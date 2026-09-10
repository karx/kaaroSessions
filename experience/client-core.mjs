/**
 * experience/client-core.mjs — shared browser core for every page
 * (graph, Mission Control, DAW): formatters, color vocabulary, geometry,
 * SSE wiring. The single source of truth for helpers that were previously
 * triplicated across 01-data.js, 05-interaction.js, 16-beat-overlay.js,
 * 19-daw-builder.js, and now.html.
 *
 * SYNTAX CONTRACT: only `export function` / `export async function` /
 * `export const` at top level — build.mjs strips the `export ` prefix and
 * injects the body into page bundles via the CLIENT_CORE placeholder, so
 * this file must also be valid plain script. Node tests import it as a
 * normal ESM module.
 */

// ── Formatters ────────────────────────────────────────────────────────────────

export function fmtTok(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'k';
  return String(n);
}

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function fmtAgo(sec) {
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm' + (sec % 60) + 's';
  return Math.floor(sec / 3600) + 'h' + Math.floor((sec % 3600) / 60) + 'm';
}

// ── Search / highlight (Thread View find-in-thread) ──────────────────────────

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Wrap case-insensitive literal matches of `query` in <mark class="thr-hit">,
 * escaping everything else with `escapeFn` (defaults to `esc`). Empty query
 * returns the plain escaped text — the no-search render path.
 */
export function highlightMatches(text, query, escapeFn = esc) {
  const s = String(text ?? '');
  if (!query) return escapeFn(s);
  const re = new RegExp(escapeRegExp(query), 'gi');
  let out = '', last = 0, m;
  while ((m = re.exec(s))) {
    out += escapeFn(s.slice(last, m.index));
    out += `<mark class="thr-hit">${escapeFn(m[0])}</mark>`;
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  out += escapeFn(s.slice(last));
  return out;
}

/** Count case-insensitive literal occurrences of `query` in `text`. */
export function countMatches(text, query) {
  if (!query) return 0;
  const re = new RegExp(escapeRegExp(query), 'gi');
  return (String(text ?? '').match(re) || []).length;
}

// ── Contrast (WCAG relative luminance) ────────────────────────────────────────
// Mirrors experience/wcag-contrast.mjs; duplicated because this file is
// inlined as a plain <script> with no imports. test/client-core.test.mjs
// cross-checks both implementations agree.

function _linearChannel(c) {
  const c1 = c / 255;
  return c1 <= 0.03928 ? c1 / 12.92 : ((c1 + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.2126 * _linearChannel(r) + 0.7152 * _linearChannel(g) + 0.0722 * _linearChannel(b);
}

/** Pick full-opacity black or white, whichever contrasts more against `hex`. */
export function readableTextOn(hex) {
  const l = relativeLuminance(hex);
  const withWhite = 1.05 / (l + 0.05);
  const withBlack = (l + 0.05) / 0.05;
  return withWhite >= withBlack ? '#ffffff' : '#000000';
}

// ── Color vocabulary (color is grammar — one meaning per hue) ────────────────

export const TOOL_COLORS = {
  Write: '#00bb55', Edit: '#ccaa00', Read: '#2a5c8a',
  Bash: '#cc6622', Shell: '#cc6622', PowerShell: '#cc6622',
  Grep: '#7733aa', Glob: '#7733aa', Agent: '#cc2244', Task: '#cc2244',
  ToolSearch: '#6644aa', WebFetch: '#336688', WebSearch: '#336688',
};

export const TOOL_COLORS_LC = Object.fromEntries(
  Object.entries(TOOL_COLORS).map(([k, v]) => [k.toLowerCase(), v])
);

/** Case-insensitive tool → color; null for unknown tools. */
export function toolColor(tool) {
  return TOOL_COLORS_LC[(tool || '').toLowerCase()] ?? null;
}

export const EDGE_COLORS  = {
  membership: '#1e3d7a', write: '#00ff88', edit: '#ffcc00', read: '#1e4a66',
  branch: '#334455', bundle: '#4a3a7a', spawn: '#cc2244',
};
export const EDGE_OPACITY = {
  membership: .55, write: .65, edit: .65, read: .28, branch: .4, bundle: .45, spawn: .5,
};
export const EDGE_WIDTH   = {
  membership: 1.4, write: 1, edit: 1, read: .7, branch: .8, bundle: 1, spawn: 1.1,
};

// ── Geometry ──────────────────────────────────────────────────────────────────

export const NODE_RADII = { PR_MIN: 18, PR_MAX: 34, SR_MIN: 5, SR_MAX: 20, FR_MIN: 3, FR_MAX: 13, CL_MIN: 12, CL_MAX: 24, SUB_R: 4 };

// d3 default is 0.0228 (~5s settle). 0.006 ran ~19s of manyBody on 700+ nodes.
export const SIM_ALPHA_DECAY = 0.02;

function hexVertices(r) {
  const pts = [];
  for (let k = 0; k < 6; k++) {
    const a = k * Math.PI / 3;
    pts.push([r * Math.sin(a), -r * Math.cos(a)]);
  }
  return pts;
}

function pathFromPts(pts) {
  return 'M' + pts.map(([x, y]) => `${x},${y}`).join('L') + 'Z';
}

/** Pointy-top regular hexagon path, vertex 0 at (0,-r) — the project glyph silhouette. */
export function hexPath(r) {
  return pathFromPts(hexVertices(r));
}

// Harness fill on the project hex — data, not chrome (mirrors TOOL_COLORS).
// No blue-family hues: Register A retired navy chrome; ticks/fills still encode identity.
export const HARNESS_MARK = {
  'claude-code': '#2a9d8f', codex: '#d9534f', pi: '#ff9944', antigravity: '#44cc88',
  grok: '#cc4488', opencode: '#aacc44', copilot: '#c070b0', 'command-code': '#ffcc44',
};
export const HARNESS_FILL_OPACITY = 1;

/** Solid harness fill only while the project is live (recencyLevel ≥ 1 or in flight). */
export function isProjectGlyphActive(d) {
  if (!d) return false;
  if (d.inFlight) return true;
  return (d.recencyLevel || 0) >= 1;
}

/**
 * Pointy-top hex packing. Odd rows shift by half a column so neighbours
 * tessellate. Origin defaults to (r, r) so the first hex is not clipped.
 */
export function glyphCellPitch(r = 16) {
  return { dx: r * Math.sqrt(3), dy: r * 1.5 };
}

export function glyphCellPosition(col, row, { r = 16, originX, originY } = {}) {
  const { dx, dy } = glyphCellPitch(r);
  const ox = originX != null ? originX : r;
  const oy = originY != null ? originY : r;
  return {
    x: ox + col * dx + (row % 2 ? dx / 2 : 0),
    y: oy + row * dy,
  };
}

export function glyphGrid(n, opts = {}) {
  const count = Math.max(0, n | 0);
  const c = Math.max(1, opts.cols || Math.ceil(Math.sqrt(count || 1)));
  const cells = [];
  for (let i = 0; i < count; i++) {
    const col = i % c;
    const row = (i - col) / c;
    cells.push({ i, col, row, ...glyphCellPosition(col, row, opts) });
  }
  return cells;
}

export function glyphLatticeCells({ cols = 12, rows = 10, r = 16, originX, originY } = {}) {
  const cells = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cells.push({ col, row, ...glyphCellPosition(col, row, { r, originX, originY }) });
    }
  }
  return cells;
}

export function glyphWorldExtent({ cols = 1, rows = 1, r = 16, originX, originY } = {}) {
  const c = Math.max(1, cols);
  const rr = Math.max(1, rows);
  const even = glyphCellPosition(c - 1, 0, { r, originX, originY });
  const odd = rr > 1 ? glyphCellPosition(c - 1, 1, { r, originX, originY }) : even;
  const last = glyphCellPosition(c - 1, rr - 1, { r, originX, originY });
  return {
    width: Math.ceil(Math.max(even.x, odd.x) + r + 1),
    height: Math.ceil(last.y + r + 1),
  };
}

export function glyphGridExtent(n, opts = {}) {
  const count = Math.max(0, n | 0);
  const c = Math.max(1, opts.cols || Math.ceil(Math.sqrt(count || 1)));
  const rows = Math.max(1, Math.ceil((count || 1) / c));
  return glyphWorldExtent({ ...opts, cols: c, rows });
}

export function snapToGlyphCell(x, y, { r = 16, cols, rows, originX, originY } = {}) {
  const { dx, dy } = glyphCellPitch(r);
  const ox = originX != null ? originX : r;
  const oy = originY != null ? originY : r;
  let row = Math.round((y - oy) / dy);
  if (rows != null) row = Math.max(0, Math.min(rows - 1, row));
  const xOff = row % 2 ? dx / 2 : 0;
  let col = Math.round((x - ox - xOff) / dx);
  if (cols != null) col = Math.max(0, Math.min(cols - 1, col));
  return { col, row, ...glyphCellPosition(col, row, { r, originX, originY }) };
}

const AXIAL_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

export function axialToOddR(q, r) {
  return { col: q + (r - (r & 1)) / 2, row: r };
}

/** i=0 is origin; then hex rings (6, 12, 18, …) — default seat order. */
export function glyphSpiralCell(index) {
  const i = Math.max(0, index | 0);
  if (i === 0) return { col: 0, row: 0 };
  let ring = 1;
  let used = 1;
  while (used + 6 * ring <= i) {
    used += 6 * ring;
    ring++;
  }
  let step = i - used;
  let q = AXIAL_DIRS[4][0] * ring;
  let r = AXIAL_DIRS[4][1] * ring;
  for (let d = 0; d < 6 && step > 0; d++) {
    for (let s = 0; s < ring && step > 0; s++) {
      q += AXIAL_DIRS[d][0];
      r += AXIAL_DIRS[d][1];
      step--;
    }
  }
  return axialToOddR(q, r);
}

export function firstAvailableRadial(occupied) {
  const occ = occupied instanceof Set ? occupied : new Set(occupied || []);
  for (let i = 0; i < 100000; i++) {
    const c = glyphSpiralCell(i);
    if (!occ.has(c.col + ',' + c.row)) return c;
  }
  return { col: 0, row: 0 };
}

/** Visible hexes for an infinite board — includes negative col/row. */
export function glyphLatticeWindow({ x0, y0, x1, y1, r = 16, originX = 0, originY = 0, pad = 1 } = {}) {
  const a = snapToGlyphCell(x0, y0, { r, originX, originY });
  const b = snapToGlyphCell(x1, y1, { r, originX, originY });
  const minCol = Math.min(a.col, b.col) - pad;
  const maxCol = Math.max(a.col, b.col) + pad;
  const minRow = Math.min(a.row, b.row) - pad;
  const maxRow = Math.max(a.row, b.row) + pad;
  const cells = [];
  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      cells.push({ col, row, ...glyphCellPosition(col, row, { r, originX, originY }) });
    }
  }
  return cells;
}

export function glyphBoardConfig() {
  return { r: 22, originX: 0, originY: 0 };
}

/** Graph-canvas hex radius: a project glyph (≤ PR_MAX) sits inside the cell. */
export const GLYPH_GRAPH_R = NODE_RADII.PR_MAX * 2;

/** Lattice origin = canvas centre. Cell (0,0) is the middle hex; seats do not rescale. */
export function glyphGraphConfig(width, height, r = GLYPH_GRAPH_R) {
  return { r, originX: (width || 0) / 2, originY: (height || 0) / 2 };
}

/** Hex relatives → graph-space pins. Identity mapping — (0,0) stays at centre. */
export function glyphGraphPins(placements, { width, height, r = GLYPH_GRAPH_R } = {}) {
  const cfg = glyphGraphConfig(width, height, r);
  const out = {};
  for (const id of Object.keys(placements || {})) {
    const p = placements[id];
    if (!p || !Number.isFinite(+p.col) || !Number.isFinite(+p.row)) continue;
    out[id] = glyphCellPosition(p.col, p.row, cfg);
  }
  return out;
}

/**
 * Map a graph-space camera rect onto minimap user space. Graph origin (canvas
 * centre) maps to minimap origin (0,0); scale is miniR / graphR.
 */
export function graphRectToMinimap(rect, { graphR = GLYPH_GRAPH_R, miniR = 7, originX = 0, originY = 0 } = {}) {
  const s = graphR ? miniR / graphR : 0;
  return {
    x: (rect.worldX - originX) * s,
    y: (rect.worldY - originY) * s,
    w: rect.worldW * s,
    h: rect.worldH * s,
  };
}

export function mergeGlyphPlacements(ids, saved) {
  const list = ids || [];
  const occupied = new Set();
  const result = {};
  const key = (col, row) => col + ',' + row;
  for (const id of list) {
    const p = saved && saved[id];
    if (!p || !Number.isFinite(+p.col) || !Number.isFinite(+p.row)) continue;
    const col = p.col | 0, row = p.row | 0;
    if (occupied.has(key(col, row))) continue;
    result[id] = { col, row };
    occupied.add(key(col, row));
  }
  for (const id of list) {
    if (result[id]) continue;
    const cell = firstAvailableRadial(occupied);
    result[id] = cell;
    occupied.add(key(cell.col, cell.row));
  }
  return result;
}

/** Map hex-cell relatives into a force viewport. Relative seats stay relative. */
export function scaleGlyphPins(placements, { width, height, r = 22, margin = 80, originX = 0, originY = 0 } = {}) {
  const ids = Object.keys(placements || {});
  if (!ids.length) return {};
  const pts = ids.map(id => ({
    id,
    ...glyphCellPosition(placements[id].col, placements[id].row, { r, originX, originY }),
  }));
  if (pts.length === 1) return { [pts[0].id]: { x: width / 2, y: height / 2 } };
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const bw = Math.max(r, maxX - minX);
  const bh = Math.max(r, maxY - minY);
  const s = Math.min((width - 2 * margin) / bw, (height - 2 * margin) / bh);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const out = {};
  for (const p of pts) {
    out[p.id] = { x: width / 2 + (p.x - cx) * s, y: height / 2 + (p.y - cy) * s };
  }
  return out;
}

export function moveGlyphPlacement(placements, id, col, row) {
  const next = { ...(placements || {}) };
  const occupant = Object.keys(next).find(k => k !== id && next[k].col === col && next[k].row === row);
  const prev = next[id] || { col: 0, row: 0 };
  if (occupant) next[occupant] = { col: prev.col, row: prev.row };
  next[id] = { col, row };
  return next;
}

export function minimapViewportRect({ worldX, worldY, worldW, worldH, boardW, boardH, miniW, miniH }) {
  if (!boardW || !boardH || !miniW || !miniH) return { x: 0, y: 0, w: 0, h: 0 };
  return {
    x: worldX * miniW / boardW,
    y: worldY * miniH / boardH,
    w: worldW * miniW / boardW,
    h: worldH * miniH / boardH,
  };
}

/** Inner SVG paths for one project hex. Idle = hollow; active = solid wedges. */
export function projectGlyphMarkup(d, { r = 16, bg = '#000000' } = {}) {
  const color = d?.color || '#888888';
  const stroke = `<path d="${hexPath(r)}" fill="none" stroke="${esc(color)}" stroke-width="2"/>`;
  if (!isProjectGlyphActive(d)) {
    return `<path d="${hexPath(r)}" fill="${bg}" stroke="${esc(color)}" stroke-width="2"/>`;
  }
  const wedges = harnessWedges(d.harnesses, r);
  if (!wedges.length) {
    return `<path d="${hexPath(r)}" fill="${bg}" stroke="${esc(color)}" stroke-width="2"/>`;
  }
  const fills = wedges.map(w =>
    `<path d="${w.d}" fill="${HARNESS_MARK[w.harness] || color}" fill-opacity="${HARNESS_FILL_OPACITY}"/>`
  ).join('');
  return fills + stroke;
}

export function projectGlyphSvg(d, opts = {}) {
  const r = opts.r || 16;
  const pad = 1;
  const size = r * 2 + pad * 2;
  return `<svg class="pglyph" width="${size}" height="${size}" viewBox="${-r - pad} ${-r - pad} ${size} ${size}" aria-hidden="true">${projectGlyphMarkup(d, opts)}</svg>`;
}

function glyphCellsExtent(cells, r) {
  if (!cells.length) return { minX: -r, minY: -r, width: r * 2, height: r * 2 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of cells) {
    minX = Math.min(minX, c.x - r);
    minY = Math.min(minY, c.y - r);
    maxX = Math.max(maxX, c.x + r);
    maxY = Math.max(maxY, c.y + r);
  }
  return { minX, minY, width: Math.ceil(maxX - minX), height: Math.ceil(maxY - minY) };
}

/** One svg with every project hex parked on a hex grid — brand field. */
export function projectGlyphFieldSvg(projects, { r = 12, cols, rows, bg = '#000000', placements, lattice, originX = 0, originY = 0 } = {}) {
  const list = projects || [];
  const merged = mergeGlyphPlacements(list.map(p => p.id), placements);
  const opts = { r, originX, originY };
  const placed = list.map(p => {
    const slot = merged[p.id] || { col: 0, row: 0 };
    return { ...slot, ...glyphCellPosition(slot.col, slot.row, opts), id: p.id };
  });
  const pad = 2;
  const colsUsed = placed.map(c => c.col);
  const rowsUsed = placed.map(c => c.row);
  const minCol = (colsUsed.length ? Math.min(0, ...colsUsed) : 0) - pad;
  const maxCol = (colsUsed.length ? Math.max(0, ...colsUsed) : 0) + pad;
  const minRow = (rowsUsed.length ? Math.min(0, ...rowsUsed) : 0) - pad;
  const maxRow = (rowsUsed.length ? Math.max(0, ...rowsUsed) : 0) + pad;
  const latticeCells = lattice
    ? glyphLatticeWindow({
        x0: glyphCellPosition(minCol, minRow, opts).x,
        y0: glyphCellPosition(minCol, minRow, opts).y,
        x1: glyphCellPosition(maxCol, maxRow, opts).x,
        y1: glyphCellPosition(maxCol, maxRow, opts).y,
        ...opts, pad: 0,
      })
    : placed;
  const extent = glyphCellsExtent(lattice ? latticeCells : placed, r);
  const latticeMarks = lattice
    ? latticeCells.map(cell =>
        `<path class="pglyph-lattice" d="${hexPath(r)}" transform="translate(${cell.x},${cell.y})" fill="none"/>`
      ).join('')
    : '';
  const groups = list.map(p => {
    const slot = merged[p.id] || { col: 0, row: 0 };
    const pos = glyphCellPosition(slot.col, slot.row, opts);
    return `<g class="pglyph-cell" data-pid="${esc(p.id)}" data-col="${slot.col}" data-row="${slot.row}" transform="translate(${pos.x},${pos.y})">${projectGlyphMarkup(p, { r, bg })}<title>${esc(p.label || p.id)}</title></g>`;
  }).join('');
  return `<svg class="pglyph-field" width="${extent.width}" height="${extent.height}" viewBox="${extent.minX} ${extent.minY} ${extent.width} ${extent.height}">${latticeMarks}${groups}</svg>`;
}

function uniqHarnesses(harnesses) {
  const list = [];
  const seen = new Set();
  for (const h of harnesses || []) {
    if (!h || seen.has(h)) continue;
    seen.add(h);
    list.push(h);
  }
  return list;
}

function rayHexIntersect(angle, verts) {
  const dx = Math.sin(angle);
  const dy = -Math.cos(angle);
  let bestT = Infinity;
  let hit = [dx, dy];
  for (let i = 0; i < 6; i++) {
    const [x1, y1] = verts[i];
    const [x2, y2] = verts[(i + 1) % 6];
    const ex = x2 - x1, ey = y2 - y1;
    const D = dx * (-ey) - dy * (-ex);
    if (Math.abs(D) < 1e-12) continue;
    const t = (x1 * (-ey) - (-ex) * y1) / D;
    const u = (dx * y1 - dy * x1) / D;
    if (t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 && t < bestT) {
      bestT = t;
      hit = [t * dx, t * dy];
    }
  }
  return hit;
}

function angleInOpenWedge(a, a0, a1) {
  const tau = Math.PI * 2;
  const norm = x => ((x % tau) + tau) % tau;
  a = norm(a); a0 = norm(a0); a1 = norm(a1);
  const eps = 1e-9;
  if (a1 > a0 + eps) return a > a0 + eps && a < a1 - eps;
  return a > a0 + eps || a < a1 - eps;
}

function ptsNear(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-8;
}

/**
 * Interior fill of a project hex, one polygon per distinct harness.
 * 1 → solid hex; 2 → half-split through top–bottom vertices; 3 → 120°
 * center fan (vertex-aligned); 4+ → equal-angle polygons from the center
 * to each side/corner the ray hits.
 *
 * `weights` (optional `{ [harness]: count }`) makes wedge angle proportional
 * to share of count instead of equal division — e.g. session counts per
 * harness. Omitted, null, or all-equal weights reproduce the equal-angle
 * default exactly.
 */
export function harnessWedges(harnesses, r, weights) {
  const list = uniqHarnesses(harnesses);
  if (!list.length) return [];
  const verts = hexVertices(r);
  if (list.length === 1) return [{ harness: list[0], d: pathFromPts(verts) }];
  const n = list.length;
  const tau = Math.PI * 2;
  const w = weights ? list.map(h => Math.max(0, weights[h] || 0)) : list.map(() => 1);
  const totalW = w.reduce((a, b) => a + b, 0) || n;
  const bounds = [0];
  let acc = 0;
  for (const wi of w) { acc += wi; bounds.push(acc / totalW * tau); }
  bounds[n] = tau; // exact close — avoids float drift leaving a hairline gap
  return list.map((h, i) => {
    const a0 = bounds[i];
    const a1 = bounds[i + 1];
    const p0 = rayHexIntersect(a0, verts);
    const p1 = rayHexIntersect(a1, verts);
    const mid = verts.filter((_, k) => angleInOpenWedge(k * Math.PI / 3, a0, a1));
    const pts = [[0, 0], p0];
    for (const v of mid) {
      if (!ptsNear(v, p0) && !ptsNear(v, p1)) pts.push(v);
    }
    if (!ptsNear(p1, pts[pts.length - 1])) pts.push(p1);
    return { harness: h, d: pathFromPts(pts) };
  });
}

/**
 * ME glyph — one hex for the whole graph. Usage is session count so
 * tokenless harnesses still count. Wedge order is count-desc, then id,
 * so the largest share starts at the top vertex.
 */
export function meGlyph(sessions = []) {
  const counts = new Map();
  for (const s of sessions || []) {
    const h = s?.harness || s?.source;
    if (!h) continue;
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const harnesses = [...counts.keys()].sort((a, b) => {
    const d = counts.get(b) - counts.get(a);
    if (d) return d;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const weights = {};
  const rows = harnesses.map(harness => {
    const count = counts.get(harness);
    weights[harness] = count;
    return {
      harness,
      count,
      share: total ? count / total : 0,
      pct: total ? Math.round(100 * count / total) : 0,
      color: HARNESS_MARK[harness] || '#888888',
    };
  });
  return { harnesses, weights, total, rows };
}

/** ME hex: hollow when empty; solid wedges proportional to share. */
export function meGlyphMarkup(me, { r = 28, bg = '#000000', color = '#ccccaa' } = {}) {
  const stroke = `<path d="${hexPath(r)}" fill="none" stroke="${esc(color)}" stroke-width="2"/>`;
  if (!me || !me.total) {
    return `<path d="${hexPath(r)}" fill="${bg}" stroke="${esc(color)}" stroke-width="2"/>`;
  }
  const wedges = harnessWedges(me.harnesses, r, me.weights);
  const fills = wedges.map(w =>
    `<path d="${w.d}" fill="${HARNESS_MARK[w.harness] || color}" fill-opacity="${HARNESS_FILL_OPACITY}"/>`
  ).join('');
  return fills + stroke;
}

export function meGlyphSvg(me, opts = {}) {
  const r = opts.r || 28;
  const pad = 1;
  const size = r * 2 + pad * 2;
  return `<svg class="me-glyph" width="${size}" height="${size}" viewBox="${-r - pad} ${-r - pad} ${size} ${size}" aria-hidden="true">${meGlyphMarkup(me, { ...opts, r })}</svg>`;
}

/** Hex + session count + per-harness share rows — dock and landing. */
export function meGlyphCardHtml(me, opts = {}) {
  const r = opts.r || 28;
  const total = me?.total || 0;
  const nH = me?.harnesses?.length || 0;
  const line = total
    ? `${total} session${total === 1 ? '' : 's'} · ${nH} harness${nH === 1 ? '' : 'es'}`
    : 'no sessions';
  const legend = (me?.rows || []).map(row =>
    `<div class="me-row"><span class="me-swatch" style="background:${esc(row.color)}"></span>` +
    `<span class="me-h">${esc(row.harness)}</span>` +
    `<span class="me-pct">${row.pct}%</span>` +
    `<span class="me-n">${row.count}</span></div>`
  ).join('');
  return meGlyphSvg(me, opts) + `<div class="me-line">${line}</div>` +
    (legend ? `<div class="me-rows">${legend}</div>` : '');
}

/** Panel rows for a project: glyph order, session counts, mark colors. */
export function harnessBreakdown(harnesses, sessions = []) {
  const order = uniqHarnesses(harnesses);
  const counts = new Map(order.map(h => [h, 0]));
  for (const s of sessions) {
    const h = s?.harness || s?.source;
    if (!h) continue;
    if (!counts.has(h)) order.push(h);
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  return order.map(harness => ({
    harness,
    count: counts.get(harness) || 0,
    color: HARNESS_MARK[harness] || '#888888',
  }));
}

export function nodeRadius(d, r = NODE_RADII) {
  if (d.type === 'project') return r.PR_MIN + (r.PR_MAX - r.PR_MIN) * (d.sizeNorm || 0);
  if (d.type === 'session') return r.SR_MIN + (r.SR_MAX - r.SR_MIN) * (d.sizeNorm || 0);
  if (d.type === 'cluster') return r.CL_MIN + (r.CL_MAX - r.CL_MIN) * (d.sizeNorm || 0);
  if (d.type === 'subagent') return r.SUB_R;
  return r.FR_MIN + (r.FR_MAX - r.FR_MIN) * (d.sizeNorm || 0);
}

export function edgeOpacity(d, maxWeight) {
  const b = EDGE_OPACITY[d.type] || .3;
  if (!d.weight) return b;
  const wn = Math.sqrt(d.weight / Math.max(1, maxWeight));
  return Math.min(1, b * (0.5 + 1.5 * wn));
}

export function edgeWidth(d, maxWeight) {
  const b = EDGE_WIDTH[d.type] || 1;
  if (!d.weight) return b;
  const wn = Math.sqrt(d.weight / Math.max(1, maxWeight));
  return b * (0.5 + 2 * wn);
}

// Block geometry for live-feed canvases (DAW widget / builder lanes).
// Two-layer model: ambient floor (tokens/words pinned to the bottom) under
// top-anchored activity spikes whose height encodes significance.
export function blockGeom(ev, trackH = 62) {
  const t = (ev.tool || '').toLowerCase();
  if (ev.type === 'tokens') return { h: 4,  yOff: trackH - 4  };
  if (ev.type === 'words')  return { h: 8,  yOff: trackH - 13 };
  // Cognition events: structural markers (full-height for resets/failures,
  // medium for human presence, low ticks for mode chrome, faint chirps)
  if (ev.type === 'compact' || ev.type === 'tool_error' || ev.type === 'api_error')
    return { h: trackH - 4, yOff: 2 };
  if (ev.type === 'human_turn') return { h: 36, yOff: 2 };
  if (ev.type === 'permission' || ev.type === 'mode_shift') return { h: 12, yOff: 2 };
  if (ev.type === 'chirp') return { h: 5, yOff: trackH - 22 };
  if (ev.type === 'thinking') return { h: 16, yOff: 20 };
  if (t === 'write')                       return { h: 52, yOff: 2 };
  if (t === 'edit')                        return { h: 46, yOff: 2 };
  if (t === 'agent' || t === 'task')       return { h: 40, yOff: 2 };
  if (t === 'read')                        return { h: 32, yOff: 2 };
  if (t === 'bash' || t === 'powershell' || t === 'shell') return { h: 22, yOff: 2 };
  if (t === 'grep' || t === 'glob')        return { h: 14, yOff: 2 };
  return { h: 20, yOff: 2 };
}

// ── DAW lane geometry (Cognitive DAW Builder) ─────────────────────────────────
// Lane tool colors are deliberately brighter variants of TOOL_COLORS — they sit
// on the dark per-family lane backgrounds (visual contract, do not unify).

export const DAW_FAMILY_LANES = [
  {
    id: 'file', label: 'FILE OPS', bg: '#0b1a0e', portion: 0.28,
    toolColors: { write: '#00cc55', edit: '#ccaa00', read: '#3a6aaa', grep_glob: '#8844cc' },
    blockW: e => e.key === 'write' ? 10 : e.key === 'edit' ? 8 : 5,
    blockH: e => e.key === 'write' ? 0.85 : e.key === 'edit' ? 0.70 : 0.50,
  },
  {
    id: 'system', label: 'SYSTEM', bg: '#0a0a18', portion: 0.20,
    toolColors: { bash_git: '#cc5522', bash_run: '#dd7733', bash_other: '#555577' },
    blockW: () => 7,
    blockH: () => 0.70,
  },
  {
    id: 'ai', label: 'AI / AGENT', bg: '#100818', portion: 0.25,
    toolColors: { agent: '#cc2244', other: '#884466' },
    blockW: e => e.key === 'agent' ? 14 : 8,
    blockH: () => 0.85,
  },
  {
    id: 'context', label: 'CONTEXT', bg: '#080c18', portion: 0.15,
    toolColors: { tokens: '#00ddcc', words: '#00aaff', thinking: '#ffaa00' },
    blockW: e => e.type === 'tokens' ? 3 : e.type === 'thinking' ? 6 : 8,
    blockH: e => {
      if (e.type === 'tokens')
        return Math.max(0.1, Math.min(0.8, Math.log1p((e.output || 0) / 200) * 0.35));
      if (e.type === 'thinking') return 0.45;
      return Math.max(0.1, Math.min(0.85, (e.word_count || 0) / 80));
    },
  },
];

/** Stack lanes under the ruler; every lane keeps an 18px minimum height. */
export function computeLaneLayout(H, lanes = DAW_FAMILY_LANES, rulerH = 20) {
  const usable = H - rulerH;
  let y = rulerH;
  return lanes.map(lane => {
    const h = Math.max(18, Math.floor(usable * lane.portion));
    const r = { id: lane.id, y, h };
    y += h;
    return r;
  });
}

export function laneForEvent(ev, lanes = DAW_FAMILY_LANES) {
  return lanes.find(l => l.id === ev.family) || null;
}

/** Right-anchored time axis: x of an event on a live-scrolling canvas. */
export function evTimeX(ev, now, W, pxPerSec, scrollMs = 0) {
  return W - (now - ev.ts) / 1000 * pxPerSec + scrollMs / 1000 * pxPerSec;
}

/** Voices whose AudioContext start time `at` still covers `t` (plus a short hold). */
export function voicesSoundingAt(voices, t, holdSec = 0.08) {
  if (!voices || !voices.length) return [];
  return voices.filter(v => {
    const dur = Math.max(Number(v.dur) || 0, holdSec);
    return t >= v.at && t < v.at + dur;
  });
}

/** Session-relative clock for the DAW now-playing readout. */
export function fmtSessionT(relMs) {
  if (relMs == null || !Number.isFinite(relMs)) return '';
  const s = Math.max(0, relMs) / 1000;
  if (s < 60) return 't+' + s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  const r = Math.floor(s - m * 60);
  return 't+' + m + 'm' + String(r).padStart(2, '0') + 's';
}

/** Compact now-playing line for DAW header and Graph beat overlay. */
export function fmtSoundingLine(sounding, max = 3) {
  if (!sounding || !sounding.length) return '';
  const clock = fmtSessionT(sounding[0].relMs);
  const bits = sounding.slice(0, max).map(v => {
    const hz = v.hz ? Math.round(v.hz) + 'Hz' : '';
    const n  = v.clusterN > 1 ? '×' + v.clusterN : '';
    return [v.instrument + n, v.label || v.key, hz].filter(Boolean).join(' ');
  });
  return '▶ ' + (clock ? clock + '  ' : '') + bits.join(' · ');
}

/**
 * Playback policy for a simultaneous burst (one scheduler flush).
 *
 * Under MAX_POLYPHONY, unisons are spread into a scale chord so N harps
 * at C4 don't stack. Over the cap: keep a few high-salience voices
 * (write/error/words) and collapse the rest per family into one chord
 * (or a single percussion hit). Oscillator count never exceeds maxPoly.
 *
 * `ghosts` are originals with no oscillator — the DAW still draws them.
 */
export const VOICE_MAX_POLYPHONY = 4;
export const VOICE_MAX_CHORD = 3;

const VOICE_PRIORITY = {
  tool_error: 100, api_error: 100,
  write: 90, edit: 80,
  words: 70, human_turn: 70, agent: 65,
  bash_git: 55, bash_run: 50, bash_other: 45,
  read: 30, grep_glob: 28, other: 25,
  tokens: 12, thinking: 10, unknown: 8, permission: 8,
};

const PERC_VOICES = new Set(['snare', 'kick', 'hat']);

export function voicePriority(v) {
  const key = v?.sonic?.key || v?.key || '';
  const event = v?.meta?.event || v?.event || '';
  return VOICE_PRIORITY[key] ?? VOICE_PRIORITY[event] ?? 40;
}

function hzOf(v) { return Number(v.hz) || 261.6; }

function spreadChord(voices, intervals) {
  if (voices.length <= 1) return voices;
  const hzs = voices.map(hzOf);
  if (Math.max(...hzs) - Math.min(...hzs) >= 2) return voices;
  const root = hzs[0];
  const iv = intervals && intervals.length ? intervals : [0, 4, 7, 12];
  return voices.map((v, i) => ({
    ...v,
    hz: root * Math.pow(2, (iv[i % iv.length] || 0) / 12),
  }));
}

export function coalesceVoices(voices, opts = {}) {
  const maxPoly  = opts.maxPoly  ?? VOICE_MAX_POLYPHONY;
  const chordMax = opts.chordMax ?? VOICE_MAX_CHORD;
  const scale    = opts.scale    || [0, 4, 7, 12];

  if (!voices || !voices.length) return { audible: [], ghosts: [] };
  if (voices.length <= maxPoly) {
    return { audible: spreadChord(voices, scale), ghosts: [] };
  }

  const byFam = new Map();
  for (const v of voices) {
    const f = v.sonic?.fam || v.fam || 'other';
    if (!byFam.has(f)) byFam.set(f, []);
    byFam.get(f).push(v);
  }
  for (const g of byFam.values())
    g.sort((a, b) => voicePriority(b) - voicePriority(a));

  const fams = [...byFam.entries()]
    .sort((a, b) => voicePriority(b[1][0]) - voicePriority(a[1][0]));

  function want(group) {
    if (PERC_VOICES.has(group[0].name)) return 1;
    if (group.length === 1) return 1;
    return Math.min(chordMax, group.length);
  }

  const alloc = new Map(fams.map(([f]) => [f, 0]));
  let slots = maxPoly;
  while (slots > 0) {
    let gave = false;
    for (const [f, group] of fams) {
      if (alloc.get(f) < want(group) && slots > 0) {
        alloc.set(f, alloc.get(f) + 1);
        slots--;
        gave = true;
      }
    }
    if (!gave) break;
  }

  const audible = [];
  const ghosts  = [];
  for (const [f, group] of fams) {
    const n = group.length;
    const k = alloc.get(f);
    if (!k) { ghosts.push(...group); continue; }
    const boost = n > 1 ? 1 + 0.18 * Math.log2(n) : 1;
    if (PERC_VOICES.has(group[0].name) || n === 1) {
      audible.push({ ...group[0], vol: (group[0].vol ?? 0.42) * boost, clusterN: n > 1 ? n : undefined });
      ghosts.push(...group.slice(1));
      continue;
    }
    const rootHz = hzOf(group[0]);
    const vol = (group[0].vol ?? 0.42) * boost / Math.sqrt(k);
    for (let i = 0; i < k; i++) {
      audible.push({
        ...group[Math.min(i, n - 1)],
        hz: rootHz * Math.pow(2, (scale[i] || 0) / 12),
        vol,
        clusterN: n,
      });
    }
    ghosts.push(...group);
  }
  return { audible, ghosts };
}

/**
 * Context pressure: how full a session's context window is, from the latest
 * tokens pulse (input + cache_read ≈ current prompt context size).
 * @returns {number} 0..1
 */
export function contextPressure(inputTokens, cacheRead, windowTokens = 200_000) {
  const ctx = (inputTokens || 0) + (cacheRead || 0);
  return Math.max(0, Math.min(1, ctx / windowTokens));
}

/** Pressure fill tiers for Mission Control CSS (`mc-pressure__fill--*`). */
export const MC_PRESSURE_MID = 0.55;
export const MC_PRESSURE_HI = 0.85;

/** Pulse events that earn a dedicated `mc-card--evt-*` / `mc-act--*` class. */
export const MC_PULSE_EVENTS = new Set([
  'tool_call', 'tool_error', 'tokens', 'words', 'chirp', 'human_turn',
  'compact', 'thinking', 'attachment', 'scaffold', 'permission', 'mode_shift',
  'api_error',
]);

/**
 * Map a 0..1 context-pressure ratio to a CSS tier token.
 * @returns {'lo'|'mid'|'hi'|null}
 */
export function pressureTier(ratio) {
  if (ratio == null || typeof ratio !== 'number' || Number.isNaN(ratio)) return null;
  if (ratio >= MC_PRESSURE_HI) return 'hi';
  if (ratio >= MC_PRESSURE_MID) return 'mid';
  return 'lo';
}

function mcEvtToken(raw) {
  if (typeof raw !== 'string' || !MC_PULSE_EVENTS.has(raw)) return 'other';
  return raw;
}

/**
 * CSS class string for a Mission Control session card.
 *
 * Cognitive roles (one channel each — do not overload):
 * - left rail (`--active/--idle` + `--evt-*`) = lifecycle + latest pulse
 * - `--alert` = styles the error *line* only (never full-card border)
 * - `--open` / `--thinking-live` = disclosure / live cognition flags
 * Pressure tier lives only on `.mc-pressure__fill--*`, not on the card.
 *
 * @param {object} session — snapshot session from active-state
 * @param {{ expanded?: boolean, windowTokens?: number }} [opts]
 * @returns {string}
 */
export function sessionCardClasses(session, opts = {}) {
  const s = session || {};
  const parts = ['mc-card'];
  parts.push(s.status === 'idle' ? 'mc-card--idle' : 'mc-card--active');
  const evt = mcEvtToken(s.last_event);
  parts.push('mc-card--evt-' + evt);
  if (s.status === 'active' && s.last_event === 'thinking') parts.push('mc-card--thinking-live');
  if (sessionAlertText(s)) parts.push('mc-card--alert');
  if (opts.expanded) parts.push('mc-card--open');
  return parts.join(' ');
}

/**
 * Human triage line for session errors. Prefer last API message; else counts.
 * @returns {string|null}
 */
export function sessionAlertText(session) {
  const s = session || {};
  const msg = s.last_api_error?.message;
  if (msg) {
    const code = s.last_api_error.code;
    return '⊘ ' + msg + (code ? ' [' + code + ']' : '');
  }
  const bits = [];
  if ((s.tool_errors || 0) > 0) bits.push(s.tool_errors + ' tool err');
  if ((s.api_errors || 0) > 0) bits.push(s.api_errors + ' api err');
  return bits.length ? '⊘ ' + bits.join(' · ') : null;
}

/**
 * Split metrics into primary scan row vs secondary cognition counts.
 * `ago` is a placeholder slot — caller fills the formatted age.
 * @returns {{ primary: object[], secondary: object[] }}
 */
export function sessionMetricSplit(session) {
  const s = session || {};
  const primary = [];
  primary.push({ key: 'tools', label: 'tools', value: s.tool_calls || 0 });
  if ((s.tool_errors || 0) > 0) {
    primary.push({ key: 'tool_errors', label: 'err', value: s.tool_errors, err: true });
  }
  if ((s.api_errors || 0) > 0) {
    primary.push({ key: 'api_errors', label: 'api', value: s.api_errors, err: true });
  }
  primary.push({ key: 'tokens', label: 'tok', value: s.tokens_work || 0, fmt: 'tok' });
  if (s.burn_rate_per_min) {
    primary.push({ key: 'burn', label: '/min', value: s.burn_rate_per_min, fmt: 'tok', burn: true });
  }
  primary.push({ key: 'human', label: '⌨', value: s.human_turns || 0 });
  primary.push({ key: 'ago', label: 'ago', value: null, ago: true });

  const secondary = [];
  if (s.compacts) secondary.push({ key: 'compacts', label: '⟲', value: s.compacts });
  if (s.thinking_count) secondary.push({ key: 'thinking', label: '◉', value: s.thinking_count });
  if (s.attachments) secondary.push({ key: 'attachments', label: '▣', value: s.attachments });
  if (s.scaffolds) secondary.push({ key: 'scaffolds', label: '⬚', value: s.scaffolds });
  return { primary, secondary };
}

/** Short labels for recency hero (mapping vernacular: cells, not prose). */
export const MC_EVENT_LABELS = {
  tool_call: 'tool',
  tool_error: 'tool err',
  tokens: 'tokens',
  words: 'words',
  chirp: 'chirp',
  human_turn: 'human',
  compact: 'compact',
  thinking: 'thinking',
  attachment: 'attach',
  scaffold: 'scaffold',
  permission: 'perm',
  mode_shift: 'mode',
  api_error: 'api err',
  other: 'other',
};

/**
 * Recency hero model — most recent pulse is the card headline.
 * For tool_call, label is the Canonical Action Key; detail is file basename or why.
 * @returns {{ status, mark, event, label, detail }}
 */
export function sessionRecencyHero(session) {
  const s = session || {};
  const status = s.status === 'idle' ? 'idle' : 'active';
  const event = mcEvtToken(s.last_event);
  let label = MC_EVENT_LABELS[event] || 'other';
  let detail = null;
  if (s.last_event === 'tool_call' && s.last_tool) {
    label = s.last_tool.key || s.last_tool.tool || 'tool';
    if (s.last_tool.where) {
      detail = String(s.last_tool.where).replace(/\\/g, '/').split('/').pop() || null;
    } else if (s.last_tool.why) {
      detail = String(s.last_tool.why).trim().slice(0, 48) || null;
    }
  }
  return {
    status,
    mark: status === 'active' ? '●' : '○',
    event,
    label,
    detail,
  };
}

/**
 * Mapping-style tool-key chips from live `tools_by_key` histogram.
 * Hottest keys first; capped for card density.
 * @returns {{ key: string, count: number, cls: string }[]}
 */
export function sessionToolChips(session, opts = {}) {
  const max = opts.max ?? 6;
  const by = session?.tools_by_key || {};
  return Object.entries(by)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([key, count]) => ({
      key,
      count,
      cls: 'mc-chip mc-chip--' + key,
    }));
}

/** Card reorder/enter motion budget (Register A: ≤250ms). */
export const MC_CARD_MOVE_MS = 200;

/**
 * Snapshot `.mc-card[data-sid]` geometry for FLIP.
 * @param {ParentNode|null|undefined} root
 * @returns {Map<string, { left: number, top: number, width: number, height: number }>}
 */
export function captureMcCardRects(root) {
  const map = new Map();
  if (!root || typeof root.querySelectorAll !== 'function') return map;
  for (const el of root.querySelectorAll('.mc-card[data-sid]')) {
    const sid = el.getAttribute('data-sid');
    if (!sid) continue;
    const r = el.getBoundingClientRect();
    map.set(sid, { left: r.left, top: r.top, width: r.width, height: r.height });
  }
  return map;
}

/**
 * FLIP plan: invert deltas for movers; `enter: true` for brand-new sids.
 * @param {Map<string, {left:number,top:number}>} prevRects
 * @param {Map<string, {left:number,top:number}>} nextRects
 * @returns {{ sid: string, dx: number, dy: number, enter: boolean }[]}
 */
export function mcCardFlipPlan(prevRects, nextRects) {
  const prev = prevRects instanceof Map ? prevRects : new Map();
  const next = nextRects instanceof Map ? nextRects : new Map();
  const plan = [];
  for (const [sid, n] of next) {
    const p = prev.get(sid);
    if (!p) {
      plan.push({ sid, dx: 0, dy: 0, enter: true });
      continue;
    }
    const dx = p.left - n.left;
    const dy = p.top - n.top;
    if (dx !== 0 || dy !== 0) plan.push({ sid, dx, dy, enter: false });
  }
  return plan;
}

/** Gate motion on visual order changes (id+status); ignore ago-only ticks. */
export function mcCardOrderKey(sessions) {
  if (!Array.isArray(sessions) || !sessions.length) return '';
  return sessions.map(s => `${s?.session_id || ''}:${s?.status || ''}`).join('|');
}

/**
 * CSS class string for one recent_actions ring row.
 * @param {{ type?: string, error?: boolean }|null} action
 * @returns {string}
 */
export function actionItemClasses(action) {
  const parts = ['mc-act'];
  parts.push('mc-act--' + mcEvtToken(action?.type));
  if (action?.error) parts.push('mc-act--err');
  return parts.join(' ');
}

/** Classes for the pressure meter fill element. */
export function pressureFillClasses(tier) {
  const parts = ['mc-pressure__fill'];
  if (tier === 'lo' || tier === 'mid' || tier === 'hi') parts.push('mc-pressure__fill--' + tier);
  return parts.join(' ');
}

/** Classes for one ContextTree strip segment. */
export function ctxSegClasses(seg) {
  const parts = ['mc-ctxseg'];
  if (seg?.isCurrent) parts.push('mc-ctxseg--cur');
  return parts.join(' ');
}

/**
 * Mission Control legend model — pulse + state grammar for the /now strip.
 * `mod` matches `mc-card--{mod}` / pressure tier / flag suffixes; `swatch` is a
 * Register A token key (`geo`|`dim`|`accent`|`select`|`data`|`err`|`label`).
 * @returns {{ status: object[], events: object[], pressure: object[], flags: object[] }}
 */
export function missionControlLegend() {
  return {
    status: [
      { mod: 'active', label: 'active', swatch: 'geo' },
      { mod: 'idle',   label: 'idle',   swatch: 'dim' },
    ],
    events: [
      { mod: 'tool_call',   label: 'tool',      swatch: 'accent' },
      { mod: 'human_turn',  label: 'human',     swatch: 'label' },
      { mod: 'thinking',    label: 'thinking',  swatch: 'select' },
      { mod: 'tokens',      label: 'tokens',    swatch: 'data' },
      { mod: 'words',       label: 'words',     swatch: 'data' },
      { mod: 'chirp',       label: 'chirp',     swatch: 'data' },
      { mod: 'compact',     label: 'compact',   swatch: 'data' },
      { mod: 'permission',  label: 'perm',      swatch: 'dim' },
      { mod: 'mode_shift',  label: 'mode',      swatch: 'dim' },
      { mod: 'attachment',  label: 'attach',    swatch: 'dim' },
      { mod: 'scaffold',    label: 'scaffold',  swatch: 'dim' },
      { mod: 'tool_error',  label: 'tool err',  swatch: 'err' },
      { mod: 'api_error',   label: 'api err',   swatch: 'err' },
    ],
    pressure: [
      { mod: 'lo',  label: 'ctx lo',  swatch: 'geo' },
      { mod: 'mid', label: 'ctx mid', swatch: 'select' },
      { mod: 'hi',  label: 'ctx hi',  swatch: 'err' },
    ],
    flags: [
      { mod: 'alert',         label: 'errors',        swatch: 'err' },
      { mod: 'thinking-live', label: 'thinking live', swatch: 'select' },
      { mod: 'flow',          label: 'flow=actions',  swatch: 'accent' },
    ],
    tools: [
      { mod: 'read',      label: 'read',  swatch: 'select' },
      { mod: 'write',     label: 'write', swatch: 'accent' },
      { mod: 'edit',      label: 'edit',  swatch: 'accent' },
      { mod: 'bash_run',  label: 'bash',  swatch: 'geo' },
      { mod: 'grep_glob', label: 'grep',  swatch: 'label' },
      { mod: 'agent',     label: 'agent', swatch: 'data' },
    ],
  };
}

/** Motion gate for FLIP/enter — honor prefers-reduced-motion. */
export function mcMotionAllowed(media = null) {
  if (media && typeof media.matches === 'boolean') return !media.matches;
  return true;
}

/**
 * Board filter: hide idles (pins survive), honor dismissed until session goes active.
 * @param {object[]} sessions
 * @param {{ hideIdles?: boolean, pinned?: Set<string>|string[], dismissed?: Set<string>|string[] }} [opts]
 */
export function filterMissionSessions(sessions, opts = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const hideIdles = !!opts.hideIdles;
  const pinned = opts.pinned instanceof Set ? opts.pinned : new Set(opts.pinned || []);
  const dismissed = opts.dismissed instanceof Set ? opts.dismissed : new Set(opts.dismissed || []);
  return list.filter(s => {
    if (!s || !s.session_id) return false;
    if (dismissed.has(s.session_id) && s.status !== 'active') return false;
    if (hideIdles && s.status === 'idle' && !pinned.has(s.session_id)) return false;
    return true;
  });
}

/** Idle session ids eligible for Clear (not pinned). */
export function idleIdsToClear(sessions, pinned = new Set()) {
  const pin = pinned instanceof Set ? pinned : new Set(pinned || []);
  return (sessions || [])
    .filter(s => s && s.status === 'idle' && s.session_id && !pin.has(s.session_id))
    .map(s => s.session_id);
}

const MC_FLOW_GLYPH = {
  tool_call: '▸', tool_error: '✖', compact: '⟲', human_turn: '⌨',
  permission: '⚙', mode_shift: '⚙', api_error: '⊘',
  attachment: '▣', scaffold: '⬚', words: '◇', chirp: '·', tokens: '◈',
};

/**
 * Last N recent_actions as a live work-flow strip (glyphs, not a mechanical grid).
 * @returns {{ type: string, glyph: string, cls: string, key: string|null }[]}
 */
export function sessionPulseFlow(actions, max = 10) {
  const list = Array.isArray(actions) ? actions : [];
  const n = Math.max(0, max | 0);
  return list.slice(-n).map(a => {
    const type = a?.type || 'other';
    const err = !!(a?.error || type === 'tool_error' || type === 'api_error');
    return {
      type,
      glyph: MC_FLOW_GLYPH[type] || '·',
      key: a?.key || null,
      cls: 'mc-flow__beat mc-flow__beat--' + mcEvtToken(type) + (err ? ' mc-flow__beat--err' : ''),
    };
  });
}

/**
 * Group sessions into harness lanes (breaks the flat card wall).
 * Within each lane: active first, then last_seen desc.
 * @param {object[]} sessions
 * @param {string[]} [harnessOrder] — preferred lane order (unknowns append alphabetically)
 * @returns {{ harness: string, sessions: object[] }[]}
 */
export function groupSessionsByHarness(sessions, harnessOrder = []) {
  const list = Array.isArray(sessions) ? sessions : [];
  const buckets = new Map();
  for (const s of list) {
    if (!s) continue;
    const h = s.harness || 'unknown';
    if (!buckets.has(h)) buckets.set(h, []);
    buckets.get(h).push(s);
  }
  for (const arr of buckets.values()) {
    arr.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      return (b.last_seen || 0) - (a.last_seen || 0);
    });
  }
  const order = Array.isArray(harnessOrder) ? harnessOrder.filter(h => buckets.has(h)) : [];
  const rest = [...buckets.keys()].filter(h => !order.includes(h)).sort();
  return [...order, ...rest].map(harness => ({
    harness,
    sessions: buckets.get(harness) || [],
  }));
}

/**
 * Distinct sessions seen in the beat ring, newest first, each with its latest
 * context pressure (null until a tokens pulse has been seen).
 * @param {object[]} ring — beat-ring entries (ts ascending)
 * @param {number} [max] — legend size cap
 */
export function sessionLegend(ring, max = 6, windowTokens = 200_000) {
  const bySlug = new Map(); // slug → entry (insertion order = recency, newest first)
  for (let i = ring.length - 1; i >= 0; i--) {
    const ev = ring[i];
    if (!ev.slug) continue;
    let entry = bySlug.get(ev.slug);
    if (!entry) {
      if (bySlug.size >= max) continue; // newer sessions already filled the legend
      entry = { slug: ev.slug, project: ev.project || null, color: ev.color || null,
                pressure: null, lastTs: ev.ts };
      bySlug.set(ev.slug, entry);
    }
    if (entry.pressure === null && ev.type === 'tokens') {
      entry.pressure = contextPressure(ev.input, ev.cache_read, windowTokens);
    }
  }
  return [...bySlug.values()];
}

// ── Live SSE subscribe (Graph / DAW → playPulse) ──────────────────────────────
// tool_call / tokens / words have their own listeners (custom ticker lines).
// Cognition events share one loop. unknown / silent / tool_result stay wire-only.

export const LIVE_COGNITION_EVENTS = [
  'human_turn', 'compact', 'permission', 'mode_shift',
  'tool_error', 'api_error', 'chirp', 'attachment', 'scaffold',
  'thinking',
];

export const LIVE_PLAYPULSE_EVENTS = [
  'tool_call', 'tokens', 'words',
  ...LIVE_COGNITION_EVENTS,
];

// ── Cognition pulse vocabulary (ticker / overlays) ────────────────────────────

export const PULSE_GLYPHS = {
  human_turn: '⌨', compact: '⟲', permission: '⚙', mode_shift: '⚙',
  tool_error: '✖', api_error: '⊘', attachment: '⊕', scaffold: '▤',
};

/**
 * Ticker line for a cognition pulse. Returns { text, role } or null when the
 * event should stay out of the ticker (chirps, thinking — too chatty).
 * Roles: 'err' | 'human' | 'context' | 'dim' (consumer maps role → color).
 */
export function pulseTickerEntry(event, data = {}) {
  const g = PULSE_GLYPHS[event];
  const tag = data.slug ? '  [' + data.slug + ']' : '';
  switch (event) {
    case 'human_turn':
      return { text: g + ' "' + String(data.text || 'prompt').slice(0, 48) + '"' + tag, role: 'human' };
    case 'compact':
      return { text: g + ' context compacted' + tag, role: 'context' };
    case 'permission':
      return { text: g + ' perm → ' + (data.mode || '?') + tag, role: 'dim' };
    case 'mode_shift':
      return { text: g + ' mode → ' + (data.mode || '?') + tag, role: 'dim' };
    case 'tool_error':
      return { text: g + ' ' + (data.tool || 'tool') + ' failed' + tag, role: 'err' };
    case 'api_error':
      return { text: g + ' ' + (data.message || 'api error') + (data.code ? ' [' + data.code + ']' : '') + tag, role: 'err' };
    default:
      return null;
  }
}

// ── History-view filters ──────────────────────────────────────────────────────

/**
 * Does a session node pass the active filters?
 * @param {{ harness?: string, project_id?: string, date_str?: string }} node
 * @param {{ from?: string|null, to?: string|null,
 *           harnesses?: Set<string>|null, projects?: Set<string>|null }} [f]
 *   — from/to are inclusive YYYY-MM-DD bounds; empty/null sets mean
 *   "no constraint"; undated sessions are never date-filtered.
 */
export function sessionMatchesFilters(node, f = {}) {
  if (node.date_str) {
    if (f.from && node.date_str < f.from) return false;
    if (f.to   && node.date_str > f.to)   return false;
  }
  if (f.harnesses?.size && !f.harnesses.has(node.harness))   return false;
  if (f.projects?.size  && !f.projects.has(node.project_id)) return false;
  return true;
}

/**
 * Node ids hidden by the bundle (cluster) mechanism. Members of collapsed
 * clusters hide behind their cluster node; a cluster with no filter-passing
 * members hides itself. Filter-based hiding of individual sessions stays the
 * caller's job — this helper only adds the cluster dimension.
 */
export function computeClusterHidden(nodes, { bundleOn = true, expanded = new Set(), filters = {} } = {}) {
  const hidden = new Set();
  const byId = {};
  for (const n of nodes) byId[n.id] = n;
  for (const n of nodes) {
    if (n.type !== 'cluster') continue;
    if (!bundleOn) { hidden.add(n.id); continue; }
    const anyPassing = (n.member_ids || []).some(id =>
      byId[id] && sessionMatchesFilters(byId[id], filters));
    if (!anyPassing) { hidden.add(n.id); continue; }
    if (!expanded.has(n.id))
      for (const id of n.member_ids) hidden.add(id);
  }
  return hidden;
}

// ── Force layout profiles ─────────────────────────────────────────────────────

/**
 * Anchored (default): projects pinned on their ring, strong membership pull —
 * the project-centric overview. Free: projects unpin and let go, sessions and
 * files cluster purely by co-access (post-filter exploration mode).
 * @param {boolean} free
 */
export function forceProfile(free) {
  if (free) return {
    projectPinned:      false,
    membershipStrength: 0.05,
    projectCharge:      -200,
    grouping:           false,  // overrides the cluster-by-project checkbox
    center:             true,
  };
  return {
    projectPinned:      true,
    membershipStrength: 0.65,
    projectCharge:      -700,
    grouping:           null,   // honor the cluster-by-project checkbox
    center:             false,
  };
}

/**
 * Landing handshake queue. `firstDelay` holds on a cursor before line one
 * (first-boot pause). Later lines wait `minGap`. `onReveal` fires when
 * that line is shown.
 */
export function createBootQueue(opts = {}) {
  const minGap = opts.minGap ?? 180;
  const firstDelay = opts.firstDelay ?? 0;
  const delay = opts.delay || ((fn, ms) => setTimeout(fn, ms));
  const shown = [];
  const queue = [];
  let timer = null;
  function flush() {
    timer = null;
    if (!queue.length) return;
    const item = queue.shift();
    shown.push(item.html);
    if (opts.onShow) opts.onShow(shown.slice());
    if (typeof item.onReveal === 'function') item.onReveal();
    if (queue.length) timer = delay(flush, minGap);
  }
  function arm() {
    if (timer) return;
    const wait = shown.length === 0 ? firstDelay : minGap;
    if (wait <= 0) flush();
    else timer = delay(flush, wait);
  }
  return {
    push(html, onReveal) {
      queue.push({ html, onReveal });
      arm();
    },
    shown: () => shown.slice(),
  };
}

// ── SSE wiring (one EventSource pattern for every page) ───────────────────────

/**
 * @param {object}   opts
 * @param {string}   [opts.url='/events']
 * @param {Object<string, (data: any, rawEvent: MessageEvent) => void>} opts.handlers
 *   — data is JSON.parse(e.data) when parseable, else null (read rawEvent.data)
 * @param {(state: 'open'|'reconnecting') => void} [opts.onStatus]
 * @param {typeof EventSource} [ES] — injectable for tests
 * @returns {EventSource}
 */
export function connectEvents(opts, ES) {
  const Ctor = ES || EventSource;
  const es = new Ctor(opts.url || '/events');
  for (const [event, fn] of Object.entries(opts.handlers || {})) {
    es.addEventListener(event, e => {
      let data = null;
      try { data = JSON.parse(e.data); } catch { /* non-JSON event payload */ }
      try { fn(data, e); } catch (err) { console.error('[connectEvents] handler for "' + event + '" threw', err); }
    });
  }
  if (opts.onStatus) {
    es.onopen  = () => opts.onStatus('open');
    es.onerror = () => opts.onStatus('reconnecting');
  }
  return es;
}

/**
 * fetch() with one retry after a short delay. Covers the transient
 * connection-reset a burst of simultaneous requests can trigger at page
 * load (observed on Windows/Firefox — Chrome silently retries these,
 * Firefox surfaces them as an immediate rejected fetch).
 * @param {string} url
 * @param {object}   [opts]
 * @param {number}   [opts.retryDelay=400]
 * @param {typeof fetch} [opts.fetchImpl] — injectable for tests
 * @param {(fn: () => void, ms: number) => void} [opts.delay] — injectable for tests
 * @returns {Promise<Response>}
 */
export function fetchRetry(url, opts = {}) {
  const retryDelay = opts.retryDelay ?? 400;
  const fetchImpl = opts.fetchImpl || fetch;
  const delay = opts.delay || ((fn, ms) => setTimeout(fn, ms));
  return fetchImpl(url).catch(() => new Promise((resolve, reject) => {
    delay(() => fetchImpl(url).then(resolve, reject), retryDelay);
  }));
}

// ── Layout controls (declarative show/hide) ───────────────────────────────────

/**
 * @param {Object<string, { controls?: string[] }>} layoutHandlers
 * @param {string} active — current layout name
 * @returns {Object<string, boolean>} element id → should be visible
 */
export function resolveControlVisibility(layoutHandlers, active) {
  const vis = {};
  for (const h of Object.values(layoutHandlers)) {
    for (const id of (h.controls || [])) vis[id] = false;
  }
  for (const id of (layoutHandlers[active]?.controls || [])) vis[id] = true;
  return vis;
}

/** Collapse chrome unless every widget is already collapsed (then expand). */
export function nextChromeCollapsed(states) {
  const list = states || [];
  if (!list.length) return true;
  return !list.every(Boolean);
}

const LAYOUT_RESET_PROMPT = 'Reset layout options to defaults? Are you sure?';

/** Are-you-sure gate for restoring DISPLAY / physics / camera defaults. */
export function confirmLayoutReset(ask) {
  const fn = ask || (typeof confirm === 'function' ? confirm : () => false);
  return !!fn(LAYOUT_RESET_PROMPT);
}

// ── Share card (session summary → shareable 1200×630 SVG) ────────────────────
// A per-session "receipt": one panel button generates a PNG a user can share
// or download. Register A colors mirror experience/design-tokens.mjs verbatim
// (this file has no import graph — it's injected as plain script — so the
// palette is duplicated here rather than imported).

const SHARE_CARD_TOKENS = {
  bg: '#000000', panel: '#080800', card: '#101008', border: '#1e1e00',
  accent: '#ff6600', label: '#ffaa00', data: '#e8e000', select: '#00cccc',
  geo: '#00ff88', dim: '#445544', body: '#ccccaa', err: '#ff5555',
};

function _shareTrunc(s, max) {
  const str = String(s || '');
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/**
 * Highest-count [name, count] entry from a tool_summary object, or null.
 * The single "which tool dominated this window" rule — shared by the share
 * card's context strip and the panel's context-window strips
 * (experience/client/17-trace-panel.js `_domTool`) so the two can't drift.
 */
export function dominantTool(toolSummary) {
  if (!toolSummary) return null;
  const entries = Object.entries(toolSummary);
  return entries.length ? entries.sort((a, b) => b[1] - a[1])[0] : null;
}

/** Minimum strip width % — matches proportional-strip skill / graph panel (5%). */
export const MIN_STRIP_PCT = 5;

/**
 * Reduce /api/trace segments into card-ready strips: proportional width by
 * token weight, colored by each window's dominant tool (same idea as the
 * panel's context-window strips, kept independent since this feeds a fixed
 * pixel layout rather than a flex row).
 *
 * Extra fields (`index`, `isCurrent`, `badges`) are for Mission Control /
 * panel consumers; share-card SVG may ignore them.
 */
export function contextStripSegments(segments, fallbackColor) {
  const segs = segments || [];
  if (!segs.length) return [];
  const totalTok = segs.reduce((s, g) => s + (g.tokens?.output || 0) + (g.tokens?.cache_read || 0), 0) || 1;
  return segs.map((seg, index) => {
    const tok = (seg.tokens?.output || 0) + (seg.tokens?.cache_read || 0);
    const top = dominantTool(seg.tool_summary);
    const branches = Array.isArray(seg.branches) ? seg.branches.length : 0;
    return {
      pct:  Math.max(MIN_STRIP_PCT, tok / totalTok * 100),
      tok,
      tool: top ? top[0] : null,
      color: (top && TOOL_COLORS[top[0]]) || fallbackColor || SHARE_CARD_TOKENS.dim,
      turns: (seg.user_turns || 0) + (seg.assistant_turns || 0),
      index,
      isCurrent: seg.compact_trigger == null,
      badges: {
        subagents: seg.subagent_count || 0,
        thinking: seg.thinking_count || 0,
        branches,
      },
    };
  });
}

// Shared 1200×630 chrome (header/divider/footer/stat column) so the three
// card kinds (session / project / full-canvas) don't triplicate layout math.
function _shareGeom() {
  const width = 1200, height = 630;
  const headerH = 80, footerH = 70;
  const bodyTop = headerH, bodyBot = height - footerH;
  const dividerX = 660, leftPad = 55, rightPad = dividerX + 40;
  return { width, height, headerH, footerH, bodyTop, bodyBot, dividerX, leftPad, rightPad };
}

function _shareHeader(g, { kicker, dateRight, subRight }) {
  const c = SHARE_CARD_TOKENS;
  return `<rect width="${g.width}" height="${g.headerH}" fill="${c.panel}"/>
  <line x1="0" y1="${g.headerH}" x2="${g.width}" y2="${g.headerH}" stroke="${c.border}" stroke-width="1"/>
  <text x="${g.leftPad}" y="34" style="font-size:20px;font-weight:bold;fill:${c.accent};letter-spacing:3px;">KAAROSESSIONS</text>
  <text x="${g.leftPad}" y="58" style="font-size:9px;fill:${c.dim};letter-spacing:2px;">${esc(kicker || '')}</text>
  <text x="${g.width - g.leftPad}" y="34" style="font-size:12px;fill:${c.dim};text-anchor:end;">${esc(dateRight || '')}</text>
  <text x="${g.width - g.leftPad}" y="58" style="font-size:12px;fill:${c.label};text-anchor:end;">${esc(subRight || '')}</text>`;
}

function _shareDivider(g) {
  return `<line x1="${g.dividerX}" y1="${g.bodyTop + 16}" x2="${g.dividerX}" y2="${g.bodyBot - 16}" stroke="${SHARE_CARD_TOKENS.border}" stroke-width="1" stroke-dasharray="4,4"/>`;
}

function _shareFooter(g, { tagLine, footerRightLabel }) {
  const c = SHARE_CARD_TOKENS;
  return `<line x1="0" y1="${g.bodyBot}" x2="${g.width}" y2="${g.bodyBot}" stroke="${c.border}" stroke-width="1"/>
  <rect y="${g.bodyBot}" width="${g.width}" height="${g.footerH}" fill="${c.panel}"/>
  <text x="${g.leftPad}" y="${g.bodyBot + 26}" style="font-size:11px;fill:${c.select};letter-spacing:0.5px;">${esc(tagLine || 'KAAROSESSIONS')}</text>
  <text x="${g.leftPad}" y="${g.bodyBot + 48}" style="font-size:10px;fill:${c.dim};">an observability surface for coding agents</text>
  <text x="${g.width - g.leftPad}" y="${g.bodyBot + 40}" style="font-size:14px;font-weight:bold;fill:${c.accent};text-anchor:end;letter-spacing:1px;">${esc(footerRightLabel || '◆ KAAROSESSIONS')}</text>`;
}

/** Right-column label/value stat rows, 50px apart, starting under the header (or `startY`). */
function _shareStatRows(stats, g, startY) {
  const c = SHARE_CARD_TOKENS;
  const y0 = startY != null ? startY : g.bodyTop + 44;
  return stats.map(([label, val], i) => {
    const sy = y0 + i * 50;
    return `<text x="${g.rightPad}" y="${sy}" style="font-size:9px;fill:${c.dim};letter-spacing:2px;">${esc(label)}</text>` +
      `<text x="${g.rightPad}" y="${sy + 22}" style="font-size:20px;font-weight:bold;fill:${c.data};">${esc(val)}</text>`;
  }).join('');
}

/**
 * Single assembler — preview, share, and download all build the card from
 * this. `node` is a graph session node (see experience/graph-pipeline.mjs);
 * `opts.traceSegments` is the raw segments array from /api/trace, when
 * available (the card renders fine without it — one placeholder strip).
 */
export function buildShareCardData(node, opts = {}) {
  const d = node || {};
  return {
    kind: 'session',
    sessionLabel:   d.ai_title || d.label || 'session',
    harness:        d.harness || d.source || 'claude-code',
    project:        opts.projectLabel || d.project_id || '',
    date:           d.date_str || '',
    duration_min:   d.duration_min ?? null,
    model:          d.model || null,
    tokens_total:   d.tokens_total || 0,
    tokens_work:    d.tokens_work || 0,
    cache_hit_rate: d.cache_hit_rate || 0,
    tool_calls:     d.tool_calls || 0,
    tool_errors:    d.tool_errors || 0,
    tool_diversity: d.tool_diversity || 0,
    subagent_count: d.subagent_count || 0,
    context_resets: d.context_resets || 0,
    segments:       contextStripSegments(opts.traceSegments, d.color),
    skills:         d.skills || [],
    color:          d.color || SHARE_CARD_TOKENS.accent,
  };
}

export function generateShareCardSVG(data) {
  const c = SHARE_CARD_TOKENS;
  const g = _shareGeom();

  const stripBoxX = g.leftPad;
  const stripBoxY = g.bodyTop + 90;
  const stripBoxW = g.dividerX - g.leftPad - 30;
  const stripBoxH = 34;

  const segs = data.segments && data.segments.length
    ? data.segments
    : [{ pct: 100, tok: data.tokens_work, tool: null, color: data.color }];
  const totalPct = segs.reduce((s, seg) => s + seg.pct, 0) || 1;
  let x = 0;
  const stripRects = segs.map(seg => {
    const w = seg.pct / totalPct * stripBoxW;
    const rect = `<rect x="${(stripBoxX + x).toFixed(1)}" y="${stripBoxY}" width="${Math.max(1, w - 2).toFixed(1)}" height="${stripBoxH}" fill="${seg.color}" opacity="0.8"><title>${esc(seg.tool || 'window')} · ${fmtTok(seg.tok)} tok</title></rect>`;
    x += w;
    return rect;
  }).join('');

  const windowCount = (data.context_resets || 0) + 1;

  const stats = [
    ['CONSUMPTION', fmtTok(data.tokens_total)],
    ['AI WORK',     fmtTok(data.tokens_work)],
    ['CACHE HIT',   data.cache_hit_rate + '%'],
    ['TOOL CALLS',  String(data.tool_calls)],
    ['ERRORS',      String(data.tool_errors)],
    ['SUBAGENTS',   String(data.subagent_count)],
  ];

  // Raw (unescaped) — _shareFooter is the single escaping point for tagLine.
  const skillTags = (data.skills || []).slice(0, 4).map(s => '/' + s).join('  ');

  return `<svg width="${g.width}" height="${g.height}" xmlns="http://www.w3.org/2000/svg">
  <defs><style>text { font-family: 'IBM Plex Mono', 'Courier New', monospace; }</style></defs>
  <rect width="${g.width}" height="${g.height}" fill="${c.bg}"/>
  ${_shareHeader(g, { kicker: `SESSION CARD · ${(data.harness || '').toUpperCase()}`, dateRight: data.date, subRight: data.project })}
  ${_shareDivider(g)}

  <!-- LEFT: title + context strip -->
  <text x="${g.leftPad}" y="${g.bodyTop + 46}" style="font-size:22px;fill:${c.body};letter-spacing:0.3px;">${esc(_shareTrunc(data.sessionLabel, 46))}</text>
  <text x="${g.leftPad}" y="${g.bodyTop + 68}" style="font-size:9px;fill:${c.dim};letter-spacing:1.5px;">◆ CONTEXT WINDOWS (${windowCount})</text>
  <rect x="${stripBoxX}" y="${stripBoxY}" width="${stripBoxW}" height="${stripBoxH}" fill="${c.card}" stroke="${c.border}" stroke-width="1"/>
  ${stripRects}
  ${data.duration_min != null ? `<text x="${g.leftPad}" y="${stripBoxY + stripBoxH + 24}" style="font-size:11px;fill:${c.dim};">${data.duration_min} min · ${data.tool_diversity} tool types</text>` : ''}

  ${_shareStatRows(stats, g)}
  ${_shareFooter(g, { tagLine: skillTags || 'AI CODING SESSION' })}
</svg>`.trim();
}

/**
 * Project card assembler. `node` is a graph project node; `opts.harnessRows`
 * is the per-harness session-count breakdown (see harnessBreakdown()) — the
 * caller already has the project's session list from neighbours(node.id).
 */
export function buildProjectShareCardData(node, opts = {}) {
  const d = node || {};
  return {
    kind: 'project',
    label:         d.label || d.id || 'project',
    session_count: d.session_count || 0,
    tokens_total:  d.tokens_total || 0,
    tokens_work:   d.tokens_work || 0,
    skills:        d.skills || [],
    harnessRows:   opts.harnessRows || [],
    last_activity: d.last_activity || null,
    color:         d.color || SHARE_CARD_TOKENS.accent,
  };
}

export function generateProjectShareCardSVG(data) {
  const c = SHARE_CARD_TOKENS;
  const g = _shareGeom();

  const rows = data.harnessRows.length
    ? data.harnessRows
    : [{ harness: 'unknown', count: data.session_count, color: data.color }];
  const maxCount = Math.max(1, ...rows.map(r => r.count));
  const barX = g.leftPad, barW = g.dividerX - g.leftPad - 30;
  const barRows = rows.map((r, i) => {
    const y = g.bodyTop + 96 + i * 32;
    const w = Math.max(2, r.count / maxCount * barW);
    return `<text x="${barX}" y="${y - 6}" style="font-size:10px;fill:${c.dim};letter-spacing:1px;">${esc(r.harness)} · ${r.count}</text>` +
      `<rect x="${barX}" y="${y}" width="${barW}" height="8" fill="${c.card}" stroke="${c.border}"/>` +
      `<rect x="${barX}" y="${y}" width="${w}" height="8" fill="${r.color || data.color}"/>`;
  }).join('');

  const stats = [
    ['SESSIONS',    String(data.session_count)],
    ['CONSUMPTION', fmtTok(data.tokens_total)],
    ['AI WORK',     fmtTok(data.tokens_work)],
    ['HARNESSES',   String(rows.length)],
  ];

  // Raw (unescaped) — _shareFooter is the single escaping point for tagLine.
  const skillTags = (data.skills || []).slice(0, 4).map(s => '/' + s).join('  ');

  return `<svg width="${g.width}" height="${g.height}" xmlns="http://www.w3.org/2000/svg">
  <defs><style>text { font-family: 'IBM Plex Mono', 'Courier New', monospace; }</style></defs>
  <rect width="${g.width}" height="${g.height}" fill="${c.bg}"/>
  ${_shareHeader(g, { kicker: 'PROJECT CARD', dateRight: data.last_activity ? String(data.last_activity).slice(0, 10) : '' })}
  ${_shareDivider(g)}

  <text x="${g.leftPad}" y="${g.bodyTop + 46}" style="font-size:24px;font-weight:bold;fill:${data.color};letter-spacing:0.3px;">${esc(_shareTrunc(data.label, 40))}</text>
  <text x="${g.leftPad}" y="${g.bodyTop + 68}" style="font-size:9px;fill:${c.dim};letter-spacing:1.5px;">◆ HARNESS BREAKDOWN</text>
  ${barRows}

  ${_shareStatRows(stats, g)}
  ${_shareFooter(g, { tagLine: skillTags || 'PROJECT SUMMARY' })}
</svg>`.trim();
}

/**
 * Full-canvas ("ME") card assembler — "Project & Session Constellation":
 * the left field layers two marks — a hex per project (foreground landmark,
 * wedge-filled by harness) over a ball per session (background texture,
 * colored by its project) — so both the project *and* the individual-session
 * count read as the intelligence report, not one traded off for the other.
 * The ME glyph is the hero, big and vertically centered in the right column.
 *
 * `me` is the output of meGlyph(sessions); `opts.projects` / `opts.sessions`
 * are the raw graph project/session-node arrays (see
 * experience/graph-pipeline.mjs); sessions rank by their project's
 * consumption so a project's balls cluster near its own hex; `opts` also
 * supplies the cross-project numbers meGlyph doesn't carry (project count,
 * total tokens, date range).
 */
export function buildUsageShareCardData(me, opts = {}) {
  const projects = (opts.projects || [])
    .slice()
    .sort((a, b) => (b.tokens_total || 0) - (a.tokens_total || 0))
    .map(p => ({
      id: p.id, label: p.label || p.id || 'project', color: p.color || SHARE_CARD_TOKENS.dim,
      harnesses: p.harnesses || [], recencyLevel: p.recencyLevel || 0, inFlight: !!p.inFlight,
      sizeNorm: p.sizeNorm || 0, session_count: p.session_count || 0, tokens_total: p.tokens_total || 0,
    }));
  const projRank = new Map(projects.map((p, i) => [p.id, i]));

  const sessions = (opts.sessions || [])
    .slice()
    .sort((a, b) => {
      const ra = projRank.has(a.project_id) ? projRank.get(a.project_id) : projects.length;
      const rb = projRank.has(b.project_id) ? projRank.get(b.project_id) : projects.length;
      if (ra !== rb) return ra - rb;
      return (a.date_str || '').localeCompare(b.date_str || '');
    })
    .map(s => ({ color: s.color || SHARE_CARD_TOKENS.dim, diversity: s.tool_diversity || 0 }));

  return {
    kind: 'usage',
    total_sessions: me?.total || 0,
    project_count:  opts.projectCount || projects.length,
    tokens_total:   opts.tokensTotal || 0,
    dateFrom:       opts.dateFrom || '',
    dateTo:         opts.dateTo || '',
    rows: (me?.rows || []).map(r => ({ harness: r.harness, count: r.count, pct: r.pct, color: r.color })),
    topProject: projects[0]?.label || '',
    projects,
    sessions,
    me: me || null,
  };
}

/** Minimal spiral ring count k with capacity 1+3k(k+1) >= n. */
function _spiralRingsNeeded(n) {
  let k = 0;
  while (1 + 3 * k * (k + 1) < n) k++;
  return k;
}

/** Pitch radius that spirals n items out to ~targetRadius, clamped to [minR, maxR]. */
function _fillRadius(n, targetRadius, { minR = 4, maxR = 30 } = {}) {
  if (n <= 1) return maxR;
  const rings = Math.max(1, _spiralRingsNeeded(n));
  return Math.max(minR, Math.min(maxR, targetRadius / (rings * 1.5)));
}

const MOSAIC_MAX_SESSIONS = 200;     // ring-8 capacity (1 + 3*8*9 = 217)
const CONSTELLATION_MAX_PROJECTS = 60; // ring-4 capacity (1 + 3*4*5 = 61)

export function generateUsageShareCardSVG(data) {
  const c = SHARE_CARD_TOKENS;
  const g = _shareGeom();

  // ── LEFT: project hexes over a session-ball texture, same center — both
  // counts (25 projects, 122 sessions) are legible in one field.
  const fieldX0 = g.leftPad, fieldX1 = g.dividerX - 30;
  const fieldY0 = g.bodyTop + 20, fieldY1 = g.bodyBot - 46;
  const centerX = (fieldX0 + fieldX1) / 2;
  const centerY = (fieldY0 + fieldY1) / 2;
  const targetR = Math.min(fieldX1 - fieldX0, fieldY1 - fieldY0) / 2 * 0.92;

  const sessions = data.sessions || [];
  const shownSess = sessions.slice(0, MOSAIC_MAX_SESSIONS);
  const sessOverflow = sessions.length - shownSess.length;
  const ballPitch = _fillRadius(shownSess.length, targetR, { minR: 5, maxR: 16 });
  const maxDiversity = Math.max(1, ...shownSess.map(s => s.diversity));
  const balls = shownSess.map((s, i) => {
    const cell = glyphSpiralCell(i);
    const pos = glyphCellPosition(cell.col, cell.row, { r: ballPitch, originX: centerX, originY: centerY });
    const norm = s.diversity / maxDiversity;
    const ballR = Math.max(ballPitch * 0.25, ballPitch * (0.3 + 0.35 * norm));
    return `<circle cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="${ballR.toFixed(1)}" fill="${s.color}" opacity="0.65"/>`;
  }).join('');

  const projects = data.projects || [];
  const shownProj = projects.slice(0, CONSTELLATION_MAX_PROJECTS);
  const projOverflow = projects.length - shownProj.length;
  const hexPitch = _fillRadius(shownProj.length, targetR, { minR: 16, maxR: 34 });
  // Painted after the balls, each with a solid backing disc, so hexes read
  // as clean foreground landmarks instead of blending into the ball texture.
  const hexes = shownProj.map((p, i) => {
    const cell = glyphSpiralCell(i);
    const pos = glyphCellPosition(cell.col, cell.row, { r: hexPitch, originX: centerX, originY: centerY });
    const hexR = Math.max(hexPitch * 0.6, Math.min(hexPitch * 0.92, hexPitch * (0.6 + 0.32 * p.sizeNorm)));
    return `<g transform="translate(${pos.x.toFixed(1)},${pos.y.toFixed(1)})">` +
      `<circle r="${(hexR + 3).toFixed(1)}" fill="${c.bg}"/>` +
      projectGlyphMarkup(p, { r: hexR, bg: c.bg }) +
      `</g>`;
  }).join('');

  const overflowBits = [];
  if (projOverflow > 0) overflowBits.push(`+${projOverflow} projects`);
  if (sessOverflow > 0) overflowBits.push(`+${sessOverflow} sessions`);
  const caption = '◆ hex = project · ball = session · size = activity' +
    (overflowBits.length ? ` · ${overflowBits.join(', ')} more` : '');

  // ── RIGHT: stats + legend on the left half; ME hero hex big, vertically
  // centered, in the right half of the right column.
  const avgDiversity = shownSess.length
    ? Math.round(shownSess.reduce((s, x) => s + x.diversity, 0) / shownSess.length)
    : 0;
  const stats = [
    ['SESSIONS',       String(data.total_sessions)],
    ['PROJECTS',       String(data.project_count)],
    ['CONSUMPTION',    fmtTok(data.tokens_total)],
    ['AVG TOOL TYPES', String(avgDiversity)],
  ];

  const legendY0 = g.bodyTop + 44 + stats.length * 50 + 20;
  const legend = data.rows.map((row, i) => {
    const y = legendY0 + i * 18;
    return `<rect x="${g.rightPad}" y="${y - 9}" width="8" height="8" fill="${row.color}"/>` +
      `<text x="${g.rightPad + 14}" y="${y}" style="font-size:9px;fill:${c.dim};">${esc(row.harness)} ${row.pct}%</text>`;
  }).join('');

  const rightColX0 = g.rightPad, rightColX1 = g.width - g.leftPad;
  const meCenterX = rightColX0 + (rightColX1 - rightColX0) * 0.72; // right half of the right column
  const meCenterY = (g.bodyTop + g.bodyBot) / 2;                    // vertically centered in the body
  const meR = 56;
  const meMarkup = data.me ? meGlyphMarkup(data.me, { r: meR, bg: c.bg, color: c.accent }) : '';
  const meGroup = `<g transform="translate(${meCenterX.toFixed(1)},${meCenterY.toFixed(1)})">` +
    `<circle r="${meR + 10}" fill="${c.card}" stroke="${c.border}" stroke-width="1"/>` +
    `<circle r="${meR + 8}" fill="none" stroke="${c.accent}" stroke-width="1.5" opacity="0.7"/>` +
    meMarkup +
    `</g>`;

  const dateRange = (data.dateFrom || data.dateTo) ? `${data.dateFrom} → ${data.dateTo}` : '';

  return `<svg width="${g.width}" height="${g.height}" xmlns="http://www.w3.org/2000/svg">
  <defs><style>text { font-family: 'IBM Plex Mono', 'Courier New', monospace; }</style></defs>
  <rect width="${g.width}" height="${g.height}" fill="${c.bg}"/>
  ${_shareHeader(g, { kicker: 'FULL USAGE CANVAS · INTELLIGENCE TRACE', dateRight: dateRange })}
  ${_shareDivider(g)}

  ${balls}
  ${hexes}
  <text x="${fieldX0}" y="${fieldY1 + 22}" style="font-size:9px;fill:${c.dim};letter-spacing:1px;">${esc(caption)}</text>

  ${_shareStatRows(stats, g)}
  ${legend}
  ${meGroup}
  ${_shareFooter(g, { tagLine: 'ALL PROJECTS · ALL TIME' })}
</svg>`.trim();
}

/** Plain-text sibling — no live URL (kaaroSessions is a local observability tool). */
export function buildShareText(data) {
  if (data.kind === 'project') {
    return [
      `📊 ${data.label}`,
      `${data.session_count} sessions · ${fmtTok(data.tokens_total)} tokens`,
    ].join('\n');
  }
  if (data.kind === 'usage') {
    return [
      `📊 My kaaroSessions canvas`,
      `${data.total_sessions} sessions · ${data.project_count} projects · ${fmtTok(data.tokens_total)} tokens`,
    ].join('\n');
  }
  const windowCount = (data.context_resets || 0) + 1;
  const lines = [
    `📊 ${data.sessionLabel}`,
    `${data.harness} · ${fmtTok(data.tokens_total)} tokens · ${data.tool_calls} tool calls · ${windowCount} context window${windowCount === 1 ? '' : 's'}`,
  ];
  if (data.project) lines.push(`project: ${data.project}`);
  return lines.join('\n');
}

function _shareCardDataURL(svgString) {
  return `data:image/svg+xml,${encodeURIComponent(svgString)}`;
}

/** SVG string → PNG Blob, same size as _shareGeom(). Browser-only (Image/canvas); not Node-tested. */
export async function svgToPNG(svgString) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const canvas = document.createElement('canvas');
    const { width, height } = _shareGeom();
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    img.onload = () => {
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('canvas.toBlob failed')), 'image/png');
    };
    img.onerror = reject;
    img.src = _shareCardDataURL(svgString);
  });
}

export async function downloadCard(svgString, filename = 'kaaro-share-card.png') {
  const blob = await svgToPNG(svgString);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Web Share API (mobile) or download (desktop fallback). Returns 'shared' | 'downloaded' | 'cancelled'. */
export async function shareCard(svgString, title = 'kaaroSessions', text = '', filename = 'kaaro-share-card.png') {
  const blob = await svgToPNG(svgString);
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.share) {
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title, text, files: [file] });
      } else {
        await navigator.share({ title, text });
      }
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
      throw err;
    }
  }
  await downloadCard(svgString, filename);
  return 'downloaded';
}
