//! 统一任务管理器（Async Task Manager）与取消令牌（CancellationToken）。
//!
//! 对应异步化架构的「后台任务异步化 / 任务生命周期管理 / 取消机制 / 超时」：
//!   - 长耗时操作（小区扫频、锁频恢复、固件升级等）统一以 Task 提交后台执行；
//!   - 每个 Task 拥有 task_id、创建/开始/结束时刻、进度、状态、错误与结果；
//!   - 支持 Pending/Running/Completed/Failed/Cancelled/Timeout 状态机；
//!   - 外部可通过 task_id cancel / status，任务体内通过 CancellationToken 收取消信号；
//!   - 有界生命周期：后台任务常规化 spawn，管理器按上限淘汰已完成任务，杜绝无限队列与残留。
//!
//! 取消语义（关键）：`cancel` 只发送取消信号并置状态，**不会粗暴 drop 任务 Future**，
//! 以免中断正在进行的清理（例如扫频结束后的 reset、事件广播）。任务体应把
//! CancellationToken 纳入自己的 select，收到信号后自行完成收尾并返回。

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{watch, RwLock};

/// 任务执行状态。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TaskState {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
    Timeout,
}

impl TaskState {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskState::Pending => "pending",
            TaskState::Running => "running",
            TaskState::Completed => "completed",
            TaskState::Failed => "failed",
            TaskState::Cancelled => "cancelled",
            TaskState::Timeout => "timeout",
        }
    }
}

/// 任务状态快照（供 status / Serde 输出使用）。
#[derive(Clone, Debug)]
pub struct TaskInfo {
    pub id: String,
    pub kind: String,
    pub state: TaskState,
    /// epoch 毫秒
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub progress: u8,
    pub error: Option<String>,
    pub result: Option<String>,
}

/// 取消令牌：基于 watch 通道，契合本后端已有的上下文取消模式。
///
/// 持有方（外部/管理器）调用 `cancel()`；任务体内用 `wait()` 拿一个 watch Receiver，
/// 再接进自己的 select 里感知取消。
#[derive(Clone)]
pub struct CancellationToken {
    tx: watch::Sender<bool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        let (tx, _rx) = watch::channel(false);
        CancellationToken { tx }
    }

    /// 触发取消：send(true) 通知所有订阅者。
    pub fn cancel(&self) {
        let _ = self.tx.send(true);
    }

    /// 任务体订阅取消信号（可 clone 多份）。初始值即当前取消状态。
    pub fn wait(&self) -> watch::Receiver<bool> {
        self.tx.subscribe()
    }
}

/// 正在跟踪的任务句柄：持有取消令牌 + 可变状态。
struct TaskHandle {
    token: CancellationToken,
    info: RwLock<TaskInfo>,
}

/// 统一任务管理器。内部共享，`spawn` 返回 task_id。
pub struct TaskManager {
    seq: AtomicU64,
    tasks: RwLock<HashMap<String, Arc<TaskHandle>>>,
    /// 最多同时跟踪的任务数（软上限，超出的已完成任务被淘汰）。
    cap: usize,
}

impl TaskManager {
    pub fn with_cap(cap: usize) -> Arc<Self> {
        Arc::new(TaskManager {
            seq: AtomicU64::new(0),
            tasks: RwLock::new(HashMap::new()),
            cap: cap.max(4),
        })
    }

    /// 提交一个后台任务。`f` 接收取消信号 Receiver，返回 `Ok(result)` / `Err(msg)`。
    ///
    /// 立即返回 task_id；执行在 manager 持有的 tokio 任务中，不阻塞调用方。
    ///
    /// `spawn` 是通用入口（任务自行管理超时）；需要整体超时保护请用
    /// [Self::spawn_with_timeout]。
    #[allow(dead_code)] // 通用入口，供后续长任务（SMS 批量 / 固件升级）复用
    pub async fn spawn<F, Fut>(&self, kind: &str, f: F) -> String
    where
        F: FnOnce(watch::Receiver<bool>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<String, String>> + Send + 'static,
    {
        self.spawn_inner(kind, None, f).await
    }

    /// 与 [Self::spawn] 相同，但支持整体超时：任务运行超过 `timeout` 即强制标记为
    /// Timeout 并发送取消信号，由任务体自行收尾（不 drop Future，保证清理不被打断）。
    pub async fn spawn_with_timeout<F, Fut>(
        &self,
        kind: &str,
        timeout: Duration,
        f: F,
    ) -> String
    where
        F: FnOnce(watch::Receiver<bool>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<String, String>> + Send + 'static,
    {
        self.spawn_inner(kind, Some(timeout), f).await
    }

    async fn spawn_inner<F, Fut>(
        &self,
        kind: &str,
        timeout: Option<Duration>,
        f: F,
    ) -> String
    where
        F: FnOnce(watch::Receiver<bool>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<String, String>> + Send + 'static,
    {
        let id = format!("{}-{}", kind, self.seq.fetch_add(1, Ordering::Relaxed) + 1);
        let token = CancellationToken::new();
        let handle = Arc::new(TaskHandle {
            token: token.clone(),
            info: RwLock::new(TaskInfo {
                id: id.clone(),
                kind: kind.to_string(),
                state: TaskState::Pending,
                created_at: now_ms(),
                started_at: None,
                finished_at: None,
                progress: 0,
                error: None,
                result: None,
            }),
        });

        {
            let mut tasks = self.tasks.write().await;
            tasks.insert(id.clone(), handle.clone());
            self.evict_locked(&mut tasks, kind);
        }

        let h = handle.clone();
        let wait = token.wait();
        tokio::spawn(async move {
            {
                let mut info = h.info.write().await;
                info.state = TaskState::Running;
                info.started_at = Some(now_ms());
            }

            // 超时门卫：到点后置 Timeout 并触发取消，但不 drop 任务体，让其自行收尾。
            let out = match timeout {
                Some(d) => {
                    let work = f(wait);
                    tokio::pin!(work);
                    let sleep = tokio::time::sleep(d);
                    tokio::pin!(sleep);
                    let r = tokio::select! {
                        r = &mut work => r,
                        _ = &mut sleep => {
                            let mut info = h.info.write().await;
                            if info.state == TaskState::Running {
                                h.token.cancel();
                                info.state = TaskState::Timeout;
                                info.finished_at = Some(now_ms());
                                info.error = Some("任务超时".into());
                            }
                            drop(info);
                            work.await
                        }
                    };
                    r
                }
                None => f(wait).await,
            };

            let mut info = h.info.write().await;
            // 已在超时门卫置为 Timeout / 经 cancel 置为 Cancelled → 不覆盖。
            if matches!(info.state, TaskState::Running | TaskState::Pending) {
                match out {
                    Ok(v) => {
                        info.state = TaskState::Completed;
                        info.result = Some(v);
                    }
                    Err(e) => {
                        info.state = TaskState::Failed;
                        info.error = Some(e);
                    }
                }
            }
            info.finished_at = Some(now_ms());
        });

        id
    }

    /// 查询任务状态。
    pub async fn status(&self, id: &str) -> Option<TaskInfo> {
        let handle = self.tasks.read().await.get(id)?.clone();
        let info = handle.info.read().await.clone();
        Some(info)
    }

    /// 列举所有被跟踪任务（状态快照）。
    pub async fn list(&self) -> Vec<TaskInfo> {
        let tasks = self.tasks.read().await;
        let mut out = Vec::with_capacity(tasks.len());
        for h in tasks.values() {
            out.push(h.info.read().await.clone());
        }
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        out
    }

    /// 取消任务：置状态为 Cancelled 并发送取消信号。任务体观察到信号后自行收尾。
    pub async fn cancel(&self, id: &str) -> bool {
        let handle = match self.tasks.read().await.get(id).cloned() {
            Some(h) => h,
            None => return false,
        };
        handle.token.cancel();
        let mut info = handle.info.write().await;
        if matches!(
            info.state,
            TaskState::Pending | TaskState::Running
        ) {
            info.state = TaskState::Cancelled;
            return true;
        }
        false
    }

    /// 清理：移除「已结束（非 pending/running）且结束至今超过 `older_than`」的任务。
    /// 返回移除数量。与每次 spawn 的 cap 淘汰共同兜底，避免无限增长。
    pub async fn cleanup(&self, older_than: Duration) -> usize {
        let now = now_ms();
        let threshold = older_than.as_millis() as i64;
        let to_remove: Vec<String> = {
            let tasks = self.tasks.read().await;
            let mut v = Vec::new();
            for (id, h) in tasks.iter() {
                let info = h.info.read().await;
                let Some(finished) = info.finished_at else { continue };
                if !matches!(
                    info.state,
                    TaskState::Completed
                        | TaskState::Failed
                        | TaskState::Cancelled
                        | TaskState::Timeout
                ) {
                    continue;
                }
                if now.saturating_sub(finished) > threshold {
                    v.push(id.clone());
                }
            }
            v
        };

        let mut tasks = self.tasks.write().await;
        let mut removed = 0;
        for id in &to_remove {
            if tasks.remove(id).is_some() {
                removed += 1;
            }
        }
        removed
    }

    /// 淘汰：超过 cap 时删除最早结束的已完成任务（软上限兜底）。
    /// `_kind` 预留按类型淘汰，当前未使用。
    fn evict_locked(&self, tasks: &mut HashMap<String, Arc<TaskHandle>>, _kind: &str) {
        while tasks.len() > self.cap {
            // 找最早 finished_at 的已完成任务；找不到（全在跑）则保留并停止淘汰。
            let mut oldest: Option<(String, i64)> = None;
            for (id, h) in tasks.iter() {
                let info = match h.info.try_read() {
                    Ok(i) => i,
                    Err(_) => continue,
                };
                if matches!(info.state, TaskState::Pending | TaskState::Running) {
                    continue;
                }
                let fin = info.finished_at.unwrap_or(i64::MAX);
                let candidate = (id.clone(), fin);
                oldest = Some(match oldest {
                    None => candidate,
                    Some((_, cur)) if fin < cur => candidate,
                    Some(x) => x,
                });
            }
            match oldest {
                Some((id, _)) => {
                    tasks.remove(&id);
                }
                None => break,
            }
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spawn_then_completed() {
        let tm = TaskManager::with_cap(4);
        let id = tm
            .spawn("op", |_cancel| async move { Ok("ok".to_string()) })
            .await;
        // 任务在后台独立执行，等待其收尾而非立即断言 intermediate 状态。
        loop {
            let st = tm.status(&id).await.unwrap();
            if st.finished_at.is_some() {
                assert_eq!(st.state, TaskState::Completed);
                assert_eq!(st.result.as_deref(), Some("ok"));
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test]
    async fn spawn_failed() {
        let tm = TaskManager::with_cap(4);
        let id = tm
            .spawn("op", |_cancel| async move { Err("boom".to_string()) })
            .await;
        loop {
            let st = tm.status(&id).await.unwrap();
            if st.finished_at.is_some() {
                assert_eq!(st.state, TaskState::Failed);
                assert_eq!(st.error.as_deref(), Some("boom"));
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test]
    async fn cancel_sets_state_and_signals() {
        let tm = TaskManager::with_cap(4);
        // 任务体观察取消信号并自行收尾（不等待）。
        let id = tm
            .spawn("op", |mut cancel: watch::Receiver<bool>| async move {
                let _ = cancel.changed().await; // 等取消
                Err("cancelled".to_string())
            })
            .await;
        // 等进入 running
        loop {
            let st = tm.status(&id).await.unwrap();
            if st.state == TaskState::Running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(tm.cancel(&id).await);
        loop {
            let st = tm.status(&id).await.unwrap();
            if st.finished_at.is_some() {
                assert_eq!(st.state, TaskState::Cancelled);
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        // 重复取消返回 false（已结束）
        assert!(!tm.cancel(&id).await);
    }

    #[tokio::test]
    async fn spawn_timeout_marks_timeout() {
        let tm = TaskManager::with_cap(4);
        // 任务运行远超超时，会被整体标记 Timeout。
        let id = tm
            .spawn_with_timeout("op", Duration::from_millis(50), |_cancel| async move {
                tokio::time::sleep(Duration::from_millis(500)).await;
                Ok("late".to_string())
            })
            .await;
        loop {
            let st = tm.status(&id).await.unwrap();
            if st.finished_at.is_some() {
                assert_eq!(st.state, TaskState::Timeout);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn cleanup_removes_finished_and_list() {
        let tm = TaskManager::with_cap(4);
        let id = tm
            .spawn("op", |_cancel| async move { Ok("x".to_string()) })
            .await;
        // 等完成
        loop {
            let st = tm.status(&id).await.unwrap();
            if st.finished_at.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(tm.list().await.len(), 1);
        // older_than=0 → 立即可清理
        let removed = tm.cleanup(Duration::ZERO).await;
        assert_eq!(removed, 1);
        assert!(tm.status(&id).await.is_none());
    }

    #[tokio::test]
    async fn cap_eviction_removes_old_finished() {
        // with_cap 强制最低 4 个跟踪位。
        let tm = TaskManager::with_cap(1); // 实际 cap == 4
        let cap = 4;
        // 提交 cap + 2 个快速完成的任务，超过 cap 后最早的已完成任务会被淘汰。
        for i in 0..(cap + 2) {
            let id = tm
                .spawn("t", move |_cancel| async move { Ok(format!("{}", i)) })
                .await;
            // 等该任务完成，确保下一次 spawn 时前面的都处于 finished 态、可被淘汰。
            loop {
                let st = tm.status(&id).await.unwrap();
                if st.finished_at.is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
        // 有界：跟踪数量不超过 cap（最早完成的被不断淘汰）。
        assert!(tm.list().await.len() <= cap, "cap 淘汰未生效: {}", tm.list().await.len());
    }
}