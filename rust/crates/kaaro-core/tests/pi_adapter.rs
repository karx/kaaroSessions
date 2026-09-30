//! Parity tests vs `test/adapters/pi.test.mjs`.
use kaaro_core::adapters::pi::records_to_normalized;
use kaaro_core::enrich_session::enrich_session;
use kaaro_core::helpers::derive_pi_label;
use kaaro_core::jsonl::parse_jsonl_str;
use kaaro_core::normalized_record::{is_normalized_record, validate_normalized_record};
use kaaro_core::session_reducer::{reduce_session, Capabilities, SessionMeta};
use serde_json::json;
use std::path::PathBuf;

const SESSION_ID: &str = "019dca2b-f4f5-7609-96ae-fe883f7a03db";
const PROJECT_ID: &str = "--D--src-ebrain--";

fn load_golden() -> Vec<serde_json::Value> {
    let raw = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/pi_golden.jsonl"),
    )
    .unwrap();
    parse_jsonl_str(&raw).unwrap()
}

fn kinds(nrs: &[serde_json::Value]) -> Vec<&str> {
    nrs.iter()
        .filter_map(|r| r.get("kind").and_then(|k| k.as_str()))
        .collect()
}

#[test]
fn derive_pi_label_cases() {
    assert_eq!(derive_pi_label("--D--src-ebrain--"), "ebrain");
    assert_eq!(derive_pi_label("--D--src-karx.github.io--"), "karx.github.io");
    assert_eq!(
        derive_pi_label("--D--src-Minecraft-Overviewer--"),
        "Minecraft-Overviewer"
    );
    assert_eq!(derive_pi_label("--C--Users-karx0--"), "C--Users-karx0");
    assert_eq!(derive_pi_label("D--src-foo"), "foo");
}

#[test]
fn golden_emits_expected_kinds() {
    let norm = records_to_normalized(&load_golden());
    let k = kinds(&norm);
    assert!(k.contains(&"session_meta"));
    assert!(k.contains(&"user_turn"));
    assert!(k.contains(&"assistant_turn"));
    assert!(k.contains(&"tokens"));
    assert!(k.iter().filter(|&&x| x == "tool_use").count() >= 2);
}

#[test]
fn golden_nrs_satisfy_contract() {
    for rec in &records_to_normalized(&load_golden()) {
        assert!(is_normalized_record(rec), "{rec}");
        let v = validate_normalized_record(rec);
        assert!(v.ok, "{}: {}", rec["kind"], v.errors.join("; "));
    }
}

#[test]
fn tool_use_bash_category_no_sonic_key() {
    let records = vec![json!({
        "type": "message", "id": "a01", "timestamp": "2026-06-09T10:00:00.000Z",
        "message": {
            "role": "assistant",
            "content": [
                {"type": "toolCall", "id": "tc01", "name": "read", "arguments": {"path": "a.mjs"}},
                {"type": "toolCall", "id": "tc02", "name": "bash", "arguments": {"command": "git status"}},
                {"type": "toolCall", "id": "tc03", "name": "bash", "arguments": {"command": "npm install"}},
            ]
        }
    })];
    let nrs: Vec<_> = records_to_normalized(&records)
        .into_iter()
        .filter(|r| r["kind"] == "tool_use")
        .collect();
    assert!(nrs[0]["category"].is_null());
    assert_eq!(nrs[1]["category"], "git");
    assert_eq!(nrs[2]["category"], "npm");
    assert!(nrs[0].get("key").is_none());
    assert!(nrs[1].get("key").is_none());
}

#[test]
fn thinking_and_text_content_blocks() {
    let records = vec![json!({
        "type": "message", "id": "a02", "timestamp": "2026-06-09T10:00:00.000Z",
        "message": {
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "plan the approach"},
                {"type": "text", "text": "I will update the provider config next."},
                {"type": "toolCall", "id": "tc01", "name": "read", "arguments": {"path": "models.json"}},
            ],
            "stopReason": "toolUse"
        }
    })];
    let nrs = records_to_normalized(&records);
    let blocks: Vec<_> = nrs
        .iter()
        .filter(|r| r["kind"] == "content_block")
        .collect();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0]["block_type"], "thinking");
    assert_eq!(blocks[1]["block_type"], "text");
    assert_eq!(blocks[1]["text"], "I will update the provider config next.");
    let tool = nrs.iter().find(|r| r["kind"] == "tool_use").unwrap();
    assert_eq!(tool["tool"], "read");
    assert_eq!(tool["tool_id"], "tc01");
}

#[test]
fn thinking_level_change_mode_shift() {
    let nrs = records_to_normalized(&[json!({
        "type": "thinking_level_change", "id": "4dfee7f7", "parentId": null,
        "timestamp": "2026-07-09T17:33:20.083Z", "thinkingLevel": "medium"
    })]);
    assert_eq!(nrs.len(), 1);
    assert_eq!(nrs[0]["kind"], "mode_shift");
    assert_eq!(nrs[0]["harness"], "pi");
    assert_eq!(nrs[0]["ts"], "2026-07-09T17:33:20.083Z");
    assert_eq!(nrs[0]["mode"], "thinking:medium");
}

#[test]
fn unknown_record_for_unrecognised_types() {
    let nrs = records_to_normalized(&[json!({
        "type": "some_future_type", "timestamp": "2026-06-09T10:00:00.000Z"
    })]);
    let unknowns: Vec<_> = nrs
        .iter()
        .filter(|r| r["kind"] == "unknown_record")
        .collect();
    assert_eq!(unknowns.len(), 1);
    assert_eq!(unknowns[0]["raw_type"], "some_future_type");
    assert_eq!(unknowns[0]["harness"], "pi");
}

#[test]
fn model_change_and_session_meta() {
    let nrs = records_to_normalized(&load_golden());
    let metas: Vec<_> = nrs
        .iter()
        .filter(|r| r["kind"] == "session_meta")
        .collect();
    // session cwd + model_change
    assert!(metas.iter().any(|m| m.get("cwd").is_some()));
    let model_meta = metas
        .iter()
        .find(|m| m.get("model").is_some())
        .unwrap();
    assert_eq!(model_meta["model"], "openai/gpt-5.4");
    assert_eq!(model_meta["overwrite"], true);
}

#[test]
fn golden_normalize_reduce_enrich() {
    let records = load_golden();
    let nrs = records_to_normalized(&records);
    let meta = SessionMeta {
        session_id: SESSION_ID.into(),
        project_id: PROJECT_ID.into(),
        project_label: derive_pi_label(PROJECT_ID),
        harness: "pi".into(),
        file_size_bytes: 0,
        capabilities: Some(Capabilities {
            size_proxy: Some("tokens_work".into()),
        }),
    };
    let mut s = reduce_session(&nrs, &meta);
    enrich_session(&mut s);

    assert_eq!(s.session_id, SESSION_ID);
    assert_eq!(s.project_id, PROJECT_ID);
    assert_eq!(s.project_label, "ebrain");
    assert_eq!(s.harness, "pi");
    assert_eq!(s.cwd.as_deref(), Some(r"D:\src\ebrain"));
    // model_change then assistant overwrite → last wins with overwrite
    assert_eq!(
        s.model.as_deref(),
        Some("google-antigravity/gemini-3.1-pro-low")
    );
    assert_eq!(s.user_turns, 1);
    assert_eq!(s.assistant_turns, 1);
    assert_eq!(s.tool_calls, 2);
    assert_eq!(s.slug.as_deref(), Some(&SESSION_ID[..8]));
    assert_eq!(s.tokens.input, 100);
    assert_eq!(s.tokens.output, 40);
    assert_eq!(s.tokens.cache_create, 5);
    assert_eq!(s.tokens.cache_read, 10);
    assert_eq!(s.tokens_work, Some(45)); // 40+5
    assert_eq!(s.tokens_total, Some(155));
    assert!(s.tools.contains_key("read"));
    assert!(s.tools.contains_key("bash"));
    assert_eq!(s.file_ops["d:/src/ebrain/foo.js"].read, 1);
    assert_eq!(s.bash_categories.get("git"), Some(&1));
    assert_eq!(s.stop_reasons.get("toolUse"), Some(&1));
    assert_eq!(
        s.first_user_message.as_deref(),
        Some("setup pi to leverage a new LLM provider")
    );
    assert_eq!(
        s.first_timestamp.as_deref(),
        Some("2026-04-26T14:22:51.638Z")
    );
    assert_eq!(
        s.last_timestamp.as_deref(),
        Some("2026-04-26T14:23:05.000Z")
    );
}
