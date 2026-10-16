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

#[allow(dead_code)] // sender 随分段信息留存，当前仅写入，保留供后续归属核对
struct PartialSms {
    sender: String,
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

    partials: HashMap<String, PartialSms>,
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
            partials: HashMap::new(),
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
                    time: crate::notify::now_string(),
                })
                .await;
        });
    }

    // ============= 新短信 =============

    async fn handle_new_sms(&mut self, storage: String, index: String) {
        log_info!("收到新短信，存储区: {}，索引: {}", storage, index);

        let resp = match self.client.send_command(&self.ctx, &format!("AT+CMGR={index}"), crate::atclient::COMMAND_TIMEOUT, None).await {
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
            self.notifier
                .notify(Notification {
                    sender: sender.clone(),
                    content: sms.content.clone(),
                    kind: NotifyKind::Sms,
                    memory_full: false,
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
                sender: sms.sender.clone(),
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
        tokio::spawn(async move {
            notifier
                .notify(Notification {
                    sender,
                    content,
                    kind: NotifyKind::Sms,
                    memory_full: false,
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
                "isComplete": true,
            }
        }));
    }

    // ============= 信号 =============

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

        let mut b = String::new();
        if mode_switched {
            b.push_str("⚡ 网络切换提醒\n");
        }
        b.push_str(&format!(
            "📶 信号变动通知\n时间: {}\n制式: {}\n信号: {}\n",
            now,
            info.rat,
            signal_level(rsrp)
        ));

        let content = match info.rat.as_str() {
            "NR" => {
                format!(
                    "{}RSRP: {} dBm\nRSRQ: {} dB\nSINR: {} dB\n\n📡 小区信息:\n频点: {}\nPCI: {}\nTAC: {}\n小区ID: {}",
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
                    "{}RSRP: {} dBm\nRSRQ: {} dB\nRSSI: {} dBm\n\n📡 小区信息:\n频点: {}\nPCI: {}\nTAC: {}\n小区ID: {}",
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

/// 从 +CMGR/+CMGL 的应答里取出 PDU 并解码。
fn parse_sms_response(resp: &AtResponse) -> Vec<Sms> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < resp.lines.len() {
        let line = resp.lines[i].trim();
        if !line.starts_with("+CMG") {
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
            Err(e) => log_warn!("PDU 解析失败: {}", e),
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

/// 查询服务小区信息（`AT^MONSC`）。
///
/// 抽成自由函数的原因：URC 分发（收到信号上报时补全明细）与定时巡检
/// （主动取样）都要用它，而巡检并不持有 `Dispatcher`。
/// 解析 `AT+CPMS?` 应答里的短信存储用量 → (已用, 容量)。
///
/// 响应形如 `+CPMS: "ME",3,50,"ME",3,50,"ME",3,50`：每三段一组，依次是
/// 存储区名、已用、容量。只取**第一组**（首选存储区），与前端短信中心的
/// 「存储用量」同一口径。
fn parse_storage_line(line: &str) -> Option<(u64, u64)> {
    let line = line.trim();
    // 个别固件回私有前缀 ^CPMS，两种都认（与前端短信中心的做法一致）
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

/// RSRP → 中文信号等级。轮询推送与 URC 通知共用，保证文案口径一致。
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
