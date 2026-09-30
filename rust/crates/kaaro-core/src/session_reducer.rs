//! Fold NormalizedRecord[] into a canonical session object.
//! Port of `hooks/session-reducer.mjs`. Pure — no I/O. Call `enrich_session` afterwards for derived fields.

use crate::helpers::{categorize_bash, is_bash_tool_name, is_builtin_command, norm_path};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Identity + capabilities passed into [`reduce_session`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub session_id: String,
    pub project_id: String,
    pub project_label: String,
    pub harness: String,
    #[serde(default)]
    pub file_size_bytes: u64,
    #[serde(default)]
    pub capabilities: Option<Capabilities>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Capabilities {
    #[serde(default)]
    pub size_proxy: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TokenCounts {
    pub input: i64,
    pub cache_create: i64,
    pub cache_read: i64,
    pub output: i64,
    /// Set by [`crate::enrich_session::enrich_session`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
}

impl Default for TokenCounts {
    fn default() -> Self {
        Self {
            input: 0,
            cache_create: 0,
            cache_read: 0,
            output: 0,
            total: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ToolStats {
    pub calls: i64,
    pub errors: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FileOpCounts {
    pub read: i64,
    pub write: i64,
    pub edit: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SkillTimelineEntry {
    pub skill: String,
    pub ts: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SkillAttribution {
    pub tool_calls: i64,
    pub tools: BTreeMap<String, i64>,
    pub errors: i64,
}

/// Canonical session bundle produced by the reducer (pre-enrich).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Session {
    pub session_id: String,
    pub project_id: String,
    pub project_label: String,
    pub harness: String,
    pub source: String,
    pub file_size_bytes: u64,
    pub size_proxy: String,

    pub first_timestamp: Option<String>,
    pub last_timestamp: Option<String>,
    pub slug: Option<String>,
    pub duration_ms: Option<i64>,
    pub message_count: Option<i64>,
    pub version: Option<String>,
    pub entrypoint: Option<String>,
    pub git_branch: Option<String>,
    pub cwd: Option<String>,
    pub permission_mode: Option<String>,
    pub model: Option<String>,

    pub user_turns: i64,
    pub assistant_turns: i64,
    pub tool_calls: i64,
    pub tool_errors: i64,

    pub tokens: TokenCounts,
    pub tools: BTreeMap<String, ToolStats>,
    pub file_ops: BTreeMap<String, FileOpCounts>,
    pub bash_categories: BTreeMap<String, i64>,
    pub content_blocks: BTreeMap<String, i64>,
    pub stop_reasons: BTreeMap<String, i64>,
    pub skills: Vec<String>,
    pub builtin_commands: Vec<String>,
    pub skill_timeline: Vec<SkillTimelineEntry>,
    pub skill_attribution: BTreeMap<String, SkillAttribution>,
    pub first_user_message: Option<String>,
    pub context_resets: i64,
    pub ai_title: Option<String>,
    pub subagent_count: i64,
    pub branches: Vec<String>,

    // ── enriched (set by enrich_session) ──────────────────────────────────
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_work: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_total: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_hit_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_diversity: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day_of_week: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hour_of_day: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_str: Option<String>,
}

/// File-op tool name → read|write|edit (JS `FILE_OP_TOOLS`).
fn file_op_for(tool: &str) -> Option<&'static str> {
    match tool {
        "Read" | "read" | "view_file" | "readFile" | "read_file" => Some("read"),
        "Write" | "write" | "write_to_file" | "createFile" | "create_file" => Some("write"),
        "Edit" | "edit" | "StrReplace" | "EditNotebook" | "replace_file_content"
        | "multi_replace_file_content" | "editFile" | "replaceString" | "applyPatch"
        | "insert_edit_into_file" | "replace_string_in_file" | "apply_patch" => Some("edit"),
        _ => None,
    }
}

fn file_path_from_input(input: &Value) -> Option<&str> {
    input
        .get("file_path")
        .or_else(|| input.get("path"))
        .or_else(|| input.get("AbsolutePath"))
        .or_else(|| input.get("TargetFile"))
        .and_then(|v| v.as_str())
}

fn empty_session(meta: &SessionMeta) -> Session {
    let size_proxy = meta
        .capabilities
        .as_ref()
        .and_then(|c| c.size_proxy.clone())
        .unwrap_or_else(|| "tokens_work".into());
    Session {
        session_id: meta.session_id.clone(),
        project_id: meta.project_id.clone(),
        project_label: meta.project_label.clone(),
        harness: meta.harness.clone(),
        source: meta.harness.clone(),
        file_size_bytes: meta.file_size_bytes,
        size_proxy,
        first_timestamp: None,
        last_timestamp: None,
        slug: None,
        duration_ms: None,
        message_count: None,
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
        tokens: TokenCounts::default(),
        tools: BTreeMap::new(),
        file_ops: BTreeMap::new(),
        bash_categories: BTreeMap::new(),
        content_blocks: BTreeMap::new(),
        stop_reasons: BTreeMap::new(),
        skills: Vec::new(),
        builtin_commands: Vec::new(),
        skill_timeline: Vec::new(),
        skill_attribution: BTreeMap::new(),
        first_user_message: None,
        context_resets: 0,
        ai_title: None,
        subagent_count: 0,
        branches: Vec::new(),
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

fn ts_key(ts: &Value) -> Option<String> {
    match ts {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn track_ts(session: &mut Session, ts: &Value) {
    let Some(key) = ts_key(ts) else {
        return;
    };
    if session
        .first_timestamp
        .as_ref()
        .map(|f| key.as_str() < f.as_str())
        .unwrap_or(true)
    {
        session.first_timestamp = Some(key.clone());
    }
    if session
        .last_timestamp
        .as_ref()
        .map(|l| key.as_str() > l.as_str())
        .unwrap_or(true)
    {
        session.last_timestamp = Some(key);
    }
}

fn add_branch(session: &mut Session, branch: Option<&str>) {
    let Some(branch) = branch.filter(|b| !b.is_empty()) else {
        return;
    };
    if session.git_branch.is_none() {
        session.git_branch = Some(branch.to_string());
    }
    if !session.branches.iter().any(|b| b == branch) {
        session.branches.push(branch.to_string());
    }
}

fn ensure_skill_attribution<'a>(
    session: &'a mut Session,
    skill: &str,
) -> &'a mut SkillAttribution {
    session
        .skill_attribution
        .entry(skill.to_string())
        .or_default()
}

fn str_field<'a>(rec: &'a Value, key: &str) -> Option<&'a str> {
    rec.get(key).and_then(|v| v.as_str())
}

fn bool_field(rec: &Value, key: &str) -> bool {
    rec.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Fold NormalizedRecord JSON objects into a session bundle.
pub fn reduce_session(records: &[Value], meta: &SessionMeta) -> Session {
    let mut session = empty_session(meta);
    let mut first_user_seen = false;
    let mut active_skill: Option<String> = None;

    for rec in records {
        if let Some(ts) = rec.get("ts") {
            track_ts(&mut session, ts);
        }

        let kind = rec.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        match kind {
            "permission_mode" => {
                session.permission_mode = str_field(rec, "mode").map(|s| s.to_string());
            }
            "context_reset" => {
                session.context_resets += 1;
                active_skill = None;
            }
            "session_meta" => {
                if let Some(t) = str_field(rec, "ai_title") {
                    if session.ai_title.is_none() {
                        session.ai_title = Some(t.to_string());
                    }
                }
                if let Some(s) = str_field(rec, "slug") {
                    session.slug = Some(s.to_string());
                }
                if let Some(v) = rec.get("duration_ms").and_then(|v| v.as_i64()) {
                    session.duration_ms = Some(v);
                }
                if let Some(v) = rec.get("message_count").and_then(|v| v.as_i64()) {
                    session.message_count = Some(v);
                }
                if let Some(v) = str_field(rec, "version") {
                    session.version = Some(v.to_string());
                }
                if let Some(v) = str_field(rec, "entrypoint") {
                    session.entrypoint = Some(v.to_string());
                }
                if let Some(v) = str_field(rec, "cwd") {
                    session.cwd = Some(v.to_string());
                }
                if let Some(model) = str_field(rec, "model") {
                    let overwrite = bool_field(rec, "overwrite");
                    if overwrite || session.model.is_none() {
                        session.model = Some(model.to_string());
                    }
                }
                add_branch(&mut session, str_field(rec, "branch"));
            }
            "branch_change" => {
                add_branch(&mut session, str_field(rec, "branch"));
            }
            "user_turn" => {
                session.user_turns += 1;
                if let Some(v) = str_field(rec, "version") {
                    if session.version.is_none() {
                        session.version = Some(v.to_string());
                    }
                }
                if let Some(v) = str_field(rec, "entrypoint") {
                    if session.entrypoint.is_none() {
                        session.entrypoint = Some(v.to_string());
                    }
                }
                if let Some(v) = str_field(rec, "cwd") {
                    if session.cwd.is_none() {
                        session.cwd = Some(v.to_string());
                    }
                }
                add_branch(&mut session, str_field(rec, "branch"));
                if !first_user_seen {
                    if let Some(text) = str_field(rec, "text") {
                        if text.len() >= 8 {
                            let sliced: String = text.chars().take(200).collect();
                            session.first_user_message = Some(sliced);
                            first_user_seen = true;
                        }
                    }
                }
            }
            "skill_invoke" => {
                if let Some(skill) = str_field(rec, "skill") {
                    let bucket_builtin = is_builtin_command(skill);
                    let list = if bucket_builtin {
                        &mut session.builtin_commands
                    } else {
                        &mut session.skills
                    };
                    if !list.iter().any(|s| s == skill) {
                        list.push(skill.to_string());
                    }
                    if !bucket_builtin && !skill.is_empty() {
                        let ts = rec.get("ts").cloned().unwrap_or(Value::Null);
                        session.skill_timeline.push(SkillTimelineEntry {
                            skill: skill.to_string(),
                            ts,
                        });
                        ensure_skill_attribution(&mut session, skill);
                        active_skill = Some(skill.to_string());
                    }
                }
            }
            "tool_result" => {
                if bool_field(rec, "error") {
                    session.tool_errors += 1;
                    let tool = str_field(rec, "tool").unwrap_or("unknown");
                    if let Some(stats) = session.tools.get_mut(tool) {
                        stats.errors += 1;
                    }
                    if let Some(ref skill) = active_skill {
                        ensure_skill_attribution(&mut session, skill).errors += 1;
                    }
                }
            }
            "assistant_turn" => {
                session.assistant_turns += 1;
                if let Some(model) = str_field(rec, "model") {
                    let overwrite = bool_field(rec, "overwrite");
                    if overwrite || session.model.is_none() {
                        session.model = Some(model.to_string());
                    }
                }
                if let Some(sr) = str_field(rec, "stop_reason") {
                    *session.stop_reasons.entry(sr.to_string()).or_insert(0) += 1;
                }
            }
            "content_block" => {
                let bt = str_field(rec, "block_type").or_else(|| str_field(rec, "content_block"));
                if let Some(bt) = bt {
                    *session.content_blocks.entry(bt.to_string()).or_insert(0) += 1;
                }
            }
            "tokens" => {
                let empty = Map::new();
                let t = rec
                    .get("tokens")
                    .and_then(|v| v.as_object())
                    .unwrap_or(&empty);
                let n = |k: &str| t.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
                session.tokens.input += n("input");
                session.tokens.output += n("output");
                session.tokens.cache_create += n("cache_create");
                session.tokens.cache_read += n("cache_read");
            }
            "tool_use" => {
                session.tool_calls += 1;
                let name = str_field(rec, "tool").unwrap_or("unknown");
                session
                    .tools
                    .entry(name.to_string())
                    .or_default()
                    .calls += 1;
                if matches!(name, "Agent" | "Task" | "spawn_subagent") {
                    session.subagent_count += 1;
                }

                if let Some(op) = file_op_for(name) {
                    let input = rec.get("input").cloned().unwrap_or(Value::Null);
                    let paths: Vec<Option<&str>> =
                        if let Some(arr) = input.get("paths").and_then(|p| p.as_array()) {
                            arr.iter().map(|p| p.as_str()).collect()
                        } else {
                            vec![file_path_from_input(&input)]
                        };
                    for raw in paths {
                        if let Some(fp) = norm_path(raw) {
                            let entry = session.file_ops.entry(fp).or_default();
                            match op {
                                "read" => entry.read += 1,
                                "write" => entry.write += 1,
                                "edit" => entry.edit += 1,
                                _ => {}
                            }
                        }
                    }
                }

                if is_bash_tool_name(name) {
                    if let Some(cmd) = rec.pointer("/input/command").and_then(|c| c.as_str()) {
                        let cat = categorize_bash(Some(cmd));
                        *session.bash_categories.entry(cat.to_string()).or_insert(0) += 1;
                    }
                }

                if let Some(ref skill) = active_skill.clone() {
                    let attr = ensure_skill_attribution(&mut session, skill);
                    attr.tool_calls += 1;
                    *attr.tools.entry(name.to_string()).or_insert(0) += 1;
                }
            }
            _ => {}
        }
    }

    if session.slug.is_none() {
        let prefix: String = session.session_id.chars().take(8).collect();
        session.slug = Some(prefix);
    }
    if session.message_count.is_none() {
        if session.user_turns > 0 || session.assistant_turns > 0 {
            session.message_count = Some(session.user_turns + session.assistant_turns);
        } else {
            session.message_count = Some(0);
        }
    }

    session
}
