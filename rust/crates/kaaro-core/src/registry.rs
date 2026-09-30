//! Harness descriptors — port of `hooks/registry.mjs` (all 8 harnesses).

use crate::adapters::{
    antigravity, claude_code, codex, command_code, copilot, grok, opencode, pi,
};
use crate::helpers::{
    derive_command_code_label, derive_grok_label, derive_grok_project_id, derive_pi_label,
};
use serde_json::Value;

/// All eight JS harness ids.
pub const HARNESS_IDS: &[&str] = &[
    "claude-code",
    "codex",
    "pi",
    "antigravity",
    "grok",
    "opencode",
    "copilot",
    "command-code",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HarnessCapabilities {
    pub tokens: bool,
    pub pulse: bool,
    pub trace: bool,
    pub context_resets: bool,
    pub ai_title: bool,
    pub subagent_count: bool,
    pub subagent_tree: bool,
    pub branches: bool,
    pub size_proxy: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchCtx {
    pub harness: String,
    pub session_id: String,
    pub slug: String,
    pub project_id: Option<String>,
    pub project_label: Option<String>,
    pub agent_id: Option<String>,
    /// `"json"` for whole-file JSON harnesses (opencode); None = JSONL tail.
    pub read_mode: Option<String>,
}

pub type AdapterFn = fn(&[Value]) -> Vec<Value>;
pub type MatchLogFn = fn(&str) -> bool;
pub type CtxFromPathFn = fn(&str) -> Option<WatchCtx>;
pub type RebuildArgFn = fn(&str) -> Option<String>;

#[derive(Clone)]
pub struct HarnessDescriptor {
    pub id: &'static str,
    pub label: &'static str,
    pub capabilities: HarnessCapabilities,
    pub adapter: AdapterFn,
    pub match_log_file: MatchLogFn,
    pub ctx_from_path: CtxFromPathFn,
    pub rebuild_arg: RebuildArgFn,
}

fn derive_label_simple(project_id: &str) -> String {
    crate::helpers::derive_label(project_id)
}

fn norm_slashes(s: &str) -> String {
    s.replace('\\', "/")
}

fn cc_match(rel: &str) -> bool {
    let p = norm_slashes(rel);
    if p.ends_with(".jsonl") {
        return true;
    }
    p.ends_with(".meta.json") && p.contains("/subagents/")
}

fn cc_ctx(rel_path: &str) -> Option<WatchCtx> {
    let norm = norm_slashes(rel_path);
    let parts: Vec<&str> = norm.split('/').collect();
    if parts.len() < 2 {
        return None;
    }
    let project_id = parts[0];
    if parts.len() >= 4 && parts[2] == "subagents" {
        let parent_id = parts[1];
        let leaf = parts[3]
            .trim_end_matches(".meta.json")
            .trim_end_matches(".jsonl")
            .trim_start_matches("agent-");
        return Some(WatchCtx {
            harness: "claude-code".into(),
            session_id: parent_id.into(),
            slug: parent_id.chars().take(8).collect(),
            project_id: Some(project_id.into()),
            project_label: Some(derive_label_simple(project_id)),
            agent_id: Some(leaf.into()),
            read_mode: None,
        });
    }
    if !parts[1].ends_with(".jsonl") {
        return None;
    }
    let session_id = parts[1].trim_end_matches(".jsonl");
    Some(WatchCtx {
        harness: "claude-code".into(),
        session_id: session_id.into(),
        slug: session_id.chars().take(8).collect(),
        project_id: Some(project_id.into()),
        project_label: Some(derive_label_simple(project_id)),
        agent_id: None,
        read_mode: None,
    })
}

fn cc_rebuild_arg(rel_path: &str) -> Option<String> {
    let norm = norm_slashes(rel_path);
    let parts: Vec<&str> = norm.split('/').collect();
    if parts.len() == 2 && parts[1].ends_with(".jsonl") {
        return Some(format!("--session={}/{}", parts[0], parts[1]));
    }
    if parts.len() >= 4 && parts[2] == "subagents" {
        return Some(format!("--session={}/{}.jsonl", parts[0], parts[1]));
    }
    None
}

fn codex_match(rel: &str) -> bool {
    let n = norm_slashes(rel);
    // sessions/YYYY/MM/DD/rollout-*.jsonl
    let parts: Vec<&str> = n.split('/').collect();
    if parts.len() != 5 || parts[0] != "sessions" {
        return false;
    }
    if !(parts[1].len() == 4 && parts[1].chars().all(|c| c.is_ascii_digit())) {
        return false;
    }
    if !(parts[2].len() == 2 && parts[2].chars().all(|c| c.is_ascii_digit())) {
        return false;
    }
    if !(parts[3].len() == 2 && parts[3].chars().all(|c| c.is_ascii_digit())) {
        return false;
    }
    parts[4].starts_with("rollout-") && parts[4].ends_with(".jsonl")
}

fn extract_uuid_suffix(s: &str) -> Option<&str> {
    // Match trailing UUID
    let bytes = s.as_bytes();
    if bytes.len() < 36 {
        return None;
    }
    let start = bytes.len() - 36;
    let cand = &s[start..];
    let ok = cand.len() == 36
        && cand.as_bytes()[8] == b'-'
        && cand.as_bytes()[13] == b'-'
        && cand.as_bytes()[18] == b'-'
        && cand.as_bytes()[23] == b'-'
        && cand.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if ok {
        Some(cand)
    } else {
        None
    }
}

fn codex_ctx(rel_path: &str) -> Option<WatchCtx> {
    let n = norm_slashes(rel_path);
    let file = n.rsplit('/').next().unwrap_or("");
    let stem = file.trim_end_matches(".jsonl");
    let session_id = extract_uuid_suffix(stem)?;
    Some(WatchCtx {
        harness: "codex".into(),
        session_id: session_id.into(),
        slug: session_id.chars().take(8).collect(),
        project_id: None,
        project_label: Some("Codex".into()),
        agent_id: None,
        read_mode: None,
    })
}

fn pi_match(rel: &str) -> bool {
    norm_slashes(rel).ends_with(".jsonl")
}

fn pi_ctx(rel_path: &str) -> Option<WatchCtx> {
    let norm = norm_slashes(rel_path);
    let parts: Vec<&str> = norm.split('/').collect();
    if parts.len() < 2 {
        return None;
    }
    let project_id = parts[0];
    let base = parts[1].trim_end_matches(".jsonl");
    let session_id = if let Some(i) = base.find('_') {
        &base[i + 1..]
    } else {
        base
    };
    Some(WatchCtx {
        harness: "pi".into(),
        session_id: session_id.into(),
        slug: session_id.chars().take(8).collect(),
        project_id: Some(project_id.into()),
        project_label: Some(derive_pi_label(project_id)),
        agent_id: None,
        read_mode: None,
    })
}

fn grok_match(rel: &str) -> bool {
    let n = norm_slashes(rel);
    let parts: Vec<&str> = n.split('/').collect();
    parts.len() >= 3 && parts[parts.len() - 1] == "updates.jsonl"
}

fn grok_ctx(rel_path: &str) -> Option<WatchCtx> {
    let norm = norm_slashes(rel_path);
    let parts: Vec<&str> = norm.split('/').collect();
    if parts.len() < 3 || parts[parts.len() - 1] != "updates.jsonl" {
        return None;
    }
    let encoded_cwd = parts[0];
    let session_id = parts[1];
    Some(WatchCtx {
        harness: "grok".into(),
        session_id: session_id.into(),
        slug: session_id.chars().take(8).collect(),
        project_id: Some(derive_grok_project_id(encoded_cwd)),
        project_label: Some(derive_grok_label(encoded_cwd)),
        agent_id: None,
        read_mode: None,
    })
}


fn ag_match(rel: &str) -> bool {
    let n = norm_slashes(rel);
    n.ends_with("transcript.jsonl") || n.ends_with("overview.txt")
}

fn ag_ctx(rel_path: &str) -> Option<WatchCtx> {
    let norm = norm_slashes(rel_path);
    let parts: Vec<&str> = norm.split('/').collect();
    let conv_idx = parts.iter().enumerate().find_map(|(i, _)| {
        if i + 2 < parts.len()
            && parts[i + 1] == ".system_generated"
            && parts[i + 2] == "logs"
        {
            Some(i)
        } else {
            None
        }
    })?;
    let session_id = parts[conv_idx];
    Some(WatchCtx {
        harness: "antigravity".into(),
        session_id: session_id.into(),
        slug: session_id.chars().take(8).collect(),
        project_id: None,
        project_label: Some("antigravity".into()),
        agent_id: None,
        read_mode: None,
    })
}

fn cp_match(rel: &str) -> bool {
    let n = norm_slashes(rel);
    let parts: Vec<&str> = n.split('/').collect();
    parts.len() == 3 && parts[1] == "chatSessions" && parts[2].ends_with(".jsonl")
}

fn cp_ctx(rel_path: &str) -> Option<WatchCtx> {
    let norm = norm_slashes(rel_path);
    let parts: Vec<&str> = norm.split('/').collect();
    if parts.len() != 3 {
        return None;
    }
    let session_id = parts[2].trim_end_matches(".jsonl");
    Some(WatchCtx {
        harness: "copilot".into(),
        session_id: session_id.into(),
        slug: session_id.chars().take(8).collect(),
        project_id: None,
        project_label: None,
        agent_id: None,
        read_mode: None,
    })
}

fn cmd_match(rel: &str) -> bool {
    let n = norm_slashes(rel);
    n.ends_with(".jsonl") && !n.ends_with(".checkpoints.jsonl")
}

fn cmd_ctx(rel_path: &str) -> Option<WatchCtx> {
    let norm = norm_slashes(rel_path);
    let parts: Vec<&str> = norm.split('/').collect();
    if parts.len() < 2 {
        return None;
    }
    let project_id = parts[0];
    let session_id = parts[1].trim_end_matches(".jsonl");
    Some(WatchCtx {
        harness: "command-code".into(),
        session_id: session_id.into(),
        slug: session_id.chars().take(8).collect(),
        project_id: Some(project_id.into()),
        project_label: Some(derive_command_code_label(project_id)),
        agent_id: None,
        read_mode: None,
    })
}

fn null_rebuild(_: &str) -> Option<String> {
    None
}

fn oc_match(rel: &str) -> bool {
    let n = norm_slashes(rel);
    (n.starts_with("session/") && n.contains("/ses_") && n.ends_with(".json"))
        || (n.starts_with("message/") && n.contains("/msg_") && n.ends_with(".json"))
        || (n.starts_with("part/") && n.contains("/prt_") && n.ends_with(".json"))
}

fn oc_slug(session_id: &str) -> String {
    crate::helpers::opencode_slug(session_id)
}

fn oc_ctx(rel_path: &str) -> Option<WatchCtx> {
    let norm = norm_slashes(rel_path);
    let parts: Vec<&str> = norm.split('/').collect();
    if parts.len() < 3 {
        return None;
    }
    let session_id = if parts[0] == "session" {
        Some(parts[2].trim_end_matches(".json").to_string())
    } else if parts[0] == "message" {
        Some(parts[1].to_string())
    } else {
        None
    };
    Some(WatchCtx {
        harness: "opencode".into(),
        session_id: session_id.clone().unwrap_or_default(),
        slug: session_id.as_deref().map(oc_slug).unwrap_or_default(),
        project_id: None,
        project_label: None,
        agent_id: None,
        read_mode: Some("json".into()),
    })
}

fn descriptors() -> [HarnessDescriptor; 8] {
    [
        HarnessDescriptor {
            id: "claude-code",
            label: "Claude Code",
            capabilities: HarnessCapabilities {
                tokens: true,
                pulse: true,
                trace: true,
                context_resets: true,
                ai_title: true,
                subagent_count: true,
                subagent_tree: true,
                branches: true,
                size_proxy: "tokens_work",
            },
            adapter: claude_code::records_to_normalized,
            match_log_file: cc_match,
            ctx_from_path: cc_ctx,
            rebuild_arg: cc_rebuild_arg,
        },
        HarnessDescriptor {
            id: "codex",
            label: "Codex",
            capabilities: HarnessCapabilities {
                tokens: true,
                pulse: true,
                trace: true,
                context_resets: false,
                ai_title: true,
                subagent_count: false,
                subagent_tree: false,
                branches: true,
                size_proxy: "tokens_work",
            },
            adapter: codex::records_to_normalized,
            match_log_file: codex_match,
            ctx_from_path: codex_ctx,
            rebuild_arg: null_rebuild,
        },
        HarnessDescriptor {
            id: "pi",
            label: "Pi",
            capabilities: HarnessCapabilities {
                tokens: true,
                pulse: true,
                trace: true,
                context_resets: false,
                ai_title: false,
                subagent_count: false,
                subagent_tree: false,
                branches: false,
                size_proxy: "tokens_work",
            },
            adapter: pi::records_to_normalized,
            match_log_file: pi_match,
            ctx_from_path: pi_ctx,
            rebuild_arg: null_rebuild,
        },
        HarnessDescriptor {
            id: "antigravity",
            label: "Google Antigravity",
            capabilities: HarnessCapabilities {
                tokens: false,
                pulse: true,
                trace: false,
                context_resets: false,
                ai_title: false,
                subagent_count: false,
                subagent_tree: false,
                branches: false,
                size_proxy: "tool_calls",
            },
            adapter: antigravity::records_to_normalized,
            match_log_file: ag_match,
            ctx_from_path: ag_ctx,
            rebuild_arg: null_rebuild,
        },
        HarnessDescriptor {
            id: "grok",
            label: "Grok Build",
            capabilities: HarnessCapabilities {
                tokens: false,
                pulse: true,
                trace: true,
                context_resets: true,
                ai_title: true,
                subagent_count: true,
                subagent_tree: false,
                branches: true,
                size_proxy: "tool_calls",
            },
            adapter: grok::records_to_normalized,
            match_log_file: grok_match,
            ctx_from_path: grok_ctx,
            rebuild_arg: null_rebuild,
        },
        HarnessDescriptor {
            id: "opencode",
            label: "opencode",
            capabilities: HarnessCapabilities {
                tokens: true,
                pulse: true,
                trace: true,
                context_resets: false,
                ai_title: true,
                subagent_count: false,
                subagent_tree: false,
                branches: false,
                size_proxy: "tokens_work",
            },
            adapter: opencode::records_to_normalized,
            match_log_file: oc_match,
            ctx_from_path: oc_ctx,
            rebuild_arg: null_rebuild,
        },
        HarnessDescriptor {
            id: "copilot",
            label: "GitHub Copilot",
            capabilities: HarnessCapabilities {
                tokens: true,
                pulse: true,
                trace: true,
                context_resets: false,
                ai_title: true,
                subagent_count: false,
                subagent_tree: false,
                branches: false,
                size_proxy: "tokens_work",
            },
            adapter: copilot::records_to_normalized,
            match_log_file: cp_match,
            ctx_from_path: cp_ctx,
            rebuild_arg: null_rebuild,
        },
        HarnessDescriptor {
            id: "command-code",
            label: "Command Code",
            capabilities: HarnessCapabilities {
                tokens: false,
                pulse: true,
                trace: true,
                context_resets: false,
                ai_title: true,
                subagent_count: false,
                subagent_tree: false,
                branches: true,
                size_proxy: "tool_calls",
            },
            adapter: command_code::records_to_normalized,
            match_log_file: cmd_match,
            ctx_from_path: cmd_ctx,
            rebuild_arg: null_rebuild,
        },
    ]
}

pub fn harness_registry() -> Vec<HarnessDescriptor> {
    descriptors().to_vec()
}

pub fn get_harness(id: &str) -> Option<HarnessDescriptor> {
    descriptors().into_iter().find(|h| h.id == id)
}

pub fn get_enabled_harnesses(ids: &[&str]) -> Vec<HarnessDescriptor> {
    ids.iter().filter_map(|id| get_harness(id)).collect()
}
