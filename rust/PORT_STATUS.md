# kaaroSessions Rust port — status

Snapshot of what lives under `rust/` vs what remains JS-owned.
Test suite at last update: **270** green.

## Ported (Rust)

| Area | Notes |
|------|--------|
| **8/8 harness adapters** | claude-code, codex, pi, antigravity, grok, opencode, copilot, command-code |
| **CLI** | `analyze`, `build`, `serve` (`kaaro-sessions`) |
| **Analyze** | Full scan + **incremental `--session=project/session`** (CC merge into existing `sessions-data.json`) |
| **Build** | `graph-data.json` only (no HTML template injection) |
| **Surface HTTP** | `/status`, `/api/harnesses`, `/api/active`, `/api/signals`, `/api/kind-map`, `/api/trace/:id`, `/graph-data.json`, `/events` (SSE) |
| **Live path** | Poll watch → pulse → active-state; debounced rebuild (targeted when `rebuild_arg` present) |
| **Kind-map** | JSON baseline (goldens) + live pulse overlay |
| **Trace** | ContextTree + **CC subagent nesting** (`subagent_tree`); mtime cache; **resolve-cache invalidation on watch** |
| **Policy / signals** | Load/merge policy → evaluate → `signals-data.json` → `/api/signals` |
| **Static UI** | Prefer JS-built HTML artifacts; minimal stubs if missing |

## Still JS-owned (intentional)

| Area | Why |
|------|-----|
| **`experience/` client** | Browser UI (graph, now, DAW, widgets) — not rewritten |
| **HTML build injection** | `build.mjs` still produces `graph.html` / `now.html` / etc. |
| **Kind-map widget HTML** | `/mapping` serves stub or JS artifact; no Rust renderer for `kind-map-widget` |
| **Copilot SQLite title index** | Skipped in Rust scan (titles from transcript / workspace.json only) |
| **Other harness incremental analyze** | Fast path is **claude-code only** (same as JS `analyze.mjs`) |

## Residual polish / future

- Deeper locator slug/prefix parity tests across all harnesses
- Pi / other harnesses incremental `--session=` if/when JS adds them
- Optional: embed kind-map HTML snippet without pulling `experience/`

## How to verify

```bash
cd rust && cargo test --workspace
cargo run -p kaaro-cli -- analyze --session=PROJECT/SESSION_ID -o sessions-data.json
cargo run -p kaaro-cli -- serve --port 3333
```
