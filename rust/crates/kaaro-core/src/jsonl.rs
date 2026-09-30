//! Minimal JSONL helpers — port of the parse path in `hooks/jsonl-io.mjs`.

use serde_json::Value;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum JsonlError {
    #[error("jsonl line {line}: {source}")]
    Parse {
        line: usize,
        #[source]
        source: serde_json::Error,
    },
}

/// Parse a JSONL string into a vec of JSON values. Blank lines are skipped.
pub fn parse_jsonl_str(raw: &str) -> Result<Vec<Value>, JsonlError> {
    let mut out = Vec::new();
    for (i, line) in raw.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(trimmed).map_err(|source| JsonlError::Parse {
            line: i + 1,
            source,
        })?;
        out.push(v);
    }
    Ok(out)
}

/// Default max JSONL size (512 MiB) — matches JS `MAX_JSONL_BYTES`.
pub const MAX_JSONL_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum JsonlFileError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("JSONL file too large to parse ({size_mb:.1}MB > {cap_mb:.1}MB cap): {path}")]
    TooLarge {
        size_mb: f64,
        cap_mb: f64,
        path: String,
    },
    #[error(transparent)]
    Parse(#[from] JsonlError),
}

/// Read a JSONL file from disk. Malformed lines are skipped (JS parity).
pub fn parse_jsonl_file(
    path: &Path,
    max_bytes: Option<u64>,
) -> Result<(Vec<Value>, u64), JsonlFileError> {
    let max_bytes = max_bytes.unwrap_or(MAX_JSONL_BYTES);
    let meta = std::fs::metadata(path)?;
    let size = meta.len();
    if size > max_bytes {
        return Err(JsonlFileError::TooLarge {
            size_mb: size as f64 / 1024.0 / 1024.0,
            cap_mb: max_bytes as f64 / 1024.0 / 1024.0,
            path: path.display().to_string(),
        });
    }
    let raw = std::fs::read_to_string(path)?;
    let size_bytes = raw.len() as u64;
    let mut records = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str(trimmed) {
            Ok(v) => records.push(v),
            Err(_) => { /* skip malformed — JS parity */ }
        }
    }
    Ok((records, size_bytes))
}

/// Result of a byte-offset JSONL tail (JS `tailRead`).
#[derive(Debug, Clone)]
pub struct TailReadResult {
    pub records: Vec<Value>,
    pub new_offset: u64,
    pub skipped_bytes: Option<u64>,
}

/// Read only bytes appended since `byte_offset`. Incomplete trailing lines
/// are deferred (offset stays at last complete newline). Oversized deltas
/// jump to EOF with `skipped_bytes` set.
pub fn tail_read(path: &Path, byte_offset: u64, max_bytes: Option<u64>) -> std::io::Result<TailReadResult> {
    let max_bytes = max_bytes.unwrap_or(MAX_JSONL_BYTES);
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TailReadResult {
                records: Vec::new(),
                new_offset: 0,
                skipped_bytes: None,
            });
        }
        Err(e) => return Err(e),
    };
    let size = meta.len();
    if size <= byte_offset {
        return Ok(TailReadResult {
            records: Vec::new(),
            new_offset: byte_offset,
            skipped_bytes: None,
        });
    }
    let read_len = size - byte_offset;
    if read_len > max_bytes {
        return Ok(TailReadResult {
            records: Vec::new(),
            new_offset: size,
            skipped_bytes: Some(read_len),
        });
    }

    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::Start(byte_offset))?;
    let mut buf = vec![0u8; read_len as usize];
    f.read_exact(&mut buf)?;

    let mut last_nl: Option<usize> = None;
    for i in (0..buf.len()).rev() {
        if buf[i] == b'\n' {
            last_nl = Some(i);
            break;
        }
    }
    let Some(last_nl) = last_nl else {
        return Ok(TailReadResult {
            records: Vec::new(),
            new_offset: byte_offset,
            skipped_bytes: None,
        });
    };

    let complete = &buf[..=last_nl];
    let new_offset = byte_offset + last_nl as u64 + 1;
    let text = String::from_utf8_lossy(complete);
    let mut records = Vec::new();
    for raw in text.split('\n') {
        let line = raw.trim_end_matches('\r').trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str(line) {
            records.push(v);
        }
    }
    Ok(TailReadResult {
        records,
        new_offset,
        skipped_bytes: None,
    })
}
