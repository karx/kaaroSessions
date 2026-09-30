//! Mission Control live store — port of `surface/active-state.mjs`.
//! Pure: caller supplies `now` (epoch ms); no wall-clock inside apply/snapshot.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;

pub const RECENT_ACTIONS_MAX: usize = 50;

#[derive(Debug, Clone)]
pub struct ActiveThresholds {
    pub active_ms: i64,
    pub evict_ms: i64,
    pub burn_window_ms: i64,
}

impl Default for ActiveThresholds {
    fn default() -> Self {
        Self {
            active_ms: 2 * 60_000,
            evict_ms: 60 * 60_000,
            burn_window_ms: 60_000,
        }
    }
}

pub const DEFAULT_THRESHOLDS: ActiveThresholds = ActiveThresholds {
    active_ms: 2 * 60_000,
    evict_ms: 60 * 60_000,
    burn_window_ms: 60_000,
};

#[derive(Debug, Clone, Default)]
pub struct TokenBucket {
    pub input: i64,
    pub output: i64,
    pub cache_create: i64,
    pub cache_read: i64,
}

#[derive(Debug, Clone)]
struct RecentWork {
    t: i64,
    work: i64,
}

#[derive(Debug, Clone)]
struct SessionEntry {
    session_id: String,
    slug: String,
    harness: String,
    project: Option<String>,
    first_seen: i64,
    last_seen: i64,
    last_event: Option<String>,
    last_tool: Option<Value>,
    tool_calls: i64,
    tool_errors: i64,
    tokens: TokenBucket,
    recent_work: Vec<RecentWork>,
    words: i64,
    last_preview: Option<String>,
    human_turns: i64,
    last_human_ts: Option<i64>,
    compacts: i64,
    recent_actions: Vec<Value>,
    last_permission_mode: Option<String>,
    last_mode: Option<String>,
    api_errors: i64,
    last_api_error: Option<Value>,
}

/// Live per-session activity store.
#[derive(Debug, Default, Clone)]
pub struct ActiveState {
    sessions: HashMap<String, SessionEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActiveTotals {
    pub sessions: usize,
    pub active: usize,
    pub idle: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActiveSnapshot {
    pub generated_at: i64,
    pub sessions: Vec<Value>,
    pub by_harness: Value,
    pub totals: ActiveTotals,
}

impl ActiveState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }
}

fn push_action(e: &mut SessionEntry, action: Value) {
    e.recent_actions.push(action);
    while e.recent_actions.len() > RECENT_ACTIONS_MAX {
        e.recent_actions.remove(0);
    }
}

fn prune_recent_work(e: &mut SessionEntry, now: i64, window_ms: i64) {
    let cutoff = now - window_ms;
    while e.recent_work.first().map(|r| r.t < cutoff).unwrap_or(false) {
        e.recent_work.remove(0);
    }
}

fn burn_rate(e: &SessionEntry, now: i64, window_ms: i64) -> i64 {
    let cutoff = now - window_ms;
    let work: i64 = e
        .recent_work
        .iter()
        .filter(|r| r.t >= cutoff)
        .map(|r| r.work)
        .sum();
    ((work as f64) * (60_000.0 / window_ms as f64)).round() as i64
}

fn i64_field(data: &Value, key: &str) -> i64 {
    data.get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .unwrap_or(0)
}

fn get_entry<'a>(state: &'a mut ActiveState, data: &Value, now: i64) -> &'a mut SessionEntry {
    let sid = data
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if !state.sessions.contains_key(&sid) {
        let slug = data
            .get("slug")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| sid.chars().take(8).collect());
        let harness = data
            .get("harness")
            .and_then(|v| v.as_str())
            .unwrap_or("claude-code")
            .to_string();
        let project = data
            .get("project")
            .and_then(|v| {
                if v.is_null() {
                    None
                } else {
                    v.as_str().map(|s| s.to_string())
                }
            });
        state.sessions.insert(
            sid.clone(),
            SessionEntry {
                session_id: sid.clone(),
                slug,
                harness,
                project,
                first_seen: now,
                last_seen: now,
                last_event: None,
                last_tool: None,
                tool_calls: 0,
                tool_errors: 0,
                tokens: TokenBucket::default(),
                recent_work: Vec::new(),
                words: 0,
                last_preview: None,
                human_turns: 0,
                last_human_ts: None,
                compacts: 0,
                recent_actions: Vec::new(),
                last_permission_mode: None,
                last_mode: None,
                api_errors: 0,
                last_api_error: None,
            },
        );
    }
    state.sessions.get_mut(&sid).expect("just inserted")
}

/// Feed one pulse `{ event, data }` into the store.
pub fn apply_pulse(state: &mut ActiveState, pulse: &Value, now: i64) {
    apply_pulse_with_thresholds(state, pulse, now, &DEFAULT_THRESHOLDS);
}

pub fn apply_pulse_with_thresholds(
    state: &mut ActiveState,
    pulse: &Value,
    now: i64,
    thresholds: &ActiveThresholds,
) {
    if !pulse.is_object() {
        return;
    }
    let event = match pulse.get("event").and_then(|v| v.as_str()) {
        Some(e) => e,
        None => return,
    };
    let data = match pulse.get("data") {
        Some(d) if d.is_object() => d,
        _ => return,
    };
    if data.get("session_id").and_then(|v| v.as_str()).is_none() {
        return;
    }

    let e = get_entry(state, data, now);
    e.last_seen = now;
    e.last_event = Some(event.to_string());
    if e.project.is_none() {
        if let Some(p) = data.get("project").and_then(|v| v.as_str()) {
            e.project = Some(p.to_string());
        }
    }

    match event {
        "tool_call" => {
            e.tool_calls += 1;
            let tool = data.get("tool").cloned().unwrap_or(Value::Null);
            let key = data.get("key").cloned().unwrap_or(Value::Null);
            let where_ = data.get("where").cloned().unwrap_or(Value::Null);
            let why = data.get("why").cloned().unwrap_or(Value::Null);
            e.last_tool = Some(json!({
                "tool": tool, "key": key, "where": where_, "why": why, "ts": now
            }));
            push_action(
                e,
                json!({
                    "type": "tool_call", "ts": now,
                    "tool": tool, "key": key, "where": where_, "why": why
                }),
            );
        }
        "tool_error" => {
            e.tool_errors += 1;
            push_action(
                e,
                json!({
                    "type": "tool_error", "ts": now,
                    "tool": data.get("tool").cloned().unwrap_or(Value::Null),
                    "error": true
                }),
            );
        }
        "tokens" => {
            e.tokens.input += i64_field(data, "input");
            e.tokens.output += i64_field(data, "output");
            e.tokens.cache_create += i64_field(data, "cache_create");
            e.tokens.cache_read += i64_field(data, "cache_read");
            let work = i64_field(data, "output") + i64_field(data, "cache_create");
            if work > 0 {
                e.recent_work.push(RecentWork { t: now, work });
            }
            prune_recent_work(e, now, thresholds.burn_window_ms);
        }
        "words" | "chirp" => {
            e.words += 1;
            if let Some(p) = data.get("preview").and_then(|v| v.as_str()) {
                e.last_preview = Some(p.to_string());
            }
        }
        "human_turn" => {
            e.human_turns += 1;
            e.last_human_ts = Some(now);
            push_action(
                e,
                json!({
                    "type": "human_turn", "ts": now,
                    "text": data.get("text").cloned().unwrap_or(Value::Null)
                }),
            );
        }
        "compact" => {
            e.compacts += 1;
            push_action(e, json!({"type": "compact", "ts": now}));
        }
        "permission" => {
            if let Some(m) = data.get("mode").and_then(|v| v.as_str()) {
                e.last_permission_mode = Some(m.to_string());
            }
            push_action(
                e,
                json!({
                    "type": "permission", "ts": now,
                    "mode": data.get("mode").cloned().unwrap_or(Value::Null)
                }),
            );
        }
        "mode_shift" => {
            if let Some(m) = data.get("mode").and_then(|v| v.as_str()) {
                e.last_mode = Some(m.to_string());
            }
            push_action(
                e,
                json!({
                    "type": "mode_shift", "ts": now,
                    "mode": data.get("mode").cloned().unwrap_or(Value::Null)
                }),
            );
        }
        "api_error" => {
            e.api_errors += 1;
            let msg = data.get("message").cloned().unwrap_or(Value::Null);
            let code = data.get("code").cloned().unwrap_or(Value::Null);
            e.last_api_error = Some(json!({"message": msg, "code": code, "ts": now}));
            push_action(
                e,
                json!({
                    "type": "api_error", "ts": now, "error": true,
                    "message": msg, "code": code
                }),
            );
        }
        _ => {}
    }
}

/// Point-in-time view; evicts stale entries as a side effect.
pub fn snapshot_active(state: &mut ActiveState, now: i64) -> ActiveSnapshot {
    snapshot_active_with(state, now, &DEFAULT_THRESHOLDS)
}

pub fn snapshot_active_with(
    state: &mut ActiveState,
    now: i64,
    thresholds: &ActiveThresholds,
) -> ActiveSnapshot {
    let mut to_delete = Vec::new();
    let mut sessions = Vec::new();
    let mut by_harness: serde_json::Map<String, Value> = serde_json::Map::new();
    let mut active = 0usize;
    let mut idle = 0usize;

    for (id, e) in state.sessions.iter() {
        let age = now - e.last_seen;
        if age > thresholds.evict_ms {
            to_delete.push(id.clone());
            continue;
        }
        let status = if age <= thresholds.active_ms {
            "active"
        } else {
            "idle"
        };
        if status == "active" {
            active += 1;
        } else {
            idle += 1;
        }
        let tokens_work = e.tokens.output + e.tokens.cache_create;
        sessions.push(json!({
            "session_id": e.session_id,
            "slug": e.slug,
            "harness": e.harness,
            "project": e.project,
            "status": status,
            "first_seen": e.first_seen,
            "last_seen": e.last_seen,
            "seconds_since": (age as f64 / 1000.0).round() as i64,
            "last_event": e.last_event,
            "last_tool": e.last_tool,
            "tool_calls": e.tool_calls,
            "tool_errors": e.tool_errors,
            "tokens": {
                "input": e.tokens.input,
                "output": e.tokens.output,
                "cache_create": e.tokens.cache_create,
                "cache_read": e.tokens.cache_read,
            },
            "tokens_work": tokens_work,
            "burn_rate_per_min": burn_rate(e, now, thresholds.burn_window_ms),
            "words": e.words,
            "last_preview": e.last_preview,
            "human_turns": e.human_turns,
            "last_human_ts": e.last_human_ts,
            "compacts": e.compacts,
            "recent_actions": e.recent_actions,
            "last_permission_mode": e.last_permission_mode,
            "last_mode": e.last_mode,
            "api_errors": e.api_errors,
            "last_api_error": e.last_api_error,
        }));

        let h = by_harness.entry(e.harness.clone()).or_insert_with(|| {
            json!({
                "sessions": 0, "active": 0, "tool_calls": 0, "tokens_work": 0
            })
        });
        if let Some(obj) = h.as_object_mut() {
            *obj.get_mut("sessions").unwrap() =
                json!(obj["sessions"].as_u64().unwrap_or(0) + 1);
            if status == "active" {
                *obj.get_mut("active").unwrap() =
                    json!(obj["active"].as_u64().unwrap_or(0) + 1);
            }
            *obj.get_mut("tool_calls").unwrap() =
                json!(obj["tool_calls"].as_i64().unwrap_or(0) + e.tool_calls);
            *obj.get_mut("tokens_work").unwrap() =
                json!(obj["tokens_work"].as_i64().unwrap_or(0) + tokens_work);
        }
    }

    for id in to_delete {
        state.sessions.remove(&id);
    }

    sessions.sort_by(|a, b| {
        let la = a.get("last_seen").and_then(|v| v.as_i64()).unwrap_or(0);
        let lb = b.get("last_seen").and_then(|v| v.as_i64()).unwrap_or(0);
        lb.cmp(&la)
    });

    let n = sessions.len();
    ActiveSnapshot {
        generated_at: now,
        sessions,
        by_harness: Value::Object(by_harness),
        totals: ActiveTotals {
            sessions: n,
            active,
            idle,
        },
    }
}

/// Empty snapshot helper for cold start (uses wall clock for generated_at only).
pub fn empty_active_snapshot() -> ActiveSnapshot {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    ActiveSnapshot {
        generated_at: now,
        sessions: Vec::new(),
        by_harness: json!({}),
        totals: ActiveTotals {
            sessions: 0,
            active: 0,
            idle: 0,
        },
    }
}
