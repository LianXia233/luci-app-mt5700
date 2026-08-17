// Single Rust binary that implements all three original MT5700M backend
// programs.  On OpenWrt the package installs three symlinks
// (`/usr/sbin/mt5700m-at`, `/usr/sbin/mt5700m-manager`, `/usr/sbin/mt5700m-traffic`)
// pointing at one `/usr/sbin/mt5700m` binary; we dispatch on the program name
// (argv[0] basename) so every existing call site keeps working unchanged.
// When invoked directly as `mt5700m` (no recognised symlink name) the first
// argument selects the tool, preserving manual invocations.

mod at;
mod error;
mod json;
mod manager;
mod server;
mod shell;
mod traffic;
mod usb;

use std::path::Path;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let prog = Path::new(argv.first().map(|s| s.as_str()).unwrap_or("mt5700m"))
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("mt5700m");

    let (tool, rest): (&str, &[String]) = match prog {
        "mt5700m-at" => ("at", &argv[1..]),
        "mt5700m-manager" => ("manager", &argv[1..]),
        "mt5700m-traffic" => ("traffic", &argv[1..]),
        "at-server" => ("server", &argv[1..]),
        _ => {
            // No recognised symlink name: first argument is the tool selector.
            let t = argv.get(1).map(|s| s.as_str()).unwrap_or("at");
            (t, &argv[2..])
        }
    };

    let code = match tool {
        "at" => {
            let cfg = at::config::load();
            at::run(&cfg, rest)
        }
        "manager" => manager::run(rest),
        "traffic" => traffic::run(rest),
        "server" => server::run(),
        _ => {
            eprintln!("Usage: mt5700m {{at|manager|traffic|at-server}} <args>");
            64
        }
    };
    std::process::exit(code);
}
