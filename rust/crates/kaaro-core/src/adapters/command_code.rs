//! Command Code JSONL → NormalizedRecord[] — port of `hooks/adapters/command-code.mjs`.

use crate::helpers::{categorize_bash, strip_first_user_message};
use crate::normalized_record::nr_base;
use serde_json::{json, Value};

const HARNESS: &str = "command-code";

fn ts_of(rec: &Value) -> Value {
    rec.get("timestamp").cloned().unwrap_or(Value::Null)
}

fn extract_user_text(content: &Value) -> String {
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

fn push_tool_result(out: &mut Vec<Value>, ts: &Value, block: &Value) {
    let error = block
        .pointer("/output/type")
        .and_then(|t| t.as_str())
        == Some("error-text");
    let mut m = nr_base("tool_result", HARNESS, ts);
    m.insert("error".into(), Value::Bool(error));
    m.insert(
        "tool".into(),
        Value::String(
            block
                .get("toolName")
                .and_then(|t| t.as_str())
                .unwrap_or("unknown")
                .into(),
        ),
    );
    if let Some(id) = block.get("toolCallId").and_then(|t| t.as_str()) {
        m.insert("tool_id".into(), Value::String(id.into()));
    }
    if error {
        let et: String = block
            .pointer("/output/value")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .chars()
            .take(300)
            .collect();
        if !et.is_empty() {
            m.insert("error_text".into(), Value::String(et));
        }
    }
    out.push(Value::Object(m));
}

/// Convert raw Command Code JSONL records into NormalizedRecord objects (JSON).
pub fn records_to_normalized(records: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut first_user_seen = false;
    let mut last_branch: Option<String> = None;

    for rec in records {
        let ts = ts_of(rec);

        if let Some(branch) = rec.get("gitBranch").and_then(|b| b.as_str()) {
            if last_branch.as_deref() != Some(branch) {
                if last_branch.is_some() {
                    let mut bc = nr_base("branch_change", HARNESS, &ts);
                    bc.insert("branch".into(), Value::String(branch.into()));
                    out.push(Value::Object(bc));
                }
                last_branch = Some(branch.into());
            }
        }

        let role = rec.get("role").and_then(|r| r.as_str()).unwrap_or("");

        if role == "user" && rec.get("content").is_some() {
            let content = rec.get("content").unwrap();
            let text = extract_user_text(content);
            let mut user_text = Value::Null;
            if !first_user_seen {
                let stripped = strip_first_user_message(&text);
                if stripped.len() >= 8 {
                    user_text = Value::String(stripped);
                    first_user_seen = true;
                }
            }
            let display_text = if text.trim().is_empty() {
                Value::Null
            } else {
                Value::String(text.trim().chars().take(500).collect())
            };
            let mut m = nr_base("user_turn", HARNESS, &ts);
            m.insert("text".into(), user_text);
            m.insert("display_text".into(), display_text);
            m.insert(
                "branch".into(),
                rec.get("gitBranch").cloned().unwrap_or(Value::Null),
            );
            out.push(Value::Object(m));

            if let Some(arr) = content.as_array() {
                for block in arr {
                    if block.get("type").and_then(|t| t.as_str()) == Some("tool-result") {
                        push_tool_result(&mut out, &ts, block);
                    }
                }
            }
        }

        if role == "assistant" && rec.get("content").is_some() {
            let mut m = nr_base("assistant_turn", HARNESS, &ts);
            m.insert("model".into(), Value::Null);
            m.insert("stop_reason".into(), Value::Null);
            out.push(Value::Object(m));

            if let Some(arr) = rec.get("content").and_then(|c| c.as_array()) {
                for block in arr {
                    let bt = block.get("type").and_then(|t| t.as_str()).unwrap_or("unknown");
                    let block_type = if bt == "reasoning" {
                        "thinking"
                    } else if bt == "tool-call" {
                        "tool_use"
                    } else {
                        bt
                    };
                    let mut cb = nr_base("content_block", HARNESS, &ts);
                    cb.insert("block_type".into(), Value::String(block_type.into()));
                    if bt == "text" || (bt == "reasoning" && block.get("text").is_some()) {
                        if let Some(text) = block.get("text") {
                            cb.insert("text".into(), text.clone());
                        }
                    }
                    out.push(Value::Object(cb));

                    if bt == "tool-call" {
                        let name = block
                            .get("toolName")
                            .and_then(|t| t.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let is_bash = matches!(
                            name.to_ascii_lowercase().as_str(),
                            "bash" | "powershell" | "shell"
                        );
                        let cmd = block.pointer("/input/command").and_then(|c| c.as_str());
                        let category = if is_bash {
                            Value::String(categorize_bash(cmd).into())
                        } else {
                            Value::Null
                        };
                        let mut tu = nr_base("tool_use", HARNESS, &ts);
                        tu.insert("tool".into(), Value::String(name));
                        tu.insert("category".into(), category);
                        if let Some(id) = block.get("toolCallId").and_then(|t| t.as_str()) {
                            tu.insert("tool_id".into(), Value::String(id.into()));
                        }
                        tu.insert(
                            "input".into(),
                            block.get("input").cloned().unwrap_or(json!({})),
                        );
                        out.push(Value::Object(tu));
                    }
                }
            }
        }

        if role == "tool" {
            if let Some(arr) = rec.get("content").and_then(|c| c.as_array()) {
                for block in arr {
                    if block.get("type").and_then(|t| t.as_str()) == Some("tool-result") {
                        push_tool_result(&mut out, &ts, block);
                    }
                }
            }
        }
    }

    out
}
