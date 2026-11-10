import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORD_KINDS, KIND_FIELDS, isNormalizedRecord, validateNormalizedRecord,
  USER_ORIGINS,
} from '../hooks/normalized-record.mjs';

test('RECORD_KINDS — contains expected kinds', () => {
  for (const k of [
    'user_turn', 'assistant_turn', 'tool_use', 'tool_result',
    'tokens', 'skill_invoke', 'context_reset', 'session_meta',
    'permission_mode', 'branch_change',
  ]) {
    assert.ok(RECORD_KINDS.includes(k), `missing kind: ${k}`);
  }
});

test('RECORD_KINDS — contains the kinds adapters actually emit', () => {
  for (const k of ['content_block', 'mode_shift', 'attachment', 'scaffold', 'unknown_record']) {
    assert.ok(RECORD_KINDS.includes(k), `missing kind: ${k}`);
  }
});

test('RECORD_KINDS — contains api_error (harness/API-level failures)', () => {
  assert.ok(RECORD_KINDS.includes('api_error'));
});

test('KIND_FIELDS — has a spec entry for every kind', () => {
  for (const k of RECORD_KINDS) {
    assert.ok(KIND_FIELDS[k], `KIND_FIELDS missing spec for: ${k}`);
  }
});

test('isNormalizedRecord — valid record', () => {
  assert.equal(isNormalizedRecord({
    kind: 'tool_use', ts: '2026-05-01T10:00:00.000Z', harness: 'claude-code', tool: 'Read',
  }), true);
});

test('isNormalizedRecord — accepts previously-rejected real adapter kinds', () => {
  assert.equal(isNormalizedRecord({ kind: 'content_block', harness: 'claude-code', block_type: 'text' }), true);
  assert.equal(isNormalizedRecord({ kind: 'scaffold', harness: 'antigravity' }), true);
  assert.equal(isNormalizedRecord({ kind: 'unknown_record', harness: 'pi' }), true);
});

test('isNormalizedRecord — rejects invalid', () => {
  assert.equal(isNormalizedRecord(null), false);
  assert.equal(isNormalizedRecord({ kind: 'bogus' }), false);
  assert.equal(isNormalizedRecord({ kind: 'user_turn' }), false);
});

// ── validateNormalizedRecord ──────────────────────────────────────────────────

test('validateNormalizedRecord — valid records per kind pass', () => {
  const valid = [
    { kind: 'user_turn', harness: 'claude-code', ts: 't', text: 'hello world' },
    { kind: 'user_turn', harness: 'claude-code', ts: null, text: null },
    { kind: 'assistant_turn', harness: 'claude-code', ts: 't', model: 'm', stop_reason: 'end_turn' },
    { kind: 'assistant_turn', harness: 'grok', ts: 't', content_length: 240 },
    { kind: 'tool_use', harness: 'claude-code', ts: 't', tool: 'Bash', category: 'git', input: { command: 'git status' } },
    { kind: 'tool_use', harness: 'pi', ts: 't', tool: 'read', category: null },
    { kind: 'tool_result', harness: 'claude-code', ts: 't', tool: 'Bash', error: true },
    { kind: 'tool_result', harness: 'opencode', ts: 't' },
    { kind: 'tokens', harness: 'claude-code', ts: 't', tokens: { input: 1, output: 2, cache_create: 0, cache_read: 3 } },
    { kind: 'skill_invoke', harness: 'claude-code', ts: 't', skill: 'code-review' },
    { kind: 'context_reset', harness: 'claude-code', ts: 't' },
    { kind: 'session_meta', harness: 'claude-code', ts: 't', ai_title: 'A title' },
    { kind: 'session_meta', harness: 'copilot', ts: null },
    { kind: 'permission_mode', harness: 'claude-code', ts: 't', mode: 'acceptEdits' },
    { kind: 'branch_change', harness: 'claude-code', ts: 't', branch: 'main' },
    { kind: 'content_block', harness: 'claude-code', ts: 't', block_type: 'text', text: 'ok' },
    { kind: 'content_block', harness: 'claude-code', ts: 't', block_type: 'thinking' },
    { kind: 'mode_shift', harness: 'claude-code', ts: 't', mode: 'plan' },
    { kind: 'attachment', harness: 'claude-code', ts: 't', subtype: 'file' },
    { kind: 'scaffold', harness: 'antigravity', ts: 't', content_preview: 'reminder' },
    { kind: 'unknown_record', harness: 'pi', ts: 't', raw_type: 'weird' },
    { kind: 'api_error', harness: 'claude-code', ts: 't', message: 'quota exceeded', code: 'rate_limit' },
    { kind: 'api_error', harness: 'grok', ts: 't', message: 'auth failed' },
  ];
  for (const rec of valid) {
    const r = validateNormalizedRecord(rec);
    assert.deepEqual(r.errors, [], `${rec.kind}: ${r.errors.join('; ')}`);
    assert.equal(r.ok, true);
  }
});

test('validateNormalizedRecord — unknown kind fails', () => {
  const r = validateNormalizedRecord({ kind: 'bogus', harness: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('kind')));
});

test('validateNormalizedRecord — missing harness fails', () => {
  const r = validateNormalizedRecord({ kind: 'context_reset', ts: 't' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('harness')));
});

test('validateNormalizedRecord — missing required field fails', () => {
  assert.equal(validateNormalizedRecord({ kind: 'tool_use', harness: 'x', ts: 't' }).ok, false,
    'tool_use without tool');
  assert.equal(validateNormalizedRecord({ kind: 'tokens', harness: 'x', ts: 't' }).ok, false,
    'tokens without tokens object');
  assert.equal(validateNormalizedRecord({ kind: 'skill_invoke', harness: 'x', ts: 't' }).ok, false,
    'skill_invoke without skill');
  assert.equal(validateNormalizedRecord({ kind: 'branch_change', harness: 'x', ts: 't' }).ok, false,
    'branch_change without branch');
  assert.equal(validateNormalizedRecord({ kind: 'content_block', harness: 'x', ts: 't' }).ok, false,
    'content_block without block_type');
  assert.equal(validateNormalizedRecord({ kind: 'api_error', harness: 'x', ts: 't' }).ok, false,
    'api_error without message');
});

test('validateNormalizedRecord — wrong field types fail', () => {
  assert.equal(validateNormalizedRecord({ kind: 'tool_use', harness: 'x', ts: 't', tool: 42 }).ok, false,
    'tool must be a string');
  assert.equal(validateNormalizedRecord(
    { kind: 'tokens', harness: 'x', ts: 't', tokens: { input: 'a', output: 0, cache_create: 0, cache_read: 0 } }
  ).ok, false, 'tokens.input must be a number');
  assert.equal(validateNormalizedRecord({ kind: 'user_turn', harness: 'x', ts: 't', text: 99 }).ok, false,
    'text must be string|null when present');
  assert.equal(validateNormalizedRecord({ kind: 'tool_result', harness: 'x', ts: 't', error: 'yes' }).ok, false,
    'error must be boolean when present');
});

test('validateNormalizedRecord — ts must be string, number, or null', () => {
  assert.equal(validateNormalizedRecord({ kind: 'context_reset', harness: 'x', ts: 't' }).ok, true);
  assert.equal(validateNormalizedRecord({ kind: 'context_reset', harness: 'x', ts: 123 }).ok, true);
  assert.equal(validateNormalizedRecord({ kind: 'context_reset', harness: 'x', ts: null }).ok, true);
  assert.equal(validateNormalizedRecord({ kind: 'context_reset', harness: 'x' }).ok, true,
    'ts may be absent');
  assert.equal(validateNormalizedRecord({ kind: 'context_reset', harness: 'x', ts: {} }).ok, false);
});

test('user_turn.origin — closed enum: who/what produced the user row', () => {
  assert.deepEqual([...USER_ORIGINS].sort(), [
    'command', 'compact_summary', 'human', 'interrupt', 'meta', 'notification', 'sidechain', 'tool_result',
  ]);
  for (const origin of USER_ORIGINS) {
    assert.equal(validateNormalizedRecord({ kind: 'user_turn', harness: 'x', ts: null, origin }).ok, true, origin);
  }
  assert.equal(validateNormalizedRecord({ kind: 'user_turn', harness: 'x', ts: null }).ok, true, 'origin optional');
  const bad = validateNormalizedRecord({ kind: 'user_turn', harness: 'x', ts: null, origin: 'robot' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(), /origin/);
});
