/**
 * test/kind-map.test.mjs — payload + widget + gatherer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RECORD_KINDS } from '../hooks/normalized-record.mjs';
import { KIND_PULSE, routeIdFromPulse } from '../hooks/pulse-map.mjs';
import { toolNameToKey, TOOL_ACTION_KEYS } from '../hooks/action-keys.mjs';
import { HARNESS_IDS } from '../hooks/registry.mjs';
import { buildKindMapPayload, applyKindMapPulse, kindFromPulse, unknownFromPulse as mapUnknownFromPulse } from '../hooks/kind-map.mjs';
import { createKindMapStore } from '../surface/kind-map-store.mjs';
import { renderKindMapSnippet, renderKindMapPage, kindMapPulseHits, unknownFromPulse, addUnknown } from '../experience/kind-map-widget.mjs';
import { buildKindMap, gatherKindMapTraces, localHarnessFlags } from '../surface/kind-map-build.mjs';
import { EVENT_TYPES } from '../experience/audio/event-registry.mjs';

const HARNESSES = [
  { id: 'claude-code', label: 'Claude Code', capabilities: { tokens: true } },
  { id: 'pi', label: 'Pi', capabilities: { tokens: true } },
];

function traces(map) {
  const out = {};
  for (const h of HARNESSES) {
    const nrs = map[h.id] || [];
    out[h.id] = { golden: nrs, sample: [] };
  }
  return out;
}

test('buildKindMapPayload — kinds 1:1 with input kinds, emit from traces', () => {
  const payload = buildKindMapPayload({
    harnesses: HARNESSES,
    kinds: ['user_turn', 'tool_use', 'session_meta'],
    kindPulse: {
      user_turn: { event: 'human_turn' },
      tool_use: { event: 'tool_call' },
      session_meta: { event: 'silent', reason: 'snapshot' },
    },
    traces: traces({
      'claude-code': [
        { kind: 'user_turn', harness: 'claude-code' },
        { kind: 'tool_use', harness: 'claude-code', tool: 'Read' },
      ],
      pi: [{ kind: 'user_turn', harness: 'pi' }],
    }),
    toolNameToKey,
    toolKeys: ['read', 'write'],
    generated_at: 't0',
  });
  assert.equal(payload.generated_at, 't0');
  assert.deepEqual(payload.kinds.map(k => k.id), ['user_turn', 'tool_use', 'session_meta']);
  const user = payload.kinds.find(k => k.id === 'user_turn');
  assert.deepEqual(user.emit, [1, 1]);
  assert.deepEqual(user.proof[0], ['golden']);
  assert.deepEqual(user.proof[1], ['golden']);
  const tools = payload.kinds.find(k => k.id === 'tool_use');
  assert.deepEqual(tools.emit, [1, 0]);
  assert.deepEqual(tools.proof[1], []);
  const meta = payload.kinds.find(k => k.id === 'session_meta');
  assert.deepEqual(meta.emit, [0, 0]);
  assert.equal(meta.pulse, 'silent');
  assert.equal(meta.reason, 'snapshot');
  assert.equal(meta.lane, 'snapshot');
  assert.equal(user.lane, 'stream');
});

test('buildKindMapPayload — tools grouped by canonical key, raw names kept', () => {
  const payload = buildKindMapPayload({
    harnesses: HARNESSES,
    kinds: ['tool_use'],
    kindPulse: { tool_use: { event: 'tool_call' } },
    traces: traces({
      'claude-code': [
        { kind: 'tool_use', harness: 'claude-code', tool: 'Read' },
        { kind: 'tool_use', harness: 'claude-code', tool: 'view_file' },
      ],
      pi: [{ kind: 'tool_use', harness: 'pi', tool: 'read' }],
    }),
    toolNameToKey,
    toolKeys: ['read', 'write'],
  });
  const read = payload.tools.find(t => t.key === 'read');
  assert.deepEqual(read.by_harness['claude-code'].sort(), ['Read', 'view_file'].sort());
  assert.deepEqual(read.by_harness.pi, ['read']);
  const write = payload.tools.find(t => t.key === 'write');
  assert.deepEqual(write.by_harness['claude-code'], []);
});

test('buildKindMapPayload — sample vs golden proof is distinct', () => {
  const payload = buildKindMapPayload({
    harnesses: HARNESSES,
    kinds: ['tool_use', 'user_turn'],
    kindPulse: KIND_PULSE,
    traces: {
      'claude-code': {
        golden: [{ kind: 'tool_use', tool: 'Read' }],
        sample: [{ kind: 'user_turn' }],
      },
      pi: { golden: [], sample: [] },
    },
    toolNameToKey,
    toolKeys: ['read'],
  });
  assert.deepEqual(payload.kinds.find(k => k.id === 'tool_use').proof[0], ['golden']);
  assert.deepEqual(payload.kinds.find(k => k.id === 'user_turn').proof[0], ['sample']);
});

test('session slug is not proof of session_meta', () => {
  const payload = buildKindMapPayload({
    harnesses: HARNESSES,
    kinds: ['session_meta'],
    kindPulse: KIND_PULSE,
    traces: traces({ 'claude-code': [], pi: [] }),
    toolNameToKey,
    toolKeys: ['read'],
  });
  const row = payload.kinds.find(k => k.id === 'session_meta');
  assert.deepEqual(row.emit, [0, 0]);
  assert.deepEqual(row.proof[0], []);
});

test('buildKindMapPayload — tokens:false is expected-empty, not a hole', () => {
  const payload = buildKindMapPayload({
    harnesses: [
      { id: 'claude-code', label: 'CC', capabilities: { tokens: true } },
      { id: 'grok', label: 'Grok', capabilities: { tokens: false } },
    ],
    kinds: ['tokens', 'user_turn'],
    kindPulse: KIND_PULSE,
    traces: {
      'claude-code': { golden: [], sample: [] },
      grok: { golden: [], sample: [] },
    },
    toolNameToKey,
    toolKeys: ['read'],
  });
  const tokens = payload.kinds.find(k => k.id === 'tokens');
  assert.deepEqual(tokens.expect, [1, 0]);
  const user = payload.kinds.find(k => k.id === 'user_turn');
  assert.deepEqual(user.expect, [1, 1]);
  const html = renderKindMapSnippet(payload);
  assert.ok(html.includes('k-na'));
  assert.ok(!html.includes('<th>lane</th>'));
  assert.ok(!html.includes('<th>pulse</th>'));
});

test('buildKindMapPayload — content_block routes from pulseDisposition, unknown-block is alarm', () => {
  const payload = buildKindMapPayload({
    harnesses: HARNESSES,
    kinds: ['content_block'],
    kindPulse: KIND_PULSE,
    traces: traces({
      'claude-code': [
        { kind: 'content_block', block_type: 'thinking' },
        { kind: 'content_block', block_type: 'text', text: 'Running the tests now.' },
        { kind: 'content_block', block_type: 'mystery' },
      ],
      pi: [],
    }),
    toolNameToKey,
    toolKeys: ['read'],
  });
  const row = payload.kinds.find(k => k.id === 'content_block');
  assert.equal(row.pulse, 'route');
  const ids = row.routes.map(r => r.id);
  assert.deepEqual(ids, ['thinking', 'words', 'chirp', 'duplicate', 'unknown-block']);
  assert.equal(row.routes.find(r => r.id === 'thinking').emit[0], 1);
  assert.equal(row.routes.find(r => r.id === 'words').emit[0], 1);
  assert.equal(row.routes.find(r => r.id === 'chirp').emit[0], 0);
  const alarm = row.routes.find(r => r.id === 'unknown-block');
  assert.equal(alarm.role, 'alarm');
  assert.equal(alarm.emit[0], 1);
  const html = renderKindMapSnippet(payload);
  assert.ok(html.includes('k-child'));
  assert.ok(html.includes('k-alarm'));
  assert.ok(html.includes('thinking'));
});

test('unknown_record is catch-all; idle is n/a not a hole', () => {
  const payload = buildKindMapPayload({
    harnesses: HARNESSES,
    kinds: ['unknown_record', 'user_turn'],
    kindPulse: KIND_PULSE,
    traces: traces({
      'claude-code': [{ kind: 'unknown_record', raw_type: 'x' }],
      pi: [],
    }),
    toolNameToKey,
    toolKeys: ['other'],
  });
  const unk = payload.kinds.find(k => k.id === 'unknown_record');
  assert.equal(unk.role, 'catchall');
  assert.deepEqual(unk.expect, [0, 0]);
  const html = renderKindMapSnippet(payload);
  assert.ok(html.includes('k-catch'));
  const other = payload.tools.find(t => t.key === 'other');
  assert.equal(other.role, 'catchall');
  assert.ok(html.includes('data-tool="other"') && html.includes('k-na'));
});

test('applyKindMapPulse — words pulse lights content_block/words route', () => {
  const base = buildKindMapPayload({
    harnesses: HARNESSES,
    kinds: ['content_block'],
    kindPulse: KIND_PULSE,
    traces: traces({ 'claude-code': [], pi: [] }),
    toolNameToKey,
    toolKeys: ['read'],
  });
  const next = applyKindMapPulse(base, 'words', {
    harness: 'pi', nr_kind: 'content_block', word_count: 4,
  });
  const row = next.kinds.find(k => k.id === 'content_block');
  assert.equal(row.emit[1], 1);
  assert.deepEqual(row.proof[1], ['pulse']);
  assert.equal(row.routes.find(r => r.id === 'words').emit[1], 1);
  assert.equal(row.routes.find(r => r.id === 'thinking').emit[1], 0);
});

test('renderKindMapSnippet — one cell per kind×harness, no authored ids required', () => {
  const payload = buildKindMapPayload({
    harnesses: HARNESSES,
    kinds: ['user_turn', 'session_meta'],
    kindPulse: KIND_PULSE,
    traces: traces({ 'claude-code': [{ kind: 'user_turn' }], pi: [] }),
    toolNameToKey,
    toolKeys: ['read'],
  });
  const html = renderKindMapSnippet(payload);
  assert.ok(html.includes('k-kind-map'));
  assert.ok(html.includes('user_turn'));
  assert.ok(html.includes('claude-code'));
  assert.ok(html.includes('pi'));
  // user_turn row + its `human` origin route (Phase 1.5) — both proved by the golden
  assert.equal((html.match(/<td class="k-emit"/g) || []).length, 2);
  assert.ok(html.includes('title="golden"'));
  assert.ok(html.includes('data-role='));
  assert.ok(html.includes('k-hit'));
  assert.ok(!/#0{0,2}0{0,2}ff\b/i.test(html.split('<style>')[1] || ''), 'no blue hex in widget css');
  assert.ok(!/box-shadow/.test(html));
  assert.ok(!/linear-gradient/.test(html));
});

test('renderKindMapSnippet — live-only proof is ○ not ●', () => {
  const payload = buildKindMapPayload({
    harnesses: HARNESSES,
    kinds: ['tool_use'],
    kindPulse: KIND_PULSE,
    traces: traces({ 'claude-code': [], pi: [] }),
    toolNameToKey,
    toolKeys: ['read'],
  });
  const next = applyKindMapPulse(payload, 'tool_call', {
    harness: 'claude-code', tool: 'Read', key: 'read', nr_kind: 'tool_use',
  });
  const html = renderKindMapSnippet(next);
  assert.ok(html.includes('k-live'));
  assert.ok(html.includes('&#9675;') || html.includes('○'));
  assert.equal((html.match(/<td class="k-emit"/g) || []).length, 0);
});

test('renderKindMapPage — tokens wrap and status line', () => {
  const html = renderKindMapPage({
    generated_at: '2026-08-26T00:00:00.000Z',
    harnesses: HARNESSES,
    kinds: [],
    tools: [],
  }, { tokensCss: ':root { --k-bg: #000000; }', live: true, streamEvents: ['tool_call'] });
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('2026-08-26T00:00:00.000Z'));
  assert.ok(html.includes('k-topbar'));
  assert.ok(html.includes('EventSource'));
  assert.ok(html.includes('?partial=1'));
  assert.ok(!html.includes('function paint('));
  assert.ok(html.includes('kindMapPulseHits'));
  assert.ok(html.includes('function onPulse'));
  assert.ok(html.includes('k-map-live'));
  assert.ok(html.includes('@keyframes k-hit') || html.includes('animation: k-hit'));
  assert.ok(html.includes('background: var(--k-geo)'));
});

test('unknown bucket — live unknown pulse upserts a shareable signature', () => {
  const data = {
    harness: 'grok', nr_kind: 'unknown_record', raw_type: 'atis-latch',
    slug: 'abcd1234', project: 'kaaro', ts: 't1',
  };
  assert.equal(unknownFromPulse('words', data), null);
  assert.deepEqual(unknownFromPulse('unknown', data), mapUnknownFromPulse('unknown', data));
  let bucket = addUnknown([], unknownFromPulse('unknown', data));
  assert.equal(bucket.length, 1);
  assert.equal(bucket[0].count, 1);
  assert.equal(bucket[0].raw_type, 'atis-latch');
  bucket = addUnknown(bucket, unknownFromPulse('unknown', { ...data, ts: 't2', slug: 'efgh' }));
  assert.equal(bucket.length, 1);
  assert.equal(bucket[0].count, 2);
  assert.equal(bucket[0].slug, 'efgh');
  const base = buildKindMapPayload({
    harnesses: HARNESSES,
    kinds: ['unknown_record'],
    kindPulse: KIND_PULSE,
    traces: traces({ 'claude-code': [], pi: [] }),
    toolNameToKey,
    toolKeys: ['read'],
  });
  const next = applyKindMapPulse(base, 'unknown', {
    harness: 'claude-code', nr_kind: 'unknown_record', raw_type: 'mystery', slug: 's1',
  });
  assert.equal(next.unknowns.length, 1);
  assert.equal(next.unknowns[0].raw_type, 'mystery');
  assert.equal(next.unknowns[0].count, 1);
  const html = renderKindMapSnippet(next);
  assert.ok(html.includes('k-unknown-bucket'));
  assert.ok(html.includes('copy JSON'));
  assert.ok(html.includes('mystery'));
});

test('unknown bucket — goldens do not seed the shareable list', () => {
  const payload = buildKindMap({ generated_at: 't0' });
  assert.deepEqual(payload.unknowns, []);
  const cc = payload.harnesses.findIndex(h => h.id === 'claude-code');
  const unk = payload.kinds.find(k => k.id === 'unknown_record');
  assert.equal(unk.emit[cc], 1, 'catch-all still proved on the kind grid');
});

test('kindMapPulseHits — Stream pulse lights kind, route, and tool cells', () => {
  assert.deepEqual(kindMapPulseHits('now', { harness: 'pi' }), []);
  assert.deepEqual(kindMapPulseHits('tool_call', {}), []);
  const tool = kindMapPulseHits('tool_call', {
    harness: 'claude-code', nr_kind: 'tool_use', tool: 'Read', key: 'read',
  });
  assert.deepEqual(tool, [
    { type: 'kind', id: 'tool_use', h: 'claude-code' },
    { type: 'tool', key: 'read', h: 'claude-code', name: 'Read' },
  ]);
  const words = kindMapPulseHits('words', {
    harness: 'pi', nr_kind: 'content_block', word_count: 5,
  });
  assert.deepEqual(words.map(h => h.id), ['content_block', 'content_block/words']);
  assert.equal(routeIdFromPulse('words', { nr_kind: 'content_block' }), 'words');
  assert.equal(words[1].id, 'content_block/' + routeIdFromPulse('words', { nr_kind: 'content_block' }));
});

test('renderKindMapPage — static copy has no EventSource', () => {
  const html = renderKindMapPage({
    generated_at: 't0',
    harnesses: HARNESSES,
    kinds: [],
    tools: [],
  }, { tokensCss: '', live: false });
  assert.ok(!html.includes('EventSource'));
  assert.ok(html.includes('static'));
  assert.ok(!html.includes('listening /events'));
});

test('gatherKindMapTraces — every registry harness has golden/sample arrays', () => {
  const tracesOut = gatherKindMapTraces(undefined, EVENT_TYPES);
  for (const id of HARNESS_IDS) {
    assert.ok(tracesOut[id], `missing traces for ${id}`);
    assert.ok(Array.isArray(tracesOut[id].golden), `${id} golden not an array`);
    assert.ok(Array.isArray(tracesOut[id].sample), `${id} sample not an array`);
    assert.ok(
      tracesOut[id].golden.length + tracesOut[id].sample.length > 0,
      `${id} produced no NRs from goldens/samples`,
    );
  }
});

test('buildKindMap — live gather: claude-code emits tool_use; kinds match contract', () => {
  const payload = buildKindMap({ generated_at: 't0', eventTypes: EVENT_TYPES });
  assert.deepEqual(payload.kinds.map(k => k.id), RECORD_KINDS);
  assert.deepEqual(payload.harnesses.map(h => h.id), HARNESS_IDS);
  const toolUse = payload.kinds.find(k => k.id === 'tool_use');
  const cc = payload.harnesses.findIndex(h => h.id === 'claude-code');
  assert.equal(toolUse.emit[cc], 1);
  assert.ok(toolUse.proof[cc].includes('golden') || toolUse.proof[cc].includes('sample'));
  assert.equal(payload.harnesses[0].adapter, undefined);
  const read = payload.tools.find(t => t.key === 'read');
  assert.ok(read.by_harness['claude-code'].length > 0);
  assert.ok([...TOOL_ACTION_KEYS].every(k => payload.tools.some(t => t.key === k)));
});

test('kindFromPulse — nr_kind is the only reverse path; lifecycle is null', () => {
  assert.equal(kindFromPulse('tool_call', { nr_kind: 'tool_use' }), 'tool_use');
  assert.equal(kindFromPulse('tool_call', {}), null);
  assert.equal(kindFromPulse('human_turn', { nr_kind: 'user_turn' }), 'user_turn');
  assert.equal(kindFromPulse('silent', { nr_kind: 'session_meta' }), 'session_meta');
  assert.equal(kindFromPulse('words', { nr_kind: 'content_block' }), 'content_block');
  assert.equal(kindFromPulse('now', {}), null);
  assert.equal(kindFromPulse('updated', {}), null);
});

test('applyKindMapPulse — live SSE tool_call lights emit, records raw tool, stamps pulse proof', () => {
  const base = buildKindMapPayload({
    harnesses: HARNESSES,
    kinds: ['tool_use', 'user_turn'],
    kindPulse: KIND_PULSE,
    traces: traces({ 'claude-code': [], pi: [] }),
    toolNameToKey,
    toolKeys: ['read', 'write'],
  });
  const skipped = applyKindMapPulse(base, 'tool_call', {
    harness: 'claude-code', tool: 'Read', key: 'read',
  });
  assert.equal(skipped, base, 'no nr_kind → no overlay');
  const next = applyKindMapPulse(base, 'tool_call', {
    harness: 'claude-code', tool: 'Read', key: 'read', nr_kind: 'tool_use',
  });
  const row = next.kinds.find(k => k.id === 'tool_use');
  assert.deepEqual(row.emit, [1, 0]);
  assert.deepEqual(row.proof[0], ['pulse']);
  assert.deepEqual(next.tools.find(t => t.key === 'read').by_harness['claude-code'], ['Read']);
  const again = applyKindMapPulse(next, 'tool_call', {
    harness: 'claude-code', tool: 'Read', key: 'read', nr_kind: 'tool_use',
  });
  assert.equal(again, next, 'repeat pulse is a no-op');
  assert.equal(again.kinds, next.kinds);
  assert.equal(again.tools, next.tools);
  assert.equal(applyKindMapPulse(next, 'now', { harness: 'claude-code' }), next);
});

test('applyKindMapPulse — unknown upsert does not remap kinds/tools', () => {
  const base = buildKindMapPayload({
    harnesses: HARNESSES,
    kinds: ['unknown_record'],
    kindPulse: KIND_PULSE,
    traces: traces({
      'claude-code': [{ kind: 'unknown_record', raw_type: 'x' }],
      pi: [],
    }),
    toolNameToKey,
    toolKeys: ['read'],
  });
  const lit = applyKindMapPulse(base, 'unknown', {
    harness: 'claude-code', nr_kind: 'unknown_record', raw_type: 'x',
  });
  assert.equal(lit.kinds.find(k => k.id === 'unknown_record').emit[0], 1);
  const kindsRef = lit.kinds;
  const toolsRef = lit.tools;
  const next = applyKindMapPulse(lit, 'unknown', {
    harness: 'claude-code', nr_kind: 'unknown_record', raw_type: 'x', ts: 't2',
  });
  assert.notEqual(next, lit, 'count bump yields a new payload');
  assert.equal(next.unknowns[0].count, 2);
  assert.equal(next.kinds, kindsRef, 'kinds array not reallocated');
  assert.equal(next.tools, toolsRef, 'tools array not reallocated');
});

test('surface kind-map modules do not import experience', () => {
  for (const rel of [
    '../surface/kind-map-build.mjs',
    '../surface/kind-map-store.mjs',
    '../surface/http-routes.mjs',
  ]) {
    const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.ok(
      !/from ['"]\.\.\/experience\//.test(src),
      `${rel} imports experience — one-way layering is hooks → surface → experience`,
    );
  }
});

test('createKindMapStore — pulses accumulate on the baseline golden', () => {
  const store = createKindMapStore({
    buildBaseline: () => buildKindMapPayload({
      harnesses: HARNESSES,
      kinds: ['tool_use'],
      kindPulse: KIND_PULSE,
      traces: traces({ 'claude-code': [], pi: [] }),
      toolNameToKey,
      toolKeys: ['read'],
    }),
  });
  assert.equal(store.snapshot().kinds[0].emit[0], 0);
  store.applyPulse({ event: 'tool_call', data: { harness: 'claude-code', tool: 'Read', key: 'read' } });
  assert.equal(store.snapshot().kinds[0].emit[0], 0);
  store.applyPulse({
    event: 'tool_call',
    data: { harness: 'claude-code', tool: 'Read', key: 'read', nr_kind: 'tool_use' },
  });
  assert.equal(store.snapshot().kinds[0].emit[0], 1);
  assert.deepEqual(store.snapshot().kinds[0].proof[0], ['pulse']);
  assert.equal(typeof store.mergeSessions, 'undefined');
});

test('local tags — detected+verified is LOCAL; disk-only is disk', () => {
  const payload = buildKindMapPayload({
    harnesses: [
      { id: 'claude-code', label: 'CC', capabilities: {}, detected: true, verified: true },
      { id: 'pi', label: 'Pi', capabilities: {}, detected: true, verified: false },
    ],
    kinds: ['user_turn'],
    kindPulse: KIND_PULSE,
    traces: traces({ 'claude-code': [], pi: [] }),
    toolNameToKey,
    toolKeys: ['read'],
  });
  assert.equal(payload.harnesses[0].detected, true);
  assert.equal(payload.harnesses[0].verified, true);
  assert.equal(payload.harnesses[1].verified, false);
  const html = renderKindMapSnippet(payload);
  assert.ok(html.includes('k-tag-local'));
  assert.ok(html.includes('k-tag-disk'));
  assert.ok(html.includes('k-col-local'));
  const pulsed = applyKindMapPulse(payload, 'human_turn', {
    harness: 'pi', nr_kind: 'user_turn',
  });
  assert.equal(pulsed.harnesses[1].verified, true);
});

test('localHarnessFlags — detected from root, verified from local sessions', () => {
  const registry = [
    { id: 'claude-code', roots: ['/cc'] },
    { id: 'pi', roots: ['/pi'] },
  ];
  const flags = localHarnessFlags(registry, {
    exists: p => p === '/cc',
    sessions: [{ harness: 'claude-code' }, { harness: 'pi' }],
  });
  assert.deepEqual(flags['claude-code'], { detected: true, verified: true });
  assert.deepEqual(flags.pi, { detected: false, verified: false });
});

test('home tile links to /mapping with M shortcut, kept low-key', () => {
  const html = fs.readFileSync(new URL('../experience/pages/home.html', import.meta.url), 'utf8');
  assert.ok(html.includes('href="/mapping"'));
  assert.ok(html.includes("k === 'm'"));
  assert.ok(html.includes('Normalized Harness Tool Mapping'));
  assert.ok(/for contributors/i.test(html));
  const tilesStart = html.indexOf('id="tiles"');
  const contribStart = html.indexOf('id="contrib"');
  assert.ok(tilesStart >= 0 && contribStart > tilesStart);
  assert.ok(!html.slice(tilesStart, contribStart).includes('href="/mapping"'),
    'mapping is a low-key contributor strip below the product tiles, not one of them');
  assert.ok(/#contrib:not\(\.on\)\s*\{\s*display:\s*none;?\s*\}/.test(html.replace(/\n\s*/g, ' ')),
    'contrib strip is hidden until revealed, like the tiles');
  assert.ok(/getElementById\('contrib'\)\?\.classList\.add\('on'\)/.test(html),
    'contrib strip is revealed by the same revealChrome() call as the tiles, not on page load');
});

test('buildKindMapPayload — user_turn origin routes: human expected everywhere, injections n/a unless seen', () => {
  const payload = buildKindMapPayload({
    harnesses: HARNESSES,
    kinds: ['user_turn'],
    kindPulse: KIND_PULSE,
    traces: traces({
      'claude-code': [{ kind: 'user_turn', origin: 'human' }, { kind: 'user_turn', origin: 'sidechain' }],
      pi: [{ kind: 'user_turn' }],
    }),
    toolNameToKey,
    toolKeys: ['read'],
  });
  const row = payload.kinds.find(k => k.id === 'user_turn');
  const r = id => row.routes.find(x => x.id === id);
  assert.deepEqual(r('human').expect, [1, 1]);
  assert.deepEqual(r('human').emit, [1, 1]);
  assert.deepEqual(r('sidechain').expect, [0, 0]);
  assert.deepEqual(r('sidechain').emit, [1, 0]);
  assert.deepEqual(r('interrupt').emit, [0, 0]);
});
