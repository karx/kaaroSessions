//! Harness-agnostic session transcript reading for `/api/trace`.

use crate::analyze::{read_grok_session, read_opencode_session, read_copilot_session};
use crate::jsonl::parse_jsonl_file;
use crate::trace_tree::TraceReconOpts;
use serde_json::Value;
use std::path::Path;

/// Result of reading a session transcript for trace reconstruction.
#[derive(Debug, Clone)]
pub struct SessionRecords {
    pub records: Vec<Value>,
    pub trace_opts: TraceReconOpts,
}

/// Read raw session records (+ optional side-channel trace opts) for a harness.
pub fn read_session_records(harness_id: &str, file_path: &Path) -> Result<SessionRecords, String> {
    match harness_id {
        "claude-code" | "codex" | "pi" | "command-code" | "antigravity" => {
            let (records, _) = parse_jsonl_file(file_path, None).map_err(|e| e.to_string())?;
            Ok(SessionRecords {
                records,
                trace_opts: TraceReconOpts::default(),
            })
        }
        "grok" => {
            let dir = file_path.parent().ok_or_else(|| "grok path missing parent".to_string())?;
            let (records, summary, _signals, _) = read_grok_session(dir)?;
            let ai_title = summary.as_ref().and_then(|s| {
                s.get("generated_title")
                    .or_else(|| s.get("session_summary"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            });
            let git_branch = summary
                .as_ref()
                .and_then(|s| s.get("head_branch"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            Ok(SessionRecords {
                records,
                trace_opts: TraceReconOpts {
                    ai_title,
                    git_branch,
                    ..Default::default()
                },
            })
        }
        "opencode" => {
            // storageRoot = three levels up from info file: session/<bucket>/<id>.json
            let storage_root = file_path
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
                .ok_or_else(|| "opencode path too shallow".to_string())?;
            let (_info, records, _) = read_opencode_session(storage_root, file_path)?;
            Ok(SessionRecords {
                records,
                trace_opts: TraceReconOpts::default(),
            })
        }
        "copilot" => {
            let (records, _) = read_copilot_session(file_path)?;
            Ok(SessionRecords {
                records,
                trace_opts: TraceReconOpts::default(),
            })
        }
        _ => Err(format!("unknown harness: {harness_id}")),
    }
}
