//! Workspan desktop collector.
//!
//! Two jobs, both metadata-only:
//!   probe     — what this host actually offers (the architecture requires a probe
//!               against the installed compositor, not a support table)
//!   presence  — coarse presence events, as the daemon's evidence envelope on stdout
//!
//! It never reads window titles, URLs or descriptions, never stores application
//! identity, and never counts anything: presence is an annotation, not hours.

mod capabilities;
mod evidence;
mod hyprland;

use std::io::{BufRead, BufReader, Write};
use std::process::exit;
use std::thread;
use std::time::Duration;

fn usage() -> ! {
    eprintln!("usage: workspan-collector probe [--json] | presence [--once] [--interval-ms N]");
    eprintln!("       --apps is not implemented yet: carrying an application identifier needs a bounded envelope field");
    exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("");
    if args.iter().any(|a| a == "--apps") {
        eprintln!("--apps needs an envelope field the daemon does not have yet; refusing to smuggle it into an event id");
        exit(2);
    }
    match command {
        "probe" => {
            let report = capabilities::probe();
            println!("{}", serde_json::to_string_pretty(&report).expect("report serializes"));
        }
        "presence" => {
            let once = args.iter().any(|a| a == "--once");
            let interval = arg_value(&args, "--interval-ms")
                .and_then(|v| v.parse::<u64>().ok())
                .map(Duration::from_millis)
                .unwrap_or(Duration::from_secs(5));
            run_presence(once, interval);
        }
        _ => usage(),
    }
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|at| args.get(at + 1)).cloned()
}

/// Poll the compositor for a coarse focus signal. Application identity is compared in
/// memory only so that a *change* can be reported; it is never emitted.
fn run_presence(once: bool, interval: Duration) {
    let instance = capabilities::instance_identity();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut last_class: Option<String> = None;
    let mut last_inhibited: Option<bool> = None;
    let mut previous_sample: Option<i64> = None;

    loop {
        let now = evidence::now_ms();
        match hyprland::sample() {
            Ok(sample) => {
                if last_class.as_deref() != Some(sample.class.as_str()) {
                    last_class = Some(sample.class.clone());
                    let line = evidence::presence_event(&instance, "focus", now);
                    writeln!(out, "{}", evidence::to_json(&line)).expect("stdout is writable");
                }
                if last_inhibited != Some(sample.inhibiting_idle) {
                    last_inhibited = Some(sample.inhibiting_idle);
                    let kind = if sample.inhibiting_idle { "inhibit-idle" } else { "inhibit-cleared" };
                    let line = evidence::presence_event(&instance, kind, now);
                    writeln!(out, "{}", evidence::to_json(&line)).expect("stdout is writable");
                }
                // A long silence between samples is itself worth seeing: it is how a
                // disconnect or a suspended compositor becomes visible instead of
                // being read as "no work".
                if let Some(previous) = previous_sample {
                    if now - previous > (interval.as_millis() as i64) * 3 {
                        let line = evidence::presence_event(&instance, "sampling-gap", now);
                        writeln!(out, "{}", evidence::to_json(&line)).expect("stdout is writable");
                    }
                }
                previous_sample = Some(now);
            }
            Err(error) => {
                let line = evidence::presence_event(&instance, "source-unavailable", now);
                writeln!(out, "{}", evidence::to_json(&line)).expect("stdout is writable");
                eprintln!("presence source unavailable: {error}");
            }
        }
        out.flush().ok();
        if once {
            return;
        }
        thread::sleep(interval);
    }
}

/// Reading the event socket is deliberately not wired to the emit path yet: the
/// polling sample above is already sufficient metadata, and the socket's
/// `activewindow>>class,title` payload is content-bearing, so it would need the same
/// transient-read decision as titles.
#[allow(dead_code)]
fn socket_reader_available() -> bool { std::path::Path::new(&capabilities::event_socket_path()).exists() }

#[allow(dead_code)]
fn read_lines(path: &str) -> Vec<String> {
    std::fs::File::open(path)
        .map(|file| BufReader::new(file).lines().map_while(Result::ok).take(4).collect())
        .unwrap_or_default()
}
