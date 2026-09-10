# Opencode Harness

`kaaro-sessions` provides first-class support for `opencode` sessions, supporting both the legacy JSON storage format (v1.0.x) and the modern SQLite database architecture (v1.18.x+), with real-time live pulse streaming, trace tree reconstruction, and project attribution.

---

## Version Support Markers & Storage Layouts

Opencode stores session transcripts under `~/.local/share/opencode/`. Over its evolution, opencode transitioned from multi-tree JSON files to a unified SQLite database:

| Version Marker | Release Series | Storage Architecture | File Layout |
|---|---|---|---|
| `1.0` | `1.0.x` (probed `1.0.201`) | V1 JSON tree | `storage/{session,message,part}/*.json` |
| `1.18` | `1.18.x+` (probed `1.18.30`) | V2 SQLite DB | `opencode.db`, `opencode.db-wal` (tables: `session`, `message`, `part`) |

The harness scanner (`hooks/analyzers/analyze-opencode.mjs`), session locator (`hooks/session-locators.mjs`), and file watcher (`hooks/registry.mjs`) automatically detect and support both formats simultaneously on the same machine.

### Layout Details

```text
~/.local/share/opencode/
├── opencode.db               # SQLite database (v1.18.x+: tables session, message, part)
├── opencode.db-wal           # SQLite Write-Ahead Log (active writes)
├── opencode.db-shm
└── storage/                  # JSON storage (v1.0.x legacy layout)
    ├── session/              # per-session info (ses_*.json)
    │   ├── <projectID>/
    │   └── global/
    ├── message/              # per-session messages (msg_*.json)
    │   ├── <sessionID>/
    │   └── <sessionID>.json
    └── part/                 # per-message parts (prt_*.json)
        └── <messageID>/
```

---

## Normalization & Data Extraction

The adapter (`hooks/adapters/opencode.mjs`) maps raw opencode records into canonical `NormalizedRecord` objects:

| Raw Source | Normalized Record Kind | Extracted Data |
|---|---|---|
| `session` row / `ses_*.json` | `session_meta` | `ai_title` (session title), `cwd` (`directory`), `version` (`1.0.201`, `1.18.30`) |
| `message` (`role: 'user'`) | `user_turn` | First user prompt, turn timestamp |
| `message` (`role: 'assistant'`) | `assistant_turn`, `tokens` | Model ID, finish reason, full token accounting (`input`, `output`, `cache_read`, `cache_create`) |
| `part` (`type: 'text'`) | `content_block` (`block_type: 'text'`) | Assistant prose (emits `words` / `chirp` pulses) |
| `part` (`type: 'reasoning'`) | `content_block` (`block_type: 'thinking'`) | Chain-of-thought tokens (emits `thinking` pulses) |
| `part` (`type: 'tool'`) | `tool_use`, `tool_result` | Tool name (`bash`, `read`, `write`, `edit`, `glob`, `grep`, `task`), inputs, and terminal status (`completed`, `error`) |

### Deduplication & Signal Rules

* **Authoritative Envelope Tokens:** Token totals live on the assistant message envelope. Intermediate `step-finish` and `step-start` parts repeat these numbers and are silenced to prevent double-counting.
* **Terminal Status Gate:** Tool parts emit only when `state.status === 'completed'` or `'error'`. Transient `running`/`pending` part updates are ignored so pulse counts equal post-hoc analysis counts.
* **Project Attribution:** Part and message records do not always embed the working directory directly. `opencodeSessionLabel` (cached in memory) dynamically resolves project identity via the session's info document or database row.

---

## Live Watch & Event Streaming

The server (`serve.mjs`) monitors the opencode root directory and streams live telemetry over Server-Sent Events (`GET /events`):

* **Watch Matcher:** Matches `opencode.db`, `opencode.db-wal`, and `(?:storage/)?{session,message,part}/*.json`.
* **Modes:**
  * `read_mode: 'sqlite'` — Triggered on database and WAL changes. Reads latest inserted/updated parts directly via zero-dependency `node:sqlite`.
  * `read_mode: 'json'` — Triggered on legacy JSON writes. Parses full document using signature-based deduplication (`size:mtime`).

### Five-Tier Timing Architecture

1. **Pulse SSE Stream (Instantaneous):** Emitted within $\approx$ 1 ms of disk write for real-time auditory feedback.
2. **Audio Beat Scheduler (80 ms / 120 BPM):** Flushes audio pulses in 80 ms batches snapped onto the nearest musical beat grid.
3. **Mission Control Snapshot ($\le$ 1 Hz):** Trailing-edge timer throttles `now` snapshot broadcasts to at most once per second.
4. **Graph Rebuild Debounce (1,500 ms):** A 1.5-second quiet window triggers incremental or full graph regeneration.
5. **Beat Overlay (60 FPS):** Visual canvas renders at the display refresh rate via `requestAnimationFrame` reading an in-place circular buffer (`window._beatRing`, cap 1,000).

---

## Context Tree Trace Reconstruction

Full conversation replay and context window analysis are available via:

```http
GET /api/trace/:sessionId
```

Where `:sessionId` can be the full UUID (e.g. `ses_f73642163ffeqZoQ6g2uXdFbQG`) or the 8-character slug prefix (`f7364216`).

`surface/trace-service.mjs` retrieves the session via `hooks/session-locators.mjs::locateOpencodeSession` from either SQLite or JSON storage, feeds it through `recordsToNormalized`, and reconstructs the multi-turn `ContextTree` (user turns, assistant turns, tool summaries, token accumulation, and thinking blocks).

---

## Test Coverage

* `test/opencode-adapter.test.mjs` — normalization unit tests, token accounting, tool mappings, version propagation
* `test/analyze-opencode.test.mjs` — JSON and SQLite reader tests, dual-layout scanner, canonical session reduction
* `test/opencode-helpers.test.mjs` — version markers (`OPENCODE_VERSION_MARKERS`), layout detection, project label resolution
* `test/session-resolver.test.mjs` — resolution of SQLite and JSON sessions by exact ID and 8-char slug prefix
* `test/watch-handlers.test.mjs` — file watcher pattern matching for `opencode.db`, `opencode.db-wal`, and storage paths
* `test/pulse-emitter.test.mjs` — `sqlite read_mode` pulse emission and project attribution
