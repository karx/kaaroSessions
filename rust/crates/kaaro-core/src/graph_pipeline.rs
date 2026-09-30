//! Transform sessions-data.json → graph nodes/edges/timeline.
//! Port of `experience/graph-pipeline.mjs`.

use crate::graph_data::{
    assign_project_colors, build_file_nodes_and_edges, calc_recency_level, calc_recency_score,
    is_session_in_flight, parse_iso_ms, PALETTE,
};
use crate::session_clusters::build_clusters;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Default)]
pub struct BuildGraphOpts {
    pub min_sessions: usize,
    pub reference_ms: Option<i64>,
    pub cluster_overrides: Option<Value>,
    pub include_subagent_nodes: bool,
}

impl BuildGraphOpts {
    pub fn new() -> Self {
        Self {
            min_sessions: 1,
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GraphStats {
    pub project: usize,
    pub session: usize,
    pub cluster: usize,
    pub subagent: usize,
    pub file: usize,
    pub membership: usize,
    pub bundle: usize,
    pub branch: usize,
    pub spawn: usize,
    pub write: usize,
    pub edit: usize,
    pub read: usize,
}

#[derive(Debug, Clone)]
pub struct GraphBuildResult {
    pub nodes: Vec<Value>,
    pub edges: Vec<Value>,
    pub timeline: Vec<Value>,
    pub stats: GraphStats,
    pub project_colors: BTreeMap<String, String>,
    pub color_to_index: BTreeMap<String, usize>,
}

/// Payload written to `graph-data.json` (SSE / snapshot).
#[derive(Debug, Clone, Serialize)]
pub struct GraphDataFile {
    pub nodes: Vec<Value>,
    pub edges: Vec<Value>,
    pub meta: Value,
    pub timeline: Vec<Value>,
}

impl GraphDataFile {
    pub fn from_build(result: &GraphBuildResult, meta: Value) -> Self {
        Self {
            nodes: result.nodes.clone(),
            edges: result.edges.clone(),
            meta,
            timeline: result.timeline.clone(),
        }
    }

    pub fn to_json_pretty(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn str_opt<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

fn i64_opt(v: &Value, key: &str) -> i64 {
    v.get(key)
        .and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64)))
        .unwrap_or(0)
}

fn top_tools(tools: Option<&Value>) -> Vec<Value> {
    let Some(obj) = tools.and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let mut entries: Vec<(String, i64)> = obj
        .iter()
        .map(|(name, d)| {
            let calls = d
                .get("calls")
                .and_then(|c| c.as_i64())
                .unwrap_or(0);
            (name.clone(), calls)
        })
        .collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    entries
        .into_iter()
        .take(10)
        .map(|(name, calls)| json!({"name": name, "calls": calls}))
        .collect()
}

fn error_level(tool_errors: i64) -> u8 {
    if tool_errors >= 8 {
        2
    } else if tool_errors >= 3 {
        1
    } else {
        0
    }
}

fn build_canonical_map(projects: &[Value]) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for proj in projects {
        let id = match str_opt(proj, "id") {
            Some(id) => id.to_string(),
            None => continue,
        };
        if let Some(raws) = proj.get("raw_ids").and_then(|v| v.as_array()) {
            for raw in raws {
                if let Some(r) = raw.as_str() {
                    map.insert(r.to_string(), id.clone());
                }
            }
        } else {
            map.insert(id.clone(), id);
        }
    }
    map
}

/// Build graph nodes + edges + timeline from a sessions-data.json object.
pub fn build_graph(data: &Value, opts: BuildGraphOpts) -> GraphBuildResult {
    let projects: Vec<Value> = data
        .get("projects")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let sessions: Vec<Value> = data
        .get("sessions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let ref_ms = opts.reference_ms.unwrap_or_else(|| {
        data.get("meta")
            .and_then(|m| str_opt(m, "generated_at"))
            .and_then(parse_iso_ms)
            .unwrap_or_else(now_ms)
    });

    let (project_colors, color_to_index) = assign_project_colors(&projects, PALETTE);
    let canonical_of = build_canonical_map(&projects);
    let canon = |raw: &str| -> String {
        canonical_of
            .get(raw)
            .cloned()
            .unwrap_or_else(|| raw.to_string())
    };

    let mut proj_last_ts: BTreeMap<String, String> = BTreeMap::new();
    for s in &sessions {
        let ts = str_opt(s, "last_timestamp").or_else(|| str_opt(s, "first_timestamp"));
        let pid = canon(str_opt(s, "project_id").unwrap_or(""));
        if let Some(ts) = ts {
            let entry = proj_last_ts.entry(pid).or_default();
            if entry.is_empty() || ts > entry.as_str() {
                *entry = ts.to_string();
            }
        }
    }

    let mut nodes: Vec<Value> = Vec::new();
    let mut edges: Vec<Value> = Vec::new();

    // ── Project nodes ──────────────────────────────────────────────────────
    let consumption = |p: &Value| -> i64 {
        let tt = i64_opt(p, "tokens_total");
        if tt > 0 {
            tt
        } else {
            i64_opt(p, "tool_calls")
        }
    };
    let max_consumption = projects.iter().map(consumption).max().unwrap_or(1).max(1);

    for proj in &projects {
        let id = str_opt(proj, "id").unwrap_or("").to_string();
        let p_last = proj_last_ts.get(&id).map(|s| s.as_str());
        let cons = consumption(proj);
        let size_norm = (cons as f64 / max_consumption as f64).sqrt();
        let color = project_colors
            .get(&id)
            .cloned()
            .unwrap_or_else(|| "#888888".into());
        nodes.push(json!({
            "id": id,
            "type": "project",
            "label": str_opt(proj, "label").unwrap_or(""),
            "color": color,
            "session_count": i64_opt(proj, "session_count"),
            "tokens_total": i64_opt(proj, "tokens_total"),
            "tokens_work": i64_opt(proj, "tokens_work"),
            "skills": proj.get("skills").cloned().unwrap_or(json!([])),
            "harnesses": proj.get("harnesses").cloned().unwrap_or(json!([])),
            "raw_ids": proj.get("raw_ids").cloned().unwrap_or(json!([])),
            "sizeNorm": size_norm,
            "last_activity": p_last,
            "recency": calc_recency_score(p_last, ref_ms),
            "recencyLevel": calc_recency_level(p_last, ref_ms),
        }));
    }

    // ── Session nodes ──────────────────────────────────────────────────────
    let max_total = sessions
        .iter()
        .map(|s| i64_opt(s, "tokens_total"))
        .max()
        .unwrap_or(1)
        .max(1);
    let max_tool_calls = sessions
        .iter()
        .map(|s| i64_opt(s, "tool_calls"))
        .max()
        .unwrap_or(1)
        .max(1);

    let flight_now = now_ms();

    for sess in &sessions {
        let sid = str_opt(sess, "session_id").unwrap_or("").to_string();
        let raw_pid = str_opt(sess, "project_id").unwrap_or("");
        let pid = canon(raw_pid);
        let tokens = sess.get("tokens").cloned().unwrap_or(json!({}));
        let tokens_work = i64_opt(sess, "tokens_work");
        let tokens_total = i64_opt(sess, "tokens_total");
        let tool_calls = i64_opt(sess, "tool_calls");
        let size_norm = if tokens_total > 0 {
            (tokens_total as f64 / max_total as f64).sqrt()
        } else {
            (tool_calls as f64 / max_tool_calls as f64).sqrt()
        };
        let label = str_opt(sess, "slug")
            .map(|s| s.to_string())
            .unwrap_or_else(|| sid.chars().take(8).collect());
        let color = project_colors
            .get(&pid)
            .cloned()
            .unwrap_or_else(|| "#888888".into());
        let source = str_opt(sess, "source")
            .or_else(|| str_opt(sess, "harness"))
            .unwrap_or("claude-code");
        let harness = str_opt(sess, "harness")
            .or_else(|| str_opt(sess, "source"))
            .unwrap_or("claude-code");
        let last_act = str_opt(sess, "last_timestamp").or_else(|| str_opt(sess, "first_timestamp"));
        let thinking = sess
            .get("content_blocks")
            .and_then(|c| c.get("thinking"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let hit_max = sess
            .get("stop_reasons")
            .and_then(|s| s.get("max_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            > 0;
        let bash_git = sess
            .get("bash_categories")
            .and_then(|b| b.get("git"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let subagents = sess
            .get("subagents")
            .cloned()
            .unwrap_or(json!([]));
        let branches = sess.get("branches").cloned().unwrap_or(json!([]));
        let tool_errors = i64_opt(sess, "tool_errors");

        nodes.push(json!({
            "id": sid,
            "type": "session",
            "label": label,
            "color": color,
            "project_id": pid,
            "git_branch": str_opt(sess, "git_branch"),
            "harness": harness,
            "tokens_work": tokens_work,
            "tokens_cached": i64_opt(&tokens, "cache_read"),
            "tokens_output": i64_opt(&tokens, "output"),
            "tokens_total": tokens_total,
            "cache_hit_rate": sess.get("cache_hit_rate").cloned().unwrap_or(Value::Null),
            "tool_calls": tool_calls,
            "tool_errors": tool_errors,
            "tool_diversity": sess.get("tool_diversity").cloned().unwrap_or(Value::Null),
            "message_count": sess.get("message_count").cloned().unwrap_or(Value::Null),
            "user_turns": i64_opt(sess, "user_turns"),
            "assistant_turns": i64_opt(sess, "assistant_turns"),
            "thinking_count": thinking,
            "hit_max_tokens": hit_max,
            "bash_git": bash_git,
            "skills": sess.get("skills").cloned().unwrap_or(json!([])),
            "date_str": str_opt(sess, "date_str"),
            "first_timestamp": str_opt(sess, "first_timestamp"),
            "duration_min": sess.get("duration_min").cloned().unwrap_or(Value::Null),
            "first_user_message": str_opt(sess, "first_user_message"),
            "model": str_opt(sess, "model"),
            "source": source,
            "context_resets": i64_opt(sess, "context_resets"),
            "ai_title": str_opt(sess, "ai_title"),
            "subagent_count": i64_opt(sess, "subagent_count"),
            "subagents": subagents,
            "branches": branches,
            "tools_top": top_tools(sess.get("tools")),
            "sizeNorm": size_norm,
            "errorLevel": error_level(tool_errors),
            "last_activity": last_act,
            "recency": calc_recency_score(last_act, ref_ms),
            "recencyLevel": calc_recency_level(last_act, ref_ms),
            "inFlight": is_session_in_flight(str_opt(sess, "last_timestamp"), flight_now),
            "cluster_id": Value::Null,
        }));
        edges.push(json!({
            "source": sid,
            "target": pid,
            "type": "membership"
        }));
    }

    // ── Subagent nodes (opt-in) ────────────────────────────────────────────
    if opts.include_subagent_nodes {
        for sess in &sessions {
            let sid = str_opt(sess, "session_id").unwrap_or("");
            let stubs = sess
                .get("subagents")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for s in stubs {
                let Some(agent_id) = str_opt(&s, "agent_id") else { continue };
                let id = format!("subagent:{sid}:{agent_id}");
                let raw_pid = str_opt(sess, "project_id").unwrap_or("");
                let color = project_colors
                    .get(raw_pid)
                    .cloned()
                    .unwrap_or_else(|| "#cc2244".into());
                let last_act =
                    str_opt(sess, "last_timestamp").or_else(|| str_opt(sess, "first_timestamp"));
                nodes.push(json!({
                    "id": id,
                    "type": "subagent",
                    "label": agent_id.chars().take(8).collect::<String>(),
                    "color": color,
                    "project_id": raw_pid,
                    "parent_session_id": sid,
                    "agent_id": agent_id,
                    "agent_type": str_opt(&s, "agent_type"),
                    "description": str_opt(&s, "description"),
                    "tool_use_id": str_opt(&s, "tool_use_id"),
                    "spawn_depth": s.get("spawn_depth").cloned().unwrap_or(Value::Null),
                    "linked": s.get("linked").and_then(|v| v.as_bool()).unwrap_or(true),
                    "harness": str_opt(sess, "harness").or_else(|| str_opt(sess, "source")).unwrap_or("claude-code"),
                    "sizeNorm": 0.15,
                    "last_activity": last_act,
                    "recency": calc_recency_score(last_act, ref_ms),
                    "recencyLevel": calc_recency_level(last_act, ref_ms),
                }));
                edges.push(json!({"source": sid, "target": id, "type": "spawn"}));
            }
        }
    }

    // ── Clusters ───────────────────────────────────────────────────────────
    let mut session_node_by_id: BTreeMap<String, usize> = BTreeMap::new();
    for (i, n) in nodes.iter().enumerate() {
        if str_opt(n, "type") == Some("session") {
            if let Some(id) = str_opt(n, "id") {
                session_node_by_id.insert(id.to_string(), i);
            }
        }
    }

    let sessions_for_clusters: Vec<Value> = sessions
        .iter()
        .map(|s| {
            let raw = str_opt(s, "project_id").unwrap_or("");
            let cid = canon(raw);
            if cid == raw {
                s.clone()
            } else {
                let mut c = s.clone();
                if let Some(obj) = c.as_object_mut() {
                    obj.insert("project_id".into(), json!(cid));
                }
                c
            }
        })
        .collect();
    let cluster_refs: Vec<&Value> = sessions_for_clusters.iter().collect();
    let clusters = build_clusters(&cluster_refs, opts.cluster_overrides.as_ref());

    let node_field = |id: &str, field: &str| -> i64 {
        session_node_by_id
            .get(id)
            .map(|&i| i64_opt(&nodes[i], field))
            .unwrap_or(0)
    };
    let sum_over = |member_ids: &[String], field: &str| -> i64 {
        member_ids.iter().map(|id| node_field(id, field)).sum()
    };
    let max_cluster_work = clusters
        .iter()
        .map(|c| sum_over(&c.member_ids, "tokens_work"))
        .max()
        .unwrap_or(1)
        .max(1);
    let max_cluster_calls = clusters
        .iter()
        .map(|c| sum_over(&c.member_ids, "tool_calls"))
        .max()
        .unwrap_or(1)
        .max(1);

    let mut pending_cluster_nodes: Vec<Value> = Vec::new();
    let mut pending_cluster_edges: Vec<Value> = Vec::new();
    let mut cluster_id_updates: Vec<(String, String)> = Vec::new();

    for c in &clusters {
        let members: Vec<&Value> = c
            .member_ids
            .iter()
            .filter_map(|id| session_node_by_id.get(id).map(|&i| &nodes[i]))
            .collect();
        let tokens_work = sum_over(&c.member_ids, "tokens_work");
        let tool_calls = sum_over(&c.member_ids, "tool_calls");
        let tool_errors = sum_over(&c.member_ids, "tool_errors");
        let mut dates: Vec<&str> = members
            .iter()
            .filter_map(|m| str_opt(m, "date_str"))
            .collect();
        dates.sort();
        let mut last_acts: Vec<&str> = members
            .iter()
            .filter_map(|m| str_opt(m, "last_activity"))
            .collect();
        last_acts.sort();
        let last_activity = last_acts.last().copied();
        let mut skills: BTreeMap<String, ()> = BTreeMap::new();
        for m in &members {
            if let Some(arr) = m.get("skills").and_then(|v| v.as_array()) {
                for s in arr.iter().filter_map(|x| x.as_str()) {
                    skills.insert(s.to_string(), ());
                }
            }
        }
        let mut harnesses: BTreeMap<String, ()> = BTreeMap::new();
        for m in &members {
            if let Some(h) = str_opt(m, "harness") {
                harnesses.insert(h.to_string(), ());
            }
        }
        let size_norm = if tokens_work > 0 {
            (tokens_work as f64 / max_cluster_work as f64).sqrt()
        } else {
            (tool_calls as f64 / max_cluster_calls as f64).sqrt()
        };
        let color = project_colors
            .get(&c.project_id)
            .cloned()
            .unwrap_or_else(|| "#888888".into());
        let in_flight = members
            .iter()
            .any(|m| m.get("inFlight").and_then(|v| v.as_bool()).unwrap_or(false));

        pending_cluster_nodes.push(json!({
            "id": c.id,
            "type": "cluster",
            "label": c.label,
            "color": color,
            "project_id": c.project_id,
            "member_ids": c.member_ids,
            "member_count": c.member_ids.len(),
            "tokens_work": tokens_work,
            "tool_calls": tool_calls,
            "tool_errors": tool_errors,
            "skills": skills.keys().cloned().collect::<Vec<_>>(),
            "harnesses": harnesses.keys().cloned().collect::<Vec<_>>(),
            "date_first": dates.first().copied(),
            "date_last": dates.last().copied(),
            "sizeNorm": size_norm,
            "errorLevel": error_level(tool_errors),
            "manual": c.manual,
            "label_overridden": c.label_overridden,
            "last_activity": last_activity,
            "recency": calc_recency_score(last_activity, ref_ms),
            "recencyLevel": calc_recency_level(last_activity, ref_ms),
            "inFlight": in_flight,
        }));
        pending_cluster_edges.push(json!({
            "source": c.id,
            "target": c.project_id,
            "type": "membership"
        }));
        for id in &c.member_ids {
            pending_cluster_edges.push(json!({"source": id, "target": c.id, "type": "bundle"}));
            cluster_id_updates.push((id.clone(), c.id.clone()));
        }
    }

    for (sid, cid) in cluster_id_updates {
        if let Some(&idx) = session_node_by_id.get(&sid) {
            if let Some(obj) = nodes[idx].as_object_mut() {
                obj.insert("cluster_id".into(), json!(cid));
            }
        }
    }
    nodes.extend(pending_cluster_nodes);
    edges.extend(pending_cluster_edges);

    // ── Branch lineage ─────────────────────────────────────────────────────
    let mut branch_groups: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for sess in &sessions {
        let b = str_opt(sess, "git_branch").unwrap_or("__unknown__").to_string();
        branch_groups.entry(b).or_default().push(sess);
    }
    for group in branch_groups.values() {
        if group.len() < 2 {
            continue;
        }
        let mut sorted = group.clone();
        sorted.sort_by(|a, b| {
            let ta = str_opt(a, "first_timestamp").unwrap_or("");
            let tb = str_opt(b, "first_timestamp").unwrap_or("");
            ta.cmp(tb)
        });
        for i in 0..sorted.len() - 1 {
            edges.push(json!({
                "source": str_opt(sorted[i], "session_id"),
                "target": str_opt(sorted[i + 1], "session_id"),
                "type": "branch",
                "branch": str_opt(sorted[i], "git_branch"),
            }));
        }
    }

    // ── File nodes ─────────────────────────────────────────────────────────
    let global_files: Vec<Value> = data
        .get("rollup")
        .and_then(|r| r.get("files"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut sess_by_id: BTreeMap<String, Value> = BTreeMap::new();
    for s in &sessions {
        if let Some(id) = str_opt(s, "session_id") {
            sess_by_id.insert(id.to_string(), s.clone());
        }
    }
    let (file_nodes, file_edges) =
        build_file_nodes_and_edges(&global_files, &sess_by_id, opts.min_sessions, ref_ms);
    nodes.extend(file_nodes);
    edges.extend(file_edges);

    // ── Timeline ───────────────────────────────────────────────────────────
    let mut timeline_src: Vec<&Value> = sessions
        .iter()
        .filter(|s| str_opt(s, "date_str").is_some())
        .collect();
    timeline_src.sort_by(|a, b| {
        let ta = str_opt(a, "first_timestamp").unwrap_or("");
        let tb = str_opt(b, "first_timestamp").unwrap_or("");
        ta.cmp(tb)
    });
    let timeline: Vec<Value> = timeline_src
        .into_iter()
        .map(|s| {
            let sid = str_opt(s, "session_id").unwrap_or("");
            let raw_pid = str_opt(s, "project_id").unwrap_or("");
            let pid = canon(raw_pid);
            let color = project_colors
                .get(&pid)
                .cloned()
                .unwrap_or_else(|| "#888".into());
            let tw = i64_opt(s, "tokens_work");
            let tokens_work = if tw > 0 { tw } else { i64_opt(s, "tool_calls") };
            let slug = str_opt(s, "slug")
                .map(|x| x.to_string())
                .unwrap_or_else(|| sid.chars().take(8).collect());
            let project = str_opt(s, "project_label")
                .or(Some(raw_pid))
                .unwrap_or(raw_pid);
            json!({
                "id": sid,
                "date_str": str_opt(s, "date_str"),
                "ts": str_opt(s, "first_timestamp"),
                "color": color,
                "project": project,
                "slug": slug,
                "tokens_work": tokens_work,
                "tool_errors": i64_opt(s, "tool_errors"),
                "skills": s.get("skills").cloned().unwrap_or(json!([])),
            })
        })
        .collect();

    let stats = GraphStats {
        project: nodes.iter().filter(|n| str_opt(n, "type") == Some("project")).count(),
        session: nodes.iter().filter(|n| str_opt(n, "type") == Some("session")).count(),
        cluster: nodes.iter().filter(|n| str_opt(n, "type") == Some("cluster")).count(),
        subagent: nodes.iter().filter(|n| str_opt(n, "type") == Some("subagent")).count(),
        file: nodes.iter().filter(|n| str_opt(n, "type") == Some("file")).count(),
        membership: edges.iter().filter(|e| str_opt(e, "type") == Some("membership")).count(),
        bundle: edges.iter().filter(|e| str_opt(e, "type") == Some("bundle")).count(),
        branch: edges.iter().filter(|e| str_opt(e, "type") == Some("branch")).count(),
        spawn: edges.iter().filter(|e| str_opt(e, "type") == Some("spawn")).count(),
        write: edges.iter().filter(|e| str_opt(e, "type") == Some("write")).count(),
        edit: edges.iter().filter(|e| str_opt(e, "type") == Some("edit")).count(),
        read: edges.iter().filter(|e| str_opt(e, "type") == Some("read")).count(),
    };

    GraphBuildResult {
        nodes,
        edges,
        timeline,
        stats,
        project_colors,
        color_to_index,
    }
}

/// Convenience: build graph-data.json payload from sessions-data Value.
pub fn build_graph_data_file(data: &Value, opts: BuildGraphOpts) -> GraphDataFile {
    let meta = data.get("meta").cloned().unwrap_or(json!({}));
    let result = build_graph(data, opts);
    GraphDataFile::from_build(&result, meta)
}
