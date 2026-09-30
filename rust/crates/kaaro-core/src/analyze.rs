//! Thin analyze/scan API with injectable roots — foundation for a future CLI.
//! Port of CC/Pi/OpenCode scan paths in `analyze.mjs` / `analyzers/analyze-*.mjs`.

use crate::adapters::{antigravity, claude_code, codex, command_code, copilot, grok, opencode, pi};
use crate::enrich_session::enrich_session;
use crate::helpers::{
    derive_command_code_label, derive_grok_label, derive_grok_project_id, derive_label,
    derive_path_label, derive_path_project_id, derive_pi_label, detect_antigravity_workspace,
    grok_record_ts, opencode_slug, workspace_folder_path,
};
use crate::jsonl::parse_jsonl_file;
use crate::scan_walk::{dir_names, list_entries, walk_sessions, ScanEnvelope, WalkItem};
use crate::session_reducer::{reduce_session, Capabilities, Session, SessionMeta};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

/// Override default home-relative harness roots (tests inject temp dirs).
#[derive(Debug, Clone, Default)]
pub struct RootOverrides {
    pub claude_code: Option<PathBuf>,
    pub codex: Option<PathBuf>,
    pub pi: Option<PathBuf>,
    pub antigravity: Option<PathBuf>,
    pub grok: Option<PathBuf>,
    pub opencode: Option<PathBuf>,
    pub copilot: Option<PathBuf>,
    pub command_code: Option<PathBuf>,
}

fn size_proxy_caps() -> Option<Capabilities> {
    Some(Capabilities {
        size_proxy: Some("tokens_work".into()),
    })
}

/// Analyze one Claude Code JSONL file.
pub fn analyze_claude_code_session(project_id: &str, file_path: &Path) -> Result<Session, String> {
    let (records, size_bytes) =
        parse_jsonl_file(file_path, None).map_err(|e| e.to_string())?;
    let session_id = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();
    let meta = SessionMeta {
        session_id,
        project_id: project_id.into(),
        project_label: derive_label(project_id),
        harness: "claude-code".into(),
        file_size_bytes: size_bytes,
        capabilities: size_proxy_caps(),
    };
    let mut session = reduce_session(&claude_code::records_to_normalized(&records), &meta);
    enrich_session(&mut session);
    Ok(session)
}

/// Analyze one Pi JSONL file.
pub fn analyze_pi_session(project_id: &str, file_path: &Path) -> Result<Session, String> {
    let (records, size_bytes) =
        parse_jsonl_file(file_path, None).map_err(|e| e.to_string())?;
    let base = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    let session_id = if let Some(i) = base.find('_') {
        base[i + 1..].to_string()
    } else {
        base.to_string()
    };
    let meta = SessionMeta {
        session_id,
        project_id: project_id.into(),
        project_label: derive_pi_label(project_id),
        harness: "pi".into(),
        file_size_bytes: size_bytes,
        capabilities: size_proxy_caps(),
    };
    let mut session = reduce_session(&pi::records_to_normalized(&records), &meta);
    session.source = "pi".into();
    enrich_session(&mut session);
    Ok(session)
}

fn list_json_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(dir) else {
        return vec![];
    };
    let mut out: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    out.sort();
    out
}

fn read_json(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// Assemble OpenCode info + messages + parts (JS `readOpencodeSession`).
pub fn read_opencode_session(
    storage_root: &Path,
    info_path: &Path,
) -> Result<(Value, Vec<Value>, u64), String> {
    let info = read_json(info_path)?;
    let mut size_bytes = fs::metadata(info_path).map_err(|e| e.to_string())?.len();
    let info_id = info
        .get("id")
        .and_then(|i| i.as_str())
        .ok_or_else(|| "opencode info missing id".to_string())?;

    let mut messages = Vec::new();
    for msg_path in list_json_files(&storage_root.join("message").join(info_id)) {
        let mut msg = match read_json(&msg_path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        size_bytes += fs::metadata(&msg_path).map(|m| m.len()).unwrap_or(0);
        let msg_id = msg
            .get("id")
            .and_then(|i| i.as_str())
            .unwrap_or("")
            .to_string();
        let mut parts = Vec::new();
        for part_path in list_json_files(&storage_root.join("part").join(&msg_id)) {
            match read_json(&part_path) {
                Ok(p) => {
                    size_bytes += fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
                    parts.push(p);
                }
                Err(_) => {}
            }
        }
        parts.sort_by(|a, b| {
            let sa = a.get("id").and_then(|i| i.as_str()).unwrap_or("");
            let sb = b.get("id").and_then(|i| i.as_str()).unwrap_or("");
            sa.cmp(sb)
        });
        if let Some(obj) = msg.as_object_mut() {
            obj.insert("_parts".into(), Value::Array(parts));
        }
        messages.push(msg);
    }
    messages.sort_by(|a, b| {
        let ta = a.pointer("/time/created").and_then(|v| v.as_i64()).unwrap_or(0);
        let tb = b.pointer("/time/created").and_then(|v| v.as_i64()).unwrap_or(0);
        ta.cmp(&tb)
    });

    let mut records = vec![info.clone()];
    records.extend(messages);
    Ok((info, records, size_bytes))
}

/// Analyze one OpenCode session info path under a storage root.
pub fn analyze_opencode_session(
    storage_root: &Path,
    info_path: &Path,
) -> Result<Option<Session>, String> {
    let (info, records, size_bytes) = read_opencode_session(storage_root, info_path)?;
    let Some(sid) = info.get("id").and_then(|i| i.as_str()) else {
        return Ok(None);
    };
    let directory = info.get("directory").and_then(|d| d.as_str());
    let meta = SessionMeta {
        session_id: sid.into(),
        project_id: derive_path_project_id(directory),
        project_label: derive_path_label(directory),
        harness: "opencode".into(),
        file_size_bytes: size_bytes,
        capabilities: size_proxy_caps(),
    };
    let mut session = reduce_session(&opencode::records_to_normalized(&records), &meta);
    session.slug = Some(opencode_slug(sid));
    session.source = "opencode".into();
    enrich_session(&mut session);
    Ok(Some(session))
}

/// Scan Claude Code projects root (`<root>/<project>/*.jsonl`).
pub fn scan_claude_code_sessions(root: &Path) -> std::io::Result<Option<ScanEnvelope>> {
    let root = root.to_path_buf();
    let root_walk = root.clone();
    walk_sessions(
        &root_walk,
        "claude-code",
        move |entries| {
            let mut items = Vec::new();
            for project_id in dir_names(entries, false) {
                let pdir = root.join(&project_id);
                let Ok(rd) = fs::read_dir(&pdir) else {
                    continue;
                };
                let mut files: Vec<_> = rd
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|f| f.ends_with(".jsonl"))
                    .collect();
                files.sort();
                for file in files {
                    let path = pdir.join(&file);
                    let pid = project_id.clone();
                    let id = file.clone();
                    items.push(WalkItem {
                        id,
                        analyze: Box::new(move || {
                            analyze_claude_code_session(&pid, &path).map(Some)
                        }),
                    });
                }
            }
            items
        },
        None,
    )
}

/// Scan Pi sessions root (`<root>/<project>/*.jsonl`).
pub fn scan_pi_sessions(root: &Path) -> std::io::Result<Option<ScanEnvelope>> {
    let root = root.to_path_buf();
    let root_walk = root.clone();
    walk_sessions(
        &root_walk,
        "pi",
        move |entries| {
            let mut items = Vec::new();
            for project_id in dir_names(entries, false) {
                let pdir = root.join(&project_id);
                let Ok(rd) = fs::read_dir(&pdir) else {
                    continue;
                };
                let mut files: Vec<_> = rd
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|f| f.ends_with(".jsonl"))
                    .collect();
                files.sort();
                for file in files {
                    let path = pdir.join(&file);
                    let pid = project_id.clone();
                    items.push(WalkItem {
                        id: file,
                        analyze: Box::new(move || analyze_pi_session(&pid, &path).map(Some)),
                    });
                }
            }
            items
        },
        None,
    )
}

/// Scan OpenCode storage root (`<storage>/session/<bucket>/ses_*.json`).
pub fn scan_opencode_sessions(storage_root: &Path) -> std::io::Result<Option<ScanEnvelope>> {
    let storage_root = storage_root.to_path_buf();
    let session_root = storage_root.join("session");
    let session_root_for_walk = session_root.clone();
    let storage_for_src = storage_root.clone();
    walk_sessions(
        &session_root_for_walk,
        "opencode",
        move |entries| {
            let mut items = Vec::new();
            for bucket in dir_names(entries, false) {
                for info_path in list_json_files(&session_root.join(&bucket)) {
                    let name = info_path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();
                    if !name.starts_with("ses_") {
                        continue;
                    }
                    let storage = storage_root.clone();
                    let path = info_path.clone();
                    items.push(WalkItem {
                        id: format!("{bucket}/{name}"),
                        analyze: Box::new(move || analyze_opencode_session(&storage, &path)),
                    });
                }
            }
            items
        },
        Some(storage_for_src.as_path()),
    )
}


fn codex_session_id_from_filename(file: &Path) -> String {
    let base = file
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    // Trailing UUID
    if base.len() >= 36 {
        let cand = &base[base.len() - 36..];
        let ok = cand.as_bytes().get(8) == Some(&b'-')
            && cand.as_bytes().get(13) == Some(&b'-')
            && cand.as_bytes().get(18) == Some(&b'-')
            && cand.as_bytes().get(23) == Some(&b'-')
            && cand.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
        if ok {
            return cand.to_string();
        }
    }
    // fallback: strip rollout-<ts>-
    if let Some(rest) = base.strip_prefix("rollout-") {
        if let Some(i) = rest.find('-') {
            // skip first timestamp-ish segment if present
            let after = &rest[i + 1..];
            if after.len() >= 8 {
                return after.to_string();
            }
        }
        return rest.to_string();
    }
    base.to_string()
}

fn codex_project_from_records(records: &[Value]) -> (String, String, String) {
    let meta = records
        .iter()
        .find(|r| r.get("type").and_then(|t| t.as_str()) == Some("session_meta"))
        .and_then(|r| r.get("payload"));
    let ctx = records
        .iter()
        .find(|r| r.get("type").and_then(|t| t.as_str()) == Some("turn_context"))
        .and_then(|r| r.get("payload"));
    let cwd = meta
        .and_then(|p| p.get("cwd"))
        .or_else(|| ctx.and_then(|p| p.get("cwd")))
        .and_then(|c| c.as_str())
        .unwrap_or("codex");
    // JS: cwd.replace(/\\/g,'/').replace(/^\/Users\/[^/]+\//,'Users--').replace(/[/:]+/g,'-')
    let mut norm = cwd.replace('\\', "/");
    if let Some(rest) = norm.strip_prefix("/Users/") {
        if let Some(slash) = rest.find('/') {
            norm = format!("Users--{}", &rest[slash + 1..]);
        }
    }
    let project_id: String = {
        let mut out = String::new();
        for ch in norm.chars() {
            if ch == '/' || ch == ':' {
                out.push('-');
            } else {
                out.push(ch);
            }
        }
        // collapse runs of -? JS replace /[/:]+/g with single -
        let mut collapsed = String::new();
        let mut prev_dash = false;
        for ch in out.chars() {
            if ch == '-' {
                if !prev_dash {
                    collapsed.push('-');
                }
                prev_dash = true;
            } else {
                collapsed.push(ch);
                prev_dash = false;
            }
        }
        collapsed
    };
    let label = derive_label(
        Path::new(cwd)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("codex"),
    );
    (cwd.to_string(), project_id, label)
}

fn read_codex_session_index(index_path: &Path) -> std::collections::HashMap<String, Value> {
    let mut out = std::collections::HashMap::new();
    let Ok((records, _)) = parse_jsonl_file(index_path, None) else {
        return out;
    };
    for rec in records {
        let Some(id) = rec.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()) else {
            continue;
        };
        let updated = rec
            .get("updated_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let replace = match out.get(&id) {
            None => true,
            Some(prev) => {
                let prev_u = prev
                    .get("updated_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                updated.as_str() >= prev_u
            }
        };
        if replace {
            out.insert(id, rec);
        }
    }
    out
}

/// Analyze one Codex rollout JSONL file.
pub fn analyze_codex_session(
    file_path: &Path,
    title_index: &std::collections::HashMap<String, Value>,
) -> Result<Session, String> {
    let (records, size_bytes) =
        parse_jsonl_file(file_path, None).map_err(|e| e.to_string())?;
    let session_id = codex_session_id_from_filename(file_path);
    let (cwd, project_id, project_label) = codex_project_from_records(&records);
    let meta = SessionMeta {
        session_id: session_id.clone(),
        project_id,
        project_label,
        harness: "codex".into(),
        file_size_bytes: size_bytes,
        capabilities: size_proxy_caps(),
    };
    let mut session = reduce_session(&codex::records_to_normalized(&records), &meta);
    session.file_size_bytes = size_bytes;
    session.source = "codex".into();
    if session.cwd.is_none() {
        session.cwd = Some(cwd);
    }
    if let Some(rec) = title_index.get(&session_id) {
        if let Some(title) = rec.get("thread_name").and_then(|t| t.as_str()) {
            session.ai_title = Some(title.into());
        }
    }
    enrich_session(&mut session);
    Ok(session)
}

fn rollout_files(root: &Path) -> Vec<PathBuf> {
    let sessions_root = root.join("sessions");
    let mut out = Vec::new();
    let Ok(year_ents) = list_entries(&sessions_root) else {
        return out;
    };
    for year in dir_names(&year_ents, false) {
        let year_dir = sessions_root.join(&year);
        let Ok(month_ents) = list_entries(&year_dir) else {
            continue;
        };
        for month in dir_names(&month_ents, false) {
            let month_dir = year_dir.join(&month);
            let Ok(day_ents) = list_entries(&month_dir) else {
                continue;
            };
            for day in dir_names(&day_ents, false) {
                let day_dir = month_dir.join(&day);
                let Ok(rd) = fs::read_dir(&day_dir) else {
                    continue;
                };
                let mut files: Vec<_> = rd
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|f| f.starts_with("rollout-") && f.ends_with(".jsonl"))
                    .collect();
                files.sort();
                for f in files {
                    out.push(day_dir.join(f));
                }
            }
        }
    }
    out
}

/// Scan Codex home (`<root>/sessions/YYYY/MM/DD/rollout-*.jsonl`).
pub fn scan_codex_sessions(root: &Path) -> std::io::Result<Option<ScanEnvelope>> {
    let root = root.to_path_buf();
    let title_index = read_codex_session_index(&root.join("session_index.jsonl"));
    let root_walk = root.clone();
    walk_sessions(
        &root_walk,
        "codex",
        move |_| {
            let mut items = Vec::new();
            for file_path in rollout_files(&root) {
                let rel = file_path
                    .strip_prefix(&root)
                    .unwrap_or(&file_path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let idx = title_index.clone();
                let path = file_path.clone();
                items.push(WalkItem {
                    id: rel,
                    analyze: Box::new(move || analyze_codex_session(&path, &idx).map(Some)),
                });
            }
            items
        },
        None,
    )
}

/// Read a Grok session directory (updates.jsonl + optional summary/signals).
pub fn read_grok_session(session_dir: &Path) -> Result<(Vec<Value>, Option<Value>, Option<Value>, u64), String> {
    let updates = session_dir.join("updates.jsonl");
    let (records, size_bytes) = parse_jsonl_file(&updates, None).map_err(|e| e.to_string())?;
    let summary = read_json(&session_dir.join("summary.json")).ok();
    let signals = read_json(&session_dir.join("signals.json")).ok();
    Ok((records, summary, signals, size_bytes))
}

fn track_grok_timestamps(session: &mut Session, records: &[Value]) {
    for rec in records {
        let Some(ts) = grok_record_ts(rec) else {
            continue;
        };
        if session.first_timestamp.as_ref().map(|f| ts.as_str() < f.as_str()).unwrap_or(true) {
            session.first_timestamp = Some(ts.clone());
        }
        if session.last_timestamp.as_ref().map(|l| ts.as_str() > l.as_str()).unwrap_or(true) {
            session.last_timestamp = Some(ts);
        }
    }
}

fn apply_grok_meta(
    session: &mut Session,
    encoded_cwd: &str,
    summary: Option<&Value>,
    signals: Option<&Value>,
    records: &[Value],
) {
    track_grok_timestamps(session, records);
    let cwd = summary
        .and_then(|s| s.pointer("/info/cwd"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .or_else(|| crate::helpers::decode_grok_cwd(Some(encoded_cwd)));
    if let Some(c) = cwd {
        session.cwd = Some(c);
    }
    session.project_id = derive_grok_project_id(encoded_cwd);
    session.project_label = derive_grok_label(encoded_cwd);

    if let Some(summary) = summary {
        if let Some(m) = summary.get("current_model_id").and_then(|v| v.as_str()) {
            session.model = Some(m.into());
        }
        let title = summary
            .get("generated_title")
            .or_else(|| summary.get("session_summary"))
            .and_then(|v| v.as_str());
        if let Some(t) = title {
            session.ai_title = Some(t.into());
        }
        if let Some(b) = summary.get("head_branch").and_then(|v| v.as_str()) {
            session.git_branch = Some(b.into());
            session.branches = vec![b.into()];
        }
        if session.first_timestamp.is_none() {
            if let Some(c) = summary.get("created_at").and_then(|v| v.as_str()) {
                session.first_timestamp = Some(c.into());
            }
        }
        if let Some(u) = summary.get("updated_at").and_then(|v| v.as_str()) {
            session.last_timestamp = Some(u.into());
        }
    }

    if let Some(signals) = signals {
        if session.model.is_none() {
            if let Some(m) = signals.get("primaryModelId").and_then(|v| v.as_str()) {
                session.model = Some(m.into());
            }
        }
        if let Some(n) = signals
            .get("contextTokensUsed")
            .and_then(|v| v.as_i64().or_else(|| v.as_u64().map(|u| u as i64)))
        {
            session.tokens.input = n;
        }
        if session.context_resets == 0 {
            if let Some(n) = signals.get("compactionCount").and_then(|v| v.as_i64()) {
                session.context_resets = n;
            }
        }
        if let Some(secs) = signals
            .get("sessionDurationSeconds")
            .and_then(|v| v.as_i64().or_else(|| v.as_u64().map(|u| u as i64)))
        {
            session.duration_ms = Some(secs * 1000);
        }
    }
}

/// Reduce + apply Grok meta (JS `parseGrokRecords`).
pub fn parse_grok_records(
    records: &[Value],
    session_id: &str,
    encoded_cwd: &str,
    summary: Option<&Value>,
    signals: Option<&Value>,
) -> Session {
    let meta = SessionMeta {
        session_id: session_id.into(),
        project_id: derive_grok_project_id(encoded_cwd),
        project_label: derive_grok_label(encoded_cwd),
        harness: "grok".into(),
        file_size_bytes: 0,
        capabilities: Some(Capabilities {
            size_proxy: Some("tool_calls".into()),
        }),
    };
    let mut session = reduce_session(&grok::records_to_normalized(records), &meta);
    apply_grok_meta(&mut session, encoded_cwd, summary, signals, records);
    session
}

/// Analyze one Grok session directory.
pub fn analyze_grok_session(
    encoded_cwd: &str,
    session_id: &str,
    sessions_root: &Path,
) -> Result<Option<Session>, String> {
    let session_dir = sessions_root.join(encoded_cwd).join(session_id);
    let updates = session_dir.join("updates.jsonl");
    if !updates.is_file() {
        return Ok(None);
    }
    let (records, summary, signals, size_bytes) = read_grok_session(&session_dir)?;
    if records.is_empty() {
        return Ok(None);
    }
    let mut session = parse_grok_records(
        &records,
        session_id,
        encoded_cwd,
        summary.as_ref(),
        signals.as_ref(),
    );
    session.file_size_bytes = size_bytes;
    session.source = "grok".into();
    enrich_session(&mut session);
    Ok(Some(session))
}

/// Scan Grok sessions root (`<root>/<encoded-cwd>/<uuid>/updates.jsonl`).
pub fn scan_grok_sessions(sessions_root: &Path) -> std::io::Result<Option<ScanEnvelope>> {
    let sessions_root = sessions_root.to_path_buf();
    let root_walk = sessions_root.clone();
    walk_sessions(
        &root_walk,
        "grok",
        move |entries| {
            let mut items = Vec::new();
            for proj in dir_names(entries, false) {
                let proj_dir = sessions_root.join(&proj);
                let Ok(sess_ents) = list_entries(&proj_dir) else {
                    continue;
                };
                for name in dir_names(&sess_ents, false) {
                    // SESSION_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i
                    let bytes = name.as_bytes();
                    let looks_uuid = bytes.len() >= 13
                        && bytes[8] == b'-'
                        && bytes[13] == b'-'
                        && name[..8].chars().all(|c| c.is_ascii_hexdigit())
                        && name[9..13].chars().all(|c| c.is_ascii_hexdigit());
                    if !looks_uuid {
                        continue;
                    }
                    let root = sessions_root.clone();
                    let enc = proj.clone();
                    let sid = name.clone();
                    items.push(WalkItem {
                        id: format!("{proj}/{name}"),
                        analyze: Box::new(move || analyze_grok_session(&enc, &sid, &root)),
                    });
                }
            }
            items
        },
        None,
    )
}


fn tool_calls_caps() -> Option<Capabilities> {
    Some(Capabilities {
        size_proxy: Some("tool_calls".into()),
    })
}

/// Reduce + apply Antigravity workspace meta (JS `parseAntigravityRecords`).
pub fn parse_antigravity_records(records: &[Value], session_id: &str) -> Session {
    let meta = SessionMeta {
        session_id: session_id.into(),
        project_id: "antigravity-unknown".into(),
        project_label: "unknown".into(),
        harness: "antigravity".into(),
        file_size_bytes: 0,
        capabilities: tool_calls_caps(),
    };
    let mut session = reduce_session(&antigravity::records_to_normalized(records), &meta);
    for rec in records {
        let Some(ts) = rec.get("created_at").and_then(|t| t.as_str()) else {
            continue;
        };
        if session
            .first_timestamp
            .as_ref()
            .map(|f| ts < f.as_str())
            .unwrap_or(true)
        {
            session.first_timestamp = Some(ts.into());
        }
        if session
            .last_timestamp
            .as_ref()
            .map(|l| ts > l.as_str())
            .unwrap_or(true)
        {
            session.last_timestamp = Some(ts.into());
        }
    }
    let cwd = detect_antigravity_workspace(records);
    session.cwd = cwd.clone();
    session.project_id = derive_path_project_id(cwd.as_deref());
    session.project_label = derive_path_label(cwd.as_deref());
    if let (Some(first), Some(last)) = (&session.first_timestamp, &session.last_timestamp) {
        // Best-effort duration from ISO strings via chrono-less heuristic: leave to enrich
        let _ = (first, last);
    }
    session
}

pub fn analyze_antigravity_session(
    conversation_id: &str,
    brain_dir: &Path,
) -> Result<Option<Session>, String> {
    let session_dir = brain_dir
        .join(conversation_id)
        .join(".system_generated")
        .join("logs");
    let transcript = session_dir.join("transcript.jsonl");
    let overview = session_dir.join("overview.txt");
    let log_path = if transcript.is_file() {
        transcript
    } else if overview.is_file() {
        overview
    } else {
        return Ok(None);
    };
    let (records, size_bytes) = parse_jsonl_file(&log_path, None).map_err(|e| e.to_string())?;
    if records.is_empty() {
        return Ok(None);
    }
    let mut session = parse_antigravity_records(&records, conversation_id);
    session.file_size_bytes = size_bytes;
    session.source = "antigravity".into();
    enrich_session(&mut session);
    Ok(Some(session))
}

pub fn scan_antigravity_sessions(brain_dir: &Path) -> std::io::Result<Option<ScanEnvelope>> {
    let brain_dir = brain_dir.to_path_buf();
    let root_walk = brain_dir.clone();
    walk_sessions(
        &root_walk,
        "antigravity",
        move |entries| {
            let mut items = Vec::new();
            for conversation_id in dir_names(entries, true) {
                let brain = brain_dir.clone();
                let id = conversation_id.clone();
                items.push(WalkItem {
                    id: conversation_id,
                    analyze: Box::new(move || analyze_antigravity_session(&id, &brain)),
                });
            }
            items
        },
        None,
    )
}

pub fn analyze_command_code_session(
    project_id: &str,
    file_path: &Path,
) -> Result<Session, String> {
    let (records, size_bytes) =
        parse_jsonl_file(file_path, None).map_err(|e| e.to_string())?;
    let session_id = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();
    let meta = SessionMeta {
        session_id: session_id.clone(),
        project_id: project_id.into(),
        project_label: derive_command_code_label(project_id),
        harness: "command-code".into(),
        file_size_bytes: size_bytes,
        capabilities: tool_calls_caps(),
    };
    let mut session = reduce_session(&command_code::records_to_normalized(&records), &meta);
    // Sibling .meta.json title
    let meta_path = file_path.with_extension("meta.json");
    if let Ok(raw) = fs::read_to_string(&meta_path) {
        if let Ok(mj) = serde_json::from_str::<Value>(&raw) {
            if let Some(title) = mj.get("title").and_then(|t| t.as_str()) {
                session.ai_title = Some(title.into());
            }
        }
    }
    session.file_size_bytes = size_bytes;
    session.source = "command-code".into();
    enrich_session(&mut session);
    Ok(session)
}

pub fn scan_command_code_sessions(root: &Path) -> std::io::Result<Option<ScanEnvelope>> {
    let root = root.to_path_buf();
    let root_walk = root.clone();
    walk_sessions(
        &root_walk,
        "command-code",
        move |entries| {
            let mut items = Vec::new();
            for project_id in dir_names(entries, false) {
                let pdir = root.join(&project_id);
                let Ok(rd) = fs::read_dir(&pdir) else {
                    continue;
                };
                let mut files: Vec<_> = rd
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|f| f.ends_with(".jsonl") && !f.ends_with(".checkpoints.jsonl"))
                    .collect();
                files.sort();
                for file in files {
                    let path = pdir.join(&file);
                    let pid = project_id.clone();
                    items.push(WalkItem {
                        id: file,
                        analyze: Box::new(move || {
                            analyze_command_code_session(&pid, &path).map(Some)
                        }),
                    });
                }
            }
            items
        },
        None,
    )
}

pub fn read_copilot_session(file_path: &Path) -> Result<(Vec<Value>, u64), String> {
    let meta = fs::metadata(file_path).map_err(|e| e.to_string())?;
    let size_bytes = meta.len();
    let raw = fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    if file_path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
        let mut records = Vec::new();
        for line in raw.lines() {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str(line) {
                records.push(v);
            }
        }
        return Ok((records, size_bytes));
    }
    match serde_json::from_str::<Value>(&raw) {
        Ok(v) => Ok((vec![v], size_bytes)),
        Err(_) => Ok((vec![], size_bytes)),
    }
}

pub fn analyze_copilot_session(
    file_path: &Path,
    project_id: &str,
    project_label: &str,
    cwd: Option<&str>,
) -> Result<Option<Session>, String> {
    let (records, size_bytes) = read_copilot_session(file_path)?;
    if records.is_empty() {
        return Ok(None);
    }
    let session_id = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();
    let meta = SessionMeta {
        session_id,
        project_id: project_id.into(),
        project_label: project_label.into(),
        harness: "copilot".into(),
        file_size_bytes: size_bytes,
        capabilities: size_proxy_caps(),
    };
    let mut session = reduce_session(&copilot::records_to_normalized(&records), &meta);
    if let Some(c) = cwd {
        session.cwd = Some(c.into());
    }
    session.file_size_bytes = size_bytes;
    session.source = "copilot".into();
    enrich_session(&mut session);
    Ok(Some(session))
}

pub fn scan_copilot_sessions(ws_root: &Path) -> std::io::Result<Option<ScanEnvelope>> {
    let ws_root = ws_root.to_path_buf();
    let root_walk = ws_root.clone();
    walk_sessions(
        &root_walk,
        "copilot",
        move |entries| {
            let mut items = Vec::new();
            for ws in dir_names(entries, false) {
                let ws_dir = ws_root.join(&ws);
                let chat_dir = ws_dir.join("chatSessions");
                let Ok(rd) = fs::read_dir(&chat_dir) else {
                    continue;
                };
                let mut project_id = "copilot-unknown".to_string();
                let mut project_label = "copilot".to_string();
                let mut cwd: Option<String> = None;
                if let Ok(raw) = fs::read_to_string(ws_dir.join("workspace.json")) {
                    if let Ok(wsj) = serde_json::from_str::<Value>(&raw) {
                        if let Some(folder) = workspace_folder_path(&wsj) {
                            project_id = derive_path_project_id(Some(&folder));
                            project_label = derive_path_label(Some(&folder));
                            cwd = Some(folder);
                        }
                    }
                }
                let mut files: Vec<_> = rd
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|f| f.ends_with(".jsonl") || f.ends_with(".json"))
                    .collect();
                files.sort();
                for f in files {
                    let path = chat_dir.join(&f);
                    let pid = project_id.clone();
                    let plab = project_label.clone();
                    let cwd2 = cwd.clone();
                    items.push(WalkItem {
                        id: format!("{ws}/{f}"),
                        analyze: Box::new(move || {
                            analyze_copilot_session(&path, &pid, &plab, cwd2.as_deref())
                        }),
                    });
                }
            }
            items
        },
        None,
    )
}

/// Run enabled harness scans with injectable roots; return envelopes (skips missing roots).
pub fn scan_all(overrides: &RootOverrides) -> Vec<ScanEnvelope> {
    use crate::harness_paths::{
        antigravity_brain_root, claude_projects_root, codex_home_root,
        command_code_projects_root, copilot_workspace_storage_root, grok_sessions_root,
        opencode_storage_root, pi_sessions_root,
    };

    let mut out = Vec::new();

    let cc_root = overrides
        .claude_code
        .clone()
        .unwrap_or_else(claude_projects_root);
    if let Ok(Some(env)) = scan_claude_code_sessions(&cc_root) {
        out.push(env);
    }

    let codex_root = overrides.codex.clone().unwrap_or_else(codex_home_root);
    if let Ok(Some(env)) = scan_codex_sessions(&codex_root) {
        out.push(env);
    }

    let pi_root = overrides.pi.clone().unwrap_or_else(pi_sessions_root);
    if let Ok(Some(env)) = scan_pi_sessions(&pi_root) {
        out.push(env);
    }

    let ag_root = overrides
        .antigravity
        .clone()
        .unwrap_or_else(antigravity_brain_root);
    if let Ok(Some(env)) = scan_antigravity_sessions(&ag_root) {
        out.push(env);
    }

    let grok_root = overrides.grok.clone().unwrap_or_else(grok_sessions_root);
    if let Ok(Some(env)) = scan_grok_sessions(&grok_root) {
        out.push(env);
    }

    let oc_root = overrides
        .opencode
        .clone()
        .unwrap_or_else(opencode_storage_root);
    if let Ok(Some(env)) = scan_opencode_sessions(&oc_root) {
        out.push(env);
    }

    let cp_root = overrides
        .copilot
        .clone()
        .unwrap_or_else(copilot_workspace_storage_root);
    if let Ok(Some(env)) = scan_copilot_sessions(&cp_root) {
        out.push(env);
    }

    let cmd_root = overrides
        .command_code
        .clone()
        .unwrap_or_else(command_code_projects_root);
    if let Ok(Some(env)) = scan_command_code_sessions(&cmd_root) {
        out.push(env);
    }

    out
}

/// Flatten [`scan_all`] sessions.
pub fn collect_sessions(overrides: &RootOverrides) -> Vec<Session> {
    scan_all(overrides)
        .into_iter()
        .flat_map(|e| e.sessions)
        .collect()
}
