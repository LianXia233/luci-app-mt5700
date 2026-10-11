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
//! - 存储满：模组主动上报 `^SMMEMFULL` → urc.rs → 合并窗口
//! - 信号：模组**不**上报 → 本模块定时轮询 → 合并窗口
//!
//! 读数换算复用 `urc::parse_signal_reading`：轮询与 URC 两条路径必须是同一套
//! 规则，否则同一信号会出现两个不同的 dBm 值。

use crate::atclient::{AtClient, COMMAND_TIMEOUT};
use crate::config::{in_poll_window, PollConfig};
use crate::notify::{Notification, NotifyKind, Notifier, SENDER_SIGNAL};
use crate::schedule::sleep_ctx;
use crate::urc::{parse_signal_reading, signal_level};
use crate::{log_debug, log_info};
use chrono::Timelike;
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

        let Some((rsrp, mode)) = self.read_signal(ctx).await else {
            log_debug!("信号轮询未取到有效读数（未注册 / 无服务小区 / 不可测），本轮跳过");
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
                rsrp,
                &mode,
            );
            if push {
                st.have = true;
                st.last_rsrp = rsrp;
                st.last_mode = mode.clone();
            }
            push
        };

        if !push {
            log_debug!(
                "信号轮询：RSRP {:.0} dBm（{}），变化未达阈值（{:.0} dB），不推送",
                rsrp,
                mode,
                self.poll.delta
            );
            return;
        }

        log_info!("信号轮询触发推送：RSRP {:.0} dBm（{}，{}）", rsrp, mode, signal_level(rsrp));
        self.notify_signal(rsrp, &mode).await;
    }

    /// 向模组查询一次当前信号。响应可能含多行（回显 + 结果 + OK），
    /// 取第一条能解析出的读数。
    async fn read_signal(&self, ctx: &watch::Receiver<bool>) -> Option<(f64, String)> {
        let resp = match self.client.send_command(ctx, "AT^HCSQ?", COMMAND_TIMEOUT, None).await {
            Ok(r) => r,
            Err(e) => {
                log_debug!("信号轮询 AT^HCSQ? 失败: {}", e);
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

    /// 组装轮询巡检文案并交给通知中枢（模板、通道、合并窗口都由它统一处理）。
    async fn notify_signal(&self, rsrp: f64, mode: &str) {
        let now = crate::notify::now_string();
        let content = format!(
            "📶 信号巡检\n时间: {}\n制式: {}\n信号: {} dBm（{}）",
            now,
            mode,
            rsrp.round() as i64,
            signal_level(rsrp)
        );
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

/// 当前时刻在当天的分钟数（0..=1439），供时段判定使用。
pub fn minute_of_day_now() -> i64 {
    let now = chrono::Local::now();
    i64::from(now.hour()) * 60 + i64::from(now.minute())
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
async fn sleep_in_slices(ctx: &watch::Receiver<bool>, mut total: Duration) -> bool {
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
}
