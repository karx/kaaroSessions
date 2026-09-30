//! Claude Code subagent on-disk discovery — port of
//! `hooks/helpers/subagent-discover.mjs`.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// Parent log `…/<uuid>.jsonl` → sibling session dir `…/<uuid>`.
pub fn parent_session_dir_from_log(log_file_path: &Path) -> PathBuf {
    let base = log_file_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    log_file_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(base)
}

/// Parent or sidechain log → flat parent session dir that holds `subagents/`.
pub fn subagent_scan_dir_from_log(log_file_path: &Path) -> PathBuf {
    let dir = log_file_path.parent().unwrap_or_else(|| Path::new("."));
    let base = log_file_path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let is_agent = base.to_ascii_lowercase().starts_with("agent-")
        && base.to_ascii_lowercase().ends_with(".jsonl");
    let parent_is_subagents = dir
        .file_name()
        .map(|s| s.to_string_lossy() == "subagents")
        .unwrap_or(false);
    if is_agent && parent_is_subagents {
        return dir.parent().unwrap_or(dir).to_path_buf();
    }
    parent_session_dir_from_log(log_file_path)
}

/// Sidechain agent id from `…/subagents/agent-<id>.jsonl`, else None.
pub fn agent_id_from_sidechain_log(log_file_path: &Path) -> Option<String> {
    let base = log_file_path.file_name()?.to_string_lossy();
    let lower = base.to_ascii_lowercase();
    if !lower.starts_with("agent-") || !lower.ends_with(".jsonl") {
        return None;
    }
    let parent_is_subagents = log_file_path
        .parent()
        .and_then(|d| d.file_name())
        .map(|s| s.to_string_lossy() == "subagents")
        .unwrap_or(false);
    if !parent_is_subagents {
        return None;
    }
    let id = &base[6..base.len() - 6]; // strip agent- and .jsonl
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

#[derive(Debug, Clone)]
pub struct SubagentArtifact {
    pub agent_id: String,
    pub meta_path: Option<PathBuf>,
    pub jsonl_path: PathBuf,
    pub meta: Option<Value>,
}

/// List agent-*.jsonl (+ optional .meta.json) under `<parentSessionDir>/subagents`.
pub fn list_subagent_artifacts(parent_session_dir: &Path) -> Vec<SubagentArtifact> {
    let sub_dir = parent_session_dir.join("subagents");
    let Ok(meta) = fs::metadata(&sub_dir) else {
        return vec![];
    };
    if !meta.is_dir() {
        return vec![];
    }
    let Ok(rd) = fs::read_dir(&sub_dir) else {
        return vec![];
    };

    let mut by_agent: HashMap<String, (Option<PathBuf>, Option<PathBuf>, Option<Value>)> =
        HashMap::new();

    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        let lower = name.to_ascii_lowercase();
        if lower.starts_with("agent-") && lower.ends_with(".jsonl") {
            let agent_id = name[6..name.len() - 6].to_string();
            if agent_id.is_empty() {
                continue;
            }
            let entry = by_agent.entry(agent_id).or_insert((None, None, None));
            entry.1 = Some(sub_dir.join(&name));
            continue;
        }
        if name.starts_with("agent-") && name.ends_with(".meta.json") {
            let agent_id = name["agent-".len()..name.len() - ".meta.json".len()].to_string();
            if agent_id.is_empty() {
                continue;
            }
            let meta_path = sub_dir.join(&name);
            let meta_val = fs::read_to_string(&meta_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok());
            let entry = by_agent.entry(agent_id).or_insert((None, None, None));
            entry.0 = Some(meta_path);
            entry.2 = meta_val;
        }
    }

    let mut out: Vec<SubagentArtifact> = by_agent
        .into_iter()
        .filter_map(|(agent_id, (meta_path, jsonl_path, meta))| {
            let jsonl_path = jsonl_path?;
            Some(SubagentArtifact {
                agent_id,
                meta_path,
                jsonl_path,
                meta,
            })
        })
        .collect();
    out.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
    out
}

fn ref_from_artifact(
    art: &SubagentArtifact,
    tool_use_id: Option<String>,
    description: Option<String>,
    linked: bool,
) -> Value {
    let meta = art.meta.as_ref();
    let tool_use_id = tool_use_id.or_else(|| {
        meta.and_then(|m| m.get("toolUseId").and_then(|v| v.as_str()).map(|s| s.to_string()))
    });
    let description = description.or_else(|| {
        meta.and_then(|m| m.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()))
    });
    let agent_type = meta
        .and_then(|m| m.get("agentType").and_then(|v| v.as_str()))
        .map(|s| json!(s))
        .unwrap_or(Value::Null);
    let spawn_depth = meta
        .and_then(|m| m.get("spawnDepth"))
        .and_then(|v| v.as_i64())
        .map(|n| json!(n))
        .unwrap_or(Value::Null);
    json!({
        "agent_id": art.agent_id,
        "tool_use_id": tool_use_id,
        "description": description,
        "agent_type": agent_type,
        "spawn_depth": spawn_depth,
        "jsonl_path": art.jsonl_path.to_string_lossy(),
        "linked": linked,
    })
}

/// Link parent Agent/Task tool uses to artifacts via meta.toolUseId.
pub fn link_spawns(agent_tool_uses: &[Value], artifacts: &[SubagentArtifact]) -> Vec<Value> {
    let mut by_tool_use_id: HashMap<String, &SubagentArtifact> = HashMap::new();
    for a in artifacts {
        if let Some(tid) = a
            .meta
            .as_ref()
            .and_then(|m| m.get("toolUseId"))
            .and_then(|v| v.as_str())
        {
            by_tool_use_id.insert(tid.to_string(), a);
        }
    }

    let mut used_agent_ids: HashSet<String> = HashSet::new();
    let mut refs = Vec::new();

    for tu in agent_tool_uses {
        let tool_use_id = tu
            .get("tool_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let desc = tu
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if let Some(ref tid) = tool_use_id {
            if let Some(art) = by_tool_use_id.get(tid) {
                used_agent_ids.insert(art.agent_id.clone());
                let description = art
                    .meta
                    .as_ref()
                    .and_then(|m| m.get("description").and_then(|v| v.as_str()))
                    .map(|s| s.to_string())
                    .or(desc);
                refs.push(ref_from_artifact(
                    art,
                    Some(tid.clone()),
                    description,
                    true,
                ));
                continue;
            }
        }
        refs.push(json!({
            "agent_id": null,
            "tool_use_id": tool_use_id,
            "description": desc,
            "agent_type": null,
            "spawn_depth": null,
            "jsonl_path": null,
            "linked": false,
        }));
    }

    for art in artifacts {
        if used_agent_ids.contains(&art.agent_id) {
            continue;
        }
        let tool_use_id = art
            .meta
            .as_ref()
            .and_then(|m| m.get("toolUseId").and_then(|v| v.as_str()))
            .map(|s| s.to_string());
        let description = art
            .meta
            .as_ref()
            .and_then(|m| m.get("description").and_then(|v| v.as_str()))
            .map(|s| s.to_string());
        refs.push(ref_from_artifact(art, tool_use_id, description, false));
    }

    refs
}

/// Graph/analyze stubs only — no jsonl_path, no nested tree.
pub fn stub_refs_from_artifacts(artifacts: &[SubagentArtifact]) -> Vec<Value> {
    artifacts
        .iter()
        .map(|a| {
            let meta = a.meta.as_ref();
            let tool_use_id = meta
                .and_then(|m| m.get("toolUseId").and_then(|v| v.as_str()))
                .map(|s| s.to_string());
            json!({
                "agent_id": a.agent_id,
                "tool_use_id": tool_use_id,
                "description": meta.and_then(|m| m.get("description").cloned()).unwrap_or(Value::Null),
                "agent_type": meta.and_then(|m| m.get("agentType").cloned()).unwrap_or(Value::Null),
                "spawn_depth": match meta.and_then(|m| m.get("spawnDepth")) {
                    Some(v) if v.is_number() => v.clone(),
                    _ => Value::Null,
                },
                "linked": tool_use_id.is_some(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root() -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("kaaro-subagent-disc-{n}"));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_agent(sub: &Path, agent_id: &str, meta: &Value) {
        fs::write(
            sub.join(format!("agent-{agent_id}.meta.json")),
            serde_json::to_string(meta).unwrap(),
        )
        .unwrap();
        fs::write(sub.join(format!("agent-{agent_id}.jsonl")), "{\"type\":\"user\"}\n").unwrap();
    }

    #[test]
    fn parent_session_dir_from_log_basic() {
        let p = PathBuf::from("proj").join("abc-uuid.jsonl");
        assert_eq!(
            parent_session_dir_from_log(&p),
            PathBuf::from("proj").join("abc-uuid")
        );
    }

    #[test]
    fn scan_dir_parent_and_sidechain() {
        let parent_log = PathBuf::from("proj").join("abc-uuid.jsonl");
        let sidechain = PathBuf::from("proj")
            .join("abc-uuid")
            .join("subagents")
            .join("agent-aaa111.jsonl");
        let expected = PathBuf::from("proj").join("abc-uuid");
        assert_eq!(subagent_scan_dir_from_log(&parent_log), expected);
        assert_eq!(subagent_scan_dir_from_log(&sidechain), expected);
        assert_ne!(
            subagent_scan_dir_from_log(&sidechain),
            PathBuf::from("proj")
                .join("abc-uuid")
                .join("subagents")
                .join("agent-aaa111")
        );
    }

    #[test]
    fn agent_id_from_sidechain() {
        assert_eq!(
            agent_id_from_sidechain_log(
                &PathBuf::from("proj")
                    .join("u")
                    .join("subagents")
                    .join("agent-xyz.jsonl")
            )
            .as_deref(),
            Some("xyz")
        );
        assert!(agent_id_from_sidechain_log(&PathBuf::from("proj").join("u.jsonl")).is_none());
        assert!(agent_id_from_sidechain_log(
            &PathBuf::from("proj")
                .join("u")
                .join("other")
                .join("agent-x.jsonl")
        )
        .is_none());
    }

    #[test]
    fn list_missing_or_empty() {
        let root = temp_root();
        assert!(list_subagent_artifacts(&root.join("nope")).is_empty());
        fs::create_dir_all(root.join("parent").join("subagents")).unwrap();
        assert!(list_subagent_artifacts(&root.join("parent")).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_three_explore() {
        let root = temp_root();
        let parent = root.join("parent-sess");
        let sub = parent.join("subagents");
        fs::create_dir_all(&sub).unwrap();
        write_agent(
            &sub,
            "aaa111",
            &json!({
                "agentType": "Explore",
                "description": "Explore template.html",
                "toolUseId": "toolu_01A",
                "spawnDepth": 1
            }),
        );
        write_agent(
            &sub,
            "bbb222",
            &json!({
                "agentType": "Explore",
                "description": "Explore build.mjs",
                "toolUseId": "toolu_01B",
                "spawnDepth": 1
            }),
        );
        write_agent(
            &sub,
            "ccc333",
            &json!({
                "agentType": "Explore",
                "description": "Explore client-core",
                "toolUseId": "toolu_01C",
                "spawnDepth": 1
            }),
        );
        let arts = list_subagent_artifacts(&parent);
        assert_eq!(arts.len(), 3);
        let a = arts.iter().find(|x| x.agent_id == "aaa111").unwrap();
        assert_eq!(a.meta.as_ref().unwrap()["toolUseId"], "toolu_01A");
        assert!(a
            .jsonl_path
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("subagents/agent-aaa111.jsonl"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_jsonl_without_meta() {
        let root = temp_root();
        let parent = root.join("p");
        let sub = parent.join("subagents");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("agent-orphan1.jsonl"), "{}\n").unwrap();
        let arts = list_subagent_artifacts(&parent);
        assert_eq!(arts.len(), 1);
        assert_eq!(arts[0].agent_id, "orphan1");
        assert!(arts[0].meta.is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn link_three_explore() {
        let root = temp_root();
        let parent = root.join("parent-sess");
        let sub = parent.join("subagents");
        fs::create_dir_all(&sub).unwrap();
        write_agent(
            &sub,
            "aaa111",
            &json!({
                "agentType": "Explore",
                "description": "Explore template.html",
                "toolUseId": "toolu_01A",
                "spawnDepth": 1
            }),
        );
        write_agent(
            &sub,
            "bbb222",
            &json!({
                "agentType": "Explore",
                "description": "Explore build.mjs",
                "toolUseId": "toolu_01B",
                "spawnDepth": 1
            }),
        );
        write_agent(
            &sub,
            "ccc333",
            &json!({
                "agentType": "Explore",
                "description": "Explore client-core",
                "toolUseId": "toolu_01C",
                "spawnDepth": 1
            }),
        );
        let arts = list_subagent_artifacts(&parent);
        let tool_uses = vec![
            json!({ "tool_id": "toolu_01A", "description": "Explore template.html" }),
            json!({ "tool_id": "toolu_01B", "description": "Explore build.mjs" }),
            json!({ "tool_id": "toolu_01C", "description": "Explore client-core" }),
        ];
        let refs = link_spawns(&tool_uses, &arts);
        assert_eq!(refs.len(), 3);
        assert!(refs.iter().all(|r| r["linked"] == true));
        assert!(refs.iter().all(|r| r["agent_type"] == "Explore"));
        assert_eq!(
            refs.iter()
                .find(|r| r["tool_use_id"] == "toolu_01A")
                .unwrap()["agent_id"],
            "aaa111"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stub_refs() {
        let stubs = stub_refs_from_artifacts(&[
            SubagentArtifact {
                agent_id: "aaa".into(),
                meta_path: None,
                jsonl_path: PathBuf::from("/x/agent-aaa.jsonl"),
                meta: Some(json!({
                    "agentType": "Explore",
                    "description": "Explore template",
                    "toolUseId": "toolu_A",
                    "spawnDepth": 1
                })),
            },
            SubagentArtifact {
                agent_id: "orphan".into(),
                meta_path: None,
                jsonl_path: PathBuf::from("/x/agent-orphan.jsonl"),
                meta: None,
            },
        ]);
        assert_eq!(stubs[0]["linked"], true);
        assert_eq!(stubs[0]["tool_use_id"], "toolu_A");
        assert!(stubs[0].get("jsonl_path").is_none());
        assert_eq!(stubs[1]["linked"], false);
        assert!(stubs[1]["tool_use_id"].is_null());
    }

    #[test]
    fn link_orphan_and_unmatched() {
        let root = temp_root();
        let parent = root.join("p");
        let sub = parent.join("subagents");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("agent-orphan1.jsonl"), "{}\n").unwrap();
        write_agent(
            &sub,
            "linked1",
            &json!({
                "agentType": "general-purpose",
                "description": "do stuff",
                "toolUseId": "toolu_X",
                "spawnDepth": 1
            }),
        );
        let arts = list_subagent_artifacts(&parent);
        let refs = link_spawns(
            &[
                json!({ "tool_id": "toolu_X", "description": "do stuff" }),
                json!({ "tool_id": "toolu_UNMATCHED", "description": "ghost" }),
            ],
            &arts,
        );
        let linked: Vec<_> = refs.iter().filter(|r| r["linked"] == true).collect();
        let unlinked: Vec<_> = refs.iter().filter(|r| r["linked"] == false).collect();
        assert_eq!(linked.len(), 1);
        assert_eq!(linked[0]["agent_id"], "linked1");
        assert!(!unlinked.is_empty());
        assert!(unlinked.iter().any(|r| {
            r["agent_id"] == "orphan1" || r["tool_use_id"] == "toolu_UNMATCHED"
        }));
        let _ = fs::remove_dir_all(&root);
    }
}
