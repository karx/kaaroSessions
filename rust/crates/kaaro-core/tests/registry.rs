//! Registry smoke vs `test/harness-registry.test.mjs` (ported subset).
use kaaro_core::normalized_record::is_normalized_record;
use kaaro_core::registry::{get_enabled_harnesses, get_harness, harness_registry, HARNESS_IDS};
use serde_json::json;

#[test]
fn known_ported_harnesses() {
    assert_eq!(HARNESS_IDS.len(), 8);
    assert_eq!(harness_registry().len(), 8);
    assert!(HARNESS_IDS.contains(&"antigravity"));
    assert!(HARNESS_IDS.contains(&"copilot"));
    assert!(HARNESS_IDS.contains(&"command-code"));
}

#[test]
fn claude_code_watch_config() {
    let h = get_harness("claude-code").unwrap();
    assert_eq!(h.id, "claude-code");
    assert!(h.capabilities.pulse);
    assert!(h.capabilities.trace);
    assert!((h.match_log_file)("D--src-foo/uuid.jsonl"));
    assert!(!(h.match_log_file)("readme.txt"));
    let ctx = (h.ctx_from_path)("D--src-foo/abc-def-123.jsonl").unwrap();
    assert_eq!(ctx.harness, "claude-code");
    assert_eq!(ctx.session_id, "abc-def-123");
    assert_eq!(ctx.slug, "abc-def-");
    assert_eq!(ctx.project_id.as_deref(), Some("D--src-foo"));
}

#[test]
fn pi_ctx_extracts_uuid_after_timestamp() {
    let h = get_harness("pi").unwrap();
    let ctx = (h.ctx_from_path)("--D--src-ebrain--/2026-04-26T14-22-51-638Z_019dca2b.jsonl").unwrap();
    assert_eq!(ctx.harness, "pi");
    assert_eq!(ctx.session_id, "019dca2b");
}

#[test]
fn get_enabled_filters() {
    let enabled = get_enabled_harnesses(&["pi", "opencode"]);
    assert_eq!(enabled.len(), 2);
}

#[test]
fn every_descriptor_has_adapter_and_tokens_cap() {
    for h in harness_registry() {
        assert!(matches!(h.capabilities.tokens, true | false));
        let nrs = (h.adapter)(&[]);
        assert!(nrs.is_empty() || nrs.iter().all(|r| r.is_object()));
    }
}

#[test]
fn adapter_smoke_normalized() {
    let h = get_harness("claude-code").unwrap();
    let nrs = (h.adapter)(&[json!({
        "type": "system",
        "subtype": "compact_boundary",
        "timestamp": "t"
    })]);
    assert_eq!(nrs.len(), 1);
    assert!(is_normalized_record(&nrs[0]));
}

#[test]
fn opencode_match_session_info() {
    let h = get_harness("opencode").unwrap();
    assert!((h.match_log_file)("session/global/ses_abc.json"));
    assert!(!(h.match_log_file)("project/global.json"));
}


#[test]
fn codex_watch_config() {
    let h = get_harness("codex").unwrap();
    assert_eq!(h.label, "Codex");
    assert!((h.match_log_file)(
        "sessions/2026/08/21/rollout-2026-08-21T19-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
    ));
    assert!(!(h.match_log_file)("sessions/foo.jsonl"));
    let ctx = (h.ctx_from_path)(
        "sessions/2026/08/21/rollout-2026-08-21T19-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
    )
    .unwrap();
    assert_eq!(ctx.harness, "codex");
    assert_eq!(ctx.session_id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert_eq!(ctx.slug, "aaaaaaaa");
}

#[test]
fn grok_watch_config() {
    let h = get_harness("grok").unwrap();
    assert_eq!(h.label, "Grok Build");
    assert!(!(h.capabilities.tokens));
    assert!(h.capabilities.context_resets);
    assert!((h.match_log_file)("D%3A%5Csrc%5Cfoo/uuid-here/updates.jsonl"));
    let ctx = (h.ctx_from_path)("D%3A%5Csrc%5CkaaroSessions/019ea1c9-46ee-77e0-bf36-f87a6403b5db/updates.jsonl")
        .unwrap();
    assert_eq!(ctx.harness, "grok");
    assert_eq!(ctx.session_id, "019ea1c9-46ee-77e0-bf36-f87a6403b5db");
    assert_eq!(ctx.project_id.as_deref(), Some("D--src-kaaroSessions"));
}


#[test]
fn antigravity_watch_config() {
    let h = get_harness("antigravity").unwrap();
    assert_eq!(h.label, "Google Antigravity");
    assert!(!h.capabilities.trace);
    assert!((h.match_log_file)("uuid/.system_generated/logs/transcript.jsonl"));
    let ctx = (h.ctx_from_path)("c7f6b422/.system_generated/logs/transcript.jsonl").unwrap();
    assert_eq!(ctx.session_id, "c7f6b422");
}

#[test]
fn copilot_and_command_code_watch() {
    let cp = get_harness("copilot").unwrap();
    assert!((cp.match_log_file)("hash123/chatSessions/abc.jsonl"));
    assert!(!(cp.match_log_file)("hash123/chatSessions/abc.json"));
    let cmd = get_harness("command-code").unwrap();
    assert!((cmd.match_log_file)("proj/sess.jsonl"));
    assert!(!(cmd.match_log_file)("proj/sess.checkpoints.jsonl"));
}
