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
const complete = { type: 'event_msg', timestamp: new Date().toISOString(),
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

test('Final requests for an answer become Input Required; ordinary questions in commentary do not', () => {
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
    const emitter = createPulseEmitter({ hub: { notify: (event, data) => emitted.push({ event, data }) }, activeState: createActiveState() });
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
