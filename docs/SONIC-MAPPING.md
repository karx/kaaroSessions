# Sonic Mapping — Design Guide

How to attack the audio design layer once adapter coverage is solid.

**Current state (2026-06-10):** All event types are wired end-to-end
(`adapter → NR → transformer → resolveSonic → audio`). The question is no longer
"does this fire?" but "does it sound right?" This doc is the roadmap for that work.

---

## Current Sonic Profile (what we have)

Each column comes from `lib/event-types.mjs`. These are the *defaults* — presets
override via `mappings[]` rules.

| Event type | Family | Instrument | Pan | Vol | Brightness | Octave | Description |
|---|---|---|---|---|---|---|---|
| `read` | FILE | harp | +0.05 | 0.65 | 6500 | 0 | File observation |
| `write` | FILE | bass | −0.15 | 1.30 | 10000 | 0 | New state creation |
| `edit` | FILE | pling | −0.10 | 1.00 | 8500 | 0 | Mutation |
| `grep_glob` | FILE | bit | +0.10 | 0.55 | 5000 | 0 | Codebase scan |
| `agent` | AI | bell | +0.35 | 1.20 | 4500 | +1 | Subagent spawn |
| `web` | AI | bell | +0.45 | 0.80 | 5500 | +1 | External network IO |
| `other` | AI | harp | 0.00 | 0.60 | 6500 | 0 | Unmapped tool |
| `bash_git` | SYSTEM | snare | −0.30 | 1.10 | 3500 | 0 | Git operation |
| `bash_run` | SYSTEM | kick | −0.30 | 1.00 | 2800 | 0 | Process execution |
| `bash_other` | SYSTEM | hat | −0.30 | 0.55 | 4000 | 0 | Shell misc |
| `tokens` | CONTEXT | flute | 0.00 | 0.50 | 5000 | −1 | Cognitive cost |
| `words` | CONTEXT | bell | +0.20 | 0.90 | 9000 | +1 | Linguistic output |
| `chirp` | CONTEXT | woodblock | +0.15 | 0.30 | 7000 | 0 | Micro-ack |
| `human_turn` | HUMAN | pad | 0.00 | 0.70 | 7000 | 0 | User prompt |
| `attachment` | HUMAN | click | +0.05 | 0.40 | 8000 | 0 | Context loading |
| `mode_shift` | CONTEXT | chime | 0.00 | 0.50 | 6000 | 0 | Plan/mode toggle |
| `compact` | SYSTEM | sweep | 0.00 | 0.80 | 1000 | −1 | Context reset |
| `permission` | SYSTEM | tick | 0.00 | 0.40 | 3000 | 0 | Permission gate |
| `scaffold` | SYSTEM | woodblock | 0.00 | 0.35 | 2500 | −1 | System injection |
| `tool_result` | SYSTEM | harp | +0.05 | 0.40 | 5000 | 0 | Tool success |
| `tool_error` | SYSTEM | buzz | −0.10 | 0.90 | 1500 | −1 | Tool failure |
| `thinking` | CONTEXT | bell | −0.10 | 0.25 | 4000 | −1 | Extended thinking — deliberation before acting |
| `unknown` | META | tick | 0.00 | 0.25 | 3000 | 0 | Catch-all |

### Brightness encoding (special rule for `tokens`)

`tokens` brightness is not fixed — `resolveSonic` overrides it based on cache ratio:

```
cacheRatio = cache_read / (output + cache_read)
brightness = lerp(5000, 800, cacheRatio)
```

Low brightness (≈800) = warm, cached context. High brightness (≈5000) = fresh tokens.
This is the only event type with dynamic brightness.

---

## Live controls: Synth tab, instruments, notification melodies

Graph and DAW use the same live sound event list. The DAW Synth tab exposes
all audible categories, including Thinking, User Prompt, Short Reply, Web,
Compaction, Permission Mode, Mode Change, Attachment, System Message,
Tool Error, API Error, and Interrupt. Each row has instrument, octave, and preview controls;
choose **off** to mute that category. Changes are saved for both views in the
same browser. Human/context signals appear in the Context lane; structural
signals and errors appear in System. SIM offers the same event types for testing.

Both views offer rimshot, clap, shaker, tom, and woodblock alongside kick,
snare, and hi-hat. Marimba adds a softer pitched mallet voice that follows the
selected scale and octave. These choices are also available in DAW mapping
rules; adding them does not change existing presets or saved selections.

Calm Groove is the default for fresh visits: random Dorian notes, low bells,
harp and bass, with shaker for Thinking, tom for Short Reply, and woodblock for
Compaction and Attachment. Saved choices still take precedence when reopening
the site. Apply Calm Groove in the DAW's PROF tab to restore the entire preset.

The Synth tab includes **Turn Complete** (low bell) and **Input Required**
(pling), each with an instrument, octave offset, and preview. Both events
also appear in the DAW simulator and the graph's live ticker.

Turn Complete plays scale degrees **1, 3, 5, 7** in sequence; Input Required
plays **7, 5, 3, 1**. Notes are spaced at half-beat intervals using the current
BPM, scale, and octave settings. On scales with fewer than seven notes,
degrees continue into the next octave. Preview plays the same phrase.
Percussion selections play four hits rather than distinct pitches.

User Prompt rings only for rows the person typed (`human_turn.origin` `human` or
`command`); an Esc/Ctrl-C interrupt plays its own **Interrupt** voice (muted buzz,
octave −1), and harness-injected rows (tool results, notifications, compaction
summaries, subagent briefs) are silent. `client-core` `humanTurnEvent()` is the one
rule, shared by the engine, the ticker and `audio-sim`.

The voice catalogue is `experience/client-core.mjs` `INSTRUMENTS`: every menu, the
percussion set and the registry's `PLAYABLE_INSTRUMENTS` derive from it.

---

## Open Design Problems

### 1. `mode_shift` — chime is correct but pitch is random

Currently `mode_shift` gets a pitch from `path_hash(null)` → always the same note.
The intent (W-COG-03) is to *signal a mode change*, not just fire once per session.

**Two approaches:**

**A. Octave ladder** — plan mode = oct+1, back to normal = oct-1. Very legible.
```js
// In resolveSonic, after base sonic:
if (event === 'mode_shift') {
  sonic.octave = data.mode === 'plan' ? 1 : data.mode === 'normal' ? 0 : -1;
}
```
Requires `data.mode` on the pulse (already present from transformer).

**B. Scale shift** — plan mode switches the SCALE from `major_pentatonic` to `dorian`.
Much more dramatic; requires threading a mutable scale state through `simulateSession`.
Hard to implement without side effects.

**Recommendation:** Option A first. Simple, reversible, testable.

---

### 2. `attachment` — all subtypes sound identical

`attachment` events carry `data.subtype`. The current `click` instrument is correct
but every subtype (file, task_reminder, invoked_skills, plan_mode) hits the same note.

**Subtype → octave map (proposed):**

| Subtype | Intent | Proposed octave |
|---|---|---|
| `file` | File context loaded | 0 |
| `task_reminder` | Task list injected | +1 |
| `invoked_skills` | Skills loaded | +1 |
| `plan_mode` / `plan_mode_exit` | Plan mode entered/exited | +2 / −1 |
| `deferred_tools_delta` | Tool list updated | 0 |
| `skill_listing` | Skill catalog | −1 |
| `compact_file_reference` | Post-compact context | −1 |
| everything else | Default | 0 |

Implementation: in `resolveSonic`, after base sonic lookup, adjust `octave` if
`event === 'attachment'` and `data.subtype` is known.

---

### 3. `tokens` — brightness dynamic, but volume is flat

The cache ratio already drives brightness. Volume should scale with the *size* of
the turn — heavier model work = louder flute.

**Proposed:** `volMult = lerp(0.30, 0.90, outputTokens / MAX_OUTPUT)` where
`MAX_OUTPUT = 8192` (typical max context output). Clamp at 0.90 to avoid clipping.

Implementation site: `resolveSonic` tokens branch, after cache-ratio brightness.

---

### 4. `tool_result` — success sounds like `read` (both are harp)

`tool_result` and `read` share the same instrument. The semantic difference is:
- `read` = active action (the AI chose to read)
- `tool_result` = passive receipt (the environment responded)

**Proposed:** use a lower-velocity harp (reduce `volMult` to 0.25), or switch to
`woodblock` at oct−1 to push it into the "structural" family sonically.

---

### 5. `human_turn` — pad volume does not scale with prompt length

W-COG-01 asked for amplitude to scale with prompt character count.

**Implementation:** In the transformer, add `char_count: nr.text?.length || 0` to the
`human_turn` pulse data. In `resolveSonic`:
```js
if (event === 'human_turn') {
  const chars = data.char_count || 0;
  sonic.volMult = Math.min(1.20, 0.50 + (chars / 500) * 0.70);
}
```
Cap at 1.20. A 500-char prompt = full volume. Single word = 0.50.

---

### 6. `unknown` — reduced from 1600+ to ~4 real unknowns per CC session ✓

**Resolved (2026-06-10).** The bulk of unknowns came from:

| Source | Count (approx) | Resolution |
|---|---|---|
| `branch_change` dedup (was emitting on every user record) | ~400 | CC adapter now deduplicates — only emits on actual change |
| `assistant_turn` NR (structural wrapper) | ~350 | Pulse `silent` (`reason: envelope`) — 2026-08-26 |
| `content_block/tool_use` (pre-tool marker) | ~350 | Pulse `silent` (`reason: duplicate`) |
| `content_block/thinking` | ~110 | Mapped to `thinking` event type (soft pad) |
| `session_meta` / `branch_change` / `skill_invoke` | ~230 | Pulse `silent` (`reason: snapshot`) |
| Actual `unknown_record` (unrecognized types) | ~4 | Left as `unknown` tick — diagnostic signal |

The remaining audible unknowns (`unknown_record` from unrecognized JSONL types) are
intentional — they surface coverage gaps and are useful for debugging.

Disposition is the table in `hooks/pulse-map.mjs`, not preset `nr_kind` off-rules. `ruleMatches` still supports `nr_kind` for real profile overrides.

---

### 7. W-COG-07 — Content-aware pitching

Not yet implemented. Requires new data from adapters.

**For file writes/edits:** the Edit tool's `new_string` / `old_string` gives us a line-delta.
If `new_string.split('\n').length > old_string.split('\n').length`, pitch up (ascending);
if fewer lines, pitch down (descending). For Write with a large file, always ascending.

Implementation sites:
1. CC adapter: add `line_delta` to `tool_use` NR input: `new_string.split('\n').length - old_string.split('\n').length`
2. Transformer: pass `line_delta` through on `tool_call` pulse data
3. `resolveSonic`: for `key === 'edit'`, adjust `octave` by `Math.sign(data.line_delta)`

**For web:** `WebFetch` already maps to `web` → bell at oct+1. Could differentiate
`WebSearch` (broader, louder) from `WebFetch` (precise, quieter) via a `web_type` field.

---

## Implementation Order

### Quick wins (1–2 hours each)

1. **`mode_shift` octave-by-mode** — 5 lines in `resolveSonic`, 1 test
2. **`attachment` octave-by-subtype** — 10 lines in `resolveSonic`, 1 test  
3. **`human_turn` volume-by-length** — 5 lines in transformer + resolveSonic, 1 test
4. ~~**Silence structural unknowns in presets**~~ ✓ Done (2026-06-10)
5. ~~**`branch_change` dedup in CC adapter**~~ ✓ Done (2026-06-10)
6. ~~**`thinking` event type**~~ ✓ Done (2026-06-10)

### Medium (half day)

7. **`tokens` volume-by-size** — new field in transformer, 5 lines in resolveSonic
8. ~~**`ruleMatches` nr_kind support**~~ ✓ Done (2026-06-10)

### Larger effort (1–2 days)

7. **W-COG-07 line-delta pitching** — adapter change + transformer + resolveSonic + 3 tests
8. **Scale-shift for plan mode** — requires threading scale state through `simulateSession`

---

## Where to make changes

| Change | File | Function |
|---|---|---|
| Add dynamic sonic per event | `experience/audio/audio-sim.mjs` | `resolveSonic()` |
| Expose new data fields | `hooks/pulse-transformer.mjs` | `transformRecord()` |
| Add new data from raw records | `hooks/adapters/<harness>.mjs` | `recordsToNormalized()` |
| Silence specific NR subtypes | `experience/audio/audio-presets.mjs` | per-preset `mappings[]` |
| New default sonic profile | `experience/audio/event-registry.mjs` | `EVENT_TYPES` entry |
| Add an instrument | `experience/client-core.mjs` + `experience/client/14-pulse-audio.js` | `INSTRUMENTS` entry + synth function, `INSTS`, `INST_DUR` |

The architecture enforces the boundary: adapters are sonic-unaware. All sonic
decisions live in `resolveSonic()` and presets. Don't put audio logic in adapters.
