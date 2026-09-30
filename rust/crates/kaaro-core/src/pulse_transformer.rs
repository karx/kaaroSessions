//! NormalizedRecord[] → SSE pulses — port of `hooks/pulse-transformer.mjs`.

use crate::action_keys::tool_name_to_key;
use crate::pulse_map::pulse_disposition;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct Pulse {
    pub event: String,
    pub data: Value,
}

#[derive(Debug, Clone, Default)]
pub struct PulseCtx {
    pub session_id: String,
    pub slug: String,
    pub harness: String,
    pub project_label: Option<String>,
}

fn base(ctx: &PulseCtx, ts: Option<&Value>, nr: &Value) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("session_id".into(), json!(ctx.session_id));
    m.insert("slug".into(), json!(ctx.slug));
    m.insert("harness".into(), json!(ctx.harness));
    m.insert("project".into(), json!(ctx.project_label));
    m.insert("ts".into(), ts.cloned().unwrap_or(Value::Null));
    m.insert(
        "nr_kind".into(),
        nr.get("kind").cloned().unwrap_or(Value::Null),
    );
    m
}

fn transform_record(nr: &Value, ctx: &PulseCtx, tokens_cap: Option<bool>) -> Pulse {
    let ts = nr.get("ts");
    let disp = pulse_disposition(nr, tokens_cap);
    let mut env = base(ctx, ts, nr);

    if disp.event == "silent" {
        env.insert("reason".into(), json!(disp.reason));
        if let Some(bt) = nr.get("block_type") {
            env.insert("block_type".into(), bt.clone());
        }
        return Pulse {
            event: "silent".into(),
            data: Value::Object(env),
        };
    }
    if disp.event == "unknown" {
        if let Some(rt) = nr.get("raw_type") {
            env.insert("raw_type".into(), rt.clone());
        }
        if let Some(bt) = nr.get("block_type") {
            env.insert("block_type".into(), bt.clone());
        }
        return Pulse {
            event: "unknown".into(),
            data: Value::Object(env),
        };
    }

    match disp.event {
        "tool_call" => {
            let tool = nr.get("tool").and_then(|v| v.as_str());
            let category = nr.get("category").and_then(|v| v.as_str());
            let key = tool_name_to_key(tool, category);
            let where_ = nr
                .get("input")
                .and_then(|i| i.get("file_path").or_else(|| i.get("path")))
                .cloned()
                .unwrap_or(Value::Null);
            let why = nr
                .get("input")
                .and_then(|i| i.get("command").or_else(|| i.get("description")))
                .cloned()
                .unwrap_or(Value::Null);
            env.insert("tool".into(), json!(tool));
            env.insert("key".into(), json!(key));
            env.insert("where".into(), where_);
            env.insert("why".into(), why);
            env.insert("category".into(), json!(key));
            Pulse {
                event: "tool_call".into(),
                data: Value::Object(env),
            }
        }
        "tokens" => {
            if disp.synthetic {
                let content_length = nr
                    .get("content_length")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                env.insert("synthetic".into(), json!(true));
                env.insert("input".into(), json!(0));
                env.insert("output".into(), json!((content_length as f64 / 4.0).round() as i64));
                env.insert("cache_create".into(), json!(0));
                env.insert("cache_read".into(), json!(0));
            } else {
                let t = nr.get("tokens").cloned().unwrap_or(json!({}));
                env.insert(
                    "input".into(),
                    json!(t.get("input").and_then(|v| v.as_i64()).unwrap_or(0)),
                );
                env.insert(
                    "output".into(),
                    json!(t.get("output").and_then(|v| v.as_i64()).unwrap_or(0)),
                );
                env.insert(
                    "cache_create".into(),
                    json!(t.get("cache_create").and_then(|v| v.as_i64()).unwrap_or(0)),
                );
                env.insert(
                    "cache_read".into(),
                    json!(t.get("cache_read").and_then(|v| v.as_i64()).unwrap_or(0)),
                );
            }
            Pulse {
                event: "tokens".into(),
                data: Value::Object(env),
            }
        }
        "words" | "chirp" => {
            let text = nr.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let trimmed = text.trim();
            let words: Vec<_> = if trimmed.is_empty() {
                Vec::new()
            } else {
                trimmed.split_whitespace().collect()
            };
            let preview: String = trimmed.chars().take(120).collect();
            env.insert("preview".into(), json!(preview));
            env.insert("word_count".into(), json!(words.len()));
            Pulse {
                event: disp.event.into(),
                data: Value::Object(env),
            }
        }
        "thinking" => {
            env.insert("block_type".into(), json!("thinking"));
            Pulse {
                event: "thinking".into(),
                data: Value::Object(env),
            }
        }
        "human_turn" => {
            env.insert(
                "text".into(),
                nr.get("text").cloned().unwrap_or(Value::Null),
            );
            Pulse {
                event: "human_turn".into(),
                data: Value::Object(env),
            }
        }
        "compact" => Pulse {
            event: "compact".into(),
            data: Value::Object(env),
        },
        "permission" | "mode_shift" => {
            env.insert(
                "mode".into(),
                nr.get("mode").cloned().unwrap_or(Value::Null),
            );
            Pulse {
                event: disp.event.into(),
                data: Value::Object(env),
            }
        }
        "attachment" => {
            env.insert(
                "subtype".into(),
                nr.get("subtype").cloned().unwrap_or(Value::Null),
            );
            Pulse {
                event: "attachment".into(),
                data: Value::Object(env),
            }
        }
        "scaffold" => {
            env.insert(
                "content_preview".into(),
                nr.get("content_preview").cloned().unwrap_or(Value::Null),
            );
            Pulse {
                event: "scaffold".into(),
                data: Value::Object(env),
            }
        }
        "tool_result" | "tool_error" => {
            env.insert(
                "tool".into(),
                nr.get("tool").cloned().unwrap_or(Value::Null),
            );
            Pulse {
                event: disp.event.into(),
                data: Value::Object(env),
            }
        }
        "api_error" => {
            env.insert(
                "message".into(),
                nr.get("message").cloned().unwrap_or(Value::Null),
            );
            env.insert(
                "code".into(),
                nr.get("code").cloned().unwrap_or(Value::Null),
            );
            Pulse {
                event: "api_error".into(),
                data: Value::Object(env),
            }
        }
        _ => Pulse {
            event: "unknown".into(),
            data: Value::Object(env),
        },
    }
}

/// Transform NormalizedRecords into pulse objects.
pub fn norm_records_to_pulses(
    nr_records: &[Value],
    ctx: &PulseCtx,
    tokens_capability: Option<bool>,
) -> Vec<Pulse> {
    nr_records
        .iter()
        .map(|nr| transform_record(nr, ctx, tokens_capability))
        .collect()
}
