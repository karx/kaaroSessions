/**
 * experience/audio/event-registry.mjs — Audio Event Registry
 *
 * Single source of truth for all audio event types, their default sonic
 * parameters, and per-harness sample traces for TDD.
 *
 * Canonical tool-action key derivation (toolNameToKey) lives in
 * hooks/action-keys.mjs — normalization vocabulary, re-exported here for
 * audio consumers that want one import.
 *
 * Adding a new event type: add one entry here. All presets must then add
 * a mapping rule (enforced by audio-sim.test.mjs preset validation).
 * instrument must be a Playable Instrument or 'off'.
 *
 * `silent` is a rest: known NR, no live sonic. `unknown` is the alarm.
 *
 * Adding a new harness: add its sample traces to the relevant entries.
 * test/harness-parity.test.mjs validates all samples automatically.
 */

export { toolNameToKey, TOOL_ACTION_KEYS } from '../../hooks/action-keys.mjs';

// ── Families ──────────────────────────────────────────────────────────────────
export const FAMILIES = new Set(['file', 'system', 'ai', 'context', 'human', 'meta']);

// ── Event Registry ────────────────────────────────────────────────────────────
/**
 * Each entry shape:
 * {
 *   family:     string   — one of FAMILIES
 *   instrument: string   — default synth voice
 *   pan:        number   — stereo position [-1, 1]
 *   sendAmt:    number   — reverb send [0, 1]
 *   brightness: number   — filter cutoff proxy (higher = brighter)
 *   volMult:    number   — volume multiplier
 *   octave:     number   — octave shift from projectRoot
 *   desc:       string   — one-line human description
 *   samples:    object   — { [harness]: { version, record, expect } } (TDD)
 * }
 */
export const EVENT_TYPES = {

  // ── Tool-action sub-keys (carried on tool_call pulses via data.key) ──────

  read: {
    family: 'file', instrument: 'harp', pan: 0.05, sendAmt: 0.05,
    brightness: 6500, volMult: 0.65, octave: 0,
    desc: 'File read — observing existing state',
    samples: {
      'claude-code': {
        version: 1,
        record: {
          type: 'assistant', timestamp: '2026-06-09T10:00:00.000Z',
          message: { usage: { input_tokens: 10, output_tokens: 5 }, content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'src/index.mjs' } },
          ]},
        },
        expect: [{ kind: 'tool_use', tool: 'Read' }],
      },
      'antigravity': {
        version: 1,
        record: {
          source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-06-09T10:00:00Z',
          tool_calls: [{ name: 'view_file', args: { AbsolutePath: '"d:\\\\src\\\\index.mjs"' } }],
        },
        expect: [{ kind: 'tool_use', tool: 'view_file' }],
      },
      'opencode': {
        version: 1,
        record: {
          id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', tool: 'read',
          state: { status: 'completed', input: { filePath: 'src/index.mjs' }, time: { start: 1, end: 2 } },
        },
        expect: [{ kind: 'tool_use', tool: 'read' }],
      },
    },
  },

  write: {
    family: 'file', instrument: 'bass', pan: -0.15, sendAmt: 0.05,
    brightness: 10000, volMult: 1.30, octave: 0,
    desc: 'File write — creating new state',
    samples: {
      'claude-code': {
        version: 1,
        record: {
          type: 'assistant', timestamp: '2026-06-09T10:00:00.000Z',
          message: { content: [
            { type: 'tool_use', name: 'Write', input: { file_path: 'out.mjs', content: 'x' } },
          ]},
        },
        expect: [{ kind: 'tool_use', tool: 'Write' }],
      },
      'opencode': {
        version: 1,
        record: {
          id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', tool: 'write',
          state: { status: 'completed', input: { filePath: 'out.mjs' }, time: { start: 1, end: 2 } },
        },
        expect: [{ kind: 'tool_use', tool: 'write' }],
      },
    },
  },

  edit: {
    family: 'file', instrument: 'pling', pan: -0.10, sendAmt: 0.05,
    brightness: 8500, volMult: 1.00, octave: 0,
    desc: 'File edit — mutating existing state',
    samples: {
      'claude-code': {
        version: 1,
        record: {
          type: 'assistant', timestamp: '2026-06-09T10:00:00.000Z',
          message: { content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.mjs', old_string: 'x', new_string: 'y' } },
          ]},
        },
        expect: [{ kind: 'tool_use', tool: 'Edit' }],
      },
      'antigravity': {
        version: 1,
        record: {
          source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-06-09T10:00:00Z',
          tool_calls: [{ name: 'replace_file_content', args: { AbsolutePath: '"d:\\\\src\\\\a.mjs"' } }],
        },
        expect: [{ kind: 'tool_use', tool: 'replace_file_content' }],
      },
      'opencode': {
        version: 1,
        record: {
          id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', tool: 'edit',
          state: { status: 'completed', input: { filePath: 'src/a.mjs' }, time: { start: 1, end: 2 } },
        },
        expect: [{ kind: 'tool_use', tool: 'edit' }],
      },
    },
  },

  grep_glob: {
    family: 'file', instrument: 'bit', pan: 0.10, sendAmt: 0.03,
    brightness: 5000, volMult: 0.55, octave: 0,
    desc: 'Search / glob — scanning the codebase',
    samples: {
      'claude-code': {
        version: 1,
        record: {
          type: 'assistant', timestamp: '2026-06-09T10:00:00.000Z',
          message: { content: [
            { type: 'tool_use', name: 'Grep', input: { pattern: 'resolveSonic' } },
          ]},
        },
        expect: [{ kind: 'tool_use', tool: 'Grep' }],
      },
      'opencode': {
        version: 1,
        record: {
          id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', tool: 'glob',
          state: { status: 'completed', input: { pattern: '**/*.mjs' }, time: { start: 1, end: 2 } },
        },
        expect: [{ kind: 'tool_use', tool: 'glob' }],
      },
    },
  },

  agent: {
    family: 'ai', instrument: 'bell', pan: 0.35, sendAmt: 0.40,
    brightness: 4500, volMult: 1.20, octave: 1,
    desc: 'Subagent delegation — spawning a cognitive branch',
    samples: {
      'claude-code': {
        version: 1,
        record: {
          type: 'assistant', timestamp: '2026-06-09T10:00:00.000Z',
          message: { content: [
            { type: 'tool_use', name: 'Agent', input: { description: 'explore codebase' } },
          ]},
        },
        expect: [{ kind: 'tool_use', tool: 'Agent' }],
      },
      'opencode': {
        version: 1,
        record: {
          id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', tool: 'task',
          state: { status: 'completed', input: {}, title: 'explore codebase', time: { start: 1, end: 2 } },
        },
        expect: [{ kind: 'tool_use', tool: 'task' }],
      },
    },
  },

  bash_git: {
    family: 'system', instrument: 'snare', pan: -0.30, sendAmt: 0.03,
    brightness: 3500, volMult: 1.10, octave: 0,
    desc: 'Git command — version control operation',
  },

  bash_run: {
    family: 'system', instrument: 'kick', pan: -0.30, sendAmt: 0.03,
    brightness: 2800, volMult: 1.00, octave: 0,
    desc: 'Process execution — running tests, builds, scripts',
  },

  bash_other: {
    family: 'system', instrument: 'hat', pan: -0.30, sendAmt: 0.02,
    brightness: 4000, volMult: 0.55, octave: 0,
    desc: 'Shell command — miscellaneous system operation',
  },

  web: {
    family: 'ai', instrument: 'bell', pan: 0.45, sendAmt: 0.28,
    brightness: 5500, volMult: 0.80, octave: 1,
    desc: 'Web fetch / search — reaching outside the local codebase',
  },

  other: {
    family: 'ai', instrument: 'harp', pan: 0.00, sendAmt: 0.06,
    brightness: 6500, volMult: 0.60, octave: 0,
    desc: 'Unmapped tool call — catch-all for unclassified tools',
  },

  // ── Cognitive / stream types ───────────────────────────────────────────────

  tokens: {
    family: 'context', instrument: 'flute', pan: 0.00, sendAmt: 0.02,
    brightness: 5000, volMult: 0.50, octave: -1,
    desc: 'Token usage — cognitive cost of a model turn; brightness encodes cache ratio',
    samples: {
      'claude-code': {
        version: 1,
        record: {
          type: 'assistant', timestamp: '2026-06-09T10:00:00.000Z',
          message: { usage: { input_tokens: 500, output_tokens: 200,
            cache_creation_input_tokens: 0, cache_read_input_tokens: 8000 }, content: [] },
        },
        expect: [{ kind: 'tokens', tokens: { input: 500, output: 200, cache_create: 0, cache_read: 8000 } }],
      },
      'opencode': {
        version: 1,
        record: {
          id: 'msg_1', sessionID: 'ses_1', role: 'assistant', time: { created: 1, completed: 2 },
          modelID: 'big-pickle', providerID: 'opencode', finish: 'tool-calls',
          tokens: { input: 500, output: 200, reasoning: 0, cache: { read: 8000, write: 0 } },
        },
        expect: [{ kind: 'tokens', tokens: { input: 500, output: 200, cache_create: 0, cache_read: 8000 } }],
      },
    },
  },

  words: {
    family: 'context', instrument: 'bell', pan: 0.20, sendAmt: 0.15,
    brightness: 9000, volMult: 0.90, octave: 1,
    desc: 'Assistant text ≥3 words — linguistic output, cognitive expression',
    samples: {
      'claude-code': {
        version: 1,
        record: {
          type: 'assistant', timestamp: '2026-06-09T10:00:00.000Z',
          message: { content: [{ type: 'text', text: 'Running the tests now.' }] },
        },
        expect: [{ kind: 'content_block', block_type: 'text', text: 'Running the tests now.' }],
      },
      'opencode': {
        version: 1,
        record: { id: 'prt_1', type: 'text', time: { start: 1 }, text: 'Running the tests now.' },
        expect: [{ kind: 'content_block', block_type: 'text', text: 'Running the tests now.' }],
      },
    },
  },

  chirp: {
    family: 'context', instrument: 'pling', pan: 0.15, sendAmt: 0.01,
    brightness: 7000, volMult: 0.30, octave: 0,
    desc: 'Assistant text <3 words — micro-acknowledgement (Got it., Writing now.)',
    samples: {
      'claude-code': {
        version: 1,
        record: {
          type: 'assistant', timestamp: '2026-06-09T10:00:00.000Z',
          message: { content: [{ type: 'text', text: 'Got it.' }] },
        },
        expect: [{ kind: 'content_block', block_type: 'text', text: 'Got it.' }],
      },
      'opencode': {
        version: 1,
        record: { id: 'prt_1', type: 'text', time: { start: 1 }, text: 'Got it.' },
        expect: [{ kind: 'content_block', block_type: 'text', text: 'Got it.' }],
      },
    },
  },

  human_turn: {
    family: 'human', instrument: 'bell', pan: 0.00, sendAmt: 0.08,
    brightness: 7000, volMult: 0.70, octave: 0,
    desc: 'User prompt — grounds AI activity with human intent; amplitude scales with prompt length',
    samples: {
      'claude-code': {
        version: 1,
        record: {
          type: 'user', timestamp: '2026-06-09T10:00:00.000Z',
          message: { content: [{ type: 'text', text: 'Run all the tests please' }] },
        },
        expect: [{ kind: 'user_turn', harness: 'claude-code' }],
      },
      'antigravity': {
        version: 1,
        record: {
          source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-06-09T10:00:00Z',
          content: '<USER_REQUEST>\nRun all the tests please\n</USER_REQUEST>',
        },
        expect: [{ kind: 'user_turn', harness: 'antigravity' }],
      },
      'opencode': {
        version: 1,
        record: {
          id: 'msg_1', sessionID: 'ses_1', role: 'user', time: { created: 1 },
          _parts: [{ id: 'prt_1', type: 'text', text: 'Run all the tests please' }],
        },
        expect: [{ kind: 'user_turn', harness: 'opencode' }],
      },
    },
  },

  attachment: {
    family: 'human', instrument: 'pling', pan: 0.05, sendAmt: 0.02,
    brightness: 8000, volMult: 0.40, octave: 0,
    desc: 'Context attachment — files, task lists, or skills loaded into the agent context',
  },

  mode_shift: {
    family: 'context', instrument: 'bell', pan: 0.00, sendAmt: 0.10,
    brightness: 6000, volMult: 0.50, octave: 0,
    desc: 'Mode or agent change — plan mode toggle, ai-title change, subagent delegation shift',
  },

  // ── Structural types ───────────────────────────────────────────────────────

  compact: {
    family: 'system', instrument: 'kick', pan: 0.00, sendAmt: 0.00,
    brightness: 1000, volMult: 0.80, octave: -1,
    desc: 'Context compaction — destructive event; context window hit its limit and was reset',
    samples: {
      'claude-code': {
        version: 1,
        record: {
          type: 'system', subtype: 'compact_boundary', timestamp: '2026-06-09T10:00:00.000Z',
        },
        expect: [{ kind: 'context_reset', harness: 'claude-code' }],
      },
    },
  },

  permission: {
    family: 'system', instrument: 'hat', pan: 0.00, sendAmt: 0.00,
    brightness: 3000, volMult: 0.40, octave: 0,
    desc: 'Permission pause — agent waiting for user approval; audible tension while blocked',
    samples: {
      'claude-code': {
        version: 1,
        record: {
          type: 'permission-mode', timestamp: '2026-06-09T10:00:00.000Z', permissionMode: 'default',
        },
        expect: [{ kind: 'permission_mode', harness: 'claude-code' }],
      },
    },
  },

  scaffold: {
    family: 'system', instrument: 'pling', pan: 0.00, sendAmt: 0.01,
    brightness: 2500, volMult: 0.35, octave: -1,
    desc: 'System scaffold — EPHEMERAL_MESSAGE or system injection; harness guardrails entering context',
    samples: {
      'antigravity': {
        version: 1,
        record: {
          source: 'SYSTEM', type: 'EPHEMERAL_MESSAGE', created_at: '2026-06-09T10:00:00Z',
          content: 'You are in planning mode. Research before acting.',
        },
        expect: [{ kind: 'scaffold', harness: 'antigravity' }],
      },
    },
  },

  tool_error: {
    family: 'system', instrument: 'buzz', pan: -0.10, sendAmt: 0.05,
    brightness: 1500, volMult: 0.90, octave: -1,
    desc: 'Tool failure — non-zero exit code or error response from a tool call',
  },

  tool_result: {
    family: 'system', instrument: 'harp', pan: 0.05, sendAmt: 0.03,
    brightness: 5000, volMult: 0.40, octave: 0,
    desc: 'Tool result — successful response payload; volume scales with payload size',
  },

  api_error: {
    family: 'system', instrument: 'buzz', pan: 0.00, sendAmt: 0.10,
    brightness: 900, volMult: 1.30, octave: -2,
    desc: 'Harness/API failure — quota exceeded, rate limit, auth error; the loudest, lowest alarm in the mix',
  },

  thinking: {
    family: 'context', instrument: 'bell', pan: -0.10, sendAmt: 0.06,
    brightness: 4000, volMult: 0.25, octave: -1,
    desc: "Extended thinking — Claude's internal deliberation before acting; soft pad signals cognition in progress",
  },

  // ── Silent rest + catch-all ───────────────────────────────────────────────

  silent: {
    family: 'meta', instrument: 'off', pan: 0.00, sendAmt: 0.00,
    brightness: 0, volMult: 0.00, octave: 0,
    desc: 'Known NR with no live sonic — envelope, snapshot, or duplicate. Not a coverage gap',
  },

  unknown: {
    family: 'meta', instrument: 'hat', pan: 0.00, sendAmt: 0.00,
    brightness: 3000, volMult: 0.25, octave: 0,
    desc: 'Unknown event — coverage hole only (unknown_record or unclassified kind)',
  },
};

// ── Derived sets ──────────────────────────────────────────────────────────────

export const EVENT_TYPE_KEYS = new Set(Object.keys(EVENT_TYPES));

/** Voices `14-pulse-audio.js` INSTS actually implements, plus `off`. */
export const PLAYABLE_INSTRUMENTS = new Set([
  'harp', 'bass', 'bell', 'flute', 'bit', 'pling',
  'snare', 'kick', 'hat', 'buzz', 'off',
]);

/** Aspirational registry names → playable stand-ins until those synths exist. */
export const PLAYABLE_FALLBACK = {
  pad: 'bell', click: 'pling', chime: 'bell',
  tick: 'hat', woodblock: 'pling', sweep: 'kick',
};

export function playableInstrument(name) {
  if (!name) return 'harp';
  if (PLAYABLE_INSTRUMENTS.has(name)) return name;
  return PLAYABLE_FALLBACK[name] || 'harp';
}
