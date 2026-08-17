// Rust port of `root/usr/share/mt5700m/usb.sh`.
//
// These helpers locate the MT5700M (USB vendor 3466) on the bus, derive its
// operational state from the product ID, find the network interface and the
// PCUI AT serial port, and (re)bind the cdc_ncm / option drivers so the module
// exposes both an eth device and usable AT ports.  The hotplug script still
// sources the original usb.sh for the plug-event path; this module is what the
// Rust `mt5700m-at` / `mt5700m-manager` tools use so they no longer depend on
// the shell helper at runtime.

use crate::shell::{modprobe, read_file_trim, read_sysfs, write_sysfs};
use std::path::{Path, PathBuf};

const DEFAULT_VENDOR: &str = "3466";

pub struct UsbInfo {
    pub state: String,   // normal | upgrade | dump | unknown
    pub product: String, // idProduct, e.g. "3301"
    pub slot: String,    // sysfs device name, e.g. "1-1"
}

fn sysfs_root() -> String {
    std::env::var("MT5700M_SYSFS_ROOT").unwrap_or_else(|_| "/sys".to_string())
}

fn dev_root() -> String {
    std::env::var("MT5700M_DEV_ROOT").unwrap_or_else(|_| "/dev".to_string())
}

fn vendor() -> String {
    std::env::var("MT5700M_USB_VENDOR")
        .unwrap_or_else(|_| DEFAULT_VENDOR.to_string())
        .to_ascii_lowercase()
}

fn devices_dir() -> PathBuf {
    Path::new(&sysfs_root()).join("bus/usb/devices")
}

/// Port of `mt5700m_usb_info`.  Returns the operational state, product id and
/// sysfs slot of the MT5700M.  Prefers the `normal` device; otherwise the first
/// device seen is reported so hotplug/manager can still act on upgrade/dump
/// modes.
pub fn usb_info() -> Option<UsbInfo> {
    let vend = vendor();
    let mut first: Option<UsbInfo> = None;
    let dir = devices_dir();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return None,
    };
    for entry in entries.flatten() {
        let slot = entry.file_name().to_string_lossy().to_string();
        let base = entry.path();
        let idv = read_sysfs(&base.join("idVendor").to_string_lossy());
        let idp = read_sysfs(&base.join("idProduct").to_string_lossy());
        if idv != vend {
            continue;
        }
        let state = match idp.as_str() {
            "3301" => "normal",
            "3302" => "upgrade",
            "3303" => "dump",
            _ => "unknown",
        }
        .to_string();
        let info = UsbInfo {
            state: state.clone(),
            product: idp,
            slot,
        };
        if state == "normal" {
            return Some(info);
        }
        if first.is_none() {
            first = Some(info);
        }
    }
    first
}

/// Port of `mt5700m_normal_slot`.
pub fn normal_slot() -> Option<String> {
    usb_info().filter(|i| i.state == "normal").map(|i| i.slot)
}

/// Port of `mt5700m_netdev`.
pub fn netdev() -> Option<String> {
    let slot = normal_slot()?;
    let dir = devices_dir();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with(&slot) {
                continue;
            }
            let net_dir = entry.path().join("net");
            if let Ok(net_entries) = std::fs::read_dir(&net_dir) {
                for ne in net_entries.flatten() {
                    let netdev = ne.file_name().to_string_lossy().to_string();
                    let class_net = Path::new(&sysfs_root()).join("class/net").join(&netdev);
                    if class_net.exists() {
                        return Some(netdev);
                    }
                }
            }
        }
    }
    None
}

/// Resolve a path (typically `/sys/class/tty/ttyUSB0/device`) to the usb
/// device directory that owns it by walking up until `idVendor` is present.
/// Port of `mt5700m_usb_device_dir_for_path`.
fn usb_device_dir_for_path(path: &str) -> Option<PathBuf> {
    let abs = std::fs::canonicalize(path).ok()?;
    for ancestor in abs.ancestors() {
        if ancestor.join("idVendor").exists() && ancestor.join("idProduct").exists() {
            return Some(ancestor.to_path_buf());
        }
    }
    None
}

/// Walk up from a tty's `device` symlink until an interface directory
/// (one exposing `bInterfaceClass` or `interface`) is found.
/// Port of `mt5700m_tty_interface_dir`.
fn tty_interface_dir(tty: &str) -> Option<PathBuf> {
    let device_path = Path::new(&sysfs_root())
        .join("class/tty")
        .join(tty.trim_start_matches("/dev/"))
        .join("device");
    let abs = std::fs::canonicalize(&device_path).ok()?;
    for ancestor in abs.ancestors() {
        if ancestor.join("bInterfaceClass").exists() || ancestor.join("interface").exists() {
            return Some(ancestor.to_path_buf());
        }
    }
    None
}

/// Port of `mt5700m_port_belongs_to_normal`.
fn port_belongs_to_normal(tty: &str) -> bool {
    let device_dir = match usb_device_dir_for_path(
        &Path::new(&sysfs_root())
            .join("class/tty")
            .join(tty.trim_start_matches("/dev/"))
            .join("device")
            .to_string_lossy(),
    ) {
        Some(d) => d,
        None => return false,
    };
    let idv = read_sysfs(&device_dir.join("idVendor").to_string_lossy());
    let idp = read_sysfs(&device_dir.join("idProduct").to_string_lossy());
    idv == "3466" && idp == "3301"
}

/// Port of `mt5700m_port_is_pcui`.
pub fn port_is_pcui(tty: &str) -> bool {
    if !port_belongs_to_normal(tty) {
        return false;
    }
    let iface = match tty_interface_dir(tty) {
        Some(p) => p,
        None => return false,
    };
    let class = read_sysfs(&iface.join("bInterfaceClass").to_string_lossy());
    let subclass = read_sysfs(&iface.join("bInterfaceSubClass").to_string_lossy());
    let protocol = read_sysfs(&iface.join("bInterfaceProtocol").to_string_lossy());
    if format!("{}:{}:{}", class, subclass, protocol) == "ff:06:12" {
        return true;
    }
    let description = read_file_trim(&iface.join("interface").to_string_lossy()).to_ascii_lowercase();
    let has_pcui = description.contains("pcui")
        || (description.contains("pc") && description.contains("ui"));
    has_pcui
}

/// Port of `mt5700m_pcui_port`.
pub fn pcui_port() -> Option<String> {
    if normal_slot().is_none() {
        return None;
    }
    let dev = dev_root();
    let entries = match std::fs::read_dir(Path::new(&dev)) {
        Ok(e) => e,
        Err(_) => return None,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("ttyUSB") {
            let path = format!("{}/{}", dev, name);
            if port_is_pcui(&path) {
                return Some(path);
            }
        }
    }
    None
}

/// Port of `mt5700m_bind_network_driver`.  Releases any non-cdc_ncm driver from
/// the CDC control interface and explicitly binds cdc_ncm.
pub fn bind_network_driver() -> bool {
    let slot = match normal_slot() {
        Some(s) => s,
        None => return false,
    };
    modprobe("usbnet");
    modprobe("cdc_ether");
    modprobe("cdc_ncm");

    let sysfs = sysfs_root();
    let slot_dir = devices_dir().join(&slot);
    let entries = match std::fs::read_dir(&slot_dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    let mut control: Option<String> = None;
    for entry in entries.flatten() {
        let iface = entry.path();
        if !iface.is_dir() {
            continue;
        }
        let class = read_sysfs(&iface.join("bInterfaceClass").to_string_lossy());
        let subclass = read_sysfs(&iface.join("bInterfaceSubClass").to_string_lossy());
        match class.as_str() {
            "02" | "0a" => {}
            _ => continue,
        }
        let driver_link = iface.join("driver");
        if let Ok(target) = std::fs::read_link(&driver_link) {
            let driver = target.file_name().unwrap_or_default().to_string_lossy().to_string();
            if !driver.is_empty() && driver != "cdc_ncm" {
                let _ = write_sysfs(&driver_link.join("unbind").to_string_lossy(), &iface.file_name().unwrap_or_default().to_string_lossy());
            }
        }
        if format!("{}:{}", class, subclass) == "02:0d" {
            control = Some(iface.file_name().unwrap_or_default().to_string_lossy().to_string());
        }
    }

    let control = match control {
        Some(c) => c,
        None => return false,
    };
    let control_path = slot_dir.join(&control);
    let driver = if let Ok(target) = std::fs::read_link(control_path.join("driver")) {
        target.file_name().unwrap_or_default().to_string_lossy().to_string()
    } else {
        String::new()
    };
    if driver == "cdc_ncm" {
        return true;
    }
    let bind_path = Path::new(&sysfs)
        .join("bus/usb/drivers/cdc_ncm/bind")
        .to_string_lossy()
        .to_string();
    write_sysfs(&bind_path, &control)
}

/// Port of `mt5700m_bind_serial_driver`.
pub fn bind_serial_driver() -> bool {
    bind_network_driver();
    if pcui_port().is_some() {
        return true;
    }
    modprobe("usbserial");
    modprobe("option");
    for new_id in [
        format!("{}/bus/usb-serial/drivers/option1/new_id", sysfs_root()),
        format!("{}/bus/usb-serial/drivers/option/new_id", sysfs_root()),
    ] {
        if Path::new(&new_id).exists() {
            write_sysfs(&new_id, "3466 3301");
            bind_network_driver();
            return true;
        }
    }
    false
}
