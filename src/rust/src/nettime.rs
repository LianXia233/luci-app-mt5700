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
//! # 时间口径
//!
//! | 层次 | 取值 | 失败回退 |
//! |:--|:--|:--|
//! | UTC 时刻 | NTP（三个服务器依次尝试） | 设备时钟（`chrono::Utc::now()`） |
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
use std::sync::atomic::{AtomicI64, AtomicU8, Ordering};
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
/// 同步成功后到下次同步的间隔（6 小时）。
const SYNC_INTERVAL: Duration = Duration::from_secs(6 * 3600);
/// 同步失败后的重试间隔（5 分钟）：失败通常是「还没拨上号」，短间隔重试更合理。
const RETRY_INTERVAL: Duration = Duration::from_secs(300);

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

/// 时间来源是否来自 NTP。
pub fn from_ntp() -> bool {
    SOURCE_NTP.load(Ordering::Relaxed) == 1
}

/// 时间来源（给日志/状态展示用）。
pub fn source_name() -> &'static str {
    if from_ntp() { "NTP" } else { "设备时钟" }
}

/// 当前 UTC 秒（已叠加 NTP 偏移；未同步时即设备时钟）。
pub fn now_ts() -> i64 {
    chrono::Utc::now().timestamp() + OFFSET_SECS.load(Ordering::Relaxed)
}

/// 当前时刻（**系统时区**，时区取不到时北京时间；时刻优先 NTP）。
///
/// 全仓库新增代码请统一用这个，而不是 `chrono::Utc::now()` / `chrono::Local`。
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
    let ntp_secs = (chrono::Utc::now().timestamp() + NTP_TO_UNIX) & 0xFFFF_FFFF;
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
pub async fn sync_and_apply() -> bool {
    let sys_before = chrono::Utc::now().timestamp();
    match sync_once().await {
        Some(ntp) => {
            let sys_after = chrono::Utc::now().timestamp();
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

/// 后台对时循环：启动即试一次，之后成功等 6 小时、失败等 5 分钟。
pub async fn run(ctx: tokio::sync::watch::Receiver<bool>) {
    loop {
        sync_and_apply().await;
        let wait = if from_ntp() { SYNC_INTERVAL } else { RETRY_INTERVAL };
        if !crate::schedule::sleep_ctx(&ctx, wait).await {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Offset;

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
        let sys = chrono::Utc::now().timestamp();
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
    fn server_list_is_not_empty() {
        assert!(!NTP_SERVERS.is_empty());
        for h in NTP_SERVERS {
            assert!(h.ends_with(".com"), "NTP 服务器域名: {h}");
        }
    }
}
