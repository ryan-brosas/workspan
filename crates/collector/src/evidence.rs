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
    EvidenceEvent {
        v: 1,
        source: SOURCE.to_string(),
        instance: instance.to_string(),
        session: instance.to_string(),
        event: format!("{what}:{at_ms}"),
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
}
