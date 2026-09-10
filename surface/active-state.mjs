/**
 * lib/active-state.mjs — Mission Control core
 *
 * Live per-session activity store, fed by pulse objects ({ event, data })
 * from lib/pulse-transformer.mjs. Powers GET /api/active and the SSE `now`
 * event consumed by the /now Mission Control page.
 *
 * Pure module: no I/O, no Date.now() — the caller supplies `now` (epoch ms).
 * State is a plain object with a Map, mutated in place (server-side store,
 * same convention as the beat ring).
 */

export const DEFAULT_THRESHOLDS = {
  activeMs: 2 * 60_000,   // pulse within 2 min  → active
  evictMs: 60 * 60_000,   // no pulse for 60 min → dropped from snapshot
  burnWindowMs: 60_000,   // burn rate = tokens_work seen in this window, per minute
};

export function createActiveState() {
  return { sessions: new Map() };
}

function getEntry(state, data, now) {
  let e = state.sessions.get(data.session_id);
  if (!e) {
    e = {
      session_id: data.session_id,
      slug: data.slug ?? data.session_id.slice(0, 8),
      harness: data.harness ?? 'claude-code',
      project: data.project ?? null,
      first_seen: now,
      last_seen: now,
      last_event: null,
      last_tool: null,
      tool_calls: 0,
      tool_errors: 0,
      tools_by_key: Object.create(null), // Canonical Action Key → count
      tokens: { input: 0, output: 0, cache_create: 0, cache_read: 0 },
      last_tokens: null,        // latest absolute window { input, cache_read, ts } — not cumulative
      recent_work: [],          // [{ t, work }] pruned to burnWindowMs
      words: 0,
      last_preview: null,
      human_turns: 0,
      last_human_ts: null,
      compacts: 0,
      thinking_count: 0,
      last_thinking_ts: null,
      attachments: 0,
      scaffolds: 0,
      recent_actions: [],       // ring of the last RECENT_ACTIONS_MAX actions
      last_permission_mode: null,
      last_mode: null,
      api_errors: 0,
      last_api_error: null,
    };
    state.sessions.set(data.session_id, e);
  }
  return e;
}

/**
 * Feed one pulse into the store.
 * @param {object} state  — from createActiveState()
 * @param {object} pulse  — { event, data } (lifecycle pulses without data.session_id are ignored)
 * @param {number} now    — epoch ms
 */
export const RECENT_ACTIONS_MAX = 50;

// Mutate-in-place ring (same convention as the beat ring).
function pushAction(e, action) {
  e.recent_actions.push(action);
  while (e.recent_actions.length > RECENT_ACTIONS_MAX) e.recent_actions.shift();
}

export function applyPulse(state, pulse, now, thresholds = DEFAULT_THRESHOLDS) {
  if (!pulse || typeof pulse !== 'object') return;
  const { event, data } = pulse;
  if (!data || typeof data !== 'object' || !data.session_id) return;

  const e = getEntry(state, data, now);
  e.last_seen = now;
  e.last_event = event;
  if (!e.project && data.project) e.project = data.project; // backfill (opencode part pulses lack it)

  switch (event) {
    case 'tool_call': {
      e.tool_calls++;
      e.last_tool = {
        tool: data.tool ?? null,
        key: data.key ?? null,
        where: data.where ?? null,
        why: data.why ?? null,
        ts: now,
      };
      const key = data.key || 'other';
      e.tools_by_key[key] = (e.tools_by_key[key] || 0) + 1;
      pushAction(e, { type: 'tool_call', ts: now, tool: data.tool ?? null,
        key: data.key ?? null, where: data.where ?? null, why: data.why ?? null });
      break;
    }

    case 'tool_error':
      e.tool_errors++;
      pushAction(e, { type: 'tool_error', ts: now, tool: data.tool ?? null, error: true });
      break;

    case 'tokens': {
      e.tokens.input        += data.input        || 0;
      e.tokens.output       += data.output       || 0;
      e.tokens.cache_create += data.cache_create || 0;
      e.tokens.cache_read   += data.cache_read   || 0;
      // Absolute window for pressure — skip synthetic / empty windows so
      // tokenless harnesses do not show a permanent 0% meter.
      const winIn = data.input || 0;
      const winCr = data.cache_read || 0;
      if (!data.synthetic && (winIn > 0 || winCr > 0)) {
        e.last_tokens = { input: winIn, cache_read: winCr, ts: now };
      }
      const work = (data.output || 0) + (data.cache_create || 0);
      if (work > 0) e.recent_work.push({ t: now, work });
      pruneRecentWork(e, now, thresholds.burnWindowMs);
      break;
    }

    case 'words':
    case 'chirp':
      e.words++;
      if (data.preview) e.last_preview = data.preview;
      break;

    case 'human_turn':
      e.human_turns++;
      e.last_human_ts = now;
      pushAction(e, { type: 'human_turn', ts: now, text: data.text ?? null });
      break;

    case 'compact':
      e.compacts++;
      e.last_tokens = null; // window reset — hide pressure until next real tokens
      pushAction(e, { type: 'compact', ts: now });
      break;

    case 'thinking':
      // Count + live rail only — do not flood the 50-cap feed with thinking rows.
      e.thinking_count++;
      e.last_thinking_ts = now;
      break;

    case 'attachment':
      e.attachments++;
      pushAction(e, {
        type: 'attachment', ts: now,
        subtype: data.subtype ?? null,
      });
      break;

    case 'scaffold':
      e.scaffolds++;
      pushAction(e, {
        type: 'scaffold', ts: now,
        content_preview: data.content_preview
          ? String(data.content_preview).slice(0, 80)
          : null,
      });
      break;

    case 'permission':
      if (data.mode) e.last_permission_mode = data.mode;
      pushAction(e, { type: 'permission', ts: now, mode: data.mode ?? null });
      break;

    case 'mode_shift':
      if (data.mode) e.last_mode = data.mode;
      pushAction(e, { type: 'mode_shift', ts: now, mode: data.mode ?? null });
      break;

    case 'api_error':
      e.api_errors++;
      e.last_api_error = { message: data.message ?? null, code: data.code ?? null, ts: now };
      pushAction(e, { type: 'api_error', ts: now, error: true,
        message: data.message ?? null, code: data.code ?? null });
      break;

    default:
      break; // last_seen/last_event already bumped — that is the signal
  }
}

function pruneRecentWork(e, now, windowMs) {
  const cutoff = now - windowMs;
  while (e.recent_work.length && e.recent_work[0].t < cutoff) e.recent_work.shift();
}

function burnRate(e, now, windowMs) {
  const cutoff = now - windowMs;
  let work = 0;
  for (const r of e.recent_work) if (r.t >= cutoff) work += r.work;
  return Math.round(work * (60_000 / windowMs));
}

/**
 * Point-in-time view for /api/active and the SSE `now` event.
 * Evicts entries older than evictMs as a side effect.
 * @returns {{ generated_at: number, sessions: object[], by_harness: object, totals: object }}
 */
export function snapshotActive(state, now, overrides = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...overrides };
  const sessions = [];
  const by_harness = {};
  let active = 0, idle = 0;

  for (const [id, e] of state.sessions) {
    const age = now - e.last_seen;
    if (age > th.evictMs) { state.sessions.delete(id); continue; }

    const status = age <= th.activeMs ? 'active' : 'idle';
    if (status === 'active') active++; else idle++;

    const tokens_work = e.tokens.output + e.tokens.cache_create;
    sessions.push({
      session_id: e.session_id,
      slug: e.slug,
      harness: e.harness,
      project: e.project,
      status,
      first_seen: e.first_seen,
      last_seen: e.last_seen,
      seconds_since: Math.round(age / 1000),
      last_event: e.last_event,
      last_tool: e.last_tool,
      tool_calls: e.tool_calls,
      tool_errors: e.tool_errors,
      tools_by_key: { ...e.tools_by_key },
      tokens: { ...e.tokens },
      last_tokens: e.last_tokens ? { ...e.last_tokens } : null,
      tokens_work,
      burn_rate_per_min: burnRate(e, now, th.burnWindowMs),
      words: e.words,
      last_preview: e.last_preview,
      human_turns: e.human_turns,
      last_human_ts: e.last_human_ts,
      compacts: e.compacts,
      thinking_count: e.thinking_count,
      last_thinking_ts: e.last_thinking_ts,
      attachments: e.attachments,
      scaffolds: e.scaffolds,
      recent_actions: [...e.recent_actions],
      last_permission_mode: e.last_permission_mode,
      last_mode: e.last_mode,
      api_errors: e.api_errors,
      last_api_error: e.last_api_error,
    });

    const h = by_harness[e.harness] ??= { sessions: 0, active: 0, tool_calls: 0, tokens_work: 0 };
    h.sessions++;
    if (status === 'active') h.active++;
    h.tool_calls += e.tool_calls;
    h.tokens_work += tokens_work;
  }

  sessions.sort((a, b) => b.last_seen - a.last_seen);

  return {
    generated_at: now,
    sessions,
    by_harness,
    totals: { sessions: sessions.length, active, idle },
  };
}
