/**
 * test/active-state.test.mjs → lib/active-state.mjs
 *
 * Mission Control core: live per-session activity state, fed by pulse
 * objects ({ event, data }) from lib/pulse-transformer.mjs.
 * Pure module — caller supplies `now` (epoch ms); no Date.now() inside.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createActiveState,
  applyPulse,
  snapshotActive,
  DEFAULT_THRESHOLDS,
} from '../surface/active-state.mjs';

const T0 = 1_750_000_000_000; // arbitrary fixed epoch ms

function pulse(event, data = {}) {
  return {
    event,
    data: {
      session_id: 'aaaabbbb-1111-2222-3333-444455556666',
      slug: 'aaaabbbb',
      harness: 'claude-code',
      project: 'kaaroSessions',
      ts: null,
      ...data,
    },
  };
}

// ── creation ──────────────────────────────────────────────────────────────────

test('createActiveState — empty snapshot', () => {
  const state = createActiveState();
  const snap = snapshotActive(state, T0);
  assert.deepEqual(snap.sessions, []);
  assert.deepEqual(snap.by_harness, {});
  assert.equal(snap.totals.sessions, 0);
  assert.equal(snap.totals.active, 0);
});

// ── tool_call ─────────────────────────────────────────────────────────────────

test('applyPulse tool_call — creates session entry with last_tool + counts', () => {
  const state = createActiveState();
  applyPulse(state, pulse('tool_call', { tool: 'Read', key: 'read', where: 'D:/x/a.mjs', why: null }), T0);

  const snap = snapshotActive(state, T0);
  assert.equal(snap.sessions.length, 1);
  const s = snap.sessions[0];
  assert.equal(s.session_id, 'aaaabbbb-1111-2222-3333-444455556666');
  assert.equal(s.slug, 'aaaabbbb');
  assert.equal(s.harness, 'claude-code');
  assert.equal(s.project, 'kaaroSessions');
  assert.equal(s.tool_calls, 1);
  assert.equal(s.last_event, 'tool_call');
  assert.deepEqual(s.last_tool, { tool: 'Read', key: 'read', where: 'D:/x/a.mjs', why: null, ts: T0 });
  assert.equal(s.first_seen, T0);
  assert.equal(s.last_seen, T0);
});

test('applyPulse tool_call — increments across pulses, updates last_tool', () => {
  const state = createActiveState();
  applyPulse(state, pulse('tool_call', { tool: 'Read', key: 'read', where: 'a.mjs', why: null }), T0);
  applyPulse(state, pulse('tool_call', { tool: 'Bash', key: 'bash_git', where: null, why: 'git status' }), T0 + 5000);

  const s = snapshotActive(state, T0 + 5000).sessions[0];
  assert.equal(s.tool_calls, 2);
  assert.equal(s.last_tool.tool, 'Bash');
  assert.equal(s.last_tool.why, 'git status');
  assert.equal(s.first_seen, T0);
  assert.equal(s.last_seen, T0 + 5000);
});

test('applyPulse tool_error — increments tool_errors', () => {
  const state = createActiveState();
  applyPulse(state, pulse('tool_call', { tool: 'Bash', key: 'bash_run', where: null, why: 'npm test' }), T0);
  applyPulse(state, pulse('tool_error', { tool: 'Bash' }), T0 + 1000);

  const s = snapshotActive(state, T0 + 1000).sessions[0];
  assert.equal(s.tool_errors, 1);
  assert.equal(s.last_event, 'tool_error');
});

// ── tokens + burn rate ────────────────────────────────────────────────────────

test('applyPulse tokens — accumulates totals and tokens_work', () => {
  const state = createActiveState();
  applyPulse(state, pulse('tokens', { input: 100, output: 50, cache_create: 200, cache_read: 1000 }), T0);
  applyPulse(state, pulse('tokens', { input: 10, output: 5, cache_create: 20, cache_read: 100 }), T0 + 1000);

  const s = snapshotActive(state, T0 + 1000).sessions[0];
  assert.deepEqual(s.tokens, { input: 110, output: 55, cache_create: 220, cache_read: 1100 });
  assert.equal(s.tokens_work, 275); // output + cache_create
});

test('burn rate — tokens_work per minute over the burn window', () => {
  const state = createActiveState();
  // 300 work tokens spread within the last 60s window
  applyPulse(state, pulse('tokens', { input: 0, output: 100, cache_create: 0, cache_read: 0 }), T0);
  applyPulse(state, pulse('tokens', { input: 0, output: 200, cache_create: 0, cache_read: 0 }), T0 + 30_000);

  const s = snapshotActive(state, T0 + 30_000).sessions[0];
  assert.equal(s.burn_rate_per_min, 300); // full window credit

  // advance past the window: first pulse falls out
  const s2 = snapshotActive(state, T0 + 70_000).sessions[0];
  assert.equal(s2.burn_rate_per_min, 200);

  // far in the future: nothing recent
  const s3 = snapshotActive(state, T0 + 200_000).sessions[0];
  assert.equal(s3.burn_rate_per_min, 0);
});

test('synthetic tokens count toward burn rate', () => {
  const state = createActiveState();
  applyPulse(state, pulse('tokens', { synthetic: true, input: 0, output: 80, cache_create: 0, cache_read: 0 }), T0);
  const s = snapshotActive(state, T0).sessions[0];
  assert.equal(s.tokens_work, 80);
  assert.equal(s.burn_rate_per_min, 80);
});

// ── words / human turns / compacts ───────────────────────────────────────────

test('applyPulse words — counts and keeps last preview', () => {
  const state = createActiveState();
  applyPulse(state, pulse('words', { preview: 'Analyzing the pipeline now', word_count: 4 }), T0);
  applyPulse(state, pulse('words', { preview: 'Tests pass, moving on', word_count: 4 }), T0 + 1000);

  const s = snapshotActive(state, T0 + 1000).sessions[0];
  assert.equal(s.words, 2);
  assert.equal(s.last_preview, 'Tests pass, moving on');
});

test('applyPulse human_turn / compact — tracked', () => {
  const state = createActiveState();
  applyPulse(state, pulse('human_turn', { text: 'fix the bug' }), T0);
  applyPulse(state, pulse('compact', {}), T0 + 1000);

  const s = snapshotActive(state, T0 + 1000).sessions[0];
  assert.equal(s.human_turns, 1);
  assert.equal(s.last_human_ts, T0);
  assert.equal(s.compacts, 1);
});

// ── status transitions ────────────────────────────────────────────────────────

test('status — active within activeMs, idle after, evicted after evictMs', () => {
  const state = createActiveState();
  applyPulse(state, pulse('tool_call', { tool: 'Read', key: 'read', where: 'a', why: null }), T0);

  const active = snapshotActive(state, T0 + DEFAULT_THRESHOLDS.activeMs - 1);
  assert.equal(active.sessions[0].status, 'active');
  assert.equal(active.totals.active, 1);

  const idle = snapshotActive(state, T0 + DEFAULT_THRESHOLDS.activeMs + 1);
  assert.equal(idle.sessions[0].status, 'idle');
  assert.equal(idle.totals.active, 0);
  assert.equal(idle.totals.idle, 1);

  const gone = snapshotActive(state, T0 + DEFAULT_THRESHOLDS.evictMs + 1);
  assert.equal(gone.sessions.length, 0);
  assert.equal(gone.totals.sessions, 0);
});

test('status thresholds — overridable per call', () => {
  const state = createActiveState();
  applyPulse(state, pulse('tool_call', { tool: 'Read', key: 'read', where: 'a', why: null }), T0);
  const snap = snapshotActive(state, T0 + 5000, { activeMs: 1000 });
  assert.equal(snap.sessions[0].status, 'idle');
});

test('snapshot — seconds_since computed from now', () => {
  const state = createActiveState();
  applyPulse(state, pulse('words', { preview: 'hello there friend', word_count: 3 }), T0);
  const s = snapshotActive(state, T0 + 12_000).sessions[0];
  assert.equal(s.seconds_since, 12);
});

// ── multi-session / multi-harness ────────────────────────────────────────────

test('multiple sessions sorted by last_seen desc; by_harness rollup', () => {
  const state = createActiveState();
  applyPulse(state, pulse('tool_call', { tool: 'Read', key: 'read', where: 'a', why: null }), T0);
  applyPulse(state, pulse('tool_call', {
    session_id: 'ses_4a89582bbffe03xj4Y14Qtss1q', slug: 'ses_4a89',
    harness: 'opencode', project: 'bun-ai-minecraft',
    tool: 'glob', key: 'grep_glob', where: null, why: null,
  }), T0 + 10_000);
  applyPulse(state, pulse('tokens', {
    session_id: 'ses_4a89582bbffe03xj4Y14Qtss1q', slug: 'ses_4a89',
    harness: 'opencode', project: 'bun-ai-minecraft',
    input: 10, output: 30, cache_create: 0, cache_read: 0,
  }), T0 + 11_000);

  const snap = snapshotActive(state, T0 + 11_000);
  assert.equal(snap.sessions.length, 2);
  assert.equal(snap.sessions[0].harness, 'opencode');     // most recent first
  assert.equal(snap.sessions[1].harness, 'claude-code');

  assert.equal(snap.by_harness['claude-code'].sessions, 1);
  assert.equal(snap.by_harness['opencode'].sessions, 1);
  assert.equal(snap.by_harness['opencode'].tool_calls, 1);
  assert.equal(snap.by_harness['opencode'].tokens_work, 30);
  assert.equal(snap.totals.sessions, 2);
});

// ── robustness ────────────────────────────────────────────────────────────────

test('pulses without session_id are ignored', () => {
  const state = createActiveState();
  applyPulse(state, { event: 'tool_call', data: { tool: 'Read' } }, T0);
  applyPulse(state, { event: 'status', data: 'rebuilding' }, T0);
  applyPulse(state, null, T0);
  assert.equal(snapshotActive(state, T0).sessions.length, 0);
});

test('project backfills when a later pulse carries it (opencode part files)', () => {
  const state = createActiveState();
  applyPulse(state, pulse('tool_call', { project: null, tool: 'read', key: 'read', where: 'a', why: null }), T0);
  assert.equal(snapshotActive(state, T0).sessions[0].project, null);
  applyPulse(state, pulse('unknown', { project: 'bun-ai-minecraft', nr_kind: 'session_meta' }), T0 + 1000);
  assert.equal(snapshotActive(state, T0 + 1000).sessions[0].project, 'bun-ai-minecraft');
});

test('unknown pulse events still bump last_seen/last_event', () => {
  const state = createActiveState();
  applyPulse(state, pulse('thinking', { block_type: 'thinking' }), T0);
  const s = snapshotActive(state, T0).sessions[0];
  assert.equal(s.last_event, 'thinking');
  assert.equal(s.tool_calls, 0);
});

// ── E4: recent-actions ring + permission/mode/api_error tracking ─────────────

test('applyPulse — recent_actions ring keeps the last 50 actions, newest last', () => {
  const state = createActiveState();
  const base = { session_id: 's1', slug: 's1slug', harness: 'claude-code', project: 'p' };
  for (let i = 0; i < 60; i++) {
    applyPulse(state, { event: 'tool_call', data: { ...base, tool: 'Read', where: 'f' + i + '.mjs' } }, 1000 + i);
  }
  const snap = snapshotActive(state, 2000);
  const actions = snap.sessions[0].recent_actions;
  assert.equal(actions.length, 50, 'ring capped at 50');
  assert.equal(actions.at(-1).where, 'f59.mjs', 'newest last');
  assert.equal(actions[0].where, 'f10.mjs', 'oldest evicted');
  assert.equal(actions.at(-1).type, 'tool_call');
});

test('applyPulse — errors, compacts, human turns and api errors land in the ring', () => {
  const state = createActiveState();
  const base = { session_id: 's2', slug: 's2slug', harness: 'grok', project: 'p' };
  applyPulse(state, { event: 'tool_call', data: { ...base, tool: 'Shell', why: 'node --test' } }, 1);
  applyPulse(state, { event: 'tool_error', data: { ...base, tool: 'Shell' } }, 2);
  applyPulse(state, { event: 'compact', data: base }, 3);
  applyPulse(state, { event: 'human_turn', data: { ...base, text: 'try again' } }, 4);
  applyPulse(state, { event: 'api_error', data: { ...base, message: 'quota exceeded', code: 'rate_limit' } }, 5);

  const s = snapshotActive(state, 10).sessions[0];
  assert.deepEqual(s.recent_actions.map(a => a.type),
    ['tool_call', 'tool_error', 'compact', 'human_turn', 'api_error']);
  assert.equal(s.recent_actions[1].error, true);
  assert.equal(s.recent_actions[4].message, 'quota exceeded');
});

test('applyPulse — permission / mode_shift / api_error update session fields', () => {
  const state = createActiveState();
  const base = { session_id: 's3', slug: 's3slug', harness: 'claude-code', project: 'p' };
  applyPulse(state, { event: 'permission', data: { ...base, mode: 'acceptEdits' } }, 1);
  applyPulse(state, { event: 'mode_shift', data: { ...base, mode: 'plan' } }, 2);
  applyPulse(state, { event: 'api_error', data: { ...base, message: 'quota exceeded', code: 'rate_limit' } }, 3);

  const s = snapshotActive(state, 10).sessions[0];
  assert.equal(s.last_permission_mode, 'acceptEdits');
  assert.equal(s.last_mode, 'plan');
  assert.equal(s.api_errors, 1);
  assert.equal(s.last_api_error.message, 'quota exceeded');
  assert.equal(s.last_api_error.code, 'rate_limit');
});

// ── phase / lead-in / ripeness / health (RFC-session-triggers) ───────────────

const tc = (intent, extra = {}) => pulse('tool_call', { tool: 'Bash', key: 'bash_other', intent, ...extra });
const prompt = () => pulse('human_turn', { text: null, prompt: true });

test('phase — current round decides: do > verify > think; null before any work', () => {
  const st = createActiveState();
  applyPulse(st, prompt(), T0);
  assert.equal(snapshotActive(st, T0).sessions[0].phase, null);
  applyPulse(st, tc('read'), T0 + 1000);
  assert.equal(snapshotActive(st, T0 + 1000).sessions[0].phase, 'think');
  applyPulse(st, tc('verify'), T0 + 2000);
  assert.equal(snapshotActive(st, T0 + 2000).sessions[0].phase, 'verify');
  applyPulse(st, tc('mutate'), T0 + 3000);
  const s = snapshotActive(st, T0 + 5000).sessions[0];
  assert.equal(s.phase, 'do');
  assert.equal(s.time_in_phase_s, 2);
});

test('phase — an empty new round keeps the previous phase until work arrives', () => {
  const st = createActiveState();
  applyPulse(st, tc('mutate'), T0);
  applyPulse(st, prompt(), T0 + 1000);
  assert.equal(snapshotActive(st, T0 + 1000).sessions[0].phase, 'do');
  applyPulse(st, tc('read'), T0 + 2000);
  assert.equal(snapshotActive(st, T0 + 2000).sessions[0].phase, 'think');
});

test('tool_result-only human_turn rows (prompt:false) do not open a round', () => {
  const st = createActiveState();
  applyPulse(st, tc('read'), T0);
  applyPulse(st, pulse('human_turn', { prompt: false }), T0 + 100);
  applyPulse(st, tc('read'), T0 + 200);
  const s = snapshotActive(st, T0 + 300).sessions[0];
  assert.equal(s.lead_in.turns, 1);
  assert.equal(s.lead_in.tool_calls, 2);
});

test('lead-in — counts thinking rounds since the last DO; DO resets it', () => {
  const st = createActiveState();
  applyPulse(st, tc('mutate'), T0);
  for (let i = 1; i <= 3; i++) {
    applyPulse(st, prompt(), T0 + i * 10_000);
    applyPulse(st, tc('read'), T0 + i * 10_000 + 1000);
  }
  let s = snapshotActive(st, T0 + 40_000).sessions[0];
  assert.equal(s.lead_in.turns, 3);
  assert.equal(s.lead_in.tool_calls, 3);
  applyPulse(st, prompt(), T0 + 50_000);
  applyPulse(st, tc('mutate'), T0 + 51_000);
  s = snapshotActive(st, T0 + 52_000).sessions[0];
  assert.equal(s.lead_in.turns, 0);
  assert.equal(s.ripeness.state, null);
});

test('ripeness — ripe after one thinking round and a 60s human pause', () => {
  const st = createActiveState();
  applyPulse(st, prompt(), T0);
  applyPulse(st, tc('read', { where: 'RFC-session-triggers.md' }), T0 + 1000);
  applyPulse(st, pulse('words', { preview: 'here is the plan', word_count: 4 }), T0 + 2000);
  const s = snapshotActive(st, T0 + 62_000).sessions[0];
  assert.equal(s.ripeness.state, 'ripe');
  assert.equal(s.ripeness.inputs.find(i => i.id === 'pause_s').value, 60);
  assert.equal(s.ripeness.inputs.find(i => i.id === 'plan_ref').value, true);
});

test('ripeness — cache input appears only after real cache counters were seen', () => {
  const st = createActiveState();
  applyPulse(st, prompt(), T0);
  applyPulse(st, tc('read'), T0 + 1000);
  applyPulse(st, pulse('tokens', { synthetic: true, output: 10 }), T0 + 1000);
  assert.equal(snapshotActive(st, T0 + 2000).sessions[0]
    .ripeness.inputs.find(i => i.id === 'cache').verdict, 'na');
  applyPulse(st, pulse('tokens', { input: 5, output: 100, cache_create: 2_000, cache_read: 40_000 }), T0 + 2000);
  const s = snapshotActive(st, T0 + 2000 + 400_000).sessions[0];
  const c = s.ripeness.inputs.find(i => i.id === 'cache');
  assert.equal(c.value, 'cold');
  assert.equal(c.est_rewrite_tokens, 42_005);
  assert.equal(s.ripeness.state, 'overripe');
});

test('ripeness — api error after the last agent activity → stalled; health degraded', () => {
  const st = createActiveState();
  applyPulse(st, prompt(), T0);
  applyPulse(st, tc('read'), T0 + 1000);
  applyPulse(st, pulse('api_error', { message: 'limit reached', code: 'session_limit' }), T0 + 2000);
  const s = snapshotActive(st, T0 + 3000).sessions[0];
  assert.equal(s.ripeness.state, 'stalled');
  assert.equal(s.health.state, 'degraded');
});

test('ripeness/health — api error then tool call in one tail batch (same now) reads as recovered', () => {
  const st = createActiveState();
  applyPulse(st, prompt(), T0);
  applyPulse(st, pulse('api_error', { message: 'overloaded', code: 'overloaded' }), T0 + 1000);
  applyPulse(st, tc('read'), T0 + 1000);
  const s = snapshotActive(st, T0 + 2000).sessions[0];
  assert.notEqual(s.ripeness.state, 'stalled');
  assert.equal(s.health.inputs.find(i => i.id === 'api_error').verdict, 'warn');
});

test('ripeness/health — tool call then api error in one tail batch stays unrecovered', () => {
  const st = createActiveState();
  applyPulse(st, prompt(), T0);
  applyPulse(st, tc('read'), T0 + 1000);
  applyPulse(st, pulse('api_error', { message: 'overloaded', code: 'overloaded' }), T0 + 1000);
  const s = snapshotActive(st, T0 + 2000).sessions[0];
  assert.equal(s.ripeness.state, 'stalled');
  assert.equal(s.health.inputs.find(i => i.id === 'api_error').verdict, 'bad');
});

test('health — snapshot carries state + inputs from the recent-actions ring', () => {
  const st = createActiveState();
  for (let i = 0; i < 6; i++) applyPulse(st, tc('read'), T0 + i);
  const s = snapshotActive(st, T0 + 10).sessions[0];
  assert.equal(s.health.state, 'ok');
  assert.ok(s.health.inputs.some(i => i.id === 'tool_error_rate'));
});

// ── awaiting (turn_complete / input_required → ball is in the human's court) ──

test('awaiting — null by default', () => {
  const st = createActiveState();
  applyPulse(st, tc('read'), T0);
  assert.equal(snapshotActive(st, T0).sessions[0].awaiting, null);
});

test('awaiting — input_required sets it; the asking tool call + tokens in the same batch do not clear it', () => {
  const st = createActiveState();
  applyPulse(st, pulse('input_required', { reason: 'question_tool' }), T0);
  applyPulse(st, pulse('tool_call', { tool: 'AskUserQuestion', key: 'other' }), T0);
  applyPulse(st, pulse('tokens', { output: 10 }), T0);
  const s = snapshotActive(st, T0 + 30_000).sessions[0];
  assert.deepEqual(s.awaiting, { event: 'input_required', reason: 'question_tool', seconds: 30 });
});

test('awaiting — turn_complete sets it with its reason', () => {
  const st = createActiveState();
  applyPulse(st, pulse('turn_complete', { reason: 'end_turn' }), T0);
  assert.deepEqual(snapshotActive(st, T0).sessions[0].awaiting,
    { event: 'turn_complete', reason: 'end_turn', seconds: 0 });
});

test('awaiting — cleared by a human prompt, a tool result (the answer), or new agent work', () => {
  for (const clearer of [prompt(), pulse('tool_result', {}), tc('read'), pulse('words', { preview: 'ok' })]) {
    const st = createActiveState();
    applyPulse(st, pulse('input_required', { reason: 'approval' }), T0);
    applyPulse(st, clearer, T0 + 1000);
    assert.equal(snapshotActive(st, T0 + 1000).sessions[0].awaiting, null, clearer.event);
  }
});

test('awaiting — signals land in recent_actions', () => {
  const st = createActiveState();
  applyPulse(st, pulse('input_required', { reason: 'final_question' }), T0);
  const a = snapshotActive(st, T0).sessions[0].recent_actions.at(-1);
  assert.deepEqual(a, { type: 'input_required', ts: T0, reason: 'final_question' });
});

// ── origin (Phase 1.4): only the person typing opens a round ─────────────────

const userRow = (origin, extra = {}) =>
  pulse('human_turn', { text: null, origin, prompt: origin === 'human' || origin === 'command', ...extra });

test('origin — injected rows (sidechain/meta/notification/compact_summary/tool_result) never open a round', () => {
  for (const origin of ['sidechain', 'meta', 'notification', 'compact_summary', 'tool_result']) {
    const st = createActiveState();
    applyPulse(st, prompt(), T0);
    applyPulse(st, tc('read'), T0 + 1000);
    applyPulse(st, userRow(origin), T0 + 2000);   // e.g. Agent dispatch → subagent prompt row
    applyPulse(st, tc('read'), T0 + 3000);
    const s = snapshotActive(st, T0 + 3000).sessions[0];
    assert.equal(s.human_turns, 1, origin + ' is not a human turn');
    assert.equal(s.lead_in.turns, 1, origin + ' did not close the thinking round');
    assert.equal(s.time_in_phase_s, 2, origin + ' did not restart the phase clock');
  }
});

test('origin — command opens a round like a typed prompt', () => {
  const st = createActiveState();
  applyPulse(st, prompt(), T0);
  applyPulse(st, tc('read'), T0 + 1000);
  applyPulse(st, userRow('command'), T0 + 2000);
  assert.equal(snapshotActive(st, T0 + 2000).sessions[0].human_turns, 2);
});

test('origin — injected rows keep awaiting; prompt / interrupt clear it', () => {
  for (const [origin, cleared] of [['sidechain', false], ['meta', false], ['notification', false],
    ['compact_summary', false], ['human', true], ['command', true], ['interrupt', true]]) {
    const st = createActiveState();
    applyPulse(st, pulse('input_required', { reason: 'question_tool' }), T0);
    applyPulse(st, userRow(origin), T0 + 1000);
    assert.equal(snapshotActive(st, T0 + 1000).sessions[0].awaiting === null, cleared, origin);
  }
});

test('origin — interrupt is an action in the feed, not a human turn or new round', () => {
  const st = createActiveState();
  applyPulse(st, prompt(), T0);
  applyPulse(st, tc('read'), T0 + 1000);
  applyPulse(st, userRow('interrupt'), T0 + 2000);
  const s = snapshotActive(st, T0 + 2000).sessions[0];
  assert.equal(s.human_turns, 1);
  assert.equal(s.lead_in.turns, 1);
  assert.deepEqual(s.recent_actions.at(-1), { type: 'interrupt', ts: T0 + 2000 });
});
