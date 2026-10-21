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

use crate::at_queue::SmsMode;
use crate::atclient::{AtClient, SMS_LIST_TIMEOUT, SMS_SUBMIT_TIMEOUT};
use crate::log_info;
use crate::log_warn;
use crate::pdu::{PartialInfo, SubmitOptions, build_submit_parts, parse_cmgl_response};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
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
pub const SMS_MODE_LEASE: Duration = Duration::from_secs(90);

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
    pub index: u32,
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
    pub storage: Option<StorageInfo>,
}

/// 短信功能开关的执行结果。
#[derive(Debug, Clone)]
pub struct PowerResult {
    pub enabled: bool,
    pub steps_done: Vec<String>,
    /// 失败在哪一步（成功时为 None）。
    pub failed_at: Option<String>,
    pub smsc: String,
    pub storage: Option<StorageInfo>,
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
        })
    }

    /// 存储满标志：被模组告知 MEMORY FULL 后置位，容量回落到未满时清除。
    pub fn memory_full(&self) -> bool {
        self.mem_full.load(Ordering::Relaxed)
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
        let _ = self
            .client
            .run_in_transaction(&self.ctx, &tx, "AT+CMGF?", crate::atclient::COMMAND_TIMEOUT)
            .await;
        let mut mode = false;
        if let Ok(resp) = self
            .client
            .run_in_transaction(&self.ctx, &tx, "AT+CMGF?", crate::atclient::COMMAND_TIMEOUT)
            .await
        {
            mode = resp.contains("+CMGF: 0");
        }
        if !mode {
            let _ = self
                .client
                .run_in_transaction(&self.ctx, &tx, "AT+CMGF=0", crate::atclient::COMMAND_TIMEOUT)
                .await;
        }

        let resp = self
            .client
            .run_in_transaction(&self.ctx, &tx, "AT+CMGL=4", SMS_LIST_TIMEOUT)
            .await?;
        drop(tx);

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
            if let Err(e) = self
                .client
                .run_in_transaction(&self.ctx, &tx, "AT+CMGF=0", crate::atclient::COMMAND_TIMEOUT)
                .await
            {
                        return Err(format!("切换到 PDU 模式失败: {e}"));
            }
        }

        // 2) 短信中心号码：请求没给就读模组。
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

        // 4) 逐片提交。一次写完整条 `AT+CMGS=<长度>\r<PDU>`（尾部 \r 由底层补），
        //    不使用会经过多层转义的 0x1A。失败点在片内，立即停下，不继续也不重试。
        let mut parts = Vec::with_capacity(plan.parts.len());
        let mut outcome = SendOutcome::Accepted;
        let mut message_out = String::new();
        let deadline = Instant::now() + self.total_budget;

        for part in &plan.parts {
            let command = format!("AT+CMGS={}\r{}", part.tpdu_length, part.pdu);
            // 单段预算 = min(单段上限, 事务剩余额度)。剩余额度为 0 时给最小预算，
            // 让模组还有一次机会回话（此时判 Unknown 而不是 Accepted）。
            let remain = deadline.saturating_duration_since(Instant::now());
            let part_timeout = self.submit_timeout.min(remain).max(Duration::from_millis(500));
            let res = self
                .client
                .run_in_transaction(&self.ctx, &tx, &command, part_timeout)
                .await;
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
        }

        Ok(SendResult {
            outcome,
            encoding: plan.encoding.name().into(),
            parts,
            storage,
            message: message_out,
        })
    }

    /// 删除若干条短信。逐个下发 `AT+CMGD=<index>`，同一事务内完成。
    ///
    /// 索引来自上一次 `list` 的真实返回；删除后重新读一次容量，
    /// 让界面显示的用量与模组当前状态一致。
    pub async fn delete(&self, indices: Vec<u32>) -> Result<DeleteResult, String> {
        if indices.is_empty() {
            return Err("没有要删除的短信".into());
        }
        // 去重并保持顺序 —— 前端批量删除可能把同一条传进来多次。
        let mut ordered: Vec<u32> = Vec::new();
        for i in indices {
            if i == 0 || ordered.contains(&i) {
                continue;
            }
            ordered.push(i);
        }
        if ordered.is_empty() {
            return Err("没有合法的短信序号".into());
        }

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
            storage,
        })
    }

    /// 清空全部短信：按当前实际存在的存储区逐个 `AT+CMGD=1,4`。
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
            mems = vec!["SM".into(), "ME".into(), "MT".into()];
        }

        let failed: Vec<u32> = Vec::new();
        let mut deleted = 0usize;
        for mem in &mems {
            if !is_safe_mem_name(mem) {
                continue;
            }
            let set = format!(r#"AT+CPMS="{mem}","{mem}","{mem}""#);
            if self
                .client
                .run_in_transaction(&self.ctx, &tx, &set, crate::atclient::COMMAND_TIMEOUT)
                .await
                .map(|r| r.ok())
                .unwrap_or(false)
            {
                match self
                    .client
                    .run_in_transaction(&self.ctx, &tx, "AT+CMGD=1,4", SMS_LIST_TIMEOUT)
                    .await
                {
                    Ok(resp) if resp.ok() => deleted += 1,
                    other => {
                        log_warn!("清空存储区 {mem} 未完成：{:?}", other.map(|r| last_line(&r.text())));
                    }
                }
            }
        }

        let storage = self.read_storage_in_tx(&tx).await.ok();
        drop(tx);
        Ok(DeleteResult { requested: mems.len(), deleted, failed, storage })
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
    pub async fn set_storage(&self, mem: &str) -> Result<StorageInfo, String> {
        if !is_safe_mem_name(mem) {
            return Err("不支持的存储区名称".into());
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
        info
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
    pub async fn set_smsc(&self, number: &str) -> Result<String, String> {
        let cleaned: String = number.trim().chars().filter(|c| c.is_ascii_digit() || *c == '+').collect();
        if cleaned.len() < 3 || cleaned.len() > 20 {
            return Err("短信中心号码格式不正确".into());
        }
        let tx = self
            .client
            .open_sms_transaction(&self.ctx, "sms.set_smsc", SMS_QUEUE_WAIT)
            .await?;
        self.client
            .run_in_transaction(
                &self.ctx,
                &tx,
                &format!(r#"AT+CSCA="{cleaned}""#),
                crate::atclient::COMMAND_TIMEOUT,
            )
            .await?;
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
    /// 这是**典型的多步骤操作**：CEUS → IMSSWITCH → CFUN → CGDCONT → CSCA，
    /// 中间还有模组自己的处理间隔。过去它在前端连发五条各自排队的命令，
    /// 后台巡检随时会从中间插进来，把「射频刚被拉起来」的状态打断，
    /// 结果是短信开关看着勾上了、实际没生效。现在整串在一次事务里跑完。
    pub async fn power_set(&self, enable: bool, smsc: Option<String>) -> Result<PowerResult, String> {
        let tx = self
            .client
            .open_sms_transaction(&self.ctx, "sms.power", SMS_QUEUE_WAIT)
            .await?;

        let mut steps: Vec<(String, u64, &'static str)> = if enable {
            vec![
                ("AT+CEUS=1".into(), 1000, "开启 CEUS"),
                ("AT^IMSSWITCH=1,0,0".into(), 2000, "开启 IMS"),
                ("AT+CFUN=1".into(), 2000, "恢复射频"),
                (
                    r#"AT+CGDCONT=5,"IPV4V6","","",0,0,0,0,1,1,1,,,,,,0,,0,0,0,0"#.into(),
                    1000,
                    "配置数据承载",
                ),
            ]
        } else {
            vec![
                ("AT+CEUS=0".into(), 500, "关闭 CEUS"),
                ("AT^IMSSWITCH=0,0,0".into(), 500, "关闭 IMS"),
                ("AT+CFUN=0".into(), 500, "关闭射频"),
            ]
        };
        if enable {
            if let Some(sc) = smsc.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                steps.push((format!(r#"AT+CSCA="{sc}""#), 0, "配置短信中心号码"));
            }
        } else {
            steps.push(("AT+CMGD=1,4".into(), 0, "清空短信"));
        }

        let mut done: Vec<String> = Vec::new();
        let mut failed_at: Option<String> = None;
        for (cmd, gap_ms, label) in steps {
            match self
                .client
                .run_in_transaction(&self.ctx, &tx, &cmd, crate::atclient::COMMAND_TIMEOUT)
                .await
            {
                Ok(resp) if resp.ok() && !resp.has_error() => {
                    done.push(label.to_string());
                }
                Ok(resp) => {
                    log_warn!("短信开关步骤「{}」未返回 OK：{}", label, last_line(&resp.text()));
                    failed_at = Some(label.to_string());
                    break;
                }
                Err(e) => {
                    log_warn!("短信开关步骤「{}」失败：{}", label, e);
                    failed_at = Some(label.to_string());
                    break;
                }
            }
            if gap_ms > 0 {
                // 事务持有通道期间 sleep：模组需要时间消化上一步，
                // 这段间隔里也不允许其它命令插进来（这正是事务的意义）。
                tokio::time::sleep(Duration::from_millis(gap_ms)).await;
            }
        }

        // 结束后读一次真实状态，供界面回显（仍然是无缓存的实时读数）。
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

        Ok(PowerResult { enabled: failed_at.is_none() && enable, steps_done: done, failed_at, smsc: smsc_now, storage })
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
/// 形如 `+CPMS: "ME",3,50,"ME",3,50,"ME",3,50`：每三段一组，依次是区名、已用、容量。
fn parse_storage(lines: &[String]) -> Option<StorageInfo> {
    for line in lines {
        let line = line.trim();
        let body = line
            .strip_prefix("+CPMS:")
            .or_else(|| line.strip_prefix("^CPMS:"))?;
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

fn is_safe_mem_name(mem: &str) -> bool {
    matches!(mem, "SM" | "ME" | "MT" | "SR" | "BM" | "TA")
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

fn last_line(text: &str) -> String {
    text.lines().last().unwrap_or("").trim().to_string()
}

/// 把一次 `AT+CMGS` 的结果归类为「已确认 / 明确拒绝 / 结果不明」。
///
/// 判定依据是**模组真正的回执**，不是 Ctrl+Z 也不是输入提示符：
///   - 应答里出现 `+CMGS` （或单独的 OK）→ 模组确认识别并提交；
///   - 出现 `+CMS ERROR` / `+CME ERROR` / `ERROR` → 明确拒绝；
///   - 超时 / 模组无响应 → Unknown。
///
/// 只看到 `> ` 提示符的情况不会走到这里：单次提交时 pending 会等到真正的结束码，
/// 见 `PendingCmd::ignore_prompt`。
fn classify_cmgs_result(res: &Result<crate::atclient::AtResponse, String>) -> (SendOutcome, String) {
    match res {
        Err(e) => (SendOutcome::Unknown, e.clone()),
        Ok(resp) => {
            let text = resp.text();
            if text.contains("+CMGS") {
                (SendOutcome::Accepted, text)
            } else if text.contains("+CMS ERROR:") || text.contains("+CME ERROR:") || resp.has_error() {
                (SendOutcome::Rejected, text)
            } else if resp.ok() {
                (SendOutcome::Accepted, text)
            } else {
                (SendOutcome::Unknown, format!("模组未给出提交确认（应答：{}）", first_line_capped(&text)))
            }
        }
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
        assert_eq!(first.entries[0].index, 1);

        let second = svc.list().await.unwrap();
        assert_eq!(second.entries.len(), 0, "第二次必须是模组的真实状态（空），不能返回上一次的快照");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2, "每次 list 都应真的下发 AT+CMGL");
    }

    #[tokio::test]
    async fn send_accepted_requires_cmgs_reference() {
        let (svc, modem, _ctx) = harness(script(vec![
            ("AT+CMGF?", Reply::Lines(vec!["+CMGF: 0".into(), "OK".into()])),
            ("AT+CSCA?", Reply::Lines(vec!["+CSCA: \"+8613800755500\",145".into(), "OK".into()])),
            ("AT+CMGS=", Reply::Prompt),
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

        // 字节级：整条 `AT+CMGS=<长度>\r<PDU>` 必须一次写入，且没有 0x1A 被改写成字面量。
        let stream = modem.stream();
        let text = String::from_utf8_lossy(&stream).to_string();
        assert!(text.contains("AT+CMGS="), "应下发 AT+CMGS：{text}");
        assert!(!stream.contains(&0x1A), "单次提交不含 Ctrl-Z 字节");
        assert!(!text.contains("\\u001a"), "不应出现被转义成字面量的 0x1A");
        assert!(!text.contains("\\x1a"), "不应出现被转义成字面量的 0x1A");
        // 命令串里必须含真实的 CR（0x0D），而不是反斜杠+r 两个字符
        let cmgs_pos = text.find("AT+CMGS=").unwrap();
        assert!(stream[cmgs_pos..].contains(&0x0D), "长度与 PDU 之间必须是真实 CR");
        assert!(!text[cmgs_pos..].contains("\\r"), "CR 不能被转义成字面量 \\r");
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
    async fn duplicate_click_is_deduped() {
        let submits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let submits2 = submits.clone();
        let (svc, _modem, _ctx) = harness(move |cmd: &str| {
            if cmd.starts_with("AT+CMGS=") {
                submits2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                return Reply::Prompt;
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
            ("AT+CMGS=", Reply::Prompt),
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

        let r = svc.delete(vec![1, 2, 3]).await.unwrap();
        assert_eq!(r.requested, 3);
        assert_eq!(r.deleted, 2, "模组明确拒绝的那条不能算成功");
        assert_eq!(r.failed, vec![3]);
        assert_eq!(*ok_indices.lock().unwrap(), vec!["1".to_string(), "2".to_string(), "3".to_string()],
            "应按顺序逐条下发");
        assert!(r.storage.is_some(), "删除后应回读一次真实容量");
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
