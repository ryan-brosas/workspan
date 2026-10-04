//! Host capability probe.
//!
//! The architecture is explicit that a reference project's support table is not a
//! host test, so these answers come from this machine: which sockets exist, whether
//! the compositor answers, and which system services are present.

use serde::Serialize;
use std::env;
use std::path::Path;
use std::process::Command;

use crate::idle;

#[derive(Serialize)]
pub struct CapabilityReport {
    pub compositor: Compositor,
    pub signals: Vec<Signal>,
    pub notes: Vec<String>,
}

#[derive(Serialize)]
pub struct Compositor {
    pub name: String,
    pub instance: Option<String>,
    pub version: Option<String>,
    pub command_channel: Channel,
    pub event_socket: Channel,
}

#[derive(Serialize)]
pub struct Channel {
    pub available: bool,
    pub detail: String,
}

#[derive(Serialize)]
pub struct Signal {
    pub name: String,
    pub available: bool,
    #[serde(rename = "source")]
    pub source: String,
    pub detail: String,
}

fn runtime_dir() -> Option<String> { env::var("XDG_RUNTIME_DIR").ok() }

pub fn instance_signature() -> Option<String> { env::var("HYPRLAND_INSTANCE_SIGNATURE").ok() }

pub fn instance_dir() -> Option<String> {
    Some(format!("{}/hypr/{}", runtime_dir()?, instance_signature()?))
}

pub fn event_socket_path() -> String {
    match instance_dir() {
        Some(dir) => format!("{dir}/.socket2.sock"),
        None => String::new(),
    }
}

/// A stable name for this desktop session. Used as the evidence session id.
pub fn instance_identity() -> String {
    let host = env::var("HOSTNAME").ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string()))
        .unwrap_or_else(|| "localhost".to_string());
    format!("{host}-desktop")
}

fn hyprctl_version() -> Option<String> {
    let output = Command::new("hyprctl").args(["-j", "version"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    value.get("tag").or_else(|| value.get("commit"))?.as_str().map(str::to_string)
}

/// Whether a system service is present on the session's system bus. Probing by
/// grepping `busctl` keeps this crate free of a D-Bus dependency; the detail says so.
fn system_service_present(name: &str) -> Channel {
    match Command::new("busctl").args(["--system", "list", "--no-pager"]).output() {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout);
            let available = text.contains(name);
            Channel { available, detail: format!("{} via busctl list", if available { "announced" } else { "not announced" }) }
        }
        _ => Channel { available: false, detail: "busctl unavailable; logind signals cannot be confirmed".to_string() },
    }
}

pub fn probe() -> CapabilityReport {
    let dir = instance_dir();
    let socket_path = event_socket_path();
    let event_socket_exists = !socket_path.is_empty() && Path::new(&socket_path).exists();
    let version = hyprctl_version();
    let logind = system_service_present("org.freedesktop.login1");

    // The idle answer is a bind attempt, not a support table: the protocol is only
    // visible to a client, so this is the only honest way to answer it.
    let idle_signal = idle::probe();

    let compositor = Compositor {
        name: if instance_signature().is_some() { "Hyprland".to_string() } else { "unknown".to_string() },
        instance: instance_signature(),
        version,
        command_channel: Channel {
            available: Command::new("hyprctl").arg("-j").arg("version").output().map(|o| o.status.success()).unwrap_or(false),
            detail: "hyprctl -j".to_string(),
        },
        event_socket: Channel {
            available: event_socket_exists,
            detail: if dir.is_some() { socket_path } else { "HYPRLAND_INSTANCE_SIGNATURE or XDG_RUNTIME_DIR missing".to_string() },
        },
    };

    let signals = vec![
        Signal { name: "focus".into(), available: compositor.command_channel.available, source: "hyprctl -j activewindow".into(), detail: "coarse class only; the application identifier is compared in memory and never emitted".into() },
        Signal { name: "idle-inhibit".into(), available: compositor.command_channel.available, source: "hyprctl -j activewindow inhibitingIdle".into(), detail: "reported as its own event, never as a break".into() },
        Signal { name: "lock".into(), available: logind.available, source: "org.freedesktop.login1".into(), detail: logind.detail.clone() },
        Signal { name: "suspend".into(), available: logind.available, source: "org.freedesktop.login1 PrepareForSleep".into(), detail: logind.detail.clone() },
        Signal { name: "workspace".into(), available: event_socket_exists, source: ".socket2.sock".into(), detail: "event stream present; not wired to the emit path yet".into() },
        Signal { name: "wayland-idle".into(), available: idle_signal.0, source: "ext_idle_notifier_v1".into(), detail: idle_signal.1 },
    ];

    let notes = vec![
        "Presence and idle are annotations: they never become working hours and never prove attendance.".to_string(),
        "Capability absence is reported as unavailable, not as zero activity.".to_string(),
        "Window titles, descriptions and tags are not read; application identity in an event needs a bounded envelope field and is not implemented.".to_string(),
        "The idle subscription observes the seat, not the application that had focus: it can say \"no input\", never \"not working\".".to_string(),
    ];

    CapabilityReport { compositor, signals, notes }
}
