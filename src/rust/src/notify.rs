//! 通知：企业微信 webhook（60 秒合并、重试 3 次）+ 本地日志文件。
//! 与 Go 实现（notify.go）行为一致。

use crate::{log_error, log_info, log_warn};
use crate::config::NotificationConfig;
use std::path::Path;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

const NOTIFY_INTERVAL: Duration = Duration::from_secs(60);
const NOTIFY_QUEUE_SIZE: usize = 256;
const NOTIFY_MAX_PENDING: usize = 1000;
const NOTIFY_MAX_RETRIES: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyKind {
    Sms,
    Call,
    MemoryFull,
    Signal,
}

/// 与旧实现一致的两个特殊发送方名字，决定了消息的排版样式。
pub const SENDER_CALL: &str = "来电提醒";
pub const SENDER_SIGNAL: &str = "信号监控";

#[derive(Debug, Clone)]
pub struct Notification {
    pub sender: String,
    pub content: String,
    pub kind: NotifyKind,
    pub memory_full: bool,
}

pub struct Notifier {
    cfg: NotificationConfig,
    tx: mpsc::Sender<Notification>,
    log_file: Option<String>,
}

#[allow(dead_code)] // sender 字段保留（通知来源标识，与 Go 一致）
impl Notifier {
    pub fn new(cfg: NotificationConfig) -> (Notifier, mpsc::Receiver<Notification>) {
        let (tx, rx) = mpsc::channel(NOTIFY_QUEUE_SIZE);
        let log_file = if !cfg.log_file.is_empty() {
            match prepare_log_file(&cfg.log_file) {
                Ok(path) => {
                    log_info!("日志通知已启用: {}", path);
                    Some(path)
                }
                Err(e) => {
                    log_error!("日志通知不可用: {}", e);
                    None
                }
            }
        } else {
            None
        };

        if !cfg.wechat_webhook.is_empty() {
            log_info!("企业微信推送已启用");
        }

        (
            Notifier {
                cfg,
                tx,
                log_file,
            },
            rx,
        )
    }

    pub fn sender(&self) -> mpsc::Sender<Notification> {
        self.tx.clone()
    }

    fn enabled(&self, kind: NotifyKind) -> bool {
        match kind {
            NotifyKind::Sms => self.cfg.types.sms,
            NotifyKind::Call => self.cfg.types.call,
            NotifyKind::MemoryFull => self.cfg.types.memory_full,
            NotifyKind::Signal => self.cfg.types.signal,
        }
    }

    /// 记录一条事件。日志立即落盘，企业微信进入合并队列。
    pub async fn notify(&self, msg: Notification) {
        if !self.enabled(msg.kind) {
            return;
        }

        if let Some(path) = &self.log_file {
            if let Err(e) = append_log(path, &msg) {
                log_error!("写入通知日志失败: {}", e);
            }
        }

        if self.cfg.wechat_webhook.is_empty() {
            return;
        }
        let sender = msg.sender.clone();
        if self.tx.try_send(msg).is_err() {
            log_warn!("通知队列已满，丢弃一条: {}", sender);
        }
    }

    /// 驱动企业微信的合并发送，直到 ctx 结束。
    /// 合并窗口 60 秒：窗口内到达的事件攒成一条发，窗口到期立即发。
    pub async fn run(&self, mut rx: mpsc::Receiver<Notification>, mut ctx: tokio::sync::watch::Receiver<bool>) {
        if self.cfg.wechat_webhook.is_empty() {
            while ctx.changed().await.is_ok() {}
            return;
        }

        let mut pending: Vec<Notification> = Vec::new();
        let mut last_send = Instant::now() - NOTIFY_INTERVAL;

        loop {
            let wait = NOTIFY_INTERVAL.saturating_sub(last_send.elapsed());
            tokio::select! {
                _ = ctx.changed() => {
                    flush(&self.cfg.wechat_webhook, &mut pending);
                    return;
                }
                msg = rx.recv() => {
                    match msg {
                        Some(msg) => {
                            if pending.len() >= NOTIFY_MAX_PENDING {
                                log_warn!("待发通知超过 {} 条，丢弃最旧的一条", NOTIFY_MAX_PENDING);
                                pending.remove(0);
                            }
                            pending.push(msg);
                        }
                        None => {
                            flush(&self.cfg.wechat_webhook, &mut pending);
                            return;
                        }
                    }
                }
                _ = tokio::time::sleep(wait), if !pending.is_empty() => {
                    flush(&self.cfg.wechat_webhook, &mut pending);
                    last_send = Instant::now();
                }
            }
        }
    }
}

fn flush(hook: &str, pending: &mut Vec<Notification>) {
    if pending.is_empty() {
        return;
    }
    let body = combine_messages(pending);
    pending.clear();
    let hook = hook.to_string();
    tokio::spawn(async move { send_webhook(&hook, &body).await; });
}

fn prepare_log_file(path: &str) -> Result<String, String> {
    let abs = std::path::absolute(path).map_err(|e| e.to_string())?;
    if let Some(dir) = abs.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建日志目录 {} 失败: {e}", dir.display()))?;
    }
    let f = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .write(true)
        .open(&abs)
        .map_err(|e| format!("日志文件不可写 {}: {e}", abs.display()))?;
    drop(f);
    Ok(abs.to_string_lossy().into_owned())
}

fn append_log(path: &str, msg: &Notification) -> std::io::Result<()> {
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let mut b = String::new();
    if msg.memory_full {
        b.push_str(&format!("[{ts}] 存储空间已满警告\n"));
    } else {
        b.push_str(&format!("[{ts}] 发送者: {}\n内容: {}\n", msg.sender, msg.content));
    }
    b.push_str(&"-".repeat(50));
    b.push('\n');

    let mut f = std::fs::OpenOptions::new().append(true).create(true).write(true).open(Path::new(path))?;
    use std::io::Write;
    f.write_all(b.as_bytes())
}

async fn send_webhook(hook: &str, content: &str) {
    let payload = serde_json::json!({
        "msgtype": "text",
        "text": { "content": content }
    });

    for attempt in 1..=NOTIFY_MAX_RETRIES {
        let result = tokio::task::spawn_blocking({
            let hook = hook.to_string();
            let body = payload.to_string();
            move || post_webhook(&hook, &body)
        })
        .await;
        match result {
            Ok(Ok(())) => {
                log_info!("企业微信通知发送成功");
                return;
            }
            Ok(Err(e)) => {
                log_warn!("企业微信发送失败 ({}/{}): {}", attempt, NOTIFY_MAX_RETRIES, e);
            }
            Err(e) => {
                log_warn!("企业微信发送任务失败 ({}/{}): {}", attempt, NOTIFY_MAX_RETRIES, e);
            }
        }
        if attempt < NOTIFY_MAX_RETRIES {
            tokio::time::sleep(Duration::from_secs(attempt as u64)).await;
        }
    }
    log_error!("企业微信通知已达最大重试次数，放弃发送");
}

fn post_webhook(hook: &str, body: &str) -> Result<(), String> {
    let resp = ureq::post(hook)
        .timeout(Duration::from_secs(10))
        .set("Content-Type", "application/json")
        .send_string(body)
        .map_err(|e| e.to_string())?;

    if resp.status() != 200 {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body = resp.into_string().map_err(|e| e.to_string())?;
    let result: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let errcode = result.get("errcode").and_then(|v| v.as_i64()).unwrap_or(-1);
    if errcode != 0 {
        let errmsg = result.get("errmsg").and_then(|v| v.as_str()).unwrap_or("");
        return Err(format!("企业微信返回 errcode={errcode} errmsg={errmsg}"));
    }
    Ok(())
}

/// 复刻旧实现的排版，单条与多条走不同格式。
pub fn combine_messages(msgs: &[Notification]) -> String {
    if msgs.is_empty() {
        return String::new();
    }
    if msgs.len() == 1 {
        let m = &msgs[0];
        return match (m.memory_full, m.sender.as_str(), m.kind) {
            (true, _, _) => "⚠️ 警告：短信存储空间已满\n请及时处理，否则可能无法接收新短信".into(),
            (_, SENDER_CALL, _) => format!("📞 来电提醒\n{}", m.content),
            (_, SENDER_SIGNAL, _) => m.content.clone(),
            _ => format!("📱 新短信通知\n发送者: {}\n内容: {}", m.sender, m.content),
        };
    }

    let mut b = String::from("📑 批量通知汇总\n");
    b.push_str(&"=".repeat(20));
    b.push('\n');
    for (i, m) in msgs.iter().enumerate() {
        match (m.memory_full, m.sender.as_str()) {
            (true, _) => b.push_str(&format!("\n{}. ⚠️ 存储空间已满警告", i + 1)),
            (_, SENDER_CALL) => b.push_str(&format!("\n{}. 📞 {}", i + 1, m.content)),
            (_, SENDER_SIGNAL) => b.push_str(&format!("\n{}. 📶 {}", i + 1, m.content)),
            _ => b.push_str(&format!("\n{}. 📱 来自 {} 的短信:\n{}", i + 1, m.sender, m.content)),
        }
        b.push('\n');
        b.push_str(&"-".repeat(20));
    }
    b
}
