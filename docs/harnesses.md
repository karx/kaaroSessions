# Harness Support Matrix

This is the living compatibility / support page for kaaroSessions multi-harness pipeline.

It is intended to be **self-growing**: when adding or discovering differences for a harness, update this table and the related code/docs.

## Overview

| Harness       | ID            | Root (default)                  | Tokens | Pulse (live) | Trace (/api/trace) | Notes / Quirks |
|---------------|---------------|---------------------------------|--------|--------------|--------------------|---------------|
| Claude Code   | `claude-code` | `~/.claude/projects/`           | Yes    | Yes          | Yes                | Full optional fields (context_resets, ai_title, subagent_count, branches). `turn_duration` provides authoritative `message_count`, `slug`, `duration_ms`. |
| Codex         | `codex`       | `$CODEX_HOME` or `~/.codex/`    | Partial | Yes         | Yes                | Dated rollout JSONL under `sessions/YYYY/MM/DD/`. Thread titles from `session_index.jsonl`; project attribution from `session_meta.cwd`; tool calls/results from `response_item` function calls. Real CLI tool name is `shell_command` (bash-aliased); `exec_command` kept as a legacy alias. Tokens = output only — `last_token_usage.input_tokens`/`cached_input_tokens` are the whole context window as of that turn, not a per-turn delta, so summing them across turns would explode; see [CODEX.md](./CODEX.md#token-handling). Watches active rollout files live. See [CODEX.md](./CODEX.md). |
| Pi            | `pi`          | (via `PI_SESSIONS_ROOT`)        | Yes    | Yes          | No                 | Optionals declared `false` in registry are data-absent in Pi's raw format (only `session`/`model_change`/`thinking_level_change`/`message` record types exist — verified 2026-07-19). `thinking_level_change` maps to a `mode_shift` NR. Usage may be absent on some messages (guarded). |
| Antigravity   | `antigravity` | `~/.gemini/antigravity/brain/`  | No     | Yes          | No                 | Tokenless (size_proxy = tool_calls). No project_id (always null). Uses `transcript.jsonl` (preferred) or `overview.txt`. |
| Grok          | `grok`        | (via `GROK_SESSIONS_ROOT`)      | No     | Yes          | Yes                | Tokenless (size_proxy = tool_calls). Streaming chunks: dedup on `turnStartMs` when present; content blocks for text handled separately. Rich meta from summary/signals. |
| opencode      | `opencode`    | `~/.local/share/opencode/` | Yes | Yes          | Yes                | Dual layout support: v1.0.x JSON trees (`storage/{session,message,part}`) and v1.18.x+ SQLite database (`opencode.db`). Watch supports `read_mode: 'json'` and `read_mode: 'sqlite'`. Full token accounting (incl. cache read/write). Tool parts emit on completed/error. Step-finish silenced. Project id derived from `directory` path. Full `/api/trace` reconstruction. See [OPENCODE.md](./OPENCODE.md). |
| GitHub Copilot | `copilot`    | VS Code `workspaceStorage/` (per-OS) | Partial | Yes      | No                 | Per-workspace `chatSessions/<uuid>.jsonl` op-log (kind 0=snapshot, 1=set, 2=append) — live-tailable; old `<uuid>.json` dumps analysis-only. Tokens = `completionTokens` output only (no input/cache). Tool calls = `toolInvocationSerialized` (toolId, file URIs) + `textEditGroup` (agent-mode edits). UI-state set-ops (inputState/modelState/result) silenced. Project attribution from `workspace.json` folder URI. Optional title/lastMessage enrichment from `state.vscdb` SQLite via `node:sqlite` (graceful `{}` fallback). |
| Command Code  | `command-code` | `~/.commandcode/projects/`       | No     | Yes          | Yes                | JSONL format (one file per session): records have `role` (user/assistant/tool), content blocks with `text`/`reasoning`/`tool-call`/`tool-result`, `gitBranch` on every record. Tokenless (size_proxy = tool_calls). Titles from sibling `.meta.json` files. Project IDs use `users-<username>-<path>` convention. Checkpoint files (`.checkpoints.jsonl`) skipped by scanner. |

## Optional Session Fields by Harness

See `hooks/sessions-schema.mjs` OPTIONAL_SESSION_FIELDS for the full list.

Populated (✓) / absent or partial (—) as of latest:

- `context_resets`, `ai_title`, `subagent_count`, `branches`: ✓ for claude-code + grok; — for pi + antigravity. Codex: `ai_title` ✓ (`session_index.jsonl`) and `branches` ✓ when git metadata is present, `context_resets`/`subagent_count` —. opencode: `ai_title` ✓ (session info `title`), others —. copilot: `ai_title` ✓ (customTitle op or SQLite index), others —. command-code: `ai_title` ✓ (`.meta.json`) and `branches` ✓, `context_resets`/`subagent_count` —.
- `message_count`: Authoritative from harness metadata when available (CC `turn_duration`); derived as `user_turns + assistant_turns` fallback for others.
- `content_blocks` / `thinking_count`: Populated via `content_block` normalized records (CC/Grok). Used for UI dots and panels.

## Harness-Specific Guides

- [Codex harness](./CODEX.md) — local rollout layout, title index, output-token
  handling, live watch behavior, trace support, and test entry points.
- [Opencode harness](./OPENCODE.md) — dual storage architecture (v1.0.x JSON trees + v1.18.x SQLite `opencode.db`),
  live watch modes, version support markers, and `/api/trace` ContextTree reconstruction.

## Normalized Record Kinds (common vocabulary)

All adapters emit from this small set (the "harness hop"), defined in `hooks/normalized-record.mjs`:

- `user_turn`
- `assistant_turn` (exactly one per conversational assistant response)
- `content_block` (per-block telemetry inside an assistant turn; does **not** increment turn counts)
- `tool_use`, `tool_result`
- `tokens`
- `context_reset`
- `session_meta`
- `branch_change`
- `skill_invoke`
- `permission_mode`, `mode_shift`, `attachment`, `scaffold`, `api_error`, `unknown_record`

See `hooks/adapters/*.mjs` + `hooks/session-reducer.mjs` and the Architecture Note in `analyze-intelligence.md`.

**Recent refinements:**
- Grok streaming without `_meta.turnStartMs` now safely limited to one `assistant_turn` per response burst (using `emittedAssistantSinceLastUser` guard + reset on user).
- File-op detection for pulses unified to `FILE_OP_TOOLS` (no more per-harness duplicate Sets).
- Error isolation in scanners and resolver cache + watch invalidation added for resilience.
- The two-layer split (2026-06) moved this system into `hooks/` (normalization flow) + `surface/` (HTTP+SSE exposure). See `notes/crystallized/harness-architecture.md` for the full current picture and `CLAUDE.md` for the architecture diagram.

## Adding a New Harness (ergonomics goal)

1. Root constant in `hooks/harness-paths.mjs`.
2. `hooks/adapters/<new>.mjs` exporting `recordsToNormalized(records)`.
3. Scanner + single-session analyzer in `hooks/analyzers/analyze-<new>.mjs` (delegates to `recordsToNormalized` + `reduceSession` for the stats path).
4. `hooks/session-locators.mjs` — `locate<New>Session(sessionId, root?)` for the `/api/trace/:session_id` resolver.
5. Registry entry in `hooks/registry.mjs` (adapter, scan module, locateSession, roots, capabilities, `watch.matchLogFile` / `ctxFromPath` / `rebuildArg`).
6. Add a golden fixture to `test/adapters/nr-compliance.test.mjs` + update `test/harness-registry.test.mjs`, `test/analyze-orchestrator.test.mjs`, `test/http-routes.test.mjs`, and this matrix.

The goal is that a new harness feels like a localized, obvious addition with minimal cross-file churn — see `notes/crystallized/harness-architecture.md` for a fully worked example (Command Code).

## Source Data Retention (why history disappears)

kaaroSessions only reads whatever transcripts a harness still has on disk — it has no
storage of its own (`sessions-data.json`/`graph-data.json` are regenerated from scratch
on every `analyze.mjs` run, gitignored, never a historical archive). If a harness deletes
its own old transcripts, they vanish from the graph too, with no warning.

**Claude Code prunes its own history.** `~/.claude/projects/**/*.jsonl` is swept by a
built-in background job controlled by the `cleanupPeriodDays` setting (introduced in CC
v0.2.117; scope expanded in v2.1.117 to also cover `~/.claude/tasks/`,
`~/.claude/shell-snapshots/`, `~/.claude/backups/`). **Default is 30 days** — any session
transcript whose file hasn't been written to in 30+ days gets deleted automatically to
cap disk usage. The clock is keyed off the file's last-modified time, not the session's
original start date, so a session you keep resuming stays alive indefinitely; a session
you touch once and never resume ages out a month later.

This is not a kaaroSessions bug and not a recent change — it's been there almost since
CC's beginning. It's just easy to not notice until the graph looks sparser than expected.

**To change it:** add to `~/.claude/settings.json` (global) or a project's `.claude/settings.json`:

```json
{
  "cleanupPeriodDays": 365
}
```

`cleanupPeriodDays: 0` is rejected by CC with a validation error (it used to silently
disable transcript persistence entirely — don't rely on that). Pick a number of days
generous enough that you won't mind the loss.

**Confirmed 2026-08-24** (this repo's dev machine): live claude-code sessions only went
back to 2026-07-16 despite ~5 months of actual usage. The gap was recovered by discovering
`~/.claude` was itself a manually-`git init`'d + pushed repo with periodic snapshot
commits — those blobs held 95 sessions (2026-03-21 → 2026-05-07) that had already aged
out of the live directory. If you want a durable safety net beyond raising
`cleanupPeriodDays`, periodically committing `~/.claude` to a **private** git remote is
one option — but audit `.gitignore` first: `.credentials.json` (live OAuth token) and
`sessions/*.key` have no business in git history and were found tracked unprotected
during that investigation.

Other harnesses' retention behavior is currently undocumented/unverified — treat "the
graph only shows what's still on disk" as a general caveat, not a claude-code-specific one.

## Known Gaps / Future

- Subagent sessions under CC `<project>/subagents/*.jsonl` are not yet walked by the main CC scanner.
- Full incremental merge for Grok/Antigravity/Command Code (their `rebuildArg` currently returns `null`).
- Deeper caching/index for resolver beyond the simple Map (current clear-on-any-change is pragmatic).
- `serve.mjs` is now a thin composition root; remaining coverage gaps are tracked in CLAUDE.md's "Known coverage gaps" section (treat that as canonical — not duplicated here).

Update this file whenever behavior or support changes. It is the single source of truth visible to contributors and users.

Last updated: 2026-08-21, Codex harness added for local rollout transcripts and live pulse/trace support.
