//! 主动上报分发：来电、新短信、存储满、信号变化、PDCP 统计。
//! 与 Go 实现（urc.go）逐项一致。

use crate::{log_info, log_warn};
use crate::atclient::{AtClient, AtResponse, Unsolicited};
use crate::notify::{Notification, NotifyKind, Notifier, SENDER_CALL, SENDER_SIGNAL};
use crate::pdu::{Sms, decode_incoming_pdu};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

const CALL_DEDUP_WINDOW: Duration = Duration::from_secs(30);
const SIGNAL_CHANGE_THRESHOLD: f64 = 1.0;
const PARTIAL_SMS_TTL: Duration = Duration::from_secs(3600);
const MAX_PARTIAL_SMS: usize = 100;

// ============= 信号换算（边界值逐一对齐前端 rpc.js 的 convertRsrp/Rsrq/Sinr/Rssi） =============
// 这些函数与前端共用同一套换算口径，改动任一侧都要同步另一侧
// （见 tests/lte-signal-contract.test.js 的「⑤ 浮点尾数」段）。
//
// ★ 接线现状（2026-09-28 更新）：**四个都在生产路径上**。
//   · convert_rsrp / convert_rssi：handle_signal 里 ^HCSQ（以及非 NR/LTE 那一路）的换算；
//   · convert_rsrq / convert_sinr：同一应答里的 rsrq / sinr，取出来给 ^MONSC 兜底
//     —— ^MONSC 的解析只在 NR 分支赋值 sinr，LTE 用户的通知里 SINR 因此长期是空的，
//     详见 notify_signal / fill_from_hcsq 的注释。
//
//   本段此前写的是「只有 convert_rsrp / convert_rssi 走在生产路径上，后两者尚无生产
//   调用点」——那句话在 2026-09-28 完成接线后就**过时**了（当时它们没有调用点，
//   `cargo check` 会报 dead_code；而 CI 的 rust-check 只做 check、不跑 test，
//   所以 2.3.43 那次的契约漂移也没人发现，见 CHANGELOG 2.3.43）。
//   留下这句更正，是为了让人一眼看出它们**已经**被用起来了，不必再去追那段历史。
fn convert_rsrp(raw: f64) -> f64 {
    if raw == 0.0 { -140.0 } else if raw >= 97.0 { -44.0 } else { -140.0 + raw }
}
fn convert_rsrq(raw: f64) -> f64 {
    if raw == 0.0 { -19.5 } else if raw >= 34.0 { -3.0 } else { -19.5 + raw * 0.5 }
}
/// 收到一位小数 —— 与前端 rpc.js 的 `round1` 同义、同适用范围。
///
/// SINR 步进 0.2 dB，而 0.2 不是二进制有限小数：`-20 + 236 × 0.2` 在 f64 里是
/// 27.200000000000003，直接进 JSON 就是一条带尾数的读数。RSRP / RSSI 是整数步进、
/// RSRQ 是 0.5 步进，二进制都能精确表示，所以只有 SINR 需要这一步 ——
/// 与前端「只给 convertSinr 加 round1」的范围完全一致。
fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}
fn convert_sinr(raw: f64) -> f64 {
    let v = if raw == 0.0 { -20.0 } else if raw >= 251.0 { 30.0 } else { -20.0 + raw * 0.2 };
    /* clamp 而非 min/max 链（2026-10-22 审计）：raw 若为 NaN（"nan" 能被
     * parse::<f64> 成功解析），min/max 链会把它变成 30.0 —— 「读不到」被
     * 伪装成「信号最好」。clamp 保留 NaN，JSON 侧序列化为 null，前端按
     * 「读不到」如实展示（红线 23）。非 NaN 输入下与原式逐值等价。 */
    round1(v.clamp(-20.0, 30.0))
}
fn convert_rssi(raw: f64) -> f64 {
    if raw == 0.0 { -120.0 } else if raw >= 96.0 { -25.0 } else { -121.0 + raw }
}

pub type Broadcaster = Arc<dyn Fn(serde_json::Value) + Send + Sync>;

#[allow(dead_code)] // sender 保留（分段归属校验）
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
    /// 短信存储满时是否自动删除最旧的短信腾出空间。
    sms_auto_clean: bool,

    partials: HashMap<String, PartialSms>,
}

impl Dispatcher {
    pub fn new(
        client: Arc<AtClient>,
        notifier: Arc<Notifier>,
        ws: Broadcaster,
        ctx: tokio::sync::watch::Receiver<bool>,
        sms_auto_clean: bool,
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
            sms_auto_clean,
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

    /*
     * 某一条上报解析失败时只丢这一条，不会拖垮整个分发。
     *
     * ★ 2026-09-19 会审后的口径修正：这里**不捕获 panic**，也不该指望捕获 ——
     * Cargo.toml 的 profile.release 写的是 `panic = "abort"`，release 构建下 panic
     * 根本不会 unwind，而是**直接终止整个服务进程**（init.d 有 procd respawn 兜底，
     * 但重试次数有限）。也就是说 catch_unwind 在 abort 模式下是**无效修复**，
     * 写上去只会制造「已经兜住了」的虚假安全感 —— 比不写更危险。
     *
     * 真正的做法是**消除 panic 源**：handler 里凡是按下标取字段的地方都要先判长度
     * （见 handle_signal 中 ^HCSQ 的 `parts.len() > idx`），解析失败走「放弃这一条」，
     * 绝不让索引越界。新增 handler 时照此办理。
     */
    async fn safe_handle(&mut self, line: String) {
        self.handle(&line).await;
    }

    /// 按固定优先级找到第一个能处理该行的处理器。
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

            let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
            self.notifier
                .notify(Notification {
                    sender: SENDER_CALL.into(),
                    content: format!("时间：{ts}\n号码：{number}\n状态：来电振铃"),
                    kind: NotifyKind::Call,
                    memory_full: false,
                })
                .await;
            self.ws(serde_json::json!({
                "type": "incoming_call",
                "data": {"time": ts, "number": number, "state": "ringing"}
            }));
        } else if line.contains("^CEND:") || line == "NO CARRIER" {
            if !self.last_call_number.is_empty() {
                let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
                let number = self.last_call_number.clone();
                self.notifier
                    .notify(Notification {
                        sender: SENDER_CALL.into(),
                        content: format!("时间：{ts}\n号码：{number}\n状态：通话结束"),
                        kind: NotifyKind::Call,
                        memory_full: false,
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
                })
                .await;
        });

        /*
         * 兜底：按时间从旧到新删掉最旧的几条，给后续短信腾出空间。
         * 注意此时模组已经拒绝了这一条（+CMS ERROR: 322 / ^SMMEMFULL），
         * 清理救不回它，但能避免「之后每一条都收不到」。
         *
         * 必须 spawn：清理要连发数条 AT，而本函数是同步的、且正持有 &mut self。
         * 传进去的是 Arc<AtClient> 与 watch::Receiver 的克隆，不借 self。
         */
        if self.sms_auto_clean {
            let client = self.client.clone();
            let ctx = self.ctx.clone();
            let notifier = self.notifier.clone();
            tokio::spawn(async move {
                let n = crate::smsclean::clean_oldest(&client, &ctx).await;
                if n > 0 {
                    notifier
                        .notify(Notification {
                            sender: String::new(),
                            content: format!(
                                "短信存储已满，已自动删除最旧的 {} 条短信以腾出接收空间",
                                n
                            ),
                            kind: NotifyKind::MemoryFull,
                            memory_full: true,
                        })
                        .await;
                }
            });
        }
    }

    // ============= 新短信 =============

    async fn handle_new_sms(&mut self, storage: String, index: String) {
        log_info!("收到新短信，存储区: {}，索引: {}", storage, index);

        // 能存下新短信说明存储已腾出空位：复位「存储满」通知标志。
        // 该标志此前只在 handle_memory_full 里置 true、从不复位，导致清理短信
        // 之后若再次存满，不会再推任何通知（兜底静默失效）。
        self.memory_full_notified = false;

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
            self.notifier
                .notify(Notification {
                    sender: sms.sender.clone(),
                    content: sms.content.clone(),
                    kind: NotifyKind::Sms,
                    memory_full: false,
                })
                .await;
            /*
             * index 必须带：前端用它定位这条短信，删除时下发 AT+CMGD=<index>。
             * 此前推送里没有这个字段，前端只能退化成负数占位，删除因此落到
             * 「已发缓存」分支——提示删除成功，模组上的短信其实还在。
             *
             * 长短信（走 assemble_partial 分支）仍不带 index：拼接后的完整消息在
             * 存储里是多段，只给一个索引会「删一段、留一段」，反而更糟，
             * 保持现状（前端不发起删除）比删坏要好。
             */
            self.ws(serde_json::json!({
                "type": "new_sms",
                "data": {
                    "sender": sms.sender,
                    "content": sms.content,
                    "time": sms.date.format("%Y-%m-%d %H:%M:%S").to_string(),
                    "index": index.parse::<u32>().ok(),
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
        // key 含 total（A-B11，2026-10-22 审计）：同号同 reference 但分段数不同的
        // 两条长短信（网络重发场景）若共用一个 key，会互相污染分段表。
        let key = format!("{}_{}_{}", sms.sender, info.reference, info.parts_count);
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

        // A-B4（2026-10-22 审计）：除数量够之外，还必须 1..=total **每段都在** ——
        // 畸形分段（如 {1,5} 而 total=2）在旧逻辑下会拼出缺段正文并按完整推送。
        let complete = entry.total > 0
            && (1..=entry.total).all(|i| entry.parts.contains_key(&i));
        if !complete {
            return;
        }

        let mut full = String::new();
        for i in 1..=entry.total {
            if let Some(p) = entry.parts.get(&i) {
                full.push_str(p);
            }
        }
        let date = sms.date;
        self.partials
            .remove(&format!("{}_{}_{}", sms.sender, info.reference, info.parts_count));

        let notifier = self.notifier.clone();
        let sender = sms.sender.clone();
        let content = full.clone();
        tokio::spawn(async move {
            notifier
                .notify(Notification {
                    sender,
                    content,
                    kind: NotifyKind::Sms,
                    memory_full: false,
                })
                .await;
        });
        self.ws(serde_json::json!({
            "type": "new_sms",
            "data": {
                "sender": sms.sender,
                "content": full,
                "time": date.format("%Y-%m-%d %H:%M:%S").to_string(),
                "isComplete": true,
            }
        }));
    }

    // ============= 信号 =============

    async fn handle_signal(&mut self, line: &str) {
        let line = line.split('\n').next().unwrap_or(line);

        let mut rsrp: f64 = 0.0;
        let mut sys_mode = String::new();
        let mut ok = false;
        // ^HCSQ 里顺带取到的 sinr / rsrq，只用于给 ^MONSC 兜底（见 notify_signal）
        let mut sinr: Option<f64> = None;
        let mut rsrq: Option<f64> = None;

        if line.contains("^CERSSI:") {
            let parts = split_fields(line, "^CERSSI:");
            // 第 19/20/21 个字段是 RSRP/RSRQ/SINR
            if parts.len() >= 20 {
                if let Ok(v) = parts[18].parse::<f64>() {
                    rsrp = v;
                    sys_mode = "4G/5G".into();
                    ok = true;
                }
            }
        } else if line.contains("^HCSQ:") {
            let parts = split_fields(line, "^HCSQ:");
            /*
             * parts[0] 为带引号的制式名。字段顺序随制式变化 ——
             * **以下按手册 13.5 的字段表逐条核对**（《MT5700M-CN AT 命令手册》
             * 13.5.3 参数说明，PDF 287-289 页）：
             *
             *   <sysmode>   value1      value2    value3     value4
             *   "GSM"       gsm_rssi    -         -          -
             *   "WCDMA"     wcdma_rssi  rscp      ecio       -
             *   "LTE"       lte_rssi    lte_rsrp  lte_sinr   lte_rsrq
             *   "NR"        5g_rsrp     5g_sinr   5g_rsrq    -
             *
             * ★ 2026-09-28 更正：本段此前的注释写的是
             *   `"LTE",<srxlev>,<rsrp>,<rsrq>,<sinr>,<rssi>` —— 三处都错：
             *   ① 字段名 srxlev 在手册里根本不存在；
             *   ② **LTE 的 sinr 在 value3、rsrq 在 value4**，旧注释把两者对调了；
             *   ③ 不存在第 5 个值。
             *   当时只取 parts[2]（rsrp）恰好侥幸取对，但按旧注释去接 sinr/rsrq
             *   必然取反 —— 前端 rpc.js 的 parseHCSQ 才是照手册写对的那一份。
             *
             * 旧实现还一律取 parts[1] 且用 -140+raw 线性换算，LTE 下 rsrp 取错字段、
             * 且换算与前端 rpc.js 不一致。这里按制式选字段并用对齐前端的换算。
             */
            if parts.len() >= 2 {
                let mode = parts[0].trim_matches('"');
                // 制式名可能带后缀，前端 rpc.js 的 parseHCSQ 用 indexOf 前缀匹配，这里保持一致
                let is_lte = mode.starts_with("LTE");
                let is_nr = mode.starts_with("NR");
                let idx = if is_lte { 2 } else { 1 };
                /*
                 * ★ 越界保护（主控复核补）：LTE 要取 parts[2]，而这里只保证 len>=2。
                 * 少了这层判断，字段不足的 ^HCSQ 会让 Rust 索引越界 panic ——
                 * 而 panic 会打断整个 URC 分发循环（见 safe_handle 的注释承诺）。
                 * 拿不到就算了，绝不能因为一条畸形上报把分发链打掉。
                 */
                if let Some(raw) = parts.get(idx).and_then(|v| eng_value(v)) {
                    // 非 NR/LTE 制式那一路在前端是 convertRssi（量纲不同），不能统一用 rsrp
                    rsrp = if is_nr || is_lte { convert_rsrp(raw) } else { convert_rssi(raw) };
                    sys_mode = mode.to_string();
                    ok = true;
                }
                /*
                 * 同一应答里的 sinr / rsrq 是**免费带回来的**，顺手取出来交给
                 * notify_signal 做兜底（^MONSC 在 LTE 下不提供 sinr，见那里的注释）。
                 * 位置同样按上表：LTE = value3(sinr) / value4(rsrq)，
                 * NR = value2(sinr) / value3(rsrq)。取不到就留 None，绝不猜。
                 */
                if ok && (is_lte || is_nr) {
                    let (si, ri) = if is_lte { (3, 4) } else { (2, 3) };
                    sinr = parts.get(si).and_then(|v| eng_value(v)).map(convert_sinr);
                    rsrq = parts.get(ri).and_then(|v| eng_value(v)).map(convert_rsrq);
                }
            }
        }

        if !ok {
            return;
        }

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
        self.notify_signal(rsrp, mode_switched, sinr, rsrq).await;
    }

    /// `hcsq_sinr` / `hcsq_rsrq`：本次 ^HCSQ 里顺带取到的值，**仅用于给 ^MONSC 兜底**。
    async fn notify_signal(
        &mut self,
        rsrp: f64,
        mode_switched: bool,
        hcsq_sinr: Option<f64>,
        hcsq_rsrq: Option<f64>,
    ) {
        let info = self.query_monsc().await;
        // ^MONSC 为空时用 ^HCSQ 兜底（见 fill_from_hcsq 的说明）
        let sinr_txt = fill_from_hcsq(&info.sinr, hcsq_sinr);
        let rsrq_txt = fill_from_hcsq(&info.rsrq, hcsq_rsrq);

        let mut b = String::new();
        if mode_switched {
            b.push_str("⚡ 网络切换提醒\n");
        }
        b.push_str(&format!(
            "📶 信号变动通知\n时间: {}\n制式: {}\n信号: {}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            info.rat,
            signal_level(rsrp)
        ));

        let content = match info.rat.as_str() {
            "NR" => {
                format!(
                    "{}RSRP: {} dBm\nRSRQ: {} dB\nSINR: {} dB\n\n📡 小区信息:\n频点: {}\nPCI: {}\nTAC: {}\n小区ID: {}",
                    b,
                    or_unknown(&info.rsrp),
                    or_unknown(&rsrq_txt),
                    or_unknown(&sinr_txt),
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
                    or_unknown(&rsrq_txt),
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
            })
            .await;
    }

    /// AT^MONSC 返回的服务小区信息。
    async fn query_monsc(&self) -> MonscInfo {
        let mut info = MonscInfo { rat: "未知".into(), ..Default::default() };
        let resp = match self.client.send_command(&self.ctx, "AT^MONSC", crate::atclient::COMMAND_TIMEOUT, None).await {
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
                /* NR/LTE 统一用 match guard（clippy 折叠后两分支风格一致；
                 * guard 不满足落 _ => {} 空分支，与原先「分支内 if + 隐式空 else」等价） */
                "NR" if parts.len() >= 11 => {
                    info.arfcn = parts[3].clone();
                    info.cell_id = parts[5].clone();
                    info.pci = hex_to_dec(&parts[6]);
                    info.tac = parts[7].clone();
                    info.rsrp = parts[8].clone();
                    info.rsrq = parts[9].clone();
                    info.sinr = parts[10].clone();
                }
                "LTE" if parts.len() >= 10 => {
                        info.arfcn = parts[3].clone();
                        info.cell_id = parts[4].clone();
                        info.pci = hex_to_dec(&parts[5]);
                        info.tac = parts[6].clone();
                        info.rsrp = parts[7].clone();
                        info.rsrq = parts[8].clone();
                        info.rssi = parts[9].clone();
                    }
                _ => {}
            }
            return info;
        }
        info
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
struct MonscInfo {
    rat: String,
    arfcn: String,
    cell_id: String,
    pci: String,
    tac: String,
    rsrp: String,
    rsrq: String,
    sinr: String,
    rssi: String,
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

fn signal_level(rsrp: f64) -> &'static str {
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

/// 把 ^HCSQ 的一个工程值字段解析成数字。
///
/// ★ **255 按"未知"处理**：手册 13.5.3 的三张换算表（rssi / rsrp / sinr / rsrq）
///   都以 `255 未知或不可测` 结尾 —— 而线性公式会把它当成"越界即最好"
///   （convert_rsrp(255) → -44、convert_sinr(255) → 30），于是模组明确说
///   "测不出来"时，界面反而显示满格信号。这里统一拦成 None，交给上层显示「未知」。
fn eng_value(s: &str) -> Option<f64> {
    let v = s.trim().parse::<f64>().ok()?;
    if v >= 255.0 {
        None
    } else {
        Some(v)
    }
}

fn or_unknown(s: &str) -> &str {
    if s.trim().is_empty() {
        "未知"
    } else {
        s
    }
}

/// ^MONSC 的值优先；它为空时用 ^HCSQ 兜底值（保留一位小数）。
/// 两者都没有就返回空串，交给 or_unknown 渲染成「未知」。
///
/// 为什么需要它：`MonscInfo.sinr` 只在 ^MONSC 的 **NR** 分支被赋值，所以 LTE 用户的
/// 信号通知里 SINR 一直是「未知」—— 而同一次 ^HCSQ 的 LTE 应答第 3 个值就是 sinr
/// （手册 13.5 字段表）。两者同为 dB，convert_* 又与前端同口径，混用是安全的。
/// 关键约束：**只在 ^MONSC 为空时填**，绝不覆盖它给出的权威值。
fn fill_from_hcsq(monsc: &str, fallback: Option<f64>) -> String {
    if !monsc.trim().is_empty() {
        return monsc.to_string();
    }
    match fallback {
        Some(v) => format!("{v:.1}"),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /*
     * new_sms 推送给前端的 index 就来自 cmti_capture，前端拿它下发 AT+CMGD=<index>
     * 删除短信；index 为负或缺失时删除会静默落到「已发缓存」分支。所以要锁住：
     * 解析出来的索引既是纯数字、也能被 parse::<u32>() 接受。
     */
    #[test]
    fn cmti_capture_解析存储区与索引() {
        let (storage, index) = cmti_capture("+CMTI: \"ME\",12").expect("应解析出存储区与索引");
        assert_eq!(storage, "ME");
        assert_eq!(index, "12");
        assert_eq!(index.parse::<u32>().ok(), Some(12u32));
    }

    #[test]
    fn cmti_capture_支持_sim_存储区与空格() {
        let (storage, index) = cmti_capture("+CMTI: \"SM\", 3").expect("应容忍逗号后的空格");
        assert_eq!(storage, "SM");
        assert_eq!(index.parse::<u32>().ok(), Some(3u32));
    }

    /// URC 里夹带换行/命令时不能放过，否则等于允许模组喂进来一条 AT 命令。
    #[test]
    fn cmti_capture_拒绝非纯数字索引() {
        assert!(cmti_capture("+CMTI: \"ME\",12\rAT+CFUN=0").is_none());
        assert!(cmti_capture("+CMTI: \"ME\",abc").is_none());
        assert!(cmti_capture("+CMTI: \"ME\",").is_none());
        assert!(cmti_capture("+CMT: \"ME\",12").is_none());
    }

    // ============= P02：^HCSQ 信号换算（边界值逐一对齐前端 rpc.js） =============
    // 这些断言锁定 convert_* 与 rpc.js:731-737 完全一致，任一侧改坏都会红。

    #[test]
    fn convert_rsrp_边界对齐_rpcjs() {
        // rpc.js: raw==0 -> -140; raw>=97 -> -44; 否则 -140+raw
        assert_eq!(convert_rsrp(0.0), -140.0);
        assert_eq!(convert_rsrp(96.0), -44.0);
        assert_eq!(convert_rsrp(97.0), -44.0);
        assert_eq!(convert_rsrp(50.0), -90.0);
        assert_eq!(convert_rsrp(77.0), -63.0);
    }

    #[test]
    fn convert_rsrq_边界对齐_rpcjs() {
        // rpc.js: raw==0 -> -19.5; raw>=34 -> -3; 否则 -19.5 + raw*0.5
        assert_eq!(convert_rsrq(0.0), -19.5);
        assert_eq!(convert_rsrq(34.0), -3.0);
        assert_eq!(convert_rsrq(31.0), -4.0);
        assert_eq!(convert_rsrq(33.0), -3.0);
    }

    #[test]
    fn convert_sinr_边界对齐_rpcjs() {
        // rpc.js: raw==0 -> -20; raw>=251 -> 30; 否则 -20 + raw*0.2; 限幅 [-20, 30]
        assert_eq!(convert_sinr(0.0), -20.0);
        assert_eq!(convert_sinr(251.0), 30.0);
        assert_eq!(convert_sinr(236.0), 27.2);
        assert_eq!(convert_sinr(300.0), 30.0); // 超上限被夹回 30
        assert_eq!(convert_sinr(20.0), -16.0);
        // ★ 浮点尾数（前端 2.3.43 修的就是这个数）：`-20 + 146 × 0.2` 在 f64 里是
        //   9.200000000000003，界面上曾直接拼成 "9.200000000000003 dB"。前端已在
        //   换算出口用 round1 收尾，后端必须同口径 —— 否则同一条 ^HCSQ，经 URC
        //   推送与经 AT 轮询会给出两个不同的读数。
        assert_eq!(convert_sinr(146.0), 9.2);
        assert_eq!(convert_sinr(106.0), 1.2); // 同一事故里 106 那档的形态
    }

    #[test]
    fn convert_sinr_保持nan不被伪装成上限() {
        // ★ B-05 同款问题（2026-10-22 审计）：raw 若为 NaN（"nan" 能被
        //   parse::<f64> 成功解析），min/max 链会把它变成 30.0 ——「读不到」
        //   被伪装成「信号最好」。clamp 保留 NaN，JSON 侧序列化为 null。
        //   这里锁住这条语义，防止有人「优化」回 min/max 链。
        let v = convert_sinr(f64::NAN);
        assert!(v.is_nan(), "NaN 必须原样透传，而不是变成 {}", v);
    }

    #[test]
    fn convert_rssi_边界对齐_rpcjs() {
        // rpc.js: raw==0 -> -120; raw>=96 -> -25; 否则 -121 + raw
        assert_eq!(convert_rssi(0.0), -120.0);
        assert_eq!(convert_rssi(96.0), -25.0);
        assert_eq!(convert_rssi(40.0), -81.0);
    }

    // 反向验证（必需）：新实现下 LTE 必须取 rsrp 字段（parts[2]），而非旧实现的 parts[1]。
    // 若把「旧行为」喂给同一检查逻辑，断言必红 —— 证明字段映射真的改了。
    #[test]
    fn hcsq_lte_取_rsrp_字段_而非旧_parts1() {
        let line = "^HCSQ: \"LTE\",50,72,31,20";
        let parts = split_fields(line, "^HCSQ:");
        let mode = parts[0].trim_matches('"');
        let rsrp_idx = if mode == "LTE" { 2 } else { 1 };
        let new_val = convert_rsrp(parts[rsrp_idx].parse::<f64>().unwrap());
        // 旧实现：一律 parts[1]，且 -140+raw 线性换算
        let old_val = -140.0 + parts[1].parse::<f64>().unwrap();
        assert_ne!(new_val, old_val, "LTE 下新旧换算必须不同，否则修复无效");
        assert_eq!(new_val, -68.0); // convert_rsrp(72) = -140 + 72
    }

    // 越界保护（主控复核补）：LTE 的 rsrp 取自 parts[2]，因此字段不足时必须放弃。
    // release 下 panic = "abort"，这里越界不是「丢一条上报」，而是终止整个进程。
    #[test]
    fn hcsq_lte_取第三个字段_故字段数必须大于二() {
        let idx_lte: usize = 2;
        let short: Vec<&str> = vec!["\"LTE\"", "50"];
        assert!(short.len() <= idx_lte, "字段不足时必须走放弃分支，不得取 parts[2]");
        let full: Vec<&str> = vec!["\"LTE\"", "50", "72"];
        assert!(full.len() > idx_lte);
        assert_eq!(convert_rsrp(full[2].parse::<f64>().unwrap()), -68.0);
    }
}
