/**
 * hooks/action-keys.mjs — canonical tool-action vocabulary.
 *
 * Maps raw harness tool names (+ bash category) onto the small canonical key
 * set carried on tool_call pulses (data.key). This is normalization-layer
 * vocabulary: adapters stay sonic-unaware, the pulse transformer derives keys
 * here, and the experience layer (Event Registry) attaches sonic defaults to
 * these same keys.
 *
 * Adding a harness with new tool names: extend the alias lists here only.
 */

export const TOOL_ACTION_KEYS = new Set([
  'read', 'write', 'edit', 'grep_glob', 'agent',
  'bash_git', 'bash_run', 'bash_other', 'web', 'other',
]);

const BASH_ALIASES = new Set([
  'bash', 'powershell', 'shell', 'run_command',
  'runinterminal', 'run_in_terminal',
  'run_terminal_command', // grok
  'shell_command',        // command-code, codex (real local CLI tool name)
  'exec_command',         // codex (older CLI versions)
]);

/** Case-insensitive: is this raw tool name a shell? Single list for keys + reducers. */
export function isBashToolName(name) {
  return BASH_ALIASES.has((name || '').toLowerCase().trim());
}

/**
 * Translate a raw harness tool name + optional bash category into a canonical
 * TOOL_ACTION_KEYS value. Case-insensitive. Returns 'other' for unknowns.
 *
 * @param {string|null} name     — raw tool name from the harness record
 * @param {string|null} category — bash category (git|npm|node|python|other)
 */
export function toolNameToKey(name, category = null) {
  const t = (name || '').toLowerCase().trim();
  if (['read', 'view_file', 'read_file', 'readfile'].includes(t))           return 'read';
  if (['write', 'write_to_file', 'createfile', 'create_file'].includes(t))   return 'write';
  if (['edit', 'replace_file_content', 'search_replace',
       'strreplace', 'editnotebook', 'editfile', 'replacestring',
       'applypatch', 'insert_edit_into_file',
       'replace_string_in_file', 'apply_patch',
       'multi_replace_file_content'].includes(t))                             return 'edit';
  if (['grep', 'glob', 'grep_search', 'list_dir', 'findtextinfiles',
       'filesearch', 'listdirectory', 'codebase', 'file_search',
       'semantic_search', 'findfiles', 'searchcodebase'].includes(t))         return 'grep_glob';
  if (['agent', 'task', 'spawn_subagent'].includes(t))                        return 'agent';
  if (isBashToolName(t)) {
    if (category === 'git')                                                   return 'bash_git';
    if (['npm', 'npx', 'node', 'python'].includes(category))                 return 'bash_run';
    return 'bash_other';
  }
  if (['web_fetch', 'webfetch', 'web_search', 'websearch',
       'web search:', 'fetchwebpage'].includes(t))                            return 'web';
  return 'other';
}

// ── Intent (RFC-session-triggers §5.1) ───────────────────────────────────────
// Phase vocabulary that sits BESIDE the Canonical Action Key: does an action
// mutate, verify, or only read? Keys stay sonic vocabulary and are unchanged;
// bash_git / bash_run / bash_other each mix all three intents.

export const SHELL_INTENTS = new Set(['mutate', 'verify', 'read']);

const MUTATE_RES = [
  /^git\s+(commit|push|add|merge|rebase|reset|stash|cherry-pick|tag|rm|mv|apply|am|revert|pull|checkout\s+-b|switch\s+-c|branch\s+-[dDmM])\b/,
  /^(sed\s+-i|mv|rm|rmdir|mkdir|cp|touch|chmod|chown|ln|tee|patch|unzip|tar\s+-?x)\b/,
  /^(npm|pnpm|yarn|bun)\s+(install|i|add|remove|rm|uninstall|ci|update|up)\b/,
  /^pip3?\s+(install|uninstall)\b/,
  /^(new-item|remove-item|set-content|add-content|out-file|move-item|copy-item|rename-item)\b/i,
];

const VERIFY_RES = [
  /^(npm|pnpm|yarn|bun)\s+(test|t)\b/,
  /^(npm|pnpm|yarn|bun)\s+run\s+(test|build|lint|check|typecheck)\S*/,
  /^node\s+--test\b/,
  /^(pytest|jest|vitest|tsc|mocha|ctest|phpunit|rspec)\b/,
  /^python3?\s+-m\s+(pytest|unittest)\b/,
  /^(cargo|go)\s+(test|build|check|vet)\b/,
  /^make(\s+(test|check|build))?\s*$/,
  /^npx\s+(tsc|jest|vitest|playwright|mocha|eslint)\b/,
];

// `> file` / `>> file`, but not `2>…`, `>&…`, or `> /dev/null` / `$null`.
const WRITE_REDIRECT = /(^|[^0-9&>])>{1,2}\s*(?!&|\/dev\/null\b|\$null\b|nul\b)\S/i;

const RANK = { read: 0, verify: 1, mutate: 2 };

function segmentIntent(seg) {
  const c = seg.trim();
  if (!c) return null;
  if (MUTATE_RES.some(re => re.test(c)) || WRITE_REDIRECT.test(c)) return 'mutate';
  if (VERIFY_RES.some(re => re.test(c))) return 'verify';
  return 'read';
}

/**
 * Intent of one shell command. Chains (`&&`, `;`, `|`, `||`) take the
 * strongest segment (mutate > verify > read). Missing text → null — never
 * guessed as read, so undercounting stays visible.
 * @param {string|string[]|null} command
 * @returns {'mutate'|'verify'|'read'|null}
 */
export function shellIntent(command) {
  const cmd = Array.isArray(command) ? command.join(' ') : command;
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  let best = null;
  for (const seg of cmd.split(/&&|\|\||;|\|/)) {
    const i = segmentIntent(seg);
    if (i && (best === null || RANK[i] > RANK[best])) best = i;
  }
  return best ?? 'read';
}

/**
 * Intent of one tool invocation: write/edit mutate, shells delegate to
 * shellIntent(input.command | input.cmd), everything else reads.
 * @param {string|null} name  — raw harness tool name
 * @param {object|null} input — raw tool input
 */
export function toolIntent(name, input) {
  if (isBashToolName(name)) return shellIntent(input?.command ?? input?.cmd ?? null);
  const key = toolNameToKey(name);
  if (key === 'write' || key === 'edit') return 'mutate';
  return 'read';
}
