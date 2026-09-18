//! 自动探测 AT 口：按优先级逐个试探候选串口，第一个能应答 AT 的即选用。
//!
//! 候选与优先级设计（对应两类实机故障）：
//!
//! 1) 候选不能只限 ttyUSB*。MT5700M 在不同 USB 组合下 AT 口可能枚举成 ttyACM*
//!    （AT^SETMODE 可切换 ECM/NCM/RNDIS/PPP，组合变了接口类就变），部分固件上
//!    还会挂到 ttyS*/ttyAMA*。此前只认 ttyUSB 会让 serial_port=auto（默认值）
//!    直接报「没有找到任何 /dev/ttyUSB* 设备」，而前端下拉框却能列出这些设备——
//!    表现为「手工选串口能用，默认自动探测永远失败」。
//!
//! 2) 优先级不能靠硬编码编号。was: 把 /dev/ttyUSB1 当成 PCUI 优先——
//!    枚举顺序由内核与 option 驱动绑定顺序决定，随版本变化，写死编号不可靠。
//!    now: 读 sysfs 的 USB 接口名字符串（PCUI / Application / GPS ...）打分，
//!    拿不到 sysfs 信息时才退回编号偏好。

use crate::{log_info, log_warn};
use crate::config::{SerialConfig, PREFERRED_AT_PORT};
use crate::transport::Transport;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 单个端口的探测超时。GPS 口只吐 NMEA 不回 OK，靠超时排除。
const AT_PROBE_TIMEOUT: Duration = Duration::from_millis(800);
/// 探测失败前最多保留的未成行字节，防止异常端口刷爆内存。
const MAX_PROBE_RESIDUAL: usize = 8192;
/// 单次探测的候选上限。优先级排序后靠前的端口才值得试；
/// 无上限时一台机器上几十个 ttyS* 会让探测耗时以 800ms × N 增长。
const MAX_PROBE_CANDIDATES: usize = 10;

/// 候选串口前缀（与前端 service.js 的串口下拉框保持一致）。
const USB_SERIAL_PREFIXES: &[&str] = &["ttyUSB", "ttyACM", "ttyAP"];
const OTHER_SERIAL_PREFIXES: &[&str] = &["ttyS", "ttyAMA"];

fn is_prefixed(name: &str, prefixes: &[&str]) -> bool {
    let base = name.trim_end_matches(|c: char| c.is_ascii_digit());
    let has_digit = name.len() > base.len();
    has_digit && prefixes.iter().any(|p| base == *p)
}

fn is_usb_serial(name: &str) -> bool {
    is_prefixed(name, USB_SERIAL_PREFIXES)
}

fn is_any_candidate(name: &str) -> bool {
    is_usb_serial(name) || is_prefixed(name, OTHER_SERIAL_PREFIXES)
}

fn serial_index(name: &str) -> u32 {
    let digits: String = name.chars().skip_while(|c| !c.is_ascii_digit()).collect();
    digits.parse::<u32>().unwrap_or(u32::MAX)
}

/// 读取 USB 串口对应的接口名字符串（如 "PCUI"、"Application Interface"）。
/// 非 USB 串口（ttyS*、ttyAMA*）没有该 sysfs 节点，返回 None。
fn port_interface_name(dev: &str) -> Option<String> {
    let name = dev.trim_start_matches("/dev/");
    // /sys/class/tty/ttyUSB1/device -> .../<iface>/ttyUSB1，其父目录才是接口目录
    let port = std::fs::canonicalize(format!("/sys/class/tty/{name}/device")).ok()?;
    let ifdir = port.parent()?;
    std::fs::read_to_string(ifdir.join("interface"))
        .ok()
        .map(|s| s.trim().to_string())
}

/// 端口优先级：元组越小越优先。
/// 0=PCUI/AT 口，1=模组/命令口，2=未知，3=明确不是 AT 口（GPS/诊断口）。
fn port_rank(dev: &str) -> (u8, u8, u32) {
    let iface = port_interface_name(dev).unwrap_or_default().to_uppercase();
    let score: u8 = if iface.contains("PCUI") || iface.contains("ATPORT") || iface.contains("AT PORT") {
        0
    } else if iface.contains("MODEM") || iface.contains("AT") || iface.contains("COMMAND") {
        1
    } else if iface.contains("GPS")
        || iface.contains("GNSS")
        || iface.contains("NMEA")
        || iface.contains("DIAG")
    {
        3
    } else {
        2
    };
    // 同分时：PREFERRED_AT_PORT 只是「常见编号偏好」，不再当作事实。
    let prefer: u8 = if dev == PREFERRED_AT_PORT { 0 } else { 1 };
    (score, prefer, serial_index(dev.trim_start_matches("/dev/")))
}

/// 列出候选串口。USB 串口存在时只返回 USB 串口：模组的 AT 口必然来自 USB，
/// 把几十个 ttyS* 混进来只会让探测白等。只有在完全没有 USB 串口时
/// 才回落到其它串口类型（覆盖把 AT 口挂到 SoC 串口的特殊机型）。
fn list_serial_candidates() -> Vec<String> {
    let mut all: Vec<String> = std::fs::read_dir("/dev")
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| is_any_candidate(n))
                .map(|n| format!("/dev/{n}"))
                .collect()
        })
        .unwrap_or_default();

    let usb: Vec<String> = all
        .iter()
        .filter(|p| is_usb_serial(p.trim_start_matches("/dev/")))
        .cloned()
        .collect();

    let mut chosen = if usb.is_empty() { std::mem::take(&mut all) } else { usb };
    chosen.sort_by_key(|p| port_rank(p));
    chosen.dedup();
    chosen.truncate(MAX_PROBE_CANDIDATES);
    chosen
}

/// 逐个探测候选串口，返回第一个能正常应答 AT 的设备。
pub async fn detect_at_port(cfg: &SerialConfig) -> Result<Box<dyn Transport>, String> {
    let candidates = list_serial_candidates();
    if candidates.is_empty() {
        return Err("没有找到任何候选串口（已尝试 ttyUSB/ttyACM/ttyAP/ttyS/ttyAMA）".into());
    }

    log_info!("自动探测 AT 口，候选: {}", candidates.join(" "));

    for port in &candidates {
        let mut probe = cfg.clone();
        probe.port = port.clone();

        let tp = match crate::serial_linux::open_serial(&probe).await {
            Ok(tp) => tp,
            Err(e) => {
                log_info!("  {} 打开失败: {}", port, e);
                continue;
            }
        };
        if probe_at(tp).await {
            log_info!("  {} 应答正常，选用该端口", port);
            // 探测用的连接已随函数返回而关闭，这里重新打开一条正式连接。
            match crate::serial_linux::open_serial(&probe).await {
                Ok(tp) => return Ok(tp),
                Err(e) => log_warn!("  重新打开 {} 失败: {}", port, e),
            }
        }
        log_info!("  {} 无有效应答，跳过", port);
    }

    Err("候选串口都没有正常应答 AT".into())
}

/// 往端口发一条 AT 并等结束行。能回 OK 或 ERROR 都算可用的 AT 口。
async fn probe_at(tp: Box<dyn Transport>) -> bool {
    let parts = tp.into_parts();
    let mut reader = parts.reader;
    let mut writer = parts.writer;
    if writer.write_all(b"AT\r").await.is_err() {
        return false;
    }

    let deadline = tokio::time::Instant::now() + AT_PROBE_TIMEOUT;
    let mut buf = [0u8; 256];
    let mut residual: Vec<u8> = Vec::new();

    loop {
        let remain = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remain.is_zero() {
            break;
        }
        let res = tokio::time::timeout(remain, reader.read(&mut buf)).await;
        match res {
            Ok(Ok(n)) if n > 0 => {
                residual.extend_from_slice(&buf[..n]);
                // 按整行判定，不做子串匹配。此前用 seen.contains("OK")，
                // 命令回显与 URC 拼接（如 ^SIMSQ: 0,123OK）都会把不可用的端口
                // 误判成 AT 口，于是自动探测可能选中 GPS/应用口。
                while let Some(i) = residual.iter().position(|&b| b == b'\n') {
                    let line = String::from_utf8_lossy(&residual[..i]).trim().to_string();
                    residual.drain(..=i);
                    if is_final_line(&line) {
                        return true;
                    }
                }
                if residual.len() > MAX_PROBE_RESIDUAL {
                    residual.clear();
                }
            }
            Ok(Ok(_)) => {}
            _ => return false,
        }
    }
    false
}

/// 是否为 AT 应答的结束行（严格整行匹配）。
pub fn is_final_line(line: &str) -> bool {
    match line {
        "OK" | "ERROR" | "ABORTED" | "NO CARRIER" => return true,
        _ => {}
    }
    line.starts_with("+CME ERROR") || line.starts_with("+CMS ERROR")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_line_matches_only_whole_line() {
        assert!(is_final_line("OK"));
        assert!(is_final_line("ERROR"));
        assert!(is_final_line("+CME ERROR: 3"));
        assert!(is_final_line("+CMS ERROR: 500"));
        // 子串不算：回显拼接、URC 尾部带 OK 都不能判定为应答
        assert!(!is_final_line("AT OK"));
        assert!(!is_final_line("^SIMSQ: 0,123OK"));
        assert!(!is_final_line("OKAY"));
        assert!(!is_final_line("^SETAUTODIAL: 1,1"));
    }

    #[test]
    fn candidate_filter_accepts_usb_and_soc_serials() {
        assert!(is_any_candidate("ttyUSB0"));
        assert!(is_any_candidate("ttyACM0"));
        assert!(is_any_candidate("ttyS0"));
        assert!(is_any_candidate("ttyAMA0"));
        // 无数字后缀的同名前缀不是串口节点
        assert!(!is_any_candidate("ttyUSB"));
        assert!(!is_any_candidate("ttyprintk"));
        assert!(!is_any_candidate("null"));
    }

    #[test]
    fn usb_serial_detection() {
        assert!(is_usb_serial("ttyUSB1"));
        assert!(is_usb_serial("ttyACM3"));
        assert!(!is_usb_serial("ttyS0"));
        assert!(!is_usb_serial("ttyAMA0"));
    }

    #[test]
    fn serial_index_parses_trailing_number() {
        assert_eq!(serial_index("ttyUSB0"), 0);
        assert_eq!(serial_index("ttyUSB12"), 12);
        assert_eq!(serial_index("ttyS3"), 3);
        assert_eq!(serial_index("ttyACM7"), 7);
    }
}
