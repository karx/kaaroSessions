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
// Tail Origin Policy (RFC-tail-origin-and-stream-honesty.md §4.2), live-
// confirmed 2026-09-10: a single watch-bait event replayed 9 dormant
// opencode sessions (mtimes Dec 2025 - Jul 2026) as live pulses, flooding
// the DAW and Mission Control. Age-of-content — not "before/after server
// start" — is the signal: a file whose last real write predates this
// emitter's first sight of it by more than this window is backlog, not a
// live event, regardless of exactly when the server process happened to
// start relative to the write (that race is what a serveStartedAt-style
// check would inherit).
const STALE_BACKLOG_AGE_MS = 5 * 60 * 1000; // 5 minutes
// Below this size, a jsonl transcript is cheap to replay in full even if
// old — only large dormant backlogs are worth seeding at EOF instead of
// streaming. opencode's per-message/part JSON-tree files have no size
// floor (see jsonAndPulse) because they're written once and never grow —
// unlike a jsonl transcript, "small but old" isn't a proxy for "harmless";
// it's the exact shape the live flood was made of.
const STALE_BACKLOG_SIZE_THRESHOLD = 64 * 1024;

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

  // @returns {number} pulses actually emitted — the sqlite path uses this to
  //   tell "dispatched, produced nothing yet (still pending)" from "dispatched
  //   and pulsed", to decide whether a part needs rechecking later.
  function emitPulses(records, ctx) {
    const harness = getHarness(ctx.harness);
    if (!harness) return 0;
    const nrs   = harness.adapter(records);
    const nowMs = Date.now();
    let pulseCount = 0;
    for (const pulse of normRecordsToPulses(nrs, ctx, harness.capabilities)) {
      pulseCount++;
      applyPulse(activeState, pulse, nowMs);
      kindMap?.applyPulse(pulse);
      hub.notify(pulse.event, JSON.stringify(pulse.data));
    }
    scheduleNowBroadcast();
    return pulseCount;
  }

  // Whole-file JSON harnesses (opencode): each watched file is one pretty-printed
  // JSON document, rewritten in place. Skip unchanged content via size+mtime
  // signature; fill session identity from the body when the path lacks it
  // (part/<messageID>/… files carry sessionID inside the JSON only).
  function jsonAndPulse(filePath, ctx) {
    const stat = fs.statSync(filePath);
    const sig = `${stat.size}:${stat.mtimeMs}`;
    const firstSight = !offsetMap.has(filePath);
    if (offsetMap.get(filePath) === sig) return;
    offsetMap.set(filePath, sig); // record the signature even when suppressed below — a real future edit still needs to diff against something

    if (firstSight && (Date.now() - stat.mtimeMs) > STALE_BACKLOG_AGE_MS) {
      return; // dormant file, first sight — Tail Origin Policy, see the module header comment
    }

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
  // dbPath, cursoring the `part`/`message` tables — see
  // RFC-opencode-cdc-tracking.md. Two bugs fixed here, both found live:
  //
  // 1. An earlier `ORDER BY rowid DESC LIMIT 5` scan silently and permanently
  //    dropped anything beyond the 5 most recent rows under a burst (routine
  //    for parallel/rapid tool calls), and never queried `message` at all
  //    (so the sqlite path emitted zero live `tokens`/`human_turn` pulses).
  //
  // 2. The fix for #1 cursored on a (time_updated, rowid) composite tuple.
  //    time_updated is an app-supplied timestamp, NOT guaranteed monotonic
  //    with SQLite's actual insertion order — under concurrent/parallel tool
  //    calls a row can land with an EARLIER time_updated than one already
  //    consumed (clock jitter, out-of-order commit), and the composite
  //    cursor's `WHERE time_updated > cursor.time OR (= AND rowid >
  //    cursor.rowid)` then excludes it forever, since neither disjunct is
  //    true. Measured live: 13 real tool-completions in a clean, settled
  //    window, only 9 reached active-state.
  //
  // Fixed by cursoring on `rowid` alone — SQLite's actual monotonic
  // guarantee, immune to timestamp ordering. That alone can't detect an
  // in-place UPDATE to a row already passed (rowid is stable across UPDATE),
  // which matters for the tool part pending→running→completed state machine
  // (only terminal states produce a pulse — see hooks/adapters/opencode.mjs).
  // So: any part dispatched with zero resulting pulses (still transient) is
  // remembered in a small bounded map and rechecked by id every tick until
  // it either pulses or the map's capacity evicts it (oldest first).
  //
  // Bootstrapping both cursors to each table's current max rowid on first
  // touch means whatever was already on disk at that point (the offline
  // scan's job) doesn't replay as a live pulse.
  const sqliteReaders = new Map(); // dbPath → reader state
  const PENDING_PARTS_CAP = 500;

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
      const maxPart = db.prepare('SELECT COALESCE(MAX(rowid),0) r FROM part').get();
      const maxMsg  = db.prepare('SELECT COALESCE(MAX(rowid),0) r FROM message').get();
      return {
        db,
        partRowid: maxPart.r,
        msgRowid: maxMsg.r,
        pendingParts: new Map(), // id → true; seen but not yet terminal (recheck by id)
        stmtParts: db.prepare(
          `SELECT rowid, id, session_id, message_id, data, time_updated FROM part
           WHERE rowid > ? ORDER BY rowid ASC LIMIT 100`
        ),
        stmtMessages: db.prepare(
          `SELECT rowid, id, session_id, data, time_updated FROM message
           WHERE rowid > ? ORDER BY rowid ASC LIMIT 100`
        ),
        stmtPartById: db.prepare(
          'SELECT rowid, id, session_id, message_id, data, time_updated FROM part WHERE id = ?'
        ),
        stmtPartsByMessage: db.prepare('SELECT id, data FROM part WHERE message_id = ? ORDER BY id ASC'),
      };
    } catch { return null; }
  }

  function rememberPending(map, id) {
    if (map.has(id)) return;
    if (map.size >= PENDING_PARTS_CAP) map.delete(map.keys().next().value); // evict oldest
    map.set(id, true);
  }

  function buildPartRecord(row) {
    let pData = {};
    try { pData = JSON.parse(row.data || '{}'); } catch {}
    return { id: row.id, sessionID: row.session_id, messageID: row.message_id, ...pData };
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
      return emitPulses([record], { ...resolvedCtx, project_label: projectLabel });
    };

    // Isolates one row's dispatch — a thrown exception is logged and skipped
    // (not a black hole for the rest of the batch), matching the earlier
    // per-row fix. Returns the pulse count (0 on error too).
    const safeDispatch = (row, buildRecord) => {
      try {
        return dispatch(buildRecord(row), row.session_id);
      } catch (err) {
        console.error(`[opencode] sqlite live-pulse dispatch failed for row ${row.id} (session ${row.session_id}) — skipping just this row:`, err);
        return 0;
      }
    };

    const buildMsgRecord = (row) => {
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
    };

    try {
      for (;;) {
        const rows = reader.stmtParts.all(reader.partRowid);
        if (!rows.length) break;
        for (const row of rows) {
          const pulses = safeDispatch(row, buildPartRecord);
          if (pulses > 0) reader.pendingParts.delete(row.id);
          else rememberPending(reader.pendingParts, row.id);
          reader.partRowid = row.rowid;
        }
        if (rows.length < 100) break;
      }

      for (;;) {
        const rows = reader.stmtMessages.all(reader.msgRowid);
        if (!rows.length) break;
        for (const row of rows) {
          safeDispatch(row, buildMsgRecord);
          reader.msgRowid = row.rowid;
        }
        if (rows.length < 100) break;
      }

      // Recheck sweep: parts seen earlier that hadn't reached a terminal
      // status (pending/running) — an in-place UPDATE doesn't change rowid,
      // so the sweep above will never re-surface it; re-fetch by id instead.
      for (const id of [...reader.pendingParts.keys()]) {
        const row = reader.stmtPartById.get(id);
        if (!row) { reader.pendingParts.delete(id); continue; } // deleted since
        const pulses = safeDispatch(row, buildPartRecord);
        if (pulses > 0) reader.pendingParts.delete(id);
      }
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
      let offset = offsetMap.get(filePath);
      if (offset === undefined) {
        offset = 0;
        const stat = fs.statSync(filePath);
        if (stat.size > STALE_BACKLOG_SIZE_THRESHOLD && (Date.now() - stat.mtimeMs) > STALE_BACKLOG_AGE_MS) {
          offset = stat.size; // Tail Origin Policy — seed at EOF, don't replay a large dormant backlog
        }
      }
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
