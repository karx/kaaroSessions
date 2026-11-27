import { toolNameToKey, toolIntent } from './action-keys.mjs';
import { pulseDisposition } from './pulse-map.mjs';

/**
 * hooks/pulse-transformer.mjs — NormalizedRecord[] → SSE pulse objects
 *
 * Every NR emits ≥1 pulse. Disposition (sonic / silent / unknown) comes from
 * hooks/pulse-map.mjs. This file only builds payload.
 *
 * Key derivation (read/write/bash_git/…) is done HERE via toolNameToKey —
 * never in adapters. Adapters are sonic-unaware; they provide nr.tool + nr.category.
 *
 * unknown is a coverage hole (unknown_record, unclassified block_type, or a
 * string that is not a RECORD_KIND). Known NRs with no live sonic emit silent.
 *
 * @param {object[]} nrRecords     — NormalizedRecord[]
 * @param {object}   ctx           — { session_id, slug, project_label, harness }
 * @param {object}   capabilities  — harness capabilities (e.g. { tokens: false })
 * @returns {object[]} pulse objects { event, data }
 */
export function normRecordsToPulses(nrRecords, ctx, capabilities = {}) {
  const pulses = [];
  for (const nr of nrRecords) {
    const p = transformRecord(nr, ctx, capabilities);
    pulses.push(p);
  }
  return pulses;
}

function base(ctx, ts, nr) {
  return {
    session_id:    ctx.session_id,
    slug:          ctx.slug,
    harness:       ctx.harness,
    project:       ctx.project_label,
    ts,
    nr_kind:       nr.kind,
  };
}

function transformRecord(nr, ctx, capabilities) {
  const ts = nr.ts ?? null;
  const disp = pulseDisposition(nr, capabilities);
  const env = base(ctx, ts, nr);

  if (disp.event === 'silent') {
    const data = { ...env, reason: disp.reason };
    if (nr.block_type != null) data.block_type = nr.block_type;
    return { event: 'silent', data };
  }

  if (disp.event === 'unknown') {
    const data = { ...env };
    if (nr.raw_type != null) data.raw_type = nr.raw_type;
    if (nr.block_type != null) data.block_type = nr.block_type;
    return { event: 'unknown', data };
  }

  switch (disp.event) {
    case 'turn_complete':
    case 'input_required':
      return { event: disp.event, data: { ...env, signal_id: nr.signal_id, reason: nr.reason } };

    case 'tool_call': {
      const key   = toolNameToKey(nr.tool, nr.category);
      const where = nr.input?.file_path || nr.input?.path || null;
      const why   = nr.input?.command || nr.input?.description || null;
      return {
        event: 'tool_call',
        data: { ...env, tool: nr.tool, tool_id: nr.tool_id ?? null, key,
          intent: toolIntent(nr.tool, nr.input), where, why, category: key },
      };
    }

    case 'tokens': {
      if (disp.synthetic) {
        const contentLength = nr.content_length || 0;
        return {
          event: 'tokens',
          data: {
            ...env,
            synthetic: true,
            input: 0,
            output: Math.round(contentLength / 4),
            cache_create: 0,
            cache_read: 0,
          },
        };
      }
      const t = nr.tokens || {};
      return {
        event: 'tokens',
        data: {
          ...env,
          input:        t.input        || 0,
          output:       t.output       || 0,
          cache_create: t.cache_create || 0,
          cache_read:   t.cache_read   || 0,
        },
      };
    }

    case 'words': {
      const trimmed = nr.text.trim();
      const words   = trimmed ? trimmed.split(/\s+/) : [];
      return {
        event: 'words',
        data: { ...env, preview: trimmed.slice(0, 120), word_count: words.length },
      };
    }

    case 'chirp': {
      const trimmed = nr.text.trim();
      const words   = trimmed ? trimmed.split(/\s+/) : [];
      return {
        event: 'chirp',
        data: { ...env, preview: trimmed.slice(0, 120), word_count: words.length },
      };
    }

    case 'thinking': {
      return { event: 'thinking', data: { ...env, block_type: 'thinking' } };
    }

    case 'human_turn': {
      // origin (user_turn NR) says who produced the row; only the person
      // typing (human / command) is a prompt. Adapters without origin: an
      // explicitly null display_text marks a tool-result row, else human.
      const origin = nr.origin ?? (nr.display_text === null ? 'tool_result' : 'human');
      return {
        event: 'human_turn',
        data: { ...env, text: nr.text || null, origin,
          prompt: origin === 'human' || origin === 'command' },
      };
    }

    case 'compact': {
      return { event: 'compact', data: env };
    }

    case 'permission': {
      return { event: 'permission', data: { ...env, mode: nr.mode } };
    }

    case 'mode_shift': {
      return { event: 'mode_shift', data: { ...env, mode: nr.mode || null } };
    }

    case 'attachment': {
      return { event: 'attachment', data: { ...env, subtype: nr.subtype || null } };
    }

    case 'scaffold': {
      return {
        event: 'scaffold',
        data: { ...env, content_preview: nr.content_preview || null },
      };
    }

    case 'tool_result': {
      return { event: 'tool_result', data: { ...env, tool: nr.tool } };
    }

    case 'tool_error': {
      return { event: 'tool_error', data: { ...env, tool: nr.tool } };
    }

    case 'api_error': {
      return {
        event: 'api_error',
        data: { ...env, message: nr.message, code: nr.code ?? null },
      };
    }

    default: {
      return { event: 'unknown', data: env };
    }
  }
}
