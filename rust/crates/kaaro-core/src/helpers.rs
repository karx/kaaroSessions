//! Pure helpers shared by adapters — port of `hooks/helpers/analyze-helpers.mjs`.

use serde_json::Value;

/// Categorize a bash/shell command into a coarse bucket (git/npm/node/fs/…).
pub fn categorize_bash(cmd: Option<&str>) -> &'static str {
    let Some(cmd) = cmd else {
        return "other";
    };
    let c = cmd.trim_start();
    if c.starts_with("git ") {
        "git"
    } else if c.starts_with("npm ") {
        "npm"
    } else if c.starts_with("npx ") {
        "npx"
    } else if c.starts_with("node ") {
        "node"
    } else if c.starts_with("py ") || c.starts_with("python") {
        "python"
    } else if starts_with_fs(c) {
        "fs"
    } else if c.starts_with("curl ") {
        "curl"
    } else {
        "other"
    }
}

fn starts_with_fs(c: &str) -> bool {
    // JS: /^(ls|cat|head|tail|mkdir|rm |cp |mv )/
    c.starts_with("ls")
        || c.starts_with("cat")
        || c.starts_with("head")
        || c.starts_with("tail")
        || c.starts_with("mkdir")
        || c.starts_with("rm ")
        || c.starts_with("cp ")
        || c.starts_with("mv ")
}

/// Pull human text from a CC message content field (string or text blocks).
pub fn extract_text_from_content(content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    let Some(arr) = content.as_array() else {
        return String::new();
    };
    arr.iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Extract skill names from `<command-name>…</command-name>` tags.
/// Mirrors JS: `/<command-name>\/?([\w-]+)<\/command-name>/g`
pub fn extract_skills(text: &str) -> Vec<String> {
    let open = "<command-name>";
    let close = "</command-name>";
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(close) else {
            break;
        };
        let mut name = &after[..end];
        if let Some(stripped) = name.strip_prefix('/') {
            name = stripped;
        }
        if !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            out.push(name.to_string());
        }
        rest = &after[end + close.len()..];
    }
    out
}

/// Strip XML-ish tags from the first user message (session-bundle text).
pub fn strip_first_user_message(text: &str) -> String {
    // JS: .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').replace(/<[^>]+>/g, '')
    let mut s = String::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            if let Some(gt) = text[i..].find('>') {
                let tag_end = i + gt;
                let tag = &text[i..=tag_end];
                // paired tag? look for closing
                if !tag.starts_with("</") && !tag.ends_with("/>") {
                    // extract tag name
                    let name = tag
                        .trim_start_matches('<')
                        .trim_end_matches('>')
                        .split_whitespace()
                        .next()
                        .unwrap_or("");
                    if !name.is_empty() {
                        let closer = format!("</{name}>");
                        if let Some(rel) = text[tag_end + 1..].find(&closer) {
                            i = tag_end + 1 + rel + closer.len();
                            continue;
                        }
                    }
                }
                // unpaired / self-closing / unmatched — drop the open tag only
                i = tag_end + 1;
                continue;
            }
        }
        s.push(bytes[i] as char);
        i += 1;
    }
    // collapse whitespace
    let mut out = String::new();
    let mut prev_space = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_space && !out.is_empty() {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categorize_bash_basic() {
        assert_eq!(categorize_bash(Some("git status")), "git");
        assert_eq!(categorize_bash(Some("node --test")), "node");
        assert_eq!(categorize_bash(Some("ls -la")), "fs");
        assert_eq!(categorize_bash(None), "other");
    }

    #[test]
    fn extract_skills_command_name() {
        let t = "<command-name>review</command-name> fix please";
        assert_eq!(extract_skills(t), vec!["review".to_string()]);
        assert_eq!(
            extract_skills("<command-name>/web-seo</command-name>"),
            vec!["web-seo".to_string()]
        );
    }

    #[test]
    fn strip_tags() {
        let t = "<command-name>review</command-name> fix the auth module please";
        assert_eq!(strip_first_user_message(t), "fix the auth module please");
    }

    #[test]
    fn ms_to_iso_matches_js_date() {
        assert_eq!(ms_to_iso(1766698155332), "2025-12-25T21:29:15.332Z");
        assert_eq!(ms_to_iso(1766696961364), "2025-12-25T21:09:21.364Z");
        assert_eq!(ms_to_iso(0), "1970-01-01T00:00:00.000Z");
    }
}

/// Harness-chrome slash-commands (→ session.builtin_commands).
pub const BUILTIN_COMMANDS: &[&str] = &[
    "exit",
    "clear",
    "compact",
    "context",
    "model",
    "help",
    "voice",
    "plan",
    "fast",
    "config",
    "review",
    "memory",
    "doctor",
    "status",
    "rate-limit-options",
    "mcp",
    "cost",
    "log",
];

pub fn is_builtin_command(skill: &str) -> bool {
    BUILTIN_COMMANDS.contains(&skill)
}

/// Case-insensitive: is this raw tool name a shell?
/// Port of `hooks/action-keys.mjs` `isBashToolName`.
pub fn is_bash_tool_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().trim(),
        "bash"
            | "powershell"
            | "shell"
            | "run_command"
            | "runinterminal"
            | "run_in_terminal"
            | "run_terminal_command"
            | "shell_command"
            | "exec_command"
    )
}

/// Normalize a file path for file_ops keys — port of `normPath`.
pub fn norm_path(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let mut p = raw.replace('\\', "/");
    while p.contains("//") {
        p = p.replace("//", "/");
    }
    let p = p.trim().to_string();
    if p.is_empty() {
        return None;
    }
    // Drive-letter paths lowercased (JS: /^[a-zA-Z]:\//)
    let bytes = p.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'/'
    {
        return Some(p.to_ascii_lowercase());
    }
    Some(p)
}



/// Display label from a project id — port of `deriveLabel` in analyze-helpers.
pub fn derive_label(project_id: &str) -> String {
    // /^[A-Za-z]--src-/
    let bytes = project_id.as_bytes();
    if bytes.len() >= 7
        && bytes[0].is_ascii_alphabetic()
        && &project_id[1..7] == "--src-"
    {
        return project_id[7..].to_string();
    }
    // /^[A-Za-z]--Users-[^-]+-/
    if bytes.len() >= 10 && bytes[0].is_ascii_alphabetic() {
        if let Some(rest) = project_id[1..].strip_prefix("--Users-") {
            if let Some(idx) = rest.find('-') {
                return rest[idx + 1..].to_string();
            }
        }
    }
    project_id.to_string()
}

/// Pi project label — strip outer `--` then [`derive_label`].
pub fn derive_pi_label(slug: &str) -> String {
    let mut s = slug;
    if let Some(r) = s.strip_prefix("--") {
        s = r;
    }
    if let Some(r) = s.strip_suffix("--") {
        s = r;
    }
    derive_label(s)
}


/// Convert Unix epoch milliseconds to an ISO-8601 UTC string (`…Z`), matching
/// JS `new Date(ms).toISOString()`.
pub fn ms_to_iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000) as u32;

    // Howard Hinnant's civil_from_days (days since 1970-01-01 → Y-M-D)
    let z = secs.div_euclid(86_400) + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let mut y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    if m <= 2 {
        y += 1;
    }

    let tod = secs.rem_euclid(86_400) as u32;
    let h = tod / 3600;
    let min = (tod % 3600) / 60;
    let s = tod % 60;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, d, h, min, s, millis
    )
}


/// CC-style project id from a cwd path — port of `deriveAntigravityProjectId`
/// (also used by OpenCode analyze).
pub fn derive_path_project_id(cwd_raw: Option<&str>) -> String {
    let Some(cwd_raw) = cwd_raw.filter(|s| !s.is_empty()) else {
        return "antigravity-unknown".into();
    };
    let mut norm = cwd_raw.replace('\\', "/");
    while norm.ends_with('/') {
        norm.pop();
    }
    let bytes = norm.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/' {
        let drive = (bytes[0] as char).to_ascii_uppercase();
        let rest = norm[3..].replace('/', "-");
        return format!("{drive}--{rest}");
    }
    let s = norm.trim_start_matches('/').replace('/', "-");
    if s.is_empty() {
        "antigravity-unknown".into()
    } else {
        s
    }
}

/// Last path segment as a display label — port of `deriveAntigravityLabel`.
pub fn derive_path_label(cwd_raw: Option<&str>) -> String {
    let Some(cwd_raw) = cwd_raw.filter(|s| !s.is_empty()) else {
        return "unknown".into();
    };
    let mut norm = cwd_raw.replace('\\', "/");
    while norm.ends_with('/') {
        norm.pop();
    }
    norm.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or("unknown").to_string()
}

pub fn opencode_slug(session_id: &str) -> String {
    let s = session_id.strip_prefix("ses_").unwrap_or(session_id);
    s.chars().take(8).collect()
}


/// Merge key for grouping the same repo across harness id dialects.
/// Port of `canonicalProjectId` in analyze-helpers.
pub fn canonical_project_id(raw_id: &str) -> String {
    let mut id = raw_id.to_string();

    // /^users-[^-]+-(.+)$/
    if let Some(rest) = id.strip_prefix("users-") {
        if let Some(dash) = rest.find('-') {
            let remainder = &rest[dash + 1..];
            let bytes = remainder.as_bytes();
            if bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && &remainder[1..3] == "--"
            {
                id = remainder.to_string();
            } else {
                return raw_id.to_string();
            }
        }
    }

    while id.starts_with('-') {
        id = id[1..].to_string();
    }
    while id.ends_with('-') {
        id.pop();
    }

    // /^([a-z])--/ → uppercase drive letter
    let bytes = id.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_lowercase() && &id[1..3] == "--" {
        let drive = (bytes[0] as char).to_ascii_uppercase();
        id = format!("{drive}{}", &id[1..]);
    }
    id
}


// ── Grok helpers (port of hooks/helpers/grok-helpers.mjs) ─────────────────────

/// Decode a URL-encoded Grok project directory name.
pub fn decode_grok_cwd(encoded: Option<&str>) -> Option<String> {
    let encoded = encoded.filter(|s| !s.is_empty())?;
    Some(
        percent_decode(encoded)
            .unwrap_or_else(|| encoded.to_string()),
    )
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            let v = u8::from_str_radix(h, 16).ok()?;
            out.push(v);
            i += 3;
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn derive_grok_project_id(encoded_cwd: &str) -> String {
    let decoded = decode_grok_cwd(Some(encoded_cwd));
    derive_path_project_id(decoded.as_deref())
}

pub fn derive_grok_label(encoded_cwd: &str) -> String {
    let decoded = decode_grok_cwd(Some(encoded_cwd));
    derive_path_label(decoded.as_deref())
}

/// ISO timestamp from a Grok ACP record.
pub fn grok_record_ts(record: &serde_json::Value) -> Option<String> {
    if let Some(ms) = record
        .pointer("/_meta/agentTimestampMs")
        .and_then(|v| v.as_i64())
    {
        return Some(ms_to_iso(ms));
    }
    if let Some(secs) = record.get("timestamp").and_then(|v| v.as_i64()) {
        return Some(ms_to_iso(secs * 1000));
    }
    if let Some(secs) = record.get("timestamp").and_then(|v| v.as_f64()) {
        return Some(ms_to_iso((secs * 1000.0) as i64));
    }
    None
}

pub fn grok_session_update(record: &serde_json::Value) -> Option<String> {
    record
        .pointer("/params/update/sessionUpdate")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

pub fn is_grok_tool_failure(update: &serde_json::Value) -> bool {
    let st = update
        .get("status")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if st != "completed" {
        return false;
    }
    match update.pointer("/rawOutput/exit_code") {
        Some(v) if v.is_i64() || v.is_u64() || v.is_f64() => {
            v.as_i64().or_else(|| v.as_u64().map(|u| u as i64)).unwrap_or(0) != 0
        }
        _ => false,
    }
}


// ── Antigravity helpers ───────────────────────────────────────────────────────

/// Parse a JSON-encoded or plain string arg value from Antigravity tool args.
pub fn parse_arg_value(val: Option<&Value>) -> Option<String> {
    let val = val?;
    if let Some(s) = val.as_str() {
        if s.is_empty() {
            return None;
        }
        // Often double-encoded JSON strings: "\"D:/src/...\""
        if let Ok(inner) = serde_json::from_str::<Value>(s) {
            if let Some(inner_s) = inner.as_str() {
                let t = inner_s.trim();
                return if t.is_empty() { None } else { Some(t.to_string()) };
            }
        }
        return Some(s.trim().to_string());
    }
    None
}

pub fn extract_model_change(content: &str) -> Option<String> {
    // /changed setting `Model Selection` from .+? to (.+?)\.\s/
    let marker = "changed setting `Model Selection` from ";
    let idx = content.find(marker)?;
    let after = &content[idx + marker.len()..];
    let to_idx = after.find(" to ")?;
    let rest = &after[to_idx + 4..];
    let end = rest.find(". ")?;
    let model = rest[..end].trim();
    if model.is_empty() {
        None
    } else {
        Some(model.to_string())
    }
}

pub fn extract_antigravity_user_message(content: &str) -> Option<String> {
    let text = if let Some(start) = content.find("<USER_REQUEST>") {
        let after = &content[start + "<USER_REQUEST>".len()..];
        if let Some(end) = after.find("</USER_REQUEST>") {
            after[..end].to_string()
        } else {
            after.to_string()
        }
    } else {
        content.to_string()
    };
    let stripped = strip_first_user_message(&text);
    if stripped.len() >= 8 {
        Some(stripped.chars().take(200).collect())
    } else {
        None
    }
}

/// Map Antigravity MODEL DONE result type → tool name.
pub fn antigravity_rec_type_to_tool(rec_type: &str) -> Option<&'static str> {
    match rec_type {
        "VIEW_FILE" => Some("view_file"),
        "LIST_DIRECTORY" => Some("list_dir"),
        "GREP_SEARCH" => Some("grep_search"),
        "RUN_COMMAND" | "CODE_ACTION" => Some("run_command"),
        _ => None,
    }
}

/// Detect workspace cwd from PLANNER_RESPONSE tool_calls (most frequent).
pub fn detect_antigravity_workspace(records: &[Value]) -> Option<String> {
    use std::collections::HashMap;
    let mut counts: HashMap<String, usize> = HashMap::new();
    for rec in records {
        if rec.get("type").and_then(|t| t.as_str()) != Some("PLANNER_RESPONSE") {
            continue;
        }
        let Some(arr) = rec.get("tool_calls").and_then(|t| t.as_array()) else {
            continue;
        };
        for tc in arr {
            let name = tc.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = tc.get("args").cloned().unwrap_or(Value::Null);
            let cwd = if name == "run_command" {
                parse_arg_value(args.get("Cwd"))
            } else if name == "list_dir" {
                parse_arg_value(args.get("DirectoryPath"))
            } else if matches!(
                name,
                "view_file"
                    | "write_to_file"
                    | "replace_file_content"
                    | "multi_replace_file_content"
            ) {
                parse_arg_value(
                    args.get("AbsolutePath")
                        .or_else(|| args.get("TargetFile")),
                )
                .and_then(|raw| {
                    let norm = raw.replace('\\', "/");
                    let idx = norm.rfind('/')?;
                    let dir = &norm[..idx];
                    if dir.is_empty() {
                        None
                    } else {
                        Some(dir.to_string())
                    }
                })
            } else {
                None
            };
            if let Some(c) = cwd {
                *counts.entry(c).or_default() += 1;
            }
        }
    }
    counts
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(k, _)| k)
}

// ── Copilot helpers ───────────────────────────────────────────────────────────

/// Decode a Copilot file URI string or UriComponents object → plain path.
pub fn copilot_uri_to_path(uri: &Value) -> Option<String> {
    let mut p = if let Some(s) = uri.as_str() {
        if !s.starts_with("file://") {
            return None;
        }
        let raw = &s["file://".len()..];
        percent_decode(raw).unwrap_or_else(|| raw.to_string())
    } else if let Some(path) = uri.get("path").and_then(|p| p.as_str()) {
        path.to_string()
    } else {
        return None;
    };
    // "/d:/src/…" → "d:/src/…"
    let bytes = p.as_bytes();
    if bytes.len() >= 4
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && bytes[2] == b':'
        && bytes[3] == b'/'
    {
        p = p[1..].to_string();
    }
    Some(p)
}

pub fn copilot_tool_name(tool_id: Option<&str>) -> String {
    let Some(id) = tool_id.filter(|s| !s.is_empty()) else {
        return "unknown".into();
    };
    id.strip_prefix("copilot_").unwrap_or(id).to_string()
}

pub fn invocation_file_path(item: &Value) -> Option<String> {
    let uris = item.pointer("/invocationMessage/uris")?.as_object()?;
    let first_key = uris.keys().next()?.clone();
    let first_val = &uris[&first_key];
    copilot_uri_to_path(first_val).or_else(|| copilot_uri_to_path(&Value::String(first_key)))
}

pub fn workspace_folder_path(ws: &Value) -> Option<String> {
    let folder = ws.get("folder")?;
    copilot_uri_to_path(folder)
}

/// Command Code project label — strip `users-<name>-` then [`derive_label`].
pub fn derive_command_code_label(project_id: &str) -> String {
    let stripped = if let Some(rest) = project_id.strip_prefix("users-") {
        if let Some(dash) = rest.find('-') {
            &rest[dash + 1..]
        } else {
            project_id
        }
    } else {
        project_id
    };
    derive_label(stripped)
}
