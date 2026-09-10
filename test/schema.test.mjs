import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSessionsData, validateProject, validateSession,
  OPTIONAL_PROJECT_FIELDS, OPTIONAL_SESSION_FIELDS,
} from '../hooks/sessions-schema.mjs';

// ── validateProject ───────────────────────────────────────────────────────────
test('validateProject', async t => {
  const valid = {
    id: 'proj-1', label: 'My Project', session_count: 3,
    tokens: { input: 100, output: 200, cache_create: 50, cache_read: 30 },
  };

  await t.test('accepts a valid project', () => {
    assert.deepEqual(validateProject(valid), []);
  });

  await t.test('rejects missing id', () => {
    const e = validateProject({ ...valid, id: '' });
    assert.ok(e.includes('missing id'));
  });

  await t.test('rejects missing label', () => {
    const e = validateProject({ ...valid, label: '' });
    assert.ok(e.includes('missing label'));
  });

  await t.test('rejects non-number session_count', () => {
    const e = validateProject({ ...valid, session_count: '3' });
    assert.ok(e.some(s => s.includes('session_count')));
  });

  await t.test('rejects missing tokens', () => {
    const e = validateProject({ ...valid, tokens: null });
    assert.ok(e.some(s => s.includes('tokens')));
  });

  await t.test('extra glyph fields do not fail validation', () => {
    assert.deepEqual(validateProject({
      ...valid,
      raw_ids: ['D--src-x', '--D--src-x--'],
      harnesses: ['claude-code', 'pi'],
      tokens_total: 380, tokens_work: 250, tool_calls: 12,
    }), []);
  });

  await t.test('rejects non-numeric tokens fields', () => {
    const e = validateProject({ ...valid, tokens: { ...valid.tokens, output: 'bad' } });
    assert.ok(e.some(s => s.includes('tokens.output')));
  });
});

// ── validateSession ───────────────────────────────────────────────────────────
test('validateSession', async t => {
  const valid = {
    session_id: 'abc-123', project_id: 'proj-1',
    tokens: { input: 100, output: 200, cache_create: 50, cache_read: 30 },
  };

  await t.test('accepts a valid session', () => {
    assert.deepEqual(validateSession(valid), []);
  });

  await t.test('rejects missing session_id', () => {
    const e = validateSession({ ...valid, session_id: '' });
    assert.ok(e.includes('missing session_id'));
  });

  await t.test('rejects missing project_id', () => {
    const e = validateSession({ ...valid, project_id: '' });
    assert.ok(e.includes('missing project_id'));
  });

  await t.test('rejects missing tokens', () => {
    const e = validateSession({ ...valid, tokens: null });
    assert.ok(e.some(s => s.includes('tokens')));
  });

  await t.test('rejects non-numeric token field', () => {
    const e = validateSession({ ...valid, tokens: { ...valid.tokens, output: 'bad' } });
    assert.ok(e.some(s => s.includes('tokens.output')));
  });

  await t.test('accepts session with only required fields (no optional)', () => {
    const minimal = { session_id: 'x', project_id: 'p', tokens: { input: 0, output: 0, cache_create: 0, cache_read: 0 } };
    assert.deepEqual(validateSession(minimal), []);
  });
});

test('OPTIONAL_PROJECT_FIELDS documents glyph identity and consumption', () => {
  for (const k of ['raw_ids', 'harnesses', 'tokens_total', 'tokens_work', 'tool_calls'])
    assert.ok(OPTIONAL_PROJECT_FIELDS.includes(k), k);
  assert.ok(OPTIONAL_SESSION_FIELDS.includes('tokens_total'));
  assert.ok(OPTIONAL_SESSION_FIELDS.includes('version'));
});

// ── validateSessionsData ──────────────────────────────────────────────────────
test('validateSessionsData', async t => {
  const validData = {
    meta: { generated_at: new Date().toISOString() },
    projects: [{
      id: 'p1', label: 'P1', session_count: 1,
      tokens: { input: 0, output: 0, cache_create: 0, cache_read: 0 },
    }],
    sessions: [{
      session_id: 's1', project_id: 'p1',
      tokens: { input: 0, output: 0, cache_create: 0, cache_read: 0 },
    }],
  };

  await t.test('accepts valid data', () => {
    assert.deepEqual(validateSessionsData(validData), { ok: true });
  });

  await t.test('rejects null root', () => {
    const r = validateSessionsData(null);
    assert.equal(r.ok, false);
  });

  await t.test('rejects missing projects array', () => {
    const r = validateSessionsData({ ...validData, projects: undefined });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('projects')));
  });

  await t.test('rejects missing sessions array', () => {
    const r = validateSessionsData({ ...validData, sessions: undefined });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('sessions')));
  });

  await t.test('collects errors from both projects and sessions', () => {
    const bad = {
      ...validData,
      projects: [{ ...validData.projects[0], id: '' }],
      sessions: [{ ...validData.sessions[0], session_id: '' }],
    };
    const r = validateSessionsData(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 2);
  });
});
