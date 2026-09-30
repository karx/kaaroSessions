//! Snapshot HTTP surface — port of `surface/http-routes.mjs` (+ SSE hub,
//! active-state, pulse-emitter, file watch, rebuild orchestrator, static HTML).

mod active;
mod kind_map_store;
mod trace_service;
mod file_watch;
mod pulse_emitter;
mod rebuild;
mod router;
mod sse_hub;
mod state;
mod static_pages;

pub use active::{
    apply_pulse, empty_active_snapshot, snapshot_active, snapshot_active_with, ActiveSnapshot,
    ActiveState, ActiveThresholds, ActiveTotals, DEFAULT_THRESHOLDS, RECENT_ACTIONS_MAX,
};
pub use file_watch::{resolve_watch_roots, FileWatchService, HarnessRoot};
pub use pulse_emitter::{EmitCtx, KindMapFn, PulseEmitter};
pub use rebuild::{in_process_runners, AnalyzeRunner, BuildRunner, RebuildTarget, Rebuilder};
pub use router::create_router;
pub use sse_hub::{HubEvent, SseHub, Subscription};
pub use state::{AppState, SurfacePaths, SurfaceStatus};
pub use static_pages::resolve_static_dir;
pub use kind_map_store::KindMapStore;
pub use trace_service::{TraceError, TraceService};
