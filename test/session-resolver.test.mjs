import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveClaudeCodeSession,
  resolvePiSession,
  resolveAntigravitySession,
  resolveGrokSession,
  resolveSessionFile,
} from '../surface/session-resolver.mjs';

function makeTemp(prefix) {
  const dir = join(tmpdir(), prefix + '-' + Date.now());
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('resolveClaudeCodeSession — finds project session file', () => {
  const root = makeTemp('kaaro-res-cc');
  try {
    const proj = join(root, 'D--src-foo');
    mkdirSync(proj);
    const sessionId = 'abc-def-123';
    writeFileSync(join(proj, `${sessionId}.jsonl`), '{"type":"user"}\n', 'utf8');

    const found = resolveClaudeCodeSession(sessionId, root);
    assert.ok(found);
    assert.equal(found.projectId, 'D--src-foo');
    assert.equal(found.sessionId, sessionId);
    assert.ok(found.filePath.endsWith(`${sessionId}.jsonl`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveClaudeCodeSession — finds session by 8-char slug prefix', () => {
  const root = makeTemp('kaaro-res-cc-slug');
  try {
    const proj = join(root, 'D--src-foo');
    mkdirSync(proj);
    const sessionId = '01a03426-46ee-77e0-bf36-f87a6403b5db';
    writeFileSync(join(proj, `${sessionId}.jsonl`), '{"type":"user"}\n', 'utf8');

    const found = resolveClaudeCodeSession(sessionId.slice(0, 8), root);
    assert.ok(found);
    assert.equal(found.sessionId, sessionId);
    assert.equal(found.projectId, 'D--src-foo');
    assert.ok(found.filePath.endsWith(`${sessionId}.jsonl`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveClaudeCodeSession — finds subagents session by 8-char slug prefix', () => {
  const root = makeTemp('kaaro-res-cc-sub-slug');
  try {
    const sub = join(root, 'D--src-foo', 'subagents');
    mkdirSync(sub, { recursive: true });
    const sessionId = '01a03426-46ee-77e0-bf36-f87a6403b5db';
    writeFileSync(join(sub, `${sessionId}.jsonl`), '{}', 'utf8');

    const found = resolveClaudeCodeSession(sessionId.slice(0, 8), root);
    assert.ok(found);
    assert.equal(found.sessionId, sessionId);
    assert.equal(found.projectId, 'D--src-foo');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveClaudeCodeSession — finds subagents session file', () => {
  const root = makeTemp('kaaro-res-cc-sub');
  try {
    const sub = join(root, 'D--src-foo', 'subagents');
    mkdirSync(sub, { recursive: true });
    const sessionId = 'sub-sess-01';
    writeFileSync(join(sub, `${sessionId}.jsonl`), '{}', 'utf8');

    const found = resolveClaudeCodeSession(sessionId, root);
    assert.ok(found);
    assert.equal(found.projectId, 'D--src-foo');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolvePiSession — matches UUID after timestamp prefix', () => {
  const root = makeTemp('kaaro-res-pi');
  try {
    const proj = join(root, '--D--src-ebrain--');
    mkdirSync(proj);
    const sessionId = '019dca2b-f4f5-7609-96ae-fe883f7a03db';
    const file = `2026-04-26T14-22-51-638Z_${sessionId}.jsonl`;
    writeFileSync(join(proj, file), '{}', 'utf8');

    const found = resolvePiSession(sessionId, root);
    assert.ok(found);
    assert.equal(found.projectId, '--D--src-ebrain--');
    assert.equal(found.sessionId, sessionId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolvePiSession — finds session by 8-char slug prefix', () => {
  const root = makeTemp('kaaro-res-pi-slug');
  try {
    const proj = join(root, '--D--src-ebrain--');
    mkdirSync(proj);
    const sessionId = '019dca2b-f4f5-7609-96ae-fe883f7a03db';
    const file = `2026-04-26T14-22-51-638Z_${sessionId}.jsonl`;
    writeFileSync(join(proj, file), '{}', 'utf8');

    const found = resolvePiSession(sessionId.slice(0, 8), root);
    assert.ok(found);
    assert.equal(found.sessionId, sessionId);
    assert.equal(found.projectId, '--D--src-ebrain--');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveAntigravitySession — prefers transcript.jsonl', () => {
  const root = makeTemp('kaaro-res-ag');
  try {
    const sessionId = 'c7f6b422-2184-4e11-ad6d-535a069e7347';
    const logs = join(root, sessionId, '.system_generated', 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'transcript.jsonl'), '{}', 'utf8');
    writeFileSync(join(logs, 'overview.txt'), '{}', 'utf8');

    const found = resolveAntigravitySession(sessionId, root);
    assert.ok(found);
    assert.ok(found.filePath.endsWith('transcript.jsonl'));
    assert.equal(found.sessionId, sessionId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveAntigravitySession — falls back to overview.txt', () => {
  const root = makeTemp('kaaro-res-ag-ov');
  try {
    const sessionId = 'c7f6b422-2184-4e11-ad6d-535a069e7347';
    const logs = join(root, sessionId, '.system_generated', 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'overview.txt'), '{}', 'utf8');

    const found = resolveAntigravitySession(sessionId, root);
    assert.ok(found);
    assert.ok(found.filePath.endsWith('overview.txt'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveGrokSession — finds updates.jsonl under encoded cwd', () => {
  const root = makeTemp('kaaro-res-grok');
  try {
    const sessionId = '019ea1c9-46ee-77e0-bf36-f87a6403b5db';
    const sessionDir = join(root, 'D%3A%5Csrc%5CkaaroSessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'updates.jsonl'), '{}', 'utf8');

    const found = resolveGrokSession(sessionId, root);
    assert.ok(found);
    assert.ok(found.filePath.endsWith('updates.jsonl'));
    assert.equal(found.projectId, 'D%3A%5Csrc%5CkaaroSessions');

    const byPrefix = resolveGrokSession(sessionId.slice(0, 8), root);
    assert.ok(byPrefix);
    assert.equal(byPrefix.sessionId, sessionId);
    assert.ok(byPrefix.filePath.endsWith('updates.jsonl'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveSessionFile — dispatches by harness order', () => {
  const ccRoot = makeTemp('kaaro-res-dispatch-cc');
  const piRoot = makeTemp('kaaro-res-dispatch-pi');
  try {
    const sessionId = 'shared-id-123';
    const ccProj = join(ccRoot, 'D--src-foo');
    mkdirSync(ccProj);
    writeFileSync(join(ccProj, `${sessionId}.jsonl`), '{}', 'utf8');

    const cc = resolveSessionFile(sessionId, {
      harness: 'claude-code',
      roots: { 'claude-code': ccRoot },
    });
    assert.equal(cc.harness, 'claude-code');

    const piProj = join(piRoot, '--proj--');
    mkdirSync(piProj);
    writeFileSync(join(piProj, `${sessionId}.jsonl`), '{}', 'utf8');
    const pi = resolvePiSession(sessionId, piRoot);
    assert.ok(pi);

    assert.equal(resolveSessionFile('missing-id', { harness: 'claude-code' }), null);
  } finally {
    rmSync(ccRoot, { recursive: true, force: true });
    rmSync(piRoot, { recursive: true, force: true });
  }
});
// ── opencode + copilot locators (N5 trace support) ────────────────────────────

test('resolveSessionFile — locates opencode session info across buckets', async () => {
  const { mkdirSync: mk, writeFileSync: wr, rmSync: rm } = await import('fs');
  const { tmpdir } = await import('os');
  const root = join(tmpdir(), 'kaaro-oc-loc-' + Date.now());
  mk(join(root, 'session', 'bucketA'), { recursive: true });
  wr(join(root, 'session', 'bucketA', 'ses_abc123.json'), '{"id":"ses_abc123"}', 'utf8');
  try {
    const found = resolveSessionFile('ses_abc123', { harness: 'opencode', roots: { opencode: root } });
    assert.ok(found, 'opencode session located');
    assert.equal(found.harness, 'opencode');
    assert.ok(found.filePath.endsWith('ses_abc123.json'));
  } finally { rm(root, { recursive: true, force: true }); }
});

test('resolveSessionFile — locates copilot chat session in workspace storage', async () => {
  const { mkdirSync: mk, writeFileSync: wr, rmSync: rm } = await import('fs');
  const { tmpdir } = await import('os');
  const root = join(tmpdir(), 'kaaro-cp-loc-' + Date.now());
  mk(join(root, 'ws-hash-1', 'chatSessions'), { recursive: true });
  wr(join(root, 'ws-hash-1', 'chatSessions', 'sess-42.jsonl'), '{"kind":0,"v":{}}', 'utf8');
  try {
    const found = resolveSessionFile('sess-42', { harness: 'copilot', roots: { copilot: root } });
    assert.ok(found, 'copilot session located');
    assert.equal(found.harness, 'copilot');
    assert.ok(found.filePath.endsWith('sess-42.jsonl'));
  } finally { rm(root, { recursive: true, force: true }); }
});

// ── 8-char slug prefix parity (Mission Control, graph slug, /api/trace) ──

test('resolveSessionFile — locates opencode session in opencode.db (both exact and 8-char slug)', async () => {
  const DatabaseSync = process.getBuiltinModule?.('node:sqlite')?.DatabaseSync;
  if (!DatabaseSync) return;

  const { mkdirSync: mk, rmSync: rm } = await import('fs');
  const { tmpdir } = await import('os');
  const root = join(tmpdir(), 'kaaro-oc-db-loc-' + Date.now());
  mk(root, { recursive: true });
  const dbPath = join(root, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      directory TEXT,
      time_updated INTEGER
    );
    INSERT INTO session (id, project_id, directory, time_updated)
    VALUES ('ses_f7364216999999', 'proj_abc', 'D:\\\\src\\\\test', 500);
  `);
  db.close();

  try {
    // 1. Exact ID
    const exact = resolveSessionFile('ses_f7364216999999', { harness: 'opencode', roots: { opencode: root } });
    assert.ok(exact, 'opencode session located in sqlite');
    assert.equal(exact.sessionId, 'ses_f7364216999999');
    assert.equal(exact.projectId, 'proj_abc');
    assert.equal(exact.harness, 'opencode');
    assert.equal(exact.format, 'sqlite');

    // 2. 8-char slug prefix
    const prefix = resolveSessionFile('f7364216', { harness: 'opencode', roots: { opencode: root } });
    assert.ok(prefix, 'opencode session located by slug prefix in sqlite');
    assert.equal(prefix.sessionId, 'ses_f7364216999999');
  } finally {
    rm(root, { recursive: true, force: true });
  }
});

test('resolveSessionFile — locates opencode session by 8-char slug prefix', async () => {
  const { mkdirSync: mk, writeFileSync: wr, rmSync: rm } = await import('fs');
  const { tmpdir } = await import('os');
  const root = join(tmpdir(), 'kaaro-oc-slug-' + Date.now());
  mk(join(root, 'session', 'bucketA'), { recursive: true });
  const sessionId = 'ses_abc123def456';
  wr(join(root, 'session', 'bucketA', `${sessionId}.json`), `{"id":"${sessionId}"}`, 'utf8');
  try {
    const found = resolveSessionFile(sessionId.slice(0, 8), { harness: 'opencode', roots: { opencode: root } });
    assert.ok(found, 'opencode session located by prefix');
    assert.equal(found.sessionId, sessionId);
    assert.ok(found.filePath.endsWith(`${sessionId}.json`));
  } finally { rm(root, { recursive: true, force: true }); }
});

test('resolveSessionFile — locates copilot chat session by 8-char slug prefix', async () => {
  const { mkdirSync: mk, writeFileSync: wr, rmSync: rm } = await import('fs');
  const { tmpdir } = await import('os');
  const root = join(tmpdir(), 'kaaro-cp-slug-' + Date.now());
  mk(join(root, 'ws-hash-1', 'chatSessions'), { recursive: true });
  const sessionId = '01a03426-46ee-77e0-bf36-f87a6403b5db';
  wr(join(root, 'ws-hash-1', 'chatSessions', `${sessionId}.jsonl`), '{"kind":0,"v":{}}', 'utf8');
  try {
    const found = resolveSessionFile(sessionId.slice(0, 8), { harness: 'copilot', roots: { copilot: root } });
    assert.ok(found, 'copilot session located by prefix');
    assert.equal(found.sessionId, sessionId);
    assert.ok(found.filePath.endsWith(`${sessionId}.jsonl`));
  } finally { rm(root, { recursive: true, force: true }); }
});

test('resolveSessionFile — locates codex session by 8-char slug prefix', async () => {
  const { mkdirSync: mk, writeFileSync: wr, rmSync: rm } = await import('fs');
  const { tmpdir } = await import('os');
  const root = join(tmpdir(), 'kaaro-codex-slug-' + Date.now());
  mk(join(root, 'sessions', '2026', '08', '29'), { recursive: true });
  const sessionId = '01a04d21-a44b-7e80-b264-f41065cdf768';
  wr(join(root, 'sessions', '2026', '08', '29', `rollout-2026-08-29T16-17-25-${sessionId}.jsonl`), '{}', 'utf8');
  try {
    const found = resolveSessionFile(sessionId.slice(0, 8), { harness: 'codex', roots: { codex: root } });
    assert.ok(found, 'codex session located by prefix');
    assert.equal(found.sessionId, sessionId);
  } finally { rm(root, { recursive: true, force: true }); }
});

test('resolveSessionFile — locates command-code session by 8-char slug prefix', async () => {
  const { mkdirSync: mk, writeFileSync: wr, rmSync: rm } = await import('fs');
  const { tmpdir } = await import('os');
  const root = join(tmpdir(), 'kaaro-cmdc-slug-' + Date.now());
  mk(join(root, 'D--src-foo'), { recursive: true });
  const sessionId = '02b14537-57ff-88f1-c047-g98b7514c6ec';
  wr(join(root, 'D--src-foo', `${sessionId}.jsonl`), '{}', 'utf8');
  try {
    const found = resolveSessionFile(sessionId.slice(0, 8), { harness: 'command-code', roots: { 'command-code': root } });
    assert.ok(found, 'command-code session located by prefix');
    assert.equal(found.sessionId, sessionId);
    assert.equal(found.projectId, 'D--src-foo');
  } finally { rm(root, { recursive: true, force: true }); }
});
