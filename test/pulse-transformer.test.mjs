/**
 * test/pulse-transformer.test.mjs — TDD tests for lib/pulse-transformer.mjs
 *
 * Every NormalizedRecord kind must emit ≥1 pulse. New event types introduced
 * by the full-cognitive-experience refactor are covered here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normRecordsToPulses } from '../hooks/pulse-transformer.mjs';

const CTX = {
  session_id:    'aaaabbbb-0000-0000-0000-000000000000',
  slug:          'aaaabbbb',
  project_label: 'test-proj',
  harness:       'claude-code',
};

const TS = '2026-06-09T10:00:00.000Z';

// ── tool_use → tool_call pulse ───────────────────────────────────────────────

test('tool_use NR → tool_call pulse with canonical key derived by transformer', () => {
  const nrs = [{ kind: 'tool_use', harness: 'claude-code', ts: TS,
    tool: 'Read', input: { file_path: 'src/index.mjs' } }];
  const pulses = normRecordsToPulses(nrs, CTX);
  assert.equal(pulses.length, 1);
  assert.equal(pulses[0].event, 'tool_call');
  assert.equal(pulses[0].data.key, 'read');
  assert.equal(pulses[0].data.tool, 'Read');
  assert.equal(pulses[0].data.slug, CTX.slug);
  assert.equal(pulses[0].data.harness, CTX.harness);
  assert.equal(pulses[0].data.nr_kind, 'tool_use');
});

test('tool_use NR key derived from tool+category by transformer', () => {
  const nrs = [
    { kind: 'tool_use', harness: 'claude-code', ts: TS, tool: 'Read',       input: {} },
    { kind: 'tool_use', harness: 'claude-code', ts: TS, tool: 'Bash', category: 'git',  input: {} },
    { kind: 'tool_use', harness: 'claude-code', ts: TS, tool: 'Bash', category: 'node', input: {} },
    { kind: 'tool_use', harness: 'claude-code', ts: TS, tool: 'Bash', category: 'fs',   input: {} },
    { kind: 'tool_use', harness: 'claude-code', ts: TS, tool: 'Agent',      input: {} },
    { kind: 'tool_use', harness: 'claude-code', ts: TS, tool: 'WebFetch',   input: {} },
  ];
  const pulses = normRecordsToPulses(nrs, CTX);
  const keys = pulses.map(p => p.data.key);
  assert.deepEqual(keys, ['read', 'bash_git', 'bash_run', 'bash_other', 'agent', 'web']);
});

test('tool_use NR → tool_call pulse preserves where from file_path', () => {
  const nrs = [{ kind: 'tool_use', harness: 'claude-code', ts: TS,
    tool: 'Write', input: { file_path: 'out/result.mjs' } }];
  const [pulse] = normRecordsToPulses(nrs, CTX);
  assert.equal(pulse.data.where, 'out/result.mjs');
});

// ── tokens NR → tokens pulse ─────────────────────────────────────────────────

test('tokens NR → tokens pulse', () => {
  const nrs = [{ kind: 'tokens', harness: 'claude-code', ts: TS,
    tokens: { input: 500, output: 200, cache_create: 0, cache_read: 8000 } }];
  const [pulse] = normRecordsToPulses(nrs, CTX);
  assert.equal(pulse.event, 'tokens');
  assert.equal(pulse.data.input, 500);
  assert.equal(pulse.data.output, 200);
  assert.equal(pulse.data.cache_read, 8000);
  assert.ok(!pulse.data.synthetic);
  assert.equal(pulse.data.nr_kind, 'tokens');
});

// ── content_block → words / chirp ────────────────────────────────────────────

test('content_block text ≥3 words → words pulse', () => {
  const nrs = [{ kind: 'content_block', harness: 'claude-code', ts: TS,
    block_type: 'text', text: 'Running the tests now.' }];
  const [pulse] = normRecordsToPulses(nrs, CTX);
  assert.equal(pulse.event, 'words');
  assert.ok(pulse.data.word_count >= 3);
  assert.ok(pulse.data.preview.length > 0);
  assert.equal(pulse.data.nr_kind, 'content_block');
});

test('content_block text <3 words → chirp pulse', () => {
  const nrs = [{ kind: 'content_block', harness: 'claude-code', ts: TS,
    block_type: 'text', text: 'Got it.' }];
  const [pulse] = normRecordsToPulses(nrs, CTX);
  assert.equal(pulse.event, 'chirp');
  assert.ok(pulse.data.word_count < 3);
});

test('content_block non-text type → unknown pulse (not words/chirp)', () => {
  const nrs = [{ kind: 'content_block', harness: 'claude-code', ts: TS,
    block_type: 'thinking' }];
  const [pulse] = normRecordsToPulses(nrs, CTX);
  assert.ok(pulse.event !== 'words' && pulse.event !== 'chirp');
});

// ── user_turn → human_turn pulse ─────────────────────────────────────────────

test('user_turn NR → human_turn pulse', () => {
  const nrs = [{ kind: 'user_turn', harness: 'claude-code', ts: TS,
    text: 'Run all the tests please' }];
  const [pulse] = normRecordsToPulses(nrs, CTX);
  assert.equal(pulse.event, 'human_turn');
  assert.equal(pulse.data.slug, CTX.slug);
  assert.equal(pulse.data.nr_kind, 'user_turn');
});

// ── context_reset → compact pulse ────────────────────────────────────────────

test('context_reset NR → compact pulse', () => {
  const nrs = [{ kind: 'context_reset', harness: 'claude-code', ts: TS }];
  const [pulse] = normRecordsToPulses(nrs, CTX);
  assert.equal(pulse.event, 'compact');
  assert.equal(pulse.data.nr_kind, 'context_reset');
});

// ── permission_mode → permission pulse ───────────────────────────────────────

test('permission_mode NR → permission pulse', () => {
  const nrs = [{ kind: 'permission_mode', harness: 'claude-code', ts: TS, mode: 'default' }];
  const [pulse] = normRecordsToPulses(nrs, CTX);
  assert.equal(pulse.event, 'permission');
  assert.equal(pulse.data.mode, 'default');
});

// ── mode_shift → mode_shift pulse ───────────────────────────────────────────

test('mode_shift NR → mode_shift pulse with mode field', () => {
  const nrs = [{ kind: 'mode_shift', harness: 'claude-code', ts: TS, mode: 'plan' }];
  const [pulse] = normRecordsToPulses(nrs, CTX);
  assert.equal(pulse.event, 'mode_shift');
  assert.equal(pulse.data.mode, 'plan');
});

// ── attachment → attachment pulse ────────────────────────────────────────────

test('attachment NR → attachment pulse with subtype field', () => {
  const nrs = [{ kind: 'attachment', harness: 'claude-code', ts: TS, subtype: 'task_reminder' }];
  const [pulse] = normRecordsToPulses(nrs, CTX);
  assert.equal(pulse.event, 'attachment');
  assert.equal(pulse.data.subtype, 'task_reminder');
});

// ── scaffold → scaffold pulse ─────────────────────────────────────────────────

test('scaffold NR → scaffold pulse', () => {
  const nrs = [{ kind: 'scaffold', harness: 'antigravity', ts: TS,
    content_preview: 'You are in planning mode.' }];
  const ctx = { ...CTX, harness: 'antigravity' };
  const [pulse] = normRecordsToPulses(nrs, ctx);
  assert.equal(pulse.event, 'scaffold');
  assert.equal(pulse.data.content_preview, 'You are in planning mode.');
});

// ── tool_result error/success ─────────────────────────────────────────────────

test('tool_result error:true → tool_error pulse', () => {
  const nrs = [{ kind: 'tool_result', harness: 'claude-code', ts: TS,
    error: true, tool: 'Bash' }];
  const [pulse] = normRecordsToPulses(nrs, CTX);
  assert.equal(pulse.event, 'tool_error');
  assert.equal(pulse.data.tool, 'Bash');
});

test('tool_result error:false → tool_result pulse', () => {
  const nrs = [{ kind: 'tool_result', harness: 'claude-code', ts: TS,
    error: false, tool: 'Read' }];
  const [pulse] = normRecordsToPulses(nrs, CTX);
  assert.equal(pulse.event, 'tool_result');
});

// ── unknown_record → unknown pulse ───────────────────────────────────────────

test('unknown_record NR → unknown pulse with raw_type', () => {
  const nrs = [{ kind: 'unknown_record', harness: 'claude-code', ts: TS,
    raw_type: 'some_future_type' }];
  const [pulse] = normRecordsToPulses(nrs, CTX);
  assert.equal(pulse.event, 'unknown');
  assert.equal(pulse.data.raw_type, 'some_future_type');
});

// ── catch-all invariant ───────────────────────────────────────────────────────

test('string that is not a RECORD_KIND → unknown pulse (catch-all never drops)', () => {
  const nrs = [{ kind: 'not_a_kind', harness: 'claude-code', ts: TS }];
  const pulses = normRecordsToPulses(nrs, CTX);
  assert.equal(pulses.length, 1);
  assert.equal(pulses[0].event, 'unknown');
  assert.equal(pulses[0].data.nr_kind, 'not_a_kind');
});

test('P0 snapshot kinds → silent, not unknown', () => {
  const nrs = [
    { kind: 'session_meta', harness: 'claude-code', ts: TS, slug: 'x' },
    { kind: 'branch_change', harness: 'claude-code', ts: TS, branch: 'feat/x' },
    { kind: 'skill_invoke', harness: 'claude-code', ts: TS, skill: 'review' },
  ];
  const pulses = normRecordsToPulses(nrs, CTX);
  assert.deepEqual(pulses.map(p => p.event), ['silent', 'silent', 'silent']);
  assert.deepEqual(pulses.map(p => p.data.reason), ['snapshot', 'snapshot', 'snapshot']);
});

test('every NR in a mixed batch emits ≥1 pulse', () => {
  const nrs = [
    { kind: 'tool_use', harness: 'claude-code', ts: TS, tool: 'Read', input: {} },
    { kind: 'tokens', harness: 'claude-code', ts: TS, tokens: { input: 100, output: 50, cache_create: 0, cache_read: 0 } },
    { kind: 'user_turn', harness: 'claude-code', ts: TS, text: 'Do this please' },
    { kind: 'context_reset', harness: 'claude-code', ts: TS },
    { kind: 'permission_mode', harness: 'claude-code', ts: TS, mode: 'bypass' },
    { kind: 'assistant_turn', harness: 'claude-code', ts: TS },
    { kind: 'session_meta', harness: 'claude-code', ts: TS, slug: 'x' },
    { kind: 'branch_change', harness: 'claude-code', ts: TS, branch: 'feat/x' },
    { kind: 'skill_invoke', harness: 'claude-code', ts: TS, skill: 'review' },
  ];
  const pulses = normRecordsToPulses(nrs, CTX);
  assert.equal(pulses.length, nrs.length, 'each NR must produce exactly 1 pulse in this batch');
  assert.ok(pulses.every(p => p.data.nr_kind), 'every pulse carries nr_kind');
  assert.deepEqual(pulses.map(p => p.data.nr_kind), nrs.map(n => n.kind));
});

// ── synthetic tokens from assistant_turn ─────────────────────────────────────

// ── content_block/thinking → thinking pulse ──────────────────────────────────

test('content_block thinking NR → thinking pulse with block_type', () => {
  const nrs = [{ kind: 'content_block', harness: 'claude-code', ts: TS,
    block_type: 'thinking' }];
  const [pulse] = normRecordsToPulses(nrs, CTX);
  assert.equal(pulse.event, 'thinking');
  assert.equal(pulse.data.block_type, 'thinking');
  assert.equal(pulse.data.nr_kind, 'content_block');
});

test('content_block tool_use → silent duplicate (not unknown)', () => {
  const nrs = [{ kind: 'content_block', harness: 'claude-code', ts: TS,
    block_type: 'tool_use' }];
  const [pulse] = normRecordsToPulses(nrs, CTX);
  assert.equal(pulse.event, 'silent');
  assert.equal(pulse.data.reason, 'duplicate');
  assert.equal(pulse.data.block_type, 'tool_use');
  assert.equal(pulse.data.nr_kind, 'content_block');
});

// ── synthetic tokens from assistant_turn ─────────────────────────────────────

test('assistant_turn + capabilities.tokens:false → synthetic tokens pulse', () => {
  const nrs = [{ kind: 'assistant_turn', harness: 'antigravity', ts: TS,
    content_length: 400 }];
  const ctx = { ...CTX, harness: 'antigravity' };
  const [pulse] = normRecordsToPulses(nrs, ctx, { tokens: false });
  assert.equal(pulse.event, 'tokens');
  assert.ok(pulse.data.synthetic);
  assert.ok(pulse.data.output > 0, 'estimated output tokens from content_length/4');
  assert.equal(pulse.data.nr_kind, 'assistant_turn');
});

test('assistant_turn + capabilities.tokens:true → silent envelope (no duplicate tokens)', () => {
  const nrs = [{ kind: 'assistant_turn', harness: 'claude-code', ts: TS }];
  const [pulse] = normRecordsToPulses(nrs, CTX, { tokens: true });
  assert.equal(pulse.event, 'silent');
  assert.equal(pulse.data.reason, 'envelope');
  assert.equal(pulse.data.nr_kind, 'assistant_turn');
});

// ── api_error → api_error pulse ──────────────────────────────────────────────

test('api_error NR → api_error pulse with message and code', () => {
  const nrs = [{ kind: 'api_error', harness: 'claude-code', ts: TS,
    message: 'quota exceeded', code: 'rate_limit' }];
  const pulses = normRecordsToPulses(nrs, CTX);
  assert.equal(pulses.length, 1);
  assert.equal(pulses[0].event, 'api_error');
  assert.equal(pulses[0].data.message, 'quota exceeded');
  assert.equal(pulses[0].data.code, 'rate_limit');
  assert.equal(pulses[0].data.slug, CTX.slug);
  assert.equal(pulses[0].data.nr_kind, 'api_error');
});

test('api_error NR without code → code null', () => {
  const pulses = normRecordsToPulses(
    [{ kind: 'api_error', harness: 'grok', ts: TS, message: 'auth failed' }], CTX);
  assert.equal(pulses[0].event, 'api_error');
  assert.equal(pulses[0].data.code, null);
});

// ── kind coverage — no RECORD_KIND silently falls through ────────────────────

test('every RECORD_KIND maps to a named event; only unknown_record is the catch-all', async () => {
  const { RECORD_KINDS, KIND_FIELDS } = await import('../hooks/normalized-record.mjs');

  const DUMMY = {
    tokens: { input: 1, output: 1, cache_create: 0, cache_read: 0 },
  };
  function minimalNR(kind) {
    const nr = { kind, harness: 'claude-code', ts: TS };
    for (const [field, type] of Object.entries(KIND_FIELDS[kind].required)) {
      nr[field] = DUMMY[type] ?? (type === 'number' ? 1 : type === 'object' ? {} : 'x');
    }
    if (kind === 'content_block') { nr.block_type = 'text'; nr.text = 'three word text'; }
    return nr;
  }

  for (const kind of RECORD_KINDS) {
    const [pulse] = normRecordsToPulses([minimalNR(kind)], CTX, { tokens: true });
    assert.ok(pulse, `${kind}: no pulse emitted`);
    if (kind === 'unknown_record') {
      assert.equal(pulse.event, 'unknown', `${kind}: expected catch-all`);
    } else {
      assert.notEqual(pulse.event, 'unknown',
        `${kind}: classified as unknown — add a KIND_PULSE row (silent or sonic)`);
    }
  }
});

// ── intent / prompt payload (RFC-session-triggers: phase + ripeness) ─────────

test('tool_call pulse carries intent (mutate / verify / read / null)', () => {
  const mk = (tool, input) => normRecordsToPulses(
    [{ kind: 'tool_use', harness: 'claude-code', ts: TS, tool, input }], CTX)[0];
  assert.equal(mk('Edit', { file_path: 'a.mjs' }).data.intent, 'mutate');
  assert.equal(mk('Bash', { command: 'git commit -m x' }).data.intent, 'mutate');
  assert.equal(mk('Bash', { command: 'node --test' }).data.intent, 'verify');
  assert.equal(mk('Read', { file_path: 'a.mjs' }).data.intent, 'read');
  assert.equal(mk('Bash', {}).data.intent, null);
  // key stays the canonical sonic key
  assert.equal(mk('Bash', { command: 'git commit -m x' }).data.key, 'bash_other');
});

test('human_turn pulse — prompt flag: explicit null display_text is a tool-result row', () => {
  const mk = nr => normRecordsToPulses([{ kind: 'user_turn', harness: 'x', ts: TS, ...nr }], CTX)[0];
  assert.equal(mk({ text: null, display_text: 'go' }).data.prompt, true);
  assert.equal(mk({ text: null, display_text: null }).data.prompt, false);   // CC tool_result-only row
  assert.equal(mk({ text: 'please build it' }).data.prompt, true);           // adapter without display_text
  assert.equal(mk({ text: null }).data.prompt, true);                        // short prompt, field absent
  // prompt text is NOT added to the pulse (text keeps first-message semantics)
  assert.equal(mk({ text: null, display_text: 'secret plan' }).data.text, null);
});
