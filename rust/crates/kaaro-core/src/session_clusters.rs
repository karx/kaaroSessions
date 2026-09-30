//! Deterministic session clustering — port of `experience/session-clusters.mjs`.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

pub const CLUSTER_THRESHOLD: f64 = 0.35;
pub const MIN_CLUSTER_SIZE: usize = 2;
const FILE_WEIGHT: f64 = 0.7;
const TEXT_WEIGHT: f64 = 0.3;

fn stopwords() -> HashSet<&'static str> {
    [
        "the", "and", "for", "with", "this", "that", "from", "into", "are", "was", "were", "you",
        "not", "can", "will", "have", "has", "had", "its", "our", "your", "all", "use", "when",
        "then",
    ]
    .into_iter()
    .collect()
}

fn str_opt<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

pub fn tokenize_session_text(sess: &Value) -> BTreeSet<String> {
    let stops = stopwords();
    let mut parts: Vec<&str> = Vec::new();
    if let Some(t) = str_opt(sess, "ai_title") {
        parts.push(t);
    }
    if let Some(t) = str_opt(sess, "first_user_message") {
        parts.push(t);
    }
    if let Some(skills) = sess.get("skills").and_then(|v| v.as_array()) {
        for s in skills {
            if let Some(t) = s.as_str() {
                parts.push(t);
            }
        }
    }
    let raw = parts.join(" ").to_lowercase();
    raw.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| t.len() >= 3 && !stops.contains(t))
        .map(|t| t.to_string())
        .collect()
}

pub fn jaccard(a: &BTreeSet<String>, b: &BTreeSet<String>) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count() as f64;
    let uni = (a.len() + b.len()) as f64 - inter;
    inter / uni
}

fn file_set(sess: &Value) -> BTreeSet<String> {
    sess.get("file_ops")
        .and_then(|v| v.as_object())
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

pub fn session_similarity(a: &Value, b: &Value) -> f64 {
    let fa = file_set(a);
    let fb = file_set(b);
    let text_j = jaccard(&tokenize_session_text(a), &tokenize_session_text(b));
    if fa.is_empty() && fb.is_empty() {
        return text_j;
    }
    FILE_WEIGHT * jaccard(&fa, &fb) + TEXT_WEIGHT * text_j
}

fn by_time_then_id(a: &Value, b: &Value) -> std::cmp::Ordering {
    let ta = str_opt(a, "first_timestamp").unwrap_or("");
    let tb = str_opt(b, "first_timestamp").unwrap_or("");
    ta.cmp(tb).then_with(|| {
        let ia = str_opt(a, "session_id").unwrap_or("");
        let ib = str_opt(b, "session_id").unwrap_or("");
        ia.cmp(ib)
    })
}

fn top_by_freq(freq: &HashMap<String, usize>) -> Vec<(String, usize)> {
    let mut v: Vec<_> = freq.iter().map(|(k, n)| (k.clone(), *n)).collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    v
}

pub fn auto_label(members: &[&Value]) -> String {
    let mut token_freq: HashMap<String, usize> = HashMap::new();
    for m in members {
        for t in tokenize_session_text(m) {
            *token_freq.entry(t).or_insert(0) += 1;
        }
    }
    let shared: Vec<_> = top_by_freq(&token_freq)
        .into_iter()
        .filter(|(_, n)| *n >= 2)
        .take(2)
        .collect();
    if !shared.is_empty() {
        return shared
            .iter()
            .map(|(t, _)| t.as_str())
            .collect::<Vec<_>>()
            .join(" ");
    }

    let mut file_freq: HashMap<String, usize> = HashMap::new();
    for m in members {
        for p in file_set(m) {
            *file_freq.entry(p).or_insert(0) += 1;
        }
    }
    if let Some((path, _)) = top_by_freq(&file_freq).into_iter().next() {
        return if let Some((dir, _)) = path.split_once('/') {
            dir.to_string()
        } else {
            path
        };
    }

    let mut sorted: Vec<&Value> = members.to_vec();
    sorted.sort_by(|a, b| by_time_then_id(a, b));
    if let Some(branch) = sorted.first().and_then(|s| str_opt(s, "git_branch")) {
        return branch.to_string();
    }
    format!("bundle x{}", members.len())
}

#[derive(Debug, Clone, PartialEq)]
pub struct Cluster {
    pub id: String,
    pub project_id: String,
    pub label: String,
    pub member_ids: Vec<String>,
    pub manual: bool,
    pub label_overridden: bool,
}

pub fn cluster_sessions(
    sessions: &[&Value],
    threshold: f64,
    min_cluster_size: usize,
) -> Vec<Cluster> {
    let mut by_project: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for s in sessions {
        let pid = str_opt(s, "project_id").unwrap_or("").to_string();
        by_project.entry(pid).or_default().push(*s);
    }

    let mut clusters = Vec::new();
    for (project_id, mut group) in by_project {
        group.sort_by(|a, b| by_time_then_id(a, b));
        let n = group.len();
        let mut parent: Vec<usize> = (0..n).collect();
        fn find(parent: &mut [usize], i: usize) -> usize {
            if parent[i] != i {
                parent[i] = find(parent, parent[i]);
            }
            parent[i]
        }
        for i in 0..n {
            for j in (i + 1)..n {
                if session_similarity(group[i], group[j]) >= threshold {
                    let ri = find(&mut parent, i);
                    let rj = find(&mut parent, j);
                    parent[rj] = ri;
                }
            }
        }
        let mut components: BTreeMap<usize, Vec<&Value>> = BTreeMap::new();
        for (i, s) in group.iter().enumerate() {
            let root = find(&mut parent, i);
            components.entry(root).or_default().push(*s);
        }
        for members in components.values() {
            if members.len() < min_cluster_size {
                continue;
            }
            let anchor_id = str_opt(members[0], "session_id").unwrap_or("").to_string();
            clusters.push(Cluster {
                id: format!("cluster:{project_id}:{anchor_id}"),
                project_id: project_id.clone(),
                label: auto_label(members),
                member_ids: members
                    .iter()
                    .filter_map(|m| str_opt(m, "session_id").map(|s| s.to_string()))
                    .collect(),
                manual: false,
                label_overridden: false,
            });
        }
    }
    clusters.sort_by(|a, b| a.id.cmp(&b.id));
    clusters
}

fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Apply editorial overrides then auto-cluster (JS `buildClusters`).
pub fn build_clusters(sessions: &[&Value], overrides: Option<&Value>) -> Vec<Cluster> {
    let projects = overrides
        .and_then(|o| o.get("projects"))
        .and_then(|v| v.as_object());

    let mut pinned: HashSet<String> = HashSet::new();
    let mut assigned_to: HashMap<String, String> = HashMap::new();
    if let Some(projs) = projects {
        for (pid, proj) in projs {
            if let Some(pins) = proj.get("pin").and_then(|v| v.as_array()) {
                for sid in pins.iter().filter_map(|v| v.as_str()) {
                    pinned.insert(format!("{pid} {sid}"));
                }
            }
            if let Some(assign) = proj.get("assign").and_then(|v| v.as_object()) {
                for (sid, name) in assign {
                    if let Some(n) = name.as_str() {
                        assigned_to.insert(format!("{pid} {sid}"), n.to_string());
                    }
                }
            }
        }
    }

    let mut auto_pool: Vec<&Value> = Vec::new();
    let mut manual_groups: BTreeMap<String, BTreeMap<String, Vec<&Value>>> = BTreeMap::new();
    for s in sessions {
        let pid = str_opt(s, "project_id").unwrap_or("");
        let sid = str_opt(s, "session_id").unwrap_or("");
        let key = format!("{pid} {sid}");
        if pinned.contains(&key) {
            continue;
        }
        if let Some(name) = assigned_to.get(&key) {
            manual_groups
                .entry(pid.to_string())
                .or_default()
                .entry(name.clone())
                .or_default()
                .push(*s);
        } else {
            auto_pool.push(*s);
        }
    }

    let mut clusters = cluster_sessions(&auto_pool, CLUSTER_THRESHOLD, MIN_CLUSTER_SIZE);

    for (project_id, by_name) in manual_groups {
        for (name, mut members) in by_name {
            members.sort_by(|a, b| by_time_then_id(a, b));
            clusters.push(Cluster {
                id: format!("cluster:{project_id}:manual:{}", slugify(&name)),
                project_id: project_id.clone(),
                label: name,
                member_ids: members
                    .iter()
                    .filter_map(|m| str_opt(m, "session_id").map(|s| s.to_string()))
                    .collect(),
                manual: true,
                label_overridden: false,
            });
        }
    }

    if let Some(projs) = projects {
        for c in &mut clusters {
            if let Some(rename) = projs
                .get(&c.project_id)
                .and_then(|p| p.get("labels"))
                .and_then(|l| l.get(&c.id))
                .and_then(|v| v.as_str())
            {
                c.label = rename.to_string();
                c.label_overridden = true;
            }
        }
    }

    clusters.sort_by(|a, b| a.id.cmp(&b.id));
    clusters
}
