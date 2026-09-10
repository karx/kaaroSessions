/**
 * test/pulse-emitter.test.mjs → surface/pulse-emitter.mjs
 *
 * The Stream production path: watched-file change → tail/parse → adapter →
 * pulses → hub broadcast + active-state, with offset tracking and the
 * throttled `now` snapshot broadcast.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createPulseEmitter } from '../surface/pulse-emitter.mjs';
import { createActiveState, snapshotActive } from '../surface/active-state.mjs';

function fakeHub() {
  const events = [];
  return { events, notify: (event, data) => events.push({ event, data: data ? JSON.parse(data) : null }) };
}

function withTempDir(fn) {
  const dir = join(tmpdir(), 'kaaro-pulse-emit-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const CC_CTX = {
  harness: 'claude-code', session_id: 'aaaabbbb-1111-2222-3333-444455556666',
  slug: 'aaaabbbb', project_id: 'P', project_label: 'proj',
};

const CC_LINE = JSON.stringify({
  type: 'assistant', timestamp: '2026-06-12T10:00:00.000Z',
  message: { model: 'm', usage: { input_tokens: 5, output_tokens: 3 },
    content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.mjs' } }] },
});

test('tailAndPulse — emits pulses for new JSONL bytes and advances the offset', () => {
  withTempDir((dir) => {
    const fp = join(dir, 's.jsonl');
    writeFileSync(fp, CC_LINE + '\n', 'utf8');
    const hub = fakeHub();
    const activeState = createActiveState();
    const emitter = createPulseEmitter({ hub, activeState });

    emitter.tailAndPulse(fp, CC_CTX);
    const toolCalls = hub.events.filter(e => e.event === 'tool_call');
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].data.slug, 'aaaabbbb');
    assert.equal(toolCalls[0].data.key, 'read');

    // No new bytes → no new pulses.
    const before = hub.events.length;
    emitter.tailAndPulse(fp, CC_CTX);
    assert.equal(hub.events.length, before);

    // Appended bytes → only the new record pulses.
    appendFileSync(fp, CC_LINE + '\n', 'utf8');
    emitter.tailAndPulse(fp, CC_CTX);
    assert.equal(hub.events.filter(e => e.event === 'tool_call').length, 2);
  });
});

test('tailAndPulse — same pulses overlay the kind-map store', () => {
  withTempDir((dir) => {
    const fp = join(dir, 's.jsonl');
    writeFileSync(fp, CC_LINE + '\n', 'utf8');
    const seen = [];
    const kindMap = { applyPulse: (p) => seen.push(p) };
    const emitter = createPulseEmitter({ hub: fakeHub(), activeState: createActiveState(), kindMap });
    emitter.tailAndPulse(fp, CC_CTX);
    assert.ok(seen.some(p => p.event === 'tool_call'));
    assert.equal(seen.filter(p => p.event === 'tool_call')[0].data.harness, 'claude-code');
  });
});

test('tailAndPulse — feeds active-state so /api/active sees the session', () => {
  withTempDir((dir) => {
    const fp = join(dir, 's.jsonl');
    writeFileSync(fp, CC_LINE + '\n', 'utf8');
    const activeState = createActiveState();
    const emitter = createPulseEmitter({ hub: fakeHub(), activeState });
    emitter.tailAndPulse(fp, CC_CTX);
    const snap = snapshotActive(activeState, Date.now());
    assert.equal(snap.sessions.length, 1);
    assert.equal(snap.sessions[0].slug, 'aaaabbbb');
  });
});

test('tailAndPulse — schedules at most one trailing `now` broadcast per window', async () => {
  await new Promise((resolve, reject) => {
    withTempDir((dir) => {
      const fp = join(dir, 's.jsonl');
      writeFileSync(fp, CC_LINE + '\n' + CC_LINE + '\n', 'utf8');
      const hub = fakeHub();
      const emitter = createPulseEmitter({ hub, activeState: createActiveState(), nowThrottleMs: 10 });
      emitter.tailAndPulse(fp, CC_CTX);
      appendFileSync(fp, CC_LINE + '\n', 'utf8');
      emitter.tailAndPulse(fp, CC_CTX); // second burst inside the window
      setTimeout(() => {
        try {
          const nows = hub.events.filter(e => e.event === 'now');
          assert.equal(nows.length, 1, 'bursty tails collapse into one now snapshot');
          assert.ok(nows.at(-1).data.sessions.length >= 1);
          resolve();
        } catch (e) { reject(e); }
      }, 40);
    });
  });
});

test('json read_mode — whole-file parse, dedupe by size+mtime signature', () => {
  withTempDir((dir) => {
    const fp = join(dir, 'msg_x.json');
    const doc = {
      id: 'msg_x', sessionID: 'ses_abcdef1234', role: 'assistant',
      time: { created: 1766698107679 }, modelID: 'm', providerID: 'opencode',
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 1, write: 2 } },
      finish: 'stop', _parts: [],
    };
    writeFileSync(fp, JSON.stringify(doc, null, 2), 'utf8');
    const hub = fakeHub();
    const emitter = createPulseEmitter({ hub, activeState: createActiveState() });
    const ctx = { harness: 'opencode', session_id: null, slug: null,
      project_id: null, project_label: null, read_mode: 'json' };

    emitter.tailAndPulse(fp, ctx);
    const first = hub.events.length;
    assert.ok(first > 0, 'whole-file json produced pulses');
    assert.ok(hub.events.every(e => e.event === 'now' || e.data.slug === 'abcdef12'),
      'slug derived from in-body sessionID');

    emitter.tailAndPulse(fp, ctx); // unchanged file → signature dedupe
    assert.equal(hub.events.length, first);
  });
});

// opencode splits a session across session/message/part JSON trees; only the
// session info doc carries `directory`. A live tool_call pulse comes from a
// bare part file (storage/part/<msgId>/prt_*.json), which carries neither
// `directory` nor `path.cwd` — see hooks/TRACE-opencode-sessions.md. Without
// resolving the session's directory from its info doc, every opencode
// tool_call pulse ships with project: null, breaking project-hex highlight
// and per-project pitch/pan in 14-pulse-audio.js (playPulse still fires, but
// unattributed — not first-class).
test('json read_mode — opencode tool part with no in-body directory resolves project via the registry (live data shape)', () => {
  withTempDir((root) => {
    mkdirSync(join(root, 'session', 'bucketA'), { recursive: true });
    mkdirSync(join(root, 'part', 'msg_readcall'), { recursive: true });
    writeFileSync(
      join(root, 'session', 'bucketA', 'ses_projparity.json'),
      JSON.stringify({ id: 'ses_projparity', directory: 'D:\\src\\myproj', time: { created: 1, updated: 2 } }),
      'utf8',
    );
    const partPath = join(root, 'part', 'msg_readcall', 'prt_readcall.json');
    writeFileSync(partPath, JSON.stringify({
      id: 'prt_readcall', sessionID: 'ses_projparity', messageID: 'msg_readcall',
      type: 'tool', tool: 'read',
      state: { status: 'completed', input: { filePath: 'a.mjs' }, time: { start: 1, end: 2 } },
    }), 'utf8');

    const hub = fakeHub();
    const emitter = createPulseEmitter({ hub, activeState: createActiveState() });
    // ctxFromPath's shape for a part/<msgId>/… change: session identity is unknown
    // from the path alone (it lives inside the JSON body).
    const ctx = { harness: 'opencode', session_id: null, slug: null,
      project_id: null, project_label: null, read_mode: 'json' };

    emitter.tailAndPulse(partPath, ctx);
    const toolCalls = hub.events.filter(e => e.event === 'tool_call');
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].data.project, 'myproj',
      'tool_call pulse must carry the project label so the graph/audio can attribute it');
  });
});

// The sqlite live-tail path (opencode >= 1.18.x) is a High-Water Mark (HWM)
// cursor over (time_updated, rowid) on the `part`/`message` tables — see
// RFC-opencode-cdc-tracking.md. On its FIRST touch for a given db, the reader
// bootstraps its cursor to the tables' current max (time_updated, rowid), so
// whatever was already on disk at that moment is treated as historical (the
// offline scan already captured it) and does not double-fire as a live pulse.
// Only rows written AFTER that bootstrap point cross the HWM and pulse.
function opencodeDbSchema(db) {
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, directory TEXT, project_id TEXT, time_updated INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
  `);
}

function insertPart(db, { id, messageId, sessionId, t, status = 'completed', tool = 'read', input = { filePath: 'main.js' } }) {
  db.prepare(
    'INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, messageId, sessionId, t, t, JSON.stringify({
    type: 'tool', tool, state: { status, input, time: { start: t, end: t } },
  }));
}

test('sqlite read_mode — opencode.db part insertion emits tool_call pulse with project label', () => {
  const DatabaseSync = process.getBuiltinModule?.('node:sqlite')?.DatabaseSync;
  if (!DatabaseSync) return;

  withTempDir((root) => {
    const dbPath = join(root, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    opencodeDbSchema(db);
    db.exec(`
      INSERT INTO session (id, directory, project_id, time_updated)
      VALUES ('ses_sqlpulse', 'D:\\\\src\\\\sqlpulseproj', 'proj_sql', 100);
    `);
    db.close();

    const hub = fakeHub();
    const emitter = createPulseEmitter({ hub, activeState: createActiveState() });
    const ctx = {
      harness: 'opencode', session_id: 'ses_sqlpulse', slug: 'sqlpulse',
      project_id: null, project_label: null, read_mode: 'sqlite',
    };

    // First tick bootstraps the HWM cursor (nothing new yet).
    emitter.tailAndPulse(dbPath, ctx);
    assert.equal(hub.events.filter(e => e.event === 'tool_call').length, 0);

    // A real tool call lands after the reader is watching.
    const db2 = new DatabaseSync(dbPath);
    insertPart(db2, { id: 'prt_sql1', messageId: 'msg_1', sessionId: 'ses_sqlpulse', t: 101 });
    db2.close();

    emitter.tailAndPulse(dbPath, ctx);
    const toolCalls = hub.events.filter(e => e.event === 'tool_call');
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].data.tool, 'read');
    assert.equal(toolCalls[0].data.project, 'sqlpulseproj');
    emitter.closeSqliteReaders(); // release the file handle before temp-dir cleanup (Windows)
  });
});

test('sqlite read_mode — rows already on disk at bootstrap are historical, not re-emitted as live pulses', () => {
  const DatabaseSync = process.getBuiltinModule?.('node:sqlite')?.DatabaseSync;
  if (!DatabaseSync) return;

  withTempDir((root) => {
    const dbPath = join(root, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    opencodeDbSchema(db);
    db.exec("INSERT INTO session (id, directory, project_id, time_updated) VALUES ('ses_old', 'D:\\\\x', 'p', 50);");
    // This row predates the watcher ever touching the db (e.g. server restart
    // mid-history) — the offline scan already accounted for it.
    insertPart(db, { id: 'prt_old', messageId: 'msg_old', sessionId: 'ses_old', t: 60 });
    db.close();

    const hub = fakeHub();
    const emitter = createPulseEmitter({ hub, activeState: createActiveState() });
    const ctx = { harness: 'opencode', session_id: null, slug: null,
      project_id: null, project_label: null, read_mode: 'sqlite' };

    emitter.tailAndPulse(dbPath, ctx);
    assert.equal(hub.events.filter(e => e.event === 'tool_call').length, 0,
      'pre-existing rows at first watch must not replay as live pulses');
    emitter.closeSqliteReaders();
  });
});

// Regression test for the bug this replaces: `SELECT ... ORDER BY rowid DESC
// LIMIT 5` silently and permanently dropped anything beyond the 5 most
// recent rows. A burst of parallel/rapid tool calls (routine in agentic
// coding sessions) must all reach the SSE stream, in commit order.
test('sqlite read_mode — a burst of >5 tool parts all pulse, in order, with no drops', () => {
  const DatabaseSync = process.getBuiltinModule?.('node:sqlite')?.DatabaseSync;
  if (!DatabaseSync) return;

  withTempDir((root) => {
    const dbPath = join(root, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    opencodeDbSchema(db);
    db.exec("INSERT INTO session (id, directory, project_id, time_updated) VALUES ('ses_burst', 'D:\\\\src\\\\burstproj', 'p', 100);");
    db.close();

    const hub = fakeHub();
    const emitter = createPulseEmitter({ hub, activeState: createActiveState() });
    const ctx = { harness: 'opencode', session_id: 'ses_burst', slug: 'burst',
      project_id: null, project_label: null, read_mode: 'sqlite' };

    emitter.tailAndPulse(dbPath, ctx); // bootstrap

    const N = 12; // > the old LIMIT 5
    const db2 = new DatabaseSync(dbPath);
    for (let i = 0; i < N; i++) {
      insertPart(db2, { id: `prt_burst${i}`, messageId: 'msg_burst', sessionId: 'ses_burst', t: 200 + i, input: { filePath: `file${i}.js` } });
    }
    db2.close();

    emitter.tailAndPulse(dbPath, ctx); // single watch tick for the whole burst
    const toolCalls = hub.events.filter(e => e.event === 'tool_call');
    assert.equal(toolCalls.length, N, `all ${N} burst tool calls must pulse — got ${toolCalls.length}`);
    // Commit order preserved.
    assert.deepEqual(toolCalls.map(e => e.data.where.replace(/\\/g, '/')), Array.from({ length: N }, (_, i) => `file${i}.js`));
    emitter.closeSqliteReaders();
  });
});

// Regression test for a second bug found while investigating a live report
// of missing opencode pulses: the cursor previously advanced as rows were
// SELECTed, before dispatch ran — so a dispatch-time exception on row N
// silently and permanently lost every row after it in that batch (the
// cursor had already passed them). Reproduced live: 31 DB rows since server
// start vs 22 active-state pulses, measured simultaneously. Fixed by
// advancing the cursor per-row, after that row's dispatch (success or
// logged failure) — never before.
test('sqlite read_mode — a dispatch failure on one row does not poison rows after it in the same batch', () => {
  const DatabaseSync = process.getBuiltinModule?.('node:sqlite')?.DatabaseSync;
  if (!DatabaseSync) return;

  withTempDir((root) => {
    const dbPath = join(root, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    opencodeDbSchema(db);
    db.exec("INSERT INTO session (id, directory, project_id, time_updated) VALUES ('ses_poison', 'D:\\\\src\\\\poisonproj', 'p', 100);");
    db.close();

    const events = [];
    const hub = {
      notify: (event, data) => {
        const parsed = data ? JSON.parse(data) : null;
        if (event === 'tool_call' && parsed?.where && parsed.where.includes('file2.js')) {
          throw new Error('simulated downstream failure');
        }
        events.push({ event, data: parsed });
      },
    };
    const origErr = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args);

    try {
      const emitter = createPulseEmitter({ hub, activeState: createActiveState() });
      try {
        const ctx = { harness: 'opencode', session_id: 'ses_poison', slug: 'poison',
          project_id: null, project_label: null, read_mode: 'sqlite' };
        emitter.tailAndPulse(dbPath, ctx); // bootstrap

        const db2 = new DatabaseSync(dbPath);
        insertPart(db2, { id: 'prt_p1', messageId: 'm', sessionId: 'ses_poison', t: 200, input: { filePath: 'file1.js' } });
        insertPart(db2, { id: 'prt_p2', messageId: 'm', sessionId: 'ses_poison', t: 201, input: { filePath: 'file2.js' } }); // throws downstream
        insertPart(db2, { id: 'prt_p3', messageId: 'm', sessionId: 'ses_poison', t: 202, input: { filePath: 'file3.js' } });
        db2.close();

        emitter.tailAndPulse(dbPath, ctx);
        const toolCalls = events.filter(e => e.event === 'tool_call');
        assert.ok(toolCalls.some(e => e.data.where.includes('file1.js')), 'row before the failure must pulse');
        assert.ok(toolCalls.some(e => e.data.where.includes('file3.js')),
          'row AFTER the failing one must not be silently lost — this is the regression');
        const dispatchErrors = errors.filter(args => args.some(a => String(a).includes('[opencode] sqlite live-pulse dispatch failed')));
        assert.equal(dispatchErrors.length, 1, 'the failure must be logged, not swallowed');
      } finally {
        emitter.closeSqliteReaders();
      }
    } finally {
      console.error = origErr;
    }
  });
});

test('sqlite read_mode — a part updated pending → completed pulses exactly once (terminal-gate + cursor agree)', () => {
  const DatabaseSync = process.getBuiltinModule?.('node:sqlite')?.DatabaseSync;
  if (!DatabaseSync) return;

  withTempDir((root) => {
    const dbPath = join(root, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    opencodeDbSchema(db);
    db.exec("INSERT INTO session (id, directory, project_id, time_updated) VALUES ('ses_state', 'D:\\\\x', 'p', 10);");
    db.close();

    const hub = fakeHub();
    const emitter = createPulseEmitter({ hub, activeState: createActiveState() });
    const ctx = { harness: 'opencode', session_id: 'ses_state', slug: 'state',
      project_id: null, project_label: null, read_mode: 'sqlite' };
    emitter.tailAndPulse(dbPath, ctx); // bootstrap

    const db2 = new DatabaseSync(dbPath);
    insertPart(db2, { id: 'prt_transition', messageId: 'msg_t', sessionId: 'ses_state', t: 20, status: 'pending' });
    db2.close();
    emitter.tailAndPulse(dbPath, ctx); // pending → no pulse (adapter gate)
    assert.equal(hub.events.filter(e => e.event === 'tool_call').length, 0);

    const db3 = new DatabaseSync(dbPath);
    // Same rowid (INSERT OR REPLACE on the same PK), later time_updated — the
    // HWM cursor's (time, rowid) condition must still pick this up.
    insertPart(db3, { id: 'prt_transition', messageId: 'msg_t', sessionId: 'ses_state', t: 21, status: 'completed' });
    db3.close();
    emitter.tailAndPulse(dbPath, ctx);
    assert.equal(hub.events.filter(e => e.event === 'tool_call').length, 1,
      'the completed transition must pulse exactly once');
    emitter.closeSqliteReaders();
  });
});

test('sqlite read_mode — message-table coverage: user text pulses human_turn, assistant tokens pulses tokens', () => {
  const DatabaseSync = process.getBuiltinModule?.('node:sqlite')?.DatabaseSync;
  if (!DatabaseSync) return;

  withTempDir((root) => {
    const dbPath = join(root, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    opencodeDbSchema(db);
    db.exec("INSERT INTO session (id, directory, project_id, time_updated) VALUES ('ses_msg', 'D:\\\\x', 'p', 10);");
    db.close();

    const hub = fakeHub();
    const emitter = createPulseEmitter({ hub, activeState: createActiveState() });
    const ctx = { harness: 'opencode', session_id: 'ses_msg', slug: 'msg',
      project_id: null, project_label: null, read_mode: 'sqlite' };
    emitter.tailAndPulse(dbPath, ctx); // bootstrap

    const db2 = new DatabaseSync(dbPath);
    db2.exec(`
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES ('msg_user', 'ses_msg', 30, 30, '${JSON.stringify({ role: 'user', time: { created: 30 } })}');
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES ('prt_usertext', 'msg_user', 'ses_msg', 30, 30, '${JSON.stringify({ type: 'text', text: 'run the tests please' })}');
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES ('msg_asst', 'ses_msg', 31, 31, '${JSON.stringify({
        role: 'assistant', time: { created: 31, completed: 32 }, modelID: 'm', providerID: 'opencode',
        tokens: { input: 500, output: 200, reasoning: 0, cache: { read: 8000, write: 0 } },
      })}');
    `);
    db2.close();

    emitter.tailAndPulse(dbPath, ctx);

    const humanTurns = hub.events.filter(e => e.event === 'human_turn');
    assert.equal(humanTurns.length, 1, 'user message must pulse human_turn');

    const tokens = hub.events.filter(e => e.event === 'tokens');
    assert.equal(tokens.length, 1, 'assistant message with tokens must pulse tokens');
    assert.equal(tokens[0].data.input, 500);
    assert.equal(tokens[0].data.output, 200);
    assert.equal(tokens[0].data.cache_read, 8000);
    emitter.closeSqliteReaders();
  });
});

test('tailAndPulse — errors never escape (missing file is a no-op)', () => {
  const emitter = createPulseEmitter({ hub: fakeHub(), activeState: createActiveState() });
  assert.doesNotThrow(() => emitter.tailAndPulse('Z:/nope/missing.jsonl', CC_CTX));
});

// ── Size cap (OOM guard) ─────────────────────────────────────────────────────
// Same class of bug as parseJsonlFile's 512MB cap, but on the live path: a
// transcript that grew huge while unwatched must not be bulk-allocated on
// the first tail after restart. injected maxBytes stands in for a real
// gigabyte fixture (matches the jsonl-io/jsonl-tail test-seam convention).

test('tailAndPulse — over-cap delta is skipped, not crashed, and offset jumps past it (no retry loop)', () => {
  withTempDir((dir) => {
    const fp = join(dir, 's.jsonl');
    const oneLine = CC_LINE + '\n';
    // Cap sized so two lines together are over cap, but one line alone is under it.
    const cap = Buffer.byteLength(oneLine, 'utf8') + 5;
    writeFileSync(fp, oneLine + oneLine, 'utf8'); // delta from offset 0 exceeds cap
    const hub = fakeHub();
    const emitter = createPulseEmitter({ hub, activeState: createActiveState(), maxBytes: cap });

    assert.doesNotThrow(() => emitter.tailAndPulse(fp, CC_CTX));
    assert.equal(hub.events.filter(e => e.event === 'tool_call').length, 0, 'oversized delta produced no pulses');

    // If offset had stayed at 0 (retry loop), this delta would again be two
    // lines (still over cap) and still skip. If offset jumped to EOF as
    // designed, this new single-line delta is under cap and reads normally.
    appendFileSync(fp, oneLine, 'utf8');
    emitter.tailAndPulse(fp, CC_CTX);
    assert.equal(hub.events.filter(e => e.event === 'tool_call').length, 1, 'offset had advanced past the skipped bytes');
  });
});

test('json read_mode — over-cap file is skipped, not crashed: no pulses, no throw', () => {
  withTempDir((dir) => {
    const fp = join(dir, 'msg_big.json');
    writeFileSync(fp, JSON.stringify({
      id: 'msg_big', sessionID: 'ses_abcdef1234', role: 'assistant',
      time: { created: 1766698107679 }, modelID: 'm', providerID: 'opencode',
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 1, write: 2 } },
      finish: 'stop', _parts: [],
    }), 'utf8');
    const hub = fakeHub();
    const emitter = createPulseEmitter({ hub, activeState: createActiveState(), maxBytes: 4 });
    const ctx = { harness: 'opencode', session_id: null, slug: null,
      project_id: null, project_label: null, read_mode: 'json' };

    assert.doesNotThrow(() => emitter.tailAndPulse(fp, ctx));
    assert.equal(hub.events.filter(e => e.event !== 'now').length, 0, 'oversized json produced no data pulses');
  });
});
