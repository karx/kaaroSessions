/**
 * test/pulse-map.test.mjs — KIND_PULSE exhaustiveness vs RECORD_KINDS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECORD_KINDS, USER_ORIGINS } from '../hooks/normalized-record.mjs';
import { EVENT_TYPE_KEYS } from '../experience/audio/event-registry.mjs';
import {
  KIND_PULSE, SILENT_REASONS, pulseDisposition, kindPulseKeys, streamEvents,
  KIND_ROUTES, routeIdFromNr, routeIdFromPulse,
} from '../hooks/pulse-map.mjs';

test('KIND_PULSE keys are exactly RECORD_KINDS', () => {
  assert.deepEqual(kindPulseKeys().sort(), RECORD_KINDS.slice().sort());
});

test('KIND_PULSE events are registry keys, tool_call, or route', () => {
  // tool_call is Stream vocabulary; sonic key is data.key (read/write/…).
  for (const [kind, spec] of Object.entries(KIND_PULSE)) {
    assert.ok(spec && spec.event, `${kind}: missing event`);
    if (spec.event === 'route' || spec.event === 'tool_call') continue;
    assert.ok(EVENT_TYPE_KEYS.has(spec.event),
      `${kind}: event '${spec.event}' not in EVENT_TYPES`);
    if (spec.event === 'silent') {
      assert.ok(SILENT_REASONS.has(spec.reason),
        `${kind}: silent reason '${spec.reason}' not in envelope|snapshot|duplicate`);
    }
  }
});

test('pulseDisposition — P0 false-unknowns are silent', () => {
  assert.deepEqual(
    pulseDisposition({ kind: 'assistant_turn' }, { tokens: true }),
    { event: 'silent', reason: 'envelope' },
  );
  assert.deepEqual(
    pulseDisposition({ kind: 'session_meta' }),
    { event: 'silent', reason: 'snapshot' },
  );
  assert.deepEqual(
    pulseDisposition({ kind: 'branch_change' }),
    { event: 'silent', reason: 'snapshot' },
  );
  assert.deepEqual(
    pulseDisposition({ kind: 'skill_invoke' }),
    { event: 'silent', reason: 'snapshot' },
  );
  assert.deepEqual(
    pulseDisposition({ kind: 'content_block', block_type: 'tool_use' }),
    { event: 'silent', reason: 'duplicate' },
  );
});

test('pulseDisposition — unknown_record and fake kinds stay unknown', () => {
  assert.equal(pulseDisposition({ kind: 'unknown_record', raw_type: 'x' }).event, 'unknown');
  assert.equal(pulseDisposition({ kind: 'not_a_kind' }).event, 'unknown');
  assert.equal(pulseDisposition({ kind: 'content_block', block_type: 'mystery' }).event, 'unknown');
});

test('pulseDisposition — assistant_turn + tokens:false is synthetic tokens', () => {
  const d = pulseDisposition({ kind: 'assistant_turn', content_length: 40 }, { tokens: false });
  assert.equal(d.event, 'tokens');
  assert.equal(d.synthetic, true);
});

test('pulseDisposition — content_block text/thinking keep sonic events', () => {
  assert.equal(
    pulseDisposition({ kind: 'content_block', block_type: 'text', text: 'Running the tests now.' }).event,
    'words',
  );
  assert.equal(
    pulseDisposition({ kind: 'content_block', block_type: 'text', text: 'Got it.' }).event,
    'chirp',
  );
  assert.equal(
    pulseDisposition({ kind: 'content_block', block_type: 'thinking' }).event,
    'thinking',
  );
});

test('streamEvents — covers every pulseDisposition event', () => {
  const events = streamEvents();
  assert.ok(events instanceof Set);
  const fixtures = [
    ...RECORD_KINDS.map(kind => ({ kind })),
    { kind: 'content_block', block_type: 'text', text: 'Running the tests now.' },
    { kind: 'content_block', block_type: 'text', text: 'Got it.' },
    { kind: 'content_block', block_type: 'thinking' },
    { kind: 'content_block', block_type: 'tool_use' },
    { kind: 'content_block', block_type: 'mystery' },
    { kind: 'tool_result', error: true },
    { kind: 'tool_result' },
    { kind: 'assistant_turn' },
    { kind: 'not_a_kind' },
  ];
  const caps = [{}, { tokens: true }, { tokens: false }];
  for (const nr of fixtures) {
    for (const c of caps) {
      const ev = pulseDisposition(nr, c).event;
      assert.ok(events.has(ev), `streamEvents missing '${ev}' from ${nr.kind}`);
    }
  }
  assert.ok(!events.has('route'), 'route is a disposition, not a Stream event');
});

test('KIND_ROUTES — content_block and tool_result cover pulseDisposition branches', () => {
  const cbIds = new Set(KIND_ROUTES.content_block.map(r => r.id));
  const trIds = new Set(KIND_ROUTES.tool_result.map(r => r.id));
  const fixtures = [
    { kind: 'content_block', block_type: 'thinking' },
    { kind: 'content_block', block_type: 'text', text: 'Running the tests now.' },
    { kind: 'content_block', block_type: 'text', text: 'Got it.' },
    { kind: 'content_block', block_type: 'tool_use' },
    { kind: 'content_block', block_type: 'mystery' },
    { kind: 'content_block' },
    { kind: 'tool_result' },
    { kind: 'tool_result', error: true },
  ];
  for (const nr of fixtures) {
    const rid = routeIdFromNr(nr);
    if (nr.kind === 'content_block') assert.ok(cbIds.has(rid), `missing content_block route ${rid}`);
    if (nr.kind === 'tool_result') assert.ok(trIds.has(rid), `missing tool_result route ${rid}`);
  }
  assert.equal(routeIdFromNr({ kind: 'session_meta' }), null, 'kinds without KIND_ROUTES have no route');
});

// ── user_turn routes by origin (Phase 1.5) ───────────────────────────────────

test('KIND_ROUTES.user_turn — one route per USER_ORIGINS member; only human is expected everywhere', () => {
  const ids = KIND_ROUTES.user_turn.map(r => r.id);
  assert.deepEqual([...ids].sort(), [...USER_ORIGINS].sort());
  for (const r of KIND_ROUTES.user_turn) {
    assert.equal(r.pulse, 'human_turn');
    assert.equal(r.expect, r.id === 'human' ? 'all' : 'none', r.id);
  }
});

test('routeIdFromNr / routeIdFromPulse — user_turn routes by origin (absent → derived)', () => {
  assert.equal(routeIdFromNr({ kind: 'user_turn', origin: 'sidechain' }), 'sidechain');
  assert.equal(routeIdFromNr({ kind: 'user_turn', display_text: 'go' }), 'human');
  assert.equal(routeIdFromNr({ kind: 'user_turn', display_text: null }), 'tool_result');
  assert.equal(routeIdFromPulse('human_turn', { nr_kind: 'user_turn', origin: 'interrupt' }), 'interrupt');
  assert.equal(routeIdFromPulse('human_turn', { nr_kind: 'user_turn' }), 'human');
});
