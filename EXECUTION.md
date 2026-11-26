# EXECUTION.md — Plan & Execution Tracker (Agent-First)

> **Who this is for:** any agent (or human) picking up this work cold.
> Every item is broken into TDD units. A unit is not done until its cycle is:
> **🔴 red** (failing test committed to working tree) → **🟢 green** (minimal code passes) →
> **📦 commit** (one atomic commit per unit, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`).
> Never batch units into one commit. Never write code before its failing test.
>
> **Ground rules** (from CLAUDE.md + project memory):
> - `node --test` must be green before every commit (full suite, <5 s, zero npm deps).
> - Deprecated code moves to `ARCHIVE/`, never `@deprecated` markers.
> - `experience/` must NOT import from `hooks/` — verified boundary, keep it.
> - Update this file's checkboxes as part of each unit's commit.

**Plan origin:** approved 2026-07-19 (plan file `elegant-splashing-token.md`).
**Baseline at start:** master fast-forwarded to `44a22cc`, 1500 tests green.

---

## Item 1 — Merge stack to master + CI ✅ DONE

- [x] Fast-forward `master` to `kaaro/feat/session-clusters` tip (`44a22cc`), push
- [x] `.github/workflows/test.yml` — `node --test`, matrix Node 18/20/22, push+PR (`63a0980`)
- [x] Verify: Action run 29698488417 → **success** on all three Node versions

Notes: remote moved to `https://github.com/karx/kaaroSessions.git` (old URL redirects).
`node:sqlite` (copilot index) degrades gracefully pre-22.5 — test self-skips, matrix safe.

## Item 2 — Pi re-scope: close TODO #1 as data-absent ✅ DONE (`afe9867`)

- [x] 🔴 `test/adapters/pi.test.mjs`: `thinking_level_change` → `mode_shift` NR (`mode: "thinking:<level>"`)
- [x] 🟢 `hooks/adapters/pi.mjs`: handle `thinking_level_change`
- [x] Docs: TODO.md #1 rewritten as resolved/data-absent; CLAUDE.md coverage gap + docs/harnesses.md Pi row updated
- [x] 📦 One commit, suite 1501 green

Grounding (2026-07-19 survey of all local Pi transcripts): raw format has ONLY
`session` / `model_change` / `thinking_level_change` / `message` record types.
`context_resets`, `ai_title`, `subagent_count`, `branches` do not exist in Pi data —
registry `false` capability flags are honest. Do not reopen without new Pi format evidence.

## Item 3 — Token arithmetic → single source in enrich-session ✅ DONE

**Design (locked during exploration):**
- `hooks/enrich-session.mjs` is the ONLY place token arithmetic lives:
  - export `tokensWork(t)` = `(t?.output || 0) + (t?.cache_create || 0)`
  - `enrichSession(sess)` additionally sets `sess.tokens_work = tokensWork(sess.tokens)`
  - new export `enrichProject(proj)` sets `proj.tokens_work` + `proj.tokens_total`
- `surface/analyze-orchestrator.mjs` `buildSessionsOutput()` calls `enrichProject` on every
  merged project (single choke point — per-harness analyzers already call `enrichSession`).
- `experience/graph-pipeline.mjs` becomes **strict passthrough**: session nodes use
  `sess.tokens_work || 0`; project nodes use `proj.tokens_work` / `proj.tokens_total`;
  timeline uses `s.tokens_work || s.tool_calls || 0`; `MAX_WORK` from `s.tokens_work`.
  The `experience/ → hooks/` import boundary stays clean (no imports — passthrough only).
  Test fixtures in `test/graph-pipeline.test.mjs` gain `tokens_work` (they model
  post-enrich data). sizeNorm tool_calls fallback for tokenless harnesses is sizing
  policy, not arithmetic — it stays in the pipeline.
- `hooks/sessions-schema.mjs`: document `tokens_work` in `OPTIONAL_SESSION_FIELDS`
  (derived by enrich, consumed as passthrough).

**Units:**
- [x] 🔴→🟢→📦 Unit 3a: `test/enrich-session.test.mjs` — `tokensWork` helper + `enrichSession` sets `tokens_work` + `enrichProject` sets project fields; implement in `hooks/enrich-session.mjs`; wire `enrichProject` into `surface/analyze-orchestrator.mjs` (+ orchestrator test asserts projects carry `tokens_work`) — suite 1505
- [x] 🔴→🟢→📦 Unit 3b: `test/graph-pipeline.test.mjs` — passthrough proof (fixture `tokens_work: 999` ≠ formula → node carries 999) + missing passthrough coverage for `tools_top`, `context_resets`, `ai_title`, `subagent_count`, `branches` (closes CLAUDE.md gap); make pipeline strict-passthrough; update fixtures to enriched shape — suite 1513
- [x] 📦 Unit 3c: schema doc for `tokens_work` + CLAUDE.md "Known coverage gaps" update (rode with 3b commit)
- [x] Verify: `node analyze.mjs && node build.mjs` — 30 real sessions, nodes carry enriched tokens_work (spot-checked graph-data.json)

## Item 4 — Policy pillar phase 1 (W-POL-01/02/03 + /api/signals) ✅ DONE

Signals only — auditor, never gatekeeper. Predicates needing W-OBS-02 attribution
(`tools.contains`) are OUT of scope; evaluator skips unknown predicates with an
INFO diagnostic (visible, not silent).

- [x] 🔴→🟢→📦 Unit 4a: `hooks/policy.mjs` loader/merger (`aa4c078`) + BOM-tolerance
      follow-up unit (PowerShell writes UTF-8 BOM; loader strips it)
- [x] 🔴→🟢→📦 Unit 4b: `hooks/signal-evaluator.mjs` — 7 predicates, first match wins,
      diagnostic signals, `buildSignalsData` W-REP-02 payload (`0491e85`)
- [x] 🔴→🟢→📦 Unit 4c: `analyze.mjs` writeOutput → `signals-data.json` every run
      (empty payload included), gitignored (`fb03dc5`)
- [x] 🔴→🟢→📦 Unit 4d: `GET /api/signals` route + serve.mjs paths.signals; tests on
      ephemeral ports (present-file + absent-file cases)
- [x] Verify end-to-end: sample `.agents/policy.json` → analyze emitted 31 signals
      (1 rule match + 30 visible diagnostics for the deliberately-unsupported
      `tools.contains`); live `serve --port=3399` → `/api/signals` returned the payload
- [x] W-REP-01 graph overlay: explicitly OUT of scope (next batch)

Refinement noted for next batch: diagnostics are per-session (30× for one bad rule) —
consider deduping diagnostics per rule in `buildSignalsData`.

## Item 5 — DX batch (one commit) ✅ DONE

- [x] 🔴→🟢 `orderClientModules()` in `build.mjs`: filenames must be `NN-name.js`
      (two-digit prefix) or the build throws; tested in `test/build.test.mjs`
      including a sweep over the real `experience/client/` dir
- [x] Split comment at the definition site (`hooks/helpers/analyze-helpers.mjs`)
      + schema field contract (`hooks/sessions-schema.mjs`) for `skills[]` vs
      `builtin_commands[]`
- [x] TODO.md refresh: header count 1436 → 1544+, CI + policy noted, items #2/#4/#6
      struck as resolved with pointers
- [x] Verify: full suite green + real `node build.mjs` exits 0 with the assertion live
- [x] 📦 Single commit for the batch

---

# Batch 2 — approved direction: half policy, half OTLP (2026-07-20)

User choices: the two highest-value policy items (attribution + severity-ring overlay),
then start the OTLP emission path (CONTEXT.md 2026-06 locked decision,
`RFC-observability-surface.md` — fully spec'd, zero code as of batch start).

Grounding (verified 2026-07-20):
- `skill_invoke` NRs exist with `ts` (claude-code.mjs:127) but only from `<command-name>`
  scanning; the CC adapter emits generic `attachment` NRs without extracting
  `invoked_skills` skill names (W-OBS-01's reliable source).
- The `tools.contains` predicate currently yields per-session INFO diagnostics
  (verified live: 30 for one rule) — attribution makes it evaluate for real.
- `build.mjs` side-file pattern to copy: `loadClusterOverrides`. Node annotation is
  centralized in `experience/graph-pipeline.mjs`.
- RFC locks: pure-Node OTLP/HTTP **JSON** (no protobuf, no deps, global fetch),
  Stream first (tool_call→Span, tokens→Metric, words→LogRecord), Snapshot as
  normalized LogRecords after rebuild, one resource per deployment
  (`kaaro.deployment.harnesses`), `harness` + `session.id` +
  `kaaro.snapshot.generation` on every signal.

## Item 6 — Skill timeline + tool-to-skill attribution (W-OBS-01/02) ⬜ PENDING

- [x] 🔴→🟢→📦 Unit 6a: CC adapter — `attachment.type === 'invoked_skills'` →
      one `skill_invoke` NR per skill (ts kept); `<command-name>` scan remains as
      fallback source; test in `test/adapters/claude-code.test.mjs`
- [x] 🔴→🟢→📦 Unit 6b: reducer — `skill_timeline: [{skill, ts}]` (chronological) +
      `skill_attribution: {<skill>: {tool_calls, tools{}, errors}}`; window opens at
      each `skill_invoke`, closes at next `skill_invoke` — and does NOT survive a
      `context_reset` (test this); BUILTIN_COMMANDS excluded; `{}`/`[]` defaults;
      add both to `OPTIONAL_SESSION_FIELDS` + schema doc block
- [x] 🔴→🟢→📦 Unit 6c: evaluator — `tools.contains` predicate (rule form
      `{ skill: X, 'tools.contains': Y }` → attribution[X].tools[Y]); keep INFO
      diagnostic when attribution data absent; **rider**: dedupe diagnostics per
      rule (not per session) in `buildSignalsData`
- [ ] Verify: sample policy with `tools.contains` rule → real evaluations, no
      per-session diagnostic spam

## Item 7 — Graph signal overlay, severity rings (W-REP-01) ⬜ PENDING

- [ ] 🔴→🟢→📦 Unit 7a: `buildGraph(data, { signals })` annotates session + project
      nodes `{ signals, max_signal, signal_ids[] }`; absent → zero defaults; unknown
      session_ids ignored; tests in `test/graph-pipeline.test.mjs`
- [ ] 🔴→🟢→📦 Unit 7b: `loadSignalsData()` in `build.mjs` (mirror
      `loadClusterOverrides`: absent/malformed → null, build never fails) + pass to
      `buildGraph`; test in `test/build.test.mjs`
- [ ] 📦 Unit 7c (browser, no Node tests): severity ring in
      `experience/client/04-rendering.js` (INFO dim → ALERT bright; **load the
      `kaaro-design` skill before any CSS/colors**; design-lint forbids blue chrome);
      counts + rule ids in tooltip/panel (`05-interaction.js`); CSS in
      `experience/pages/template.html`
- [ ] Verify: sample policy → analyze → build → `/graph` shows rings, panel lists
      rules; remove sample policy afterward

## Item 8 — OTLP encoder, pure zero-dep (RFC phase 2) ⬜ PENDING

- [ ] 🔴→🟢→📦 new `surface/otlp-encoder.mjs` + `test/otlp-encoder.test.mjs`:
      `buildResource(harnesses, opts)`; `pulseToOtlp(pulse, ctx)` →
      `{ kind: span|metric|log, payload }` (tool_call→Span `tool.{name}`,
      tokens→Sum `kaaro.tokens.*`, words→LogRecord, others→LogRecord with
      `event.type`); `snapshotToLog(sessionsData, generation)`; common attrs on
      every signal; OTLP/HTTP JSON envelopes (`resourceSpans`/`resourceMetrics`/
      `resourceLogs`). Pure — no I/O, no Date.now (caller passes generation/ts)

## Item 9 — OTLP stream emission wiring (RFC phases 3+5) ⬜ PENDING

- [ ] 🔴→🟢→📦 new `surface/otlp-emitter.mjs` + `test/otlp-emitter.test.mjs`:
      `createOtlpEmitter({ endpoint, headers, fetchFn })` — batches pulses
      (coalesce like pulse-emitter), POSTs to `<endpoint>/v1/{traces,metrics,logs}`
      via injected fetchFn; network errors warn + swallow (never breaks serve);
      no-op when endpoint absent; `flush()`
- [ ] 📦 Wire in `serve.mjs`: `--otlp-endpoint=` / `OTLP_ENDPOINT` env
      (+ `OTLP_HEADERS` JSON env); emit beside SSE notify. Off by default —
      local mirror unchanged

## Item 10 — OTLP snapshot emission + consumer docs (RFC phases 4+6) ⬜ PENDING

- [ ] 🔴→🟢→📦 Unit 10a: `emitSnapshot(sessionsData)` — one `resourceLogs` POST,
      full normalized body, monotonic `kaaro.snapshot.generation`; subsequent
      stream signals carry the same generation (correlation contract)
- [ ] 📦 Unit 10b: hook into rebuild-success path (serve.mjs /
      `surface/rebuild-orchestrator.mjs` callback) when OTLP configured
- [ ] 📦 Unit 10c: `docs/OTLP.md` (config, example Collector config, signal
      reference table); update CLAUDE.md + CONTEXT.md status (OTLP Emission:
      implemented for Stream + Snapshot)
- [ ] Verify end-to-end: throwaway local HTTP sink (scratchpad script printing
      request paths/bodies) + `node serve.mjs --otlp-endpoint=http://127.0.0.1:4318
      --no-open` → touch a session file → span/metric/log POSTs arrive + one
      snapshot log after rebuild

**Sequencing:** 6→10; items 6–7 independent of 8–10; 9 depends on 8; 10 on 9.
**Risk watch:** attribution across `context_reset` (decided: window dies at reset —
test it); snapshot log payload size (30+ sessions ≈ MBs — acceptable per RFC "full
shape preferred"; gzip noted as future work).

## Item 11 — Merge readiness: fork DAW audio + session vitals 🟡 IN PROGRESS (Phases 0–3, 4.1/4.2 ✅ — merge gates closed)

Phase-wise plan with rationale, direction and end hypotheses:
[`PLAN-merge-fork-daw-audio.md`](PLAN-merge-fork-daw-audio.md). Branch
`kaaro/merge/fork-daw-audio`. Phases 0–3 + 4.1/4.2 gate the merge; 4.3 + 5 follow-up.

---

## Status log

| When (UTC) | Event |
|---|---|
| 2026-07-19 | Plan approved; Item 1 done (CI green run 29698488417); Item 2 done `afe9867`, suite 1501 |
| 2026-07-19 | Item 3 design locked (strict passthrough + enrichProject in orchestrator); units 3a–3c pending |
| 2026-07-19 | Item 3 done (`96cfc1a`, `6f397e6`); Item 4 done (`aa4c078`, `0491e85`, `fb03dc5`, `e381eba`) incl. BOM fix + live /api/signals verification |
| 2026-07-20 | Item 5 done; suite 1549 green; **all 5 items complete** — next batch candidates: W-REP-01 graph signal overlay, diagnostic dedupe, OTLP emission (deferred by choice), W-COG-07 content-aware pitching |
| 2026-07-20 | Batch 2 planned (items 6–10): user chose half policy (attribution W-OBS-01/02 + severity-ring overlay W-REP-01) / half OTLP (encoder, stream emitter, snapshot emission per RFC). Not started. |
| 2026-07-20 | Unit 6a done: CC adapter extracts `invoked_skills` → `skill_invoke` NRs (attachment NR kept; command-name fallback retained); suite 1552 |
| 2026-07-20 | Unit 6b done: reducer skill_timeline + skill_attribution (window dies at context_reset; BUILTIN excluded); suite 1558 |
| 2026-07-20 | Unit 6c done: tools.contains predicate + diagnostic dedupe per rule in buildSignalsData; suite 1565 |
