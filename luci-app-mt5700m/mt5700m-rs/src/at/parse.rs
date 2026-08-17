// Pure-string parsers and AT command builders — faithful Rust ports of the
// `print_*`, `extract_*`, `normalize_rat` and `build_*_lock_command` helpers in
// `mt5700m-at`.  None of these touch the device directly; they consume the raw
// response text produced by `at_query` and emit the exact `key=value` / block
// format the LuCI front-end (`status.js`, `controls.js`) parses.

use crate::at::config::AtConfig;
use crate::at::transport::at_query;

// ----------------------------- helpers ----------------------------------

/// Port of `first_match`: first line whose (whitespace-trimmed) start matches
/// `prefix`; returns the remainder after stripping that prefix.
pub fn first_match(raw: &str, prefix: &str) -> Option<String> {
    for line in raw.split('\n') {
        let l = line.trim_matches(['\r', ' ']);
        if let Some(rest) = l.strip_prefix(prefix) {
            return Some(rest.trim().to_string());
        }
    }
    None
}

/// Port of `clean_value` / `clean_line_value`.
pub fn clean_value(s: &str) -> String {
    let s = s.trim();
    let s = s.strip_prefix('"').unwrap_or(s);
    let s = s.strip_suffix('"').unwrap_or(s);
    s.trim().to_string()
}

pub fn extract_cops_operator(raw: &str) -> Option<String> {
    let line = first_match(raw, "+COPS:")?;
    let line = line.replace('\r', "");
    if line.is_empty() {
        return None;
    }
    // First quoted field (awk -F\" -> $2).
    if let Some(start) = line.find('"') {
        let after = &line[start + 1..];
        if let Some(end) = after.find('"') {
            let name = clean_value(&after[..end]);
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    // Numeric MCC-MNC in a comma field.
    for field in line.split(',') {
        let f = field.trim();
        if f.len() >= 5 && f.len() <= 6 && f.chars().all(|c| c.is_ascii_digit()) {
            return Some(f.to_string());
        }
    }
    // Third comma field.
    let fields: Vec<&str> = line.split(',').collect();
    if fields.len() >= 3 {
        let third = clean_value(fields[2]);
        if !third.is_empty() {
            return Some(third);
        }
    }
    Some(clean_value(&line))
}

pub fn extract_cops_rat(raw: &str) -> Option<String> {
    let line = first_match(raw, "+COPS:")?;
    let line = line.replace([' ', '"', '\r'], "");
    if line.is_empty() {
        return None;
    }
    let fields: Vec<&str> = line.split(',').collect();
    if fields.len() >= 4 {
        let rat = fields[3];
        if !rat.is_empty() {
            return Some(normalize_rat(rat));
        }
    }
    None
}

pub fn extract_sysinfo_mode(raw: &str) -> Option<String> {
    let line = first_match(raw, "^SYSINFOEX:")?;
    let line = line.replace('\r', "");
    if line.is_empty() {
        return None;
    }
    let fields: Vec<&str> = line.split('"').collect();
    if fields.len() >= 2 {
        let mode = clean_value(fields[1]);
        if !mode.is_empty() {
            return Some(mode);
        }
    }
    Some(clean_value(&line))
}

pub fn normalize_rat(code: &str) -> String {
    match code {
        "0" => "GSM",
        "2" => "UTRAN",
        "3" => "GSM EDGE",
        "4" => "HSDPA",
        "5" => "HSUPA",
        "6" => "HSDPA/HSUPA",
        "7" => "LTE",
        "9" => "NR",
        "10" => "LTE-M",
        "11" => "NB-IoT",
        "13" => "LTE",
        "20" => "NR",
        other => other,
    }
    .to_string()
}

pub fn csv_count(value: &str) -> usize {
    let v = value.replace(' ', "");
    if v.is_empty() {
        return 0;
    }
    v.split(',').count()
}

pub fn clean_csv(value: &str) -> String {
    let v = value.replace(' ', "");
    let v = v.trim_start_matches(',').trim_end_matches(',').to_string();
    // collapse repeated commas
    let mut out = String::new();
    let mut prev_comma = false;
    for c in v.chars() {
        if c == ',' {
            if prev_comma {
                continue;
            }
            prev_comma = true;
        } else {
            prev_comma = false;
        }
        out.push(c);
    }
    out
}

pub fn valid_numeric_csv(value: &str) -> bool {
    !value.is_empty() && value.split(',').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

pub fn numeric_csv_in_range(value: &str, minimum: i64, maximum: i64) -> bool {
    if !valid_numeric_csv(value) {
        return false;
    }
    value.split(',').all(|p| {
        p.parse::<i64>().map(|n| n >= minimum && n <= maximum).unwrap_or(false)
    })
}

pub fn valid_lock_count(n: usize) -> bool {
    n >= 1 && n <= 20
}

// --------------------------- printers -----------------------------------

fn block(label: &str, command: &str, raw: &str) -> String {
    format!("===== {}: {} =====\n{}\n\n", label, command, raw.trim_end_matches(['\r', '\n']))
}

pub fn print_signal(cfg: &AtConfig) -> String {
    let raw = at_query(cfg, "AT^HCSQ?");
    // Locate the ^HCSQ: line and mimic the awk field logic.
    let line = match raw.lines().find(|l| l.trim_start_matches('\r').trim_start().starts_with("^HCSQ:")) {
        Some(l) => l.trim_start_matches('\r').trim_start().trim_start_matches("^HCSQ:").trim().to_string(),
        None => return String::new(),
    };
    let fields: Vec<String> = line.split(',').map(|s| s.replace([' ', '\r', '"'], "")).collect();
    let mut out = String::new();
    let sys = fields.first().cloned().unwrap_or_default();
    let valid = |v: &str| -> bool { v.chars().all(|c| c.is_ascii_digit()) && v != "255" };
    let num = |v: &str| v.parse::<i64>().unwrap_or(-9999);
    let print_rssi = |v: &str, out: &mut String| {
        if valid(v) {
            out.push_str(&format!("rssi={}\n", num(v) - 121));
        }
    };
    let print_rsrp = |v: &str, key: &str, out: &mut String| {
        if valid(v) {
            let n = num(v);
            if n >= 97 {
                out.push_str(&format!("{}=-44\n", key));
            } else {
                out.push_str(&format!("{}={}\n", key, n - 141));
            }
        }
    };
    let print_rscp = |v: &str, out: &mut String| {
        if valid(v) {
            let n = num(v);
            if n >= 96 {
                out.push_str("rscp=-25\n");
            } else {
                out.push_str(&format!("rscp={}\n", n - 121));
            }
        }
    };
    let print_sinr = |v: &str, out: &mut String| {
        if valid(v) {
            let n = num(v);
            if n >= 251 {
                out.push_str("sinr=30.0\n");
            } else {
                out.push_str(&format!("sinr={:.1}\n", -20.2 + n as f64 * 0.2));
            }
        }
    };
    let print_rsrq = |v: &str, out: &mut String| {
        if valid(v) {
            let n = num(v);
            if n >= 34 {
                out.push_str("rsrq=-3.0\n");
            } else {
                out.push_str(&format!("rsrq={:.1}\n", -20.0 + n as f64 * 0.5));
            }
        }
    };
    match sys.as_str() {
        "NR" => {
            if fields.len() >= 4 {
                print_rsrp(&fields[1], "rsrp", &mut out);
                print_sinr(&fields[2], &mut out);
                print_rsrq(&fields[3], &mut out);
            }
        }
        "LTE" => {
            if fields.len() >= 5 {
                print_rssi(&fields[1], &mut out);
                print_rsrp(&fields[2], "rsrp", &mut out);
                print_sinr(&fields[3], &mut out);
                print_rsrq(&fields[4], &mut out);
            }
        }
        "WCDMA" => {
            if fields.len() >= 4 {
                print_rssi(&fields[1], &mut out);
                print_rscp(&fields[2], &mut out);
                if let Some(ecio) = fields.get(3) {
                    if valid(ecio) {
                        out.push_str(&format!("ecio={:.1}\n", -32.5 + num(ecio) as f64 * 0.5));
                    }
                }
            }
        }
        "GSM" => {
            if !fields.is_empty() {
                print_rssi(&fields[1], &mut out);
            }
        }
        _ => {}
    }
    out
}

pub fn print_identity(cfg: &AtConfig) -> String {
    let raw = at_query(cfg, "ATI");
    let mut out = String::new();
    if let Some(v) = first_match(&raw, "Manufacturer:") {
        out.push_str(&format!("manufacturer={}\n", clean_value(&v)));
    }
    if let Some(v) = first_match(&raw, "Model:") {
        out.push_str(&format!("model={}\n", clean_value(&v)));
    }
    if let Some(v) = first_match(&raw, "Revision:") {
        out.push_str(&format!("revision={}\n", clean_value(&v)));
    }
    let mut imei = first_match(&raw, "IMEI:")
        .map(|v| clean_value(&v))
        .unwrap_or_default();
    if !is_15_digit(&imei) {
        imei = at_query(cfg, "AT+CGSN")
            .lines()
            .map(|l| l.trim_matches(['\r', ' ']).to_string())
            .find(|l| is_15_digit(l))
            .unwrap_or_default();
    }
    if is_15_digit(&imei) {
        out.push_str(&format!("imei={}\n", imei));
    }
    out.push_str("product_name=MT5700M\n");
    out
}

fn is_15_digit(s: &str) -> bool {
    s.len() == 15 && s.chars().all(|c| c.is_ascii_digit())
}

pub fn print_sim_operator(cfg: &AtConfig) -> String {
    let sim = at_query(cfg, "AT+CPIN?");
    let mut out = String::new();
    if let Some(v) = first_match(&sim, "+CPIN:") {
        out.push_str(&format!("sim={}\n", clean_value(&v)));
    }
    let cops = at_query(cfg, "AT+COPS?");
    if let Some(op) = extract_cops_operator(&cops) {
        out.push_str(&format!("operator={}\n", op));
    }
    if let Some(rat) = extract_cops_rat(&cops) {
        out.push_str(&format!("sysmode={}\n", rat));
    }
    let sysinfo = at_query(cfg, "AT^SYSINFOEX");
    if let Some(mode) = extract_sysinfo_mode(&sysinfo) {
        out.push_str(&format!("sysmode_detail={}\n", mode));
    }
    out
}

pub fn print_sim_details(cfg: &AtConfig) -> String {
    let mut out = String::new();
    let iccid = at_query(cfg, "AT^ICCID?");
    if let Some(v) = first_match(&iccid, "^ICCID:") {
        let v = clean_value(&v);
        if !v.is_empty() {
            out.push_str(&format!("iccid={}\n", v));
        }
    }
    let imsi = at_query(cfg, "AT+CIMI");
    let imsi = imsi
        .lines()
        .map(|l| l.trim_matches(['\r', ' ']).to_string())
        .find(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or_default();
    if !imsi.is_empty() {
        out.push_str(&format!("imsi={}\n", imsi));
    }
    out
}

pub fn print_qos(cfg: &AtConfig) -> String {
    let raw = at_query(cfg, "AT+CGEQOSRDP=1");
    let mut out = String::new();
    for line in raw.lines() {
        let l = line.trim_matches(['\r', ' ']);
        if let Some(rest) = l.strip_prefix("+CGEQOSRDP:") {
            let fields: Vec<&str> = rest.split(',').collect();
            if fields.len() >= 2 {
                let qci = fields[1].replace([' ', '"', '\r'], "");
                if !qci.is_empty() {
                    out.push_str(&format!("qci={}\n", qci));
                }
            }
        }
    }
    out
}

pub fn print_active_apn(cfg: &AtConfig) -> String {
    let raw = at_query(cfg, "AT+CGDCONT?");
    let mut out = String::new();
    for line in raw.lines() {
        let l = line.trim_matches(['\r', ' ']);
        if let Some(rest) = l.strip_prefix("+CGDCONT:") {
            let fields: Vec<&str> = rest.split(',').collect();
            // +CGDCONT: <cid>,"<type>","<apn>",...  -> cid is fields[0], apn fields[2]
            if fields.len() >= 3 && fields[0].trim() == "1" {
                let mut apn = fields[2].to_string();
                apn = apn.trim().to_string();
                apn = apn.strip_prefix('"').unwrap_or(&apn).to_string();
                apn = apn.strip_suffix('"').unwrap_or(&apn).to_string();
                apn = apn.trim().to_string();
                if !apn.is_empty() {
                    out.push_str(&format!("active_apn={}\n", apn));
                    break;
                }
            }
        }
    }
    out
}

pub fn print_subscriber_number(cfg: &AtConfig) -> String {
    let raw = at_query(cfg, "AT+CNUM");
    let mut out = String::new();
    for line in raw.lines() {
        let l = line.replace(['\r', '"', ' '], "");
        if l.starts_with("+CNUM:") {
            let payload = l.trim_start_matches("+CNUM:");
            if let Some(num) = payload.split(',').next() {
                let num = num.trim();
                if num.starts_with('+') || num.chars().all(|c| c.is_ascii_digit()) && num.len() >= 5 {
                    out.push_str(&format!("phone_number={}\n", num));
                    return out;
                }
            }
        }
    }
    if raw.lines().any(|l| l.contains("+CME ERROR: 22")) {
        out.push_str("phone_number_state=not_stored\n");
    }
    out
}

pub fn print_temperature(cfg: &AtConfig) -> String {
    let raw = at_query(cfg, "AT^CHIPTEMP?");
    let names = [
        "sub3g_pa", "sub6g_pa", "mimo_pa", "tcxo", "peri1", "peri2", "ap1", "ap2", "modem1", "modem2",
        "bbp1", "bbp2",
    ];
    let mut out = String::new();
    for line in raw.lines() {
        let l = line.trim_matches(['\r', ' ']);
        if let Some(rest) = l.strip_prefix("^CHIPTEMP:") {
            let fields: Vec<&str> = rest.split(',').collect();
            let mut peak: i64 = i64::MIN;
            let mut peak_name = String::new();
            let mut found = false;
            for (i, &value) in fields.iter().enumerate() {
                let v = value.replace([' ', '\r'], "");
                if let Ok(n) = v.parse::<i64>() {
                    if (0..=12).contains(&(i + 1)) && n >= -400 && n <= 1200 {
                        let name = names.get(i).copied().unwrap_or("unknown");
                        out.push_str(&format!("temp_{}={:.1}\n", name, n as f64 / 10.0));
                        if !found || n > peak {
                            peak = n;
                            peak_name = name.to_string();
                            found = true;
                        }
                    }
                }
            }
            if found {
                out.push_str(&format!("temperature={:.1}\n", peak as f64 / 10.0));
                out.push_str(&format!("temperature_sensor={}\n", peak_name));
            }
            break;
        }
    }
    out
}

pub fn print_subscription_rate(cfg: &AtConfig) -> String {
    let mut raw = at_query(cfg, "AT^DSAMBR=1");
    if !raw.lines().any(|l| l.contains("^DSAMBR:")) {
        raw = at_query(cfg, "AT^DSAMBR=1");
    }
    if !raw.lines().any(|l| l.contains("^DSAMBR:")) {
        raw = at_query(cfg, "AT^DSAMBR=8");
    }
    let mut out = String::new();
    for line in raw.lines() {
        let l = line.trim_matches(['\r', ' ']);
        if let Some(rest) = l.strip_prefix("^DSAMBR:") {
            let fields: Vec<&str> = rest.split(',').collect();
            if fields.len() >= 3 {
                let f2 = fields[1].replace([' ', '"', '\r'], "");
                let f3 = fields[2].replace([' ', '"', '\r'], "");
                if let (Ok(d), Ok(u)) = (f2.parse::<f64>(), f3.parse::<f64>()) {
                    out.push_str(&format!("ambr_down_mbps={:.1}\n", d / 1000.0));
                    out.push_str(&format!("ambr_up_mbps={:.1}\n", u / 1000.0));
                }
            }
            break;
        }
    }
    out
}

pub fn print_carrier_aggregation(cfg: &AtConfig) -> String {
    let freq_raw = at_query(cfg, "AT^HFREQINFO?");
    let ca_raw = at_query(cfg, "AT^CASCELLINFO?");
    let nsa_raw = at_query(cfg, "AT^MONSSC");

    let mut carriers: Vec<String> = Vec::new();
    let mut nr_count = 0usize;
    let mut lte_count = 0usize;
    let mut lte_scell_count = 0usize;
    let mut secondary_count = 0usize;
    let mut dl_total = 0.0f64;
    let mut ul_total = 0.0f64;

    // HFREQINFO section
    for line in freq_raw.lines() {
        let l = line.trim_matches(['\r', ' ']);
        if let Some(rest) = l.strip_prefix("^HFREQINFO:") {
            let fields: Vec<&str> = rest.split(',').collect();
            let rat = fields.get(1).copied().unwrap_or("");
            let (radio, freq_div, limit) = match rat {
                "7" => ("NR", 1000.0, 4),
                "6" => ("LTE", 10.0, 1),
                _ => continue,
            };
            let mut parsed = 0;
            let mut i = 2;
            while i + 6 <= fields.len() && parsed < limit {
                let f: Vec<&str> = fields[i..i + 7].to_vec();
                let all_num = f.iter().all(|s| s.replace([' ', '\r'], "").parse::<i64>().is_ok());
                if !all_num {
                    i += 7;
                    continue;
                }
                parsed += 1;
                if radio == "NR" {
                    nr_count += 1;
                } else {
                    lte_count += 1;
                }
                let band = format!("{}{}", if radio == "NR" { "n" } else { "B" }, f[0]);
                let dl_freq = f[2].replace([' ', '\r'], "").parse::<f64>().unwrap_or(0.0) / freq_div;
                let ul_freq = f[5].replace([' ', '\r'], "").parse::<f64>().unwrap_or(0.0) / freq_div;
                let dl_bw = f[3].replace([' ', '\r'], "").parse::<f64>().unwrap_or(0.0) / 1000.0;
                let ul_bw = f[6].replace([' ', '\r'], "").parse::<f64>().unwrap_or(0.0) / 1000.0;
                dl_total += dl_bw;
                ul_total += ul_bw;
                carriers.push(format!(
                    "carrier_{}={}|{}|{}|{:.2}|{:.1}|{}|{:.2}|{:.1}",
                    carriers.len() + 1,
                    radio,
                    band,
                    f[1],
                    dl_freq,
                    dl_bw,
                    f[4],
                    ul_freq,
                    ul_bw
                ));
                i += 7;
            }
        }
    }

    // CASCELLINFO section (LTE secondary cells)
    for line in ca_raw.lines() {
        let l = line.trim_matches(['\r', ' ']);
        if let Some(rest) = l.strip_prefix("^CASCELLINFO:") {
            let fields: Vec<&str> = rest.split(',').collect();
            if fields.len() < 12 {
                continue;
            }
            let all_num = fields[..12].iter().all(|s| {
                let v = s.replace([' ', '\r'], "");
                v.parse::<i64>().is_ok() && (v.starts_with('-') || v.parse::<i64>().map(|n| n >= 0).unwrap_or(false))
            });
            if !all_num {
                continue;
            }
            lte_count += 1;
            lte_scell_count += 1;
            let dl_bw = bandwidth_code(fields[11].replace([' ', '\r'], "").parse::<i64>().unwrap_or(0));
            let ul_bw = bandwidth_code(fields[12].replace([' ', '\r'], "").parse::<i64>().unwrap_or(0));
            dl_total += dl_bw;
            ul_total += ul_bw;
            carriers.push(format!(
                "carrier_{}=LTE|B{}|{}|{:.2}|{:.1}|{}|{:.2}|{:.1}",
                carriers.len() + 1,
                fields[5],
                fields[7],
                fields[9].replace([' ', '\r'], "").parse::<f64>().unwrap_or(0.0) / 10.0,
                dl_bw,
                fields[6],
                fields[8].replace([' ', '\r'], "").parse::<f64>().unwrap_or(0.0) / 10.0,
                ul_bw
            ));
        }
    }

    // MONSSC section (NSA secondary)
    for line in nsa_raw.lines() {
        let l = line.trim_matches(['\r', ' ']);
        if l.starts_with("^MONSSC:") && l.contains("NR,") {
            secondary_count += 1;
        }
    }

    if carriers.is_empty() {
        return String::new();
    }
    let count = carriers.len();
    let ca = nr_count > 1 || lte_scell_count > 0;
    let dc = secondary_count > 0 || (nr_count > 0 && lte_count > 0);
    let mode = if dc {
        if ca { "EN-DC + CA" } else { "EN-DC" }.to_string()
    } else if nr_count > 0 {
        if nr_count > 1 { "NR-CA" } else { "NR" }.to_string()
    } else {
        if lte_count > 1 { "LTE-CA" } else { "LTE" }.to_string()
    };

    let mut out = String::new();
    for c in &carriers {
        out.push_str(c);
        out.push('\n');
    }
    out.push_str(&format!("carrier_count={}\n", count));
    out.push_str(&format!("ca_active={}\n", if ca { 1 } else { 0 }));
    out.push_str(&format!("dc_active={}\n", if dc { 1 } else { 0 }));
    out.push_str(&format!("nr_carrier_count={}\n", nr_count));
    out.push_str(&format!("lte_carrier_count={}\n", lte_count));
    out.push_str(&format!("lte_secondary_count={}\n", lte_scell_count));
    out.push_str(&format!("secondary_connection_count={}\n", secondary_count));
    out.push_str(&format!("ca_mode={}\n", mode));
    out.push_str(&format!("ca_dl_bandwidth={:.1}\n", dl_total));
    out.push_str(&format!("ca_ul_bandwidth={:.1}\n", ul_total));
    out
}

fn bandwidth_code(code: i64) -> f64 {
    match code {
        0 => 1.4,
        1 => 3.0,
        2 => 5.0,
        3 => 10.0,
        4 => 15.0,
        5 => 20.0,
        _ => 0.0,
    }
}

pub fn print_lock_status(cfg: &AtConfig) -> String {
    let mut out = String::new();
    let nr = at_query(cfg, "AT^NRFREQLOCK?");
    if let Some(v) = first_match(&nr, "^NRFREQLOCK:") {
        out.push_str(&format!("nr_lock={}\n", clean_value(&v)));
    }
    let lte = at_query(cfg, "AT^LTEFREQLOCK?");
    if let Some(v) = first_match(&lte, "^LTEFREQLOCK:") {
        out.push_str(&format!("lte_lock={}\n", clean_value(&v)));
    }
    out
}

pub fn print_network_info(cfg: &AtConfig) -> String {
    let mut out = String::new();
    for (label, command) in [
        ("Signal", "AT^HCSQ?"),
        ("Serving cell", "AT^MONSC"),
        ("RRC state", "AT^RRCSTAT?"),
        ("Network registration", "AT+CEREG?"),
        ("Operator", "AT+COPS?"),
        ("LTE lock", "AT^LTEFREQLOCK?"),
        ("NR lock", "AT^NRFREQLOCK?"),
    ] {
        let raw = at_query(cfg, command);
        out.push_str(&block(label, command, &raw));
    }
    out.push_str(&print_temperature(cfg));
    out
}

fn system_items() -> Vec<(&'static str, &'static str)> {
    vec![
        ("Identity", "ATI"),
        ("IMEI", "AT+CGSN"),
        ("Revision", "AT+CGMR"),
        ("Version", "AT^VERSION?"),
        ("SIM", "AT+CPIN?"),
        ("ICCID", "AT^ICCID?"),
        ("IMSI", "AT+CIMI"),
        ("Subscriber number", "AT+CNUM"),
        ("Subscription rate", "AT^DSAMBR=1"),
        ("Operator", "AT+COPS?"),
        ("Network time", "AT^NWTIME?"),
        ("Function level", "AT+CFUN?"),
        ("LED", "AT^LEDSWITCH?"),
        ("SIM activation", "AT^HVSST?"),
        ("SIM slot", "AT^SCICHG?"),
        ("FOTA mode", "AT^FOTAMODE?"),
        ("FOTA state", "AT^FOTASTATE?"),
        ("FOTA progress", "AT^FOTADLQ"),
        ("Temperature", "AT^CHIPTEMP?"),
        ("Thermal status", "AT^THERMLDAUTOSTATUS?"),
        ("Thermal thresholds", "AT^THERMLDAUTOPARA?"),
        ("Thermal log", "AT^THERMLDLOGSW?"),
    ]
}

pub fn print_system_info(cfg: &AtConfig) -> String {
    let mut out = String::new();
    for (label, command) in system_items() {
        let raw = at_query(cfg, command);
        out.push_str(&block(label, command, &raw));
    }
    out
}

#[derive(Debug, Clone, Copy)]
pub enum AdvancedGroup {
    Connection,
    ConnectionSettings,
    Session,
    Radio,
    RadioDiagnostics,
    Hardware,
    All,
}

impl AdvancedGroup {
    fn items(self) -> Vec<(&'static str, &'static str)> {
        match self {
            AdvancedGroup::Connection => vec![
                ("Auto dial", "AT^SETAUTODIAL?"),
                ("Interface mode", "AT^TDCFG?"),
                ("PDP contexts", "AT+CGDCONT?"),
                ("PDP activation", "AT+CGACT?"),
                ("Data session", "AT^NDISSTATQRY?"),
                ("Detailed sessions", "AT^DCONNSTAT?"),
                ("Direct IP", "AT^SETDIRECTIP?"),
                ("IPv4 lease", "AT^DHCP?"),
                ("IPv6 lease", "AT^DHCPV6?"),
                ("IP capability", "AT^IPV6CAP?"),
                ("Data flow", "AT^DSFLOWQRY"),
                ("MTU", "AT^CGMTU=1"),
                ("PDP address", "AT+CGPADDR=1"),
            ],
            AdvancedGroup::ConnectionSettings => vec![
                ("Auto dial", "AT^SETAUTODIAL?"),
                ("Interface mode", "AT^TDCFG?"),
                ("PDP contexts", "AT+CGDCONT?"),
                ("PDP activation", "AT+CGACT?"),
                ("Direct IP", "AT^SETDIRECTIP?"),
            ],
            AdvancedGroup::Session => vec![
                ("Data session", "AT^NDISSTATQRY?"),
                ("Detailed sessions", "AT^DCONNSTAT?"),
                ("IPv4 lease", "AT^DHCP?"),
                ("IPv6 lease", "AT^DHCPV6?"),
                ("IP capability", "AT^IPV6CAP?"),
                ("Data flow", "AT^DSFLOWQRY"),
                ("MTU", "AT^CGMTU=1"),
                ("PDP address", "AT+CGPADDR=1"),
            ],
            AdvancedGroup::Radio => vec![
                ("Radio mode", "AT^SYSCFGEX?"),
                ("5G access mode", "AT^C5GOPTION?"),
                ("NR carrier aggregation", "AT^NRRCCAPQRY=3"),
                ("VoNR", "AT^NRRCCAPQRY=2"),
                ("DSS", "AT^NRRCCAPQRY=5"),
            ],
            AdvancedGroup::RadioDiagnostics => vec![
                ("LTE secondary cells", "AT^CASCELLINFO?"),
                ("NSA secondary cells", "AT^MONSSC"),
                ("Uplink MCS", "AT^MCS=0"),
                ("Downlink MCS", "AT^MCS=1"),
                ("NR transmit power", "AT^NTXPOWER?"),
                ("NR SSB beam", "AT^NRSSBID?"),
                ("Neighbour cells", "AT^MONNC"),
                ("QoS", "AT+CGEQOSRDP=1"),
                ("Data registration", "AT+C5GREG?"),
                ("IMS registration", "AT+CIREG?"),
                ("Dual connectivity", "AT^LENDC?"),
            ],
            AdvancedGroup::Hardware => vec![
                ("USB mode", "AT^SETMODE?"),
                ("Interface mode", "AT^TDCFG?"),
                ("NIC speed", "AT^TDPCIELANCFG?"),
                ("PCIe controller", "AT^TDPMCFG?"),
                ("LED", "AT^LEDSWITCH?"),
                ("SIM hotplug", "AT^TDSIMHP?"),
                ("SIM slot", "AT^SCICHG?"),
                ("Thermal control", "AT^THERMAUTOFUN?"),
            ],
            AdvancedGroup::All => vec![
                ("Auto dial", "AT^SETAUTODIAL?"),
                ("USB mode", "AT^SETMODE?"),
                ("Interface mode", "AT^TDCFG?"),
                ("PDP contexts", "AT+CGDCONT?"),
                ("Radio mode", "AT^SYSCFGEX?"),
                ("NIC speed", "AT^TDPCIELANCFG?"),
                ("PCIe controller", "AT^TDPMCFG?"),
                ("LED", "AT^LEDSWITCH?"),
                ("SIM hotplug", "AT^TDSIMHP?"),
                ("SIM slot", "AT^SCICHG?"),
                ("Thermal control", "AT^THERMAUTOFUN?"),
                ("NR carrier aggregation", "AT^NRRCCAPQRY=3"),
                ("VoNR", "AT^NRRCCAPQRY=2"),
                ("DSS", "AT^NRRCCAPQRY=5"),
            ],
        }
    }
}

pub fn print_advanced_info(cfg: &AtConfig, group: AdvancedGroup) -> String {
    let mut out = String::new();
    for (label, command) in group.items() {
        let raw = at_query(cfg, command);
        out.push_str(&block(label, command, &raw));
    }
    out
}

pub fn print_sms_list(cfg: &AtConfig) -> String {
    let mut out = String::new();
    out.push_str("===== SMS storage =====\n");
    out.push_str(&at_query(cfg, "AT+CPMS?"));
    out.push_str("\n\n===== SMS messages =====\n");
    at_query(cfg, "AT+CMGF=0");
    out.push_str(&at_query(cfg, "AT+CMGL=4"));
    out
}

pub fn print_sms_info(cfg: &AtConfig) -> String {
    let mut out = String::new();
    for (label, command) in [
        ("IMS", "AT^IMSSWITCH?"),
        ("Service mode", "AT+CEUS?"),
        ("SMSC", "AT+CSCA?"),
        ("Storage", "AT+CPMS?"),
    ] {
        let raw = at_query(cfg, command);
        out.push_str(&block(label, command, &raw));
    }
    out
}

// ---------------------- frequency lock builders -------------------------

/// Port of `build_lte_lock_command`.  Returns the AT command string, or `Err`
/// when validation fails (the shell would `exit 64`).
pub fn build_lte_lock_command(
    lock_type: &str,
    bands: &str,
    arfcns: &str,
    pcis: &str,
) -> std::result::Result<String, ()> {
    match lock_type {
        "0" => Ok("AT^LTEFREQLOCK=0".to_string()),
        "3" => {
            let bands = clean_csv(bands);
            let count = csv_count(&bands);
            if valid_lock_count(count) && numeric_csv_in_range(&bands, 0, 65535) {
                Ok(format!("AT^LTEFREQLOCK=3,0,{},{:?}", count, bands))
            } else {
                Err(())
            }
        }
        "1" => {
            let bands = clean_csv(bands);
            let arfcns = clean_csv(arfcns);
            let count = csv_count(&bands);
            if valid_lock_count(count)
                && numeric_csv_in_range(&bands, 0, 65535)
                && numeric_csv_in_range(&arfcns, 0, 4294967295)
                && csv_count(&bands) == csv_count(&arfcns)
            {
                Ok(format!(
                    "AT^LTEFREQLOCK=1,0,{},{:?},{:?}",
                    count, bands, arfcns
                ))
            } else {
                Err(())
            }
        }
        "2" => {
            let bands = clean_csv(bands);
            let arfcns = clean_csv(arfcns);
            let pcis = clean_csv(pcis);
            let count = csv_count(&bands);
            if valid_lock_count(count)
                && numeric_csv_in_range(&bands, 0, 65535)
                && numeric_csv_in_range(&arfcns, 0, 4294967295)
                && numeric_csv_in_range(&pcis, 0, 503)
                && csv_count(&bands) == csv_count(&arfcns)
                && csv_count(&bands) == csv_count(&pcis)
            {
                Ok(format!(
                    "AT^LTEFREQLOCK=2,0,{},{:?},{:?},{:?}",
                    count, bands, arfcns, pcis
                ))
            } else {
                Err(())
            }
        }
        _ => Err(()),
    }
}

pub fn build_nr_lock_command(
    lock_type: &str,
    bands: &str,
    arfcns: &str,
    scs: &str,
    pcis: &str,
) -> std::result::Result<String, ()> {
    match lock_type {
        "0" => Ok("AT^NRFREQLOCK=0".to_string()),
        "3" => {
            let bands = clean_csv(bands);
            let count = csv_count(&bands);
            if valid_lock_count(count) && numeric_csv_in_range(&bands, 0, 65535) {
                Ok(format!("AT^NRFREQLOCK=3,0,{},{:?}", count, bands))
            } else {
                Err(())
            }
        }
        "1" => {
            let bands = clean_csv(bands);
            let arfcns = clean_csv(arfcns);
            let scs = clean_csv(scs);
            let count = csv_count(&bands);
            if valid_lock_count(count)
                && numeric_csv_in_range(&bands, 0, 65535)
                && numeric_csv_in_range(&arfcns, 0, 4294967295)
                && numeric_csv_in_range(&scs, 0, 4)
                && csv_count(&bands) == csv_count(&arfcns)
                && csv_count(&bands) == csv_count(&scs)
            {
                Ok(format!(
                    "AT^NRFREQLOCK=1,0,{},{:?},{:?},{:?}",
                    count, bands, arfcns, scs
                ))
            } else {
                Err(())
            }
        }
        "2" => {
            let bands = clean_csv(bands);
            let arfcns = clean_csv(arfcns);
            let scs = clean_csv(scs);
            let pcis = clean_csv(pcis);
            let count = csv_count(&bands);
            if valid_lock_count(count)
                && numeric_csv_in_range(&bands, 0, 65535)
                && numeric_csv_in_range(&arfcns, 0, 4294967295)
                && numeric_csv_in_range(&scs, 0, 4)
                && numeric_csv_in_range(&pcis, 0, 1007)
                && csv_count(&bands) == csv_count(&arfcns)
                && csv_count(&bands) == csv_count(&scs)
                && csv_count(&bands) == csv_count(&pcis)
            {
                Ok(format!(
                    "AT^NRFREQLOCK=2,0,{},{:?},{:?},{:?},{:?}",
                    count, bands, arfcns, scs, pcis
                ))
            } else {
                Err(())
            }
        }
        _ => Err(()),
    }
}
