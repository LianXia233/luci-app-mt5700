//! 网络时间源（NTP）：**优先从 NTP 服务器取时间，取不到就退回设备时钟**。
//!
//! # 与 main 分支（OpenWrt 版）的差异
//!
//! | 维度 | main（OpenWrt） | 本分支（Debian） |
//! |:--|:--|:--|
//! | 时刻来源 | NTP → 设备时钟 | 同左（逻辑完全一致） |
//! | 时区来源 | `localtime` 模块解析 `/etc/TZ` → uci（**固件无 tzdata**） | **`chrono::Local`**（Debian 自带 tzdata，读 `/etc/localtime` + `TZ` 环境变量） |
//!
//! 也就是说：Debian 上时区这件事系统已经做好了，本模块不需要（也不应该）再自己解析
//! POSIX TZ 串 —— 只校正 UTC 时刻，时区继续**读设备的**。
//!
//! # 全仓库唯一墙上时间入口
//!
//! 凡是「现在几点」一律走这里：日志时间戳、短信 PDU 时间兜底、通知时间、
//! 巡检时段判定、定时锁频、HTTP 接口时间戳……都不再各自去取
//! `chrono::Local::now()` / `chrono::Utc::now()`。
//!
//! 例外只有两类：
//!   - **耗时 / 间隔测量**（AT 超时、节流、长命令结束判定）：用 `Instant`，
//!     单调时钟不受 NTP 校正跳变影响；
//!   - 本模块内部（它自己就是时间源）。
//!
//! `tests` 里有一条源码级回归用例盯着这条约定：除 `nettime.rs` 之外的任何源文件
//! 出现 `chrono::Local` / `chrono::Utc::now()` / `SystemTime::now()`，测试直接失败。
//!
//! # 同步节奏
//!
//! ```text
//! 启动 ──► 同步一次 ─成功─► 记下偏移 ──► 本地计时 20 分钟 ──► 再同步 …
//!                │                                            ▲
//!                └─失败─► 3 秒 ×10 ─► 1 分钟 ×10 ─► 20 分钟 ───┘
//! ```
//!
//! - 成功后 **20 分钟**再同步；期间 `now` / `now_ts` / `now_ms` 都是
//!   「设备时钟 + 偏移」的纯本地计算，**零网络开销**；
//! - 失败按三级退避：3 秒 ×10（约 30 秒，覆盖开机拨号/网络就绪）→
//!   1 分钟 ×10（约 10 分钟）→ 20 分钟常驻；任何一次成功都把连续失败计数清零。

use crate::{log_debug, log_info, log_warn};
use chrono::{DateTime, Local, Offset, TimeZone};
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU8, Ordering};
use std::time::Duration;
use tokio::net::UdpSocket;

/// 本分支的时间类型：**`chrono::Local`**（系统时区由 tzdata 解析）。
///
/// 与既有代码（schedule / pdu 等）使用的 `DateTime<Local>` 完全一致，
/// 因此把它们的时间源换成 `nettime::now()` 不需要改任何类型签名。
pub type Tz = Local;

/// NTP 服务器列表（按序尝试，取第一个应答的）。
pub const NTP_SERVERS: [&str; 3] = ["ntp.tencent.com", "ntp.aliyun.com", "time.cloudflare.com"];

const NTP_PORT: u16 = 123;
/// 单服务器等待上限。
const NTP_TIMEOUT: Duration = Duration::from_secs(3);

/// 同步成功后的再次同步间隔（**20 分钟**）。
const SYNC_INTERVAL: Duration = Duration::from_secs(20 * 60);
/// 退避第一级：**3 秒**重试，最多 [`RETRY_FAST_TIMES`] 次（约 30 秒窗口）。
const RETRY_FAST: Duration = Duration::from_secs(3);
const RETRY_FAST_TIMES: u32 = 10;
/// 退避第二级：**1 分钟**一次，最多 [`RETRY_SLOW_TIMES`] 次（约 10 分钟窗口）。
const RETRY_MID: Duration = Duration::from_secs(60);
const RETRY_SLOW_TIMES: u32 = 10;

/// NTP 纪元（1900-01-01）到 Unix 纪元（1970-01-01）的秒差。
const NTP_TO_UNIX: i64 = 2_208_988_800;
/// 32 位 NTP 秒字段的模（用于 2036 年纪元回绕展开）。
const NTP_U32_MOD: i64 = 4_294_967_296;
/// 合理性下界：2000-01-01T00:00:00Z。
const MIN_PLAUSIBLE_UNIX: i64 = 946_684_800;
/// 合理性上界：2100-01-01T00:00:00Z。
const MAX_PLAUSIBLE_UNIX: i64 = 4_102_444_800;

/// NTP 时刻相对设备时钟的偏移（秒）：`ntp = sys + OFFSET`。
static OFFSET_SECS: AtomicI64 = AtomicI64::new(0);
/// 当前时间来源：0=设备时钟，1=NTP。
static SOURCE_NTP: AtomicU8 = AtomicU8::new(0);
/// 连续失败次数（成功即清零），决定 [`backoff_for`] 落在哪一级。
static CONSECUTIVE_FAILS: AtomicU32 = AtomicU32::new(0);

/// 失败退避：先 3 秒快重试，再 1 分钟慢重试，最后落到 20 分钟常驻节奏。
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
    chrono::Utc::now().timestamp()
}

/// 当前 unix 秒（已叠加 NTP 偏移；未同步时即设备时钟）。
pub fn now_ts() -> i64 {
    device_ts() + OFFSET_SECS.load(Ordering::Relaxed)
}

/// 当前毫秒时间戳（前端按本地格式化展示）。
pub fn now_ms() -> i64 {
    let sys = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = sys.as_secs() as i64 + OFFSET_SECS.load(Ordering::Relaxed);
    secs * 1000 + i64::from(sys.subsec_millis())
}

/// 当前时刻（**系统时区由 tzdata 解析**，时刻优先 NTP）。
pub fn now() -> DateTime<Tz> {
    Local.timestamp_opt(now_ts(), 0).single().unwrap_or_else(Local::now)
}

/// 本地时区的固定偏移（供 [`crate::monthly`] 等需要 `FixedOffset` 的
/// 日历计算使用：DST 地区按当前时刻的偏移取，够用以定位「本地目标日 00:00」）。
pub fn offset() -> chrono::FixedOffset {
    Local::now().offset().fix()
}

/// `%Y-%m-%d %H:%M:%S` 格式的当前时刻字符串（系统时区）。
pub fn now_string() -> String {
    now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 解析 NTP 服务端应答，取出**发送时刻**（Transmit Timestamp，字节 40..44）。
pub fn parse_response(buf: &[u8]) -> Option<i64> {
    if buf.len() < 48 {
        return None;
    }
    let mode = buf[0] & 0x07;
    let version = (buf[0] >> 3) & 0x07;
    if mode != 4 || version < 3 {
        return None;
    }
    let stratum = buf[1];
    if stratum == 0 || stratum > 15 {
        return None;
    }
    let raw = u32::from_be_bytes([buf[40], buf[41], buf[42], buf[43]]);
    if raw == 0 {
        return None;
    }
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

/// 构造 NTPv4 客户端请求（48 字节）。
fn build_request() -> [u8; 48] {
    let mut req = [0u8; 48];
    req[0] = (4 << 3) | 3;
    let ntp_secs = (device_ts() + NTP_TO_UNIX) & 0xFFFF_FFFF;
    req[40..44].copy_from_slice(&(ntp_secs as u32).to_be_bytes());
    req
}

/// 向单个服务器取时间；任何一步失败都返回 `None`。
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
pub async fn sync_and_apply() -> bool {
    let sys_before = device_ts();
    match sync_once().await {
        Some(ntp) => {
            let sys_after = device_ts();
            let mid = sys_before + (sys_after - sys_before) / 2;
            OFFSET_SECS.store(ntp - mid, Ordering::Relaxed);
            SOURCE_NTP.store(1, Ordering::Relaxed);
            log_info!("时间源: NTP 对时成功（相对设备时钟 {:+}s）", ntp - mid);
            true
        }
        None => {
            SOURCE_NTP.store(0, Ordering::Relaxed);
            log_warn!("时间源: NTP 均不可达，回退设备时钟（待对时后自动纠正）");
            false
        }
    }
}

/// 后台对时循环：启动即试一次，之后成功等 20 分钟、失败按三级退避。
pub async fn run(ctx: tokio::sync::watch::Receiver<bool>) {
    loop {
        let ok = sync_and_apply().await;
        let wait = if ok {
            CONSECUTIVE_FAILS.store(0, Ordering::Relaxed);
            SYNC_INTERVAL
        } else {
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
        assert_eq!(parse_response(&resp(1_700_000_000, 4, 2)), Some(1_700_000_000));
    }

    #[test]
    fn rejects_bad_packets() {
        assert_eq!(parse_response(&[0u8; 47]), None, "短包");
        assert_eq!(parse_response(&resp(1_700_000_000, 3, 2)), None, "非服务端 mode");
        assert_eq!(parse_response(&resp(1_700_000_000, 4, 0)), None, "stratum 0 = KoD");
        assert_eq!(parse_response(&resp(1_700_000_000, 4, 16)), None, "stratum 16 = 未同步");
        assert_eq!(parse_response(&resp(631_152_000, 4, 2)), None, "1990 年不合理");
    }

    #[test]
    fn expands_era_after_2036_rollover() {
        let unix: i64 = 2_500_000_000;
        let raw = ((unix + NTP_TO_UNIX) % NTP_U32_MOD) as u32;
        assert!((raw as i64) < NTP_TO_UNIX);
        let mut b = [0u8; 48];
        b[0] = (4 << 3) | 4;
        b[1] = 2;
        b[40..44].copy_from_slice(&raw.to_be_bytes());
        assert_eq!(parse_response(&b), Some(unix));
    }

    #[test]
    fn offset_is_applied_to_now_ts() {
        OFFSET_SECS.store(3600, Ordering::Relaxed);
        let sys = device_ts();
        let got = now_ts();
        OFFSET_SECS.store(0, Ordering::Relaxed);
        assert!((got - sys - 3600).abs() <= 2);
    }

    #[test]
    fn steady_state_resync_is_twenty_minutes() {
        assert_eq!(SYNC_INTERVAL, Duration::from_secs(20 * 60));
    }

    #[test]
    fn backoff_is_fast_then_slow_then_steady() {
        for f in 1..=RETRY_FAST_TIMES {
            assert_eq!(backoff_for(f), RETRY_FAST);
        }
        for f in RETRY_FAST_TIMES + 1..=RETRY_FAST_TIMES + RETRY_SLOW_TIMES {
            assert_eq!(backoff_for(f), RETRY_MID);
        }
        for f in [RETRY_FAST_TIMES + RETRY_SLOW_TIMES + 1, 50, 1000] {
            assert_eq!(backoff_for(f), SYNC_INTERVAL);
        }
        assert!(RETRY_FAST < RETRY_MID && RETRY_MID < SYNC_INTERVAL);
    }

    #[test]
    fn server_list_is_not_empty() {
        assert!(!NTP_SERVERS.is_empty());
    }

    #[test]
    fn no_direct_wall_clock_outside_time_modules() {
        // 约定：除本模块外不许直接取墙上时钟 —— 一律走 nettime；
        // 耗时测量改用 Instant。注释里的说明不计入（先剥离注释再匹配）。
        let dir = std::fs::read_dir("src").expect("测试工作目录应为 crate 根");
        for entry in dir.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".rs") || name == "nettime.rs" {
                continue;
            }
            let body = std::fs::read_to_string(entry.path()).unwrap_or_default();
            let code = {
                let bytes = body.as_bytes();
                let mut out = String::new();
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
            for pat in ["chrono::Utc::now(", "chrono::Local::", "Local::now(", "SystemTime::now()"] {
                assert!(!code.contains(pat), "{name} 里出现了 `{pat}`：请改用 crate::nettime（耗时测量用 Instant）");
            }
        }
    }
}
