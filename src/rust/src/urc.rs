//! 主动上报分发：raw_data 广播、来电、新短信、存储满、信号变化、PDCP 统计。

use crate::{log_info, log_warn};
use crate::atclient::{AtClient, AtResponse, Unsolicited};
use crate::notify::{normalize_phone_number, Notification, NotifyKind, Notifier, SENDER_CALL, SENDER_SIGNAL};
use crate::pdu::{Sms, decode_incoming_pdu};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

const CALL_DEDUP_WINDOW: Duration = Duration::from_secs(30);
const SIGNAL_CHANGE_THRESHOLD: f64 = 1.0;
const PARTIAL_SMS_TTL: Duration = Duration::from_secs(3600);
const MAX_PARTIAL_SMS: usize = 100;

pub type Broadcaster = Arc<dyn Fn(serde_json::Value) + Send + Sync>;

struct PartialSms {
    total: u32,
    parts: HashMap<u32, String>,
    received: Instant,
}

pub struct Dispatcher {
    client: Arc<AtClient>,
    notifier: Arc<Notifier>,
    ws: Broadcaster,
    ctx: tokio::sync::watch::Receiver<bool>,

    // 来电状态
    last_call_number: String,
    last_call_at: Instant,
    call_state: String,

    // 信号状态
    last_rsrp: f64,
    have_rsrp: bool,
    last_sys_mode: String,

    memory_full_notified: bool,

    /// 上一次为读短信设过的首选存储器（`AT+CPMS` 的 `<mem1>`）。
    sms_mem: String,

    partials: HashMap<String, PartialSms>,

    /// 短信本地归档句柄（main 注入）。未注入时只走通知、不落盘。
    archive: Option<Arc<crate::sms_store::SmsArchive>>,
}

impl Dispatcher {
    pub fn new(
        client: Arc<AtClient>,
        notifier: Arc<Notifier>,
        ws: Broadcaster,
        ctx: tokio::sync::watch::Receiver<bool>,
    ) -> Dispatcher {
        Dispatcher {
            client,
            notifier,
            ws,
            ctx,
            last_call_number: String::new(),
            last_call_at: Instant::now(),
            call_state: "idle".into(),
            last_rsrp: 0.0,
            have_rsrp: false,
            last_sys_mode: String::new(),
            memory_full_notified: false,
            sms_mem: String::new(),
            partials: HashMap::new(),
            archive: None,
        }
    }

    /// 注入短信本地归档句柄（main 装配时调用一次）。
    pub fn set_archive(&mut self, a: Arc<crate::sms_store::SmsArchive>) {
        self.archive = Some(a);
    }

    /// 把收到的短信写入本地归档。
    ///
    /// 归档失败只记日志：留档不是收发链路的一环，绝不能让「写文件失败」
    /// 变成一条错误弹到用户脸上 —— 短信其实已经好好躺在模组里了。
    fn archive_received(
        &self,
        sender: &str,
        content: &str,
        time: Option<String>,
        index: Option<u32>,
    ) {
        let Some(a) = self.archive.as_ref() else { return };
        if let Err(e) = a.append(vec![crate::sms::received_record(sender, content, time, index)]) {
            log_warn!("写入短信本地归档失败（不影响收发）: {e}");
        }
    }

    /// 单任务串行处理上报，直到 ctx 结束。
    pub async fn run(&mut self, mut rx: tokio::sync::mpsc::Receiver<Unsolicited>) {
        loop {
            tokio::select! {
                _ = self.ctx.changed() => return,
                u = rx.recv() => {
                    match u {
                        Some(u) => {
                            if u.broadcast {
                                self.ws(serde_json::json!({"type": "raw_data", "data": u.line}));
                            }
                            self.safe_handle(u.line).await;
                        }
                        None => return,
                    }
                }
            }
        }
    }

    fn ws(&self, msg: serde_json::Value) {
        (self.ws)(msg);
    }

    /// 某一条上报解析失败时只丢这一条，不会拖垮整个分发。
    async fn safe_handle(&mut self, line: String) {
        self.handle(&line).await;
    }

    /// 按固定顺序匹配，命中即处理。
    async fn handle(&mut self, line: &str) {
        if is_call_line(line) {
            self.handle_call(line).await;
        } else if is_memory_full_line(line) {
            self.handle_memory_full();
        } else if let Some(caps) = cmti_capture(line) {
            self.handle_new_sms(caps.0, caps.1).await;
        } else if line.contains("^CERSSI:") || line.contains("^HCSQ:") {
            self.handle_signal(line).await;
        } else if line.starts_with("^PDCPDATAINFO:") {
            self.handle_pdcp(line);
        }
    }

    // ============= 来电 =============

    async fn handle_call(&mut self, line: &str) {
        match line {
            "RING" | "IRING" | "^IRING" => {
                self.call_state = "ringing".into();
                return;
            }
            _ => {}
        }

        if line.starts_with("+CLIP:") {
            let number = clip_number(line);
            let number = match number {
                Some(n) => n,
                None => return,
            };
            /* 号码归一化：+CLIP 给的是国际格式 `+8613...`，
               推送与界面（短信中心显示 138...）口径必须一致，见 normalize_phone_number */
            let number = normalize_phone_number(&number);
            let now = Instant::now();
            let same_call = number == self.last_call_number
                && now.duration_since(self.last_call_at) <= CALL_DEDUP_WINDOW
                && self.call_state != "idle";
            if same_call {
                return;
            }

            self.last_call_number = number.clone();
            self.last_call_at = now;
            self.call_state = "ringing".into();

            let ts = crate::nettime::now_string();
            self.notifier
                .notify(Notification {
                    sender: SENDER_CALL.into(),
                    content: format!("时间：{ts}\n号码：{number}\n状态：来电振铃"),
                    kind: NotifyKind::Call,
                    memory_full: false,
                    qq_card: None,
                    time: ts.clone(),
                })
                .await;
            self.ws(serde_json::json!({
                "type": "incoming_call",
                "data": {"time": ts, "number": number, "state": "ringing"}
            }));
        } else if line.contains("^CEND:") || line == "NO CARRIER" {
            if !self.last_call_number.is_empty() {
                let ts = crate::nettime::now_string();
                let number = self.last_call_number.clone();
                self.notifier
                    .notify(Notification {
                        sender: SENDER_CALL.into(),
                        content: format!("时间：{ts}\n号码：{number}\n状态：通话结束"),
                        kind: NotifyKind::Call,
                        memory_full: false,
                        qq_card: None,
                        time: ts.clone(),
                    })
                    .await;
                self.ws(serde_json::json!({
                    "type": "incoming_call",
                    "data": {"time": ts, "number": number, "state": "ended"}
                }));
            }
            self.last_call_number.clear();
            self.last_call_at = Instant::now();
            self.call_state = "idle".into();
        }
    }

    // ============= 存储空间满 =============

    fn handle_memory_full(&mut self) {
        if self.memory_full_notified {
            return;
        }
        self.memory_full_notified = true;
        let notifier = self.notifier.clone();
        tokio::spawn(async move {
            notifier
                .notify(Notification {
                    sender: String::new(),
                    content: String::new(),
                    kind: NotifyKind::MemoryFull,
                    memory_full: true,
                    qq_card: None,
                    time: crate::notify::now_string(),
                })
                .await;
        });
    }

    // ============= 新短信 =============

    async fn handle_new_sms(&mut self, storage: String, index: String) {
        log_info!("收到新短信，存储区: {}，索引: {}", storage, index);

        // 先把读写介质对到上报的那个区。
        //
        // `AT+CMGR=<index>` 的 `<index>` 是「当前首选存储器（<mem1>）里的序号」，
        // 而 +CMTI 报的是「这条短信落在哪个区、第几格」（8.1.1／9.9.1）。两个区各自
        // 从自己的 0 号位排起，所以 `+CMTI: "SM",7` 落在 mem1="ME" 的时候去读
        // `AT+CMGR=7`，读到的是**模组 FLASH 里第 7 格那条**，还把人家标成已读 ——
        // 推送里出现的正文与真实新短信毫无关系。实机的读侧（`sendat 1 at+cmgl=4 |
        // pdu_decoder --json`）之所以没这个问题，是因为它压根不指定区、只读当前 mem1。
        //
        // 手册 8.1.3 只承认 SM / ME 两个可写区名，别的区名不猜。切换后按
        // CPMS_SWITCH_GAP 留出换区时间：`AT+CPMS` 回 OK 只代表命令被接受，
        // 不代表介质已经换完（同 sms::purge_all）。
        //
        // 切与读是两次独立的 Sms 优先级下发，中间理论上可能被别人的短信事务插进去。
        // 认下这点：切区只在「上报区与上次切到的区不同」时发生（见 mem_to_switch 的
        // 缓存），而清空短信那条路径现在也会把区还原回去，剩下的这一丝窗口不值得
        // 为它把每次新短信都变成一次长时间独占通道的事务。
        if let Some(mem) = mem_to_switch(&self.sms_mem, &storage) {
            let cmd = format!("AT+CPMS=\"{mem}\",\"{mem}\",\"{mem}\"");
            match self
                .client
                .send_sms_command(&self.ctx, &cmd, crate::atclient::COMMAND_TIMEOUT)
                .await
            {
                Ok(resp) if resp.ok() && !resp.has_error() => {
                    self.sms_mem = mem.clone();
                    tokio::time::sleep(crate::sms::CPMS_SWITCH_GAP).await;
                }
                other => log_warn!(
                    "把读写介质切到 {mem} 没成功，仍按当前区读第 {index} 格：{}",
                    match other {
                        Ok(r) => r.text(),
                        Err(e) => e,
                    }
                ),
            }
        }

        // 短信到达后的读取必须走短信最高优先级：它不能被后台巡检（信号/缓存/
        // 流量/自动拨号对账）排在后面，否则用户要等好几秒才看到新短信。
        //
        // 副作用要认账：手册 9.10.2 写明 `AT+CMGR` 读成功后，存储里那条「收到的未读」
        // 就变成「收到的已读」（`AT+CMGL` 的 9.8.2 同理）。于是界面上的「未读」不可能
        // 来自模组的标志位 —— 我们一读它就没了，短信中心页只按本页会话估（见 sms_center.js）。
        let resp = match self.client.send_sms_command(
            &self.ctx,
            &format!("AT+CMGR={index}"),
            crate::atclient::SMS_LIST_TIMEOUT,
        ).await {
            Ok(r) => r,
            Err(e) => {
                log_warn!("读取短信 {} 失败: {}", index, e);
                return;
            }
        };

        for sms in parse_sms_response(&resp) {
            if sms.partial.is_some() {
                self.assemble_partial(sms);
                continue;
            }
            /* 归一化号码：PDU 里是 `8613800138000`，界面显示的是 `13800138000` */
            let sender = normalize_phone_number(&sms.sender);
            /*
             * 落盘：把「收到过什么」留在路由器本地。
             *
             * 时间用 PDU 的 TP-SCTS，格式与 `list` 返回的口径一致
             * （`yy/MM/dd,HH:mm:ss`）—— 这样同一条短信无论从模组读到还是
             * 从归档里读，指纹都相同，不会存成两条。
             */
            self.archive_received(
                &sender,
                &sms.content,
                Some(sms.date.format("%y/%m/%d,%H:%M:%S").to_string()),
                index.trim().parse::<u32>().ok(),
            );
            self.notifier
                .notify(Notification {
                    sender: sender.clone(),
                    content: sms.content.clone(),
                    kind: NotifyKind::Sms,
                    memory_full: false,
                    qq_card: None,
                    time: sms.date.format("%Y-%m-%d %H:%M:%S").to_string(),
                })
                .await;
            self.ws(serde_json::json!({
                "type": "new_sms",
                "data": {
                    "sender": sender,
                    "content": sms.content,
                    "time": sms.date.format("%Y-%m-%d %H:%M:%S").to_string(),
                }
            }));
        }
    }

    /// 拼装长短信，收齐全部分段后再推送。
    fn assemble_partial(&mut self, sms: Sms) {
        let now = Instant::now();
        let mut to_delete: Vec<String> = Vec::new();
        for (k, v) in &self.partials {
            if now.duration_since(v.received) > PARTIAL_SMS_TTL {
                log_warn!("清理过期的分段短信: {}", k);
                to_delete.push(k.clone());
            }
        }
        for k in to_delete {
            self.partials.remove(&k);
        }

        if self.partials.len() >= MAX_PARTIAL_SMS {
            let oldest_key = self
                .partials
                .iter()
                .min_by(|a, b| a.1.received.cmp(&b.1.received))
                .map(|(k, _)| k.clone());
            if let Some(k) = oldest_key {
                log_warn!("分段短信缓存超限，删除最旧的: {}", k);
                self.partials.remove(&k);
            }
        }

        let info = match &sms.partial {
            Some(p) => p.clone(),
            None => return,
        };
        let key = format!("{}_{}", sms.sender, info.reference);
        let entry = self
            .partials
            .entry(key)
            .or_insert_with(|| PartialSms {
                total: info.parts_count,
                parts: HashMap::new(),
                received: now,
            });
        entry.parts.insert(info.part_number, sms.content.clone());

        if entry.total == 0 || (entry.parts.len() as u32) < entry.total {
            return;
        }

        let mut full = String::new();
        for i in 1..=entry.total {
            if let Some(p) = entry.parts.get(&i) {
                full.push_str(p);
            }
        }
        let date = sms.date;
        self.partials.remove(&format!("{}_{}", sms.sender, info.reference));

        let notifier = self.notifier.clone();
        /* 拼装完成后同样归一化号码，保证长短信与普通短信口径一致 */
        let sender = normalize_phone_number(&sms.sender);
        let sender_ws = sender.clone();
        let content = full.clone();
        /*
         * 长短信按**合并后的完整正文**记一条，与界面上看到的那条气泡一致。
         * 槽位留空：拼装发生在 URC 侧，此时拿不到各段在模组里的格位，
         * 删除这类记录靠内容指纹匹配。
         */
        self.archive_received(
            &sender,
            &full,
            Some(date.format("%y/%m/%d,%H:%M:%S").to_string()),
            None,
        );
        tokio::spawn(async move {
            notifier
                .notify(Notification {
                    sender,
                    content,
                    kind: NotifyKind::Sms,
                    memory_full: false,
                    qq_card: None,
                    time: date.format("%Y-%m-%d %H:%M:%S").to_string(),
                })
                .await;
        });
        self.ws(serde_json::json!({
            "type": "new_sms",
            "data": {
                "sender": sender_ws,
                "content": full,
                "time": date.format("%Y-%m-%d %H:%M:%S").to_string(),
            }
        }));
    }

    // ============= 信号 =============

    /*
     * 这条链（handle_signal → notify_signal → render_switch_card_md / signal_level）
     * 在实机上**不会被触发**：本模组（TDTECH / Fibocom 系）不主动上报 ^HCSQ / ^CERSSI，
     * 实测 1200 条 AT 记录里自发信号上报 0 条（同款记录见 crate::signalwatch 模块头
     * 与 config.rs 的轮询开关注释）。「信号变化通知」实际由 signalwatch 定时轮询驱动，
     * 等级与文案走 signalgrade。
     *
     * 所以这里的措辞是**当前休眠的第二份实现**：改巡检推送文案不必同步改这里，反之也是；
     * 但换成会自发上报的固件时它会重新生效，**勿当死代码删除**。
     */
    async fn handle_signal(&mut self, line: &str) {
        let line = line.split('\n').next().unwrap_or(line);
        // 解析逻辑抽成纯函数，供「定时轮询推送」复用同一套换算规则
        // （见 crate::signalwatch），避免两条路径各写一份导致读数口径不一致。
        let Some((rsrp, sys_mode)) = parse_signal_reading(line) else {
            return;
        };

        let changed = !self.have_rsrp
            || (rsrp - self.last_rsrp).abs() >= SIGNAL_CHANGE_THRESHOLD
            || sys_mode != self.last_sys_mode;
        if !changed {
            return;
        }

        let mode_switched = sys_mode != self.last_sys_mode;
        self.last_rsrp = rsrp;
        self.have_rsrp = true;
        self.last_sys_mode = sys_mode;
        self.notify_signal(rsrp, mode_switched).await;
    }

    async fn notify_signal(&mut self, rsrp: f64, mode_switched: bool) {
        let info = self.query_monsc().await;
        let now = crate::notify::now_string();

        // 标题行：发生制式切换时以「网络切换提醒」为题（这是用户最关心的
        // 网络事件），否则以「信号变动通知」为题。正文统一「键：值」行 +
        // 分段小标题，QQ 富文本下键值行会渲染为列表（见 qqpush::build_markdown）。
        let mut b = String::new();
        if mode_switched {
            b.push_str("网络切换提醒\n");
        } else {
            b.push_str("信号变动通知\n");
        }
        b.push_str(&format!("时间：{}\n", now));
        b.push_str(&format!("制式：{}\n", info.rat));
        b.push_str(&format!("信号：{}\n", signal_level(rsrp)));

        let content = match info.rat.as_str() {
            "NR" => {
                format!(
                    "{}RSRP：{} dBm\nRSRQ：{} dB\nSINR：{} dB\n\n小区信息\n频点：{}\nPCI：{}\nTAC：{}\n小区ID：{}",
                    b,
                    or_unknown(&info.rsrp),
                    or_unknown(&info.rsrq),
                    or_unknown(&info.sinr),
                    or_unknown(&info.arfcn),
                    or_unknown(&info.pci),
                    or_unknown(&info.tac),
                    or_unknown(&info.cell_id),
                )
            }
            "LTE" => {
                format!(
                    "{}RSRP：{} dBm\nRSRQ：{} dB\nRSSI：{} dBm\n\n小区信息\n频点：{}\nPCI：{}\nTAC：{}\n小区ID：{}",
                    b,
                    or_unknown(&info.rsrp),
                    or_unknown(&info.rsrq),
                    or_unknown(&info.rssi),
                    or_unknown(&info.arfcn),
                    or_unknown(&info.pci),
                    or_unknown(&info.tac),
                    or_unknown(&info.cell_id),
                )
            }
            _ => {
                self.notifier
                    .notify(Notification {
                        sender: SENDER_SIGNAL.into(),
                        content: b,
                        kind: NotifyKind::Signal,
                        memory_full: false,
                        qq_card: Some(render_switch_card_md(rsrp, mode_switched, &info, &now)),
                        time: now.clone(),
                    })
                    .await;
                return;
            }
        };

        self.notifier
            .notify(Notification {
                sender: SENDER_SIGNAL.into(),
                content,
                kind: NotifyKind::Signal,
                memory_full: false,
                qq_card: Some(render_switch_card_md(rsrp, mode_switched, &info, &now)),
                time: now,
            })
            .await;
    }

    /// AT^MONSC 返回的服务小区信息。
    async fn query_monsc(&self) -> MonscInfo {
        query_monsc(&self.client, &self.ctx).await
    }

    // ============= PDCP 统计 =============

    fn handle_pdcp(&mut self, line: &str) {
        let parts = split_fields(line, "^PDCPDATAINFO:");
        if parts.len() < PDCP_FIELDS.len() {
            return;
        }

        let mut data = serde_json::Map::new();
        for (i, (name, tenth)) in PDCP_FIELDS.iter().enumerate() {
            let v = match parts[i].parse::<f64>() {
                Ok(v) => v,
                Err(_) => return,
            };
            if *tenth {
                data.insert(name.to_string(), serde_json::json!(v / 10.0));
            } else {
                data.insert(name.to_string(), serde_json::json!(v as i64));
            }
        }
        self.ws(serde_json::json!({ "type": "pdcp_data", "data": serde_json::Value::Object(data) }));
    }
}

/// 与前端期望的字段名一一对应，顺序即 ^PDCPDATAINFO 的字段顺序。
pub static PDCP_FIELDS: &[(&str, bool)] = &[
    ("id", false),
    ("pduSessionId", false),
    ("discardTimerLen", false),
    ("avgDelay", true),
    ("minDelay", true),
    ("maxDelay", true),
    ("highPriQueMaxBuffTime", true),
    ("lowPriQueMaxBuffTime", true),
    ("highPriQueBuffPktNums", false),
    ("lowPriQueBuffPktNums", false),
    ("ulPdcpRate", false),
    ("dlPdcpRate", false),
    ("ulDiscardCnt", false),
    ("dlDiscardCnt", false),
];

#[derive(Default)]
pub(crate) struct MonscInfo {
    pub(crate) rat: String,
    pub(crate) arfcn: String,
    pub(crate) cell_id: String,
    pub(crate) pci: String,
    pub(crate) tac: String,
    pub(crate) rsrp: String,
    pub(crate) rsrq: String,
    pub(crate) sinr: String,
    pub(crate) rssi: String,
}

fn is_call_line(line: &str) -> bool {
    match line {
        "RING" | "IRING" | "^IRING" | "NO CARRIER" => return true,
        _ => {}
    }
    line.starts_with("+CLIP:") || line.contains("^CEND:")
}

fn is_memory_full_line(line: &str) -> bool {
    line.contains("CMS ERROR: 322") || line.contains("MEMORY FULL") || line.contains("^SMMEMFULL")
}

fn clip_number(line: &str) -> Option<String> {
    // +CLIP: "13800138000",145,,,"",0  → 号码
    let rest = line.strip_prefix("+CLIP:")?;
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// +CMTI: "ME",12 → (storage, index)
fn cmti_capture(line: &str) -> Option<(String, String)> {
    let rest = line.strip_prefix("+CMTI:")?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    let storage = rest[..end].to_string();
    let after = rest[end + 1..].trim_start().trim_start_matches(',').trim();
    let index = after.split(',').next()?.trim();
    // 索引必须是纯数字，防止 NETWORK 模式下 URC 注入 AT 命令
    if index.is_empty() || !index.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((storage, index.to_string()))
}

/// 这次上报要不要先切读写介质、切到哪个区（`AT+CPMS` 的 `<mem1>`）。
///
/// 只认手册 8.1.3 定义的两个可写区名（SM / ME），大小写与多带的引号都先抹平；
/// 已经停在同一个区就不必再写一遍 `AT+CPMS`。
fn mem_to_switch(current: &str, reported: &str) -> Option<String> {
    let mem = reported.trim().trim_matches('"').to_ascii_uppercase();
    match mem.as_str() {
        "SM" | "ME" if mem != current.trim().to_ascii_uppercase() => Some(mem),
        _ => None,
    }
}

/// 从 `AT+CMGR=<index>`（手册 9.10.1）/ `AT+CMGL`（9.8.1）的应答里取出 PDU 并解码。
///
/// 两条命令的头行字段数不一样（CMGL 是 `<index>,<stat>,[<reserved>],<length>`，
/// CMGR 没有 `<index>`），这里刻意不解析头行：序号本来就是调用方自己下发的那个，
/// 状态和长度对解码没用。前缀要写全 —— `starts_with("+CMG")` 会把发送回执
/// `+CMGS: <mr>` 也当头行，接着把下一行的 `OK` 当 PDU 去解。
fn parse_sms_response(resp: &AtResponse) -> Vec<Sms> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < resp.lines.len() {
        let line = resp.lines[i].trim();
        if !(line.starts_with("+CMGR:") || line.starts_with("+CMGL:")) {
            i += 1;
            continue;
        }
        let pdu = resp.lines[i + 1].trim();
        i += 2;
        if pdu.is_empty() || !is_hex(pdu) {
            continue;
        }
        match decode_incoming_pdu(pdu) {
            Ok(sms) => out.push(sms),
            // 本应用只收 SMS-DELIVER：状态报告（MTI=2）与其它类型走不到 out 里。
            // 文案点明这一点，否则日志看起来像「短信坏了」，其实是「这条不该由我们解」。
            Err(e) => log_warn!("短信上报未采纳（非 SMS-DELIVER 或解析失败，已忽略）：{}", e),
        }
    }
    out
}

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn split_fields(line: &str, prefix: &str) -> Vec<String> {
    let body = match line.find(prefix) {
        Some(i) => &line[i + prefix.len()..],
        None => line,
    };
    body.trim()
        .split(',')
        .map(|p| p.trim().to_string())
        .collect()
}

/// 解析 `AT+CPMS?` 应答里的短信存储用量 → (已用, 容量)。
///
/// 手册 8.1.1 的读命令形态：`+CPMS: <mem1>,<used1>,<total1>,<mem2>,…`，每三段一组、
/// 组内依次是区名/已用/容量。这里只要**第一组**（`<mem1>` 才是 8.1.3 里读取与删除
/// 所用的介质，短信是否满也就看它），所以把非数字的区名滤掉、取头两个数就够。
///
/// 与 `sms::parse_storage` 是两件事，不是重复实现：那一个要给出三个区的区名给界面显示，
/// 少一个字段就该整体判为「没读到」；这一个跑在定时推送里，宁可宽松地拿到第一组数字，
/// 也不能因为固件少回了一组就把「存储已满」的通知关掉。两处都同时认私有前缀 `^CPMS`。
fn parse_storage_line(line: &str) -> Option<(u64, u64)> {
    let line = line.trim();
    // 个别固件回私有前缀 ^CPMS，两种都认（与 sms::parse_storage 同一口径）
    let body = line.strip_prefix("+CPMS:").or_else(|| line.strip_prefix("^CPMS:"))?;
    // 存储区名（"ME" / "SM"）不是数字，会被过滤掉，剩下的就是 used,total,...
    let mut nums = body
        .split(',')
        .filter_map(|p| p.trim().trim_matches('"').parse::<u64>().ok());
    let used = nums.next()?;
    let total = nums.next()?;
    // 容量 0 是「没读到」而不是「满了」：当成满会误报存储已满
    if total == 0 {
        return None;
    }
    Some((used, total))
}

/// 查询短信存储用量：`AT+CPMS?` → (已用, 容量)。
///
/// 为什么定时推送要用它，而不是等模组上报 `^SMMEMFULL`：后者只在**恰好收满**
/// 的那一刻来一次，此后即便用户清理过也不会再来 —— 拿事件当状态，推送会永远
/// 卡在「已满」。存储用量是**可以主动读到的真实状态**，满没满由当前读数判定。
pub(crate) async fn query_storage(
    client: &AtClient,
    ctx: &tokio::sync::watch::Receiver<bool>,
) -> Option<(u64, u64)> {
    let resp = match client
        .send_command(ctx, "AT+CPMS?", crate::atclient::COMMAND_TIMEOUT, None)
        .await
    {
        Ok(r) => r,
        Err(_) => return None,
    };
    resp.lines.iter().filter_map(|l| parse_storage_line(l)).next()
}

/// 查询驻留小区信息（`AT^MONSC`，《AT 命令手册》13.9.1/13.9.3）。
///
/// 应答恒为 `^MONSC: <RAT>[,<cell_paras>]`，<RAT> ∈ WCDMA / LTE / NR / NONE；
/// NONE 或无服务时不带小区参数，字段长度不足会直接返回默认值（制式「未知」）。
/// **回退 `AT^HCSQ?` 只发生在巡检侧**（`signalwatch::sample_signal` 拿不到可用
/// RSRP 时才读 HCSQ）；本文件的 URC 路径拿到「未知」不会回退，直接按未知出文案。
/// LTE 与 NR 的 <cell_paras> 顺序不同，必须分支取值：
///   LTE: MCC,MNC,ARFCN(十进制 0~133121),Cell_ID(hex),PCI(hex 0~0x1F7),TAC(hex),RSRP,RSRQ,RSSI
///   NR:  MCC,MNC,ARFCN-NR,SCS(0~4),Cell_ID(hex),PCI(hex 0~0x3EF),TAC(hex),RSRP,RSRQ,SINR
/// 下标须与前端 `rpc.js::parseMONSC` 完全一致，否则页面与推送会给出不同的小区参数。
///
/// 抽成自由函数的原因：URC 分发（收到信号上报时补全明细）与定时巡检
/// （主动取样）都要用它，而巡检并不持有 `Dispatcher`。
pub(crate) async fn query_monsc(
    client: &AtClient,
    ctx: &tokio::sync::watch::Receiver<bool>,
) -> MonscInfo {
    let mut info = MonscInfo { rat: "未知".into(), ..Default::default() };
    let resp = match client.send_command(ctx, "AT^MONSC", crate::atclient::COMMAND_TIMEOUT, None).await {
        Ok(r) => r,
        Err(_) => return info,
    };
    for line in &resp.lines {
        if !line.starts_with("^MONSC:") {
            continue;
        }
        let parts = split_fields(line, "^MONSC:");
        if parts.len() < 2 {
            return info;
        }
        info.rat = parts[0].trim_matches('"').to_string();
        match info.rat.as_str() {
            "NR" => {
                if parts.len() >= 11 {
                    info.arfcn = parts[3].clone();
                    info.cell_id = parts[5].clone();
                    info.pci = hex_to_dec(&parts[6]);
                    info.tac = parts[7].clone();
                    info.rsrp = parts[8].clone();
                    info.rsrq = parts[9].clone();
                    info.sinr = parts[10].clone();
                }
            }
            "LTE" => {
                if parts.len() >= 10 {
                    info.arfcn = parts[3].clone();
                    info.cell_id = parts[4].clone();
                    info.pci = hex_to_dec(&parts[5]);
                    info.tac = parts[6].clone();
                    info.rsrp = parts[7].clone();
                    info.rsrq = parts[8].clone();
                    info.rssi = parts[9].clone();
                }
            }
            _ => {}
        }
        return info;
    }
    info
}

/// `^HFREQINFO?` 解析出的主载波信息（手册 13.16.3）。
#[derive(Debug, Clone)]
pub(crate) struct HfreqCarrier {
    /// 制式名（`NR` / `LTE` / `WCDMA` / `GSM`），由 `<sysmode>` 编码翻译而来。
    pub sysmode: String,
    /// 频段号 `<band>`：NR 记 n 号、LTE 记 B 号（此处只存数字，前缀由渲染侧按制式补）。
    pub band: Option<u32>,
    /// 下行频点（kHz）。
    pub dl_freq_khz: f64,
    /// 下行带宽（kHz）；0 表示模组未给出。
    pub dl_bw_khz: f64,
}

/// 查询服务载波信息（`AT^HFREQINFO?`）。
///
/// 手册 13.16.3 字段顺序（实测 NR n41）：
/// `^HFREQINFO:<n>,<sysmode>,<band>,<dl_fcn>,<dl_freq>,<dl_bw>,<ul_fcn>,<ul_freq>,<ul_bw>`
/// 例如 `0,7,41,513000,2565000,100000,...` → 制式 NR、**band 41**、
/// 下行 2565 MHz / 100 MHz。
///
/// `<band>` 就是推送里要显示的「具体频段」，此前只取了频点与带宽、把它丢掉了，
/// 于是文案只能笼统写「中频 2565 MHz」，用户看不到 n41 / B3 这样的频段号。
///
/// 多载波时取第一个（主载波）——推送文案不需要逐载波展开。
pub(crate) async fn query_hfreqinfo(
    client: &AtClient,
    ctx: &tokio::sync::watch::Receiver<bool>,
) -> Option<HfreqCarrier> {
    let resp = client
        .send_command(ctx, "AT^HFREQINFO?", crate::atclient::COMMAND_TIMEOUT, None)
        .await
        .ok()?;
    for line in &resp.lines {
        if let Some(c) = parse_hfreq_line(line) {
            return Some(c);
        }
    }
    None
}

/// 解析一行 `^HFREQINFO:` 文本。
///
/// 抽成纯函数是为了能用**实机原始应答**做回归 —— 频段号此前被整段忽略，
/// 这类「字段取错下标」的缺陷只有对着真包才看得出来。
fn parse_hfreq_line(line: &str) -> Option<HfreqCarrier> {
    if !line.contains("^HFREQINFO:") {
        return None;
    }
    let parts = split_fields(line, "^HFREQINFO:");
    if parts.len() < 6 {
        return None;
    }
    let dl_freq = parts[4].parse::<f64>().ok()?;
    // 未注册 / 无服务时模组把频点填 0，这不是「0 Hz」而是「没有读数」
    if dl_freq <= 0.0 {
        return None;
    }
    Some(HfreqCarrier {
        sysmode: hfreq_sysmode_name(&parts[1]),
        band: parts[2].trim().parse::<u32>().ok().filter(|v| *v > 0),
        dl_freq_khz: dl_freq,
        dl_bw_khz: parts[5].parse::<f64>().unwrap_or(0.0),
    })
}

/// `^HFREQINFO` 的 `<sysmode>` 编码（手册 13.16.3）：`1` GSM / `3` WCDMA / `6` LTE / `7` NR。
///
/// 注意：这与 `^SYSINFOEX` 的 `<sysmode>`（`6`=LTE、`11`=NR-5GC）**不是同一张表**，
/// 两者数值含义不同，不可混用。
fn hfreq_sysmode_name(code: &str) -> String {
    match code.trim().trim_matches('"') {
        "1" => "GSM".into(),
        "3" => "WCDMA".into(),
        "6" => "LTE".into(),
        "7" => "NR".into(),
        other => other.to_string(),
    }
}

/// 从一行上报文本里解析信号读数 → `(RSRP dBm, 制式)`。
///
/// 同时支持两条模组上报：
/// - `^HCSQ:` —— 手册 13.5 字段表：LTE 为 `<rssi>,<rsrp>,<sinr>,<rsrq>`，
///   NR 等制式为 `<rsrp>,<sinr>,<rsrq>`。故 LTE 的 RSRP 下标为 2、其余为 1；
///   255 表示「未知或不可测」，此时视为无有效读数。换算：`RSRP = raw - 140`。
/// - `^CERSSI:` —— 第 19 个字段（下标 18）为 RSRP，单位已是 dBm，制式未知记为 `4G/5G`。
///
/// 返回 `None` 表示这一行不含可用读数（字段缺失 / 非数字 / 不可测）。
///
/// 抽成纯函数的原因：URC 分发（本模块）与「定时轮询推送」（signalwatch）
/// 必须用**同一套**换算规则，否则同一信号会出现两个不同的 dBm 值。
pub fn parse_signal_reading(line: &str) -> Option<(f64, String)> {
    if line.contains("^CERSSI:") {
        let parts = split_fields(line, "^CERSSI:");
        // 第 19/20/21 个字段是 RSRP/RSRQ/SINR
        if parts.len() >= 20 {
            if let Ok(v) = parts[18].parse::<f64>() {
                return Some((v, "4G/5G".into()));
            }
        }
        return None;
    }
    if line.contains("^HCSQ:") {
        let parts = split_fields(line, "^HCSQ:");
        let mode = parts.first()?.trim_matches('"').to_string();
        let rsrp_idx = if mode.eq_ignore_ascii_case("LTE") { 2 } else { 1 };
        let raw = parts.get(rsrp_idx)?.parse::<f64>().ok()?;
        if raw != 255.0 {
            return Some((-140.0 + raw, mode));
        }
    }
    None
}

/// 渲染 QQ 富文本「网络切换提醒 / 信号变动通知」卡片（Markdown 表格排版）。
///
/// 制式切换（LTE ↔ NR）时以「网络切换提醒」为题，否则「信号变动通知」——
/// 与纯文本正文同一判定。缺测项整行省略。分隔线用空行包裹的 `---`
/// （CommonMark 中紧随段落的 `---` 是 setext 二级标题下线）；页脚用斜体
/// （QQ Markdown 不支持 `<sub>` 等 HTML 标签）。
pub(crate) fn render_switch_card_md(
    rsrp: f64,
    mode_switched: bool,
    info: &MonscInfo,
    now: &str,
) -> String {
    let rat = info.rat.trim();
    let is_nr = rat.eq_ignore_ascii_case("NR");
    let is_lte = rat.eq_ignore_ascii_case("LTE");
    let gen = if is_nr {
        "5G"
    } else if is_lte {
        "4G"
    } else {
        ""
    };
    let title = if mode_switched { "网络切换提醒" } else { "信号变动通知" };
    let intro = if mode_switched {
        "检测到网络状态发生变化，请留意当前信号表现喵。"
    } else {
        "信号状态更新，请留意当前信号表现喵。"
    };
    let level = signal_level(rsrp);
    // RSRP 展示值：MONSC 给出就用实测串，否则用事件读数兜底
    let rsrp_s = if info.rsrp.trim().is_empty() {
        format!("{rsrp:.0}")
    } else {
        info.rsrp.trim().to_string()
    };
    let gen_or_rat = if gen.is_empty() { rat } else { gen };

    let mut out = format!(
        "## {title}
{intro}
**事件时间：** `{now}`
**消息序号：** `1`

---

### 网络状态
| 项目 | 当前状态 |
|:--|:--|
"
    );
    if !rat.is_empty() {
        let cell = if gen.is_empty() {
            format!("**{rat}**")
        } else {
            format!("**{rat} · {gen}**")
        };
        out.push_str(&format!("| 网络制式 | {cell} |
"));
    }
    out.push_str(&format!("| 信号质量 | **{level}** |
"));
    out.push_str(&format!("| RSRP | `{rsrp_s} dBm` |
"));
    if !info.rsrq.trim().is_empty() {
        out.push_str(&format!("| RSRQ | `{} dB` |
", or_unknown(&info.rsrq)));
    }
    if is_nr {
        if !info.sinr.trim().is_empty() {
            out.push_str(&format!("| SINR | `{} dB` |
", or_unknown(&info.sinr)));
        }
    } else if !info.rssi.trim().is_empty() {
        out.push_str(&format!("| RSSI | `{} dBm` |
", or_unknown(&info.rssi)));
    }

    out.push_str("
### 小区信息
| 项目 | 参数 |
|:--|:--|
");
    let arfcn_label = if is_nr { "频点（NR-ARFCN）" } else { "频点（LTE-ARFCN）" };
    if !info.arfcn.trim().is_empty() {
        out.push_str(&format!("| {arfcn_label} | `{}` |
", or_unknown(&info.arfcn)));
    }
    if !info.pci.trim().is_empty() {
        out.push_str(&format!("| PCI | `{}` |
", or_unknown(&info.pci)));
    }
    if !info.tac.trim().is_empty() {
        out.push_str(&format!("| TAC | `{}` |
", or_unknown(&info.tac)));
    }
    if !info.cell_id.trim().is_empty() {
        out.push_str(&format!("| 小区 ID | `{}` |
", or_unknown(&info.cell_id)));
    }

    // 巡检提示：按信号等级给一句结论 + 通用建议
    let hint = match level {
        "优秀" => format!("当前 {gen_or_rat} 信号整体优秀。"),
        "良好" => format!("当前 {gen_or_rat} 信号整体良好，但信号强度与信噪比仍有优化空间。"),
        other => format!("当前 {gen_or_rat} 信号{other}，建议关注驻网质量。"),
    };
    out.push_str(&format!(
        "
---

### 巡检提示
{hint}建议继续观察网络稳定性，暂不必仅凭单次测量切换频段或小区。

---

*网络状态监测 · 自动通知*
*本喵会继续关注网络变化，有新的状态更新时再来提醒你喵。*"
    ));
    out
}

/// RSRP → 中文信号等级。
///
/// 注意：**只服务于本文件的 URC 通知文案**。定时轮询与定时推送的等级文案来自
/// `crate::signalgrade`（`Level::caption()`：极佳/良好/一般/较差/极差），两者是
/// 两套词表、并不共用——改这里不会同步改变巡检推送里的措辞，反之亦然。
pub(crate) fn signal_level(rsrp: f64) -> &'static str {
    match rsrp {
        _ if rsrp >= -85.0 => "优秀",
        _ if rsrp >= -95.0 => "良好",
        _ if rsrp >= -105.0 => "一般",
        _ => "较差",
    }
}

/// 把 MONSC 里以十六进制表示的 PCI 转成十进制。
fn hex_to_dec(s: &str) -> String {
    match u64::from_str_radix(s.trim(), 16) {
        Ok(v) => v.to_string(),
        Err(_) => s.to_string(),
    }
}

fn or_unknown(s: &str) -> &str {
    if s.trim().is_empty() {
        "未知"
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hcsq_lte_reads_rsrp_from_third_field() {
        // LTE 字段序为 <rssi>,<rsrp>,<sinr>,<rsrq> → RSRP 下标 2，换算 raw - 140
        let (rsrp, mode) = parse_signal_reading("^HCSQ: \"LTE\",60,44,53,15").expect("应解析成功");
        assert_eq!(rsrp, -96.0);
        assert_eq!(mode, "LTE");
    }

    #[test]
    fn hcsq_nr_reads_rsrp_from_second_field() {
        // NR 等制式为 <rsrp>,<sinr>,<rsrq> → RSRP 下标 1
        let (rsrp, mode) = parse_signal_reading("^HCSQ: \"NR\",60,44,53").expect("应解析成功");
        assert_eq!(rsrp, -80.0);
        assert_eq!(mode, "NR");
    }

    #[test]
    fn hcsq_255_means_unmeasurable() {
        // 255 是手册定义的「未知或不可测」，不能当成一个有效读数算成 -115 dBm
        assert!(parse_signal_reading("^HCSQ: \"LTE\",60,255,53,15").is_none());
    }

    #[test]
    fn hcsq_tolerates_line_prefix_and_trailing_cr() {
        // 实机上报行常带行首 \r\n 与行尾 \r，不能要求整行以 ^HCSQ 开头
        assert!(parse_signal_reading("\r\n^HCSQ: \"LTE\",60,50,53,15\r").is_some());
    }

    #[test]
    fn cerssi_reads_field_19_as_dbm() {
        let line = "^CERSSI: \"LTE\",1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,-95,19,20";
        let (rsrp, mode) = parse_signal_reading(line).expect("应解析成功");
        assert_eq!(rsrp, -95.0, "CERSSI 的下标 18 已是 dBm，不应再减 140");
        assert_eq!(mode, "4G/5G");
    }

    #[test]
    fn cerssi_too_few_fields_is_ignored() {
        // 字段不足时若不去校验长度，会拿到错位的值冒充 RSRP
        assert!(parse_signal_reading("^CERSSI: \"LTE\",1,2,3").is_none());
    }

    #[test]
    fn unrelated_lines_yield_nothing() {
        assert!(parse_signal_reading("OK").is_none());
        assert!(parse_signal_reading("+CMTI: \"SM\",3").is_none());
        assert!(parse_signal_reading("").is_none());
    }

    #[test]
    fn signal_level_thresholds_are_monotonic() {
        assert_eq!(signal_level(-70.0), "优秀");
        assert_eq!(signal_level(-85.0), "优秀", "边界值应归入更高一档");
        assert_eq!(signal_level(-90.0), "良好");
        assert_eq!(signal_level(-100.0), "一般");
        assert_eq!(signal_level(-110.0), "较差");
    }

    // ---- ^HFREQINFO 载波解析 ----

    #[test]
    fn hfreq_line_parses_band_and_sysmode() {
        // 实机原始应答（MT5700M-CN，NR n41，下行 100 MHz）
        let line = "^HFREQINFO: 0,7,41,513000,2565000,100000,513000,2565000,100000";
        let c = parse_hfreq_line(line).expect("应解析成功");
        assert_eq!(c.sysmode, "NR", "sysmode=7 应译为 NR（手册 13.16.3）");
        assert_eq!(c.band, Some(41), "band_classN 必须取到，否则推送显示不出 n41");
        assert_eq!(c.dl_freq_khz, 2_565_000.0);
        assert_eq!(c.dl_bw_khz, 100_000.0);
    }

    #[test]
    fn mem_to_switch_only_moves_for_a_writable_area() {
        // 手册 8.1.3 只给 SM / ME 两个可写区名，别的一律不猜。
        assert_eq!(mem_to_switch("", "SM").as_deref(), Some("SM"), "第一次读到上报区要先对上");
        assert_eq!(mem_to_switch("SM", "SM"), None, "已经在同一个区，不再写一遍 CPMS");
        assert_eq!(mem_to_switch("ME", "\"sm\"").as_deref(), Some("SM"), "大小写与引号都要抹平");
        assert_eq!(mem_to_switch("sm", "SM"), None, "当前区的大小写不同也不算要切");
        assert_eq!(mem_to_switch("ME", "SM").as_deref(), Some("SM"), "上报在卡上而当前是模组 FLASH");
        assert_eq!(mem_to_switch("ME", "BM"), None, "BM/MT 这类手册没定义的区名不切");
        assert_eq!(mem_to_switch("ME", ""), None);
    }

    #[test]
    fn storage_line_reads_used_and_total() {
        assert_eq!(parse_storage_line("+CPMS: \"ME\",3,50,\"ME\",3,50,\"ME\",3,50"), Some((3, 50)));
        assert_eq!(parse_storage_line("+CPMS: \"SM\",0,50"), Some((0, 50)));
        // 私有前缀同样认（个别固件回 ^CPMS）
        assert_eq!(parse_storage_line("^CPMS: \"ME\",10,50"), Some((10, 50)));
        // 容量 0 = 没读到，不是「满了」
        assert_eq!(parse_storage_line("+CPMS: \"ME\",0,0"), None);
        assert_eq!(parse_storage_line("OK"), None);
    }

    #[test]
    fn hfreq_sysmode_codes_differ_from_sysinfoex() {
        // ^HFREQINFO：6=LTE / 7=NR；^SYSINFOEX：6=LTE / 11=NR-5GC。
        // 两张表不是一回事，混用会把 LTE 误判成 NR 之类。
        assert_eq!(hfreq_sysmode_name("1"), "GSM");
        assert_eq!(hfreq_sysmode_name("3"), "WCDMA");
        assert_eq!(hfreq_sysmode_name("6"), "LTE");
        assert_eq!(hfreq_sysmode_name("7"), "NR");
        assert_eq!(hfreq_sysmode_name("11"), "11", "11 不在本表内，应原样保留");
    }

    #[test]
    fn hfreq_line_rejects_missing_or_zero_freq() {
        assert!(parse_hfreq_line("OK").is_none());
        assert!(parse_hfreq_line("^HFREQINFO: 0,7,41,513000").is_none(), "字段不足应拒绝");
        // 未注册时频点为 0，若当成合法读数就会渲染出「0 MHz」这种假信息
        assert!(parse_hfreq_line("^HFREQINFO: 0,7,41,0,0,0,0,0,0").is_none());
    }
}
