//! 定时锁频配置：DTO <-> UCI 转换与校验，并定义 AT+SCHED 伪命令字面量。

use chrono::Timelike;
use crate::config::{BandLock, ScheduleConfig};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

pub const SCHED_QUERY_COMMAND: &str = "AT+SCHED?";
pub const SCHED_SET_PREFIX: &str = "AT+SCHED=";
pub const SCHED_RESPONSE_PREFIX: &str = "+SCHED: ";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BandLockDto {
    #[serde(rename = "type")]
    pub type_: i64,
    pub bands: String,
    pub arfcns: String,
    #[serde(rename = "scs_types")]
    pub scs_types: String,
    pub pcis: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedPeriodDto {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    pub lte: BandLockDto,
    pub nr: BandLockDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedStatusDto {
    pub current_mode: String,
    /// 下一次切换的钟点（HH:MM），沿用历史字段名，LuCI 旧版本仍能解析。
    pub next_switch: String,
    pub switch_count: i64,
    pub applied: bool,
    /// 下一次切换的完整本地时刻（YYYY-MM-DD HH:MM，时间取插件自己的时间源）。
    ///
    /// 只给 HH:MM 时，22:00 与「明天 06:00」在页面上长得一样，用户没法判断
    /// 这一次到底是今天还是明天。多给一个带日期的串，前端直接回显即可。
    #[serde(default)]
    pub next_switch_time: String,
    /// 距下一次切换还有多少秒（0 表示当前正好是切换点，-1 表示没有可用的时段端点）。
    #[serde(default)]
    pub next_switch_in: i64,
    /// 插件当前时间（YYYY-MM-DD HH:MM:SS），与上面两个字段同一时间源同一时刻。
    #[serde(default)]
    pub server_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedConfigDto {
    pub enabled: bool,
    pub check_interval: i64,
    pub timeout: i64,
    pub unlock_lte: bool,
    pub unlock_nr: bool,
    pub toggle_airplane: bool,
    pub night: SchedPeriodDto,
    pub day: SchedPeriodDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<SchedStatusDto>,
}

pub fn to_band_lock_dto(l: &BandLock) -> BandLockDto {
    BandLockDto {
        type_: l.type_,
        bands: l.bands.clone(),
        arfcns: l.arfcns.clone(),
        scs_types: l.scs_types.clone(),
        pcis: l.pcis.clone(),
    }
}

impl BandLockDto {
    fn to_band_lock(&self) -> BandLock {
        BandLock {
            type_: self.type_,
            bands: self.bands.clone(),
            arfcns: self.arfcns.clone(),
            scs_types: self.scs_types.clone(),
            pcis: self.pcis.clone(),
        }
    }
}

pub fn schedule_to_dto(cfg: &ScheduleConfig) -> SchedConfigDto {
    SchedConfigDto {
        enabled: cfg.enabled,
        check_interval: cfg.check_interval.as_secs() as i64,
        timeout: cfg.no_service_limit.as_secs() as i64,
        unlock_lte: cfg.unlock_lte,
        unlock_nr: cfg.unlock_nr,
        toggle_airplane: cfg.toggle_airplane,
        night: SchedPeriodDto {
            enabled: cfg.night_enabled,
            start: Some(cfg.night_start.clone()),
            end: Some(cfg.night_end.clone()),
            lte: to_band_lock_dto(&cfg.night_lte),
            nr: to_band_lock_dto(&cfg.night_nr),
        },
        day: SchedPeriodDto {
            enabled: cfg.day_enabled,
            start: None,
            end: None,
            lte: to_band_lock_dto(&cfg.day_lte),
            nr: to_band_lock_dto(&cfg.day_nr),
        },
        status: None,
    }
}

pub fn dto_to_schedule(d: &SchedConfigDto) -> ScheduleConfig {
    ScheduleConfig {
        enabled: d.enabled,
        check_interval: Duration::from_secs(d.check_interval.max(0) as u64),
        no_service_limit: Duration::from_secs(d.timeout.max(0) as u64),
        unlock_lte: d.unlock_lte,
        unlock_nr: d.unlock_nr,
        toggle_airplane: d.toggle_airplane,
        night_enabled: d.night.enabled,
        night_start: d.night.start.clone().unwrap_or_default(),
        night_end: d.night.end.clone().unwrap_or_default(),
        night_lte: d.night.lte.to_band_lock(),
        night_nr: d.night.nr.to_band_lock(),
        day_enabled: d.day.enabled,
        day_lte: d.day.lte.to_band_lock(),
        day_nr: d.day.nr.to_band_lock(),
    }
}

pub fn parse_hhmm(v: &str) -> Option<i64> {
    let v = v.trim();
    let (h, m) = v.split_once(':')?;
    let hour: i64 = h.trim().parse().ok()?;
    let minute: i64 = m.trim().parse().ok()?;
    if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) {
        return None;
    }
    Some(hour * 60 + minute)
}

pub fn split_list(v: &str) -> Vec<String> {
    v.split(',')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

/// 3GPP TS 36.101 主要频段的 EARFCN 范围。
pub fn lte_band_arfcn() -> &'static HashMap<i64, (i64, i64)> {
    use std::sync::OnceLock;
    static T: OnceLock<HashMap<i64, (i64, i64)>> = OnceLock::new();
    T.get_or_init(|| {
        let mut m = HashMap::new();
        for (b, r) in [
            (1, (0, 599)), (2, (600, 1199)), (3, (1200, 1949)), (4, (1950, 2399)), (5, (2400, 2649)),
            (7, (2750, 3449)), (8, (3450, 3799)), (12, (5010, 5179)), (13, (5180, 5279)),
            (17, (5730, 5849)), (18, (5850, 5999)), (19, (6000, 6149)), (20, (6150, 6449)),
            (25, (8040, 8689)), (26, (8690, 9039)), (28, (9210, 9659)), (38, (37750, 38249)),
            (39, (38250, 38649)), (40, (38650, 39649)), (41, (39650, 41589)), (42, (41590, 43589)),
            (43, (43590, 45589)), (66, (66436, 67335)),
        ] {
            m.insert(b, r);
        }
        m
    })
}

/// 3GPP TS 38.104 主要频段的 NR-ARFCN 下行范围。
pub fn nr_band_arfcn() -> &'static HashMap<i64, (i64, i64)> {
    use std::sync::OnceLock;
    static T: OnceLock<HashMap<i64, (i64, i64)>> = OnceLock::new();
    T.get_or_init(|| {
        let mut m = HashMap::new();
        for (b, r) in [
            (1, (422000, 434000)), (2, (386000, 398000)), (3, (361000, 376000)),
            (5, (173800, 178800)), (7, (524000, 538000)), (8, (185000, 192000)),
            (12, (145800, 149200)), (20, (158200, 164200)), (25, (386000, 399000)),
            (28, (151600, 160600)), (34, (402000, 405000)), (38, (514000, 524000)),
            (39, (376000, 384000)), (40, (460000, 480000)), (41, (499200, 537999)),
            (48, (636667, 646666)), (66, (422000, 440000)), (71, (123400, 130400)),
            (77, (620000, 680000)), (78, (620000, 653333)), (79, (693334, 733333)),
            (257, (2054166, 2104165)), (258, (2016667, 2070832)),
            (260, (2229166, 2279165)), (261, (2070833, 2084999)),
        ] {
            m.insert(b, r);
        }
        m
    })
}

fn all_numeric(label: &str, values: &[String], max: i64) -> Result<(), String> {
    for v in values {
        match v.parse::<i64>() {
            Ok(n) if n >= 0 && n <= max => {}
            _ => return Err(format!("{label} {v:?} 不是有效的非负整数（0-{max}）")),
        }
    }
    Ok(())
}

impl BandLockDto {
    fn validate(&self, label: &str, table: &HashMap<i64, (i64, i64)>, max_pci: i64) -> Result<(), String> {
        if self.type_ == 0 {
            return Ok(());
        }
        if !(0..=3).contains(&self.type_) {
            return Err(format!("{label} 锁定类型只能是 0-3，当前为 {}", self.type_));
        }

        let bands = split_list(&self.bands);
        if bands.is_empty() {
            return Err(format!("{label} 已启用锁定但没有填频段"));
        }
        if bands.len() > 20 {
            return Err(format!("{label} 最多只能锁 20 组，当前 {} 组", bands.len()));
        }
        all_numeric(&format!("{label} 频段"), &bands, 65535)?;
        if self.type_ == 3 {
            return Ok(());
        }

        let arfcns = split_list(&self.arfcns);
        if arfcns.len() != bands.len() {
            return Err(format!("{label} 频点数量({})与频段数量({})不一致", arfcns.len(), bands.len()));
        }
        all_numeric(&format!("{label} 频点"), &arfcns, 4294967295)?;
        for (i, band_s) in bands.iter().enumerate() {
            let band: i64 = band_s.parse().unwrap_or(-1);
            let arfcn: i64 = arfcns[i].parse().unwrap_or(-1);
            if let Some((lo, hi)) = table.get(&band) {
                if arfcn < *lo || arfcn > *hi {
                    return Err(format!("{label} 频段 {band} 与频点 {arfcn} 不匹配（该频段频点范围 {lo}-{hi}）"));
                }
            }
        }

        let scs = split_list(&self.scs_types);
        if !scs.is_empty() {
            if scs.len() != bands.len() {
                return Err(format!("{label} SCS 数量({})与频段数量({})不一致", scs.len(), bands.len()));
            }
            all_numeric(&format!("{label} SCS"), &scs, 4)?;
        }
        if self.type_ == 1 {
            return Ok(());
        }

        let pcis = split_list(&self.pcis);
        if pcis.len() != bands.len() {
            return Err(format!("{label} PCI 数量({})与频段数量({})不一致", pcis.len(), bands.len()));
        }
        all_numeric(&format!("{label} PCI"), &pcis, max_pci)
    }
}

impl SchedConfigDto {
    /// 在落盘前挡住会让模组锁到不存在小区上的配置。
    pub fn validate(&self) -> Result<(), String> {
        if self.check_interval < 10 {
            return Err("检测间隔不能小于 10 秒".into());
        }
        if self.timeout < 30 {
            return Err("无服务超时不能小于 30 秒".into());
        }
        let start = self.night.start.as_deref().unwrap_or("");
        let end = self.night.end.as_deref().unwrap_or("");
        if parse_hhmm(start).is_none() {
            return Err(format!("夜间开始时间格式应为 HH:MM，当前为 {start:?}"));
        }
        if parse_hhmm(end).is_none() {
            return Err(format!("夜间结束时间格式应为 HH:MM，当前为 {end:?}"));
        }
        for (label, item) in [("夜间", &self.night), ("日间", &self.day)] {
            if !item.enabled {
                continue;
            }
            item.lte.validate(&format!("{label} LTE"), lte_band_arfcn(), 503)?;
            item.nr.validate(&format!("{label} NR"), nr_band_arfcn(), 1007)?;
        }
        Ok(())
    }

    /// 摊平成 uci key/value。键名与 `config.rs` 的 schedule 读取侧一一对应；
    /// LuCI 定时页认的是 `AT+SCHED` JSON 里的 DTO 字段名（check_interval / night.lte.bands
    /// 等），从不出现 `schedule_` 前缀——两套命名互转正是本模块的职责。
    pub fn uci_entries(&self) -> Vec<(String, String)> {
        let flag = |b: bool| if b { "1".to_string() } else { "0".to_string() };
        let mut out = vec![
            ("schedule_enabled".into(), flag(self.enabled)),
            ("schedule_check_interval".into(), self.check_interval.to_string()),
            ("schedule_timeout".into(), self.timeout.to_string()),
            ("schedule_unlock_lte".into(), flag(self.unlock_lte)),
            ("schedule_unlock_nr".into(), flag(self.unlock_nr)),
            ("schedule_toggle_airplane".into(), flag(self.toggle_airplane)),
            ("schedule_night_enabled".into(), flag(self.night.enabled)),
            ("schedule_night_start".into(), self.night.start.clone().unwrap_or_default()),
            ("schedule_night_end".into(), self.night.end.clone().unwrap_or_default()),
            ("schedule_day_enabled".into(), flag(self.day.enabled)),
        ];
        for (prefix, item) in [("schedule_night", &self.night), ("schedule_day", &self.day)] {
            for (kind, lock) in [("lte", &item.lte), ("nr", &item.nr)] {
                let base = format!("{prefix}_{kind}");
                out.push((format!("{base}_type"), lock.type_.to_string()));
                out.push((format!("{base}_bands"), lock.bands.clone()));
                out.push((format!("{base}_arfcns"), lock.arfcns.clone()));
                out.push((format!("{base}_scs_types"), lock.scs_types.clone()));
                out.push((format!("{base}_pcis"), lock.pcis.clone()));
            }
        }
        out
    }
}

/// 落盘配置。用 exec 直接传参，不经过 shell，避免值里的引号被解释。
pub async fn write_schedule_uci(d: &SchedConfigDto) -> Result<(), String> {
    for (k, v) in d.uci_entries() {
        let arg = format!("at-webserver.config.{k}={v}");
        let out = tokio::process::Command::new("uci").args(["set", &arg]).output().await.map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("写入 {k} 失败: {}", String::from_utf8_lossy(&out.stderr)));
        }
    }
    let out = tokio::process::Command::new("uci").args(["commit", "at-webserver"]).output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("提交配置失败: {}", String::from_utf8_lossy(&out.stderr)));
    }
    Ok(())
}

/// 下一次时段切换距现在多少秒（1..=86400）。
///
/// 只认夜间时段的两个端点 —— 它们就是「模式切换时刻」的全部来源。
/// 返回值用于两件事：
///   1. 调度循环据此**提前醒来**，保证到点就切（见 `Scheduler::run`）；
///   2. 前端「下次切换」的倒计时文案。
pub fn seconds_to_next_switch(cfg: &ScheduleConfig, now: chrono::DateTime<crate::localtime::Tz>) -> Option<i64> {
    let cur = now.hour() as i64 * 3600 + now.minute() as i64 * 60 + now.second() as i64;
    [&cfg.night_start, &cfg.night_end]
        .iter()
        .filter_map(|v| parse_hhmm(v))
        .map(|m| {
            let mut d = m * 60 - cur;
            if d <= 0 {
                d += 86_400;
            }
            d
        })
        .min()
}

/// 下一次时段切换的完整本地时刻（`YYYY-MM-DD HH:MM`）。
///
/// 时刻一律由调用方传入的 `now` 推导（业务侧统一取 `nettime::now()`），
/// 本函数不自己去问时钟，便于单测固定时间。
pub fn next_switch_time(cfg: &ScheduleConfig, now: chrono::DateTime<crate::localtime::Tz>) -> String {
    match seconds_to_next_switch(cfg, now) {
        Some(secs) => (now + chrono::Duration::seconds(secs)).format("%Y-%m-%d %H:%M").to_string(),
        None => String::new(),
    }
}

/// 下一次时段切换的时刻（HH:MM），夜间时段的两个端点就是切换点。
pub fn next_switch_at(cfg: &ScheduleConfig, now: chrono::DateTime<crate::localtime::Tz>) -> String {
    match seconds_to_next_switch(cfg, now) {
        Some(secs) => (now + chrono::Duration::seconds(secs)).format("%H:%M").to_string(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{BandLock, ScheduleConfig};
    use chrono::DateTime;
    use std::time::Duration;

    fn cfg(start: &str, end: &str) -> ScheduleConfig {
        ScheduleConfig {
            enabled: true,
            check_interval: Duration::from_secs(60),
            no_service_limit: Duration::from_secs(300),
            unlock_lte: true,
            unlock_nr: true,
            toggle_airplane: false,
            night_enabled: true,
            night_start: start.into(),
            night_end: end.into(),
            night_lte: BandLock::default(),
            night_nr: BandLock::default(),
            day_enabled: true,
            day_lte: BandLock::default(),
            day_nr: BandLock::default(),
        }
    }

    /// 固定一个本地时刻（2026-10-31），避免测试依赖运行机器的当前时间。
    fn at(h: u32, m: u32, s: u32) -> DateTime<crate::localtime::Tz> {
        crate::localtime::from_ymdhms(2026, 10, 31, h, m, s).expect("构造合法时刻")
    }

    #[test]
    fn next_switch_points_to_night_start_before_it() {
        let c = cfg("22:00", "06:00");
        assert_eq!(next_switch_at(&c, at(21, 30, 0)), "22:00");
        assert_eq!(seconds_to_next_switch(&c, at(21, 30, 0)), Some(30 * 60));
    }

    #[test]
    fn next_switch_rolls_to_tomorrow_across_midnight() {
        let c = cfg("22:00", "06:00");
        // 23:00 之后的下一个端点是次日 06:00，不是「今天 22:00」
        assert_eq!(next_switch_at(&c, at(23, 0, 0)), "06:00");
        assert_eq!(seconds_to_next_switch(&c, at(23, 0, 0)), Some(7 * 3600));
        assert_eq!(next_switch_time(&c, at(23, 0, 0)), "2026-11-01 06:00");
    }

    #[test]
    fn next_switch_skips_exact_boundary_minute() {
        let c = cfg("22:00", "06:00");
        // 正好在切换点上时，报的是**下一个**端点，避免「还有 0 秒」被当成没切换
        assert_eq!(next_switch_at(&c, at(22, 0, 0)), "06:00");
        assert_eq!(seconds_to_next_switch(&c, at(22, 0, 1)), Some(8 * 3600 - 1));
    }

    #[test]
    fn next_switch_empty_when_endpoints_invalid() {
        let c = cfg("", "oops");
        assert_eq!(next_switch_at(&c, at(12, 0, 0)), "");
        assert_eq!(seconds_to_next_switch(&c, at(12, 0, 0)), None);
        assert_eq!(next_switch_time(&c, at(12, 0, 0)), "");
    }

    #[test]
    fn next_switch_never_exceeds_a_day() {
        let c = cfg("08:00", "20:00");
        for h in 0..24 {
            let secs = seconds_to_next_switch(&c, at(h, 0, 0)).expect("端点合法");
            assert!((1..=86_400).contains(&secs), "{h} 点算出的间隔异常: {secs}");
        }
    }
}
