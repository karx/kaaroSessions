import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordsToNormalized as codex } from '../hooks/adapters/codex.mjs';
import { recordsToNormalized as claude } from '../hooks/adapters/claude-code.mjs';
import { normRecordsToPulses } from '../hooks/pulse-transformer.mjs';
import { createPulseEmitter } from '../surface/pulse-emitter.mjs';
import { createActiveState } from '../surface/active-state.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ctx = { harness: 'codex', session_id: 'test', slug: 'test', project_label: 'test' };
// Fixed epochs: the emitter gets startedAt injected, so no test depends on the wall clock.
const STARTED_AT = Date.parse('2026-01-01T00:00:00Z');
const complete = { type: 'event_msg', timestamp: '2026-01-01T00:00:05Z',
  payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'The tests pass.' } };
const signals = records => records.filter(r => ['turn_complete', 'input_required'].includes(r.kind));

test('Codex emits one completion from task_complete, not commentary or token counts', () => {
  const records = [
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Should this work? I will check.' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'The tests pass.' }] } },
    complete,
  ];
  const pulses = normRecordsToPulses(signals(codex(records)), ctx);
  assert.equal(pulses.length, 1);
  assert.equal(pulses[0].event, 'turn_complete');
  assert.equal(pulses[0].data.signal_id, 'turn-1');
});

test('Codex final message asking a question becomes Input Required', () => {
  const result = signals(codex([{ ...complete, payload: { ...complete.payload, last_agent_message: 'Which option would you prefer?' } }]));
  assert.equal(result[0]?.kind, 'input_required');
  assert.equal(result[0]?.reason, 'final_question');
});

test('Codex question tools emit Input Required with call identity', () => {
  for (const type of ['function_call', 'custom_tool_call']) {
    const result = signals(codex([{ type: 'response_item', payload: { type, name: 'functions.request_user_input', call_id: 'question-1' } }]));
    assert.equal(result[0]?.kind, 'input_required');
    assert.equal(result[0]?.signal_id, 'question-1');
  }
});

test('Claude only completes on end_turn; explicit question tools ask for input', () => {
  const result = signals(claude([
    { type: 'assistant', message: { id: 'progress', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Checking now.' }] } },
    { type: 'assistant', message: { id: 'ask', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'q1', input: {} }] } },
    { type: 'assistant', message: { id: 'done', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Finished the implementation.' }] } },
  ]));
  assert.deepEqual(result.map(r => r.kind), ['input_required', 'turn_complete']);
});

test('Repeated completion records across separate tails broadcast only once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaaro-signals-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    const emitted = [];
    const emitter = createPulseEmitter({ hub: { notify: (event, data) => emitted.push({ event, data }) },
      activeState: createActiveState(), startedAt: STARTED_AT, now: () => STARTED_AT + 10_000 });
    const old = { ...complete, timestamp: '2020-01-01T00:00:00Z', payload: { ...complete.payload, turn_id: 'old' } };
    fs.writeFileSync(file, JSON.stringify(old) + '\n' + JSON.stringify(complete) + '\n');
    emitter.tailAndPulse(file, ctx);
    fs.appendFileSync(file, JSON.stringify(complete) + '\n');
    emitter.tailAndPulse(file, ctx);
    assert.equal(emitted.filter(e => e.event === 'turn_complete').length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Aborted turns and permission-mode changes do not create completion or input alerts', () => {
  assert.equal(signals(codex([{ type: 'event_msg', payload: { type: 'turn_aborted' } }])).length, 0);
  assert.equal(signals(claude([{ type: 'permission-mode', permissionMode: 'default' }])).length, 0);
});

test('Claude subagent (sidechain) records never signal the parent session', () => {
  // Subagent JSONL under <session>/subagents/ is tailed into the PARENT session;
  // a subagent finishing is not the main turn finishing.
  const result = signals(claude([
    { type: 'assistant', isSidechain: true, message: { id: 'sub-done', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Which file should I read next?' }] } },
    { type: 'assistant', isSidechain: true, message: { id: 'sub-ask', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'q2', input: {} }] } },
  ]));
  assert.deepEqual(result, []);
});

test('Final-question fallback: asks addressed to the human become Input Required', async () => {
  const { finalTurnSignal } = await import('../hooks/helpers/turn-signals.mjs');
  const asks = [
    'Which option would you prefer?',
    'Should I commit these changes?',
    'Want me to push?',
    'Do you want the tests split too?',
    'Shall I open the PR?',
    'Ready to merge?',
    'OK to delete the old fixtures?',
    'Okay if I rename the helper?',
    'Can you run the migration locally?',
    'Done.\n\nWould you like me to also update the docs? Either way the build is green.',
    'All 40 tests pass.\n\nShould I bump the version? I can do it in a separate commit.',
    'Please confirm the target branch.',
  ];
  for (const text of asks) {
    assert.equal(finalTurnSignal(text, 'codex', 0).kind, 'input_required', text);
  }
});

test('Final-question fallback: statements and rhetorical questions stay turn_complete', async () => {
  const { finalTurnSignal } = await import('../hooks/helpers/turn-signals.mjs');
  const done = [
    'The tests pass.',
    'What changed? The parser now skips blank lines.',
    'Why did it fail? The cache was stale; it is fixed now.',
    'Which option would you prefer?\n\nI went with the first one and the build is green.',
    'Let me know if anything else comes up.',
    'Used `a?.b` to guard the lookup.',
    'See https://example.com/search?q=1 for details.',
    '',
  ];
  for (const text of done) {
    assert.equal(finalTurnSignal(text, 'codex', 0).kind, 'turn_complete', JSON.stringify(text));
  }
});
