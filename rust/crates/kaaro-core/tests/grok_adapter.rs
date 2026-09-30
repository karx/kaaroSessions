//! Parity tests vs `test/adapters/grok.test.mjs`.
use kaaro_core::adapters::grok::records_to_normalized;
use kaaro_core::analyze::parse_grok_records;
use kaaro_core::enrich_session::enrich_session;
use kaaro_core::normalized_record::{is_normalized_record, validate_normalized_record};
use serde_json::json;

const SESSION_ID: &str = "019ea1c9-46ee-77e0-bf36-f87a6403b5db";
const ENCODED_CWD: &str = "D%3A%5Csrc%5CkaaroSessions";

fn golden_records() -> Vec<serde_json::Value> {
    vec![
        json!({
            "timestamp": 1780830790,
            "method": "session/update",
            "params": {
                "sessionId": SESSION_ID,
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": { "type": "text", "text": "Create a branch and build!" },
                    "_meta": { "modelId": "grok-composer-2.5-fast" }
                }
            },
            "_meta": { "agentTimestampMs": 1780831407026i64 }
        }),
        json!({
            "timestamp": 1780830790,
            "method": "session/update",
            "params": {
                "sessionId": SESSION_ID,
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call-test-composer_call_kLDxP",
                    "title": "Shell",
                    "rawInput": {
                        "command": "node --test",
                        "working_directory": "D:\\src\\kaaroSessions",
                        "description": "Run all unit tests"
                    }
                }
            },
            "_meta": { "agentTimestampMs": 1780830790407i64, "turnStartMs": 1780830788417i64 }
        }),
        json!({
            "timestamp": 1780830790,
            "method": "session/update",
            "params": {
                "sessionId": SESSION_ID,
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call-test-composer_call_by04n",
                    "title": "Read",
                    "rawInput": { "path": "D:\\src\\kaaroSessions\\TODO.md" }
                }
            },
            "_meta": { "agentTimestampMs": 1780830793529i64, "turnStartMs": 1780830788417i64 }
        }),
        json!({
            "timestamp": 1780831787,
            "method": "_x.ai/session/update",
            "params": {
                "sessionId": SESSION_ID,
                "update": { "sessionUpdate": "compaction_checkpoint", "checkpoint_id": "abc" }
            }
        }),
    ]
}

fn su(update: serde_json::Value, meta: serde_json::Value) -> serde_json::Value {
    json!({
        "timestamp": 1,
        "method": "session/update",
        "params": { "sessionId": "s", "update": update },
        "_meta": meta
    })
}

#[test]
fn emits_expected_kinds() {
    let norm = records_to_normalized(&golden_records());
    let kinds: Vec<_> = norm
        .iter()
        .filter_map(|r| r.get("kind").and_then(|k| k.as_str()))
        .collect();
    assert!(kinds.contains(&"user_turn"));
    assert!(kinds.contains(&"tool_use"));
    assert!(kinds.contains(&"context_reset"));
    assert_eq!(kinds.iter().filter(|&&k| k == "tool_use").count(), 2);
    for rec in &norm {
        assert!(is_normalized_record(rec));
        let v = validate_normalized_record(rec);
        assert!(v.ok, "{}: {}", rec["kind"], v.errors.join("; "));
    }
}

#[test]
fn no_turn_start_ms_chunks_dedup() {
    let no_key = vec![
        json!({
            "method": "session/update",
            "params": { "update": { "sessionUpdate": "agent_message_chunk",
                "content": { "text": "Thinking..." } } },
            "_meta": { "agentTimestampMs": 1 }
        }),
        json!({
            "method": "session/update",
            "params": { "update": { "sessionUpdate": "agent_message_chunk",
                "content": { "text": " more text" } } },
            "_meta": { "agentTimestampMs": 2 }
        }),
        json!({
            "method": "session/update",
            "params": { "update": { "sessionUpdate": "agent_thought_chunk",
                "content": { "text": "internal" } } },
            "_meta": { "agentTimestampMs": 3 }
        }),
    ];
    let norm = records_to_normalized(&no_key);
    let asst = norm.iter().filter(|r| r["kind"] == "assistant_turn").count();
    let blocks = norm.iter().filter(|r| r["kind"] == "content_block").count();
    assert_eq!(asst, 1);
    assert!(blocks >= 2);
}

#[test]
fn tool_use_category_no_sonic_key() {
    let records = vec![
        json!({
            "method": "session/update",
            "params": { "update": { "sessionUpdate": "tool_call", "toolCallId": "c1", "title": "Shell",
                "rawInput": { "command": "node --test", "working_directory": "D:\\src" } } },
            "_meta": { "agentTimestampMs": 1 }
        }),
        json!({
            "method": "session/update",
            "params": { "update": { "sessionUpdate": "tool_call", "toolCallId": "c2", "title": "Read",
                "rawInput": { "path": "D:\\src\\index.mjs" } } },
            "_meta": { "agentTimestampMs": 2 }
        }),
    ];
    let nrs: Vec<_> = records_to_normalized(&records)
        .into_iter()
        .filter(|r| r["kind"] == "tool_use")
        .collect();
    assert_eq!(nrs.len(), 2);
    assert_eq!(nrs[0]["category"], "node");
    assert!(nrs[1]["category"].is_null());
    assert!(nrs[0].get("key").is_none());
}

#[test]
fn content_block_carries_text() {
    let nrs = records_to_normalized(&[json!({
        "method": "session/update",
        "params": { "update": { "sessionUpdate": "agent_message_chunk",
            "content": { "text": "Analysing the output now." } } },
        "_meta": { "agentTimestampMs": 1 }
    })]);
    let blocks: Vec<_> = nrs.iter().filter(|r| r["kind"] == "content_block").collect();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0]["text"], "Analysing the output now.");
}

#[test]
fn unknown_record_for_unrecognised() {
    let nrs = records_to_normalized(&[json!({
        "method": "session/update",
        "params": { "update": { "sessionUpdate": "some_future_event", "data": {} } },
        "_meta": { "agentTimestampMs": 1 }
    })]);
    let unknowns: Vec<_> = nrs.iter().filter(|r| r["kind"] == "unknown_record").collect();
    assert_eq!(unknowns.len(), 1);
    assert_eq!(unknowns[0]["raw_type"], "some_future_event");
    assert_eq!(unknowns[0]["harness"], "grok");
}

#[test]
fn assistant_turn_per_turn_start_ms() {
    let nrs = records_to_normalized(&[
        su(json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "go do the thing" } }), json!({})),
        su(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "starting" } }), json!({ "turnStartMs": 100 })),
        su(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": " now" } }), json!({ "turnStartMs": 100 })),
        su(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "second turn" } }), json!({ "turnStartMs": 200 })),
    ]);
    assert_eq!(
        nrs.iter().filter(|r| r["kind"] == "assistant_turn").count(),
        2
    );
}

#[test]
fn thought_chunks_and_failed_tool() {
    let nrs = records_to_normalized(&[
        su(
            json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "hmm" } }),
            json!({ "turnStartMs": 100 }),
        ),
        su(
            json!({ "sessionUpdate": "tool_call", "toolCallId": "c-1", "title": "Shell",
                "rawInput": { "command": "node --test" } }),
            json!({}),
        ),
        su(
            json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c-1", "status": "completed",
                "rawOutput": { "exit_code": 1, "stderr": "Error: 3 tests failing" } }),
            json!({}),
        ),
    ]);
    assert!(nrs.iter().any(|r| r["kind"] == "content_block" && r["block_type"] == "thinking"));
    let tr = nrs.iter().find(|r| r["kind"] == "tool_result" && r["error"] == true).unwrap();
    assert_eq!(tr["tool_id"], "c-1");
    assert!(tr["error_text"].as_str().unwrap().contains("3 tests failing"));
}

#[test]
fn short_user_turn_display_text() {
    let nrs = records_to_normalized(&[su(
        json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "ok go" } }),
        json!({}),
    )]);
    let ut = nrs.iter().find(|r| r["kind"] == "user_turn").unwrap();
    assert!(ut["text"].is_null());
    assert_eq!(ut["display_text"], "ok go");
}

#[test]
fn golden_reduce_enrich_smoke() {
    let summary = json!({
        "info": { "id": SESSION_ID, "cwd": "D:\\src\\kaaroSessions" },
        "generated_title": "Multi-harness TDD session",
        "current_model_id": "grok-composer-2.5-fast",
        "head_branch": "feat/multi-harness-tdd",
        "created_at": "2026-06-07T11:13:03.236022400Z",
        "updated_at": "2026-06-07T11:42:01.294547500Z"
    });
    let signals = json!({
        "toolCallCount": 3,
        "compactionCount": 1,
        "contextTokensUsed": 12000,
        "sessionDurationSeconds": 600,
        "primaryModelId": "grok-composer-2.5-fast"
    });
    let mut session = parse_grok_records(
        &golden_records(),
        SESSION_ID,
        ENCODED_CWD,
        Some(&summary),
        Some(&signals),
    );
    enrich_session(&mut session);
    assert_eq!(session.harness, "grok");
    assert_eq!(session.user_turns, 1);
    assert_eq!(session.tool_calls, 2);
    assert_eq!(session.project_id, "D--src-kaaroSessions");
    assert!(session
        .file_ops
        .get("d:/src/kaarosessions/todo.md")
        .map(|f| f.read >= 1)
        .unwrap_or(false));
}
