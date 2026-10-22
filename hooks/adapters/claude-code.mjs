/**
 * adapters/claude-code.mjs
 *
 * Converts Claude Code JSONL records → NormalizedRecord[].
 */

import { extractTextFromContent, extractSkills, categorizeBash } from '../helpers/analyze-helpers.mjs';
import { finalTurnSignal, inputToolSignal } from '../helpers/turn-signals.mjs';

const HARNESS = 'claude-code';

const KNOWN_TYPES = new Set([
  'permission-mode', 'system', 'ai-title', 'user', 'assistant',
  'mode', 'attachment', 'last-prompt', 'file-history-snapshot',
]);

function stripFirstUserMessage(text) {
  return text
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ').trim();
}

/**
 * @param {object[]} records — raw CC JSONL records
 * @returns {object[]} NormalizedRecord[]
 */
export function recordsToNormalized(records) {
  const out = [];
  let firstUserSeen = false;
  let lastBranch    = null;

  for (const rec of records) {
    const ts = rec.timestamp ?? null;
    let handled = false;

    if (rec.type === 'permission-mode') {
      handled = true;
      out.push({ kind: 'permission_mode', harness: HARNESS, ts, mode: rec.permissionMode });
    }

    if (rec.type === 'system' && rec.subtype === 'compact_boundary') {
      handled = true;
      out.push({ kind: 'context_reset', harness: HARNESS, ts });
    }

    if (rec.type === 'mode') {
      handled = true;
      out.push({ kind: 'mode_shift', harness: HARNESS, ts, mode: rec.mode || null });
    }

    if (rec.type === 'attachment') {
      handled = true;
      const subtype = rec.attachment?.type || null;
      out.push({
        kind: 'attachment', harness: HARNESS, ts,
        subtype,
      });
      // W-OBS-01: invoked_skills is the reliable skill source (exact ts + names).
      // command-name scanning on user turns remains as fallback for older sessions.
      if (subtype === 'invoked_skills') {
        for (const s of rec.attachment?.skills || []) {
          const name = typeof s === 'string' ? s : s?.name;
          if (name) out.push({ kind: 'skill_invoke', harness: HARNESS, ts, skill: name });
        }
      }
    }

    if (rec.type === 'last-prompt') {
      handled = true;
      out.push({ kind: 'session_meta', harness: HARNESS, ts, last_prompt: rec.lastPrompt || null });
    }

    if (rec.type === 'file-history-snapshot') {
      handled = true;
      out.push({ kind: 'session_meta', harness: HARNESS, ts });
    }

    if (rec.type === 'ai-title') {
      handled = true;
      out.push({
        kind: 'session_meta', harness: HARNESS, ts,
        ai_title: rec.aiTitle || rec.title || null,
      });
    }

    if (rec.type === 'system' && rec.subtype === 'turn_duration') {
      handled = true;
      out.push({
        kind: 'session_meta', harness: HARNESS, ts,
        slug:         rec.slug,
        duration_ms:  rec.durationMs,
        message_count: rec.messageCount,
        version:      rec.version,
        entrypoint:   rec.entrypoint,
        cwd:          rec.cwd,
        branch:       rec.gitBranch,
      });
      if (rec.gitBranch && rec.gitBranch !== lastBranch) {
        lastBranch = rec.gitBranch;
        out.push({ kind: 'branch_change', harness: HARNESS, ts, branch: rec.gitBranch });
      }
    }

    if (rec.type === 'user' && rec.message) {
      handled = true;
      const text = extractTextFromContent(rec.message.content);
      let userText = null;
      if (!firstUserSeen) {
        const stripped = stripFirstUserMessage(text);
        if (stripped.length >= 8
            && !stripped.startsWith('Base directory for this skill')
            && !stripped.startsWith('Caveat:')) {
          userText = stripped;
          firstUserSeen = true;
        }
      }

      // display_text: per-turn human text for trace/thread views (text keeps
      // first-user-message-only semantics for the session bundle).
      // extractTextFromContent only pulls type:text blocks, so tool-result-only
      // rows stay null; hybrid rows (human text + tool_result) keep the prose.
      const displayText = text ? text.trim().slice(0, 500) || null : null;

      out.push({
        kind: 'user_turn', harness: HARNESS, ts, text: userText,
        display_text: displayText,
        version: rec.version, entrypoint: rec.entrypoint,
        cwd: rec.cwd, branch: rec.gitBranch,
      });

      if (rec.gitBranch && rec.gitBranch !== lastBranch) {
        lastBranch = rec.gitBranch;
        out.push({ kind: 'branch_change', harness: HARNESS, ts, branch: rec.gitBranch });
      }

      for (const s of extractSkills(text)) {
        out.push({ kind: 'skill_invoke', harness: HARNESS, ts, skill: s });
      }

      if (Array.isArray(rec.message.content)) {
        for (const block of rec.message.content) {
          if (block.type !== 'tool_result') continue;
          const nr = {
            kind: 'tool_result', harness: HARNESS, ts,
            error: !!block.is_error,
            tool: block.tool_name || 'unknown',
            tool_id: block.tool_use_id || undefined,
          };
          if (block.is_error) {
            const raw = Array.isArray(block.content)
              ? block.content.map(b => b.text || '').join(' ')
              : String(block.content || '');
            nr.error_text = raw.trim().slice(0, 300) || undefined;
          }
          out.push(nr);
        }
      }
    }

    if (rec.type === 'assistant' && rec.message) {
      handled = true;
      const msg = rec.message;
      out.push({
        kind: 'assistant_turn', harness: HARNESS, ts,
        model: msg.model, stop_reason: msg.stop_reason,
      });

      if (msg.usage !== undefined) {
        const u = msg.usage || {};
        out.push({
          kind: 'tokens', harness: HARNESS, ts,
          tokens: {
            input:        u.input_tokens                || 0,
            output:       u.output_tokens               || 0,
            cache_create: u.cache_creation_input_tokens || 0,
            cache_read:   u.cache_read_input_tokens     || 0,
          },
        });
      }

      for (const block of (msg.content || [])) {
        const bt = block.type || 'unknown';
        const cbNR = { kind: 'content_block', harness: HARNESS, ts, block_type: bt };
        if (bt === 'text') cbNR.text = block.text;
        out.push(cbNR);
        if (bt === 'tool_use') {
          const name = block.name || 'unknown';
          const signal = inputToolSignal(name, block.id, HARNESS, ts);
          if (signal) out.push(signal);
          const isBash = ['bash', 'powershell', 'shell', 'run_command'].includes(name.toLowerCase());
          const category = isBash ? categorizeBash(block.input?.command) : null;
          out.push({
            kind: 'tool_use', harness: HARNESS, ts,
            tool: name, category,
            tool_id: block.id || undefined,
            input: block.input || {},
          });
        }
      }
    }

    if (rec.type === 'assistant' && rec.message?.stop_reason === 'end_turn') {
      const text = extractTextFromContent(rec.message.content);
      out.push(finalTurnSignal(text, HARNESS, ts, rec.message.id || rec.uuid));
    }

    if (!handled) {
      out.push({ kind: 'unknown_record', harness: HARNESS, ts, raw_type: rec.type });
    }
  }

  return out;
}
