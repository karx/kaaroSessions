/**
 * test/harness-parity.test.mjs
 *
 * Internal consistency: verifies that each harness's high-level entry point
 * (analyzeSession / parsePiRecords / parseAntigravityRecords) and the
 * normalized pipeline (recordsToNormalized + reduceSession) produce identical
 * Session objects for the same input.
 *
 * Scope: consistency, not absolute correctness. For independent correctness
 * of counts like assistant_turns see analyze-session-tokens.test.mjs and
 * test/adapters/*.test.mjs.
 *
 * When adding a new harness: add a parity test here if a legacy direct parser
 * exists; otherwise add an independent correctness test in test/adapters/.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordsToNormalized as ccToNorm } from '../hooks/adapters/claude-code.mjs';
import { recordsToNormalized as piToNorm } from '../hooks/adapters/pi.mjs';
import { recordsToNormalized as agToNorm } from '../hooks/adapters/antigravity.mjs';
import { recordsToNormalized as grokToNorm } from '../hooks/adapters/grok.mjs';
import { recordsToNormalized as ocToNorm } from '../hooks/adapters/opencode.mjs';
import { EVENT_TYPES } from '../experience/audio/event-registry.mjs';
import { reduceSession } from '../hooks/session-reducer.mjs';
import { enrichSession } from '../hooks/enrich-session.mjs';
import { analyzeSession, parseJsonlFile, deriveLabel } from '../analyze.mjs';
import { parsePiRecords, derivePiLabel } from '../hooks/analyzers/analyze-pi.mjs';
import {
  parseAntigravityRecords,
  deriveAntigravityProjectId,
  deriveAntigravityLabel,
  detectWorkspace,
} from '../hooks/analyzers/analyze-antigravity.mjs';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PARITY_FIELDS = [
  'harness', 'user_turns', 'assistant_turns', 'tool_calls', 'tool_errors',
  'tokens', 'tools', 'file_ops', 'bash_categories', 'first_user_message',
  'model', 'message_count', 'slug',
];

function assertParity(legacy, pipeline, harness) {
  for (const f of PARITY_FIELDS) {
    assert.deepEqual(legacy[f], pipeline[f], `[${harness}] mismatch on ${f}`);
  }
}

function finalizeAntigravity(session, records) {
  for (const rec of records) {
    const ts = rec.created_at;
    if (!ts) continue;
    if (!session.first_timestamp || ts < session.first_timestamp) session.first_timestamp = ts;
    if (!session.last_timestamp  || ts > session.last_timestamp)  session.last_timestamp  = ts;
  }
  const cwd = detectWorkspace(records);
  session.cwd           = cwd;
  session.project_id    = deriveAntigravityProjectId(cwd);
  session.project_label = deriveAntigravityLabel(cwd);
  if (session.first_timestamp && session.last_timestamp) {
    session.duration_ms =
      new Date(session.last_timestamp).getTime() -
      new Date(session.first_timestamp).getTime();
  }
  enrichSession(session);
  return session;
}

// ── Sample Trace validation ───────────────────────────────────────────────────
// For each EVENT_TYPES entry with samples, run the adapter and assert output
// contains at least one NR matching all fields in the expect entry.

const ADAPTERS = {
  'claude-code':  ccToNorm,
  'pi':           piToNorm,
  'antigravity':  agToNorm,
  'grok':         grokToNorm,
  'opencode':     ocToNorm,
};

function partialMatch(actual, expect) {
  for (const [k, v] of Object.entries(expect)) {
    if (!assert.deepEqual) break;
    if (JSON.stringify(actual[k]) !== JSON.stringify(v)) return false;
  }
  return true;
}

for (const [eventKey, entry] of Object.entries(EVENT_TYPES)) {
  if (!entry.samples) continue;
  for (const [harness, sample] of Object.entries(entry.samples)) {
    const adapterFn = ADAPTERS[harness];
    if (!adapterFn) continue;
    test(`sample trace — ${eventKey}/${harness} v${sample.version}`, () => {
      const nrs = adapterFn([sample.record]);
      for (const expectedNR of sample.expect) {
        const match = nrs.find(nr => partialMatch(nr, expectedNR));
        assert.ok(
          match,
          `${eventKey}/${harness}: no NR matching ${JSON.stringify(expectedNR)}.\nGot: ${JSON.stringify(nrs, null, 2)}`,
        );
      }
    });
  }
}

test('pipeline internal consistency — claude-code', () => {
  const records = [
    {
      type: 'user', timestamp: '2026-05-01T10:00:00.000Z', gitBranch: 'feat/x',
      message: { content: 'Please review the auth module changes' },
    },
    {
      type: 'assistant', timestamp: '2026-05-01T10:02:00.000Z',
      message: {
        model: 'claude-sonnet-4-6', stop_reason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 25 },
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/auth.js' } }],
      },
    },
  ];
  const projectId = 'D--src-myapp';
  const dir = join(tmpdir(), 'kaaro-parity-cc-' + Date.now());
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'parity-sess.jsonl');
  writeFileSync(filePath, records.map(r => JSON.stringify(r)).join('\n'), 'utf8');
  try {
    const legacy = analyzeSession(projectId, filePath);
    const { records: parsed, sizeBytes } = parseJsonlFile(filePath);
    const pipeline = reduceSession(ccToNorm(parsed), {
      session_id: 'parity-sess', project_id: projectId,
      project_label: deriveLabel(projectId), harness: 'claude-code',
      file_size_bytes: sizeBytes, capabilities: { size_proxy: 'tokens_work' },
    });
    enrichSession(pipeline);
    assertParity(legacy, pipeline, 'claude-code');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('harness parity — pi', () => {
  const records = [
    {
      type: 'session', timestamp: '2026-04-26T14:22:51.638Z', cwd: 'D:\\src\\ebrain',
    },
    {
      type: 'message', timestamp: '2026-04-26T14:23:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'run the integration tests please' }],
      },
    },
    {
      type: 'message', timestamp: '2026-04-26T14:23:05.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'npm test' } }],
        provider: 'openai', model: 'gpt-5.4',
        usage: { input: 20, output: 10 },
        stopReason: 'stop',
      },
    },
  ];
  const sessionId = '019dca2b-f4f5-7609-96ae-fe883f7a03db';
  const projectId = '--D--src-ebrain--';
  const legacy = parsePiRecords(records, sessionId, projectId);
  enrichSession(legacy);
  const pipeline = reduceSession(piToNorm(records), {
    session_id: sessionId, project_id: projectId,
    project_label: derivePiLabel(projectId), harness: 'pi',
    capabilities: { size_proxy: 'tokens_work' },
  });
  enrichSession(pipeline);
  assertParity(legacy, pipeline, 'pi');
});

test('harness parity — antigravity', () => {
  const records = [
    {
      source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-06-07T00:15:33Z',
      content: '<USER_REQUEST>\nDeploy the staging environment\n</USER_REQUEST>',
    },
    {
      source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-06-07T00:15:34Z',
      tool_calls: [{
        name: 'run_command',
        args: {
          CommandLine: '"npm run build"',
          Cwd: '"D:\\\\src\\\\ebrain"',
        },
      }],
    },
  ];
  const sessionId = 'c7f6b422-2184-4e11-ad6d-535a069e7347';
  const legacy = parseAntigravityRecords(records, sessionId);
  enrichSession(legacy);
  const pipeline = finalizeAntigravity(
    reduceSession(agToNorm(records), {
      session_id: sessionId, project_id: null, project_label: null,
      harness: 'antigravity', capabilities: { size_proxy: 'tool_calls' },
    }),
    records,
  );
  assertParity(legacy, pipeline, 'antigravity');
});
// ── Capability-enforced field parity (N3) ─────────────────────────────────────
// The registry capability flags ARE the parity matrix: a harness session must
// populate context_resets / ai_title / subagent_count / branches iff its
// descriptor claims the capability. Fixtures below are deliberately rich —
// they exercise every populate path the harness format offers.

import { getHarness } from '../hooks/registry.mjs';
import { recordsToNormalized as cpToNorm } from '../hooks/adapters/copilot.mjs';
import { parseGrokRecords } from '../hooks/analyzers/analyze-grok.mjs';

const CAPABILITY_FIELDS = ['context_resets', 'ai_title', 'subagent_count', 'branches'];

const IS_DEFAULT = {
  context_resets: v => v === 0,
  ai_title:       v => v == null,
  subagent_count: v => v === 0,
  branches:       v => !Array.isArray(v) || v.length === 0,
};

const CAP_SESSION_BUILDERS = {
  'claude-code': () => {
    const records = [
      { type: 'system', subtype: 'compact_boundary', timestamp: 't1' },
      { type: 'ai-title', timestamp: 't2', aiTitle: 'Cap parity session' },
      { type: 'user', timestamp: 't3', gitBranch: 'main',
        message: { content: 'populate all capability fields please' } },
      { type: 'assistant', timestamp: 't4',
        message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'tool_use', name: 'Agent', input: { description: 'sub work' } }] } },
    ];
    const s = reduceSession(ccToNorm(records), {
      session_id: 'cap-cc', project_id: 'P', project_label: 'p',
      harness: 'claude-code', capabilities: { size_proxy: 'tokens_work' },
    });
    enrichSession(s);
    return s;
  },

  'pi': () => {
    const records = [
      { type: 'session', version: 3, id: 'cap-pi', timestamp: 't1', cwd: 'D:/x' },
      { type: 'message', id: 'u1', timestamp: 't2',
        message: { role: 'user', content: [{ type: 'text', text: 'rich pi fixture' }] } },
      { type: 'message', id: 'a1', timestamp: 't3',
        message: { role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc', name: 'bash', arguments: { command: 'git status' } }],
          model: 'm', usage: { input: 1, output: 1 }, stopReason: 'end' } },
    ];
    return parsePiRecords(records, 'cap-pi', '--D--x--');
  },

  'antigravity': () => {
    const records = [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE',
        created_at: 't1', content: '<USER_REQUEST>rich prompt for capability parity test</USER_REQUEST>' },
      { step_index: 1, source: 'SYSTEM', type: 'CONVERSATION_HISTORY', status: 'DONE', created_at: 't2' },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
        created_at: 't3', content: 'ok',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: '"git status"' } },
          { name: 'invoke_subagent', args: { TypeName: '"research"' } },
        ] },
    ];
    const s = parseAntigravityRecords(records, 'cap-ag');
    enrichSession(s);
    return s;
  },


  'grok': () => {
    const records = [
      { timestamp: 1, method: 'session/update',
        params: { sessionId: 'cap-grok', update: {
          sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'go' },
          _meta: { modelId: 'grok-composer-2.5-fast' } } } },
      { timestamp: 2, method: 'session/update',
        params: { sessionId: 'cap-grok', update: {
          sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Task',
          rawInput: { description: 'spawn a subagent' } } } },
      { timestamp: 3, method: '_x.ai/session/update',
        params: { sessionId: 'cap-grok', update: { sessionUpdate: 'compaction_checkpoint', checkpoint_id: 'x' } } },
    ];
    const summary = {
      info: { id: 'cap-grok', cwd: 'D:/x' },
      generated_title: 'Cap parity grok', head_branch: 'feat/cap',
    };
    return parseGrokRecords(records, 'cap-grok', 'D%3A%5Cx', summary, null);
  },

  'opencode': () => {
    const records = [
      { id: 'ses_cap', version: '1.0.201', projectID: 'p', directory: 'D:/x',
        title: 'Cap parity opencode', time: { created: 1, updated: 2 } },
      { id: 'msg_u', sessionID: 'ses_cap', role: 'user', time: { created: 1 },
        _parts: [{ id: 'prt_1', type: 'text', text: 'go' }] },
    ];
    const s = reduceSession(ocToNorm(records), {
      session_id: 'ses_cap', project_id: 'p', project_label: 'x',
      harness: 'opencode', capabilities: { size_proxy: 'tokens_work' },
    });
    enrichSession(s);
    return s;
  },

  'copilot': () => {
    const records = [
      { kind: 0, v: { version: 3, sessionId: 'cap-cp', creationDate: 1,
        customTitle: 'Cap parity copilot',
        requests: [{ requestId: 'r1', timestamp: 2, modelId: 'm',
          message: { text: 'go', parts: [] }, response: [], completionTokens: 5 }] } },
    ];
    const s = reduceSession(cpToNorm(records), {
      session_id: 'cap-cp', project_id: null, project_label: null,
      harness: 'copilot', capabilities: { size_proxy: 'tokens_work' },
    });
    enrichSession(s);
    return s;
  },
};

for (const [harness, build] of Object.entries(CAP_SESSION_BUILDERS)) {
  test(`capability parity — ${harness} fields match registry flags`, () => {
    const caps = getHarness(harness).capabilities;
    const session = build();
    for (const field of CAPABILITY_FIELDS) {
      const v = session[field];
      if (caps[field]) {
        assert.ok(!IS_DEFAULT[field](v),
          `${harness}: capabilities.${field}=true but rich fixture left it default (${JSON.stringify(v)})`);
      } else {
        assert.ok(IS_DEFAULT[field](v),
          `${harness}: capabilities.${field}=false but session populated it (${JSON.stringify(v)}) — flip the flag`);
      }
    }
  });
}
