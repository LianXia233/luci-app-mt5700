//! 流量使用量**后台统计**。
//!
//! # 为什么放在后端常驻进程里
//!
//! 早期的实现把累加逻辑放在 rpcd 的 ucode 插件（`netrateCall`）里，由前端
//! `setInterval(sampleRate, 1000)` 每秒触发。那样做只在**页面开着**的时候才累加：
//! 关掉浏览器这期间的流量虽然能靠「内核计数器单调累计」在下次打开时补记，但
//! 语义上终究是「前端打开才记录」，且接口 flap 造成的计数器归零会直接丢掉那段增量。
//!
//! 现在由本模块在后端常驻进程里**独立周期采样**（默认 1 秒），与前端是否打开、
//! 是否刷新完全无关；前端只通过 `usage` RPC 读取快照。
//!
//! # 存储与生命周期
//!
//! | 场景 | 落点 | 重启后 |
//! |:--|:--|:--|
//! | 持久化关（默认） | `/tmp/mt5700-usage.json`（tmpfs，纯内存） | 丢失，从零开始 |
//! | 持久化开 | 额外写 `/etc/at-webserver-usage.json`（overlay），每 10 分钟最多一次 | 恢复 |
//!
//! - **清零按钮**：无论持久化开关状态如何，都强制重写两个文件（持久化开时把落盘
//!   文件一并清零，持久化关时删掉落盘文件），不会留下旧值。
//! - **文件大小上限**：状态文件是定长 schema 的 JSON，`MAX_USAGE_FILE_BYTES`
//!   既是写入时的断言，也是读取时的准入线——超限的文件一律视为损坏并忽略，
//!   避免异常大的文件被读进内存。
//! - **自动清零**：`usage_reset_day`（**每月几号**，默认 1 号，用户可改）存在 UCI 里，
//!   与「使用量是否持久化」解耦，否则关掉持久化就连设置一起丢了。
//!   到点后由本模块自行清零并重新基线，不需要前端参与。
//!   日期判定（大小月 / 闰年 / 跨年 / 「31 号在小月按月末」）全部由
//!   [`crate::monthly`] 负责，时刻取自 [`crate::nettime`]（NTP 优先、设备时钟兜底），
//!   本模块只做「该不该清」这一句调用，不重复实现日历逻辑。
//!
//! # 边界处理
//!
//! - 计数器归零（接口 flap / 重新拨号）表现为负增量：**只重置基线、不累加**，
//!   避免把一次归零误记成一笔巨额流量。
//! - 承载网卡变了（`iface_v4` 改动 / 模组换了网口）：同样只重置基线，累计值保留。
//! - 峰值只在正常采样节拍内计算；采样间隔异常拉长（进程被阻塞）时跳过，
//!   免得把一段长时间的低均值当成峰值。

use crate::localtime;
use crate::nettime;
use crate::{log_debug, log_info, log_warn};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{watch, Mutex};

/// 内存态状态文件（tmpfs，重启即失）。
pub const USAGE_VOL_PATH: &str = "/tmp/mt5700-usage.json";
/// 持久化状态文件（overlay，跨重启保留）。
pub const USAGE_FLASH_PATH: &str = "/etc/at-webserver-usage.json";

/// 统计记录文件大小上限（字节）。
///
/// 状态是定长 schema，正常序列化只有两百多字节；留到 4 KiB 是为了容忍
/// 未来加字段。超过这个大小的文件一律视为损坏：读取时忽略、从零开始，
/// 写入时断言不超限（超限说明有 bug，宁可不写也不能写出一个异常大的文件）。
pub const MAX_USAGE_FILE_BYTES: u64 = 4096;

/// 采样间隔：1 秒。
///
/// 取 1 秒而不是更疏，是为了让「峰值速率」有 1 秒粒度——5 秒 bucket 会把
/// 一秒的突发压成五分之一，显示出来的峰值会明显低于实际。
const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);

/// 持久化落盘的最小间隔（秒）。
///
/// 内存文件每秒都写（tmpfs，零磨损），闪存最多每 10 分钟写一次，
/// 把闪存寿命影响压到最低；代价是重启后最多回退 10 分钟的用量。
const FLASH_INTERVAL_SECS: i64 = 600;

/// 承载网卡探测的兜底名。
///
/// 与 init.d / rpcd ucode 的探测链保持一致：UCI 指定接口 → sysfs 上挂在
/// USB 总线上的网卡 → `network.MT5700M` 的 device → `eth2`。
const FALLBACK_NETDEV: &str = "eth2";

/// 使用量状态（落盘的 schema）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct UsageState {
    /// 累计下行字节数。
    pub total_rx: u64,
    /// 累计上行字节数。
    pub total_tx: u64,
    /// 上次采样时的接口计数器（基线）。
    pub last_rx: u64,
    pub last_tx: u64,
    /// 本次累计的起点（unix 秒）。
    pub start_ts: i64,
    /// 上次采样时刻（unix 秒）。
    pub last_ts: i64,
    /// 峰值下行速率（B/s）。
    pub peak_rx: u64,
    /// 峰值上行速率（B/s）。
    pub peak_tx: u64,
    /// 承载网卡名。
    #[serde(default)]
    pub device: String,
    /// 是否开启持久化（跨重启保留）。
    #[serde(default)]
    pub persist: bool,
    /// 上次写闪存的时刻（unix 秒），用于节流。
    #[serde(default)]
    pub last_flash: i64,
}

/// 读单个字节计数器；失败返回 `None`（不静默补 0，避免算出假增量）。
fn read_counter(path: &str) -> Option<u64> {
    let raw = std::fs::read_to_string(path).ok()?;
    raw.trim().parse::<u64>().ok()
}

/// 在 `/sys/class/net` 里找第一个挂在 USB 总线上的网卡。
///
/// 与 ucode 的 `detectUsbNetdev` 同口径：跳过 `lo` 与 `br-*`，要求存在
/// `device` 链接且其真实路径含 `usb`。
fn detect_usb_netdev() -> Option<String> {
    let entries = std::fs::read_dir("/sys/class/net").ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "lo" || name.starts_with("br-") {
            continue;
        }
        let device = entry.path().join("device");
        let Ok(real) = std::fs::canonicalize(&device) else { continue };
        if real.to_string_lossy().contains("usb") {
            return Some(name);
        }
    }
    None
}

/// 网卡是否存在且计数器可读。
fn netdev_usable(dev: &str) -> bool {
    !dev.is_empty()
        && std::path::Path::new(&format!("/sys/class/net/{dev}/statistics/rx_bytes")).exists()
}

/// 解析承载网卡名：UCI 指定接口 → USB 网卡 → `network.MT5700M` → `eth2`。
///
/// 只在启动时与「当前网卡读不到计数」时调用，不走热路径。
fn detect_netdev() -> String {
    // 1) UCI 显式指定了承载接口
    if let Ok(iface) = std::env::var("AT_WEBSERVER_IFACE_V4") {
        let iface = iface.trim().to_string();
        if !iface.is_empty() && iface != "auto" {
            if let Ok(dev) = std::process::Command::new("uci")
                .args(["-q", "get", &format!("network.{iface}.device")])
                .output()
            {
                let dev = String::from_utf8_lossy(&dev.stdout).trim().to_string();
                if netdev_usable(&dev) {
                    return dev;
                }
            }
        }
    }
    // 2) sysfs 上挂在 USB 总线上的网卡（承载的可能是固件自带的 wan）
    if let Some(dev) = detect_usb_netdev() {
        if netdev_usable(&dev) {
            return dev;
        }
    }
    // 3) MT5700M 接口的网卡
    if let Ok(out) = std::process::Command::new("uci")
        .args(["-q", "get", "network.MT5700M.device"])
        .output()
    {
        let dev = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if netdev_usable(&dev) {
            return dev;
        }
    }
    // 4) 兜底
    FALLBACK_NETDEV.to_string()
}

/// 从磁盘加载状态：优先内存文件（最新），缺失时回退持久化文件（重启后）。
///
/// 文件超限或解析失败都视为损坏：忽略并从零开始，绝不把来路不明的大文件
/// 读进内存。
fn load_state() -> UsageState {
    for path in [USAGE_VOL_PATH, USAGE_FLASH_PATH] {
        if let Ok(md) = std::fs::metadata(path) {
            if md.len() > MAX_USAGE_FILE_BYTES {
                log_warn!("使用量状态文件 {path} 超过 {} 字节上限，已忽略", MAX_USAGE_FILE_BYTES);
                continue;
            }
        }
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(st) = serde_json::from_str::<UsageState>(&text) {
                log_debug!("已从 {path} 恢复使用量状态");
                return st;
            }
        }
    }
    UsageState::default()
}

/// 序列化状态；超限时返回 `None`（宁可不写，也不写出异常大的文件）。
fn serialize_state(st: &UsageState) -> Option<String> {
    let text = serde_json::to_string(st).ok()?;
    if text.len() as u64 > MAX_USAGE_FILE_BYTES {
        log_warn!("使用量状态序列化后超过 {} 字节，本次不落盘", MAX_USAGE_FILE_BYTES);
        return None;
    }
    Some(text)
}

fn write_file(path: &str, body: &str) -> Result<(), String> {
    std::fs::write(path, body).map_err(|e| format!("写 {path} 失败: {e}"))
}

fn remove_file(path: &str) {
    if let Err(e) = std::fs::remove_file(path) {
        // 不存在即已删除，只有其它错误才值得记一笔
        if e.kind() != std::io::ErrorKind::NotFound {
            log_debug!("删除 {path} 失败: {e}");
        }
    }
}

/// 使用量后台统计器。
pub struct UsageTracker {
    state: Mutex<UsageState>,
    /// 自动清零日：每月几号（存 UCI，与使用量是否持久化解耦）。
    reset_day: AtomicU32,
    /// 已解析的承载网卡；读不到计数时重新探测。
    device: Mutex<Option<String>>,
}

impl UsageTracker {
    /// 创建统计器并从磁盘恢复状态。
    ///
    /// `reset_day` 为「每月几号清零」，非法值由 [`crate::monthly::normalize_day`] 夹取。
    pub fn new(reset_day: u32) -> Arc<UsageTracker> {
        Arc::new(UsageTracker {
            state: Mutex::new(load_state()),
            reset_day: AtomicU32::new(crate::monthly::normalize_day(reset_day)),
            device: Mutex::new(None),
        })
    }

    /// 常驻采样循环：与前端是否打开无关。
    pub async fn run(self: Arc<Self>, ctx: watch::Receiver<bool>) {
        let ctx_c = ctx;
        loop {
            if !crate::schedule::sleep_ctx(&ctx_c, SAMPLE_INTERVAL).await {
                return;
            }
            self.sample().await;
        }
    }

    /// 一次采样：读计数器 → 到期自动清零 → 累加 → 落盘。
    async fn sample(&self) {
        let (dev, rx, tx) = match self.read_counters().await {
            Some(v) => v,
            None => return,
        };
        let now = nettime::now_ts();

        let mut st = self.state.lock().await;
        // 到期自动清零：先清零再累加，清零时直接把基线设为当前计数，
        // 这样同一轮采样不会把清零前的流量又记回来。
        self.maybe_auto_reset(&mut st, rx, tx, now);
        accumulate(&mut st, &dev, rx, tx, now);
        let snapshot = st.clone();
        drop(st);

        self.persist(&snapshot, false).await;
    }

    /// 读计数器；网卡变更或读不到时重新探测。
    async fn read_counters(&self) -> Option<(String, u64, u64)> {
        let mut cached = self.device.lock().await;
        let mut dev = cached.clone().unwrap_or_default();
        if !netdev_usable(&dev) {
            dev = detect_netdev();
            *cached = Some(dev.clone());
            log_info!("使用量统计承载网卡: {dev}");
        }
        drop(cached);

        let base = format!("/sys/class/net/{dev}/statistics");
        let rx = read_counter(&format!("{base}/rx_bytes"));
        let tx = read_counter(&format!("{base}/tx_bytes"));
        match (rx, tx) {
            (Some(rx), Some(tx)) => Some((dev, rx, tx)),
            _ => {
                // 网卡消失了（接口 down / 换了口）：清掉缓存让下一轮重新探测
                let mut cached = self.device.lock().await;
                *cached = None;
                drop(cached);
                log_debug!("读不到 {dev} 的计数器，下轮重新探测承载网卡");
                None
            }
        }
    }

    /// 到「每月几号」则自动清零。
    ///
    /// 判定本身在 [`crate::monthly`]：以 `start_ts` 之后的第一个清零时刻（本地时区
    /// 目标日 00:00）与当下比较，天然做到一月只清一次、跨大小月/跨年都对齐；
    /// 31 号这类「小月不存在」的日子按当月月末触发，不会整月漏清。
    fn maybe_auto_reset(&self, st: &mut UsageState, rx: u64, tx: u64, now: i64) {
        let day = self.reset_day.load(Ordering::Relaxed);
        if !crate::monthly::should_reset(now, st.start_ts, day, localtime::offset()) {
            return;
        }
        st.total_rx = 0;
        st.total_tx = 0;
        st.peak_rx = 0;
        st.peak_tx = 0;
        st.start_ts = now;
        st.last_ts = now;
        st.last_rx = rx;
        st.last_tx = tx;
        log_info!("本次使用量已自动清零（{}）", crate::monthly::describe(day));
    }

    /// 落盘：内存文件每次都写；闪存按节流写，`force` 时强制。
    ///
    /// `force` 用于清零 / 切换持久化这类「必须立刻反映到文件」的操作。
    async fn persist(&self, st: &UsageState, force: bool) {
        let Some(body) = serialize_state(st) else { return };
        let now = nettime::now_ts();
        let want_flash = st.persist;
        let due = force || now - st.last_flash >= FLASH_INTERVAL_SECS;

        let mut to_write: Vec<(String, String)> = Vec::new();
        to_write.push((USAGE_VOL_PATH.to_string(), body.clone()));
        let mut to_remove: Vec<String> = Vec::new();
        if want_flash && due {
            to_write.push((USAGE_FLASH_PATH.to_string(), body));
        } else if !want_flash && force {
            // 关闭持久化：删掉落盘文件，避免残留旧值被下次重启读回来
            to_remove.push(USAGE_FLASH_PATH.to_string());
        }

        let result = tokio::task::spawn_blocking(move || {
            let mut first_err = None;
            for (path, body) in to_write {
                if let Err(e) = write_file(&path, &body) {
                    if first_err.is_none() {
                        first_err = Some(e);
                    }
                }
            }
            for path in to_remove {
                remove_file(&path);
            }
            first_err
        })
        .await
        .unwrap_or(None);

        if let Some(e) = result {
            log_warn!("使用量状态落盘失败: {e}");
            return;
        }

        // 闪存写完要回写时间戳，否则下一轮又会判定「到期」再写一次
        if want_flash && due {
            let mut cur = self.state.lock().await;
            if cur.last_flash != now {
                cur.last_flash = now;
                let snapshot = cur.clone();
                drop(cur);
                let Some(body) = serialize_state(&snapshot) else { return };
                let _ = tokio::task::spawn_blocking(move || write_file(USAGE_VOL_PATH, &body)).await;
            }
        }
    }

    /// 读取当前快照（供 RPC 返回）。
    pub async fn snapshot(&self) -> UsageSnapshot {
        let st = self.state.lock().await.clone();
        let now = nettime::now_ts();
        UsageSnapshot {
            total_rx: st.total_rx,
            total_tx: st.total_tx,
            peak_rx: st.peak_rx,
            peak_tx: st.peak_tx,
            device: st.device,
            start_ts: st.start_ts,
            last_ts: st.last_ts,
            now_ts: now,
            persist: st.persist,
            reset_day: self.reset_day.load(Ordering::Relaxed),
            time_source: nettime::source_name().to_string(),
        }
    }

    /// 清零：无论持久化开关状态如何，都强制重写/删除文件。
    ///
    /// 持久化开着时把落盘文件一并清零（而不是只清内存），否则重启后旧值会回来。
    pub async fn reset(&self) -> UsageSnapshot {
        let now = nettime::now_ts();
        let (dev, rx, tx) = self.read_counters().await.unwrap_or((String::new(), 0, 0));
        let mut st = self.state.lock().await;
        st.total_rx = 0;
        st.total_tx = 0;
        st.peak_rx = 0;
        st.peak_tx = 0;
        st.start_ts = now;
        st.last_ts = now;
        if !dev.is_empty() {
            st.device = dev;
            st.last_rx = rx;
            st.last_tx = tx;
        }
        let snapshot = st.clone();
        drop(st);
        self.persist(&snapshot, true).await;
        log_info!("本次使用量已手动清零");
        self.snapshot().await
    }

    /// 切换持久化。
    pub async fn set_persist(&self, on: bool) -> UsageSnapshot {
        {
            let mut st = self.state.lock().await;
            st.persist = on;
        }
        let st = self.state.lock().await.clone();
        self.persist(&st, true).await;
        log_info!("使用量持久化已{}", if on { "开启" } else { "关闭" });
        self.snapshot().await
    }

    /// 修改自动清零日（每月几号）：写 UCI（跨重启生效）+ 热更新内存值。
    pub async fn set_reset_day(&self, day: u32) -> Result<u32, String> {
        let day = crate::monthly::normalize_day(day);
        let arg = format!("at-webserver.config.usage_reset_day={day}");
        let out = tokio::process::Command::new("uci")
            .args(["set", &arg])
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("写入 usage_reset_day 失败: {}", String::from_utf8_lossy(&out.stderr)));
        }
        let out = tokio::process::Command::new("uci")
            .args(["commit", "at-webserver"])
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("提交配置失败: {}", String::from_utf8_lossy(&out.stderr)));
        }
        self.reset_day.store(day, Ordering::Relaxed);
        log_info!("使用量自动清零已改为 {}", crate::monthly::describe(day));
        Ok(day)
    }
}

/// 一次累加：只认正向增量，负增量（计数器归零）只重置基线。
fn accumulate(st: &mut UsageState, dev: &str, rx: u64, tx: u64, now: i64) {
    if st.device != dev {
        // 承载网卡变了：重新基线，累计值保留
        log_debug!("使用量统计承载网卡由 {} 变为 {dev}", st.device);
        st.device = dev.to_string();
        st.last_rx = rx;
        st.last_tx = tx;
        st.last_ts = now;
        if st.start_ts <= 0 {
            st.start_ts = now;
        }
        return;
    }
    if st.last_ts <= 0 {
        // 首次采样：只建立基线，不累加
        st.last_rx = rx;
        st.last_tx = tx;
        st.last_ts = now;
        st.start_ts = now;
        return;
    }

    // 用 i128 判别负增量：u64 相减会回绕成一个巨大正数，反而会被当成巨额流量
    let drx = rx as i128 - st.last_rx as i128;
    let dtx = tx as i128 - st.last_tx as i128;
    if drx < 0 || dtx < 0 {
        // 计数器归零（接口 flap / 重新拨号）：只重置基线，不累加
        log_debug!("接口计数器归零（rx {drx} / tx {dtx}），已重置基线，不累加本次");
        st.last_rx = rx;
        st.last_tx = tx;
        st.last_ts = now;
        return;
    }

    st.total_rx += drx as u64;
    st.total_tx += dtx as u64;

    let dt = (now - st.last_ts).max(0);
    // 峰值只在正常节拍内算：进程被阻塞很久后补算的增量除以大 dt 是低均值，
    // 拿来当峰值会污染统计。
    if (1..=5).contains(&dt) {
        let rate_rx = (drx as u64) / dt as u64;
        let rate_tx = (dtx as u64) / dt as u64;
        if rate_rx > st.peak_rx {
            st.peak_rx = rate_rx;
        }
        if rate_tx > st.peak_tx {
            st.peak_tx = rate_tx;
        }
    }

    st.last_rx = rx;
    st.last_tx = tx;
    st.last_ts = now;
}

/// 返回给前端的快照（比落盘状态多带一个当前时刻，便于前端算时长）。
#[derive(Debug, Clone, Serialize)]
pub struct UsageSnapshot {
    pub total_rx: u64,
    pub total_tx: u64,
    pub peak_rx: u64,
    pub peak_tx: u64,
    pub device: String,
    pub start_ts: i64,
    pub last_ts: i64,
    pub now_ts: i64,
    pub persist: bool,
    /// 自动清零日（每月几号，1~31）。
    pub reset_day: u32,
    /// 时刻来源（`NTP` / `设备时钟`）：按日历清零强依赖时钟准确度，
    /// 回退到设备时钟时在日志页能一眼看出「日期可能不准」。
    pub time_source: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn base() -> UsageState {
        UsageState {
            device: "eth2".into(),
            last_rx: 1000,
            last_tx: 500,
            last_ts: 100,
            start_ts: 100,
            ..UsageState::default()
        }
    }

    #[test]
    fn accumulate_adds_positive_delta() {
        let mut st = base();
        accumulate(&mut st, "eth2", 1500, 900, 101);
        assert_eq!(st.total_rx, 500);
        assert_eq!(st.total_tx, 400);
        assert_eq!(st.last_rx, 1500);
        assert_eq!(st.last_ts, 101);
    }

    #[test]
    fn counter_reset_is_not_counted_as_huge_traffic() {
        // 接口 flap：计数器归零，drx/dtx 为负 → 只重置基线，不累加
        let mut st = base();
        accumulate(&mut st, "eth2", 10, 20, 101);
        assert_eq!(st.total_rx, 0, "归零不能被记成巨额流量");
        assert_eq!(st.total_tx, 0);
        assert_eq!(st.last_rx, 10);
    }

    #[test]
    fn device_change_rebaselines_but_keeps_totals() {
        let mut st = base();
        st.total_rx = 777;
        accumulate(&mut st, "usb0", 5, 5, 101);
        assert_eq!(st.total_rx, 777, "换网卡不该丢掉已累计的用量");
        assert_eq!(st.device, "usb0");
        assert_eq!(st.last_rx, 5);
    }

    #[test]
    fn first_sample_only_establishes_baseline() {
        let mut st = UsageState::default();
        accumulate(&mut st, "eth2", 12345, 6789, 100);
        assert_eq!(st.total_rx, 0);
        assert_eq!(st.total_tx, 0);
        assert_eq!(st.last_rx, 12345);
        assert_eq!(st.start_ts, 100);
    }

    #[test]
    fn peak_only_computed_within_normal_beat() {
        let mut st = base();
        // dt=1：1000 B/s 记为峰值
        accumulate(&mut st, "eth2", 2000, 500, 101);
        assert_eq!(st.peak_rx, 1000);
        // dt 过大（进程被阻塞后补算）：不当成峰值
        let mut st2 = base();
        st2.last_ts = 100;
        accumulate(&mut st2, "eth2", 1_000_100, 500, 200);
        assert_eq!(st2.peak_rx, 0, "长时间间隔补算的低均值不能当峰值");
        assert_eq!(st2.total_rx, 999_100, "但用量仍要如实累加");
    }

    #[test]
    fn oversized_state_file_is_rejected() {
        // 超限文件一律视为损坏，不被读进内存（由 load_state 把关）
        let mut st = base();
        st.device = "x".repeat(MAX_USAGE_FILE_BYTES as usize);
        assert!(serialize_state(&st).is_none(), "超限状态不该被序列化");
    }

    #[test]
    fn normal_state_serializes_within_limit() {
        let st = base();
        let text = serialize_state(&st).expect("正常状态应可序列化");
        assert!(text.len() as u64 <= MAX_USAGE_FILE_BYTES);
        // 往返无损
        let back: UsageState = serde_json::from_str(&text).unwrap();
        assert_eq!(back, st);
    }

    #[test]
    fn default_reset_day_is_first_of_month() {
        // 默认「每月 1 号」而不是滚动天数：与月度对账口径一致
        assert_eq!(crate::monthly::DEFAULT_RESET_DAY, 1);
    }

    #[test]
    fn monthly_reset_clears_totals_and_rebaselines() {
        // 起点 1 月 5 日，设定每月 1 号 → 到 2 月 1 日 00:00 应清零
        let off = localtime::offset();
        let start = off.with_ymd_and_hms(2026, 1, 5, 9, 0, 0).unwrap().timestamp();
        let target = off.with_ymd_and_hms(2026, 2, 1, 0, 0, 0).unwrap().timestamp();
        assert!(crate::monthly::should_reset(target, start, 1, off));
    }
}
