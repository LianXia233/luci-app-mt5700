//! 定时锁频调度器：按时段切换锁频设置，长时间无服务时自动解锁恢复。
//! 与 Go 实现（schedule.go）逻辑一致。

use chrono::Timelike;
use crate::{log_info, log_warn};
use crate::atclient::AtClient;
use crate::config::{BandLock, ScheduleConfig};
use crate::notify::{Notification, NotifyKind, Notifier, SENDER_SIGNAL};
use crate::schedconfig::{SchedStatusDto, next_switch_at, parse_hhmm, split_list};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

/// 扫频结束后留给模组重新驻留的时间，这段时间内不做无服务判定。
const SCAN_RECOVERY_GRACE: Duration = Duration::from_secs(60);

/// SSB 默认按 30kHz 子载波间隔的频段（sub-6 的 TDD 中高频段）。
const NR_30KHZ_BANDS: &[i64] = &[41, 48, 77, 78, 79];
/// 走 120kHz 的毫米波频段，其余（FDD 与低频段）按 15kHz。
const NR_MMWAVE_BANDS: &[i64] = &[257, 258, 260, 261];

#[derive(Clone, PartialEq)]
pub struct LockPair {
    pub lte: BandLock,
    pub nr: BandLock,
}

pub struct Scheduler {
    client: Arc<AtClient>,
    notifier: Arc<Notifier>,
    ctx: tokio::sync::watch::Receiver<bool>,

    state: Arc<RwLock<SchedState>>,
}

pub struct SchedState {
    pub cfg: ScheduleConfig,
    pub last_service_at: Instant,
    pub current_mode: String,
    pub switch_count: i64,
    pub last_applied: LockPair,
    pub applied: bool,
    pub announced: bool,
}

impl Scheduler {
    pub fn new(
        cfg: ScheduleConfig,
        client: Arc<AtClient>,
        notifier: Arc<Notifier>,
        ctx: tokio::sync::watch::Receiver<bool>,
    ) -> Arc<Scheduler> {
        Arc::new(Scheduler {
            client,
            notifier,
            ctx,
            state: Arc::new(RwLock::new(SchedState {
                cfg,
                last_service_at: Instant::now(),
                current_mode: String::new(),
                switch_count: 0,
                last_applied: LockPair { lte: BandLock { type_: -1, ..Default::default() }, nr: BandLock { type_: -1, ..Default::default() } },
                applied: false,
                announced: false,
            })),
        })
    }

    pub async fn config(&self) -> ScheduleConfig {
        self.state.read().await.cfg.clone()
    }

    /// 热替换配置。下一个检测周期就会按新配置判断。
    pub async fn set_config(&self, cfg: ScheduleConfig) {
        let mut s = self.state.write().await;
        s.cfg = cfg;
        s.announced = false;
    }

    pub async fn status(&self) -> SchedStatusDto {
        let s = self.state.read().await;
        SchedStatusDto {
            current_mode: s.current_mode.clone(),
            next_switch: next_switch_at(&s.cfg, chrono::Local::now()),
            switch_count: s.switch_count,
            applied: s.applied,
        }
    }

    /// 即使当前未启用也要保持轮询：用户可能在 WebUI 里随时打开开关。
    pub async fn run(self: Arc<Self>) {
        loop {
            let interval = {
                let s = self.state.read().await;
                s.cfg.check_interval
            };
            if !sleep_ctx(&self.ctx, interval).await {
                return;
            }

            self.announce().await;
            let (enabled, connected) = {
                let s = self.state.read().await;
                (s.cfg.enabled, self.client.connected())
            };
            if !enabled || !connected {
                continue;
            }

            // 扫频会独占模组几分钟，跳过本轮并把计时起点推到现在。
            if self.client.long_command_active() {
                self.state.write().await.last_service_at = Instant::now();
                continue;
            }

            self.safe_tick().await;
        }
    }

    async fn announce(&self) {
        let mut s = self.state.write().await;
        if s.announced {
            return;
        }
        s.announced = true;
        if !s.cfg.enabled {
            log_info!("定时锁频未启用");
            return;
        }
        log_info!(
            "定时锁频已启用：检测间隔 {}s，无服务超时 {}s",
            s.cfg.check_interval.as_secs(),
            s.cfg.no_service_limit.as_secs()
        );
        log_info!(
            "  夜间模式 {} ({} - {})，日间模式 {}",
            enabled_text(s.cfg.night_enabled),
            s.cfg.night_start,
            s.cfg.night_end,
            enabled_text(s.cfg.day_enabled)
        );
    }

    async fn safe_tick(&self) {
        self.tick().await;
    }

    async fn tick(&self) {
        let now = chrono::Local::now();
        let target = self.target_mode(now).await;
        let want = self.lock_for(&target).await;

        let (mode, applied, last) = {
            let s = self.state.read().await;
            (s.current_mode.clone(), s.applied, s.last_applied.clone())
        };

        if target != mode || !applied || want != last {
            let ok = if !target.is_empty() {
                log_info!("时段切换: {} -> {}", or_none(&mode), target);
                self.apply_lock(&want, &target).await
            } else if applied {
                log_info!("当前时段无需锁频，解锁所有频段");
                self.apply_lock(&unlock_config(), "解锁").await
            } else {
                true
            };
            // 仅在下发成功时标记 applied，失败留给下一周期重试
            if ok {
                let mut s = self.state.write().await;
                s.current_mode = target.clone();
                s.last_applied = want.clone();
                s.applied = true;
            } else {
                log_warn!("锁频下发失败，保持 applied=false 以便下周期重试");
            }
        }

        if self.has_service().await {
            self.state.write().await.last_service_at = Instant::now();
            return;
        }

        // 刚扫过频，跳过无服务判定。
        if self.modem_busy_recently() {
            self.state.write().await.last_service_at = Instant::now();
            return;
        }

        let down = {
            let s = self.state.read().await;
            s.last_service_at.elapsed()
        };
        let no_service_limit = {
            let s = self.state.read().await;
            s.cfg.no_service_limit
        };
        if down < no_service_limit {
            return;
        }

        // 锁频锁到了没有覆盖的小区会一直无服务，这时解锁比守着配置更重要。
        log_warn!("网络无服务已持续 {}s，解锁频段恢复", down.as_secs());
        self.apply_lock(&unlock_config(), "恢复").await;
        self.state.write().await.last_service_at = Instant::now();
    }

    fn modem_busy_recently(&self) -> bool {
        if self.client.long_command_active() {
            return true;
        }
        if let Some(end) = self.client.long_command_ended_at() {
            return end.elapsed() < SCAN_RECOVERY_GRACE;
        }
        false
    }

    /// 当前时刻应该使用的模式，"" 表示不锁频。
    async fn target_mode(&self, now: chrono::DateTime<chrono::Local>) -> String {
        let s = self.state.read().await;
        let night = is_night(&s.cfg, now);
        match (night && s.cfg.night_enabled, !night && s.cfg.day_enabled) {
            (true, _) => "夜间".into(),
            (_, true) => "日间".into(),
            _ => String::new(),
        }
    }

    async fn lock_for(&self, mode: &str) -> LockPair {
        let s = self.state.read().await;
        match mode {
            "夜间" => LockPair { lte: s.cfg.night_lte.clone(), nr: s.cfg.night_nr.clone() },
            "日间" => LockPair { lte: s.cfg.day_lte.clone(), nr: s.cfg.day_nr.clone() },
            _ => unlock_config(),
        }
    }

    /// 通过注册状态判断是否有网络服务。C5GREG 覆盖 SA，CEREG 覆盖 LTE/NSA，CREG 兜底。
    async fn has_service(&self) -> bool {
        for cmd in ["AT+C5GREG?", "AT+CEREG?", "AT+CREG?"] {
            if let Ok(resp) = self.client.send_command(&self.ctx, cmd, crate::atclient::COMMAND_TIMEOUT, None).await {
                if registered(&resp.text()) {
                    return true;
                }
            }
        }
        false
    }

    /// 下发一次完整的锁频切换。返回是否成功（全部实际下发的锁频命令均 OK）。
    async fn apply_lock(&self, cfg: &LockPair, mode: &str) -> bool {
        let switch_count = {
            let mut s = self.state.write().await;
            s.switch_count += 1;
            s.switch_count
        };
        let sched = self.state.read().await.cfg.clone();
        log_info!("开始切换到{mode}锁频设置 (第 {switch_count} 次)");

        let mut done: Vec<String> = Vec::new();
        let mut lock_ok = true;
        let mut lock_attempts = 0usize;

        if sched.toggle_airplane {
            match self.client.send_command(&self.ctx, "AT+CFUN=0", crate::atclient::COMMAND_TIMEOUT, None).await {
                Ok(r) if r.ok() => {
                    log_info!("已进入飞行模式");
                    if !sleep_ctx(&self.ctx, Duration::from_secs(2)).await {
                        return false;
                    }
                }
                _ => log_warn!("进入飞行模式失败"),
            }
        }

        if let Some((cmd, action)) = self.lte_command(&cfg.lte).await {
            lock_attempts += 1;
            if self.run_lock_command(&cmd, &action).await {
                done.push(action);
            } else {
                lock_ok = false;
            }
            if !sleep_ctx(&self.ctx, Duration::from_secs(1)).await {
                return false;
            }
        }

        if let Some((cmd, action)) = self.nr_command(&cfg.nr).await {
            lock_attempts += 1;
            if self.run_lock_command(&cmd, &action).await {
                done.push(action);
            } else {
                lock_ok = false;
            }
            if !sleep_ctx(&self.ctx, Duration::from_secs(1)).await {
                return false;
            }
        }

        if sched.toggle_airplane {
            match self.client.send_command(&self.ctx, "AT+CFUN=1", crate::atclient::COMMAND_TIMEOUT, None).await {
                Ok(r) if r.ok() => {
                    log_info!("已退出飞行模式");
                    done.push("切飞行模式".into());
                }
                _ => log_warn!("退出飞行模式失败"),
            }
            if !sleep_ctx(&self.ctx, Duration::from_secs(3)).await {
                return false;
            }
        }

        // 一条锁频命令都未下发（如 type=3 且 bands 为空）视为失败，避免空操作被标成 applied
        if lock_attempts == 0 {
            log_warn!("未生成任何锁频命令（配置可能为空），视为下发失败");
            lock_ok = false;
        }

        let actions = if done.is_empty() { "未执行任何操作".to_string() } else { done.join("、") };
        let notifier = self.notifier.clone();
        let content = format!(
            "🔄 定时锁频切换\n时间: {}\n模式: {}\nLTE: {}\nNR: {}\n执行操作: {}\n切换次数: 第 {} 次\n结果: {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            mode,
            lock_summary("LTE", &cfg.lte),
            lock_summary("NR", &cfg.nr),
            actions,
            switch_count,
            if lock_ok { "成功" } else { "失败" }
        );
        tokio::spawn(async move {
            notifier
                .notify(Notification { sender: SENDER_SIGNAL.into(), content, kind: NotifyKind::Signal, memory_full: false })
                .await;
        });
        log_info!("定时锁频切换完成: {}（{}）", actions, if lock_ok { "成功" } else { "失败" });
        lock_ok
    }

    async fn run_lock_command(&self, cmd: &str, action: &str) -> bool {
        log_info!("下发 {}: {}", action, cmd);
        match self.client.send_command(&self.ctx, cmd, crate::atclient::COMMAND_TIMEOUT, None).await {
            Ok(r) if r.ok() => {
                log_info!("{} 成功", action);
                true
            }
            Ok(r) => {
                log_warn!("{} 失败: {}", action, r.text());
                false
            }
            Err(e) => {
                log_warn!("{} 失败: {}", action, e);
                false
            }
        }
    }

    async fn lte_command(&self, l: &BandLock) -> Option<(String, String)> {
        let sched = self.state.read().await.cfg.clone();
        if l.type_ <= 0 {
            if !sched.unlock_lte {
                return None;
            }
            return Some(("AT^LTEFREQLOCK=0".into(), "LTE解锁".into()));
        }

        let bands = split_list(&l.bands);
        if bands.is_empty() {
            return None;
        }

        match l.type_ {
            3 => Some((
                format!("AT^LTEFREQLOCK=3,0,{},\"{}\"", bands.len(), bands.join(",")),
                format!("LTE锁频(类型{})", l.type_),
            )),
            1 | 2 => {
                let arfcns = split_list(&l.arfcns);
                if arfcns.len() != bands.len() {
                    log_warn!("LTE 锁频：频段与频点数量不一致({}/{})，改为解锁", bands.len(), arfcns.len());
                    return Some(("AT^LTEFREQLOCK=0".into(), "LTE解锁".into()));
                }
                if !validate_pairs(&bands, &arfcns, crate::schedconfig::lte_band_arfcn(), "LTE") {
                    return Some(("AT^LTEFREQLOCK=0".into(), "LTE解锁".into()));
                }
                if l.type_ == 1 {
                    return Some((
                        format!("AT^LTEFREQLOCK=1,0,{},\"{}\",\"{}\"", bands.len(), bands.join(","), arfcns.join(",")),
                        "LTE锁频(类型1)".into(),
                    ));
                }
                let pcis = split_list(&l.pcis);
                if pcis.len() != bands.len() {
                    log_warn!("LTE 小区锁定：PCI 数量与频段不一致({}/{})，改为解锁", bands.len(), pcis.len());
                    return Some(("AT^LTEFREQLOCK=0".into(), "LTE解锁".into()));
                }
                Some((
                    format!("AT^LTEFREQLOCK=2,0,{},\"{}\",\"{}\",\"{}\"", bands.len(), bands.join(","), arfcns.join(","), pcis.join(",")),
                    "LTE锁频(类型2)".into(),
                ))
            }
            _ => Some(("AT^LTEFREQLOCK=0".into(), "LTE解锁".into())),
        }
    }

    async fn nr_command(&self, l: &BandLock) -> Option<(String, String)> {
        let sched = self.state.read().await.cfg.clone();
        if l.type_ <= 0 {
            if !sched.unlock_nr {
                return None;
            }
            return Some(("AT^NRFREQLOCK=0".into(), "NR解锁".into()));
        }

        let bands = split_list(&l.bands);
        if bands.is_empty() {
            return None;
        }

        match l.type_ {
            3 => Some((
                format!("AT^NRFREQLOCK=3,0,{},\"{}\"", bands.len(), bands.join(",")),
                format!("NR锁频(类型{})", l.type_),
            )),
            1 | 2 => {
                let arfcns = split_list(&l.arfcns);
                if arfcns.len() != bands.len() {
                    log_warn!("NR 锁频：频段与频点数量不一致({}/{})，改为解锁", bands.len(), arfcns.len());
                    return Some(("AT^NRFREQLOCK=0".into(), "NR解锁".into()));
                }
                let mut scs = split_list(&l.scs_types);
                if scs.is_empty() {
                    scs = auto_detect_scs(&bands);
                }
                if scs.len() != bands.len() {
                    log_warn!("NR 锁频：SCS 数量与频段不一致({}/{})，改为解锁", bands.len(), scs.len());
                    return Some(("AT^NRFREQLOCK=0".into(), "NR解锁".into()));
                }
                if !validate_pairs(&bands, &arfcns, crate::schedconfig::nr_band_arfcn(), "NR") {
                    return Some(("AT^NRFREQLOCK=0".into(), "NR解锁".into()));
                }
                if l.type_ == 1 {
                    return Some((
                        format!("AT^NRFREQLOCK=1,0,{},\"{}\",\"{}\",\"{}\"", bands.len(), bands.join(","), arfcns.join(","), scs.join(",")),
                        "NR锁频(类型1)".into(),
                    ));
                }
                let pcis = split_list(&l.pcis);
                if pcis.len() != bands.len() {
                    log_warn!("NR 小区锁定：PCI 数量与频段不一致({}/{})，改为解锁", bands.len(), pcis.len());
                    return Some(("AT^NRFREQLOCK=0".into(), "NR解锁".into()));
                }
                Some((
                    format!(
                        "AT^NRFREQLOCK=2,0,{},\"{}\",\"{}\",\"{}\",\"{}\"",
                        bands.len(),
                        bands.join(","),
                        arfcns.join(","),
                        scs.join(","),
                        pcis.join(",")
                    ),
                    "NR锁频(类型2)".into(),
                ))
            }
            _ => Some(("AT^NRFREQLOCK=0".into(), "NR解锁".into())),
        }
    }
}

fn enabled_text(b: bool) -> &'static str {
    if b {
        "启用"
    } else {
        "禁用"
    }
}

fn or_none(s: &str) -> &str {
    if s.is_empty() {
        "无"
    } else {
        s
    }
}

fn unlock_config() -> LockPair {
    LockPair { lte: BandLock { type_: 0, ..Default::default() }, nr: BandLock { type_: 0, ..Default::default() } }
}

fn is_night(cfg: &ScheduleConfig, now: chrono::DateTime<chrono::Local>) -> bool {
    let (Some(start), Some(end)) = (parse_hhmm(&cfg.night_start), parse_hhmm(&cfg.night_end)) else {
        log_warn!("夜间时段配置无法解析: {:?}-{:?}", cfg.night_start, cfg.night_end);
        return false;
    };
    let cur = now.hour() as i64 * 60 + now.minute() as i64;
    if start > end {
        // 跨零点，例如 22:00-06:00
        cur >= start || cur < end
    } else {
        cur >= start && cur < end
    }
}

/// 匹配 +CREG/+CGREG/+CEREG/+C5GREG 的查询应答。
/// 按 3GPP 27.007，查询应答是 "+CxREG: <n>,<stat>[,...]"，<stat> 为 1=已注册本地网络，5=已注册漫游网络。
fn registered(text: &str) -> bool {
    let mut rest = text;
    while let Some(rel) = rest.find("REG:") {
        let after = &rest[rel + 4..];
        // 跳过空白后读第一个整数 <n>
        let after = after.trim_start();
        let n_len = after.chars().take_while(|c| c.is_ascii_digit()).count();
        if n_len == 0 {
            rest = after;
            continue;
        }
        let after_n = &after[n_len..];
        if let Some(comma) = after_n.find(',') {
            let stat_part = after_n[comma + 1..].trim_start();
            let stat_digits: String = stat_part.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(v) = stat_digits.parse::<u32>() {
                if v == 1 || v == 5 {
                    return true;
                }
            }
        }
        rest = after;
    }
    false
}

fn validate_pairs(bands: &[String], arfcns: &[String], table: &std::collections::HashMap<i64, (i64, i64)>, kind: &str) -> bool {
    for (i, band_s) in bands.iter().enumerate() {
        let band: i64 = match band_s.parse() {
            Ok(b) => b,
            Err(_) => {
                log_warn!("{} 锁频参数不是数字: 频段 {:?}", kind, band_s);
                return false;
            }
        };
        // ARFCN 按 64 位解析：配置校验允许到 4294967295。
        let arfcn: i64 = match arfcns[i].parse() {
            Ok(a) => a,
            Err(_) => {
                log_warn!("{} 锁频参数不是数字: 频点 {:?}", kind, arfcns[i]);
                return false;
            }
        };
        if let Some((lo, hi)) = table.get(&band) {
            if arfcn < *lo || arfcn > *hi {
                log_warn!("{} 频段 {} 与频点 {} 不匹配(应在 {}-{})", kind, band, arfcn, lo, hi);
                return false;
            }
        }
    }
    true
}

/// 未显式配置时按频段推断 SSB 的子载波间隔类型。
/// 取值含义：0=15kHz 1=30kHz 3=120kHz。
fn auto_detect_scs(bands: &[String]) -> Vec<String> {
    bands
        .iter()
        .map(|b| match b.parse::<i64>() {
            Err(_) => "1".to_string(),
            Ok(band) if NR_MMWAVE_BANDS.contains(&band) => "3".to_string(),
            Ok(band) if NR_30KHZ_BANDS.contains(&band) => "1".to_string(),
            Ok(_) => "0".to_string(),
        })
        .collect()
}

fn lock_summary(kind: &str, l: &BandLock) -> String {
    if l.type_ > 0 && !l.bands.trim().is_empty() {
        format!("{}类型{}", kind, l.type_)
    } else {
        format!("{}解锁", kind)
    }
}

async fn sleep_ctx(ctx: &tokio::sync::watch::Receiver<bool>, d: Duration) -> bool {
    let mut ctx_c = ctx.clone();
    tokio::select! {
        _ = tokio::time::sleep(d) => true,
        _ = ctx_c.changed() => false,
    }
}
