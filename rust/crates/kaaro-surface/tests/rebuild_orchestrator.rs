//! Mirrors `test/rebuild-orchestrator.test.mjs`.
use kaaro_surface::{
    AnalyzeRunner, BuildRunner, HubEvent, RebuildTarget, Rebuilder, SseHub, SurfaceStatus,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn recording_hub() -> (SseHub, Arc<Mutex<Vec<(String, String)>>>) {
    let hub = SseHub::new(None);
    let log = Arc::new(Mutex::new(Vec::new()));
    let log2 = log.clone();
    let mut sub = hub.subscribe();
    tokio::spawn(async move {
        while let Some(ev) = sub.receiver().recv().await {
            if let HubEvent::Named { event, data } = ev {
                log2.lock().unwrap().push((event, data));
            }
        }
    });
    (hub, log)
}

fn runners_from(
    analyze: impl Fn(Vec<String>) -> Result<(), String> + Send + Sync + 'static,
    build: impl Fn() -> Result<(), String> + Send + Sync + 'static,
) -> (AnalyzeRunner, BuildRunner) {
    let analyze = Arc::new(analyze);
    let build = Arc::new(build);
    let a: AnalyzeRunner = Arc::new(move |args| {
        let analyze = analyze.clone();
        Box::pin(async move { analyze(args) })
    });
    let b: BuildRunner = Arc::new(move || {
        let build = build.clone();
        Box::pin(async move { build() })
    });
    (a, b)
}

#[tokio::test]
async fn rebuild_runs_analyze_then_build_notifies_status_updated() {
    let (hub, log) = recording_hub();
    tokio::time::sleep(Duration::from_millis(10)).await;
    let calls = Arc::new(Mutex::new(Vec::<(String, Vec<String>)>::new()));
    let calls_a = calls.clone();
    let calls_b = calls.clone();
    let (analyze, build) = runners_from(
        move |args| {
            calls_a.lock().unwrap().push(("A".into(), args));
            Ok(())
        },
        move || {
            calls_b.lock().unwrap().push(("B".into(), vec![]));
            Ok(())
        },
    );
    let status = Arc::new(Mutex::new(SurfaceStatus::default()));
    let rb = Rebuilder::new(hub, status.clone(), analyze, build, 1500, None);
    rb.rebuild(None).await;
    tokio::time::sleep(Duration::from_millis(20)).await;

    let c = calls.lock().unwrap();
    assert_eq!(c[0].0, "A");
    assert_eq!(c[0].1, vec!["--all-harnesses"]);
    assert_eq!(c[1].0, "B");
    let events = log.lock().unwrap();
    assert_eq!(events[0].0, "status");
    assert_eq!(events[0].1, "rebuilding");
    assert_eq!(events.last().unwrap().0, "updated");
    assert!(!rb.rebuilding());
    assert!(rb.last_built().is_some());
    assert!(!status.lock().unwrap().rebuilding);
    assert!(status.lock().unwrap().last_built.is_some());
}

#[tokio::test]
async fn rebuild_on_snapshot_order() {
    let order = Arc::new(Mutex::new(Vec::new()));
    let (hub, _) = recording_hub();
    let oa = order.clone();
    let ob = order.clone();
    let (analyze, build) = runners_from(
        move |_| {
            oa.lock().unwrap().push("A".to_string());
            Ok(())
        },
        move || {
            ob.lock().unwrap().push("B".to_string());
            Ok(())
        },
    );
    let os = order.clone();
    let rb = Rebuilder::new(
        hub,
        Arc::new(Mutex::new(SurfaceStatus::default())),
        analyze,
        build,
        10,
        Some(Arc::new(move || {
            os.lock().unwrap().push("snap".to_string());
        })),
    );
    rb.rebuild(None).await;
    assert_eq!(*order.lock().unwrap(), vec!["A", "snap", "B"]);
}

#[tokio::test]
async fn rebuild_targeted_arg() {
    let (hub, _) = recording_hub();
    let calls = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
    let c2 = calls.clone();
    let (analyze, build) = runners_from(
        move |args| {
            c2.lock().unwrap().push(args);
            Ok(())
        },
        || Ok(()),
    );
    let rb = Rebuilder::new(
        hub,
        Arc::new(Mutex::new(SurfaceStatus::default())),
        analyze,
        build,
        10,
        None,
    );
    rb.rebuild(Some(RebuildTarget {
        rebuild_arg: Some("--session=P/s1".into()),
        harness_id: None,
    }))
    .await;
    assert_eq!(calls.lock().unwrap()[0], vec!["--session=P/s1"]);
}

#[tokio::test]
async fn overlapping_coalesce_one_follow_up() {
    let (hub, _) = recording_hub();
    let runs = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(tokio::sync::Mutex::new(None::<tokio::sync::oneshot::Sender<()>>));
    let runs_a = runs.clone();
    let gate_a = gate.clone();
    let analyze: AnalyzeRunner = Arc::new(move |_args| {
        let runs = runs_a.clone();
        let gate = gate_a.clone();
        Box::pin(async move {
            let n = runs.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                let (tx, rx) = tokio::sync::oneshot::channel();
                *gate.lock().await = Some(tx);
                let _ = rx.await;
            }
            Ok(())
        })
    });
    let runs_b = runs.clone();
    let build: BuildRunner = Arc::new(move || {
        let runs = runs_b.clone();
        Box::pin(async move {
            runs.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    });
    let rb = Rebuilder::new(
        hub,
        Arc::new(Mutex::new(SurfaceStatus::default())),
        analyze,
        build,
        10,
        None,
    );
    let first = {
        let rb = rb.clone();
        tokio::spawn(async move { rb.rebuild(None).await })
    };
    for _ in 0..100 {
        if gate.lock().await.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    rb.rebuild(None).await;
    rb.rebuild(None).await;
    assert!(rb.rebuilding());
    if let Some(tx) = gate.lock().await.take() {
        let _ = tx.send(());
    }
    first.await.unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(runs.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn rebuild_failure_notifies_error() {
    let (hub, log) = recording_hub();
    tokio::time::sleep(Duration::from_millis(10)).await;
    let (analyze, build) = runners_from(|_| Err("analyze exploded".into()), || Ok(()));
    let rb = Rebuilder::new(
        hub,
        Arc::new(Mutex::new(SurfaceStatus::default())),
        analyze,
        build,
        10,
        None,
    );
    rb.rebuild(None).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    let events = log.lock().unwrap();
    assert!(events
        .iter()
        .any(|(e, d)| e == "error" && d.contains("analyze exploded")));
    assert!(!rb.rebuilding());
}

#[tokio::test]
async fn schedule_rebuild_debounces() {
    let (hub, _) = recording_hub();
    let runs = Arc::new(AtomicUsize::new(0));
    let r2 = runs.clone();
    let r3 = runs.clone();
    let (analyze, build) = runners_from(
        move |_| {
            r2.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        move || {
            r3.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
    );
    let rb = Rebuilder::new(
        hub,
        Arc::new(Mutex::new(SurfaceStatus::default())),
        analyze,
        build,
        30,
        None,
    );
    rb.schedule_rebuild(None);
    rb.schedule_rebuild(None);
    rb.schedule_rebuild(None);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(runs.load(Ordering::SeqCst), 2, "one rebuild = analyze + build");
}
