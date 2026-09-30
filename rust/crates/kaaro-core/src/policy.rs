//! Policy file loader + merge — port of `hooks/policy.mjs` (W-POL-01).
//!
//! Loads `.agents/policy.json` (project) and `~/.agents/policy.json` (global);
//! project rules prepend global. Loading never panics: absent/malformed → None.

use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// Read + validate one policy file. Absent / malformed / invalid → None.
pub fn load_policy_file(file_path: &Path) -> Option<Value> {
    if !file_path.exists() {
        return None;
    }
    let raw = match fs::read_to_string(file_path) {
        Ok(s) => s,
        Err(err) => {
            eprintln!(
                "policy {} unreadable — ignoring: {err}",
                file_path.display()
            );
            return None;
        }
    };
    // Strip UTF-8 BOM (Windows editors / PowerShell).
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
    let obj: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(err) => {
            eprintln!(
                "policy {} unreadable — ignoring: {err}",
                file_path.display()
            );
            return None;
        }
    };
    if let Some(rules) = obj.get("rules") {
        if !rules.is_array() {
            eprintln!(
                "policy {} invalid — rules must be an array; ignoring",
                file_path.display()
            );
            return None;
        }
    }
    Some(obj)
}

/// Merge project policy over global: project rules prepend, anomaly keys override.
pub fn merge_policies(project: Option<&Value>, global: Option<&Value>) -> Option<Value> {
    match (project, global) {
        (None, None) => None,
        (Some(p), None) => Some(p.clone()),
        (None, Some(g)) => Some(g.clone()),
        (Some(p), Some(g)) => {
            let mut out = Map::new();
            if let Some(obj) = g.as_object() {
                for (k, v) in obj {
                    out.insert(k.clone(), v.clone());
                }
            }
            if let Some(obj) = p.as_object() {
                for (k, v) in obj {
                    if k == "rules" || k == "builtin_anomalies" {
                        continue;
                    }
                    out.insert(k.clone(), v.clone());
                }
            }
            let mut rules = Vec::new();
            if let Some(arr) = p.get("rules").and_then(|v| v.as_array()) {
                rules.extend(arr.iter().cloned());
            }
            if let Some(arr) = g.get("rules").and_then(|v| v.as_array()) {
                rules.extend(arr.iter().cloned());
            }
            out.insert("rules".into(), Value::Array(rules));

            let mut anomalies = Map::new();
            if let Some(obj) = g.get("builtin_anomalies").and_then(|v| v.as_object()) {
                for (k, v) in obj {
                    anomalies.insert(k.clone(), v.clone());
                }
            }
            if let Some(obj) = p.get("builtin_anomalies").and_then(|v| v.as_object()) {
                for (k, v) in obj {
                    anomalies.insert(k.clone(), v.clone());
                }
            }
            out.insert("builtin_anomalies".into(), Value::Object(anomalies));
            Some(Value::Object(out))
        }
    }
}

/// Load and merge project + global policy. Both absent → None.
pub fn load_policy(project_dir: &Path, home_dir: &Path) -> Option<Value> {
    let project = load_policy_file(&project_dir.join(".agents").join("policy.json"));
    let global = load_policy_file(&home_dir.join(".agents").join("policy.json"));
    merge_policies(project.as_ref(), global.as_ref())
}

/// Default home directory for policy load.
pub fn default_home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_root() -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("kaaro-policy-{n}"));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_json(root: &Path, rel: &str, obj: &Value) -> PathBuf {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, serde_json::to_string(obj).unwrap()).unwrap();
        p
    }

    fn rule_a() -> Value {
        json!({
            "id": "no-bash-in-viz",
            "match": { "skill": "visualize-seed", "tool": "Bash" },
            "signal": "WARN",
            "reason": "no bash"
        })
    }
    fn rule_b() -> Value {
        json!({
            "id": "slow-session",
            "match": { "duration_min.gt": 60 },
            "signal": "INFO",
            "reason": "long session"
        })
    }

    #[test]
    fn load_valid_policy() {
        let root = tmp_root();
        let p = write_json(
            &root,
            "valid/policy.json",
            &json!({ "version": "1", "default": "allow", "rules": [rule_a()] }),
        );
        let policy = load_policy_file(&p).unwrap();
        assert_eq!(policy["version"], "1");
        assert_eq!(policy["rules"][0]["id"], "no-bash-in-viz");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn absent_file_is_none() {
        let root = tmp_root();
        assert!(load_policy_file(&root.join("nope/policy.json")).is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn tolerates_utf8_bom() {
        let root = tmp_root();
        let p = root.join("bom/policy.json");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        let body = format!(
            "\u{feff}{}",
            serde_json::to_string(&json!({ "version": "1", "rules": [rule_a()] })).unwrap()
        );
        fs::write(&p, body).unwrap();
        let policy = load_policy_file(&p).expect("BOM policy");
        assert_eq!(policy["rules"][0]["id"], "no-bash-in-viz");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn malformed_json_is_none() {
        let root = tmp_root();
        let p = root.join("bad/policy.json");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, "{ not json !!").unwrap();
        assert!(load_policy_file(&p).is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rules_not_array_is_none() {
        let root = tmp_root();
        let p = write_json(
            &root,
            "shape/policy.json",
            &json!({ "version": "1", "rules": { "a": 1 } }),
        );
        assert!(load_policy_file(&p).is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_project_rules_prepend() {
        let merged = merge_policies(
            Some(&json!({ "version": "1", "rules": [rule_a()] })),
            Some(&json!({ "version": "1", "rules": [rule_b()] })),
        )
        .unwrap();
        let ids: Vec<_> = merged["rules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["no-bash-in-viz", "slow-session"]);
    }

    #[test]
    fn merge_either_null() {
        let proj = json!({ "version": "1", "rules": [rule_a()] });
        assert_eq!(
            merge_policies(Some(&proj), None).unwrap()["rules"][0]["id"],
            "no-bash-in-viz"
        );
        assert_eq!(
            merge_policies(None, Some(&proj)).unwrap()["rules"][0]["id"],
            "no-bash-in-viz"
        );
        assert!(merge_policies(None, None).is_none());
    }

    #[test]
    fn merge_builtin_anomalies_override() {
        let merged = merge_policies(
            Some(&json!({
                "version": "1",
                "rules": [],
                "builtin_anomalies": {
                    "high_error_rate": { "threshold": 0.5, "signal": "ALERT" }
                }
            })),
            Some(&json!({
                "version": "1",
                "rules": [],
                "builtin_anomalies": {
                    "high_error_rate": { "threshold": 0.3, "signal": "WARN" },
                    "repeated_compaction": { "threshold": 2, "signal": "WARN" }
                }
            })),
        )
        .unwrap();
        assert_eq!(merged["builtin_anomalies"]["high_error_rate"]["threshold"], 0.5);
        assert_eq!(merged["builtin_anomalies"]["high_error_rate"]["signal"], "ALERT");
        assert_eq!(
            merged["builtin_anomalies"]["repeated_compaction"]["threshold"],
            2
        );
    }

    #[test]
    fn load_policy_merges_dirs() {
        let root = tmp_root();
        let project_dir = root.join("proj");
        let home_dir = root.join("home");
        write_json(
            &root,
            "proj/.agents/policy.json",
            &json!({ "version": "1", "rules": [rule_a()] }),
        );
        write_json(
            &root,
            "home/.agents/policy.json",
            &json!({ "version": "1", "rules": [rule_b()] }),
        );
        let policy = load_policy(&project_dir, &home_dir).unwrap();
        let ids: Vec<_> = policy["rules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["no-bash-in-viz", "slow-session"]);
        assert!(load_policy(&root.join("x"), &root.join("y")).is_none());
        let _ = fs::remove_dir_all(&root);
    }
}
