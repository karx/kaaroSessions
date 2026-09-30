//! Key cases from `test/graph-pipeline.test.mjs`.
use kaaro_core::graph_data::parse_iso_ms;
use kaaro_core::graph_pipeline::{build_graph, build_graph_data_file, BuildGraphOpts};
use serde_json::{json, Value};

fn make_data(overrides: Value) -> Value {
    let mut data = json!({
        "meta": {
            "generated_at": "2026-05-11T00:00:00.000Z",
            "date_range": {
                "first": "2026-05-01T00:00:00.000Z",
                "last": "2026-05-11T00:00:00.000Z"
            }
        },
        "projects": [{
            "id": "proj-a", "label": "Proj A", "session_count": 2,
            "tokens": { "input": 100, "output": 200, "cache_create": 50, "cache_read": 30 },
            "tokens_work": 250, "tokens_total": 380,
            "skills": ["review"]
        }],
        "sessions": [
            {
                "session_id": "s1", "project_id": "proj-a", "slug": "alpha",
                "tokens": { "input": 50, "output": 80, "cache_create": 20, "cache_read": 10 },
                "tokens_work": 100, "tokens_total": 160,
                "first_timestamp": "2026-05-01T10:00:00.000Z",
                "last_timestamp":  "2026-05-01T10:30:00.000Z",
                "git_branch": "main", "date_str": "2026-05-01", "duration_min": 30,
                "tool_calls": 10, "tool_errors": 1, "tool_diversity": 5, "message_count": 8,
                "user_turns": 4, "assistant_turns": 4, "cache_hit_rate": 20, "skills": []
            },
            {
                "session_id": "s2", "project_id": "proj-a", "slug": "beta",
                "tokens": { "input": 50, "output": 120, "cache_create": 30, "cache_read": 20 },
                "tokens_work": 150, "tokens_total": 220,
                "first_timestamp": "2026-05-05T14:00:00.000Z",
                "last_timestamp":  "2026-05-05T14:45:00.000Z",
                "git_branch": "main", "date_str": "2026-05-05", "duration_min": 45,
                "tool_calls": 15, "tool_errors": 0, "tool_diversity": 4, "message_count": 12,
                "user_turns": 6, "assistant_turns": 6, "cache_hit_rate": 30, "skills": ["review"]
            }
        ],
        "rollup": { "files": [] }
    });
    if let (Some(base), Some(over)) = (data.as_object_mut(), overrides.as_object()) {
        for (k, v) in over {
            base.insert(k.clone(), v.clone());
        }
    }
    data
}

fn ref_ms() -> i64 {
    parse_iso_ms("2026-05-11T00:00:00.000Z").unwrap()
}

fn opts() -> BuildGraphOpts {
    BuildGraphOpts {
        reference_ms: Some(ref_ms()),
        min_sessions: 1,
        ..Default::default()
    }
}

#[test]
fn build_graph_nodes_edges_timeline_basics() {
    let result = build_graph(&make_data(json!({})), opts());
    assert_eq!(
        result.nodes.iter().filter(|n| n["type"] == "project").count(),
        1
    );
    assert_eq!(
        result.nodes.iter().filter(|n| n["type"] == "session").count(),
        2
    );
    let s1 = result.nodes.iter().find(|n| n["id"] == "s1").unwrap();
    assert_eq!(s1["label"], "alpha");
    assert_eq!(s1["git_branch"], "main");
    assert_eq!(s1["tokens_work"], 100);
    assert_eq!(s1["source"], "claude-code");
    assert!(s1["sizeNorm"].as_f64().unwrap() > 0.0);

    let mem: Vec<_> = result
        .edges
        .iter()
        .filter(|e| e["type"] == "membership")
        .collect();
    assert_eq!(mem.len(), 2);
    assert!(mem.iter().all(|e| e["target"] == "proj-a"));

    let branch: Vec<_> = result
        .edges
        .iter()
        .filter(|e| e["type"] == "branch")
        .collect();
    assert_eq!(branch.len(), 1);
    assert_eq!(branch[0]["source"], "s1");
    assert_eq!(branch[0]["target"], "s2");
    assert_eq!(branch[0]["branch"], "main");

    assert_eq!(result.stats.project, 1);
    assert_eq!(result.stats.session, 2);
    assert_eq!(result.stats.membership, 2);
    assert_eq!(result.stats.branch, 1);

    assert_eq!(result.timeline.len(), 2);
    assert!(result.timeline[0]["ts"].as_str().unwrap() < result.timeline[1]["ts"].as_str().unwrap());
}

#[test]
fn tokens_work_passthrough() {
    let mut d = make_data(json!({}));
    d["sessions"][0]["tokens_work"] = json!(999);
    d["projects"][0]["tokens_work"] = json!(777);
    d["projects"][0]["tokens_total"] = json!(888);
    let result = build_graph(&d, opts());
    assert_eq!(result.nodes.iter().find(|n| n["id"] == "s1").unwrap()["tokens_work"], 999);
    let proj = result.nodes.iter().find(|n| n["type"] == "project").unwrap();
    assert_eq!(proj["tokens_work"], 777);
    assert_eq!(proj["tokens_total"], 888);
    assert_eq!(
        result.timeline.iter().find(|e| e["id"] == "s1").unwrap()["tokens_work"],
        999
    );
}

#[test]
fn session_size_norm_and_error_level() {
    let result = build_graph(&make_data(json!({})), opts());
    let s2 = result.nodes.iter().find(|n| n["id"] == "s2").unwrap();
    assert!((s2["sizeNorm"].as_f64().unwrap() - 1.0).abs() < 1e-9);
    let s1 = result.nodes.iter().find(|n| n["id"] == "s1").unwrap();
    assert!((s1["sizeNorm"].as_f64().unwrap() - (160.0_f64 / 220.0).sqrt()).abs() < 1e-9);

    let mut d = make_data(json!({}));
    d["sessions"][0]["tool_errors"] = json!(3);
    assert_eq!(
        build_graph(&d, opts()).nodes.iter().find(|n| n["id"] == "s1").unwrap()["errorLevel"],
        1
    );
    d["sessions"][0]["tool_errors"] = json!(8);
    assert_eq!(
        build_graph(&d, opts()).nodes.iter().find(|n| n["id"] == "s1").unwrap()["errorLevel"],
        2
    );
}

#[test]
fn file_nodes_and_edges() {
    let mut d = make_data(json!({
        "rollup": {
            "files": [{
                "path": "src/index.js",
                "sessions": ["s1", "s2"],
                "read": 2, "write": 1, "edit": 3
            }]
        }
    }));
    d["sessions"][0]["file_ops"] = json!({"src/index.js": {"read": 1, "write": 1, "edit": 2}});
    d["sessions"][1]["file_ops"] = json!({"src/index.js": {"read": 1, "write": 0, "edit": 1}});

    let result = build_graph(&d, opts());
    let files: Vec<_> = result.nodes.iter().filter(|n| n["type"] == "file").collect();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0]["id"], "src/index.js");
    assert_eq!(files[0]["write"], 1);
    assert_eq!(files[0]["edit"], 3);
    assert_eq!(result.stats.write, 1);
    assert_eq!(result.stats.edit, 2);
    assert_eq!(result.stats.read, 2);

    let filtered = build_graph(
        &d,
        BuildGraphOpts {
            min_sessions: 3,
            reference_ms: Some(ref_ms()),
            ..Default::default()
        },
    );
    assert_eq!(
        filtered.nodes.iter().filter(|n| n["type"] == "file").count(),
        0
    );
}

#[test]
fn subagent_nodes_opt_in() {
    let mut d = make_data(json!({}));
    d["sessions"][0]["subagents"] = json!([
        {"agent_id": "aaa", "description": "Explore x", "agent_type": "Explore"}
    ]);
    let off = build_graph(&d, opts());
    assert_eq!(off.stats.subagent, 0);

    let on = build_graph(
        &d,
        BuildGraphOpts {
            include_subagent_nodes: true,
            reference_ms: Some(ref_ms()),
            ..Default::default()
        },
    );
    assert_eq!(on.stats.subagent, 1);
    assert_eq!(on.stats.spawn, 1);
    let sub = on.nodes.iter().find(|n| n["type"] == "subagent").unwrap();
    assert!(sub["id"].as_str().unwrap().starts_with("subagent:s1:"));
}

#[test]
fn canonical_raw_id_remap() {
    let d = make_data(json!({
        "projects": [
            {
                "id": "proj-a", "label": "Proj A", "session_count": 2,
                "raw_ids": ["proj-a", "proj-a-raw"],
                "harnesses": ["claude-code", "pi"],
                "tokens_work": 250, "tokens_total": 380, "tool_calls": 0, "skills": []
            }
        ],
        "sessions": [
            {
                "session_id": "s1", "project_id": "proj-a", "slug": "alpha",
                "tokens_work": 100, "tokens_total": 160,
                "first_timestamp": "2026-05-01T10:00:00.000Z",
                "last_timestamp": "2026-05-01T10:30:00.000Z",
                "git_branch": "main", "date_str": "2026-05-01",
                "tool_calls": 10, "tool_errors": 0, "skills": []
            },
            {
                "session_id": "s3", "project_id": "proj-a-raw", "slug": "gamma", "harness": "pi",
                "tokens_work": 50, "tokens_total": 80,
                "first_timestamp": "2026-05-03T10:00:00.000Z",
                "last_timestamp": "2026-05-03T10:30:00.000Z",
                "git_branch": "main", "date_str": "2026-05-03",
                "tool_calls": 5, "tool_errors": 0, "skills": []
            }
        ]
    }));
    let result = build_graph(&d, opts());
    let s3 = result.nodes.iter().find(|n| n["id"] == "s3").unwrap();
    assert_eq!(s3["project_id"], "proj-a");
    let e = result
        .edges
        .iter()
        .find(|e| e["type"] == "membership" && e["source"] == "s3")
        .unwrap();
    assert_eq!(e["target"], "proj-a");
}

#[test]
fn cluster_from_shared_files() {
    let mk = |id: &str, ts: &str, extra: Value| {
        let mut s = json!({
            "session_id": id, "project_id": "proj-a", "slug": format!("slug-{id}"),
            "tokens": {"input": 10, "output": 80, "cache_create": 20, "cache_read": 10},
            "tokens_work": 100,
            "first_timestamp": format!("{ts}T10:00:00.000Z"),
            "last_timestamp": format!("{ts}T11:00:00.000Z"),
            "git_branch": "main", "date_str": ts, "duration_min": 60,
            "tool_calls": 10, "tool_errors": 1, "tool_diversity": 4, "message_count": 8,
            "user_turns": 4, "assistant_turns": 4, "cache_hit_rate": 20, "skills": []
        });
        if let (Some(obj), Some(ex)) = (s.as_object_mut(), extra.as_object()) {
            for (k, v) in ex {
                obj.insert(k.clone(), v.clone());
            }
        }
        s
    };
    let d = make_data(json!({
        "projects": [{
            "id": "proj-a", "label": "Proj A", "session_count": 4,
            "tokens_work": 250, "tokens_total": 380, "skills": []
        }],
        "sessions": [
            mk("c1", "2026-05-01", json!({
                "file_ops": {"src/auth.js": {"read": 1, "write": 1, "edit": 0}},
                "ai_title": "auth rework", "skills": ["review"]
            })),
            mk("c2", "2026-05-02", json!({
                "file_ops": {"src/auth.js": {"read": 1, "write": 0, "edit": 1}},
                "ai_title": "auth cleanup", "harness": "grok",
                "tokens": {"input": 10, "output": 100, "cache_create": 0, "cache_read": 0},
                "tokens_work": 100
            })),
            mk("c3", "2026-05-03", json!({
                "file_ops": {"src/auth.js": {"read": 2, "write": 0, "edit": 0}},
                "tokens": {"input": 10, "output": 50, "cache_create": 50, "cache_read": 0},
                "tokens_work": 100
            })),
            mk("s4", "2026-05-04", json!({
                "file_ops": {"docs/readme.md": {"read": 1, "write": 0, "edit": 0}},
                "tokens": {"input": 10, "output": 10, "cache_create": 0, "cache_read": 0},
                "tokens_work": 10
            }))
        ]
    }));
    let result = build_graph(&d, opts());
    let clusters: Vec<_> = result.nodes.iter().filter(|n| n["type"] == "cluster").collect();
    assert_eq!(clusters.len(), 1);
    assert_eq!(clusters[0]["id"], "cluster:proj-a:c1");
    assert_eq!(clusters[0]["member_count"], 3);
    assert_eq!(result.stats.bundle, 3);
    assert_eq!(result.nodes.iter().find(|n| n["id"] == "c1").unwrap()["cluster_id"], "cluster:proj-a:c1");
    assert!(result.nodes.iter().find(|n| n["id"] == "s4").unwrap()["cluster_id"].is_null());
}

#[test]
fn graph_data_file_shape() {
    let data = make_data(json!({}));
    let file = build_graph_data_file(&data, opts());
    assert!(!file.nodes.is_empty());
    assert!(file.nodes.iter().any(|n| n["type"] == "session"));
    assert_eq!(file.meta["generated_at"], "2026-05-11T00:00:00.000Z");
    let pretty = file.to_json_pretty().unwrap();
    assert!(pretty.contains("\"nodes\""));
    assert!(pretty.contains("\"timeline\""));
}
