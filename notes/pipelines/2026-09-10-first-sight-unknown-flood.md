---
published: false
title: "First-sight unknown flood — dormant JSONL replay vs coverage alarm"
tags: [kaaro-sessions, pipeline, pulse, kind-map, unknown-bucket, claude-code, watch, ontology]
description: "Behaviour note: inactive Claude Code transcripts were full-file pulsed into the unknown bucket after a CLI upgrade touched idle sessions. Separates adapter gaps from first-sight replay. Proposes ontology + structure updates to refine, improve, visualize, and encode the Stream honestly."
date: 2026-09-10
layer: L3-Principle
maturity: BUDDING
para: Pipeline
evidence:
  - demos/unknown-bucket-user-capture.tmp.json
  - demos/unknown-bucket-user-capture.tmp.txt
  - ~/.claude/daemon.log (upgrade 2.1.263→2.1.267 @ 18:12Z)
---

# First-sight unknown flood

**Status:** behaviour + ontology proposal — not an RFC yet  
**Capture:** `demos/unknown-bucket-user-capture.tmp.{json,txt}` @ `2026-09-10T19:22:40Z`  
**Symptom:** Kind Map unknown bucket filled with thousands of Claude Code `unknown_record` hits (`atis-latch`, `bridge-session`, `file-history-delta`, …), attributed to sessions that were **not** actively chatting  
**Sibling notes:** `oom-proof-transcript-io.md` (first-sight EOF seed deliberately deferred), `docs/LIVE-FEED-KNOWN-MAP.md` P4 (atis-latch / system residuals)

This note records **what the system actually did**, **why inactive sessions appeared**, and **which vocabulary / structures** we need so the next capture is diagnosable without a forensic dig.

Promote to an RFC only when we lock a Stream contract change (Tail Origin policy, unknown-bucket schema, or bookkeeping NR kind).

---

## 1. Behaviour (observed)

### 1.1 Causal chain

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
pulse-map: unknown_record → event "unknown" (Catch-all / alarm)
        ↓
kindMap.applyPulse + SSE → unknown bucket upsert (count++)
```

Serve does **not** scan all sessions on startup. It only pulses after a watch event. The flood happens when a **dormant** file gets its **first** watch event in this process.

### 1.2 What touched idle files (this capture)

From `~/.claude/daemon.log` + project mtimes (UTC):

| When | Marker | Effect on Stream |
|---|---|---|
| 18:12:57 | Claude CLI upgrade `2.1.263 → 2.1.267` (daemon self-restart) | Process churn; workers re-adopted |
| 18:14:07 | `lattu/04917833….jsonl` mtime bump; tail is `cost-state` / `bridge-session` / `continued-in` | Idle session bookkeeping write → watch |
| 18:16:01 | Daemon retires worker `b49929e5` (idle 65h, version skew, low memory); **~11.8MB** jsonl mtime bump | Primary full-file replay candidate |
| 18:22:56 | `~/.claude/.last-cleanup` | Cleanup marker only |
| 19:18:50 | `kaaroViewer/293d23e9….jsonl` mtime/ctime bump; **no** new timestamped chat (max ts Sep 8); no file-history / history.jsonl / sessions registry update | Touch without active resume — watch bait |
| 19:22:40 | User copied unknown bucket | Snapshot of accumulated alarms |

Only four project JSONLs were touched in the window. The bucket’s huge counts are **not** “every dead session woke up.”

### 1.3 Attribution illusion

Unknown bucket key today:

```text
harness | nr_kind | raw_type | block_type
```

`session_id` / `slug` / `project` on each row are **last writer**, not the sole contributor.  
Example: capture `atis-latch ×1079` vs ~1329 `atis-latch` records disk-wide (~0.81× corpus) — one near-complete first-sight pass over most CC sessions that carry that type, labeled with whichever session bumped the key last (`293d23e9`).

Session-specific types still prove replay: `worktree-state` 65 in-file → 209 in bucket (~3.2×) for a file whose mtime was days old — multiple first-sight waves and/or a long-lived `/mapping` tab accumulating across SSE reconnects before `updated` refresh.

### 1.4 Two bugs stacked (do not conflate)

| Layer | Failure | Fix class |
|---|---|---|
| **A. Adapter coverage** | Claude bookkeeping raw types (`atis-latch`, `bridge-session`, `file-history-delta`, residual `system` subtypes, `cost-state`, `worktree-state`, …) fall through to `unknown_record` | Map to `session_meta` (or a dedicated bookkeeping NR) → disposition **silent / snapshot** |
| **B. Tail Origin** | First sight of an **already-large** file replays history as live pulses | Policy: distinguish *new session first content* vs *stale backlog* (deferred in OOM L2) |

Layer A makes the replay **loud** (alarm). Layer B makes the replay **large**. Fix A alone turns a flood into a silent storm; fix B alone leaves honest holes still bursting on upgrade day. Need both for an honest Kind Map.

### 1.5 Invariants that stay

- Every raw record → ≥1 NormalizedRecord → ≥1 pulse (no silent *drops*).
- `unknown` remains the Catch-all alarm for true coverage holes.
- `silent` remains the sink for known envelope / snapshot / duplicate NRs.
- Adapters stay sonic-unaware; disposition lives in `pulse-map.mjs`.

---

## 2. Ontology updates (CONTEXT vocabulary)

Add or sharpen these terms so operators and code share one language. Proposed `CONTEXT.md` Language entries:

### 2.1 Tail Origin

**Tail Origin**:
The byte-offset policy for the first `tailAndPulse` on a watched path in the current serve process.

- **Live-open** — offset `0` is correct: the file is new or still short; opening content should become live pulses.
- **Stale-backlog** — offset should seed at EOF: the file already existed with substantial history; only subsequent appends are live.

_Avoid_: “bootstrap replay”, “full-file pulse” as the name of the policy (those are symptoms). Name the **decision**, not the failure mode.

### 2.2 Bookkeeping Record

**Bookkeeping Record** (raw harness type → usually `session_meta`):
Harness-internal plumbing written into the transcript without a user/assistant cognitive turn: latch ids, bridge session ids, cost snapshots, worktree relocation, queue operations, artifact ledgers, residual `system` subtypes (`stop_hook_summary`, `away_summary`), etc.

Disposition target: **Silent Pulse** (`reason: snapshot`), not Catch-all.

_Avoid_: calling these “noise” in the ontology (they are structured); calling them `unknown` once mapped.

### 2.3 Unknown Bucket

**Unknown Bucket**:
The Kind Map accumulator of Catch-all (`unknown`) pulses, keyed for maintainer triage. Today: distinct `harness × nr_kind × raw_type × block_type` with a running `count` and last-hit session fields.

Must not be read as “this session alone emitted `count` holes” unless the schema says so.

### 2.4 Coverage Hole vs Replay Amplification

**Coverage Hole**:
An NR that is genuinely unclassified (`unknown_record`, unknown `content_block.block_type`, non-`RECORD_KIND`). One hole per such NR is the alarm unit.

**Replay Amplification**:
The multiplier introduced when Tail Origin = live-open on a stale file (or when the bucket key collapses many sessions). `capture_count / in_file_count` for a session-specific raw type estimates waves; `capture_count / disk_wide_count` estimates corpus first-sight coverage.

### 2.5 Watch Bait

**Watch Bait**:
A filesystem event on a transcript path that is not a cognitive turn — upgrade retire, bridge latch rewrite, cleanup, desktop scan, spurious recursive `fs.watch`. Sufficient to start the Stream path; insufficient to mean “session is active.”

Mission Control “active” and Tail Origin must not treat Watch Bait as Live-open proof by itself.

### 2.6 Arrival Time (already adjacent)

Keep **Recorded Time** (`data.ts` from NR) distinct from **Arrival Time** (when SSE delivered / when first-sight replayed history). Replay storms have Recorded Time in the past and Arrival Time = now. Visualize both or the DAW lies.

---

## 3. Structure updates — refine · improve · visualize · encode

### 3.1 Refine (model / schema)

| Structure | Change | Why |
|---|---|---|
| Unknown bucket key | Add optional dimensions: `tail_origin` (`live-open` \| `stale-backlog` \| `append`), `wave_id` (serve boot id), and **contributor rollup** (`by_session: [{session_id, count}]` capped) | Separates last-writer illusion from real multiplicity |
| Pulse envelope | Stamp `data.tail_origin` + `data.byte_offset` / `data.delta_bytes` on every live pulse from `pulse-emitter` | Kind Map + Mission Control can filter replay |
| `session_meta` fields | Allow stable optional keys from bookkeeping: `agent_name`, `bridge_session_id`, `atis`, `relocated_cwd`, `cost_usd` (as meta, not tokens) | Encode without new RECORD_KINDs unless a kind earns sonic/trace weight |
| Serve boot marker | `wave_id` / `serve_started_at` on kind-map payload + SSE hello | Replay waves become countable |

### 3.2 Improve (adapters / emitter behaviour)

| Priority | Change | Effect |
|---|---|---|
| **P0** | Claude Code adapter: map bookkeeping raw types → `session_meta` (same pattern as `file-history-snapshot`) | Flood becomes silent; Catch-all honest again |
| **P0b** | Residual `system` subtypes → `session_meta` (keep `compact_boundary` / `turn_duration` special cases) | Clears residual `system` unknowns |
| **P1** | Tail Origin heuristic: if first sight and `size ≥ N` (or `mtime` older than serve start by T) → seed offset at EOF, emit one diagnostic `silent`/`scaffold` “stale-tail-seeded” (or a single typed lifecycle event) | Stops upgrade-day history storms |
| **P1b** | Grok `turn_completed` → `tokens` (data loss today); `subagent_*` / `current_mode_update` → real NRs | Encode high-value gaps, not just silence noise |
| **P2** | Opencode empty `content_block` text → skip or silent (falsy `nr.text` currently → unknown) | One-line disposition edge |
| **P3** | `/mapping` client: reset or version-stamp `_kUnknownBucket` on EventSource reconnect; don’t stack waves across serve restarts | Client amplification |

### 3.3 Visualize (Kind Map / Mission Control / DAW)

| Surface | Update |
|---|---|
| **Unknown bucket UI** | Show `count` plus `sessions_touched` / top contributors; badge `REPLAY` when `tail_origin=stale-backlog` or `delta_bytes ≈ file size` |
| **Kind Map cells** | Keep ●/○/·/◇; add a small “live vs replay” strip or filter so upgrade storms don’t paint false live coverage |
| **Mission Control** | Do not mark a session Active solely from bookkeeping / silent meta pulses; require cognitive pulse families (`tool_call`, `tokens`, `words`, `human_turn`, …) |
| **DAW / beat ring** | Prefer Recorded Time for placement; if Arrival−Recorded ≫ threshold, draw as ghost/backfill lane (or drop from live ring) so history replay doesn’t look like a present burst |
| **Copy JSON** | Include `generated_at`, `serve_started_at`, `wave_id`, and schema_version so demos/ captures are comparable |

### 3.4 Encode (disposition + registry — the actual code table)

Encoding path stays:

```text
raw type → adapter NR kind → pulseDisposition → Event Registry / sinks
```

Recommended encode table for the Claude flood types (all → NR `session_meta` → pulse `silent` / `snapshot`):

| raw_type | Encode as | Notes |
|---|---|---|
| `atis-latch` | `session_meta` | latch id optional field |
| `bridge-session` | `session_meta` | bridge ids |
| `file-history-delta` | `session_meta` | sibling of handled snapshot |
| `agent-name` | `session_meta` (+ future sonic wishlist) | silent now |
| `queue-operation` | `session_meta` or `scaffold` | task-notification XML |
| `cost-state` | `session_meta` | not `tokens` |
| `worktree-state` / `relocated` | `session_meta` (± `branch_change` if branch flips) | |
| `frame-link` / `pr-link` / `continued-in` | `session_meta` or `attachment` | |
| `artifact-*` | `session_meta` | plugin ledgers |
| `system` ∉ {compact_boundary, turn_duration} | `session_meta` | stop_hook_summary, away_summary, … |

Do **not** invent a second disposition channel in the adapter. Do **not** drop NRs.

Optional later NR kind `harness_bookkeeping` only if Kind Map needs a distinct stub from `session_meta` (same silent disposition). Prefer extending `session_meta` until a stub earns its keep.

---

## 4. Diagnostic checklist (next capture)

1. Note `serve_started_at` / process uptime.  
2. List project `*.jsonl` with mtime in the storm window (expect few).  
3. Diff `daemon.log` / harness upgrade markers vs those mtimes.  
4. For each unknown raw_type: `capture_count / disk_wide_count` (corpus first-sight) and, if session-specific, `capture_count / in_file_count` (replay waves).  
5. Confirm whether pulses carry past Recorded Time with present Arrival.  
6. Classify each raw_type: **map to silent meta** vs **real semantic NR** vs **leave unknown**.

---

## 5. Decision gate (when to RFC)

RFC if we change any of:

1. Tail Origin default (first sight EOF vs 0) — Stream contract.  
2. Unknown bucket key / contributor schema — Kind Map API.  
3. New `RECORD_KIND` for bookkeeping — NR contract + pulse-map row + tests.

Otherwise ship as: adapter P0 + emitter Tail Origin heuristic + bucket UI honesty, linked from this note and `docs/LIVE-FEED-KNOWN-MAP.md` P4.

---

## 6. Links

- Capture: `demos/unknown-bucket-user-capture.tmp.json`  
- Emitter contract: `surface/pulse-emitter.mjs`, `test/pulse-emitter.test.mjs`  
- Disposition: `hooks/pulse-map.mjs`, `CONTEXT.md` Silent Pulse / Catch-all  
- Deferred seed: `notes/pipelines/oom-proof-transcript-io.md` (“What L2 deliberately did not do”)  
- Prior CC holes: `docs/LIVE-FEED-KNOWN-MAP.md` P4  
- Kind Map: `RFC-kind-map.md` § unknowns[]
