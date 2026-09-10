#!/usr/bin/env node
/**
 * analyze-opencode.mjs
 *
 * Harness Hook scanner/analyzer for opencode sessions.
 * Reads ~/.local/share/opencode/storage/{session,message,part}/ JSON trees.
 *
 * Layout (probed 2026-06-11, opencode 1.0.201):
 *   storage/session/<projectID|global>/ses_*.json   — session info (title, directory, times)
 *   storage/message/<sessionID>/msg_*.json          — messages (role, model, tokens)
 *   storage/part/<messageID>/prt_*.json             — parts (text, reasoning, tool, …)
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { enrichSession } from '../enrich-session.mjs';
import { buildSessionsOutput } from '../../surface/analyze-orchestrator.mjs';
import { recordsToNormalized } from '../adapters/opencode.mjs';
import { reduceSession } from '../session-reducer.mjs';
import { walkSessions, dirNames } from '../scan-walk.mjs';
import {
  deriveAntigravityProjectId as deriveProjectIdFromPath,
  deriveAntigravityLabel as deriveLabelFromPath,
} from '../helpers/antigravity-helpers.mjs';
import {
  OPENCODE_STORAGE_ROOT,
  OPENCODE_ROOT,
  OPENCODE_DB_PATH,
} from '../harness-paths.mjs';
import {
  OPENCODE_VERSION_MARKERS,
  OPENCODE_SUPPORTED_VERSIONS,
  detectOpencodeVersionMarker,
  warnOnOpencodeVersionMismatch,
} from '../helpers/opencode-helpers.mjs';

export {
  OPENCODE_STORAGE_ROOT,
  OPENCODE_ROOT,
  OPENCODE_DB_PATH,
  OPENCODE_VERSION_MARKERS,
  OPENCODE_SUPPORTED_VERSIONS,
  detectOpencodeVersionMarker,
};

const OUT_FILE = path.join(process.cwd(), 'sessions-data.json');

export function opencodeSlug(sessionId) {
  return sessionId.replace(/^ses_/, '').slice(0, 8);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function listJsonFiles(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return []; }
  return entries.filter(f => f.endsWith('.json')).map(f => path.join(dir, f));
}

function getSqlite() {
  const { DatabaseSync } = process.getBuiltinModule?.('node:sqlite') ?? {};
  return DatabaseSync || null;
}

/**
 * Assemble one session: info + messages (chronological) with parts embedded.
 * Used for opencode <= 1.0.x (V1 JSON storage layout).
 * @returns {{ info: object, records: object[], sizeBytes: number }}
 */
export function readOpencodeSession(storageRoot, infoPath) {
  const info = readJson(infoPath);
  let sizeBytes = fs.statSync(infoPath).size;

  const messages = [];
  for (const msgPath of listJsonFiles(path.join(storageRoot, 'message', info.id))) {
    try {
      const msg = readJson(msgPath);
      sizeBytes += fs.statSync(msgPath).size;
      const parts = [];
      for (const partPath of listJsonFiles(path.join(storageRoot, 'part', msg.id))) {
        try {
          parts.push(readJson(partPath));
          sizeBytes += fs.statSync(partPath).size;
        } catch { /* skip malformed part */ }
      }
      parts.sort((a, b) => String(a.id).localeCompare(String(b.id))); // prt_ ids are monotonic
      msg._parts = parts;
      messages.push(msg);
    } catch { /* skip malformed message */ }
  }
  messages.sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0));

  warnOnOpencodeVersionMismatch(info.version, OPENCODE_VERSION_MARKERS.V1_STORAGE_JSON);
  return { info, records: [info, ...messages], sizeBytes };
}

/**
 * Read one session from SQLite database.
 * Used for opencode >= 1.18.x (V2 SQLite layout).
 * @param {string} dbPath
 * @param {string} sessionId
 * @returns {{ info: object, records: object[], sizeBytes: number }|null}
 */
export function readOpencodeDbSession(dbPath, sessionId) {
  const DatabaseSync = getSqlite();
  if (!DatabaseSync || !fs.existsSync(dbPath)) return null;

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    let sessionRow = db.prepare('SELECT * FROM session WHERE id = ?').get(sessionId);
    if (!sessionRow) {
      const search = sessionId.startsWith('ses_') ? `${sessionId}%` : `ses_${sessionId}%`;
      sessionRow = db.prepare('SELECT * FROM session WHERE id LIKE ? ORDER BY time_updated DESC LIMIT 1').get(search);
    }
    if (!sessionRow) return null;

    const info = {
      id: sessionRow.id,
      version: sessionRow.version,
      projectID: sessionRow.project_id,
      directory: sessionRow.directory,
      title: sessionRow.title,
      time: {
        created: sessionRow.time_created,
        updated: sessionRow.time_updated,
      },
      summary: {
        additions: sessionRow.summary_additions,
        deletions: sessionRow.summary_deletions,
        files: sessionRow.summary_files,
      },
    };

    const messages = db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY time_created ASC').all(sessionRow.id);
    const msgRecords = [];
    for (const m of messages) {
      let data = {};
      try { data = JSON.parse(m.data || '{}'); } catch {}
      const msgObj = {
        id: m.id,
        sessionID: m.session_id,
        role: data.role,
        time: {
          created: m.time_created,
          completed: data.time?.completed || m.time_updated,
        },
        modelID: data.modelID,
        providerID: data.providerID,
        tokens: data.tokens,
        finish: data.finish,
        path: data.path,
      };

      const parts = db.prepare('SELECT * FROM part WHERE message_id = ? ORDER BY id ASC').all(m.id);
      msgObj._parts = parts.map(p => {
        let pData = {};
        try { pData = JSON.parse(p.data || '{}'); } catch {}
        return {
          id: p.id,
          sessionID: p.session_id,
          messageID: p.message_id,
          ...pData,
        };
      });
      msgRecords.push(msgObj);
    }

    const sizeBytes = fs.statSync(dbPath).size;
    warnOnOpencodeVersionMismatch(info.version, OPENCODE_VERSION_MARKERS.V2_SQLITE_DB);
    return { info, records: [info, ...msgRecords], sizeBytes };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

export function analyzeOpencodeSession(storageRoot, infoPath, opts = {}) {
  let sessionData;
  if (opts.dbPath || infoPath?.endsWith?.('.db') || opts.sessionId) {
    const dbPath = opts.dbPath || infoPath;
    sessionData = readOpencodeDbSession(dbPath, opts.sessionId);
  } else {
    sessionData = readOpencodeSession(storageRoot, infoPath);
  }
  if (!sessionData?.info?.id) return null;
  const { info, records, sizeBytes } = sessionData;

  const session = reduceSession(recordsToNormalized(records), {
    session_id:    info.id,
    project_id:    deriveProjectIdFromPath(info.directory), // CC-style path slug → cross-harness project unify
    project_label: deriveLabelFromPath(info.directory),
    harness:       'opencode',
    capabilities:  { size_proxy: 'tokens_work' },
  });

  session.slug = opencodeSlug(info.id);
  const updatedIso = info.time?.updated ? new Date(info.time.updated).toISOString() : null;
  if (updatedIso && (!session.last_timestamp || updatedIso > session.last_timestamp)) {
    session.last_timestamp = updatedIso;
  }
  if (!session.duration_ms && session.first_timestamp && session.last_timestamp) {
    session.duration_ms =
      new Date(session.last_timestamp).getTime() - new Date(session.first_timestamp).getTime();
  }
  session.file_size_bytes = sizeBytes;
  session.source = 'opencode';
  enrichSession(session);
  return session;
}

export function scanOpencodeSessions(storageRoot = OPENCODE_STORAGE_ROOT) {
  let dbPath = null;
  if (storageRoot.endsWith('.db') && fs.existsSync(storageRoot)) {
    dbPath = storageRoot;
  } else if (fs.existsSync(path.join(storageRoot, 'opencode.db'))) {
    dbPath = path.join(storageRoot, 'opencode.db');
  } else if (fs.existsSync(path.join(path.dirname(storageRoot), 'opencode.db'))) {
    dbPath = path.join(path.dirname(storageRoot), 'opencode.db');
  }

  const sessionRoot = fs.existsSync(path.join(storageRoot, 'session'))
    ? path.join(storageRoot, 'session')
    : (fs.existsSync(path.join(storageRoot, 'storage', 'session'))
      ? path.join(storageRoot, 'storage', 'session')
      : null);

  if (!sessionRoot && !dbPath) {
    return null;
  }

  const walkRoot = sessionRoot || path.dirname(dbPath);
  const seenIds = new Set();

  return walkSessions(walkRoot, 'opencode', function* (entries) {
    // 1. Scan SQLite sessions (opencode >= 1.18.x)
    const DatabaseSync = getSqlite();
    if (DatabaseSync && dbPath) {
      let db;
      try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        const rows = db.prepare('SELECT id, time_updated FROM session ORDER BY time_updated DESC').all();
        for (const r of rows) {
          if (!r?.id || seenIds.has(r.id)) continue;
          seenIds.add(r.id);
          yield {
            id: `sqlite/${r.id}`,
            analyze: () => analyzeOpencodeSession(storageRoot, dbPath, { dbPath, sessionId: r.id }),
          };
        }
      } catch (err) {
        console.warn(`[opencode] sqlite scan error: ${err.message}`);
      } finally {
        try { db?.close(); } catch {}
      }
    }

    // 2. Scan JSON sessions (opencode <= 1.0.x)
    if (sessionRoot) {
      const bucketEntries = sessionRoot === walkRoot ? entries : (function() {
        try { return fs.readdirSync(sessionRoot, { withFileTypes: true }); } catch { return []; }
      })();
      for (const bucket of dirNames(bucketEntries)) {
        for (const infoPath of listJsonFiles(path.join(sessionRoot, bucket))) {
          const base = path.basename(infoPath);
          if (!base.startsWith('ses_')) continue;
          const sessId = base.replace(/\.json$/, '');
          if (seenIds.has(sessId)) continue;
          seenIds.add(sessId);
          yield {
            id: `${bucket}/${base}`,
            analyze: () => analyzeOpencodeSession(storageRoot, infoPath),
          };
        }
      }
    }
  }, { sourceDir: storageRoot });
}

function main() {
  const result = scanOpencodeSessions();
  if (!result?.sessions?.length) {
    console.error(`opencode storage not found or empty: ${OPENCODE_STORAGE_ROOT}`);
    process.exit(1);
  }

  console.log('Scanning', OPENCODE_STORAGE_ROOT, '...');
  const output = buildSessionsOutput([result]);
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nSessions: ${output.sessions.length}  Projects: ${output.projects.length}`);
  console.log(`Output: ${OUT_FILE}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
