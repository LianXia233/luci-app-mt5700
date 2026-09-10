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
            self.notifier
                .notify(Notification {
                    sender: sms.sender.clone(),
                    content: sms.content.clone(),
                    kind: NotifyKind::Sms,
                    memory_full: false,
                })
                .await;
            self.ws(serde_json::json!({
                "type": "new_sms",
                "data": {
                    "sender": sms.sender,
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

        if entry.total <= 0 || (entry.parts.len() as u32) < entry.total {
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
            if parts.len() >= 4 {
                if let Ok(raw) = parts[1].parse::<f64>() {
                    rsrp = -140.0 + raw;
                    sys_mode = parts[0].trim_matches('"').to_string();
                    ok = true;
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
        self.notify_signal(rsrp, mode_switched).await;
    }

    async fn notify_signal(&mut self, rsrp: f64, mode_switched: bool) {
        let info = self.query_monsc().await;

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
    let index = after.split(',').next()?.to_string();
    Some((storage, index))
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

fn or_unknown(s: &str) -> &str {
    if s.trim().is_empty() {
        "未知"
    } else {
        s
    }
}
