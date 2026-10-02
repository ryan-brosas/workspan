//! Coarse compositor sampling.
//!
//! `hyprctl -j activewindow` returns a large object that includes `title`,
//! `initialTitle` and `xdgDescription` — content-bearing fields. This module reads
//! only `class` and `inhibitingIdle`, and never materializes the rest.

use serde::{Deserialize, Serialize};
use std::process::Command;

/// Only the coarse fields are declared, so nothing else is deserialized into memory.
#[derive(Deserialize)]
struct CoarseWindow {
    class: Option<String>,
    #[serde(rename = "inhibitingIdle")]
    inhibiting_idle: Option<bool>,
}

#[derive(Serialize)]
pub struct Sample {
    /// Application identity: held in memory to detect a change, never emitted.
    pub class: String,
    pub inhibiting_idle: bool,
}

pub fn sample() -> Result<Sample, String> {
    let output = Command::new("hyprctl")
        .args(["-j", "activewindow"])
        .output()
        .map_err(|error| format!("hyprctl could not be run: {error}"))?;
    if !output.status.success() {
        return Err(format!("hyprctl exited with {}", output.status));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed == "{}" {
        // No focused window: a real state, reported as its own class token.
        return Ok(Sample { class: "(none)".to_string(), inhibiting_idle: false });
    }
    let window: CoarseWindow = serde_json::from_str(trimmed)
        .map_err(|error| format!("activewindow was not the expected shape: {error}"))?;
    Ok(Sample {
        class: window.class.filter(|c| !c.is_empty()).unwrap_or_else(|| "(unknown)".to_string()),
        inhibiting_idle: window.inhibiting_idle.unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_coarse_window_keeps_only_class_and_inhibition() {
        let raw = r#"{"class":"Chatgpt","title":"quarterly-planning-secret","initialTitle":"also-secret","xdgDescription":"customer-invoice.pdf","inhibitingIdle":true}"#;
        let window: CoarseWindow = serde_json::from_str(raw).expect("shape parses");
        assert_eq!(window.class.as_deref(), Some("Chatgpt"));
        assert_eq!(window.inhibiting_idle, Some(true));

        // What leaves this module is the sample, and it carries no content-bearing field.
        let sample = Sample {
            class: window.class.clone().unwrap_or_default(),
            inhibiting_idle: window.inhibiting_idle.unwrap_or(false),
        };
        let rendered = serde_json::to_string(&sample).expect("serializes");
        assert!(rendered.contains("Chatgpt"));
        for secret in ["quarterly-planning-secret", "also-secret", "customer-invoice.pdf", "title", "xdgDescription"] {
            assert!(!rendered.contains(secret), "a sample must never carry {secret}");
        }
    }
}
