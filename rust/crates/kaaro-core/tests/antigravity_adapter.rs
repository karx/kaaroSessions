//! Parity vs `test/adapters/antigravity.test.mjs`.
use kaaro_core::adapters::antigravity::records_to_normalized;
use kaaro_core::analyze::parse_antigravity_records;
use kaaro_core::enrich_session::enrich_session;
use kaaro_core::normalized_record::{is_normalized_record, validate_normalized_record};
use serde_json::json;

const SESSION_ID: &str = "c7f6b422-2184-4e11-ad6d-535a069e7347";

fn golden() -> Vec<serde_json::Value> {
    vec![
        json!({
            "step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "status": "DONE",
            "created_at": "2026-06-07T00:15:33Z",
            "content": "<USER_REQUEST>\nSet up the database connection pool\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.5 Flash (Medium). No need to comment on this change.\n</USER_SETTINGS_CHANGE>"
        }),
        json!({
            "step_index": 2, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
            "created_at": "2026-06-07T00:15:34Z",
            "content": "I will look at the files.",
            "tool_calls": [
                { "name": "view_file", "args": { "AbsolutePath": "\"D:/src/ebrain/README.md\"", "toolSummary": "\"Viewing file\"" } },
                { "name": "run_command", "args": {
                    "CommandLine": "\"git status\"",
                    "Cwd": "\"D:\\\\src\\\\ebrain\"",
                    "WaitMsBeforeAsync": "2000"
                }}
            ]
        }),
        json!({
            "step_index": 4, "source": "MODEL", "type": "VIEW_FILE", "status": "ERROR",
            "created_at": "2026-06-07T00:15:41Z",
            "content": "Permission denied."
        }),
    ]
}

#[test]
fn emits_expected_kinds() {
    let norm = records_to_normalized(&golden());
    let kinds: Vec<_> = norm.iter().filter_map(|r| r["kind"].as_str()).collect();
    assert!(kinds.contains(&"user_turn"));
    assert!(kinds.contains(&"session_meta"));
    assert!(kinds.contains(&"assistant_turn"));
    assert!(kinds.contains(&"tool_use"));
    assert!(kinds.contains(&"tool_result"));
    for rec in &norm {
        assert!(is_normalized_record(rec));
        let v = validate_normalized_record(rec);
        assert!(v.ok, "{}: {}", rec["kind"], v.errors.join("; "));
    }
}

#[test]
fn bash_categories_no_sonic_key() {
    let records = vec![json!({
        "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
        "created_at": "2026-06-09T10:00:00Z",
        "tool_calls": [
            { "name": "view_file", "args": { "AbsolutePath": "\"d:\\\\src\\\\a.mjs\"" } },
            { "name": "run_command", "args": { "CommandLine": "\"git status\"", "Cwd": "\"d:\\\\src\"" } },
            { "name": "run_command", "args": { "CommandLine": "\"npm test\"", "Cwd": "\"d:\\\\src\"" } },
            { "name": "grep_search", "args": { "Pattern": "foo" } }
        ]
    })];
    let nrs: Vec<_> = records_to_normalized(&records)
        .into_iter()
        .filter(|r| r["kind"] == "tool_use")
        .collect();
    assert!(nrs[0]["category"].is_null());
    assert_eq!(nrs[1]["category"], "git");
    assert_eq!(nrs[2]["category"], "npm");
    assert!(nrs[3]["category"].is_null());
    assert!(nrs[0].get("key").is_none());
}

#[test]
fn scaffold_and_done_results() {
    let scaffolds = records_to_normalized(&[json!({
        "source": "SYSTEM", "type": "EPHEMERAL_MESSAGE", "created_at": "2026-06-09T10:00:00Z",
        "content": "You are in planning mode. Research before acting."
    })]);
    assert_eq!(scaffolds.iter().filter(|r| r["kind"] == "scaffold").count(), 1);

    for ty in ["VIEW_FILE", "LIST_DIRECTORY", "RUN_COMMAND", "GREP_SEARCH", "CODE_ACTION"] {
        let nrs = records_to_normalized(&[json!({
            "source": "MODEL", "type": ty, "status": "DONE",
            "created_at": "2026-06-09T10:00:00Z", "content": "ok"
        })]);
        let tr = nrs.iter().find(|r| r["kind"] == "tool_result").unwrap();
        assert_eq!(tr["error"], false, "{ty}");
    }
}

#[test]
fn unknown_and_error_message() {
    let nrs = records_to_normalized(&[json!({
        "source": "MODEL", "type": "SOME_FUTURE_TYPE", "created_at": "2026-06-09T10:00:00Z"
    })]);
    assert_eq!(nrs[0]["kind"], "unknown_record");
    assert_eq!(nrs[0]["raw_type"], "SOME_FUTURE_TYPE");

    let err = records_to_normalized(&[json!({
        "source": "MODEL", "type": "ERROR_MESSAGE", "status": "ERROR",
        "created_at": "2026-06-09T10:00:00Z", "content": "Permission denied."
    })]);
    let te = err.iter().find(|r| r["kind"] == "tool_result").unwrap();
    assert_eq!(te["error"], true);
}

#[test]
fn golden_reduce_enrich_smoke() {
    let mut session = parse_antigravity_records(&golden(), SESSION_ID);
    enrich_session(&mut session);
    assert_eq!(session.harness, "antigravity");
    assert_eq!(session.user_turns, 1);
    assert!(session.tool_calls >= 2);
    assert_eq!(session.project_id, "D--src-ebrain");
    assert_eq!(session.project_label, "ebrain");
    assert!(session.model.as_deref().unwrap_or("").contains("Gemini"));
}
