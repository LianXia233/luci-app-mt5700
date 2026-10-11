//! 通知：短信/来电/信号/内存满四类事件，经企业微信 webhook、QQ 机器人（官方 API v2）
//! 与本地日志文件输出（可配置合并窗口、重试 3 次）。
//!
//! 数据流（本模块是推送链路的中枢）：
//!   urc.rs / schedule.rs 产生事件
//!     → `Notifier::notify()`    过滤事件类型 → 立即写本地日志文件 → 入合并队列
//!     → `Notifier::run()`       常驻任务，按合并窗口（UCI `notify_interval`）批量出队
//!     → `Notifier::flush_all()` 按自定义文案模板渲染，广播到所有已启用通道
//!     → 企业微信 webhook / QQ 机器人（`QqSender`）
//!
//! 关于「QQ 绑定模式」：绑定前 QQ 通道为空（`QqSender::from_config` 返回 None），
//! 但事件**必须照常入队并保留**，否则用户按推荐流程绑定成功后拿不到任何数据。
//! 因此本模块的队列恒定运行，通道状态只在发送那一刻判定（见 `flush_all`）。

use crate::{log_debug, log_error, log_info, log_warn};
use crate::config::{NotificationConfig, NotifyTemplates};
use std::path::Path;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

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

/// 两个特殊发送方名字，用于区分事件来源。
pub const SENDER_CALL: &str = "来电提醒";
pub const SENDER_SIGNAL: &str = "信号监控";

#[derive(Debug, Clone)]
pub struct Notification {
    pub sender: String,
    pub content: String,
    pub kind: NotifyKind,
    pub memory_full: bool,
    /// 事件发生时刻（本地时间 `%Y-%m-%d %H:%M:%S`），供文案模板的 `{time}` 占位符使用。
    /// 空串时渲染阶段回落到推送时刻。
    pub time: String,
}

/// 事件类型的中文标签，供文案模板的 `{kind}` 占位符使用。
pub fn kind_label(kind: NotifyKind) -> &'static str {
    match kind {
        NotifyKind::Sms => "新短信",
        NotifyKind::Call => "来电",
        NotifyKind::MemoryFull => "存储空间已满",
        NotifyKind::Signal => "信号变化",
    }
}

pub struct Notifier {
    cfg: NotificationConfig,
    /// QQ 机器人通道；未启用（AppID/Secret/目标缺失）或处于绑定模式时为 None。
    /// RwLock 支持「自动绑定」完成后热替换，无需重启服务。
    qq: std::sync::RwLock<Option<std::sync::Arc<QqSender>>>,
    tx: mpsc::Sender<Notification>,
    log_file: Option<String>,
    /// 本进程启动时处于 QQ「绑定模式」：绑定完成前通道为空，但事件必须照常入队，
    /// 否则绑定成功后拿不到任何后续推送（通道变了，队列入口却已关闭）。
    qq_bind_pending: bool,
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

        let qq_bind_pending = cfg.qq.target_type == "bind";
        log_info!(
            "通知合并窗口: {} 秒（事件在该窗口内合并为一条推送）",
            cfg.interval.as_secs()
        );

        (
            Notifier {
                cfg,
                qq: std::sync::RwLock::new(qq),
                tx,
                log_file,
                qq_bind_pending,
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

    /// 合并窗口：下限防忙循环与频控，上限 1 小时保时效。
    fn interval(&self) -> Duration {
        let min = Duration::from_secs(crate::config::MIN_NOTIFY_INTERVAL_SECS);
        let max = Duration::from_secs(crate::config::MAX_NOTIFY_INTERVAL_SECS);
        let d = self.cfg.interval;
        if d < min {
            min
        } else if d > max {
            max
        } else {
            d
        }
    }

    /// 是否存在「可能送达」的推送通道。
    ///
    /// 注意这里把「绑定模式待绑定」也算作可用：此时通道虽然为空，
    /// 但事件必须继续入队（绑定成功后由 `flush_all` 补发），
    /// 否则就是「机器人推送未接入任何推送数据」那个缺陷。
    fn dispatch_enabled(&self) -> bool {
        self.wechat_enabled() || self.qq_enabled() || self.qq_bind_pending
    }

    /// 记录一条事件。日志立即落盘，推送进入合并队列。
    pub async fn notify(&self, msg: Notification) {
        if !self.enabled(msg.kind) {
            return;
        }

        if let Some(path) = &self.log_file {
            if let Err(e) = append_log(path, &msg) {
                log_error!("写入通知日志失败: {}", e);
            }
        }

        if !self.dispatch_enabled() {
            return;
        }
        let sender = msg.sender.clone();
        let kind = msg.kind;
        if let Err(e) = self.tx.try_send(msg) {
            // 区分「队列满」与「接收端已退出」：后者的原文案会严重误导排障方向。
            match e {
                mpsc::error::TrySendError::Full(_) => {
                    log_warn!("通知队列已满，丢弃一条: {}（{:?}）", sender, kind)
                }
                mpsc::error::TrySendError::Closed(_) => {
                    log_error!("通知合并任务未在运行，事件已丢弃: {}（{:?}）", sender, kind)
                }
            }
        }
    }

    /// 驱动推送通道（企业微信 + QQ 机器人）的合并发送，直到 ctx 结束。
    ///
    /// 合并窗口由 UCI `notify_interval` 决定：窗口内到达的事件合并成一条发送；
    /// 空队列不触发发送。
    ///
    /// 本任务**恒定运行**，不因「启动时还没有可用通道」而退出：QQ 绑定模式下
    /// 通道要等用户给机器人发消息后才热替换进来，若这里提前 return，`rx` 会随
    /// 任务结束被丢弃，此后 `notify()` 的 `try_send` 全部失败——表现为
    /// 「绑定成功却收不到任何推送数据」。通道状态交给 `flush_all` 在发送时判定。
    pub async fn run(&self, mut rx: mpsc::Receiver<Notification>, mut ctx: tokio::sync::watch::Receiver<bool>) {
        let interval = self.interval();
        let mut pending: Vec<Notification> = Vec::new();
        let mut last_send = Instant::now() - interval;

        loop {
            let wait = interval.saturating_sub(last_send.elapsed());
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
    ///
    /// 一个通道都没有时**保留队列**而不是清空：QQ 绑定模式下绑定完成前没有通道，
    /// 保留下来才能在绑定成功的那一刻把窗口内的积压事件发出去，做到不丢事件。
    fn flush_all(&self, pending: &mut Vec<Notification>) {
        if pending.is_empty() {
            return;
        }
        let wechat = self.wechat_enabled();
        let qq = self.current_qq();
        if !wechat && qq.is_none() {
            log_debug!("通知通道尚未就绪（QQ 绑定模式等待绑定），保留 {} 条待发事件", pending.len());
            return;
        }

        let count = pending.len();
        let body = combine_messages(pending, &self.cfg.templates);
        pending.clear();
        // 记录实际推送文本：这是「文案模板到底渲染成了什么」的唯一权威观测点，
        // 排障时不至于只能看「发送成功」却不知道发了什么。
        log_debug!("推送内容（合并 {} 条）: {}", count, body);

        if wechat {
            let hook = self.cfg.wechat_webhook.clone();
            let body = body.clone();
            tokio::spawn(async move { let _ = send_webhook(&hook, &body).await; });
        }
        if let Some(qq) = qq {
            tokio::spawn(async move { let _ = qq.send(&body).await; });
        }
    }

    /// 测试指定推送通道（LuCI「发送测试通知」按钮）。绕过合并窗口直接发送。
    /// 测试消息不携带任何插件名字样，同样套用全局前缀，便于一次性验证前缀配置是否生效。
    pub async fn notify_test(&self, channel: &str) -> Result<(), String> {
        let base = "测试通知：推送通道链路正常";
        let now = now_string();
        let prefix = render_prefix(&self.cfg.templates.prefix, 1, &now);
        let content = if prefix.trim().is_empty() {
            base.to_string()
        } else {
            format!("{prefix}\n{base}")
        };
        // 与合并推送一致地记录「实际发出的文本」：测试通道是排障入口，
        // 只有看到真实出站内容才能判断前缀/文案是否按预期生效。
        log_debug!("推送内容（测试通道 {}）: {}", channel, content);
        match channel {
            "qq" => {
                let qq = self
                    .current_qq()
                    .ok_or_else(|| "QQ 通道未启用（检查 AppID/AppSecret/目标 ID；绑定模式需先完成绑定）".to_string())?;
                qq.send(&content).await
            }
            "wechat" => {
                if self.cfg.wechat_webhook.is_empty() {
                    return Err("企业微信 WebHook 未配置".into());
                }
                send_webhook(&self.cfg.wechat_webhook.clone(), &content).await
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
    let ts = if msg.time.is_empty() { now_string() } else { msg.time.clone() };
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

/// 本机当前时刻字符串（`%Y-%m-%d %H:%M:%S`）。事件产生侧用它填充
/// [`Notification::time`]，保证推送文案里的 `{time}` 是事件时刻而非推送时刻。
pub fn now_string() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 按事件类型选出对应的文案模板。
pub fn template_for<'a>(tpl: &'a NotifyTemplates, kind: NotifyKind) -> &'a str {
    match kind {
        NotifyKind::Sms => &tpl.sms,
        NotifyKind::Call => &tpl.call,
        NotifyKind::MemoryFull => &tpl.memory_full,
        NotifyKind::Signal => &tpl.signal,
    }
}

/// 渲染单条事件的文案模板。
///
/// 占位符：`{sender}` `{content}` `{time}` `{kind}` `{count}`；
/// 未识别的占位符原样保留（不清空，避免用户写错的变量把整段文案吃掉）。
pub fn render_template(tpl: &str, msg: &Notification, count: usize, fallback_now: &str) -> String {
    // 存储满事件的 content 天生为空，这里补一个可读的默认正文，
    // 使用户在模板里写 {content} 时不会得到一段空白。
    let content = if msg.content.is_empty() && msg.kind == NotifyKind::MemoryFull {
        "短信存储空间已满"
    } else {
        msg.content.as_str()
    };
    let time = if msg.time.is_empty() { fallback_now } else { msg.time.as_str() };
    tpl.replace("{sender}", &msg.sender)
        .replace("{content}", content)
        .replace("{time}", time)
        .replace("{kind}", kind_label(msg.kind))
        .replace("{count}", &count.to_string())
}

/// 渲染全局前缀（仅支持 `{count}` 与 `{time}`：前缀不属于某一条事件，
/// `{sender}` / `{content}` 在这里没有明确取值，保持原样由用户自行判断）。
pub fn render_prefix(prefix: &str, count: usize, now: &str) -> String {
    prefix.replace("{count}", &count.to_string()).replace("{time}", now)
}

/// 合并窗口内的事件渲染为最终推送文本。
///
/// 单条：直接套用该事件类型的模板。
/// 多条：`{batch}` 标题 + 分隔线 + 逐条「序号 + 该事件类型的模板渲染结果」。
/// 两种形态都会在最前面加全局前缀（若配置了）。
pub fn combine_messages(msgs: &[Notification], tpl: &NotifyTemplates) -> String {
    if msgs.is_empty() {
        return String::new();
    }
    let now = now_string();

    let mut body = if msgs.len() == 1 {
        let m = &msgs[0];
        render_template(template_for(tpl, m.kind), m, 1, &now)
    } else {
        let mut b = String::new();
        b.push_str(&tpl.batch);
        b.push('\n');
        b.push_str(&"=".repeat(20));
        b.push('\n');
        for (i, m) in msgs.iter().enumerate() {
            b.push('\n');
            b.push_str(&format!("{}. ", i + 1));
            b.push_str(&render_template(template_for(tpl, m.kind), m, msgs.len(), &now));
            b.push('\n');
            b.push_str(&"-".repeat(20));
        }
        b
    };

    if !tpl.prefix.trim().is_empty() {
        body = format!("{}\n{}", render_prefix(&tpl.prefix, msgs.len(), &now), body);
    }
    body
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

    fn sms(sender: &str, content: &str) -> Notification {
        Notification {
            sender: sender.into(),
            content: content.into(),
            kind: NotifyKind::Sms,
            memory_full: false,
            time: "2026-10-11 12:00:00".into(),
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

    // ---------- 文案模板渲染 ----------

    #[test]
    fn default_single_sms_keeps_legacy_layout() {
        let tpl = NotifyTemplates::default();
        let out = combine_messages(&[sms("10086", "验证码 1234")], &tpl);
        assert_eq!(out, "📱 新短信通知\n发送者: 10086\n内容: 验证码 1234");
    }

    #[test]
    fn custom_template_renders_all_placeholders() {
        let mut tpl = NotifyTemplates::default();
        tpl.prefix = "[监控]".into();
        tpl.sms = "来自 {sender} 的{kind}（{time}）：{content}".into();
        let out = combine_messages(&[sms("10086", "hi")], &tpl);
        assert_eq!(out, "[监控]\n来自 10086 的新短信（2026-10-11 12:00:00）：hi");
    }

    #[test]
    fn unknown_placeholder_is_preserved() {
        let mut tpl = NotifyTemplates::default();
        tpl.sms = "{sender}/{unknown}".into();
        assert_eq!(combine_messages(&[sms("A", "B")], &tpl), "A/{unknown}");
    }

    #[test]
    fn memory_full_content_falls_back_to_readable_text() {
        let mut tpl = NotifyTemplates::default();
        tpl.memory_full = "{content}".into();
        let m = Notification {
            sender: String::new(),
            content: String::new(),
            kind: NotifyKind::MemoryFull,
            memory_full: true,
            time: String::new(),
        };
        assert_eq!(combine_messages(&[m], &tpl), "短信存储空间已满");
    }

    #[test]
    fn batch_uses_header_index_and_template() {
        let mut tpl = NotifyTemplates::default();
        tpl.batch = "汇总".into();
        tpl.sms = "S:{content}".into();
        let out = combine_messages(&[sms("A", "1"), sms("B", "2")], &tpl);
        assert!(out.starts_with("汇总\n====================\n"));
        assert!(out.contains("1. S:1"));
        assert!(out.contains("2. S:2"));
    }

    #[test]
    fn prefix_supports_count_and_time() {
        let mut tpl = NotifyTemplates::default();
        tpl.prefix = "共 {count} 条".into();
        let out = combine_messages(&[sms("A", "1"), sms("B", "2")], &tpl);
        assert!(out.starts_with("共 2 条\n"), "实际: {out}");
    }

    #[test]
    fn empty_input_yields_empty_output() {
        let tpl = NotifyTemplates::default();
        assert_eq!(combine_messages(&[], &tpl), "");
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
            .block_on(sender.send("QQ 机器人通知通道冒烟测试（QqSender 生产链路）"));
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
