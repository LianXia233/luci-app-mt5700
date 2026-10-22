//! UCI 配置读取：一次 `uci show at-webserver` 取回整个配置段。
//! 键名与 Go 实现（config.go）以及 LuCI 页面完全一致。

use crate::logger::{self, Level};
use std::collections::HashMap;
use std::time::Duration;

pub const AUTO_SERIAL_PORT: &str = "auto";
pub const PREFERRED_AT_PORT: &str = "/dev/ttyUSB1";
/// 通知日志默认路径，与 root/etc/config/at-webserver 的 `option log_file` 保持一致。
pub const DEFAULT_NOTIFY_LOG: &str = "/tmp/at-notifications.log";

/// 单次 `uci` 子进程调用的墙钟预算（**唯一真源**）。
///
/// 定义在 config.rs 而非 schedconfig.rs：`schedconfig` 已经
/// `use crate::config::{…}`，反向引用会成环，所以常量只能放在最底层这个模块，
/// 由 schedconfig 引用（那边原先自己定义了一份同值常量，只能靠人肉同步）。
///
/// 为什么必须有这个超时：`uci` 会争用 `/var/lock/uci`，commit 还要写 flash。
/// 任何一处**不带超时**的 uci 调用挂住，都会让那条 RPC 的 handle_connection 任务
/// 永远停在 `.output().await` 上，而同一连接上后续所有请求（含前端每 1.5s 一次的
/// events 轮询）会全部堵在它后面 —— 表现为「点了保存之后这个页面再也不刷新」。
pub const UCI_TIMEOUT: Duration = Duration::from_secs(5);

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
    /// APDU 透传类命令（AT+CSIM / AT+CGLA / 逻辑通道管理）的应答超时。
    /// 这类命令的耗时由卡片决定，见 atclient::DEFAULT_APDU_TIMEOUT 的注释。
    pub apdu_timeout: Duration,
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
    /// 短信存储满时是否自动删除最旧的短信腾出空间（默认 true）。
    /// 关掉后存储满就只会推送通知，不做任何删除。
    pub sms_auto_clean: bool,
}

#[derive(Debug, Clone)]
pub struct WebSocketConfig {
    pub port: u16,
    pub auth_key: String,
    pub allow_wan: bool,
    /// RPC 监听地址：127.0.0.1（默认）或 0.0.0.0（allow_wan / websocket_bind）
    pub bind: String,
    /// bind 是否因安全策略被从对外地址降回 127.0.0.1（见 load_config 的兜底）。
    /// 仅用于启动日志把「为什么没按配置监听」说清楚。
    pub bind_downgraded: bool,
    /// 一次 ^CELLSCAN 允许跑多久
    pub scan_timeout: Duration,
}

/// 是否只监听本机。
pub fn is_loopback(addr: &str) -> bool {
    let a = addr.trim();
    a == "127.0.0.1" || a == "::1" || a.eq_ignore_ascii_case("localhost")
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

/// 扫频超时的默认值：rpcserver 的回退值与这里的默认配置共用一份
/// （A-B5，2026-10-22 审计：同值两处会静默漂移）。
pub const DEFAULT_SCAN_TIMEOUT: Duration = Duration::from_secs(180);

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
                // 默认走自动探测：UCI 默认配置与前端默认值都是 'auto'，
                // 这里此前写死 ttyUSB1，一旦 UCI 读取失败就会跳过探测死盯这一个口，
                // 而该口不存在或不回 AT 时服务永远连不上。
                // auto 的候选排序仍把 ttyUSB1 排在最前（见 serialdetect），无额外开销。
                port: AUTO_SERIAL_PORT.into(),
                baudrate: 115200,
                timeout: Duration::from_secs(10),
            },
            // 自动拨号默认开启：模组不拨号则 USB 网口不会有 DHCP，接口拿不到 IP
            autodial_enable: true,
            autodial_mode: 1,
            apdu_timeout: crate::atclient::DEFAULT_APDU_TIMEOUT,
        },
        notification: NotificationConfig {
            wechat_webhook: String::new(),
            // 与 UCI 的 option log_file 对齐：此前默认空串，UCI 读不到时
            // 通知日志会被静默关闭，与文档和界面行为都不一致。
            log_file: DEFAULT_NOTIFY_LOG.into(),
            types: NotifyTypes {
                sms: true,
                call: true,
                memory_full: true,
                signal: true,
            },
            sms_auto_clean: true,
        },
        websocket: WebSocketConfig {
            port: 8765,
            auth_key: String::new(),
            allow_wan: false,
            bind: "127.0.0.1".into(),
            bind_downgraded: false,
            scan_timeout: DEFAULT_SCAN_TIMEOUT,
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

/// 用一次 `uci show at-webserver` 取回整个配置段。
pub async fn uci_values() -> Result<UciReader, String> {
    // 与 Go 版一致：加超时，避免 uci 命令异常挂起卡死启动。
    //
    // ★ kill_on_drop(true) 与超时**同等重要**（理由与 schedconfig.rs 的 uci_run 相同）：
    //   超时只是 drop 掉 future，并**不会**杀掉子进程 —— 那个 uci 仍会继续跑、
    //   仍持有 /var/lock/uci，于是之后每一次 uci 调用都得排队等它。
    //   让它随 future 一起结束，失败就是干净的失败。
    let out = tokio::time::timeout(
        UCI_TIMEOUT,
        tokio::process::Command::new("uci")
            .args(["show", "at-webserver"])
            .kill_on_drop(true)
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
            if let Some(rest) = key.strip_prefix(prefix) {
                values.insert(rest.to_string(), unquote_uci(raw));
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
    // 下界取 9600（最小支持档位），原先的 0 会让非法值一路通过校验，
    // 直到 open_serial 才失败。非支持档位的兜底回退在 serial_linux::open_serial 内。
    cfg.at.serial.baudrate = values.int("serial_baudrate", 115200).clamp(9600, 4000000) as u32;
    cfg.at.serial.timeout = values.seconds("serial_timeout", cfg.at.serial.timeout, Duration::from_secs(1));
    /*
     * APDU 应答超时：eSIM 下载/写卡时卡侧可能耗时数秒（见 atclient 的注释）。
     * 下限取 2 秒（与 COMMAND_TIMEOUT 对齐）—— 防止把「写卡必然超时」配出来；
     * 上限不限：卡片越慢，用户越需要给足时间。
     */
    cfg.at.apdu_timeout = values.seconds(
        "apdu_timeout",
        cfg.at.apdu_timeout,
        crate::atclient::COMMAND_TIMEOUT,
    );

    // 自动拨号：默认开启。模组不拨号则不会给 USB 网口下发 DHCP，接口拿不到 IP。
    // （★ 2026-09-28：这两行原先**整段重复了两遍**，连注释都一字不差 —— 大概是
    //   某次编辑粘了两遍。值一样所以行为无害，但属明确冗余；已删去重复的一份。）
    cfg.at.autodial_enable = values.bool("autodial_enable", true);
    cfg.at.autodial_mode = values.int("autodial_mode", 1).clamp(1, 2);
    /*
     * 此处原先有一行注释宣称「SIM 卡状态自愈：默认开启，且每次开机最多执行一次」——
     * 那个配置项和功能**已于 v1.1.0 删除**（提交 07553ce「删除 SIM 卡状态自愈，
     * 并把 SIM 状态 11 改回『不是故障』」，理由：无效、无收益、有掉网风险），
     * 只是注释忘在这里。它用现在时描述一个不存在的功能，会让人以为漏读了配置。
     * 回归守卫见 tests/sim-status-contract.test.js 第 5 节。
     */

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

    /*
     * 安全兜底：对外监听 + 没有访问密钥 = 任何能连到这个端口的人都能直接下发
     * AT 命令（复位模组、改锁频、读短信，全都不要认证）。这不该是默认行为，
     * 所以要求显式确认：设了 websocket_allow_insecure=1 才真的对外监听。
     *
     * 回退到回环**不影响 LuCI**：页面是经 rpcd/ucode 走 127.0.0.1 访问后端的，
     * 只有「外部程序直连 8765」这一种用法会受影响，而它正是要被挡住的那一种。
     * 真想要无认证对外监听，加一行 uci 即可，日志里会写明。
     */
    let allow_insecure = values.bool("websocket_allow_insecure", false);
    cfg.websocket.bind_downgraded = false;
    if !is_loopback(&cfg.websocket.bind)
        && cfg.websocket.auth_key.is_empty()
        && !allow_insecure
    {
        cfg.websocket.bind = "127.0.0.1".into();
        cfg.websocket.bind_downgraded = true;
    }
    // 下限 10 秒而不是默认 3 分钟：用户配置的小于 3 分钟的值不能被悄悄抬回。
    cfg.websocket.scan_timeout = values.seconds("cellscan_timeout", cfg.websocket.scan_timeout, Duration::from_secs(10));

    cfg.notification.wechat_webhook = values.str("wechat_webhook", "");
    cfg.notification.log_file = values.str("log_file", DEFAULT_NOTIFY_LOG);
    cfg.notification.types = NotifyTypes {
        sms: values.bool("notify_sms", true),
        call: values.bool("notify_call", true),
        memory_full: values.bool("notify_memory_full", true),
        signal: values.bool("notify_signal", true),
    };
    cfg.notification.sms_auto_clean = values.bool("sms_auto_clean", true);

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
