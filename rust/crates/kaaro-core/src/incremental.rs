//! Incremental analyze — port of `parseSessionFlag` + `mergeSessionIntoData`
//! from `analyze.mjs` (CC `--session=` fast path).

use crate::analyze::analyze_claude_code_session;
use crate::enrich_session::{enrich_project, ProjectSummary as EnrichProject};
use crate::helpers::canonical_project_id;
use crate::session_reducer::Session;
use crate::sessions_output::{
    build_global_rollup, build_project_summary, SessionsData,
};
use std::path::Path;

/// Parsed `--session=projectId/sessionId[.jsonl]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionFlag {
    pub project_id: String,
    pub session_id: String,
}

/// Find `--session=…` in argv-like args. Malformed (no `/`) → None.
pub fn parse_session_flag(args: &[impl AsRef<str>]) -> Option<SessionFlag> {
    let arg = args.iter().map(|a| a.as_ref()).find(|a| a.starts_with("--session="))?;
    let val = &arg["--session=".len()..];
    let slash = val.find('/')?;
    let project_id = val[..slash].to_string();
    let raw_session = &val[slash + 1..];
    let session_id = raw_session
        .strip_suffix(".jsonl")
        .unwrap_or(raw_session)
        .to_string();
    if project_id.is_empty() || session_id.is_empty() {
        return None;
    }
    Some(SessionFlag {
        project_id,
        session_id,
    })
}

/// Replace-or-append one session and recompute project summary + rollup + meta counts.
pub fn merge_session_into_data(existing: &SessionsData, updated: Session) -> SessionsData {
    let project_id = canonical_project_id(&updated.project_id);

    let mut sessions: Vec<Session> = existing
        .sessions
        .iter()
        .filter(|s| s.session_id != updated.session_id)
        .cloned()
        .collect();
    sessions.push(updated);

    let project_sessions: Vec<&Session> = sessions
        .iter()
        .filter(|s| canonical_project_id(&s.project_id) == project_id)
        .collect();
    let mut new_project = build_project_summary(&project_id, &project_sessions);
    let mut raw_ids: Vec<String> = project_sessions
        .iter()
        .map(|s| s.project_id.clone())
        .collect();
    raw_ids.sort();
    raw_ids.dedup();
    new_project.raw_ids = raw_ids;
    let mut harnesses: Vec<String> = project_sessions.iter().map(|s| s.harness.clone()).collect();
    harnesses.sort();
    harnesses.dedup();
    new_project.harnesses = harnesses;
    if let Some(sample) = project_sessions.first() {
        if !sample.project_label.is_empty() {
            new_project.label = sample.project_label.clone();
        }
    }
    let mut ep = EnrichProject {
        id: Some(new_project.id.clone()),
        tokens: new_project.tokens.clone(),
        tokens_work: None,
        tokens_total: None,
    };
    enrich_project(&mut ep);
    new_project.tokens_work = ep.tokens_work;
    new_project.tokens_total = ep.tokens_total;

    let mut projects: Vec<_> = existing
        .projects
        .iter()
        .filter(|p| p.id != project_id)
        .cloned()
        .collect();
    projects.push(new_project);
    projects.sort_by(|a, b| a.id.cmp(&b.id));

    let rollup = build_global_rollup(&sessions);

    let mut meta = existing.meta.clone();
    meta.total_sessions = sessions.len();
    meta.total_projects = projects.len();

    SessionsData {
        meta,
        projects,
        sessions,
        rollup,
    }
}

/// Load existing sessions-data.json, re-analyze one CC session, merge.
/// Returns `Ok(None)` when the output file is missing/unreadable (caller → full scan).
pub fn try_incremental_claude_code(
    sessions_out: &Path,
    project_id: &str,
    session_id: &str,
    cc_root: &Path,
) -> Result<Option<SessionsData>, String> {
    let raw = match std::fs::read_to_string(sessions_out) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let existing: SessionsData = match serde_json::from_str(&raw) {
        Ok(d) => d,
        Err(_) => return Ok(None),
    };
    let file_path = cc_root.join(project_id).join(format!("{session_id}.jsonl"));
    if !file_path.exists() {
        return Err(format!(
            "incremental session file missing: {}",
            file_path.display()
        ));
    }
    let updated = analyze_claude_code_session(project_id, &file_path)?;
    let mut result = merge_session_into_data(&existing, updated);
    result.meta.generated_at = crate::signal_evaluator::now_iso_utc();
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_reducer::{Session, TokenCounts};
    use crate::sessions_output::{DateRange, GlobalRollup, SessionsMeta};
    use std::collections::BTreeMap;

    const TS: &str = "2026-05-01T10:00:00.000Z";

    fn empty_data(sessions: Vec<Session>) -> SessionsData {
        let n = sessions.len();
        SessionsData {
            meta: SessionsMeta {
                generated_at: TS.into(),
                harnesses: vec!["claude-code".into()],
                source_dirs: BTreeMap::new(),
                total_sessions: n,
                total_projects: 0,
                date_range: DateRange {
                    first: None,
                    last: None,
                },
            },
            projects: vec![],
            sessions,
            rollup: GlobalRollup {
                tools: vec![],
                skills: vec![],
                models: BTreeMap::new(),
                tokens: TokenCounts::default(),
                total_errors: 0,
                files: vec![],
            },
        }
    }

    fn make_session(id: &str, project_id: &str, input: i64, output: i64) -> Session {
        Session {
            session_id: id.into(),
            project_id: project_id.into(),
            project_label: project_id.trim_start_matches("proj-").into(),
            harness: "claude-code".into(),
            source: "claude-code".into(),
            file_size_bytes: 1000,
            size_proxy: "tokens_work".into(),
            first_timestamp: Some(TS.into()),
            last_timestamp: Some(TS.into()),
            slug: None,
            duration_ms: None,
            message_count: None,
            version: None,
            entrypoint: None,
            git_branch: Some("main".into()),
            cwd: None,
            permission_mode: None,
            model: Some("claude-sonnet-4-5".into()),
            user_turns: 0,
            assistant_turns: 0,
            tool_calls: 0,
            tool_errors: 0,
            tokens: TokenCounts {
                input,
                cache_create: 0,
                cache_read: 0,
                output,
                ..Default::default()
            },
            tools: BTreeMap::new(),
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
    fn parse_session_flag_cases() {
        assert!(parse_session_flag(&[] as &[&str]).is_none());
        assert!(parse_session_flag(&["node", "analyze"]).is_none());
        let r = parse_session_flag(&["--session=D--src-kaaroSessions/abc123"]).unwrap();
        assert_eq!(r.project_id, "D--src-kaaroSessions");
        assert_eq!(r.session_id, "abc123");
        let r = parse_session_flag(&["--session=D--src-foo/abc123.jsonl"]).unwrap();
        assert_eq!(r.session_id, "abc123");
        assert!(parse_session_flag(&["--session=noseparator"]).is_none());
    }

    #[test]
    fn merge_append_and_immutable() {
        let data = empty_data(vec![]);
        let sess = make_session("new1", "proj-A", 100, 50);
        let result = merge_session_into_data(&data, sess);
        assert_eq!(result.sessions.len(), 1);
        assert_eq!(result.sessions[0].session_id, "new1");
        assert_eq!(data.sessions.len(), 0);
    }

    #[test]
    fn merge_replace_keeps_others() {
        let s1 = make_session("s1", "proj-A", 100, 50);
        let s2 = make_session("s2", "proj-A", 100, 50);
        let data = empty_data(vec![s1, s2]);
        let updated = make_session("s1", "proj-A", 999, 50);
        let result = merge_session_into_data(&data, updated);
        assert_eq!(result.sessions.len(), 2);
        assert_eq!(
            result
                .sessions
                .iter()
                .find(|s| s.session_id == "s2")
                .unwrap()
                .tokens
                .input,
            100
        );
        assert_eq!(
            result
                .sessions
                .iter()
                .find(|s| s.session_id == "s1")
                .unwrap()
                .tokens
                .input,
            999
        );
    }

    #[test]
    fn merge_recomputes_project_and_meta() {
        let data = empty_data(vec![]);
        let result = merge_session_into_data(&data, make_session("s1", "proj-A", 100, 50));
        let proj = result.projects.iter().find(|p| p.id == "proj-A").unwrap();
        assert_eq!(proj.session_count, 1);
        assert_eq!(result.meta.total_sessions, 1);
        assert_eq!(result.meta.total_projects, 1);

        let s1 = make_session("s1", "proj-A", 100, 50);
        let s2 = make_session("s2", "proj-A", 200, 80);
        let data = empty_data(vec![s1, s2]);
        let updated = make_session("s1", "proj-A", 500, 200);
        let result = merge_session_into_data(&data, updated);
        let proj = result.projects.iter().find(|p| p.id == "proj-A").unwrap();
        assert_eq!(proj.tokens.input, 700);
        assert_eq!(proj.tokens.output, 280);
    }
}
