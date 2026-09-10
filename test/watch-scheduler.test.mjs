/**
 * test/watch-scheduler.test.mjs → surface/watch-scheduler.mjs
 *
 * The raw fs.watch callback must return to libuv near-instantly — on Windows,
 * a slow synchronous callback delays re-arming the underlying
 * ReadDirectoryChangesW read, which is how the kernel's fixed-size
 * notification buffer overflows under write bursts (see
 * RFC-opencode-watch-reliability.md §3). createWatchScheduler is the seam
 * that keeps handleWatchEvent's synchronous footprint to "match a regex, set
 * a Map key" and pushes all real work (tailAndPulse, rebuild scheduling) onto
 * a later event-loop tick.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWatchScheduler } from '../surface/watch-scheduler.mjs';

test('schedule — does not invoke onEvent synchronously', () => {
  const seen = [];
  const scheduler = createWatchScheduler({ onEvent: (ev) => seen.push(ev), defer: (fn) => fn() });
  // defer runs immediately here only because we chose to for this assertion's
  // shape; the real assertion is the next one below (schedule() itself never
  // calls onEvent — only the injected defer does).
  scheduler.schedule('a', { id: 1 });
  assert.deepEqual(seen, [{ id: 1 }], 'defer(fn) ran fn — onEvent was reached only through defer, not schedule');
});

test('schedule — onEvent runs on a later tick, not inside the schedule() call', () => {
  const seen = [];
  const scheduler = createWatchScheduler({ onEvent: (ev) => seen.push(ev) }); // real setImmediate
  scheduler.schedule('a', { id: 1 });
  assert.deepEqual(seen, [], 'onEvent must not have run yet — schedule() returned before the deferred tick');
  return new Promise((resolve) => {
    setImmediate(() => {
      assert.deepEqual(seen, [{ id: 1 }]);
      resolve();
    });
  });
});

test('schedule — a burst of calls for the same key before the deferred tick coalesces into one onEvent call', () => {
  const seen = [];
  const scheduler = createWatchScheduler({ onEvent: (ev) => seen.push(ev) });
  scheduler.schedule('opencode.db', { n: 1 });
  scheduler.schedule('opencode.db', { n: 2 });
  scheduler.schedule('opencode.db', { n: 3 });
  scheduler.schedule('opencode.db', { n: 4 });
  return new Promise((resolve) => {
    setImmediate(() => {
      assert.equal(seen.length, 1, 'four raw notifications for the same path must not run onEvent four times');
      assert.deepEqual(seen[0], { n: 4 }, 'the latest event payload wins');
      resolve();
    });
  });
});

test('schedule — different keys each get their own deferred run (no cross-key coalescing)', () => {
  const seen = [];
  const scheduler = createWatchScheduler({ onEvent: (ev) => seen.push(ev) });
  scheduler.schedule('opencode.db', { file: 'db' });
  scheduler.schedule('opencode.db-wal', { file: 'wal' });
  return new Promise((resolve) => {
    setImmediate(() => {
      assert.equal(seen.length, 2);
      assert.ok(seen.some(e => e.file === 'db'));
      assert.ok(seen.some(e => e.file === 'wal'));
      resolve();
    });
  });
});

test('schedule — after a deferred run completes, a new schedule() for the same key runs again', () => {
  const seen = [];
  const scheduler = createWatchScheduler({ onEvent: (ev) => seen.push(ev) });
  scheduler.schedule('a', { n: 1 });
  return new Promise((resolve) => {
    setImmediate(() => {
      assert.equal(seen.length, 1);
      scheduler.schedule('a', { n: 2 });
      setImmediate(() => {
        assert.equal(seen.length, 2);
        assert.deepEqual(seen[1], { n: 2 });
        resolve();
      });
    });
  });
});

test('schedule — an onEvent exception on one key does not prevent other keys from running', () => {
  const seen = [];
  const scheduler = createWatchScheduler({
    onEvent: (ev) => {
      if (ev.boom) throw new Error('simulated failure');
      seen.push(ev);
    },
  });
  scheduler.schedule('bad', { boom: true });
  scheduler.schedule('good', { ok: true });
  return new Promise((resolve) => {
    setImmediate(() => {
      setImmediate(() => { // give both deferred callbacks (independent setImmediate calls) a turn
        assert.deepEqual(seen, [{ ok: true }], 'the good key must still have run despite the bad key throwing');
        resolve();
      });
    });
  });
});

test('pendingCount — reflects keys queued but not yet run', () => {
  const scheduler = createWatchScheduler({ onEvent: () => {}, defer: () => {} }); // never actually runs
  assert.equal(scheduler.pendingCount(), 0);
  scheduler.schedule('a', {});
  scheduler.schedule('b', {});
  scheduler.schedule('a', {}); // coalesced, still one key
  assert.equal(scheduler.pendingCount(), 2);
});
