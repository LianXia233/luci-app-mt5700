//! AT 客户端：维护到模组的唯一连接。
//!
//! 与 Go 实现完全一致的语义：
//! - 只有一个任务读取通道，命令应答与主动上报在同一处解复用；
//! - 命令串行执行（100ms 最小间隔），2 秒超时，最多保留 2048 行；
//! - 空闲期收到的数据视为主动上报（raw_data 推给前端）；
//! - 有命令等待时，只把「绝不可能是查询结果」的行（^REJINFO/+CUSD 等）截出来；
//! - `abcd` 打断绕过命令锁直接写入（供扫频使用）。

use crate::{log_debug, log_info, log_warn};
use crate::config::AtConfig;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex, Notify};

const COMMAND_GAP: Duration = Duration::from_millis(100);
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
/// 等待命令锁的独立预算。
///
/// 背景（AT 终端「只有 ATI 有回复」的根因）：
/// 服务启动/重连时会先跑 `init_modem()` 的一串初始化和自动拨号对齐命令，
/// 这些命令全程持有 `cmd_mu`。此前 `send_command_inner` 的超时是从进入函数
/// 就开始计时的，于是用户的终端命令会把整个预算消耗在「排队等锁」上，
/// 2 秒一到就返回「模组无响应」——而模组其实什么都没收到。
/// 表现为：服务刚起或刚重连的那段时间，除最先发的一条外全都没有回复。
///
/// 修复思路：把「排队（等锁 + 命令间隔）」与「等应答」拆成两段独立预算。
/// 排队最多等 QUEUE_WAIT_TIMEOUT；真正写入模组之后，再按 timeout 等应答。
/// 这样排队慢不会再吃掉应答时间，用户看到的是真实结果而不是假超时。
pub const QUEUE_WAIT_TIMEOUT: Duration = Duration::from_secs(8);
const READ_BUF_SIZE: usize = 4096;
const MAX_RESPONSE_LINES: usize = 2048;
const MAX_RESIDUAL_BYTES: usize = 64 * 1024;
/// 读到 0 字节时的让步间隔（详见 read_loop 内注释）。
const ZERO_READ_BACKOFF: Duration = Duration::from_millis(50);
/// 连续 0 字节读达到该次数才判定链路断开（50ms × 20 ≈ 1s）。
const ZERO_READ_RETRY_LIMIT: u32 = 20;

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

/// 从 `AT^SETAUTODIAL?` 的应答里取出「开关」与「拨号方式」。
///
/// 手册回显形如 `^SETAUTODIAL: 1,1,"IP","cmnet","","",0`：
///   字段 1 = 开关（0=关 / 1=开）
///   字段 2 = 拨号方式（1=USB 网络接口 / 2=转网口模式）
/// 部分固件只回 `^SETAUTODIAL: 1`，此时方式为 None（表示「无法判定」，不是「不匹配」）。
/// 解析失败返回 None，调用方据此决定是否直接下发设置。
///
/// 为什么必须把方式一起解析出来：只看开关会造成
/// 「开关已是 1、但方式停在 2（转网口模式）」时直接跳过下发，
/// 而期望是 1（USB 网络接口）——USB 网口永远收不到模组下发的 DHCP，
/// MT5700M 接口长期没有 IP。这是「模组在线却上不了网」的一条独立成因。
fn parse_autodial_state(text: &str) -> Option<(bool, Option<i64>)> {
    for line in text.replace('\r', "").lines() {
        let line = line.trim();
        if !line.starts_with("^SETAUTODIAL:") {
            continue;
        }
        let payload = line[line.find(':')? + 1..].trim();
        let mut parts = payload.split(',');
        let first = parts.next()?.trim().trim_matches('"');
        if first.is_empty() {
            return None;
        }
        let enable = match first {
            "0" => false,
            "1" => true,
            _ => return None,
        };
        let mode = parts
            .next()
            .map(|s| s.trim().trim_matches('"'))
            .and_then(|s| s.parse::<i64>().ok())
            .filter(|m| *m == 1 || *m == 2);
        return Some((enable, mode));
    }
    None
}

/// 从 `AT^NDISSTATQRY?` 应答取 USB 数据面状态（首字段 1=就绪）。
/// 拿不到可判定字段时返回 None（表示无法判定，而不是「未就绪」）。
fn parse_ndis_state(text: &str) -> Option<bool> {
    for line in text.replace('\r', "").lines() {
        let line = line.trim();
        if !line.starts_with("^NDISSTATQRY:") {
            continue;
        }
        let payload = line[line.find(':')? + 1..].trim();
        let first = payload.split(',').next()?.trim().trim_matches('"');
        return match first {
            "0" => Some(false),
            "1" => Some(true),
            _ => None,
        };
    }
    None
}

/// 从 `AT+CGACT?` 应答判断是否存在任一已激活的 PDP 上下文。
/// 拿不到 `+CGACT:` 行时返回 None（无法判定）。
fn parse_cgact_active(text: &str) -> Option<bool> {
    let mut saw = false;
    let mut any_active = false;
    for line in text.replace('\r', "").lines() {
        let line = line.trim();
        if !line.starts_with("+CGACT:") {
            continue;
        }
        saw = true;
        let payload = line[line.find(':')? + 1..].trim();
        let mut it = payload.split(',');
        let _cid = it.next();
        if let Some(state) = it.next() {
            if state.trim() == "1" {
                any_active = true;
            }
        }
    }
    if saw {
        Some(any_active)
    } else {
        None
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

        // 拨号守护只起一次，跨重连存活：按 connected_flag 判断是否工作，
        // 断开时自动跳过。若改为每次重连都 spawn，会随重连次数叠加任务。
        {
            let client = self.clone();
            let ctx_w = ctx.clone();
            tokio::spawn(async move { client.autodial_watchdog(ctx_w).await });
        }

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
        // 错误判定说明：send_command 只在「链路层」失败（未连接、写失败、超时）返回 Err；
        // 模组回 ERROR / +CME ERROR 时它返回的是 Ok(resp)（lines 里含错误行）。
        // 因此每条设置命令都必须显式检查 resp.ok()，否则「模组拒绝该命令」会被静默吞掉，
        // 排障时只看到后续功能不正常而没有任何线索。
        match self.send_command(ctx, "AT+CMEE=2", COMMAND_TIMEOUT, None).await {
            Ok(resp) if resp.ok() => {}
            Ok(resp) => log_warn!("开启详细错误码未返回 OK: {}", resp.text()),
            Err(e) => log_warn!("开启详细错误码失败: {}", e),
        }
        // 短信走 PDU 模式并开启新短信主动上报，来电开启号码显示。
        // 与 Go 一致：查询失败或不含目标值时都要 SET，避免模组刚连上超时导致模式未启用。
        match self.send_command(ctx, "AT+CNMI?", COMMAND_TIMEOUT, None).await {
            Ok(resp) if resp.contains("+CNMI: 2,1,0,2,0") => {}
            _ => match self.send_command(ctx, "AT+CNMI=2,1,0,2,0", COMMAND_TIMEOUT, None).await {
                Ok(resp) if resp.ok() => {}
                Ok(resp) => log_warn!("设置短信上报模式未返回 OK: {}", resp.text()),
                Err(e) => log_warn!("设置短信上报模式失败: {}", e),
            },
        }
        match self.send_command(ctx, "AT+CMGF?", COMMAND_TIMEOUT, None).await {
            Ok(resp) if resp.contains("+CMGF: 0") => {}
            _ => match self.send_command(ctx, "AT+CMGF=0", COMMAND_TIMEOUT, None).await {
                Ok(resp) if resp.ok() => {}
                Ok(resp) => log_warn!("设置短信 PDU 模式未返回 OK: {}", resp.text()),
                Err(e) => log_warn!("设置短信 PDU 模式失败: {}", e),
            },
        }
        match self.send_command(ctx, "AT+CLIP=1", COMMAND_TIMEOUT, None).await {
            Ok(resp) if resp.ok() => {}
            Ok(resp) => log_warn!("开启来电号码显示未返回 OK: {}", resp.text()),
            Err(e) => log_warn!("开启来电号码显示失败: {}", e),
        }

        // 自动拨号默认开启（UCI autodial_enable 默认 1）。
        // 放在最后：前面的设置类命令失败不应阻止拨号，否则设备会一直没有 IP。
        // 内部含退避重试，覆盖「AT 已通但驻网/PDP 尚未完成」的冷启动窗口。
        self.ensure_autodial(ctx).await;
    }

    /// 确保自动拨号处于期望状态（开关 + 拨号方式）。
    ///
    /// 「模块显示在线但接口拿不到 IP」的根因链：
    ///   模组已注册网络（AT 通、有信号）→ 但 ^SETAUTODIAL 未开启 →
    ///   模组不向 USB 网口下发 DHCP → eth2 一直是 NO-CARRIER/DHCP 无应答 →
    ///   netifd 的 MT5700M 接口没有 IP → 无法联网。
    ///
    /// 两个容易踩的坑（此前各造成一类「长期无 IP」）：
    ///   1) 只比开关不比方式：模组停在方式 2（转网口）而期望方式 1（USB 网口）时会直接跳过；
    ///   2) 只对齐一次且失败只记日志：冷启动时 AT 通道往往早于驻网可用，
    ///      第一次下发失败后不再重试，链路一直稳定的话永远等不到自愈。
    /// 因此这里做**带退避的重试**（最长约 4 分钟），并在复核阶段确认数据面。
    async fn ensure_autodial(self: &Arc<Self>, ctx: &tokio::sync::watch::Receiver<bool>) {
        let desired = self.cfg.autodial_enable;
        let mode = self.cfg.autodial_mode.clamp(1, 2);

        // 退避序列覆盖冷启动窗口：0s / 5s / 15s / 30s / 60s / 120s。
        // 单次尝试内部不持有命令锁（只在真正收发时持有），不会阻塞用户命令。
        let delays = [
            Duration::from_secs(0),
            Duration::from_secs(5),
            Duration::from_secs(15),
            Duration::from_secs(30),
            Duration::from_secs(60),
            Duration::from_secs(120),
        ];
        let total = delays.len();
        for (attempt, delay) in delays.iter().enumerate() {
            if !delay.is_zero() && !sleep_ctx(ctx, *delay).await {
                return;
            }
            if self.align_autodial_once(ctx, desired, mode).await {
                if attempt > 0 {
                    log_info!("自动拨号在第 {} 次尝试后达成期望状态", attempt + 1);
                }
                return;
            }
            if attempt + 1 < total {
                log_warn!("自动拨号尚未达成期望状态（第 {} 次尝试），稍后重试", attempt + 1);
            }
        }
        log_warn!(
            "自动拨号连续 {} 次未能达成期望状态（enable={} mode={}），\
             交由周期对账或下一次链路重连继续处理；请检查模组是否已驻网",
            total,
            desired as i32,
            mode
        );
    }

    /// 单次对齐：查询 → 必要时下发 → 复核 + 数据面确认。返回是否已达成期望状态。
    async fn align_autodial_once(
        self: &Arc<Self>,
        ctx: &tokio::sync::watch::Receiver<bool>,
        desired: bool,
        mode: i64,
    ) -> bool {
        // 1) 查询当前状态；查询失败也继续尝试下发，避免模组刚连上超时导致不拨号。
        let current = match self.send_command(ctx, "AT^SETAUTODIAL?", COMMAND_TIMEOUT, None).await {
            Ok(resp) => parse_autodial_state(&resp.text()),
            Err(e) => {
                log_warn!("查询自动拨号状态失败，将直接下发设置: {}", e);
                None
            }
        };

        // 开关必须一致；方式只在「模组明确回了方式」且与期望不符时才算未达成。
        // 模组未回方式字段（None）视为无法判定，不据此反复下发打断已建立的上下文。
        if let Some((enable, cur_mode)) = current {
            let mode_ok = !desired || cur_mode.is_none() || cur_mode == Some(mode);
            if enable == desired && mode_ok {
                log_info!(
                    "自动拨号已处于期望状态（enable={}, mode={:?}），不重复下发",
                    desired as i32,
                    cur_mode
                );
                notify_uplink_ready().await;
                return true;
            }
            if enable == desired && !mode_ok {
                log_warn!(
                    "自动拨号开关已开但拨号方式不符（实际 {:?}，期望 {}），将重新下发",
                    cur_mode,
                    mode
                );
            }
        }

        // 2) 下发。开启时带上拨号方式；关闭时不带参数（与手册及前端 dial.js 一致）。
        let cmd = if desired {
            format!("AT^SETAUTODIAL=1,{}", mode)
        } else {
            "AT^SETAUTODIAL=0".to_string()
        };
        match self.send_command(ctx, &cmd, COMMAND_TIMEOUT, None).await {
            Ok(resp) if resp.ok() => {
                log_info!("已{}自动拨号（{}）", if desired { "开启" } else { "关闭" }, cmd);
            }
            Ok(resp) => {
                log_warn!("自动拨号设置未返回 OK: {}", resp.text());
            }
            Err(e) => {
                log_warn!("自动拨号设置失败: {}（命令 {}）", e, cmd);
            }
        }

        // 3) 复核：确认设置真的生效。
        let verified = match self.send_command(ctx, "AT^SETAUTODIAL?", COMMAND_TIMEOUT, None).await {
            Ok(resp) => match parse_autodial_state(&resp.text()) {
                Some((enable, cur_mode)) => {
                    let mode_ok = !desired || cur_mode.is_none() || cur_mode == Some(mode);
                    if enable == desired && mode_ok {
                        log_info!("自动拨号状态复核通过（enable={}, mode={:?}）", enable as i32, cur_mode);
                        true
                    } else {
                        log_warn!(
                            "自动拨号状态复核不一致：期望 enable={} mode={}，实际 enable={} mode={:?}",
                            desired as i32,
                            mode,
                            enable as i32,
                            cur_mode
                        );
                        false
                    }
                }
                None => {
                    log_warn!("自动拨号状态复核无法解析: {}", resp.text());
                    false
                }
            },
            Err(e) => {
                log_warn!("自动拨号状态复核失败: {}", e);
                false
            }
        };
        if !verified {
            return false;
        }

        // 4) 数据面确认：开关为 1 不等于已经拨上。
        //    仅 USB 网口模式（mode=1）才用数据面判定——转网口模式的数据面在以太网口侧，
        //    模组的 NDIS/PDP 状态不能代表有网，不做强判定以免误报。
        if desired && mode == 1 && !self.pdp_ready(ctx).await {
            log_warn!("自动拨号已开启但数据面尚未就绪（PDP 未激活），将继续重试");
            return false;
        }
        notify_uplink_ready().await;
        true
    }

    /// 数据面是否就绪。先看 USB 网口状态，再回退看 PDP 激活位；
    /// 两条命令都给不出可判定信息时返回 true（宁可放过，也不要因判定工具缺失而反复下发）。
    async fn pdp_ready(self: &Arc<Self>, ctx: &tokio::sync::watch::Receiver<bool>) -> bool {
        if let Ok(resp) = self.send_command(ctx, "AT^NDISSTATQRY?", COMMAND_TIMEOUT, None).await {
            if let Some(state) = parse_ndis_state(&resp.text()) {
                if state {
                    return true;
                }
            }
        }
        if let Ok(resp) = self.send_command(ctx, "AT+CGACT?", COMMAND_TIMEOUT, None).await {
            if let Some(active) = parse_cgact_active(&resp.text()) {
                return active;
            }
        }
        true
    }

    /// 拨号守护：链路存活期间周期性对账，覆盖「首次对齐时模组尚未驻网」与
    /// 「运行中 PDP 被网络侧或模组释放」两类自愈场景。
    ///
    /// 设计要点：
    ///   - 整个进程只起一个守护（在 run() 里 spawn 一次，跨重连存活），
    ///     不会因为频繁重连而叠加任务；
    ///   - 仅在已连接时工作，断开则跳过，不产生无效 AT 命令；
    ///   - 每次先探数据面，就绪就什么都不做（稳态下每 5 分钟只发 1~2 条 AT），
    ///     避免「方式字段无法判定」时反复下发打断已建立的 PDP 上下文；
    ///   - 转网口模式（mode=2）的数据面不在 USB 网口上，不做该判定，直接跳过。
    async fn autodial_watchdog(self: Arc<Self>, ctx: tokio::sync::watch::Receiver<bool>) {
        const TICK: Duration = Duration::from_secs(60);
        const TICKS_PER_CHECK: u32 = 5;
        let mut ticks: u32 = 0;
        loop {
            if !sleep_ctx(&ctx, TICK).await {
                return;
            }
            if !self.connected() {
                ticks = 0;
                continue;
            }
            ticks += 1;
            if ticks < TICKS_PER_CHECK {
                continue;
            }
            ticks = 0;
            if !self.cfg.autodial_enable {
                continue;
            }
            if self.cfg.autodial_mode.clamp(1, 2) != 1 {
                continue;
            }
            if self.pdp_ready(&ctx).await {
                continue;
            }
            log_warn!("周期对账发现自动拨号数据面未就绪，重新对齐");
            self.ensure_autodial(&ctx).await;
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
        let now_ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as i64;
        if now_ns < ns {
            // 时钟回拨：视为刚结束
            return Some(Instant::now());
        }
        let delta = (now_ns - ns) as u64;
        Instant::now().checked_sub(Duration::from_nanos(delta))
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
        // 第一段预算：排队（等命令锁 + 最小命令间隔）。
        // 这段不计入应答超时，否则初始化/重连期间用户的命令会被误判为「模组无响应」。
        let _cmd_guard = {
            let mut ctx_c = ctx.clone();
            tokio::select! {
                g = self.cmd_mu.lock() => g,
                _ = tokio::time::sleep(QUEUE_WAIT_TIMEOUT) => {
                    return Err(format!(
                        "等待空闲通道超时（{}s）：模组正忙或正在重连，请稍后重试",
                        QUEUE_WAIT_TIMEOUT.as_secs()
                    ));
                }
                _ = ctx_c.changed() => return Err("上下文取消".into()),
            }
        };

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
        // 方向标记：这里是**唯一**真正写串口的地方，内部命令（初始化、自动拨号对齐）
        // 也走这条路径，所以在这一层记录才能完整反映"我们发给模组什么"。
        log_debug!("发送 → 模组: {}", cmd.trim());

        let mut ctx_c = ctx.clone();
        let mut answered = true;
        tokio::select! {
            _ = notified => {}
            _ = tokio::time::sleep(timeout) => { answered = false; }
            _ = ctx_c.changed() => {
                self.pending.lock().await.take();
                return Err("上下文取消".into());
            }
        }

        let pending = self.pending.lock().await.take();
        let lines = pending.map(|p| p.lines).unwrap_or_default();

        if !lines.is_empty() {
            // 应答可能很多行，只记「末行（结束码）+ 行数」，避免日志被刷爆；
            // 需要看全文时用 AT 终端页。
            log_debug!(
                "接收 ← 模组: {}（共 {} 行）",
                lines.last().map(|s| s.as_str()).unwrap_or(""),
                lines.len()
            );
            return Ok(AtResponse { lines });
        }
        if answered {
            // 收到过结束码但没攒到任何内容（例如模组只回一个空结束码）。
            Err(format!("模组未返回内容: {}", command.trim()))
        } else {
            Err(format!(
                "模组无响应（已等待 {}ms）: {}",
                timeout.as_millis(),
                command.trim()
            ))
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
        let mut zero_reads: u32 = 0;

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
                // 0 字节读的含义按通道区分：
                //   串口：serial_linux.rs 设 VMIN=1，无数据时 read 返回 EAGAIN（不会给 0），
                //         所以这里的 0 只可能是真 EOF（例如 USB 串口被拔出）；
                //   TCP ：0 表示对端已关闭连接。
                // 两种情况都按「链路断开」处理，但用连续多次重试兜住驱动的偶发行为：
                // 直接退出会让读循环刚连上就结束，此后所有 AT 命令都超时
                // （实机曾表现为「模组无响应」+ 每十几秒反复重连）。
                zero_reads += 1;
                if zero_reads >= ZERO_READ_RETRY_LIMIT {
                    return Ok(()); // 持续为 0：判定链路已断开，交给上层重连
                }
                let mut ctx_c = ctx.clone();
                tokio::select! {
                    _ = tokio::time::sleep(ZERO_READ_BACKOFF) => {}
                    _ = ctx_c.changed() => return Ok(()),
                }
                continue;
            }
            zero_reads = 0;

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
        // 队列满时丢弃而非阻塞：唯一读循环绝不能被 URC 背压卡住
        match self.urc_tx.try_send(u) {
            Ok(()) | Err(mpsc::error::TrySendError::Closed(_)) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                log_warn!("URC 队列已满，丢弃一条主动上报");
            }
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

/// 通知系统侧「拨号已就绪」，由本包提供的钩子脚本拉起承载接口。
///
/// 时序意义：接口侧（init.d / hotplug）无法知道模组何时真正拨号成功，
/// 只能靠开机时抢跑 + 猜时间窗口，冷启动很容易错过（实测整条链路
/// USB 枚举→驻网→下发 DHCP 常见 30~60s，而旧实现 35s 后即放弃）。
/// 这个通知让「拨号完成 → ifup 要地址」变成确定顺序。
///
/// 脚本不存在或执行失败都静默跳过：它是补充手段，兜底路径在 init.d 的重试
/// 与 hotplug 钩子里，缺了它功能仍然可用。
async fn notify_uplink_ready() {
    const HOOK: &str = "/usr/libexec/at-webserver/on-uplink.sh";
    if !std::path::Path::new(HOOK).exists() {
        return;
    }
    match tokio::process::Command::new(HOOK).status().await {
        Ok(st) if st.success() => log_info!("已通知系统侧拉起模组接口（{}）", HOOK),
        Ok(st) => log_warn!("拉起模组接口的钩子返回非零退出码: {:?}", st.code()),
        Err(e) => log_warn!("执行拉起模组接口的钩子失败: {}", e),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncRead, ReadBuf};

    /// 模拟「暂无数据时 read 返回 0 字节」的串口：先给若干次 0，再给出数据。
    struct ZeroThenData {
        zeros: u32,
        data: Vec<u8>,
    }

    impl AsyncRead for ZeroThenData {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            if self.zeros > 0 {
                self.zeros -= 1;
                return Poll::Ready(Ok(())); // 0 字节 = 暂无数据（非 EOF）
            }
            let n = self.data.len().min(buf.remaining());
            let chunk: Vec<u8> = self.data.drain(..n).collect();
            buf.put_slice(&chunk);
            Poll::Ready(Ok(()))
        }
    }

    /// 回归：0 字节读不能被当成 EOF，读循环必须继续并派发后续数据。
    #[tokio::test]
    async fn read_loop_survives_zero_reads() {
        let (tx, mut rx) = mpsc::channel::<Unsolicited>(8);
        let client = AtClient::new(crate::config::default_config().at, tx);
        let (_ctx_tx, ctx) = tokio::sync::watch::channel(false);

        let reader = ZeroThenData {
            zeros: 3,
            data: b"^HCSQ: 1,2,3,4\r\nOK\r\n".to_vec(),
        };
        let c = client.clone();
        let handle = tokio::spawn(async move { c.read_loop(&ctx, Box::new(reader)).await });

        let urc = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .expect("0 字节读之后读循环不应退出")
            .expect("应收到主动上报");
        assert_eq!(urc.line, "^HCSQ: 1,2,3,4");
        assert!(urc.broadcast);
        handle.abort();
    }

    /* ---------- 自动拨号状态解析（对应「接口拿不到 IP」修复） ---------- */

    #[test]
    fn parse_autodial_state_reads_switch_and_mode() {
        // 实测回显：带拨号方式的完整形态
        assert_eq!(
            parse_autodial_state("^SETAUTODIAL: 1,1,\"IP\",\"cmnet\",\"\",\"\",0\r\nOK"),
            Some((true, Some(1)))
        );
        assert_eq!(
            parse_autodial_state("^SETAUTODIAL: 0,2,\"IP\",\"cmnet\"\r\nOK"),
            Some((false, Some(2)))
        );
    }

    #[test]
    fn parse_autodial_state_handles_short_and_padded_forms() {
        // 部分固件只回一个字段：方式为 None（表示无法判定，不是不匹配）
        assert_eq!(parse_autodial_state("^SETAUTODIAL: 1\r\nOK"), Some((true, None)));
        // 前导空白 / 多空格
        assert_eq!(parse_autodial_state("  ^SETAUTODIAL:  0  \r\nOK"), Some((false, None)));
    }

    #[test]
    fn parse_autodial_state_rejects_non_boolean_and_missing() {
        // 非 0/1 视为不可判定，调用方据此改为直接下发命令
        assert_eq!(parse_autodial_state("^SETAUTODIAL: \r\nOK"), None);
        assert_eq!(parse_autodial_state("^SETAUTODIAL: abc\r\nOK"), None);
        assert_eq!(parse_autodial_state("OK\r\nERROR"), None);
        assert_eq!(parse_autodial_state(""), None);
    }

    #[test]
    fn parse_autodial_state_picks_the_setautodial_line() {
        // 应答里混有其它行时，只认 ^SETAUTODIAL
        let mixed = "^HCSQ: \"NR\",72,201,30\r\n^SETAUTODIAL: 1,2\r\nOK";
        assert_eq!(parse_autodial_state(mixed), Some((true, Some(2))));
    }

    #[test]
    fn parse_autodial_state_ignores_out_of_range_mode() {
        // 第 2 字段不是拨号方式（或取值非法）时，只保留开关，方式记为无法判定，
        // 避免据此反复下发设置。
        assert_eq!(parse_autodial_state("^SETAUTODIAL: 1,9\r\nOK"), Some((true, None)));
        assert_eq!(parse_autodial_state("^SETAUTODIAL: 1,x\r\nOK"), Some((true, None)));
    }

    /// 回归：开关一致但方式不符时必须视为「未达成」，
    /// 否则模组会一直停在转网口模式，USB 网口拿不到 DHCP。
    #[test]
    fn autodial_mode_mismatch_is_not_satisfied() {
        let current = parse_autodial_state("^SETAUTODIAL: 1,2\r\nOK").unwrap();
        let desired_mode = 1;
        let mode_ok = current.1.is_none() || current.1 == Some(desired_mode);
        assert!(
            !(current.0 && mode_ok),
            "开关一致但方式不符时不能判定为已对齐"
        );

        // 方式字段缺失时不应据此反复下发
        let unknown = parse_autodial_state("^SETAUTODIAL: 1\r\nOK").unwrap();
        assert!(unknown.0 && (unknown.1.is_none() || unknown.1 == Some(desired_mode)));
    }

    #[test]
    fn parse_ndis_state_reads_first_field() {
        assert_eq!(parse_ndis_state("^NDISSTATQRY: 1,1,0,0,0,0,0\r\nOK"), Some(true));
        assert_eq!(parse_ndis_state("^NDISSTATQRY: 0,1,0,0,0,0,0\r\nOK"), Some(false));
        assert_eq!(parse_ndis_state("OK"), None);
    }

    #[test]
    fn parse_cgact_active_detects_any_active_context() {
        assert_eq!(parse_cgact_active("+CGACT: 1,1\r\nOK"), Some(true));
        assert_eq!(parse_cgact_active("+CGACT: 1,0\r\n+CGACT: 2,0\r\nOK"), Some(false));
        assert_eq!(parse_cgact_active("+CGACT: 1,0\r\n+CGACT: 2,1\r\nOK"), Some(true));
        assert_eq!(parse_cgact_active("OK"), None);
    }

    /* ---------- 排队超时与应答超时分离（对应「终端只有 ATI 有回复」修复） ---------- */

    /// 回归：等命令锁的时间不能吃掉应答预算。
    ///
    /// 构造：先占用 `cmd_mu` 一小段时间模拟「初始化序列正在发命令」，
    /// 随后释放。此时后一条命令若仍按「进入函数即计时」的老逻辑，
    /// 扣除排队后留给模组的应答窗口会不足；修复后排队走独立预算，
    /// 命令应在拿到锁之后正常写入并收到应答。
    #[tokio::test]
    async fn queue_wait_does_not_consume_response_budget() {
        use tokio::io::AsyncWriteExt as _;

        let (tx, _rx) = mpsc::channel::<Unsolicited>(16);
        let client = AtClient::new(crate::config::default_config().at, tx);
        let (_ctx_tx, ctx) = tokio::sync::watch::channel(false);

        // 用一个双端管道冒充模组：读到的命令一律回 "OK"。
        let (host_side, device_side) = tokio::io::duplex(256);
        let (dev_rd, mut dev_wr) = tokio::io::split(device_side);
        let (host_rd, host_wr) = tokio::io::split(host_side);

        {
            let mut guard = client.conn.lock().await;
            *guard = Some(Connection {
                writer: Arc::new(Mutex::new(Box::new(host_wr))),
                describe: "test".into(),
            });
        }
        client.connected_flag.store(true, Ordering::Relaxed);

        // 模组侧：读到一行就回 OK。
        let dev = tokio::spawn(async move {
            let mut rd = dev_rd;
            let mut buf = [0u8; 256];
            loop {
                match rd.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        let _ = dev_wr.write_all(b"OK\r\n").await;
                        let _ = n;
                    }
                    Err(_) => break,
                }
            }
        });

        // 读循环负责把模组回的数据派发给 pending。
        let c = client.clone();
        let ctx_r = ctx.clone();
        let reader_handle = tokio::spawn(async move {
            c.read_loop(&ctx_r, Box::new(host_rd)).await
        });

        // 先抢住命令锁 600ms，模拟初始化序列占用通道。
        let holder = {
            let mu = client.cmd_mu.clone();
            tokio::spawn(async move {
                let _g = mu.lock().await;
                tokio::time::sleep(Duration::from_millis(600)).await;
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;

        // 排队 600ms 后才拿到锁；应答本身很快，应成功而不是报「模组无响应」。
        let res = client
            .send_command(&ctx, "AT+CGMM", COMMAND_TIMEOUT, None)
            .await;
        assert!(
            res.is_ok(),
            "排队不应导致假超时，实际: {:?}",
            res.err()
        );
        assert!(res.unwrap().ok());

        holder.await.unwrap();
        reader_handle.abort();
        dev.abort();
    }

    /// 回归：排队超过独立预算时，返回可辨识的排队超时提示，而不是「模组无响应」。
    #[tokio::test]
    async fn queue_wait_timeout_reports_queue_error() {
        let (tx, _rx) = mpsc::channel::<Unsolicited>(8);
        let client = AtClient::new(crate::config::default_config().at, tx);
        let (_ctx_tx, ctx) = tokio::sync::watch::channel(false);

        // 永久占住命令锁（模拟通道被长时间占用/卡死）。
        let mu = client.cmd_mu.clone();
        let holder = tokio::spawn(async move {
            let _g = mu.lock().await;
            tokio::time::sleep(Duration::from_secs(60)).await;
        });
        tokio::time::sleep(Duration::from_millis(50)).await;

        // 用一个短的排队预算做验证（直接调内部函数无法改常量，故这里改为
        // 断言错误文案包含「等待空闲通道」这一排队特征，而非「模组无响应」）。
        let err = tokio::time::timeout(
            QUEUE_WAIT_TIMEOUT + Duration::from_secs(2),
            client.send_command(&ctx, "AT+CGMM", COMMAND_TIMEOUT, None),
        )
        .await
        .expect("排队超时应按时返回")
        .expect_err("锁被占满时应失败");

        assert!(
            err.contains("等待空闲通道"),
            "应给出排队超时提示，实际: {err}"
        );
        assert!(
            !err.contains("模组无响应"),
            "不应把排队问题误报成模组无响应，实际: {err}"
        );

        holder.abort();
    }
}
