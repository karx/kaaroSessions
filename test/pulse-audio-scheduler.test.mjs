import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Beat scheduler of experience/client/14-pulse-audio.js, run against a stub
// AudioContext whose state the test controls.
const engine = fs.readFileSync(new URL('../experience/client/14-pulse-audio.js', import.meta.url), 'utf8');

function scheduler() {
  const ctx = { state: 'suspended', currentTime: 0 };
  const started = [];
  const c = vm.createContext({
    window: { AUDIO_SETTINGS: { bpm: 120, beatsPerBar: 4 } },
    SCALES: {},
    ac: () => ctx,
    startVoice: (_c, at, v) => started.push({ at, name: v.name }),
    setTimeout: () => 1,
  });
  vm.runInContext(engine.slice(engine.indexOf('  let _beatAt ='), engine.indexOf('  // ── Per-voice signal chain')), c);
  const flush = names => {
    c.names = names;
    vm.runInContext('_batchBuf.push(...names.map(name => ({ name, hz: 440 }))); _flushBatch();', c);
  };
  return { ctx, started, flush };
}

test('Suspended AudioContext (autoplay blocked): pulses schedule no voices', () => {
  const { started, flush } = scheduler();
  for (let i = 0; i < 20; i++) flush(['harp', 'bell']);
  assert.equal(started.length, 0);
});

test('After resume only new pulses sound, on the current beat — no backlog burst', () => {
  const { ctx, started, flush } = scheduler();
  for (let i = 0; i < 20; i++) flush(['harp']);
  ctx.state = 'running';
  ctx.currentTime = 5;
  flush(['bell']);
  assert.deepEqual(started.map(v => v.name), ['bell']);
  assert.ok(started[0].at >= 5 && started[0].at < 5.1, `scheduled at ${started[0].at}`);
});
