//! Antigravity transcript → NormalizedRecord[] — port of `hooks/adapters/antigravity.mjs`.

use crate::helpers::{
    antigravity_rec_type_to_tool, categorize_bash, extract_antigravity_user_message,
    extract_model_change, parse_arg_value,
};
use crate::normalized_record::nr_base;
use serde_json::{json, Map, Value};

const HARNESS: &str = "antigravity";

fn ts_of(rec: &Value) -> Value {
    rec.get("created_at").cloned().unwrap_or(Value::Null)
}

/// Convert raw Antigravity JSONL records into NormalizedRecord objects (JSON).
pub fn records_to_normalized(records: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();

    for rec in records {
        let ts = ts_of(rec);
        let rec_type = rec.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let source = rec.get("source").and_then(|s| s.as_str()).unwrap_or("");
        let status = rec.get("status").and_then(|s| s.as_str()).unwrap_or("");
        let mut handled = false;

        if rec_type == "USER_INPUT" && source == "USER_EXPLICIT" {
            handled = true;
            let content = rec.get("content").and_then(|c| c.as_str()).unwrap_or("");
            let mut m = nr_base("user_turn", HARNESS, &ts);
            match extract_antigravity_user_message(content) {
                Some(text) => m.insert("text".into(), Value::String(text)),
                None => m.insert("text".into(), Value::Null),
            };
            out.push(Value::Object(m));
            if let Some(model) = extract_model_change(content) {
                let mut sm = nr_base("session_meta", HARNESS, &ts);
                sm.insert("model".into(), Value::String(model));
                sm.insert("overwrite".into(), Value::Bool(true));
                out.push(Value::Object(sm));
            }
        }

        if rec_type == "PLANNER_RESPONSE" && source == "MODEL" {
            handled = true;
            out.push(Value::Object(nr_base("assistant_turn", HARNESS, &ts)));
            if let Some(arr) = rec.get("tool_calls").and_then(|t| t.as_array()) {
                for tc in arr {
                    let name = tc
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let args = tc.get("args").cloned().unwrap_or(json!({}));
                    let command = parse_arg_value(args.get("CommandLine"));
                    let is_bash = matches!(
                        name.to_ascii_lowercase().as_str(),
                        "run_command" | "bash" | "shell"
                    );
                    let category = if is_bash {
                        Value::String(categorize_bash(command.as_deref()).into())
                    } else {
                        Value::Null
                    };
                    let mut input = Map::new();
                    input.insert(
                        "file_path".into(),
                        parse_arg_value(
                            args.get("AbsolutePath")
                                .or_else(|| args.get("TargetFile")),
                        )
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                    );
                    input.insert(
                        "command".into(),
                        command.map(Value::String).unwrap_or(Value::Null),
                    );
                    input.insert(
                        "Cwd".into(),
                        parse_arg_value(args.get("Cwd"))
                            .map(Value::String)
                            .unwrap_or(Value::Null),
                    );
                    input.insert(
                        "DirectoryPath".into(),
                        parse_arg_value(args.get("DirectoryPath"))
                            .map(Value::String)
                            .unwrap_or(Value::Null),
                    );
                    let mut m = nr_base("tool_use", HARNESS, &ts);
                    m.insert("tool".into(), Value::String(name));
                    m.insert("category".into(), category);
                    m.insert("input".into(), Value::Object(input));
                    out.push(Value::Object(m));
                }
            }
        }

        if rec_type == "EPHEMERAL_MESSAGE" || rec_type == "SYSTEM_MESSAGE" {
            handled = true;
            let preview: String = rec
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .chars()
                .take(80)
                .collect();
            let mut m = nr_base("scaffold", HARNESS, &ts);
            m.insert("content_preview".into(), Value::String(preview));
            out.push(Value::Object(m));
        }

        if rec_type == "ERROR_MESSAGE" {
            handled = true;
            let mut m = nr_base("tool_result", HARNESS, &ts);
            m.insert("error".into(), Value::Bool(true));
            m.insert("tool".into(), Value::String("unknown".into()));
            out.push(Value::Object(m));
        }

        if !handled
            && source == "MODEL"
            && rec_type != "PLANNER_RESPONSE"
            && status == "DONE"
            && antigravity_rec_type_to_tool(rec_type).is_some()
        {
            handled = true;
            let mut m = nr_base("tool_result", HARNESS, &ts);
            m.insert("error".into(), Value::Bool(false));
            m.insert(
                "tool".into(),
                Value::String(antigravity_rec_type_to_tool(rec_type).unwrap().into()),
            );
            out.push(Value::Object(m));
        }

        if !handled && source == "MODEL" && rec_type != "PLANNER_RESPONSE" && status == "ERROR" {
            handled = true;
            let tool = antigravity_rec_type_to_tool(rec_type).unwrap_or("unknown");
            let mut m = nr_base("tool_result", HARNESS, &ts);
            m.insert("error".into(), Value::Bool(true));
            m.insert("tool".into(), Value::String(tool.into()));
            out.push(Value::Object(m));
        }

        if !handled {
            let mut m = nr_base("unknown_record", HARNESS, &ts);
            m.insert("raw_type".into(), Value::String(rec_type.into()));
            out.push(Value::Object(m));
        }
    }

    out
}
