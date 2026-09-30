//! NR kind → pulse disposition — port of `hooks/pulse-map.mjs`.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PulseDisposition {
    pub event: &'static str,
    pub reason: Option<&'static str>,
    pub synthetic: bool,
}

fn kind_pulse(kind: &str) -> Option<PulseDisposition> {
    Some(match kind {
        "user_turn" => PulseDisposition {
            event: "human_turn",
            reason: None,
            synthetic: false,
        },
        "assistant_turn" => PulseDisposition {
            event: "silent",
            reason: Some("envelope"),
            synthetic: false,
        },
        "tool_use" => PulseDisposition {
            event: "tool_call",
            reason: None,
            synthetic: false,
        },
        "tool_result" => PulseDisposition {
            event: "tool_result",
            reason: None,
            synthetic: false,
        },
        "tokens" => PulseDisposition {
            event: "tokens",
            reason: None,
            synthetic: false,
        },
        "skill_invoke" => PulseDisposition {
            event: "silent",
            reason: Some("snapshot"),
            synthetic: false,
        },
        "context_reset" => PulseDisposition {
            event: "compact",
            reason: None,
            synthetic: false,
        },
        "session_meta" => PulseDisposition {
            event: "silent",
            reason: Some("snapshot"),
            synthetic: false,
        },
        "permission_mode" => PulseDisposition {
            event: "permission",
            reason: None,
            synthetic: false,
        },
        "branch_change" => PulseDisposition {
            event: "silent",
            reason: Some("snapshot"),
            synthetic: false,
        },
        "content_block" => PulseDisposition {
            event: "route",
            reason: None,
            synthetic: false,
        },
        "mode_shift" => PulseDisposition {
            event: "mode_shift",
            reason: None,
            synthetic: false,
        },
        "attachment" => PulseDisposition {
            event: "attachment",
            reason: None,
            synthetic: false,
        },
        "scaffold" => PulseDisposition {
            event: "scaffold",
            reason: None,
            synthetic: false,
        },
        "api_error" => PulseDisposition {
            event: "api_error",
            reason: None,
            synthetic: false,
        },
        "unknown_record" => PulseDisposition {
            event: "unknown",
            reason: None,
            synthetic: false,
        },
        _ => return None,
    })
}

/// Resolve pulse event for one NormalizedRecord (+ optional capabilities.tokens).
pub fn pulse_disposition(nr: &Value, tokens_capability: Option<bool>) -> PulseDisposition {
    let Some(kind) = nr.get("kind").and_then(|v| v.as_str()) else {
        return PulseDisposition {
            event: "unknown",
            reason: None,
            synthetic: false,
        };
    };

    if kind == "assistant_turn" && tokens_capability == Some(false) {
        return PulseDisposition {
            event: "tokens",
            reason: None,
            synthetic: true,
        };
    }

    if kind == "content_block" {
        let block = nr.get("block_type").and_then(|v| v.as_str());
        match block {
            Some("thinking") => {
                return PulseDisposition {
                    event: "thinking",
                    reason: None,
                    synthetic: false,
                }
            }
            Some("tool_use") => {
                return PulseDisposition {
                    event: "silent",
                    reason: Some("duplicate"),
                    synthetic: false,
                }
            }
            Some("text") => {
                if let Some(text) = nr.get("text").and_then(|v| v.as_str()) {
                    let trimmed = text.trim();
                    let words: Vec<_> = if trimmed.is_empty() {
                        Vec::new()
                    } else {
                        trimmed.split_whitespace().collect()
                    };
                    return PulseDisposition {
                        event: if words.len() >= 3 { "words" } else { "chirp" },
                        reason: None,
                        synthetic: false,
                    };
                }
                return PulseDisposition {
                    event: "unknown",
                    reason: None,
                    synthetic: false,
                };
            }
            _ => {
                return PulseDisposition {
                    event: "unknown",
                    reason: None,
                    synthetic: false,
                }
            }
        }
    }

    if kind == "tool_result" && nr.get("error").and_then(|v| v.as_bool()).unwrap_or(false) {
        return PulseDisposition {
            event: "tool_error",
            reason: None,
            synthetic: false,
        };
    }

    match kind_pulse(kind) {
        Some(spec) if spec.event != "route" => spec,
        _ => PulseDisposition {
            event: "unknown",
            reason: None,
            synthetic: false,
        },
    }
}

/// Catalog of routed children for kinds whose KIND_PULSE.event is not the Stream event.
#[derive(Debug, Clone, Copy)]
pub struct KindRouteSpec {
    pub id: &'static str,
    pub pulse: &'static str,
    pub reason: Option<&'static str>,
    pub role: &'static str,
}

/// KIND_ROUTES table — port of `hooks/pulse-map.mjs`.
pub fn kind_routes(kind: &str) -> &'static [KindRouteSpec] {
    match kind {
        "content_block" => &[
            KindRouteSpec {
                id: "thinking",
                pulse: "thinking",
                reason: None,
                role: "emit",
            },
            KindRouteSpec {
                id: "words",
                pulse: "words",
                reason: None,
                role: "emit",
            },
            KindRouteSpec {
                id: "chirp",
                pulse: "chirp",
                reason: None,
                role: "emit",
            },
            KindRouteSpec {
                id: "duplicate",
                pulse: "silent",
                reason: Some("duplicate"),
                role: "emit",
            },
            KindRouteSpec {
                id: "unknown-block",
                pulse: "unknown",
                reason: None,
                role: "alarm",
            },
        ],
        "tool_result" => &[
            KindRouteSpec {
                id: "ok",
                pulse: "tool_result",
                reason: None,
                role: "emit",
            },
            KindRouteSpec {
                id: "error",
                pulse: "tool_error",
                reason: None,
                role: "emit",
            },
        ],
        _ => &[],
    }
}

/// KIND_PULSE table as (kind, event, reason) for kind-map payload builders.
pub fn kind_pulse_entry(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
    match kind {
        "user_turn" => Some(("human_turn", None)),
        "assistant_turn" => Some(("silent", Some("envelope"))),
        "tool_use" => Some(("tool_call", None)),
        "tool_result" => Some(("tool_result", None)),
        "tokens" => Some(("tokens", None)),
        "skill_invoke" => Some(("silent", Some("snapshot"))),
        "context_reset" => Some(("compact", None)),
        "session_meta" => Some(("silent", Some("snapshot"))),
        "permission_mode" => Some(("permission", None)),
        "branch_change" => Some(("silent", Some("snapshot"))),
        "content_block" => Some(("route", None)),
        "mode_shift" => Some(("mode_shift", None)),
        "attachment" => Some(("attachment", None)),
        "scaffold" => Some(("scaffold", None)),
        "api_error" => Some(("api_error", None)),
        "unknown_record" => Some(("unknown", None)),
        _ => None,
    }
}

/// Route id for one NR, or None if the kind has no KIND_ROUTES row.
pub fn route_id_from_nr(nr: &Value, tokens_capability: Option<bool>) -> Option<&'static str> {
    let kind = nr.get("kind").and_then(|v| v.as_str())?;
    if kind == "content_block" {
        let d = pulse_disposition(nr, tokens_capability);
        return Some(match (d.event, d.reason) {
            ("thinking", _) => "thinking",
            ("words", _) => "words",
            ("chirp", _) => "chirp",
            ("silent", Some("duplicate")) => "duplicate",
            _ => "unknown-block",
        });
    }
    if kind == "tool_result" {
        return Some(if nr.get("error").and_then(|v| v.as_bool()).unwrap_or(false) {
            "error"
        } else {
            "ok"
        });
    }
    None
}

/// Route id from a Stream pulse envelope.
pub fn route_id_from_pulse(event: &str, data: &Value) -> Option<&'static str> {
    let nr_kind = data.get("nr_kind").and_then(|v| v.as_str()).unwrap_or("");
    if nr_kind == "content_block" {
        let block = data.get("block_type").and_then(|v| v.as_str()).unwrap_or("");
        let reason = data.get("reason").and_then(|v| v.as_str()).unwrap_or("");
        if event == "thinking" || block == "thinking" {
            return Some("thinking");
        }
        if event == "words" {
            return Some("words");
        }
        if event == "chirp" {
            return Some("chirp");
        }
        if block == "tool_use" || reason == "duplicate" {
            return Some("duplicate");
        }
        if event == "unknown" {
            return Some("unknown-block");
        }
        return None;
    }
    if nr_kind == "tool_result" {
        if event == "tool_error" {
            return Some("error");
        }
        if event == "tool_result" {
            return Some("ok");
        }
    }
    None
}
