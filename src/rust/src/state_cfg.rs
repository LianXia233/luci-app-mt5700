//! 状态缓存的白名单：只对「只读、高频、非 读后写」的 AT 查询启用缓存。
//!
//! 设计边界：
//! - 仅缓存**查询**（带 ? 或纯查询指令）且对网络状态页高频轮询、且页面在写入后又
//!   会立刻读的指令**不能**缓存（例如 AT^LTEFREQLOCK? / AT^NRFREQLOCK? / AT+CPMS?），
//!   否则写入后读到的是旧缓存。
//! - **状态机类指令一律不缓存**：AT^FOTASTATE? 的轮询每秒都在读同一个键，缓存会把
//!   升级进度冻结在一个旧状态（FOTA 指南要求实时跟踪 11/12/30/40/50 的迁移）；
//!   AT+CGMR 是升级完必须立刻回读的新版本号，AT+CGDCONT? 是 dial.js 写完 APN 就要
//!   重画的列表，两者同样属于「读后写 / 写后读」。
//! - 只保留前端真正发起过的指令：后台刷新只对「近期被读过」的条目生效（见 state.rs
//!   的 active 窗口），因此没人调用的指令既不会下发 AT，也留下一条永远不生效的死配置，
//!   还会让后来人误以为这些私有指令是插件支持的能力。
//! - 每条指令可配置独立的刷新周期（interval），避免所有数据共用一个 polling interval。
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
    static RULES: [CacheRule; 23] = [
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
        // 数据面 / IP
        CacheRule { command: "AT^NDISSTATQRY?", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        CacheRule { command: "AT+CGACT?", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        CacheRule { command: "AT+CGPADDR", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        CacheRule { command: "AT^DHCP?", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        CacheRule { command: "AT^DHCPV6?", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        CacheRule { command: "AT^IPV6CAP?", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        // 流量
        CacheRule { command: "AT^DSFLOWQRY", interval: Duration::from_secs(2), freshness: 2, active: 4 },
        // 温度
        CacheRule { command: "AT^CHIPTEMP?", interval: Duration::from_secs(5), freshness: 2, active: 3 },
        // SIM / 设备（低频）
        CacheRule { command: "AT^SIMSQ?", interval: Duration::from_secs(30), freshness: 2, active: 2 },
        CacheRule { command: "AT+CNUM?", interval: Duration::from_secs(30), freshness: 2, active: 2 },
    ];
    &RULES
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 白名单里绝不能出现的指令：状态机轮询、写后读、升级后要立刻回读的版本号。
    const FORBIDDEN: &[&str] = &[
        "AT^FOTASTATE?",
        "AT+CGMR",
        "AT+CGDCONT?",
        "AT+CPMS?",
        "AT^LTEFREQLOCK?",
        "AT^NRFREQLOCK?",
    ];

    #[test]
    fn rule_count_matches_declaration() {
        // 数组长度是手写的，增删规则时最容易漏改这一处
        assert_eq!(cache_rules().len(), 23);
    }

    #[test]
    fn no_state_machine_or_write_then_read_command_is_cached() {
        for cmd in FORBIDDEN {
            assert!(
                !cache_rules().iter().any(|r| r.key() == *cmd),
                "{cmd} 属于状态机或写后读指令，缓存会让界面读到旧值"
            );
        }
    }

    #[test]
    fn only_read_commands_are_cached() {
        // 带 = 的是设置指令，下发会改设备状态，绝不能被后台重放
        for rule in cache_rules() {
            assert!(
                !rule.command.contains('=') && !rule.command.contains('"'),
                "缓存白名单里不该有写指令：{}",
                rule.command
            );
        }
    }

    #[test]
    fn rule_keys_are_unique() {
        let mut keys: Vec<String> = cache_rules().iter().map(|r| r.key()).collect();
        keys.sort();
        let before = keys.len();
        keys.dedup();
        assert_eq!(before, keys.len(), "缓存白名单存在重复指令");
    }
}
