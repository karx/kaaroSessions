# PLAN — Merge readiness: fork DAW audio + session vitals

> **Branch:** `kaaro/merge/fork-daw-audio` (15 commits ahead of `master` @ `8255bfd`)
> **Contents:** session-vitals stack (8) · fork audio cherry-picks `4b8d5a2` `fd8475c` `03e1c24`
> (Calm Groove, notification melodies, DAW synth controls) · sidechain fix `8ba6bd4` ·
> awaiting state `e5f2adc` `c8f39b1` · docs `78e3922`.
> **Baseline:** 1939 tests green. Built pages parse. Live behaviour not yet exercised.
> **Sources:** `/code-review high` on the branch (10 findings), test-smell pass, and a
> normalization audit of real CC user rows (60 most recent sessions, this project).
>
> **Working rules** (same as `EXECUTION.md`): every unit is 🔴 failing test → 🟢 minimal
> code → 📦 one atomic commit, with `node --test` green before each commit. Fixes to the
> contributor's commits go in *new* commits; their sound design choices (presets, melodies,
> Calm Groove default, timbres) stay as they are unless a phase says otherwise.

---

## The core finding (why Phase 1 comes first)

Claude Code writes eight kinds of `user` row. The adapter turns **all** of them into
`user_turn`, which becomes a `human_turn` pulse and plays the human bell. The only marker is
`prompt` (`display_text !== null`). Mission Control reads it; the audio never does
(`14-pulse-audio.js:739`).

| Real row (60 sessions) | Count | Raw tag | Today | Should be |
|---|---|---|---|---|
| tool_result only | 4,297 | content = `tool_result` blocks | bell, `prompt:false` | silent (the tool result already sounds) |
| real human prompt | 174 | — | bell, `prompt:true` | bell, opens round |
| task notification | 22 | `<task-notification>` text | bell, opens round | silent, no round |
| slash command | 20 | `<command-name>` | bell, opens round | bell, opens round (decision D2) |
| command caveat/stdout | 14 | `isMeta` | bell, opens round | silent, no round |
| skill body / injected instructions | 15 | `isMeta` | bell, opens round | silent, no round |
| subagent prompt / reminders | 39 | `isSidechain` | bell, opens **parent** round | silent, no round |
| interrupt | 13 | `[Request interrupted by user]` | bell, opens round | **own sound**, no round, clears awaiting |
| compact summary | 1 | `isCompactSummary` | bell, opens round | silent (`compact` already sounds) |

Observed on session `eb64c814`: 65 human bells, only 19 of them on rows with `prompt:true`,
and some of those 19 are skill, subagent or notification rows.

Review findings #1 (subagent rows open parent rounds) and #2 (meta rows open rounds) are the
same root cause. Patching `prompt` would only treat the symptom. **Fix it once, at
normalization**, and every downstream consumer (vitals, audio, kind map, trace) reads the
same tag.

---

## Phase 0 — Merge hygiene ✅ (`0ab77fb`)

**Rationale.** The branch's code, tests and `CLAUDE.md` cite `RFC-session-triggers.md`, which
is untracked. Merging now would leave `master` with dangling references.

- [x] Commit `RFC-session-triggers.md` (brief left untracked)
- [x] Add an Item 11 pointer to this plan in `EXECUTION.md`
- [x] Leave out `tools.html` and `demos/` (scratch)

**End hypothesis.** `grep -r RFC-session-triggers` → every reference resolves to a tracked
file. The suite stays at 1939.

---

## Phase 1 — `origin` on user rows: normalize once, consume everywhere ✅ (merge gate)

**Landed:** 1.1 `fbf50a6` · 1.2 `3fe2da5` + fix `575b17f` (reminder-prefixed prompts) + wiring `152d509` ·
1.3 `9057b65` · 1.4 `ef875cf` + feed `31b849d` · 1.5 `5361390`. Suite 1939 → 1978.

**Hypothesis results (real data):**
- Classifier over 7,226 user rows (all local projects): no injected rows left as `human`.
  Real data found 3 cases the fixtures missed (isMeta skill body with `<command-name>`,
  `<bash-input>`/`<bash-stdout>`, reminder-prefixed typed prompt); each got a red test first.
- First-message diff over 94 sessions: 1 changed, a skill body replaced by the typed prompt.
- Store replay incl. subagent files: human_turns **162→8** (f22d728b), **94→13** (eb64c814),
  **96→5** (5ca8614f), each equal to the number of typed rows. ✔
- Other harnesses: goldens untouched, nr-compliance green. ✔
- Deferred: `public/index.html` seed blurb → Phase 5.2.

**Rationale.** This is the root cause behind findings #1 and #2, the false human bells, the
missing interrupt signal and the double compaction sound. The raw data is already well
tagged (`isSidechain`, `isMeta`, `isCompactSummary`, block types, stable text markers); the
adapter just throws those tags away. Per the two-layer rule, harness specifics stay in
`hooks/` and the experience layer only sees a harness-neutral tag.

**Direction.**

- **1.1 NR contract** — `hooks/normalized-record.mjs`: add optional `origin` to `user_turn`,
  enum `human | command | tool_result | interrupt | meta | notification | compact_summary | sidechain`.
  🔴 `test/normalized-record.test.mjs`: valid enum accepted, unknown value rejected.
- **1.2 CC adapter classifier** — a pure `classifyUserOrigin(rec, text)` in
  `hooks/helpers/analyze-helpers.mjs`. Precedence: `isSidechain` → `isCompactSummary` →
  all-`tool_result` content → interrupt text → `<task-notification>` → `isMeta` →
  `<command-name>` → `human`. 🔴 One table-driven test per row type, using fixtures shaped
  like the real rows from the audit above. The `firstUserSeen` logic switches to
  `origin === 'human'` and its two `startsWith` special cases are deleted.
- **1.3 Pulse transformer** — `human_turn.data.origin = nr.origin ?? 'human'`;
  `prompt = origin ∈ {human, command}` (kept for backward compatibility).
  🔴 `test/pulse-transformer.test.mjs`. Other adapters emit no `origin`, so they default
  to `human` (no change).
- **1.4 Active state** — `surface/active-state.mjs`: only `prompt === true` opens a round,
  bumps `human_turns` or sets `last_prompt_at`. `awaiting` clears on `prompt`, `interrupt`,
  `tool_result` or agent resume; `meta`, `notification` and `sidechain` rows never clear it.
  🔴 `test/active-state.test.mjs`: an Agent dispatch with a sidechain row keeps the parent's
  round, phase and lead-in.
- **1.5 Kind map / public seed** — `pulseDisposition` routes per origin; the
  `public/index.html` kinds/samples blurb lists them.
  🔴 `test/adapters/nr-compliance.test.mjs` golden update.

**End hypothesis.**
- Replaying `eb64c814` through adapter → pulses: `prompt:true` pulses ≈ the real human count
  (verify by hand from the transcript), not 19 plus injected rows.
- Replaying any session that has Agent calls through `active-state`: `lead_in.turns` and
  `phase` match a manual reading of the transcript, and Agent dispatches no longer reset
  `time_in_phase_s`.
- No change for the seven other harnesses (their golden fixtures stay untouched).

---

## Phase 2 — Signal accuracy ⬜ (merge gate)

**Rationale.** Vitals and alerts are only worth as much as their inputs. Each item below was
reproduced with `node` against the current code.

- **2.1 Final-question detection** (`hooks/helpers/turn-signals.mjs:3`) — misses
  "Should I commit these changes?", "Want me to push?", and a question followed by a closing
  sentence. Direction: a wider opener list (`should|shall|want me|do you want|ready to|ok to|
  okay if|let me know`) plus "any sentence of the final paragraph ends in `?` and is addressed
  to *you* / *me*". Still English-only: it's a heuristic fallback, and the question *tools*
  stay the primary path. 🔴 Table of 12+ positive/negative phrasings, including rhetorical
  questions in commentary that must stay `turn_complete`.
- **2.2 Intent labels** (`hooks/action-keys.mjs:89,127`) — currently `read` but should be
  `mutate`: `MultiEdit`, `NotebookEdit`, `tar -xzf`, `git -C <dir> commit`, `git restore`,
  `git clean`. Currently `mutate` but should not be: `>> /dev/null` (the regex `>{1,2}` takes
  one `>` and `\S` takes the second). 🔴 Extend `test/action-keys.test.mjs` with each case.
- **2.3 Same-batch tie** (`surface/pulse-emitter.mjs:50`, `session-vitals.mjs:80,139`) —
  every pulse in one tail batch shares `nowMs`, so a recovered API error still reads as
  unrecovered. Direction: `applyPulse` gets a monotonic per-session `seq`; vitals compare
  `(ts, seq)` instead of `ts >= ts`. Keep it pure: the caller passes `now`, the store owns
  `seq`. 🔴 `api_error` then `tool_call` with the same `now` → health ok, ripeness not
  stalled.
- **2.4 No duplicated asking-tool list** (`surface/active-state.mjs:25`) — drop
  `ASKING_TOOL`. `input_required` already carries `signal_id` = the tool id, so the store
  remembers `awaiting.signal_id` and ignores the `tool_call` whose `tool_id` matches it.
  The surface no longer knows harness tool names. 🔴 A renamed asking tool still keeps
  awaiting set.

**End hypothesis.** False YOUR TURN on real questions → 0 across the table. Read-only
mutations no longer keep sessions in THINK. A recovered API error shows OK within the same
batch. `grep AskUserQuestion surface/` → no matches.

---

## Phase 3 — Audio correctness ⬜ (merge gate)

**Rationale.** These are the user-audible defects. #3 also grows memory.

- **3.1 Autoplay backlog** (`14-pulse-audio.js:283`) — once "sound on" is saved, reload
  creates a suspended `AudioContext`; voices queue onto a frozen clock and play all at once
  on the first gesture. Direction: until `ac().state === 'running'`, `schedVoice` feeds the
  visual only and **drops** audio (no queue); `unlockAudio` resumes and resets `_beatAt`.
  🔴 A vm test with a stub context whose state is `suspended` → zero `startVoice` calls, and
  the flush after resume schedules only new voices.
- **3.2 Preset replace** (`19-daw-builder.js:1046`) — `applyPreset` resets octaves but
  merges instruments, so the result depends on click order. Direction: a preset applies
  `DEFAULT_SETTINGS.instruments ⊕ preset.instruments` (a full replace from a known base).
  🔴 Calm Groove → Cognitive Flow gives the same result as Cognitive Flow from a fresh
  start.
- **3.3 Origin-aware sound** (depends on Phase 1) — only `origin ∈ {human, command}` plays
  the human bell. `tool_result`, `meta`, `notification` and `compact_summary` are silent (the
  `tool_result` and `compact` events already sound). `sidechain` is covered by the `agent`
  tool call. `interrupt` gets a new registry event (decision D1). 🔴
  `test/event-registry.test.mjs` + `audio-sim` test: replaying `eb64c814` gives a human bell
  count equal to the Phase 1 prompt count.

**End hypothesis.** A reload with sound on followed by 5 idle minutes produces no burst on
first click and keeps the node count flat. Preset results don't depend on order. Human bells
equal human prompts; each interrupt can be heard on its own.

---

## Phase 4 — Determinism & test hygiene ⬜ (4.1, 4.2 before merge; 4.3 may follow)

**Rationale.** One latent flaky test, and tests that break when a comment is reworded.
Both cost time later.

- **4.1 Injectable clock** — `createPulseEmitter({ …, startedAt = Date.now(), now = Date.now })`.
  `signalStart` uses `startedAt`; `turn-signals.test.mjs` fixtures use fixed epochs instead
  of `new Date()` at module load. This removes the "test >1 s after load → 0 emitted" flake
  and matches the "caller supplies time" convention of `surface/`.
- **4.2 Test naming** — split "…ordinary questions in commentary do not" into two tests
  that each assert what they say.
- **4.3 Extract pure audio logic** — move `notificationNotes`, preset merge, settings load
  and octave resolution into `experience/client-core.mjs` (already injected as
  `%%CLIENT_CORE%%`). Replace comment-banner slicing (15 anchors across 3 files) with plain
  imports. One test file per module (CLAUDE.md rule). The vm tests stay only for real DOM
  wiring. 🔴/🟢 per function moved, behaviour unchanged (the existing assertions are the
  oracle).

**End hypothesis.** `grep "indexOf('  // ──" test/` → 0. Running the suite with an artificial
2 s delay before the dedup test stays green. Rewording any comment in `14-pulse-audio.js`
breaks no tests.

---

## Phase 5 — Single source of truth for instruments & docs ⬜ (follow-up PR)

**Rationale.** The playable-instrument list is copied by hand in about 8 places and has
already drifted (`public/index.html:659` still maps `woodblock → pling`). Every new
instrument needs about 8 edits.

- **5.1** `experience/audio/event-registry.mjs` `PLAYABLE_INSTRUMENTS` / `PERC` become the
  only source. The client lists (`INSTS` keys, `PERC`, `PERC_VOICES`, `INST_OPTS`,
  `INST_NAMES`, the synth-tab array, the resolveSonic inline list) derive from it via build
  injection. 🔴 A test asserts that every client copy equals the registry set (guards the
  drift until each copy is removed).
- **5.2** Regenerate or fix the `public/index.html` audio seed (woodblock, new instruments,
  new kinds).
- **5.3** Move the fork's audio notes from `docs/CODEX.md` to `docs/SONIC-MAPPING.md`.

**End hypothesis.** Adding an instrument = one registry entry + one synth function.
`grep -c "'woodblock'" experience/` falls to the registry and the synth.

---

## Phase 6 — Ship ⬜

- [ ] **Live validation** (`node serve.mjs`), checklist:
  sound on → reload → idle 2 min → click: no burst ·
  AskUserQuestion in a live CC session → AWAITING INPUT chip + descending phrase ·
  answer → chip clears · end of turn → YOUR TURN + ascending phrase ·
  subagent dispatch → no bell, parent phase unchanged · Esc interrupt → interrupt sound ·
  Calm Groove ↔ other presets in any order → identical results
- [ ] Push the branch; open the PR to `master` with this plan linked; merge
- [ ] Ask the fork contributor to review Phase 3 (their domain) and to voice D1
- [ ] Review the remaining fork commits (Codex archived sessions `267ebb1`, poll fallback
      `d4f43c1`) as a separate PR against the new `master`

**End hypothesis.** `master` contains vitals + audio + all correctness fixes, CI green on
Node 18/20/22, and every live checklist item behaves as stated.

---

## Open decisions

| ID | Decision | Default if undecided |
|---|---|---|
| D1 | Interrupt sound: new instrument/phrase, or a re-voiced existing one? | New registry event `interrupt`, placeholder muted `buzz`, octave −1; contributor tunes |
| D2 | Do slash commands open a round (ripeness)? | Yes: typed by the human, and they start work |
| D3 | Phases 4.3 + 5 in this PR or a follow-up? | Follow-up PR; Phases 0–3 + 4.1/4.2 gate the merge |

## Finding → phase map

| Source | Finding | Phase |
|---|---|---|
| review #1 | sidechain rows open parent rounds | 1 |
| review #2 | meta/compact/command/interrupt rows count as prompts | 1 |
| audit | 46/65 human bells are tool results; interrupt can't be heard | 1, 3.3 |
| review #3 | autoplay backlog / node growth | 3.1 |
| review #4 | preset leaves stale instruments | 3.2 |
| review #5 | intent misclassification | 2.2 |
| review #6 | final-question misses | 2.1 |
| review #7 | same-batch tie | 2.3 |
| review smell | instrument list ×8 | 5.1–5.2 |
| review smell | `ASKING_TOOL` duplicate | 2.4 |
| review/test smell | banner-sliced vm tests | 4.3 |
| test smell | wall-clock flaky dedup test | 4.1 |
| test smell | misleading test name | 4.2 |
| hygiene | untracked RFC | 0 |
| docs | audio notes in CODEX.md | 5.3 |

## Status log

- 2026-11-10 — plan written; branch at `78e3922`, 1939 green.
- 2026-11-10 — Phases 0 + 1 landed (9 commits); 1978 green. Next: Phase 2.
