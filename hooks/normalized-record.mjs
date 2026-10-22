/**
 * hooks/normalized-record.mjs — THE NormalizedRecord contract.
 *
 * NormalizedRecords are the "harness hop": the small common vocabulary every
 * adapter (hooks/adapters/*.mjs) emits and every downstream consumer
 * (session-reducer, pulse-transformer, trace reconstruction) reads. They are
 * internal — never persisted in sessions-data.json.
 *
 * Every record carries:
 *   kind     — one of RECORD_KINDS
 *   harness  — origin harness id (string, required)
 *   ts       — ISO string | epoch number | null (optional)
 *
 * Per-kind fields are specified in KIND_FIELDS below. Field types:
 *   'string' 'number' 'boolean' 'object'  — required to match when present
 * A field listed under `required` must be present (null NOT allowed unless
 * the type ends with '?'); under `optional` it may be absent or null.
 *
 * test/adapters/nr-compliance.test.mjs holds every adapter to this contract.
 */

/**
 * Per-kind field specification. The `required`/`optional` maps double as
 * documentation of what each kind means and carries.
 */
export const KIND_FIELDS = {
  turn_complete: { required: {}, optional: { signal_id: 'string', reason: 'string' } },
  input_required: { required: {}, optional: { signal_id: 'string', reason: 'string' } },
  // A human prompt entering the session. text is the cleaned first-user-message
  // (adapters null it for subsequent turns); cwd/branch/version/entrypoint are
  // CC envelope extras.
  // display_text carries per-turn human text for trace/thread views; text is
  // the cleaned FIRST user message only (session bundle semantics).
  user_turn:       { required: {}, optional: { text: 'string', display_text: 'string', version: 'string', entrypoint: 'string', cwd: 'string', branch: 'string' } },

  // One assistant message envelope. content_length is the synthetic-token
  // proxy for harnesses with capabilities.tokens === false.
  assistant_turn:  { required: {}, optional: { model: 'string', stop_reason: 'string', content_length: 'number', text: 'string' } },

  // One tool invocation. category is the bash sub-category when tool is a
  // shell (git/npm/…); input carries the raw tool input (file_path, command…).
  tool_use:        { required: { tool: 'string' }, optional: { category: 'string', input: 'object', tool_id: 'string' } },

  // Outcome of a tool invocation. error=true marks failures (→ tool_error pulse).
  tool_result:     { required: {}, optional: { tool: 'string', error: 'boolean', tool_id: 'string', error_text: 'string' } },

  // Token usage for one assistant turn (all four counters required, numbers).
  tokens:          { required: { tokens: 'tokens' }, optional: {} },

  // A skill / slash-command invocation detected in a user turn.
  skill_invoke:    { required: { skill: 'string' }, optional: {} },

  // Context compaction boundary — segments the session's context tree.
  context_reset:   { required: {}, optional: {} },

  // Session-level metadata drops (any subset may appear on one record).
  session_meta:    { required: {}, optional: {
    ai_title: 'string', last_prompt: 'string', slug: 'string', duration_ms: 'number',
    message_count: 'number', version: 'string', entrypoint: 'string', cwd: 'string',
    branch: 'string', model: 'string', title: 'string', project_label: 'string',
  } },

  // Permission mode change (CC: plan / acceptEdits / bypassPermissions …).
  permission_mode: { required: {}, optional: { mode: 'string' } },

  // Git branch observed to change mid-session.
  branch_change:   { required: { branch: 'string' }, optional: {} },

  // One assistant content block (text / thinking / tool_use envelope).
  // text blocks <3 words become 'chirp' pulses, ≥3 'words'. chunk marks
  // streamed fragments that concatenate without separators (grok).
  content_block:   { required: { block_type: 'string' }, optional: { text: 'string', chunk: 'boolean' } },

  // Agent operating-mode shift (CC 'mode' records).
  mode_shift:      { required: {}, optional: { mode: 'string' } },

  // User-attached context (files, images) entering the conversation.
  attachment:      { required: {}, optional: { subtype: 'string' } },

  // System-injected scaffolding (Antigravity EPHEMERAL_MESSAGE etc.) —
  // the harness loading guardrails/reminders into the context window.
  scaffold:        { required: {}, optional: { content_preview: 'string' } },

  // Harness/API-level failure surfaced in the transcript: quota exceeded,
  // rate limit, auth errors. Distinct from tool_result.error (a tool failing).
  api_error:       { required: { message: 'string' }, optional: { code: 'string' } },

  // Catch-all: a raw record type the adapter does not recognise. Guarantees
  // no harness activity is silently dropped (renders as 'unknown' pulse).
  unknown_record:  { required: {}, optional: { raw_type: 'string' } },
};

export const RECORD_KINDS = Object.keys(KIND_FIELDS);

const KIND_SET = new Set(RECORD_KINDS);

function typeError(field, type, val) {
  return `${field}: expected ${type}, got ${val === null ? 'null' : typeof val}`;
}

function checkType(field, type, val, errors) {
  if (type === 'tokens') {
    if (!val || typeof val !== 'object') { errors.push(typeError(field, 'object', val)); return; }
    for (const k of ['input', 'output', 'cache_create', 'cache_read']) {
      if (typeof val[k] !== 'number') errors.push(typeError(`${field}.${k}`, 'number', val[k]));
    }
    return;
  }
  if (typeof val !== type) errors.push(typeError(field, type, val));
}

/**
 * Validate a single NormalizedRecord against the contract.
 * @param {unknown} rec
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateNormalizedRecord(rec) {
  const errors = [];
  if (!rec || typeof rec !== 'object') return { ok: false, errors: ['record: not an object'] };

  if (!KIND_SET.has(rec.kind)) errors.push(`kind: unknown '${rec.kind}'`);
  if (typeof rec.harness !== 'string') errors.push('harness: expected string');
  if (rec.ts !== undefined && rec.ts !== null
      && typeof rec.ts !== 'string' && typeof rec.ts !== 'number') {
    errors.push(typeError('ts', 'string|number|null', rec.ts));
  }

  const spec = KIND_FIELDS[rec.kind];
  if (spec) {
    for (const [field, type] of Object.entries(spec.required)) {
      if (rec[field] === undefined || rec[field] === null) errors.push(`${field}: required`);
      else checkType(field, type, rec[field], errors);
    }
    for (const [field, type] of Object.entries(spec.optional)) {
      if (rec[field] === undefined || rec[field] === null) continue;
      checkType(field, type, rec[field], errors);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Cheap shape check (kind + harness only). Use validateNormalizedRecord for
 * full contract enforcement.
 * @param {unknown} rec
 * @returns {boolean}
 */
export function isNormalizedRecord(rec) {
  return !!rec
    && typeof rec === 'object'
    && KIND_SET.has(rec.kind)
    && typeof rec.harness === 'string';
}
