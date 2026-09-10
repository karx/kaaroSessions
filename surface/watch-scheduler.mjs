/**
 * surface/watch-scheduler.mjs — Non-blocking seam for raw fs.watch callbacks.
 *
 * On Windows, recursive fs.watch is backed by one outstanding
 * ReadDirectoryChangesW read per watched root. The kernel keeps appending
 * change records into that read's fixed-size buffer for as long as the read
 * stays un-serviced — and the read is only serviced (drained + re-armed)
 * when libuv processes its completion, on the SAME thread a synchronous JS
 * callback is running on. A callback that does real work before returning
 * (JSON.parse, a SQLite scan, activeState/hub fan-out) lengthens the window
 * the buffer can silently overflow in under write bursts. See
 * RFC-opencode-watch-reliability.md §3.
 *
 * createWatchScheduler is the fix for that: the raw fs.watch callback should
 * do only the cheap regex match (processWatchFilename) and then call
 * schedule(key, event) — which returns immediately, every time, regardless
 * of how expensive onEvent is. The real work (tailAndPulse, rebuild
 * scheduling) runs on a later event-loop tick via `defer` (setImmediate by
 * default — the "check" phase, after pending I/O callbacks, including any
 * other queued watch completions, have had a turn).
 *
 * Concurrent schedule() calls for the same key before that tick fires
 * coalesce into a single onEvent call (latest payload wins) — safe because
 * tailAndPulse's cursors (byte offset / rowid HWM) are idempotent
 * replay-from-last-position, not per-raw-event, so processing "10 raw
 * notifications for opencode.db" once is equivalent to processing it 10
 * times. This also means a burst of N raw OS notifications costs one
 * synchronous onEvent run, not N — shrinking total main-thread occupancy
 * per unit of real file activity, which is itself part of what keeps the
 * re-arm window short.
 *
 * Read-only, zero-dependency, no timers left running when idle (setImmediate
 * has nothing to unref — it fires once and is done).
 */

/**
 * @param {object} deps
 * @param {(event: any) => void} deps.onEvent
 * @param {(fn: () => void) => void} [deps.defer] — injectable for tests; setImmediate in production
 * @param {{ error: Function }} [deps.log]
 */
export function createWatchScheduler({ onEvent, defer = setImmediate, log = console } = {}) {
  const pending = new Map(); // key → latest event payload, not yet dispatched

  function schedule(key, event) {
    const alreadyQueued = pending.has(key);
    pending.set(key, event);
    if (alreadyQueued) return; // a run for this key is already deferred — it'll pick up the latest payload
    defer(() => {
      const ev = pending.get(key);
      pending.delete(key);
      try {
        onEvent(ev);
      } catch (err) {
        // One key's failure must not affect other keys' independently-deferred runs.
        log.error?.('[watch-scheduler] onEvent failed:', err);
      }
    });
  }

  return { schedule, pendingCount: () => pending.size };
}
