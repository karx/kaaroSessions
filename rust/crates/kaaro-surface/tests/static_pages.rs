//! Static HTML routes — stubs + artifact prefer.
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use kaaro_surface::{create_router, AppState, SseHub, SurfacePaths, SurfaceStatus};
use std::fs;
use std::path::PathBuf;
use tower::ServiceExt;

fn temp_static() -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "kaaro-static-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&d).unwrap();
    d
}

async fn get_html(app: axum::Router, uri: &str) -> (StatusCode, String) {
    let response = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn stub_graph_when_no_artifact() {
    let state = AppState::with_hub(
        SurfacePaths {
            graph_data: None,
            sessions_data: None,
            signals: None,
            static_dir: Some(temp_static()),
        },
        SurfaceStatus::default(),
        SseHub::new(None),
    );
    let app = create_router(state);
    let (st, body) = get_html(app, "/graph").await;
    assert_eq!(st, StatusCode::OK);
    assert!(body.contains("stub") || body.contains("graph-data.json"));
}

#[tokio::test]
async fn prefers_graph_html_from_static_dir() {
    let dir = temp_static();
    fs::write(dir.join("graph.html"), "<html><body>REAL_GRAPH</body></html>").unwrap();
    let state = AppState::with_hub(
        SurfacePaths {
            graph_data: Some(dir.join("graph-data.json")),
            sessions_data: None,
            signals: None,
            static_dir: Some(dir),
        },
        SurfaceStatus::default(),
        SseHub::new(None),
    );
    let app = create_router(state);
    let (st, body) = get_html(app, "/graph").await;
    assert_eq!(st, StatusCode::OK);
    assert!(body.contains("REAL_GRAPH"));
}

#[tokio::test]
async fn home_falls_back_to_graph_html() {
    let dir = temp_static();
    fs::write(dir.join("graph.html"), "<html>G</html>").unwrap();
    let state = AppState::with_hub(
        SurfacePaths {
            graph_data: None,
            sessions_data: None,
            signals: None,
            static_dir: Some(dir),
        },
        SurfaceStatus::default(),
        SseHub::new(None),
    );
    let (st, body) = get_html(create_router(state), "/").await;
    assert_eq!(st, StatusCode::OK);
    assert!(body.contains(">G<") || body.contains("<html>G</html>"));
}

#[tokio::test]
async fn now_stub_loads_api_active() {
    let state = AppState::with_hub(
        SurfacePaths {
            graph_data: None,
            sessions_data: None,
            signals: None,
            static_dir: Some(temp_static()),
        },
        SurfaceStatus::default(),
        SseHub::new(None),
    );
    let (st, body) = get_html(create_router(state), "/now").await;
    assert_eq!(st, StatusCode::OK);
    assert!(body.contains("/api/active") || body.contains("Mission Control"));
}
