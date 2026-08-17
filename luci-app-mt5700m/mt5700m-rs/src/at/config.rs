// AT channel configuration, transplanted from the head of `mt5700m-at`.
//
// The shell script reads `mt5700m.settings` via uci.  We honour the same
// option names and defaults, plus the `MT5700M_USB_HELPER` / `MT5700M_AT_HELPER`
// environment overrides the scripts accepted.

use crate::shell::{uci_get_or, uci_get};

#[derive(Debug, Clone)]
pub struct AtConfig {
    pub enabled: bool,
    pub mode: AtMode,
    pub at_port: String,
    pub host: String,
    pub port: u16,
    pub timeout: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AtMode {
    Auto,
    Serial,
    Network,
}

impl AtMode {
    pub fn from_str(s: &str) -> AtMode {
        match s {
            "serial" => AtMode::Serial,
            "network" => AtMode::Network,
            _ => AtMode::Auto,
        }
    }
}

impl Default for AtConfig {
    fn default() -> Self {
        AtConfig {
            enabled: true,
            mode: AtMode::Auto,
            at_port: String::new(),
            host: "192.168.8.1".to_string(),
            port: 20249,
            timeout: 8,
        }
    }
}

pub fn load() -> AtConfig {
    let enabled = uci_get_or("mt5700m.settings.enabled", "1") == "1";
    let mode = AtMode::from_str(&uci_get_or("mt5700m.settings.mode", "auto"));
    let at_port = uci_get("mt5700m.settings.at_port").unwrap_or_default();
    let host = uci_get_or("mt5700m.settings.host", "192.168.8.1");
    let port: u16 = uci_get_or("mt5700m.settings.port", "20249")
        .parse()
        .unwrap_or(20249);
    let timeout: u64 = uci_get_or("mt5700m.settings.timeout", "8")
        .parse()
        .unwrap_or(8);
    AtConfig {
        enabled,
        mode,
        at_port,
        host,
        port,
        timeout: if timeout == 0 { 8 } else { timeout },
    }
}
