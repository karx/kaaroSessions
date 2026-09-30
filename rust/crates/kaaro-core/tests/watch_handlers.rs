//! Port of `test/watch-handlers.test.mjs` (ported harnesses).
use kaaro_core::process_watch_filename;
use std::path::Path;

const ROOT: &str = "/fake/root";

#[test]
fn claude_code_jsonl() {
    let r = process_watch_filename(
        "claude-code",
        Some("D--src-foo/abc-def-123.jsonl"),
        Path::new(ROOT),
    )
    .unwrap();
    assert_eq!(r.ctx.harness, "claude-code");
    assert_eq!(r.ctx.session_id, "abc-def-123");
    assert_eq!(
        r.rebuild_arg.as_deref(),
        Some("--session=D--src-foo/abc-def-123.jsonl")
    );
    assert_eq!(
        r.abs_path.to_string_lossy(),
        "/fake/root/D--src-foo/abc-def-123.jsonl"
    );
}

#[test]
fn claude_code_subagent_attributes_to_parent() {
    let r = process_watch_filename(
        "claude-code",
        Some("D--src-foo/abc-def-123/subagents/agent-a3e11a292d609acd8.jsonl"),
        Path::new(ROOT),
    )
    .unwrap();
    assert_eq!(r.ctx.session_id, "abc-def-123");
    assert_eq!(r.ctx.agent_id.as_deref(), Some("a3e11a292d609acd8"));
    assert_eq!(
        r.rebuild_arg.as_deref(),
        Some("--session=D--src-foo/abc-def-123.jsonl")
    );
}

#[test]
fn rejects_non_log() {
    assert!(process_watch_filename(
        "claude-code",
        Some("D--src-foo/readme.txt"),
        Path::new(ROOT)
    )
    .is_none());
    assert!(process_watch_filename("claude-code", None, Path::new(ROOT)).is_none());
}

#[test]
fn pi_extracts_uuid() {
    let r = process_watch_filename(
        "pi",
        Some("--D--src-ebrain--/2026-04-26T14-22-51-638Z_019dca2b.jsonl"),
        Path::new(ROOT),
    )
    .unwrap();
    assert_eq!(r.ctx.harness, "pi");
    assert_eq!(r.ctx.session_id, "019dca2b");
    assert!(r.rebuild_arg.is_none());
}

#[test]
fn opencode_session_json() {
    let r = process_watch_filename(
        "opencode",
        Some("session/global/ses_4a89582bbffe03xj4Y14Qtss1q.json"),
        Path::new(ROOT),
    )
    .unwrap();
    assert_eq!(r.ctx.harness, "opencode");
    assert_eq!(r.ctx.session_id, "ses_4a89582bbffe03xj4Y14Qtss1q");
    assert_eq!(r.ctx.read_mode.as_deref(), Some("json"));
    assert!(r.rebuild_arg.is_none());
}

#[test]
fn opencode_part_session_empty() {
    let r = process_watch_filename(
        "opencode",
        Some("part/msg_b5769c31f001Wjs4cv6/prt_b57584550001nzWf.json"),
        Path::new(ROOT),
    )
    .unwrap();
    assert_eq!(r.ctx.session_id, "");
    assert_eq!(r.ctx.read_mode.as_deref(), Some("json"));
}

#[test]
fn unknown_harness() {
    assert!(process_watch_filename("unknown", Some("foo.jsonl"), Path::new(ROOT)).is_none());
}
