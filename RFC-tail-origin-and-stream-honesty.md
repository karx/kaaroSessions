# RFC: Tail Origin Policy, Bookkeeping Classification, and Unknown Bucket Honesty

**Project:** kaaroSessions  
**Status:** Proposed  
**Date:** 2026-09-11  
**Relates to:** `surface/pulse-emitter.mjs`, `surface/watch-handlers.mjs`, `hooks/adapters/claude-code.mjs`, `hooks/pulse-map.mjs`, `hooks/normalized-record.mjs`, `RFC-kind-map.md`, `docs/LIVE-FEED-KNOWN-MAP.md`, `notes/pipelines/2026-09-10-first-sight-unknown-flood.md`  
**Grounding:** Live capture `demos/unknown-bucket-user-capture.tmp.json` (`2026-09-10T19:22:40Z`) where Claude CLI upgrades and daemon worker cleanups touched dormant transcript files, triggering first-sight byte-0 full-file replays that flooded the Kind Map unknown bucket with thousands of false-alarm `unknown_record` hits.

---

## 1. Problem Statement

During live operation, the Observability Surface stream is fed by filesystem watch events dispatched to `tailAndPulse(filePath, ctx)`. When a transcript file is observed for the first time by a running `serve` process, its initial byte offset defaults to `0`:

```text
Harness writes/touches a .jsonl under a watched root
        ↓
fs.watch (recursive) → processWatchFilename → tailAndPulse(absPath, ctx)
        ↓
offsetMap.get(path) ?? 0     ← FIRST SIGHT = byte 0
        ↓
tailRead(path, 0)            ← entire file if under MAX_JSONL_BYTES
        ↓
adapter → NormalizedRecord[] (many unknown_record for unmapped raw types)
        ↓
pulse-map: unknown_record → event "unknown" (Catch-all alarm)
        ↓
kindMap.applyPulse + SSE → unknown bucket upsert (count++)
```

In the incident recorded in `notes/pipelines/2026-09-10-first-sight-unknown-flood.md`, a Claude CLI version update (`2.1.263 → 2.1.267`) caused daemon housekeeping and worker retirement that bumped the timestamps of several inactive, multi-megabyte `.jsonl` files. Because `serve` had never seen those files in the current process, it read each entire file from byte 0.

This caused two distinct issues to compound:

| Layer | Failure Mode | Impact |
|---|---|---|
| **Layer A: Adapter Coverage** | Unmapped internal bookkeeping raw types (`atis-latch`, `bridge-session`, `file-history-delta`, residual `system` subtypes, `cost-state`, `worktree-state`) fell through to `unknown_record`. | Turned non-cognitive harness state into high-severity coverage alarms. |
| **Layer B: Tail Origin Policy** | First sight of an **already-large, inactive** file replayed its complete multi-megabyte history as if it were a live burst occurring at the current instant. | Injected thousands of historical records into the live SSE stream, saturating the unknown bucket and skewing live telemetry. |
| **Attribution Illusion** | The Kind Map unknown bucket aggregated counts keyed only by `harness | nr_kind | raw_type | block_type`, displaying the `session_id` and `slug` of only the **most recent writer**. | A single session (`293d23e9`) appeared to be responsible for 1,079 `atis-latch` errors, obscuring that the count was a cumulative replay across the entire corpus. |

---

## 2. Goals & Guiding Invariants

### 2.1 Goals
1. **Eliminate False-Alarm Floods:** Classify known harness bookkeeping records into explicit `session_meta` NormalizedRecords with `silent` (snapshot) disposition.
2. **Honest Tail Origin:** Distinguish between a newly initiated active session (which should pulse its opening content) and a stale, pre-existing backlog touched by background processes (which should seed at EOF).
3. **Truthful Attribution in Kind Map:** Update the unknown bucket contract so multi-session replay cannot masquerade as single-session error generation.
4. **Preserve Temporal Integrity:** Distinguish between **Recorded Time** (event timestamp from log) and **Arrival Time** (delivery time via SSE) across Mission Control, the DAW, and the Kind Map.

### 2.2 Guiding Invariants
* **Zero Silent Drops:** Every raw record must emit $\ge 1$ NormalizedRecord, and every NormalizedRecord must emit $\ge 1$ pulse object. Never drop raw records silently in adapters.
* **Catch-All Integrity:** The `unknown` pulse event remains the strict catch-all alarm for genuine coverage holes. Never reclassify unknown types as `silent` without identifying their schema.
* **Sonic-Unaware Adapters:** Adapters never make audio or UI disposition decisions. They produce semantic NormalizedRecords; disposition rules remain exclusively in `hooks/pulse-map.mjs`.
* **Auditor Stance:** The pipeline observes and normalizes. It never modifies watched transcripts or interferes with harness operations.

---

## 3. Ontology & Terminology

The following definitions are formalized for `CONTEXT.md` and repo-wide architectural documentation:

### 3.1 Tail Origin
The byte-offset initialization policy for the first `tailAndPulse` call on a watched path within the current serve process:
- **`live-open`**: The file is newly created or within the active-start size threshold ($< \text{threshold}$). Offset initialized to `0` so initial user/assistant turns are delivered as live pulses.
- **`stale-backlog`**: The file already existed prior to server startup or is larger than the active-start threshold without recent chat turns. Offset initialized to current `file_size` (EOF). Subsequent appends are processed live.
- **`append`**: Steady-state streaming after initial offset registration.

### 3.2 Bookkeeping Record
A transcript record capturing internal harness plumbing rather than a cognitive turn: latch tokens, bridge metadata, cost metrics, worktree path relocation, queue state, or background summaries (`stop_hook_summary`, `away_summary`).
- **Normalized Kind:** `session_meta` (or dedicated `harness_bookkeeping` if lifecycle isolation is required).
- **Disposition:** `silent` (`reason: 'snapshot'`).

### 3.3 Watch Bait
A filesystem mutation on a transcript file that does not signify a user or assistant cognitive turn (e.g. daemon retirement, CLI self-update, bridge latch rewrite, desktop indexer scan). Watch Bait must not trigger `live-open` replay or promote a session card to `Active` in Mission Control.

### 3.4 Recorded Time vs. Arrival Time
- **Recorded Time ($\tau_R$):** The timestamp encoded in the record's payload (`nr.ts`).
- **Arrival Time ($\tau_A$):** The monotonic timestamp when the server ingested the byte delta and broadcast the SSE pulse.
- When $\tau_A - \tau_R \gg \text{window}$, the event is historical replay, not current cognition.

---

## 4. Technical Specification

### 4.1 Layer A: Claude Code Bookkeeping Adapter Classification

The Claude Code adapter (`hooks/adapters/claude-code.mjs`) is updated to classify known internal bookkeeping types into `session_meta` NormalizedRecords instead of letting them fall through to `unknown_record`:

| Raw Type | Normalized Record Kind | Target Fields | Pulse Disposition |
|---|---|---|---|
| `atis-latch` | `session_meta` | `latch_id`, `type: 'atis-latch'` | `silent` |
| `bridge-session` | `session_meta` | `bridge_session_id` | `silent` |
| `file-history-delta` | `session_meta` | `file_history_delta` | `silent` |
| `cost-state` | `session_meta` | `cost_usd` | `silent` |
| `worktree-state` | `session_meta` | `worktree_root` | `silent` |
| `queue-operation` | `session_meta` | `queue_op` | `silent` |
| `agent-name` | `session_meta` | `agent_name` | `silent` |
| `system` (residual subtypes) | `session_meta` | `subtype: raw.subtype` | `silent` |

*Note:* `compact_boundary` and `turn_duration` within `system` records continue to produce their dedicated `context_reset` and `turn_duration` NRs.

### 4.2 Layer B: Tail Origin Policy in `pulse-emitter.mjs`

When `tailAndPulse(filePath, ctx)` encounters an untracked file:

```js
const STALE_BACKLOG_SIZE_THRESHOLD = 64 * 1024; // 64 KB

function determineTailOrigin(filePath, stats, serveStartedAt) {
  // If file was modified before the server process started and exceeds the threshold:
  if (stats.mtimeMs < serveStartedAt && stats.size > STALE_BACKLOG_SIZE_THRESHOLD) {
    return 'stale-backlog';
  }
  return 'live-open';
}
```

1. If `tail_origin === 'stale-backlog'`:
   - Initialize `offsetMap.set(filePath, stats.size)`.
   - Emit an optional single typed diagnostic lifecycle event (`status: 'stale_tail_seeded'`, `{ file: filePath, size: stats.size }`).
   - Do not parse historical bytes into pulses.
2. If `tail_origin === 'live-open'`:
   - Initialize `offsetMap.set(filePath, 0)`.
   - Read and pulse up to `MAX_JSONL_BYTES` with `data.tail_origin = 'live-open'`.

### 4.3 Layer C: Kind Map Unknown Bucket Schema Refinement

The Kind Map unknown bucket (`surface/kind-map-store.mjs` and `/api/kind-map`) is refined to represent multi-session distribution honestly:

#### Current Schema:
```json
{
  "harness": "claude-code",
  "nr_kind": "unknown_record",
  "raw_type": "atis-latch",
  "block_type": null,
  "count": 1079,
  "last_session_id": "293d23e9...",
  "last_slug": "293d23e9",
  "last_project": "kaaroViewer"
}
```

#### Proposed Schema:
```json
{
  "harness": "claude-code",
  "nr_kind": "unknown_record",
  "raw_type": "atis-latch",
  "block_type": null,
  "count": 1079,
  "sessions_touched": 24,
  "contributors": [
    { "session_id": "04917833...", "slug": "04917833", "count": 420 },
    { "session_id": "293d23e9...", "slug": "293d23e9", "count": 310 }
  ],
  "last_seen_at": "2026-09-10T19:18:50.000Z",
  "replayed": true
}
```

- Adds `sessions_touched` (unique count of sessions contributing to this hole).
- Adds `contributors` (top-$N$ sessions with call counts, preventing single-session scapegoating).
- Badges `REPLAY` in `/mapping` when the majority of pulses arrived via backlog replays or when $\tau_A - \tau_R > 1 \text{ hr}$.

### 4.4 Downstream Surface Protections

1. **Mission Control (`now.html` / `surface/active-state.mjs`):**
   - Bookkeeping pulses and silent `session_meta` pulses do not reset a session's idle timer or mark it `active`.
   - Active state transition strictly requires cognitive events: `tool_call`, `tokens`, `words`, `human_turn`, `compact`, or `mode_shift`.
2. **Cognitive DAW (`experience/client/14-pulse-audio.js`, `16-beat-overlay.js`):**
   - Events with $\tau_A - \tau_R > 300\text{s}$ are classified as backfill; they do not trigger realtime synthesizer triggers on the live beat clock.

---

## 5. Implementation Plan & Test Verification

### Phase 1: Adapter Bookkeeping Classification
- **Files:** `hooks/adapters/claude-code.mjs`, `hooks/pulse-map.mjs`.
- **Tests:** Add unit tests in `test/adapters/claude-code.test.mjs` asserting that `atis-latch`, `bridge-session`, `file-history-delta`, `cost-state`, and residual `system` types produce `session_meta` with `silent` disposition. Verify `test/adapters/nr-compliance.test.mjs` remains green.

### Phase 2: Tail Origin Implementation
- **Files:** `surface/pulse-emitter.mjs`.
- **Tests:** Add test scenarios in `test/pulse-emitter.test.mjs`:
  - `tailAndPulse — newly created file with small size seeds at byte 0 (live-open)`.
  - `tailAndPulse — pre-existing file older than server startup seeds at EOF (stale-backlog)`.
  - Verify zero pulses emitted on first sight of a stale multi-megabyte fixture.

### Phase 3: Unknown Bucket Contributor Aggregation
- **Files:** `surface/kind-map-store.mjs`, `surface/http-routes.mjs`, `experience/client/20-kind-map.js`.
- **Tests:** Add test in `test/http-routes.test.mjs` asserting `contributors` array and `sessions_touched` in `/api/kind-map` payload.

---

## 6. Compatibility & Migration

- **Backward Compatibility:** Existing client bundles consuming `/events` and `/api/active` require no changes; additional fields on pulses and `/api/kind-map` are additive.
- **Contract Adherence:** Fully preserves the Two-Layer architecture. Adapters remain pure data converters; `surface/` handles transport, caching, and stream origin semantics.
