//! Embedded golden session fixtures — dump of `hooks/adapters/golden-sessions.mjs`.

use serde_json::{Map, Value};
use std::sync::OnceLock;

static GOLDENS: OnceLock<Map<String, Value>> = OnceLock::new();

/// Raw golden records keyed by harness id.
pub fn golden_sessions() -> &'static Map<String, Value> {
    GOLDENS.get_or_init(|| {
        let raw = include_str!("../fixtures/golden-sessions.json");
        serde_json::from_str::<Map<String, Value>>(raw).unwrap_or_default()
    })
}

/// Golden records for one harness (empty if missing).
pub fn golden_for(harness_id: &str) -> Vec<Value> {
    golden_sessions()
        .get(harness_id)
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}
