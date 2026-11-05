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
//! # 统计来源（可手动切换）
//!
//! `at-webserver.config.usage_source` 决定累计用量的取值口径：
//!
//! | 取值 | 数据源 | AT 通道代价 |
//! |:--|:--|:--|
//! | `netdev`（默认） | WAN 区域模组物理网口的 `/sys/class/net/<dev>/statistics/{rx,tx}_bytes` | 零 |
//! | `modem` | 模组 `AT^DSFLOWQRY` 上报的 DS 累计收发字节 | 走已存在的状态缓存（2s 刷新） |
//!
//! 来源切换会改变 `device` 标签，[`accumulate`] 的「承载变了」分支会自动
//! 重新基线：累计值保留、不把两套计数器的差值误记成一笔巨额流量。
//!
//! # 统计网卡口径
//!
//! 只认 **WAN 防火墙区域**里的物理网口，自动识别模组创建的 WAN 口，
//! 不写死任何网卡名；显式排除 `br-lan` 及其 VLAN 子接口、`lo` 与 LAN 区域网卡。
//! 取不到可用 WAN 网卡时**停止采样**（累计值保留），绝不回退 LAN 侧计数器。
//!
//! # 边界处理
//!
//! - 计数器归零（接口 flap / 重新拨号）表现为负增量：**只重置基线、不累加**，
//!   避免把一次归零误记成一笔巨额流量。
//! - 承载网卡变了（模组接口的物理绑定改动 / 模组换了网口）：同样只重置基线，累计值保留。
//! - 峰值只在正常采样节拍内计算；采样间隔异常拉长（进程被阻塞）时跳过，
//!   免得把一段长时间的低均值当成峰值。

use crate::localtime;
use crate::nettime;
use crate::{log_debug, log_info, log_warn};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{watch, Mutex, RwLock};

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

/// 模组来源的采样间隔：与 `AT^DSFLOWQRY` 状态缓存的 2s 刷新周期对齐。
///
/// 若仍按 1s 采样，缓存未刷新的那一秒读到的还是旧值，速率会呈现
/// 「一秒全额、一秒为零」的锯齿，峰值被算成实际的约两倍。
const MODEM_SAMPLE_INTERVAL: Duration = Duration::from_secs(2);

/// 持久化落盘的最小间隔（秒）。
///
/// 内存文件每秒都写（tmpfs，零磨损），闪存最多每 10 分钟写一次，
/// 把闪存寿命影响压到最低；代价是重启后最多回退 10 分钟的用量。
const FLASH_INTERVAL_SECS: i64 = 600;

/// 统计来源：WAN 区域物理网口的 sysfs 计数器（默认，零 AT 负担）。
pub const SOURCE_NETDEV: &str = "netdev";
/// 统计来源：模组 `AT^DSFLOWQRY` 上报的 DS 累计流量。
pub const SOURCE_MODEM: &str = "modem";
/// 模组来源下返回给前端的 `device` 标签（不含具体网卡名）。
const MODEM_DEVICE_LABEL: &str = "modem:^DSFLOWQRY";
/// 模组 DS 累计流量查询指令（已在 `state_cfg` 的缓存白名单里，2s 刷新）。
const DSFLOWQRY_CMD: &str = "AT^DSFLOWQRY";

/// UCI 取值归一化：只接受 `netdev` / `modem`，其它一律回落默认。
pub fn normalize_usage_source(raw: &str) -> &'static str {
    if raw.trim() == SOURCE_MODEM { SOURCE_MODEM } else { SOURCE_NETDEV }
}

/// WAN 防火墙区域解析不到时的兜底逻辑接口名（不是物理网卡名）。
///
/// 只列明确的 WAN 侧逻辑接口；任何情况下都不允许回落到 LAN / `br-lan`：
/// `br-lan` 承载 LAN 桥接与 Wi-Fi 互传流量，实机其上行计数器可达
/// 200 GB 以上，计入后会把蜂窝用量放大一到两个数量级。
const FALLBACK_WAN_IFACES: &[&str] = &["MT5700M", "MT5700Mv6", "wan", "wan6"];

/// LAN 侧硬排除项与 VLAN 子接口前缀。
const LAN_EXCLUDED: &[&str] = &["lo", "br-lan"];
const LAN_EXCLUDED_PREFIXES: &[&str] = &["br-lan."];

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

/// 网卡是否存在且计数器可读。
fn netdev_usable(dev: &str) -> bool {
    !dev.is_empty()
        && std::path::Path::new(&format!("/sys/class/net/{dev}/statistics/rx_bytes")).exists()
}

/// 解析 `uci show` 取值：标量 `'eth2'`、列表 `'a' 'b'` 都还原成逐项 token。
///
/// 这一层是纯字符串处理，与平台无关，可在 Windows / macOS 上直接跑单测；
/// 真正读 sysfs 的部分只在 OpenWrt 设备侧调用。
fn uci_values(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = raw
        .split('\'')
        .enumerate()
        .filter(|(i, _)| i % 2 == 1)
        .map(|(_, s)| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if out.is_empty() {
        // 少数版本对标量值不带引号，按空白取首项即可
        if let Some(v) = raw.split_whitespace().next() {
            out.push(v.to_string());
        }
    }
    out
}

/// `section -> option -> values`，由一次 `uci show <pkg>` 的输出解析而来。
type UciShow = std::collections::HashMap<String, std::collections::HashMap<String, Vec<String>>>;

fn parse_uci_show(text: &str) -> UciShow {
    let mut out = UciShow::new();
    for line in text.lines() {
        let Some((key, raw)) = line.split_once('=') else {
            continue;
        };
        let mut parts = key.splitn(3, '.');
        let (Some(_pkg), Some(section), Some(option)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        out.entry(section.to_string())
            .or_default()
            .insert(option.to_string(), uci_values(raw));
    }
    out
}

/// 取指定防火墙区域（`wan` / `lan`）登记的逻辑接口名，顺序稳定。
fn zone_ifaces(cfg: &UciShow, zone: &str) -> Vec<String> {
    let mut sections: Vec<&String> = cfg
        .iter()
        .filter(|(_, opts)| {
            opts.get("name")
                .and_then(|v| v.first())
                .map(|s| s.as_str())
                == Some(zone)
        })
        .map(|(sec, _)| sec)
        .collect();
    // HashMap 迭代顺序不稳定，按 section 名排序以保证结果可复现
    sections.sort();

    let mut out = Vec::new();
    for sec in sections {
        if let Some(list) = cfg.get(sec).and_then(|o| o.get("network")) {
            for name in list {
                if !out.contains(name) {
                    out.push(name.clone());
                }
            }
        }
    }
    out
}

/// 逻辑接口 → 物理网卡；`@alias` 递归解析（最多 4 层，防配置成环）。
fn resolve_netdev(iface: &str, net: &UciShow) -> Option<String> {
    let mut cur = iface.to_string();
    for _ in 0..4 {
        let opts = net.get(&cur)?;
        let dev = opts
            .get("device")
            .or_else(|| opts.get("ifname"))
            .and_then(|v| v.first())?;
        if let Some(alias) = dev.strip_prefix('@') {
            cur = alias.to_string();
            continue;
        }
        return Some(dev.clone());
    }
    None
}

/// LAN 侧网卡判定：硬排除 `br-lan` / VLAN 子接口 / `lo`，以及 LAN 区域解析出的网卡。
fn is_lan_side(dev: &str, lan_devs: &std::collections::HashSet<String>) -> bool {
    dev.is_empty()
        || LAN_EXCLUDED.contains(&dev)
        || LAN_EXCLUDED_PREFIXES.iter().any(|p| dev.starts_with(p))
        || lan_devs.contains(dev)
}

/// 挂在 USB 总线上的模组网卡（口径与 init.d 的 `detect_usb_netdev` 一致）。
///
/// 只判定「是不是 USB 网卡」，不假定任何具体网卡名。
fn usb_netdev() -> Option<String> {
    let mut names: Vec<String> = std::fs::read_dir("/sys/class/net")
        .ok()?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != "lo" && !n.starts_with("br-"))
        .collect();
    names.sort();
    names.into_iter().find(|name| {
        std::fs::canonicalize(format!("/sys/class/net/{name}/device"))
            .map(|p| p.to_string_lossy().contains("usb"))
            .unwrap_or(false)
    })
}

/// 网卡是否被「非 LAN 区域」的 network 接口绑定。
///
/// 只在「WAN 区域候选全无」的兜底路径里，用来确认 USB 网卡确实位于 WAN 侧。
fn bound_outside_lan(netdev: &str, net: &UciShow, lan_ifaces: &[String]) -> bool {
    net.iter().any(|(section, opts)| {
        if lan_ifaces.contains(section) {
            return false;
        }
        opts.get("device")
            .or_else(|| opts.get("ifname"))
            .map(|v| v.iter().any(|d| d == netdev))
            .unwrap_or(false)
    })
}

/// 选出流量统计用的唯一物理网卡：**只认 WAN 区域，绝不回退 LAN / br-lan**。
///
/// 纯逻辑实现，UCI 文本 / USB 网卡 / 可用性判定全部由调用方注入，
/// 因此在 Windows / macOS 上也能完整跑单测；设备侧入口是 [`wan_netdev`]。
/// 选择顺序：
/// 1. WAN 区域成员 ∩ USB 模组网口 → 模组创建的 WAN 口；
/// 2. 模组网口未命中时，取 WAN 区域里第一个非 LAN 侧的可用物理网口；
/// 3. WAN 区域候选全无时，仍只接受「非 LAN 归属的 USB 网卡」；
/// 4. 以上全失败返回 None —— 停止统计，累计值保留，不把 LAN 流量算进来。
fn select_wan_netdev(
    fw_text: &str,
    net_text: &str,
    usb: Option<&str>,
    usable: impl Fn(&str) -> bool,
) -> Option<String> {
    let fw = parse_uci_show(fw_text);
    let net = parse_uci_show(net_text);

    let lan_ifaces = zone_ifaces(&fw, "lan");
    let lan_devs: std::collections::HashSet<String> = lan_ifaces
        .iter()
        .filter_map(|i| resolve_netdev(i, &net))
        .collect();

    let mut wan_ifaces = zone_ifaces(&fw, "wan");
    if wan_ifaces.is_empty() {
        wan_ifaces = FALLBACK_WAN_IFACES.iter().map(|s| s.to_string()).collect();
    }

    let mut candidates: Vec<String> = Vec::new();
    for iface in &wan_ifaces {
        let Some(dev) = resolve_netdev(iface, &net) else {
            continue;
        };
        if is_lan_side(&dev, &lan_devs) || !usable(&dev) || candidates.contains(&dev) {
            continue;
        }
        candidates.push(dev);
    }

    // 1) 模组创建的 WAN 口：WAN 区域 ∩ USB 网卡
    if let Some(usb_dev) = usb {
        if candidates.iter().any(|d| d == usb_dev) {
            return Some(usb_dev.to_string());
        }
    }
    // 2) 默认 WAN 口所在的物理网卡：设备上没有模组专用 WAN 口可用时，
    //    按 `network.wan` 反查出的物理网卡统计，仍绝不回退 LAN。
    //    仅当 wan 逻辑接口确实属于 WAN 区域时才采用，避免把被挪到
    //    其它区域的接口误当成 WAN 出口。
    if wan_ifaces.iter().any(|i| i == "wan") {
        if let Some(dev) = resolve_netdev("wan", &net) {
            if !is_lan_side(&dev, &lan_devs) && usable(&dev) {
                return Some(dev);
            }
        }
    }
    // 3) WAN 区域内的其它物理网口（仍排除 LAN 侧与 br-lan）
    if let Some(dev) = candidates.first() {
        return Some(dev.clone());
    }
    // 4) 候选全无：只接受非 LAN 归属的 USB 网卡
    if let Some(usb_dev) = usb {
        if !is_lan_side(usb_dev, &lan_devs)
            && usable(usb_dev)
            && bound_outside_lan(usb_dev, &net, &lan_ifaces)
        {
            return Some(usb_dev.to_string());
        }
    }
    None
}

/// 一次 `uci show <pkg>`；比旧实现逐个 `uci get` 起子进程更省。
fn uci_show(pkg: &str) -> String {
    std::process::Command::new("uci")
        .args(["-q", "show", pkg])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

/// 写一项 UCI 配置并提交；内存态的热更新由各调用方自己做。
async fn uci_set_config(key: &str, value: &str) -> Result<(), String> {
    let arg = format!("{key}={value}");
    let out = tokio::process::Command::new("uci")
        .args(["set", &arg])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("写入 {key} 失败: {}", String::from_utf8_lossy(&out.stderr)));
    }
    let out = tokio::process::Command::new("uci")
        .args(["commit", "at-webserver"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("提交配置失败: {}", String::from_utf8_lossy(&out.stderr)));
    }
    Ok(())
}

/// 设备侧入口：每次采样重新解析，用户改动接口绑定后下一轮即生效。
fn wan_netdev() -> Option<String> {
    let usb = usb_netdev();
    select_wan_netdev(
        &uci_show("firewall"),
        &uci_show("network"),
        usb.as_deref(),
        netdev_usable,
    )
}

/// 解析 `^DSFLOWQRY` 应答，取 DS 累计接收 / 发送字节数。
///
/// 手册 16.12：`^DSFLOWQRY: <last_ds_time>,<last_tx_flow>,<last_rx_flow>,
/// <total_ds_time>,<total_tx_flow>,<total_rx_flow>`，流量字段是 **16 位十六进制**，
/// 单位为字节。应答可能被拆成多行（含手册示例里的数值折行），因此把
/// `^DSFLOWQRY:` 之后到终止行之前的文本无分隔拼接后再按逗号切分。
pub fn parse_dsflowqry(text: &str) -> Option<(u64, u64)> {
    const TAG: &str = "^DSFLOWQRY:";
    let mut joined = String::new();
    let mut found = false;
    for line in text.lines() {
        let line = line.trim();
        if let Some(pos) = line.find(TAG) {
            found = true;
            joined.push_str(line[pos + TAG.len()..].trim());
            continue;
        }
        if !found {
            continue;
        }
        let upper = line.to_ascii_uppercase();
        if line == "OK" || upper.contains("ERROR") || line.starts_with('+') {
            break;
        }
        joined.push_str(line);
    }
    if !found {
        return None;
    }
    let parts: Vec<&str> = joined.split(',').collect();
    if parts.len() < 6 {
        return None;
    }
    let total_tx = u64::from_str_radix(parts[4].trim(), 16).ok()?;
    let total_rx = u64::from_str_radix(parts[5].trim(), 16).ok()?;
    Some((total_rx, total_tx))
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
    /// 统计来源（`netdev` / `modem`），可由前端热切换。
    source: RwLock<String>,
    /// 模组来源取数用的异步状态缓存；`netdev` 来源下完全不触碰。
    cache: Option<Arc<crate::state::StateCache>>,
}

impl UsageTracker {
    /// 创建统计器并从磁盘恢复状态。
    ///
    /// `reset_day` 为「每月几号清零」，非法值由 [`crate::monthly::normalize_day`] 夹取；
    /// `source` 由 [`normalize_usage_source`] 归一化，非法值一律回落 `netdev`。
    pub fn new(
        reset_day: u32,
        source: &str,
        cache: Arc<crate::state::StateCache>,
    ) -> Arc<UsageTracker> {
        Arc::new(UsageTracker {
            state: Mutex::new(load_state()),
            reset_day: AtomicU32::new(crate::monthly::normalize_day(reset_day)),
            source: RwLock::new(normalize_usage_source(source).to_string()),
            cache: Some(cache),
        })
    }

    /// 常驻采样循环：与前端是否打开无关。
    pub async fn run(self: Arc<Self>, ctx: watch::Receiver<bool>) {
        let ctx_c = ctx;
        loop {
            let interval = if *self.source.read().await == *SOURCE_MODEM {
                MODEM_SAMPLE_INTERVAL
            } else {
                SAMPLE_INTERVAL
            };
            if !crate::schedule::sleep_ctx(&ctx_c, interval).await {
                return;
            }
            self.sample().await;
        }
    }

    /// 一次采样：读计数器 → 到期自动清零 → 累加 → 落盘。
    async fn sample(&self) {
        let (dev, rx, tx) = match self.counters().await {
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

    /// 当前来源下的计数器快照；后端 `netrate` RPC 与采样循环共用。
    ///
    /// 返回 `(device 标签, 累计 rx, 累计 tx)`；取不到时返回 None，
    /// 调用方必须停止累加，绝不能用另一套计数器顶替。
    pub async fn counters(&self) -> Option<(String, u64, u64)> {
        let source = self.source.read().await.clone();
        if source == SOURCE_MODEM {
            self.read_counters_modem().await
        } else {
            self.read_counters_netdev().await
        }
    }

    /// 物理网卡来源：只认 WAN 区域自动识别出的模组网口。
    async fn read_counters_netdev(&self) -> Option<(String, u64, u64)> {
        let dev = match wan_netdev() {
            Some(d) => d,
            None => {
                log_debug!("未识别到 WAN 区域网卡，本轮不采样（不回退 LAN/br-lan）");
                return None;
            }
        };
        let base = format!("/sys/class/net/{dev}/statistics");
        let rx = read_counter(&format!("{base}/rx_bytes"));
        let tx = read_counter(&format!("{base}/tx_bytes"));
        match (rx, tx) {
            (Some(rx), Some(tx)) => Some((dev, rx, tx)),
            _ => {
                log_debug!("读不到 WAN 网卡 {dev} 的计数器，下轮重新解析");
                None
            }
        }
    }

    /// 模组来源：`AT^DSFLOWQRY` 的 DS 累计值，走已有的异步状态缓存。
    ///
    /// 该指令本来就在缓存白名单里（2s 刷新），这里只是读缓存，
    /// 不额外增加 AT 通道压力；缓存拿不到就跳过本轮，不补 0。
    async fn read_counters_modem(&self) -> Option<(String, u64, u64)> {
        let cache = self.cache.as_ref()?;
        let text = cache.resolve(DSFLOWQRY_CMD).await.ok().flatten()?;
        let (rx, tx) = parse_dsflowqry(&text)?;
        Some((MODEM_DEVICE_LABEL.to_string(), rx, tx))
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
            source: self.source.read().await.clone(),
        }
    }

    /// 清零：无论持久化开关状态如何，都强制重写/删除文件。
    ///
    /// 持久化开着时把落盘文件一并清零（而不是只清内存），否则重启后旧值会回来。
    pub async fn reset(&self) -> UsageSnapshot {
        let now = nettime::now_ts();
        let (dev, rx, tx) = self.counters().await.unwrap_or((String::new(), 0, 0));
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
        uci_set_config("at-webserver.config.usage_reset_day", &day.to_string()).await?;
        self.reset_day.store(day, Ordering::Relaxed);
        log_info!("使用量自动清零已改为 {}", crate::monthly::describe(day));
        Ok(day)
    }

    /// 切换统计来源：写 UCI（跨重启生效）+ 热更新内存值。
    ///
    /// 只接受 `netdev` / `modem`；切换后 `device` 标签随之改变，
    /// [`accumulate`] 会自动重新基线，累计值保留，不会把两套计数器的
    /// 绝对差值误记成流量。
    pub async fn set_source(&self, raw: &str) -> Result<UsageSnapshot, String> {
        let source = normalize_usage_source(raw);
        if source == SOURCE_MODEM && self.cache.is_none() {
            return Err("模组数据来源不可用（状态缓存未初始化）".into());
        }
        uci_set_config("at-webserver.config.usage_source", source).await?;
        *self.source.write().await = source.to_string();
        log_info!("使用量统计来源已切换为 {}", if source == SOURCE_MODEM { "模组 AT^DSFLOWQRY" } else { "WAN 物理网卡" });
        Ok(self.snapshot().await)
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
    /// 当前统计来源（`netdev` / `modem`）。
    pub source: String,
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

    /// 实机拓扑：WAN zone = MT5700M / MT5700Mv6 / wan / wan6，LAN zone = lan(br-lan)。
    fn real_world_fw() -> &'static str {
        "firewall.@zone[0]=zone\n\
         firewall.@zone[0].name='lan'\n\
         firewall.@zone[0].network='lan'\n\
         firewall.@zone[1]=zone\n\
         firewall.@zone[1].name='wan'\n\
         firewall.@zone[1].network='MT5700M' 'MT5700Mv6' 'wan' 'wan6'\n"
    }
    fn real_world_net() -> &'static str {
        "network.lan=interface\n\
         network.lan.device='br-lan'\n\
         network.wan=interface\n\
         network.wan.device='eth1'\n\
         network.wan6=interface\n\
         network.wan6.device='@wan'\n\
         network.MT5700M=interface\n\
         network.MT5700M.device='eth2'\n\
         network.MT5700Mv6=interface\n\
         network.MT5700Mv6.device='@MT5700M'\n"
    }
    fn all_usable(_: &str) -> bool { true }

    #[test]
    fn selects_usb_modem_wan_port_without_hardcoded_name() {
        assert_eq!(
            select_wan_netdev(real_world_fw(), real_world_net(), Some("eth2"), all_usable),
            Some("eth2".into())
        );
    }

    #[test]
    fn no_other_modem_wan_port_selects_default_wan_physical_dev() {
        // 模组 USB 网口未枚举：优先按默认 WAN 口 network.wan 反查物理网卡，
        // 而不是继续沿用某个残留的模组绑定，也绝不退回 br-lan。
        assert_eq!(
            select_wan_netdev(real_world_fw(), real_world_net(), None, all_usable),
            Some("eth1".into()),
            "无模组 WAN 口时应选默认 WAN 口的物理网卡"
        );

        // 只有默认 wan/wan6、完全没有模组专用接口的设备同样命中该判据。
        let fw = "firewall.@zone[0].name='wan'\nfirewall.@zone[0].network='wan' 'wan6'\n\
                  firewall.@zone[1].name='lan'\nfirewall.@zone[1].network='lan'\n";
        assert_eq!(
            select_wan_netdev(fw, real_world_net(), None, all_usable),
            Some("eth1".into())
        );
    }

    #[test]
    fn default_wan_dev_is_ignored_when_wan_is_not_in_wan_zone() {
        // wan 逻辑接口被挪出 WAN 区域时，不能仅凭名字把它当 WAN 出口；
        // 此时仍应回到 WAN 区域成员 / USB 回落判据。
        let fw = "firewall.@zone[0].name='wan'\nfirewall.@zone[0].network='wwan'\n\
                  firewall.@zone[1].name='lan'\nfirewall.@zone[1].network='lan'\n";
        let net = "network.wan.device='eth1'\nnetwork.wwan.device='br-lan'\n\
                   network.lan.device='br-lan'\n";
        assert_eq!(select_wan_netdev(fw, net, None, all_usable), None);
    }

    #[test]
    fn br_lan_and_lan_zone_devices_are_never_selected() {
        let fw = "firewall.@zone[0].name='wan'\nfirewall.@zone[0].network='badwan'\n\
                  firewall.@zone[1].name='lan'\nfirewall.@zone[1].network='lan'\n";
        let net = "network.badwan.device='br-lan'\nnetwork.lan.device='br-lan'\n";
        assert_eq!(select_wan_netdev(fw, net, Some("br-lan"), all_usable), None);
        // VLAN 子接口同样排除
        let net2 = "network.badwan.device='br-lan.10'\nnetwork.lan.device='br-lan'\n";
        assert_eq!(select_wan_netdev(fw, net2, None, all_usable), None);
    }

    #[test]
    fn lan_zone_physical_port_is_excluded_even_if_listed_in_wan_zone() {
        let fw = "firewall.@zone[0].name='wan'\nfirewall.@zone[0].network='wan'\n\
                  firewall.@zone[1].name='lan'\nfirewall.@zone[1].network='lan'\n";
        let net = "network.wan.device='eth0'\nnetwork.lan.device='eth0'\n";
        assert_eq!(select_wan_netdev(fw, net, None, all_usable), None);
    }

    #[test]
    fn no_wan_zone_uses_wan_iface_whitelist_not_lan() {
        assert_eq!(
            select_wan_netdev("", real_world_net(), Some("eth2"), all_usable),
            Some("eth2".into())
        );
        assert_eq!(
            select_wan_netdev("", "network.lan.device='br-lan'\n", None, all_usable),
            None,
            "firewall 读不到时也不能掉到 LAN 网桥"
        );
    }

    #[test]
    fn all_candidates_empty_falls_back_to_wan_bound_usb_netdev() {
        // 「全无」：firewall 无 zone、白名单接口也不存在，但 USB 网卡被非 LAN 接口绑定
        let net = "network.wwan=interface\nnetwork.wwan.device='usb0'\n";
        assert_eq!(
            select_wan_netdev("", net, Some("usb0"), all_usable),
            Some("usb0".into())
        );
    }

    #[test]
    fn usb_netdev_bound_only_to_lan_is_rejected() {
        let fw = "firewall.@zone[0].name='lan'\nfirewall.@zone[0].network='lan'\n";
        let net = "network.lan.device='usb0'\n";
        assert_eq!(select_wan_netdev(fw, net, Some("usb0"), all_usable), None);
    }

    #[test]
    fn nothing_available_stops_sampling() {
        assert_eq!(select_wan_netdev("", "", None, all_usable), None);
        assert_eq!(select_wan_netdev(real_world_fw(), real_world_net(), Some("eth2"), |_| false), None);
    }

    #[test]
    fn alias_chain_resolves_to_physical_dev() {
        let net = parse_uci_show(
            "network.wan.device='eth1'\nnetwork.wan6.device='@wan'\nnetwork.v6alias.device='@wan6'\n",
        );
        assert_eq!(resolve_netdev("wan6", &net).as_deref(), Some("eth1"));
        assert_eq!(resolve_netdev("v6alias", &net).as_deref(), Some("eth1"));
    }

    #[test]
    fn alias_cycle_is_bounded() {
        let net = parse_uci_show("network.a.device='@b'\nnetwork.b.device='@a'\n");
        assert_eq!(resolve_netdev("a", &net), None);
    }

    #[test]
    fn uci_list_values_are_parsed() {
        let cfg = parse_uci_show("firewall.@zone[1].network='MT5700M' 'wan' 'wan6'\n");
        assert_eq!(
            cfg["@zone[1]"]["network"],
            vec!["MT5700M".to_string(), "wan".to_string(), "wan6".to_string()]
        );
    }

    #[test]
    fn dsflowqry_hex_fields_are_parsed() {
        // 手册 16.12.5 示例（数值被折行，实际 AT 输出为单行）
        let text = "^DSFLOWQRY:\r\n0000002D,0000000000019A01,0000000000736A52,0000002D,0000000000019A01,0000000000736A52\r\nOK\r\n";
        assert_eq!(parse_dsflowqry(text), Some((0x736A52, 0x19A01)));
        // 数值中间折行也要能拼回来
        let wrapped = "^DSFLOWQRY: 1,2,3,4,00000000\r\n00000100,0000000000000200\r\nOK";
        assert_eq!(parse_dsflowqry(wrapped), Some((0x200, 0x100)));
    }

    #[test]
    fn dsflowqry_rejects_broken_responses() {
        assert_eq!(parse_dsflowqry("OK"), None);
        assert_eq!(parse_dsflowqry("^DSFLOWQRY: 1,2,3\r\nOK"), None);
        assert_eq!(parse_dsflowqry("^DSFLOWQRY: 1,2,3,4,ZZ,6\r\nOK"), None);
        assert_eq!(parse_dsflowqry("ERROR"), None);
    }

    #[test]
    fn usage_source_is_normalized() {
        assert_eq!(normalize_usage_source("modem"), SOURCE_MODEM);
        assert_eq!(normalize_usage_source(" modem "), SOURCE_MODEM);
        assert_eq!(normalize_usage_source("netdev"), SOURCE_NETDEV);
        assert_eq!(normalize_usage_source("br-lan"), SOURCE_NETDEV);
        assert_eq!(normalize_usage_source(""), SOURCE_NETDEV);
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
