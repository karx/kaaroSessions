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

test('applyPulse tool_call — tools_by_key histogram for mapping-style chips', () => {
  const state = createActiveState();
  applyPulse(state, pulse('tool_call', { tool: 'Read', key: 'read' }), T0);
  applyPulse(state, pulse('tool_call', { tool: 'Read', key: 'read' }), T0 + 1);
  applyPulse(state, pulse('tool_call', { tool: 'Edit', key: 'edit' }), T0 + 2);
  applyPulse(state, pulse('tool_call', { tool: 'Weird', key: null }), T0 + 3);

  const s = snapshotActive(state, T0 + 3).sessions[0];
  assert.deepEqual(s.tools_by_key, { read: 2, edit: 1, other: 1 });
  assert.equal(snapshotActive(createActiveState(), T0).sessions.length, 0);
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

test('applyPulse tokens — last_tokens is latest absolute window, not cumulative', () => {
  const state = createActiveState();
  assert.equal(snapshotActive(state, T0).sessions.length, 0);

  applyPulse(state, pulse('tokens', { input: 100, output: 50, cache_create: 200, cache_read: 1000 }), T0);
  let s = snapshotActive(state, T0).sessions[0];
  assert.deepEqual(s.last_tokens, { input: 100, cache_read: 1000, ts: T0 });
  assert.deepEqual(s.tokens, { input: 100, output: 50, cache_create: 200, cache_read: 1000 });

  // Second pulse: cumulative sums keep growing; last_tokens overwrites.
  applyPulse(state, pulse('tokens', { input: 10, output: 5, cache_create: 20, cache_read: 100 }), T0 + 1000);
  s = snapshotActive(state, T0 + 1000).sessions[0];
  assert.deepEqual(s.tokens, { input: 110, output: 55, cache_create: 220, cache_read: 1100 });
  assert.deepEqual(s.last_tokens, { input: 10, cache_read: 100, ts: T0 + 1000 });
});

test('applyPulse tokens — output-only pulse does not invent a zero window for pressure', () => {
  const state = createActiveState();
  applyPulse(state, pulse('tokens', { output: 40 }), T0);
  const s = snapshotActive(state, T0).sessions[0];
  assert.equal(s.last_tokens, null, 'no absolute window → leave last_tokens unset');
  assert.equal(s.tokens_work, 40);
});

test('applyPulse tokens — synthetic / zero-window does not stamp last_tokens', () => {
  const state = createActiveState();
  applyPulse(state, pulse('tokens', {
    synthetic: true, input: 0, output: 80, cache_create: 0, cache_read: 0,
  }), T0);
  let s = snapshotActive(state, T0).sessions[0];
  assert.equal(s.last_tokens, null);
  assert.equal(s.tokens_work, 80);

  // Real window later still wins.
  applyPulse(state, pulse('tokens', { input: 50_000, output: 10, cache_read: 10_000 }), T0 + 1);
  s = snapshotActive(state, T0 + 1).sessions[0];
  assert.deepEqual(s.last_tokens, { input: 50_000, cache_read: 10_000, ts: T0 + 1 });

  // Later synthetic must not wipe a real window.
  applyPulse(state, pulse('tokens', {
    synthetic: true, input: 0, output: 20, cache_create: 0, cache_read: 0,
  }), T0 + 2);
  s = snapshotActive(state, T0 + 2).sessions[0];
  assert.deepEqual(s.last_tokens, { input: 50_000, cache_read: 10_000, ts: T0 + 1 });
});

test('snapshot — last_tokens null until first tokens pulse', () => {
  const state = createActiveState();
  applyPulse(state, pulse('tool_call', { tool: 'Read', key: 'read', where: 'a', why: null }), T0);
  assert.equal(snapshotActive(state, T0).sessions[0].last_tokens, null);
});

test('applyPulse thinking — count + live ts, but do not spam the actions ring', () => {
  const state = createActiveState();
  applyPulse(state, pulse('thinking'), T0);
  applyPulse(state, pulse('thinking'), T0 + 1);
  applyPulse(state, pulse('tool_call', { tool: 'Read', key: 'read' }), T0 + 2);
  applyPulse(state, pulse('thinking'), T0 + 3);

  const s = snapshotActive(state, T0 + 3).sessions[0];
  assert.equal(s.thinking_count, 3);
  assert.equal(s.last_thinking_ts, T0 + 3);
  assert.equal(s.recent_actions.filter(a => a.type === 'thinking').length, 0);
  assert.equal(s.recent_actions.length, 1);
  assert.equal(s.recent_actions[0].type, 'tool_call');
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

test('applyPulse compact — clears last_tokens so pressure is not pre-compact', () => {
  const state = createActiveState();
  applyPulse(state, pulse('tokens', { input: 80_000, output: 10, cache_read: 20_000 }), T0);
  assert.ok(snapshotActive(state, T0).sessions[0].last_tokens);
  applyPulse(state, pulse('compact', {}), T0 + 1);
  const s = snapshotActive(state, T0 + 1).sessions[0];
  assert.equal(s.compacts, 1);
  assert.equal(s.last_tokens, null);
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

test('unknown pulse events still bump last_seen/last_event only', () => {
  const state = createActiveState();
  applyPulse(state, pulse('mystery_pulse', { nr_kind: 'unknown_record' }), T0);
  const s = snapshotActive(state, T0).sessions[0];
  assert.equal(s.last_event, 'mystery_pulse');
  assert.equal(s.tool_calls, 0);
  assert.equal(s.thinking_count, 0);
  assert.equal(s.attachments, 0);
  assert.equal(s.scaffolds, 0);
});

// ── thinking / attachment / scaffold (typed MC signals) ──────────────────────

test('applyPulse thinking — count + last_thinking_ts without ring rows', () => {
  const state = createActiveState();
  applyPulse(state, pulse('thinking', { block_type: 'thinking' }), T0);
  applyPulse(state, pulse('thinking', { block_type: 'thinking' }), T0 + 500);

  const s = snapshotActive(state, T0 + 500).sessions[0];
  assert.equal(s.thinking_count, 2);
  assert.equal(s.last_thinking_ts, T0 + 500);
  assert.equal(s.last_event, 'thinking');
  assert.equal(s.recent_actions.length, 0);
});

test('applyPulse attachment — count + ring with subtype', () => {
  const state = createActiveState();
  applyPulse(state, pulse('attachment', { subtype: 'invoked_skills' }), T0);
  const s = snapshotActive(state, T0).sessions[0];
  assert.equal(s.attachments, 1);
  assert.deepEqual(s.recent_actions[0], { type: 'attachment', ts: T0, subtype: 'invoked_skills' });
});

test('applyPulse scaffold — count + truncated content_preview on ring', () => {
  const state = createActiveState();
  const long = 'x'.repeat(120);
  applyPulse(state, pulse('scaffold', { content_preview: long }), T0);
  const s = snapshotActive(state, T0).sessions[0];
  assert.equal(s.scaffolds, 1);
  assert.equal(s.recent_actions[0].type, 'scaffold');
  assert.equal(s.recent_actions[0].content_preview.length, 80);
});

test('attachment/scaffold share the 50-cap recent_actions ring (thinking excluded)', () => {
  const state = createActiveState();
  const base = { session_id: 's1', slug: 's1slug', harness: 'claude-code', project: 'p' };
  for (let i = 0; i < 30; i++) {
    applyPulse(state, { event: 'thinking', data: { ...base } }, 1000 + i);
    applyPulse(state, { event: 'attachment', data: { ...base, subtype: 'file' } }, 2000 + i);
    applyPulse(state, { event: 'scaffold', data: { ...base, content_preview: 'nudge' } }, 3000 + i);
  }
  const s = snapshotActive(state, 4000).sessions[0];
  assert.equal(s.thinking_count, 30);
  assert.equal(s.recent_actions.length, 50);
  assert.ok(s.recent_actions.every(a => a.type === 'attachment' || a.type === 'scaffold'));
  assert.equal(s.recent_actions.filter(a => a.type === 'thinking').length, 0);
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
