/**
 * test/opencode-helpers.test.mjs → hooks/helpers/opencode-helpers.mjs
 *
 * opencodeSessionLabel resolves a session's project label from its info doc
 * (ses_*.json) even when called against a message/part file that carries no
 * directory info of its own — see hooks/TRACE-opencode-sessions.md and the
 * live-pulse project-attribution gap it documents.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  opencodeSessionLabel,
  clearOpencodeSessionLabelCache,
  OPENCODE_VERSION_MARKERS,
  OPENCODE_SUPPORTED_VERSIONS,
  detectOpencodeVersionMarker,
} from '../hooks/helpers/opencode-helpers.mjs';

function withTempStorage(fn) {
  const root = join(tmpdir(), 'kaaro-oc-helpers-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(join(root, 'session', 'bucketA'), { recursive: true });
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('opencode version markers and supported versions contracts', () => {
  assert.equal(OPENCODE_VERSION_MARKERS.V1_STORAGE_JSON, '1.0');
  assert.equal(OPENCODE_VERSION_MARKERS.V2_SQLITE_DB, '1.18');
  assert.deepEqual(OPENCODE_SUPPORTED_VERSIONS, ['1.0.x', '1.18.x']);

  assert.equal(detectOpencodeVersionMarker('1.0.201'), '1.0');
  assert.equal(detectOpencodeVersionMarker('1.0'), '1.0');
  assert.equal(detectOpencodeVersionMarker('1.18.30'), '1.18');
  assert.equal(detectOpencodeVersionMarker('1.19.0'), '1.18');
  assert.equal(detectOpencodeVersionMarker('2.0.0'), null);
  assert.equal(detectOpencodeVersionMarker(null), null);
  assert.equal(detectOpencodeVersionMarker(''), null);
});

test('opencodeSessionLabel — derives the label from SQLite session row if present', () => {
  const DatabaseSync = process.getBuiltinModule?.('node:sqlite')?.DatabaseSync;
  if (!DatabaseSync) return;

  withTempStorage((root) => {
    const dbPath = join(root, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT,
        project_id TEXT,
        time_updated INTEGER
      );
      INSERT INTO session (id, directory, project_id, time_updated)
      VALUES ('ses_sql123', 'D:\\\\src\\\\sqlproj', 'proj_1', 100);
    `);
    db.close();

    clearOpencodeSessionLabelCache();
    assert.equal(opencodeSessionLabel('ses_sql123', root), 'sqlproj');
  });
});

test('opencodeSessionLabel — derives the label from the session info doc directory', () => {
  withTempStorage((root) => {
    writeFileSync(
      join(root, 'session', 'bucketA', 'ses_test123.json'),
      JSON.stringify({ id: 'ses_test123', directory: 'D:\\src\\myproj', time: { created: 1, updated: 2 } }),
      'utf8',
    );
    clearOpencodeSessionLabelCache();
    assert.equal(opencodeSessionLabel('ses_test123', root), 'myproj');
  });
});

test('opencodeSessionLabel — caches per session id (second call skips disk)', () => {
  withTempStorage((root) => {
    const infoPath = join(root, 'session', 'bucketA', 'ses_cache1.json');
    writeFileSync(infoPath, JSON.stringify({ id: 'ses_cache1', directory: 'D:\\x\\y' }), 'utf8');
    clearOpencodeSessionLabelCache();
    assert.equal(opencodeSessionLabel('ses_cache1', root), 'y');

    // Mutate on disk — a cached lookup must not see this.
    writeFileSync(infoPath, JSON.stringify({ id: 'ses_cache1', directory: 'D:\\other\\z' }), 'utf8');
    assert.equal(opencodeSessionLabel('ses_cache1', root), 'y', 'cached label survives a later on-disk change');
  });
});

test('opencodeSessionLabel — unknown session id returns null (cached as null too)', () => {
  withTempStorage((root) => {
    clearOpencodeSessionLabelCache();
    assert.equal(opencodeSessionLabel('ses_nope', root), null);
    assert.equal(opencodeSessionLabel('ses_nope', root), null); // cache hit path, same result
  });
});

test('opencodeSessionLabel — null session id short-circuits to null without touching disk', () => {
  clearOpencodeSessionLabelCache();
  assert.equal(opencodeSessionLabel(null, 'Z:/does/not/exist'), null);
});
