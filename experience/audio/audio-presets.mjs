/**
 * lib/audio-presets.mjs — built-in audio presets as pure data.
 *
 * Source of truth for both the Node simulation (lib/audio-sim.mjs) and
 * the browser DAW builder (src/client/19-daw-builder.js).
 * Keep the two copies in sync — test/audio-sim.test.mjs verifies correctness
 * against the canonical data here.
 */

export const AUDIO_PRESETS = {
  'cognitive-flow': {
    name: 'Cognitive Flow',
    tag:  'Pre-attentive · Identity · Sustainable',
    desc: 'Timbre=category, velocity=importance, path-hash pitch for file identity. Major pentatonic.',
    settings: {
      scale: 'major_pentatonic', noteMode: 'path_hash', bpm: 100,
      instruments: {
        // tool-action
        read:'harp', write:'bass', edit:'pling',
        bash_git:'snare', bash_run:'kick', bash_other:'hat',
        grep_glob:'bit', agent:'bell', other:'harp', web:'bell',
        // cognitive / stream
        tokens:'flute', words:'bell', chirp:'pling',
        human_turn:'bell', attachment:'pling', mode_shift:'bell',
        thinking:'bell',
        // structural
        compact:'kick', permission:'hat', scaffold:'pling',
        tool_error:'buzz', tool_result:'harp', api_error:'buzz',
        // rest + catch-all
        silent:'off', unknown:'hat', turn_complete:'bell', input_required:'pling',
      },
    },
    mappings: [
      // Stereo field: left=mutation (write/edit/bash), right=observation/delegation (read/agent/web)
      // Brightness: high=sharp new state (write 10k), medium=stable (read 6.5k), low=git/system (3.5k)
      { match: { key:'write'      }, set: { volMult:1.30, pan:-0.20, send:0.04, brightness:10000 } },
      { match: { key:'edit'       }, set: { volMult:1.00, pan:-0.12, send:0.04, brightness: 8500 } },
      { match: { key:'read'       }, set: { volMult:0.65, pan: 0.05, send:0.05, brightness: 6500 } },
      { match: { key:'grep_glob'  }, set: { volMult:0.55, pan: 0.10, send:0.03, brightness: 5000 } },
      // Bash: hard left, low brightness (warm/subterranean feel for system ops), git louder than run
      { match: { key:'bash_git'   }, set: { volMult:1.10, pan:-0.38, send:0.03, brightness: 3500 } },
      { match: { key:'bash_run'   }, set: { volMult:1.00, pan:-0.32, send:0.03, brightness: 2800 } },
      { match: { key:'bash_other' }, set: { volMult:0.55, pan:-0.30, send:0.02, brightness: 4000 } },
      // Agent: oct+1 (one octave above baseline) + high reverb — cognitive branch is distinctive and spatial
      { match: { key:'agent'      }, set: { volMult:1.20, octave: 1, pan: 0.40, send:0.45, brightness: 5000 } },
      { match: { key:'other'      }, set: { volMult:0.60, pan: 0.00, send:0.06, brightness: 6500 } },
      // Web: far right + oct+1 — network calls feel distant/external, distinct from local file ops
      { match: { key:'web'        }, set: { volMult:0.80, pan: 0.42, send:0.28, brightness: 5500, octave: 1 } },
      // Tokens: quiet flute at oct-1 — cognitive cost is a background layer, not a foreground event
      // Brightness overridden dynamically by cache ratio (see resolveSonic: low bri=warm cache, high=fresh)
      { match: { key:'tokens'     }, set: { volMult:0.50, pan: 0.00, send:0.02, octave:-1 } },
      // Words: bright right channel, moderate reverb — assistant output is primary linguistic content
      { match: { key:'words'      }, set: { volMult:0.90, pan: 0.22, send:0.14, brightness: 9000, octave: 1 } },
      // Chirp: quiet woodblock — micro acks ("Got it.") are structurally present but not primary signal
      { match: { key:'chirp'      }, set: { volMult:0.25, pan: 0.15, send:0.01, brightness: 7000 } },
      // Human turn: centered pad — grounds the session, equal weight L/R (human intent is neutral axis)
      { match: { key:'human_turn' }, set: { volMult:0.65, pan: 0.00, send:0.08, brightness: 7000 } },
      // Attachment: quiet click, slight right — context loading is passive, signals preparation
      { match: { key:'attachment' }, set: { volMult:0.35, pan: 0.05, send:0.02, brightness: 8000 } },
      // Mode shift: centered chime with reverb — plan mode toggle is a rare, significant mode change
      { match: { key:'mode_shift' }, set: { volMult:0.45, pan: 0.00, send:0.10, brightness: 6000 } },
      // Thinking: soft dark pad oct-1, slight left — internal deliberation is quieter than output words
      // Same instrument as human_turn (pad) but dimmer/lower/darker — both are cognitive, different layers
      { match: { key:'thinking'   }, set: { volMult:0.25, pan:-0.10, send:0.06, brightness: 4000, octave:-1 } },
      // Compact: very dark sweep oct-1, no reverb — context reset is a discrete destructive event, not ambient
      { match: { key:'compact'    }, set: { volMult:0.75, pan: 0.00, send:0.00, brightness: 1000, octave:-1 } },
      // Permission: quiet centered tick, no reverb — soft pause signal; volume kept low to avoid fatigue
      { match: { key:'permission' }, set: { volMult:0.35, pan: 0.00, send:0.00, brightness: 3000 } },
      // Scaffold: very quiet, dark oct-1 — system injections are background infrastructure, not user-facing
      { match: { key:'scaffold'   }, set: { volMult:0.30, pan: 0.00, send:0.01, brightness: 2500, octave:-1 } },
      // Tool error: loud buzz oct-1, slight left — errors demand attention but stay dark/low to signal failure
      { match: { key:'tool_error' }, set: { volMult:0.80, pan:-0.10, send:0.05, brightness: 1500, octave:-1 } },
      { match: { key:'api_error'  }, set: { volMult:1.30, pan: 0.00, send:0.10, brightness:  900, octave:-2 } },
      // Tool result: quiet harp — successful response is passive receipt, not action; same instrument as read
      { match: { key:'tool_result'}, set: { volMult:0.35, pan: 0.05, send:0.03, brightness: 5000 } },
      // Unknown: minimal tick — diagnostic signal, not music; low vol to stay audible without cluttering
      { match: { key:'unknown'    }, set: { volMult:0.20, pan: 0.00, send:0.00, brightness: 3000 } },
      { match: { key:'turn_complete' }, set: { volMult:0.7 } },
      { match: { key:'input_required' }, set: { volMult:0.85 } },
      { match: { key:'silent'     }, set: { instrument:'off', volMult:0.00 } },
    ],
  },

  'thrash-detector': {
    name: 'Thrash Detector',
    tag:  'Flow · Tension · Anomaly',
    desc: 'Sequential notes build phrase density. Dorian scale tension. Threshold rules for anomaly salience.',
    settings: {
      scale: 'dorian', noteMode: 'sequential', bpm: 120,
      instruments: {
        // tool-action
        read:'harp', write:'bass', edit:'pling',
        bash_git:'snare', bash_run:'kick', bash_other:'hat',
        grep_glob:'bit', agent:'bell', other:'bit', web:'bell',
        // cognitive / stream
        tokens:'flute', words:'bell', chirp:'pling',
        human_turn:'bell', attachment:'pling', mode_shift:'bell',
        thinking:'bell',
        // structural
        compact:'kick', permission:'hat', scaffold:'pling',
        tool_error:'buzz', tool_result:'harp', api_error:'buzz',
        // rest + catch-all
        silent:'off', unknown:'hat', turn_complete:'bell', input_required:'pling',
      },
    },
    mappings: [
      // Write at oct-1 for thrash: heavy bass mutation sounds like work piling up rather than flowing
      { match: { key:'write'      }, set: { volMult:1.40, pan:-0.25, send:0.05, brightness: 9000, octave:-1 } },
      { match: { key:'edit'       }, set: { volMult:1.10, pan:-0.15, send:0.05, brightness: 8000          } },
      { match: { key:'read'       }, set: { volMult:0.55, pan: 0.00, send:0.04, brightness: 6000          } },
      // Grep slightly louder: thrash sessions often churn grep/glob (searching for the same thing repeatedly)
      { match: { key:'grep_glob'  }, set: { volMult:0.65, pan: 0.12, send:0.03, brightness: 4500          } },
      { match: { key:'bash_git'   }, set: { volMult:1.20, pan:-0.40, send:0.02, brightness: 3000          } },
      // bash_run oct-1: process execution sounds heavy; reveals test-run loops in thrash sessions
      { match: { key:'bash_run'   }, set: { volMult:1.15, pan:-0.35, send:0.02, brightness: 2500, octave:-1 } },
      { match: { key:'bash_other' }, set: { volMult:0.60, pan:-0.28, send:0.02, brightness: 3500          } },
      // Agent: highest reverb of any preset (0.55) — subagent spawning in a thrash session is an anomaly
      { match: { key:'agent'      }, set: { volMult:1.35, pan: 0.45, send:0.55, brightness: 4000, octave: 1 } },
      { match: { key:'other'      }, set: { volMult:0.70, pan: 0.05, send:0.08, brightness: 5500          } },
      { match: { key:'web'        }, set: { volMult:0.95, pan: 0.48, send:0.38, brightness: 5000, octave: 1 } },
      // Tokens threshold rule: heavy output turns (>600) are louder — signals cognitive load spikes
      { match: { key:'tokens', outMin:600 }, set: { volMult:0.90, pan: 0.05, send:0.05, octave:-1, brightness: 6000 } },
      { match: { key:'tokens'     }, set: { volMult:0.40, pan: 0.00, send:0.02, octave:-1, brightness: 4500 } },
      // Words threshold rule: long responses (>40w) stand out — distinguishes dense work from fluff
      { match: { key:'words', wordMin:40 }, set: { volMult:1.10, pan: 0.28, send:0.20, brightness:10000, octave: 1 } },
      { match: { key:'words'      }, set: { volMult:0.75, pan: 0.20, send:0.12, brightness: 8000, octave: 1 } },
      { match: { key:'chirp'      }, set: { volMult:0.20, pan: 0.15, send:0.01, brightness: 7000 } },
      { match: { key:'human_turn' }, set: { volMult:0.60, pan: 0.00, send:0.08, brightness: 7000 } },
      { match: { key:'attachment' }, set: { volMult:0.30, pan: 0.05, send:0.02, brightness: 8000 } },
      { match: { key:'mode_shift' }, set: { volMult:0.40, pan: 0.00, send:0.10, brightness: 6000 } },
      { match: { key:'thinking'   }, set: { volMult:0.25, pan:-0.10, send:0.06, brightness: 4000, octave:-1 } },
      // THRASH SIGNALS: compact + tool_error deliberately boosted to stand out from background texture
      // compact (context reset): vol=1.10 instead of 0.75 — hitting context limits is a thrash indicator
      // tool_error: vol=1.20, reverb=0.08, brightness=1200 — errors are prominent alerts in this preset
      { match: { key:'compact'    }, set: { volMult:1.10, pan: 0.00, send:0.00, brightness: 800,  octave:-1 } },
      // Permission boosted vs CF (0.55 vs 0.35) — repeated permission pauses signal stuck-in-a-loop
      { match: { key:'permission' }, set: { volMult:0.55, pan: 0.00, send:0.00, brightness: 3000 } },
      { match: { key:'scaffold'   }, set: { volMult:0.30, pan: 0.00, send:0.01, brightness: 2500, octave:-1 } },
      { match: { key:'tool_error' }, set: { volMult:1.20, pan:-0.10, send:0.08, brightness: 1200, octave:-1 } },
      { match: { key:'api_error'  }, set: { volMult:1.50, pan: 0.00, send:0.12, brightness:  800, octave:-2 } },
      { match: { key:'tool_result'}, set: { volMult:0.40, pan: 0.05, send:0.03, brightness: 5000 } },
      { match: { key:'unknown'    }, set: { volMult:0.20, pan: 0.00, send:0.00, brightness: 3000 } },
      { match: { key:'turn_complete' }, set: { volMult:0.7 } },
      { match: { key:'input_required' }, set: { volMult:0.85 } },
      { match: { key:'silent'     }, set: { instrument:'off', volMult:0.00 } },
    ],
  },

  'session-arc': {
    name: 'Session Arc',
    tag:  'Multi-scale · Arc · Layers',
    desc: 'Tools=micro texture, token bursts=mid harmonic foundation (bass −2oct), words=macro melody. Blues.',
    settings: {
      scale: 'blues', noteMode: 'path_hash', bpm: 90,
      instruments: {
        // tool-action
        read:'harp', write:'bass', edit:'pling',
        bash_git:'snare', bash_run:'kick', bash_other:'hat',
        grep_glob:'bit', agent:'bell', other:'harp', web:'bell',
        // cognitive / stream
        tokens:'bass', words:'bell', chirp:'pling',
        human_turn:'bell', attachment:'pling', mode_shift:'bell',
        thinking:'bell',
        // structural
        compact:'kick', permission:'hat', scaffold:'pling',
        tool_error:'buzz', tool_result:'harp', api_error:'buzz',
        // rest + catch-all
        silent:'off', unknown:'hat', turn_complete:'bell', input_required:'pling',
      },
    },
    mappings: [
      // LAYER MODEL: micro=tools, mid=tokens, macro=words+human — designed for long session listening
      // All tool volumes slightly lower than CF to let tokens and words emerge
      { match: { key:'write'      }, set: { volMult:1.00, pan:-0.18, send:0.04, brightness: 9500 } },
      { match: { key:'edit'       }, set: { volMult:0.85, pan:-0.10, send:0.04, brightness: 8000 } },
      { match: { key:'read'       }, set: { volMult:0.55, pan: 0.05, send:0.04, brightness: 6000 } },
      { match: { key:'grep_glob'  }, set: { volMult:0.50, pan: 0.10, send:0.03, brightness: 4500 } },
      { match: { key:'bash_git'   }, set: { volMult:0.95, pan:-0.38, send:0.03, brightness: 3500 } },
      { match: { key:'bash_run'   }, set: { volMult:0.90, pan:-0.32, send:0.03, brightness: 2800 } },
      { match: { key:'bash_other' }, set: { volMult:0.45, pan:-0.28, send:0.02, brightness: 3800 } },
      // Agent + web: degreeMode=root so they land on the tonic — delegation events anchor to the key
      { match: { key:'agent'      }, set: { volMult:1.10, pan: 0.42, send:0.50, brightness: 4500, octave: 1, degreeMode:'root' } },
      { match: { key:'other'      }, set: { volMult:0.55, pan: 0.08, send:0.06, brightness: 5500 } },
      { match: { key:'web'        }, set: { volMult:0.85, pan: 0.44, send:0.32, brightness: 5000, octave: 1, degreeMode:'root' } },
      // Tokens: bass instrument at oct-2 — the harmonic FOUNDATION layer; heavy/deep under the melody
      // degreeMode=root so every token event sounds a bass root note, not a random scale degree
      { match: { key:'tokens'     }, set: { instrument:'bass', volMult:0.70, pan:0.00, send:0.05, octave:-2, degreeMode:'root', brightness: 4000 } },
      // Words threshold: long responses (>50w) soar to oct+2, short stay at oct+1 — the melody arc
      { match: { key:'words', wordMin:50 }, set: { volMult:1.20, pan: 0.30, send:0.22, brightness:11000, octave: 2 } },
      { match: { key:'words'      }, set: { volMult:0.90, pan: 0.25, send:0.16, brightness: 9500, octave: 1 } },
      // Chirp silenced: in the 3-layer model, micro-acks would clutter the melody layer without adding info
      { match: { key:'chirp'      }, set: { instrument:'off', volMult:0.00, pan: 0.00, send:0.00, brightness: 1 } },
      // Human turn louder (0.90 vs CF 0.65): macro layer — user prompts shape session arc, need presence
      { match: { key:'human_turn' }, set: { volMult:0.90, pan: 0.00, send:0.10, brightness: 7500 } },
      { match: { key:'attachment' }, set: { volMult:0.30, pan: 0.05, send:0.02, brightness: 8000 } },
      { match: { key:'mode_shift' }, set: { volMult:0.40, pan: 0.00, send:0.10, brightness: 6000 } },
      // Thinking slightly dimmer in session-arc (0.20 vs CF 0.25) — deliberation is a background texture
      { match: { key:'thinking'   }, set: { volMult:0.20, pan:-0.10, send:0.05, brightness: 3500, octave:-1 } },
      // Compact: moderate boost (0.90) — context reset marks a structural division in the session arc
      { match: { key:'compact'    }, set: { volMult:0.90, pan: 0.00, send:0.00, brightness: 800,  octave:-1 } },
      { match: { key:'permission' }, set: { volMult:0.30, pan: 0.00, send:0.00, brightness: 3000 } },
      { match: { key:'scaffold'   }, set: { volMult:0.25, pan: 0.00, send:0.01, brightness: 2500, octave:-1 } },
      { match: { key:'tool_error' }, set: { volMult:0.90, pan:-0.10, send:0.05, brightness: 1500, octave:-1 } },
      { match: { key:'api_error'  }, set: { volMult:1.30, pan: 0.00, send:0.10, brightness:  900, octave:-2 } },
      { match: { key:'tool_result'}, set: { volMult:0.35, pan: 0.05, send:0.03, brightness: 5000 } },
      { match: { key:'unknown'    }, set: { volMult:0.15, pan: 0.00, send:0.00, brightness: 3000 } },
      { match: { key:'turn_complete' }, set: { volMult:0.7 } },
      { match: { key:'input_required' }, set: { volMult:0.85 } },
      { match: { key:'silent'     }, set: { instrument:'off', volMult:0.00 } },
    ],
  },
};

/** Resolve preset by slug key or display name (case-insensitive). */
export function getPreset(nameOrSlug) {
  if (!nameOrSlug) return AUDIO_PRESETS['cognitive-flow'];
  const key = nameOrSlug.toLowerCase().replace(/\s+/g, '-');
  if (AUDIO_PRESETS[key]) return AUDIO_PRESETS[key];
  const match = Object.values(AUDIO_PRESETS).find(p => p.name.toLowerCase() === nameOrSlug.toLowerCase());
  return match || AUDIO_PRESETS['cognitive-flow'];
}

export const PRESET_SLUGS = Object.keys(AUDIO_PRESETS);
