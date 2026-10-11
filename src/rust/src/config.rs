//! UCI 配置读取：一次 `uci show at-webserver` 取回整个配置段。
//! 键名与 LuCI 页面约定完全一致。

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

/// 事件合并窗口的默认值（秒）。窗口内到达的事件合并成一条推送。
pub const DEFAULT_NOTIFY_INTERVAL_SECS: u64 = 60;
/// 合并窗口下限。低于 5 秒时事件几乎无法合并，且会顶到 QQ 主动消息频控
/// （单关系 20 条/分钟）上沿，故在此设硬下限。
pub const MIN_NOTIFY_INTERVAL_SECS: u64 = 5;
/// 合并窗口上限（1 小时）。再长会让通知失去时效性。
pub const MAX_NOTIFY_INTERVAL_SECS: u64 = 3600;

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
pub const DEFAULT_TPL_SMS: &str = "📱 新短信通知\n发送者: {sender}\n内容: {content}";
/// 来电通知的默认文案。
pub const DEFAULT_TPL_CALL: &str = "📞 来电提醒\n{content}";
/// 短信存储满通知的默认文案。
pub const DEFAULT_TPL_MEMORY: &str = "⚠️ 警告：短信存储空间已满\n请及时处理，否则可能无法接收新短信";
/// 信号变化通知的默认文案（正文由后端组装，模板默认直接透出）。
pub const DEFAULT_TPL_SIGNAL: &str = "{content}";
/// 批量汇总的默认标题。
pub const DEFAULT_TPL_BATCH: &str = "📑 批量通知汇总";

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
    /// 批量汇总标题（合并窗口内多于一条时使用）。
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
    pub wechat_webhook: String,
    pub log_file: String,
    pub types: NotifyTypes,
    /// QQ 机器人（官方 API v2）推送配置；AppSecret 建议走环境变量 QQ_BOT_APP_SECRET。
    pub qq: QqNotifyConfig,
    /// 事件合并窗口（推送频率）：窗口内到达的事件合并为一条推送，空队列不触发发送。
    pub interval: Duration,
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
            interval: Duration::from_secs(DEFAULT_NOTIFY_INTERVAL_SECS),
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

    // 推送频率：合并窗口秒数（下限 5s 防频控/忙循环，上限 1h 保时效）。
    let interval = values.seconds(
        "notify_interval",
        Duration::from_secs(DEFAULT_NOTIFY_INTERVAL_SECS),
        Duration::from_secs(MIN_NOTIFY_INTERVAL_SECS),
    );
    cfg.notification.interval = interval.min(Duration::from_secs(MAX_NOTIFY_INTERVAL_SECS));

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
        assert_eq!(unescape_template("📱 新短信通知"), "📱 新短信通知");
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
    fn notify_interval_bounds_are_ordered() {
        assert!(MIN_NOTIFY_INTERVAL_SECS <= DEFAULT_NOTIFY_INTERVAL_SECS);
        assert!(DEFAULT_NOTIFY_INTERVAL_SECS <= MAX_NOTIFY_INTERVAL_SECS);
    }
}
