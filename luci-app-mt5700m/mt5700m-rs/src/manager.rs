// Port of `mt5700m-manager` — the connection/sync orchestrator invoked by the
// rpcd wrapper (`status` -> `status_json`), the init script and the LuCI
// "connect/disconnect/redial" actions.  All external OpenWrt contracts are
// preserved: the same lock directory, state dir, log file, UCI keys, ubus
// object names and the exact `status_json` shape the LuCI front-end consumes.

use crate::at::config as at_config;
use crate::at::parse as at_parse;
use crate::error::exit;
use crate::json::{parse as parse_json, Json};
use crate::shell;
use crate::usb;
use std::io::Write;
use std::path::{Path, PathBuf};

const TAG: &str = "mt5700m-manager";
const INTERFACE: &str = "MT5700M";
const INTERFACE6: &str = "MT5700Mv6";

fn lock_dir() -> PathBuf {
    PathBuf::from(std::env::var("MT5700M_MANAGER_LOCK").unwrap_or_else(|_| "/var/lock/mt5700m-manager.lock".into()))
}

fn state_dir() -> PathBuf {
    PathBuf::from(std::env::var("MT5700M_MANAGER_STATE").unwrap_or_else(|_| "/var/run/mt5700m".into()))
}

fn log_file() -> PathBuf {
    PathBuf::from(std::env::var("MT5700M_MANAGER_LOG").unwrap_or_else(|_| "/tmp/mt5700m-manager.log".into()))
}

fn temp_cache() -> PathBuf {
    state_dir().join("temperature")
}

/// Entry point invoked when the program runs as `mt5700m-manager`.
pub fn run(args: &[String]) -> i32 {
    let action = args.first().map(|s| s.as_str()).unwrap_or("status-json");
    match action {
        "monitor" => {
            monitor_manager();
            0
        }
        "status" | "status-json" => {
            status_json();
            0
        }
        "refresh-temperature" => {
            refresh_temperature_cache();
            0
        }
        "log" => {
            let (out, _) = shell::run("tail", &["-n", "120", &log_file().to_string_lossy()])
                .unwrap_or((String::new(), false));
            if !out.is_empty() {
                println!("{}", out);
            }
            0
        }
        _ => {
            if !acquire_lock_wait() {
                eprintln!("manager is busy");
                return 2;
            }
            let _guard = LockGuard;
            match action {
                "sync" => sync_manager(),
                "connect" => connect_manager(),
                "disconnect" => disconnect_manager(),
                "redial" => redial_manager(),
                "down" => bring_down(),
                _ => {
                    eprintln!("Usage: mt5700m-manager {{status-json|sync|connect|disconnect|redial|refresh-temperature|log|monitor}}");
                    return exit::BAD_ARG;
                }
            }
            0
        }
    }
}

struct LockGuard;
impl Drop for LockGuard {
    fn drop(&mut self) {
        release_lock();
    }
}

// ----------------------------- logging ----------------------------------

fn log_message(message: &str) {
    let sd = state_dir();
    let _ = std::fs::create_dir_all(&sd);
    let ts = date_now();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file())
    {
        let _ = writeln!(f, "{} {}", ts, message);
    }
    let _ = std::process::Command::new("logger")
        .args(["-t", TAG, "--", message])
        .status();
}

fn date_now() -> String {
    shell::run_allow_fail("date", &["+%Y-%m-%d %H:%M:%S"])
}

fn date_epoch() -> String {
    shell::run_allow_fail("date", &["+%s"])
}

// ----------------------------- locking ----------------------------------

fn acquire_lock() -> bool {
    let dir = lock_dir();
    if std::fs::create_dir(&dir).is_ok() {
        let _ = std::fs::write(dir.join("pid"), std::process::id().to_string());
        return true;
    }
    let owner = std::fs::read_to_string(dir.join("pid")).unwrap_or_default();
    let owner = owner.trim().to_string();
    let valid = !owner.is_empty() && owner.chars().all(|c| c.is_ascii_digit());
    if !valid || !process_alive(&owner) {
        let _ = std::fs::remove_dir_all(&dir);
        if std::fs::create_dir(&dir).is_ok() {
            let _ = std::fs::write(dir.join("pid"), std::process::id().to_string());
            return true;
        }
    }
    false
}

fn acquire_lock_wait() -> bool {
    let mut attempts = 0;
    while !acquire_lock() {
        attempts += 1;
        if attempts >= 8 {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    true
}

fn release_lock() {
    let _ = std::fs::remove_dir_all(lock_dir());
}

fn process_alive(pid: &str) -> bool {
    shell::run("kill", &["-0", pid]).map(|(_, ok)| ok).unwrap_or(false)
}

// ----------------------------- config -----------------------------------

fn config_value(key: &str, default: &str) -> String {
    shell::uci_get_or(&format!("mt5700m.connection.{}", key), default)
}

fn sync_set(key: &str, value: &str, changed: &mut bool) {
    let cur = shell::uci_get(key).unwrap_or_default();
    if cur != value {
        let _ = shell::uci_set(key, value);
        *changed = true;
    }
}

fn delete_if_present(key: &str, changed: &mut bool) {
    if shell::uci_get(key).is_some() {
        let _ = shell::uci_delete(key);
        *changed = true;
    }
}

fn list_contains(key: &str, wanted: &str) -> bool {
    shell::uci_get(key)
        .map(|v| v.split_whitespace().any(|x| x == wanted))
        .unwrap_or(false)
}

fn effective_policy() -> (i64, i32, i32, i32) {
    let mode = shell::uci_get("h5000m_netmode.settings.mode").unwrap_or_default();
    let owner = shell::uci_get("h5000m_netmode.settings.ipv6_owner").unwrap_or_default();
    let configured_metric = config_value("metric", "50");
    let metric: i64 = if configured_metric.chars().all(|c| c.is_ascii_digit()) {
        configured_metric.parse().unwrap_or(50)
    } else {
        50
    };
    let effective_metric = match mode.as_str() {
        "modem_first" | "modem_only" => 10,
        "wan_first" | "wan_only" => 50,
        _ => metric,
    };
    let ipv4_default: i32 = if mode == "wan_only" { 0 } else { 1 };
    let (ipv6_default, ipv6_auto) = match owner.as_str() {
        "modem" => (1, 1),
        "wan" => (0, 0),
        _ => match mode.as_str() {
            "modem_first" | "modem_only" => (1, 1),
            _ => (0, 0),
        },
    };
    (effective_metric, ipv4_default, ipv6_default, ipv6_auto)
}

// ----------------------------- network sync -----------------------------

fn ensure_firewall_network(network: &str, firewall_changed: &mut bool) {
    let script = "uci show firewall 2>/dev/null | sed -n \"s/^\\(firewall\\.[^.]*\\)\\.name='wan'$/\\1/p\" | head -n 1";
    let (zone, _) = shell::run("sh", &["-c", script]).unwrap_or((String::new(), false));
    let zone = zone.trim().to_string();
    if zone.is_empty() {
        return;
    }
    if list_contains(&format!("{}.network", zone), network) {
        return;
    }
    let _ = shell::uci_add_list(&format!("{}.network={}", zone, network));
    *firewall_changed = true;
}

fn ensure_network(netdev: &str) {
    let mut config_changed = false;
    let mut firewall_changed = false;

    let mut pdp_type = config_value("pdp_type", "ipv4v6");
    if !matches!(pdp_type.as_str(), "ip" | "ipv6" | "ipv4v6") {
        pdp_type = "ipv4v6".to_string();
    }

    let (metric, ipv4_default, ipv6_default, ipv6_auto) = effective_policy();

    sync_set(&format!("network.{}.interface", INTERFACE), "interface", &mut config_changed);
    sync_set(&format!("network.{}.managed_by", INTERFACE), "mt5700m", &mut config_changed);
    sync_set(&format!("network.{}.device", INTERFACE), netdev, &mut config_changed);
    sync_set(&format!("network.{}.ifname", INTERFACE), netdev, &mut config_changed);
    sync_set(&format!("network.{}.metric", INTERFACE), &metric.to_string(), &mut config_changed);
    sync_set(&format!("network.{}.defaultroute", INTERFACE), &ipv4_default.to_string(), &mut config_changed);
    sync_set(&format!("network.{}.norelease", INTERFACE), "1", &mut config_changed);
    delete_if_present(&format!("network.{}.modem_config", INTERFACE), &mut config_changed);

    if pdp_type == "ipv6" {
        sync_set(&format!("network.{}.proto", INTERFACE), "none", &mut config_changed);
    } else {
        sync_set(&format!("network.{}.proto", INTERFACE), "dhcp", &mut config_changed);
    }

    let dns = shell::uci_get("mt5700m.connection.dns_list").unwrap_or_default();
    let current_dns = shell::uci_get(&format!("network.{}.dns", INTERFACE)).unwrap_or_default();
    if !dns.is_empty() {
        sync_set(&format!("network.{}.peerdns", INTERFACE), "0", &mut config_changed);
        if current_dns != dns {
            let _ = shell::uci_delete(&format!("network.{}.dns", INTERFACE));
            for d in dns.split_whitespace() {
                let _ = shell::uci_add_list(&format!("network.{}.dns={}", INTERFACE, d));
            }
            config_changed = true;
        }
    } else {
        delete_if_present(&format!("network.{}.dns", INTERFACE), &mut config_changed);
        delete_if_present(&format!("network.{}.peerdns", INTERFACE), &mut config_changed);
    }

    if pdp_type == "ip" {
        // NOTE: must pass the full UCI path ("network.MT5700Mv6"), not the bare
        // section name, otherwise the stale IPv6 interface is never removed.
        delete_if_present(&format!("network.{}", INTERFACE6), &mut config_changed);
    } else {
        sync_set(&format!("network.{}", INTERFACE6), "interface", &mut config_changed);
        sync_set(&format!("network.{}.managed_by", INTERFACE6), "mt5700m", &mut config_changed);
        sync_set(&format!("network.{}.proto", INTERFACE6), "dhcpv6", &mut config_changed);
        sync_set(&format!("network.{}.device", INTERFACE6), &format!("@{}", INTERFACE), &mut config_changed);
        sync_set(&format!("network.{}.ifname", INTERFACE6), &format!("@{}", INTERFACE), &mut config_changed);
        sync_set(&format!("network.{}.metric", INTERFACE6), &metric.to_string(), &mut config_changed);
        sync_set(&format!("network.{}.defaultroute", INTERFACE6), &ipv6_default.to_string(), &mut config_changed);
        sync_set(&format!("network.{}.auto", INTERFACE6), &ipv6_auto.to_string(), &mut config_changed);
        sync_set(&format!("network.{}.extendprefix", INTERFACE6), "1", &mut config_changed);
        delete_if_present(&format!("network.{}.modem_config", INTERFACE6), &mut config_changed);
    }

    ensure_firewall_network(INTERFACE, &mut firewall_changed);
    if pdp_type != "ip" {
        ensure_firewall_network(INTERFACE6, &mut firewall_changed);
    }

    if config_changed {
        let _ = shell::uci_commit("network");
        let _ = shell::run("/etc/init.d/network", &["reload"]);
        log_message(&format!("network synchronized device={} protocol={} metric={}", netdev, pdp_type, metric));
    }
    if firewall_changed {
        let _ = shell::uci_commit("firewall");
        let _ = shell::run("/etc/init.d/firewall", &["reload"]);
    }
}

fn interface_up(name: &str) -> bool {
    let out = shell::ubus_call(&format!("network.interface.{}", name), "status", "{}").unwrap_or_default();
    match parse_json(&out) {
        Ok(j) => j.get_path("up").and_then(|v| v.as_bool()) == Some(true),
        Err(_) => false,
    }
}

fn bring_up() {
    let pdp_type = config_value("pdp_type", "ipv4v6");
    let _ = shell::ifup(INTERFACE);
    match pdp_type.as_str() {
        "ip" => {
            let _ = shell::ifdown(INTERFACE6);
        }
        _ => {
            let auto = shell::uci_get(&format!("network.{}.auto", INTERFACE6)).unwrap_or_else(|| "1".into());
            if auto == "0" {
                let _ = shell::ifdown(INTERFACE6);
            } else {
                let _ = shell::ifup(INTERFACE6);
            }
        }
    }
}

fn bring_down() {
    let _ = shell::ifdown(INTERFACE6);
    let _ = shell::ifdown(INTERFACE);
}

fn sync_manager() {
    let info = usb::usb_info();
    let state = info.as_ref().map(|i| i.state.clone()).unwrap_or_else(|| "absent".into());
    if state != "normal" {
        bring_down();
        if info.is_some() {
            log_message(&format!("module unavailable state={}", state));
        }
        return;
    }

    if !usb::bind_network_driver() {
        log_message("unable to bind MT5700M NCM interface");
    }
    if usb::pcui_port().is_none() {
        usb::bind_serial_driver();
        std::thread::sleep(std::time::Duration::from_secs(1));
    }

    let netdev = match usb::netdev() {
        Some(n) => n,
        None => {
            log_message("normal-mode module has no network interface");
            return;
        }
    };

    ensure_network(&netdev);

    if config_value("enabled", "1") == "1" {
        if !interface_up(INTERFACE) {
            bring_up();
        }
    } else {
        bring_down();
    }
}

fn apply_profile() {
    let pdp = config_value("pdp_type", "ipv4v6");
    let protocol = match pdp.as_str() {
        "ip" => "IP",
        "ipv6" => "IPV6",
        _ => "IPV4V6",
    };
    let apn = config_value("apn", "");
    let username = config_value("username", "");
    let password = config_value("password", "");
    let auth = config_value("auth", "none");
    let auth_code = match auth.as_str() {
        "pap" => "1",
        "chap" => "2",
        _ => "0",
    };
    let cfg = at_config::load();
    let args = vec![
        "advanced-set".to_string(),
        "autodial".to_string(),
        "1".to_string(),
        "1".to_string(),
        protocol.to_string(),
        apn,
        username,
        password,
        auth_code.to_string(),
    ];
    let _ = crate::at::run(&cfg, &args);
}

fn connect_manager() {
    let mut changed = false;
    sync_set("mt5700m.connection.enabled", "1", &mut changed);
    if changed {
        let _ = shell::uci_commit("mt5700m");
    }
    sync_manager();
    apply_profile();
    bring_up();
    log_message("connection enabled");
}

fn disconnect_manager() {
    let mut changed = false;
    sync_set("mt5700m.connection.enabled", "0", &mut changed);
    if changed {
        let _ = shell::uci_commit("mt5700m");
    }
    bring_down();
    log_message("connection disabled");
}

fn redial_manager() {
    bring_down();
    std::thread::sleep(std::time::Duration::from_secs(1));
    let mut changed = false;
    sync_set("mt5700m.connection.enabled", "1", &mut changed);
    if changed {
        let _ = shell::uci_commit("mt5700m");
    }
    sync_manager();
    apply_profile();
    bring_up();
    log_message("connection recycled");
}

// ----------------------------- status -----------------------------------

fn bool_from_json(s: &str) -> i32 {
    match parse_json(s) {
        Ok(j) => {
            if j.get_path("up").and_then(|v| v.as_bool()) == Some(true) {
                1
            } else {
                0
            }
        }
        Err(_) => 0,
    }
}

fn status_json() {
    let info = usb::usb_info();
    let state = info.as_ref().map(|i| i.state.clone()).unwrap_or_else(|| "absent".into());
    let product = info.as_ref().map(|i| i.product.clone()).unwrap_or_default();
    let slot = info.as_ref().map(|i| i.slot.clone()).unwrap_or_default();
    let netdev = usb::netdev().unwrap_or_default();
    let atport = usb::pcui_port().unwrap_or_default();

    let status4 = shell::ubus_call(&format!("network.interface.{}", INTERFACE), "status", "{}").unwrap_or_default();
    let status6 = shell::ubus_call(&format!("network.interface.{}", INTERFACE6), "status", "{}").unwrap_or_default();
    let up4 = bool_from_json(&status4);
    let up6 = bool_from_json(&status6);

    let carrier: i32 = if !netdev.is_empty() {
        let c = shell::read_sysfs(&format!("/sys/class/net/{}/carrier", netdev));
        if c == "1" { 1 } else { 0 }
    } else {
        0
    };

    let running: i32 = if config_value("enabled", "1") == "1" && state == "normal" { 1 } else { 0 };
    let connected: i32 = if (up4 == 1 || up6 == 1) && carrier == 1 { 1 } else { 0 };
    let metric = shell::uci_get(&format!("network.{}.metric", INTERFACE))
        .unwrap_or_else(|| config_value("metric", "50"));

    let doc = Json::obj(vec![
        ("running", Json::bool_(running == 1)),
        ("connected", Json::bool_(connected == 1)),
        ("ipv4_up", Json::bool_(up4 == 1)),
        ("ipv6_up", Json::bool_(up6 == 1)),
        ("carrier", Json::bool_(carrier == 1)),
        ("usb_state", Json::str_(state)),
        ("usb_pid", Json::str_(product)),
        ("usb_slot", Json::str_(slot)),
        ("at_port", Json::str_(atport)),
        ("network", Json::str_(netdev)),
        ("interface", Json::str_(INTERFACE)),
        ("interface6", Json::str_(INTERFACE6)),
        ("mode", Json::str_("NCM / ECM")),
        ("metric", Json::str_(metric)),
    ]);
    println!("{}", doc.to_compact_string());
}

// ----------------------------- temperature cache ------------------------

fn valid_temperature(value: &str) -> bool {
    match value.parse::<f64>() {
        Ok(n) => n >= -40.0 && n <= 150.0,
        Err(_) => false,
    }
}

fn refresh_temperature_cache() {
    let cfg = at_config::load();
    let output = at_parse::print_temperature(&cfg);
    let value = output
        .lines()
        .find_map(|l| l.strip_prefix("temperature="))
        .unwrap_or("")
        .to_string();
    if !valid_temperature(&value) {
        return;
    }

    let sd = state_dir();
    if std::fs::create_dir_all(&sd).is_err() {
        return;
    }
    let tmp = format!("{}.{}", temp_cache().to_string_lossy(), std::process::id());
    {
        let mut f = match std::fs::OpenOptions::new().create(true).write(true).truncate(true).open(&tmp) {
            Ok(f) => f,
            Err(_) => return,
        };
        for line in output.lines() {
            let keep = (line.starts_with("temp_") && is_temp_line(line))
                || line.starts_with("temperature=")
                || line.starts_with("temperature_sensor=");
            if keep {
                let _ = writeln!(f, "{}", line);
            }
        }
        let _ = writeln!(f, "updated={}", date_epoch());
    }
    let _ = std::fs::rename(&tmp, temp_cache());
    #[cfg(unix)]
    let _ = std::fs::set_permissions(temp_cache(), std::os::unix::fs::PermissionsExt::from_mode(0o644));
}

fn is_temp_line(line: &str) -> bool {
    // temp_<name>=<number> where number is a signed decimal (optionally .x)
    let v = match line.split('=').nth(1) {
        Some(v) => v,
        None => return false,
    };
    v.parse::<f64>().is_ok()
}

// ----------------------------- monitor ----------------------------------

fn monitor_manager() {
    loop {
        if acquire_lock() {
            sync_manager();
            release_lock();
        }
        refresh_temperature_cache();
        std::thread::sleep(std::time::Duration::from_secs(15));
    }
}

// Silence unused import warning on platforms without unix permissions.
#[allow(dead_code)]
fn _path_marker(_p: &Path) {}
