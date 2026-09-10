/**
 * test/opencode-adapter.test.mjs → adapters/opencode.mjs
 *
 * Fixtures mirror real shapes probed from ~/.local/share/opencode/storage
 * (2026-06-11, opencode 1.0.201). See memory: harness-storage-formats.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recordsToNormalized } from '../hooks/adapters/opencode.mjs';
import { reduceSession } from '../hooks/session-reducer.mjs';
import { toolNameToKey } from '../hooks/action-keys.mjs';

// ── fixtures (shapes from real storage) ──────────────────────────────────────

function makeInfo(over = {}) {
  return {
    id: 'ses_4a89582bbffe03xj4Y14Qtss1q',
    version: '1.0.201',
    projectID: 'a2e62809cabc418ada21bb21c33c53f450d908f3',
    directory: 'D:\\src\\mineKaaro\\bun-ai-minecraft',
    title: 'Minecraft Bridge Session',
    time: { created: 1766698155332, updated: 1766698155332 },
    ...over,
  };
}

function makeUserMsg(over = {}) {
  return {
    id: 'msg_b5769137e0018PLt3AfBg4hv1C',
    sessionID: 'ses_4a89582bbffe03xj4Y14Qtss1q',
    role: 'user',
    time: { created: 1766698062733 },
    _parts: [{
      id: 'prt_u1', sessionID: 'ses_4a89582bbffe03xj4Y14Qtss1q',
      messageID: 'msg_b5769137e0018PLt3AfBg4hv1C',
      type: 'text', text: 'create a README describing the bot capabilities',
    }],
    ...over,
  };
}

function makeAssistantMsg(over = {}) {
  return {
    id: 'msg_b5769c31f001Wjs4cv4KuecGOU',
    sessionID: 'ses_4a89582bbffe03xj4Y14Qtss1q',
    role: 'assistant',
    time: { created: 1766698107679, completed: 1766698137064 },
    parentID: 'msg_b5769137e0018PLt3AfBg4hv1C',
    modelID: 'glm-4.7-free',
    providerID: 'opencode',
    mode: 'build', agent: 'build',
    path: { cwd: 'D:\\src\\mineKaaro\\bun-ai-minecraft', root: 'D:\\src\\mineKaaro\\bun-ai-minecraft' },
    cost: 0,
    tokens: { input: 25801, output: 166, reasoning: 0, cache: { read: 70, write: 12 } },
    finish: 'stop',
    _parts: [],
    ...over,
  };
}

function makeToolPart(over = {}, stateOver = {}) {
  return {
    id: 'prt_b57584550001nzWfv6yKaN7Jdr',
    sessionID: 'ses_4a89582bbffe03xj4Y14Qtss1q',
    messageID: 'msg_b5769c31f001Wjs4cv4KuecGOU',
    type: 'tool',
    callID: 'call_405d6a0710e6408a95f38c14',
    tool: 'glob',
    state: {
      status: 'completed',
      input: { pattern: '*.config.*' },
      output: 'No files found',
      title: 'src\\mineKaaro',
      metadata: { count: 0, truncated: false },
      time: { start: 1766696961364, end: 1766696961381 },
      ...stateOver,
    },
    ...over,
  };
}

// ── session info ──────────────────────────────────────────────────────────────

test('opencode session info → session_meta with ai_title + cwd + version', () => {
  const nrs = recordsToNormalized([makeInfo()]);
  assert.equal(nrs.length, 1);
  const m = nrs[0];
  assert.equal(m.kind, 'session_meta');
  assert.equal(m.harness, 'opencode');
  assert.equal(m.ai_title, 'Minecraft Bridge Session');
  assert.equal(m.cwd, 'D:\\src\\mineKaaro\\bun-ai-minecraft');
  assert.equal(m.version, '1.0.201');
  assert.equal(m.ts, new Date(1766698155332).toISOString());
});

// ── messages ──────────────────────────────────────────────────────────────────

test('user message → user_turn with text from embedded text part', () => {
  const nrs = recordsToNormalized([makeUserMsg()]);
  const turn = nrs.find(r => r.kind === 'user_turn');
  assert.ok(turn);
  assert.equal(turn.text, 'create a README describing the bot capabilities');
  assert.equal(turn.ts, new Date(1766698062733).toISOString());
  // user text must NOT additionally emit a content_block (no double words pulse)
  assert.equal(nrs.filter(r => r.kind === 'content_block').length, 0);
});

test('assistant message → assistant_turn + tokens (cache.write → cache_create)', () => {
  const nrs = recordsToNormalized([makeAssistantMsg()]);
  const turn = nrs.find(r => r.kind === 'assistant_turn');
  assert.ok(turn);
  assert.equal(turn.model, 'glm-4.7-free');
  assert.equal(turn.stop_reason, 'stop');

  const tok = nrs.find(r => r.kind === 'tokens');
  assert.ok(tok);
  assert.deepEqual(tok.tokens, { input: 25801, output: 166, cache_create: 12, cache_read: 70 });
});

test('assistant message without tokens → no tokens record', () => {
  const nrs = recordsToNormalized([makeAssistantMsg({ tokens: undefined })]);
  assert.equal(nrs.filter(r => r.kind === 'tokens').length, 0);
});

// ── tool parts ────────────────────────────────────────────────────────────────

test('completed tool part → tool_use with input + start ts', () => {
  const nrs = recordsToNormalized([makeToolPart()]);
  assert.equal(nrs.length, 1);
  const t = nrs[0];
  assert.equal(t.kind, 'tool_use');
  assert.equal(t.tool, 'glob');
  assert.equal(t.ts, new Date(1766696961364).toISOString());
});

test('tool part filePath → input.file_path (reducer file_ops compatible)', () => {
  const nrs = recordsToNormalized([makeToolPart(
    { tool: 'read' },
    { input: { filePath: 'D:\\src\\demo\\a.mjs' } },
  )]);
  assert.equal(nrs[0].input.file_path, 'D:\\src\\demo\\a.mjs');
});

test('bash tool part → category from command', () => {
  const nrs = recordsToNormalized([makeToolPart(
    { tool: 'bash' },
    { input: { command: 'git status' } },
  )]);
  assert.equal(nrs[0].kind, 'tool_use');
  assert.equal(nrs[0].category, 'git');
  assert.equal(nrs[0].input.command, 'git status');
});

test('error tool part → tool_use + tool_result error', () => {
  const nrs = recordsToNormalized([makeToolPart({}, { status: 'error' })]);
  assert.equal(nrs.length, 2);
  assert.equal(nrs[0].kind, 'tool_use');
  assert.equal(nrs[1].kind, 'tool_result');
  assert.equal(nrs[1].error, true);
  assert.equal(nrs[1].tool, 'glob');
});

test('pending/running tool parts → no records (single emission on completion)', () => {
  assert.equal(recordsToNormalized([makeToolPart({}, { status: 'pending' })]).length, 0);
  assert.equal(recordsToNormalized([makeToolPart({}, { status: 'running' })]).length, 0);
});

// ── other parts ───────────────────────────────────────────────────────────────

test('assistant text + reasoning parts → content_block text/thinking', () => {
  const msg = makeAssistantMsg({
    _parts: [
      { id: 'prt_t', type: 'text', text: 'Done — the README is written and committed now.' },
      { id: 'prt_r', type: 'reasoning', text: 'Let me check the files.', time: { start: 1766696906083, end: 1766696906793 } },
    ],
  });
  const nrs = recordsToNormalized([msg]);
  const text = nrs.find(r => r.kind === 'content_block' && r.block_type === 'text');
  const think = nrs.find(r => r.kind === 'content_block' && r.block_type === 'thinking');
  assert.ok(text);
  assert.equal(text.text, 'Done — the README is written and committed now.');
  assert.ok(think);
});

test('step-start / step-finish / patch parts → silenced (no double token count)', () => {
  const msg = makeAssistantMsg({
    _parts: [
      { id: 'p1', type: 'step-start' },
      { id: 'p2', type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 10913, output: 428, reasoning: 0, cache: { read: 70, write: 0 } } },
      { id: 'p3', type: 'patch', hash: 'abc', files: ['D:\\x\\README.md'] },
    ],
  });
  const nrs = recordsToNormalized([msg]);
  // exactly one tokens record — from the message envelope, not step-finish
  assert.equal(nrs.filter(r => r.kind === 'tokens').length, 1);
  assert.equal(nrs.filter(r => r.kind === 'unknown_record').length, 0);
});

test('unknown part type → unknown_record catch-all', () => {
  const nrs = recordsToNormalized([{ type: 'snapshot-v9', id: 'prt_x' }]);
  assert.equal(nrs.length, 1);
  assert.equal(nrs[0].kind, 'unknown_record');
  assert.equal(nrs[0].raw_type, 'part:snapshot-v9');
});

// ── tool key aliases ──────────────────────────────────────────────────────────

test('toolNameToKey — opencode names map to canonical keys', () => {
  assert.equal(toolNameToKey('glob'), 'grep_glob');
  assert.equal(toolNameToKey('read'), 'read');
  assert.equal(toolNameToKey('bash', 'git'), 'bash_git');
  assert.equal(toolNameToKey('webfetch'), 'web');
  assert.equal(toolNameToKey('task'), 'agent'); // opencode subagent tool
});

// ── reducer integration ───────────────────────────────────────────────────────

test('full session reduces: tokens, tools, file_ops, errors', () => {
  const records = [
    makeInfo(),
    makeUserMsg(),
    makeAssistantMsg({
      _parts: [
        makeToolPart({ tool: 'read' }, { input: { filePath: 'D:\\src\\demo\\a.mjs' } }),
        makeToolPart({ id: 'prt_2', tool: 'edit' }, { input: { filePath: 'D:\\src\\demo\\a.mjs' } }),
        makeToolPart({ id: 'prt_3', tool: 'bash' }, { input: { command: 'node --test' }, status: 'error' }),
      ],
    }),
  ];
  const session = reduceSession(recordsToNormalized(records), {
    session_id: 'ses_4a89582bbffe03xj4Y14Qtss1q',
    project_id: 'D--src-mineKaaro-bun-ai-minecraft',
    project_label: 'bun-ai-minecraft',
    harness: 'opencode',
    capabilities: { size_proxy: 'tokens_work' },
  });

  assert.equal(session.harness, 'opencode');
  assert.equal(session.version, '1.0.201');
  assert.equal(session.user_turns, 1);
  assert.equal(session.assistant_turns, 1);
  assert.equal(session.tool_calls, 3);
  assert.equal(session.tool_errors, 1);
  assert.equal(session.tokens.input, 25801);
  assert.equal(session.tokens.cache_create, 12);
  assert.equal(session.ai_title, 'Minecraft Bridge Session');
  assert.equal(session.model, 'glm-4.7-free');
  assert.equal(session.first_user_message, 'create a README describing the bot capabilities');
  assert.deepEqual(session.file_ops['d:/src/demo/a.mjs'], { read: 1, write: 0, edit: 1 }); // normPath lowercases
  assert.equal(session.bash_categories.node, 1);
});
