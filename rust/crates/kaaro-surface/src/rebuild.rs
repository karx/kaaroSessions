//! Debounced analyze+build scheduling — port of `surface/rebuild-orchestrator.mjs`.

use crate::sse_hub::SseHub;
use crate::state::SurfaceStatus;
use std::future::Future;
use std::pin::Pin;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::AbortHandle;

pub type BoxFut = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub type AnalyzeRunner = Arc<dyn Fn(Vec<String>) -> BoxFut + Send + Sync>;
pub type BuildRunner = Arc<dyn Fn() -> BoxFut + Send + Sync>;
pub type SnapshotHook = Arc<dyn Fn() + Send + Sync>;

#[derive(Debug, Clone, Default)]
pub struct RebuildTarget {
    pub rebuild_arg: Option<String>,
    pub harness_id: Option<String>,
}

struct Inner {
    rebuilding: bool,
    pending: bool,
    last_built: Option<String>,
    debounce: Option<AbortHandle>,
}

/// Snapshot rebuild orchestrator (injectable runners for tests).
#[derive(Clone)]
pub struct Rebuilder {
    hub: SseHub,
    status: Arc<Mutex<SurfaceStatus>>,
    analyze: AnalyzeRunner,
    build: BuildRunner,
    on_snapshot: Option<SnapshotHook>,
    debounce_ms: u64,
    inner: Arc<Mutex<Inner>>,
}

impl Rebuilder {
    pub fn new(
        hub: SseHub,
        status: Arc<Mutex<SurfaceStatus>>,
        analyze: AnalyzeRunner,
        build: BuildRunner,
        debounce_ms: u64,
        on_snapshot: Option<SnapshotHook>,
    ) -> Self {
        Self {
            hub,
            status,
            analyze,
            build,
            on_snapshot,
            debounce_ms,
            inner: Arc::new(Mutex::new(Inner {
                rebuilding: false,
                pending: false,
                last_built: None,
                debounce: None,
            })),
        }
    }

    pub fn rebuilding(&self) -> bool {
        self.inner.lock().expect("rebuilder").rebuilding
    }

    pub fn last_built(&self) -> Option<String> {
        self.inner.lock().expect("rebuilder").last_built.clone()
    }

    fn set_status_rebuilding(&self, rebuilding: bool) {
        if let Ok(mut s) = self.status.lock() {
            s.rebuilding = rebuilding;
            if let Some(lb) = self.last_built() {
                s.last_built = Some(lb);
            }
        }
    }

    fn sync_last_built(&self, iso: &str) {
        if let Ok(mut s) = self.status.lock() {
            s.last_built = Some(iso.to_string());
            s.rebuilding = false;
        }
    }

    fn analyze_args(target: &Option<RebuildTarget>) -> Vec<String> {
        match target {
            Some(t) if t.rebuild_arg.is_some() => {
                let mut args = Vec::new();
                if let Some(h) = &t.harness_id {
                    args.push(format!("--harness={h}"));
                }
                if let Some(a) = &t.rebuild_arg {
                    args.push(a.clone());
                }
                args
            }
            _ => vec!["--all-harnesses".into()],
        }
    }

    /// Run analyze → build once (coalesces overlapping calls into one follow-up).
    pub async fn rebuild(&self, target: Option<RebuildTarget>) {
        {
            let mut g = self.inner.lock().expect("rebuilder");
            if g.rebuilding {
                g.pending = true;
                return;
            }
            g.rebuilding = true;
        }
        self.set_status_rebuilding(true);
        self.hub.notify("status", "rebuilding");

        let args = Self::analyze_args(&target);
        let result = async {
            (self.analyze)(args).await?;
            if let Some(hook) = &self.on_snapshot {
                hook();
            }
            (self.build)().await?;
            Ok::<(), String>(())
        }
        .await;

        match result {
            Ok(()) => {
                let iso = chrono_like_now();
                {
                    let mut g = self.inner.lock().expect("rebuilder");
                    g.last_built = Some(iso.clone());
                }
                self.sync_last_built(&iso);
                self.hub.notify("updated", &iso);
            }
            Err(e) => {
                let msg: String = e.chars().take(200).collect();
                self.hub.notify("error", &msg);
                self.set_status_rebuilding(false);
            }
        }

        let follow_up = {
            let mut g = self.inner.lock().expect("rebuilder");
            g.rebuilding = false;
            if g.pending {
                g.pending = false;
                true
            } else {
                false
            }
        };
        if follow_up {
            Box::pin(self.rebuild(None)).await;
        } else {
            self.set_status_rebuilding(false);
        }
    }

    /// Debounce bursts into a single rebuild.
    pub fn schedule_rebuild(&self, target: Option<RebuildTarget>) {
        let this = self.clone();
        let ms = self.debounce_ms;
        let mut g = self.inner.lock().expect("rebuilder");
        if let Some(h) = g.debounce.take() {
            h.abort();
        }
        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            this.rebuild(target).await;
        });
        g.debounce = Some(handle.abort_handle());
    }
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // ISO-ish UTC without chrono crate: enough for lastBuilt / SSE.
    format_iso_ms(ms as i64)
}

fn format_iso_ms(ms: i64) -> String {
    // Reuse graph_data parser inverse via simple UTC format from epoch.
    // Days since Unix epoch:
    let secs = ms / 1000;
    let millis = (ms % 1000).abs();
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400) as i64;
    let h = tod / 3600;
    let m = (tod % 3600) / 60;
    let s = tod % 60;
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

/// Howard Hinnant civil_from_days
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

/// In-process analyze+build using kaaro-core (production serve runner).
pub fn in_process_runners(
    sessions_out: PathBuf,
    graph_out: PathBuf,
    signals_out: PathBuf,
    roots: kaaro_core::analyze::RootOverrides,
) -> (AnalyzeRunner, BuildRunner) {
    use kaaro_core::analyze::scan_all;
    use kaaro_core::graph_pipeline::{build_graph_data_file, BuildGraphOpts};
    use kaaro_core::sessions_output::{build_sessions_output, sessions_data_to_json};
    use kaaro_core::{
        build_signals_data_from_sessions, default_home_dir, load_policy, now_iso_utc,
    };
    let sessions_out_a = sessions_out.clone();
    let signals_out_a = signals_out;
    let roots_a = roots;
    let analyze: AnalyzeRunner = Arc::new(move |args: Vec<String>| {
        let sessions_out = sessions_out_a.clone();
        let signals_out = signals_out_a.clone();
        let roots = roots_a.clone();
        Box::pin(async move {
            use kaaro_core::harness_paths;
            use kaaro_core::{parse_session_flag, try_incremental_claude_code};
            let sessions_out_blocking = sessions_out.clone();
            let roots_blocking = roots.clone();
            let args_blocking = args.clone();
            let data = tokio::task::spawn_blocking(move || -> Result<_, String> {
                if let Some(flag) = parse_session_flag(&args_blocking) {
                    let cc_root = roots_blocking
                        .claude_code
                        .clone()
                        .unwrap_or_else(harness_paths::claude_projects_root);
                    match try_incremental_claude_code(
                        &sessions_out_blocking,
                        &flag.project_id,
                        &flag.session_id,
                        &cc_root,
                    ) {
                        Ok(Some(merged)) => return Ok(merged),
                        Ok(None) => {
                            // No existing sessions-data — fall through to full scan.
                        }
                        Err(e) => {
                            eprintln!("incremental analyze failed ({e}); full scan");
                        }
                    }
                }
                let envelopes = scan_all(&roots_blocking);
                Ok(build_sessions_output(&envelopes))
            })
            .await
            .map_err(|e| e.to_string())??;
            let json = sessions_data_to_json(&data).map_err(|e| e.to_string())?;
            if let Some(parent) = sessions_out.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
            }
            std::fs::write(&sessions_out, json.as_bytes()).map_err(|e| e.to_string())?;

            let project_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let policy = load_policy(&project_dir, &default_home_dir());
            let signals =
                build_signals_data_from_sessions(&data.sessions, policy.as_ref(), &now_iso_utc());
            let signals_json =
                serde_json::to_string_pretty(&signals).map_err(|e| e.to_string())?;
            if let Some(parent) = signals_out.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
            }
            std::fs::write(&signals_out, signals_json.as_bytes()).map_err(|e| e.to_string())?;
            Ok(())
        })
    });

    let sessions_out_b = sessions_out;
    let graph_out_b = graph_out;
    let build: BuildRunner = Arc::new(move || {
        let sessions_out = sessions_out_b.clone();
        let graph_out = graph_out_b.clone();
        Box::pin(async move {
            let raw = tokio::fs::read_to_string(&sessions_out)
                .await
                .map_err(|e| format!("read {}: {e}", sessions_out.display()))?;
            let data: serde_json::Value =
                serde_json::from_str(&raw).map_err(|e| format!("parse sessions-data: {e}"))?;
            let file = build_graph_data_file(
                &data,
                BuildGraphOpts {
                    include_subagent_nodes: true,
                    ..Default::default()
                },
            );
            let json = file.to_json_pretty().map_err(|e| e.to_string())?;
            if let Some(parent) = graph_out.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
            }
            tokio::fs::write(&graph_out, json.as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        })
    });

    (analyze, build)
}

