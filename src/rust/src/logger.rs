//! 分级 + 分类日志器：按类别决定这条日志去内存环形缓存、插件文件还是 syslog。
//!
//! # 三个去处，不是一个
//!
//! 改动前只有一条路：入环形缓冲，再按级别 `eprintln!` 到 stderr（procd/logd 收进
//! syslog）。结果是 `logread` 里混满 AT 收发与短信正文，而业务痕迹又留不住。
//! 现在按 [`crate::logcat::Category`] 分流（策略表见该模块）：
//!
//! | 去处 | 谁进 | 上限 |
//! | --- | --- | --- |
//! | 内存环形缓冲 | **全部**日志，不受级别限制 | 1200 条 / 512 KiB（[`crate::ringlog`]） |
//! | 插件日志文件 | 仅业务类（`persists_to_file`） | 有界追加，默认 512 KiB |
//! | syslog(stderr) | 运行时类按全局级别；业务类**只有 ERR** | 由 logd 滚动 |
//!
//! 环形缓冲之所以不看级别：稳态下（非 verbose）全局级别是 Warn，
//! **info 级的拨号/接口过程日志进不了 syslog**，而那恰恰是排障最需要的。
//! 日志页把「环形缓冲 + 插件文件视角 + syslog 的 init.d 输出」合并展示，
//! 所以「拨号过程」与「接口拉起」都看得到。
//!
//! # 插件日志文件为什么要单独一个
//!
//! 业务日志不再进 syslog 之后，它们必须有个能跨进程重启留存的地方，
//! 否则「后端刚被 procd 拉起」这种最需要回看的场景反而什么都查不到。
//! 文件默认落在 `/tmp/at-webserver/plugin.log`（tmpfs，不磨闪存），
//! 由 [`crate::ringlog::append_capped`] 保证永不超上限。
//!
//! 注意 [`init_plugin_file`] 之前的日志**只进环形缓冲**：那时还不知道用户把路径
//! 配成了什么，先写默认路径再搬家会产生两个文件、也会绕过 `enabled=0`。
//! 启动阶段的日志量很小，且环形缓冲一份不丢，这个取舍是值得的。

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};

use crate::logcat::Category;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[repr(u8)]
pub enum Level {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

impl Level {
    /// 级别短标签，写进环形缓冲的 `level` 字段（前端据此配色与筛选）。
    pub fn tag(self) -> &'static str {
        match self {
            Level::Debug => "DBG",
            Level::Info => "INF",
            Level::Warn => "WRN",
            Level::Error => "ERR",
        }
    }
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

/// 把毫秒时间戳格式化成**路由本地时区的可读文本**（秒 + 三位毫秒）。
///
/// 只给 `logread` 与插件日志文件的**行首**用，它本身不带时区标记，因此
/// **不能当作机器口径**：浏览器按自己的时区解释这串数字会整体平移。
/// 插件日志文件另行写入绝对毫秒（见 [`plugin_file_push`]），那次才用于跨源去重与排序。
fn timestamp(ms: i64) -> String {
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
/// 一条很长的 URC/短信正文照样能把内存撑大。`LogRecord` 的序列化结构是
/// `seq`/`ts`/`level`/`cat`/`msg`，其中 `cat` 由本模块按类别写入。
pub type LogRecord = crate::ringlog::Entry;

static LOGS: OnceLock<crate::ringlog::RingLog> = OnceLock::new();

fn ring() -> &'static crate::ringlog::RingLog {
    LOGS.get_or_init(crate::ringlog::RingLog::with_defaults)
}

/// 追加一条记录（**不受当前日志级别限制**，被级别挡掉的也要留在缓冲里）。
fn buffer_push(ts: i64, lv: Level, cat: Category, msg: &str) -> u64 {
    ring().push(ts, lv.tag(), cat.key(), msg)
}

/// 取日志快照：返回 (当前最新 seq, seq > since 的记录，最多 limit 条)。
///
/// `cats` 是类别键过滤：`None` 表示不过滤；`Some(&[])` 表示「筛过了，但一个合法类别
/// 都没有」→ **空结果**。两者必须分开，否则拼错类别键的人会静默拿到全部日志、
/// 误以为自己筛对了。limit 超出时保留**最新**的部分（排障看最新的更有用）。
/// 过滤在 limit 之前生效，语义见 [`crate::ringlog::RingLog::snapshot_cats`]。
///
/// 给 `logs` RPC 用：从 SSH 里 `ubus call mt5700 logs '{"cats":"sms"}'`
/// 只看短信链路，不必把 1200 条全捞出来再自己 grep。
pub fn snapshot_cats(since: u64, limit: usize, cats: Option<&[String]>) -> (u64, Vec<LogRecord>) {
    ring().snapshot_cats(since, limit, cats)
}

/// 把 RPC 传来的 `cats` 参数解析成合法类别键。
///
/// 接受逗号或空格分隔；无法识别的键直接丢弃。返回值可能为空列表 —— 那表示
/// 「筛过了但一个合法键都没有」，调用方必须传 `Some(&[])` 而不是 `None` 给
/// [`snapshot_cats`]，这样拼错参数得到的是空结果，而不是静默返回全部日志
/// （后者会让拼错的人以为自己筛对了）。
pub fn parse_cat_filter(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in raw.split([',', ' ', '\t']) {
        let key = part.trim();
        if key.is_empty() {
            continue;
        }
        if let Some(c) = Category::from_key(key) {
            let k = c.key().to_string();
            if !out.contains(&k) {
                out.push(k);
            }
        }
    }
    out
}

/* ------------------------------ 插件日志文件 ------------------------------ */

/// 插件自己的日志文件上限（512 KiB）。
///
/// 比通知日志的 256 KiB 大一档：这里承载的是**全部**业务类日志（AT 收发、拨号、
/// 信号、短信…），条数远多于通知；但仍在 `/tmp`（tmpfs）上，不能让它是无界的。
pub const DEFAULT_PLUGIN_LOG_BYTES: u64 = 512 * 1024;

/// 插件日志文件的默认路径。放在独立子目录下，与通知日志分开，便于整体清理。
pub const DEFAULT_PLUGIN_LOG_PATH: &str = "/tmp/at-webserver/plugin.log";

#[derive(Clone, Debug)]
struct PluginFile {
    enabled: bool,
    path: String,
    max_bytes: u64,
}

/// 文件写入串行化：`append_capped` 的「裁剪 + 追加」是读-改-写，
/// 并发下两个任务可能同时判定要裁剪、把对方刚写的内容裁掉。
/// 临界区只有一次 tmpfs 写入，不含 await，用 std Mutex 足够。
static SINK: OnceLock<Mutex<Option<PluginFile>>> = OnceLock::new();

fn sink() -> &'static Mutex<Option<PluginFile>> {
    SINK.get_or_init(|| Mutex::new(None))
}

fn lock_sink() -> std::sync::MutexGuard<'static, Option<PluginFile>> {
    match sink().lock() {
        Ok(g) => g,
        // 中毒说明有线程在临界区里 panic 过；日志不能因此彻底失声，取内层值继续
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// 配置插件日志文件。由 `main` 在读到 UCI 配置后调用一次。
///
/// `path` 为空表示沿用默认路径；`max_bytes` 小于 4096 视为非法并回落默认
/// （与通知日志的 `log_file_max_bytes` 同一套下限，防用户手填个 `1` 把日志废掉）。
/// 目录创建失败只降级为「不写文件」，绝不影响日志的另外两个去处。
pub fn init_plugin_file(enabled: bool, path: &str, max_bytes: u64) {
    let target = if path.trim().is_empty() {
        DEFAULT_PLUGIN_LOG_PATH.to_string()
    } else {
        path.trim().to_string()
    };
    let cap = if max_bytes >= 4096 { max_bytes } else { DEFAULT_PLUGIN_LOG_BYTES };

    if !enabled {
        *lock_sink() = None;
        return;
    }
    if let Some(dir) = std::path::Path::new(&target).parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            // 这里不能再调 log_*（会重入本函数写的同一条链路），直接走 stderr 兜底
            eprintln!("at-webserver: 插件日志目录 {} 创建失败，业务日志仅留内存缓冲: {e}", dir.display());
            *lock_sink() = None;
            return;
        }
    }
    *lock_sink() = Some(PluginFile { enabled: true, path: target, max_bytes: cap });
}

/// 当前插件日志文件配置（给 RPC 状态展示与单测用）。
pub fn plugin_file_info() -> (bool, String, u64) {
    match &*lock_sink() {
        Some(f) => (f.enabled, f.path.clone(), f.max_bytes),
        None => (false, String::new(), 0),
    }
}

/// 追加一行到插件日志文件。未配置（`init_plugin_file` 之前或被关掉）时静默跳过。
///
/// 行格式：`2026-11-08 04:40:01.123 (1762555201123) [INF] [SMS] 正文`。
/// 行首是给人 `grep` / `less` 读的**路由本地时间文本**，括号里是**绝对毫秒** ——
/// 机器口径只能认后者：浏览器与路由可能不在同一时区，靠文本解释会让整批文件条目
/// 平移一个时区，与内存环形缓冲里同一条日志的去重键（`ts + 正文`）对不上，
/// 页面表现为「同一句话出现两遍、时间还差几小时」。
fn plugin_file_push(ts_text: &str, ts: i64, lv: Level, cat: Category, msg: &str) {
    if !cat.persists_to_file() {
        return;
    }
    // 换行会破坏「一行一条」的文件结构，也会让 trim_file 的行边界裁剪切错位置
    let flat: std::borrow::Cow<'_, str> = if msg.contains(['\n', '\r']) {
        std::borrow::Cow::Owned(msg.replace(['\n', '\r'], " "))
    } else {
        std::borrow::Cow::Borrowed(msg)
    };

    let guard = lock_sink();
    let Some(f) = guard.as_ref() else { return };
    let line = format!("{ts_text} ({ts}) [{}] [{}] {}\n", lv.tag(), cat.code(), flat);
    // 写失败不重试也不上报：日志落盘是尽力而为，为它再打一条日志只会放大故障
    let _ = crate::ringlog::append_capped(&f.path, &line, f.max_bytes);
}

/* -------------------------------- 输出 -------------------------------- */

/// 这条日志能否进 syslog（stderr → procd/logd）。
///
/// 两道闸门，缺一不可：
///   1. **类别地板**（[`Category::syslog_floor`]）：业务类只有 `ERR` 放行，
///      运行时类不设地板；
///   2. **全局级别**（[`level`]）：用户选的日志级别，稳态是 Warn。
///
/// 单独抽成函数是因为它是这次改造的核心行为，必须能被单测直接钉住 ——
/// 「业务日志不再刷 syslog」这句话要是只写在文档里，改坏了没人知道。
pub fn syslog_allowed(lv: Level, cat: Category) -> bool {
    lv >= cat.syslog_floor() && lv >= level()
}

/// 写一条日志。类别决定它去哪些通道，级别决定它能否越过 syslog 门槛。
pub fn emit(lv: Level, cat: Category, args: std::fmt::Arguments) {
    let msg = format!("{}", args);
    // 同一毫秒既进环形缓冲又写文件：两处的 ts 必须一模一样，
    // 前端才能按 `ts + 正文` 把「内存里的那条」和「文件里的同一条」认成一条。
    // 全仓库统一时间源（NTP 优先、设备时钟兜底），日志时间和通知时间同一条时间线。
    let ts = now_ms();
    let ts_text = timestamp(ts);

    // 1) 内存环形缓冲：**不受级别限制**，否则拨号/接口这类 info 日志在稳态下会完全消失
    buffer_push(ts, lv, cat, &msg);

    // 2) syslog：先过类别地板（业务类只有 ERR 放行），再过全局级别
    if syslog_allowed(lv, cat) {
        eprintln!("{ts_text} [{}] [{}] {}", lv.tag(), cat.code(), msg);
    }

    // 3) 插件文件：仅业务类
    plugin_file_push(&ts_text, ts, lv, cat, &msg);
}

/// 按 `module_path!()` 自动定类的日志入口，四个级别宏的默认路径。
///
/// 单独拆出来是为了让宏展开处只写一次 `module_path!()`：一个模块横跨多个业务域时，
/// 用 `log_info!(Cat::Sms, …)` 显式覆盖即可，不必改这个函数。
#[doc(hidden)]
pub fn emit_auto(lv: Level, module: &str, args: std::fmt::Arguments) {
    emit(lv, Category::from_module(module), args)
}

/// 日志宏：`log_info!("…")` 按 `module_path!()` 自动定类，
/// `log_info!(Cat::Sms, "…")` 显式指定类别。
///
/// 两条分支靠**首 token 是不是字面量 `Cat::`** 区分。不能写成 `$cat:expr,` ——
/// `log_info!("发送: {}", cmd)` 里的格式串同样是 `expr`，会被第一条分支抢先匹配，
/// 然后把格式串当类别用，报一个极难定位的类型错误。
///
/// 四个宏逐条展开而不是用「宏生成宏」：后者的宏体里要写 `$($arg:tt)*`，
/// 而 `$arg` 会被外层宏当成自己的重复变量，编译期直接报
/// 「attempted to repeat an expression containing no syntax variables」。
#[macro_export]
macro_rules! log_debug {
    (Cat::$c:ident, $($arg:tt)*) => {
        $crate::logger::emit(
            $crate::logger::Level::Debug,
            $crate::logcat::Category::$c,
            format_args!($($arg)*),
        )
    };
    ($($arg:tt)*) => {
        $crate::logger::emit_auto(
            $crate::logger::Level::Debug,
            module_path!(),
            format_args!($($arg)*),
        )
    };
}

#[macro_export]
macro_rules! log_info {
    (Cat::$c:ident, $($arg:tt)*) => {
        $crate::logger::emit(
            $crate::logger::Level::Info,
            $crate::logcat::Category::$c,
            format_args!($($arg)*),
        )
    };
    ($($arg:tt)*) => {
        $crate::logger::emit_auto(
            $crate::logger::Level::Info,
            module_path!(),
            format_args!($($arg)*),
        )
    };
}

#[macro_export]
macro_rules! log_warn {
    (Cat::$c:ident, $($arg:tt)*) => {
        $crate::logger::emit(
            $crate::logger::Level::Warn,
            $crate::logcat::Category::$c,
            format_args!($($arg)*),
        )
    };
    ($($arg:tt)*) => {
        $crate::logger::emit_auto(
            $crate::logger::Level::Warn,
            module_path!(),
            format_args!($($arg)*),
        )
    };
}

#[macro_export]
macro_rules! log_error {
    (Cat::$c:ident, $($arg:tt)*) => {
        $crate::logger::emit(
            $crate::logger::Level::Error,
            $crate::logcat::Category::$c,
            format_args!($($arg)*),
        )
    };
    ($($arg:tt)*) => {
        $crate::logger::emit_auto(
            $crate::logger::Level::Error,
            module_path!(),
            format_args!($($arg)*),
        )
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 插件文件落点是**进程级全局状态**，而 `cargo test` 默认多线程并发跑用例。
    /// 所有会改它的用例都必须先拿这把锁，否则 A 用例刚写完、B 用例就把落点换掉了，
    /// 表现为「本地偶发失败、CI 上又好了」这种最难查的抖动。
    static SINK_LOCK: Mutex<()> = Mutex::new(());

    fn guard_sink() -> std::sync::MutexGuard<'static, ()> {
        match SINK_LOCK.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// 全局日志级别同样是进程级状态，改它的用例也要排队，
    /// 否则 `syslog_allowed` 这类断言会被并发用例临时改掉的级别带偏。
    static LEVEL_LOCK: Mutex<()> = Mutex::new(());

    fn guard_level() -> std::sync::MutexGuard<'static, ()> {
        match LEVEL_LOCK.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// 在指定全局级别下跑 `f`，结束后还原。
    fn with_level<F: FnOnce()>(lv: Level, f: F) {
        let _g = guard_level();
        let saved = level();
        set_level(lv);
        f();
        set_level(saved);
    }

    /// 建一个独占的临时落点，跑完 `f` 再把全局落点关掉，避免污染其它用例。
    fn with_plugin_file<F: FnOnce(&std::path::Path)>(tag: &str, cap: u64, f: F) {
        let _g = guard_sink();
        let dir = std::env::temp_dir().join(format!("at-plugin-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("plugin.log");
        let _ = std::fs::remove_file(&path);
        init_plugin_file(true, &path.to_string_lossy(), cap);
        f(&path);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
        init_plugin_file(false, DEFAULT_PLUGIN_LOG_PATH, DEFAULT_PLUGIN_LOG_BYTES);
    }

    /// 在环形缓冲里按正文找记录。不能用 `last()`：缓冲是全进程共享的，
    /// 并发用例随时可能追加一条，`last()` 拿到的就不一定是自己刚写的那条。
    fn find_in_ring(msg: &str) -> Option<LogRecord> {
        let (_, all) = ring().snapshot(0, 0);
        all.into_iter().rev().find(|e| e.msg == msg)
    }

    #[test]
    fn parse_cat_filter_accepts_mixed_separators_and_drops_unknown() {
        assert_eq!(parse_cat_filter(""), Vec::<String>::new(), "空串 = 不过滤");
        assert_eq!(parse_cat_filter("sms"), vec!["sms".to_string()]);
        assert_eq!(
            parse_cat_filter("sms,at dial"),
            vec!["sms".to_string(), "at".to_string(), "dial".to_string()],
            "逗号与空格都要能当分隔符"
        );
        assert_eq!(
            parse_cat_filter("sms,sms"),
            vec!["sms".to_string()],
            "重复键要去重，否则过滤条件白白变长"
        );
        assert_eq!(
            parse_cat_filter("sms,拼错的键"),
            vec!["sms".to_string()],
            "非法键丢弃，合法的照常生效"
        );
        assert!(
            parse_cat_filter("全是非法键").is_empty(),
            "全非法时必须是空列表（→ 空结果），不能静默当成「不过滤」"
        );
        assert!(parse_cat_filter("SMS").is_empty(), "类别键大小写敏感");
    }

    #[test]
    fn level_tags_match_frontend_contract() {        // 前端 LEVEL_LABEL 只认这四个；改名会让日志页的级别徽章退化成英文原文
        assert_eq!(Level::Debug.tag(), "DBG");
        assert_eq!(Level::Info.tag(), "INF");
        assert_eq!(Level::Warn.tag(), "WRN");
        assert_eq!(Level::Error.tag(), "ERR");
    }

    #[test]
    fn emit_auto_classifies_by_module() {
        // module_path!() 推导：短信模块的日志必须落成 sms，而不是兜底的 misc
        emit_auto(Level::Info, "at_webserver::sms", format_args!("分类用例：发送短信"));
        let e = find_in_ring("分类用例：发送短信").expect("应能在缓冲里找到");
        assert_eq!(e.cat, "sms");
        assert_eq!(e.level, "INF");
    }

    #[test]
    fn unknown_module_falls_back_to_misc() {
        emit_auto(Level::Info, "at_webserver::brand_new_module", format_args!("分类用例：未登记模块"));
        let e = find_in_ring("分类用例：未登记模块").expect("应能在缓冲里找到");
        assert_eq!(e.cat, "misc", "未登记的模块必须落 misc（Runtime 组，仍进 syslog）");
    }

    #[test]
    fn explicit_category_overrides_module_default() {
        // main.rs 这类横跨多个业务域的模块靠显式指定细分
        emit(Level::Info, Category::Dial, format_args!("分类用例：显式指定拨号"));
        let e = find_in_ring("分类用例：显式指定拨号").expect("应能在缓冲里找到");
        assert_eq!(e.cat, "dial");
    }

    #[test]
    fn buffer_ignores_level_filter() {
        // 稳态级别是 Warn，但 debug 日志仍要留在缓冲里，否则日志页看不到过程
        with_level(Level::Warn, || {
            emit_auto(Level::Debug, "at_webserver::atclient", format_args!("分类用例：被级别挡掉的调试日志"));
            let e = find_in_ring("分类用例：被级别挡掉的调试日志").expect("被级别挡掉也要入缓冲");
            assert_eq!(e.level, "DBG");
            assert_eq!(e.cat, "at");
        });
    }

    /// 这次改造的核心行为：业务日志不刷 syslog，运行时日志照常按级别走。
    /// 只写在文档里的话，改坏了没人知道。
    #[test]
    fn syslog_takes_runtime_by_level_but_business_only_on_error() {
        // 稳态：Warn
        with_level(Level::Warn, || {
            assert!(syslog_allowed(Level::Warn, Category::Runtime));
            assert!(syslog_allowed(Level::Error, Category::Runtime));
            assert!(!syslog_allowed(Level::Info, Category::Runtime), "低于全局级别的运行时日志不进 syslog");

            assert!(syslog_allowed(Level::Error, Category::Sms), "业务硬故障必须留在 logread 里，否则是倒退");
            for lv in [Level::Debug, Level::Info, Level::Warn] {
                assert!(!syslog_allowed(lv, Category::Sms), "业务 {lv:?} 不该刷 syslog");
            }
        });

        // 排障态：Debug。全局放开也不会把业务痕迹放回 syslog —— 类别地板独立生效。
        with_level(Level::Debug, || {
            assert!(syslog_allowed(Level::Debug, Category::Runtime));
            assert!(syslog_allowed(Level::Info, Category::Config));
            assert!(!syslog_allowed(Level::Debug, Category::At), "全局 Debug 也不能放行业务 DBG");
            assert!(!syslog_allowed(Level::Warn, Category::Dial));
            assert!(syslog_allowed(Level::Error, Category::Dial));
        });
    }

    #[test]
    fn syslog_floor_is_error_for_every_business_category_and_debug_for_runtime() {
        for c in crate::logcat::ALL {
            let floor = c.syslog_floor();
            match c.group() {
                crate::logcat::Group::Business => {
                    assert_eq!(floor, Level::Error, "{:?} 属业务类，地板必须是 ERR", c);
                    assert!(c.persists_to_file(), "{:?} 不进 syslog 就必须能落盘，否则痕迹全丢", c);
                }
                crate::logcat::Group::Runtime => {
                    assert_eq!(floor, Level::Debug, "{:?} 属运行时类，不设类别地板", c);
                    assert!(!c.persists_to_file(), "{:?} 已进 syslog，不该再占 /tmp", c);
                }
            }
        }
    }

    #[test]
    fn plugin_file_is_off_until_init_and_after_disable() {
        let _g = guard_sink();
        init_plugin_file(false, DEFAULT_PLUGIN_LOG_PATH, DEFAULT_PLUGIN_LOG_BYTES);
        let (enabled, path, _) = plugin_file_info();
        assert!(!enabled, "关掉时不应有落点，实际 {path}");

        init_plugin_file(true, DEFAULT_PLUGIN_LOG_PATH, DEFAULT_PLUGIN_LOG_BYTES);
        let (enabled, path, cap) = plugin_file_info();
        assert!(enabled);
        assert_eq!(path, DEFAULT_PLUGIN_LOG_PATH);
        assert_eq!(cap, DEFAULT_PLUGIN_LOG_BYTES);

        init_plugin_file(false, DEFAULT_PLUGIN_LOG_PATH, DEFAULT_PLUGIN_LOG_BYTES);
        assert!(!plugin_file_info().0, "enabled=0 必须彻底关掉落盘");
    }

    #[test]
    fn init_plugin_file_rejects_tiny_cap_and_blank_path() {
        let _g = guard_sink();
        init_plugin_file(true, "   ", 1);
        let (enabled, path, cap) = plugin_file_info();
        assert!(enabled);
        assert_eq!(path, DEFAULT_PLUGIN_LOG_PATH, "空路径应回落默认");
        assert_eq!(cap, DEFAULT_PLUGIN_LOG_BYTES, "过小上限应回落默认，防用户填个 1 把日志废掉");
        init_plugin_file(false, DEFAULT_PLUGIN_LOG_PATH, DEFAULT_PLUGIN_LOG_BYTES);
    }

    #[test]
    fn business_logs_land_in_plugin_file_runtime_logs_do_not() {
        with_plugin_file("split", 64 * 1024, |path| {
            emit(Level::Info, Category::Sms, format_args!("分流用例：短信已发送"));
            emit(Level::Info, Category::Runtime, format_args!("分流用例：服务已启动"));

            let text = std::fs::read_to_string(path).expect("业务日志应已落盘");
            assert!(text.contains("分流用例：短信已发送"), "业务类必须写进插件文件");
            assert!(text.contains("[SMS]"), "行内应带类别短标签，实际：{text}");
            assert!(text.contains("[INF]"), "行内应带级别标签，实际：{text}");
            assert!(
                !text.contains("分流用例：服务已启动"),
                "运行时类已进 syslog，不该再占 /tmp"
            );
        });
    }

    /// 文件行必须带**绝对毫秒**，且与环形缓冲里同一条记录的 `ts` 完全一致 ——
    /// 前端按 `ts + 正文` 去重（见 logs.js::dedupKey），对不上就会把同一条日志显示两遍。
    /// 只写本地时间文本的话，浏览器与路由不在同一时区时整批文件条目还会平移一个时区。
    #[test]
    fn plugin_file_line_carries_epoch_matching_ring_ts() {
        with_plugin_file("epoch", 64 * 1024, |path| {
            emit(Level::Info, Category::Sms, format_args!("epoch 用例：短信已发送"));
            let text = std::fs::read_to_string(path).expect("业务日志应已落盘");
            let e = find_in_ring("epoch 用例：短信已发送").expect("应能在缓冲里找到");
            let want = format!("({})", e.ts);
            assert!(
                text.contains(&want),
                "文件行必须带与环形缓冲相同的绝对毫秒 {want}，实际：{text}"
            );
        });
    }

    #[test]
    fn every_business_category_persists_and_no_runtime_category_does() {
        with_plugin_file("allcats", 256 * 1024, |path| {
            for c in crate::logcat::ALL {
                emit(Level::Info, c, format_args!("全类别用例 {}", c.key()));
            }
            let text = std::fs::read_to_string(path).unwrap();
            for c in crate::logcat::ALL {
                let line = format!("全类别用例 {}", c.key());
                if c.persists_to_file() {
                    assert!(text.contains(&line), "{:?} 应落盘却没找到", c);
                } else {
                    assert!(!text.contains(&line), "{:?} 不该落盘却出现了", c);
                }
            }
        });
    }

    #[test]
    fn plugin_file_stays_within_cap() {
        with_plugin_file("cap", 64 * 1024, |path| {
            for i in 0..600 {
                emit(Level::Info, Category::At, format_args!("上限用例 第 {i} 条：{}", "长消息".repeat(20)));
            }
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            assert!(size <= 64 * 1024, "插件日志文件不得超过上限，实际 {size}");
            let text = std::fs::read_to_string(path).unwrap();
            assert!(text.contains("上限用例 第 599 条"), "最新一条必须还在");
            assert!(!text.contains("上限用例 第 0 条"), "最旧的应当已被裁掉");
            for line in text.lines() {
                assert!(line.starts_with('2') || line.is_empty(),
                    "不能有被裁断的半行（应以年份开头）：{line}");
            }
        });
    }

    #[test]
    fn multiline_message_is_flattened_before_file_write() {
        with_plugin_file("flat", 64 * 1024, |path| {
            emit(Level::Warn, Category::Urc, format_args!("压平用例 第一行\n第二行\r第三行"));
            let text = std::fs::read_to_string(path).unwrap();
            assert!(
                text.contains("压平用例 第一行 第二行 第三行"),
                "换行必须压平，否则「一行一条」的结构和行边界裁剪都会错：{text}"
            );
            assert_eq!(
                text.lines().filter(|l| l.contains("压平用例")).count(),
                1,
                "一条日志只能占一行"
            );
        });
    }
}
