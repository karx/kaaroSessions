//! Pure graph helpers — port of `experience/graph-data.mjs`.

use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const MAX_AGE_MS: i64 = 2 * 24 * 3600 * 1000;
pub const IN_FLIGHT_COLOR: &str = "#00ffcc";
pub const IN_FLIGHT_THRESHOLD_MS: i64 = 2 * 60 * 1000;

pub const PALETTE: &[&str] = &[
    "#00aaff", "#ff4488", "#cc44ff", "#ff8800", "#00ff88", "#ffcc00", "#00cccc", "#ff6666",
    "#44ffaa", "#ff88cc", "#8844ff", "#88ccff",
];

/// Extension → color map (JS `EXT_COLORS`).
pub fn ext_color(ext: &str) -> &'static str {
    match ext {
        "mjs" => "#00cccc",
        "js" => "#00aaff",
        "ts" => "#6688ff",
        "svelte" => "#ff8844",
        "json" => "#ffcc00",
        "md" => "#cc44ff",
        "html" => "#ff4488",
        "css" => "#33ee88",
        "py" => "#88cc44",
        "txt" => "#888888",
        "sh" => "#44ffaa",
        _ => "#666666",
    }
}

/// Parse ISO-8601 timestamps used in sessions-data (`…Z` with optional fractional seconds).
pub fn parse_iso_ms(ts: &str) -> Option<i64> {
    let s = ts.trim();
    let s = s.strip_suffix('Z').unwrap_or(s);
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-');
    let y: i64 = d.next()?.parse().ok()?;
    let mo: i64 = d.next()?.parse().ok()?;
    let day: i64 = d.next()?.parse().ok()?;
    let (hms, frac) = match time.split_once('.') {
        Some((hms, frac)) => (hms, Some(frac)),
        None => (time, None),
    };
    let mut t = hms.split(':');
    let h: i64 = t.next()?.parse().ok()?;
    let mi: i64 = t.next()?.parse().ok()?;
    let sec: i64 = t.next()?.parse().ok()?;
    let mut ms: i64 = 0;
    if let Some(f) = frac {
        let digits: String = f.chars().take(3).collect();
        let padded = format!("{digits:0<3}");
        ms = padded.parse().ok()?;
    }
    // days from civil date → unix ms (algorithm from Howard Hinnant)
    let y = if mo <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = if mo > 2 { mo - 3 } else { mo + 9 };
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86_400_000 + h * 3_600_000 + mi * 60_000 + sec * 1000 + ms)
}

pub fn calc_recency_score(ts: Option<&str>, reference_ms: i64) -> f64 {
    let Some(ts) = ts else { return 0.0 };
    let Some(t) = parse_iso_ms(ts) else { return 0.0 };
    ((1.0 - (reference_ms - t) as f64 / MAX_AGE_MS as f64).max(0.0)) as f64
}

pub fn calc_recency_level(ts: Option<&str>, reference_ms: i64) -> u8 {
    let Some(ts) = ts else { return 0 };
    let Some(t) = parse_iso_ms(ts) else { return 0 };
    let age = reference_ms - t;
    if age < 5 * 60 * 1000 {
        3
    } else if age < 15 * 60 * 1000 {
        2
    } else if age < 2 * 24 * 3600 * 1000 {
        1
    } else {
        0
    }
}

pub fn is_session_in_flight(last_timestamp: Option<&str>, reference_ms: i64) -> bool {
    let Some(ts) = last_timestamp else { return false };
    let Some(t) = parse_iso_ms(ts) else { return false };
    let age = reference_ms - t;
    age >= 0 && age < IN_FLIGHT_THRESHOLD_MS
}

/// Projects sorted alphabetically for stable colour assignment.
pub fn assign_project_colors(
    projects: &[Value],
    palette: &[&str],
) -> (BTreeMap<String, String>, BTreeMap<String, usize>) {
    let mut ids: Vec<String> = projects
        .iter()
        .filter_map(|p| p.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();
    ids.sort();
    let mut project_colors = BTreeMap::new();
    let mut color_to_index = BTreeMap::new();
    for (i, id) in ids.into_iter().enumerate() {
        let color = palette[i % palette.len()].to_string();
        color_to_index.insert(color.clone(), i);
        project_colors.insert(id, color);
    }
    (project_colors, color_to_index)
}

fn str_field<'a>(obj: &'a Value, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(|v| v.as_str())
}

fn i64_field(obj: &Value, key: &str) -> i64 {
    obj.get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .unwrap_or(0)
}

/// Build file nodes + read/write/edit edges (JS `buildFileNodesAndEdges`).
pub fn build_file_nodes_and_edges(
    global_files: &[Value],
    sess_by_id: &BTreeMap<String, Value>,
    min_sessions: usize,
    reference_ms: i64,
) -> (Vec<Value>, Vec<Value>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    if global_files.is_empty() {
        return (nodes, edges);
    }
    let max_file_w = global_files
        .iter()
        .map(|f| i64_field(f, "write") + i64_field(f, "edit"))
        .max()
        .unwrap_or(1)
        .max(1);

    for f in global_files {
        let path = match str_field(f, "path") {
            Some(p) => p,
            None => continue,
        };
        let sessions: Vec<&str> = f
            .get("sessions")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();
        if sessions.len() < min_sessions {
            continue;
        }
        let mut last_ts: Option<String> = None;
        for sid in &sessions {
            if let Some(s) = sess_by_id.get(*sid) {
                let ts = str_field(s, "last_timestamp")
                    .or_else(|| str_field(s, "first_timestamp"))
                    .map(|s| s.to_string());
                if let Some(t) = ts {
                    if last_ts.as_ref().map(|p| t.as_str() > p.as_str()).unwrap_or(true) {
                        last_ts = Some(t);
                    }
                }
            }
        }
        let ext = path
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_lowercase()
            .split('?')
            .next()
            .unwrap_or("")
            .to_string();
        let write = i64_field(f, "write");
        let edit = i64_field(f, "edit");
        let read = i64_field(f, "read");
        let size_norm = ((write + edit) as f64 / max_file_w as f64).sqrt();
        let label = path.rsplit('/').next().unwrap_or(path);
        let f_last = last_ts.as_deref();
        nodes.push(json!({
            "id": path,
            "type": "file",
            "label": label,
            "full_path": path,
            "color": ext_color(&ext),
            "ext": ext,
            "read": read,
            "write": write,
            "edit": edit,
            "session_count": sessions.len(),
            "sizeNorm": size_norm,
            "last_activity": f_last,
            "recency": calc_recency_score(f_last, reference_ms),
            "recencyLevel": calc_recency_level(f_last, reference_ms),
        }));
        for sid in sessions {
            let Some(sess) = sess_by_id.get(sid) else { continue };
            let Some(ops) = sess
                .get("file_ops")
                .and_then(|m| m.get(path))
                .and_then(|v| v.as_object())
            else {
                continue;
            };
            let w = ops.get("write").and_then(|v| v.as_i64()).unwrap_or(0);
            let e = ops.get("edit").and_then(|v| v.as_i64()).unwrap_or(0);
            let r = ops.get("read").and_then(|v| v.as_i64()).unwrap_or(0);
            if w > 0 {
                edges.push(json!({"source": sid, "target": path, "type": "write", "weight": w}));
            }
            if e > 0 {
                edges.push(json!({"source": sid, "target": path, "type": "edit", "weight": e}));
            }
            if r > 0 {
                edges.push(json!({"source": sid, "target": path, "type": "read", "weight": r}));
            }
        }
    }
    (nodes, edges)
}

/// Parse `--min-sessions=N` style argv (JS `parseMinSessions`).
pub fn parse_min_sessions(argv: &[String]) -> usize {
    argv.iter()
        .find_map(|a| a.strip_prefix("--min-sessions=")?.parse().ok())
        .unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_iso_roundtrip_basics() {
        let ms = parse_iso_ms("2026-05-11T00:00:00.000Z").unwrap();
        assert!(ms > 0);
        let a = parse_iso_ms("2026-05-01T10:00:00.000Z").unwrap();
        let b = parse_iso_ms("2026-05-05T14:00:00.000Z").unwrap();
        assert!(a < b);
    }

    #[test]
    fn recency_score_edges() {
        let now = parse_iso_ms("2026-05-11T00:00:00.000Z").unwrap();
        assert_eq!(calc_recency_score(None, now), 0.0);
        assert!((calc_recency_score(Some("2026-05-11T00:00:00.000Z"), now) - 1.0).abs() < 1e-9);
        assert_eq!(
            calc_recency_score(Some("2026-05-09T00:00:00.000Z"), now),
            0.0
        ); // exactly MAX_AGE
    }

    #[test]
    fn assign_colors_alpha_order() {
        let projects = vec![json!({"id": "B"}), json!({"id": "A"})];
        let (colors, _) = assign_project_colors(&projects, PALETTE);
        assert_eq!(colors.get("A").unwrap(), PALETTE[0]);
        assert_eq!(colors.get("B").unwrap(), PALETTE[1]);
    }
}
