// Notification delivery: WeChat Work webhook (HTTP POST) and a local log file.
//
// The original `at-server.py` delivered notifications through two channels:
// an enterprise-WeChat webhook (posted as a `text` message) and/or an appended
// log file.  We preserve both.  Because the WeChat endpoint is HTTPS, we shell
// out to `curl` (present on the MT5700M firmware / most OpenWrt images and
// already required by other packages) instead of bundling a TLS stack — this
// keeps the dependency surface flat for the offline build.  The payload is
// written to a temp file first so the JSON is never re-quoted on the command
// line (avoids injection and escaping bugs).

use crate::server::config::NotifyConfig;
use crate::shell;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct NotificationManager {
    pub wechat: String,
    pub log_file: String,
    pub sms: bool,
    pub call: bool,
    pub memory_full: bool,
    pub signal: bool,
}

impl NotificationManager {
    pub fn from(cfg: &NotifyConfig) -> NotificationManager {
        NotificationManager {
            wechat: cfg.wechat.clone(),
            log_file: cfg.log_file.clone(),
            sms: cfg.sms,
            call: cfg.call,
            memory_full: cfg.memory_full,
            signal: cfg.signal,
        }
    }

    fn enabled(&self, ntype: &str) -> bool {
        match ntype {
            "SMS" => self.sms,
            "CALL" => self.call,
            "MEMORY_FULL" => self.memory_full,
            "SIGNAL" => self.signal,
            _ => true,
        }
    }

    /// Send a notification of the given type.  `is_memory_full` selects the
    /// dedicated storage-full wording (mirrors the Python single-message path).
    pub fn notify(&self, sender: &str, content: &str, ntype: &str, is_memory_full: bool) {
        if !self.enabled(ntype) {
            return;
        }
        if !self.wechat.is_empty() {
            self.send_wechat(sender, content, is_memory_full);
        }
        if !self.log_file.is_empty() {
            self.write_log(sender, content, is_memory_full);
        }
    }

    /// Format the human-readable text for one notification (matches the
    /// Python `_combine_messages` single-message branch).
    fn format_text(&self, sender: &str, content: &str, is_memory_full: bool) -> String {
        if is_memory_full {
            "⚠️ 警告：短信存储空间已满\n请及时处理，否则可能无法接收新短信".to_string()
        } else if sender == "来电提醒" {
            format!("📞 来电提醒\n{}", content)
        } else if sender == "信号监控" {
            content.to_string()
        } else {
            format!("📱 新短信通知\n发送者: {}\n内容: {}", sender, content)
        }
    }

    fn send_wechat(&self, sender: &str, content: &str, is_memory_full: bool) {
        let text = self.format_text(sender, content, is_memory_full);
        let payload = format!(
            "{{\"msgtype\":\"text\",\"text\":{{\"content\":{}}}}}",
            crate::server::jsonx::json_str(&text)
        );
        // Write payload to a temp file, then POST it via curl.
        let tmp = match shell::run_allow_fail("mktemp", &["-t", "mt5700m-ws.XXXXXX"]) {
            ref t if !t.is_empty() => t.clone(),
            _ => return,
        };
        {
            let mut f = match std::fs::File::create(&tmp) {
                Ok(f) => f,
                Err(_) => return,
            };
            if f.write_all(payload.as_bytes()).is_err() {
                let _ = std::fs::remove_file(&tmp);
                return;
            }
        }
        let _ = shell::run(
            "curl",
            &[
                "-sS",
                "-m",
                "5",
                "-X",
                "POST",
                "-H",
                "Content-Type: application/json",
                "--data-binary",
                &format!("@{}", tmp),
                &self.wechat,
            ],
        );
        let _ = std::fs::remove_file(&tmp);
    }

    fn write_log(&self, sender: &str, content: &str, is_memory_full: bool) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let ts = format_rfc3339(now);
        let entry = if is_memory_full {
            format!("[{}] 存储空间已满警告\n", ts)
        } else {
            format!("[{}] 发送者: {}\n内容: {}\n", ts, sender, content)
        };
        // Mirror the Python log separator.
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_file)
            .and_then(|mut f| {
                use std::io::Write as _;
                f.write_all(entry.as_bytes())
                    .and_then(|_| f.write_all(b"-".repeat(50).as_slice()))
                    .and_then(|_| f.write_all(b"\n"))
            });
    }
}

/// Format a unix timestamp as `YYYY-MM-DD HH:MM:SS` in local time.  OpenWrt has
/// no timezone database by default, so we emit UTC — sufficient for logs.
fn format_rfc3339(secs: i64) -> String {
    let (y, mo, d, h, mi, s) = epoch_to_ymdhms(secs);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        y, mo, d, h, mi, s
    )
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn epoch_to_ymdhms(mut t: i64) -> (i64, i64, i64, i64, i64, i64) {
    let days = t / 86400;
    t %= 86400;
    let mut d = days + 719163; // 1970-01-01 is day 719163
    let mut y = 1970;
    loop {
        let leap = if is_leap(y) { 366 } else { 365 };
        if d >= leap {
            d -= leap;
            y += 1;
        } else {
            break;
        }
    }
    let month_len = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let leap = is_leap(y);
    let mut mo = 1;
    let mut rem = d;
    loop {
        let len = if mo == 2 && leap { 29 } else { month_len[(mo - 1) as usize] };
        if rem >= len {
            rem -= len;
            mo += 1;
        } else {
            break;
        }
    }
    let day = rem + 1;
    let h = t / 3600;
    let mi = (t % 3600) / 60;
    let s = t % 60;
    (y, mo as i64, day as i64, h, mi, s)
}
