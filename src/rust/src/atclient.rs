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
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex, Notify};

pub const COMMAND_GAP: Duration = Duration::from_millis(100);
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);

/// APDU 透传类命令（`AT+CSIM` / `AT+CGLA` / 逻辑通道管理）的应答超时。
///
/// ★ 为什么不能共用 COMMAND_TIMEOUT(2s)
/// （2026-09-20 真机：eSIM 下载到一半「模组无响应（已等待 2000ms，收到 4 行不完整数据）」）：
/// 普通 AT 命令的应答在 200ms 量级（本机实测 AT+CSQ ≈ 130~205ms），2 秒绰绰有余；
/// 但 APDU 透传命令的耗时由**卡片**决定 —— 模组只负责搬运，卡什么时候吐出结束码
/// 取决于它自己。eSIM 写卡时每一段 STORE DATA 都可能触发卡侧的密钥运算与非易失
/// 写入，含加密 Profile 数据的 A3 段尤其明显，单条跳到秒级是常态。
/// 共用 2 秒预算的表现就是：进度条一路在动，走到某一段突然被掐断。
///
/// 取 12 秒：远大于卡片单次写入的合理上界，同时让「一条命令最坏耗时」留在 ubus
/// 默认的 30 秒以内（排队 8s + 本值 12s + 余量 ≈ 23s），不至于被上层先掐断。
/// 可由 UCI `at-webserver.config.apdu_timeout` 覆盖 —— 调这个值不必重新编译。
pub const DEFAULT_APDU_TIMEOUT: Duration = Duration::from_secs(12);

static APDU_TIMEOUT: OnceLock<Duration> = OnceLock::new();

/// 由 main 读完 UCI 后调用。未调用（或测试里直接构造 client）时取默认值。
pub fn set_apdu_timeout(d: Duration) {
    let _ = APDU_TIMEOUT.set(d);
}

pub fn apdu_timeout() -> Duration {
    *APDU_TIMEOUT.get().unwrap_or(&DEFAULT_APDU_TIMEOUT)
}

/// 判定一条 AT 命令是不是「APDU 透传」类 —— 这类命令的应答时间由卡片而非模组决定。
///
/// 只认命令名、不认参数：`AT+CSIM=10,"80E2…"` 与 `AT+CSIM=?` 同属一类
/// （能力探测本来返回就快，走长超时没有副作用）。
pub fn is_apdu_command(command: &str) -> bool {
    // 用 get(..7) 而不是 &c[..7]：后者在字节边界上会 panic，
    // 而本 crate 的 release 是 panic = "abort"，一次越界就是进程退出。
    match command.trim().get(..7) {
        Some(head) => {
            head.eq_ignore_ascii_case("AT+CSIM")
                || head.eq_ignore_ascii_case("AT+CGLA")
                || head.eq_ignore_ascii_case("AT+CCHO")
                || head.eq_ignore_ascii_case("AT+CCHC")
                || head.eq_ignore_ascii_case("AT+CCHP")
        }
        None => false,
    }
}

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
/// 写入模组的独立超时。
///
/// `write_all` 本身没有超时：串口的发送缓冲被填满、而对端（模组）又不再读走
/// 数据时会一直挂住 —— 典型场景是模组卡在「等待 PDU 输入」的数据态，此时它
/// 把后续一切字节当短信内容吞掉，读循环拿不到任何结束码，缓冲区也就不再排空。
///
/// 不设上限的后果比一次命令超时严重得多：写入卡住时 `cmd_mu` 一直被持有，
/// **之后每一条命令都会耗到 QUEUE_WAIT_TIMEOUT(8s) 才失败**，AT 通道等于整体
/// 瘫痪，而进程还活着、procd 不会重启它，只能手动干预。
///
/// 取 3 秒：一次 AT 命令最多几百字节，正常情况下写入是微秒级完成的；
/// 3 秒只可能是「对端不读了」，此时尽早失败、清掉 pending 才是正解。
///
/// 上限还受 rpcd 侧总预算约束：ucode 代理给整个 RPC 限时 20 秒，而一条命令
/// 的最坏耗时是 排队 QUEUE_WAIT(8s) + 写入(本值) + 等应答 / 短信(6s)。
/// 本值取 5 秒时最坏 19s，几乎顶满 20s，正常的慢响应就有被掐断的风险；
/// 取 3 秒则最坏 17s，留出了余量。
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(3);
/// 连接断开后，等待初始化任务收尾的最长时间（超过就放弃，直接进入重连）。
const INIT_JOIN_TIMEOUT: Duration = Duration::from_secs(15);

/// 单行是否为 AT 错误结束码。
///
/// 判据形状与前端 rpc.js 的 `isErrorText` 等价（那边用正则做行锚定）：
/// 行首（允许前导空白）恰为 `ERROR`，或 `+CME ERROR` / `+CMS ERROR` 且其后
/// 紧接冒号或行尾。用 `get(..n)` 而不是切片索引，避免多字节字符落在字符边界
/// 之外 panic —— 本 crate 的 release 是 `panic = "abort"`。
fn is_error_line(line: &str) -> bool {
    let t = line.trim();
    if t.eq_ignore_ascii_case("ERROR") {
        return true;
    }
    for prefix in ["+CME ERROR", "+CMS ERROR"] {
        if let Some(head) = t.get(..prefix.len()) {
            if head.eq_ignore_ascii_case(prefix) {
                let rest = &t[prefix.len()..];
                if rest.is_empty() || rest.starts_with(':') {
                    return true;
                }
            }
        }
    }
    false
}

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
    /// 应答里是否含 AT 错误结束码（`ERROR` / `+CME ERROR[: …]` / `+CMS ERROR[: …]`）。
    ///
    /// ★ 必须**逐行判定**，不能对整份应答做 `contains("ERROR")`。
    ///   原实现是 `self.text().to_uppercase().contains("ERROR")` —— 正文里任意位置
    ///   出现这个词就判失败。同一个事故前端已经踩过并修好（rpc.js 的 isErrorText
    ///   改成了行锚定判据，注释里记着现场）：Text 模式（CMGF=1）下 `AT+CMGL` 返回
    ///   的短信正文含 "error" 时，整份列表被判成「命令失败」，界面一片空白，而
    ///   日志里什么错误都查不到。后端这两条路径（普通命令与扫频的成败判定）
    ///   此前一直是宽匹配，与前端不一致。
    ///
    ///   模组的错误结束码按 3GPP TS 27.007 独占一行（`ERROR` / `+CME ERROR: <err>` /
    ///   `+CMS ERROR: <err>`），所以按行判定既不会误伤正文，也不会漏掉真错误。
    ///   大小写仍保持旧实现的宽容度（ASCII 不敏感）：这次只收紧「位置」，
    ///   不额外收紧大小写，免得把某个固件的小写 `error` 变成漏判。
    pub fn has_error(&self) -> bool {
        self.lines.iter().any(|l| is_error_line(l))
    }
    pub fn contains(&self, sub: &str) -> bool {
        self.text().contains(sub)
    }
}

/// 从 `AT^SETAUTODIAL?` 的应答里取出「自动拨号是否开启」。
///
/// 手册回显形如 `^SETAUTODIAL: 1,1,"IP","cmnet",...`，第一个字段即开关；
/// 部分固件只回 `^SETAUTODIAL: 1`。解析失败返回 None（调用方据此决定是否直接下发）。
fn parse_autodial_enable(text: &str) -> Option<bool> {
    for line in text.replace('\r', "").lines() {
        let line = line.trim();
        if !line.starts_with("^SETAUTODIAL:") {
            continue;
        }
        let payload = line[line.find(':')? + 1..].trim();
        let first = payload.split(',').next()?.trim().trim_matches('"');
        if first.is_empty() {
            return None;
        }
        return match first {
            "0" => Some(false),
            "1" => Some(true),
            _ => None,
        };
    }
    None
}

/*
 * 不推给前端的主动上报前缀。
 *
 * ★ 2026-09-28 真机实测（设备 192.168.10.1，luci-app-mt5700-2.4.3-r1）：
 *   模组在空闲期**每秒**上报约 10 条 —— `^RSSI` 5 条 + `^CERSSI` 5 条，
 *   而这两者在**前端完全没有消费方**：
 *     · `^RSSI`   —— `rpc.js` 的 `parseRawData` 根本不认这个前缀（全仓 0 处引用），
 *                    推过去就是「解包 → 没有产出 → 丢弃」；
 *     · `^CERSSI` —— 会产出 `{type:'CERSSI', raw}`，但**全仓没有任何消费方**；
 *                    它的信号语义由 Rust 侧 `urc::handle_signal` 解析并用于
 *                    `notify_signal`（企业微信推送），与前端事件是两条路。
 *   实测后果（`ubus call mt5700 logs` 的 WRN，每分钟一次）：
 *     `事件帧超出 6144 字节预算，本次回 90 条，剩余等下一轮`
 *   —— 90 条里 90 条都是这两者，而 `+CMTI`（新短信）这类**真正要紧**的事件
 *   被排在它们后面；`urc_tx` 队列只有 256 格（见 main.rs），满了还会丢。
 *
 * 为什么用**黑名单**而不是白名单：未知/新出现的 URC 应当保持「原样推给前端」的
 * 既有行为，只排除已被实测确认无消费方的高频项。若日后前端要用这两个数据，
 * 把它们从这里删掉即可恢复（`^HCSQ` 不在此列：它既是主动上报也是 `AT^HCSQ?`
 * 的应答，且 `handle_signal` 依赖它）。
 */
const NO_BROADCAST_PREFIXES: &[&str] = &["^RSSI:", "^CERSSI:"];

/// 这条主动上报要不要作为 `raw_data` 推给前端。
fn should_broadcast(line: &str) -> bool {
    !NO_BROADCAST_PREFIXES.iter().any(|p| line.starts_with(p))
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

/// 扫频计数的 RAII 守卫，见 `send_long_command` 内的说明。
///
/// 持有引用的生命周期比任何一次调用都短，不存在跨 await 持有的风险。
struct LongCmdGuard<'a>(&'a AtomicI32);

impl Drop for LongCmdGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 进程内的单调时间（纳秒），用于记录「扫频什么时候结束的」。
///
/// 这里**不能**用 `SystemTime`（墙钟）：NTP 校时会让它前跳或后跳，
/// 而 `Instant` 是单调钟但没法直接存进原子整数。取进程首次调用时的
/// `Instant` 作基准，之后一律用相对值 —— 单调、可存、无锁。
fn mono_ns() -> i64 {
    static BASE: OnceLock<Instant> = OnceLock::new();
    let base = BASE.get_or_init(Instant::now);
    Instant::now()
        .checked_duration_since(*base)
        .unwrap_or_default()
        .as_nanos() as i64
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
        Self::build(cfg, urc_tx)
    }

    fn build(cfg: AtConfig, urc_tx: mpsc::Sender<Unsolicited>) -> Arc<Self> {
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
                        log_warn!("模组读循环异常结束: {}", e);
                    }
                }
                _ = ctx_c.changed() => {}
            }

            // 先拆连接，再收尾初始化任务。
            //
            // init_modem 与读循环是并行跑的。连接一旦断开，它发出的命令就再也等不到
            // 应答 —— 而 ctx 只在**服务关闭**时才翻转，链路断开并不会，于是这些命令
            // 会各自耗满 COMMAND_TIMEOUT(2s) 才失败，一次重连因此被白白推迟好几秒，
            // 期间用户看到的就是「所有命令都在转圈」。
            //
            // teardown 会清空 pending 并 notify，等待中的命令立刻返回错误，
            // init_modem 于是能马上收尾。teardown 本身是幂等的（见其实现）。
            self.teardown().await;

            // 兜底：万一 init 还卡在 teardown 影响不到的地方（例如正排在命令锁后面），
            // 最多再等 INIT_JOIN_TIMEOUT 就放弃 —— 绝不能让一个注定没有结果的初始化
            // 把重连流程拖死。
            match tokio::time::timeout(INIT_JOIN_TIMEOUT, init).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => log_warn!("初始化任务异常结束: {}", e),
                Err(_) => log_warn!(
                    "初始化任务未在 {}s 内结束，放弃等待并继续重连",
                    INIT_JOIN_TIMEOUT.as_secs()
                ),
            }
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
        // 与 Go 一致：查询失败或不含目标值时都要 SET，避免模组刚连上超时导致模式未启用。
        match self.send_command(ctx, "AT+CNMI?", COMMAND_TIMEOUT, None).await {
            Ok(resp) if resp.contains("+CNMI: 2,1,0,2,0") => {}
            _ => {
                if let Err(e) = self.send_command(ctx, "AT+CNMI=2,1,0,2,0", COMMAND_TIMEOUT, None).await {
                    log_warn!("设置短信上报模式失败: {}", e);
                }
            }
        }
        match self.send_command(ctx, "AT+CMGF?", COMMAND_TIMEOUT, None).await {
            Ok(resp) if resp.contains("+CMGF: 0") => {}
            _ => {
                if let Err(e) = self.send_command(ctx, "AT+CMGF=0", COMMAND_TIMEOUT, None).await {
                    log_warn!("设置短信 PDU 模式失败: {}", e);
                }
            }
        }
        if let Err(e) = self.send_command(ctx, "AT+CLIP=1", COMMAND_TIMEOUT, None).await {
            log_warn!("开启来电号码显示失败: {}", e);
        }

        // 自动拨号默认开启（UCI autodial_enable 默认 1）。
        // 放在最后：前面的设置类命令失败不应阻止拨号，否则设备会一直没有 IP。
        self.ensure_autodial(ctx).await;
    }

    /// 确保自动拨号处于期望状态。
    ///
    /// 「模块显示在线但接口拿不到 IP」的根因链：
    ///   模组已注册网络（AT 通、有信号）→ 但 ^SETAUTODIAL 未开启 →
    ///   模组不向 USB 网口下发 DHCP → eth2 一直是 NO-CARRIER/DHCP 无应答 →
    ///   netifd 的 MT5700M 接口没有 IP → 无法联网。
    /// 因此每次连上模组后都要对齐一次自动拨号状态。
    ///
    /// 幂等：先查询，已是目标值则不重复下发（避免每次重连都打断已建立的 PDP 上下文）。
    async fn ensure_autodial(self: &Arc<Self>, ctx: &tokio::sync::watch::Receiver<bool>) {
        let desired = self.cfg.autodial_enable;
        let mode = self.cfg.autodial_mode.clamp(1, 2);

        // 1) 查询当前状态；查询失败也继续尝试下发，避免模组刚连上超时导致不拨号。
        let current = match self.send_command(ctx, "AT^SETAUTODIAL?", COMMAND_TIMEOUT, None).await {
            Ok(resp) => parse_autodial_enable(&resp.text()),
            Err(e) => {
                log_warn!("查询自动拨号状态失败，将直接下发设置: {}", e);
                None
            }
        };

        if current == Some(desired) {
            log_info!("自动拨号已处于期望状态（enable={}），不重复下发", desired as i32);
            return;
        }

        // 2) 下发。开启时带上拨号方式；关闭时不带参数（与手册及前端 dial.js 一致）。
        let cmd = if desired {
            format!("AT^SETAUTODIAL=1,{}", mode)
        } else {
            "AT^SETAUTODIAL=0".to_string()
        };
        let mut applied = false;
        match self.send_command(ctx, &cmd, COMMAND_TIMEOUT, None).await {
            Ok(resp) if resp.ok() => {
                // ★ 脱敏：`AT^SETAUTODIAL` 的完整参数里含 APN 的用户名与口令
                log_info!(
                    "已{}自动拨号（{}）",
                    if desired { "开启" } else { "关闭" },
                    crate::logger::redact_at_for_log(&cmd)
                );
                applied = true;
            }
            Ok(resp) => {
                log_warn!("自动拨号设置未返回 OK: {}", resp.text());
            }
            Err(e) => {
                log_warn!("自动拨号设置失败: {}（命令 {}）", e, crate::logger::redact_at_for_log(&cmd));
            }
        }

        // 3) 复核，便于日志里直接看出是否真的生效。
        // 只在设置成功时做：设置已经失败时复核不出新信息，白白多占一次 AT 通道
        // （这条查询同样要排队 + 100ms 命令间隔，重连时每次都是实打实的等待）。
        if !applied {
            return;
        }
        if let Ok(resp) = self.send_command(ctx, "AT^SETAUTODIAL?", COMMAND_TIMEOUT, None).await {
            match parse_autodial_enable(&resp.text()) {
                Some(v) if v == desired => log_info!("自动拨号状态复核通过"),
                Some(v) => log_warn!("自动拨号状态复核不一致：期望 {}，实际 {}", desired as i32, v as i32),
                None => log_warn!("自动拨号状态复核无法解析: {}", resp.text()),
            }
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
        /*
         * ★ 递减必须挂在 Drop 上，不能写在 .await 之后。
         *
         * 本函数是 async：外层一旦超时/取消，整个 future 被 drop，写在
         * `send_command_inner(...).await` 后面的 fetch_sub 就永远不会执行。
         * 计数从此停在 1，long_command_active() 恒为真 —— schedule 每周期都走
         * 「扫频中」分支，定时锁频与无服务自动解锁双双永久停摆，日志里没有任何
         * 报错，只能重启服务才能恢复。扫频命令抢锁等得久（排队预算 8s + 写入 3s）
         * 时很容易顶到外层 10s 余量，这个窗口并不窄。
         *
         * 用守卫后，正常返回、? 提前返回、future 被 drop 三条路径都会递减。
         */
        let _guard = LongCmdGuard(&self.long_cmd);
        let result = self.send_command_inner(ctx, command, timeout, stream).await;
        self.long_cmd_end.store(mono_ns(), Ordering::SeqCst);
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
        let now_ns = mono_ns();
        if now_ns < ns {
            // 单调钟不该回拨；真发生了就视为刚结束
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
        // 同样要限时：打断就是用在「模组不回话」的场景，此时它同样可能不读数据。
        match tokio::time::timeout(WRITE_TIMEOUT, w.write_all(payload.as_bytes())).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => {
                log_warn!("写入打断字符串失败: {}", e);
                Err(e.to_string())
            }
            Err(_) => {
                log_warn!("写入打断字符串超时({}s)", WRITE_TIMEOUT.as_secs());
                Err(format!("写入模组超时（{}s）", WRITE_TIMEOUT.as_secs()))
            }
        }
    }

    /// 向模组写入 ESC(0x1B)，取消当前的数据输入态。
    ///
    /// 用途：`AT+CMGS` / `AT+CMGW` 会让模组进入「等待 PDU 数据」的状态。若这段数据
    /// 没有被模组接受（例如模组迟迟不返回 `+CMGS:` / `OK`），该状态会一直挂住串口
    /// —— 此时**任何** AT 命令都会被模组当成 PDU 数据吞掉，表现为「发一次短信后
    /// 整个界面全部超时、页面加载不出来」。
    ///
    /// 与 [`interrupt`] 的区别：这里不要求存在待应答命令（超时后 pending 已被清空），
    /// 属于「事后清场」，因此绕过命令锁与 pending 检查直接写入。
    pub async fn cancel_data_entry(&self) -> Result<(), String> {
        let writer = {
            let guard = self.conn.lock().await;
            match &*guard {
                Some(c) => c.writer.clone(),
                None => return Err("AT 通道未连接".into()),
            }
        };
        let mut w = writer.lock().await;
        // 这里比别处更需要限时：本函数就是用在「模组卡在数据态」的事后清场，
        // 而卡住时它对端往往既不回数据也不再读数据，写入很容易挂住。
        // 挂住的后果是清场者自己被卡死，本来还能救的通道彻底没人救了。
        match tokio::time::timeout(WRITE_TIMEOUT, w.write_all(&[0x1b])).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => {
                log_warn!("写入 ESC 取消失败: {}", e);
                Err(e.to_string())
            }
            Err(_) => {
                log_warn!("写入 ESC 取消超时({}s)，模组已不接收数据", WRITE_TIMEOUT.as_secs());
                Err(format!("写入 ESC 超时（{}s）", WRITE_TIMEOUT.as_secs()))
            }
        }
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
        // 先把要等多久算出来再放开锁：睡眠期间没必要占着 last_cmd_at。
        // （串行化由上面的 cmd_mu 保证，不是靠这把锁，所以放开它不会引入并发。）
        let gap = {
            let last = self.last_cmd_at.lock().await;
            COMMAND_GAP.saturating_sub(last.elapsed())
        };
        if !gap.is_zero() {
            let mut ctx_c = ctx.clone();
            tokio::select! {
                _ = tokio::time::sleep(gap) => {}
                _ = ctx_c.changed() => return Err("上下文取消".into()),
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

        // ★ drop 安全性警示（B05，2026-10-22 审计）：本函数的 future **不能被
        //   调用方随意 drop** —— 从这里到应答收集完之间任意 await 点被 drop 的话，
        //   cmd_mu 随 drop 释放、pending 槽残留旧命令，下一条命令可能读到旧结束码
        //   （AT 应答错位）。当前调用方的外层预算都按「排队+写入+应答+gap+余量」
        //   覆盖了内层最坏耗时（rpcserver 短信任务 = 20.1s）；新增调用方必须遵守
        //   同一约定，或先给 pending 实现真正的 Drop 守卫。

        // 先创建 notified 再写入，避免应答先到而错过通知。
        let notified = done.notified();
        {
            let mut w = conn.lock().await;
            match tokio::time::timeout(WRITE_TIMEOUT, w.write_all(cmd.as_bytes())).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    log_warn!("写入 AT 命令失败: {}", e);
                    self.pending.lock().await.take();
                    return Err(e.to_string());
                }
                Err(_) => {
                    // 写入超时多半是模组卡在「等待 PDU 输入」的数据态：
                    // 它既不取走数据也不回结束码。此时必须清掉 pending，
                    // 否则锁要一直被这条命令占着，后续命令全都会排队超时。
                    log_warn!(
                        "写入 AT 命令超时({}s)，模组可能卡在数据输入态: {}",
                        WRITE_TIMEOUT.as_secs(),
                        // ★ 脱敏：数据态卡住的多半就是 `AT+CMGS`/`AT+CGLA` 这类带内容的命令
                        crate::logger::redact_at_for_log(command)
                    );
                    self.pending.lock().await.take();
                    return Err(format!(
                        "写入模组超时（{}s）：模组可能正等待数据输入",
                        WRITE_TIMEOUT.as_secs()
                    ));
                }
            }
        }
        *self.last_cmd_at.lock().await = Instant::now();

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

        /*
         * ★ 超时判定必须优先于「收到了点东西」。
         *
         * 原写法是 `if !lines.is_empty() { return Ok(...) }`：只要模组回了哪怕一行，
         * 即便结束码（OK/ERROR）没到，超时也被当成成功返回。上层于是拿到一份
         * **被截断的应答**却毫不知情 —— `AT+CMGL=4` 列 50 条短信在 115200 波特下
         * 约 1.7s，已经逼近 2s 的命令超时，截断是真实会发生的；短信列表因此少几条、
         * 新短信的 PDU 因此缺半截，全都是静默的数据丢失。
         *
         * 「结束码没到 == 应答不完整」没有例外：notify 只在 is_terminator() 为真时
         * 发生，而所有 AT 命令都以 OK / ERROR 收尾（`>` 提示符按设计不 notify，
         * 它本就不代表命令完成，见 consume() 内注释）。
         */
        if !answered {
            let msg = format!(
                "模组无响应（已等待 {}ms，收到 {} 行不完整数据）: {}",
                timeout.as_millis(),
                lines.len(),
                // ★ 脱敏：msg 既进日志、也作为错误返回给 RPC 调用方，
                //   而它会经 rpcserver 的"AT 命令失败"日志再打一遍 —— 不脱敏等于绕过那里的脱敏。
                crate::logger::redact_at_for_log(command)
            );
            /*
             * ★ 末行摘要（2026-09-20）：「收到 N 行」只说明没等到结束码，说明不了
             *   卡/模组当时在干什么。把最后两行的**前 12 个字符**记进日志，就能一眼
             *   区分「卡还没吐数据」与「吐了一半」（例如 `+CGLA: 4,"90`）。
             *   只取前缀：完整响应里可能含 ICCID / EID 之类的卡数据，不该落进日志。
             */
            let tail: Vec<String> = lines
                .iter()
                .rev()
                .take(2)
                .map(|l| {
                    let t = l.trim();
                    let head: String = t.chars().take(12).collect();
                    if t.chars().count() > 12 { head + "…" } else { head }
                })
                .collect();
            log_warn!("{}；末行: {:?}", msg, tail);
            return Err(msg);
        }
        if lines.is_empty() {
            // 收到过结束码但没攒到任何内容（例如模组只回一个空结束码）。
            return Err(format!(
                "模组未返回内容: {}",
                crate::logger::redact_at_for_log(command)
            ));
        }
        Ok(AtResponse { lines })
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
                // 不能立刻当 EOF：串口在 VMIN=0/VTIME=0 下「暂无数据」时 read 返回 0
                // 而不是 EAGAIN，直接退出会让读循环刚连上就结束，此后所有 AT 命令都
                // 超时（实机表现为「模组无响应」+ 每十几秒反复重连）。
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
        //
        // 这里**只记录提示符，不结束命令**。模组回 ">" 只是说「可以把 PDU 发过来了」，
        // 提交结果在它后面的 `+CMGS:` / `OK` / `ERROR` 里。以前在这里 notify_one()，
        // 命令就带着 `[">"]` 提前返回了：等到 `+CMGS:` / `OK` 到达时 pending 已被取走，
        // 它们只能被当成 URC 广播出去，上层（rpcserver 的短信后台任务）因此永远看不到
        // `+CMGS:`，哪怕模组其实提交成功了也会被判成「模组未确认」，还要白等 60 秒冷却。
        //
        // 不 notify 的代价只有一种：模组回了 ">" 却再无任何应答时，要多等到本命令的超时
        // （短信是 6 秒）才失败。失败后的兜底没变 —— 照样补发 ESC 清掉数据输入态、照样进
        // 冷却，所以最坏情况也只是慢一点，不会更糟。
        if data.iter().all(|b| b.is_ascii_whitespace() || *b == b'>') && data.contains(&b'>') {
            let mut pending = self.pending.lock().await;
            if let Some(p) = pending.as_mut() {
                p.lines.push(">".into());
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
            // 空闲期收到的数据视为主动上报：交给处理器；是否推给前端见 should_broadcast。
            // 与 Go 实现一致（Go handleLine: p == nil 时 broadcast: true），
            // 唯一的例外是下面 NO_BROADCAST_PREFIXES 里那几个前端不消费的高频 URC。
            // ★ 必须先算 broadcast 再构造：struct 字面量的字段按书写顺序求值，
            //   写成 `Unsolicited { line, broadcast: should_broadcast(&line) }`
            //   会先 move `line` 再借用它 → E0382。
            let broadcast = should_broadcast(&line);
            self.emit(Unsolicited { line, broadcast }).await;
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
    /*
     * ★ 复用 is_error_line，而不是自己写一遍 `starts_with("+CME ERROR:")`。
     *   两条判据必须**完全一致**，否则会出现这种自相矛盾的组合：
     *   `has_error()` 说这份应答含错误结束码，而 `is_terminator()` 不认它是结束码
     *   —— 于是那条命令收不到 notify，只能白等到超时，最终报出来的是
     *   「模组无响应（已等待 2000ms…）」这种**指向完全错误**的原因。
     *   具体分歧点在「不带冒号」的形态：is_error_line 接受 `+CME ERROR`（行尾即结束），
     *   旧实现只接受 `+CME ERROR:`。
     *   代价是 ERROR 一侧从大小写敏感放宽成 ASCII 不敏感 —— 与 has_error 一致，
     *   而 has_error 那边早已按此口径（3GPP TS 27.007 的错误结束码独占一行）。
     */
    line == "OK" || line == "ABORTED" || is_error_line(line)
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
    /*
     * 通话生命周期的鼎桥私有 URC（手册第 12 章，属性 NA/NA —— 无开关、默认就发）。
     *
     * ★ 为什么必须登记在这里，而不是只丢进 is_exclusive_urc：
     *   handle_line 在「有命令在等应答」时只 emit is_exclusive_urc 为真的行，
     *   而那一行的 broadcast 位取的是**本函数**的返回值 —— 不登记就会被并进
     *   那条命令的应答体里，前端一条都收不到。
     *   实测（2026-10-22）：`ATD10086;` 的响应体内就带着
     *   `^CCALLSTATE: 1,0,1` 与 `^ORIG: 1,0`，而那正是「拨号已被接受」的第一个
     *   信号；通话期间前端每 2 秒发一次 AT+CLCC，落在命令等待窗口里的概率不低。
     *
     * ★ 安全边界：这五条只存在 URC 形态，手册里没有对应的读取命令，不可能与
     *   任何 AT 应答混淆；单通电话合计 5~10 条，不会淹没事件总线（500 条环形）。
     *   `^CEND` 另在 is_exclusive_urc 里单列过，两处都留着不冲突 ——
     *   那边管「命令等待期要不要 emit」，这边管「emit 时带不带 broadcast」。
     */
    if line.starts_with("^CCALLSTATE:")
        || line.starts_with("^ORIG:")
        || line.starts_with("^CONF:")
        || line.starts_with("^CONN:")
        || line.starts_with("^CEND:")
    {
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

    /* ---------- 错误结束码判定（对应前端 isErrorText 的同款修复） ---------- */

    fn resp_of(s: &str) -> AtResponse {
        AtResponse { lines: s.split("\r\n").map(|l| l.to_string()).collect() }
    }

    /// 正文里出现 "error" 不算失败；真错误结束码必须逐行识别。
    /// 样本与前端 tests/at-error-text-contract.test.js 同源。
    #[test]
    fn has_error_只认整行的错误结束码() {
        // 误判面：这个词出现在正文 / 数据里，行首不是错误码
        assert!(!resp_of("+CMGL: 1,1,,,\"My network error again\"\r\nOK").has_error());
        assert!(!resp_of("^HFREQINFO: 0,7,41,528960,2644800\r\nOK").has_error());
        assert!(!resp_of("+CSQ: 12,0\r\nOK").has_error());

        // 真错误：三种结束码都要认（含不带错误码、带说明文字的形态）
        assert!(resp_of("ERROR").has_error());
        assert!(resp_of("\r\nERROR\r\n").has_error());
        assert!(resp_of("+CME ERROR: 10").has_error());
        assert!(resp_of("+CMS ERROR: 500").has_error());
        assert!(resp_of("+CME ERROR").has_error());
        assert!(resp_of("+CME ERROR: not found").has_error());

        // 形状必须是「行首 + 冒号或行尾」：+CME ERRORX 不是结束码，
        // 出现在行中间的同样不算
        assert!(!resp_of("+CME ERRORX").has_error());
        assert!(!resp_of("回显里提到 +CME ERROR 但不在行首").has_error());
    }

    /* ---------- 结束码判定：必须与 has_error 同口径 ---------- */

    /// 回归守卫：`is_terminator` 与 `has_error` 一旦分歧，就会产出
    /// 「认出是错误、却等不到结束码」的组合 —— 命令白等到超时，还报
    /// 「模组无响应」这种指向错误的原因。分歧点就在**不带冒号**的形态上。
    #[test]
    fn is_terminator_与_has_error_同口径() {
        // 正常成功 / 中断
        assert!(is_terminator("OK"));
        assert!(is_terminator("ABORTED"));
        // 三种错误结束码，含不带冒号的形态（旧实现漏掉的就是这一种）
        assert!(is_terminator("ERROR"));
        assert!(is_terminator("+CME ERROR: 10"));
        assert!(is_terminator("+CMS ERROR: 500"));
        assert!(is_terminator("+CME ERROR"));
        assert!(is_terminator("+CMS ERROR"));
        // 不一致性本身：凡 has_error 认的结束码，is_terminator 必须也认
        for s in [
            "ERROR",
            "+CME ERROR",
            "+CME ERROR: 10",
            "+CMS ERROR",
            "+CMS ERROR: 500",
        ] {
            assert!(
                !resp_of(s).has_error() || is_terminator(s),
                "has_error 认它是错误，is_terminator 却不认它是结束码：{s}"
            );
        }
        // 不能误判成结束码
        assert!(!is_terminator("+CME ERRORX"));
        assert!(!is_terminator("+CMGL: 1,1,,,\"My network error again\""));
        assert!(!is_terminator("^HCSQ: 1,2,3,4"));
        assert!(!is_terminator(""));
    }

    #[test]
    fn ok_只认整行_ok() {
        assert!(resp_of("+CSQ: 12,0\r\nOK").ok());
        assert!(!resp_of("+CMGL: 1,1,,,\"NOT OK\"").ok());
    }

    /* ---------- 自动拨号状态解析（对应「接口拿不到 IP」修复） ---------- */

    #[test]
    fn parse_autodial_enable_reads_first_field() {
        // 实测回显：带拨号方式的完整形态
        assert_eq!(
            parse_autodial_enable("^SETAUTODIAL: 1,1,\"IP\",\"cmnet\",\"\",\"\",0\r\nOK"),
            Some(true)
        );
        assert_eq!(
            parse_autodial_enable("^SETAUTODIAL: 0,1,\"IP\",\"cmnet\"\r\nOK"),
            Some(false)
        );
    }

    #[test]
    fn parse_autodial_enable_handles_short_and_padded_forms() {
        // 部分固件只回一个字段
        assert_eq!(parse_autodial_enable("^SETAUTODIAL: 1\r\nOK"), Some(true));
        // 前导空白 / 单引号风格
        assert_eq!(parse_autodial_enable("  ^SETAUTODIAL:  0  \r\nOK"), Some(false));
    }

    #[test]
    fn parse_autodial_enable_rejects_non_boolean_and_missing() {
        // 非 0/1 视为不可判定，调用方据此改为直接下发命令
        assert_eq!(parse_autodial_enable("^SETAUTODIAL: \r\nOK"), None);
        assert_eq!(parse_autodial_enable("^SETAUTODIAL: abc\r\nOK"), None);
        assert_eq!(parse_autodial_enable("OK\r\nERROR"), None);
        assert_eq!(parse_autodial_enable(""), None);
    }

    #[test]
    fn parse_autodial_enable_picks_the_setautodial_line() {
        // 应答里混有其它行时，只认 ^SETAUTODIAL
        let mixed = "^HCSQ: \"NR\",72,201,30\r\n^SETAUTODIAL: 1,2\r\nOK";
        assert_eq!(parse_autodial_enable(mixed), Some(true));
    }

    /* ---------- APDU 透传的独立应答预算 ---------- */

    /// APDU 透传类命令必须拿到比普通命令宽的预算；普通命令必须维持 2 秒。
    ///
    /// 反例（2026-09-20 真机）：eSIM 下载到一半「模组无响应（已等待 2000ms，
    /// 收到 4 行不完整数据）」—— 写卡时卡侧做密钥运算与非易失写入，单条跳到
    /// 秒级是常态，而普通 AT 命令实测只有 130~205ms。反过来，若把普通命令也
    /// 放宽到 12 秒，一次「模组真的死了」就要空等 12 秒 —— 两边都不能越界。
    #[test]
    fn apdu_commands_get_their_own_budget() {
        for c in [
            "AT+CSIM=10,\"80E2000005\"",
            "AT+CGLA=1,20,\"81E2910006\"",
            "AT+CCHO=\"A0000005591010FFFFFFFF8900000100\"",
            "AT+CCHC=1",
            "AT+CCHP=1",
            "at+csim=?",          // 大小写与「测试命令」形态同样算
            "  AT+CSIM=10,\"80\"", // 前导空白
        ] {
            assert!(is_apdu_command(c), "{c} 应判为 APDU 透传类");
        }
        for c in ["AT", "AT+CSQ", "AT+CEREG?", "AT+CPIN?", "AT+CMGS=20", "AT+CFUN=1"] {
            assert!(!is_apdu_command(c), "{c} 不应判为 APDU 透传类");
        }
    }

    /// 短字符串 / 空串不能 panic —— 本 crate 的 release 是 `panic = "abort"`，
    /// 一次切片越界就是进程退出（这里原本就是 `&c[..7]` 的高危写法）。
    #[test]
    fn apdu_command_check_survives_short_input() {
        for c in ["", "A", "AT", "AT+", "AT+C", "AT+CS"] {
            assert!(!is_apdu_command(c), "{c:?} 不应判为 APDU 透传类");
        }
    }

    #[test]
    fn apdu_timeout_is_longer_than_generic_command_timeout() {
        assert!(
            apdu_timeout() > COMMAND_TIMEOUT,
            "APDU 预算 {}s 必须大于普通命令的 {}s",
            apdu_timeout().as_secs(),
            COMMAND_TIMEOUT.as_secs()
        );
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

    /// ★ 2026-09-28 真机实测（192.168.10.1，luci-app-mt5700-2.4.3-r1）：
    ///   模组空闲期**每秒**上报约 10 条 —— `^RSSI` 5 + `^CERSSI` 5，
    ///   而两者在前端都没有消费方（`^RSSI` 连 `rpc.js::parseRawData` 都不认；
    ///   `^CERSSI` 虽会产出 `{type:'CERSSI'}`，但全仓无消费方）。
    ///   实测后果是 `logs` 里每分钟一条 WRN「事件帧超出 6144 字节预算」，
    ///   而 `+CMTI`（新短信）这类要紧事件被排在它们后面。
    #[test]
    fn 高频且前端不消费的上报不推给前端() {
        // 这两个必须被挡掉
        assert!(!should_broadcast("^RSSI: 156"));
        assert!(!should_broadcast("^CERSSI: 0,0,255,0,0,0,3,15,0,0,99,99,99,99,99,99,99,99,-78,-10,17"));

        // 真正被前端消费的必须放行
        assert!(should_broadcast("^REJINFO: 1,2,3"), "网络拒绝原因是唯一被前端消费的 URC");
        assert!(should_broadcast("+CMTI: \"ME\",57"), "新短信通知必须放行");
        assert!(should_broadcast("RING"));
        assert!(should_broadcast("^CLIP: \"+8613800138000\",145"));

        // ^HCSQ 不在黑名单里：它既是主动上报也是 AT^HCSQ? 的应答，且 handle_signal 依赖它
        assert!(should_broadcast("^HCSQ: \"NR\",63,186,30"));

        // 未知/新出现的 URC 保持「原样推给前端」的既有行为（黑名单而非白名单）
        assert!(should_broadcast("^SOMETHINGNEW: 1"), "未知 URC 不应被静默吞掉");
        assert!(should_broadcast(""), "空行的行为与改动前一致");

        // 前缀匹配必须是「从头开始」：正文里出现不算
        assert!(should_broadcast("OK"));
        assert!(should_broadcast("^HCSQ: \"LTE\",45,34,106"), "其他信号 URC 不受影响");
    }

    /*
     * 通话类 URC 必须能被「命令等待期」放行。
     *
     * 这条守卫盯的是一个很容易回归的坑：is_exclusive_urc 管「要不要 emit」，
     * is_passthrough_urc 管「emit 时带不带 broadcast」—— 两者是两件事。
     * 只往前面加、忘了后面，URC 会被安静地并进 AT+CLCC 的应答体里：
     * 前端收不到，也不会有任何报错，症状只是「状态更新慢两秒」。
     * 2026-10-22 实测就踩到了：ATD 的响应体内带着 ^CCALLSTATE 和 ^ORIG。
     */
    #[test]
    fn 通话类_urc_在命令等待期也要推给前端() {
        let call_urcs = [
            "^CCALLSTATE: 1,3,1",
            "^CCALLSTATE: 1,5,1",
            "^ORIG: 1,0",
            "^CONF: 1",
            "^CONN: 1,0",
            "^CEND: 1,25,104,0",
        ];
        for l in call_urcs.iter() {
            assert!(is_passthrough_urc(l), "{} 必须在命令等待期带上 broadcast", l);
            assert!(is_exclusive_urc(l), "{} 必须是独占 URC，否则会被当成 CLCC 应答", l);
        }

        // 不能误伤：CLCC 应答自己不是 URC
        assert!(!is_passthrough_urc("+CLCC: 1,0,0,0,0,\"10086\",129"));
        assert!(!is_exclusive_urc("+CLCC: 1,0,0,0,0,\"10086\",129"));
        // 前缀必须从头匹配，行首空白不算
        assert!(!is_passthrough_urc("  ^CEND: 1,25,104,0"));
    }
}
