//! Unified ContextTree reconstruction from NormalizedRecords —
//! port of `hooks/trace-tree.mjs`.

use serde_json::{json, Map, Value};
use std::collections::HashMap;

const TURN_TEXT_CAP: usize = 500;

fn sanitize_input(name: &str, input: Option<&Value>) -> Value {
    let Some(input) = input.and_then(|v| v.as_object()) else {
        return json!({});
    };
    let n = name.to_lowercase();
    if matches!(
        n.as_str(),
        "bash" | "powershell" | "shell" | "run_command"
    ) {
        let cmd = input
            .get("command")
            .or_else(|| input.get("cmd"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        return json!({ "command": cmd.chars().take(300).collect::<String>() });
    }
    if matches!(n.as_str(), "read" | "view_file" | "read_file") {
        let fp = input
            .get("file_path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .replace('\\', "/");
        return json!({ "file_path": fp });
    }
    if matches!(n.as_str(), "write" | "write_to_file") {
        let fp = input
            .get("file_path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .replace('\\', "/");
        return json!({ "file_path": fp });
    }
    if matches!(
        n.as_str(),
        "edit"
            | "multiedit"
            | "strreplace"
            | "editnotebook"
            | "replace_file_content"
            | "search_replace"
    ) {
        let mut r = Map::new();
        r.insert(
            "file_path".into(),
            json!(input
                .get("file_path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .replace('\\', "/")),
        );
        if let Some(s) = input.get("old_string").and_then(|v| v.as_str()) {
            r.insert(
                "old_string".into(),
                json!(s.chars().take(160).collect::<String>()),
            );
        }
        if let Some(s) = input.get("new_string").and_then(|v| v.as_str()) {
            r.insert(
                "new_string".into(),
                json!(s.chars().take(160).collect::<String>()),
            );
        }
        return Value::Object(r);
    }
    if matches!(n.as_str(), "grep" | "grep_search") {
        return json!({
            "pattern": input.get("pattern").cloned().unwrap_or(json!("")),
            "path": input.get("path").or_else(|| input.get("glob")).cloned().unwrap_or(json!("")),
        });
    }
    if n == "glob" {
        return json!({
            "pattern": input.get("pattern").or_else(|| input.get("glob_pattern")).cloned().unwrap_or(json!("")),
        });
    }
    if matches!(n.as_str(), "agent" | "task") {
        let desc = input
            .get("description")
            .or_else(|| input.get("prompt"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        return json!({ "description": desc.chars().take(400).collect::<String>() });
    }
    if matches!(n.as_str(), "websearch" | "toolsearch") {
        return json!({ "query": input.get("query").cloned().unwrap_or(json!("")) });
    }
    if n == "webfetch" {
        return json!({ "url": input.get("url").cloned().unwrap_or(json!("")) });
    }
    let mut safe = Map::new();
    for (k, v) in input {
        match v {
            Value::String(s) => {
                let t = if s.len() > 300 {
                    format!("{}…", &s[..300])
                } else {
                    s.clone()
                };
                safe.insert(k.clone(), json!(t));
            }
            Value::Object(_) | Value::Array(_) => {}
            other => {
                safe.insert(k.clone(), other.clone());
            }
        }
    }
    Value::Object(safe)
}

fn cap_turn_text(s: Option<&str>) -> Option<String> {
    let s = s?;
    let t: String = s.chars().take(TURN_TEXT_CAP).collect();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

fn new_segment(index: usize) -> Value {
    json!({
        "index": index,
        "ts_start": null,
        "ts_end": null,
        "user_turns": 0,
        "assistant_turns": 0,
        "tool_calls": 0,
        "subagent_count": 0,
        "thinking_count": 0,
        "permission_modes": [],
        "branches": [],
        "tool_summary": {},
        "tokens": { "output": 0, "cache_read": 0 },
        "compact_trigger": null,
        "turns": [],
    })
}

fn add_branch(seg: &mut Value, branch: Option<&str>) {
    let Some(branch) = branch.filter(|b| !b.is_empty()) else {
        return;
    };
    let arr = seg
        .get_mut("branches")
        .and_then(|v| v.as_array_mut())
        .unwrap();
    if !arr.iter().any(|b| b.as_str() == Some(branch)) {
        arr.push(json!(branch));
    }
}

fn assemble_text(parts: &[(String, bool)]) -> Option<String> {
    let mut buf = String::new();
    for (text, chunk) in parts {
        if text.is_empty() {
            continue;
        }
        if *chunk || buf.is_empty() {
            buf.push_str(text);
        } else {
            buf.push('\n');
            buf.push_str(text);
        }
    }
    cap_turn_text(Some(buf.trim()))
}

/// Lookup key for nested child trees.
pub fn child_tree_key(spawn: &Value) -> Option<String> {
    if let Some(id) = spawn.get("tool_use_id").and_then(|v| v.as_str()) {
        return Some(id.to_string());
    }
    if let Some(id) = spawn.get("agent_id").and_then(|v| v.as_str()) {
        return Some(format!("agent:{id}"));
    }
    None
}

fn lookup_child_tree<'a>(spawn: &Value, child_trees: Option<&'a Map<String, Value>>) -> Option<&'a Value> {
    let trees = child_trees?;
    if let Some(id) = spawn.get("tool_use_id").and_then(|v| v.as_str()) {
        if let Some(v) = trees.get(id) {
            return Some(v);
        }
    }
    if let Some(id) = spawn.get("agent_id").and_then(|v| v.as_str()) {
        let k = format!("agent:{id}");
        if let Some(v) = trees.get(&k) {
            return Some(v);
        }
    }
    None
}

fn clone_spawn(spawn: &Value, child_trees: Option<&Map<String, Value>>) -> Value {
    let mut ref_obj = Map::new();
    if let Some(obj) = spawn.as_object() {
        for (k, v) in obj {
            if k == "jsonl_path" || k == "meta_path" {
                continue;
            }
            ref_obj.insert(k.clone(), v.clone());
        }
    }
    if let Some(nested) = lookup_child_tree(spawn, child_trees) {
        ref_obj.insert("tree".into(), nested.clone());
    }
    Value::Object(ref_obj)
}

fn materialize_spawns(spawns: &[Value], child_trees: Option<&Map<String, Value>>) -> Vec<Value> {
    spawns.iter().map(|s| clone_spawn(s, child_trees)).collect()
}

fn index_spawns(spawns: Option<&[Value]>) -> HashMap<String, Value> {
    let mut map = HashMap::new();
    let Some(spawns) = spawns else {
        return map;
    };
    for s in spawns {
        if let Some(id) = s.get("tool_use_id").and_then(|v| v.as_str()) {
            map.insert(id.to_string(), s.clone());
        }
    }
    map
}

#[derive(Debug, Clone, Default)]
pub struct TraceReconOpts {
    pub ai_title: Option<String>,
    pub git_branch: Option<String>,
    pub spawns: Option<Vec<Value>>,
    pub child_trees: Option<Map<String, Value>>,
}

/// Reconstruct ContextTree from chronological NormalizedRecords.
pub fn reconstruct_trace_from_nrs(nrs: &[Value], opts: &TraceReconOpts) -> Value {
    if nrs.is_empty() {
        let mut empty = json!({
            "ai_title": opts.ai_title,
            "segments": [],
        });
        if let Some(spawns) = &opts.spawns {
            empty.as_object_mut().unwrap().insert(
                "subagents".into(),
                json!(materialize_spawns(spawns, opts.child_trees.as_ref())),
            );
        }
        return empty;
    }

    let mut ai_title = opts.ai_title.clone();
    let mut segments: Vec<Value> = Vec::new();
    let mut seg = new_segment(0);
    let mut has_content = false;
    let mut pending: Option<Pending> = None;
    let mut tool_by_id: HashMap<String, usize> = HashMap::new(); // tool_id -> index in pending.tool_calls
    // After flush, tool_calls live on turns — keep a side map of tool objects by id for results.
    let mut tool_objs: HashMap<String, Value> = HashMap::new();
    let spawn_by_tool_id = index_spawns(opts.spawns.as_deref());

    struct Pending {
        ts: Value,
        parts: Vec<(String, bool)>,
        tool_calls: Vec<Value>,
        has_thinking: bool,
        usage: Option<Value>,
        duration_ms: Option<Value>,
        stop_reason: Option<Value>,
    }

    let flush_pending = |pending: &mut Option<Pending>,
                         seg: &mut Value,
                         spawn_by: &HashMap<String, Value>,
                         child_trees: Option<&Map<String, Value>>,
                         tool_objs: &mut HashMap<String, Value>| {
        let Some(p) = pending.take() else {
            return;
        };
        // Sync tool_objs from pending before building turn
        for tc in &p.tool_calls {
            if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                tool_objs.insert(id.to_string(), tc.clone());
            }
        }
        let mut tool_calls = p.tool_calls;
        // Prefer latest from tool_objs (may have error flags from tool_result)
        for tc in &mut tool_calls {
            if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                if let Some(updated) = tool_objs.get(id) {
                    *tc = updated.clone();
                }
            }
        }
        let mut turn = json!({
            "role": "assistant",
            "ts": p.ts,
            "text": assemble_text(&p.parts),
            "tool_calls": tool_calls,
            "has_thinking": p.has_thinking,
            "usage": p.usage,
            "duration_ms": p.duration_ms,
            "stop_reason": p.stop_reason,
        });
        if !spawn_by.is_empty() {
            let mut spawned = Vec::new();
            for tc in turn["tool_calls"].as_array().unwrap_or(&vec![]) {
                let name = tc.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if name != "Agent" && name != "Task" {
                    continue;
                }
                let Some(id) = tc.get("id").and_then(|v| v.as_str()) else {
                    continue;
                };
                if let Some(spawn) = spawn_by.get(id) {
                    spawned.push(clone_spawn(spawn, child_trees));
                }
            }
            if !spawned.is_empty() {
                turn.as_object_mut()
                    .unwrap()
                    .insert("spawned_subagents".into(), json!(spawned));
            }
        }
        seg.get_mut("turns")
            .and_then(|v| v.as_array_mut())
            .unwrap()
            .push(turn);
    };

    let ensure_pending = |pending: &mut Option<Pending>, ts: Value| {
        if pending.is_none() {
            *pending = Some(Pending {
                ts,
                parts: vec![],
                tool_calls: vec![],
                has_thinking: false,
                usage: None,
                duration_ms: None,
                stop_reason: None,
            });
        }
    };

    for nr in nrs {
        if let Some(ts) = nr.get("ts") {
            if !ts.is_null() {
                if seg.get("ts_start").map(|v| v.is_null()).unwrap_or(true) {
                    seg.as_object_mut()
                        .unwrap()
                        .insert("ts_start".into(), ts.clone());
                }
                seg.as_object_mut()
                    .unwrap()
                    .insert("ts_end".into(), ts.clone());
            }
        }

        let kind = nr.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "session_meta" => {
                if ai_title.is_none() {
                    if let Some(t) = nr.get("ai_title").and_then(|v| v.as_str()) {
                        ai_title = Some(t.to_string());
                    }
                }
                if let Some(p) = pending.as_mut() {
                    if let Some(d) = nr.get("duration_ms") {
                        if !d.is_null() {
                            p.duration_ms = Some(d.clone());
                        }
                    }
                }
            }
            "permission_mode" => {
                if let Some(mode) = nr.get("mode").and_then(|v| v.as_str()) {
                    let arr = seg
                        .get_mut("permission_modes")
                        .and_then(|v| v.as_array_mut())
                        .unwrap();
                    if !arr.iter().any(|m| m.as_str() == Some(mode)) {
                        arr.push(json!(mode));
                    }
                }
            }
            "branch_change" => {
                add_branch(&mut seg, nr.get("branch").and_then(|v| v.as_str()));
            }
            "user_turn" => {
                flush_pending(
                    &mut pending,
                    &mut seg,
                    &spawn_by_tool_id,
                    opts.child_trees.as_ref(),
                    &mut tool_objs,
                );
                let ut = seg.get("user_turns").and_then(|v| v.as_u64()).unwrap_or(0) + 1;
                seg.as_object_mut().unwrap().insert("user_turns".into(), json!(ut));
                has_content = true;
                add_branch(&mut seg, nr.get("branch").and_then(|v| v.as_str()));
                let text = cap_turn_text(
                    nr.get("display_text")
                        .or_else(|| nr.get("text"))
                        .and_then(|v| v.as_str()),
                );
                if let Some(text) = text {
                    seg.get_mut("turns")
                        .and_then(|v| v.as_array_mut())
                        .unwrap()
                        .push(json!({
                            "role": "user",
                            "ts": nr.get("ts").cloned().unwrap_or(Value::Null),
                            "text": text,
                            "tool_calls": [],
                            "has_thinking": false,
                            "usage": null,
                            "duration_ms": null,
                            "stop_reason": null,
                        }));
                }
            }
            "assistant_turn" => {
                flush_pending(
                    &mut pending,
                    &mut seg,
                    &spawn_by_tool_id,
                    opts.child_trees.as_ref(),
                    &mut tool_objs,
                );
                let at = seg
                    .get("assistant_turns")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0)
                    + 1;
                seg.as_object_mut()
                    .unwrap()
                    .insert("assistant_turns".into(), json!(at));
                has_content = true;
                ensure_pending(
                    &mut pending,
                    nr.get("ts").cloned().unwrap_or(Value::Null),
                );
                if let Some(p) = pending.as_mut() {
                    p.stop_reason = nr.get("stop_reason").cloned();
                }
            }
            "tokens" => {
                let t = nr.get("tokens").cloned().unwrap_or(json!({}));
                let out_add = t.get("output").and_then(|v| v.as_i64()).unwrap_or(0);
                let cache_add = t.get("cache_read").and_then(|v| v.as_i64()).unwrap_or(0);
                {
                    let tokens = seg.get_mut("tokens").and_then(|v| v.as_object_mut()).unwrap();
                    let cur_out = tokens.get("output").and_then(|v| v.as_i64()).unwrap_or(0);
                    let cur_c = tokens.get("cache_read").and_then(|v| v.as_i64()).unwrap_or(0);
                    tokens.insert("output".into(), json!(cur_out + out_add));
                    tokens.insert("cache_read".into(), json!(cur_c + cache_add));
                }
                if let Some(p) = pending.as_mut() {
                    p.usage = Some(json!({ "output": out_add, "cache_read": cache_add }));
                }
            }
            "content_block" => {
                let block = nr.get("block_type").and_then(|v| v.as_str()).unwrap_or("");
                if block == "thinking" {
                    ensure_pending(
                        &mut pending,
                        nr.get("ts").cloned().unwrap_or(Value::Null),
                    );
                    if let Some(p) = pending.as_mut() {
                        p.has_thinking = true;
                    }
                    let tc = seg
                        .get("thinking_count")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0)
                        + 1;
                    seg.as_object_mut()
                        .unwrap()
                        .insert("thinking_count".into(), json!(tc));
                    has_content = true;
                } else if block == "text" {
                    if let Some(text) = nr.get("text").and_then(|v| v.as_str()) {
                        ensure_pending(
                            &mut pending,
                            nr.get("ts").cloned().unwrap_or(Value::Null),
                        );
                        if let Some(p) = pending.as_mut() {
                            p.parts.push((
                                text.to_string(),
                                nr.get("chunk").and_then(|v| v.as_bool()).unwrap_or(false),
                            ));
                        }
                        has_content = true;
                    }
                }
            }
            "tool_use" => {
                ensure_pending(
                    &mut pending,
                    nr.get("ts").cloned().unwrap_or(Value::Null),
                );
                let name = nr
                    .get("tool")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                {
                    let summary = seg
                        .get_mut("tool_summary")
                        .and_then(|v| v.as_object_mut())
                        .unwrap();
                    let cur = summary.get(name).and_then(|v| v.as_u64()).unwrap_or(0);
                    summary.insert(name.to_string(), json!(cur + 1));
                }
                let tc_n = seg.get("tool_calls").and_then(|v| v.as_u64()).unwrap_or(0) + 1;
                seg.as_object_mut()
                    .unwrap()
                    .insert("tool_calls".into(), json!(tc_n));
                if name == "Agent" || name == "Task" {
                    let sc = seg
                        .get("subagent_count")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0)
                        + 1;
                    seg.as_object_mut()
                        .unwrap()
                        .insert("subagent_count".into(), json!(sc));
                }
                has_content = true;
                let tc = json!({
                    "id": nr.get("tool_id").cloned().unwrap_or(Value::Null),
                    "name": name,
                    "input": sanitize_input(name, nr.get("input")),
                    "is_error": null,
                    "error_text": null,
                });
                if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                    tool_objs.insert(id.to_string(), tc.clone());
                    if let Some(p) = pending.as_mut() {
                        tool_by_id.insert(id.to_string(), p.tool_calls.len());
                        p.tool_calls.push(tc);
                    }
                } else if let Some(p) = pending.as_mut() {
                    p.tool_calls.push(tc);
                }
            }
            "tool_result" => {
                if let Some(id) = nr.get("tool_id").and_then(|v| v.as_str()) {
                    let is_error = nr.get("error").and_then(|v| v.as_bool()).unwrap_or(false);
                    let err_text = if is_error {
                        nr.get("error_text").cloned().unwrap_or(Value::Null)
                    } else {
                        Value::Null
                    };
                    // Update pending if still open
                    if let Some(p) = pending.as_mut() {
                        if let Some(&idx) = tool_by_id.get(id) {
                            if let Some(tc) = p.tool_calls.get_mut(idx) {
                                if let Some(obj) = tc.as_object_mut() {
                                    obj.insert("is_error".into(), json!(is_error));
                                    if is_error {
                                        obj.insert("error_text".into(), err_text.clone());
                                    }
                                }
                            }
                        }
                    }
                    // Update tool_objs (survives flush)
                    if let Some(tc) = tool_objs.get_mut(id) {
                        if let Some(obj) = tc.as_object_mut() {
                            obj.insert("is_error".into(), json!(is_error));
                            if is_error {
                                obj.insert("error_text".into(), err_text);
                            }
                        }
                    }
                    // Also patch already-flushed turns
                    if let Some(turns) = seg.get_mut("turns").and_then(|v| v.as_array_mut()) {
                        for turn in turns {
                            if let Some(tcs) = turn.get_mut("tool_calls").and_then(|v| v.as_array_mut())
                            {
                                for tc in tcs {
                                    if tc.get("id").and_then(|v| v.as_str()) == Some(id) {
                                        if let Some(obj) = tc.as_object_mut() {
                                            obj.insert("is_error".into(), json!(is_error));
                                            if is_error {
                                                obj.insert(
                                                    "error_text".into(),
                                                    nr.get("error_text")
                                                        .cloned()
                                                        .unwrap_or(Value::Null),
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "context_reset" => {
                flush_pending(
                    &mut pending,
                    &mut seg,
                    &spawn_by_tool_id,
                    opts.child_trees.as_ref(),
                    &mut tool_objs,
                );
                if let Some(b) = &opts.git_branch {
                    add_branch(&mut seg, Some(b));
                }
                seg.as_object_mut()
                    .unwrap()
                    .insert("compact_trigger".into(), json!("auto"));
                segments.push(seg);
                seg = new_segment(segments.len());
                has_content = false;
                tool_by_id.clear();
                // tool_objs persist across segments? JS creates new Map per segment.
                tool_objs.clear();
            }
            _ => {}
        }
    }

    flush_pending(
        &mut pending,
        &mut seg,
        &spawn_by_tool_id,
        opts.child_trees.as_ref(),
        &mut tool_objs,
    );
    if has_content {
        if let Some(b) = &opts.git_branch {
            add_branch(&mut seg, Some(b));
        }
        seg.as_object_mut()
            .unwrap()
            .insert("compact_trigger".into(), Value::Null);
        segments.push(seg);
    }

    let mut out = json!({
        "ai_title": ai_title,
        "segments": segments,
    });
    if let Some(spawns) = &opts.spawns {
        out.as_object_mut().unwrap().insert(
            "subagents".into(),
            json!(materialize_spawns(spawns, opts.child_trees.as_ref())),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::claude_code;
    use serde_json::json;

    fn user() -> Value {
        json!({
            "type": "user",
            "timestamp": "2026-05-01T10:00:00Z",
            "message": { "content": "hello world prompt" }
        })
    }
    fn asst() -> Value {
        json!({
            "type": "assistant",
            "timestamp": "2026-05-01T10:01:00Z",
            "message": {
                "model": "claude-sonnet-4-6",
                "stop_reason": "end_turn",
                "usage": { "input_tokens": 0, "output_tokens": 100, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0 },
                "content": []
            }
        })
    }
    fn compact() -> Value {
        json!({
            "type": "system",
            "subtype": "compact_boundary",
            "timestamp": "2026-05-01T11:00:00Z"
        })
    }

    #[test]
    fn basic_single_segment() {
        let nrs = claude_code::records_to_normalized(&[user(), asst()]);
        let tree = reconstruct_trace_from_nrs(&nrs, &TraceReconOpts::default());
        assert_eq!(tree["segments"].as_array().unwrap().len(), 1);
        assert_eq!(tree["segments"][0]["user_turns"], 1);
        assert_eq!(tree["segments"][0]["assistant_turns"], 1);
    }

    #[test]
    fn compact_splits_segments() {
        let nrs = claude_code::records_to_normalized(&[
            user(),
            asst(),
            compact(),
            user(),
            asst(),
        ]);
        let tree = reconstruct_trace_from_nrs(&nrs, &TraceReconOpts::default());
        assert_eq!(tree["segments"].as_array().unwrap().len(), 2);
        assert_eq!(tree["segments"][0]["compact_trigger"], "auto");
        assert!(tree["segments"][1]["compact_trigger"].is_null());
    }

    #[test]
    fn tool_summary_and_sanitize() {
        let records = vec![json!({
            "type": "assistant",
            "timestamp": "2026-05-01T10:01:00Z",
            "message": {
                "stop_reason": "tool_use",
                "usage": { "output_tokens": 10, "cache_read_input_tokens": 0, "input_tokens": 0, "cache_creation_input_tokens": 0 },
                "content": [
                    { "type": "tool_use", "id": "tu1", "name": "Read", "input": { "file_path": "src/foo.js" } },
                    { "type": "tool_use", "id": "tu2", "name": "Bash", "input": { "command": "git status" } },
                    { "type": "tool_use", "id": "tu3", "name": "Agent", "input": { "description": "explore" } },
                ]
            }
        })];
        let nrs = claude_code::records_to_normalized(&records);
        let tree = reconstruct_trace_from_nrs(&nrs, &TraceReconOpts::default());
        let seg = &tree["segments"][0];
        assert_eq!(seg["tool_calls"], 3);
        assert_eq!(seg["subagent_count"], 1);
        assert_eq!(seg["tool_summary"]["Read"], 1);
        let turns = seg["turns"].as_array().unwrap();
        let tcs = turns[0]["tool_calls"].as_array().unwrap();
        assert_eq!(tcs[0]["input"]["file_path"], "src/foo.js");
        assert_eq!(tcs[1]["input"]["command"], "git status");
    }

    #[test]
    fn empty_nrs() {
        let tree = reconstruct_trace_from_nrs(&[], &TraceReconOpts {
            ai_title: Some("t".into()),
            ..Default::default()
        });
        assert_eq!(tree["ai_title"], "t");
        assert!(tree["segments"].as_array().unwrap().is_empty());
    }

    fn nrs_with_agent(tool_id: &str, desc: &str) -> Vec<Value> {
        vec![
            json!({
                "kind": "user_turn", "harness": "claude-code", "ts": "t0",
                "text": "plan layout", "display_text": "plan layout"
            }),
            json!({
                "kind": "assistant_turn", "harness": "claude-code", "ts": "t1",
                "model": "m", "stop_reason": "tool_use"
            }),
            json!({
                "kind": "tokens", "harness": "claude-code", "ts": "t1",
                "tokens": { "output": 10, "cache_read": 0, "input": 1, "cache_create": 0 }
            }),
            json!({
                "kind": "tool_use", "harness": "claude-code", "ts": "t1",
                "tool": "Agent", "tool_id": tool_id, "category": null,
                "input": { "description": desc, "subagent_type": "Explore" }
            }),
        ]
    }

    #[test]
    fn without_spawns_opts_no_tree_subagents() {
        let tree = reconstruct_trace_from_nrs(&nrs_with_agent("toolu_01A", "Explore template.html"), &TraceReconOpts::default());
        assert_eq!(tree["segments"][0]["subagent_count"], 1);
        assert!(tree.get("subagents").is_none());
        let asst = tree["segments"][0]["turns"].as_array().unwrap().iter().find(|t| t["role"] == "assistant").unwrap();
        assert!(asst.get("spawned_subagents").is_none());
    }

    #[test]
    fn with_spawns_fills_subagents_and_strips_jsonl_path() {
        let spawns = vec![json!({
            "agent_id": "aaa111",
            "tool_use_id": "toolu_01A",
            "description": "Explore template.html",
            "agent_type": "Explore",
            "spawn_depth": 1,
            "jsonl_path": "/tmp/agent-aaa111.jsonl",
            "linked": true
        })];
        let tree = reconstruct_trace_from_nrs(
            &nrs_with_agent("toolu_01A", "Explore template.html"),
            &TraceReconOpts { spawns: Some(spawns), ..Default::default() },
        );
        assert_eq!(tree["subagents"].as_array().unwrap().len(), 1);
        assert_eq!(tree["subagents"][0]["agent_id"], "aaa111");
        assert!(tree["subagents"][0].get("jsonl_path").is_none());
        let asst = tree["segments"][0]["turns"].as_array().unwrap().iter().find(|t| t["role"] == "assistant").unwrap();
        assert_eq!(asst["spawned_subagents"][0]["agent_id"], "aaa111");
        assert!(asst["spawned_subagents"][0].get("jsonl_path").is_none());
    }

    #[test]
    fn child_trees_attach_nested_tree() {
        let child_tree = json!({
            "ai_title": null,
            "segments": [{ "index": 0, "tool_summary": { "Grep": 2 }, "tool_calls": 2, "subagent_count": 0, "turns": [] }]
        });
        let spawns = vec![json!({
            "agent_id": "aaa111", "tool_use_id": "toolu_01A",
            "description": "Explore template.html", "agent_type": "Explore",
            "spawn_depth": 1, "jsonl_path": "/tmp/x.jsonl", "linked": true
        })];
        let mut child_trees = serde_json::Map::new();
        child_trees.insert("toolu_01A".into(), child_tree.clone());
        let tree = reconstruct_trace_from_nrs(
            &nrs_with_agent("toolu_01A", "Explore template.html"),
            &TraceReconOpts {
                spawns: Some(spawns),
                child_trees: Some(child_trees),
                ..Default::default()
            },
        );
        assert_eq!(tree["subagents"][0]["tree"], child_tree);
        let asst = tree["segments"][0]["turns"].as_array().unwrap().iter().find(|t| t["role"] == "assistant").unwrap();
        assert_eq!(asst["spawned_subagents"][0]["tree"], child_tree);
    }

    #[test]
    fn child_trees_by_agent_id_fallback() {
        let child_tree = json!({
            "ai_title": null,
            "segments": [{ "index": 0, "tool_calls": 1, "subagent_count": 0, "turns": [] }]
        });
        let spawns = vec![json!({
            "agent_id": "orphanAgent", "tool_use_id": null,
            "description": "no meta", "agent_type": "Explore",
            "spawn_depth": 1, "jsonl_path": "/tmp/x.jsonl", "linked": false
        })];
        let mut child_trees = serde_json::Map::new();
        child_trees.insert("agent:orphanAgent".into(), child_tree.clone());
        let tree = reconstruct_trace_from_nrs(
            &nrs_with_agent("other_id", "x"),
            &TraceReconOpts {
                spawns: Some(spawns),
                child_trees: Some(child_trees),
                ..Default::default()
            },
        );
        assert_eq!(tree["subagents"][0]["tree"], child_tree);
    }

    #[test]
    fn task_tool_attaches_spawns() {
        let nrs = vec![
            json!({ "kind": "assistant_turn", "harness": "grok", "ts": "t1", "model": "m", "stop_reason": null }),
            json!({
                "kind": "tool_use", "harness": "grok", "ts": "t1",
                "tool": "Task", "tool_id": "task_1", "category": null,
                "input": { "description": "explore" }
            }),
        ];
        let spawns = vec![json!({
            "agent_id": "t1", "tool_use_id": "task_1", "description": "explore",
            "agent_type": null, "spawn_depth": 1, "jsonl_path": null, "linked": true
        })];
        let tree = reconstruct_trace_from_nrs(
            &nrs,
            &TraceReconOpts { spawns: Some(spawns), ..Default::default() },
        );
        let asst = tree["segments"][0]["turns"].as_array().unwrap().iter().find(|t| t["role"] == "assistant").unwrap();
        assert_eq!(asst["spawned_subagents"][0]["tool_use_id"], "task_1");
    }

    #[test]
    fn orphan_spawns_on_tree_subagents_only() {
        let spawns = vec![json!({
            "agent_id": "orphan", "tool_use_id": null, "description": "lost",
            "agent_type": "Explore", "spawn_depth": 1, "jsonl_path": "/x", "linked": false
        })];
        let tree = reconstruct_trace_from_nrs(
            &nrs_with_agent("other_id", "x"),
            &TraceReconOpts { spawns: Some(spawns), ..Default::default() },
        );
        assert_eq!(tree["subagents"][0]["agent_id"], "orphan");
        let asst = tree["segments"][0]["turns"].as_array().unwrap().iter().find(|t| t["role"] == "assistant").unwrap();
        assert!(asst.get("spawned_subagents").is_none());
    }


}
