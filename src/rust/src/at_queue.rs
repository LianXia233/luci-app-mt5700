//! AT 请求优先级门（Priority Gate）。
//!
//! 替换原先 FIFO 的 `cmd_mu` 普通互斥锁：所有业务模块（RPC、缓存刷新、定时任务、
//! 自动拨号等）都通过这里申请独占模组通道的使用权，由同一把异步锁按**优先级**放行，
//! 而不是谁先抢到锁谁先执行。
//!
//! 优先级约定（与需求文档一致）：
//!   - High       ：AT Console 用户主动操作、紧急恢复
//!   - Normal     ：状态查询、网络信息、SIM 信息
//!   - Low        ：后台统计、温度采集、周期性状态刷新
//!   - Background ：扫频、频段分析、历史统计
//!
//! 设计要点：
//!   - 完全异步，排队的等待者不再自旋占 CPU；
//!   - `acquire` 自带超时与上下文取消，取带可让出通道；
//!   - 用 Notify + 显式 pump 派发，取消者直接从堆里移除，不会占着不放。

use std::cmp::Ordering as CmpOrdering;
use std::collections::BinaryHeap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, Notify, watch};

/// 命令优先级，数值越大越优先。
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[repr(u8)]
pub enum AtPriority {
    Background = 0,
    Low = 1,
    Normal = 2,
    High = 3,
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

impl WaitToken {
    fn make(&self) -> WaitToken {
        WaitToken {
            prio: self.prio,
            seq: self.seq,
            token: self.token,
            notify: self.notify.clone(),
            cancelled: self.cancelled.clone(),
        }
    }
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
        // 先申请异步锁，保护状态短临界区（绝不做任何 IO）。
        let mut state = self.inner.lock().await;

        let token = state.seq.fetch_add(1, Ordering::Relaxed);
        let mine = WaitToken {
            prio: prio as u8,
            seq: token,
            token,
            notify: Arc::new(Notify::new()),
            cancelled: Arc::new(AtomicBool::new(false)),
        };

        // 若通道空闲，立即放行我自己；否则入队等待。
        if state.holder.is_none() {
            state.holder = Some(mine.token);
            drop(state);
            return Ok(GatePermit { owner: self.clone(), token: mine.token });
        }
        state.waiters.push(mine.make());
        drop(state);

        // 等待被放行（notify）或超时 / 取消。
        let mut ctx_c = ctx.clone();
        loop {
            let notify = mine.notify.notified();
            tokio::pin!(notify);
            let timeout = tokio::time::sleep(wait);
            tokio::pin!(timeout);

            tokio::select! {
                _ = &mut notify => {}
                _ = &mut timeout => {
                    self.remove(&mine).await;
                    return Err(format!(
                        "等待空闲通道超时（{}s）：模组正忙或正在重连，请稍后重试",
                        wait.as_secs()
                    ));
                }
                _ = ctx_c.changed() => {
                    self.remove(&mine).await;
                    return Err("上下文取消".into());
                }
            }

            // 被唤醒：确认是否已轮到（放行发生在 OnHold 协议里，见下）。
            // 若已轮到则 FastPath 已置 holder，直接返回。
            let state = self.inner.lock().await;
            if state.holder == Some(mine.token) {
                drop(state);
                return Ok(GatePermit { owner: self.clone(), token: mine.token });
            }
            drop(state);
            // 尚未轮到（可能是伪唤醒）→ 继续等。
        }
    }

    /// 从等待队列移除一个令牌（超时/取消用）。
    async fn remove(&self, mine: &WaitToken) {
        mine.cancelled.store(true, Ordering::Release);
        let mut state = self.inner.lock().await;
        // 极端并发：等待期间已被放行（holder == mine）却又收到超时/取消。
        // 此时没有对应的 GatePermit 会被 drop，必须在这里把通道让出来，
        // 否则通道会被永久占住，后续所有命令都卡死。
        if state.holder == Some(mine.token) {
            state.holder = None;
        }
        drop(state);
        // 标记后由派发逻辑清扫；若通道已被腾出，补一次派发通知下一个排队者。
        self.dispatch().await;
    }

    /// 尝试把通道交给队里最优先且未取消的令牌。
    async fn dispatch(&self) {
        let mut state = self.inner.lock().await;
        if state.holder.is_some() {
            return;
        }
        self.grant_locked(&mut state);
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