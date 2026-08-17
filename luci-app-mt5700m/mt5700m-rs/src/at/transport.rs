// AT transport layer — faithful port of the `at_*` functions in `mt5700m-at`.
//
// Three channels, selected by `mt5700m.settings.mode`:
//   * ubus    — forward the command through `ubus-at-daemon` (the same daemon
//               the LuCI app shares, so the PCUI tty is never opened twice).
//   * serial  — open the PCUI tty directly (`cat` reader + `stty` + write).
//   * network — TCP to the module's network AT port via `nc`.
// Mode `auto` tries ubus, then serial, then network, exactly like the shell.

use crate::at::config::{AtConfig, AtMode};
use crate::error::{MtError, Result};
use crate::json::Json;
use crate::shell::{run, run_allow_fail, ubus_call, ubus_list};
use crate::usb;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Outcome of sending a single AT command: the raw modem response (already
/// carriage-stripped) and the shell-compatible return code the original
/// `at_cmd` would have produced.
#[derive(Debug, Clone)]
pub struct AtResult {
    pub response: String,
    pub rc: i32,
}

impl AtResult {
    pub fn ok(response: impl Into<String>) -> AtResult {
        AtResult {
            response: response.into(),
            rc: 0,
        }
    }
    pub fn fail(rc: i32, response: impl Into<String>) -> AtResult {
        AtResult {
            response: response.into(),
            rc,
        }
    }
}

/// Mirror of `at_response_ok`: any literal "ERROR" substring means the modem
/// rejected the command.
pub fn response_ok(response: &str) -> bool {
    !response.contains("ERROR")
}

/// Port of `detect_mt5700m_at_port`.
pub fn detect_at_port(cfg: &AtConfig) -> Option<String> {
    if !cfg.at_port.is_empty() && usb::port_is_pcui(&cfg.at_port) {
        return Some(cfg.at_port.clone());
    }
    let detected = usb::pcui_port();
    if detected.is_some() {
        return detected;
    }
    None
}

/// Port of `at_ubus_cmd`.
pub fn ubus_sendat(at_port: &str, timeout: u64, command: &str) -> AtResult {
    if !ubus_list("at-daemon") {
        return AtResult::fail(127, "");
    }
    let payload = Json::obj(vec![
        ("at_port", Json::str_(at_port)),
        ("timeout", Json::num(timeout as f64)),
        ("at_cmd", Json::str_(command)),
    ])
    .to_compact_string();
    let res = match ubus_call("at-daemon", "sendat", &payload) {
        Ok(s) => s,
        Err(_) => return AtResult::fail(1, ""),
    };
    let parsed = match crate::json::parse(&res) {
        Ok(j) => j,
        Err(_) => return AtResult::fail(1, ""),
    };
    let status = parsed.get_path("status").and_then(|j| j.as_str()).unwrap_or("");
    if status != "success" {
        return AtResult::fail(1, "");
    }
    let response = parsed
        .get_path("response")
        .and_then(|j| j.as_str())
        .unwrap_or("")
        .to_string();
    let rc = if response_ok(&response) { 0 } else { 1 };
    AtResult { response, rc }
}

/// Port of `at_serial_cmd`.  Uses the same `cat <dev> > tmp &` reader trick as
/// the shell so we never block on a tty read we cannot cancel.
pub fn serial_sendat(device: &str, timeout: u64, command: &str) -> AtResult {
    if !std::path::Path::new(device).exists() {
        return AtResult::fail(1, "");
    }
    let _ = crate::shell::stty(
        device,
        &[
            "115200", "raw", "-echo", "-echoe", "-echok", "-echoctl", "-echoke", "-ixon",
            "-ixoff", "min", "0", "time", "5",
        ],
    );

    // Drain any pending input.
    let _ = Command::new("timeout")
        .args(["1", "cat", device])
        .stdout(Stdio::null())
        .status();

    let tmp = match std::env::temp_dir().join(format!("mt5700m-at.{}.XXXXXX", std::process::id())).to_str() {
        Some(p) => p.to_string(),
        None => "/tmp/mt5700m-at.tmp".to_string(),
    };
    // Use mktemp if available for a unique file, else a pid-scoped name.
    let tmp = if let Ok(out) = run("mktemp", &["/tmp/mt5700m-at.XXXXXX"]) {
        out.0
    } else {
        tmp
    };

    let mut cat = Command::new("cat")
        .arg(device)
        .stdout(Stdio::from(
            std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&tmp)
                .map_err(|e| MtError(e.to_string()))
                .unwrap(),
        ))
        .spawn()
        .map_err(|e| MtError(e.to_string()))
        .unwrap();

    // Write the command (CRLF-terminated) to the serial device.
    {
        let mut dev = std::fs::OpenOptions::new()
            .write(true)
            .open(device)
            .map_err(|e| MtError(e.to_string()))
            .unwrap();
        let _ = dev.write_all(format!("{}\r", command).as_bytes());
        let _ = dev.flush();
    }

    let deadline = Instant::now() + Duration::from_secs(timeout);
    let mut elapsed: u64 = 0;
    let mut final_output = String::new();
    loop {
        if let Ok(contents) = std::fs::read_to_string(&tmp) {
            let stripped: String = contents.replace('\r', "");
            if terminal_token_present(&stripped) {
                let _ = cat.kill();
                let _ = cat.wait();
                let rc = if response_ok(&stripped) { 0 } else { 1 };
                return AtResult { response: stripped, rc };
            }
            final_output = stripped;
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
        elapsed += 1;
        if elapsed >= timeout {
            break;
        }
    }
    let _ = cat.kill();
    let _ = cat.wait();
    if let Ok(contents) = std::fs::read_to_string(&tmp) {
        final_output = contents.replace('\r', "");
    }
    let _ = std::fs::remove_file(&tmp);
    // A serial timeout is a transport failure, not a modem ERROR response.
    // Let auto mode try the network AT endpoint.
    AtResult::fail(124, final_output)
}

fn terminal_token_present(text: &str) -> bool {
    for line in text.split('\n') {
        let t = line.trim();
        if t == "OK" || t == "ERROR" || t.starts_with("+CME ERROR") || t.starts_with("+CMS ERROR") {
            return true;
        }
    }
    false
}

/// Port of `at_network_cmd`.
pub fn network_sendat(host: &str, port: u16, timeout: u64, command: &str) -> AtResult {
    if run_allow_fail("command", &["-v", "nc"]) != "0" && !std::path::Path::new("/usr/bin/nc").exists() {
        return AtResult::fail(127, "nc command not found");
    }
    let timeout_s = timeout.to_string();
    let port_s = port.to_string();
    let mut child = match Command::new("nc")
        .args(["-w", timeout_s.as_str(), host, port_s.as_str()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return AtResult::fail(127, "nc command not found"),
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{}\r", command).as_bytes());
        let _ = stdin.flush();
    }
    let _ = child.wait();
    let mut response = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut response);
    }
    let response = response.trim().to_string();
    if response.is_empty() {
        return AtResult::fail(1, "");
    }
    let rc = if response_ok(&response) { 0 } else { 1 };
    AtResult { response, rc }
}

/// Port of `detect_modem_gateway` + `network_hosts`.
pub fn network_hosts(cfg: &AtConfig) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    let gateway = detect_modem_gateway();
    if let Some(g) = &gateway {
        if !hosts.contains(g) {
            hosts.push(g.clone());
        }
    }
    if !cfg.host.is_empty() && !hosts.contains(&cfg.host) {
        hosts.push(cfg.host.clone());
    }
    for fixed in ["192.168.8.1", "10.0.0.1"] {
        if cfg.host != fixed && gateway.as_deref() != Some(fixed) && !hosts.contains(&fixed.to_string()) {
            hosts.push(fixed.to_string());
        }
    }
    hosts
}

fn detect_modem_gateway() -> Option<String> {
    let (out, _) = run("ip", &["-4", "route", "show", "default"]).unwrap_or_default();
    gateway_inner(&out)
}

/// Public wrapper used by the AT dispatcher (`status`/`channel`) so it can
/// report the auto-detected modem gateway the way the shell's
/// `detect_modem_gateway` did.
pub fn detect_gateway() -> Option<String> {
    detect_modem_gateway()
}

fn gateway_inner(out: &str) -> Option<String> {
    for line in out.lines() {
        if line.contains("dev")
            && (line.contains("eth2")
                || line.contains("usb")
                || line.contains("wwan")
                || line.contains("qmimux")
                || line.contains("rmnet")
                || line.contains("mhi")
                || line.contains("USB"))
        {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if let Some(pos) = parts.iter().position(|&p| p == "via") {
                if let Some(gw) = parts.get(pos + 1) {
                    return Some((*gw).to_string());
                }
            }
        }
    }
    let (out2, _) = run("ip", &["-4", "route", "show", "10.0.0.0/8"]).unwrap_or_default();
    for line in out2.lines() {
        if line.contains("dev")
            && (line.contains("eth2")
                || line.contains("usb")
                || line.contains("wwan")
                || line.contains("qmimux")
                || line.contains("rmnet")
                || line.contains("mhi")
                || line.contains("USB"))
        {
            return Some("10.0.0.1".to_string());
        }
    }
    None
}

/// Port of `at_cmd`.  Returns the response and the rc the shell would have
/// exited with.  The caller is responsible for printing `response` (only when
/// non-empty) and exiting with `rc`.
pub fn at_cmd(cfg: &AtConfig, command: &str) -> AtResult {
    if !cfg.enabled {
        return AtResult::fail(2, "");
    }
    let command: String = command.chars().filter(|c| *c != '\0' && *c != '\r' && *c != '\n').collect();
    if command.is_empty() {
        return AtResult::fail(1, "");
    }

    match cfg.mode {
        AtMode::Serial => {
            let device = match detect_at_port(cfg) {
                Some(d) => d,
                None => return AtResult::fail(1, "AT serial port not found"),
            };
            let ubus_rc = ubus_sendat(&device, cfg.timeout, &command);
            if ubus_rc.rc == 0 {
                return AtResult::ok(ubus_rc.response);
            }
            if ubus_rc.rc != 127 {
                return ubus_rc;
            }
            serial_sendat(&device, cfg.timeout, &command)
        }
        AtMode::Network => {
            for target in network_hosts(cfg) {
                let r = network_sendat(&target, cfg.port, cfg.timeout, &command);
                if r.rc == 0 {
                    return AtResult::ok(r.response);
                }
            }
            AtResult::fail(1, "")
        }
        AtMode::Auto => {
            if let Some(device) = detect_at_port(cfg) {
                let ubus_rc = ubus_sendat(&device, cfg.timeout, &command);
                if ubus_rc.rc == 0 {
                    return AtResult::ok(ubus_rc.response);
                }
                if ubus_rc.rc != 127 {
                    return ubus_rc;
                }
                let serial_rc = serial_sendat(&device, cfg.timeout, &command);
                if serial_rc.rc == 0 {
                    return AtResult::ok(serial_rc.response);
                }
            }
            for target in network_hosts(cfg) {
                let r = network_sendat(&target, cfg.port, cfg.timeout, &command);
                if r.rc == 0 {
                    return AtResult::ok(r.response);
                }
            }
            AtResult::fail(1, "")
        }
    }
}

/// Convenience wrapper used by the parsers: send a command and return just the
/// response text (empty on any failure), matching `at_cmd '...' || true`.
pub fn at_query(cfg: &AtConfig, command: &str) -> String {
    at_cmd(cfg, command).response
}

#[allow(dead_code)]
fn _unused() -> Result<()> {
    Ok(())
}
