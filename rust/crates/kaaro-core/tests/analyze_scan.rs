//! Injectable-root scan: temp CC / Pi / OpenCode trees → sessions.
use kaaro_core::analyze::{collect_sessions, RootOverrides};
use kaaro_core::session_locators::{
    locate_claude_code_session, locate_opencode_session, locate_pi_session,
};
use std::fs;
use std::path::PathBuf;

fn temp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kaaro-analyze-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &PathBuf, body: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, body).unwrap();
}

#[test]
fn collect_sessions_from_temp_cc_pi_opencode_trees() {
    let cc_root = temp_root("cc");
    let pi_root = temp_root("pi");
    let oc_root = temp_root("oc");

    // Claude Code: projects/<proj>/<uuid>.jsonl
    let cc_jsonl = cc_root.join("D--src-demo").join("sess-cc-001.jsonl");
    write(
        &cc_jsonl,
        r#"{"type":"user","timestamp":"2026-05-01T10:00:00.000Z","message":{"content":"please fix the auth module now"}}
{"type":"assistant","timestamp":"2026-05-01T10:01:00.000Z","message":{"model":"claude-sonnet-4-6","stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"content":[{"type":"text","text":"ok"}]}}
"#,
    );

    // Pi: sessions/<proj>/<ts>_<uuid>.jsonl
    let pi_jsonl = pi_root
        .join("--D--src-ebrain--")
        .join("2026-04-26T14-22-51-638Z_019dca2b.jsonl");
    write(
        &pi_jsonl,
        r#"{"type":"session","version":3,"id":"019dca2b","timestamp":"2026-04-26T14:22:51.638Z","cwd":"D:\\src\\ebrain"}
{"type":"message","id":"u01","timestamp":"2026-04-26T14:23:00.000Z","message":{"role":"user","content":[{"type":"text","text":"setup pi to leverage a new LLM provider"}]}}
"#,
    );

    // OpenCode storage tree
    let ses = "ses_4a89582bbffe03xj4Y14Qtss1q";
    let msg_u = "msg_user01";
    let msg_a = "msg_asst01";
    write(
        &oc_root.join("session/global").join(format!("{ses}.json")),
        &format!(
            r#"{{"id":"{ses}","directory":"D:\\src\\demo","title":"Demo Session","time":{{"created":1766698000000,"updated":1766698200000}}}}"#
        ),
    );
    write(
        &oc_root.join("message").join(ses).join(format!("{msg_u}.json")),
        &format!(
            r#"{{"id":"{msg_u}","sessionID":"{ses}","role":"user","time":{{"created":1766698062733}}}}"#
        ),
    );
    write(
        &oc_root.join("part").join(msg_u).join("prt_a.json"),
        r#"{"id":"prt_a","type":"text","text":"please fix the build script now"}"#,
    );
    write(
        &oc_root.join("message").join(ses).join(format!("{msg_a}.json")),
        &format!(
            r#"{{"id":"{msg_a}","sessionID":"{ses}","role":"assistant","time":{{"created":1766698107679,"completed":1766698137064}},"modelID":"glm-4.7-free","finish":"stop","tokens":{{"input":100,"output":50,"cache":{{"read":30,"write":20}}}}}}"#
        ),
    );
    write(
        &oc_root.join("part").join(msg_a).join("prt_b.json"),
        r#"{"id":"prt_b","type":"tool","tool":"read","state":{"status":"completed","input":{"filePath":"D:\\src\\demo\\build.mjs"},"time":{"start":1766698110000,"end":1766698110050}}}"#,
    );

    let sessions = collect_sessions(&RootOverrides {
        claude_code: Some(cc_root.clone()),
        pi: Some(pi_root.clone()),
        opencode: Some(oc_root.clone()),
        // Missing codex/grok roots → skipped
        ..Default::default()
    });

    assert_eq!(sessions.len(), 3, "expected one session per harness");
    let harnesses: Vec<_> = sessions.iter().map(|s| s.harness.as_str()).collect();
    assert!(harnesses.contains(&"claude-code"));
    assert!(harnesses.contains(&"pi"));
    assert!(harnesses.contains(&"opencode"));

    let cc = sessions.iter().find(|s| s.harness == "claude-code").unwrap();
    assert_eq!(cc.user_turns, 1);
    assert_eq!(cc.assistant_turns, 1);
    assert!(cc.tokens_work.is_some());

    let pi = sessions.iter().find(|s| s.harness == "pi").unwrap();
    assert_eq!(pi.session_id, "019dca2b");
    assert_eq!(pi.project_label, "ebrain");
    assert_eq!(pi.user_turns, 1);

    let oc = sessions.iter().find(|s| s.harness == "opencode").unwrap();
    assert_eq!(oc.session_id, ses);
    assert_eq!(oc.ai_title.as_deref(), Some("Demo Session"));
    assert_eq!(oc.tokens.input, 100);
    assert_eq!(oc.tool_calls, 1);
    assert!(oc.tokens_total.is_some());

    // locators
    let hit = locate_claude_code_session("sess-cc-001", &cc_root).unwrap();
    assert_eq!(hit.project_id.as_deref(), Some("D--src-demo"));
    let hit = locate_pi_session("019dca2b", &pi_root).unwrap();
    assert!(hit.file_path.ends_with("2026-04-26T14-22-51-638Z_019dca2b.jsonl"));
    let hit = locate_opencode_session(ses, &oc_root).unwrap();
    assert!(hit.file_path.ends_with(format!("{ses}.json")));

    fs::remove_dir_all(cc_root).ok();
    fs::remove_dir_all(pi_root).ok();
    fs::remove_dir_all(oc_root).ok();
}

#[test]
fn locate_claude_code_missing_is_none() {
    let root = temp_root("empty");
    assert!(locate_claude_code_session("nope", &root).is_none());
    fs::remove_dir_all(root).ok();
}
