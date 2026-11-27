/**
 * hooks/kind-map.mjs — pure Kind Map payload + live overlay.
 *
 * Traces in, JSON out. No I/O, no Date.now. Live pulses (same SSE Stream
 * objects: { event, data }) only SET bits; they never author cells.
 * Overlay requires data.nr_kind — no reverse pulse→kind table.
 */

import { KIND_ROUTES, routeIdFromNr, routeIdFromPulse } from './pulse-map.mjs';

const LIFECYCLE = new Set(['connected', 'now', 'status', 'updated', 'error']);

function nrsOf(bucket) {
  if (!bucket) return { golden: [], sample: [] };
  if (Array.isArray(bucket.golden) || Array.isArray(bucket.sample)) {
    return { golden: bucket.golden || [], sample: bucket.sample || [] };
  }
  if (Array.isArray(bucket)) return { golden: bucket, sample: [] };
  return { golden: [], sample: [] };
}

/** Capability flags that mean a kind is out of scope — not a golden hole. */
function kindExpected(id, caps = {}) {
  if (id === 'unknown_record') return false;
  if (id === 'tokens') return caps.tokens !== false;
  if (id === 'context_reset') return caps.context_resets !== false;
  if (id === 'branch_change') return caps.branches !== false;
  return true;
}

function kindRole(id, spec) {
  if (id === 'unknown_record') return 'catchall';
  if (spec && spec.event === 'unknown') return 'alarm';
  return 'emit';
}

function emptyProof(n) {
  return Array.from({ length: n }, () => []);
}

function proofFor(seenBySource, id, harnesses) {
  return harnesses.map(h => {
    const seen = seenBySource[h.id] || { golden: new Set(), sample: new Set() };
    const p = [];
    if (seen.golden.has(id)) p.push('golden');
    if (seen.sample.has(id)) p.push('sample');
    return p;
  });
}

export const UNKNOWN_BUCKET_MAX = 80;

/** Slim coverage-hole record from a Stream pulse. Null if not an unknown. */
export function unknownFromPulse(event, data = {}) {
  if (event !== 'unknown' || !data) return null;
  if (!data.harness && !data.nr_kind) return null;
  return {
    harness: data.harness || null,
    nr_kind: data.nr_kind || null,
    raw_type: data.raw_type ?? null,
    block_type: data.block_type ?? null,
    slug: data.slug || null,
    project: data.project || null,
    session_id: data.session_id || null,
    ts: data.ts || null,
  };
}

export function unknownKey(u) {
  return [u.harness || '', u.nr_kind || '', u.raw_type || '', u.block_type || ''].join('|');
}

/** Distinct-signature bucket, newest first. Immutable. */
export function addUnknown(list, entry, max = UNKNOWN_BUCKET_MAX) {
  if (!entry) return Array.isArray(list) ? list : [];
  const key = unknownKey(entry);
  const cur = Array.isArray(list) ? list.slice() : [];
  const i = cur.findIndex(x => x.key === key);
  if (i >= 0) {
    const prev = cur[i];
    cur.splice(i, 1);
    cur.unshift({
      ...prev,
      count: (prev.count || 1) + 1,
      last_ts: entry.ts || prev.last_ts || null,
      slug: entry.slug || prev.slug || null,
      project: entry.project || prev.project || null,
      session_id: entry.session_id || prev.session_id || null,
    });
  } else {
    cur.unshift({
      key,
      harness: entry.harness || null,
      nr_kind: entry.nr_kind || null,
      raw_type: entry.raw_type ?? null,
      block_type: entry.block_type ?? null,
      count: 1,
      last_ts: entry.ts || null,
      slug: entry.slug || null,
      project: entry.project || null,
      session_id: entry.session_id || null,
      source: entry.source || 'pulse',
    });
  }
  return cur.slice(0, max);
}

export function buildKindMapPayload({
  harnesses = [],
  kinds = [],
  kindPulse = {},
  traces = {},
  toolNameToKey = (name) => name,
  toolKeys = [],
  generated_at = null,
} = {}) {
  const kindsSeen = {};
  const routesSeen = {};
  const toolsSeen = {};
  let unknowns = [];

  for (const h of harnesses) {
    const { golden, sample } = nrsOf(traces[h.id]);
    kindsSeen[h.id] = {
      golden: new Set(golden.map(nr => nr.kind)),
      sample: new Set(sample.map(nr => nr.kind)),
    };
    routesSeen[h.id] = { golden: new Set(), sample: new Set() };
    toolsSeen[h.id] = {};
    for (const [source, nrs] of [['golden', golden], ['sample', sample]]) {
      for (const nr of nrs) {
        const rid = routeIdFromNr(nr);
        if (rid) routesSeen[h.id][source].add(`${nr.kind}:${rid}`);
        if (nr.kind !== 'tool_use' || !nr.tool) continue;
        const key = toolNameToKey(nr.tool, nr.category);
        const list = toolsSeen[h.id][key] || (toolsSeen[h.id][key] = []);
        if (!list.includes(nr.tool)) list.push(nr.tool);
      }
    }
  }

  const kindRows = kinds.map(id => {
    const spec = kindPulse[id] || { event: 'unknown' };
    const proof = proofFor(kindsSeen, id, harnesses);
    const role = kindRole(id, spec);
    const expect = harnesses.map(h => (kindExpected(id, h.capabilities) ? 1 : 0));
    const routeSpecs = KIND_ROUTES[id] || [];
    const routes = routeSpecs.map(rs => {
      const rProof = proofFor(routesSeen, `${id}:${rs.id}`, harnesses);
      return {
        id: rs.id,
        pulse: rs.pulse,
        reason: rs.reason || null,
        role: rs.role,
        expect: harnesses.map(() => (rs.role === 'alarm' || rs.expect === 'none' ? 0 : 1)),
        emit: rProof.map(p => (p.length ? 1 : 0)),
        proof: rProof,
      };
    });
    const row = {
      id,
      pulse: spec.event,
      reason: spec.reason || null,
      lane: spec.event === 'silent' ? 'snapshot' : 'stream',
      role,
      expect,
      emit: proof.map(p => (p.length ? 1 : 0)),
      proof,
    };
    if (routes.length) row.routes = routes;
    return row;
  });

  const toolRows = toolKeys.map(key => ({
    key,
    role: key === 'other' ? 'catchall' : 'emit',
    by_harness: Object.fromEntries(
      harnesses.map(h => [h.id, (toolsSeen[h.id] && toolsSeen[h.id][key]) || []]),
    ),
  }));

  return {
    generated_at,
    harnesses: harnesses.map(h => ({
      id: h.id,
      label: h.label,
      capabilities: h.capabilities || {},
      detected: !!h.detected,
      verified: !!h.verified,
    })),
    kinds: kindRows,
    tools: toolRows,
    unknowns,
  };
}

/** Map a Stream pulse event to a RECORD_KIND, or null for lifecycle / unstamped. */
export function kindFromPulse(event, data = {}) {
  if (!event || LIFECYCLE.has(event)) return null;
  return data.nr_kind || null;
}

function withPulseProof(row, hi, nHarnesses) {
  const emit = row.emit.slice();
  emit[hi] = 1;
  const proof = (row.proof && row.proof.length === nHarnesses
    ? row.proof.map(p => p.slice())
    : emptyProof(nHarnesses));
  if (!proof[hi].includes('pulse')) proof[hi].push('pulse');
  return { ...row, emit, proof };
}

/**
 * Overlay one Stream pulse onto a kind-map payload. Same {event, data}
 * shape the hub broadcasts. Immutable; returns the input if nothing changes.
 * Requires data.nr_kind — pulses without it do not light kinds.
 */
export function applyKindMapPulse(payload, event, data = {}) {
  if (!payload || !data.harness) return payload;
  const hi = payload.harnesses.findIndex(h => h.id === data.harness);
  const hole = unknownFromPulse(event, data);
  if (hi < 0 && !hole) return payload;

  const kindId = kindFromPulse(event, data);
  if (!kindId && !hole) return payload;
  const nH = payload.harnesses.length;
  let changed = false;
  let unknowns = payload.unknowns || [];
  if (hole) {
    unknowns = addUnknown(unknowns, { ...hole, source: 'pulse' });
    changed = true;
  }
  if (hi < 0) return changed ? { ...payload, unknowns } : payload;
  let harnessesOut = payload.harnesses;
  if (kindId && !payload.harnesses[hi].verified) {
    changed = true;
    harnessesOut = payload.harnesses.map((h, i) => (i === hi ? { ...h, verified: true } : h));
  }
  const routeId = routeIdFromPulse(event, data);

  let kinds = payload.kinds;
  if (kindId) {
    const ki = kinds.findIndex(row => row.id === kindId);
    if (ki >= 0) {
      const row = kinds[ki];
      let next = row;
      const already = row.emit[hi] === 1 && (row.proof?.[hi] || []).includes('pulse');
      if (!already) next = withPulseProof(row, hi, nH);
      if (routeId && next.routes) {
        const ri = next.routes.findIndex(rt => rt.id === routeId);
        if (ri >= 0) {
          const rt = next.routes[ri];
          const rAlready = rt.emit[hi] === 1 && (rt.proof?.[hi] || []).includes('pulse');
          if (!rAlready) {
            const routes = next.routes.slice();
            routes[ri] = withPulseProof(rt, hi, nH);
            next = { ...next, routes };
          }
        }
      }
      if (next !== row) {
        changed = true;
        kinds = kinds.slice();
        kinds[ki] = next;
      }
    }
  }

  let tools = payload.tools;
  if (kindId && event === 'tool_call' && data.tool && data.key) {
    const ti = tools.findIndex(t => t.key === data.key);
    if (ti >= 0) {
      const t = tools[ti];
      const cur = t.by_harness[data.harness] || [];
      if (!cur.includes(data.tool)) {
        changed = true;
        tools = tools.slice();
        tools[ti] = {
          ...t,
          by_harness: { ...t.by_harness, [data.harness]: [...cur, data.tool] },
        };
      }
    }
  }

  if (!changed) return payload;
  return { ...payload, harnesses: harnessesOut, kinds, tools, unknowns };
}
