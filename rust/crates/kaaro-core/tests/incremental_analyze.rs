//! Incremental `--session=` merge against a real CC jsonl + sessions-data.json.
use kaaro_core::analyze::analyze_claude_code_session;
use kaaro_core::incremental::{
    merge_session_into_data, parse_session_flag, try_incremental_claude_code,
};
use kaaro_core::sessions_output::{
    build_sessions_output, sessions_data_to_json,
};
use kaaro_core::scan_walk::ScanEnvelope;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp() -> PathBuf {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let p = std::env::temp_dir().join(format!("kaaro-incr-{n}"));
    fs::create_dir_all(&p).unwrap();
    p
}

#[test]
fn incremental_updates_one_session_in_existing_data() {
    let root = temp();
    let proj = "D--src-demo";
    let sid = "abcd1234-0000-0000-0000-000000000001";
    let proj_dir = root.join(proj);
    fs::create_dir_all(&proj_dir).unwrap();
    let file = proj_dir.join(format!("{sid}.jsonl"));
    let body_v1 = r#"{"type":"user","timestamp":"2026-05-01T10:00:00Z","message":{"content":"first prompt here"}}
{"type":"assistant","timestamp":"2026-05-01T10:01:00Z","message":{"model":"x","stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"content":[]}}
"#;
    fs::write(&file, body_v1).unwrap();

    let sess1 = analyze_claude_code_session(proj, &file).unwrap();
    let env = ScanEnvelope {
        harness: "claude-code".into(),
        source_dir: root.clone(),
        sessions: vec![sess1.clone()],
    };
    let data = build_sessions_output(&[env]);
    let out = root.join("sessions-data.json");
    fs::write(&out, sessions_data_to_json(&data).unwrap()).unwrap();

    // Grow the transcript
    let body_v2 = format!(
        "{body_v1}{}",
        r#"{"type":"user","timestamp":"2026-05-01T10:02:00Z","message":{"content":"second prompt here"}}
"#
    );
    fs::write(&file, body_v2).unwrap();

    let flag = parse_session_flag(&[format!("--session={proj}/{sid}")]).unwrap();
    let merged = try_incremental_claude_code(&out, &flag.project_id, &flag.session_id, &root)
        .unwrap()
        .expect("merged");
    assert_eq!(merged.sessions.len(), 1);
    assert_eq!(merged.sessions[0].session_id, sid);
    assert_eq!(merged.sessions[0].user_turns, 2);
    assert!(merged.sessions[0].tokens.input >= sess1.tokens.input);

    // Replace via merge helper keeps count
    let updated = analyze_claude_code_session(proj, &file).unwrap();
    let again = merge_session_into_data(&merged, updated);
    assert_eq!(again.meta.total_sessions, 1);

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn incremental_missing_file_returns_none() {
    let root = temp();
    let out = root.join("sessions-data.json");
    // no file → None
    let r = try_incremental_claude_code(&out, "p", "s", &root).unwrap();
    assert!(r.is_none());
    let _ = fs::remove_dir_all(&root);
}
