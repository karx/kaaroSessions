//! Injectable surface state (paths + status + SSE hub + active-state + emitter).

use crate::active::ActiveState;
use crate::kind_map_store::KindMapStore;
use crate::pulse_emitter::PulseEmitter;
use crate::sse_hub::SseHub;
use crate::trace_service::TraceService;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Paths the snapshot surface may read.
#[derive(Debug, Clone, Default)]
pub struct SurfacePaths {
    pub graph_data: Option<PathBuf>,
    pub sessions_data: Option<PathBuf>,
    /// Policy signals artifact (`signals-data.json` from analyze).
    pub signals: Option<PathBuf>,
    /// Directory with JS-built HTML artifacts (graph.html, now.html, …).
    pub static_dir: Option<PathBuf>,
}

/// Live status fields exposed by GET /status.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceStatus {
    pub rebuilding: bool,
    pub last_built: Option<String>,
    pub clients: usize,
    pub port: u16,
}

impl Default for SurfaceStatus {
    fn default() -> Self {
        Self {
            rebuilding: false,
            last_built: None,
            clients: 0,
            port: 3333,
        }
    }
}

/// Shared app state for the axum router.
#[derive(Clone)]
pub struct AppState {
    pub paths: SurfacePaths,
    pub status: Arc<Mutex<SurfaceStatus>>,
    pub hub: SseHub,
    pub active: Arc<Mutex<ActiveState>>,
    pub emitter: Arc<PulseEmitter>,
    pub kind_map: Arc<Mutex<KindMapStore>>,
    pub trace: Arc<TraceService>,
}

impl AppState {
    pub fn new(paths: SurfacePaths, status: SurfaceStatus) -> Self {
        Self::with_hub(paths, status, SseHub::with_defaults())
    }

    pub fn with_hub(paths: SurfacePaths, status: SurfaceStatus, hub: SseHub) -> Self {
        let active = Arc::new(Mutex::new(ActiveState::new()));
        let kind_map = Arc::new(Mutex::new(KindMapStore::new()));
        let kind_map_for_emitter = kind_map.clone();
        let kind_map_fn: crate::pulse_emitter::KindMapFn = Arc::new(move |pulse| {
            if let Ok(mut km) = kind_map_for_emitter.lock() {
                km.apply_pulse(&pulse.event, &pulse.data);
            }
        });
        let emitter = Arc::new(PulseEmitter::with_options(
            hub.clone(),
            active.clone(),
            1000,
            kaaro_core::MAX_JSONL_BYTES,
            Some(kind_map_fn),
        ));
        Self {
            paths,
            status: Arc::new(Mutex::new(status)),
            hub,
            active,
            emitter,
            kind_map,
            trace: {
                let t = TraceService::new();
                t.set_roots_from_overrides(&kaaro_core::RootOverrides::default());
                Arc::new(t)
            },
        }
    }

    pub fn with_paths(paths: SurfacePaths) -> Self {
        Self::new(paths, SurfaceStatus::default())
    }

    /// Status with `clients` taken live from the SSE hub (JS `hub.size`).
    pub fn status_snapshot(&self) -> SurfaceStatus {
        let mut s = self.status.lock().expect("status lock").clone();
        s.clients = self.hub.size();
        s
    }

    pub fn set_port(&self, port: u16) {
        self.status.lock().expect("status lock").port = port;
    }

    /// Snapshot kind-map (builds baseline store on first access already).
    pub fn kind_map_snapshot(&self) -> serde_json::Value {
        self.kind_map
            .lock()
            .expect("kind_map lock")
            .snapshot()
    }
}
