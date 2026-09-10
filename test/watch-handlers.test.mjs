import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processWatchFilename } from '../surface/watch-handlers.mjs';

const ROOT = 'C:/fake/root';

test('processWatchFilename — claude-code jsonl', () => {
  const r = processWatchFilename('claude-code', 'D--src-foo/abc-def-123.jsonl', ROOT);
  assert.ok(r);
  assert.equal(r.ctx.harness, 'claude-code');
  assert.equal(r.ctx.session_id, 'abc-def-123');
  assert.equal(r.rebuildArg, '--session=D--src-foo/abc-def-123.jsonl');
  assert.equal(r.absPath.replace(/\\/g, '/'), 'C:/fake/root/D--src-foo/abc-def-123.jsonl');
});

test('processWatchFilename — claude-code nested subagent attributes to parent', () => {
  const r = processWatchFilename(
    'claude-code',
    'D--src-foo/abc-def-123/subagents/agent-a3e11a292d609acd8.jsonl',
    ROOT,
  );
  assert.ok(r);
  assert.equal(r.ctx.harness, 'claude-code');
  assert.equal(r.ctx.session_id, 'abc-def-123', 'parent session, not agent id');
  assert.equal(r.ctx.agent_id, 'a3e11a292d609acd8');
  assert.equal(r.ctx.slug, 'abc-def-');
  assert.equal(r.rebuildArg, '--session=D--src-foo/abc-def-123.jsonl');
});

test('processWatchFilename — claude-code sidechain meta.json rebuilds parent', () => {
  const r = processWatchFilename(
    'claude-code',
    'D--src-foo/abc-def-123/subagents/agent-a3e11a292d609acd8.meta.json',
    ROOT,
  );
  assert.ok(r, 'meta under subagents is a watched log');
  assert.equal(r.ctx.harness, 'claude-code');
  assert.equal(r.ctx.session_id, 'abc-def-123');
  assert.equal(r.ctx.agent_id, 'a3e11a292d609acd8');
  assert.equal(r.rebuildArg, '--session=D--src-foo/abc-def-123.jsonl');
});

test('processWatchFilename — rejects non-log files', () => {
  assert.equal(processWatchFilename('claude-code', 'D--src-foo/readme.txt', ROOT), null);
  assert.equal(processWatchFilename('claude-code', 'D--src-foo/notes.meta.json', ROOT), null,
    'meta outside subagents is ignored');
  assert.equal(processWatchFilename('claude-code', null, ROOT), null);
});

test('processWatchFilename — pi extracts UUID from timestamp prefix', () => {
  const r = processWatchFilename(
    'pi',
    '--D--src-ebrain--/2026-04-26T14-22-51-638Z_019dca2b.jsonl',
    ROOT,
  );
  assert.ok(r);
  assert.equal(r.ctx.harness, 'pi');
  assert.equal(r.ctx.session_id, '019dca2b');
  // Pi has no incremental analyze path (CC-only fast path) — null triggers full --all-harnesses scan
  assert.equal(r.rebuildArg, null);
});

test('processWatchFilename — antigravity nested log path', () => {
  const r = processWatchFilename(
    'antigravity',
    'c7f6b422/.system_generated/logs/transcript.jsonl',
    ROOT,
  );
  assert.ok(r);
  assert.equal(r.ctx.harness, 'antigravity');
  assert.equal(r.ctx.session_id, 'c7f6b422');
  assert.equal(r.rebuildArg, '--session=antigravity/c7f6b422');
});


test('processWatchFilename — antigravity overview.txt', () => {
  const r = processWatchFilename(
    'antigravity',
    'c7f6b422/.system_generated/logs/overview.txt',
    ROOT,
  );
  assert.ok(r);
  assert.equal(r.ctx.session_id, 'c7f6b422');
});

test('processWatchFilename — grok updates.jsonl', () => {
  const r = processWatchFilename(
    'grok',
    'D%3A%5Csrc%5CkaaroSessions/019ea1c9-46ee-77e0-bf36-f87a6403b5db/updates.jsonl',
    ROOT,
  );
  assert.ok(r);
  assert.equal(r.ctx.harness, 'grok');
  assert.equal(r.ctx.session_id, '019ea1c9-46ee-77e0-bf36-f87a6403b5db');
  assert.equal(r.ctx.project_id, 'D--src-kaaroSessions');
  assert.equal(r.rebuildArg, null);
});

test('processWatchFilename — unknown harness', () => {
  assert.equal(processWatchFilename('unknown', 'foo.jsonl', ROOT), null);
});

test('processWatchFilename — opencode session info json', () => {
  const r = processWatchFilename(
    'opencode',
    'session/global/ses_4a89582bbffe03xj4Y14Qtss1q.json',
    ROOT,
  );
  assert.ok(r);
  assert.equal(r.ctx.harness, 'opencode');
  assert.equal(r.ctx.session_id, 'ses_4a89582bbffe03xj4Y14Qtss1q');
  assert.equal(r.ctx.slug, '4a89582b');
  assert.equal(r.ctx.read_mode, 'json'); // whole-file JSON, not JSONL tail
  assert.equal(r.ctx.version_marker, '1.0');
  assert.equal(r.rebuildArg, null);
});

test('processWatchFilename — opencode storage/ prefixed path matches and strips cleanly', () => {
  const r = processWatchFilename(
    'opencode',
    'storage/session/global/ses_4a89582bbffe03xj4Y14Qtss1q.json',
    ROOT,
  );
  assert.ok(r);
  assert.equal(r.ctx.session_id, 'ses_4a89582bbffe03xj4Y14Qtss1q');
  assert.equal(r.ctx.read_mode, 'json');
  assert.equal(r.ctx.version_marker, '1.0');
});

test('processWatchFilename — opencode.db and opencode.db-wal emit sqlite read_mode', () => {
  const r1 = processWatchFilename('opencode', 'opencode.db', ROOT);
  assert.ok(r1);
  assert.equal(r1.ctx.harness, 'opencode');
  assert.equal(r1.ctx.read_mode, 'sqlite');
  assert.equal(r1.ctx.version_marker, '1.18');
  assert.equal(r1.rebuildArg, null);

  const r2 = processWatchFilename('opencode', 'opencode.db-wal', ROOT);
  assert.ok(r2);
  assert.equal(r2.ctx.harness, 'opencode');
  assert.equal(r2.ctx.read_mode, 'sqlite');
  assert.equal(r2.ctx.version_marker, '1.18');
});

test('processWatchFilename — opencode message json carries session id from dir', () => {
  const r = processWatchFilename(
    'opencode',
    'message/ses_4a89582bbffe03xj4Y14Qtss1q/msg_b5769c31f001Wjs4cv6.json',
    ROOT,
  );
  assert.ok(r);
  assert.equal(r.ctx.session_id, 'ses_4a89582bbffe03xj4Y14Qtss1q');
  assert.equal(r.ctx.read_mode, 'json');
});

test('processWatchFilename — opencode part json resolves session from content later', () => {
  const r = processWatchFilename(
    'opencode',
    'part/msg_b5769c31f001Wjs4cv6/prt_b57584550001nzWf.json',
    ROOT,
  );
  assert.ok(r);
  assert.equal(r.ctx.harness, 'opencode');
  assert.equal(r.ctx.session_id, null); // sessionID lives inside the JSON body
  assert.equal(r.ctx.read_mode, 'json');
});

test('processWatchFilename — opencode ignores non-transcript storage noise', () => {
  assert.equal(processWatchFilename('opencode', 'project/global.json', ROOT), null);
  assert.equal(processWatchFilename('opencode', 'session_diff/ses_x.json', ROOT), null);
  assert.equal(processWatchFilename('opencode', 'migration', ROOT), null);
});

test('processWatchFilename — copilot chatSessions jsonl op-log', () => {
  const r = processWatchFilename(
    'copilot',
    'e07ec4b76ec1cba51ba84e69683d85e4/chatSessions/052d579c-9e9f-4c40-989b-b6923159f2dd.jsonl',
    ROOT,
  );
  assert.ok(r);
  assert.equal(r.ctx.harness, 'copilot');
  assert.equal(r.ctx.session_id, '052d579c-9e9f-4c40-989b-b6923159f2dd');
  assert.equal(r.ctx.slug, '052d579c');
  assert.equal(r.ctx.workspace_hash, 'e07ec4b76ec1cba51ba84e69683d85e4');
  assert.equal(r.rebuildArg, null);
});

test('processWatchFilename — copilot ignores old .json dumps and state.vscdb', () => {
  assert.equal(processWatchFilename('copilot', 'e07e/chatSessions/old.json', ROOT), null);
  assert.equal(processWatchFilename('copilot', 'e07e/state.vscdb', ROOT), null);
  assert.equal(processWatchFilename('copilot', 'e07e/chatEditingSessions/x.jsonl', ROOT), null);
});