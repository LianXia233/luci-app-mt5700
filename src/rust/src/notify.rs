//! 通知：企业微信 webhook（60 秒合并、重试 3 次）+ 本地日志文件。
//! 与 Go 实现（notify.go）行为一致。

use crate::{log_error, log_info, log_warn};
use crate::config::NotificationConfig;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

const NOTIFY_INTERVAL: Duration = Duration::from_secs(60);
const NOTIFY_QUEUE_SIZE: usize = 256;
const NOTIFY_MAX_PENDING: usize = 1000;
const NOTIFY_MAX_RETRIES: u32 = 3;

/// 通知日志文件上限。超过后保留尾部一半。
///
/// 默认配置 `log_file '/tmp/at-notifications.log'`（见 root/etc/config/at-webserver）
/// 落在 tmpfs 上，而 tmpfs 吃的是内存。锁频下发失败时每个检测周期都会追加一条，
/// 长年运行下无轮转会把 /tmp 写满，进而影响路由器上依赖 /tmp 的其它服务。
const NOTIFY_LOG_MAX_BYTES: u64 = 256 * 1024;

/// 写日志失败时的报错节流间隔。
/// /tmp 满时每条通知都会失败，不节流就会每条再刷一条错误日志，雪上加霜。
const LOG_ERROR_THROTTLE_SECS: u64 = 60;

/// 上次上报「写日志失败」的时刻（0 = 从未上报），单位是**单调**秒。
static LAST_LOG_ERROR_AT: AtomicU64 = AtomicU64::new(0);
/// 单调时钟起点。
///
/// 用 Instant 而不是 SystemTime 的 epoch 秒：路由器没有 RTC，靠 NTP 对时，
/// 墙钟可能大幅向后跳。若用 epoch 秒做节流基准，回拨后 `now - last` 恒为 0，
/// 「/tmp 写满」这类最需要报警的错误会被永久静默，直到墙钟重新追上才恢复。
static MONO_EPOCH: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

/// 进程启动以来的单调秒数。
fn mono_secs() -> u64 {
    MONO_EPOCH.get_or_init(Instant::now).elapsed().as_secs()
}

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

/// 距下一次 flush 还要等多久。
///
/// `last` 为 `None` 表示"本轮窗口尚未开始"（进程刚起来），此时返回 0 —— 语义上
/// 等价于原来的 `Instant::now() - NOTIFY_INTERVAL`（即"窗口已满、可以立即发"）。
///
/// ★ 2026-09-28 修：原来那一行是
///     `let mut last_send = Instant::now() - NOTIFY_INTERVAL;`
///   `Instant` 的 `Sub<Duration>` 在**下溢时 panic**（内部是
///   `checked_sub(other).expect("overflow when subtracting duration from instant")`），
///   而 Linux 上 `Instant` 基于 `CLOCK_MONOTONIC`、从**系统启动**起算 ——
///   于是「服务在开机不足 60 秒内启动」就会让这一行 panic。本 crate 的 release 是
///   `panic = "abort"`，一次 panic 即 abort，后果是 procd 反复 respawn、攒满重试后
///   **永久放弃拉起本服务**（正是 main.rs 里 join_log 上方那条约定要避免的事）。
///   boot 阶段 procd 拉起服务时 uptime 通常只有 10~30 秒，这个窗口并不窄。
///
///   它一直没被发现，是因为上面 145-148 行在**没配企业微信 webhook** 时直接 return，
///   根本走不到这里 —— 踩到的是配了 webhook 的用户。
fn next_wait(last: Option<Instant>) -> Duration {
    match last {
        Some(t) => NOTIFY_INTERVAL.saturating_sub(t.elapsed()),
        None => Duration::ZERO,
    }
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
            // 同步 std::fs 会卡住整条 tokio worker 线程，而 notify() 是在 URC 分发
            // 与定时锁频路径上被 await 的。丢进 blocking 线程池，只阻塞当前任务。
            let path = path.clone();
            let msg = msg.clone();
            let outcome = tokio::task::spawn_blocking(move || append_log(&path, &msg)).await;
            match outcome {
                Ok(Ok(())) => {}
                Ok(Err(e)) => report_log_error(&e.to_string()),
                Err(e) => report_log_error(&e.to_string()),
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
        // None = 本进程还没发过第一批（等价于"窗口早已期满"），见 next_wait 的说明。
        let mut last_send: Option<Instant> = None;

        loop {
            let wait = next_wait(last_send);
            tokio::select! {
                _ = ctx.changed() => {
                    // 退出路径（A-B9，2026-10-22 审计）：原先 flush 只 spawn 就 return，
                    // runtime 一关最后一批通知就丢了 —— 改为带超时的在位等待。
                    flush_and_wait(&self.cfg.wechat_webhook, &mut pending).await;
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
                            flush_and_wait(&self.cfg.wechat_webhook, &mut pending).await;
                            return;
                        }
                    }
                }
                _ = tokio::time::sleep(wait), if !pending.is_empty() => {
                    flush(&self.cfg.wechat_webhook, &mut pending);
                    last_send = Some(Instant::now());
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

/// 退出路径专用：flush 后**在当前任务里等发送完成**（带 10s 上限，不无限拖关停）。
async fn flush_and_wait(hook: &str, pending: &mut Vec<Notification>) {
    if pending.is_empty() {
        return;
    }
    let body = combine_messages(pending);
    pending.clear();
    let hook = hook.to_string();
    let send = tokio::spawn(async move { send_webhook(&hook, &body).await; });
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), send).await;
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
    // 日志含短信/来电内容（D-B11，2026-10-22 审计）：收掉组/其他位。
    // Windows 无此权限模型，随平台编译只在 Unix 生效。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&abs, std::fs::Permissions::from_mode(0o600));
    }
    Ok(abs.to_string_lossy().into_owned())
}

/// 上报写日志失败，按 [`LOG_ERROR_THROTTLE_SECS`] 节流。
fn report_log_error(detail: &str) {
    let now = mono_secs();
    let last = LAST_LOG_ERROR_AT.load(Ordering::Relaxed);
    if now.saturating_sub(last) < LOG_ERROR_THROTTLE_SECS {
        return;
    }
    LAST_LOG_ERROR_AT.store(now, Ordering::Relaxed);
    log_error!(
        "写入通知日志失败: {}（{} 秒内不再重复上报）",
        detail,
        LOG_ERROR_THROTTLE_SECS
    );
}

fn append_log(path: &str, msg: &Notification) -> std::io::Result<()> {
    let path = Path::new(path);
    rotate_if_oversized(path, NOTIFY_LOG_MAX_BYTES)?;

    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let mut b = String::new();
    if msg.memory_full {
        b.push_str(&format!("[{ts}] 存储空间已满警告\n"));
    } else {
        b.push_str(&format!("[{ts}] 发送者: {}\n内容: {}\n", msg.sender, msg.content));
    }
    b.push_str(&"-".repeat(50));
    b.push('\n');

    let mut f = std::fs::OpenOptions::new().append(true).create(true).write(true).open(path)?;
    f.write_all(b.as_bytes())
}

/// 日志文件超过 `max` 字节时保留尾部一半，从第一个完整行开始，避免留下半条记录。
///
/// 直接写回原路径而不是新建文件：通知日志是调试用的历史记录，不值得为它
/// 额外占用一份 tmpfs 空间（`.old` 副本会让峰值占用变成两倍）。
fn rotate_if_oversized(path: &Path, max: u64) -> std::io::Result<()> {
    let size = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        // 文件还不存在：下面的 append 会创建它
        Err(_) => return Ok(()),
    };
    if size <= max {
        return Ok(());
    }
    let keep = (max / 2) as usize;
    if keep == 0 {
        return Ok(());
    }

    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::End(-(keep as i64)))?;
    let mut tail: Vec<u8> = Vec::with_capacity(keep);
    // 必须借 &mut f：Read::take 按值取走 self，直接 f.take() 会把文件句柄 move 掉。
    (&mut f).take(keep as u64).read_to_end(&mut tail)?;
    drop(f);

    // 尾部开头多半是半条记录，丢掉第一个换行之前的内容。
    let skip = tail.iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
    let truncated = &tail[skip..];

    let tmp = path.with_extension("rotating");
    std::fs::write(&tmp, truncated)?;
    std::fs::rename(&tmp, path)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归：进程刚启动时**不得**依赖 `Instant::now() - NOTIFY_INTERVAL` 这类运算 ——
    /// 它在系统运行不足一个窗口时会下溢 panic，而 release 是 `panic = "abort"`。
    /// （boot 阶段 procd 拉起本服务时 uptime 通常只有 10~30 秒。）
    #[test]
    fn next_wait_首轮不依赖减去一个窗口() {
        assert_eq!(next_wait(None), Duration::ZERO, "首轮应视为窗口已满、可立即发");
        let w = next_wait(Some(Instant::now()));
        assert!(
            w <= NOTIFY_INTERVAL && w >= NOTIFY_INTERVAL - Duration::from_millis(500),
            "刚发过之后应等待接近一个完整窗口，实际 {w:?}"
        );
    }

    /// 合并排版的两种形态（单条 / 多条）不能丢内容。
    #[test]
    fn combine_messages_keeps_every_entry() {
        let one = Notification {
            sender: "10086".into(),
            content: "流量提醒".into(),
            kind: NotifyKind::Sms,
            memory_full: false,
        };
        let s = combine_messages(std::slice::from_ref(&one));
        assert!(s.contains("10086") && s.contains("流量提醒"), "{s}");

        let many = vec![
            one.clone(),
            // 注意：多条汇总里 SENDER_CALL / SENDER_SIGNAL 是被当作**发送者**匹配的，
            // 输出的是它们的 content 配图标 —— 所以下面断言 content，而不是发送者名。
            Notification { sender: SENDER_CALL.into(), content: "13800138000".into(), ..one.clone() },
            Notification { sender: SENDER_SIGNAL.into(), content: "信号 -95".into(), ..one.clone() },
            Notification { memory_full: true, ..one.clone() },
        ];
        let s = combine_messages(&many);
        for expect in ["10086", "流量提醒", "13800138000", "信号 -95", "存储空间已满"] {
            assert!(s.contains(expect), "批量汇总里少了 {expect}：{s}");
        }
    }
}
