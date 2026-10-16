//! 网络时间源（NTP）：**优先从 NTP 服务器取时间，取不到就退回设备时钟**。
//!
//! # 为什么单独成模块
//!
//! 「每月几号自动清零」这类按**日历日期**判定的逻辑，对时钟准确度极其敏感：
//! 路由器断电重启后没有 RTC 时会从 1970 或某个出厂时间开始走，此时
//! 「今天是不是 1 号」完全答错，清零会错月触发或永不触发。
//! 本模块只做一件事：把「当前准确的 unix 秒」这个问题收敛到一处，
//! 其它模块（usage / schedule / 日志）一律通过 [`now`] 取时间，不再自己判断。
//!
//! # 全仓库唯一墙上时间入口
//!
//! **插件里凡是「现在几点」的地方一律走本模块**：日志时间戳、短信 PDU 时间兜底、
//! 通知时间、时段判定、使用量按月清零……都不再各自去取 `chrono::Utc::now()`。
//! 只有两类例外（详见 [`now`] 的文档）：
//!   - **耗时 / 间隔测量**（AT 超时、节流、凭证有效期）：用 `Instant`，
//!     它不受 NTP 校正的跳变影响；
//!   - 本模块内部（它自己就是时间源）。
//!
//! `tests` 里有一条源码级回归用例盯着这条约定：除 `localtime.rs` / `nettime.rs`
//! 之外的任何源文件里出现 `chrono::Utc::now()`，测试直接失败。
//!
//! # 同步节奏
//!
//! **取到一次之后就本地计时**，不再每次取时间都去问服务器：
//!
//! ```text
//! 启动 ──► 同步一次 ─成功─► 记下偏移 ──► 本地计时 20 分钟 ──► 再同步 …
//!                │                                             ▲
//!                └─失败─► 3 秒 ×10 次 ─► 1 分钟 ×10 次 ─► 20 分钟 ┘
//!                         （仍失败）        （仍失败）     （长期兜底，直到成功）
//! ```
//!
//! 失败退避是**先快后慢**：
//!   - 刚开机最常见的失败原因是「还没拨上号」，几秒后就好了，所以先 **3 秒 × 10 次**
//!     （约 30 秒窗口，覆盖拨号与基站注册的时间）；
//!   - 仍不通说明不是瞬时抖动，降到 **1 分钟 × 10 次**（约 10 分钟窗口）；
//!   - 再不通就落到 **20 分钟**常驻节奏，避免网络长期不可达时每 3 秒空转。
//! 任何一次成功都会把连续失败计数清零，回到 20 分钟节奏。
//!
//! 期间 [`now`] / [`now_ts`] / [`now_ms`] 一律是「设备时钟 + 偏移」的本地计算，
//! **零网络开销**。
//!
//! # 时间口径
//!
//! | 层次 | 取值 | 失败回退 |
//! |:--|:--|:--|
//! | UTC 时刻 | NTP（三个服务器依次尝试） | 设备时钟（[`crate::localtime::now`]） |
//! | 本地时区 | 系统时区（`/etc/TZ` → uci），见 [`crate::localtime`] | 北京时间 UTC+8 |
//!
//! 即：**时刻**优先 NTP、**时区**优先 OpenWrt 系统设置，两者正交。
//! 时区解析仍全部复用 `localtime`，本模块不重复实现一套。
//!
//! # 为什么不用 chrono::Local
//!
//! 同 `localtime` 的结论：本固件不带 tzdata、守护进程也没有 `TZ` 环境变量，
//! `chrono::Local` 会静默退化成 UTC。全仓库约定除 `localtime` 外不许出现它。

use crate::{log_debug, log_info, log_warn};
use chrono::DateTime;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU8, Ordering};
use std::time::Duration;
use tokio::net::UdpSocket;

/// NTP 服务器列表（按序尝试，取第一个应答的）。
///
/// 全部是公共 NTP 池/厂商服务器，无需鉴权；三个都不可达就直接回退设备时钟，
/// 不会因为取不到网络时间而阻塞启动。
pub const NTP_SERVERS: [&str; 3] = ["ntp.tencent.com", "ntp.aliyun.com", "time.cloudflare.com"];

const NTP_PORT: u16 = 123;
/// 单服务器等待上限：移动网络下 DNS + 往返偶尔会到 1~2 秒，给 3 秒足够。
const NTP_TIMEOUT: Duration = Duration::from_secs(3);
/// 同步成功后的再次同步间隔（**20 分钟**）。
///
/// 取到一次之后就靠「设备时钟 + 偏移」本地计时，不再频繁打扰服务器：
/// 24 小时约 72 次查询，每次 48 字节请求 / 48 字节应答，流量可以忽略。
/// 20 分钟足够跟上设备晶振的漂移（常温晶振日漂移百毫秒级），不需要更密。
const SYNC_INTERVAL: Duration = Duration::from_secs(20 * 60);

/// 退避第一级：**3 秒**重试，最多 [`RETRY_FAST_TIMES`] 次（约 30 秒窗口）。
///
/// 取 10 次而不是 3 次：开机拨号往往要十几秒到二十几秒才通，
/// 3 次（9 秒）太早放弃，会白白掉到分钟级，把「刚开机那半分钟」浪费掉。
const RETRY_FAST: Duration = Duration::from_secs(3);
/// 退避第一级的重试次数。
const RETRY_FAST_TIMES: u32 = 10;
/// 退避第二级：**1 分钟**一次，最多 [`RETRY_SLOW_TIMES`] 次（约 10 分钟窗口）。
///
/// 同样取 10 次：覆盖「拨号慢 / 基站注册慢 / 短暂断网」这类分钟级恢复，
/// 之后才认为网络长期不可达，落到 20 分钟常驻节奏。
const RETRY_MID: Duration = Duration::from_secs(60);
/// 退避第二级的重试次数。
const RETRY_SLOW_TIMES: u32 = 10;

/// NTP 纪元（1900-01-01）到 Unix 纪元（1970-01-01）的秒差。
const NTP_TO_UNIX: i64 = 2_208_988_800;
/// 32 位 NTP 秒字段的模（用于 2036 年纪元回绕展开）。
const NTP_U32_MOD: i64 = 4_294_967_296;
/// 合理性下界：2000-01-01T00:00:00Z。早于此的应答一律视为异常，不用。
const MIN_PLAUSIBLE_UNIX: i64 = 946_684_800;
/// 合理性上界：2100-01-01T00:00:00Z。
const MAX_PLAUSIBLE_UNIX: i64 = 4_102_444_800;

/// NTP 时刻相对设备时钟的偏移（秒）：`ntp = sys + OFFSET`。
///
/// 存偏移而不是存绝对时刻：两次同步之间仍由设备时钟单调推进，
/// 不会因为 NTP 取不到就把时间「冻住」。
static OFFSET_SECS: AtomicI64 = AtomicI64::new(0);
/// 最近一次成功同步的设备时刻（0 = 从未成功）。
static SYNCED_AT: AtomicI64 = AtomicI64::new(0);
/// 当前时间来源：0=设备时钟，1=NTP。
static SOURCE_NTP: AtomicU8 = AtomicU8::new(0);
/// 连续失败次数（成功即清零），决定 [`backoff_for`] 落在哪一级。
static CONSECUTIVE_FAILS: AtomicU32 = AtomicU32::new(0);

/// 失败退避：先 3 秒快重试，再 1 分钟慢重试，最后落到 20 分钟常驻节奏。
///
/// 纯函数（不碰全局状态），便于单测逐级覆盖。
/// `consecutive_fails` 为**连续**失败次数（成功即清零）。
pub fn backoff_for(consecutive_fails: u32) -> Duration {
    if consecutive_fails <= RETRY_FAST_TIMES {
        RETRY_FAST
    } else if consecutive_fails <= RETRY_FAST_TIMES + RETRY_SLOW_TIMES {
        RETRY_MID
    } else {
        SYNC_INTERVAL
    }
}

/// 时间来源是否来自 NTP。
pub fn from_ntp() -> bool {
    SOURCE_NTP.load(Ordering::Relaxed) == 1
}

/// 时间来源（给日志/状态展示用）。
pub fn source_name() -> &'static str {
    if from_ntp() { "NTP" } else { "设备时钟" }
}

/// **未经校正**的设备时钟（unix 秒）。
///
/// 只在对时逻辑内部使用：算偏移必须用原始设备时钟，否则偏移会自我叠加。
fn device_ts() -> i64 {
    crate::localtime::now().timestamp()
}

/// 当前 unix 秒（已叠加 NTP 偏移；未同步时即设备时钟）。
///
/// 底钟走 [`crate::localtime::now`]（设备时钟 + 系统时区）而不是 `chrono::Utc::now()`：
/// 两者同一时刻、数值相同，但这样能保证「全仓库只有一个地方读设备时钟」。
pub fn now_ts() -> i64 {
    crate::localtime::now().timestamp() + OFFSET_SECS.load(Ordering::Relaxed)
}

/// 当前毫秒时间戳（前端按本地格式化展示）。
///
/// 秒部分随 NTP 偏移校正，毫秒部分取设备时钟的亚秒 —— NTP 只到秒级精度，
/// 亚秒部分只能来自本机，二者相加即为「校正后的毫秒时刻」。
pub fn now_ms() -> i64 {
    let sys = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = sys.as_secs() as i64 + OFFSET_SECS.load(Ordering::Relaxed);
    secs * 1000 + i64::from(sys.subsec_millis())
}

/// `%Y-%m-%d %H:%M:%S` 格式的当前时刻字符串（系统时区）。
pub fn now_string() -> String {
    now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 当前时刻（**系统时区**，时区取不到时北京时间；时刻优先 NTP）。
///
/// 全代码库请统一用这个，而不是 `chrono::Utc::now()` / `chrono::Local`。
/// 不需要时区的场合用 [`now_ts`] / [`now_ms`]。
pub fn now() -> DateTime<crate::localtime::Tz> {
    crate::localtime::from_unix(now_ts())
}

/// 解析 NTP 服务端应答，取出**发送时刻**（Transmit Timestamp，字节 40..44）。
///
/// 取的是「服务器发出应答的时刻」而不是客户端接收时刻，能抵消大部分单向延迟。
/// 纯函数（不碰网络），便于单测覆盖各种异常报文。
pub fn parse_response(buf: &[u8]) -> Option<i64> {
    if buf.len() < 48 {
        return None;
    }
    let mode = buf[0] & 0x07;
    let version = (buf[0] >> 3) & 0x07;
    // mode 4 = server；3 以下的老版本报文结构一致，一并接受
    if mode != 4 || version < 3 {
        return None;
    }
    let stratum = buf[1];
    // stratum 0 是 Kiss-o'-Death（服务器拒绝服务），16 是「未同步」，都不能用
    if stratum == 0 || stratum > 15 {
        return None;
    }
    let raw = u32::from_be_bytes([buf[40], buf[41], buf[42], buf[43]]);
    if raw == 0 {
        return None;
    }
    // 32 位 NTP 秒会在 2036 年回绕：字段值小于 1970 对应的值时按下一纪元展开。
    let mut secs = raw as i64;
    if secs < NTP_TO_UNIX {
        secs += NTP_U32_MOD;
    }
    let unix = secs - NTP_TO_UNIX;
    if !(MIN_PLAUSIBLE_UNIX..MAX_PLAUSIBLE_UNIX).contains(&unix) {
        return None;
    }
    Some(unix)
}

/// 构造 NTPv4 客户端请求（48 字节，只填首字节与 Transmit Timestamp）。
fn build_request() -> [u8; 48] {
    let mut req = [0u8; 48];
    // LI=0(无告警) VN=4 Mode=3(客户端)
    req[0] = (4 << 3) | 3;
    let ntp_secs = (device_ts() + NTP_TO_UNIX) & 0xFFFF_FFFF;
    req[40..44].copy_from_slice(&(ntp_secs as u32).to_be_bytes());
    req
}

/// 向单个服务器取时间；任何一步失败都返回 `None`（不抛错、不重试）。
async fn query_server(host: &str) -> Option<i64> {
    let sock = UdpSocket::bind("0.0.0.0:0").await.ok()?;
    let addr = tokio::net::lookup_host((host, NTP_PORT)).await.ok()?.next()?;
    let req = build_request();
    sock.send_to(&req, addr).await.ok()?;
    let mut buf = [0u8; 64];
    let (n, _) = tokio::time::timeout(NTP_TIMEOUT, sock.recv_from(&mut buf))
        .await
        .ok()?
        .ok()?;
    parse_response(&buf[..n])
}

/// 依次尝试 [`NTP_SERVERS`]，返回第一个成功取到的 unix 秒。
pub async fn sync_once() -> Option<i64> {
    for host in NTP_SERVERS {
        match query_server(host).await {
            Some(ts) => {
                log_debug!("NTP 对时成功: {host} → {ts}");
                return Some(ts);
            }
            None => log_debug!("NTP 服务器 {host} 未应答，尝试下一个"),
        }
    }
    None
}

/// 同步一次并把结果写进进程态；返回是否来自 NTP。
///
/// 偏移按「请求前 / 应答后」两个设备时刻的中点计算，抵消一半往返延迟。
/// 这里刻意用 **原始设备时钟**（[`device_ts`]）而不是 [`now_ts`]：后者已含偏移，
/// 拿它跟 NTP 比会把上一轮的偏移算进去，越同步越歪。
pub async fn sync_and_apply() -> bool {
    let sys_before = device_ts();
    match sync_once().await {
        Some(ntp) => {
            let sys_after = device_ts();
            let mid = sys_before + (sys_after - sys_before) / 2;
            OFFSET_SECS.store(ntp - mid, Ordering::Relaxed);
            SYNCED_AT.store(sys_after, Ordering::Relaxed);
            SOURCE_NTP.store(1, Ordering::Relaxed);
            log_info!("时间源: NTP 对时成功（相对设备时钟 {:+}s）", ntp - mid);
            true
        }
        None => {
            SOURCE_NTP.store(0, Ordering::Relaxed);
            log_warn!("时间源: NTP 均不可达，回退设备时钟（按日历清零可能不准，待对时后自动纠正）");
            false
        }
    }
}

/// 后台对时循环：**启动即试一次，之后成功等 20 分钟、失败等 60 秒**。
///
/// 取时间只发生在这里（以及 [`sync_and_apply`] 被显式调用时）；
/// [`now`] / [`now_ts`] / [`now_ms`] 都是纯本地计算，不产生任何网络流量。
pub async fn run(ctx: tokio::sync::watch::Receiver<bool>) {
    loop {
        let ok = sync_and_apply().await;
        let wait = if ok {
            CONSECUTIVE_FAILS.store(0, Ordering::Relaxed);
            SYNC_INTERVAL
        } else {
            // 连续失败次数 +1（本次算在内），据此选择退避档位
            let fails = CONSECUTIVE_FAILS.fetch_add(1, Ordering::Relaxed) + 1;
            backoff_for(fails)
        };
        if ok {
            log_debug!("时间源: 下次对时在 {} 分钟后", wait.as_secs() / 60);
        } else {
            log_debug!("时间源: 对时失败，{} 秒后重试", wait.as_secs());
        }
        if !crate::schedule::sleep_ctx(&ctx, wait).await {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个合法的服务端应答：mode=4 / vn=4 / stratum=2，Transmit = 给定 unix 秒。
    fn resp(unix: i64, mode: u8, stratum: u8) -> [u8; 48] {
        let mut b = [0u8; 48];
        b[0] = (4 << 3) | mode;
        b[1] = stratum;
        let ntp = (unix + NTP_TO_UNIX) as u32;
        b[40..44].copy_from_slice(&ntp.to_be_bytes());
        b
    }

    #[test]
    fn parses_normal_server_response() {
        let b = resp(1_700_000_000, 4, 2);
        assert_eq!(parse_response(&b), Some(1_700_000_000));
    }

    #[test]
    fn rejects_short_packet() {
        assert_eq!(parse_response(&[0u8; 47]), None);
    }

    #[test]
    fn rejects_non_server_mode() {
        // mode=3 是客户端报文，不能当成服务端应答
        assert_eq!(parse_response(&resp(1_700_000_000, 3, 2)), None);
    }

    #[test]
    fn rejects_kiss_of_death_and_unsynced() {
        assert_eq!(parse_response(&resp(1_700_000_000, 4, 0)), None, "stratum 0 = 拒绝服务");
        assert_eq!(parse_response(&resp(1_700_000_000, 4, 16)), None, "stratum 16 = 未同步");
    }

    #[test]
    fn rejects_zero_timestamp() {
        let mut b = resp(1_700_000_000, 4, 2);
        b[40..44].copy_from_slice(&0u32.to_be_bytes());
        assert_eq!(parse_response(&b), None);
    }

    #[test]
    fn rejects_implausible_time() {
        // 1990 年：早于 2000，视为异常报文（常见于设备时钟被误当 NTP 时间回传）
        assert_eq!(parse_response(&resp(631_152_000, 4, 2)), None);
    }

    #[test]
    fn expands_era_after_2036_rollover() {
        // 2036 年后 32 位 NTP 秒回绕，字段值会小于 1970 对应的值 → 按下一纪元展开
        let unix: i64 = 2_500_000_000; // 2049 年
        let raw = ((unix + NTP_TO_UNIX) % NTP_U32_MOD) as u32;
        assert!((raw as i64) < NTP_TO_UNIX, "构造前提：字段已回绕");
        let mut b = [0u8; 48];
        b[0] = (4 << 3) | 4;
        b[1] = 2;
        b[40..44].copy_from_slice(&raw.to_be_bytes());
        assert_eq!(parse_response(&b), Some(unix));
    }

    #[test]
    fn offset_is_applied_to_now_ts() {
        // 直接落偏移（NTP 不可达时无法真连，测的是叠加逻辑本身）
        OFFSET_SECS.store(3600, Ordering::Relaxed);
        let sys = device_ts();
        let got = now_ts();
        OFFSET_SECS.store(0, Ordering::Relaxed);
        assert!((got - sys - 3600).abs() <= 2, "now_ts 应等于设备时间 + 偏移");
    }

    #[test]
    fn now_uses_system_timezone() {
        // 时刻可以来自 NTP，但时区永远走 localtime（系统时区 → 北京时间兜底）
        let dt = now();
        assert_eq!(dt.offset().local_minus_utc(), crate::localtime::offset().local_minus_utc());
    }

    #[test]
    fn no_direct_wall_clock_outside_time_modules() {
        // 约定：除 localtime（时区层）与 nettime（时间源）外，
        // 任何模块都不许直接取墙上时钟 —— 否则同一条日志/同一个判定会出现两条时间线。
        // 耗时测量请用 Instant，绝对时刻请用 nettime::now / now_ts / now_ms。
        let allowed = ["localtime.rs", "nettime.rs"];
        let dir = std::fs::read_dir("src").expect("测试的工作目录应是 crate 根");
        for entry in dir.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".rs") || allowed.contains(&name.as_str()) {
                continue;
            }
            let body = std::fs::read_to_string(entry.path()).unwrap_or_default();
            // 只查代码：注释里出现这些名字（例如说明「为什么不能用 chrono::Local」）不算违规
            let code = {
                let mut out = String::new();
                let bytes = body.as_bytes();
                let mut i = 0;
                while i < bytes.len() {
                    if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                        if let Some(end) = body[i + 2..].find("*/") {
                            i += 2 + end + 2;
                            continue;
                        }
                    }
                    if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
                        if let Some(end) = body[i..].find('\n') {
                            i += end + 1;
                            continue;
                        }
                        break;
                    }
                    out.push(bytes[i] as char);
                    i += 1;
                }
                out
            };
            for pat in ["chrono::Utc::now(", "chrono::Local", "SystemTime::now()"] {
                assert!(
                    !code.contains(pat),
                    "{name} 里出现了 `{pat}`：请改用 crate::nettime（耗时测量用 Instant）",
                );
            }
        }
    }

    #[test]
    fn steady_state_resync_is_twenty_minutes() {
        // 「取到后本地计时，20 分钟再同步」：绝不退化成每次取时间都去问服务器
        assert_eq!(SYNC_INTERVAL, Duration::from_secs(20 * 60));
        assert_eq!(SYNC_INTERVAL.as_secs(), 1200);
    }

    #[test]
    fn backoff_is_fast_then_slow_then_steady() {
        // 第一级：3 秒快重试（刚开机多半只是还没拨上号）
        for fails in 1..=RETRY_FAST_TIMES {
            assert_eq!(backoff_for(fails), RETRY_FAST, "第 {fails} 次失败应 3 秒重试");
        }
        assert_eq!(RETRY_FAST, Duration::from_secs(3));
        // 第二级：1 分钟 × 3 次
        for fails in RETRY_FAST_TIMES + 1..=RETRY_FAST_TIMES + RETRY_SLOW_TIMES {
            assert_eq!(backoff_for(fails), RETRY_MID, "第 {fails} 次失败应 1 分钟重试");
        }
        assert_eq!(RETRY_MID, Duration::from_secs(60));
        // 第三级：之后长期 20 分钟一次，不再加速
        for fails in [RETRY_FAST_TIMES + RETRY_SLOW_TIMES + 1, 50, 1000] {
            assert_eq!(backoff_for(fails), SYNC_INTERVAL, "第 {fails} 次失败应回落到 20 分钟");
        }
        // 逐级变慢，不能出现「越失败越急」
        assert!(RETRY_FAST < RETRY_MID && RETRY_MID < SYNC_INTERVAL);
    }

    #[test]
    fn backoff_zero_is_the_fast_lane() {
        // 计数只在失败时自增，0 次失败不会真的走进这里；兜底给最快档
        assert_eq!(backoff_for(0), RETRY_FAST);
    }

    #[test]
    fn server_list_is_not_empty() {
        assert!(!NTP_SERVERS.is_empty());
        for h in NTP_SERVERS {
            assert!(h.ends_with(".com"), "NTP 服务器域名: {h}");
        }
    }
}
