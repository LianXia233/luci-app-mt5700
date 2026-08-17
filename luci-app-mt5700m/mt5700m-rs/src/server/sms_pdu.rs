// Minimal GSM PDU SMS decoder.
//
// Used by the SMS notification path: when a `+CMTI` URC arrives the daemon
// issues `AT+CMGR=<idx>` and the module returns the message as a hex PDU.  We
// decode the sender number, the text (GSM 7-bit default alphabet or UCS2) and
// the timestamp, and surface concatenated-message info (8-bit or 16-bit
// reference) so the multi-part reassembly in `handlers.rs` can stitch long
// messages back together — mirroring `at-server.py`'s `read_incoming_sms`.

pub struct Concat {
    pub reference: u16,
    pub total: u8,
    pub seq: u8,
}

pub struct Sms {
    pub sender: String,
    pub content: String,
    pub timestamp: String,
    pub partial: Option<Concat>,
}

static GSM7: &[char] = &[
    '@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', 'ò', 'Ç', '\n', 'Ø', 'ø', '\r', 'Å', 'å',
    'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', 'Σ', 'Θ', 'Ξ', '\u{1b}', 'Æ', 'æ', 'ß', 'É',
    ' ', '!', '"', '#', '¤', '%', '&', '\'', '(', ')', '*', '+', ',', '-', '.', '/',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', ';', '<', '=', '>', '?',
    '¡', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
    'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'Ä', 'Ö', 'Ñ', 'Ü', '§',
    '¿', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
    'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'ä', 'ö', 'ñ', 'ü', 'à',
];

fn hex_decode(s: &str) -> Vec<u8> {
    let s = s.trim();
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i + 1 < bytes.len() + 1 && i + 1 <= s.len() {
        if i + 1 >= s.len() {
            break;
        }
        let hi = hex_val(bytes[i]);
        let lo = hex_val(bytes[i + 1]);
        if hi < 0 || lo < 0 {
            break;
        }
        out.push(((hi << 4) | lo) as u8);
        i += 2;
    }
    out
}

fn hex_val(c: u8) -> i16 {
    match c {
        b'0'..=b'9' => (c - b'0') as i16,
        b'a'..=b'f' => (c - b'a' + 10) as i16,
        b'A'..=b'F' => (c - b'A' + 10) as i16,
        _ => -1,
    }
}

fn bcd_char(d: u8) -> char {
    match d {
        0..=9 => (b'0' + d) as char,
        0x0a => '*',
        0x0b => '#',
        0x0c => '<',
        0x0d => '>',
        _ => '?',
    }
}

fn unpack_7bit(data: &[u8], num: usize) -> String {
    let mut out = String::new();
    let mut acc: u32 = 0;
    let mut nbits: u32 = 0;
    let mut produced = 0;
    for &byte in data {
        acc |= (byte as u32) << nbits;
        nbits += 8;
        while nbits >= 7 && produced < num {
            let septet = (acc & 0x7f) as u8;
            acc >>= 7;
            nbits -= 7;
            out.push(GSM7[septet as usize]);
            produced += 1;
        }
        if produced >= num {
            break;
        }
    }
    out
}

fn decode_ucs2(data: &[u8]) -> String {
    let mut units: Vec<u16> = Vec::with_capacity(data.len() / 2);
    let mut i = 0;
    while i + 1 < data.len() {
        units.push(u16::from_be_bytes([data[i], data[i + 1]]));
        i += 2;
    }
    // Strip a trailing NUL if present, then decode UTF-16.
    while units.last() == Some(&0) {
        units.pop();
    }
    String::from_utf16_lossy(&units)
}

fn parse_timestamp(b: &[u8]) -> String {
    if b.len() < 7 {
        return "未知".to_string();
    }
    let sw = |x: u8| -> u8 { (x & 0x0f) * 10 + (x >> 4) };
    let yy = sw(b[0]) as i32;
    let year = if yy < 70 { 2000 + yy } else { 1900 + yy };
    let mm = sw(b[1]);
    let dd = sw(b[2]);
    let hh = sw(b[3]);
    let mi = sw(b[4]);
    let ss = sw(b[5]);
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", year, mm, dd, hh, mi, ss)
}

fn empty() -> Sms {
    Sms {
        sender: "解析失败".to_string(),
        content: String::new(),
        timestamp: "未知".to_string(),
        partial: None,
    }
}

pub fn decode(pdu: &str) -> Sms {
    let b = hex_decode(pdu);
    if b.is_empty() {
        return empty();
    }
    let mut i = 0usize;
    let smsc_len = b[i] as usize;
    i += 1;
    if smsc_len > 0 {
        i += 1 + smsc_len;
    }
    if i >= b.len() {
        return empty();
    }
    let tp = b[i];
    i += 1;
    let udhi = (tp & 0x40) != 0;

    // Sender number.
    let sender_len = b[i] as usize;
    i += 1;
    if i >= b.len() {
        return empty();
    }
    let _ton = b[i];
    i += 1;
    let sender_bytes = (sender_len + 1) / 2;
    let mut sender = String::new();
    for k in 0..sender_len {
        let byte = b.get(i + k / 2).copied().unwrap_or(0);
        let digit = if k % 2 == 0 { byte & 0x0f } else { byte >> 4 };
        if digit == 0x0f {
            break;
        }
        sender.push(bcd_char(digit));
    }
    i += sender_bytes;

    if i + 2 > b.len() {
        return empty();
    }
    let _pid = b[i];
    i += 1;
    let dcs = b[i];
    i += 1;

    if i + 7 > b.len() {
        return empty();
    }
    let ts = parse_timestamp(&b[i..i + 7]);
    i += 7;

    if i >= b.len() {
        return empty();
    }
    let udl = b[i] as usize;
    i += 1;
    let is_ucs2 = (dcs & 0x0c) == 0x08;

    let mut partial: Option<Concat> = None;
    let mut skip_udh_bytes = 0usize;
    let mut udh_septets = 0usize;
    if udhi {
        if i >= b.len() {
            return empty();
        }
        let udhl = b[i] as usize;
        let mut p = i + 1;
        let udh_end = (p + udhl).min(b.len());
        while p + 1 < udh_end {
            let ie_id = b[p];
            p += 1;
            let ie_len = b[p] as usize;
            p += 1;
            if p + ie_len > b.len() {
                break;
            }
            let ds = p;
            p += ie_len;
            if ie_id == 0x00 && ie_len >= 3 {
                partial = Some(Concat {
                    reference: b[ds] as u16,
                    total: b[ds + 1],
                    seq: b[ds + 2],
                });
            } else if ie_id == 0x08 && ie_len >= 4 {
                let r = ((b[ds] as u16) << 8) | (b[ds + 1] as u16);
                partial = Some(Concat {
                    reference: r,
                    total: b[ds + 2],
                    seq: b[ds + 3],
                });
            }
        }
        skip_udh_bytes = udhl + 1;
        if !is_ucs2 {
            let bits = (udhl + 1) * 8;
            udh_septets = (bits + 6) / 7;
        }
    }

    let content = if is_ucs2 {
        let content_bytes = udl.saturating_sub(skip_udh_bytes);
        let end = (i + skip_udh_bytes + content_bytes).min(b.len());
        decode_ucs2(&b[i + skip_udh_bytes..end])
    } else {
        let total_bytes = (udl * 7 + 7) / 8;
        let end = (i + total_bytes).min(b.len());
        let all = unpack_7bit(&b[i..end], udl);
        all.chars().skip(udh_septets).collect()
    };

    Sms {
        sender,
        content,
        timestamp: ts,
        partial,
    }
}
