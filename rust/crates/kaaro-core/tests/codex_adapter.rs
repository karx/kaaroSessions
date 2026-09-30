//! Parity tests vs `test/adapters/codex.test.mjs`.
use kaaro_core::adapters::codex::records_to_normalized;
use kaaro_core::enrich_session::enrich_session;
use kaaro_core::normalized_record::{is_normalized_record, validate_normalized_record};
use kaaro_core::session_reducer::{reduce_session, Capabilities, SessionMeta};
use serde_json::json;

fn kinds(nrs: &[serde_json::Value]) -> Vec<&str> {
    nrs.iter()
        .filter_map(|r| r.get("kind").and_then(|k| k.as_str()))
        .collect()
}

#[test]
fn maps_messages_tools_results_and_token_counts() {
    let nrs = records_to_normalized(&[
        json!({
            "timestamp": "2026-08-21T19:00:00.000Z",
            "type": "session_meta",
            "payload": {
                "id": "01abc",
                "cwd": "/Users/vinayakarora/Documents/GitHub/kaaroSessions",
                "cli_version": "0.148.0-alpha.9",
                "git": { "branch": "main" }
            }
        }),
        json!({
            "timestamp": "2026-08-21T19:00:01.000Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "Please make the sessions easier to hear" }]
            }
        }),
        json!({
            "timestamp": "2026-08-21T19:00:02.000Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "I will inspect the audio path." }]
            }
        }),
        json!({
            "timestamp": "2026-08-21T19:00:03.000Z",
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "call_id": "call_1",
                "arguments": "{\"cmd\":\"node --test\",\"workdir\":\"/tmp/app\"}"
            }
        }),
        json!({
            "timestamp": "2026-08-21T19:00:04.000Z",
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": "call_1",
                "output": "Process exited with code 1\nError: boom"
            }
        }),
        json!({
            "timestamp": "2026-08-21T19:00:05.000Z",
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {
                        "input_tokens": 10,
                        "output_tokens": 4,
                        "cached_input_tokens": 2,
                        "cache_write_input_tokens": 1
                    }
                }
            }
        }),
    ]);

    assert!(nrs.iter().any(|r| r["kind"] == "session_meta"
        && r["cwd"].as_str().unwrap().ends_with("kaaroSessions")));
    assert!(nrs.iter().any(|r| r["kind"] == "user_turn"
        && r["text"] == "Please make the sessions easier to hear"));
    assert!(nrs.iter().any(|r| r["kind"] == "assistant_turn" && r["model"].is_null()));
    assert!(nrs.iter().any(|r| r["kind"] == "content_block"
        && r["block_type"] == "text"
        && r["text"].as_str().unwrap().contains("audio path")));
    assert!(nrs.iter().any(|r| r["kind"] == "tool_use"
        && r["tool"] == "exec_command"
        && r["input"]["command"] == "node --test"));
    assert!(nrs.iter().any(|r| r["kind"] == "tool_result"
        && r["tool_id"] == "call_1"
        && r["error"] == true));
    assert!(nrs.iter().any(|r| r["kind"] == "tokens"
        && r["tokens"]["input"] == 0
        && r["tokens"]["output"] == 4
        && r["tokens"]["cache_read"] == 0));

    for rec in &nrs {
        assert!(is_normalized_record(rec), "{rec}");
        let v = validate_normalized_record(rec);
        assert!(v.ok, "{}: {}", rec["kind"], v.errors.join("; "));
    }
}

#[test]
fn ignores_cumulative_token_totals() {
    let nrs = records_to_normalized(&[json!({
        "timestamp": "2026-08-21T19:00:05.000Z",
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": {
                "total_token_usage": {
                    "input_tokens": 999999,
                    "output_tokens": 999999
                }
            }
        }
    })]);
    assert!(!kinds(&nrs).contains(&"tokens"));
}

#[test]
fn shell_command_categorized_as_git() {
    let nrs = records_to_normalized(&[json!({
        "timestamp": "2026-08-29T10:49:30.000Z",
        "type": "response_item",
        "payload": {
            "type": "function_call",
            "name": "shell_command",
            "call_id": "call_1",
            "arguments": "{\"command\":\"git status --short --branch\",\"workdir\":\"D:\\\\src\\\\x\"}"
        }
    })]);
    let tool_use = nrs.iter().find(|r| r["kind"] == "tool_use").unwrap();
    assert_eq!(tool_use["tool"], "shell_command");
    assert_eq!(tool_use["category"], "git");
}

#[test]
fn every_user_turn_gets_text() {
    let nrs = records_to_normalized(&[
        json!({
            "timestamp": "2026-08-29T10:49:21.000Z",
            "type": "response_item",
            "payload": { "type": "message", "role": "user",
                "content": [{ "type": "input_text", "text": "First prompt here" }] }
        }),
        json!({
            "timestamp": "2026-08-29T10:55:59.000Z",
            "type": "response_item",
            "payload": { "type": "message", "role": "user",
                "content": [{ "type": "input_text", "text": "Second prompt here too" }] }
        }),
    ]);
    let user_turns: Vec<_> = nrs.iter().filter(|r| r["kind"] == "user_turn").collect();
    assert_eq!(user_turns.len(), 2);
    assert_eq!(user_turns[0]["text"], "First prompt here");
    assert_eq!(user_turns[1]["text"], "Second prompt here too");
}

#[test]
fn no_double_emit_assistant_text() {
    let nrs = records_to_normalized(&[
        json!({
            "timestamp": "2026-08-29T10:00:00.000Z",
            "type": "event_msg",
            "payload": { "type": "agent_message", "message": "I will inspect the repo shape first." }
        }),
        json!({
            "timestamp": "2026-08-29T10:00:00.001Z",
            "type": "response_item",
            "payload": { "type": "message", "role": "assistant",
                "content": [{ "type": "output_text", "text": "I will inspect the repo shape first." }] }
        }),
    ]);
    let text_blocks: Vec<_> = nrs
        .iter()
        .filter(|r| r["kind"] == "content_block" && r["block_type"] == "text")
        .collect();
    assert_eq!(text_blocks.len(), 1);
}

#[test]
fn apply_patch_custom_tool_call() {
    let nrs = records_to_normalized(&[
        json!({
            "timestamp": "2026-08-29T10:00:00.000Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call", "status": "completed", "call_id": "call_1",
                "name": "apply_patch",
                "input": "*** Begin Patch\n*** Update File: src/app.mjs\n@@\n-old\n+new\n*** End Patch"
            }
        }),
        json!({
            "timestamp": "2026-08-29T10:00:01.000Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output", "call_id": "call_1",
                "output": "{\"output\":\"Success. Updated the following files:\\nM src/app.mjs\\n\",\"metadata\":{\"exit_code\":0}}"
            }
        }),
    ]);
    let tool_use = nrs.iter().find(|r| r["kind"] == "tool_use").unwrap();
    assert_eq!(tool_use["tool"], "apply_patch");
    assert_eq!(tool_use["tool_id"], "call_1");
    assert_eq!(tool_use["input"]["paths"], json!(["src/app.mjs"]));
    let tool_result = nrs.iter().find(|r| r["kind"] == "tool_result").unwrap();
    assert_eq!(tool_result["tool_id"], "call_1");
    assert_eq!(tool_result["error"], false);
}

#[test]
fn multi_file_apply_patch_paths() {
    let nrs = records_to_normalized(&[json!({
        "timestamp": "2026-08-29T10:00:00.000Z",
        "type": "response_item",
        "payload": {
            "type": "custom_tool_call", "status": "completed", "call_id": "call_2",
            "name": "apply_patch",
            "input": "*** Begin Patch\n*** Update File: a.mjs\n@@\n-x\n+y\n*** Add File: b.mjs\n+z\n*** End Patch"
        }
    })]);
    let tool_use = nrs.iter().find(|r| r["kind"] == "tool_use").unwrap();
    assert_eq!(tool_use["input"]["paths"], json!(["a.mjs", "b.mjs"]));
}

#[test]
fn failed_apply_patch_is_error() {
    let nrs = records_to_normalized(&[
        json!({
            "timestamp": "2026-08-29T10:00:00.000Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call", "status": "completed", "call_id": "call_3",
                "name": "apply_patch", "input": "*** Begin Patch\n*** End Patch"
            }
        }),
        json!({
            "timestamp": "2026-08-29T10:00:01.000Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output", "call_id": "call_3",
                "output": "{\"output\":\"Error: context mismatch\",\"metadata\":{\"exit_code\":1}}"
            }
        }),
    ]);
    let tool_result = nrs.iter().find(|r| r["kind"] == "tool_result").unwrap();
    assert_eq!(tool_result["error"], true);
}

#[test]
fn golden_reduce_enrich_smoke() {
    let nrs = records_to_normalized(&[
        json!({
            "timestamp": "2026-08-21T19:00:00.000Z",
            "type": "session_meta",
            "payload": { "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "cwd": "D:/src/demo", "git": { "branch": "main" } }
        }),
        json!({
            "timestamp": "2026-08-21T19:00:01.000Z",
            "type": "response_item",
            "payload": { "type": "message", "role": "user",
                "content": [{ "type": "input_text", "text": "please land the patch now" }] }
        }),
        json!({
            "timestamp": "2026-08-21T19:00:02.000Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call", "call_id": "c1", "name": "apply_patch",
                "input": "*** Begin Patch\n*** Update File: src/a.mjs\n@@\n-x\n+y\n*** End Patch"
            }
        }),
    ]);
    let meta = SessionMeta {
        session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into(),
        project_id: "D--src-demo".into(),
        project_label: "demo".into(),
        harness: "codex".into(),
        file_size_bytes: 100,
        capabilities: Some(Capabilities {
            size_proxy: Some("tokens_work".into()),
        }),
    };
    let mut session = reduce_session(&nrs, &meta);
    enrich_session(&mut session);
    assert_eq!(session.harness, "codex");
    assert_eq!(session.user_turns, 1);
    assert!(session.tool_calls >= 1);
    assert!(session.file_ops.contains_key("src/a.mjs") || !session.file_ops.is_empty());
}
