/**
 * lib/audio-sim.mjs — server-side audio simulation engine.
 *
 * Pure mirror of src/client/14-pulse-audio.js resolveSonic logic.
 * No Web Audio API, no DOM, no I/O.
 *
 * Pipeline:
 *   JSONL records → parsePulse() → pulses → resolveSonic() → SimEvent[]
 */

import { EVENT_TYPES, toolNameToKey, playableInstrument } from './event-registry.mjs';
import { normRecordsToPulses } from '../../hooks/pulse-transformer.mjs';
import { humanTurnEvent } from '../client-core.mjs';
import { recordsToNormalized as ccNorm }   from '../../hooks/adapters/claude-code.mjs';
import { recordsToNormalized as piNorm }   from '../../hooks/adapters/pi.mjs';
import { recordsToNormalized as agNorm }   from '../../hooks/adapters/antigravity.mjs';
import { recordsToNormalized as grokNorm } from '../../hooks/adapters/grok.mjs';

const NR_ADAPTERS = {
  'claude-code': ccNorm,
  'pi':          piNorm,
  'antigravity': agNorm,
  'grok':        grokNorm,
};

const HARNESS_CAPS = {
  'claude-code': { tokens: true  },
  'pi':          { tokens: true  },
  'antigravity': { tokens: false },
  'grok':        { tokens: false },
};

// ── Scales (mirrors 14-pulse-audio.js) ───────────────────────────────────────
export const SCALES = {
  major_pentatonic: [0, 2, 4, 7, 9],
  minor_pentatonic: [0, 3, 5, 7, 10],
  blues:            [0, 3, 5, 6, 7, 10],
  major:            [0, 2, 4, 5, 7, 9, 11],
  dorian:           [0, 2, 3, 5, 7, 9, 10],
};

// ── Family map (derived from EVENT_TYPES for backward compat) ─────────────────
export const TOOL_FAMILY = Object.fromEntries(
  Object.entries(EVENT_TYPES).map(([k, v]) => [k, v.family])
);

// ── Spatial defaults (derived from EVENT_TYPES for backward compat) ───────────
export const SPATIAL = Object.fromEntries(
  Object.entries(EVENT_TYPES).map(([k, v]) => [k, { pan: v.pan, sendAmt: v.sendAmt, brightness: v.brightness }])
);

export const HARNESS_PAN_BIAS = { pi: -0.15, antigravity: 0.15, grok: 0.25 };

export const DEFAULT_SETTINGS = {
  instruments: Object.fromEntries(
    Object.entries(EVENT_TYPES).map(([k, v]) => [k, v.instrument])
  ),
  scale:    'major_pentatonic',
  noteMode: 'path_hash',
  bpm:      120,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function strHash(s) {
  if (!s) return 0;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

function ruleMatches(rule, evType, data, key) {
  const m = rule.match || {};
  const fam = (EVENT_TYPES[key] || EVENT_TYPES.unknown).family;
  if (m.type && m.type !== evType) return false;
  const mFam = Array.isArray(m.family) ? m.family : (m.family ? [m.family] : null);
  if (mFam && !mFam.includes(fam)) return false;
  const mKey = Array.isArray(m.key) ? m.key : (m.key ? [m.key] : null);
  if (mKey && !mKey.includes(key)) return false;
  const mH = Array.isArray(m.harness) ? m.harness : (m.harness ? [m.harness] : null);
  if (mH && data.harness && !mH.includes(data.harness)) return false;
  if (m.project && data.project && data.project !== m.project) return false;
  if (m.whereContains && data.where && !String(data.where).includes(m.whereContains)) return false;
  if (m.wordMin != null && (data.word_count || 0) < m.wordMin) return false;
  if (m.outMin  != null && (data.output    || 0) < m.outMin)   return false;
  if (m.nr_kind != null && data.nr_kind !== m.nr_kind)          return false;
  return true;
}

// ── resolveSonic ──────────────────────────────────────────────────────────────
/**
 * Pure mirror of 14-pulse-audio.js resolveSonic().
 * @param {string} event    'tool_call' | 'tokens' | 'words' | 'human_turn' | etc.
 * @param {object} data     pulse data payload
 * @param {object} settings AUDIO_SETTINGS shape
 * @param {object} profile  AUDIO_PROFILE shape { mappings[] }
 * @returns {{ key, instrument, volMult, octave, degreeMode, scale, fam, pan, sendAmt, brightness }}
 */
export function resolveSonic(event, data, settings = DEFAULT_SETTINGS, profile = { mappings: [] }) {
  const S = { ...DEFAULT_SETTINGS, instruments: { ...DEFAULT_SETTINGS.instruments }, ...settings };
  if (settings.instruments) S.instruments = { ...DEFAULT_SETTINGS.instruments, ...settings.instruments };
  const P = profile || { mappings: [] };

  let degreeMode = S.noteMode;
  let scale = (P.scale || S.scale) || 'major_pentatonic';

  // Resolve canonical key
  let key;
  if (event === 'tool_call') {
    key = data.key || toolNameToKey(data.tool, data.category);
  } else {
    key = event;
  }

  // Read defaults from Event Registry (fall back to 'unknown' entry for unmapped keys)
  const et = EVENT_TYPES[key] || EVENT_TYPES.unknown;
  let instrument = (S.instruments && S.instruments[key]) || et.instrument || 'harp';
  let volMult    = et.volMult;
  let octave     = et.octave;
  let pan        = et.pan;
  let sendAmt    = et.sendAmt;
  let brightness = et.brightness;

  // Tokens brightness driven by cache ratio
  if (key === 'tokens') {
    const total = (data.output || 0) + (data.cache_read || 0);
    const cR = total > 0 ? (data.cache_read || 0) / total : 0;
    brightness = Math.round(800 + 4200 * (1 - cR));
    // vol scaling by output size (if no mapping rule overrides)
    volMult = Math.min(1.5, 0.04 + Math.log1p((data.output || 0) / 300) * 0.028) / 0.11;
  }

  // Harness pan bias (additive, clamped)
  const hBias = (data && data.harness) ? (HARNESS_PAN_BIAS[data.harness] || 0) : 0;
  pan = Math.max(-1, Math.min(1, pan + hBias));

  // Mapping rules — first match wins
  for (const rule of (P.mappings || [])) {
    if (!ruleMatches(rule, event, data, key)) continue;
    const eff = rule.set || {};
    if (eff.instrument)                      instrument  = eff.instrument;
    if (typeof eff.volMult    === 'number')  volMult     = eff.volMult;
    if (typeof eff.octave     === 'number')  octave      = eff.octave;
    if (eff.degreeMode)                      degreeMode  = eff.degreeMode;
    if (eff.scale)                           scale       = eff.scale;
    if (typeof eff.pan        === 'number')  pan         = Math.max(-1, Math.min(1, eff.pan));
    if (typeof eff.send       === 'number')  sendAmt     = eff.send;
    if (typeof eff.brightness === 'number')  brightness  = eff.brightness;
    break;
  }

  const fam = et.family;
  instrument = playableInstrument(instrument);
  return { key, instrument, volMult, octave, degreeMode, scale, fam, pan, sendAmt, brightness };
}

// ── resolveHz ─────────────────────────────────────────────────────────────────
/**
 * Deterministic pitch. Mirrors noteHz() from 14-pulse-audio.js.
 * Uses `projectRoot` (MIDI note, default 60=C4) instead of graph lookup.
 * `seqState` is mutated in-place for sequential mode.
 */
export function resolveHz(data, sonic, projectRoot = 60, seqState = { idx: 0 }) {
  const iv  = SCALES[sonic.scale] || SCALES.major_pentatonic;
  const mode = sonic.degreeMode;
  let degree = 0;

  if (mode === 'root') {
    degree = 0;
  } else if (mode === 'random') {
    // Deterministic "random": hash of where+ts so same input → same pitch
    degree = strHash((data.where || '') + String(data.ts || '')) % iv.length;
  } else if (mode === 'sequential') {
    seqState.idx = (seqState.idx + 1) % iv.length;
    degree = seqState.idx;
  } else {
    // path_hash (default)
    degree = data.where ? strHash(String(data.where)) % iv.length : 0;
  }

  const idx  = ((degree % iv.length) + iv.length) % iv.length;
  const midi = projectRoot + iv[idx] + (sonic.octave || 0) * 12;
  return parseFloat(midiToHz(midi).toFixed(1));
}

// ── simulateSession ───────────────────────────────────────────────────────────
/**
 * Run a full JSONL session through the audio pipeline.
 *
 * @param {object[]} records  Parsed JSONL records
 * @param {object}   ctx      { session_id, slug, harness, project_id, project_label }
 * @param {object}   settings AUDIO_SETTINGS
 * @param {object}   profile  AUDIO_PROFILE { mappings[] }
 * @param {number}   [projectRoot=60]  MIDI root for pitch (C4 default)
 * @returns {{ events: SimEvent[], summary: object, silentCount: number }}
 */
export function simulateSession(records, ctx = {}, settings = DEFAULT_SETTINGS, profile = { mappings: [] }, projectRoot = 60) {
  const harness  = ctx.harness || 'claude-code';
  const adaptFn  = NR_ADAPTERS[harness] ?? ccNorm;
  const caps     = HARNESS_CAPS[harness] ?? { tokens: true };

  const nrs    = adaptFn(records);
  const pulses = normRecordsToPulses(nrs, ctx, caps);

  const seqState  = { idx: 0 };
  const events    = [];
  let tsFirst     = null;
  let silentCount = 0;

  for (const pulse of pulses) {
    const rawTs = pulse.data?.ts;
    const ts    = rawTs != null ? new Date(rawTs).getTime() : null;
    if (ts !== null && tsFirst === null) tsFirst = ts;

    const relMs = (ts !== null && tsFirst !== null) ? ts - tsFirst : 0;
    // same origin routing as the live engine (14-pulse-audio.js playPulse)
    const event = pulse.event === 'human_turn' ? humanTurnEvent(pulse.data) : pulse.event;
    if (!event) { silentCount++; continue; }
    const sonic = resolveSonic(event, pulse.data, settings, profile);
    if (!sonic) { silentCount++; continue; }
    if (sonic.instrument === 'off') { silentCount++; continue; }

    const hz = resolveHz(pulse.data, sonic, projectRoot, seqState);
    events.push({ relMs, event, data: pulse.data, sonic, hz });
  }

  const summary = {
    total:       events.length,
    silent:      silentCount,
    tool_call:   events.filter(e => e.event === 'tool_call').length,
    tokens:      events.filter(e => e.event === 'tokens').length,
    words:       events.filter(e => e.event === 'words').length,
    human_turn:  events.filter(e => e.event === 'human_turn').length,
    interrupt:   events.filter(e => e.event === 'interrupt').length,
    compact:     events.filter(e => e.event === 'compact').length,
    scaffold:    events.filter(e => e.event === 'scaffold').length,
    permission:  events.filter(e => e.event === 'permission').length,
    chirp:       events.filter(e => e.event === 'chirp').length,
    mode_shift:  events.filter(e => e.event === 'mode_shift').length,
    attachment:  events.filter(e => e.event === 'attachment').length,
    thinking:    events.filter(e => e.event === 'thinking').length,
    tool_result: events.filter(e => e.event === 'tool_result').length,
    tool_error:  events.filter(e => e.event === 'tool_error').length,
    unknown:     events.filter(e => e.event === 'unknown').length,
  };

  return { events, summary, silentCount };
}

// ── dumpSession ──────────────────────────────────────────────────────────────
/**
 * Full pipeline dump — every NR → pulse, with sonic resolution and NR metadata.
 * Returns one row per pulse; audible:false rows are included (instrument='off').
 * Designed for debugging and refinement — not for production audio playback.
 *
 * @returns {object[]} DumpRow[]
 */
export function dumpSession(records, ctx = {}, settings = DEFAULT_SETTINGS, profile = { mappings: [] }, projectRoot = 60) {
  const harness = ctx.harness || 'claude-code';
  const adaptFn = NR_ADAPTERS[harness] ?? ccNorm;
  const caps    = HARNESS_CAPS[harness] ?? { tokens: true };

  const nrs    = adaptFn(records);
  const pulses = normRecordsToPulses(nrs, ctx, caps);

  const seqState = { idx: 0 };
  let tsFirst    = null;
  const rows     = [];

  for (let i = 0; i < pulses.length; i++) {
    const nr    = nrs[i];
    const pulse = pulses[i];
    const rawTs = pulse.data?.ts;
    const ts    = rawTs != null ? new Date(rawTs).getTime() : null;
    if (ts !== null && tsFirst === null) tsFirst = ts;
    const relMs = (ts !== null && tsFirst !== null) ? ts - tsFirst : 0;

    const sonic   = resolveSonic(pulse.event, pulse.data, settings, profile);
    const audible = !!(sonic && sonic.instrument !== 'off');
    const hz      = audible ? resolveHz(pulse.data, sonic, projectRoot, seqState) : null;

    const nr_label = nr.kind === 'content_block' && nr.block_type
      ? `content_block/${nr.block_type}`
      : nr.kind;

    rows.push({
      i,
      event:      pulse.event,
      audible,
      nr_kind:    nr_label,
      raw_type:   nr.raw_type   || null,
      instrument: sonic?.instrument || 'off',
      vol:        +(sonic?.volMult  || 0).toFixed(2),
      pan:        +(sonic?.pan      || 0).toFixed(2),
      hz,
      relMs,
      ts:         nr.ts || null,
      tool:       pulse.data.tool       || null,
      key:        pulse.data.key        || null,
      where:      pulse.data.where      || null,
      mode:       pulse.data.mode       || null,
      subtype:    pulse.data.subtype    || null,
      word_count: pulse.data.word_count || null,
      preview:    pulse.data.preview?.slice(0, 80) || null,
      branch:     nr.branch             || null,
      synthetic:  pulse.data.synthetic  || null,
    });
  }

  return rows;
}

// ── formatTranscript ──────────────────────────────────────────────────────────
/**
 * Render SimEvent[] to a text transcript (one event per line).
 * Stable and diffable — use for snapshots.
 */
export function formatTranscript(events) {
  return events.map(ev => {
    const { event, data, sonic, hz, relMs } = ev;
    const t      = `t+${(relMs / 1000).toFixed(3)}s`;
    const pan    = (sonic.pan >= 0 ? '+' : '') + sonic.pan.toFixed(2);
    const vol    = sonic.volMult.toFixed(2);
    const bri    = String(sonic.brightness).padStart(5);
    const hzStr  = String(hz).padStart(7);
    const fam    = (sonic.fam || 'unk').toUpperCase().padEnd(7);
    const inst   = sonic.instrument.padEnd(6);
    const key    = (sonic.key || '?').padEnd(11);

    let detail = '';
    if (event === 'tool_call') {
      const tool  = (data.tool || '?').padEnd(14);
      detail = `${tool}  ${key}`;
    } else if (event === 'tokens') {
      const cr  = data.cache_read != null && (data.output + data.cache_read) > 0
        ? Math.round(data.cache_read / (data.output + data.cache_read) * 100) : 0;
      detail = `out=${String(data.output || 0).padStart(6)} cr=${String(cr).padStart(3)}%  ${'tokens'.padEnd(25)}`;
    } else if (event === 'words') {
      const wc = String(data.word_count || 0).padStart(4);
      const pr = (data.preview || '').slice(0, 28).replace(/\n/g, ' ');
      detail = `${wc}w "${pr}"${''.padEnd(Math.max(0, 28 - pr.length))}  ${'words'.padEnd(11)}`;
    }

    const octStr = sonic.octave != null && sonic.octave !== 0
      ? (sonic.octave > 0 ? `oct+${sonic.octave}` : `oct${sonic.octave}`) : '     ';

    return `${t.padEnd(13)}  ${event.padEnd(10)}  ${detail}  ` +
           `${inst}  hz=${hzStr}  vol=${vol}  pan=${pan}  bri=${bri}  rv=${sonic.sendAmt.toFixed(2)}  ${octStr}  [${fam}]`;
  });
}

// ── formatSnapshotHeader ──────────────────────────────────────────────────────
export function formatSnapshotHeader(sessionId, presetSlug, summary, settings) {
  const now = new Date().toISOString().slice(0, 10);
  return [
    `# AUDIO TRANSCRIPT SNAPSHOT`,
    `# session=${sessionId}`,
    `# preset=${presetSlug}`,
    `# scale=${settings.scale || '?'}  noteMode=${settings.noteMode || '?'}  bpm=${settings.bpm || '?'}`,
    `# generated=${now}  projectRoot=60 (fixed)`,
    `# tool_call=${summary.tool_call}  words=${summary.words}  tokens=${summary.tokens}  total=${summary.total}  silent=${summary.silent}`,
    `# ${'─'.repeat(70)}`,
  ].join('\n');
}
