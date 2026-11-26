// Copyright (C) 2026 LianXia233
// SPDX-License-Identifier: GPL-3.0-only

//! QQ 机器人「扫码绑定」：手机 QQ 扫一扫，一次性拿到 AppID / AppSecret / 用户 openid。
//!
//! 与 [`crate::qqbind`]（绑定模式：等用户先给机器人发一条消息再抓 openid）的关系：
//! 两条链路解决的是不同痛点，互不替代 ——
//!   * `qqbind`：凭据已经手动填好，只缺 openid（QQ 不提供「QQ 号 → openid」接口）；
//!   * `qqqr`（本模块）：连凭据都还躺在 QQ 开放平台后台，用户既要抄 AppID/AppSecret，
//!     又要再发一条消息。官方扫码页由 QQ 托管，用户登录态下勾选要授权的机器人后，
//!     QQ 把「AppID + 加密后的 AppSecret + 扫码者 openid」写进服务端任务，
//!     后端轮询取回并在本地解密 —— 一次扫码把三件事一起办完。
//!
//! 协议对齐 `@tencent-connect/qqbot-connector` 1.2.0（官方 SDK）：
//!   `POST /lite/create_bind_task`  {"key": base64(32B)}  → data.task_id
//!   `POST /lite/poll_bind_result`  {"task_id": ...}      → data.status / bot_appid /
//!                                                          bot_encrypt_secret / user_openid
//!   二维码内容 = `https://q.qq.com/qqbot/openclaw/connect.html?task_id=…&source=…&_wv=2`
//!
//! 安全要点（改这个模块前先读）：
//!   * 32 字节任务密钥 `key` 只存在于本进程内存：不进二维码、不进 UCI、不写日志；
//!   * 二维码里只有 `task_id`，截图或被转发都拿不到 AppSecret（密钥不在二维码里）；
//!   * 明文 AppSecret 只在解密瞬间存在于内存，落盘走与手工填写同一条 UCI 路径；
//!   * 前端 RPC 永远只拿到 AppID 与 openid，**AppSecret 一个字节都不下发**。

use crate::{log_debug, log_info};
use serde_json::Value;
use std::time::Duration;

/// 创建绑定任务（body 里的 key 用于加密回传的 AppSecret）
const CREATE_TASK_URL: &str = "https://q.qq.com/lite/create_bind_task";
/// 轮询扫码结果
const POLL_RESULT_URL: &str = "https://q.qq.com/lite/poll_bind_result";
/// 二维码承载页（由 QQ 托管，用户在这里完成授权）
const CONNECT_PAGE: &str = "https://q.qq.com/qqbot/openclaw/connect.html";
/// 单次 HTTP 预算（与 qqpush 的 10s 对齐：路由器弱网下再长会让 LuCI 侧先超时）
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
/// 任务状态：2 = 已扫码并授权完成，3 = 二维码过期
const STATUS_COMPLETED: i64 = 2;
const STATUS_EXPIRED: i64 = 3;

/// 扫码会话阶段（对前端暴露 idle / pending / success / expired / failed）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Phase {
    #[default]
    Idle,
    Pending,
    Complete,
    Expired,
    /// 终态失败：原因存在 `Inner::failure`，重新 start 才能恢复
    Failed,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Pending => "pending",
            Phase::Complete => "success",
            Phase::Expired => "expired",
            Phase::Failed => "failed",
        }
    }
}

/// 扫码得到的绑定结果（AppID + 扫码者 openid）。AppSecret 不进这个结构，避免被顺手序列化出去。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub app_id: String,
    pub openid: String,
}

/// 一次 `qq_qr_start` 的返回：二维码内容 + 矩阵（前端据此画 canvas，不下发 SVG 字符串）
#[derive(Debug, Clone)]
pub struct StartInfo {
    /// 二维码承载页 URL（前端也会展示成可点击链接，终端二维码排版错位时可直接点开）
    pub url: String,
    /// 模块边长（含定位图案，不含静区）
    pub size: i32,
    /// 每行一条 "1010…" 串，'1' 为黑块
    pub rows: Vec<String>,
}

/// 一次轮询的结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollOutcome {
    /// 当前没有进行中的会话（没扫过 / 已取消）
    Idle,
    /// 等待扫码或等待用户点「连接」
    Pending,
    /// 二维码已过期，需要重新 start
    Expired,
    /// 会话已进入终态失败（协议应答残缺 / 解密失败）。重试同一个 task 只会得到
    /// 同样的结果，前端必须停下来让用户重新出码，不能当成网络抖动一直重试。
    Failed(String),
    /// 扫码完成。`app_secret` 仅在**首次**完成的那次轮询里是 `Some`：
    /// 上层用它写一次 UCI 就够，重复轮询不应反复落盘明文。
    Complete {
        app_id: String,
        app_secret: Option<String>,
        openid: String,
    },
}

#[derive(Debug, Default)]
struct Inner {
    /// 会话代号：每次 start/cancel 自增。迟到的轮询结果必须带着旧代号回来，
    /// 否则「用户点了刷新，旧任务的响应恰好此刻到达」会把新二维码的密钥清掉，
    /// 新码从此再也解不开（这不是理论风险，是 2s 轮询下很容易撞上的时序）。
    epoch: u64,
    phase: Phase,
    task_id: String,
    /// 仅内存持有；`task_id` 失效后一并清掉
    key_b64: String,
    outcome: Option<Outcome>,
    /// `Phase::Failed` 的原因（终端错误，不能让前端当成网络抖动反复重试）
    failure: Option<String>,
}

/// 扫码绑定会话。字段用 `std::sync::Mutex` 保护（临界区只有几次内存操作，无 `await`），
/// 写侧是 RPC handler，读侧同样是 RPC handler，两者都在 Tokio 线程上。
#[derive(Debug, Default)]
pub struct QrBind {
    inner: std::sync::Mutex<Inner>,
    /// 串行化 start：两次并发的 start 会各建一个服务端任务，后写会话的那个让
    /// 先返回的二维码变成死码（前端画的是 A，后端轮询的是 B），用户扫完永远没反应。
    start_lock: tokio::sync::Mutex<()>,
}

impl QrBind {
    pub fn new() -> QrBind {
        QrBind::default()
    }

    /// 当前阶段（供状态查询，不触发网络）
    pub fn phase(&self) -> Phase {
        self.inner.lock().map(|g| g.phase).unwrap_or_default()
    }

    /// 创建新任务并返回二维码。会无条件覆盖上一次未完成的会话：
    /// 同时维护两个 task 只会让前端不知道该显示哪张码。
    pub async fn start(&self, source: &str) -> Result<StartInfo, String> {
        // 同一时刻只允许一个 start 在飞行（见字段注释）。cancel 不持这把锁，
        // 所以下面还要用 epoch 复核「申请任务期间是否被取消」。
        let _start_guard = self.start_lock.lock().await;
        let epoch_before = self
            .inner
            .lock()
            .map_err(|_| "扫码会话状态锁异常".to_string())?
            .epoch;
        let key_b64 = tokio::task::spawn_blocking(random_key_b64)
            .await
            .map_err(|e| format!("生成任务密钥失败: {e}"))??;
        let key = key_b64.clone();
        let task_id = tokio::task::spawn_blocking(move || create_task(&key))
            .await
            .map_err(|e| format!("创建绑定任务失败: {e}"))??;
        let url = build_connect_url(&task_id, source);
        // 矩阵生成是纯计算（几十微秒），不涉及阻塞 IO，留在 async 上下文里
        let (size, rows) = qr_matrix(&url)?;
        // 锁中毒（其它线程 panic 过）时必须报错：静默跳过会让二维码显示出来、
        // 但会话是空的，前端只会一直拿到 idle 反复重出码，问题被掩盖成"网络不好"
        let mut g = self
            .inner
            .lock()
            .map_err(|_| "扫码会话状态锁异常".to_string())?;
        if g.epoch != epoch_before {
            // 申请期间被 cancel：这张码对应的会话已经被丢弃，交回去只会让用户
            // 扫一张后端不认的二维码。
            return Err("扫码会话已被取消，请重新生成二维码".into());
        }
        let epoch = g.epoch.wrapping_add(1);
        *g = Inner {
            epoch,
            phase: Phase::Pending,
            task_id,
            key_b64,
            outcome: None,
            failure: None,
        };
        Ok(StartInfo { url, size, rows })
    }

    /// 轮询一次（前端每 2s 调一次，节奏由前端掌握，后端不做定时器）。
    ///
    /// 网络失败**不清会话**：路由器刚拨上号、DNS 抖动、网关偶发 502 都很常见，
    /// 一次失败就把用户的二维码作废，体验比"多等两秒"差得多。真正的失效只有
    /// 服务端明确返回 expired（status=3）。
    ///
    /// 但「服务端说已完成、我们却解不出来」是终态：同一个 task 再轮询只会得到
    /// 同样的应答，必须置 `Phase::Failed` 让前端停下来，否则会以 2s 节奏无限重试
    /// 一个永远失败的结果，用户只看到「网络抖动」。
    pub async fn poll(&self) -> Result<PollOutcome, String> {
        let Snapshot {
            task_id,
            key_b64,
            phase,
            outcome,
            failure,
            epoch,
        } = {
            let g = self.inner.lock().map_err(|_| "扫码会话状态锁异常".to_string())?;
            Snapshot {
                task_id: g.task_id.clone(),
                key_b64: g.key_b64.clone(),
                phase: g.phase,
                outcome: g.outcome.clone(),
                failure: g.failure.clone(),
                epoch: g.epoch,
            } // 锁在此释放：下面的网络请求可能几百毫秒，不能带着锁
        };
        match phase {
            Phase::Idle | Phase::Expired => {
                return Ok(if phase == Phase::Expired {
                    PollOutcome::Expired
                } else {
                    PollOutcome::Idle
                })
            }
            Phase::Failed => {
                return Ok(PollOutcome::Failed(
                    failure.unwrap_or_else(|| "扫码绑定失败".to_string()),
                ))
            }
            Phase::Complete => {
                let o = outcome.ok_or_else(|| "扫码会话缺少绑定结果".to_string())?;
                // 重复轮询只回显结果，不再给 AppSecret（避免前端拿到可重放的明文）
                return Ok(PollOutcome::Complete {
                    app_id: o.app_id,
                    app_secret: None,
                    openid: o.openid,
                });
            }
            Phase::Pending => {}
        }

        let tid = task_id.clone();
        let reply = tokio::task::spawn_blocking(move || poll_task(&tid))
            .await
            .map_err(|e| format!("轮询扫码结果失败: {e}"))??;

        match reply.status {
            STATUS_COMPLETED => {
                let decrypted = if reply.encrypt_secret.is_empty() || reply.app_id.is_empty() {
                    Err("扫码结果缺少 AppID 或密文（可能不是一次完整授权）".to_string())
                } else {
                    decrypt_secret(&reply.encrypt_secret, &key_b64)
                };
                let app_secret = match decrypted {
                    Ok(s) => s,
                    Err(msg) => {
                        // 终态失败：丢弃 task/key，只保留原因供前端展示（不自动重出码，
                        // 避免「解密一直失败 → 前端自动刷新 → 用户反复扫码」的死循环）
                        let stale = self.settle(epoch, Phase::Failed, None, Some(msg.clone()))?;
                        return Ok(if stale {
                            PollOutcome::Pending
                        } else {
                            PollOutcome::Failed(msg)
                        });
                    }
                };
                let outcome = Outcome {
                    app_id: reply.app_id.clone(),
                    openid: reply.openid.clone(),
                };
                let stale = self.settle(epoch, Phase::Complete, Some(outcome), None)?;
                if stale {
                    return Ok(PollOutcome::Pending);
                }
                Ok(PollOutcome::Complete {
                    app_id: reply.app_id,
                    app_secret: Some(app_secret),
                    openid: reply.openid,
                })
            }
            STATUS_EXPIRED => {
                let stale = self.settle(epoch, Phase::Expired, None, None)?;
                if stale {
                    return Ok(PollOutcome::Pending);
                }
                Ok(PollOutcome::Expired)
            }
            // 0 = 任务不存在 / 1 = 等待扫码：都按"继续等"处理，前端只看 state
            _ => Ok(PollOutcome::Pending),
        }
    }

    /// 在会话代号仍然匹配时写入终态并清掉 task/key；返回 `true` 表示结果属于旧会话，
    /// 调用方必须整份丢弃（不能碰新会话的 key，否则新二维码永远解不开）。
    fn settle(
        &self,
        epoch: u64,
        phase: Phase,
        outcome: Option<Outcome>,
        failure: Option<String>,
    ) -> Result<bool, String> {
        let mut g = self.inner.lock().map_err(|_| "扫码会话状态锁异常".to_string())?;
        if g.epoch != epoch {
            return Ok(true);
        }
        g.phase = phase;
        g.outcome = outcome;
        g.failure = failure;
        g.task_id.clear();
        // 密钥用完即弃：进入终态后没有任何地方还需要它
        g.key_b64.clear();
        Ok(false)
    }

    /// 取消扫码（关闭面板、刷新二维码前调用）。丢弃 task 后服务端任务会自行过期。
    ///
    /// 代号必须自增：正在飞行中的 `poll` 回来时会发现代号对不上而丢弃结果，
    /// 否则取消瞬间到达的成功响应会把「已取消」的会话又改写回 success。
    pub fn cancel(&self) {
        if let Ok(mut g) = self.inner.lock() {
            let epoch = g.epoch.wrapping_add(1);
            *g = Inner {
                epoch,
                ..Inner::default()
            };
        }
    }

    // ---------------- RPC 入口（rpcserver 只做参数取值与 {"id","result"} 包装） ----------------
    //
    // 把「谁落盘、谁热替换、返回什么给前端」全部收在本模块：扫码是一条独立业务链，
    // 散进 rpcserver 的大 match 后，改协议要同时翻两个文件，很容易只改一半。

    pub async fn rpc_start(&self, source: &str) -> serde_json::Value {
        // 覆盖上一次会话前把旧状态留在日志里，排查「为什么码突然换了」时有据可查
        log_debug!("QQ 扫码绑定：申请新任务（上一会话 {}，source {}）", self.phase().as_str(), source);
        match self.start(source).await {
            Ok(info) => serde_json::json!({
                "success": true,
                "url": info.url,
                "qr": { "size": info.size, "rows": info.rows },
            }),
            Err(e) => serde_json::json!({ "success": false, "error": e }),
        }
    }

    pub async fn rpc_poll(&self, notify: &std::sync::Arc<crate::notify::Notifier>) -> serde_json::Value {
        match self.poll().await {
            Ok(PollOutcome::Complete { app_id, app_secret, openid }) => {
                let mut saved = true;
                let mut save_error = String::new();
                // 只有首次完成才带 AppSecret：重复轮询不反复写盘、不反复热替换
                if let Some(secret) = app_secret.as_deref() {
                    match persist_credentials(&app_id, secret, &openid).await {
                        Ok(()) => {
                            // 只有落盘成功才热替换：否则运行中的通道会用一份「重启后就
                            // 消失」的密钥，表现为当时能推、重启后全挂且日志无线索。
                            // rebind_qq 内部会 fork uci 推导管理页地址，必须离开 reactor 线程
                            let n = notify.clone();
                            let (aid, sec, oid) = (app_id.clone(), secret.to_string(), openid.clone());
                            if tokio::task::spawn_blocking(move || n.rebind_qq(&aid, &sec, &oid))
                                .await
                                .unwrap_or(false)
                            {
                                log_info!("QQ 扫码绑定：通道已热替换（openid {}）", if openid.is_empty() { "-" } else { openid.as_str() });
                            }
                        }
                        Err(e) => {
                            saved = false;
                            save_error = e;
                        }
                    }
                }
                serde_json::json!({
                    "success": true,
                    "state": "success",
                    "app_id": app_id,
                    "target_id": openid,
                    "saved": saved,
                    "save_error": save_error,
                })
            }
            Ok(PollOutcome::Pending) => serde_json::json!({ "success": true, "state": "pending" }),
            Ok(PollOutcome::Expired) => serde_json::json!({
                "success": true, "state": "expired", "hint": "二维码已过期，请重新生成",
            }),
            // 只有没 start 过或已取消时才会是 Idle，前端按「重新出码」处理
            Ok(PollOutcome::Idle) => serde_json::json!({ "success": true, "state": "idle" }),
            // 终态失败（应答残缺/解密失败）：`retryable=false` 让前端立刻停下，
            // 不要用「网络抖动」的退避逻辑把一个永远不会变的结果重试 89 秒。
            Ok(PollOutcome::Failed(e)) => serde_json::json!({
                "success": false, "state": "failed", "retryable": false, "error": e,
            }),
            // 网络/协议传输层错误：会话仍是 Pending，前端退避后重试即可
            Err(e) => serde_json::json!({
                "success": false, "state": "failed", "retryable": true, "error": e,
            }),
        }
    }

    pub fn rpc_cancel(&self) -> serde_json::Value {
        // 丢弃内存态即可：服务端 task 未完成会自行过期，不需要额外请求
        self.cancel();
        serde_json::json!({ "success": true })
    }

    /// 仅测试用：读取会话代号，验证 start/cancel 是否真的推进了它。
    #[cfg(test)]
    fn epoch_for_test(&self) -> u64 {
        self.inner.lock().map(|g| g.epoch).unwrap_or(0)
    }
}

/// `poll()` 里把锁内状态拷出来用的临时载体（避免跨 `await` 持锁）
struct Snapshot {
    task_id: String,
    key_b64: String,
    phase: Phase,
    outcome: Option<Outcome>,
    /// `Phase::Failed` 的终态原因
    failure: Option<String>,
    /// 取快照时的会话代号：回写状态前必须复核，见 `Inner::epoch` 的注释
    epoch: u64,
}

/// 把扫码得到的凭据写回 UCI（与手工填写同一组键），并 commit。
///
/// openid 为空时不覆盖目标：那种情况说明这次只授权了机器人、没带扫码者身份，
/// 把 target 写成空字符串会让原本配好的群目标凭空消失。
pub async fn persist_credentials(app_id: &str, app_secret: &str, openid: &str) -> Result<(), String> {
    let mut pairs: Vec<(&str, &str)> = vec![("qq_app_id", app_id), ("qq_app_secret", app_secret)];
    if !openid.is_empty() {
        pairs.push(("qq_target_type", "c2c"));
        pairs.push(("qq_target_id", openid));
    }
    for (applied, (k, v)) in pairs.into_iter().enumerate() {
        if let Err(e) = crate::qqbind::run_cmd("uci", &["set", &format!("mt5700d.config.{k}={v}")]).await {
            if applied > 0 {
                // 半写状态必须撤干净：`uci set` 只写 /tmp/.uci 的增量，残余项会被
                // init.d reload_service 里那句 `uci -q commit mt5700d` 顺带提交上去，
                // 变成「AppID 是新的、Secret 是旧的」这种最难受的错配。
                let _ = crate::qqbind::run_cmd("uci", &["revert", "mt5700d"]).await;
            }
            return Err(e);
        }
    }
    crate::qqbind::run_cmd("uci", &["commit", "mt5700d"]).await?;
    // 凭据落盘后收紧权限：UCI 默认 0644，而扫码绑定让「密钥落盘」变成默认路径。
    // 用 busybox chmod 而不是 std::os::unix：本项目的单测还要在 Windows 上跑，
    // `cfg(unix)` 分支在本地没有任何编译验证机会；chmod 失败也不影响绑定本身。
    harden_config_permissions().await;
    Ok(())
}

/// `/etc/config/mt5700d` 收紧到 0600（仅 root 可读）。
async fn harden_config_permissions() {
    if let Err(e) = crate::qqbind::run_cmd("chmod", &["600", "/etc/config/mt5700d"]).await {
        log_debug!("QQ 扫码绑定：收紧配置文件权限失败（不影响绑定）: {e}");
    }
}

// ---------------- 协议层（全部同步，由上层 spawn_blocking 调起） ----------------

/// 复用的 HTTP Agent：`ureq::post` 每次都会新建连接，2s 一次的轮询等于反复做
/// TLS 握手（5G 上单次 300–500ms、CPU 也明显）。Agent 自带连接池 + keep-alive。
fn http_agent() -> &'static ureq::Agent {
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    AGENT.get_or_init(|| ureq::AgentBuilder::new().timeout(HTTP_TIMEOUT).build())
}

fn create_task(key_b64: &str) -> Result<String, String> {
    let v = post_json(CREATE_TASK_URL, &serde_json::json!({ "key": key_b64 }))?;
    check_retcode(&v)?;
    let task_id = v
        .pointer("/data/task_id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if task_id.is_empty() {
        return Err("创建绑定任务失败：响应缺少 task_id".into());
    }
    Ok(task_id)
}

struct PollReply {
    status: i64,
    app_id: String,
    encrypt_secret: String,
    openid: String,
}

fn poll_task(task_id: &str) -> Result<PollReply, String> {
    let v = post_json(POLL_RESULT_URL, &serde_json::json!({ "task_id": task_id }))?;
    check_retcode(&v)?;
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    Ok(PollReply {
        status: as_int(data.get("status")).unwrap_or(0),
        // bot_appid 有时以数字下发，统一转成字符串，避免下游再分两种情况
        app_id: match data.get("bot_appid") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            _ => String::new(),
        },
        encrypt_secret: data
            .get("bot_encrypt_secret")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        openid: data
            .get("user_openid")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// 数字或数字字符串都能取。
///
/// 官方 SDK 用 `!== 0` / `?? 0` 直接比数字，所以这层兼容不是协议要求；但一旦平台
/// 侧把 `retcode`/`status` 换成字符串（`bot_appid` 就已经出现过两种形态），严格
/// `as_i64` 会把「已完成」读成 0（pending），表现为扫码成功但永远不结束——这类
/// 失败从日志上完全看不出来，容错成本又极低。
fn as_int(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn check_retcode(v: &Value) -> Result<(), String> {
    if as_int(v.get("retcode")) == Some(0) {
        return Ok(());
    }
    let msg = v.get("msg").and_then(|x| x.as_str()).unwrap_or("未知错误");
    Err(format!("QQ 开放平台返回失败: {msg}"))
}

fn post_json(url: &str, body: &Value) -> Result<Value, String> {
    let resp = http_agent()
        .post(url)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .send_string(&body.to_string())
        .map_err(|e| format!("请求 {url} 失败（路由器需已拨号且系统时间正确）: {e}"))?;
    if resp.status() != 200 {
        return Err(format!("{url} 返回 HTTP {}", resp.status()));
    }
    let text = resp.into_string().map_err(|e| format!("读取 {url} 响应失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{url} 响应不是合法 JSON: {e}"))
}

/// 二维码承载页 URL。`_wv=2` 是 QQ 侧要求的内嵌页参数，缺了会在部分版本里进错页面。
fn build_connect_url(task_id: &str, source: &str) -> String {
    format!(
        "{CONNECT_PAGE}?task_id={}&source={}&_wv=2",
        percent_encode(task_id),
        percent_encode(source)
    )
}

/// 只保留 `A-Za-z0-9-_.~`，其余（含中文平台名）一律百分号编码：
/// URL 会进二维码，中文不编码会在部分扫码器里变成乱码。
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let keep = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~');
        if keep {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

/// 生成 32 字节任务密钥（base64）。读 `/dev/urandom` 是阻塞 IO，必须在 `spawn_blocking` 里调。
fn random_key_b64() -> Result<String, String> {
    use std::io::Read;
    let mut buf = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| format!("读取 /dev/urandom 失败: {e}"))?;
    Ok(base64_encode(&buf))
}

/// 标准 base64（无换行、带 padding）。只为一个 32 字节密钥服务，不引第三方 base64 依赖。
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len() * 4 / 3 + 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let v = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(v >> 18) as usize & 0x3f] as char);
        out.push(TABLE[(v >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 { TABLE[(v >> 6) as usize & 0x3f] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[v as usize & 0x3f] as char } else { '=' });
    }
    out
}

/// AES-256-GCM 解密。密文布局：`IV(12B) || ciphertext || AuthTag(16B)`（官方 SDK 约定）。
///
/// 认证失败（tag 不匹配）说明密文被改过或密钥不对，必须报错而不是返回半截明文。
fn decrypt_secret(encrypted_b64: &str, key_b64: &str) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    let key = b64_decode(key_b64).ok_or_else(|| "任务密钥不是合法 base64".to_string())?;
    let payload = b64_decode(encrypted_b64).ok_or_else(|| "密文不是合法 base64".to_string())?;
    if payload.len() < 12 + 16 {
        return Err("密文长度不足（缺少 IV 或 AuthTag）".into());
    }
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "任务密钥长度不是 32 字节".to_string())?;
    let nonce = Nonce::from_slice(&payload[..12]);
    // aes-gcm 的 decrypt 期望 tag 紧跟在密文尾部，正好对应官方布局
    let plain = cipher
        .decrypt(nonce, &payload[12..])
        .map_err(|_| "AppSecret 解密失败（密文认证不通过）".to_string())?;
    String::from_utf8(plain).map_err(|e| format!("解密结果不是 UTF-8: {e}"))
}

/// base64 解码（标准表 + 可选 URL-safe 变体 + 省略 padding 也接受），只服务密钥与密文。
///
/// 为什么容忍无 padding：官方服务端按 `Buffer.from(x, 'base64')` 生成密文，
/// 某些实现会省掉 `=`。JS 能解，我们若严格要求 4 的倍数就会把合法密文判成非法，
/// 表现为「扫码成功但解密失败」——这种失败极难从日志上看出来。
fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let mut bytes: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let rem = bytes.len() % 4;
    if rem == 1 {
        return None; // 1 个余数字符不可能由任何合法 base64 产生
    }
    if rem != 0 {
        bytes.resize(bytes.len() + (4 - rem), b'=');
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for group in bytes.chunks(4) {
        let mut vals = [0u8; 4];
        for (i, b) in group.iter().enumerate() {
            vals[i] = match b {
                b'A'..=b'Z' => b - b'A',
                b'a'..=b'z' => b - b'a' + 26,
                b'0'..=b'9' => b - b'0' + 52,
                b'+' | b'-' => 62,
                b'/' | b'_' => 63,
                b'=' => 0,
                _ => return None,
            };
        }
        let v = u32::from(vals[0]) << 18
            | u32::from(vals[1]) << 12
            | u32::from(vals[2]) << 6
            | u32::from(vals[3]);
        out.push((v >> 16) as u8);
        if group[2] != b'=' {
            out.push((v >> 8) as u8);
        }
        if group[3] != b'=' {
            out.push(v as u8);
        }
    }
    Some(out)
}

/// 生成二维码矩阵（不含静区，静区由前端加：4 个模块）。
/// 返回 `(边长, 每行 "0101…")`；前端用 canvas 逐格填充，不做 SVG 拼接，避免注入面。
fn qr_matrix(text: &str) -> Result<(i32, Vec<String>), String> {
    use qrcodegen::{QrCode, QrCodeEcc};
    let code = QrCode::encode_text(text, QrCodeEcc::Medium).map_err(|e| format!("二维码内容过长: {e}"))?;
    let size = code.size();
    let mut rows = Vec::with_capacity(size as usize);
    for y in 0..size {
        let mut row = String::with_capacity(size as usize);
        for x in 0..size {
            row.push(if code.get_module(x, y) { '1' } else { '0' });
        }
        rows.push(row);
    }
    Ok((size, rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_encode_matches_rfc4648_vectors() {
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(base64_encode(b"Ma"), "TWE=");
        assert_eq!(base64_encode(b"M"), "TQ==");
        // 32 字节 → 44 字符（不丢 padding），服务端按这个长度校验过
        assert_eq!(base64_encode(&[0u8; 32]).len(), 44);
    }

    #[test]
    fn base64_roundtrip_32_bytes() {
        let key: Vec<u8> = (0..32).collect();
        let enc = base64_encode(&key);
        assert_eq!(b64_decode(&enc).unwrap(), key);
    }

    #[test]
    fn int_fields_accept_string_and_number() {
        assert_eq!(as_int(Some(&serde_json::json!(2))), Some(2));
        assert_eq!(as_int(Some(&serde_json::json!("2"))), Some(2));
        assert_eq!(as_int(Some(&serde_json::json!(" 0 "))), Some(0));
        assert_eq!(as_int(Some(&serde_json::json!(null))), None);
        assert_eq!(as_int(Some(&serde_json::json!("x"))), None);
        assert_eq!(as_int(None), None);
    }

    #[tokio::test]
    async fn failed_phase_is_terminal_and_reports_reason() {
        let q = QrBind::new();
        {
            let mut g = q.inner.lock().unwrap();
            g.epoch = 3;
            g.phase = Phase::Failed;
            g.failure = Some("AppSecret 解密失败".into());
        }
        // 终态失败必须原样回放原因，且不触发网络（没有 task_id 也不会 panic）
        assert_eq!(
            q.poll().await.unwrap(),
            PollOutcome::Failed("AppSecret 解密失败".into())
        );
    }

    #[tokio::test]
    async fn settle_with_stale_epoch_never_touches_new_session() {
        let q = QrBind::new();
        {
            let mut g = q.inner.lock().unwrap();
            g.epoch = 5;
            g.phase = Phase::Pending;
            g.task_id = "NEW-TASK".into();
            g.key_b64 = "NEW-KEY".into();
        }
        // 旧会话（epoch 4）迟到的终态写入必须被丢弃：否则新二维码的密钥被清掉，
        // 用户扫完永远解不开。
        assert!(q.settle(4, Phase::Complete, None, None).unwrap());
        let g = q.inner.lock().unwrap();
        assert_eq!(g.phase, Phase::Pending);
        assert_eq!(g.task_id, "NEW-TASK");
        assert_eq!(g.key_b64, "NEW-KEY");
    }

    #[test]
    fn connect_url_carries_task_and_source() {
        let url = build_connect_url("task-123", "mt5700d");
        assert!(url.starts_with(CONNECT_PAGE));
        assert!(url.contains("task_id=task-123"));
        assert!(url.contains("source=mt5700d"));
        assert!(url.ends_with("_wv=2"));
        // 中文平台名必须编码，否则扫码器里是乱码
        let url = build_connect_url("t", "测试平台");
        assert!(url.contains("source=%E6"), "中文应被百分号编码: {url}");
        assert!(!url.contains('测'), "URL 里不得残留原始中文");
    }

    fn seal(secret: &str, key: &[u8; 32]) -> String {
        use aes_gcm::aead::{Aead, KeyInit};
        use aes_gcm::{Aes256Gcm, Nonce};
        let cipher = Aes256Gcm::new_from_slice(key).unwrap();
        let nonce = Nonce::from_slice(&[7u8; 12]);
        let ct = cipher.encrypt(nonce, secret.as_bytes()).unwrap();
        let mut payload = Vec::new();
        payload.extend_from_slice(&[7u8; 12]);
        payload.extend_from_slice(&ct); // aes-gcm 已把 tag 拼在尾部
        base64_encode(&payload)
    }

    #[test]
    fn decrypt_recovers_secret() {
        let key = [9u8; 32];
        let enc = seal("SECRET-abc123", &key);
        assert_eq!(decrypt_secret(&enc, &base64_encode(&key)).unwrap(), "SECRET-abc123");
    }

    #[test]
    fn decrypt_rejects_tampered_or_short_payload() {
        let key = [9u8; 32];
        let mut payload = b64_decode(&seal("SECRET-abc123", &key)).unwrap();
        payload[13] ^= 0x01; // 改一个字节 → AuthTag 必须失败
        assert!(decrypt_secret(&base64_encode(&payload), &base64_encode(&key)).is_err());
        assert!(decrypt_secret(&base64_encode(&[1u8; 10]), &base64_encode(&key)).is_err());
        assert!(decrypt_secret("!!!", &base64_encode(&key)).is_err());
    }

    #[test]
    fn qr_matrix_is_square_and_has_finder_pattern() {
        let (size, rows) = qr_matrix("https://q.qq.com/qqbot/openclaw/connect.html?task_id=x").unwrap();
        assert!(size >= 21, "最小版本仍有 21 个模块");
        assert_eq!(rows.len() as i32, size);
        assert!(rows.iter().all(|r| r.len() as i32 == size));
        // 左上定位图案的外环四角必须是黑块
        for (x, y) in [(0, 0), (size - 1, 0), (0, size - 1)] {
            let row = &rows[y as usize];
            assert_eq!(&row[x as usize..=x as usize], "1");
        }
    }

    #[tokio::test]
    async fn poll_without_session_is_idle() {
        let q = QrBind::new();
        assert_eq!(q.phase(), Phase::Idle);
        assert_eq!(q.poll().await.unwrap(), PollOutcome::Idle);
    }

    #[test]
    fn cancel_resets_session() {
        let q = QrBind::new();
        q.cancel(); // 空闲时取消不应 panic
        assert_eq!(q.phase(), Phase::Idle);
    }

    #[test]
    fn percent_encode_keeps_unreserved_only() {
        assert_eq!(percent_encode("abc-_.~123"), "abc-_.~123");
        assert_eq!(percent_encode("a b"), "a%20b");
    }

    #[test]
    fn b64_decode_accepts_unpadded_and_url_safe() {
        // 官方用 JS Buffer 解码，padding 可有可无：我们这边也必须能解
        let key: Vec<u8> = (0..32).collect();
        let enc = base64_encode(&key);
        assert_eq!(b64_decode(enc.trim_end_matches('=')).unwrap(), key);
        assert_eq!(b64_decode("TWFu").unwrap(), b"Man".to_vec());
        assert_eq!(b64_decode("TQ==").unwrap(), b"M".to_vec());
        // URL-safe 变体（- _）同样接受：两个字符只产出 1 个字节
        assert_eq!(b64_decode("-_").unwrap(), vec![0xfb]);
        // 余 1 个字符不可能由任何合法 base64 产生
        assert!(b64_decode("A").is_none());
        assert!(b64_decode("!!!").is_none());
    }

    #[test]
    fn cancel_bumps_epoch_so_stale_polls_are_dropped() {
        let q = QrBind::new();
        let e0 = q.epoch_for_test();
        q.cancel();
        assert!(q.epoch_for_test() > e0, "取消必须推进代号，否则飞行中的旧结果会写回新会话");
    }
}
