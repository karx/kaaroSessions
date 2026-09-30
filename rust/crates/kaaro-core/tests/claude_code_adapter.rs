//! Smoke / golden parity vs `test/adapters/claude-code.test.mjs` GOLDEN_RECORDS.
use kaaro_core::adapters::claude_code::records_to_normalized;
use kaaro_core::jsonl::parse_jsonl_str;
use kaaro_core::normalized_record::{is_normalized_record, validate_normalized_record};
use serde_json::{json, Value};
use std::path::PathBuf;

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(name)
}

fn load_golden() -> Vec<Value> {
    let raw = std::fs::read_to_string(fixture_path("claude_code_golden.jsonl"))
        .expect("read golden fixture");
    parse_jsonl_str(&raw).expect("parse golden jsonl")
}

fn kinds(nrs: &[Value]) -> Vec<&str> {
    nrs.iter()
        .filter_map(|r| r.get("kind").and_then(|k| k.as_str()))
        .collect()
}

#[test]
fn golden_emits_expected_kinds() {
    let norm = records_to_normalized(&load_golden());
    let kinds = kinds(&norm);
    assert!(kinds.contains(&"user_turn"));
    assert!(kinds.contains(&"context_reset"));
    assert!(kinds.contains(&"skill_invoke"));
    assert!(kinds.contains(&"tool_use"));
    assert!(kinds.contains(&"tokens"));
    assert!(kinds.contains(&"assistant_turn"));
    assert!(kinds.contains(&"content_block"));
    assert_eq!(
        kinds.iter().filter(|&&k| k == "assistant_turn").count(),
        1
    );
    assert!(kinds.iter().filter(|&&k| k == "content_block").count() >= 3);
    assert!(kinds.iter().filter(|&&k| k == "tool_use").count() >= 3);
}

#[test]
fn golden_nrs_satisfy_contract() {
    let norm = records_to_normalized(&load_golden());
    assert!(!norm.is_empty());
    for rec in &norm {
        assert!(is_normalized_record(rec), "shape: {rec}");
        let v = validate_normalized_record(rec);
        assert!(v.ok, "{}: {}", rec["kind"], v.errors.join("; "));
    }
}

#[test]
fn tool_use_bash_category_and_no_sonic_key() {
    let records = vec![json!({
        "type": "assistant",
        "timestamp": "2026-06-09T10:00:00.000Z",
        "message": {"content": [
            {"type": "tool_use", "name": "Read", "input": {"file_path": "a.mjs"}},
            {"type": "tool_use", "name": "Bash", "input": {"command": "git status"}},
            {"type": "tool_use", "name": "Bash", "input": {"command": "node --test"}},
            {"type": "tool_use", "name": "Bash", "input": {"command": "ls -la"}},
            {"type": "tool_use", "name": "Write", "input": {"file_path": "b.mjs"}},
        ]}
    })];
    let nrs: Vec<_> = records_to_normalized(&records)
        .into_iter()
        .filter(|r| r["kind"] == "tool_use")
        .collect();
    assert_eq!(nrs.len(), 5);
    assert!(nrs[0]["category"].is_null());
    assert!(nrs[4]["category"].is_null());
    assert_eq!(nrs[1]["category"], "git");
    assert_eq!(nrs[2]["category"], "node");
    assert_eq!(nrs[3]["category"], "fs");
    assert!(nrs[0].get("key").is_none());
    assert!(nrs[1].get("key").is_none());
}

#[test]
fn content_block_text_carries_text() {
    let records = vec![json!({
        "type": "assistant",
        "timestamp": "2026-06-09T10:00:00.000Z",
        "message": {"content": [
            {"type": "text", "text": "Running the tests now."},
            {"type": "text", "text": "Ok."},
        ]}
    })];
    let nrs: Vec<_> = records_to_normalized(&records)
        .into_iter()
        .filter(|r| r["kind"] == "content_block")
        .collect();
    assert_eq!(nrs.len(), 2);
    assert_eq!(nrs[0]["text"], "Running the tests now.");
    assert_eq!(nrs[1]["text"], "Ok.");
}

#[test]
fn mode_record_emits_mode_shift() {
    let nrs = records_to_normalized(&[json!({"type": "mode", "mode": "plan", "sessionId": "abc"})]);
    assert_eq!(nrs.len(), 1);
    assert_eq!(nrs[0]["kind"], "mode_shift");
    assert_eq!(nrs[0]["mode"], "plan");
    assert_eq!(nrs[0]["harness"], "claude-code");
}

#[test]
fn attachment_invoked_skills_emits_skill_invoke() {
    let ts = "2026-05-05T10:03:12.000Z";
    let nrs = records_to_normalized(&[json!({
        "type": "attachment",
        "timestamp": ts,
        "attachment": {
            "type": "invoked_skills",
            "skills": [
                {"name": "visualize-seed", "path": "/skills/visualize-seed/SKILL.md"},
                {"name": "web-seo", "path": "/skills/web-seo/SKILL.md"},
                {"name": "", "path": "/skills/empty/SKILL.md"},
            ]
        }
    })]);
    let skills: Vec<_> = nrs
        .iter()
        .filter(|r| r["kind"] == "skill_invoke")
        .collect();
    assert_eq!(skills.len(), 2);
    assert_eq!(skills[0]["skill"], "visualize-seed");
    assert_eq!(skills[1]["skill"], "web-seo");
    for s in &skills {
        assert_eq!(s["ts"], ts);
        assert_eq!(s["harness"], "claude-code");
    }
    let att = nrs.iter().find(|r| r["kind"] == "attachment").unwrap();
    assert_eq!(att["subtype"], "invoked_skills");
}

#[test]
fn tool_use_carries_tool_id() {
    let nrs = records_to_normalized(&[json!({
        "type": "assistant",
        "timestamp": "t",
        "message": {"content": [
            {"type": "tool_use", "id": "toolu_01abc", "name": "Read", "input": {"file_path": "a.mjs"}},
        ]}
    })]);
    let tu = nrs.iter().find(|r| r["kind"] == "tool_use").unwrap();
    assert_eq!(tu["tool_id"], "toolu_01abc");
}

#[test]
fn tool_result_error_carries_tool_id_and_error_text() {
    let nrs = records_to_normalized(&[json!({
        "type": "user",
        "timestamp": "t",
        "message": {"content": [
            {"type": "tool_result", "tool_use_id": "toolu_01abc", "is_error": true,
             "content": [{"type": "text", "text": "Command failed: exit code 1 -- missing file"}]}
        ]}
    })]);
    let tr = nrs.iter().find(|r| r["kind"] == "tool_result").unwrap();
    assert_eq!(tr["error"], true);
    assert_eq!(tr["tool_id"], "toolu_01abc");
    assert!(tr["error_text"].as_str().unwrap().contains("exit code 1"));
}

#[test]
fn user_turn_display_text_on_every_human_turn() {
    let nrs = records_to_normalized(&[
        json!({"type": "user", "timestamp": "t1", "message": {"content": "first prompt with enough text"}}),
        json!({"type": "user", "timestamp": "t2", "message": {"content": "second prompt also matters here"}}),
        json!({"type": "user", "timestamp": "t3",
            "message": {"content": [{"type": "tool_result", "tool_use_id": "x", "content": []}]}}),
    ]);
    let turns: Vec<_> = nrs
        .iter()
        .filter(|r| r["kind"] == "user_turn")
        .collect();
    assert_eq!(turns.len(), 3);
    assert!(turns[0]["display_text"]
        .as_str()
        .unwrap()
        .contains("first prompt"));
    assert!(turns[1]["display_text"]
        .as_str()
        .unwrap()
        .contains("second prompt"));
    assert!(turns[1]["text"].is_null(), "text keeps first-user-message-only");
    assert!(
        turns[2]["display_text"].is_null(),
        "tool-result-only carries no display text"
    );
}

#[test]
fn unknown_record_for_unrecognised_types() {
    let nrs = records_to_normalized(&[
        json!({"type": "some_future_type", "timestamp": "2026-06-09T10:00:00.000Z", "data": {}}),
        json!({"type": "another_unknown", "timestamp": "2026-06-09T10:00:01.000Z"}),
    ]);
    let unknowns: Vec<_> = nrs
        .iter()
        .filter(|r| r["kind"] == "unknown_record")
        .collect();
    assert_eq!(unknowns.len(), 2);
    assert_eq!(unknowns[0]["raw_type"], "some_future_type");
    assert_eq!(unknowns[1]["raw_type"], "another_unknown");
    assert_eq!(unknowns[0]["harness"], "claude-code");
}

#[test]
fn parse_jsonl_str_skips_blank_lines() {
    let records = parse_jsonl_str("{\"a\":1}\n\n{\"b\":2}\n").unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["a"], 1);
    assert_eq!(records[1]["b"], 2);
}
