//! 通知：短信/来电/信号/内存满四类事件，经企业微信 webhook、QQ 机器人（官方 API v2）
//! 与本地日志文件输出（60 秒合并、重试 3 次）。

use crate::{log_error, log_info, log_warn};
use crate::config::NotificationConfig;
use std::path::Path;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

const NOTIFY_INTERVAL: Duration = Duration::from_secs(60);
const NOTIFY_QUEUE_SIZE: usize = 256;
const NOTIFY_MAX_PENDING: usize = 1000;
const NOTIFY_MAX_RETRIES: u32 = 3;

/// QQ 机器人开放接口（API v2）基础地址与令牌提前刷新余量。
/// 文档：https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html
const QQ_API_BASE: &str = "https://api.bot.qq.com";
/// access_token 官方有效期 7200 秒，过期前 60 秒内刷新可拿到新 token 且旧 token 仍有 60 秒余命。
/// 这里提前 120 秒判定过期，避开交界期边界。
const QQ_TOKEN_REFRESH_MARGIN: u64 = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyKind {
    Sms,
    Call,
    MemoryFull,
    Signal,
}

/// 两个特殊发送方名字，决定消息的排版样式。
pub const SENDER_CALL: &str = "来电提醒";
pub const SENDER_SIGNAL: &str = "信号监控";

#[derive(Debug, Clone)]
pub struct Notification {
    pub sender: String,
    pub content: String,
    pub kind: NotifyKind,
    pub memory_full: bool,
}

pub struct Notifier {
    cfg: NotificationConfig,
    /// QQ 机器人通道；未启用（AppID/Secret/目标缺失）或处于绑定模式时为 None。
    /// RwLock 支持「自动绑定」完成后热替换，无需重启服务。
    qq: std::sync::RwLock<Option<std::sync::Arc<QqSender>>>,
    tx: mpsc::Sender<Notification>,
    log_file: Option<String>,
}

#[allow(dead_code)] // 通知事件类型与来源标识
impl Notifier {
    pub fn new(cfg: NotificationConfig) -> (Notifier, mpsc::Receiver<Notification>) {
        let (tx, rx) = mpsc::channel(NOTIFY_QUEUE_SIZE);
        let log_file = if !cfg.log_file.is_empty() {
            match prepare_log_file(&cfg.log_file) {
                Ok(path) => {
                    log_info!("日志通知已启用: {}", path);
                    Some(path)
                }
                Err(e) => {
                    log_error!("日志通知不可用: {}", e);
                    None
                }
            }
        } else {
            None
        };

        if !cfg.wechat_webhook.is_empty() {
            log_info!("企业微信推送已启用");
        }

        let qq = QqSender::from_config(&cfg.qq);
        if let Some(ref s) = qq {
            log_info!("QQ 机器人推送已启用（目标类型: {}）", s.target_type);
        }
        let qq = qq.map(std::sync::Arc::new);

        (
            Notifier {
                cfg,
                qq: std::sync::RwLock::new(qq),
                tx,
                log_file,
            },
            rx,
        )
    }

    pub fn sender(&self) -> mpsc::Sender<Notification> {
        self.tx.clone()
    }

    fn enabled(&self, kind: NotifyKind) -> bool {
        match kind {
            NotifyKind::Sms => self.cfg.types.sms,
            NotifyKind::Call => self.cfg.types.call,
            NotifyKind::MemoryFull => self.cfg.types.memory_full,
            NotifyKind::Signal => self.cfg.types.signal,
        }
    }

    /// 记录一条事件。日志立即落盘，企业微信进入合并队列。
    pub async fn notify(&self, msg: Notification) {
        if !self.enabled(msg.kind) {
            return;
        }

        if let Some(path) = &self.log_file {
            if let Err(e) = append_log(path, &msg) {
                log_error!("写入通知日志失败: {}", e);
            }
        }

        if !self.wechat_enabled() && !self.qq_enabled() {
            return;
        }
        let sender = msg.sender.clone();
        if self.tx.try_send(msg).is_err() {
            log_warn!("通知队列已满，丢弃一条: {}", sender);
        }
    }

    /// 驱动推送通道（企业微信 + QQ 机器人）的合并发送，直到 ctx 结束。
    /// 合并窗口 60 秒：窗口内到达的事件合并成一条发送；空队列不触发发送。
    pub async fn run(&self, mut rx: mpsc::Receiver<Notification>, mut ctx: tokio::sync::watch::Receiver<bool>) {
        if !self.wechat_enabled() && !self.qq_enabled() {
            while ctx.changed().await.is_ok() {}
            return;
        }

        let mut pending: Vec<Notification> = Vec::new();
        let mut last_send = Instant::now() - NOTIFY_INTERVAL;

        loop {
            let wait = NOTIFY_INTERVAL.saturating_sub(last_send.elapsed());
            tokio::select! {
                _ = ctx.changed() => {
                    self.flush_all(&mut pending);
                    return;
                }
                msg = rx.recv() => {
                    match msg {
                        Some(msg) => {
                            if pending.len() >= NOTIFY_MAX_PENDING {
                                log_warn!("待发通知超过 {} 条，丢弃最旧的一条", NOTIFY_MAX_PENDING);
                                pending.remove(0);
                            }
                            pending.push(msg);
                        }
                        None => {
                            self.flush_all(&mut pending);
                            return;
                        }
                    }
                }
                _ = tokio::time::sleep(wait), if !pending.is_empty() => {
                    self.flush_all(&mut pending);
                    last_send = Instant::now();
                }
            }
        }
    }

    /// 把合并窗口内积累的事件广播到所有已启用的推送通道。
    fn flush_all(&self, pending: &mut Vec<Notification>) {
        if pending.is_empty() {
            return;
        }
        let body = combine_messages(pending);
        pending.clear();

        if self.wechat_enabled() {
            let hook = self.cfg.wechat_webhook.clone();
            let body = body.clone();
            tokio::spawn(async move { let _ = send_webhook(&hook, &body).await; });
        }
        if let Some(qq) = self.current_qq() {
            tokio::spawn(async move { let _ = qq.send(&body).await; });
        }
    }

    /// 测试指定推送通道（LuCI「发送测试通知」按钮）。绕过 60 秒合并窗口直接发送。
    pub async fn notify_test(&self, channel: &str) -> Result<(), String> {
        let content = "[luci-app-mt5700] 测试通知：推送通道链路正常";
        match channel {
            "qq" => {
                let qq = self
                    .current_qq()
                    .ok_or_else(|| "QQ 通道未启用（检查 AppID/AppSecret/目标 ID；绑定模式需先完成绑定）".to_string())?;
                qq.send(content).await
            }
            "wechat" => {
                if self.cfg.wechat_webhook.is_empty() {
                    return Err("企业微信 WebHook 未配置".into());
                }
                send_webhook(&self.cfg.wechat_webhook.clone(), content).await
            }
            other => Err(format!("未知通道: {other}")),
        }
    }

    fn wechat_enabled(&self) -> bool {
        !self.cfg.wechat_webhook.is_empty()
    }

    /// 当前 QQ 通道快照（读锁短暂持有，热替换不影响进行中的发送）。
    fn current_qq(&self) -> Option<std::sync::Arc<QqSender>> {
        self.qq.read().ok().and_then(|g| g.clone())
    }

    fn qq_enabled(&self) -> bool {
        self.current_qq().is_some()
    }

    /// 自动绑定完成后热替换 QQ 通道（无需重启服务）。
    pub fn set_qq(&self, sender: Option<QqSender>) {
        if let Ok(mut g) = self.qq.write() {
            *g = sender.map(std::sync::Arc::new);
        }
        match self.current_qq() {
            Some(s) => log_info!("QQ 机器人推送已启用（目标类型: {}，热生效）", s.target_type),
            None => log_info!("QQ 机器人推送通道已停用"),
        }
    }
}

fn prepare_log_file(path: &str) -> Result<String, String> {
    let abs = std::path::absolute(path).map_err(|e| e.to_string())?;
    if let Some(dir) = abs.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建日志目录 {} 失败: {e}", dir.display()))?;
    }
    let f = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .write(true)
        .open(&abs)
        .map_err(|e| format!("日志文件不可写 {}: {e}", abs.display()))?;
    drop(f);
    Ok(abs.to_string_lossy().into_owned())
}

fn append_log(path: &str, msg: &Notification) -> std::io::Result<()> {
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let mut b = String::new();
    if msg.memory_full {
        b.push_str(&format!("[{ts}] 存储空间已满警告\n"));
    } else {
        b.push_str(&format!("[{ts}] 发送者: {}\n内容: {}\n", msg.sender, msg.content));
    }
    b.push_str(&"-".repeat(50));
    b.push('\n');

    let mut f = std::fs::OpenOptions::new().append(true).create(true).write(true).open(Path::new(path))?;
    use std::io::Write;
    f.write_all(b.as_bytes())
}

async fn send_webhook(hook: &str, content: &str) -> Result<(), String> {
    let payload = serde_json::json!({
        "msgtype": "text",
        "text": { "content": content }
    });

    for attempt in 1..=NOTIFY_MAX_RETRIES {
        let result = tokio::task::spawn_blocking({
            let hook = hook.to_string();
            let body = payload.to_string();
            move || post_webhook(&hook, &body)
        })
        .await;
        match result {
            Ok(Ok(())) => {
                log_info!("企业微信通知发送成功");
                return Ok(());
            }
            Ok(Err(e)) => {
                log_warn!("企业微信发送失败 ({}/{}): {}", attempt, NOTIFY_MAX_RETRIES, e);
            }
            Err(e) => {
                log_warn!("企业微信发送任务失败 ({}/{}): {}", attempt, NOTIFY_MAX_RETRIES, e);
            }
        }
        if attempt < NOTIFY_MAX_RETRIES {
            tokio::time::sleep(Duration::from_secs(attempt as u64)).await;
        }
    }
    log_error!("企业微信通知已达最大重试次数，放弃发送");
    Err(format!("重试 {NOTIFY_MAX_RETRIES} 次均失败（详见日志）"))
}

fn post_webhook(hook: &str, body: &str) -> Result<(), String> {
    let resp = ureq::post(hook)
        .timeout(Duration::from_secs(10))
        .set("Content-Type", "application/json")
        .send_string(body)
        .map_err(|e| e.to_string())?;

    if resp.status() != 200 {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body = resp.into_string().map_err(|e| e.to_string())?;
    let result: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let errcode = result.get("errcode").and_then(|v| v.as_i64()).unwrap_or(-1);
    if errcode != 0 {
        let errmsg = result.get("errmsg").and_then(|v| v.as_str()).unwrap_or("");
        return Err(format!("企业微信返回 errcode={errcode} errmsg={errmsg}"));
    }
    Ok(())
}

/// 单条与多条消息走不同排版格式。
pub fn combine_messages(msgs: &[Notification]) -> String {
    if msgs.is_empty() {
        return String::new();
    }
    if msgs.len() == 1 {
        let m = &msgs[0];
        return match (m.memory_full, m.sender.as_str(), m.kind) {
            (true, _, _) => "⚠️ 警告：短信存储空间已满\n请及时处理，否则可能无法接收新短信".into(),
            (_, SENDER_CALL, _) => format!("📞 来电提醒\n{}", m.content),
            (_, SENDER_SIGNAL, _) => m.content.clone(),
            _ => format!("📱 新短信通知\n发送者: {}\n内容: {}", m.sender, m.content),
        };
    }

    let mut b = String::from("📑 批量通知汇总\n");
    b.push_str(&"=".repeat(20));
    b.push('\n');
    for (i, m) in msgs.iter().enumerate() {
        match (m.memory_full, m.sender.as_str()) {
            (true, _) => b.push_str(&format!("\n{}. ⚠️ 存储空间已满警告", i + 1)),
            (_, SENDER_CALL) => b.push_str(&format!("\n{}. 📞 {}", i + 1, m.content)),
            (_, SENDER_SIGNAL) => b.push_str(&format!("\n{}. 📶 {}", i + 1, m.content)),
            _ => b.push_str(&format!("\n{}. 📱 来自 {} 的短信:\n{}", i + 1, m.sender, m.content)),
        }
        b.push('\n');
        b.push_str(&"-".repeat(20));
    }
    b
}

// ==================== QQ 机器人通道（官方 API v2） ====================
//
// 鉴权与发消息接口均来自官方文档（bot.q.qq.com/wiki/develop/api-v2）：
//   取凭证：POST /app/getAppAccessToken，body {appId, clientSecret}
//           → {access_token, expires_in}；expires_in 官方示例是字符串 "7200"。
//   携带：  请求头 `Authorization: QQBot <access_token>`。
//   发消息：群   POST /v2/groups/{group_openid}/messages
//           单聊 POST /v2/users/{openid}/messages
//           频道 POST /channels/{channel_id}/messages
//           文本用 msg_type=0 + content。
//
// 已知限制（本模块为单向推送、不连 WebSocket，拿不到 msg_id/event_id）：
//   - 所有消息都是「主动消息」，受频控（群 30~60 条/分钟、单关系 20 条/分钟、
//     1000 条/群/天）与用户端「允许主动发送」开关约束；
//   - 频道主动推送官方要求机器人保持 WebSocket 在线，channel 模式可能失败。

/// QQ 机器人推送通道。凭证缓存 + 单飞刷新；发送失败重试 NOTIFY_MAX_RETRIES 次。
pub struct QqSender {
    app_id: String,
    app_secret: String,
    /// "group" | "c2c" | "channel"
    target_type: String,
    target_id: String,
    token: tokio::sync::Mutex<Option<QqToken>>,
}

struct QqToken {
    value: String,
    valid_until: Instant,
}

impl QqSender {
    /// 由配置构造；AppID/Secret/目标 ID 任一为空，或目标类型是 "bind"
    /// （绑定模式由 qqbind 模块处理，完成后经 set_qq 热替换）时返回 None。
    pub fn from_config(cfg: &crate::config::QqNotifyConfig) -> Option<Self> {
        let app_id = cfg.app_id.trim().to_string();
        let app_secret = cfg.app_secret.trim().to_string();
        let target_id = cfg.target_id.trim().to_string();
        let target_type = normalize_qq_target_type(&cfg.target_type);
        if app_id.is_empty() || app_secret.is_empty() || target_id.is_empty() || target_type == "bind" {
            return None;
        }
        Some(QqSender {
            app_id,
            app_secret,
            target_type,
            target_id,
            token: tokio::sync::Mutex::new(None),
        })
    }

    /// 按目标类型路由到对应的消息发送接口。
    fn message_url(&self) -> String {
        match self.target_type.as_str() {
            "channel" => format!("{QQ_API_BASE}/channels/{}/messages", self.target_id),
            "c2c" => format!("{QQ_API_BASE}/v2/users/{}/messages", self.target_id),
            _ => format!("{QQ_API_BASE}/v2/groups/{}/messages", self.target_id),
        }
    }

    /// 取 access_token：缓存有效期内直接复用；过期则锁内单飞刷新，
    /// 避免并发请求各自取一次凭证。
    async fn token(&self) -> Result<String, String> {
        let mut cache = self.token.lock().await;
        if let Some(t) = cache.as_ref() {
            if Instant::now() < t.valid_until {
                return Ok(t.value.clone());
            }
        }
        let (value, expires_in) = fetch_qq_token(&self.app_id, &self.app_secret).await?;
        let valid_secs = expires_in.saturating_sub(QQ_TOKEN_REFRESH_MARGIN);
        *cache = Some(QqToken {
            value: value.clone(),
            valid_until: Instant::now() + Duration::from_secs(valid_secs),
        });
        Ok(value)
    }

    /// 发送一条文本消息（msg_type=0）。不带 msg_id，属主动消息。
    /// 重试 NOTIFY_MAX_RETRIES 次后仍失败则返回 Err（日志照记）。
    pub async fn send(&self, content: &str) -> Result<(), String> {
        let url = self.message_url();
        for attempt in 1..=NOTIFY_MAX_RETRIES {
            let result = match self.token().await {
                Ok(token) => {
                    let payload = serde_json::json!({
                        "msg_type": 0,
                        "content": content,
                        "msg_seq": 1
                    });
                    tokio::task::spawn_blocking({
                        let url = url.clone();
                        let body = payload.to_string();
                        move || post_qq(&url, &token, &body)
                    })
                    .await
                    .unwrap_or_else(|e| Err(format!("发送任务失败: {e}")))
                }
                Err(e) => Err(format!("获取凭证失败: {e}")),
            };
            match result {
                Ok(()) => {
                    log_info!("QQ 机器人通知发送成功");
                    return Ok(());
                }
                Err(e) => {
                    log_warn!("QQ 机器人发送失败 ({}/{NOTIFY_MAX_RETRIES}): {}", attempt, e);
                }
            }
            if attempt < NOTIFY_MAX_RETRIES {
                tokio::time::sleep(Duration::from_secs(attempt as u64)).await;
            }
        }
        log_error!("QQ 机器人通知已达最大重试次数，放弃发送");
        Err(format!("重试 {NOTIFY_MAX_RETRIES} 次均失败（详见日志）"))
    }
}

/// 目标类型归一化：识别常见别名与 bind 模式，其余未知值回落群聊。
pub fn normalize_qq_target_type(t: &str) -> String {
    match t.trim().to_ascii_lowercase().as_str() {
        "c2c" | "user" | "users" | "single" => "c2c".into(),
        "channel" | "channels" | "guild" => "channel".into(),
        "bind" | "auto" => "bind".into(),
        _ => "group".into(),
    }
}

/// 获取 app access_token。兼容 expires_in 的字符串/数字两种返回。
async fn fetch_qq_token(app_id: &str, app_secret: &str) -> Result<(String, u64), String> {
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

    parse_token_response(&raw)
}

/// 解析 getAppAccessToken 响应。实测错误场景（如密钥错误）返回
/// HTTP 200 + `{"code":100016,"message":"invalid appid or secret"}`，
/// 必须显式检查业务码，不能只看 HTTP 状态。
fn parse_token_response(raw: &str) -> Result<(String, u64), String> {
    let v: serde_json::Value = serde_json::from_str(raw).map_err(|e| format!("凭证响应解析失败: {e}"))?;
    if let Some(code) = v.get("code").and_then(|x| x.as_i64()) {
        if code != 0 {
            let msg = v.get("message").and_then(|x| x.as_str()).unwrap_or("");
            return Err(format!("鉴权接口返回 code={code} message={msg}"));
        }
    }
    let token = v.get("access_token").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if token.is_empty() {
        return Err(format!("凭证响应缺少 access_token: {raw}"));
    }
    Ok((token, parse_expires_in(v.get("expires_in"))))
}

/// 兼容 expires_in 的字符串（官方示例 "7200"）与数字两种类型，异常时回落 7200。
fn parse_expires_in(v: Option<&serde_json::Value>) -> u64 {
    match v {
        Some(serde_json::Value::String(s)) => s.trim().parse().unwrap_or(7200),
        Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(7200),
        _ => 7200,
    }
}

/// 调用 QQ openapi 发消息。2xx 视为成功；非 2xx 附响应片段便于排障
/// （QQ 错误码如 304xxx 会出现在响应体里）。
fn post_qq(url: &str, token: &str, body: &str) -> Result<(), String> {
    match ureq::post(url)
        .timeout(Duration::from_secs(10))
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("QQBot {token}"))
        .send_string(body)
    {
        Ok(resp) if (200..300).contains(&resp.status()) => Ok(()),
        Ok(resp) => Err(format!("HTTP {}", resp.status())),
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            let snippet: String = text.chars().take(300).collect();
            Err(format!("HTTP {code}: {snippet}"))
        }
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::QqNotifyConfig;

    fn qq_cfg(target_type: &str) -> QqNotifyConfig {
        QqNotifyConfig {
            app_id: "111999".into(),
            app_secret: "secret".into(),
            target_type: target_type.into(),
            target_id: "ABC123".into(),
            bind_qq: String::new(),
        }
    }

    #[test]
    fn qq_message_url_routes_by_target_type() {
        let base = "https://api.bot.qq.com";
        assert_eq!(sender_of("group").message_url(), format!("{base}/v2/groups/ABC123/messages"));
        assert_eq!(sender_of("c2c").message_url(), format!("{base}/v2/users/ABC123/messages"));
        assert_eq!(sender_of("channel").message_url(), format!("{base}/channels/ABC123/messages"));
    }

    #[test]
    fn qq_message_url_unknown_type_falls_back_to_group() {
        assert_eq!(
            sender_of(" nonsense ").message_url(),
            sender_of("group").message_url()
        );
    }

    #[test]
    fn qq_sender_requires_credentials_and_target() {
        let missing_id = QqNotifyConfig { app_id: String::new(), ..qq_cfg("group") };
        let missing_secret = QqNotifyConfig { app_secret: String::new(), ..qq_cfg("group") };
        let missing_target = QqNotifyConfig { target_id: "  ".into(), ..qq_cfg("group") };
        assert!(QqSender::from_config(&missing_id).is_none());
        assert!(QqSender::from_config(&missing_secret).is_none());
        assert!(QqSender::from_config(&missing_target).is_none());
        assert!(QqSender::from_config(&qq_cfg("group")).is_some());
    }

    #[test]
    fn qq_target_type_normalization() {
        assert_eq!(normalize_qq_target_type("Group"), "group");
        assert_eq!(normalize_qq_target_type(" users "), "c2c");
        assert_eq!(normalize_qq_target_type("GUILD"), "channel");
        assert_eq!(normalize_qq_target_type(""), "group");
    }

    #[test]
    fn parse_expires_in_accepts_string_and_number() {
        assert_eq!(parse_expires_in(Some(&serde_json::json!("7200"))), 7200);
        assert_eq!(parse_expires_in(Some(&serde_json::json!(3600))), 3600);
        assert_eq!(parse_expires_in(Some(&serde_json::json!("not-a-num"))), 7200);
        assert_eq!(parse_expires_in(None), 7200);
    }

    #[test]
    fn parse_token_response_accepts_success_body() {
        // 实测成功响应：expires_in 为字符串，无 code 字段
        let (token, exp) = parse_token_response(r#"{"access_token":"abc","expires_in":"7200"}"#).expect("应成功");
        assert_eq!(token, "abc");
        assert_eq!(exp, 7200);
    }

    #[test]
    fn parse_token_response_surfaces_business_error() {
        // 实测错误场景：HTTP 200 + 业务码（错误的 AppSecret）
        let err = parse_token_response(r#"{"code":100016,"message":"invalid appid or secret"}"#)
            .expect_err("业务错误应转为 Err");
        assert!(err.contains("100016"), "错误信息应包含业务码: {err}");
        assert!(err.contains("invalid appid or secret"), "错误信息应包含 message: {err}");
    }

    /// 真实接口冒烟测试（默认跳过）：
    ///   QQ_BOT_APP_ID=xxx QQ_BOT_APP_SECRET=xxx cargo test -- --ignored qq_real_api
    /// 凭据只经环境变量传入，严禁写死在代码里。
    #[test]
    #[ignore]
    fn qq_real_api_token_smoke() {
        let app_id = std::env::var("QQ_BOT_APP_ID").expect("需要环境变量 QQ_BOT_APP_ID");
        let secret = std::env::var("QQ_BOT_APP_SECRET").expect("需要环境变量 QQ_BOT_APP_SECRET");
        let (token, expires) = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(fetch_qq_token(&app_id, &secret))
            .expect("鉴权应成功");
        assert!(!token.is_empty());
        // 实测 expires_in 不是恒定 7200：QQ 返回「到服务端固定过期点的剩余秒数」
        // （首次实测 7039），即共享过期窗口倒计时。缓存按 expires_in - 120 兜底，天然兼容。
        assert!((1..=7200).contains(&expires), "expires_in 应在 (0, 7200] 内: {expires}");
    }

    /// 真实发送链路冒烟（默认跳过，走生产代码 QqSender::send 全路径）：
    ///   QQ_BOT_APP_ID=xxx QQ_BOT_APP_SECRET=xxx QQ_BOT_TARGET=c2c:OPENID \
    ///     cargo test -- --ignored qq_real_send
    /// 目标格式 c2c:openid / group:group_openid / channel:channel_id。
    #[test]
    #[ignore]
    fn qq_real_send_smoke() {
        let app_id = std::env::var("QQ_BOT_APP_ID").expect("需要环境变量 QQ_BOT_APP_ID");
        let secret = std::env::var("QQ_BOT_APP_SECRET").expect("需要环境变量 QQ_BOT_APP_SECRET");
        let target = std::env::var("QQ_BOT_TARGET").expect("需要环境变量 QQ_BOT_TARGET（type:id）");
        let (t, id) = target.split_once(':').expect("目标格式应为 type:id");
        let sender = QqSender::from_config(&QqNotifyConfig {
            app_id,
            app_secret: secret,
            target_type: t.into(),
            target_id: id.into(),
            bind_qq: String::new(),
        })
        .expect("配置应完整");
        tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(sender.send("[luci-app-mt5700] QQ 机器人通知通道冒烟测试（QqSender 生产链路）"));
    }

    #[test]
    fn qq_token_validity_uses_refresh_margin() {
        // 正常 7200 秒 → 提前 120 秒视为过期；expires_in 小于余量时立即待刷新
        assert_eq!(7200u64.saturating_sub(QQ_TOKEN_REFRESH_MARGIN), 7080);
        assert_eq!(30u64.saturating_sub(QQ_TOKEN_REFRESH_MARGIN), 0);
    }

    fn sender_of(target_type: &str) -> QqSender {
        QqSender::from_config(&qq_cfg(target_type)).expect("应构造成功")
    }
}
