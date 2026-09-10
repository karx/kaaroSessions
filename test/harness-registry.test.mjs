import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESS_REGISTRY, HARNESS_IDS, getHarness, getEnabledHarnesses,
} from '../hooks/registry.mjs';

test('HARNESS_REGISTRY — known harnesses', () => {
  assert.deepEqual(HARNESS_IDS, ['claude-code', 'codex', 'pi', 'antigravity', 'grok', 'opencode', 'copilot', 'command-code']);
  assert.equal(HARNESS_REGISTRY.length, 8);
});

test('getHarness — claude-code watch config', () => {
  const h = getHarness('claude-code');
  assert.ok(h);
  assert.equal(h.id, 'claude-code');
  assert.ok(h.capabilities.pulse);
  assert.ok(h.capabilities.trace);
  assert.ok(h.watch.matchLogFile('D--src-foo/uuid.jsonl'));
  assert.equal(h.watch.matchLogFile('readme.txt'), false);

  const ctx = h.watch.ctxFromPath('D--src-foo/abc-def-123.jsonl');
  assert.equal(ctx.harness, 'claude-code');
  assert.equal(ctx.session_id, 'abc-def-123');
  assert.equal(ctx.slug, 'abc-def-');
  assert.equal(ctx.project_id, 'D--src-foo');

  assert.equal(h.watch.rebuildArg('D--src-foo/sess.jsonl'), '--session=D--src-foo/sess.jsonl');
});

test('getHarness — pi ctxFromPath extracts UUID from timestamp prefix', () => {
  const h = getHarness('pi');
  const ctx = h.watch.ctxFromPath('--D--src-ebrain--/2026-04-26T14-22-51-638Z_019dca2b.jsonl');
  assert.equal(ctx.harness, 'pi');
  assert.equal(ctx.session_id, '019dca2b');
});

test('getHarness — codex matches dated rollout paths', () => {
  const h = getHarness('codex');
  assert.ok(h.watch.matchLogFile('sessions/2026/08/21/rollout-2026-08-21T20-02-32-01abc000-0000-7000-8000-000000000001.jsonl'));
  assert.equal(h.watch.matchLogFile('session_index.jsonl'), false);
  const ctx = h.watch.ctxFromPath('sessions/2026/08/21/rollout-2026-08-21T20-02-32-01abc000-0000-7000-8000-000000000001.jsonl');
  assert.equal(ctx.harness, 'codex');
  assert.equal(ctx.session_id, '01abc000-0000-7000-8000-000000000001');
  assert.equal(ctx.slug, '01abc000');
});

test('getHarness — antigravity matches nested log paths', () => {
  const h = getHarness('antigravity');
  assert.ok(h.watch.matchLogFile('c7f6b422/.system_generated/logs/transcript.jsonl'));
  assert.ok(h.watch.matchLogFile('c7f6b422/.system_generated/logs/overview.txt'));
  assert.equal(h.watch.matchLogFile('c7f6b422/other.jsonl'), false);
  assert.equal(h.capabilities.tokens, false);
  assert.equal(h.capabilities.size_proxy, 'tool_calls');

  const ctx = h.watch.ctxFromPath('c7f6b422/.system_generated/logs/transcript.jsonl');
  assert.equal(ctx.harness, 'antigravity');
  assert.equal(ctx.session_id, 'c7f6b422');
});

test('getEnabledHarnesses — filters by id list', () => {
  const enabled = getEnabledHarnesses(['pi', 'antigravity']);
  assert.equal(enabled.length, 2);
  assert.ok(enabled.every(h => h.id === 'pi' || h.id === 'antigravity'));
});
// ── registry as single source of truth (N2) ──────────────────────────────────

test('every descriptor carries its adapter function', () => {
  for (const h of HARNESS_REGISTRY) {
    assert.equal(typeof h.adapter, 'function', `${h.id}: missing adapter`);
  }
});

test('every descriptor declares capabilities.tokens as a boolean', () => {
  for (const h of HARNESS_REGISTRY) {
    assert.equal(typeof h.capabilities.tokens, 'boolean', `${h.id}: capabilities.tokens`);
  }
});

test('adapter functions produce NormalizedRecords (smoke)', async () => {
  const { isNormalizedRecord } = await import('../hooks/normalized-record.mjs');
  const h = getHarness('claude-code');
  const nrs = h.adapter([{ type: 'system', subtype: 'compact_boundary', timestamp: 't' }]);
  assert.equal(nrs.length, 1);
  assert.ok(isNormalizedRecord(nrs[0]));
});

test('copilot + opencode watch configs expose resolveProjectLabel; others omit it', () => {
  // Both harnesses split project attribution out of the watched file path:
  // copilot's lives in a sibling workspace.json, opencode's message/part
  // docs carry no directory of their own (only the session info doc does —
  // see hooks/TRACE-opencode-sessions.md).
  for (const id of ['copilot', 'opencode']) {
    assert.equal(typeof getHarness(id).watch.resolveProjectLabel, 'function', `${id} should expose it`);
  }
  for (const id of ['claude-code', 'codex', 'pi', 'antigravity', 'grok']) {
    assert.equal(getHarness(id).watch.resolveProjectLabel, undefined, `${id} should omit it`);
  }
});

test('every descriptor declares a scan module + export for dispatch', () => {
  for (const h of HARNESS_REGISTRY) {
    assert.equal(typeof h.scan?.module, 'string', `${h.id}: scan.module`);
    assert.equal(typeof h.scan?.export, 'string', `${h.id}: scan.export`);
  }
});

test('loadScanner resolves a callable scanner from the descriptor', async () => {
  const { loadScanner } = await import('../hooks/registry.mjs');
  const scanner = await loadScanner('pi');
  assert.equal(typeof scanner, 'function');
  assert.equal(await loadScanner('nope'), null);
});

test('trace-capable file harnesses expose locateSession', () => {
  for (const id of ['claude-code', 'codex', 'pi', 'antigravity', 'grok']) {
    assert.equal(typeof getHarness(id).locateSession, 'function', `${id}: locateSession`);
  }
});
