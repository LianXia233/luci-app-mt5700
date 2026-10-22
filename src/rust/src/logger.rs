//! 极简分级日志器：写 stderr（由 procd/logd 接管），同时在内存里留一份环形缓冲。
//!
//! 为什么要留内存副本：
//!   本服务的 eprintln 输出**并没有**进 syslog（实测 `logread -e at-webserver` 里
//!   只有 init.d 用 `logger -t` 写的那几行），于是「拨号对齐」「串口探测」「URC 分发」
//!   这些真正排障要用的过程日志，在任何地方都看不到。
//!   这里把**所有**日志（含会被当前级别过滤掉的）先记入环形缓冲，再由 RPC 的 logs
//!   方法提供给 LuCI 的「运行日志 → 模组拨号」视图，与 syslog 形成互补：
//!     - 内存缓冲：最新 N 条完整记录（含被级别挡掉的），进程重启即清零；
//!     - syslog：历史记录（可能已滚动丢失），且包含 init.d 的 logger 输出。
//!
//! ★ 缓冲**不受当前日志级别限制**：级别只管「要不要打到 stderr」，
//!   否则级别调到 Warn 时缓冲里就只剩警告，等于白留。

use chrono::TimeZone;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum Level {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

static CURRENT_LEVEL: AtomicU8 = AtomicU8::new(1);

pub fn set_level(level: Level) {
    CURRENT_LEVEL.store(level as u8, Ordering::Relaxed);
}

/// 日志脱敏：把**敏感 AT 命令**的参数部分替换成 `***`，其余命令原样返回。
///
/// 为什么必须有（2026-09-30 全局同类排查后的统一出口）：
///   本服务的日志既进内存环形缓冲（1200 条，可经 `logs` RPC 取回）也打到 stderr/syslog，
///   而 AT 命令里带着这些**排障并不需要、泄露后果却明确**的内容：
///     · `AT+CPIN=` / `AT+CPWD=` / `AT+CLCK=`：PIN / PUK；
///     · `AT+CSIM=` / `AT+CGLA=`：完整 APDU（可读出 ICCID / EID）；
///     · `AT^PHYNUM=IMEI,…`：IMEI 写入；
///     · `AT^SETAUTODIAL=` / `AT+CGDCONT=`：APN 的用户名与口令；
///     · `AT+CSCA=`：短信中心号。
///   命令名本身足以定位"是哪条命令出的问题"，参数一律不记。
///
/// 口径（刻意保守，避免把排障信息一起遮掉）：
///   · 大小写不敏感（`at+cpin=` 同样被遮）；
///   · **只遮名单里的命令** —— `AT+CMGS=20` 这类"长度也是参数"的命令原样保留；
///   · `?` 结尾的纯查询没有参数；无 `=` 的命令（`AT`/`ATI`/`AT+CSQ`）也原样返回；
///   · 首尾空白裁掉，空串安全返回空串。
pub fn redact_at_for_log(cmd: &str) -> String {
    const SENSITIVE: [&str; 9] = [
        "AT+CPIN",
        "AT+CPWD",
        "AT+CLCK",
        "AT+CSIM",
        "AT+CGLA",
        "AT+CSCA",
        "AT^PHYNUM",
        "AT^SETAUTODIAL",
        "AT+CGDCONT",
    ];
    let s = cmd.trim();
    let eq = match s.find('=') {
        Some(i) => i,
        None => return s.to_string(),
    };
    let name = s[..eq].trim_end();
    let upper = name.to_ascii_uppercase();
    if SENSITIVE.iter().any(|c| upper == *c) {
        format!("{name}=***")
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::redact_at_for_log;

    /// 敏感命令的参数（PIN/PUK/APDU/IMEI/APN 口令/短信中心号）必须被遮掉
    #[test]
    fn 敏感参数被遮掉() {
        assert_eq!(redact_at_for_log("AT+CPIN=\"1234\""), "AT+CPIN=***");
        assert_eq!(redact_at_for_log("AT+CPWD=\"SC\",\"1234\",\"5678\""), "AT+CPWD=***");
        assert_eq!(redact_at_for_log("AT+CLCK=\"SC\",1,\"1234\""), "AT+CLCK=***");
        assert_eq!(redact_at_for_log("AT+CGLA=0,18,\"00A40804047FFF6F07\""), "AT+CGLA=***");
        assert_eq!(redact_at_for_log("AT+CSIM=10,\"00A4040002\""), "AT+CSIM=***");
        assert_eq!(redact_at_for_log("AT^PHYNUM=IMEI,864640060359112"), "AT^PHYNUM=***");
        assert_eq!(
            redact_at_for_log("AT^SETAUTODIAL=1,0,\"IP\",\"apn\",\"user\",\"pass\",1"),
            "AT^SETAUTODIAL=***"
        );
        assert_eq!(
            redact_at_for_log("AT+CGDCONT=1,\"IP\",\"apn\",\"u\",\"p\""),
            "AT+CGDCONT=***"
        );
        assert_eq!(redact_at_for_log("AT+CSCA=\"+8613800100500\""), "AT+CSCA=***");
        // 大小写不敏感
        assert_eq!(redact_at_for_log("at+cpwd=\"SC\",\"1\",\"2\""), "at+cpwd=***");
        // 首尾空白不影响判定
        assert_eq!(redact_at_for_log("  AT+CPIN=\"1\"  "), "AT+CPIN=***");
    }

    /// 非敏感命令必须原样保留（否则排障关键信息被误伤）
    #[test]
    fn 非敏感命令原样保留() {
        assert_eq!(redact_at_for_log("AT+CMGS=20"), "AT+CMGS=20");
        assert_eq!(redact_at_for_log("AT^HCSQ?"), "AT^HCSQ?");
        assert_eq!(redact_at_for_log("AT+CSQ"), "AT+CSQ");
        assert_eq!(redact_at_for_log("AT+CPIN?"), "AT+CPIN?");
        assert_eq!(redact_at_for_log("AT^SETAUTODIAL?"), "AT^SETAUTODIAL?");
        assert_eq!(redact_at_for_log("AT"), "AT");
        assert_eq!(redact_at_for_log(""), "");
    }
}

pub fn level() -> Level {
    match CURRENT_LEVEL.load(Ordering::Relaxed) {
        0 => Level::Debug,
        1 => Level::Info,
        2 => Level::Warn,
        _ => Level::Error,
    }
}

fn timestamp() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    // 用 chrono 格式化本地时间
    let dt = chrono::Local.timestamp_opt(secs as i64, 0).single().unwrap_or_else(chrono::Local::now);
    format!("{}.{:03}", dt.format("%Y-%m-%d %H:%M:%S"), millis)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/* ----------------------------- 内存环形缓冲 ----------------------------- */

/// 缓冲容量（条）。够覆盖一次完整启动 + 拨号 + 若干次重连与对账。
pub const LOG_BUFFER_CAP: usize = 1200;

#[derive(Clone, serde::Serialize)]
pub struct LogRecord {
    /// 单调递增序号，前端据此做增量拉取（与 events 的 seq 语义一致）
    pub seq: u64,
    /// 毫秒时间戳（前端本地格式化，避免时区/时钟不同源）
    pub ts: i64,
    /// DBG / INF / WRN / ERR
    pub level: String,
    pub msg: String,
}

static LOG_SEQ: AtomicU64 = AtomicU64::new(0);
static LOGS: Mutex<Option<VecDeque<LogRecord>>> = Mutex::new(None);

/// 入队一条记录，**取号在锁内完成**。
///
/// ★ 取号必须在持有队列锁之后 —— 这与 `rpcserver.rs` 的 `EventBus::push` 是同一条
///   约定，那边的注释记着同一个事故：「先 fetch_add 再加锁，于是存在这样的窗口：
///   号已分配、事件尚未入队，而此时 since() 读到这个新 seq 却看不到对应事件，
///   前端据此把游标推进到该 seq —— 那条事件就永久拉不到了」。
///   本函数原先正是那个未修的形态（emit 里先取号再调它取锁），已对齐。
fn buffer_push(level: &str, msg: String) {
    let mut guard = match LOGS.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let q = guard.get_or_insert_with(|| VecDeque::with_capacity(LOG_BUFFER_CAP));
    let seq = LOG_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    q.push_back(LogRecord { seq, ts: now_ms(), level: level.to_string(), msg });
    while q.len() > LOG_BUFFER_CAP {
        q.pop_front();
    }
}

/// 取日志快照：返回 (本次实际回到的 seq, seq > since 的记录，最多 limit 条)。
/// limit 超出时保留**最新**的部分（排障看最新的更有用）。
///
/// ★ 返回的 seq 是「**本次真正回到的位置**」，不是当前最新 seq —— 与
///   `rpcserver.rs` 的 `EventBus::since` 同一条约定（那里注释写着理由：
///   「若报了最新 seq，前端会把游标推过去，被裁掉的那些就永久拉不到了」）。
///   本函数上面刚把最旧的若干条 drain 掉，若这里报最新 seq，被 drain 的日志
///   就此永久不可见。没有任何记录时回退到 `since`，表示「游标没动」。
pub fn snapshot(since: u64, limit: usize) -> (u64, Vec<LogRecord>) {
    let guard = match LOGS.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut out: Vec<LogRecord> = match guard.as_ref() {
        Some(q) => q.iter().filter(|r| r.seq > since).cloned().collect(),
        None => Vec::new(),
    };
    if limit > 0 && out.len() > limit {
        let keep_from = out.len() - limit;
        out.drain(..keep_from);
    }
    let last = out.last().map(|r| r.seq).unwrap_or(since);
    (last, out)
}

/* -------------------------------- 输出 -------------------------------- */

pub fn emit(lv: Level, tag: &str, args: std::fmt::Arguments) {
    let msg = format!("{}", args);

    // 先入缓冲：**不受当前级别限制**，否则拨号/接口这类 info 日志在稳态下会完全消失。
    // （取号在 buffer_push 的锁内完成，见那里的说明。）
    if lv < level() {
        // 不打 stderr 时直接 move 进缓冲，省掉一次必然被丢弃的 String 克隆 ——
        // 日志是本服务频率最高的一类分配（每条 URC / 每条命令都会走到这里）。
        buffer_push(tag, msg);
        return;
    }
    buffer_push(tag, msg.clone());
    eprintln!("{} [{}] {}", timestamp(), tag, msg);
}

#[macro_export]
macro_rules! log_debug {
    ($($arg:tt)*) => { $crate::logger::emit($crate::logger::Level::Debug, "DBG", format_args!($($arg)*)) };
}
#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => { $crate::logger::emit($crate::logger::Level::Info, "INF", format_args!($($arg)*)) };
}
#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => { $crate::logger::emit($crate::logger::Level::Warn, "WRN", format_args!($($arg)*)) };
}
#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => { $crate::logger::emit($crate::logger::Level::Error, "ERR", format_args!($($arg)*)) };
}
