//! Parity tests vs `test/enrich-session.test.mjs` + golden pipeline.
use kaaro_core::adapters::claude_code::records_to_normalized;
use kaaro_core::enrich_session::{enrich_project, enrich_session, tokens_work, ProjectSummary};
use kaaro_core::jsonl::parse_jsonl_str;
use kaaro_core::session_reducer::{
    reduce_session, Capabilities, Session, SessionMeta, TokenCounts, ToolStats,
};
use std::collections::BTreeMap;
use std::path::PathBuf;

fn base_session() -> Session {
    let mut tools = BTreeMap::new();
    tools.insert(
        "Read".into(),
        ToolStats {
            calls: 2,
            errors: 0,
        },
    );
    tools.insert(
        "Write".into(),
        ToolStats {
            calls: 1,
            errors: 0,
        },
    );
    Session {
        session_id: "s".into(),
        project_id: "p".into(),
        project_label: "p".into(),
        harness: "claude-code".into(),
        source: "claude-code".into(),
        file_size_bytes: 0,
        size_proxy: "tokens_work".into(),
        first_timestamp: Some("2026-05-01T14:30:00.000Z".into()),
        last_timestamp: None,
        slug: Some("s".into()),
        duration_ms: Some(120_000),
        message_count: Some(0),
        version: None,
        entrypoint: None,
        git_branch: None,
        cwd: None,
        permission_mode: None,
        model: None,
        user_turns: 0,
        assistant_turns: 0,
        tool_calls: 0,
        tool_errors: 0,
        tokens: TokenCounts {
            input: 100,
            output: 50,
            cache_create: 20,
            cache_read: 80,
            total: None,
        },
        tools,
        file_ops: BTreeMap::new(),
        bash_categories: BTreeMap::new(),
        content_blocks: BTreeMap::new(),
        stop_reasons: BTreeMap::new(),
        skills: vec![],
        builtin_commands: vec![],
        skill_timeline: vec![],
        skill_attribution: BTreeMap::new(),
        first_user_message: None,
        context_resets: 0,
        ai_title: None,
        subagent_count: 0,
        branches: vec![],
        tokens_work: None,
        tokens_total: None,
        cache_hit_rate: None,
        duration_min: None,
        tool_diversity: None,
        day_of_week: None,
        hour_of_day: None,
        date_str: None,
    }
}

#[test]
fn enrich_session_computes_totals_and_cache_hit_rate() {
    let mut s = base_session();
    enrich_session(&mut s);
    assert_eq!(s.tokens.total, Some(250));
    assert_eq!(s.cache_hit_rate, Some(40.0));
    assert_eq!(s.tool_diversity, Some(2));
    assert_eq!(s.duration_min, Some(2.0));
    assert_eq!(s.date_str.as_deref(), Some("2026-05-01"));
    assert_eq!(s.day_of_week, Some(5)); // Friday
    assert_eq!(s.hour_of_day, Some(14));
}

#[test]
fn enrich_session_cache_hit_rate_zero_when_no_input_side() {
    let mut s = base_session();
    s.tokens = TokenCounts::default();
    enrich_session(&mut s);
    assert_eq!(s.cache_hit_rate, Some(0.0));
}

#[test]
fn enrich_session_duration_min_null_when_duration_ms_absent() {
    let mut s = base_session();
    s.duration_ms = None;
    enrich_session(&mut s);
    assert_eq!(s.duration_min, None);
}

#[test]
fn tokens_work_output_plus_cache_create() {
    assert_eq!(
        tokens_work(Some(&TokenCounts {
            output: 80,
            cache_create: 20,
            ..Default::default()
        })),
        100
    );
    assert_eq!(
        tokens_work(Some(&TokenCounts {
            output: 5,
            ..Default::default()
        })),
        5
    );
    assert_eq!(tokens_work(Some(&TokenCounts::default())), 0);
    assert_eq!(tokens_work(None), 0);
}

#[test]
fn enrich_session_sets_tokens_work() {
    let mut s = base_session(); // output 50 + cache_create 20
    enrich_session(&mut s);
    assert_eq!(s.tokens_work, Some(70));
}

#[test]
fn enrich_session_sets_tokens_total_top_level() {
    let mut s = base_session();
    enrich_session(&mut s);
    assert_eq!(s.tokens_total, Some(250));
    assert_eq!(s.tokens_total, s.tokens.total);
}

#[test]
fn enrich_project_sets_tokens_work_and_total() {
    let mut p = ProjectSummary {
        id: Some("proj-a".into()),
        tokens: TokenCounts {
            input: 100,
            output: 200,
            cache_create: 50,
            cache_read: 30,
            total: None,
        },
        tokens_work: None,
        tokens_total: None,
    };
    enrich_project(&mut p);
    assert_eq!(p.tokens_work, Some(250));
    assert_eq!(p.tokens_total, Some(380));
}

#[test]
fn golden_normalize_reduce_enrich() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join("claude_code_golden.jsonl");
    let raw = std::fs::read_to_string(&path).unwrap();
    let nrs = records_to_normalized(&parse_jsonl_str(&raw).unwrap());
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
    let mut s = reduce_session(&nrs, &meta);
    enrich_session(&mut s);

    // tokens from golden: 100/50/10/20 → total 180, work 60, hit 20/(100+10+20)*100 = 15.4
    assert_eq!(s.tokens.total, Some(180));
    assert_eq!(s.tokens_work, Some(60));
    assert_eq!(s.tokens_total, Some(180));
    assert_eq!(s.cache_hit_rate, Some(15.4));
    assert_eq!(s.duration_min, Some(3.0)); // 180000 ms
    assert_eq!(s.tool_diversity, Some(3)); // Read, Agent, Bash
    assert_eq!(s.date_str.as_deref(), Some("2026-05-01"));
    assert_eq!(s.hour_of_day, Some(10));
}
