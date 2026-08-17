// Thin wrappers around the external OpenWrt tools the original shell scripts
// relied on (uci, ubus, ifup/ifdown, modprobe, stty, nc, sms_tool_q).  Keeping
// these as shell-outs preserves the exact runtime contract the LuCI front-end
// and the init scripts depend on, and means the Rust port needs no new kernel
// interfaces or daemons.

use crate::error::{MtError, Result};
use std::process::Command;

/// Run a command, returning its trimmed stdout and whether it exited 0.
pub fn run(cmd: &str, args: &[&str]) -> Result<(String, bool)> {
    let output = Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| MtError(format!("failed to exec {}: {}", cmd, e)))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    Ok((stdout.trim_end_matches(['\n', '\r']).to_string(), output.status.success()))
}

/// Run a command and return trimmed stdout regardless of exit code (used for
/// best-effort queries where a non-zero exit simply means "no data").
pub fn run_allow_fail(cmd: &str, args: &[&str]) -> String {
    match run(cmd, args) {
        Ok((s, _)) => s,
        Err(_) => String::new(),
    }
}

pub fn command_exists(cmd: &str) -> bool {
    run_allow_fail("command", &["-v", cmd]) == "0"
        || std::path::Path::new(&format!("/usr/sbin/{}", cmd)).exists()
        || std::path::Path::new(&format!("/bin/{}", cmd)).exists()
        || std::path::Path::new(&format!("/usr/bin/{}", cmd)).exists()
}

// ------------------------------ uci -------------------------------------

pub fn uci_get(option: &str) -> Option<String> {
    let (out, ok) = run_allow("uci", &["-q", "get", option]);
    if ok && !out.is_empty() {
        Some(out)
    } else {
        None
    }
}

/// Like `uci_get` but returns `default` when unset — mirrors the shell
/// `uci -q get x || echo default` idiom.
pub fn uci_get_or(option: &str, default: &str) -> String {
    uci_get(option).unwrap_or_else(|| default.to_string())
}

fn run_allow(cmd: &str, args: &[&str]) -> (String, bool) {
    run(cmd, args).unwrap_or((String::new(), false))
}

pub fn uci_set(option: &str, value: &str) -> Result<()> {
    run(cmd_uci(), &["-q", "set", &format!("{}={}", option, value)])?;
    Ok(())
}

pub fn uci_delete(option: &str) -> Result<()> {
    run(cmd_uci(), &["-q", "delete", option])?;
    Ok(())
}

pub fn uci_add_list(option_eq_value: &str) -> Result<()> {
    // option_eq_value looks like "network.foo.list=bar"
    run(cmd_uci(), &["-q", "add_list", option_eq_value])?;
    Ok(())
}

pub fn uci_commit(config: &str) -> Result<()> {
    run(cmd_uci(), &["-q", "commit", config])?;
    Ok(())
}

pub fn uci_show(prefix: &str) -> Option<String> {
    let (out, ok) = run_allow(cmd_uci(), &["show", prefix]);
    if ok {
        Some(out)
    } else {
        None
    }
}

fn cmd_uci() -> &'static str {
    "uci"
}

// ------------------------------ ubus ------------------------------------

/// Call `ubus call <object> <method> '<payload>'` and return stdout.
pub fn ubus_call(object: &str, method: &str, payload: &str) -> Result<String> {
    let (out, ok) = run_allow("ubus", &["call", object, method, payload]);
    if ok {
        Ok(out)
    } else {
        Err(MtError(format!("ubus call {} {} failed", object, method)))
    }
}

pub fn ubus_list(object: &str) -> bool {
    run("ubus", &["list", object]).map(|(_, ok)| ok).unwrap_or(false)
}

// --------------------------- network / sys ------------------------------

pub fn ifup(name: &str) -> Result<()> {
    run("ifup", &[name])?;
    Ok(())
}

pub fn ifdown(name: &str) -> Result<()> {
    run("ifdown", &[name])?;
    Ok(())
}

pub fn modprobe(name: &str) {
    let _ = run("modprobe", &[name]);
}

pub fn stty(device: &str, opts: &[&str]) -> Result<()> {
    let mut args: Vec<&str> = vec!["-F", device];
    args.extend_from_slice(opts);
    run("stty", &args)?;
    Ok(())
}

// ------------------------------ files ------------------------------------

/// Read a file, returning empty string if missing/unreadable (matches the
/// shell `cat file 2>/dev/null || true` idiom used throughout usb.sh).
pub fn read_file(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

pub fn read_file_trim(path: &str) -> String {
    read_file(path).trim().to_string()
}

/// Read a sysfs attribute as a lower-cased trimmed string.
pub fn read_sysfs(path: &str) -> String {
    read_file(path).trim().to_ascii_lowercase()
}

/// Write `value` to a sysfs node, ignoring failure (the original used
/// `printf ... > node 2>/dev/null || true`).
pub fn write_sysfs(path: &str, value: &str) -> bool {
    use std::io::Write;
    match std::fs::OpenOptions::new().write(true).open(path) {
        Ok(mut f) => f.write_all(value.as_bytes()).is_ok(),
        Err(_) => false,
    }
}

/// Does `path` exist and is it readable?
pub fn readable(path: &str) -> bool {
    std::path::Path::new(path).exists()
}
