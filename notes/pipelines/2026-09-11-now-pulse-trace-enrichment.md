---
published: false
title: "/now pulse + trace enrichment — Mission Control intelligence"
tags: [kaaro-sessions, pipeline, now, mission-control, pulse, trace, tdd]
description: "Phase plan to enrich /now with live context pressure, proportional ContextTree strips, compact-driven cache invalidation, and typed thinking/attachment/scaffold pulses. TDD order locked."
date: 2026-09-11
layer: L3-Principle
maturity: BUDDING
para: Pipeline
branch: kaaro/feat/now-and-improved-with-trace
---

# `/now` pulse + trace enrichment

**Status:** done (P0 + P1)  

**Branch / worktree:** `kaaro/feat/now-and-improved-with-trace`  
**Discipline:** TDD — red → green per phase  
**Surface only:** `/api/active`, SSE `now`, `/api/trace`, `/api/harnesses`

```text
pulses → applyPulse(active-state) → throttled SSE "now" → /now cards
expand → /api/trace → proportional colored context strip
compact → invalidate traceCache → honest windows
```

---

## Scope

| In | Out |
|---|---|
| `last_tokens` + context pressure bar | Tail Origin / first-sight emitter policy |
| Proportional `ctxStrip` via `contextStripSegments` | Claude bookkeeping → `session_meta` map |
| Compact → trace cache invalidation | Thread embed / prefetch-all (P2) |
| Typed `thinking` / `attachment` / `scaffold` | `/api/signals` strip (P2) |
| `MIN_STRIP_PCT = 5` | Per-pulse SSE on `/now` (keep snapshot consumer) |

---

## Phases

| Phase | Work | Tests | Status |
|---|---|---|---|
| **0** | This note | — | done |
| **1** | `last_tokens` on tokens pulse (overwrite, not sum) | `test/active-state.test.mjs` | done |
| **2** | Typed thinking / attachment / scaffold + ring | `test/active-state.test.mjs` | done |
| **3** | `MIN_STRIP_PCT=5` + strip model extras | `test/client-core.test.mjs` | done |
| **3b** | Optional: panel uses `contextStripSegments` | client-core parity | deferred |
| **4** | `now.html` pressure, strip, invalidate, chips | design-lint + browser | done |
| **5** | `docs/PULSE-SOURCE-SINK.md` + mark done | — | done |

### Phase 1 contract

```js
last_tokens: { input, cache_read, ts } | null  // null until first tokens pulse
```

Cumulative `tokens.*` unchanged. Pressure UI must use `last_tokens`, never sums.

### Phase 2 contract

```js
thinking_count, last_thinking_ts
attachments, scaffolds
// ring: { type:'thinking'|'attachment'|'scaffold', ts, … }
```

### Phase 3 contract

`MIN_STRIP_PCT = 5` (skill / panel). Optional strip fields: `index`, `isCurrent`, `badges`.

---

## Visual encoding (CSS class ontology)

Mission Control classes are **grammar**, not decoration. Pure helpers in `client-core.mjs` (Node-tested):

| Helper | Encodes |
|---|---|
| `sessionCardClasses(s, {expanded})` | `mc-card--active\|idle`, `--evt-{pulse}`, `--alert`, `--pressure-{lo\|mid\|hi}`, `--thinking-live`, `--open` |
| `actionItemClasses(a)` | `mc-act--{pulse}`, `--err` |
| `pressureTier` / `pressureFillClasses` | fill tier for context meter |
| `ctxSegClasses` | `mc-ctxseg--cur` |

### Card IA zones (mapping-inspired — cells over prose)

```text
mc-card
  __hero    MOST RECENT: ● LIVE|○ IDLE · event/key · file · ago
  __who     slug · project · harness (+ title/modes)
  __alert   errors line (never full-card border)
  __tools   Canonical Action Key chips (read 12 · bash_run 5 · …)
  __load    tok / burn / secondary · pressure meter
  __detail  pulse feed · context windows
```

Helpers: `sessionRecencyHero`, `sessionToolChips`, `tools_by_key` on active-state.
Left rail = idle vs latest pulse. Hero label for `tool_call` = canonical key (not buried in a tool line).

**Legend:** live / latest / tools / ctx / flag — same swatch grammar as mapping marks.

## TDD loop

```text
RED → GREEN → refactor
node --test test/active-state.test.mjs test/client-core.test.mjs
# after UI:
node --test test/design-lint.test.mjs
```

---

## Links

- Plan session: `/now` pulse+trace enrichment plan  
- Sink table: `docs/PULSE-SOURCE-SINK.md`  
- Strip pattern: `notes/skills/proportional-strip-ui.md`  
- Flood / Tail Origin sibling: `notes/pipelines/2026-09-10-first-sight-unknown-flood.md` (main workspace; may not be on this branch yet)
