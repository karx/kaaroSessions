//! Poll watcher → pulse path integration.
use kaaro_surface::{
    snapshot_active, ActiveState, FileWatchService, HarnessRoot, PulseEmitter, SseHub,
};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn temp_root() -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "kaaro-watch-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&d).unwrap();
    d
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

#[tokio::test]
async fn handle_watch_event_pulses_active() {
    let root = temp_root();
    let proj = root.join("D--src-foo");
    fs::create_dir_all(&proj).unwrap();
    let fp = proj.join("aaaabbbb-1111-2222-3333-444455556666.jsonl");
    fs::write(&fp, format!("{}\n", cc_line())).unwrap();

    let hub = SseHub::new(None);
    let active = Arc::new(Mutex::new(ActiveState::new()));
    let emitter = PulseEmitter::with_options(hub, active.clone(), 60_000, 512 * 1024 * 1024, None);
    let watch = FileWatchService::new(
        vec![HarnessRoot {
            harness_id: "claude-code".into(),
            root: root.clone(),
        }],
        emitter,
        Duration::from_millis(1),
    );

    let ok = watch.handle_watch_event(
        "claude-code",
        &root,
        "D--src-foo/aaaabbbb-1111-2222-3333-444455556666.jsonl",
    );
    assert!(ok);
    let snap = {
        let mut st = active.lock().unwrap();
        snapshot_active(&mut st, 1_750_000_000_000)
    };
    assert_eq!(snap.sessions.len(), 1);
    assert_eq!(snap.sessions[0]["slug"], "aaaabbbb");
    fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn poll_tick_sees_append_after_seed() {
    let root = temp_root();
    let proj = root.join("D--src-foo");
    fs::create_dir_all(&proj).unwrap();
    let fp = proj.join("sess-watch-1.jsonl");
    fs::write(&fp, format!("{}\n", cc_line())).unwrap();

    let hub = SseHub::new(None);
    let active = Arc::new(Mutex::new(ActiveState::new()));
    let emitter = PulseEmitter::with_options(hub, active.clone(), 60_000, 512 * 1024 * 1024, None);
    let watch = FileWatchService::new(
        vec![HarnessRoot {
            harness_id: "claude-code".into(),
            root: root.clone(),
        }],
        emitter,
        Duration::from_millis(5),
    );

    // Seed existing file without pulsing.
    watch.seed();
    assert_eq!(active.lock().unwrap().session_count(), 0);

    // Append → scan queues → wait debounce → flush
    {
        let mut f = fs::OpenOptions::new().append(true).open(&fp).unwrap();
        writeln!(f, "{}", cc_line()).unwrap();
    }
    let queued = watch.scan_once(false);
    assert!(queued >= 1);
    tokio::time::sleep(Duration::from_millis(20)).await;
    let flushed = watch.flush_due();
    assert!(flushed >= 1);

    let snap = {
        let mut st = active.lock().unwrap();
        snapshot_active(&mut st, 1_750_000_000_000)
    };
    assert_eq!(snap.sessions.len(), 1);
    assert_eq!(snap.sessions[0]["session_id"], "sess-watch-1");
    fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn tick_helper_seeds_then_pulses_on_change() {
    let root = temp_root();
    let proj = root.join("D--src-bar");
    fs::create_dir_all(&proj).unwrap();
    let fp = proj.join("sess-tick.jsonl");
    fs::write(&fp, format!("{}\n", cc_line())).unwrap();

    let hub = SseHub::new(None);
    let active = Arc::new(Mutex::new(ActiveState::new()));
    let emitter = PulseEmitter::with_options(hub, active.clone(), 60_000, 512 * 1024 * 1024, None);
    let watch = FileWatchService::new(
        vec![HarnessRoot {
            harness_id: "claude-code".into(),
            root: root.clone(),
        }],
        emitter,
        Duration::from_millis(5),
    );

    assert_eq!(watch.tick(), 0); // seed only
    {
        let mut f = fs::OpenOptions::new().append(true).open(&fp).unwrap();
        writeln!(f, "{}", cc_line()).unwrap();
    }
    watch.scan_once(false);
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(watch.tick() >= 1 || watch.flush_due() >= 1 || active.lock().unwrap().session_count() >= 1);
    // Ensure pulse landed (flush if still pending)
    tokio::time::sleep(Duration::from_millis(20)).await;
    watch.flush_due();
    assert!(active.lock().unwrap().session_count() >= 1);
    fs::remove_dir_all(root).ok();
}
