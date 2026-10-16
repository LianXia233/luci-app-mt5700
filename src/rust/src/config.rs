//! UCI 配置读取：一次 `uci show at-webserver` 取回整个配置段。
//! 键名与 LuCI 页面约定完全一致。

use crate::{log_info, log_warn};
use crate::logger::{self, Level};
use std::collections::HashMap;
use std::time::Duration;

pub const AUTO_SERIAL_PORT: &str = "auto";

/// 常见 PCUI 口编号偏好，**仅用于同优先级时的排序**，不是事实判断。
///
/// MT5700M-CN 在典型内核/驱动下把 PCUI 枚举为 ttyUSB1，但枚举顺序取决于
/// USB 接口描述符与 option 驱动绑定顺序，会随内核与固件版本变化。
/// 真正的判定依据是 sysfs 的接口名（见 serialdetect::port_rank），
/// 只有在拿不到该信息时才会用到这个编号偏好。
/// 另有一个更隐蔽的风险：若某机型上 ttyUSB1 恰是 GPS 口且其数据里出现整行 OK，
/// 硬编码编号会把它排到最前；按接口名打分可避免。
pub const PREFERRED_AT_PORT: &str = "/dev/ttyUSB1";

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BandLock {
    /// Type: 0=解锁 1=频点 2=小区 3=频段
    pub type_: i64,
    pub bands: String,
    pub arfcns: String,
    pub scs_types: String,
    pub pcis: String,
}

#[derive(Debug, Clone)]
pub struct NetworkConfig {
    pub host: String,
    pub port: u16,
    pub timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct SerialConfig {
    pub port: String,
    pub baudrate: u32,
    pub timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct AtConfig {
    /// 连接方式："NETWORK" 或 "SERIAL"（非 NETWORK 一律回落 SERIAL）
    pub type_: String,
    pub network: NetworkConfig,
    pub serial: SerialConfig,
    /// 模组连上后是否确保自动拨号开启（默认 true）。
    /// 关闭后模组不会向 USB 网口下发 DHCP，接口将拿不到 IP。
    pub autodial_enable: bool,
    /// 自动拨号方式：1=USB网络接口，2=转网口模式
    pub autodial_mode: i64,
}

#[derive(Debug, Clone)]
pub struct NotifyTypes {
    pub sms: bool,
    pub call: bool,
    pub memory_full: bool,
    pub signal: bool,
}

/// 定时推送间隔的默认值（分钟）：到点主动推一次「当前实际情况」。
///
/// 10 分钟的由来：定时推送是**主动推送当前状态**，不是等事件来了才发，
/// 太密就成了噪音；10 分钟既能及时反映信号与存储的变化，又不至于让人想关掉。
pub const DEFAULT_NOTIFY_TIMER_INTERVAL_MIN: u64 = 10;
/// 定时推送间隔下限（1 分钟）：分钟粒度下的最小值。
pub const MIN_NOTIFY_TIMER_INTERVAL_MIN: u64 = 1;
/// 定时推送间隔上限（1440 分钟 = 24 小时）。
pub const MAX_NOTIFY_TIMER_INTERVAL_MIN: u64 = 1440;
/// 旧键 `notify_interval` 的**出厂默认值**（秒）。
///
/// 迁移时要单独认它：包内 `root/etc/config` 原本就写死 60，所以实机上看到
/// `notify_interval='60'` 绝大多数是「用户从没改过」，而不是「用户刻意选了
/// 60 秒」。若一律按公式换算成 1 分钟，升级后每台设备都会每分钟推一条
/// （每天 1440 条）—— 远超 QQ 主动消息频控，等于把语义升级变成推送轰炸。
pub const LEGACY_DEFAULT_NOTIFY_INTERVAL_SECS: u64 = 60;

/// 旧键 `notify_interval`（合并窗口秒数）迁移：秒 → 分钟，向上取整。
///
/// 单独成函数是为了让「60 秒 → 1 分钟」「1 秒 → 1 分钟」「超大值 → 24 小时封顶」
/// 这些边界在单测里能被直接钉住，而不是散落在读取逻辑里靠人脑推演。
///
/// 注意：这个函数只在「旧值不是出厂默认值」时才被调用（见 `timer_interval_from`）。
pub fn secs_to_timer_minutes(secs: u64) -> u64 {
    let m = (secs + 59) / 60;
    m.clamp(MIN_NOTIFY_TIMER_INTERVAL_MIN, MAX_NOTIFY_TIMER_INTERVAL_MIN)
}

// ---------------------------------------------------------------------------
// 定时轮询推送（信号采样）
//
// 为什么需要它：本模组（TDTECH/Fibocom 系）不会主动上报 ^HCSQ / ^CERSSI，
// 实机 1200 条 AT 记录里自发信号上报为 0 条，`Dispatcher::handle_signal`
// 因而永远不会被调用，「信号变化通知」开关实际处于失效状态。
// 这里由后端在**用户指定的时段**内自己轮询，让该开关真正生效；
// 时段外完全不发 AT，避免无意义的串口占用与推送打扰。
// ---------------------------------------------------------------------------

/// 轮询间隔默认值（秒）。
pub const DEFAULT_NOTIFY_POLL_INTERVAL_SECS: u64 = 300;
/// 轮询间隔下限（30 秒）：再密就是拿串口和推送配额开玩笑。
pub const MIN_NOTIFY_POLL_INTERVAL_SECS: u64 = 30;
/// 轮询间隔上限（1 小时）。
pub const MAX_NOTIFY_POLL_INTERVAL_SECS: u64 = 3600;
/// 时段默认起点/终点（全天）。
pub const DEFAULT_NOTIFY_POLL_START: &str = "00:00";
pub const DEFAULT_NOTIFY_POLL_END: &str = "23:59";
/// 「仅变化时推送」模式下触发推送的最小 RSRP 变化量（dB）。
///
/// 不复用 URC 路径 1 dB 的阈值：那是为「模组主动上报的即时变化」设计的，
/// 用于分钟级轮询时任何一次读数抖动都会越过 1 dB，等于每次轮询都推。
/// 3 dB 在 RSRP 上已是一档明显的信号质量变化，既能反映真实变化又不打扰。
pub const DEFAULT_SIGNAL_DELTA_DB: f64 = 3.0;
/// 变化阈值允许的范围（dB）。下限 1 = 任何一档变化都推；上限 30 = 只推剧烈变化。
pub const MIN_NOTIFY_POLL_DELTA_DB: i64 = 1;
pub const MAX_NOTIFY_POLL_DELTA_DB: i64 = 30;

/// 定时轮询推送配置。
#[derive(Debug, Clone)]
pub struct PollConfig {
    /// 是否启用定时轮询推送（总开关关闭时同样不轮询）。
    pub enabled: bool,
    /// 时段起点 `HH:MM`（含）。
    pub start: String,
    /// 时段终点 `HH:MM`（含，闭区间）；小于起点表示**跨零点**（如 22:00-06:00）。
    pub end: String,
    /// 轮询间隔。
    pub interval: Duration,
    /// true = 每次轮询都推送当前信号状态；false = 仅在信号显著变化时推送。
    pub always: bool,
    /// 「仅变化时推送」模式下的最小变化量（dB）。
    pub delta: f64,
}

impl Default for PollConfig {
    fn default() -> Self {
        PollConfig {
            enabled: true,
            start: DEFAULT_NOTIFY_POLL_START.into(),
            end: DEFAULT_NOTIFY_POLL_END.into(),
            interval: Duration::from_secs(DEFAULT_NOTIFY_POLL_INTERVAL_SECS),
            always: false,
            delta: DEFAULT_SIGNAL_DELTA_DB,
        }
    }
}

/// 判断某个「当天分钟数」（0..=1439）是否落在 `[start, end]` 时段内。
///
/// 区间取**闭区间**（两端都算在时段内），因为用户写「18:00」想表达的是
/// 「到 18:00 为止」，半开区间会让 18:00:00~18:00:59 这段落在窗外，
/// 更关键的是默认全天时段 `00:00-23:59` 会漏掉当天最后一分钟。
///
/// - `start < end`：普通时段，直接区间比较；
/// - `start > end`：跨零点时段（如 22:00-06:00），落在 `[start, 1439] ∪ [0, end]`；
/// - `start == end`：按「全天」处理（否则会变成只命中一分钟，用户会以为坏了）；
/// - 任一时间格式非法：按「全天」处理并交由调用方记录一次告警，避免因笔误彻底静默。
pub fn in_poll_window(start: &str, end: &str, minute_of_day: i64) -> bool {
    let (s, e) = match (
        crate::schedconfig::parse_hhmm(start),
        crate::schedconfig::parse_hhmm(end),
    ) {
        (Some(s), Some(e)) => (s, e),
        _ => return true,
    };
    if s == e {
        return true;
    }
    if s < e {
        minute_of_day >= s && minute_of_day <= e
    } else {
        minute_of_day >= s || minute_of_day <= e
    }
}

/// 时段字符串是否合法（供配置校验与单测使用）。
pub fn valid_hhmm(v: &str) -> bool {
    crate::schedconfig::parse_hhmm(v).is_some()
}

// ---------------------------------------------------------------------------
// 自定义推送文案模板
//
// 采用「UCI 存单行文本 + 反斜杠转义换行」的约定：UCI 的 option 值是单行的，
// 无法直接存多行文本，因此模板里的换行统一写成 `\n`（两个字符），由本模块在
// 读取时还原为真实换行。LuCI 页面在保存时把真实换行转回 `\n`，来回一趟无损。
//
// 可用占位符（渲染时替换，未识别的占位符原样保留）：
//   {sender}  发送者（短信为号码/名称；来电与信号为内部来源标识）
//   {content} 事件正文（短信内容、来电的号码与状态、信号的完整明细）
//   {time}    本条消息的推送时刻（本地时间 %Y-%m-%d %H:%M:%S）
//   {kind}    事件类型中文名（新短信 / 来电 / 信号变化 / 存储空间已满）
//   {count}   本条消息合并的事件条数（单条为 1）
// ---------------------------------------------------------------------------

/// 单条短信通知的默认文案。
pub const DEFAULT_TPL_SMS: &str = "喵呜～，有新短信到啦！快来看看是谁给你发消息了喵~\n发送者: {sender}\n内容: {content}";
/// 来电通知的默认文案。
pub const DEFAULT_TPL_CALL: &str = "喵呜～有电话打进来啦，快接起来看看是谁找你喵！\n{content}";
/// 短信存储满通知的默认文案。
pub const DEFAULT_TPL_MEMORY: &str = "喵呜～短信存储空间已经满啦，请尽快清理一下喵，不然可能收不到新的短信了哦！";
/// 信号变化通知的默认文案（正文由后端组装，模板默认直接透出）。
pub const DEFAULT_TPL_SIGNAL: &str = "{content}";
/// 批量汇总的默认标题。
pub const DEFAULT_TPL_BATCH: &str = "喵～有一批新通知需要查看哦，快来看看都有哪些消息吧！";

#[derive(Debug, Clone)]
pub struct NotifyTemplates {
    /// 全局前缀：附加在每条推送消息（含测试消息）的最前面，留空则不添加。
    pub prefix: String,
    /// 新短信文案模板。
    pub sms: String,
    /// 来电文案模板。
    pub call: String,
    /// 短信存储满文案模板。
    pub memory_full: String,
    /// 信号变化文案模板。
    pub signal: String,
    /// 批量汇总标题（多条合并时使用）。v1.14.20 起生产路径逐条直发，
    /// 该标题当前不会被触发，保留仅为兼容已有配置。
    pub batch: String,
}

impl Default for NotifyTemplates {
    fn default() -> Self {
        NotifyTemplates {
            prefix: String::new(),
            sms: DEFAULT_TPL_SMS.into(),
            call: DEFAULT_TPL_CALL.into(),
            memory_full: DEFAULT_TPL_MEMORY.into(),
            signal: DEFAULT_TPL_SIGNAL.into(),
            batch: DEFAULT_TPL_BATCH.into(),
        }
    }
}

/// 模板值的转义还原：把 `\n` / `\t` / `\r` / `\\` 还原为真实字符。
/// 其它反斜杠序列原样保留（避免把用户写的正则或路径吃掉）。
///
/// 反方向的转义（真实换行 → `\n`）由写配置的一方负责：LuCI 页面在保存前
/// 完成转换，后端只读不写，因此这里不提供 Rust 侧的 `escape` 实现。
pub fn unescape_template(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

#[derive(Debug, Clone)]
pub struct NotificationConfig {
    /// 自动推送总开关。关闭时事件不再推送（仅保留本地通知日志），
    /// 便于用户在不改动分类开关的前提下整体静音。
    pub enabled: bool,
    pub wechat_webhook: String,
    pub log_file: String,
    pub types: NotifyTypes,
    /// QQ 机器人（官方 API v2）推送配置；AppSecret 建议走环境变量 QQ_BOT_APP_SECRET。
    pub qq: QqNotifyConfig,
    /// 定时推送间隔：每隔这么久主动推一次「当前实际情况」（信号读数 + 存储状态）。
    /// 与 `poll`（信号巡检）是两条独立的周期线，互不覆盖。
    pub timer_interval: Duration,
    /// 定时轮询推送（信号采样）。
    pub poll: PollConfig,
    /// 自定义推送文案模板。
    pub templates: NotifyTemplates,
}

#[derive(Debug, Clone)]
pub struct QqNotifyConfig {
    pub app_id: String,
    pub app_secret: String,
    /// "group" | "c2c" | "channel" | "bind"（bind=启动后自动抓取 openid 并写回 UCI）
    pub target_type: String,
    pub target_id: String,
    /// 绑定模式下的用户 QQ 号（仅作展示标签，事件里拿不到 QQ 号）
    pub bind_qq: String,
}

#[derive(Debug, Clone)]
pub struct WebSocketConfig {
    pub port: u16,
    pub auth_key: String,
    pub allow_wan: bool,
    /// RPC 监听地址：websocket_bind 显式值优先；否则 allow_wan=1 → 0.0.0.0，默认 127.0.0.1
    pub bind: String,
    /// 一次 ^CELLSCAN 允许跑多久；读 UCI cellscan_timeout，下限 10s，默认 180s
    pub scan_timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct ScheduleConfig {
    pub enabled: bool,
    pub check_interval: Duration,
    pub no_service_limit: Duration,
    pub unlock_lte: bool,
    pub unlock_nr: bool,
    pub toggle_airplane: bool,

    pub night_enabled: bool,
    pub night_start: String,
    pub night_end: String,
    pub night_lte: BandLock,
    pub night_nr: BandLock,

    pub day_enabled: bool,
    pub day_lte: BandLock,
    pub day_nr: BandLock,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub enabled: bool,
    pub at: AtConfig,
    pub notification: NotificationConfig,
    pub websocket: WebSocketConfig,
    pub schedule: ScheduleConfig,
    /// 使用量统计的自动清零天数（默认 30）。
    ///
    /// 放在 UCI 而不是使用量状态文件里：状态文件在「持久化关」时重启即失，
    /// 设置跟着一起丢会让用户每次重启后都要重填。
    pub usage_auto_reset_days: u32,
}

pub fn default_config() -> Config {
    Config {
        enabled: true,
        at: AtConfig {
            // 默认 PCUI 串口优先（与 UCI 默认配置一致）
            type_: "SERIAL".into(),
            network: NetworkConfig {
                host: "192.168.8.1".into(),
                port: 20249,
                timeout: Duration::from_secs(10),
            },
            serial: SerialConfig {
                port: PREFERRED_AT_PORT.into(),
                baudrate: 115200,
                timeout: Duration::from_secs(10),
            },
            // 自动拨号默认开启：模组不拨号则 USB 网口不会有 DHCP，接口拿不到 IP
            autodial_enable: true,
            autodial_mode: 1,
        },
        notification: NotificationConfig {
            enabled: true,
            wechat_webhook: String::new(),
            log_file: String::new(),
            types: NotifyTypes {
                sms: true,
                call: true,
                memory_full: true,
                signal: true,
            },
            qq: QqNotifyConfig {
                app_id: String::new(),
                app_secret: String::new(),
                target_type: "group".into(),
                target_id: String::new(),
                bind_qq: String::new(),
            },
            timer_interval: Duration::from_secs(DEFAULT_NOTIFY_TIMER_INTERVAL_MIN * 60),
            poll: PollConfig::default(),
            templates: NotifyTemplates::default(),
        },
        websocket: WebSocketConfig {
            port: 8765,
            auth_key: String::new(),
            allow_wan: false,
            bind: "127.0.0.1".into(),
            scan_timeout: Duration::from_secs(180),
        },
        schedule: ScheduleConfig {
            enabled: false,
            check_interval: Duration::from_secs(60),
            no_service_limit: Duration::from_secs(180),
            unlock_lte: true,
            unlock_nr: true,
            toggle_airplane: true,
            night_enabled: true,
            night_start: "22:00".into(),
            night_end: "06:00".into(),
            night_lte: BandLock { type_: 3, bands: String::new(), arfcns: String::new(), scs_types: String::new(), pcis: String::new() },
            night_nr: BandLock { type_: 3, bands: String::new(), arfcns: String::new(), scs_types: String::new(), pcis: String::new() },
            day_enabled: true,
            day_lte: BandLock { type_: 3, bands: String::new(), arfcns: String::new(), scs_types: String::new(), pcis: String::new() },
            day_nr: BandLock { type_: 3, bands: String::new(), arfcns: String::new(), scs_types: String::new(), pcis: String::new() },
        },
        usage_auto_reset_days: crate::usage::DEFAULT_USAGE_AUTO_RESET_DAYS,
    }
}

/// 还原 uci show 的单引号包裹，包括 '\'' 的内嵌引号转义。
fn unquote_uci(raw: &str) -> String {
    let raw = raw.trim();
    if raw.len() >= 2 && raw.starts_with('\'') && raw.ends_with('\'') {
        raw[1..raw.len() - 1].replace("'\\''", "'")
    } else {
        raw.to_string()
    }
}

pub struct UciReader(HashMap<String, String>);

impl UciReader {
    pub fn str(&self, key: &str, def: &str) -> String {
        match self.0.get(key) {
            Some(v) if !v.is_empty() => v.clone(),
            _ => def.to_string(),
        }
    }

    pub fn int(&self, key: &str, def: i64) -> i64 {
        if let Some(v) = self.0.get(key) {
            if let Ok(n) = v.trim().parse::<i64>() {
                return n;
            }
        }
        def
    }

    pub fn bool(&self, key: &str, def: bool) -> bool {
        let v = match self.0.get(key) {
            Some(v) => v,
            None => return def,
        };
        match v.trim() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => def,
        }
    }

    /// 秒为单位读取并夹到下限，避免忙循环。
    pub fn seconds(&self, key: &str, def: Duration, min: Duration) -> Duration {
        let d = Duration::from_secs(self.int(key, def.as_secs() as i64).max(0) as u64);
        if d < min {
            min
        } else {
            d
        }
    }

    fn band_lock(&self, prefix: &str) -> BandLock {
        BandLock {
            type_: self.int(&format!("{prefix}_type"), 3),
            bands: self.str(&format!("{prefix}_bands"), ""),
            arfcns: self.str(&format!("{prefix}_arfcns"), ""),
            scs_types: self.str(&format!("{prefix}_scs_types"), ""),
            pcis: self.str(&format!("{prefix}_pcis"), ""),
        }
    }
}

/// 读取环境变量（trim 后为空视为未设置）。
fn env_nonempty(key: &str) -> String {
    std::env::var(key).unwrap_or_default().trim().to_string()
}

/// 用一次 `uci show at-webserver` 取回整个配置段。
pub async fn uci_values() -> Result<UciReader, String> {
    // 加 5s 超时，避免 uci 命令异常挂起卡死启动。
    let out = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new("uci")
            .args(["show", "at-webserver"])
            .output(),
    )
    .await
    .map_err(|_| "uci show 超时".to_string())?
    .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("uci show 退出码 {}", out.status));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let prefix = "at-webserver.config.";
    let mut values = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(eq) = line.find('=') {
            let key = &line[..eq];
            let raw = &line[eq + 1..];
            if key.starts_with(prefix) {
                values.insert(key[prefix.len()..].to_string(), unquote_uci(raw));
            }
        }
    }
    Ok(UciReader(values))
}

/// 从 UCI 读取配置；读取失败时返回默认配置，让服务仍能起来。

/// 解析定时推送间隔：UCI 以**分钟**为单位，内部换算成 [`Duration`]。
///
/// 单独成函数的理由：`load_config()` 自己会去调 `uci show`，单测无法注入值；
/// 而这里的规则（默认值、上下限夹取、旧键迁移）恰恰是最容易写错又最难在实机上
/// 逐个试的部分，必须能被单测直接覆盖。
///
/// 旧键 `notify_interval` 是「合并窗口秒数」，语义已废弃；**仅在未配置新键时**
/// 迁移一次，否则老设备升级后会静默退回默认值，用户会以为自己填过的频率丢了。
fn timer_interval_from(values: &UciReader) -> Duration {
    let raw = values.str("notify_timer_interval", "");
    let raw = raw.trim().to_string();
    let minutes = if raw.is_empty() {
        let legacy = values.int("notify_interval", 0);
        if legacy > 0 {
            if legacy as u64 == LEGACY_DEFAULT_NOTIFY_INTERVAL_SECS {
                // 出厂默认值：不是用户的选择，迁移到新的默认值而不是换算后的 1 分钟，
                // 否则每台升级的设备都会变成每分钟推一条。
                log_info!(
                    "旧配置 notify_interval={legacy}s 是出厂默认值，已迁移为 notify_timer_interval={} 分钟",
                    DEFAULT_NOTIFY_TIMER_INTERVAL_MIN
                );
                DEFAULT_NOTIFY_TIMER_INTERVAL_MIN
            } else {
                let migrated = secs_to_timer_minutes(legacy as u64);
                log_info!("旧配置 notify_interval={legacy}s 已迁移为 notify_timer_interval={migrated} 分钟");
                migrated
            }
        } else {
            DEFAULT_NOTIFY_TIMER_INTERVAL_MIN
        }
    } else {
        raw.parse::<u64>().unwrap_or_else(|_| {
            log_warn!("notify_timer_interval 不是数字（{raw}），已回落默认 {DEFAULT_NOTIFY_TIMER_INTERVAL_MIN} 分钟");
            DEFAULT_NOTIFY_TIMER_INTERVAL_MIN
        })
    };
    Duration::from_secs(minutes.clamp(MIN_NOTIFY_TIMER_INTERVAL_MIN, MAX_NOTIFY_TIMER_INTERVAL_MIN) * 60)
}

pub async fn load_config() -> Config {
    let mut cfg = default_config();
    let values = match uci_values().await {
        Ok(v) => v,
        Err(e) => {
            logger::emit(Level::Warn, "CFG", format_args!("读取 UCI 配置失败，使用默认配置: {e}"));
            return cfg;
        }
    };

    cfg.enabled = values.bool("enabled", true);

    let t = values.str("connection_type", "SERIAL").to_uppercase();   // PCUI 优先
    // 非 NETWORK 一律走串口（含历史误写 AUTO），保证默认/兼容均为 PCUI
    cfg.at.type_ = if t == "NETWORK" { "NETWORK" } else { "SERIAL" }.to_string();

    cfg.at.network.host = values.str("network_host", &cfg.at.network.host);
    cfg.at.network.port = values.int("network_port", cfg.at.network.port as i64).clamp(1, 65535) as u16;
    cfg.at.network.timeout = values.seconds("network_timeout", cfg.at.network.timeout, Duration::from_secs(1));

    let mut serial_port = values.str("serial_port", &cfg.at.serial.port);
    if serial_port == "custom" {
        serial_port = values.str("serial_port_custom", PREFERRED_AT_PORT);
    }
    // "auto" 是哨兵值，交给 detect_at_port 逐个探测。
    cfg.at.serial.port = serial_port;
    cfg.at.serial.baudrate = values.int("serial_baudrate", 115200).clamp(0, 4000000) as u32;
    cfg.at.serial.timeout = values.seconds("serial_timeout", cfg.at.serial.timeout, Duration::from_secs(1));

    // 自动拨号：默认开启。模组不拨号则不会给 USB 网口下发 DHCP，接口拿不到 IP。
    cfg.at.autodial_enable = values.bool("autodial_enable", true);
    cfg.at.autodial_mode = values.int("autodial_mode", 1).clamp(1, 2);

    cfg.websocket.port = values.int("websocket_port", 8765).clamp(1, 65535) as u16;
    cfg.websocket.auth_key = values.str("websocket_auth_key", "");
    cfg.websocket.allow_wan = values.bool("websocket_allow_wan", false);
    // 监听地址：显式 websocket_bind 优先；否则 allow_wan=1 → 0.0.0.0，否则 127.0.0.1
    let bind = values.str("websocket_bind", "");
    cfg.websocket.bind = if !bind.is_empty() {
        bind
    } else if cfg.websocket.allow_wan {
        "0.0.0.0".into()
    } else {
        "127.0.0.1".into()
    };
    // 下限 10 秒而不是默认 3 分钟：用户配置的小于 3 分钟的值不能被悄悄抬回。
    cfg.websocket.scan_timeout = values.seconds("cellscan_timeout", cfg.websocket.scan_timeout, Duration::from_secs(10));

    cfg.notification.wechat_webhook = values.str("wechat_webhook", "");
    cfg.notification.log_file = values.str("log_file", "");
    cfg.notification.types = NotifyTypes {
        sms: values.bool("notify_sms", true),
        call: values.bool("notify_call", true),
        memory_full: values.bool("notify_memory_full", true),
        signal: values.bool("notify_signal", true),
    };

    // QQ 机器人推送：密钥优先取环境变量（QQ_BOT_APP_ID / QQ_BOT_APP_SECRET），
    // 避免敏感凭据硬编码进 UCI 配置；环境变量为空时回落 UCI。
    let qq_app_id = env_nonempty("QQ_BOT_APP_ID");
    let qq_app_secret = env_nonempty("QQ_BOT_APP_SECRET");
    cfg.notification.qq = QqNotifyConfig {
        app_id: if qq_app_id.is_empty() { values.str("qq_app_id", "") } else { qq_app_id },
        app_secret: if qq_app_secret.is_empty() { values.str("qq_app_secret", "") } else { qq_app_secret },
        target_type: crate::notify::normalize_qq_target_type(&values.str("qq_target_type", "group")),
        target_id: values.str("qq_target_id", ""),
        bind_qq: values.str("qq_bind_qq", ""),
    };

    // 定时推送间隔（分钟）：到点主动推一次当前实际情况。
    cfg.notification.timer_interval = timer_interval_from(&values);

    // 自定义推送文案：UCI 存单行转义文本，空值回落内置默认，保证升级后行为不变。
    let tpl = |key: &str, def: &str| -> String {
        let v = values.str(key, "");
        if v.trim().is_empty() {
            def.to_string()
        } else {
            unescape_template(&v)
        }
    };
    cfg.notification.templates = NotifyTemplates {
        prefix: unescape_template(&values.str("notify_tpl_prefix", "")),
        sms: tpl("notify_tpl_sms", DEFAULT_TPL_SMS),
        call: tpl("notify_tpl_call", DEFAULT_TPL_CALL),
        memory_full: tpl("notify_tpl_memory", DEFAULT_TPL_MEMORY),
        signal: tpl("notify_tpl_signal", DEFAULT_TPL_SIGNAL),
        batch: tpl("notify_tpl_batch", DEFAULT_TPL_BATCH),
    };

    // 自动推送总开关：默认开启，保证升级后行为不变。
    cfg.notification.enabled = values.bool("notify_enabled", true);

    // 定时轮询推送：时段内周期采样信号，按策略推送。
    let poll_start = values.str("notify_poll_start", DEFAULT_NOTIFY_POLL_START);
    let poll_end = values.str("notify_poll_end", DEFAULT_NOTIFY_POLL_END);
    let poll_interval = values.seconds(
        "notify_poll_interval",
        Duration::from_secs(DEFAULT_NOTIFY_POLL_INTERVAL_SECS),
        Duration::from_secs(MIN_NOTIFY_POLL_INTERVAL_SECS),
    );
    cfg.notification.poll = PollConfig {
        enabled: values.bool("notify_poll_enabled", true),
        // 时间格式非法时回落「全天」并留痕：宁可多推也别让笔误把功能变成静默失效。
        start: if valid_hhmm(&poll_start) {
            poll_start
        } else {
            log_warn!("notify_poll_start 格式非法（{}），已回落 {}", poll_start, DEFAULT_NOTIFY_POLL_START);
            DEFAULT_NOTIFY_POLL_START.into()
        },
        end: if valid_hhmm(&poll_end) {
            poll_end
        } else {
            log_warn!("notify_poll_end 格式非法（{}），已回落 {}", poll_end, DEFAULT_NOTIFY_POLL_END);
            DEFAULT_NOTIFY_POLL_END.into()
        },
        interval: poll_interval.min(Duration::from_secs(MAX_NOTIFY_POLL_INTERVAL_SECS)),
        always: values.bool("notify_poll_all", false),
        delta: values
            .int("notify_poll_delta", DEFAULT_SIGNAL_DELTA_DB as i64)
            .clamp(MIN_NOTIFY_POLL_DELTA_DB, MAX_NOTIFY_POLL_DELTA_DB) as f64,
    };

    let s = &mut cfg.schedule;
    s.enabled = values.bool("schedule_enabled", false);
    s.check_interval = values.seconds("schedule_check_interval", s.check_interval, Duration::from_secs(10));
    s.no_service_limit = values.seconds("schedule_timeout", s.no_service_limit, Duration::from_secs(30));
    s.unlock_lte = values.bool("schedule_unlock_lte", true);
    s.unlock_nr = values.bool("schedule_unlock_nr", true);
    s.toggle_airplane = values.bool("schedule_toggle_airplane", true);

    s.night_enabled = values.bool("schedule_night_enabled", true);
    s.night_start = values.str("schedule_night_start", &s.night_start);
    s.night_end = values.str("schedule_night_end", &s.night_end);
    s.night_lte = values.band_lock("schedule_night_lte");
    s.night_nr = values.band_lock("schedule_night_nr");

    s.day_enabled = values.bool("schedule_day_enabled", true);
    s.day_lte = values.band_lock("schedule_day_lte");
    s.day_nr = values.band_lock("schedule_day_nr");

    // 使用量自动清零天数：默认 30 天，夹在 [1, 3650]
    cfg.usage_auto_reset_days = (values
        .int("usage_auto_reset_days", crate::usage::DEFAULT_USAGE_AUTO_RESET_DAYS as i64)
        .clamp(
            crate::usage::MIN_USAGE_AUTO_RESET_DAYS as i64,
            crate::usage::MAX_USAGE_AUTO_RESET_DAYS as i64,
        ) as u32)
        .max(crate::usage::MIN_USAGE_AUTO_RESET_DAYS);

    cfg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unescape_template_restores_known_escapes() {
        // UCI 里存的是单行转义文本，读取时必须还原为真实换行/制表/反斜杠
        assert_eq!(
            unescape_template("第一行\\n第二行\\t\\\\ 结束"),
            "第一行\n第二行\t\\ 结束"
        );
    }

    #[test]
    fn unescape_template_keeps_unknown_sequences() {
        // 未知转义（如 \d）必须原样保留，避免把用户写的正则或路径吃掉
        assert_eq!(unescape_template("\\d+\\n"), "\\d+\n");
        // 末尾孤立的反斜杠不能吞掉
        assert_eq!(unescape_template("abc\\"), "abc\\");
    }

    #[test]
    fn unescape_template_leaves_plain_text_untouched() {
        assert_eq!(unescape_template("喵呜～，有新短信到啦！快来看看是谁给你发消息了喵~"), "喵呜～，有新短信到啦！快来看看是谁给你发消息了喵~");
        assert_eq!(unescape_template(""), "");
    }

    #[test]
    fn default_templates_expose_expected_placeholders() {
        let t = NotifyTemplates::default();
        assert!(t.sms.contains("{sender}") && t.sms.contains("{content}"));
        assert!(t.call.contains("{content}"));
        assert!(t.signal.contains("{content}"));
        assert!(!t.memory_full.is_empty());
        assert!(!t.batch.is_empty());
        assert!(t.prefix.is_empty(), "默认不添加前缀");
    }

    #[test]
    fn notify_timer_interval_bounds_are_ordered() {
        assert!(MIN_NOTIFY_TIMER_INTERVAL_MIN <= DEFAULT_NOTIFY_TIMER_INTERVAL_MIN);
        assert!(DEFAULT_NOTIFY_TIMER_INTERVAL_MIN <= MAX_NOTIFY_TIMER_INTERVAL_MIN);
        // 默认 10 分钟：定时推送是主动推送，太密会变成噪音
        assert_eq!(DEFAULT_NOTIFY_TIMER_INTERVAL_MIN, 10);
        // 上限 24 小时 = 1440 分钟
        assert_eq!(MAX_NOTIFY_TIMER_INTERVAL_MIN, 1440);
    }

    #[test]
    fn legacy_seconds_interval_migrates_to_minutes() {
        // 换算函数本身仍是纯公式（60 秒 → 1 分钟）；
        // 「出厂默认值不换算」的判断在 timer_interval_from 里，另有单测覆盖
        assert_eq!(secs_to_timer_minutes(60), 1);
        // 向上取整：61 秒也是 1 分钟？不 —— 61 秒超过 1 分钟，进位为 2
        assert_eq!(secs_to_timer_minutes(61), 2);
        // 旧下限 5 秒在分钟粒度下无法表达，收敛到 1 分钟
        assert_eq!(secs_to_timer_minutes(5), 1);
        assert_eq!(secs_to_timer_minutes(0), 1);
        // 超过 24 小时一律封顶，避免「填错成 99999 分钟」后永远不推
        assert_eq!(secs_to_timer_minutes(999_999), MAX_NOTIFY_TIMER_INTERVAL_MIN);
    }

    #[test]
    fn legacy_default_seconds_falls_to_new_default_not_one_minute() {
        // 关键点：60 秒是**出厂默认值**，不是用户的选择。迁移成 1 分钟会让
        // 每台升级的设备每分钟推一条（每天 1440 条），必须落到新默认值 10 分钟。
        let mk = |pairs: &[(&str, &str)]| {
            let mut m = HashMap::new();
            for (k, v) in pairs {
                m.insert(k.to_string(), v.to_string());
            }
            UciReader(m)
        };
        assert_eq!(
            timer_interval_from(&mk(&[("notify_interval", "60")])).as_secs(),
            10 * 60,
            "旧默认值 60 秒应迁移为新默认值 10 分钟，而不是 1 分钟"
        );
        // 真正被改过的值才按秒→分钟换算
        assert_eq!(timer_interval_from(&mk(&[("notify_interval", "300")])).as_secs(), 5 * 60);
        assert_eq!(timer_interval_from(&mk(&[("notify_interval", "30")])).as_secs(), 60);
    }

    #[test]
    fn timer_interval_reads_minutes_and_clamps() {
        let mk = |pairs: &[(&str, &str)]| {
            let mut m = HashMap::new();
            for (k, v) in pairs {
                m.insert(k.to_string(), v.to_string());
            }
            UciReader(m)
        };
        assert_eq!(timer_interval_from(&mk(&[("notify_timer_interval", "30")])).as_secs(), 30 * 60);
        // 超出上限：夹到 24 小时
        assert_eq!(timer_interval_from(&mk(&[("notify_timer_interval", "99999")])).as_secs(), 1440 * 60);
        // 低于下限：夹到 1 分钟（填 0 不该退化成「不推送」或「每 0 分钟推一次」）
        assert_eq!(timer_interval_from(&mk(&[("notify_timer_interval", "0")])).as_secs(), 60);
        // 两个键都没配：默认 10 分钟
        assert_eq!(timer_interval_from(&mk(&[])).as_secs(), 10 * 60);
        // 旧键迁移：未配置新键时才生效（300 秒不是出厂默认值，按公式换算）
        assert_eq!(timer_interval_from(&mk(&[("notify_interval", "300")])).as_secs(), 5 * 60);
        // 新旧键同时存在：以新键为准，旧键不再覆盖用户的新选择
        assert_eq!(
            timer_interval_from(&mk(&[("notify_interval", "300"), ("notify_timer_interval", "15")])).as_secs(),
            15 * 60
        );
        // 非数字：回落默认，而不是解析成 0
        assert_eq!(timer_interval_from(&mk(&[("notify_timer_interval", "abc")])).as_secs(), 10 * 60);
    }

    #[test]
    fn default_config_has_auto_push_on_and_full_day_poll() {
        let cfg = default_config();
        // 总开关默认开启：升级后行为与旧版一致，不会静默停掉用户已有的推送
        assert!(cfg.notification.enabled, "自动推送总开关应默认开启");
        // 总开关关闭必须是「只停推送」，不能顺手把某类事件开关也改掉
        assert!(cfg.notification.types.sms);
        assert!(cfg.notification.types.call);

        let p = &cfg.notification.poll;
        assert!(p.enabled, "信号轮询默认启用，否则信号类开关在实机永远是死的");
        assert!(!p.always, "默认仅变化时推送，避免每轮都刷一条");
        assert_eq!(p.start, DEFAULT_NOTIFY_POLL_START);
        assert_eq!(p.end, DEFAULT_NOTIFY_POLL_END);
        assert_eq!(p.delta, DEFAULT_SIGNAL_DELTA_DB);
    }

    #[test]
    fn poll_bounds_are_ordered() {
        assert!(MIN_NOTIFY_POLL_INTERVAL_SECS <= DEFAULT_NOTIFY_POLL_INTERVAL_SECS);
        assert!(DEFAULT_NOTIFY_POLL_INTERVAL_SECS <= MAX_NOTIFY_POLL_INTERVAL_SECS);
        // 30 秒下限的意义：QQ 主动消息频控是单关系 20 条/分钟，
        // 间隔比这更密就算每次都推也发不出去，只会被频控拦掉。
        assert!(MIN_NOTIFY_POLL_INTERVAL_SECS >= 30);
        assert!(MIN_NOTIFY_POLL_DELTA_DB <= DEFAULT_SIGNAL_DELTA_DB as i64);
        assert!(DEFAULT_SIGNAL_DELTA_DB as i64 <= MAX_NOTIFY_POLL_DELTA_DB);
    }

    #[test]
    fn uci_reader_parses_poll_keys() {
        // 模拟 uci show 的结果，覆盖轮询各键的读取与夹取
        let mut m = HashMap::new();
        m.insert("notify_enabled".to_string(), "0".to_string());
        m.insert("notify_poll_enabled".to_string(), "1".to_string());
        m.insert("notify_poll_start".to_string(), "22:00".to_string());
        m.insert("notify_poll_end".to_string(), "06:00".to_string());
        m.insert("notify_poll_interval".to_string(), "1".to_string());   // 低于下限 30
        m.insert("notify_poll_all".to_string(), "1".to_string());
        m.insert("notify_poll_delta".to_string(), "99".to_string());     // 高于上限 30
        let v = UciReader(m);

        assert!(!v.bool("notify_enabled", true));
        assert!(v.bool("notify_poll_enabled", false));
        assert!(valid_hhmm(&v.str("notify_poll_start", DEFAULT_NOTIFY_POLL_START)));
        assert!(valid_hhmm(&v.str("notify_poll_end", DEFAULT_NOTIFY_POLL_END)));
        // seconds() 只夹下限，上限由 load_config 再夹一次
        let iv = v.seconds(
            "notify_poll_interval",
            Duration::from_secs(DEFAULT_NOTIFY_POLL_INTERVAL_SECS),
            Duration::from_secs(MIN_NOTIFY_POLL_INTERVAL_SECS),
        );
        assert_eq!(iv.as_secs(), MIN_NOTIFY_POLL_INTERVAL_SECS);
        let delta = v
            .int("notify_poll_delta", DEFAULT_SIGNAL_DELTA_DB as i64)
            .clamp(MIN_NOTIFY_POLL_DELTA_DB, MAX_NOTIFY_POLL_DELTA_DB);
        assert_eq!(delta, MAX_NOTIFY_POLL_DELTA_DB);
    }

    #[test]
    fn poll_time_slot_survives_invalid_uci_value() {
        // 用户手改 UCI 写错了时段，必须回落默认而不是让轮询彻底不工作
        assert!(!valid_hhmm("8:7:60"));
        assert!(!valid_hhmm("late"));
        // 合法但跨零点的写法要保留
        assert!(valid_hhmm("22:00"));
        assert!(valid_hhmm("06:00"));
    }

    #[test]
    fn usage_auto_reset_days_clamps() {
        let mk = |pairs: &[(&str, &str)]| {
            let mut m = HashMap::new();
            for (k, v) in pairs {
                m.insert(k.to_string(), v.to_string());
            }
            UciReader(m)
        };
        let read = |v: &UciReader| -> u32 {
            (v.int("usage_auto_reset_days", crate::usage::DEFAULT_USAGE_AUTO_RESET_DAYS as i64)
                .clamp(
                    crate::usage::MIN_USAGE_AUTO_RESET_DAYS as i64,
                    crate::usage::MAX_USAGE_AUTO_RESET_DAYS as i64,
                ) as u32)
                .max(crate::usage::MIN_USAGE_AUTO_RESET_DAYS)
        };
        // 没配：默认 30 天
        assert_eq!(read(&mk(&[])), 30);
        // 正常值透传
        assert_eq!(read(&mk(&[("usage_auto_reset_days", "7")])), 7);
        // 0 与负值夹到下限 1（不能退化成「永不自动清零」）
        assert_eq!(read(&mk(&[("usage_auto_reset_days", "0")])), 1);
        assert_eq!(read(&mk(&[("usage_auto_reset_days", "-5")])), 1);
        // 超大值夹到上限
        assert_eq!(read(&mk(&[("usage_auto_reset_days", "99999")])), 3650);
        // 非数字回落默认
        assert_eq!(read(&mk(&[("usage_auto_reset_days", "abc")])), 30);
    }
}
