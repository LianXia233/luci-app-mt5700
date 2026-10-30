//! AT 客户端：维护到模组的唯一连接。
//!
//! - 只有一个任务读取通道，命令应答与主动上报在同一处解复用；
//! - 命令串行执行（100ms 最小间隔），2 秒超时，最多保留 2048 行；
//! - 空闲期收到的数据视为主动上报（raw_data 推给前端）；
//! - 有命令等待时，只截取绝不可能出现在查询应答里的上报（来电 RING/+CLIP、
//!   短信 +CMTI、通话 ^CEND 等）；^REJINFO/+CUSD/+CDSI 经 passthrough 一并纳入；
//! - `abcd` 打断绕过命令锁直接写入（供扫频使用）。

use crate::{log_debug, log_info, log_warn};
use crate::at_queue::{AtPriority, PriLock, SmsMode, SmsTransaction};
use crate::config::AtConfig;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex, Notify};

const COMMAND_GAP: Duration = Duration::from_millis(100);
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);

/// 短信提交（`AT+CMGS=<长度>` 后面同一条命令里就带着 PDU，见
/// [is_single_shot_cmgs]）的应答预算。
///
/// 为什么必须单独给：普通查询是「模组本地算一下就回」，2 秒足够；而提交短信要
/// 把 TPDU 交给网络侧，`+CMGS` 的回执取决于信号与基站排队，实测弱信号下要好几秒
/// 甚至十几秒。原来统一 2 秒，提交必然超时 —— 前端于是显示
/// 「模组无响应（已等待 2000ms）」，而短信其实可能已经发出去了。
///
/// 40 秒的依据：3GPP 27.005 允许模组在网络侧排队较久；这里取一个既能容忍弱信号、
/// 又不会让用户觉得「卡死」的值（前端另有同量级的上限）。
pub const SMS_SUBMIT_TIMEOUT: Duration = Duration::from_secs(40);

/// 短信列表（`AT+CMGL=4`）与短信正文读取的应答预算。
///
/// 同样是短信链路，但比提交短得多：列全量短信时模组要一条条吐 PDU，几十条
/// 时远超普通查询的 2 秒，又不需要像提交那样等网络侧回执。25 秒是实测留的余量。
pub const SMS_LIST_TIMEOUT: Duration = Duration::from_secs(25);
/// 等待命令锁的独立预算。
///
/// 背景（AT 终端「只有 ATI 有回复」的根因）：
/// 服务启动/重连时会先跑 `init_modem()` 的一串初始化和自动拨号对齐命令，
/// 这些命令全程占着通道不释放。此前 `send_command_inner` 的超时是从进入函数
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
/// 手册 16.18.1 给出两种应答形态，16.18.5 的实例是全字段那一种：
///   `^SETAUTODIAL: 1,1,"IP","cmnet","","",0` → 字段 1 = 开关（0=关 / 1=开），
///   字段 2 = 拨号方式（0=模组内部拨号 / 1=上位机 USB 数传 / 2=上位机 网口数传，16.18.3）
///   `^SETAUTODIAL: 1`                        → 只有开关，方式为 None（「无法判定」，不是「不匹配」）
/// 同一节的语法页还把全字段形态印作 `^SETAUTODAIL:`（DIA 与 DAI 顺序互换），
/// 手册两处口径不一致，故两种拼写都接受，否则真机回这一种时会被当成「读不到」而反复重下配置。
/// 解析失败返回 None，调用方据此决定是否直接下发设置。
///
/// 为什么必须把方式一起解析出来：只看开关会造成
/// 「开关已是 1、但方式停在 2（转网口模式）」时直接跳过下发，
/// 而期望是 1（USB 网络接口）——USB 网口永远收不到模组下发的 DHCP，
/// MT5700M 接口长期没有 IP。这是「模组在线却上不了网」的一条独立成因。
///
/// 方式只认 1/2：本插件的数据通道就是这两种，模组停在 0（内部拨号）时
/// 按「无法判定」处理，走同一条重新对齐的路径。
fn parse_autodial_state(text: &str) -> Option<(bool, Option<i64>)> {
    for line in text.replace('\r', "").lines() {
        let line = line.trim();
        if !line.starts_with("^SETAUTODIAL:") && !line.starts_with("^SETAUTODAIL:") {
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

/// 从 `AT^NDISSTATQRY?` 应答取 CID 1 的 USB 数据面连接状态。
///
/// 手册 16.4.1/16.4.5 的应答形如 `^NDISSTATQRY: 1,1,,,"IPV4",0,,,"IPV6"`，
/// 结构是 `<cid>,<stat>[,<err>[,<wx_state>[,<PDP_type>]]] [<stat>,<err>,<wx_state>,<PDP_type>]`，
/// 可以一次上报一组或两组（IPv4 / IPv6）状态。**首字段是 <cid>，不是连接状态**：
/// 早先按「首字段 1=就绪」解析，只要模组回里带 CID 1 就永远判定为已连接 ——
/// 数据面已经掉线（`1,0,,,"IPV4",...`）时拨号守护同样不再补拨，界面也显示已连接。
/// <stat>：0=断开 1=已连接 2=连接中 3=断开中（后两个模组暂不上报，见 16.4.3）。
/// 本插件的数据通道固定 CID 1，因此只看 CID 1 那一行的 IPv4 状态；
/// 找不到该行或字段不可判定时返回 None（「无法判定」，不是「未就绪」）。
/// 注意：带参数的 `AT^NDISSTATQRY=<cid>` 才是以 <ipv4_stat> 开头，插件只用 `?` 形式。
fn parse_ndis_state(text: &str) -> Option<bool> {
    for line in text.replace('\r', "").lines() {
        let line = line.trim();
        if !line.starts_with("^NDISSTATQRY:") {
            continue;
        }
        let payload = &line[line.find(':')? + 1..];
        let mut fields = payload.split(',').map(|f| f.trim().trim_matches('"'));
        let cid = fields.next()?.trim();
        let stat = fields.next()?.trim();
        if cid != "1" {
            continue;
        }
        return match stat {
            "1" => Some(true),
            "0" | "2" | "3" => Some(false),
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

/// 扫频期间数据面操作的原始状态快照（供 prepare/restore_scan_data_plane 配对使用）。
///
/// 背景：模组在数据业务激活时拒绝 `AT^CELLSCAN`（`+CME ERROR: operation not allowed`），
/// 全网扫频必须先断开蜂窝数据才能进行。prepare 记录断连前的真实状态并断开数据面，
/// 扫频结束（无论成功/失败/超时/取消）后 restore 依据快照无条件恢复，杜绝「扫完一直断网」。
#[derive(Debug, Default, Clone)]
pub struct ScanDataPrior {
    /// 断连前自动拨号是否开启。
    pub autodial_on: bool,
    /// 断连前自动拨号方式（1=USB 网络接口 / 2=转网口模式；模组未回方式时为 None）。
    pub autodial_mode: Option<i64>,
    /// 断连前 NDIS 数据面是否激活。
    pub ndis_active: bool,
    /// 是否实际执行过断连动作。false 表示数据面本未激活、无需恢复。
    pub did_disconnect: bool,
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
    /// true 时忽略 `> ` 输入提示符，必须等到真正的结束码。
    ///
    /// 仅用于「一次写完整条 `AT+CMGS=<长度>` + 分隔符 + `<PDU>`」的短信提交：
    /// 这台模组的正常路径不给 `> ` 提示符（手册 9.14.1 的应答里也没有它），但裸 AT
    /// 终端页的一次性写法仍可能先吃到一个 `> ` 再等回执。若把 `> ` 当成应答结束，
    /// 命令会提前返回 success，而此刻短信可能压根没提交完。
    pub ignore_prompt: bool,
}

pub struct Connection {
    writer: Arc<Mutex<Box<dyn tokio::io::AsyncWrite + Unpin + Send>>>,
    #[allow(dead_code)] // 仅构造时写入、从不读取；保留是为了不改动各处构造字面量的签名
    describe: String,
}

/// 进程单调时钟的毫秒数（自首次调用起）。
///
/// 长命令「什么时候结束的」是两个瞬时之间的**间隔**，不是墙上时间：
/// 必须用 `Instant` 这类单调时钟，否则 NTP 校正 / 手动改时间会让差值失真。
/// `Instant` 没法塞进原子量，这里折算成「距进程起点的毫秒」再存。
pub(crate) fn mono_ms() -> u64 {
    static ORIGIN: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    ORIGIN.get_or_init(Instant::now).elapsed().as_millis() as u64
}

pub struct AtClient {
    cfg: AtConfig,

    conn: Arc<Mutex<Option<Connection>>>,
    /// 连接标志（原子，供 Scheduler 等异步任务安全读取，替代阻塞式取锁）。
    connected_flag: Arc<AtomicBool>,
    /// 连接代次：每成功建立一次链路 +1。
    ///
    /// 定时锁频靠它识别「模组重连过」——USB 重枚举或模组自复位会把已下发的
    /// 锁频清掉，而 `connected_flag` 只是 true/false 两态，抖动一次再回来
    /// 看不出区别。代次是单调递增的，重连一次就变一次，判断不会被时序吃掉。
    connect_epoch: Arc<AtomicU64>,
    /// 扫频进行中标志：扫频期间数据面会被临时断开，autodial_watchdog 据此跳过对账，
    /// 避免把「扫频导致的未就绪」误判为拨号故障而抢先重拨（会与扫频恢复逻辑抢 CID）。
    scan_active: Arc<AtomicBool>,
    urc_tx: mpsc::Sender<Unsolicited>,

    /// AT 通道的「唯一放行闸」：所有命令按优先级排队申请。
    /// 业务模块不能直接碰 TTY，只能经 send_command 走这个闸。
    gate: Arc<PriLock>,
    /// 短信优先模式的暂停门：非短信命令在它的入口等待模式解除。
    sms_mode: Arc<SmsMode>,
    long_cmd: Arc<AtomicI32>,
    long_cmd_end: Arc<AtomicU64>,
    last_cmd_at: Arc<Mutex<Instant>>,

    pending: Arc<Mutex<Option<PendingCmd>>>,
}

/// 非短信命令在短信优先模式下的等待预算：按优先级分级（issue #23）。
///
/// 旧实现对所有非短信命令一刀切等 30s：页面状态查询（Normal）与后台巡检
/// （Low）一个待遇，短信中心开着的时候其它页面全部干等满 30s 才失败，
/// 再叠加前端 14s 的 RPC 超时，表现为「整个界面卡死」。
///
/// 分级依据：
///   - High（用户主动操作：AT 终端、强制刷新）：短等，坏了立刻给明确结论；
///   - Normal（页面状态查询）：中短等，保证页面 5s 内必有确定结果；
///   - Low / Background（后台巡检、缓存刷新）：零预算直接跳过本轮 ——
///     错过一轮下一轮补上，不该占着 worker 干等。
///
/// 等待超时的错误文案带 `sms_busy:` 前缀（前端 rpc.js 据此 2s 退避自动重试），
/// 零预算的跳过带 `sms_skip:` 前缀（后台任务，无需重试）。
pub fn sms_mode_budget(prio: AtPriority) -> Duration {
    match prio {
        AtPriority::High => Duration::from_secs(3),
        AtPriority::Normal => Duration::from_secs(5),
        AtPriority::Low | AtPriority::Background | AtPriority::Sms => Duration::ZERO,
    }
}

/// 短信事务协作让出阈值：持有超过这么久且门外有排队者时，让出一次通道，
/// 让被挡住的交互命令插进来，再以 Sms 优先级抢回（issue #23）。
///
/// 让出只发生在**命令边界**：PDU 会话上下文不跨让出点，事务完整性不受影响。
/// `sms.list` 的单条 `AT+CMGL=4` 无法中途让出（一条命令一个 RPC），那种场景
/// 由分级预算兜底（High 3s 内得到明确结论 + 前端自动重试）。
const SMS_TX_YIELD_AFTER: Duration = Duration::from_secs(5);

/// 让出后的抢回等待：给 [GatePermit] Drop 的「释放 + 派发」留出执行窗口
/// （Drop 内部是 spawn，不占当前任务，但需要一次调度才会真正让出）。
const SMS_TX_YIELD_GRACE: Duration = Duration::from_millis(100);

impl AtClient {
    pub fn new(cfg: AtConfig, urc_tx: mpsc::Sender<Unsolicited>) -> Arc<Self> {
        Arc::new(AtClient {
            cfg,
            conn: Arc::new(Mutex::new(None)),
            connected_flag: Arc::new(AtomicBool::new(false)),
            connect_epoch: Arc::new(AtomicU64::new(0)),
            scan_active: Arc::new(AtomicBool::new(false)),
            urc_tx,
            gate: PriLock::new(),
            sms_mode: SmsMode::new(),
            long_cmd: Arc::new(AtomicI32::new(0)),
            long_cmd_end: Arc::new(AtomicU64::new(0)),
            last_cmd_at: Arc::new(Mutex::new(Instant::now())),
            pending: Arc::new(Mutex::new(None)),
        })
    }

    /// 短信优先模式的句柄（供 RPC 层登记/释放会话租约）。
    pub fn sms_mode(&self) -> Arc<SmsMode> {
        self.sms_mode.clone()
    }

    /// 短信优先模式是否生效（供缓存刷新等后台任务避让，issue #23）。
    pub async fn sms_mode_active(&self) -> bool {
        self.sms_mode.active().await
    }

    pub fn connection_type(&self) -> &str {
        &self.cfg.type_
    }

    pub fn connected(&self) -> bool {
        // 纯原子读取：绝不能在这里取锁阻塞（Scheduler 在异步循环中调用）。
        self.connected_flag.load(Ordering::Relaxed)
    }

    /// 当前连接代次（每次成功建链 +1）。同样只做原子读取，不加锁。
    pub fn connect_epoch(&self) -> u64 {
        self.connect_epoch.load(Ordering::Relaxed)
    }

    /// 标记扫频进行中。true 时 autodial_watchdog 暂停对账，避免与扫频恢复逻辑抢 CID。
    pub fn set_scan_active(&self, v: bool) {
        self.scan_active.store(v, Ordering::Relaxed);
    }

    pub fn scan_active(&self) -> bool {
        self.scan_active.load(Ordering::Relaxed)
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

        // 短信优先模式的租约清扫：即使前端没发释放请求，到期租约也会自动失效，
        // 后台巡检不会被永久挡在门外。
        {
            let mode = self.sms_mode.clone();
            let ctx_w = ctx.clone();
            tokio::spawn(async move { mode.run(ctx_w).await });
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
            self.connect_epoch.fetch_add(1, Ordering::Relaxed);

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
        // 链路断开关对会造成影响：短信事务无法再完成，租约必须马上清掉，
        // 否则后台巡检会在重连后整段地被挡住。
        self.sms_mode.release_all().await;

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
        /*
         * AT+CNMI=2,1,0,2,0 —— 手册 8.3.3 的五个参数依次是 mode / mt / bm / ds / bfr：
         *   mode=2  短信通知与状态报告都直接送 TE；送不出去时（例如 online data 模式）
         *           先缓存在 ME，能发了再一次性补上。8.3.3 的说明还规定：mode=0 或 2
         *           时 <mt> 不能取 2/3、<ds> 不能取 1，配错了模组直接报错。
         *   mt=1    短信**存在 MT 里**并上报 `+CMTI: "<mem>",<index>`（8.4）。
         *           这是本插件要的形状：列表、删除、容量都以存储里的真实条目为准；
         *           mt=2/3 是把 PDU 甩成 `+CMT` 且不落盘，那样界面就没有可删的条目了。
         *   bm=0    小区广播（CBM）不上报，本页不处理 CBS。
         *   ds=2    短信回执存在 MT 里并上报 `+CDSI: "<mem>",<index>`（8.5）。
         *           回执内容界面暂不展示，但这条上报必须被认成主动上报，
         *           否则它会混进正在等待的那条命令的应答行里。
         *   bfr=0   从 mode=0 切到 mode=1/2 后，把之前缓存的通知一次性发给 TE
         *           （取 1 才是清空丢掉，用户会看不到断连期间来的短信）。
         * 查询失败或应答不含目标值时都要重新 SET：手册 8.3.4 的掉电保存是 N，
         * 8.3.2 也写明 MT 重启后 CNMI 会回到 0,0,0,0,0 —— 那样一条 +CMTI 都收不到。
         */
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
    ///
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

    /// 数据面是否就绪。先看 USB 网口状态，再回退看 PDP 激活位。
    /// 只要拿不到可判定的读数就**倾向放过**（含 NDISSTATQRY 报了未就绪、
    /// 但 CGACT? 给不出行的组合）—— 宁可放过，也不要因判定工具缺失而反复下发。
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

    /// 扫频前的数据面准备：记录原状态并断开蜂窝数据。
    ///
    /// 模组在数据业务激活时拒绝 `AT^CELLSCAN`，必须先断开才能扫。这里：
    ///   1) 查询并记录自动拨号开关/方式与 NDIS 数据面状态；
    ///   2) 数据面未激活且自动拨号本就关闭时直接跳过（无卡扫描等场景不断不恢复）；
    ///   3) 先关自动拨号（防止模组在断开后自动重拨、与恢复逻辑争用 CID），再撤数据面；
    ///   4) 给模组 1.5s 收尾，避免紧随其后的 CELLSCAN 撞上 PDP 拆除。
    ///
    /// 返回快照，扫频结束后必须用 [Self::restore_scan_data_plane] 成对恢复。
    pub async fn prepare_scan_data_plane(&self, ctx: &tokio::sync::watch::Receiver<bool>) -> ScanDataPrior {
        let mut prior = ScanDataPrior::default();

        // 1) 自动拨号状态（开关 + 方式）。
        match self.send_command(ctx, "AT^SETAUTODIAL?", COMMAND_TIMEOUT, None).await {
            Ok(resp) => match parse_autodial_state(&resp.text()) {
                Some((on, mode)) => {
                    prior.autodial_on = on;
                    prior.autodial_mode = mode;
                }
                None => log_warn!("扫频前查询自动拨号状态无法解析: {}", resp.text()),
            },
            Err(e) => log_warn!("扫频前查询自动拨号状态失败: {}", e),
        }
        // 2) NDIS 数据面激活状态（无法判定按未激活处理，宁可多断一次也不要漏断）。
        if let Ok(resp) = self.send_command(ctx, "AT^NDISSTATQRY?", COMMAND_TIMEOUT, None).await {
            prior.ndis_active = parse_ndis_state(&resp.text()).unwrap_or(false);
        }

        // 3) 本就无网：直接扫，无需断连与恢复。
        if !prior.autodial_on && !prior.ndis_active {
            log_info!("扫频前数据面未激活，无需断连");
            return prior;
        }

        // 4) 先关自动拨号再撤数据面。
        if prior.autodial_on {
            match self.send_command(ctx, "AT^SETAUTODIAL=0", COMMAND_TIMEOUT, None).await {
                Ok(resp) if resp.ok() => log_info!("扫频前已关闭自动拨号"),
                Ok(resp) => log_warn!("扫频前关闭自动拨号未返回 OK: {}", resp.text()),
                Err(e) => log_warn!("扫频前关闭自动拨号失败: {}", e),
            }
        }
        match self.send_command(ctx, "AT^NDISDUP=1,0", COMMAND_TIMEOUT, None).await {
            Ok(resp) if resp.ok() => log_info!("扫频前已断开蜂窝数据"),
            Ok(resp) => log_warn!("扫频前断开蜂窝数据未返回 OK: {}", resp.text()),
            Err(e) => log_warn!("扫频前断开蜂窝数据失败: {}", e),
        }
        prior.did_disconnect = true;

        // 5) 短暂收尾，确保 PDP 拆除完成再下发 CELLSCAN。
        sleep_ctx(ctx, Duration::from_millis(1500)).await;
        prior
    }

    /// 扫频结束后的数据面恢复（成功/失败/超时/取消统一调用，无条件执行）。
    ///
    /// 原自动拨号开启 → 只恢复自动拨号（模组自会重拨，不手动 NDISDUP 以免与自动拨号争用 CID）；
    /// 原自动拨号关闭但数据面原已激活 → 手动恢复 NDISDUP=1,1。
    /// 恢复失败仅记日志，由 autodial_watchdog 周期对账兜底，不会长期断网。
    pub async fn restore_scan_data_plane(&self, ctx: &tokio::sync::watch::Receiver<bool>, prior: &ScanDataPrior) {
        if !prior.did_disconnect {
            return;
        }
        // 给模组短暂时间退出扫频独占态，避免恢复命令与扫频收尾交叠。
        sleep_ctx(ctx, Duration::from_millis(300)).await;

        if prior.autodial_on {
            let mode = prior.autodial_mode.unwrap_or_else(|| self.cfg.autodial_mode.clamp(1, 2));
            let cmd = format!("AT^SETAUTODIAL=1,{mode}");
            match self.send_command(ctx, &cmd, COMMAND_TIMEOUT, None).await {
                Ok(resp) if resp.ok() => log_info!("扫频结束，已恢复自动拨号（{}）", cmd),
                Ok(resp) => log_warn!("扫频结束，恢复自动拨号未返回 OK: {}", resp.text()),
                Err(e) => log_warn!("扫频结束，恢复自动拨号失败: {}（周期对账将兜底）", e),
            }
        } else if prior.ndis_active {
            match self.send_command(ctx, "AT^NDISDUP=1,1", COMMAND_TIMEOUT, None).await {
                Ok(resp) if resp.ok() => log_info!("扫频结束，已恢复蜂窝数据连接"),
                Ok(resp) => log_warn!("扫频结束，恢复蜂窝数据未返回 OK: {}", resp.text()),
                Err(e) => log_warn!("扫频结束，恢复蜂窝数据失败: {}（周期对账将兜底）", e),
            }
        }
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
            // 扫频进行中：数据面被临时断开，跳过本轮对账（恢复由 run_cell_scan 负责，
            // 周期对账的下一轮自然会复核，不差这 5 分钟）。
            if self.scan_active() {
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


    /// 串行发送一条 AT 命令并等待结束码。普通优先级（状态查询 / 网络 / SIM 等）。
    /// 注意：超时前若已收到任意行，返回 Ok 并携带这些部分行；仅当一行未收到时才返回超时错误。
    pub async fn send_command(
        &self,
        ctx: &tokio::sync::watch::Receiver<bool>,
        command: &str,
        timeout: Duration,
        stream: Option<Box<dyn Fn(String) + Send + Sync>>,
    ) -> Result<AtResponse, String> {
        self.send_command_pri(ctx, AtPriority::Normal, command, timeout, stream)
            .await
    }

    /// 以显式优先级发送一条 AT 命令并等待结束码。
    pub async fn send_command_pri(
        &self,
        ctx: &tokio::sync::watch::Receiver<bool>,
        prio: AtPriority,
        command: &str,
        timeout: Duration,
        stream: Option<Box<dyn Fn(String) + Send + Sync>>,
    ) -> Result<AtResponse, String> {
        self.send_command_inner(ctx, prio, command, timeout, stream).await
    }

    /// 扫频一类长命令：Background 优先级（不抢占终端/状态查询），可指定超时，
    /// 并通过 stream 实时拿到每一行应答。
    pub async fn send_long_command(
        &self,
        ctx: &tokio::sync::watch::Receiver<bool>,
        command: &str,
        timeout: Duration,
        stream: Option<Box<dyn Fn(String) + Send + Sync>>,
    ) -> Result<AtResponse, String> {
        self.long_cmd.fetch_add(1, Ordering::SeqCst);
        let result = self
            .send_command_inner(ctx, AtPriority::Background, command, timeout, stream)
            .await;
        self.long_cmd_end.store(mono_ms(), Ordering::SeqCst);
        self.long_cmd.fetch_sub(1, Ordering::SeqCst);
        result
    }

    pub fn long_command_active(&self) -> bool {
        self.long_cmd.load(Ordering::SeqCst) > 0
    }

    pub fn long_command_ended_at(&self) -> Option<Instant> {
        let end = self.long_cmd_end.load(Ordering::SeqCst);
        if end == 0 {
            return None;
        }
        let now = mono_ms();
        if now < end {
            // 回拨（理论上单调时钟不会，兜底）：视为刚结束
            return Some(Instant::now());
        }
        Instant::now().checked_sub(Duration::from_millis(now - end))
    }

    // ============= 短信事务：多步骤操作的通道独占 =============

    /// 开启一次短信事务，返回独占通道的句柄。
    ///
    /// 事务内的所有命令通过 [Self::run_in_transaction] 下发，中间**不释放**通道，
    /// 因此「长短信分片发送」「批量删除」「读列表 + 读正文」这类多步骤流程
    /// 不会被任何其它 AT 命令从中间插进来。
    ///
    /// `label` 仅用于日志，便于在命令日志里看出某一串命令属于哪个事务。
    pub async fn open_sms_transaction(
        &self,
        ctx: &tokio::sync::watch::Receiver<bool>,
        label: &str,
        wait: Duration,
    ) -> Result<SmsTransaction, String> {
        let permit = self.gate.acquire(AtPriority::Sms, ctx, wait).await?;
        log_debug!("短信事务开始: {}", label);
        Ok(SmsTransaction::new(permit, label.to_string()))
    }

    /// 在事务持有的通道上下发一条 AT 命令。
    ///
    /// 与 `send_command_pri` 的区别：不再申请闸（已持有），也不经过短信模式的
    /// 暂停门（短信命令本就该优先）。短信提交类命令自动按一次完整提交处理：
    /// `> ` 提示符不算应答结束，必须等到 `+CMGS:` / OK / ERROR。
    pub async fn run_in_transaction(
        &self,
        ctx: &tokio::sync::watch::Receiver<bool>,
        tx: &SmsTransaction,
        command: &str,
        timeout: Duration,
    ) -> Result<AtResponse, String> {
        // 协作让出检查点（issue #23）：事务持有超过阈值且门外有排队者时，
        // 主动交出通道一次，让页面查询 / AT 终端插进来，再以 Sms 优先级抢回。
        // 分片发送、批量删除这类多步骤流程因此在步骤间形成天然让出点，
        // 长事务不再无限期饿死交互命令。
        if tx.held_since() >= SMS_TX_YIELD_AFTER && self.gate.has_waiters().await {
            crate::log_debug!(
                "短信事务 {} 已持有 {}s，门外有等待者，协作让出一次",
                tx.label(),
                tx.held_since().as_secs()
            );
            tx.relinquish().await;
            tokio::time::sleep(SMS_TX_YIELD_GRACE).await;
            let permit = self
                .gate
                .acquire(AtPriority::Sms, ctx, QUEUE_WAIT_TIMEOUT)
                .await?;
            tx.restore(permit).await;
        }
        if !tx.holds_channel().await {
            return Err(format!("短信事务 {} 已失效，拒绝下发 {}", tx.label(), command.trim()));
        }
        let single_shot_submit = is_single_shot_cmgs(command) || is_cmgs_payload(command);
        self.exec_locked(ctx, command, timeout, None, single_shot_submit).await
    }

    /// 以短信最高优先级发送单条命令（事务之外的短信读任务，例如 `+CMTI` 触发的 CMGR）。
    ///
    /// 它会越过短信模式的暂停门（否则短信自己把自己挡在门外），并以 Sms 优先级
    /// 排在所有其它命令之前。
    pub async fn send_sms_command(
        &self,
        ctx: &tokio::sync::watch::Receiver<bool>,
        command: &str,
        timeout: Duration,
    ) -> Result<AtResponse, String> {
        self.send_command_pri(ctx, AtPriority::Sms, command, timeout, None)
            .await
    }

    /// 测试专用：把一条双向管道装成模组连接。
    ///
    /// 生产代码里连接只由 `run()` 建立，测试没有第二条通道可用，所以要留一个
    /// 注入点。它不参与 release 构建。
    #[cfg(test)]
    pub(crate) async fn attach_test_channel(
        &self,
        writer: Box<dyn tokio::io::AsyncWrite + Unpin + Send>,
    ) {
        *self.conn.lock().await = Some(Connection {
            writer: Arc::new(Mutex::new(writer)),
            describe: "test-duplex".into(),
        });
        self.connected_flag.store(true, Ordering::Relaxed);
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
        prio: AtPriority,
        command: &str,
        timeout: Duration,
        stream: Option<Box<dyn Fn(String) + Send + Sync>>,
    ) -> Result<AtResponse, String> {
        // 第 0 段预算：短信优先模式。
        // 非短信命令在短信模式生效期间一律停在入口等待 —— 后台巡检、自动拨号对账、
        // 缓存刷新此时不能产生新的 AT，否则会和正在进行的短信事务抢同一条 TTY。
        // 等待本身有上限：超时给出明确文案，不会把命令硬塞进通道造成响应串线。
        if !prio.is_sms() {
            self.sms_mode
                .wait_clear(ctx, sms_mode_budget(prio), command)
                .await?;
        }

        // 第一段预算：排队（按优先级申请放行闸 + 最小命令间隔）。
        // 这段不计入应答超时，否则初始化/重连期间用户的命令会被误判为「模组无响应」。
        // acquire 内部已处理 wait 超时与 ctx 取消，这里直接收其结果即可。
        // 下划线前缀不是「不用」，而是「它唯一的用途就是活着」：
        // permit 的存在期间即通道独占期间，Drop 才让出。
        let _gate_permit = self
            .gate
            .acquire(prio, ctx, QUEUE_WAIT_TIMEOUT)
            .await?;

        // 一次性提交（长度与 PDU 同一条命令）与 PDU 载荷段不能被 `> ` 提示符提前
        // 结束应答，判据与 [run_in_transaction] 完全一致 —— 否则裸 AT 终端页会
        // 把「模组只给了个提示符」报成一次成功应答，而短信根本没提交完。
        let single_shot_submit = is_single_shot_cmgs(command) || is_cmgs_payload(command);
        self.exec_locked(ctx, command, timeout, stream, single_shot_submit)
            .await
    }

    /// 通道已被本调用方持有时下发一条命令（不重复申请闸）。
    ///
    /// 调用方必须自己持有 [GatePermit]（直接地、或通过 [SmsTransaction] 间接地）
    /// 并在整段 await 期间不释放它 —— 这就是「通道由谁独占」的唯一凭据。
    ///
    /// 短信提交相关的命令自动按「还没说完」处理：`> ` 输入提示符不算应答结束，
    /// 必须等到 `+CMGS:` / OK / ERROR（例外情形见 [is_cmgs_payload] 的注释）。
    async fn exec_locked(
        &self,
        ctx: &tokio::sync::watch::Receiver<bool>,
        command: &str,
        timeout: Duration,
        stream: Option<Box<dyn Fn(String) + Send + Sync>>,
        ignore_prompt: bool,
    ) -> Result<AtResponse, String> {
        // 两条命令之间最小间隔。
        {
            let last = self.last_cmd_at.lock().await;
            let gap = COMMAND_GAP.saturating_sub(last.elapsed());
            if !gap.is_zero() && !sleep_ctx(ctx, gap).await {
                return Err("上下文取消".into());
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
            // 单次提交的短信：`> ` 提示符不能当作应答结束，必须等到真正的
            // `+CMGS:` / OK / ERROR，否则会重演「Modem 还在收 PDU，前端已报成功」。
            ignore_prompt,
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
        // 方向标记：常规命令（含内部初始化、自动拨号对齐）都从这一行写出去，
        // 在这层记录才最接近"我们发给模组什么"。唯一例外是 interrupt() 的 `abcd`
        // 打断串——它刻意绕过命令锁直接 write_all，不走这条路径、也就不会出现在这里。
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
            // 极端情形：结束码行内容与命令回显相同而被过滤，于是有应答标记却无内容。
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
                if !sleep_ctx(ctx, ZERO_READ_BACKOFF).await {
                    return Ok(());
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
        // 单次提交（命令串里同带长度与 PDU）例外：必须等真正的结束码，
        // 见 PendingCmd::ignore_prompt。
        if data.iter().all(|b| b.is_ascii_whitespace() || *b == b'>') && data.contains(&b'>') {
            let mut pending = self.pending.lock().await;
            let ignore = pending.as_ref().map(|p| p.ignore_prompt).unwrap_or(false);
            if ignore {
                drop(pending);
                return Vec::new();
            }
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

/// 判断是否为「一次性写完整条提交串」的 `AT+CMGS`：长度与 PDU 在同一条命令里。
///
/// 两种分隔符都要认：
///   - **字面的 `\r`**（反斜杠 + 字母 r 两个字符）—— 手册 9.14.5 举例与厂商 WebUI
///     实际下发的形态，也是这台模组唯一认的形态（真 CR 那种只回显、不应答）；
///     业务路径 `sms::send` 走的就是这一种。
///   - 真实的 CR —— 裸 AT 终端页里用户手敲或脚本贴进来的形态。
///
/// 两种都不能被 `> ` 提示符提前结束应答：模组对这条形态是直接给 `+CMGS:` / OK，
/// 把它当成「停在提示符上的一次普通命令」会把回执丢到下一条应答里。
/// 只报长度的那一半（`AT+CMGS=14`，两种分隔符都没有）不算 —— 它确实要停在 `> ` 上。
pub fn is_single_shot_cmgs(command: &str) -> bool {
    command.starts_with("AT+CMGS=") && (command.contains('\r') || command.contains("\\r"))
}

/// 判断是否为「两段式提交里 PDU 那一半」：以 Ctrl+Z 结尾就是提交体，
/// 不是新的一条 AT 命令。
///
/// 它同样不能被 `> ` 提示符结束（模组偶尔会在收完 PDU 前再提示一次），
/// 必须等到真正的 `+CMGS:` / OK / ERROR。
pub fn is_cmgs_payload(command: &str) -> bool {
    command.ends_with('\u{1a}')
}

/// 只匹配不可能出现在查询应答里的主动上报。
pub fn is_exclusive_urc(line: &str) -> bool {
    match line {
        "RING" | "IRING" | "^IRING" | "NO CARRIER" => return true,
        _ => {}
    }
    // +CMTI（手册 8.4）与 +CDSI（8.5）都是纯上报：没有对应的读命令，永远不会
    // 是某条命令的应答。CNMI 设成 mt=1、ds=2 后两者都会来，漏掉 +CDSI 就会被
    // 塞进正在等待的那条命令的应答行里，打断「头行 + 下一行 PDU」的配对。
    if line.starts_with("+CMTI:")
        || line.starts_with("+CDSI:")
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
    // 状态报告索引本插件暂不解析（短信中心页面不展示送达回执），
    // 但也不能让它安静地消失：原样推给前端，日志里看得见「模组报过回执」。
    if line.starts_with("+CDSI:") {
        return true;
    }
    line.starts_with("+CUSD:") && line.contains(',')
}

/// 通知系统侧「拨号已就绪」，由本包提供的钩子脚本拉起承载接口。
///
/// 时序意义：接口侧（init.d / hotplug）无法知道模组何时真正拨号成功，
/// 只能靠开机时抢跑 + 猜时间窗口，冷启动很容易错过（实测整条链路
/// USB 枚举→驻网→下发 DHCP 常见 30~60s）。
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

    #[test]
    fn sms_mode_budget_tiers_by_priority() {
        // issue #23：分级预算，High 短等 / Normal 中短等 / 后台零预算直接跳过
        assert_eq!(sms_mode_budget(AtPriority::High), Duration::from_secs(3));
        assert_eq!(sms_mode_budget(AtPriority::Normal), Duration::from_secs(5));
        assert_eq!(sms_mode_budget(AtPriority::Low), Duration::ZERO);
        assert_eq!(sms_mode_budget(AtPriority::Background), Duration::ZERO);
    }
    use super::*;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncRead, ReadBuf};

    /// 一次性提交的识别：字面 `\r`（业务路径与厂商形态）与真实 CR（终端页手敲）
    /// 都要认，只报长度的那半步都不能认——它确实要停在 `> ` 提示符上。
    #[test]
    fn single_shot_cmgs_recognizes_both_separators() {
        assert!(is_single_shot_cmgs("AT+CMGS=18\\r0015660B3108108300F00008FF04"));
        assert!(is_single_shot_cmgs("AT+CMGS=18\r0015660B3108108300F00008FF04"));
        assert!(!is_single_shot_cmgs("AT+CMGS=18"), "只报长度：要等提示符");
        assert!(!is_single_shot_cmgs("AT+CMGS=18\n001566"), "LF 不是分隔符");
        assert!(!is_single_shot_cmgs("AT+CMGF=0\\r"), "不是提交命令");
    }

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
        // 手册 16.18.1 的语法页把同一行印作 ^SETAUTODAIL:（少一个 I），两种拼写都要认；
        // 这里的 dial_mode=0（模组内部拨号）不在本插件的通道之内 → 方式为 None（需重新对齐）
        assert_eq!(
            parse_autodial_state("^SETAUTODAIL:1,0,\"IPV4V6\",\"\",\"\",\"\",0\r\nOK"),
            Some((true, None))
        );
        assert_eq!(
            parse_autodial_state("^SETAUTODAIL: 1,1\r\nOK"),
            Some((true, Some(1)))
        );
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
    fn parse_ndis_state_reads_cid_stat_pair() {
        // 手册 16.4.5 举例：首字段是 CID，第二字段才是连接状态
        assert_eq!(
            parse_ndis_state("^NDISSTATQRY: 1,1,,,\"IPV4\",0,,,\"IPV6\"\r\nOK"),
            Some(true)
        );
        // 同样带 CID 1，但状态是 0（断开）—— 旧实现读首字段会误判为「已连接」
        assert_eq!(
            parse_ndis_state("^NDISSTATQRY: 1,0,32,,\"IPV4\",,,,\"IPV6\"\r\nOK"),
            Some(false)
        );
        // 多组上报：IPv6 组已连、IPv4 组断开 → 数据面（USB 网口按 IPv4 通道）未就绪
        assert_eq!(parse_ndis_state("^NDISSTATQRY: 1,0,,,\"IPV4\",1,,,\"IPV6\"\r\nOK"), Some(false));
        // 只有 CID 2 的行：读不到本插件通道（CID 1）的状态 → 无法判定
        assert_eq!(parse_ndis_state("^NDISSTATQRY: 2,1,,,\"IPV4\"\r\nOK"), None);
        // 字段缺失 / 非数字 → 无法判定
        assert_eq!(parse_ndis_state("^NDISSTATQRY: 1\r\nOK"), None);
        assert_eq!(parse_ndis_state("^NDISSTATQRY: 1,x,,,\"IPV4\"\r\nOK"), None);
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
    /// 构造：先占用命令闸（gate）一小段时间模拟「初始化序列正在发命令」，
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

        // 先抢住放行闸 600ms，模拟初始化序列占用通道。
        let holder = {
            let gate = client.gate.clone();
            let ctx_h = ctx.clone();
            tokio::spawn(async move {
                let permit = gate.acquire(AtPriority::High, &ctx_h, QUEUE_WAIT_TIMEOUT).await.unwrap();
                tokio::time::sleep(Duration::from_millis(600)).await;
                drop(permit);
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

        // 永久占住放行闸（模拟通道被长时间占用/卡死）。
        let holder = {
            let gate = client.gate.clone();
            let ctx_h = ctx.clone();
            tokio::spawn(async move {
                let permit = gate.acquire(AtPriority::High, &ctx_h, QUEUE_WAIT_TIMEOUT).await.unwrap();
                tokio::time::sleep(Duration::from_secs(60)).await;
                drop(permit);
            })
        };
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

/// 模拟模组的测试装置。
///
/// 目标是用**真实的 AtClient + 真实的读循环 + 真实的命令闸**跑短信流程，
/// 只把「模组那一端」换成可编程的应答器。这样测出来的命令顺序、字节序列、
/// 优先级行为才和实机一致 —— mock 掉太多层就只剩下自娱自乐。
#[cfg(test)]
pub(crate) mod testutil {
    use super::AtClient;
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 一次应答的形态。
    pub(crate) enum Reply {
        /// 回若干行（每行自带结束码语义），例如 `vec!["+CMGS: 1".into(), "OK".into()]`。
        Lines(Vec<String>),
        /// 回 `> ` 输入提示符（**不带换行**），随后的一段被当作 PDU。
        Prompt,
        /// 什么都不回（模拟模组无响应，用于验证超时不被当成失败）。
        Silent,
    }

    impl Reply {
        pub(crate) fn ok(extra: &[&str]) -> Reply {
            let mut v: Vec<String> = extra.iter().map(|s| s.to_string()).collect();
            v.push("OK".into());
            Reply::Lines(v)
        }
    }

    /// 装好并返回记录器：`written` 是**原始写入字节**（字节级验证用），
    /// `commands` 是按 `\r` 切出的命令段（顺序验证用）。
    pub(crate) struct MockModem {
        pub written: Arc<StdMutex<Vec<Vec<u8>>>>,
        pub commands: Arc<StdMutex<Vec<String>>>,
    }

    impl MockModem {
        /// 截至目前写入串口的全部字节（按写入批次拼接后的完整流）。
        pub fn stream(&self) -> Vec<u8> {
            let guard = self.written.lock().unwrap_or_else(|e| e.into_inner());
            guard.iter().flatten().copied().collect()
        }
        pub fn cmds(&self) -> Vec<String> {
            self.commands.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }
    }

    /// 把 `client` 接到一个可编程的模拟模组上，并启动读循环。
    ///
    /// `responder` 按「以 \r 结尾的一段」回调，返回该段的应答。
    /// 对 `Reply::Prompt`，紧接着的下一段（PDU）自动回 `+CMGS` + OK，
    /// 这与真实模组「先吐提示符、收到 PDU 后才给回执」的行为一致。
    pub(crate) async fn attach_mock_modem(
        client: Arc<AtClient>,
        ctx: tokio::sync::watch::Receiver<bool>,
        responder: impl Fn(&str) -> Reply + Send + Sync + 'static,
    ) -> MockModem {
        let (host, device) = tokio::io::duplex(8192);
        let (mut dev_rd, mut dev_wr) = tokio::io::split(device);
        let (host_rd, host_wr) = tokio::io::split(host);

        client.attach_test_channel(Box::new(host_wr)).await;

        let written: Arc<StdMutex<Vec<Vec<u8>>>> = Arc::new(StdMutex::new(Vec::new()));
        let commands: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let w = written.clone();
        let c = commands.clone();
        tokio::spawn(async move {
            let mut buf: Vec<u8> = Vec::new();
            let mut tmp = [0u8; 1024];
            let mut expect_pdu = false;
            let mut silence = false;
            let mut swallow = false;
            loop {
                match dev_rd.read(&mut tmp).await {
                    Ok(0) => return,
                    Ok(n) => {
                        buf.extend_from_slice(&tmp[..n]);
                        w.lock().unwrap_or_else(|e| e.into_inner()).push(tmp[..n].to_vec());
                    }
                    Err(_) => return,
                }
                while let Some(i) = buf.iter().position(|&b| b == b'\r') {
                    let mut seg: Vec<u8> = buf.drain(..=i).collect();
                    seg.pop(); // 去掉结尾的 \r
                    let seg_str = String::from_utf8_lossy(&seg).to_string();
                    c.lock().unwrap_or_else(|e| e.into_inner()).push(seg_str.clone());

                    let is_cmd = seg_str.starts_with("AT");
                    let out: String = if expect_pdu && !is_cmd {
                        // 上一段回了 `> ` 提示符，这一段就是 PDU 载荷：
                        // 真实模组在收完 PDU 之后才给出 +CMGS 回执。
                        expect_pdu = false;
                        if silence {
                            String::new()
                        } else {
                            "+CMGS: 1\r\n\r\nOK\r\n".to_string()
                        }
                    } else if !is_cmd {
                        // 既不是命令、也不是被期待的 PDU：真实模组会报错。
                        // 早期版本这里一律回 OK，于是「模组其实没回话」的场景
                        // 被误判成发送成功，测试完全失去了意义。
                        if silence || swallow {
                            swallow = false;
                            String::new()
                        } else {
                            "ERROR\r\n".to_string()
                        }
                    } else {
                        silence = false;
                        match responder(&seg_str) {
                            Reply::Lines(lines) => {
                                // 一次性提交（`AT+CMGS=<len>\r<PDU>\r`）：模组把整串
                                // 当作一次输入，紧随其后的 PDU 段已被消费，不再单独应答。
                                swallow = seg_str.starts_with("AT+CMGS=");
                                let mut s = String::new();
                                for l in lines {
                                    s.push_str(&l);
                                    s.push_str("\r\n");
                                }
                                s
                            }
                            Reply::Prompt => {
                                expect_pdu = true;
                                "> ".to_string()
                            }
                            Reply::Silent => {
                                // 模组彻底不回话：连随后的 PDU 也不应答
                                silence = true;
                                String::new()
                            }
                        }
                    };
                    if !out.is_empty() && dev_wr.write_all(out.as_bytes()).await.is_err() {
                        return;
                    }
                }
            }
        });

        // 启动唯一读循环（与生产路径同一份实现）。
        let c2 = client.clone();
        let ctx2 = ctx.clone();
        tokio::spawn(async move { c2.read_loop(&ctx2, Box::new(host_rd)).await });

        MockModem { written, commands }
    }
}
