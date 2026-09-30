//! 状态缓存的白名单：只对「只读、高频、非 读后写」的 AT 查询启用缓存。
//!
//! 设计边界：
//! - 仅缓存**查询**（带 ? 或纯查询指令）且对网络状态页高频轮询、且页面在写入后又
//!   会立刻读的指令**不能**缓存（例如 AT^LTEFREQLOCK? / AT^NRFREQLOCK? / AT+CPMS?），
//!   否则写入后读到的是旧缓存。
//! - 每条指令有自己的刷新周期（十一节），避免所有数据用同一个 polling interval。
//! - 键统一大写比较；`resolve` 在 fast-path 命中时毫秒级返回，冷启动才走一次 AT。

use std::time::Duration;

/// 一条可缓存指令的配置。
pub struct CacheRule {
    /// 指令原文（比较时统一转大写 + trim）。
    pub command: &'static str,
    /// 后台刷新周期。
    pub interval: Duration,
    /// 每次读取的「新鲜窗口」倍数。读取时年龄 <= interval * freshness 即直接命中缓存，
    /// 不会立刻触发 AT，从而把「前端每次刷新 = 一串阻塞 AT」改成「读内存立即返回」。
    pub freshness: u32,
    /// 主动保持刷新活跃的窗口倍数：间隔内没有读取则暂停该指令的后台刷新，省 CPU/AT。
    pub active: u32,
}

impl CacheRule {
    pub(crate) fn key(&self) -> String {
        self.command.trim().to_uppercase()
    }
}

/// 可缓存指令表（静态分配，返回 `&'static` 切片供缓存零拷贝引用）。
pub fn cache_rules() -> &'static [CacheRule] {
    static RULES: [CacheRule; 30] = [
        // 信号
        CacheRule { command: "AT^HCSQ?", interval: Duration::from_secs(1), freshness: 2, active: 4 },
        CacheRule { command: "AT+CSQ?", interval: Duration::from_secs(1), freshness: 2, active: 4 },
        // 注册状态
        CacheRule { command: "AT+C5GREG?", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        CacheRule { command: "AT+CEREG?", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        CacheRule { command: "AT+CREG?", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        CacheRule { command: "AT+CGREG?", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        // 小区 / 网络
        CacheRule { command: "AT^MONSC", interval: Duration::from_secs(3), freshness: 2, active: 4 },
        CacheRule { command: "AT^MONSSC", interval: Duration::from_secs(3), freshness: 2, active: 4 },
        CacheRule { command: "AT^CASCELLINFO?", interval: Duration::from_secs(3), freshness: 2, active: 4 },
        CacheRule { command: "AT^HFREQINFO?", interval: Duration::from_secs(3), freshness: 2, active: 4 },
        CacheRule { command: "AT^LENDC?", interval: Duration::from_secs(3), freshness: 2, active: 4 },
        CacheRule { command: "AT^TXPOWER?", interval: Duration::from_secs(3), freshness: 2, active: 4 },
        CacheRule { command: "AT^NTXPOWER?", interval: Duration::from_secs(3), freshness: 2, active: 4 },
        CacheRule { command: "AT^MONC", interval: Duration::from_secs(10), freshness: 2, active: 3 },
        CacheRule { command: "AT^PCOINFO", interval: Duration::from_secs(10), freshness: 2, active: 3 },
        // 数据面 / IP
        CacheRule { command: "AT^NDISSTATQRY?", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        CacheRule { command: "AT+CGACT?", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        CacheRule { command: "AT+CGPADDR", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        CacheRule { command: "AT^DHCP?", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        CacheRule { command: "AT^DHCPV6?", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        CacheRule { command: "AT^IPV6CAP?", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        CacheRule { command: "AT+CGDCONT?", interval: Duration::from_secs(10), freshness: 2, active: 3 },
        // 流量
        CacheRule { command: "AT^DSFLOWQRY", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        // 温度
        CacheRule { command: "AT^CHIPTEMP?", interval: Duration::from_secs(5), freshness: 2, active: 3 },
        // SIM / 设备 / 固件（低频）
        CacheRule { command: "AT^SIMSQ?", interval: Duration::from_secs(30), freshness: 2, active: 2 },
        CacheRule { command: "AT+CNUM?", interval: Duration::from_secs(30), freshness: 2, active: 2 },
        CacheRule { command: "AT^EMMSTATE?", interval: Duration::from_secs(10), freshness: 2, active: 3 },
        CacheRule { command: "AT^MCFGINFO?", interval: Duration::from_secs(60), freshness: 2, active: 2 },
        CacheRule { command: "AT+CGMR", interval: Duration::from_secs(60), freshness: 2, active: 2 },
        CacheRule { command: "AT^FOTASTATE?", interval: Duration::from_secs(60), freshness: 2, active: 2 },
    ];
    &RULES
}