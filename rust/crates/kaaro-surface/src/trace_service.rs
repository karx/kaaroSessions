//! `/api/trace` production path — port of `surface/trace-service.mjs`
//! (mtime cache + CC subagent nesting).

use kaaro_core::registry::get_harness;
use kaaro_core::session_locators::resolve_session_file;
use kaaro_core::trace_tree::child_tree_key;
use kaaro_core::{
    agent_id_from_sidechain_log, link_spawns, list_subagent_artifacts, read_session_records,
    reconstruct_trace_from_nrs, subagent_scan_dir_from_log,
};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

const DEFAULT_MAX_SUBAGENT_DEPTH: u32 = 2;

struct CacheEntry {
    fingerprint: String,
    tree: Value,
}

#[derive(Debug, Clone)]
struct ResolveEntry {
    file_path: PathBuf,
    project_id: Option<String>,
    session_id: String,
    harness: &'static str,
}

/// mtime-cached trace builder with optional CC subagent nesting.
pub struct TraceService {
    cache: Mutex<HashMap<String, CacheEntry>>,
    resolve_cache: Mutex<HashMap<String, ResolveEntry>>,
    roots: Mutex<HashMap<String, PathBuf>>,
}

#[derive(Clone)]
struct BuildOpts {
    max_subagent_depth: u32,
    depth: u32,
    visited: HashSet<PathBuf>,
}

impl Default for BuildOpts {
    fn default() -> Self {
        Self {
            max_subagent_depth: DEFAULT_MAX_SUBAGENT_DEPTH,
            depth: 0,
            visited: HashSet::new(),
        }
    }
}

impl TraceService {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            resolve_cache: Mutex::new(HashMap::new()),
            roots: Mutex::new(HashMap::new()),
        }
    }

    pub fn set_root(&self, harness_id: &str, root: PathBuf) {
        self.roots
            .lock()
            .expect("roots")
            .insert(harness_id.to_string(), root);
    }

    pub fn set_roots_from_overrides(&self, o: &kaaro_core::RootOverrides) {
        use kaaro_core::harness_paths;
        let pairs = [
            ("claude-code", o.claude_code.clone().unwrap_or_else(harness_paths::claude_projects_root)),
            ("codex", o.codex.clone().unwrap_or_else(harness_paths::codex_home_root)),
            ("pi", o.pi.clone().unwrap_or_else(harness_paths::pi_sessions_root)),
            ("antigravity", o.antigravity.clone().unwrap_or_else(harness_paths::antigravity_brain_root)),
            ("grok", o.grok.clone().unwrap_or_else(harness_paths::grok_sessions_root)),
            ("opencode", o.opencode.clone().unwrap_or_else(harness_paths::opencode_storage_root)),
            ("copilot", o.copilot.clone().unwrap_or_else(harness_paths::copilot_workspace_storage_root)),
            ("command-code", o.command_code.clone().unwrap_or_else(harness_paths::command_code_projects_root)),
        ];
        let mut roots = self.roots.lock().expect("roots");
        for (id, path) in pairs {
            roots.insert(id.to_string(), path);
        }
    }

    /// Resolve session id across harness roots (in-memory cache).
    pub fn resolve(
        &self,
        session_id: &str,
        harness_filter: Option<&str>,
    ) -> Option<(PathBuf, Option<String>, String, &'static str)> {
        if harness_filter.is_none() {
            if let Some(ent) = self.resolve_cache.lock().expect("resolve").get(session_id) {
                return Some((
                    ent.file_path.clone(),
                    ent.project_id.clone(),
                    ent.session_id.clone(),
                    ent.harness,
                ));
            }
        }
        let roots_map = self.roots.lock().expect("roots").clone();
        let (hit, harness) = resolve_session_file(session_id, harness_filter, &|hid| {
            roots_map.get(hid).cloned()
        })?;
        let entry = ResolveEntry {
            file_path: hit.file_path.clone(),
            project_id: hit.project_id.clone(),
            session_id: hit.session_id.clone(),
            harness,
        };
        self.resolve_cache
            .lock()
            .expect("resolve")
            .insert(session_id.to_string(), entry.clone());
        // Also cache under resolved id (slug expand).
        if hit.session_id != session_id {
            self.resolve_cache
                .lock()
                .expect("resolve")
                .insert(hit.session_id.clone(), entry.clone());
        }
        Some((
            hit.file_path,
            hit.project_id,
            hit.session_id,
            harness,
        ))
    }

    /// Invalidate resolve + tree caches for one session (or all when `None`).
    /// Called from the watch path so `/api/trace/:id` re-resolves after jsonl changes.
    pub fn invalidate_session(&self, session_id: Option<&str>) {
        match session_id {
            Some(sid) if !sid.is_empty() => {
                let mut resolve = self.resolve_cache.lock().expect("resolve");
                let paths: Vec<PathBuf> = resolve
                    .iter()
                    .filter(|(k, v)| k.as_str() == sid || v.session_id == sid)
                    .map(|(_, v)| v.file_path.clone())
                    .collect();
                resolve.retain(|k, v| k.as_str() != sid && v.session_id != sid);
                drop(resolve);
                let mut cache = self.cache.lock().expect("cache");
                for path in paths {
                    let key = std::fs::canonicalize(&path)
                        .unwrap_or(path)
                        .to_string_lossy()
                        .into_owned();
                    cache.remove(&key);
                }
            }
            _ => {
                self.resolve_cache.lock().expect("resolve").clear();
                self.cache.lock().expect("cache").clear();
            }
        }
    }

    /// Build (or return cached) ContextTree for a session file.
    pub fn build_trace(
        &self,
        file_path: &Path,
        project_id: Option<&str>,
        session_id: &str,
        harness_id: &str,
    ) -> Option<Value> {
        self.build_trace_inner(
            file_path,
            project_id,
            session_id,
            harness_id,
            BuildOpts::default(),
        )
    }

    fn build_trace_inner(
        &self,
        file_path: &Path,
        project_id: Option<&str>,
        session_id: &str,
        harness_id: &str,
        mut opts: BuildOpts,
    ) -> Option<Value> {
        let harness = get_harness(harness_id)?;
        if !harness.capabilities.trace {
            return None;
        }

        let abs = std::fs::canonicalize(file_path).unwrap_or_else(|_| file_path.to_path_buf());
        if opts.visited.contains(&abs) {
            return None;
        }
        opts.visited.insert(abs.clone());

        let self_agent_id = agent_id_from_sidechain_log(file_path);
        let mut artifacts = if harness.capabilities.subagent_tree {
            let scan = subagent_scan_dir_from_log(file_path);
            let mut arts = list_subagent_artifacts(&scan);
            if let Some(ref sid) = self_agent_id {
                arts.retain(|a| &a.agent_id != sid);
            }
            arts
        } else {
            vec![]
        };

        let mut watch_paths: Vec<PathBuf> = vec![file_path.to_path_buf()];
        for a in &artifacts {
            watch_paths.push(a.jsonl_path.clone());
            if let Some(ref m) = a.meta_path {
                watch_paths.push(m.clone());
            }
        }
        let watch_refs: Vec<&Path> = watch_paths.iter().map(|p| p.as_path()).collect();
        let fp = fingerprint(&watch_refs);

        if opts.depth == 0 {
            let cache = self.cache.lock().expect("cache");
            let key = abs.to_string_lossy().into_owned();
            if let Some(ent) = cache.get(&key) {
                if ent.fingerprint == fp {
                    return Some(ent.tree.clone());
                }
            }
        }

        let session = read_session_records(harness_id, file_path).ok()?;
        let nrs = (harness.adapter)(&session.records);

        let mut recon = session.trace_opts.clone();

        if harness.capabilities.subagent_tree {
            let agent_tool_uses: Vec<Value> = nrs
                .iter()
                .filter(|nr| {
                    nr.get("kind").and_then(|v| v.as_str()) == Some("tool_use")
                        && matches!(
                            nr.get("tool").and_then(|v| v.as_str()),
                            Some("Agent") | Some("Task")
                        )
                })
                .map(|nr| {
                    let desc = nr
                        .pointer("/input/description")
                        .or_else(|| nr.pointer("/input/prompt"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    json!({
                        "tool_id": nr.get("tool_id").cloned().unwrap_or(Value::Null),
                        "description": desc,
                    })
                })
                .collect();

            let mut spawns = link_spawns(&agent_tool_uses, &artifacts);
            if self_agent_id.is_some() {
                spawns.retain(|s| {
                    s.get("linked").and_then(|v| v.as_bool()).unwrap_or(false)
                        && s.get("agent_id").and_then(|v| v.as_str()).is_some()
                });
            }

            let mut child_trees = Map::new();
            if opts.depth < opts.max_subagent_depth {
                for s in &spawns {
                    let Some(jsonl) = s.get("jsonl_path").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    let child_path = PathBuf::from(jsonl);
                    if !child_path.exists() {
                        continue;
                    }
                    let child_abs =
                        std::fs::canonicalize(&child_path).unwrap_or_else(|_| child_path.clone());
                    if opts.visited.contains(&child_abs) {
                        continue;
                    }
                    let child_sid = s
                        .get("agent_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or(session_id);
                    let child_opts = BuildOpts {
                        max_subagent_depth: opts.max_subagent_depth,
                        depth: opts.depth + 1,
                        visited: opts.visited.clone(),
                    };
                    if let Some(child) = self.build_trace_inner(
                        &child_path,
                        project_id,
                        child_sid,
                        harness_id,
                        child_opts,
                    ) {
                        if let Some(key) = child_tree_key(s) {
                            let mut slim = Map::new();
                            if let Some(t) = child.get("ai_title") {
                                slim.insert("ai_title".into(), t.clone());
                            }
                            if let Some(segs) = child.get("segments") {
                                slim.insert("segments".into(), segs.clone());
                            }
                            if let Some(subs) = child.get("subagents") {
                                slim.insert("subagents".into(), subs.clone());
                            }
                            child_trees.insert(key, Value::Object(slim));
                        }
                    }
                }
            }

            recon.spawns = Some(spawns);
            if !child_trees.is_empty() {
                recon.child_trees = Some(child_trees);
            }
        }

        let mut tree = reconstruct_trace_from_nrs(&nrs, &recon);
        if let Some(obj) = tree.as_object_mut() {
            obj.insert("session_id".into(), json!(session_id));
            obj.insert(
                "project_id".into(),
                match project_id {
                    Some(p) => json!(p),
                    None => Value::Null,
                },
            );
        }

        if opts.depth == 0 {
            self.cache.lock().expect("cache").insert(
                abs.to_string_lossy().into_owned(),
                CacheEntry {
                    fingerprint: fp,
                    tree: tree.clone(),
                },
            );
        }
        // silence unused after move of artifacts list
        let _ = &mut artifacts;
        Some(tree)
    }

    /// Resolve + build in one step.
    pub fn trace_for_session(&self, session_id: &str) -> Result<Value, TraceError> {
        let Some((path, project_id, resolved_id, harness)) = self.resolve(session_id, None) else {
            return Err(TraceError::NotFound);
        };
        let Some(h) = get_harness(harness) else {
            return Err(TraceError::NotFound);
        };
        if !h.capabilities.trace {
            return Err(TraceError::Unsupported);
        }
        self.build_trace(&path, project_id.as_deref(), &resolved_id, harness)
            .ok_or(TraceError::Failed)
    }
}

impl Default for TraceService {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraceError {
    NotFound,
    Unsupported,
    Failed,
}

fn fingerprint(paths: &[&Path]) -> String {
    paths
        .iter()
        .map(|p| {
            let mtime = std::fs::metadata(p)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            format!("{}:{}", p.display(), mtime)
        })
        .collect::<Vec<_>>()
        .join("|")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, SystemTime};

    fn write_cc_parent_with_agent(root: &Path, sid: &str, tool_id: &str, agent_id: &str) {
        let proj = root.join("proj");
        fs::create_dir_all(&proj).unwrap();
        let parent = proj.join(format!("{sid}.jsonl"));
        // Parent spawns Agent
        let parent_body = format!(
            r#"{{"type":"user","timestamp":"2026-05-01T10:00:00Z","message":{{"content":"plan layout"}}}}
{{"type":"assistant","timestamp":"2026-05-01T10:01:00Z","message":{{"model":"x","stop_reason":"tool_use","usage":{{"input_tokens":1,"output_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"content":[{{"type":"tool_use","id":"{tool_id}","name":"Agent","input":{{"description":"Explore template.html","subagent_type":"Explore"}}}}]}}}}
"#
        );
        fs::write(&parent, parent_body).unwrap();

        let sub = proj.join(sid).join("subagents");
        fs::create_dir_all(&sub).unwrap();
        let meta = json!({
            "agentType": "Explore",
            "description": "Explore template.html",
            "toolUseId": tool_id,
            "spawnDepth": 1
        });
        fs::write(
            sub.join(format!("agent-{agent_id}.meta.json")),
            serde_json::to_string(&meta).unwrap(),
        )
        .unwrap();
        let child_body = r#"{"type":"user","timestamp":"2026-05-01T10:02:00Z","message":{"content":"child prompt"}}
{"type":"assistant","timestamp":"2026-05-01T10:03:00Z","message":{"model":"x","stop_reason":"end_turn","usage":{"input_tokens":0,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"content":[{"type":"text","text":"child done"}]}}
"#;
        fs::write(sub.join(format!("agent-{agent_id}.jsonl")), child_body).unwrap();
    }

    #[test]
    fn mtime_cache_and_cc_trace() {
        let dir = std::env::temp_dir().join(format!(
            "kaaro-trace-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let proj = dir.join("proj");
        fs::create_dir_all(&proj).unwrap();
        let sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let file = proj.join(format!("{sid}.jsonl"));
        let line = r#"{"type":"user","timestamp":"2026-05-01T10:00:00Z","message":{"content":"hello world prompt"}}"#;
        let line2 = r#"{"type":"assistant","timestamp":"2026-05-01T10:01:00Z","message":{"model":"x","stop_reason":"end_turn","usage":{"input_tokens":0,"output_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"content":[]}}"#;
        fs::write(&file, format!("{line}\n{line2}\n")).unwrap();

        let svc = TraceService::new();
        svc.set_root("claude-code", dir.clone());

        let tree = svc.trace_for_session(sid).expect("tree");
        assert_eq!(tree["session_id"], sid);
        assert_eq!(tree["segments"].as_array().unwrap().len(), 1);
        assert_eq!(tree["segments"][0]["user_turns"], 1);

        let tree2 = svc.trace_for_session(sid).unwrap();
        assert_eq!(tree2["segments"][0]["user_turns"], 1);

        std::thread::sleep(Duration::from_millis(20));
        let line3 = r#"{"type":"user","timestamp":"2026-05-01T10:02:00Z","message":{"content":"second"}}"#;
        fs::write(&file, format!("{line}\n{line2}\n{line3}\n")).unwrap();
        let tree3 = svc.trace_for_session(sid).unwrap();
        assert_eq!(tree3["segments"][0]["user_turns"], 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nests_cc_subagent_tree() {
        let dir = std::env::temp_dir().join(format!(
            "kaaro-trace-nest-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let sid = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
        write_cc_parent_with_agent(&dir, sid, "toolu_01A", "aaa111");

        let svc = TraceService::new();
        svc.set_root("claude-code", dir.clone());
        let tree = svc.trace_for_session(sid).expect("tree");

        assert_eq!(tree["segments"][0]["subagent_count"], 1);
        let subs = tree["subagents"].as_array().expect("subagents");
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0]["agent_id"], "aaa111");
        assert_eq!(subs[0]["linked"], true);
        assert!(subs[0].get("jsonl_path").is_none(), "FS path stripped");
        let nested = &subs[0]["tree"];
        assert!(nested.is_object());
        assert_eq!(nested["segments"][0]["user_turns"], 1);
        assert_eq!(nested["segments"][0]["assistant_turns"], 1);

        let asst = tree["segments"][0]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["role"] == "assistant")
            .unwrap();
        assert_eq!(asst["spawned_subagents"][0]["agent_id"], "aaa111");
        assert!(asst["spawned_subagents"][0]["tree"].is_object());

        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn invalidate_clears_resolve_cache() {
        let dir = std::env::temp_dir().join(format!(
            "kaaro-trace-inv-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let proj = dir.join("proj");
        fs::create_dir_all(&proj).unwrap();
        let sid = "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee";
        let file = proj.join(format!("{sid}.jsonl"));
        fs::write(
            &file,
            r#"{"type":"user","timestamp":"2026-05-01T10:00:00Z","message":{"content":"hi"}}
"#,
        )
        .unwrap();
        let svc = TraceService::new();
        svc.set_root("claude-code", dir.clone());
        let (p1, _, _, _) = svc.resolve(sid, None).unwrap();
        assert_eq!(p1, file);
        // Cached
        let (p2, _, _, _) = svc.resolve(sid, None).unwrap();
        assert_eq!(p2, file);
        svc.invalidate_session(Some(sid));
        // Still resolves after invalidate (re-walk), and tree cache cleared.
        let tree = svc.trace_for_session(sid).unwrap();
        assert_eq!(tree["session_id"], sid);
        let _ = fs::remove_dir_all(&dir);
    }

}
