import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const builder = fs.readFileSync(new URL('../experience/client/19-daw-builder.js', import.meta.url), 'utf8');
const synthSource = builder.slice(builder.indexOf('  const SYNTH_KEYS ='), builder.indexOf('  // ── SIM tab'));
const engine = fs.readFileSync(new URL('../experience/client/14-pulse-audio.js', import.meta.url), 'utf8');
const settingsSource = engine.slice(0, engine.indexOf('  // ── Rule matching')) + '\n})();';

// Model DOM reparsing: replacing innerHTML recreates descendants without JS handlers.
class Element {
  children = [];
  style = {};
  _html = '';
  constructor(tag) { this.tagName = tag; }
  appendChild(child) { this.children.push(child); return child; }
  get innerHTML() { return this._html; }
  set innerHTML(html) {
    this._html = html;
    this.children = this.children.map(child => child.clone());
    if (this.tagName === 'select') {
      this.value = html.match(/value="([^"]+)" selected/)?.[1] || html.match(/value="([^"]+)"/)?.[1];
    }
  }
  clone() {
    const copy = new Element(this.tagName);
    Object.assign(copy, { _html: this._html, value: this.value, className: this.className, textContent: this.textContent });
    copy.children = this.children.map(child => child.clone());
    return copy;
  }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
}

function synthHarness() {
  const window = { AUDIO_SETTINGS: { scale: 'major_pentatonic', instruments: { read: 'harp' } } };
  const previews = [];
  window.previewInstrument = name => previews.push(name);
  window.updateAudioSettings = patch => Object.assign(window.AUDIO_SETTINGS, patch);
  const context = vm.createContext({ window, document: { createElement: tag => new Element(tag), getElementById: () => null } });
  vm.runInContext(synthSource, context);
  const render = () => {
    const body = new Element('div');
    context.body = body;
    vm.runInContext('buildSynthTab(body)', context);
    return body;
  };
  return { window, previews, render };
}

test('Synth preview buttons retain click handlers after the entire tab is built', () => {
  const { render, previews } = synthHarness();
  const body = render();
  const buttons = body.descendants().filter(el => el.className === 'btn inst-prev');
  assert.equal(buttons.length, 11);
  assert.equal(typeof buttons[0].onclick, 'function');
  buttons[0].onclick();
  assert.deepEqual(previews, ['harp']);
});

test('Synth scale changes survive leaving and rebuilding the tab', () => {
  const { render, window } = synthHarness();
  const scale = render().descendants().find(el => el.tagName === 'select' && el._html.includes('Maj Pentatonic'));
  assert.equal(typeof scale.onchange, 'function');
  scale.value = 'dorian';
  scale.onchange();
  assert.equal(window.AUDIO_SETTINGS.scale, 'dorian');
  const restored = render().descendants().find(el => el.tagName === 'select' && el._html.includes('Maj Pentatonic'));
  assert.equal(restored.value, 'dorian');
});

test('Manually selected scale overrides a saved profile when a new window loads', () => {
  const storage = new Map([['kaaro-audio-profile', JSON.stringify({ scale: 'major_pentatonic' })]]);
  const localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
  const load = () => {
    const context = vm.createContext({ window: {}, localStorage });
    vm.runInContext(settingsSource, context);
    return context.window;
  };
  const first = load();
  first.updateAudioSettings({ scale: 'blues', noteMode: 'random', bpm: 95, octave: -2, octaves: { read: -1 } });
  first.updateAudioSettings({ octaves: { words: -2 } });
  const next = load();
  assert.equal(next.AUDIO_SETTINGS.scale, 'blues');
  assert.equal(next.AUDIO_SETTINGS.noteMode, 'random');
  assert.equal(next.AUDIO_SETTINGS.bpm, 95);
  assert.equal(next.AUDIO_SETTINGS.octave, -2);
  assert.equal(next.AUDIO_SETTINGS.octaves.read, -1);
  assert.equal(next.AUDIO_SETTINGS.octaves.words, -2);
});

test('Synth offers persisted overall and individual octave controls', () => {
  const { render, window } = synthHarness();
  const body = render();
  const master = body.descendants().find(el => el.title === 'Overall octave');
  const read = body.descendants().find(el => el.title === 'Read octave');
  assert.ok(master);
  assert.ok(read);
  master.value = '-2'; master.onchange();
  read.value = '-1'; read.onchange();
  assert.equal(window.AUDIO_SETTINGS.octave, -2);
  assert.equal(window.AUDIO_SETTINGS.octaves.read, -1);
  const next = render();
  assert.equal(Number(next.descendants().find(el => el.title === 'Overall octave').value), -2);
  assert.equal(Number(next.descendants().find(el => el.title === 'Read octave').value), -1);
});

test('An overall octave down halves live pitch; individual offsets add to mapping rules', () => {
  const context = vm.createContext({ window: {}, localStorage: { getItem: () => null } });
  vm.runInContext(engine.slice(0, engine.indexOf('  // ── AudioContext + master bus')) + '\n})();', context);
  context.SCALES = context.window.AUDIO_SCALES;
  vm.runInContext(engine.slice(engine.indexOf('  const ROOTS ='), engine.indexOf('  // ── Beat scheduler')), context);
  const original = vm.runInContext('noteHz(null, 0, 0)', context);
  context.window.AUDIO_SETTINGS.octave = -1;
  assert.equal(vm.runInContext('noteHz(null, 0, 0)', context), original / 2);
  context.window.AUDIO_SETTINGS.octaves = { read: -2 };
  context.window.AUDIO_PROFILE.mappings = [{ match: { key: 'read' }, set: { octave: 1 } }];
  const sonic = context.window.resolveSonicForEvent('tool_call', { key: 'read' });
  assert.equal(sonic.octave, -1);
});

test('Instrument previews use the same overall and per-key pitch as live events', () => {
  const context = vm.createContext({ window: {}, localStorage: { getItem: () => null } });
  vm.runInContext(engine.slice(0, engine.indexOf('  // ── AudioContext + master bus')) + '\n})();', context);
  context.SCALES = context.window.AUDIO_SCALES;
  vm.runInContext(engine.slice(engine.indexOf('  const ROOTS ='), engine.indexOf('  // ── Beat scheduler')), context);
  const pitches = [];
  context.resolveSonic = context.window.resolveSonicForEvent;
  context.INSTS = { harp: (c, at, hz) => pitches.push(hz) };
  context.PERC = new Set();
  context._masterGain = {};
  context.ac = () => ({ currentTime: 0, createGain: () => ({ gain: {}, connect() {} }) });
  vm.runInContext(engine.slice(engine.indexOf('  window.previewInstrument ='), engine.indexOf('  // ── Beat ring buffer')), context);
  context.window.previewInstrument('harp', 'read');
  context.window.updateAudioSettings({ octave: -1, octaves: { read: -1 } });
  context.window.previewInstrument('harp', 'read');
  assert.equal(pitches[1], pitches[0] / 4);
});

test('Audio enabled choice survives new windows and turning it off is remembered', () => {
  const storage = new Map();
  const localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
  const load = () => {
    const listeners = {};
    const button = { style: {}, addEventListener: (type, fn) => { if (type === 'click') button.clickHandler = fn; } };
    const context = vm.createContext({ window: { location: { protocol: 'http:' } }, localStorage,
      clearInterval,
      KAARO_TOKENS: {}, document: { createElement: () => button, body: { appendChild() {} },
        addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: type => { delete listeners[type]; } } });
    vm.runInContext(engine, context);
    return { window: context.window, button, listeners };
  };
  const first = load();
  assert.equal(first.window._getAudioMuted(), true);
  first.window._setAudioMuted(false);
  const next = load();
  assert.equal(next.window._getAudioMuted(), false);
  assert.equal(next.button.textContent, '♪ ON');
  assert.equal(typeof next.listeners.pointerdown, 'function', 'first interaction can unlock browser audio');
  next.window._setAudioMuted(true);
  const off = load();
  assert.equal(off.window._getAudioMuted(), true);
  assert.equal(off.button.textContent, '♪ OFF');
});

test('Snare rolls off harsh highs and fades into its attack', () => {
  const filters = [], envelope = [];
  const node = () => ({ connect() {}, start() {}, stop() {} });
  const c = { sampleRate: 1000,
    createBuffer: () => ({ getChannelData: () => new Float32Array(120) }),
    createBufferSource: node,
    createBiquadFilter: () => { const filter = { ...node(), frequency: {}, Q: {} }; filters.push(filter); return filter; },
    createGain: () => ({ ...node(), gain: {
      setValueAtTime: (value, time) => envelope.push(['set', value, time]),
      linearRampToValueAtTime: (value, time) => envelope.push(['attack', value, time]),
      exponentialRampToValueAtTime() {},
    } }),
  };
  const context = vm.createContext({ c });
  vm.runInContext(engine.slice(engine.indexOf('  function snare('), engine.indexOf('  function kick(')) + '\nsnare(c, 0, undefined, {});', context);
  assert.ok(filters.some(f => f.type === 'lowpass' && f.frequency.value <= 4000));
  assert.equal(envelope[0][1], 0.0001);
  assert.ok(envelope.some(e => e[0] === 'attack' && e[2] >= 0.004));
});

test('Calm Groove preset restores the screenshot instruments and octaves', () => {
  const context = vm.createContext({ window: {}, document: { getElementById: () => null } });
  vm.runInContext(builder.slice(builder.indexOf('  const DAW_PRESETS ='), builder.indexOf('  // ── PROF tab')), context);
  context.window.updateAudioSettings = settings => { context.window.settings = settings; };
  context.window.updateAudioProfile = profile => { context.window.profile = profile; };
  vm.runInContext("applyPreset(DAW_PRESETS.find(p => p.name === 'Calm Groove'))", context);
  const settings = context.window.settings;
  assert.equal(settings.scale, 'dorian');
  assert.equal(settings.noteMode, 'random');
  assert.equal(settings.octave, 0);
  assert.equal(settings.clickTrack, false);
  assert.equal(settings.instruments.read, 'hat');
  assert.equal(settings.octaves.read, -2);
  assert.equal(settings.octaves.edit, -1);
  assert.equal(settings.octaves.agent, -1);
  assert.equal(settings.octaves.tokens, 0);
  assert.equal(settings.instruments.tokens, 'snare');
  assert.equal(settings.instruments.bash_run, 'harp');
  assert.equal(settings.octaves.bash_run, 1);
  assert.equal(settings.instruments.words, 'hat');
  assert.equal(settings.instruments.grep_glob, 'snare');
});
