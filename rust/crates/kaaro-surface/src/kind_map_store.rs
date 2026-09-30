//! Live golden overlay — port of `surface/kind-map-store.mjs`.

use kaaro_core::{apply_kind_map_pulse, build_kind_map, BuildKindMapOpts};
use serde_json::Value;

/// Mutable kind-map payload store (baseline + pulse overlay).
pub struct KindMapStore {
    payload: Value,
    baseline_fn: Box<dyn Fn() -> Value + Send + Sync>,
}

impl KindMapStore {
    pub fn new() -> Self {
        Self::with_baseline(|| {
            build_kind_map(BuildKindMapOpts {
                generated_at: Some("baseline".into()),
                ..Default::default()
            })
        })
    }

    pub fn with_baseline<F>(f: F) -> Self
    where
        F: Fn() -> Value + Send + Sync + 'static,
    {
        let payload = f();
        Self {
            payload,
            baseline_fn: Box::new(f),
        }
    }

    pub fn apply_pulse(&mut self, event: &str, data: &Value) {
        if event.is_empty() {
            return;
        }
        self.payload = apply_kind_map_pulse(&self.payload, event, data);
    }

    pub fn snapshot(&self) -> Value {
        self.payload.clone()
    }

    pub fn reset(&mut self) {
        self.payload = (self.baseline_fn)();
    }
}

impl Default for KindMapStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pulses_accumulate_on_baseline() {
        let mut store = KindMapStore::with_baseline(|| {
            build_kind_map(BuildKindMapOpts {
                generated_at: Some("t".into()),
                ..Default::default()
            })
        });
        let before = store.snapshot();
        let hi = before["harnesses"]
            .as_array()
            .unwrap()
            .iter()
            .position(|h| h["id"] == "claude-code")
            .unwrap();
        store.apply_pulse(
            "tool_call",
            &json!({
                "harness": "claude-code",
                "nr_kind": "tool_use",
                "tool": "WeirdTool",
                "key": "other",
            }),
        );
        let after = store.snapshot();
        let tool_use = after["kinds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|k| k["id"] == "tool_use")
            .unwrap();
        assert_eq!(tool_use["emit"][hi], 1);
        assert!(tool_use["proof"][hi]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "pulse"));
        let other = after["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["key"] == "other")
            .unwrap();
        assert!(other["by_harness"]["claude-code"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t == "WeirdTool"));
    }
}
