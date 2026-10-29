//! QQ 机器人推送通道（官方 OpenAPI v2）—— 独立模块。
//!
//! 自 v1.28.0 起，所有 QQ 机器人相关能力（鉴权、发消息、富媒体组装、内嵌
//! 键盘、自定义菜单）都收敛在本模块；[`crate::notify`] 只面向「事件 → 文案
//! 模板 → 多通道投递」，不再掺入 QQ 的平台细节。两侧的边界：
//!
//! - notify：产生**纯文本正文**（标题 + `键：值` 行）与全局前缀，不关心对端格式；
//! - qqpush：把正文组装成 QQ 支持的消息形态并投递，负责格式选择与降级。
//!
//! 支持的消息形态（发送侧，依据官方「消息类型总览」）：
//! - `msg_type=0` 纯文本（`content`）—— 兜底形态，任何机器人可用；
//! - `msg_type=2` Markdown（`markdown.content`）—— 结构化/富媒体展示，
//!   单聊与群聊自定义 Markdown 自 2026-04 起对所有机器人开放，无需模板申请；
//! - 内嵌键盘（`keyboard.content.rows`）—— 可附在 Markdown 消息上携带按钮；
//! - `msg_type=7` 富媒体（`media.file_info`）—— 需先上传素材，本模块未使用
//!   （推送内容是文本型状态报告，没有需要投递的图片/文件）。
//!
//! 单聊场景**不能发送** ark 结构化卡片（官方各场景支持情况表中「结构化卡片
//! 发 ❌」），因此富媒体化走 Markdown 路线，不碰 ark。
//!
//! 已知限制：本模块只做**主动消息**推送，不连 WebSocket 网关，拿不到
//! msg_id/event_id，也收不到用户消息与按钮回调。自定义菜单里
//! `send_message` 类按钮点击后仅把指令填入用户输入框，机器人应答指令需要
//! 长连接指令处理（规划中，见 README「已知限制」）。
//!
//! 文档依据：
//! - 主动消息（单聊）：<https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html>
//! - 消息类型总览：<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/overview.html>
//! - 自定义菜单：<https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_menu.put.html>

use crate::{log_debug, log_error, log_info, log_warn};
use crate::config::QqNotifyConfig;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// QQ 机器人开放接口（API v2）基础地址。
pub(crate) const QQ_API_BASE: &str = "https://api.bot.qq.com";
/// access_token 官方有效期 7200 秒，提前 120 秒判定过期，避开交界期边界。
const QQ_TOKEN_REFRESH_MARGIN: u64 = 120;
/// 单条消息的发送重试次数（与 notify 侧 webhook 重试策略一致）。
const QQ_SEND_MAX_RETRIES: u32 = 3;
/// Markdown 连续失败后的静默冷却：期间 Auto 模式直接发纯文本，
/// 避免每条消息都先撞一次墙（无权限 / 内容被拒时尤其明显）。
const MD_COOLDOWN: Duration = Duration::from_secs(600);
/// 节流等待上限：预约的槽位排到 2 分钟之后就直接发，不再无限挂下去。
/// 排队排到这种长度，说明刷屏的源头在事件侧（该用 `notify_signal_min_interval`
/// 限），而不是靠发送端继续攒队 —— 攒队只会让推送晚点几分钟到、内容还是那几条。
const PACE_MAX_WAIT: Duration = Duration::from_secs(120);

/// 消息格式（UCI `qq_msg_format`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QqMsgFormat {
    /// 只发纯文本。
    Text,
    /// 只发 Markdown（失败不回落，让错误暴露出来）。
    Markdown,
    /// 优先 Markdown，失败自动回落纯文本（默认）。
    Auto,
}

impl QqMsgFormat {
    /// 从 UCI 字符串解析，无法识别时回落 Auto。
    pub fn from_uci(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "text" | "plain" | "0" => Self::Text,
            "markdown" | "md" | "rich" | "1" => Self::Markdown,
            _ => Self::Auto,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Markdown => "markdown",
            Self::Auto => "auto",
        }
    }
}

/// 一条待发送的 QQ 消息（由 [`QqSender::build_message`] 按格式配置产生）。
#[derive(Debug, Clone)]
pub enum QqMessage {
    /// 纯文本（msg_type=0）。
    Text(String),
    /// Markdown 富文本（msg_type=2），可附内嵌键盘。
    Markdown { content: String },
}

/// 内嵌键盘配置：一条「打开管理页」跳转按钮。
#[derive(Debug, Clone)]
pub struct QqKeyboard {
    /// 跳转地址（http/https），来自 UCI `qq_keyboard_url` 或 LAN IP 推导。
    pub admin_url: String,
}

/// QQ 机器人推送通道。凭证缓存 + 单飞刷新；Markdown 失败自动降级。
pub struct QqSender {
    app_id: String,
    app_secret: String,
    /// "group" | "c2c" | "channel"
    target_type: String,
    target_id: String,
    format: QqMsgFormat,
    keyboard: Option<QqKeyboard>,
    /// 是否启用自定义菜单（启动时自动配置一次，或用 qq_menu RPC 手动配置）。
    menu_enabled: bool,
    /// 通道节流（条/分钟，0=不节流），来自 UCI `qq_max_per_minute`。
    max_per_minute: u64,
    token: Mutex<Option<QqToken>>,
    /// Markdown 冷却截止时刻；Some(Instant) 且未到期时 Auto 直接发纯文本。
    md_cooldown: std::sync::Mutex<Option<Instant>>,
    /// 最近一次**已预约**的发送时刻（节流槽位指针，见 [`QqSender::reserve_slot`]）。
    last_send: std::sync::Mutex<Option<Instant>>,
}

struct QqToken {
    value: String,
    valid_until: Instant,
}

impl QqSender {
    /// 由配置构造；开关关闭、AppID/Secret/目标 ID 任一为空，或目标类型是
    /// "bind"（绑定模式由 qqbind 模块处理，完成后经 set_qq 热替换）时返回 None。
    ///
    /// `enabled` 是独立于企业微信的 QQ 推送总开关（**默认关闭**）：关掉后
    /// QQ 通道整体停用，企业微信不受影响，反之亦然。
    pub fn from_config(cfg: &QqNotifyConfig) -> Option<Self> {
        if !cfg.enabled {
            return None;
        }
        let app_id = cfg.app_id.trim().to_string();
        let app_secret = cfg.app_secret.trim().to_string();
        let target_id = cfg.target_id.trim().to_string();
        let target_type = normalize_qq_target_type(&cfg.target_type);
        if app_id.is_empty() || app_secret.is_empty() || target_id.is_empty() || target_type == "bind" {
            return None;
        }
        // 键盘地址：显式配置优先；否则从 LAN IP 推导（uci get network.lan.ipaddr）。
        // 推导失败（无 uci / 无 IP）时键盘不挂——按钮没有目标地址比没有按钮更糟。
        let admin_url = if cfg.keyboard_url.trim().is_empty() {
            derive_admin_url().unwrap_or_default()
        } else {
            cfg.keyboard_url.trim().to_string()
        };
        let keyboard = if cfg.keyboard_enabled && !admin_url.is_empty() {
            Some(QqKeyboard { admin_url })
        } else {
            None
        };
        Some(QqSender {
            app_id,
            app_secret,
            target_type,
            target_id,
            format: QqMsgFormat::from_uci(&cfg.msg_format),
            keyboard,
            menu_enabled: cfg.menu_enabled,
            max_per_minute: cfg.max_per_minute,
            token: Mutex::new(None),
            md_cooldown: std::sync::Mutex::new(None),
            last_send: std::sync::Mutex::new(None),
        })
    }

    /// 目标类型（供日志与状态展示）。
    pub fn target_type(&self) -> &str {
        &self.target_type
    }

    // ---------- 通道节流（qq_max_per_minute）----------

    /// 两次投递之间的最小间隔；`Duration::ZERO` 表示不节流（`max_per_minute = 0`）。
    ///
    /// 用「间隔」而不是「每分钟计数」：固定窗口计数在窗口交界处会放过双倍的量
    /// （上一窗最后 1 秒 + 本窗最初 1 秒），而间隔预约是严格均匀的节奏，
    /// 不需要额外处理窗口边界。
    pub fn throttle_gap(&self) -> Duration {
        if self.max_per_minute == 0 {
            return Duration::ZERO;
        }
        // 条数已在配置层夹到 1..=60，这里不会再除 0；60 条/分钟 = 1 秒一条是最密的一档。
        // 用毫秒而不是整秒：7 条/分钟按秒算是 8 秒（截断后实际能塞进 7.5 条），
        // 按毫秒算是 8571 毫秒，与页面提示的「约每 8.6 秒」一致。
        Duration::from_millis(60_000 / self.max_per_minute.max(1))
    }

    /// 为下一条消息预约一个发送时刻（**同步**预约，异步等待，见 [`QqSender::pace`]）。
    ///
    /// 预约制而不是「到了再看一眼上次时间」：多条消息由 `notify` 各自 `tokio::spawn`
    /// 出去，若都只在发送前比较 `last + gap`，它们会挤在同一时刻一起撞向平台频控。
    /// 每次预约都以上一个槽位为基准顺延，天然把并发请求排成队列。
    /// 长时间空闲后（上个槽已落在过去）以当前时刻为基准，不会攒出一串「补发」。
    fn reserve_slot(&self, now: Instant) -> Instant {
        let gap = self.throttle_gap();
        let mut guard = match self.last_send.lock() {
            Ok(g) => g,
            // 锁中毒（仅在有任务 panic 时发生）时不阻塞发送：宁可不节流，
            // 也不能让「记录上次发送时刻」变成推送链路上的新故障点。
            Err(_) => return now,
        };
        if gap.is_zero() {
            *guard = Some(now);
            return now;
        }
        let slot = match *guard {
            Some(prev) => (prev + gap).max(now),
            None => now,
        };
        *guard = Some(slot);
        slot
    }

    /// 等到自己预约的槽位再放行。等待上限 [`PACE_MAX_WAIT`]：
    /// 队列被拉长到几分钟以上，说明事件本身就在刷屏，那时候该限的是源头
    /// （见 `notify_signal_min_interval`），而不是把发送任务无限挂下去。
    async fn pace(&self) {
        let gap = self.throttle_gap();
        if gap.is_zero() {
            return;
        }
        let slot = self.reserve_slot(Instant::now());
        let wait = slot.saturating_duration_since(Instant::now()).min(PACE_MAX_WAIT);
        if !wait.is_zero() {
            log_debug!("QQ 通道节流：等 {:.1}s 后发送（上限 {} 条/分钟）", wait.as_secs_f64(), self.max_per_minute);
            tokio::time::sleep(wait).await;
        }
    }

    /// 当前消息格式（供状态展示）。
    pub fn format(&self) -> QqMsgFormat {
        self.format
    }

    /// 把一段纯文本正文组装成 QQ 消息。
    ///
    /// - `body`：不含前缀的正文（首行通常是标题，其余是 `键：值` 行或普通行）；
    /// - `prefix`：渲染后的全局前缀（空串表示不添加）。
    pub fn build_message(&self, body: &str, prefix: &str) -> QqMessage {
        match self.format {
            QqMsgFormat::Text => QqMessage::Text(combine_plain(body, prefix)),
            QqMsgFormat::Markdown => QqMessage::Markdown {
                content: build_markdown(body, prefix),
            },
            QqMsgFormat::Auto => {
                if self.md_cooling() {
                    QqMessage::Text(combine_plain(body, prefix))
                } else {
                    QqMessage::Markdown {
                        content: build_markdown(body, prefix),
                    }
                }
            }
        }
    }

    /// 发送一条消息（按形态路由，Markdown 失败时按配置降级）。
    ///
    /// 进门先过通道节流（[`QqSender::pace`]）：所有 QQ 投递都从这里出去，
    /// 节流只需要在这一个点生效。降级（Markdown → 纯文本）发生在同一次调用内部，
    /// 不会被当成「第二条消息」再排一次队。
    pub async fn send(&self, msg: QqMessage) -> Result<(), String> {
        self.pace().await;
        match msg {
            QqMessage::Text(t) => self.send_text(&t).await,
            QqMessage::Markdown { content } => self.send_markdown(&content).await,
        }
    }

    /// 纯文本发送（msg_type=0）。
    pub async fn send_text(&self, content: &str) -> Result<(), String> {
        self.post_payload(text_payload(content)).await
    }

    /// Markdown 发送（msg_type=2，可附内嵌键盘）。
    ///
    /// 降级阶梯（任一环失败才走下一环）：
    /// 1. Markdown + 键盘（若启用了键盘）；
    /// 2. Markdown 去掉键盘（键盘形状不被平台接受时，富文本本身仍要送达）；
    /// 3. 仅 Auto 格式：回落纯文本（记录冷却，随后一段时间直接发纯文本）。
    async fn send_markdown(&self, content: &str) -> Result<(), String> {
        if self.md_cooling() {
            return self.send_text(&md_to_plain(content)).await;
        }
        let kb = self.keyboard_json();
        let result = match kb {
            Some(_) => self.post_payload(markdown_payload(content, kb.as_ref())).await,
            None => self.post_payload(markdown_payload(content, None)).await,
        };
        let result = match result {
            Ok(()) => Ok(()),
            Err(e) if kb.is_some() => {
                log_warn!("QQ 富文本（含键盘）发送失败，去掉键盘重试: {}", e);
                self.post_payload(markdown_payload(content, None)).await
            }
            Err(e) => Err(e),
        };
        match result {
            Ok(()) => Ok(()),
            Err(e) => {
                self.note_md_failure();
                if self.format == QqMsgFormat::Auto {
                    log_warn!("QQ 富文本不可用，本条回落纯文本: {}", e);
                    self.send_text(&md_to_plain(content)).await
                } else {
                    Err(e)
                }
            }
        }
    }

    /// 组装内嵌键盘 JSON（未启用或地址为空时返回 None）。
    fn keyboard_json(&self) -> Option<serde_json::Value> {
        let url = self.keyboard.as_ref()?.admin_url.trim();
        if url.is_empty() {
            return None;
        }
        Some(serde_json::json!({
            "content": {
                "rows": [{
                    "buttons": [{
                        "id": "mt5700_open_admin",
                        "render_data": {
                            "label": "打开管理页",
                            "visited_label": "已打开",
                            "style": 1
                        },
                        "action": {
                            "type": 0,
                            "data": url,
                            "permission": { "type": 2 }
                        }
                    }]
                }]
            }
        }))
    }

    // ---------- 自定义菜单（PUT /v2/menu，仅 C2C 场景生效） ----------

    /// 默认菜单：两个指令项，点击后把指令填入用户输入框。
    ///
    /// 不用 link 项：官方要求链接必须以 https:// 开头，而 LuCI 管理页在
    /// 局域网是 http；强行填 https 会被 40030008 拒绝。有 https 入口的
    /// 用户可经 `qq_menu` RPC 自行配置。
    pub fn default_menu_body() -> serde_json::Value {
        serde_json::json!({
            "menu": {
                "items": [
                    { "type": "send_message", "name": "查询状态", "send_message": "状态" },
                    { "type": "send_message", "name": "查询流量", "send_message": "流量" }
                ]
            }
        })
    }

    /// 覆盖配置自定义菜单，返回菜单版本号。
    pub async fn set_menu(&self, body: &serde_json::Value) -> Result<u64, String> {
        let token = self.token().await?;
        let raw = tokio::task::spawn_blocking({
            let url = format!("{QQ_API_BASE}/v2/menu");
            let body = body.to_string();
            move || {
                let resp = ureq::put(&url)
                    .timeout(Duration::from_secs(10))
                    .set("Content-Type", "application/json")
                    .set("Authorization", &format!("QQBot {token}"))
                    .send_string(&body)
                    .map_err(|e| e.to_string())?;
                if !(200..300).contains(&resp.status()) {
                    return Err(format!("HTTP {}", resp.status()));
                }
                resp.into_string().map_err(|e| e.to_string())
            }
        })
        .await
        .map_err(|e| format!("菜单请求任务失败: {e}"))??;
        let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        v.get("version")
            .and_then(|x| x.as_u64())
            .ok_or_else(|| format!("菜单响应缺少 version: {raw}"))
    }

    /// 查询当前自定义菜单。
    pub async fn get_menu(&self) -> Result<serde_json::Value, String> {
        let token = self.token().await?;
        let raw = tokio::task::spawn_blocking(move || {
            let resp = ureq::get(&format!("{QQ_API_BASE}/v2/menu"))
                .timeout(Duration::from_secs(10))
                .set("Authorization", &format!("QQBot {token}"))
                .call()
                .map_err(|e| e.to_string())?;
            if !(200..300).contains(&resp.status()) {
                return Err(format!("HTTP {}", resp.status()));
            }
            resp.into_string().map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("菜单查询任务失败: {e}"))??;
        serde_json::from_str(&raw).map_err(|e| format!("菜单响应解析失败: {e}"))
    }

    /// 启动时按配置自动配置一次默认菜单（失败仅记日志，不阻塞启动）。
    pub async fn apply_default_menu(&self) {
        if !self.menu_enabled {
            return;
        }
        match self.set_menu(&Self::default_menu_body()).await {
            Ok(v) => log_info!("QQ 自定义菜单已配置（version={v}）"),
            Err(e) => log_error!("QQ 自定义菜单配置失败（不影响推送）: {}", e),
        }
    }

    // ---------- 频控冷却 ----------

    fn md_cooling(&self) -> bool {
        self.md_cooldown
            .lock()
            .ok()
            .and_then(|g| *g)
            .is_some_and(|until| Instant::now() < until)
    }

    fn note_md_failure(&self) {
        if let Ok(mut g) = self.md_cooldown.lock() {
            *g = Some(Instant::now() + MD_COOLDOWN);
        }
    }

    // ---------- HTTP 细节 ----------

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

    /// 带重试的消息投递。失败由调用方决定是否降级。
    async fn post_payload(&self, payload: serde_json::Value) -> Result<(), String> {
        let url = self.message_url();
        let body = payload.to_string();
        for attempt in 1..=QQ_SEND_MAX_RETRIES {
            let result = match self.token().await {
                Ok(token) => {
                    tokio::task::spawn_blocking({
                        let url = url.clone();
                        let body = body.clone();
                        let token = token.clone();
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
                    log_warn!("QQ 机器人发送失败 ({}/{QQ_SEND_MAX_RETRIES}): {}", attempt, e);
                }
            }
            if attempt < QQ_SEND_MAX_RETRIES {
                tokio::time::sleep(Duration::from_secs(attempt as u64)).await;
            }
        }
        log_error!("QQ 机器人通知已达最大重试次数，放弃发送");
        Err(format!("重试 {QQ_SEND_MAX_RETRIES} 次均失败（详见日志）"))
    }
}

/// 纯文本形态：前缀在上、正文在下（与企业微信/webhook 一致）。
fn combine_plain(body: &str, prefix: &str) -> String {
    if prefix.trim().is_empty() {
        body.to_string()
    } else {
        format!("{prefix}\n{body}")
    }
}

/// 纯文本消息体（msg_type=0）。
fn text_payload(content: &str) -> serde_json::Value {
    serde_json::json!({
        "msg_type": 0,
        "content": content,
        "msg_seq": 1
    })
}

/// Markdown 消息体（msg_type=2），可附内嵌键盘。
fn markdown_payload(content: &str, keyboard: Option<&serde_json::Value>) -> serde_json::Value {
    let mut p = serde_json::json!({
        "msg_type": 2,
        "markdown": { "content": content },
        "msg_seq": 1
    });
    if let Some(kb) = keyboard {
        p["keyboard"] = kb.clone();
    }
    p
}

/// 把纯文本正文组装为 QQ Markdown。
///
/// 规则（对任意自定义模板都成立，不依赖特定模板）：
/// - 首行（非空）作为二级标题 `## …`；若首行本身就是 `键：值` 行
///   （模板没有标题行，如来电模板只写 `{content}`），则不硬造标题；
/// - 全局前缀渲染为引用行 `> …`（保留 `{time} {count}` 信息又不抢标题）；
/// - `键：值` 行渲染为无序列表 `- **键**：值`；
/// - **列表项续行**：`键：值` 行之后紧跟的非空普通行（中间没有空行）视为
///   该列表项的延续，缩进 4 空格保持列表结构 —— 多行短信正文
///   （`内容：第一行\n第二行`）若不做这层处理，第二行会跳出列表变成
///   独立段落，版式上与内容脱节；
/// - 空行保留（分段），并结束当前列表上下文（空行后的普通行是新段落，
///   不再缩进 —— 巡检报告的指标行正是这种结构）。
pub fn build_markdown(body: &str, prefix: &str) -> String {
    let mut lines: Vec<&str> = body.lines().collect();
    while lines.first().is_some_and(|l| l.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    if lines.is_empty() {
        return String::new();
    }

    let mut out = String::new();
    let first = lines[0].trim();
    let mut rest: &[&str] = &lines[1..];
    if split_kv(first).is_none() {
        out.push_str(&format!("## {first}\n"));
    } else {
        rest = &lines[..];
    }
    if !prefix.trim().is_empty() {
        out.push_str(&format!("> {}\n", prefix.trim()));
    }
    if !rest.is_empty() {
        out.push('\n');
    }
    let mut in_list = false;
    for line in rest {
        let t = line.trim();
        if t.is_empty() {
            out.push('\n');
            in_list = false;
            continue;
        }
        if let Some((k, v)) = split_kv(t) {
            out.push_str(&format!("- **{k}**：{v}\n"));
            in_list = true;
        } else if in_list {
            // 列表项续行（多行短信正文）：缩进 4 空格，QQ Markdown 渲染时
            // 仍归属上方列表项，不会掉出列表变成独立段落
            out.push_str(&format!("    {t}\n"));
        } else {
            out.push_str(t);
            out.push('\n');
        }
    }
    out.trim_end().to_string()
}

/// 识别 `键：值` 行。
///
/// 全角冒号优先（默认模板统一使用全角，值里的半角时间戳不会误切）；
/// 半角冒号仅当键足够短且键内无冒号时认可（兼容旧配置的 `发送者: 10086`）。
/// 含 `://` 的行（URL）一律不拆。
fn split_kv(line: &str) -> Option<(String, String)> {
    if line.contains("://") {
        return None;
    }
    if let Some(pos) = line.find('：') {
        let k = line[..pos].trim();
        let v = line[pos + '：'.len_utf8()..].trim();
        if !k.is_empty() && k.chars().count() <= 12 {
            return Some((k.to_string(), v.to_string()));
        }
    }
    if let Some(pos) = line.find(':') {
        let k = line[..pos].trim();
        let v = line[pos + 1..].trim();
        if !k.is_empty() && !v.is_empty() && k.chars().count() <= 8 && !k.contains(':') {
            return Some((k.to_string(), v.to_string()));
        }
    }
    None
}

/// Markdown 还原为纯文本（冷却期降级路径用）。
fn md_to_plain(md: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in md.lines() {
        let t = line.trim();
        let plain = if let Some(r) = t.strip_prefix("## ") {
            r.to_string()
        } else if let Some(r) = t.strip_prefix("> ") {
            r.to_string()
        } else if let Some(r) = t.strip_prefix("- **") {
            // "- **键**：值" → "键：值"
            match r.find("**") {
                Some(end) => format!("{}：{}", &r[..end], r[end + 2..].trim_start_matches('：')),
                None => t.to_string(),
            }
        } else {
            t.to_string()
        };
        if !plain.is_empty() {
            out.push(plain);
        }
    }
    out.join("\n")
}

/// 从 LAN IP 推导管理页地址（`uci get network.lan.ipaddr`）。
fn derive_admin_url() -> Option<String> {
    let out = std::process::Command::new("uci")
        .args(["get", "network.lan.ipaddr"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let ip = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if ip.is_empty() {
        None
    } else {
        Some(format!("http://{ip}/"))
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
pub(crate) async fn fetch_qq_token(app_id: &str, app_secret: &str) -> Result<(String, u64), String> {
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
            enabled: true,
            app_id: "111999".into(),
            app_secret: "secret".into(),
            target_type: target_type.into(),
            target_id: "ABC123".into(),
            bind_qq: String::new(),
            msg_format: "auto".into(),
            keyboard_enabled: false,
            keyboard_url: String::new(),
            menu_enabled: false,
            // 与出厂默认一致：节流只在 send() 里生效，单测不发网络请求，不受影响
            max_per_minute: crate::config::DEFAULT_QQ_MAX_PER_MIN,
        }
    }

    fn sender_of(target_type: &str) -> QqSender {
        QqSender::from_config(&qq_cfg(target_type)).expect("应构造成功")
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
    fn qq_sender_respects_enabled_switch() {
        // 开关关闭 → 不构造发送器（与企业微信开关互不影响）
        let off = QqNotifyConfig { enabled: false, ..qq_cfg("c2c") };
        assert!(QqSender::from_config(&off).is_none(), "qq_enabled=0 时不应构造发送器");
        // 显式开启 + 凭据齐全才构造（默认关闭，需用户主动打开）
        let on = QqNotifyConfig { enabled: true, ..qq_cfg("c2c") };
        assert!(QqSender::from_config(&on).is_some(), "显式开启应能构造");
    }

    #[test]
    fn qq_sender_requires_credentials_and_target() {
        let missing_id = QqNotifyConfig { app_id: String::new(), ..qq_cfg("group") };
        let missing_secret = QqNotifyConfig { app_secret: String::new(), ..qq_cfg("group") };
        let missing_target = QqNotifyConfig { target_id: "  ".into(), ..qq_cfg("group") };
        assert!(QqSender::from_config(&missing_id).is_none());
        assert!(QqSender::from_config(&missing_secret).is_none());
        assert!(QqSender::from_config(&missing_target).is_none());
        // bind 模式不构造发送器（由 qqbind 完成后热替换）
        assert!(QqSender::from_config(&qq_cfg("bind")).is_none());
        assert!(QqSender::from_config(&qq_cfg("group")).is_some());
    }

    #[test]
    fn qq_target_type_normalization() {
        assert_eq!(normalize_qq_target_type("Group"), "group");
        assert_eq!(normalize_qq_target_type(" users "), "c2c");
        assert_eq!(normalize_qq_target_type("GUILD"), "channel");
        assert_eq!(normalize_qq_target_type("bind"), "bind");
        assert_eq!(normalize_qq_target_type(""), "group");
    }

    #[test]
    fn msg_format_parsing() {
        assert_eq!(QqMsgFormat::from_uci("text"), QqMsgFormat::Text);
        assert_eq!(QqMsgFormat::from_uci("Markdown"), QqMsgFormat::Markdown);
        assert_eq!(QqMsgFormat::from_uci("md"), QqMsgFormat::Markdown);
        assert_eq!(QqMsgFormat::from_uci("auto"), QqMsgFormat::Auto);
        assert_eq!(QqMsgFormat::from_uci("乱值"), QqMsgFormat::Auto);
    }

    #[test]
    fn build_message_respects_format() {
        let body = "新短信\n发送者：10086\n内容：验证码 1234";
        let prefix = "2026-10-23 16:00:00 1";
        let mut cfg = qq_cfg("c2c");
        cfg.msg_format = "text".into();
        let s = QqSender::from_config(&cfg).unwrap();
        match s.build_message(body, prefix) {
            QqMessage::Text(t) => assert!(t.starts_with(prefix) && t.contains("新短信")),
            _ => panic!("text 格式应产生 Text"),
        }
        cfg.msg_format = "markdown".into();
        let s = QqSender::from_config(&cfg).unwrap();
        match s.build_message(body, prefix) {
            QqMessage::Markdown { content } => {
                assert!(content.starts_with("## 新短信"), "实际: {content}");
                assert!(content.contains("> 2026-10-23 16:00:00 1"), "前缀应为引用行: {content}");
                assert!(content.contains("- **发送者**：10086"), "kv 行应成列表: {content}");
            }
            _ => panic!("markdown 格式应产生 Markdown"),
        }
    }

    #[test]
    fn markdown_skips_title_when_first_line_is_kv() {
        // 模板只有 {content}（无标题行）时不硬造标题：首行是 kv 行
        let md = build_markdown("时间：2026-10-23 16:00:00\n号码：138****0000\n状态：来电振铃", "");
        assert!(!md.contains("## "), "kv 行不应被当成标题: {md}");
        assert!(md.contains("- **时间**：2026-10-23 16:00:00"), "实际: {md}");
        assert!(md.contains("- **状态**：来电振铃"), "实际: {md}");
    }

    #[test]
    fn markdown_keeps_plain_lines_and_blanks() {
        let md = build_markdown("5G 信号巡检\n时间：now\n\nRSRP -62 dBm（≥ -80）  优秀 · 信号强劲", "p 1");
        assert!(md.starts_with("## 5G 信号巡检\n"));
        assert!(md.contains("\n\nRSRP -62 dBm"), "空行应保留: {md}");
        assert!(md.contains("RSRP -62 dBm（≥ -80）  优秀 · 信号强劲"), "普通行原样: {md}");
        assert!(!md.contains("- **RSRP"), "无冒号行不应变成列表: {md}");
    }

    #[test]
    fn markdown_indents_multiline_content_under_list_item() {
        // 多行短信正文：第二行必须缩进成列表续行，否则会跳出列表变成独立段落
        let md = build_markdown("新短信\n发送者：10086\n内容：第一行\n第二行继续", "");
        assert!(
            md.contains("- **内容**：第一行\n    第二行继续"),
            "多行正文应缩进为列表续行: {md}"
        );
        // 空行之后的普通行是新段落，不缩进（巡检报告的指标行结构）
        let md2 = build_markdown("5G 信号巡检\n时间：now\n\nRSRP -62 dBm  优秀", "");
        assert!(md2.contains("\n\nRSRP -62 dBm  优秀"), "空行后不应缩进: {md2}");
    }

    #[test]
    fn md_to_plain_strips_list_indent() {
        let md = "## 新短信\n\n- **发送者**：10086\n- **内容**：第一行\n    第二行继续";
        let plain = md_to_plain(md);
        assert!(plain.contains("内容：第一行"), "实际: {plain}");
        assert!(plain.contains("\n第二行继续"), "续行缩进应被剥掉: {plain}");
    }

    #[test]
    fn split_kv_handles_full_and_half_width_colons() {
        assert_eq!(split_kv("发送者：10086"), Some(("发送者".into(), "10086".into())));
        assert_eq!(split_kv("发送者: 10086"), Some(("发送者".into(), "10086".into())));
        // 全角优先：半角时间戳不被误切
        assert_eq!(split_kv("时间：2026-10-23 16:00:00"), Some(("时间".into(), "2026-10-23 16:00:00".into())));
        // 普通行
        assert_eq!(split_kv("RSRP -62 dBm  优秀"), None);
        // URL 行不拆
        assert_eq!(split_kv("https://example.com/x"), None);
        // 键过长不拆
        assert_eq!(split_kv("一二三四五六七八九十一十二十三者：值"), None);
    }

    #[test]
    fn md_to_plain_round_trips_content() {
        let md = "## 新短信\n> 2026-10-23 16:00:00 1\n\n- **发送者**：10086\n- **内容**：验证码 1234";
        let plain = md_to_plain(md);
        assert!(plain.contains("新短信"), "实际: {plain}");
        assert!(plain.contains("2026-10-23 16:00:00 1"), "实际: {plain}");
        assert!(plain.contains("发送者：10086"), "实际: {plain}");
        assert!(plain.contains("内容：验证码 1234"), "实际: {plain}");
    }

    #[test]
    fn default_menu_body_shape_matches_platform_schema() {
        let body = QqSender::default_menu_body();
        let items = body.pointer("/menu/items").expect("应有 menu.items").as_array().expect("items 应为数组");
        assert_eq!(items.len(), 2);
        for it in items {
            assert_eq!(it["type"], "send_message");
            assert!(it["name"].as_str().is_some_and(|n| !n.is_empty()));
            assert!(it["send_message"].as_str().is_some_and(|s| !s.is_empty()));
        }
    }

    #[test]
    fn keyboard_json_only_when_url_present() {
        let mut cfg = qq_cfg("c2c");
        cfg.keyboard_enabled = true;
        cfg.keyboard_url = "http://192.168.1.1/".into();
        let s = QqSender::from_config(&cfg).unwrap();
        let kb = s.keyboard_json().expect("启用且带地址时应产出键盘");
        assert_eq!(kb.pointer("/content/rows/0/buttons/0/action/type"), Some(&serde_json::json!(0)));
        assert_eq!(
            kb.pointer("/content/rows/0/buttons/0/action/data"),
            Some(&serde_json::json!("http://192.168.1.1/"))
        );
        // 未启用 → 无键盘
        let s2 = sender_of("c2c");
        assert!(s2.keyboard_json().is_none());
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

    #[test]
    fn md_cooldown_starts_open_and_closes_after_failure() {
        let s = sender_of("c2c");
        assert!(!s.md_cooling(), "初始不在冷却");
        s.note_md_failure();
        assert!(s.md_cooling(), "失败后应进入冷却");
    }

    // ---------- 通道节流（qq_max_per_minute）----------

    fn sender_with_per_minute(max_per_minute: u64) -> QqSender {
        let mut cfg = qq_cfg("c2c");
        cfg.max_per_minute = max_per_minute;
        QqSender::from_config(&cfg).expect("应构造成功")
    }

    #[test]
    fn throttle_gap_derives_from_per_minute_count() {
        // 0 = 用户显式选了「不节流」
        assert_eq!(sender_with_per_minute(0).throttle_gap(), Duration::ZERO);
        assert_eq!(sender_with_per_minute(10).throttle_gap(), Duration::from_secs(6));
        // 最密的一档：60 条/分钟 = 每秒一条
        assert_eq!(sender_with_per_minute(60).throttle_gap(), Duration::from_secs(1));
        // 非整除档位保留毫秒精度：按整秒截断会让实际速率略高于用户设定的上限
        assert_eq!(sender_with_per_minute(7).throttle_gap(), Duration::from_millis(8571));
        // 出厂默认换算出 6 秒，落在单关系 20 条/分钟的频控之下
        assert_eq!(sender_of("c2c").throttle_gap(), Duration::from_secs(6));
    }

    #[test]
    fn reserve_slot_queues_requests_instead_of_bunching_them() {
        // 同一时刻涌进来的四条（典型场景：多条短信同时到达）必须排成
        // 6 秒一条的队列，而不是挤在同一秒一起撞平台频控。
        let s = sender_with_per_minute(10);
        let t0 = Instant::now();
        assert_eq!(s.reserve_slot(t0), t0, "首条不等");
        assert_eq!(s.reserve_slot(t0), t0 + Duration::from_secs(6));
        assert_eq!(s.reserve_slot(t0), t0 + Duration::from_secs(12));
        assert_eq!(s.reserve_slot(t0), t0 + Duration::from_secs(18));
    }

    #[test]
    fn reserve_slot_reanchors_after_idle_so_no_backlog_burst() {
        // 空闲一小时后再来一条：立刻发。若仍按「上一个槽 + 间隔」排队，
        // 就等于把这条消息无端压后 6 秒 —— 节流不该制造补发。
        let s = sender_with_per_minute(10);
        let t0 = Instant::now();
        s.reserve_slot(t0);
        let later = t0 + Duration::from_secs(3600);
        assert_eq!(s.reserve_slot(later), later);
    }

    #[test]
    fn reserve_slot_is_passthrough_when_throttling_is_off() {
        let s = sender_with_per_minute(0);
        let t0 = Instant::now();
        assert_eq!(s.reserve_slot(t0), t0);
        assert_eq!(s.reserve_slot(t0), t0, "不节流时同一时刻也能连续预约");
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

    /// 真实发送链路冒烟（默认跳过，走生产代码全路径）：
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
            enabled: true,
            app_id,
            app_secret: secret,
            target_type: t.into(),
            target_id: id.into(),
            bind_qq: String::new(),
            msg_format: "auto".into(),
            keyboard_enabled: false,
            keyboard_url: String::new(),
            menu_enabled: false,
            max_per_minute: crate::config::DEFAULT_QQ_MAX_PER_MIN,
        })
        .expect("配置应完整");
        let _ = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(sender.send(QqMessage::Text(
                "QQ 机器人通知通道冒烟测试（qqpush 生产链路）".to_string(),
            )));
    }
}
