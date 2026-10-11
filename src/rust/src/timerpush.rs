//! 定时推送：每隔 UCI `notify_timer_interval`（分钟）主动推一次「当前实际情况」。
//!
//! 与 [`crate::signalwatch`]（信号巡检）是**两条独立的周期线**，互不覆盖：
//! - 巡检：在自己的时段内按自己的间隔采样，按「变化阈值」策略决定要不要推；
//! - 定时推送：不管信号有没有变化，到点就把**当前状态**（信号读数 + 存储用量）推一条。
//!
//! 为什么需要它：v1.14.20 移除合并窗口后，要回答的不再是「刚才发生了什么事件」，
//! 而是「现在怎么样」。而状态型信息只有主动去读才是真的 —— 本模组实测 1200 条
//! AT 记录里自发信号上报 0 条（它不会在信号变差时主动吭声），存储满的 `^SMMEMFULL`
//! 也只在恰好收满那一刻来一次，此后即便用户清理过也不会再来，状态会一直卡在「已满」。
//!
//! 采样与制式/频段口径一律复用 `signalwatch` 的函数：两条线若各采各的，
//! 同一时刻的 RSRP 可能差几个 dB，用户会以为设备在骗人。

use crate::atclient::AtClient;
use crate::notify::{Notification, NotifyKind, Notifier, SENDER_SIGNAL};
use crate::signalgrade::Grade;
use crate::signalwatch::{assess, band_label, fmt_num, sample_signal, sleep_in_slices, Sample};
use crate::urc::query_storage;
use crate::{log_debug, log_info};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

pub struct TimerPusher {
    client: Arc<AtClient>,
    notifier: Arc<Notifier>,
    interval: Duration,
}

impl TimerPusher {
    pub fn new(client: Arc<AtClient>, notifier: Arc<Notifier>, interval: Duration) -> Arc<Self> {
        Arc::new(TimerPusher { client, notifier, interval })
    }

    /// 周期循环：**先睡满一个间隔**再推第一轮。
    ///
    /// 开局立刻采一次看似更「及时」，但此刻串口/网络往往还在建立连接，采样只会
    /// 拿到空读数并推出一条「暂无读数」的消息 —— 那比晚几分钟推一条真的更糟：
    /// 用户会以为设备一直没信号。
    pub async fn run(self: Arc<Self>, ctx: watch::Receiver<bool>) {
        log_info!(
            "定时推送已启动：每 {} 分钟推送一次当前实际情况（信号读数 + 存储状态）",
            self.interval.as_secs() / 60
        );
        loop {
            if !sleep_in_slices(&ctx, self.interval).await {
                return;
            }
            self.tick(&ctx).await;
        }
    }

    /// 一轮：读当前信号与存储，渲染成一条「当前状态」推送。
    pub async fn tick(&self, ctx: &watch::Receiver<bool>) {
        // 总开关关闭时连 AT 都不发：「关掉自动推送」应当也停掉后台定时读取，
        // 否则用户关了开关却仍看到串口被周期性占用，会以为开关无效。
        if !self.notifier.master_enabled() {
            return;
        }
        if !self.client.connected() || self.client.long_command_active() {
            // 扫频一类长命令会独占模组，此刻发查询只会排队等待，跳过本轮。
            log_debug!("定时推送：模组忙（未连接 / 长命令进行中），本轮跳过");
            return;
        }

        let now = crate::notify::now_string();
        let sample = sample_signal(&self.client, ctx).await;
        let storage = query_storage(&self.client, ctx).await;
        if sample.is_none() && storage.is_none() {
            log_debug!("定时推送：信号与存储都没读到有效值，本轮跳过");
            return;
        }

        let memory_full = storage.map(|(used, total)| total > 0 && used >= total).unwrap_or(false);
        let content = render_status(sample.as_ref(), storage, &now);
        log_info!("定时推送触发：{}", first_line(&content));
        self.notifier
            .notify(Notification {
                sender: SENDER_SIGNAL.into(),
                content,
                // 走 Signal 模板：正文主体是信号状态，存储是附加项。
                // 分类开关因此按「信号」判定，与网页上「信号变化」那个开关一致。
                kind: NotifyKind::Signal,
                memory_full,
                time: now,
            })
            .await;
    }
}

/// 渲染「当前实际情况」：信号读数（有就给，没有就明说）+ 短信存储用量。
///
/// 与巡检报告刻意**不长得一样**：巡检是「刚才信号变了」的事件推送，这里是
/// 「现在是什么状态」的快照，且多了存储一项 —— 两条线内容可区分，用户收到
/// 两条时才不会以为是重复推送。
pub fn render_status(sample: Option<&Sample>, storage: Option<(u64, u64)>, now: &str) -> String {
    let mut out = String::from("🕒 当前状态（定时推送）\n");
    out.push_str(&format!("时间：{now}\n"));

    match sample {
        Some(s) => {
            let a = assess(s);
            let gen = a
                .capability
                .iter()
                .find(|c| c.label == "网络制式")
                .map(|c| c.value.clone())
                .unwrap_or_default();
            out.push('\n');

            let mut line = if gen.is_empty() {
                String::from("📶 信号")
            } else {
                format!("📶 {gen}")
            };
            let band = band_label(&s.rat, s.band);
            if !band.is_empty() {
                line.push_str(&format!(" · {band}"));
            }
            if let Some(freq) = s.dl_freq_khz {
                line.push_str(&format!(" · {} MHz", fmt_num(freq / 1000.0)));
                if let Some(bw) = s.dl_bw_khz {
                    line.push_str(&format!(" / {} MHz", fmt_num(bw / 1000.0)));
                }
            }
            out.push_str(&line);
            out.push('\n');

            out.push_str(&format!("RSRP {} dBm  {}\n", fmt_num(s.rsrp), grade_phrase(a.rsrp)));
            if let Some(pct) = a.signal_percent {
                out.push_str(&format!("SIGNAL {}%  {}\n", pct, grade_phrase(a.pct)));
            }
            if let Some(v) = &a.verdict {
                let short = v.title.strip_prefix("网络能力").unwrap_or(v.title);
                out.push_str(&format!("网络能力：{short} —— {}\n", v.advice));
            }
        }
        // 宁可明说「没读到」，也不要拿上一轮的旧值冒充当前状态
        None => out.push_str("\n📶 信号：暂无读数（未注册 / 无服务 / 模组忙）\n"),
    }

    if let Some((used, total)) = storage {
        out.push('\n');
        if total > 0 && used >= total {
            out.push_str(&format!("💾 短信存储已满（{used} / {total}）—— 清理前可能收不到新短信\n"));
        } else {
            out.push_str(&format!("💾 短信存储 {used} / {total}\n"));
        }
    }
    out
}

/// 档位 + 状态短语合成一段（与巡检报告的口径一致，只是不再带基准值）。
fn grade_phrase(g: Option<Grade>) -> String {
    match g {
        Some(x) => format!("{} · {}", x.text, x.status),
        None => "暂无数据".to_string(),
    }
}

/// 取首行用于日志（推送正文是多行，日志里只记一句就够定位）。
fn first_line(s: &str) -> &str {
    s.split('\n').next().unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn status_shows_generation_band_and_storage() {
        let s = full_sample();
        let text = render_status(Some(&s), Some((3, 50)), "2026-10-12 02:30:00");
        assert!(text.starts_with("🕒 当前状态（定时推送）"), "标题不对: {text}");
        assert!(text.contains("时间：2026-10-12 02:30:00"));
        assert!(text.contains("📶 5G"), "缺网络代际: {text}");
        assert!(text.contains("n41"), "缺频段号: {text}");
        assert!(text.contains("2565 MHz / 100 MHz"), "缺频点与带宽: {text}");
        assert!(text.contains("RSRP -62 dBm"), "缺 RSRP: {text}");
        assert!(text.contains("SIGNAL 100%"), "缺综合信号: {text}");
        assert!(text.contains("💾 短信存储 3 / 50"), "缺存储用量: {text}");
    }

    #[test]
    fn status_marks_full_storage_with_consequence() {
        let s = full_sample();
        let text = render_status(Some(&s), Some((50, 50)), "2026-10-12 02:30:00");
        // 光说「已满」不够：要说清后果，用户才知道该去清理
        assert!(text.contains("短信存储已满"), "未标记已满: {text}");
        assert!(text.contains("收不到新短信"), "未说明后果: {text}");
    }

    #[test]
    fn status_admits_when_there_is_no_reading() {
        // 信号与存储都没读到：宁可明说，也不能拿上一轮旧值冒充当前状态
        let text = render_status(None, None, "2026-10-12 02:30:00");
        assert!(text.contains("暂无读数"), "未说明没有读数: {text}");
        assert!(!text.contains("RSRP"), "没有读数时不该出现指标行: {text}");
    }

    #[test]
    fn status_is_short_enough_to_read_at_a_glance() {
        let s = full_sample();
        let text = render_status(Some(&s), Some((3, 50)), "2026-10-12 02:30:00");
        let lines = text.trim().split('\n').count();
        assert!(lines <= 9, "定时推送正文 {lines} 行，太长: {text}");
    }
}
