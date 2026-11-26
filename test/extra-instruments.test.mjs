import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as core from '../experience/client-core.mjs';

const { coalesceVoices, INSTRUMENT_IDS, PERC_VOICES } = core;

const source = name => fs.readFileSync(new URL('../experience/client/' + name, import.meta.url), 'utf8');
const audio = source('14-pulse-audio.js');
const percussion = ['rimshot', 'clap', 'shaker', 'tom', 'woodblock'];
const added = [...percussion, 'marimba'];

/** The synth section of 14-pulse-audio.js, run with the client-core globals the page provides. */
function loadSynths() {
  const context = vm.createContext({ ...core, window: {} });
  vm.runInContext(audio.slice(audio.indexOf('  function harp('), audio.indexOf('  window.previewInstrument ='))
    + '\nwindow.durations = INST_DUR;', context);
  return context.window;
}

test('The engine synthesises exactly the catalogue voices, each with a duration', () => {
  const { INSTS, durations } = loadSynths();
  assert.deepEqual(Object.keys(INSTS).sort(), [...INSTRUMENT_IDS].sort());
  assert.deepEqual(Object.keys(durations).sort(), [...INSTRUMENT_IDS].sort());
  for (const name of added) assert.ok(INSTRUMENT_IDS.includes(name), name);
});

test('Client modules keep no instrument list of their own — menus derive from the catalogue', () => {
  const handList = /['"](?:harp|bass|bell)['"]\s*,\s*['"](?:harp|bass|bell)['"]|\['harp','Harp'\]/;
  for (const name of ['14-pulse-audio.js', '15-audio-settings.js', '19-daw-builder.js']) {
    assert.doesNotMatch(source(name), handList, name + ' hand-lists instruments');
    assert.doesNotMatch(source(name), /new Set\(\['snare'/, name + ' hand-lists percussion');
  }
  assert.match(source('15-audio-settings.js'), /INSTRUMENT_OPTIONS/);
  assert.match(source('19-daw-builder.js'), /INSTRUMENT_OPTIONS/);
});

test('New percussion bursts collapse into one hit rather than pitched chords', () => {
  for (const name of percussion) {
    const voices = Array.from({ length: 8 }, () => ({ name, hz: 440, vol: 0.2, sonic: { key: 'read', fam: 'file' } }));
    const { audible } = coalesceVoices(voices);
    assert.equal(audible.length, 1, name);
    assert.equal(audible[0].name, name);
  }
});

test('All new synths schedule finite bounded voices and connect to the supplied output', () => {
  const window = loadSynths();
  for (const name of added) {
    assert.equal(PERC_VOICES.has(name), percussion.includes(name), name + ' uses the correct signature');
    const output = {}, connections = [], starts = [], stops = [];
    const param = () => ({ value: 0, setValueAtTime(value, time) { assert.ok(Number.isFinite(value) && Number.isFinite(time)); },
      linearRampToValueAtTime(value, time) { assert.ok(Number.isFinite(value) && Number.isFinite(time)); },
      exponentialRampToValueAtTime(value, time) { assert.ok(Number.isFinite(value) && value > 0 && Number.isFinite(time)); } });
    const node = () => ({ connect: target => { assert.ok(target); connections.push(target); },
      start: time => starts.push(time), stop: time => stops.push(time) });
    const c = { sampleRate: 1000,
      createBuffer: (channels, length) => ({ getChannelData: () => new Float32Array(length) }),
      createBufferSource: node,
      createOscillator: () => ({ ...node(), frequency: param() }),
      createGain: () => ({ ...node(), gain: param() }),
      createBiquadFilter: () => ({ ...node(), frequency: param(), Q: param() }),
    };
    const fn = window.INSTS[name];
    assert.equal(typeof fn, 'function', name);
    if (percussion.includes(name)) fn(c, 1, 0.2, output);
    else fn(c, 1, 220, 0.2, output);
    assert.ok(connections.includes(output), name + ' reaches output');
    assert.ok(starts.length > 0 && stops.length === starts.length, name + ' has bounded voices');
    assert.ok(stops.every(time => time > 1 && time <= 1 + window.durations[name] + 1e-9),
      name + ' stops within its advertised duration');
  }
});
