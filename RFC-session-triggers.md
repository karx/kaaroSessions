# RFC: Session Triggers — a Cockpit Experience to Incubate Sessions

**Project:** kaaroSessions
**Status:** Draft
**Date:** 2026-10-08
**Relates to:** NR contract (`hooks/normalized-record.mjs`), action keys (`hooks/action-keys.mjs`), pulse map (`hooks/pulse-map.mjs`), session reducer (`hooks/session-reducer.mjs`), trace tree (`hooks/trace-tree.mjs`), Mission Control (`surface/active-state.mjs`, `experience/pages/now.html`), policy pillar (`hooks/policy.mjs`, `hooks/signal-evaluator.mjs`), `RFC-kind-map.md`, `RFC-context-tree-visualization.md`, `RFC-cache-hit-rate.md`
**Grounding:** a read-only pass over all 232 local sessions in 8 harnesses (registry `readSessionRecords` → adapter → NormalizedRecords). That gave 920 human prompts in 188 sessions after noise removal. Method, tables and caveats are in §10. Every number below comes from that pass.

---

## 1. Problem

A session has two phases:

- **Thinking:** reads, greps, planning, questions.
- **Doing:** edits, writes, mutating shell, commits.

The human moves a session from thinking to doing with a prompt such as "let's build", "go", "execute", "resume" or a skill invocation. That prompt is a **trigger**. It is the highest-leverage prompt in a session, and nothing in the Personal Live Mirror shows it today.

What the user cannot see today:

| Question | Where the answer should be | Today |
|---|---|---|
| Is this session still thinking, or already doing? | `/now` session card | Not shown. `recent_actions` lists tools, but nothing classes them. |
| Has thinking gone on long enough to act on? | `/now` | Not shown. |
| Which prompt shapes tend to start real work? | history view | Not shown. Prompt text survives only as the first message and per-turn `display_text`. |
| Why did my session stop? | `/now` api-error line | Always empty. No adapter emits `api_error` (§10, finding 8a). |
| Will "resume" be cheap or expensive? | nowhere | Not shown. A cold-cache re-entry costs 89k–412k `cache_creation` tokens; a warm one costs 0.5–11k. |

**The incubation metaphor.** A session is incubated, not driven. The human lets the thinking phase develop until it is ripe, then triggers. The cockpit's job is to make ripeness, trigger choice and recovery *visible*. The human still decides; the cockpit never acts.

### 1.1 Failure modes the grounding exposes

| Failure mode | Evidence (§10) | What the cockpit could show |
|---|---|---|
| **Ambiguous trigger.** "Let's review / brainstorm / understand" reads like action but produces only reading. | 24% (62/256) of action-style prompts produced no DO and no VERIFY. Users re-prompted after 54 of the 62. | Trigger class + its observed yield, before the user sends it |
| **Premature or overripe trigger.** | 1 lead-in thinking turn → 71% bursts; 4+ turns → 22% (n=9) | Ripeness state with its inputs listed |
| **Stalled resume.** After an interrupt-for-tool-use, "resume" is read as feedback. | 1 of those resumes stalled ("I'll pause there. What would you like me to adjust?"); 1 was reframed | Resume Panel suggests explicit wording |
| **Cold-cache re-entry.** | 89k and 412k `cache_creation` with `cache_read=0`, vs 0.5–11k for warm resumes under 10 min | Cache-cold warning with a token estimate |
| **Limit dead time.** | 11 real API-limit errors: 6 got a "resume", 2 were re-woken by a subagent notification, 1 abandoned, 1 moved on after 9.5 h, 1 session ended | Detected cause + reset countdown (the session-limit text contains the reset time) |

---

## 2. Goals and non-goals

### Goals

1. **Phase is first-class normalized data.** Each turn gets a `think | do | verify` phase, derived once in the normalization flow. Every consumer reads the same answer.
2. **Triggers are recorded.** A human turn that precedes the first DO after thinking gets a `trigger` record: class, verb, word count, gap, booster flags.
3. **Ripeness can be explained.** A small, discrete state with its inputs listed. No opaque score.
4. **Recovery is visible.** API-limit cause, reset time, cache temperature and suggested resume wording appear on the session card.
5. **Users learn from their own history.** Per-class trigger yield is computed from local `sessions-data.json` and shown next to the composer.
6. **Capability-driven per harness.** New registry flags tell the experience layer what each harness can provide (§4.5).

### Non-goals

- **Never auto-send, never gate.** The cockpit copies text to the clipboard and nothing else. This matches the policy pillar: signals only, an auditor and never a gatekeeper (`hooks/signal-evaluator.mjs` header; CONTEXT.md non-goal "Acting as an active gate or interceptor").
- **No harness specifics in the UI.** `experience/` consumes the Observability Surface only (HTTP + SSE). Phase, trigger class and resume cause are computed in `hooks/` / `surface/`.
- **No new SSE channel** without a reason. `phase_shift` is one more pulse on `/events`. Ripeness rides on the existing throttled `now` snapshot.
- **No quality or rework claims.** Yield means "the next turn did work". It does not mean the work was good. Rework detection was too weak to use (§10.4).
- **No prompt rewriting by an LLM.** The composer helps the user pick a verb and add clauses. It does not generate prompts.
- **No upload of prompt text.** Trigger stats stay local (§8).

---

## 3. Concepts — proposed CONTEXT.md entries

Proposed only; this RFC does not edit CONTEXT.md.

**Phase**:
The work mode of one assistant turn, derived from its tool calls: `think` (no mutating or verifying action), `do` (≥1 mutating action: write/edit or a mutating shell command), `verify` (test/build commands, no mutation). If a turn has both DO and VERIFY actions, the phase is `do` and the turn is flagged `verified`.
_Avoid_: mode (taken by `mode_shift` / `permission_mode`), state.

**Phase Shift**:
The pulse emitted when a session's phase changes between consecutive turns that contain tools. It is a Stream event like `mode_shift`.

**Trigger**:
The human turn right before a session's first DO turn after ≥1 non-DO turn (a *transition*). Every human turn also gets a **Trigger Class**, so turns that failed to trigger can be studied too.
_Avoid_: command, go-prompt.

**Trigger Class**:
The verb-based category of a human prompt: `go`, `lets_build`, `go_scope`, `ship`, `skill`, `imperative`, `lets_think`, `resume`, `question`, `repair`, `other`. The verb is the trigger, not the word "let's".

**Burst**:
_Collision._ CONTEXT.md already uses **Burst** for "pulses that share Recorded Time". This RFC uses **Build Burst**: a turn with ≥3 DO actions, or DO + VERIFY.

**Lead-in**:
The run of non-DO turns before a transition. It is measured in turns, tool calls and wall time.

**Incubation**:
The thinking phase seen as something that ripens. It is the cockpit's frame, not a data field.

**Ripeness**:
A discrete, explainable state of the current lead-in: `fresh | ripening | ripe | overripe | stalled`. Each state comes with the list of inputs that produced it (§5.4).

**Round**:
One human prompt plus the agent work that follows it, up to the next prompt. A `human_turn` pulse with `prompt !== false` opens a new round. Claude Code tool-result rows set `display_text: null`, which gives `prompt: false`, so they do not open one. A round's phase is `do > verify > think`. Live "turns" in ripeness and lead-in are rounds, not assistant envelopes. CC writes one assistant record per content block, which would inflate envelope counts.

**Session Health**:
A discrete, explainable state of how cleanly a live session is running: `ok | strained | degraded | unknown`. Like Ripeness, it comes with its input rows (§5.5). It is not a quality judgement on the work.

**Yield** (of a Trigger Class):
The share of prompts in that class whose next turn did DO work, or started a Build Burst, plus the median DO action count. Descriptive only.

**Resume Event**:
A human turn classed `resume`, or the first human turn after an `api_error` / `interrupt`. It carries its cause, gap and cache temperature.

---

## 4. Design

The design is split into layers per CLAUDE.md. Each layer only reads from the layer above it.

```
 adapters ──► NRs (+ api_error, interrupt)                       hooks/
     │
     ├─► session-reducer ─► sessions-data.json (+ phases, triggers[], resume_events[])
     │                          │
     │                          └─► GET /api/triggers  (yield table, history)  surface/
     ├─► trace-tree ─► segment.turns[].phase / .trigger ─► GET /api/trace/:id
     └─► pulse-transformer ─► tool_call{phase}, human_turn{trigger}, phase_shift
                                 │
                                 └─► active-state ─► /api/active + SSE `now`
                                                      (phase, ripeness, resume_hint)
                                                                         experience/
                         /now cockpit · composer · resume panel · trace ribbon · DAW cue
```

### 4.1 Normalization layer (`hooks/`)

| # | Change | File | Kind | Priority |
|---|---|---|---|---|
| N1 | Split `bash_other` (and the phase-ambiguous parts of `bash_git` / `bash_run`) by intent | `hooks/action-keys.mjs` | proposed `shellIntent(command)` → `mutate \| verify \| read` | **P0 prerequisite** |
| N2 | `api_error` NR from Claude Code | `hooks/adapters/claude-code.mjs` | emit an existing kind | **P0 prerequisite** |
| N3 | `interrupt` NR | `hooks/normalized-record.mjs`, `hooks/pulse-map.mjs`, CC adapter | new RECORD_KIND | P0 |
| N4 | Per-turn `phase`, per-human-turn `trigger` | `hooks/session-reducer.mjs`, `hooks/trace-tree.mjs` | derived fields | P1 |
| N5 | `phase_shift` pulse; `phase` on `tool_call`; `trigger` on `human_turn` | `hooks/pulse-transformer.mjs`, `hooks/pulse-map.mjs` | pulse payload | P1 |
| N6 | `resume_events[]`, `triggers[]`, `phase_counts` on the session | `hooks/session-reducer.mjs`, `hooks/sessions-schema.mjs` (`OPTIONAL_SESSION_FIELDS`) | session fields | P1 |
| N7 | command-code adapter yields 0 NRs on its real 532 KB session | `hooks/adapters/command-code.mjs` | bug fix | later (blocks command-code row only) |

#### N1 — shell intent (proposed)

Today `toolNameToKey` returns `bash_git | bash_run | bash_other` from `categorizeBash` (`hooks/helpers/analyze-helpers.mjs`). That prefix test cannot tell phases apart:

- `bash_git` mixes `git status` (read) with `git commit` (mutate).
- `bash_run` mixes `npm test` (verify) with `npm install` (mutate).
- `bash_other` mixes `sed -i`, `pytest` and `ls`.

So phase cannot come from action keys alone (§10, finding 8d).

Proposal: keep `TOOL_ACTION_KEYS` unchanged, so the Event Registry and sonic keys stay stable. Add an orthogonal **intent** next to it:

```js
// hooks/action-keys.mjs (proposed)
export const SHELL_INTENTS = new Set(['mutate', 'verify', 'read']);
export function shellIntent(command) { /* §5.1 rules; null command → null */ }
export function toolIntent(name, input) {
  const key = toolNameToKey(name);
  if (key === 'write' || key === 'edit') return 'mutate';
  if (isBashToolName(name)) return shellIntent(input?.command ?? input?.cmd ?? null);
  return 'read';                       // read, grep_glob, web, agent, other
}
```

The brief's literal "split `bash_other` into three keys" option was considered and not chosen. New keys would change the Canonical Action Key vocabulary. That would ripple into the Event Registry, `resolveSonic` presets, the kind-map tool grid and `test/audio-sim.test.mjs`. Intent is phase vocabulary, not sonic vocabulary, so it lives beside the key, not inside it. Open question Q1 asks whether to split the keys anyway.

`null` intent means the command text was missing. For example, Copilot emits `category: null` and often no command. The reducer counts these as `unknown` intent, not as `read`. That keeps undercounting visible (§10.4).

#### N2 — `api_error` from Claude Code

`api_error` exists in `KIND_FIELDS`, has a `KIND_PULSE` row, is built by the transformer and is counted by `active-state.mjs`. `now.html` already renders `last_api_error`. But no adapter emits it. CC writes API failures as `assistant` records flagged `isApiErrorMessage`. `recordsToNormalized` maps them to a plain `assistant_turn` + text `content_block`, and the flag is never read. Result: 0 `api_error` NRs across 232 sessions.

Proposal: in the CC adapter's `rec.type === 'assistant'` branch, when `rec.isApiErrorMessage` is true:

- emit `{ kind: 'api_error', message, code }` instead of the text block;
- still emit `assistant_turn`, so turn counts stay unchanged;
- add optional fields to `KIND_FIELDS.api_error`: `resets_at: 'string'` (ISO) and `raw_reset: 'string'` (the text as written).

`code` comes from `classifyApiError(message)`, proposed in `hooks/helpers/analyze-helpers.mjs`:

| `code` | Matches (case-insensitive) | Observed |
|---|---|---|
| `session_limit` | `limit reached`, `resets <time>` | yes, with "resets 2:30am (Asia/Kolkata)" |
| `spend_limit` | `monthly`, `spend`, `usage limit` | yes |
| `content_filter` | `content filter`, `output blocked` | yes |
| `overloaded` | `overloaded`, `529`, `rate limit` | expected; not separately counted |
| `other` | anything else | — |

`resets_at` parsing is pure. It takes the record `ts` plus the "resets H:MMam (IANA zone)" text and returns the next such wall-clock instant after `ts`. It uses `Intl.DateTimeFormat` only (zero deps). If parsing fails, the result is `resets_at: null` with `raw_reset` kept. The UI then shows the raw text and no countdown.

Other harnesses: there is no source evidence yet. They stay `records_api_errors: false` (§4.5). Their limit text currently lands in `content_block` / `unknown_record`.

#### N3 — `interrupt` NR (new kind)

`[Request interrupted by user]` and `[Request interrupted by user for tool use]` arrive as CC `user` records. Today they become a `user_turn` whose `display_text` is that string. One snapshot already records it as a 4-word `words` pulse (`test/snapshots/277e6422-cognitive-flow.snap`). These are not human prompts, and they distort trigger stats.

Proposal:

```js
// KIND_FIELDS (proposed)
interrupt: { required: {}, optional: { during: 'string' } }, // 'tool_use' | 'response'
// KIND_PULSE (proposed)
interrupt: { event: 'interrupt' },
```

Changes:

- The CC adapter emits `interrupt` *instead of* `user_turn` for those exact strings.
- `pulse-map.mjs` gets a row, enforced by `test/pulse-map.test.mjs`.
- The Event Registry gets an `interrupt` entry with a Playable Instrument (for example `hat`).
- `active-state.mjs` gets an `interrupts` counter and `last_interrupt`.

#### N4 — phase and trigger per turn

Derived in the reducer, and in the trace tree for the per-turn view, from the NR stream. The algorithms are in §5. Shapes (proposed):

```js
// trace-tree segment.turns[] (assistant turn, proposed additions)
{ role: 'assistant', …, phase: 'think'|'do'|'verify', verified: bool,
  do_count: n, verify_count: n, burst: bool }

// trace-tree segment.turns[] (user turn, proposed additions)
{ role: 'user', …, trigger: {
    class, verb, words, gap_s, after_offer, has_process_clause, skill,
    transition: bool            // true iff next assistant turn is the first DO after ≥1 non-DO
} }
```

`trigger` on a user turn needs per-turn human text. CC, Codex, Grok and command-code emit `display_text`. Pi, opencode, Copilot and Antigravity do not today. For those, `trigger.class` is `null` while phase still works (§4.5).

Skill turns: the CC "Base directory for this skill" user turn, and any `skill_invoke` NR inside a turn, force `class: 'skill'`. Phrase matching misses these, yet they started 38- and 41-action bursts (§10, finding 3).

#### N5 — pulses

Payload additions:

- `tool_call` gets `data.intent` (`mutate | verify | read | null`). Live phase then needs no second shell parse in `active-state`.
- `human_turn` gets `data.trigger` (class + flags, **no text**), when the adapter supplies `display_text`. Today `human_turn.data.text` is `nr.text`, which adapters null after the first prompt. So live text never arrives, and this RFC does not add it.
- New pulse `phase_shift` `{ from, to, turn_index }`. It is emitted by the pulse transformer when consecutive tool-bearing assistant turns change phase. The transformer is per-batch, so it needs the prior phase from the previous tail. Proposed: the emitter keeps `lastPhase` per session in `surface/pulse-emitter.mjs` and passes it in `ctx`. That keeps the transformer pure.

`phase_shift` is a derived pulse, not an NR. It breaks the rule "every pulse has `nr_kind`". Proposal: stamp `nr_kind: 'tool_use'` (the NR that caused it) plus `derived: true`. That way the kind-map overlay (`RFC-kind-map.md` §3.1) still credits only real kinds. This is open question Q3.

#### N6 — session fields (sessions-data)

Proposed additions to `OPTIONAL_SESSION_FIELDS`:

| Field | Shape | Notes |
|---|---|---|
| `phase_counts` | `{ think, do, verify }` turn counts | |
| `transitions` | number | think→DO transitions |
| `first_burst_prompt` | number \| null | index of the human prompt that started the first Build Burst |
| `triggers` | `[{ ts, class, verb, words, gap_s, after_offer, has_process_clause, skill, outcome: { did, burst, do_count, verified } }]` | **no prompt text** (§8) |
| `resume_events` | `[{ ts, cause: 'api_error'\|'interrupt'\|'idle'\|'explicit', code, gap_s, cache_cold, cache_create_after }]` | |
| `api_errors` | number | session total |

### 4.2 Surface layer (`surface/`)

#### `/api/active` — proposed per-session additions

`surface/active-state.mjs` stays pure (the caller supplies `now`). New entry fields:

| Field | Source | Notes |
|---|---|---|
| `phase` | last `tool_call.intent` group per assistant turn | `think \| do \| verify \| null` |
| `phase_since` | ts of last `phase_shift` | → `time_in_phase_s` in snapshot |
| `lead_in` | `{ turns, tool_calls, since }` since last DO | reset on DO |
| `last_offer` | assistant ended with an offer | needs `words.preview` regex; see §5.3 |
| `last_trigger` | from `human_turn.data.trigger` | class only |
| `ripeness` | `{ state, inputs: [{ id, value, verdict }] }` | §5.4, computed in `snapshotActive` |
| `resume_hint` | `{ reason, code, resets_at, cache_cold, idle_s, est_cache_rewrite_tokens, phrasing }` | present only when stalled / errored / interrupted |
| `interrupts`, `last_interrupt` | `interrupt` pulse | |

`est_cache_rewrite_tokens` = the context size at the last `tokens` pulse, `input + cache_read + cache_create`. It is a *lower bound* on what a cold re-entry rewrites. It is only meaningful for `capabilities.tokens === true` harnesses with cache counters (CC). For Codex and Copilot it is `null` (output-only tokens, `RFC-cache-hit-rate.md`).

`cache_cold` = `idle_s > COLD_CACHE_S`. The default is 300 s (the CC 5-minute prompt-cache TTL), and it is **tunable**. The grounding only shows that warm resumes under 10 min cost 0.5–11k and two long-idle ones cost 89k / 412k. It does not locate the edge.

All of this rides the existing `now` snapshot, so there is no new channel.

#### `GET /api/triggers` — new endpoint (proposed)

Composed in `surface/http-routes.mjs` from `sessions-data.json`. It is pure aggregation in a proposed `surface/trigger-stats.mjs`:

```js
{
  generated_at,
  sample: { sessions, prompts, harnesses: { [id]: n } },
  by_class: [{ class, n, did_pct, burst_pct, median_do, verified_pct, small_n: n < 20 }],
  boosters: [{ id: 'process_clause'|'words_16plus'|'after_offer'|'gap_30s_5m',
               with: { n, did_pct, burst_pct }, without: { … } }],
  by_harness: [{ harness, burst_pct, median_first_do_s }],
  recent: [{ session_id, slug, harness, ts, class, outcome }]   // last 50, no text
}
```

`?harness=<id>` and `?project=<label>` filter. `small_n` is set when n < 20, and the UI dims those rows. This is the composer's yield source. The UI never computes yield itself.

#### Signals via the policy evaluator

`hooks/signal-evaluator.mjs` evaluates sessions-data post hoc. These proposed predicates fit that model directly (INFO/WARN only, never blocking):

| Predicate | Meaning | Example rule |
|---|---|---|
| `resumes.gt` | `resume_events.length > v` | WARN "session needed >2 resumes" |
| `api_errors.gt` | `api_errors > v` | INFO "hit a limit" |
| `failed_triggers.gt` | action-class triggers with `outcome.did === false` > v | INFO "ambiguous triggers" |
| `phase` | last phase equals v | used with `duration_min.gt` |

**Live** predicates (`idle_min.gt`, `ripeness`) do not fit a sessions-data evaluator. Proposal: a later `evaluateActive(entry, policy, now)` over the `/api/active` entry, with the same rule format and the same unsupported-predicate INFO diagnostic. It is P2-optional (Q5).

### 4.3 Experience layer — the cockpit

Register A only. Tokens come from `experience/design-tokens.mjs` (`--k-*`):

- no blue chrome, no `box-shadow`, no gradients, `border-radius` ≤ 2px, transitions ≤ 250 ms (`test/design-lint.test.mjs`);
- color is grammar.

Color mapping:

| Meaning | Token |
|---|---|
| think phase | `--k-select` (cyan) |
| do phase | `--k-accent` (orange) |
| verify phase | `--k-geo` (green) |
| ripe | `--k-geo` |
| overripe / stalled | `--k-label` (amber) |
| limit / error | `--k-err` |
| numbers | `--k-data` |
| inactive / small-n | `--k-dim` |

#### 4.3.1 Incubation gauge (on each `/now` session card)

One new row under `.modes`:

```
┌ ● ACTIVE  a1b2c3d4  kaaroSessions · master                CLAUDE-CODE ┐
│ refactor pulse emitter                                                  │
│ ▸ Read · hooks/pulse-transformer.mjs                                    │
│ PHASE THINK 2m14s  ░░░▓▓▓▓··· RIPE   lead-in 1t · 6 tools · 1m40s      │
│ mode plan · perm default                                                │
│ 412 tools · 2 err · 18.2k/min                               4s ago     │
└─────────────────────────────────────────────────────────────────────────┘
```

- `PHASE` label is `--k-label`. The phase word uses its phase color. Time in phase is `--k-data`.
- The 10-cell strip is the last 10 tool-bearing turns, one cell each, colored by phase. It is a mini ribbon, not a progress bar. `·` = no turn yet.
- The ripeness word comes from `ripeness.state`. Hover or focus shows the inputs list (§5.4) as a `title` tooltip and an expanded block in `.detail`:

```
◆ RIPENESS  RIPE
  lead-in turns     1      ✓ 1–3 (71% burst after 1)
  pause since reply 1m12s  ✓ 30s–5m (74% doing)
  plan referenced   yes    · small effect (75% vs 69%)
  offer pending     no     ·
  cache             warm   ✓ < 5m
```

Capability gate: when `capabilities.phase === false`, the row reads `PHASE —` in `--k-dim`, and nothing is guessed.

#### 4.3.2 Trigger Composer (in `.detail`, toggled with `c`)

```
◆ TRIGGER COMPOSER                                      yields from 188 local sessions
  verb  [ GO ] [ BUILD ] [ SHIP ] [ SKILL ] [ FIX ] [ REVIEW ] [ ASK ]
        ─────
  GO          94% start doing · 82% burst · median 16 DO        n=17  small
  +clause  [ TDD ] [ ATOMIC COMMITS ] [ WORKTREE ] [ SCOPE: … ]
           process clause seen with 86% doing vs 69% (n=28 — a lead, not proof)
  ┌───────────────────────────────────────────────────────────────────┐
  │ go — tdd, atomic commits                                           │
  └───────────────────────────────────────────────────────────────────┘
                                                          [ COPY ]  ⌘C
```

- Verb chips are `.k-btn`, and the selected chip is `.k-active`. Yield numbers come from `/api/triggers` `by_class`. `small_n` rows are `--k-dim` and say "small".
- `REVIEW` (`lets_think`) shows its yield **honestly**: 56% doing / 41% burst. It also shows one dim hint line: "reads first; follow with GO to act". This is information, not a block.
- The text area is editable. **COPY** writes to the clipboard. There is no send button, no API to a harness, and no keystroke injection.
- The composer never fills in the user's task. It only gives verb + clause scaffolding.

#### 4.3.3 Resume Panel (replaces the `.apierr` line when `resume_hint` is present)

```
◆ STALLED  session_limit                                           ⊘
  resets 02:30 (Asia/Kolkata)  in 1h 12m                      ▓▓▓▓▓░░░░░
  cache  COLD after 1h 40m idle — resume rewrites ≈ 214k tokens
  after interrupt-for-tool-use, plain "resume" was read as feedback (1 of 2).
  suggested:  "Continue the previous plan from where you stopped; no changes needed."
                                                                  [ COPY ]
```

- The countdown appears only when `resets_at` parsed. Otherwise `raw_reset` is shown verbatim.
- The token estimate appears only when `est_cache_rewrite_tokens != null`.
- Suggested phrasing is a small static table keyed by `reason` (`interrupt` / `session_limit` / `spend_limit` / `idle`). It lives in the surface payload, so the UI holds no harness knowledge. Copy only.

#### 4.3.4 Trigger Log (history)

- **Trace panel phase ribbon** (`experience/client/17-trace-panel.js`): a 3px ribbon under each context-window strip, one tick per assistant turn, colored by `phase`. Trigger markers (`▲` in `--k-accent`) sit at transition user turns. Hover shows `class · verb · gap`.
- **Thread view** (`experience/client/18-thread-view.js`): a chip on user turns, e.g. `TRIGGER · lets_build · build`, and phase color on assistant turn rules.
- **Yield table**: a new section on `/now` below the cards, collapsed by default (`y`). It renders `/api/triggers` `by_class` + `boosters` + `by_harness`, with the caveats line verbatim from the payload.

#### 4.3.5 Sonic cue

`phase_shift` gets an Event Registry entry (`experience/audio/event-registry.mjs`), family `context`, with a Playable Instrument:

- `think→do`: `bell`, octave +1;
- `do→think`: `pling`;
- `→verify`: `hat`.

The DAW (`19-daw-builder.js`) and the beat overlay get it through the existing Stream, with no special case. `interrupt` gets `hat`, low volume.

#### 4.3.6 Keyboard

The existing global scheme `g / n / d / m` (in `experience/pages/home.html`) stays. `/now` currently has no key handler. Proposed, active only on `/now` and ignored while a text field has focus:

| Key | Action |
|---|---|
| `j` / `k` | focus next / previous card |
| `Enter` | expand focused card |
| `c` | open Trigger Composer on focused card |
| `r` | open Resume Panel (if present) |
| `y` | toggle yield table |
| `1`–`7` | pick composer verb |
| `Ctrl/⌘+C` | copy composer text (when the composer has focus) |

### 4.4 Data flow honesty

- `phase` is a fact about tool calls. `trigger.class` is a regex guess about text. The UI labels class as "class (heuristic)" in tooltips.
- Ripeness is a rule table, not a prediction. It says which inputs fired, not "you should trigger now".

### 4.5 Per-harness support matrix

Proposed registry capability flags, read by the UI through `/api/harnesses`:

- `phase` — tool calls + shell command text are available;
- `trigger_text` — `user_turn.display_text` is present;
- `records_api_errors`;
- `records_interrupts`;
- `cache_tokens` — `cache_read` / `cache_create` are real.

| Harness | Sessions | `phase` | `trigger_text` | `records_api_errors` | `records_interrupts` | `cache_tokens` | Work needed |
|---|---|---|---|---|---|---|---|
| claude-code | 87 | yes | yes | **after N2** | **after N3** | yes | N2, N3 |
| grok | 69 | yes (categorizeBash on `raw.command`) | yes | no | no | no (tokenless) | find limit/interrupt source records |
| codex | 21 | yes (`shell_command` → `categorizeBash`; `apply_patch` → edit) | yes | no | no | no (output-only) | — |
| opencode | 28 | yes (bash `input.command`) | **no** | no | no | partial | add `display_text`; verify command text survives (DO may be undercounted) |
| pi | 13 | yes (`args.command`) | **no** | no | no | yes | add `display_text` |
| copilot | 7 | **partial** (`category: null`, no command text) | **no** | no | no | no (output-only) | command text from tool input; `display_text` |
| antigravity | 6 | yes | **no** | no | no | no | `display_text` from `USER_INPUT` |
| command-code | 1 | **no** — 0 NRs on the real session | — | no | no | no | N7 adapter bug first |

`skill` trigger class: only claude-code emits `skill_invoke` (`hooks/adapters/claude-code.mjs`). Other harnesses fall back to text matching for `/name` prefixes.

---

## 5. Algorithms

All pure, all in `hooks/`, all thresholds exported as named constants for tests and tuning.

### 5.1 Shell intent

```
shellIntent(cmd):
  if cmd is null → null
  c = first segment of cmd split on && ; | (each segment classified; max wins: mutate > verify > read)
  MUTATE  = /^git (commit|push|add|merge|rebase|reset|checkout -b|stash|cherry-pick|tag)\b/
          | /^(sed -i|mv|rm|mkdir|cp|touch|chmod|ln)\b/
          | /^(npm|pnpm|yarn) (install|i|add|remove|uninstall)\b/ | /^pip install\b/
          | /\s>{1,2}\s*\S/                       # redirect into a file
          | /^(New-Item|Remove-Item|Set-Content|Out-File|Move-Item|Copy-Item)\b/  # PowerShell
  VERIFY  = /^(npm|pnpm|yarn) (test|run (test|build|lint|check))\b/ | /^node --test\b/
          | /^(pytest|jest|vitest|cargo (test|build)|go (test|build)|tsc|make( test)?)\b/
          | /^npx (tsc|jest|vitest|playwright)\b/
  else → read
```

Windows paths and PowerShell cmdlets are explicit, because this repo's own sessions run on Windows (§8).

### 5.2 Phase and transition

```
phaseOf(turn):                          # turn = one assistant turn's tool_use NRs
  intents = turn.tools.map(toolIntent)
  do = count(mutate), ver = count(verify)
  phase    = do > 0 ? 'do' : ver > 0 ? 'verify' : 'think'
  burst    = do >= 3 || (do > 0 && ver > 0)
  verified = do > 0 && ver > 0
  unknown  = count(null)                # surfaced, never folded into think

transitions(turns):
  for i, t in assistant turns:
    if t.phase == 'do' and i > 0 and turns[i-1].phase != 'do':
      mark t.transition = true; trigger = nearest preceding user_turn
```

A turn with zero tool calls is `think`, and is counted as a zero-tool reply in trigger outcomes (§10, finding 4).

### 5.3 Trigger classification (verb-based)

```
normalize(text): lowercase, strip IDE wrappers / <tags> / image placeholders, collapse ws
classify(text, ctx):
  if ctx.skill_invoke or text starts 'base directory for this skill' or /^\/[\w-]+/ → skill
  if RESUME   /^(resume|continue|carry on|keep going|pick up)\b/            → resume
  if GO       /^(go|execute|proceed|yes|yep|do it|ship it|lgtm)\b[.! ]*$/  → go
  if GO       /^(go|yes|proceed)\b[,—-]? (and|also|but)\b/                 → go_scope
  if SHIP     /\b(commit|push|rebase|merge|open (a )?pr)\b/ and words ≤ 15 → ship
  if REPAIR   /\b(still|not working|broken|fails?|again|didn'?t)\b/       → repair
  m = /^(let'?s|lets|let us)\s+(\w+)/
  if m: verb = m[2]
    if verb in THINK_VERBS {review, brainstorm, understand, explore, discuss,
                            think, investigate, analyse, analyze, plan, look}  → lets_think
    if verb in BUILD_VERBS {build, implement, add, fix, write, create, refactor,
                            do, make, wire, ship, start, migrate, update}      → lets_build
  if text ends '?' or /^(what|why|how|can|could|should|is|are|does|do)\b/  → question
  if first word in IMPERATIVE_VERBS (BUILD_VERBS ∪ {remove, rename, move, run, test}) → imperative
  → other

flags:
  words              = token count
  gap_s              = user_turn.ts − previous assistant turn end ts
  after_offer        = prev assistant text matches /\b(want me to|shall i|should i|would you like me to)\b/
  has_process_clause = /\b(tdd|red[- ]green|atomic( commits?)?|worktree)\b/
  skill              = skill name or null
```

"The verb is the trigger": `lets_build` (77% doing) and `lets_think` (56%) share the word "let's" and differ only by verb.

### 5.4 Ripeness (deliberately simple)

Ripeness is evaluated only while `phase ∈ {think, null}` and the session is not errored. Inputs, each with a verdict `✓ / · / !`:

| Input | Rule | Default threshold (tunable) | Evidence |
|---|---|---|---|
| `lead_in_turns` | non-DO assistant turns since last DO | ✓ 1–3, ! ≥ 4 | 1 turn → 71% bursts; 4+ → 22% (n=9) |
| `pause_s` | now − last assistant reply end | ✓ 30–300 s | 30s–5m: 74% doing vs 65% |
| `plan_ref` | lead-in read/wrote a `RFC-*.md`, `*PLAN*`, `EXECUTION.md` | ✓ if yes | small: 75% vs 69% |
| `offer` | last reply ends with an offer | ✓ if yes | small: 74% vs 69% |
| `cache` | idle < `COLD_CACHE_S` | ! if cold | 89k / 412k cold vs 0.5–11k warm |

```
ripeness(inputs):
  if errored or interrupted        → stalled
  if lead_in_turns == 0            → fresh
  if lead_in_turns ≥ 4 or cache !  → overripe
  if lead_in_turns ≥ 1 and pause_s ≥ 30 → ripe
  → ripening
```

There is no weighted sum and no score. `plan_ref` and `offer` are shown but **do not change the state**, because their effects are small. The output is the state plus every input row, so the user can always see why.

As built, `stalled` uses the api-error input only: it fires when the api error is the latest agent event. `offer` is not available live, because `words.preview` holds the first 120 characters and offers sit at the end of a reply. It is omitted rather than guessed.

### 5.5 Session Health

Inputs, each with a verdict `ok / info / warn / bad / na`. Thresholds are `HEALTH_THRESHOLDS` in `surface/session-vitals.mjs`. They are conservative defaults with **no grounding yet**, and they are tunable.

| Input | Rule | warn | bad |
|---|---|---|---|
| `tool_error_rate` | failed share of the tool calls in the recent-actions ring (≥5 calls, else `na`) | ≥10% | ≥25% |
| `error_streak` | consecutive failing calls at the head of the session; each `tool_error` pairs with the latest unfailed call, so parallel calls count | ≥2 | ≥3 |
| `api_error` | last api error, and whether tools ran after it | tools resumed | no tool activity since |
| `compacts` | context compactions this session (1 = `info`) | ≥2 | — |
| `cache_hit` | `cache_read / (input + cache_read + cache_create)`; `na` without real cache counters or under 50k tokens | <60% | <30% |

```
health(inputs):
  if every row is na or a baseline (no api error, 0 compacts) → unknown
  if any bad  → degraded
  if any warn → strained
  → ok
```

---

## 6. Test plan

TDD with `node:test` + `node:assert/strict`. Inline factory fixtures (`makeNR()`, `makeTurn()`, `makeSess()`). One test file per module.

| Test file | Module | Covers |
|---|---|---|
| `test/action-keys.test.mjs` *(new)* | `hooks/action-keys.mjs` | `shellIntent` table: git read vs mutate, npm test vs install, `sed -i`, redirects, PowerShell cmdlets, chained `&&` (max wins), `null` → `null`; `toolIntent` for every key; `TOOL_ACTION_KEYS` unchanged |
| `test/adapters/claude-code.test.mjs` | CC adapter | `isApiErrorMessage` → `api_error` + `assistant_turn`, no text block; interrupt strings → `interrupt`, no `user_turn` |
| `test/analyze-helpers.test.mjs` | `classifyApiError`, `parseResetsAt` | each `code`; "resets 2:30am (Asia/Kolkata)" relative to a fixed `ts` crosses midnight correctly; garbage → `null` + `raw_reset` |
| `test/normalized-record.test.mjs` | NR contract | `interrupt` kind; `api_error.resets_at` optional |
| `test/pulse-map.test.mjs` | pulse map | `interrupt` row exists (fails until added, by design) |
| `test/adapters/nr-compliance.test.mjs` | all adapters | goldens still validate; CC golden (`hooks/adapters/golden-sessions.mjs`) gains one api-error + one interrupt record |
| `test/trigger-classifier.test.mjs` *(new)* | proposed `hooks/trigger-classifier.mjs` | each class with ≥3 positive + 1 near-miss (e.g. "let's review" ≠ `lets_build`); flags; skill turn overrides text |
| `test/session-reducer.test.mjs` | reducer | `phase_counts`, `transitions`, `triggers[].outcome`, `resume_events[]` cause + `cache_cold`; no prompt text in `triggers[]` |
| `test/trace-tree.test.mjs` | trace tree | `turns[].phase`, `.burst`, user `trigger.transition`; parity oracles unchanged for existing fields |
| `test/pulse-transformer.test.mjs` | transformer | `tool_call.intent`; `human_turn.trigger` without text; `phase_shift` from `ctx.lastPhase`; derived flag |
| `test/active-state.test.mjs` | Mission Control | `phase`, `time_in_phase_s`, `lead_in` reset on DO, every ripeness branch with injected `now`, `resume_hint` only when stalled |
| `test/trigger-stats.test.mjs` *(new)* | proposed `surface/trigger-stats.mjs` | yield math, medians, `small_n`, filters, no text in payload |
| `test/http-routes.test.mjs` | routes | `GET /api/triggers` present / absent sessions-data |
| `test/signal-evaluator.test.mjs` | evaluator | `resumes.gt`, `api_errors.gt`, `failed_triggers.gt`, `phase` |
| `test/harness-registry.test.mjs` / `test/harness-parity.test.mjs` | registry | new capability flags on all 8 descriptors; parity enforces them |
| `test/event-registry.test.mjs` | Event Registry | `phase_shift`, `interrupt` entries with Playable Instruments |
| `test/design-lint.test.mjs` | pages | unchanged rules cover the new `/now` CSS |

---

## 7. Phased delivery

Each unit follows red → green → commit (one atomic commit), with the full suite green. Checkbox style as in `EXECUTION.md` (this RFC does not edit it).

### P0 — honest raw signals (prerequisites)

- [ ] 🔴→🟢→📦 P0a: `shellIntent` / `toolIntent` in `hooks/action-keys.mjs` (+ `test/action-keys.test.mjs`)
- [ ] 🔴→🟢→📦 P0b: `classifyApiError` + `parseResetsAt` helpers; `api_error.resets_at`/`raw_reset` optional fields
- [ ] 🔴→🟢→📦 P0c: CC adapter emits `api_error` from `isApiErrorMessage`; golden updated
- [ ] 🔴→🟢→📦 P0d: `interrupt` kind (contract + pulse-map + registry entry + CC adapter + `active-state` counter)
- [ ] Exit: re-run the grounding pass → `api_error` count ≥ 11 on CC (the real limit errors); 0 interrupt strings left as `user_turn`; `/mapping` shows `api_error` ● for claude-code

### P1 — phase and trigger in the normalization flow

- [ ] 🔴→🟢→📦 P1a: new `hooks/trigger-classifier.mjs` (proposed, pure) + tests
- [ ] 🔴→🟢→📦 P1b: trace-tree `phase` / `burst` / `trigger` per turn
- [ ] 🔴→🟢→📦 P1c: reducer `phase_counts`, `transitions`, `triggers[]`, `resume_events[]`; schema optional fields
- [ ] 🔴→🟢→📦 P1d: transformer `intent` / `trigger` payload + `phase_shift` (emitter keeps `lastPhase`)
- [ ] Exit: on the local corpus, reducer reproduces §10 tables within ±2 pp (same regexes); suite green

### P2 — surface

- [ ] 🔴→🟢→📦 P2a: `active-state` phase, lead-in, ripeness, `resume_hint`
- [ ] 🔴→🟢→📦 P2b: `surface/trigger-stats.mjs` + `GET /api/triggers`
- [ ] 🔴→🟢→📦 P2c: evaluator predicates `resumes.gt`, `api_errors.gt`, `failed_triggers.gt`, `phase`
- [ ] 🔴→🟢→📦 P2d: registry capability flags + parity test
- [ ] Exit: `/api/active` and `/api/triggers` JSON verified against a live session; no new SSE event names except `phase_shift` / `interrupt`

### P3 — cockpit on `/now`

- [ ] 📦 P3a: incubation gauge row + ripeness detail (browser; extract pure helpers to `experience/client-core.mjs` and test there)
- [ ] 📦 P3b: `/now` keyboard handler (`j/k/Enter/c/r/y`)
- [ ] 📦 P3c: `phase_shift` / `interrupt` Event Registry entries + DAW lanes
- [ ] Exit: design-lint green; capability-off harness shows `PHASE —`; no `hooks/` import from `experience/`

### P4 — composer, resume panel, history

- [ ] 📦 P4a: Trigger Composer (copy-only) fed by `/api/triggers`
- [ ] 📦 P4b: Resume Panel fed by `resume_hint`
- [ ] 📦 P4c: trace-panel phase ribbon + thread-view trigger chips
- [ ] 📦 P4d: yield table section on `/now`
- [ ] Exit: no code path writes to a harness or sends input; clipboard is the only output

### As built — first vertical slice (2026-10-08, branch `kaaro/feat/now-ripeness-health`)

Landed ahead of P0b–P1, with no NR-contract change:

- [x] P0a `shellIntent` / `toolIntent` (`hooks/action-keys.mjs`, `test/action-keys.test.mjs`)
- [x] Pulse payload: `tool_call.data.intent`, `human_turn.data.prompt` (`hooks/pulse-transformer.mjs`)
- [x] `surface/session-vitals.mjs`: `assessRipeness` + `assessHealth` (`test/session-vitals.test.mjs`)
- [x] `/api/active`: `phase`, `time_in_phase_s`, `lead_in`, `ripeness`, `health` (`surface/active-state.mjs`)
- [x] Registry `capabilities.phase` (copilot `false`)
- [x] `/now`: vitals line on each card, plus ripeness/health input rows in the expanded detail (`experience/client-core.mjs` helpers)

Ontology impact of the slice:

| Layer | Change |
|---|---|
| NR contract | none (`interrupt` and the `api_error` fields are still P0b–P0d) |
| Canonical Action Keys | unchanged; `intent` sits beside `key` |
| Stream | two payload fields; no new event names; `nr_kind` untouched |
| Snapshot (`/api/active`) | five per-session fields |
| sessions-data schema | none |
| Registry capabilities | `phase` |

**Later:** N7 (command-code 0 NRs); `display_text` for pi / opencode / copilot / antigravity; `evaluateActive` live signals; non-CC `api_error` sources.

---

## 8. Risks and open questions

### Risks

| Risk | Mitigation |
|---|---|
| **Privacy of prompt text** | `triggers[]`, pulses and `/api/triggers` carry class, verb (one word from a fixed list or `null`), counts and flags. They never carry prompt text. sessions-data already holds `first_user_message`; this adds nothing more. Everything stays local. OTLP emission (EXECUTION Items 8–10) must not export `trigger.verb` without opt-in. |
| **Classifier drift** | Regexes live in one module with a fixture per class. About a third of prompts are `other`, and the yield table shows the `other` row so the gap stays visible. Harness wrapper formats change, and `nr-compliance` goldens catch adapter-side drift. |
| **Goodhart on "yield"** | Yield measures "did work next", not "did the right work". The composer shows yield next to its caveat line and never ranks the user. There is no streak or score. |
| **Ethics of nudging** | Every surface is informational and copy-only. Ripeness never says "trigger now". It shows input rows. REVIEW keeps its chip; thinking prompts are legitimate. |
| **Thresholds from small n** | Every threshold is a named, exported constant marked tunable. `small_n` (n < 20) dims rows. The process-clause lead (n=28) and 4+-turn lead-in (n=9) are labelled as leads. |
| **Windows paths and shells** | `shellIntent` covers PowerShell cmdlets. Paths in `plan_ref` matching use `.replace(/\\/g, '/')` per CLAUDE.md. |
| **Time-of-day bias** | ~86% of transitions fall between 20:00 and 05:00 local time, and the corpus is one person's. Yields reflect one working style, and the UI says "from N local sessions". |

### Open questions

- **Q1.** Keep intent orthogonal to `TOOL_ACTION_KEYS` (proposed), or split `bash_other` into `bash_mutate | bash_verify | bash_read` keys at the cost of an Event Registry migration?
- **Q2.** Should `interrupt` replace the `user_turn` (proposed) or sit beside it? Replacing changes `user_turns` counts on old sessions.
- **Q3.** `phase_shift` is derived, not an NR. Is `nr_kind: 'tool_use'` + `derived: true` acceptable to the kind-map, or should derived pulses carry no `nr_kind`?
- **Q4.** `COLD_CACHE_S`: 300 s (CC default TTL) or 3600 s (1-hour cache)? This needs per-harness data and possibly a registry field.
- **Q5.** Live signals: extend the evaluator to `/api/active` entries now, or wait for P4 usage?
- **Q6.** Should `go` after an assistant offer count as a trigger of the offer's verb? (Small effect: 74% vs 69%.)

---

## 9. Out of scope

- Sending prompts, keystroke injection, harness control of any kind.
- LLM-generated trigger suggestions.
- Cross-user or remote yield aggregation.
- Quality, correctness or rework scoring.

---

## 10. Appendix — grounding

### 10.1 Method

- **Corpus:** all 232 sessions across the 8 harnesses, read through the registry's `readSessionRecords` → adapter → NormalizedRecords. Read-only; nothing in the repo was changed.

  | Harness | Sessions |
  |---|---|
  | claude-code | 87 |
  | grok | 69 |
  | opencode | 28 |
  | codex | 21 |
  | pi | 13 |
  | copilot | 7 |
  | antigravity | 6 |
  | command-code | 1 |

- **Noise removed:** IDE wrappers, `/context` dumps, image placeholders, repeated Pi prompts. Result: **920 human prompts in 188 sessions**.
- **Action classes:** from `tool_use` via `toolNameToKey` plus bash command text. DO = write/edit or mutating shell (`git commit/push/add/merge`, `sed -i`, `mv`, `rm`, `mkdir`, `npm install`). VERIFY = test/build commands. THINK = everything else.
- **Build Burst:** a turn with ≥3 DO actions, or DO + VERIFY. **Transition:** the first DO turn after ≥1 non-DO turn.

### 10.2 Findings

**1. Phase mix.**

- 67% of turns contain any DO; 44% are Build Bursts.
- 137 think→DO transitions (86 into a burst). 121 sessions start doing on the first prompt.
- First burst of a session: prompt 0 in 69 sessions, prompts 1–2 in 41, prompt 3+ in 11.
- Lead-in before a transition: median 1 turn, 4 tool calls, ~1 min. Human pause before the trigger: median 77 s.
- Users think mostly *inside* the prompt, not across turns.

**2. Trigger yield** (prompts after the first in a session).

| Trigger class | n | Starts doing | Starts burst | Median DO actions |
|---|---|---|---|---|
| bare go (`go`/`execute`/`proceed`/`yes`/`do it`) | 17 | 94% | 82% | 16 |
| "let's" + build verb | 62 | 77% | 58% | 5 |
| go + scope ("yes, and also…") | 11 | 73% | 55% | 8 |
| ship (`commit`/`push`/`rebase`) | 46 | 85% | 52% | 3 (57% commit) |
| skill invocation | 34 | 91% | 53% | 3 |
| imperative | 80 | 68% | 46% | 4 |
| "let's" + think verb | 27 | 56% | 41% | 3 |
| resume | 12 | 67% | 42% | 7 |
| question | 43 | 40% | 28% | 4 |
| repair ("still not working") | 24 | 54% | 29% | 3 |

The verb is the trigger, not the word "let's".

**3. First-burst sources.**

- Only 31% of first bursts were started by an explicit go-phrase.
- The largest source (40 of 121) was unframed descriptive prompts.
- Skill-injected turns started 38- and 41-action bursts; phrase matching misses them.

**4. Failed triggers.**

- 24% (62/256) of action-style prompts produced neither DO nor VERIFY: 51 read-only investigations and 11 zero-tool replies. Mostly "let's review/brainstorm/understand".
- By harness: Grok 30, Claude Code 22.
- Users re-prompted after 54 of 62.

**5. Boosters.**

| Factor | Effect |
|---|---|
| Process clause (tdd/atomic/worktree/red-green) | 86% start doing vs 69%; burst 68% vs 46%; median DO 8 vs 4; commits 46% vs 12% — **n=28, a lead, not proof** |
| Prompt length 16+ words | 76% doing / 54% burst vs 63% / 41% for 4–15 words |
| Assistant offer ("want me to…") | small: 74% vs 69% |
| Plan/RFC reference | small: 75% vs 69% |
| Human pause 30s–5m | best, 74% doing vs 65% for <30s and for >5m |
| Lead-in | 1 thinking turn → 71% bursts; 4+ turns → 22% (n=9) |

**6. Harness differences.**

| Harness | Burst | First DO action | Other |
|---|---|---|---|
| claude-code | 56% | ~40 s | median 5 DO actions |
| grok | 37% | ~74 s | |
| codex | 35% | | rework 13% (weak detector) |
| antigravity | 36% | | |
| opencode, pi, copilot | ≤17% | | small n; possibly undercounted (shell text may be missing) |

About 86% of transitions occur between 20:00 and 05:00 local time.

**7. Resume** (14 resume-style prompts: claude-code 9, grok 3, codex 2).

- API-error-triggered resumes (session limit, monthly spend limit, content filter): 6 of 14. All 6 acted at once, median 22 tool calls.
- After an interrupt-for-tool-use, "resume" was misread as feedback: 1 stalled, 1 reframed.
- Two long-idle re-entries paid full cold-cache rewrites: 89k and 412k `cache_creation` with `cache_read=0`. Warm resumes under 10 min cost 0.5–11k.
- 11 real API-limit errors: 6 got a "resume", 2 were re-woken by a subagent task-notification, 1 was abandoned, 1 moved on after 9.5 h, 1 session ended.
- Session-limit text includes the reset time ("resets 2:30am (Asia/Kolkata)").

**8. Tooling gaps.**

- (a) No adapter emits `api_error`. CC `isApiErrorMessage` records are not read, so there are 0 `api_error` NRs across 232 sessions.
- (b) "[Request interrupted by user for tool use]" is not a distinct NR.
- (c) The command-code adapter yields 0 NRs on its 532 KB session.
- (d) `bash_other` mixes mutating, verifying and read-only shell commands, so phase cannot come from action keys alone.

### 10.3 How to reproduce

1. For each `HARNESS_IDS` entry, list sessions with the scanner, then call the registry's `readSessionRecords` and that harness's adapter to get NRs.
2. Group NRs into turns (user turn → following assistant turns until the next user turn).
3. Class each `tool_use` with `toolNameToKey` + the §5.1 shell rules on `input.command`.
4. Strip noise from `display_text`, then class prompts with the §5.3 regexes.
5. Compute outcomes on the *next* assistant turn(s) before the next human prompt.
6. Join `tokens` NRs around resume prompts for cache cost. Match API-error text patterns, and hand-check the matches (one false positive was excluded).

After P1 the reducer should reproduce these tables directly. That is P1's exit criterion.

### 10.4 Caveats

- Prompt classes come from regexes; about a third of prompts remain `other`.
- Several classes have small n (see the n column; boosters flagged).
- Rework detection is weak, so no quality claims are made.
- Some turn durations include idle spans (one was 3 days), so medians are used throughout.
- Shell command text may be missing for non-CC harnesses, so DO may be undercounted there.
- API errors were detected with text patterns; one false positive was excluded.
- One person's corpus, mostly late-night sessions. Yields describe this user, not users in general.
