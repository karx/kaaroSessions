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
 *
 * Phase / lead-in (RFC-session-triggers): a *round* is one human prompt plus
 * the agent work that follows it (human_turn with prompt !== false opens a new
 * round). A round's phase is do > verify > think from tool_call.data.intent.
 * Ripeness + Health are computed per snapshot in surface/session-vitals.mjs.
 */

import { assessRipeness, assessHealth } from './session-vitals.mjs';

const AGENT_EVENTS = new Set(['tool_call', 'tool_error', 'tool_result', 'tokens', 'words', 'chirp', 'thinking']);
// Pulses that end an awaiting state: the human answered/prompted, or the agent
// resumed. tokens are excluded (usage rides the same batch as the signal), and
// so is the asking tool's own tool_call (AskUserQuestion → input_required → tool_call).
const RESUME_EVENTS = new Set(['human_turn', 'tool_result', 'tool_error', 'words', 'chirp', 'thinking', 'compact', 'tool_call']);
const ASKING_TOOL = /^(AskUserQuestion|ExitPlanMode)$|(^|[._])request_user_input(_async)?$/;
const PLAN_REF = /(^|\/)(RFC-[^/]*|[^/]*PLAN[^/]*|EXECUTION\.md)$|\/plans?\//i;

function newRound() { return { tools: 0, do: 0, verify: 0, activity: 0 }; }

function roundPhase(r) {
  if (r.do > 0) return 'do';
  if (r.verify > 0) return 'verify';
  if (r.activity > 0) return 'think';
  return null;
}

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
      tokens: { input: 0, output: 0, cache_create: 0, cache_read: 0 },
      recent_work: [],          // [{ t, work }] pruned to burnWindowMs
      words: 0,
      last_preview: null,
      human_turns: 0,
      last_human_ts: null,
      compacts: 0,
      recent_actions: [],       // ring of the last RECENT_ACTIONS_MAX actions
      last_permission_mode: null,
      last_mode: null,
      api_errors: 0,
      last_api_error: null,
      // phase / lead-in / vitals inputs
      round: newRound(),
      phase: null,
      phase_since: null,
      lead_in_closed: 0,        // closed thinking rounds since the last do/verify round
      lead_in_tool_calls: 0,
      lead_in_plan_ref: false,
      last_prompt_at: null,
      last_agent_at: null,
      last_tool_at: null,
      has_cache: false,
      last_context: null,
      awaiting: null,           // { event, reason, since } — ball is in the human's court
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
  if (AGENT_EVENTS.has(event)) { e.last_agent_at = now; e.round.activity++; }

  if (e.awaiting && RESUME_EVENTS.has(event)
      && !(event === 'tool_call' && ASKING_TOOL.test(String(data.tool ?? '')))) {
    e.awaiting = null;
  }

  switch (event) {
    case 'turn_complete':
    case 'input_required':
      e.awaiting = { event, reason: data.reason ?? null, since: now };
      pushAction(e, { type: event, ts: now, reason: data.reason ?? null });
      break;

    case 'tool_call':
      e.tool_calls++;
      e.last_tool = {
        tool: data.tool ?? null,
        key: data.key ?? null,
        where: data.where ?? null,
        why: data.why ?? null,
        ts: now,
      };
      pushAction(e, { type: 'tool_call', ts: now, tool: data.tool ?? null,
        key: data.key ?? null, where: data.where ?? null, why: data.why ?? null });
      e.last_tool_at = now;
      e.round.tools++;
      if (data.intent === 'mutate') e.round.do++;
      else if (data.intent === 'verify') e.round.verify++;
      else {
        e.lead_in_tool_calls++;
        if (data.where && PLAN_REF.test(String(data.where).replace(/\\/g, '/'))) e.lead_in_plan_ref = true;
      }
      if (e.round.do || e.round.verify) { e.lead_in_tool_calls = 0; e.lead_in_plan_ref = false; }
      break;

    case 'tool_error':
      e.tool_errors++;
      pushAction(e, { type: 'tool_error', ts: now, tool: data.tool ?? null, error: true });
      break;

    case 'tokens': {
      e.tokens.input        += data.input        || 0;
      e.tokens.output       += data.output       || 0;
      e.tokens.cache_create += data.cache_create || 0;
      e.tokens.cache_read   += data.cache_read   || 0;
      if (!data.synthetic) {
        if ((data.cache_read || 0) > 0 || (data.cache_create || 0) > 0) e.has_cache = true;
        const ctx = (data.input || 0) + (data.cache_read || 0) + (data.cache_create || 0);
        if (ctx > 0) e.last_context = ctx;
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
      if (data.prompt !== false) {
        closeRound(e);
        e.last_prompt_at = now;
      }
      e.human_turns++;
      e.last_human_ts = now;
      pushAction(e, { type: 'human_turn', ts: now, text: data.text ?? null });
      break;

    case 'compact':
      e.compacts++;
      pushAction(e, { type: 'compact', ts: now });
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

  const p = roundPhase(e.round);
  if (p && p !== e.phase) { e.phase = p; e.phase_since = now; }
}

function closeRound(e) {
  const p = roundPhase(e.round);
  if (p === 'think') e.lead_in_closed++;
  else if (p === 'do' || p === 'verify') e.lead_in_closed = 0;
  e.round = newRound();
}

function leadInTurns(e) {
  const p = roundPhase(e.round);
  if (p === 'do' || p === 'verify') return 0;
  return e.lead_in_closed + (p === 'think' ? 1 : 0);
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
      tokens: { ...e.tokens },
      tokens_work,
      burn_rate_per_min: burnRate(e, now, th.burnWindowMs),
      words: e.words,
      last_preview: e.last_preview,
      human_turns: e.human_turns,
      last_human_ts: e.last_human_ts,
      compacts: e.compacts,
      recent_actions: [...e.recent_actions],
      last_permission_mode: e.last_permission_mode,
      last_mode: e.last_mode,
      api_errors: e.api_errors,
      last_api_error: e.last_api_error,
      phase: e.phase,
      time_in_phase_s: e.phase_since == null ? null : Math.round((now - e.phase_since) / 1000),
      lead_in: { turns: leadInTurns(e), tool_calls: e.lead_in_tool_calls },
      awaiting: e.awaiting && { event: e.awaiting.event, reason: e.awaiting.reason,
        seconds: Math.round((now - e.awaiting.since) / 1000) },
      ripeness: assessRipeness({
        phase: e.phase,
        lead_in_turns: leadInTurns(e),
        last_prompt_at: e.last_prompt_at,
        last_agent_at: e.last_agent_at,
        last_seen: e.last_seen,
        plan_ref: e.lead_in_plan_ref,
        has_cache: e.has_cache,
        last_context: e.last_context,
        last_api_error_at: e.last_api_error?.ts ?? null,
      }, now),
      health: assessHealth({
        recent_actions: e.recent_actions,
        compacts: e.compacts,
        tokens: e.tokens,
        has_cache: e.has_cache,
        last_api_error: e.last_api_error,
        last_tool_at: e.last_tool_at,
      }),
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
