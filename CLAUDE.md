# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
node serve.mjs              # full pipeline: analyze + build + serve + watch (port 3333)
node serve.mjs --port=3334  # alternate port
node serve.mjs --no-open    # skip auto browser open
node analyze.mjs            # scan ~/.claude/projects/ → sessions-data.json
node build.mjs              # sessions-data.json → graph.html + graph-data.json
node build.mjs --min-sessions=3  # hide file nodes appearing in fewer than N sessions (default: 1)
```

**Tests** (Node.js built-in test runner, no install needed):
```bash
node --test                          # run all tests
node --test test/build.test.mjs      # single file
node --test test/graph-pipeline.test.mjs test/schema.test.mjs  # multiple files
```

No `npm install` needed — zero external dependencies. D3 v7 and 3d-force-graph are loaded from CDN inside the generated HTML.

**HTTP endpoints** (routes in `surface/http-routes.mjs`, composed by `serve.mjs`):
- `GET /` (or `/home`) — **landing page** (`home.html` built artifact): Register A boot ritual + three view tiles (graph/now/daw) with live stats and `g`/`n`/`d` shortcuts, plus a dim contribute strip to `/mapping` (`m`). Falls back to the graph until built.
- `GET /graph` (or legacy `/graph.html`) — the **history view** `graph.html` (no-cache)
- `GET /daw` (or `/builder`, `/audio`) — dedicated **Live Pulse DAW Builder** page (pure event stream, no graph). Full sonic axis mapping, simulator, timbre lab, rule-based audio profiles per event type, session legend with context-pressure bars. Works only when served (needs /events).
- `GET /now` (or `/mission`, `/active`) — **Mission Control** (`now.html` built artifact, Register A): per-harness rollup with capability badges, expandable session cards (recent-actions feed, live context-pressure from `last_tokens`, on-demand proportional ContextTree strip, thinking/attachment/scaffold chips, mode/permission chips, api-error line; compact invalidates trace cache).
- `GET /mapping` (or `/kind-map`) — **Kind Map** (generated HTML): harness × RECORD_KIND coverage grid (disposition on the kind stub; `content_block` / `tool_result` expand to pulseDisposition routes) + tool-key × raw names + **unknown bucket** (distinct `unknown` holes with counts; copy JSON for a maintainer). Harnesses whose root exists on this machine **and** have local sessions (or a live pulse) get a `LOCAL` tag. Cells: proved / live / n/a (capability off) / hole. Baseline = goldens + samples; overlay = live `/events` pulses with `nr_kind`. `GET /api/kind-map` JSON includes `unknowns[]`; `GET /mapping?partial=1` snippet. See `RFC-kind-map.md`.
- `GET /events` — SSE stream; lifecycle events (`status`, `updated`, `error`), live pulse events (`tool_call`, `tokens`, `words`, `human_turn`, `compact`, `permission`, `mode_shift`, `tool_error`, `api_error`, `chirp`, `thinking`, …), plus throttled `now` snapshots (≤1/s)
- `GET /api/active` — Mission Control snapshot from `surface/active-state.mjs` (`{ generated_at, sessions[] (incl. recent_actions ring), by_harness, totals }`)
- `GET /api/harnesses` — registry descriptors `{ id, label, capabilities }` — the experience layer's capability source
- `GET /api/signals` — policy signals payload from `signals-data.json` (`{ generated_at, total_signals, by_level, by_rule, signals[] }`); empty payload when no policy configured. Policy: `hooks/policy.mjs` loads/merges `.agents/policy.json` (project, prepends) + `~/.agents/policy.json` (global); `hooks/signal-evaluator.mjs` evaluates session-scoped predicates (`skill`, `tool`, `tools.contains` [needs companion `skill` + `skill_attribution`], `tool_errors.gt`, `cache_hit_rate.lt`, `duration_min.gt`, `project`, `compact_count.gt`), first match wins, unsupported predicates → visible INFO diagnostic (deduped per rule in `buildSignalsData`). Signals only — auditor, never gatekeeper. `analyze.mjs` writes `signals-data.json` (gitignored) on every run.
- `GET /graph-data.json` — current graph payload for incremental updates
- `GET /status` — JSON `{ rebuilding, lastBuilt, clients, port }` (debug)
- `GET /api/trace/:session_id` — context tree via `surface/trace-service.mjs` (mtime-cached; all harnesses except antigravity)

## Architecture

### Two-layer separation of concern

```
┌─ NORMALIZATION FLOW (backend, per-harness hooks) ──────────────┐
│  hooks/      adapters, analyzers, registry, NormalizedRecord   │
│              contract, reducer — raw transcripts → normalized  │
│              stream (pulses) + bundle (sessions snapshot)      │
│  surface/    exposure of that normalized product:              │
│              Snapshot (HTTP) + Stream (SSE)                    │
└────────────────────────── boundary = Observability Surface ────┘
┌─ COGNITIVE EXPERIENCE LAYER (UI) ──────────────────────────────┐
│  experience/ history view (graph) · live view (Mission         │
│              Control) · sonic view (DAW) — consume ONLY the    │
│              surface (HTTP + SSE), capability-driven           │
└─────────────────────────────────────────────────────────────────┘
```

The experience layer must never reach into harness specifics — it consumes the
Observability Surface (HTTP endpoints + SSE events) only. Root `analyze.mjs`,
`build.mjs`, `serve.mjs` are thin CLI/composition entries.

Repository layout:
- `hooks/` — registry.mjs (THE single source of truth: adapter, scan, locateSession, readSessionRecords, capabilities per harness; `HARNESS_IDS` = `claude-code, codex, pi, antigravity, grok, opencode, copilot, command-code`), normalized-record.mjs (NR contract), action-keys.mjs, session-reducer.mjs, enrich-session.mjs, sessions-schema.mjs, pulse-transformer.mjs, trace-tree.mjs, jsonl-io.mjs, jsonl-tail.mjs, scan-walk.mjs, session-locators.mjs, harness-paths.mjs; `hooks/adapters/` (one per harness), `hooks/analyzers/` (analyze-codex/-pi/-antigravity/-grok/-opencode/-copilot/-command-code), `hooks/helpers/` (analyze/grok/copilot/antigravity helpers)
- `surface/` — http-routes.mjs, sse-hub.mjs, pulse-emitter.mjs, rebuild-orchestrator.mjs, trace-service.mjs, active-state.mjs, session-resolver.mjs, watch-handlers.mjs, scan-harnesses.mjs, analyze-orchestrator.mjs (all tested; serve.mjs only composes)
- `experience/` — client-core.mjs (shared browser helpers, Node-tested, injected as `%%CLIENT_CORE%%`), design-tokens.mjs (Register A `--k-*` tokens, injected as `%%TOKENS_CSS%%` + `KAARO_TOKENS`), `client/` (21 numbered browser modules: `00-boot`, `00-core` placeholder, `01`–`19`), `pages/` (template.html, now.html, daw-template.html, home.html, og-image.svg), `audio/` (event-registry, audio-sim, audio-presets, beat-clock, ticker-store), graph-pipeline.mjs, graph-data.mjs, session-clusters.mjs

**Adding a harness**: see the checklist at the top of `hooks/registry.mjs` — one adapter, one analyzer (using `hooks/scan-walk.mjs`), one registry descriptor, tests (golden + `test/adapters/nr-compliance.test.mjs` entry). Nothing else changes.

### Build pipeline

Four-stage pipeline, each stage independently testable:

```
~/.claude/projects/**/*.jsonl   (+ other harness roots)
        ↓ analyze.mjs
  sessions-data.json                    (intermediate — gitignored)
        ↓ experience/graph-pipeline.mjs (pure data transform)
  { nodes, edges, timeline }
        ↓ build.mjs                     (thin orchestrator: I/O + template injection)
  experience/pages/*.html + experience/client/*.js + client-core + design tokens
        ↓
  graph.html · daw-builder.html · now.html · home.html   (built artifacts — gitignored)
  graph-data.json                       (SSE incremental update payload — gitignored)
```

Every page artifact receives `%%TOKENS_CSS%%` (Register A `--k-*` block) and the
shared client core (`%%CLIENT_CORE%%`, export-stripped from
`experience/client-core.mjs`); the graph bundle additionally gets graph data and
`%%TRACE_HARNESSES%%` from the registry. `graph.html` stays a single
self-contained file.

**`serve.mjs`** owns the runtime: runs `analyze.mjs` then `build.mjs` as child processes via `execFile`, watches `~/.claude/projects/` for `.jsonl` changes (1500 ms debounce), and pushes `event: updated` over SSE so the browser calls `window.updateGraph(newData)` without a full reload. Also tails new JSONL bytes on every change and emits live pulse SSE events. Also watches `PI_SESSIONS_ROOT` if present.

**`analyze.mjs`** walks every `~/.claude/projects/<projectId>/*.jsonl` file (one JSONL = one session). Extracts token usage, tool calls, file ops (Read/Write/Edit with paths), bash categories, skills (from `<command-name>` tags), first user message, git branch, and model. Also extracts: `context_resets` (compact_boundary count), `ai_title` (from `<ai-title>` tags), `subagent_count` (Agent tool_use count), `branches[]` (all git branches seen). Outputs `sessions` array + `rollup` object (global aggregates). Skills from `BUILTIN_COMMANDS` are stored under `builtin_commands`, not `skills`.

**`hooks/analyzers/analyze-codex.mjs`** — Codex harness adapter. Reads dated rollout JSONL under `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (`~/.codex` default); titles from a sibling `session_index.jsonl`. Real local CLI emits tool name `shell_command` (bash-aliased in `hooks/action-keys.mjs`; `exec_command` kept as a legacy alias). File edits arrive as a separate `custom_tool_call`/`custom_tool_call_output` pair (`apply_patch`), not `function_call` — its diff-DSL `input` is parsed into `input.paths[]` so `session-reducer.mjs`'s `file_ops` can credit every file a multi-file patch touched without inflating the tool-call count. `event_msg`'s `agent_message`/`user_message`/`agent_reasoning` duplicate `response_item`'s message/reasoning content (verified byte-identical) and are intentionally left unhandled — only `response_item` is read for turn content. Tokens are output-only — `last_token_usage.input_tokens`/`cached_input_tokens` report the whole context window as of that turn, not a per-turn delta, so they're excluded from the normalized token object (see `docs/CODEX.md#token-handling`). `trace: true`, `branches: true`, but `context_resets`/`subagent_count` not extracted; no `unknown_record` catch-all yet.

**`hooks/analyzers/analyze-pi.mjs`** — Pi harness adapter. Same output shape as `analyze.mjs` for Pi session files. **Does not yet extract** `context_resets`, `ai_title`, `subagent_count`, or `branches` — these are CC-only for now.

**`hooks/analyzers/analyze-grok.mjs`** — Grok Build Harness Hook. Reads `~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/updates.jsonl` plus a sibling `summary.json` (title, head branch). Tokenless (`size_proxy: 'tool_calls'`) but otherwise full-featured: `context_resets`, `ai_title`, `subagent_count`, `branches` all populated. Streaming chunks dedup on `_meta.turnStartMs` when present; falls back to an `emittedAssistantSinceLastUser` guard so one response burst yields exactly one `assistant_turn`.

**`hooks/analyzers/analyze-antigravity.mjs`** — Google Antigravity Harness Hook. Reads `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/` — `transcript.jsonl` when present (active sessions), else the compact `overview.txt`. No project_id (always `null`) and tokenless (`size_proxy: 'tool_calls'`); `trace: false` in the registry because its NRs carry no assistant text/thinking blocks, so reconstructed turns would be tool-lists only.

**`hooks/analyzers/analyze-opencode.mjs`** — opencode Harness Hook. Reads `~/.local/share/opencode/storage/{session,message,part}/` JSON trees; assembles info + messages (chronological) with parts embedded as `_parts`; adapter in `hooks/adapters/opencode.mjs`. Watch uses `read_mode: 'json'` (whole-file JSON parse, not JSONL tail). Tool parts emit only on `completed`/`error` status; `step-finish` tokens silenced (message envelope is authoritative).

**`hooks/analyzers/analyze-copilot.mjs`** — GitHub Copilot (VS Code) Harness Hook. Scans per-workspace `chatSessions/*.jsonl` op-logs (kind 0=snapshot, 1=set, 2=append) + old `*.json` dumps; project attribution from `workspace.json`; optional title enrichment from `state.vscdb` SQLite (`readChatSessionIndex`, zero-dep via `node:sqlite`, graceful `{}` fallback). Adapter in `hooks/adapters/copilot.mjs`; pure URI/tool helpers in `hooks/helpers/copilot-helpers.mjs`. Tokens are output-only (`completionTokens`).

**`hooks/analyzers/analyze-command-code.mjs`** — Command Code harness adapter. Reads `~/.commandcode/projects/<project>/<session>.jsonl` (one file per session; records carry `role` user/assistant/tool, content blocks with `text`/`reasoning`/`tool-call`/`tool-result`, and `gitBranch` on every record). Titles come from sibling `.meta.json` files; `.checkpoints.jsonl` files are skipped by the scanner. Tokenless (`size_proxy: 'tool_calls'`); `trace: true`, `branches: true`, but `context_resets`/`subagent_count` not extracted.

**`surface/active-state.mjs`** — Mission Control core. Pure live per-session activity store fed by pulse objects: `createActiveState()`, `applyPulse(state, pulse, now)`, `snapshotActive(state, now)` (active/idle status, burn rate over 60s window, per-harness rollups, eviction). No `Date.now()` inside — caller supplies `now`.

**`experience/graph-data.mjs`** — pure functions with no I/O: `calcRecencyScore`, `calcRecencyLevel`, `assignProjectColors`, `buildFileNodesAndEdges`, `isSessionInFlight`, `filterSessionsByDateRange`. Re-exported from `build.mjs` for backward-compat test imports.

**`experience/graph-pipeline.mjs`** — exports `buildGraph(data, opts)`. Pure transform: takes a parsed `sessions-data.json` object, returns `{ nodes, edges, timeline, stats, PROJECT_COLORS, COLOR_TO_INDEX }`. Session nodes include `context_resets`, `ai_title`, `subagent_count`, `branches`, `tools_top` (top-10 tools by call count), and `cluster_id` (null when unbundled). Project and session `sizeNorm` both scale by overall consumption (`tokens_total`; `tool_calls` fallback when total is 0). Also emits `type:'cluster'` bundle nodes (aggregate telemetry, own-scale sizeNorm) with a cluster→project `membership` edge and member→cluster `bundle` edges. No file I/O; fully unit-testable.

**`experience/session-clusters.mjs`** — deterministic per-project session clustering for the graph view. Weighted Jaccard similarity (0.7 shared file sets + 0.3 text tokens from `ai_title`/`first_user_message`/`skills`; pure text when both file sets are empty), single-linkage union-find, threshold 0.35, min cluster size 2. Cluster ids anchor on the earliest member: `cluster:<project_id>:<session_id>` (stable as later members join). `buildClusters(sessions, overrides)` applies **`cluster-overrides.json`** (repo root, checked in, hand-edited — the pipeline's only user-editable config): `pin` excludes sessions from clustering, `assign` groups sessions into manual clusters by name (`cluster:<pid>:manual:<slug>`), `labels` renames clusters by id. `build.mjs loadClusterOverrides()` reads it with graceful fallback (absent/malformed → warn + null, build never fails). In the browser, bundles render collapsed by default (`#cb-bundle` checkbox disables the feature); expansion state lives in localStorage `kaaro-expanded-clusters`; clusters affect the force layout only.

**`hooks/sessions-schema.mjs`** — canonical contract for `sessions-data.json`. `validateSessionsData()` returns `{ ok, errors[] }`. Any new adapter (Pi, opencode, Copilot) must produce data satisfying this schema. Optional fields are enumerated in `OPTIONAL_SESSION_FIELDS` — graph builder consumes them when present, skips when absent.

**`hooks/pulse-transformer.mjs`** — converts `NormalizedRecord[]` (adapter output) into typed pulse objects for `resolveSonic`. Every NR emits ≥1 pulse. Disposition lives in `hooks/pulse-map.mjs` (sonic / `silent` / `unknown`); `unknown` is a coverage hole only. Key derivation (`read`/`bash_git`/…) from `nr.tool + nr.category` happens here via `toolNameToKey` — adapters are sonic-unaware. Replaces the archived `lib/pulse-adapters.mjs`.

**`hooks/jsonl-tail.mjs`** — reads only new bytes from a JSONL file given a byte offset. Returns `{ records[], newOffset }`. Used by `serve.mjs` to tail active sessions without re-parsing the whole file.

**`hooks/trace-tree.mjs`** — unified, pure ContextTree reconstruction from NormalizedRecords (any harness). `reconstructTraceFromNRs(nrs, opts)` returns `{ ai_title, segments[] }`. Each segment spans between `context_reset` NRs and tracks: user/assistant turns, tool call counts by name, subagent count, thinking count, permission modes, branches, and tokens. `surface/trace-service.mjs` feeds it (registry `readSessionRecords` → adapter → tree, mtime-cached) for the `/api/trace/:session_id` endpoint. Trace-capable today: claude-code, grok, pi, opencode, copilot (antigravity excluded — no assistant text in its NRs).

**`experience/audio/beat-clock.mjs`** — pure BPM math: `bpmToInterval`, `beatPosition`, `eventsInWindow`, `pushBeatEvent`. No I/O, no AudioContext.

**`experience/audio/ticker-store.mjs`** — pure immutable store for the pulse ticker: `createStore`, `addEntry`, `toggleSticky`, `clearEntries`. No DOM.


**`build.mjs`** is a thin orchestrator: reads `sessions-data.json`, calls `buildGraph`, concatenates `experience/client/01-*.js` in numeric order, then calls `applySubstitutions()` to inject JSON into the template. `applySubstitutions(template, subs)` is a single-pass regex replace — the callback form prevents injected data from matching a subsequent `%%PLACEHOLDER%%` and prevents `$&`/`$1` backreference corruption.

**`experience/pages/template.html`** — HTML skeleton with `%%PLACEHOLDER%%` markers. `%%CLIENT_JS%%` receives the concatenated + data-injected browser JS. `%%MIN_FILE_SESSIONS%%` sets the range slider default.

**`experience/client/`** — browser JS split into 21 numbered modules, concatenated in order by `build.mjs`. `01-data.js` receives injected data (`%%GRAPH_JSON%%`, `%%TIMELINE_JSON%%`, `%%COLOR_INDEX_JSON%%`, `%%IN_FLIGHT_COLOR%%`) and defines global `GRAPH`, `TIMELINE`, `W`, `H`. Key constants: `TL_H = 154` (total bottom chrome height; graph canvas avoids this), `TIMELINE_H = 60` (height of `#timeline` strip; draw coordinates inside it). These two constants serve different purposes — do not conflate.

Layout modules and their responsibilities:
- `06-force-layout.js` — D3 force simulation
- `07-swimlane.js` — Gantt-style bars; branch sub-rows; 8 configurable axes
- `08-arc.js` — temporal coupling map; file co-access arcs; hub list
- `09-matrix.js` — file × session co-occurrence matrix
- `10-3d.js` — 3d-force-graph integration
- `11-layout-manager.js` — switches between layouts, manages active controls panel

Live and audio modules:
- `13-live-updates.js` — SSE client; consumes `updated/status/tool_call/tokens/words` events; calls `window.playPulse(event, data)` and `window.updateGraph(newData)`
- `14-pulse-audio.js` — beat ring buffer (`window._beatRing`, cap 1000, mutate in-place), instrument synthesis, BPM scheduler with 80ms batch coalescing
- `15-audio-settings.js` — audio settings panel DOM; reads/writes `window.AUDIO_SETTINGS` to localStorage
- `16-beat-overlay.js` — DAW Feed Widget; 80px canvas, LIVE/SCROLL mode, block-per-event rendering, hover → graph highlight
- `17-trace-panel.js` — Context Window Trace Panel; a session's context windows (segments between `compact_boundary` events) as proportional strips (width = token weight, color = dominant tool category, badges for subagent/branch/thinking)
- `18-thread-view.js` — Thread View full-screen overlay; full conversation replay per context window (stacked composition bar + every turn with tool inputs). Entry `window.openThread(sessionId)`, exit Escape/✕
- `19-daw-builder.js` — Cognitive DAW Builder v2; multi-lane canvas, mixer strips, automation curves. Only activates when `#daw-root` is present (the dedicated `/daw` page — this file loads harmlessly on the graph page too)

`00-core.js` is a placeholder module (kept for numbering/ordering); `00-boot.js` defines `window.bootComplete()`, called once at the end of `13-live-updates.js` init to swap the boot overlay for the live stats readout.

**Live SSE pulse events** (emitted by `serve.mjs`, consumed by `13-live-updates.js`):
- `tool_call` — `{ slug, project, tool, where, why, category, ts }` — every tool_use block seen in new JSONL bytes
- `tokens` — `{ slug, project, input, output, cache_create, cache_read, ts }` — every usage record
- `words` — `{ slug, project, preview, word_count, ts }` — assistant text blocks (≥3 words)
- `status` — `"rebuilding"` — pipeline started
- `updated` — ISO timestamp — pipeline complete, client should fetch `/graph-data.json`

`slug` in pulse events = `session_id.slice(0, 8)` (UUID prefix, NOT the human-readable slug). Session node IDs are full UUIDs. To match: `node.id.startsWith(ev.slug)`. `node.label` is the human-readable slug — do NOT compare against `ev.slug`.

**Beat ring mutability contract**: `window._beatRing` is initialised once by `14-pulse-audio.js` and referenced by `16-beat-overlay.js`. The array must be mutated in-place (`push` / `shift`) — never reassigned. Reassignment breaks the shared reference.

**File path normalisation**: JSONL `file_path` fields on Windows contain backslashes. Graph file node IDs use forward slashes (normalised by `analyze.mjs`). When matching `ev.where` against a file node ID: `.replace(/\\/g, '/')`.

**Node sizing**: session nodes scale by `√(tokens_work / MAX_WORK)` where `tokens_work = output + cache_create`. File nodes scale by `√((write + edit) / MAX_FILE_W)`.

**Project ID format**: Claude Code names dirs as path-derived slugs, e.g. `D--src-kaaroViewer`. `deriveLabel()` in `analyze.mjs` strips the drive/path prefix to get the short label.

## Test conventions

Tests use `node:test` + `node:assert/strict`. Each test file targets one module. Fixtures are inline factory functions (`makeData()`, `makeFile()`, `makeSess()`). TDD is the expected workflow — write failing tests before implementing.

Test files map to modules:
- `test/analyze.test.mjs` → `analyze.mjs` (core extraction)
- `test/analyze-bash-jsonl.test.mjs` → `analyze.mjs` (bash categorisation)
- `test/analyze-session-ops.test.mjs` → `analyze.mjs` (file ops)
- `test/analyze-session-tokens.test.mjs` → `analyze.mjs` (token accounting)
- `test/analyze-timeline.test.mjs` → `analyze.mjs` (date/timeline fields)
- `test/analyze-session-metadata.test.mjs` → `analyze.mjs` (context_resets, ai_title, subagent_count, branches)
- `test/analyze-codex.test.mjs` → `hooks/analyzers/analyze-codex.mjs`
- `test/analyze-pi.test.mjs` → `hooks/analyzers/analyze-pi.mjs`
- `test/analyze-grok.test.mjs` → `hooks/analyzers/analyze-grok.mjs`
- `test/analyze-antigravity.test.mjs` → `hooks/analyzers/analyze-antigravity.mjs`
- `test/analyze-orchestrator.test.mjs` → `surface/analyze-orchestrator.mjs` (merges per-harness scan results into `sessions-data.json` shape)
- `test/session-reducer.test.mjs` → `hooks/session-reducer.mjs` (NormalizedRecord[] → canonical session object)
- `test/session-resolver.test.mjs` → `surface/session-resolver.mjs`
- `test/watch-handlers.test.mjs` → `surface/watch-handlers.mjs` (`processWatchFilename` per harness)
- `test/enrich-session.test.mjs` → `hooks/enrich-session.mjs` (derived fields: totals, cache_hit_rate, duration_min, tool_diversity)
- `test/harness-registry.test.mjs` → `hooks/registry.mjs`
- `test/event-registry.test.mjs` → `experience/audio/event-registry.mjs`
- `test/build.test.mjs` → `build.mjs`
- `test/build-template.test.mjs` → `build.mjs` (template substitution)
- `test/build-live.test.mjs` → `build.mjs` (live update path)
- `test/build-features.test.mjs` → `build.mjs` / `experience/graph-data.mjs`
- `test/graph-pipeline.test.mjs` → `experience/graph-pipeline.mjs`
- `test/session-clusters.test.mjs` → `experience/session-clusters.mjs` (similarity, clustering, overrides merge)
- `test/schema.test.mjs` → `hooks/sessions-schema.mjs`
- `test/pulse-transformer.test.mjs` → `hooks/pulse-transformer.mjs`
- `test/jsonl-tail.test.mjs` → `hooks/jsonl-tail.mjs`
- `test/trace-tree.test.mjs` → `hooks/trace-tree.mjs` (parity vs archived per-harness oracles + all-harness sanity)
- `test/trace-service.test.mjs` → `surface/trace-service.mjs` (per-harness /api/trace smokes, mtime cache)
- `test/beat-clock.test.mjs` → `experience/audio/beat-clock.mjs`
- `test/ticker-store.test.mjs` → `experience/audio/ticker-store.mjs`
- `test/audio-sim.test.mjs` → `experience/audio/audio-sim.mjs` + `experience/audio/audio-presets.mjs` (resolveSonic, resolveHz, simulateSession, all 3 presets; Grok tool aliases; web key)
- `test/grok-helpers.test.mjs` → `hooks/helpers/grok-helpers.mjs` (grokToolWhere path extraction, grokRecordTs, grokSessionUpdate)
- `test/active-state.test.mjs` → `surface/active-state.mjs` (Mission Control store: pulses, burn rate, status, rollups)
- `test/opencode-adapter.test.mjs` → `hooks/adapters/opencode.mjs` (+ toolNameToKey opencode/task aliases)
- `test/analyze-opencode.test.mjs` → `hooks/analyzers/analyze-opencode.mjs` (read/analyze/scan over temp storage tree)
- `test/copilot-adapter.test.mjs` → `hooks/adapters/copilot.mjs` + `hooks/helpers/copilot-helpers.mjs` (op-log mapping, URI decode, aliases)
- `test/analyze-copilot.test.mjs` → `hooks/analyzers/analyze-copilot.mjs` (workspace attribution, both formats, real SQLite index fixture)
- `test/adapters/nr-compliance.test.mjs` → all eight adapters vs the NR contract (sample traces + golden sessions) — the harness-format-change guard
- `test/adapters/{claude-code,codex,pi,grok,antigravity}.test.mjs` → per-adapter golden fixtures (opencode/copilot/command-code adapters are covered by their own `test/<name>-adapter.test.mjs` instead)
- `test/normalized-record.test.mjs` → `hooks/normalized-record.mjs` (KIND_FIELDS, validateNormalizedRecord)
- `test/harness-parity.test.mjs` → sample traces + capability-enforced field parity (registry flags ARE the matrix)
- `test/scan-walk.test.mjs` / `test/jsonl-io.test.mjs` → the shared scanner skeleton + JSONL reader
- `test/sse-hub.test.mjs` / `test/pulse-emitter.test.mjs` / `test/rebuild-orchestrator.test.mjs` / `test/http-routes.test.mjs` → the decomposed serve runtime (ephemeral ports, no child processes)
- `test/client-core.test.mjs` → `experience/client-core.mjs` (formatters, colors, geometry, SSE wiring, filters, force profiles, DAW legend)
- `test/design-tokens.test.mjs` / `test/design-lint.test.mjs` → Register A tokens + the grammar guard (no blue chrome, no shadows/gradients/large radii)

## Known coverage gaps

- **`serve.mjs`** — only the thin composition root + registry watch loop remain untested; HTTP routes, SSE hub, pulse emission, and rebuild orchestration are tested in `surface/` (`http-routes`, `sse-hub`, `pulse-emitter`, `rebuild-orchestrator` test files)
- **`experience/client/*.js`** — browser JS; pure logic (e.g. `blockGeom`, `_toolBars`) testable but not yet extracted
- **Pi optional fields** — `context_resets`, `ai_title`, `subagent_count`, `branches` are data-absent in Pi's raw format (verified 2026-07-19: only `session`/`model_change`/`thinking_level_change`/`message` record types exist); not extractable, registry capabilities `false` are correct
- **`unknown_record` catch-all** — codex and command-code adapters silently drop raw record types they don't recognize instead of emitting `unknown_record`, unlike the other six adapters; kind-map coverage holes for these two harnesses won't surface until this is added
