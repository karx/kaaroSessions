//! Parity vs `test/scan-walk.test.mjs`.
use kaaro_core::scan_walk::{dir_names, walk_sessions, FsEntry, WalkItem};
use kaaro_core::session_reducer::{Capabilities, Session, SessionMeta};
use std::fs;
use std::path::PathBuf;

fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kaaro-scan-walk-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn stub_session(id: &str) -> Session {
    use kaaro_core::session_reducer::reduce_session;
    reduce_session(
        &[],
        &SessionMeta {
            session_id: id.into(),
            project_id: "p".into(),
            project_label: "p".into(),
            harness: "test".into(),
            file_size_bytes: 0,
            capabilities: Some(Capabilities {
                size_proxy: Some("tokens_work".into()),
            }),
        },
    )
}

#[test]
fn missing_root_returns_none() {
    let result = walk_sessions(
        PathBuf::from("/definitely/not/here-kaaro-xyz").as_path(),
        "pi",
        |_| vec![],
        None,
    )
    .unwrap();
    assert!(result.is_none());
}

#[test]
fn envelope_carries_harness_source_dir_sessions() {
    let root = temp_dir();
    fs::create_dir(root.join("proj-a")).unwrap();
    let root_clone = root.clone();
    let result = walk_sessions(
        &root,
        "pi",
        |entries| {
            dir_names(entries, false)
                .into_iter()
                .map(|name| {
                    let id = name.clone();
                    WalkItem {
                        id: name.clone(),
                        analyze: Box::new(move || Ok(Some(stub_session(&id)))),
                    }
                })
                .collect()
        },
        None,
    )
    .unwrap()
    .unwrap();
    assert_eq!(result.harness, "pi");
    assert_eq!(result.source_dir, root_clone);
    assert_eq!(result.sessions.len(), 1);
    assert_eq!(result.sessions[0].session_id, "proj-a");
    fs::remove_dir_all(root).ok();
}

#[test]
fn analyze_errors_isolated() {
    let root = temp_dir();
    fs::create_dir(root.join("bad")).unwrap();
    fs::create_dir(root.join("good")).unwrap();
    let result = walk_sessions(
        &root,
        "grok",
        |entries| {
            dir_names(entries, false)
                .into_iter()
                .map(|name| WalkItem {
                    id: name.clone(),
                    analyze: Box::new(move || {
                        if name == "bad" {
                            Err("corrupt".into())
                        } else {
                            Ok(Some(stub_session(&name)))
                        }
                    }),
                })
                .collect()
        },
        None,
    )
    .unwrap()
    .unwrap();
    assert_eq!(result.sessions.len(), 1);
    assert_eq!(result.sessions[0].session_id, "good");
    fs::remove_dir_all(root).ok();
}

#[test]
fn null_analyze_skipped() {
    let root = temp_dir();
    fs::create_dir(root.join("empty")).unwrap();
    let result = walk_sessions(
        &root,
        "copilot",
        |entries| {
            dir_names(entries, false)
                .into_iter()
                .map(|name| WalkItem {
                    id: name,
                    analyze: Box::new(|| Ok(None)),
                })
                .collect()
        },
        None,
    )
    .unwrap()
    .unwrap();
    assert!(result.sessions.is_empty());
    fs::remove_dir_all(root).ok();
}

#[test]
fn dir_names_sorted_dirs_only() {
    let entries = vec![
        FsEntry {
            name: "file.jsonl".into(),
            is_dir: false,
        },
        FsEntry {
            name: "b-dir".into(),
            is_dir: true,
        },
        FsEntry {
            name: "a-dir".into(),
            is_dir: true,
        },
    ];
    assert_eq!(dir_names(&entries, false), vec!["a-dir", "b-dir"]);
}

#[test]
fn dir_names_skip_hidden() {
    let entries = vec![
        FsEntry {
            name: ".hidden".into(),
            is_dir: true,
        },
        FsEntry {
            name: "visible".into(),
            is_dir: true,
        },
    ];
    assert_eq!(dir_names(&entries, true), vec!["visible"]);
}
