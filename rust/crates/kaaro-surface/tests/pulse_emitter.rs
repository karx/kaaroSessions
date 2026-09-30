//! Port of `test/pulse-emitter.test.mjs` (key cases).
use kaaro_surface::{
    snapshot_active, ActiveState, EmitCtx, HubEvent, PulseEmitter, SseHub, Subscription,
};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kaaro-pulse-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn cc_line() -> String {
    serde_json::json!({
        "type": "assistant",
        "timestamp": "2026-06-12T10:00:00.000Z",
        "message": {
            "model": "m",
            "usage": {"input_tokens": 5, "output_tokens": 3},
            "content": [{"type": "tool_use", "name": "Read", "input": {"file_path": "a.mjs"}}]
        }
    })
    .to_string()
}

fn cc_ctx() -> EmitCtx {
    EmitCtx::claude_code(
        "aaaabbbb-1111-2222-3333-444455556666",
        "aaaabbbb",
        "proj",
    )
}

async fn drain_events(sub: &mut Subscription, out: &mut Vec<(String, Value)>, rounds: usize) {
    for _ in 0..rounds {
        match tokio::time::timeout(Duration::from_millis(5), sub.receiver().recv()).await {
            Ok(Some(HubEvent::Named { event, data })) => {
                let v: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
                out.push((event, v));
            }
            Ok(Some(_)) => {}
            _ => break,
        }
    }
    while let Ok(Some(ev)) =
        tokio::time::timeout(Duration::from_millis(2), sub.receiver().recv()).await
    {
        if let HubEvent::Named { event, data } = ev {
            let v: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
            out.push((event, v));
        }
    }
}

#[tokio::test]
async fn tail_and_pulse_emits_and_advances_offset() {
    let dir = temp_dir();
    let fp = dir.join("s.jsonl");
    fs::write(&fp, format!("{}\n", cc_line())).unwrap();

    let hub = SseHub::new(None);
    let mut sub = hub.subscribe();
    let active = Arc::new(Mutex::new(ActiveState::new()));
    let emitter =
        PulseEmitter::with_options(hub.clone(), active.clone(), 60_000, 512 * 1024 * 1024, None);

    emitter.tail_and_pulse(&fp, &cc_ctx());
    let mut events = Vec::new();
    drain_events(&mut sub, &mut events, 20).await;
    let tool_calls: Vec<_> = events.iter().filter(|(e, _)| e == "tool_call").collect();
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0].1["slug"], "aaaabbbb");
    assert_eq!(tool_calls[0].1["key"], "read");

    let before_tools = events.iter().filter(|(e, _)| e == "tool_call").count();
    emitter.tail_and_pulse(&fp, &cc_ctx());
    drain_events(&mut sub, &mut events, 5).await;
    assert_eq!(
        events.iter().filter(|(e, _)| e == "tool_call").count(),
        before_tools
    );

    use std::io::Write;
    let mut f = fs::OpenOptions::new().append(true).open(&fp).unwrap();
    writeln!(f, "{}", cc_line()).unwrap();
    emitter.tail_and_pulse(&fp, &cc_ctx());
    drain_events(&mut sub, &mut events, 20).await;
    assert_eq!(events.iter().filter(|(e, _)| e == "tool_call").count(), 2);

    fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn feeds_active_state() {
    let dir = temp_dir();
    let fp = dir.join("s.jsonl");
    fs::write(&fp, format!("{}\n", cc_line())).unwrap();
    let hub = SseHub::new(None);
    let active = Arc::new(Mutex::new(ActiveState::new()));
    let emitter = PulseEmitter::new(hub, active.clone());
    emitter.tail_and_pulse(&fp, &cc_ctx());
    let snap = {
        let mut st = active.lock().unwrap();
        snapshot_active(&mut st, 1_750_000_000_000)
    };
    assert_eq!(snap.sessions.len(), 1);
    assert_eq!(snap.sessions[0]["slug"], "aaaabbbb");
    fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn trailing_now_coalesces() {
    let dir = temp_dir();
    let fp = dir.join("s.jsonl");
    fs::write(&fp, format!("{}\n{}\n", cc_line(), cc_line())).unwrap();
    let hub = SseHub::new(None);
    let mut sub = hub.subscribe();
    let active = Arc::new(Mutex::new(ActiveState::new()));
    let emitter = PulseEmitter::with_options(hub, active, 10, 512 * 1024 * 1024, None);
    emitter.tail_and_pulse(&fp, &cc_ctx());
    use std::io::Write;
    let mut f = fs::OpenOptions::new().append(true).open(&fp).unwrap();
    writeln!(f, "{}", cc_line()).unwrap();
    emitter.tail_and_pulse(&fp, &cc_ctx());

    tokio::time::sleep(Duration::from_millis(50)).await;
    let mut events = Vec::new();
    drain_events(&mut sub, &mut events, 50).await;
    let nows: Vec<_> = events.iter().filter(|(e, _)| e == "now").collect();
    assert_eq!(nows.len(), 1, "bursty tails collapse into one now");
    assert!(nows[0].1["sessions"].as_array().unwrap().len() >= 1);
    fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn missing_file_is_noop() {
    let hub = SseHub::new(None);
    let active = Arc::new(Mutex::new(ActiveState::new()));
    let emitter = PulseEmitter::new(hub, active);
    emitter.tail_and_pulse(std::path::Path::new("/nope/missing.jsonl"), &cc_ctx());
}

#[tokio::test]
async fn over_cap_delta_skips_and_advances() {
    let dir = temp_dir();
    let fp = dir.join("s.jsonl");
    let one = format!("{}\n", cc_line());
    let cap = (one.len() as u64) + 5;
    fs::write(&fp, format!("{one}{one}")).unwrap();
    let hub = SseHub::new(None);
    let mut sub = hub.subscribe();
    let active = Arc::new(Mutex::new(ActiveState::new()));
    let emitter = PulseEmitter::with_options(hub, active, 60_000, cap, None);
    emitter.tail_and_pulse(&fp, &cc_ctx());
    let mut events = Vec::new();
    drain_events(&mut sub, &mut events, 10).await;
    assert_eq!(events.iter().filter(|(e, _)| e == "tool_call").count(), 0);

    use std::io::Write;
    let mut f = fs::OpenOptions::new().append(true).open(&fp).unwrap();
    write!(f, "{one}").unwrap();
    emitter.tail_and_pulse(&fp, &cc_ctx());
    drain_events(&mut sub, &mut events, 20).await;
    assert_eq!(events.iter().filter(|(e, _)| e == "tool_call").count(), 1);
    fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn json_read_mode_dedupe() {
    let dir = temp_dir();
    let fp = dir.join("msg_x.json");
    let doc = serde_json::json!({
        "id": "msg_x", "sessionID": "ses_abcdef1234", "role": "assistant",
        "time": {"created": 1766698107679u64}, "modelID": "m", "providerID": "opencode",
        "tokens": {"input": 10, "output": 5, "reasoning": 0, "cache": {"read": 1, "write": 2}},
        "finish": "stop", "_parts": []
    });
    fs::write(&fp, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    let hub = SseHub::new(None);
    let mut sub = hub.subscribe();
    let active = Arc::new(Mutex::new(ActiveState::new()));
    let emitter = PulseEmitter::with_options(hub, active, 60_000, 512 * 1024 * 1024, None);
    let ctx = EmitCtx {
        harness: "opencode".into(),
        session_id: None,
        slug: None,
        project_id: None,
        project_label: None,
        read_mode: Some("json".into()),
    };
    emitter.tail_and_pulse(&fp, &ctx);
    let mut events = Vec::new();
    drain_events(&mut sub, &mut events, 30).await;
    let first = events.iter().filter(|(e, _)| e != "now").count();
    assert!(first > 0);
    emitter.tail_and_pulse(&fp, &ctx);
    drain_events(&mut sub, &mut events, 5).await;
    assert_eq!(events.iter().filter(|(e, _)| e != "now").count(), first);
    fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn api_active_reflects_applied_pulses() {
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use kaaro_surface::{create_router, AppState, SurfacePaths, SurfaceStatus};
    use tower::ServiceExt;

    let state = AppState::with_hub(
        SurfacePaths::default(),
        SurfaceStatus::default(),
        SseHub::new(None),
    );
    let pulse = serde_json::json!({
        "event": "tool_call",
        "data": {
            "session_id": "s-live", "slug": "s-live", "harness": "claude-code",
            "project": "demo", "tool": "Read", "key": "read", "where": "a.rs", "why": null
        }
    });
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let mut active = state.active.lock().unwrap();
        kaaro_surface::apply_pulse(&mut active, &pulse, now);
    }
    let app = create_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/active")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(body["sessions"][0]["slug"], "s-live");
    assert_eq!(body["totals"]["sessions"], 1);
}
