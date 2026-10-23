//! 短信业务层：列表/发送/删除/容量/存储/短信中心。
//!
//! 三条硬性约束（也是本次重构要解决的问题）：
//!
//! 1. **优先**：所有短信操作都在统一的 AT 通道上跑，且享有最高优先级。
//!    多步骤操作（发送要 CMGF→CSCA→CMGS×N，批量删除要 CMGD×N）在一次
//!    [SmsTransaction] 内完成，中途不放 channel，严禁其它命令插入事务中间。
//! 2. **实时**：列表、正文、容量、发送结果、删除结果一律以模组当次响应为准，
//!    不读任何缓存、不返回历史快照。页面打开、刷新、切回来都是一次真实下发。
//! 3. **不臆造结果**：发送必须拿到 `+CMGS` / OK 才算成功；拿到模组明确的拒绝算失败；
//!    超时或模组无响应算「结果不明」，并且**绝不自动重发** —— 那一次可能
//!    已经发出去了，重发就是重复计费。

use crate::at_queue::{SmsMode, SmsTransaction};
use crate::atclient::{AtClient, AtResponse, SMS_LIST_TIMEOUT, SMS_SUBMIT_TIMEOUT};
use crate::log_info;
use crate::log_warn;
use crate::pdu::{PartialInfo, SubmitOptions, build_submit_parts, parse_cmgl_response};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, watch};

/// 短信事务等待前面的任务让出通道的预算。
///
/// 取 10 秒而不是默认的 8 秒：长短信下发是「一个事务连续几十秒」的操作，
/// 排在它后面的第二个短信请求需要多等一会儿才合理。再往上加意义不大 ——
/// 超过这个数用户已经认为没响应了，宁可让他看到明确提示。
pub const SMS_QUEUE_WAIT: Duration = Duration::from_secs(10);
/// 一次 `send` 的**总**预算（含所有分片）。
///
/// 为什么要有总预算：长短信要连续提交多片，片数越多、单段的 40 秒预算叠加得
/// 越离谱（3 片就是 120 秒）。给事务一个整体 deadline，单段超时按剩余额度收缩，
/// 才能让「前端 / RPC / 后端」三层的时间预期对齐。
pub const SMS_SEND_TOTAL_BUDGET: Duration = Duration::from_secs(60);
/// 前台短信模式租约时长。前端每轮续期，忘记释放也会在这里自动失效。
/// 短信中心会话租约的默认 TTL。
///
/// 90s → 30s（issue #23）：页面崩溃 / 忘记释放 / WebSocket 断了的时候，
/// 最长阻塞从 90s 降到 30s；心跳同步加密到 10s（见 sms_center.js），
/// 续租粒度更细，正常使用无感。
pub const SMS_MODE_LEASE: Duration = Duration::from_secs(30);

/// 把存储区选择写回 UCI 并 commit（开机默认值的来源，界面保存时同路）。
async fn persist_storage_uci(mem: &str) -> Result<(), String> {
    let arg = format!("at-webserver.config.sms_storage={mem}");
    crate::qqbind::run_cmd("uci", &["set", arg.as_str()]).await?;
    crate::qqbind::run_cmd("uci", &["commit", "at-webserver"]).await?;
    Ok(())
}

/// `AT+CFUN=1` 的应答预算。
///
/// 不能用默认的 2 秒：模组拉起射频、重新附着时这条命令的回话本身就会变慢，
/// 实测（mock 注入 3 秒延迟）2 秒预算会让整串在 `AT+CFUN=1` 上判超时，
/// 后面的 `IMSSWITCH`/`CSCA` 一条都发不出去，而射频已经被关闭着 —— 比不开更糟。
pub const CFUN_SET_TIMEOUT: Duration = Duration::from_secs(10);
/// `AT+CFUN=1` 之后确认「射频回来了、网也注册上了」的轮询上限。
///
/// 手册没给恢复时长，所以只能轮询而不能死等。上限压在 15 秒：加上前面各步，
/// 整条 enable 序列最坏 ≈ 40 秒，仍在 `mt5700.uc` 给 power 动作的 70 秒以内，
/// 不会出现「后端还在跑、前端已经报超时」的错配。
pub const RF_RECOVER_BUDGET: Duration = Duration::from_secs(15);
/// 射频恢复轮询的间隔（同时也是两次查询之间的天然喘息）。
pub const RF_RECOVER_STEP: Duration = Duration::from_millis(1500);
/// `AT+CFUN=0` 与 `AT+CFUN=1` 之间必须保持的间隔。
///
/// 手册 6.1.2：「cfun=0/1 生效至少大于 1s，建议 CFUN=0 与 CFUN=1 间隔至少大于 1s」。
/// 取 1100ms 留一点余量 —— 原来只差 3ms，等于把约束写在悬崖边上。
pub const CFUN_SWITCH_GAP: Duration = Duration::from_millis(1100);
/// `AT+CPMS=` 切完存储区到 `AT+CMGD=1,4` 之间的等待。
///
/// 手册 8.1 没说切换何时生效，只说删除作用在 `<mem1>` 上（8.6.2）。厂商 WebUI 的
/// 「清空全部短信」实测节奏是逐区 `AT+CMGF=0` → 500ms → `AT+CPMS="X","X","X"` →
/// 500ms → `AT+CMGD=1,4` → 1s → 下一个区，这里对齐它那个 500ms：`AT+CPMS` 回 OK
/// 只代表命令被接受，不代表 MT 内部的读/写/接收介质已经换完，抢在换完之前删的会是
/// **上一个区**。多等半秒换的是「不会删错区」，成本可忽略（purge 动作有 70 秒预算）。
pub const CPMS_SWITCH_GAP: Duration = Duration::from_millis(500);

/// 发送结果的不确定状态：不要让上层把它当成成功或失败。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendOutcome {
    /// 模组明确确认（`+CMGS` 回执）。
    Accepted,
    /// 模组明确拒绝（ERROR / +CMS ERROR / +CME ERROR）。
    Rejected,
    /// 超时或模组无响应：可能已经发走了，也可能没有。
    Unknown,
}

impl SendOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            SendOutcome::Accepted => "accepted",
            SendOutcome::Rejected => "rejected",
            SendOutcome::Unknown => "unknown",
        }
    }
}

/// 单条短信（含长短信的分段信息）。
#[derive(Debug, Clone)]
pub struct SmsEntry {
    /// 存储槽位；None 表示头行里那个字段没读出来（0 是合法槽位，不能当哨兵）。
    pub index: Option<u32>,
    /// 0=未读 1=已读 2=未发 3=已发（TS 27.005 `<stat>`）
    pub stat: u32,
    pub direction: &'static str,
    pub number: String,
    pub content: String,
    pub time: Option<String>,
    /// SUBMIT 且只有相对有效期时，时间是「有效期」而不是发送时刻。
    pub time_approx: bool,
    pub concat: Option<ConcatInfo>,
    /// 该条 PDU 无法解析时给出原因，界面上要如实提示而不是显示空内容。
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ConcatInfo {
    pub reference: u32,
    pub parts_count: u32,
    pub part_number: u32,
}

#[derive(Debug, Clone)]
pub struct SmsListResult {
    pub entries: Vec<SmsEntry>,
    /// 本次真实查询的时刻（毫秒），前端据此确认数据不是旧快照。
    pub fetched_at_ms: i64,
    /// 列表为空时区分「真的没有」与「一条都解析不出来」。
    pub total_lines: usize,
}

#[derive(Debug, Clone)]
pub struct StorageInfo {
    pub used: u64,
    pub total: u64,
    pub mem1: String,
    pub mem2: String,
    pub mem3: String,
}

#[derive(Debug, Clone)]
pub struct SendRequest {
    pub destination: String,
    pub message: String,
    /// 不填则从模组读 `AT+CSCA?`。
    pub smsc: Option<String>,
    /// 同一服务端会话内用于去重的客户端序号（可选）。
    pub dedup_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SendPartResult {
    pub part_number: u32,
    pub parts_count: u32,
    pub outcome: SendOutcome,
    pub detail: String,
}

#[derive(Debug, Clone)]
pub struct SendResult {
    pub outcome: SendOutcome,
    pub encoding: String,
    pub parts: Vec<SendPartResult>,
    pub storage: Option<StorageInfo>,
    /// 完整的失败/未确认原因，便于前端原样展示。
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct DeleteResult {
    pub requested: usize,
    pub deleted: usize,
    pub failed: Vec<u32>,
    /// 存储区操作失败原因（清空全部使用）；普通按序号删除时为空。
    pub errors: Vec<String>,
    pub storage: Option<StorageInfo>,
}

/// 短信功能开关的执行结果。
#[derive(Debug, Clone)]
pub struct PowerResult {
    pub enabled: bool,
    pub steps_done: Vec<String>,
    /// 失败在哪一步（成功时为 None）。
    pub failed_at: Option<String>,
    /// 模组原始拒绝信息，供页面诊断。
    pub failed_detail: Option<String>,
    pub smsc: String,
    pub storage: Option<StorageInfo>,
}

/// 开关序列的中间结果：`power_set` 用它把「失败在哪、射频现在的真实状态」
/// 一并带回外层，再由外层决定要不要回滚射频。
#[derive(Debug, Default)]
struct PowerSeq {
    done: Vec<String>,
    failed_at: Option<String>,
    failed_detail: Option<String>,
    /// 本次是否下发过 `AT+CFUN=0`（决定失败时要不要回滚）。
    rf_off: bool,
    /// 序列结束时射频是否已确认回到 `+CFUN: 1`。
    rf_back: bool,
}

impl PowerSeq {
    /// 标记失败在哪一步并原样返回自己，让调用处能写成 `return out.fail(..)`。
    fn fail(mut self, label: &str, detail: String) -> Self {
        self.failed_at = Some(label.to_string());
        self.failed_detail = Some(detail);
        self
    }
}

/// 短信服务。
pub struct SmsService {
    client: Arc<AtClient>,
    sms_mode: Arc<SmsMode>,
    ctx: watch::Receiver<bool>,
    /// 发送去重：key -> 最近一次提交时刻。防止用户重复点击 / 浏览器重试
    /// 造成同一条短信被提交两次。
    recent_sends: Mutex<HashMap<String, Instant>>,
    /// 是否已 MEMORY FULL（用于释放后复位，参考实现里这个标志一旦置位永不复位）。
    mem_full: AtomicBool,
    /// 单分片提交预算（默认 [SMS_SUBMIT_TIMEOUT]；测试可注入更短的值）。
    submit_timeout: Duration,
    /// 一次 send 的总预算（默认 [SMS_SEND_TOTAL_BUDGET]）。
    total_budget: Duration,
    /// 射频恢复轮询上限（毫秒；默认 [RF_RECOVER_BUDGET]，单测里压到 0）。
    rf_recover_ms: AtomicU64,
    /// 短信本地归档句柄。由 main 在装配阶段注入（[`SmsService::set_archive`]），
    /// 未注入时 `send` 只走模组、不落盘 —— 单测因此不必准备文件系统。
    archive: std::sync::OnceLock<std::sync::Arc<crate::sms_store::SmsArchive>>,
}

impl SmsService {
    pub fn new(
        client: Arc<AtClient>,
        ctx: watch::Receiver<bool>,
        sms_mode: Arc<SmsMode>,
    ) -> Arc<SmsService> {
        Self::with_timeouts(client, ctx, sms_mode, SMS_SUBMIT_TIMEOUT, SMS_SEND_TOTAL_BUDGET)
    }

    /// 带显式超时预算构造（测试用：默认预算是按实机弱信号给的，单测里太长）。
    pub fn with_timeouts(
        client: Arc<AtClient>,
        ctx: watch::Receiver<bool>,
        sms_mode: Arc<SmsMode>,
        submit_timeout: Duration,
        total_budget: Duration,
    ) -> Arc<SmsService> {
        Arc::new(SmsService {
            client,
            sms_mode,
            ctx,
            recent_sends: Mutex::new(HashMap::new()),
            mem_full: AtomicBool::new(false),
            submit_timeout,
            total_budget,
            rf_recover_ms: AtomicU64::new(RF_RECOVER_BUDGET.as_millis() as u64),
            archive: std::sync::OnceLock::new(),
        })
    }

    /// 注入短信本地归档句柄（main 装配时调用一次）。
    ///
    /// 用 `OnceLock` 而不是构造参数，是为了不动 `new` / `with_timeouts` 的签名
    /// —— 这两个入口被一堆既有用例直接调用，改签名等于把它们全改一遍。
    pub fn set_archive(&self, a: std::sync::Arc<crate::sms_store::SmsArchive>) {
        let _ = self.archive.set(a);
    }

    /// 把一条短信写入本地归档（发送与接收共用）。
    ///
    /// 归档失败**不影响**短信本身：落盘只是留档，失败时记一条日志就过，
    /// 绝不能让「写文件失败」把已经发成功的短信报成失败。
    pub fn archive_record(&self, rec: crate::sms_store::ArchiveRecord) {
        let Some(a) = self.archive.get() else { return };
        if let Err(e) = a.append(vec![rec]) {
            log_warn!("写入短信本地归档失败（不影响本次收发）: {e}");
        }
    }

    /// 存储满标志：被模组告知 MEMORY FULL 后置位，容量回落到未满时清除。
    pub fn memory_full(&self) -> bool {
        self.mem_full.load(Ordering::Relaxed)
    }

    /// 测试专用：把射频恢复轮询上限压小，否则「模组迟迟不注册」这条分支
    /// 在单测里要真的等满 15 秒。
    #[cfg(test)]
    pub(crate) fn set_rf_recover_budget(&self, budget: Duration) {
        self.rf_recover_ms.store(budget.as_millis() as u64, Ordering::Relaxed);
    }

    // ============= 前台短信模式（会话租约） =============

    /// 短信中心进入活动状态：登记一份租约，后台轮询自此让路。
    pub async fn session_open(&self, ttl_ms: Option<u64>) -> u64 {
        let ttl = Duration::from_millis(ttl_ms.unwrap_or(SMS_MODE_LEASE.as_millis() as u64).max(5_000))
            .min(crate::at_queue::SMS_MAX_LEASE);
        let id = self.sms_mode.acquire(ttl).await;
        log_info!("短信优先模式：会话 {} 上线（TTL {}s）", id, ttl.as_secs());
        id
    }

    /// 续期（页面仍在短信中心 → 继续占用通道）。
    pub async fn session_renew(&self, id: u64, ttl_ms: Option<u64>) -> bool {
        let ttl = Duration::from_millis(ttl_ms.unwrap_or(SMS_MODE_LEASE.as_millis() as u64).max(5_000))
            .min(crate::at_queue::SMS_MAX_LEASE);
        self.sms_mode.renew(id, ttl).await
    }

    /// 页面退出 / WebSocket 断开 → 立刻释放，后台轮询恢复。
    pub async fn session_release(&self, id: u64) {
        self.sms_mode.release(id).await;
        log_info!("短信优先模式：会话 {} 已释放", id);
    }

    pub async fn session_count(&self) -> usize {
        self.sms_mode.lease_count().await
    }

    // ============= 业务操作 =============

    /// 列出全部短信：**每次都真的去模组读**。
    ///
    /// 为什么不能缓存：`AT+CMGL=4` 的结果会随新短信、删除、存储切换而变化，
    /// 返回上一次的快照会出现「界面上有、模组里已经没了」的幽灵条目，
    /// 删除时就会按着不存在的 index 下发一堆 `AT+CMGD`，全是 ERROR。
    pub async fn list(&self) -> Result<SmsListResult, String> {
        let tx = self
            .client
            .open_sms_transaction(&self.ctx, "sms.list", SMS_QUEUE_WAIT)
            .await?;

        // 先确保 PDU 模式。查询只能确认「当前已经是 PDU 模式」时才跳过，
        // 查询失败/看不懂一律强制设一次 —— CMGF=0 幂等，代价远小于模式歧义。
        let mut mode = false;
        if let Ok(resp) = self
            .client
            .run_in_transaction(&self.ctx, &tx, "AT+CMGF?", crate::atclient::COMMAND_TIMEOUT)
            .await
        {
            mode = resp.contains("+CMGF: 0");
        }
        if !mode {
            let set = self.client
                .run_in_transaction(&self.ctx, &tx, "AT+CMGF=0", crate::atclient::COMMAND_TIMEOUT)
                .await
                .map_err(|e| format!("切换到 PDU 模式失败: {e}"))?;
            if !set.ok() || set.has_error() {
                return Err(format!("切换到 PDU 模式失败：{}", last_line(&set.text())));
            }
        }

        let resp = self
            .client
            .run_in_transaction(&self.ctx, &tx, "AT+CMGL=4", SMS_LIST_TIMEOUT)
            .await?;
        drop(tx);

        // 手册 9.8.1 给了两种结局：成功是若干组「`+CMGL:` 头行 + PDU 行」再以 OK 收尾，
        // 失败是 `+CMS ERROR: <err>`。没有 OK 就别当成「存储区是空的」——
        // 「读不出来」和「一条也没有」差得很远，静默返回空列表会把 SIM 卡未就绪
        // 洗成「本机没有短信」，用户接着就会去删那些根本不存在的东西。
        // 只看 OK 不看 has_error：`^SMMEMFULL` 那类附带 CMS ERROR 字样的上报行也会
        // 混进同一次应答里（见 atclient 的读循环），那时候列表其实已经读出来了。
        if !resp.ok() {
            return Err(format!("读取短信列表失败：{}", last_line(&resp.text())));
        }

        let parsed = parse_cmgl_response(&resp.lines);
        let total_lines = resp.lines.len();
        let entries = parsed
            .into_iter()
            .map(|p| SmsEntry {
                index: p.index,
                stat: p.stat,
                direction: if p.direction_incoming { "received" } else { "sent" },
                number: p.number,
                content: p.content,
                time: p.time,
                time_approx: p.time_approx,
                concat: p.partial.map(|q: PartialInfo| ConcatInfo {
                    reference: q.reference,
                    parts_count: q.parts_count,
                    part_number: q.part_number,
                }),
                error: p.error,
            })
            .collect();

        Ok(SmsListResult {
            entries,
            fetched_at_ms: crate::nettime::now_ms(),
            total_lines,
        })
    }

    /// 发送一条短信（长短信自动分片）。
    ///
    /// 全流程在一次事务里跑完：CMGF → CSCA → CMGS×N。
    /// 任一分片超时即整体返回 `Unknown`，**不重试已经提交过的片段**。
    pub async fn send(&self, req: SendRequest) -> Result<SendResult, String> {
        let destination = req.destination.trim().to_string();
        if destination.is_empty() {
            return Err("缺少收件人号码".into());
        }
        let message = req.message.clone();
        if message.is_empty() {
            return Err("短信内容为空".into());
        }

        // 重复提交保护：同一目标 + 同一正文在 10 秒内只放第一次进去。
        // 浏览器重试、用户连点、前端没来得及 disable 按钮都会走到这里。
        let dedup_key = req
            .dedup_key
            .clone()
            .unwrap_or_else(|| format!("{destination}|{message}"));
        {
            let mut recent = self.recent_sends.lock().await;
            let now = Instant::now();
            recent.retain(|_, t| now.duration_since(*t) < Duration::from_secs(10));
            if let Some(last) = recent.get(&dedup_key) {
                if now.duration_since(*last) < Duration::from_secs(10) {
                    return Ok(SendResult {
                        outcome: SendOutcome::Rejected,
                        encoding: "".into(),
                        parts: Vec::new(),
                        storage: None,
                        message: "该短信刚刚提交过，已忽略重复提交（避免重复计费）".into(),
                    });
                }
            }
            recent.insert(dedup_key.clone(), now);
        }

        let tx = self
            .client
            .open_sms_transaction(&self.ctx, "sms.send", SMS_QUEUE_WAIT)
            .await?;

        // 1) 确保 PDU 模式。
        let mode_resp = self
            .client
            .run_in_transaction(&self.ctx, &tx, "AT+CMGF?", crate::atclient::COMMAND_TIMEOUT)
            .await;
        let already_pdu = matches!(&mode_resp, Ok(r) if r.contains("+CMGF: 0"));
        if !already_pdu {
            let set = self.client
                .run_in_transaction(&self.ctx, &tx, "AT+CMGF=0", crate::atclient::COMMAND_TIMEOUT)
                .await
                .map_err(|e| format!("切换到 PDU 模式失败: {e}"))?;
            if !set.ok() || set.has_error() {
                return Err(format!("切换到 PDU 模式失败：{}", last_line(&set.text())));
            }
        }

        // 2) 短信中心号码：请求没给就读模组（`AT+CSCA?`）。
        //    手册 9.5.2 规定 PDU 模式下模组只在该次 PDU 的「短信中心地址长度 = 0」时才
        //    用自己存的 CSCA。这里读到就把它编进 PDU（`build_submit_parts` 的 sca 字段），
        //    读不到才写 0 长度让模组兜底 —— 于是「在短信设置里改过中心号」必然反映到
        //    这一次发送，而不是靠模组记得它被设成了什么。
        let smsc = match req.smsc.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(s) => Some(s.to_string()),
            None => match self
                .client
                .run_in_transaction(&self.ctx, &tx, "AT+CSCA?", crate::atclient::COMMAND_TIMEOUT)
                .await
            {
                Ok(resp) => extract_quoted_number(&resp.text(), "+CSCA:").filter(|s| !s.is_empty()),
                Err(_) => None,
            },
        };

        // 3) 编码分片。
        let plan = build_submit_parts(&SubmitOptions {
            destination: destination.clone(),
            message: message.clone(),
            smsc: smsc.clone(),
            validity: None,
            reference: None,
        })?;

        log_info!(
            "短信提交：{} → {}，共 {} 片（{} 编码，参考号 {}）",
            destination,
            text_preview(&message),
            plan.parts.len(),
            plan.encoding.name(),
            plan.reference
        );

        // 4) 逐片提交。形态取手册 9.14.1／9.14.5 与实机表现一致的那一种：
        //    `AT+CMGS=<长度>` + **字面的 `\r` 两个字符** + `<PDU>`，整条一次写完，
        //    模组直接回 `+CMGS: <mr>` / OK —— 全程没有 `> ` 输入提示符，也不需要
        //    Ctrl-Z(0x1A)。手册 9.14.5 的举例正是 `AT+CMGS=18\r0011…`，并注明
        //    「使用 SSCOM 工具时对应的 "\r" 应改为 "\\r"」—— 串口上要发的是反斜杠
        //    加字母 r，不是回车。同一台 MT5700M-CN 的实机对照：
        //      `AT+CMGS=19` + 真 CR + PDU + CR → 只回显命令本身，随后静默
        //          （无 `>`、无 `+CMGS:`、无 ERROR）；
        //      `AT+CMGS=19` + 字面 `\r` + PDU → 立即 `+CMGS: <mr>` / OK。
        //    这条路上没有任何控制字节，也就不会再被「浏览器 JSON → rpcd → ucode → nc」
        //    的转义链路打到（issue #19 里 0x1A 变成字面量 `u001a` 属同一类问题）。
        //    失败点在片内，立即停下，不继续。只有模组**明确回本地 ERROR / +CME ERROR**
        //    （PDU 还没进网络侧，换形态不算重发）时，才退回 3GPP TS 27.005 §3.4.1 的
        //    标准两段式再试一次；`+CMS ERROR`（网络侧已拒）与超时静默（结果不明，
        //    可能已经发出去）一律不重试，见 [needs_two_step_fallback]。
        let mut parts = Vec::with_capacity(plan.parts.len());
        let mut outcome = SendOutcome::Accepted;
        let mut message_out = String::new();
        let deadline = Instant::now() + self.total_budget;

        for part in &plan.parts {
            // 单段预算 = min(单段上限, 事务剩余额度)。剩余额度为 0 时给最小预算，
            // 让模组还有一次机会回话（此时判 Unknown 而不是 Accepted）。
            let remain = deadline.saturating_duration_since(Instant::now());
            let part_timeout = self.submit_timeout.min(remain).max(Duration::from_millis(500));
            let started = Instant::now();
            // `\\r` 在 Rust 源里是「反斜杠 + r」两个字符，正是模组要的分隔符。
            let one_shot = format!("AT+CMGS={}\\r{}", part.tpdu_length, part.pdu);
            let res = self
                .client
                .run_in_transaction(&self.ctx, &tx, &one_shot, part_timeout)
                .await;
            let res = if needs_two_step_fallback(&res) {
                log_info!(
                    "短信提交：第 {} 片的一次性形态被模组本地拒绝，退回标准两段式重试一次",
                    part.part_number
                );
                let head = format!("AT+CMGS={}", part.tpdu_length);
                let head_budget = part_timeout
                    .saturating_sub(started.elapsed())
                    .max(Duration::from_millis(500));
                let head_started = Instant::now();
                let prompt = self
                    .client
                    .run_in_transaction(&self.ctx, &tx, &head, head_budget)
                    .await;
                // 第一步没等到 `> ` 就不写 PDU：那样做会把 PDU 当成一条新命令，模组回
                // ERROR，用户看到的是一次莫名其妙的失败；此时直接把第一步的应答报出去。
                match prompt {
                    Ok(resp) if saw_input_prompt(&resp) => {
                        let left = head_budget
                            .saturating_sub(head_started.elapsed())
                            .max(Duration::from_millis(500));
                        self.client
                            .run_in_transaction(
                                &self.ctx,
                                &tx,
                                &format!("{}\u{1a}", part.pdu),
                                left,
                            )
                            .await
                    }
                    other => other,
                }
            } else {
                res
            };
            let (part_outcome, detail) = classify_cmgs_result(&res);
            if part_outcome == SendOutcome::Rejected {
                self.mem_full.store(is_memory_full_detail(&detail), Ordering::Relaxed);
            }
            parts.push(SendPartResult {
                part_number: part.part_number as u32,
                parts_count: part.parts_count as u32,
                outcome: part_outcome,
                detail: detail.clone(),
            });
            // 取最坏的一片作为整体结论：成功+未知=未知，任一拒绝=拒绝。
            outcome = worst_outcome(outcome, part_outcome);
            if part_outcome != SendOutcome::Accepted {
                message_out = match part_outcome {
                    SendOutcome::Rejected => format!(
                        "第 {}/{} 段被模组拒绝：{}",
                        part.part_number, part.parts_count, compact_detail(&detail)
                    ),
                    SendOutcome::Unknown => format!(
                        "第 {}/{} 段未收到模组确认（{}）。短信可能已发走，请勿重复点击；\
                         如需确认请稍后刷新发送列表。",
                        part.part_number,
                        part.parts_count,
                        compact_detail(&detail)
                    ),
                    SendOutcome::Accepted => String::new(),
                };
                log_warn!("短信提交异常：{}", message_out);
                // 实机在每一片失败后都先往串口写一个 ESC(0x1B) 再继续用端口
                // （`smssend` 里的 `at("\x1b", 3)`）：模组可能正卡在「等 PDU」的
                // 半开输入态，这时候紧跟着的 `AT+CPMS?` 会被当成 PDU 吞掉，
                // 于是一次发送失败连带把后面的读写一起拖死。清完再交还通道。
                let _ = self
                    .client
                    .run_in_transaction(
                        &self.ctx,
                        &tx,
                        "\u{1b}",
                        crate::atclient::COMMAND_TIMEOUT,
                    )
                    .await;
                break;
            }
        }

        // 5) 无论成败都顺手读一次真实容量，前端展示的是模组当次读数。
        let storage = self.read_storage_in_tx(&tx).await.ok();
        drop(tx);

        if outcome == SendOutcome::Accepted {
            message_out = if parts.len() > 1 {
                format!("已提交 {} 段长短信", parts.len())
            } else {
                "模组已确认提交".into()
            };
            /*
             * 落盘：把「发出过什么」留在路由器本地，与模组格位的生命周期解耦
             * （格位会满、会被清空，本地归档不会）。
             *
             * 归档写失败**不影响**本次结论：模组已经回 `+CMGS` 确认收下，
             * 留档只是附带动作，绝不能让「写文件失败」把发成功的短信报成失败。
             */
            self.archive_record(sent_record(&destination, &message));
        }

        Ok(SendResult {
            outcome,
            encoding: plan.encoding.name().into(),
            parts,
            storage,
            message: message_out,
        })
    }

    /// 删除若干条短信。模组不收槽位列表，所以**一个槽位一句 `AT+CMGD`**，
    /// 并按槽位**从大到小**下发；同一事务内完成，末尾再回读一次容量。
    ///
    /// 索引来自上一次 `list` 的真实返回；删除后重新读一次容量，
    /// 让界面显示的用量与模组当前状态一致。
    pub async fn delete(&self, indices: Vec<u32>) -> Result<DeleteResult, String> {
        if indices.is_empty() {
            return Err("没有要删除的短信".into());
        }
        // 去重，再**按槽位从大到小**下发。
        //
        // 降序这条来自实机：厂商的删除路径（modem.lua 的 action_smsdel）注释写着
        // 「一条命令一个槽位：模组不收槽位列表。从大到小删，免得剩下的槽位号在中途挪位」，
        // 实机的实现就是把 idx 排序后倒着逐条 AT+CMGD。升序删到一半，后面的号可能已经
        // 指向别的短信 —— 删错一条是不可逆的。
        //
        // 0 号槽位是真实的（实机一张存着分段短信的卡，头两条就在 0 和 1），所以这里
        // 不再拿 0 当「序号来路不明」的哨兵；那种条目在解析层就是 index=None，
        // 界面对它禁用勾选，永远走不到这条命令里。
        let mut ordered: Vec<u32> = Vec::new();
        for i in indices {
            if !ordered.contains(&i) {
                ordered.push(i);
            }
        }
        ordered.sort_unstable_by(|a, b| b.cmp(a));

        let tx = self
            .client
            .open_sms_transaction(&self.ctx, "sms.delete", SMS_QUEUE_WAIT)
            .await?;

        let mut deleted = 0usize;
        let mut failed: Vec<u32> = Vec::new();
        for index in &ordered {
            let command = format!("AT+CMGD={index}");
            let res = self
                .client
                .run_in_transaction(&self.ctx, &tx, &command, crate::atclient::COMMAND_TIMEOUT)
                .await;
            match res {
                Ok(resp) if resp.ok() && !resp.has_error() => deleted += 1,
                Ok(resp) => {
                    log_warn!("删除短信 {index} 未成功：{}", last_line(&resp.text()));
                    failed.push(*index);
                }
                Err(e) => {
                    log_warn!("删除短信 {index} 失败：{e}");
                    failed.push(*index);
                }
            }
        }

        let storage = self.read_storage_in_tx(&tx).await.ok();
        drop(tx);

        Ok(DeleteResult {
            requested: ordered.len(),
            deleted,
            failed,
            errors: Vec::new(),
            storage,
        })
    }

    /// 清空全部短信：按当前实际存在的存储区逐个 `AT+CMGD=1,4`。
    ///
    /// 一次 `AT+CMGD=1,4` 只清「首选存储器」（手册 8.6.3：delflag=4 = 删除首选存储器上
    /// 所有短信，含未读；8.6.2 注明 delflag≠0 时 MT 忽略 `<index>`，所以那个 `1` 只是占位，
    /// 且删除作用的介质是 8.1 里的 `<mem1>`）。要清干净就得先把三个区都指到目标区、
    /// 再下一次 delflag=4，所以这里是「切区 → 删」的循环，而不是单下一条命令。
    pub async fn purge_all(&self) -> Result<DeleteResult, String> {
        let tx = self
            .client
            .open_sms_transaction(&self.ctx, "sms.purge", SMS_QUEUE_WAIT)
            .await?;

        let storage = self.read_storage_in_tx(&tx).await.ok();
        let mut mems: Vec<String> = Vec::new();
        if let Some(s) = &storage {
            for m in [&s.mem1, &s.mem2, &s.mem3] {
                if !m.is_empty() && !mems.contains(m) {
                    mems.push(m.clone());
                }
            }
        }
        if mems.is_empty() {
            // 读不到 `AT+CPMS?` 时的兜底：只试手册 8.1.3 承认的两个区。
            mems = vec!["SM".into(), "ME".into()];
        }

        let mut errors: Vec<String> = Vec::new();
        let mut deleted = 0usize;
        for mem in &mems {
            if !is_safe_mem_name(mem) {
                // 模组在 `AT+CPMS?` 里回了手册 8.1.3 之外的区名：读侧如实显示，
                // 写侧不去碰它 —— 拼一个手册没记载的区名去下发，换来的是模组的
                // `+CME ERROR`，用户看不出是「不支持」还是「操作失败」。
                errors.push(format!("{mem}: 存储区名不在手册 8.1.3 的可选值（SM/ME）内，已跳过"));
                continue;
            }
            let set = format!(r#"AT+CPMS="{mem}","{mem}","{mem}""#);
            // 切换失败也要把模组的原始应答带出来（+CME ERROR: 4 之类），
            // 只留一句「切换存储区失败」等于把最能定位问题的那半句丢了。
            let switched = match self
                .client
                .run_in_transaction(&self.ctx, &tx, &set, crate::atclient::COMMAND_TIMEOUT)
                .await
            {
                Ok(resp) if resp.ok() && !resp.has_error() => true,
                Ok(resp) => {
                    errors.push(format!("{mem}: 切换存储区失败：{}", compact_detail(&resp.text())));
                    false
                }
                Err(e) => {
                    errors.push(format!("{mem}: 切换存储区失败：{e}"));
                    false
                }
            };
            if !switched {
                continue;
            }
            // 与厂商 WebUI 同一步的等待：见 CPMS_SWITCH_GAP —— 别在介质还没换完时删上一个区。
            tokio::time::sleep(CPMS_SWITCH_GAP).await;
            match self.client
                .run_in_transaction(&self.ctx, &tx, "AT+CMGD=1,4", SMS_LIST_TIMEOUT)
                .await
            {
                Ok(resp) if resp.ok() && !resp.has_error() => deleted += 1,
                Ok(resp) => errors.push(format!("{mem}: {}", compact_detail(&resp.text()))),
                Err(e) => errors.push(format!("{mem}: {e}")),
            }
        }

        // 把读写介质还回用户原先的那一组。
        //
        // 上面为了逐区清空写了好几次 AT+CPMS，循环结束时 mem1 停在最后一个试过的区上。
        // mem1 决定之后 list / delete / CMGR 落在哪个区（手册 8.1.1），不还的话
        // 「清空短信」这一个动作会连带把之后所有短信读写的默认介质改掉 —— 用户看到的是
        // 列表莫名其妙换了一个区。实机的清空压根不切区（`AT+CMGD=0,4` 清当前 mem1），
        // 所以没有这个副作用；这里既然要切，就得切回去。
        if let Some(s) = &storage {
            let areas = [&s.mem1, &s.mem2, &s.mem3];
            if areas.iter().all(|m| is_safe_mem_name(m)) {
                let restore = format!(r#"AT+CPMS="{}","{}","{}""#, s.mem1, s.mem2, s.mem3);
                if let Err(e) = self
                    .client
                    .run_in_transaction(&self.ctx, &tx, &restore, crate::atclient::COMMAND_TIMEOUT)
                    .await
                {
                    log_warn!("清空后恢复原存储区设置失败：{e}");
                }
            }
        }

        let storage = self.read_storage_in_tx(&tx).await.ok();
        drop(tx);
        Ok(DeleteResult { requested: mems.len(), deleted, failed: Vec::new(), errors, storage })
    }

    /// 读取存储用量：一次真实下发 `AT+CPMS?`。
    pub async fn capacity(&self) -> Result<StorageInfo, String> {
        // 单条命令也要走短信事务：它是「用户在短信中心里主动刷新」的结果，
        // 必须优先于后台轮询拿到通道，否则会被信号采集挤到队尾。
        let tx = self
            .client
            .open_sms_transaction(&self.ctx, "sms.capacity", SMS_QUEUE_WAIT)
            .await?;
        let info = self.read_storage_in_tx(&tx).await;
        drop(tx);
        if let Ok(s) = &info {
            // 参考实现里这个标志置位后永不复位，用户清空短信后仍一直报「存储已满」。
            if s.used < s.total {
                self.mem_full.store(false, Ordering::Relaxed);
            }
        }
        info
    }

    /// 设置首选存储区（三个区指向同一处）。
    ///
    /// 区名只认手册 8.1.3 的两个值：`"SM"`（(U)SIM 卡）与 `"ME"`（FLASH）。
    pub async fn set_storage(&self, mem: &str) -> Result<StorageInfo, String> {
        if !is_safe_mem_name(mem) {
            return Err(format!(
                "不支持的存储区 {mem}（手册 8.1.3 只定义了 SM=SIM 卡、ME=模组 FLASH）"
            ));
        }
        let tx = self
            .client
            .open_sms_transaction(&self.ctx, "sms.set_storage", SMS_QUEUE_WAIT)
            .await?;
        let set = format!(r#"AT+CPMS="{mem}","{mem}","{mem}""#);
        self.client
            .run_in_transaction(&self.ctx, &tx, &set, crate::atclient::COMMAND_TIMEOUT)
            .await?;
        let info = self.read_storage_in_tx(&tx).await;
        drop(tx);
        // 写回 UCI：这个选择同时是「开机默认存储区」，不落盘的话模组复位 /
        // 换卡回 SM 后，用户每次重启都要重设一次。写失败不影响本次生效，留痕即可。
        if let Err(e) = persist_storage_uci(mem).await {
            log_warn!("存储区已生效但写回 UCI 失败（{mem}）：{e}");
        }
        info
    }

    /// 开机按 UCI 配置兜底存储区（默认 ME）。
    ///
    /// 模组 CPMS 选择虽掉电保存，但换卡 / 刷固件 / 模组复位后会回 SM。
    /// 先读一次实际容量，与配置不符才下发——避免每次重启都白跑一个事务，
    /// 也让「界面保存 → 重启 → 还是那个值」形成闭环。返回是否发生了切换。
    pub async fn apply_default_storage(&self, want: &str) -> Result<bool, String> {
        let want = crate::config::normalize_sms_storage(want);
        let cur = self.capacity().await?;
        if cur.mem1.eq_ignore_ascii_case(&want) {
            return Ok(false);
        }
        self.set_storage(&want).await?;
        Ok(true)
    }

    /// 读短信中心号码。
    pub async fn get_smsc(&self) -> Result<String, String> {
        let tx = self
            .client
            .open_sms_transaction(&self.ctx, "sms.get_smsc", SMS_QUEUE_WAIT)
            .await?;
        let resp = self
            .client
            .run_in_transaction(&self.ctx, &tx, "AT+CSCA?", crate::atclient::COMMAND_TIMEOUT)
            .await?;
        drop(tx);
        Ok(extract_quoted_number(&resp.text(), "+CSCA:").unwrap_or_default())
    }

    /// 写短信中心号码，并回读校验（写成功不等于写对了）。
    ///
    /// 手册 9.5.4：`AT+CSCA` 掉电保存 = Y，写一次就长期有效，不需要每次开机重写。
    /// 9.5.2 还有一条容易误读的规定 —— **PDU 模式下只有当 PDU 里短信中心地址长度为 0 时
    /// 才用这个值**。本插件发送时是先用 `AT+CSCA?` 把号码读出来、直接编进 PDU
    /// （见 `send` 第 2 步），所以「改完号码马上生效」靠的是那次读取，而不是模组的默认值。
    pub async fn set_smsc(&self, number: &str) -> Result<String, String> {
        let cleaned = check_smsc_input(number)?;
        let tx = self
            .client
            .open_sms_transaction(&self.ctx, "sms.set_smsc", SMS_QUEUE_WAIT)
            .await?;
        let set = self.client
            .run_in_transaction(
                &self.ctx,
                &tx,
                &format!(r#"AT+CSCA="{cleaned}""#),
                crate::atclient::COMMAND_TIMEOUT,
            )
            .await?;
        if !set.ok() || set.has_error() {
            return Err(format!("模组拒绝设置短信中心号码：{}", last_line(&set.text())));
        }
        let back = match self
            .client
            .run_in_transaction(&self.ctx, &tx, "AT+CSCA?", crate::atclient::COMMAND_TIMEOUT)
            .await
        {
            Ok(resp) => extract_quoted_number(&resp.text(), "+CSCA:").unwrap_or_default(),
            Err(_) => String::new(),
        };
        drop(tx);
        if !back.is_empty() && !digits_eq(&back, &cleaned) {
            return Err(format!("模组写入后回读不一致（期望 {cleaned}，实际 {back}）"));
        }
        Ok(if back.is_empty() { cleaned } else { back })
    }

    /// 短信功能开关（开启/关闭）。
    ///
    /// 这是**典型的多步骤操作**：读 `CEUS` → （必要时）`CEUS=1` → `CFUN=0` →
    /// `CFUN=1` 并确认恢复 → `IMSSWITCH=1` → 可选 `CSCA`，中间还有模组自己的处理间隔。
    /// 过去它在前端连发五条各自排队的命令，后台巡检随时会从中间插进来，把「射频刚被
    /// 拉起来」的状态打断，结果是短信开关看着勾上了、实际没生效。现在整串在一次事务里跑完。
    ///
    /// 两条不能省的规矩：
    /// 1. **CEUS 要经一次开关机才生效**（手册 3.15.2），所以改过 CEUS 就必须重启射频；
    ///    反之 CEUS 已经是 1 时整套重启都是白断网，所以先读再决定。
    /// 2. **只要下发过 `AT+CFUN=0`，无论后面哪一步失败都必须把射频拉回来**，
    ///    否则用户点一下「开启短信」得到的是整机断网，且界面已经报错了，没人知道要手动 `CFUN=1`。
    pub async fn power_set(&self, enable: bool, smsc: Option<String>) -> Result<PowerResult, String> {
        if let Some(sc) = smsc.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            // 与 set_smsc 同一条校验、同一句文案：同一个号码不该在两个入口拿到两种答案。
            check_smsc_input(sc)?;
        }
        let tx = self
            .client
            .open_sms_transaction(&self.ctx, "sms.power", SMS_QUEUE_WAIT)
            .await?;

        let seq = if enable {
            self.run_power_enable(&tx, smsc).await
        } else {
            // 关闭短信/IMS 能力只关 IMS：不动射频、不改 CEUS、不清空短信。
            // 后三样都曾在这里发生过，代价分别是整机断网、需要开关机才自愈、用户数据消失。
            self.run_one_step(&tx, "AT^IMSSWITCH=0,0,0", "关闭 LTE IMS").await
        };

        // 失败回滚：本次关过射频而序列没把它带回来，就 best-effort 补一次并回读确认。
        let mut failed_detail = seq.failed_detail;
        if seq.failed_at.is_some() && seq.rf_off && !seq.rf_back {
            let note = self.restore_rf(&tx).await;
            failed_detail = Some(match failed_detail {
                Some(d) => format!("{d}；{note}"),
                None => note,
            });
        }

        let smsc_now = match self
            .client
            .run_in_transaction(&self.ctx, &tx, "AT+CSCA?", crate::atclient::COMMAND_TIMEOUT)
            .await
        {
            Ok(resp) => extract_quoted_number(&resp.text(), "+CSCA:").unwrap_or_default(),
            Err(_) => String::new(),
        };
        let storage = self.read_storage_in_tx(&tx).await.ok();
        drop(tx);

        Ok(PowerResult {
            enabled: seq.failed_at.is_none() && enable,
            steps_done: seq.done,
            failed_at: seq.failed_at,
            failed_detail,
            smsc: smsc_now,
            storage,
        })
    }

    /// 开启分支：见 [SmsService::power_set] 的两条规矩。
    async fn run_power_enable(&self, tx: &SmsTransaction, smsc: Option<String>) -> PowerSeq {
        let mut out = PowerSeq::default();

        // 1) 先读数据中心模式。手册 3.15.3 写「1 数据中心（默认值）」，但 3.15.5 的
        //    回读举例是 `+CEUS: 0`，而且本应用的旧版本确实写过 `CEUS=0` —— 出厂默认
        //    不能推定当前值，读不到就只能按「需要重启」处理，宁可多断一次网。
        //
        //    「开启短信要 CEUS 取几」本身**仍待真机确认**：手册通篇（3.15 与 4.10）都没
        //    把 CEUS 和短信/IMS 绑定，1 还是 0 属推断。厂商自己的 WebUI 在开启短信时下发
        //    `AT+CEUS=0`（语音中心）、关闭时下发 `AT+CEUS=1`（数据中心），方向与本插件
        //    相反，而且它是在 `AT+CFUN=0` 之后才写 CEUS（本插件写之前）。真机验证办法：
        //    分别按 0 与 1 走完开启流程、各发一条短信；若确认应为 0，本函数与
        //    `power_requires_rf_restart` 里的目标值要一起翻转，别只改一处。
        let ceus = match self
            .client
            .run_in_transaction(&self.ctx, tx, "AT+CEUS?", crate::atclient::COMMAND_TIMEOUT)
            .await
        {
            Ok(resp) => parse_ceus_state(&resp.text()),
            Err(e) => {
                log_warn!("读取 CEUS 失败，按「需要重启射频」处理：{}", e);
                None
            }
        };

        if power_requires_rf_restart(ceus) {
            // 2) 写 CEUS。这一步必须在 CFUN=0 之前：手册说它「设置后需要开关机生效」，
            //    放在射频已经关闭的时候写，等于赌模组还认这条命令。
            //    下面这对 CFUN=0 → CFUN=1 是本插件对「开关机」的替代：手册 6.1.3 里
            //    真正的复位是 `AT+CFUN=1,1`（且只支持 online 模式下发，复位范围由 NV2391
            //    决定，可能连整机一起复），代价是承载接口全部重建，比关开射频重得多。
            //    **CFUN=0/1 是否足以让 CEUS 生效，手册没有承诺，需要真机确认**；
            //    确认不足时应当改用 CFUN=1,1，并把重启后的等待时间一起加进来。
            match self.step(tx, "AT+CEUS=1", "设置数据中心模式").await {
                Ok(_) => out.done.push("设置数据中心模式".into()),
                Err(detail) => return out.fail("设置数据中心模式", detail),
            }
            tokio::time::sleep(CFUN_SWITCH_GAP).await;

            // 3) 关射频。rf_off 要在下发**之前**置位：万一命令已被模组执行、
            //    只是回话丢了，仍然必须回滚。
            out.rf_off = true;
            out.rf_back = false;
            match self.step(tx, "AT+CFUN=0", "关闭射频以应用短信模式").await {
                Ok(_) => out.done.push("关闭射频以应用短信模式".into()),
                Err(detail) => return out.fail("关闭射频以应用短信模式", detail),
            }
            // 手册 6.1.2：CFUN=0 与 CFUN=1 之间间隔至少大于 1s。
            tokio::time::sleep(CFUN_SWITCH_GAP).await;

            // 4) 恢复射频，用长超时（见 CFUN_SET_TIMEOUT 的注释）。
            match self
                .step_with_timeout(tx, "AT+CFUN=1", "恢复射频", CFUN_SET_TIMEOUT)
                .await
            {
                Ok(_) => out.done.push("恢复射频".into()),
                Err(detail) => return out.fail("恢复射频", detail),
            }

            // 5) 确认射频与注册状态。没确认到也继续往下走（IMSSWITCH 值得再试一次），
            //    但 rf_back 如实记录，失败时外层会回滚；成功时把「未确认注册」写进步骤里，
            //    界面显示的是模组的真实状态而不是「全部完成」。
            let (back, registered) = self.wait_for_rf(tx).await;
            out.rf_back = back;
            out.done.push(if !back {
                "恢复射频（未确认 +CFUN: 1）".into()
            } else {
                match registered {
                    Some(true) => "射频已恢复并注册网络".into(),
                    Some(false) => "射频已恢复（未在时限内注册，继续）".into(),
                    None => "射频已恢复（注册状态未知）".into(),
                }
            });

            // 手册 4.10.2：`AT^IMSSWITCH` 需要在上电初次开机后才能设置。刚恢复射频时
            // 模组可能还没注册完，这条命令有一定概率被拒；上面已经等过注册，这里失败就
            // 如实报，不再盲等。
        } else {
            out.done.push("数据中心模式已开启（CEUS=1），跳过射频重启".into());
        }

        match self
            .step(tx, "AT^IMSSWITCH=1,0,0", "开启 LTE IMS")
            .await
        {
            Ok(_) => out.done.push("开启 LTE IMS".into()),
            Err(detail) => return out.fail("开启 LTE IMS", detail),
        }

        if let Some(sc) = smsc.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let cmd = format!(r#"AT+CSCA="{sc}""#);
            match self.step(tx, &cmd, "配置短信中心号码").await {
                Ok(_) => out.done.push("配置短信中心号码".into()),
                Err(detail) => return out.fail("配置短信中心号码", detail),
            }
        }
        out
    }

    /// 只跑一条命令的开关分支（关闭 IMS）。
    async fn run_one_step(&self, tx: &SmsTransaction, cmd: &str, label: &str) -> PowerSeq {
        let mut out = PowerSeq::default();
        match self.step(tx, cmd, label).await {
            Ok(_) => out.done.push(label.into()),
            Err(detail) => return out.fail(label, detail),
        }
        out
    }

    /// 事务内下发一条命令；返回 Err 就是**模组原始拒绝信息**（供页面诊断）。
    async fn step(&self, tx: &SmsTransaction, cmd: &str, label: &str) -> Result<AtResponse, String> {
        self.step_with_timeout(tx, cmd, label, crate::atclient::COMMAND_TIMEOUT)
            .await
    }

    async fn step_with_timeout(
        &self,
        tx: &SmsTransaction,
        cmd: &str,
        label: &str,
        timeout: Duration,
    ) -> Result<AtResponse, String> {
        match self
            .client
            .run_in_transaction(&self.ctx, tx, cmd, timeout)
            .await
        {
            Ok(resp) if resp.ok() && !resp.has_error() => Ok(resp),
            Ok(resp) => {
                let detail = compact_detail(&resp.text());
                log_warn!("短信开关步骤「{}」未返回 OK：{}", label, detail);
                Err(detail)
            }
            Err(e) => {
                log_warn!("短信开关步骤「{}」失败：{}", label, e);
                Err(e)
            }
        }
    }

    /// `AT+CFUN=1` 之后轮询射频与注册状态，返回（射频是否回到 1，是否已注册）。
    ///
    /// 判据：`AT+CFUN?` 回 1（射频已开）+ `AT+CEREG?` 回 1/5（已注册本地/漫游）。
    /// `AT+CEREG?` 答不上来时不把它当成「没注册」死等 —— 模组不支持查询的话，
    /// 再等 15 秒也不会多出答案，直接按「未知」结束轮询。
    async fn wait_for_rf(&self, tx: &SmsTransaction) -> (bool, Option<bool>) {
        let budget = Duration::from_millis(self.rf_recover_ms.load(Ordering::Relaxed));
        let started = Instant::now();
        let mut back = false;
        let mut registered: Option<bool> = None;
        loop {
            match self
                .client
                .run_in_transaction(&self.ctx, tx, "AT+CFUN?", crate::atclient::COMMAND_TIMEOUT)
                .await
            {
                Ok(resp) => back = parse_cfun_state(&resp.text()) == Some(1),
                Err(e) => log_warn!("回读 AT+CFUN? 失败：{}", e),
            }
            if back {
                match self
                    .client
                    .run_in_transaction(&self.ctx, tx, "AT+CEREG?", crate::atclient::COMMAND_TIMEOUT)
                    .await
                {
                    Ok(resp) => {
                        registered = parse_reg_state(&resp.text());
                        if registered == Some(true) {
                            break;
                        }
                    }
                    Err(e) => {
                        log_warn!("查询 AT+CEREG? 失败，注册状态按未知处理：{}", e);
                        registered = None;
                    }
                }
            }
            if started.elapsed() >= budget {
                break;
            }
            tokio::time::sleep(RF_RECOVER_STEP).await;
        }
        (back, registered)
    }

    /// 失败后的射频回滚：补 `AT+CFUN=1` 并回读，把结果写成一句给用户/日志看的话。
    async fn restore_rf(&self, tx: &SmsTransaction) -> String {
        let detail = match self
            .client
            .run_in_transaction(&self.ctx, tx, "AT+CFUN=1", CFUN_SET_TIMEOUT)
            .await
        {
            Ok(resp) if resp.ok() && !resp.has_error() => None,
            Ok(resp) => Some(compact_detail(&resp.text())),
            Err(e) => Some(e),
        };
        if let Some(d) = detail {
            log_warn!("短信开关失败后恢复射频失败：{}（请手动执行 AT+CFUN=1）", d);
            return format!("恢复射频失败：{d}（请手动执行 AT+CFUN=1）");
        }
        match self
            .client
            .run_in_transaction(&self.ctx, tx, "AT+CFUN?", crate::atclient::COMMAND_TIMEOUT)
            .await
        {
            Ok(resp) if parse_cfun_state(&resp.text()) == Some(1) => {
                log_warn!("短信开关失败，已回滚射频（回读 +CFUN: 1）");
                "已回滚：恢复射频并确认 +CFUN: 1".into()
            }
            Ok(resp) => {
                let d = compact_detail(&resp.text());
                log_warn!("短信开关失败后已补发 AT+CFUN=1，但回读仍不是 1：{}", d);
                format!("已尝试恢复射频，但回读为 {d}（请手动执行 AT+CFUN=1）")
            }
            Err(e) => {
                log_warn!("短信开关失败后已补发 AT+CFUN=1，但无法回读确认：{}", e);
                format!("已尝试恢复射频，但回读失败：{e}（请手动执行 AT+CFUN=1）")
            }
        }
    }

    /// IMS 开关（单条命令，但同样走短信事务：它直接决定短信能不能收发）。
    pub async fn ims_set(&self, enable: bool) -> Result<(), String> {
        let tx = self
            .client
            .open_sms_transaction(&self.ctx, "sms.ims", SMS_QUEUE_WAIT)
            .await?;
        let cmd = if enable { "AT^IMSSWITCH=1,0,0" } else { "AT^IMSSWITCH=0,0,0" };
        let res = self
            .client
            .run_in_transaction(&self.ctx, &tx, cmd, crate::atclient::COMMAND_TIMEOUT)
            .await?;
        drop(tx);
        if res.has_error() || !res.ok() {
            return Err(format!("模组拒绝了 IMS 设置：{}", last_line(&res.text())));
        }
        Ok(())
    }

    /// 查询 IMS（短信）开关状态；无法判定时返回 None。
    pub async fn ims_state(&self) -> Result<Option<bool>, String> {
        let tx = self
            .client
            .open_sms_transaction(&self.ctx, "sms.ims_state", SMS_QUEUE_WAIT)
            .await?;
        let resp = self
            .client
            .run_in_transaction(&self.ctx, &tx, "AT^IMSSWITCH?", crate::atclient::COMMAND_TIMEOUT)
            .await?;
        drop(tx);
        Ok(parse_ims_state(&resp.text()))
    }

    /// 在已有事务内读取存储用量（不新开事务）。
    async fn read_storage_in_tx(
        &self,
        tx: &crate::at_queue::SmsTransaction,
    ) -> Result<StorageInfo, String> {
        let resp = self
            .client
            .run_in_transaction(&self.ctx, tx, "AT+CPMS?", crate::atclient::COMMAND_TIMEOUT)
            .await?;
        parse_storage(&resp.lines).ok_or_else(|| "未能解析存储用量".into())
    }
}

/// `AT+CPMS?` 应答 → 三组存储区用量。
///
/// 手册 8.1.1 的读命令形态：`+CPMS: <mem1>,<used1>,<total1>,<mem2>,<used2>,<total2>,
/// <mem3>,<used3>,<total3>`，即每三段一组、组内依次是区名/已用/容量（区名带引号）。
/// 同一章节的**设置**命令应答只有六个数（`<used1>,<total1>,…`，不带区名），
/// 段数不够 9，正好被下面的 `segs.len() < 9` 挡掉，不会被误当成读命令。
fn parse_storage(lines: &[String]) -> Option<StorageInfo> {
    for line in lines {
        let line = line.trim();
        // 个别固件回私有前缀 ^CPMS，两种都认（与 urc.rs 的存储行解析同一口径）
        let Some(body) = line.strip_prefix("+CPMS:").or_else(|| line.strip_prefix("^CPMS:")) else {
            continue;
        };
        let segs: Vec<String> = body.split(',').map(|p| p.trim().trim_matches('"').to_string()).collect();
        if segs.len() < 9 {
            continue;
        }
        let mem1 = segs[0].clone();
        let used = segs[1].parse::<u64>().ok()?;
        let total = segs[2].parse::<u64>().ok()?;
        let mem2 = segs[3].clone();
        let mem3 = segs[6].clone();
        if total == 0 {
            // 容量 0 是「没读到」，不是「已满」
            continue;
        }
        return Some(StorageInfo { used, total, mem1, mem2, mem3 });
    }
    None
}

/*
 * 构造一条「已发送」的归档记录。
 *
 * 3GPP 的 SMS-SUBMIT 里没有发送时刻字段（只有 TP-VP 有效期），模组存下来再读
 * 回去也拿不到，所以发送时刻只能由**插件自己**盖章：取 [`crate::nettime`] 这个
 * 全仓库唯一墙上时间入口 —— 它优先 NTP 校时结果，取不到才回退设备时钟。
 *
 * `time_approx` 因此不再是「一律近似」，而是如实反映**这一次**的时刻来源：
 *   - NTP 已同步 → 时刻与服务器同源，`false`，界面按精确时刻显示；
 *   - NTP 没同步（刚开机还没拨上号、服务器不可达）→ 只能信设备时钟，
 *     断电重启后它可能停在 1970 或出厂时间，这时必须继续标 `true`，
 *     让界面写明「（近似）」，别把没对过的钟当成精确时刻误导排障。
 */
fn sent_record(destination: &str, message: &str) -> crate::sms_store::ArchiveRecord {
    let number = crate::notify::normalize_phone_number(destination);
    let time = Some(crate::nettime::now().format("%y/%m/%d,%H:%M:%S").to_string());
    crate::sms_store::ArchiveRecord {
        fingerprint: crate::sms_store::fingerprint("sent", &number, time.as_deref(), message),
        direction: "sent".into(),
        number,
        content: message.to_string(),
        time,
        time_approx: !crate::nettime::from_ntp(),
        index: None,
        archived_at_ms: crate::nettime::now_ms(),
    }
}

/*
 * 构造一条「已收到」的归档记录。
 *
 * 时间来自 PDU 的 TP-SCTS（模组给的服务中心时间戳），是真实时刻，
 * 故 `time_approx` 为 `false`。`index` 是模组格位，用于删除时按格位定位
 * —— 长短信合并成一条气泡后，界面只带着各段的格位。
 */
pub(crate) fn received_record(
    sender: &str,
    content: &str,
    time: Option<String>,
    index: Option<u32>,
) -> crate::sms_store::ArchiveRecord {
    let number = crate::notify::normalize_phone_number(sender);
    crate::sms_store::ArchiveRecord {
        fingerprint: crate::sms_store::fingerprint("received", &number, time.as_deref(), content),
        direction: "received".into(),
        number,
        content: content.to_string(),
        time,
        time_approx: false,
        index,
        archived_at_ms: crate::nettime::now_ms(),
    }
}

/// 日志里只放正文的简短预览：短信正文可能很长，整条打进日志既刷屏又泄隐私。
fn text_preview(s: &str) -> String {
    let n = s.chars().count();
    let head: String = s.chars().take(20).collect();
    if n > 20 {
        format!("{head}…（共 {n} 字）")
    } else {
        head
    }
}

/// 号码白名单：可选单个前导 `+`，其后 3～20 位**纯数字**。
///
/// 这是短信中心号码（`set_smsc` / `power_set`）的入口校验。手册 9.5.3 给 `<sca>` 写的
/// 字符集是 `*`、`#`、`+`、`0`～`9`（长度不超过 20，不含 `+`），这里**有意不收** `*` 和 `#`：
/// 本插件发送时要把中心号编进 PDU 的短信中心字段（见 `send` 第 2 步与 `pdu::encode_address`），
/// 那一栏只有 BCD 数字的位置。放开的话，`AT+CSCA="86*123"` 可能被模组收下、回读也一致，
/// 但下一次发信就在编码阶段失败 —— 「中心号设好了、短信反而发不出去」比当场拒绝难解释得多。
/// 3 位下限同理是防手滑，手册没有下限。引号、逗号、CR/LF 一律过不去：那是往串口注入第二条
/// AT 命令，这一条比格式美观重要得多。
///
/// 收件人号码在 `pdu::encode_address` 里还有一道同样的校验，两边口径一致。
fn valid_phone_address(s: &str) -> bool {
    let digits = s.strip_prefix('+').unwrap_or(s);
    (3..=20).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit())
}

/// 短信中心号码的入口校验。`set_smsc` 与 `power_set` 共用，两处对「什么样的号码算合法」
/// 必须给出同一句答案，否则用户在两个界面上拿到两种互不相同的规则。
fn check_smsc_input(number: &str) -> Result<String, String> {
    let cleaned = number.trim().to_string();
    if !valid_phone_address(&cleaned) {
        return Err(SMSC_FORMAT_HINT.into());
    }
    Ok(cleaned)
}

const SMSC_FORMAT_HINT: &str = "短信中心号码格式不正确：可选单个前导 +，其后 3～20 位数字\
                                （手册 9.5.3 的字符集另含 * 与 #，但本插件要把中心号编进 PDU，\
                                那一栏只放得下数字）";

/// 可写入 `AT+CPMS` 的存储区名白名单。
///
/// 手册 8.1.3 只给了两个可选值：**“SM”（(U)SIM 卡）** 与 **“ME”（FLASH 存储）**，
/// 三个参数 `<mem1>/<mem2>/<mem3>` 的可选值相同。TS 27.005 里的 `"MT"`/`"SR"`/`"BM"`/`"TA"`
/// 本手册一概没有，照着拼进命令只会换来一句 `+CME ERROR`，用户看不出为什么。
///
/// 注意这是**写侧**的约束：`AT+CPMS?` 的读侧解析（`parse_storage`）照旧照单收下模组
/// 实际回的区名，不在这里丢数据 —— 万一固件回了别的名字，界面仍显示真实状态，
/// 只有真的要去切/清那个区时才会被拦下来并给出可读的原因。
fn is_safe_mem_name(mem: &str) -> bool {
    matches!(mem, "SM" | "ME")
}

/// 从 `+XXX: "<number>",<...>` 应答里取出引号中的号码。
fn extract_quoted_number(text: &str, prefix: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.replace('\r', "");
        let line = line.trim();
        let Some(rest) = line.strip_prefix(prefix) else {
            continue;
        };
        let rest = rest.trim();
        let Some(start) = rest.find('"') else {
            continue;
        };
        let after = &rest[start + 1..];
        let Some(end) = after.find('"') else {
            continue;
        };
        return Some(after[..end].trim().to_string());
    }
    None
}

fn digits_eq(a: &str, b: &str) -> bool {
    let norm = |s: &str| -> String {
        let mut d: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
        d = d.trim_start_matches('0').to_string();
        if d.is_empty() {
            String::new()
        } else if d.len() > 1 && d.starts_with("86") {
            d[2..].to_string()
        } else {
            d
        }
    };
    norm(a) == norm(b)
}

/// `AT^IMSSWITCH?` 应答 → 开关是否开启（无法判定时 None）。
fn parse_ims_state(text: &str) -> Option<bool> {
    for line in text.replace('\r', "").lines() {
        let line = line.trim();
        let Some(payload) = line.strip_prefix("^IMSSWITCH:") else {
            continue;
        };
        let first = payload.split(',').next()?.trim().trim_matches('"');
        return match first {
            "1" => Some(true),
            "0" => Some(false),
            _ => None,
        };
    }
    None
}

/// `AT+CEUS?` 应答 → 数据中心模式取值（无法判定为 None）。
///
/// 手册 3.15.3 说 `1 数据中心（默认值）`，但 3.15.5 的举例回读是 `+CEUS: 0`，
/// 而且旧版本应用写过 `CEUS=0`。所以这里区分「读到 1」与「读不到」——
/// 后者必须按「需要重启射频」处理，不能拿默认值当现网状态。
fn parse_ceus_state(text: &str) -> Option<u8> {
    for line in text.replace('\r', "").lines() {
        let line = line.trim();
        let Some(payload) = line.strip_prefix("+CEUS:") else {
            continue;
        };
        let first = payload.split(',').next()?.trim().trim_matches('"');
        return first.parse::<u8>().ok();
    }
    None
}

/// `AT+CFUN?` 应答 → 射频功能状态（无法判定为 None）。
fn parse_cfun_state(text: &str) -> Option<u8> {
    for line in text.replace('\r', "").lines() {
        let line = line.trim();
        let Some(payload) = line.strip_prefix("+CFUN:") else {
            continue;
        };
        let first = payload.split(',').next()?.trim().trim_matches('"');
        return first.parse::<u8>().ok();
    }
    None
}

/// `AT+CEREG?` 应答 → 是否已注册（1=本地、5=漫游）。
///
/// 返回 None 表示「答不上来 / 看不懂」，调用方据此**不再等注册**，
/// 而不是当成未注册死等到超时上限。
fn parse_reg_state(text: &str) -> Option<bool> {
    for line in text.replace('\r', "").lines() {
        let line = line.trim();
        let Some(payload) = line.strip_prefix("+CEREG:") else {
            continue;
        };
        // 两种形态（3GPP TS 27.007）：
        //   查询回读  `+CEREG: <n>,<stat>`                  → <stat> 在第二位
        //   主动上报  `+CEREG: <stat>[,<tac>,<ci>,<AcT>]`   → <stat> 在第一位，后面是带引号的 TAC/CI
        // 用「第二位是不是引号串」区分两者，比数字段数可靠。
        let second_quoted = payload
            .split(',')
            .nth(1)
            .map(|f| f.trim().starts_with('"'))
            .unwrap_or(false);
        let fields: Vec<&str> = payload.split(',').map(|f| f.trim().trim_matches('"')).collect();
        let stat = if second_quoted {
            fields.first()
        } else {
            fields.get(1).or_else(|| fields.first())
        }?;
        return match *stat {
            "1" | "5" => Some(true),
            "0" | "2" | "3" | "4" | "8" => Some(false),
            _ => None,
        };
    }
    None
}

/// 是否需要为了应用 CEUS 而重启射频。
///
/// 只有**明确读到 1** 才跳过；读不到、读到 0 或其它值一律走完整重启。
/// 判断反了会静默留下一个「勾上了但短信收不到」的状态，代价比多断一次网大。
fn power_requires_rf_restart(ceus: Option<u8>) -> bool {
    ceus != Some(1)
}

fn last_line(text: &str) -> String {
    text.lines().last().unwrap_or("").trim().to_string()
}

/// 一次性提交的第一步（`AT+CMGS=<长度>`）是否等到了模组的 `> ` 输入提示符。
///
/// 只在 [needs_two_step_fallback] 触发的两段式重试里用到：这台模组正常路径上根本
/// 不给提示符（手册 9.14.1 的「可能的返回结果」里也没有 `>`），所以「没等到提示符」
/// 本身就是值得如实报出去的结果，而不是继续往下写 PDU 的理由。
///
/// 底层把「只剩空白与 `>` 的残留字节」识别成一行 `">"`（见 `AtClient::consume`），
/// 所以这里只认独立成行的提示符，不拿整段文本 `contains(">")` 凑数 —— 那样
/// 一条 `+CMS ERROR: 500` 里出现尖括号也会被当成「模组在等 PDU」。
fn saw_input_prompt(resp: &AtResponse) -> bool {
    resp.lines.iter().any(|l| l.trim() == ">")
}

/// 模组是否给出了真正的提交回执：有以 `+CMGS` 开头的应答行。
///
/// 按行首判断而不是全文 `contains`：PDU 回显、正文里出现的字符串都可能带
/// `+CMGS` 这几个字符，但它们不是模组的回执。
fn has_cmgs_reference(text: &str) -> bool {
    text.replace('\r', "")
        .lines()
        .any(|l| l.trim().starts_with("+CMGS"))
}

/// 把一次 `AT+CMGS` 的结果归类为「已确认 / 明确拒绝 / 结果不明」。
///
/// 判定依据是**模组真正的回执**，不是 Ctrl+Z 也不是输入提示符：
///   - 出现 `+CMS ERROR` / `+CME ERROR` / `ERROR` → 明确拒绝（先判，避免错误应答里
///     夹了 `+CMGS` 文本就被当成已受理）；
///   - 应答里有以 `+CMGS` 开头的回执行 → 模组确认提交；
///   - 只有单独的 OK（个别固件不给回执行）→ 也按提交处理，但 detail 保留原始应答；
///   - 超时 / 模组无响应 → Unknown。
///
/// 只看到 `> ` 提示符的情况不会走到 Accepted：那说明模组还在等 PDU，既没有 `+CMGS`
/// 也没有 OK，落到最后的 Unknown 分支。
fn classify_cmgs_result(res: &Result<crate::atclient::AtResponse, String>) -> (SendOutcome, String) {
    match res {
        Err(e) => (SendOutcome::Unknown, e.clone()),
        Ok(resp) => {
            let text = resp.text();
            if text.contains("+CMS ERROR:") || text.contains("+CME ERROR:") || resp.has_error() {
                (SendOutcome::Rejected, text)
            } else if has_cmgs_reference(&text) || resp.ok() {
                (SendOutcome::Accepted, text)
            } else {
                (SendOutcome::Unknown, format!("模组未给出提交确认（应答：{}）", first_line_capped(&text)))
            }
        }
    }
}

/// 一次性形态被拒时，是否值得退回标准两段式再试一次。
///
/// 判据是「PDU 还没进网络侧」：`ERROR` 与 `+CME ERROR` 都发生在模组的命令解析层，
/// 不存在已经投递成功的可能，所以换一种形态重发不构成重复投递。反过来两种情况
/// 必须停手：`+CMS ERROR` 是短信层/网络侧的拒绝（换形态也是同样结果，白等一轮），
/// 超时与静默是**结果不明**（模组可能已经发出去了），重试就是用户最不想看到的
/// 「同一条短信收到两遍」。
fn needs_two_step_fallback(res: &Result<AtResponse, String>) -> bool {
    match res {
        Ok(resp) => {
            let text = resp.text();
            !text.contains("+CMS ERROR:") && resp.has_error()
        }
        Err(_) => false,
    }
}

fn first_line_capped(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        return "(空应答)".into();
    }
    if line.chars().count() > 80 {
        return format!("{}…", line.chars().take(80).collect::<String>());
    }
    line.to_string()
}

/// 压缩成一句给人看的失败原因。
///
/// 优先挑**模组给出的错误行**（`+CMS ERROR: 500` 之类）而不是最后一行：
/// 应答里往往既有错误码又有别的行，取最后一行会把真正的错误码丢掉，
/// 用户看到的就只剩一句没有信息量的「失败」。
fn compact_detail(detail: &str) -> String {
    let line = detail
        .lines()
        .map(|l| l.trim())
        .find(|l| l.starts_with("+CMS ERROR:") || l.starts_with("+CME ERROR:") || *l == "ERROR")
        .or_else(|| detail.lines().last())
        .unwrap_or(detail)
        .trim();
    if line.is_empty() {
        "(无应答)".into()
    } else if line.chars().count() > 120 {
        format!("{}…", line.chars().take(120).collect::<String>())
    } else {
        line.to_string()
    }
}

fn is_memory_full_detail(detail: &str) -> bool {
    detail.contains("MEMORY FULL") || detail.contains("+CMS ERROR: 322") || detail.contains("^SMMEMFULL")
}

fn worst_outcome(a: SendOutcome, b: SendOutcome) -> SendOutcome {
    use SendOutcome::{Accepted, Rejected, Unknown};
    match (a, b) {
        (Accepted, x) | (x, Accepted) => x,
        (Rejected, _) | (_, Rejected) => Rejected,
        _ => Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sms_phone_address_validation_is_strict() {
        assert!(valid_phone_address("+8613800138000"));
        assert!(valid_phone_address("13800138000"));
        for bad in ["", "+", "12+3", "1,23", "123\rAT", "１２３"] {
            assert!(!valid_phone_address(bad), "should reject {bad:?}");
        }
    }

    #[test]
    fn smsc_input_rejects_what_pdu_cannot_encode() {
        // 手册 9.5.3 的字符集含 * 与 #，但中心号要被编进 PDU 的短信中心字段（BCD 数字），
        // 所以这两个字符在入口就拒掉，别让「设置成功、发信失败」这种状态出现。
        assert_eq!(check_smsc_input(" +8613800755500 ").unwrap(), "+8613800755500");
        for bad in ["86*123", "86#123", "+86+13800755500", "12", "861380075550000000001234",
                    r#"8613800755500","SM"#, "8613800755500\r\nAT+CFUN=0"] {
            let err = check_smsc_input(bad).expect_err("should reject {bad:?}");
            assert!(err.contains(SMSC_FORMAT_HINT), "文案要指回 9.5.3：{err}");
        }
    }

    #[test]
    fn mem_name_whitelist_follows_manual_8_1_3() {
        // 8.1.3 只定义 SM / ME。TS 27.005 里的 MT/SR/BM/TA 本手册没有，
        // 拼进 AT+CPMS 只会换来一句 +CME ERROR，所以入口直接拒。
        for ok in ["SM", "ME"] {
            assert!(is_safe_mem_name(ok), "{ok} 应可用");
        }
        for bad in ["MT", "SR", "BM", "TA", "sm", "ME1", ""] {
            assert!(!is_safe_mem_name(bad), "{bad:?} 不该进白名单");
        }
    }

    #[test]
    fn parse_storage_skips_noise_before_the_cpms_line() {
        // 回归：曾经用 `?` 提前返回，只要第一行不是 +CPMS 就整体读不到。
        let lines = vec![
            "AT+CPMS?".to_string(),
            String::new(),
            r#"+CPMS: "SM",3,50,"SM",3,50,"ME",1,30"#.to_string(),
            "OK".to_string(),
        ];
        let s = parse_storage(&lines).expect("应答里只要有 +CPMS 行就该读到");
        assert_eq!((s.used, s.total), (3, 50));
        assert_eq!(s.mem3, "ME");
        // 设置命令的应答只有六个数字（8.1.1），不带区名，不能当成读命令解析
        assert!(parse_storage(&[r#"+CPMS: 3,50,3,50,1,30"#.to_string(), "OK".into()]).is_none());
    }

    #[test]
    fn classify_accepted_on_cmgs_reference() {
        let ok: Result<crate::atclient::AtResponse, String> = Ok(crate::atclient::AtResponse {
            lines: vec!["+CMGS: 12".into(), "OK".into()],
        });
        let (outcome, _) = classify_cmgs_result(&ok);
        assert_eq!(outcome, SendOutcome::Accepted);
    }

    #[test]
    fn classify_rejected_on_cms_error() {
        let bad: Result<crate::atclient::AtResponse, String> = Ok(crate::atclient::AtResponse {
            lines: vec!["+CMS ERROR: 500".into()],
        });
        let (outcome, _) = classify_cmgs_result(&bad);
        assert_eq!(outcome, SendOutcome::Rejected);
    }

    #[test]
    fn classify_unknown_on_timeout() {
        let none: Result<crate::atclient::AtResponse, String> =
            Err("模组无响应（已等待 40000ms）: AT+CMGS=25".into());
        let (outcome, _) = classify_cmgs_result(&none);
        assert_eq!(outcome, SendOutcome::Unknown, "超时只能记为结果不明，不能当成失败重发");
    }

    #[test]
    fn prompt_only_is_not_accepted() {
        // 只拿到 `> ` 提示符说明模组还在等 PDU 输入，绝不能算成功。
        let prompt: Result<crate::atclient::AtResponse, String> = Ok(crate::atclient::AtResponse {
            lines: vec![">".into()],
        });
        let (outcome, _) = classify_cmgs_result(&prompt);
        assert_ne!(outcome, SendOutcome::Accepted);
    }

    #[test]
    fn storage_parsing_requires_nine_fields() {
        let lines: Vec<String> = vec!["+CPMS: \"ME\",3,50,\"ME\",3,50,\"ME\",3,50".into(), "OK".into()];
        let info = parse_storage(&lines).unwrap();
        assert_eq!(info.used, 3);
        assert_eq!(info.total, 50);
        assert_eq!(info.mem1, "ME");
        assert_eq!(info.mem2, "ME");
        assert_eq!(info.mem3, "ME");
    }

    #[test]
    fn storage_zero_total_is_not_full() {
        let lines: Vec<String> = vec!["+CPMS: \"ME\",0,0,\"ME\",0,0,\"ME\",0,0".into()];
        assert!(parse_storage(&lines).is_none(), "容量 0 表示没读到，不是满了");
    }

    #[test]
    fn quoted_number_extraction_handles_both_shapes() {
        // 部分固件不给第二参数
        assert_eq!(
            extract_quoted_number("+CSCA: \"+8613800755500\"\r\nOK", "+CSCA:").as_deref(),
            Some("+8613800755500")
        );
        assert_eq!(
            extract_quoted_number("+CSCA: \"+8613800755500\",145\r\nOK", "+CSCA:").as_deref(),
            Some("+8613800755500")
        );
        assert_eq!(extract_quoted_number("OK", "+CSCA:"), None);
    }

    #[test]
    fn digits_eq_normalizes_country_prefix() {
        assert!(digits_eq("+8613800755500", "8613800755500"));
        assert!(digits_eq("1380075550 0", "13800755500"));
        assert!(!digits_eq("13800138000", "13800755500"));
    }

    #[test]
    fn mem_name_whitelist_blocks_injection() {
        assert!(is_safe_mem_name("SM"));
        assert!(is_safe_mem_name("ME"));
        assert!(!is_safe_mem_name(r#"SM","SM","SM" AT+CFUN=0"#), "不能让外部串注入到 AT 命令里");
    }

    #[test]
    fn state_parsers_only_trust_real_replies() {
        // CEUS：手册 3.15.3 的默认值是 1，3.15.5 的举例回读却是 0 —— 两者都得如实解析。
        assert_eq!(parse_ceus_state("+CEUS: 1\r\nOK"), Some(1));
        assert_eq!(parse_ceus_state("+CEUS: 0"), Some(0));
        assert_eq!(parse_ceus_state("+CEUS: \"1\""), Some(1));
        assert_eq!(parse_ceus_state("OK"), None, "没给 CEUS 行就是没读到，不能当成 1");
        assert_eq!(parse_ceus_state("+CEUS: abc"), None);
        // CFUN
        assert_eq!(parse_cfun_state("+CFUN: 1\r\nOK"), Some(1));
        assert_eq!(parse_cfun_state("+CFUN: 0"), Some(0));
        assert_eq!(parse_cfun_state("ERROR"), None);
        // CEREG：查询回读 <n>,<stat> 与事件上报 <stat>,<tac>,<ci> 两种形态
        assert_eq!(parse_reg_state("+CEREG: 0,1\r\nOK"), Some(true));
        assert_eq!(parse_reg_state("+CEREG: 2,5"), Some(true), "漫游注册也算注册");
        assert_eq!(parse_reg_state("+CEREG: 0,2"), Some(false), "正在搜网 ≠ 已注册");
        assert_eq!(parse_reg_state("+CEREG: 1,\"57274\",\"01234567\",7"), Some(true));
        assert_eq!(parse_reg_state("+CEREG: 2"), Some(false), "只有一位时它就是 stat");
        assert_eq!(parse_reg_state("ERROR"), None, "读不到就交 None，让调用方别死等");
    }

    #[test]
    fn rf_restart_is_skipped_only_on_explicit_ceus_one() {
        assert!(!power_requires_rf_restart(Some(1)), "已经是数据中心模式，重启射频只是白断网");
        assert!(power_requires_rf_restart(Some(0)), "CEUS=0 必须写 1 并开关机生效");
        assert!(power_requires_rf_restart(None), "读不到时按需要重启处理，宁可慢也不能留下假开启");
    }

    #[tokio::test]
    async fn power_enable_skips_rf_restart_when_ceus_is_already_one() {
        // 绝大多数设备出厂就是 CEUS=1，此时整套 CFUN 重启是不必要的断网。
        let (svc, modem, _ctx) = harness(power_ok("+CEUS: 1")).await;
        let r = svc.power_set(true, None).await.unwrap();
        assert!(r.enabled, "开启应成功：{:?}", r.failed_detail);
        let cmds = modem.cmds();
        assert!(cmds.iter().any(|c| c == "AT+CEUS?"), "必须先读 CEUS");
        assert!(!cmds.iter().any(|c| c == "AT+CFUN=0"), "CEUS 已是 1 时不得关射频：{cmds:?}");
        assert!(cmds.iter().any(|c| c.starts_with("AT^IMSSWITCH=1")), "IMS 仍要设置：{cmds:?}");
        assert!(
            r.steps_done.iter().any(|s| s.contains("跳过射频重启")),
            "步骤里要如实说明为什么没重启：{:?}",
            r.steps_done
        );
    }

    #[tokio::test]
    async fn power_enable_rolls_back_rf_when_a_later_step_fails() {
        // CEUS=0 → 走完整重启；IMSSWITCH 被拒（手册 4.10.1 的失败场景），
        // 且射频回读仍是 0（模组没回来）——这时必须补发 AT+CFUN=1，
        // 否则用户点一次「开启短信」换来的是整机断网。
        let (svc, modem, _ctx) = harness(move |cmd: &str| match cmd {
            "AT+CEUS?" => Reply::Lines(vec!["+CEUS: 0".into(), "OK".into()]),
            "AT+CFUN?" => Reply::Lines(vec!["+CFUN: 0".into(), "OK".into()]),
            "AT+CEREG?" => Reply::Lines(vec!["+CME ERROR: 3".into()]),
            "AT^IMSSWITCH=1,0,0" => Reply::Lines(vec!["+CME ERROR: 308".into()]),
            _ => Reply::ok(&[]),
        })
        .await;
        svc.set_rf_recover_budget(Duration::from_millis(0));
        let r = svc.power_set(true, None).await.unwrap();
        assert!(!r.enabled);
        assert_eq!(r.failed_at.as_deref(), Some("开启 LTE IMS"), "{:?}", r.failed_at);
        let detail = r.failed_detail.clone().unwrap_or_default();
        assert!(detail.contains("308"), "要带上模组的原始错误码：{detail}");
        assert!(detail.contains("恢复射频"), "要说明射频回滚的结果：{detail}");
        let cmds = modem.cmds();
        let cfun1 = cmds.iter().filter(|c| c.as_str() == "AT+CFUN=1").count();
        assert!(cfun1 >= 2, "序列里一次、回滚再补一次，实际 {cmds:?}");
        // 顺序：CEUS=1 必须早于 CFUN=0（手册 3.15.2 要求设置后经开关机生效）
        let pos_ceus = cmds.iter().position(|c| c == "AT+CEUS=1").unwrap();
        let pos_off = cmds.iter().position(|c| c == "AT+CFUN=0").unwrap();
        let pos_on = cmds.iter().position(|c| c == "AT+CFUN=1").unwrap();
        assert!(pos_ceus < pos_off, "CEUS 必须在关射频之前写下：{cmds:?}");
        assert!(pos_off < pos_on, "关射频之后必须再开回来：{cmds:?}");
    }

    #[tokio::test]
    async fn power_enable_ceus_rejected_leaves_rf_untouched() {
        // 手册 3.15.4 之外还有一层：CEUS 写失败时射频根本没动过，
        // 所以这条路径不该出现任何 CFUN 下发，模组保持 +CFUN: 1。
        let (svc, modem, _ctx) = harness(move |cmd: &str| {
            if cmd == "AT+CEUS?" {
                return Reply::Lines(vec!["+CEUS: 0".into(), "OK".into()]);
            }
            if cmd == "AT+CEUS=1" {
                return Reply::Lines(vec!["+CME ERROR: 3".into()]);
            }
            if cmd.starts_with("AT+CFUN") || cmd.starts_with("AT^IMSSWITCH") {
                return Reply::Lines(vec!["OK".into()]);
            }
            Reply::ok(&["+CSCA: \"+8613800755500\",145"])
        })
        .await;
        let r = svc.power_set(true, None).await.unwrap();
        assert!(!r.enabled);
        assert_eq!(r.failed_at.as_deref(), Some("设置数据中心模式"));
        assert!(r.failed_detail.clone().unwrap_or_default().contains('3'));
        let cmds = modem.cmds();
        assert!(!cmds.iter().any(|c| c == "AT+CFUN=0"), "CEUS 被拒后不得关射频：{cmds:?}");
        assert!(!cmds.iter().any(|c| c == "AT+CFUN=1"), "更不得补发开射频：{cmds:?}");
        assert!(!cmds.iter().any(|c| c.starts_with("AT^IMSSWITCH=1")), "后面几步都不该跑：{cmds:?}");
    }

    #[tokio::test]
    async fn power_disable_touches_nothing_but_ims() {
        let (svc, modem, _ctx) = harness(power_ok("+CEUS: 1")).await;
        let r = svc.power_set(false, None).await.unwrap();
        assert!(!r.enabled, "关闭后 enabled 必须是 false");
        assert!(r.failed_at.is_none(), "{:?}", r.failed_detail);
        let cmds = modem.cmds();
        assert!(cmds.iter().any(|c| c == "AT^IMSSWITCH=0,0,0"));
        assert!(!cmds.iter().any(|c| c == "AT+CFUN=0"), "关闭短信不该断网：{cmds:?}");
        assert!(!cmds.iter().any(|c| c == "AT+CEUS=0"), "关闭短信不该改 CEUS：{cmds:?}");
        assert!(!cmds.iter().any(|c| c.starts_with("AT+CMGD")), "关闭短信不该清空短信：{cmds:?}");
    }

    #[tokio::test]
    async fn purge_keeps_modem_reason_when_switching_mem_fails() {
        // 「切换存储区失败」后面必须带模组原话，否则 +CME ERROR: 4 这类线索就丢了。
        let (svc, _modem, _ctx) = harness(move |cmd: &str| {
            if cmd.starts_with(r#"AT+CPMS="SM""#) {
                return Reply::Lines(vec!["+CME ERROR: 4".into()]);
            }
            if cmd == "AT+CPMS?" {
                return Reply::Lines(vec![
                    "+CPMS: \"SM\",1,50,\"SM\",1,50,\"ME\",0,50".into(),
                    "OK".into(),
                ]);
            }
            if cmd == "AT+CMGD=1,4" {
                return Reply::Lines(vec!["OK".into()]);
            }
            Reply::ok(&[])
        })
        .await;
        let r = svc.purge_all().await.unwrap();
        assert_eq!(r.requested, 2, "读到的 SM / ME 两个区各试一次");
        assert_eq!(r.deleted, 1, "SM 没切过去，只有 ME 清空成功：{:?}", r.errors);
        assert_eq!(r.errors.len(), 1, "{:?}", r.errors);
        assert!(r.errors[0].starts_with("SM: 切换存储区失败"), "{:?}", r.errors);
        assert!(r.errors[0].contains('4'), "模组原话要留在错误里：{:?}", r.errors);
    }

    #[tokio::test]
    async fn purge_never_writes_a_mem_name_the_manual_does_not_define() {
        // 固件在 AT+CPMS? 里回了手册 8.1.3 之外的区名（拿 "MT" 当例子）：
        // 读侧照实显示，写侧一次都不能去碰 —— 拼一个手册没记载的区名只会换来
        // 一句 +CME ERROR，用户分不清是「不支持」还是「清空功能坏了」。
        let (svc, modem, _ctx) = harness(move |cmd: &str| {
            if cmd == "AT+CPMS?" {
                return Reply::Lines(vec![
                    "+CPMS: \"SM\",1,50,\"SM\",1,50,\"MT\",0,50".into(),
                    "OK".into(),
                ]);
            }
            if cmd == "AT+CMGD=1,4" {
                return Reply::Lines(vec!["OK".into()]);
            }
            Reply::ok(&[])
        })
        .await;
        let r = svc.purge_all().await.unwrap();
        let cmds = modem.cmds();
        assert!(
            !cmds.iter().any(|c| c.starts_with(r#"AT+CPMS="MT""#)),
            "不该对 MT 区下发切换：{cmds:?}"
        );
        assert!(r.errors.iter().any(|e| e.contains("MT") && e.contains("8.1.3")), "{:?}", r.errors);
        assert_eq!(r.deleted, 1, "SM 区仍然要清干净：{:?}", r.errors);
    }

    #[tokio::test]
    async fn purge_restores_the_original_storage_areas() {
        // 清空为了逐区删净，会把 mem1 一个个切过去；切完必须还回用户原先的那一组，
        // 否则「清空短信」顺带把之后所有 list / delete / CMGR 的默认介质改了。
        let (svc, modem, _ctx) = harness(move |cmd: &str| {
            if cmd == "AT+CPMS?" {
                return Reply::Lines(vec![
                    "+CPMS: \"SM\",4,50,\"SM\",4,50,\"ME\",0,50".into(),
                    "OK".into(),
                ]);
            }
            Reply::ok(&[])
        })
        .await;
        let r = svc.purge_all().await.unwrap();
        let switches: Vec<String> = modem
            .cmds()
            .into_iter()
            .filter(|c| c.starts_with("AT+CPMS=\""))
            .collect();
        assert_eq!(
            switches.first().map(String::as_str),
            Some(r#"AT+CPMS="SM","SM","SM""#),
            "第一个被切到的区应是上报里排在最前的 SM：{switches:?}"
        );
        assert!(switches.iter().any(|c| c == r#"AT+CPMS="ME","ME","ME""#), "ME 区也要清：{switches:?}");
        assert_eq!(
            switches.last().map(String::as_str),
            Some(r#"AT+CPMS="SM","SM","ME""#),
            "收尾必须把三个区原样还回去：{switches:?}"
        );
        assert_eq!(r.requested, 2, "SM 与 ME 两个区都试过了");
    }

    #[tokio::test]
    async fn list_reports_modem_failure_instead_of_empty_list() {
        // 手册 9.8.1：CMGL 失败回 `+CMS ERROR: <err>`，成功才以 OK 收尾。
        // 没有 OK 就不能当成「一条短信也没有」，否则 SIM 卡没就绪会被洗成「本机没有短信」。
        let (svc, _modem, _ctx) = harness(move |cmd: &str| {
            if cmd.starts_with("AT+CMGL") {
                return Reply::Lines(vec!["+CMS ERROR: 4".into()]);
            }
            Reply::ok(&["+CMGF: 0"])
        })
        .await;
        let err = svc.list().await.expect_err("读不出来必须报错，不能返回空列表");
        assert!(err.contains('4'), "要把模组原话带出来：{err}");
    }

    #[test]
    fn cmgs_reference_requires_a_real_receipt_line() {
        // 回显里带 +CMGS 字样的非回执行不能算成功；真正的回执行才算。
        assert!(has_cmgs_reference("+CMGS: 12\r\nOK"));
        assert!(has_cmgs_reference("+CMGS: 12"));
        assert!(!has_cmgs_reference("OK"), "没有回执行时交给 resp.ok() 判断");
        assert!(!has_cmgs_reference("> "));
        assert!(!has_cmgs_reference("0011006800002143F1 里提到 +CMGS 只是正文"));
    }

    #[test]
    fn classify_treats_bare_ok_as_accepted_but_prompt_as_unknown() {
        let bare: Result<crate::atclient::AtResponse, String> =
            Ok(crate::atclient::AtResponse { lines: vec!["OK".into()] });
        assert_eq!(classify_cmgs_result(&bare).0, SendOutcome::Accepted);
        let prompt: Result<crate::atclient::AtResponse, String> =
            Ok(crate::atclient::AtResponse { lines: vec![">".into()] });
        assert_eq!(classify_cmgs_result(&prompt).0, SendOutcome::Unknown);
    }

    /// 开关序列用的通用应答器：CEUS 回读值由 `ceus_line` 决定，其余命令一律接受，
    /// 射频回读为 1 且已注册。
    fn power_ok(ceus_line: &'static str) -> impl Fn(&str) -> Reply + Send + Sync + 'static {
        move |cmd: &str| match cmd {
            "AT+CEUS?" => Reply::Lines(vec![ceus_line.into(), "OK".into()]),
            "AT+CFUN?" => Reply::Lines(vec!["+CFUN: 1".into(), "OK".into()]),
            "AT+CEREG?" => Reply::Lines(vec!["+CEREG: 0,1".into(), "OK".into()]),
            "AT+CSCA?" => Reply::ok(&["+CSCA: \"+8613800755500\",145"]),
            _ => Reply::ok(&[]),
        }
    }

    #[tokio::test]
    async fn power_enable_full_restart_succeeds_without_rollback_noise() {
        // CEUS=0 的设备：完整走 CEUS=1 → CFUN=0 → CFUN=1 → 确认 → IMSSWITCH，
        // 成功时不该多补一次 AT+CFUN=1（回滚只属于失败路径）。
        let (svc, modem, _ctx) = harness(power_ok("+CEUS: 0")).await;
        svc.set_rf_recover_budget(Duration::from_millis(0));
        let r = svc.power_set(true, Some("+8613800755500".into())).await.unwrap();
        assert!(r.enabled, "{:?}", r.failed_detail);
        assert_eq!(r.failed_at, None);
        let cmds = modem.cmds();
        assert_eq!(cmds.iter().filter(|c| c.as_str() == "AT+CFUN=1").count(), 1, "{cmds:?}");
        assert!(cmds.iter().any(|c| c == r#"AT+CSCA="+8613800755500""#), "短信中心要在这串里写掉：{cmds:?}");
        assert!(
            r.steps_done.iter().any(|s| s.contains("注册网络")),
            "射频确认结果要如实写进步骤：{:?}",
            r.steps_done
        );
    }

    /* ==================== 模拟模组端到端测试 ==================== */

    use crate::atclient::testutil::{MockModem, Reply, attach_mock_modem};
    use crate::atclient::COMMAND_TIMEOUT;

    /// 造一个带模拟模组的短信服务。
    ///
    /// 走的是**真实的 AtClient + 真实的读循环 + 真实的命令闸**，
    /// 只把模组那一端换成可编程应答器，因此命令顺序、字节序列、互斥行为
    /// 与实机一致。
    async fn harness(
        responder: impl Fn(&str) -> Reply + Send + Sync + 'static,
    ) -> (Arc<crate::sms::SmsService>, MockModem, tokio::sync::watch::Sender<bool>) {
        let (tx, _rx) = tokio::sync::mpsc::channel::<crate::atclient::Unsolicited>(64);
        let client = AtClient::new(crate::config::default_config().at, tx);
        let (ctx_tx, ctx_rx) = tokio::sync::watch::channel(false);
        let modem = attach_mock_modem(client.clone(), ctx_rx.clone(), responder).await;
        let mode = client.sms_mode();
        let svc = crate::sms::SmsService::with_timeouts(
            client,
            ctx_rx,
            mode,
            Duration::from_millis(600),   // 单分片提交预算（测试用短值）
            Duration::from_millis(2000),  // 总预算
        );
        (svc, modem, ctx_tx)
    }

    /// 通用应答器：按前缀给出模组应答。
    fn script(pairs: Vec<(&'static str, Reply)>) -> impl Fn(&str) -> Reply + Send + Sync + 'static {
        move |cmd: &str| {
            for (prefix, reply) in &pairs {
                if cmd.starts_with(prefix) {
                    return match reply {
                        Reply::Lines(v) => Reply::Lines(v.clone()),
                        Reply::Prompt => Reply::Prompt,
                        Reply::Silent => Reply::Silent,
                    };
                }
            }
            Reply::ok(&[])
        }
    }

    #[tokio::test]
    async fn list_uses_live_data_not_cache() {
        // 模组分两次给出不同的列表：第二次必须反映模组的新状态，
        // 不能把第一次的结果当成缓存返回。
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls2 = calls.clone();
        let responder = move |cmd: &str| {
            if cmd.starts_with("AT+CMGL") {
                let n = calls2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if n == 0 {
                    Reply::Lines(vec![
                        "+CMGL: 1,1,,24".into(),
                        "00040B913108108300F0000852805221000023046D4B8BD5".into(),
                        "OK".into(),
                    ])
                } else {
                    // 第二次：模组里已经空了
                    Reply::Lines(vec!["OK".into()])
                }
            } else {
                Reply::ok(&["+CMGF: 0"])
            }
        };
        let (svc, _modem, _ctx) = harness(responder).await;

        let first = svc.list().await.unwrap();
        assert_eq!(first.entries.len(), 1, "第一次应读到 1 条");
        assert_eq!(first.entries[0].content, "测试");
        assert_eq!(first.entries[0].index, Some(1));

        let second = svc.list().await.unwrap();
        assert_eq!(second.entries.len(), 0, "第二次必须是模组的真实状态（空），不能返回上一次的快照");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2, "每次 list 都应真的下发 AT+CMGL");
    }

    #[tokio::test]
    async fn send_accepted_requires_cmgs_reference() {
        let (svc, modem, _ctx) = harness(script(vec![
            ("AT+CMGF?", Reply::Lines(vec!["+CMGF: 0".into(), "OK".into()])),
            ("AT+CSCA?", Reply::Lines(vec!["+CSCA: \"+8613800755500\",145".into(), "OK".into()])),
            ("AT+CMGS=", Reply::ok(&["+CMGS: 12"])),
            ("AT+CPMS?", Reply::Lines(vec!["+CPMS: \"ME\",3,50,\"ME\",3,50,\"ME\",3,50".into(), "OK".into()])),
        ]))
        .await;

        let r = svc
            .send(SendRequest { destination: "13800138000".into(), message: "你好".into(), smsc: None, dedup_key: None })
            .await
            .unwrap();
        assert_eq!(r.outcome, SendOutcome::Accepted, "拿到 +CMGS 回执才算成功：{:?}", r.message);
        assert_eq!(r.encoding, "UCS2");
        assert!(r.storage.is_some(), "发送后应带回一次真实容量读数");

        // 字节级：手册 9.14.5 的一次性形态 —— **同一次写入**里就有长度、字面 `\r`
        // 分隔符与完整 PDU；全程没有 0x1A，也没有「只报长度」的独立一段。
        let batches: Vec<Vec<u8>> = {
            let guard = modem.written.lock().unwrap_or_else(|e| e.into_inner());
            guard.clone()
        };
        let stream = modem.stream();
        let text = String::from_utf8_lossy(&stream).to_string();
        let submit = batches
            .iter()
            .map(|b| String::from_utf8_lossy(b).to_string())
            .find(|s| s.starts_with("AT+CMGS="))
            .unwrap_or_else(|| panic!("应下发 AT+CMGS，实际写入 {text:?}"));
        assert!(submit.ends_with('\r'), "命令以真实 CR 结尾交给模组，实际 {submit:?}");
        let body = submit.trim_end_matches('\r');
        let rest = body.strip_prefix("AT+CMGS=").expect("前缀必须是 AT+CMGS=");
        let (len, pdu) = rest.split_once("\\r").expect("长度与 PDU 之间必须是字面的 \\r 两个字符");
        assert!(
            !len.is_empty() && len.chars().all(|c| c.is_ascii_digit()),
            "长度字段是十进制字节数，实际 {rest:?}"
        );
        let want = len.parse::<usize>().unwrap();
        let smsc_octets = usize::from_str_radix(pdu.get(0..2).unwrap_or("00"), 16).unwrap();
        assert_eq!(
            pdu.len() / 2,
            want + 1 + smsc_octets,
            "<length> 不含 SMSC 字段（手册 9.14.5：18 配 19 字节 PDU），实际 PDU {pdu}"
        );
        assert!(!stream.contains(&0x1A), "一次性形态不带 Ctrl-Z；出现 0x1A 说明走了两段式重试");
        assert!(!text.contains("\\u001a") && !text.contains("\\x1a"), "不应出现被转义成字面量的 0x1A");
    }

    #[tokio::test]
    async fn send_falls_back_to_two_step_only_after_local_error() {
        // 一次性形态被模组**本地**拒绝（ERROR，PDU 没进网络侧）→ 允许退回标准
        // 两段式再试一次；这条用例同时锁住「重试只发生一次」。
        let submits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let submits2 = submits.clone();
        let (svc, modem, _ctx) = harness(move |cmd: &str| {
            if cmd.starts_with("AT+CMGS=") {
                let n = submits2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                // 第 0 次 = 一次性形态（带字面 \r）→ 本地 ERROR；
                // 第 1 次 = 两段式第一步（只报长度）→ 给 `> ` 提示符，
                // 随后的 PDU 由 attach_mock_modem 按真实模组回 +CMGS。
                return if n == 0 {
                    Reply::Lines(vec!["ERROR".into()])
                } else {
                    Reply::Prompt
                };
            }
            if cmd.starts_with("AT+CPMS?") {
                return Reply::ok(&["+CPMS: \"ME\",3,50,\"ME\",3,50,\"ME\",3,50"]);
            }
            Reply::ok(&["+CMGF: 0"])
        })
        .await;

        let r = svc
            .send(SendRequest { destination: "13800138000".into(), message: "重试".into(), smsc: None, dedup_key: None })
            .await
            .unwrap();
        assert_eq!(r.outcome, SendOutcome::Accepted, "两段式重试拿到回执应算成功：{:?}", r.message);
        assert_eq!(submits.load(std::sync::atomic::Ordering::SeqCst), 2, "一次性一次 + 两段式一次");
        let stream = modem.stream();
        assert!(stream.contains(&0x1A), "两段式重试必须以 Ctrl-Z 结束 PDU 输入");
    }

    #[tokio::test]
    async fn send_does_not_change_shape_after_cms_error() {
        // `+CMS ERROR` 是短信层/网络侧的拒绝：换形态也是同样结果，且已经白等一轮
        // 网络交互，必须直接如实报失败，不再走两段式。
        let submits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let submits2 = submits.clone();
        let (svc, _modem, _ctx) = harness(move |cmd: &str| {
            if cmd.starts_with("AT+CMGS=") {
                submits2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                return Reply::Lines(vec!["+CMS ERROR: 500".into()]);
            }
            if cmd.starts_with("AT+CPMS?") {
                return Reply::ok(&["+CPMS: \"ME\",3,50,\"ME\",3,50,\"ME\",3,50"]);
            }
            Reply::ok(&["+CMGF: 0"])
        })
        .await;

        let r = svc
            .send(SendRequest { destination: "13800138000".into(), message: "x".into(), smsc: None, dedup_key: None })
            .await
            .unwrap();
        assert_eq!(r.outcome, SendOutcome::Rejected, "{:?}", r.message);
        assert_eq!(submits.load(std::sync::atomic::Ordering::SeqCst), 1, "网络侧拒绝不得换形态重试");
    }

    #[tokio::test]
    async fn send_rejected_on_cms_error() {
        // 模组明确拒绝：`+CMS ERROR: 500`（典型的「未知错误/网络侧拒绝」）。
        let (svc, modem, _ctx) = harness(script(vec![
            ("AT+CMGF?", Reply::Lines(vec!["+CMGF: 0".into(), "OK".into()])),
            ("AT+CSCA?", Reply::ok(&["+CSCA: \"+8613800755500\",145"])),
            ("AT+CMGS=", Reply::Lines(vec!["+CMS ERROR: 500".into()])),
            ("AT+CPMS?", Reply::ok(&["+CPMS: \"ME\",3,50,\"ME\",3,50,\"ME\",3,50"])),
        ]))
        .await;
        let _ = modem;
        let r = svc
            .send(SendRequest { destination: "13800138000".into(), message: "x".into(), smsc: None, dedup_key: None })
            .await
            .unwrap();
        assert_eq!(r.outcome, SendOutcome::Rejected, "模组明确拒绝必须记为失败：{:?}", r.message);
        assert!(r.message.contains("500"), "失败原因要带上模组的错误码：{}", r.message);
        assert_eq!(r.parts.len(), 1, "拒绝后不得继续提交后续分片");
    }

    #[tokio::test]
    async fn send_does_not_retry_after_unknown() {
        let submits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let submits2 = submits.clone();
        let (svc, _modem, _ctx) = harness(move |cmd: &str| {
            if cmd.starts_with("AT+CMGS=") {
                submits2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                return Reply::Silent; // 模组不回话
            }
            if cmd.starts_with("AT+CPMS?") {
                return Reply::ok(&["+CPMS: \"ME\",3,50,\"ME\",3,50,\"ME\",3,50"]);
            }
            Reply::ok(&["+CMGF: 0"])
        })
        .await;

        let r = svc
            .send(SendRequest { destination: "13800138000".into(), message: "测试内容".into(), smsc: None, dedup_key: None })
            .await
            .unwrap();
        assert_eq!(r.outcome, SendOutcome::Unknown);
        assert_eq!(submits.load(std::sync::atomic::Ordering::SeqCst), 1,
            "结果不明时绝不能自动重发（可能已经发走，重发=重复计费）");
    }

    #[tokio::test]
    async fn send_clears_a_half_open_pdu_prompt_with_escape() {
        // 实机每片提交失败后先往串口写一个 ESC 才继续用（smssend 的 `at("\x1b", 3)`）：
        // 模组可能停在「等 PDU」的半开输入态，这时直接问 AT+CPMS? 会被当成 PDU 吞掉，
        // 一次发送失败连带把后面的读写一起拖死。
        let (svc, modem, _ctx) = harness(move |cmd: &str| {
            if cmd.starts_with("AT+CMGS=") {
                return Reply::Silent; // 模组不回话
            }
            if cmd.starts_with("AT+CPMS?") {
                return Reply::ok(&["+CPMS: \"ME\",3,50,\"ME\",3,50,\"ME\",3,50"]);
            }
            Reply::ok(&["+CMGF: 0"])
        })
        .await;

        let r = svc
            .send(SendRequest { destination: "10000".into(), message: "102".into(), smsc: None, dedup_key: None })
            .await
            .unwrap();
        assert_eq!(r.outcome, SendOutcome::Unknown);
        // ESC 不是 AT 命令，只会出现在「写到串口的字节流」里，故取 modem 的记录。
        let cmds = modem.cmds();
        let cmgs_at = cmds.iter().position(|c| c.starts_with("AT+CMGS=")).expect("应有一次提交");
        let esc_at = cmds.iter().position(|c| c == "\u{1b}").expect("失败后应写 ESC 清输入态");
        let cpms_at = cmds.iter().position(|c| c.starts_with("AT+CPMS?")).expect("收尾应读一次容量");
        assert!(cmgs_at < esc_at && esc_at < cpms_at, "ESC 必须夹在失败的提交与后续查询之间：{cmds:?}");
        assert_eq!(cmds.iter().filter(|c| c.starts_with("AT+CMGS=")).count(), 1,
            "清完输入态也不等于可以重发");
    }

    #[tokio::test]
    async fn duplicate_click_is_deduped() {
        let submits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let submits2 = submits.clone();
        let (svc, _modem, _ctx) = harness(move |cmd: &str| {
            if cmd.starts_with("AT+CMGS=") {
                submits2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                return Reply::ok(&["+CMGS: 12"]);
            }
            if cmd.starts_with("AT+CPMS?") {
                return Reply::ok(&["+CPMS: \"ME\",3,50,\"ME\",3,50,\"ME\",3,50"]);
            }
            Reply::ok(&["+CMGF: 0"])
        })
        .await;

        let req = SendRequest { destination: "13800138000".into(), message: "同一条".into(), smsc: None, dedup_key: None };
        let a = svc.send(req.clone()).await.unwrap();
        // 立刻再点一次（同一号码 + 同一正文）
        let b = svc.send(req.clone()).await.unwrap();
        assert_eq!(a.outcome, SendOutcome::Accepted);
        assert_eq!(b.outcome, SendOutcome::Rejected, "重复点击应被后端拦下");
        assert_eq!(submits.load(std::sync::atomic::Ordering::SeqCst), 1, "重复点击只能真实提交一次");
    }

    #[tokio::test]
    async fn long_message_is_split_and_ordered() {
        let mut message = String::from("长短信");
        for _ in 0..40 {
            message.push_str("这是一句比较长的测试内容😀");
        }
        let (svc, modem, _ctx) = harness(script(vec![
            ("AT+CMGF?", Reply::Lines(vec!["+CMGF: 0".into(), "OK".into()])),
            ("AT+CSCA?", Reply::ok(&["+CSCA: \"+8613800755500\",145"])),
            ("AT+CMGS=", Reply::ok(&["+CMGS: 12"])),
            ("AT+CPMS?", Reply::ok(&["+CPMS: \"ME\",3,50,\"ME\",3,50,\"ME\",3,50"])),
        ]))
        .await;

        let r = svc
            .send(SendRequest { destination: "13800138000".into(), message: message.clone(), smsc: None, dedup_key: None })
            .await
            .unwrap();
        assert_eq!(r.outcome, SendOutcome::Accepted);
        assert!(r.parts.len() > 1, "长短信应自动分片，实际 {} 片", r.parts.len());
        // 片序必须连续递增
        for (i, p) in r.parts.iter().enumerate() {
            assert_eq!(p.part_number, (i + 1) as u32, "分片顺序必须连续");
            assert_eq!(p.parts_count, r.parts.len() as u32);
        }
        // 每一片都是一条独立的 AT+CMGS，且长度参数是「不含 SMSC 的 TPDU 字节数」
        let cmds = modem.cmds();
        let submits: Vec<&String> = cmds.iter().filter(|c| c.starts_with("AT+CMGS=")).collect();
        assert_eq!(submits.len(), r.parts.len());
    }

    #[tokio::test]
    async fn transaction_excludes_other_commands() {
        // 短信事务持有通道期间，其它优先级的命令必须排在后面，不能插进事务中间。
        let (tx, _rx) = tokio::sync::mpsc::channel::<crate::atclient::Unsolicited>(64);
        let client = AtClient::new(crate::config::default_config().at, tx);
        let (ctx_tx, ctx_rx) = tokio::sync::watch::channel(false);
        let modem = attach_mock_modem(client.clone(), ctx_rx.clone(), |cmd: &str| {
            if cmd.starts_with("AT^HCSQ?") {
                return Reply::ok(&["^HCSQ: \"NR\",72,201,30"]);
            }
            Reply::ok(&[])
        })
        .await;

        let svc = crate::sms::SmsService::with_timeouts(
            client.clone(), ctx_rx.clone(), client.sms_mode(),
            Duration::from_millis(500), Duration::from_millis(1500),
        );

        // 开一个事务，在里面跑两条命令，中间塞入一条「后台巡检」
        let txn = client.open_sms_transaction(&ctx_rx, "test", Duration::from_secs(2)).await.unwrap();
        client.run_in_transaction(&ctx_rx, &txn, "AT+CMGF=0", COMMAND_TIMEOUT).await.unwrap();

        // 后台巡检：此时通道被事务占着，它应当拿不到（超时失败），而不是插进去执行。
        let intruder = {
            let c = client.clone();
            let ctx = ctx_rx.clone();
            tokio::spawn(async move {
                c.send_command(&ctx, "AT^HCSQ?", COMMAND_TIMEOUT, None).await
            })
        };
        tokio::time::sleep(Duration::from_millis(120)).await;
        let intruder_done = intruder.is_finished();
        assert!(!intruder_done, "事务进行中，后台命令不得插进来执行");

        // 事务第二条命令仍然正常
        client.run_in_transaction(&ctx_rx, &txn, "AT+CSCA?", COMMAND_TIMEOUT).await.unwrap();
        drop(txn);

        // 释放之后后台命令应当能执行
        let res = tokio::time::timeout(Duration::from_secs(5), intruder)
            .await
            .expect("事务释放后后台命令应被放行")
            .unwrap();
        assert!(res.is_ok(), "事务结束后后台巡检应恢复执行: {:?}", res.err());
        let _ = (svc, modem, ctx_tx);
    }

    #[tokio::test]
    async fn sms_mode_pauses_background_polling_and_releases() {
        let (tx, _rx) = tokio::sync::mpsc::channel::<crate::atclient::Unsolicited>(64);
        let client = AtClient::new(crate::config::default_config().at, tx);
        let (ctx_tx, ctx_rx) = tokio::sync::watch::channel(false);
        attach_mock_modem(client.clone(), ctx_rx.clone(), |_| Reply::ok(&[])).await;
        let mode = client.sms_mode();

        // 未开启短信模式：普通命令直接通过
        let ok = mode.wait_clear(&ctx_rx, Duration::from_millis(300), "AT^HCSQ?").await;
        assert!(ok.is_ok(), "未开启短信模式时不该拦截");

        // 开启短信模式
        let lease = mode.acquire(Duration::from_secs(60)).await;
        assert!(mode.active().await);

        // 模式内：普通命令被拦住（等满预算后返回明确错误）
        let started = std::time::Instant::now();
        let blocked = mode.wait_clear(&ctx_rx, Duration::from_millis(300), "AT^HCSQ?").await;
        assert!(blocked.is_err(), "短信模式内后台命令必须被拦下");
        assert!(started.elapsed() >= Duration::from_millis(250), "应当等待而不是立即失败");

        // 短信自己的命令不受拦截（Sms 优先级不走 wait_clear，这里验证模式语义本身）
        // 释放后恢复
        mode.release(lease).await;
        assert!(!mode.active().await, "释放后模式应解除");
        let ok2 = mode.wait_clear(&ctx_rx, Duration::from_millis(300), "AT^HCSQ?").await;
        assert!(ok2.is_ok(), "释放后后台轮询应恢复");
        let _ = ctx_tx;
    }

    #[tokio::test]
    async fn sms_mode_lease_expires_on_its_own() {
        let mode = SmsMode::new();
        let lease = mode.acquire(Duration::from_millis(150)).await;
        assert!(mode.active().await);
        tokio::time::sleep(Duration::from_millis(250)).await;
        // wait_clear 会顺带清扫过期租约：前端没发释放请求也不会让轮询永久停摆。
        let (_ctx_tx, ctx) = tokio::sync::watch::channel(false);
        let r = mode.wait_clear(&ctx, Duration::from_millis(200), "AT^HCSQ?").await;
        assert!(r.is_ok(), "租约到期后应自动解除：{:?}", r.err());
        assert!(!mode.active().await);
        let _ = lease;
    }

    #[tokio::test]
    async fn concurrent_sms_operations_are_serialized() {
        // 两个并发的短信列表请求：必须一前一后完成，不能交叠。
        let order = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c2 = counter.clone();
        let o2 = order.clone();
        let (svc, _modem, _ctx) = harness(move |cmd: &str| {
            if cmd.starts_with("AT+CMGL") {
                let n = c2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                o2.lock().unwrap().push(format!("start{n}"));
                // 人为拉长，制造交叠窗口
                std::thread::sleep(Duration::from_millis(80));
                o2.lock().unwrap().push(format!("end{n}"));
                return Reply::Lines(vec!["OK".into()]);
            }
            Reply::ok(&["+CMGF: 0"])
        })
        .await;

        let a = { let s = svc.clone(); tokio::spawn(async move { s.list().await }) };
        let b = { let s = svc.clone(); tokio::spawn(async move { s.list().await }) };
        let ra = tokio::time::timeout(Duration::from_secs(10), a).await.unwrap().unwrap();
        let rb = tokio::time::timeout(Duration::from_secs(10), b).await.unwrap().unwrap();
        assert!(ra.is_ok() && rb.is_ok(), "并发的两个列表都应完成");

        let seq = order.lock().unwrap().clone();
        assert_eq!(seq.len(), 4, "两次列表各有一对 start/end：{seq:?}");
        // 严格不交叠：start0 end0 start1 end1（或 start1 在前，取决于谁先拿到通道）
        let first = &seq[0];
        assert_eq!(seq[1], first.replace("start", "end"), "两次短信操作不得交叉执行：{seq:?}");
    }

    #[tokio::test]
    async fn delete_reports_real_result_per_index() {
        let ok_indices = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let oi = ok_indices.clone();
        let (svc, _modem, _ctx) = harness(move |cmd: &str| {
            if cmd.starts_with("AT+CMGD=") {
                let idx = cmd.trim_start_matches("AT+CMGD=").to_string();
                oi.lock().unwrap().push(idx.clone());
                // 模拟「第 3 条已不存在」的模组拒绝
                if idx == "3" {
                    return Reply::Lines(vec!["+CMS ERROR: 321".into()]);
                }
                return Reply::ok(&[]);
            }
            if cmd.starts_with("AT+CPMS?") {
                return Reply::ok(&["+CPMS: \"ME\",1,50,\"ME\",1,50,\"ME\",1,50"]);
            }
            Reply::ok(&[])
        })
        .await;

        // 前端给的顺序是乱的，且 0 号槽位是真实存在的：下发必须去重后按槽位降序。
        let r = svc.delete(vec![1, 3, 2, 3]).await.unwrap();
        assert_eq!(r.requested, 3);
        assert_eq!(r.deleted, 2, "模组明确拒绝的那条不能算成功");
        assert_eq!(r.failed, vec![3]);
        assert_eq!(*ok_indices.lock().unwrap(), vec!["3".to_string(), "2".to_string(), "1".to_string()],
            "应按槽位从大到小逐条下发，删一条挪一次位也不能碰错条目");
        assert!(r.storage.is_some(), "删除后应回读一次真实容量");
    }

    #[tokio::test]
    async fn delete_accepts_slot_zero() {
        // 实机的短信从 0 号位开始排（一张存着分段短信的卡，头两条就在 0 和 1），
        // 所以 0 不能当「序号来路不明」的哨兵被丢掉 —— 那样最老的一条永远删不掉。
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let s = seen.clone();
        let (svc, _modem, _ctx) = harness(move |cmd: &str| {
            if cmd.starts_with("AT+CMGD=") {
                s.lock().unwrap().push(cmd.trim_start_matches("AT+CMGD=").to_string());
            }
            Reply::ok(&[])
        })
        .await;

        let r = svc.delete(vec![0, 1]).await.unwrap();
        assert_eq!(r.requested, 2, "0 号槽位是一条合法删除请求");
        assert_eq!(*seen.lock().unwrap(), vec!["1".to_string(), "0".to_string()]);
    }

    #[tokio::test]
    async fn delete_rejects_empty_index_list() {
        let (svc, _modem, _ctx) = harness(|_| Reply::ok(&[])).await;
        assert!(svc.delete(vec![]).await.is_err(), "空列表不该占用一次短信事务");
    }

    #[tokio::test]
    async fn session_lifecycle_open_renew_release() {
        let (svc, _modem, _ctx) = harness(|_| Reply::ok(&[])).await;
        let id = svc.session_open(Some(60_000)).await;
        assert_eq!(svc.session_count().await, 1, "会话上线后应有 1 份租约");
        assert!(svc.session_renew(id, Some(60_000)).await, "续期应成功");
        svc.session_release(id).await;
        assert_eq!(svc.session_count().await, 0, "释放后应归零，后台轮询恢复");
        // 释放不存在的 id 是幂等的
        svc.session_release(id).await;
        assert_eq!(svc.session_count().await, 0);
    }

    #[tokio::test]
    async fn cancelled_context_does_not_hang_the_channel() {
        let (tx, _rx) = tokio::sync::mpsc::channel::<crate::atclient::Unsolicited>(64);
        let client = AtClient::new(crate::config::default_config().at, tx);
        let (ctx_tx, ctx_rx) = tokio::sync::watch::channel(false);
        attach_mock_modem(client.clone(), ctx_rx.clone(), |_| Reply::Silent).await;

        // 服务关闭（ctx 置位）时，等待中的短信命令必须立即返回，通道不被永久占住。
        let c = client.clone();
        let ctx = ctx_rx.clone();
        let handle = tokio::spawn(async move { c.send_sms_command(&ctx, "AT+CMGR=1", Duration::from_secs(3)).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let _ = ctx_tx.send(true);

        let res = tokio::time::timeout(Duration::from_secs(3), handle).await;
        assert!(res.is_ok(), "上下文取消后命令必须立即返回而不是一直占着通道");
    }

    #[test]
    fn worst_outcome_prefers_rejected_then_unknown() {
        assert_eq!(worst_outcome(SendOutcome::Accepted, SendOutcome::Unknown), SendOutcome::Unknown);
        assert_eq!(worst_outcome(SendOutcome::Unknown, SendOutcome::Rejected), SendOutcome::Rejected);
        assert_eq!(worst_outcome(SendOutcome::Accepted, SendOutcome::Accepted), SendOutcome::Accepted);
    }
}
