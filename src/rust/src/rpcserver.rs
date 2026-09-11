//! LuCI RPC 服务：TCP newline-JSON（127.0.0.1:8765），由 rpcd ucode 插件（mt5700.uc）代理转发。
//! 替代原 WebSocket 传输层；核心业务逻辑（伪命令/扫频/命令分发/事件总线）全部保留。
//!
//! 协议（每行一个 JSON 对象）：
//!   请求: {"id":1,"method":"at","params":{"cmd":"AT+CSQ","auth_key":"..."}}
//!   请求: {"id":2,"method":"events","params":{"since":12,"auth_key":"..."}}
//!   应答: {"id":1,"result":{"success":true,"data":"..."}}
//!   应答: {"id":2,"result":{"seq":18,"events":[{"type":"raw_data","data":"..."}]}}
//!   错误: {"id":1,"error":{"code":-1,"message":"..."}}
//!
//! 事件不主动推送：前端通过 events(since) 拉取增量（LuCI RPC 为请求-响应模型）。

use crate::{log_debug, log_error, log_info, log_warn};
use crate::atclient::AtClient;
use crate::schedconfig::{SCHED_QUERY_COMMAND, SCHED_RESPONSE_PREFIX, SCHED_SET_PREFIX, SchedConfigDto, dto_to_schedule, schedule_to_dto, write_schedule_uci};
use crate::schedule::Scheduler;
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
/// RPC 请求行长度上限（防异常长行撑爆内存；Go 版 WebSocket 是 64KB 读限）。
const MAX_RPC_LINE: usize = 8192;
const CELLSCAN_ABORT_TOKEN: &str = "abcd";
const DEFAULT_SCAN_TIMEOUT: Duration = Duration::from_secs(180);

/// 发给前端的命令应答。字段名与原实现严格一致。
#[derive(Serialize)]
pub struct AtCommandResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 扫频推给前端的事件 data。state 取值 running/done/aborted/error。
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

/// 事件总线：替代原 WebSocket Hub 的"广播给所有客户端"。
/// 所有推送（raw_data/new_sms/incoming_call/pdcp_data/memory_full/cellscan/urc_data）
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
    ctx: tokio::sync::watch::Receiver<bool>,
}

impl RpcServer {
    pub fn new(
        client: Arc<AtClient>,
        auth_key: String,
        sched: Arc<Scheduler>,
        ctx: tokio::sync::watch::Receiver<bool>,
    ) -> RpcServer {
        RpcServer {
            client,
            auth_key,
            sched,
            hub: Hub::new(),
            scan: Arc::new(AsyncMutex::new(ScanState { running: false, aborted: false, lines: Vec::new() })),
            scan_timeout: DEFAULT_SCAN_TIMEOUT,
            ctx,
        }
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
            ctx: self.ctx.clone(),
        }
    }

    pub fn set_scan_timeout(&mut self, d: Duration) {
        if !d.is_zero() {
            self.scan_timeout = d;
        }
    }

    /// 绑定并服务 RPC，直到 ctx 结束。仅监听回环地址：LuCI 经 rpcd/ucode 本机转发，
    /// 不对外暴露端口。
    pub async fn serve(&self, port: u16) -> Result<(), String> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| format!("监听 RPC 端口 127.0.0.1:{port} 失败: {e}"))?;
        log_info!("LuCI RPC 监听 127.0.0.1:{port}");

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
            _ => serde_json::json!({ "id": id, "error": { "code": -32601, "message": format!("未知方法: {}", req.method) } }),
        }
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

        // 后台异步执行扫频，让 RPC 读循环空出来接收打断命令。
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

async fn run_cell_scan(
    client: Arc<AtClient>,
    hub: Hub,
    scan_state: Arc<AsyncMutex<ScanState>>,
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
        ),
    )
    .await;

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
