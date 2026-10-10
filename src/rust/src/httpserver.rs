//! 独立 WebUI 服务：HTTP API + WebSocket + 静态文件。
//!
//! 监听 0.0.0.0:9000（默认），浏览器直访 http://<设备IP>:9000 即进入 WebUI。
//! 与 TCP RPC（rpcserver.rs，用于 mock-modem e2e 与本地调试）共享同一套
//! 核心组件：AT 队列、事件总线、后台任务、状态缓存、定时锁频调度。
//!
//! API 一览：
//!   POST /api/at            {cmd}                  执行 AT 命令（High 优先级）
//!   GET  /api/events?since  增量事件（事件总线，seq 单调递增）
//!   GET  /api/logs?since&limit   后端运行日志
//!   GET  /api/netrate?device     接口累计字节数（sysfs，不占 AT 通道）
//!   GET  /api/usb                模组 USB 链路速率（sysfs，不占 AT 通道）
//!   GET  /api/syslog?lines       系统日志（journalctl -t at-webserver）
//!   GET/POST /api/config         配置读取 / 合并落盘（JSON 扁平键值）
//!   POST /api/config/apply       热应用；结构性变更返回 restart_required
//!   GET  /api/service/status     版本/PID/运行时长/串口清单
//!   POST /api/service/restart    延时后退出进程（systemd 自动拉起）
//!   GET/POST /api/file/read|write|list|stat   受限文件访问（日志文件等）
//!   GET  /ws                     WebSocket 事件推送（每 400ms 批量增量；每 30s ping 保活）
//!
//! 认证：配置 auth_key 后，/api 与 /ws 需携带 X-Auth-Key 头（/ws 可用 ?key=）；
//! 静态资源不设防，页面加载后由前端弹窗索取密钥；/api 与 /ws 均需携带密钥。

use crate::config::{Config, DEFAULT_WEB_ROOT};
use crate::configstore;
use crate::rpcserver::RpcServer;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::RwLock;

/// 配置文件单次请求体上限（普通 JSON 足够）。
const MAX_BODY: usize = 64 * 1024 * 1024;
/// 需要重启服务才能生效的配置键（其余 schedule_* 等可热应用）。
const RESTART_KEYS: &[&str] = &[
    "enabled", "connection_type", "network_host", "network_port", "network_timeout",
    "serial_port", "serial_port_custom", "serial_baudrate", "serial_timeout",
    "autodial_enable", "autodial_mode",
    "http_port", "http_bind", "web_root", "auth_key", "websocket_auth_key",
    "cellscan_timeout", "netdev", "uplink_hook",
    "notify_sms", "notify_call", "notify_memory_full", "notify_signal",
    "wechat_webhook", "log_file",
];

pub struct HttpServer {
    rpc: Arc<RpcServer>,
    cfg: Arc<RwLock<Config>>,
    cur_map: Arc<RwLock<configstore::ConfigMap>>,
    /// 保存时实际发生变更的结构性键（apply 时据此判定 restart_required）。
    pending_restart: Arc<RwLock<Vec<String>>>,
    started: Instant,
    ctx: tokio::sync::watch::Receiver<bool>,
}

struct Request {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

struct Response {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
    no_cache: bool,
}

impl Response {
    fn json(status: u16, v: &Value) -> Response {
        Response {
            status,
            content_type: "application/json; charset=utf-8",
            body: serde_json::to_vec(v).unwrap_or_default(),
            no_cache: true,
        }
    }
    fn file(ct: &'static str, body: Vec<u8>) -> Response {
        Response { status: 200, content_type: ct, body, no_cache: false }
    }
}

fn ok_json(v: Value) -> Response { Response::json(200, &v) }
fn err_json(status: u16, msg: &str) -> Response {
    Response::json(status, &json!({ "error": msg }))
}

impl HttpServer {
    pub fn new(
        rpc: Arc<RpcServer>,
        cfg: Arc<RwLock<Config>>,
        cur_map: configstore::ConfigMap,
        ctx: tokio::sync::watch::Receiver<bool>,
    ) -> HttpServer {
        HttpServer {
            rpc,
            cfg,
            cur_map: Arc::new(RwLock::new(cur_map)),
            pending_restart: Arc::new(RwLock::new(Vec::new())),
            started: Instant::now(),
            ctx,
        }
    }

    /// 绑定并服务 HTTP，直到 ctx 结束。
    pub async fn serve(&self, bind: &str, port: u16) -> Result<(), String> {
        let listener = tokio::net::TcpListener::bind((bind, port))
            .await
            .map_err(|e| format!("监听 HTTP {bind}:{port} 失败: {e}"))?;
        crate::log_info!("独立 WebUI/HTTP API 监听 {bind}:{port}");

        let mut ctx_c = self.ctx.clone();
        loop {
            let accepted = tokio::select! {
                _ = ctx_c.changed() => return Ok(()),
                a = listener.accept() => a,
            };
            let (stream, addr) = match accepted {
                Ok(v) => v,
                Err(e) => {
                    crate::log_warn!("接受 HTTP 连接失败: {}", e);
                    continue;
                }
            };
            let srv = self.shallow();
            tokio::spawn(async move {
                if let Err(e) = srv.handle_conn(stream).await {
                    crate::log_debug!("HTTP 连接结束: {} ({})", addr, e);
                }
            });
        }
    }

    fn shallow(&self) -> HttpServer {
        HttpServer {
            rpc: self.rpc.clone(),
            cfg: self.cfg.clone(),
            cur_map: self.cur_map.clone(),
            pending_restart: self.pending_restart.clone(),
            started: self.started,
            ctx: self.ctx.clone(),
        }
    }

    async fn handle_conn(&self, stream: tokio::net::TcpStream) -> Result<(), String> {
        /* WebSocket 升级路径单独处理（连接生命周期与普通请求不同） */
        let (mut read_half, mut write_half) = stream.into_split();

        let mut req = {
            let mut reader = BufReader::new(&mut read_half);
            match read_request(&mut reader).await {
                Ok(Some(r)) => r,
                Ok(None) => return Ok(()),
                Err(e) => {
                    let resp = err_json(400, &format!("无效请求: {e}"));
                    let _ = write_response(&mut write_half, resp).await;
                    return Ok(());
                }
            }
        };

        /* WebSocket 升级请求 */
        let is_ws = req
            .headers
            .iter()
            .any(|(k, v)| k.eq_ignore_ascii_case("upgrade") && v.eq_ignore_ascii_case("websocket"));
        if is_ws && req.path == "/ws" {
            if let Err(resp) = self.check_auth(&req).await {
                let _ = write_response(&mut write_half, resp).await;
                return Ok(());
            }
            let key = req
                .headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("sec-websocket-key"))
                .map(|(_, v)| v.clone())
                .unwrap_or_default();
            let accept = ws_accept_key(&key);
            let handshake = format!(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
            );
            write_half.write_all(handshake.as_bytes()).await.map_err(|e| e.to_string())?;
            write_half.flush().await.ok();
            return ws_serve(self.rpc.clone(), write_half, self.ctx.clone()).await;
        }

        /* 普通请求（Connection: close，一次一请求，简单可靠） */
        let resp = self.route(&mut req).await;
        write_response(&mut write_half, resp).await.map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn check_auth(&self, req: &Request) -> Result<(), Response> {
        let key = self.cfg.read().await.http.auth_key.clone();
        if key.is_empty() {
            return Ok(());
        }
        let got = req
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("x-auth-key"))
            .map(|(_, v)| v.clone())
            .or_else(|| req.query.get("key").cloned())
            .unwrap_or_default();
        if got == key {
            Ok(())
        } else {
            Err(err_json(401, "REQUIRE_AUTH_KEY"))
        }
    }

    /* ================= 路由 ================= */

    async fn route(&self, req: &mut Request) -> Response {
        let path = req.path.trim_end_matches('/').to_string();
        let path = if path.is_empty() { "/".to_string() } else { path };

        /* 静态资源不设防（页面要先加载才能弹认证框） */
        if !path.starts_with("/api/") {
            return self.serve_static(&path).await;
        }

        if let Err(resp) = self.check_auth(req).await {
            return resp;
        }

        match (req.method.as_str(), path.as_str()) {
            ("POST", "/api/at") => {
                let body = match serde_json::from_slice::<Value>(&req.body) {
                    Ok(v) => v,
                    Err(e) => return err_json(400, &format!("请求体不是有效 JSON: {e}")),
                };
                let cmd = body.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
                if cmd.is_empty() {
                    return err_json(400, "缺少参数 cmd");
                }
                let resp = self.rpc.run_command(cmd).await;
                ok_json(json!({
                    "success": resp.success,
                    "data": resp.data,
                    "error": resp.error,
                }))
            }
            ("GET", "/api/events") => {
                let since = req.query.get("since").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
                let (seq, events) = self.rpc.events_since(since).await;
                ok_json(json!({ "seq": seq, "events": events }))
            }
            ("GET", "/api/logs") => {
                let since = req.query.get("since").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
                let limit = req.query.get("limit").and_then(|v| v.parse::<usize>().ok()).unwrap_or(300);
                let (seq, entries) = self.rpc.logs_since(since, limit).await;
                ok_json(json!({ "seq": seq, "entries": entries }))
            }
            ("GET", "/api/netrate") => self.netrate(req.query.get("device").map(|s| s.as_str())).await,
            ("GET", "/api/usb") => ok_json(usb_info()),
            ("GET", "/api/syslog") => {
                let lines = req.query.get("lines").and_then(|v| v.parse::<usize>().ok()).unwrap_or(200).min(2000);
                ok_json(syslog(lines).await)
            }
            ("GET", "/api/config") => {
                let map = self.cur_map.read().await.clone();
                map_to_json(map)
            }
            ("POST", "/api/config") => {
                let patch: HashMap<String, String> = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(e) => return err_json(400, &format!("请求体不是有效配置: {e}")),
                };
                let patch: configstore::ConfigMap = patch.into_iter().collect();
                /* 记录本次保存里真实变更的结构性键（供 apply 判定 restart_required） */
                {
                    let before = self.cur_map.read().await;
                    let mut pending = self.pending_restart.write().await;
                    for (k, v) in &patch {
                        if RESTART_KEYS.contains(&k.as_str()) && before.get(k).map(|s| s.as_str()) != Some(v.as_str()) {
                            if !pending.iter().any(|x| x == k) {
                                pending.push(k.clone());
                            }
                        }
                    }
                }
                match configstore::update(patch).await {
                    Ok(map) => {
                        *self.cur_map.write().await = map.clone();
                        ok_json(json!({ "saved": true, "config": map }))
                    }
                    Err(e) => err_json(500, &e),
                }
            }
            ("POST", "/api/config/apply") => self.apply_config().await,
            ("GET", "/api/service/status") => ok_json(self.service_status().await),
            ("POST", "/api/service/restart") => {
                crate::log_info!("收到 WebUI 重启请求，服务将在 500ms 后退出（systemd 自动拉起）");
                tokio::spawn(async {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    std::process::exit(0);
                });
                ok_json(json!({ "restarting": true }))
            }
            ("GET", "/api/file/read") => file_read(req.query.get("path").map(|s| s.as_str()).unwrap_or("")),
            ("POST", "/api/file/write") => {
                let body = match serde_json::from_slice::<Value>(&req.body) {
                    Ok(v) => v,
                    Err(e) => return err_json(400, &format!("请求体不是有效 JSON: {e}")),
                };
                let p = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let data = body.get("data").and_then(|v| v.as_str()).unwrap_or("");
                file_write(p, data)
            }
            ("GET", "/api/file/list") => file_list(req.query.get("path").map(|s| s.as_str()).unwrap_or("")),
            ("GET", "/api/file/stat") => file_stat(req.query.get("path").map(|s| s.as_str()).unwrap_or("")),
            ("POST", "/api/rpc/mt5700/task_status") => {
                let body = match serde_json::from_slice::<Value>(&req.body) {
                    Ok(v) => v,
                    Err(e) => return err_json(400, &format!("请求体不是有效 JSON: {e}")),
                };
                let tid = body.get("id").and_then(|v| v.as_str()).unwrap_or("");
                match self.rpc.task_status(tid).await {
                    Some(info) => ok_json(json!({
                        "id": info.id, "kind": info.kind, "state": info.state.as_str(),
                        "progress": info.progress, "error": info.error, "result": info.result,
                        "created_at": info.created_at, "started_at": info.started_at, "finished_at": info.finished_at,
                    })),
                    None => err_json(404, &format!("任务不存在: {tid}")),
                }
            }
            ("POST", "/api/rpc/mt5700/task_cancel") => {
                let body = match serde_json::from_slice::<Value>(&req.body) {
                    Ok(v) => v,
                    Err(e) => return err_json(400, &format!("请求体不是有效 JSON: {e}")),
                };
                let tid = body.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if self.rpc.task_cancel(tid).await {
                    ok_json(json!({ "cancelled": true, "id": tid }))
                } else {
                    err_json(404, &format!("任务不存在: {tid}"))
                }
            }
            ("POST", "/api/rpc/mt5700/task_list") => {
                let items: Vec<Value> = self
                    .rpc
                    .task_list()
                    .await
                    .into_iter()
                    .map(|info| {
                        json!({
                            "id": info.id, "kind": info.kind, "state": info.state.as_str(),
                            "progress": info.progress, "error": info.error, "result": info.result,
                            "created_at": info.created_at, "started_at": info.started_at, "finished_at": info.finished_at,
                        })
                    })
                    .collect();
                ok_json(json!({ "tasks": items }))
            }
            _ => err_json(404, &format!("未知端点: {} {}", req.method, req.path)),
        }
    }

    /// 热应用配置：schedule_* 即时生效；结构性变更提示重启。
    async fn apply_config(&self) -> Response {
        let new_map = match configstore::read_map().await {
            Ok(m) => m,
            Err(e) => return err_json(500, &e),
        };
        let new_cfg = crate::config::load_config().await;
        let old_map = self.cur_map.read().await.clone();

        /* restart_required：本次保存以来记录的结构性变更键；
         * 并把「存储里的值与运行时快照仍不一致」的键也并入（覆盖手工改文件的场景）。 */
        let mut restart_keys: Vec<String> = self.pending_restart.write().await.drain(..).collect();
        for k in RESTART_KEYS {
            let old = old_map.get(*k).map(|s| s.as_str()).unwrap_or("");
            let new = new_map.get(*k).map(|s| s.as_str()).unwrap_or("");
            if old != new && !restart_keys.iter().any(|x| x == k) {
                restart_keys.push((*k).to_string());
            }
        }

        /* schedule_* 变更即时热应用（校验失败返回错误，不影响其它键） */
        let old_sched = serde_json::to_string(&schedule_summary(&old_map)).unwrap_or_default();
        let new_sched = serde_json::to_string(&schedule_summary(&new_map)).unwrap_or_default();
        let mut sched_error: Option<String> = None;
        if old_sched != new_sched {
            if let Err(e) = self.rpc.apply_schedule_config(&new_cfg.schedule).await {
                sched_error = Some(e);
            }
        }

        *self.cfg.write().await = new_cfg;
        *self.cur_map.write().await = new_map;

        match sched_error {
            Some(e) => err_json(400, &format!("定时锁频配置校验失败: {e}")),
            None => ok_json(json!({
                "applied": true,
                "restart_required": !restart_keys.is_empty(),
                "restart_keys": restart_keys,
            })),
        }
    }

    async fn netrate(&self, device: Option<&str>) -> Response {
        let dev = match device.filter(|s| !s.is_empty()) {
            Some(d) => d.to_string(),
            None => {
                let netdev = configstore::get_str("netdev", "").await;
                if !netdev.is_empty() {
                    netdev
                } else {
                    match detect_modem_netdev() {
                        Some(d) => d,
                        None => return err_json(404, "未检测到模组网络接口，可在配置中设置 netdev"),
                    }
                }
            }
        };
        let base = PathBuf::from(format!("/sys/class/net/{dev}/statistics"));
        let rx = read_sysfs_u64(&base.join("rx_bytes"));
        let tx = read_sysfs_u64(&base.join("tx_bytes"));
        if rx.is_none() && tx.is_none() {
            return Response::json(
                200,
                &json!({ "success": false, "device": dev, "error": "读不到接口计数器，设备可能不存在或未 up" }),
            );
        }
        ok_json(json!({
            "success": true,
            "device": dev,
            "rx_bytes": rx.unwrap_or(0),
            "tx_bytes": tx.unwrap_or(0),
        }))
    }

    async fn service_status(&self) -> Value {
        let cfg = self.cfg.read().await.clone();
        json!({
            "alive": true,
            "pid": std::process::id(),
            "version": env!("CARGO_PKG_VERSION"),
            "uptime_secs": self.started.elapsed().as_secs(),
            "enabled": cfg.enabled,
            "serials": list_serial_devices(),
            "http_port": cfg.http.port,
            "http_bind": cfg.http.bind,
            "at_channel": cfg.at.type_,
            "schedule_enabled": cfg.schedule.enabled,
        })
    }

    /* ================= 静态文件 ================= */

    async fn serve_static(&self, path: &str) -> Response {
        let web_root = self.cfg.read().await.http.web_root.clone();
        let web_root = if web_root.is_empty() { DEFAULT_WEB_ROOT.to_string() } else { web_root };
        let rel = if path == "/" { "/index.html" } else { path };

        /* 路径穿越防护：拒绝 .. 与反斜杠 */
        if rel.contains("..") || rel.contains('\\') {
            return err_json(400, "非法路径");
        }
        let full = PathBuf::from(web_root).join(rel.trim_start_matches('/'));
        match std::fs::read(&full) {
            Ok(data) => {
                let ct = content_type(&full);
                Response::file(ct, data)
            }
            Err(_) => err_json(404, &format!("资源不存在: {path}")),
        }
    }
}

/* ---------- 配置辅助 ---------- */

fn schedule_summary(map: &configstore::ConfigMap) -> configstore::ConfigMap {
    map.iter()
        .filter(|(k, _)| k.starts_with("schedule_"))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn map_to_json(map: configstore::ConfigMap) -> Response {
    let obj: serde_json::Map<String, Value> = map
        .into_iter()
        .map(|(k, v)| (k, Value::String(v)))
        .collect();
    ok_json(Value::Object(obj))
}

/* ================= 系统信息（sysfs 直读，全程不发 AT） ================= */

fn read_sysfs_u64(p: &Path) -> Option<u64> {
    std::fs::read_to_string(p).ok()?.trim().parse::<u64>().ok()
}

/// 自动识别承载 5G 流量的 USB 网络接口：
/// 在 /sys/class/net 里找带物理设备（device 链接）且其父路径含 usb 的接口。
fn detect_modem_netdev() -> Option<String> {
    let dir = Path::new("/sys/class/net");
    let entries = std::fs::read_dir(dir).ok()?;
    let mut candidates: Vec<String> = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name == "lo" {
            continue;
        }
        let dev = e.path().join("device");
        if !dev.exists() {
            continue; /* 无 device 链接多为虚拟接口（bridge/veth 等） */
        }
        let link = std::fs::read_link(&dev).unwrap_or_else(|_| dev.clone());
        let link_str = link.to_string_lossy().to_string();
        /* 仅认 USB 物理设备（PCI 网卡如 eth0/enp*s0 的路径不含 usb） */
        if link_str.contains("usb") {
            candidates.push(name);
        }
    }
    candidates.sort();
    candidates.into_iter().next()
}

/// 模组 USB 链路信息：直读 /sys/bus/usb/devices，返回速率 / 产品名 / 版本。
fn usb_info() -> Value {
    let dir = Path::new("/sys/bus/usb/devices");
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return json!({ "success": false, "error": "无法读取 USB 设备列表" }),
    };
    let mut devices: Vec<String> = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.contains(':') {
            continue; /* 跳过接口子目录（如 2-1:1.0） */
        }
        devices.push(name);
    }
    devices.sort();
    for name in devices {
        let base = dir.join(&name);
        let vendor = std::fs::read_to_string(base.join("idVendor")).unwrap_or_default();
        if vendor.trim().eq_ignore_ascii_case("1d6b") {
            continue; /* 跳过 xHCI 根集线器 */
        }
        let product = std::fs::read_to_string(base.join("product")).unwrap_or_default().trim().to_string();
        if product.is_empty() {
            continue;
        }
        let speed = std::fs::read_to_string(base.join("speed")).unwrap_or_default().trim().to_string();
        let version = std::fs::read_to_string(base.join("version")).unwrap_or_default().trim().to_string();
        let mbps = speed.parse::<u64>().unwrap_or(0);
        return json!({ "success": true, "speed_mbps": mbps, "product": product, "version": version });
    }
    json!({ "success": false, "error": "未检测到 USB 模组设备" })
}

/// 系统日志：通过 journalctl 读取 at-webserver 标识的最近若干行。
async fn syslog(lines: usize) -> Value {
    let out = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new("journalctl")
            .args([
                "-t", "at-webserver",
                "-n", &lines.to_string(),
                "--no-pager", "-q",
                "-o", "short-iso",
            ])
            .output(),
    )
    .await;

    let entries = match out {
        Ok(Ok(o)) if o.status.success() => {
            let text = String::from_utf8_lossy(&o.stdout);
            text.lines()
                .filter_map(|line| {
                    /* short-iso: "2026-10-05T18:00:00+0800 host at-webserver[pid]: msg" */
                    let msg_start = line.find("at-webserver")?;
                    let msg = line.get(msg_start..)?.to_string();
                    let ts = if line.len() >= 19 {
                        chrono::NaiveDateTime::parse_from_str(&line[..19], "%Y-%m-%dT%H:%M:%S")
                            .ok()
                            .map(|t| t.and_utc().timestamp_millis())
                            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis())
                    } else {
                        chrono::Utc::now().timestamp_millis()
                    };
                    Some(json!({ "time": ts, "msg": msg }))
                })
                .collect::<Vec<_>>()
        }
        _ => {
            /* 非 systemd journal 环境（容器/手工运行）：返回空列表，页面显示无数据 */
            Vec::new()
        }
    };
    json!({ "log": entries })
}

/// 串口设备清单：枚举 /dev，保留 ttyUSB / ttyACM / ttyAMA 及 ttyS<数字> 形式的设备。
fn list_serial_devices() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/dev") {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let hit = name.starts_with("ttyUSB")
                || name.starts_with("ttyACM")
                || name.starts_with("ttyAMA")
                || (name.starts_with("ttyS") && name[4..].chars().all(|c| c.is_ascii_digit()));
            if hit {
                out.push(format!("/dev/{name}"));
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/* ================= 受限文件访问 ================= */

/// 允许读写的路径白名单：通知日志（log_file 配置键）与 /tmp 下的 mt5700 专属文件。
fn file_allowed(path: &str) -> bool {
    let p = path.trim();
    if p.is_empty() || p.contains("..") {
        return false;
    }
    if p.starts_with("/tmp/mt5700") || p == "/tmp/at-notifications.log" || p.starts_with("/tmp/at-notifications") {
        return true;
    }
    /* log_file 配置键指向的通知日志 */
    match std::fs::read_to_string(configstore::config_path()) {
        Ok(text) => {
            if let Ok(map) = serde_json::from_str::<serde_json::Map<String, Value>>(&text) {
                if let Some(Some(log_file)) = map.get("log_file").map(|v| v.as_str()) {
                    if !log_file.is_empty() && p == log_file {
                        return true;
                    }
                }
            }
            false
        }
        Err(_) => false,
    }
}

fn file_read(path: &str) -> Response {
    if !file_allowed(path) {
        return err_json(403, "路径不在允许范围内（仅限通知日志与 /tmp/mt5700*）");
    }
    match std::fs::read_to_string(path) {
        Ok(data) => ok_json(json!({ "data": data })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ok_json(json!({ "data": "" })),
        Err(e) => err_json(500, &format!("读取失败: {e}")),
    }
}

fn file_write(path: &str, data: &str) -> Response {
    if !file_allowed(path) {
        return err_json(403, "路径不在允许范围内（仅限通知日志与 /tmp/mt5700*）");
    }
    match std::fs::write(path, data.as_bytes()) {
        Ok(()) => ok_json(json!({ "ok": true })),
        Err(e) => err_json(500, &format!("写入失败: {e}")),
    }
}

fn file_list(path: &str) -> Response {
    /* 仅允许列 /dev（串口识别用途） */
    if path.trim_end_matches('/') != "/dev" {
        return err_json(403, "仅允许列出 /dev");
    }
    let mut entries: Vec<Value> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(path) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let kind = if e.path().is_dir() { "directory" } else { "file" };
            entries.push(json!({ "name": name, "type": kind }));
        }
    }
    ok_json(json!({ "entries": entries }))
}

fn file_stat(path: &str) -> Response {
    let p = path.trim();
    if p.contains("..") || !(p.starts_with("/dev/") || p.starts_with("/usr/bin/")) {
        return err_json(403, "仅允许 stat /dev 与 /usr/bin 下的路径");
    }
    match std::fs::metadata(p) {
        Ok(md) => ok_json(json!({
            "type": if md.is_dir() { "directory" } else { "file" },
            "size": md.len(),
            "mode": 0o755,
        })),
        Err(_) => ok_json(Value::Null),
    }
}

/* ================= HTTP 基础设施 ================= */

async fn read_request<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
) -> Result<Option<Request>, String> {
    /* 读请求头（直到空行） */
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let n = reader.read(&mut byte).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(None); /* 连接关闭 */
        }
        head.push(byte[0]);
        if head.len() >= 4 && &head[head.len() - 4..] == b"\r\n\r\n" {
            break;
        }
        if head.len() > 32 * 1024 {
            return Err("请求头过大".to_string());
        }
    }
    let head = String::from_utf8_lossy(&head).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_uppercase();
    let target = parts.next().unwrap_or("/").to_string();
    if method.is_empty() {
        return Err("无效请求行".to_string());
    }

    let mut headers = Vec::new();
    for line in lines {
        if let Some(colon) = line.find(':') {
            headers.push((line[..colon].trim().to_string(), line[colon + 1..].trim().to_string()));
        }
    }

    /* 路径与查询串 */
    let (path, query_str) = match target.find('?') {
        Some(i) => (target[..i].to_string(), target[i + 1..].to_string()),
        None => (target.clone(), String::new()),
    };
    let mut query = HashMap::new();
    for kv in query_str.split('&') {
        if let Some(eq) = kv.find('=') {
            query.insert(url_decode(&kv[..eq]), url_decode(&kv[eq + 1..]));
        } else if !kv.is_empty() {
            query.insert(url_decode(kv), String::new());
        }
    }

    /* 请求体 */
    let content_length = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_BODY {
        return Err("请求体过大".to_string());
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body).await.map_err(|e| e.to_string())?;
    }

    Ok(Some(Request { method, path, query, headers, body }))
}

async fn write_response(w: &mut tokio::net::tcp::OwnedWriteHalf, resp: Response) -> std::io::Result<()> {
    let status_text = match resp.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Unknown",
    };
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n",
        resp.status,
        status_text,
        resp.content_type,
        resp.body.len(),
        if resp.no_cache { "Cache-Control: no-cache\r\n" } else { "Cache-Control: max-age=300\r\n" },
    );
    w.write_all(head.as_bytes()).await?;
    w.write_all(&resp.body).await?;
    w.flush().await
}

fn content_type(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 3 <= bytes.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/* ================= WebSocket ================= */

/// RFC 6455 握手应答键：base64(sha1(key + GUID))。
fn ws_accept_key(client_key: &str) -> String {
    const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    let digest = sha1(format!("{client_key}{GUID}").as_bytes());
    base64_encode(&digest)
}

/// 精简 SHA-1 实现（仅用于 WebSocket 握手，非安全用途）。
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for (i, word) in chunk.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let tmp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = tmp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }

    let mut out = [0u8; 20];
    for (i, v) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 编码一个服务端文本帧（不掩码）。
fn ws_frame_text(payload: &[u8]) -> Vec<u8> {
    let mut frame = vec![0x81u8]; /* FIN + text */
    let len = payload.len();
    if len < 126 {
        frame.push(len as u8);
    } else if len <= 0xFFFF {
        frame.push(126);
        frame.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        frame.push(127);
        frame.extend_from_slice(&(len as u64).to_be_bytes());
    }
    frame.extend_from_slice(payload);
    frame
}

/// WebSocket 服务：推送事件总线增量（400ms 批量轮询），处理 ping/close。
async fn ws_serve(
    rpc: Arc<RpcServer>,
    mut write: tokio::net::tcp::OwnedWriteHalf,
    ctx: tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    crate::log_debug!("WebSocket 客户端接入");
    /* 首次对齐到当前最新序号，不重放历史事件 */
    let (latest, _) = rpc.events_since(0).await;
    let mut seq = latest;

    let mut ctx_c = ctx.clone();
    let mut ping_timer = tokio::time::interval(Duration::from_secs(30));
    ping_timer.tick().await; /* 首个 tick 立即返回，跳过 */

    loop {
        tokio::select! {
            _ = ctx_c.changed() => break,
            _ = ping_timer.tick() => {
                let ping = vec![0x89u8, 0x00]; /* ping, 空 payload */
                if write.write_all(&ping).await.is_err() {
                    break;
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(400)) => {
                let (latest, events) = rpc.events_since(seq).await;
                if latest > seq {
                    seq = latest;
                }
                let mut sent = 0usize;
                for ev in &events {
                    let payload = match serde_json::to_vec(ev) {
                        Ok(p) => p,
                        Err(_) => continue,
                    };
                    let frame = ws_frame_text(&payload);
                    if write.write_all(&frame).await.is_err() {
                        return Ok(());
                    }
                    sent += 1;
                }
                if sent > 0 {
                    write.flush().await.ok();
                }
            }
        }
    }
    /* 发送 close 帧 */
    let _ = write.write_all(&[0x88u8, 0x00]).await;
    let _ = write.flush().await;
    Ok(())
}
