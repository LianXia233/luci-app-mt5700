// Hand-rolled WebSocket server (RFC 6455) — no external crates.
//
// The original `at-server.py` used the `websockets` Python library with
// `ping_interval=None, ping_timeout=None`, i.e. it disabled the library's
// protocol-level keepalive and ran its OWN application-level heartbeat: the
// server sends a TEXT frame containing the literal string `"ping"` every 30s
// and the client answers with a TEXT frame `"pong"`.  We reproduce that exact
// behaviour (down to the payload strings) so the existing WebUI JS keeps
// working unchanged.  We additionally auto-answer real WebSocket protocol
// Ping (0x9) frames with Pong (0xA), exactly as the Python library did.
//
// Reads are non-blocking; the per-connection loop sleeps ~20ms when idle so
// outbound broadcasts and the heartbeat are flushed promptly without busy
// spinning.  Writes briefly flip the socket back to blocking so small frames
// always flush.

use crate::server::bus;
use crate::server::config::WsConfig;
use crate::server::jsonx;
use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use super::Context;

const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

enum Fill {
    More,
    WouldBlock,
    Eof,
    Err,
}

pub enum Recv {
    Frame { opcode: u8, payload: Vec<u8> },
    Idle,
    Closed,
}

pub struct Ws {
    stream: TcpStream,
    buf: Vec<u8>,
    frag_op: u8,
    frag_data: Vec<u8>,
    frag_active: bool,
    dead: bool,
}

fn ioerr(m: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, m)
}

impl Ws {
    /// Perform the HTTP upgrade handshake.  Reads the client request headers,
    /// computes `Sec-WebSocket-Accept`, writes the 101 response, then switches
    /// the socket to non-blocking for frame I/O.
    pub fn handshake(stream: TcpStream) -> std::io::Result<Ws> {
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        let mut s = stream;
        let mut headers = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            let n = s.read(&mut byte)?;
            if n == 0 {
                return Err(ioerr("eof during handshake"));
            }
            headers.push(byte[0]);
            if headers.len() >= 4 && &headers[headers.len() - 4..] == b"\r\n\r\n" {
                break;
            }
            if headers.len() > 8192 {
                return Err(ioerr("headers too large"));
            }
        }
        let text = String::from_utf8_lossy(&headers);
        let mut key = String::new();
        for line in text.lines() {
            let low = line.trim_start().to_ascii_lowercase();
            if let Some(rest) = low.strip_prefix("sec-websocket-key:") {
                key = rest.trim().to_string();
            }
        }
        if key.is_empty() {
            return Err(ioerr("missing Sec-WebSocket-Key"));
        }
        let accept = ws_accept(&key);
        let resp = format!(
            "HTTP/1.1 101 Switching Protocols\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Accept: {}\r\n\r\n",
            accept
        );
        s.write_all(resp.as_bytes())?;
        s.flush()?;
        s.set_nonblocking(true)?;
        s.set_read_timeout(None)?;
        Ok(Ws {
            stream: s,
            buf: Vec::new(),
            frag_op: 0,
            frag_data: Vec::new(),
            frag_active: false,
            dead: false,
        })
    }

    fn fill(&mut self) -> Fill {
        let mut tmp = [0u8; 4096];
        match self.stream.read(&mut tmp) {
            Ok(0) => Fill::Eof,
            Ok(n) => {
                self.buf.extend_from_slice(&tmp[..n]);
                Fill::More
            }
            Err(ref e) if e.kind() == ErrorKind::WouldBlock => Fill::WouldBlock,
            Err(_) => Fill::Err,
        }
    }

    fn try_parse(&mut self) -> Option<(u8, Vec<u8>)> {
        if self.buf.len() < 2 {
            return None;
        }
        let b0 = self.buf[0];
        let b1 = self.buf[1];
        let opcode = b0 & 0x0f;
        let masked = (b1 & 0x80) != 0;
        let mut len = (b1 & 0x7f) as usize;
        let mut off = 2;
        if len == 126 {
            if self.buf.len() < off + 2 {
                return None;
            }
            len = u16::from_be_bytes([self.buf[off], self.buf[off + 1]]) as usize;
            off += 2;
        } else if len == 127 {
            if self.buf.len() < off + 8 {
                return None;
            }
            let mut arr = [0u8; 8];
            arr.copy_from_slice(&self.buf[off..off + 8]);
            len = u64::from_be_bytes(arr) as usize;
            off += 8;
        }
        let mut mask = [0u8; 4];
        if masked {
            if self.buf.len() < off + 4 {
                return None;
            }
            mask.copy_from_slice(&self.buf[off..off + 4]);
            off += 4;
        }
        // Guard against abusive frame sizes (reject > 16 MiB).
        if len > 16 * 1024 * 1024 {
            self.buf.clear();
            self.dead = true;
            return None;
        }
        if self.buf.len() < off + len {
            return None;
        }
        let mut payload = self.buf[off..off + len].to_vec();
        if masked {
            for (i, b) in payload.iter_mut().enumerate() {
                *b ^= mask[i & 3];
            }
        }
        self.buf.drain(0..off + len);

        // Fragmentation assembly.
        if opcode == 0x0 {
            // continuation
            if !self.frag_active {
                return self.try_parse(); // drop unexpected continuation
            }
            self.frag_data.extend_from_slice(&payload);
            if (b0 & 0x80) != 0 {
                let op = self.frag_op;
                let data = std::mem::take(&mut self.frag_data);
                self.frag_active = false;
                return Some((op, data));
            }
            return self.try_parse();
        } else if opcode == 0x1 || opcode == 0x2 {
            if (b0 & 0x80) != 0 {
                return Some((opcode, payload));
            }
            self.frag_active = true;
            self.frag_op = opcode;
            self.frag_data = payload;
            return self.try_parse();
        } else {
            // control frames (ping/pong/close) are never fragmented
            return Some((opcode, payload));
        }
    }

    pub fn next_recv(&mut self) -> Recv {
        if self.dead {
            return Recv::Closed;
        }
        loop {
            if let Some((opcode, payload)) = self.try_parse() {
                return Recv::Frame { opcode, payload };
            }
            match self.fill() {
                Fill::More => continue,
                Fill::WouldBlock => return Recv::Idle,
                Fill::Eof | Fill::Err => return Recv::Closed,
            }
        }
    }

    pub fn write_frame(&mut self, opcode: u8, payload: &[u8]) -> std::io::Result<()> {
        // Flip to blocking so the (small) frame is always flushed.
        let _ = self.stream.set_nonblocking(false);
        let mut header = Vec::with_capacity(10);
        header.push(0x80 | (opcode & 0x0f)); // FIN + opcode, server frames unmasked
        let len = payload.len();
        if len < 126 {
            header.push(len as u8);
        } else if len <= 0xffff {
            header.push(126);
            header.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            header.push(127);
            header.extend_from_slice(&(len as u64).to_be_bytes());
        }
        self.stream.write_all(&header)?;
        self.stream.write_all(payload)?;
        self.stream.flush()?;
        let _ = self.stream.set_nonblocking(true);
        Ok(())
    }
}

/// Accept one WebSocket connection and serve it until the client disconnects.
pub fn serve(stream: TcpStream, ctx: Arc<Context>, ws_cfg: &WsConfig) {
    let mut conn = match Ws::handshake(stream) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[at-server] websocket handshake failed: {}", e);
            return;
        }
    };

    let auth_key = ws_cfg.auth_key.clone();
    let mut authed = auth_key.is_empty();

    let (out_tx, out_rx) = mpsc::channel::<String>();
    bus::register(&ctx.bus, out_tx.clone());

    // Application-level heartbeat: push a TEXT "ping" every 30s; the WebUI
    // answers with a TEXT "pong".  (Distinct from protocol Ping frames.)
    let hb_tx = out_tx.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(30));
        if hb_tx.send("ping".to_string()).is_err() {
            break;
        }
    });

    let start = Instant::now();
    loop {
        match conn.next_recv() {
            Recv::Closed => break,
            Recv::Idle => {}
            Recv::Frame { opcode, payload } => match opcode {
                0x8 => {
                    // close
                    let _ = conn.write_frame(0x8, &[]);
                    break;
                }
                0x9 => {
                    // protocol ping -> answer with pong (same payload)
                    let _ = conn.write_frame(0xA, &payload);
                }
                0xA => { /* protocol pong from client: ignore */ }
                0x1 | 0x2 => {
                    let text = String::from_utf8_lossy(&payload).to_string();
                    if !authed {
                        match parse_auth_key(&text) {
                            Some(client_key) if client_key == auth_key => {
                                authed = true;
                                let _ = conn.write_frame(
                                    0x1,
                                    r#"{"success":true,"message":"认证成功"}"#.as_bytes(),
                                );
                            }
                            _ => {
                                let _ = conn.write_frame(
                                    0x1,
                                    r#"{"error":"Authentication failed","message":"密钥验证失败"}"#
                                        .as_bytes(),
                                );
                                let _ = conn.write_frame(0x8, &[]);
                                break;
                            }
                        }
                    } else {
                        let t = text.trim();
                        if t == "ping" {
                            // client-initiated heartbeat probe -> answer pong
                            let _ = conn.write_frame(0x1, b"pong");
                        } else if t == "pong" {
                            // client ack of our application-level heartbeat;
                            // nothing to forward to the module.
                        } else {
                            let resp = process_command(&text, &ctx);
                            let _ = conn.write_frame(0x1, resp.as_bytes());
                        }
                    }
                }
                _ => {}
            },
        }

        // Auth timeout (only when a key is configured).
        if !authed && !auth_key.is_empty() && start.elapsed() > Duration::from_secs(10) {
            let _ = conn.write_frame(
                0x1,
                r#"{"error":"Authentication timeout","message":"认证超时"}"#.as_bytes(),
            );
            let _ = conn.write_frame(0x8, &[]);
            break;
        }

        // Drain outbound (broadcast notifications + heartbeat "ping").
        let mut n = 0;
        while let Ok(msg) = out_rx.try_recv() {
            let _ = conn.write_frame(0x1, msg.as_bytes());
            n += 1;
            if n > 256 {
                break;
            }
        }

        thread::sleep(Duration::from_millis(20));
    }
}

/// Extract the `auth_key` field from the client's first JSON message.
fn parse_auth_key(s: &str) -> Option<String> {
    let idx = s.find("auth_key")?;
    let rest = &s[idx + 8..];
    let q = rest.find('"')?;
    let after = &rest[q + 1..];
    let end = after.find('"')?;
    Some(after[..end].to_string())
}

/// Process a text command frame and return the JSON `ATResponse` envelope.
/// Mirrors `at-server.py::_process_command`.
fn process_command(cmd: &str, ctx: &Context) -> String {
    let cmd = cmd.trim();
    if cmd == "AT+CONNECT?" {
        let ct = if ctx.at.conn_type == "NETWORK" { "0" } else { "1" };
        return jsonx::at_response(true, Some(&format!("+CONNECT: {}\r\nOK", ct)), None);
    }

    let mut command = cmd.to_string();
    if command.starts_with("AT^SYSCFGEX") {
        command = command
            .replace('\n', "")
            .replace('\r', "")
            .replace("OK", "");
        if command.contains(",\"\",\"\"") {
            let parts: Vec<&str> = command.split(',').collect();
            if parts.len() >= 5 {
                let bands = parts[4].trim_matches('"');
                command = format!(
                    "{},{},{},{},\"{}\",\"\",\"\"",
                    parts[0], parts[1], parts[2], parts[3], bands
                );
            }
        }
        command.push('\r');
    }
    if !command.ends_with('\r') {
        command.push('\r');
    }

    let resp = ctx.at.send_command(&command);
    let resp_text = String::from_utf8_lossy(&resp);
    let filtered: Vec<&str> = resp_text
        .split("\r\n")
        .filter(|l| !l.is_empty() && l.trim() != command.trim())
        .collect();
    let filtered = filtered.join("\r\n");
    let upper = filtered.to_uppercase();
    let ok = !upper.contains("ERROR");
    jsonx::at_response(
        ok,
        if ok { Some(&filtered) } else { None },
        if ok { None } else { Some(&filtered) },
    )
}

// ----------------------- SHA1 + Base64 (for the accept key) -----------------

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xEFCDAB89;
    let mut h2: u32 = 0x98BADCFE;
    let mut h3: u32 = 0x10325476;
    let mut h4: u32 = 0xC3D2E1F0;
    let mut msg = data.to_vec();
    let ml = (msg.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&ml.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[4 * i],
                chunk[4 * i + 1],
                chunk[4 * i + 2],
                chunk[4 * i + 3],
            ]);
        }
        for i in 16..80 {
            let v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
            w[i] = v.rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h0, h1, h2, h3, h4);
        for i in 0..80 {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1u32),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDCu32),
                _ => (b ^ c ^ d, 0xCA62C1D6u32),
            };
            let tmp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(w[i]);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = tmp;
        }
        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }
    let mut out = [0u8; 20];
    out[0..4].copy_from_slice(&h0.to_be_bytes());
    out[4..8].copy_from_slice(&h1.to_be_bytes());
    out[8..12].copy_from_slice(&h2.to_be_bytes());
    out[12..16].copy_from_slice(&h3.to_be_bytes());
    out[16..20].copy_from_slice(&h4.to_be_bytes());
    out
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b = match chunk.len() {
            1 => [chunk[0], 0, 0],
            2 => [chunk[0], chunk[1], 0],
            _ => [chunk[0], chunk[1], chunk[2]],
        };
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

fn ws_accept(key: &str) -> String {
    let mut v = key.as_bytes().to_vec();
    v.extend_from_slice(WS_GUID.as_bytes());
    base64(&sha1(&v))
}
