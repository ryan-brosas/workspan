//! The daemon's evidence envelope, built here so the collector cannot drift from it.

use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

pub const SOURCE: &str = "desktop";
/// Presence is not attendance: the daemon only turns *human* interaction into inferred
/// work, so desktop evidence lands as an annotation with an unknown origin.
pub const ORIGIN: &str = "unknown";

#[derive(Serialize)]
pub struct EvidenceEvent {
    pub v: u8,
    pub source: String,
    pub instance: String,
    pub session: String,
    pub event: String,
    pub kind: String,
    pub at: i64,
    pub origin: String,
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// One presence observation. The `what` token names the transition (focus, workspace,
/// inhibit-idle, sampling-gap, source-unavailable, ...); application identity is never
/// part of it.
pub fn presence_event(instance: &str, what: &str, at_ms: i64) -> EvidenceEvent {
    observation(instance, format!("{what}:{at_ms}"), at_ms)
}

/// One seat idle transition, as `ext_idle_notifier_v1` reported it.
///
/// The notifier fires only after `timeout_ms` without input, so the timeout travels
/// in the event id: it is what turns the stamp back into the start of the quiet
/// stretch (`at - timeout_ms`) without a config lookup, and a reader that did not
/// know it would understate the gap.
pub fn idle_event(instance: &str, transition: &str, at_ms: i64, timeout_ms: u32) -> EvidenceEvent {
    observation(instance, format!("{transition}:{at_ms}:{timeout_ms}"), at_ms)
}

fn observation(instance: &str, event: String, at_ms: i64) -> EvidenceEvent {
    EvidenceEvent {
        v: 1,
        source: SOURCE.to_string(),
        instance: instance.to_string(),
        session: instance.to_string(),
        event,
        kind: "interaction".to_string(),
        at: at_ms,
        origin: ORIGIN.to_string(),
    }
}

pub fn to_json(event: &EvidenceEvent) -> String {
    serde_json::to_string(event).expect("an evidence event always serializes")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_event_carries_only_the_contract_fields() {
        let json = to_json(&presence_event("host-desktop", "focus", 1_700_000_000_000));
        let value: serde_json::Value = serde_json::from_str(&json).expect("json");
        let mut keys: Vec<&str> = value.as_object().expect("object").keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["at", "event", "instance", "kind", "origin", "session", "source", "v"]);
        assert_eq!(value["source"], "desktop");
        assert_eq!(value["origin"], "unknown");
        assert_eq!(value["kind"], "interaction");
        // No project: desktop presence is never attributed to a client.
        assert!(value.get("project").is_none());
    }

    #[test]
    fn the_event_id_names_the_transition_and_the_moment_only() {
        let event = presence_event("host-desktop", "inhibit-idle", 42);
        assert_eq!(event.event, "inhibit-idle:42");
    }

    #[test]
    fn an_idle_event_carries_the_timeout_that_places_the_quiet_stretch() {
        let event = idle_event("host-desktop", "idle", 1_700_000_000_000, 300_000);
        assert_eq!(event.event, "idle:1700000000000:300000");
        assert_eq!(event.at, 1_700_000_000_000);
        // Still an annotation: unknown origin, and no project to guess at.
        let value: serde_json::Value = serde_json::from_str(&to_json(&event)).expect("json");
        assert_eq!(value["origin"], "unknown");
        assert_eq!(value["kind"], "interaction");
        assert!(value.get("project").is_none());
        assert_eq!(idle_event("host-desktop", "resumed", 7, 300_000).event, "resumed:7:300000");
    }
}
