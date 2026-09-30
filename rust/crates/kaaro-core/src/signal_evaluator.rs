//! Session-scoped policy evaluation — port of `hooks/signal-evaluator.mjs`
//! (W-POL-02/03, W-REP-02).
//!
//! Pure: (session, policy, now_iso) → signals. No I/O / Date.now inside.

use serde_json::{json, Map, Value};

fn pred_skill(sess: &Value, v: &Value) -> bool {
    let Some(want) = v.as_str() else {
        return false;
    };
    sess.get("skills")
        .and_then(|s| s.as_array())
        .map(|arr| arr.iter().any(|x| x.as_str() == Some(want)))
        .unwrap_or(false)
}

fn pred_tool(sess: &Value, v: &Value) -> bool {
    let Some(want) = v.as_str() else {
        return false;
    };
    match sess.pointer(&format!("/tools/{want}")) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) != 0.0,
        Some(Value::Object(_)) | Some(Value::Array(_)) | Some(Value::String(_)) => true,
    }
}

fn num_field(sess: &Value, key: &str) -> f64 {
    sess.get(key)
        .and_then(|v| v.as_f64().or_else(|| v.as_i64().map(|i| i as f64)))
        .unwrap_or(0.0)
}

fn pred_num_gt(sess: &Value, key: &str, v: &Value) -> bool {
    let threshold = v.as_f64().or_else(|| v.as_i64().map(|i| i as f64)).unwrap_or(0.0);
    num_field(sess, key) > threshold
}

fn pred_num_lt(sess: &Value, key: &str, v: &Value) -> bool {
    let threshold = v.as_f64().or_else(|| v.as_i64().map(|i| i as f64)).unwrap_or(0.0);
    num_field(sess, key) < threshold
}

fn pred_project(sess: &Value, v: &Value) -> bool {
    sess.get("project_label").and_then(|p| p.as_str()) == v.as_str()
}

fn pred_tools_contains(sess: &Value, tool: &Value, match_obj: &Value) -> bool {
    let Some(skill) = match_obj.get("skill").and_then(|s| s.as_str()) else {
        return false;
    };
    let Some(tool_name) = tool.as_str() else {
        return false;
    };
    let n = sess
        .pointer(&format!("/skill_attribution/{skill}/tools/{tool_name}"))
        .cloned();
    match n {
        Some(Value::Number(num)) => num.as_f64().unwrap_or(0.0) > 0.0,
        Some(Value::Bool(b)) => b,
        Some(Value::Null) | None => false,
        Some(_) => true,
    }
}

fn predicate_holds(key: &str, sess: &Value, v: &Value, match_obj: &Value) -> Option<bool> {
    Some(match key {
        "skill" => pred_skill(sess, v),
        "tool" => pred_tool(sess, v),
        "tool_errors.gt" => pred_num_gt(sess, "tool_errors", v),
        "cache_hit_rate.lt" => pred_num_lt(sess, "cache_hit_rate", v),
        "duration_min.gt" => pred_num_gt(sess, "duration_min", v),
        "project" => pred_project(sess, v),
        "compact_count.gt" => pred_num_gt(sess, "context_resets", v),
        "tools.contains" => pred_tools_contains(sess, v, match_obj),
        _ => return None,
    })
}

fn make_signal(sess: &Value, rule: &Value, now_iso: &str, context: Value) -> Value {
    json!({
        "ts": now_iso,
        "session_id": sess.get("session_id").cloned().unwrap_or(Value::Null),
        "project_id": sess.get("project_id").cloned().unwrap_or(Value::Null),
        "project_label": sess.get("project_label").cloned().unwrap_or(Value::Null),
        "session_ts": sess.get("first_timestamp").cloned().unwrap_or(Value::Null),
        "rule_id": rule.get("id").cloned().unwrap_or(Value::Null),
        "signal": rule.get("signal").cloned().unwrap_or(Value::Null),
        "reason": rule.get("reason").cloned().unwrap_or(Value::Null),
        "context": context,
    })
}

fn make_diagnostic(sess: &Value, rule: &Value, now_iso: &str, reason: &str, context: Value) -> Value {
    let mut sig = make_signal(sess, rule, now_iso, context);
    if let Some(obj) = sig.as_object_mut() {
        let rid = rule
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        obj.insert("rule_id".into(), json!(format!("diagnostic:{rid}")));
        obj.insert("signal".into(), json!("INFO"));
        obj.insert("reason".into(), json!(reason));
    }
    sig
}

/// Evaluate one session against `policy.rules`. Returns signals (possibly empty).
pub fn evaluate_session(sess: &Value, policy: Option<&Value>, now_iso: &str) -> Vec<Value> {
    let mut signals = Vec::new();
    let Some(rules) = policy
        .and_then(|p| p.get("rules"))
        .and_then(|r| r.as_array())
    else {
        return signals;
    };

    for rule in rules {
        let match_obj = rule.get("match").cloned().unwrap_or(json!({}));
        let match_map = match_obj.as_object().cloned().unwrap_or_default();

        if match_map.contains_key("tools.contains") {
            let attr = sess.get("skill_attribution");
            if attr.is_none() || attr == Some(&Value::Null) {
                let rid = rule.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                signals.push(make_diagnostic(
                    sess,
                    rule,
                    now_iso,
                    &format!(
                        "tools.contains requires skill_attribution — rule \"{rid}\" skipped (attribution data absent)"
                    ),
                    json!({ "predicate": "tools.contains" }),
                ));
                continue;
            }
            let has_skill = match_map
                .get("skill")
                .and_then(|v| v.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            if !has_skill {
                let rid = rule.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                signals.push(make_diagnostic(
                    sess,
                    rule,
                    now_iso,
                    &format!(
                        "tools.contains requires companion \"skill\" in match — rule \"{rid}\" skipped"
                    ),
                    json!({ "predicate": "tools.contains" }),
                ));
                continue;
            }
        }

        let unsupported = match_map.keys().find(|k| predicate_holds(k, sess, &Value::Null, &match_obj).is_none());
        if let Some(unsupported) = unsupported {
            let rid = rule.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            signals.push(make_diagnostic(
                sess,
                rule,
                now_iso,
                &format!("unsupported predicate \"{unsupported}\" — rule \"{rid}\" skipped"),
                json!({ "predicate": unsupported }),
            ));
            continue;
        }

        let holds = match_map.iter().all(|(k, v)| {
            predicate_holds(k, sess, v, &match_obj).unwrap_or(false)
        });
        if holds {
            signals.push(make_signal(sess, rule, now_iso, match_obj));
            break; // first matching rule wins
        }
    }

    signals
}

/// Empty W-REP-02 payload (no policy / absent file).
pub fn empty_signals_data(now_iso: Option<&str>) -> Value {
    json!({
        "generated_at": now_iso,
        "total_signals": 0,
        "by_level": {},
        "by_rule": {},
        "signals": [],
    })
}

/// Evaluate all sessions → signals-data.json payload (W-REP-02).
/// Diagnostic signals (`diagnostic:…`) are deduped per rule_id.
pub fn build_signals_data(sessions: &[Value], policy: Option<&Value>, now_iso: &str) -> Value {
    let mut signals = Vec::new();
    let mut seen_diagnostics = std::collections::HashSet::new();

    for sess in sessions {
        for sig in evaluate_session(sess, policy, now_iso) {
            let rid = sig
                .get("rule_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if rid.starts_with("diagnostic:") {
                if seen_diagnostics.contains(rid) {
                    continue;
                }
                seen_diagnostics.insert(rid.to_string());
            }
            signals.push(sig);
        }
    }

    let mut by_level = Map::new();
    let mut by_rule = Map::new();
    for sig in &signals {
        if let Some(level) = sig.get("signal").and_then(|v| v.as_str()) {
            let cur = by_level.get(level).and_then(|v| v.as_u64()).unwrap_or(0);
            by_level.insert(level.to_string(), json!(cur + 1));
        }
        if let Some(rid) = sig.get("rule_id").and_then(|v| v.as_str()) {
            let cur = by_rule.get(rid).and_then(|v| v.as_u64()).unwrap_or(0);
            by_rule.insert(rid.to_string(), json!(cur + 1));
        }
    }

    json!({
        "generated_at": now_iso,
        "total_signals": signals.len(),
        "by_level": by_level,
        "by_rule": by_rule,
        "signals": signals,
    })
}

/// Build signals from Session structs (serialize each to Value).
pub fn build_signals_data_from_sessions(
    sessions: &[crate::session_reducer::Session],
    policy: Option<&Value>,
    now_iso: &str,
) -> Value {
    let values: Vec<Value> = sessions
        .iter()
        .filter_map(|s| serde_json::to_value(s).ok())
        .collect();
    build_signals_data(&values, policy, now_iso)
}

/// Current UTC ISO-8601 timestamp (millis precision), matching `Date.toISOString()`.
pub fn now_iso_utc() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let millis = dur.subsec_millis();
    // Civil date from unix days (same approach as rebuild.rs)
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400) as u32;
    let (y, m, d) = civil_from_days(days);
    let hh = tod / 3600;
    let mm = (tod % 3600) / 60;
    let ss = tod % 60;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    // Howard Hinnant algorithms
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-07-19T12:00:00.000Z";

    fn make_sess(overrides: Value) -> Value {
        let mut base = json!({
            "session_id": "abc12345-0000-0000-0000-000000000000",
            "project_id": "D--src-kaaroSkills",
            "project_label": "kaaroSkills",
            "first_timestamp": "2026-07-18T09:00:00.000Z",
            "tokens": { "input": 10, "output": 20, "cache_create": 5, "cache_read": 0 },
            "tools": {
                "Read": { "calls": 5, "errors": 0 },
                "Bash": { "calls": 3, "errors": 1 }
            },
            "skills": ["visualize-seed"],
            "tool_calls": 8,
            "tool_errors": 1,
            "cache_hit_rate": 12,
            "duration_min": 42,
            "context_resets": 1,
        });
        if let (Some(b), Some(o)) = (base.as_object_mut(), overrides.as_object()) {
            for (k, v) in o {
                b.insert(k.clone(), v.clone());
            }
        }
        base
    }

    fn rule(overrides: Value) -> Value {
        let mut r = json!({
            "id": "r1",
            "match": { "skill": "visualize-seed" },
            "signal": "WARN",
            "reason": "test rule"
        });
        if let (Some(base), Some(o)) = (r.as_object_mut(), overrides.as_object()) {
            for (k, v) in o {
                base.insert(k.clone(), v.clone());
            }
        }
        r
    }

    #[test]
    fn skill_predicate() {
        let sigs = evaluate_session(
            &make_sess(json!({})),
            Some(&json!({ "rules": [rule(json!({}))] })),
            NOW,
        );
        assert_eq!(sigs.len(), 1);
        assert_eq!(sigs[0]["rule_id"], "r1");
        assert_eq!(sigs[0]["signal"], "WARN");
    }

    #[test]
    fn tool_predicate() {
        let r = rule(json!({ "match": { "tool": "Bash" } }));
        assert_eq!(
            evaluate_session(&make_sess(json!({})), Some(&json!({ "rules": [r] })), NOW).len(),
            1
        );
        let r2 = rule(json!({ "match": { "tool": "WebFetch" } }));
        assert_eq!(
            evaluate_session(&make_sess(json!({})), Some(&json!({ "rules": [r2] })), NOW).len(),
            0
        );
    }

    #[test]
    fn numeric_predicates() {
        let cases: Vec<(Value, usize)> = vec![
            (json!({ "tool_errors.gt": 0 }), 1),
            (json!({ "tool_errors.gt": 5 }), 0),
            (json!({ "cache_hit_rate.lt": 20 }), 1),
            (json!({ "cache_hit_rate.lt": 5 }), 0),
            (json!({ "duration_min.gt": 30 }), 1),
            (json!({ "duration_min.gt": 60 }), 0),
            (json!({ "compact_count.gt": 0 }), 1),
            (json!({ "compact_count.gt": 3 }), 0),
        ];
        for (match_obj, expected) in cases {
            let sigs = evaluate_session(
                &make_sess(json!({})),
                Some(&json!({ "rules": [rule(json!({ "match": match_obj }))] })),
                NOW,
            );
            assert_eq!(sigs.len(), expected);
        }
    }

    #[test]
    fn project_and_and() {
        let r = rule(json!({ "match": { "project": "kaaroSkills" } }));
        assert_eq!(
            evaluate_session(&make_sess(json!({})), Some(&json!({ "rules": [r] })), NOW).len(),
            1
        );
        let r2 = rule(json!({ "match": { "skill": "visualize-seed", "tool": "WebFetch" } }));
        assert_eq!(
            evaluate_session(&make_sess(json!({})), Some(&json!({ "rules": [r2] })), NOW).len(),
            0
        );
    }

    #[test]
    fn first_matching_wins() {
        let rules = json!([
            { "id": "first", "match": { "tool": "Read" }, "signal": "INFO", "reason": "a" },
            { "id": "second", "match": { "tool": "Bash" }, "signal": "ALERT", "reason": "b" },
        ]);
        let sigs = evaluate_session(&make_sess(json!({})), Some(&json!({ "rules": rules })), NOW);
        assert_eq!(sigs.len(), 1);
        assert_eq!(sigs[0]["rule_id"], "first");
    }

    #[test]
    fn unsupported_predicate_diagnostic() {
        let rules = json!([
            { "id": "intent-rule", "match": { "intent": "refactor" }, "signal": "WARN", "reason": "x" },
            { "id": "fallback", "match": { "tool": "Bash" }, "signal": "WARN", "reason": "y" },
        ]);
        let sigs = evaluate_session(&make_sess(json!({})), Some(&json!({ "rules": rules })), NOW);
        assert_eq!(sigs.len(), 2);
        assert_eq!(sigs[0]["rule_id"], "diagnostic:intent-rule");
        assert_eq!(sigs[0]["signal"], "INFO");
        assert!(sigs[0]["reason"].as_str().unwrap().contains("intent"));
        assert_eq!(sigs[1]["rule_id"], "fallback");
    }

    #[test]
    fn tools_contains_match() {
        let sess = make_sess(json!({
            "skill_attribution": {
                "visualize-seed": { "tool_calls": 3, "tools": { "Read": 2, "Bash": 1 }, "errors": 0 }
            }
        }));
        let r = rule(json!({
            "id": "no-bash-in-viz",
            "match": { "skill": "visualize-seed", "tools.contains": "Bash" },
            "signal": "WARN",
            "reason": "visualize-seed should not use Bash"
        }));
        let sigs = evaluate_session(&sess, Some(&json!({ "rules": [r] })), NOW);
        assert_eq!(sigs.len(), 1);
        assert_eq!(sigs[0]["rule_id"], "no-bash-in-viz");
        assert_eq!(sigs[0]["context"]["tools.contains"], "Bash");
    }

    #[test]
    fn tools_contains_false_when_unused() {
        let sess = make_sess(json!({
            "skill_attribution": {
                "visualize-seed": { "tool_calls": 2, "tools": { "Read": 2 }, "errors": 0 }
            }
        }));
        let r = rule(json!({
            "match": { "skill": "visualize-seed", "tools.contains": "Bash" }
        }));
        assert_eq!(
            evaluate_session(&sess, Some(&json!({ "rules": [r] })), NOW).len(),
            0
        );
    }

    #[test]
    fn tools_contains_absent_attribution_diagnostic() {
        let mut sess = make_sess(json!({}));
        sess.as_object_mut().unwrap().remove("skill_attribution");
        let r = rule(json!({
            "id": "attr-rule",
            "match": { "skill": "visualize-seed", "tools.contains": "Bash" }
        }));
        let sigs = evaluate_session(&sess, Some(&json!({ "rules": [r] })), NOW);
        assert_eq!(sigs.len(), 1);
        assert_eq!(sigs[0]["rule_id"], "diagnostic:attr-rule");
        assert_eq!(sigs[0]["signal"], "INFO");
    }

    #[test]
    fn tools_contains_empty_attribution_is_non_match() {
        let sess = make_sess(json!({ "skill_attribution": {} }));
        let r = rule(json!({
            "id": "attr-rule",
            "match": { "skill": "visualize-seed", "tools.contains": "Bash" }
        }));
        assert_eq!(
            evaluate_session(&sess, Some(&json!({ "rules": [r] })), NOW).len(),
            0
        );
    }

    #[test]
    fn tools_contains_without_skill_companion() {
        let sess = make_sess(json!({
            "skill_attribution": {
                "visualize-seed": { "tool_calls": 1, "tools": { "Bash": 1 }, "errors": 0 }
            }
        }));
        let r = rule(json!({
            "id": "bare",
            "match": { "tools.contains": "Bash" }
        }));
        let sigs = evaluate_session(&sess, Some(&json!({ "rules": [r] })), NOW);
        assert_eq!(sigs.len(), 1);
        assert_eq!(sigs[0]["rule_id"], "diagnostic:bare");
        assert!(sigs[0]["reason"].as_str().unwrap().to_lowercase().contains("skill"));
    }

    #[test]
    fn signal_shape() {
        let sigs = evaluate_session(
            &make_sess(json!({})),
            Some(&json!({ "rules": [rule(json!({}))] })),
            NOW,
        );
        assert_eq!(sigs.len(), 1);
        let sig = &sigs[0];
        assert_eq!(sig["ts"], NOW);
        assert_eq!(sig["session_id"], "abc12345-0000-0000-0000-000000000000");
        assert_eq!(sig["session_ts"], "2026-07-18T09:00:00.000Z");
        assert_eq!(sig["context"]["skill"], "visualize-seed");
    }

    #[test]
    fn build_aggregates() {
        let sessions = vec![
            make_sess(json!({})),
            make_sess(json!({ "session_id": "s2", "skills": [], "tool_errors": 9 })),
        ];
        let policy = json!({ "rules": [
            { "id": "skill-rule", "match": { "skill": "visualize-seed" }, "signal": "WARN", "reason": "a" },
            { "id": "errors", "match": { "tool_errors.gt": 5 }, "signal": "ALERT", "reason": "b" },
        ]});
        let data = build_signals_data(&sessions, Some(&policy), NOW);
        assert_eq!(data["generated_at"], NOW);
        assert_eq!(data["total_signals"], 2);
        assert_eq!(data["by_level"]["WARN"], 1);
        assert_eq!(data["by_level"]["ALERT"], 1);
        assert_eq!(data["by_rule"]["skill-rule"], 1);
        assert_eq!(data["by_rule"]["errors"], 1);
    }

    #[test]
    fn null_policy_empty() {
        let empty = build_signals_data(&[make_sess(json!({}))], None, NOW);
        assert_eq!(empty["total_signals"], 0);
        assert!(empty["signals"].as_array().unwrap().is_empty());
    }

    #[test]
    fn diagnostics_deduped() {
        let mut sessions = vec![
            make_sess(json!({ "session_id": "s1" })),
            make_sess(json!({ "session_id": "s2" })),
            make_sess(json!({ "session_id": "s3" })),
        ];
        for s in &mut sessions {
            s.as_object_mut().unwrap().remove("skill_attribution");
        }
        let policy = json!({ "rules": [
            { "id": "attr-rule", "match": { "skill": "visualize-seed", "tools.contains": "Bash" }, "signal": "WARN", "reason": "a" },
            { "id": "intent-rule", "match": { "intent": "x" }, "signal": "WARN", "reason": "b" },
        ]});
        let data = build_signals_data(&sessions, Some(&policy), NOW);
        let diags: Vec<_> = data["signals"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| {
                s["rule_id"]
                    .as_str()
                    .unwrap_or("")
                    .starts_with("diagnostic:")
            })
            .collect();
        assert_eq!(diags.len(), 2);
        assert_eq!(data["by_rule"]["diagnostic:attr-rule"], 1);
        assert_eq!(data["by_rule"]["diagnostic:intent-rule"], 1);
    }

    #[test]
    fn real_matches_not_deduped() {
        let sessions = vec![
            make_sess(json!({
                "session_id": "s1",
                "skill_attribution": {
                    "visualize-seed": { "tool_calls": 1, "tools": { "Bash": 1 }, "errors": 0 }
                }
            })),
            make_sess(json!({
                "session_id": "s2",
                "skill_attribution": {
                    "visualize-seed": { "tool_calls": 1, "tools": { "Bash": 1 }, "errors": 0 }
                }
            })),
        ];
        let policy = json!({ "rules": [{
            "id": "no-bash",
            "match": { "skill": "visualize-seed", "tools.contains": "Bash" },
            "signal": "WARN",
            "reason": "x"
        }]});
        let data = build_signals_data(&sessions, Some(&policy), NOW);
        assert_eq!(data["total_signals"], 2);
        assert_eq!(data["by_rule"]["no-bash"], 2);
    }
}
