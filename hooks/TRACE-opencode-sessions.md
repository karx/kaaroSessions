# opencode session tracing

How to locate, read, and reconstruct any opencode session.

## Version support markers & layout variants

| Version marker | Storage layout | Paths / Structure |
|---|---|---|
| `1.0` (`1.0.x`, e.g. `1.0.201`) | V1 JSON tree | `~/.local/share/opencode/storage/{session,message,part}/*.json` |
| `1.18` (`1.18.x`, e.g. `1.18.30`) | V2 SQLite DB | `~/.local/share/opencode/opencode.db` (tables: `session`, `message`, `part`) |

Both versions are fully supported by `scanOpencodeSessions`, `locateOpencodeSession`, `readSessionRecords`, and the live watcher (`read_mode: 'json'` for V1, `read_mode: 'sqlite'` for V2).

## On-disk layout

opencode stores sessions under `~/.local/share/opencode/`:

```text
~/.local/share/opencode/
├── opencode.db               # SQLite database (v1.18.x+: tables session, message, part)
├── opencode.db-wal
├── opencode.db-shm
└── storage/                  # JSON trees (v1.0.x legacy layout)
    ├── session/              # per-session info (ses_*.json)
    │   ├── <projectID>/
    │   └── global/
    ├── message/              # per-session messages (msg_*.json)
    │   ├── <sessionID>/
    │   └── <sessionID>.json
    └── part/                 # per-message parts (prt_*.json)
        └── <messageID>/
```

## Finding a session

### 1. Global search: `~/hooks/session-locators.mjs`

The `locateOpencodeSession(sessionId, root)` function scans `storage/session/` — both exact match and 8-char prefix fallback — then maps to `session_id` (strips `ses_` prefix).

### 2. Build pipeline: `~/hooks/analyzers/analyze-opencode.mjs`

`scanOpencodeSessions()` walks `storage/session/`, resolves `infoPath` per bucket, then `analyzeOpencodeSession(storageRoot, infoPath)` assembles each session:

```
readJson(infoPath)
  │
  ├─ messages:  storage/message/<info.id>/msg_*.json
  │               └─ parts:    storage/part/<msg.id>/prt_*.json
  │                   (sorted by monotonic prefix)
  │
  └─ recordsToNormalized([info, ...messages])  ← hooks/adapters/opencode.mjs
```

**`analyze-opencode.readOpencodeSession`** is the key helper for ad-hoc reconstruction without running the full pipeline.

## File formats

### `ses_*.json` (session info)

| Field | Meaning |
|-------|---------|
| `id` | `ses_<uuid>` — the session id |
| `version` | opencode version (e.g. `1.0.201`) |
| `projectID` | bucket under `session/` (`global` or a UUID prefix) |
| `directory` | `cwd` of the session |
| `title` | human-readable session title |
| `time.created` | ms timestamp |
| `time.updated` | last update ms timestamp |
| `summary.additions` | git ADD count |
| `summary.deletions` | git DEL count |

### `msg_*.json` (messages)

| Field | Meaning |
|-------|---------|
| `id` | `msg_<uuid>` — part of `_parts` not embedded |
| `sessionID` | links to `ses_*` |
| `role` | `user` | `assistant` |
| `time.created` / `time.completed` | ms timestamps |
| `parentID` | while `groupMessages` is not yet in use, a child links to its parent |
| `modelID` / `providerID` | e.g. `big-pickle` / `opencode` |
| `path.cwd` | working directory (redundant with session info) |
| `tokens.input / output` | authoritative totals from the envelope |
| `tokens.cache.read / write` | cache hits / writes |
| `finish` | e.g. `tool-calls` (assistant only, absent on the empty-response terminal message) |

### `prt_*.json` (parts)

| Field | Meaning |
|-------|---------|
| `type` | `text`, `reasoning`, `tool` |
| `time.start` | ms timestamp |
| `text` | for `text` and `reasoning` |
| `state.status` | `pending` → `running` → `completed` (tool parts) |
| `state.input` | `{ command, filePath, path }` for `bash` and file tools |
| `state.title` | description / title |
| `state.time.end` | completed timestamp |

**Note:** `step-start`, `step-finish`, and `patch` parts are intentionally dropped in `partToNormalized()` because they duplicate content that lives in the message envelope.

## Quick reconstruction example (from on-disk)

Given `ses_x73f...` as the session id:

```js
import { readOpencodeSession } from './hooks/analyzers/analyze-opencode.mjs';

const storageRoot = process.env.OPENCODE_STORAGE_ROOT
  || path.join(os.homedir(), '.local', 'share', 'opencode', 'storage');

const infoPath = path.join(storageRoot, 'session', '836c481ab00c209eaad52d5a4e9b24b63e652f47', 'ses_f73b406c8ffezQ5m2H5VptJLKU.json');

const { info, records } = readOpencodeSession(storageRoot, infoPath);
// records[0]  = session meta
// records[1]  = first user turn (has `text` from message)
// records[2..] = assistant turns (model, stop_reason, tokens, _parts)
//              followed by NS-embedded content blocks (text, thinking) and tool NRs
```

## Known gotchas

1. **Part-to-message sync drift.** The `part/` tree is flattened; `msg.id` in `storage/message/<sessionID>/msg_*.json` is **not** the same as the `id` field inside the part object. Match by directory (`storage/part/<msg.id>/`).
2. **Partial messages.** Live watch mode writes individual part files before the parent message exists. In that case the adapter accepts bare parts (entries without a parent message).
3. **Empty message dirs for completed sessions.** Some versions (e.g. 1.0.201) write to `message/<sessionID>/` while older versions write `global/` directly or rely on `part/` alone.
4. **Timeline absence.** opencode sessions do not carry an explicit `timeline` array (unlike `~/.claude/projects/*.jsonl`). The UI infers timeline from `msg.time.created` and `msg.time.completed`.
5. **Windows path normalisation.** `info.directory` uses backslashes; graph file nodes normalise to forward slashes.
6. **Live tool_call pulses need the session's directory, but only the info doc has it.** `part/<msgId>/prt_*.json` — the file that fires on every tool call — carries `sessionID` but no `directory`/`cwd` of its own; `msg_*.json` carries `path.cwd` but not `part_*.json`. `hooks/registry.mjs`'s opencode `watch.resolveProjectLabel` (backed by `hooks/helpers/opencode-helpers.mjs::opencodeSessionLabel`, cached per session id) locates and reads the sibling `ses_*.json` to fill `project_label` on these pulses; `surface/pulse-emitter.mjs::jsonAndPulse` calls it when the changed doc's own body has no `directory`. Without it, live opencode `tool_call` pulses still play (audio isn't gated on project) but ship `project: null`, which breaks the graph/DAW's project-hex highlight and per-project pitch/pan (`GRAPH.nodes.find(n => n.type==='project' && n.label===data.project)` never matches). Verified against a real local session on 2026-09-10.
