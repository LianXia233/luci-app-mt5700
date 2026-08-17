// Minimal JSON string builder.
//
// The daemon emits only a handful of fixed-shape JSON documents (the
// `ATResponse` envelope and a few broadcast envelopes).  Rather than pulling
// in `serde_json` — which would force crate vendoring into the offline
// OpenWrt build — we hand-roll the small number of payloads we need, with a
// correct string escaper.

/// Escape a string as a JSON string literal (including control chars).
pub fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
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
    out
}

/// Build the `ATResponse` envelope the WebUI terminal expects:
/// `{"success":bool,"data":str|null,"error":str|null}`.
pub fn at_response(success: bool, data: Option<&str>, error: Option<&str>) -> String {
    let data_json = match data {
        Some(d) => json_str(d),
        None => "null".to_string(),
    };
    let error_json = match error {
        Some(e) => json_str(e),
        None => "null".to_string(),
    };
    format!(
        "{{\"success\":{},\"data\":{},\"error\":{}}}",
        if success { "true" } else { "false" },
        data_json,
        error_json
    )
}

/// Convenience for a generic `{"type":...,"data":{...}}` broadcast envelope
/// where `data` is already a JSON object string (no further escaping).
pub fn envelope(typ: &str, data_obj: &str) -> String {
    format!("{{\"type\":{},\"data\":{}}}", json_str(typ), data_obj)
}
