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
    // ★ 循环结束时 bits 必定落在 1..=6 —— 那是末尾字节里的填充位，不是一个真实
    // 码位。原先在此补一个 (acc & 0x7F)，会凭空造出一个由填充位拼出来的字符，
    // 表现为短信正文尾部莫名多一个 '@' 之类，并且会原样进入企业微信推送。
    // 数据不足时宁可截断，也不要造字。
    out
}

/// GSM 03.38 默认字母表，按码位索引（**恰好 128 个**）。
///
/// ★ 缓存成 `OnceLock`：`septets_to_string` 是**每条短信**解码的必经路径，而
///   `GSM7_ALPHABET.chars().collect()` 每次调用都会新分配一个 128 元素的 `Vec`。
///   表本身是编译期常量，收集一次就够（原先每次解码都收集一遍）。
fn gsm7_alphabet() -> &'static [char] {
    static TABLE: std::sync::OnceLock<Vec<char>> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| GSM7_ALPHABET.chars().collect())
}

fn septets_to_string(septets: &[u8]) -> String {
    let mut sb = String::new();
    let alphabet = gsm7_alphabet();
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
    /*
     * ★ TON = 001（国际号码）要加前导 '+' —— 与前端 parse.js 的 decodeAddress 对齐
     *   （那边写的是 `if (ton === 1) return '+' + digits;`）。
     *
     *   缺这一步会让**两端显示不一致**：同一条来自 +8613800138000 的短信，
     *   页面里的短信列表显示「+8613800138000」，而通知 / 企业微信推送里
     *   （走的是本函数）显示「8613800138000」。
     *   3GPP 23.040 里 TON=1 本就表示国际格式，带 '+' 才是标准写法。
     */
    let number = decode_number(data, digits);
    if (toa >> 4) & 0x07 == 0x01 {
        return format!("+{number}");
    }
    number
}

/// 从 DCS 推出用户数据的编码：0 = GSM7、1 = 8bit、2 = UCS2。
///
/// ★ 与前端 `parse.js` 的 `dcsEncoding` 对齐（2026-09-28）。
///
///   原先这里直接写 `(dcs >> 2) & 0x03` —— 那只在 **0x0–0xB 组**成立：
///   · `0xC / 0xD / 0xE` 组（GSM7 / 8bit / UCS2 的扩展组）要看 **bit3**
///     决定是 8bit 还是 UCS2；
///   · `0xF` 组（**数据编码 / 消息类别组**）的 bit3-2 是**消息类别，不是编码**，
///     必须固定按 GSM7 处理。
///
///   前端早就按这个口径修好了，并在注释里记着「已按 256 个 DCS 全量自检：
///   差异只落在 0xF 组，常见 DCS 完全等价」；**后端当时漏改**，于是同一条 PDU
///   走前端解码与走后端解码会得到不同的正文。分歧点举例：`DCS = 0xF4`
///   → 旧算式 `(0xF4 >> 2) & 0x03 == 1`（当成 8bit），正确结果是 0（GSM7）。
fn dcs_encoding(dcs: u8) -> u8 {
    let group = dcs >> 4;
    if group == 0xC || group == 0xD || group == 0xE {
        return if dcs & 0x08 != 0 { 2 } else { 0 };
    }
    if group == 0xF {
        return 0;
    }
    (dcs >> 2) & 0x03
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
    let sender_bytes = cut(&raw, &mut pos, sender_digits.div_ceil(2))?;
    let sender = decode_address(sender_bytes, sender_digits, sender_toa);

    cut(&raw, &mut pos, 1)?; // 协议标识符 PID
    let dcs = cut(&raw, &mut pos, 1)?[0];
    let ts_bytes = cut(&raw, &mut pos, 7)?;
    let udl = cut(&raw, &mut pos, 1)?[0] as usize;

    // DCS → 编码。见 dcs_encoding 的说明：不能只写 (dcs >> 2) & 0x03。
    let encoding = dcs_encoding(dcs);

    // ★ 2026-09-30：按 udl **交叉校验并裁剪**用户数据。
    //
    //   为什么必须做：udl 是 PDU **自己声明的**长度，而 ud 是**实到字节**，此前两者不交叉校验：
    //     · 数据不足（`AT+CMGL=4` 被 2 秒应答预算截断、串口半包）时，GSM7 会静默少解几个码位、
    //       UCS2/8 位会丢掉尾部字节，最后仍然返回 `Ok` —— 调用方拿到一条"看起来正常"的短信，
    //       尾部被悄悄吃掉，且会原样进通知与企业微信推送；
    //     · 数据多于声明长度时，多余字节会被当成正文追加到末尾（垃圾字符进正文）。
    //
    //   口径：**不足即 Err**（显式失败，与本仓"不许静默"的约定一致，也与 gsm7 解码里
    //   "宁可截断也不要造字"那条注释同一取向：能判断出错误就必须报出来）；
    //   **多余则按声明长度裁剪** —— 3GPP 23.040 里 udl 才是 UD 的权威长度。
    //
    //   单位随编码不同，且**不能想当然**：
    //     · GSM7（默认）：udl 计**码位**，字节数向上取整 = (udl*7+7)/8；
    //     · UCS2 / 8 位：udl 计**八位组**（不是字符）—— 仓库自己的真机样本
    //       `test_decode_concatenated_pdu` 就是 udl=8 对应「UDH 6 字节 + “测” 2 字节」。
    //       若按 udl*2 校验，会把所有合法 UCS2 短信判成"数据不足"。
    let ud = &raw[pos..];
    let ud_need = match encoding {
        0x02 | 0x01 => udl,
        _ => (udl * 7).div_ceil(8),
    };
    if ud.len() < ud_need {
        return Err(format!(
            "用户数据不足：声明 {ud_need} 字节（udl={udl}），实到 {}",
            ud.len()
        ));
    }
    let ud = &ud[..ud_need];

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
        0x01 => {
            /*
             * 8bit 载荷默认按 Latin-1 逐字节映射（1 字节 = 1 字符，不丢信息）。
             * 但 **WAP Push / 彩信通知**走的也是 8bit，载荷是二进制报头 ——
             * 真机实测（2026-09-30，设备收件箱 IDX 23/24，发件人 12520115，两条是同一通知的 1/2 段）：
             *   UDH 目的端口 `0x0B84` = **2948**（WAP Push），载荷里是 ASCII 可见的
             *   `application/vnd.wap.mms-message`、`http://[2409:…]:80/E6UJeHm6eG`、`12520088`、`/TYPE=PLMN`。
             * 按文本显示就是一串 `Ã¤Â¸Â` 之类的乱码（用户报的"短信乱码"就是这个）。
             * 这里**不猜字符集**（GBK/UTF-16 都要引入编码表依赖，而本模组的 8bit 文本短信极罕见），
             * 而是按端口把它明确标注出来：用户看到"这是彩信通知"，而不是乱码。
             */
            let wap_port = if udh_len > 0 { udh_app_port(&ud[1..udh_len]) } else { None };
            match wap_port {
                Some(p) if WAP_PUSH_PORTS.contains(&p) => MMS_NOTICE_TEXT.to_string(),
                _ => ud[udh_len..].iter().map(|&b| b as char).collect(),
            }
        }
        _ => {
            // 7 位编码里 UDH 也按码位计数，且正文需要对齐到 7 位边界。
            let udh_septets = (udh_len * 8).div_ceil(7);
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

/// WAP Push 的目的端口：2948 = 无连接 WAP Push（彩信通知走这个），2949 = 同上（安全）。
///
/// 真机依据（2026-09-30，设备 192.168.10.1 收件箱 33 条中的 IDX 23/24，发件人 12520115）：
///   UDH = `05 04 0b 84 23 f0 …` → IEI 0x05（16 位端口寻址），**目的端口 0x0B84 = 2948**，
///   源端口 0x23F0 = 9200；载荷是 MMS 通知报头（ASCII 可见 `application/vnd.wap.mms-message`
///   与 `/TYPE=PLMN`）。这类报文不是文本，按 8bit→Latin-1 显示即为乱码。
const WAP_PUSH_PORTS: [u16; 2] = [2948, 2949];

/// 彩信通知在本控制台里的显示文案。**前端 parse.js 必须与此逐字一致**
/// （`tests/fixtures/pdu-samples.json` 的共享样本会在两侧同时校验）。
const MMS_NOTICE_TEXT: &str = "[彩信通知] 本机不支持彩信，请用手机查看该条内容";

/// 从 UDH 里取"16 位端口寻址"（IEI 0x05）的**目的端口**；没有该 IE 时返回 None。
fn udh_app_port(udh: &[u8]) -> Option<u16> {
    let mut i = 0;
    while i + 1 < udh.len() {
        let iei = udh[i];
        let ie_len = udh[i + 1] as usize;
        let body = i + 2;
        if body + ie_len > udh.len() {
            break; // 长度越界：按"没有该 IE"处理，交给上层现有的 UDH 校验
        }
        if iei == 0x05 && ie_len >= 2 {
            return Some(u16::from_be_bytes([udh[body], udh[body + 1]]));
        }
        i = body + ie_len;
    }
    None
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

    /// GSM 03.38 默认字母表的**长度与关键锚点** —— 这张表按码位直接索引，
    /// 多一个或少一个字符都会让**整表错位**（收到的每个字母都是错的，而且不会报错）。
    /// 它是手抄的常量，所以必须有断言钉住，不能靠目测。
    #[test]
    fn gsm7_alphabet_is_exactly_128_chars() {
        let v: Vec<char> = GSM7_ALPHABET.chars().collect();
        assert_eq!(v.len(), 128, "GSM 03.38 默认字母表必须恰好 128 个码位（0x00-0x7F）");
        // 关键锚点（GSM 03.38 表）：起点、控制位、以及 0x20 起的可打印区
        assert_eq!(v[0x00], '@');
        assert_eq!(v[0x0A], '\n');
        assert_eq!(v[0x0D], '\r');
        assert_eq!(v[0x1B], '\u{1b}', "0x1B 是转义前导（扩展表用）");
        assert_eq!(v[0x20], ' ');
        assert_eq!(v[0x24], '\u{00A4}', "0x24 是 ¤ 而不是 $");
        assert_eq!(v[0x30], '0');
        assert_eq!(v[0x3F], '?');
        assert_eq!(v[0x40], '¡');
        assert_eq!(v[0x41], 'A');
        assert_eq!(v[0x5A], 'Z');
        assert_eq!(v[0x61], 'a');
        assert_eq!(v[0x7A], 'z');
        assert_eq!(v[0x7F], 'à');
        // 缓存版本与直接收集必须一致
        assert_eq!(gsm7_alphabet(), &v[..]);
    }

    /// DCS → 编码的口径必须与前端 `parse.js` 的 `dcsEncoding` **逐值一致**。
    ///
    /// 这条契约此前只有前端一侧在守（前端注释里写着"已按 256 个 DCS 全量自检"），
    /// 后端漏改了 `0xC/0xD/0xE` 与 `0xF` 两组，于是同一条 PDU 两侧可能解出不同正文。
    #[test]
    fn dcs_encoding_与前端口径一致() {
        // 常见 DCS
        assert_eq!(dcs_encoding(0x00), 0, "GSM7（默认）");
        assert_eq!(dcs_encoding(0x04), 1, "8bit");
        assert_eq!(dcs_encoding(0x08), 2, "UCS2");

        // 0xC / 0xD / 0xE 组：看 bit3 决定 8bit 还是 UCS2（不是看 bit3-2）
        for &d in &[0xC0u8, 0xD0, 0xE0] {
            assert_eq!(dcs_encoding(d), 0, "{d:#04X}：bit3=0 → GSM7");
            assert_eq!(dcs_encoding(d | 0x08), 2, "{d:#04X}：bit3=1 → UCS2");
        }

        // ★ 0xF 组：bit3-2 是消息类别，不是编码 → 一律 GSM7
        for d in 0xF0u8..=0xFF {
            assert_eq!(dcs_encoding(d), 0, "{d:#04X} 属 0xF 组，必须按 GSM7 处理");
        }

        // 把分歧点钉死：旧算式在这里给 1（8bit），正是漏改的后果
        assert_eq!((0xF4u8 >> 2) & 0x03, 1, "旧式算式在 0xF4 上是 1 —— 所以必须走 dcs_encoding");
    }

    /// 跨端一致性：与前端 `tests/pdu-cross-end-contract.test.js` **读同一份 fixture**
    /// （`tests/fixtures/pdu-samples.json`），断言同一结果。
    ///
    /// 这条契约补的是本仓的一个结构性缺口：`parse.js` 与 `pdu.rs` 各有一份 PDU 解码，
    /// 而**各自的测试只守自己那一侧**（`sms-pdu.test.js` 拿后端样本当输入验证前端），
    /// 所以"两端各自改对、口径却分叉"不会被任何测试发现 —— 2026-09-28 的人工核对就查出
    /// 四处（填充位造字、DCS 分组、地址 BCD/TON=1、时间戳日期进位），方向各不相同。
    /// 新增样本请改 fixture，两侧自动生效。
    #[test]
    fn pdu_共享样本两端一致() {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/pdu-samples.json");
        let raw = std::fs::read_to_string(p).unwrap_or_else(|e| panic!("读不到共享样本 {p}: {e}"));
        let v: serde_json::Value =
            serde_json::from_str(&raw).unwrap_or_else(|e| panic!("共享样本不是合法 JSON: {e}"));
        let samples = v["samples"].as_array().expect("samples 必须是数组");
        assert!(!samples.is_empty(), "共享样本不能为空（否则这条契约形同虚设）");

        for s in samples {
            let name = s["name"].as_str().unwrap_or("(无名)");
            let hex = s["hex"].as_str().unwrap_or_else(|| panic!("{name}: 样本缺 hex"));
            let sms = decode_incoming_pdu(hex).unwrap_or_else(|e| panic!("{name}: 解码失败 {e}"));

            assert_eq!(sms.sender, s["sender"].as_str().unwrap_or(""), "{name}: 发送方不一致");
            if let Some(c) = s["content"].as_str() {
                assert_eq!(sms.content, c, "{name}: 正文不一致");
            }
            if let Some(pfx) = s["contentPrefix"].as_str() {
                assert!(
                    sms.content.starts_with(pfx),
                    "{name}: 正文不以 {pfx:?} 开头，实际 {:?}",
                    sms.content.chars().take(24).collect::<String>()
                );
            }
            if let Some(exp) = s["partial"].as_object() {
                let got = sms.partial.as_ref().unwrap_or_else(|| panic!("{name}: 应解析出分段信息"));
                assert_eq!(got.reference, exp["reference"].as_u64().unwrap_or(0) as u32, "{name}: reference");
                assert_eq!(got.parts_count, exp["parts_count"].as_u64().unwrap_or(0) as u32, "{name}: parts_count");
                assert_eq!(got.part_number, exp["part_number"].as_u64().unwrap_or(0) as u32, "{name}: part_number");
            }
        }
    }

    #[test]
    fn test_decode_ucs2_pdu() {
        let sms = decode_incoming_pdu(UCS2_PDU).unwrap();
        /*
         * ★ 2026-09-28：样本的 TOA=0x91 ⇒ (0x91>>4)&7 == 1 ⇒ TON=1（国际号码），
         *   按 3GPP 23.040 与前端 parse.js 的 decodeAddress 口径应带前导 '+'。
         *   这里原先断言的是不带 '+' 的形态 —— 那是在守后端漏掉这一步时的行为，
         *   而它同时意味着「同一条短信在页面列表与通知里的号码写法不一致」。
         */
        assert_eq!(sms.sender, "+13800138000");
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

    /*
     * ★ 2026-09-30 新增两条边界契约：udl（PDU 声明的长度）与实到字节的交叉校验。
     *
     * 触发路径是真实存在的那条：`AT+CMGL=4` 的应答超过 2 秒应答预算被截断 → 半截 PDU
     * 进到解码器。旧行为下 UCS2 会少几个字符、GSM7 会少几个码位，**仍然返回 Ok**，
     * 调用方无法区分"短信就这么长"与"数据被截断了"。
     */
    #[test]
    fn pdu_用户数据不足必须报错而不是静默截断() {
        // 砍掉 UCS2 样本最后 2 个字节，而它声明的 udl 没变 → 属于"数据不足"
        let truncated = &UCS2_PDU[..UCS2_PDU.len() - 4];
        let err = decode_incoming_pdu(truncated).expect_err("数据不足必须报错，不能静默截断");
        assert!(err.contains("用户数据不足"), "错误信息要说明原因，实际：{err}");
    }

    #[test]
    fn pdu_多余字节按声明长度裁剪() {
        // 在合法 PDU 后追加 2 字节垃圾（"4142"）：udl 没变，所以它们不属于正文，
        // 必须被裁掉 —— 旧行为会把它们解成正文尾部的乱码并一路推到通知里。
        let with_junk = format!("{UCS2_PDU}4142");
        let base = decode_incoming_pdu(UCS2_PDU).unwrap();
        let got = decode_incoming_pdu(&with_junk).unwrap();
        assert_eq!(got.content, base.content, "多余字节不得进入正文");
    }

    /*
     * ★ 2026-09-30 新增：WAP Push / 彩信通知的识别。
     * 用户报"12520115 的短信乱码"，真机取证实为彩信通知（8bit + UDH 目的端口 2948），
     * 按 Latin-1 显示成二进制报头即乱码。下面两条用**真机原样 PDU** 钉住行为。
     */
    #[test]
    fn wap_push_目的端口解析() {
        // 真机 UDH 片段：IEI 0x05 + len 4 + 目的端口 0x0B84(2948) + 源端口 0x23F0(9200)
        assert_eq!(udh_app_port(&[0x05, 0x04, 0x0b, 0x84, 0x23, 0xf0]), Some(2948));
        // 端口 IE 在长短信分段头**之后**时也要能找到（真机 IDX 23 就是这个顺序）
        assert_eq!(
            udh_app_port(&[0x00, 0x03, 0xbd, 0x02, 0x01, 0x05, 0x04, 0x0b, 0x84, 0x23, 0xf0]),
            Some(2948)
        );
        // 只有长短信分段头时不得误判成端口
        assert_eq!(udh_app_port(&[0x00, 0x03, 0xbd, 0x02, 0x01]), None);
        // 长度越界时按"没有该 IE"处理，不 panic
        assert_eq!(udh_app_port(&[0x05, 0x04, 0x0b]), None);
    }

    #[test]
    fn 彩信通知按明文标注而不是乱码() {
        // 真机原样 PDU（设备收件箱 IDX 24，发件人 12520115，同一通知的第 2/2 段）
        let pdu = "0891683108901705F16408A121251051000462900371808223170B05040B8423F00003BD0202\
                   2F545950453D504C4D4E00";
        let sms = decode_incoming_pdu(pdu).unwrap();
        assert_eq!(sms.sender, "12520115");
        assert_eq!(sms.content, MMS_NOTICE_TEXT, "彩信通知必须被标注，不能显示二进制报头");
        let part = sms.partial.expect("两条都是长短信分段（UDH ref=0xBD，共 2 段）");
        assert_eq!((part.reference, part.parts_count, part.part_number), (0xBD, 2, 2));
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
