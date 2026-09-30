//! Codex rollout JSONL → NormalizedRecord[] — port of `hooks/adapters/codex.mjs`.

use crate::helpers::{categorize_bash, is_bash_tool_name};
use crate::normalized_record::nr_base;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

const HARNESS: &str = "codex";

fn ts_of(rec: &Value) -> Value {
    rec.get("timestamp").cloned().unwrap_or(Value::Null)
}

fn text_from_content(content: &Value, wanted: &[&str]) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    let Some(arr) = content.as_array() else {
        return String::new();
    };
    arr.iter()
        .filter(|b| {
            b.get("type")
                .and_then(|t| t.as_str())
                .map(|t| wanted.contains(&t))
                .unwrap_or(false)
        })
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_tag_blocks(mut s: String) -> String {
    // Remove <tag>...</tag> blocks and bare <tag> tokens (JS stripInfrastructure).
    loop {
        let Some(open) = s.find('<') else { break };
        let rest = &s[open..];
        let Some(gt) = rest.find('>') else { break };
        let tag_body = &rest[1..gt];
        if tag_body.starts_with('/') {
            // closing tag alone
            s = format!("{}{}", &s[..open], &rest[gt + 1..]);
            continue;
        }
        let name: String = tag_body
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            s = format!("{}{}", &s[..open], &rest[gt + 1..]);
            continue;
        }
        if tag_body.ends_with('/') {
            // self-closing
            s = format!("{}{}", &s[..open], &rest[gt + 1..]);
            continue;
        }
        let close = format!("</{name}>");
        if let Some(close_at) = s[open + gt + 1..].find(&close) {
            let end = open + gt + 1 + close_at + close.len();
            s = format!("{}{}", &s[..open], &s[end..]);
        } else {
            s = format!("{}{}", &s[..open], &rest[gt + 1..]);
        }
    }
    collapse_ws(&s)
}

fn collapse_ws(s: &str) -> String {
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

fn parse_arguments(raw: Option<&str>) -> Map<String, Value> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Map::new();
    };
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

fn command_from_args(args: &Map<String, Value>) -> Option<String> {
    args.get("cmd")
        .or_else(|| args.get("command"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn extract_exit_code(text: &str) -> Option<i64> {
    // Match: Process exited with code N  OR  exitCode": N / exitCode': N / exitCode: N
    let lower_markers = ["process exited with code", "exitcode"];
    let lower = text.to_ascii_lowercase();
    for marker in lower_markers {
        if let Some(idx) = lower.find(marker) {
            let after = &text[idx + marker.len()..];
            let trimmed = after.trim_start_matches(['"', '\'', ':', ' ', '\t']);
            let num: String = trimmed
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '-')
                .collect();
            if let Ok(n) = num.parse::<i64>() {
                return Some(n);
            }
        }
    }
    None
}

fn has_failure_text(output: &str) -> bool {
    if let Some(n) = extract_exit_code(output) {
        return n != 0;
    }
    let lower = output.to_ascii_lowercase();
    for needle in ["error", "failed", "exception", "traceback"] {
        // word-boundary-ish: start or non-alnum before, non-alnum or end after
        let mut start = 0;
        while let Some(rel) = lower[start..].find(needle) {
            let i = start + rel;
            let before_ok = i == 0 || !lower.as_bytes()[i - 1].is_ascii_alphanumeric();
            let after = i + needle.len();
            let after_ok =
                after >= lower.len() || !lower.as_bytes()[after].is_ascii_alphanumeric();
            if before_ok && after_ok {
                return true;
            }
            start = i + 1;
        }
    }
    false
}

fn files_from_patch(patch_text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in patch_text.lines() {
        for prefix in ["*** Add File: ", "*** Update File: ", "*** Delete File: "] {
            if let Some(rest) = line.strip_prefix(prefix) {
                let p = rest.trim();
                if !p.is_empty() {
                    out.push(p.to_string());
                }
            }
        }
    }
    out
}

fn patch_output_failed(output: &str) -> bool {
    if let Ok(parsed) = serde_json::from_str::<Value>(output) {
        if let Some(code) = parsed
            .pointer("/metadata/exit_code")
            .and_then(|v| v.as_i64())
        {
            return code != 0;
        }
    }
    has_failure_text(output)
}

fn token_usage(payload: &Value) -> Option<Value> {
    let usage = payload.pointer("/info/last_token_usage")?;
    Some(json!({
        "input": 0,
        "output": usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
        "cache_create": 0,
        "cache_read": 0,
    }))
}

fn opt_str_field(map: &mut Map<String, Value>, key: &str, val: Option<&str>) {
    if let Some(s) = val.filter(|s| !s.is_empty()) {
        map.insert(key.into(), Value::String(s.into()));
    }
}

/// Convert raw Codex rollout records into NormalizedRecord objects (JSON).
pub fn records_to_normalized(records: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut tool_by_call_id: HashMap<String, String> = HashMap::new();
    let mut last_branch: Option<String> = None;

    for rec in records {
        let ts = ts_of(rec);
        let rec_type = rec.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let payload = rec.get("payload").cloned().unwrap_or(json!({}));

        if rec_type == "session_meta" {
            let branch = payload
                .pointer("/git/branch")
                .and_then(|b| b.as_str())
                .map(|s| s.to_string());
            let mut m = nr_base("session_meta", HARNESS, &ts);
            let id = payload
                .get("id")
                .or_else(|| payload.get("session_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let slug: String = id.chars().take(8).collect();
            if !slug.is_empty() {
                m.insert("slug".into(), Value::String(slug));
            }
            opt_str_field(
                &mut m,
                "version",
                payload.get("cli_version").and_then(|v| v.as_str()),
            );
            opt_str_field(
                &mut m,
                "entrypoint",
                payload
                    .get("originator")
                    .or_else(|| payload.get("source"))
                    .and_then(|v| v.as_str()),
            );
            opt_str_field(&mut m, "cwd", payload.get("cwd").and_then(|v| v.as_str()));
            if let Some(ref b) = branch {
                m.insert("branch".into(), Value::String(b.clone()));
            }
            opt_str_field(
                &mut m,
                "model",
                payload.get("model").and_then(|v| v.as_str()),
            );
            out.push(Value::Object(m));
            if let Some(ref b) = branch {
                if last_branch.as_ref() != Some(b) {
                    last_branch = Some(b.clone());
                    let mut bc = nr_base("branch_change", HARNESS, &ts);
                    bc.insert("branch".into(), Value::String(b.clone()));
                    out.push(Value::Object(bc));
                }
            }
            continue;
        }

        if rec_type == "turn_context" {
            let branch = payload.pointer("/git/branch").and_then(|b| b.as_str());
            let mut m = nr_base("session_meta", HARNESS, &ts);
            opt_str_field(&mut m, "cwd", payload.get("cwd").and_then(|v| v.as_str()));
            opt_str_field(
                &mut m,
                "model",
                payload.get("model").and_then(|v| v.as_str()),
            );
            opt_str_field(&mut m, "branch", branch);
            out.push(Value::Object(m));
            continue;
        }

        if rec_type == "event_msg" {
            if payload.get("type").and_then(|t| t.as_str()) == Some("token_count") {
                if let Some(tokens) = token_usage(&payload) {
                    let mut m = nr_base("tokens", HARNESS, &ts);
                    m.insert("tokens".into(), tokens);
                    out.push(Value::Object(m));
                }
            }
            continue;
        }

        if rec_type != "response_item" {
            continue;
        }

        let ptype = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");

        if ptype == "message" {
            let role = payload.get("role").and_then(|r| r.as_str()).unwrap_or("");
            if role == "user" {
                let text = text_from_content(
                    payload.get("content").unwrap_or(&Value::Null),
                    &["input_text"],
                );
                let cleaned = strip_tag_blocks(text);
                if cleaned.is_empty() {
                    continue;
                }
                let mut m = nr_base("user_turn", HARNESS, &ts);
                if cleaned.len() >= 8 {
                    m.insert("text".into(), Value::String(cleaned.clone()));
                } else {
                    m.insert("text".into(), Value::Null);
                }
                m.insert(
                    "display_text".into(),
                    Value::String(cleaned.chars().take(500).collect()),
                );
                out.push(Value::Object(m));
            } else if role == "assistant" {
                let text = text_from_content(
                    payload.get("content").unwrap_or(&Value::Null),
                    &["output_text"],
                );
                let mut m = nr_base("assistant_turn", HARNESS, &ts);
                m.insert(
                    "model".into(),
                    payload.get("model").cloned().unwrap_or(Value::Null),
                );
                m.insert(
                    "stop_reason".into(),
                    payload.get("status").cloned().unwrap_or(Value::Null),
                );
                m.insert("content_length".into(), json!(text.len() as u64));
                out.push(Value::Object(m));
                if !text.is_empty() {
                    let mut cb = nr_base("content_block", HARNESS, &ts);
                    cb.insert("block_type".into(), Value::String("text".into()));
                    cb.insert("text".into(), Value::String(text));
                    out.push(Value::Object(cb));
                }
            }
            continue;
        }

        if ptype == "reasoning" {
            let mut cb = nr_base("content_block", HARNESS, &ts);
            cb.insert("block_type".into(), Value::String("thinking".into()));
            out.push(Value::Object(cb));
            continue;
        }

        if ptype == "function_call" {
            let args = parse_arguments(payload.get("arguments").and_then(|a| a.as_str()));
            let command = command_from_args(&args);
            let mut input = args.clone();
            if let Some(ref cmd) = command {
                if !input.contains_key("command") {
                    input.insert("command".into(), Value::String(cmd.clone()));
                }
            }
            if let Some(wd) = args.get("workdir").and_then(|v| v.as_str()) {
                if !input.contains_key("path") {
                    input.insert("path".into(), Value::String(wd.into()));
                }
            }
            let tool = payload
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("unknown")
                .to_string();
            if let Some(cid) = payload.get("call_id").and_then(|c| c.as_str()) {
                tool_by_call_id.insert(cid.into(), tool.clone());
            }
            let is_shell = is_bash_tool_name(&tool);
            let mut m = nr_base("tool_use", HARNESS, &ts);
            m.insert("tool".into(), Value::String(tool));
            m.insert(
                "category".into(),
                if is_shell {
                    Value::String(categorize_bash(command.as_deref()).into())
                } else {
                    Value::Null
                },
            );
            if let Some(cid) = payload.get("call_id").and_then(|c| c.as_str()) {
                m.insert("tool_id".into(), Value::String(cid.into()));
            }
            m.insert("input".into(), Value::Object(input));
            out.push(Value::Object(m));
            continue;
        }

        if ptype == "function_call_output" {
            let call_id = payload.get("call_id").and_then(|c| c.as_str());
            let tool = call_id
                .and_then(|id| tool_by_call_id.get(id))
                .cloned()
                .unwrap_or_else(|| "unknown".into());
            let output = payload
                .get("output")
                .and_then(|o| o.as_str())
                .unwrap_or("");
            let error = has_failure_text(output);
            let mut m = nr_base("tool_result", HARNESS, &ts);
            m.insert("tool".into(), Value::String(tool));
            if let Some(cid) = call_id {
                m.insert("tool_id".into(), Value::String(cid.into()));
            }
            m.insert("error".into(), Value::Bool(error));
            if error {
                let et: String = output.trim().chars().take(300).collect();
                if !et.is_empty() {
                    m.insert("error_text".into(), Value::String(et));
                }
            }
            out.push(Value::Object(m));
            continue;
        }

        if ptype == "custom_tool_call" {
            let tool = payload
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("unknown")
                .to_string();
            if let Some(cid) = payload.get("call_id").and_then(|c| c.as_str()) {
                tool_by_call_id.insert(cid.into(), tool.clone());
            }
            let patch = payload.get("input").and_then(|i| i.as_str()).unwrap_or("");
            let paths = files_from_patch(patch);
            let mut m = nr_base("tool_use", HARNESS, &ts);
            m.insert("tool".into(), Value::String(tool));
            m.insert("category".into(), Value::Null);
            if let Some(cid) = payload.get("call_id").and_then(|c| c.as_str()) {
                m.insert("tool_id".into(), Value::String(cid.into()));
            }
            m.insert("input".into(), json!({ "paths": paths }));
            out.push(Value::Object(m));
            continue;
        }

        if ptype == "custom_tool_call_output" {
            let call_id = payload.get("call_id").and_then(|c| c.as_str());
            let tool = call_id
                .and_then(|id| tool_by_call_id.get(id))
                .cloned()
                .unwrap_or_else(|| "unknown".into());
            let output = payload
                .get("output")
                .and_then(|o| o.as_str())
                .unwrap_or("");
            let error = patch_output_failed(output);
            let mut m = nr_base("tool_result", HARNESS, &ts);
            m.insert("tool".into(), Value::String(tool));
            if let Some(cid) = call_id {
                m.insert("tool_id".into(), Value::String(cid.into()));
            }
            m.insert("error".into(), Value::Bool(error));
            if error {
                let et: String = output.trim().chars().take(300).collect();
                if !et.is_empty() {
                    m.insert("error_text".into(), Value::String(et));
                }
            }
            out.push(Value::Object(m));
        }
    }

    out
}
