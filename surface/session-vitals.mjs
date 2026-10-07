/**
 * surface/session-vitals.mjs — Session Ripeness + Session Health.
 *
 * Two discrete, explainable states for Mission Control (/api/active, /now).
 * Each result is { state, inputs[] } where every input row says what was
 * measured, its value, and a verdict (ok | info | warn | bad | na). No scores,
 * no weights: the state is a short rule table over the rows, so the UI can
 * always show WHY. Signals only — nothing here gates or acts.
 *
 * Ripeness (RFC-session-triggers §5.4) — how ready a thinking phase is for a
 * trigger. Thresholds come from the local grounding pass (1 lead-in turn →
 * 71% bursts, 4+ → 22% at n=9; human pause 30s–5m → 74% doing) and are
 * TUNABLE, not proven.
 *
 * Health — is the session running cleanly? Tool error rate and failing
 * streak over the recent-actions ring, unrecovered api errors, repeated
 * compaction, cache hit rate. These thresholds have no grounding yet; they
 * are conservative defaults, also tunable.
 *
 * Pure: no I/O, no Date.now() — caller supplies `now`.
 */

export const RIPENESS_THRESHOLDS = {
  leadInMax: 3,      // 1..leadInMax thinking turns is ripe; more is overripe
  pauseMinS: 30,     // human pause since the agent's last activity
  pauseMaxS: 300,
  coldCacheS: 300,   // prompt-cache TTL (CC default 5 min)
};

export const HEALTH_THRESHOLDS = {
  errRateMinCalls: 5,
  errRateWarn: 0.10,
  errRateBad: 0.25,
  streakWarn: 2,
  streakBad: 3,
  compactsWarn: 2,
  cacheMinTokens: 50_000,
  cacheHitWarn: 0.60, // below → warn
  cacheHitBad: 0.30,  // below → bad
};

const row = (id, value, verdict, note, extra = {}) => ({ id, value, verdict, note, ...extra });

/**
 * @param {object} v — { phase, lead_in_turns, last_prompt_at, last_agent_at,
 *   last_seen, plan_ref, has_cache, last_context, last_api_error_at } (epoch ms)
 * @param {number} now
 * @returns {{ state: 'fresh'|'ripening'|'ripe'|'overripe'|'stalled'|null, inputs: object[] }}
 */
export function assessRipeness(v, now, th = RIPENESS_THRESHOLDS) {
  if (v.phase === 'do' || v.phase === 'verify') return { state: null, inputs: [] };

  const inputs = [];
  const n = v.lead_in_turns || 0;
  inputs.push(row('lead_in_turns', n,
    n === 0 ? 'na' : n <= th.leadInMax ? 'ok' : 'warn',
    `1–${th.leadInMax} thinking turns before acting; 4+ rarely bursts`));

  const agentWorking = v.last_prompt_at != null
    && (v.last_agent_at == null || v.last_prompt_at > v.last_agent_at);
  const pause = agentWorking || v.last_agent_at == null
    ? null : Math.round((now - v.last_agent_at) / 1000);
  inputs.push(row('pause_s', pause,
    pause == null ? 'na' : pause >= th.pauseMinS && pause <= th.pauseMaxS ? 'ok' : 'info',
    agentWorking ? 'agent is working on the prompt'
      : `pause ${th.pauseMinS}s–${th.pauseMaxS / 60}m since the reply`));

  inputs.push(row('plan_ref', !!v.plan_ref, 'info',
    'plan / RFC touched in this lead-in (small effect, display only)'));

  const idle = v.last_seen == null ? null : Math.round((now - v.last_seen) / 1000);
  const cold = idle != null && idle > th.coldCacheS;
  inputs.push(v.has_cache
    ? row('cache', cold ? 'cold' : 'warm', cold ? 'warn' : 'ok',
        cold ? `idle ${idle}s > ${th.coldCacheS}s — next prompt rewrites the cache`
             : `idle under ${th.coldCacheS}s`,
        { idle_s: idle, est_rewrite_tokens: cold ? (v.last_context || null) : null })
    : row('cache', null, 'na', 'harness reports no cache counters'));

  const stalled = v.last_api_error_at != null
    && (v.last_agent_at == null || v.last_api_error_at >= v.last_agent_at);
  if (v.last_api_error_at != null) {
    inputs.push(row('api_error', stalled ? 'unrecovered' : 'recovered',
      stalled ? 'bad' : 'info', stalled ? 'api error is the latest agent event' : 'agent resumed after the error'));
  }

  let state;
  if (stalled)                                  state = 'stalled';
  else if (n === 0)                             state = 'fresh';
  else if (n > th.leadInMax || (v.has_cache && cold)) state = 'overripe';
  else if (pause != null && pause >= th.pauseMinS)    state = 'ripe';
  else                                          state = 'ripening';

  return { state, inputs };
}

/** Pair tool_error entries with the latest unfailed tool_call (parallel calls). */
function callOutcomes(actions) {
  const out = [];
  for (const a of actions || []) {
    if (a.type === 'tool_call') out.push({ failed: false });
    else if (a.type === 'tool_error') {
      for (let i = out.length - 1; i >= 0; i--) {
        if (!out[i].failed) { out[i].failed = true; break; }
      }
    }
  }
  return out;
}

/**
 * @param {object} v — { recent_actions, compacts, tokens, has_cache,
 *   last_api_error: { ts }|null, last_tool_at }
 * @returns {{ state: 'ok'|'strained'|'degraded'|'unknown', inputs: object[] }}
 */
export function assessHealth(v, th = HEALTH_THRESHOLDS) {
  const inputs = [];
  const outcomes = callOutcomes(v.recent_actions);
  const failed = outcomes.filter(o => o.failed).length;

  if (outcomes.length < th.errRateMinCalls) {
    inputs.push(row('tool_error_rate', null, 'na', `fewer than ${th.errRateMinCalls} recent tool calls`));
  } else {
    const rate = failed / outcomes.length;
    inputs.push(row('tool_error_rate', Math.round(rate * 100) / 100,
      rate >= th.errRateBad ? 'bad' : rate >= th.errRateWarn ? 'warn' : 'ok',
      `failed share of the last ${outcomes.length} tool calls`));
  }

  let streak = 0;
  for (let i = outcomes.length - 1; i >= 0 && outcomes[i].failed; i--) streak++;
  inputs.push(outcomes.length
    ? row('error_streak', streak,
        streak >= th.streakBad ? 'bad' : streak >= th.streakWarn ? 'warn' : 'ok',
        'consecutive failing calls at the head of the session')
    : row('error_streak', null, 'na', 'no tool calls yet'));

  if (v.last_api_error) {
    const unrecovered = v.last_tool_at == null || v.last_api_error.ts >= v.last_tool_at;
    inputs.push(row('api_error', v.last_api_error.code || 'error',
      unrecovered ? 'bad' : 'warn',
      unrecovered ? 'no tool activity since the api error' : 'tools resumed after an api error'));
  } else {
    inputs.push(row('api_error', null, 'ok', 'no api errors', { baseline: true }));
  }

  const c = v.compacts || 0;
  inputs.push(row('compacts', c,
    c >= th.compactsWarn ? 'warn' : c > 0 ? 'info' : 'ok',
    'context compactions this session', c === 0 ? { baseline: true } : {}));

  const t = v.tokens || {};
  const denom = (t.input || 0) + (t.cache_read || 0) + (t.cache_create || 0);
  if (!v.has_cache || denom < th.cacheMinTokens) {
    inputs.push(row('cache_hit', null, 'na',
      v.has_cache ? `under ${th.cacheMinTokens / 1000}k input tokens` : 'harness reports no cache counters'));
  } else {
    const hit = (t.cache_read || 0) / denom;
    inputs.push(row('cache_hit', Math.round(hit * 100) / 100,
      hit < th.cacheHitBad ? 'bad' : hit < th.cacheHitWarn ? 'warn' : 'ok',
      'cache_read share of input-side tokens'));
  }

  const informative = inputs.filter(i => i.verdict !== 'na' && !i.baseline);
  let state = 'ok';
  if (!informative.length) state = 'unknown';
  else if (inputs.some(i => i.verdict === 'bad'))  state = 'degraded';
  else if (inputs.some(i => i.verdict === 'warn')) state = 'strained';

  return { state, inputs };
}
