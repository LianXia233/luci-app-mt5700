// Frequency-lock application and the `advanced-set` validators/actors that
// `mt5700m-at` delegates to.  Ports of `apply_frequency_lock`, `set_radio_mode`,
// `set_radio_policy`, `set_5g_access_mode`, `valid_thermal_thresholds`,
// `valid_pin`, `valid_puk`, `safe_at_field`.

use crate::at::config::AtConfig;
use crate::at::parse::first_match;
use crate::at::transport::{at_cmd, at_query};
use crate::error::Result;

fn clean_value(s: &str) -> String {
    let s = s.trim();
    let s = s.strip_prefix('"').unwrap_or(s);
    let s = s.strip_suffix('"').unwrap_or(s);
    s.trim().to_string()
}

/// Port of `apply_frequency_lock`.  Sends `lock_cmd`, briefly cycles the radio
/// function level when the module was online, then verifies the lock type took
/// effect.  Returns the raw verification response on success, or an error
/// carrying the shell-equivalent exit code.
pub fn apply_frequency_lock(cfg: &AtConfig, rat: &str, lock_type: &str, lock_cmd: &str) -> Result<String> {
    let (query, prefix) = if rat == "lte" {
        ("AT^LTEFREQLOCK?", "^LTEFREQLOCK")
    } else {
        ("AT^NRFREQLOCK?", "^NRFREQLOCK")
    };

    let raw = at_query(cfg, "AT+CFUN?");
    let previous = first_match(&raw, "+CFUN:")
        .map(|v| clean_value(&v))
        .unwrap_or_else(|| "1".to_string());
    let previous = if previous == "0" || previous == "1" {
        previous
    } else {
        "1".to_string()
    };

    let rc = at_cmd(cfg, lock_cmd).rc;
    if rc != 0 {
        return Err(crate::error::MtError("lock command rejected".into()));
    }

    if previous == "1" {
        let _ = at_cmd(cfg, "AT+CFUN=0");
        std::thread::sleep(std::time::Duration::from_secs(1));
        let _ = at_cmd(cfg, "AT+CFUN=1");
    }

    let mut attempt = 0;
    while attempt < 8 {
        let raw = at_query(cfg, query);
        let current = first_match(&raw, prefix)
            .map(|v| clean_value(&v))
            .map(|v| v.split(',').next().unwrap_or("").to_string())
            .unwrap_or_default();
        if current == lock_type {
            return Ok(raw);
        }
        if previous == "0" {
            break;
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
        attempt += 1;
    }
    Err(crate::error::MtError(format!(
        "MT5700M frequency lock verification failed: expected {}, got no response",
        lock_type
    )))
}

/// Port of `set_radio_mode`.
pub fn set_radio_mode(cfg: &AtConfig, requested: &str) -> i32 {
    match requested {
        "02" | "03" | "08" | "0302" | "0803" | "080302" => {}
        _ => return 64,
    }
    let raw = at_query(cfg, "AT^SYSCFGEX?");
    let current = match first_match(&raw, "^SYSCFGEX:") {
        Some(v) => v,
        None => return 1,
    };
    let suffix = current.split(',').skip(1).collect::<Vec<_>>().join(",");
    if suffix.is_empty() {
        return 1;
    }
    at_cmd(cfg, &format!("AT^SYSCFGEX=\"{}\",{}", requested, suffix)).rc
}

/// Port of `set_radio_policy`.
pub fn set_radio_policy(cfg: &AtConfig, args: &[&str]) -> i32 {
    if args.len() < 5 {
        return 64;
    }
    let acqorder = args[0];
    let band = args[1];
    let roam = args[2];
    let srvdomain = args[3];
    let lteband = args[4];
    match acqorder {
        "02" | "03" | "08" | "0302" | "0803" | "080302" => {}
        _ => return 64,
    }
    if !is_hex(band) || !is_hex(lteband) {
        return 64;
    }
    match roam {
        "0" | "1" => {}
        _ => return 64,
    }
    match srvdomain {
        "1" | "2" => {}
        _ => return 64,
    }
    at_cmd(
        cfg,
        &format!("AT^SYSCFGEX=\"{}\",{},{},{},{},,,", acqorder, band, roam, srvdomain, lteband),
    )
    .rc
}

/// Port of `set_5g_access_mode`.
pub fn set_5g_access_mode(cfg: &AtConfig, preset: &str) -> i32 {
    let values = match preset {
        "option2" => "1,0,1",
        "option3" => "0,1,0",
        "option23" => "1,1,1",
        _ => return 64,
    };
    let raw = at_query(cfg, "AT+CFUN?");
    let previous = first_match(&raw, "+CFUN:")
        .map(|v| clean_value(&v))
        .unwrap_or_else(|| "1".to_string());
    let previous = if previous == "0" || previous == "1" {
        previous
    } else {
        "1".to_string()
    };
    let _ = at_cmd(cfg, "AT+CFUN=0");
    let result = at_cmd(cfg, &format!("AT^C5GOPTION={}", values));
    if previous != "0" {
        let _ = at_cmd(cfg, &format!("AT+CFUN={}", previous));
    }
    if !result.response.is_empty() {
        println!("{}", result.response);
    }
    result.rc
}

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn valid_thermal_thresholds(args: &[&str]) -> bool {
    if args.len() != 9 {
        return false;
    }
    for a in args {
        match a.parse::<i64>() {
            Ok(n) if (0..=150).contains(&n) => {}
            _ => return false,
        }
    }
    let n: Vec<i64> = args.iter().map(|a| a.parse::<i64>().unwrap()).collect();
    if n[1] <= n[0] || n[3] <= n[2] || n[5] <= n[4] || n[7] <= n[6] {
        return false;
    }
    if n[2] >= n[1] || n[4] >= n[3] || n[6] >= n[5] || n[8] >= n[7] {
        return false;
    }
    true
}

pub fn safe_at_field(s: &str) -> bool {
    !s.contains('"') && !s.contains(',') && !s.contains('\r') && !s.contains('\n')
}

pub fn valid_pin(s: &str) -> bool {
    let len = s.chars().count();
    len >= 4 && len <= 8 && s.chars().all(|c| c.is_ascii_digit())
}

pub fn valid_puk(s: &str) -> bool {
    s.chars().count() == 8 && s.chars().all(|c| c.is_ascii_digit())
}
