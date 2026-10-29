//! 通知：短信/来电/信号/内存满四类事件，经企业微信 webhook、QQ 机器人
//! （[`crate::qqpush`]，官方 API v2）与本地日志文件输出
//! （可配置定时推送间隔、重试 3 次）。
//!
//! 数据流（本模块是推送链路的中枢）：
//!   urc.rs / schedule.rs 产生事件
//!     → `Notifier::notify()`    过滤事件类型 → 立即写本地日志文件 → **直接渲染并投递**
//!     → 企业微信 webhook / QQ 机器人（`QqSender`）
//!
//! **没有合并窗口**：v1.14.20 起「推送频率」改为「定时推送间隔」
//! （UCI `notify_timer_interval`，分钟），由 `timerpush.rs` 按它周期性推送
//! **当前实际情况**；事件到达时一律即刻发送，不再攒成批量。
//!
//! 队列只保留一个用途：**通道尚未就绪时暂存**。QQ「绑定模式」下绑定完成前没有
//! 通道，此时事件入队，`Notifier::run()` 每 10 秒扫一次，通道就绪即逐条补发
//! （不合并）。若照直发路径丢弃，用户绑定成功后会永久失去绑定期间的事件。

use crate::qqpush::{QqMessage, QqMsgFormat, QqSender};
use crate::{log_debug, log_error, log_info, log_warn};
use crate::config::{NotificationConfig, NotifyTemplates};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

const NOTIFY_QUEUE_SIZE: usize = 256;
const NOTIFY_MAX_PENDING: usize = 1000;
const NOTIFY_MAX_RETRIES: u32 = 3;

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

/// 测试事件的虚拟号码。
///
/// 刻意用掩码形式而不是 `13800138000` 这类看起来像真号的号码：测试推送是给用户
/// 自己看的，若显示成完整号码，用户可能真的回拨过去。掩码一眼就能看出是假的。
pub const TEST_SENDER_NUMBER: &str = "138****0000";

/// 测试短信的正文。写在正文里的（测试消息）标注与掩码号码同理：让接收端一眼分辨。
pub const TEST_SMS_CONTENT: &str = "这是一条模拟短信，用于验证推送通道与文案模板";

#[derive(Debug, Clone)]
pub struct Notification {
    pub sender: String,
    pub content: String,
    pub kind: NotifyKind,
    pub memory_full: bool,
    /// 事件发生时刻（本地时间 `%Y-%m-%d %H:%M:%S`），供文案模板的 `{time}` 占位符使用。
    /// 空串时渲染阶段回落到推送时刻。
    pub time: String,
    /// 预渲染的 QQ 富文本正文（Markdown 卡片）。
    ///
    /// 由掌握结构化数据的生产者自行渲染并携带（信号巡检、网络切换提醒
    /// 的表格卡片含条件行，模板表达不了）；短信卡片由 Notifier 按
    /// `notify_tpl_qq_sms_md` 自动填充；其余事件为 None，走通用的
    /// 「纯文本 → Markdown」转换。仅 QQ 富文本形态使用它。
    pub qq_card: Option<String>,
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
    /// 通知日志文件的大小上限（字节），写入前按此裁剪。
    log_file_max_bytes: u64,
    /// 本进程启动时处于 QQ「绑定模式」：绑定完成前通道为空，但事件必须照常入队，
    /// 否则绑定成功后拿不到任何后续推送（通道变了，队列入口却已关闭）。
    qq_bind_pending: bool,
}

impl Notifier {
    pub fn new(cfg: NotificationConfig) -> (Notifier, mpsc::Receiver<Notification>) {
        let (tx, rx) = mpsc::channel(NOTIFY_QUEUE_SIZE);
        let log_file_max_bytes = cfg.log_file_max_bytes.max(4096);
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
            log_info!(
                "QQ 机器人推送已启用（目标类型: {}，消息格式: {}）",
                s.target_type(),
                s.format().as_str()
            );
        }
        let qq = qq.map(std::sync::Arc::new);

        let qq_bind_pending = cfg.qq.target_type == "bind";
        log_info!(
            "定时推送间隔: {} 分钟（周期性推送当前实际情况；信号巡检另有一套间隔）",
            cfg.timer_interval.as_secs() / 60
        );

        (
            Notifier {
                cfg,
                qq: std::sync::RwLock::new(qq),
                tx,
                log_file,
                qq_bind_pending,
                log_file_max_bytes,
            },
            rx,
        )
    }

    fn enabled(&self, kind: NotifyKind) -> bool {
        match kind {
            NotifyKind::Sms => self.cfg.types.sms,
            NotifyKind::Call => self.cfg.types.call,
            NotifyKind::MemoryFull => self.cfg.types.memory_full,
            NotifyKind::Signal => self.cfg.types.signal,
        }
    }

    /// 是否存在「可能送达」的推送通道。
    ///
    /// 注意这里把「绑定模式待绑定」也算作可用：此时通道虽然为空，
    /// 但事件必须继续走（入队暂存，绑定成功后补发），
    /// 否则就是「机器人推送未接入任何推送数据」那个缺陷。
    fn dispatch_enabled(&self) -> bool {
        self.wechat_enabled() || self.qq_enabled() || self.qq_bind_pending
    }

    /// 此刻是否**真的**有可投递的通道（不含「绑定模式待绑定」）。
    ///
    /// 与 [`Notifier::dispatch_enabled`] 的分工：后者决定「事件要不要继续走」，
    /// 这里决定「现在能不能发出去」。混用会让待绑定状态下的事件被当成已送达而丢弃。
    fn has_channel(&self) -> bool {
        self.wechat_enabled() || self.qq_enabled()
    }

    /// 记录一条事件。
    ///
    /// 三条路径，按优先级判定：
    /// 1. **总开关关闭**（`notify_enabled=0`）：不入队、不推送，但仍写本地通知日志
    ///    （关的是「推送」而不是「记录」，留着事后追溯）；
    /// 2. **实时事件**（短信 / 来电）：绕过任何攒批逻辑**立即直发**，用户要求这两类必须实时；
    /// 3. 其余事件（信号 / 存储满）：v1.14.20 起同样**立即直发** —— 定时推送已独立成
    ///    `timerpush` 模块，不再需要靠攒批来控制节奏。
    pub async fn notify(&self, msg: Notification) {
        if !self.cfg.enabled {
            log_debug!("自动推送已关闭，事件仅记本地日志不推送: {}（{:?}）", msg.sender, msg.kind);
            if let Some(path) = &self.log_file {
                if let Err(e) = append_log(path, &msg, self.log_file_max_bytes) {
                    log_error!("写入通知日志失败: {}", e);
                }
            }
            return;
        }

        if !self.enabled(msg.kind) {
            log_debug!("该事件类型的推送开关已关闭，丢弃: {}（{:?}）", msg.sender, msg.kind);
            return;
        }

        if let Some(path) = &self.log_file {
            if let Err(e) = append_log(path, &msg, self.log_file_max_bytes) {
                log_error!("写入通知日志失败: {}", e);
            }
        }

        if !self.dispatch_enabled() {
            return;
        }

        // 有可用通道 → 立刻渲染并投递。**所有事件类型都直发**，不再攒合并窗口：
        // 短信/来电的实时性自不必说，信号与存储满也没有理由被压着等到窗口结束。
        if self.has_channel() {
            self.send_realtime(&msg);
            return;
        }

        // 没有可用通道（典型是 QQ「绑定模式」尚未完成绑定）：入队暂存，
        // 由 run() 在通道就绪后逐条补发。此刻直接丢弃的话，用户会永久失去
        // 绑定这段时间里发生的事件 —— 而绑定恰恰只在首次使用时发生一次。
        let sender = msg.sender.clone();
        let kind = msg.kind;
        if let Err(e) = self.tx.try_send(msg) {
            // 区分「队列满」与「接收端已退出」：后者的原文案会严重误导排障方向。
            match e {
                mpsc::error::TrySendError::Full(_) => {
                    log_warn!("待发通知队列已满，丢弃一条: {}（{:?}）", sender, kind)
                }
                mpsc::error::TrySendError::Closed(_) => {
                    log_error!("通知补发任务未在运行，事件已丢弃: {}（{:?}）", sender, kind)
                }
            }
        }
    }

    /// 实时直发：单条事件立即渲染并投递到所有通道，不经过任何攒批。
    fn send_realtime(&self, msg: &Notification) {
        let body = render_body(msg, &self.cfg.templates);
        let prefix = render_prefix_str(&self.cfg.templates, 1);
        let combined = combine_body(&body, &prefix);
        // QQ 富文本卡片：生产者预渲染优先，否则按事件类型自动套模板（短信）。
        // 卡片自带时间与序号信息，不再叠加全局前缀。
        let qq_card = msg.qq_card.clone().or_else(|| self.auto_card(msg));
        match &qq_card {
            Some(card) => log_debug!("推送内容（QQ 富文本卡片）: {}", card),
            None => log_debug!("推送内容（实时直发）: {}", combined),
        }
        self.dispatch_body(&combined, &body, &prefix, qq_card.as_deref());
    }

    /// 生产者未预渲染卡片时，按事件类型自动套用对应的 QQ 富文本模板。
    /// 当前仅短信有模板卡片（`notify_tpl_qq_sms_md`）。
    fn auto_card(&self, msg: &Notification) -> Option<String> {
        match msg.kind {
            NotifyKind::Sms => {
                render_card_template(&self.cfg.templates.qq_sms_md, msg, 1, &now_string())
            }
            _ => None,
        }
    }

    /// 把渲染好的正文投递到所有已启用通道。
    ///
    /// 通道可用性在此刻同步判定、发送异步进行：投递失败由各自的重试与日志负责，
    /// 不阻塞调用方（URC 分发循环与定时推送都跑在关键路径上）。
    ///
    /// 三个入参的分工：`combined` 是「前缀 + 正文」的纯文本（企业微信用）；
    /// `body` / `prefix` 分开传是给 QQ 通道的 —— [`crate::qqpush`] 需要它们
    /// 分别组装 Markdown（正文进标题与列表，前缀进引用行）。
    fn dispatch_body(&self, combined: &str, body: &str, prefix: &str, qq_card: Option<&str>) {
        let wechat = self.wechat_enabled();
        let qq = self.current_qq();
        if wechat {
            let hook = self.cfg.wechat_webhook.clone();
            let text = combined.to_string();
            tokio::spawn(async move {
                let _ = send_webhook(&hook, &text).await;
            });
        }
        if let Some(qq) = qq {
            let msg = match qq_card {
                // 富文本卡片已是最终 Markdown，直接投递；纯文本格式不投卡片
                Some(card) if qq.format() != QqMsgFormat::Text => {
                    QqMessage::Markdown { content: card.to_string() }
                }
                _ => qq.build_message(body, prefix),
            };
            tokio::spawn(async move {
                let _ = qq.send(msg).await;
            });
        }
    }

    /// 驱动「通道未就绪时暂存事件」的补发，直到 ctx 结束。
    ///
    /// v1.14.20 起这里**不再做合并窗口**：正常路径上事件已经直发，队列只剩一个
    /// 用途 —— QQ 绑定模式下绑定完成前没有通道，事件先暂存，绑定成功（通道热
    /// 替换进来）后逐条补发。
    ///
    /// 为什么还要 10 秒扫一次：绑定是外部事件（用户在 QQ 里给机器人发消息），
    /// 不会唤醒本循环。没有定时扫描的话，pending 里的事件要等到下一条新事件到达
    /// 才被捎带发出，表现为「明明绑定成功了，可刚才那条短信推送再也没来过」。
    ///
    /// 本任务**恒定运行**，不因「启动时还没有可用通道」而退出：`rx` 若随任务结束
    /// 被丢弃，此后 `notify()` 的 `try_send` 会全部失败——那就是
    /// 「绑定成功却收不到任何推送数据」这个老缺陷。
    pub async fn run(&self, mut rx: mpsc::Receiver<Notification>, mut ctx: tokio::sync::watch::Receiver<bool>) {
        /// 补发扫描周期：仅在有待发事件时才挂这个定时器。
        const SWEEP: Duration = Duration::from_secs(10);
        let mut pending: Vec<Notification> = Vec::new();

        loop {
            tokio::select! {
                _ = ctx.changed() => {
                    self.drain_pending(&mut pending);
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
                            self.drain_pending(&mut pending);
                            return;
                        }
                    }
                }
                _ = tokio::time::sleep(SWEEP), if !pending.is_empty() => {}
            }
            // 无论被哪个分支唤醒都尝试补发一次：新事件到达与定时扫描都会走到这里，
            // 通道一旦就绪就把积压事件按原顺序逐条发出。
            self.drain_pending(&mut pending);
        }
    }

    /// 把暂存的事件**逐条**发送到已启用的推送通道（不再合并成批量）。
    ///
    /// 一个通道都没有时保留队列；总开关被关掉时丢弃并留痕。
    fn drain_pending(&self, pending: &mut Vec<Notification>) {
        if pending.is_empty() {
            return;
        }
        if !self.has_channel() {
            log_debug!("推送通道尚未就绪（QQ 绑定模式等待绑定），保留 {} 条待发事件", pending.len());
            return;
        }
        // 总开关可能在事件入队后被关掉：此时保留队列无意义，直接丢弃并留痕。
        if !self.cfg.enabled {
            log_debug!("自动推送已关闭，丢弃 {} 条待发事件", pending.len());
            pending.clear();
            return;
        }

        let taken = std::mem::take(pending);
        log_info!("推送通道已就绪，补发 {} 条暂存事件", taken.len());
        for msg in &taken {
            self.send_realtime(msg);
        }
    }

    /// 自动推送总开关是否开启。
    pub fn master_enabled(&self) -> bool {
        self.cfg.enabled
    }

    /// 信号类通知的最小推送间隔（UCI `notify_signal_min_interval`，分钟；ZERO=不限频）。
    ///
    /// 门控由**事件生产者**执行（[`crate::signalwatch`] 巡检、[`crate::urc`] 的
    /// 信号上报），不在这里拦：Notifier 收到的「信号事件」既包括巡检推来的突变
    /// 通知，也包括 [`crate::timerpush`] 到点推的状态快照，两者同为
    /// [`NotifyKind::Signal`]，在枢纽处一刀切会把用户自己设定的定时推送节奏也夹掉。
    /// 配置挂在 Notifier 上，只是让两个生产者共用同一份取值而不各读一次 UCI。
    pub fn signal_min_interval(&self) -> Duration {
        self.cfg.signal_min_interval
    }

    /// 测试指定推送通道（LuCI「发送测试通知」按钮）。绕过事件链路直接发送。
    /// 测试消息不携带任何插件名字样，同样套用全局前缀，便于一次性验证前缀配置是否生效。
    pub async fn notify_test(&self, channel: &str) -> Result<(), String> {
        let base = "测试通知：推送通道一切正常，链路畅通";
        let prefix = render_prefix_str(&self.cfg.templates, 1);
        // 与业务推送一致地记录「实际发出的文本」：测试通道是排障入口，
        // 只有看到真实出站内容才能判断前缀/文案是否按预期生效。
        log_debug!("推送内容（测试通道 {}）: {}", channel, combine_body(base, &prefix));
        match channel {
            "qq" => {
                let qq = self
                    .current_qq()
                    .ok_or_else(|| "QQ 通道未启用（检查 AppID/AppSecret/目标 ID；绑定模式需先完成绑定）".to_string())?;
                qq.send(qq.build_message(base, &prefix)).await
            }
            "wechat" => {
                if !self.cfg.wechat_enabled {
                    return Err("企业微信推送开关未开启（通知设置里打开「企业微信推送」并填写 WebHook）".into());
                }
                if self.cfg.wechat_webhook.trim().is_empty() {
                    return Err("企业微信推送开关已开启，但 WebHook 地址为空".into());
                }
                send_webhook(&self.cfg.wechat_webhook.clone(), &combine_body(base, &prefix)).await
            }
            other => Err(format!("未知通道: {other}")),
        }
    }

    /// 按事件类型直发一条**合成测试事件**（LuCI「测试短信推送 / 测试来电推送」按钮）。
    ///
    /// 与 [`Notifier::notify_test`] 的分工：
    /// - `notify_test` 只验证**通道连通性**：固定文案、不经过事件链路，任何类型都测得到；
    /// - 本方法验证**某一类的完整链路**：构造一条与真实事件**同形状**的事件交给
    ///   [`Notifier::notify`]，于是走的是完全相同的判定与渲染路径
    ///   （总开关 → 该类型开关 → 短信/来电实时直发 → 文案模板 → 通道投递），
    ///   收到的文本与真实短信/来电一字不差。短信与来电这两类只能由模组 URC 触发，
    ///   想验证「新文案长什么样、是不是实时」不必真的等一条短信或一通电话。
    ///
    /// 开关未开启时**显式返回错误**，而不是照直调用 `notify()` 后返回 Ok：
    /// `notify()` 在总开关/类型开关关闭时是静默 return 的，若照直调用，界面会显示
    /// 「发送成功」而手机毫无动静 —— 这是最难排查的一种失败（发送侧一切正常）。
    pub async fn notify_test_event(&self, kind: NotifyKind) -> Result<(), String> {
        let (sender, content) = match kind {
            NotifyKind::Sms => (
                TEST_SENDER_NUMBER.to_string(),
                format!("{TEST_SMS_CONTENT}（测试消息，非真实短信）"),
            ),
            NotifyKind::Call => (
                SENDER_CALL.to_string(),
                format!(
                    "时间：{now}\n号码：{num}\n状态：来电振铃（测试消息，非真实来电）",
                    now = now_string(),
                    num = TEST_SENDER_NUMBER
                ),
            ),
            other => {
                return Err(format!(
                    "「{}」不支持测试推送（只有短信与来电需要按类型验证；信号请等定时推送或真实巡检）",
                    kind_label(other)
                ))
            }
        };

        if !self.cfg.enabled {
            return Err("自动推送总开关已关闭，事件不会推送（当前只记本地日志）".into());
        }
        if !self.enabled(kind) {
            return Err(format!("「{}」的事件推送开关已关闭", kind_label(kind)));
        }
        if !self.dispatch_enabled() {
            return Err("没有已启用的推送通道（企业微信 WebHook 或 QQ 机器人）".into());
        }

        self.notify(Notification {
            sender,
            content,
            kind,
            memory_full: false,
            qq_card: None,
            time: now_string(),
        })
        .await;
        Ok(())
    }

    /// 企业微信通道是否可用：独立开关 **且** WebHook 地址非空。
    ///
    /// 两个条件都要：只填地址不开开关不发（默认关），开了开关没地址也不发
    /// （否则会拿空串去请求，每轮通知白跑三次重试）。
    fn wechat_enabled(&self) -> bool {
        self.cfg.wechat_enabled && !self.cfg.wechat_webhook.trim().is_empty()
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
            Some(s) => log_info!("QQ 机器人推送已启用（目标类型: {}，热生效）", s.target_type()),
            None => log_info!("QQ 机器人推送通道已停用"),
        }
    }

    /// QQ 自定义菜单管理（LuCI `qq_menu` RPC）：set=覆盖配置默认菜单，get=查询当前菜单。
    ///
    /// 自定义菜单仅 C2C（单聊）场景生效（官方限制），对所有用户生效；
    /// 默认菜单项见 [`crate::qqpush::QqSender::default_menu_body`]。
    pub async fn qq_menu(&self, action: &str) -> Result<serde_json::Value, String> {
        let qq = self
            .current_qq()
            .ok_or_else(|| "QQ 通道未启用（检查 AppID/AppSecret/目标 ID）".to_string())?;
        match action.trim() {
            "set" => {
                let version = qq.set_menu(&QqSender::default_menu_body()).await?;
                Ok(serde_json::json!({ "action": "set", "version": version }))
            }
            "get" => {
                let menu = qq.get_menu().await?;
                Ok(serde_json::json!({ "action": "get", "menu": menu }))
            }
            other => Err(format!("未知菜单操作: {other}（可用 set / get）")),
        }
    }

    /// 启动时按 `qq_menu_enabled` 配置一次 QQ 自定义菜单（由 main 在启动
    /// 段落调用）。通道未就绪（绑定模式等待绑定）时静默跳过 —— 绑定成功
    /// 路径会补一次，见 `main::run_qq_bind`。
    pub async fn apply_qq_menu_auto(&self) {
        match self.current_qq() {
            Some(qq) => qq.apply_default_menu().await,
            None => log_debug!("QQ 通道未就绪，跳过自定义菜单自动配置"),
        }
    }
}

fn prepare_log_file(path: &str) -> Result<String, String> {
    let abs = std::path::absolute(path).map_err(|e| e.to_string())?;
    if let Some(dir) = abs.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建日志目录 {} 失败: {e}", dir.display()))?;
    }
    // append(true) 已隐含写权限，显式再写 write(true) 是冗余
    let f = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&abs)
        .map_err(|e| format!("日志文件不可写 {}: {e}", abs.display()))?;
    drop(f);
    Ok(abs.to_string_lossy().into_owned())
}

/// 追加一条通知到日志文件，**并保证文件不超过 `max_bytes`**。
///
/// 走 [`crate::ringlog::append_capped`]：超限先按行边界裁掉最旧的一半再追加，
/// 绝不切出半行，也绝不让文件无上限增长（`/tmp` 是 tmpfs，写满会拖垮整机）。
fn append_log(path: &str, msg: &Notification, max_bytes: u64) -> std::io::Result<()> {
    let ts = if msg.time.is_empty() { now_string() } else { msg.time.clone() };
    let mut b = String::new();
    if msg.memory_full {
        b.push_str(&format!("[{ts}] 存储空间已满警告\n"));
    } else {
        b.push_str(&format!("[{ts}] 发送者: {}\n内容: {}\n", msg.sender, msg.content));
    }
    b.push_str(&"-".repeat(50));
    b.push('\n');

    crate::ringlog::append_capped(path, &b, max_bytes)
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

/// 最小推送间隔门控（防刷屏）：返回 `Some(还需等待)` 表示这一条**不该**发。
///
/// 做成纯函数（两个时刻都由调用方传入）是为了能把「从未发过」「差一秒」「刚好
/// 到点」这三种边界直接钉进单测 —— 用 `Instant::now()` 的实现测不到，而这三点
/// 恰恰是「限频到底生没生效」的全部争议处。
///
/// - `min` 为 `ZERO`：不限频，恒 `None`（用户在界面上选了「不限制」）；
/// - `last` 为 `None`：进程内该类第一次推送，必放 —— 否则服务每次重启都要先
///   干等一小时，功能看起来像坏了；
/// - 恰好等于最小间隔：放行。语义是「达到即推」，与巡检变化阈值同口径。
pub fn min_interval_hold(last: Option<Instant>, now: Instant, min: Duration) -> Option<Duration> {
    if min.is_zero() {
        return None;
    }
    let last = last?;
    let elapsed = now.saturating_duration_since(last);
    if elapsed >= min {
        None
    } else {
        Some(min - elapsed)
    }
}

/// 本机当前时刻字符串（`%Y-%m-%d %H:%M:%S`，系统时区）。事件产生侧用它填充
/// [`Notification::time`]，保证推送文案里的 `{time}` 是事件时刻而非推送时刻。
///
/// 时刻取 [`crate::nettime`]（NTP 优先、设备时钟兜底），时区沿用系统设置
/// （见 [`crate::localtime`]，取不到时北京时间）—— **系统怎么设就怎么显示**。
/// 此处曾经直接用 `chrono::Local`，在无 tzdata 的固件上静默变成 UTC，
/// 推送时间比现实早 8 小时。
pub fn now_string() -> String {
    crate::nettime::now_string()
}

/// 号码归一化：剥掉前导 `+` 与国家码 `86`，与前端 `Parse.normalizePhoneNumber`
/// （`htdocs/.../at-webserver/parse.js`）**保持同一规则**。
///
/// 为什么必须统一：同一个联系人会以三种面貌出现 ——
/// 短信 PDU 里的 `8613800138000`、`+CLIP` 里的 `+8613800138000`、
/// 而短信中心界面显示的是 `13800138000`（前端已归一化）。
/// 推送若原样透出，用户看到的号码就和界面上对不上，同一个联系人像两个人。
///
/// 只处理「看起来像国内号码」的情形：`86` 之后全是数字才剥国家码；
/// `+1...` 这类国际号码只剥 `+`，不动国家码；
/// 完全不像号码的（含字母等）最后只留数字，与前端 `replace(/\D/g, '')` 相同。
pub fn normalize_phone_number(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let n = raw.strip_prefix('+').unwrap_or(raw);
    if let Some(rest) = n.strip_prefix("86") {
        if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()) {
            return rest.to_string();
        }
    }
    if n.bytes().all(|b| b.is_ascii_digit()) {
        return n.to_string();
    }
    // 兜底：夹杂了分隔符（如 138-0013-8000）时只留数字
    let digits: String = n.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        n.to_string()
    } else {
        digits
    }
}

/// 按事件类型选出对应的文案模板。
pub fn template_for(tpl: &NotifyTemplates, kind: NotifyKind) -> &str {
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

/// 渲染 QQ 富文本卡片模板（当前用于短信卡片）。
///
/// 占位符与通用模板一致（`{sender}` `{content}` `{time}` `{kind}` `{count}`），
/// 渲染结果本身就是最终 Markdown，不再经通用转换。模板为空、或显式写成
/// `{body}`（逃生开关：表示「改用通用转换」）时返回 None。
pub fn render_card_template(tpl: &str, msg: &Notification, count: usize, now: &str) -> Option<String> {
    let t = tpl.trim();
    if t.is_empty() || t == "{body}" {
        return None;
    }
    Some(render_template(tpl, msg, count, now))
}

/// 前缀拼接：前缀在上、正文在下；前缀为空（或全空白）时只返回正文。
pub fn combine_body(body: &str, prefix: &str) -> String {
    if prefix.trim().is_empty() {
        body.to_string()
    } else {
        format!("{prefix}\n{body}")
    }
}

/// 渲染单条事件的正文（**不含**全局前缀，供 QQ 富媒体单独组装用）。
pub fn render_body(msg: &Notification, tpl: &NotifyTemplates) -> String {
    render_template(template_for(tpl, msg.kind), msg, 1, &now_string())
}

/// 渲染全局前缀（空串表示不添加）。
pub fn render_prefix_str(tpl: &NotifyTemplates, count: usize) -> String {
    render_prefix(&tpl.prefix, count, &now_string())
}

/// 把一批事件渲染为最终推送文本（单条即只渲染该条）。
///
/// 单条：直接套用该事件类型的模板。
/// 多条：`{batch}` 标题 + 分隔线 + 逐条「序号 + 该事件类型的模板渲染结果」。
/// 两种形态都会在最前面加全局前缀（若配置了）。
///
/// **生产路径不会走多条分支**：v1.14.20 起事件一律逐条实时直发，
/// 攒批（合并窗口）已经移除，`{batch}` 模板键保留只为兼容已有配置。
/// 之所以还留着这个函数，是因为它是「模板渲染 + 前缀拼接」的唯一端到端
/// 断言入口 —— 单测靠它覆盖占位符替换、未知占位符保留、存储满兜底文案、
/// 前缀 `{count}`/`{time}` 取值这些规则。删掉它，这些规则就只剩分散的
/// 单点断言，模板改动容易漏测。改动渲染逻辑时请同步更新这里的测试。
#[cfg_attr(not(test), allow(dead_code))]
pub fn combine_messages(msgs: &[Notification], tpl: &NotifyTemplates) -> String {
    if msgs.is_empty() {
        return String::new();
    }
    let now = now_string();

    let body = if msgs.len() == 1 {
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

    combine_body(&body, &render_prefix(&tpl.prefix, msgs.len(), &now))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::QqNotifyConfig;

    fn sms(sender: &str, content: &str) -> Notification {
        Notification {
            sender: sender.into(),
            content: content.into(),
            kind: NotifyKind::Sms,
            memory_full: false,
            qq_card: None,
            time: "2026-10-11 12:00:00".into(),
        }
    }

    /// 号码归一化的规则必须与前端 `Parse.normalizePhoneNumber` 完全一致：
    /// 任何一侧单独改动，推送与界面就会重新对不上。
    #[test]
    fn phone_normalization_matches_frontend_rules() {
        // 国内号码：三种写法都收敛到同一串
        assert_eq!(normalize_phone_number("8613800138000"), "13800138000");
        assert_eq!(normalize_phone_number("+8613800138000"), "13800138000");
        assert_eq!(normalize_phone_number("13800138000"), "13800138000");
        // 已是归一化形态时幂等（WS 事件里会二次处理）
        assert_eq!(normalize_phone_number("13800138000"), normalize_phone_number("+8613800138000"));
        // 国际号码：只剥 `+`，不动国家码
        assert_eq!(normalize_phone_number("+14155550100"), "14155550100");
        // 不以 86 开头 → 原样保留；86 之后非数字 → 落到「只留数字」兜底（与前端一致）
        assert_eq!(normalize_phone_number("10086"), "10086");
        assert_eq!(normalize_phone_number("86abc"), "86");
        // 带分隔符
        assert_eq!(normalize_phone_number("138-0013-8000"), "13800138000");
        // 空串
        assert_eq!(normalize_phone_number(""), "");
    }

    /// 短号与特殊号码不能被误伤：`86` 后没有数字时按原样处理。
    #[test]
    fn phone_normalization_keeps_short_codes() {
        /* `+86` 只剩国家码时保留国家码本身（只剥 `+`），与前端一致 */
        assert_eq!(normalize_phone_number("+86"), "86");
        assert_eq!(normalize_phone_number("+8610"), "10");
    }

    // ---------- 最小推送间隔门控 ----------

    /// 限频门控的三种边界。这三条直接决定「网络切换提醒会不会一小时刷屏」，
    /// 也决定「限频会不会把第一条也吞掉」。
    #[test]
    fn min_interval_hold_gates_repeats() {
        let base = Instant::now();
        let one_hour = Duration::from_secs(3600);

        // 从未推过 → 必放（服务重启后不能先干等一小时）
        assert_eq!(min_interval_hold(None, base, one_hour), None);

        // 刚推过 → 抑制，且剩余时间正确
        let hold = min_interval_hold(Some(base), base + Duration::from_secs(10), one_hour)
            .expect("10 秒后重复推送应被抑制");
        assert_eq!(hold, one_hour - Duration::from_secs(10));

        // 差一秒 → 仍抑制
        assert!(min_interval_hold(Some(base), base + one_hour - Duration::from_secs(1), one_hour).is_some());

        // 刚好到点 → 放行（「达到即推」，与巡检阈值同口径）
        assert_eq!(min_interval_hold(Some(base), base + one_hour, one_hour), None);

        // 超过间隔 → 放行
        assert_eq!(min_interval_hold(Some(base), base + one_hour * 3, one_hour), None);

        // 时钟回拨（last 在未来）：saturating 减法得 0，仍是抑制而不是panic
        assert!(min_interval_hold(Some(base + one_hour), base, one_hour).is_some());
    }

    #[test]
    fn min_interval_zero_disables_the_gate() {
        // 用户在界面上选「不限制」→ 任何重复都放行
        let base = Instant::now();
        assert_eq!(min_interval_hold(Some(base), base, Duration::ZERO), None);
        assert_eq!(min_interval_hold(None, base, Duration::ZERO), None);
    }

    #[test]
    fn notifier_exposes_signal_min_interval() {
        let mut cfg = crate::config::default_config().notification;
        cfg.log_file = String::new();
        let (notifier, _rx) = Notifier::new(cfg.clone());
        assert_eq!(notifier.signal_min_interval(), Duration::from_secs(3600));

        cfg.signal_min_interval = Duration::ZERO;
        let (relaxed, _rx2) = Notifier::new(cfg);
        assert!(relaxed.signal_min_interval().is_zero());
    }

    // ---------- 文案模板渲染 ----------

    #[test]
    fn qq_sms_card_template_renders_placeholders() {
        let tpl = NotifyTemplates::default();
        let m = sms("10086", "验证码 1234");
        let card = render_card_template(&tpl.qq_sms_md, &m, 1, "2026-10-23 17:00:00")
            .expect("默认配置应产出短信卡片");
        assert!(card.starts_with("## 喵呜～收到新短信啦"), "实际: {card}");
        assert!(card.contains("**发送者：** `10086`"), "发送者应进代码 span: {card}");
        assert!(card.contains("**接收时间：** `2026-10-11 12:00:00`"), "缺接收时间: {card}");
        assert!(card.contains("**消息序号：** `1`"), "缺消息序号: {card}");
        assert!(card.contains("### 信笺内容"), "缺内容分节: {card}");
        assert!(card.contains("验证码 1234"), "正文缺失: {card}");
    }

    #[test]
    fn qq_card_template_empty_or_body_means_generic() {
        let m = sms("10086", "hi");
        assert!(render_card_template("", &m, 1, "t").is_none(), "空模板不产卡片");
        assert!(render_card_template("   ", &m, 1, "t").is_none(), "空白模板不产卡片");
        assert!(
            render_card_template("{body}", &m, 1, "t").is_none(),
            "{{body}} 是显式改用通用转换的逃生开关"
        );
    }

    #[test]
    fn default_single_sms_has_no_decorative_prefix() {
        // v1.28.0 起默认模板不再自带「喵呜～」类装饰前缀：全部推送只带
        // 统一的全局前缀 {time} {count}，正文首行即标题。
        let tpl = NotifyTemplates::default();
        let out = combine_messages(&[sms("10086", "验证码 1234")], &tpl);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 4, "实际: {out}");
        assert!(lines[0].ends_with(" 1"), "首行应为「事件时刻 条数」: {}", lines[0]);
        assert_eq!(lines[1], "新短信");
        assert_eq!(lines[2], "发送者：10086");
        assert_eq!(lines[3], "内容：验证码 1234");
        assert!(!out.contains("喵呜"), "默认模板不应再带装饰性前缀: {out}");
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
        tpl.prefix = String::new();
        tpl.sms = "{sender}/{unknown}".into();
        assert_eq!(combine_messages(&[sms("A", "B")], &tpl), "A/{unknown}");
    }

    #[test]
    fn memory_full_content_falls_back_to_readable_text() {
        let mut tpl = NotifyTemplates::default();
        tpl.prefix = String::new();
        tpl.memory_full = "{content}".into();
        let m = Notification {
            sender: String::new(),
            content: String::new(),
            kind: NotifyKind::MemoryFull,
            memory_full: true,
            qq_card: None,
            time: String::new(),
        };
        assert_eq!(combine_messages(&[m], &tpl), "短信存储空间已满");
    }

    #[test]
    fn batch_uses_header_index_and_template() {
        let mut tpl = NotifyTemplates::default();
        tpl.prefix = String::new();
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

    /// 「事件 → 入队（通道未就绪时）→ 补发 → 文案模板渲染 → HTTP 投递」整条链路的回归用例。
    ///
    /// 用本地 TCP 监听充当 WebHook 接收端，断言**真正发出的报文内容**。
    /// 这是「机器人推送未接入任何推送数据」缺陷最直接的回归保护：一旦
    /// `run()` 又被改成「启动时无通道就退出」，或事件不再入队，本用例会因
    /// 收不到请求而超时失败，而不会静默「通过」。
    #[tokio::test]
    async fn merged_push_renders_template_and_posts_to_webhook() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("监听应成功");
        let port = listener.local_addr().expect("取端口").port();

        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.expect("应收到 WebHook 请求");
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                let n = match sock.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                buf.extend_from_slice(&chunk[..n]);
                // 收到完整请求（头 + Content-Length 指定的正文）即停止读取
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..pos]).to_string();
                    let len = head
                        .lines()
                        .find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            if k.eq_ignore_ascii_case("content-length") {
                                v.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);
                    if buf.len() >= pos + 4 + len {
                        break;
                    }
                }
            }
            // post_webhook 要求 HTTP 200 且正文 errcode=0，否则会重试并判失败
            let reply = r#"{"errcode":0,"errmsg":"ok"}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                reply.len(),
                reply
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.flush().await;
            String::from_utf8_lossy(&buf).to_string()
        });

        let mut cfg = crate::config::default_config().notification;
        cfg.log_file = String::new();
        cfg.wechat_enabled = true;
        cfg.wechat_webhook = format!("http://127.0.0.1:{port}/hook");
        cfg.qq = QqNotifyConfig {
            enabled: true,
            app_id: String::new(),
            app_secret: String::new(),
            target_type: "c2c".into(),
            target_id: String::new(),
            bind_qq: String::new(),
            msg_format: "auto".into(),
            keyboard_enabled: false,
            keyboard_url: String::new(),
            menu_enabled: false,
            max_per_minute: crate::config::DEFAULT_QQ_MAX_PER_MIN,
        };
        // 模板换成可精确断言的固定格式；事件走实时直发，测试不必等任何攒批窗口
        cfg.templates.prefix = "[测试]".into();
        cfg.templates.sms = "{kind}|{sender}|{content}|{time}|{count}".into();

        let (notifier, rx) = Notifier::new(cfg);
        let notifier = std::sync::Arc::new(notifier);
        let (_ctx_tx, ctx_rx) = tokio::sync::watch::channel(false);
        tokio::spawn({
            let notifier = notifier.clone();
            async move { notifier.run(rx, ctx_rx).await }
        });

        notifier
            .notify(Notification {
                sender: "10086".into(),
                content: "余额不足".into(),
                kind: NotifyKind::Sms,
                memory_full: false,
                qq_card: None,
                time: "2026-10-11 23:00:00".into(),
            })
            .await;

        let raw = tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("5 秒内应收到 WebHook 请求（事件未入队，或合并任务已提前退出）")
            .expect("接收任务不应 panic");

        assert!(raw.contains(r#""msgtype":"text""#), "报文缺少企业微信文本消息结构: {raw}");
        assert!(
            raw.contains("新短信|10086|余额不足|2026-10-11 23:00:00|1"),
            "合并推送未按自定义模板渲染（占位符未替换或文案未生效）: {raw}"
        );
        assert!(raw.contains("[测试]"), "全局前缀未出现在推送内容中: {raw}");
    }

    /// 起一个「只接收一次请求」的本地 WebHook 接收端。
    /// 返回端口与接收任务；接收任务在拿到完整请求（头 + 正文）后返回原始报文。
    async fn one_shot_webhook() -> (u16, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("监听应成功");
        let port = listener.local_addr().expect("取端口").port();
        let task = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.expect("应收到 WebHook 请求");
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                let n = match sock.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..pos]).to_string();
                    let len = head
                        .lines()
                        .find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            if k.eq_ignore_ascii_case("content-length") {
                                v.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);
                    if buf.len() >= pos + 4 + len {
                        break;
                    }
                }
            }
            let reply = r#"{"errcode":0,"errmsg":"ok"}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                reply.len(),
                reply
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.flush().await;
            String::from_utf8_lossy(&buf).to_string()
        });
        (port, task)
    }

    /// 只配 WebHook、关掉 QQ 与日志文件的测试基线配置。
    fn webhook_only_cfg(port: u16) -> NotificationConfig {
        let mut cfg = crate::config::default_config().notification;
        cfg.log_file = String::new();
        cfg.wechat_enabled = true;
        cfg.wechat_webhook = format!("http://127.0.0.1:{port}/hook");
        cfg.qq = QqNotifyConfig {
            enabled: true,
            app_id: String::new(),
            app_secret: String::new(),
            target_type: "c2c".into(),
            target_id: String::new(),
            bind_qq: String::new(),
            msg_format: "auto".into(),
            keyboard_enabled: false,
            keyboard_url: String::new(),
            menu_enabled: false,
            max_per_minute: crate::config::DEFAULT_QQ_MAX_PER_MIN,
        };
        cfg
    }

    /// 总开关关闭：**只写本地日志，绝不外发**。
    ///
    /// 「关掉自动推送」不等于「关掉记录」——事后追溯仍需要日志，所以这里
    /// 同时断言两件事：网络侧静默、磁盘侧留痕。
    #[tokio::test]
    async fn master_switch_off_logs_but_never_sends() {
        let (port, server) = one_shot_webhook().await;

        let mut cfg = webhook_only_cfg(port);
        cfg.enabled = false;
        let log_path = std::env::temp_dir().join(format!("at-notify-off-{port}.log"));
        let _ = std::fs::remove_file(&log_path);
        cfg.log_file = log_path.to_string_lossy().into_owned();

        let (notifier, rx) = Notifier::new(cfg);
        let notifier = std::sync::Arc::new(notifier);
        assert!(!notifier.master_enabled(), "总开关关闭时 master_enabled 应为 false");
        let (_ctx_tx, ctx_rx) = tokio::sync::watch::channel(false);
        tokio::spawn({
            let notifier = notifier.clone();
            async move { notifier.run(rx, ctx_rx).await }
        });

        notifier
            .notify(Notification {
                sender: "10086".into(),
                content: "总开关关闭时不应外发".into(),
                kind: NotifyKind::Sms,
                memory_full: false,
                qq_card: None,
                time: "2026-10-11 23:10:00".into(),
            })
            .await;

        // 短信是「实时直发」路径，若总开关没有优先判定，这里必然会被连上
        let got = tokio::time::timeout(Duration::from_millis(1200), server).await;
        assert!(got.is_err(), "总开关关闭时不应发出任何推送请求");

        let text = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert!(text.contains("10086"), "总开关关闭时仍应写本地通知日志，实际内容: {text}");
        let _ = std::fs::remove_file(&log_path);
    }

    /// 短信 / 来电必须**实时**推送：不能进队列等攒批。
    ///
    /// 把兜底扫描周期设成 10 秒。若这两类事件走的是入队路径，2 秒内绝不可能收到
    /// WebHook 请求，用例会因此失败——这正是「短信和来电需要实时推送」的回归保护。
    #[tokio::test]
    async fn sms_is_sent_immediately_bypassing_merge_window() {
        let (port, server) = one_shot_webhook().await;

        let mut cfg = webhook_only_cfg(port);
        cfg.templates.prefix = String::new();
        cfg.templates.sms = "实时|{sender}|{content}".into();

        let (notifier, rx) = Notifier::new(cfg);
        let notifier = std::sync::Arc::new(notifier);
        let (_ctx_tx, ctx_rx) = tokio::sync::watch::channel(false);
        tokio::spawn({
            let notifier = notifier.clone();
            async move { notifier.run(rx, ctx_rx).await }
        });

        notifier
            .notify(Notification {
                sender: "10086".into(),
                content: "验证码 4321".into(),
                kind: NotifyKind::Sms,
                memory_full: false,
                qq_card: None,
                time: "2026-10-11 23:20:00".into(),
            })
            .await;

        let raw = tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .expect("短信应实时直发，不该走攒批入队路径")
            .expect("接收任务不应 panic");
        assert!(
            raw.contains("实时|10086|验证码 4321"),
            "实时推送的短信内容不符合模板: {raw}"
        );
    }

    #[tokio::test]
    async fn call_is_sent_immediately_bypassing_merge_window() {
        let (port, server) = one_shot_webhook().await;

        let mut cfg = webhook_only_cfg(port);
        cfg.templates.prefix = String::new();
        cfg.templates.call = "来电实时|{content}".into();

        let (notifier, rx) = Notifier::new(cfg);
        let notifier = std::sync::Arc::new(notifier);
        let (_ctx_tx, ctx_rx) = tokio::sync::watch::channel(false);
        tokio::spawn({
            let notifier = notifier.clone();
            async move { notifier.run(rx, ctx_rx).await }
        });

        notifier
            .notify(Notification {
                sender: SENDER_CALL.into(),
                content: "13800138000 来电".into(),
                kind: NotifyKind::Call,
                memory_full: false,
                qq_card: None,
                time: "2026-10-11 23:21:00".into(),
            })
            .await;

        let raw = tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .expect("来电应实时直发，不该走攒批入队路径")
            .expect("接收任务不应 panic");
        assert!(
            raw.contains("来电实时|13800138000 来电"),
            "实时推送的来电内容不符合模板: {raw}"
        );
    }

    /// 信号类事件同样立即直发：攒批合并已在 v1.14.20 移除，
    /// 信号由巡检与定时推送两条周期线产生，本来就不会高频刷屏，
    /// 没有理由再压着它等窗口结束。
    #[tokio::test]
    async fn signal_is_sent_immediately() {
        let (port, server) = one_shot_webhook().await;

        let mut cfg = webhook_only_cfg(port);
        cfg.templates.prefix = String::new();
        cfg.templates.signal = "巡检|{content}".into();

        let (notifier, rx) = Notifier::new(cfg);
        let notifier = std::sync::Arc::new(notifier);
        let (_ctx_tx, ctx_rx) = tokio::sync::watch::channel(false);
        tokio::spawn({
            let notifier = notifier.clone();
            async move { notifier.run(rx, ctx_rx).await }
        });

        notifier
            .notify(Notification {
                sender: SENDER_SIGNAL.into(),
                content: "RSRP -95 dBm".into(),
                kind: NotifyKind::Signal,
                memory_full: false,
                qq_card: None,
                time: "2026-10-11 23:22:00".into(),
            })
            .await;

        let raw = tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("信号事件应立即直发，不再走攒批")
            .expect("接收任务不应 panic");
        assert!(
            raw.contains("巡检|RSRP -95 dBm"),
            "信号内容不符合模板: {raw}"
        );
    }

    /// 类型化测试推送（短信）：走的是真实事件的完整链路，所以渲染结果必须与
    /// 真实短信一字不差 —— 这正是它存在的意义，也是它与「通道连通性测试」的区别。
    #[tokio::test]
    async fn test_event_sms_renders_real_template() {
        let (port, server) = one_shot_webhook().await;

        let mut cfg = webhook_only_cfg(port);
        cfg.templates.prefix = String::new();
        cfg.templates.sms = "短信|{sender}|{content}".into();

        let (notifier, rx) = Notifier::new(cfg);
        let notifier = std::sync::Arc::new(notifier);
        let (_ctx_tx, ctx_rx) = tokio::sync::watch::channel(false);
        tokio::spawn({
            let notifier = notifier.clone();
            async move { notifier.run(rx, ctx_rx).await }
        });

        notifier
            .notify_test_event(NotifyKind::Sms)
            .await
            .expect("短信测试推送应成功");

        let raw = tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .expect("短信测试推送应实时直发，不该走攒批")
            .expect("接收任务不应 panic");
        assert!(
            raw.contains(&format!("短信|{TEST_SENDER_NUMBER}|{TEST_SMS_CONTENT}")),
            "测试短信应套用真实短信模板（含虚号与正文占位符）: {raw}"
        );
    }

    /// 类型化测试推送（来电）：与真实来电一样实时直发，且正文携带号码与振铃状态。
    #[tokio::test]
    async fn test_event_call_is_realtime_and_carries_number() {
        let (port, server) = one_shot_webhook().await;

        let mut cfg = webhook_only_cfg(port);
        cfg.templates.prefix = String::new();
        cfg.templates.call = "来电|{content}".into();

        let (notifier, rx) = Notifier::new(cfg);
        let notifier = std::sync::Arc::new(notifier);
        let (_ctx_tx, ctx_rx) = tokio::sync::watch::channel(false);
        tokio::spawn({
            let notifier = notifier.clone();
            async move { notifier.run(rx, ctx_rx).await }
        });

        notifier
            .notify_test_event(NotifyKind::Call)
            .await
            .expect("来电测试推送应成功");

        let raw = tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .expect("来电测试推送应实时直发，不该走攒批")
            .expect("接收任务不应 panic");
        assert!(
            raw.contains("来电|时间：") && raw.contains(TEST_SENDER_NUMBER) && raw.contains("来电振铃"),
            "测试来电正文结构应与真实来电一致（时间/号码/状态）: {raw}"
        );
    }

    /// 开关未开启时必须**报错**而不是返回成功。
    ///
    /// 这是本方法最关键的契约：`notify()` 在关闭时是静默 return 的，若照直调用后
    /// 返回 Ok，界面会显示「发送成功」而手机毫无动静 —— 发送侧全绿、接收侧全无，
    /// 是最难排查的一类失败。四种「发不出去」的原因必须各自可辨。
    #[tokio::test]
    async fn test_event_explains_why_nothing_would_be_sent() {
        // 1) 总开关关闭
        let mut cfg = webhook_only_cfg(1);
        cfg.enabled = false;
        let (notifier, _rx) = Notifier::new(cfg);
        let err = notifier
            .notify_test_event(NotifyKind::Sms)
            .await
            .expect_err("总开关关闭时不应返回成功");
        assert!(err.contains("总开关"), "错误应指明总开关: {err}");

        // 2) 该事件类型的开关关闭
        let mut cfg = webhook_only_cfg(1);
        cfg.types.sms = false;
        let (notifier, _rx) = Notifier::new(cfg);
        let err = notifier
            .notify_test_event(NotifyKind::Sms)
            .await
            .expect_err("短信开关关闭时不应返回成功");
        assert!(
            err.contains("新短信") && err.contains("开关"),
            "错误应指明是哪一类的开关: {err}"
        );

        // 3) 一个可用通道都没有
        let mut cfg = webhook_only_cfg(1);
        cfg.wechat_webhook = String::new();
        let (notifier, _rx) = Notifier::new(cfg);
        let err = notifier
            .notify_test_event(NotifyKind::Sms)
            .await
            .expect_err("没有通道时不应返回成功");
        assert!(err.contains("推送通道"), "错误应指明没有可用通道: {err}");

        // 4) 不支持的事件类型（信号靠定时推送与真实巡检验证，不造假读数）
        let cfg = webhook_only_cfg(1);
        let (notifier, _rx) = Notifier::new(cfg);
        let err = notifier
            .notify_test_event(NotifyKind::Signal)
            .await
            .expect_err("信号不应支持类型化测试推送");
        assert!(err.contains("不支持测试推送"), "错误应说明类型不受支持: {err}");
    }
}
