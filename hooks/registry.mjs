/**
 * hooks/registry.mjs
 *
 * Declarative registry of harness descriptors — THE single source of truth
 * for everything per-harness: roots, capabilities, watch config, and the
 * adapter (recordsToNormalized). serve.mjs, scan dispatch, and the
 * experience layer (via /api/harnesses) all consume this.
 *
 * === Adding a new harness ===
 * 1. Implement hooks/adapters/<new>.mjs with recordsToNormalized() → NormalizedRecord[]
 *    (kinds per hooks/normalized-record.mjs — the compliance test enforces it).
 * 2. Add the descriptor below: id, label, roots, capabilities, adapter,
 *    watch.matchLogFile/ctxFromPath/rebuildArg.
 * 3. Add scanner + analyze<New>Session in hooks/analyzers/analyze-<new>.mjs
 *    (delegate to reduceSession + the adapter) and wire it in
 *    surface/scan-harnesses.mjs.
 * 4. Add tests: adapter golden + a golden session in
 *    test/adapters/nr-compliance.test.mjs.
 * 5. Update docs/harnesses.md matrix.
 */

import { deriveLabel } from './helpers/analyze-helpers.mjs';
import {
  CLAUDE_PROJECTS_ROOT, CODEX_HOME_ROOT, PI_SESSIONS_ROOT, ANTIGRAVITY_BRAIN_ROOT, GROK_SESSIONS_ROOT,
  OPENCODE_ROOT, OPENCODE_STORAGE_ROOT, COPILOT_WORKSPACE_STORAGE_ROOT, COMMANDCODE_PROJECTS_ROOT,
} from './harness-paths.mjs';
import { deriveGrokProjectId, deriveGrokLabel } from './helpers/grok-helpers.mjs';
import { copilotWorkspaceLabel } from './helpers/copilot-helpers.mjs';
import { opencodeSessionLabel, OPENCODE_VERSION_MARKERS } from './helpers/opencode-helpers.mjs';
import {
  locateClaudeCodeSession, locateCodexSession, locatePiSession, locateAntigravitySession, locateGrokSession,
  locateOpencodeSession, locateCopilotSession, locateCommandCodeSession,
} from './session-locators.mjs';
import path from 'node:path';
import { parseJsonlFile } from './jsonl-io.mjs';
import { readGrokSession } from './analyzers/analyze-grok.mjs';
import { readOpencodeSession, readOpencodeDbSession } from './analyzers/analyze-opencode.mjs';
import { readCopilotSession } from './analyzers/analyze-copilot.mjs';

// Default transcript reader for JSONL-file harnesses; harness-specific
// readers (grok dir+summary, opencode three-tree, copilot op-log) override.
function readJsonlRecords(filePath) {
  return { records: parseJsonlFile(filePath).records };
}
import { recordsToNormalized as ccAdapter }   from './adapters/claude-code.mjs';
import { recordsToNormalized as codexAdapter } from './adapters/codex.mjs';
import { recordsToNormalized as piAdapter }   from './adapters/pi.mjs';
import { recordsToNormalized as agAdapter }   from './adapters/antigravity.mjs';
import { recordsToNormalized as grokAdapter } from './adapters/grok.mjs';
import { recordsToNormalized as ocAdapter }   from './adapters/opencode.mjs';
import { recordsToNormalized as cpAdapter }   from './adapters/copilot.mjs';
import { recordsToNormalized as cmdAdapter }  from './adapters/command-code.mjs';

export {
  CODEX_HOME_ROOT, PI_SESSIONS_ROOT, ANTIGRAVITY_BRAIN_ROOT, GROK_SESSIONS_ROOT, OPENCODE_STORAGE_ROOT,
  COPILOT_WORKSPACE_STORAGE_ROOT, COMMANDCODE_PROJECTS_ROOT,
} from './harness-paths.mjs';

function derivePiLabel(slug) {
  return deriveLabel(slug.replace(/^--/, '').replace(/--$/, ''));
}

export const HARNESS_IDS = ['claude-code', 'codex', 'pi', 'antigravity', 'grok', 'opencode', 'copilot', 'command-code'];

function opencodeSlug(sessionId) {
  return sessionId.replace(/^ses_/, '').slice(0, 8);
}

function deriveCCProjectLabel(projectId) {
  // Project IDs are like "users-arshigoyal-kaaro-src-kaaro-sessions"
  return deriveLabel(projectId.replace(/^users-[^-]+-/, ''));
}

/** @type {HarnessDescriptor[]} */
export const HARNESS_REGISTRY = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    adapter: ccAdapter,
    scan: { module: '../analyze.mjs', export: 'scanClaudeCodeSessions' },
    locateSession: locateClaudeCodeSession,
    readSessionRecords: readJsonlRecords,
    roots: [CLAUDE_PROJECTS_ROOT],
    capabilities: {
      tokens: true, pulse: true, trace: true,
      context_resets: true, ai_title: true, subagent_count: true, branches: true,
      subagent_tree: true,
      size_proxy: 'tokens_work',
    },
    watch: {
      matchLogFile: (rel) => {
        const p = rel.replace(/\\/g, '/');
        if (p.endsWith('.jsonl')) return true;
        // Sidechain meta: proj/<parent>/subagents/agent-*.meta.json
        if (p.endsWith('.meta.json') && p.includes('/subagents/')) return true;
        return false;
      },
      ctxFromPath(relPath) {
        const parts = relPath.replace(/\\/g, '/').split('/');
        if (parts.length < 2) return null;
        const project_id = parts[0];
        // Nested sidechain: proj/<parent>/subagents/agent-*.{jsonl,meta.json} → parent
        if (parts.length >= 4 && parts[2] === 'subagents') {
          const parent_id = parts[1];
          const leaf = parts[3]
            .replace(/\.meta\.json$/i, '')
            .replace(/\.jsonl$/i, '')
            .replace(/^agent-/, '');
          return {
            harness: 'claude-code', session_id: parent_id,
            slug: parent_id.slice(0, 8), project_id,
            project_label: deriveLabel(project_id),
            agent_id: leaf,
          };
        }
        if (!parts[1].endsWith('.jsonl')) return null;
        const session_id = parts[1].replace(/\.jsonl$/, '');
        return {
          harness: 'claude-code', session_id,
          slug: session_id.slice(0, 8), project_id,
          project_label: deriveLabel(project_id),
        };
      },
      rebuildArg(relPath) {
        const parts = relPath.replace(/\\/g, '/').split('/');
        if (parts.length === 2 && parts[1].endsWith('.jsonl'))
          return `--session=${parts[0]}/${parts[1]}`;
        // Sidechain jsonl or meta → rebuild parent session jsonl
        if (parts.length >= 4 && parts[2] === 'subagents') {
          return `--session=${parts[0]}/${parts[1]}.jsonl`;
        }
        return null;
      },
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    adapter: codexAdapter,
    scan: { module: './analyzers/analyze-codex.mjs', export: 'scanCodexSessions' },
    locateSession: locateCodexSession,
    readSessionRecords: readJsonlRecords,
    roots: [CODEX_HOME_ROOT],
    capabilities: {
      tokens: true, pulse: true, trace: true, // tokens are output-only (input/cache are per-request context-window snapshots, not per-turn deltas — see docs/CODEX.md)
      context_resets: false, ai_title: true, subagent_count: false, branches: true,
      size_proxy: 'tokens_work',
    },
    watch: {
      matchLogFile(rel) {
        const n = rel.replace(/\\/g, '/');
        return /^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-.*\.jsonl$/.test(n);
      },
      ctxFromPath(relPath) {
        const n = relPath.replace(/\\/g, '/');
        const file = path.basename(n);
        const session_id = file.replace(/\.jsonl$/, '').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1];
        if (!session_id) return null;
        return {
          harness: 'codex', session_id,
          slug: session_id.slice(0, 8),
          project_id: null,
          project_label: 'Codex',
        };
      },
      rebuildArg: () => null,
    },
  },
  {
    id: 'pi',
    label: 'Pi',
    adapter: piAdapter,
    scan: { module: './analyzers/analyze-pi.mjs', export: 'scanPiSessions' },
    locateSession: locatePiSession,
    readSessionRecords: readJsonlRecords,
    roots: [PI_SESSIONS_ROOT],
    capabilities: {
      tokens: true, pulse: true, trace: true,
      context_resets: false, ai_title: false, subagent_count: false, branches: false,
      size_proxy: 'tokens_work',
    },
    watch: {
      matchLogFile: (rel) => rel.replace(/\\/g, '/').endsWith('.jsonl'),
      ctxFromPath(relPath) {
        const parts = relPath.replace(/\\/g, '/').split('/');
        if (parts.length < 2) return null;
        const project_id = parts[0];
        const base       = parts[1].replace(/\.jsonl$/, '');
        const session_id = base.includes('_') ? base.slice(base.indexOf('_') + 1) : base;
        return {
          harness: 'pi', session_id,
          slug: session_id.slice(0, 8), project_id,
          project_label: derivePiLabel(project_id),
        };
      },
      // Pi's incremental path is not yet wired in analyze.mjs (CC-only fast path).
      // Return null so serve falls back to full --all-harnesses scan safely.
      rebuildArg: () => null,
    },
  },
  {
    id: 'antigravity',
    label: 'Google Antigravity',
    adapter: agAdapter,
    scan: { module: './analyzers/analyze-antigravity.mjs', export: 'scanAntigravitySessions' },
    locateSession: locateAntigravitySession,
    readSessionRecords: readJsonlRecords,
    roots: [ANTIGRAVITY_BRAIN_ROOT],
    capabilities: {
      tokens: false, pulse: true, trace: true,
      context_resets: true, ai_title: true, subagent_count: true, branches: false,
      size_proxy: 'tool_calls',
    },


    watch: {
      matchLogFile: (rel) => {
        const n = rel.replace(/\\/g, '/');
        return n.endsWith('transcript.jsonl') || n.endsWith('overview.txt');
      },
      ctxFromPath(relPath) {
        const parts = relPath.replace(/\\/g, '/').split('/');
        const convIdx = parts.findIndex((p, i) =>
          parts[i + 1] === '.system_generated' && parts[i + 2] === 'logs'
        );
        if (convIdx < 0) return null;
        const session_id = parts[convIdx];
        return {
          harness: 'antigravity', session_id,
          slug: session_id.slice(0, 8),
          project_id: null,
          project_label: 'antigravity',
        };
      },
      rebuildArg: (relPath) => {
        const parts = relPath.replace(/\\/g, '/').split('/');
        const convIdx = parts.findIndex((p, i) =>
          parts[i + 1] === '.system_generated' && parts[i + 2] === 'logs'
        );
        if (convIdx < 0) return null;
        return `--session=antigravity/${parts[convIdx]}`;
      },

    },
  },
  {
    id: 'grok',
    label: 'Grok Build',
    adapter: grokAdapter,
    scan: { module: './analyzers/analyze-grok.mjs', export: 'scanGrokSessions' },
    locateSession: locateGrokSession,
    // Session meta (title, branch) lives beside the transcript in summary.json.
    readSessionRecords(filePath) {
      const grok = readGrokSession(path.dirname(filePath));
      return {
        records: grok.records,
        traceOpts: {
          ai_title:   grok.summary?.generated_title || grok.summary?.session_summary || null,
          git_branch: grok.summary?.head_branch || null,
        },
      };
    },
    roots: [GROK_SESSIONS_ROOT],
    capabilities: {
      tokens: false, pulse: true, trace: true,
      context_resets: true, ai_title: true, subagent_count: true, branches: true,
      size_proxy: 'tool_calls',
    },
    watch: {
      matchLogFile(rel) {
        const n = rel.replace(/\\/g, '/');
        const parts = n.split('/');
        return parts.length >= 3 && parts[parts.length - 1] === 'updates.jsonl';
      },
      ctxFromPath(relPath) {
        const parts = relPath.replace(/\\/g, '/').split('/');
        if (parts.length < 3 || parts[parts.length - 1] !== 'updates.jsonl') return null;
        const encoded_cwd = parts[0];
        const session_id  = parts[1];
        return {
          harness: 'grok', session_id,
          slug: session_id.slice(0, 8),
          project_id: deriveGrokProjectId(encoded_cwd),
          project_label: deriveGrokLabel(encoded_cwd),
        };
      },
      rebuildArg: () => null,
    },
  },
  {
    id: 'opencode',
    label: 'opencode',
    adapter: ocAdapter,
    scan: { module: './analyzers/analyze-opencode.mjs', export: 'scanOpencodeSessions' },
    locateSession: locateOpencodeSession,
    // filePath is either the session info doc (JSON) or opencode.db (SQLite).
    readSessionRecords(filePath, sessionId) {
      if (filePath.endsWith('.db')) {
        const result = readOpencodeDbSession(filePath, sessionId);
        return { records: result?.records || [] };
      }
      const storageRoot = path.dirname(path.dirname(path.dirname(filePath)));
      return { records: readOpencodeSession(storageRoot, filePath).records };
    },
    roots: [OPENCODE_ROOT, OPENCODE_STORAGE_ROOT],
    capabilities: {
      tokens: true, pulse: true, trace: true,
      context_resets: false, ai_title: true, subagent_count: false, branches: false,
      size_proxy: 'tokens_work',
    },
    watch: {
      // Storage spreads a session across three JSON trees (opencode <= 1.0.x)
      // or a SQLite db (opencode >= 1.18.x); only these carry transcript signal.
      matchLogFile(rel) {
        const n = rel.replace(/\\/g, '/');
        return /^(?:storage\/)?session\/[^/]+\/ses_[^/]+\.json$/.test(n)
            || /^(?:storage\/)?message\/[^/]+\/msg_[^/]+\.json$/.test(n)
            || /^(?:storage\/)?part\/[^/]+\/prt_[^/]+\.json$/.test(n)
            || n === 'opencode.db'
            || n === 'opencode.db-wal';
      },
      // Files are whole pretty-printed JSON documents (read_mode: json) or SQLite db.
      ctxFromPath(relPath) {
        const n = relPath.replace(/\\/g, '/');
        if (n === 'opencode.db' || n === 'opencode.db-wal') {
          return {
            harness: 'opencode', session_id: null,
            slug: null, project_id: null, project_label: null,
            read_mode: 'sqlite',
            version_marker: OPENCODE_VERSION_MARKERS.V2_SQLITE_DB,
          };
        }
        let stripped = n;
        if (stripped.startsWith('storage/')) stripped = stripped.slice('storage/'.length);
        const parts = stripped.split('/');
        if (parts.length < 3) return null;
        let session_id = null;
        if (parts[0] === 'session')      session_id = parts[2].replace(/\.json$/, '');
        else if (parts[0] === 'message') session_id = parts[1];
        // part/<messageID>/… — sessionID lives inside the JSON body; serve fills it
        return {
          harness: 'opencode', session_id,
          slug: session_id ? opencodeSlug(session_id) : null,
          project_id: null, project_label: null, // resolveProjectLabel fills this lazily
          read_mode: 'json',
          version_marker: OPENCODE_VERSION_MARKERS.V1_STORAGE_JSON,
        };
      },
      // message/part docs carry no directory/cwd of their own — resolve the
      // session's directory from its info doc or SQLite row, cached per session id.
      resolveProjectLabel: (ctx, absPath) => {
        if (absPath.endsWith('.db') || absPath.endsWith('.db-wal')) {
          return opencodeSessionLabel(ctx.session_id, path.dirname(absPath));
        }
        return opencodeSessionLabel(ctx.session_id, path.dirname(path.dirname(path.dirname(absPath))));
      },
      rebuildArg: () => null,
    },
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    adapter: cpAdapter,
    scan: { module: './analyzers/analyze-copilot.mjs', export: 'scanCopilotSessions' },
    locateSession: locateCopilotSession,
    readSessionRecords(filePath) {
      return { records: readCopilotSession(filePath).records };
    },
    roots: [COPILOT_WORKSPACE_STORAGE_ROOT],
    capabilities: {
      tokens: true, pulse: true, trace: true, // tokens are output-only (completionTokens)
      context_resets: false, ai_title: true, subagent_count: false, branches: false,
      size_proxy: 'tokens_work',
    },
    watch: {
      // live format is the .jsonl op-log (tailable); old .json dumps are
      // analysis-only (covered by the scanner, not the watcher)
      matchLogFile(rel) {
        const n = rel.replace(/\\/g, '/');
        return /^[^/]+\/chatSessions\/[^/]+\.jsonl$/.test(n);
      },
      ctxFromPath(relPath) {
        const parts = relPath.replace(/\\/g, '/').split('/');
        if (parts.length !== 3) return null;
        const session_id = parts[2].replace(/\.jsonl$/, '');
        return {
          harness: 'copilot', session_id,
          slug: session_id.slice(0, 8),
          project_id: null, project_label: null, // resolveProjectLabel fills this lazily
          workspace_hash: parts[0],
        };
      },
      // Project attribution lives in <ws>/workspace.json, not the watched path —
      // serve calls this when ctx.project_label is null (cached per ws hash).
      resolveProjectLabel: (ctx, absPath) => copilotWorkspaceLabel(absPath, ctx.workspace_hash),
      rebuildArg: () => null,
    },
  },
  {
    id: 'command-code',
    label: 'Command Code',
    adapter: cmdAdapter,
    scan: { module: './analyzers/analyze-command-code.mjs', export: 'scanCommandCodeSessions' },
    locateSession: locateCommandCodeSession,
    readSessionRecords: readJsonlRecords,
    roots: [COMMANDCODE_PROJECTS_ROOT],
    capabilities: {
      tokens: false, pulse: true, trace: true,
      context_resets: false, ai_title: true, subagent_count: false, branches: true,
      size_proxy: 'tool_calls',
    },
    watch: {
      matchLogFile: (rel) => {
        const n = rel.replace(/\\/g, '/');
        return n.endsWith('.jsonl') && !n.endsWith('.checkpoints.jsonl');
      },
      ctxFromPath(relPath) {
        const parts = relPath.replace(/\\/g, '/').split('/');
        if (parts.length < 2) return null;
        const project_id = parts[0];
        const session_id = parts[1].replace(/\.jsonl$/, '');
        return {
          harness: 'command-code', session_id,
          slug: session_id.slice(0, 8), project_id,
          project_label: deriveCCProjectLabel(project_id),
        };
      },
      // Incremental --session only works for claude-code in analyze.mjs.
      // Return null so CC file changes trigger full --all-harnesses rebuild.
      rebuildArg: () => null,
    },
  },
];

export function getHarness(id) {
  return HARNESS_REGISTRY.find(h => h.id === id) ?? null;
}

/**
 * Dynamically import the scanner function declared by a descriptor's `scan`
 * entry (module path relative to this file — declarative strings keep the
 * registry free of static analyzer imports and import cycles).
 * @param {string} id
 * @returns {Promise<Function|null>}
 */
export async function loadScanner(id) {
  const h = getHarness(id);
  if (!h?.scan) return null;
  const mod = await import(h.scan.module);
  return mod[h.scan.export] ?? null;
}

export function getEnabledHarnesses(harnessIds = HARNESS_IDS) {
  return HARNESS_REGISTRY.filter(h => harnessIds.includes(h.id));
}
