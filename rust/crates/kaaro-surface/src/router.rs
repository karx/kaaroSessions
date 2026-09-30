//! HTTP routes — Snapshot read surface + SSE /events.

use crate::active::snapshot_active;
use crate::sse_hub::HubEvent;
use crate::state::AppState;
use crate::static_pages;
use std::time::{SystemTime, UNIX_EPOCH};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::stream::{self, StreamExt};
use kaaro_core::registry::harness_registry;
use serde::Serialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use tower_http::cors::{Any, CorsLayer};

fn json_headers() -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    h.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    h
}

async fn get_status(State(state): State<AppState>) -> impl IntoResponse {
    let body = state.status_snapshot();
    (StatusCode::OK, Json(body))
}

#[derive(Serialize)]
struct HarnessPublic {
    id: &'static str,
    label: &'static str,
    capabilities: HarnessCapsPublic,
}

#[derive(Serialize)]
struct HarnessCapsPublic {
    tokens: bool,
    pulse: bool,
    trace: bool,
    context_resets: bool,
    ai_title: bool,
    subagent_count: bool,
    subagent_tree: bool,
    branches: bool,
    size_proxy: &'static str,
}

async fn get_harnesses() -> impl IntoResponse {
    let harnesses: Vec<HarnessPublic> = harness_registry()
        .into_iter()
        .map(|h| HarnessPublic {
            id: h.id,
            label: h.label,
            capabilities: HarnessCapsPublic {
                tokens: h.capabilities.tokens,
                pulse: h.capabilities.pulse,
                trace: h.capabilities.trace,
                context_resets: h.capabilities.context_resets,
                ai_title: h.capabilities.ai_title,
                subagent_count: h.capabilities.subagent_count,
                subagent_tree: h.capabilities.subagent_tree,
                branches: h.capabilities.branches,
                size_proxy: h.capabilities.size_proxy,
            },
        })
        .collect();
    let mut res = Json(json!({ "harnesses": harnesses })).into_response();
    res.headers_mut().extend(json_headers());
    res
}

async fn get_active(State(state): State<AppState>) -> impl IntoResponse {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let snap = {
        let mut active = state.active.lock().expect("active lock");
        snapshot_active(&mut active, now)
    };
    let mut res = Json(snap).into_response();
    res.headers_mut().extend(json_headers());
    res
}

async fn get_graph_data(State(state): State<AppState>) -> Response {
    let Some(path) = state.paths.graph_data.as_ref() else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({}))).into_response();
    };
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            let mut res = Response::new(bytes.into());
            *res.status_mut() = StatusCode::OK;
            res.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            res.headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            res
        }
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({}))).into_response(),
    }
}

async fn get_signals(State(state): State<AppState>) -> Response {
    let empty = json!({
        "generated_at": Value::Null,
        "total_signals": 0,
        "by_level": {},
        "by_rule": {},
        "signals": [],
    });
    let Some(path) = state.paths.signals.as_ref() else {
        let mut res = Json(empty).into_response();
        res.headers_mut().extend(json_headers());
        return res;
    };
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            let mut res = Response::new(bytes.into());
            *res.status_mut() = StatusCode::OK;
            res.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            res.headers_mut().extend(json_headers());
            res
        }
        Err(_) => {
            let mut res = Json(empty).into_response();
            res.headers_mut().extend(json_headers());
            res
        }
    }
}

fn hub_event_to_sse(ev: HubEvent) -> Event {
    match ev {
        HubEvent::Comment => Event::default().comment(""),
        HubEvent::Named { event, data } => Event::default().event(event).data(data),
    }
}

/// GET /events — SSE handshake (`connected`) + hub fan-out.
///
/// Heartbeats come from the hub (JS `:\n\n` interval), not axum KeepAlive,
/// so dead-client eviction stays in one place.
async fn get_events(
    State(state): State<AppState>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let sub = state.hub.subscribe();
    let live = stream::unfold(sub, |mut sub| async move {
        match sub.receiver().recv().await {
            Some(ev) => Some((Ok(hub_event_to_sse(ev)), sub)),
            None => None,
        }
    });
    let handshake = stream::iter([
        Ok(Event::default().comment("")),
        Ok(Event::default().event("connected").data("ok")),
    ]);
    Sse::new(handshake.chain(live))
}


async fn get_kind_map(State(state): State<AppState>) -> impl IntoResponse {
    let body = state.kind_map_snapshot();
    let mut res = Json(body).into_response();
    res.headers_mut().extend(json_headers());
    res
}

async fn get_trace(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Response {
    use crate::trace_service::TraceError;
    let session_id = session_id.trim_end_matches(".jsonl").to_string();
    if session_id.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing session_id").into_response();
    }
    match state.trace.trace_for_session(&session_id) {
        Ok(tree) => {
            let mut res = Json(tree).into_response();
            res.headers_mut().extend(json_headers());
            res
        }
        Err(TraceError::NotFound) => (StatusCode::NOT_FOUND, "session not found").into_response(),
        Err(TraceError::Unsupported) => {
            (StatusCode::NOT_FOUND, "trace not supported for this harness").into_response()
        }
        Err(TraceError::Failed) => {
            (StatusCode::INTERNAL_SERVER_ERROR, "reconstruction failed").into_response()
        }
    }
}

/// Build the snapshot surface router (JSON APIs + SSE).
pub fn create_router(state: AppState) -> Router {
    Router::new()
        .route("/", get(static_pages::page_home))
        .route("/home", get(static_pages::page_home))
        .route("/graph", get(static_pages::page_graph))
        .route("/graph.html", get(static_pages::page_graph))
        .route("/now", get(static_pages::page_now))
        .route("/mission", get(static_pages::page_now))
        .route("/active", get(static_pages::page_now))
        .route("/daw", get(static_pages::page_daw))
        .route("/daw-builder", get(static_pages::page_daw))
        .route("/mapping", get(static_pages::page_mapping))
        .route("/kind-map", get(static_pages::page_mapping))
        .route("/status", get(get_status))
        .route("/api/harnesses", get(get_harnesses))
        .route("/api/active", get(get_active))
        .route("/api/signals", get(get_signals))
        .route("/api/kind-map", get(get_kind_map))
        .route("/api/trace/{session_id}", get(get_trace))
        .route("/graph-data.json", get(get_graph_data))
        .route("/events", get(get_events))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state)
}
