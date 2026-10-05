//! 配置读取（Debian）：从 JSON 扁平键值配置文件（/etc/mt5700/config.json，
//! 可用 MT5700_CONFIG 覆盖）读取整个配置。键名与原 OpenWrt UCI 完全一致，
//! 前端页面与业务逻辑无需感知存储介质的变化。

use crate::configstore;
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
    /// "NETWORK" 或 "SERIAL"
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

#[derive(Debug, Clone)]
pub struct NotificationConfig {
    pub wechat_webhook: String,
    pub log_file: String,
    pub types: NotifyTypes,
}

#[derive(Debug, Clone)]
pub struct WebSocketConfig {
    pub port: u16,
    pub auth_key: String,
    pub allow_wan: bool,
    /// TCP RPC 监听地址：127.0.0.1（默认，兼容 mock-modem e2e 等本地工具）
    pub bind: String,
    /// 一次 ^CELLSCAN 允许跑多久
    pub scan_timeout: Duration,
}

/// 独立 WebUI 的 HTTP 服务配置（Debian 分支新增）。
#[derive(Debug, Clone)]
pub struct HttpConfig {
    /// HTTP API + WebUI 监听端口，默认 9000
    pub port: u16,
    /// 监听地址，默认 0.0.0.0（开箱即用：浏览器直访 http://<设备IP>:9000）
    pub bind: String,
    /// 静态 WebUI 根目录
    pub web_root: String,
    /// 访问密钥；为空表示不启用认证
    pub auth_key: String,
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
    pub http: HttpConfig,
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
        },
        websocket: WebSocketConfig {
            port: 8765,
            auth_key: String::new(),
            allow_wan: false,
            bind: "127.0.0.1".into(),
            scan_timeout: Duration::from_secs(180),
        },
        http: HttpConfig {
            port: 9000,
            bind: "0.0.0.0".into(),
            web_root: String::new(),
            auth_key: String::new(),
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

/// WebUI 静态根目录默认值（发行包安装到 /usr/share/mt5700/webui）。
pub const DEFAULT_WEB_ROOT: &str = "/usr/share/mt5700/webui";

pub struct UciReader(HashMap<String, String>);

impl UciReader {
    /// 从 JSON 配置存储的扁平键值映射构造（键名沿用原 UCI 语义）。
    fn from_map(map: configstore::ConfigMap) -> UciReader {
        UciReader(map.into_iter().collect())
    }

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

/// 从配置存储读取；读取失败时返回默认配置，让服务仍能起来。
pub async fn load_config() -> Config {
    let mut cfg = default_config();
    let values = match configstore::read_map().await {
        Ok(map) => UciReader::from_map(map),
        Err(e) => {
            logger::emit(Level::Warn, "CFG", format_args!("读取配置文件失败，使用默认配置: {e}"));
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

    // 独立 WebUI 的 HTTP 服务（Debian）：默认 9000 端口对外监听，开箱即用。
    cfg.http.port = values.int("http_port", 9000).clamp(1, 65535) as u16;
    cfg.http.bind = {
        let b = values.str("http_bind", "0.0.0.0");
        if b.is_empty() { "0.0.0.0".to_string() } else { b }
    };
    cfg.http.web_root = {
        let w = values.str("web_root", "");
        if w.is_empty() {
            std::env::var("MT5700_WEBROOT").unwrap_or_else(|_| DEFAULT_WEB_ROOT.to_string())
        } else {
            w
        }
    };
    // 认证密钥：auth_key（新）与 websocket_auth_key（兼容旧配置键）取其一
    {
        let k = values.str("auth_key", "");
        cfg.http.auth_key = if k.is_empty() { values.str("websocket_auth_key", "") } else { k };
    }

    cfg.notification.wechat_webhook = values.str("wechat_webhook", "");
    cfg.notification.log_file = values.str("log_file", "");
    cfg.notification.types = NotifyTypes {
        sms: values.bool("notify_sms", true),
        call: values.bool("notify_call", true),
        memory_full: values.bool("notify_memory_full", true),
        signal: values.bool("notify_signal", true),
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
