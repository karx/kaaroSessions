# RFC: Defensive Poll Fallback for fs.watch Notification Stalls on opencode.db

**Project:** kaaroSessions
**Status:** Proposed — awaiting review, not yet implemented
**Date:** 2026-09-11
**Relates to:** `serve.mjs`, `surface/pulse-emitter.mjs`, `hooks/registry.mjs`, `RFC-opencode-cdc-tracking.md` (the HWM-cursor fix this builds on), `RFC-tail-origin-and-stream-honesty.md` (a related, non-overlapping finding on the same watch → `tailAndPulse` path)
**Grounding:** Live trace against the real, running `serve.mjs` process and the user's active opencode session on `2026-09-10T20:31–20:32Z` (session `ses_f7352c536ffeBQI3KpynGgsGWj`, project `ebrain`). No fixtures — this is an observed production behavior on Windows.

---

## 1. Problem Statement

Three bugs in the opencode SQLite live-pulse *cursor* (the code that decides which DB rows are "new") were found and fixed today — see `RFC-opencode-cdc-tracking.md` and commits `0d2d936`, `d47bfbc`, `b965b7d`. All three are proven correct by unit tests, including a reproduction of the specific failure mode that caused the third one.

A fourth, structurally different problem surfaced while live-verifying that third fix, and it sits one layer below the cursor entirely: **the cursor only ever runs when `fs.watch` tells `serve.mjs` that `opencode.db` or `opencode.db-wal` changed — and on Windows, that notification does not reliably fire.**

This is not a data-loss bug. Every row the cursor eventually sees, it correctly turns into a pulse. The problem is *timeliness*: when the notification stalls, no tick runs, so no pulse fires, until something else nudges the watch loose. From a user's perspective this reads exactly like "missing" tool calls — the DAW goes silent for real work that's actively happening — even though nothing has actually been lost.

---

## 2. Evidence

Trace conducted against the live server (PID confirmed stable throughout, no restart in this window — restart-adjacent effects, which contaminated earlier measurements in this investigation, are ruled out here).

**T0 — 2026-09-10T20:31:30Z**
```
DB (ses_f7352c536ffeBQI3KpynGgsGWj, completed tool parts): 173
active-state tool_calls: (session not yet present)
changed: [opencode] count in server log: 4
```

**T1 — 2026-09-10T20:32:03Z (33s later, no manual intervention)**
```
DB: 177                                    (+4 real rows written)
active-state tool_calls: (session STILL not present)
changed: [opencode] count: 4               (UNCHANGED — zero new watch events in 33s)
```

At this point: real writes were landing in `opencode.db-wal` (confirmed independently via direct SQLite reads), but the `fs.watch` callback registered in `serve.mjs` on `~/.local/share/opencode` had not fired once for either `opencode.db` or `opencode.db-wal` since the four events at server startup.

**Manual probe — same timestamp.** A single unrelated file was touched elsewhere in the same recursively-watched tree (`storage/session/global/.watch-probe.json`, a file `opencode`'s current storage layout doesn't even use):

```
changed: [opencode] count: 4 → 13          (9 notifications flushed at once)
active-state tool_calls: 0 → 8             (immediate catch-up, same tick)
```

**T2 — 25s later, no further manual intervention**
```
changed: [opencode] count: 13 → 16         (3 more events, delivered normally)
DB: unchanged (the session went idle)
```

Interpretation: the watch is not dead — it resumed normal delivery on its own after the nudge, and stayed healthy for the following 25s window. The failure mode is a **transient stall**, not a permanent stop, and it was broken loose by an event completely unrelated to the file that was actually changing.

---

## 3. Root Cause

`serve.mjs` registers one `fs.watch(root, { recursive: true }, callback)` per harness root; opencode's root is `~/.local/share/opencode`, watched recursively over the entire tree including `storage/`, `snapshot/`, `log/`, `tool-output/`, and the SQLite files at the top level. On Windows, Node's recursive `fs.watch` is backed by `ReadDirectoryChangesW`, which delivers change notifications through a fixed-size kernel buffer per watched directory handle. Under sustained write volume — exactly what `opencode.db-wal` sees during an active session (a WAL frame appended on every message/part commit) — that buffer can fill faster than the notifications drain, and Windows' documented behavior on overflow is silent notification loss or delivery starvation until the buffer is serviced by *some* event, not necessarily one from the file that overflowed it.

This matches the observed pattern precisely: real writes continued, no notifications arrived for the specific files under contention, and an unrelated write anywhere in the tree flushed the backlog. This is stated as the best-fitting explanation of the observed behavior, not as something independently confirmed against Windows/libuv internals — no deeper OS-level instrumentation was attached in this investigation.

**This is unrelated to any of today's cursor fixes.** The cursor is a pure function of "what rows exist past my last position" — it has no dependency on *how often* it's asked to check. It was proven correct by direct SQL comparison, by unit tests, and by the fact that the 9-event backlog, once flushed, produced exactly the right pulses.

---

## 4. Proposed Fix: Defensive Poll Fallback

Don't depend on `fs.watch` firing at all. Add a low-frequency timer that calls the same `tailAndPulse` entry point on a schedule, independent of any filesystem notification. The HWM cursor already makes this safe and cheap:

- **Idempotent by construction:** a poll tick and a watch-triggered tick call the exact same code path (`sqliteAndPulse`) against the exact same persistent reader and cursor state. Whichever fires first does the work; the other is a `WHERE rowid > ?` query that matches nothing and returns immediately.
- **Cheap when quiet:** an indexed `rowid`-range scan against zero new rows is a fast, bounded no-op on a local SQLite file — running it every few seconds indefinitely is not a meaningful cost.
- **No double-delivery risk:** because the cursor (not the trigger) is the source of truth for "have I seen this row," a watch event and a poll tick racing on the same moment cannot produce duplicate pulses — whichever runs second simply finds nothing new.

### 4.1 Where it lives

Scope this to the registry, not hardcoded into `serve.mjs` or `pulse-emitter.mjs`, matching the existing "registry is the single source of truth per harness" pattern (`hooks/registry.mjs`'s own header comment). Proposed shape:

```js
// hooks/registry.mjs — opencode's watch block
watch: {
  matchLogFile(rel) { /* unchanged */ },
  ctxFromPath(relPath) { /* unchanged */ },
  resolveProjectLabel(ctx, absPath) { /* unchanged */ },
  rebuildArg: () => null,
  pollIntervalMs: 4000, // NEW — only opencode declares this today
},
```

`serve.mjs`'s watch-registration loop, alongside its existing `fs.watch(root, ...)` call per harness, additionally checks for `harness.watch.pollIntervalMs` and — only when present — starts a `setInterval` that re-invokes `tailAndPulse` against every currently-known sqlite `dbPath` for that harness on that cadence. No other harness declares this field, so no other harness's behavior changes.

### 4.2 What "every currently-known dbPath" means in practice

For opencode there is exactly one `dbPath` per machine (`OPENCODE_DB_PATH`), so the poll target is static and known at watch-registration time — no dynamic discovery needed. This keeps the poll loop trivial: one `setInterval` per harness that declares `pollIntervalMs`, calling `tailAndPulse(dbPath, ctx)` with the same `read_mode: 'sqlite'` context `ctxFromPath` would have produced for a real `opencode.db` watch event.

### 4.3 Interval choice

4 seconds is proposed as a starting point: fast enough that a stalled watch window feels like normal SSE latency rather than a dropout, slow enough that it stays a true fallback (a healthy watch will keep firing far more often than this and do essentially all the real work; the poll mostly finds nothing). This is a judgment call, not derived from a hard constraint — worth tuning against real usage rather than treating as final.

---

## 5. Testing & Validation Strategy

1. **Unit: poll timer invokes `tailAndPulse` on schedule.** `surface/pulse-emitter.mjs` already exposes `tailAndPulse`; a new test in `test/pulse-emitter.test.mjs` (or a new `test/registry-poll.test.mjs` if the timer lives in a separate registry-driven helper) asserts that, given a harness descriptor with `pollIntervalMs` set, a scheduled call fires without any `fs.watch` event.
2. **Unit: poll and watch coexist without double pulses.** Seed a temp `opencode.db`, call `tailAndPulse` twice in immediate succession (simulating a watch event and a poll tick landing back-to-back) — assert the second call produces zero additional pulses, proving the cursor (not the caller) is what prevents duplication.
3. **No regression for other harnesses.** `test/harness-registry.test.mjs` gets a new assertion alongside its existing `resolveProjectLabel` coverage check: only `opencode` declares `pollIntervalMs`; every other harness's descriptor omits it.
4. **Live verification.** Once merged, restart `serve.mjs`, deliberately reproduce the stall (sustained opencode activity — this has been directly observed to trigger it, no artificial fault injection needed) and confirm the DAW/graph no longer goes silent for more than one poll interval.

---

## 6. Alternatives Considered

- **Watch a narrower path** (e.g., just `opencode.db-wal` instead of the whole `OPENCODE_ROOT` tree). Would reduce notification volume competing for the same kernel buffer, but the RFC's own evidence shows the *specific* file being written was what stalled — narrowing the watch doesn't address a buffer that overflows under that file's own write rate, and it would require splitting opencode off from the single-recursive-watch-per-harness pattern every other harness in `serve.mjs` uses. Not pursued as the primary fix; could be a complementary tweak later if the poll fallback alone proves insufficient.
- **Switch to `chokidar` or another watch library.** Might have different (possibly better) buffering behavior on Windows, but it's a new dependency in a project whose adapters and harness readers are explicitly zero-dependency by design (`node:sqlite` used raw rather than any wrapper, for exactly this reason — see `hooks/analyzers/analyze-copilot.mjs`'s precedent). Not pursued.
- **Fix nothing, rely on the user manually nudging the watch.** This is literally what happened during today's investigation and it worked, but it's obviously not a real fix — it depends on unrelated filesystem activity happening to occur in the same tree.

The poll fallback is the smallest, dependency-free, harness-scoped change that removes the reliance on `fs.watch` firing at all, without touching or risking the cursor logic that was just fixed and proven correct today.

---

## 7. Implementation Phases

- **Phase 1:** Add `pollIntervalMs` to opencode's `watch` block in `hooks/registry.mjs`; wire a per-harness `setInterval` in `serve.mjs`'s existing watch-registration loop, gated on the field being present.
- **Phase 2:** Tests per §5.
- **Phase 3:** Live verification per §5.4; tune the interval if warranted.
