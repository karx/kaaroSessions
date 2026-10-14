// ── Audio settings panel ───────────────────────────────────────────────────────
// Sections: METRONOME · INSTRUMENT FAMILIES · FILTER · SCALE · NOTE
// All changes are live (no reload) and persist via window.updateAudioSettings.

(function() {

  // ── Option definitions ────────────────────────────────────────────────────────
  const INST_OPTS = [
    ['harp','Harp'],['bass','Bass'],['bell','Bell'],['flute','Flute'],
    ['bit','Bit'],['pling','Pling'],['snare','Snare'],['kick','Kick'],['hat','Hi-Hat'],
    ['off','— Off —'],
  ];

  const SCALE_OPTS = [
    ['major_pentatonic','Major Pentatonic  · C D E G A'],
    ['minor_pentatonic','Minor Pentatonic  · C Eb F G Bb'],
    ['blues',           'Blues  · C Eb F F# G Bb'],
    ['major',           'Major  · C D E F G A B'],
    ['dorian',          'Dorian  · C D Eb F G A Bb'],
  ];

  const NOTE_OPTS = [
    ['path_hash', 'Consistent  (path → note)'],
    ['sequential','Ascending  (step up scale)'],
    ['random',    'Random'],
    ['root',      'Root only'],
  ];

  const BPB_OPTS = [2, 3, 4, 8];

  // Tool rows per family — parallel to window.AUDIO_FAMILIES
  const FAM_ROWS = {
    file:    [['read','Read'],['write','Write'],['edit','Edit']],
    system:  [['bash_git','Bash / git'],['bash_run','Bash / run'],['bash_other','Bash / other'],['grep_glob','Grep · Glob']],
    ai:      [['agent','Agent'],['other','Other tools']],
    context: [['tokens','Tokens'],['words','Words']],
  };

  // Track which families are expanded
  const expanded = new Set();

  // ── Panel DOM ─────────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'audio-panel';
  document.body.appendChild(panel);

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function selOpts(opts, cur) {
    return opts.map(([v,t]) => `<option value="${v}"${cur===v?' selected':''}>${t}</option>`).join('');
  }

  function instSel(key, cur, dataAttr) {
    return `<select class="ap-sel" ${dataAttr} onchange="window._apInstChange(this)">${selOpts(INST_OPTS, cur)}</select>`;
  }

  // The "family instrument" value: shared instrument name if all tools agree, else 'mixed'
  function famInstVal(famId) {
    const tools = (window.AUDIO_FAMILIES||[]).find(f=>f.id===famId)?.tools || [];
    const insts = tools.map(t => window.AUDIO_SETTINGS.instruments[t] || 'harp');
    const uniq  = [...new Set(insts)];
    return uniq.length === 1 ? uniq[0] : 'mixed';
  }

  function famInstSel(famId) {
    const cur  = famInstVal(famId);
    const mixOpt = cur === 'mixed' ? '<option value="mixed" selected>— Mixed —</option>' : '<option value="mixed">— Mixed —</option>';
    return `<select class="ap-sel" data-fam-id="${famId}" onchange="window._apFamChange(this)">${mixOpt}${selOpts(INST_OPTS, cur)}</select>`;
  }

  // ── Full render ───────────────────────────────────────────────────────────────
  function render() {
    const S  = window.AUDIO_SETTINGS || {};
    const fi = S.instruments || {};
    const ff = S.filter || {};

    // ── Metronome ──────────────────────────────────────────────────────────────
    const bpm  = S.bpm || 120;
    const bpb  = S.beatsPerBar || 4;
    const cvol = Math.round((S.clickVol || 0.15) * 100);
    const cOn  = !!S.clickTrack;

    const metronome = `
      <div class="ap-sec">◆ METRONOME</div>
      <div class="ap-row ap-bpm-row">
        <input id="ap-bpm-slider" class="ap-range" type="range" min="40" max="240" step="1"
               value="${bpm}" oninput="window._apBpmInput(this.value)"
               onchange="window._apBpmChange(this.value)">
        <span id="ap-bpm-val" class="ap-bpm-val">${bpm}</span>
        <button class="ap-tap-btn" id="ap-tap" onclick="window._apTap()" title="Tap to set BPM">TAP</button>
      </div>
      <div class="ap-chips-row">
        <span class="ap-lbl" style="padding-left:14px">Beats / bar</span>
        ${BPB_OPTS.map(b => `<button class="ap-chip${bpb===b?' on':''}" onclick="window._apBpbChange(${b})">${b}</button>`).join('')}
      </div>
      <div class="ap-row ap-click-row">
        <span class="ap-lbl">Click track</span>
        <button class="ap-toggle${cOn?' on':''}" onclick="window._apClickToggle(this)">${cOn?'ON':'OFF'}</button>
        <input class="ap-range ap-range-sm" type="range" min="0" max="100" step="5"
               value="${cvol}" oninput="window._apClickVol(this.value)" title="Click volume">
      </div>`;

    // ── Instrument families ────────────────────────────────────────────────────
    const families = (window.AUDIO_FAMILIES || []).map(fam => {
      const isExp = expanded.has(fam.id);
      const muted = (ff.mutedFamilies||[]).includes(fam.id);
      const toolsList = (FAM_ROWS[fam.id] || []).map(([,l]) => l).join(' · ');

      const rows = isExp ? (FAM_ROWS[fam.id] || []).map(([key, lbl]) => `
        <div class="ap-row ap-fam-row">
          <span class="ap-lbl ap-fam-lbl">${lbl}</span>
          <div class="ap-sel-wrap">
            ${instSel(key, fi[key]||'harp', `data-inst-key="${key}"`)}
            <button class="ap-prev" onclick="window._apPreview('${key}')" title="Preview">▶</button>
          </div>
        </div>`).join('') : '';

      return `
        <div class="ap-fam${muted?' ap-fam-muted':''}" style="--fc:${fam.color}">
          <div class="ap-fam-hd">
            <button class="ap-fam-expand" onclick="window._apFamToggle('${fam.id}')"
                    title="Expand / collapse tools">${isExp?'▾':'▸'}</button>
            <span class="ap-fam-name">${fam.label}</span>
            <span class="ap-fam-tools">${toolsList}</span>
            ${famInstSel(fam.id)}
            <button class="ap-prev" onclick="window._apFamPreview('${fam.id}')" title="Preview">▶</button>
          </div>
          ${rows ? `<div class="ap-fam-rows">${rows}</div>` : ''}
        </div>`;
    }).join('');

    // ── Filter ─────────────────────────────────────────────────────────────────
    const mFams = ff.mutedFamilies || [];
    const mProjs = ff.mutedProjects || [];
    const famChips = (window.AUDIO_FAMILIES||[]).map(f => {
      const off = mFams.includes(f.id);
      return `<button class="ap-mute-chip${off?' off':''}" style="--fc:${f.color}"
                      data-mute-fam="${f.id}" title="${off?'Muted — click to unmute':'Click to mute'}">${f.label}</button>`;
    }).join('');

    const projNodes = (typeof GRAPH !== 'undefined')
      ? GRAPH.nodes.filter(n => n.type === 'project') : [];
    const projChips = projNodes.map(p => {
      const off = mProjs.includes(p.label);
      const col = off ? '#334' : p.color;
      const bg  = off ? 'transparent' : p.color + '22';
      const bdr = off ? KAARO_TOKENS.border : p.color;
      return `<button class="ap-mute-chip" style="color:${col};background:${bg};border-color:${bdr};${off?'text-decoration:line-through':''}"
                      data-mute-proj="${p.label.replace(/"/g,'&quot;')}">${p.label}</button>`;
    }).join('');

    const filterSection = `
      <div class="ap-sec">◆ FILTER</div>
      <div class="ap-filter-label">Mute families</div>
      <div class="ap-chips-wrap">${famChips}</div>
      ${projNodes.length ? `<div class="ap-filter-label" style="margin-top:5px">Mute projects</div>
      <div class="ap-chips-wrap">${projChips}</div>` : ''}`;

    // ── Scale + Note ───────────────────────────────────────────────────────────
    const scaleNote = `
      <div class="ap-sec">◆ SCALE</div>
      <div class="ap-row ap-row-wide">
        <select class="ap-sel ap-sel-wide" onchange="window._apScaleChange(this)">
          ${selOpts(SCALE_OPTS, S.scale||'major_pentatonic')}
        </select>
      </div>
      <div class="ap-sec">◆ NOTE</div>
      <div class="ap-row ap-row-wide">
        <select class="ap-sel ap-sel-wide" onchange="window._apNoteChange(this)">
          ${selOpts(NOTE_OPTS, S.noteMode||'path_hash')}
        </select>
      </div>`;

    panel.innerHTML = `
      <div class="ap-hd">
        <span class="ap-title">◆ AUDIO</span>
        <button class="ap-x" onclick="window._apClose()" title="Close">✕</button>
      </div>
      ${metronome}
      <div class="ap-sec">◆ INSTRUMENT FAMILIES</div>
      <div class="ap-families">${families}</div>
      ${filterSection}
      ${scaleNote}
      <div class="ap-foot">
        <button class="ap-reset" onclick="window._apReset()">↺ Reset to defaults</button>
      </div>`;

    // Event delegation for mute chips (avoids quote-escaping in onclick)
    panel.addEventListener('click', _chipDelegate, { once: true });
  }

  // ── Mute chip delegation (registered fresh on each render) ───────────────────
  function _chipDelegate(e) {
    const chip = e.target.closest('[data-mute-fam],[data-mute-proj]');
    if (!chip) return;
    if (chip.dataset.muteFam) {
      window._apMuteFam(chip.dataset.muteFam);
    } else if (chip.dataset.muteProj !== undefined) {
      window._apMuteProj(chip.dataset.muteProj);
    }
  }

  // ── Global callbacks ──────────────────────────────────────────────────────────

  window._apInstChange = function(sel) {
    window.updateAudioSettings({ instruments: { [sel.dataset.instKey]: sel.value } });
    // Refresh the family instrument selector for this tool's family
    _refreshFamSel(sel.dataset.instKey);
  };

  window._apFamChange = function(sel) {
    const famId = sel.dataset.famId;
    if (sel.value === 'mixed') return; // no-op: mixed is a display state only
    const fam = (window.AUDIO_FAMILIES||[]).find(f=>f.id===famId);
    if (!fam) return;
    const patch = {};
    for (const t of fam.tools) patch[t] = sel.value;
    window.updateAudioSettings({ instruments: patch });
    // Update individual rows if family is expanded
    if (expanded.has(famId)) {
      panel.querySelectorAll(`[data-inst-key]`).forEach(s => {
        if (fam.tools.includes(s.dataset.instKey)) s.value = sel.value;
      });
    }
  };

  window._apFamToggle = function(famId) {
    if (expanded.has(famId)) expanded.delete(famId); else expanded.add(famId);
    render();
  };

  window._apPreview = function(key) {
    const name = (window.AUDIO_SETTINGS?.instruments||{})[key]||'harp';
    if (name==='off') return;
    if (window.previewInstrument) window.previewInstrument(name, key);
  };

  window._apFamPreview = function(famId) {
    const name = famInstVal(famId);
    if (name==='mixed'||name==='off') return;
    if (window.previewInstrument) window.previewInstrument(name);
  };

  // ── Metronome callbacks ───────────────────────────────────────────────────────
  window._apBpmInput = function(val) {
    const v = parseInt(val);
    const el = document.getElementById('ap-bpm-val');
    if (el) el.textContent = v;
    window.updateAudioSettings({ bpm: v });
    if (window.setClickTrack && window.AUDIO_SETTINGS.clickTrack)
      window.setClickTrack(true, true); // restart click at new BPM
  };

  window._apBpmChange = function(val) {
    window.updateAudioSettings({ bpm: parseInt(val) });
  };

  let _tapTimes = [];
  window._apTap = function() {
    const now = Date.now();
    _tapTimes = _tapTimes.filter(t => now - t < 3000).concat(now);
    const btn = document.getElementById('ap-tap');
    if (_tapTimes.length >= 2) {
      const diffs = _tapTimes.slice(1).map((t,i) => t - _tapTimes[i]);
      const avg   = diffs.reduce((a,b) => a+b) / diffs.length;
      const bpm   = Math.max(40, Math.min(240, Math.round(60000 / avg)));
      window.updateAudioSettings({ bpm });
      if (window.setClickTrack && window.AUDIO_SETTINGS.clickTrack)
        window.setClickTrack(true, true);
      const sl = document.getElementById('ap-bpm-slider');
      const vl = document.getElementById('ap-bpm-val');
      if (sl) sl.value = bpm;
      if (vl) vl.textContent = bpm;
      if (btn) { btn.textContent = bpm; setTimeout(() => { if(btn) btn.textContent='TAP'; },800); }
    } else {
      if (btn) { btn.textContent = '…'; setTimeout(() => { if(btn) btn.textContent='TAP'; },1200); }
    }
  };

  window._apBpbChange = function(n) {
    window.updateAudioSettings({ beatsPerBar: n });
    // Re-render just the chips row (full render preserves expanded state)
    render();
  };

  window._apClickToggle = function(btn) {
    const on = !window.AUDIO_SETTINGS.clickTrack;
    if (window.setClickTrack) window.setClickTrack(on);
    btn.classList.toggle('on', on);
    btn.textContent = on ? 'ON' : 'OFF';
  };

  window._apClickVol = function(val) {
    window.updateAudioSettings({ clickVol: parseInt(val) / 100 });
  };

  // ── Filter callbacks ──────────────────────────────────────────────────────────
  window._apMuteFam = function(famId) {
    const cur = [...(window.AUDIO_SETTINGS.filter?.mutedFamilies||[])];
    const idx = cur.indexOf(famId);
    if (idx >= 0) cur.splice(idx, 1); else cur.push(famId);
    window.updateAudioSettings({ filter: { mutedFamilies: cur } });
    _updateSettingsBtn();
    render();
  };

  window._apMuteProj = function(proj) {
    const cur = [...(window.AUDIO_SETTINGS.filter?.mutedProjects||[])];
    const idx = cur.indexOf(proj);
    if (idx >= 0) cur.splice(idx, 1); else cur.push(proj);
    window.updateAudioSettings({ filter: { mutedProjects: cur } });
    _updateSettingsBtn();
    render();
  };

  // ── Scale / note ──────────────────────────────────────────────────────────────
  window._apScaleChange = function(sel) { window.updateAudioSettings({ scale: sel.value }); };
  window._apNoteChange  = function(sel) { window.updateAudioSettings({ noteMode: sel.value }); };

  // ── Reset ─────────────────────────────────────────────────────────────────────
  window._apReset = function() {
    const d = window.AUDIO_DEFAULTS;
    window.AUDIO_SETTINGS = JSON.parse(JSON.stringify(d));
    try { localStorage.removeItem('kaaro-audio-settings'); } catch {}
    if (window.setClickTrack) window.setClickTrack(false);
    expanded.clear();
    _updateSettingsBtn();
    render();
  };

  window._apClose = function() {
    panel.classList.remove('open');
    const b = document.getElementById('audio-settings-btn');
    if (b) { b.style.color=KAARO_TOKENS.dim; b.style.background=KAARO_TOKENS.card; b.style.borderColor=KAARO_TOKENS.border; }
  };

  // ── Helper: refresh only the family selector after an individual change ───────
  function _refreshFamSel(toolKey) {
    const fam = (window.AUDIO_FAMILIES||[]).find(f=>f.tools.includes(toolKey));
    if (!fam) return;
    const sel = panel.querySelector(`[data-fam-id="${fam.id}"]`);
    if (sel) { const v=famInstVal(fam.id); if(v==='mixed') sel.value='mixed'; else sel.value=v; }
  }

  // ── ⚙ button highlight when filters are active ───────────────────────────────
  function _updateSettingsBtn() {
    const b = document.getElementById('audio-settings-btn');
    if (!b) return;
    const f = window.AUDIO_SETTINGS.filter || {};
    const active = (f.mutedFamilies?.length||0) + (f.mutedProjects?.length||0) > 0;
    b.style.color = active ? '#ff9944' : (panel.classList.contains('open') ? KAARO_TOKENS.label : KAARO_TOKENS.dim);
  }

  // ── ⚙ Settings button ─────────────────────────────────────────────────────────
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    const btn = document.createElement('div');
    btn.id    = 'audio-settings-btn';
    btn.title = 'Audio settings — metronome, instruments, filter';
    btn.style.cssText = 'position:fixed;top:8px;right:160px;background:'+KAARO_TOKENS.card+';color:'+KAARO_TOKENS.dim+';font:bold 12px \'IBM Plex Mono\',monospace;padding:2px 8px;z-index:9998;cursor:pointer;user-select:none;border:1px solid '+KAARO_TOKENS.border+';transition:color .15s,background .15s,border-color .15s;letter-spacing:0';
    btn.textContent = '⚙';
    document.body.appendChild(btn);

    btn.addEventListener('click', () => {
      const opening = !panel.classList.contains('open');
      panel.classList.toggle('open');
      if (opening) {
        render();
        btn.style.color=KAARO_TOKENS.label; btn.style.background=KAARO_TOKENS.card; btn.style.borderColor=KAARO_TOKENS.accent;
      } else {
        btn.style.color=KAARO_TOKENS.dim; btn.style.background=KAARO_TOKENS.card; btn.style.borderColor=KAARO_TOKENS.border;
      }
      _updateSettingsBtn();
    });
  }

})();
