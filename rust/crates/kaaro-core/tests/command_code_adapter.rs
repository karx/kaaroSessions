//! Parity vs `test/adapters/command-code.test.mjs`.
use kaaro_core::adapters::command_code::records_to_normalized;
use kaaro_core::enrich_session::enrich_session;
use kaaro_core::normalized_record::{is_normalized_record, validate_normalized_record};
use kaaro_core::session_reducer::{reduce_session, Capabilities, SessionMeta};
use serde_json::json;

#[test]
fn reasoning_maps_to_thinking_block() {
    let nrs = records_to_normalized(&[json!({
        "id": "a1", "timestamp": "t1", "sessionId": "s1", "parentId": null,
        "role": "assistant", "gitBranch": "main",
        "content": [
            { "type": "reasoning", "text": "planning the edit" },
            { "type": "text", "text": "I will open the file." },
            { "type": "tool-call", "toolCallId": "c1", "toolName": "read_file",
              "input": { "absolutePath": "/a.mjs" } }
        ]
    })]);
    let blocks: Vec<_> = nrs.iter().filter(|r| r["kind"] == "content_block").collect();
    assert!(blocks.iter().any(|b| b["block_type"] == "thinking"));
    assert!(!blocks.iter().any(|b| b["block_type"] == "reasoning"));
    assert!(blocks.iter().any(|b| b["block_type"] == "tool_use"));
    assert!(!blocks.iter().any(|b| b["block_type"] == "tool-call"));
    assert!(blocks.iter().any(|b| b["block_type"] == "text"
        && b["text"].as_str().unwrap().contains("open the file")));
    for rec in &nrs {
        assert!(is_normalized_record(rec));
        let v = validate_normalized_record(rec);
        assert!(v.ok, "{}: {}", rec["kind"], v.errors.join("; "));
    }
}

#[test]
fn hybrid_user_keeps_display_text() {
    let nrs = records_to_normalized(&[json!({
        "id": "u2", "timestamp": "t4", "sessionId": "s1", "parentId": "t1",
        "role": "user", "gitBranch": "feat/auth",
        "content": [
            { "type": "text", "text": "Also add test coverage please" },
            { "type": "tool-result", "toolCallId": "call_1", "toolName": "read_file",
              "output": { "type": "text", "value": "ok" } }
        ]
    })]);
    let ut = nrs.iter().find(|r| r["kind"] == "user_turn").unwrap();
    assert_eq!(ut["display_text"], "Also add test coverage please");
    assert!(nrs.iter().any(|r| r["kind"] == "tool_result" && r["tool_id"] == "call_1"));
}

#[test]
fn tool_result_only_user_no_display_text() {
    let nrs = records_to_normalized(&[json!({
        "id": "u3", "timestamp": "t5", "sessionId": "s1", "parentId": "a1",
        "role": "user", "gitBranch": "main",
        "content": [
            { "type": "tool-result", "toolCallId": "c2", "toolName": "shell_command",
              "output": { "type": "text", "value": "done" } }
        ]
    })]);
    let ut = nrs.iter().find(|r| r["kind"] == "user_turn").unwrap();
    assert!(ut["display_text"].is_null());
}

#[test]
fn reduce_enrich_smoke() {
    let nrs = records_to_normalized(&[
        json!({
            "id": "u1", "timestamp": "2026-06-01T10:00:00.000Z", "role": "user", "gitBranch": "main",
            "content": [{ "type": "text", "text": "please land the command-code port now" }]
        }),
        json!({
            "id": "a1", "timestamp": "2026-06-01T10:00:01.000Z", "role": "assistant", "gitBranch": "main",
            "content": [
                { "type": "text", "text": "ok" },
                { "type": "tool-call", "toolCallId": "c1", "toolName": "read_file",
                  "input": { "file_path": "src/a.mjs" } }
            ]
        }),
    ]);
    let meta = SessionMeta {
        session_id: "s1".into(),
        project_id: "users-x-src-demo".into(),
        project_label: "demo".into(),
        harness: "command-code".into(),
        file_size_bytes: 10,
        capabilities: Some(Capabilities {
            size_proxy: Some("tool_calls".into()),
        }),
    };
    let mut session = reduce_session(&nrs, &meta);
    enrich_session(&mut session);
    assert_eq!(session.harness, "command-code");
    assert_eq!(session.user_turns, 1);
    assert!(session.tool_calls >= 1);
}
