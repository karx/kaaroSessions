/**
 * hooks/pulse-map.mjs — NR kind → pulse disposition.
 *
 * Every RECORD_KIND has a row. The transformer builds payload from this
 * table; it does not invent dispositions in switch fallthrough.
 *
 *   sonic   — named event in the Event Registry (live signal)
 *   silent  — known NR, no live sonic (envelope / snapshot / duplicate)
 *   unknown — coverage hole only (unknown_record, or unclassified block_type)
 *   route   — content_block: sub-kind decides (see pulseDisposition)
 *
 * Adding a RECORD_KIND: add a row here. test/pulse-map.test.mjs fails until
 * you do. Do not put the new kind on the unknown allowlist.
 */

import { RECORD_KINDS } from './normalized-record.mjs';

export const SILENT_REASONS = new Set(['envelope', 'snapshot', 'duplicate']);

/**
 * Default disposition per NR kind. `assistant_turn` + tokens:false and
 * `content_block` sub-kinds are resolved in pulseDisposition().
 * `tool_result` flips to tool_error when nr.error is set.
 */
export const KIND_PULSE = {
  turn_complete: { event: 'turn_complete' },
  input_required: { event: 'input_required' },
  user_turn:       { event: 'human_turn' },
  assistant_turn:  { event: 'silent', reason: 'envelope' },
  tool_use:        { event: 'tool_call' },
  tool_result:     { event: 'tool_result' },
  tokens:          { event: 'tokens' },
  skill_invoke:    { event: 'silent', reason: 'snapshot' },
  context_reset:   { event: 'compact' },
  session_meta:    { event: 'silent', reason: 'snapshot' },
  permission_mode: { event: 'permission' },
  branch_change:   { event: 'silent', reason: 'snapshot' },
  content_block:   { event: 'route' },
  mode_shift:      { event: 'mode_shift' },
  attachment:      { event: 'attachment' },
  scaffold:        { event: 'scaffold' },
  api_error:       { event: 'api_error' },
  unknown_record:  { event: 'unknown' },
};

/**
 * Resolve the pulse event (+ optional silent reason / synthetic flag)
 * for one NormalizedRecord.
 *
 * @param {object} nr
 * @param {object} [capabilities]
 * @returns {{ event: string, reason?: string, synthetic?: boolean }}
 */
export function pulseDisposition(nr, capabilities = {}) {
  if (!nr || typeof nr.kind !== 'string') return { event: 'unknown' };

  if (nr.kind === 'assistant_turn' && capabilities.tokens === false) {
    return { event: 'tokens', synthetic: true };
  }

  if (nr.kind === 'content_block') {
    if (nr.block_type === 'thinking') return { event: 'thinking' };
    if (nr.block_type === 'tool_use') return { event: 'silent', reason: 'duplicate' };
    if (nr.block_type === 'text' && nr.text) {
      const trimmed = nr.text.trim();
      const words = trimmed ? trimmed.split(/\s+/) : [];
      return { event: words.length >= 3 ? 'words' : 'chirp' };
    }
    return { event: 'unknown' };
  }

  if (nr.kind === 'tool_result' && nr.error) {
    return { event: 'tool_error' };
  }

  const spec = KIND_PULSE[nr.kind];
  if (!spec || spec.event === 'route') return { event: 'unknown' };
  return spec;
}

/** Fail-fast in tests: table keys must match the NR contract exactly. */
export function kindPulseKeys() {
  return Object.keys(KIND_PULSE);
}

/**
 * Stream event names a coverage sink must subscribe.
 * KIND_PULSE minus `route`, plus the events pulseDisposition actually emits
 * for content_block routing and tool_result errors.
 */
const ROUTE_EVENTS = ['words', 'chirp', 'thinking', 'tool_error'];

export function streamEvents() {
  const events = new Set(['silent', 'unknown']);
  for (const spec of Object.values(KIND_PULSE)) {
    if (spec.event && spec.event !== 'route') events.add(spec.event);
  }
  for (const e of ROUTE_EVENTS) events.add(e);
  return events;
}

/**
 * Routed children of kinds whose KIND_PULSE.event is not the Stream event.
 * Catalog of pulseDisposition branches — not a second disposition table.
 */
export const KIND_ROUTES = {
  content_block: [
    { id: 'thinking',      pulse: 'thinking', role: 'emit' },
    { id: 'words',         pulse: 'words',    role: 'emit' },
    { id: 'chirp',         pulse: 'chirp',    role: 'emit' },
    { id: 'duplicate',     pulse: 'silent',   reason: 'duplicate', role: 'emit' },
    { id: 'unknown-block', pulse: 'unknown',  role: 'alarm' },
  ],
  tool_result: [
    { id: 'ok',    pulse: 'tool_result', role: 'emit' },
    { id: 'error', pulse: 'tool_error',  role: 'emit' },
  ],
};

/** Route id for one NR, or null if the kind has no KIND_ROUTES row. */
export function routeIdFromNr(nr, capabilities = {}) {
  if (!nr || typeof nr.kind !== 'string') return null;
  if (nr.kind === 'content_block') {
    const d = pulseDisposition(nr, capabilities);
    if (d.event === 'thinking') return 'thinking';
    if (d.event === 'words') return 'words';
    if (d.event === 'chirp') return 'chirp';
    if (d.event === 'silent' && d.reason === 'duplicate') return 'duplicate';
    return 'unknown-block';
  }
  if (nr.kind === 'tool_result') return nr.error ? 'error' : 'ok';
  return null;
}

/**
 * Route id from a Stream pulse. Uses nr_kind + event + block_type already
 * on the envelope — not a reverse KIND_PULSE scan.
 */
export function routeIdFromPulse(event, data = {}) {
  if (data.nr_kind === 'content_block') {
    if (event === 'thinking' || data.block_type === 'thinking') return 'thinking';
    if (event === 'words') return 'words';
    if (event === 'chirp') return 'chirp';
    if (data.block_type === 'tool_use' || data.reason === 'duplicate') return 'duplicate';
    if (event === 'unknown') return 'unknown-block';
    return null;
  }
  if (data.nr_kind === 'tool_result') {
    if (event === 'tool_error') return 'error';
    if (event === 'tool_result') return 'ok';
  }
  return null;
}

export { RECORD_KINDS };
