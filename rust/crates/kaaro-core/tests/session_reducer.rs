//! Parity tests vs `test/session-reducer.test.mjs` + Claude golden pipeline.
use kaaro_core::adapters::claude_code::records_to_normalized;
use kaaro_core::jsonl::parse_jsonl_str;
use kaaro_core::session_reducer::{reduce_session, Capabilities, SessionMeta};
use serde_json::json;
use std::path::PathBuf;

fn meta() -> SessionMeta {
    SessionMeta {
        session_id: "sess-uuid-1234".into(),
        project_id: "D--src-foo".into(),
        project_label: "foo".into(),
        harness: "claude-code".into(),
        file_size_bytes: 1024,
        capabilities: Some(Capabilities {
            size_proxy: Some("tokens_work".into()),
        }),
    }
}

const TS1: &str = "2026-05-01T10:00:00.000Z";
const TS2: &str = "2026-05-01T10:05:00.000Z";

#[test]
fn user_and_assistant_turn_counts() {
    let s = reduce_session(
        &[
            json!({"kind": "user_turn", "harness": "claude-code", "ts": TS1, "text": "fix the bug please"}),
            json!({"kind": "assistant_turn", "harness": "claude-code", "ts": TS2, "model": "claude-sonnet-4-6"}),
        ],
        &meta(),
    );
    assert_eq!(s.user_turns, 1);
    assert_eq!(s.assistant_turns, 1);
    assert_eq!(s.first_timestamp.as_deref(), Some(TS1));
    assert_eq!(s.last_timestamp.as_deref(), Some(TS2));
    assert_eq!(s.model.as_deref(), Some("claude-sonnet-4-6"));
}

#[test]
fn content_block_populates_map_without_affecting_turns() {
    let s = reduce_session(
        &[
            json!({"kind": "assistant_turn", "harness": "claude-code", "ts": TS1}),
            json!({"kind": "content_block", "harness": "claude-code", "ts": TS1, "block_type": "text"}),
            json!({"kind": "content_block", "harness": "claude-code", "ts": TS1, "block_type": "tool_use"}),
            json!({"kind": "content_block", "harness": "claude-code", "ts": TS1, "block_type": "thinking"}),
            json!({"kind": "content_block", "harness": "claude-code", "ts": TS1, "block_type": "tool_use"}),
        ],
        &meta(),
    );
    assert_eq!(s.assistant_turns, 1);
    assert_eq!(s.content_blocks.get("text"), Some(&1));
    assert_eq!(s.content_blocks.get("tool_use"), Some(&2));
    assert_eq!(s.content_blocks.get("thinking"), Some(&1));
}

#[test]
fn tool_use_and_file_ops() {
    let s = reduce_session(
        &[
            json!({"kind": "tool_use", "harness": "claude-code", "ts": TS1, "tool": "Read",
                   "input": {"file_path": "D:/src/foo.js"}}),
            json!({"kind": "tool_use", "harness": "claude-code", "ts": TS1, "tool": "Write",
                   "input": {"file_path": "D:/src/foo.js"}}),
            json!({"kind": "tool_use", "harness": "claude-code", "ts": TS1, "tool": "Bash",
                   "input": {"command": "git status"}}),
        ],
        &meta(),
    );
    assert_eq!(s.tool_calls, 3);
    assert_eq!(s.tools["Read"].calls, 1);
    assert_eq!(s.file_ops["d:/src/foo.js"].read, 1);
    assert_eq!(s.file_ops["d:/src/foo.js"].write, 1);
    assert_eq!(s.bash_categories.get("git"), Some(&1));
}

#[test]
fn tool_use_paths_array_credits_every_path_once_per_call() {
    let mut m = meta();
    m.harness = "codex".into();
    let s = reduce_session(
        &[json!({
            "kind": "tool_use", "harness": "codex", "ts": TS1, "tool": "apply_patch",
            "input": {"paths": ["a.mjs", "b.mjs"]}
        })],
        &m,
    );
    assert_eq!(s.tool_calls, 1);
    assert_eq!(s.tools["apply_patch"].calls, 1);
    assert_eq!(s.file_ops["a.mjs"].edit, 1);
    assert_eq!(s.file_ops["b.mjs"].edit, 1);
}

#[test]
fn tokens_accumulation() {
    let s = reduce_session(
        &[
            json!({"kind": "tokens", "harness": "claude-code", "ts": TS1,
                   "tokens": {"input": 10, "output": 20, "cache_create": 5, "cache_read": 3}}),
            json!({"kind": "tokens", "harness": "claude-code", "ts": TS2,
                   "tokens": {"input": 1, "output": 2, "cache_create": 0, "cache_read": 7}}),
        ],
        &meta(),
    );
    assert_eq!(s.tokens.input, 11);
    assert_eq!(s.tokens.output, 22);
    assert_eq!(s.tokens.cache_create, 5);
    assert_eq!(s.tokens.cache_read, 10);
}

#[test]
fn context_reset_and_ai_title() {
    let s = reduce_session(
        &[
            json!({"kind": "context_reset", "harness": "claude-code", "ts": TS1}),
            json!({"kind": "context_reset", "harness": "claude-code", "ts": TS2}),
            json!({"kind": "session_meta", "harness": "claude-code", "ts": TS1, "ai_title": "Fix parser"}),
        ],
        &meta(),
    );
    assert_eq!(s.context_resets, 2);
    assert_eq!(s.ai_title.as_deref(), Some("Fix parser"));
}

#[test]
fn subagent_count_from_agent_tool() {
    let s = reduce_session(
        &[
            json!({"kind": "tool_use", "harness": "claude-code", "ts": TS1, "tool": "Agent", "input": {}}),
            json!({"kind": "tool_use", "harness": "claude-code", "ts": TS1, "tool": "Agent", "input": {}}),
        ],
        &meta(),
    );
    assert_eq!(s.subagent_count, 2);
}

#[test]
fn branches_deduped() {
    let s = reduce_session(
        &[
            json!({"kind": "branch_change", "harness": "claude-code", "ts": TS1, "branch": "main"}),
            json!({"kind": "branch_change", "harness": "claude-code", "ts": TS2, "branch": "feature"}),
            json!({"kind": "branch_change", "harness": "claude-code", "ts": TS2, "branch": "main"}),
        ],
        &meta(),
    );
    assert_eq!(s.branches, vec!["main".to_string(), "feature".to_string()]);
    assert_eq!(s.git_branch.as_deref(), Some("main"));
}

#[test]
fn skills_and_builtin_commands() {
    let s = reduce_session(
        &[
            json!({"kind": "skill_invoke", "harness": "claude-code", "ts": TS1, "skill": "visualize-seed"}),
            json!({"kind": "skill_invoke", "harness": "claude-code", "ts": TS1, "skill": "compact"}),
            json!({"kind": "skill_invoke", "harness": "claude-code", "ts": TS1, "skill": "visualize-seed"}),
        ],
        &meta(),
    );
    assert_eq!(s.skills, vec!["visualize-seed".to_string()]);
    assert_eq!(s.builtin_commands, vec!["compact".to_string()]);
}

#[test]
fn skill_timeline_and_attribution_default_empty() {
    let s = reduce_session(
        &[json!({"kind": "tool_use", "harness": "claude-code", "ts": TS1, "tool": "Read", "input": {}})],
        &meta(),
    );
    assert!(s.skill_timeline.is_empty());
    assert!(s.skill_attribution.is_empty());
}

#[test]
fn skill_timeline_chronological_builtins_excluded() {
    let s = reduce_session(
        &[
            json!({"kind": "skill_invoke", "harness": "claude-code", "ts": TS1, "skill": "visualize-seed"}),
            json!({"kind": "skill_invoke", "harness": "claude-code", "ts": "2026-05-01T10:02:00.000Z", "skill": "compact"}),
            json!({"kind": "skill_invoke", "harness": "claude-code", "ts": TS2, "skill": "web-seo"}),
            json!({"kind": "skill_invoke", "harness": "claude-code", "ts": "2026-05-01T10:06:00.000Z", "skill": "visualize-seed"}),
        ],
        &meta(),
    );
    assert_eq!(s.skill_timeline.len(), 3);
    assert_eq!(s.skill_timeline[0].skill, "visualize-seed");
    assert_eq!(s.skill_timeline[0].ts, TS1);
    assert_eq!(s.skill_timeline[1].skill, "web-seo");
    assert_eq!(s.skill_timeline[1].ts, TS2);
    assert_eq!(s.skill_timeline[2].skill, "visualize-seed");
    assert!(!s.skill_timeline.iter().any(|e| e.skill == "compact"));
    assert_eq!(s.builtin_commands, vec!["compact".to_string()]);
}

#[test]
fn skill_attribution_window_tools_between_invokes() {
    let s = reduce_session(
        &[
            json!({"kind": "skill_invoke", "harness": "claude-code", "ts": TS1, "skill": "visualize-seed"}),
            json!({"kind": "tool_use", "harness": "claude-code", "ts": "t1", "tool": "Read", "input": {}}),
            json!({"kind": "tool_use", "harness": "claude-code", "ts": "t2", "tool": "Write", "input": {}}),
            json!({"kind": "tool_use", "harness": "claude-code", "ts": "t3", "tool": "Read", "input": {}}),
            json!({"kind": "skill_invoke", "harness": "claude-code", "ts": TS2, "skill": "web-seo"}),
            json!({"kind": "tool_use", "harness": "claude-code", "ts": "t4", "tool": "Bash", "input": {"command": "ls"}}),
            json!({"kind": "tool_result", "harness": "claude-code", "ts": "t5", "tool": "Bash", "error": true}),
        ],
        &meta(),
    );
    let vs = &s.skill_attribution["visualize-seed"];
    assert_eq!(vs.tool_calls, 3);
    assert_eq!(vs.tools.get("Read"), Some(&2));
    assert_eq!(vs.tools.get("Write"), Some(&1));
    assert_eq!(vs.errors, 0);
    let ws = &s.skill_attribution["web-seo"];
    assert_eq!(ws.tool_calls, 1);
    assert_eq!(ws.tools.get("Bash"), Some(&1));
    assert_eq!(ws.errors, 1);
}

#[test]
fn skill_attribution_dies_at_context_reset() {
    let s = reduce_session(
        &[
            json!({"kind": "skill_invoke", "harness": "claude-code", "ts": TS1, "skill": "visualize-seed"}),
            json!({"kind": "tool_use", "harness": "claude-code", "ts": "t1", "tool": "Read", "input": {}}),
            json!({"kind": "context_reset", "harness": "claude-code", "ts": "t2"}),
            json!({"kind": "tool_use", "harness": "claude-code", "ts": "t3", "tool": "Write", "input": {}}),
            json!({"kind": "tool_result", "harness": "claude-code", "ts": "t4", "tool": "Write", "error": true}),
        ],
        &meta(),
    );
    assert_eq!(s.context_resets, 1);
    let vs = &s.skill_attribution["visualize-seed"];
    assert_eq!(vs.tool_calls, 1);
    assert_eq!(vs.tools.get("Read"), Some(&1));
    assert_eq!(vs.errors, 0);
    assert_eq!(s.tool_calls, 2);
    assert_eq!(s.tool_errors, 1);
}

#[test]
fn skill_invoke_with_no_tools_seeds_attribution() {
    let s = reduce_session(
        &[json!({"kind": "skill_invoke", "harness": "claude-code", "ts": TS1, "skill": "web-seo"})],
        &meta(),
    );
    assert_eq!(s.skill_timeline.len(), 1);
    assert_eq!(s.skill_timeline[0].skill, "web-seo");
    let a = &s.skill_attribution["web-seo"];
    assert_eq!(a.tool_calls, 0);
    assert!(a.tools.is_empty());
    assert_eq!(a.errors, 0);
}

#[test]
fn tools_before_skill_invoke_unattributed() {
    let s = reduce_session(
        &[
            json!({"kind": "tool_use", "harness": "claude-code", "ts": TS1, "tool": "Read", "input": {}}),
            json!({"kind": "skill_invoke", "harness": "claude-code", "ts": TS2, "skill": "web-seo"}),
            json!({"kind": "tool_use", "harness": "claude-code", "ts": "t3", "tool": "Write", "input": {}}),
        ],
        &meta(),
    );
    let a = &s.skill_attribution["web-seo"];
    assert_eq!(a.tool_calls, 1);
    assert_eq!(a.tools.get("Write"), Some(&1));
    assert_eq!(s.tool_calls, 2);
}

#[test]
fn tool_result_errors() {
    let s = reduce_session(
        &[json!({"kind": "tool_result", "harness": "claude-code", "ts": TS1, "error": true, "tool": "Bash"})],
        &meta(),
    );
    assert_eq!(s.tool_errors, 1);
}

#[test]
fn tokenless_harness_sets_size_proxy() {
    let mut m = meta();
    m.harness = "antigravity".into();
    m.capabilities = Some(Capabilities {
        size_proxy: Some("tool_calls".into()),
    });
    let s = reduce_session(
        &[
            json!({"kind": "tool_use", "harness": "antigravity", "ts": TS1, "tool": "view_file", "input": {}}),
            json!({"kind": "tool_use", "harness": "antigravity", "ts": TS1, "tool": "view_file", "input": {}}),
        ],
        &m,
    );
    assert_eq!(s.size_proxy, "tool_calls");
    assert_eq!(s.tokens.output, 0);
}

#[test]
fn first_user_message_from_user_turn() {
    let s = reduce_session(
        &[json!({
            "kind": "user_turn", "harness": "claude-code", "ts": TS1,
            "text": "Please refactor the session reducer module"
        })],
        &meta(),
    );
    assert_eq!(
        s.first_user_message.as_deref(),
        Some("Please refactor the session reducer module")
    );
}

#[test]
fn session_meta_slug_and_duration() {
    let s = reduce_session(
        &[json!({
            "kind": "session_meta", "harness": "claude-code", "ts": TS1,
            "slug": "happy-slug", "duration_ms": 60000, "message_count": 4
        })],
        &meta(),
    );
    assert_eq!(s.slug.as_deref(), Some("happy-slug"));
    assert_eq!(s.duration_ms, Some(60000));
    assert_eq!(s.message_count, Some(4));
}

#[test]
fn slug_fallback_to_session_id_prefix() {
    let s = reduce_session(&[], &meta());
    assert_eq!(s.slug.as_deref(), Some("sess-uui"));
    assert_eq!(s.message_count, Some(0));
}

#[test]
fn claude_golden_jsonl_normalize_then_reduce() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join("claude_code_golden.jsonl");
    let raw = std::fs::read_to_string(&path).unwrap();
    let records = parse_jsonl_str(&raw).unwrap();
    let nrs = records_to_normalized(&records);
    let meta = SessionMeta {
        session_id: "golden-sess".into(),
        project_id: "D--src-myapp".into(),
        project_label: "myapp".into(),
        harness: "claude-code".into(),
        file_size_bytes: raw.len() as u64,
        capabilities: Some(Capabilities {
            size_proxy: Some("tokens_work".into()),
        }),
    };
    let s = reduce_session(&nrs, &meta);

    assert_eq!(s.session_id, "golden-sess");
    assert_eq!(s.harness, "claude-code");
    assert_eq!(s.user_turns, 1);
    assert_eq!(s.assistant_turns, 1);
    assert_eq!(s.context_resets, 1);
    assert_eq!(s.ai_title.as_deref(), Some("Auth fix session"));
    assert_eq!(s.slug.as_deref(), Some("auth-fix-slug"));
    assert_eq!(s.duration_ms, Some(180000));
    assert_eq!(s.message_count, Some(2));
    assert_eq!(s.git_branch.as_deref(), Some("main"));
    assert_eq!(s.branches, vec!["main".to_string()]);
    assert!(s.skills.contains(&"review".to_string()) || s.builtin_commands.contains(&"review".to_string()));
    // "review" is a BUILTIN_COMMAND in JS
    assert!(s.builtin_commands.contains(&"review".to_string()));
    assert_eq!(s.tool_calls, 3);
    assert_eq!(s.subagent_count, 1); // Agent tool
    assert_eq!(s.tokens.input, 100);
    assert_eq!(s.tokens.output, 50);
    assert_eq!(s.tokens.cache_create, 10);
    assert_eq!(s.tokens.cache_read, 20);
    assert!(s.tools.contains_key("Read"));
    assert!(s.tools.contains_key("Bash"));
    assert!(s.tools.contains_key("Agent"));
    assert_eq!(s.file_ops["d:/src/app/auth.js"].read, 1);
    assert_eq!(s.bash_categories.get("git"), Some(&1));
    assert!(s.first_user_message.as_ref().unwrap().contains("fix the auth"));
    assert_eq!(s.first_timestamp.as_deref(), Some("2026-05-01T10:00:00.000Z"));
    assert_eq!(s.last_timestamp.as_deref(), Some("2026-05-01T10:03:00.000Z"));
    // content_blocks include the 3 tool_use blocks
    assert!(s.content_blocks.get("tool_use").copied().unwrap_or(0) >= 3);
}

#[test]
fn message_count_fallback_from_turns() {
    let s = reduce_session(
        &[
            json!({"kind": "user_turn", "harness": "claude-code", "ts": TS1, "text": "hello there friend"}),
            json!({"kind": "assistant_turn", "harness": "claude-code", "ts": TS2}),
        ],
        &meta(),
    );
    assert_eq!(s.message_count, Some(2));
}
