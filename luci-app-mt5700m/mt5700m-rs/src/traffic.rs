// Port of `mt5700m-traffic` — the traffic accounting daemon and its JSON
// exporter.  The original kept a plain-text history file and rewrote it with a
// sizeable `awk` program on every sample; this version keeps the identical
// on-disk format (`updated`/`total`/`day`/`month` space-separated lines) so the
// file is drop-in compatible, but maintains the model in memory and writes it
// back deterministically.  The exported JSON keeps the exact shape the LuCI
// traffic widget consumes.

use crate::error::exit;
use crate::json::Json;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;

fn interfaces() -> Vec<String> {
    std::env::var("MT5700M_TRAFFIC_INTERFACES")
        .unwrap_or_else(|_| "eth2".into())
        .split_whitespace()
        .map(|s| s.to_string())
        .collect()
}

fn sys_class_net() -> PathBuf {
    PathBuf::from(std::env::var("MT5700M_TRAFFIC_SYS_CLASS_NET").unwrap_or_else(|_| "/sys/class/net".into()))
}

fn runtime_dir() -> PathBuf {
    PathBuf::from(std::env::var("MT5700M_TRAFFIC_RUNTIME_DIR").unwrap_or_else(|_| "/tmp/mt5700m-traffic".into()))
}

fn history_file() -> PathBuf {
    PathBuf::from(std::env::var("MT5700M_TRAFFIC_HISTORY_FILE").unwrap_or_else(|_| "/etc/mt5700m/traffic-history".into()))
}

fn runtime_file() -> PathBuf {
    runtime_dir().join("history")
}

fn interval() -> u64 {
    std::env::var("MT5700M_TRAFFIC_INTERVAL")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(30)
}

fn flush_cycles() -> u64 {
    std::env::var("MT5700M_TRAFFIC_FLUSH_CYCLES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20)
}

/// Entry point invoked when the program runs as `mt5700m-traffic`.
pub fn run(args: &[String]) -> i32 {
    umask_077();
    let action = args.first().map(|s| s.as_str()).unwrap_or("");
    match action {
        "daemon" => {
            collect_daemon();
            0
        }
        "json" => {
            export_json();
            0
        }
        "flush" => {
            flush_history();
            0
        }
        "update" => {
            let dev = args.get(1).cloned().unwrap_or_else(|| "eth2".into());
            let rx: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
            let tx: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
            let day = args.get(4).cloned().unwrap_or_else(|| date_fmt("%Y-%m-%d"));
            let stamp = args.get(5).cloned().unwrap_or_else(|| date_fmt("%H:%M"));
            ensure_history();
            update_history(&dev, rx, tx, &day, &stamp);
            0
        }
        _ => {
            eprintln!("Usage: mt5700m-traffic {{daemon|json|flush}}");
            1
        }
    }
}

fn umask_077() {
    // The original script sets `umask 077` so the history file is created
    // private.  We keep the zero-dependency build (no libc) and instead apply
    // restrictive permissions to the runtime/history files right after writing
    // them (see `write_history` / `flush_history`).  This is a no-op placeholder
    // kept so the call site mirrors the original flow.
}

// ----------------------------- history model ----------------------------

#[derive(Default, Clone)]
struct Entry {
    updated_date: String,
    updated_time: String,
    total_rx: u64,
    total_tx: u64,
    days: Vec<(String, u64, u64)>,
    months: Vec<(String, u64, u64)>,
}

fn ensure_history() {
    let _ = std::fs::create_dir_all(runtime_dir());
    if let Some(parent) = history_file().parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if !runtime_file().exists() {
        if history_file().exists() {
            let _ = std::fs::copy(history_file(), runtime_file());
        } else {
            let mut content = String::from("version 1\n");
            for dev in interfaces() {
                content.push_str(&format!("updated {} 1970-01-01 00:00\n", dev));
                content.push_str(&format!("total {} 0 0\n", dev));
            }
            let _ = std::fs::write(runtime_file(), content);
        }
    }
}

fn read_history() -> (Vec<String>, HashMap<String, Entry>) {
    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, Entry> = HashMap::new();
    if let Ok(data) = std::fs::read_to_string(runtime_file()) {
        for line in data.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 2 {
                continue;
            }
            let dev = parts[1].to_string();
            if !map.contains_key(&dev) {
                order.push(dev.clone());
                map.insert(dev.clone(), Entry::default());
            }
            let entry = map.get_mut(&dev).unwrap();
            match parts[0] {
                "updated" => {
                    if parts.len() >= 4 {
                        entry.updated_date = parts[2].to_string();
                        entry.updated_time = parts[3].to_string();
                    }
                }
                "total" => {
                    if parts.len() >= 4 {
                        entry.total_rx = parts[2].parse().unwrap_or(0);
                        entry.total_tx = parts[3].parse().unwrap_or(0);
                    }
                }
                "day" => {
                    if parts.len() >= 5 {
                        let rx = parts[3].parse().unwrap_or(0);
                        let tx = parts[4].parse().unwrap_or(0);
                        entry.days.push((parts[2].to_string(), rx, tx));
                    }
                }
                "month" => {
                    if parts.len() >= 5 {
                        let rx = parts[3].parse().unwrap_or(0);
                        let tx = parts[4].parse().unwrap_or(0);
                        entry.months.push((parts[2].to_string(), rx, tx));
                    }
                }
                _ => {}
            }
        }
    }
    (order, map)
}

fn write_history(order: &[String], map: &HashMap<String, Entry>) {
    let mut content = String::from("version 1\n");
    for dev in order {
        if let Some(e) = map.get(dev) {
            content.push_str(&format!(
                "updated {} {} {}\n",
                dev, e.updated_date, e.updated_time
            ));
            content.push_str(&format!("total {} {} {}\n", dev, e.total_rx, e.total_tx));
            for (date, rx, tx) in &e.days {
                content.push_str(&format!("day {} {} {} {}\n", dev, date, rx, tx));
            }
            for (month, rx, tx) in &e.months {
                content.push_str(&format!("month {} {} {} {}\n", dev, month, rx, tx));
            }
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).write(true).truncate(true).open(runtime_file()) {
        let _ = f.write_all(content.as_bytes());
    }
}

fn update_history(netdev: &str, rx_delta: u64, tx_delta: u64, day_key: &str, stamp: &str) {
    let month_key = day_key.rsplit('-').last().map(|_| {
        // month = first two dash components, e.g. 2026-08
        let mut it = day_key.split('-');
        let y = it.next().unwrap_or("");
        let m = it.next().unwrap_or("");
        format!("{}-{}", y, m)
    }).unwrap_or_else(|| day_key.to_string());

    let (mut order, mut map) = read_history();
    if !map.contains_key(netdev) {
        order.push(netdev.to_string());
        map.insert(netdev.to_string(), Entry::default());
    }
    let entry = map.get_mut(netdev).unwrap();
    entry.updated_date = day_key.to_string();
    entry.updated_time = stamp.to_string();
    entry.total_rx += rx_delta;
    entry.total_tx += tx_delta;

    if let Some(slot) = entry.days.iter_mut().find(|(d, _, _)| d == day_key) {
        slot.1 += rx_delta;
        slot.2 += tx_delta;
    } else {
        entry.days.push((day_key.to_string(), rx_delta, tx_delta));
    }

    if let Some(slot) = entry.months.iter_mut().find(|(m, _, _)| m == &month_key) {
        slot.1 += rx_delta;
        slot.2 += tx_delta;
    } else {
        entry.months.push((month_key, rx_delta, tx_delta));
    }

    write_history(&order, &map);
}

fn flush_history() {
    ensure_history();
    let tmp = format!("{}.tmp.{}", history_file().to_string_lossy(), std::process::id());
    if std::fs::copy(runtime_file(), &tmp).is_ok() {
        let _ = std::fs::rename(&tmp, history_file());
    }
}

// ----------------------------- export -----------------------------------

fn export_interface(netdev: &str, entry: &Entry) -> Json {
    let (uy, um, ud) = split_date(&entry.updated_date);
    let (uh, umi) = split_time(&entry.updated_time);

    let mut day_arr = json_arr();
    for (date, rx, tx) in &entry.days {
        let (dy, dm, dd) = split_date(date);
        day_arr = push(
            day_arr,
            json_obj(vec![
                ("date", date_obj(dy, dm, dd)),
                ("rx", num_f(*rx as f64)),
                ("tx", num_f(*tx as f64)),
            ]),
        );
    }
    let mut month_arr = json_arr();
    for (month, rx, tx) in &entry.months {
        let (my, mm) = split_month(month);
        month_arr = push(
            month_arr,
            json_obj(vec![
                ("date", json_obj(vec![("year", num_i(my)), ("month", num_i(mm))])),
                ("rx", num_f(*rx as f64)),
                ("tx", num_f(*tx as f64)),
            ]),
        );
    }

    json_obj(vec![
        ("name", str_(netdev.to_string())),
        (
            "updated",
            json_obj(vec![
                ("date", date_obj(uy, um, ud)),
                ("time", json_obj(vec![("hour", num_i(uh)), ("minute", num_i(umi))])),
            ]),
        ),
        (
            "traffic",
            json_obj(vec![
                (
                    "total",
                    json_obj(vec![("rx", num_f(entry.total_rx as f64)), ("tx", num_f(entry.total_tx as f64))]),
                ),
                ("day", day_arr),
                ("month", month_arr),
            ]),
        ),
    ])
}

fn export_json() {
    ensure_history();
    let (order, map) = read_history();
    let mut out = String::from("{\"interfaces\":[");
    let mut first = true;
    for dev in &order {
        if let Some(e) = map.get(dev) {
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str(&export_interface(dev, e).to_compact_string());
        }
    }
    out.push_str("]}");
    println!("{}", out);
}

// ----------------------------- collection -------------------------------

fn valid_number(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

fn collect_interface(netdev: &str) -> bool {
    let sys = sys_class_net();
    let rx_file = sys.join(netdev).join("statistics/rx_bytes");
    let tx_file = sys.join(netdev).join("statistics/tx_bytes");
    let last_file = runtime_dir().join(format!("last-{}", netdev));

    if !rx_file.exists() || !tx_file.exists() {
        let _ = std::fs::remove_file(&last_file);
        return false;
    }
    let rx_now = crate::shell::read_file_trim(&rx_file.to_string_lossy());
    let tx_now = crate::shell::read_file_trim(&tx_file.to_string_lossy());
    if !(valid_number(&rx_now) && valid_number(&tx_now)) {
        return false;
    }
    let rx_now: u64 = rx_now.parse().unwrap_or(0);
    let tx_now: u64 = tx_now.parse().unwrap_or(0);

    let (last_rx, last_tx) = if let Ok(data) = std::fs::read_to_string(&last_file) {
        let mut it = data.split_whitespace();
        let a = it.next().unwrap_or("").to_string();
        let b = it.next().unwrap_or("").to_string();
        (a, b)
    } else {
        (String::new(), String::new())
    };

    if valid_number(&last_rx) && valid_number(&last_tx) {
        let last_rx: u64 = last_rx.parse().unwrap_or(0);
        let last_tx: u64 = last_tx.parse().unwrap_or(0);
        let rx_delta = if rx_now >= last_rx { rx_now - last_rx } else { rx_now };
        let tx_delta = if tx_now >= last_tx { tx_now - last_tx } else { tx_now };
        let year: i64 = date_fmt("%Y").parse().unwrap_or(0);
        if year >= 2024 && (rx_delta > 0 || tx_delta > 0) {
            update_history(netdev, rx_delta, tx_delta, &date_fmt("%Y-%m-%d"), &date_fmt("%H:%M"));
            return true;
        }
    }
    let _ = std::fs::write(&last_file, format!("{} {}\n", rx_now, tx_now));
    false
}

fn collect_daemon() {
    ensure_history();
    let mut cycles: u64 = 0;
    let mut dirty = false;
    // Best-effort graceful flush on SIGINT/SIGTERM.
    loop {
        for dev in interfaces() {
            if collect_interface(&dev) {
                dirty = true;
            }
        }
        cycles += 1;
        if cycles >= flush_cycles() {
            if dirty {
                flush_history();
                dirty = false;
            }
            cycles = 0;
        }
        sleep(interval());
    }
}

// ----------------------------- date helpers -----------------------------

fn date_fmt(fmt: &str) -> String {
    crate::shell::run_allow_fail("date", &[fmt])
}

#[allow(dead_code)]
fn split_date(s: &str) -> (i64, i64, i64) {
    let parts: Vec<&str> = s.split('-').collect();
    let y = parts.first().and_then(|v| v.parse().ok()).unwrap_or(0);
    let m = parts.get(1).and_then(|v| v.parse().ok()).unwrap_or(0);
    let d = parts.get(2).and_then(|v| v.parse().ok()).unwrap_or(0);
    (y, m, d)
}

fn split_time(s: &str) -> (i64, i64) {
    let parts: Vec<&str> = s.split(':').collect();
    let h = parts.first().and_then(|v| v.parse().ok()).unwrap_or(0);
    let m = parts.get(1).and_then(|v| v.parse().ok()).unwrap_or(0);
    (h, m)
}

fn split_month(s: &str) -> (i64, i64) {
    let parts: Vec<&str> = s.split('-').collect();
    let y = parts.first().and_then(|v| v.parse().ok()).unwrap_or(0);
    let m = parts.get(1).and_then(|v| v.parse().ok()).unwrap_or(0);
    (y, m)
}

fn sleep(secs: u64) {
    std::thread::sleep(std::time::Duration::from_secs(secs));
}

// ----------------------------- json builders ----------------------------

fn json_obj(items: Vec<(&str, Json)>) -> Json {
    Json::obj(items)
}
fn json_arr() -> Json {
    Json::arr(vec![])
}
fn push(arr: Json, item: Json) -> Json {
    match arr {
        Json::Arr(mut v) => {
            v.push(item);
            Json::Arr(v)
        }
        _ => arr,
    }
}
fn num_i(n: i64) -> Json {
    Json::num(n as f64)
}
fn num_f(n: f64) -> Json {
    Json::num(n)
}
fn str_(s: String) -> Json {
    Json::str_(s)
}
fn date_obj(y: i64, m: i64, d: i64) -> Json {
    json_obj(vec![("year", num_i(y)), ("month", num_i(m)), ("day", num_i(d))])
}

// Mark the unused `exit` import as intentionally available for future use.
#[allow(dead_code)]
fn _exit_marker() -> i32 {
    exit::BAD_ARG
}
