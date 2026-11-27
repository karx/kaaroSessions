import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordsToNormalized } from '../../hooks/adapters/claude-code.mjs';
import { reduceSession } from '../../hooks/session-reducer.mjs';
import { enrichSession } from '../../hooks/enrich-session.mjs';
import { analyzeSession, parseJsonlFile, deriveLabel } from '../../analyze.mjs';

function writeTempJsonl(records, sessionId = 'golden-sess') {
  const dir = join(tmpdir(), 'kaaro-cc-' + Date.now());
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, sessionId + '.jsonl');
  writeFileSync(filePath, records.map(r => JSON.stringify(r)).join('\n'), 'utf8');
  return { dir, filePath };
}

const GOLDEN_RECORDS = [
  {
    type: 'user', timestamp: '2026-05-01T10:00:00.000Z', gitBranch: 'main',
    message: { content: '<command-name>review</command-name> fix the auth module please' },
  },
  {
    type: 'system', subtype: 'compact_boundary', timestamp: '2026-05-01T10:01:00.000Z',
  },
  {
    type: 'ai-title', timestamp: '2026-05-01T10:01:01.000Z', aiTitle: 'Auth fix session',
  },
  {
    type: 'assistant', timestamp: '2026-05-01T10:02:00.000Z',
    message: {
      model: 'claude-sonnet-4-6', stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 },
      content: [
        { type: 'tool_use', name: 'Read', input: { file_path: 'D:/src/app/auth.js' } },
        { type: 'tool_use', name: 'Agent', input: { description: 'review sub' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
      ],
    },
  },
  {
    type: 'system', subtype: 'turn_duration', timestamp: '2026-05-01T10:03:00.000Z',
    slug: 'auth-fix-slug', durationMs: 180000, messageCount: 2, gitBranch: 'main',
  },
];

test('recordsToNormalized — emits expected kinds', () => {
  const norm = recordsToNormalized(GOLDEN_RECORDS);
  const kinds = norm.map(r => r.kind);
  assert.ok(kinds.includes('user_turn'));
  assert.ok(kinds.includes('context_reset'));
  assert.ok(kinds.includes('skill_invoke'));
  assert.ok(kinds.includes('tool_use'));
  assert.ok(kinds.includes('tokens'));
  assert.ok(kinds.includes('assistant_turn'));
  assert.ok(kinds.includes('content_block'));
  // One assistant_turn (the header), not one per block. The 3 tool_use blocks + no text in this fixture still produce exactly 1 assistant_turn.
  assert.equal(kinds.filter(k => k === 'assistant_turn').length, 1);
  assert.ok(kinds.filter(k => k === 'content_block').length >= 3);
  assert.ok(kinds.filter(k => k === 'tool_use').length >= 3);
});

test('tool_use NR has category for bash tools; key is NOT set by adapter', () => {
  const records = [{
    type: 'assistant', timestamp: '2026-06-09T10:00:00.000Z',
    message: { content: [
      { type: 'tool_use', name: 'Read',     input: { file_path: 'a.mjs' } },
      { type: 'tool_use', name: 'Bash',     input: { command: 'git status' } },
      { type: 'tool_use', name: 'Bash',     input: { command: 'node --test' } },
      { type: 'tool_use', name: 'Bash',     input: { command: 'ls -la' } },
      { type: 'tool_use', name: 'Write',    input: { file_path: 'b.mjs' } },
    ]},
  }];
  const nrs = recordsToNormalized(records).filter(r => r.kind === 'tool_use');
  // Non-bash tools: no category
  assert.equal(nrs[0].category, null);  // Read
  assert.equal(nrs[4].category, null);  // Write
  // Bash tools carry structural bash category
  assert.equal(nrs[1].category, 'git');
  assert.equal(nrs[2].category, 'node');
  assert.equal(nrs[3].category, 'fs');
  // Sonic key is NOT derived by adapters (sonic domain belongs to resolveSonic/transformer)
  assert.equal(nrs[0].key, undefined);
  assert.equal(nrs[1].key, undefined);
});

test('content_block text NR carries text field', () => {
  const records = [{
    type: 'assistant', timestamp: '2026-06-09T10:00:00.000Z',
    message: { content: [
      { type: 'text', text: 'Running the tests now.' },
      { type: 'text', text: 'Ok.' },
    ]},
  }];
  const nrs = recordsToNormalized(records).filter(r => r.kind === 'content_block');
  assert.equal(nrs.length, 2);
  assert.equal(nrs[0].text, 'Running the tests now.');
  assert.equal(nrs[1].text, 'Ok.');
});

test('mode record emits mode_shift NR', () => {
  const records = [{ type: 'mode', mode: 'plan', sessionId: 'abc' }];
  const nrs = recordsToNormalized(records);
  assert.equal(nrs.length, 1);
  assert.equal(nrs[0].kind, 'mode_shift');
  assert.equal(nrs[0].mode, 'plan');
  assert.equal(nrs[0].harness, 'claude-code');
});

test('attachment record emits attachment NR with subtype', () => {
  const records = [{
    type: 'attachment', timestamp: '2026-06-09T10:00:00.000Z',
    attachment: { type: 'task_reminder', content: 'Check the tests' },
  }];
  const nrs = recordsToNormalized(records);
  assert.equal(nrs.length, 1);
  assert.equal(nrs[0].kind, 'attachment');
  assert.equal(nrs[0].subtype, 'task_reminder');
  assert.equal(nrs[0].ts, '2026-06-09T10:00:00.000Z');
});

// W-OBS-01 / Unit 6a: attachment.invoked_skills is the reliable skill source.
// Keep the attachment NR (sonic) and emit one skill_invoke per named skill.
test('attachment/invoked_skills → skill_invoke NR per skill (ts kept)', () => {
  const ts = '2026-05-05T10:03:12.000Z';
  const nrs = recordsToNormalized([{
    type: 'attachment', timestamp: ts,
    attachment: {
      type: 'invoked_skills',
      skills: [
        { name: 'visualize-seed', path: '/skills/visualize-seed/SKILL.md', content: '...' },
        { name: 'web-seo', path: '/skills/web-seo/SKILL.md', content: '...' },
        { name: '', path: '/skills/empty/SKILL.md' }, // skip empty names
      ],
    },
  }]);

  const skills = nrs.filter(r => r.kind === 'skill_invoke');
  assert.equal(skills.length, 2);
  assert.deepEqual(skills.map(r => r.skill), ['visualize-seed', 'web-seo']);
  for (const s of skills) {
    assert.equal(s.ts, ts);
    assert.equal(s.harness, 'claude-code');
  }

  // Generic attachment NR still emitted (sonic / unknown-subtype surface).
  const att = nrs.find(r => r.kind === 'attachment');
  assert.ok(att, 'attachment NR preserved');
  assert.equal(att.subtype, 'invoked_skills');
  assert.equal(att.ts, ts);
});

test('attachment/invoked_skills with no skills array emits only attachment NR', () => {
  const nrs = recordsToNormalized([{
    type: 'attachment', timestamp: 't1',
    attachment: { type: 'invoked_skills' },
  }]);
  assert.equal(nrs.filter(r => r.kind === 'skill_invoke').length, 0);
  assert.equal(nrs.filter(r => r.kind === 'attachment').length, 1);
});

test('command-name skill_invoke remains as fallback beside invoked_skills', () => {
  const nrs = recordsToNormalized([
    {
      type: 'user', timestamp: 't0',
      message: { content: '<command-name>review</command-name> please' },
    },
    {
      type: 'attachment', timestamp: 't1',
      attachment: {
        type: 'invoked_skills',
        skills: [{ name: 'visualize-seed' }],
      },
    },
  ]);
  const skills = nrs.filter(r => r.kind === 'skill_invoke').map(r => r.skill);
  assert.ok(skills.includes('review'), 'command-name fallback still emits');
  assert.ok(skills.includes('visualize-seed'), 'invoked_skills emits');
});

test('last-prompt record emits session_meta NR', () => {
  const records = [{ type: 'last-prompt', lastPrompt: 'Run tests', sessionId: 'abc' }];
  const nrs = recordsToNormalized(records);
  assert.equal(nrs.length, 1);
  assert.equal(nrs[0].kind, 'session_meta');
});

test('file-history-snapshot record emits session_meta NR', () => {
  const records = [{ type: 'file-history-snapshot', messageId: 'm1', snapshot: {} }];
  const nrs = recordsToNormalized(records);
  assert.equal(nrs.length, 1);
  assert.equal(nrs[0].kind, 'session_meta');
});

test('branch_change dedup: only emits on first occurrence and on actual change', () => {
  const records = [
    { type: 'user', timestamp: '2026-06-09T10:00:00.000Z', gitBranch: 'main',
      message: { content: [{ type: 'text', text: 'Run the tests please now' }] } },
    { type: 'user', timestamp: '2026-06-09T10:01:00.000Z', gitBranch: 'main',
      message: { content: [{ type: 'text', text: 'Run them again please' }] } },
    { type: 'user', timestamp: '2026-06-09T10:02:00.000Z', gitBranch: 'feat/new-thing',
      message: { content: [{ type: 'text', text: 'Switched to new branch now' }] } },
    { type: 'user', timestamp: '2026-06-09T10:03:00.000Z', gitBranch: 'feat/new-thing',
      message: { content: [{ type: 'text', text: 'Same branch another message' }] } },
  ];
  const nrs = recordsToNormalized(records).filter(r => r.kind === 'branch_change');
  assert.equal(nrs.length, 2, 'only first main + first feat/new-thing');
  assert.equal(nrs[0].branch, 'main');
  assert.equal(nrs[1].branch, 'feat/new-thing');
});

test('branch_change dedup works across user and turn_duration records', () => {
  const records = [
    { type: 'user', timestamp: '2026-06-09T10:00:00.000Z', gitBranch: 'main',
      message: { content: [{ type: 'text', text: 'Start the session now' }] } },
    { type: 'system', subtype: 'turn_duration', timestamp: '2026-06-09T10:01:00.000Z',
      slug: 'x', durationMs: 1000, messageCount: 1, gitBranch: 'main' },
    { type: 'system', subtype: 'turn_duration', timestamp: '2026-06-09T10:02:00.000Z',
      slug: 'x', durationMs: 2000, messageCount: 2, gitBranch: 'feat/abc' },
  ];
  const nrs = recordsToNormalized(records).filter(r => r.kind === 'branch_change');
  assert.equal(nrs.length, 2, 'main (from user) then feat/abc (from second turn_duration)');
  assert.equal(nrs[0].branch, 'main');
  assert.equal(nrs[1].branch, 'feat/abc');
});

test('unknown_record emitted for unrecognised record types', () => {
  const records = [
    { type: 'some_future_type', timestamp: '2026-06-09T10:00:00.000Z', data: {} },
    { type: 'another_unknown', timestamp: '2026-06-09T10:00:01.000Z' },
  ];
  const nrs = recordsToNormalized(records);
  const unknowns = nrs.filter(r => r.kind === 'unknown_record');
  assert.equal(unknowns.length, 2);
  assert.equal(unknowns[0].raw_type, 'some_future_type');
  assert.equal(unknowns[1].raw_type, 'another_unknown');
  assert.equal(unknowns[0].harness, 'claude-code');
});

test('adapter + reducer golden regression matches analyzeSession', () => {
  const projectId = 'D--src-myapp';
  const { dir, filePath } = writeTempJsonl(GOLDEN_RECORDS);
  try {
    const viaAnalyze = analyzeSession(projectId, filePath);
    const { records, sizeBytes } = parseJsonlFile(filePath);
    const viaPipeline = reduceSession(recordsToNormalized(records), {
      session_id:      'golden-sess',
      project_id:      projectId,
      project_label:   deriveLabel(projectId),
      harness:         'claude-code',
      file_size_bytes: sizeBytes,
      capabilities:    { size_proxy: 'tokens_work' },
    });
    enrichSession(viaPipeline);

    const fields = [
      'session_id', 'project_id', 'harness', 'user_turns', 'assistant_turns',
      'tool_calls', 'context_resets', 'ai_title', 'subagent_count', 'slug',
      'skills', 'git_branch', 'branches', 'tokens', 'tools', 'file_ops',
      'bash_categories', 'first_user_message', 'cache_hit_rate', 'duration_min',
    ];
    for (const f of fields) {
      assert.deepEqual(viaAnalyze[f], viaPipeline[f], `mismatch on ${f}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// ── Trace-fidelity fields (N5) ────────────────────────────────────────────────

test('tool_use NR carries tool_id from the content block id', () => {
  const nrs = recordsToNormalized([{
    type: 'assistant', timestamp: 't',
    message: { content: [
      { type: 'tool_use', id: 'toolu_01abc', name: 'Read', input: { file_path: 'a.mjs' } },
    ] },
  }]);
  const tu = nrs.find(r => r.kind === 'tool_use');
  assert.equal(tu.tool_id, 'toolu_01abc');
});

test('tool_result NR carries tool_id and error_text for failures', () => {
  const nrs = recordsToNormalized([{
    type: 'user', timestamp: 't',
    message: { content: [
      { type: 'tool_result', tool_use_id: 'toolu_01abc', is_error: true,
        content: [{ type: 'text', text: 'Command failed: exit code 1 -- missing file' }] },
    ] },
  }]);
  const tr = nrs.find(r => r.kind === 'tool_result');
  assert.equal(tr.error, true);
  assert.equal(tr.tool_id, 'toolu_01abc');
  assert.ok(tr.error_text.includes('exit code 1'));
});

test('tool_result NR — success results also carry tool_id (no error_text)', () => {
  const nrs = recordsToNormalized([{
    type: 'user', timestamp: 't',
    message: { content: [
      { type: 'tool_result', tool_use_id: 'toolu_02', content: [{ type: 'text', text: 'ok' }] },
    ] },
  }]);
  const tr = nrs.find(r => r.kind === 'tool_result');
  assert.ok(tr, 'success tool_result emitted for trace attachment');
  assert.equal(tr.error, false);
  assert.equal(tr.tool_id, 'toolu_02');
  assert.equal(tr.error_text, undefined);
});

test('user_turn NR carries display_text on every human turn, not just the first', () => {
  const nrs = recordsToNormalized([
    { type: 'user', timestamp: 't1', message: { content: 'first prompt with enough text' } },
    { type: 'user', timestamp: 't2', message: { content: 'second prompt also matters here' } },
    { type: 'user', timestamp: 't3',
      message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: [] }] } },
  ]);
  const turns = nrs.filter(r => r.kind === 'user_turn');
  assert.equal(turns.length, 3);
  assert.ok(turns[0].display_text.includes('first prompt'));
  assert.ok(turns[1].display_text.includes('second prompt'));
  assert.equal(turns[1].text, null, 'text keeps first-user-message-only semantics');
  assert.equal(turns[2].display_text, null, 'tool-result-only records carry no display text');
});

test('user_turn hybrid text + tool_result still carries display_text', () => {
  const nrs = recordsToNormalized([{
    type: 'user', timestamp: 't1',
    message: { content: [
      { type: 'text', text: 'also fix the flaky suite please' },
      { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'ok' }] },
    ] },
  }]);
  const ut = nrs.find(r => r.kind === 'user_turn');
  assert.ok(ut, 'user_turn emitted');
  assert.ok(ut.display_text.includes('also fix the flaky suite'), 'human text preserved on hybrid row');
  assert.ok(nrs.some(r => r.kind === 'tool_result' && r.tool_id === 'tu1'));
});

test('user_turn NR carries origin from classifyClaudeUserOrigin (Phase 1.2)', () => {
  const nrs = recordsToNormalized([
    { type: 'user', timestamp: 't1', message: { content: 'refactor the emitter please' } },
    { type: 'user', timestamp: 't2', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
    { type: 'user', timestamp: 't3', isSidechain: true, message: { content: 'You are a subagent: read the repo' } },
    { type: 'user', timestamp: 't4', message: { content: '[Request interrupted by user]' } },
    { type: 'user', timestamp: 't5', isMeta: true, message: { content: 'Base directory for this skill: C:\s' } },
  ]);
  assert.deepEqual(nrs.filter(r => r.kind === 'user_turn').map(r => r.origin),
    ['human', 'tool_result', 'sidechain', 'interrupt', 'meta']);
});

test('first user message skips injected rows: only human/command rows qualify', () => {
  const nrs = recordsToNormalized([
    { type: 'user', timestamp: 't1', message: { content: '<task-notification> <task-id>abc</task-id> done' } },
    { type: 'user', timestamp: 't2', message: { content: '[Request interrupted by user]' } },
    { type: 'user', timestamp: 't3', message: { content: 'build the kind map coverage grid' } },
  ]);
  const turns = nrs.filter(r => r.kind === 'user_turn');
  assert.equal(turns[0].text, null);
  assert.equal(turns[1].text, null);
  assert.equal(turns[2].text, 'build the kind map coverage grid');
});
