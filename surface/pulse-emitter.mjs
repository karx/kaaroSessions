/**
 * surface/pulse-emitter.mjs — the Stream production path.
 *
 * Watched-file change → tail new bytes (or whole-file JSON for read_mode
 * 'json' harnesses) → registry adapter → NormalizedRecords → pulses →
 * hub broadcast + active-state, plus the throttled `now` snapshot.
 *
 * Adapter + capabilities + project-label resolution all come from the
 * registry — nothing here is harness-specific.
 */
import fs from 'fs';

import { tailRead } from '../hooks/jsonl-tail.mjs';
import { normRecordsToPulses } from '../hooks/pulse-transformer.mjs';
import { getHarness } from '../hooks/registry.mjs';
import { applyPulse, snapshotActive } from './active-state.mjs';
import { MAX_JSONL_BYTES } from '../hooks/jsonl-io.mjs';

/**
 * @param {object} deps
 * @param {{ notify: (event: string, data?: string) => void }} deps.hub
 * @param {object} deps.activeState — store from createActiveState()
 * @param {{ applyPulse: (pulse: object) => void }} [deps.kindMap] — live kind-map overlay
 * @param {number} [deps.nowThrottleMs] — trailing-edge `now` broadcast window
 * @param {number} [deps.maxBytes] — shared OOM-guard cap for tail/whole-file
 *   reads (default MAX_JSONL_BYTES) + test seam
 * @returns {{ tailAndPulse: (filePath: string, ctx: object) => void }}
 */
export function createPulseEmitter({ hub, activeState, kindMap = null, nowThrottleMs = 1000, maxBytes = MAX_JSONL_BYTES }) {
  const offsetMap = new Map(); // filePath → byte offset (jsonl) or size:mtime sig (json)
  const seenSignals = new Map();
  const signalStart = Date.now() - 1000;
  let nowTimer = null;

  // Throttle: at most one `now` broadcast per window, trailing-edge,
  // so bursty multi-record tails collapse into a single snapshot push.
  function scheduleNowBroadcast() {
    if (nowTimer) return;
    nowTimer = setTimeout(() => {
      nowTimer = null;
      hub.notify('now', JSON.stringify(snapshotActive(activeState, Date.now())));
    }, nowThrottleMs);
    nowTimer.unref?.();
  }

  function emitPulses(records, ctx) {
    const harness = getHarness(ctx.harness);
    if (!harness) return;
    const nrs   = harness.adapter(records);
    const nowMs = Date.now();
    for (const pulse of normRecordsToPulses(nrs, ctx, harness.capabilities)) {
      if (pulse.event === 'turn_complete' || pulse.event === 'input_required') {
        const signalTime = typeof pulse.data.ts === 'number' ? pulse.data.ts : Date.parse(pulse.data.ts);
        if (Number.isFinite(signalTime) && signalTime < signalStart) continue;
        const id = pulse.data.signal_id || pulse.data.ts;
        if (id != null) {
          const key = JSON.stringify([ctx.harness, ctx.session_id, pulse.event, id]);
          if (seenSignals.has(key)) continue;
          seenSignals.set(key, true);
          if (seenSignals.size > 4096) seenSignals.delete(seenSignals.keys().next().value);
        }
      }
      applyPulse(activeState, pulse, nowMs);
      kindMap?.applyPulse(pulse);
      hub.notify(pulse.event, JSON.stringify(pulse.data));
    }
    scheduleNowBroadcast();
  }

  // Whole-file JSON harnesses (opencode): each watched file is one pretty-printed
  // JSON document, rewritten in place. Skip unchanged content via size+mtime
  // signature; fill session identity from the body when the path lacks it
  // (part/<messageID>/… files carry sessionID inside the JSON only).
  function jsonAndPulse(filePath, ctx) {
    const stat = fs.statSync(filePath);
    const sig = `${stat.size}:${stat.mtimeMs}`;
    if (offsetMap.get(filePath) === sig) return;
    offsetMap.set(filePath, sig);

    // Same OOM guard as the jsonl tail path — a whole-file JSON harness
    // (opencode) rewrites its file on every change, so this read is
    // unconditional; refuse rather than bulk-allocate an unbounded file.
    if (stat.size > maxBytes) {
      console.warn(`[pulse] json read skipped ${(stat.size / 1024 / 1024).toFixed(1)}MB (over ${(maxBytes / 1024 / 1024).toFixed(1)}MB cap) — ${filePath}`);
      return;
    }

    const obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const sessionId = ctx.session_id || obj.sessionID || null;
    if (!sessionId) return;
    const dir = obj.directory ? obj.directory.replace(/\\/g, '/').split('/').pop() : null;
    emitPulses([obj], {
      ...ctx,
      session_id: sessionId,
      slug: ctx.slug || sessionId.replace(/^ses_/, '').slice(0, 8),
      project_label: ctx.project_label || dir,
    });
  }

  function tailAndPulse(filePath, ctx) {
    try {
      if (ctx.read_mode === 'json') return jsonAndPulse(filePath, ctx);
      const resolveLabel = getHarness(ctx.harness)?.watch?.resolveProjectLabel;
      if (resolveLabel && !ctx.project_label) {
        ctx = { ...ctx, project_label: resolveLabel(ctx, filePath) };
      }
      const offset = offsetMap.get(filePath) ?? 0;
      const { records, newOffset, skippedBytes } = tailRead(filePath, offset, { maxBytes });
      offsetMap.set(filePath, newOffset);
      if (skippedBytes) {
        console.warn(`[pulse] tail skipped ${(skippedBytes / 1024 / 1024).toFixed(1)}MB (over ${(maxBytes / 1024 / 1024).toFixed(1)}MB cap) — ${filePath}`);
      }
      if (!records.length) return;
      emitPulses(records, ctx);
    } catch { /* tail errors must not affect the main rebuild flow */ }
  }

  return { tailAndPulse };
}
