//! Shared scanner skeleton — port of `hooks/scan-walk.mjs`.

use crate::session_reducer::Session;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Directory listing entry (name + is_dir).
#[derive(Debug, Clone)]
pub struct FsEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Scan result envelope.
#[derive(Debug, Clone)]
pub struct ScanEnvelope {
    pub harness: String,
    pub source_dir: PathBuf,
    pub sessions: Vec<Session>,
}

/// List directory entries. `NotFound` is returned as-is for the caller.
pub fn list_entries(root: &Path) -> io::Result<Vec<FsEntry>> {
    let mut out = Vec::new();
    for ent in fs::read_dir(root)? {
        let ent = ent?;
        let file_type = ent.file_type()?;
        out.push(FsEntry {
            name: ent.file_name().to_string_lossy().into_owned(),
            is_dir: file_type.is_dir(),
        });
    }
    Ok(out)
}

/// Directory names only, sorted. `skip_hidden` drops dot-dirs.
pub fn dir_names(entries: &[FsEntry], skip_hidden: bool) -> Vec<String> {
    let mut names: Vec<String> = entries
        .iter()
        .filter(|e| e.is_dir)
        .filter(|e| !(skip_hidden && e.name.starts_with('.')))
        .map(|e| e.name.clone())
        .collect();
    names.sort();
    names
}

/// One work item yielded by a harness iterate callback.
pub struct WalkItem {
    pub id: String,
    /// Returns Ok(Some(session)), Ok(None) to skip, Err to isolate & continue.
    pub analyze: Box<dyn FnOnce() -> Result<Option<Session>, String>>,
}

/// Walk a root: ENOENT → `Ok(None)`; per-item analyze errors are isolated.
pub fn walk_sessions<F>(
    root: &Path,
    harness: &str,
    iterate: F,
    source_dir: Option<&Path>,
) -> io::Result<Option<ScanEnvelope>>
where
    F: FnOnce(&[FsEntry]) -> Vec<WalkItem>,
{
    let entries = match list_entries(root) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };

    let mut sessions = Vec::new();
    for item in iterate(&entries) {
        match (item.analyze)() {
            Ok(Some(s)) => sessions.push(s),
            Ok(None) => {}
            Err(msg) => {
                eprintln!("  !! [{harness}] {}: {msg}", item.id);
            }
        }
    }

    Ok(Some(ScanEnvelope {
        harness: harness.to_string(),
        source_dir: source_dir.unwrap_or(root).to_path_buf(),
        sessions,
    }))
}
