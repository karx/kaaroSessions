//! Stream production path — port of `surface/pulse-emitter.mjs`.
//!
//! File change → tail/parse → adapter → pulses → hub + active-state,
//! plus throttled `now` snapshot. File watch wiring is the caller's job.

use crate::active::{apply_pulse, snapshot_active, ActiveState};
use crate::sse_hub::SseHub;
use kaaro_core::jsonl::{tail_read, MAX_JSONL_BYTES};
use kaaro_core::pulse_transformer::{norm_records_to_pulses, Pulse, PulseCtx};
use kaaro_core::registry::get_harness;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
enum FileCursor {
    /// Byte offset for JSONL tails.
    Offset(u64),
    /// `size:mtime_ms` signature for whole-file JSON.
    Sig(String),
}

/// Context for a watched session file (JS watch ctx).
#[derive(Debug, Clone)]
pub struct EmitCtx {
    pub harness: String,
    pub session_id: Option<String>,
    pub slug: Option<String>,
    pub project_id: Option<String>,
    pub project_label: Option<String>,
    pub read_mode: Option<String>,
}

impl EmitCtx {
    pub fn claude_code(session_id: &str, slug: &str, project_label: &str) -> Self {
        Self {
            harness: "claude-code".into(),
            session_id: Some(session_id.into()),
            slug: Some(slug.into()),
            project_id: None,
            project_label: Some(project_label.into()),
            read_mode: None,
        }
    }
}

/// Optional kind-map overlay sink (test / live overlay).
pub type KindMapFn = Arc<dyn Fn(&Pulse) + Send + Sync>;

#[derive(Clone)]
pub struct PulseEmitter {
    hub: SseHub,
    active: Arc<Mutex<ActiveState>>,
    offsets: Arc<Mutex<HashMap<String, FileCursor>>>,
    now_throttle_ms: u64,
    max_bytes: u64,
    kind_map: Option<KindMapFn>,
    now_scheduled: Arc<Mutex<bool>>,
}

impl PulseEmitter {
    pub fn new(hub: SseHub, active: Arc<Mutex<ActiveState>>) -> Self {
        Self::with_options(hub, active, 1000, MAX_JSONL_BYTES, None)
    }

    pub fn with_options(
        hub: SseHub,
        active: Arc<Mutex<ActiveState>>,
        now_throttle_ms: u64,
        max_bytes: u64,
        kind_map: Option<KindMapFn>,
    ) -> Self {
        Self {
            hub,
            active,
            offsets: Arc::new(Mutex::new(HashMap::new())),
            now_throttle_ms,
            max_bytes,
            kind_map,
            now_scheduled: Arc::new(Mutex::new(false)),
        }
    }

    pub fn active_state(&self) -> Arc<Mutex<ActiveState>> {
        self.active.clone()
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    fn schedule_now_broadcast(&self) {
        {
            let mut scheduled = self.now_scheduled.lock().expect("now lock");
            if *scheduled {
                return;
            }
            *scheduled = true;
        }
        let this = self.clone();
        let ms = self.now_throttle_ms;
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            this.flush_now();
        });
    }

    fn flush_now(&self) {
        *self.now_scheduled.lock().expect("now lock") = false;
        let snap = {
            let mut st = self.active.lock().expect("active lock");
            snapshot_active(&mut st, Self::now_ms())
        };
        if let Ok(s) = serde_json::to_string(&snap) {
            self.hub.notify("now", &s);
        }
    }

    /// Emit pulses from already-normalized raw records (adapter applied inside).
    pub fn emit_pulses(&self, records: &[Value], ctx: &EmitCtx) {
        let Some(harness) = get_harness(&ctx.harness) else {
            return;
        };
        let nrs = (harness.adapter)(records);
        let pulse_ctx = PulseCtx {
            session_id: ctx.session_id.clone().unwrap_or_default(),
            slug: ctx.slug.clone().unwrap_or_default(),
            harness: ctx.harness.clone(),
            project_label: ctx.project_label.clone(),
        };
        let tokens_cap = Some(harness.capabilities.tokens);
        let pulses = norm_records_to_pulses(&nrs, &pulse_ctx, tokens_cap);
        let now = Self::now_ms();
        {
            let mut st = self.active.lock().expect("active lock");
            for p in &pulses {
                let pulse_val = json!({"event": p.event, "data": p.data});
                apply_pulse(&mut st, &pulse_val, now);
                if let Some(km) = &self.kind_map {
                    km(p);
                }
                if let Ok(s) = serde_json::to_string(&p.data) {
                    self.hub.notify(&p.event, &s);
                }
            }
        }
        if !pulses.is_empty() {
            self.schedule_now_broadcast();
        }
    }

    /// Apply a ready-made pulse (test / manual inject) without adapter.
    pub fn apply_and_notify(&self, pulse: &Pulse, now: i64) {
        let pulse_val = json!({"event": pulse.event, "data": pulse.data});
        {
            let mut st = self.active.lock().expect("active lock");
            apply_pulse(&mut st, &pulse_val, now);
        }
        if let Ok(s) = serde_json::to_string(&pulse.data) {
            self.hub.notify(&pulse.event, &s);
        }
        self.schedule_now_broadcast();
    }

    fn json_and_pulse(&self, file_path: &Path, ctx: &EmitCtx) {
        let meta = match std::fs::metadata(file_path) {
            Ok(m) => m,
            Err(_) => return,
        };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let sig = format!("{}:{}", meta.len(), mtime_ms);
        {
            let map = self.offsets.lock().expect("offset lock");
            if let Some(FileCursor::Sig(prev)) = map.get(&file_path.to_string_lossy().to_string()) {
                if prev == &sig {
                    return;
                }
            }
        }
        self.offsets.lock().expect("offset lock").insert(
            file_path.to_string_lossy().to_string(),
            FileCursor::Sig(sig),
        );

        if meta.len() > self.max_bytes {
            eprintln!(
                "[pulse] json read skipped {:.1}MB (over {:.1}MB cap) — {}",
                meta.len() as f64 / 1024.0 / 1024.0,
                self.max_bytes as f64 / 1024.0 / 1024.0,
                file_path.display()
            );
            return;
        }

        let raw = match std::fs::read_to_string(file_path) {
            Ok(s) => s,
            Err(_) => return,
        };
        let obj: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => return,
        };
        let session_id = ctx
            .session_id
            .clone()
            .or_else(|| {
                obj.get("sessionID")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            });
        let Some(session_id) = session_id else {
            return;
        };
        let dir = obj
            .get("directory")
            .and_then(|v| v.as_str())
            .map(|d| d.replace('\\', "/"))
            .and_then(|d| d.rsplit('/').next().map(|s| s.to_string()));
        let slug = ctx.slug.clone().unwrap_or_else(|| {
            session_id
                .strip_prefix("ses_")
                .unwrap_or(&session_id)
                .chars()
                .take(8)
                .collect()
        });
        let mut filled = ctx.clone();
        filled.session_id = Some(session_id);
        filled.slug = Some(slug);
        if filled.project_label.is_none() {
            filled.project_label = dir;
        }
        self.emit_pulses(&[obj], &filled);
    }

    /// Tail (or whole-file JSON) and emit pulses. Errors are swallowed.
    pub fn tail_and_pulse(&self, file_path: &Path, ctx: &EmitCtx) {
        if ctx.read_mode.as_deref() == Some("json") {
            self.json_and_pulse(file_path, ctx);
            return;
        }
        let key = file_path.to_string_lossy().to_string();
        let offset = {
            let map = self.offsets.lock().expect("offset lock");
            match map.get(&key) {
                Some(FileCursor::Offset(o)) => *o,
                _ => 0,
            }
        };
        let tail = match tail_read(file_path, offset, Some(self.max_bytes)) {
            Ok(t) => t,
            Err(_) => return,
        };
        self.offsets
            .lock()
            .expect("offset lock")
            .insert(key, FileCursor::Offset(tail.new_offset));
        if let Some(skipped) = tail.skipped_bytes {
            eprintln!(
                "[pulse] tail skipped {:.1}MB (over {:.1}MB cap) — {}",
                skipped as f64 / 1024.0 / 1024.0,
                self.max_bytes as f64 / 1024.0 / 1024.0,
                file_path.display()
            );
        }
        if tail.records.is_empty() {
            return;
        }
        self.emit_pulses(&tail.records, ctx);
    }
}
