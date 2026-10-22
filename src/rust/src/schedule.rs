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
/// 因「无服务」自动解锁后，重新尝试用户锁频配置前的等待时间下限。
///
/// 实际冷却取本值与用户配置的 `no_service_limit` 中较大的一个。
const LOCK_RETRY_COOLDOWN: Duration = Duration::from_secs(300);
/// 一轮 `has_service` 的总预算，详见该函数内的说明。
const HAS_SERVICE_BUDGET: Duration = Duration::from_secs(6);

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
    /// 上一次锁频下发是否失败。
    ///
    /// 下发失败时 `applied` 会保持 false，于是**每个**检测周期都会重试一次。
    /// 若每次重试都推一条通知（并往通知日志追加一条），配置有误时就是
    /// 每 `check_interval` 一条——日志落在 tmpfs 上会持续膨胀。
    /// 用它把通知收敛成「只在失败状态翻转时推一条」。
    pub apply_failed: bool,
    /// 因「无服务」自动解锁后的重试冷却截止时刻。
    ///
    /// 非空表示：在这个时刻之前**不主动下发任何锁频命令**，把频段完全交还给模组
    /// 自行搜网。没有这道闸门就会锁→解锁→锁地反复震荡，而每次重锁都还会带上
    /// 一轮飞行模式开关（CFUN=0/1）。详见 `tick()` 的解锁分支。
    pub retry_after: Option<Instant>,
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
                apply_failed: false,
                retry_after: None,
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
        /*
         * 用户主动改配置就立刻撤销「无服务解锁」的冷却。
         * 冷却防的是本模块自己反复重试造成的震荡；用户既然重新下了指令，
         * 就该马上按新配置下发一次，而不是让他干等几分钟才看到效果。
         */
        s.retry_after = None;
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
                // 断连期间也要推进「最近有服务」的计时起点。
                // 否则掉线几小时后的重连第一拍，`down` 会是整段断线时长，
                // 而此刻模组往往还没注册完，会被下面的「无服务超时」分支
                // 当成锁频锁死，直接把用户配置的锁频擦掉。
                self.state.write().await.last_service_at = Instant::now();
                continue;
            }

            // 扫频会独占模组几分钟，跳过本轮并把计时起点推到现在。
            if self.client.long_command_active() {
                self.state.write().await.last_service_at = Instant::now();
                continue;
            }

            /*
             * ★ 这里**没有** panic 保护 —— 此前中间隔着一层 `safe_tick()`，名字听着
             *   像有，实际只是 `self.tick().await` 的转发（2026-09-28 把这层删掉了：
             *   它既是 Middle Man，又用 `safe_` 前缀给出了与实际相反的暗示）。
             *
             *   真实后果要说清：本 crate 的 release 是 `panic = "abort"`，panic **不
             *   unwinding**，所以进程内**根本不可能**用 catch_unwind 之类兜住它 ——
             *   tick 里任何一处 panic 都是**整个进程消失**（随后由 procd 重新拉起），
             *   而不是"只有这个任务停了"。名字与实际的这种错位，比没有保护更危险：
             *   它会让人以为已经兜住了，从而不再去消除真正的 panic 源。
             */
            self.tick().await;
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

    /*
     * ★ 2026-09-19 会审：与 urc.rs 的 safe_handle 同一口径 —— 这里**不捕获 panic**。
     * profile.release 是 `panic = "abort"`，panic 不会 unwind 而是直接终止进程，
     * 所以 catch_unwind 在这里无效。要保证的是 tick() 内部不 panic（不裸索引、
     * 不做 unwrap 于外部数据），而不是在外面套一层捕获。
     */
    async fn tick(&self) {
        let now = chrono::Local::now();
        let target = self.target_mode(now).await;
        let want = self.lock_for(&target).await;

        let (mode, applied, last) = {
            let s = self.state.read().await;
            (s.current_mode.clone(), s.applied, s.last_applied.clone())
        };

        /*
         * 冷却期内不下发任何锁频命令。
         *
         * 冷却只在「因无服务自动解锁」之后设置：那时 applied 被置回 false，
         * 而这正是下一周期的触发条件之一，于是会变成
         * 「解锁 → 下一拍立刻重锁 → 又无服务 → 再等 no_service_limit → 再解锁」
         * 的震荡；若用户开了 toggle_airplane，每一轮还要多做一次 CFUN=0/1，
         * 射频被反复开关。冷却期内把频段交还模组自行搜网，到点后再试一次
         * 用户配置 —— 万一只是临时故障，也还有机会自己恢复。
         */
        let cooling_down = {
            let s = self.state.read().await;
            s.retry_after.is_some_and(|until| Instant::now() < until)
        };

        if !cooling_down && (target != mode || !applied || want != last) {
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
        {
            let mut s = self.state.write().await;
            s.last_service_at = Instant::now();
            // ★ 模组已被解锁，内存状态必须跟着变。
            // 否则下一周期 tick 的「target != mode || !applied || want != last」
            // 三个条件全部不成立，于是不再下发任何命令 —— 用户配置的锁频
            // 在本次时段内就永久失效了，而 status() 仍对外报 applied=true，
            // 界面显示与实际完全相反，要等到下一次时段切换才自愈。
            s.applied = false;
            /*
             * ★ 光把 applied 置回 false 还不够 —— 它同时就是下一周期的重锁触发
             * 条件。必须再上冷却，让模组先自由搜网注册，否则就是锁→解锁→锁的
             * 震荡（每轮还带一次飞行模式开关）。冷却取「用户容忍的无服务时长」
             * 与 5 分钟中较大的一个：前者尊重配置，后者是搜网注册的合理下限。
             */
            s.retry_after = Some(Instant::now() + LOCK_RETRY_COOLDOWN.max(s.cfg.no_service_limit));
        }
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
        /*
         * 三条查询共用一个总预算。
         *
         * 每条最坏「排队 8s + 等应答 2s」，三条串行能到 30s —— 已经接近甚至超过
         * no_service_limit 本身。而这个查询的返回值是用来推进 last_service_at 的：
         * 它自己耗掉的时间会被算进「无服务已持续」，于是越查越像无服务，
         * 最终把用户配的锁频当成「锁死」给擦掉。
         *
         * 6 秒 = 三条各 2 秒，正常一轮远用不完（C5GREG 通常第一条就命中），
         * 只在通道拥堵时才兜底。预算用完仍查不到就当作无服务，下一周期再试。
         */
        let probe = async {
            for cmd in ["AT+C5GREG?", "AT+CEREG?", "AT+CREG?"] {
                if let Ok(resp) = self
                    .client
                    .send_command(&self.ctx, cmd, crate::atclient::COMMAND_TIMEOUT, None)
                    .await
                {
                    if registered(&resp.text()) {
                        return true;
                    }
                }
            }
            false
        };

        match tokio::time::timeout(HAS_SERVICE_BUDGET, probe).await {
            Ok(v) => v,
            Err(_) => {
                log_warn!(
                    "注册状态查询超出 {}s 预算，本轮按无服务处理",
                    HAS_SERVICE_BUDGET.as_secs()
                );
                false
            }
        }
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
                _ => {
                    // 进入飞行模式失败仍继续下发锁频命令（模组此刻是全功能态，
                    // 部分锁频命令依然能生效），但本次必须记为失败：
                    // 否则若后续命令恰好全 OK，就会把「没按预期切飞行模式」
                    // 记成一次成功切换，用户永远看不到异常。
                    log_warn!("进入飞行模式失败，本次切换记为失败");
                    lock_ok = false;
                }
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
                _ => {
                    // 必须记为失败：模组停在 CFUN=0 就是「完全离线」，
                    // 而 applied=true 会让调度器认为已下发成功、永不再试，
                    // 设备就会一直没信号直到人为重启。
                    log_warn!("退出飞行模式失败，模组可能停在飞行模式");
                    lock_ok = false;
                }
            }
            if !sleep_ctx(&self.ctx, Duration::from_secs(3)).await {
                return false;
            }
        }

        // 一条锁频命令都未下发时，要区分两种成因：
        //  (a) 用户关闭了 unlock_lte / unlock_nr，本次切换本就「什么都不该下发」——正常；
        //  (b) 配置有误（如 type=3 但 bands 为空），命令生成不出来——必须判失败好重试。
        // 原先不区分，(a) 会被判成失败：模组保持旧锁频不动，且 applied 始终为 false，
        // 于是每个 check_interval 重放一次空切换，日志被反复污染。
        let expected = [cfg.lte.type_ > 0, cfg.nr.type_ > 0]
            .iter()
            .filter(|&&v| v)
            .count();
        if lock_attempts == 0 && expected > 0 {
            log_warn!("未生成任何锁频命令（配置可能为空），视为下发失败");
            lock_ok = false;
        }

        let actions = if done.is_empty() { "未执行任何操作".to_string() } else { done.join("、") };

        // 通知只在「状态翻转」时推一条。
        // 下发失败后 applied 保持 false，下一周期必然重试；若每次重试都推一条
        // 通知并往通知日志里追加一条，配置有误（如 type=3 但 bands 为空）时就是
        // 每 check_interval 一条——日志在 tmpfs 上会持续膨胀，推送也会被刷屏。
        // 于是：成功→总推；失败→只在「首次失败」时推，连续失败期间保持静默。
        let mut s = self.state.write().await;
        let should_notify = lock_ok || !s.apply_failed;
        s.apply_failed = !lock_ok;
        drop(s);

        if !should_notify {
            log_warn!("锁频下发仍失败，处于连续失败状态，本周期不再推送通知");
            return lock_ok;
        }

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
        // 整条路径只在这一处记录结果。
        // ★ 2026-09-28：此前这里**前面还有一条一模一样的 log_info!**，于是正常路径下
        //   每次切换都会打两条完全相同的「定时锁频切换完成: …」；而上面那个
        //   「连续失败则静默」的分支又有自己的 log_warn，所以删掉前面那条不会丢信息。
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

/// 校验「频段 ↔ 频点」是否都落在该频段的合法频点范围内。
///
/// ★ 前置不变量：`bands` 与 `arfcns` **必须等长** —— 本函数按同一下标同步索引两者。
///   两个调用方（`lte_command` / `nr_command`）都在调用之前做了 `len()` 比较并提前返回
///   "改为解锁"，所以实际上从来不会越界。**但那是调用方的检查，没有写进这个接口**：
///   签名只说了"两个字符串数组"，任何将来新增的调用点只要漏掉那一步，`arfcns[i]` 就会
///   越界 panic —— 而本 crate 的 release 是 `panic = "abort"`（一次越界 = 进程退出，
///   且 procd 的重试计数会累积）。代价不对称（一次比较 vs 进程退出），所以这里显式挡
///   一道，把隐式契约变成显式的、可被这个函数自己保证的东西。
fn validate_pairs(bands: &[String], arfcns: &[String], table: &std::collections::HashMap<i64, (i64, i64)>, kind: &str) -> bool {
    if bands.len() != arfcns.len() {
        log_warn!("{} 锁频参数数量不一致：频段 {} 个，频点 {} 个", kind, bands.len(), arfcns.len());
        return false;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn to_v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    /// `is_night` 的跨零点边界 —— 这是"界面显示与实际相反"那类事故的高发处。
    #[test]
    fn is_night_跨零点() {
        use chrono::TimeZone;
        let mk = |h: u32, m: u32| {
            chrono::Local.with_ymd_and_hms(2026, 9, 28, h, m, 0).unwrap()
        };
        let mut cfg = crate::config::default_config().schedule;
        cfg.night_start = "22:00".into();
        cfg.night_end = "06:00".into();

        assert!(!is_night(&cfg, mk(21, 59)), "21:59 尚未进入夜间");
        assert!(is_night(&cfg, mk(22, 0)), "22:00 是闭区间起点");
        assert!(is_night(&cfg, mk(23, 59)));
        assert!(is_night(&cfg, mk(0, 0)), "跨零点后仍在夜间");
        assert!(is_night(&cfg, mk(5, 59)));
        assert!(!is_night(&cfg, mk(6, 0)), "06:00 是开区间终点");
        assert!(!is_night(&cfg, mk(12, 0)));

        // 同日时段（不跨零点）
        cfg.night_start = "01:00".into();
        cfg.night_end = "05:00".into();
        assert!(!is_night(&cfg, mk(0, 59)));
        assert!(is_night(&cfg, mk(1, 0)));
        assert!(!is_night(&cfg, mk(5, 0)));

        // 无法解析时按"非夜间"处理，且不能 panic
        cfg.night_start = "坏".into();
        assert!(!is_night(&cfg, mk(23, 0)));
    }

    /// 回归：`bands` 与 `arfcns` 不等长时必须返回 `false`，**而不是越界 panic**。
    /// （两个现有调用方都已提前比较长度，所以这条路径原本不可达；本断言守的是
    ///   「将来新增调用点漏掉那一步」的情况 —— release 是 panic = "abort"。）
    #[test]
    fn validate_pairs_不等长时返回假而不是越界() {
        let table = crate::schedconfig::lte_band_arfcn();
        let bands = to_v(&["1", "3"]);
        let arfcns = to_v(&["100"]); // 故意少一个
        assert!(
            !validate_pairs(&bands, &arfcns, table, "LTE"),
            "不等长必须返回 false；否则 arfcns[1] 越界 panic"
        );

        // 等长且配对合法 → 真
        let lo1 = table.get(&1).map(|(lo, _)| lo.to_string()).unwrap_or_default();
        assert!(validate_pairs(&to_v(&["1"]), &to_v(&[lo1.as_str()]), table, "LTE"));

        // 等长但频点越界 → 假
        assert!(!validate_pairs(&to_v(&["1"]), &to_v(&["99999999"]), table, "LTE"));
    }

    /// `registered`：四种 CxREG 应答形态都要认，且正文里的干扰不能误判。
    #[test]
    fn registered_判据() {
        assert!(registered("+CEREG: 2,1\r\nOK"));
        assert!(registered("+CREG: 0,5"), "5 = 已注册漫游");
        assert!(registered("+CGREG: 2,5\r\n+CEREG: 2,1"));
        assert!(!registered("+CEREG: 2,0"), "0 = 未注册");
        assert!(!registered("+CEREG: 2,2"), "2 = 搜索中");
        assert!(!registered("+CEREG: 2,4"), "4 = 未知");
        assert!(!registered("OK"));
        assert!(!registered(""));
    }

    /// `auto_detect_scs`：未知频段不能 panic，且枚举值只落在 0/1/3。
    #[test]
    fn auto_detect_scs_取值受限() {
        for s in auto_detect_scs(&to_v(&["1", "78", "999999", "坏"])) {
            assert!(s == "0" || s == "1" || s == "3", "SCS 只能是 0/1/3，实际 {s}");
        }
        assert_eq!(auto_detect_scs(&to_v(&[])).len(), 0);
    }
}
