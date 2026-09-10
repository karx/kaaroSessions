/**
 * hooks/session-locators.mjs
 *
 * Per-harness "find the log file for this session id" walkers, referenced by
 * the registry descriptors (locateSession). surface/session-resolver.mjs runs
 * the generic registry loop + cache on top of these.
 */

import fs   from 'fs';
import path from 'path';
import {
  CLAUDE_PROJECTS_ROOT, CODEX_HOME_ROOT, PI_SESSIONS_ROOT, ANTIGRAVITY_BRAIN_ROOT, GROK_SESSIONS_ROOT,
  OPENCODE_STORAGE_ROOT, COPILOT_WORKSPACE_STORAGE_ROOT, COMMANDCODE_PROJECTS_ROOT,
} from './harness-paths.mjs';

function sessionIdFromPiFilename(filename) {
  const base = filename.replace(/\.jsonl$/, '');
  return base.includes('_') ? base.slice(base.indexOf('_') + 1) : base;
}

// The graph, Mission Control, and the DAW builder all display/accept the
// 8-char `session_id.slice(0, 8)` slug rather than the full id. Every
// locator below falls back to a case-insensitive prefix match on that slug
// once an exact-id lookup misses, so pasting the slug shown in the UI
// resolves the same session everywhere (not just for Grok).
const SLUG_MIN_LEN = 8;

/**
 * Scan `dir` for a file `${id}${ext}` where `id` case-insensitively starts
 * with `needle`. Returns the first match, or null.
 * @param {string} dir
 * @param {string} needle
 * @param {string} ext
 * @returns {{ id: string, filePath: string }|null}
 */
function findByPrefix(dir, needle, ext) {
  if (needle.length < SLUG_MIN_LEN) return null;
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const lower = needle.toLowerCase();
  for (const name of names) {
    if (!name.endsWith(ext)) continue;
    const id = name.slice(0, -ext.length);
    if (id.toLowerCase().startsWith(lower)) return { id, filePath: path.join(dir, name) };
  }
  return null;
}

/**
 * @param {string} sessionId
 * @param {string} [root]
 * @returns {{ filePath: string, projectId: string, sessionId: string }|null}
 */
export function locateClaudeCodeSession(sessionId, root = CLAUDE_PROJECTS_ROOT) {
  if (!sessionId || !fs.existsSync(root)) return null;

  // Accept either bare agentId or `agent-<id>` form for sidechain lookup.
  const agentFile = sessionId.startsWith('agent-')
    ? `${sessionId}.jsonl`
    : `agent-${sessionId}.jsonl`;

  for (const proj of fs.readdirSync(root)) {
    const projPath = path.join(root, proj);
    try {
      if (!fs.statSync(projPath).isDirectory()) continue;
    } catch { continue; }

    const candidate = path.join(projPath, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      return { filePath: candidate, projectId: proj, sessionId };
    }

    // Current CC layout: <project>/<parentUuid>/subagents/agent-<agentId>.jsonl
    let entries;
    try { entries = fs.readdirSync(projPath); } catch { continue; }
    for (const entry of entries) {
      const nested = path.join(projPath, entry, 'subagents', agentFile);
      if (fs.existsSync(nested)) {
        return { filePath: nested, projectId: proj, sessionId };
      }
    }

    // Legacy layout (RFC-era): <project>/subagents/<id>.jsonl
    const subCandidate = path.join(projPath, 'subagents', `${sessionId}.jsonl`);
    if (fs.existsSync(subCandidate)) {
      return { filePath: subCandidate, projectId: proj, sessionId };
    }
  }

  // 8-char slug prefix (graph/Mission Control/DAW slug = session_id.slice(0, 8))
  for (const proj of fs.readdirSync(root)) {
    const projPath = path.join(root, proj);
    try {
      if (!fs.statSync(projPath).isDirectory()) continue;
    } catch { continue; }

    const found = findByPrefix(projPath, sessionId, '.jsonl')
      || findByPrefix(path.join(projPath, 'subagents'), sessionId, '.jsonl');
    if (found) return { filePath: found.filePath, projectId: proj, sessionId: found.id };
  }
  return null;
}

/**
 * @param {string} sessionId
 * @param {string} [root]
 * @returns {{ filePath: string, projectId: null, sessionId: string }|null}
 */
// Rollout filenames are `rollout-<timestamp>-<uuid>.jsonl` — the session id
// is a suffix, not a prefix of the filename, so the shared findByPrefix
// (prefix-of-filename) helper doesn't apply; match the trailing uuid instead.
const CODEX_ROLLOUT_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function locateCodexSession(sessionId, root = CODEX_HOME_ROOT) {
  if (!sessionId || !fs.existsSync(root)) return null;
  const sessionsRoot = path.join(root, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;

  const lower = sessionId.toLowerCase();
  let prefixMatch = null;

  const stack = [sessionsRoot];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(`${sessionId}.jsonl`)) {
        return { filePath: p, projectId: null, sessionId };
      }
      // 8-char slug prefix (graph/Mission Control/DAW slug = session_id.slice(0, 8))
      if (!prefixMatch && sessionId.length >= SLUG_MIN_LEN) {
        const m = entry.name.match(CODEX_ROLLOUT_ID_RE);
        if (m && m[1].toLowerCase().startsWith(lower)) {
          prefixMatch = { filePath: p, projectId: null, sessionId: m[1] };
        }
      }
    }
  }
  return prefixMatch;
}

/**
 * @param {string} sessionId
 * @param {string} [root]
 * @returns {{ filePath: string, projectId: string, sessionId: string }|null}
 */
export function locatePiSession(sessionId, root = PI_SESSIONS_ROOT) {
  if (!sessionId || !fs.existsSync(root)) return null;

  for (const proj of fs.readdirSync(root)) {
    const projPath = path.join(root, proj);
    try {
      if (!fs.statSync(projPath).isDirectory()) continue;
    } catch { continue; }

    for (const file of fs.readdirSync(projPath)) {
      if (!file.endsWith('.jsonl')) continue;
      if (sessionIdFromPiFilename(file) === sessionId) {
        return { filePath: path.join(projPath, file), projectId: proj, sessionId };
      }
    }
  }

  // 8-char slug prefix (graph/Mission Control/DAW slug = session_id.slice(0, 8))
  if (sessionId.length < SLUG_MIN_LEN) return null;
  const needle = sessionId.toLowerCase();
  for (const proj of fs.readdirSync(root)) {
    const projPath = path.join(root, proj);
    let files;
    try { files = fs.readdirSync(projPath); } catch { continue; }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const id = sessionIdFromPiFilename(file);
      if (id.toLowerCase().startsWith(needle)) {
        return { filePath: path.join(projPath, file), projectId: proj, sessionId: id };
      }
    }
  }
  return null;
}

/**
 * @param {string} sessionId — Antigravity conversation id
 * @param {string} [root]
 * @returns {{ filePath: string, projectId: null, sessionId: string }|null}
 */
export function locateAntigravitySession(sessionId, root = ANTIGRAVITY_BRAIN_ROOT) {
  if (!sessionId || !fs.existsSync(root)) return null;

  const sessionDir = path.join(root, sessionId, '.system_generated', 'logs');
  const transcript = path.join(sessionDir, 'transcript.jsonl');
  if (fs.existsSync(transcript)) {
    return { filePath: transcript, projectId: null, sessionId };
  }

  const overview = path.join(sessionDir, 'overview.txt');
  if (fs.existsSync(overview)) {
    return { filePath: overview, projectId: null, sessionId };
  }

  return null;
}

/**
 * @param {string} sessionId
 * @param {string} [root]
 * @returns {{ filePath: string, projectId: string, sessionId: string }|null}
 */
export function locateGrokSession(sessionId, root = GROK_SESSIONS_ROOT) {
  if (!sessionId || !fs.existsSync(root)) return null;

  for (const encodedCwd of fs.readdirSync(root)) {
    const updates = path.join(root, encodedCwd, sessionId, 'updates.jsonl');
    if (fs.existsSync(updates)) {
      return { filePath: updates, projectId: encodedCwd, sessionId };
    }
  }

  // 8-char slug prefix (graph / Mission Control slug, sim-audio.mjs)
  if (sessionId.length < 8) return null;
  const needle = sessionId.toLowerCase();
  for (const encodedCwd of fs.readdirSync(root)) {
    const projDir = path.join(root, encodedCwd);
    let names;
    try { names = fs.readdirSync(projDir); } catch { continue; }
    for (const sid of names) {
      if (!sid.toLowerCase().startsWith(needle)) continue;
      const updates = path.join(projDir, sid, 'updates.jsonl');
      if (fs.existsSync(updates)) {
        return { filePath: updates, projectId: encodedCwd, sessionId: sid };
      }
    }
  }
  return null;
}

/**
 * @param {string} sessionId — opencode info id (ses_…)
 * @param {string} [root] — opencode storage root
 * @returns {{ filePath: string, projectId: string|null, sessionId: string, directory?: string|null, format?: string }|null}
 */
export function locateOpencodeSession(sessionId, root = OPENCODE_STORAGE_ROOT) {
  if (!sessionId) return null;

  // 1. Check SQLite database (opencode >= 1.18.x)
  let dbPath = null;
  if (root.endsWith('.db') && fs.existsSync(root)) {
    dbPath = root;
  } else if (fs.existsSync(path.join(root, 'opencode.db'))) {
    dbPath = path.join(root, 'opencode.db');
  } else if (fs.existsSync(path.join(path.dirname(root), 'opencode.db'))) {
    dbPath = path.join(path.dirname(root), 'opencode.db');
  }

  const DatabaseSync = process.getBuiltinModule?.('node:sqlite')?.DatabaseSync;
  if (DatabaseSync && dbPath) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        let row = db.prepare('SELECT id, project_id, directory FROM session WHERE id = ?').get(sessionId);
        if (!row) {
          const search = sessionId.startsWith('ses_') ? `${sessionId}%` : `ses_${sessionId}%`;
          row = db.prepare('SELECT id, project_id, directory FROM session WHERE id LIKE ? ORDER BY time_updated DESC LIMIT 1').get(search);
        }
        if (row) {
          return {
            filePath: dbPath,
            projectId: row.project_id || null,
            sessionId: row.id,
            directory: row.directory || null,
            format: 'sqlite',
          };
        }
      } finally {
        db.close();
      }
    } catch {}
  }

  // 2. Check JSON trees (opencode <= 1.0.x)
  const sessionRoot = fs.existsSync(path.join(root, 'session'))
    ? path.join(root, 'session')
    : (fs.existsSync(path.join(root, 'storage', 'session')) ? path.join(root, 'storage', 'session') : null);
  if (!sessionRoot) return null;

  for (const bucket of fs.readdirSync(sessionRoot)) {
    const candidate = path.join(sessionRoot, bucket, `${sessionId}.json`);
    if (fs.existsSync(candidate)) {
      return { filePath: candidate, projectId: null, sessionId, format: 'json' };
    }
  }

  // 8-char slug prefix (graph/Mission Control/DAW slug = session_id.slice(0, 8))
  for (const bucket of fs.readdirSync(sessionRoot)) {
    const found = findByPrefix(path.join(sessionRoot, bucket), sessionId, '.json');
    if (found) return { filePath: found.filePath, projectId: null, sessionId: found.id, format: 'json' };
  }
  return null;
}

/**
 * @param {string} sessionId — copilot chat session id
 * @param {string} [root] — VS Code workspaceStorage root
 * @returns {{ filePath: string, projectId: null, sessionId: string }|null}
 */
export function locateCopilotSession(sessionId, root = COPILOT_WORKSPACE_STORAGE_ROOT) {
  if (!sessionId || !fs.existsSync(root)) return null;

  for (const ws of fs.readdirSync(root)) {
    const chatDir = path.join(root, ws, 'chatSessions');
    for (const ext of ['jsonl', 'json']) {
      const candidate = path.join(chatDir, `${sessionId}.${ext}`);
      if (fs.existsSync(candidate)) {
        return { filePath: candidate, projectId: null, sessionId };
      }
    }
  }

  // 8-char slug prefix (graph/Mission Control/DAW slug = session_id.slice(0, 8))
  for (const ws of fs.readdirSync(root)) {
    const chatDir = path.join(root, ws, 'chatSessions');
    for (const ext of ['.jsonl', '.json']) {
      const found = findByPrefix(chatDir, sessionId, ext);
      if (found) return { filePath: found.filePath, projectId: null, sessionId: found.id };
    }
  }
  return null;
}

/**
 * @param {string} sessionId
 * @param {string} [root]
 * @returns {{ filePath: string, projectId: string, sessionId: string }|null}
 */
export function locateCommandCodeSession(sessionId, root = COMMANDCODE_PROJECTS_ROOT) {
  if (!sessionId || !fs.existsSync(root)) return null;

  for (const proj of fs.readdirSync(root)) {
    const projPath = path.join(root, proj);
    try {
      if (!fs.statSync(projPath).isDirectory()) continue;
    } catch { continue; }

    const candidate = path.join(projPath, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      return { filePath: candidate, projectId: proj, sessionId };
    }
  }

  // 8-char slug prefix (graph/Mission Control/DAW slug = session_id.slice(0, 8))
  for (const proj of fs.readdirSync(root)) {
    const projPath = path.join(root, proj);
    try {
      if (!fs.statSync(projPath).isDirectory()) continue;
    } catch { continue; }

    const found = findByPrefix(projPath, sessionId, '.jsonl');
    if (found) return { filePath: found.filePath, projectId: proj, sessionId: found.id };
  }
  return null;
}
