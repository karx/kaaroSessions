//! OpenCode storage records → NormalizedRecord[] — port of `hooks/adapters/opencode.mjs`.
//!
//! Assembled shape is `[info, ...messages]` with `_parts` on messages; bare parts
//! (live watch) are also accepted.

use crate::helpers::{categorize_bash, ms_to_iso};
use crate::normalized_record::nr_base;
use serde_json::{json, Map, Value};

const HARNESS: &str = "opencode";

fn to_iso(ms: Option<i64>) -> Value {
    match ms {
        Some(ms) => Value::String(ms_to_iso(ms)),
        None => Value::Null,
    }
}

fn as_i64(v: Option<&Value>) -> Option<i64> {
    v.and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64)))
}

fn is_session_info(rec: &Value) -> bool {
    let Some(id) = rec.get("id").and_then(|i| i.as_str()) else {
        return false;
    };
    id.starts_with("ses_")
        && rec.get("role").is_none()
        && rec.get("type").is_none()
}

fn first_text(parts: &[Value]) -> Value {
    for p in parts {
        if p.get("type").and_then(|t| t.as_str()) == Some("text") {
            if let Some(t) = p.get("text").and_then(|t| t.as_str()).filter(|s| !s.is_empty()) {
                return Value::String(t.to_string());
            }
        }
    }
    Value::Null
}

fn part_to_normalized(p: &Value) -> Vec<Value> {
    let ptype = p.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match ptype {
        "text" => {
            let mut m = nr_base(
                "content_block",
                HARNESS,
                &to_iso(as_i64(p.pointer("/time/start"))),
            );
            m.insert("block_type".into(), Value::String("text".into()));
            m.insert(
                "text".into(),
                p.get("text")
                    .cloned()
                    .unwrap_or_else(|| Value::String(String::new())),
            );
            vec![Value::Object(m)]
        }
        "reasoning" => {
            let mut m = nr_base(
                "content_block",
                HARNESS,
                &to_iso(as_i64(p.pointer("/time/start"))),
            );
            m.insert("block_type".into(), Value::String("thinking".into()));
            m.insert(
                "text".into(),
                p.get("text")
                    .cloned()
                    .unwrap_or_else(|| Value::String(String::new())),
            );
            vec![Value::Object(m)]
        }
        "tool" => {
            let status = p.pointer("/state/status").and_then(|s| s.as_str());
            if status != Some("completed") && status != Some("error") {
                return vec![];
            }
            let empty = Map::new();
            let input = p
                .pointer("/state/input")
                .and_then(|i| i.as_object())
                .unwrap_or(&empty);
            let tool = p
                .get("tool")
                .and_then(|t| t.as_str())
                .unwrap_or("unknown");
            let is_bash = tool == "bash";
            let ts = to_iso(as_i64(p.pointer("/state/time/start")));
            let category = if is_bash {
                let cmd = input.get("command").and_then(|c| c.as_str());
                Value::String(categorize_bash(cmd).into())
            } else {
                Value::Null
            };
            let file_path = input
                .get("filePath")
                .or_else(|| input.get("path"))
                .cloned()
                .unwrap_or(Value::Null);
            let mut tu = nr_base("tool_use", HARNESS, &ts);
            tu.insert("tool".into(), Value::String(tool.into()));
            tu.insert("category".into(), category);
            let mut in_obj = Map::new();
            in_obj.insert("file_path".into(), file_path);
            in_obj.insert(
                "command".into(),
                input.get("command").cloned().unwrap_or(Value::Null),
            );
            in_obj.insert(
                "description".into(),
                p.pointer("/state/title")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            tu.insert("input".into(), Value::Object(in_obj));
            let mut out = vec![Value::Object(tu)];
            if status == Some("error") {
                let end_ts = to_iso(as_i64(p.pointer("/state/time/end")));
                let err_ts = if end_ts.is_null() { ts } else { end_ts };
                let mut tr = nr_base("tool_result", HARNESS, &err_ts);
                tr.insert("error".into(), Value::Bool(true));
                tr.insert("tool".into(), Value::String(tool.into()));
                out.push(Value::Object(tr));
            }
            out
        }
        "step-start" | "step-finish" | "patch" => vec![],
        _ => {
            let mut m = nr_base("unknown_record", HARNESS, &Value::Null);
            m.insert(
                "raw_type".into(),
                Value::String(format!("part:{ptype}")),
            );
            vec![Value::Object(m)]
        }
    }
}

/// Convert assembled OpenCode records (or bare parts) into NormalizedRecords.
pub fn records_to_normalized(records: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();

    for rec in records {
        if !rec.is_object() {
            continue;
        }

        if is_session_info(rec) {
            let mut m = nr_base(
                "session_meta",
                HARNESS,
                &to_iso(as_i64(rec.pointer("/time/created"))),
            );
            m.insert(
                "ai_title".into(),
                rec.get("title").cloned().unwrap_or(Value::Null),
            );
            m.insert(
                "cwd".into(),
                rec.get("directory").cloned().unwrap_or(Value::Null),
            );
            out.push(Value::Object(m));
            continue;
        }

        if rec.get("role").and_then(|r| r.as_str()) == Some("user") {
            let parts = rec
                .get("_parts")
                .and_then(|p| p.as_array())
                .cloned()
                .unwrap_or_default();
            let mut m = nr_base(
                "user_turn",
                HARNESS,
                &to_iso(as_i64(rec.pointer("/time/created"))),
            );
            m.insert("text".into(), first_text(&parts));
            m.insert(
                "cwd".into(),
                rec.pointer("/path/cwd")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            out.push(Value::Object(m));
            continue;
        }

        if rec.get("role").and_then(|r| r.as_str()) == Some("assistant") {
            let mut at = nr_base(
                "assistant_turn",
                HARNESS,
                &to_iso(as_i64(rec.pointer("/time/created"))),
            );
            at.insert(
                "model".into(),
                rec.get("modelID").cloned().unwrap_or(Value::Null),
            );
            at.insert(
                "stop_reason".into(),
                rec.get("finish").cloned().unwrap_or(Value::Null),
            );
            out.push(Value::Object(at));

            if let Some(tokens) = rec.get("tokens") {
                if !tokens.is_null() {
                    let num = |v: Option<&Value>| -> i64 {
                        v.and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64)))
                            .unwrap_or(0)
                    };
                    let ts = to_iso(
                        as_i64(rec.pointer("/time/completed"))
                            .or_else(|| as_i64(rec.pointer("/time/created"))),
                    );
                    let mut tm = nr_base("tokens", HARNESS, &ts);
                    tm.insert(
                        "tokens".into(),
                        json!({
                            "input": num(tokens.get("input")),
                            "output": num(tokens.get("output")),
                            "cache_create": num(tokens.pointer("/cache/write")),
                            "cache_read": num(tokens.pointer("/cache/read")),
                        }),
                    );
                    out.push(Value::Object(tm));
                }
            }

            if let Some(parts) = rec.get("_parts").and_then(|p| p.as_array()) {
                for p in parts {
                    out.extend(part_to_normalized(p));
                }
            }
            continue;
        }

        if rec.get("type").is_some() {
            out.extend(part_to_normalized(rec));
            continue;
        }

        let mut m = nr_base("unknown_record", HARNESS, &Value::Null);
        m.insert(
            "raw_type".into(),
            Value::String("opencode_unknown".into()),
        );
        out.push(Value::Object(m));
    }

    out
}
