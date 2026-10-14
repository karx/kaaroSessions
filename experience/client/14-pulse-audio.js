// ── Pulse audio engine v2 — master bus · reverb · stereo pan · brightness filter ──
//
// Signal chain per voice:
//   instrument(out) → brightness-filter → stereo-panner → masterGain → masterFilter → destination
//                                       ↘ reverbSend (sendAmt) → convolver → reverbReturn → masterGain
//
// Spatial semantics: file-writes=left, bash=far-left, reads=center, words=right, agent=far-right+reverb
// Cognitive pressure: rolling cache_ratio + density → drives masterFilter cutoff (dull under load)

(function () {

  // ── Scales ─────────────────────────────────────────────────────────────────────
  const SCALES = {
    major_pentatonic: [0, 2, 4, 7, 9],
    minor_pentatonic: [0, 3, 5, 7, 10],
    blues:            [0, 3, 5, 6, 7, 10],
    major:            [0, 2, 4, 5, 7, 9, 11],
    dorian:           [0, 2, 3, 5, 7, 9, 10],
  };

  // ── Families ──────────────────────────────────────────────────────────────────
  window.AUDIO_FAMILIES = [
    { id: 'file',    label: 'File Ops', color: '#2a6a2a', tools: ['read', 'write', 'edit', 'grep_glob'] },
    { id: 'system',  label: 'System',   color: '#2a3a7a', tools: ['bash_git', 'bash_run', 'bash_other'] },
    { id: 'ai',      label: 'AI',       color: '#6a2a7a', tools: ['agent', 'other', 'web'] },
    { id: 'context', label: 'Context',  color: '#2a5a6a', tools: ['tokens', 'words', 'thinking'] },
  ];

  const TOOL_FAMILY = {};
  for (const f of window.AUDIO_FAMILIES)
    for (const t of f.tools) TOOL_FAMILY[t] = f.id;
  window.TOOL_FAMILY = TOOL_FAMILY;

  // ── Default settings ──────────────────────────────────────────────────────────
  const DEFAULT_SETTINGS = {
    instruments: {
      read: 'harp', write: 'bass', edit: 'pling',
      bash_git: 'snare', bash_run: 'hat', bash_other: 'kick',
      grep_glob: 'bit', agent: 'bell', other: 'harp',
      web: 'bell', tokens: 'flute', words: 'bell',
      tool_error: 'buzz', api_error: 'buzz',
      human_turn: 'bell', compact: 'kick',
      permission: 'hat', mode_shift: 'hat',
      chirp: 'pling', attachment: 'pling', scaffold: 'hat',
      thinking: 'bell',
    },
    scale:       'major_pentatonic',
    octave:      0,
    octaves:     {},
    noteMode:    'path_hash',
    bpm:         120,
    beatsPerBar: 4,
    clickTrack:  false,
    soundEnabled: false,
    clickVol:    0.15,
    filter: { mutedFamilies: [], mutedProjects: [] },
  };

  function _load() {
    try {
      const raw = localStorage.getItem('kaaro-audio-settings');
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
      const s = JSON.parse(raw);
      return {
        ...DEFAULT_SETTINGS, ...s,
        instruments: { ...DEFAULT_SETTINGS.instruments, ...(s.instruments || {}) },
        octaves:     { ...(s.octaves || {}) },
        filter:      { ...DEFAULT_SETTINGS.filter,      ...(s.filter || {}) },
      };
    } catch { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
  }

  window.AUDIO_SETTINGS = _load();
  window.AUDIO_SCALES   = SCALES;
  window.AUDIO_DEFAULTS = DEFAULT_SETTINGS;

  // ── Audio profile (mapping rules + timbre overrides) ──────────────────────────
  const DEFAULT_PROFILE = { mappings: [], timbre: {}, scale: null, noteMode: null, bpm: null };
  window.AUDIO_PROFILE  = JSON.parse(JSON.stringify(DEFAULT_PROFILE));

  window.updateAudioProfile = function (patch) {
    if (!patch) return;
    if (patch.mappings)   window.AUDIO_PROFILE.mappings = patch.mappings;
    if (patch.timbre)     Object.assign(window.AUDIO_PROFILE.timbre, patch.timbre);
    if ('scale'    in patch) window.AUDIO_PROFILE.scale    = patch.scale;
    if ('noteMode' in patch) window.AUDIO_PROFILE.noteMode = patch.noteMode;
    if ('bpm'      in patch) window.AUDIO_PROFILE.bpm      = patch.bpm;
    try { localStorage.setItem('kaaro-audio-profile', JSON.stringify(window.AUDIO_PROFILE)); } catch {}
  };

  (function _loadProfile() {
    try {
      const raw = localStorage.getItem('kaaro-audio-profile');
      if (raw) {
        const p = JSON.parse(raw);
        window.AUDIO_PROFILE = {
          ...DEFAULT_PROFILE, ...p,
          timbre: { ...(p.timbre || {}) }, mappings: p.mappings || [],
        };
      }
    } catch {}
  })();

  if (window.AUDIO_PROFILE.bpm)      window.AUDIO_SETTINGS.bpm      = window.AUDIO_PROFILE.bpm;
  if (window.AUDIO_PROFILE.scale)    window.AUDIO_SETTINGS.scale    = window.AUDIO_PROFILE.scale;
  if (window.AUDIO_PROFILE.noteMode) window.AUDIO_SETTINGS.noteMode = window.AUDIO_PROFILE.noteMode;

  window.updateAudioSettings = function (patch) {
    if (patch.instruments) Object.assign(window.AUDIO_SETTINGS.instruments, patch.instruments);
    if (patch.octaves) Object.assign(window.AUDIO_SETTINGS.octaves, patch.octaves);
    if (patch.filter)      Object.assign(window.AUDIO_SETTINGS.filter, patch.filter);
    const rest = Object.fromEntries(
      Object.entries(patch).filter(([k]) => k !== 'instruments' && k !== 'filter' && k !== 'octaves')
    );
    Object.assign(window.AUDIO_SETTINGS, rest);
    const profilePatch = Object.fromEntries(
      ['scale', 'noteMode', 'bpm'].filter(key => key in patch).map(key => [key, patch[key]])
    );
    if (Object.keys(profilePatch).length) window.updateAudioProfile(profilePatch);
    try { localStorage.setItem('kaaro-audio-settings', JSON.stringify(window.AUDIO_SETTINGS)); } catch {}
  };

  // ── Rule matching ─────────────────────────────────────────────────────────────
  function ruleMatches(rule, evType, data, key) {
    const m = rule.match || {};
    const fam = key ? (TOOL_FAMILY[key] || null) : null;
    if (m.type && m.type !== evType) return false;
    const mFam = Array.isArray(m.family) ? m.family : (m.family ? [m.family] : null);
    if (mFam && !mFam.includes(fam)) return false;
    const mKey = Array.isArray(m.key) ? m.key : (m.key ? [m.key] : null);
    if (mKey && !mKey.includes(key)) return false;
    const mH = Array.isArray(m.harness) ? m.harness : (m.harness ? [m.harness] : null);
    if (mH && data.harness && !mH.includes(data.harness)) return false;
    if (m.project && data.project && data.project !== m.project) return false;
    if (m.whereContains && data.where && !String(data.where).includes(m.whereContains)) return false;
    if (m.wordMin != null && (data.word_count || 0) < m.wordMin) return false;
    if (m.outMin  != null && (data.output || 0) < m.outMin) return false;
    return true;
  }

  // ── Spatial defaults per action key ──────────────────────────────────────────
  const SPATIAL = {
    write:      { pan: -0.15, sendAmt: 0.05, brightness: 10000 },
    edit:       { pan: -0.10, sendAmt: 0.05, brightness: 9000  },
    read:       { pan:  0.05, sendAmt: 0.06, brightness: 7000  },
    grep_glob:  { pan:  0.10, sendAmt: 0.04, brightness: 5500  },
    agent:      { pan:  0.35, sendAmt: 0.40, brightness: 4500  },
    bash_git:   { pan: -0.30, sendAmt: 0.04, brightness: 3500  },
    bash_run:   { pan: -0.30, sendAmt: 0.04, brightness: 3500  },
    bash_other: { pan: -0.30, sendAmt: 0.04, brightness: 3500  },
    other:      { pan:  0.00, sendAmt: 0.08, brightness: 6000  },
    web:        { pan:  0.45, sendAmt: 0.28, brightness: 5800  },
    tokens:     { pan:  0.00, sendAmt: 0.00, brightness: 5000  }, // brightness overridden by cache_ratio
    words:      { pan:  0.20, sendAmt: 0.15, brightness: 9000  },
    tool_error: { pan: -0.10, sendAmt: 0.05, brightness: 1500  },
    api_error:  { pan:  0.00, sendAmt: 0.10, brightness:  900  },
    human_turn: { pan:  0.30, sendAmt: 0.25, brightness: 6000  },
    compact:    { pan:  0.00, sendAmt: 0.30, brightness: 1200  },
    permission: { pan: -0.10, sendAmt: 0.02, brightness: 7000  },
    mode_shift: { pan: -0.10, sendAmt: 0.02, brightness: 7000  },
    chirp:      { pan:  0.20, sendAmt: 0.10, brightness: 8000  },
    attachment: { pan:  0.25, sendAmt: 0.15, brightness: 6500  },
    scaffold:   { pan: -0.20, sendAmt: 0.05, brightness: 4000  },
    thinking:   { pan: -0.10, sendAmt: 0.06, brightness: 4000  },
  };
  const HARNESS_PAN_BIAS = { pi: -0.15, antigravity: 0.15, grok: 0.25 };

  function bashKey(cat) {
    if (cat === 'git') return 'bash_git';
    if (cat === 'npm' || cat === 'npx' || cat === 'node' || cat === 'python') return 'bash_run';
    return 'bash_other';
  }

  // ── Sonic resolution (all axes) ───────────────────────────────────────────────
  // Cognition events: instrument/octave/volume profile (spatial axes in SPATIAL)
  const COG_SOUND = {
    tool_error: { instrument: 'buzz',  octave: -1, volMult: 1.10 },
    api_error:  { instrument: 'buzz',  octave: -2, volMult: 1.40 },
    human_turn: { instrument: 'bell',  octave: -1, volMult: 0.90 },
    compact:    { instrument: 'kick',  octave: -2, volMult: 1.20 },
    permission: { instrument: 'hat',   octave:  0, volMult: 0.50 },
    mode_shift: { instrument: 'hat',   octave:  0, volMult: 0.50 },
    chirp:      { instrument: 'pling', octave:  1, volMult: 0.35 },
    attachment: { instrument: 'pling', octave:  0, volMult: 0.50 },
    scaffold:   { instrument: 'hat',   octave: -1, volMult: 0.40 },
    thinking:   { instrument: 'bell',  octave: -1, volMult: 0.25 },
  };

  function resolveSonic(event, data) {
    const S  = window.AUDIO_SETTINGS;
    const P  = window.AUDIO_PROFILE || {};
    let key = null, instrument = null, volMult = 1, octave = 0;
    let degreeMode = S.noteMode, scale = P.scale || S.scale;

    if (event === 'tool_call' && data.key) {
      // canonical key arrives on every pulse from hooks/pulse-transformer
      key = data.key;
      instrument = S.instruments[key] || 'harp';

    } else if (event === 'tool_call') {
      const tool = (data.tool || '').toLowerCase();
      if      (tool === 'read'  || tool === 'view_file' || tool === 'read_file')    key = 'read';
      else if (tool === 'write' || tool === 'write_to_file')                        key = 'write';
      else if (tool === 'edit'  || tool === 'replace_file_content'
               || tool === 'search_replace')                                        key = 'edit';
      else if (tool === 'grep'  || tool === 'glob' || tool === 'grep_search'
               || tool === 'list_dir')                                              key = 'grep_glob';
      else if (tool === 'agent')                                                    key = 'agent';
      else if (tool === 'bash'  || tool === 'powershell' || tool === 'shell'
               || tool === 'run_command')                                           key = bashKey(data.category || 'other');
      else if (tool === 'web_fetch' || tool === 'web_search'
               || tool === 'web search:')                                           key = 'web';
      else key = 'other';
      instrument = S.instruments[key] || 'harp';

    } else if (event === 'tokens') {
      key = 'tokens'; instrument = S.instruments.tokens || 'flute'; octave = -1;
      volMult = Math.min(1.5, 0.04 + Math.log1p((data.output || 0) / 300) * 0.028) / 0.11;

    } else if (event === 'words') {
      key = 'words'; instrument = S.instruments.words || 'bell'; octave = 1;

    } else if (COG_SOUND[event]) {
      key = event;
      const cog = COG_SOUND[event];
      instrument = S.instruments[key] || cog.instrument;
      octave = cog.octave; volMult = cog.volMult;
    }

    // Spatial defaults
    const sp = SPATIAL[key] || { pan: 0, sendAmt: 0.05, brightness: 7000 };
    let pan = sp.pan, sendAmt = sp.sendAmt, brightness = sp.brightness;

    // tokens brightness driven by cache_ratio
    if (key === 'tokens') {
      const total = (data.output || 0) + (data.cache_read || 0);
      const cR = total > 0 ? (data.cache_read || 0) / total : 0;
      brightness = Math.round(800 + 4200 * (1 - cR)); // high cache = dull 800 Hz
    }

    // Harness spatial bias
    const hBias = (data && data.harness) ? (HARNESS_PAN_BIAS[data.harness] || 0) : 0;
    pan = Math.max(-1, Math.min(1, pan + hBias));

    // Apply mapping rules
    for (const rule of (P.mappings || [])) {
      if (!ruleMatches(rule, event, data, key)) continue;
      const eff = rule.set || {};
      if (eff.instrument)                     instrument = eff.instrument;
      if (typeof eff.volMult    === 'number') volMult    = eff.volMult;
      if (typeof eff.octave     === 'number') octave     = eff.octave;
      if (eff.degreeMode)                     degreeMode = eff.degreeMode;
      if (eff.scale)                          scale      = eff.scale;
      if (typeof eff.pan        === 'number') pan        = Math.max(-1, Math.min(1, eff.pan));
      if (typeof eff.send       === 'number') sendAmt    = eff.send;
      if (typeof eff.brightness === 'number') brightness = eff.brightness;
      break;
    }

    octave += Number(S.octaves?.[key]) || 0;
    const tmb = (P.timbre && P.timbre[instrument]) || {};
    const fam = key ? (TOOL_FAMILY[key] || null) : null;
    if (instrument && instrument !== 'off' && !['harp','bass','bell','flute','bit','pling','snare','kick','hat','buzz'].includes(instrument)) {
      instrument = ({ pad:'bell', click:'pling', chime:'bell', tick:'hat', woodblock:'pling', sweep:'kick' })[instrument] || 'harp';
    }
    return { key, instrument, volMult, octave, degreeMode, scale, timbre: tmb, fam, pan, sendAmt, brightness };
  }

  window.resolveSonicForEvent = resolveSonic;

  // ── AudioContext + master bus ─────────────────────────────────────────────────
  let _ac = null, muted = !window.AUDIO_SETTINGS.soundEnabled;
  let _masterGain, _masterFilter, _reverbConvolver, _reverbReturn, _masterBusReady = false;

  function _setupMasterBus(c) {
    if (_masterBusReady) return;
    _masterBusReady = true;

    _masterGain = c.createGain(); _masterGain.gain.value = 0.75;
    _masterFilter = c.createBiquadFilter();
    _masterFilter.type = 'lowpass'; _masterFilter.frequency.value = 12000; _masterFilter.Q.value = 0.7;
    _masterGain.connect(_masterFilter); _masterFilter.connect(c.destination);

    // Reverb: 1.8 s exponential-decay white-noise impulse response
    const len = Math.floor(c.sampleRate * 1.8);
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    }
    _reverbConvolver = c.createConvolver(); _reverbConvolver.buffer = buf;
    _reverbReturn = c.createGain(); _reverbReturn.gain.value = 0.45;
    _reverbConvolver.connect(_reverbReturn); _reverbReturn.connect(_masterGain);
  }

  function ac() {
    if (!_ac) {
      try { _ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
    }
    if (_ac.state === 'suspended') _ac.resume().catch(() => {});
    _setupMasterBus(_ac);
    return _ac;
  }

  // ── Cognitive pressure → master filter automation ─────────────────────────────
  window.COGNITIVE_PRESSURE = 0;

  // Rolling cache ratio from token events (20-sample window)
  const _cacheRatioWindow = [];
  let _pressureTickCount = 0;

  function _updatePressure() {
    const ring = _beatRing;
    const now  = Date.now();
    const eventsIn10s = ring.filter(e => now - e.ts < 10000).length;
    const densityP    = Math.min(1, eventsIn10s / 30);
    const avgCache    = _cacheRatioWindow.length
      ? _cacheRatioWindow.reduce((a, b) => a + b, 0) / _cacheRatioWindow.length
      : 0;
    const pressure = avgCache * 0.6 + densityP * 0.4;
    window.COGNITIVE_PRESSURE = pressure;
    if (_masterFilter && _ac) {
      const cutoff = Math.max(200, 12000 * Math.pow(1 - pressure * 0.70, 1.5));
      _masterFilter.frequency.setTargetAtTime(cutoff, _ac.currentTime, 0.5);
    }
  }

  window.updateMasterPressure = function (p) {
    window.COGNITIVE_PRESSURE = Math.max(0, Math.min(1, p));
    if (_masterFilter && _ac) {
      const cutoff = Math.max(200, 12000 * Math.pow(1 - window.COGNITIVE_PRESSURE * 0.70, 1.5));
      _masterFilter.frequency.setTargetAtTime(cutoff, _ac.currentTime, 0.5);
    }
  };

  // ── Musical system ────────────────────────────────────────────────────────────
  const ROOTS = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79];
  function midiToHz(m)  { return 440 * Math.pow(2, (m - 69) / 12); }
  function activeIv()   { return SCALES[window.AUDIO_SETTINGS.scale] || SCALES.major_pentatonic; }

  function projectRoot(project) {
    if (typeof GRAPH !== 'undefined' && typeof COLOR_TO_INDEX !== 'undefined') {
      const n = GRAPH.nodes.find(n => n.type === 'project' && n.label === project);
      if (n) return ROOTS[(COLOR_TO_INDEX[n.color] ?? 0) % ROOTS.length];
    }
    return ROOTS[0];
  }

  function noteHz(project, degree, octaveShift) {
    const iv  = activeIv();
    const idx = ((degree % iv.length) + iv.length) % iv.length;
    const overall = Number(window.AUDIO_SETTINGS.octave) || 0;
    return midiToHz(projectRoot(project) + iv[idx] + ((octaveShift || 0) + overall) * 12);
  }

  function strHash(s) {
    if (!s) return 0;
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
    return h;
  }

  let _seqIdx = 0;
  function getDegree(where) {
    const iv = activeIv(), mode = window.AUDIO_SETTINGS.noteMode;
    if (mode === 'root')       return 0;
    if (mode === 'random')     return Math.floor(Math.random() * iv.length);
    if (mode === 'sequential') { _seqIdx = (_seqIdx + 1) % iv.length; return _seqIdx; }
    return where ? strHash(where) % iv.length : 0;
  }

  // ── Beat scheduler ────────────────────────────────────────────────────────────
  // 80 ms batch, then snap onto the next beat (musical grid).
  let _beatAt = 0, _barBeat = 0, _batchBuf = [], _batchTimer = null;
  const BATCH_MS = 80;

  function _flushBatch() {
    _batchTimer = null;
    if (!_batchBuf.length) return;
    const buf = _batchBuf.splice(0);
    const c   = ac(); if (!c) return;
    const now = c.currentTime;
    const scale = SCALES[window.AUDIO_SETTINGS?.scale] || SCALES.major_pentatonic;
    const { audible } = (typeof coalesceVoices === 'function')
      ? coalesceVoices(buf, { scale })
      : { audible: buf };

    const bd = 60 / (window.AUDIO_SETTINGS.bpm || 120);
    if (_beatAt < now + 0.02) { _beatAt = now + 0.02; _barBeat = 0; }
    const at = _beatAt;
    _barBeat = (_barBeat + 1) % (window.AUDIO_SETTINGS.beatsPerBar || 4);
    _beatAt += bd;

    const stagger = Math.min(0.012, 0.04 / Math.max(1, audible.length - 1));
    // Audio sink only: heardAt is the oscillator clock. The viz sink already
    // owns the ring entry (arrival ts). Do not rewrite ts — that jumps the block.
    for (const v of buf) {
      if (v.meta?.ringEv) v.meta.ringEv.heardAt = at;
    }
    audible.forEach((v, i) => startVoice(c, at + i * stagger, v));
  }

  // ── Per-voice signal chain ────────────────────────────────────────────────────
  window.MIXER_GAINS = { file: 1, system: 1, ai: 1, context: 1 };
  window._scheduledVoices = [];
  window._getAudioNow = () => (_ac ? _ac.currentTime : 0);

  function schedVoice(name, hz, vol, sonic, meta) {
    const mixerGain = (window.MIXER_GAINS && sonic.fam) ? (window.MIXER_GAINS[sonic.fam] ?? 1) : 1;
    const finalVol  = (vol != null ? vol : 0.42) * mixerGain;
    _batchBuf.push({ name, hz, vol: finalVol, sonic, meta });
    if (!ac()) return; // viz already has the pulse; no oscillator to arm
    if (!_batchTimer) _batchTimer = setTimeout(_flushBatch, BATCH_MS);
  }

  function startVoice(c, at, v) {
    if (!_masterGain) return;
    const { name, hz, vol, sonic, meta } = v;
    const filt = c.createBiquadFilter(); filt.type = 'lowpass';
    filt.frequency.value = sonic?.brightness || 10000; filt.Q.value = 0.8;
    let panner = null;
    try { panner = c.createStereoPanner(); panner.pan.value = sonic?.pan || 0; } catch {}
    const endpoint = panner || _masterGain;
    filt.connect(endpoint);
    if (panner) panner.connect(_masterGain);
    if ((sonic?.sendAmt || 0) > 0.01 && _reverbConvolver) {
      const sg = c.createGain(); sg.gain.value = sonic.sendAmt;
      endpoint.connect(sg); sg.connect(_reverbConvolver);
    }
    const fn = INSTS[name] || harp;
    PERC.has(name) ? fn(c, at, vol, filt) : fn(c, at, hz, vol, filt);

    const voices = window._scheduledVoices;
    voices.push({
      at, dur: INST_DUR[name] || 0.4,
      instrument: name, hz, key: sonic?.key, fam: sonic?.fam,
      label: meta?.label || name, relMs: meta?.relMs, event: meta?.event,
      clusterN: v.clusterN,
    });
    if (voices.length > 48) voices.shift();
  }

  // ── Click track ───────────────────────────────────────────────────────────────
  let _clickAt = 0, _clickBeat = 0, _clickTimer = null;

  function _tick(c, at, isDown) {
    if (!_masterGain) return;
    const vol = (window.AUDIO_SETTINGS.clickVol || 0.15) * (isDown ? 1 : 0.5);
    const o   = c.createOscillator(); o.type = 'triangle'; o.frequency.value = isDown ? 880 : 660;
    const g   = c.createGain();
    g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.03);
    o.connect(g); g.connect(_masterGain); o.start(at); o.stop(at + 0.03);
  }

  function _schedClicks() {
    const c = ac(); if (!c) return;
    const bd  = 60 / (window.AUDIO_SETTINGS.bpm || 120);
    const bpb = window.AUDIO_SETTINGS.beatsPerBar || 4;
    const now = c.currentTime;
    if (_clickAt < now) { _clickAt = now + 0.02; _clickBeat = 0; }
    while (_clickAt < now + 0.12) {
      _tick(c, _clickAt, _clickBeat % bpb === 0);
      _clickBeat++; _clickAt += bd;
    }
  }

  function _startClick() {
    if (_clickTimer) return;
    const c = ac(); if (!c) return;
    _clickAt = c.currentTime + 0.05; _clickBeat = 0;
    _clickTimer = setInterval(_schedClicks, 25);
  }
  function _stopClick() { clearInterval(_clickTimer); _clickTimer = null; }

  window.setClickTrack = function (on, forceRestart) {
    window.updateAudioSettings({ clickTrack: on });
    if (forceRestart && _clickTimer) _stopClick();
    if (!muted && on) _startClick(); else if (!on) _stopClick();
  };

  // ── Filter (family / project mute) ───────────────────────────────────────────
  function passesFilter(toolKey, project) {
    const f = window.AUDIO_SETTINGS.filter || {};
    if (f.mutedFamilies?.length && f.mutedFamilies.includes(TOOL_FAMILY[toolKey])) return false;
    if (f.mutedProjects?.length  && f.mutedProjects.includes(project))             return false;
    return true;
  }

  // ── Instrument synthesizers ───────────────────────────────────────────────────
  // All instruments now connect to `out` (a GainNode) instead of c.destination.

  function harp(c, at, hz, vol, out) {
    vol = vol ?? 0.42;
    const env = c.createGain();
    env.gain.setValueAtTime(vol, at);
    env.gain.exponentialRampToValueAtTime(0.001, at + 0.9);
    env.connect(out);
    [[1, 'triangle', 0.72], [2, 'sine', 0.28]].forEach(([mult, type, w]) => {
      const o = c.createOscillator(); o.type = type; o.frequency.value = hz * mult;
      const g = c.createGain(); g.gain.value = w;
      o.connect(g); g.connect(env); o.start(at); o.stop(at + 0.9);
    });
  }

  function bass(c, at, hz, vol, out) {
    vol = vol ?? 0.48;
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = hz / 2;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.001, at + 1.4);
    o.connect(g); g.connect(out); o.start(at); o.stop(at + 1.4);
  }

  function bell(c, at, hz, vol, out) {
    vol = vol ?? 0.32;
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = hz * 2;
    const g = c.createGain();
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(vol, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, at + 2.5);
    o.connect(g); g.connect(out); o.start(at); o.stop(at + 2.5);
  }

  function flute(c, at, hz, vol, out) {
    vol = vol ?? 0.18;
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = hz;
    const g = c.createGain();
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(vol, at + 0.07);
    g.gain.setValueAtTime(vol, at + 0.2); g.gain.exponentialRampToValueAtTime(0.001, at + 0.65);
    o.connect(g); g.connect(out); o.start(at); o.stop(at + 0.65);
  }

  function bit(c, at, hz, vol, out) {
    vol = vol ?? 0.14;
    const o = c.createOscillator(); o.type = 'square'; o.frequency.value = hz;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.22);
    o.connect(g); g.connect(out); o.start(at); o.stop(at + 0.22);
  }

  function pling(c, at, hz, vol, out) {
    vol = vol ?? 0.30;
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = hz;
    const g = c.createGain();
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(vol, at + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.48);
    o.connect(g); g.connect(out); o.start(at); o.stop(at + 0.48);
  }

  function snare(c, at, vol, out) {
    vol = (vol ?? 0.32) * 0.75;
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * 0.12), c.sampleRate);
    const d   = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource(); src.buffer = buf;
    const f   = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 650;
    const soften = c.createBiquadFilter(); soften.type = 'lowpass'; soften.frequency.value = 3200; soften.Q.value = 0.5;
    const g   = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(vol, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.12);
    src.connect(f); f.connect(soften); soften.connect(g); g.connect(out); src.start(at); src.stop(at + 0.12);
  }

  function kick(c, at, vol, out) {
    vol = vol ?? 0.46;
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(120, at); o.frequency.exponentialRampToValueAtTime(40, at + 0.15);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.25);
    o.connect(g); g.connect(out); o.start(at); o.stop(at + 0.25);
  }

  function hat(c, at, vol, out) {
    vol = vol ?? 0.18;
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * 0.04), c.sampleRate);
    const d   = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource(); src.buffer = buf;
    const f   = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 8000;
    const g   = c.createGain();
    g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.04);
    src.connect(f); f.connect(g); g.connect(out); src.start(at); src.stop(at + 0.04);
  }

  // buzz: sawtooth with a downward pitch sweep — the unmistakable failure voice
  function buzz(c, at, hz, vol, out) {
    const o = c.createOscillator(); o.type = 'sawtooth';
    const f0 = Math.max(60, hz || 160);
    o.frequency.setValueAtTime(f0, at);
    o.frequency.exponentialRampToValueAtTime(Math.max(36, f0 * 0.35), at + 0.22);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.min(0.6, (vol != null ? vol : 0.4) * 1.1), at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.26);
    o.connect(g); g.connect(out); o.start(at); o.stop(at + 0.27);
  }

  const INSTS = { harp, bass, bell, flute, bit, pling, snare, kick, hat, buzz };
  window.INSTS = INSTS;
  const PERC  = new Set(['snare', 'kick', 'hat']);
  const INST_DUR = {
    harp: 0.9, bass: 1.4, bell: 2.5, flute: 0.65, bit: 0.22, pling: 0.48,
    snare: 0.12, kick: 0.25, hat: 0.04, buzz: 0.27,
  };

  window.previewInstrument = function (name, key) {
    const fn = INSTS[name]; if (!fn) return;
    const c  = ac(); if (!c || !_masterGain) return;
    const at = c.currentTime + 0.05;
    const tmpOut = c.createGain(); tmpOut.gain.value = 1; tmpOut.connect(_masterGain);
    const event = key === 'tokens' || key === 'words' ? key : 'tool_call';
    const octave = key ? resolveSonic(event, { key }).octave : 0;
    PERC.has(name) ? fn(c, at, undefined, tmpOut) : fn(c, at, noteHz(null, 0, octave), undefined, tmpOut);
  };

  // ── Beat ring buffer (shared reference — mutate in place) ─────────────────────
  const _beatRing    = [];
  const BEAT_RING_MAX = 1000;
  window._beatRing   = _beatRing;

  function _pushToBeatRing(ev) {
    _beatRing.push(ev);
    if (_beatRing.length > BEAT_RING_MAX) _beatRing.shift();
    _pressureTickCount++;
    if (_pressureTickCount % 10 === 0) _updatePressure();
  }

  // ── Client dispatcher: encode once, fan out to independent sinks ───────────
  // Cognition events ride the same ring + audio path: structural/human signals
  // with registry-defined sonic profiles (W-COG surfacing).
  const COGNITION_EVENTS = new Set([
    'human_turn', 'compact', 'permission', 'mode_shift',
    'tool_error', 'api_error', 'chirp', 'attachment', 'scaffold',
    'thinking', 'unknown',
  ]);

  window.playPulse = function (event, data) {
    let ringEv = null;
    let r = null;

    // PROCESS: encode. Viz and audio both read this object; neither produces the other.
    try {
      if (event === 'tool_call' || event === 'words' || event === 'tokens' || COGNITION_EVENTS.has(event)) {
        r = resolveSonic(event, data);

        // Track cache ratios for pressure
        if (event === 'tokens') {
          const total = (data.output || 0) + (data.cache_read || 0);
          const cR = total > 0 ? (data.cache_read || 0) / total : 0;
          _cacheRatioWindow.push(cR);
          if (_cacheRatioWindow.length > 20) _cacheRatioWindow.shift();
        }

        const projNode = (typeof GRAPH !== 'undefined')
          ? GRAPH.nodes.find(n => n.type === 'project' && n.label === data.project)
          : null;
        const cacheRatio = (() => {
          const total = (data.output || 0) + (data.cache_read || 0);
          return total > 0 ? (data.cache_read || 0) / total : 0;
        })();

        ringEv = {
          ts:          Date.now(),
          color:       projNode?.color || '#334466',
          label:       event === 'tool_call' ? (data.tool || 'tool') : event,
          type:        event,
          slug:        data.slug      || null,
          project:     data.project   || null,
          harness:     data.harness   || null,
          tool:        data.tool      || null,
          where:       data.where     || null,
          category:    data.category  || null,
          preview:     data.preview   || null,
          relMs:       data.relMs     != null ? data.relMs : null,
          key:         r.key,
          family:      r.fam,
          output:      data.output    || 0,
          input:       data.input     || 0,
          cache_read:  data.cache_read || 0,
          word_count:  data.word_count || 0,
          cache_ratio: cacheRatio,
          pan:         r.pan,
          brightness:  r.brightness,
        };
        // VIZ SINK — arrival clock. Independent of mute and AudioContext.
        _pushToBeatRing(ringEv);
      }
    } catch {}

    if (muted) return;
    try {
      const S = window.AUDIO_SETTINGS;
      if (!r) r = resolveSonic(event, data);
      const meta = {
        ringEv,
        label: ringEv?.label,
        relMs: data.relMs,
        event,
      };

      if (event === 'tool_call') {
        if (!passesFilter(r.key, data.project)) return;
        const name = r.instrument; if (name === 'off') return;
        const oldMode = S.noteMode;
        if (r.degreeMode && r.degreeMode !== oldMode) S.noteMode = r.degreeMode;
        const hz = noteHz(data.project, getDegree(data.where), r.octave || 0);
        if (r.degreeMode && r.degreeMode !== oldMode) S.noteMode = oldMode;
        schedVoice(name, hz, r.volMult !== 1 ? 0.42 * r.volMult : undefined, r, meta);

      } else if (event === 'tokens') {
        if (!passesFilter('tokens', data.project)) return;
        const name = r.instrument; if (name === 'off') return;
        const hz  = noteHz(data.project, 0, r.octave ?? -1);
        const vol = Math.min(0.11, 0.04 + Math.log1p((data.output || 0) / 300) * 0.028);
        schedVoice(name, hz, vol * r.volMult, r, meta);

      } else if (event === 'words') {
        if (!passesFilter('words', data.project)) return;
        const name = r.instrument; if (name === 'off') return;
        const iv  = SCALES[r.scale] || activeIv();
        const deg = Math.min(iv.length - 1, Math.floor((data.word_count || 0) / 15));
        const hz  = noteHz(data.project, deg, r.octave ?? 1);
        schedVoice(name, hz, 0.11 * r.volMult, r, meta);

      } else if (COGNITION_EVENTS.has(event)) {
        if (!passesFilter(r.key, data.project)) return;
        const name = r.instrument; if (name === 'off') return;
        const hz = noteHz(data.project, 0, r.octave || 0);
        schedVoice(name, hz, 0.12 * r.volMult, r, meta);
      }
    } catch { /* audio must never break UI */ }
  };

  // ── Mute toggle button (hidden on DAW page via CSS, used on main graph page) ──
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    const btn = document.createElement('div');
    btn.id    = 'sound-btn';
    btn.title = 'Toggle pulse sounds';
    btn.style.cssText = 'position:fixed;top:8px;right:110px;background:'+KAARO_TOKENS.card+';color:'+KAARO_TOKENS.dim+';font:bold 10px \'IBM Plex Mono\',monospace;padding:3px 9px;z-index:9998;cursor:pointer;user-select:none;border:1px solid '+KAARO_TOKENS.border+';transition:color .15s,background .15s,border-color .15s;letter-spacing:1px';
    document.body.appendChild(btn);
    function syncSoundButton() {
      btn.textContent = muted ? '♪ OFF' : '♪ ON';
      btn.style.color = muted ? KAARO_TOKENS.dim : '#00ff88';
      btn.style.background = muted ? KAARO_TOKENS.card : '#061a0e';
      btn.style.borderColor = muted ? KAARO_TOKENS.border : '#1a4a2a';
    }
    function setMuted(value) {
      muted = !!value;
      window.updateAudioSettings({ soundEnabled: !muted });
      if (!muted) {
        ac();
        if (window.AUDIO_SETTINGS.clickTrack) _startClick();
      } else {
        _stopClick();
      }
      syncSoundButton();
    }
    syncSoundButton();
    btn.addEventListener('click', () => setMuted(!muted));
    // A saved ON choice still needs a user gesture in browsers that block autoplay.
    const unlockAudio = () => {
      if (muted) return;
      ac();
      if (window.AUDIO_SETTINGS.clickTrack && !_clickTimer) _startClick();
    };
    document.addEventListener('pointerdown', unlockAudio);
    document.addEventListener('keydown', unlockAudio);
    // Expose muted state + toggle for DAW builder's own mute button
    window._getAudioMuted  = () => muted;
    window._setAudioMuted  = (v) => {
      if (v === muted) return;
      setMuted(v);
    };
  }

})();
