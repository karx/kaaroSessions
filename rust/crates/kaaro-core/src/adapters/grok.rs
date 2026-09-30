//! Grok updates.jsonl ACP → NormalizedRecord[] — port of `hooks/adapters/grok.mjs`.

use crate::helpers::{
    categorize_bash, grok_record_ts, grok_session_update, is_bash_tool_name, is_grok_tool_failure,
};
use crate::normalized_record::nr_base;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

const HARNESS: &str = "grok";

fn assistant_chunks() -> HashSet<&'static str> {
    HashSet::from(["agent_message_chunk", "agent_thought_chunk"])
}

fn compact_events() -> HashSet<&'static str> {
    HashSet::from(["auto_compact_completed", "compaction_checkpoint"])
}

/// Convert raw Grok updates.jsonl records into NormalizedRecord objects (JSON).
pub fn records_to_normalized(records: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut tool_titles: HashMap<String, String> = HashMap::new();
    let mut current_turn_key: Option<String> = None;
    let asst = assistant_chunks();
    let compact = compact_events();

    for rec in records {
        let Some(su) = grok_session_update(rec) else {
            continue;
        };
        let ts = grok_record_ts(rec)
            .map(Value::String)
            .unwrap_or(Value::Null);
        let upd = rec
            .pointer("/params/update")
            .cloned()
            .unwrap_or(json!({}));
        let mut handled = false;

        if su == "user_message_chunk" {
            handled = true;
            let text = upd
                .pointer("/content/text")
                .and_then(|t| t.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let mut m = nr_base("user_turn", HARNESS, &ts);
            match &text {
                Some(t) if t.len() >= 8 => {
                    m.insert(
                        "text".into(),
                        Value::String(t.chars().take(200).collect()),
                    );
                }
                _ => {
                    m.insert("text".into(), Value::Null);
                }
            }
            m.insert(
                "display_text".into(),
                text.as_ref()
                    .map(|t| Value::String(t.chars().take(500).collect()))
                    .unwrap_or(Value::Null),
            );
            out.push(Value::Object(m));
            if let Some(model) = upd.pointer("/_meta/modelId").and_then(|m| m.as_str()) {
                let mut sm = nr_base("session_meta", HARNESS, &ts);
                sm.insert("model".into(), Value::String(model.into()));
                sm.insert("overwrite".into(), Value::Bool(true));
                out.push(Value::Object(sm));
            }
            current_turn_key = None;
        }

        if asst.contains(su.as_str()) {
            handled = true;
            ensure_assistant_turn(rec, &ts, &mut current_turn_key, &mut out);
            if su == "agent_message_chunk" {
                if let Some(text) = upd.pointer("/content/text").and_then(|t| t.as_str()) {
                    let mut cb = nr_base("content_block", HARNESS, &ts);
                    cb.insert("block_type".into(), Value::String("text".into()));
                    cb.insert("text".into(), Value::String(text.into()));
                    cb.insert("chunk".into(), Value::Bool(true));
                    out.push(Value::Object(cb));
                }
            }
            if su == "agent_thought_chunk" {
                let mut cb = nr_base("content_block", HARNESS, &ts);
                cb.insert("block_type".into(), Value::String("thinking".into()));
                out.push(Value::Object(cb));
            }
        }

        if su == "tool_call" {
            handled = true;
            let title = upd
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("unknown")
                .to_string();
            let raw = upd.get("rawInput").cloned().unwrap_or(json!({}));
            let is_bash = is_bash_tool_name(&title);
            let cmd = raw.get("command").and_then(|c| c.as_str());
            let category = if is_bash {
                Value::String(categorize_bash(cmd).into())
            } else {
                Value::Null
            };
            if let Some(tid) = upd.get("toolCallId").and_then(|t| t.as_str()) {
                tool_titles.insert(tid.into(), title.clone());
            }
            ensure_assistant_turn(rec, &ts, &mut current_turn_key, &mut out);
            let mut input: Map<String, Value> = match raw.as_object() {
                Some(o) => o.clone(),
                None => Map::new(),
            };
            let fp = input
                .get("path")
                .or_else(|| input.get("file_path"))
                .cloned()
                .unwrap_or(Value::Null);
            input.insert("file_path".into(), fp);
            let mut m = nr_base("tool_use", HARNESS, &ts);
            m.insert("tool".into(), Value::String(title));
            m.insert("category".into(), category);
            if let Some(tid) = upd.get("toolCallId").and_then(|t| t.as_str()) {
                m.insert("tool_id".into(), Value::String(tid.into()));
            }
            m.insert("input".into(), Value::Object(input));
            out.push(Value::Object(m));
        }

        if su == "tool_call_update" {
            handled = true;
            if is_grok_tool_failure(&upd) {
                let tid = upd.get("toolCallId").and_then(|t| t.as_str());
                let title = tid
                    .and_then(|id| tool_titles.get(id))
                    .cloned()
                    .or_else(|| {
                        upd.get("title")
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_else(|| "unknown".into());
                let stderr = upd
                    .pointer("/rawOutput/stderr")
                    .or_else(|| upd.pointer("/rawOutput/stdout"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                let mut m = nr_base("tool_result", HARNESS, &ts);
                m.insert("error".into(), Value::Bool(true));
                m.insert("tool".into(), Value::String(title));
                if let Some(id) = tid {
                    m.insert("tool_id".into(), Value::String(id.into()));
                }
                let et: String = stderr.trim().chars().take(300).collect();
                m.insert(
                    "error_text".into(),
                    Value::String(if et.is_empty() {
                        "non-zero exit".into()
                    } else {
                        et
                    }),
                );
                out.push(Value::Object(m));
            }
        }

        if compact.contains(su.as_str()) {
            handled = true;
            out.push(Value::Object(nr_base("context_reset", HARNESS, &ts)));
            current_turn_key = None;
        }

        if !handled {
            let mut m = nr_base("unknown_record", HARNESS, &ts);
            m.insert("raw_type".into(), Value::String(su));
            out.push(Value::Object(m));
        }
    }

    out
}

fn ensure_assistant_turn(
    rec: &Value,
    ts: &Value,
    current_turn_key: &mut Option<String>,
    out: &mut Vec<Value>,
) {
    let key = rec
        .pointer("/_meta/turnStartMs")
        .map(|v| match v {
            Value::Number(n) => n.to_string(),
            Value::String(s) => s.clone(),
            _ => "__none__".into(),
        })
        .unwrap_or_else(|| "__none__".into());
    if current_turn_key.as_ref() == Some(&key) {
        return;
    }
    *current_turn_key = Some(key);
    out.push(Value::Object(nr_base("assistant_turn", HARNESS, ts)));
}
