//! WebSocket 服务：认证、心跳、{success,data,error} 命令应答、主动上报推送。
//! 协议与 Go 实现（wsserver.go）严格一致，前端无需改动即可接入。

use crate::{log_debug, log_error, log_info, log_warn};
use crate::atclient::AtClient;
use crate::schedconfig::{SCHED_QUERY_COMMAND, SCHED_RESPONSE_PREFIX, SCHED_SET_PREFIX, SchedConfigDto, dto_to_schedule, schedule_to_dto, write_schedule_uci};
use crate::schedule::Scheduler;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;

const WS_HEARTBEAT: Duration = Duration::from_secs(30);
const WS_AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const WS_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const WS_OUT_BUFFER: usize = 128;
const CELLSCAN_ABORT_TOKEN: &str = "abcd";
const DEFAULT_SCAN_TIMEOUT: Duration = Duration::from_secs(180);

/// 发给前端的命令应答。字段名与旧实现严格一致，前端按 FIFO 顺序匹配。
#[derive(Serialize)]
pub struct AtCommandResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
struct AuthResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    success: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    message: String,
}

/// 扫频推给前端的消息。state 取值 running/done/aborted/error。
#[derive(Serialize)]
#[allow(dead_code)] // 扫频推送结构保留（后续断点续扫扩展）
pub struct ScanPush {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<Vec<String>>,
    pub count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct ScanState {
    pub running: bool,
    pub aborted: bool,
    pub lines: Vec<String>,
}

/// 推送中枢：给所有已认证客户端 try_send（客户端来不及收就丢弃）。
#[derive(Clone)]
pub struct Hub {
    clients: Arc<RwLock<Vec<mpsc::Sender<Vec<u8>>>>>,
}

impl Hub {
    pub fn new() -> Hub {
        Hub { clients: Arc::new(RwLock::new(Vec::new())) }
    }

    pub fn broadcast(&self, msg: &serde_json::Value) {
        let payload = match serde_json::to_vec(msg) {
            Ok(p) => p,
            Err(e) => {
                log_error!("序列化推送消息失败: {}", e);
                return;
            }
        };
        // std::sync::RwLock：广播在异步任务里被调用，tokio 锁的 blocking_* 会 panic；
        // 锁内只做非阻塞 try_send，持有时间极短。
        let clients = self.clients.read().unwrap_or_else(|e| e.into_inner());
        for c in clients.iter() {
            if c.try_send(payload.clone()).is_err() {
                log_debug!("客户端发送队列已满，丢弃一条推送");
            }
        }
    }

    pub fn broadcast_json(&self, type_: &str, data: serde_json::Value) {
        self.broadcast(&serde_json::json!({ "type": type_, "data": data }));
    }
}

type WsStream = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

pub struct WsServer {
    client: Arc<AtClient>,
    auth_key: String,
    sched: Arc<Scheduler>,
    hub: Hub,
    scan: Arc<Mutex<ScanState>>,
    scan_timeout: Duration,
    ctx: tokio::sync::watch::Receiver<bool>,
}

impl WsServer {
    pub fn new(
        client: Arc<AtClient>,
        auth_key: String,
        sched: Arc<Scheduler>,
        ctx: tokio::sync::watch::Receiver<bool>,
    ) -> WsServer {
        WsServer {
            client,
            auth_key,
            sched,
            hub: Hub::new(),
            scan: Arc::new(Mutex::new(ScanState { running: false, aborted: false, lines: Vec::new() })),
            scan_timeout: DEFAULT_SCAN_TIMEOUT,
            ctx,
        }
    }

    pub fn hub(&self) -> Hub {
        self.hub.clone()
    }

    /// 生成一个只用于单连接的浅拷贝（共享内部状态）。
    fn shallow_clone(&self) -> WsServer {
        WsServer {
            client: self.client.clone(),
            auth_key: self.auth_key.clone(),
            sched: self.sched.clone(),
            hub: self.hub.clone(),
            scan: self.scan.clone(),
            scan_timeout: self.scan_timeout,
            ctx: self.ctx.clone(),
        }
    }

    pub fn set_scan_timeout(&mut self, d: Duration) {
        if !d.is_zero() {
            self.scan_timeout = d;
        }
    }

    /// 绑定并服务 WebSocket，直到 ctx 结束。
    pub async fn serve(&self, port: u16) -> Result<(), String> {
        let listener = match tokio::net::TcpListener::bind(("::", port)).await {
            Ok(l) => l,
            Err(_) => tokio::net::TcpListener::bind(("0.0.0.0", port))
                .await
                .map_err(|e| format!("监听 WebSocket 端口 {port} 失败: {e}"))?,
        };
        log_info!("WebSocket 监听 :{} (IPv4 + IPv6)", port);

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
                        if let Err(e) = conn_server.handle_connection(stream, addr).await {
                            log_debug!("WebSocket 客户端断开: {} ({})", addr, e);
                        }
                    });
                }
            }
        }
    }

    async fn handle_connection(&self, stream: tokio::net::TcpStream, addr: std::net::SocketAddr) -> Result<(), String> {
        let mut ws = tokio_tungstenite::accept_async(stream).await.map_err(|e| e.to_string())?;

        // 认证握手是严格的一问一答；拒绝消息一定在关闭连接之前送达。
        if !self.auth_key.is_empty() && !self.authenticate(&mut ws).await {
            return Ok(());
        }

        let (mut write, mut read) = ws.split();
        let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(WS_OUT_BUFFER);
        self.hub.clients.write().unwrap_or_else(|e| e.into_inner()).push(out_tx.clone());
        log_debug!("WebSocket 客户端已连接: {}", addr);

        // 写循环：这条连接唯一的写入者，同时负责 30 秒一次的心跳。
        let writer_task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(WS_HEARTBEAT);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ticker.tick().await; // 跳过立即触发的一次，与 Go 一致：首包心跳在 30s 后
            loop {
                tokio::select! {
                    msg = out_rx.recv() => {
                        match msg {
                            Some(payload) => {
                                let text = String::from_utf8(payload).unwrap_or_default();
                                if write.send(Message::Text(text.into())).await.is_err() {
                                    return;
                                }
                            }
                            None => return,
                        }
                    }
                    _ = ticker.tick() => {
                        if write.send(Message::Text("ping".into())).await.is_err() {
                            return;
                        }
                    }
                }
            }
        });

        // 读循环：顺序处理客户端消息。串行是刻意的：前端没有请求 ID，
        // 靠应答顺序匹配命令，并发处理会串号。
        let mut ctx_c = self.ctx.clone();
        loop {
            let msg = tokio::select! {
                m = read.next() => m,
                _ = ctx_c.changed() => break,
            };
            match msg {
                Some(Ok(Message::Text(text))) => {
                    let text = text.to_string();
                    if text == "ping" {
                        let _ = out_tx.try_send(b"pong".to_vec());
                        continue;
                    }
                    let response = self.run_command(&text).await;
                    let payload = serde_json::to_vec(&response).unwrap_or_default();
                    if out_tx.send(payload).await.is_err() {
                        break;
                    }
                }
                Some(Ok(_)) => {}
                _ => break,
            }
        }

        writer_task.abort();
        drop(out_tx);
        self.hub.clients.write().unwrap_or_else(|e| e.into_inner()).retain(|c| !c.is_closed());
        Ok(())
    }

    async fn authenticate(&self, ws: &mut WsStream) -> bool {
        let msg = tokio::time::timeout(WS_AUTH_TIMEOUT, ws.next()).await;
        let text = match msg {
            Ok(Some(Ok(Message::Text(t)))) => t.to_string(),
            _ => {
                send_auth(ws, AuthResult { success: None, error: Some("Authentication timeout".into()), message: "认证超时".into() }).await;
                return false;
            }
        };

        let body: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => {
                send_auth(ws, AuthResult { success: None, error: Some("Invalid authentication".into()), message: "无效的认证数据".into() }).await;
                return false;
            }
        };

        let key = body.get("auth_key").and_then(|v| v.as_str()).unwrap_or("");
        if key != self.auth_key {
            log_warn!("WebSocket 连接被拒绝: 密钥错误");
            send_auth(ws, AuthResult { success: None, error: Some("Authentication failed".into()), message: "密钥验证失败".into() }).await;
            return false;
        }

        send_auth(ws, AuthResult { success: Some(true), error: None, message: "认证成功".into() }).await;
        log_debug!("WebSocket 客户端认证成功");
        true
    }

    /// 把前端发来的字符串当作 AT 命令执行并整理成应答。
    pub async fn run_command(&self, command: &str) -> AtCommandResponse {
        log_debug!("收到 AT 命令: {}", command.trim());

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

        let result = tokio::time::timeout(
            crate::atclient::COMMAND_TIMEOUT + Duration::from_secs(3),
            self.client.send_command(&self.ctx, &command, crate::atclient::COMMAND_TIMEOUT, None),
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

        // 后台异步执行扫频，让 WebSocket 读循环空出来接收打断命令。
        let client = self.client.clone();
        let hub = self.hub.clone();
        let scan_state = self.scan.clone();
        let timeout = if self.scan_timeout > Duration::ZERO { self.scan_timeout } else { DEFAULT_SCAN_TIMEOUT };
        let ctx = self.ctx.clone();
        let command = command.trim().to_string();
        tokio::spawn(async move {
            run_cell_scan(client, hub, scan_state, ctx, command, timeout).await;
        });

        // 立刻应答，让前端的命令队列不被这条几分钟的命令堵住。
        ok_response("^CELLSCAN: STARTED\r\nOK")
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

async fn send_auth(ws: &mut WsStream, result: AuthResult) {
    if let Ok(payload) = serde_json::to_vec(&result) {
        let text = String::from_utf8(payload).unwrap_or_default();
        let _ = tokio::time::timeout(WS_WRITE_TIMEOUT, ws.send(Message::Text(text.into()))).await;
    }
}

async fn run_cell_scan(
    client: Arc<AtClient>,
    hub: Hub,
    scan_state: Arc<Mutex<ScanState>>,
    ctx: tokio::sync::watch::Receiver<bool>,
    command: String,
    timeout: Duration,
) {
    log_info!("开始扫频: {} (超时 {}s)", command, timeout.as_secs());

    let scan_state_stream = scan_state.clone();
    let hub_stream = hub.clone();
    let result = tokio::time::timeout(
        timeout + Duration::from_secs(10),
        client.send_long_command(
            &ctx,
            &command,
            timeout,
            Some(Box::new(move |line: String| {
                let line = line.trim().to_string();
                if !line.starts_with("^CELLSCAN:") {
                    return;
                }
                let mut scan = scan_state_stream.blocking_lock();
                scan.lines.push(line.clone());
                let count = scan.lines.len();
                drop(scan);
                hub_stream.broadcast_json(
                    "cellscan",
                    serde_json::json!({ "state": "running", "cell": line, "count": count }),
                );
            })),
        ),
    )
    .await;

    // running 必须无条件复位：万一出了意外还留着 true，
    // 之后所有 AT 命令都会被"正在扫频"挡住，只能重启服务才能恢复。
    let mut scan = scan_state.blocking_lock();
    let lines = scan.lines.clone();
    let aborted = scan.aborted;
    scan.running = false;
    scan.aborted = false;
    scan.lines.clear();
    drop(scan);

    let count = lines.len();
    match result {
        Ok(Ok(resp)) if !resp.has_error() => {
            let state = if aborted { "aborted" } else { "done" };
            log_info!("扫频结束({}): 共 {} 个小区", state, count);
            hub.broadcast_json("cellscan", serde_json::json!({ "state": state, "lines": lines, "count": count }));
        }
        Ok(Ok(resp)) => {
            log_warn!("扫频被模组拒绝: {}", resp.text());
            hub.broadcast_json(
                "cellscan",
                serde_json::json!({ "state": "error", "error": resp.text(), "lines": lines, "count": count }),
            );
        }
        Ok(Err(e)) => {
            log_warn!("扫频失败: {}", e);
            hub.broadcast_json(
                "cellscan",
                serde_json::json!({ "state": "error", "error": e, "lines": lines, "count": count }),
            );
        }
        Err(_) => {
            log_warn!("扫频超时");
            hub.broadcast_json(
                "cellscan",
                serde_json::json!({ "state": "error", "error": "扫频超时", "lines": lines, "count": count }),
            );
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
