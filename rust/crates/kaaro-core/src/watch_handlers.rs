//! Registry-driven watch event routing — port of `surface/watch-handlers.mjs`.

use crate::registry::{get_harness, WatchCtx};
use std::path::{Path, PathBuf};

/// Result of matching a relative watch filename against a harness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessedWatch {
    pub ctx: WatchCtx,
    pub abs_path: PathBuf,
    pub rebuild_arg: Option<String>,
    pub harness_id: String,
    pub rel_path: String,
}

/// Map `(harnessId, relative filename, rootDir)` → pulse/rebuild target, or None.
pub fn process_watch_filename(
    harness_id: &str,
    filename: Option<&str>,
    root_dir: &Path,
) -> Option<ProcessedWatch> {
    let filename = filename.filter(|s| !s.is_empty())?;
    let rel_path = filename.replace('\\', "/");
    let harness = get_harness(harness_id)?;
    if !(harness.match_log_file)(&rel_path) {
        return None;
    }
    let ctx = (harness.ctx_from_path)(&rel_path)?;
    let rebuild_arg = (harness.rebuild_arg)(&rel_path);
    Some(ProcessedWatch {
        ctx,
        abs_path: root_dir.join(filename),
        rebuild_arg,
        harness_id: harness_id.to_string(),
        rel_path,
    })
}
