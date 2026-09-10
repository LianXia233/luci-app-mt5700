//! SMS PDU 解码（SMS-DELIVER），GSM7/UCS2/8bit + UDH 长短信。
//! 逻辑与 Go 实现（pdu.go）逐项一致。

use chrono::{DateTime, Local, TimeZone};

/// GSM 03.38 默认字母表（按码位索引）。
const GSM7_ALPHABET: &str = concat!(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?",
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
);

/// 0x1B 转义后的扩展表。
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
    pub date: DateTime<Local>,
    pub partial: Option<PartialInfo>,
}

/// 把 8 位字节流还原成 7 位码位序列。
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

/// 还原一个半字节交换的 BCD 字节，返回两位数字。
fn bcd_digit(b: u8) -> i32 {
    (b & 0x0F) as i32 * 10 + (b >> 4) as i32
}

fn decode_timestamp(ts: &[u8]) -> DateTime<Local> {
    if ts.len() < 7 {
        return Local::now();
    }
    let year = 2000 + bcd_digit(ts[0]);
    let month = bcd_digit(ts[1]);
    let day = bcd_digit(ts[2]);
    let hour = bcd_digit(ts[3]);
    let minute = bcd_digit(ts[4]);
    let second = bcd_digit(ts[5]);

    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return Local::now();
    }
    // 时区字节存在但沿用本地时区解释，与旧实现保持一致。
    match Local.with_ymd_and_hms(year, month as u32, day as u32, hour as u32, minute as u32, second as u32) {
        chrono::LocalResult::Single(dt) => dt,
        _ => Local::now(),
    }
}

/// 解码 BCD 电话号码，digits 为号码位数。
fn decode_number(data: &[u8], digits: usize) -> String {
    let mut sb = String::new();
    for &b in data {
        let lo = b & 0x0F;
        let hi = b >> 4;
        if lo <= 9 {
            sb.push((b'0' + lo) as char);
        }
        if sb.len() < digits && hi <= 9 {
            sb.push((b'0' + hi) as char);
        }
    }
    sb
}

/// 解码地址字段，区分数字号码与字母数字发送方（如 "CMCC"）。
fn decode_address(data: &[u8], digits: usize, toa: u8) -> String {
    // TON = 101 表示 alphanumeric，内容是打包的 7 位字符而不是 BCD 数字。
    if (toa >> 4) & 0x07 == 0x05 {
        let septets = (digits * 4) / 7;
        return septets_to_string(&unpack_septets(data, septets));
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

    let sender_digits = cut(&raw, &mut pos, 1)?[0] as usize;
    let sender_toa = cut(&raw, &mut pos, 1)?[0];
    let sender_bytes = cut(&raw, &mut pos, (sender_digits + 1) / 2)?;
    let sender = decode_address(sender_bytes, sender_digits, sender_toa);

    cut(&raw, &mut pos, 1)?; // 协议标识符 PID
    let dcs = cut(&raw, &mut pos, 1)?[0];
    let ts_bytes = cut(&raw, &mut pos, 7)?;
    let udl = cut(&raw, &mut pos, 1)?[0] as usize;
    let ud = &raw[pos..];

    // DCS bit3-2 选编码：00=GSM7 01=8bit 10=UCS2
    let encoding = (dcs >> 2) & 0x03;

    let mut udh_len = 0usize;
    let mut partial: Option<PartialInfo> = None;
    if pdu_type & 0x40 != 0 && !ud.is_empty() {
        udh_len = ud[0] as usize + 1;
        if udh_len > ud.len() {
            return Err("UDH 长度超出用户数据".into());
        }
        partial = parse_udh_concat(&ud[1..udh_len]);
    }

    let content = match encoding {
        0x02 => decode_ucs2(&ud[udh_len..]),
        0x01 => ud[udh_len..].iter().map(|&b| b as char).collect(),
        _ => {
            // 7 位编码里 UDH 也按码位计数，且正文需要对齐到 7 位边界。
            let udh_septets = (udh_len * 8 + 6) / 7;
            let mut total = udl;
            if total < udh_septets {
                total = udh_septets;
            }
            let septets = unpack_septets(ud, total);
            if udh_septets <= septets.len() {
                septets_to_string(&septets[udh_septets..])
            } else {
                String::new()
            }
        }
    };

    Ok(Sms {
        sender,
        content,
        date: decode_timestamp(ts_bytes),
        partial,
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    // 发送方 13800138000，时间戳 2025-08-25 12:00:00，UCS2 正文 "测试"（与 Go 测试同源）。
    const UCS2_PDU: &str = "00040B913108108300F0000852805221000023046D4B8BD5";

    // 同一个头，DCS=00，GSM 7-bit 正文 "hello"。
    const GSM7_PDU: &str = "00040B913108108300F000005280522100002305E8329BFD06";

    #[test]
    fn test_decode_ucs2_pdu() {
        let sms = decode_incoming_pdu(UCS2_PDU).unwrap();
        assert_eq!(sms.sender, "13800138000");
        assert_eq!(sms.content, "测试");
        let want = Local.with_ymd_and_hms(2025, 8, 25, 12, 0, 0).single().unwrap();
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
        // TOA=0xD0 字母数字发送方，5 个 7 位字符 "hello"。
        let pdu = "00040AD0E8329BFD06000852805221000023026D4B";
        let sms = decode_incoming_pdu(pdu).unwrap();
        assert_eq!(sms.sender, "hello");
    }

    #[test]
    fn test_gsm7_extension() {
        // 0x1B 0x65 是扩展表里的欧元符号。
        assert_eq!(septets_to_string(&[0x1B, 0x65, b'a']), "€a");
    }
}
