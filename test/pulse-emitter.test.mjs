/**
 * test/pulse-emitter.test.mjs → surface/pulse-emitter.mjs
 *
 * The Stream production path: watched-file change → tail/parse → adapter →
 * pulses → hub broadcast + active-state, with offset tracking and the
 * throttled `now` snapshot broadcast.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createPulseEmitter } from '../surface/pulse-emitter.mjs';
import { createActiveState, snapshotActive } from '../surface/active-state.mjs';

function fakeHub() {
  const events = [];
  return { events, notify: (event, data) => events.push({ event, data: data ? JSON.parse(data) : null }) };
}

function withTempDir(fn) {
  const dir = join(tmpdir(), 'kaaro-pulse-emit-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const CC_CTX = {
  harness: 'claude-code', session_id: 'aaaabbbb-1111-2222-3333-444455556666',
  slug: 'aaaabbbb', project_id: 'P', project_label: 'proj',
};

const CC_LINE = JSON.stringify({
  type: 'assistant', timestamp: '2026-06-12T10:00:00.000Z',
  message: { model: 'm', usage: { input_tokens: 5, output_tokens: 3 },
    content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.mjs' } }] },
});

test('tailAndPulse — emits pulses for new JSONL bytes and advances the offset', () => {
  withTempDir((dir) => {
    const fp = join(dir, 's.jsonl');
    writeFileSync(fp, CC_LINE + '\n', 'utf8');
    const hub = fakeHub();
    const activeState = createActiveState();
    const emitter = createPulseEmitter({ hub, activeState });

    emitter.tailAndPulse(fp, CC_CTX);
    const toolCalls = hub.events.filter(e => e.event === 'tool_call');
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].data.slug, 'aaaabbbb');
    assert.equal(toolCalls[0].data.key, 'read');

    // No new bytes → no new pulses.
    const before = hub.events.length;
    emitter.tailAndPulse(fp, CC_CTX);
    assert.equal(hub.events.length, before);

    // Appended bytes → only the new record pulses.
    appendFileSync(fp, CC_LINE + '\n', 'utf8');
    emitter.tailAndPulse(fp, CC_CTX);
    assert.equal(hub.events.filter(e => e.event === 'tool_call').length, 2);
  });
});

test('tailAndPulse — same pulses overlay the kind-map store', () => {
  withTempDir((dir) => {
    const fp = join(dir, 's.jsonl');
    writeFileSync(fp, CC_LINE + '\n', 'utf8');
    const seen = [];
    const kindMap = { applyPulse: (p) => seen.push(p) };
    const emitter = createPulseEmitter({ hub: fakeHub(), activeState: createActiveState(), kindMap });
    emitter.tailAndPulse(fp, CC_CTX);
    assert.ok(seen.some(p => p.event === 'tool_call'));
    assert.equal(seen.filter(p => p.event === 'tool_call')[0].data.harness, 'claude-code');
  });
});

test('tailAndPulse — feeds active-state so /api/active sees the session', () => {
  withTempDir((dir) => {
    const fp = join(dir, 's.jsonl');
    writeFileSync(fp, CC_LINE + '\n', 'utf8');
    const activeState = createActiveState();
    const emitter = createPulseEmitter({ hub: fakeHub(), activeState });
    emitter.tailAndPulse(fp, CC_CTX);
    const snap = snapshotActive(activeState, Date.now());
    assert.equal(snap.sessions.length, 1);
    assert.equal(snap.sessions[0].slug, 'aaaabbbb');
  });
});

test('tailAndPulse — schedules at most one trailing `now` broadcast per window', async () => {
  await new Promise((resolve, reject) => {
    withTempDir((dir) => {
      const fp = join(dir, 's.jsonl');
      writeFileSync(fp, CC_LINE + '\n' + CC_LINE + '\n', 'utf8');
      const hub = fakeHub();
      const emitter = createPulseEmitter({ hub, activeState: createActiveState(), nowThrottleMs: 10 });
      emitter.tailAndPulse(fp, CC_CTX);
      appendFileSync(fp, CC_LINE + '\n', 'utf8');
      emitter.tailAndPulse(fp, CC_CTX); // second burst inside the window
      setTimeout(() => {
        try {
          const nows = hub.events.filter(e => e.event === 'now');
          assert.equal(nows.length, 1, 'bursty tails collapse into one now snapshot');
          assert.ok(nows.at(-1).data.sessions.length >= 1);
          resolve();
        } catch (e) { reject(e); }
      }, 40);
    });
  });
});

test('json read_mode — whole-file parse, dedupe by size+mtime signature', () => {
  withTempDir((dir) => {
    const fp = join(dir, 'msg_x.json');
    const doc = {
      id: 'msg_x', sessionID: 'ses_abcdef1234', role: 'assistant',
      time: { created: 1766698107679 }, modelID: 'm', providerID: 'opencode',
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 1, write: 2 } },
      finish: 'stop', _parts: [],
    };
    writeFileSync(fp, JSON.stringify(doc, null, 2), 'utf8');
    const hub = fakeHub();
    const emitter = createPulseEmitter({ hub, activeState: createActiveState() });
    const ctx = { harness: 'opencode', session_id: null, slug: null,
      project_id: null, project_label: null, read_mode: 'json' };

    emitter.tailAndPulse(fp, ctx);
    const first = hub.events.length;
    assert.ok(first > 0, 'whole-file json produced pulses');
    assert.ok(hub.events.every(e => e.event === 'now' || e.data.slug === 'abcdef12'),
      'slug derived from in-body sessionID');

    emitter.tailAndPulse(fp, ctx); // unchanged file → signature dedupe
    assert.equal(hub.events.length, first);
  });
});

test('tailAndPulse — errors never escape (missing file is a no-op)', () => {
  const emitter = createPulseEmitter({ hub: fakeHub(), activeState: createActiveState() });
  assert.doesNotThrow(() => emitter.tailAndPulse('Z:/nope/missing.jsonl', CC_CTX));
});

// ── Size cap (OOM guard) ─────────────────────────────────────────────────────
// Same class of bug as parseJsonlFile's 512MB cap, but on the live path: a
// transcript that grew huge while unwatched must not be bulk-allocated on
// the first tail after restart. injected maxBytes stands in for a real
// gigabyte fixture (matches the jsonl-io/jsonl-tail test-seam convention).

test('tailAndPulse — over-cap delta is skipped, not crashed, and offset jumps past it (no retry loop)', () => {
  withTempDir((dir) => {
    const fp = join(dir, 's.jsonl');
    const oneLine = CC_LINE + '\n';
    // Cap sized so two lines together are over cap, but one line alone is under it.
    const cap = Buffer.byteLength(oneLine, 'utf8') + 5;
    writeFileSync(fp, oneLine + oneLine, 'utf8'); // delta from offset 0 exceeds cap
    const hub = fakeHub();
    const emitter = createPulseEmitter({ hub, activeState: createActiveState(), maxBytes: cap });

    assert.doesNotThrow(() => emitter.tailAndPulse(fp, CC_CTX));
    assert.equal(hub.events.filter(e => e.event === 'tool_call').length, 0, 'oversized delta produced no pulses');

    // If offset had stayed at 0 (retry loop), this delta would again be two
    // lines (still over cap) and still skip. If offset jumped to EOF as
    // designed, this new single-line delta is under cap and reads normally.
    appendFileSync(fp, oneLine, 'utf8');
    emitter.tailAndPulse(fp, CC_CTX);
    assert.equal(hub.events.filter(e => e.event === 'tool_call').length, 1, 'offset had advanced past the skipped bytes');
  });
});

test('json read_mode — over-cap file is skipped, not crashed: no pulses, no throw', () => {
  withTempDir((dir) => {
    const fp = join(dir, 'msg_big.json');
    writeFileSync(fp, JSON.stringify({
      id: 'msg_big', sessionID: 'ses_abcdef1234', role: 'assistant',
      time: { created: 1766698107679 }, modelID: 'm', providerID: 'opencode',
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 1, write: 2 } },
      finish: 'stop', _parts: [],
    }), 'utf8');
    const hub = fakeHub();
    const emitter = createPulseEmitter({ hub, activeState: createActiveState(), maxBytes: 4 });
    const ctx = { harness: 'opencode', session_id: null, slug: null,
      project_id: null, project_label: null, read_mode: 'json' };

    assert.doesNotThrow(() => emitter.tailAndPulse(fp, ctx));
    assert.equal(hub.events.filter(e => e.event !== 'now').length, 0, 'oversized json produced no data pulses');
  });
});

test('turn signals — startedAt and now are injectable: no wall-clock dependence', () => {
  withTempDir((dir) => {
    const fp = join(dir, 's.jsonl');
    const T0 = Date.parse('2020-01-01T00:00:00Z');
    const done = (iso, id) => JSON.stringify({ type: 'assistant', timestamp: iso,
      message: { id, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } });
    writeFileSync(fp, done('2019-12-31T23:59:00Z', 'before-start') + '\n'
      + done('2020-01-01T00:00:05Z', 'after-start') + '\n', 'utf8');
    const hub = fakeHub();
    const activeState = createActiveState();
    const emitter = createPulseEmitter({ hub, activeState, startedAt: T0, now: () => T0 + 10_000 });
    emitter.tailAndPulse(fp, CC_CTX);
    const signals = hub.events.filter(e => e.event === 'turn_complete');
    assert.equal(signals.length, 1, 'only the signal after startedAt (−1s grace) broadcasts');
    assert.equal(activeState.sessions.get(CC_CTX.session_id).last_seen, T0 + 10_000);
  });
});
