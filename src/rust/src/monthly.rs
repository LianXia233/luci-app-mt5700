//! 按月（每月固定几号）触发的周期计算。
//!
//! # 为什么单独成模块
//!
//! 使用量的自动清零原来是「累计满 N 天」，问题是它跟自然月完全脱节：
//! 用户想的是「每月 1 号重新计一次」（对账日口径），而按 30 天滚动会在
//! 月里漂移、还要自己算对齐。改成「每月几号」后，需要一套**日历语义**的
//! 判定：大小月、闰年、跨年、以及「31 号在小月怎么办」。
//!
//! 这些是纯日期算术，跟使用量统计、跟网络、跟 UCI 都没关系，因此单独放这里，
//! `usage` 只调用 [`should_reset`] 一个函数，不把日历逻辑塞进统计模块。
//!
//! # 大小月与闰年口径
//!
//! | 设定 | 1 月 | 2 月（平） | 2 月（闰） | 4/6/9/11 月 |
//! |:--|:--|:--|:--|:--|
//! | 每月 31 号 | 31 号 | **28 号** | **29 号** | **30 号** |
//! | 每月 30 号 | 30 号 | **28 号** | **29 号** | 30 号 |
//!
//! 即：**目标日超过当月天数时，按当月最后一天触发**（不是跳过、也不是顺延到下月）。
//! 这样「每月 31 号」在 2 月也会清一次，不会整月漏清。
//!
//! # 判定时点
//!
//! 触发时刻是目标日 **00:00:00（本地时区）**。用「本次累计起点 `start_ts`
//! 之后的第一个触发时刻」与当前时刻比较，天然满足：
//!   - 一个月只清一次（清零后 `start_ts` 前进到当下，下次目标自动是下个月）；
//!   - 月中改设置立刻生效（重新以当前 `start_ts` 推算）；
//!   - 跨年、跨大小月都不需要额外状态。

use chrono::{Datelike, FixedOffset, TimeZone};

/// 默认清零日：每月 1 号（最常见对账口径）。
pub const DEFAULT_RESET_DAY: u32 = 1;
/// 清零日下限。
pub const MIN_RESET_DAY: u32 = 1;
/// 清零日上限（一个月最多 31 天）。
pub const MAX_RESET_DAY: u32 = 31;

/// 是否闰年（格里高利历：能被 4 整除且不被 100 整除，或被 400 整除）。
pub fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// 某年某月的天数；月份非法返回 `None`。
pub fn days_in_month(year: i32, month: u32) -> Option<u32> {
    let d = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => return None,
    };
    Some(d)
}

/// 把「每月 N 号」夹到当月实际存在的一天（31 号在 2 月 → 28/29 号）。
///
/// 入参 `day` 已假定落在 [`MIN_RESET_DAY`..`MAX_RESET_DAY`]，这里只做月份夹取。
pub fn clamp_day(day: u32, year: i32, month: u32) -> u32 {
    match days_in_month(year, month) {
        Some(max) => day.min(max).max(1),
        None => day.clamp(MIN_RESET_DAY, MAX_RESET_DAY),
    }
}

/// 归一化清零日配置：非法值（0 或 > 31）夹回 [`MIN_RESET_DAY`..`MAX_RESET_DAY`]。
pub fn normalize_day(day: u32) -> u32 {
    day.clamp(MIN_RESET_DAY, MAX_RESET_DAY)
}

/// `start_ts` 之后的**下一个**清零时刻（目标日 00:00:00，本地时区）。
///
/// - 若本月目标日还没到 → 就是本月目标日；
/// - 若本月目标日已过（或正好等于起点，避免同一秒重复清零）→ 顺延到下个月，
///   并按下个月的天数重新夹取（跨年自动进位到次年 1 月）。
///
/// 返回 `None` 只可能是时间戳越界（chrono 不支持的范围），调用方按「不清零」处理。
pub fn next_reset_ts(start_ts: i64, day: u32, offset: FixedOffset) -> Option<i64> {
    let start = offset.timestamp_opt(start_ts, 0).single()?;
    let day = normalize_day(day);

    let mut year = start.year();
    let mut month = start.month();
    let mut candidate = month_instant(year, month, day, offset)?;

    // 用 `<=` 而非 `<`：起点正好落在清零时刻（刚清完）时，下一次应是下个月
    if candidate <= start_ts {
        month += 1;
        if month > 12 {
            month = 1;
            year += 1;
        }
        candidate = month_instant(year, month, day, offset)?;
    }
    Some(candidate)
}

/// 某年某月目标日 00:00:00 的 unix 秒（按当月天数夹取）。
fn month_instant(year: i32, month: u32, day: u32, offset: FixedOffset) -> Option<i64> {
    let d = clamp_day(day, year, month);
    offset
        .with_ymd_and_hms(year, month, d, 0, 0, 0)
        .single()
        .map(|dt| dt.timestamp())
}

/// 当下是否应当清零：`now_ts` 已越过 `start_ts` 之后的第一个清零时刻。
pub fn should_reset(now_ts: i64, start_ts: i64, day: u32, offset: FixedOffset) -> bool {
    if start_ts <= 0 {
        // 还没建立基线（首次采样），不清零
        return false;
    }
    match next_reset_ts(start_ts, day, offset) {
        Some(target) => now_ts >= target,
        None => false,
    }
}

/// 给日志/UI 用的一句话说明，例如「每月 31 号（小月按当月最后一天）」。
pub fn describe(day: u32) -> String {
    let day = normalize_day(day);
    if day > 28 {
        format!("每月 {day} 号（当月不足 {day} 天时按月末）")
    } else {
        format!("每月 {day} 号")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 北京时间 UTC+8（本地时区口径：所有日期都按本地时区解释）。
    fn tz() -> FixedOffset {
        FixedOffset::east_opt(8 * 3600).unwrap()
    }

    /// 本地时间 (y,m,d,h) → unix 秒
    fn ts(y: i32, m: u32, d: u32, h: u32) -> i64 {
        tz().with_ymd_and_hms(y, m, d, h, 0, 0).unwrap().timestamp()
    }

    #[test]
    fn month_lengths_cover_leap_rules() {
        assert_eq!(days_in_month(2026, 2), Some(28), "平年 2 月");
        assert_eq!(days_in_month(2024, 2), Some(29), "闰年 2 月（能被 4 整除）");
        assert_eq!(days_in_month(1900, 2), Some(28), "整百年不闰（1900）");
        assert_eq!(days_in_month(2000, 2), Some(29), "能被 400 整除仍闰（2000）");
        assert_eq!(days_in_month(2026, 4), Some(30));
        assert_eq!(days_in_month(2026, 12), Some(31));
        assert_eq!(days_in_month(2026, 13), None, "月份非法");
    }

    #[test]
    fn day_31_falls_back_to_month_end() {
        assert_eq!(clamp_day(31, 2026, 2), 28, "平年 2 月 → 28 号");
        assert_eq!(clamp_day(31, 2024, 2), 29, "闰年 2 月 → 29 号");
        assert_eq!(clamp_day(31, 2026, 4), 30, "小月 → 30 号");
        assert_eq!(clamp_day(31, 2026, 1), 31, "大月照旧");
        assert_eq!(clamp_day(30, 2026, 2), 28, "30 号在平年 2 月同样按月末");
    }

    #[test]
    fn normalize_day_clamps_config() {
        assert_eq!(normalize_day(0), MIN_RESET_DAY, "0 不能变成「永不清零」");
        assert_eq!(normalize_day(99), MAX_RESET_DAY);
        assert_eq!(normalize_day(15), 15);
        assert_eq!(DEFAULT_RESET_DAY, 1, "默认每月 1 号");
    }

    #[test]
    fn next_reset_is_this_month_when_not_reached() {
        // 起点 10 月 5 日 → 下次是 10 月 31 日 00:00
        assert_eq!(next_reset_ts(ts(2026, 10, 5, 9), 31, tz()), Some(ts(2026, 10, 31, 0)));
        // 起点 10 月 5 日，每月 1 号 → 本月 1 号已过，应是 11 月 1 号
        assert_eq!(next_reset_ts(ts(2026, 10, 5, 9), 1, tz()), Some(ts(2026, 11, 1, 0)));
    }

    #[test]
    fn next_reset_rolls_to_next_month_after_the_day() {
        // 10 月 31 日当天已清零过（start == 目标时刻）→ 下一个是 11 月 30 日（11 月只有 30 天）
        assert_eq!(next_reset_ts(ts(2026, 10, 31, 0), 31, tz()), Some(ts(2026, 11, 30, 0)));
        // 10 月 31 日 12:00（已过 00:00）→ 同样是 11 月 30 日
        assert_eq!(next_reset_ts(ts(2026, 10, 31, 12), 31, tz()), Some(ts(2026, 11, 30, 0)));
    }

    #[test]
    fn next_reset_crosses_year_boundary() {
        // 12 月 15 日 → 次年 1 月 1 日
        assert_eq!(next_reset_ts(ts(2026, 12, 15, 0), 1, tz()), Some(ts(2027, 1, 1, 0)));
        // 12 月 31 日（31 号已过）→ 次年 1 月 31 日
        assert_eq!(next_reset_ts(ts(2026, 12, 31, 8), 31, tz()), Some(ts(2027, 1, 31, 0)));
    }

    #[test]
    fn february_short_month_still_resets() {
        // 1 月 31 日清过 → 2 月只有 28 天，31 号要落到 2 月 28 日，而不是跳过整月
        assert_eq!(next_reset_ts(ts(2026, 1, 31, 0), 31, tz()), Some(ts(2026, 2, 28, 0)));
        // 闰年则落到 2 月 29 日
        assert_eq!(next_reset_ts(ts(2024, 1, 31, 0), 31, tz()), Some(ts(2024, 2, 29, 0)));
    }

    #[test]
    fn should_reset_boundaries() {
        let start = ts(2026, 10, 5, 9);
        let target = ts(2026, 10, 31, 0);
        assert!(!should_reset(target - 1, start, 31, tz()), "差一秒不到点");
        assert!(should_reset(target, start, 31, tz()), "到点即清零");
        assert!(should_reset(target + 3600, start, 31, tz()), "过了点也要补清（设备曾关机）");
    }

    #[test]
    fn no_reset_without_baseline() {
        assert!(!should_reset(ts(2026, 10, 31, 0), 0, 31, tz()), "start_ts 未建立不清零");
        assert!(!should_reset(ts(2026, 10, 31, 0), -1, 31, tz()));
    }

    #[test]
    fn reset_happens_only_once_per_month() {
        // 清零后 start_ts 前进到「当下」，下一次目标必须落到下个月
        let first = ts(2026, 10, 5, 9);
        let target = next_reset_ts(first, 1, tz()).unwrap();
        assert_eq!(target, ts(2026, 11, 1, 0));
        let after = next_reset_ts(target, 1, tz()).unwrap();
        assert_eq!(after, ts(2026, 12, 1, 0), "同一个月内不能重复清零");
    }

    #[test]
    fn describe_mentions_month_end_for_late_days() {
        assert_eq!(describe(1), "每月 1 号");
        assert_eq!(describe(28), "每月 28 号");
        assert!(describe(31).contains("月末"));
    }
}
