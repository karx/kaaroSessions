//! Parity tests vs `test/opencode-adapter.test.mjs`.
use kaaro_core::adapters::opencode::records_to_normalized;
use kaaro_core::enrich_session::enrich_session;
use kaaro_core::helpers::ms_to_iso;
use kaaro_core::normalized_record::{is_normalized_record, validate_normalized_record};
use kaaro_core::session_reducer::{reduce_session, Capabilities, SessionMeta};
use serde_json::{json, Value};

fn make_info(over: Value) -> Value {
    let mut base = json!({
        "id": "ses_4a89582bbffe03xj4Y14Qtss1q",
        "version": "1.0.201",
        "projectID": "a2e62809cabc418ada21bb21c33c53f450d908f3",
        "directory": "D:\\src\\mineKaaro\\bun-ai-minecraft",
        "title": "Minecraft Bridge Session",
        "time": { "created": 1766698155332u64, "updated": 1766698155332u64 },
    });
    if let (Some(b), Some(o)) = (base.as_object_mut(), over.as_object()) {
        for (k, v) in o {
            b.insert(k.clone(), v.clone());
        }
    }
    base
}

fn make_user_msg() -> Value {
    json!({
        "id": "msg_b5769137e0018PLt3AfBg4hv1C",
        "sessionID": "ses_4a89582bbffe03xj4Y14Qtss1q",
        "role": "user",
        "time": { "created": 1766698062733u64 },
        "_parts": [{
            "id": "prt_u1",
            "sessionID": "ses_4a89582bbffe03xj4Y14Qtss1q",
            "messageID": "msg_b5769137e0018PLt3AfBg4hv1C",
            "type": "text",
            "text": "create a README describing the bot capabilities",
        }],
    })
}

fn make_assistant_msg(over: Value) -> Value {
    let mut base = json!({
        "id": "msg_b5769c31f001Wjs4cv4KuecGOU",
        "sessionID": "ses_4a89582bbffe03xj4Y14Qtss1q",
        "role": "assistant",
        "time": { "created": 1766698107679u64, "completed": 1766698137064u64 },
        "parentID": "msg_b5769137e0018PLt3AfBg4hv1C",
        "modelID": "glm-4.7-free",
        "providerID": "opencode",
        "mode": "build",
        "agent": "build",
        "path": {
            "cwd": "D:\\src\\mineKaaro\\bun-ai-minecraft",
            "root": "D:\\src\\mineKaaro\\bun-ai-minecraft"
        },
        "cost": 0,
        "tokens": {
            "input": 25801,
            "output": 166,
            "reasoning": 0,
            "cache": { "read": 70, "write": 12 }
        },
        "finish": "stop",
        "_parts": [],
    });
    if let (Some(b), Some(o)) = (base.as_object_mut(), over.as_object()) {
        for (k, v) in o {
            b.insert(k.clone(), v.clone());
        }
    }
    base
}

fn make_tool_part(over: Value, state_over: Value) -> Value {
    let mut state = json!({
        "status": "completed",
        "input": { "pattern": "*.config.*" },
        "output": "No files found",
        "title": "src\\mineKaaro",
        "metadata": { "count": 0, "truncated": false },
        "time": { "start": 1766696961364u64, "end": 1766696961381u64 },
    });
    if let (Some(s), Some(o)) = (state.as_object_mut(), state_over.as_object()) {
        for (k, v) in o {
            s.insert(k.clone(), v.clone());
        }
    }
    let mut base = json!({
        "id": "prt_b57584550001nzWfv6yKaN7Jdr",
        "sessionID": "ses_4a89582bbffe03xj4Y14Qtss1q",
        "messageID": "msg_b5769c31f001Wjs4cv4KuecGOU",
        "type": "tool",
        "callID": "call_405d6a0710e6408a95f38c14",
        "tool": "glob",
    });
    if let Some(b) = base.as_object_mut() {
        b.insert("state".into(), state);
        if let Some(o) = over.as_object() {
            for (k, v) in o {
                b.insert(k.clone(), v.clone());
            }
        }
    }
    base
}

#[test]
fn session_info_to_session_meta() {
    let nrs = records_to_normalized(&[make_info(json!({}))]);
    assert_eq!(nrs.len(), 1);
    let m = &nrs[0];
    assert_eq!(m["kind"], "session_meta");
    assert_eq!(m["harness"], "opencode");
    assert_eq!(m["ai_title"], "Minecraft Bridge Session");
    assert_eq!(m["cwd"], "D:\\src\\mineKaaro\\bun-ai-minecraft");
    assert_eq!(m["ts"], ms_to_iso(1766698155332));
}

#[test]
fn user_message_to_user_turn_no_content_block() {
    let nrs = records_to_normalized(&[make_user_msg()]);
    let turn = nrs.iter().find(|r| r["kind"] == "user_turn").unwrap();
    assert_eq!(
        turn["text"],
        "create a README describing the bot capabilities"
    );
    assert_eq!(turn["ts"], ms_to_iso(1766698062733));
    assert_eq!(
        nrs.iter().filter(|r| r["kind"] == "content_block").count(),
        0
    );
}

#[test]
fn assistant_message_tokens_cache_write() {
    let nrs = records_to_normalized(&[make_assistant_msg(json!({}))]);
    let turn = nrs.iter().find(|r| r["kind"] == "assistant_turn").unwrap();
    assert_eq!(turn["model"], "glm-4.7-free");
    assert_eq!(turn["stop_reason"], "stop");
    let tok = nrs.iter().find(|r| r["kind"] == "tokens").unwrap();
    assert_eq!(tok["tokens"]["input"], 25801);
    assert_eq!(tok["tokens"]["output"], 166);
    assert_eq!(tok["tokens"]["cache_create"], 12);
    assert_eq!(tok["tokens"]["cache_read"], 70);
}

#[test]
fn assistant_without_tokens_no_tokens_record() {
    let mut msg = make_assistant_msg(json!({}));
    msg.as_object_mut().unwrap().remove("tokens");
    let nrs = records_to_normalized(&[msg]);
    assert_eq!(nrs.iter().filter(|r| r["kind"] == "tokens").count(), 0);
}

#[test]
fn completed_tool_part() {
    let nrs = records_to_normalized(&[make_tool_part(json!({}), json!({}))]);
    assert_eq!(nrs.len(), 1);
    assert_eq!(nrs[0]["kind"], "tool_use");
    assert_eq!(nrs[0]["tool"], "glob");
    assert_eq!(nrs[0]["ts"], ms_to_iso(1766696961364));
}


#[test]
fn tool_part_filepath_maps_to_file_path() {
    let nrs = records_to_normalized(&[make_tool_part(
        json!({"tool": "read"}),
        json!({"input": {"filePath": "D:\\src\\demo\\a.mjs"}}),
    )]);
    assert_eq!(nrs[0]["input"]["file_path"], "D:\\src\\demo\\a.mjs");
}

#[test]
fn bash_tool_category_from_command() {
    let nrs = records_to_normalized(&[make_tool_part(
        json!({"tool": "bash"}),
        json!({"input": {"command": "git status"}}),
    )]);
    assert_eq!(nrs[0]["kind"], "tool_use");
    assert_eq!(nrs[0]["category"], "git");
    assert_eq!(nrs[0]["input"]["command"], "git status");
}

#[test]
fn error_tool_part_emits_tool_result() {
    let nrs = records_to_normalized(&[make_tool_part(
        json!({}),
        json!({"status": "error"}),
    )]);
    assert_eq!(nrs.len(), 2);
    assert_eq!(nrs[0]["kind"], "tool_use");
    assert_eq!(nrs[1]["kind"], "tool_result");
    assert_eq!(nrs[1]["error"], true);
    assert_eq!(nrs[1]["tool"], "glob");
}

#[test]
fn pending_running_tool_parts_silent() {
    assert!(records_to_normalized(&[make_tool_part(
        json!({}),
        json!({"status": "pending"})
    )])
    .is_empty());
    assert!(records_to_normalized(&[make_tool_part(
        json!({}),
        json!({"status": "running"})
    )])
    .is_empty());
}

#[test]
fn text_and_reasoning_content_blocks() {
    let msg = make_assistant_msg(json!({
        "_parts": [
            {"id": "prt_t", "type": "text", "text": "Done — the README is written and committed now."},
            {"id": "prt_r", "type": "reasoning", "text": "Let me check the files.",
             "time": {"start": 1766696906083u64, "end": 1766696906793u64}},
        ]
    }));
    let nrs = records_to_normalized(&[msg]);
    let text = nrs
        .iter()
        .find(|r| r["kind"] == "content_block" && r["block_type"] == "text")
        .unwrap();
    let think = nrs
        .iter()
        .find(|r| r["kind"] == "content_block" && r["block_type"] == "thinking")
        .unwrap();
    assert_eq!(
        text["text"],
        "Done — the README is written and committed now."
    );
    assert!(think.get("text").is_some());
}

#[test]
fn step_parts_silenced_single_tokens() {
    let msg = make_assistant_msg(json!({
        "_parts": [
            {"id": "p1", "type": "step-start"},
            {"id": "p2", "type": "step-finish", "reason": "stop", "cost": 0,
             "tokens": {"input": 10913, "output": 428, "reasoning": 0,
                        "cache": {"read": 70, "write": 0}}},
            {"id": "p3", "type": "patch", "hash": "abc", "files": ["D:\\x\\README.md"]},
        ]
    }));
    let nrs = records_to_normalized(&[msg]);
    assert_eq!(nrs.iter().filter(|r| r["kind"] == "tokens").count(), 1);
    assert_eq!(
        nrs.iter()
            .filter(|r| r["kind"] == "unknown_record")
            .count(),
        0
    );
}

#[test]
fn unknown_part_type_catch_all() {
    let nrs = records_to_normalized(&[json!({"type": "snapshot-v9", "id": "prt_x"})]);
    assert_eq!(nrs.len(), 1);
    assert_eq!(nrs[0]["kind"], "unknown_record");
    assert_eq!(nrs[0]["raw_type"], "part:snapshot-v9");
}

#[test]
fn full_session_reduce_enrich() {
    let records = vec![
        make_info(json!({})),
        make_user_msg(),
        make_assistant_msg(json!({
            "_parts": [
                make_tool_part(json!({"tool": "read"}), json!({"input": {"filePath": "D:\\src\\demo\\a.mjs"}})),
                make_tool_part(json!({"id": "prt_2", "tool": "edit"}), json!({"input": {"filePath": "D:\\src\\demo\\a.mjs"}})),
                make_tool_part(
                    json!({"id": "prt_3", "tool": "bash"}),
                    json!({"input": {"command": "node --test"}, "status": "error"}),
                ),
            ]
        })),
    ];
    let nrs = records_to_normalized(&records);
    for rec in &nrs {
        assert!(is_normalized_record(rec), "{rec}");
        let v = validate_normalized_record(rec);
        assert!(v.ok, "{}: {}", rec["kind"], v.errors.join("; "));
    }

    let meta = SessionMeta {
        session_id: "ses_4a89582bbffe03xj4Y14Qtss1q".into(),
        project_id: "D--src-mineKaaro-bun-ai-minecraft".into(),
        project_label: "bun-ai-minecraft".into(),
        harness: "opencode".into(),
        file_size_bytes: 0,
        capabilities: Some(Capabilities {
            size_proxy: Some("tokens_work".into()),
        }),
    };
    let mut session = reduce_session(&nrs, &meta);
    enrich_session(&mut session);

    assert_eq!(session.harness, "opencode");
    assert_eq!(session.user_turns, 1);
    assert_eq!(session.assistant_turns, 1);
    assert_eq!(session.tool_calls, 3);
    assert_eq!(session.tool_errors, 1);
    assert_eq!(session.tokens.input, 25801);
    assert_eq!(session.tokens.cache_create, 12);
    assert_eq!(session.ai_title.as_deref(), Some("Minecraft Bridge Session"));
    assert_eq!(session.model.as_deref(), Some("glm-4.7-free"));
    assert_eq!(
        session.first_user_message.as_deref(),
        Some("create a README describing the bot capabilities")
    );
    let fo = &session.file_ops["d:/src/demo/a.mjs"];
    assert_eq!(fo.read, 1);
    assert_eq!(fo.write, 0);
    assert_eq!(fo.edit, 1);
    assert_eq!(session.bash_categories.get("node"), Some(&1));
    // enrich
    assert_eq!(session.tokens_work, Some(166 + 12));
    assert_eq!(session.tokens_total, Some(25801 + 166 + 12 + 70));
}
