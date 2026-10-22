import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const engine = fs.readFileSync(new URL('../experience/client/14-pulse-audio.js', import.meta.url), 'utf8');
function harness(scale = 'dorian') {
  const context = vm.createContext({ window: {}, localStorage: { getItem: () => null } });
  vm.runInContext(engine.slice(0, engine.indexOf('  // ── AudioContext + master bus')) + '\n})();', context);
  context.SCALES = context.window.AUDIO_SCALES;
  context.window.AUDIO_SETTINGS.scale = scale;
  context.window.AUDIO_SETTINGS.bpm = 120;
  vm.runInContext(engine.slice(engine.indexOf('  const ROOTS ='), engine.indexOf('  // ── Beat scheduler')), context);
  return context;
}

test('Notifications play scale degrees 1,3,5,7 and their reverse', () => {
  for (const [scale, intervals] of [['major', [0, 4, 7, 11]], ['dorian', [0, 3, 7, 10]]]) {
    const c = harness(scale);
    const notes = vm.runInContext("notificationNotes('turn_complete', null, 0)", c);
    const reverse = vm.runInContext("notificationNotes('input_required', null, 0)", c);
    const root = 261.6255653005986;
    intervals.forEach((semitones, i) => assert.ok(Math.abs(notes[i].hz - root * 2 ** (semitones / 12)) < 1e-8));
    assert.deepEqual(Array.from(reverse, n => n.hz), Array.from(notes, n => n.hz).reverse());
    assert.deepEqual(Array.from(notes, n => n.offset), [0, 0.25, 0.5, 0.75]);
  }
});

test('Short scales continue into the next octave, and octave controls transpose the whole phrase', () => {
  const c = harness('major_pentatonic');
  const first = vm.runInContext("notificationNotes('turn_complete', null, 0)", c);
  const root = first[0].hz;
  [0, 4, 9, 14].forEach((semitones, i) => assert.ok(Math.abs(first[i].hz - root * 2 ** (semitones / 12)) < 1e-8));
  c.window.AUDIO_SETTINGS.octave = -1;
  const lowered = vm.runInContext("notificationNotes('turn_complete', null, -1)", c);
  first.forEach((note, i) => assert.ok(Math.abs(lowered[i].hz - note.hz / 4) < 1e-8));
  assert.equal(vm.runInContext("notificationNotes('words', null, 0)", c), null);
});

test('Preview schedules all four notes for alerts but just one for ordinary rows', () => {
  const c = harness();
  const played = [];
  c.resolveSonic = c.window.resolveSonicForEvent;
  c.COG_SOUND = { turn_complete: true, input_required: true };
  c.INSTS = { bell: (ctx, at, hz) => played.push({ at, hz }) };
  c.PERC = new Set();
  c._masterGain = {};
  c.ac = () => ({ currentTime: 1, createGain: () => ({ gain: {}, connect() {} }) });
  vm.runInContext(engine.slice(engine.indexOf('  window.previewInstrument ='), engine.indexOf('  // ── Beat ring buffer')), c);
  c.window.previewInstrument('bell', 'turn_complete');
  assert.equal(played.length, 4);
  assert.ok(played.every((note, i) => i === 0 || note.hz > played[i - 1].hz));
  c.window.previewInstrument('bell', 'input_required');
  assert.equal(played.length, 8);
  assert.ok(played.slice(4).every((note, i, notes) => i === 0 || note.hz < notes[i - 1].hz));
  c.window.previewInstrument('bell', 'read');
  assert.equal(played.length, 9);
});

test('Live burst reduction cannot discard or reharmonize a notification phrase', () => {
  const c = harness();
  const played = [];
  c.ac = () => ({ currentTime: 1 });
  c.coalesceVoices = voices => {
    assert.equal(voices.length, 1, 'ordinary events alone go through burst reduction');
    return { audible: [] };
  };
  c.startVoice = (ctx, at, voice) => played.push({ at, hz: voice.hz });
  vm.runInContext(engine.slice(engine.indexOf('  let _beatAt ='), engine.indexOf('  // ── Per-voice signal chain')), c);
  vm.runInContext("_batchBuf.push({name:'bell', notes:notificationNotes('turn_complete',null,0)}, {name:'harp',hz:440}); _flushBatch();", c);
  assert.equal(played.length, 4);
  assert.deepEqual(played.map(note => Math.round((note.at - played[0].at) * 1000)), [0, 250, 500, 750]);
  assert.ok(played.every((note, i) => i === 0 || note.hz > played[i - 1].hz));
});
