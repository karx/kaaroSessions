//! Merge scan envelopes → sessions-data.json shape.
//! Port of `surface/analyze-orchestrator.mjs` + `buildProjectSummary` /
//! `buildGlobalRollup` from `analyze.mjs`.

use crate::enrich_session::{enrich_project, ProjectSummary as EnrichProject};
use crate::helpers::{canonical_project_id, derive_label};
use crate::scan_walk::ScanEnvelope;
use crate::session_reducer::{Session, TokenCounts};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectSummary {
    pub id: String,
    pub label: String,
    pub session_count: i64,
    pub tokens: TokenCounts,
    pub tool_calls: i64,
    pub tool_errors: i64,
    pub skills: Vec<String>,
    pub builtin_commands: Vec<String>,
    pub models: BTreeMap<String, i64>,
    pub git_branches: Vec<String>,
    pub total_bytes: u64,
    pub duration_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_work: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_total: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub raw_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub harnesses: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RollupTool {
    pub name: String,
    pub calls: i64,
    pub errors: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RollupSkill {
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RollupFile {
    pub path: String,
    pub read: i64,
    pub write: i64,
    pub edit: i64,
    pub sessions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GlobalRollup {
    pub tools: Vec<RollupTool>,
    pub skills: Vec<RollupSkill>,
    pub models: BTreeMap<String, i64>,
    pub tokens: TokenCounts,
    pub total_errors: i64,
    pub files: Vec<RollupFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionsMeta {
    pub generated_at: String,
    pub harnesses: Vec<String>,
    pub source_dirs: BTreeMap<String, String>,
    pub total_sessions: usize,
    pub total_projects: usize,
    pub date_range: DateRange,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DateRange {
    pub first: Option<String>,
    pub last: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionsData {
    pub meta: SessionsMeta,
    pub projects: Vec<ProjectSummary>,
    pub sessions: Vec<Session>,
    pub rollup: GlobalRollup,
}

/// Aggregate sessions into a project summary (pre-enrich).
pub fn build_project_summary(project_id: &str, sessions: &[&Session]) -> ProjectSummary {
    let mut s = ProjectSummary {
        id: project_id.into(),
        label: derive_label(project_id),
        session_count: sessions.len() as i64,
        tokens: TokenCounts::default(),
        tool_calls: 0,
        tool_errors: 0,
        skills: Vec::new(),
        builtin_commands: Vec::new(),
        models: BTreeMap::new(),
        git_branches: Vec::new(),
        total_bytes: 0,
        duration_ms: 0,
        tokens_work: None,
        tokens_total: None,
        raw_ids: Vec::new(),
        harnesses: Vec::new(),
    };

    for sess in sessions {
        s.tokens.input += sess.tokens.input;
        s.tokens.cache_create += sess.tokens.cache_create;
        s.tokens.cache_read += sess.tokens.cache_read;
        s.tokens.output += sess.tokens.output;
        s.tool_calls += sess.tool_calls;
        s.tool_errors += sess.tool_errors;
        s.total_bytes += sess.file_size_bytes;
        if let Some(ms) = sess.duration_ms {
            s.duration_ms += ms;
        }
        for sk in &sess.skills {
            if !s.skills.contains(sk) {
                s.skills.push(sk.clone());
            }
        }
        for cmd in &sess.builtin_commands {
            if !s.builtin_commands.contains(cmd) {
                s.builtin_commands.push(cmd.clone());
            }
        }
        if let Some(model) = &sess.model {
            *s.models.entry(model.clone()).or_insert(0) += 1;
        }
        if let Some(branch) = &sess.git_branch {
            if !s.git_branches.contains(branch) {
                s.git_branches.push(branch.clone());
            }
        }
    }
    s.git_branches.sort();
    s.skills.sort();
    s.builtin_commands.sort();
    s
}

/// Global rollup across all sessions.
pub fn build_global_rollup(sessions: &[Session]) -> GlobalRollup {
    let mut tools: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    let mut skills: BTreeMap<String, i64> = BTreeMap::new();
    let mut models: BTreeMap<String, i64> = BTreeMap::new();
    let mut tokens = TokenCounts::default();
    let mut errors = 0i64;
    let mut file_map: BTreeMap<String, RollupFile> = BTreeMap::new();

    for sess in sessions {
        tokens.input += sess.tokens.input;
        tokens.cache_create += sess.tokens.cache_create;
        tokens.cache_read += sess.tokens.cache_read;
        tokens.output += sess.tokens.output;
        errors += sess.tool_errors;

        for (name, data) in &sess.tools {
            let e = tools.entry(name.clone()).or_insert((0, 0));
            e.0 += data.calls;
            e.1 += data.errors;
        }
        for sk in &sess.skills {
            *skills.entry(sk.clone()).or_insert(0) += 1;
        }
        if let Some(model) = &sess.model {
            *models.entry(model.clone()).or_insert(0) += 1;
        }
        for (fp, ops) in &sess.file_ops {
            let entry = file_map.entry(fp.clone()).or_insert_with(|| RollupFile {
                path: fp.clone(),
                read: 0,
                write: 0,
                edit: 0,
                sessions: Vec::new(),
            });
            entry.read += ops.read;
            entry.write += ops.write;
            entry.edit += ops.edit;
            if !entry.sessions.contains(&sess.session_id) {
                entry.sessions.push(sess.session_id.clone());
            }
        }
    }

    let mut tools_vec: Vec<RollupTool> = tools
        .into_iter()
        .map(|(name, (calls, errors))| RollupTool { name, calls, errors })
        .collect();
    tools_vec.sort_by(|a, b| b.calls.cmp(&a.calls).then(a.name.cmp(&b.name)));

    let mut skills_vec: Vec<RollupSkill> = skills
        .into_iter()
        .map(|(name, count)| RollupSkill { name, count })
        .collect();
    skills_vec.sort_by(|a, b| b.count.cmp(&a.count).then(a.name.cmp(&b.name)));

    let mut files: Vec<RollupFile> = file_map.into_values().collect();
    files.sort_by(|a, b| {
        let ta = b.write + b.edit + b.read;
        let tb = a.write + a.edit + a.read;
        ta.cmp(&tb).then(a.path.cmp(&b.path))
    });

    GlobalRollup {
        tools: tools_vec,
        skills: skills_vec,
        models,
        tokens,
        total_errors: errors,
        files,
    }
}

fn now_iso() -> String {
    // Prefer clock; fall back for exotic envs.
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    crate::helpers::ms_to_iso(ms)
}

/// Merge harness scan results into sessions-data.json shape.
pub fn build_sessions_output(scan_results: &[ScanEnvelope]) -> SessionsData {
    let mut all_sessions: Vec<Session> = Vec::new();
    for r in scan_results {
        all_sessions.extend(r.sessions.clone());
    }
    all_sessions.sort_by(|a, b| {
        let ta = a.first_timestamp.as_deref().unwrap_or("");
        let tb = b.first_timestamp.as_deref().unwrap_or("");
        ta.cmp(tb)
    });

    let mut project_map: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, sess) in all_sessions.iter().enumerate() {
        let key = canonical_project_id(&sess.project_id);
        project_map.entry(key).or_default().push(i);
    }

    let mut projects = Vec::new();
    for (id, idxs) in &project_map {
        let bucket: Vec<&Session> = idxs.iter().map(|&i| &all_sessions[i]).collect();
        let mut proj = build_project_summary(id, &bucket);
        if let Some(sample) = bucket.first() {
            if !sample.project_label.is_empty() {
                proj.label = sample.project_label.clone();
            }
        }
        let mut raw_ids: Vec<String> = bucket.iter().map(|s| s.project_id.clone()).collect();
        raw_ids.sort();
        raw_ids.dedup();
        proj.raw_ids = raw_ids;
        let mut harnesses: Vec<String> = bucket.iter().map(|s| s.harness.clone()).collect();
        harnesses.sort();
        harnesses.dedup();
        proj.harnesses = harnesses;

        // enrich via shared token arithmetic
        let mut ep = EnrichProject {
            id: Some(proj.id.clone()),
            tokens: proj.tokens.clone(),
            tokens_work: None,
            tokens_total: None,
        };
        enrich_project(&mut ep);
        proj.tokens_work = ep.tokens_work;
        proj.tokens_total = ep.tokens_total;
        projects.push(proj);
    }

    let first = all_sessions
        .iter()
        .find(|s| s.first_timestamp.is_some())
        .and_then(|s| s.first_timestamp.clone());
    let last = all_sessions
        .iter()
        .rev()
        .find(|s| s.last_timestamp.is_some())
        .and_then(|s| s.last_timestamp.clone());

    let harnesses: Vec<String> = scan_results.iter().map(|r| r.harness.clone()).collect();
    let mut source_dirs = BTreeMap::new();
    for r in scan_results {
        source_dirs.insert(r.harness.clone(), r.source_dir.display().to_string());
    }

    let rollup = build_global_rollup(&all_sessions);
    let total_projects = projects.len();
    let total_sessions = all_sessions.len();

    SessionsData {
        meta: SessionsMeta {
            generated_at: now_iso(),
            harnesses,
            source_dirs,
            total_sessions,
            total_projects,
            date_range: DateRange { first, last },
        },
        projects,
        sessions: all_sessions,
        rollup,
    }
}

/// Serialize sessions-data.json (pretty, JS-ish).
pub fn sessions_data_to_json(data: &SessionsData) -> Result<String, serde_json::Error> {
    serde_json::to_string_pretty(data)
}

/// Convenience: Value view for tests.
pub fn sessions_data_to_value(data: &SessionsData) -> Value {
    serde_json::to_value(data).unwrap_or_else(|_| json!({}))
}

/// Minimal schema check mirroring `validateSessionsData` required fields.
pub fn validate_sessions_data(data: &Value) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    let Some(obj) = data.as_object() else {
        return Err(vec!["root must be an object".into()]);
    };
    if !obj.get("projects").map(|v| v.is_array()).unwrap_or(false) {
        errors.push("missing: data.projects (array)".into());
    }
    if !obj.get("sessions").map(|v| v.is_array()).unwrap_or(false) {
        errors.push("missing: data.sessions (array)".into());
    }
    if !obj.get("meta").map(|v| v.is_object()).unwrap_or(false) {
        errors.push("missing: data.meta (object)".into());
    }
    if let Some(projects) = obj.get("projects").and_then(|p| p.as_array()) {
        for (i, p) in projects.iter().enumerate() {
            if p.get("id").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                errors.push(format!("projects[{i}]: missing id"));
            }
            if p.get("label").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                errors.push(format!("projects[{i}]: missing label"));
            }
            if !p.get("session_count").map(|v| v.is_number()).unwrap_or(false) {
                errors.push(format!("projects[{i}]: session_count must be number"));
            }
            if let Some(tok) = p.get("tokens").and_then(|t| t.as_object()) {
                for k in ["input", "output", "cache_create", "cache_read"] {
                    if !tok.get(k).map(|v| v.is_number()).unwrap_or(false) {
                        errors.push(format!("projects[{i}]: tokens.{k} must be number"));
                    }
                }
            } else {
                errors.push(format!("projects[{i}]: missing tokens object"));
            }
        }
    }
    if let Some(sessions) = obj.get("sessions").and_then(|s| s.as_array()) {
        for (i, s) in sessions.iter().enumerate() {
            if s.get("session_id").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                errors.push(format!("sessions[{i}]: missing session_id"));
            }
            if s.get("project_id").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                errors.push(format!("sessions[{i}]: missing project_id"));
            }
            if !s.get("tokens").map(|v| v.is_object()).unwrap_or(false) {
                errors.push(format!("sessions[{i}]: missing tokens object"));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

