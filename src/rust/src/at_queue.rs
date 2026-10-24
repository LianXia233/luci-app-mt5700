//! AT 请求优先级门（Priority Gate）与短信优先调度。
//!
//! 所有业务模块（RPC、缓存刷新、定时任务、自动拨号等）都通过这里申请独占模组通道的
//! 使用权，由同一把异步锁按**优先级**放行，而不是谁先抢到锁谁先执行。
//!
//! 优先级约定（与需求文档一致）：
//!   - Sms        ：短信收发相关（最高，仅在短信事务/短信读任务中使用）
//!   - High       ：AT Console 用户主动操作、紧急恢复
//!   - Normal     ：状态查询、网络信息、SIM 信息
//!   - Low        ：后台统计、温度采集、周期性状态刷新
//!   - Background ：扫频、频段分析、历史统计
//!
//! 设计要点：
//!   - 完全异步，排队的等待者不再自旋占 CPU；
//!   - `acquire` 自带超时与上下文取消，超时或被取消即从队列撤出、让出通道；
//!   - 用 Notify + 显式 pump 派发，取消者直接从堆里移除，不会占着不放。
//!
//! 短信优先由两层构成（缺一不可）：
//!   1. [SmsMode] ——「暂停门」。短信中心进入活动状态时登记租约，非短信命令在
//!      申请通道前必须等模式解除；这样一来后台轮询不会在短信操作期间插队。
//!      租约带 TTL 且由后台清扫，前端忘记释放也会自动失效，不会永久停止轮询。
//!   2. [SmsTransaction] ——「事务锁」。一次多步骤短信操作（如长短信分片发送、
//!      批量删除）全程持有 [GatePermit]，中间不释放，杜绝其它命令插入事务中间。

use std::cmp::Ordering as CmpOrdering;
use std::collections::{BinaryHeap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify, watch};

/// 命令优先级，数值越大越优先。
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[repr(u8)]
pub enum AtPriority {
    Background = 0,
    Low = 1,
    Normal = 2,
    High = 3,
    /// 短信专用：最高优先级，且在 [SmsMode] 生效时是唯一被放行的命令。
    Sms = 4,
}

impl AtPriority {
    pub fn is_sms(self) -> bool {
        matches!(self, AtPriority::Sms)
    }
}

/// 短信优先模式的租约上限。
///
/// 单次续期最多给这么久，防止某个会话无限续期把其它模块的轮询永久停掉。
pub const SMS_MAX_LEASE: Duration = Duration::from_secs(300);

pub struct SmsModeState {
    /// 租约 id -> 到期时刻。空即表示短信模式未启用。
    leases: HashMap<u64, Instant>,
    next_id: u64,
}

/// 短信优先模式的暂停门。
///
/// 语义：
///   - 持有一份租约 = 「短信中心正在活动」；同一时刻可有多个租约（多标签页），
///     全部释放或过期后模式解除；
///   - 非短信命令在申请通道前调用 [Self::wait_clear]，模式生效期间一律等待，
///     直到解除或超过 `max_wait`；
///   - 租约带 TTL 且由 [Self::sweep] 清扫，前端崩了 / WebSocket 断了 /
///     忘记发送释放请求，都不会让其它模块永久停轮询。
pub struct SmsMode {
    inner: Mutex<SmsModeState>,
    changed: Notify,
}

impl SmsMode {
    pub fn new() -> Arc<Self> {
        Arc::new(SmsMode {
            inner: Mutex::new(SmsModeState { leases: HashMap::new(), next_id: 1 }),
            changed: Notify::new(),
        })
    }

    /// 登记一份租约。返回租约 id，调用方需负责释放（或等待其过期）。
    pub async fn acquire(&self, ttl: Duration) -> u64 {
        self.sweep().await;
        let ttl = ttl.min(SMS_MAX_LEASE);
        let mut state = self.inner.lock().await;
        let id = state.next_id;
        state.next_id += 1;
        state.leases.insert(id, Instant::now() + ttl);
        log_sms_mode_change(true, &state);
        id
    }

    /// 续期一份已存在的租约。租约已过期/不存在时返回 false。
    pub async fn renew(&self, id: u64, ttl: Duration) -> bool {
        let mut state = self.inner.lock().await;
        match state.leases.get_mut(&id) {
            Some(deadline) => {
                *deadline = Instant::now() + ttl.min(SMS_MAX_LEASE);
                true
            }
            None => false,
        }
    }

    /// 释放租约。幂等。
    pub async fn release(&self, id: u64) {
        let mut state = self.inner.lock().await;
        if state.leases.remove(&id).is_some() {
            log_sms_mode_change(false, &state);
            drop(state);
            self.changed.notify_waiters();
        }
    }

    /// 清空全部租约（服务关闭 / 模组断连等场景）。
    pub async fn release_all(&self) {
        let mut state = self.inner.lock().await;
        if state.leases.is_empty() {
            return;
        }
        state.leases.clear();
        log_sms_mode_change(false, &state);
        drop(state);
        self.changed.notify_waiters();
    }

    /// 短信模式是否生效。
    pub async fn active(&self) -> bool {
        let state = self.inner.lock().await;
        !state.leases.is_empty()
    }

    /// 当前租约数（供状态展示与测试观察）。
    pub async fn lease_count(&self) -> usize {
        self.inner.lock().await.leases.len()
    }

    /// 清扫已过期租约。清理掉至少一个时唤醒所有等待者。
    ///
    /// 每次 [Self::wait_clear] 都会顺带扫一遍：即使清扫任务因故没跑起来，
    /// 等待者也能在自己这里纠正「模式卡住」。
    async fn sweep(&self) {
        let mut state = self.inner.lock().await;
        if state.leases.is_empty() {
            return;
        }
        let now = Instant::now();
        let expired: Vec<u64> = state
            .leases
            .iter()
            .filter(|(_, deadline)| **deadline <= now)
            .map(|(id, _)| *id)
            .collect();
        if expired.is_empty() {
            return;
        }
        for id in &expired {
            state.leases.remove(id);
        }
        let remain = state.leases.len();
        drop(state);
        crate::log_warn!("短信优先模式租约到期自动释放（回收 {} 个，剩余 {} 个）", expired.len(), remain);
        self.changed.notify_waiters();
    }

    /// 非短信命令的入口：短信模式生效期间在此等待，直到解除或超过 `max_wait`。
    ///
    /// 超时返回 Err 让调用方拿到「短信操作进行中」的明确结论，
    /// 而不是假装成功或把命令硬塞进通道造成响应串线。
    pub async fn wait_clear(
        &self,
        ctx: &watch::Receiver<bool>,
        max_wait: Duration,
        command: &str,
    ) -> Result<(), String> {
        // 快速路径：绝大多数时候根本没有短信会话。
        self.sweep().await;
        if !self.active().await {
            return Ok(());
        }
        // 零预算（Low/Background 后台任务）：不等，直接带稳定前缀失败。
        // 前缀是与前端的约定（rpc.js 据此区分「重试」与「跳过」），勿改文案开头。
        if max_wait.is_zero() {
            return Err(format!(
                "sms_skip:短信操作进行中，后台任务本轮跳过：{}",
                command.trim()
            ));
        }
        crate::log_debug!("命令 {} 等待短信优先模式让出通道", command.trim());

        let deadline = Instant::now() + max_wait;
        let mut ctx_c = ctx.clone();
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let timeout = tokio::time::sleep(remaining);
            tokio::pin!(timeout);
            tokio::select! {
                _ = &mut notified => {}
                _ = &mut timeout => break,
                _ = ctx_c.changed() => return Err("上下文取消".into()),
            }
            self.sweep().await;
            if !self.active().await {
                return Ok(());
            }
        }

        Err(format!(
            "sms_busy:短信操作进行中，通道已被占用 {}s，请稍后重试：{}",
            max_wait.as_secs(),
            command.trim()
        ))
    }

    /// 后台清扫任务：到期租约自动失效。挂到 AtClient 生命周期里即可。
    pub async fn run(self: Arc<Self>, mut ctx: watch::Receiver<bool>) {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                _ = ctx.changed() => {
                    self.release_all().await;
                    return;
                }
            }
            self.sweep().await;
        }
    }
}

fn log_sms_mode_change(entered: bool, state: &SmsModeState) {
    if state.leases.is_empty() {
        if entered {
            crate::log_info!("短信优先模式启用：后台巡检暂停");
        }
    } else {
        crate::log_debug!("短信优先模式租约变更，当前 {} 个会话", state.leases.len());
    }
}

struct GateState {
    /// 当前持有通道的 token（与 WaitToken.token 对应）。
    holder: Option<u64>,
    waiters: BinaryHeap<WaitToken>,
    seq: AtomicU64,
}

/// 一次排队的令牌；Ord 实现让「优先级高的 + 更早的」排在堆顶。
#[derive(Clone)]
struct WaitToken {
    prio: u8,
    seq: u64,
    token: u64,
    notify: Arc<Notify>,
    cancelled: Arc<AtomicBool>,
}

impl PartialEq for WaitToken {
    fn eq(&self, o: &Self) -> bool {
        self.token == o.token
    }
}
impl Eq for WaitToken {}

impl PartialOrd for WaitToken {
    fn partial_cmp(&self, o: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(o))
    }
}

// BinaryHeap 是 max-heap：cmp 返回 Greater 者排在堆顶。
// 我们想要优先级大的在前；同优先级 seq 小的（更早入队）在前。
impl Ord for WaitToken {
    fn cmp(&self, o: &Self) -> CmpOrdering {
        let p = self.prio.cmp(&o.prio);
        p.then_with(|| o.seq.cmp(&self.seq))
    }
}

/// 异步优先级门：任意时刻至多一个持有者，次序按优先级。
pub struct PriLock {
    inner: Mutex<GateState>,
}

impl PriLock {
    pub fn new() -> Arc<Self> {
        Arc::new(PriLock {
            inner: Mutex::new(GateState {
                holder: None,
                waiters: BinaryHeap::new(),
                seq: AtomicU64::new(1),
            }),
        })
    }

    /// 以 `prio` 申请通道。等待期间受 `wait` 超时与 `ctx` 取消约束；
    /// 成功返回 [GatePermit]，失败返回错误文案（队列里自动清理）。
    pub async fn acquire(
        self: &Arc<Self>,
        prio: AtPriority,
        ctx: &watch::Receiver<bool>,
        wait: Duration,
    ) -> Result<GatePermit, String> {
        // 为什么要先把 Notify 取出来再进临界区：
        //
        // 放行方在 `grant_locked` 里 `notify_one()`，而 `Notify::notify_one`
        // 只在**已有等待者**时才存一个 permit；否则它只是把「已通知」标记置位。
        // 若这里先加锁、入队、放锁，之后才 `notified()`，中间那一瞬是允许
        // 放行发生却漏掉通知的窗口（漏掉就只能在超时或取消时醒来）。
        // 先在外层建好 `Notified` 再入队，放行必定被记在它身上，无窗口。
        let notify = Arc::new(Notify::new());
        let mut state = self.inner.lock().await;

        let token = state.seq.fetch_add(1, Ordering::Relaxed);
        let mine = WaitToken {
            prio: prio as u8,
            seq: token,
            token,
            notify: notify.clone(),
            cancelled: Arc::new(AtomicBool::new(false)),
        };

        // 若通道空闲，立即放行我自己；否则入队等待。
        if state.holder.is_none() {
            state.holder = Some(mine.token);
            drop(state);
            return Ok(GatePermit { owner: self.clone(), token: mine.token });
        }
        state.waiters.push(mine.clone());
        drop(state);

        // 等待被放行（notify）或超时 / 取消。
        //
        // 超时预算是**整段排队**的预算：deadline 只算一次，被伪唤醒重试时
        // 用的是剩余额度。旧实现在循环里每次重建 `sleep(wait)`，非取消的
        // 伪唤醒会把预算无限续期，8 秒的排队上限因此失效。
        let deadline = Instant::now() + wait;
        let mut ctx_c = ctx.clone();
        let mut notified = Box::pin(mine.notify.clone().notified_owned());
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.release_if_owned(&mine).await;
                return Err(format!(
                    "等待空闲通道超时（{}s）：模组正忙或正在重连，请稍后重试",
                    wait.as_secs()
                ));
            }
            let timeout = tokio::time::sleep(remaining);
            tokio::pin!(timeout);

            tokio::select! {
                _ = &mut notified => {}
                _ = &mut timeout => {
                    self.release_if_owned(&mine).await;
                    return Err(format!(
                        "等待空闲通道超时（{}s）：模组正忙或正在重连，请稍后重试",
                        wait.as_secs()
                    ));
                }
                _ = ctx_c.changed() => {
                    self.release_if_owned(&mine).await;
                    return Err("上下文取消".into());
                }
            }

            // 被唤醒：确认是否已轮到。放行与「确认」必须在**同一个临界区**里
            // 完成 —— 旧实现先放锁再检查 holder，超时/取消分支可能在两者之间
            // 把通道收回去，于是这里直接返回 Ok 却带着一个已被收回的 token，
            // 其它命令就能同时进来，通道独占被破坏。
            let state = self.inner.lock().await;
            if state.holder == Some(mine.token) {
                drop(state);
                return Ok(GatePermit { owner: self.clone(), token: mine.token });
            }
            drop(state);
            // 尚未轮到（伪唤醒）→ 继续等剩余额度。
            notified = Box::pin(mine.notify.clone().notified_owned());
        }
    }

    /// 从等待队列移除一个令牌（超时/取消用）。
    ///
    /// 与「确认轮到」同一把锁：要么这里把通道收回并派发给下一位，要么
    /// `acquire` 那边已经拿走 `GatePermit`（那时 unmark 返回 false，
    /// 由 permit 的 Drop 负责释放）。两条路径不会同时成立。
    async fn release_if_owned(&self, mine: &WaitToken) {
        mine.cancelled.store(true, Ordering::Release);
        let mut state = self.inner.lock().await;
        // 极端并发：等待期间已被放行（holder == mine）却又收到超时/取消。
        // 此时没有对应的 GatePermit 会被 drop，必须在这里把通道让出来，
        // 否则通道会被永久占住，后续所有命令都卡死。
        if state.holder == Some(mine.token) {
            state.holder = None;
            self.grant_locked(&mut state);
        }
    }

    fn grant_locked(&self, state: &mut tokio::sync::MutexGuard<'_, GateState>) {
        loop {
            match state.waiters.peek() {
                Some(w) if w.cancelled.load(Ordering::Acquire) => {
                    state.waiters.pop();
                }
                Some(_) => break,
                None => return,
            }
        }
        if let Some(w) = state.waiters.pop() {
            state.holder = Some(w.token);
            w.notify.notify_one();
        }
    }

    /// 仅测试用：向所有排队者发一次伪唤醒，用来验证「排队预算不因伪唤醒续期」。
    #[cfg(test)]
    pub(crate) async fn notify_all_waiters_for_test(&self) {
        let state = self.inner.lock().await;
        for w in state.waiters.iter() {
            w.notify.notify_waiters();
        }
    }

    /// 等待队列是否非空（有命令正在排队等通道）。
    ///
    /// 供短信事务的协作让出判断使用：近似判断（含已取消尚未清扫的令牌），
    /// 代价是一次短临界区加锁，绝不在命令路径上做堆扫描。
    pub async fn has_waiters(&self) -> bool {
        let state = self.inner.lock().await;
        !state.waiters.is_empty()
    }
}

/// 拿到的通道使用权，释放时把通道交给下一个排队的请求。
pub struct GatePermit {
    owner: Arc<PriLock>,
    token: u64,
}

impl Drop for GatePermit {
    fn drop(&mut self) {
        let owner = self.owner.clone();
        let token = self.token;
        // Drop 里不能 .await：交给 runtime 让持有权尽快流转（释放极快，无 IO）。
        tokio::spawn(async move {
            let mut state = owner.inner.lock().await;
            if state.holder == Some(token) {
                state.holder = None;
                owner.grant_locked(&mut state);
            }
            drop(state);
        });
    }
}

impl GatePermit {
    /// 当前该令牌是否仍是通道持有者。
    pub async fn still_holds(&self) -> bool {
        let state = self.owner.inner.lock().await;
        state.holder == Some(self.token)
    }
}

/// 一次短信事务持有的通道独占权。
///
/// 为什么需要它：短信的很多操作是**多步骤**的 —— 发送要 CMGF/CSCA/CMGS×N，
/// 批量删除要逐条 CMGD，长短信要连续提交多片。若每步各拿一次 [GatePermit]，
/// 两步之间通道就会被后台巡检或其它页面抢走（它们插入的不是短信命令本身，
/// 而是把「模组刚进 PDU 会话」的上下文打乱），表现为半途失败或 PDU 串线。
///
/// 持有期间：
///   - 通道不释放，任何非事务命令都排不到；
///   - 事务内部的命令直接下发，不再重复 acquire（否则会与自己死锁）；
///   - Drop 即释放，异常/取消/超时都不会把通道永久占住。
pub struct SmsTransaction {
    /// 通道独占权。协作让出期间为 `None`（已交出、尚未抢回）。
    ///
    /// 用 `Option + Mutex` 而不是把方法改成 `&mut self`：让出只发生在命令边界，
    /// 但调用方（sms.rs 的多个辅助函数）持有的是 `&SmsTransaction`，
    /// 改签名会波及十余处调用点，收益不成比例。
    permit: Mutex<Option<GatePermit>>,
    label: String,
    /// 事务开始时刻（Drop 日志报总耗时）。
    started: Instant,
    /// 当前持有段的起点（让出后抢回时重置，供让出判断）。
    held_since: AtomicU64,
}

impl SmsTransaction {
    pub(crate) fn new(permit: GatePermit, label: String) -> SmsTransaction {
        SmsTransaction {
            permit: Mutex::new(Some(permit)),
            label,
            started: Instant::now(),
            held_since: AtomicU64::new(crate::atclient::mono_ms()),
        }
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    /// 当前持有段已持续的时间（让出判断用）。
    pub fn held_since(&self) -> Duration {
        let since = self.held_since.load(Ordering::Relaxed);
        Duration::from_millis(crate::atclient::mono_ms().saturating_sub(since))
    }

    /// 供 AtClient 在事务内下发命令前做归属校验。
    pub async fn holds_channel(&self) -> bool {
        let guard = self.permit.lock().await;
        match guard.as_ref() {
            // still_holds 只做一次短临界区加锁，不与其它路径成环
            Some(p) => p.still_holds().await,
            None => false,
        }
    }

    /// 协作让出：交出通道，让排队的高优先级命令插进来（issue #23）。
    pub async fn relinquish(&self) {
        let taken = {
            let mut guard = self.permit.lock().await;
            guard.take()
        };
        // GatePermit::drop 内部 spawn 释放 + 派发，不阻塞当前任务
        drop(taken);
    }

    /// 让出后重新持回通道（重置持有段计时）。
    pub async fn restore(&self, permit: GatePermit) {
        let mut guard = self.permit.lock().await;
        *guard = Some(permit);
        self.held_since.store(crate::atclient::mono_ms(), Ordering::Relaxed);
    }
}

impl Drop for SmsTransaction {
    fn drop(&mut self) {
        // permit 的 Drop 负责释放通道；这里只补耗时日志。
        // logger::emit 是非阻塞的（缓冲 + eprintln），Drop 内调用安全。
        crate::log_debug!(
            "短信事务结束: {} 耗时 {}ms",
            self.label,
            self.started.elapsed().as_millis()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering as AOrdering;

    #[tokio::test]
    async fn relinquishes_in_priority_order() {
        let lock = PriLock::new();
        let (_ctx_tx, ctx) = watch::channel(false);

        // 先占住通道。
        let p1 = lock
            .acquire(AtPriority::Normal, &ctx, Duration::from_secs(1))
            .await
            .unwrap();

        // 三个排队者（顺序：Low 先到，High 后到，Normal 后到）。
        let low = {
            let lock = lock.clone();
            let ctx = ctx.clone();
            tokio::spawn(async move {
                let _p = lock.acquire(AtPriority::Low, &ctx, Duration::from_secs(3)).await.unwrap();
                "Low"
            })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        let high = {
            let lock = lock.clone();
            let ctx = ctx.clone();
            tokio::spawn(async move {
                let _p = lock.acquire(AtPriority::High, &ctx, Duration::from_secs(3)).await.unwrap();
                "High"
            })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        let normal = {
            let lock = lock.clone();
            let ctx = ctx.clone();
            tokio::spawn(async move {
                let _p = lock.acquire(AtPriority::Normal, &ctx, Duration::from_secs(3)).await.unwrap();
                "Normal"
            })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;

        // 释放占用方后，应总按优先级：High 最先拿到。
        drop(p1);
        let r1 = tokio::time::timeout(Duration::from_secs(2), high).await.unwrap().unwrap();
        assert_eq!(r1, "High", "优先级最高的应最先拿到通道");

        // 此时剩 Low、Normal 且无人持有（Permit 在 High 任务内 drop）。
        tokio::time::sleep(Duration::from_millis(20)).await;
        let r2 = tokio::time::timeout(Duration::from_secs(2), normal).await.unwrap().unwrap();
        assert_eq!(r2, "Normal", "Normal 应排在 Low 之前");
        let r3 = tokio::time::timeout(Duration::from_secs(2), low).await.unwrap().unwrap();
        assert_eq!(r3, "Low");
    }

    /// 短信优先级必须压过包括 High（AT 终端用户操作）在内的所有其它优先级。
    ///
    /// 这是「短信优先」的落点：后台巡检（Low/Background）与终端命令（High）
    /// 都排在短信之后，短信任务不会因为它们先到而被挡住。
    #[tokio::test]
    async fn sms_priority_beats_everything_else() {
        let lock = PriLock::new();
        let (_ctx_tx, ctx) = watch::channel(false);

        let held = lock
            .acquire(AtPriority::Normal, &ctx, Duration::from_secs(1))
            .await
            .unwrap();

        // 依次入队：Background → Low → Normal → High → Sms
        let order = std::sync::Arc::new(std::sync::Mutex::new(Vec::<&'static str>::new()));
        let spawn = |prio: AtPriority, name: &'static str| {
            let lock = lock.clone();
            let ctx = ctx.clone();
            let order = order.clone();
            tokio::spawn(async move {
                let _p = lock.acquire(prio, &ctx, Duration::from_secs(5)).await.unwrap();
                order.lock().unwrap().push(name);
            })
        };
        let bg = spawn(AtPriority::Background, "Background");
        tokio::time::sleep(Duration::from_millis(5)).await;
        let low = spawn(AtPriority::Low, "Low");
        tokio::time::sleep(Duration::from_millis(5)).await;
        let normal = spawn(AtPriority::Normal, "Normal");
        tokio::time::sleep(Duration::from_millis(5)).await;
        let high = spawn(AtPriority::High, "High");
        tokio::time::sleep(Duration::from_millis(5)).await;
        let sms = spawn(AtPriority::Sms, "Sms");
        tokio::time::sleep(Duration::from_millis(20)).await;

        drop(held);
        tokio::time::sleep(Duration::from_millis(50)).await;

        let got = order.lock().unwrap().clone();
        assert_eq!(got.first().copied(), Some("Sms"), "短信必须第一个拿到通道，实际 {got:?}");
        assert_eq!(got, vec!["Sms", "High", "Normal", "Low", "Background"], "完整次序应为优先级降序");

        // 让剩余任务收尾，避免 JoinHandle 泄漏到测试外
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            let _ = bg.await;
            let _ = low.await;
            let _ = normal.await;
            let _ = high.await;
            let _ = sms.await;
        })
        .await;
    }

    /// 短信事务的持有权是一次性的：drop 之后才轮到下一个。
    #[tokio::test]
    async fn sms_transaction_holds_channel_until_dropped() {
        let lock = PriLock::new();
        let (_ctx_tx, ctx) = watch::channel(false);

        let tx = lock.acquire(AtPriority::Sms, &ctx, Duration::from_secs(1)).await.unwrap();
        assert!(tx.still_holds().await);

        // 事务存续期间，后来的短信请求只能排队
        let second = {
            let lock = lock.clone();
            let ctx = ctx.clone();
            tokio::spawn(async move { lock.acquire(AtPriority::Sms, &ctx, Duration::from_secs(3)).await.is_ok() })
        };
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(!second.is_finished(), "第一个事务还持有通道时，第二个必须排队等待");

        drop(tx);
        let ok = tokio::time::timeout(Duration::from_secs(3), second)
            .await
            .expect("释放后第二个事务应放行")
            .unwrap();
        assert!(ok, "释放后第二个短信事务应拿到通道");
    }

    #[tokio::test]
    async fn fifo_among_same_priority() {
        let lock = PriLock::new();
        let (_ctx_tx, ctx) = watch::channel(false);
        let p0 = lock
            .acquire(AtPriority::Normal, &ctx, Duration::from_secs(1))
            .await
            .unwrap();

        // 同优先级按先到先得。
        let a = tokio_test_a(&lock, &ctx, "A");
        tokio::time::sleep(Duration::from_millis(5)).await;
        let b = tokio_test_a(&lock, &ctx, "B");
        tokio::time::sleep(Duration::from_millis(5)).await;
        let c = tokio_test_a(&lock, &ctx, "C");

        drop(p0);
        assert_eq!(tokio::time::timeout(Duration::from_secs(2), a).await.unwrap().unwrap(), "A");
        assert_eq!(tokio::time::timeout(Duration::from_secs(2), b).await.unwrap().unwrap(), "B");
        assert_eq!(tokio::time::timeout(Duration::from_secs(2), c).await.unwrap().unwrap(), "C");
    }

    fn tokio_test_a(
        lock: &Arc<PriLock>,
        ctx: &watch::Receiver<bool>,
        name: &'static str,
    ) -> tokio::task::JoinHandle<&'static str> {
        let lock = lock.clone();
        let ctx = ctx.clone();
        tokio::spawn(async move {
            let _p = lock.acquire(AtPriority::Normal, &ctx, Duration::from_secs(3)).await.unwrap();
            name
        })
    }

    /// 排队超时只消耗**一次**预算，不因伪唤醒而续期。
    ///
    /// 旧实现在循环里每次重建 `sleep(wait)`，任何非取消的伪唤醒都会把
    /// 8 秒的排队上限变成「再等 8 秒」。这里用 notify_waiters 主动制造一次
    /// 伪唤醒，断言总耗时不显著超过给定预算。
    #[tokio::test]
    async fn queue_timeout_is_not_extended_by_spurious_wakeups() {
        let lock = PriLock::new();
        let (_ctx_tx, ctx) = watch::channel(false);
        let holder = lock
            .acquire(AtPriority::Normal, &ctx, Duration::from_secs(1))
            .await
            .unwrap();

        let waiter = {
            let lock = lock.clone();
            let ctx = ctx.clone();
            tokio::spawn(async move {
                lock.acquire(AtPriority::High, &ctx, Duration::from_millis(150)).await
            })
        };
        // 反复伪唤醒：旧实现每被唤醒一次就重置整段预算，必然拖到很远
        for _ in 0..5 {
            tokio::time::sleep(Duration::from_millis(40)).await;
            lock.notify_all_waiters_for_test().await;
        }

        let t0 = Instant::now();
        let res = tokio::time::timeout(Duration::from_secs(2), waiter).await.expect("不应挂死");
        let err = match res.unwrap() {
            Ok(_) => panic!("预算耗尽后必须返回排队超时，却拿到了通道"),
            Err(e) => e,
        };
        assert!(err.contains("等待空闲通道超时"), "实际: {err}");
        assert!(
            t0.elapsed() < Duration::from_millis(1000),
            "总耗时应保持在一次预算量级，实测 {:?}",
            t0.elapsed()
        );
        drop(holder);
    }

    /// 超时分支不得把「已经放行给等待者」的通道再收回。
    ///
    /// 这是「先放锁再确认」那个缺陷的**确定性**复现：放行已经发生
    /// （`holder == 等待者`），此时等待者的超时分支才醒来。旧实现在
    /// `remove()` 里无条件把 holder 置空并派发给下一位 —— 而等待者随后
    /// 从 select 里返回 Ok，于是同一个通道同时给了两个人。
    ///
    /// 现在收回到「置空 + 派发」全部在 `acquire` 的同一临界区里完成，
    /// 所以这里断言：超时分支走完后通道要么仍在原等待者手里、要么交给
    /// 下一位，绝不会两边都以为自己拿到了。
    #[tokio::test]
    async fn timed_out_branch_and_grant_are_mutually_exclusive() {
        let lock = PriLock::new();
        let (_ctx_tx, ctx) = watch::channel(false);

        // 持有者先占住通道（通道空闲时应立即拿到，不能先起等待者）
        let holder = lock
            .acquire(AtPriority::Normal, &ctx, Duration::from_secs(1))
            .await
            .expect("通道空闲时应立即拿到");

        // 等待者：预算极短，且放行时点被安排在预算到期前后（见下面的 sleep）
        let waiting = {
            let lock = lock.clone();
            let ctx = ctx.clone();
            tokio::spawn(async move { lock.acquire(AtPriority::High, &ctx, Duration::from_millis(20)).await })
        };
        tokio::time::sleep(Duration::from_millis(2)).await;
        drop(holder);

        let res = tokio::time::timeout(Duration::from_secs(2), waiting)
            .await
            .expect("等待者不应挂死")
            .expect("任务不应 panic");
        match res {
            Ok(permit) => {
                // 拿到了就真的持有：此刻再来一个申请者必须排队，不能也被放行
                let second = lock
                    .acquire(AtPriority::Normal, &ctx, Duration::from_millis(50))
                    .await;
                assert!(second.is_err(), "通道被同时交给了两个调用方");
                drop(permit);
                // permit 释放后通道应当可以再拿到
                let third = lock.acquire(AtPriority::Normal, &ctx, Duration::from_secs(1)).await;
                assert!(third.is_ok(), "permit 释放后通道应重新可用");
            }
            Err(e) => {
                // 超时分支：通道也必须保持可用，不能被「收回到虚空」里
                assert!(e.contains("等待空闲通道超时"), "实际: {e}");
                let again = lock.acquire(AtPriority::Normal, &ctx, Duration::from_secs(1)).await;
                assert!(again.is_ok(), "超时后通道应重新可用（不能既没结果又占着通道）");
            }
        }
    }

    #[tokio::test]
    async fn wait_clear_zero_budget_fails_fast_with_skip_prefix() {
        let mode = SmsMode::new();
        let (_tx, ctx) = watch::channel(false);
        mode.acquire(Duration::from_secs(30)).await;
        let t0 = Instant::now();
        let err = mode
            .wait_clear(&ctx, Duration::ZERO, "AT+CGREG?")
            .await
            .unwrap_err();
        assert!(
            t0.elapsed() < Duration::from_millis(100),
            "零预算应立即失败，实测 {:?}",
            t0.elapsed()
        );
        assert!(err.starts_with("sms_skip:"), "应带跳过前缀: {err}");
    }

    #[tokio::test]
    async fn wait_clear_timeout_carries_busy_prefix() {
        let mode = SmsMode::new();
        let (_tx, ctx) = watch::channel(false);
        mode.acquire(Duration::from_secs(30)).await;
        let err = mode
            .wait_clear(&ctx, Duration::from_millis(120), "AT^MONSC")
            .await
            .unwrap_err();
        assert!(err.starts_with("sms_busy:"), "应带忙前缀: {err}");
    }

    #[tokio::test]
    async fn gate_reports_waiters_for_transaction_yield() {
        let lock = PriLock::new();
        let (_ctx_tx, ctx) = watch::channel(false);
        assert!(!lock.has_waiters().await, "空队列不应有等待者");
        let p = lock
            .acquire(AtPriority::Sms, &ctx, Duration::from_secs(1))
            .await
            .unwrap();
        assert!(!lock.has_waiters().await, "仅持有者不应算等待者");
        let waiter = {
            let lock = lock.clone();
            let ctx = ctx.clone();
            tokio::spawn(async move {
                let _p = lock
                    .acquire(AtPriority::High, &ctx, Duration::from_secs(3))
                    .await
                    .unwrap();
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(lock.has_waiters().await, "排队者应被观察到");
        drop(p);
        waiter.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_removes_waiter_and_unblocks_others() {
        let lock = PriLock::new();
        let (_ctx_tx, ctx) = watch::channel(false);
        let p0 = lock
            .acquire(AtPriority::Normal, &ctx, Duration::from_secs(1))
            .await
            .unwrap();

        // 一个会被取消的等待者（Low），后面跟一个 Normal。
        let doomed = {
            let lock = lock.clone();
            let ctx = ctx.clone();
            tokio::spawn(async move {
                let r = lock.acquire(AtPriority::Low, &ctx, Duration::from_millis(60)).await;
                r.map(|_p| "should-not-get")
            })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        let survivor = {
            let lock = lock.clone();
            let ctx = ctx.clone();
            tokio::spawn(async move {
                let _p = lock.acquire(AtPriority::Normal, &ctx, Duration::from_secs(3)).await.unwrap();
                "survivor"
            })
        };
        tokio::time::sleep(Duration::from_millis(80)).await;

        // Low 等不到（60ms 超时）即自我移除并触发派发。
        let r = tokio::time::timeout(Duration::from_secs(2), doomed)
            .await
            .unwrap()
            .unwrap();
        assert!(r.is_err(), "Low 应超时失败而非拿到通道");

        // 释放占用后，survivor 应成功拿到（不会被已移除的 Low 挡住）。
        drop(p0);
        let rs = tokio::time::timeout(Duration::from_secs(2), survivor)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rs, "survivor");
        let _ = AOrdering::Relaxed; // silence import
    }
}