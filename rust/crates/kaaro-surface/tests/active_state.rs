//! Port of `test/active-state.test.mjs` (key cases).
use kaaro_surface::{
    apply_pulse, snapshot_active, snapshot_active_with, ActiveState, ActiveThresholds,
    DEFAULT_THRESHOLDS, RECENT_ACTIONS_MAX,
};
use serde_json::json;

const T0: i64 = 1_750_000_000_000;

fn pulse(event: &str, data: serde_json::Value) -> serde_json::Value {
    let mut d = json!({
        "session_id": "aaaabbbb-1111-2222-3333-444455556666",
        "slug": "aaaabbbb",
        "harness": "claude-code",
        "project": "kaaroSessions",
        "ts": null,
    });
    if let (Some(base), Some(extra)) = (d.as_object_mut(), data.as_object()) {
        for (k, v) in extra {
            base.insert(k.clone(), v.clone());
        }
    }
    json!({"event": event, "data": d})
}

#[test]
fn empty_snapshot() {
    let mut state = ActiveState::new();
    let snap = snapshot_active(&mut state, T0);
    assert!(snap.sessions.is_empty());
    assert_eq!(snap.totals.sessions, 0);
}

#[test]
fn tool_call_creates_entry() {
    let mut state = ActiveState::new();
    apply_pulse(
        &mut state,
        &pulse("tool_call", json!({"tool": "Read", "key": "read", "where": "D:/x/a.mjs", "why": null})),
        T0,
    );
    let snap = snapshot_active(&mut state, T0);
    assert_eq!(snap.sessions.len(), 1);
    let s = &snap.sessions[0];
    assert_eq!(s["slug"], "aaaabbbb");
    assert_eq!(s["tool_calls"], 1);
    assert_eq!(s["last_event"], "tool_call");
    assert_eq!(s["last_tool"]["tool"], "Read");
    assert_eq!(s["last_tool"]["ts"], T0);
}

#[test]
fn tokens_and_burn_rate() {
    let mut state = ActiveState::new();
    apply_pulse(
        &mut state,
        &pulse("tokens", json!({"input": 100, "output": 50, "cache_create": 200, "cache_read": 1000})),
        T0,
    );
    apply_pulse(
        &mut state,
        &pulse("tokens", json!({"input": 10, "output": 5, "cache_create": 20, "cache_read": 100})),
        T0 + 1000,
    );
    let s = &snapshot_active(&mut state, T0 + 1000).sessions[0];
    assert_eq!(s["tokens"]["input"], 110);
    assert_eq!(s["tokens_work"], 275);

    let mut state = ActiveState::new();
    apply_pulse(
        &mut state,
        &pulse("tokens", json!({"input": 0, "output": 100, "cache_create": 0, "cache_read": 0})),
        T0,
    );
    apply_pulse(
        &mut state,
        &pulse("tokens", json!({"input": 0, "output": 200, "cache_create": 0, "cache_read": 0})),
        T0 + 30_000,
    );
    assert_eq!(
        snapshot_active(&mut state, T0 + 30_000).sessions[0]["burn_rate_per_min"],
        300
    );
    assert_eq!(
        snapshot_active(&mut state, T0 + 70_000).sessions[0]["burn_rate_per_min"],
        200
    );
    assert_eq!(
        snapshot_active(&mut state, T0 + 200_000).sessions[0]["burn_rate_per_min"],
        0
    );
}

#[test]
fn status_active_idle_evict() {
    let mut state = ActiveState::new();
    apply_pulse(
        &mut state,
        &pulse("tool_call", json!({"tool": "Read", "key": "read", "where": "a", "why": null})),
        T0,
    );
    assert_eq!(
        snapshot_active(&mut state, T0 + DEFAULT_THRESHOLDS.active_ms - 1).sessions[0]["status"],
        "active"
    );
    assert_eq!(
        snapshot_active(&mut state, T0 + DEFAULT_THRESHOLDS.active_ms + 1).sessions[0]["status"],
        "idle"
    );
    let gone = snapshot_active(&mut state, T0 + DEFAULT_THRESHOLDS.evict_ms + 1);
    assert!(gone.sessions.is_empty());
}

#[test]
fn multi_session_by_harness() {
    let mut state = ActiveState::new();
    apply_pulse(
        &mut state,
        &pulse("tool_call", json!({"tool": "Read", "key": "read", "where": "a", "why": null})),
        T0,
    );
    apply_pulse(
        &mut state,
        &pulse(
            "tool_call",
            json!({
                "session_id": "ses_4a89582bbffe03xj4Y14Qtss1q", "slug": "ses_4a89",
                "harness": "opencode", "project": "bun-ai-minecraft",
                "tool": "glob", "key": "grep_glob", "where": null, "why": null
            }),
        ),
        T0 + 10_000,
    );
    let snap = snapshot_active(&mut state, T0 + 11_000);
    assert_eq!(snap.sessions.len(), 2);
    assert_eq!(snap.sessions[0]["harness"], "opencode");
    assert_eq!(snap.by_harness["opencode"]["sessions"], 1);
}

#[test]
fn ignores_missing_session_id() {
    let mut state = ActiveState::new();
    apply_pulse(&mut state, &json!({"event": "tool_call", "data": {"tool": "Read"}}), T0);
    apply_pulse(&mut state, &json!({"event": "status", "data": "rebuilding"}), T0);
    assert!(snapshot_active(&mut state, T0).sessions.is_empty());
}

#[test]
fn recent_actions_ring_capped() {
    let mut state = ActiveState::new();
    let base = json!({"session_id": "s1", "slug": "s1slug", "harness": "claude-code", "project": "p"});
    for i in 0..60 {
        let mut data = base.clone();
        data.as_object_mut().unwrap().insert("tool".into(), json!("Read"));
        data.as_object_mut()
            .unwrap()
            .insert("where".into(), json!(format!("f{i}.mjs")));
        apply_pulse(
            &mut state,
            &json!({"event": "tool_call", "data": data}),
            1000 + i,
        );
    }
    let actions = snapshot_active(&mut state, 2000).sessions[0]["recent_actions"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(actions.len(), RECENT_ACTIONS_MAX);
    assert_eq!(actions.last().unwrap()["where"], "f59.mjs");
    assert_eq!(actions[0]["where"], "f10.mjs");
}

#[test]
fn permission_mode_api_error() {
    let mut state = ActiveState::new();
    apply_pulse(
        &mut state,
        &json!({"event": "permission", "data": {
            "session_id": "s3", "slug": "s3slug", "harness": "claude-code", "project": "p",
            "mode": "acceptEdits"
        }}),
        1,
    );
    apply_pulse(
        &mut state,
        &json!({"event": "mode_shift", "data": {
            "session_id": "s3", "slug": "s3slug", "harness": "claude-code", "project": "p",
            "mode": "plan"
        }}),
        2,
    );
    apply_pulse(
        &mut state,
        &json!({"event": "api_error", "data": {
            "session_id": "s3", "slug": "s3slug", "harness": "claude-code", "project": "p",
            "message": "quota exceeded", "code": "rate_limit"
        }}),
        3,
    );
    let s = &snapshot_active(&mut state, 10).sessions[0];
    assert_eq!(s["last_permission_mode"], "acceptEdits");
    assert_eq!(s["last_mode"], "plan");
    assert_eq!(s["api_errors"], 1);
    assert_eq!(s["last_api_error"]["message"], "quota exceeded");
}

#[test]
fn threshold_override() {
    let mut state = ActiveState::new();
    apply_pulse(
        &mut state,
        &pulse("tool_call", json!({"tool": "Read", "key": "read", "where": "a", "why": null})),
        T0,
    );
    let th = ActiveThresholds {
        active_ms: 1000,
        evict_ms: DEFAULT_THRESHOLDS.evict_ms,
        burn_window_ms: DEFAULT_THRESHOLDS.burn_window_ms,
    };
    let snap = snapshot_active_with(&mut state, T0 + 5000, &th);
    assert_eq!(snap.sessions[0]["status"], "idle");
}
