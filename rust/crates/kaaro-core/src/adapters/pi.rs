//! Pi JSONL → NormalizedRecord[] — port of `hooks/adapters/pi.mjs`.

use crate::helpers::categorize_bash;
use crate::normalized_record::nr_base;
use serde_json::{json, Map, Value};

const HARNESS: &str = "pi";

fn ts_of(rec: &Value) -> Value {
    rec.get("timestamp").cloned().unwrap_or(Value::Null)
}

fn extract_user_text(content: &Value) -> String {
    let Some(arr) = content.as_array() else {
        return String::new();
    };
    let joined = arr
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join(" ");
    // collapse whitespace like JS `.replace(/\s+/g, ' ').trim()`
    let mut out = String::new();
    let mut prev_space = false;
    for ch in joined.chars() {
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

fn join_provider_model(provider: Option<&str>, model: Option<&str>) -> Option<String> {
    let parts: Vec<&str> = [provider, model].into_iter().flatten().collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn is_bash_tool(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "bash" | "shell" | "powershell"
    )
}

/// Convert raw Pi JSONL records into NormalizedRecord objects (JSON).
pub fn records_to_normalized(records: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();

    for rec in records {
        let ts = ts_of(rec);
        let rec_type = rec.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let mut handled = false;

        if rec_type == "session" {
            handled = true;
            if let Some(cwd) = rec.get("cwd").filter(|c| !c.is_null()) {
                let mut m = nr_base("session_meta", HARNESS, &ts);
                m.insert("cwd".into(), cwd.clone());
                out.push(Value::Object(m));
            }
        }

        if rec_type == "model_change" {
            handled = true;
            let model = join_provider_model(
                rec.get("provider").and_then(|p| p.as_str()),
                rec.get("modelId").and_then(|p| p.as_str()),
            );
            if let Some(model) = model {
                let mut m = nr_base("session_meta", HARNESS, &ts);
                m.insert("model".into(), Value::String(model));
                m.insert("overwrite".into(), Value::Bool(true));
                out.push(Value::Object(m));
            }
        }

        if rec_type == "thinking_level_change" {
            handled = true;
            let mode = rec
                .get("thinkingLevel")
                .and_then(|l| l.as_str())
                .filter(|s| !s.is_empty())
                .map(|l| format!("thinking:{l}"));
            let mut m = nr_base("mode_shift", HARNESS, &ts);
            m.insert(
                "mode".into(),
                mode.map(Value::String).unwrap_or(Value::Null),
            );
            out.push(Value::Object(m));
        }

        if rec_type == "message" && rec.get("message").is_some() {
            handled = true;
            let msg = rec.get("message").unwrap();
            let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");

            if role == "user" {
                let content = msg.get("content").cloned().unwrap_or(Value::Null);
                let text = extract_user_text(&content);
                let user_text = if text.len() >= 8 {
                    Value::String(text.chars().take(200).collect())
                } else {
                    Value::Null
                };
                let mut m = nr_base("user_turn", HARNESS, &ts);
                m.insert("text".into(), user_text);
                out.push(Value::Object(m));
            }

            if role == "assistant" {
                let model = join_provider_model(
                    msg.get("provider").and_then(|p| p.as_str()),
                    msg.get("model").and_then(|p| p.as_str()),
                );
                let mut at = nr_base("assistant_turn", HARNESS, &ts);
                at.insert(
                    "model".into(),
                    model.map(Value::String).unwrap_or(Value::Null),
                );
                if let Some(sr) = msg.get("stopReason") {
                    at.insert("stop_reason".into(), sr.clone());
                }
                at.insert("overwrite".into(), Value::Bool(true));
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
                            "input": num("input"),
                            "output": num("output"),
                            "cache_create": num("cacheWrite"),
                            "cache_read": num("cacheRead"),
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
                    let bt = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if bt == "text" {
                        if let Some(t) = block.get("text").and_then(|t| t.as_str()).filter(|s| !s.is_empty())
                        {
                            let mut cb = nr_base("content_block", HARNESS, &ts);
                            cb.insert("block_type".into(), Value::String("text".into()));
                            cb.insert("text".into(), Value::String(t.into()));
                            out.push(Value::Object(cb));
                        }
                        continue;
                    }
                    if bt == "thinking" {
                        let mut cb = nr_base("content_block", HARNESS, &ts);
                        cb.insert("block_type".into(), Value::String("thinking".into()));
                        if let Some(t) = block.get("thinking").and_then(|t| t.as_str()) {
                            cb.insert("text".into(), Value::String(t.into()));
                        }
                        out.push(Value::Object(cb));
                        continue;
                    }
                    if bt != "toolCall" {
                        continue;
                    }
                    let name = block
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("unknown");
                    let args = block.get("arguments").cloned().unwrap_or(json!({}));
                    let category = if is_bash_tool(name) {
                        let cmd = args.get("command").and_then(|c| c.as_str());
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
                    let mut input = Map::new();
                    let path = args.get("path").cloned().unwrap_or(Value::Null);
                    input.insert("file_path".into(), path.clone());
                    input.insert("path".into(), path);
                    input.insert(
                        "command".into(),
                        args.get("command").cloned().unwrap_or(Value::Null),
                    );
                    tu.insert("input".into(), Value::Object(input));
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
