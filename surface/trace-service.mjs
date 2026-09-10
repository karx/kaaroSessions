/**
 * surface/trace-service.mjs — /api/trace production path.
 *
 * registry readSessionRecords (harness-specific transcript reading) →
 * registry adapter → reconstructTraceFromNRs, with an mtime cache per file.
 * Fully harness-agnostic: trace support for a new harness is just its
 * descriptor's readSessionRecords + capabilities.trace = true.
 *
 * When capabilities.subagent_tree is true (claude-code), discovers
 * <parent>/subagents/agent-* artifacts, links via meta.toolUseId, and
 * nests child ContextTrees up to maxSubagentDepth (default 2).
 */
import fs from 'fs';
import path from 'path';

import { getHarness } from '../hooks/registry.mjs';
import { reconstructTraceFromNRs, childTreeKey } from '../hooks/trace-tree.mjs';
import {
  subagentScanDirFromLog,
  agentIdFromSidechainLog,
  listSubagentArtifacts,
  linkSpawns,
} from '../hooks/helpers/subagent-discover.mjs';

const DEFAULT_MAX_SUBAGENT_DEPTH = 2;

export function createTraceService() {
  const cache = new Map(); // filePath → { fingerprint, tree }

  /**
   * @param {string} filePath — resolved session log file
   * @param {string|null} projectId
   * @param {string} sessionId
   * @param {string} harnessId
   * @param {{ maxSubagentDepth?: number }} [opts]
   * @returns {object|null} tree ({ session_id, project_id, ai_title, segments, subagents? }) or null
   */
  function buildTrace(filePath, projectId, sessionId, harnessId, opts = {}) {
    try {
      const harness = getHarness(harnessId);
      if (!harness?.readSessionRecords) return null;

      const maxDepth = opts.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
      const visited = opts._visited || new Set();
      const depth = opts._depth || 0;

      const abs = path.resolve(filePath);
      if (visited.has(abs)) return null;
      visited.add(abs);

      const watchPaths = [filePath];
      // Flat CC layout: all agents under <parent>/subagents/ (siblings at any spawnDepth).
      let artifacts = [];
      const selfAgentId = agentIdFromSidechainLog(filePath);
      if (harness.capabilities?.subagent_tree) {
        artifacts = listSubagentArtifacts(subagentScanDirFromLog(filePath));
        // Sidechain: do not treat self as a spawn candidate.
        if (selfAgentId) {
          artifacts = artifacts.filter(a => a.agent_id !== selfAgentId);
        }
        for (const a of artifacts) {
          if (a.jsonl_path) watchPaths.push(a.jsonl_path);
          if (a.meta_path) watchPaths.push(a.meta_path);
        }
      }
      const fingerprint = _fingerprint(watchPaths);

      // Only use top-level cache for depth-0 parent builds
      if (depth === 0) {
        const cached = cache.get(filePath);
        if (cached && cached.fingerprint === fingerprint) return cached.tree;
      }

      const { records, traceOpts = {} } = harness.readSessionRecords(filePath, sessionId);
      const nrs = harness.adapter(records);

      let reconOpts = { ...traceOpts };

      if (harness.capabilities?.subagent_tree) {
        const agentToolUses = nrs
          .filter(nr => nr.kind === 'tool_use' && (nr.tool === 'Agent' || nr.tool === 'Task'))
          .map(nr => ({
            tool_id: nr.tool_id || null,
            description: nr.input?.description || nr.input?.prompt || null,
          }));
        let spawns = linkSpawns(agentToolUses, artifacts);
        // On a sidechain, only linked spawns (not every sibling as orphan).
        if (selfAgentId) {
          spawns = spawns.filter(s => s.linked && s.agent_id);
        }
        const childTrees = {};

        // Load nested child trees only while remaining depth budget allows.
        if (depth < maxDepth) {
          for (const s of spawns) {
            if (!s.jsonl_path || !fs.existsSync(s.jsonl_path)) continue;
            if (visited.has(path.resolve(s.jsonl_path))) continue;
            const child = buildTrace(
              s.jsonl_path,
              projectId,
              s.agent_id || sessionId,
              harnessId,
              {
                maxSubagentDepth: maxDepth,
                _depth: depth + 1,
                _visited: visited,
              },
            );
            const key = childTreeKey(s);
            if (child && key) {
              childTrees[key] = {
                ai_title: child.ai_title,
                segments: child.segments,
                ...(child.subagents ? { subagents: child.subagents } : {}),
              };
            }
          }
        }

        reconOpts = {
          ...reconOpts,
          spawns,
          childTrees: Object.keys(childTrees).length ? childTrees : undefined,
        };
      }

      const tree = {
        session_id: sessionId,
        project_id: projectId,
        ...reconstructTraceFromNRs(nrs, reconOpts),
      };

      if (depth === 0) cache.set(filePath, { fingerprint, tree });
      return tree;
    } catch {
      return null;
    }
  }

  return { buildTrace };
}

function _fingerprint(paths) {
  return paths.map(p => {
    try {
      return `${p}:${fs.statSync(p).mtimeMs}`;
    } catch {
      return `${p}:0`;
    }
  }).join('|');
}
