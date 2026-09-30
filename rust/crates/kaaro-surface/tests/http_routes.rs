//! Integration tests mirroring `test/http-routes.test.mjs` (JSON + SSE).
use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use futures_util::StreamExt;
use http_body_util::BodyExt;
use kaaro_surface::{create_router, AppState, SseHub, SurfacePaths, SurfaceStatus};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tower::ServiceExt;

async fn json_get(app: axum::Router, uri: &str) -> (StatusCode, Value) {
    let response = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body)
}

fn base_state() -> AppState {
    AppState::with_hub(
        SurfacePaths {
            graph_data: Some(PathBuf::from("/definitely/missing/graph-data.json")),
            sessions_data: None,
            signals: None,
            static_dir: None,
        },
        SurfaceStatus {
            rebuilding: false,
            last_built: Some("2026-06-12T00:00:00.000Z".into()),
            clients: 0,
            port: 0,
        },
        SseHub::new(None),
    )
}

#[tokio::test]
async fn get_status_json_shape() {
    let app = create_router(base_state());
    let (status, body) = json_get(app, "/status").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["rebuilding"], false);
    assert_eq!(body["lastBuilt"], "2026-06-12T00:00:00.000Z");
    assert!(body["clients"].is_number());
    assert!(body["port"].is_number());
}

#[tokio::test]
async fn get_api_active_empty_default() {
    let app = create_router(base_state());
    let (status, body) = json_get(app, "/api/active").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["sessions"].as_array().unwrap().is_empty());
    assert!(body["by_harness"].is_object());
    assert_eq!(body["totals"]["sessions"], 0);
    assert_eq!(body["totals"]["active"], 0);
    assert_eq!(body["totals"]["idle"], 0);
    assert!(body["generated_at"].is_number());
}

#[tokio::test]
async fn get_api_harnesses_from_registry() {
    let app = create_router(base_state());
    let (status, body) = json_get(app, "/api/harnesses").await;
    assert_eq!(status, StatusCode::OK);
    let harnesses = body["harnesses"].as_array().unwrap();
    assert_eq!(harnesses.len(), 8);
    let cc = harnesses
        .iter()
        .find(|h| h["id"] == "claude-code")
        .unwrap();
    assert_eq!(cc["label"], "Claude Code");
    assert!(cc["capabilities"]["tokens"].is_boolean());
    assert!(cc["capabilities"]["trace"].is_boolean());
    assert!(cc.get("adapter").is_none());
    assert!(cc.get("watch").is_none());
}

#[tokio::test]
async fn get_graph_data_503_when_missing() {
    let app = create_router(base_state());
    let (status, body) = json_get(app, "/graph-data.json").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body, serde_json::json!({}));
}

#[tokio::test]
async fn get_graph_data_200_when_present() {
    let dir = std::env::temp_dir().join(format!(
        "kaaro-http-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    let data_path = dir.join("graph-data.json");
    fs::write(&data_path, r#"{"nodes":[]}"#).unwrap();

    let state = AppState::new(
        SurfacePaths {
            graph_data: Some(data_path),
            sessions_data: None,
            signals: None,
            static_dir: None,
        },
        SurfaceStatus::default(),
    );
    let app = create_router(state);
    let (status, body) = json_get(app, "/graph-data.json").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["nodes"], serde_json::json!([]));

    fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn get_api_signals_empty_when_absent() {
    let app = create_router(base_state());
    let (status, body) = json_get(app, "/api/signals").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total_signals"], 0);
    assert_eq!(body["signals"], serde_json::json!([]));
}

#[tokio::test]
async fn status_clients_reflects_hub_size() {
    let state = base_state();
    let _sub = state.hub.subscribe();
    state.set_port(3333);
    let app = create_router(state);
    let (_, body) = json_get(app, "/status").await;
    assert_eq!(body["clients"], 1);
    assert_eq!(body["port"], 3333);
}

async fn read_sse_until(body: &mut axum::body::BodyDataStream, needle: &str) -> String {
    let mut buf = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while tokio::time::Instant::now() < deadline {
        let next = tokio::time::timeout(Duration::from_millis(500), body.next()).await;
        match next {
            Ok(Some(Ok(bytes))) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                if buf.contains(needle) {
                    return buf;
                }
            }
            Ok(Some(Err(e))) => panic!("body error: {e}"),
            Ok(None) => break,
            Err(_) => continue,
        }
    }
    panic!("timed out waiting for {needle:?}; got: {buf:?}");
}

#[tokio::test]
async fn get_events_sse_handshake_and_broadcast() {
    let state = base_state();
    let hub = state.hub.clone();
    let app = create_router(state);
    let app_status = app.clone();

    let response = app
        .oneshot(
            Request::builder()
                .uri("/events")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let ct = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(
        ct.starts_with("text/event-stream"),
        "content-type was {ct:?}"
    );

    let mut stream = response.into_body().into_data_stream();
    let handshake = read_sse_until(&mut stream, "event: connected").await;
    assert!(handshake.contains(':') || handshake.contains("connected"));
    assert!(handshake.contains("data: ok") || handshake.contains("ok"));

    let (_, status_body) = json_get(app_status.clone(), "/status").await;
    assert_eq!(status_body["clients"], 1);

    hub.notify("updated", "2026-06-12T00:00:00Z");
    let live = read_sse_until(&mut stream, "event: updated").await;
    assert!(live.contains("2026-06-12T00:00:00Z"));

    // Drop stream → client disconnect → hub size 0
    drop(stream);
    // Give Drop a tick
    tokio::task::yield_now().await;
    let (_, status_body) = json_get(app_status, "/status").await;
    assert_eq!(status_body["clients"], 0);
}

#[tokio::test]
async fn get_api_kind_map_json_shape() {
    let app = create_router(base_state());
    let (status, body) = json_get(app, "/api/kind-map").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["harnesses"].as_array().unwrap().len() >= 8);
    assert!(body["kinds"].as_array().unwrap().len() >= 16);
    assert!(body["tools"].is_array());
    assert!(body["unknowns"].is_array());
    let cc = body["harnesses"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["id"] == "claude-code")
        .unwrap();
    assert!(cc["capabilities"]["trace"].as_bool().unwrap());
}

#[tokio::test]
async fn get_api_trace_not_found() {
    let app = create_router(base_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/trace/does-not-exist-session")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn get_api_signals_serves_file_when_present() {
    let dir = std::env::temp_dir().join(format!(
        "kaaro-signals-{}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("signals-data.json");
    let payload = serde_json::json!({
        "generated_at": "2026-07-19T12:00:00.000Z",
        "total_signals": 1,
        "by_level": { "WARN": 1 },
        "by_rule": { "r1": 1 },
        "signals": [{ "rule_id": "r1", "signal": "WARN" }],
    });
    fs::write(&path, serde_json::to_string(&payload).unwrap()).unwrap();

    let state = AppState::with_hub(
        SurfacePaths {
            graph_data: Some(PathBuf::from("/missing/graph-data.json")),
            sessions_data: None,
            signals: Some(path),
            static_dir: None,
        },
        SurfaceStatus::default(),
        SseHub::new(None),
    );
    let app = create_router(state);
    let (status, body) = json_get(app, "/api/signals").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total_signals"], 1);
    assert_eq!(body["by_level"]["WARN"], 1);
    assert_eq!(body["signals"][0]["rule_id"], "r1");
    let _ = fs::remove_dir_all(&dir);
}
