//! Locate a session file by id under an injectable root — port of
//! `hooks/session-locators.mjs` (CC / Pi / OpenCode).

use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocateHit {
    pub file_path: PathBuf,
    pub project_id: Option<String>,
    pub session_id: String,
}

fn is_dir(path: &Path) -> bool {
    fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}

/// Find a Claude Code session jsonl under `root` (projects tree).
pub fn locate_claude_code_session(session_id: &str, root: &Path) -> Option<LocateHit> {
    if session_id.is_empty() || !root.exists() {
        return None;
    }
    let agent_file = if session_id.starts_with("agent-") {
        format!("{session_id}.jsonl")
    } else {
        format!("agent-{session_id}.jsonl")
    };

    let entries = fs::read_dir(root).ok()?;
    for ent in entries.flatten() {
        let proj = ent.file_name().to_string_lossy().into_owned();
        let proj_path = root.join(&proj);
        if !is_dir(&proj_path) {
            continue;
        }

        let candidate = proj_path.join(format!("{session_id}.jsonl"));
        if candidate.exists() {
            return Some(LocateHit {
                file_path: candidate,
                project_id: Some(proj),
                session_id: session_id.into(),
            });
        }

        if let Ok(inner) = fs::read_dir(&proj_path) {
            for entry in inner.flatten() {
                let nested = proj_path
                    .join(entry.file_name())
                    .join("subagents")
                    .join(&agent_file);
                if nested.exists() {
                    return Some(LocateHit {
                        file_path: nested,
                        project_id: Some(proj.clone()),
                        session_id: session_id.into(),
                    });
                }
            }
        }

        let legacy = proj_path.join("subagents").join(format!("{session_id}.jsonl"));
        if legacy.exists() {
            return Some(LocateHit {
                file_path: legacy,
                project_id: Some(proj),
                session_id: session_id.into(),
            });
        }
    }
    None
}

fn session_id_from_pi_filename(file: &str) -> String {
    let base = file.trim_end_matches(".jsonl");
    if let Some(i) = base.find('_') {
        base[i + 1..].to_string()
    } else {
        base.to_string()
    }
}

/// Find a Pi session jsonl under `root`.
pub fn locate_pi_session(session_id: &str, root: &Path) -> Option<LocateHit> {
    if session_id.is_empty() || !root.exists() {
        return None;
    }
    for ent in fs::read_dir(root).ok()?.flatten() {
        let proj = ent.file_name().to_string_lossy().into_owned();
        let proj_path = root.join(&proj);
        if !is_dir(&proj_path) {
            continue;
        }
        for file in fs::read_dir(&proj_path).ok()?.flatten() {
            let name = file.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".jsonl") {
                continue;
            }
            if session_id_from_pi_filename(&name) == session_id {
                return Some(LocateHit {
                    file_path: proj_path.join(name),
                    project_id: Some(proj),
                    session_id: session_id.into(),
                });
            }
        }
    }
    // slug prefix
    if session_id.len() < 4 {
        return None;
    }
    let needle = session_id.to_ascii_lowercase();
    for ent in fs::read_dir(root).ok()?.flatten() {
        let proj = ent.file_name().to_string_lossy().into_owned();
        let proj_path = root.join(&proj);
        let Ok(files) = fs::read_dir(&proj_path) else {
            continue;
        };
        for file in files.flatten() {
            let name = file.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".jsonl") {
                continue;
            }
            let id = session_id_from_pi_filename(&name);
            if id.to_ascii_lowercase().starts_with(&needle) {
                return Some(LocateHit {
                    file_path: proj_path.join(name),
                    project_id: Some(proj),
                    session_id: id,
                });
            }
        }
    }
    None
}

/// Find an OpenCode session info json under storage `root`.
pub fn locate_opencode_session(session_id: &str, root: &Path) -> Option<LocateHit> {
    if session_id.is_empty() {
        return None;
    }
    let session_root = root.join("session");
    if !session_root.exists() {
        return None;
    }
    for bucket in fs::read_dir(&session_root).ok()?.flatten() {
        let candidate = session_root
            .join(bucket.file_name())
            .join(format!("{session_id}.json"));
        if candidate.exists() {
            return Some(LocateHit {
                file_path: candidate,
                project_id: None,
                session_id: session_id.into(),
            });
        }
    }
    None
}

fn find_by_prefix(dir: &Path, session_id: &str, ext: &str) -> Option<(PathBuf, String)> {
    if session_id.len() < 4 || !dir.exists() {
        return None;
    }
    let needle = session_id.to_ascii_lowercase();
    let Ok(rd) = fs::read_dir(dir) else {
        return None;
    };
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        if !name.ends_with(ext) {
            continue;
        }
        let id = name.trim_end_matches(ext).to_string();
        if id.to_ascii_lowercase().starts_with(&needle) {
            return Some((dir.join(name), id));
        }
    }
    None
}

/// Codex rollout under `root/sessions/**`.
pub fn locate_codex_session(session_id: &str, root: &Path) -> Option<LocateHit> {
    if session_id.is_empty() || !root.exists() {
        return None;
    }
    let sessions_root = root.join("sessions");
    if !sessions_root.exists() {
        return None;
    }
    let lower = session_id.to_ascii_lowercase();
    let mut prefix_match: Option<LocateHit> = None;
    let mut stack = vec![sessions_root];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else {
            continue;
        };
        for ent in rd.flatten() {
            let p = dir.join(ent.file_name());
            if ent.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                stack.push(p);
                continue;
            }
            let name = ent.file_name().to_string_lossy().into_owned();
            if name.ends_with(&format!("{session_id}.jsonl")) {
                return Some(LocateHit {
                    file_path: p,
                    project_id: None,
                    session_id: session_id.into(),
                });
            }
            if prefix_match.is_none() && session_id.len() >= 4 {
                if let Some(id) = extract_codex_uuid(&name) {
                    if id.to_ascii_lowercase().starts_with(&lower) {
                        prefix_match = Some(LocateHit {
                            file_path: p,
                            project_id: None,
                            session_id: id,
                        });
                    }
                }
            }
        }
    }
    prefix_match
}

fn extract_codex_uuid(name: &str) -> Option<String> {
    // ...uuid.jsonl
    let lower = name.to_ascii_lowercase();
    if !lower.ends_with(".jsonl") {
        return None;
    }
    let stem = &name[..name.len() - 6];
    if stem.len() >= 36 {
        let cand = &stem[stem.len() - 36..];
        if looks_like_uuid(cand) {
            return Some(cand.to_string());
        }
    }
    None
}

fn looks_like_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    // 8-4-4-4-12
    let dashes = [8usize, 13, 18, 23];
    for (i, c) in b.iter().enumerate() {
        if dashes.contains(&i) {
            if *c != b'-' {
                return false;
            }
        } else if !c.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}


/// Antigravity conversation under brain root.
pub fn locate_antigravity_session(session_id: &str, root: &Path) -> Option<LocateHit> {
    if session_id.is_empty() || !root.exists() {
        return None;
    }
    let session_dir = root.join(session_id).join(".system_generated").join("logs");
    let transcript = session_dir.join("transcript.jsonl");
    if transcript.exists() {
        return Some(LocateHit {
            file_path: transcript,
            project_id: None,
            session_id: session_id.into(),
        });
    }
    let overview = session_dir.join("overview.txt");
    if overview.exists() {
        return Some(LocateHit {
            file_path: overview,
            project_id: None,
            session_id: session_id.into(),
        });
    }
    None
}

/// Grok session updates.jsonl under encoded_cwd/session_id/.
pub fn locate_grok_session(session_id: &str, root: &Path) -> Option<LocateHit> {
    if session_id.is_empty() || !root.exists() {
        return None;
    }
    for encoded in fs::read_dir(root).ok()?.flatten() {
        let updates = root
            .join(encoded.file_name())
            .join(session_id)
            .join("updates.jsonl");
        if updates.exists() {
            return Some(LocateHit {
                file_path: updates,
                project_id: Some(encoded.file_name().to_string_lossy().into_owned()),
                session_id: session_id.into(),
            });
        }
    }
    if session_id.len() < 8 {
        return None;
    }
    let needle = session_id.to_ascii_lowercase();
    for encoded in fs::read_dir(root).ok()?.flatten() {
        let proj = root.join(encoded.file_name());
        let Ok(names) = fs::read_dir(&proj) else {
            continue;
        };
        for sid_ent in names.flatten() {
            let sid = sid_ent.file_name().to_string_lossy().into_owned();
            if !sid.to_ascii_lowercase().starts_with(&needle) {
                continue;
            }
            let updates = proj.join(&sid).join("updates.jsonl");
            if updates.exists() {
                return Some(LocateHit {
                    file_path: updates,
                    project_id: Some(encoded.file_name().to_string_lossy().into_owned()),
                    session_id: sid,
                });
            }
        }
    }
    None
}

/// Copilot chat session under workspaceStorage/*/chatSessions/.
pub fn locate_copilot_session(session_id: &str, root: &Path) -> Option<LocateHit> {
    if session_id.is_empty() || !root.exists() {
        return None;
    }
    for ws in fs::read_dir(root).ok()?.flatten() {
        let chat_dir = root.join(ws.file_name()).join("chatSessions");
        for ext in ["jsonl", "json"] {
            let candidate = chat_dir.join(format!("{session_id}.{ext}"));
            if candidate.exists() {
                return Some(LocateHit {
                    file_path: candidate,
                    project_id: None,
                    session_id: session_id.into(),
                });
            }
        }
    }
    for ws in fs::read_dir(root).ok()?.flatten() {
        let chat_dir = root.join(ws.file_name()).join("chatSessions");
        for ext in [".jsonl", ".json"] {
            if let Some((path, id)) = find_by_prefix(&chat_dir, session_id, ext) {
                return Some(LocateHit {
                    file_path: path,
                    project_id: None,
                    session_id: id,
                });
            }
        }
    }
    None
}

/// Command Code session jsonl under projects/.
pub fn locate_command_code_session(session_id: &str, root: &Path) -> Option<LocateHit> {
    if session_id.is_empty() || !root.exists() {
        return None;
    }
    for proj in fs::read_dir(root).ok()?.flatten() {
        let proj_path = root.join(proj.file_name());
        if !is_dir(&proj_path) {
            continue;
        }
        let candidate = proj_path.join(format!("{session_id}.jsonl"));
        if candidate.exists() {
            return Some(LocateHit {
                file_path: candidate,
                project_id: Some(proj.file_name().to_string_lossy().into_owned()),
                session_id: session_id.into(),
            });
        }
    }
    for proj in fs::read_dir(root).ok()?.flatten() {
        let proj_path = root.join(proj.file_name());
        if !is_dir(&proj_path) {
            continue;
        }
        if let Some((path, id)) = find_by_prefix(&proj_path, session_id, ".jsonl") {
            return Some(LocateHit {
                file_path: path,
                project_id: Some(proj.file_name().to_string_lossy().into_owned()),
                session_id: id,
            });
        }
    }
    None
}

/// Resolve session across harness locators (first hit wins).
pub fn resolve_session_file(
    session_id: &str,
    harness_filter: Option<&str>,
    roots: &dyn Fn(&str) -> Option<PathBuf>,
) -> Option<(LocateHit, &'static str)> {
    if session_id.is_empty() {
        return None;
    }
    let ids: Vec<&'static str> = if let Some(h) = harness_filter {
        let hid = match h {
            "claude-code" => "claude-code",
            "codex" => "codex",
            "pi" => "pi",
            "antigravity" => "antigravity",
            "grok" => "grok",
            "opencode" => "opencode",
            "copilot" => "copilot",
            "command-code" => "command-code",
            _ => return None,
        };
        vec![hid]
    } else {
        crate::registry::HARNESS_IDS.to_vec()
    };
    for hid in ids {
        let Some(root) = roots(hid) else {
            continue;
        };
        if let Some(hit) = locate_for_harness(hid, session_id, &root) {
            return Some((hit, hid));
        }
    }
    None
}

fn locate_for_harness(harness: &str, session_id: &str, root: &Path) -> Option<LocateHit> {
    match harness {
        "claude-code" => locate_claude_code_session(session_id, root),
        "codex" => locate_codex_session(session_id, root),
        "pi" => locate_pi_session(session_id, root),
        "antigravity" => locate_antigravity_session(session_id, root),
        "grok" => locate_grok_session(session_id, root),
        "opencode" => locate_opencode_session(session_id, root),
        "copilot" => locate_copilot_session(session_id, root),
        "command-code" => locate_command_code_session(session_id, root),
        _ => None,
    }
}
