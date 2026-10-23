//! SMS PDU 编解码。
//!
//! 解码侧负责 SMS-DELIVER（模组收进来、我们用 `AT+CMGR` / `AT+CMGL` 读出来的东西）：
//! GSM7 / UCS2 / 8bit 三种编码、UDH 长短信、字母数字发送方、时区。
//!
//! 编码侧负责 SMS-SUBMIT（我们发出去的）：自动选编码、自动分片、自动加 UDH，
//! 输出可直接喂给 `AT+CMGS=<TPDU 长度>\r<PDU>` 的分片列表。
//!
//! 两侧共用同一张 GSM 03.38 字母表，避免「收得对、发得错」这种只在一个
//! 方向暴露的偏差。

// 手动写 `(x + n - 1) / n` / `% n != 0` 而不是用 `div_ceil` / `is_multiple_of`：
// 本包要进 OpenWrt 各版本交叉编译，而这两个方法分别稳定于 Rust 1.73 / 1.87，
// 老版本 OpenWrt 自带的 Rust 工具链会直接编译失败。可移植性优先于 lint。
#![allow(clippy::manual_div_ceil, clippy::manual_is_multiple_of)]

use crate::localtime;
use crate::nettime;
use chrono::{DateTime, TimeZone};

/// 3GPP TS 23.038 默认字母表（按码位索引）。
const GSM7_ALPHABET: &str = concat!(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?",
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
);

/// 0x1B 转义表：入参为 0x1B 之后的码位，返回对应扩展字符。
fn gsm7_extension(c: u8) -> Option<char> {
    match c {
        0x0A => Some('\u{000C}'),
        0x14 => Some('^'),
        0x28 => Some('{'),
        0x29 => Some('}'),
        0x2F => Some('\\'),
        0x3C => Some('['),
        0x3D => Some('~'),
        0x3E => Some(']'),
        0x40 => Some('|'),
        0x65 => Some('€'),
        _ => None,
    }
}

/// 反查扩展表：扩展字符 → 0x1B 之后的码位。
fn gsm7_extension_code(c: char) -> Option<u8> {
    match c {
        '\u{000C}' => Some(0x0A),
        '^' => Some(0x14),
        '{' => Some(0x28),
        '}' => Some(0x29),
        '\\' => Some(0x2F),
        '[' => Some(0x3C),
        '~' => Some(0x3D),
        ']' => Some(0x3E),
        '|' => Some(0x40),
        '€' => Some(0x65),
        _ => None,
    }
}

/// 用户数据的编码方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmEncoding {
    Gsm7,
    Ucs2,
    EightBit,
}

impl SmEncoding {
    pub fn name(self) -> &'static str {
        match self {
            SmEncoding::Gsm7 => "GSM7",
            SmEncoding::Ucs2 => "UCS2",
            SmEncoding::EightBit => "8BIT",
        }
    }
}

/// 按 3GPP TS 23.038 Table 4 判定 DCS 的字符编码。
///
/// 关键点：DCS 的 **高 4 位（bits 7-4）决定编码组**，只有离开组别的语境直接看
/// bits 3-2 是不成立的。先前照着 Go 参考实现写成的 `(dcs >> 2) & 0x03` 会把
/// `0xF6`（ bits7-4 = 1111 的消息类别组 + GSM7 ）判成 8-bit，于是运营商下发的
/// SIM 卡短信 / 端口短信全部变成 Latin-1 乱码。
fn resolve_encoding(dcs: u8) -> SmEncoding {
    match dcs >> 4 {
        // 通用数据编码组：bits 3-2 直接选字符集（bit5 为压缩位，不影响字符集）
        0x0..=0x3 => match (dcs >> 2) & 0x03 {
            0x02 => SmEncoding::Ucs2,
            0x01 => SmEncoding::EightBit,
            _ => SmEncoding::Gsm7,
        },
        // 消息等待指示组：bit2 选字符集（0=GSM7 / 1=UCS2）
        0xC | 0xD => {
            if dcs & 0x04 != 0 {
                SmEncoding::Ucs2
            } else {
                SmEncoding::Gsm7
            }
        }
        0xE => SmEncoding::Ucs2,
        // 数据编码 / 消息类别组：bit3 选字符集（0=GSM7 / 1=8bit）
        0xF => {
            if dcs & 0x08 != 0 {
                SmEncoding::EightBit
            } else {
                SmEncoding::Gsm7
            }
        }
        _ => SmEncoding::Gsm7,
    }
}

#[derive(Debug, Clone)]
pub struct PartialInfo {
    pub reference: u32,
    pub parts_count: u32,
    pub part_number: u32,
}

#[derive(Debug, Clone)]
pub struct Sms {
    pub sender: String,
    pub content: String,
    pub date: DateTime<localtime::Tz>,
    pub partial: Option<PartialInfo>,
}

/// 把 8 位字节流按 LSB-first 还原成 7 位码位序列（0x1B 扩展由 septets_to_string 处理）。
fn unpack_septets(data: &[u8], count: usize) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(count);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;

    for &b in data {
        acc |= (b as u32) << bits;
        bits += 8;
        while bits >= 7 {
            if out.len() == count {
                return out;
            }
            out.push((acc & 0x7F) as u8);
            acc >>= 7;
            bits -= 7;
        }
    }
    if bits > 0 && out.len() < count {
        out.push((acc & 0x7F) as u8);
    }
    out
}

fn septets_to_string(septets: &[u8]) -> String {
    let mut sb = String::new();
    let alphabet: Vec<char> = GSM7_ALPHABET.chars().collect();
    let mut i = 0;
    while i < septets.len() {
        let c = septets[i];
        if c == 0x1B && i + 1 < septets.len() {
            if let Some(r) = gsm7_extension(septets[i + 1]) {
                sb.push(r);
                i += 2;
                continue;
            }
        }
        if (c as usize) < alphabet.len() {
            sb.push(alphabet[c as usize]);
        } else {
            sb.push('?');
        }
        i += 1;
    }
    sb
}

fn decode_ucs2(data: &[u8]) -> String {
    let mut units: Vec<u16> = Vec::with_capacity(data.len() / 2);
    let mut i = 0;
    while i + 1 < data.len() {
        units.push(((data[i] as u16) << 8) | data[i + 1] as u16);
        i += 2;
    }
    String::from_utf16_lossy(&units)
}

/// 半字节交换 BCD：返回低半字节*10 + 高半字节（A-F 等非法值不在此校验）。
fn bcd_digit(b: u8) -> i32 {
    (b & 0x0F) as i32 * 10 + (b >> 4) as i32
}

/// 32 位 BCD 反向交换（编码用）：`12` → `0x21`。
fn bcd_swap(hi: u8, lo: u8) -> u8 {
    (hi << 4) | lo
}

/// 时区字节还原为分钟偏移。
///
/// SCTS 的第 7 字节同样按半字节交换存放「以 15 分钟为单位的偏移」，
/// 最高位为符号位。丢掉它等于把短信中心所在时区的时间直接当成本地时间，
/// 跨时区时会整体偏数小时。
fn timezone_offset_minutes(tz: u8) -> i32 {
    // SCTS 的时区字节与其它时间字段一样按半字节交换存放（十位在低半字节），
    // 单位是「一刻钟」，最高位 bit7 为符号位。
    let tens = (tz & 0x0F) as i32;
    let ones = ((tz >> 4) & 0x07) as i32;
    let minutes = (tens * 10 + ones) * 15;
    if tz & 0x80 != 0 {
        -minutes
    } else {
        minutes
    }
}

fn decode_timestamp(ts: &[u8]) -> DateTime<localtime::Tz> {
    if ts.len() < 7 {
        return nettime::now();
    }
    let year = 2000 + bcd_digit(ts[0]);
    let month = bcd_digit(ts[1]);
    let day = bcd_digit(ts[2]);
    let hour = bcd_digit(ts[3]);
    let minute = bcd_digit(ts[4]);
    let second = bcd_digit(ts[5]);

    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return nettime::now();
    }

    // SCTS 记录的是「短信中心本地时间 + 时区偏移」。先按 UTC 还原出真正的时刻，
    // 再按设备时区呈现；此前忽略时区字节直接按墙上时钟解释，跨时区会整体偏数小时。
    let naive_wall = match chrono::NaiveDate::from_ymd_opt(year, month as u32, day as u32)
        .and_then(|d| d.and_hms_opt(hour as u32, minute as u32, second as u32))
    {
        Some(n) => n,
        None => return nettime::now(),
    };
    let utc = naive_wall - chrono::Duration::minutes(timezone_offset_minutes(ts[6]) as i64);
    TimeZone::from_utc_datetime(&localtime::offset(), &utc)
}

/// 解码 BCD 电话号码，digits 为号码位数。
fn decode_number(data: &[u8], digits: usize) -> String {
    let mut sb = String::new();
    for &b in data {
        let lo = b & 0x0F;
        let hi = b >> 4;
        if lo <= 9 && sb.len() < digits {
            sb.push((b'0' + lo) as char);
        }
        if sb.len() < digits && hi <= 9 {
            sb.push((b'0' + hi) as char);
        }
    }
    sb
}

/// TON = 101 的地址字段是字母数字方式打包的 7 位字符，不是 BCD 数字。
fn is_alphanumeric_toa(toa: u8) -> bool {
    (toa >> 4) & 0x07 == 0x05
}

/// 字母数字地址占用的字节数。
///
/// TS 23.040 §9.1.2.5： alnum 地址的 `<address-length>` 是**字符数（septets）**，
/// 占用字节数为 ceil(digits * 7 / 8)。此前复用 BCD 的 `(digits + 1) / 2` 会把
/// 5 字符的 "hello"（应占 5 字节）当成 3 字节，剩下两个字节被当 PID/DCS 吃掉，
/// 整条 PDU 随即错位。
fn alnum_address_bytes(septets: usize) -> usize {
    (septets * 7 + 7) / 8
}

/// 解码地址字段，区分数字号码与字母数字发送方（如 "CMCC"）。
fn decode_address(data: &[u8], digits: usize, toa: u8) -> String {
    if is_alphanumeric_toa(toa) {
        // septets 本身就是字符数 —— alnum 的 address-length 不按 BCD 位数换算。
        return septets_to_string(&unpack_septets(data, digits));
    }
    decode_number(data, digits)
}

pub fn decode_incoming_pdu(pdu_hex: &str) -> Result<Sms, String> {
    let raw = hex::decode(pdu_hex.trim()).map_err(|_| "PDU 不是合法的十六进制".to_string())?;

    let mut pos = 0usize;

    fn cut<'a>(raw: &'a [u8], pos: &mut usize, n: usize) -> Result<&'a [u8], String> {
        if *pos + n > raw.len() {
            return Err("PDU 数据不完整".into());
        }
        let b = &raw[*pos..*pos + n];
        *pos += n;
        Ok(b)
    }

    let smsc_len = cut(&raw, &mut pos, 1)?[0] as usize;
    cut(&raw, &mut pos, smsc_len)?;

    let pdu_type = cut(&raw, &mut pos, 1)?[0];
    if pdu_type & 0x03 != 0x00 {
        return Err("不支持的 PDU 类型（仅支持 SMS-DELIVER）".into());
    }

    let sender_digits = cut(&raw, &mut pos, 1)?[0] as usize;
    let sender_toa = cut(&raw, &mut pos, 1)?[0];
    let sender_len = if is_alphanumeric_toa(sender_toa) {
        alnum_address_bytes(sender_digits)
    } else {
        (sender_digits + 1) / 2
    };
    let sender_bytes = cut(&raw, &mut pos, sender_len)?;
    let sender = decode_address(sender_bytes, sender_digits, sender_toa);

    cut(&raw, &mut pos, 1)?; // 协议标识符 PID
    let dcs = cut(&raw, &mut pos, 1)?[0];
    let ts_bytes = cut(&raw, &mut pos, 7)?;
    let udl = cut(&raw, &mut pos, 1)?[0] as usize;
    let ud = &raw[pos..];
    let required = match resolve_encoding(dcs) {
        SmEncoding::Gsm7 => (udl * 7 + 7) / 8,
        _ => udl,
    };
    if required > ud.len() {
        return Err("PDU 用户数据长度与 UDL 不一致".into());
    }

    let (content, partial) = decode_user_data(ud, udl, dcs, pdu_type & 0x40 != 0);

    Ok(Sms {
        sender,
        content,
        date: decode_timestamp(ts_bytes),
        partial,
    })
}

/// 解出用户数据（正文 + 分段信息）。DELIVER 与 SUBMIT 共用这一段布局。
fn decode_user_data(
    ud: &[u8],
    udl: usize,
    dcs: u8,
    udhi: bool,
) -> (String, Option<PartialInfo>) {
    let encoding = resolve_encoding(dcs);

    let mut udh_len = 0usize;
    let mut partial = None;
    if udhi && !ud.is_empty() {
        udh_len = ud[0] as usize + 1;
        if udh_len > ud.len() {
            return (String::new(), None);
        }
        partial = parse_udh_concat(&ud[1..udh_len]);
    }

    let content = match encoding {
        SmEncoding::Ucs2 => {
            let body = &ud[udh_len..];
            let end = body.len().min(udl.saturating_sub(udh_len));
            decode_ucs2(&body[..end])
        }
        SmEncoding::EightBit => {
            let body = &ud[udh_len..];
            let end = body.len().min(udl.saturating_sub(udh_len));
            body[..end].iter().map(|&b| b as char).collect()
        }
        SmEncoding::Gsm7 => {
            // 7 位编码里 UDH 也按码位计数，正文需对齐到 septet 边界。
            let udh_septets = (udh_len as u32 * 8 + 6) / 7;
            let mut total = udl;
            if total < udh_septets as usize {
                total = udh_septets as usize;
            }
            let septets = unpack_septets(ud, total);
            if udh_septets as usize <= septets.len() {
                septets_to_string(&septets[udh_septets as usize..])
            } else {
                String::new()
            }
        }
    };
    (content, partial)
}

// ==================== 模组存储里的短信（AT+CMGL / AT+CMGR 返回） ====================

/// 从存储区读出的一条短信。
#[derive(Debug, Clone)]
pub struct StoredSms {
    /// true = 对方发来的（SMS-DELIVER）；false = 本机发出、模组存下来的（SMS-SUBMIT）。
    pub incoming: bool,
    /// 对方号码（DELIVER 是发件人，SUBMIT 是收件人）。
    pub number: String,
    pub content: String,
    /// 时刻；SUBMIT 在没有绝对有效期时没有发送时刻，为 None。
    pub time: Option<DateTime<localtime::Tz>>,
    /// true 表示时刻来自 TP-VP 有效期，而不是真正的发送时刻。
    pub time_approx: bool,
    pub partial: Option<PartialInfo>,
    pub error: Option<String>,
}

/// 解析模组存储里的 PDU：按 TP-MTI 分派 DELIVER / SUBMIT。
///
/// `AT+CMGL=4` 会把**存下来的已发短信**也列出来（SMS-SUBMIT），把它当成
/// DELIVER 解会整条错位：SUBMIT 里没有 SCTS 时间戳、多了一个 TP-MR。
/// 参考实现就是一律按 DELIVER 解，于是已发短信的时间、号码全是错的。
pub fn decode_stored_pdu(pdu_hex: &str) -> StoredSms {
    let raw = match hex::decode(pdu_hex.trim()) {
        Ok(r) => r,
        Err(_) => {
            return StoredSms {
                incoming: true,
                number: String::new(),
                content: String::new(),
                time: None,
                time_approx: false,
                partial: None,
                error: Some("PDU 不是合法的十六进制".into()),
            }
        }
    };

    fn cut<'a>(raw: &'a [u8], pos: &mut usize, n: usize) -> Result<&'a [u8], String> {
        if *pos + n > raw.len() {
            return Err("PDU 数据不完整".into());
        }
        let b = &raw[*pos..*pos + n];
        *pos += n;
        Ok(b)
    }

    let mut pos = 0usize;
    let parsed = (|| -> Result<StoredSms, String> {
        let smsc_len = cut(&raw, &mut pos, 1)?[0] as usize;
        cut(&raw, &mut pos, smsc_len)?;
        let first = cut(&raw, &mut pos, 1)?[0];
        let mti = first & 0x03;
        let udhi = first & 0x40 != 0;

        match mti {
            0x00 => {
                // SMS-DELIVER：对方发来的
                let digits = cut(&raw, &mut pos, 1)?[0] as usize;
                let toa = cut(&raw, &mut pos, 1)?[0];
                let addr_bytes = if is_alphanumeric_toa(toa) {
                    alnum_address_bytes(digits)
                } else {
                    (digits + 1) / 2
                };
                let addr = cut(&raw, &mut pos, addr_bytes)?;
                let number = decode_address(addr, digits, toa);
                cut(&raw, &mut pos, 1)?; // PID
                let dcs = cut(&raw, &mut pos, 1)?[0];
                let ts = cut(&raw, &mut pos, 7)?;
                let udl = cut(&raw, &mut pos, 1)?[0] as usize;
                let ud = &raw[pos..];
                let (content, partial) = decode_user_data(ud, udl, dcs, udhi);
                Ok(StoredSms {
                    incoming: true,
                    number,
                    content,
                    time: Some(decode_timestamp(ts)),
                    time_approx: false,
                    partial,
                    error: None,
                })
            }
            0x01 => {
                // SMS-SUBMIT：本机发出的
                cut(&raw, &mut pos, 1)?; // TP-MR
                let digits = cut(&raw, &mut pos, 1)?[0] as usize;
                let toa = cut(&raw, &mut pos, 1)?[0];
                let addr_bytes = if is_alphanumeric_toa(toa) {
                    alnum_address_bytes(digits)
                } else {
                    (digits + 1) / 2
                };
                let addr = cut(&raw, &mut pos, addr_bytes)?;
                let number = decode_address(addr, digits, toa);
                cut(&raw, &mut pos, 1)?; // PID
                let dcs = cut(&raw, &mut pos, 1)?[0];
                // TP-VP：由 first octet 的 bit4:bit3 决定长度
                let vpf = (first >> 3) & 0x03;
                let mut time = None;
                let mut time_approx = false;
                match vpf {
                    0 => {} // 无有效期
                    2 => {
                        cut(&raw, &mut pos, 1)?; // 相对格式，1 字节，不含发送时刻
                    }
                    1 | 3 => {
                        // 增强/绝对格式：7 字节的 TP-VP，可以拿来近似当作发送时刻
                        let vp = cut(&raw, &mut pos, 7)?;
                        time = Some(decode_timestamp(vp));
                        time_approx = true;
                    }
                    _ => {}
                }
                let udl = cut(&raw, &mut pos, 1)?[0] as usize;
                let ud = &raw[pos..];
                let (content, partial) = decode_user_data(ud, udl, dcs, udhi);
                Ok(StoredSms {
                    incoming: false,
                    number,
                    content,
                    time,
                    time_approx,
                    partial,
                    error: None,
                })
            }
            _ => Err("暂不支持的 PDU 类型（状态报告/命令）".into()),
        }
    })();

    match parsed {
        Ok(s) => s,
        Err(e) => StoredSms {
            incoming: true,
            number: String::new(),
            content: String::new(),
            time: None,
            time_approx: false,
            partial: None,
            error: Some(e),
        },
    }
}

/// `AT+CMGL` 应答里的一条记录（手册 9.8.1）。
#[derive(Debug, Clone)]
pub struct CmglEntry {
    /// 模组报的存储槽位。**None = 头行里那个字段没读出来**，不是「0 号位」：
    /// 实机证明槽位确实从 0 开始（一张有两条分段短信的卡回过 `indices [0,1]`），
    /// 拿 0 当「读不出」的哨兵会把一条真短信永久变成删不掉的条目。
    pub index: Option<u32>,
    /// 手册 9.8.3 `<stat>`：0=收到的未读 1=收到的已读 2=存储的未发送 3=存储的已发送
    pub stat: u32,
    pub direction_incoming: bool,
    pub number: String,
    pub content: String,
    /// `YY/MM/DD,HH:MM:SS` 字符串（与前端现有口径一致）；无时刻时为 None。
    pub time: Option<String>,
    pub time_approx: bool,
    pub partial: Option<PartialInfo>,
    pub error: Option<String>,
}

/// 解析 `AT+CMGL=<stat>` 的应答行（手册 9.8.1）。
///
/// 形状是 `+CMGL: <index>,<stat>,[<reserved>],<length>` 紧跟一行 PDU，
/// 手册 9.8.5 的实例是 `+CMGL: 1,0,,25`。`<length>` 按 9.8.3 是 TPDU 的字节数
/// （十进制），本函数不读它：正文一律取下一行那串十六进制，长度只在模组侧用。
///
/// **别用它读 `AT+CMGR` 的应答**：手册 9.10.1 的形状是
/// `+CMGR: <stat>,[<reserved>],<length>`，**没有 `<index>` 字段**，第一个字段是状态。
/// 把两条命令当成同形就会把「已读」读成序号 1、把序号丢掉。单条读取走
/// `urc::parse_sms_response`，它只取 PDU 那一行，序号由调用方自己带着。
///
/// 解析失败的单条会带着 error 保留下来，界面上如实提示，而不是静默丢掉；
/// 这种条目如果连头行的序号都没读出来，`index` 是 **None**（删除侧据此拒发，
/// 见 `sms::delete`）—— 0 是一个合法槽位，不能拿来当哨兵。
pub fn parse_cmgl_response(lines: &[String]) -> Vec<CmglEntry> {
    let mut out: Vec<CmglEntry> = Vec::new();
    let mut i = 0usize;
    while i + 1 < lines.len() {
        let line = lines[i].trim();
        let Some(rest) = line.strip_prefix("+CMGL:") else {
            i += 1;
            continue;
        };
        let fields: Vec<&str> = rest.split(',').map(|p| p.trim()).collect();
        let index = fields.first().and_then(|s| s.parse::<u32>().ok());
        let stat = fields.get(1).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        let pdu = lines[i + 1].trim();
        i += 2;
        if pdu.is_empty() || !pdu.chars().all(|c| c.is_ascii_hexdigit()) {
            out.push(CmglEntry {
                index, stat, direction_incoming: true, number: String::new(), content: String::new(),
                time: None, time_approx: false, partial: None,
                error: Some("PDU 行为空或含非十六进制字符".into()),
            });
            continue;
        }
        let sms = decode_stored_pdu(pdu);
        out.push(CmglEntry {
            index,
            stat,
            direction_incoming: sms.incoming,
            number: sms.number,
            content: sms.content,
            time: sms.time.map(|t| t.format("%y/%m/%d,%H:%M:%S").to_string()),
            time_approx: sms.time_approx,
            partial: sms.partial,
            error: sms.error,
        });
    }
    out
}

/// 从 UDH 中取出长短信分段信息（IEI 0x00 为 8 位序号，0x08 为 16 位）。
fn parse_udh_concat(udh: &[u8]) -> Option<PartialInfo> {
    let mut i = 0;
    while i + 1 < udh.len() {
        let iei = udh[i];
        let ie_len = udh[i + 1] as usize;
        let body = i + 2;
        if body + ie_len > udh.len() {
            return None;
        }
        match (iei, ie_len) {
            (0x00, l) if l >= 3 => {
                return Some(PartialInfo {
                    reference: udh[body] as u32,
                    parts_count: udh[body + 1] as u32,
                    part_number: udh[body + 2] as u32,
                });
            }
            (0x08, l) if l >= 4 => {
                return Some(PartialInfo {
                    reference: ((udh[body] as u32) << 8) | udh[body + 1] as u32,
                    parts_count: udh[body + 2] as u32,
                    part_number: udh[body + 3] as u32,
                });
            }
            _ => {}
        }
        i = body + ie_len;
    }
    None
}

// ==================== 发送侧：SMS-SUBMIT 编码 ====================

/// 单条 SMS-SUBMIT 的分片上限（用户数据部分，不含 SMSC 头）。
const UD_MAX_OCTETS: usize = 140;
/// 8 位连接头 UDH：UDHL + IEI + IEDL + ref + total + seq = 6 字节。
const CONCAT_UDH_LEN: usize = 6;
/// 6 字节 UDH 在 7 位编码里占用的 septet 数 = ceil(6*8/7)。
const CONCAT_UDH_SEPTETS: usize = 7;

/// 一个 SMS-SUBMIT 分片。
#[derive(Debug, Clone)]
pub struct SubmitPart {
    /// 完整 PDU（含 SMSC 字段）的十六进制串，大写。
    pub pdu: String,
    /// `AT+CMGS` 要的长度：**不含** SMSC 字段的 TPDU 字节数。
    /// 手册 9.14.3 只写了「长度指示」，取值以 9.14.5 的实例为准：
    /// `AT+CMGS=18` 配的 PDU 是 19 字节（首字节 `00` 是 SMSC 长度），18 = TPDU 字节数。
    pub tpdu_length: usize,
    pub part_number: u8,
    pub parts_count: u8,
}

/// 编码结果的整体描述，供上层组装提示文案。
#[derive(Debug, Clone)]
pub struct SubmitPlan {
    pub parts: Vec<SubmitPart>,
    pub encoding: SmEncoding,
    pub reference: u16,
}

/// 地址是否可以按 GSM 7bit 默认字母表表示。
fn is_gsm7_char(c: char) -> bool {
    GSM7_ALPHABET.contains(c) || gsm7_extension_code(c).is_some() || c == '\r' || c == '\n'
}

/// 一个字符占几个 septet（扩展字符占 2 个：ESC + 码位）。
fn septets_of(c: char) -> usize {
    if GSM7_ALPHABET.contains(c) {
        1
    } else {
        2 // 只可能是扩展表里的字符，调用方已用 is_gsm7_char 预检
    }
}

/// 整个消息能否按 GSM 7bit 编码。含任何表外字符（中英文之外的 emoji、中文…
/// 严格说是所有非 GSM 字符，中文必然不行）都要转 UCS2。
pub fn pick_encoding(message: &str) -> SmEncoding {
    if message.chars().all(is_gsm7_char) {
        SmEncoding::Gsm7
    } else {
        SmEncoding::Ucs2
    }
}

/// 按实机 `normalize()` 的口径归一收件人号码，返回可以直接交给 [`encode_address`] 的串。
///
/// 实机在编码之前多走这一步，因为它决定 TOA 取 0x81 还是 0x91、以及要不要补国家码：
///   - 先去掉空白、`-`、`()`、`.`，`+` 只认最前面那一个；
///   - `+` 开头，或 `00` 开头的国际前缀 → 国际格式；
///   - 裸的 11 位、`1` 开头的手机号 → 补上 `86` 走国际格式；
///   - 12 位以上且已经带 `86` → 国际格式；
///   - 其余（特服短号、固话）→ 国内格式，不补任何前缀。
///
/// 本插件原先「照用户输入的写法编码」，于是界面上填 `13800138000` 会以国内格式
/// （0x81）发出。实机那条路是这台模组 + 这张卡真发出去过的写法，短号（如 `10000`）
/// 也确实是按 0x81 发的 —— 两种情形各归各位，不能一刀切。
///
/// 长度上下限沿用 [`encode_address`] 的 3～20 位（实机放到 2 位，但没有 2 位可达
/// 号码，放开只会让手滑多一个出口）；两处结论必须一致，所以这里先判一次。
///
/// 「裸 11 位且 `1` 开头就补 `86`」是本机（MT5700M-CN，大陆运营商）的口径，与实机
/// 完全一致；代价是一个不带 `+` 的外国 11 位号码会被当成大陆手机号。真要给国际
/// 号码用就照实机的写法带上前导 `+` —— `+` 是这里唯一的、不会猜错的信号。
pub fn normalize_destination(raw: &str) -> Result<String, String> {
    if raw.trim().is_empty() {
        return Err("缺少收件人号码".into());
    }
    let mut digits = String::new();
    let mut international = false;
    for ch in raw.trim().chars() {
        match ch {
            // `+` 只允许出现在号码之前；号码中间再出 `+` 是打错了。
            '+' if digits.is_empty() && !international => international = true,
            '0'..='9' => digits.push(ch),
            ' ' | '\t' | '\r' | '\n' | '-' | '(' | ')' | '.' => {}
            c => return Err(format!("号码格式不正确（仅允许可选前导 +、数字与分隔符 -()，遇到 {c}）")),
        }
    }
    if digits.len() < 3 || digits.len() > 20 {
        return Err("号码长度不正确（应为 3 至 20 位）".into());
    }
    // `00` 是手动拨国际长途的写法，去掉它，剩下的按国际格式编。
    if !international && digits.starts_with("00") && digits.len() > 8 {
        international = true;
        digits.drain(..2);
    }
    if international {
        return Ok(format!("+{digits}"));
    }
    if digits.len() == 11 && digits.starts_with('1') {
        return Ok(format!("+86{digits}")); // 裸的大陆手机号
    }
    if digits.len() >= 12 && digits.starts_with("86") {
        return Ok(format!("+{digits}")); // 国家码写了但没写 +
    }
    Ok(digits)
}

/// 把地址打包成 PDU 地址字段。
///
/// `include_len` 为真时在前面加一个长度字节：
///   - SMSC（TP-SCCC 的第一字节）记的是 **TOA + 号码** 的总字节数；
///   - TP-DA（目的地址）记的是 **号码位数**，两者不是一回事。
///     参考实现里两者混用了同一套算法，号码位数或 SMSC 字节数会被算错。
fn encode_address(number: &str, is_smsc: bool, include_len: bool) -> Result<Vec<u8>, String> {
    let trimmed = number.trim();
    let has_plus = trimmed.starts_with('+');
    let digits = if has_plus { &trimmed[1..] } else { trimmed };
    // 第二个 `+` 不可能通过下面的全数字检查，所以不必单独数 `+` 的个数。
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err("号码格式不正确（仅允许可选前导 + 和数字）".into());
    }
    // 故意不支持 1–2 位短号/特服号：SUBMIT 的地址字段要按 TON/NPI 选类型，
    // 这里固定 0x81/0x91（国内/国际 ISDN），把 10086、12345 这类按普通号码编
    // 出来网络侧也不认。真要支持短号得先补 TON/NPI 分支，而不是放开长度下限。
    // 与后端 `valid_phone_address`（3–20 位）保持同一口径，避免两边结论不一致。
    if digits.len() < 3 || digits.len() > 20 {
        return Err("号码长度不正确（应为 3 至 20 位）".into());
    }
    let digits = digits.to_string();
    // TOA：国际格式（带 +）用 0x91，国内/unknown 用 0x81。
    let toa: u8 = if has_plus { 0x91 } else { 0x81 };

    let mut packed = digits.clone();
    if packed.len() % 2 != 0 {
        packed.push('F'); // 奇数位补 F
    }
    let mut body: Vec<u8> = Vec::new();
    let bytes: Vec<char> = packed.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        let hi = bytes[i].to_digit(16).unwrap_or(0) as u8;
        let lo = bytes[i + 1].to_digit(16).unwrap_or(0) as u8;
        body.push(bcd_swap(lo, hi)); // 半字节交换
        i += 2;
    }

    let mut out: Vec<u8> = Vec::new();
    if include_len {
        let len = if is_smsc {
            body.len() + 1 // 号码字节 + TOA
        } else {
            digits.len() // 号码位数
        };
        out.push(len as u8);
    }
    out.push(toa);
    out.extend_from_slice(&body);
    Ok(out)
}

/// GSM 7bit 打包（低位在前），把 septet 逐个写进给定的比特流。
/// 返回写入的 septet 数。
fn write_septets(w: &mut BitWriter, chars: &[char]) -> usize {
    let mut n = 0usize;
    for &c in chars {
        match GSM7_ALPHABET.chars().position(|x| x == c) {
            Some(code) => w.push_lsb(code as u32, 7),
            None => {
                if let Some(ext) = gsm7_extension_code(c) {
                    w.push_lsb(0x1B, 7);
                    w.push_lsb(ext as u32, 7);
                    n += 1; // 转义多占一个 septet
                } else {
                    // 调用方必须先用 pick_encoding 检查，这里用 '?' 兜底而不是 panic
                    w.push_lsb(b'?' as u32, 7);
                }
            }
        }
        n += 1;
    }
    n
}

/// 低位在前的比特写入器。
///
/// GSM 的做法是把 UDH 与正文当成**同一条 LSB-first 比特流**：UDH 按字节排在前面，
/// 补若干填充位让正文对齐到 septet 边界，正文再按 septet 依次排下去。
/// 参考实现（以及本项目更早的版本）到这里往往直接按字节拼 UDH 与正文，
/// 于是 UDH 尾部残余的几个比特会把正文整体错位 —— 表现为「7bit 长短信除了
/// 第一段全是乱码」。用统一的比特流写就不会错位。
struct BitWriter {
    bytes: Vec<u8>,
    nbits: usize,
}

impl BitWriter {
    fn new() -> BitWriter {
        BitWriter { bytes: Vec::new(), nbits: 0 }
    }

    /// 写入 `n` 个比特，第 i 位取自 `value` 的第 i 位（低位在前）。
    fn push_lsb(&mut self, value: u32, n: usize) {
        for i in 0..n {
            let bit = ((value >> i) & 1) as u8;
            let idx = self.nbits;
            if idx / 8 >= self.bytes.len() {
                self.bytes.push(0);
            }
            self.bytes[idx / 8] |= bit << (idx % 8);
            self.nbits += 1;
        }
    }

    /// 补 0 直到总比特数是 `unit` 的整数倍。
    fn align_to(&mut self, unit: usize) {
        while self.nbits % unit != 0 {
            self.push_lsb(0, 1);
        }
    }

    fn finish(mut self) -> Vec<u8> {
        self.align_to(8);
        self.bytes
    }
}

/// UCS2（UTF-16BE）编码，返回字节。
fn encode_ucs2(s: &str) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    for unit in s.encode_utf16() {
        out.push((unit >> 8) as u8);
        out.push((unit & 0xFF) as u8);
    }
    out
}

/// 构造 UDH 的 8 位连接头。
fn concat_udh(reference: u8, parts_count: u8, part_number: u8) -> Vec<u8> {
    vec![
        (CONCAT_UDH_LEN - 1) as u8, // UDHL：不含自身
        0x00,                       // IEI：8 位参考号的连接头
        0x03,                       // IEDL
        reference,
        parts_count,
        part_number,
    ]
}

/// 一条消息的用户数据配额（单个 septet/字符数，不含 UDH）。
fn per_part_capacity(encoding: SmEncoding, concat: bool) -> usize {
    match encoding {
        SmEncoding::Gsm7 => {
            if concat {
                UD_MAX_OCTETS * 8 / 7 - CONCAT_UDH_SEPTETS // 153
            } else {
                UD_MAX_OCTETS * 8 / 7 // 160
            }
        }
        // UCS2 每个字符 2 字节
        _ => {
            let avail = if concat {
                UD_MAX_OCTETS - CONCAT_UDH_LEN
            } else {
                UD_MAX_OCTETS
            };
            avail / 2 // 67 / 70
        }
    }
}

/// 按配额把消息切成若干片，GSM7 按 septet 计、UCS2 按 UTF-16 码元计。
///
/// UCS2 分片必须**按字符边界**切，不能把一个代理对（emoji 等增补平面字符）
/// 劈成两半，否则两片各自解出替身字符。
fn split_message(message: &str, encoding: SmEncoding, concat: bool) -> Vec<String> {
    let per = per_part_capacity(encoding, concat);
    if per == 0 {
        return vec![message.to_string()];
    }
    match encoding {
        SmEncoding::Gsm7 => {
            let mut parts: Vec<String> = Vec::new();
            let mut cur = String::new();
            let mut used = 0usize;
            for c in message.chars() {
                let cost = septets_of(c);
                if used + cost > per && !cur.is_empty() {
                    parts.push(cur.clone());
                    cur.clear();
                    used = 0;
                }
                cur.push(c);
                used += cost;
            }
            if !cur.is_empty() || parts.is_empty() {
                parts.push(cur);
            }
            parts
        }
        _ => {
            let mut parts: Vec<String> = Vec::new();
            let mut cur = String::new();
            let mut used = 0usize;
            for c in message.chars() {
                let cost = c.len_utf16(); // 代理对记 2 个码元
                if used + cost > per && !cur.is_empty() {
                    parts.push(cur.clone());
                    cur.clear();
                    used = 0;
                }
                cur.push(c);
                used += cost;
            }
            if !cur.is_empty() || parts.is_empty() {
                parts.push(cur);
            }
            parts
        }
    }
}

/// 短信提交的选项。
#[derive(Debug, Clone, Default)]
pub struct SubmitOptions {
    /// 对方号码（可带 `+`；不带 `+` 时按国内号码编码）。
    pub destination: String,
    /// 正文。
    pub message: String,
    /// 短信中心号码，留空表示用 SIM 卡里存的那一个（SMSC 长度字节写 0）。
    pub smsc: Option<String>,
    /// 相对有效期（TP-VP 字节），默认 0xA7 = 24 小时。
    ///
    /// TP-VP 用的是 3GPP TS 23.040 §9.2.3.12 的相对有效期编码（本 AT 手册不含该表，
    /// 别按字面当小时数读）：`0～143` 为 `(n+1)×5` 分钟，`144～167` 为
    /// `12 小时 + (n−143)×30` 分钟（**167 = 24 小时**），`168～196` 为 `(n−166)×1 天`
    /// （168 已经是 **2 天**，不是 24 小时），`197～255` 为 `(n−192)×1 周`。
    /// 相邻档在边界上是连续跳跃的：143→12 小时、144→12.5 小时、167→24 小时、
    /// 168→48 小时、196→30 天、197→35 天，可以拿这条自查读表有没有读歪。
    /// 厂商 WebUI 的短信发送用的正是 0xA7（= 24 小时）。
    pub validity: Option<u8>,
    /// 8 位连接头参考号；不给则随机取 1..=255。
    pub reference: Option<u8>,
}

/// 构造真正要发出去的分片列表（按片序排列）。
///
/// `tpdu_length` 是 TPDU 字节数、**不含前面的 SMSC 字段**，厂商 WebUI 的编码器算的也是
/// 这一个数（它把 SMSC 字段单独拼在 TPDU 之前、长度只取 TPDU 部分），与本插件一致。
/// 提交形态取手册 9.14.5 的一次性写法 `AT+CMGS=<长度>` + 字面 `\r` + `<PDU>`，
/// 由 `sms.rs::send` 下发。
pub fn build_submit_parts(opts: &SubmitOptions) -> Result<SubmitPlan, String> {
    if opts.destination.trim().is_empty() {
        return Err("缺少收件人号码".into());
    }
    if opts.message.is_empty() {
        return Err("短信内容为空".into());
    }
    let destination = normalize_destination(&opts.destination)?;
    let message = &opts.message;

    let encoding = pick_encoding(message);
    let da = encode_address(&destination, false, true)?;

    // 先试单条；超限时才引入 UDH。
    let mut chunks = split_message(message, encoding, false);
    let concat = chunks.len() > 1;
    if concat {
        chunks = split_message(message, encoding, true);
    }
    if chunks.len() > 255 {
        return Err("短信过长，超过 255 段拼接上限".into());
    }
    let parts_count = chunks.len() as u8;
    let reference = opts.reference.unwrap_or_else(|| {
        // 参考号只需在同一收件人的短窗口内不重复；用单调时钟的低字节足够。
        let seed = (monotonic_seed() % 255) as u8;
        seed.saturating_add(1)
    });

    let sca: Vec<u8> = match opts.smsc.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(sc) => encode_address(sc, true, true)?,
        None => vec![0x00], // 0 长度 = 用卡里配的短信中心
    };
    let vp = opts.validity.unwrap_or(0xA7);
    let dcs: u8 = match encoding {
        SmEncoding::Gsm7 => 0x00,
        SmEncoding::Ucs2 => 0x08,
        SmEncoding::EightBit => 0x04,
    };

    let mut parts = Vec::with_capacity(parts_count as usize);
    for (i, chunk) in chunks.iter().enumerate() {
        // TP-MTI = SMS-SUBMIT(0x01) | TP-VPF = 相对(bit4:bit3 = 10，即 0x10) | TP-SRR(0x20，索要状态报告)
        // 注意 0x20 是 bit5 的 TP-SRR，不是 bit2 的 TP-RD(0x04)——见 23.038 的 SMS-SUBMIT 首字节表。
        let mut first_octet: u8 = 0x01 | 0x20 | 0x10;
        let udh_value = if concat {
            first_octet |= 0x40; // TP-UDHI
            Some(concat_udh(reference, parts_count, (i + 1) as u8))
        } else {
            None
        };
        let chars: Vec<char> = chunk.chars().collect();

        let (ud, udl) = if let Some(udh) = udh_value {
            match encoding {
                // 7bit：UDH 与正文共享同一条 LSB-first 比特流，中间由 align_to(7)
                // 补出规范要求的填充位；TP-UDL 计的是 septet 总数（含 UDH 与填充）。
                SmEncoding::Gsm7 => {
                    let mut w = BitWriter::new();
                    for b in &udh {
                        w.push_lsb(*b as u32, 8);
                    }
                    w.align_to(7);
                    let body = write_septets(&mut w, &chars);
                    let ud = w.finish();
                    // TP-UDL = UDH 占的 septet 数（含 align_to(7) 补的填充位）+ 正文 septet 数。
                    let udl = CONCAT_UDH_SEPTETS + body;
                    (ud, udl)
                }
                // UCS2：UDH 按字节前置即可（本身就是字节对齐），TP-UDL 是字节数。
                _ => {
                    let mut ud: Vec<u8> = Vec::new();
                    ud.extend_from_slice(&udh);
                    ud.extend_from_slice(&encode_ucs2(chunk));
                    let udl = ud.len();
                    (ud, udl)
                }
            }
        } else {
            match encoding {
                SmEncoding::Gsm7 => {
                    let mut w = BitWriter::new();
                    let body = write_septets(&mut w, &chars);
                    (w.finish(), body)
                }
                _ => {
                    let ud = encode_ucs2(chunk);
                    let udl = ud.len();
                    (ud, udl)
                }
            }
        };

        if ud.len() > UD_MAX_OCTETS {
            return Err(format!("短信分片超出 {} 字节上限（{}）", UD_MAX_OCTETS, ud.len()));
        }

        // TPDU：不含 SMSC 字段
        let mut tpdu: Vec<u8> = Vec::new();
        tpdu.push(first_octet);
        tpdu.push(0x00); // TP-MR（模组自行填写）
        tpdu.extend_from_slice(&da);
        tpdu.push(0x00); // TP-PID
        tpdu.push(dcs);
        tpdu.push(vp);
        tpdu.push(udl.min(255) as u8);
        tpdu.extend_from_slice(&ud);

        let mut full: Vec<u8> = Vec::new();
        full.extend_from_slice(&sca);
        full.extend_from_slice(&tpdu);

        parts.push(SubmitPart {
            pdu: hex_upper(&full),
            tpdu_length: tpdu.len(),
            part_number: (i + 1) as u8,
            parts_count,
        });
    }

    Ok(SubmitPlan { parts, encoding, reference: reference as u16 })
}

fn hex_upper(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02X}"));
    }
    s
}

fn monotonic_seed() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEED: AtomicU64 = AtomicU64::new(0x9E3779B97F4A7C15);
    let v = SEED.fetch_add(0x6C078965, Ordering::Relaxed);
    v ^ (v >> 33)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 发送方 13800138000，时间戳 2025-08-25 12:00:00，UCS2 正文 "测试"。
    const UCS2_PDU: &str = "00040B913108108300F0000852805221000023046D4B8BD5";

    // 同一个头，DCS=00，GSM 7-bit 正文 "hello"。
    const GSM7_PDU: &str = "00040B913108108300F000005280522100002305E8329BFD06";

    #[test]
    fn rejects_more_than_255_concat_parts_and_invalid_addresses() {
        let too_long = "测".repeat(67 * 255 + 1);
        let opts = SubmitOptions { destination: "13800138000".into(), message: too_long, ..Default::default() };
        assert!(build_submit_parts(&opts).unwrap_err().contains("255 段"));
        for destination in ["12+3", "123,45", "123\rAT+CMGS=1"] {
            let opts = SubmitOptions { destination: destination.into(), message: "x".into(), ..Default::default() };
            assert!(build_submit_parts(&opts).is_err(), "should reject {destination:?}");
        }
    }

    #[test]
    fn test_decode_ucs2_pdu() {
        let sms = decode_incoming_pdu(UCS2_PDU).unwrap();
        assert_eq!(sms.sender, "13800138000");
        assert_eq!(sms.content, "测试");
        // SCTS 是「短信中心本地时间 2025-08-25 12:00:00，偏移 +08:00」，
        // 绝对时刻为 04:00 UTC。期望值必须按中心时区构造：早先用设备时区
        // （localtime::from_ymdhms）换算，只有设备恰好也在东八区时才成立，
        // 换到 UTC 环境就会误报。
        let center = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
        let want = center
            .with_ymd_and_hms(2025, 8, 25, 12, 0, 0)
            .single()
            .unwrap();
        assert_eq!(sms.date.timestamp(), want.timestamp());
        assert!(sms.partial.is_none());
    }

    #[test]
    fn test_decode_gsm7_pdu() {
        let sms = decode_incoming_pdu(GSM7_PDU).unwrap();
        assert_eq!(sms.content, "hello");
    }

    #[test]
    fn test_decode_concatenated_pdu() {
        // PDU 类型 0x44 带 UDH；UDH 为 05 00 03 2A 02 01：
        // 8 位分段头 reference=0x2A(42)，共 2 段，当前第 1 段，正文 UCS2 "测"。
        let pdu = "00440B913108108300F0000852805221000023080500032A02016D4B";
        let sms = decode_incoming_pdu(pdu).unwrap();
        let partial = sms.partial.expect("应该识别出分段信息");
        assert_eq!(partial.reference, 42);
        assert_eq!(partial.parts_count, 2);
        assert_eq!(partial.part_number, 1);
        assert_eq!(sms.content, "测");
    }

    #[test]
    fn test_decode_16bit_concat_reference() {
        // IEI 0x08：16 位序号 reference=0x0102(258)，共 3 段，当前第 2 段。
        let pdu = "00440B913108108300F000085280522100002309060804010203026D4B";
        let sms = decode_incoming_pdu(pdu).unwrap();
        let partial = sms.partial.expect("应该识别出分段信息");
        assert_eq!(partial.reference, 258);
        assert_eq!(partial.parts_count, 3);
        assert_eq!(partial.part_number, 2);
    }

    #[test]
    fn test_decode_malformed_pdu() {
        for bad in ["", "ZZ", "00", "0004", "00040B91", "00040B9131"] {
            assert!(decode_incoming_pdu(bad).is_err(), "输入 {:?} 应当返回错误", bad);
        }
    }

    #[test]
    fn test_decode_alphanumeric_sender() {
        // TOA=0xD0 字母数字发送方，5 个 7 位字符 "hello"（address-length 记字符数）。
        let pdu = "000405D0E8329BFD06000852805221000023026D4B";
        let sms = decode_incoming_pdu(pdu).unwrap();
        assert_eq!(sms.sender, "hello", "alnum 地址应按字符数取 septet");
        assert_eq!(sms.content, "测");
    }

    #[test]
    fn test_alnum_address_reads_full_bytes() {
        // 回归：alnum 地址占 ceil(digits*7/8) 字节而非 (digits+1)/2 字节。
        // 若仍按 BCD 算法取 3 字节，后面两个地址字节会被错当成 PID/DCS，
        // 整条 PDU 随即错位（表现是发送方乱码 + 时间错乱）。
        assert_eq!(alnum_address_bytes(5), 5);
        assert_eq!(alnum_address_bytes(10), 9);
    }

    #[test]
    fn test_gsm7_extension() {
        // 0x1B 0x65 是扩展表里的欧元符号。
        assert_eq!(septets_to_string(&[0x1B, 0x65, b'a']), "€a");
    }

    #[test]
    fn resolve_encoding_handles_message_class_dcs() {
        // 0xF6 = 消息类别组 + GSM7：bits7-4=1111 → bit3=0 → GSM7。
        // 早期实现直接算 (dcs>>2)&0x03 得 1，判成 8-bit，SIM 卡/端口短信全乱码。
        assert_eq!(resolve_encoding(0xF6), SmEncoding::Gsm7);
        assert_eq!(resolve_encoding(0xF5), SmEncoding::Gsm7);
        assert_eq!(resolve_encoding(0x00), SmEncoding::Gsm7);
        assert_eq!(resolve_encoding(0x04), SmEncoding::EightBit);
        assert_eq!(resolve_encoding(0x08), SmEncoding::Ucs2);
        assert_eq!(resolve_encoding(0xD0), SmEncoding::Gsm7);
        assert_eq!(resolve_encoding(0xD4), SmEncoding::Ucs2);
    }

    #[test]
    fn timezone_offset_is_signed_quarters() {
        // 时区字节与其它 BCD 字段一样半字节交换（十位在低半字节），单位是一刻钟。
        // 0x21 → 十位 1、个位 2 → 12 刻 = +180 分钟；最高位 bit7 为负号。
        assert_eq!(timezone_offset_minutes(0x21), 180);
        assert_eq!(timezone_offset_minutes(0x21 | 0x80), -180);
        assert_eq!(timezone_offset_minutes(0x00), 0);
        // 东八区：8 小时 = 32 刻 → 十位 3、个位 2 → 0x23
        assert_eq!(timezone_offset_minutes(0x23), 480);
    }

    #[test]
    fn scts_timezone_is_applied() {
        // 同一时刻、不同时区字节应得到不同的绝对时间戳；忽略时区会把
        // 短信中心的墙上时钟直接当成本机时间。
        let same = |tz: u8| -> i64 {
            let mut ts = [0u8; 7];
            // 2025-08-25 12:00:00（半字节交换 BCD）
            ts[0] = 0x52; ts[1] = 0x80; ts[2] = 0x52; ts[3] = 0x21; ts[4] = 0x00; ts[5] = 0x00;
            ts[6] = tz;
            decode_timestamp(&ts).timestamp()
        };
        // UTC(+0) 比东八区晚 8 小时
        assert_eq!(same(0x23) + 8 * 3600, same(0x00));
    }

    /* ---------- 发送侧编码 ---------- */

    #[test]
    fn encode_address_counts_digits_for_destination() {
        // TP-DA 的长度字节记**号码位数**：8613800138000 共 13 位。
        let da = encode_address("8613800138000", false, true).unwrap();
        assert_eq!(da[0], 13, "TP-DA 长度应是号码位数而不是字节数");
        assert_eq!(da[1], 0x81, "不带 + 时按国内号码编码");
        // 13 位 → 补 F 后 7 字节，半字节交换：86→68, 13→31, 80→08, 01→10, 38→83, 00→00, 0F→F0
        assert_eq!(hex_upper(&da[2..]), "683108108300F0");
    }

    #[test]
    fn normalize_destination_matches_modem_side_rules() {
        // 实机 normalize() 的四档判定，逐条对齐。
        assert_eq!(normalize_destination("13800138000").unwrap(), "+8613800138000", "裸的大陆手机号要补国家码");
        assert_eq!(normalize_destination("10000").unwrap(), "10000", "特服短号按国内格式，不补任何前缀");
        assert_eq!(normalize_destination("+8613800138000").unwrap(), "+8613800138000");
        assert_eq!(normalize_destination("8613800138000").unwrap(), "+8613800138000", "写了 86 没写 + 也算国际");
        assert_eq!(normalize_destination("008613800138000").unwrap(), "+8613800138000", "00 前缀剥掉后按国际");
        assert_eq!(normalize_destination("8613800").unwrap(), "8613800", "不足 12 位的 86 开头不猜国际");
        assert_eq!(normalize_destination("0755-1234 5678").unwrap(), "075512345678", "分隔符只是噪声");
        assert_eq!(normalize_destination(" +86 (138) 0013-8000 ").unwrap(), "+8613800138000");
    }

    #[test]
    fn normalize_destination_rejects_unencodable_input() {
        // 归一之后仍只剩数字与一个前导 +，控制字符与逗号永远进不了串口。
        for bad in ["", "   ", "12", "123\rAT+CMGS=1", "123,45", "abc", "+", "13800138000+", "138001380001234567890"] {
            assert!(normalize_destination(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn destination_is_encoded_international_after_normalize() {
        // 归一的落点在 PDU 上：TP-DA 长度是位数，TOA 随之从 0x81 变 0x91。
        let da = encode_address(&normalize_destination("13800138000").unwrap(), false, true).unwrap();
        assert_eq!(da[0], 13);
        assert_eq!(da[1], 0x91);
        assert_eq!(hex_upper(&da[2..]), "683108108300F0");
        let short = encode_address(&normalize_destination("10000").unwrap(), false, true).unwrap();
        assert_eq!(short[1], 0x81, "短号仍走国内格式");
    }

    #[test]
    fn encode_address_counts_octets_for_smsc() {
        // SMSC 的长度字节记 TOA + 号码字节数。
        let sca = encode_address("+8613800755500", true, true).unwrap();
        let digits = "8613800755500".len();
        let body_len = (digits + 1) / 2 + 1; // 号码字节（补 F）+ TOA
        assert_eq!(sca[0] as usize, body_len);
        assert_eq!(sca[1], 0x91, "带 + 时按国际号码编码");
    }

    #[test]
    fn ascii_message_uses_gsm7_single_part() {
        let plan = build_submit_parts(&SubmitOptions {
            destination: "+8613800138000".into(),
            message: "hello".into(),
            smsc: None,
            validity: None,
            reference: Some(7),
        })
        .unwrap();
        assert_eq!(plan.encoding, SmEncoding::Gsm7);
        assert_eq!(plan.parts.len(), 1);
        assert_eq!(plan.parts[0].parts_count, 1);
        // SMSC 长度写 0（用卡里配的中心号），其后紧跟 TPDU
        assert!(plan.parts[0].pdu.starts_with("00"));
        assert_eq!(plan.parts[0].tpdu_length * 2 + 2, plan.parts[0].pdu.len());
    }

    #[test]
    fn default_validity_is_relative_24h() {
        // 相对有效期编码（TS 23.040 §9.2.3.12）：n=168～196 表示「1 天 + (n−168) 小时」，
        // 相对有效期编码（TS 23.040 §9.2.3.12）：n=144～167 表示「12 小时 + (n−143)×30 分钟」，
        // 24 小时对应 0xA7（167）。n=168（0xA8）已经跳到「(n−166)×1 天」= 2 天，
        // 早期注释把 0xA8 当 24 小时用，是读表读歪了。
        let plan = build_submit_parts(&SubmitOptions {
            destination: "+8613800138000".into(),
            message: "vp".into(),
            smsc: None,
            validity: None,
            reference: Some(1),
        })
        .unwrap();
        let raw = hex::decode(&plan.parts[0].pdu).unwrap();
        let mut pos = 1 + raw[0] as usize; // 跳过 SMSC 字段
        let first = raw[pos];
        pos += 2; // first octet + TP-MR
        let da_len = raw[pos] as usize;
        pos += 1 + (da_len + 1) / 2 + 1; // DA 长度 + 号码 BCD 字节 + TOA
        pos += 2; // TP-PID + TP-DCS → TP-VP
        assert_eq!(first & 0x18, 0x10, "TP-VPF 应为相对格式（bit4:bit3 = 10）");
        assert_eq!(raw[pos], 0xA7, "默认 TP-VP 应为 0xA7 = 24 小时");
    }

    #[test]
    fn chinese_message_uses_ucs2_and_round_trips() {
        let text = "你好，这是一条测试短信";
        let plan = build_submit_parts(&SubmitOptions {
            destination: "+8613800138000".into(),
            message: text.into(),
            smsc: None,
            validity: None,
            reference: Some(3),
        })
        .unwrap();
        assert_eq!(plan.encoding, SmEncoding::Ucs2);
        for part in &plan.parts {
            assert!(part.tpdu_length * 2 + 2 <= part.pdu.len() + 4);
            // SMSC 字段 1 字节后即 TPDU
            let tpdu_hex = &part.pdu[2..];
            assert_eq!(tpdu_hex.len() / 2, part.tpdu_length, "tpdu_length 必须等于去掉 SMSC 后的字节数");
        }
        // 把每一片当作 DELIVER 反向解回去，确认 UCS2 正文无损。
        let mut decoded = String::new();
        for part in &plan.parts {
            decoded.push_str(&decode_submit_body(&part.pdu, plan.encoding));
        }
        assert_eq!(decoded, text);
    }

    #[test]
    fn emoji_and_long_message_split_on_char_boundary() {
        // 构造足够长、且夹杂 emoji（代理对）的文本，必须按字符边界切分。
        let mut message = String::from("出发！");
        for _ in 0..40 {
            message.push_str("这是一句比较长的测试内容😀");
        }
        let plan = build_submit_parts(&SubmitOptions {
            destination: "+8613800138000".into(),
            message: message.clone(),
            smsc: None,
            validity: None,
            reference: Some(9),
        })
        .unwrap();
        assert_eq!(plan.encoding, SmEncoding::Ucs2);
        assert!(plan.parts.len() > 1, "长文本应自动分片");
        // 每片按 init-char 边界切：反向解回来不应出现 U+FFFD
        let mut merged = String::new();
        for (i, part) in plan.parts.iter().enumerate() {
            assert_eq!(part.part_number, (i + 1) as u8);
            assert_eq!(part.parts_count, plan.parts.len() as u8);
            merged.push_str(&decode_submit_body(&part.pdu, plan.encoding));
        }
        assert_eq!(merged, message, "分片后重组必须逐字符一致（含 emoji）");
        assert!(!merged.contains('\u{FFFD}'), "代理对被劈开会产出 U+FFFD");
    }

    #[test]
    fn long_gsm7_message_adds_concat_udh_and_aligns() {
        let text = "a".repeat(200);
        let plan = build_submit_parts(&SubmitOptions {
            destination: "13800138000".into(),
            message: text.clone(),
            smsc: Some("+8613800755500".into()),
            validity: None,
            reference: Some(0x2A),
        })
        .unwrap();
        assert_eq!(plan.encoding, SmEncoding::Gsm7);
        assert_eq!(plan.parts.len(), 2, "200 个 septet 应拆成 2 条 153-septet 分片");
        let mut merged = String::new();
        for part in &plan.parts {
            merged.push_str(&decode_submit_body(&part.pdu, SmEncoding::Gsm7));
        }
        assert_eq!(merged, text, "7bit 长短信不得因 UDH 填充位错位而乱码");
    }

    #[test]
    fn empty_destination_or_message_is_rejected() {
        assert!(build_submit_parts(&SubmitOptions {
            destination: "".into(),
            message: "hi".into(),
            ..Default::default()
        })
        .is_err());
        assert!(build_submit_parts(&SubmitOptions {
            destination: "13800138000".into(),
            message: "".into(),
            ..Default::default()
        })
        .is_err());
        assert!(build_submit_parts(&SubmitOptions {
            destination: "13800138000".into(),
            message: "hi".into(),
            smsc: Some("not-a-number".into()),
            ..Default::default()
        })
        .is_err());
    }

    #[test]
    fn cmgl_parses_manual_shape_and_ignores_cmgr() {
        // 手册 9.8.5 的实例形状：`+CMGL: 1,0,,25` + 下一行 PDU；<length> 是十进制字节数。
        let lines = vec![
            "AT+CMGL=4".to_string(),
            String::new(),
            "+CMGL: 1,1,,25".to_string(),
            "00040B913108108300F0000852805221000023046D4B8BD5".to_string(),
            "OK".to_string(),
        ];
        let got = parse_cmgl_response(&lines);
        assert_eq!(got.len(), 1, "回显行与空行都不该被当成记录");
        assert_eq!(got[0].index, Some(1));
        assert_eq!(got[0].stat, 1, "9.8.3：<stat>=1 是「收到的已读短信」");
        assert_eq!(got[0].content, "测试");
        assert!(got[0].error.is_none());

        // 9.10.1 的 `+CMGR: <stat>,[<reserved>],<length>` 没有 <index> 字段，
        // 绝不能被这个函数当成 CMGL 记录（那样会把状态读成序号）。
        let cmgr = vec![
            "+CMGR: 1,,25".to_string(),
            "00040B913108108300F0000852805221000023046D4B8BD5".to_string(),
            "OK".to_string(),
        ];
        assert!(parse_cmgl_response(&cmgr).is_empty(), "+CMGR 头行不属于 CMGL 解析器的输入");
    }

    #[test]
    fn cmgl_keeps_unparsable_entry_with_error() {
        // 解析失败的一条要带着原因留下，而不是静默丢掉。头行的序号照样读得出来
        // 就照实报（槽位 0 也是真槽位），只有读不出来时才是 None。
        let lines = vec![
            "+CMGL: 2,0,,30".to_string(),
            "not-hex-at-all".to_string(),
            "OK".to_string(),
        ];
        let got = parse_cmgl_response(&lines);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].index, Some(2));
        assert!(got[0].error.is_some(), "{:?}", got[0].error);

        // 槽位 0：实机的短信就从 0 号位开始排。
        let zero = vec![
            "+CMGL: 0,0,,25".to_string(),
            "00040B913108108300F0000852805221000023046D4B8BD5".to_string(),
            "OK".to_string(),
        ];
        assert_eq!(parse_cmgl_response(&zero)[0].index, Some(0), "0 号槽位不是「读不出序号」");

        let noindex = vec![
            "+CMGL: ,0,,25".to_string(),
            "00040B913108108300F0000852805221000023046D4B8BD5".to_string(),
            "OK".to_string(),
        ];
        assert_eq!(parse_cmgl_response(&noindex)[0].index, None, "序号读不出时留 None");
    }

    /// 把我们自己编出来的 SMS-SUBMIT 反向解出正文，验证「编得对不对」。
    ///
    /// SUBMIT 的字段顺序与 DELIVER 不同：跳过 SMSC 字段后是 first octet、TP-MR、TP-DA、
    /// TP-PID、TP-DCS、TP-VP，才到 TP-UDL。所以这里单独走一遍，不复用收信侧的 decode。
    fn decode_submit_body(pdu: &str, encoding: SmEncoding) -> String {
        let raw = hex::decode(pdu).unwrap();
        let mut pos = 1 + raw[0] as usize; // SMSC 字段
        let first = raw[pos];
        pos += 1;
        pos += 1; // TP-MR
        let _da_len = raw[pos] as usize;
        pos += 1;
        pos += (_da_len + 1) / 2 + 1; // 号码 BCD 字节 + TOA
        pos += 1; // TP-PID
        pos += 1; // TP-DCS
        pos += 1; // TP-VP
        let udl = raw[pos] as usize;
        pos += 1;
        let ud = &raw[pos..];

        if first & 0x40 == 0 {
            match encoding {
                SmEncoding::Gsm7 => septets_to_string(&unpack_septets(ud, udl)),
                _ => decode_ucs2(&ud[..ud.len().min(udl)]),
            }
        } else {
            let udh_len = ud[0] as usize + 1;
            let body = &ud[udh_len..];
            match encoding {
                SmEncoding::Gsm7 => {
                    let udh_septets = (udh_len * 8 + 6) / 7;
                    let septets = unpack_septets(ud, udl);
                    septets_to_string(&septets[udh_septets..])
                }
                _ => decode_ucs2(&body[..body.len().min(udl - udh_len)]),
            }
        }
    }
}
