/**
 * adapters/opencode.mjs
 *
 * Converts opencode storage records → NormalizedRecord[].
 *
 * opencode (~/.local/share/opencode/storage) splits a session across three
 * JSON trees: session info (ses_*.json), messages (msg_*.json), and message
 * parts (prt_*.json). analyze-opencode.mjs assembles them into a record list
 * [info, ...messages] with each message carrying its parts as `_parts`.
 * The live watch path feeds individual files, so bare part objects are also
 * accepted (their message context is unknown — they map standalone).
 *
 * Token accounting: the assistant message envelope carries the authoritative
 * totals. step-finish parts repeat the same numbers per LLM step and are
 * silenced to avoid double counting (as are step-start and patch, which
 * duplicate tool_use file information).
 *
 * Tool parts emit only on terminal status (completed/error) — opencode
 * rewrites the part file across pending→running→completed, and a single
 * emission keeps live pulse counts equal to post-hoc analysis counts.
 */

import { categorizeBash } from '../helpers/analyze-helpers.mjs';

const HARNESS = 'opencode';

function toIso(ms) {
  return typeof ms === 'number' ? new Date(ms).toISOString() : null;
}

function isSessionInfo(rec) {
  return typeof rec.id === 'string' && rec.id.startsWith('ses_') && !rec.role && !rec.type;
}

function firstText(parts = []) {
  const p = parts.find(x => x?.type === 'text' && x.text);
  return p ? p.text : null;
}

function partToNormalized(p) {
  switch (p.type) {
    case 'text':
      return [{
        kind: 'content_block', harness: HARNESS, ts: toIso(p.time?.start),
        block_type: 'text', text: p.text || '',
      }];

    case 'reasoning':
      return [{
        kind: 'content_block', harness: HARNESS, ts: toIso(p.time?.start),
        block_type: 'thinking', text: p.text || '',
      }];

    case 'tool': {
      const status = p.state?.status;
      if (status !== 'completed' && status !== 'error') return [];
      const input  = p.state?.input || {};
      const isBash = p.tool === 'bash';
      const ts     = toIso(p.state?.time?.start);
      const out = [{
        kind: 'tool_use', harness: HARNESS, ts,
        tool: p.tool || 'unknown',
        category: isBash ? categorizeBash(input.command) : null,
        input: {
          file_path:   input.filePath ?? input.path,
          command:     input.command,
          description: p.state?.title,
        },
      }];
      if (status === 'error') {
        out.push({
          kind: 'tool_result', harness: HARNESS, ts: toIso(p.state?.time?.end) ?? ts,
          error: true, tool: p.tool || 'unknown',
        });
      }
      return out;
    }

    case 'step-start':
    case 'step-finish':
    case 'patch':
      return []; // structural / duplicated info — see header

    default:
      return [{ kind: 'unknown_record', harness: HARNESS, ts: null, raw_type: `part:${p.type}` }];
  }
}

/**
 * @param {object[]} records — assembled [info, ...messages-with-_parts] or bare parts
 * @returns {object[]} NormalizedRecord[]
 */
export function recordsToNormalized(records) {
  const out = [];

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;

    if (isSessionInfo(rec)) {
      out.push({
        kind: 'session_meta', harness: HARNESS, ts: toIso(rec.time?.created),
        ai_title: rec.title || null,
        cwd: rec.directory || null,
        version: rec.version || undefined,
      });
      continue;
    }

    if (rec.role === 'user') {
      out.push({
        kind: 'user_turn', harness: HARNESS, ts: toIso(rec.time?.created),
        text: firstText(rec._parts),
        cwd: rec.path?.cwd || null,
      });
      // user text lives in the turn — parts are not re-emitted (no double words)
      continue;
    }

    if (rec.role === 'assistant') {
      out.push({
        kind: 'assistant_turn', harness: HARNESS, ts: toIso(rec.time?.created),
        model: rec.modelID || null,
        stop_reason: rec.finish || null,
      });
      if (rec.tokens) {
        out.push({
          kind: 'tokens', harness: HARNESS,
          ts: toIso(rec.time?.completed ?? rec.time?.created),
          tokens: {
            input:        rec.tokens.input         || 0,
            output:       rec.tokens.output        || 0,
            cache_create: rec.tokens.cache?.write  || 0,
            cache_read:   rec.tokens.cache?.read   || 0,
          },
        });
      }
      for (const p of rec._parts || []) out.push(...partToNormalized(p));
      continue;
    }

    if (rec.type) { // bare part (live watch path)
      out.push(...partToNormalized(rec));
      continue;
    }

    out.push({ kind: 'unknown_record', harness: HARNESS, ts: null, raw_type: 'opencode_unknown' });
  }

  return out;
}
