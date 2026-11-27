/**
 * test/session-vitals.test.mjs → surface/session-vitals.mjs
 *
 * Session Ripeness + Session Health for Mission Control (/now).
 * Both are discrete, explainable states: every result lists the inputs that
 * produced it. No scores, no weights. Pure — caller supplies `now`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessRipeness, assessHealth, RIPENESS_THRESHOLDS, HEALTH_THRESHOLDS,
} from '../surface/session-vitals.mjs';

const T0 = 1_750_000_000_000;
const S = 1000;

function rip(over = {}) {
  return {
    phase: 'think',
    lead_in_turns: 1,
    last_prompt_at: T0 - 120 * S,
    last_agent_at: T0 - 60 * S,
    last_seen: T0 - 60 * S,
    plan_ref: false,
    has_cache: true,
    last_context: 80_000,
    last_api_error_at: null,
    ...over,
  };
}
const input = (r, id) => r.inputs.find(i => i.id === id);

// ── ripeness ──────────────────────────────────────────────────────────────────

test('thresholds are exported and named (tunable, not magic numbers)', () => {
  assert.equal(RIPENESS_THRESHOLDS.leadInMax, 3);
  assert.equal(RIPENESS_THRESHOLDS.pauseMinS, 30);
  assert.equal(RIPENESS_THRESHOLDS.pauseMaxS, 300);
  assert.equal(RIPENESS_THRESHOLDS.coldCacheS, 300);
  assert.ok(HEALTH_THRESHOLDS.errRateWarn < HEALTH_THRESHOLDS.errRateBad);
});

test('ripeness — not evaluated while doing or verifying', () => {
  assert.equal(assessRipeness(rip({ phase: 'do' }), T0).state, null);
  assert.equal(assessRipeness(rip({ phase: 'verify' }), T0).state, null);
});

test('ripeness — ripe: 1–3 lead-in turns and the human has paused ≥30s', () => {
  const r = assessRipeness(rip(), T0);
  assert.equal(r.state, 'ripe');
  assert.equal(input(r, 'lead_in_turns').verdict, 'ok');
  assert.equal(input(r, 'pause_s').value, 60);
  assert.equal(input(r, 'pause_s').verdict, 'ok');
  assert.equal(input(r, 'cache').verdict, 'ok');
});

test('ripeness — ripening while the agent is still working on the prompt', () => {
  const r = assessRipeness(rip({ last_prompt_at: T0 - 5 * S, last_agent_at: T0 - 20 * S }), T0);
  assert.equal(r.state, 'ripening');
  assert.equal(input(r, 'pause_s').value, null);
  assert.equal(input(r, 'pause_s').verdict, 'na');
});

test('ripeness — ripening when the reply just landed (<30s)', () => {
  const r = assessRipeness(rip({ last_agent_at: T0 - 10 * S, last_seen: T0 - 10 * S }), T0);
  assert.equal(r.state, 'ripening');
  assert.equal(input(r, 'pause_s').verdict, 'info');
});

test('ripeness — fresh: no thinking turn yet', () => {
  const r = assessRipeness(rip({ lead_in_turns: 0, phase: null }), T0);
  assert.equal(r.state, 'fresh');
});

test('ripeness — overripe: ≥4 lead-in turns', () => {
  const r = assessRipeness(rip({ lead_in_turns: 4 }), T0);
  assert.equal(r.state, 'overripe');
  assert.equal(input(r, 'lead_in_turns').verdict, 'warn');
});

test('ripeness — overripe: cache went cold; estimate is last context size', () => {
  const r = assessRipeness(rip({ last_agent_at: T0 - 600 * S, last_seen: T0 - 600 * S }), T0);
  assert.equal(r.state, 'overripe');
  const c = input(r, 'cache');
  assert.equal(c.verdict, 'warn');
  assert.equal(c.value, 'cold');
  assert.equal(c.est_rewrite_tokens, 80_000);
});

test('ripeness — cache input n/a for harnesses without cache counters', () => {
  const r = assessRipeness(rip({ has_cache: false, last_agent_at: T0 - 900 * S, last_seen: T0 - 900 * S }), T0);
  assert.equal(input(r, 'cache').verdict, 'na');
  assert.notEqual(r.state, 'overripe');
});

test('ripeness — stalled: an api error after the last agent activity', () => {
  const r = assessRipeness(rip({ last_api_error_at: T0 - 30 * S }), T0);
  assert.equal(r.state, 'stalled');
  assert.equal(input(r, 'api_error').verdict, 'bad');
  // an older error the agent has since moved past does not stall
  const r2 = assessRipeness(rip({ last_api_error_at: T0 - 90 * S }), T0);
  assert.equal(r2.state, 'ripe');
});

test('ripeness — plan_ref is shown but never changes the state (small effect)', () => {
  const a = assessRipeness(rip({ plan_ref: true }), T0);
  const b = assessRipeness(rip({ plan_ref: false }), T0);
  assert.equal(a.state, b.state);
  assert.equal(input(a, 'plan_ref').verdict, 'info');
});

test('ripeness — every input row carries id, value, verdict, note', () => {
  for (const i of assessRipeness(rip(), T0).inputs) {
    assert.ok(i.id && 'value' in i && i.verdict && typeof i.note === 'string', JSON.stringify(i));
  }
});

// ── health ────────────────────────────────────────────────────────────────────

function calls(n, failedIdx = []) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ type: 'tool_call', tool: 'Bash' });
    if (failedIdx.includes(i)) out.push({ type: 'tool_error', tool: 'Bash', error: true });
  }
  return out;
}
function hp(over = {}) {
  return {
    recent_actions: calls(10),
    compacts: 0,
    tokens: { input: 1_000, output: 5_000, cache_create: 20_000, cache_read: 180_000 },
    has_cache: true,
    last_api_error: null,
    last_tool_at: T0 - 5 * S,
    ...over,
  };
}
const hin = (h, id) => h.inputs.find(i => i.id === id);

test('health — ok on a clean session', () => {
  const h = assessHealth(hp());
  assert.equal(h.state, 'ok');
  assert.equal(hin(h, 'tool_error_rate').value, 0);
  assert.equal(hin(h, 'cache_hit').verdict, 'ok');
});

test('health — tool error rate over the recent ring: warn ≥10%, bad ≥25%', () => {
  assert.equal(hin(assessHealth(hp({ recent_actions: calls(10, [2]) })), 'tool_error_rate').verdict, 'warn');
  const h = assessHealth(hp({ recent_actions: calls(8, [0, 2, 4]) }));
  assert.equal(hin(h, 'tool_error_rate').verdict, 'bad');
  assert.equal(h.state, 'degraded');
});

test('health — error rate n/a under the minimum sample', () => {
  const h = assessHealth(hp({ recent_actions: calls(3, [0]) }));
  assert.equal(hin(h, 'tool_error_rate').verdict, 'na');
});

test('health — failing streak: last N calls each failed (parallel calls paired)', () => {
  const streak2 = [...calls(6), ...calls(2, [0, 1])];
  assert.equal(hin(assessHealth(hp({ recent_actions: streak2 })), 'error_streak').value, 2);
  assert.equal(hin(assessHealth(hp({ recent_actions: streak2 })), 'error_streak').verdict, 'warn');
  const parallel = [...calls(6),
    { type: 'tool_call' }, { type: 'tool_call' }, { type: 'tool_call' },
    { type: 'tool_error', error: true }, { type: 'tool_error', error: true }, { type: 'tool_error', error: true }];
  const p = hin(assessHealth(hp({ recent_actions: parallel })), 'error_streak');
  assert.equal(p.value, 3);
  assert.equal(p.verdict, 'bad');
});

test('health — compactions: 2+ is strained (context repeatedly lost)', () => {
  assert.equal(hin(assessHealth(hp({ compacts: 1 })), 'compacts').verdict, 'info');
  const h = assessHealth(hp({ compacts: 2 }));
  assert.equal(hin(h, 'compacts').verdict, 'warn');
  assert.equal(h.state, 'strained');
});

test('health — api error: bad while unrecovered, warn once tools resumed', () => {
  const live = assessHealth(hp({ last_api_error: { ts: T0, code: 'session_limit' }, last_tool_at: T0 - 60 * S }));
  assert.equal(hin(live, 'api_error').verdict, 'bad');
  assert.equal(live.state, 'degraded');
  const past = assessHealth(hp({ last_api_error: { ts: T0 - 60 * S }, last_tool_at: T0 }));
  assert.equal(hin(past, 'api_error').verdict, 'warn');
});

test('health — cache hit: n/a without cache counters or below min tokens', () => {
  assert.equal(hin(assessHealth(hp({ has_cache: false })), 'cache_hit').verdict, 'na');
  const small = { input: 100, output: 10, cache_create: 900, cache_read: 0 };
  assert.equal(hin(assessHealth(hp({ tokens: small })), 'cache_hit').verdict, 'na');
  const poor = { input: 50_000, output: 1_000, cache_create: 60_000, cache_read: 20_000 };
  assert.equal(hin(assessHealth(hp({ tokens: poor })), 'cache_hit').verdict, 'bad');
});

test('health — unknown when no input has data', () => {
  const h = assessHealth(hp({ recent_actions: [], has_cache: false, compacts: 0 }));
  assert.equal(h.state, 'unknown');
});
