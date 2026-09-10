//! AT 客户端：维护到模组的唯一连接。
//!
//! 与 Go 实现完全一致的语义：
//! - 只有一个任务读取通道，命令应答与主动上报在同一处解复用；
//! - 命令串行执行（100ms 最小间隔），2 秒超时，最多保留 2048 行；
//! - 空闲期收到的数据视为主动上报（raw_data 推给前端）；
//! - 有命令等待时，只把「绝不可能是查询结果」的行（^REJINFO/+CUSD 等）截出来；
//! - `abcd` 打断绕过命令锁直接写入（供扫频使用）。

use crate::{log_info, log_warn};
use crate::config::AtConfig;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex, Notify};

const COMMAND_GAP: Duration = Duration::from_millis(100);
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
const READ_BUF_SIZE: usize = 4096;
const MAX_RESPONSE_LINES: usize = 2048;
const MAX_RESIDUAL_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct AtResponse {
    pub lines: Vec<String>,
}

impl AtResponse {
    pub fn text(&self) -> String {
        self.lines.join("\r\n")
    }
    pub fn ok(&self) -> bool {
        self.lines.iter().any(|l| l == "OK")
    }
    pub fn has_error(&self) -> bool {
        self.text().to_uppercase().contains("ERROR")
    }
    pub fn contains(&self, sub: &str) -> bool {
        self.text().contains(sub)
    }
}

/// 一条模组主动上报。broadcast 为真表示需要作为 raw_data 推给前端。
#[derive(Debug)]
pub struct Unsolicited {
    pub line: String,
    pub broadcast: bool,
}

/// 一条正在等待应答的命令。
pub struct PendingCmd {
    pub echo: String,
    pub lines: Vec<String>,
    pub done: Arc<Notify>,
    /// 非空时每收到一行应答就回调一次（^CELLSCAN 边扫边显示用）。
    pub stream: Option<Box<dyn Fn(String) + Send + Sync>>,
}

#[allow(dead_code)] // describe 保留给诊断输出
pub struct Connection {
    writer: Arc<Mutex<Box<dyn tokio::io::AsyncWrite + Unpin + Send>>>,
    describe: String,
}

pub struct AtClient {
    cfg: AtConfig,

    conn: Arc<Mutex<Option<Connection>>>,
    /// 连接标志（原子，供 Scheduler 等异步任务安全读取，替代阻塞式取锁）。
    connected_flag: Arc<AtomicBool>,
    urc_tx: mpsc::Sender<Unsolicited>,

    cmd_mu: Arc<Mutex<()>>,
    long_cmd: Arc<AtomicI32>,
    long_cmd_end: Arc<AtomicI64>,
    last_cmd_at: Arc<Mutex<Instant>>,

    pending: Arc<Mutex<Option<PendingCmd>>>,
}

impl AtClient {
    pub fn new(cfg: AtConfig, urc_tx: mpsc::Sender<Unsolicited>) -> Arc<Self> {
        Arc::new(AtClient {
            cfg,
            conn: Arc::new(Mutex::new(None)),
            connected_flag: Arc::new(AtomicBool::new(false)),
            urc_tx,
            cmd_mu: Arc::new(Mutex::new(())),
            long_cmd: Arc::new(AtomicI32::new(0)),
            long_cmd_end: Arc::new(AtomicI64::new(0)),
            last_cmd_at: Arc::new(Mutex::new(Instant::now())),
            pending: Arc::new(Mutex::new(None)),
        })
    }

    pub fn connection_type(&self) -> &str {
        &self.cfg.type_
    }

    pub fn connected(&self) -> bool {
        // 纯原子读取：绝不能在这里取锁阻塞（Scheduler 在异步循环中调用）。
        self.connected_flag.load(Ordering::Relaxed)
    }

    /// 连接、重连与读循环，直到 ctx 结束。
    pub async fn run(self: Arc<Self>, ctx: tokio::sync::watch::Receiver<bool>) {
        let mut backoff = Duration::from_secs(5);
        let max_backoff = Duration::from_secs(60);

        while !*ctx.borrow() {
            let tp = match crate::transport::open_transport(&self.cfg).await {
                Ok(tp) => tp,
                Err(e) => {
                    log_warn!("连接模组失败，{} 后重试: {}", humandur(backoff), e);
                    if !sleep_ctx(&ctx, backoff).await {
                        return;
                    }
                    if backoff < max_backoff {
                        backoff += Duration::from_secs(5);
                    }
                    continue;
                }
            };

            log_info!("已连接到 {}", tp.describe());
            backoff = Duration::from_secs(5);

            let describe = tp.describe();
            let parts = tp.into_parts();
            let (reader, writer) = (parts.reader, parts.writer);
            let conn = Connection {
                writer: Arc::new(Mutex::new(writer)),
                describe,
            };
            *self.conn.lock().await = Some(conn);
            self.connected_flag.store(true, Ordering::Relaxed);

            // 初始化命令要在读循环起来之后发，否则等不到应答。
            let read_ctx = ctx.clone();
            let init_ctx = ctx.clone();
            let read_done = {
                let client = self.clone();
                tokio::spawn(async move { client.read_loop(&read_ctx, reader).await })
            };
            let init = {
                let client = self.clone();
                tokio::spawn(async move { client.init_modem(&init_ctx).await })
            };

            let mut ctx_c = ctx.clone();
            tokio::select! {
                r = read_done => {
                    if let Err(e) = r {
                        log_warn!("模组连接中断: {}", e);
                    }
                }
                _ = ctx_c.changed() => {}
            }
            let _ = init.await;
            self.teardown().await;

            if !*ctx.borrow() && !sleep_ctx(&ctx, Duration::from_secs(2)).await {
                return;
            }
        }
    }

    async fn teardown(&self) {
        self.connected_flag.store(false, Ordering::Relaxed);
        let mut guard = self.conn.lock().await;
        guard.take(); // drop transport → 读循环退出
        drop(guard);

        // 让等待中的命令立刻失败，而不是干等超时。
        let pending = self.pending.lock().await.take();
        if let Some(p) = pending {
            p.done.notify_one();
        }
    }

    async fn init_modem(self: Arc<Self>, ctx: &tokio::sync::watch::Receiver<bool>) {
        // 手册 3.14：置 2 后错误返回描述字符串，界面上能显示具体原因。
        if let Err(e) = self.send_command(ctx, "AT+CMEE=2", COMMAND_TIMEOUT, None).await {
            log_warn!("开启详细错误码失败: {}", e);
        }
        // 短信走 PDU 模式并开启新短信主动上报，来电开启号码显示。
        if let Ok(resp) = self.send_command(ctx, "AT+CNMI?", COMMAND_TIMEOUT, None).await {
            if !resp.contains("+CNMI: 2,1,0,2,0") {
                if let Err(e) = self.send_command(ctx, "AT+CNMI=2,1,0,2,0", COMMAND_TIMEOUT, None).await {
                    log_warn!("设置短信上报模式失败: {}", e);
                }
            }
        }
        if let Ok(resp) = self.send_command(ctx, "AT+CMGF?", COMMAND_TIMEOUT, None).await {
            if !resp.contains("+CMGF: 0") {
                if let Err(e) = self.send_command(ctx, "AT+CMGF=0", COMMAND_TIMEOUT, None).await {
                    log_warn!("设置短信 PDU 模式失败: {}", e);
                }
            }
        }
        if let Err(e) = self.send_command(ctx, "AT+CLIP=1", COMMAND_TIMEOUT, None).await {
            log_warn!("开启来电号码显示失败: {}", e);
        }
    }

    /// 串行发送一条 AT 命令并等待结束码。
    pub async fn send_command(
        &self,
        ctx: &tokio::sync::watch::Receiver<bool>,
        command: &str,
        timeout: Duration,
        stream: Option<Box<dyn Fn(String) + Send + Sync>>,
    ) -> Result<AtResponse, String> {
        self.send_command_inner(ctx, command, timeout, stream).await
    }

    /// 扫频一类长命令：可指定超时，并通过 stream 实时拿到每一行应答。
    pub async fn send_long_command(
        &self,
        ctx: &tokio::sync::watch::Receiver<bool>,
        command: &str,
        timeout: Duration,
        stream: Option<Box<dyn Fn(String) + Send + Sync>>,
    ) -> Result<AtResponse, String> {
        self.long_cmd.fetch_add(1, Ordering::SeqCst);
        let result = self.send_command_inner(ctx, command, timeout, stream).await;
        self.long_cmd_end.store(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos() as i64,
            Ordering::SeqCst,
        );
        self.long_cmd.fetch_sub(1, Ordering::SeqCst);
        result
    }

    pub fn long_command_active(&self) -> bool {
        self.long_cmd.load(Ordering::SeqCst) > 0
    }

    pub fn long_command_ended_at(&self) -> Option<Instant> {
        let ns = self.long_cmd_end.load(Ordering::SeqCst);
        if ns == 0 {
            return None;
        }
        Some(Instant::now() - Duration::from_nanos((std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as i64
            - ns) as u64))
    }

    /// 绕过命令锁直接向模组写入原始字符串（打断扫频用）。
    pub async fn interrupt(&self, payload: &str) -> Result<(), String> {
        let writer = {
            let guard = self.conn.lock().await;
            match &*guard {
                Some(c) => c.writer.clone(),
                None => return Err("AT 通道未连接".into()),
            }
        };

        let has_pending = self.pending.lock().await.is_some();
        if !has_pending {
            return Err("当前没有可打断的命令".into());
        }

        let mut payload = payload.to_string();
        if !payload.ends_with('\r') {
            payload.push('\r');
        }
        let mut w = writer.lock().await;
        w.write_all(payload.as_bytes()).await.map_err(|e| {
            log_warn!("写入打断字符串失败: {}", e);
            e.to_string()
        })?;
        Ok(())
    }

    async fn send_command_inner(
        &self,
        ctx: &tokio::sync::watch::Receiver<bool>,
        command: &str,
        timeout: Duration,
        stream: Option<Box<dyn Fn(String) + Send + Sync>>,
    ) -> Result<AtResponse, String> {
        let _cmd_guard = self.cmd_mu.lock().await;

        // 两条命令之间最小间隔。
        {
            let last = self.last_cmd_at.lock().await;
            let gap = COMMAND_GAP.saturating_sub(last.elapsed());
            if !gap.is_zero() {
                let mut ctx_c = ctx.clone();
                tokio::select! {
                    _ = tokio::time::sleep(gap) => {}
                    _ = ctx_c.changed() => return Err("上下文取消".into()),
                }
            }
        }

        let conn = {
            let guard = self.conn.lock().await;
            match &*guard {
                Some(c) => c.writer.clone(),
                None => return Err("AT 通道未连接".into()),
            }
        };

        let mut cmd = command.to_string();
        if !cmd.ends_with('\r') {
            cmd.push('\r');
        }

        let done = Arc::new(Notify::new());
        let pending = PendingCmd {
            echo: cmd.trim().to_string(),
            lines: Vec::new(),
            done: done.clone(),
            stream,
        };
        *self.pending.lock().await = Some(pending);

        // 先创建 notified 再写入，避免应答先到而错过通知。
        let notified = done.notified();
        {
            let mut w = conn.lock().await;
            if let Err(e) = w.write_all(cmd.as_bytes()).await {
                log_warn!("写入 AT 命令失败: {}", e);
                self.pending.lock().await.take();
                return Err(e.to_string());
            }
        }
        *self.last_cmd_at.lock().await = Instant::now();

        let mut ctx_c = ctx.clone();
        tokio::select! {
            _ = notified => {}
            _ = tokio::time::sleep(timeout) => {}
            _ = ctx_c.changed() => {
                self.pending.lock().await.take();
                return Err("上下文取消".into());
            }
        }

        let pending = self.pending.lock().await.take();
        let lines = pending.map(|p| p.lines).unwrap_or_default();

        if lines.is_empty() {
            Err("模组无响应".into())
        } else {
            Ok(AtResponse { lines })
        }
    }

    /// 唯一读取模组的地方。阻塞在 tokio netpoller 上，空闲时不占 CPU。
    async fn read_loop(
        self: Arc<Self>,
        ctx: &tokio::sync::watch::Receiver<bool>,
        mut reader: Box<dyn tokio::io::AsyncRead + Unpin + Send>,
    ) -> Result<(), String> {
        let mut buf = vec![0u8; READ_BUF_SIZE];
        let mut residual: Vec<u8> = Vec::new();

        loop {
            let mut ctx_c = ctx.clone();
            let n = tokio::select! {
                r = reader.read(&mut buf) => match r {
                    Ok(n) => n,
                    Err(e) => return Err(e.to_string()),
                },
                _ = ctx_c.changed() => return Ok(()),
            };
            if n == 0 {
                return Ok(()); // EOF
            }
            residual.extend_from_slice(&buf[..n]);
            residual = self.consume(residual).await;
        }
    }

    /// 从缓冲里切出完整行并派发，返回尚未成行的剩余字节。
    async fn consume(&self, mut data: Vec<u8>) -> Vec<u8> {
        loop {
            let nl = data.iter().position(|&b| b == b'\n');
            match nl {
                Some(i) => {
                    let line = String::from_utf8_lossy(&data[..i]).trim().to_string();
                    data.drain(..=i);
                    self.handle_line(line).await;
                }
                None => break,
            }
        }

        // AT+CMGS 的输入提示符 "> " 后面没有换行，单独识别成一次应答结束。
        if data.iter().all(|b| b.is_ascii_whitespace() || *b == b'>') && data.contains(&b'>') {
            let mut pending = self.pending.lock().await;
            if let Some(p) = pending.as_mut() {
                p.lines.push(">".into());
            }
            if let Some(p) = pending.as_ref() {
                p.done.notify_one();
            }
            return Vec::new();
        }

        if data.len() > MAX_RESIDUAL_BYTES {
            log_warn!("丢弃 {} 字节无法成行的数据", data.len());
            return Vec::new();
        }
        data
    }

    async fn handle_line(&self, line: String) {
        if line.is_empty() {
            return;
        }

        let (has_pending, is_excl, is_passthrough) = {
            let mut pending = self.pending.lock().await;
            if let Some(p) = pending.as_mut() {
                if line != p.echo && p.lines.len() < MAX_RESPONSE_LINES {
                    p.lines.push(line.clone());
                    // 流式回调（扫频用）。Broadcast 走 try_send 不阻塞，锁内调用安全。
                    if let Some(cb) = p.stream.as_ref() {
                        cb(line.clone());
                    }
                }
                if is_terminator(&line) {
                    p.done.notify_one();
                }
                (true, is_exclusive_urc(&line), is_passthrough_urc(&line))
            } else {
                (false, false, false)
            }
        };

        if !has_pending {
            // 空闲期收到的任何数据都视为主动上报：交给处理器，并按原样推给前端。
            // 与 Go 实现一致（Go handleLine: p == nil 时 broadcast: true）。
            self.emit(Unsolicited { line, broadcast: true }).await;
            return;
        }

        // 有命令等待时，只把「绝不可能是查询结果」的行交给处理器。
        // 比如 ^HCSQ: 既是主动上报也是 AT^HCSQ? 的应答，不能在这里截走，
        // 否则前端的信号显示会拿不到数据。
        if is_excl {
            self.emit(Unsolicited { line, broadcast: is_passthrough }).await;
        }
    }

    async fn emit(&self, u: Unsolicited) {
        if let Err(_e) = self.urc_tx.send(u).await {
            // 队列关闭（服务退出）时忽略
        }
    }
}

pub fn is_terminator(line: &str) -> bool {
    match line {
        "OK" | "ERROR" | "ABORTED" => return true,
        _ => {}
    }
    line.starts_with("+CMS ERROR:") || line.starts_with("+CME ERROR:")
}

/// 只匹配不可能出现在查询应答里的主动上报。
pub fn is_exclusive_urc(line: &str) -> bool {
    match line {
        "RING" | "IRING" | "^IRING" | "NO CARRIER" => return true,
        _ => {}
    }
    if line.starts_with("+CMTI:")
        || line.starts_with("^CEND:")
        || line.starts_with("^SMMEMFULL")
        || line.contains("MEMORY FULL")
        || line.contains("CMS ERROR: 322")
    {
        return true;
    }
    // 带引号的 +CLIP: 是来电上报；AT+CLIP? 的应答形如 "+CLIP: 1,1"，不会命中。
    if line.starts_with("+CLIP:") && line.contains('"') {
        return true;
    }
    is_passthrough_urc(line)
}

/// 没有结构化推送、必须原样转给前端的主动上报。
pub fn is_passthrough_urc(line: &str) -> bool {
    if line.starts_with("^REJINFO") {
        return true;
    }
    line.starts_with("+CUSD:") && line.contains(',')
}

async fn sleep_ctx(ctx: &tokio::sync::watch::Receiver<bool>, d: Duration) -> bool {
    let mut ctx_c = ctx.clone();
    tokio::select! {
        _ = tokio::time::sleep(d) => true,
        _ = ctx_c.changed() => false,
    }
}

pub fn humandur(d: Duration) -> String {
    format!("{}s", d.as_secs())
}
