# RFC: Non-Blocking Debezium-Style CDC & High-Water Mark Cursors for Opencode SQLite Tracking

**Project:** kaaroSessions  
**Status:** Proposed  
**Date:** 2026-09-11  
**Relates to:** `hooks/analyzers/analyze-opencode.mjs`, `surface/pulse-emitter.mjs`, `surface/watch-handlers.mjs`, `hooks/registry.mjs`, `docs/OPENCODE.md`  
**Grounding:** Opencode v1.18.x+ SQLite database architecture (`opencode.db`, `opencode.db-wal`), `node:sqlite` zero-dependency engine.

---

## 1. Problem Statement

Opencode ($\ge 1.18.x$) stores all session, message, and part data in a local SQLite database (`~/.local/share/opencode/opencode.db`) running in Write-Ahead Logging (`WAL`) mode. 

While historical analysis (`readOpencodeDbSession`) and ContextTree trace reconstruction (`/api/trace/:sessionId`) function correctly, the **live tracking and pulse emission path (`sqliteAndPulse` in `surface/pulse-emitter.mjs`)** suffers from architectural bottlenecks and coverage gaps:

| Current Flaw | Mechanism in Code | Consequence |
|---|---|---|
| **Connection Thrashing** | `new DatabaseSync(dbPath, { readOnly: true })` + `db.close()` per `fs.watch` event | Allocates file handles, inspects WAL headers, and touches `-shm` on every micro-tick. Induces locking friction and risk of `SQLITE_BUSY` against active opencode transactions. |
| **Arbitrary Window Drop** | `SELECT ... FROM part ORDER BY rowid DESC LIMIT 5` | If opencode inserts/updates $>5$ parts in a burst or if OS file watch batches notifications, records beyond the 5 most recent are **permanently skipped**. |
| **Incomplete Domain Capture** | Queries **only** the `part` table | Opencode stores token metrics (`input`, `output`, `cache.read`, `cache.write`), model IDs, and user prompts on the `message` table. Consequently, **zero `tokens` pulses and zero `human_turn` pulses** are ever emitted for opencode SQLite live streams. |
| **Unbounded Memory Leak** | `offsetMap.set('${row.id}:${status}', true)` in global `Map` | Keys are never evicted. In a long-running daemon, the map grows monotonically ($O(N)$ with total lifetime parts). |
| **Machine-Wide Rebuild Spike** | `watch.rebuildArg` returns `null` for `opencode.db` | Triggers a full, un-targeted scan across **all harnesses on the system** on every SQLite change instead of an incremental 5 ms session update. |

---

## 2. Goals & Guiding Invariants

### 2.1 Goals
1. **Deterministic Event Delivery (0% Drop Rate):** Consume every mutation in chronological commit order, regardless of burst size.
2. **Non-Blocking WAL Concurrency:** Guarantee that tracking operations never block opencode CLI writers, never degrade host performance, and never fail on concurrent writes.
3. **Full Domain Telemetry:** Capture `message` records (for `tokens` and `user_turn`) alongside `part` records (for `tool_call`, `thinking`, `words`).
4. **$O(1)$ Memory Footprint:** Replace the unbounded `offsetMap` with High-Water Mark cursor coordinates and a fixed-capacity ring buffer for status deduplication.
5. **Surgical Incremental Rebuilds:** Capture the modified `session_id` to drive `--harness=opencode --session=<id>` rebuilds instead of multi-harness rescans.

### 2.2 Guiding Invariants
* **Auditor Invariant (Zero DDL/Mutation):** Never create tables, triggers, views, or write-locks on `opencode.db`. The database is externally owned by the opencode runtime. Tracking is strictly passive and read-only.
* **Zero External Dependencies:** Built entirely with Node.js built-in `node:sqlite` (`DatabaseSync`).
* **Graceful Degradation:** If `opencode.db` is temporarily locked or undergoing WAL checkpointing, fail non-fatally with a configurable busy timeout.

---

## 3. High-Water Mark (HWM) Cursor: Definition & Semantics

In distributed stream processing (such as Apache Kafka and Debezium CDC), a **High-Water Mark (HWM)** represents the highest committed offset or log sequence number (LSN) processed by a consumer.

In the context of Opencode SQLite tracking, the table schema does not provide a global auto-incrementing WAL sequence, but it guarantees:
1. `time_updated`: Monotonically non-decreasing integer (Unix epoch ms timestamp of record creation/mutation).
2. `rowid`: 64-bit unique monotonic integer assigned by SQLite for row insertion.

### 3.1 Composite Cursor Tuple
We define the cursor state vector as:
$$\text{Cursor} = \langle \tau_{\text{last}}, \rho_{\text{last}} \rangle = \langle \text{time\_updated}, \text{rowid} \rangle$$

By indexing on the composite order $(\text{time\_updated}, \text{rowid})$, we achieve a strictly ordered, forward-advancing scan across table mutations.

```
Table commit sequence:
[ (t1, r1) ] → [ (t1, r2) ] → [ (t2, r3) ] → [ (t2, r4) ] ──▶ (Time)
                              ▲
                              └─ High-Water Mark Checkpoint: <t1, r2>
                                 Next Query fetches: > t1 OR (= t1 AND rowid > r2)
```

---

## 4. Architectural Design

```
                  ┌────────────────────────────────────────┐
                  │          Opencode CLI Writer           │
                  │   Writes to opencode.db / -wal / -shm  │
                  └──────────────────┬─────────────────────┘
                                     │ OS file notifications
                                     ▼
                  ┌────────────────────────────────────────┐
                  │    kaaroSessions Persistent Reader     │
                  │  - PRAGMA query_only = ON              │
                  │  - PRAGMA busy_timeout = 5000          │
                  │  - Prepared Statement Pool             │
                  └───────────┬────────────────┬───────────┘
                              │                │
            Poll Table `part` │                │ Poll Table `message`
       WHERE (time, rowid) > HWM               WHERE (time, rowid) > HWM
                              ▼                ▼
                  ┌────────────────────────────────────────┐
                  │        CDC Drain & Dispatcher          │
                  │  - Drain batches (LIMIT 100)           │
                  │  - Advance HWM checkpoints             │
                  │  - Bounded LRU dedup (terminal states) │
                  └───────────┬────────────────┬───────────┘
                              │                │
             emitPulses()     │                │ capture changed session_id
                              ▼                ▼
     ┌──────────────────────────────────┐   ┌──────────────────────────────┐
     │      Active State & SSE Hub      │   │ Targeted Incremental Rebuild │
     │  - tool_call, words, thinking    │   │ analyzeOpencodeSession()     │
     │  - tokens, human_turn            │   │ mergeSessionIntoData()       │
     └──────────────────────────────────┘   └──────────────────────────────┘
```

### 4.1 Connection Lifecycle & PRAGMA Tuning
Instead of allocating and closing connections per watch event, `pulse-emitter.mjs` manages a persistent reader connection:

```js
class OpencodeDbReader {
  constructor(dbPath) {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    
    // Concurrency and non-blocking guarantees:
    this.db.exec('PRAGMA query_only = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA synchronous = NORMAL;');

    this.partCursor = { time: 0, rowid: 0 };
    this.msgCursor  = { time: 0, rowid: 0 };

    this.stmtParts = this.db.prepare(`
      SELECT rowid, id, session_id, message_id, data, time_updated
      FROM part
      WHERE time_updated > ? OR (time_updated = ? AND rowid > ?)
      ORDER BY time_updated ASC, rowid ASC
      LIMIT 100
    `);

    this.stmtMessages = this.db.prepare(`
      SELECT rowid, id, session_id, time_created, time_updated, data
      FROM message
      WHERE time_updated > ? OR (time_updated = ? AND rowid > ?)
      ORDER BY time_updated ASC, rowid ASC
      LIMIT 100
    `);
  }
}
```

### 4.2 High-Water Mark Initialization
On server initialization, the reader bootstraps its cursor to the table maximums so historical rows are not re-emitted as live pulses:

```sql
SELECT COALESCE(MAX(time_updated), 0) AS max_time, COALESCE(MAX(rowid), 0) AS max_rowid FROM part;
SELECT COALESCE(MAX(time_updated), 0) AS max_time, COALESCE(MAX(rowid), 0) AS max_rowid FROM message;
```

### 4.3 Deterministic Drain Loop
When notified of a database change, the reader drains both tables in batches:

```js
drainChanges() {
  const touchedSessions = new Set();

  // 1. Drain parts
  while (true) {
    const rows = this.stmtParts.all(this.partCursor.time, this.partCursor.time, this.partCursor.rowid);
    if (!rows.length) break;

    for (const row of rows) {
      this.partCursor.time  = row.time_updated;
      this.partCursor.rowid = row.rowid;
      touchedSessions.add(row.session_id);
      this.dispatchPart(row);
    }
    if (rows.length < 100) break; // caught up
  }

  // 2. Drain messages
  while (true) {
    const rows = this.stmtMessages.all(this.msgCursor.time, this.msgCursor.time, this.msgCursor.rowid);
    if (!rows.length) break;

    for (const row of rows) {
      this.msgCursor.time  = row.time_updated;
      this.msgCursor.rowid = row.rowid;
      touchedSessions.add(row.session_id);
      this.dispatchMessage(row);
    }
    if (rows.length < 100) break;
  }

  return touchedSessions;
}
```

### 4.4 Bounded LRU Cache for Update Deduplication
Tool parts transition through states: `pending` $\rightarrow$ `running` $\rightarrow$ `completed` / `error`.
Only terminal states emit pulses (`completed` / `error`). To prevent duplicate emissions when updated:

```js
class BoundedKeyCache {
  constructor(maxSize = 2000) {
    this.maxSize = maxSize;
    this.map = new Map();
  }
  has(key) { return this.map.has(key); }
  add(key) {
    if (this.map.size >= this.maxSize) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
    this.map.set(key, true);
  }
}
```
* Key format: `${part.id}:${part.state?.status || part.type}`
* Memory bound: $\le 2000$ string keys ($\approx 120\text{ KB}$ constant heap).

### 4.5 Message Telemetry Dispatch (Tokens & Turns)
When a message row updates:
1. If `data.role === 'user'`, emit `user_turn` $\rightarrow$ `human_turn` pulse.
2. If `data.role === 'assistant'` and `data.tokens`:
   ```js
   const tokens = {
     input: data.tokens.input || 0,
     output: data.tokens.output || 0,
     cache_create: data.tokens.cache?.write || 0,
     cache_read: data.tokens.cache?.read || 0,
   };
   emitPulses([{
     kind: 'tokens',
     harness: 'opencode',
     ts: new Date(row.time_updated).toISOString(),
     tokens,
   }], ctx);
   ```

### 4.6 Surgical Incremental Rebuild Orchestration
Instead of triggering an unbounded full rebuild:
1. `drainChanges()` returns the set of modified `session_id` values.
2. For each touched session, `scheduleRebuild({ rebuildArg: \`--session=\${sessionId}\`, harnessId: 'opencode' })`.
3. `analyze.mjs` executes `analyzeOpencodeSession(storageRoot, dbPath, { dbPath, sessionId })` and merges via `mergeSessionIntoData()`.
4. Total rebuild execution time drops from hundreds of milliseconds to under 10 ms.

---

## 5. Performance Hypotheses & Resource Model

### 5.1 Complexity & Overhead Comparison

| Characteristic | Current Implementation | Proposed CDC Architecture |
|---|---|---|
| **Query Complexity** | $O(\log N + 5)$ backward scan on `rowid` | $O(\log N + K)$ forward indexed scan ($K = \text{batch size}$) |
| **File Handle Churn** | 1 open + 1 close per fs notification | 1 open at startup, 0 close during streaming |
| **Lock Friction on WAL** | Reader touches lock/shm headers on every tick | Reused snapshot, zero lock contention |
| **Event Loss Probability** | $>0\%$ on bursts $>5$ | $0.00\%$ |
| **Memory Growth (24 hr)** | Monotonically increasing ($O(N)$) | Strictly $O(1)$ ($<200\text{ KB}$ fixed) |
| **Rebuild Latency** | $300\text{ ms} - 1200\text{ ms}$ (full scan) | $4\text{ ms} - 12\text{ ms}$ (incremental merge) |

### 5.2 Theoretical Concurrency Bounds
Under SQLite WAL mode:
* $$T_{\text{read}} \cap T_{\text{write}} \neq \emptyset \implies \text{Non-blocking}$$
* Because the reader runs with `PRAGMA query_only = ON;`, SQLite avoids taking any `SHARED` locks on the rollback journal or write locks on the database page header.
* `PRAGMA busy_timeout = 5000` guarantees that even during a `wal_checkpoint(TRUNCATE)` operation by opencode, the reader gracefully yields for up to 5 seconds rather than raising `SQLITE_BUSY`.

---

## 6. Testing & Validation Strategy

1. **Burst Invariant Test (`test/pulse-emitter.test.mjs`):**
   * Insert 25 tool parts and 5 message tokens in a single transaction.
   * Verify all 25 `tool_call` and 5 `tokens` pulses are emitted in chronological order without drops.
2. **Concurrent Write Resilience Test:**
   * Run active write transactions in one worker while `drainChanges()` executes concurrently.
   * Confirm zero `SQLITE_BUSY` exceptions occur.
3. **Memory Boundedness Test:**
   * Stream 10,000 simulated part updates.
   * Verify cache size remains clamped at $\le 2000$ entries.
4. **Incremental Rebuild Test (`test/analyze-opencode.test.mjs`):**
   * Verify `analyzeOpencodeSession` invoked via `--session=<id>` updates only the targeted session in `sessions-data.json`.

---

## 7. Implementation Phases

* **Phase 1 (HWM Part Cursor & Connection Persistence):** Convert `sqliteAndPulse` to use a persistent reader and cursor query `(time_updated, rowid)`.
* **Phase 2 (Message Table & Token Pulse Coverage):** Add message table polling to emit `tokens` and `human_turn` pulses.
* **Phase 3 (Surgical Rebuild & LRU Cache):** Replace unbounded map with bounded LRU cache and wire targeted session rebuilds.
