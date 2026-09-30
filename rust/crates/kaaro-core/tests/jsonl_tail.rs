//! Port of key cases from `test/jsonl-tail.test.mjs`.
use kaaro_core::jsonl::{tail_read, MAX_JSONL_BYTES};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

fn temp() -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "kaaro-tail-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn from_offset_zero() {
    let d = temp();
    let fp = d.join("a.jsonl");
    fs::write(&fp, "{\"a\":1}\n{\"b\":2}\n").unwrap();
    let r = tail_read(&fp, 0, None).unwrap();
    assert_eq!(r.records.len(), 2);
    assert_eq!(r.new_offset, fp.metadata().unwrap().len());
    fs::remove_dir_all(d).ok();
}

#[test]
fn incremental_and_append() {
    let d = temp();
    let fp = d.join("inc.jsonl");
    let line1 = "{\"first\":1}\n";
    fs::write(&fp, line1).unwrap();
    let r1 = tail_read(&fp, 0, None).unwrap();
    assert_eq!(r1.records.len(), 1);
    let mut f = fs::OpenOptions::new().append(true).open(&fp).unwrap();
    write!(f, "{{\"second\":2}}\n").unwrap();
    drop(f);
    let r2 = tail_read(&fp, r1.new_offset, None).unwrap();
    assert_eq!(r2.records.len(), 1);
    assert_eq!(r2.records[0]["second"], 2);
    fs::remove_dir_all(d).ok();
}

#[test]
fn partial_line_deferred() {
    let d = temp();
    let fp = d.join("partial.jsonl");
    fs::write(&fp, "{\"complete\":1}\n{\"incomplete\":2").unwrap();
    let r = tail_read(&fp, 0, None).unwrap();
    assert_eq!(r.records.len(), 1);
    assert_eq!(r.new_offset, "{\"complete\":1}\n".len() as u64);
    fs::remove_dir_all(d).ok();
}

#[test]
fn missing_file() {
    let r = tail_read(std::path::Path::new("/nonexistent/x.jsonl"), 0, None).unwrap();
    assert!(r.records.is_empty());
    assert_eq!(r.new_offset, 0);
}

#[test]
fn over_cap_jumps_eof() {
    let d = temp();
    let fp = d.join("huge.jsonl");
    let content = "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n";
    fs::write(&fp, content).unwrap();
    let r = tail_read(&fp, 0, Some(4)).unwrap();
    assert!(r.records.is_empty());
    assert_eq!(r.new_offset, content.len() as u64);
    assert_eq!(r.skipped_bytes, Some(content.len() as u64));
    assert_eq!(MAX_JSONL_BYTES, 512 * 1024 * 1024);
    fs::remove_dir_all(d).ok();
}
