// Unsolicited-result-code (URC) handlers.
//
// These mirror `at-server.py`'s `MessageProcessor` + handler classes.  Each
// handler inspects one line of module output and, when it matches, raises a
// notification (WeChat / log file) and/or a WebSocket broadcast.  They run on
// the URC monitor thread, which only exists for NETWORK/SERIAL modes — for
// UBUS the AT channel is owned by `ubus-at-daemon` and URCs are not surfaced
// here (identical to the original behaviour).

use crate::server::bus;
use crate::server::jsonx;
use crate::server::sms_pdu;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use super::Context;

struct PartialSms {
    sender: String,
    parts: HashMap<u8, String>,
    total: u8,
    ts: String,
}

struct CallState {
    last_number: Option<String>,
    last_time: i64,
    ring: bool,
    state: String,
}

struct SignalState {
    last_rsrp: Option<i64>,
    last_mode: Option<String>,
}

pub struct MessageProcessor {
    partial: Mutex<HashMap<String, PartialSms>>,
    call: Mutex<CallState>,
    signal: Mutex<SignalState>,
    mem_full: Mutex<bool>,
}

impl MessageProcessor {
    pub fn new() -> MessageProcessor {
        MessageProcessor {
            partial: Mutex::new(HashMap::new()),
            call: Mutex::new(CallState {
                last_number: None,
                last_time: 0,
                ring: false,
                state: "idle".to_string(),
            }),
            signal: Mutex::new(SignalState {
                last_rsrp: None,
                last_mode: None,
            }),
            mem_full: Mutex::new(false),
        }
    }

    pub fn process(&self, line: &str, ctx: &Context) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        if self.call_can_handle(line) {
            self.handle_call(line, ctx);
        } else if self.mem_full_can_handle(line) {
            self.handle_mem_full(ctx);
        } else if let Some((_storage, index)) = parse_cmti(line) {
            self.handle_new_sms(index, ctx);
        } else if self.signal_can_handle(line) {
            self.handle_signal(line, ctx);
        } else if line.starts_with("^PDCPDATAINFO:") {
            self.handle_pdcp(line, ctx);
        }
    }

    // ----------------------------- Call --------------------------------
    fn call_can_handle(&self, line: &str) -> bool {
        line.contains("RING")
            || line.contains("IRING")
            || line.starts_with("+CLIP:")
            || line.contains("^CEND:")
            || line.contains("NO CARRIER")
    }

    fn handle_call(&self, line: &str, ctx: &Context) {
        let mut st = self.call.lock().unwrap();
        if line.contains("RING") || line.contains("IRING") {
            st.ring = true;
            st.state = "ringing".to_string();
        } else if line.starts_with("+CLIP:") {
            if !st.ring {
                st.state = "ringing".to_string();
            }
            if let Some(num) = parse_clip(line) {
                let now = now_secs();
                let should = st.last_number.as_ref() != Some(&num)
                    || now - st.last_time > 30
                    || st.state == "idle";
                if should {
                    st.last_number = Some(num.clone());
                    st.last_time = now;
                    st.state = "ringing".to_string();
                    let ts = format_time(now);
                    let content =
                        format!("时间：{}\n号码：{}\n状态：来电振铃", ts, num);
                    ctx.notify.notify("来电提醒", &content, "CALL", false);
                    ws_broadcast(
                        ctx,
                        "incoming_call",
                        &format!(
                            "{{\"time\":{},\"number\":{},\"state\":\"ringing\"}}",
                            jsonx::json_str(&ts),
                            jsonx::json_str(&num)
                        ),
                    );
                }
            }
        } else if line.contains("^CEND:") || line.contains("NO CARRIER") {
            if let Some(num) = st.last_number.clone() {
                let ts = format_time(now_secs());
                let content = format!("时间：{}\n号码：{}\n状态：通话结束", ts, num);
                ctx.notify.notify("来电提醒", &content, "CALL", false);
                ws_broadcast(
                    ctx,
                    "incoming_call",
                    &format!(
                        "{{\"time\":{},\"number\":{},\"state\":\"ended\"}}",
                        jsonx::json_str(&ts),
                        jsonx::json_str(&num)
                    ),
                );
            }
            st.last_number = None;
            st.last_time = 0;
            st.ring = false;
            st.state = "idle".to_string();
        }
    }

    // -------------------------- Memory full ----------------------------
    fn mem_full_can_handle(&self, line: &str) -> bool {
        line.contains("CMS ERROR: 322")
            || line.contains("MEMORY FULL")
            || line.contains("^SMMEMFULL")
    }

    fn handle_mem_full(&self, ctx: &Context) {
        let mut f = self.mem_full.lock().unwrap();
        if !*f {
            ctx.notify.notify("", "", "MEMORY_FULL", true);
            *f = true;
        }
    }

    // ----------------------------- SMS ---------------------------------
    fn handle_new_sms(&self, index: u32, ctx: &Context) {
        let resp = ctx.at.send_command(&format!("AT+CMGR={}\r", index));
        let sms_list = parse_sms_response(&resp);
        for sms in sms_list {
            if let Some(p) = sms.partial {
                self.handle_partial(ctx, &sms.sender, &sms.content, &sms.timestamp, p);
            } else {
                ctx.notify.notify(&sms.sender, &sms.content, "SMS", false);
                ws_broadcast(
                    ctx,
                    "new_sms",
                    &format!(
                        "{{\"sender\":{},\"content\":{},\"time\":{}}}",
                        jsonx::json_str(&sms.sender),
                        jsonx::json_str(&sms.content),
                        jsonx::json_str(&sms.timestamp)
                    ),
                );
            }
        }
    }

    fn handle_partial(
        &self,
        ctx: &Context,
        sender: &str,
        content: &str,
        ts: &str,
        p: sms_pdu::Concat,
    ) {
        let key = format!("{}_{}", sender, p.reference);
        let now = now_secs();
        let mut map = self.partial.lock().unwrap();
        // Prune expired (>= 1h) and cap cache size.
        map.retain(|_, v| now - parse_ts(&v.ts) < 3600);
        if map.len() > 100 {
            if let Some(oldest) = map.keys().next().cloned() {
                map.remove(&oldest);
            }
        }
        let entry = map.entry(key.clone()).or_insert(PartialSms {
            sender: sender.to_string(),
            parts: HashMap::new(),
            total: p.total,
            ts: ts.to_string(),
        });
        entry.parts.insert(p.seq, content.to_string());
        if entry.parts.len() == p.total as usize {
            let mut full = String::new();
            for i in 1..=p.total {
                if let Some(s) = entry.parts.get(&i) {
                    full.push_str(s);
                }
            }
            ctx.notify.notify(sender, &full, "SMS", false);
            ws_broadcast(
                ctx,
                "new_sms",
                &format!(
                    "{{\"sender\":{},\"content\":{},\"time\":{},\"isComplete\":true}}",
                    jsonx::json_str(sender),
                    jsonx::json_str(&full),
                    jsonx::json_str(ts)
                ),
            );
            map.remove(&key);
        }
    }

    // ---------------------------- Signal -------------------------------
    fn signal_can_handle(&self, line: &str) -> bool {
        line.contains("^CERSSI:") || line.contains("^HCSQ:")
    }

    fn handle_signal(&self, line: &str, ctx: &Context) {
        // Extract rsrp + sys_mode from ^HCSQ / ^CERSSI (best-effort, matches
        // the original's intent without the extra AT^MONSC query).
        let (rsrp, sys_mode): (Option<i64>, Option<String>) = if let Some(rest) =
            line.strip_prefix("^HCSQ:")
        {
            let parts: Vec<&str> = rest.trim().split(',').collect();
            if parts.len() >= 4 {
                let mode = parts[0].trim_matches('"').to_string();
                let rsrp_raw: i64 = parts[1].parse().unwrap_or(0);
                let rsrp = -140 + rsrp_raw;
                (Some(rsrp), Some(mode))
            } else {
                (None, None)
            }
        } else if let Some(rest) = line.strip_prefix("^CERSSI:") {
            let parts: Vec<&str> = rest.trim().split(',').collect();
            if parts.len() >= 20 {
                let rsrp: i64 = parts[18].parse().unwrap_or(0);
                (Some(rsrp), Some("4G/5G".to_string()))
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };

        let (rsrp, sys_mode) = match (rsrp, sys_mode) {
            (Some(r), Some(m)) => (r, m),
            _ => return,
        };

        let mut st = self.signal.lock().unwrap();
        let mut force = false;
        if let Some(last) = st.last_rsrp {
            if (rsrp - last).abs() >= 1 {
                force = true;
            }
        } else {
            force = true;
        }
        if st.last_mode.as_deref() != Some(sys_mode.as_str()) {
            force = true;
        }
        if force {
            let level = if rsrp >= -85 {
                "优秀"
            } else if rsrp >= -95 {
                "良好"
            } else if rsrp >= -105 {
                "一般"
            } else {
                "较差"
            };
            let ts = format_time(now_secs());
            let message = format!(
                "📶 信号变动通知\n时间: {}\n制式: {}\n信号: {}\nRSRP: {} dBm",
                ts, sys_mode, level, rsrp
            );
            ctx.notify.notify("信号监控", &message, "SIGNAL", false);
            st.last_rsrp = Some(rsrp);
            st.last_mode = Some(sys_mode);
        }
    }

    // ----------------------------- PDCP --------------------------------
    fn handle_pdcp(&self, line: &str, ctx: &Context) {
        let rest = line.trim_start_matches("^PDCPDATAINFO:").trim();
        let parts: Vec<&str> = rest.split(',').collect();
        if parts.len() < 14 {
            return;
        }
        let num = |i: usize| -> String {
            parts
                .get(i)
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(0)
                .to_string()
        };
        let obj = format!(
            "{{\"id\":{},\"pduSessionId\":{},\"discardTimerLen\":{},\"avgDelay\":{},\
             \"minDelay\":{},\"maxDelay\":{},\"highPriQueMaxBuffTime\":{},\
             \"lowPriQueMaxBuffTime\":{},\"highPriQueBuffPktNums\":{},\
             \"lowPriQueBuffPktNums\":{},\"ulPdcpRate\":{},\"dlPdcpRate\":{},\
             \"ulDiscardCnt\":{},\"dlDiscardCnt\":{}}}",
            num(0),
            num(1),
            num(2),
            num(3),
            num(4),
            num(5),
            num(6),
            num(7),
            num(8),
            num(9),
            num(10),
            num(11),
            num(12),
            num(13)
        );
        ws_broadcast(ctx, "pdcp_data", &obj);
    }
}

// ------------------------------ helpers ----------------------------------

fn ws_broadcast(ctx: &Context, typ: &str, data_obj: &str) {
    bus::broadcast(&ctx.bus, &jsonx::envelope(typ, data_obj));
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn format_time(secs: i64) -> String {
    let (y, mo, d, h, mi, s) = epoch_to_ymdhms(secs);
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, d, h, mi, s)
}

fn parse_ts(s: &str) -> i64 {
    // `timestamp` strings produced by format_time are "YYYY-MM-DD HH:MM:SS".
    let mut it = s.split(['-', ' ', ':']).filter_map(|x| x.parse::<i64>().ok());
    let y = it.next().unwrap_or(1970);
    let mo = it.next().unwrap_or(1);
    let d = it.next().unwrap_or(1);
    let h = it.next().unwrap_or(0);
    let mi = it.next().unwrap_or(0);
    let s = it.next().unwrap_or(0);
    let days = (y - 1970).max(0) * 365 + (y - 1969).max(0).div_euclid(4)
        + (1..mo).map(|m| month_days(m, is_leap(y))).sum::<i64>()
        + (d - 1);
    (days * 86400) + h * 3600 + mi * 60 + s
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}
fn month_days(m: i64, leap: bool) -> i64 {
    match m {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}
fn epoch_to_ymdhms(mut t: i64) -> (i64, i64, i64, i64, i64, i64) {
    let days = t / 86400;
    t %= 86400;
    let mut d = days + 719163;
    let mut y = 1970;
    loop {
        let leap = is_leap(y);
        let yd = if leap { 366 } else { 365 };
        if d >= yd {
            d -= yd;
            y += 1;
        } else {
            break;
        }
    }
    let mlen = [
        31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut mo = 1;
    let mut rem = d;
    loop {
        let len = if mo == 2 && is_leap(y) { 29 } else { mlen[(mo - 1) as usize] };
        if rem >= len {
            rem -= len;
            mo += 1;
        } else {
            break;
        }
    }
    (
        y,
        mo as i64,
        rem + 1,
        t / 3600,
        (t % 3600) / 60,
        t % 60,
    )
}

/// Parse `+CLIP: "123456789"` -> number.
fn parse_clip(line: &str) -> Option<String> {
    let idx = line.find("+CLIP:")?;
    let rest = &line[idx + 6..];
    let q1 = rest.find('"')?;
    let after = &rest[q1 + 1..];
    let q2 = after.find('"')?;
    Some(after[..q2].to_string())
}

/// Parse `+CMTI: "ME",12` -> (storage, index).
fn parse_cmti(line: &str) -> Option<(String, u32)> {
    let idx = line.find("+CMTI:")?;
    let rest = &line[idx + 6..];
    let q1 = rest.find('"')?;
    let after = &rest[q1 + 1..];
    let q2 = after.find('"')?;
    let storage = after[..q2].to_string();
    let num_part = &after[q2 + 1..];
    let comma = num_part.find(',')?;
    let digits = &num_part[comma + 1..];
    let index: u32 = digits.trim().parse().ok()?;
    Some((storage, index))
}

/// Decode a `+CMGR` response: lines starting with `+CMG` are followed by the
/// PDU hex on the next line.
fn parse_sms_response(resp: &[u8]) -> Vec<sms_pdu::Sms> {
    let text = String::from_utf8_lossy(resp);
    let lines: Vec<&str> = text.split("\r\n").collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].starts_with("+CMG") {
            if i + 1 < lines.len() {
                let pdu = lines[i + 1].trim();
                if !pdu.is_empty() && pdu.bytes().all(|b| b.is_ascii_hexdigit()) {
                    out.push(sms_pdu::decode(pdu));
                }
                i += 2;
            } else {
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    out
}
