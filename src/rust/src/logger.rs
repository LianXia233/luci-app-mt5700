//! 极简分级日志器，写 stdout，由 procd/logd 接管。
//! 稳态只保留警告与错误，避免刷满日志（与 Go 实现一致）。

use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use chrono::TimeZone;

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

pub fn emit(lv: Level, tag: &str, args: std::fmt::Arguments) {
    if lv < level() {
        return;
    }
    eprintln!("{} [{}] {}", timestamp(), tag, args);
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
