//! Parity vs `test/copilot-adapter.test.mjs`.
use kaaro_core::adapters::copilot::records_to_normalized;
use kaaro_core::enrich_session::enrich_session;
use kaaro_core::helpers::{copilot_tool_name, copilot_uri_to_path};
use kaaro_core::normalized_record::{is_normalized_record, validate_normalized_record};
use kaaro_core::session_reducer::{reduce_session, Capabilities, SessionMeta};
use kaaro_core::tool_name_to_key;
use serde_json::json;

const T_CREATE: i64 = 1779124637563;
const T_REQ: i64 = 1780942410161;

fn make_request(over: serde_json::Value) -> serde_json::Value {
    let mut base = json!({
        "requestId": "request_f00b9286",
        "timestamp": T_REQ,
        "modelId": "copilot/oswe-vscode-prime",
        "message": { "text": "What is the ontology used by the adapters?", "parts": [] },
        "variableData": { "variables": [] },
        "response": [],
    });
    if let (Some(bo), Some(oo)) = (base.as_object_mut(), over.as_object()) {
        for (k, v) in oo {
            bo.insert(k.clone(), v.clone());
        }
    }
    base
}

fn make_tool_invocation() -> serde_json::Value {
    json!({
        "kind": "toolInvocationSerialized",
        "invocationMessage": {
            "value": "Reading [](file:///d%3A/src/kaaroSessions/README.md)",
            "uris": {
                "file:///d%3A/src/kaaroSessions/README.md": {
                    "$mid": 1, "path": "/d:/src/kaaroSessions/README.md", "scheme": "file"
                }
            }
        },
        "toolCallId": "call_fgmplVAsqnIe3gZ8cMYlJ0KT",
        "toolId": "copilot_readFile"
    })
}

#[test]
fn helpers_uri_and_tool_name() {
    assert_eq!(
        copilot_uri_to_path(&json!("file:///d%3A/src/kaaroSessions/README.md")).as_deref(),
        Some("d:/src/kaaroSessions/README.md")
    );
    assert_eq!(
        copilot_uri_to_path(&json!({ "$mid": 1, "path": "/d:/src/x/a.mjs", "scheme": "file" }))
            .as_deref(),
        Some("d:/src/x/a.mjs")
    );
    assert_eq!(
        copilot_uri_to_path(&json!({ "path": "/home/u/a.mjs", "scheme": "file" })).as_deref(),
        Some("/home/u/a.mjs")
    );
    assert_eq!(copilot_tool_name(Some("copilot_readFile")), "readFile");
    assert_eq!(copilot_tool_name(None), "unknown");
}

#[test]
fn snapshot_and_history() {
    let nrs = records_to_normalized(&[json!({
        "kind": 0,
        "v": {
            "version": 3, "creationDate": T_CREATE, "customTitle": "Ontology Q&A",
            "requests": [make_request(json!({
                "response": [make_tool_invocation()],
                "completionTokens": 1092
            }))]
        }
    })]);
    assert_eq!(
        nrs.iter().find(|r| r["kind"] == "session_meta").unwrap()["ai_title"],
        "Ontology Q&A"
    );
    assert!(nrs.iter().any(|r| r["kind"] == "user_turn"));
    assert!(nrs.iter().any(|r| r["kind"] == "assistant_turn"));
    assert_eq!(
        nrs.iter().find(|r| r["kind"] == "tool_use").unwrap()["tool"],
        "readFile"
    );
    assert_eq!(
        nrs.iter().find(|r| r["kind"] == "tokens").unwrap()["tokens"]["output"],
        1092
    );
    for rec in &nrs {
        assert!(is_normalized_record(rec));
        let v = validate_normalized_record(rec);
        assert!(v.ok, "{}: {}", rec["kind"], v.errors.join("; "));
    }
}

#[test]
fn old_dump_and_request_append() {
    let nrs = records_to_normalized(&[json!({
        "version": 3, "sessionId": "old", "creationDate": T_CREATE,
        "customTitle": "Old format chat", "requests": [make_request(json!({}))]
    })]);
    assert_eq!(
        nrs.iter().find(|r| r["kind"] == "session_meta").unwrap()["ai_title"],
        "Old format chat"
    );

    let nrs2 = records_to_normalized(&[json!({
        "kind": 2, "k": ["requests"], "v": [make_request(json!({}))]
    })]);
    assert_eq!(
        nrs2.iter().find(|r| r["kind"] == "user_turn").unwrap()["text"],
        "What is the ontology used by the adapters?"
    );
    assert_eq!(
        nrs2.iter().find(|r| r["kind"] == "session_meta").unwrap()["model"],
        "copilot/oswe-vscode-prime"
    );
}

#[test]
fn response_appends_and_items() {
    let nrs = records_to_normalized(&[
        json!({ "kind": 2, "k": ["requests", 0, "response"], "v": [make_tool_invocation()] }),
        json!({ "kind": 2, "k": ["requests", 0, "response"], "v": [{
            "value": "Here is the answer.", "supportThemeIcons": false
        }] }),
        json!({ "kind": 2, "k": ["requests", 1, "response"], "v": [make_tool_invocation()] }),
    ]);
    assert_eq!(
        nrs.iter().filter(|r| r["kind"] == "assistant_turn").count(),
        2
    );
    let tool = nrs.iter().find(|r| r["kind"] == "tool_use").unwrap();
    assert_eq!(tool["input"]["file_path"], "d:/src/kaaroSessions/README.md");

    let nrs2 = records_to_normalized(&[json!({
        "kind": 2, "k": ["requests", 0, "response"], "v": [
            { "kind": "thinking", "value": "scan first" },
            { "value": "The schema is **NormalizedRecord**." },
            { "kind": "inlineReference", "inlineReference": { "path": "/d:/x" } },
            { "kind": "textEditGroup", "uri": { "path": "/d:/src/x/app.mjs", "scheme": "file" } },
            { "kind": "markdownContent", "content": { "value": "The ontology is…" } },
            { "kind": "hologram9000" }
        ]
    })]);
    assert!(nrs2.iter().any(|r| r["kind"] == "content_block" && r["block_type"] == "thinking"));
    assert!(nrs2.iter().any(|r| r["kind"] == "tool_use" && r["tool"] == "editFile"));
    assert!(nrs2.iter().any(|r| r["kind"] == "content_block"
        && r["text"] == "The ontology is…"));
    assert!(nrs2.iter().any(|r| r["kind"] == "unknown_record"
        && r["raw_type"] == "response:hologram9000"));
}

#[test]
fn set_ops_and_silence() {
    let nrs = records_to_normalized(&[json!({
        "kind": 1, "k": ["requests", 0, "completionTokens"], "v": 2098
    })]);
    assert_eq!(nrs[0]["tokens"]["output"], 2098);

    let title = records_to_normalized(&[json!({
        "kind": 1, "k": ["customTitle"], "v": "Ontology/schema for adapters"
    })]);
    assert_eq!(title[0]["ai_title"], "Ontology/schema for adapters");

    let silent = records_to_normalized(&[
        json!({ "kind": 1, "k": ["inputState", "inputText"], "v": "typing…" }),
        json!({ "kind": 1, "k": ["requests", 0, "result"], "v": { "timings": {} } }),
    ]);
    assert!(silent.is_empty());
}

#[test]
fn tool_key_aliases_and_reduce_smoke() {
    assert_eq!(tool_name_to_key(Some("readFile"), None), "read");
    assert_eq!(tool_name_to_key(Some("createFile"), None), "write");
    let nrs = records_to_normalized(&[json!({
        "kind": 0,
        "v": {
            "creationDate": T_CREATE,
            "requests": [make_request(json!({
                "response": [make_tool_invocation()],
                "completionTokens": 10
            }))]
        }
    })]);
    let meta = SessionMeta {
        session_id: "abc".into(),
        project_id: "D--src-kaaroSessions".into(),
        project_label: "kaaroSessions".into(),
        harness: "copilot".into(),
        file_size_bytes: 1,
        capabilities: Some(Capabilities {
            size_proxy: Some("tokens_work".into()),
        }),
    };
    let mut session = reduce_session(&nrs, &meta);
    enrich_session(&mut session);
    assert_eq!(session.harness, "copilot");
    assert_eq!(session.user_turns, 1);
    assert!(session.tool_calls >= 1);
    assert!(session.tokens.output >= 10);
}
