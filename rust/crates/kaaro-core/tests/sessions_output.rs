//! Parity vs `test/analyze-orchestrator.test.mjs` (core cases).
use kaaro_core::helpers::canonical_project_id;
use kaaro_core::scan_walk::ScanEnvelope;
use kaaro_core::session_reducer::{reduce_session, Capabilities, Session, SessionMeta, TokenCounts};
use kaaro_core::sessions_output::{
    build_global_rollup, build_sessions_output, sessions_data_to_value, validate_sessions_data,
};
use std::path::PathBuf;

fn meta(id: &str, harness: &str, project_id: &str) -> SessionMeta {
    SessionMeta {
        session_id: id.into(),
        project_id: project_id.into(),
        project_label: "ebrain".into(),
        harness: harness.into(),
        file_size_bytes: 0,
        capabilities: Some(Capabilities {
            size_proxy: Some("tokens_work".into()),
        }),
    }
}

fn make_session(id: &str, harness: &str, project_id: &str, tokens: TokenCounts, tool_calls: i64) -> Session {
    let mut s = reduce_session(&[], &meta(id, harness, project_id));
    s.tokens = tokens;
    s.tool_calls = tool_calls;
    s.first_timestamp = Some("2026-05-01T10:00:00.000Z".into());
    s.last_timestamp = Some("2026-05-01T11:00:00.000Z".into());
    s
}

#[test]
fn canonical_project_id_strips_pi_wrap_and_uppercases_drive() {
    assert_eq!(canonical_project_id("--D--src-ebrain--"), "D--src-ebrain");
    assert_eq!(canonical_project_id("d--src-foo"), "D--src-foo");
    assert_eq!(canonical_project_id("D--src-ebrain"), "D--src-ebrain");
}

#[test]
fn build_sessions_output_merges_harnesses() {
    let output = build_sessions_output(&[
        ScanEnvelope {
            harness: "claude-code".into(),
            source_dir: PathBuf::from("/claude"),
            sessions: vec![make_session(
                "cc-1",
                "claude-code",
                "D--src-ebrain",
                TokenCounts {
                    input: 10,
                    output: 20,
                    cache_create: 5,
                    cache_read: 0,
                    total: None,
                },
                3,
            )],
        },
        ScanEnvelope {
            harness: "pi".into(),
            source_dir: PathBuf::from("/pi"),
            sessions: vec![make_session(
                "pi-1",
                "pi",
                "--D--src-ebrain--",
                TokenCounts {
                    input: 0,
                    output: 0,
                    cache_create: 0,
                    cache_read: 0,
                    total: None,
                },
                12,
            )],
        },
    ]);

    assert_eq!(output.sessions.len(), 2);
    assert_eq!(output.meta.harnesses, vec!["claude-code", "pi"]);
    assert_eq!(
        output.meta.source_dirs.get("claude-code").map(String::as_str),
        Some("/claude")
    );
    assert_eq!(output.projects.len(), 1);
    assert_eq!(output.projects[0].session_count, 2);
    assert_eq!(output.projects[0].label, "ebrain");
    assert_eq!(output.projects[0].id, "D--src-ebrain");

    let v = sessions_data_to_value(&output);
    validate_sessions_data(&v).unwrap();
}

#[test]
fn project_summaries_carry_tokens_work_total() {
    let output = build_sessions_output(&[ScanEnvelope {
        harness: "claude-code".into(),
        source_dir: PathBuf::from("/claude"),
        sessions: vec![
            make_session(
                "s1",
                "claude-code",
                "p1",
                TokenCounts {
                    input: 10,
                    output: 20,
                    cache_create: 5,
                    cache_read: 0,
                    total: None,
                },
                0,
            ),
            make_session(
                "s2",
                "claude-code",
                "p1",
                TokenCounts {
                    input: 10,
                    output: 100,
                    cache_create: 15,
                    cache_read: 40,
                    total: None,
                },
                0,
            ),
        ],
    }]);
    let p = &output.projects[0];
    assert_eq!(p.tokens_work, Some(140)); // (20+5)+(100+15)
    assert_eq!(p.tokens_total, Some(200)); // 35+165
}

#[test]
fn sorts_sessions_by_first_timestamp() {
    let mut a = make_session(
        "later",
        "claude-code",
        "p",
        TokenCounts::default(),
        0,
    );
    a.first_timestamp = Some("2026-05-02T00:00:00.000Z".into());
    let mut b = make_session(
        "earlier",
        "claude-code",
        "p",
        TokenCounts::default(),
        0,
    );
    b.first_timestamp = Some("2026-05-01T00:00:00.000Z".into());
    let output = build_sessions_output(&[ScanEnvelope {
        harness: "claude-code".into(),
        source_dir: PathBuf::from("/c"),
        sessions: vec![a, b],
    }]);
    assert_eq!(output.sessions[0].session_id, "earlier");
    assert_eq!(output.sessions[1].session_id, "later");
}

#[test]
fn global_rollup_sums_tokens() {
    let sessions = vec![
        make_session(
            "a",
            "claude-code",
            "p",
            TokenCounts {
                input: 100,
                output: 50,
                cache_create: 0,
                cache_read: 0,
                total: None,
            },
            0,
        ),
        make_session(
            "b",
            "claude-code",
            "p",
            TokenCounts {
                input: 200,
                output: 120,
                cache_create: 0,
                cache_read: 0,
                total: None,
            },
            0,
        ),
    ];
    let rollup = build_global_rollup(&sessions);
    assert_eq!(rollup.tokens.input, 300);
    assert_eq!(rollup.tokens.output, 170);
}
