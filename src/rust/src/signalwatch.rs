//! 定时轮询推送：在用户指定的时段内，由后端定期读取信号并按策略推送。
//!
//! 为什么需要这个模块：本模组（TDTECH / Fibocom 系）**不会主动上报** `^HCSQ` /
//! `^CERSSI`。实测 1200 条 AT 记录里自发信号上报为 0 条，因此
//! `urc::Dispatcher::handle_signal` 实际永远不会被调用，LuCI 上的「信号变化
//! 通知」开关处于失效状态。这里由后端在用户给定的时段内主动轮询，让该开关
//! 真正生效；**时段外一条 AT 都不发**，避免无意义的串口占用与推送打扰。
//!
//! 四类事件的分工（决定了谁实时、谁轮询）：
//! - 短信：模组主动上报 `+CMTI:` → urc.rs → **实时直发**
//! - 来电：模组主动上报 `RING` → urc.rs → **实时直发**
//! - 存储满：模组主动上报 `^SMMEMFULL` → urc.rs → 实时直发
//! - 信号：模组**不**上报 → 本模块定时轮询 → 实时直发
//!
//! 另有 `timerpush` 按 `notify_timer_interval`（分钟）周期性推送当前状态快照，
//! 与本模块是两条独立周期线：本模块抓突变，它做保底。
//!
//! 读数换算复用 `urc::parse_signal_reading`：轮询与 URC 两条路径必须是同一套
//! 规则，否则同一信号会出现两个不同的 dBm 值。

use crate::atclient::{AtClient, COMMAND_TIMEOUT};
use crate::config::{in_poll_window, PollConfig};
use crate::notify::{Notification, NotifyKind, Notifier, SENDER_SIGNAL};
use crate::schedule::sleep_ctx;
use crate::signalgrade::{Assessment, Grade, SignalInput};
use crate::urc::{parse_signal_reading, query_hfreqinfo, query_monsc};
use crate::{log_debug, log_info};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{watch, Mutex};

/// 单次睡眠的最长分片（秒）。
///
/// 轮询间隔可能长达 1 小时，若一次睡满，用户把时段起点设成「10 分钟后」时
/// 要等满一个间隔才会开始工作，体感像坏了。切成不超过 30 秒的片段后，时段
/// 边界最多迟到 30 秒生效，且片段睡眠期间不做任何 AT 操作，代价可忽略。
const MAX_SLEEP_SLICE: Duration = Duration::from_secs(30);

/// 轮询基线：用于「仅变化时推送」策略的比较。
///
/// 只在**推送发生时**刷新，不随每次读数刷新。原因：若每次读数都刷新基线，
/// 信号从 -80 缓慢漂移到 -95（每次只差 2 dB）时永远越不过阈值，用户反而收
/// 不到「信号持续变差」这个最该知道的通知。以「上次通知时的值」为基准更符
/// 合直觉，也能捕捉缓慢漂移。
#[derive(Default)]
struct WatchState {
    /// 是否已有基线（首次轮询恒定推送一次，让用户确认链路可用）。
    have: bool,
    last_rsrp: f64,
    last_mode: String,
}

pub struct SignalWatcher {
    client: Arc<AtClient>,
    notifier: Arc<Notifier>,
    poll: PollConfig,
    state: Mutex<WatchState>,
}

impl SignalWatcher {
    pub fn new(client: Arc<AtClient>, notifier: Arc<Notifier>, poll: PollConfig) -> Arc<SignalWatcher> {
        Arc::new(SignalWatcher {
            client,
            notifier,
            poll,
            state: Mutex::new(WatchState::default()),
        })
    }

    /// 常驻轮询：间隔由 `notify_poll_interval` 决定，切片睡眠以便及时进出时段。
    ///
    /// 即使当前不在时段内也保持循环：用户随时可能改时段，任务退出后就再没人
    /// 把它叫起来了。真正决定「发不发 AT」的是 `tick()`。
    pub async fn run(self: Arc<Self>, ctx: watch::Receiver<bool>) {
        loop {
            if !sleep_in_slices(&ctx, self.poll.interval).await {
                return;
            }
            self.tick(&ctx).await;
        }
    }

    /// 一次轮询：判定时段 → 读信号 → 按策略决定是否推送。
    pub async fn tick(&self, ctx: &watch::Receiver<bool>) {
        if !self.poll.enabled {
            return;
        }
        // 总开关关闭时连 AT 都不发：「关掉自动推送」应当也停掉后台轮询，
        // 否则用户关了开关却仍看到串口被周期性占用，会以为开关无效。
        if !self.notifier.master_enabled() {
            return;
        }
        if !in_poll_window(&self.poll.start, &self.poll.end, minute_of_day_now()) {
            return;
        }
        if !self.client.connected() || self.client.long_command_active() {
            // 扫频一类长命令会独占模组，此刻发查询只会排队等待，跳过本轮。
            return;
        }

        let Some(sample) = self.sample(ctx).await else {
            log_debug!("信号巡检未取到有效读数（未注册 / 无服务小区 / 不可测），本轮跳过");
            return;
        };

        let push = {
            let mut st = self.state.lock().await;
            let push = should_push(
                self.poll.always,
                st.have,
                self.poll.delta,
                st.last_rsrp,
                &st.last_mode,
                sample.rsrp,
                &sample.rat,
            );
            if push {
                st.have = true;
                st.last_rsrp = sample.rsrp;
                st.last_mode = sample.rat.clone();
            }
            push
        };

        if !push {
            log_debug!(
                "信号巡检：RSRP {:.0} dBm（{}），变化未达阈值（{:.0} dB），不推送",
                sample.rsrp,
                sample.rat,
                self.poll.delta
            );
            return;
        }

        log_info!("信号巡检触发推送：RSRP {:.0} dBm（{}）", sample.rsrp, sample.rat);
        self.notify_signal(&sample).await;
    }

    /// 采样一次完整信号状态。
    ///
    /// 主数据源是 `AT^MONSC`（一条命令同时给出制式与 RSRP/RSRQ/SINR，且与页面
    /// 状态卡同源）；`AT^HFREQINFO?` 补上频点与带宽，供网络能力总评使用。
    /// 若 MONSC 没给出可用 RSRP（个别制式或未注册时为空/0），回退 `AT^HCSQ?`
    /// ——它至少能给一个强度读数，宁可少几项明细也不要整轮不出声。
    /// 采样一次完整信号状态。
    ///
    /// 薄包装：真正的实现是 [`sample_signal`]。定时推送（timerpush.rs）要复用
    /// **同一套采样规则** —— 两条周期线若各采各的，同一时刻的 RSRP 可能差几个
    /// dB，用户会以为设备在骗人。
    async fn sample(&self, ctx: &watch::Receiver<bool>) -> Option<Sample> {
        sample_signal(&self.client, ctx).await
    }

    /// 渲染完整巡检报告并交给通知中枢（模板与通道由它统一处理，并立即直发）。
async fn notify_signal(&self, sample: &Sample) {
        let now = crate::notify::now_string();
        let assessment = assess(sample);
        /*
         * 总评档位也落到日志：QQ 里只留最近几条推送，
         * 事后要判断「这次评估合不合理」只能对着日志看。
         */
        if let Some(v) = &assessment.verdict {
            log_info!("信号评估：网络能力{}（{}）", v.level.caption(), v.title);
        }
        let content = render_report_with(&assessment, sample, &now);
        self.notifier
            .notify(Notification {
                sender: SENDER_SIGNAL.into(),
                content,
                kind: NotifyKind::Signal,
                memory_full: false,
                time: now,
            })
            .await;
    }
}

/// 一次采样得到的信号快照。
#[derive(Debug, Clone)]
pub struct Sample {
    pub rat: String,
    pub rsrp: f64,
    pub rsrq: Option<f64>,
    pub sinr: Option<f64>,
    pub dl_freq_khz: Option<f64>,
    pub dl_bw_khz: Option<f64>,
    /// 频段号，取自 `AT^HFREQINFO?` 的 `<band>`（NR 为 n 号、LTE 为 B 号）。
    /// 这是推送里要显示「具体频段」的唯一来源——按频率反查频段会在边界上猜错。
    pub band: Option<u32>,
}

/// 把 MONSC 的字符串字段解析成数值；空串、非数字、0 都视为「无读数」。
fn parse_db(s: &str) -> Option<f64> {
    let v = s.trim().trim_matches('"').parse::<f64>().ok()?;
    if v == 0.0 {
        None
    } else {
        Some(v)
    }
}

/// 渲染巡检报告。
///
/// 设计取向：**与网页「射频信号质量」卡片同源同口径**——用户在网页上看到的
/// 等级、状态短语、网络能力总评，在推送里必须一模一样，否则同一时刻两处结论
/// 不同会直接损害可信度。因此这里不做任何「简化版」换算。
/// 由一次采样算出完整评估。
///
/// 报告渲染与推送日志共用同一份评估结果，避免两处各算一遍导致口径走偏
/// （评估里含「木桶两层取更差」这类逻辑，重复实现迟早不一致）。
/// 采样一次完整信号状态（自由函数版本：巡检与定时推送共用）。
///
/// 主数据源是 `AT^MONSC`（一条命令同时给出制式与 RSRP/RSRQ/SINR，且与页面
/// 状态卡同源）；`AT^HFREQINFO?` 补上频点与带宽，供网络能力总评使用。
/// 若 MONSC 没给出可用 RSRP（个别制式或未注册时为空/0），回退 `AT^HCSQ?`
/// ——它至少能给一个强度读数，宁可少几项明细也不要整轮不出声。
pub async fn sample_signal(client: &Arc<AtClient>, ctx: &watch::Receiver<bool>) -> Option<Sample> {
    let monsc = query_monsc(client, ctx).await;
    let mut rat = monsc.rat.clone();
    // RSRP/RSRQ 恒为负值；0 与空串都表示「无有效读数」而不是真实值
    let mut rsrp = parse_db(&monsc.rsrp).filter(|v| *v < 0.0 && *v > -200.0);
    let rsrq = parse_db(&monsc.rsrq).filter(|v| *v < 0.0 && *v > -50.0);
    // SINR 可以为 0（对应「频发重传」档），故这里不能按「非零」过滤
    let sinr = parse_db(&monsc.sinr).filter(|v| *v >= -30.0 && *v <= 50.0);

    if rsrp.is_none() {
        if let Some((v, m)) = read_hcsq(client, ctx).await {
            rsrp = Some(v);
            if rat.trim().is_empty() || rat == "未知" {
                rat = m;
            }
        }
    }

    let hf = query_hfreqinfo(client, ctx).await;
    // 制式优先信 MONSC；它没给出时用 HFREQINFO 的 sysmode 兜底，
    // 否则会出现「拿到了频段号、却不知道该写成 n41 还是 B41」的尴尬。
    if rat.trim().is_empty() || rat == "未知" {
        if let Some(info) = &hf {
            if !info.sysmode.is_empty() {
                rat = info.sysmode.clone();
            }
        }
    }
    let (dl_freq_khz, dl_bw_khz, band) = match &hf {
        Some(info) => (
            Some(info.dl_freq_khz),
            if info.dl_bw_khz > 0.0 { Some(info.dl_bw_khz) } else { None },
            info.band,
        ),
        None => (None, None, None),
    };

    Some(Sample { rat, rsrp: rsrp?, rsrq, sinr, dl_freq_khz, dl_bw_khz, band })
}

/// 回退路径：`AT^HCSQ?` 只给强度，但字段位置随制式不同，解析复用 URC 那套。
pub async fn read_hcsq(client: &Arc<AtClient>, ctx: &watch::Receiver<bool>) -> Option<(f64, String)> {
    let resp = match client.send_command(ctx, "AT^HCSQ?", COMMAND_TIMEOUT, None).await {
        Ok(r) => r,
        Err(e) => {
            log_debug!("信号采样 AT^HCSQ? 失败: {}", e);
            return None;
        }
    };
    for line in &resp.lines {
        if let Some(reading) = parse_signal_reading(line) {
            return Some(reading);
        }
    }
    None
}

/// 把采样结果交给评估器（与网页「射频信号质量」卡片同一口径）。
pub fn assess(sample: &Sample) -> Assessment {
    Assessment::new(&SignalInput {
        rat: sample.rat.clone(),
        rsrp: Some(sample.rsrp),
        rsrq: sample.rsrq,
        sinr: sample.sinr,
        dl_freq_khz: sample.dl_freq_khz,
        dl_bw_khz: sample.dl_bw_khz,
    })
}

/// 渲染推送文案（自算评估再委托 `render_report_with`）。
///
/// 生产路径先算评估、再用同一份评估渲染日志与推送（见 `notify_signal`），
/// 所以这里只留给测试用：避免"测试用入口"在生产构建里成为 dead_code。
#[cfg(test)]
pub fn render_report(sample: &Sample, now: &str) -> String {
    render_report_with(&assess(sample), sample, now)
}

/// 用已算好的评估渲染推送文案。
///
/// 两条硬约束：
/// 1. **与网页「射频信号质量」卡片同源同口径** —— 等级、状态短语、网络能力总评必须
///    一致，否则同一时刻两处结论不同会直接损害可信度；
/// 2. **排布要紧凑** —— 推送是纯文本、手机上要一眼看完，因此制式进标题、
///    频段与带宽合成一行、总评一行、四个指标各一行，不再分「制式」「载波」两段。
pub fn render_report_with(assessment: &Assessment, sample: &Sample, now: &str) -> String {
    // 代际标签（5G / 4G）沿用能力档里「网络制式」的取值，保证与总评同一口径
    let gen = assessment
        .capability
        .iter()
        .find(|c| c.label == "网络制式")
        .map(|c| c.value.clone())
        .unwrap_or_default();

    let mut out = if gen.is_empty() {
        String::from("📶 信号巡检\n")
    } else {
        format!("📶 {gen} 信号巡检\n")
    };
    out.push_str(&format!("时间：{now}\n"));

    // 频段行：频段号 · 下行频点 / 带宽（缺哪项就少哪项，不写占位符）
    let band = band_label(&sample.rat, sample.band);
    let mut freq_part = String::new();
    if let Some(freq) = sample.dl_freq_khz {
        freq_part = format!("{} MHz", fmt_num(freq / 1000.0));
        if let Some(bw) = sample.dl_bw_khz {
            freq_part.push_str(&format!(" / {} MHz", fmt_num(bw / 1000.0)));
        }
    } else if let Some(bw) = sample.dl_bw_khz {
        freq_part = format!("带宽 {} MHz", fmt_num(bw / 1000.0));
    }
    let bw_note = assessment
        .capability
        .iter()
        .find(|c| c.label == "载波带宽")
        .map(|c| format!("（{}）", c.note))
        .unwrap_or_default();
    let mut parts: Vec<String> = Vec::new();
    if !band.is_empty() {
        parts.push(band);
    }
    if !freq_part.is_empty() {
        parts.push(freq_part);
    }
    if !parts.is_empty() {
        out.push_str(&format!("频段：{}{bw_note}\n", parts.join(" · ")));
    }

    if let Some(v) = &assessment.verdict {
        // title 形如「网络能力优秀」，去掉重复前缀后与建议并成一行
        let short = v.title.strip_prefix("网络能力").unwrap_or(v.title);
        out.push_str(&format!("网络能力：{short} —— {}\n", v.advice));
    }
    out.push('\n');

    out.push_str(&format!(
        "RSRP {} dBm（≥ -80）  {} · {}\n",
        fmt_num(sample.rsrp),
        grade_text(assessment.rsrp),
        grade_status(assessment.rsrp)
    ));
    if let (Some(v), Some(g)) = (sample.rsrq, assessment.rsrq) {
        out.push_str(&format!("RSRQ {} dB（≥ -10）  {} · {}\n", fmt_num(v), g.text, g.status));
    }
    if let (Some(v), Some(g)) = (sample.sinr, assessment.sinr) {
        out.push_str(&format!("SINR {} dB（≥ 20）  {} · {}\n", fmt_num(v), g.text, g.status));
    }
    if let (Some(pct), Some(g)) = (assessment.signal_percent, assessment.pct) {
        out.push_str(&format!("SIGNAL {pct}%（满分）  {} · {}\n", g.text, g.status));
    }

    out.trim_end().to_string()
}

/// 频段号显示：NR 用 `n` 前缀、LTE 用 `B` 前缀（3GPP 书写惯例）；
/// 制式未知时退回中性的 `Band <n>`，不去猜它到底是 4G 还是 5G。
pub(crate) fn band_label(rat: &str, band: Option<u32>) -> String {
    let b = match band {
        Some(v) if v > 0 => v,
        _ => return String::new(),
    };
    let r = rat.trim().to_ascii_uppercase();
    if r.contains("NR") {
        format!("n{b}")
    } else if r.contains("LTE") {
        format!("B{b}")
    } else {
        format!("Band {b}")
    }
}

/// 指标值格式化：整数不带小数点，非整数保留一位（-10 → "-10"，-9.5 → "-9.5"）。
pub(crate) fn fmt_num(v: f64) -> String {
    if (v - v.round()).abs() < 0.05 {
        format!("{}", v.round() as i64)
    } else {
        format!("{v:.1}")
    }
}

fn grade_text(g: Option<Grade>) -> &'static str {
    g.map(|x| x.text).unwrap_or("未知")
}

fn grade_status(g: Option<Grade>) -> &'static str {
    g.map(|x| x.status).unwrap_or("暂无数据")
}

/// 当前时刻在当天的分钟数（0..=1439），供时段判定使用。
///
/// 时区口径由 [`crate::localtime`] 统一（系统时区，缺省北京时间）。
pub fn minute_of_day_now() -> i64 {
    crate::localtime::minute_of_day_now()
}

/// 「本次读数是否应当推送」的纯判定，便于单测覆盖各策略组合。
///
/// - `always`：每次轮询都推（用户选择「始终推送当前状态」）；
/// - 首次读数必定推一次：让用户立刻确认「这个功能真的在工作」，
///   否则默认的「仅变化时推送」可能几小时都不出声，看起来像坏的；
/// - 制式切换（LTE ↔ NR）必定推：这是用户最关心的网络事件之一，
///   即便 RSRP 数值恰好没变；
/// - 其余比较 RSRP 变化量是否达到用户设定的阈值。
pub fn should_push(
    always: bool,
    have: bool,
    delta_db: f64,
    last_rsrp: f64,
    last_mode: &str,
    rsrp: f64,
    mode: &str,
) -> bool {
    if always {
        return true;
    }
    if !have {
        return true;
    }
    if !mode.eq_ignore_ascii_case(last_mode) {
        return true;
    }
    (rsrp - last_rsrp).abs() >= delta_db
}

/// 把一段总时长切成不超过 [`MAX_SLEEP_SLICE`] 的片段依次睡眠。
/// 返回 `false` 表示期间收到了关闭信号，调用方应退出。
pub(crate) async fn sleep_in_slices(ctx: &watch::Receiver<bool>, mut total: Duration) -> bool {
    if total.is_zero() {
        return true;
    }
    loop {
        let slice = total.min(MAX_SLEEP_SLICE);
        if !sleep_ctx(ctx, slice).await {
            return false;
        }
        total = total.saturating_sub(slice);
        if total.is_zero() {
            return true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::valid_hhmm;

    // ---- should_push：五种策略组合 ----

    #[test]
    fn always_pushes_regardless_of_state() {
        // 无论有没有基线、变化多少，always 都推
        assert!(should_push(true, false, 3.0, -80.0, "LTE", -80.0, "LTE"));
        assert!(should_push(true, true, 30.0, -80.0, "LTE", -80.1, "LTE"));
    }

    #[test]
    fn first_reading_always_pushes() {
        // 没有基线时必推一次，让用户确认功能在工作
        assert!(should_push(false, false, 30.0, 0.0, "", -120.0, "LTE"));
    }

    #[test]
    fn mode_switch_always_pushes() {
        // RSRP 完全没变但制式从 LTE 换成 NR，仍要推
        assert!(should_push(false, true, 30.0, -90.0, "LTE", -90.0, "NR"));
    }

    #[test]
    fn delta_below_threshold_does_not_push() {
        // 差 2 dB，阈值 3 → 不推
        assert!(!should_push(false, true, 3.0, -90.0, "LTE", -92.0, "LTE"));
    }

    #[test]
    fn delta_at_or_above_threshold_pushes() {
        // 恰好等于阈值要推（阈值语义是「达到即推」）
        assert!(should_push(false, true, 3.0, -90.0, "LTE", -93.0, "LTE"));
        // 改善方向同样算变化
        assert!(should_push(false, true, 3.0, -95.0, "LTE", -88.0, "LTE"));
    }

    #[test]
    fn delta_threshold_of_one_pushes_on_any_change() {
        // 阈值取到下限 1 dB 时，1 dB 的变化就应触发
        assert!(should_push(false, true, 1.0, -90.0, "LTE", -91.0, "LTE"));
        // 完全没变则不推
        assert!(!should_push(false, true, 1.0, -90.0, "LTE", -90.0, "LTE"));
    }

    #[test]
    fn mode_compare_is_case_insensitive() {
        // 模组可能回 "lte"，不能因为大小写差异误判成制式切换
        assert!(!should_push(false, true, 3.0, -90.0, "LTE", -90.0, "lte"));
    }

    // ---- PollConfig 边界 ----

    #[test]
    fn poll_default_is_full_day_and_conservative() {
        let p = PollConfig::default();
        assert!(p.enabled);
        assert!(!p.always, "默认应是「仅变化时推送」，避免刷屏与频控");
        assert_eq!(p.start, "00:00");
        assert_eq!(p.end, "23:59");
        assert_eq!(p.interval.as_secs(), 300);
        assert_eq!(p.delta, 3.0);
        // 默认全天时段下，任意时刻都应在时段内
        for m in [0, 1, 719, 1438, 1439] {
            assert!(in_poll_window(&p.start, &p.end, m), "分钟 {m} 应在全天时段内");
        }
    }

    #[test]
    fn hhmm_validation_rejects_garbage() {
        // "0:00" 这类不补零的写法要接受：用户手改 UCI 时很常见，没有理由拒绝
        for ok in ["00:00", "08:30", "23:59", "0:00"] {
            assert!(valid_hhmm(ok), "{ok} 应被判为合法");
        }
        for bad in ["24:00", "08:60", "0800", "8:", "", "ab:cd", "08:30:00"] {
            assert!(!valid_hhmm(bad), "{bad} 应被判为非法");
        }
    }

    // ---- 时段判定：普通区间 / 跨零点 / 等值 / 非法 ----

    #[test]
    fn window_normal_range() {
        // 08:00-18:00，闭区间
        assert!(!in_poll_window("08:00", "18:00", 7 * 60 + 59), "起点前 1 分钟不进段");
        assert!(in_poll_window("08:00", "18:00", 8 * 60), "起点含");
        assert!(in_poll_window("08:00", "18:00", 12 * 60), "区间中");
        assert!(in_poll_window("08:00", "18:00", 18 * 60), "终点含（闭区间：「到 18:00 为止」）");
        assert!(!in_poll_window("08:00", "18:00", 18 * 60 + 1), "终点后 1 分钟出段");
    }

    #[test]
    fn window_across_midnight() {
        // 22:00-06:00：跨零点
        assert!(in_poll_window("22:00", "06:00", 22 * 60), "起点含");
        assert!(in_poll_window("22:00", "06:00", 23 * 60 + 30), "前半夜");
        assert!(in_poll_window("22:00", "06:00", 0), "零点");
        assert!(in_poll_window("22:00", "06:00", 6 * 60), "终点含");
        assert!(!in_poll_window("22:00", "06:00", 6 * 60 + 1), "终点后 1 分钟出段");
        assert!(!in_poll_window("22:00", "06:00", 12 * 60), "白天不在段内");
    }

    #[test]
    fn window_equal_bounds_means_full_day() {
        // 起止相同若按区间解释只命中一分钟，用户会以为功能坏了；按「全天」处理
        for m in [0, 5 * 60, 12 * 60, 23 * 60 + 59] {
            assert!(in_poll_window("08:00", "08:00", m), "等值起止应视为全天");
        }
    }

    #[test]
    fn window_invalid_format_falls_back_to_full_day() {
        // 格式笔误时按全天处理，交由配置层记一次告警，避免彻底静默
        for m in [0, 12 * 60, 23 * 60 + 59] {
            assert!(in_poll_window("", "", m));
            assert!(in_poll_window("25:00", "18:00", m));
            assert!(in_poll_window("08:00", "xx:yy", m));
        }
    }

    // ---- 巡检报告渲染 ----

    /// 实测场景：NR n41 100MHz、RSRP -62、RSRQ -10、SINR 28
    fn full_sample() -> Sample {
        Sample {
            rat: "NR".into(),
            rsrp: -62.0,
            rsrq: Some(-10.0),
            sinr: Some(28.0),
            dl_freq_khz: Some(2_565_000.0),
            dl_bw_khz: Some(100_000.0),
            band: Some(41),
        }
    }

    #[test]
    fn report_carries_every_metric_the_page_shows() {
        // 推送内容必须与网页「射频信号质量」卡片逐项对齐：
        // 指标名 + 基准 + 实测值 + 档位 + 状态短语 + 网络能力总评
        let text = render_report(&full_sample(), "2026-10-11 23:43:12");
        // 制式（4G/5G）进标题，频段号与带宽合并在「频段」行 —— 这是本版新增的信息
        assert!(text.starts_with("📶 5G 信号巡检"), "标题缺少 5G 代际: {text}");
        assert!(text.contains("时间：2026-10-11 23:43:12"));
        assert!(text.contains("频段：n41 · 2565 MHz / 100 MHz"), "缺少具体频段号: {text}");
        assert!(text.contains("网络能力：优秀 —— 信号与频段带宽俱佳"), "总评缺少档位或建议: {text}");
        assert!(text.contains("RSRP -62 dBm（≥ -80）  极佳 · 覆盖极佳"), "实际: {text}");
        assert!(text.contains("RSRQ -10 dB（≥ -10）  极佳 · 纯净通畅"), "实际: {text}");
        assert!(text.contains("SINR 28 dB（≥ 20）  极佳 · 顶速阶数"), "实际: {text}");
        assert!(text.contains("SIGNAL 100%（满分）  极佳 · 满格服务"), "实际: {text}");
        assert!(!text.ends_with('\n'), "报告末尾不应留多余空行: {text:?}");
    }

    #[test]
    fn report_omits_metrics_without_reading() {
        // LTE 的 MONSC 不提供 SINR，也没有频点信息：
        // 既不凭空写一行「未知」，也不因为「缺失」把总评误判成最差
        let s = Sample {
            rat: "LTE".into(),
            rsrp: -75.0,
            rsrq: Some(-9.0),
            sinr: None,
            dl_freq_khz: None,
            dl_bw_khz: None,
            band: None,
        };
        let text = render_report(&s, "t");
        assert!(text.starts_with("📶 4G 信号巡检"), "LTE 应显示为 4G: {text}");
        assert!(text.contains("RSRP -75 dBm"));
        assert!(text.contains("RSRQ -9 dB"));
        assert!(!text.contains("SINR"), "无读数时不该输出该行: {text}");
        assert!(!text.contains("频段："), "无频点信息时不该输出频段行: {text}");
        assert!(text.contains("网络能力：良好"), "缺失项不应把总评压成极差: {text}");
    }

    #[test]
    fn report_skips_rat_line_when_mode_unknown() {
        let mut s = full_sample();
        s.rat = "  ".into();
        let text = render_report(&s, "t");
        assert!(text.starts_with("📶 信号巡检"), "制式未知时标题不该带代际: {text}");
        // 频段号仍要显示，但不能猜前缀 —— 未知制式用中性的 Band 41
        assert!(text.contains("频段：Band 41"), "实际: {text}");
        // 能力档仍由频段与带宽支撑，总评不受影响
        assert!(text.contains("网络能力：优秀"), "实际: {text}");
    }

    #[test]
    fn number_formatting_drops_trailing_zero() {
        assert_eq!(fmt_num(-62.0), "-62");
        assert_eq!(fmt_num(-10.0), "-10");
        assert_eq!(fmt_num(-9.5), "-9.5");
    }

    #[test]
    fn parse_db_treats_zero_and_blank_as_missing() {
        // MONSC 在未注册时会把数值字段填 0 或留空，二者都不是真实读数
        assert_eq!(parse_db("-62"), Some(-62.0));
        assert_eq!(parse_db(" 28 "), Some(28.0));
        assert_eq!(parse_db("-10.5"), Some(-10.5));
        assert_eq!(parse_db(""), None);
        assert_eq!(parse_db("0"), None);
        assert_eq!(parse_db("--"), None);
        assert_eq!(parse_db("\"\"") , None);
    }

    #[test]
    fn band_label_uses_rat_specific_prefix() {
        // NR 记 n 号、LTE 记 B 号（3GPP 书写惯例）；
        // 制式未知时不猜代际，退回中性的 Band <n>
        assert_eq!(band_label("NR", Some(41)), "n41");
        assert_eq!(band_label("LTE", Some(3)), "B3");
        assert_eq!(band_label("  ", Some(41)), "Band 41");
        assert_eq!(band_label("NR", None), "", "没有频段号就不该编造前缀");
        assert_eq!(band_label("NR", Some(0)), "", "0 不是合法频段号");
    }
}
