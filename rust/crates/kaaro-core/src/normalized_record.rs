//! THE NormalizedRecord contract — port of `hooks/normalized-record.mjs`.
//!
//! Records are the harness hop: adapters emit them; reducer / pulse / trace consume them.
//! They are internal — never persisted in sessions-data.json.

use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::LazyLock;

/// Number of kinds in KIND_FIELDS (JS parity).
pub const KIND_COUNT: usize = 16;

/// Result of [`validate_normalized_record`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationResult {
    pub ok: bool,
    pub errors: Vec<String>,
}

#[derive(Clone, Copy)]
enum FieldType {
    String,
    Number,
    Boolean,
    Object,
    Tokens,
}

struct KindSpec {
    required: &'static [(&'static str, FieldType)],
    optional: &'static [(&'static str, FieldType)],
}

static KIND_FIELDS: LazyLock<HashMap<&'static str, KindSpec>> = LazyLock::new(|| {
    let mut m = HashMap::new();
    m.insert(
        "user_turn",
        KindSpec {
            required: &[],
            optional: &[
                ("text", FieldType::String),
                ("display_text", FieldType::String),
                ("version", FieldType::String),
                ("entrypoint", FieldType::String),
                ("cwd", FieldType::String),
                ("branch", FieldType::String),
            ],
        },
    );
    m.insert(
        "assistant_turn",
        KindSpec {
            required: &[],
            optional: &[
                ("model", FieldType::String),
                ("stop_reason", FieldType::String),
                ("content_length", FieldType::Number),
                ("text", FieldType::String),
            ],
        },
    );
    m.insert(
        "tool_use",
        KindSpec {
            required: &[("tool", FieldType::String)],
            optional: &[
                ("category", FieldType::String),
                ("input", FieldType::Object),
                ("tool_id", FieldType::String),
            ],
        },
    );
    m.insert(
        "tool_result",
        KindSpec {
            required: &[],
            optional: &[
                ("tool", FieldType::String),
                ("error", FieldType::Boolean),
                ("tool_id", FieldType::String),
                ("error_text", FieldType::String),
            ],
        },
    );
    m.insert(
        "tokens",
        KindSpec {
            required: &[("tokens", FieldType::Tokens)],
            optional: &[],
        },
    );
    m.insert(
        "skill_invoke",
        KindSpec {
            required: &[("skill", FieldType::String)],
            optional: &[],
        },
    );
    m.insert(
        "context_reset",
        KindSpec {
            required: &[],
            optional: &[],
        },
    );
    m.insert(
        "session_meta",
        KindSpec {
            required: &[],
            optional: &[
                ("ai_title", FieldType::String),
                ("last_prompt", FieldType::String),
                ("slug", FieldType::String),
                ("duration_ms", FieldType::Number),
                ("message_count", FieldType::Number),
                ("version", FieldType::String),
                ("entrypoint", FieldType::String),
                ("cwd", FieldType::String),
                ("branch", FieldType::String),
                ("model", FieldType::String),
                ("title", FieldType::String),
                ("project_label", FieldType::String),
            ],
        },
    );
    m.insert(
        "permission_mode",
        KindSpec {
            required: &[],
            optional: &[("mode", FieldType::String)],
        },
    );
    m.insert(
        "branch_change",
        KindSpec {
            required: &[("branch", FieldType::String)],
            optional: &[],
        },
    );
    m.insert(
        "content_block",
        KindSpec {
            required: &[("block_type", FieldType::String)],
            optional: &[("text", FieldType::String), ("chunk", FieldType::Boolean)],
        },
    );
    m.insert(
        "mode_shift",
        KindSpec {
            required: &[],
            optional: &[("mode", FieldType::String)],
        },
    );
    m.insert(
        "attachment",
        KindSpec {
            required: &[],
            optional: &[("subtype", FieldType::String)],
        },
    );
    m.insert(
        "scaffold",
        KindSpec {
            required: &[],
            optional: &[("content_preview", FieldType::String)],
        },
    );
    m.insert(
        "api_error",
        KindSpec {
            required: &[("message", FieldType::String)],
            optional: &[("code", FieldType::String)],
        },
    );
    m.insert(
        "unknown_record",
        KindSpec {
            required: &[],
            optional: &[("raw_type", FieldType::String)],
        },
    );
    m
});

/// Ordered list of record kinds (matches JS `Object.keys(KIND_FIELDS)` insertion order).
pub fn record_kinds() -> Vec<&'static str> {
    vec![
        "user_turn",
        "assistant_turn",
        "tool_use",
        "tool_result",
        "tokens",
        "skill_invoke",
        "context_reset",
        "session_meta",
        "permission_mode",
        "branch_change",
        "content_block",
        "mode_shift",
        "attachment",
        "scaffold",
        "api_error",
        "unknown_record",
    ]
}

fn type_error(field: &str, expected: &str, val: &Value) -> String {
    let got = match val {
        Value::Null => "null".to_string(),
        Value::Bool(_) => "boolean".to_string(),
        Value::Number(_) => "number".to_string(),
        Value::String(_) => "string".to_string(),
        Value::Array(_) => "object".to_string(), // JS typeof array === 'object'
        Value::Object(_) => "object".to_string(),
    };
    format!("{field}: expected {expected}, got {got}")
}

fn check_type(field: &str, ty: FieldType, val: &Value, errors: &mut Vec<String>) {
    match ty {
        FieldType::Tokens => {
            let Some(obj) = val.as_object() else {
                errors.push(type_error(field, "object", val));
                return;
            };
            for k in ["input", "output", "cache_create", "cache_read"] {
                match obj.get(k) {
                    Some(v) if v.is_number() => {}
                    Some(v) => errors.push(type_error(&format!("{field}.{k}"), "number", v)),
                    None => errors.push(type_error(
                        &format!("{field}.{k}"),
                        "number",
                        &Value::Null,
                    )),
                }
            }
        }
        FieldType::String => {
            if !val.is_string() {
                errors.push(type_error(field, "string", val));
            }
        }
        FieldType::Number => {
            if !val.is_number() {
                errors.push(type_error(field, "number", val));
            }
        }
        FieldType::Boolean => {
            if !val.is_boolean() {
                errors.push(type_error(field, "boolean", val));
            }
        }
        FieldType::Object => {
            // JS typeof null === 'object' but we treat null as absent upstream.
            // Arrays are typeof 'object' in JS — accept object or array.
            if !val.is_object() && !val.is_array() {
                errors.push(type_error(field, "object", val));
            }
        }
    }
}

/// Validate a single NormalizedRecord against the contract (JS parity).
pub fn validate_normalized_record(rec: &Value) -> ValidationResult {
    let mut errors = Vec::new();
    let Some(obj) = rec.as_object() else {
        return ValidationResult {
            ok: false,
            errors: vec!["record: not an object".into()],
        };
    };

    let kind = obj.get("kind").and_then(|k| k.as_str());
    match kind {
        Some(k) if KIND_FIELDS.contains_key(k) => {}
        Some(k) => errors.push(format!("kind: unknown '{k}'")),
        None => errors.push(format!(
            "kind: unknown '{}'",
            obj.get("kind")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "null".into())
        )),
    }

    match obj.get("harness") {
        Some(Value::String(_)) => {}
        _ => errors.push("harness: expected string".into()),
    }

    if let Some(ts) = obj.get("ts") {
        if !ts.is_null() && !ts.is_string() && !ts.is_number() {
            errors.push(type_error("ts", "string|number|null", ts));
        }
    }

    if let Some(k) = kind {
        if let Some(spec) = KIND_FIELDS.get(k) {
            for &(field, ty) in spec.required {
                match obj.get(field) {
                    None | Some(Value::Null) => errors.push(format!("{field}: required")),
                    Some(val) => check_type(field, ty, val, &mut errors),
                }
            }
            for &(field, ty) in spec.optional {
                match obj.get(field) {
                    None | Some(Value::Null) => {}
                    Some(val) => check_type(field, ty, val, &mut errors),
                }
            }
        }
    }

    ValidationResult {
        ok: errors.is_empty(),
        errors,
    }
}

/// Cheap shape check (kind + harness only).
pub fn is_normalized_record(rec: &Value) -> bool {
    let Some(obj) = rec.as_object() else {
        return false;
    };
    let Some(kind) = obj.get("kind").and_then(|k| k.as_str()) else {
        return false;
    };
    KIND_FIELDS.contains_key(kind)
        && matches!(obj.get("harness"), Some(Value::String(_)))
}

/// Helper to build an NR object (adapters).
pub(crate) fn nr_base(kind: &str, harness: &str, ts: &Value) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("kind".into(), Value::String(kind.into()));
    m.insert("harness".into(), Value::String(harness.into()));
    m.insert("ts".into(), ts.clone());
    m
}

#[cfg(test)]
mod unit_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn kinds_len() {
        assert_eq!(record_kinds().len(), KIND_COUNT);
    }

    #[test]
    fn not_object() {
        let r = validate_normalized_record(&json!(42));
        assert!(!r.ok);
    }
}
