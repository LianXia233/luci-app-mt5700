//! 自动探测 AT 口：按优先级逐个试探 /dev/ttyUSB*，第一个能应答 AT 的即选用。

use crate::{log_info, log_warn};
use crate::config::{SerialConfig, PREFERRED_AT_PORT};
use crate::transport::Transport;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 单个端口的探测超时。GPS 口只吐 NMEA 不回 OK，靠超时排除。
const AT_PROBE_TIMEOUT: Duration = Duration::from_millis(800);

fn list_serial_candidates() -> Vec<String> {
    let mut matches: Vec<String> = std::fs::read_dir("/dev")
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("ttyUSB"))
                .map(|n| format!("/dev/{n}"))
                .collect()
        })
        .unwrap_or_default();

    matches.sort_by_key(|p| {
        let idx = p.trim_start_matches("/dev/ttyUSB").parse::<u32>().unwrap_or(u32::MAX);
        (p != PREFERRED_AT_PORT, idx)
    });
    matches
}

/// 逐个探测候选串口，返回第一个能正常应答 AT 的设备。
pub async fn detect_at_port(cfg: &SerialConfig) -> Result<Box<dyn Transport>, String> {
    let candidates = list_serial_candidates();
    if candidates.is_empty() {
        return Err("没有找到任何 /dev/ttyUSB* 设备".into());
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

/// 往端口发一条 AT 并等 OK。能回 OK 或 ERROR 都算可用的 AT 口。
async fn probe_at(tp: Box<dyn Transport>) -> bool {
    let parts = tp.into_parts();
    let mut reader = parts.reader;
    let mut writer = parts.writer;
    if writer.write_all(b"AT\r").await.is_err() {
        return false;
    }

    let deadline = tokio::time::Instant::now() + AT_PROBE_TIMEOUT;
    let mut buf = [0u8; 256];
    let mut seen = String::new();

    loop {
        let remain = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remain.is_zero() {
            break;
        }
        let res = tokio::time::timeout(remain, reader.read(&mut buf)).await;
        match res {
            Ok(Ok(n)) if n > 0 => {
                seen.push_str(&String::from_utf8_lossy(&buf[..n]));
                if seen.contains("OK") || seen.contains("ERROR") {
                    return true;
                }
            }
            Ok(Ok(_)) => {}
            _ => return false,
        }
    }
    false
}
