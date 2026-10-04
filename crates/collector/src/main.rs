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
mod idle;

use std::io::{BufRead, BufReader, Write};
use std::process::exit;
use std::thread;
use std::time::{Duration, Instant};

fn usage() -> ! {
    eprintln!("usage: workspan-collector probe [--json] | presence [--once] [--interval-ms N] [--idle-timeout-ms N]");
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
            let idle_timeout_ms = match idle_timeout(&args) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("{error}");
                    exit(2);
                }
            };
            run_presence(once, interval, idle_timeout_ms);
        }
        _ => usage(),
    }
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|at| args.get(at + 1)).cloned()
}

/// Poll the compositor for a coarse focus signal. Application identity is compared in
/// memory only so that a *change* can be reported; it is never emitted.
///
/// Seat idle arrives on its own thread through `ext_idle_notifier_v1`, because a
/// transition is an event while the focus signal is a poll.
fn run_presence(once: bool, interval: Duration, idle_timeout_ms: u32) {
    let instance = capabilities::instance_identity();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut last_class: Option<String> = None;
    let mut last_inhibited: Option<bool> = None;
    let mut previous_sample: Option<i64> = None;

    // A host without the protocol keeps sampling. The missing capability is said out
    // loud - stderr and one evidence line - because silence would read as "nobody
    // was ever idle", which is exactly the wrong conclusion.
    let observer = match idle::observe(idle_timeout_ms) {
        Ok(observer) => Some(observer),
        Err(reason) => {
            eprintln!("idle observation unavailable: {reason}");
            let line = evidence::presence_event(&instance, "idle-unavailable", evidence::now_ms());
            writeln!(out, "{}", evidence::to_json(&line)).expect("stdout is writable");
            None
        }
    };
    let mut idle_alive = observer.is_some();

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
        // Between samples, wait for the interval; a seat transition is written the
        // moment it arrives instead of at the next poll.
        match &observer {
            Some(observer) if idle_alive => {
                if !pump_idle(observer, &mut out, &instance, idle_timeout_ms, interval) {
                    idle_alive = false;
                    let line = evidence::presence_event(&instance, "idle-unavailable", evidence::now_ms());
                    writeln!(out, "{}", evidence::to_json(&line)).expect("stdout is writable");
                    out.flush().ok();
                    eprintln!("idle observation ended; the seat is no longer being watched");
                }
            }
            _ => thread::sleep(interval),
        }
    }
}

/// Write seat transitions as they arrive, waiting at most `wait` for the next one.
/// `false` means the observation thread ended.
fn pump_idle(observer: &idle::Observer, out: &mut impl Write, instance: &str, timeout_ms: u32, wait: Duration) -> bool {
    let deadline = Instant::now() + wait;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match idle::next(observer.signals(), remaining) {
            idle::Next::Quiet => return true,
            idle::Next::Ended => return false,
            idle::Next::Transition(signal) => {
                let transition = match signal {
                    idle::IdleSignal::Idle => "idle",
                    idle::IdleSignal::Resumed => "resumed",
                };
                let line = evidence::idle_event(instance, transition, evidence::now_ms(), timeout_ms);
                writeln!(out, "{}", evidence::to_json(&line)).expect("stdout is writable");
                out.flush().ok();
            }
        }
    }
}

/// A day-long quiet window is a wedged session or a suspend; logind reports those
/// separately, so the idle subscription refuses to be armed beyond one day.
const MAX_IDLE_TIMEOUT_MS: u32 = 24 * 60 * 60 * 1000;

/// The quiet window before "idle" is reported, in whole milliseconds.
fn idle_timeout(args: &[String]) -> Result<u32, String> {
    let raw = match arg_value(args, "--idle-timeout-ms") {
        Some(raw) => raw,
        None => return Ok(idle::DEFAULT_TIMEOUT_MS),
    };
    let parsed = raw
        .parse::<u32>()
        .map_err(|_| format!("--idle-timeout-ms wants whole milliseconds, got {raw:?}"))?;
    if parsed == 0 || parsed > MAX_IDLE_TIMEOUT_MS {
        return Err(format!("--idle-timeout-ms must be 1..={MAX_IDLE_TIMEOUT_MS} ms, got {parsed}"));
    }
    Ok(parsed)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn the_idle_timeout_defaults_and_refuses_an_absurd_window() {
        assert_eq!(idle_timeout(&args(&[])).expect("default"), idle::DEFAULT_TIMEOUT_MS);
        assert_eq!(idle_timeout(&args(&["--idle-timeout-ms", "2000"])).expect("explicit"), 2_000);
        assert!(idle_timeout(&args(&["--idle-timeout-ms", "0"])).is_err());
        assert!(idle_timeout(&args(&["--idle-timeout-ms", "soon"])).is_err());
        assert!(idle_timeout(&args(&["--idle-timeout-ms", "86400001"])).is_err());
    }
}
