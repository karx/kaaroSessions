# kaaroSessions — Rust port

TDD port of the Node/JS harness hop under `/workspace/kaaroSessions`. The browser
`experience/` UI stays JS; `serve` prefers JS-built HTML artifacts from the repo
root (or `--static-dir`), with minimal stubs when artifacts are missing.

## Workspace

| Crate | Status | Role |
|-------|--------|------|
| `crates/kaaro-core` | in progress | NR, **8/8 adapters**, scan, sessions-data, graph, pulse/watch |
| `crates/kaaro-cli` | in progress | `analyze` + `build` + `serve` |
| `crates/kaaro-surface` | in progress | axum JSON + SSE + rebuild orchestrator + static HTML stubs |

## Quick start

```bash
cd rust
cargo test
cargo run -p kaaro-cli -- analyze --help
cargo run -p kaaro-cli -- build --help
cargo run -p kaaro-cli -- serve --help
```

### Full flow (analyze → build → serve UI)

```bash
# From rust/ (cwd for default json paths), or pass absolute -o/-i/--graph-data
cd /workspace/kaaroSessions

# 1) Scan harness roots → sessions-data.json
cargo run --manifest-path rust/Cargo.toml -p kaaro-cli -- analyze \
  --claude-code-root ~/.claude/projects \
  -o sessions-data.json

# 2) Graph JSON (optional if serve --rebuild will do it)
cargo run --manifest-path rust/Cargo.toml -p kaaro-cli -- build \
  -i sessions-data.json -o graph-data.json

# 3) Serve APIs + static UI + watch pulse + debounced rebuild
cargo run --manifest-path rust/Cargo.toml -p kaaro-cli -- serve \
  --port 3333 \
  --sessions-data ./sessions-data.json \
  --graph-data ./graph-data.json \
  --static-dir . \
  --claude-code-root ~/.claude/projects

# Open the UI
#   http://127.0.0.1:3333/        (home.html → graph.html → stub)
#   http://127.0.0.1:3333/graph
#   http://127.0.0.1:3333/now
#   http://127.0.0.1:3333/daw
#   http://127.0.0.1:3333/mapping
#   http://127.0.0.1:3333/api/kind-map
#   http://127.0.0.1:3333/api/trace/<session_id>
```

Prefer JS-built pages after `node build.mjs` in the repo root (`graph.html`,
`now.html`, `home.html`, …). If missing, stubs load `/graph-data.json` /
`/api/active` so the surface still works.

### Serve flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--port` | `3333` | Listen port |
| `--bind` | `127.0.0.1` | Bind address |
| `--sessions-data` | `sessions-data.json` | Analyze output / rebuild write path |
| `--signals-data` | `signals-data.json` | Policy signals served at `/api/signals` |
| `--graph-data` | `graph-data.json` | Graph JSON served at `/graph-data.json` + rebuild write path |
| `--static-dir` | auto (`.`, `..`, `../..` if HTML present) | JS-built HTML artifacts |
| `--watch` / `--no-watch` | watch on | Poll harness roots → pulse |
| `--watch-debounce-ms` | `1500` | Debounce before pulse (also default rebuild debounce) |
| `--watch-poll-ms` | `500` | Poll interval |
| `--rebuild` / `--no-rebuild` | rebuild on | Startup + watch-triggered analyze→build |
| `--rebuild-debounce-ms` | = watch debounce | `schedule_rebuild` window |
| `--claude-code-root` / `--pi-root` / `--opencode-root` | home defaults | Watch + rebuild scan roots |

On JSONL/JSON change: pulse (`FileWatchService`) **and** `schedule_rebuild`
(targeted `--session=…` when the harness provides `rebuild_arg`, else
`--all-harnesses`). Incremental analyze merges that session into
`sessions-data.json` when possible. Watch also invalidates TraceService
resolve/mtime caches for the session. Overlapping rebuilds coalesce to one
follow-up. SSE: `status` / `updated` / `error`.

```bash
# pulse only, no rebuild
cargo run -p kaaro-cli -- serve --no-rebuild

# no filesystem watch
cargo run -p kaaro-cli -- serve --no-watch
```

### Build flags

- `--min-sessions N` — file node threshold (default 1)
- `--include-subagents` — subagent satellite nodes (default on)
- `--compact` — single-line JSON

## Harnesses (8/8)

| Id | Label | Default root / CLI flag |
|----|-------|-------------------------|
| `claude-code` | Claude Code | `~/.claude/projects` · `--claude-code-root` |
| `codex` | Codex | `~/.codex` · `--codex-root` |
| `pi` | Pi | `~/.pi/agent/sessions` · `--pi-root` |
| `antigravity` | Google Antigravity | `~/.gemini/antigravity/brain` · `--antigravity-root` |
| `grok` | Grok Build | `~/.grok/sessions` · `--grok-root` |
| `opencode` | opencode | `~/.local/share/opencode/storage` · `--opencode-root` |
| `copilot` | GitHub Copilot | VS Code `workspaceStorage` · `--copilot-root` |
| `command-code` | Command Code | `~/.commandcode/projects` · `--command-code-root` |

## Port status

- **Done:** analyze/build; surface JSON + SSE; active-state + pulse-emitter;
  poll file watch → pulse; **rebuild-orchestrator** (injectable runners);
  **static HTML** routes (prefer JS artifacts, else stubs);
  **`/api/kind-map`** + **`/api/trace/:session_id`** (mtime cache + CC subagent nesting);
  **policy / signal-evaluator** → `signals-data.json` + **`/api/signals`**;
  **incremental `--session=`** (CC) + watch→trace resolve-cache invalidation.
- **Harnesses (8/8):** `claude-code`, `codex`, `pi`, `antigravity`, `grok`,
  `opencode`, `copilot`, `command-code` — CLI root overrides for each.
- **Not yet (full port gaps):** targeted analyze `--session=` fast path
  (rebuild always full-scans today); HTML template
  injection in `build` (JS `build.mjs` still produces experience pages);
  no rewrite of `experience/` client JS.

## Live pulses + rebuild

`FileWatchService` polls harness roots (size/mtime), debounces, then
`process_watch_filename` → `PulseEmitter::tail_and_pulse` **and** (when enabled)
`Rebuilder::schedule_rebuild`. `/api/active` and SSE `tool_call` / `tokens` /
throttled `now` update live; `updated` fires after analyze→build.

## Endpoints (serve)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/status` | rebuild + clients + port |
| GET | `/api/harnesses` | registry public descriptors |
| GET | `/api/active` | Mission Control snapshot |
| GET | `/api/signals` | `signals-data.json` from analyze (empty payload if absent) |
| GET | `/api/kind-map` | golden baseline + live pulse overlay |
| GET | `/api/trace/:session_id` | ContextTree (mtime-cached; CC `subagent_tree` nesting) |
| GET | `/graph-data.json` | graph artifact |
| GET | `/events` | SSE |
| GET | `/` `/graph` `/now` `/daw` `/mapping` | static HTML / stubs |

## Next recommended slice

1. **Kind-map HTML** — inject `experience/kind-map-widget` into `/mapping` (or keep JS `build.mjs` artifacts)
2. **Docs / experience** — no rewrite of `experience/` client JS; HTML build injection still JS
3. **Optional** — deeper locator slug tests; other-harness incremental analyze if JS adds it

Full matrix: [PORT_STATUS.md](./PORT_STATUS.md).

