import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { playableInstrument } from '../experience/audio/event-registry.mjs';
import { coalesceVoices } from '../experience/client-core.mjs';

const source = name => fs.readFileSync(new URL('../experience/client/' + name, import.meta.url), 'utf8');
const audio = source('14-pulse-audio.js');
const percussion = ['rimshot', 'clap', 'shaker', 'tom', 'woodblock'];
const added = [...percussion, 'marimba'];

test('New instruments resolve directly and are offered in DAW, mapping rules, and Graph settings', () => {
  for (const name of added) {
    assert.equal(playableInstrument(name), name);
    const builder = source('19-daw-builder.js');
    for (const options of [builder.match(/const INST_NAMES = (\[[^;]+\])/)[1],
      builder.match(/sel.innerHTML = (\[[^\n]+\])/)[1]]) {
      assert.ok(options.includes("'" + name + "'"), name + ' is offered in Synth and mapping rules');
    }
    assert.ok(source('15-audio-settings.js').includes("'" + name + "'"));
  }
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
  const context = vm.createContext({ window: {} });
  vm.runInContext(audio.slice(audio.indexOf('  function harp('), audio.indexOf('  window.previewInstrument ='))
    + '\nwindow.percussion = PERC; window.durations = INST_DUR;', context);
  for (const name of added) {
    assert.equal(context.window.percussion.has(name), percussion.includes(name), name + ' uses the correct signature');
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
    const fn = context.window.INSTS[name];
    assert.equal(typeof fn, 'function', name);
    if (percussion.includes(name)) fn(c, 1, 0.2, output);
    else fn(c, 1, 220, 0.2, output);
    assert.ok(connections.includes(output), name + ' reaches output');
    assert.ok(starts.length > 0 && stops.length === starts.length, name + ' has bounded voices');
    assert.ok(stops.every(time => time > 1 && time <= 1 + context.window.durations[name] + 1e-9),
      name + ' stops within its advertised duration');
  }
});
