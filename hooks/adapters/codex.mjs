/**
 * hooks/adapters/codex.mjs
 *
 * Converts Codex desktop/CLI rollout JSONL records -> NormalizedRecord[].
 */

import { categorizeBash } from '../helpers/analyze-helpers.mjs';
import { isBashToolName } from '../action-keys.mjs';
import { finalTurnSignal, inputToolSignal } from '../helpers/turn-signals.mjs';

const HARNESS = 'codex';

function textFromContent(content, wantedTypes) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => wantedTypes.has(b.type))
    .map(b => b.text || '')
    .filter(Boolean)
    .join(' ');
}

function stripInfrastructure(text) {
  return text
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseArguments(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function commandFromArgs(args) {
  return typeof args.cmd === 'string' ? args.cmd
    : typeof args.command === 'string' ? args.command
    : null;
}

function hasFailureText(output = '') {
  const text = String(output);
  const match = text.match(/(?:Process exited with code|exitCode["']?:)\s*(-?\d+)/i);
  if (match) return Number(match[1]) !== 0;
  return /\b(error|failed|exception|traceback)\b/i.test(text);
}

// apply_patch's raw input is a diff-DSL string, not a structured object —
// e.g. "*** Begin Patch\n*** Update File: a.mjs\n@@\n...\n*** End Patch".
// Extract every touched path so file_ops can credit all of them.
function filesFromPatch(patchText) {
  const text = String(patchText || '');
  return [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => m[1].trim());
}

// custom_tool_call_output wraps its result in a JSON string with a
// metadata.exit_code — check that before falling back to text sniffing.
function patchOutputFailed(output) {
  const raw = String(output || '');
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.metadata?.exit_code === 'number') return parsed.metadata.exit_code !== 0;
  } catch { /* not JSON — fall through */ }
  return hasFailureText(raw);
}

function tokenUsage(payload = {}) {
  const usage = payload.info?.last_token_usage || null;
  if (!usage) return null;
  return {
    input:        0,
    output:       usage.output_tokens || 0,
    cache_create: 0,
    cache_read:   0,
  };
}

/**
 * @param {object[]} records - raw Codex rollout records
 * @returns {object[]} NormalizedRecord[]
 */
export function recordsToNormalized(records) {
  const out = [];
  const toolByCallId = new Map();
  let lastBranch = null;

  for (const rec of records) {
    const ts = rec.timestamp ?? null;
    const payload = rec.payload || {};

    if (rec.type === 'session_meta') {
      const branch = payload.git?.branch || null;
      out.push({
        kind: 'session_meta', harness: HARNESS, ts,
        slug: (payload.id || payload.session_id || '').slice(0, 8) || undefined,
        version: payload.cli_version || undefined,
        entrypoint: payload.originator || payload.source || undefined,
        cwd: payload.cwd || undefined,
        branch: branch || undefined,
        model: payload.model || undefined,
      });
      if (branch && branch !== lastBranch) {
        lastBranch = branch;
        out.push({ kind: 'branch_change', harness: HARNESS, ts, branch });
      }
      continue;
    }

    if (rec.type === 'turn_context') {
      const branch = payload.git?.branch || null;
      out.push({
        kind: 'session_meta', harness: HARNESS, ts,
        cwd: payload.cwd || undefined,
        model: payload.model || undefined,
        branch: branch || undefined,
      });
      continue;
    }

    if (rec.type === 'event_msg') {
      if (payload.type === 'task_complete') {
        out.push(finalTurnSignal(payload.last_agent_message, HARNESS, ts, payload.turn_id || payload.root_turn_id));
      }
      if (payload.type === 'token_count') {
        const tokens = tokenUsage(payload);
        if (tokens) out.push({ kind: 'tokens', harness: HARNESS, ts, tokens });
      }
      // agent_message/user_message under event_msg duplicate response_item's
      // message (role assistant/user) — verified byte-identical text, ~1ms
      // apart, in live rollouts. response_item is the sole source of turn
      // content; emitting both here would double every content_block:text.
      continue;
    }

    if (rec.type !== 'response_item') continue;

    if (payload.type === 'message') {
      if (payload.role === 'user') {
        const text = textFromContent(payload.content, new Set(['input_text']));
        const cleaned = stripInfrastructure(text);
        if (!cleaned) continue;
        out.push({
          kind: 'user_turn', harness: HARNESS, ts,
          text: cleaned.length >= 8 ? cleaned : null,
          display_text: cleaned.slice(0, 500),
        });
      } else if (payload.role === 'assistant') {
        const text = textFromContent(payload.content, new Set(['output_text']));
        out.push({
          kind: 'assistant_turn', harness: HARNESS, ts,
          model: payload.model || null,
          stop_reason: payload.status || null,
          content_length: text.length,
        });
        if (text) {
          out.push({
            kind: 'content_block', harness: HARNESS, ts,
            block_type: 'text', text,
          });
        }
      }
      continue;
    }

    if (payload.type === 'reasoning') {
      out.push({ kind: 'content_block', harness: HARNESS, ts, block_type: 'thinking' });
      continue;
    }

    if (payload.type === 'function_call') {
      const signal = inputToolSignal(payload.name || '', payload.call_id, HARNESS, ts);
      if (signal) out.push(signal);
      const args = parseArguments(payload.arguments);
      const command = commandFromArgs(args);
      const input = { ...args };
      if (command && !input.command) input.command = command;
      if (args.workdir && !input.path) input.path = args.workdir;
      const tool = payload.name || 'unknown';
      if (payload.call_id) toolByCallId.set(payload.call_id, tool);
      const isShell = isBashToolName(tool);
      out.push({
        kind: 'tool_use', harness: HARNESS, ts,
        tool,
        category: isShell ? categorizeBash(command) : null,
        tool_id: payload.call_id || undefined,
        input,
      });
      continue;
    }

    if (payload.type === 'function_call_output') {
      const tool = toolByCallId.get(payload.call_id) || 'unknown';
      const error = hasFailureText(payload.output);
      const nr = {
        kind: 'tool_result', harness: HARNESS, ts,
        tool,
        tool_id: payload.call_id || undefined,
        error,
      };
      if (error) nr.error_text = String(payload.output || '').trim().slice(0, 300) || undefined;
      out.push(nr);
      continue;
    }

    // File edits never go through function_call — they're a separate
    // custom_tool_call/custom_tool_call_output pair (verified against live
    // rollouts). apply_patch is the only known name so far.
    if (payload.type === 'custom_tool_call') {
      const signal = inputToolSignal(payload.name || '', payload.call_id, HARNESS, ts);
      if (signal) out.push(signal);
      const tool = payload.name || 'unknown';
      if (payload.call_id) toolByCallId.set(payload.call_id, tool);
      out.push({
        kind: 'tool_use', harness: HARNESS, ts,
        tool,
        category: null,
        tool_id: payload.call_id || undefined,
        input: { paths: filesFromPatch(payload.input) },
      });
      continue;
    }

    if (payload.type === 'custom_tool_call_output') {
      const tool = toolByCallId.get(payload.call_id) || 'unknown';
      const error = patchOutputFailed(payload.output);
      const nr = {
        kind: 'tool_result', harness: HARNESS, ts,
        tool,
        tool_id: payload.call_id || undefined,
        error,
      };
      if (error) nr.error_text = String(payload.output || '').trim().slice(0, 300) || undefined;
      out.push(nr);
    }
  }

  return out;
}
