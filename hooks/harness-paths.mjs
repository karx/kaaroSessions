/**
 * lib/harness-paths.mjs — session root directories per harness (no adapter imports).
 */

import path from 'path';
import os   from 'os';

export const CLAUDE_PROJECTS_ROOT  = path.join(os.homedir(), '.claude', 'projects');
export const CODEX_HOME_ROOT       = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const PI_SESSIONS_ROOT      = path.join(os.homedir(), '.pi', 'agent', 'sessions');
export const ANTIGRAVITY_BRAIN_ROOT = path.join(
  os.homedir(), '.gemini', 'antigravity', 'brain'
);
export const GROK_SESSIONS_ROOT = path.join(os.homedir(), '.grok', 'sessions');
export const OPENCODE_ROOT = path.join(
  os.homedir(), '.local', 'share', 'opencode'
);
export const OPENCODE_STORAGE_ROOT = path.join(
  OPENCODE_ROOT, 'storage'
);
export const OPENCODE_DB_PATH = path.join(
  OPENCODE_ROOT, 'opencode.db'
);

// VS Code user-data dir is platform-specific; Copilot chat sessions live in
// workspaceStorage/<hash>/chatSessions inside it.
function vscodeUserDir() {
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User');
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
  return path.join(os.homedir(), '.config', 'Code', 'User');
}
export const COPILOT_WORKSPACE_STORAGE_ROOT = path.join(vscodeUserDir(), 'workspaceStorage');
export const COMMANDCODE_PROJECTS_ROOT = path.join(os.homedir(), '.commandcode', 'projects');
