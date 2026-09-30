//! Derived session / project fields — port of `hooks/enrich-session.mjs`.
//!
//! ALL token arithmetic lives here. Downstream consumers pass these fields
//! through and must never recompute them.

use crate::session_reducer::{Session, TokenCounts};
use serde::{Deserialize, Serialize};

/// AI "work" tokens: generated output + cache writes.
pub fn tokens_work(t: Option<&TokenCounts>) -> i64 {
    match t {
        Some(t) => t.output + t.cache_create,
        None => 0,
    }
}

/// Round to 1 decimal place like JS `+(n).toFixed(1)`.
fn to_fixed1(n: f64) -> f64 {
    (n * 10.0).round() / 10.0
}

/// Sakamoto's method — returns 0=Sunday … 6=Saturday (JS `Date#getUTCDay`).
fn weekday_utc(y: i32, m: u32, d: u32) -> u32 {
    let t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let mut y = y;
    if m < 3 {
        y -= 1;
    }
    let m = m as i32;
    let d = d as i32;
    let w = (y + y / 4 - y / 100 + y / 400 + t[(m - 1) as usize] + d) % 7;
    w.rem_euclid(7) as u32
}

fn parse_iso_date_parts(ts: &str) -> Option<(i32, u32, u32, u32)> {
    // Expect at least YYYY-MM-DDTHH…
    if ts.len() < 13 {
        return None;
    }
    let y: i32 = ts.get(0..4)?.parse().ok()?;
    let mo: u32 = ts.get(5..7)?.parse().ok()?;
    let d: u32 = ts.get(8..10)?.parse().ok()?;
    let h: u32 = ts.get(11..13)?.parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 {
        return None;
    }
    Some((y, mo, d, h))
}

/// Mutate `sess` with derived fields (JS `enrichSession`).
pub fn enrich_session(sess: &mut Session) {
    let total = sess.tokens.input
        + sess.tokens.cache_create
        + sess.tokens.cache_read
        + sess.tokens.output;
    sess.tokens.total = Some(total);
    sess.tokens_work = Some(tokens_work(Some(&sess.tokens)));
    sess.tokens_total = Some(total);

    let input_side =
        sess.tokens.input + sess.tokens.cache_create + sess.tokens.cache_read;
    sess.cache_hit_rate = Some(if input_side > 0 {
        to_fixed1(sess.tokens.cache_read as f64 / input_side as f64 * 100.0)
    } else {
        0.0
    });

    sess.duration_min = match sess.duration_ms {
        Some(ms) => Some(to_fixed1(ms as f64 / 60_000.0)),
        None => None,
    };

    sess.tool_diversity = Some(sess.tools.len() as i64);

    if let Some(ts) = sess.first_timestamp.clone() {
        sess.date_str = Some(ts.chars().take(10).collect());
        if let Some((y, mo, d, h)) = parse_iso_date_parts(&ts) {
            sess.day_of_week = Some(weekday_utc(y, mo, d));
            sess.hour_of_day = Some(h);
        }
    }
}

/// Minimal project summary for [`enrich_project`] (JS project aggregate shape).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub tokens: TokenCounts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_work: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_total: Option<i64>,
}

/// Derived token fields for a project summary (JS `enrichProject`).
pub fn enrich_project(proj: &mut ProjectSummary) {
    let t = &proj.tokens;
    proj.tokens_work = Some(tokens_work(Some(t)));
    proj.tokens_total = Some(t.input + t.cache_create + t.cache_read + t.output);
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn weekday_friday_2026_05_01() {
        // 2026-05-01 was a Friday → 5
        assert_eq!(weekday_utc(2026, 5, 1), 5);
    }
}
