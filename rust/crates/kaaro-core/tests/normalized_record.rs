//! Parity tests vs `/workspace/kaaroSessions/test/normalized-record.test.mjs`.
use kaaro_core::normalized_record::{
    is_normalized_record, record_kinds, validate_normalized_record, KIND_COUNT,
};
use serde_json::json;

#[test]
fn record_kinds_contains_expected_kinds() {
    let kinds = record_kinds();
    for k in [
        "user_turn",
        "assistant_turn",
        "tool_use",
        "tool_result",
        "tokens",
        "skill_invoke",
        "context_reset",
        "session_meta",
        "permission_mode",
        "branch_change",
    ] {
        assert!(kinds.contains(&k), "missing kind: {k}");
    }
}

#[test]
fn record_kinds_contains_adapter_emitted_kinds() {
    let kinds = record_kinds();
    for k in [
        "content_block",
        "mode_shift",
        "attachment",
        "scaffold",
        "unknown_record",
        "api_error",
    ] {
        assert!(kinds.contains(&k), "missing kind: {k}");
    }
}

#[test]
fn kind_count_matches_js_contract() {
    // JS KIND_FIELDS has 16 entries (see hooks/normalized-record.mjs).
    assert_eq!(record_kinds().len(), KIND_COUNT);
    assert_eq!(KIND_COUNT, 16);
}

#[test]
fn is_normalized_record_valid() {
    assert!(is_normalized_record(&json!({
        "kind": "tool_use",
        "ts": "2026-05-01T10:00:00.000Z",
        "harness": "claude-code",
        "tool": "Read",
    })));
}

#[test]
fn is_normalized_record_accepts_real_adapter_kinds() {
    assert!(is_normalized_record(
        &json!({"kind": "content_block", "harness": "claude-code", "block_type": "text"})
    ));
    assert!(is_normalized_record(
        &json!({"kind": "scaffold", "harness": "antigravity"})
    ));
    assert!(is_normalized_record(
        &json!({"kind": "unknown_record", "harness": "pi"})
    ));
}

#[test]
fn is_normalized_record_rejects_invalid() {
    assert!(!is_normalized_record(&json!(null)));
    assert!(!is_normalized_record(&json!({"kind": "bogus"})));
    assert!(!is_normalized_record(&json!({"kind": "user_turn"})));
}

#[test]
fn validate_valid_records_per_kind_pass() {
    let valid = [
        json!({"kind": "user_turn", "harness": "claude-code", "ts": "t", "text": "hello world"}),
        json!({"kind": "user_turn", "harness": "claude-code", "ts": null, "text": null}),
        json!({"kind": "assistant_turn", "harness": "claude-code", "ts": "t", "model": "m", "stop_reason": "end_turn"}),
        json!({"kind": "assistant_turn", "harness": "grok", "ts": "t", "content_length": 240}),
        json!({"kind": "tool_use", "harness": "claude-code", "ts": "t", "tool": "Bash", "category": "git", "input": {"command": "git status"}}),
        json!({"kind": "tool_use", "harness": "pi", "ts": "t", "tool": "read", "category": null}),
        json!({"kind": "tool_result", "harness": "claude-code", "ts": "t", "tool": "Bash", "error": true}),
        json!({"kind": "tool_result", "harness": "opencode", "ts": "t"}),
        json!({"kind": "tokens", "harness": "claude-code", "ts": "t", "tokens": {"input": 1, "output": 2, "cache_create": 0, "cache_read": 3}}),
        json!({"kind": "skill_invoke", "harness": "claude-code", "ts": "t", "skill": "code-review"}),
        json!({"kind": "context_reset", "harness": "claude-code", "ts": "t"}),
        json!({"kind": "session_meta", "harness": "claude-code", "ts": "t", "ai_title": "A title"}),
        json!({"kind": "session_meta", "harness": "copilot", "ts": null}),
        json!({"kind": "permission_mode", "harness": "claude-code", "ts": "t", "mode": "acceptEdits"}),
        json!({"kind": "branch_change", "harness": "claude-code", "ts": "t", "branch": "main"}),
        json!({"kind": "content_block", "harness": "claude-code", "ts": "t", "block_type": "text", "text": "ok"}),
        json!({"kind": "content_block", "harness": "claude-code", "ts": "t", "block_type": "thinking"}),
        json!({"kind": "mode_shift", "harness": "claude-code", "ts": "t", "mode": "plan"}),
        json!({"kind": "attachment", "harness": "claude-code", "ts": "t", "subtype": "file"}),
        json!({"kind": "scaffold", "harness": "antigravity", "ts": "t", "content_preview": "reminder"}),
        json!({"kind": "unknown_record", "harness": "pi", "ts": "t", "raw_type": "weird"}),
        json!({"kind": "api_error", "harness": "claude-code", "ts": "t", "message": "quota exceeded", "code": "rate_limit"}),
        json!({"kind": "api_error", "harness": "grok", "ts": "t", "message": "auth failed"}),
    ];
    for rec in &valid {
        let r = validate_normalized_record(rec);
        assert!(
            r.ok,
            "{}: {}",
            rec["kind"],
            r.errors.join("; ")
        );
        assert!(r.errors.is_empty());
    }
}

#[test]
fn validate_unknown_kind_fails() {
    let r = validate_normalized_record(&json!({"kind": "bogus", "harness": "x"}));
    assert!(!r.ok);
    assert!(r.errors.iter().any(|e| e.contains("kind")));
}

#[test]
fn validate_missing_harness_fails() {
    let r = validate_normalized_record(&json!({"kind": "context_reset", "ts": "t"}));
    assert!(!r.ok);
    assert!(r.errors.iter().any(|e| e.contains("harness")));
}

#[test]
fn validate_missing_required_field_fails() {
    assert!(!validate_normalized_record(&json!({"kind": "tool_use", "harness": "x", "ts": "t"})).ok);
    assert!(!validate_normalized_record(&json!({"kind": "tokens", "harness": "x", "ts": "t"})).ok);
    assert!(!validate_normalized_record(&json!({"kind": "skill_invoke", "harness": "x", "ts": "t"})).ok);
    assert!(!validate_normalized_record(&json!({"kind": "branch_change", "harness": "x", "ts": "t"})).ok);
    assert!(!validate_normalized_record(&json!({"kind": "content_block", "harness": "x", "ts": "t"})).ok);
    assert!(!validate_normalized_record(&json!({"kind": "api_error", "harness": "x", "ts": "t"})).ok);
}

#[test]
fn validate_wrong_field_types_fail() {
    assert!(!validate_normalized_record(&json!({
        "kind": "tool_use", "harness": "x", "ts": "t", "tool": 42
    }))
    .ok);
    assert!(!validate_normalized_record(&json!({
        "kind": "tokens", "harness": "x", "ts": "t",
        "tokens": {"input": "a", "output": 0, "cache_create": 0, "cache_read": 0}
    }))
    .ok);
    assert!(!validate_normalized_record(&json!({
        "kind": "user_turn", "harness": "x", "ts": "t", "text": 99
    }))
    .ok);
    assert!(!validate_normalized_record(&json!({
        "kind": "tool_result", "harness": "x", "ts": "t", "error": "yes"
    }))
    .ok);
}

#[test]
fn validate_ts_must_be_string_number_or_null() {
    assert!(validate_normalized_record(&json!({"kind": "context_reset", "harness": "x", "ts": "t"})).ok);
    assert!(validate_normalized_record(&json!({"kind": "context_reset", "harness": "x", "ts": 123})).ok);
    assert!(validate_normalized_record(&json!({"kind": "context_reset", "harness": "x", "ts": null})).ok);
    assert!(validate_normalized_record(&json!({"kind": "context_reset", "harness": "x"})).ok);
    assert!(!validate_normalized_record(&json!({"kind": "context_reset", "harness": "x", "ts": {}})).ok);
}
