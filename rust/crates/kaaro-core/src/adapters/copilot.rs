//! GitHub Copilot chatSessions op-log → NormalizedRecord[] — port of `hooks/adapters/copilot.mjs`.

use crate::helpers::{copilot_tool_name, copilot_uri_to_path, invocation_file_path, ms_to_iso};
use crate::normalized_record::nr_base;
use serde_json::{json, Value};
use std::collections::HashSet;

const HARNESS: &str = "copilot";

fn to_iso_val(ms: Option<i64>) -> Value {
    match ms {
        Some(ms) => Value::String(ms_to_iso(ms)),
        None => Value::Null,
    }
}

fn keypath(op: &Value) -> String {
    let k = match op.get("k") {
        Some(Value::Array(arr)) => arr.clone(),
        Some(Value::String(s)) => vec![Value::String(s.clone())],
        _ => vec![],
    };
    k.iter()
        .map(|x| {
            if x.is_number() {
                "#".to_string()
            } else {
                x.as_str().unwrap_or("").to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(".")
}

fn plain_text(md: Option<&str>) -> String {
    let s = md.unwrap_or("");
    let mut out = String::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            if let Some(close) = s[i + 1..].find(']') {
                let label = &s[i + 1..i + 1 + close];
                let after = i + 1 + close + 1;
                if after < bytes.len() && bytes[after] == b'(' {
                    if let Some(paren) = s[after + 1..].find(')') {
                        out.push_str(label);
                        i = after + 1 + paren + 1;
                        continue;
                    }
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out.trim().to_string()
}

fn response_item_to_normalized(item: &Value) -> Vec<Value> {
    if !item.is_object() {
        return vec![];
    }
    let kind = item.get("kind").and_then(|k| k.as_str());
    let ts = Value::Null;

    if kind == Some("toolInvocationSerialized") {
        let mut m = nr_base("tool_use", HARNESS, &ts);
        m.insert(
            "tool".into(),
            Value::String(copilot_tool_name(item.get("toolId").and_then(|t| t.as_str()))),
        );
        m.insert("category".into(), Value::Null);
        let desc = plain_text(
            item.pointer("/invocationMessage/value")
                .and_then(|v| v.as_str()),
        );
        m.insert(
            "input".into(),
            json!({
                "file_path": invocation_file_path(item),
                "command": item.pointer("/toolSpecificData/command").cloned().unwrap_or(Value::Null),
                "description": if desc.is_empty() { Value::Null } else { Value::String(desc) },
            }),
        );
        return vec![Value::Object(m)];
    }

    if kind == Some("textEditGroup") {
        let mut m = nr_base("tool_use", HARNESS, &ts);
        m.insert("tool".into(), Value::String("editFile".into()));
        m.insert("category".into(), Value::Null);
        let fp = item
            .get("uri")
            .and_then(copilot_uri_to_path)
            .map(Value::String)
            .unwrap_or(Value::Null);
        m.insert("input".into(), json!({ "file_path": fp }));
        return vec![Value::Object(m)];
    }

    if kind == Some("thinking") {
        let mut m = nr_base("content_block", HARNESS, &ts);
        m.insert("block_type".into(), Value::String("thinking".into()));
        let text = item
            .get("value")
            .map(|v| match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .unwrap_or_default();
        m.insert("text".into(), Value::String(text));
        return vec![Value::Object(m)];
    }

    if kind == Some("markdownContent") {
        let text = item
            .pointer("/content/value")
            .or_else(|| item.get("value"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let mut m = nr_base("content_block", HARNESS, &ts);
        m.insert("block_type".into(), Value::String("text".into()));
        m.insert("text".into(), Value::String(text.into()));
        return vec![Value::Object(m)];
    }

    if kind.is_none() {
        if let Some(Value::String(s)) = item.get("value") {
            let mut m = nr_base("content_block", HARNESS, &ts);
            m.insert("block_type".into(), Value::String("text".into()));
            m.insert("text".into(), Value::String(s.clone()));
            return vec![Value::Object(m)];
        }
    }

    if kind == Some("inlineReference") {
        return vec![];
    }

    let mut m = nr_base("unknown_record", HARNESS, &ts);
    m.insert(
        "raw_type".into(),
        Value::String(format!("response:{}", kind.unwrap_or("null"))),
    );
    vec![Value::Object(m)]
}

fn emit_response_items(
    items: &[Value],
    req_idx: &str,
    out: &mut Vec<Value>,
    assistant_emitted: &mut HashSet<String>,
) {
    if !items.is_empty() && !assistant_emitted.contains(req_idx) {
        assistant_emitted.insert(req_idx.to_string());
        out.push(Value::Object(nr_base("assistant_turn", HARNESS, &Value::Null)));
    }
    for item in items {
        out.extend(response_item_to_normalized(item));
    }
}

fn emit_request(
    req: &Value,
    req_idx: &str,
    out: &mut Vec<Value>,
    assistant_emitted: &mut HashSet<String>,
) {
    let ts = to_iso_val(req.get("timestamp").and_then(|t| t.as_i64()));
    let mut m = nr_base("user_turn", HARNESS, &ts);
    m.insert(
        "text".into(),
        req.pointer("/message/text")
            .cloned()
            .unwrap_or(Value::Null),
    );
    out.push(Value::Object(m));
    if let Some(model) = req.get("modelId").and_then(|m| m.as_str()) {
        let mut sm = nr_base("session_meta", HARNESS, &ts);
        sm.insert("model".into(), Value::String(model.into()));
        sm.insert("overwrite".into(), Value::Bool(true));
        out.push(Value::Object(sm));
    }
    if let Some(resp) = req.get("response").and_then(|r| r.as_array()) {
        if !resp.is_empty() {
            emit_response_items(resp, req_idx, out, assistant_emitted);
        }
    }
    if let Some(n) = req
        .get("completionTokens")
        .and_then(|v| v.as_i64().or_else(|| v.as_u64().map(|u| u as i64)))
    {
        let mut t = nr_base("tokens", HARNESS, &ts);
        t.insert(
            "tokens".into(),
            json!({ "input": 0, "output": n, "cache_create": 0, "cache_read": 0 }),
        );
        out.push(Value::Object(t));
    }
}

fn emit_snapshot(
    v: &Value,
    out: &mut Vec<Value>,
    assistant_emitted: &mut HashSet<String>,
    request_count: &mut usize,
) {
    let ts = to_iso_val(v.get("creationDate").and_then(|t| t.as_i64()));
    let mut m = nr_base("session_meta", HARNESS, &ts);
    m.insert(
        "ai_title".into(),
        v.get("customTitle").cloned().unwrap_or(Value::Null),
    );
    out.push(Value::Object(m));
    if let Some(reqs) = v.get("requests").and_then(|r| r.as_array()) {
        for (i, req) in reqs.iter().enumerate() {
            emit_request(req, &i.to_string(), out, assistant_emitted);
        }
        *request_count = reqs.len();
    } else {
        *request_count = 0;
    }
}

/// Convert Copilot op-log / dump records into NormalizedRecord objects (JSON).
pub fn records_to_normalized(records: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut assistant_emitted: HashSet<String> = HashSet::new();
    let mut request_count: usize = 0;

    for rec in records {
        if !rec.is_object() {
            continue;
        }

        if rec.get("kind").and_then(|k| k.as_u64()) == Some(0) {
            if let Some(v) = rec.get("v") {
                emit_snapshot(v, &mut out, &mut assistant_emitted, &mut request_count);
            }
            continue;
        }
        if rec.get("kind").is_none() && rec.get("requests").and_then(|r| r.as_array()).is_some() {
            emit_snapshot(rec, &mut out, &mut assistant_emitted, &mut request_count);
            continue;
        }

        let kp = keypath(rec);
        let kind_num = rec.get("kind").and_then(|k| k.as_i64());

        if kind_num == Some(2) {
            if kp == "requests" {
                if let Some(arr) = rec.get("v").and_then(|v| v.as_array()) {
                    for req in arr {
                        emit_request(
                            req,
                            &request_count.to_string(),
                            &mut out,
                            &mut assistant_emitted,
                        );
                        request_count += 1;
                    }
                }
                continue;
            }
            if kp == "requests.#.response" {
                let idx = rec
                    .get("k")
                    .and_then(|k| k.as_array())
                    .and_then(|a| a.get(1))
                    .map(|v| match v {
                        Value::Number(n) => n.to_string(),
                        Value::String(s) => s.clone(),
                        _ => "0".into(),
                    })
                    .unwrap_or_else(|| "0".into());
                let items = rec
                    .get("v")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                emit_response_items(&items, &idx, &mut out, &mut assistant_emitted);
                continue;
            }
            continue;
        }

        if kind_num == Some(1) {
            if kp == "requests.#.completionTokens" {
                if let Some(n) = rec
                    .get("v")
                    .and_then(|v| v.as_i64().or_else(|| v.as_u64().map(|u| u as i64)))
                {
                    let mut m = nr_base("tokens", HARNESS, &Value::Null);
                    m.insert(
                        "tokens".into(),
                        json!({ "input": 0, "output": n, "cache_create": 0, "cache_read": 0 }),
                    );
                    out.push(Value::Object(m));
                }
            } else if kp == "customTitle" {
                if let Some(v) = rec.get("v").filter(|v| !v.is_null()) {
                    let mut m = nr_base("session_meta", HARNESS, &Value::Null);
                    m.insert(
                        "ai_title".into(),
                        Value::String(v.as_str().unwrap_or(&v.to_string()).into()),
                    );
                    out.push(Value::Object(m));
                }
            }
            continue;
        }

        let mut m = nr_base("unknown_record", HARNESS, &Value::Null);
        m.insert(
            "raw_type".into(),
            Value::String(format!(
                "op:kind{}",
                kind_num
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| "null".into())
            )),
        );
        out.push(Value::Object(m));
    }

    out
}
