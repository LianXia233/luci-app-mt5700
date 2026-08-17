// Configuration loading for the at-server daemon.
//
// The original `at-server.py` read everything from UCI with a single
// `uci show at-webserver` call and parsed the `key=value` lines.  We mirror
// that exactly: one shell-out, then a prefix strip + parse.  Keeping this as a
// shell-out (instead of linking a uci library) preserves the runtime contract
// and means the daemon needs no new OpenWrt packages beyond `uci` itself.

use crate::shell;
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct AtConfig {
    pub conn_type: String, // "UBUS" | "NETWORK" | "SERIAL"
    pub ubus_at_port: String,
    pub ubus_timeout: u64,
    pub net_host: String,
    pub net_port: u16,
    pub net_timeout: u64,
    pub serial_port: String,
    pub serial_baud: u32,
    pub serial_timeout: u64,
}

#[derive(Clone, Debug)]
pub struct WsConfig {
    pub port: u16,
    pub auth_key: String,
}

#[derive(Clone, Debug)]
pub struct NotifyConfig {
    pub wechat: String,
    pub log_file: String,
    pub sms: bool,
    pub call: bool,
    pub memory_full: bool,
    pub signal: bool,
}

pub struct Config {
    pub at: AtConfig,
    pub ws: WsConfig,
    pub notify: NotifyConfig,
}

fn parse_bool(s: &str) -> bool {
    s.trim() == "1"
}
fn parse_u64(s: &str, d: u64) -> u64 {
    s.trim().parse().unwrap_or(d)
}
fn parse_u16(s: &str, d: u16) -> u16 {
    s.trim().parse().unwrap_or(d)
}
fn parse_u32(s: &str, d: u32) -> u32 {
    s.trim().parse().unwrap_or(d)
}

/// Load configuration from UCI (`at-webserver` config section).  Falls back to
/// the documented defaults when a key is missing or UCI is unavailable.
pub fn load() -> Config {
    let mut kv: HashMap<String, String> = HashMap::new();
    if let Some(out) = shell::uci_show("at-webserver") {
        for line in out.lines() {
            if let Some(eq) = line.find('=') {
                let key = line[..eq].trim();
                let val = line[eq + 1..].trim().trim_matches(|c| c == '\'' || c == '"');
                if let Some(stripped) = key.strip_prefix("at-webserver.config.") {
                    kv.insert(stripped.to_string(), val.to_string());
                }
            }
        }
    }

    let get = |k: &str| kv.get(k).map(|s| s.as_str());

    let conn_type = get("connection_type").unwrap_or("UBUS").to_string();

    let mut at = AtConfig {
        conn_type: conn_type.clone(),
        ubus_at_port: get("ubus_at_port").unwrap_or("").to_string(),
        ubus_timeout: parse_u64(get("ubus_timeout").unwrap_or("10"), 10),
        net_host: get("network_host").unwrap_or("192.168.8.1").to_string(),
        net_port: parse_u16(get("network_port").unwrap_or("20249"), 20249),
        net_timeout: parse_u64(get("network_timeout").unwrap_or("10"), 10),
        serial_port: get("serial_port").unwrap_or("/dev/ttyUSB0").to_string(),
        serial_baud: parse_u32(get("serial_baudrate").unwrap_or("115200"), 115200),
        serial_timeout: parse_u64(get("serial_timeout").unwrap_or("10"), 10),
    };
    // `serial_port='custom'` selects `serial_port_custom`.
    if at.serial_port == "custom" {
        at = AtConfig {
            serial_port: get("serial_port_custom")
                .unwrap_or("/dev/ttyUSB0")
                .to_string(),
            ..at
        };
    }

    let ws = WsConfig {
        port: parse_u16(get("websocket_port").unwrap_or("8765"), 8765),
        auth_key: get("websocket_auth_key").unwrap_or("").to_string(),
    };

    let notify = NotifyConfig {
        wechat: get("wechat_webhook").unwrap_or("").to_string(),
        log_file: get("log_file").unwrap_or("").to_string(),
        sms: parse_bool(get("notify_sms").unwrap_or("1")),
        call: parse_bool(get("notify_call").unwrap_or("1")),
        memory_full: parse_bool(get("notify_memory_full").unwrap_or("1")),
        signal: parse_bool(get("notify_signal").unwrap_or("1")),
    };

    Config { at, ws, notify }
}
