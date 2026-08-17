// AT command dispatcher — faithful Rust port of the `case "${1:-status}"` block
// in `mt5700m-at`.  Every sub-command prints the exact stdout the LuCI
// front-end (`status.js`, `terminal.js`, `advanced.js`, ...) parses, and exits
// with the same codes the original shell used (0 success, 64 usage/validation,
// 1 transport/modem error, 2 channel disabled).

pub mod config;
pub mod transport;
pub mod parse;
pub mod lock;

use crate::error::exit;
use crate::shell;
use crate::usb;
use config::{AtConfig, AtMode};
use parse::AdvancedGroup;

/// Entry point invoked by `main` when the program is running as `mt5700m-at`.
/// `args` is everything after the program name (i.e. `mt5700m-at <args>`).
pub fn run(cfg: &AtConfig, args: &[String]) -> i32 {
    let cmd = args.first().map(|s| s.as_str()).unwrap_or("status");
    let rest = tail(args);
    match cmd {
        "status" => status(cfg),
        "temperature" => {
            print_out(&parse::print_temperature(cfg));
            0
        }
        "command" => command(cfg, rest),
        "network" => {
            print_out(&parse::print_network_info(cfg));
            0
        }
        "cellscan" => cellscan(cfg),
        "sms-list" => {
            print_out(&parse::print_sms_list(cfg));
            0
        }
        "sms-info" => {
            print_out(&parse::print_sms_info(cfg));
            0
        }
        "sms-send" => sms_send(cfg, rest),
        "sms-delete" => sms_delete(cfg, rest),
        "sms-clear" => sms_clear(cfg),
        "sms-set" => sms_set(cfg, rest),
        "system" => {
            print_out(&parse::print_system_info(cfg));
            0
        }
        "advanced" => advanced(cfg, rest),
        "advanced-set" => advanced_set(cfg, rest),
        "pdp-set" => pdp_set(cfg, rest),
        "pdp-remove" => pdp_remove(cfg, rest),
        "pdp-state" => pdp_state(cfg, rest),
        "flow-clear" => at_send(cfg, "AT^DSFLOWCLR"),
        "airplane" => airplane(cfg, rest),
        "sim-pin" => sim_pin(cfg, rest),
        "sms-ims" => sms_ims(cfg, rest),
        "factory-reset" => at_send(cfg, "AT&F0"),
        "set-imei" => set_imei(cfg, rest),
        "fota-init" => at_send(cfg, "AT^FOTAMODE=0,1,0,1"),
        "fota-state" => at_send(cfg, "AT^FOTASTATE?"),
        "fota-progress" => at_send(cfg, "AT^FOTADLQ"),
        "fota-download" => fota_download(cfg, rest),
        "fota-start" => fota_start(cfg, rest),
        "fota-resume" => at_send(cfg, "AT^FOTADL=1"),
        "fota-upgrade" => at_send(cfg, "AT^FWUP"),
        "preview-lock" => preview_lock(rest),
        "lock" => lock(cfg, rest),
        "restart" => at_send(cfg, "AT^RESET"),
        "unlock" => unlock(cfg),
        _ => {
            eprintln!("Usage: mt5700m-at {{status|command <AT>|restart|unlock}}");
            1
        }
    }
}

// ----------------------------- helpers ----------------------------------

fn tail(args: &[String]) -> &[String] {
    if args.is_empty() {
        &[]
    } else {
        &args[1..]
    }
}

fn str_refs(args: &[String]) -> Vec<&str> {
    args.iter().map(|s| s.as_str()).collect()
}

fn digits_of(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect()
}

fn arg_str(args: &[String], idx: usize) -> &str {
    args.get(idx).map(|s| s.as_str()).unwrap_or("")
}

/// Send one AT command and print its response when non-empty, mirroring the
/// way the shell's `at_cmd` emits the modem reply before returning its rc.
fn at_send(cfg: &AtConfig, command: &str) -> i32 {
    let r = transport::at_cmd(cfg, command);
    if !r.response.is_empty() {
        println!("{}", r.response);
    }
    r.rc
}

/// Like `at_send` but discards the response (shell `>/dev/null`), still
/// returning the rc so callers can `|| exit 1`.
fn at_rc(cfg: &AtConfig, command: &str) -> i32 {
    transport::at_cmd(cfg, command).rc
}

fn print_out(s: &str) {
    if !s.is_empty() {
        print!("{}", s);
        if !s.ends_with('\n') {
            println!();
        }
    }
}

fn valid_ipv4(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parts.iter().all(|p| {
        let ok = !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) && p.parse::<u32>().map(|n| n <= 255).unwrap_or(false);
        ok && !(p.len() > 1 && p.starts_with('0'))
    })
}

// ----------------------------- commands ---------------------------------

fn status(cfg: &AtConfig) -> i32 {
    // Keep the status query inside rpcd's timeout even if an optional query
    // hangs; the shell clamped the timeout to >= 2 s.
    let mut c = cfg.clone();
    if c.timeout > 2 {
        c.timeout = 2;
    }

    println!("enabled={}", if c.enabled { 1 } else { 0 });
    println!(
        "mode={}",
        match c.mode {
            AtMode::Serial => "serial",
            AtMode::Network => "network",
            AtMode::Auto => "auto",
        }
    );

    match usb::usb_info() {
        Some(info) => {
            println!("usb_state={}", info.state);
            println!("usb_pid={}", info.product);
            println!("usb_slot={}", info.slot);
        }
        None => println!("usb_state=absent"),
    }

    let detected_at_port = usb::pcui_port().unwrap_or_default();
    let at_port = if detected_at_port.is_empty() {
        c.at_port.clone()
    } else {
        detected_at_port.clone()
    };
    println!("at_port={}", at_port);
    println!("host={}", c.host);
    println!("port={}", c.port);
    let gateway = transport::detect_gateway().unwrap_or_default();
    println!("detected_gateway={}", gateway);

    let channel = match c.mode {
        AtMode::Network => "network",
        _ => {
            if detected_at_port.is_empty() {
                "network"
            } else {
                "serial"
            }
        }
    };
    println!("channel={}", channel);

    let at_resp = transport::at_cmd(&c, "AT");
    println!("connected={}", if at_resp.response.contains("OK") { 1 } else { 0 });

    print_out(&parse::print_identity(&c));
    print_out(&parse::print_sim_operator(&c));
    print_out(&parse::print_sim_details(&c));
    print_out(&parse::print_qos(&c));
    print_out(&parse::print_active_apn(&c));
    print_out(&parse::print_subscriber_number(&c));
    print_out(&parse::print_signal(&c));
    print_out(&parse::print_subscription_rate(&c));
    print_out(&parse::print_carrier_aggregation(&c));
    print_out(&parse::print_temperature(&c));
    print_out(&parse::print_lock_status(&c));
    0
}

fn command(cfg: &AtConfig, args: &[String]) -> i32 {
    let cmd: String = args.join(" ");
    if cmd.is_empty() {
        return 1;
    }
    at_send(cfg, &cmd)
}

fn cellscan(cfg: &AtConfig) -> i32 {
    let mut c = cfg.clone();
    if c.timeout < 30 {
        c.timeout = 30;
    }
    println!("===== Serving cell: AT^MONSC =====");
    let _ = at_send(&c, "AT^MONSC");
    println!();
    println!("===== Neighbour cells: AT^MONNC =====");
    let _ = at_send(&c, "AT^MONNC");
    println!();
    println!("===== Frequency scan: AT^CELLSCAN =====");
    let _ = at_send(&c, "AT^CELLSCAN");
    0
}

fn sms_delete(cfg: &AtConfig, args: &[String]) -> i32 {
    let index = digits_of(arg_str(args, 0));
    if index.is_empty() {
        return 1;
    }
    at_send(cfg, &format!("AT+CMGD={}", index))
}

fn sms_clear(cfg: &AtConfig) -> i32 {
    let _ = at_rc(cfg, "AT+CMGF=0");
    at_send(cfg, "AT+CMGD=1,4")
}

fn sms_set(cfg: &AtConfig, args: &[String]) -> i32 {
    match arg_str(args, 0) {
        "smsc" => {
            let v: String = arg_str(args, 1)
                .chars()
                .filter(|c| c.is_ascii_digit() || *c == '+')
                .collect();
            if v.is_empty() {
                return exit::BAD_ARG;
            }
            at_send(cfg, &format!("AT+CSCA=\"{}\"", v))
        }
        "storage" => match arg_str(args, 1) {
            "SM" | "ME" => {
                let s = arg_str(args, 1);
                at_send(cfg, &format!("AT+CPMS=\"{}\",\"{}\",\"{}\"", s, s, s))
            }
            _ => exit::BAD_ARG,
        },
        _ => exit::BAD_ARG,
    }
}

fn advanced(cfg: &AtConfig, args: &[String]) -> i32 {
    let group = match arg_str(args, 0) {
        "connection" => AdvancedGroup::Connection,
        "connection-settings" => AdvancedGroup::ConnectionSettings,
        "session" => AdvancedGroup::Session,
        "radio" => AdvancedGroup::Radio,
        "radio-diagnostics" => AdvancedGroup::RadioDiagnostics,
        "hardware" => AdvancedGroup::Hardware,
        _ => AdvancedGroup::All,
    };
    print_out(&parse::print_advanced_info(cfg, group));
    0
}

fn advanced_set(cfg: &AtConfig, args: &[String]) -> i32 {
    let sub = arg_str(args, 0);
    let a = tail(args);
    match sub {
        "radio-policy" => lock::set_radio_policy(cfg, &str_refs(a)),
        "radio-mode" => lock::set_radio_mode(cfg, arg_str(a, 0)),
        "5g-access" => lock::set_5g_access_mode(cfg, arg_str(a, 0)),
        "autodial" => autodial_set(cfg, a),
        "nic-speed" => match arg_str(a, 0) {
            "1" | "2" => at_send(cfg, &format!("AT^TDPCIELANCFG={}", arg_str(a, 0))),
            _ => exit::BAD_ARG,
        },
        "pcie-controller" => match arg_str(a, 0) {
            "0" | "1" => at_send(cfg, &format!("AT^TDPMCFG={},0,0,0", arg_str(a, 0))),
            _ => exit::BAD_ARG,
        },
        "led" => match arg_str(a, 0) {
            "0" | "1" => at_send(cfg, &format!("AT^LEDSWITCH={}", arg_str(a, 0))),
            _ => exit::BAD_ARG,
        },
        "usb-mode" => match arg_str(a, 0) {
            "0" | "1" | "2" | "3" | "4" | "5" | "6" | "8" => {
                at_send(cfg, &format!("AT^SETMODE={}", arg_str(a, 0)))
            }
            _ => exit::BAD_ARG,
        },
        "interface-mode" => match arg_str(a, 0) {
            "1" | "2" => at_send(cfg, &format!("AT^TDCFG=\"infcfg\",\"mode\",{}", arg_str(a, 0))),
            _ => exit::BAD_ARG,
        },
        "postroute" => match arg_str(a, 0) {
            "2" => at_send(cfg, "AT^TDCFG=\"infcfg\",\"PostRoute\",2"),
            "1" => {
                if at_rc(cfg, "AT^TDCFG=\"infcfg\",\"PostRoute\",1") != 0 {
                    return 1;
                }
                at_send(cfg, "AT^IPFILTERSWITCH=0")
            }
            _ => exit::BAD_ARG,
        },
        "dmz" => {
            let dmz = arg_str(a, 0);
            if dmz == "0" {
                at_send(cfg, "AT^TDCFG=\"infcfg\",\"dmz\",\"0\"")
            } else if valid_ipv4(dmz) {
                at_send(cfg, &format!("AT^TDCFG=\"infcfg\",\"dmz\",\"{}\"", dmz))
            } else {
                exit::BAD_ARG
            }
        }
        "sim-hotplug" => match arg_str(a, 0) {
            "0" | "1" => at_send(cfg, &format!("AT^TDSIMHP={}", arg_str(a, 0))),
            _ => exit::BAD_ARG,
        },
        "sim-activation" => match arg_str(a, 0) {
            "0" | "1" => at_send(cfg, &format!("AT^HVSST=1,{}", arg_str(a, 0))),
            _ => exit::BAD_ARG,
        },
        "sim-slot" => match arg_str(a, 0) {
            "0" => at_send(cfg, "AT^SCICHG=0,1"),
            "1" => at_send(cfg, "AT^SCICHG=1,0"),
            _ => exit::BAD_ARG,
        },
        "thermal" => {
            let enabled = arg_str(a, 0);
            let interval = arg_str(a, 1);
            match enabled {
                "0" | "1" => {}
                _ => return exit::BAD_ARG,
            }
            match interval {
                "1" | "2" | "3" | "4" | "5" | "10" | "15" | "30" | "60" => {}
                _ => return exit::BAD_ARG,
            }
            at_send(cfg, &format!("AT^THERMAUTOFUN={},0,{}", enabled, interval))
        }
        "thermal-log" => {
            let serial = arg_str(a, 0);
            let file = arg_str(a, 1);
            match serial {
                "0" | "1" => {}
                _ => return exit::BAD_ARG,
            }
            match file {
                "0" | "1" => {}
                _ => return exit::BAD_ARG,
            }
            at_send(cfg, &format!("AT^THERMLDLOGSW={},{}", serial, file))
        }
        "thermal-thresholds" => {
            if !lock::valid_thermal_thresholds(&str_refs(a)) {
                return exit::BAD_ARG;
            }
            let joined = a
                .iter()
                .take(9)
                .cloned()
                .collect::<Vec<_>>()
                .join(",");
            at_send(cfg, &format!("AT^THERMLDAUTOPARA={}", joined))
        }
        "carrier-aggregation" => match arg_str(a, 0) {
            "0" | "1" => at_send(cfg, &format!("AT^NRRCCAPCFG=3,{}", arg_str(a, 0))),
            _ => exit::BAD_ARG,
        },
        "vonr" => match arg_str(a, 0) {
            "0" | "1" | "2" | "3" => at_send(cfg, &format!("AT^NRRCCAPCFG=2,{}", arg_str(a, 0))),
            _ => exit::BAD_ARG,
        },
        "dss" => {
            let rate = arg_str(a, 0);
            let dmrs = arg_str(a, 1);
            match rate {
                "0" | "1" => {}
                _ => return exit::BAD_ARG,
            }
            match dmrs {
                "0" | "1" => {}
                _ => return exit::BAD_ARG,
            }
            at_send(cfg, &format!("AT^NRRCCAPCFG=5,{},{}", rate, dmrs))
        }
        "direct-ip" => match arg_str(a, 0) {
            "0" | "1" => at_send(cfg, &format!("AT^SETDIRECTIP={}", arg_str(a, 0))),
            _ => exit::BAD_ARG,
        },
        _ => exit::BAD_ARG,
    }
}

fn autodial_set(cfg: &AtConfig, a: &[String]) -> i32 {
    let enable = arg_str(a, 0);
    let dial_mode = arg_str(a, 1);
    let protocol = arg_str(a, 2);
    let apn = arg_str(a, 3);
    let username = arg_str(a, 4);
    let password = arg_str(a, 5);
    let auth_type = arg_str(a, 6);

    if enable != "0" && enable != "1" {
        return exit::BAD_ARG;
    }
    if enable == "0" {
        return at_send(cfg, "AT^SETAUTODIAL=0");
    }
    if !matches!(dial_mode, "0" | "1" | "2") {
        return exit::BAD_ARG;
    }
    if !matches!(protocol, "IP" | "IPV6" | "IPV4V6") {
        return exit::BAD_ARG;
    }
    if !matches!(auth_type, "0" | "1" | "2") {
        return exit::BAD_ARG;
    }
    if !(lock::safe_at_field(apn) && lock::safe_at_field(username) && lock::safe_at_field(password)) {
        return exit::BAD_ARG;
    }
    if apn.len() > 99 || username.len() > 31 || password.len() > 31 {
        return exit::BAD_ARG;
    }
    at_send(
        cfg,
        &format!(
            "AT^SETAUTODIAL={},{},{:?},\"{}\",\"{}\",\"{}\",{}",
            enable, dial_mode, protocol, apn, username, password, auth_type
        ),
    )
}

fn pdp_set(cfg: &AtConfig, args: &[String]) -> i32 {
    let cid = arg_str(args, 0);
    let pdp_type = arg_str(args, 1);
    let apn = arg_str(args, 2);
    if !is_cid(cid) {
        return exit::BAD_ARG;
    }
    if !matches!(pdp_type, "IP" | "IPV6" | "IPV4V6") {
        return exit::BAD_ARG;
    }
    if !(lock::safe_at_field(apn) && apn.len() <= 99) {
        return exit::BAD_ARG;
    }
    at_send(cfg, &format!("AT+CGDCONT={},\"{}\",\"{}\"", cid, pdp_type, apn))
}

fn pdp_remove(cfg: &AtConfig, args: &[String]) -> i32 {
    let cid = arg_str(args, 0);
    if !is_cid(cid) {
        return exit::BAD_ARG;
    }
    at_send(cfg, &format!("AT+CGDCONT={}", cid))
}

fn pdp_state(cfg: &AtConfig, args: &[String]) -> i32 {
    let state = arg_str(args, 0);
    let cid = arg_str(args, 1);
    if state != "0" && state != "1" {
        return exit::BAD_ARG;
    }
    if !is_cid(cid) {
        return exit::BAD_ARG;
    }
    at_send(cfg, &format!("AT+CGACT={},{}", state, cid))
}

fn airplane(cfg: &AtConfig, args: &[String]) -> i32 {
    match arg_str(args, 0) {
        "0" | "1" => at_send(cfg, &format!("AT+CFUN={}", arg_str(args, 0))),
        _ => exit::BAD_ARG,
    }
}

fn sim_pin(cfg: &AtConfig, args: &[String]) -> i32 {
    let op = arg_str(args, 0);
    let p1 = arg_str(args, 1);
    let p2 = arg_str(args, 2);
    match op {
        "verify" => {
            if !lock::valid_pin(p1) {
                return exit::BAD_ARG;
            }
            at_send(cfg, &format!("AT+CPIN=\"{}\"", p1))
        }
        "enable" | "disable" => {
            if !lock::valid_pin(p1) {
                return exit::BAD_ARG;
            }
            let lock_state = if op == "enable" { 1 } else { 0 };
            at_send(cfg, &format!("AT+CLCK=\"SC\",{},\"{}\"", lock_state, p1))
        }
        "change" => {
            if !(lock::valid_pin(p1) && lock::valid_pin(p2)) {
                return exit::BAD_ARG;
            }
            at_send(cfg, &format!("AT+CPWD=\"SC\",\"{}\",\"{}\"", p1, p2))
        }
        "unblock" => {
            if !(lock::valid_puk(p1) && lock::valid_pin(p2)) {
                return exit::BAD_ARG;
            }
            at_send(cfg, &format!("AT+CPIN=\"{}\",\"{}\"", p1, p2))
        }
        _ => exit::BAD_ARG,
    }
}

fn sms_ims(cfg: &AtConfig, args: &[String]) -> i32 {
    match arg_str(args, 0) {
        "1" => {
            if at_rc(cfg, "AT+CFUN=0") != 0 {
                return 1;
            }
            if at_rc(
                cfg,
                "AT+CGDCONT=5,\"IPV4V6\",\"ims\",\"\",0,0,0,0,1,1,1,,,,,,0,,0,0,0,0",
            ) != 0
            {
                return 1;
            }
            if at_rc(cfg, "AT+CEUS=0") != 0 {
                return 1;
            }
            if at_rc(cfg, "AT^IMSSWITCH=1,0,0") != 0 {
                return 1;
            }
            at_send(cfg, "AT+CFUN=1")
        }
        "0" => {
            if at_rc(cfg, "AT+CFUN=0") != 0 {
                return 1;
            }
            if at_rc(
                cfg,
                "AT+CGDCONT=5,\"IPV4V6\",\"\",\"\",0,0,0,0,1,1,1,,,,,,0,,0,0,0,0",
            ) != 0
            {
                return 1;
            }
            if at_rc(cfg, "AT+CEUS=1") != 0 {
                return 1;
            }
            if at_rc(cfg, "AT^IMSSWITCH=0,0,0") != 0 {
                return 1;
            }
            at_send(cfg, "AT+CFUN=1")
        }
        _ => exit::BAD_ARG,
    }
}

fn set_imei(cfg: &AtConfig, args: &[String]) -> i32 {
    let imei = arg_str(args, 0);
    if imei.is_empty() || !imei.chars().all(|c| c.is_ascii_digit()) || imei.len() != 15 {
        return exit::BAD_ARG;
    }
    at_send(cfg, &format!("AT^PHYNUM=IMEI,{}", imei))
}

fn fota_download(cfg: &AtConfig, args: &[String]) -> i32 {
    let url: String = arg_str(args, 0)
        .chars()
        .filter(|c| *c != '\0' && *c != '\r' && *c != '\n' && *c != '"')
        .collect();
    if url.is_empty() {
        return 1;
    }
    at_send(cfg, &format!("AT^FOTAOEMDL=\"{}\"", url))
}

fn fota_start(cfg: &AtConfig, args: &[String]) -> i32 {
    let url: String = arg_str(args, 0)
        .chars()
        .filter(|c| *c != '\0' && *c != '\r' && *c != '\n' && *c != '"')
        .collect();
    if !url.starts_with("http://") {
        return exit::BAD_ARG;
    }
    if url.contains(',') {
        return exit::BAD_ARG;
    }
    let url = if url.ends_with('/') {
        url
    } else {
        format!("{}/", url)
    };
    if at_rc(cfg, "ATE0") != 0 {
        return 1;
    }
    if at_rc(cfg, "AT^FOTAMODE=0,1,0,1") != 0 {
        return 1;
    }
    at_send(cfg, &format!("AT^FOTAOEMDL=\"{}\"", url))
}

fn preview_lock(args: &[String]) -> i32 {
    match arg_str(args, 0) {
        "lte" => match parse::build_lte_lock_command(
            arg_str(args, 1),
            arg_str(args, 2),
            arg_str(args, 3),
            arg_str(args, 4),
        ) {
            Ok(cmd) => {
                println!("{}", cmd);
                0
            }
            Err(()) => exit::BAD_ARG,
        },
        "nr" => match parse::build_nr_lock_command(
            arg_str(args, 1),
            arg_str(args, 2),
            arg_str(args, 3),
            arg_str(args, 4),
            arg_str(args, 5),
        ) {
            Ok(cmd) => {
                println!("{}", cmd);
                0
            }
            Err(()) => exit::BAD_ARG,
        },
        _ => {
            eprintln!("Usage: mt5700m-at preview-lock {{lte|nr}} <type> <bands> [arfcns] [scs] [pcis]");
            1
        }
    }
}

fn lock(cfg: &AtConfig, args: &[String]) -> i32 {
    let (rat, lock_type, lock_cmd) = match arg_str(args, 0) {
        "lte" => {
            let t = arg_str(args, 1);
            match parse::build_lte_lock_command(t, arg_str(args, 2), arg_str(args, 3), arg_str(args, 4)) {
                Ok(cmd) => ("lte", t.to_string(), cmd),
                Err(()) => return exit::BAD_ARG,
            }
        }
        "nr" => {
            let t = arg_str(args, 1);
            match parse::build_nr_lock_command(
                t,
                arg_str(args, 2),
                arg_str(args, 3),
                arg_str(args, 4),
                arg_str(args, 5),
            ) {
                Ok(cmd) => ("nr", t.to_string(), cmd),
                Err(()) => return exit::BAD_ARG,
            }
        }
        _ => {
            eprintln!("Usage: mt5700m-at lock {{lte|nr}} <type> <bands> [arfcns] [scs] [pcis]");
            return 1;
        }
    };
    if lock_cmd.is_empty() {
        return exit::BAD_ARG;
    }
    match lock::apply_frequency_lock(cfg, rat, &lock_type, &lock_cmd) {
        Ok(raw) => {
            if !raw.is_empty() {
                println!("{}", raw);
            }
            0
        }
        Err(_) => 1,
    }
}

fn unlock(cfg: &AtConfig) -> i32 {
    println!("Unlock LTE:");
    let _ = at_send(cfg, "AT^LTEFREQLOCK=0");
    println!("Unlock NR:");
    at_send(cfg, "AT^NRFREQLOCK=0")
}

fn is_cid(s: &str) -> bool {
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    matches!(s, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11")
}

// ----------------------------- SMS send ---------------------------------

fn sms_send(cfg: &AtConfig, args: &[String]) -> i32 {
    let number: String = arg_str(args, 0)
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '+')
        .collect();
    let text: String = arg_str(args, 1).chars().filter(|c| *c != '\0').collect();
    if number.is_empty() || text.is_empty() {
        return 1;
    }

    if let Some(device) = usb::pcui_port() {
        // Prefer sms_tool_q (PDU encoding + final +CMGS handling).
        if shell::command_exists("sms_tool_q") {
            let (_, ok) = shell::run(
                "sms_tool_q",
                &["-d", device.as_str(), "send", number.as_str(), text.as_str()],
            )
            .unwrap_or((String::new(), false));
            return if ok { 0 } else { 1 };
        }
        return serial_sms_send(&device, &number, &text);
    }

    // Network channel fallback: pipe the AT sequence to nc.
    for host in transport::network_hosts(cfg) {
        if network_sms_send(&host, cfg.port, &number, &text) {
            return 0;
        }
    }
    1
}

fn serial_sms_send(device: &str, number: &str, text: &str) -> i32 {
    use std::io::Write;
    use std::time::{Duration, Instant};

    if !std::path::Path::new(device).exists() {
        return 1;
    }
    let _ = shell::stty(
        device,
        &[
            "115200", "raw", "-echo", "-echoe", "-echok", "-echoctl", "-echoke", "-ixon", "-ixoff",
            "min", "0", "time", "5",
        ],
    );

    let tmp = format!("/tmp/mt5700m-sms.{}.XXXXXX", std::process::id());
    let tmp = if let Ok(out) = shell::run("mktemp", &[tmp.as_str()]) {
        out.0
    } else {
        "/tmp/mt5700m-sms.tmp".to_string()
    };

    let mut cat = match std::process::Command::new("cat")
        .arg(device)
        .stdout(std::fs::OpenOptions::new().create(true).write(true).truncate(true).open(&tmp).map_err(|e| e.to_string()).unwrap())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return 1,
    };

    let write_step = |cmd: &str| -> bool {
        let mut dev = match std::fs::OpenOptions::new().write(true).open(device) {
            Ok(d) => d,
            Err(_) => return false,
        };
        let _ = dev.write_all(cmd.as_bytes());
        let _ = dev.flush();
        true
    };

    if !write_step(&format!("AT+CMGF=1\r")) {
        let _ = cat.kill();
        return 1;
    }
    std::thread::sleep(Duration::from_secs(1));
    if !write_step(&format!("AT+CMGS=\"{}\"\r", number)) {
        let _ = cat.kill();
        return 1;
    }
    std::thread::sleep(Duration::from_secs(1));
    if !write_step(&format!("{}\u{001a}", text)) {
        let _ = cat.kill();
        return 1;
    }

    // Read until a final result token or until the bounded timeout elapses.
    let deadline = Instant::now() + Duration::from_secs(25);
    let mut final_output = String::new();
    let mut done = false;
    while Instant::now() < deadline {
        if let Ok(contents) = std::fs::read_to_string(&tmp) {
            let stripped: String = contents.replace('\r', "");
            if terminal_token_present(&stripped) {
                final_output = stripped;
                done = true;
                break;
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    if !done {
        if let Ok(contents) = std::fs::read_to_string(&tmp) {
            final_output = contents.replace('\r', "");
        }
    }
    let _ = cat.kill();
    let _ = std::fs::remove_file(&tmp);
    if !final_output.is_empty() {
        println!("{}", final_output);
    }
    0
}

fn network_sms_send(host: &str, port: u16, number: &str, text: &str) -> bool {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};

    if !shell::command_exists("nc") && !std::path::Path::new("/usr/bin/nc").exists() {
        return false;
    }
    let port_s = port.to_string();
    let mut child = match Command::new("nc")
        .args(["-w", "30", host, port_s.as_str()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("AT+CMGF=1\r").as_bytes());
        let _ = stdin.write_all(format!("AT+CMGS=\"{}\"\r", number).as_bytes());
        let _ = stdin.write_all(format!("{}\u{001a}", text).as_bytes());
        let _ = stdin.flush();
    }
    let _ = child.wait();
    let mut response = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut response);
    }
    if !response.trim().is_empty() {
        println!("{}", response.trim());
    }
    !response.trim().is_empty()
}

fn terminal_token_present(text: &str) -> bool {
    for line in text.split('\n') {
        let t = line.trim();
        if t == "OK" || t == "ERROR" || t.starts_with("+CME ERROR") || t.starts_with("+CMS ERROR") {
            return true;
        }
    }
    false
}
