//! Poll-based harness root watcher → pulse emitter.
//!
//! Avoids the `notify` crate: walks configured roots on an interval, detects
//! size/mtime changes, debounces, then `process_watch_filename` + `tail_and_pulse`.

use crate::pulse_emitter::{EmitCtx, PulseEmitter};
use crate::rebuild::{RebuildTarget, Rebuilder};
use crate::trace_service::TraceService;
use kaaro_core::watch_handlers::process_watch_filename;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

#[derive(Debug, Clone)]
pub struct HarnessRoot {
    pub harness_id: String,
    pub root: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileSig {
    len: u64,
    mtime: SystemTime,
}

#[derive(Debug, Clone)]
struct PendingChange {
    harness_id: String,
    root: PathBuf,
    /// Path relative to root (forward slashes).
    rel_path: String,
    due: Instant,
}

/// Debounced poll watcher over harness roots.
#[derive(Clone)]
pub struct FileWatchService {
    roots: Arc<Vec<HarnessRoot>>,
    emitter: PulseEmitter,
    rebuilder: Option<Rebuilder>,
    trace: Option<Arc<TraceService>>,
    known: Arc<Mutex<HashMap<PathBuf, FileSig>>>,
    pending: Arc<Mutex<HashMap<PathBuf, PendingChange>>>,
    debounce: Duration,
    /// When true, first scan only seeds signatures (no pulses).
    seeded: Arc<Mutex<bool>>,
}

impl FileWatchService {
    pub fn new(roots: Vec<HarnessRoot>, emitter: PulseEmitter, debounce: Duration) -> Self {
        Self::with_rebuilder(roots, emitter, debounce, None)
    }

    pub fn with_rebuilder(
        roots: Vec<HarnessRoot>,
        emitter: PulseEmitter,
        debounce: Duration,
        rebuilder: Option<Rebuilder>,
    ) -> Self {
        Self::with_rebuilder_and_trace(roots, emitter, debounce, rebuilder, None)
    }

    pub fn with_rebuilder_and_trace(
        roots: Vec<HarnessRoot>,
        emitter: PulseEmitter,
        debounce: Duration,
        rebuilder: Option<Rebuilder>,
        trace: Option<Arc<TraceService>>,
    ) -> Self {
        Self {
            roots: Arc::new(roots),
            emitter,
            rebuilder,
            trace,
            known: Arc::new(Mutex::new(HashMap::new())),
            pending: Arc::new(Mutex::new(HashMap::new())),
            debounce,
            seeded: Arc::new(Mutex::new(false)),
        }
    }

    /// Attach / replace rebuild orchestrator (watch → schedule_rebuild).
    pub fn set_rebuilder(&mut self, rebuilder: Option<Rebuilder>) {
        self.rebuilder = rebuilder;
    }

    pub fn emitter(&self) -> &PulseEmitter {
        &self.emitter
    }

    /// Seed known signatures without emitting (call once before watching).
    pub fn seed(&self) {
        let _ = self.scan_once(true);
        *self.seeded.lock().expect("seeded") = true;
    }

    /// Handle one relative path change immediately (no debounce) — test / fs.watch seam.
    pub fn handle_watch_event(&self, harness_id: &str, root: &Path, filename: &str) -> bool {
        let Some(event) = process_watch_filename(harness_id, Some(filename), root) else {
            return false;
        };
        let ctx = watch_ctx_to_emit(&event.ctx);
        if let Some(trace) = &self.trace {
            trace.invalidate_session(Some(event.ctx.session_id.as_str()));
        }
        self.emitter.tail_and_pulse(&event.abs_path, &ctx);
        if let Some(rb) = &self.rebuilder {
            let target = event.rebuild_arg.as_ref().map(|a| RebuildTarget {
                rebuild_arg: Some(a.clone()),
                harness_id: Some(event.harness_id.clone()),
            });
            rb.schedule_rebuild(target);
        }
        true
    }

    /// Queue a change with debounce (used by the poll loop).
    pub fn queue_change(&self, harness_id: &str, root: &Path, rel_path: &str) {
        let abs = root.join(rel_path);
        let due = Instant::now() + self.debounce;
        self.pending.lock().expect("pending").insert(
            abs,
            PendingChange {
                harness_id: harness_id.into(),
                root: root.to_path_buf(),
                rel_path: rel_path.replace('\\', "/"),
                due,
            },
        );
    }

    /// Flush due pending changes → pulse. Returns number of handled events.
    pub fn flush_due(&self) -> usize {
        let now = Instant::now();
        let due: Vec<PendingChange> = {
            let mut pending = self.pending.lock().expect("pending");
            let keys: Vec<_> = pending
                .iter()
                .filter(|(_, p)| p.due <= now)
                .map(|(k, _)| k.clone())
                .collect();
            keys.into_iter()
                .filter_map(|k| pending.remove(&k))
                .collect()
        };
        let mut n = 0;
        for p in due {
            if self.handle_watch_event(&p.harness_id, &p.root, &p.rel_path) {
                n += 1;
            }
        }
        n
    }

    /// One poll pass: discover new/changed files, queue with debounce.
    /// If `seed_only`, update signatures without queueing.
    /// Returns number of newly queued changes.
    pub fn scan_once(&self, seed_only: bool) -> usize {
        let mut queued = 0;
        for hr in self.roots.iter() {
            if !hr.root.is_dir() {
                continue;
            }
            let files = walk_files(&hr.root);
            for abs in files {
                let Ok(meta) = std::fs::metadata(&abs) else {
                    continue;
                };
                let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                let sig = FileSig {
                    len: meta.len(),
                    mtime,
                };
                let rel = match abs.strip_prefix(&hr.root) {
                    Ok(r) => r.to_string_lossy().replace('\\', "/"),
                    Err(_) => continue,
                };
                let mut known = self.known.lock().expect("known");
                match known.get(&abs) {
                    Some(prev) if *prev == sig => {}
                    _ => {
                        known.insert(abs.clone(), sig);
                        drop(known);
                        if !seed_only {
                            // Only queue if it matches a log pattern (cheap prefilter).
                            if process_watch_filename(&hr.harness_id, Some(&rel), &hr.root)
                                .is_some()
                            {
                                self.queue_change(&hr.harness_id, &hr.root, &rel);
                                queued += 1;
                            }
                        }
                    }
                }
            }
        }
        queued
    }

    /// Poll + flush once (for tests / manual tick).
    pub fn tick(&self) -> usize {
        if !*self.seeded.lock().expect("seeded") {
            self.seed();
            return 0;
        }
        self.scan_once(false);
        self.flush_due()
    }

    /// Background loop: poll every `interval`, flush debounce.
    pub fn spawn(self, interval: Duration) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            self.seed();
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                self.scan_once(false);
                self.flush_due();
            }
        })
    }
}

fn watch_ctx_to_emit(ctx: &kaaro_core::registry::WatchCtx) -> EmitCtx {
    EmitCtx {
        harness: ctx.harness.clone(),
        session_id: if ctx.session_id.is_empty() {
            None
        } else {
            Some(ctx.session_id.clone())
        },
        slug: if ctx.slug.is_empty() {
            None
        } else {
            Some(ctx.slug.clone())
        },
        project_id: ctx.project_id.clone(),
        project_label: ctx.project_label.clone(),
        read_mode: ctx.read_mode.clone(),
    }
}

fn walk_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for ent in rd.flatten() {
            let path = ent.path();
            let Ok(ft) = ent.file_type() else {
                continue;
            };
            if ft.is_dir() {
                // Skip hidden dirs
                if ent
                    .file_name()
                    .to_str()
                    .map(|n| n.starts_with('.'))
                    .unwrap_or(false)
                {
                    continue;
                }
                stack.push(path);
            } else if ft.is_file() {
                out.push(path);
            }
        }
    }
    out
}

/// Resolve default harness roots with CLI overrides (serve watch).
pub fn resolve_watch_roots(
    claude_code: Option<PathBuf>,
    codex: Option<PathBuf>,
    pi: Option<PathBuf>,
    antigravity: Option<PathBuf>,
    grok: Option<PathBuf>,
    opencode: Option<PathBuf>,
    copilot: Option<PathBuf>,
    command_code: Option<PathBuf>,
) -> Vec<HarnessRoot> {
    use kaaro_core::harness_paths::{
        antigravity_brain_root, claude_projects_root, codex_home_root,
        command_code_projects_root, copilot_workspace_storage_root, grok_sessions_root,
        opencode_storage_root, pi_sessions_root,
    };
    let pairs = [
        ("claude-code", claude_code.unwrap_or_else(claude_projects_root)),
        ("codex", codex.unwrap_or_else(codex_home_root)),
        ("pi", pi.unwrap_or_else(pi_sessions_root)),
        ("antigravity", antigravity.unwrap_or_else(antigravity_brain_root)),
        ("grok", grok.unwrap_or_else(grok_sessions_root)),
        ("opencode", opencode.unwrap_or_else(opencode_storage_root)),
        ("copilot", copilot.unwrap_or_else(copilot_workspace_storage_root)),
        ("command-code", command_code.unwrap_or_else(command_code_projects_root)),
    ];
    pairs
        .into_iter()
        .filter(|(_, p)| p.is_dir())
        .map(|(id, root)| HarnessRoot {
            harness_id: id.into(),
            root,
        })
        .collect()
}
