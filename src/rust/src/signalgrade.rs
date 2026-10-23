//! 信号评估：把网页上的信号结论搬进推送，让用户不打开网页也能在 QQ 里看到同一套判断。
//!
//! 存在意义：网页上那套仪表只有打开页面才看得到，而用户需要的是「不合时宜地
//! 掏出手机看信号」——巡检推送必须把同样的结论送到 QQ/微信里，否则同一时刻
//! 两处结论不同会直接损害可信度。
//!
//! 但**当前只对齐了一部分**，改这里之前先看清（这几处口径历史上反复漂移）：
//!   - RSRP 分档边界与 `network_status.js` 的 `SSB_TIERS` 一致（-80/-90/-100/-110），
//!     档位名却是两套：前端「优/良/中/弱/差」，这里「极佳/良好/一般/较差/极差」；
//!   - 前端**还有第二张表** `SIGNAL_TIERS`（趋势图背景分区，4 档、阈值 -110/-95/-80，
//!     名字 较差/一般/良好/极佳）——前四个名字与 [`Level::caption()`] **完全重合而阈值不同**，
//!     是最容易被误当成「已对齐」的一处：只 grep 到「极佳」就以为同源，会改错表；
//!   - 状态短语、能力总评标题与建议文案**只有本文件一份**，前端并没有对应的表；
//!   - 信号百分比**是分歧的**：这里按 30 dB 跨度（-80→100%），前端
//!     `rpc.js` 的 `calculateSignalPercent` 按 40 dB 跨度（-70→100%），见
//!     [`signal_percent`]。
//!
//! 两处口径若发生分歧，以本文件为准，前端需同步（反之亦然）。

/// 档位。数值越大越差，便于用 `max` 做木桶原理取最差项。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Exc,
    Good,
    Fair,
    Poor,
    Bad,
}

impl Level {
    /// 档位中文名。前端 `SSB_TIERS`（SSB 波束矩阵）用的是另一套「优/良/中/弱/差」；
    /// `SIGNAL_TIERS`（趋势图背景分区）前四个名字与本表**重合但阈值不同**（见模块头），
    /// 改任一侧之前先确认动的是哪张表。文案以本文件为准。
    pub fn caption(self) -> &'static str {
        match self {
            Level::Exc => "极佳",
            Level::Good => "良好",
            Level::Fair => "一般",
            Level::Poor => "较差",
            Level::Bad => "极差",
        }
    }
}

/// 单项指标的评估结果。
#[derive(Debug, Clone, Copy)]
pub struct Grade {
    pub level: Level,
    /// 档位中文名（极佳/良好/一般/较差/极差）
    pub text: &'static str,
    /// 状态短语（覆盖极佳 / 纯净通畅 / 顶速阶数 …）
    pub status: &'static str,
}

fn g(level: Level, status: &'static str) -> Grade {
    Grade { level, text: level.caption(), status }
}

/// RSRP 信号强度（dBm）。分档边界与前端 `network_status.js` 的 `SSB_TIERS` 一致（文案不同）。
pub fn grade_rsrp(v: f64) -> Grade {
    if v >= -80.0 {
        g(Level::Exc, "覆盖极佳")
    } else if v >= -90.0 {
        g(Level::Good, "工况优良")
    } else if v >= -100.0 {
        g(Level::Fair, "信号偏弱")
    } else if v >= -110.0 {
        g(Level::Poor, "边缘弱区")
    } else {
        g(Level::Bad, "频发脱网")
    }
}

/// RSRQ 信号质量（dB）。注意档位阈值比 RSRP 密得多（-10/-13/-16/-18，约 2~3 dB 一档）。
pub fn grade_rsrq(v: f64) -> Grade {
    if v >= -10.0 {
        g(Level::Exc, "纯净通畅")
    } else if v >= -13.0 {
        g(Level::Good, "轻微扰动")
    } else if v >= -16.0 {
        g(Level::Fair, "中度负载")
    } else if v >= -18.0 {
        g(Level::Poor, "邻区拥塞")
    } else {
        g(Level::Bad, "强干扰区")
    }
}

/// SINR 信噪比（dB）。
pub fn grade_sinr(v: f64) -> Grade {
    if v >= 20.0 {
        g(Level::Exc, "顶速阶数")
    } else if v >= 13.0 {
        g(Level::Good, "稳定传输")
    } else if v >= 5.0 {
        g(Level::Fair, "速率受限")
    } else if v >= 0.0 {
        g(Level::Poor, "频发重传")
    } else {
        g(Level::Bad, "严重丢包")
    }
}

/// 综合信号百分比（0~100）。
pub fn grade_pct(v: i64) -> Grade {
    if v >= 80 {
        g(Level::Exc, "满格服务")
    } else if v >= 60 {
        g(Level::Good, "稳定连接")
    } else if v >= 40 {
        g(Level::Fair, "基础覆盖")
    } else if v >= 20 {
        g(Level::Poor, "微弱临界")
    } else {
        g(Level::Bad, "濒临掉线")
    }
}

/// 综合信号百分比：由 RSRP 线性映射，量程 -110 dBm(0%) ~ -80 dBm(100%)，30 dB 跨度。
///
/// **与前端并不一致**：`rpc.js` 的 `calculateSignalPercent` 用 `(rsrp + 110) / 40`，
/// 到 -70 dBm 就算满格。同一时刻两处数字不同（-85 dBm：网页 63%、推送 83%），
/// 要统一口径得两边一起改，别只动一边。`rsrp >= 0` 视为无效（前端同样返回空串）。
pub fn signal_percent(rsrp: f64) -> Option<i64> {
    if rsrp >= 0.0 {
        return None;
    }
    let ratio = ((rsrp + 110.0) / 30.0).clamp(0.0, 1.0);
    Some((ratio * 100.0).round() as i64)
}

/// 网络承载能力的一个评估项。
#[derive(Debug, Clone)]
pub struct CapItem {
    pub label: &'static str,
    pub value: String,
    pub level: Level,
    pub note: &'static str,
}

/// 制式归一（前端 normRat）：`6`/`LTE*` → LTE，`7`/`11`/`NR*` → NR，其余按前缀。
pub fn normalize_rat(v: &str) -> Option<&'static str> {
    let s = v.trim().to_ascii_uppercase();
    if s.is_empty() {
        return None;
    }
    if s == "6" || s.starts_with("LTE") {
        return Some("LTE");
    }
    if s == "7" || s == "11" || s.starts_with("NR") {
        return Some("NR");
    }
    if s.starts_with("WCDMA") || s == "3" {
        return Some("WCDMA");
    }
    if s.starts_with("GSM") || s == "1" {
        return Some("GSM");
    }
    None
}

/// 制式代际档位：决定理论峰值与调度效率的量级差异，与当前信号强弱无关。
fn rat_cap(rat: &str) -> Option<(Level, &'static str, &'static str)> {
    match rat {
        "NR" => Some((Level::Exc, "5G", "5G 制式，单载波带宽上限最高")),
        "LTE" => Some((Level::Good, "4G", "4G 制式，理论峰值明显低于 5G")),
        "WCDMA" => Some((Level::Poor, "3G", "3G 制式，仅够轻量上网")),
        "GSM" => Some((Level::Bad, "2G", "2G 制式，无法承载数据业务")),
        _ => None,
    }
}

/// 频段传播特性按中心频率分档：低频绕射好但带宽天生受限；Sub-6 中频是 5G 主力区；
/// 毫米波带宽大但穿透差。判据用实测频率而非频段号（频段号映射随 3GPP 版本扩展）。
fn band_prop(dl_freq_khz: f64) -> (Level, &'static str, &'static str) {
    let mhz = dl_freq_khz / 1000.0;
    if mhz < 1000.0 {
        (Level::Good, "低频", "穿透与覆盖好，但频谱窄、带宽受限")
    } else if mhz < 6000.0 {
        (Level::Exc, "中频", "Sub-6 主力频段，覆盖与带宽均衡")
    } else {
        (Level::Fair, "毫米波", "带宽大但穿透差，覆盖半径小")
    }
}

/// 单载波下行带宽档位。阈值必须按制式区分：LTE 单载波上限就是 20MHz，
/// 拿 NR 的尺子去量会把「4G 满配」误判成「带宽不足」。
fn bw_cap(bw_khz: f64, rat: Option<&str>) -> (Level, &'static str) {
    if rat == Some("LTE") {
        if bw_khz >= 19000.0 {
            (Level::Good, "已达 4G 单载波带宽上限")
        } else if bw_khz >= 14000.0 {
            (Level::Fair, "带宽尚可，峰值中等")
        } else {
            (Level::Poor, "带宽偏窄，峰值明显受限")
        }
    } else if bw_khz >= 80000.0 {
        (Level::Exc, "接近 5G 单载波满配")
    } else if bw_khz >= 45000.0 {
        (Level::Good, "带宽充裕")
    } else if bw_khz >= 24000.0 {
        (Level::Good, "带宽够用，峰值可观")
    } else if bw_khz >= 19000.0 {
        (Level::Fair, "带宽一般，峰值受限")
    } else {
        (Level::Poor, "带宽偏窄，峰值明显受限")
    }
}

/// 网络能力总评的结论项（标题 + 建议）。这套文案只存在于本文件，前端没有对应表。
#[derive(Debug, Clone, Copy)]
pub struct Verdict {
    pub level: Level,
    pub title: &'static str,
    pub advice: &'static str,
}

fn verdict_text(level: Level) -> Verdict {
    match level {
        Level::Exc => Verdict { level, title: "网络能力优秀", advice: "信号与频段带宽俱佳，适合高清视频及大文件下载" },
        Level::Good => Verdict { level, title: "网络能力良好", advice: "日常上网、视频与通话流畅无压力" },
        Level::Fair => Verdict { level, title: "网络能力一般", advice: "轻量使用够用，高清视频可能缓冲" },
        Level::Poor => Verdict { level, title: "网络能力偏弱", advice: "易卡顿掉线，建议调整位置或加天线" },
        Level::Bad => Verdict { level, title: "网络能力很差", advice: "基本无法上网，请检查天线与 SIM 卡" },
    }
}

/// 评估输入。
#[derive(Debug, Clone, Default)]
pub struct SignalInput {
    pub rat: String,
    pub rsrp: Option<f64>,
    pub rsrq: Option<f64>,
    pub sinr: Option<f64>,
    /// 服务小区下行频点（kHz），来自 `^HFREQINFO`
    pub dl_freq_khz: Option<f64>,
    /// 下行载波带宽（kHz），来自 `^HFREQINFO`
    pub dl_bw_khz: Option<f64>,
}

/// 完整评估结果。
#[derive(Debug, Clone, Default)]
pub struct Assessment {
    pub rsrp: Option<Grade>,
    pub rsrq: Option<Grade>,
    pub sinr: Option<Grade>,
    pub pct: Option<Grade>,
    pub signal_percent: Option<i64>,
    pub capability: Vec<CapItem>,
    /// 网络能力总评；两层证据都没有时为 None
    pub verdict: Option<Verdict>,
}

impl Assessment {
    pub fn new(input: &SignalInput) -> Assessment {
        let rsrp = input.rsrp.map(grade_rsrp);
        let rsrq = input.rsrq.map(grade_rsrq);
        let sinr = input.sinr.map(grade_sinr);
        let signal_percent = input.rsrp.and_then(signal_percent);
        let pct = signal_percent.map(grade_pct);

        let rat = normalize_rat(&input.rat);
        let mut capability = Vec::new();
        if let Some((level, label, note)) = rat.and_then(rat_cap) {
            capability.push(CapItem { label: "网络制式", value: label.to_string(), level, note });
        }
        if let Some(freq) = input.dl_freq_khz.filter(|f| *f > 0.0) {
            let (level, label, note) = band_prop(freq);
            capability.push(CapItem {
                label: "频段特性",
                value: format!("{} {:.0} MHz", label, freq / 1000.0),
                level,
                note,
            });
        }
        if let Some(bw) = input.dl_bw_khz.filter(|b| *b > 0.0) {
            let (level, note) = bw_cap(bw, rat);
            capability.push(CapItem {
                label: "载波带宽",
                value: format!("{} MHz", format_mhz(bw / 1000.0)),
                level,
                note,
            });
        }

        // 木桶原理两层取更差：信号档（四项最差）与能力档（三项最差）再取更差。
        // 只看信号档会得出「700MHz 上的 LTE 满格 ⇒ 适合下载大文件」这类乐观误判
        // —— 信号好只说明链路质量好，不等于网速快。
        let signal_worst = [rsrp.map(|x| x.level), rsrq.map(|x| x.level), sinr.map(|x| x.level), pct.map(|x| x.level)]
            .into_iter()
            .flatten()
            .max();
        let cap_worst = capability.iter().map(|c| c.level).max();
        let verdict = match (signal_worst, cap_worst) {
            (None, None) => None,
            (a, b) => Some(verdict_text(a.max(b).unwrap_or(Level::Fair))),
        };

        Assessment { rsrp, rsrq, sinr, pct, signal_percent, capability, verdict }
    }
}

/// 带宽显示：整数不带小数点（100 MHz），非整数保留一位（19.8 MHz）。
fn format_mhz(v: f64) -> String {
    if (v - v.round()).abs() < 0.05 {
        format!("{}", v.round() as i64)
    } else {
        format!("{v:.1}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rsrp_thresholds_match_frontend() {
        assert_eq!(grade_rsrp(-63.0).text, "极佳");
        assert_eq!(grade_rsrp(-63.0).status, "覆盖极佳");
        assert_eq!(grade_rsrp(-85.0).text, "良好");
        assert_eq!(grade_rsrp(-95.0).text, "一般");
        assert_eq!(grade_rsrp(-105.0).text, "较差");
        assert_eq!(grade_rsrp(-115.0).text, "极差");
        // 边界值归入更高一档
        assert_eq!(grade_rsrp(-80.0).level, Level::Exc);
        assert_eq!(grade_rsrp(-90.0).level, Level::Good);
        assert_eq!(grade_rsrp(-100.0).level, Level::Fair);
        assert_eq!(grade_rsrp(-110.0).level, Level::Poor);
    }

    #[test]
    fn rsrq_and_sinr_thresholds_match_frontend() {
        assert_eq!(grade_rsrq(-10.0).status, "纯净通畅");
        assert_eq!(grade_rsrq(-12.0).status, "轻微扰动");
        assert_eq!(grade_rsrq(-15.0).status, "中度负载");
        assert_eq!(grade_rsrq(-17.0).status, "邻区拥塞");
        assert_eq!(grade_rsrq(-19.0).status, "强干扰区");

        assert_eq!(grade_sinr(28.0).status, "顶速阶数");
        assert_eq!(grade_sinr(15.0).status, "稳定传输");
        assert_eq!(grade_sinr(8.0).status, "速率受限");
        assert_eq!(grade_sinr(2.0).status, "频发重传");
        assert_eq!(grade_sinr(-3.0).status, "严重丢包");
    }

    #[test]
    fn percent_uses_30db_span() {
        // (rsrp + 110) / 30，量程 -110 → 0%，-80 → 100%。
        // 这条断言锁的是**后端自己的**口径；前端 rpc.js 用的是 /40（-70 满格），两边并不相同。
        assert_eq!(signal_percent(-110.0), Some(0));
        assert_eq!(signal_percent(-95.0), Some(50));
        assert_eq!(signal_percent(-80.0), Some(100));
        // 超出量程两端都要夹住，不能产生负百分比或 >100
        assert_eq!(signal_percent(-130.0), Some(0));
        assert_eq!(signal_percent(-60.0), Some(100));
        // 0 与正数视为无效（与前端 `if (!rsrp || rsrp >= 0) return ''` 对齐）
        assert_eq!(signal_percent(0.0), None);
        assert_eq!(signal_percent(12.0), None);
    }

    #[test]
    fn percent_grading_matches_frontend() {
        assert_eq!(grade_pct(95).text, "极佳");
        assert_eq!(grade_pct(95).status, "满格服务");
        assert_eq!(grade_pct(60).level, Level::Good);
        assert_eq!(grade_pct(40).level, Level::Fair);
        assert_eq!(grade_pct(20).level, Level::Poor);
        assert_eq!(grade_pct(0).level, Level::Bad);
    }

    #[test]
    fn rat_normalization_handles_numeric_and_text_forms() {
        assert_eq!(normalize_rat("7"), Some("NR"));
        assert_eq!(normalize_rat("NR"), Some("NR"));
        assert_eq!(normalize_rat("nr"), Some("NR"));
        assert_eq!(normalize_rat("6"), Some("LTE"));
        assert_eq!(normalize_rat("LTE"), Some("LTE"));
        assert_eq!(normalize_rat("WCDMA"), Some("WCDMA"));
        assert_eq!(normalize_rat("GSM"), Some("GSM"));
        assert_eq!(normalize_rat("未知"), None);
        assert_eq!(normalize_rat(""), None);
    }

    #[test]
    fn good_signal_on_5g_scores_excellent() {
        // 实测场景：NR n41 100MHz、RSRP -62、RSRQ -10、SINR 28
        let a = Assessment::new(&SignalInput {
            rat: "NR".into(),
            rsrp: Some(-62.0),
            rsrq: Some(-10.0),
            sinr: Some(28.0),
            dl_freq_khz: Some(2_565_000.0),
            dl_bw_khz: Some(100_000.0),
        });
        assert_eq!(a.signal_percent, Some(100));
        assert_eq!(a.pct.unwrap().text, "极佳");
        assert_eq!(a.rsrp.unwrap().text, "极佳");
        assert_eq!(a.capability.len(), 3, "制式/频段/带宽三项都应给出");
        let v = a.verdict.expect("应有总评");
        assert_eq!(v.title, "网络能力优秀");
        assert_eq!(v.advice, "信号与频段带宽俱佳，适合高清视频及大文件下载");
    }

    #[test]
    fn strong_lte_on_low_band_is_not_rated_excellent() {
        // 木桶原理的核心用例：700MHz 上的 LTE 信号满格（RSRP -70 属极佳），
        // 但制式(4G=良好)与带宽(20MHz=良好)把总评压到「良好」。
        // 若只看信号档就会误报「适合下载大文件」。
        let a = Assessment::new(&SignalInput {
            rat: "LTE".into(),
            rsrp: Some(-70.0),
            rsrq: Some(-9.0),
            sinr: Some(22.0),
            dl_freq_khz: Some(950_000.0),
            dl_bw_khz: Some(20_000.0),
        });
        assert_eq!(a.rsrp.unwrap().level, Level::Exc);
        let v = a.verdict.expect("应有总评");
        assert_eq!(v.level, Level::Good, "能力档应把总评拉到良好，而不是极佳");
        assert_eq!(v.title, "网络能力良好");
    }

    #[test]
    fn weakest_signal_metric_drags_verdict_down() {
        // RSRP 很好但 SINR 极差（强干扰）：信号档取最差 → 极差
        let a = Assessment::new(&SignalInput {
            rat: "NR".into(),
            rsrp: Some(-70.0),
            rsrq: Some(-9.0),
            sinr: Some(-5.0),
            dl_freq_khz: Some(3_500_000.0),
            dl_bw_khz: Some(100_000.0),
        });
        let v = a.verdict.expect("应有总评");
        assert_eq!(v.level, Level::Bad);
        assert_eq!(v.title, "网络能力很差");
    }

    #[test]
    fn missing_metrics_are_skipped_instead_of_treated_as_worst() {
        // 只有 RSRP 可用（LTE 不报 SINR）：不应因为「缺失」被当成最差档
        let a = Assessment::new(&SignalInput {
            rat: "LTE".into(),
            rsrp: Some(-75.0),
            rsrq: None,
            sinr: None,
            dl_freq_khz: None,
            dl_bw_khz: None,
        });
        assert!(a.rsrq.is_none());
        assert!(a.sinr.is_none());
        // 能力档只剩制式(4G=良好)，总评取两者更差 → 良好
        assert_eq!(a.capability.len(), 1);
        assert_eq!(a.verdict.unwrap().level, Level::Good);
    }

    #[test]
    fn no_data_yields_no_verdict() {
        let a = Assessment::new(&SignalInput::default());
        assert!(a.verdict.is_none());
        assert!(a.capability.is_empty());
        assert!(a.rsrp.is_none());
    }

    #[test]
    fn bandwidth_label_keeps_decimals_only_when_needed() {
        assert_eq!(format_mhz(100.0), "100");
        assert_eq!(format_mhz(20.0), "20");
        assert_eq!(format_mhz(19.8), "19.8");
    }
}
