/**
 * hooks/helpers/opencode-helpers.mjs — live-pulse project-label resolution for opencode.
 *
 * opencode splits a session across session/message/part JSON trees (see
 * hooks/TRACE-opencode-sessions.md). Only the session info doc (ses_*.json)
 * carries `directory` — message docs carry `path.cwd`, but part docs (the
 * ones that emit audible tool_call pulses) carry neither. Resolve the
 * session's directory by locating its info doc, then cache the derived
 * label per session id for the life of the process — mirrors
 * copilotWorkspaceLabel's lazy-read-and-cache pattern in copilot-helpers.mjs.
 */
import fs from 'node:fs';
import { locateOpencodeSession } from '../session-locators.mjs';
import { deriveAntigravityLabel as deriveLabelFromPath } from './antigravity-helpers.mjs';

/**
 * Opencode version support markers and layout variants.
 * - V1_STORAGE_JSON (<= 1.0.x): JSON tree layout in storage/{session,message,part}/ (probed 1.0.201)
 * - V2_SQLITE_DB    (>= 1.18.x): SQLite database at opencode.db (probed 1.18.30)
 */
export const OPENCODE_VERSION_MARKERS = {
  V1_STORAGE_JSON: '1.0',
  V2_SQLITE_DB:    '1.18',
};

export const OPENCODE_SUPPORTED_VERSIONS = ['1.0.x', '1.18.x'];

export function detectOpencodeVersionMarker(versionStr) {
  if (!versionStr || typeof versionStr !== 'string') return null;
  if (versionStr.startsWith('1.0.') || versionStr === '1.0') return OPENCODE_VERSION_MARKERS.V1_STORAGE_JSON;
  if (versionStr.startsWith('1.18.') || versionStr === '1.18' || versionStr.startsWith('1.')) return OPENCODE_VERSION_MARKERS.V2_SQLITE_DB;
  return null;
}

const sessionLabelCache = new Map(); // `${storageRoot}::${sessionId}` → label|null

export function opencodeSessionLabel(sessionId, storageRoot) {
  if (!sessionId) return null;
  const key = `${storageRoot}::${sessionId}`;
  if (sessionLabelCache.has(key)) return sessionLabelCache.get(key);
  let label = null;
  try {
    const found = locateOpencodeSession(sessionId, storageRoot);
    if (found) {
      if (found.directory) {
        label = deriveLabelFromPath(found.directory);
      } else if (found.filePath && found.filePath.endsWith('.json')) {
        const info = JSON.parse(fs.readFileSync(found.filePath, 'utf8'));
        if (info.directory) label = deriveLabelFromPath(info.directory);
      }
    }
  } catch { /* unattributed session */ }
  sessionLabelCache.set(key, label);
  return label;
}

/** Test seam: reset the per-process session-label cache. */
export function clearOpencodeSessionLabelCache() {
  sessionLabelCache.clear();
}
