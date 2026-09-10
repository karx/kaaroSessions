/**
 * surface/pulse-emitter.mjs — the Stream production path.
 *
 * Watched-file change → tail new bytes (or whole-file JSON for read_mode
 * 'json' harnesses) → registry adapter → NormalizedRecords → pulses →
 * hub broadcast + active-state, plus the throttled `now` snapshot.
 *
 * Adapter + capabilities + project-label resolution all come from the
 * registry — nothing here is harness-specific.
 */
import fs from 'fs';

import { tailRead } from '../hooks/jsonl-tail.mjs';
import { normRecordsToPulses } from '../hooks/pulse-transformer.mjs';
import { getHarness } from '../hooks/registry.mjs';
import { applyPulse, snapshotActive } from './active-state.mjs';
import { MAX_JSONL_BYTES } from '../hooks/jsonl-io.mjs';

/**
 * @param {object} deps
 * @param {{ notify: (event: string, data?: string) => void }} deps.hub
 * @param {object} deps.activeState — store from createActiveState()
 * @param {{ applyPulse: (pulse: object) => void }} [deps.kindMap] — live kind-map overlay
 * @param {number} [deps.nowThrottleMs] — trailing-edge `now` broadcast window
 * @param {number} [deps.maxBytes] — shared OOM-guard cap for tail/whole-file
 *   reads (default MAX_JSONL_BYTES) + test seam
 * @returns {{ tailAndPulse: (filePath: string, ctx: object) => void }}
 */
export function createPulseEmitter({ hub, activeState, kindMap = null, nowThrottleMs = 1000, maxBytes = MAX_JSONL_BYTES }) {
  const offsetMap = new Map(); // filePath → byte offset (jsonl) or size:mtime sig (json)
  let nowTimer = null;

  // Throttle: at most one `now` broadcast per window, trailing-edge,
  // so bursty multi-record tails collapse into a single snapshot push.
  function scheduleNowBroadcast() {
    if (nowTimer) return;
    nowTimer = setTimeout(() => {
      nowTimer = null;
      hub.notify('now', JSON.stringify(snapshotActive(activeState, Date.now())));
    }, nowThrottleMs);
    nowTimer.unref?.();
  }

  function emitPulses(records, ctx) {
    const harness = getHarness(ctx.harness);
    if (!harness) return;
    const nrs   = harness.adapter(records);
    const nowMs = Date.now();
    for (const pulse of normRecordsToPulses(nrs, ctx, harness.capabilities)) {
      applyPulse(activeState, pulse, nowMs);
      kindMap?.applyPulse(pulse);
      hub.notify(pulse.event, JSON.stringify(pulse.data));
    }
    scheduleNowBroadcast();
  }

  // Whole-file JSON harnesses (opencode): each watched file is one pretty-printed
  // JSON document, rewritten in place. Skip unchanged content via size+mtime
  // signature; fill session identity from the body when the path lacks it
  // (part/<messageID>/… files carry sessionID inside the JSON only).
  function jsonAndPulse(filePath, ctx) {
    const stat = fs.statSync(filePath);
    const sig = `${stat.size}:${stat.mtimeMs}`;
    if (offsetMap.get(filePath) === sig) return;
    offsetMap.set(filePath, sig);

    // Same OOM guard as the jsonl tail path — a whole-file JSON harness
    // (opencode) rewrites its file on every change, so this read is
    // unconditional; refuse rather than bulk-allocate an unbounded file.
    if (stat.size > maxBytes) {
      console.warn(`[pulse] json read skipped ${(stat.size / 1024 / 1024).toFixed(1)}MB (over ${(maxBytes / 1024 / 1024).toFixed(1)}MB cap) — ${filePath}`);
      return;
    }

    const obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const sessionId = ctx.session_id || obj.sessionID || null;
    if (!sessionId) return;
    // Fast path: the changed doc itself carries the directory (session info
    // docs do). Otherwise fall back to the harness's resolveProjectLabel
    // hook (message/part docs don't carry it — see registry.mjs's opencode
    // watch config) so tool_call pulses stay attributed to their project.
    const dir = obj.directory ? obj.directory.replace(/\\/g, '/').split('/').pop() : null;
    const resolvedCtx = { ...ctx, session_id: sessionId, slug: ctx.slug || sessionId.replace(/^ses_/, '').slice(0, 8) };
    const resolveLabel = getHarness(ctx.harness)?.watch?.resolveProjectLabel;
    const projectLabel = ctx.project_label || dir || (resolveLabel ? resolveLabel(resolvedCtx, filePath) : null);
    emitPulses([obj], { ...resolvedCtx, project_label: projectLabel });
  }

  // SQLite database harnesses (opencode >= 1.18.x): a persistent reader per
  // dbPath, cursoring the `part`/`message` tables by a High-Water Mark tuple
  // (time_updated, rowid) — see RFC-opencode-cdc-tracking.md. This replaces
  // an earlier `ORDER BY rowid DESC LIMIT 5` scan, which silently and
  // permanently dropped anything beyond the 5 most recent rows under a burst
  // (routine for parallel/rapid tool calls) and never queried `message` at
  // all (so opencode's SQLite path emitted zero live `tokens`/`human_turn`
  // pulses). The HWM cursor guarantees every row is delivered exactly once,
  // in commit order, with no arbitrary window; bootstrapping it to the
  // tables' current max on first touch means whatever was already on disk
  // at that point (the offline scan's job) doesn't replay as a live pulse.
  const sqliteReaders = new Map(); // dbPath → reader state

  function dbPathFromWatchedFile(filePath) {
    return filePath.endsWith('.db') ? filePath : filePath.replace(/\.db-[^/\\]+$/, '.db');
  }

  function loadSqliteReader(dbPath) {
    const DatabaseSync = process.getBuiltinModule?.('node:sqlite')?.DatabaseSync;
    if (!DatabaseSync || !fs.existsSync(dbPath)) return null;
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec('PRAGMA query_only = ON;');
      db.exec('PRAGMA busy_timeout = 5000;'); // yield through opencode's own WAL checkpoints
      const maxPart = db.prepare('SELECT COALESCE(MAX(time_updated),0) t, COALESCE(MAX(rowid),0) r FROM part').get();
      const maxMsg  = db.prepare('SELECT COALESCE(MAX(time_updated),0) t, COALESCE(MAX(rowid),0) r FROM message').get();
      return {
        db,
        partCursor: { time: maxPart.t, rowid: maxPart.r },
        msgCursor:  { time: maxMsg.t,  rowid: maxMsg.r },
        stmtParts: db.prepare(
          `SELECT rowid, id, session_id, message_id, data, time_updated FROM part
           WHERE time_updated > ? OR (time_updated = ? AND rowid > ?)
           ORDER BY time_updated ASC, rowid ASC LIMIT 100`
        ),
        stmtMessages: db.prepare(
          `SELECT rowid, id, session_id, data, time_updated FROM message
           WHERE time_updated > ? OR (time_updated = ? AND rowid > ?)
           ORDER BY time_updated ASC, rowid ASC LIMIT 100`
        ),
        stmtPartsByMessage: db.prepare('SELECT id, data FROM part WHERE message_id = ? ORDER BY id ASC'),
      };
    } catch { return null; }
  }

  // Drains a cursor's statement in LIMIT-100 pages until caught up, dispatching
  // each row as it's fetched — a burst larger than one page still delivers
  // every row, just across more queries. The cursor advances per row, AFTER
  // that row's dispatch (success or logged failure), never before: advancing
  // eagerly during the SELECT phase (an earlier design) let a dispatch-time
  // exception on row N silently and permanently skip every row after it in
  // the batch, since the cursor had already passed them before dispatch ever
  // ran. One bad row is now logged and skipped — not a black hole for
  // everything downstream of it.
  function drainAndDispatch(stmt, cursor, buildRecord, dispatch) {
    for (;;) {
      const rows = stmt.all(cursor.time, cursor.time, cursor.rowid);
      if (!rows.length) break;
      for (const row of rows) {
        try {
          dispatch(buildRecord(row), row.session_id);
        } catch (err) {
          console.error(`[opencode] sqlite live-pulse dispatch failed for row ${row.id} (session ${row.session_id}) — skipping just this row:`, err);
        }
        cursor.time = row.time_updated;
        cursor.rowid = row.rowid;
      }
      if (rows.length < 100) break;
    }
  }

  function sqliteAndPulse(filePath, ctx) {
    const dbPath = dbPathFromWatchedFile(filePath);
    let reader = sqliteReaders.get(dbPath);
    if (!reader) {
      reader = loadSqliteReader(dbPath);
      if (!reader) return;
      sqliteReaders.set(dbPath, reader);
    }

    const dispatch = (record, sessionId) => {
      const resolvedCtx = {
        ...ctx,
        session_id: sessionId,
        slug: ctx.slug || (sessionId ? sessionId.replace(/^ses_/, '').slice(0, 8) : null),
      };
      const resolveLabel = getHarness(ctx.harness)?.watch?.resolveProjectLabel;
      const projectLabel = ctx.project_label || (resolveLabel ? resolveLabel(resolvedCtx, dbPath) : null);
      emitPulses([record], { ...resolvedCtx, project_label: projectLabel });
    };

    try {
      drainAndDispatch(reader.stmtParts, reader.partCursor, (row) => {
        let pData = {};
        try { pData = JSON.parse(row.data || '{}'); } catch {}
        return { id: row.id, sessionID: row.session_id, messageID: row.message_id, ...pData };
      }, dispatch);

      drainAndDispatch(reader.stmtMessages, reader.msgCursor, (row) => {
        let mData = {};
        try { mData = JSON.parse(row.data || '{}'); } catch {}
        const msgObj = { id: row.id, sessionID: row.session_id, ...mData };
        // Message rows never carry their own text (only role/time/tokens/etc) —
        // it lives in a separate `part` row. Join it so human_turn pulses
        // carry real preview text, same as the JSON-tree adapter path does
        // via `_parts`.
        if (mData.role === 'user') {
          msgObj._parts = reader.stmtPartsByMessage.all(row.id).map(p => {
            let d = {};
            try { d = JSON.parse(p.data || '{}'); } catch {}
            return { id: p.id, ...d };
          });
        }
        return msgObj;
      }, dispatch);
    } catch (err) {
      // The SELECT itself failing (locked db, corrupted file, etc) — the
      // cursor hasn't moved, so the next tick retries from the same point.
      console.error('[opencode] sqlite live-pulse read failed (will retry next tick):', err);
    }
  }

  function tailAndPulse(filePath, ctx) {
    try {
      if (ctx.read_mode === 'json') return jsonAndPulse(filePath, ctx);
      if (ctx.read_mode === 'sqlite') return sqliteAndPulse(filePath, ctx);
      const resolveLabel = getHarness(ctx.harness)?.watch?.resolveProjectLabel;
      if (resolveLabel && !ctx.project_label) {
        ctx = { ...ctx, project_label: resolveLabel(ctx, filePath) };
      }
      const offset = offsetMap.get(filePath) ?? 0;
      const { records, newOffset, skippedBytes } = tailRead(filePath, offset, { maxBytes });
      offsetMap.set(filePath, newOffset);
      if (skippedBytes) {
        console.warn(`[pulse] tail skipped ${(skippedBytes / 1024 / 1024).toFixed(1)}MB (over ${(maxBytes / 1024 / 1024).toFixed(1)}MB cap) — ${filePath}`);
      }
      if (!records.length) return;
      emitPulses(records, ctx);
    } catch { /* tail errors must not affect the main rebuild flow */ }
  }

  // Test/shutdown seam: persistent sqlite readers are never closed during
  // normal operation (they live for the server process's lifetime), but a
  // caller that owns a dbPath's lifecycle (tests with a temp dir; a future
  // graceful shutdown) needs to release the handle explicitly — on Windows,
  // an open sqlite connection blocks deleting its file.
  function closeSqliteReaders() {
    for (const reader of sqliteReaders.values()) {
      try { reader.db.close(); } catch { /* already closed / never opened */ }
    }
    sqliteReaders.clear();
  }

  return { tailAndPulse, closeSqliteReaders };
}
