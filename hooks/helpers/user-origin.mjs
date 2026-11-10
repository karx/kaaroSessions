/**
 * hooks/helpers/user-origin.mjs — who produced a Claude Code `user` row.
 *
 * CC routes harness-injected content through `user` messages (tool results,
 * skill bodies, subagent prompts, notifications, interrupts, compact
 * summaries). Classifying here keeps those specifics in hooks/; downstream
 * reads the harness-neutral NR field `user_turn.origin` (USER_ORIGINS).
 *
 * Precedence: structural flags first (isSidechain, isCompactSummary), then
 * content shape (all tool_result), then stable text markers.
 */

import { extractTextFromContent } from './analyze-helpers.mjs';

const INTERRUPT = /^\[Request interrupted by user/;
const NOTIFICATION = /^<task-notification>/;
const META_TEXT = /^(<local-command-stdout>|<local-command-stderr>|<local-command-caveat>|<bash-stdout>|<bash-stderr>|<system-reminder>|Caveat:|Base directory for this skill)/;
// Typed by the human: slash commands and `!` shell input.
const COMMAND = /<command-name>|^<bash-input>/;

/**
 * @param {object} rec — raw CC JSONL record of type 'user'
 * @returns {'human'|'command'|'tool_result'|'interrupt'|'meta'|'notification'|'compact_summary'|'sidechain'}
 */
export function classifyClaudeUserOrigin(rec) {
  if (rec?.isSidechain) return 'sidechain';
  if (rec?.isCompactSummary) return 'compact_summary';

  const content = rec?.message?.content;
  const text = extractTextFromContent(content ?? '').trim();
  if (!text && Array.isArray(content) && content.length
      && content.every(b => b?.type === 'tool_result')) return 'tool_result';

  if (INTERRUPT.test(text)) return 'interrupt';
  if (NOTIFICATION.test(text)) return 'notification';
  // isMeta before command: skill bodies echo <command-name> but aren't typed.
  if (rec?.isMeta || META_TEXT.test(text)) return 'meta';
  if (COMMAND.test(text)) return 'command';
  return 'human';
}
