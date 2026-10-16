//! 极简分级日志器：写 stderr（由 procd/logd 接管），同时在内存里留一份环形缓冲。
//!
//! 为什么要留内存副本：
//!   稳态下（非 verbose）日志级别是 Warn，**info 级的拨号/接口过程日志不会进 syslog**，
//!   于是「日志」页什么都看不到 —— 而恰恰这些才是排障最需要的。
//!   这里把**所有**日志（含会被级别过滤掉的）先记入环形缓冲，再由 RPC 的 logs 方法提供，
//!   与 syslog 形成互补：
//!     - 内存缓冲：最新 N 条完整记录（含被级别挡掉的），进程重启即清零；
//!     - syslog：历史记录（可能已滚动丢失），但包含 init.d 的 logger 输出
//!       （stderr 由 init.d 重定向产生，本模块不直接写 syslog）。
//!   LuCI 的日志页把两者合并展示，所以「拨号过程」与「接口拉起」都能看到。

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;

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
    // 全仓库统一时间源（NTP 优先、设备时钟兜底）：日志时间必须和通知时间、
    // 使用量按月清零判定在同一条时间线上，否则排障时对不上「这条日志到底是几号」。
    let ms = crate::nettime::now_ms();
    // 系统时区（未配置时北京时间，见 localtime）格式化到秒，毫秒单独拼接。
    let dt = crate::localtime::from_unix(ms / 1000);
    format!("{}.{:03}", dt.format("%Y-%m-%d %H:%M:%S"), ms % 1000)
}

fn now_ms() -> i64 {
    crate::nettime::now_ms()
}

/* ----------------------------- 内存环形缓冲 ----------------------------- */

/// 日志页的默认载体：**内存环形缓存**。
///
/// 条数与总字节双上限由 [`crate::ringlog::RingLog`] 把关 —— 只限条数不够，
/// 一条很长的 URC/短信正文照样能把内存撑大。这里保持 `LogRecord` 的
/// 序列化结构不变（`seq`/`ts`/`level`/`msg`），前端无需适配。
pub type LogRecord = crate::ringlog::Entry;

static LOGS: OnceLock<crate::ringlog::RingLog> = OnceLock::new();

fn ring() -> &'static crate::ringlog::RingLog {
    LOGS.get_or_init(crate::ringlog::RingLog::with_defaults)
}

/// 追加一条记录（**不受当前日志级别限制**，被级别挡掉的也要留在缓冲里）。
fn buffer_push(ts: i64, level: &str, msg: &str) -> u64 {
    ring().push(ts, level, msg)
}

/// 取日志快照：返回 (当前最新 seq, seq > since 的记录，最多 limit 条)。
/// limit 超出时保留**最新**的部分（排障看最新的更有用）。
pub fn snapshot(since: u64, limit: usize) -> (u64, Vec<LogRecord>) {
    ring().snapshot(since, limit)
}


/* -------------------------------- 输出 -------------------------------- */

pub fn emit(lv: Level, tag: &str, args: std::fmt::Arguments) {
    let msg = format!("{}", args);

    // 先入缓冲：**不受当前级别限制**，否则拨号/接口这类 info 日志在稳态下会完全消失
    buffer_push(now_ms(), tag, &msg);

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
