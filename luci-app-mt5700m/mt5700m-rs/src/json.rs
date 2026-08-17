// Zero-dependency JSON support.
//
// Two jobs:
//   1. Parse the compact JSON emitted by `ubus call ...` so we can read fields
//      the original shell code extracted with `jsonfilter -e '@.up'` etc.
//   2. Serialize the fixed-shape status / traffic documents that the LuCI
//      front-end and `mt5700m-traffic` currently emit, replacing the
//      `jshn.sh` / `json_dump` shell helpers with a deterministic writer.
//
// The serializer deliberately emits *compact* JSON (no spaces after `:`/`,`)
// because the original `json_dump` output is consumed by `jsonfilter` and by
// the LuCI RPC layer, both of which are whitespace-insensitive.

use crate::error::{MtError, Result};

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    // Objects keep insertion order so the output matches the original key order.
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn null() -> Json {
        Json::Null
    }
    pub fn bool_(v: bool) -> Json {
        Json::Bool(v)
    }
    pub fn num(v: f64) -> Json {
        Json::Num(v)
    }
    pub fn str_(v: impl Into<String>) -> Json {
        Json::Str(v.into())
    }
    pub fn arr(items: Vec<Json>) -> Json {
        Json::Arr(items)
    }
    pub fn obj(items: Vec<(&str, Json)>) -> Json {
        Json::Obj(items.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    /// Look up a dotted/json-pointer-ish path, e.g. `network.interface.foo.up`.
    pub fn get_path(&self, path: &str) -> Option<&Json> {
        let mut cur = self;
        for part in path.split('.') {
            match cur {
                Json::Obj(entries) => {
                    cur = entries.iter().find(|(k, _)| k == part).map(|(_, v)| v)?;
                }
                Json::Arr(items) => {
                    let idx: usize = part.parse().ok()?;
                    cur = items.get(idx)?;
                }
                _ => return None,
            }
        }
        Some(cur)
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            Json::Str(s) if s == "true" => Some(true),
            Json::Str(s) if s == "false" => Some(false),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Num(n) => Some(*n),
            Json::Str(s) => s.parse().ok(),
            _ => None,
        }
    }

    pub fn to_compact_string(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Num(n) => {
                if n.fract() == 0.0 && n.is_finite() && n.abs() < 1e15 {
                    out.push_str(&format!("{}", *n as i64));
                } else {
                    out.push_str(&format!("{}", n));
                }
            }
            Json::Str(s) => write_string(s, out),
            Json::Arr(items) => {
                out.push('[');
                for (i, it) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    it.write(out);
                }
                out.push(']');
            }
            Json::Obj(entries) => {
                out.push('{');
                for (i, (k, v)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_string(k, out);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

// ----------------------------- parser -----------------------------------

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(s: &'a str) -> Self {
        Parser {
            bytes: s.as_bytes(),
            pos: 0,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn bump(&mut self) -> Option<u8> {
        let b = self.bytes.get(self.pos).copied();
        if b.is_some() {
            self.pos += 1;
        }
        b
    }

    fn skip_ws(&mut self) {
        while let Some(b) = self.peek() {
            if b == b' ' || b == b'\t' || b == b'\n' || b == b'\r' {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn parse_value(&mut self) -> Result<Json> {
        self.skip_ws();
        match self.peek() {
            Some(b'{') => self.parse_object(),
            Some(b'[') => self.parse_array(),
            Some(b'"') => Ok(Json::Str(self.parse_string()?)),
            Some(b't') | Some(b'f') => self.parse_bool(),
            Some(b'n') => self.parse_null(),
            Some(b'-') | Some(b'0'..=b'9') => self.parse_number(),
            other => Err(MtError(format!("unexpected byte 0x{:02x} at {}", other.unwrap_or(0), self.pos))),
        }
    }

    fn parse_object(&mut self) -> Result<Json> {
        self.bump(); // {
        let mut entries = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.bump();
            return Ok(Json::Obj(entries));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err(MtError("expected object key".into()));
            }
            let key = self.parse_string()?;
            self.skip_ws();
            if self.bump() != Some(b':') {
                return Err(MtError("expected ':'".into()));
            }
            let val = self.parse_value()?;
            entries.push((key, val));
            self.skip_ws();
            match self.bump() {
                Some(b',') => continue,
                Some(b'}') => break,
                _ => return Err(MtError("expected ',' or '}'".into())),
            }
        }
        Ok(Json::Obj(entries))
    }

    fn parse_array(&mut self) -> Result<Json> {
        self.bump(); // [
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.bump();
            return Ok(Json::Arr(items));
        }
        loop {
            let val = self.parse_value()?;
            items.push(val);
            self.skip_ws();
            match self.bump() {
                Some(b',') => continue,
                Some(b']') => break,
                _ => return Err(MtError("expected ',' or ']'".into())),
            }
        }
        Ok(Json::Arr(items))
    }

    fn parse_string(&mut self) -> Result<String> {
        self.bump(); // opening "
        let mut s = String::new();
        while let Some(b) = self.bump() {
            match b {
                b'"' => return Ok(s),
                b'\\' => {
                    let esc = self.bump().ok_or_else(|| MtError("unterminated escape".into()))?;
                    match esc {
                        b'"' => s.push('"'),
                        b'\\' => s.push('\\'),
                        b'/' => s.push('/'),
                        b'n' => s.push('\n'),
                        b't' => s.push('\t'),
                        b'r' => s.push('\r'),
                        b'b' => s.push('\u{0008}'),
                        b'f' => s.push('\u{000C}'),
                        b'u' => {
                            let cp = self.read_hex4()?;
                            if (0xD800..=0xDBFF).contains(&cp) {
                                // high surrogate; expect low surrogate
                                if self.bump() == Some(b'\\') && self.bump() == Some(b'u') {
                                    let lo = self.read_hex4()?;
                                    if (0xDC00..=0xDFFF).contains(&lo) {
                                        let c = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                                        if let Some(ch) = char::from_u32(c) {
                                            s.push(ch);
                                        }
                                    }
                                }
                            } else if let Some(ch) = char::from_u32(cp) {
                                s.push(ch);
                            }
                        }
                        _ => s.push(esc as char),
                    }
                }
                _ => s.push(b as char),
            }
        }
        Err(MtError("unterminated string".into()))
    }

    fn read_hex4(&mut self) -> Result<u32> {
        let mut v = 0u32;
        for _ in 0..4 {
            let b = self.bump().ok_or_else(|| MtError("bad unicode escape".into()))?;
            let d = match b {
                b'0'..=b'9' => (b - b'0') as u32,
                b'a'..=b'f' => (b - b'a' + 10) as u32,
                b'A'..=b'F' => (b - b'A' + 10) as u32,
                _ => return Err(MtError("bad unicode escape".into())),
            };
            v = v * 16 + d;
        }
        Ok(v)
    }

    fn parse_bool(&mut self) -> Result<Json> {
        if self.bytes[self.pos..].starts_with(b"true") {
            self.pos += 4;
            Ok(Json::Bool(true))
        } else if self.bytes[self.pos..].starts_with(b"false") {
            self.pos += 5;
            Ok(Json::Bool(false))
        } else {
            Err(MtError("invalid token".into()))
        }
    }

    fn parse_null(&mut self) -> Result<Json> {
        if self.bytes[self.pos..].starts_with(b"null") {
            self.pos += 4;
            Ok(Json::Null)
        } else {
            Err(MtError("invalid token".into()))
        }
    }

    fn parse_number(&mut self) -> Result<Json> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.bump();
        }
        while let Some(b) = self.peek() {
            match b {
                b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-' => self.pos += 1,
                _ => break,
            }
        }
        let slice = &self.bytes[start..self.pos];
        let s = std::str::from_utf8(slice).map_err(|e| MtError(e.to_string()))?;
        s.parse::<f64>()
            .map(Json::Num)
            .map_err(|e| MtError(format!("invalid number: {}", e)))
    }
}

pub fn parse(s: &str) -> Result<Json> {
    let mut p = Parser::new(s);
    let v = p.parse_value()?;
    p.skip_ws();
    if p.pos != p.bytes.len() {
        // Tolerate trailing garbage that some ubus helpers append.
        // (We only ever read specific paths afterwards.)
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_status() {
        let doc = Json::obj(vec![
            ("running", Json::bool_(true)),
            ("connected", Json::bool_(false)),
            ("usb_state", Json::str_("normal")),
            ("metric", Json::str_("50")),
        ]);
        let s = doc.to_compact_string();
        assert!(s.contains("\"running\":true"));
        assert!(s.contains("\"connected\":false"));
        let back = parse(&s).unwrap();
        assert_eq!(back.get_path("usb_state").and_then(|j| j.as_str()), Some("normal"));
    }

    #[test]
    fn parses_nested() {
        let v = parse(r#"{"a":{"b":[1,2,{"c":true}]}}"#).unwrap();
        assert_eq!(v.get_path("a.b.2.c").and_then(|j| j.as_bool()), Some(true));
    }
}
