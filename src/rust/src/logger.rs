//! 极简分级日志器：写 stdout（由 procd/logd 接管），同时在内存里留一份环形缓冲。
//!
//! 为什么要留内存副本：
//!   稳态下（非 verbose）日志级别是 Warn，**info 级的拨号/接口过程日志不会进 syslog**，
//!   于是「日志」页什么都看不到 —— 而恰恰这些才是排障最需要的。
//!   这里把**所有**日志（含会被级别过滤掉的）先记入环形缓冲，再由 RPC 的 logs 方法提供，
//!   与 syslog 形成互补：
//!     - 内存缓冲：最新 N 条完整记录（含被级别挡掉的），进程重启即清零；
//!     - syslog：历史记录（可能已滚动丢失），但包含 init.d 的 logger 输出。
//!   LuCI 的日志页把两者合并展示，所以「拨号过程」与「接口拉起」都能看到。

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
    let dt = chrono::Local.timestamp_opt(secs as i64, 0).single().unwrap_or_else(|| chrono::Local::now());
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
const LOG_BUFFER_CAP: usize = 1200;

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

fn buffer_push(rec: LogRecord) {
    let mut guard = match LOGS.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if guard.is_none() {
        *guard = Some(VecDeque::with_capacity(LOG_BUFFER_CAP));
    }
    if let Some(q) = guard.as_mut() {
        q.push_back(rec);
        while q.len() > LOG_BUFFER_CAP {
            q.pop_front();
        }
    }
}

/// 取日志快照：返回 (当前最新 seq, seq > since 的记录，最多 limit 条)。
/// limit 超出时保留**最新**的部分（排障看最新的更有用）。
pub fn snapshot(since: u64, limit: usize) -> (u64, Vec<LogRecord>) {
    let guard = match LOGS.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let seq = LOG_SEQ.load(Ordering::Relaxed);
    let mut out: Vec<LogRecord> = match guard.as_ref() {
        Some(q) => q.iter().filter(|r| r.seq > since).cloned().collect(),
        None => Vec::new(),
    };
    if limit > 0 && out.len() > limit {
        let keep_from = out.len() - limit;
        out.drain(..keep_from);
    }
    (seq, out)
}

/* -------------------------------- 输出 -------------------------------- */

pub fn emit(lv: Level, tag: &str, args: std::fmt::Arguments) {
    let msg = format!("{}", args);

    // 先入缓冲：**不受当前级别限制**，否则拨号/接口这类 info 日志在稳态下会完全消失
    let seq = LOG_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    buffer_push(LogRecord {
        seq,
        ts: now_ms(),
        level: tag.to_string(),
        msg: msg.clone(),
    });

    if lv < level() {
        return;
    }
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
