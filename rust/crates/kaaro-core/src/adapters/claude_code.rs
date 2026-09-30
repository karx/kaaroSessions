//! Claude Code JSONL → NormalizedRecord[] — port of `hooks/adapters/claude-code.mjs`.

use crate::helpers::{
    categorize_bash, extract_skills, extract_text_from_content, strip_first_user_message,
};
use crate::normalized_record::nr_base;
use serde_json::{json, Map, Value};

const HARNESS: &str = "claude-code";

fn ts_of(rec: &Value) -> Value {
    rec.get("timestamp").cloned().unwrap_or(Value::Null)
}

fn is_bash_tool(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "bash" | "powershell" | "shell" | "run_command"
    )
}

/// Convert raw Claude Code JSONL records into NormalizedRecord objects (JSON).
pub fn records_to_normalized(records: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut first_user_seen = false;
    let mut last_branch: Option<String> = None;

    for rec in records {
        let ts = ts_of(rec);
        let rec_type = rec.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let mut handled = false;

        if rec_type == "permission-mode" {
            handled = true;
            let mut m = nr_base("permission_mode", HARNESS, &ts);
            m.insert(
                "mode".into(),
                rec.get("permissionMode").cloned().unwrap_or(Value::Null),
            );
            out.push(Value::Object(m));
        }

        if rec_type == "system" && rec.get("subtype").and_then(|s| s.as_str()) == Some("compact_boundary")
        {
            handled = true;
            out.push(Value::Object(nr_base("context_reset", HARNESS, &ts)));
        }

        if rec_type == "mode" {
            handled = true;
            let mut m = nr_base("mode_shift", HARNESS, &ts);
            m.insert(
                "mode".into(),
                rec.get("mode").cloned().unwrap_or(Value::Null),
            );
            out.push(Value::Object(m));
        }

        if rec_type == "attachment" {
            handled = true;
            let subtype = rec
                .pointer("/attachment/type")
                .cloned()
                .unwrap_or(Value::Null);
            let mut m = nr_base("attachment", HARNESS, &ts);
            m.insert("subtype".into(), subtype.clone());
            out.push(Value::Object(m));

            if subtype.as_str() == Some("invoked_skills") {
                if let Some(skills) = rec.pointer("/attachment/skills").and_then(|s| s.as_array()) {
                    for s in skills {
                        let name = if let Some(n) = s.as_str() {
                            Some(n.to_string())
                        } else {
                            s.get("name")
                                .and_then(|n| n.as_str())
                                .filter(|n| !n.is_empty())
                                .map(|n| n.to_string())
                        };
                        if let Some(name) = name {
                            let mut sm = nr_base("skill_invoke", HARNESS, &ts);
                            sm.insert("skill".into(), Value::String(name));
                            out.push(Value::Object(sm));
                        }
                    }
                }
            }
        }

        if rec_type == "last-prompt" {
            handled = true;
            let mut m = nr_base("session_meta", HARNESS, &ts);
            m.insert(
                "last_prompt".into(),
                rec.get("lastPrompt").cloned().unwrap_or(Value::Null),
            );
            out.push(Value::Object(m));
        }

        if rec_type == "file-history-snapshot" {
            handled = true;
            out.push(Value::Object(nr_base("session_meta", HARNESS, &ts)));
        }

        if rec_type == "ai-title" {
            handled = true;
            let title = rec
                .get("aiTitle")
                .or_else(|| rec.get("title"))
                .cloned()
                .unwrap_or(Value::Null);
            let mut m = nr_base("session_meta", HARNESS, &ts);
            m.insert("ai_title".into(), title);
            out.push(Value::Object(m));
        }

        if rec_type == "system" && rec.get("subtype").and_then(|s| s.as_str()) == Some("turn_duration")
        {
            handled = true;
            let mut m = nr_base("session_meta", HARNESS, &ts);
            for (k, src) in [
                ("slug", "slug"),
                ("duration_ms", "durationMs"),
                ("message_count", "messageCount"),
                ("version", "version"),
                ("entrypoint", "entrypoint"),
                ("cwd", "cwd"),
                ("branch", "gitBranch"),
            ] {
                if let Some(v) = rec.get(src) {
                    m.insert(k.into(), v.clone());
                }
            }
            out.push(Value::Object(m));

            if let Some(branch) = rec.get("gitBranch").and_then(|b| b.as_str()) {
                if last_branch.as_deref() != Some(branch) {
                    last_branch = Some(branch.to_string());
                    let mut bm = nr_base("branch_change", HARNESS, &ts);
                    bm.insert("branch".into(), Value::String(branch.into()));
                    out.push(Value::Object(bm));
                }
            }
        }

        if rec_type == "user" && rec.get("message").is_some() {
            handled = true;
            let content = rec
                .pointer("/message/content")
                .cloned()
                .unwrap_or(Value::Null);
            let text = extract_text_from_content(&content);

            let mut user_text = Value::Null;
            if !first_user_seen {
                let stripped = strip_first_user_message(&text);
                if stripped.len() >= 8
                    && !stripped.starts_with("Base directory for this skill")
                    && !stripped.starts_with("Caveat:")
                {
                    user_text = Value::String(stripped);
                    first_user_seen = true;
                }
            }

            let display_text = {
                let t = text.trim();
                if t.is_empty() {
                    Value::Null
                } else {
                    let sliced: String = t.chars().take(500).collect();
                    if sliced.is_empty() {
                        Value::Null
                    } else {
                        Value::String(sliced)
                    }
                }
            };

            let mut m = nr_base("user_turn", HARNESS, &ts);
            m.insert("text".into(), user_text);
            m.insert("display_text".into(), display_text);
            for (k, src) in [
                ("version", "version"),
                ("entrypoint", "entrypoint"),
                ("cwd", "cwd"),
            ] {
                if let Some(v) = rec.get(src) {
                    m.insert(k.into(), v.clone());
                }
            }
            if let Some(v) = rec.get("gitBranch") {
                m.insert("branch".into(), v.clone());
            }
            out.push(Value::Object(m));

            if let Some(branch) = rec.get("gitBranch").and_then(|b| b.as_str()) {
                if last_branch.as_deref() != Some(branch) {
                    last_branch = Some(branch.to_string());
                    let mut bm = nr_base("branch_change", HARNESS, &ts);
                    bm.insert("branch".into(), Value::String(branch.into()));
                    out.push(Value::Object(bm));
                }
            }

            for skill in extract_skills(&text) {
                let mut sm = nr_base("skill_invoke", HARNESS, &ts);
                sm.insert("skill".into(), Value::String(skill));
                out.push(Value::Object(sm));
            }

            if let Some(arr) = content.as_array() {
                for block in arr {
                    if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                        continue;
                    }
                    let is_error = block
                        .get("is_error")
                        .and_then(|e| e.as_bool())
                        .unwrap_or(false);
                    let mut tr = nr_base("tool_result", HARNESS, &ts);
                    tr.insert("error".into(), Value::Bool(is_error));
                    tr.insert(
                        "tool".into(),
                        block
                            .get("tool_name")
                            .cloned()
                            .unwrap_or_else(|| Value::String("unknown".into())),
                    );
                    if let Some(id) = block.get("tool_use_id") {
                        tr.insert("tool_id".into(), id.clone());
                    }
                    if is_error {
                        let raw = match block.get("content") {
                            Some(Value::Array(parts)) => parts
                                .iter()
                                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                                .collect::<Vec<_>>()
                                .join(" "),
                            Some(Value::String(s)) => s.clone(),
                            Some(other) => other.to_string(),
                            None => String::new(),
                        };
                        let trimmed = raw.trim();
                        if !trimmed.is_empty() {
                            let sliced: String = trimmed.chars().take(300).collect();
                            tr.insert("error_text".into(), Value::String(sliced));
                        }
                    }
                    out.push(Value::Object(tr));
                }
            }
        }

        if rec_type == "assistant" && rec.get("message").is_some() {
            handled = true;
            let msg = rec.get("message").unwrap();
            let mut at = nr_base("assistant_turn", HARNESS, &ts);
            if let Some(model) = msg.get("model") {
                at.insert("model".into(), model.clone());
            }
            if let Some(sr) = msg.get("stop_reason") {
                at.insert("stop_reason".into(), sr.clone());
            }
            out.push(Value::Object(at));

            if msg.get("usage").is_some() {
                let u = msg.get("usage").unwrap();
                let empty = Map::new();
                let uobj = u.as_object().unwrap_or(&empty);
                let num = |k: &str| -> i64 {
                    uobj.get(k).and_then(|v| v.as_i64()).unwrap_or(0)
                };
                let mut tm = nr_base("tokens", HARNESS, &ts);
                tm.insert(
                    "tokens".into(),
                    json!({
                        "input": num("input_tokens"),
                        "output": num("output_tokens"),
                        "cache_create": num("cache_creation_input_tokens"),
                        "cache_read": num("cache_read_input_tokens"),
                    }),
                );
                out.push(Value::Object(tm));
            }

            let empty_arr: Vec<Value> = Vec::new();
            let blocks = msg
                .get("content")
                .and_then(|c| c.as_array())
                .unwrap_or(&empty_arr);
            for block in blocks {
                let bt = block
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("unknown");
                let mut cb = nr_base("content_block", HARNESS, &ts);
                cb.insert("block_type".into(), Value::String(bt.into()));
                if bt == "text" {
                    if let Some(t) = block.get("text") {
                        cb.insert("text".into(), t.clone());
                    }
                }
                out.push(Value::Object(cb));

                if bt == "tool_use" {
                    let name = block
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("unknown");
                    let category = if is_bash_tool(name) {
                        let cmd = block.pointer("/input/command").and_then(|c| c.as_str());
                        Value::String(categorize_bash(cmd).into())
                    } else {
                        Value::Null
                    };
                    let mut tu = nr_base("tool_use", HARNESS, &ts);
                    tu.insert("tool".into(), Value::String(name.into()));
                    tu.insert("category".into(), category);
                    if let Some(id) = block.get("id") {
                        tu.insert("tool_id".into(), id.clone());
                    }
                    tu.insert(
                        "input".into(),
                        block
                            .get("input")
                            .cloned()
                            .unwrap_or_else(|| json!({})),
                    );
                    out.push(Value::Object(tu));
                }
            }
        }

        if !handled {
            let mut m = nr_base("unknown_record", HARNESS, &ts);
            m.insert(
                "raw_type".into(),
                rec.get("type").cloned().unwrap_or(Value::Null),
            );
            out.push(Value::Object(m));
        }
    }

    out
}
