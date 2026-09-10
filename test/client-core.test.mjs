/**
 * test/client-core.test.mjs → experience/client-core.mjs
 *
 * The shared browser core: formatters, colors, geometry, SSE wiring.
 * Node-tested ESM; build.mjs strips `export ` and injects it into every
 * page bundle as %%CLIENT_CORE%% (so the file is also valid plain script).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio } from '../experience/wcag-contrast.mjs';
import {
  fmtTok, esc, fmtAgo, TOOL_COLORS, toolColor, blockGeom,
  escapeRegExp, highlightMatches, countMatches,
  relativeLuminance, readableTextOn,
  nodeRadius, edgeOpacity, edgeWidth, EDGE_COLORS,
  connectEvents, createBootQueue, resolveControlVisibility, fetchRetry,
  nextChromeCollapsed, confirmLayoutReset,
  hexPath, harnessWedges, harnessBreakdown, HARNESS_MARK, HARNESS_FILL_OPACITY,
  meGlyph, meGlyphMarkup, meGlyphSvg, meGlyphCardHtml,
  SIM_ALPHA_DECAY,
  isProjectGlyphActive, glyphGrid, glyphGridExtent,
  glyphCellPosition, glyphLatticeCells, snapToGlyphCell,
  mergeGlyphPlacements, moveGlyphPlacement, minimapViewportRect,
  glyphWorldExtent, glyphBoardConfig, glyphSpiralCell,
  firstAvailableRadial, glyphLatticeWindow, scaleGlyphPins,
  GLYPH_GRAPH_R, glyphGraphConfig, glyphGraphPins, graphRectToMinimap,
  NODE_RADII,
  projectGlyphMarkup, projectGlyphSvg, projectGlyphFieldSvg,
} from '../experience/client-core.mjs';

test('fmtTok — M/k/plain formatting', () => {
  assert.equal(fmtTok(2_400_000), '2.4M');
  assert.equal(fmtTok(42_000), '42k');
  assert.equal(fmtTok(999), '999');
  assert.equal(fmtTok(0), '0');
});

test('esc — escapes HTML-significant characters', () => {
  assert.equal(esc('<b a="x">&'), '&lt;b a=&quot;x&quot;&gt;&amp;');
  assert.equal(esc(null), 'null');
});

test('fmtAgo — seconds/minutes/hours', () => {
  assert.equal(fmtAgo(45), '45s');
  assert.equal(fmtAgo(125), '2m5s');
  assert.equal(fmtAgo(7320), '2h2m');
});

test('escapeRegExp — escapes regex metacharacters', () => {
  assert.equal(escapeRegExp('a.b*c?'), 'a\\.b\\*c\\?');
  assert.equal(escapeRegExp('[test]'), '\\[test\\]');
  assert.equal(escapeRegExp('plain'), 'plain');
});

test('highlightMatches — empty query returns plain escaped text', () => {
  assert.equal(highlightMatches('<script>', ''), esc('<script>'));
  assert.equal(highlightMatches('<script>', null), esc('<script>'));
});

test('highlightMatches — wraps case-insensitive matches in <mark class="thr-hit">', () => {
  assert.equal(
    highlightMatches('Read the file.md', 'read'),
    '<mark class="thr-hit">Read</mark> the file.md',
  );
});

test('highlightMatches — wraps every occurrence', () => {
  assert.equal(
    highlightMatches('cat cat CAT', 'cat'),
    '<mark class="thr-hit">cat</mark> <mark class="thr-hit">cat</mark> <mark class="thr-hit">CAT</mark>',
  );
});

test('highlightMatches — escapes surrounding text and treats query literally, not as regex', () => {
  assert.equal(
    highlightMatches('<a> a.b', 'a.b'),
    '&lt;a&gt; <mark class="thr-hit">a.b</mark>',
  );
});

test('countMatches — counts case-insensitive occurrences, 0 for empty query', () => {
  assert.equal(countMatches('cat cat CAT', 'cat'), 3);
  assert.equal(countMatches('no hits here', 'zzz'), 0);
  assert.equal(countMatches('anything', ''), 0);
});

test('relativeLuminance — agrees with experience/wcag-contrast.mjs', () => {
  for (const hex of ['#000000', '#ffffff', '#cc2244', '#00bb55', '#705a3a', '#aa8e66']) {
    assert.ok(Math.abs(relativeLuminance(hex) - relativeLuminanceRef(hex)) < 1e-9, hex);
  }
  function relativeLuminanceRef(hex) {
    // cross-check via the standalone contrast module: L such that
    // contrastRatio(hex, '#000000') == (L + 0.05) / 0.05
    return contrastRatio(hex, '#000000') * 0.05 - 0.05;
  }
});

test('readableTextOn — picks whichever of black/white clears the bigger ratio', () => {
  assert.equal(readableTextOn('#ccaa00'), '#000000', 'bright yellow needs black text');
  assert.equal(readableTextOn('#2a5c8a'), '#ffffff', 'medium blue needs white text');
  assert.equal(readableTextOn('#000000'), '#ffffff');
  assert.equal(readableTextOn('#ffffff'), '#000000');
});

test('toolColor — case-insensitive canonical tool colors, aliases share hues', () => {
  assert.equal(toolColor('Write'), TOOL_COLORS.Write);
  assert.equal(toolColor('write'), TOOL_COLORS.Write);
  assert.equal(toolColor('Shell'), toolColor('Bash'), 'shell aliases bash');
  assert.equal(toolColor('Glob'), toolColor('Grep'));
  assert.equal(toolColor('NeverHeardOfIt'), null);
});

test('blockGeom — ambient floor strips vs top-anchored activity spikes', () => {
  const trackH = 62;
  assert.deepEqual(blockGeom({ type: 'tokens' }, trackH), { h: 4, yOff: 58 });
  assert.deepEqual(blockGeom({ type: 'words' }, trackH),  { h: 8, yOff: 49 });
  assert.deepEqual(blockGeom({ type: 'tool_call', tool: 'Write' }, trackH), { h: 52, yOff: 2 });
  assert.deepEqual(blockGeom({ type: 'tool_call', tool: 'grep' }, trackH),  { h: 14, yOff: 2 });
  assert.deepEqual(blockGeom({ type: 'tool_call', tool: 'Mystery' }, trackH), { h: 20, yOff: 2 });
});

test('nodeRadius — project scales by sizeNorm (PR_MIN..PR_MAX), session/file/cluster too', () => {
  assert.equal(nodeRadius({ type: 'project', sizeNorm: 0 }), 18);
  assert.equal(nodeRadius({ type: 'project', sizeNorm: 1 }), 34);
  assert.equal(nodeRadius({ type: 'project' }), 18, 'missing sizeNorm defaults to 0');
  assert.equal(nodeRadius({ type: 'session', sizeNorm: 0 }), 5);
  assert.equal(nodeRadius({ type: 'session', sizeNorm: 1 }), 20);
  assert.equal(nodeRadius({ type: 'file', sizeNorm: 0.5 }), 8);
});

test('hexPath — pointy-top regular hexagon, 6 vertices at radius r', async () => {
  const { hexPath } = await import('../experience/client-core.mjs');
  const d = hexPath(20);
  assert.ok(d.startsWith('M'));
  assert.ok(d.endsWith('Z'));
  const verts = d.slice(1, -1).split('L').map(p => p.split(',').map(Number));
  assert.equal(verts.length, 6);
  assert.ok(Math.abs(verts[0][0] - 0) < 1e-9, 'first vertex is pointy-top: x≈0');
  assert.ok(Math.abs(verts[0][1] - -20) < 1e-9, 'first vertex is pointy-top: y≈-r');
  for (const [x, y] of verts)
    assert.ok(Math.abs(Math.hypot(x, y) - 20) < 1e-9, 'every vertex sits at distance r from origin');
});

test('SIM_ALPHA_DECAY settles the force layout in a few seconds, not twenty', () => {
  assert.ok(SIM_ALPHA_DECAY >= 0.018 && SIM_ALPHA_DECAY <= 0.023);
});

test('HARNESS_FILL_OPACITY is solid — active project glyphs are opaque cells', () => {
  assert.equal(HARNESS_FILL_OPACITY, 1);
});

test('isProjectGlyphActive — recencyLevel >= 1 or inFlight', () => {
  assert.equal(isProjectGlyphActive(null), false);
  assert.equal(isProjectGlyphActive({}), false);
  assert.equal(isProjectGlyphActive({ recencyLevel: 0 }), false);
  assert.equal(isProjectGlyphActive({ recencyLevel: 1 }), true);
  assert.equal(isProjectGlyphActive({ recencyLevel: 3 }), true);
  assert.equal(isProjectGlyphActive({ recencyLevel: 0, inFlight: true }), true);
});

test('glyphGrid — pointy-top hex packing, odd rows offset, stable', () => {
  assert.deepEqual(glyphGrid(0), []);
  const r = 10;
  const one = glyphGrid(1, { r, cols: 3 });
  assert.equal(one.length, 1);
  assert.equal(one[0].col, 0);
  assert.equal(one[0].row, 0);
  assert.equal(one[0].x, r);
  assert.equal(one[0].y, r);

  const four = glyphGrid(4, { r, cols: 2 });
  assert.equal(four.length, 4);
  const dx = r * Math.sqrt(3);
  const dy = r * 1.5;
  assert.equal(four[1].col, 1);
  assert.equal(four[1].row, 0);
  assert.ok(Math.abs(four[1].x - (r + dx)) < 1e-9);
  assert.equal(four[2].row, 1);
  assert.ok(Math.abs(four[2].x - (r + dx / 2)) < 1e-9, 'odd row is offset by half a hex');
  assert.ok(Math.abs(four[2].y - (r + dy)) < 1e-9);
  assert.deepEqual(glyphGrid(4, { r, cols: 2 }), four, 'same inputs → same cells');

  const ext = glyphGridExtent(4, { r, cols: 2 });
  assert.ok(ext.width >= four[1].x + r);
  assert.ok(ext.height >= four[2].y + r);
});

test('projectGlyphMarkup — inactive is hollow; active is solid harness fill', () => {
  const idle = projectGlyphMarkup({ color: '#ff8800', harnesses: ['claude-code', 'pi'], recencyLevel: 0 }, { r: 16, bg: '#000000' });
  assert.ok(idle.includes(hexPath(16)));
  assert.ok(idle.includes('fill="#000000"'), 'idle hex sits on the canvas');
  assert.ok(!idle.includes(HARNESS_MARK['claude-code']), 'idle has no harness fill');

  const live = projectGlyphMarkup({ color: '#ff8800', harnesses: ['claude-code'], recencyLevel: 1 }, { r: 16, bg: '#000000' });
  assert.ok(live.includes(HARNESS_MARK['claude-code']));
  assert.ok(/fill-opacity="1"/.test(live), 'active fill is solid');

  const svg = projectGlyphSvg({ color: '#ff8800', recencyLevel: 0, id: 'p1' }, { r: 8 });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('viewBox'));
});

test('glyphCellPosition / snapToGlyphCell — inverse on the hex lattice', () => {
  const opts = { r: 12, cols: 8, rows: 6 };
  for (const [col, row] of [[0, 0], [3, 0], [0, 1], [2, 3], [7, 5]]) {
    const pos = glyphCellPosition(col, row, opts);
    const snap = snapToGlyphCell(pos.x, pos.y, opts);
    assert.equal(snap.col, col, `col ${col},${row}`);
    assert.equal(snap.row, row, `row ${col},${row}`);
  }
  const clamped = snapToGlyphCell(-40, -40, { r: 12, cols: 8, rows: 6 });
  assert.equal(clamped.col, 0);
  assert.equal(clamped.row, 0);
  const hi = snapToGlyphCell(4000, 4000, { r: 12, cols: 8, rows: 6 });
  assert.equal(hi.col, 7);
  assert.equal(hi.row, 5);
  const west = snapToGlyphCell(-40, 0, { r: 12, originX: 0, originY: 0 });
  assert.ok(west.col < 0, 'unbounded snap goes negative (infinite in all directions)');
});

test('glyphLatticeCells — full configurable board, not just packed n', () => {
  const cells = glyphLatticeCells({ cols: 4, rows: 3, r: 10 });
  assert.equal(cells.length, 12);
  assert.equal(cells[0].col, 0);
  assert.equal(cells[0].row, 0);
  assert.equal(cells[11].col, 3);
  assert.equal(cells[11].row, 2);
  const world = glyphWorldExtent({ cols: 4, rows: 3, r: 10 });
  assert.ok(world.width > 10);
  assert.ok(world.height > 10);
});

test('glyphSpiralCell — origin then hex rings, first available is radial', () => {
  assert.deepEqual(glyphSpiralCell(0), { col: 0, row: 0 });
  const ring1 = new Set();
  for (let i = 1; i <= 6; i++) {
    const c = glyphSpiralCell(i);
    ring1.add(c.col + ',' + c.row);
    const pos = glyphCellPosition(c.col, c.row, { r: 10, originX: 0, originY: 0 });
    const origin = glyphCellPosition(0, 0, { r: 10, originX: 0, originY: 0 });
    const dist = Math.hypot(pos.x - origin.x, pos.y - origin.y);
    assert.ok(dist > 5 && dist < 25, 'ring 1 sits on the first hex neighbourhood');
  }
  assert.equal(ring1.size, 6, 'six unique neighbours');
  const seen = new Set();
  for (let i = 0; i < 19; i++) {
    const c = glyphSpiralCell(i);
    const k = c.col + ',' + c.row;
    assert.equal(seen.has(k), false, 'spiral never repeats');
    seen.add(k);
  }
  const occ = new Set(['0,0', ...[...ring1]]);
  const next = firstAvailableRadial(occ);
  assert.equal(glyphSpiralCell(7).col, next.col);
  assert.equal(glyphSpiralCell(7).row, next.row);
});

test('mergeGlyphPlacements — saved cells win, the rest pack radially', () => {
  const ids = ['a', 'b', 'c'];
  const packed = mergeGlyphPlacements(ids, null);
  assert.deepEqual(packed.a, glyphSpiralCell(0));
  assert.deepEqual(packed.b, glyphSpiralCell(1));
  assert.deepEqual(packed.c, glyphSpiralCell(2));

  const saved = { b: { col: 2, row: 1 } };
  const merged = mergeGlyphPlacements(ids, saved);
  assert.deepEqual(merged.b, { col: 2, row: 1 }, 'manual place is kept');
  assert.deepEqual(merged.a, { col: 0, row: 0 });
  assert.notDeepEqual(merged.c, { col: 2, row: 1 }, 'auto pack skips occupied');
});

test('moveGlyphPlacement — empty cell moves, occupied cell swaps', () => {
  const start = { a: { col: 0, row: 0 }, b: { col: 1, row: 0 } };
  const moved = moveGlyphPlacement(start, 'a', 2, 1);
  assert.deepEqual(moved.a, { col: 2, row: 1 });
  assert.deepEqual(moved.b, { col: 1, row: 0 });
  const swapped = moveGlyphPlacement(start, 'a', 1, 0);
  assert.deepEqual(swapped.a, { col: 1, row: 0 });
  assert.deepEqual(swapped.b, { col: 0, row: 0 });
});

test('minimapViewportRect — world camera maps onto the mini field', () => {
  const rect = minimapViewportRect({
    worldX: 100, worldY: 50, worldW: 200, worldH: 100,
    boardW: 400, boardH: 200, miniW: 80, miniH: 40,
  });
  assert.equal(rect.x, 20);
  assert.equal(rect.y, 10);
  assert.equal(rect.w, 40);
  assert.equal(rect.h, 20);
  const empty = minimapViewportRect({ worldX: 0, worldY: 0, worldW: 10, worldH: 10, boardW: 0, boardH: 0, miniW: 80, miniH: 40 });
  assert.deepEqual(empty, { x: 0, y: 0, w: 0, h: 0 });
});

test('glyphBoardConfig — board radius only; lattice is unbounded', () => {
  const cfg = glyphBoardConfig(4);
  assert.ok(cfg.r > 0);
  assert.equal(cfg.cols, undefined);
  assert.equal(cfg.rows, undefined);
});

test('glyphLatticeWindow — cells covering a view, including negatives', () => {
  const cells = glyphLatticeWindow({ x0: -40, y0: -40, x1: 40, y1: 40, r: 10, originX: 0, originY: 0 });
  assert.ok(cells.some(c => c.col === 0 && c.row === 0));
  assert.ok(cells.some(c => c.col < 0 || c.row < 0), 'window extends west/north of origin');
});

test('scaleGlyphPins — hex relatives mapped into a force viewport, centroid at center', () => {
  const pins = scaleGlyphPins(
    { a: { col: 0, row: 0 }, b: { col: 2, row: 0 } },
    { width: 800, height: 600, r: 20 },
  );
  assert.ok(pins.a.x < pins.b.x, 'relative east-west preserved');
  assert.ok(Math.abs((pins.a.x + pins.b.x) / 2 - 400) < 1, 'centroid x → width/2');
  assert.ok(Math.abs((pins.a.y + pins.b.y) / 2 - 300) < 1, 'centroid y → height/2');
  const one = scaleGlyphPins({ a: { col: 0, row: 0 } }, { width: 800, height: 600, r: 20 });
  assert.ok(Math.abs(one.a.x - 400) < 1);
  assert.ok(Math.abs(one.a.y - 300) < 1);
});

test('glyphGraphPins — identity mapping, origin hex at canvas centre', () => {
  assert.equal(GLYPH_GRAPH_R, NODE_RADII.PR_MAX * 2);
  const cfg = glyphGraphConfig(800, 600);
  assert.equal(cfg.originX, 400);
  assert.equal(cfg.originY, 300);
  assert.equal(cfg.r, GLYPH_GRAPH_R);
  const pins = glyphGraphPins(
    { a: { col: 0, row: 0 }, b: { col: 1, row: 0 } },
    { width: 800, height: 600 },
  );
  assert.equal(pins.a.x, 400);
  assert.equal(pins.a.y, 300);
  const east = glyphCellPosition(1, 0, cfg);
  assert.equal(pins.b.x, east.x);
  assert.equal(pins.b.y, east.y);
  const snap = snapToGlyphCell(pins.b.x, pins.b.y, cfg);
  assert.equal(snap.col, 1);
  assert.equal(snap.row, 0);
});

test('graphRectToMinimap — graph camera maps onto the dock field', () => {
  const vis = { worldX: 400, worldY: 300, worldW: 136, worldH: 136 };
  const rect = graphRectToMinimap(vis, { graphR: 68, miniR: 7, originX: 400, originY: 300 });
  assert.equal(rect.x, 0);
  assert.equal(rect.y, 0);
  assert.ok(Math.abs(rect.w - 14) < 1e-9);
  assert.ok(Math.abs(rect.h - 14) < 1e-9);
});

test('projectGlyphFieldSvg — placements override default pack', () => {
  const projects = [
    { id: 'a', label: 'a', color: '#ff8800', harnesses: [], recencyLevel: 0 },
    { id: 'b', label: 'b', color: '#00ff88', harnesses: [], recencyLevel: 0 },
  ];
  const svg = projectGlyphFieldSvg(projects, {
    r: 10, cols: 4, rows: 3, bg: '#000000',
    placements: { b: { col: 3, row: 2 } },
  });
  assert.ok(svg.includes('data-pid="b"'));
  const pos = glyphCellPosition(3, 2, { r: 10, originX: 0, originY: 0 });
  assert.ok(svg.includes(`translate(${pos.x},${pos.y})`));
});

test('projectGlyphFieldSvg — one svg, glyphs at grid cells, data-pid for click', () => {
  const projects = [
    { id: 'D--src-a', label: 'a', color: '#ff8800', harnesses: ['pi'], recencyLevel: 1 },
    { id: 'D--src-b', label: 'b', color: '#00ff88', harnesses: ['grok'], recencyLevel: 0 },
  ];
  const svg = projectGlyphFieldSvg(projects, { r: 10, cols: 2, bg: '#000000' });
  assert.ok(svg.startsWith('<svg'));
  assert.equal((svg.match(/data-pid="/g) || []).length, 2);
  assert.ok(svg.includes('data-pid="D--src-a"'));
  assert.ok(svg.includes('data-pid="D--src-b"'));
  assert.ok(svg.includes(HARNESS_MARK.pi), 'active cell is solid');
  assert.ok(!svg.split('data-pid="D--src-b"')[1].split('</g>')[0].includes(HARNESS_MARK.grok),
    'idle cell stays hollow');
});

test('HARNESS_MARK has an entry for every registered harness', async () => {
  const { HARNESS_IDS } = await import('../hooks/registry.mjs');
  for (const id of HARNESS_IDS) {
    assert.ok(HARNESS_MARK[id], `HARNESS_MARK is missing a color for harness "${id}"`);
  }
});

test('HARNESS_MARK has eight distinct non-blue data hues', () => {
  const ids = ['claude-code', 'codex', 'pi', 'antigravity', 'grok', 'opencode', 'copilot', 'command-code'];
  const hexes = ids.map(id => HARNESS_MARK[id]);
  assert.equal(new Set(hexes).size, 8);
  for (const hex of hexes) {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max === min) continue;
    const d = max - min;
    const l = (max + min) / 2;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    h *= 360;
    assert.ok(!(s >= 0.06 && h >= 190 && h <= 268), `${hex} is blue-family chrome (h=${h.toFixed(0)})`);
  }
});

function pathPts(d) {
  return d.replace(/Z$/i, '').slice(1).split('L').map(p => p.split(',').map(Number));
}

function near(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

test('harnessWedges — empty / one / two / three / four+', () => {
  assert.deepEqual(harnessWedges([], 20), []);
  assert.deepEqual(harnessWedges(null, 20), []);

  const solid = harnessWedges(['claude-code'], 20);
  assert.equal(solid.length, 1);
  assert.equal(solid[0].harness, 'claude-code');
  assert.equal(solid[0].d, hexPath(20), 'single harness is a solid hex, not a fan');

  const split = harnessWedges(['claude-code', 'pi'], 20);
  assert.equal(split.length, 2);
  assert.equal(split[0].harness, 'claude-code');
  assert.equal(split[1].harness, 'pi');
  const left = pathPts(split[0].d);
  const right = pathPts(split[1].d);
  assert.ok(left.length >= 3 && right.length >= 3);
  assert.ok(near(left[0][0], 0) && near(left[0][1], 0), 'n=2 wedges start at the center');
  // Vertical split through top and bottom vertices of a pointy-top hex.
  const hasTop = p => p.some(([x, y]) => near(x, 0) && near(y, -20));
  const hasBot = p => p.some(([x, y]) => near(x, 0) && near(y, 20));
  assert.ok(hasTop(left) && hasBot(left), 'first half includes the top–bottom diagonal');
  assert.ok(hasTop(right) && hasBot(right), 'second half shares the same diagonal');

  const tri = harnessWedges(['claude-code', 'pi', 'grok'], 20);
  assert.equal(tri.length, 3);
  // 120° rays hit vertices 0, 2, 4 (top, lower-right, lower-left).
  const tri0 = pathPts(tri[0].d);
  assert.ok(near(tri0[0][0], 0) && near(tri0[0][1], 0));
  assert.ok(tri0.some(([x, y]) => near(x, 0) && near(y, -20)), 'first 120° wedge includes the top vertex');

  const quad = harnessWedges(['claude-code', 'pi', 'grok', 'opencode'], 20);
  assert.equal(quad.length, 4);
  const q0 = pathPts(quad[0].d);
  assert.ok(near(q0[0][0], 0) && near(q0[0][1], 0), 'n=4 is a fan from the center');
  // 90° ray from top hits the right flat (side midpoint), not a vertex.
  const sideHit = q0.find(([x, y]) => near(x, 20 * Math.sqrt(3) / 2, 1e-4) && near(y, 0, 1e-4));
  assert.ok(sideHit, 'n=4 first wedge lands on a hex side, not only corners');

  const seven = harnessWedges(
    ['claude-code', 'pi', 'antigravity', 'grok', 'opencode', 'copilot', 'command-code'], 20);
  assert.equal(seven.length, 7);
  for (const w of seven) {
    const pts = pathPts(w.d);
    assert.ok(near(pts[0][0], 0) && near(pts[0][1], 0));
    assert.ok(pts.length >= 3);
  }
});

test('harnessWedges — weighted by session counts', () => {
  // No weights (or all-equal weights) is unchanged from the equal-angle default.
  const bare = harnessWedges(['claude-code', 'pi'], 20);
  assert.deepEqual(harnessWedges(['claude-code', 'pi'], 20, null), bare);
  assert.deepEqual(harnessWedges(['claude-code', 'pi'], 20, { 'claude-code': 1, pi: 1 }), bare);

  // claude-code: 3 sessions, pi: 1 session → 75%/25% split, boundary at 270°
  // (the left-side midpoint of a pointy-top hex, not a vertex).
  const w = harnessWedges(['claude-code', 'pi'], 20, { 'claude-code': 3, pi: 1 });
  assert.equal(w.length, 2);
  assert.equal(w[0].harness, 'claude-code');
  assert.equal(w[1].harness, 'pi');
  const majority = pathPts(w[0].d);
  const minority = pathPts(w[1].d);
  assert.ok(near(majority[0][0], 0) && near(majority[0][1], 0), 'wedges start at center');
  const hasLeftMid = p => p.some(([x, y]) => near(x, -20 * Math.sqrt(3) / 2, 1e-4) && near(y, 0, 1e-4));
  assert.ok(hasLeftMid(majority), 'majority wedge reaches the 270° boundary (left side midpoint)');
  assert.ok(hasLeftMid(minority), 'minority wedge shares the same boundary point');
});

test('meGlyph — aggregate harness usage across all sessions, split by share', () => {
  assert.deepEqual(meGlyph(), { harnesses: [], weights: {}, total: 0, rows: [] });
  assert.equal(meGlyph([]).total, 0);

  const me = meGlyph([
    { harness: 'pi' },
    { harness: 'claude-code' },
    { harness: 'claude-code' },
    { harness: 'claude-code' },
    { source: 'pi' },
    { harness: 'grok' },
    { label: 'no-harness' },
  ]);
  assert.equal(me.total, 6);
  assert.deepEqual(me.harnesses, ['claude-code', 'pi', 'grok'], 'largest share first');
  assert.equal(me.weights['claude-code'], 3);
  assert.equal(me.weights.pi, 2);
  assert.equal(me.weights.grok, 1);
  assert.equal(me.rows[0].share, 0.5);
  assert.equal(me.rows[0].pct, 50);
  assert.equal(me.rows[0].count, 3);
  assert.equal(me.rows[0].color, HARNESS_MARK['claude-code']);
  assert.equal(me.rows[1].share, 2 / 6);
  assert.equal(me.rows[2].pct, 17);

  const tied = meGlyph([{ harness: 'pi' }, { harness: 'grok' }]);
  assert.deepEqual(tied.harnesses, ['grok', 'pi'], 'ties break alphabetically');
});

test('meGlyphMarkup — empty is hollow; usage splits the hex by share', () => {
  const empty = meGlyphMarkup(meGlyph([]), { r: 20, bg: '#000000', color: '#ccccaa' });
  assert.ok(empty.includes(hexPath(20)));
  assert.ok(empty.includes('fill="#000000"'));
  assert.ok(!empty.includes(HARNESS_MARK['claude-code']));

  const me = meGlyph([
    { harness: 'claude-code' }, { harness: 'claude-code' }, { harness: 'claude-code' },
    { harness: 'pi' },
  ]);
  const markup = meGlyphMarkup(me, { r: 20, bg: '#000000', color: '#ccccaa' });
  assert.ok(markup.includes(HARNESS_MARK['claude-code']));
  assert.ok(markup.includes(HARNESS_MARK.pi));
  assert.ok(/fill-opacity="1"/.test(markup), 'ME fill is solid');
  const equal = harnessWedges(me.harnesses, 20);
  const weighted = harnessWedges(me.harnesses, 20, me.weights);
  assert.notDeepEqual(weighted, equal, 'share wedges are not equal-angle');
  assert.ok(markup.includes(weighted[0].d), 'majority wedge path is in the mark');

  const svg = meGlyphSvg(me, { r: 16, bg: '#000000' });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('class="me-glyph"'));
  assert.ok(svg.includes('viewBox'));

  const card = meGlyphCardHtml(me, { r: 16, bg: '#000000' });
  assert.ok(card.includes('class="me-glyph"'));
  assert.ok(card.includes('75%'));
  assert.ok(card.includes('claude-code'));
  assert.ok(card.includes('4 session'));
});

test('harnessBreakdown — preserves glyph order, counts sessions, carries mark color', () => {
  assert.deepEqual(harnessBreakdown([]), []);
  const rows = harnessBreakdown(
    ['claude-code', 'pi'],
    [
      { harness: 'pi' },
      { harness: 'claude-code' },
      { harness: 'claude-code' },
      { source: 'pi' },
    ],
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].harness, 'claude-code');
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].color, HARNESS_MARK['claude-code']);
  assert.equal(rows[1].harness, 'pi');
  assert.equal(rows[1].count, 2);
});

test('edge opacity/width — weighted edges scale with sqrt(weight/max)', () => {
  assert.ok(EDGE_COLORS.write);
  const base = edgeOpacity({ type: 'read' }, 100);
  const heavy = edgeOpacity({ type: 'read', weight: 100 }, 100);
  assert.ok(heavy > base, 'weight raises opacity');
  assert.ok(edgeWidth({ type: 'write', weight: 100 }, 100) > edgeWidth({ type: 'write', weight: 1 }, 100));
});

test('createBootQueue — first line is immediate, later lines wait minGap', () => {
  const frames = [];
  const reveals = [];
  const scheduled = [];
  const delay = (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; };
  const q = createBootQueue({
    minGap: 180,
    delay,
    onShow: shown => frames.push(shown.slice()),
  });
  q.push('a');
  assert.deepEqual(frames, [['a']], 'first line paints now');
  q.push('b', () => reveals.push('b'));
  q.push('c');
  assert.equal(frames.length, 1, 'later lines stay queued');
  assert.deepEqual(reveals, []);
  assert.equal(scheduled[0].ms, 180);
  scheduled[0].fn();
  assert.deepEqual(frames[1], ['a', 'b']);
  assert.deepEqual(reveals, ['b'], 'onReveal fires when that line is shown');
  scheduled[1].fn();
  assert.deepEqual(frames[2], ['a', 'b', 'c']);
});

test('createBootQueue — firstDelay holds on the cursor before line one', () => {
  const frames = [];
  const scheduled = [];
  const delay = (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; };
  const q = createBootQueue({
    minGap: 500,
    firstDelay: 400,
    delay,
    onShow: shown => frames.push(shown.slice()),
  });
  q.push('a');
  assert.equal(frames.length, 0, 'hold before the first line');
  assert.equal(scheduled[0].ms, 400);
  scheduled[0].fn();
  assert.deepEqual(frames[0], ['a']);
  q.push('b');
  assert.equal(scheduled[1].ms, 500);
  scheduled[1].fn();
  assert.deepEqual(frames[1], ['a', 'b']);
});

test('connectEvents — wires handlers with JSON parsing and status callbacks', () => {
  const listeners = {};
  class FakeES {
    constructor(url) { this.url = url; FakeES.last = this; }
    addEventListener(ev, fn) { listeners[ev] = fn; }
  }
  const seen = [];
  const states = [];
  connectEvents({
    handlers: {
      tool_call: d => seen.push(d),
      updated:   (d, raw) => seen.push({ raw: raw.data }),
    },
    onStatus: s => states.push(s),
  }, FakeES);

  assert.equal(FakeES.last.url, '/events');
  listeners.tool_call({ data: '{"tool":"Read","slug":"abc"}' });
  assert.deepEqual(seen[0], { tool: 'Read', slug: 'abc' });

  listeners.updated({ data: '2026-06-12T00:00:00Z' }); // non-JSON → raw passthrough
  assert.equal(seen[1].raw, '2026-06-12T00:00:00Z');

  FakeES.last.onopen();
  FakeES.last.onerror();
  assert.deepEqual(states, ['open', 'reconnecting']);
});

test('fetchRetry — resolves on first try without retrying', async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; return Promise.resolve('ok'); };
  const delay = () => { throw new Error('should not delay'); };
  const result = await fetchRetry('/x', { fetchImpl, delay });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('fetchRetry — retries once after a delay on transient failure', async () => {
  let calls = 0;
  const fetchImpl = () => {
    calls++;
    return calls === 1 ? Promise.reject(new Error('NetworkError')) : Promise.resolve('ok');
  };
  const delays = [];
  const delay = (fn, ms) => { delays.push(ms); fn(); };
  const result = await fetchRetry('/x', { fetchImpl, delay, retryDelay: 400 });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(delays, [400]);
});

test('fetchRetry — rejects if both attempts fail', async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; return Promise.reject(new Error('still down')); };
  const delay = (fn) => fn();
  await assert.rejects(() => fetchRetry('/x', { fetchImpl, delay }), /still down/);
  assert.equal(calls, 2);
});

test('resolveControlVisibility — only the active layout’s control panels show', () => {
  const handlers = {
    force:    { controls: ['force-options'] },
    swimlane: { controls: ['sl-options', 'sl-extra'] },
    matrix:   {},
    grid:     { controls: ['force-options'] },
  };
  assert.deepEqual(resolveControlVisibility(handlers, 'swimlane'), {
    'force-options': false, 'sl-options': true, 'sl-extra': true,
  });
  assert.deepEqual(resolveControlVisibility(handlers, 'matrix'), {
    'force-options': false, 'sl-options': false, 'sl-extra': false,
  });
  assert.deepEqual(resolveControlVisibility(handlers, 'force'), {
    'force-options': true, 'sl-options': false, 'sl-extra': false,
  });
  assert.deepEqual(resolveControlVisibility(handlers, 'grid'), {
    'force-options': true, 'sl-options': false, 'sl-extra': false,
  }, 'shared force-options stays visible on lattice');
});

test('nextChromeCollapsed — collapse unless every widget is already collapsed', () => {
  assert.equal(nextChromeCollapsed([]), true);
  assert.equal(nextChromeCollapsed([false, false, false]), true);
  assert.equal(nextChromeCollapsed([true, false]), true);
  assert.equal(nextChromeCollapsed([true, true, true]), false, 'all down → expand');
});

test('confirmLayoutReset — asks are-you-sure and follows the answer', () => {
  const asked = [];
  assert.equal(confirmLayoutReset(msg => { asked.push(msg); return false; }), false);
  assert.equal(confirmLayoutReset(msg => { asked.push(msg); return true; }), true);
  assert.ok(asked[0].toLowerCase().includes('reset'));
  assert.ok(asked[0].toLowerCase().includes('sure') || asked[0].includes('?'));
});

// ── DAW lane geometry (extracted from 19-daw-builder) ─────────────────────────

test('DAW_FAMILY_LANES — four family lanes with portions summing to ~0.88', async () => {
  const { DAW_FAMILY_LANES } = await import('../experience/client-core.mjs');
  assert.deepEqual(DAW_FAMILY_LANES.map(l => l.id), ['file', 'system', 'ai', 'context']);
  const total = DAW_FAMILY_LANES.reduce((a, l) => a + l.portion, 0);
  assert.ok(Math.abs(total - 0.88) < 1e-9);
});

test('computeLaneLayout — stacks lanes under the ruler, 18px minimum', async () => {
  const { computeLaneLayout } = await import('../experience/client-core.mjs');
  const rows = computeLaneLayout(420);
  assert.equal(rows[0].y, 20, 'first lane starts under the 20px ruler');
  assert.equal(rows[1].y, rows[0].y + rows[0].h, 'lanes stack');
  assert.ok(rows.every(r => r.h >= 18));
  const tiny = computeLaneLayout(40);
  assert.ok(tiny.every(r => r.h === 18), 'minimum lane height enforced');
});

test('laneForEvent — routes by pulse family', async () => {
  const { laneForEvent } = await import('../experience/client-core.mjs');
  assert.equal(laneForEvent({ family: 'ai' }).id, 'ai');
  assert.equal(laneForEvent({ family: 'nope' }), null);
  assert.equal(laneForEvent({ family: 'context', type: 'thinking' }).id, 'context');
});

test('DAW context lane — thinking is a visible pad, not a word_count sliver', async () => {
  const { DAW_FAMILY_LANES } = await import('../experience/client-core.mjs');
  const ctx = DAW_FAMILY_LANES.find(l => l.id === 'context');
  assert.ok(ctx.toolColors.thinking, 'thinking has a lane color');
  assert.ok(ctx.blockH({ type: 'thinking' }) >= 0.4,
    'thinking pad must be visible on the context lane');
  assert.ok(ctx.blockH({ type: 'thinking' }) < ctx.blockH({ type: 'words', word_count: 80 }),
    'thinking stays under a full words block');
});

test('evTimeX — right-anchored time axis with scroll offset', async () => {
  const { evTimeX } = await import('../experience/client-core.mjs');
  const now = 100_000;
  // event now → right edge; 1s ago at 30px/s → 30px left of edge
  assert.equal(evTimeX({ ts: now }, now, 800, 30, 0), 800);
  assert.equal(evTimeX({ ts: now - 1000 }, now, 800, 30, 0), 770);
  assert.equal(evTimeX({ ts: now - 1000 }, now, 800, 30, 1000), 800, 'scrollMs shifts view back');
});

test('voicesSoundingAt — covers [at, at+dur) and drops expired voices', async () => {
  const { voicesSoundingAt } = await import('../experience/client-core.mjs');
  const voices = [
    { at: 1.0, dur: 0.4, instrument: 'harp' },
    { at: 1.2, dur: 0.2, instrument: 'bit' },
    { at: 2.0, dur: 0.5, instrument: 'bell' },
  ];
  assert.deepEqual(voicesSoundingAt(voices, 0.9).map(v => v.instrument), []);
  assert.deepEqual(voicesSoundingAt(voices, 1.1).map(v => v.instrument), ['harp']);
  assert.deepEqual(voicesSoundingAt(voices, 1.25).map(v => v.instrument), ['harp', 'bit']);
  assert.deepEqual(voicesSoundingAt(voices, 1.41).map(v => v.instrument), []);
  assert.deepEqual(voicesSoundingAt(voices, 2.1).map(v => v.instrument), ['bell']);
  assert.deepEqual(voicesSoundingAt([], 1), []);
});

test('fmtSoundingLine — instrument ×cluster, label, hz', async () => {
  const { fmtSoundingLine } = await import('../experience/client-core.mjs');
  assert.equal(fmtSoundingLine([]), '');
  assert.equal(fmtSoundingLine(null), '');
  assert.equal(
    fmtSoundingLine([{ instrument: 'harp', label: 'read_file', hz: 261.6, clusterN: 12, relMs: 12400 }]),
    '▶ t+12.4s  harp×12 read_file 262Hz',
  );
});

test('fmtSessionT — seconds then mmss', async () => {
  const { fmtSessionT } = await import('../experience/client-core.mjs');
  assert.equal(fmtSessionT(null), '');
  assert.equal(fmtSessionT(12400), 't+12.4s');
  assert.equal(fmtSessionT(65000), 't+1m05s');
  assert.equal(fmtSessionT(125000), 't+2m05s');
});

function v(over = {}) {
  const { sonic, ...rest } = over;
  return {
    name: 'harp', hz: 261.6, vol: 0.4,
    sonic: { key: 'read', fam: 'file', ...sonic },
    ...rest,
  };
}

test('coalesceVoices — under cap, unison C4 spreads into a chord', async () => {
  const { coalesceVoices } = await import('../experience/client-core.mjs');
  const { audible, ghosts } = coalesceVoices([v({}), v({}), v({})], { scale: [0, 4, 7] });
  assert.equal(audible.length, 3);
  assert.equal(ghosts.length, 0);
  const hzs = audible.map(a => +a.hz.toFixed(1));
  assert.notEqual(hzs[1], hzs[0], 'second tone leaves unison');
  assert.ok(hzs[2] > hzs[1]);
});

test('coalesceVoices — 12 reads collapse to a 3-tone file chord', async () => {
  const { coalesceVoices, VOICE_MAX_CHORD } = await import('../experience/client-core.mjs');
  const burst = Array.from({ length: 12 }, () => v({}));
  const { audible, ghosts } = coalesceVoices(burst, { scale: [0, 4, 7, 12] });
  assert.equal(audible.length, VOICE_MAX_CHORD);
  assert.equal(ghosts.length, 12);
  assert.equal(audible[0].clusterN, 12);
  assert.ok(audible.every(a => a.sonic.fam === 'file'));
});

test('coalesceVoices — write stays the root of a file-family chord', async () => {
  const { coalesceVoices } = await import('../experience/client-core.mjs');
  const burst = [
    v({ name: 'bass', hz: 130.8, sonic: { key: 'write', fam: 'file' } }),
    ...Array.from({ length: 10 }, () => v({})),
  ];
  const { audible } = coalesceVoices(burst, { scale: [0, 4, 7] });
  assert.equal(audible[0].sonic.key, 'write');
  assert.ok(audible.length <= 4);
  assert.equal(audible[0].clusterN, 11);
});

test('coalesceVoices — mixed families get one cluster each, never more than maxPoly', async () => {
  const { coalesceVoices, VOICE_MAX_POLYPHONY } = await import('../experience/client-core.mjs');
  const burst = [
    ...Array.from({ length: 6 }, () => v({})),
    ...Array.from({ length: 6 }, () => v({ name: 'bell', sonic: { key: 'other', fam: 'ai' } })),
    ...Array.from({ length: 6 }, () => v({ name: 'flute', sonic: { key: 'tokens', fam: 'context' } })),
  ];
  const { audible } = coalesceVoices(burst, { scale: [0, 4, 7] });
  assert.ok(audible.length <= VOICE_MAX_POLYPHONY);
  const fams = new Set(audible.map(a => a.sonic.fam));
  assert.ok(fams.size >= 2, 'varied burst keeps more than one family');
});

test('coalesceVoices — percussion pile is one hit, not a snare chord', async () => {
  const { coalesceVoices } = await import('../experience/client-core.mjs');
  const burst = Array.from({ length: 8 }, () => v({ name: 'snare', sonic: { key: 'bash_git', fam: 'system' } }));
  const { audible, ghosts } = coalesceVoices(burst);
  assert.equal(audible.length, 1);
  assert.equal(audible[0].name, 'snare');
  assert.equal(audible[0].clusterN, 8);
  assert.equal(ghosts.length, 7);
});

// ── History-view filters + free force profile (E3) ────────────────────────────

test('sessionMatchesFilters — date range, harness set, project set', async () => {
  const { sessionMatchesFilters } = await import('../experience/client-core.mjs');
  const node = { type: 'session', harness: 'grok', project_id: 'P1', date_str: '2026-06-10' };

  assert.equal(sessionMatchesFilters(node, {}), true, 'no filters → match');
  assert.equal(sessionMatchesFilters(node, { from: '2026-06-01' }), true);
  assert.equal(sessionMatchesFilters(node, { from: '2026-06-11' }), false);
  assert.equal(sessionMatchesFilters(node, { to: '2026-06-10' }), true, 'to is inclusive');
  assert.equal(sessionMatchesFilters(node, { to: '2026-06-09' }), false);
  assert.equal(sessionMatchesFilters(node, { harnesses: new Set(['grok']) }), true);
  assert.equal(sessionMatchesFilters(node, { harnesses: new Set(['pi']) }), false);
  assert.equal(sessionMatchesFilters(node, { harnesses: new Set() }), true, 'empty set → no constraint');
  assert.equal(sessionMatchesFilters(node, { projects: new Set(['P1']) }), true);
  assert.equal(sessionMatchesFilters(node, { projects: new Set(['P2']) }), false);
  assert.equal(sessionMatchesFilters({ ...node, date_str: undefined }, { from: '2026-06-11' }), true,
    'undated sessions are never date-filtered');
});

test('forceProfile — anchored vs free layouts', async () => {
  const { forceProfile } = await import('../experience/client-core.mjs');
  const anchored = forceProfile(false);
  assert.equal(anchored.projectPinned, true);
  assert.equal(anchored.membershipStrength, 0.65);
  assert.equal(anchored.center, false);

  const free = forceProfile(true);
  assert.equal(free.projectPinned, false, 'projects unpin');
  assert.ok(free.membershipStrength < 0.1, 'membership links nearly let go');
  assert.equal(free.center, true, 'a weak center keeps the free graph on screen');
  assert.ok(Math.abs(free.projectCharge) < Math.abs(anchored.projectCharge),
    'project repulsion de-weighted');
});

// ── E5: cognition pulse glyphs + ticker entries ───────────────────────────────

test('pulseTickerEntry — glyphs, text, and roles per cognition event', async () => {
  const { pulseTickerEntry } = await import('../experience/client-core.mjs');

  const human = pulseTickerEntry('human_turn', { slug: 'abc12345', text: 'fix the auth bug please' });
  assert.ok(human.text.startsWith('⌨'));
  assert.ok(human.text.includes('fix the auth bug'));
  assert.equal(human.role, 'human');

  const compact = pulseTickerEntry('compact', { slug: 'abc12345' });
  assert.ok(compact.text.startsWith('⟲'));
  assert.equal(compact.role, 'context');

  const perm = pulseTickerEntry('permission', { slug: 'abc12345', mode: 'acceptEdits' });
  assert.ok(perm.text.includes('acceptEdits'));

  const terr = pulseTickerEntry('tool_error', { slug: 'abc12345', tool: 'Bash' });
  assert.ok(terr.text.startsWith('✖'));
  assert.equal(terr.role, 'err');

  const aerr = pulseTickerEntry('api_error', { slug: 'abc12345', message: 'quota exceeded', code: 'rate_limit' });
  assert.ok(aerr.text.includes('quota exceeded'));
  assert.equal(aerr.role, 'err');

  assert.equal(pulseTickerEntry('chirp', {}), null, 'chirps stay out of the ticker');
  assert.equal(pulseTickerEntry('thinking', { slug: 'abc12345' }), null,
    'thinking is a pad on the ring, not a ticker line');
});

test('LIVE_COGNITION_EVENTS — thinking is live; unknown/silent/tool_result stay wire-only', async () => {
  const { LIVE_COGNITION_EVENTS, LIVE_PLAYPULSE_EVENTS } = await import('../experience/client-core.mjs');
  assert.ok(LIVE_COGNITION_EVENTS.includes('thinking'));
  for (const skip of ['unknown', 'silent', 'tool_result']) {
    assert.ok(!LIVE_COGNITION_EVENTS.includes(skip), skip + ' must not be subscribed');
    assert.ok(!LIVE_PLAYPULSE_EVENTS.includes(skip), skip + ' must not reach playPulse');
  }
  for (const ev of ['tool_call', 'tokens', 'words', 'thinking']) {
    assert.ok(LIVE_PLAYPULSE_EVENTS.includes(ev), ev + ' must reach playPulse');
  }
});

test('blockGeom — cognition events get distinct canvas geometry', () => {
  const trackH = 62;
  assert.deepEqual(blockGeom({ type: 'compact' }, trackH),    { h: 58, yOff: 2 }, 'compact = full-height divider');
  assert.deepEqual(blockGeom({ type: 'tool_error' }, trackH), { h: 58, yOff: 2 });
  assert.deepEqual(blockGeom({ type: 'api_error' }, trackH),  { h: 58, yOff: 2 });
  assert.deepEqual(blockGeom({ type: 'human_turn' }, trackH), { h: 36, yOff: 2 });
  assert.deepEqual(blockGeom({ type: 'permission' }, trackH), { h: 12, yOff: 2 });
  assert.deepEqual(blockGeom({ type: 'mode_shift' }, trackH), { h: 12, yOff: 2 });
  assert.deepEqual(blockGeom({ type: 'chirp' }, trackH),      { h: 5,  yOff: 40 });
  assert.deepEqual(blockGeom({ type: 'thinking' }, trackH),   { h: 16, yOff: 20 }, 'thinking = mid-track pad');
});

// ── E5: DAW session legend + context pressure ─────────────────────────────────

test('contextPressure — context tokens vs window, clamped 0..1', async () => {
  const { contextPressure } = await import('../experience/client-core.mjs');
  assert.equal(contextPressure(50_000, 50_000, 200_000), 0.5);
  assert.equal(contextPressure(0, 0), 0);
  assert.equal(contextPressure(300_000, 0, 200_000), 1, 'clamped');
});

// ── Mission Control visual encoding (CSS class ontology) ─────────────────────

test('pressureTier — lo / mid / hi thresholds for mc-pressure fills', async () => {
  const { pressureTier } = await import('../experience/client-core.mjs');
  assert.equal(pressureTier(null), null);
  assert.equal(pressureTier(undefined), null);
  assert.equal(pressureTier(0), 'lo');
  assert.equal(pressureTier(0.54), 'lo');
  assert.equal(pressureTier(0.55), 'mid');
  assert.equal(pressureTier(0.84), 'mid');
  assert.equal(pressureTier(0.85), 'hi');
  assert.equal(pressureTier(1), 'hi');
});

test('sessionCardClasses — encodes status, last pulse, alert, pressure, open', async () => {
  const { sessionCardClasses } = await import('../experience/client-core.mjs');
  const base = {
    status: 'active',
    last_event: 'tool_call',
    tool_errors: 0,
    api_errors: 0,
    last_api_error: null,
    last_tokens: { input: 100_000, cache_read: 80_000 },
  };
  const cls = sessionCardClasses(base);
  assert.ok(cls.includes('mc-card'));
  assert.ok(cls.includes('mc-card--active'));
  assert.ok(cls.includes('mc-card--evt-tool_call'));
  assert.equal(cls.includes('mc-card--pressure-'), false, 'pressure stays on the meter fill only');
  assert.equal(cls.includes('mc-card--alert'), false);
  assert.equal(cls.includes('mc-card--open'), false);

  const idleErr = sessionCardClasses({
    status: 'idle',
    last_event: 'api_error',
    tool_errors: 0,
    api_errors: 1,
    last_api_error: { message: 'quota' },
    last_tokens: null,
  }, { expanded: true });
  assert.ok(idleErr.includes('mc-card--idle'));
  assert.ok(idleErr.includes('mc-card--evt-api_error'));
  assert.ok(idleErr.includes('mc-card--alert'), 'alert flags the error zone — not a full-card chrome wipe');
  assert.ok(idleErr.includes('mc-card--open'));
  assert.equal(idleErr.includes('mc-card--pressure-'), false);

  const think = sessionCardClasses({
    status: 'active',
    last_event: 'thinking',
    tool_errors: 0,
    api_errors: 0,
    last_api_error: null,
    last_tokens: { input: 10_000, cache_read: 0 },
  });
  assert.ok(think.includes('mc-card--evt-thinking'));
  assert.ok(think.includes('mc-card--thinking-live'));
  assert.equal(think.includes('mc-card--pressure-'), false);

  const unknown = sessionCardClasses({
    status: 'active',
    last_event: 'mystery!!',
    tool_errors: 2,
    api_errors: 0,
    last_api_error: null,
    last_tokens: null,
  });
  assert.ok(unknown.includes('mc-card--evt-other'), 'unsafe last_event → other');
  assert.ok(unknown.includes('mc-card--alert'), 'tool_errors → alert');
});

test('sessionAlertText — human-readable error line for triage scan', async () => {
  const { sessionAlertText } = await import('../experience/client-core.mjs');
  assert.equal(sessionAlertText(null), null);
  assert.equal(sessionAlertText({ tool_errors: 0, api_errors: 0 }), null);
  assert.equal(
    sessionAlertText({ last_api_error: { message: 'quota exceeded', code: 'rate_limit' } }),
    '⊘ quota exceeded [rate_limit]',
  );
  assert.equal(
    sessionAlertText({ tool_errors: 2, api_errors: 1, last_api_error: null }),
    '⊘ 2 tool err · 1 api err',
  );
  assert.equal(
    sessionAlertText({
      tool_errors: 3,
      last_api_error: { message: 'boom', code: null },
    }),
    '⊘ boom',
    'explicit api message wins over counts',
  );
});

test('sessionMetricSplit — primary scan vs secondary counts', async () => {
  const { sessionMetricSplit } = await import('../experience/client-core.mjs');
  const { primary, secondary } = sessionMetricSplit({
    tool_calls: 12,
    tool_errors: 1,
    api_errors: 0,
    tokens_work: 9000,
    burn_rate_per_min: 400,
    human_turns: 3,
    compacts: 1,
    thinking_count: 5,
    attachments: 2,
    scaffolds: 0,
  });
  assert.deepEqual(primary.map(m => m.key), ['tools', 'tool_errors', 'tokens', 'burn', 'human', 'ago']);
  assert.ok(primary.some(m => m.key === 'tool_errors' && m.err));
  assert.deepEqual(secondary.map(m => m.key), ['compacts', 'thinking', 'attachments']);
});

test('sessionRecencyHero — most-recent pulse is the card headline', async () => {
  const { sessionRecencyHero } = await import('../experience/client-core.mjs');
  const tool = sessionRecencyHero({
    status: 'active',
    last_event: 'tool_call',
    last_tool: { key: 'read', tool: 'Read', where: 'D:/x/a.mjs', why: null },
  });
  assert.equal(tool.status, 'active');
  assert.equal(tool.mark, '●');
  assert.equal(tool.event, 'tool_call');
  assert.equal(tool.label, 'read', 'canonical key, not raw tool name');
  assert.equal(tool.detail, 'a.mjs');

  const bash = sessionRecencyHero({
    status: 'active',
    last_event: 'tool_call',
    last_tool: { key: 'bash_run', tool: 'Bash', where: null, why: 'npm test -- --watch' },
  });
  assert.equal(bash.label, 'bash_run');
  assert.equal(bash.detail, 'npm test -- --watch', 'why fallback when no where');

  const think = sessionRecencyHero({ status: 'active', last_event: 'thinking', last_tool: null });
  assert.equal(think.label, 'thinking');
  assert.equal(think.detail, null);

  const idle = sessionRecencyHero({ status: 'idle', last_event: 'words', last_preview: 'hello' });
  assert.equal(idle.mark, '○');
  assert.equal(idle.label, 'words');

  const other = sessionRecencyHero({ status: 'active', last_event: 'mystery' });
  assert.equal(other.event, 'other');
  assert.equal(other.label, 'other');
});

test('sessionToolChips — mapping-style key×count cells, hottest first', async () => {
  const { sessionToolChips } = await import('../experience/client-core.mjs');
  assert.deepEqual(sessionToolChips(null), []);
  assert.deepEqual(sessionToolChips({ tools_by_key: {} }), []);

  const chips = sessionToolChips({
    tools_by_key: { read: 12, edit: 3, bash_run: 5, other: 1, write: 2 },
  }, { max: 4 });
  assert.equal(chips.length, 4);
  assert.deepEqual(chips.map(c => c.key), ['read', 'bash_run', 'edit', 'write']);
  assert.deepEqual(chips.map(c => c.count), [12, 5, 3, 2]);
  assert.ok(chips.every(c => c.cls === 'mc-chip mc-chip--' + c.key));
});

test('mcCardFlipPlan — reorder deltas + enter flag for new cards', async () => {
  const { mcCardFlipPlan, MC_CARD_MOVE_MS } = await import('../experience/client-core.mjs');
  assert.ok(MC_CARD_MOVE_MS > 0 && MC_CARD_MOVE_MS <= 250);

  const prev = new Map([
    ['a', { left: 0, top: 0, width: 100, height: 40 }],
    ['b', { left: 0, top: 50, width: 100, height: 40 }],
  ]);
  const next = new Map([
    ['b', { left: 0, top: 0, width: 100, height: 40 }],   // moved up
    ['a', { left: 0, top: 50, width: 100, height: 40 }],  // moved down
    ['c', { left: 0, top: 100, width: 100, height: 40 }], // new
  ]);
  const plan = mcCardFlipPlan(prev, next);
  const by = Object.fromEntries(plan.map(p => [p.sid, p]));
  assert.equal(by.b.dx, 0);
  assert.equal(by.b.dy, 50, 'invert: was at 50, now at 0 → +50 translate');
  assert.equal(by.a.dy, -50);
  assert.equal(by.c.enter, true);
  assert.equal(by.c.dx, 0);
  assert.equal(by.b.enter, false);

  assert.deepEqual(mcCardFlipPlan(prev, prev), [], 'no motion when rects unchanged');
});

test('mcCardOrderKey — includes status so active↔idle triggers motion', async () => {
  const { mcCardOrderKey } = await import('../experience/client-core.mjs');
  assert.equal(mcCardOrderKey([{ session_id: 'a', status: 'active' }, { session_id: 'b', status: 'idle' }]), 'a:active|b:idle');
  assert.notEqual(
    mcCardOrderKey([{ session_id: 'a', status: 'active' }]),
    mcCardOrderKey([{ session_id: 'a', status: 'idle' }]),
  );
  assert.equal(mcCardOrderKey([]), '');
  assert.equal(mcCardOrderKey(null), '');
});

test('actionItemClasses — encodes pulse type + error flag', async () => {
  const { actionItemClasses } = await import('../experience/client-core.mjs');
  assert.equal(actionItemClasses({ type: 'thinking' }), 'mc-act mc-act--thinking');
  assert.equal(actionItemClasses({ type: 'tool_error', error: true }), 'mc-act mc-act--tool_error mc-act--err');
  assert.equal(actionItemClasses({ type: 'attachment', subtype: 'file' }), 'mc-act mc-act--attachment');
  assert.equal(actionItemClasses({ type: 'Weird Type' }), 'mc-act mc-act--other');
  assert.equal(actionItemClasses(null), 'mc-act mc-act--other');
});

test('pressureFillClasses / ctxSegClasses — fill and strip modifiers', async () => {
  const { pressureFillClasses, ctxSegClasses } = await import('../experience/client-core.mjs');
  assert.equal(pressureFillClasses('lo'), 'mc-pressure__fill mc-pressure__fill--lo');
  assert.equal(pressureFillClasses('hi'), 'mc-pressure__fill mc-pressure__fill--hi');
  assert.equal(pressureFillClasses(null), 'mc-pressure__fill');
  assert.equal(ctxSegClasses({ isCurrent: false }), 'mc-ctxseg');
  assert.equal(ctxSegClasses({ isCurrent: true }), 'mc-ctxseg mc-ctxseg--cur');
});

test('missionControlLegend — pulse + state grammar entries for the /now legend strip', async () => {
  const { missionControlLegend } = await import('../experience/client-core.mjs');
  const L = missionControlLegend();
  assert.ok(Array.isArray(L.status) && L.status.length >= 2);
  assert.ok(L.status.every(x => x.swatch && x.label && x.mod));
  assert.deepEqual(L.status.map(x => x.mod).sort(), ['active', 'idle']);

  const evtMods = L.events.map(x => x.mod);
  for (const need of ['tool_call', 'thinking', 'human_turn', 'compact', 'tool_error', 'api_error']) {
    assert.ok(evtMods.includes(need), 'events include ' + need);
  }
  assert.ok(L.events.every(x => x.swatch && x.label && !String(x.mod).startsWith('evt-')));

  assert.deepEqual(L.pressure.map(x => x.mod), ['lo', 'mid', 'hi']);
  assert.ok(L.status.every(x => /active|idle/i.test(x.label)));
  const alertFlag = L.flags.find(x => x.mod === 'alert');
  assert.ok(alertFlag);
  assert.equal(alertFlag.label, 'errors');
  assert.ok(L.flags.some(x => x.mod === 'thinking-live'));
  assert.ok(Array.isArray(L.tools) && L.tools.some(t => t.mod === 'read'));
  for (const need of ['tokens', 'words', 'permission', 'mode_shift']) {
    assert.ok(L.events.some(e => e.mod === need), 'legend covers rail event ' + need);
  }
});

test('mcMotionAllowed — respects prefers-reduced-motion', async () => {
  const { mcMotionAllowed } = await import('../experience/client-core.mjs');
  assert.equal(mcMotionAllowed({ matches: false }), true);
  assert.equal(mcMotionAllowed({ matches: true }), false);
  assert.equal(mcMotionAllowed(null), true);
});

test('filterMissionSessions — hide idles, pins survive, dismissed until active', async () => {
  const { filterMissionSessions } = await import('../experience/client-core.mjs');
  const sessions = [
    { session_id: 'a', status: 'active' },
    { session_id: 'b', status: 'idle' },
    { session_id: 'c', status: 'idle' },
    { session_id: 'd', status: 'idle' },
  ];
  assert.equal(filterMissionSessions(sessions, {}).length, 4);

  const hidden = filterMissionSessions(sessions, {
    hideIdles: true,
    pinned: new Set(['c']),
  });
  assert.deepEqual(hidden.map(s => s.session_id), ['a', 'c'], 'pinned idle stays when hide on');

  const cleared = filterMissionSessions(sessions, {
    dismissed: new Set(['b', 'd']),
  });
  assert.deepEqual(cleared.map(s => s.session_id), ['a', 'c']);

  // Dismissed session that goes active returns.
  const back = filterMissionSessions(
    [{ session_id: 'b', status: 'active' }, { session_id: 'd', status: 'idle' }],
    { dismissed: new Set(['b', 'd']) },
  );
  assert.deepEqual(back.map(s => s.session_id), ['b']);
});

test('sessionPulseFlow — last N feed glyphs for live work stream', async () => {
  const { sessionPulseFlow } = await import('../experience/client-core.mjs');
  assert.deepEqual(sessionPulseFlow(null), []);
  const actions = [
    { type: 'tool_call', key: 'read' },
    { type: 'tool_call', key: 'edit' },
    { type: 'human_turn' },
    { type: 'compact' },
    { type: 'tool_error', error: true },
  ];
  const flow = sessionPulseFlow(actions, 3);
  assert.equal(flow.length, 3);
  assert.deepEqual(flow.map(f => f.type), ['human_turn', 'compact', 'tool_error']);
  assert.ok(flow.every(f => f.glyph && f.cls.includes('mc-flow__beat')));
  assert.equal(flow[2].cls.includes('mc-flow__beat--err'), true);
});

test('idleIdsToClear — idle sessions not pinned', async () => {
  const { idleIdsToClear } = await import('../experience/client-core.mjs');
  const ids = idleIdsToClear(
    [
      { session_id: 'a', status: 'active' },
      { session_id: 'b', status: 'idle' },
      { session_id: 'c', status: 'idle' },
    ],
    new Set(['c']),
  );
  assert.deepEqual(ids, ['b']);
});

test('groupSessionsByHarness — clear lanes, active-first within harness', async () => {
  const { groupSessionsByHarness } = await import('../experience/client-core.mjs');
  assert.deepEqual(groupSessionsByHarness(null), []);
  const lanes = groupSessionsByHarness([
    { session_id: '1', harness: 'grok', status: 'idle', last_seen: 10 },
    { session_id: '2', harness: 'claude-code', status: 'active', last_seen: 30 },
    { session_id: '3', harness: 'claude-code', status: 'idle', last_seen: 40 },
    { session_id: '4', harness: 'grok', status: 'active', last_seen: 20 },
  ], ['claude-code', 'grok', 'opencode']);
  assert.deepEqual(lanes.map(l => l.harness), ['claude-code', 'grok']);
  assert.deepEqual(lanes[0].sessions.map(s => s.session_id), ['2', '3'], 'active before idle');
  assert.deepEqual(lanes[1].sessions.map(s => s.session_id), ['4', '1']);
  assert.equal(lanes.find(l => l.harness === 'opencode'), undefined, 'empty harnesses omitted');
});

test('sessionLegend — newest-first distinct sessions with latest context pressure', async () => {
  const { sessionLegend } = await import('../experience/client-core.mjs');
  const ring = [
    { type: 'tokens', ts: 1, slug: 'aaaa1111', project: 'pA', color: '#111111', input: 10_000, cache_read: 30_000 },
    { type: 'tool_call', ts: 2, slug: 'bbbb2222', project: 'pB', color: '#222222', tool: 'Read' },
    { type: 'tokens', ts: 3, slug: 'aaaa1111', project: 'pA', color: '#111111', input: 20_000, cache_read: 80_000 },
  ];
  const legend = sessionLegend(ring, 6, 200_000);
  assert.equal(legend.length, 2);
  assert.equal(legend[0].slug, 'aaaa1111', 'most recent first');
  assert.equal(legend[0].pressure, 0.5, 'latest tokens pulse wins (20k+80k of 200k)');
  assert.equal(legend[1].slug, 'bbbb2222');
  assert.equal(legend[1].pressure, null, 'no tokens seen → unknown pressure');
  assert.equal(sessionLegend(ring, 1, 200_000).length, 1, 'max cap');
});

// ── cluster geometry + visibility ─────────────────────────────────────────────

test('nodeRadius — cluster scales between CL_MIN and CL_MAX', async () => {
  const { NODE_RADII } = await import('../experience/client-core.mjs');
  assert.equal(NODE_RADII.CL_MIN, 12);
  assert.equal(NODE_RADII.CL_MAX, 24);
  assert.equal(nodeRadius({ type: 'cluster', sizeNorm: 0 }), 12);
  assert.equal(nodeRadius({ type: 'cluster', sizeNorm: 1 }), 24);
  assert.equal(nodeRadius({ type: 'cluster', sizeNorm: 0.5 }), 18);
  assert.equal(nodeRadius({ type: 'cluster' }), 12, 'missing sizeNorm defaults to 0');
});

test('EDGE styles — bundle + spawn entries present in the client-core copies', async () => {
  const { EDGE_OPACITY, EDGE_WIDTH } = await import('../experience/client-core.mjs');
  assert.equal(EDGE_COLORS.bundle, '#4a3a7a');
  assert.equal(EDGE_COLORS.spawn, '#cc2244');
  assert.equal(typeof EDGE_OPACITY.bundle, 'number');
  assert.equal(typeof EDGE_WIDTH.bundle, 'number');
  assert.equal(typeof EDGE_OPACITY.spawn, 'number');
  assert.equal(typeof EDGE_WIDTH.spawn, 'number');
});

test('nodeRadius — subagent fixed small radius', () => {
  assert.equal(nodeRadius({ type: 'subagent' }), 4);
  assert.equal(nodeRadius({ type: 'subagent', sizeNorm: 1 }), 4);
});

test('computeClusterHidden', async t => {
  const { computeClusterHidden } = await import('../experience/client-core.mjs');
  const nodes = [
    { id: 'proj-a', type: 'project' },
    { id: 's1', type: 'session', project_id: 'proj-a', date_str: '2026-05-01', cluster_id: 'cl1' },
    { id: 's2', type: 'session', project_id: 'proj-a', date_str: '2026-05-02', cluster_id: 'cl1' },
    { id: 's3', type: 'session', project_id: 'proj-a', date_str: '2026-05-03', cluster_id: null },
    { id: 'cl1', type: 'cluster', project_id: 'proj-a', member_ids: ['s1', 's2'] },
  ];

  await t.test('bundleOn false → hides all cluster nodes, nothing else', () => {
    const hidden = computeClusterHidden(nodes, { bundleOn: false, expanded: new Set(), filters: {} });
    assert.deepEqual([...hidden], ['cl1']);
  });

  await t.test('collapsed cluster → members hidden, cluster visible', () => {
    const hidden = computeClusterHidden(nodes, { bundleOn: true, expanded: new Set(), filters: {} });
    assert.ok(hidden.has('s1'));
    assert.ok(hidden.has('s2'));
    assert.ok(!hidden.has('cl1'));
    assert.ok(!hidden.has('s3'), 'unclustered session unaffected');
  });

  await t.test('expanded cluster → nothing hidden by the helper', () => {
    const hidden = computeClusterHidden(nodes, { bundleOn: true, expanded: new Set(['cl1']), filters: {} });
    assert.equal(hidden.size, 0);
  });

  await t.test('cluster with zero filter-passing members is hidden too', () => {
    const hidden = computeClusterHidden(nodes, {
      bundleOn: true, expanded: new Set(), filters: { from: '2026-06-01' },
    });
    assert.ok(hidden.has('cl1'));
  });

  await t.test('defaults are safe (no opts)', () => {
    const hidden = computeClusterHidden(nodes);
    assert.ok(hidden.has('s1') && hidden.has('s2') && !hidden.has('cl1'));
  });
});

test('dominantTool — highest-count [name, count] entry, shared by contextStripSegments and the trace panel', async () => {
  const { dominantTool } = await import('../experience/client-core.mjs');
  assert.equal(dominantTool(null), null);
  assert.equal(dominantTool(undefined), null);
  assert.equal(dominantTool({}), null);
  assert.deepEqual(dominantTool({ Write: 5, Read: 2 }), ['Write', 5]);
  assert.deepEqual(dominantTool({ Bash: 3 }), ['Bash', 3]);
});

test('contextStripSegments — proportional by token weight, colored by dominant tool', async () => {
  const { contextStripSegments, MIN_STRIP_PCT } = await import('../experience/client-core.mjs');
  assert.equal(MIN_STRIP_PCT, 5, 'floor matches proportional-strip skill / panel');
  assert.deepEqual(contextStripSegments(null), []);
  assert.deepEqual(contextStripSegments([]), []);

  const segs = contextStripSegments([
    { tokens: { output: 300, cache_read: 0 }, tool_summary: { Write: 5, Read: 2 }, user_turns: 1, assistant_turns: 2 },
    { tokens: { output: 100, cache_read: 0 }, tool_summary: { Bash: 3 }, user_turns: 1, assistant_turns: 1 },
  ], '#888888');
  assert.equal(segs.length, 2);
  assert.equal(segs[0].tool, 'Write', 'dominant tool by call count');
  assert.equal(segs[0].color, TOOL_COLORS.Write);
  assert.ok(segs[0].pct > segs[1].pct, 'bigger token weight → bigger share');
  assert.equal(segs[0].turns, 3);
  assert.equal(segs[0].index, 0);
  assert.equal(segs[1].index, 1);

  const noSummary = contextStripSegments([{ tokens: { output: 10, cache_read: 0 } }], '#123456');
  assert.equal(noSummary[0].tool, null);
  assert.equal(noSummary[0].color, '#123456', 'falls back to session color when no dominant tool');
});

test('contextStripSegments — tiny window still gets MIN_STRIP_PCT floor', async () => {
  const { contextStripSegments, MIN_STRIP_PCT } = await import('../experience/client-core.mjs');
  const segs = contextStripSegments([
    { tokens: { output: 10000, cache_read: 0 }, tool_summary: { Read: 1 } },
    { tokens: { output: 1, cache_read: 0 }, tool_summary: { Bash: 1 } },
  ]);
  assert.equal(segs[1].pct, MIN_STRIP_PCT);
});

test('contextStripSegments — isCurrent + badges from segment fields', async () => {
  const { contextStripSegments } = await import('../experience/client-core.mjs');
  const segs = contextStripSegments([
    {
      tokens: { output: 100, cache_read: 0 },
      tool_summary: { Read: 2 },
      compact_trigger: 'manual',
      subagent_count: 2,
      thinking_count: 5,
      branches: ['main', 'feat'],
    },
    {
      tokens: { output: 200, cache_read: 0 },
      tool_summary: { Write: 3 },
      compact_trigger: null,
      subagent_count: 0,
      thinking_count: 1,
      branches: ['main'],
    },
  ]);
  assert.equal(segs[0].isCurrent, false);
  assert.deepEqual(segs[0].badges, { subagents: 2, thinking: 5, branches: 2 });
  assert.equal(segs[1].isCurrent, true, 'open window = compact_trigger null');
  assert.deepEqual(segs[1].badges, { subagents: 0, thinking: 1, branches: 1 });
});

test('buildShareCardData — assembles a session node into card data (single source for preview/share/download)', async () => {
  const { buildShareCardData } = await import('../experience/client-core.mjs');
  const node = {
    id: 's1', label: 'fix-bug', ai_title: 'Fix the flaky test', harness: 'claude-code',
    project_id: 'proj-a', date_str: '2026-08-01', duration_min: 12.3, model: 'claude-sonnet-5',
    tokens_total: 42000, tokens_work: 9000, cache_hit_rate: 88.5,
    tool_calls: 40, tool_errors: 2, tool_diversity: 6, subagent_count: 1, context_resets: 2,
    skills: ['code-review', 'run'], color: '#ff8800',
  };
  const data = buildShareCardData(node, { projectLabel: 'kaaroSessions' });
  assert.equal(data.sessionLabel, 'Fix the flaky test', 'ai_title wins over label');
  assert.equal(data.project, 'kaaroSessions');
  assert.equal(data.tokens_total, 42000);
  assert.equal(data.context_resets, 2);
  assert.equal(data.segments.length, 0, 'no traceSegments opt → empty, SVG generator supplies the placeholder');
  assert.deepEqual(data.skills, ['code-review', 'run']);

  const bare = buildShareCardData({ session_id: 's2' });
  assert.equal(bare.sessionLabel, 'session', 'graceful defaults with a near-empty node');
  assert.equal(bare.tokens_total, 0);
});

test('generateShareCardSVG — 1200×630, escapes user text, one strip per segment, placeholder when none', async () => {
  const { buildShareCardData, generateShareCardSVG } = await import('../experience/client-core.mjs');

  const withSegs = buildShareCardData(
    { id: 's1', ai_title: 'Refactor <script>alert(1)</script>', harness: 'grok', tokens_total: 1000, tokens_work: 500, tool_calls: 10, context_resets: 1, skills: ['note'] },
    { projectLabel: 'p', traceSegments: [
      { tokens: { output: 300, cache_read: 0 }, tool_summary: { Write: 1 } },
      { tokens: { output: 200, cache_read: 0 }, tool_summary: { Read: 1 } },
    ] },
  );
  const svg = generateShareCardSVG(withSegs);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('width="1200" height="630"'));
  assert.ok(!svg.includes('<script>alert'), 'session title is escaped, not injected raw');
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.equal((svg.match(/<rect[^>]*fill="#[0-9a-f]{6}"[^>]*><title>/gi) || []).length, 2, 'one strip rect per segment');
  assert.ok(svg.includes('GROK'));
  assert.ok(svg.includes('1k'), 'consumption stat formatted via fmtTok');

  const noSegs = generateShareCardSVG(buildShareCardData({ id: 's2', label: 'plain', harness: 'pi', tokens_work: 400 }));
  assert.equal((noSegs.match(/<title>/gi) || []).length, 1, 'placeholder single strip when no trace segments');
});

test('generateShareCardSVG / generateProjectShareCardSVG — footer tagLine (skill tags) is escaped, not injected raw', async () => {
  const { buildShareCardData, generateShareCardSVG, buildProjectShareCardData, generateProjectShareCardSVG } =
    await import('../experience/client-core.mjs');

  const sessionSvg = generateShareCardSVG(buildShareCardData(
    { id: 's1', label: 's1', harness: 'claude-code', skills: ['<script>alert(1)</script>'] },
  ));
  assert.ok(!sessionSvg.includes('<script>alert'), 'session card footer escapes skill tags');
  assert.ok(sessionSvg.includes('&lt;script&gt;'));

  const projectSvg = generateProjectShareCardSVG(buildProjectShareCardData(
    { id: 'p1', label: 'p1', skills: ['<script>alert(1)</script>'] },
  ));
  assert.ok(!projectSvg.includes('<script>alert'), 'project card footer escapes skill tags');
  assert.ok(projectSvg.includes('&lt;script&gt;'));
});

test('buildShareText — plain-text twin, no live URL (local tool)', async () => {
  const { buildShareCardData, buildShareText } = await import('../experience/client-core.mjs');
  const data = buildShareCardData({ id: 's1', ai_title: 'Ship the thing', harness: 'claude-code', tokens_total: 5000, tool_calls: 12, context_resets: 3 }, { projectLabel: 'kaaroSessions' });
  const text = buildShareText(data);
  assert.ok(text.includes('Ship the thing'));
  assert.ok(text.includes('4 context windows'), 'context_resets + 1');
  assert.ok(text.includes('kaaroSessions'));
  assert.ok(!/https?:\/\//.test(text), 'no fabricated public URL for a local tool');
});

test('buildProjectShareCardData / generateProjectShareCardSVG — harness breakdown bars', async () => {
  const { buildProjectShareCardData, generateProjectShareCardSVG, buildShareText } = await import('../experience/client-core.mjs');
  const node = {
    id: 'proj-a', label: 'kaaroSessions', session_count: 12, tokens_total: 900000, tokens_work: 200000,
    skills: ['code-review'], last_activity: '2026-08-27T10:00:00Z', color: '#ff6600',
  };
  const harnessRows = [
    { harness: 'claude-code', count: 8, color: '#2a9d8f' },
    { harness: 'grok', count: 4, color: '#cc4488' },
  ];
  const data = buildProjectShareCardData(node, { harnessRows });
  assert.equal(data.kind, 'project');
  assert.equal(data.session_count, 12);
  assert.deepEqual(data.harnessRows, harnessRows);

  const svg = generateProjectShareCardSVG(data);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('width="1200" height="630"'));
  assert.ok(svg.includes('kaaroSessions'));
  assert.ok(svg.includes('claude-code · 8'));
  assert.ok(svg.includes('grok · 4'));
  assert.ok(svg.includes('PROJECT CARD'));

  const noRows = generateProjectShareCardSVG(buildProjectShareCardData({ id: 'p2', label: 'solo', session_count: 3 }));
  assert.ok(noRows.includes('unknown · 3'), 'falls back to a single unknown-harness bar');

  const text = buildShareText(data);
  assert.ok(text.includes('kaaroSessions'));
  assert.ok(text.includes('12 sessions'));
});

test('buildUsageShareCardData / generateUsageShareCardSVG — full-canvas card from meGlyph()', async () => {
  const { buildUsageShareCardData, generateUsageShareCardSVG, buildShareText, meGlyph } = await import('../experience/client-core.mjs');
  const sessions = [
    { harness: 'claude-code' }, { harness: 'claude-code' }, { harness: 'grok' },
  ];
  const me = meGlyph(sessions);
  const data = buildUsageShareCardData(me, { projectCount: 5, tokensTotal: 1_200_000, dateFrom: '2026-01-01', dateTo: '2026-08-27' });
  assert.equal(data.kind, 'usage');
  assert.equal(data.total_sessions, 3);
  assert.equal(data.rows.length, 2);

  const svg = generateUsageShareCardSVG(data);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('FULL USAGE CANVAS'));
  assert.ok(svg.includes('2026-01-01 → 2026-08-27'));
  assert.ok(svg.includes('claude-code'));
  assert.ok(svg.includes('1.2M'), 'consumption formatted via fmtTok');

  const empty = generateUsageShareCardSVG(buildUsageShareCardData(meGlyph([]), {}));
  assert.ok(empty.startsWith('<svg'), 'renders even with no sessions');

  const text = buildShareText(data);
  assert.ok(text.includes('3 sessions'));
  assert.ok(text.includes('5 projects'));
});

test('buildUsageShareCardData — constellation: sessions ranked by their project\'s consumption, projects keep their full render fields', async () => {
  const { buildUsageShareCardData, meGlyph } = await import('../experience/client-core.mjs');
  const projects = [
    { id: 'p1', label: 'small', color: '#111111', harnesses: ['pi'], sizeNorm: 0.1, tokens_total: 1000 },
    { id: 'p2', label: 'big', color: '#222222', harnesses: ['claude-code'], inFlight: true, sizeNorm: 0.9, tokens_total: 900000 },
  ];
  const sessions = [
    { project_id: 'p1', color: '#111111', tool_diversity: 2, date_str: '2026-01-01' },
    { project_id: 'p2', color: '#222222', tool_diversity: 6, date_str: '2026-02-01' },
    { project_id: 'p2', color: '#222222', tool_diversity: 4, date_str: '2026-01-15' },
  ];
  const data = buildUsageShareCardData(meGlyph([]), { projects, sessions });
  assert.equal(data.project_count, 2, 'falls back to projects.length when projectCount is not supplied');
  assert.equal(data.topProject, 'big', 'top project = highest tokens_total');
  assert.equal(data.projects[0].label, 'big', 'projects sorted by tokens_total descending');
  assert.equal(data.projects[0].inFlight, true, 'render fields (color/harnesses/inFlight/sizeNorm) survive for the hex layer');
  assert.equal(data.sessions.length, 3);
  assert.equal(data.sessions[0].color, '#222222', 'the biggest project\'s sessions sort first, closest to center');
  assert.equal(data.sessions[1].color, '#222222');
  assert.equal(data.sessions[0].diversity, 4, 'within a project, sessions sort by date ascending (2026-01-15 before 2026-02-01)');
  assert.equal(data.sessions[1].diversity, 6);
  assert.equal(data.sessions[2].color, '#111111');
});

test('generateUsageShareCardSVG — constellation: one hex per project over one ball per session, ME hero big + right-half + vertically centered, overflow noted past either cap', async () => {
  const { buildUsageShareCardData, generateUsageShareCardSVG, meGlyph } = await import('../experience/client-core.mjs');
  const projects = Array.from({ length: 3 }, (_, i) => ({
    id: 'p' + i, label: 'proj' + i, color: '#334455', harnesses: ['claude-code'], sizeNorm: 0.5, tokens_total: 100 - i,
  }));
  const sessions = Array.from({ length: 5 }, (_, i) => ({
    project_id: 'p0', color: '#556677', tool_diversity: i + 1, date_str: '2026-01-0' + (i + 1),
  }));
  const data = buildUsageShareCardData(meGlyph([{ harness: 'claude-code' }]), { projects, sessions });
  const svg = generateUsageShareCardSVG(data);

  assert.equal((svg.match(/<circle cx="[^"]*" cy="[^"]*" r="[^"]*" fill="#556677"/g) || []).length, sessions.length, 'one ball per session');
  assert.equal((svg.match(/<g transform="translate\([^)]*\)">\s*<circle[^>]*fill="#000000"/g) || []).length, projects.length, 'one backing-cleared hex group per project');
  assert.ok(svg.includes('hex = project'));
  assert.ok(svg.includes('ball = session'));
  assert.ok(!svg.includes('more'), 'no overflow note under either cap');

  // ME hero: right half of the right column, vertically centered in the body.
  const g = { width: 1200, height: 630, headerH: 80, footerH: 70, bodyTop: 80, bodyBot: 560, dividerX: 660, leftPad: 55, rightPad: 700 };
  const expectX = (g.rightPad + (g.width - g.leftPad - g.rightPad) * 0.72).toFixed(1);
  const expectY = ((g.bodyTop + g.bodyBot) / 2).toFixed(1);
  assert.ok(svg.includes(`translate(${expectX},${expectY})`), 'ME hero sits right-half + vertically centered');
  assert.ok(svg.includes('r="66"'), 'ME hero backing ring reflects the bigger, more prominent hex (r=56 + 10)');

  const manyProjects = Array.from({ length: 65 }, (_, i) => ({ id: 'q' + i, label: 'q' + i, color: '#334455', tokens_total: 1 }));
  const manySessions = Array.from({ length: 205 }, () => ({ project_id: 'q0', color: '#556677', tool_diversity: 1 }));
  const overflowSvg = generateUsageShareCardSVG(buildUsageShareCardData(meGlyph([]), { projects: manyProjects, sessions: manySessions }));
  assert.ok(overflowSvg.includes('+5 projects'), '65 projects, 60-cap → 5 overflow');
  assert.ok(overflowSvg.includes('+5 sessions'), '205 sessions, 200-cap → 5 overflow');
});
