//! Pure Kind Map payload + live overlay — port of `hooks/kind-map.mjs`.

use crate::pulse_map::{kind_pulse_entry, kind_routes, route_id_from_nr, route_id_from_pulse};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

pub const UNKNOWN_BUCKET_MAX: usize = 80;

const LIFECYCLE: &[&str] = &["connected", "now", "status", "updated", "error"];

fn nrs_of(bucket: Option<&Value>) -> (Vec<Value>, Vec<Value>) {
    let Some(bucket) = bucket else {
        return (vec![], vec![]);
    };
    if let Some(arr) = bucket.as_array() {
        return (arr.clone(), vec![]);
    }
    let golden = bucket
        .get("golden")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let sample = bucket
        .get("sample")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    (golden, sample)
}

fn kind_expected(id: &str, caps: &Value) -> bool {
    if id == "unknown_record" {
        return false;
    }
    if id == "tokens" {
        return caps.get("tokens").and_then(|v| v.as_bool()) != Some(false);
    }
    if id == "context_reset" {
        return caps.get("context_resets").and_then(|v| v.as_bool()) != Some(false);
    }
    if id == "branch_change" {
        return caps.get("branches").and_then(|v| v.as_bool()) != Some(false);
    }
    true
}

fn kind_role(id: &str, pulse_event: &str) -> &'static str {
    if id == "unknown_record" {
        return "catchall";
    }
    if pulse_event == "unknown" {
        return "alarm";
    }
    "emit"
}

fn empty_proof(n: usize) -> Vec<Vec<String>> {
    (0..n).map(|_| Vec::new()).collect()
}

fn proof_for(
    seen_by_source: &HashMap<String, (HashSet<String>, HashSet<String>)>,
    id: &str,
    harness_ids: &[&str],
) -> Vec<Vec<String>> {
    harness_ids
        .iter()
        .map(|hid| {
            let (g, s) = seen_by_source
                .get(*hid)
                .cloned()
                .unwrap_or_else(|| (HashSet::new(), HashSet::new()));
            let mut p = Vec::new();
            if g.contains(id) {
                p.push("golden".into());
            }
            if s.contains(id) {
                p.push("sample".into());
            }
            p
        })
        .collect()
}

/// Slim coverage-hole record from a Stream pulse. Null if not an unknown.
pub fn unknown_from_pulse(event: &str, data: &Value) -> Option<Value> {
    if event != "unknown" {
        return None;
    }
    let has_harness = data
        .get("harness")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let has_nr = data.get("nr_kind").and_then(|v| v.as_str()).is_some();
    if !has_harness && !has_nr {
        return None;
    }
    Some(json!({
        "harness": data.get("harness").cloned().unwrap_or(Value::Null),
        "nr_kind": data.get("nr_kind").cloned().unwrap_or(Value::Null),
        "raw_type": data.get("raw_type").cloned().unwrap_or(Value::Null),
        "block_type": data.get("block_type").cloned().unwrap_or(Value::Null),
        "slug": data.get("slug").cloned().unwrap_or(Value::Null),
        "project": data.get("project").cloned().unwrap_or(Value::Null),
        "session_id": data.get("session_id").cloned().unwrap_or(Value::Null),
        "ts": data.get("ts").cloned().unwrap_or(Value::Null),
    }))
}

pub fn unknown_key(u: &Value) -> String {
    format!(
        "{}|{}|{}|{}",
        u.get("harness").and_then(|v| v.as_str()).unwrap_or(""),
        u.get("nr_kind").and_then(|v| v.as_str()).unwrap_or(""),
        u.get("raw_type")
            .map(|v| match v {
                Value::Null => "".into(),
                other => other.to_string().trim_matches('"').to_string(),
            })
            .unwrap_or_default(),
        u.get("block_type")
            .map(|v| match v {
                Value::Null => "".into(),
                other => other.to_string().trim_matches('"').to_string(),
            })
            .unwrap_or_default(),
    )
}

/// Distinct-signature bucket, newest first. Immutable.
pub fn add_unknown(list: &[Value], entry: &Value, max: usize) -> Vec<Value> {
    let key = unknown_key(entry);
    let mut cur = list.to_vec();
    if let Some(i) = cur.iter().position(|x| x.get("key").and_then(|k| k.as_str()) == Some(&key)) {
        let prev = cur.remove(i);
        let count = prev.get("count").and_then(|c| c.as_u64()).unwrap_or(1) + 1;
        cur.insert(
            0,
            json!({
                "key": key,
                "harness": prev.get("harness").cloned().unwrap_or(Value::Null),
                "nr_kind": prev.get("nr_kind").cloned().unwrap_or(Value::Null),
                "raw_type": prev.get("raw_type").cloned().unwrap_or(Value::Null),
                "block_type": prev.get("block_type").cloned().unwrap_or(Value::Null),
                "count": count,
                "last_ts": entry.get("ts").cloned().unwrap_or_else(|| prev.get("last_ts").cloned().unwrap_or(Value::Null)),
                "slug": entry.get("slug").cloned().or_else(|| prev.get("slug").cloned()).unwrap_or(Value::Null),
                "project": entry.get("project").cloned().or_else(|| prev.get("project").cloned()).unwrap_or(Value::Null),
                "session_id": entry.get("session_id").cloned().or_else(|| prev.get("session_id").cloned()).unwrap_or(Value::Null),
                "source": prev.get("source").cloned().unwrap_or(json!("pulse")),
            }),
        );
    } else {
        cur.insert(
            0,
            json!({
                "key": key,
                "harness": entry.get("harness").cloned().unwrap_or(Value::Null),
                "nr_kind": entry.get("nr_kind").cloned().unwrap_or(Value::Null),
                "raw_type": entry.get("raw_type").cloned().unwrap_or(Value::Null),
                "block_type": entry.get("block_type").cloned().unwrap_or(Value::Null),
                "count": 1,
                "last_ts": entry.get("ts").cloned().unwrap_or(Value::Null),
                "slug": entry.get("slug").cloned().unwrap_or(Value::Null),
                "project": entry.get("project").cloned().unwrap_or(Value::Null),
                "session_id": entry.get("session_id").cloned().unwrap_or(Value::Null),
                "source": entry.get("source").cloned().unwrap_or(json!("pulse")),
            }),
        );
    }
    if cur.len() > max {
        cur.truncate(max);
    }
    cur
}

fn tool_name_to_key_fn(name: Option<&str>, category: Option<&str>) -> String {
    crate::action_keys::tool_name_to_key(name, category).to_string()
}

/// Build the Kind Map JSON payload (pure).
pub fn build_kind_map_payload(
    harnesses: &[Value],
    kinds: &[&str],
    traces: &Map<String, Value>,
    tool_keys: &[&str],
    generated_at: Option<&str>,
) -> Value {
    let harness_ids: Vec<&str> = harnesses
        .iter()
        .filter_map(|h| h.get("id").and_then(|v| v.as_str()))
        .collect();

    let mut kinds_seen: HashMap<String, (HashSet<String>, HashSet<String>)> = HashMap::new();
    let mut routes_seen: HashMap<String, (HashSet<String>, HashSet<String>)> = HashMap::new();
    let mut tools_seen: HashMap<String, HashMap<String, Vec<String>>> = HashMap::new();

    for h in harnesses {
        let hid = h.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let (golden, sample) = nrs_of(traces.get(hid));
        let mut g_kinds = HashSet::new();
        let mut s_kinds = HashSet::new();
        let mut g_routes = HashSet::new();
        let mut s_routes = HashSet::new();
        let mut tools: HashMap<String, Vec<String>> = HashMap::new();

        for (source_name, nrs) in [("golden", &golden), ("sample", &sample)] {
            for nr in nrs {
                let kind = nr.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                if source_name == "golden" {
                    g_kinds.insert(kind.to_string());
                } else {
                    s_kinds.insert(kind.to_string());
                }
                if let Some(rid) = route_id_from_nr(nr, None) {
                    let key = format!("{kind}:{rid}");
                    if source_name == "golden" {
                        g_routes.insert(key);
                    } else {
                        s_routes.insert(key);
                    }
                }
                if kind != "tool_use" {
                    continue;
                }
                let Some(tool) = nr.get("tool").and_then(|v| v.as_str()) else {
                    continue;
                };
                let cat = nr.get("category").and_then(|v| v.as_str());
                let key = tool_name_to_key_fn(Some(tool), cat);
                let list = tools.entry(key).or_default();
                if !list.iter().any(|t| t == tool) {
                    list.push(tool.to_string());
                }
            }
        }
        kinds_seen.insert(hid.to_string(), (g_kinds, s_kinds));
        routes_seen.insert(hid.to_string(), (g_routes, s_routes));
        tools_seen.insert(hid.to_string(), tools);
    }

    let kind_rows: Vec<Value> = kinds
        .iter()
        .map(|id| {
            let (pulse_event, reason) = kind_pulse_entry(id).unwrap_or(("unknown", None));
            let proof = proof_for(&kinds_seen, id, &harness_ids);
            let role = kind_role(id, pulse_event);
            let expect: Vec<i64> = harnesses
                .iter()
                .map(|h| {
                    let caps = h.get("capabilities").cloned().unwrap_or(json!({}));
                    if kind_expected(id, &caps) {
                        1
                    } else {
                        0
                    }
                })
                .collect();
            let emit: Vec<i64> = proof.iter().map(|p| if p.is_empty() { 0 } else { 1 }).collect();
            let mut row = json!({
                "id": id,
                "pulse": pulse_event,
                "reason": reason,
                "lane": if pulse_event == "silent" { "snapshot" } else { "stream" },
                "role": role,
                "expect": expect,
                "emit": emit,
                "proof": proof,
            });
            let route_specs = kind_routes(id);
            if !route_specs.is_empty() {
                let routes: Vec<Value> = route_specs
                    .iter()
                    .map(|rs| {
                        let rid = format!("{id}:{}", rs.id);
                        let r_proof = proof_for(&routes_seen, &rid, &harness_ids);
                        let r_emit: Vec<i64> =
                            r_proof.iter().map(|p| if p.is_empty() { 0 } else { 1 }).collect();
                        let r_expect: Vec<i64> = harnesses
                            .iter()
                            .map(|_| if rs.role == "alarm" { 0 } else { 1 })
                            .collect();
                        json!({
                            "id": rs.id,
                            "pulse": rs.pulse,
                            "reason": rs.reason,
                            "role": rs.role,
                            "expect": r_expect,
                            "emit": r_emit,
                            "proof": r_proof,
                        })
                    })
                    .collect();
                row.as_object_mut()
                    .unwrap()
                    .insert("routes".into(), Value::Array(routes));
            }
            row
        })
        .collect();

    let tool_rows: Vec<Value> = tool_keys
        .iter()
        .map(|key| {
            let mut by_harness = Map::new();
            for hid in &harness_ids {
                let tools = tools_seen
                    .get(*hid)
                    .and_then(|m| m.get(*key))
                    .cloned()
                    .unwrap_or_default();
                by_harness.insert((*hid).to_string(), json!(tools));
            }
            json!({
                "key": key,
                "role": if *key == "other" { "catchall" } else { "emit" },
                "by_harness": by_harness,
            })
        })
        .collect();

    let harness_out: Vec<Value> = harnesses
        .iter()
        .map(|h| {
            json!({
                "id": h.get("id"),
                "label": h.get("label"),
                "capabilities": h.get("capabilities").cloned().unwrap_or(json!({})),
                "detected": h.get("detected").and_then(|v| v.as_bool()).unwrap_or(false),
                "verified": h.get("verified").and_then(|v| v.as_bool()).unwrap_or(false),
            })
        })
        .collect();

    json!({
        "generated_at": generated_at,
        "harnesses": harness_out,
        "kinds": kind_rows,
        "tools": tool_rows,
        "unknowns": [],
    })
}

/// Map a Stream pulse event to a RECORD_KIND, or null for lifecycle / unstamped.
pub fn kind_from_pulse(event: &str, data: &Value) -> Option<String> {
    if event.is_empty() || LIFECYCLE.contains(&event) {
        return None;
    }
    data.get("nr_kind")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn with_pulse_proof(row: &Value, hi: usize, n_harnesses: usize) -> Value {
    let mut emit = row
        .get("emit")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_else(|| vec![json!(0); n_harnesses]);
    while emit.len() < n_harnesses {
        emit.push(json!(0));
    }
    emit[hi] = json!(1);
    let mut proof = if let Some(arr) = row.get("proof").and_then(|v| v.as_array()) {
        if arr.len() == n_harnesses {
            arr.iter()
                .map(|p| {
                    p.as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default()
                })
                .collect()
        } else {
            empty_proof(n_harnesses)
        }
    } else {
        empty_proof(n_harnesses)
    };
    if !proof[hi].iter().any(|s| s == "pulse") {
        proof[hi].push("pulse".into());
    }
    let mut next = row.clone();
    if let Some(obj) = next.as_object_mut() {
        obj.insert("emit".into(), Value::Array(emit));
        obj.insert(
            "proof".into(),
            Value::Array(proof.into_iter().map(|p| json!(p)).collect()),
        );
    }
    next
}

/// Overlay one Stream pulse onto a kind-map payload. Immutable.
pub fn apply_kind_map_pulse(payload: &Value, event: &str, data: &Value) -> Value {
    if payload.is_null() {
        return payload.clone();
    }
    let harness = data.get("harness").and_then(|v| v.as_str()).unwrap_or("");
    if harness.is_empty() {
        return payload.clone();
    }
    let harnesses = payload
        .get("harnesses")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let hi = harnesses
        .iter()
        .position(|h| h.get("id").and_then(|v| v.as_str()) == Some(harness));
    let hole = unknown_from_pulse(event, data);
    if hi.is_none() && hole.is_none() {
        return payload.clone();
    }
    let kind_id = kind_from_pulse(event, data);
    if kind_id.is_none() && hole.is_none() {
        return payload.clone();
    }
    let n_h = harnesses.len();
    let mut changed = false;
    let mut unknowns = payload
        .get("unknowns")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if let Some(hole) = &hole {
        let mut entry = hole.clone();
        if let Some(obj) = entry.as_object_mut() {
            obj.insert("source".into(), json!("pulse"));
        }
        unknowns = add_unknown(&unknowns, &entry, UNKNOWN_BUCKET_MAX);
        changed = true;
    }
    let Some(hi) = hi else {
        if changed {
            let mut out = payload.clone();
            if let Some(obj) = out.as_object_mut() {
                obj.insert("unknowns".into(), Value::Array(unknowns));
            }
            return out;
        }
        return payload.clone();
    };

    let mut harnesses_out = harnesses.clone();
    if kind_id.is_some()
        && !harnesses_out[hi]
            .get("verified")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    {
        changed = true;
        if let Some(obj) = harnesses_out[hi].as_object_mut() {
            obj.insert("verified".into(), json!(true));
        }
    }

    let route_id = route_id_from_pulse(event, data);
    let mut kinds = payload
        .get("kinds")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if let Some(kind_id) = &kind_id {
        if let Some(ki) = kinds.iter().position(|row| row.get("id").and_then(|v| v.as_str()) == Some(kind_id))
        {
            let row = kinds[ki].clone();
            let mut next = row.clone();
            let already = row
                .get("emit")
                .and_then(|v| v.as_array())
                .and_then(|a| a.get(hi))
                .and_then(|v| v.as_i64())
                == Some(1)
                && row
                    .get("proof")
                    .and_then(|v| v.as_array())
                    .and_then(|a| a.get(hi))
                    .and_then(|v| v.as_array())
                    .map(|p| p.iter().any(|x| x.as_str() == Some("pulse")))
                    .unwrap_or(false);
            if !already {
                next = with_pulse_proof(&row, hi, n_h);
            }
            if let Some(rid) = route_id {
                if let Some(routes) = next.get("routes").and_then(|v| v.as_array()) {
                    if let Some(ri) = routes
                        .iter()
                        .position(|rt| rt.get("id").and_then(|v| v.as_str()) == Some(rid))
                    {
                        let rt = &routes[ri];
                        let r_already = rt
                            .get("emit")
                            .and_then(|v| v.as_array())
                            .and_then(|a| a.get(hi))
                            .and_then(|v| v.as_i64())
                            == Some(1)
                            && rt
                                .get("proof")
                                .and_then(|v| v.as_array())
                                .and_then(|a| a.get(hi))
                                .and_then(|v| v.as_array())
                                .map(|p| p.iter().any(|x| x.as_str() == Some("pulse")))
                                .unwrap_or(false);
                        if !r_already {
                            let mut routes_new = routes.clone();
                            routes_new[ri] = with_pulse_proof(rt, hi, n_h);
                            if let Some(obj) = next.as_object_mut() {
                                obj.insert("routes".into(), Value::Array(routes_new));
                            }
                        }
                    }
                }
            }
            if next != row {
                changed = true;
                kinds[ki] = next;
            }
        }
    }

    let mut tools = payload
        .get("tools")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if kind_id.is_some() && event == "tool_call" {
        let tool = data.get("tool").and_then(|v| v.as_str());
        let key = data.get("key").and_then(|v| v.as_str());
        if let (Some(tool), Some(key)) = (tool, key) {
            if let Some(ti) = tools
                .iter()
                .position(|t| t.get("key").and_then(|v| v.as_str()) == Some(key))
            {
                let t = tools[ti].clone();
                let cur = t
                    .pointer(&format!("/by_harness/{harness}"))
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                if !cur.iter().any(|x| x.as_str() == Some(tool)) {
                    changed = true;
                    let mut cur = cur;
                    cur.push(json!(tool));
                    let mut next = t;
                    if let Some(obj) = next.as_object_mut() {
                        let mut by = obj
                            .get("by_harness")
                            .and_then(|v| v.as_object())
                            .cloned()
                            .unwrap_or_default();
                        by.insert(harness.to_string(), Value::Array(cur));
                        obj.insert("by_harness".into(), Value::Object(by));
                    }
                    tools[ti] = next;
                }
            }
        }
    }

    if !changed {
        return payload.clone();
    }
    let mut out = payload.clone();
    if let Some(obj) = out.as_object_mut() {
        obj.insert("harnesses".into(), Value::Array(harnesses_out));
        obj.insert("kinds".into(), Value::Array(kinds));
        obj.insert("tools".into(), Value::Array(tools));
        obj.insert("unknowns".into(), Value::Array(unknowns));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::action_keys::TOOL_ACTION_KEYS;
    use crate::normalized_record::record_kinds;
    use serde_json::json;

    fn harness(id: &str, caps: Value) -> Value {
        json!({
            "id": id,
            "label": id,
            "capabilities": caps,
            "detected": false,
            "verified": false,
        })
    }

    #[test]
    fn build_kinds_1_to_1_emit_from_traces() {
        let kinds = record_kinds();
        let harnesses = vec![harness("h1", json!({"tokens": true, "context_resets": true, "branches": true}))];
        let mut traces = Map::new();
        traces.insert(
            "h1".into(),
            json!({
                "golden": [
                    {"kind": "user_turn"},
                    {"kind": "tool_use", "tool": "Read"},
                ],
                "sample": []
            }),
        );
        let payload = build_kind_map_payload(&harnesses, &kinds, &traces, TOOL_ACTION_KEYS, Some("t0"));
        assert_eq!(payload["kinds"].as_array().unwrap().len(), kinds.len());
        let user = payload["kinds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|k| k["id"] == "user_turn")
            .unwrap();
        assert_eq!(user["emit"][0], 1);
        assert_eq!(user["proof"][0][0], "golden");
        let tokens = payload["kinds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|k| k["id"] == "tokens")
            .unwrap();
        assert_eq!(tokens["emit"][0], 0);
    }

    #[test]
    fn tools_grouped_by_canonical_key() {
        let kinds = record_kinds();
        let harnesses = vec![harness("h1", json!({}))];
        let mut traces = Map::new();
        traces.insert(
            "h1".into(),
            json!({
                "golden": [
                    {"kind": "tool_use", "tool": "Read"},
                    {"kind": "tool_use", "tool": "Bash", "category": "git"},
                ],
                "sample": []
            }),
        );
        let payload = build_kind_map_payload(&harnesses, &kinds, &traces, TOOL_ACTION_KEYS, None);
        let read = payload["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["key"] == "read")
            .unwrap();
        assert_eq!(read["by_harness"]["h1"][0], "Read");
        let bash = payload["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["key"] == "bash_git")
            .unwrap();
        assert_eq!(bash["by_harness"]["h1"][0], "Bash");
    }

    #[test]
    fn tokens_false_is_expected_empty() {
        let kinds = record_kinds();
        let harnesses = vec![harness("h1", json!({"tokens": false}))];
        let traces = Map::new();
        let payload = build_kind_map_payload(&harnesses, &kinds, &traces, TOOL_ACTION_KEYS, None);
        let tokens = payload["kinds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|k| k["id"] == "tokens")
            .unwrap();
        assert_eq!(tokens["expect"][0], 0);
    }

    #[test]
    fn content_block_routes_from_disposition() {
        let kinds = record_kinds();
        let harnesses = vec![harness("h1", json!({}))];
        let mut traces = Map::new();
        traces.insert(
            "h1".into(),
            json!({
                "golden": [
                    {"kind": "content_block", "block_type": "thinking"},
                    {"kind": "content_block", "block_type": "text", "text": "one two three"},
                    {"kind": "content_block", "block_type": "weird"},
                ],
                "sample": []
            }),
        );
        let payload = build_kind_map_payload(&harnesses, &kinds, &traces, TOOL_ACTION_KEYS, None);
        let cb = payload["kinds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|k| k["id"] == "content_block")
            .unwrap();
        let routes = cb["routes"].as_array().unwrap();
        let thinking = routes.iter().find(|r| r["id"] == "thinking").unwrap();
        assert_eq!(thinking["emit"][0], 1);
        let words = routes.iter().find(|r| r["id"] == "words").unwrap();
        assert_eq!(words["emit"][0], 1);
        let alarm = routes.iter().find(|r| r["id"] == "unknown-block").unwrap();
        assert_eq!(alarm["emit"][0], 1);
        assert_eq!(alarm["role"], "alarm");
        assert_eq!(alarm["expect"][0], 0);
    }

    #[test]
    fn apply_pulse_lights_content_block_words() {
        let kinds = record_kinds();
        let harnesses = vec![harness("h1", json!({}))];
        let traces = Map::new();
        let baseline = build_kind_map_payload(&harnesses, &kinds, &traces, TOOL_ACTION_KEYS, None);
        let next = apply_kind_map_pulse(
            &baseline,
            "words",
            &json!({"harness": "h1", "nr_kind": "content_block"}),
        );
        let cb = next["kinds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|k| k["id"] == "content_block")
            .unwrap();
        assert_eq!(cb["emit"][0], 1);
        assert!(cb["proof"][0]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "pulse"));
        let words = cb["routes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == "words")
            .unwrap();
        assert_eq!(words["emit"][0], 1);
    }

    #[test]
    fn unknown_bucket_from_live_pulse() {
        let kinds = record_kinds();
        let harnesses = vec![harness("h1", json!({}))];
        let traces = Map::new();
        let baseline = build_kind_map_payload(&harnesses, &kinds, &traces, TOOL_ACTION_KEYS, None);
        let next = apply_kind_map_pulse(
            &baseline,
            "unknown",
            &json!({"harness": "h1", "nr_kind": "unknown_record", "raw_type": "weird"}),
        );
        assert_eq!(next["unknowns"].as_array().unwrap().len(), 1);
        assert_eq!(next["unknowns"][0]["raw_type"], "weird");
    }

    #[test]
    fn kind_from_pulse_requires_nr_kind() {
        assert!(kind_from_pulse("tool_call", &json!({})).is_none());
        assert_eq!(
            kind_from_pulse("tool_call", &json!({"nr_kind": "tool_use"})).as_deref(),
            Some("tool_use")
        );
        assert!(kind_from_pulse("connected", &json!({"nr_kind": "x"})).is_none());
    }
}
