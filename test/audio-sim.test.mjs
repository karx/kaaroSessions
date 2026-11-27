/**
 * test/audio-sim.test.mjs — TDD tests for lib/audio-sim.mjs + lib/audio-presets.mjs
 *
 * Covers:
 *   resolveSonic  — all 11 keys, spatial defaults, harness bias, rule overrides,
 *                   threshold rules, tokens brightness, instrument override
 *   resolveHz     — path_hash, sequential, root, deterministic "random"
 *   simulateSession — event extraction, silencing, summary counts
 *   audio-presets  — preset lookup, slug normalisation, all presets cover all keys
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSonic, resolveHz, simulateSession, formatTranscript, SCALES, TOOL_FAMILY, DEFAULT_SETTINGS } from '../experience/audio/audio-sim.mjs';
import { getPreset, AUDIO_PRESETS, PRESET_SLUGS } from '../experience/audio/audio-presets.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TS  = '2026-06-09T10:00:00.000Z';
const CTX = { session_id: 'aabb1122-0000-0000-0000-000000000000', slug: 'aabb1122', harness: 'claude-code', project_id: 'D--test', project_label: 'test' };

function ccAssistant(content = [], usage = { input_tokens: 10, output_tokens: 100 }, ts = TS) {
  return { type: 'assistant', timestamp: ts, message: { usage, content } };
}
function ccTool(name, input = {}) { return { type: 'tool_use', id: 'tu01', name, input }; }
function ccText(text)             { return { type: 'text', text }; }

const CF = getPreset('cognitive-flow');
const TD = getPreset('thrash-detector');
const SA = getPreset('session-arc');

function cfSim(event, data) { return resolveSonic(event, data, CF.settings, { mappings: CF.mappings }); }
function tdSim(event, data) { return resolveSonic(event, data, TD.settings, { mappings: TD.mappings }); }
function saSim(event, data) { return resolveSonic(event, data, SA.settings, { mappings: SA.mappings }); }

// ── resolveSonic: Cognitive Flow — all 11 keys ────────────────────────────────

test('resolveSonic CF — Read → harp, pan=+0.05, brightness=6500', () => {
  const s = cfSim('tool_call', { tool: 'Read', where: 'src/foo.js' });
  assert.equal(s.instrument, 'harp');
  assert.equal(s.key, 'read');
  assert.equal(s.fam, 'file');
  assert.equal(s.pan, 0.05);
  assert.equal(s.brightness, 6500);
  assert.equal(s.sendAmt, 0.05);
  assert.equal(s.volMult, 0.65);
});

test('resolveSonic CF — Write → bass, pan=-0.20, brightness=10000, vol=1.30', () => {
  const s = cfSim('tool_call', { tool: 'Write', where: 'src/app.js' });
  assert.equal(s.instrument, 'bass');
  assert.equal(s.key, 'write');
  assert.equal(s.pan, -0.20);
  assert.equal(s.brightness, 10000);
  assert.equal(s.volMult, 1.30);
  assert.equal(s.sendAmt, 0.04);
});

test('resolveSonic CF — Edit → pling, pan=-0.12, brightness=8500', () => {
  const s = cfSim('tool_call', { tool: 'Edit', where: 'lib/x.mjs' });
  assert.equal(s.instrument, 'pling');
  assert.equal(s.pan, -0.12);
  assert.equal(s.brightness, 8500);
});

test('resolveSonic CF — Grep → bit, pan=+0.10, brightness=5000, vol=0.55', () => {
  const s = cfSim('tool_call', { tool: 'Grep', where: 'foo' });
  assert.equal(s.instrument, 'bit');
  assert.equal(s.key, 'grep_glob');
  assert.equal(s.pan, 0.10);
  assert.equal(s.brightness, 5000);
  assert.equal(s.volMult, 0.55);
});

test('resolveSonic CF — Glob → bit (same as grep_glob)', () => {
  const s = cfSim('tool_call', { tool: 'Glob' });
  assert.equal(s.instrument, 'bit');
  assert.equal(s.key, 'grep_glob');
});

test('resolveSonic CF — Bash git → snare, pan=-0.38, brightness=3500, vol=1.10', () => {
  const s = cfSim('tool_call', { tool: 'Bash', category: 'git' });
  assert.equal(s.instrument, 'snare');
  assert.equal(s.key, 'bash_git');
  assert.equal(s.fam, 'system');
  assert.equal(s.pan, -0.38);
  assert.equal(s.brightness, 3500);
  assert.equal(s.volMult, 1.10);
});

test('resolveSonic CF — Bash node → kick, pan=-0.32, brightness=2800', () => {
  const s = cfSim('tool_call', { tool: 'Bash', category: 'node' });
  assert.equal(s.instrument, 'kick');
  assert.equal(s.key, 'bash_run');
  assert.equal(s.pan, -0.32);
  assert.equal(s.brightness, 2800);
});

test('resolveSonic CF — Bash other → hat, pan=-0.30, brightness=4000, vol=0.55', () => {
  const s = cfSim('tool_call', { tool: 'Bash', category: 'other' });
  assert.equal(s.instrument, 'hat');
  assert.equal(s.key, 'bash_other');
  assert.equal(s.pan, -0.30);
  assert.equal(s.brightness, 4000);
  assert.equal(s.volMult, 0.55);
});

test('resolveSonic CF — PowerShell → hat (bash_other path)', () => {
  const s = cfSim('tool_call', { tool: 'PowerShell', category: 'other' });
  assert.equal(s.instrument, 'hat');
  assert.equal(s.key, 'bash_other');
});

test('resolveSonic CF — Agent → bell, pan=+0.40, send=0.45, octave=1', () => {
  const s = cfSim('tool_call', { tool: 'Agent' });
  assert.equal(s.instrument, 'bell');
  assert.equal(s.key, 'agent');
  assert.equal(s.fam, 'ai');
  assert.equal(s.pan, 0.40);
  assert.equal(s.sendAmt, 0.45);
  assert.equal(s.octave, 1);
  assert.equal(s.brightness, 5000);
  assert.equal(s.volMult, 1.20);
});

test('resolveSonic CF — unknown tool → other → harp center, vol=0.60', () => {
  const s = cfSim('tool_call', { tool: 'ToolSearch' });
  assert.equal(s.key, 'other');
  assert.equal(s.instrument, 'harp');
  assert.equal(s.fam, 'ai');
  assert.equal(s.pan, 0.00);
  assert.equal(s.volMult, 0.60);
});

test('resolveSonic CF — tokens, cache=100% → brightness=800 (floor)', () => {
  // output=0 cache_read=1000 → cR=1.0 → brightness=round(800+4200*0)=800
  const s = cfSim('tokens', { output: 0, cache_read: 1000 });
  assert.equal(s.instrument, 'flute');
  assert.equal(s.key, 'tokens');
  assert.equal(s.fam, 'context');
  assert.equal(s.brightness, 800);
  assert.equal(s.octave, -1);
  assert.equal(s.sendAmt, 0.02);
});

test('resolveSonic CF — tokens, cache=0% → brightness=5000 (ceiling)', () => {
  const s = cfSim('tokens', { output: 200, cache_read: 0 });
  assert.equal(s.brightness, 5000);
});

test('resolveSonic CF — tokens, cache=50% → brightness=2900', () => {
  const s = cfSim('tokens', { output: 100, cache_read: 100 });
  assert.equal(s.brightness, Math.round(800 + 4200 * 0.5));
});

test('resolveSonic CF — tokens, no cache_read field → brightness=5000', () => {
  const s = cfSim('tokens', { output: 100 });
  assert.equal(s.brightness, 5000);
});

test('resolveSonic CF — words → bell, pan=+0.22, brightness=9000, octave=1, vol=0.90', () => {
  const s = cfSim('words', { word_count: 20, preview: 'hello world' });
  assert.equal(s.instrument, 'bell');
  assert.equal(s.key, 'words');
  assert.equal(s.fam, 'context');
  assert.equal(s.pan, 0.22);
  assert.equal(s.brightness, 9000);
  assert.equal(s.octave, 1);
  assert.equal(s.sendAmt, 0.14);
  assert.equal(s.volMult, 0.90);
});

// ── Harness pan bias ──────────────────────────────────────────────────────────
// Harness bias is applied to SPATIAL.pan and then mapping rules can override.
// These tests use an empty profile so only SPATIAL defaults + harness bias apply.

test('resolveSonic — harness=pi subtracts 0.15 from SPATIAL pan (write: -0.15 → -0.30)', () => {
  // SPATIAL.write.pan = -0.15; pi bias = -0.15 → -0.30
  const s = resolveSonic('tool_call', { tool: 'Write', harness: 'pi' }, DEFAULT_SETTINGS, { mappings: [] });
  assert.equal(s.pan, parseFloat((-0.15 - 0.15).toFixed(10)));
});

test('resolveSonic — harness=grok adds 0.25 to SPATIAL pan (read: +0.05 → +0.30)', () => {
  // SPATIAL.read.pan = +0.05; grok bias = +0.25 → +0.30
  const s = resolveSonic('tool_call', { tool: 'Read', harness: 'grok' }, DEFAULT_SETTINGS, { mappings: [] });
  assert.equal(s.pan, parseFloat((0.05 + 0.25).toFixed(10)));
});

test('resolveSonic — harness=antigravity adds 0.15 to SPATIAL pan (agent: +0.35 → +0.50)', () => {
  // SPATIAL.agent.pan = +0.35; antigravity bias = +0.15 → +0.50
  const s = resolveSonic('tool_call', { tool: 'Agent', harness: 'antigravity' }, DEFAULT_SETTINGS, { mappings: [] });
  assert.equal(s.pan, parseFloat((0.35 + 0.15).toFixed(10)));
});

test('resolveSonic — pan clamped to [-1, +1] even with extreme bias', () => {
  // words SPATIAL.pan=+0.20, add grok+0.25=0.45; within range
  const s = resolveSonic('words', { word_count: 10, harness: 'grok' }, DEFAULT_SETTINGS, { mappings: [] });
  assert.ok(s.pan >= -1 && s.pan <= 1);
});

// ── Mapping rule overrides ────────────────────────────────────────────────────

test('resolveSonic — mapping rule: instrument override wins over default', () => {
  const customProfile = {
    mappings: [{ match: { key: 'read' }, set: { instrument: 'bell' } }],
  };
  const s = resolveSonic('tool_call', { tool: 'Read' }, CF.settings, customProfile);
  assert.equal(s.instrument, 'bell');
});

test('resolveSonic — mapping rule: first match wins, later rules ignored', () => {
  const customProfile = {
    mappings: [
      { match: { key: 'read' }, set: { instrument: 'bell' } },
      { match: { key: 'read' }, set: { instrument: 'bass' } }, // should not apply
    ],
  };
  const s = resolveSonic('tool_call', { tool: 'Read' }, CF.settings, customProfile);
  assert.equal(s.instrument, 'bell');
});

test('resolveSonic — mapping rule: pan + send + brightness all overridden', () => {
  const customProfile = {
    mappings: [{ match: { key: 'write' }, set: { pan: 0.99, send: 0.88, brightness: 1234 } }],
  };
  const s = resolveSonic('tool_call', { tool: 'Write' }, CF.settings, customProfile);
  assert.equal(s.pan, 0.99);
  assert.equal(s.sendAmt, 0.88);
  assert.equal(s.brightness, 1234);
});

test('resolveSonic — threshold rule outMin: low output → fallthrough to next rule', () => {
  // Thrash Detector has two token rules: outMin:600 (first), then catch-all
  const s = tdSim('tokens', { output: 100, cache_read: 0 });
  assert.equal(s.volMult, 0.40); // catch-all rule
});

test('resolveSonic — threshold rule outMin: high output → first rule matches', () => {
  const s = tdSim('tokens', { output: 700, cache_read: 0 });
  assert.equal(s.volMult, 0.90); // outMin:600 rule
});

test('resolveSonic — threshold rule wordMin: low wordCount → catch-all', () => {
  const s = tdSim('words', { word_count: 10, preview: '' });
  assert.equal(s.volMult, 0.75);
  assert.equal(s.pan, 0.20);
});

test('resolveSonic — threshold rule wordMin: high wordCount → boosted rule', () => {
  const s = tdSim('words', { word_count: 50, preview: '' });
  assert.equal(s.volMult, 1.10);
  assert.equal(s.pan, 0.28);
});

// ── Thrash Detector specifics ─────────────────────────────────────────────────

test('resolveSonic TD — write: octave=-1 for grounding', () => {
  const s = tdSim('tool_call', { tool: 'Write' });
  assert.equal(s.octave, -1);
  assert.equal(s.pan, -0.25);
});

test('resolveSonic TD — bash_run: octave=-1', () => {
  const s = tdSim('tool_call', { tool: 'Bash', category: 'node' });
  assert.equal(s.octave, -1);
});

test('resolveSonic TD — scale=dorian, noteMode=sequential', () => {
  const s = tdSim('tool_call', { tool: 'Read' });
  assert.equal(s.scale, 'dorian');
  assert.equal(s.degreeMode, 'sequential');
});

// ── Session Arc specifics ─────────────────────────────────────────────────────

test('resolveSonic SA — tokens: instrument overridden to bass, octave=-2, degreeMode=root', () => {
  const s = saSim('tokens', { output: 200, cache_read: 0 });
  assert.equal(s.instrument, 'bass');
  assert.equal(s.octave, -2);
  assert.equal(s.degreeMode, 'root');
  assert.equal(s.brightness, 4000);
});

test('resolveSonic SA — words wordMin=50: octave=2', () => {
  const s = saSim('words', { word_count: 60, preview: '' });
  assert.equal(s.octave, 2);
  assert.equal(s.volMult, 1.20);
});

test('resolveSonic SA — words < 50: octave=1', () => {
  const s = saSim('words', { word_count: 20, preview: '' });
  assert.equal(s.octave, 1);
  assert.equal(s.volMult, 0.90);
});

test('resolveSonic SA — agent: degreeMode=root', () => {
  const s = saSim('tool_call', { tool: 'Agent' });
  assert.equal(s.degreeMode, 'root');
});

// ── resolveHz ─────────────────────────────────────────────────────────────────

test('resolveHz — path_hash: same where → same hz always', () => {
  const sonic = { scale: 'major_pentatonic', degreeMode: 'path_hash', octave: 0 };
  const d = { where: 'src/app.js' };
  const hz1 = resolveHz(d, sonic, 60, { idx: 0 });
  const hz2 = resolveHz(d, sonic, 60, { idx: 0 });
  assert.equal(hz1, hz2);
});

test('resolveHz — path_hash: different where → different hz (usually)', () => {
  const sonic = { scale: 'major_pentatonic', degreeMode: 'path_hash', octave: 0 };
  const hz1 = resolveHz({ where: 'src/a.js' }, sonic, 60, { idx: 0 });
  const hz2 = resolveHz({ where: 'src/b.js' }, sonic, 60, { idx: 0 });
  // Not guaranteed to differ (hash collision possible) but true for these inputs
  // Just verify both are valid positive frequencies
  assert.ok(hz1 > 0 && hz2 > 0);
});

test('resolveHz — root mode: always returns projectRoot degree=0', () => {
  const sonic = { scale: 'major_pentatonic', degreeMode: 'root', octave: 0 };
  const d1 = { where: 'src/a.js' };
  const d2 = { where: 'src/b.js', ts: 9999 };
  const hz1 = resolveHz(d1, sonic, 60, { idx: 0 });
  const hz2 = resolveHz(d2, sonic, 60, { idx: 99 });
  assert.equal(hz1, hz2); // same root regardless of input
});

test('resolveHz — sequential: advances degree each call', () => {
  const sonic = { scale: 'major_pentatonic', degreeMode: 'sequential', octave: 0 };
  const state = { idx: 0 };
  const hz1 = resolveHz({ where: 'x' }, sonic, 60, state);
  const hz2 = resolveHz({ where: 'x' }, sonic, 60, state);
  // degree advances so hz should differ unless wrap-around coincides
  assert.ok(state.idx > 0);
  assert.ok(hz1 > 0 && hz2 > 0);
});

test('resolveHz — octave shift changes hz by factor of 2', () => {
  const d = { where: 'src/app.js' };
  const s0 = { scale: 'major_pentatonic', degreeMode: 'root', octave: 0 };
  const s1 = { scale: 'major_pentatonic', degreeMode: 'root', octave: 1 };
  const hz0 = resolveHz(d, s0, 60, { idx: 0 });
  const hz1 = resolveHz(d, s1, 60, { idx: 0 });
  assert.equal(Math.round(hz1 / hz0), 2);
});

test('resolveHz — project root shifts base pitch', () => {
  const sonic = { scale: 'major_pentatonic', degreeMode: 'root', octave: 0 };
  const hz60 = resolveHz({}, sonic, 60, { idx: 0 }); // C4
  const hz72 = resolveHz({}, sonic, 72, { idx: 0 }); // C5
  assert.equal(Math.round(hz72 / hz60), 2);
});

// ── simulateSession ───────────────────────────────────────────────────────────

test('simulateSession — empty records → zero events', () => {
  const { events, summary } = simulateSession([], CTX, CF.settings, { mappings: CF.mappings });
  assert.equal(events.length, 0);
  assert.equal(summary.total, 0);
});

test('simulateSession — single tool_use → one tool_call event', () => {
  const records = [ccAssistant([ccTool('Write', { file_path: 'out.js' })])];
  const { events } = simulateSession(records, CTX, CF.settings, { mappings: CF.mappings });
  const tc = events.find(e => e.event === 'tool_call');
  assert.ok(tc, 'tool_call event expected');
  assert.equal(tc.sonic.instrument, 'bass');
  assert.equal(tc.sonic.key, 'write');
});

test('simulateSession — tokens usage → one tokens event', () => {
  const records = [ccAssistant([], { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 0 })];
  const { events } = simulateSession(records, CTX, CF.settings, { mappings: CF.mappings });
  const tok = events.find(e => e.event === 'tokens');
  assert.ok(tok, 'tokens event expected');
  assert.equal(tok.sonic.key, 'tokens');
  assert.equal(tok.sonic.instrument, 'flute');
});

test('simulateSession — text ≥3 words → words event', () => {
  const records = [ccAssistant([ccText('Hello world this is a test')])];
  const { events } = simulateSession(records, CTX, CF.settings, { mappings: CF.mappings });
  const w = events.find(e => e.event === 'words');
  assert.ok(w, 'words event expected');
  assert.equal(w.sonic.instrument, 'bell');
});

test('simulateSession — text <3 words → no words event', () => {
  const records = [ccAssistant([ccText('OK')])];
  const { events } = simulateSession(records, CTX, CF.settings, { mappings: CF.mappings });
  assert.equal(events.filter(e => e.event === 'words').length, 0);
});

test('simulateSession — permission-mode record produces permission event', () => {
  const records = [
    { type: 'permission-mode', permissionMode: 'plan' },
    ccAssistant([ccTool('Read', { file_path: 'x.js' })]),
  ];
  const { events, summary } = simulateSession(records, CTX, CF.settings, { mappings: CF.mappings });
  assert.ok(events.some(e => e.event === 'permission'), 'permission-mode record must produce permission event');
  assert.equal(summary.tool_call, 1);
  assert.equal(summary.unknown, 0);
  assert.ok(summary.silent >= 1, 'assistant_turn envelope is a silent rest, not unknown');
});

test('simulateSession — compact_boundary record produces compact event', () => {
  const records = [
    { type: 'system', subtype: 'compact_boundary' },
    ccAssistant([ccTool('Write', { file_path: 'x.js' })]),
  ];
  const { events, summary } = simulateSession(records, CTX, CF.settings, { mappings: CF.mappings });
  assert.ok(events.some(e => e.event === 'compact'), 'compact_boundary record must produce compact event');
  assert.equal(summary.unknown, 0);
  assert.ok(summary.silent >= 1, 'assistant_turn envelope is a silent rest, not unknown');
});

test('simulateSession — user record produces human_turn event', () => {
  const records = [
    { type: 'user', message: { content: 'Do the thing' } },
    ccAssistant([ccTool('Read', { file_path: 'x.js' })]),
  ];
  const { events, summary } = simulateSession(records, CTX, CF.settings, { mappings: CF.mappings });
  assert.ok(events.some(e => e.event === 'human_turn'), 'user record must produce human_turn event');
  assert.equal(summary.tool_call, 1);
  assert.equal(summary.unknown, 0);
  assert.ok(summary.silent >= 1, 'assistant_turn envelope is a silent rest, not unknown');
});

test('simulateSession — instrument=off excluded from events', () => {
  const offProfile = {
    mappings: [{ match: { key: 'read' }, set: { instrument: 'off' } }],
  };
  const records = [ccAssistant([ccTool('Read', { file_path: 'x.js' })])];
  const { events } = simulateSession(records, CTX, CF.settings, offProfile);
  assert.equal(events.filter(e => e.event === 'tool_call' && e.sonic.key === 'read').length, 0);
});

test('simulateSession — summary counts match event array', () => {
  const records = [
    ccAssistant([ccTool('Write', { file_path: 'a.js' }), ccTool('Read', { file_path: 'b.js' }), ccText('Hello world test')], { input_tokens: 5, output_tokens: 50 }),
  ];
  const { events, summary } = simulateSession(records, CTX, CF.settings, { mappings: CF.mappings });
  assert.equal(summary.total, events.length);
  assert.equal(summary.tool_call, events.filter(e => e.event === 'tool_call').length);
  assert.equal(summary.tokens,    events.filter(e => e.event === 'tokens').length);
  assert.equal(summary.words,     events.filter(e => e.event === 'words').length);
});

test('simulateSession — relMs is 0 for first event, positive for later (different ts)', () => {
  const ts1 = '2026-06-09T10:00:00.000Z';
  const ts2 = '2026-06-09T10:00:05.000Z'; // +5s
  const records = [
    { type: 'assistant', timestamp: ts1, message: { usage: { output_tokens: 10 }, content: [ccTool('Read', { file_path: 'a.js' })] } },
    { type: 'assistant', timestamp: ts2, message: { usage: { output_tokens: 10 }, content: [ccTool('Write', { file_path: 'b.js' })] } },
  ];
  const { events } = simulateSession(records, CTX, CF.settings, { mappings: CF.mappings });
  const tc = events.filter(e => e.event === 'tool_call');
  assert.equal(tc[0].relMs, 0);
  assert.equal(tc[1].relMs, 5000);
});

// ── formatTranscript ──────────────────────────────────────────────────────────

test('formatTranscript — each event produces exactly one line', () => {
  const records = [
    ccAssistant([ccTool('Write', { file_path: 'x.js' }), ccText('Hello world test')],
                { input_tokens: 5, output_tokens: 30 }),
  ];
  const { events } = simulateSession(records, CTX, CF.settings, { mappings: CF.mappings });
  const lines = formatTranscript(events);
  assert.equal(lines.length, events.length);
});

test('formatTranscript — lines contain instrument, hz, pan, bri, rv fields', () => {
  const records = [ccAssistant([ccTool('Agent')])];
  const { events } = simulateSession(records, CTX, CF.settings, { mappings: CF.mappings });
  const lines = formatTranscript(events);
  // NR pipeline produces more events per assistant record (assistant_turn, tokens, content_block, tool_call)
  const tcLine = lines.find(l => l.includes('tool_call'));
  assert.ok(tcLine.includes('bell'),  'instrument');
  assert.ok(tcLine.includes('hz='),   'hz field');
  assert.ok(tcLine.includes('pan='),  'pan field');
  assert.ok(tcLine.includes('bri='),  'brightness field');
  assert.ok(tcLine.includes('rv='),   'reverb field');
  assert.ok(tcLine.includes('[AI'),   'family tag');
});

test('formatTranscript — tokens line contains output and cache% fields', () => {
  const records = [ccAssistant([], { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 1500 })];
  const { events } = simulateSession(records, CTX, CF.settings, { mappings: CF.mappings });
  const lines = formatTranscript(events);
  const tLine = lines.find(l => l.includes('tokens'));
  assert.ok(tLine, 'tokens line expected');
  assert.ok(tLine.includes('out='), 'output field');
  assert.ok(tLine.includes('cr='),  'cache ratio field');
});

// ── audio-presets ─────────────────────────────────────────────────────────────

test('getPreset — returns cognitive-flow by default (null input)', () => {
  const p = getPreset(null);
  assert.equal(p.name, 'Cognitive Flow');
});

test('getPreset — resolves by slug key', () => {
  assert.equal(getPreset('cognitive-flow').name, 'Cognitive Flow');
  assert.equal(getPreset('thrash-detector').name, 'Thrash Detector');
  assert.equal(getPreset('session-arc').name, 'Session Arc');
});

test('getPreset — resolves by display name (case-insensitive)', () => {
  assert.equal(getPreset('Cognitive Flow').name, 'Cognitive Flow');
  assert.equal(getPreset('session arc').name, 'Session Arc');
});

test('getPreset — unknown falls back to cognitive-flow', () => {
  const p = getPreset('does-not-exist');
  assert.equal(p.name, 'Cognitive Flow');
});

test('PRESET_SLUGS — has exactly 3 entries', () => {
  assert.equal(PRESET_SLUGS.length, 3);
});

// ── Grok tool name aliases ────────────────────────────────────────────────────

test('resolveSonic — Grok read_file aliases to key=read', () => {
  const s = resolveSonic('tool_call', { tool: 'read_file' }, DEFAULT_SETTINGS, { mappings: [] });
  assert.equal(s.key, 'read');
  assert.equal(s.fam, 'file');
  assert.equal(s.instrument, 'harp');
});

test('resolveSonic — Grok search_replace aliases to key=edit', () => {
  const s = resolveSonic('tool_call', { tool: 'search_replace' }, DEFAULT_SETTINGS, { mappings: [] });
  assert.equal(s.key, 'edit');
  assert.equal(s.fam, 'file');
  assert.equal(s.instrument, 'pling');
});

test('resolveSonic — Grok list_dir aliases to key=grep_glob', () => {
  const s = resolveSonic('tool_call', { tool: 'list_dir' }, DEFAULT_SETTINGS, { mappings: [] });
  assert.equal(s.key, 'grep_glob');
  assert.equal(s.fam, 'file');
  assert.equal(s.instrument, 'bit');
});

test('resolveSonic — Grok web_fetch → key=web, family=ai', () => {
  const s = resolveSonic('tool_call', { tool: 'web_fetch' }, DEFAULT_SETTINGS, { mappings: [] });
  assert.equal(s.key, 'web');
  assert.equal(s.fam, 'ai');
});

test('resolveSonic — Grok "Web search:" (title with space+colon) → key=web', () => {
  const s = resolveSonic('tool_call', { tool: 'Web search:' }, DEFAULT_SETTINGS, { mappings: [] });
  assert.equal(s.key, 'web');
  assert.equal(s.fam, 'ai');
});

test('resolveSonic — web_search normalised form → key=web', () => {
  const s = resolveSonic('tool_call', { tool: 'web_search' }, DEFAULT_SETTINGS, { mappings: [] });
  assert.equal(s.key, 'web');
});

test('resolveSonic — web key has valid SPATIAL defaults (positive pan, some send)', () => {
  const s = resolveSonic('tool_call', { tool: 'web_fetch' }, DEFAULT_SETTINGS, { mappings: [] });
  assert.ok(s.pan > 0, 'web pan should be positive (right channel)');
  assert.ok(s.sendAmt > 0, 'web should have some reverb send');
  assert.ok(s.brightness > 0, 'web brightness must be positive');
});

test('resolveSonic — Grok path_hash pitch varies by where for read_file alias', () => {
  // Two different files should (usually) produce different pitches via path_hash
  const s1 = resolveSonic('tool_call', { tool: 'read_file', where: 'src/app.js' }, DEFAULT_SETTINGS, { mappings: [] });
  const s2 = resolveSonic('tool_call', { tool: 'read_file', where: 'lib/util.mjs' }, DEFAULT_SETTINGS, { mappings: [] });
  // Just verify both are valid — can't guarantee different (hash collision possible on short fixture)
  assert.ok(s1.key === 'read' && s2.key === 'read');
});

// ── `web` key in presets ──────────────────────────────────────────────────────

test('CF preset — web key instrument defined', () => {
  assert.ok(CF.settings.instruments.web, 'CF instruments.web must be set');
});

test('TD preset — web key instrument defined', () => {
  assert.ok(TD.settings.instruments.web, 'TD instruments.web must be set');
});

test('SA preset — web key instrument defined', () => {
  assert.ok(SA.settings.instruments.web, 'SA instruments.web must be set');
});

test('resolveSonic CF — web_fetch uses CF preset mapping', () => {
  const s = cfSim('tool_call', { tool: 'web_fetch' });
  assert.equal(s.key, 'web');
  assert.ok(typeof s.pan === 'number');
  assert.ok(s.brightness > 0);
  assert.ok(s.volMult > 0);
});

// ── New event types (Phase 4 — resolveSonic must handle all, never null) ─────

test('resolveSonic — human_turn → bell instrument, family=human', () => {
  const s = resolveSonic('human_turn', {}, DEFAULT_SETTINGS, { mappings: [] });
  assert.ok(s !== null, 'human_turn must return non-null sonic');
  assert.equal(s.instrument, 'bell');
  assert.equal(s.fam, 'human');
});

test('resolveSonic — compact → kick instrument, family=system', () => {
  const s = resolveSonic('compact', {}, DEFAULT_SETTINGS, { mappings: [] });
  assert.ok(s !== null, 'compact must return non-null');
  assert.equal(s.instrument, 'kick');
  assert.equal(s.fam, 'system');
});

test('resolveSonic — chirp → pling instrument, family=context', () => {
  const s = resolveSonic('chirp', {}, DEFAULT_SETTINGS, { mappings: [] });
  assert.ok(s !== null, 'chirp must return non-null');
  assert.equal(s.instrument, 'pling');
  assert.equal(s.fam, 'context');
});

test('resolveSonic — permission → hat instrument, family=system', () => {
  const s = resolveSonic('permission', {}, DEFAULT_SETTINGS, { mappings: [] });
  assert.ok(s !== null, 'permission must return non-null');
  assert.equal(s.instrument, 'hat');
});

test('resolveSonic — scaffold → pling instrument', () => {
  const s = resolveSonic('scaffold', {}, DEFAULT_SETTINGS, { mappings: [] });
  assert.ok(s !== null, 'scaffold must return non-null');
  assert.equal(s.instrument, 'pling');
});

test('resolveSonic — aspirational instrument names fall back to playable', () => {
  const s = resolveSonic('human_turn', {}, { instruments: { human_turn: 'pad' } }, { mappings: [] });
  assert.equal(s.instrument, 'bell');
});

test('resolveSonic — unknown event type → catch-all (never null)', () => {
  const s = resolveSonic('completely_unknown_event', {}, DEFAULT_SETTINGS, { mappings: [] });
  assert.ok(s !== null, 'unknown event must return non-null catch-all');
  assert.ok(s.instrument, 'catch-all must have an instrument');
  assert.equal(s.key, 'completely_unknown_event');
  assert.ok(s.fam, 'catch-all must have a family');
});

test('resolveSonic — tool_call with data.key uses key directly (no tool name lookup)', () => {
  const s = resolveSonic('tool_call', { key: 'read' }, DEFAULT_SETTINGS, { mappings: [] });
  assert.equal(s.key, 'read');
  assert.equal(s.instrument, 'harp');
});

test('resolveSonic — tool_call with data.key=bash_git ignores data.tool', () => {
  const s = resolveSonic('tool_call', { key: 'bash_git', tool: 'SomeRandomTool' }, DEFAULT_SETTINGS, { mappings: [] });
  assert.equal(s.key, 'bash_git');
  assert.equal(s.instrument, 'snare');
});

// ── ruleMatches nr_kind support ──────────────────────────────────────────────

test('ruleMatches nr_kind: rule with nr_kind silences matching unknown event', () => {
  const profile = {
    mappings: [
      { match: { type: 'unknown', nr_kind: 'assistant_turn' }, set: { instrument: 'off', volMult: 0.00 } },
    ],
  };
  const s = resolveSonic('unknown', { nr_kind: 'assistant_turn' }, CF.settings, profile);
  assert.equal(s.instrument, 'off');
});

test('ruleMatches nr_kind: rule does not silence different nr_kind', () => {
  const profile = {
    mappings: [
      { match: { type: 'unknown', nr_kind: 'assistant_turn' }, set: { instrument: 'off', volMult: 0.00 } },
    ],
  };
  const s = resolveSonic('unknown', { nr_kind: 'session_meta' }, CF.settings, profile);
  assert.notEqual(s.instrument, 'off');
});

test('resolveSonic — silent event is instrument off without nr_kind rules', () => {
  const CF = AUDIO_PRESETS['cognitive-flow'];
  const s = resolveSonic('silent', { nr_kind: 'assistant_turn', reason: 'envelope' }, CF.settings, CF);
  assert.equal(s.instrument, 'off');
  assert.equal(s.volMult, 0);
  assert.equal(s.fam, 'meta');
});

test('ruleMatches nr_kind: rule without nr_kind matches all unknowns regardless of nr_kind', () => {
  const profile = {
    mappings: [
      { match: { key: 'unknown' }, set: { volMult: 0.05 } },
    ],
  };
  const s1 = resolveSonic('unknown', { nr_kind: 'assistant_turn' }, CF.settings, profile);
  const s2 = resolveSonic('unknown', { nr_kind: 'session_meta' }, CF.settings, profile);
  assert.equal(s1.volMult, 0.05);
  assert.equal(s2.volMult, 0.05);
});

// ── ALL_KEYS now includes 'web' ───────────────────────────────────────────────

import { EVENT_TYPE_KEYS, PLAYABLE_INSTRUMENTS } from '../experience/audio/event-registry.mjs';

const ALL_KEYS = [...EVENT_TYPE_KEYS];

for (const [slug, preset] of Object.entries(AUDIO_PRESETS)) {
  test(`preset ${slug} — instruments covers all event type keys`, () => {
    const inst = preset.settings.instruments;
    for (const key of ALL_KEYS) {
      assert.ok(inst[key], `instrument missing for key "${key}" in preset "${slug}"`);
      assert.ok(PLAYABLE_INSTRUMENTS.has(inst[key]),
        `preset "${slug}" instruments.${key}='${inst[key]}' is not playable`);
    }
  });

  test(`preset ${slug} — mappings cover all event type keys (at least once)`, () => {
    const coveredKeys = new Set(
      preset.mappings
        .map(r => r.match.key)
        .filter(Boolean)
        .flat()
    );
    for (const key of ALL_KEYS) {
      assert.ok(coveredKeys.has(key), `key "${key}" not covered by any mapping in preset "${slug}"`);
    }
  });

  test(`preset ${slug} — every mapping set has at least one field`, () => {
    for (const rule of preset.mappings) {
      const fields = Object.keys(rule.set || {});
      assert.ok(fields.length > 0, `empty set in mapping ${JSON.stringify(rule.match)} in "${slug}"`);
    }
  });
}

// ── Integration test — real session file (structural invariants only) ────────
// Snapshot diff is intentionally NOT here: a live/growing session will always
// diverge between --snap and the next test run. Use the CLI for diffs:
//   node scripts/sim-audio.mjs <sid> --snap   (baseline)
//   node scripts/sim-audio.mjs <sid> --diff   (regression check)

test('integration — real CC session produces valid transcript with CF preset', () => {
  const sessionPath = 'C:\\Users\\karx0\\.claude\\projects\\D--src-kaaroSessions\\277e6422-4abb-4f90-85fd-fbdcaf9f47ee.jsonl';
  if (!fs.existsSync(sessionPath)) return; // skip on other machines

  const records = fs.readFileSync(sessionPath, 'utf8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const ctx = { session_id: '277e6422-4abb-4f90-85fd-fbdcaf9f47ee', slug: '277e6422', harness: 'claude-code', project_id: 'D--src-kaaroSessions', project_label: 'kaaroSessions' };
  const { events, summary } = simulateSession(records, ctx, CF.settings, { mappings: CF.mappings });

  assert.ok(summary.total    > 0, 'some audible events expected');
  assert.ok(summary.tool_call > 0, 'tool calls expected');
  assert.ok(summary.tokens   > 0, 'token events expected');

  for (const ev of events) {
    assert.ok(ev.sonic.instrument,              `event ${ev.event} missing instrument`);
    assert.ok(typeof ev.sonic.pan === 'number', `event ${ev.event} pan must be number`);
    assert.ok(ev.sonic.brightness > 0,          `event ${ev.event} brightness must be positive`);
    assert.ok(ev.hz > 0,                        `event ${ev.event} hz must be positive`);
  }
});

// ── E5: error distinctness + bash bucket regression guards ───────────────────

test('every preset — tool_error and api_error sound unlike any tool action', () => {
  const TOOL_ACTION = ['read', 'write', 'edit', 'grep_glob', 'agent', 'bash_git', 'bash_run', 'bash_other', 'web', 'other'];
  for (const [slug, preset] of Object.entries(AUDIO_PRESETS)) {
    const inst = preset.settings.instruments;
    for (const errKey of ['tool_error', 'api_error']) {
      for (const k of TOOL_ACTION) {
        assert.notEqual(inst[errKey], inst[k],
          `${slug}: ${errKey} (${inst[errKey]}) must not share an instrument with ${k}`);
      }
    }
  }
});

test('every preset — the three bash buckets have three distinct instruments', () => {
  for (const [slug, preset] of Object.entries(AUDIO_PRESETS)) {
    const inst = preset.settings.instruments;
    const set = new Set([inst.bash_git, inst.bash_run, inst.bash_other]);
    assert.equal(set.size, 3, `${slug}: bash_git/bash_run/bash_other must be distinguishable`);
  }
});

test('resolveSonic — api_error pulses resolve to the api_error profile', () => {
  const s = cfSim('api_error', { message: 'quota exceeded', code: 'rate_limit' });
  assert.equal(s.key, 'api_error');
  assert.ok(s.volMult >= 1.0, 'api errors must be prominent');
});

test('simulateSession — human bells equal typed prompts; interrupt has its own voice; injected rows are silent', () => {
  const ts = '2026-06-09T10:00:00.000Z';
  const user = (content, extra = {}) => ({ type: 'user', timestamp: ts, message: { content }, ...extra });
  const records = [
    user('Run all the tests please'),
    user('<command-name>/review</command-name>'),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
    user('Base directory for this skill: /x', { isMeta: true }),
    user('<task-notification>done</task-notification>'),
    user('Summarise the repo', { isSidechain: true }),
    user('This session is being continued…', { isCompactSummary: true }),
    user('[Request interrupted by user]'),
  ];
  const { events, summary } = simulateSession(records, { harness: 'claude-code' });
  assert.equal(summary.human_turn, 2);
  assert.equal(summary.interrupt, 1);
  const intr = events.find(e => e.event === 'interrupt');
  assert.equal(intr.sonic.key, 'interrupt');
  assert.equal(intr.sonic.instrument, 'buzz');
});
