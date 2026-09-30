//! Compose traces → Kind Map payload — port of `surface/kind-map-build.mjs`.

use crate::action_keys::TOOL_ACTION_KEYS;
use crate::golden_sessions::golden_for;
use crate::kind_map::build_kind_map_payload;
use crate::normalized_record::record_kinds;
use crate::registry::{harness_registry, HarnessDescriptor};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::Path;

/// Local presence: detected = harness root exists; verified = detected AND sessions for harness.
pub fn local_harness_flags(
    registry: &[HarnessDescriptor],
    exists: &dyn Fn(&Path) -> bool,
    sessions: &[Value],
    roots: &dyn Fn(&str) -> Option<std::path::PathBuf>,
) -> Map<String, Value> {
    let seen: HashSet<String> = sessions
        .iter()
        .filter_map(|s| s.get("harness").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();
    let mut flags = Map::new();
    for h in registry {
        let detected = roots(h.id)
            .map(|p| exists(&p))
            .unwrap_or(false);
        flags.insert(
            h.id.to_string(),
            json!({
                "detected": detected,
                "verified": detected && seen.contains(h.id),
            }),
        );
    }
    flags
}

fn adapt(adapter: crate::registry::AdapterFn, records: &[Value]) -> Vec<Value> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| adapter(records))) {
        Ok(out) => out,
        Err(_) => Vec::new(),
    }
}

/// Gather golden (+ optional sample) NR traces per harness.
pub fn gather_kind_map_traces(
    registry: &[HarnessDescriptor],
    event_types: Option<&Map<String, Value>>,
) -> Map<String, Value> {
    let mut traces = Map::new();
    for h in registry {
        let mut golden = Vec::new();
        let mut sample = Vec::new();
        let golden_recs = golden_for(h.id);
        if !golden_recs.is_empty() {
            golden.extend(adapt(h.adapter, &golden_recs));
        }
        if let Some(ets) = event_types {
            for entry in ets.values() {
                if let Some(rec) = entry
                    .pointer(&format!("/samples/{}", h.id))
                    .and_then(|s| s.get("record"))
                {
                    sample.extend(adapt(h.adapter, &[rec.clone()]));
                }
            }
        }
        traces.insert(h.id.to_string(), json!({ "golden": golden, "sample": sample }));
    }
    traces
}

fn caps_json(h: &HarnessDescriptor) -> Value {
    json!({
        "tokens": h.capabilities.tokens,
        "pulse": h.capabilities.pulse,
        "trace": h.capabilities.trace,
        "context_resets": h.capabilities.context_resets,
        "ai_title": h.capabilities.ai_title,
        "subagent_count": h.capabilities.subagent_count,
        "branches": h.capabilities.branches,
        "size_proxy": h.capabilities.size_proxy,
    })
}

/// Build kind-map payload from registry + goldens (+ optional local flags / traces).
pub fn build_kind_map(opts: BuildKindMapOpts<'_>) -> Value {
    let registry_fallback;
    let registry: &[HarnessDescriptor] = match &opts.registry {
        Some(r) => r.as_slice(),
        None => {
            registry_fallback = harness_registry();
            registry_fallback.as_slice()
        }
    };
    let flags = opts.local_flags.clone().unwrap_or_default();
    let harnesses: Vec<Value> = registry
        .iter()
        .map(|h| {
            let f = flags.get(h.id);
            json!({
                "id": h.id,
                "label": h.label,
                "capabilities": caps_json(h),
                "detected": f.and_then(|v| v.get("detected")).and_then(|v| v.as_bool()).unwrap_or(false),
                "verified": f.and_then(|v| v.get("verified")).and_then(|v| v.as_bool()).unwrap_or(false),
            })
        })
        .collect();
    let traces = match &opts.traces {
        Some(t) => t.clone(),
        None => gather_kind_map_traces(registry, opts.event_types),
    };
    let kinds = opts.kinds.unwrap_or_else(record_kinds);
    let tool_keys = opts.tool_keys.unwrap_or(TOOL_ACTION_KEYS);
    let generated_at = opts.generated_at.unwrap_or_else(|| {
        // ISO-ish UTC; box clock is Asia/Calcutta but JS uses Date.toISOString (UTC).
        use std::time::{SystemTime, UNIX_EPOCH};
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        // Keep a stable-ish format without chrono dep: epoch millis string is fine for tests;
        // prefer RFC3339-ish via simple formatting if available — use null when not needed.
        format!("{ms}")
    });
    build_kind_map_payload(
        &harnesses,
        &kinds,
        &traces,
        tool_keys,
        Some(&generated_at),
    )
}

#[derive(Default)]
pub struct BuildKindMapOpts<'a> {
    pub registry: Option<Vec<HarnessDescriptor>>,
    pub local_flags: Option<Map<String, Value>>,
    pub traces: Option<Map<String, Value>>,
    pub event_types: Option<&'a Map<String, Value>>,
    pub kinds: Option<Vec<&'static str>>,
    pub tool_keys: Option<&'static [&'static str]>,
    pub generated_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::HARNESS_IDS;

    #[test]
    fn gather_every_registry_harness_has_golden_sample_arrays() {
        let reg = harness_registry();
        let traces = gather_kind_map_traces(&reg, None);
        for id in HARNESS_IDS {
            let t = traces.get(*id).expect("harness present");
            assert!(t.get("golden").and_then(|v| v.as_array()).is_some());
            assert!(t.get("sample").and_then(|v| v.as_array()).is_some());
        }
    }

    #[test]
    fn build_kind_map_claude_code_emits_tool_use() {
        let payload = build_kind_map(BuildKindMapOpts {
            generated_at: Some("test".into()),
            ..Default::default()
        });
        assert_eq!(payload["harnesses"].as_array().unwrap().len(), 8);
        let kinds = payload["kinds"].as_array().unwrap();
        assert_eq!(kinds.len(), crate::normalized_record::KIND_COUNT);
        let cc_idx = payload["harnesses"]
            .as_array()
            .unwrap()
            .iter()
            .position(|h| h["id"] == "claude-code")
            .unwrap();
        let tool_use = kinds.iter().find(|k| k["id"] == "tool_use").unwrap();
        assert_eq!(tool_use["emit"][cc_idx], 1);
    }
}
