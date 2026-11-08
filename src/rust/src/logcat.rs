//! 日志类别（细分）与「这条日志该往哪儿写」的策略表。
//!
//! # 为什么需要这一层
//!
//! 改之前所有日志走同一条路：入内存环形缓冲，再按级别 `eprintln!` 到 stderr，
//! 由 procd/logd 收进 syslog。后果是 `logread` 里混满了 AT 收发、短信正文、
//! 信号巡检这类**模组业务痕迹**，把「软件自己出了什么事」冲得看不见；
//! 而业务痕迹本身又受 syslog 滚动策略摆布，留不住。
//!
//! 本模块把日志按业务域细分成 [`Category`]，并给每个类别定两条策略：
//!
//! | 分组 | 含义 | 内存环形缓冲 | 插件日志文件 | syslog |
//! | --- | --- | --- | --- | --- |
//! | [`Group::Runtime`] | 软件自身运行情况（启动/配置/RPC/串口/任务/存储） | ✅ | ❌（syslog 已有，不重复占空间） | ✅ 按全局级别 |
//! | [`Group::Business`] | 模组与网络的业务痕迹（AT/短信/拨号/信号/通知…） | ✅ | ✅ 有界追加 | ⚠️ 仅 `ERR` |
//!
//! 也就是说：**业务日志不再刷 syslog**，改由插件自己的文件（`/tmp` 下有界）承载，
//! 内存环形缓冲照旧，日志页两个来源都能看到。业务类的 `ERR` 仍破例进 syslog ——
//! 否则运维在 `logread` 里连「短信发送失败」这种硬故障都看不到，属于倒退。
//!
//! # 类别从哪来
//!
//! 两条路，优先级从高到低：
//!   1. 调用点显式指定：`log_info!(Cat::Sms, "…")`；
//!   2. 未指定时按 `module_path!()` 推导（[`Category::from_module`]）。
//!
//! 推导是编译期常量字符串比较，不产生运行时开销；显式指定用于「一个模块横跨多个
//! 业务域」的场景（如 `main` 里同时有启动、拨号、接口三类日志）。
//! 无法识别的模块一律落到 [`Category::Misc`]，而 `Misc` 属 Runtime 分组 ——
//! 这是刻意的兜底：**没被分类到的日志行为与改动前完全一致**，不会因为漏标而从 syslog 消失。

/// 日志分组：决定这条日志走哪些输出通道。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Group {
    /// 软件自身运行情况。
    Runtime,
    /// 模组 / 网络的业务痕迹。
    Business,
}

impl Group {
    /// 分组的稳定小写标识：随 `logs` RPC 的类别清单下发给前端，
    /// 前端据此把类别按钮分成「软件运行 / 业务痕迹」两栏。
    pub fn key(self) -> &'static str {
        match self {
            Group::Runtime => "runtime",
            Group::Business => "business",
        }
    }
}

/// 细分后的日志类别。
///
/// 新增类别时**四处都要补**：本枚举、[`Category::key`]、[`Category::code`]、
/// [`Category::group`]、[`ALL`]，以及 `Category::from_module` 的模块映射。
/// `tests/log-category-test.js` 会拿前端 `logs.js` 的类别表与这里对账，漏补会挂测试。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Category {
    /* ---------------- Runtime：软件自身运行情况 ---------------- */
    /// 进程生命周期：启动、版本、退出、信号、panic 兜底。
    Runtime,
    /// UCI 读写、配置解析与热更新、参数校验失败。
    Config,
    /// RPC 服务：监听、连接、方法分发、鉴权。
    Rpc,
    /// 串口与设备节点：打开/关闭、termios、自动探测、设备消失。
    Serial,
    /// 异步任务编排：扫频/升级等长任务的提交、取消、超时。
    Task,
    /// 本地存储：文件读写、配额、加密归档落盘。
    Storage,
    /// 未归类。**故意属 Runtime**：漏标的日志保持改动前行为，仍进 syslog。
    Misc,

    /* ---------------- Business：模组与网络的业务痕迹 ---------------- */
    /// AT 通道事务：发送/接收/回显/超时/重试。
    At,
    /// 模组主动上报（URC）的接收与分发。
    Urc,
    /// 自动拨号、对账、退避重拨、APN / PDP 承载。
    Dial,
    /// 承载接口、防火墙区域、DNS 下发、hotplug 协作。
    Net,
    /// 信号采集、综合评分、载波聚合、芯片温度。
    Signal,
    /// SIM 卡状态、PIN、卡槽切换、ICCID / IMSI。
    Sim,
    /// 短信收发、PDU 编解码、存储区与归档。
    Sms,
    /// 来电与通话状态。
    Call,
    /// 事件通知推送：企业微信 / QQ 通道、模板、节流。
    Notify,
    /// 全网扫频。
    Scan,
    /// 定时锁频编排。
    Schedule,
    /// 模组固件升级（FOTA）与刷写。
    Firmware,
    /// 流量与使用量统计。
    Usage,
    /// 时间与时区：NTP 对时、模组时间、本地时间换算。
    Time,
}

/// 全部类别，顺序即前端类别条的展示顺序（Runtime 组在前、Business 组在后由 [`Group`] 决定）。
pub const ALL: [Category; 21] = [
    Category::Runtime,
    Category::Config,
    Category::Rpc,
    Category::Serial,
    Category::Task,
    Category::Storage,
    Category::Misc,
    Category::At,
    Category::Urc,
    Category::Dial,
    Category::Net,
    Category::Signal,
    Category::Sim,
    Category::Sms,
    Category::Call,
    Category::Notify,
    Category::Scan,
    Category::Schedule,
    Category::Firmware,
    Category::Usage,
    Category::Time,
];

// 日志宏里写的 `Cat::Sms`，其 `Cat` 只是一个**字面量标记**，由宏在展开前拦截，
// 不参与名字解析 —— 所以调用点不需要 `use` 任何东西，本模块也不必真的导出一个
// 叫 `Cat` 的别名（早先导出过一个，结果它永远「未使用」，纯属误导，已删）。
impl Category {
    /// 稳定小写标识。**这是跨进程契约**：写进环形缓冲的 `cat` 字段、
    /// RPC 过滤参数、前端类别键都用它，改名等于破坏兼容。
    pub fn key(self) -> &'static str {
        match self {
            Category::Runtime => "runtime",
            Category::Config => "config",
            Category::Rpc => "rpc",
            Category::Serial => "serial",
            Category::Task => "task",
            Category::Storage => "storage",
            Category::Misc => "misc",
            Category::At => "at",
            Category::Urc => "urc",
            Category::Dial => "dial",
            Category::Net => "net",
            Category::Signal => "signal",
            Category::Sim => "sim",
            Category::Sms => "sms",
            Category::Call => "call",
            Category::Notify => "notify",
            Category::Scan => "scan",
            Category::Schedule => "schedule",
            Category::Firmware => "firmware",
            Category::Usage => "usage",
            Category::Time => "time",
        }
    }

    /// 日志行里的短标签（等宽大写，方便肉眼扫一列）。
    pub fn code(self) -> &'static str {
        match self {
            Category::Runtime => "RT",
            Category::Config => "CFG",
            Category::Rpc => "RPC",
            Category::Serial => "TTY",
            Category::Task => "TSK",
            Category::Storage => "STO",
            Category::Misc => "MISC",
            Category::At => "AT",
            Category::Urc => "URC",
            Category::Dial => "DIAL",
            Category::Net => "NET",
            Category::Signal => "SIG",
            Category::Sim => "SIM",
            Category::Sms => "SMS",
            Category::Call => "CALL",
            Category::Notify => "NTF",
            Category::Scan => "SCAN",
            Category::Schedule => "SCH",
            Category::Firmware => "FOTA",
            Category::Usage => "USAGE",
            Category::Time => "TIME",
        }
    }

    pub fn group(self) -> Group {
        match self {
            Category::Runtime
            | Category::Config
            | Category::Rpc
            | Category::Serial
            | Category::Task
            | Category::Storage
            | Category::Misc => Group::Runtime,
            Category::At
            | Category::Urc
            | Category::Dial
            | Category::Net
            | Category::Signal
            | Category::Sim
            | Category::Sms
            | Category::Call
            | Category::Notify
            | Category::Scan
            | Category::Schedule
            | Category::Firmware
            | Category::Usage
            | Category::Time => Group::Business,
        }
    }

    /// 是否写插件自己的日志文件。业务痕迹要落盘（syslog 里没有），
    /// Runtime 组不落盘 —— 它本来就进 syslog，再写一份纯属浪费 `/tmp`。
    pub fn persists_to_file(self) -> bool {
        self.group() == Group::Business
    }

    /// 这个类别进 syslog 的**级别地板**：低于它的级别一律不进 syslog。
    ///
    /// - Runtime 组 → [`Level::Debug`]，即不设类别级门槛，完全由全局日志级别决定
    ///   （与改动前行为一致）；
    /// - Business 组 → [`Level::Error`]，业务痕迹默认不刷 syslog，只有硬故障破例外发，
    ///   保证 `logread` 里仍看得到「短信发送失败」这类真问题。
    ///
    /// 内存环形缓冲不受此地板约束 —— 所有级别都留一份，日志页才看得到过程细节。
    pub fn syslog_floor(self) -> crate::logger::Level {
        match self.group() {
            Group::Runtime => crate::logger::Level::Debug,
            Group::Business => crate::logger::Level::Error,
        }
    }

    /// 由稳定标识反查类别。用于 RPC 过滤参数与配置项，未知值返回 `None`。
    pub fn from_key(key: &str) -> Option<Category> {
        ALL.into_iter().find(|c| c.key() == key)
    }

    /// 由 `module_path!()` 推导默认类别。
    ///
    /// `module_path!()` 形如 `at_webserver::sms` 或 `at_webserver::sms::tests`，
    /// 取**紧跟 crate 名之后**的那一段（即顶层模块名），这样 `#[cfg(test)] mod tests`
    /// 里的日志也会归到它所属的业务模块，而不是统统变成 `tests`。
    /// 只有一段时说明就在 crate 根（`main.rs`），按 Runtime 处理。
    pub fn from_module(path: &str) -> Category {
        let mut segs = path.split("::");
        let first = segs.next().unwrap_or("");
        // 单段 = crate 根（main.rs）→ 进程运行时；多段则取第二段作为顶层模块名。
        let module = match segs.next() {
            Some(m) => m,
            None => return if first.is_empty() { Category::Misc } else { Category::Runtime },
        };
        match module {
            "main" | "logger" | "logcat" | "ringlog" | "state" | "state_cfg" => Category::Runtime,
            "config" => Category::Config,
            "async_runtime" => Category::Task,
            "rpcserver" => Category::Rpc,
            "serial_linux" | "serialdetect" | "transport" => Category::Serial,
            "atclient" | "at_queue" => Category::At,
            "urc" => Category::Urc,
            "sms" | "pdu" | "sms_store" => Category::Sms,
            "notify" | "qqpush" | "qqbind" | "timerpush" => Category::Notify,
            "signalwatch" | "signalgrade" => Category::Signal,
            "schedule" | "schedconfig" => Category::Schedule,
            "usage" | "monthly" => Category::Usage,
            "nettime" | "localtime" => Category::Time,
            // 未识别的模块落到 Misc（Runtime 分组）：保持改动前的 syslog 行为，
            // 避免新增模块忘记登记就把日志从系统日志里悄悄弄丢。
            _ => Category::Misc,
        }
    }
}

/// 类别清单，随 `logs` RPC 一并下发。
///
/// 只给**结构**（`key` / `code` / `group`），刻意不给中文标签：界面文案留在前端
/// `logs.js`，那边才能走 `po/` 翻译；后端再存一份中文只会造成两处措辞漂移。
/// 前端拿到清单后按 `group` 分栏渲染类别按钮，于是后端新增类别时界面自动多出一个
/// 筛选项（标签缺失则退化成显示 `key`），不必两边同时改。
pub fn table() -> Vec<serde_json::Value> {
    ALL.iter()
        .map(|c| serde_json::json!({ "key": c.key(), "code": c.code(), "group": c.group().key() }))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_category_has_unique_key_and_code() {
        let mut keys: Vec<&str> = Vec::new();
        let mut codes: Vec<&str> = Vec::new();
        for c in ALL {
            assert!(!c.key().is_empty(), "{c:?} 缺 key");
            assert!(!c.code().is_empty(), "{c:?} 缺 code");
            assert!(c.key().chars().all(|ch| ch.is_ascii_lowercase() || ch == '_'),
                "key 必须是稳定小写标识，{} 不合规", c.key());
            assert!(!keys.contains(&c.key()), "key 重复: {}", c.key());
            assert!(!codes.contains(&c.code()), "code 重复: {}", c.code());
            keys.push(c.key());
            codes.push(c.code());
        }
        assert_eq!(keys.len(), ALL.len());
    }

    #[test]
    fn from_key_round_trips_every_category() {
        for c in ALL {
            assert_eq!(Category::from_key(c.key()), Some(c), "{} 反查失败", c.key());
        }
        assert_eq!(Category::from_key("不存在的类别"), None);
        assert_eq!(Category::from_key(""), None);
        // 大小写敏感：key 是契约，不接受宽松匹配
        assert_eq!(Category::from_key("SMS"), None);
    }

    #[test]
    fn business_categories_never_reach_syslog_below_error() {
        use crate::logger::Level;
        for c in ALL {
            match c.group() {
                Group::Business => {
                    assert_eq!(c.syslog_floor(), Level::Error,
                        "{:?} 属业务类，只有 ERR 才允许进 syslog", c);
                    assert!(c.persists_to_file(), "{:?} 属业务类，必须落插件文件", c);
                }
                Group::Runtime => {
                    assert_eq!(c.syslog_floor(), Level::Debug,
                        "{:?} 属运行时，syslog 门槛应交给全局级别", c);
                    assert!(!c.persists_to_file(), "{:?} 已进 syslog，不该再占 /tmp", c);
                }
            }
        }
    }

    #[test]
    fn misc_is_runtime_so_unclassified_logs_keep_old_behaviour() {
        // 兜底类别必须在 Runtime 组：漏标的日志行为与改动前一致，仍进 syslog
        assert_eq!(Category::Misc.group(), Group::Runtime);
        assert_eq!(Category::from_module("at_webserver::some_brand_new_module"), Category::Misc);
        assert_eq!(Category::from_module("totally::unknown"), Category::Misc);
    }

    #[test]
    fn module_mapping_covers_every_module_declared_in_main() {
        // main.rs 里 mod 声明的模块必须全部登记，否则会静默落进 Misc
        let declared = [
            "async_runtime", "at_queue", "atclient", "config", "logger", "localtime", "logcat",
            "monthly", "nettime", "notify", "pdu", "qqbind", "qqpush", "ringlog", "rpcserver",
            "schedconfig", "schedule", "serial_linux", "serialdetect", "signalgrade",
            "signalwatch", "sms", "sms_store", "state", "state_cfg", "transport", "urc", "usage",
        ];
        for m in declared {
            let cat = Category::from_module(&format!("at_webserver::{m}"));
            assert_ne!(cat, Category::Misc, "模块 {m} 未登记类别映射");
        }
    }

    #[test]
    fn module_mapping_ignores_nested_test_module() {
        // `#[cfg(test)] mod tests` 里的日志应归到所属业务模块
        assert_eq!(Category::from_module("at_webserver::sms::tests"), Category::Sms);
        assert_eq!(Category::from_module("at_webserver::usage::tests"), Category::Usage);
        // crate 根（main.rs）→ Runtime
        assert_eq!(Category::from_module("at_webserver"), Category::Runtime);
    }

    #[test]
    fn module_mapping_is_fine_grained_not_one_bucket() {
        // 「细分」的硬指标：模块映射至少覆盖 8 个不同类别
        let mut seen: Vec<Category> = Vec::new();
        for m in [
            "atclient", "urc", "sms", "notify", "signalwatch", "schedule", "usage", "config",
            "rpcserver", "serialdetect", "nettime", "main",
        ] {
            let c = Category::from_module(&format!("at_webserver::{m}"));
            if !seen.contains(&c) {
                seen.push(c);
            }
        }
        assert!(seen.len() >= 8, "模块默认类别过于粗，仅 {} 种", seen.len());
    }

    #[test]
    fn group_keys_are_stable() {
        assert_eq!(Group::Runtime.key(), "runtime");
        assert_eq!(Group::Business.key(), "business");
    }
}
