// AT transport client used by the daemon.
//
// Three channel types mirror `at-server.py`:
//   * UBUS    — forward every command through `ubus call at-daemon sendat`.
//               The PCUI serial port is owned by `ubus-at-daemon`, so we must
//               not open it ourselves; this is the default and recommended
//               mode on the MT5700M.
//   * NETWORK — a TCP connection to the module's network AT port.
//   * SERIAL  — a directly-opened serial TTY (configured via `stty`).
//
// NETWORK/SERIAL share one connection owned by a background thread.  That
// thread is the single reader: it demultiplexes spontaneous URCs (SMS / call /
// signal / PDCP) which it forwards line-by-line over `urc_tx`, and it services
// request/response commands posted on `cmd_rx`.  This avoids the dual-read
// race the original event-loop code was exposed to, while preserving its
// behaviour.  The connection auto-reconnects internally on I/O failure.

use crate::server::config::AtConfig;
use crate::server::jsonx;
use crate::shell;
use std::fs::OpenOptions;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub struct AtClient {
    pub conn_type: String,
    #[allow(dead_code)]
    cfg: AtConfig,
    conn: Mutex<ConnState>,
}

enum ConnState {
    Ubus {
        at_port: String,
        timeout: u64,
        connected: bool,
    },
    Module(Arc<ModuleConnection>),
}

struct CmdReq {
    cmd: String,
    resp_tx: mpsc::Sender<String>,
}

enum LoopExit {
    Reconnect,
}

struct ModuleConnection {
    io: Mutex<Option<Box<dyn Write + Send>>>,
    cmd_rx: Mutex<mpsc::Receiver<CmdReq>>,
    cmd_tx: mpsc::Sender<CmdReq>,
    urc_tx: mpsc::Sender<String>,
    connected: AtomicBool,
    timeout: u64,
}

#[derive(Clone, Copy)]
enum Mode {
    Network,
    Serial,
}

impl AtClient {
    pub fn new(cfg: &AtConfig) -> (AtClient, Option<mpsc::Receiver<String>>) {
        match cfg.conn_type.as_str() {
            "NETWORK" => {
                let (mc, urc_rx) = ModuleConnection::spawn(cfg, Mode::Network);
                (
                    AtClient {
                        conn_type: "NETWORK".to_string(),
                        cfg: cfg.clone(),
                        conn: Mutex::new(ConnState::Module(mc)),
                    },
                    Some(urc_rx),
                )
            }
            "SERIAL" => {
                let (mc, urc_rx) = ModuleConnection::spawn(cfg, Mode::Serial);
                (
                    AtClient {
                        conn_type: "SERIAL".to_string(),
                        cfg: cfg.clone(),
                        conn: Mutex::new(ConnState::Module(mc)),
                    },
                    Some(urc_rx),
                )
            }
            _ => (
                AtClient {
                    conn_type: "UBUS".to_string(),
                    cfg: cfg.clone(),
                    conn: Mutex::new(ConnState::Ubus {
                        at_port: cfg.ubus_at_port.clone(),
                        timeout: cfg.ubus_timeout,
                        connected: false,
                    }),
                },
                None,
            ),
        }
    }

    pub fn is_connected(&self) -> bool {
        match &*self.conn.lock().unwrap() {
            ConnState::Ubus { connected, .. } => *connected,
            ConnState::Module(mc) => mc.connected.load(Ordering::SeqCst),
        }
    }

    /// Best-effort (re)connect.  For UBUS this pings the daemon; for
    /// NETWORK/SERIAL the background thread already manages reconnection.
    pub fn connect(&self) -> bool {
        match &mut *self.conn.lock().unwrap() {
            ConnState::Ubus {
                at_port,
                timeout,
                connected,
            } => {
                if !*connected {
                    *connected = ubus_connect(at_port, *timeout);
                }
                *connected
            }
            ConnState::Module(mc) => mc.connected.load(Ordering::SeqCst),
        }
    }

    pub fn send_command(&self, cmd: &str) -> Vec<u8> {
        match &mut *self.conn.lock().unwrap() {
            ConnState::Ubus {
                at_port,
                timeout,
                connected,
            } => {
                if !*connected {
                    if !ubus_connect(at_port, *timeout) {
                        return Vec::new();
                    }
                    *connected = true;
                }
                ubus_send(at_port, cmd, *timeout).into_bytes()
            }
            ConnState::Module(mc) => {
                let c = if cmd.ends_with('\r') {
                    cmd.to_string()
                } else {
                    format!("{}\r", cmd)
                };
                let (resp_tx, resp_rx) = mpsc::channel();
                if mc.cmd_tx.send(CmdReq { cmd: c, resp_tx }).is_err() {
                    return Vec::new();
                }
                match resp_rx.recv_timeout(Duration::from_secs(mc.timeout + 3)) {
                    Ok(s) => s.into_bytes(),
                    Err(_) => Vec::new(),
                }
            }
        }
    }
}

// ----------------------------- UBUS helpers -------------------------------

/// Detect the MT5700M PCUI serial port by scanning `ttyUSB*` for the
/// interface class `ff:06:12` (as `ubus-at-daemon` does).  Falls back to
/// `/dev/ttyUSB1`.
fn detect_at_port() -> String {
    if let Ok(entries) = std::fs::read_dir("/sys/class/tty") {
        let mut ttys: Vec<String> = Vec::new();
        for e in entries.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with("ttyUSB") {
                ttys.push(n);
            }
        }
        ttys.sort();
        for t in ttys {
            let dev = format!("/sys/class/tty/{}/device", t);
            let parent = match std::fs::read_link(&dev) {
                Ok(l) => l.join(".."),
                Err(_) => continue,
            };
            let cls = read_trim(&parent.join("bInterfaceClass"));
            let sub = read_trim(&parent.join("bInterfaceSubClass"));
            let proto = read_trim(&parent.join("bInterfaceProtocol"));
            if (cls, sub, proto) == ("ff".to_string(), "06".to_string(), "12".to_string()) {
                return format!("/dev/{}", t);
            }
        }
    }
    "/dev/ttyUSB1".to_string()
}

fn read_trim(path: &std::path::Path) -> String {
    std::fs::read_to_string(path)
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default()
}

fn ubus_connect(at_port: &mut String, timeout: u64) -> bool {
    if at_port.is_empty() {
        *at_port = detect_at_port();
    }
    let payload = format!(
        "{{\"at_port\":{},\"at_cmd\":\"AT\",\"timeout\":{}}}",
        jsonx::json_str(at_port),
        timeout
    );
    match shell::ubus_call("at-daemon", "sendat", &payload) {
        Ok(out) => json_get_string(&out, "status").as_deref() == Some("success"),
        Err(_) => false,
    }
}

fn ubus_send(at_port: &str, cmd: &str, timeout: u64) -> String {
    let port = if at_port.is_empty() {
        detect_at_port()
    } else {
        at_port.to_string()
    };
    let payload = format!(
        "{{\"at_port\":{},\"at_cmd\":{},\"timeout\":{}}}",
        jsonx::json_str(&port),
        jsonx::json_str(cmd.trim()),
        timeout
    );
    match shell::ubus_call("at-daemon", "sendat", &payload) {
        Ok(out) => json_get_string(&out, "response").unwrap_or_default(),
        Err(_) => String::new(),
    }
}

/// Extract a JSON string value for `key` from `s`, honouring escapes.  We avoid
/// pulling in `serde_json` (offline-build concern) for this one field.
fn json_get_string(s: &str, key: &str) -> Option<String> {
    let pat = format!("\"{}\"", key);
    let idx = s.find(&pat)?;
    let rest = &s[idx + pat.len()..];
    let colon = rest.find(':')?;
    let after = rest[colon + 1..].trim_start();
    if !after.starts_with('"') {
        return None;
    }
    let bytes = after.as_bytes();
    let mut out = String::new();
    let mut i = 1;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'"' {
            return Some(out);
        } else if c == b'\\' && i + 1 < bytes.len() {
            i += 1;
            match bytes[i] {
                b'"' => out.push('"'),
                b'\\' => out.push('\\'),
                b'/' => out.push('/'),
                b'n' => out.push('\n'),
                b'r' => out.push('\r'),
                b't' => out.push('\t'),
                _ => out.push('?'),
            }
        } else {
            out.push(c as char);
        }
        i += 1;
    }
    Some(out)
}

// --------------------------- Module connection ----------------------------

impl ModuleConnection {
    fn spawn(cfg: &AtConfig, mode: Mode) -> (Arc<ModuleConnection>, mpsc::Receiver<String>) {
        let (urc_tx, urc_rx) = mpsc::channel();
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let (host, port, serial, baud) = match mode {
            Mode::Network => (
                cfg.net_host.clone(),
                cfg.net_port,
                String::new(),
                0,
            ),
            Mode::Serial => (
                String::new(),
                0,
                cfg.serial_port.clone(),
                cfg.serial_baud,
            ),
        };
        let timeout = match mode {
            Mode::Network => cfg.net_timeout,
            Mode::Serial => cfg.serial_timeout,
        };
        let mc = Arc::new(ModuleConnection {
            io: Mutex::new(None),
            cmd_rx: Mutex::new(cmd_rx),
            cmd_tx,
            urc_tx,
            connected: AtomicBool::new(false),
            timeout,
        });
        let mc2 = mc.clone();
        thread::spawn(move || mc2.run(mode, host, port, serial, baud));
        (mc, urc_rx)
    }

    fn run(
        self: Arc<Self>,
        mode: Mode,
        host: String,
        port: u16,
        serial: String,
        baud: u32,
    ) {
        loop {
            match self.establish(mode, &host, port, &serial, baud) {
                Ok((write_end, read_end)) => {
                    *self.io.lock().unwrap() = Some(write_end);
                    self.connected.store(true, Ordering::SeqCst);
                    // Initialise URC delivery (CNMI / text mode / clip).
                    self.send_raw("AT+CNMI=2,1,0,2,0\r");
                    thread::sleep(Duration::from_millis(50));
                    self.send_raw("AT+CMGF=0\r");
                    thread::sleep(Duration::from_millis(50));
                    self.send_raw("AT+CLIP=1\r");
                    thread::sleep(Duration::from_millis(50));

                    let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<u8>>();
                    let rr = thread::spawn(move || raw_reader(read_end, chunk_tx));
                    let _ = self.inner_loop(&chunk_rx);
                    self.connected.store(false, Ordering::SeqCst);
                    *self.io.lock().unwrap() = None;
                    let _ = rr.join();
                }
                Err(e) => {
                    self.connected.store(false, Ordering::SeqCst);
                    eprintln!("[at-server] module connect failed: {}", e);
                    thread::sleep(Duration::from_secs(2));
                }
            }
        }
    }

    fn establish(
        &self,
        mode: Mode,
        host: &str,
        port: u16,
        serial: &str,
        baud: u32,
    ) -> std::io::Result<(Box<dyn Write + Send>, Box<dyn Read + Send>)> {
        match mode {
            Mode::Network => {
                let addr = format!("{}:{}", host, port);
                let sa = match addr.to_socket_addrs() {
                    Ok(mut it) => match it.next() {
                        Some(s) => s,
                        None => {
                            return Err(std::io::Error::new(
                                ErrorKind::InvalidInput,
                                "no address resolved",
                            ))
                        }
                    },
                    Err(_) => {
                        return Err(std::io::Error::new(ErrorKind::InvalidInput, "bad address"))
                    }
                };
                let s = TcpStream::connect_timeout(&sa, Duration::from_secs(self.timeout.max(3)))?;
                let r = s.try_clone()?;
                Ok((Box::new(s), Box::new(r)))
            }
            Mode::Serial => {
                let baud_str = baud.to_string();
                let _ = shell::stty(serial, &[baud_str.as_str()]);
                let f = OpenOptions::new().read(true).write(true).open(serial)?;
                let r = f.try_clone()?;
                Ok((Box::new(f), Box::new(r)))
            }
        }
    }

    fn send_raw(&self, cmd: &str) {
        let mut g = self.io.lock().unwrap();
        if let Some(io) = g.as_mut() {
            let _ = io.write_all(cmd.as_bytes());
            let _ = io.flush();
        }
    }

    fn inner_loop(&self, chunk_rx: &mpsc::Receiver<Vec<u8>>) -> LoopExit {
        let mut line_buf = String::new();
        loop {
            let req = self.cmd_rx.lock().unwrap().try_recv();
            match req {
                Ok(req) => {
                    self.send_raw(&req.cmd);
                    let resp = self.read_response(chunk_rx, self.timeout);
                    let _ = req.resp_tx.send(resp);
                }
                Err(mpsc::TryRecvError::Empty) => match chunk_rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(chunk) => {
                        line_buf.push_str(&String::from_utf8_lossy(&chunk));
                        while let Some(pos) = line_buf.find('\n') {
                            let line = line_buf[..pos].trim_end_matches('\r').to_string();
                            line_buf.drain(..pos + 1);
                            if !line.is_empty() {
                                let _ = self.urc_tx.send(line);
                            }
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => return LoopExit::Reconnect,
                },
                Err(_) => return LoopExit::Reconnect,
            }
        }
    }

    fn read_response(&self, chunk_rx: &mpsc::Receiver<Vec<u8>>, timeout: u64) -> String {
        let mut resp = String::new();
        let deadline = Instant::now() + Duration::from_secs(timeout + 2);
        loop {
            match chunk_rx.recv_timeout(Duration::from_millis(200)) {
                Ok(chunk) => {
                    resp.push_str(&String::from_utf8_lossy(&chunk));
                    if resp.len() > 1024 * 1024 {
                        break;
                    }
                    let u = resp.to_uppercase();
                    if u.contains("OK\r\n")
                        || u.contains("\r\nOK")
                        || u.contains("\nOK")
                        || u.contains("ERROR")
                        || u.contains("+CMS ERROR:")
                        || u.contains("+CME ERROR:")
                    {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if Instant::now() > deadline {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        resp
    }
}

/// Dedicated reader: blocks on the I/O handle and forwards every chunk to the
/// module loop.  Exits on EOF / error so the loop reconnects.
fn raw_reader(mut read_end: Box<dyn Read + Send>, chunk_tx: mpsc::Sender<Vec<u8>>) {
    let mut buf = [0u8; 4096];
    loop {
        match read_end.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if chunk_tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
            Err(ref e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}
