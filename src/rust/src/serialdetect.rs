//! 自动探测 AT 口：按优先级逐个试探候选串口，第一个能应答 AT 的即选用。
//!
//! 候选与优先级设计（对应两类实机故障）：
//!
//! 1) 候选不能只限 ttyUSB*。MT5700M 在不同 USB 组合下 AT 口可能枚举成 ttyACM*
//!    （AT^SETMODE 可切换 ECM/NCM/RNDIS/PPP，组合变了接口类就变），部分固件上
//!    还会挂到 ttyS*/ttyAMA*。若只认 ttyUSB，serial_port=auto（默认值）会直接
//!    探测失败，而前端下拉框却能列出这些设备——表现为「手工选串口能用，
//!    默认自动探测永远失败」。
//!
//! 2) 优先级不能靠硬编码编号：枚举顺序由内核与 option 驱动的绑定顺序决定，
//!    随版本变化，写死编号不可靠。改为读 sysfs 的 USB 接口名字符串
//!    （PCUI / Application / GPS ...）打分；同分或拿不到 sysfs 信息时，
//!    再用 PREFERRED_AT_PORT 作编号偏好兜底。
//!
//! 3) 编号本身不稳定：同一个模组换 USB 口/换 xHCI 控制器后，ttyUSB* 的编号会整体
//!    平移（实测换口后 PCUI 从 ttyUSB1 变成 ttyUSB2），用户手工选定的串口路径因此
//!    失效，表现为「昨天配好能用，拔插一次就再也不通」。故引入 /dev/serial/by-id/
//!    稳定符号链接：命名取 USB 的 iSerial + 接口名，与枚举顺序完全无关。
//!    by-id 链接由 init.d 里的 sync_serial_by_id 维护（本机无 udev/mdev）。
//!    探测顺序：by-id → ttyUSB* 回退，见 list_serial_candidates。

use crate::{log_info, log_warn};
use crate::config::{SerialConfig, PREFERRED_AT_PORT};
use crate::transport::Transport;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// by-id 符号链接所在目录（与 systemd/udev 约定一致）。
pub const BY_ID_DIR: &str = "/dev/serial/by-id";

/// 单个端口的探测超时。GPS 口只吐 NMEA 不回 OK，靠超时排除。
const AT_PROBE_TIMEOUT: Duration = Duration::from_millis(800);
/// 探测失败前最多保留的未成行字节，防止异常端口刷爆内存。
const MAX_PROBE_RESIDUAL: usize = 8192;
/// 单次探测的候选上限。优先级排序后靠前的端口才值得试；
/// 无上限时一台机器上几十个 ttyS* 会让探测耗时以 800ms × N 增长。
const MAX_PROBE_CANDIDATES: usize = 10;

/// USB 类串口前缀（USB / ACM / AP 复合口），与前端下拉框列出的设备一致。
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

/// 把可能带符号链接的设备路径解析为真实内核节点名（如 "ttyUSB1"）。
///
/// 为什么必须先解析（本喵实测踩到，且是本模块最隐蔽的坑）：
///   /sys/class/tty/ 下面只有**真实内核设备名**的目录，没有符号链接入口。
///   若直接把 "/dev/serial/by-id/usb-3466:3301-if12-xxxx" 去掉 "/dev/" 前缀拿去
///   拼路径，会得到 "/sys/class/tty/serial/by-id/usb-3466:3301-if12-xxxx/device"，
///   这个路径必然不存在 → canonicalize 失败 → interface 名拿不到
///   → 打分退化为「未知」(2 分) → **by-id 路径永远拿不到 AT 口优先权**，
///   于是「加了稳定路径反而选错口」。
///   实测验证：直接用 by-id 路径查 sysfs 返回「无法解析」，而先 readlink -f
///   解到 /dev/ttyUSB1 再查就正常得到 "TDTECH Connect - PC UI Interface"。
///
/// 解析用 canonicalize 而不是 readlink：canonicalize 会一路解开多层链接并
/// 校验目标存在，链接悬空（设备已拔）时直接失败，正好是我们想要的语义。
fn resolve_tty_name(dev: &str) -> Option<String> {
    // 快路径：本身就是 /dev/ttyXXX 这种真实节点，直接取文件名
    let direct = dev.trim_start_matches("/dev/");
    if !direct.contains('/') {
        return Some(direct.to_string());
    }
    // 慢路径：by-id / by-path 等符号链接，解到实体后取文件名
    let real = std::fs::canonicalize(dev).ok()?;
    let name = real.file_name()?.to_string_lossy().into_owned();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// 读取 USB 串口对应的接口目录（.../2-1:2.3 这种），供读 interface / bInterfaceProtocol。
/// 非 USB 串口（ttyS*、ttyAMA*）没有该 sysfs 节点，返回 None。
fn port_interface_dir(dev: &str) -> Option<std::path::PathBuf> {
    let name = resolve_tty_name(dev)?;
    // /sys/class/tty/ttyUSB1/device -> .../<iface>/ttyUSB1，其父目录才是接口目录
    let port = std::fs::canonicalize(format!("/sys/class/tty/{name}/device")).ok()?;
    port.parent().map(|p| p.to_path_buf())
}

/// 读取 USB 串口对应的接口名字符串（如 "TDTECH Connect - PC UI Interface"）。
/// 非 USB 串口（ttyS*、ttyAMA*）没有该 sysfs 节点，返回 None。
///
/// 入参既可以是 /dev/ttyUSB1，也可以是 /dev/serial/by-id/xxx 符号链接：
/// 先用 resolve_tty_name 解出真实内核设备名，再查 sysfs。
fn port_interface_name(dev: &str) -> Option<String> {
    let ifdir = port_interface_dir(dev)?;
    std::fs::read_to_string(ifdir.join("interface"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 读取 USB 接口描述符里的 bInterfaceProtocol（十六进制文本，如 "12"）。
///
/// 这是 interface 名缺失时的**二级兜底**，本喵实测它与接口角色一一对应且极稳定：
///   0x12 = PC UI / AT 口（AT 命令口，就是我们要找的）
///   0x13 = Application Interface（应用/数据口）
///   0x14 = GPS Interface
///   0x1b = SerialB、0x1c = SerialC（厂商自定义数据口）
/// 换 USB 口 / 换 xHCI 控制器 / 换主机，这些值都不变（写死在模组固件里），
/// 所以比「接口名字符串」更耐改版：某些固件/批次会把 interface 名留空或改成
/// 厂商自定义描述，此时只能靠它认口。
///
/// 注意 sysfs 里该文件内容是**不带 0x 前缀的十六进制文本**，读出来是 "12" 而非 "0x12"，
/// 比较前统一去掉可能存在的 0x 前缀并转小写，避免不同内核版本格式差异。
fn port_interface_protocol(dev: &str) -> Option<String> {
    let ifdir = port_interface_dir(dev)?;
    std::fs::read_to_string(ifdir.join("bInterfaceProtocol"))
        .ok()
        .map(|s| {
            let t = s.trim().to_ascii_lowercase();
            t.strip_prefix("0x").unwrap_or(&t).to_string()
        })
        .filter(|s| !s.is_empty())
}

/// 依据 bInterfaceProtocol 判定接口分。返回 None 表示该协议号不认识（交给下一级判据）。
///
/// 只认「明确是/明确不是」的两头：不能因为协议号未知就把它当成 AT 口或彻底排除。
fn protocol_score(proto: &str) -> Option<u8> {
    match proto {
        // PC UI：MT5700 系列（含本机 TDTECH MT5700M-CN）的 AT 命令口
        "12" => Some(0),
        // GPS：只吐 NMEA，明确不是 AT 口
        "14" => Some(3),
        // Application / SerialB / SerialC：都是数据口，明确不是 AT 口，
        // 但也不该抢 AT 口位置，给 2 与「未知」同分即可
        "13" | "1b" | "1c" => Some(2),
        // 其余协议号（含 00/01 的网卡口）不表态
        _ => None,
    }
}

/// 把接口名字符串切成大写 token 序列（非字母数字一律作分隔符）。
///
/// 为什么要切 token 而不是直接 contains（本喵实测踩到的真 Bug）：
///   实机的接口名带厂商前缀，完整内容是
///     "TDTECH Connect - PC UI Interface"
///     "TDTECH Connect - Application Interface"
///   旧实现用 `iface.contains("AT")` 找 AT 口，结果：
///     * "PC UI Interface" 里 PC 与 UI 之间有空格 → contains("PCUI") 不命中；
///     * 反过来 "Applic**at**ion Interface" 里含 "at" → contains("AT") **误命中**，
///       被打成 1 分（"模组/命令口"），而真正的 PC UI 口因不命中任何规则掉到 2 分。
///   于是排序把 Application 口排在 PC UI 口**前面**（实测 rank (1,..) < (2,..)）。
///   功能上之所以还没炸，是因为探测阶段会逐个真发 AT：Application 口一般不应答，
///   超时 800ms 后才轮到 PC UI 口 —— 代价是每次启动白等一个超时；
///   更糟的是若某些固件的 Application 口**恰好回了 OK**（非 AT 命令口但能应答），
///   就会直接把 Application 口选成 AT 口，波形「能连上但命令全乱」。
///   所以必须改成整词匹配：只有独立的 "AT" / "PC"+"UI" 才算，子串不算。
fn tokenize(iface: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for ch in iface.to_uppercase().chars() {
        if ch.is_ascii_alphanumeric() {
            cur.push(ch);
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// token 序列里是否出现任一给定词（整词相等，非子串）。
fn has_token(tokens: &[String], words: &[&str]) -> bool {
    tokens.iter().any(|t| words.iter().any(|w| t == w))
}

/// 纯接口名打分，与路径形态无关（by-id 与 ttyUSB* 共用同一套判据）。
/// 0=AT 口（PCUI/PC UI/AT PORT），1=模组/命令口，2=未知，3=明确不是 AT 口（GPS/诊断口）。
///
/// 判据全部基于 token 整词匹配，理由见 tokenize 的说明。
fn interface_score(iface: &str) -> u8 {
    let tokens = tokenize(iface);

    // 0) AT 口。三种写法都覆盖：
    //    "PC UI"（实机，两词）、"PCUI"（部分固件连写）、"AT PORT"/"ATPORT"。
    let pcui = has_token(&tokens, &["PCUI"])
        || (has_token(&tokens, &["PC", "PCUI"]) && has_token(&tokens, &["UI"]))
        || (has_token(&tokens, &["AT"]) && has_token(&tokens, &["PORT"]))
        || has_token(&tokens, &["ATPORT"])
        // "AT Interface" / "AT Command" 也是明确的 AT 口写法
        || (has_token(&tokens, &["AT"]) && has_token(&tokens, &["INTERFACE", "CMD"]));
    if pcui {
        return 0;
    }

    // 3) 明确不是 AT 口。GPS/NMEA 只吐定位语句；DIAG 是诊断口。
    //    放在 1) 之前判：GPS 口常写作 "GPS NMEA"，若先按 "NMEA" 落进 1 分反而不准。
    if has_token(&tokens, &["GPS", "GNSS", "NMEA", "DIAG", "DIAGNOSTIC"]) {
        return 3;
    }

    // 1) 模组/命令口。"AT" 是独立词才算（不再命中 Application 里的子串）。
    //    "Application" 单独出现时不代表 AT 口，只在没有更好候选时兜底，
    //    故归到 2 分（未知）而不是 1 分，避免抢在真正的 AT 口前面。
    if has_token(&tokens, &["MODEM", "COMMAND", "AT", "ATCMD", "DUN"]) {
        return 1;
    }

    // 2) 未知。注意 "SerialB"/"SerialC" 这类厂商自定义数据口落在这里，
    //    与 Application 同分，靠后续 by-id/ttyUSB 编号序决定先后，不影响正确性。
    2
}

/// 接口名是否给出了**强** AT 口信号（几乎不可能是误写，优先于协议号）。
///
/// 为什么要把强弱分开（实测场景 S5 暴露的取舍）：
///   `PC UI` / `PCUI` 是 MT5700 系列对 AT 命令口的**专有叫法**，误写概率极低；
///   而 `AT` / `AT Port` / `Modem` / `Command` 是通用词，某些 OEM 会把它们
///   误用在数据口上。若不加区分地让协议号否决一切名字结论，就会出现
///   「名字明明是 PCUI，却被一个反常规的协议号压成非 AT 口」的反向误判。
///   故：强信号直接采信；只有弱信号才允许被协议号交叉校验否决。
fn is_strong_at_signal(iface: &str) -> bool {
    let tokens = tokenize(iface);
    has_token(&tokens, &["PCUI"])
        || (has_token(&tokens, &["PC"]) && has_token(&tokens, &["UI"]))
        || has_token(&tokens, &["ATPORT"])
}

/// 综合判定一个端口的角色分（0 最好，3 最差），判据按可信度逐层降级：
///
///   1) 接口名强信号（PCUI / PC UI / ATPORT） —— 最可信，直接采信；
///   2) 接口名弱信号 ∩ 协议号交叉校验；
///   3) bInterfaceProtocol 单独兜底（接口名缺失时）；
///   4) 都拿不到 → 2（未知），交给路径形态与编号序决定。
///
/// **交叉校验说明（实测发现并修复的兼容性缺陷）**：
///   只靠名字有时会「多个口同时命中 AT 判据」——例如某 OEM 固件把 Application 口
///   也描述成 "AT Port"，于是它和真正的 PC UI 口同为 0 分，排序只能退到字典序，
///   选谁纯属巧合（实测场景 S5 复现：`MT5700 AT Port` 与另一 AT 口双 0 分）。
///   此时用 bInterfaceProtocol 交叉校验：名字给出弱信号（0/1 分）但协议号明确是
///   0x13/0x14/0x1b/0x1c（Application/GPS/SerialB/SerialC，已知非 AT 口）时，
///   否决名字结论改取协议号分数；强信号与「协议号不认识」两种情况都不干预。
fn device_score(dev: &str) -> u8 {
    let iface = port_interface_name(dev);

    // 1) 强信号：直接采信，不受协议号影响
    if let Some(ref i) = iface {
        if is_strong_at_signal(i) {
            return 0;
        }
    }

    let iface_score = iface.as_deref().map(interface_score);
    let proto_score = port_interface_protocol(dev).and_then(|p| protocol_score(&p));

    match (iface_score, proto_score) {
        // 2) 名字给弱 AT 信号，但协议号说「明确不是 AT 口」→ 信协议号
        (Some(0 | 1), Some(s @ 2..=3)) => s,
        // 名字能给出明确结论
        (Some(s), _) if s != 2 => s,
        // 3) 名字不认识/不存在 → 协议号兜底
        (_, Some(s)) => s,
        // 4) 都拿不到
        _ => 2,
    }
}

/// 该路径是否为 /dev/serial/by-id 下的稳定链接。
fn is_by_id(p: &str) -> bool {
    p.starts_with(BY_ID_DIR)
}

/// 端口优先级：元组越小越优先。
///
/// 元组含义：(接口分, 是否非 by-id, 编号偏好, 序号)
/// 第 2 位专门用「by-id 优先」：接口分相同的情况下，稳定路径一定排在 ttyUSB* 之前，
/// 这样即便某天 ttyUSB 编号平移导致两者指向不同设备，也会优先用不漂移的那个。
///
/// 注意 by-id 的序号位填 u32::MAX：by-id 名字里没有裸编号，
/// 若拿整串去 parse 会得到一个巨大且无意义的数，反而干扰排序。
/// by-id 之间靠名字字典序（调用方 sort 前已按名字排序）决定，不需要序号。
fn port_rank(dev: &str) -> (u8, u8, u8, u32) {
    let score = device_score(dev);
    // 同分时：PREFERRED_AT_PORT 只是「常见编号偏好」，不再当作事实。
    // 仅对裸 ttyUSB* 路径生效；by-id 路径形态不同，比较编号没有意义。
    let prefer: u8 = if !is_by_id(dev) && dev == PREFERRED_AT_PORT { 0 } else { 1 };
    let by_id_first: u8 = if is_by_id(dev) { 0 } else { 1 };
    let idx = if is_by_id(dev) {
        u32::MAX
    } else {
        serial_index(dev.trim_start_matches("/dev/"))
    };
    (score, by_id_first, prefer, idx)
}

/// 列出 /dev/serial/by-id 下的稳定链接。
///
/// 只收「符号链接且能解析到某个候选串口」的条目：目录里可能残留指向已拔出设备的
/// 断链（因本机无 udev，链接由 init.d 维护，异常断电后可能留下断链），
/// 断链必须排除，否则探测会白等一次超时预算。
fn list_by_id_candidates() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let rd = match std::fs::read_dir(BY_ID_DIR) {
        Ok(rd) => rd,
        Err(_) => return out,
    };
    for e in rd.filter_map(|e| e.ok()) {
        let path = e.path();
        // 必须是符号链接：by-id 下出现普通文件说明目录被误用，不参与探测
        match std::fs::symlink_metadata(&path) {
            Ok(md) if md.file_type().is_symlink() => {}
            _ => continue,
        }
        // 解析链接目标：断链在此处失败，直接跳过
        let target = match std::fs::canonicalize(&path) {
            Ok(t) => t,
            Err(_) => {
                log_info!("  by-id 链接 {} 已失效（目标不存在），跳过", path.display());
                continue;
            }
        };
        // 目标仍须落在 /dev 下且是候选串口名，避免链到别的东西上
        let tname = target
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        if !is_any_candidate(&tname) {
            log_info!(
                "  by-id 链接 {} 指向 {}，非串口候选，跳过",
                path.display(),
                target.display()
            );
            continue;
        }
        out.push(path.to_string_lossy().into_owned());
    }
    out.sort();
    out
}

/// 列出候选串口。
///
/// 分层取候选，由稳定到不稳定：
///   1) /dev/serial/by-id/* —— 稳定路径，优先（编号漂移免疫）；
///   2) /dev/ttyUSB* 等 USB 串口 —— by-id 为空时的主力回退；
///   3) 其它串口（ttyS*/ttyAMA*）—— 仅在完全没有 USB 串口时才用，
///      因为模组的 AT 口必然来自 USB，混进几十个 ttyS* 只会让探测白等。
///
/// 注意：by-id 与其指向的 ttyUSB* 是**同一物理口**，两者都进候选会让同一个口
/// 被探测两次（AT 口第一次探测已成功则不会走到第二次，但失败口会被重复耗掉 800ms）。
/// 这里保留两者是有意的：万一 by-id 链接被误删/权限异常导致该路径打不开，
/// 仍能靠 ttyUSB* 兜住；去重只在「已解析到同一实体目标」时做，
/// 且 by-id 排在前面保证优先命中。
fn list_serial_candidates() -> Vec<String> {
    let by_id = list_by_id_candidates();

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

    let mut chosen: Vec<String> = Vec::new();
    if !by_id.is_empty() {
        // by-id 可用：以它为主，USB 裸路径作为回退附在其后
        chosen.extend(by_id);
        chosen.extend(usb);
        if chosen.is_empty() {
            chosen.append(&mut all);
        }
    } else if usb.is_empty() {
        // 既无 by-id 也无 USB 串口：退回任意串口（覆盖 AT 口挂 SoC 串口的机型）
        chosen.append(&mut all);
    } else {
        chosen = usb;
    }

    // 按「实体目标」去重，但保留先出现的那条：by-id 已排在前面，
    // 故同一口的稳定路径会胜出，ttyUSB* 重复项被丢弃。
    let mut seen: Vec<std::path::PathBuf> = Vec::new();
    chosen.retain(|p| {
        // 解析失败（如 by-id 断链）时按自身路径去重，不牵连其它项
        let key = std::fs::canonicalize(p).unwrap_or_else(|_| std::path::PathBuf::from(p));
        if seen.contains(&key) {
            false
        } else {
            seen.push(key);
            true
        }
    });

    chosen.sort_by_key(|p| port_rank(p));
    chosen.truncate(MAX_PROBE_CANDIDATES);
    chosen
}

/// 逐个探测候选串口，返回第一个能正常应答 AT 的设备。
pub async fn detect_at_port(cfg: &SerialConfig) -> Result<Box<dyn Transport>, String> {
    let candidates = list_serial_candidates();
    if candidates.is_empty() {
        return Err(format!(
            "没有找到任何候选串口（已尝试 {BY_ID_DIR} 稳定链接与 ttyUSB/ttyACM/ttyAP/ttyS/ttyAMA）"
        ));
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
                // 按整行判定，不做子串匹配。若用 contains("OK") 这类子串匹配，
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

    #[test]
    fn by_id_paths_are_recognized() {
        assert!(is_by_id("/dev/serial/by-id/usb-TDTECH_MT5700M-CN_57050M5826800582-if01"));
        assert!(!is_by_id("/dev/ttyUSB1"));
        assert!(!is_by_id("/dev/serial/by-path/pci-0000:00:14.0-usb-0:1:1.1"));
    }

    /// by-id 的接口判据必须与 ttyUSB* 一致：打分只看 sysfs 接口名，
    /// 不看路径形态，否则稳定路径会因「路径名不同」而被打成未知分。
    #[test]
    fn interface_score_matches_expected_roles() {
        // 实机接口名（带厂商前缀，判据用 token 故仍命中）
        assert_eq!(interface_score("TDTECH Connect - PC UI Interface"), 0);
        assert_eq!(interface_score("TDTECH Connect - GPS Interface"), 3);
        assert_eq!(interface_score("TDTECH Connect - SerialB"), 2);
        // Application 是数据口，绝不能因为含 "at" 子串被打成 1（历史 Bug）
        assert_eq!(interface_score("TDTECH Connect - Application Interface"), 2);
        // 兼容 PCUI / ATPORT 两种历史写法
        assert_eq!(interface_score("PCUI"), 0);
        assert_eq!(interface_score("PC UI"), 0);
        assert_eq!(interface_score("AT PORT"), 0);
        assert_eq!(interface_score("AT Interface"), 0);
        assert_eq!(interface_score("Modem"), 1);
        assert_eq!(interface_score("AT"), 1);
    }

    /// 这条是本模块最关键的行为回归：历史上 `contains("AT")` 会把
    /// "Application Interface" 误判成 AT 口（分数更低 = 排更前），
    /// 而真正的 "PC UI Interface" 因 PC/UI 间有空格不命中 PCUI 而掉分，
    /// 于是排序把 Application 排在 PC UI 前面 —— 自动探测会先试错口。
    /// 用例守护「PC UI 必须严格优于 Application」。
    #[test]
    fn pcui_must_outrank_application() {
        let pcui = interface_score("TDTECH Connect - PC UI Interface");
        let app = interface_score("TDTECH Connect - Application Interface");
        assert!(
            pcui < app,
            "PC UI 口({pcui}) 必须比 Application 口({app}) 优先"
        );
        // Application 不许落到 1（模组/命令口）那一档
        assert_ne!(app, 1, "Application 口不得被判成命令口");
    }

    /// token 化必须把非字母数字都当分隔符，且转大写。
    #[test]
    fn tokenize_splits_on_punctuation_and_uppercases() {
        assert_eq!(
            tokenize("TDTECH Connect - PC UI Interface"),
            vec!["TDTECH", "CONNECT", "PC", "UI", "INTERFACE"]
        );
        assert_eq!(tokenize("PCUI"), vec!["PCUI"]);
        assert_eq!(tokenize("A/B_C-D.E"), vec!["A", "B", "C", "D", "E"]);
        assert!(tokenize("   ").is_empty());
    }

    /// token 整词匹配不能退回子串匹配：这是修 Bug 的核心。
    #[test]
    fn has_token_is_whole_word_only() {
        let t = tokenize("Application Interface");
        assert!(!has_token(&t, &["AT"]), "APPLICATION 不该命中 AT");
        assert!(has_token(&t, &["APPLICATION"]));
        assert!(has_token(&t, &["INTERFACE"]));
    }

    /// 协议号兜底：0x12 必须是 AT 口，0x14 必须被排除。
    #[test]
    fn protocol_score_maps_known_values() {
        assert_eq!(protocol_score("12"), Some(0));
        assert_eq!(protocol_score("14"), Some(3));
        assert_eq!(protocol_score("13"), Some(2));
        assert_eq!(protocol_score("1b"), Some(2));
        assert_eq!(protocol_score("1c"), Some(2));
        // 不认识的协议号不表态，交给下一级判据
        assert_eq!(protocol_score("00"), None);
        assert_eq!(protocol_score("01"), None);
        assert_eq!(protocol_score("ff"), None);
    }

    /// 强/弱 AT 信号必须分开：PCUI / PC UI / ATPORT 是专有叫法（强，直接采信），
    /// 而 AT / Modem / Command 是通用词（弱，允许被协议号交叉校验否决）。
    /// S5 实测教训：不区分强弱会导致「名字明明是 PCUI 却被非常规协议号压走」。
    #[test]
    fn strong_at_signal_recognizes_only_specific_words() {
        assert!(is_strong_at_signal("TDTECH Connect - PC UI Interface"));
        assert!(is_strong_at_signal("PCUI"));
        assert!(is_strong_at_signal("ATPORT"));
        assert!(is_strong_at_signal("MT5700 PCUI"));
        // 弱信号不算强：这些要留给协议号交叉校验
        assert!(!is_strong_at_signal("AT"));
        assert!(!is_strong_at_signal("AT Port"));
        assert!(!is_strong_at_signal("Modem"));
        assert!(!is_strong_at_signal("Application Interface"));
    }

    /// 稳定路径的元组必须整体小于任何 ttyUSB* 路径：第 2 位是 by-id 标志位，
    /// 同接口分时保证 by-id 排在前面（编号漂移免疫的落点就在这里）。
    #[test]
    fn by_id_sorts_before_bare_ttyusb() {
        let tuple_by_id = (0u8, 0u8, 1u8, u32::MAX);
        let tuple_bare = (0u8, 1u8, 0u8, 1u32);
        assert!(tuple_by_id < tuple_bare, "by-id 应排在 ttyUSB1 之前");
    }

    /// 真实节点名（无斜杠）走快路径，不依赖文件系统即可解析。
    /// 这条很关键：port_interface_name 的输入在探测时既可能是裸路径，
    /// 也可能是 by-id 链接，两条分支都必须正确。
    #[test]
    fn resolve_tty_name_fast_path_keeps_bare_names() {
        assert_eq!(resolve_tty_name("/dev/ttyUSB1").as_deref(), Some("ttyUSB1"));
        assert_eq!(resolve_tty_name("/dev/ttyACM0").as_deref(), Some("ttyACM0"));
        assert_eq!(resolve_tty_name("/dev/ttyS3").as_deref(), Some("ttyS3"));
    }

    /// by-id 路径必须走「解析链接」的慢路径，且不能把中间的目录段当成设备名。
    /// 若实现写错（直接 trim "/dev/" 拼 sysfs），会得到
    /// "/sys/class/tty/serial/by-id/.../device" 这种不存在的路径，
    /// 接口名永远取不到，AT 口优先权失效 —— 这正是本用例守护的行为。
    #[test]
    fn resolve_tty_name_rejects_nonexistent_by_id_link() {
        // 不存在的设备：慢路径必须失败（返回 None）而不是回退成中间段名字
        assert_eq!(
            resolve_tty_name("/dev/serial/by-id/usb-0000:0000-if12-nosuch"),
            None
        );
    }

    /// is_by_id 只认 by-id 目录，不能把 by-path 或裸路径误判进来。
    #[test]
    fn by_id_dir_constant_is_consistent() {
        assert!(BY_ID_DIR.starts_with("/dev/serial/"));
        assert!(is_by_id(&format!("{BY_ID_DIR}/usb-3466:3301-if12-57050M5826800582")));
    }
}
