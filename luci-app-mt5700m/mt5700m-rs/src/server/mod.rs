// at-server: the Rust re-implementation of `at-server.py`.
//
// A single long-running daemon that:
//   * serves a WebSocket terminal on `0.0.0.0` + `::` (dual stack) — the
//     WebUI's AT terminal connects here;
//   * forwards AT commands over the configured channel (UBUS / NETWORK /
//     SERIAL);
//   * watches for unsolicited result codes (SMS / call / signal / PDCP) and
//     raises notifications (WeChat webhook + log file) and WebSocket broadcasts.
//
// It is dispatched as `at-server` (a symlink to the `mt5700m` binary) so the
// OpenWrt init script and every existing call site keep working unchanged.

pub mod at;
pub mod bus;
pub mod config;
pub mod handlers;
pub mod jsonx;
pub mod notify;
pub mod sms_pdu;
pub mod ws;

use crate::server::at::AtClient;
use crate::server::handlers::MessageProcessor;
use crate::server::notify::NotificationManager;
use std::net::TcpListener;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

pub struct Context {
    pub at: AtClient,
    pub bus: bus::Bus,
    pub notify: NotificationManager,
    pub handlers: MessageProcessor,
}

/// Entry point for `mt5700m at-server`.  Returns the process exit code.
pub fn run() -> i32 {
    let cfg = config::load();
    let notify = NotificationManager::from(&cfg.notify);
    let handlers = MessageProcessor::new();
    let bus: bus::Bus = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (at, urc_rx) = AtClient::new(&cfg.at);
    let ctx = Arc::new(Context {
        at,
        bus: bus.clone(),
        notify,
        handlers,
    });
    ctx.at.connect();

    // Connection monitor: re-establish the AT channel every 30s if down.
    {
        let ctx_m = ctx.clone();
        thread::spawn(move || loop {
            if !ctx_m.at.is_connected() {
                ctx_m.at.connect();
            }
            thread::sleep(Duration::from_secs(30));
        });
    }

    // URC monitor — only meaningful for NETWORK/SERIAL (UBUS URCs are not
    // surfaced by `ubus-at-daemon`).  Each line is handled and also echoed as a
    // `raw_data` WebSocket broadcast for the WebUI's live log.
    if let Some(urc_rx) = urc_rx {
        let ctx_u = ctx.clone();
        thread::spawn(move || loop {
            match urc_rx.recv() {
                Ok(line) => {
                    ctx_u.handlers.process(&line, &ctx_u);
                    bus::broadcast(
                        &ctx_u.bus,
                        &jsonx::envelope(
                            "raw_data",
                            &format!("{{\"data\":{}}}", jsonx::json_str(&line)),
                        ),
                    );
                }
                Err(_) => break,
            }
        });
    }

    // WebSocket listeners (IPv4 always; IPv6 best-effort).
    let port = cfg.ws.port;
    let ws_cfg = cfg.ws.clone();
    let ctx_ws = ctx.clone();

    let mut threads = Vec::new();
    match TcpListener::bind(("0.0.0.0", port)) {
        Ok(l) => {
            let ctx4 = ctx_ws.clone();
            let wsc = ws_cfg.clone();
            threads.push(thread::spawn(move || accept_loop(l, ctx4, &wsc)));
        }
        Err(e) => eprintln!("[at-server] IPv4 bind {} failed: {}", port, e),
    }
    match TcpListener::bind(("::", port)) {
        Ok(l) => {
            let ctx6 = ctx_ws.clone();
            let wsc = ws_cfg.clone();
            threads.push(thread::spawn(move || accept_loop(l, ctx6, &wsc)));
        }
        Err(e) => eprintln!("[at-server] IPv6 bind {} failed (ignored): {}", port, e),
    }

    // The listeners run forever; joining keeps the process alive.
    for t in threads {
        let _ = t.join();
    }
    0
}

fn accept_loop(l: TcpListener, ctx: Arc<Context>, ws_cfg: &config::WsConfig) {
    for stream in l.incoming() {
        match stream {
            Ok(s) => {
                let ctx_c = ctx.clone();
                let wsc = ws_cfg.clone();
                thread::spawn(move || ws::serve(s, ctx_c, &wsc));
            }
            Err(_) => {
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
}
