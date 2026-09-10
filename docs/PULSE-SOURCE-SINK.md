# Pulse Source and Sinks — Current Record Trace

**Focus:** One source, one process, many sinks. Visualization must not depend on Web Audio.
**Status:** Current architecture (post NR-unified pulses), with the client dispatcher split so the beat ring is independent of `AudioContext`.
**Primary modules:** `hooks/adapters/*` → `hooks/pulse-transformer.mjs` → `surface/pulse-emitter.mjs` → SSE → `experience/client/13-live-updates.js` → `playPulse` → beat ring **and** audio scheduler.

---

## 1. Source vs sinks

```
SOURCE                          PROCESS                         SINKS (independent)
──────                          ───────                         ───────────────────
harness JSONL / JSON
        │
        ▼
adapter → NormalizedRecord[]    (harness hop; sonic-unaware)
        │
        ▼
pulse-transformer               Pulse { event, data }           ─► active-state  (Mission Control)
        │                         Stream vocabulary              ─► SSE hub
        ▼                                                       │
SSE event: <pulse.event>                                        │
data: pulse.data                                                │
        │                                                       │
        ▼                                                       │
13-live-updates  (subscribe)                                    ├─► ticker text
        │                                                       │
        ▼                                                       │
playPulse                                                       │
  encode: resolveSonic(event, data)                             ├─► beat ring     (viz)
  fan-out                                                       └─► schedVoice    (audio)
```

**Source (one):** the Stream. Produced by `surface/pulse-emitter.mjs`. Raw JSONL is not a source for viz or audio.

**Process (one):** `resolveSonic` maps a Stream pulse to sounding parameters (key, family, instrument, pan, brightness, vol). It does not push the ring and does not start an oscillator.

**Sinks (many, no edges between them):**

| Sink | Module | Clock | Gated by |
|---|---|---|---|
| Mission Control | `surface/active-state.mjs` | server `now` | `session_id` present |
| Ticker | `13-live-updates.js` | arrival | SSE listener + `pulseTickerEntry` |
| Beat ring (viz) | `14-pulse-audio.js` `_pushToBeatRing` | arrival `Date.now()` on `ev.ts` | pulse type only |
| Audio scheduler | `14-pulse-audio.js` `schedVoice` / `_flushBatch` | AudioContext `currentTime` on `ev.heardAt` | unmuted **and** `ac()` |

Sinks do not feed each other. The ring does not wait for an oscillator. The oscillator does not create the ring entry. `_flushBatch` may stamp `heardAt` onto an entry that is **already** on the ring; it must not be the first (or only) push.

Lifecycle SSE (`status`, `updated`, `error`, `now`) is not a pulse. It is a different source (rebuild / snapshot) and is out of this table.

---

## 2. Push → process → propagate

| Stage | Where | What moves |
|---|---|---|
| **Push** | watch → `tailAndPulse` / `jsonAndPulse` | new raw records for one file |
| **Hop** | harness `adapter(records)` | `NormalizedRecord[]` |
| **Process (server)** | `normRecordsToPulses` | `{ event, data }[]` — one pulse per NR (catch-all `unknown` if unmapped) |
| **Propagate (server)** | `emitPulses` | `applyPulse` then `hub.notify(event, JSON.stringify(data))` |
| **Push (client)** | `EventSource` listener | `playPulse(event, data)` and/or `tickerAdd` |
| **Process (client)** | `resolveSonic` | encoded pulse (`key`, `fam`, instrument, pan, …) |
| **Propagate (client)** | fan-out | viz sink always; audio sink if unmuted and `ac()` |

The 80 ms `_flushBatch` timer is a **playback** convenience (snap onto the beat grid). It is not the Burst clock. Burst = pulses that share Recorded Time (`data.ts` from the NormalizedRecord). See CONTEXT.md.

---

## 3. Two clocks on one ring object

A beat-ring entry is a **viz record**. Audio may annotate it; it must not own it.

| Field | Owner | Meaning |
|---|---|---|
| `ev.ts` | viz sink | arrival wall time — block `x` in the feed and DAW |
| `ev.heardAt` | audio sink | AudioContext time the oscillator starts — amber outline |
| `data.ts` | Stream | Recorded Time from the harness — burst grouping, not the feed `x` |

Rewriting `ev.ts` to the scheduled wall time would jump an already-drawn block off the right edge. Audio only stamps `heardAt`.

---

## 4. Current record trace — NormalizedRecord → pulse → sinks

Transformer: `hooks/pulse-transformer.mjs`. Registry types: `experience/audio/event-registry.mjs`. Client SSE: `13-live-updates.js`.

Legend: **Y** = this sink receives it today. **—** = produced upstream but this sink does not subscribe or does not encode. **last_seen** = Mission Control bumps the session but has no typed counter.

### Tool and token path

| NR kind | Pulse `event` | `data.key` / notes | MC | Ticker | Beat ring | Audio |
|---|---|---|---|---|---|---|
| `tool_use` | `tool_call` | Canonical Action Key from `nr.tool + nr.category` | Y | Y (tool + file) | Y | Y (unless filter/`off`) |
| `tokens` | `tokens` | MC also stamps `last_tokens` (latest absolute `input`+`cache_read`, overwrite) for context pressure | Y | — | Y | Y |
| `assistant_turn` and `capabilities.tokens === false` | `tokens` | `synthetic: true`, `output ≈ content_length/4` | Y | — | Y | Y |
| `content_block` text ≥ 3 words | `words` | preview, word_count | Y | Y (quoted preview) | Y | Y |
| `content_block` text < 3 words | `chirp` | preview, word_count | Y (counts as words) | — (explicitly null) | Y | Y |

### Cognition / structure

| NR kind | Pulse `event` | MC | Ticker | Beat ring | Audio |
|---|---|---|---|---|---|
| `user_turn` | `human_turn` | Y | Y | Y | Y |
| `context_reset` | `compact` | Y | Y | Y | Y |
| `permission_mode` | `permission` | Y | Y | Y | Y |
| `mode_shift` | `mode_shift` | Y | Y | Y | Y |
| `attachment` | `attachment` | Y (count + ring subtype) | — | Y | Y |
| `scaffold` | `scaffold` | Y (count + ring preview) | — | Y | Y |
| `tool_result` (`error: true`) | `tool_error` | Y | Y | Y | Y |
| `tool_result` (ok) | `tool_result` | last_seen | — | — | — |
| `api_error` | `api_error` | Y | Y | Y | Y |
| `content_block` thinking | `thinking` | Y (count + ring, no text) | — | Y | Y |
| `content_block` unclassified `block_type` / `unknown_record` | `unknown` | last_seen | — | — | — |
| `assistant_turn` when tokens **are** a capability | `silent` | — | — | — | — |

### Silent rest (known NR, no live sonic)

SSE emits `silent`. The client does **not** subscribe. `reason` is `envelope` | `snapshot` | `duplicate`.

| NR kind | Pulse | reason |
|---|---|---|
| `assistant_turn` (tokens capable) | `silent` | envelope |
| `session_meta` | `silent` | snapshot |
| `skill_invoke` | `silent` | snapshot |
| `branch_change` | `silent` | snapshot |
| `content_block` `tool_use` | `silent` | duplicate |

`unknown` is only `unknown_record` and unclassified kinds/block types. The client does **not** listen for `unknown` until that is true.

### Stream events the client dispatcher will encode **if called**

`playPulse` treats `thinking` and `unknown` as cognition events (they would hit both viz and audio). The live client subscribes `thinking`. It does **not** subscribe `unknown` (coverage alarm) or `tool_result` (success; noisy 1:1 with `tool_call`).

`tool_result` (success) is not in that set: even a direct `playPulse('tool_result', …)` would not build a ring entry.

---

## 5. Effect of encoding vs visualization

Same pulse object, two effects. Encoding does not decide visibility.

**Visualization (beat ring → overlay + DAW):**

- Block `x` from `ev.ts` (arrival).
- Height / lane from `ev.type`, `ev.key`, `ev.family`, token/word magnitudes (`blockGeom`, family lanes).
- Color from project node + tool stripe.
- Amber outline when `audioT` is inside `[heardAt, heardAt+0.55)` — **absent `heardAt` means “drawn, not sounding.”**
- Mute, failed `AudioContext`, filter, and `instrument: 'off'` must still leave the block on the ring.

**Audio encoding (resolveSonic → schedVoice → coalesceVoices → oscillator):**

- Instrument / pan / brightness / family from the Event Registry + settings + profile rules.
- Pitch from scale + `noteMode` (path hash, sequential, …).
- `coalesceVoices` may drop oscillators (`ghosts`). Ghosts stay on the ring; only `audible` get `startVoice`.
- Filter / `off` skip `schedVoice` only. They do not un-push the ring.
- No `AudioContext` → no oscillator, no `heardAt`. Ring entry already exists.

---

## 6. Gaps (current, not aspirational)

1. **SSE subscribe ≠ transformer emit.** `unknown` and `tool_result` leave the server and never call `playPulse`. `thinking` is subscribed.
2. **Ticker ⊂ beat ring.** `tokens`, `chirp`, `attachment`, `scaffold`, `thinking` draw on the ring (when they reach `playPulse`) but have no ticker line.
3. **Playable Instrument vs registry names.** P1 aliased leftover pad/click/chime/tick/woodblock/sweep at encode time. Live mix names only voices `INSTS` implements.
4. **Recorded Time is unused on the live feed.** `data.ts` is the burst clock in the encoder/sim path; the live ring uses arrival `Date.now()`.
