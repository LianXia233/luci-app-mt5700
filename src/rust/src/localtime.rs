//! 统一时间源：**以 OpenWrt 系统设置的时区为准，解析不出来时回落北京时间（UTC+8）**。
//!
//! # 为什么不能用 `chrono::Local`
//!
//! `chrono::Local` 在 Unix 上走 `libc::localtime_r()`，而 `localtime_r` 只认两样东西：
//!   1. 进程环境变量 `TZ`；
//!   2. `/etc/localtime`（或 `/usr/share/zoneinfo`）。
//!
//! OpenWrt 的时区设置（LuCI「系统 → 时间同步 → 时区」）落在 **UCI `system.@system[0].timezone`**
//! （POSIX TZ 串，如 `CST-8`），再由 init 脚本派生出 **`/etc/TZ`**；而 `TZ` 环境变量
//! **只由 `/etc/profile` 为登录 shell 导出**（`[ -n "$TZ" ] || export TZ="$(cat /etc/TZ)"`），
//! procd 启动的守护进程拿不到。于是：
//!
//! * 本模块的目标固件（ImmortalWrt SNAPSHOT, mediatek/filogic）**不带 tzdata**
//!   —— 实测实机 `/usr/share/zoneinfo` 目录根本不存在，也没有 `/etc/localtime`；
//! * 守护进程环境里没有 `TZ`；
//!
//! 两条路都断，musl 的 `localtime_r` 就静默退化成 **UTC**。实测证据：
//!
//! ```text
//! SSH shell : Sun Oct 11 23:53:36 CST 2026   ← /etc/profile 导出了 TZ，正确
//! 应用日志  : 2026-10-11 15:41:02.963 [INF]  ← syslog 前缀 23:41:02，差 8 小时
//! ```
//!
//! 也就是说「日志时间比现实早 8 小时」不是时区配错，而是**守护进程根本没读到时区**。
//!
//! # 本模块怎么解决
//!
//! 1. 依次尝试 `TZ` 环境变量 → `/etc/TZ` → `uci get system.@system[0].timezone`，
//!    拿到 POSIX TZ 串（OpenWrt 的标准位置）；
//! 2. 把拿到的串写回进程环境（仅 Unix，且只在首次解析时写，此时尚未 spawn 线程），
//!    这样 **libc 与任何仍在用 `chrono::Local` 的代码口径一致**；
//! 3. 用 `libc::localtime_r()` + `tm_gmtoff` 取**当前时刻**的偏移 —— 这是唯一能
//!    **连夏令时规则一起算对**的做法（musl/glibc 都能在无 tzdata 的情况下
//!    直接解释 POSIX TZ 串，含 `,M3.2.0/2,M11.1.0/2` 这类 DST 规则）；
//! 4. 取不到（非 Unix 宿主、或 libc 也解析失败）时，用内置的 POSIX TZ 解析器
//!    取**标准时**偏移；再不行才用兜底常量 [`BEIJING_OFFSET_SECS`]。
//!
//! 因此：用户把时区设成 `Asia/Shanghai`（`CST-8`）就是北京时间；设成 `MST7MDT`
//! 之类也照样跟系统走；系统什么都没配时，默认给北京时间 —— 这正是需求
//! 「所有时间默认北京时间，以系统时区设置为准」。
//!
//! # 全仓库约定
//!
//! 1. 除本模块外**任何地方都不许再出现 `chrono::Local`**，一律使用 [`offset`] /
//!    [`from_unix`] / [`Tz`]；
//! 2. **本模块只管时区，不管「现在几点」** —— 绝对时刻一律走
//!    [`crate::nettime`]（`now` / `now_ts` / `now_ms` / `now_string`）：
//!    它优先用 NTP 校正设备时钟，取不到才回退到本模块的设备时钟。
//!    [`now`] 保留在这里正是作为那条回退链的底座，业务代码不要直接调它；
//! 3. 耗时 / 间隔测量用 `Instant`，不要用墙上时钟（NTP 校正会造成跳变）。
//!
//! 上述约定由 `nettime` 里的源码级回归用例盯着：除 `localtime.rs` / `nettime.rs`
//! 之外出现 `chrono::Utc::now()` / `SystemTime::now()`，测试直接失败。

use crate::{log_info, log_warn};
use chrono::{DateTime, FixedOffset, LocalResult, TimeZone};
use std::sync::OnceLock;

/// 全仓库统一的时间类型。等价于 `chrono::DateTime<chrono::FixedOffset>`。
pub type Tz = FixedOffset;

/// 兜底偏移：北京时间（UTC+8）。**只在系统时区完全取不到时使用**。
pub const BEIJING_OFFSET_SECS: i32 = 8 * 3600;


/// 解析结果（进程内只算一次）。
struct Resolved {
    offset: FixedOffset,
    /// 生效偏移的秒数（东为正）
    secs: i32,
    /// 拿到的 POSIX TZ 串，如 `CST-8`
    tz: Option<String>,
    /// 来源说明（用于启动日志，明确告诉排障的人「时间从哪来的」）
    source: &'static str,
    /// TZ 串里带夏令时规则、但当前只能取到标准时偏移（非 Unix 宿主）
    dst_ignored: bool,
}

static RESOLVED: OnceLock<Resolved> = OnceLock::new();

/// 启动时调用一次：解析系统时区并把结果打进日志。
///
/// 必须在 spawn 任何线程**之前**调用（[`resolve`] 会写 `TZ` 环境变量）。
pub fn init() {
    let r = resolved();
    log_info!("时区: {}", describe());
    if r.dst_ignored {
        log_warn!("TZ `{}` 含夏令时规则，当前宿主无法解析，仅按标准时偏移计算", r.tz.as_deref().unwrap_or(""));
    }
}

/// 当前生效的 UTC 偏移。
pub fn offset() -> FixedOffset {
    resolved().offset
}

/// 当前时刻（设备时钟 + 系统时区，缺省北京时间）。
///
/// 这是**设备时钟**口径，不含 NTP 校正。业务代码要「现在几点」请用
/// [`crate::nettime::now`]（NTP 优先、失败自动回退到这里）。
pub fn now() -> DateTime<Tz> {
    chrono::Utc::now().with_timezone(&offset())
}

/// 由 Unix 秒构造时刻（系统时区）。
pub fn from_unix(secs: i64) -> DateTime<Tz> {
    offset().timestamp_opt(secs, 0).single().unwrap_or_else(now)
}

/// 由年月日时分秒构造时刻（系统时区）。字段越界（如 2 月 30 日）返回 `None`。
///
/// 短信 PDU 里的时间戳是「对方交换机时区的本地时间」，本身不带时区信息，
/// 按 POSIX 惯例用本地时区解释，这里即系统时区。
pub fn from_ymdhms(
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
) -> Option<DateTime<Tz>> {
    match offset().with_ymd_and_hms(year, month, day, hour, minute, second) {
        LocalResult::Single(dt) => Some(dt),
        _ => None,
    }
}

/// 供设置页/日志展示的完整说明，例如 `CST-8 → UTC+08:00`。
pub fn describe() -> String {
    describe_of(resolved())
}


/* ------------------------------- 解析实现 ------------------------------- */

fn resolved() -> &'static Resolved {
    RESOLVED.get_or_init(resolve)
}

fn describe_of(r: &Resolved) -> String {
    match &r.tz {
        Some(tz) => format!("{} → UTC{}{}", tz, if r.secs < 0 { "-" } else { "+" }, hhmm(r.secs)),
        None => format!("未配置时区，使用默认北京时间 UTC+08:00（{}）", r.source),
    }
}

/// `secs` → `HH:MM`（取绝对值）。
fn hhmm(secs: i32) -> String {
    let a = secs.unsigned_abs();
    format!("{:02}:{:02}", a / 3600, (a % 3600) / 60)
}

fn resolve() -> Resolved {
    let (tz, source) = system_tz_string();

    // 回写环境变量：libc / chrono::Local / 子进程（uci）都只看 TZ。
    // 仅在此处写一次，且 main 在 spawn 线程前调用 init()，不构成数据竞争。
    #[cfg(unix)]
    if let Some(t) = tz.as_deref() {
        std::env::set_var("TZ", t);
    }

    // 首选 libc：它连夏令时一起算对。
    let libc_secs = libc_offset_secs();

    // 内置解析器：给非 Unix 宿主兜底，也用于判断「有没有 DST 规则」。
    let parsed = tz.as_deref().and_then(parse_posix_tz);

    let (secs, dst_ignored) = pick_offset(libc_secs, parsed);

    // FixedOffset 允许 ±24h；这里再夹一次，避免脏配置把整条时间线带偏。
    let secs = secs.clamp(-24 * 3600, 24 * 3600);
    let offset = FixedOffset::east_opt(secs).unwrap_or_else(|| {
        FixedOffset::east_opt(BEIJING_OFFSET_SECS).expect("UTC+8 必然合法")
    });

    Resolved { offset, secs, tz, source, dst_ignored }
}

/// 偏移决策（纯函数，便于单测覆盖三级回退的每一种组合）。
///
/// 优先级：libc 结果（含 DST）> 内置解析器的标准时 > 北京时间兜底。
/// 返回 `(偏移秒数, 是否因宿主不支持 DST 而只取了标准时)`。
fn pick_offset(libc_secs: Option<i32>, parsed: Option<PosixTz>) -> (i32, bool) {
    match (libc_secs, parsed) {
        (Some(s), _) => (s, false),
        (None, Some(p)) => (p.std_secs, p.dst_secs.is_some()),
        (None, None) => (BEIJING_OFFSET_SECS, false),
    }
}

/// 按优先级取得系统时区串。
///
/// 顺序即「谁更权威」：
///   1. `TZ` 环境变量 —— 运维显式覆盖，优先级最高；
///   2. `/etc/TZ` —— OpenWrt 由 UCI 派生出的标准落点，也是 libc 直接读的位置；
///   3. `uci get system.@system[0].timezone` —— `/etc/TZ` 被误删时的最后一道；
///   4. 都没有 → 交给调用方用北京时间兜底。
fn system_tz_string() -> (Option<String>, &'static str) {
    if let Ok(v) = std::env::var("TZ") {
        let v = v.trim().to_string();
        if !v.is_empty() {
            return (Some(v), "环境变量 TZ");
        }
    }
    if let Some(v) = read_etc_tz() {
        return (Some(v), "/etc/TZ");
    }
    if let Some(v) = read_uci_timezone() {
        return (Some(v), "uci system.@system[0].timezone");
    }
    (None, "无任何时区配置")
}

/// 读 OpenWrt 的 `/etc/TZ`。内容形如 `CST-8`，末尾可能有换行。
fn read_etc_tz() -> Option<String> {
    let raw = std::fs::read_to_string("/etc/TZ").ok()?;
    // 只取第一行：个别固件会在文件里附加注释
    let first = raw.lines().next().unwrap_or("").trim().to_string();
    if first.is_empty() {
        None
    } else {
        Some(first)
    }
}

/// `uci get system.@system[0].timezone`。找不到 uci 或选项为空时返回 `None`。
///
/// 这是**一次性**调用（在 `OnceLock` 初始化里），不会出现在热路径上。
/// 路径写绝对优先：procd 给守护进程的 `PATH` 极简，裸 `uci` 未必能命中。
fn read_uci_timezone() -> Option<String> {
    for bin in ["/sbin/uci", "/usr/bin/uci", "uci"] {
        let Ok(out) = std::process::Command::new(bin)
            .args(["-q", "get", "system.@system[0].timezone"])
            .output()
        else {
            continue;
        };
        if !out.status.success() {
            continue;
        }
        let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !v.is_empty() {
            return Some(v);
        }
    }
    None
}

/// 从 libc 取「此刻」的 UTC 偏移秒数。非 Unix 宿主直接返回 `None`。
///
/// 用 `localtime_r` 而不是自己算：只有 libc 会应用 TZ 串里的 DST 规则。
#[cfg(unix)]
fn libc_offset_secs() -> Option<i32> {
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&now, &mut tm).is_null() {
            return None;
        }
        Some(tm.tm_gmtoff as i32)
    }
}

#[cfg(not(unix))]
fn libc_offset_secs() -> Option<i32> {
    // Windows/macOS 开发机上跑单测用：没有 TZ 文件时走内置解析器或北京时间兜底，
    // 使「默认北京时间」这条规则在任何宿主上都能被测试到。
    None
}

/// POSIX TZ 串的解析结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PosixTz {
    /// 标准时 UTC 偏移秒数（东为正）
    std_secs: i32,
    /// 夏令时 UTC 偏移秒数（东为正）；`None` 表示该 TZ 无夏令时
    dst_secs: Option<i32>,
}

/// 解析 POSIX TZ 串（`man tzset` 的 `std offset [dst [offset][,start[/time],end[/time]]]`）。
///
/// 关键约定：串里的偏移符号与 UTC 偏移**相反** —— `CST-8` 表示
/// 「本地时间 = UTC − (−8) = UTC+8」，即北京时间。
///
/// 只解析出两端偏移，**不展开 `M3.2.0` 之类的 DST 日期规则**：
/// 需要按日期切换时应当交给 libc（见 [`libc_offset_secs`]）。
/// 本函数存在的意义是 (a) 非 Unix 宿主兜底、(b) 判断是否含 DST 以便日志提示。
fn parse_posix_tz(s: &str) -> Option<PosixTz> {
    let s = s.trim();
    // `:` 前缀表示「按实现定义的名字去查 tzdata 文件」，不是 POSIX 串，本函数不处理。
    // 带 `/` 的 `Asia/Shanghai` 同理（zoneinfo 名，靠 libc 解析）。
    if s.is_empty() || s.starts_with(':') {
        return None;
    }
    let b = s.as_bytes();
    let mut i = skip_tz_name(b, 0)?;
    let (std_raw, next) = parse_tz_offset(b, i)?;
    i = next;

    // 到这里只有标准时
    if i >= b.len() {
        return Some(PosixTz { std_secs: -std_raw, dst_secs: None });
    }

    // 有夏令时名
    i = skip_tz_name(b, i)?;
    let dst_utc = if i < b.len() && b[i] != b',' {
        // 显式给了夏令时偏移
        let (raw, next) = parse_tz_offset(b, i)?;
        i = next;
        -raw
    } else {
        // POSIX 约定：省略时默认比标准时快 1 小时
        -std_raw + 3600
    };
    let _ = i; // 后面的 ,start,end 规则不展开，交给 libc
    Some(PosixTz { std_secs: -std_raw, dst_secs: Some(dst_utc) })
}

/// 跳过时区名：`<...>` 引号形式，或 ≥3 个字母的形式。
fn skip_tz_name(b: &[u8], mut i: usize) -> Option<usize> {
    if i >= b.len() {
        return None;
    }
    if b[i] == b'<' {
        let end = b[i + 1..].iter().position(|&c| c == b'>')? + i + 1;
        return Some(end + 1);
    }
    let start = i;
    while i < b.len() && b[i].is_ascii_alphabetic() {
        i += 1;
    }
    if i - start < 3 {
        return None;
    }
    Some(i)
}

/// 解析 `[+-]hh[:mm[:ss]]`，返回（POSIX 原始偏移秒数，新下标）。
fn parse_tz_offset(b: &[u8], mut i: usize) -> Option<(i32, usize)> {
    if i >= b.len() {
        return None;
    }
    let mut neg = false;
    if b[i] == b'+' || b[i] == b'-' {
        neg = b[i] == b'-';
        i += 1;
    }
    let (h, ni) = parse_digits(b, i, 3)?;
    i = ni;
    let mut total = h * 3600;
    if i < b.len() && b[i] == b':' {
        let (m, ni) = parse_digits(b, i + 1, 2)?;
        i = ni;
        total += m * 60;
        if i < b.len() && b[i] == b':' {
            let (s, ni) = parse_digits(b, i + 1, 2)?;
            i = ni;
            total += s;
        }
    }
    Some((if neg { -total } else { total }, i))
}

/// 读 1..=max 位十进制数字。
fn parse_digits(b: &[u8], mut i: usize, max: usize) -> Option<(i32, usize)> {
    let start = i;
    let mut v: i32 = 0;
    while i < b.len() && b[i].is_ascii_digit() && i - start < max {
        v = v * 10 + i32::from(b[i] - b'0');
        i += 1;
    }
    if i == start {
        return None;
    }
    Some((v, i))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    /// 一天 24 小时的分钟数，仅测试断言用。

    /// 生效偏移的秒数（东为正）。生产代码不需要它，故只活在测试里。
    fn offset_secs() -> i32 {
        offset().local_minus_utc()
    }

    /* ---------------------------- POSIX TZ 解析 ---------------------------- */

    #[test]
    fn posix_cst_minus_8_is_utc_plus_8() {
        let p = parse_posix_tz("CST-8").expect("CST-8 必须能解析");
        assert_eq!(p.std_secs, 8 * 3600);
        assert_eq!(p.dst_secs, None);
    }

    #[test]
    fn posix_utc_zero_is_utc() {
        assert_eq!(parse_posix_tz("UTC0").unwrap().std_secs, 0);
        assert_eq!(parse_posix_tz("GMT0").unwrap().std_secs, 0);
    }

    #[test]
    fn posix_est5_is_utc_minus_5() {
        // POSIX 符号相反：EST5 → UTC−5
        assert_eq!(parse_posix_tz("EST5").unwrap().std_secs, -5 * 3600);
    }

    #[test]
    fn posix_explicit_utc_offset_syntax() {
        // 再次强调符号相反：`UTC+8` 的本地时间是 **UTC−8**，不是 UTC+8。
        // 这是 POSIX TZ 最容易写错的地方，OpenWrt 存的是 `CST-8`（= UTC+8）。
        assert_eq!(parse_posix_tz("UTC+8").unwrap().std_secs, -8 * 3600);
        assert_eq!(parse_posix_tz("CST-8:30").unwrap().std_secs, 8 * 3600 + 1800);
        assert_eq!(parse_posix_tz("ABC-1:2:3").unwrap().std_secs, 3600 + 120 + 3);
    }

    #[test]
    fn posix_shanghai_style_string_is_utc_plus_8() {
        // 需求基线：北京时间
        assert_eq!(parse_posix_tz("CST-8").unwrap().std_secs, BEIJING_OFFSET_SECS);
        assert_eq!(parse_posix_tz("CST-8:00:00").unwrap().std_secs, BEIJING_OFFSET_SECS);
    }

    #[test]
    fn posix_quoted_name() {
        assert_eq!(parse_posix_tz("<-04>4").unwrap().std_secs, -4 * 3600);
        assert_eq!(parse_posix_tz("<+0530>-5:30").unwrap().std_secs, 5 * 3600 + 1800);
    }

    #[test]
    fn posix_dst_default_offset_is_plus_one_hour() {
        // 省略 DST 偏移 → 标准时 +1h
        let p = parse_posix_tz("GMT0BST,M3.5.0/1,M10.5.0").expect("含 DST 规则应能识别");
        assert_eq!(p.std_secs, 0);
        assert_eq!(p.dst_secs, Some(3600));
    }

    #[test]
    fn posix_dst_explicit_offset() {
        let p = parse_posix_tz("EST5EDT4,M3.2.0,M11.1.0").unwrap();
        assert_eq!(p.std_secs, -5 * 3600);
        assert_eq!(p.dst_secs, Some(-4 * 3600));
    }

    #[test]
    fn posix_rejects_non_posix_names() {
        // zoneinfo 路径名不是 POSIX 串，应当交给 libc 而不是被误解析
        assert!(parse_posix_tz("Asia/Shanghai").is_none());
        assert!(parse_posix_tz("").is_none());
        assert!(parse_posix_tz(":Asia/Shanghai").is_none());
        // 名字少于 3 个字母、缺偏移、偏移非数字
        assert!(parse_posix_tz("AB-8").is_none());
        assert!(parse_posix_tz("CST").is_none());
        assert!(parse_posix_tz("CSTabc").is_none());
    }

    /* ------------------------------ 时间源行为 ------------------------------ */

    #[test]
    fn beijing_fallback_is_eight_hours() {
        assert_eq!(BEIJING_OFFSET_SECS, 28800);
        assert_eq!(FixedOffset::east_opt(BEIJING_OFFSET_SECS).unwrap().local_minus_utc(), 28800);
    }

    #[test]
    fn offset_is_within_valid_range() {
        let s = offset_secs();
        assert!((-24 * 3600..=24 * 3600).contains(&s), "偏移越界: {s}");
    }

    /// 回归用例：`now()` 的**墙上时间**必须比 UTC 恰好快「本模块解析出的偏移」。
    ///
    /// 注意**不能**用 `timestamp()` 比较 —— 那是 UTC 秒，与显示时区无关，
    /// 拿它做断言会把「静默退化成 UTC」这个 bug 完整放过去。
    /// 必须比较 `naive_local() - naive_utc()`，也就是真正显示给用户的那串数字。
    #[test]
    fn now_wall_clock_is_utc_plus_resolved_offset() {
        let utc = Utc::now();
        let diff = now().naive_local() - utc.naive_utc();
        assert!(
            (diff.num_seconds() - i64::from(offset_secs())).abs() <= 1,
            "墙上时间与 UTC 相差 {}s，但解析出的偏移是 {}s（差整 8 小时即退化成 UTC 的典型症状）",
            diff.num_seconds(),
            offset_secs()
        );
    }

    /* --------------------------- 三级回退决策 --------------------------- */

    #[test]
    fn pick_offset_prefers_libc_result() {
        // libc 能连夏令时一起算对，优先级最高，哪怕内置解析器算出别的值
        assert_eq!(pick_offset(Some(-5 * 3600), parse_posix_tz("CST-8")), (-5 * 3600, false));
    }

    #[test]
    fn pick_offset_uses_parsed_std_when_libc_unavailable() {
        assert_eq!(pick_offset(None, parse_posix_tz("CST-8")), (BEIJING_OFFSET_SECS, false));
        assert_eq!(pick_offset(None, parse_posix_tz("EST5")), (-5 * 3600, false));
    }

    #[test]
    fn pick_offset_flags_ignored_dst() {
        // 宿主不支持 DST 时，只能用标准时偏移，并且必须把这件事报出来
        let p = parse_posix_tz("GMT0BST,M3.5.0/1,M10.5.0").unwrap();
        assert_eq!(pick_offset(None, Some(p)), (0, true));
    }

    #[test]
    fn pick_offset_defaults_to_beijing() {
        // 系统完全没配时区 → 北京时间。这就是需求里的「默认北京时间」。
        assert_eq!(pick_offset(None, None), (BEIJING_OFFSET_SECS, false));
    }



    #[test]
    fn describe_is_non_empty() {
        assert!(!describe().is_empty());
    }
    #[test]
    fn from_unix_matches_offset() {
        // 0 秒（epoch）在 UTC 是 1970-01-01 00:00:00，本地应等于「UTC + 偏移」
        let dt = from_unix(0);
        assert_eq!(dt.timestamp(), 0);
        assert_eq!(dt.offset().local_minus_utc(), offset_secs());
    }
    #[test]
    fn from_ymdhms_rejects_invalid() {
        // 字段越界必须返回 None 而不是 panic 或静默纠正
        assert!(from_ymdhms(2025, 2, 30, 0, 0, 0).is_none());
        assert!(from_ymdhms(2025, 13, 1, 0, 0, 0).is_none());
    }
    #[test]
    fn from_ymdhms_roundtrip_timezone() {
        // 2025-08-25 12:00:00 本地 → 减去偏移即为 UTC
        let dt = from_ymdhms(2025, 8, 25, 12, 0, 0).expect("合法日期");
        assert_eq!(dt.format("%Y-%m-%d %H:%M:%S").to_string(), "2025-08-25 12:00:00");
        assert_eq!(dt.timestamp(), 1756123200 - i64::from(offset_secs()));
        assert_eq!(dt.offset().local_minus_utc(), offset_secs());
    }
    #[test]
    fn hhmm_formats_signed_offset() {
        assert_eq!(hhmm(8 * 3600), "08:00");
        assert_eq!(hhmm(-5 * 3600), "05:00");
        assert_eq!(hhmm(5 * 3600 + 1800), "05:30");
        assert_eq!(hhmm(0), "00:00");
    }
}
