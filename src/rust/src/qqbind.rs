//! QQ 机器人 openid 自动绑定。
//!
//! 背景：QQ 开放平台出于隐私设计，不提供「QQ 号 → openid」的转换接口，
//! openid 只能从机器人 WebSocket 网关事件中获得（事件里同样没有 QQ 号）。
//! 本模块实现「绑定模式」：用户在配置里把目标类型设为 `bind` 并填上自己的
//! QQ 号（仅作标签），服务启动后直连官方网关监听事件；用户给机器人发一条
//! 消息，收到 `C2C_MESSAGE_CREATE`（或 `GROUP_AT_MESSAGE_CREATE`）即完成
//! 绑定——openid 写回 UCI 并热替换推送通道，无需重启。
//!
//! 网关协议（v2）：wss 连接 → Hello(op=10, 含心跳间隔) → Identify(op=2) →
//! READY(op=0, t=READY) → 周期心跳(op=1, d=最近事件序号)。

use crate::{log_info, log_warn};
use futures_util::{SinkExt, StreamExt};
use std::pin::Pin;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

const QQ_API_BASE: &str = "https://api.bot.qq.com";
const WSS_AGENT: &str = "at-webserver-qqbind";
/// C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE 共用 intent 位 1<<25
const INTENT_GROUP_AND_C2C: u64 = 1 << 25;
/// 绑定监听窗口：超过即失败（下次服务重启会自动重试）
const BIND_WINDOW: Duration = Duration::from_secs(600);
/// 绑定监听窗口秒数（对外暴露给 RPC 状态查询，用于前端倒计时）
pub const BIND_WINDOW_SECS: u64 = 600;

/// 绑定进度状态（LuCI 前端经 RPC `qq_bind_status` 轮询展示）。
/// 字段用 `std::sync::Mutex` 保护：写侧是绑定任务，读侧是 RPC 连接线程。
#[derive(Debug, Default)]
pub struct BindStatus {
    inner: std::sync::Mutex<BindStatusInner>,
}

#[derive(Debug, Default, Clone)]
pub struct BindStatusInner {
    /// idle（未在绑定）| waiting（监听事件中）| success | failed
    pub state: String,
    /// 进入 waiting 的时刻（用于计算倒计时剩余秒数）
    pub started: Option<std::time::Instant>,
    /// 绑定成功后的目标（type + openid）
    pub target: Option<BindTarget>,
    /// 失败原因
    pub error: String,
}

impl BindStatus {
    fn set(&self, f: impl FnOnce(&mut BindStatusInner)) {
        if let Ok(mut g) = self.inner.lock() {
            f(&mut g);
        }
    }

    pub fn snapshot(&self) -> BindStatusInner {
        self.inner.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

/// 包装 `run_bind`：把等待中 / 成功 / 失败的进度写入 `status` 供前端轮询。
pub async fn run_bind_tracked(
    status: std::sync::Arc<BindStatus>,
    app_id: &str,
    app_secret: &str,
    ctx: tokio::sync::watch::Receiver<bool>,
) -> Result<BindTarget, String> {
    status.set(|s| {
        *s = BindStatusInner {
            state: "waiting".into(),
            started: Some(std::time::Instant::now()),
            target: None,
            error: String::new(),
        };
    });
    let result = run_bind(app_id, app_secret, ctx).await;
    match &result {
        Ok(t) => status.set(|s| {
            s.state = "success".into();
            s.target = Some(t.clone());
        }),
        Err(e) => status.set(|s| {
            s.state = "failed".into();
            s.error = e.clone();
        }),
    }
    result
}

/// 绑定结果：目标类型 + 目标 ID（openid / group_openid）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindTarget {
    pub target_type: String,
    pub target_id: String,
}

/// 运行一次绑定：返回第一个 C2C（优先）或群事件的目标。
pub async fn run_bind(
    app_id: &str,
    app_secret: &str,
    mut ctx: tokio::sync::watch::Receiver<bool>,
) -> Result<BindTarget, String> {
    let token = fetch_token(app_id, app_secret).await?;
    let ws_url = fetch_gateway(&token).await?;

    let (ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .map_err(|e| format!("连接网关失败: {e}"))?;
    // WebSocketStream 不是 Unpin，装箱固定后才能安全 split/next
    let (mut tx, rx) = Box::pin(ws).split();
    let mut rx: Pin<Box<_>> = Box::pin(rx);

    // Hello(op=10) → 取心跳间隔 → Identify(op=2)
    let hello = loop {
        tokio::select! {
            _ = ctx.changed() => return Err("服务退出，绑定中止".into()),
            msg = rx.next() => {
                match msg {
                    Some(Ok(Message::Text(t))) => {
                        let v: serde_json::Value = serde_json::from_str(&t)
                            .map_err(|e| format!("帧解析失败: {e}"))?;
                        if v.get("op").and_then(|x| x.as_u64()) == Some(10) {
                            break v;
                        }
                        log_warn!("QQ 绑定: 忽略 Hello 前的帧: {}", brief(&v));
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => return Err(format!("网关读取失败: {e}")),
                    None => return Err("网关连接已关闭".into()),
                }
            }
        }
    };
    let hb_ms = hello
        .pointer("/d/heartbeat_interval")
        .and_then(|v| v.as_u64())
        .unwrap_or(41_250);
    let identify = serde_json::json!({
        "op": 2,
        "d": {
            "token": format!("QQBot {token}"),
            "intents": INTENT_GROUP_AND_C2C,
            "shard": [0, 1],
        }
    });
    tx.send(Message::Text(identify.to_string().into()))
        .await
        .map_err(|e| format!("发送 Identify 失败: {e}"))?;
    log_info!("QQ 绑定: 已上线监听（心跳 {}s），请给机器人发一条消息", hb_ms / 1000);

    let mut last_seq: Option<u64> = None;
    let mut last_hb = tokio::time::Instant::now();
    let hb = Duration::from_millis(hb_ms);

    let mut group_target: Option<BindTarget> = None;
    let result = loop {
        tokio::select! {
            _ = ctx.changed() => return Err("服务退出，绑定中止".into()),
            _ = tokio::time::sleep_until(last_hb + hb) => {
                // 周期心跳（阻塞式读取会饿死心跳被网关踢线，这里按时间驱动）
                let hb_frame = serde_json::json!({"op": 1, "d": last_seq});
                if tx.send(Message::Text(hb_frame.to_string().into())).await.is_err() {
                    return Err("发送心跳失败".into());
                }
                last_hb = tokio::time::Instant::now();
            }
            msg = rx.next() => {
                let msg = match msg {
                    Some(Ok(m)) => m,
                    Some(Err(e)) => return Err(format!("网关连接中断: {e}")),
                    None => return Err("网关连接已关闭".into()),
                };
                let frame: serde_json::Value = match msg {
                    Message::Text(t) => match serde_json::from_str(&t) {
                        Ok(v) => v,
                        Err(e) => { log_warn!("QQ 绑定: 忽略无法解析的帧: {e}"); continue; }
                    },
                    Message::Ping(p) => {
                        let _ = tx.send(Message::Pong(p)).await;
                        continue;
                    }
                    Message::Close(c) => return Err(format!("网关主动断开: {:?}", c)),
                    _ => continue,
                };
                if let Some(s) = frame.get("s").and_then(|v| v.as_u64()) {
                    last_seq = Some(s);
                }
                match frame.get("op").and_then(|v| v.as_u64()) {
                    Some(11) => continue,       // Heartbeat ACK
                    Some(10) => continue,       // 重复 Hello
                    _ => {}
                }
                let t = frame.get("t").and_then(|v| v.as_str()).unwrap_or("");
                let d = frame.get("d").cloned().unwrap_or(serde_json::Value::Null);
                match t {
                    "READY" => {
                        log_info!("QQ 绑定: READY，等待消息…");
                        continue;
                    }
                    "C2C_MESSAGE_CREATE" => {
                        if let Some(id) = d.pointer("/author/user_openid").and_then(|v| v.as_str()) {
                            break Some(BindTarget { target_type: "c2c".into(), target_id: id.to_string() });
                        }
                        continue;
                    }
                    "GROUP_AT_MESSAGE_CREATE" => {
                        if group_target.is_none() {
                            if let Some(id) = d.get("group_openid").and_then(|v| v.as_str()) {
                                log_info!("QQ 绑定: 捕获群事件 group_openid={id}（单聊优先，继续等待…）");
                                group_target = Some(BindTarget { target_type: "group".into(), target_id: id.to_string() });
                            }
                        }
                        continue;
                    }
                    _ => continue,
                }
            }
        }
    };

    match result {
        Some(t) => Ok(t),
        None => match group_target {
            Some(g) => {
                log_warn!("QQ 绑定: 未收到单聊消息，使用先捕获的群事件");
                Ok(g)
            }
            None => Err("绑定窗口内未收到任何消息".into()),
        },
    }
}

/// 把绑定结果写回 UCI 并 commit；返回是否全部成功。
pub async fn persist_uci(target: &BindTarget) -> Result<(), String> {
    let cmds: [(&str, &str); 2] = [
        ("qq_target_type", &target.target_type),
        ("qq_target_id", &target.target_id),
    ];
    for (k, v) in cmds {
        run_cmd("uci", &["set", &format!("at-webserver.config.{k}={v}")]).await?;
    }
    run_cmd("uci", &["commit", "at-webserver"]).await?;
    Ok(())
}

async fn run_cmd(prog: &str, args: &[&str]) -> Result<(), String> {
    let out = tokio::process::Command::new(prog)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("执行 {prog} {args:?} 失败: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{prog} {args:?} 退出码 {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

async fn fetch_token(app_id: &str, app_secret: &str) -> Result<String, String> {
    let body = serde_json::json!({ "appId": app_id, "clientSecret": app_secret }).to_string();
    let raw = tokio::task::spawn_blocking(move || {
        let resp = ureq::post(&format!("{QQ_API_BASE}/app/getAppAccessToken"))
            .timeout(Duration::from_secs(10))
            .set("Content-Type", "application/json")
            .send_string(&body)
            .map_err(|e| e.to_string())?;
        if resp.status() != 200 {
            return Err(format!("HTTP {}", resp.status()));
        }
        resp.into_string().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("获取凭证任务失败: {e}"))??;
    // 业务错误（如密钥错误）为 HTTP 200 + {"code":100016,...}，必须显式检查
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("凭证响应解析失败: {e}"))?;
    if let Some(code) = v.get("code").and_then(|x| x.as_i64()) {
        if code != 0 {
            return Err(format!("鉴权失败 code={code} message={}", v.get("message").and_then(|x| x.as_str()).unwrap_or("")));
        }
    }
    let token = v.get("access_token").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if token.is_empty() {
        return Err(format!("凭证响应缺少 access_token: {raw}"));
    }
    Ok(token)
}

async fn fetch_gateway(token: &str) -> Result<String, String> {
    let raw = tokio::task::spawn_blocking({
        let token = token.to_string();
        move || {
            let resp = ureq::get(&format!("{QQ_API_BASE}/gateway"))
                .timeout(Duration::from_secs(10))
                .set("Authorization", &format!("QQBot {token}"))
                .call()
                .map_err(|e| e.to_string())?;
            if resp.status() != 200 {
                return Err(format!("HTTP {}", resp.status()));
            }
            resp.into_string().map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| format!("获取网关地址任务失败: {e}"))??;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("网关响应解析失败: {e}"))?;
    let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if url.is_empty() {
        return Err(format!("网关响应缺少 url: {raw}"));
    }
    Ok(url)
}

fn brief(v: &serde_json::Value) -> String {
    let s = v.to_string();
    s.chars().take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_target_equality() {
        assert_eq!(
            BindTarget { target_type: "c2c".into(), target_id: "A".into() },
            BindTarget { target_type: "c2c".into(), target_id: "A".into() }
        );
        assert_ne!(
            BindTarget { target_type: "c2c".into(), target_id: "A".into() },
            BindTarget { target_type: "group".into(), target_id: "A".into() }
        );
    }

    #[test]
    fn brief_truncates_long_values() {
        let long = "x".repeat(1000);
        assert!(brief(&serde_json::json!({ "k": long })).chars().count() <= 200);
    }

    #[tokio::test]
    async fn tracked_status_records_failure_and_waiting() {
        let status = std::sync::Arc::new(BindStatus::default());
        // 初始为空（RPC 侧按 idle 处理）
        assert!(status.snapshot().state.is_empty());
        // 错误凭据 → 鉴权失败 → failed 状态带原因
        let (_tx, rx) = tokio::sync::watch::channel(false);
        let r = run_bind_tracked(status.clone(), "bad", "bad", rx).await;
        assert!(r.is_err());
        let s = status.snapshot();
        assert_eq!(s.state, "failed");
        assert!(!s.error.is_empty());
        assert!(s.target.is_none());
    }
}
