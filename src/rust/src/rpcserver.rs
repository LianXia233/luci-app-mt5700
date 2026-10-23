//! LuCI RPC 服务：TCP newline-JSON（127.0.0.1:8765），由 rpcd ucode 插件（mt5700.uc）代理转发。
//! 核心业务逻辑（伪命令/扫频/命令分发/事件总线）均在此实现。
//!
//! 协议（每行一个 JSON 对象）：
//!   请求: {"id":1,"method":"at","params":{"cmd":"AT+CSQ","auth_key":"..."}}
//!   请求: {"id":2,"method":"events","params":{"since":12,"auth_key":"..."}}
//!   应答: {"id":1,"result":{"success":true,"data":"..."}}
//!   应答: {"id":2,"result":{"seq":18,"events":[{"type":"raw_data","data":"..."}]}}
//!   错误: {"id":1,"error":{"code":-1,"message":"..."}}
//!
//! 另支持方法：logs / task_status / task_cancel / task_list。
//! 事件不主动推送：前端通过 events(since) 拉取增量（LuCI RPC 为请求-响应模型）。

use crate::{log_debug, log_error, log_info, log_warn};
use crate::async_runtime::{TaskInfo, TaskManager};
use crate::atclient::AtClient;
use crate::schedconfig::{SCHED_QUERY_COMMAND, SCHED_RESPONSE_PREFIX, SCHED_SET_PREFIX, SchedConfigDto, dto_to_schedule, schedule_to_dto, write_schedule_uci};
use crate::schedule::Scheduler;
use crate::state::StateCache;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::io::AsyncRead;
use tokio::net::TcpStream;
use tokio::sync::Mutex as AsyncMutex;

const RPC_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// RPC 请求行长度上限（防异常长行撑爆内存）。
const MAX_RPC_LINE: usize = 8192;
const CELLSCAN_ABORT_TOKEN: &str = "abcd";
const DEFAULT_SCAN_TIMEOUT: Duration = Duration::from_secs(180);

/// 发给前端的命令应答，字段名与前端约定严格一致。
#[derive(Serialize)]
pub struct AtCommandResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 短信存储用量 → 前端 JSON。
fn storage_json(s: &crate::sms::StorageInfo) -> serde_json::Value {
    serde_json::json!({
        "used": s.used,
        "total": s.total,
        "mem1": s.mem1,
        "mem2": s.mem2,
        "mem3": s.mem3,
    })
}

/// 扫频进行中的状态快照（供 cellscan 进度查询与并发保护）。
pub struct ScanState {
    pub running: bool,
    pub aborted: bool,
    pub lines: Vec<String>,
}

/// 事件总线：向所有订阅客户端广播。
/// 推送类型（urc_data/new_sms/incoming_call/pdcp_data/cellscan/raw_data）
/// 按序入队并分配单调递增 seq；前端轮询 events(since) 拉取增量。
#[derive(Clone)]
pub struct Hub {
    bus: Arc<EventBus>,
}

pub struct EventBus {
    seq: AtomicU64,
    events: Mutex<VecDeque<(u64, serde_json::Value)>>,
    max: usize,
}

impl EventBus {
    fn new(max: usize) -> EventBus {
        EventBus { seq: AtomicU64::new(0), events: Mutex::new(VecDeque::new()), max }
    }

    fn push(&self, value: serde_json::Value) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let mut q = self.events.lock().unwrap_or_else(|e| e.into_inner());
        q.push_back((seq, value));
        while q.len() > self.max {
            q.pop_front();
        }
    }

    /// 返回 (当前最新 seq, 自 since 之后的事件列表)。
    fn since(&self, since: u64) -> (u64, Vec<serde_json::Value>) {
        let q = self.events.lock().unwrap_or_else(|e| e.into_inner());
        let seq = self.seq.load(Ordering::Relaxed);
        let events = q.iter().filter(|(s, _)| *s > since).map(|(_, v)| v.clone()).collect();
        (seq, events)
    }
}

impl Hub {
    pub fn new() -> Hub {
        Hub { bus: Arc::new(EventBus::new(500)) }
    }

    /// 完整推送对象入队（调用方传入 {type,data}）。
    pub fn broadcast(&self, msg: &serde_json::Value) {
        self.bus.push(msg.clone());
    }

    pub fn broadcast_json(&self, type_: &str, data: serde_json::Value) {
        self.bus.push(serde_json::json!({ "type": type_, "data": data }));
    }
}

/// RPC 请求（每行一个 JSON）。
#[derive(Deserialize)]
struct RpcRequest {
    id: serde_json::Value,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

pub struct RpcServer {
    client: Arc<AtClient>,
    auth_key: String,
    sched: Arc<Scheduler>,
    hub: Hub,
    scan: Arc<AsyncMutex<ScanState>>,
    scan_timeout: Duration,
    /// 异步状态缓存：只读状态查询优先命中内存，避免重复 AT 与排队阻塞。
    cache: Arc<StateCache>,
    /// 统一后台任务管理器。**目前只有扫频接入**（`spawn_with_timeout("cellscan", …)`，
    /// 因为只有它需要整体超时保护）；锁频与固件升级并不经由这里——锁频由
    /// `schedule` 自己的循环执行，固件升级走 ucode 的独立链路。
    /// 支持状态查询与取消，RPC handler 立即返回，不阻塞。
    tasks: Arc<TaskManager>,
    /// 通知器：notify_test 直发测试消息，验证推送通道链路。
    notify: Arc<crate::notify::Notifier>,
    /// 短信业务：列表/发送/删除/容量/存储/短信中心，全部实时走模组。
    sms: Arc<crate::sms::SmsService>,
    /// QQ 绑定进度（bind 模式时由绑定任务更新，qq_bind_status 读取；未设置则返回 idle）
    bind_status: Option<std::sync::Arc<crate::qqbind::BindStatus>>,
    /// 使用量后台统计器：`usage` / `usage_ctl` 读写的都是它。
    usage: Arc<crate::usage::UsageTracker>,
    /// 短信本地归档：`store_stats` / `store_read` / `store_drop` 读写的都是它。
    /// 为 `None` 时（例如只跑单测的场合）归档动作返回「未启用」。
    archive: Option<std::sync::Arc<crate::sms_store::SmsArchive>>,
    ctx: tokio::sync::watch::Receiver<bool>,
}

impl RpcServer {
    #[allow(clippy::too_many_arguments)] // 依赖随模块增长而增长，拆分收益低于可读性的损失
    pub fn new(
        client: Arc<AtClient>,
        auth_key: String,
        sched: Arc<Scheduler>,
        ctx: tokio::sync::watch::Receiver<bool>,
        cache: Arc<StateCache>,
        tasks: Arc<TaskManager>,
        notify: Arc<crate::notify::Notifier>,
        usage: Arc<crate::usage::UsageTracker>,
        sms: Arc<crate::sms::SmsService>,
    ) -> RpcServer {
        RpcServer {
            client,
            auth_key,
            sched,
            hub: Hub::new(),
            scan: Arc::new(AsyncMutex::new(ScanState { running: false, aborted: false, lines: Vec::new() })),
            scan_timeout: DEFAULT_SCAN_TIMEOUT,
            cache,
            tasks,
            ctx,
            notify,
            bind_status: None,
            usage,
            sms,
            archive: None,
        }
    }

    /// 注入 QQ 绑定进度句柄（main 在 spawn 绑定任务前调用）。
    pub fn set_bind_status(&mut self, s: std::sync::Arc<crate::qqbind::BindStatus>) {
        self.bind_status = Some(s);
    }

    /// 注入短信本地归档句柄（main 在建好归档目录后调用）。
    pub fn set_archive(&mut self, a: std::sync::Arc<crate::sms_store::SmsArchive>) {
        self.archive = Some(a);
    }

    pub fn hub(&self) -> Hub {
        self.hub.clone()
    }

    fn shallow_clone(&self) -> RpcServer {
        RpcServer {
            client: self.client.clone(),
            auth_key: self.auth_key.clone(),
            sched: self.sched.clone(),
            hub: self.hub.clone(),
            scan: self.scan.clone(),
            scan_timeout: self.scan_timeout,
            cache: self.cache.clone(),
            tasks: self.tasks.clone(),
            ctx: self.ctx.clone(),
            notify: self.notify.clone(),
            bind_status: self.bind_status.clone(),
            usage: self.usage.clone(),
            sms: self.sms.clone(),
            archive: self.archive.clone(),
        }
    }

    pub fn set_scan_timeout(&mut self, d: Duration) {
        if !d.is_zero() {
            self.scan_timeout = d;
        }
    }

    /// 绑定并服务 RPC，直到 ctx 结束。
    /// bind 默认 127.0.0.1；websocket_allow_wan=1 或 websocket_bind=0.0.0.0 时对外监听。
    pub async fn serve(&self, port: u16, bind: &str) -> Result<(), String> {
        let listener = tokio::net::TcpListener::bind((bind, port))
            .await
            .map_err(|e| format!("监听 RPC 端口 {bind}:{port} 失败: {e}"))?;
        log_info!("LuCI RPC 监听 {bind}:{port}");

        let mut ctx_c = self.ctx.clone();
        loop {
            tokio::select! {
                _ = ctx_c.changed() => return Ok(()),
                accepted = listener.accept() => {
                    let (stream, addr) = match accepted {
                        Ok(v) => v,
                        Err(e) => {
                            log_warn!("接受连接失败: {}", e);
                            continue;
                        }
                    };
                    let conn_server = self.shallow_clone();
                    tokio::spawn(async move {
                        if let Err(e) = conn_server.handle_connection(stream).await {
                            log_debug!("RPC 连接结束: {} ({})", addr, e);
                        }
                    });
                }
            }
        }
    }

    async fn handle_connection(&self, stream: TcpStream) -> Result<(), String> {
        let (read_half, mut write_half) = tokio::io::split(stream);
        let mut reader = BufReader::new(read_half);
        let mut ctx_c = self.ctx.clone();
        loop {
            let line = tokio::select! {
                _ = ctx_c.changed() => break,
                r = tokio::time::timeout(RPC_READ_TIMEOUT, read_line_limited(&mut reader, MAX_RPC_LINE)) => {
                    match r {
                        Ok(Ok(Some(line))) => line,
                        Ok(Ok(None)) => break,
                        _ => break,
                    }
                }
            };
            if line.1 {
                log_warn!("RPC 请求行过长 ({} bytes)，断开连接", line.0.len());
                break;
            }
            let line = line.0;
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let resp = self.handle_request(line).await;
            let payload = match serde_json::to_string(&resp) {
                Ok(p) => p,
                Err(e) => {
                    log_error!("序列化 RPC 应答失败: {}", e);
                    continue;
                }
            };
            let _ = tokio::time::timeout(Duration::from_secs(5), write_half.write_all(format!("{payload}\n").as_bytes())).await;
            let _ = write_half.flush().await;
        }
        Ok(())
    }

    async fn handle_request(&self, line: &str) -> serde_json::Value {
        let req: RpcRequest = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => {
                return serde_json::json!({ "id": null, "error": { "code": -32700, "message": format!("无效的 RPC 请求: {e}") } });
            }
        };
        let id = req.id;

        // 认证：配置了密钥时，每个请求必须携带匹配的 auth_key（rpcd ucode 代理从 UCI 读取并附加；
        // 页面登录态由 LuCI/rpcd 会话保证，密钥保持原配置语义兼容）。
        let key = req.params.get("auth_key").and_then(|v| v.as_str()).unwrap_or("");
        if !self.auth_key.is_empty() && key != self.auth_key {
            log_warn!("RPC 请求被拒绝: 密钥错误 (method={})", req.method);
            return serde_json::json!({ "id": id, "error": { "code": -32001, "message": "认证失败" } });
        }

        match req.method.as_str() {
            "at" => {
                let cmd = req.params.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
                if cmd.is_empty() {
                    return serde_json::json!({ "id": id, "error": { "code": -32602, "message": "缺少参数 cmd" } });
                }
                let resp = self.run_command(cmd).await;
                serde_json::json!({ "id": id, "result": {
                    "success": resp.success,
                    "data": resp.data,
                    "error": resp.error,
                } })
            }
            "events" => {
                let since = req.params.get("since").and_then(|v| v.as_u64()).unwrap_or(0);
                let (seq, events) = self.hub.bus.since(since);
                serde_json::json!({ "id": id, "result": { "seq": seq, "events": events } })
            }
            // 短信业务：列表/发送/删除/容量/存储/短信中心/前台优先会话。
            //
            // 与 `at` 通道的关键差别：这里的每个动作都是**一次真实的模组交互**，
            // 不经过状态缓存，也不返回任何历史快照；多步骤动作（发送分片、批量
            // 删除）在后端一次事务里跑完，期间其它 AT 命令拿不到通道。
            "sms" => {
                let action = req.params.get("action").and_then(|v| v.as_str()).unwrap_or("");
                self.handle_sms(&id, action, &req.params).await
            }
            // 通知通道测试（LuCI「发送测试通知」按钮）：绕过事件链路直发一条测试消息。
            // channel 分两组语义：
            //   qq / wechat —— 只测**通道连通性**（固定文案，不走事件链路）；
            //   sms / call  —— 测**某一类的完整链路**，构造同形状事件走 notify()，
            //                  收到的文本与真实短信/来电一致（含实时直发与文案模板）。
            // signal / memory_full 也交给类型化分支：它们不受支持，但理由必须说清楚
            // （信号指标是真实读数，造假的「RSRP -xx dBm」只会误导），而不是笼统的
            // 「未知通道」——后者会让人以为是拼错了名字，反复试。
            "notify_test" => {
                let channel = req.params.get("channel").and_then(|v| v.as_str()).unwrap_or("qq").to_string();
                let kind = match channel.as_str() {
                    "sms" => Some(crate::notify::NotifyKind::Sms),
                    "call" => Some(crate::notify::NotifyKind::Call),
                    "signal" => Some(crate::notify::NotifyKind::Signal),
                    "memory_full" => Some(crate::notify::NotifyKind::MemoryFull),
                    _ => None,
                };
                let result = match kind {
                    Some(k) => self.notify.notify_test_event(k).await,
                    None => self.notify.notify_test(&channel).await,
                };
                match result {
                    Ok(()) => serde_json::json!({ "id": id, "result": { "success": true, "channel": channel } }),
                    Err(e) => serde_json::json!({ "id": id, "result": { "success": false, "channel": channel, "error": e } }),
                }
            }
            // QQ 绑定进度（LuCI bind 模式轮询展示状态与倒计时）。
            "qq_bind_status" => {
                let s = self
                    .bind_status
                    .as_ref()
                    .map(|b| b.snapshot())
                    .unwrap_or_default();
                // waiting 状态计算倒计时剩余秒数；其余状态不适用
                let left = if s.state == "waiting" {
                    s.started
                        .map(|t| {
                            let elapsed = t.elapsed().as_secs();
                            crate::qqbind::BIND_WINDOW_SECS.saturating_sub(elapsed)
                        })
                        .unwrap_or(crate::qqbind::BIND_WINDOW_SECS)
                } else {
                    0
                };
                serde_json::json!({ "id": id, "result": {
                    "state": if s.state.is_empty() { "idle" } else { s.state.as_str() },
                    "left": left,
                    "target_type": s.target.as_ref().map(|t| t.target_type.as_str()).unwrap_or(""),
                    "target_id": s.target.as_ref().map(|t| t.target_id.as_str()).unwrap_or(""),
                    "error": s.error,
                } })
            }
            // QQ 自定义菜单（LuCI「配置 QQ 菜单」按钮）：set=覆盖配置默认菜单，
            // get=查询当前菜单。菜单仅 C2C 场景生效，见 qqpush 模块文档。
            "qq_menu" => {
                let action = req.params.get("action").and_then(|v| v.as_str()).unwrap_or("set").to_string();
                match self.notify.qq_menu(&action).await {
                    Ok(mut result) => {
                        result["success"] = serde_json::json!(true);
                        serde_json::json!({ "id": id, "result": result })
                    }
                    Err(e) => serde_json::json!({ "id": id, "result": { "success": false, "action": action, "error": e } }),
                }
            }
            // 后端运行日志（含被级别过滤掉的 info）：拨号对齐、串口探测、接口拉起协作、
            // URC 分发等过程都在这里，是 syslog 看不到的部分（稳态级别是 Warn）。
            "logs" => {
                let since = req.params.get("since").and_then(|v| v.as_u64()).unwrap_or(0);
                let limit = req
                    .params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(300)
                    .min(1200) as usize;
                let (seq, entries) = crate::logger::snapshot(since, limit);
                serde_json::json!({ "id": id, "result": { "seq": seq, "entries": entries } })
            }
            // 使用量统计快照：由后端常驻采样累加，与前端是否打开无关。
            "usage" => {
                let snap = self.usage.snapshot().await;
                serde_json::json!({ "id": id, "result": snap })
            }
            // 使用量控制：reset（清零，含落盘文件）/ persist_on / persist_off /
            // set_reset_day（改自动清零日 = 每月几号，写 UCI）。
            "usage_ctl" => {
                let action = req.params.get("action").and_then(|v| v.as_str()).unwrap_or("");
                let result = match action {
                    "reset" => Some(self.usage.reset().await),
                    "persist_on" => Some(self.usage.set_persist(true).await),
                    "persist_off" => Some(self.usage.set_persist(false).await),
                    // 每月几号清零：日期语义（大小月/闰年）由 crate::monthly 负责
                    "set_reset_day" => {
                        let day = req.params.get("day").and_then(|v| v.as_u64()).unwrap_or(0);
                        if let Err(e) = self.usage.set_reset_day(day as u32).await {
                            return serde_json::json!({ "id": id, "error": { "code": -32003, "message": e } });
                        }
                        // set_reset_day 内部已热更新内存值，snapshot 读到的就是新的清零日
                        Some(self.usage.snapshot().await)
                    }
                    _ => None,
                };
                match result {
                    Some(snap) => serde_json::json!({ "id": id, "result": snap }),
                    None => serde_json::json!({ "id": id, "error": { "code": -32602, "message": format!("未知的 usage_ctl 动作: {action}") } }),
                }
            }
            // 后台任务管理（异步化新增）：查询状态 / 取消 / 列表。
            // 不改变既有 at/events/logs 接口，前端仍通过 AT^CELLSCAN 伪命令触发扫频。
            "task_status" => {
                let tid = req.params.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if tid.is_empty() {
                    return serde_json::json!({ "id": id, "error": { "code": -32602, "message": "缺少参数 id" } });
                }
                match self.tasks.status(tid).await {
                    Some(info) => serde_json::json!({ "id": id, "result": { "id": info.id, "kind": info.kind, "state": info.state.as_str(), "progress": info.progress, "error": info.error, "result": info.result, "created_at": info.created_at, "started_at": info.started_at, "finished_at": info.finished_at } }),
                    None => serde_json::json!({ "id": id, "error": { "code": -32002, "message": format!("任务不存在: {tid}") } }),
                }
            }
            "task_cancel" => {
                let tid = req.params.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if tid.is_empty() {
                    return serde_json::json!({ "id": id, "error": { "code": -32602, "message": "缺少参数 id" } });
                }
                let cancelled = self.tasks.cancel(tid).await;
                if cancelled {
                    serde_json::json!({ "id": id, "result": { "cancelled": true, "id": tid } })
                } else {
                    serde_json::json!({ "id": id, "error": { "code": -32002, "message": format!("任务不存在: {tid}") } })
                }
            }
            "task_list" => {
                let list = self.tasks.list().await;
                let items: Vec<serde_json::Value> = list
                    .into_iter()
                    .map(|info: TaskInfo| serde_json::json!({
                        "id": info.id,
                        "kind": info.kind,
                        "state": info.state.as_str(),
                        "progress": info.progress,
                        "error": info.error,
                        "result": info.result,
                        "created_at": info.created_at,
                        "started_at": info.started_at,
                        "finished_at": info.finished_at,
                    }))
                    .collect();
                serde_json::json!({ "id": id, "result": { "tasks": items } })
            }
            _ => serde_json::json!({ "id": id, "error": { "code": -32601, "message": format!("未知方法: {}", req.method) } }),
        }
    }

    /// 短信业务入口。所有动作都实时下发 AT，不含任何缓存分支。
    async fn handle_sms(
        &self,
        id: &serde_json::Value,
        action: &str,
        params: &serde_json::Value,
    ) -> serde_json::Value {
        use crate::sms::SendRequest;

        fn ok(id: &serde_json::Value, result: serde_json::Value) -> serde_json::Value {
            serde_json::json!({ "id": id, "result": result })
        }
        fn err(id: &serde_json::Value, msg: impl Into<String>) -> serde_json::Value {
            serde_json::json!({ "id": id, "error": { "code": -32010, "message": msg.into() } })
        }

        // 会话租约：进入短信中心 / 执行短信操作前登记，页面退出或超时自动解除。
        // 它是「后台轮询暂停」的开关 —— 不登记就不会暂停，避免了误伤其它页面。
        match action {
            "session_open" => {
                let ttl = params.get("ttl_ms").and_then(|v| v.as_u64());
                let id2 = self.sms.session_open(ttl).await;
                return ok(id, serde_json::json!({ "session_id": id2, "ttl_ms": ttl.unwrap_or(crate::sms::SMS_MODE_LEASE.as_millis() as u64) }));
            }
            "session_renew" => {
                let sid = params.get("session_id").and_then(|v| v.as_u64()).unwrap_or(0);
                let ttl = params.get("ttl_ms").and_then(|v| v.as_u64());
                let renewed = self.sms.session_renew(sid, ttl).await;
                return ok(id, serde_json::json!({ "renewed": renewed, "sessions": self.sms.session_count().await }));
            }
            "session_release" => {
                let sid = params.get("session_id").and_then(|v| v.as_u64()).unwrap_or(0);
                self.sms.session_release(sid).await;
                return ok(id, serde_json::json!({ "released": true, "sessions": self.sms.session_count().await }));
            }
            _ => {}
        }

        // ============= 短信本地归档 =============
        //
        // 这三个动作只做文件读写，**不占用 AT 通道、不开短信事务** ——
        // 因此必须放在事务段之前，否则浏览归档会把模组通道堵住。
        match action {
            "store_stats" => {
                let Some(a) = self.archive.as_ref() else {
                    return err(id, "短信本地归档未启用");
                };
                let st = a.stats();
                let conversations: Vec<serde_json::Value> = st
                    .conversations
                    .iter()
                    .map(|c| {
                        serde_json::json!({
                            "number": c.number,
                            "count": c.count,
                            "bytes": c.bytes,
                            "updatedAtMs": c.updated_at_ms,
                    "lastContent": c.last_content,
                        })
                    })
                    .collect();
                return ok(id, serde_json::json!({
                    "dir": st.dir,
                    "totalBytes": st.total_bytes,
                    "maxBytes": st.max_bytes,
                    "conversations": conversations,
                }));
            }
            "store_read" => {
                let Some(a) = self.archive.as_ref() else {
                    return err(id, "短信本地归档未启用");
                };
                let number = params.get("number").and_then(|v| v.as_str()).unwrap_or("");
                if number.is_empty() {
                    return err(id, "缺少参数 number");
                }
                return match a.read(number) {
                    Ok(recs) => {
                        let entries: Vec<serde_json::Value> = recs
                            .iter()
                            .map(|r| {
                                serde_json::json!({
                                    "fingerprint": r.fingerprint,
                                    "direction": r.direction,
                                    "number": r.number,
                                    "content": r.content,
                                    "time": r.time,
                                    "timeApprox": r.time_approx,
                                    "index": r.index,
                                    "archivedAtMs": r.archived_at_ms,
                                })
                            })
                            .collect();
                        ok(id, serde_json::json!({ "entries": entries }))
                    }
                    Err(e) => err(id, e),
                };
            }
            "store_drop" => {
                let Some(a) = self.archive.as_ref() else {
                    return err(id, "短信本地归档未启用");
                };
                let number = params
                    .get("number")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let all = params.get("all").and_then(|v| v.as_bool()).unwrap_or(false);

                let mut fingerprints = Vec::new();
                let indices: Vec<u32> = params
                    .get("indices")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|v| v.as_u64()).map(|v| v as u32).collect())
                    .unwrap_or_default();

                /*
                 * `items: [{ direction, content, time }]` 只传原始字段，
                 * 指纹由**后端**按 `方向|号码|时间|正文` 计算 ——
                 * 前端因此不必自己实现一次 SHA-256，两处口径也不会走偏。
                 */
                if let Some(items) = params.get("items").and_then(|v| v.as_array()) {
                    for it in items {
                        let d = it.get("direction").and_then(|v| v.as_str()).unwrap_or("");
                        let c = it.get("content").and_then(|v| v.as_str()).unwrap_or("");
                        let t = it.get("time").and_then(|v| v.as_str());
                        let n = it.get("number").and_then(|v| v.as_str()).unwrap_or(&number);
                        fingerprints.push(crate::sms_store::fingerprint(d, n, t, c));
                    }
                }

                if all {
                    match a.purge() {
                        Ok((n, freed)) => {
                            return ok(id, serde_json::json!({
                                "scope": "all",
                                "dropped": n,
                                "freedBytes": freed,
                                "totalBytes": a.total_bytes(),
                                "maxBytes": a.max_bytes(),
                            }));
                        }
                        Err(e) => return err(id, e),
                    }
                }

                /*
                 * 只给了号码、没给任何命中线索 → 整个会话的归档一起删。
                 * 界面上「清空该会话」走这条路；按条删除则走下面的 remove_records。
                 */
                if fingerprints.is_empty() && indices.is_empty() {
                    if number.is_empty() {
                        return err(id, "缺少参数：需要 number，或 all=true");
                    }
                    return match a.drop_conversation(&number) {
                        Ok(freed) => ok(id, serde_json::json!({
                            "scope": "conversation",
                            "dropped": 1,
                            "freedBytes": freed,
                            "totalBytes": a.total_bytes(),
                            "maxBytes": a.max_bytes(),
                        })),
                        Err(e) => err(id, e),
                    };
                }

                match a.remove_records(
                    &number,
                    &crate::sms_store::RecordSelector { fingerprints, indices },
                ) {
                    Ok((removed, touched)) => {
                        return ok(id, serde_json::json!({
                            "scope": "records",
                            "dropped": removed,
                            "touched": touched,
                            "totalBytes": a.total_bytes(),
                            "maxBytes": a.max_bytes(),
                        }));
                    }
                    Err(e) => return err(id, e),
                }
            }
            _ => {}
        }

        // 以下都是「短信事务」级操作：全程独占通道，且享有最高优先级。
        let result = match action {
            "list" => match self.sms.list().await {
                Ok(r) => {
                    let entries: Vec<serde_json::Value> = r
                        .entries
                        .iter()
                        .map(|e| {
                            serde_json::json!({
                                "index": e.index,
                                "stat": e.stat,
                                "direction": e.direction,
                                "number": e.number,
                                "content": e.content,
                                "time": e.time,
                                "timeApprox": e.time_approx,
                                "concat": e.concat.as_ref().map(|c| serde_json::json!({
                                    "reference": c.reference,
                                    "partsCount": c.parts_count,
                                    "partNumber": c.part_number,
                                })),
                                "error": e.error,
                            })
                        })
                        .collect();
                    ok(id, serde_json::json!({
                        "entries": entries,
                        "fetchedAt": r.fetched_at_ms,
                        "totalLines": r.total_lines,
                    }))
                }
                Err(e) => err(id, e),
            },
            "send" => {
                let destination = params.get("destination").and_then(|v| v.as_str()).unwrap_or("");
                let message = params.get("message").and_then(|v| v.as_str()).unwrap_or("");
                let smsc = params
                    .get("smsc")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let dedup = params
                    .get("dedup_key")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                match self.sms.send(SendRequest { destination: destination.to_string(), message: message.to_string(), smsc, dedup_key: dedup }).await {
                    Ok(r) => ok(id, serde_json::json!({
                        "outcome": r.outcome.as_str(),
                        "encoding": r.encoding,
                        "message": r.message,
                        "parts": r.parts.iter().map(|p| serde_json::json!({
                            "partNumber": p.part_number,
                            "partsCount": p.parts_count,
                            "outcome": p.outcome.as_str(),
                            "detail": p.detail,
                        })).collect::<Vec<_>>(),
                        "storage": r.storage.as_ref().map(storage_json),
                    })),
                    Err(e) => err(id, e),
                }
            }
            "delete" => {
                let indices: Vec<u32> = params
                    .get("indices")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|v| v.as_u64()).map(|v| v as u32).collect())
                    .unwrap_or_default();
                match self.sms.delete(indices).await {
                    Ok(r) => ok(id, serde_json::json!({
                        "requested": r.requested,
                        "deleted": r.deleted,
                        "failed": r.failed,
                        "storage": r.storage.as_ref().map(storage_json),
                    })),
                    Err(e) => err(id, e),
                }
            }
            "purge" => match self.sms.purge_all().await {
                Ok(r) => ok(id, serde_json::json!({
                    "requested": r.requested,
                    "deleted": r.deleted,
                    "errors": r.errors,
                    "storage": r.storage.as_ref().map(storage_json),
                })),
                Err(e) => err(id, e),
            },
            "capacity" => match self.sms.capacity().await {
                Ok(s) => ok(id, serde_json::json!({
                    "storage": storage_json(&s),
                    /* 模组告知过「存储已满」且尚未回落。注意：**当前界面并不读这个键**
                     * （sms_center / sms_settings 的容量提示只看 storage 里的 used/total），
                     * 保留给直连 RPC 的调用方；要界面提示得前端一并接。 */
                    "memFull": self.sms.memory_full(),
                })),
                Err(e) => err(id, e),
            },
            "set_storage" => {
                let mem = params.get("mem").and_then(|v| v.as_str()).unwrap_or("");
                match self.sms.set_storage(mem).await {
                    Ok(s) => ok(id, serde_json::json!({ "storage": storage_json(&s) })),
                    Err(e) => err(id, e),
                }
            }
            "get_smsc" => match self.sms.get_smsc().await {
                Ok(n) => ok(id, serde_json::json!({ "smsc": n })),
                Err(e) => err(id, e),
            },
            // 短信功能开关（读 CEUS → 必要时 CEUS/CFUN 重启 → IMSSWITCH → 可选 CSCA）
            // 与 IMS 开关。两者都是「会改变模组状态」的操作，同样必须独占通道跑完。
            "power" => {
                let enable = match params.get("enable").and_then(|v| v.as_bool()) {
                    // 类型不对就报错：这里 default 成 false 等于「点开启、得到关闭」，
                    // 而关闭与开启做的是完全不同的事（关 IMS vs 重启射频）。
                    Some(v) => v,
                    None => return err(id, "enable 必须为布尔值（true/false）"),
                };
                let smsc = params
                    .get("smsc")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                match self.sms.power_set(enable, smsc).await {
                    Ok(r) => ok(id, serde_json::json!({
                        "enabled": r.enabled,
                        "stepsDone": r.steps_done,
                        "failedAt": r.failed_at,
                        "failedDetail": r.failed_detail,
                        "smsc": r.smsc,
                        "storage": r.storage.as_ref().map(storage_json),
                    })),
                    Err(e) => err(id, e),
                }
            }
            "set_ims" => {
                let enable = match params.get("enable").and_then(|v| v.as_bool()) {
                    Some(v) => v,
                    None => return err(id, "enable 必须为布尔值（true/false）"),
                };
                match self.sms.ims_set(enable).await {
                    Ok(()) => ok(id, serde_json::json!({ "enabled": enable })),
                    Err(e) => err(id, e),
                }
            }
            "get_ims" => match self.sms.ims_state().await {
                Ok(v) => ok(id, serde_json::json!({ "enabled": v })),
                Err(e) => err(id, e),
            },
            "set_smsc" => {
                let number = params.get("smsc").and_then(|v| v.as_str()).unwrap_or("");
                match self.sms.set_smsc(number).await {
                    Ok(n) => ok(id, serde_json::json!({ "smsc": n })),
                    Err(e) => err(id, e),
                }
            }
            other => err(id, format!("未知短信动作: {other}")),
        };
        result
    }

    /// 把前端发来的字符串当作 AT 命令执行并整理成应答。
    pub async fn run_command(&self, command: &str) -> AtCommandResponse {
        log_debug!("前端请求: {}", command.trim());

        // AT+CONNECT? 不是真的 AT 命令，用来让前端知道当前走网络还是串口。
        if command.trim() == "AT+CONNECT?" {
            let kind = if self.client.connection_type() == "SERIAL" { "1" } else { "0" };
            return ok_response(&format!("+CONNECT: {kind}\r\nOK"));
        }

        // AT+SCHED? / AT+SCHED= 同样不是真命令，用来读写定时锁频配置。
        if let Some(resp) = self.handle_schedule_command(command).await {
            return resp;
        }

        // 扫频要跑几分钟，单独走异步通路。
        if let Some(resp) = self.handle_cell_scan_command(command).await {
            return resp;
        }

        if self.scan_in_progress().await {
            return err_response("正在扫频，模组暂时无法响应其它命令，请先取消扫频");
        }

        let command = normalize_syscfgex(command);

        // 状态缓存优先：白名单内的只读查询命中内存即毫秒级返回，下发 AT 的去重、
        // 刷新与断线失效都由缓存负责。miss / 非白名单 / 抓取失败一律走 live 路径，
        // 保证终端页手动执行同一条查询也能拿到真实结果。
        match self.cache.resolve(&command).await {
            Ok(Some(text)) => {
                log_debug!("缓存命中: {}", command.trim());
                return ok_response(&text);
            }
            _ => {}
        }

        // 短信提交单独给足预算：`AT+CMGS=<长度>` 后面带 PDU 时，要把 TPDU 交给网络侧，
        // 回 `+CMGS` 的耗时取决于信号与基站排队，弱信号下好几秒甚至十几秒。
        // 其余命令仍按 2 秒算 —— 不能因为短信把整页的失败检测一起拖慢。
        //
        // 判据复用 [atclient::is_single_shot_cmgs]，与读循环里「不能被 `> ` 提前结束」
        // 是同一个判断：字面 `\r`（业务路径与厂商形态）与真 CR（终端页手敲）都算。
        // 只报长度的那一半（`AT+CMGS=14`，两种分隔符都没有）仍走短超时，它只等提示符。
        let is_sms_submit = crate::atclient::is_single_shot_cmgs(&command);
        let cmd_timeout = if is_sms_submit {
            crate::atclient::SMS_SUBMIT_TIMEOUT
        } else {
            crate::atclient::COMMAND_TIMEOUT
        };
        if is_sms_submit {
            log_info!("短信提交：等待模组回执，预算 {}s", cmd_timeout.as_secs());
        }

        // 外层超时 = 排队预算 + 应答预算 + 余量。
        // 排队预算单独给足，避免初始化/重连期间用户的终端命令被外层提前掐断，
        // 从而出现「模组无响应」的假失败（终端页只有 ATI 有回复的根因）。
        let result = tokio::time::timeout(
            crate::atclient::QUEUE_WAIT_TIMEOUT + cmd_timeout + Duration::from_secs(3),
            // 用户主动的 AT 操作属于 High 优先级，可越过后台刷新的 Low/Background。
            self.client.send_command_pri(
                &self.ctx,
                crate::at_queue::AtPriority::High,
                &command,
                cmd_timeout,
                None,
            ),
        )
        .await;

        match result {
            Ok(Ok(resp)) => {
                let text = resp.text();
                if resp.has_error() {
                    return AtCommandResponse { success: false, data: None, error: Some(text) };
                }
                AtCommandResponse { success: true, data: Some(text), error: None }
            }
            Ok(Err(e)) => {
                log_debug!("AT 命令失败: {} -> {}", command.trim(), e);
                AtCommandResponse { success: false, data: None, error: Some(e) }
            }
            Err(_) => AtCommandResponse { success: false, data: None, error: Some("命令执行超时".into()) },
        }
    }

    async fn handle_schedule_command(&self, command: &str) -> Option<AtCommandResponse> {
        let trimmed = command.trim();

        if trimmed == SCHED_QUERY_COMMAND {
            let mut dto = schedule_to_dto(&self.sched.config().await);
            dto.status = Some(self.sched.status().await);
            let payload = match serde_json::to_string(&dto) {
                Ok(p) => p,
                Err(e) => return Some(err_response(&format!("序列化定时锁频配置失败: {e}"))),
            };
            return Some(AtCommandResponse {
                success: true,
                data: Some(format!("{SCHED_RESPONSE_PREFIX}{payload}\r\nOK")),
                error: None,
            });
        }

        if let Some(rest) = trimmed.strip_prefix(SCHED_SET_PREFIX) {
            let dto: SchedConfigDto = match serde_json::from_str(rest.trim()) {
                Ok(d) => d,
                Err(e) => return Some(err_response(&format!("定时锁频配置不是有效的 JSON: {e}"))),
            };
            if let Err(e) = dto.validate() {
                return Some(err_response(&e));
            }
            if let Err(e) = write_schedule_uci(&dto).await {
                return Some(err_response(&e));
            }
            self.sched.set_config(dto_to_schedule(&dto)).await;
            log_info!(
                "定时锁频配置已由 WebUI 更新: 启用={} 夜间={} 日间={}",
                dto.enabled,
                dto.night.enabled,
                dto.day.enabled
            );
            return Some(AtCommandResponse {
                success: true,
                data: Some(format!("{SCHED_RESPONSE_PREFIX}OK\r\nOK")),
                error: None,
            });
        }

        None
    }

    // ============= 小区扫频 =============

    fn is_cell_scan(command: &str) -> bool {
        command.trim().to_uppercase().starts_with("AT^CELLSCAN")
    }

    fn is_cell_scan_abort(command: &str) -> bool {
        command.trim().eq_ignore_ascii_case("AT^CELLSCAN=ABORT")
    }

    fn is_cell_scan_state(command: &str) -> bool {
        command.trim().eq_ignore_ascii_case("AT^CELLSCAN=STATE")
    }

    async fn handle_cell_scan_command(&self, command: &str) -> Option<AtCommandResponse> {
        if Self::is_cell_scan_state(command) {
            return Some(self.cell_scan_state().await);
        }
        if Self::is_cell_scan_abort(command) {
            return Some(self.abort_cell_scan().await);
        }
        if Self::is_cell_scan(command) {
            return Some(self.start_cell_scan(command).await);
        }
        None
    }

    async fn cell_scan_state(&self) -> AtCommandResponse {
        let scan = self.scan.lock().await;
        let (running, count) = (scan.running, scan.lines.len());
        drop(scan);
        if !running {
            return ok_response("^CELLSCAN: IDLE\r\nOK");
        }
        ok_response(&format!("^CELLSCAN: RUNNING,{count}\r\nOK"))
    }

    async fn start_cell_scan(&self, command: &str) -> AtCommandResponse {
        let mut scan = self.scan.lock().await;
        if scan.running {
            return err_response("扫频正在进行中，请先取消");
        }
        scan.running = true;
        scan.aborted = false;
        scan.lines.clear();
        drop(scan);

        // 后台异步执行扫频，让 RPC 读循环空出来接收打断命令。
        // 同时登记进 TaskManager，可获得 task_id / 状态 / 取消（AT^CELLSCAN=ABORT
        // 撤下 AT 打断字符串，取消则经由 CancellationToken 让任务体自行收尾）。
        let client = self.client.clone();
        let hub = self.hub.clone();
        let tasks = self.tasks.clone();
        let scan_state = self.scan.clone();
        // scan_timeout 恒为正：new() 取 DEFAULT，set_scan_timeout() 显式忽略零值，
        // 唯一外部来源 main.rs 传 config.scan_timeout，而 config 已按下限 10s 夹取。
        let timeout = self.scan_timeout;
        let ctx = self.ctx.clone();
        let command = command.trim().to_string();
        let tid = tasks
            .spawn_with_timeout("cellscan", timeout, move |cancel: tokio::sync::watch::Receiver<bool>| async move {
                run_cell_scan(client, hub, scan_state, ctx, cancel, command, timeout).await
            })
            .await;

        // 立刻应答，让前端的命令队列不被这条几分钟的命令堵住。
        ok_response(&format!("^CELLSCAN: STARTED {tid}\r\nOK"))
    }

    async fn scan_in_progress(&self) -> bool {
        self.scan.lock().await.running
    }

    async fn abort_cell_scan(&self) -> AtCommandResponse {
        // 全程持锁：扫频若在"判断还在跑"和"写打断字符串"之间正好结束，
        // abcd 就会插进下一条命令的数据流里。
        let mut scan = self.scan.lock().await;
        if !scan.running {
            return err_response("当前没有正在进行的扫频");
        }
        match self.client.interrupt(CELLSCAN_ABORT_TOKEN).await {
            Ok(()) => {
                scan.aborted = true;
                log_info!("已下发扫频打断字符串");
                ok_response("OK")
            }
            Err(e) => err_response(&format!("打断扫频失败: {e}")),
        }
    }
}

async fn run_cell_scan(
    client: Arc<AtClient>,
    hub: Hub,
    scan_state: Arc<AsyncMutex<ScanState>>,
    ctx: tokio::sync::watch::Receiver<bool>,
    mut cancel: tokio::sync::watch::Receiver<bool>,
    command: String,
    timeout: Duration,
) -> Result<String, String> {
    log_info!("开始扫频: {} (超时 {}s)", command, timeout.as_secs());

    // 扫频前断开蜂窝数据：模组在数据业务激活时拒绝 ^CELLSCAN（+CME ERROR: operation not allowed）。
    // scan_active 置位让 autodial_watchdog 暂停对账，避免它把「扫频导致的未就绪」误判为故障抢先重拨、
    // 与下方恢复逻辑争用 CID。prior 快照记录断连前的真实状态，结束后无条件恢复。
    client.set_scan_active(true);
    let prior = client.prepare_scan_data_plane(&ctx).await;

    let scan_state_stream = scan_state.clone();
    let hub_stream = hub.clone();
    let mut ctx_scan = ctx.clone();
    let long =
        client.send_long_command(
            &ctx,
            &command,
            timeout,
            Some(Box::new(move |line: String| {
                let line = line.trim().to_string();
                if !line.starts_with("^CELLSCAN:") {
                    return;
                }
                // 同步闭包内不能 await，也不能 blocking_lock（会在运行时 panic）。
                // 用 try_lock：拿不到锁就跳过本次推送，下一条 ^CELLSCAN 行会再触发。
                let Ok(mut scan) = scan_state_stream.try_lock() else {
                    return;
                };
                scan.lines.push(line.clone());
                let count = scan.lines.len();
                drop(scan);
                hub_stream.broadcast_json(
                    "cellscan",
                    serde_json::json!({ "state": "running", "cell": line, "count": count }),
                );
            })),
        );
    let outer = tokio::time::timeout(timeout + Duration::from_secs(10), long);
    let mut outer = std::pin::pin!(outer);

    let result = tokio::select! {
        r = &mut outer => r,
        // 任务取消（task_cancel）：撤下 AT 打断字符串，让模组尽早停止扫频。
        _ = cancel.changed() => {
            log_warn!("扫频被取消，下发打断字符串");
            let _ = client.interrupt(CELLSCAN_ABORT_TOKEN).await;
            // 等待底层长命令收尾，尽量拿到已扫到的小区。
            outer.await
        }
        // 全局关闭：同样打断，避免扫频卡住优雅退出。
        _ = ctx_scan.changed() => {
            log_warn!("服务退出，扫频中断");
            let _ = client.interrupt(CELLSCAN_ABORT_TOKEN).await;
            outer.await
        }
    };

    // running 必须无条件复位：万一出了意外还留着 true，
    // 之后所有 AT 命令都会被"正在扫频"挡住，只能重启服务才能恢复。
    // run_cell_scan 本身是异步任务，直接用 async lock（禁止 blocking_lock）。
    let mut scan = scan_state.lock().await;
    let lines = scan.lines.clone();
    let aborted = scan.aborted;
    scan.running = false;
    scan.aborted = false;
    scan.lines.clear();
    drop(scan);

    // 扫频结束（成功/失败/超时/取消均必经此处）：先复位扫频标志，再无条件恢复数据面。
    // 恢复失败仅记 WRN 日志，由 autodial_watchdog 周期对账兜底，不会长期断网。
    client.set_scan_active(false);
    client.restore_scan_data_plane(&ctx, &prior).await;

    let count = lines.len();
    match result {
        Ok(Ok(resp)) if !resp.has_error() => {
            let state = if aborted { "aborted" } else { "done" };
            log_info!("扫频结束({}): 共 {} 个小区", state, count);
            hub.broadcast_json("cellscan", serde_json::json!({ "state": state, "lines": lines, "count": count }));
            Ok(format!("{state}:{}", count))
        }
        Ok(Ok(resp)) => {
            let text = resp.text();
            log_warn!("扫频被模组拒绝: {}", text);
            hub.broadcast_json(
                "cellscan",
                serde_json::json!({ "state": "error", "error": text, "lines": lines, "count": count }),
            );
            Err(text)
        }
        Ok(Err(e)) => {
            log_warn!("扫频失败: {}", e);
            hub.broadcast_json(
                "cellscan",
                serde_json::json!({ "state": "error", "error": e, "lines": lines, "count": count }),
            );
            Err(e)
        }
        Err(_) => {
            log_warn!("扫频超时");
            hub.broadcast_json(
                "cellscan",
                serde_json::json!({ "state": "error", "error": "扫频超时", "lines": lines, "count": count }),
            );
            Err("扫频超时".to_string())
        }
    }
}

pub fn ok_response(data: &str) -> AtCommandResponse {
    AtCommandResponse { success: true, data: Some(data.to_string()), error: None }
}

pub fn err_response(msg: &str) -> AtCommandResponse {
    AtCommandResponse { success: false, data: None, error: Some(msg.to_string()) }
}

/// 修补前端发来的 AT^SYSCFGEX：把频段参数重新加上引号，并补齐末尾两个空参数。
fn normalize_syscfgex(command: &str) -> String {
    if !command.starts_with("AT^SYSCFGEX") {
        return command.to_string();
    }
    let cleaned = command.replace('\r', "").replace('\n', "").replace("OK", "");
    if cleaned.contains(",\"\",\"\"") {
        let parts: Vec<&str> = cleaned.split(',').collect();
        if parts.len() >= 5 {
            let bands = parts[4].trim_matches('"');
            let head = parts[..4].join(",");
            return format!("{head},\"{bands}\",\"\",\"\"");
        }
    }
    cleaned
}

/// 按行读取，单行最多 max 字节。超限时标记 overlong 并排空该行剩余数据。
/// 返回 None 表示 EOF；Some((line, overlong)) 表示读到一行。
async fn read_line_limited<R>(reader: &mut BufReader<R>, max: usize) -> std::io::Result<Option<(String, bool)>>
where
    R: AsyncRead + Unpin,
{
    let mut raw: Vec<u8> = Vec::new();
    {
        let mut limited = (&mut *reader).take(max as u64);
        let n = limited.read_until(b'\n', &mut raw).await?;
        if n == 0 && raw.is_empty() {
            return Ok(None);
        }
    }
    let mut overlong = false;
    if raw.last() != Some(&b'\n') {
        // take 用尽仍未见换行：本行超长，排空剩余
        if raw.len() >= max {
            overlong = true;
            let mut drain = Vec::new();
            let _ = (&mut *reader).read_until(b'\n', &mut drain).await;
        }
    } else {
        raw.pop();
        if raw.last() == Some(&b'\r') {
            raw.pop();
        }
    }
    Ok(Some((String::from_utf8_lossy(&raw).into_owned(), overlong)))
}
