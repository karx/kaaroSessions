/**
 * test/public-index-nr.test.mjs → public/index.html normalized hop
 *
 * Guards the landing-page NR matrix against the live contract
 * (RECORD_KINDS, HARNESS_IDS, pulse-transformer cases) so the viz
 * cannot rot independently of hooks/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RECORD_KINDS, KIND_FIELDS } from '../hooks/normalized-record.mjs';
import { HARNESS_IDS } from '../hooks/registry.mjs';
import { EVENT_TYPES, PLAYABLE_FALLBACK } from '../experience/audio/event-registry.mjs';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function seedOf() {
  const m = html.match(/<script type="application\/json" id="nr-seed">([\s\S]*?)<\/script>/);
  assert.ok(m, 'public/index.html embeds nr-seed JSON');
  return JSON.parse(m[1]);
}

test('nr-seed — parses and lists every RECORD_KIND in contract order', () => {
  const seed = seedOf();
  assert.deepEqual(seed.kinds.map(k => k.id), RECORD_KINDS);
});

test('nr-seed — harness ids match the registry', () => {
  const seed = seedOf();
  assert.deepEqual(seed.harnesses.map(h => h.id), HARNESS_IDS);
});

test('nr-seed — emit vector length matches harness count', () => {
  const seed = seedOf();
  for (const k of seed.kinds) {
    assert.equal(k.emit.length, seed.harnesses.length, k.id + ' emit length');
    for (const v of k.emit) assert.ok(v === 0 || v === 1, k.id + ' emit not 0/1');
  }
});

test('nr-seed — required fields are a subset of KIND_FIELDS', () => {
  const seed = seedOf();
  for (const k of seed.kinds) {
    const spec = KIND_FIELDS[k.id];
    const allowed = new Set([...Object.keys(spec.required), ...Object.keys(spec.optional)]);
    for (const f of [...k.required, ...k.optional]) {
      assert.ok(allowed.has(f), k.id + ' lists unknown field ' + f);
    }
    for (const f of k.required) {
      assert.ok(Object.prototype.hasOwnProperty.call(spec.required, f), k.id + ' required ' + f + ' not in contract');
    }
  }
});

test('nr-seed — dedicated pulse names match the transformer', () => {
  const seed = seedOf();
  const byId = Object.fromEntries(seed.kinds.map(k => [k.id, k.pulse]));
  assert.equal(byId.user_turn, 'human_turn');
  assert.equal(byId.tool_use, 'tool_call');
  assert.equal(byId.tokens, 'tokens');
  assert.equal(byId.context_reset, 'compact');
  assert.equal(byId.permission_mode, 'permission');
  assert.equal(byId.mode_shift, 'mode_shift');
  assert.equal(byId.attachment, 'attachment');
  assert.equal(byId.scaffold, 'scaffold');
  assert.equal(byId.api_error, 'api_error');
  assert.equal(byId.unknown_record, 'unknown');
  assert.equal(byId.tool_result, 'tool_result');
  assert.equal(byId.content_block, 'words');
  assert.equal(byId.assistant_turn, 'silent');
  assert.equal(byId.session_meta, 'silent');
  assert.equal(byId.skill_invoke, 'silent');
  assert.equal(byId.branch_change, 'silent');
});

test('nr-seed — tape kinds exist in the contract and labels are the kind id', () => {
  const seed = seedOf();
  const ids = new Set(RECORD_KINDS);
  for (const step of seed.tape) {
    assert.ok(ids.has(step.kind), 'tape kind missing: ' + step.kind);
    assert.ok(step.preview && step.preview.length > 0, 'tape preview missing: ' + step.kind);
  }
});

test('nr-seed — every kind except api_error has at least one sample', () => {
  const seed = seedOf();
  for (const k of RECORD_KINDS) {
    if (k === 'api_error') {
      assert.ok(!seed.samples[k], 'api_error should have no sample (no adapter emits it)');
      continue;
    }
    assert.ok(seed.samples[k], 'missing sample for ' + k);
  }
});

test('nr-seed — sample NR JSON has matching kind + harness that emits it', () => {
  const seed = seedOf();
  const hIndex = Object.fromEntries(seed.harnesses.map((h, i) => [h.id, i]));
  const byKind = Object.fromEntries(seed.kinds.map(k => [k.id, k]));
  for (const [kind, byH] of Object.entries(seed.samples)) {
    assert.ok(RECORD_KINDS.includes(kind), 'sample for unknown kind ' + kind);
    for (const [hid, rec] of Object.entries(byH)) {
      assert.ok(HARNESS_IDS.includes(hid), 'sample harness ' + hid);
      const nr = JSON.parse(rec.nr);
      assert.equal(nr.kind, kind);
      assert.equal(nr.harness, hid);
      JSON.parse(rec.raw);
      assert.ok(typeof rec.pulse === 'string' && rec.pulse.length > 0);
      assert.equal(byKind[kind].emit[hIndex[hid]], 1, kind + ' sample on ' + hid + ' but emit is 0');
    }
  }
});

test('landing shell — shortcut chrome and section ids', () => {
  for (const id of ['statusbar', 'help-panel', 'help-btn', 's-incident', 's-surface', 's-hop', 's-audio', 's-views', 's-privacy', 's-install']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing #' + id);
  }
  assert.ok(html.includes('? help'), 'status bar should document ? help');
  assert.ok(html.includes('enable audio'), 'audio is opt-in');
  assert.ok(html.includes('Every adapter normalizes into the same sixteen kind vocabulary.'));
  assert.ok(html.includes('id="hop-guide"') && html.includes('id="nr-legend"'));
  assert.ok(html.includes("Hop: what you're looking at") || html.includes('what you\'re looking at'));
  assert.ok(!html.includes('id="tile-graph"') && !html.includes('kaaroSessions --graph'), 'no app-only G/N/D chooser on the public page');
});

function audioOf() {
  const m = html.match(/<script type="application\/json" id="audio-seed">([\s\S]*?)<\/script>/);
  assert.ok(m, 'public/index.html embeds audio-seed JSON');
  return JSON.parse(m[1]);
}

test('audio-seed — events cover EVENT_TYPES keys and axes', () => {
  const a = audioOf();
  const keys = a.events.map(e => e.key);
  assert.deepEqual(keys.sort(), Object.keys(EVENT_TYPES).sort());
  for (const e of a.events) {
    const src = EVENT_TYPES[e.key];
    assert.equal(e.family, src.family, e.key + ' family');
    assert.equal(e.instrument, src.instrument, e.key + ' instrument');
    assert.equal(e.pan, src.pan, e.key + ' pan');
    assert.equal(e.brightness, src.brightness, e.key + ' brightness');
    assert.equal(e.volMult, src.volMult, e.key + ' volMult');
    assert.equal(e.octave, src.octave, e.key + ' octave');
  }
});

test('audio-seed — kindSonic maps every RECORD_KIND to a registry key or null', () => {
  const a = audioOf();
  assert.deepEqual(Object.keys(a.kindSonic).sort(), RECORD_KINDS.slice().sort());
  for (const [kind, key] of Object.entries(a.kindSonic)) {
    if (key == null) continue;
    assert.ok(EVENT_TYPES[key], kind + ' sonic key missing from EVENT_TYPES: ' + key);
  }
});

test('audio-seed — stand-in voices match the live engine; every default plays on this page', () => {
  const a = audioOf();
  assert.deepEqual(a.fallbackInst, PLAYABLE_FALLBACK);
  const block = html.slice(html.indexOf('  const INSTS = {'), html.indexOf('  function playEvent('));
  const synths = new Set([...block.matchAll(/^    (\w+)\(c, at,/gm)].map(m => m[1]));
  for (const e of a.events) {
    if (e.instrument === 'off') continue;
    const heard = a.fallbackInst[e.instrument] || e.instrument;
    assert.ok(synths.has(heard), e.key + ' plays ' + heard + ', which this page does not synthesise');
  }
});

test('audio-seed — AudioContext is opt-in (no autoplay constructor in markup)', () => {
  assert.ok(html.includes("setAudioOn(!audioOn)") || html.includes('toggleAudio'), 'toggle exists');
  assert.match(html, /let audioOn = false/);
  assert.ok(!/new \(window\.AudioContext/.test(html.split('function ac()')[0]), 'AudioContext not constructed at parse time');
});
