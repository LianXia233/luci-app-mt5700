//! 异步状态缓存（Async State Cache）。
//!
//! 目标（对应 MT5700 异步化架构的「状态采集异步化 / 数据缓存异步更新 / 请求去重」）：
//!   前端每 5s 的网络状态刷新会串行发一大堆只读 AT 查询；
//!   反复查询同一指令、且查询本身还要排队 + 等模组应答，既慢又重复。
//! 本模块把「读缓存」与「写模组」分离：
//!   - 后台单任务按各自刷新周期预热白名单内指令；
//!   - 前端 RPC 读取走缓存（新鲜命中即毫秒级返回，不下发 AT）；
//!   - 同一指令的并发读取通过 per-command 锁去重，一个时间窗只发一条 AT；
//!   - 模组断开时清空缓存，避免跨重连的陈旧数据；
//!   - 只刷新「最近仍被读取」的指令，页面离开后自动停止后台轮询，省 CPU/AT。

use crate::{log_debug, log_warn};
use crate::atclient::AtClient;
use crate::state_cfg::{CacheRule, cache_rules};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock, watch};

/// 一条缓存条目。
#[derive(Clone)]
struct Entry {
    /// 模组返回的完整应答行（不含命令回显），与 live 路径语义一致。
    lines: Vec<String>,
    /// 最近一次成功抓取时刻（后台刷新成功后也更新）。
    fetched_at: Instant,
    /// 最近一次被读取时刻；用于决定该指令是否仍需保持后台活跃。
    last_read: Instant,
}

pub struct StateCache {
    client: Arc<AtClient>,
    /// 每条可缓存指令的刷新规则（白名单），直接引用静态表，零拷贝。
    rules: HashMap<String, &'static CacheRule>,
    /// command -> 缓存条目。
    entries: RwLock<HashMap<String, Entry>>,
    /// command -> per-command 锁，用于同一指令并发读取去重。
    locks: RwLock<HashMap<String, Arc<Mutex<()>>>>,
    ctx: watch::Receiver<bool>,
}

/// 最近一次『连接 -> 断开』翻转已清除过缓存；避免每个周期重复清空。
#[derive(Default)]
struct LoopState {
    prev_connected: bool,
}

impl StateCache {
    pub fn new(client: Arc<AtClient>, ctx: watch::Receiver<bool>) -> Arc<StateCache> {
        // 直接引用静态表（&'static），键为统一大写后的指令，零拷贝。
        let rules = cache_rules()
            .iter()
            .map(|r| (r.key(), r))
            .collect();
        Arc::new(StateCache {
            client,
            rules,
            entries: RwLock::new(HashMap::new()),
            locks: RwLock::new(HashMap::new()),
            ctx,
        })
    }

    /// 该指令是否在白名单（可缓存）。目前主要由测试直接断言；业务读取统一走 `resolve`。
    #[allow(dead_code)]
    pub fn is_cacheable(&self, command: &str) -> bool {
        self.rules.contains_key(&command.trim().to_uppercase())
    }

    fn rule(&self, command: &str) -> Option<&'static CacheRule> {
        self.rules.get(&command.trim().to_uppercase()).copied()
    }

    async fn entry(&self, key: &str) -> Option<Entry> {
        self.entries.read().await.get(key).cloned()
    }

    async fn touch_read(&self, key: &str) {
        if let Some(e) = self.entries.write().await.get_mut(key) {
            e.last_read = Instant::now();
        }
    }

    /// 快速命中：条目存在且年龄 <= interval * freshness。
    async fn fresh_hit(&self, key: &str, rule: &CacheRule) -> Option<Vec<String>> {
        let e = self.entry(key).await?;
        if e.fetched_at.elapsed() <= rule.interval.saturating_mul(rule.freshness) {
            return Some(e.lines);
        }
        None
    }

    /// 取 per-command 去重锁。
    async fn fetch_lock(&self, key: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.write().await;
        locks
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// 真正下发一次 AT 并写入缓存。per-command 锁内串行，避免同一指令并发重发。
    async fn do_fetch(&self, key: &str, rule: &CacheRule) -> Result<(), String> {
        let lock = self.fetch_lock(key).await;
        let _guard = lock.lock().await;

        // 双检：等锁期间可能已被其它读取/后台刷新写好，避免重复下发。
        if let Some(e) = self.entry(key).await {
            if e.fetched_at.elapsed() <= rule.interval.saturating_mul(rule.freshness) {
                return Ok(());
            }
        }

        if !self.client.connected() {
            return Err("AT 通道未连接".into());
        }

        // 扫频/锁频等长命令独占通道：此时不下发新的 AT，以免排队阻塞，
        // 改由新鲜窗口内的旧缓存顶住（见 resolve 的 long-command 分支）。
        if self.client.long_command_active() {
            return Err("模组正忙（长命令进行中），暂不刷新缓存".into());
        }

        let resp = self
            .client
            // 后台缓存刷新：Low 优先级，绝不抢占用户终端的 High 与状态查询的 Normal。
            .send_command_pri(
                &self.ctx,
                crate::at_queue::AtPriority::Low,
                rule.command,
                rule.interval,
                None,
            )
            .await
            .map_err(|e| e.to_string())?;
        let lines = resp.lines;
        self.entries.write().await.insert(
            key.to_string(),
            Entry { lines, fetched_at: Instant::now(), last_read: Instant::now() },
        );
        Ok(())
    }

    /// 读穿接口：返回 `Some(text)` 表示从缓存/一次抓取得到结果（毫秒级命中）；
    /// 返回 `Ok(None)` 表示该指令不在白名单，调用方走原有 live 路径；
    /// 返回 `Err(msg)` 表示白名单内但抓取失败（如未连接 / 模组正忙），调用方可回退或报错。
    pub async fn resolve(&self, command: &str) -> Result<Option<String>, String> {
        let key = command.trim().to_uppercase();
        let Some(rule) = self.rule(&key) else {
            return Ok(None);
        };

        // 长命令进行中：尽量用已有缓存（哪怕略旧），避免阻塞通道。
        if self.client.long_command_active() {
            if let Some(e) = self.entry(&key).await {
                self.touch_read(&key).await;
                return Ok(Some(e.lines.join("\r\n")));
            }
            return Err("模组正忙（长命令进行中），暂无缓存可读".into());
        }

        // fast path：新鲜命中直接返回，不下发 AT。
        if let Some(lines) = self.fresh_hit(&key, rule).await {
            self.touch_read(&key).await;
            return Ok(Some(lines.join("\r\n")));
        }

        // slow path：只读一次 AT 并回填缓存（去重），随后从缓存返回。
        match self.do_fetch(&key, rule).await {
            Ok(()) => {
                let text = self
                    .entry(&key)
                    .await
                    .map(|e| e.lines.join("\r\n"))
                    .unwrap_or_default();
                Ok(Some(text))
            }
            Err(e) => Err(e),
        }
    }

    /// 清空缓存（模组断开 / 重连语义）。
    pub async fn clear(&self) {
        self.entries.write().await.clear();
    }

    /// 后台刷新单任务：按各指令刷新周期预热「最近仍被读取」的指令。
    /// 整进程仅一个任务；页面离开后指令因 `last_read` 过期而自动停止刷新。
    pub async fn run(self: Arc<Self>, mut ctx: watch::Receiver<bool>) {
        let tick = Duration::from_secs(1);
        let mut loop_state = LoopState { prev_connected: self.client.connected() };

        loop {
            tokio::select! {
                _ = tokio::time::sleep(tick) => {}
                _ = ctx.changed() => return,
            }

            let connected = self.client.connected();
            if !connected && loop_state.prev_connected {
                log_warn!("模组连接断开，清空状态缓存");
                self.clear().await;
            }
            loop_state.prev_connected = connected;
            if !connected {
                continue;
            }

            // 收集仍活跃（最近被读取）的指令。
            let active: Vec<(String, Duration)> = {
                let entries = self.entries.read().await;
                self.rules
                    .iter()
                    .filter(|(key, rule)| {
                        entries
                            .get(*key)
                            .map(|e| e.last_read.elapsed() <= rule.interval.saturating_mul(rule.active))
                            .unwrap_or(false)
                    })
                    .map(|(key, rule)| (key.clone(), rule.interval))
                    .collect()
            };

            for (key, interval) in active {
                // 后台按自身刷新周期(interval)预热；超过一个周期才需要刷新。
                let overdue = match self.entry(&key).await {
                    Some(e) => e.fetched_at.elapsed() > interval,
                    None => true,
                };
                if !overdue {
                    continue;
                }
                if let Err(e) = self.do_fetch(&key, self.rule(&key).expect("active 来自 rules")).await {
                    log_debug!("缓存刷新 {} 失败: {}", key, e);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config;
    use crate::atclient::Unsolicited;
    use tokio::sync::watch;

    // 说明：StateCache 的去重/新鲜/命中逻辑不依赖真实模组，
    // 通过对空缓存 + 命中路径的断言覆盖核心语义。
    #[tokio::test]
    async fn white_list_and_key_normalization() {
        let (tx, _rx) = tokio::sync::mpsc::channel::<Unsolicited>(8);
        let client = AtClient::new(config::default_config().at, tx);
        let (_ctx_tx, ctx) = watch::channel(false);
        let cache = StateCache::new(client, ctx);

        assert!(cache.is_cacheable("AT^HCSQ?"));
        assert!(cache.is_cacheable("  at^hcsq?  "));
        assert!(!cache.is_cacheable("AT^LTEFREQLOCK?"));
        assert!(!cache.is_cacheable("AT+CMGL=4"));
        assert_eq!(cache.resolve("AT+CPMS?").await.unwrap(), None);
    }

    #[tokio::test]
    async fn resolve_uncached_command_falls_through() {
        let (tx, _rx) = tokio::sync::mpsc::channel::<Unsolicited>(8);
        let client = AtClient::new(config::default_config().at, tx);
        let (_ctx_tx, ctx) = watch::channel(false);
        let cache = StateCache::new(client, ctx);

        let r = cache.resolve("AT+CPMS?").await.unwrap();
        assert!(r.is_none(), "非白名单指令应返回 None 走 live 路径");
    }

    #[tokio::test]
    async fn cached_command_not_connected_reports_error() {
        let (tx, _rx) = tokio::sync::mpsc::channel::<Unsolicited>(8);
        let client = AtClient::new(config::default_config().at, tx);
        let (_ctx_tx, ctx) = watch::channel(false);
        let cache = StateCache::new(client, ctx);

        // 未连接且冷缓存：返回 Err（白名单内，但抓取失败）
        let r = cache.resolve("AT^HCSQ?").await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn freshness_server_path_returns_immediately() {
        let (tx, _rx) = tokio::sync::mpsc::channel::<Unsolicited>(8);
        let client = AtClient::new(config::default_config().at, tx);
        let (_ctx_tx, ctx) = watch::channel(false);
        let cache = StateCache::new(client, ctx);
        cache
            .entries
            .write()
            .await
            .insert("AT^HCSQ?".to_string(), Entry {
                lines: vec![r#""NR",77,236,31"#.to_string(), "OK".to_string()],
                fetched_at: Instant::now(),
                last_read: Instant::now(),
            });

        // 新鲜命中：直接返回缓存文本。
        let r = cache.resolve("at^hcsq?").await.unwrap().unwrap();
        assert!(r.contains("77,236,31"), "应返回缓存内容，实际: {r}");
    }

    #[tokio::test]
    async fn clear_empties_cache() {
        let (tx, _rx) = tokio::sync::mpsc::channel::<Unsolicited>(8);
        let client = AtClient::new(config::default_config().at, tx);
        let (_ctx_tx, ctx) = watch::channel(false);
        let cache = StateCache::new(client, ctx);
        cache
            .entries
            .write()
            .await
            .insert("AT^HCSQ?".into(), Entry { lines: vec![], fetched_at: Instant::now(), last_read: Instant::now() });
        cache.clear().await;
        assert!(cache.entries.read().await.is_empty());
    }
}