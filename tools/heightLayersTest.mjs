/**
 * Headless checks for the height stack (v3/terrain/heightLayers.js) and River
 * v2's CPU terrain operator (v3/tools/riverV2Terrain.js).
 *
 * The one that matters most is 4: a pad (a STAMP) inside a river's footprint
 * survives any number of river re-conforms. Before the stack, the river rebuilt
 * the whole terrain from its own copy of the ground and nam-rts lost its pads.
 * Run: node tools/heightLayersTest.mjs   (picked up by npm test)
 */
import { createHeightLayers } from "../v3/terrain/heightLayers.js";
import { buildRiverTerrainOp, riverDirtyRect, snapshotRiverPath } from "../v3/tools/riverV2Terrain.js";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

const S = 128;
const U = { bedCurve: 0.55, freeboardN: 0.6 / 250, lipFrac: 0.28, slopeToUv: 250 / (0.9 * 1024), flareMax: 4 };
const MAXP = 64;

/** A ground that tilts gently in x, in normalized height. */
function makeGround() {
  const g = new Float32Array(S * S);
  for (let z = 0; z < S; z++) for (let x = 0; x < S; x++) g[z * S + x] = 0.2 + 0.1 * (x / S);
  return g;
}

/**
 * Path data for rivers given as polylines of [u, v] with a constant level,
 * half width, depth and bank (UV / normalized units, as the GPU uploads them).
 */
function makeRiver(polys, { level = 0.24, halfW = 0.03, depth = 0.01, bank = 0.02, mouth = null } = {}) {
  const P = new Float32Array(MAXP * 2 * 4);
  const R1 = MAXP * 4;
  const layout = [];
  let off = 0;
  for (const pts of polys) {
    pts.forEach(([u, v], k) => {
      const j = off + k;
      P[j * 4] = u; P[j * 4 + 1] = v; P[j * 4 + 2] = level; P[j * 4 + 3] = halfW;
      P[R1 + j * 4] = depth; P[R1 + j * 4 + 1] = bank;
      P[R1 + j * 4 + 2] = mouth ? mouth[0] : -1; P[R1 + j * 4 + 3] = mouth ? mouth[1] : 0;
    });
    layout.push({ offset: off, count: pts.length });
    off += pts.length;
  }
  return { pathData: P, rowStride: R1, layout, size: S, u: U };
}

const inRect = (r, x, z) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
const FULL = { x0: 0, z0: 0, x1: S - 1, z1: S - 1 };

// ── 1. An empty stack is the ground ─────────────────────────────────────────
{
  const final = new Float32Array(S * S);
  const L = createHeightLayers({ final, size: S });
  const g = makeGround();
  L.reset(g);
  L.compose(FULL);
  ok("empty stack: FINAL is GROUND, bit for bit", final.every((v, i) => v === g[i]));
}

// ── 2. The river changes its footprint and nothing else ─────────────────────
const straight = makeRiver([[[0.1, 0.5], [0.3, 0.5], [0.5, 0.5], [0.7, 0.5], [0.9, 0.5]]]);
{
  const final = new Float32Array(S * S);
  const L = createHeightLayers({ final, size: S });
  const g = makeGround();
  L.reset(g);
  const op = buildRiverTerrainOp(straight);
  L.setRiver(op);
  let outside = 0, cut = 0;
  for (let z = 0; z < S; z++) for (let x = 0; x < S; x++) {
    const i = z * S + x;
    if (!inRect(op.rect, x, z) && final[i] !== g[i]) outside++;
    if (final[i] < g[i] - 1e-4) cut++;
  }
  ok("river writes nothing outside its footprint rect", outside === 0, `${outside} texels`);
  ok("river actually cuts a channel", cut > 50, `${cut} texels cut`);
  const c = Math.floor(0.5 * S) * S + Math.floor(0.5 * S);
  ok("centreline bed = level − depth", Math.abs(final[c] - (0.24 - 0.01)) < 2e-4, `${final[c]}`);
  L.setRiver(null);
  ok("removing the river restores the ground exactly", final.every((v, i) => v === g[i]));
}

// ── 3. The river never reads the stamps (they sit above it) ─────────────────
// ── 4. A pad inside the river's footprint survives any re-conform ───────────
{
  const final = new Float32Array(S * S);
  const L = createHeightLayers({ final, size: S });
  L.reset(makeGround());
  L.setRiver(buildRiverTerrainOp(straight));
  const riverOnly = Float32Array.from(final);
  // A pad on the bank, overlapping the channel: flat at 0.25 in its rect.
  const pad = { x0: 60, z0: 62, x1: 70, z1: 70 };
  L.addStamp("pad", pad, (map, r) => {
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) map[z * S + x] = 0.25;
  });
  const padFlat = () => {
    for (let z = pad.z0; z <= pad.z1; z++) for (let x = pad.x0; x <= pad.x1; x++) if (final[z * S + x] !== 0.25) return false;
    return true;
  };
  ok("stamp over the river: pad is flat", padFlat());
  // Re-conform the river ten times, as a drag would, and once with a moved river.
  for (let k = 0; k < 10; k++) L.setRiver(buildRiverTerrainOp(straight));
  ok("pad still flat after 10 river re-conforms (the lost-pads bug)", padFlat());
  L.setRiver(buildRiverTerrainOp(makeRiver([[[0.1, 0.52], [0.5, 0.52], [0.9, 0.52]]])));
  ok("pad still flat after the river MOVES", padFlat());
  L.setRiver(buildRiverTerrainOp(straight));
  let same = true;
  for (let i = 0; i < S * S; i++) {
    const x = i % S, z = (i / S) | 0;
    if (!inRect(pad, x, z) && final[i] !== riverOnly[i]) { same = false; break; }
  }
  ok("outside the pad the river is unchanged by the stamp (it reads GROUND)", same);
  L.removeStamp("pad");
  ok("removing the pad gives back the river-shaped ground", final.every((v, i) => v === riverOnly[i]));
}

// ── 5. Edits made behind the stack's back go into GROUND ────────────────────
{
  const final = new Float32Array(S * S);
  const L = createHeightLayers({ final, size: S });
  const g = makeGround();
  L.reset(g);
  L.setRiver(buildRiverTerrainOp(straight));
  L.takePending();
  // (a) far from the river: a sculpt-like bump written straight into FINAL
  final[10 * S + 10] += 0.05;
  const hitA = L.absorb();
  ok("absorb finds an outside edit", !!hitA && hitA.x0 === 10 && hitA.z0 === 10);
  ok("…takes it into GROUND", Math.abs(L.ground[10 * S + 10] - (g[10 * S + 10] + 0.05)) < 1e-7);
  ok("…and needs no recompose there (FINAL already right)", L.takePending() === null);
  // (b) in the channel: the edit lands in GROUND but the river wins in FINAL
  const c = 64 * S + 64;
  const before = final[c];
  final[c] += 0.05;
  const hitB = L.absorb();
  ok("absorb in the channel: GROUND moved", !!hitB && Math.abs(L.ground[c] - (g[c] + 0.05)) < 1e-7);
  ok("…and the river re-applies over it (bed unchanged)", Math.abs(final[c] - before) < 1e-7);
  ok("…with the rect queued for the GPU", L.takePending() !== null);
  // (c) a half-float readback of untouched heights is not an edit
  const q = (v) => Math.round(v * 2048) / 2048;
  for (let i = 0; i < S * S; i++) final[i] = q(final[i]);
  const hitC = L.absorb(FULL, q);
  ok("quantized re-read of the same heights absorbs nothing", hitC === null);
}

// ── 6. Stamps by key replace, reset clears ──────────────────────────────────
{
  const final = new Float32Array(S * S);
  const L = createHeightLayers({ final, size: S });
  L.reset(makeGround());
  const f = (map, r) => { for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) map[z * S + x] = 0.3; };
  L.addStamp("a", { x0: 1, z0: 1, x1: 4, z1: 4 }, f);
  L.addStamp("a", { x0: 1, z0: 1, x1: 4, z1: 4 }, f);
  L.addStamp(null, { x0: 8, z0: 8, x1: 9, z1: 9 }, f);
  ok("same key replaces, null key adds", L.stampCount === 2, `${L.stampCount}`);
  const g2 = makeGround();
  L.reset(g2);
  ok("reset: no stamps, no river, FINAL = new ground", L.stampCount === 0 && !L.river && final.every((v, i) => v === g2[i]));
}

// ── 7. The operator's nearest search matches brute force on a hairpin ───────
// Two arms 0.06 UV apart but far apart along the river: the case that broke
// the chunked GPU conform twice. The op's grid must still find the true nearest.
{
  const hair = makeRiver([[
    [0.15, 0.40], [0.35, 0.40], [0.55, 0.40], [0.75, 0.40], [0.82, 0.43],
    [0.82, 0.47], [0.75, 0.50], [0.55, 0.50], [0.35, 0.50], [0.15, 0.50],
  ]], { halfW: 0.012, bank: 0.01 });
  const g = makeGround();
  const out = Float32Array.from(g);
  buildRiverTerrainOp(hair).apply(out, g, FULL);

  // Reference: every segment for every texel, the same cross-section.
  const P = hair.pathData, R1 = hair.rowStride;
  const ref = Float32Array.from(g);
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let z = 0; z < S; z++) for (let x = 0; x < S; x++) {
    const uu = (x + 0.5) / S, v = (z + 0.5) / S;
    let bd = 1e9, bk = -1, bt = 0;
    for (let k = 0; k < 9; k++) {
      const ax = P[k * 4], az = P[k * 4 + 1], abx = P[k * 4 + 4] - ax, abz = P[k * 4 + 5] - az;
      const t = Math.min(1, Math.max(0, ((uu - ax) * abx + (v - az) * abz) / Math.max(abx * abx + abz * abz, 1e-12)));
      const d2 = (uu - ax - abx * t) ** 2 + (v - az - abz * t) ** 2;
      if (d2 < bd) { bd = d2; bk = k; bt = t; }
    }
    const a = bk * 4, i = z * S + x, nat = g[i];
    const level = P[a + 2], halfW = P[a + 3], depth = P[R1 + a], bank = P[R1 + a + 1], dist = Math.sqrt(bd);
    if (dist <= halfW) {
      const uc = dist / halfW, flat = 1 - uc ** 8, para = 1 - uc * uc;
      ref[i] = level - depth * (flat + (para - flat) * U.bedCurve);
    } else {
      const rim = level + U.freeboardN;
      const flare = Math.min(bank * U.flareMax, Math.max(bank, Math.abs(nat - rim) * U.slopeToUv));
      const ub = Math.min(1, (dist - halfW) / flare);
      if (ub < 1) {
        const lip = level + (rim - level) * sm(0, U.lipFrac, ub);
        ref[i] = lip + (nat - lip) * sm(U.lipFrac, 1, ub);
      }
    }
  }
  let worst = 0;
  for (let i = 0; i < S * S; i++) worst = Math.max(worst, Math.abs(out[i] - ref[i]));
  ok("river op == brute-force nearest on a hairpin", worst < 1e-6, `worst ${worst}`);
}

// ── 8. An open mouth stops the river dead at the lip ────────────────────────
{
  const g = makeGround();
  const open = makeRiver([[[0.1, 0.5], [0.3, 0.5], [0.5, 0.5]]], { mouth: [0.4, 0.5] });
  const out = Float32Array.from(g);
  buildRiverTerrainOp(open).apply(out, g, FULL);
  const past = Math.floor(0.45 * S), before = Math.floor(0.3 * S), row = Math.floor(0.5 * S) * S;
  ok("past an open mouth: natural ground", out[row + past] === g[row + past]);
  ok("before the mouth: channel (bed = level − depth)", Math.abs(out[row + before] - (0.24 - 0.01)) < 2e-4, `${out[row + before]}`);
}

// ── 9. A drag recomposes only where the river changed — and gets it exact ───
{
  const pts = [[0.1, 0.5], [0.3, 0.5], [0.5, 0.5], [0.7, 0.5], [0.9, 0.5]];
  const A = makeRiver([pts]);
  const moved = pts.map((p, i) => (i === 3 ? [0.7, 0.53] : p));
  const B = makeRiver([moved]);
  const g = makeGround();
  const opA = buildRiverTerrainOp(A), opB = buildRiverTerrainOp(B);
  const dirty = riverDirtyRect(snapshotRiverPath(A, opA.maxReach), snapshotRiverPath(B, opB.maxReach), S);

  const finalP = new Float32Array(S * S), finalF = new Float32Array(S * S);
  const LP = createHeightLayers({ final: finalP, size: S });
  const LF = createHeightLayers({ final: finalF, size: S });
  LP.reset(g); LF.reset(g);
  LP.setRiver(opA); LF.setRiver(opA);
  LP.setRiver(opB, dirty);
  LF.setRiver(opB);
  ok("drag: dirty rect is smaller than the whole river",
    !!dirty && (dirty.x1 - dirty.x0) < (opB.rect.x1 - opB.rect.x0), JSON.stringify(dirty));
  ok("drag: partial recompose == full recompose, bit for bit", finalP.every((v, i) => v === finalF[i]));
  const same = riverDirtyRect(snapshotRiverPath(B, opB.maxReach), snapshotRiverPath(B, opB.maxReach), S);
  ok("no change: nothing to recompose", same === false);
}

// ── 8. Sculpt layers: GROUND = BASE + Σ visible layers × strength ──────────
// A "stroke" here is what a GPU edit looks like to the stack: FINAL written
// behind its back, then absorbed.
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
function stroke(final, L, x0, z0, x1, z1, d, target) {
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) final[z * S + x] += d;
  return L.absorb({ x0, z0, x1, z1 }, null, target);
}
{
  const final = new Float32Array(S * S);
  const L = createHeightLayers({ final, size: S });
  const g = makeGround();
  L.reset(g);
  const i = 20 * S + 20, j = 100 * S + 100;

  stroke(final, L, 10, 10, 30, 30, 0.05);                 // into BASE (active by default)
  const id = L.addLayer("Details");                         // a new layer becomes active
  ok("layers: a new layer is active", L.activeLayer === id);
  stroke(final, L, 15, 15, 25, 25, 0.02);                  // into Details
  ok("layers: final = base edit + layer edit", near(final[i], g[i] + 0.07));

  L.setLayer(id, { visible: false });
  ok("layers: hiding a layer removes only its edit", near(final[i], g[i] + 0.05));
  ok("layers: hiding leaves the rest of the map alone", final[j] === g[j]);
  L.setLayer(id, { visible: true, strength: 0.5 });
  ok("layers: strength scales the layer", near(final[i], g[i] + 0.05 + 0.01));
  L.setLayer(id, { strength: 1 });
  ok("layers: strength back to 1 is exact", near(final[i], g[i] + 0.07));

  // An edit while a layer is at strength 0.5 is stored unscaled, so the next
  // strength change still scales it exactly.
  L.setLayer(id, { strength: 0.5 });
  stroke(final, L, 15, 15, 25, 25, 0.01);
  L.setLayer(id, { strength: 1 });
  ok("layers: an edit at strength 0.5 lands where it was drawn", near(final[i], g[i] + 0.05 + 0.02 + 0.02));
  stroke(final, L, 15, 15, 25, 25, -0.02);                  // back to +0.02 in Details

  // A refused edit is put back.
  L.setLayer(id, { locked: true });
  const before = final[i];
  stroke(final, L, 15, 15, 25, 25, 0.3);
  ok("layers: a locked layer refuses the edit", final[i] === before);
  ok("layers: the refusal is reported", L.takeDiscard()?.target === id);
  ok("layers: the refused rect goes back to the GPU", !!L.takePending());
  L.setLayer(id, { locked: false });

  // Undo of an earlier BASE edit while Details is active: routed by target.
  stroke(final, L, 10, 10, 30, 30, -0.05, 0);
  ok("layers: an edit routed to BASE leaves the active layer alone", near(final[i], g[i] + 0.02));
  L.setLayer(id, { visible: false });
  ok("layers: …so hiding the layer leaves BASE as it was", near(final[i], g[i]));
  L.setLayer(id, { visible: true });

  // Save / load round trip.
  const saved = L.exportLayers();
  ok("layers: export keeps only touched tiles", saved.meta.layers[0].tiles.length === 1, JSON.stringify(saved.meta.layers[0].tiles));
  const final2 = new Float32Array(S * S);
  const L2 = createHeightLayers({ final: final2, size: S });
  L2.reset(Float32Array.from(L.ground), saved);
  ok("layers: load restores the list", L2.listLayers().length === 2 && L2.activeLayer === id);
  ok("layers: load gives the same heights", final2.every((v, k) => near(v, final[k])));
  L2.setLayer(id, { visible: false });
  ok("layers: after load, hiding still removes exactly the layer", near(final2[i], g[i]));

  // Merge down folds the layer into BASE; heights do not move.
  const snap = Float32Array.from(final);
  ok("layers: merge down", L.mergeDown(id));
  ok("layers: merge keeps the heights", final.every((v, k) => near(v, snap[k])));
  ok("layers: merged layer is gone, BASE active", L.listLayers().length === 1 && L.activeLayer === 0);
  ok("layers: nothing left to sum", L.layerSum() === null);

  // Clear and remove.
  const id2 = L.addLayer();
  stroke(final, L, 40, 40, 50, 50, 0.04);
  ok("layers: layerSum is what the layers add", near(L.layerSum()[45 * S + 45], 0.04));
  L.clearLayer(id2);
  ok("layers: clear removes the edit", near(final[45 * S + 45], g[45 * S + 45]));
  ok("layers: remove", L.removeLayer(id2) && L.listLayers().length === 1);
}

// ── 8b. Undo / redo ("history") into a hidden or locked layer ──────────────
{
  const final = new Float32Array(S * S);
  const L = createHeightLayers({ final, size: S });
  const g = makeGround();
  L.reset(g);
  const i = 20 * S + 20;
  const id = L.addLayer();
  stroke(final, L, 15, 15, 25, 25, 0.03);                  // the step, in the layer
  L.setLayer(id, { visible: false });
  // Undo as the GPU does it: the step's change taken off whatever is shown now.
  for (let z = 15; z <= 25; z++) for (let x = 15; x <= 25; x++) final[z * S + x] -= 0.03;
  L.absorb({ x0: 15, z0: 15, x1: 25, z1: 25 }, null, id, { history: true });
  ok("history: undo into a hidden layer does not dent the terrain", near(final[i], g[i]));
  ok("history: …and is not reported as refused", L.takeDiscard() === null);
  L.setLayer(id, { visible: true });
  ok("history: …the stroke really left the layer", near(final[i], g[i]));
  L.setLayer(id, { locked: true });
  stroke(final, L, 15, 15, 25, 25, 0.03, id);              // a plain edit: refused
  ok("history: a locked layer refuses a plain edit", near(final[i], g[i]) && L.takeDiscard() !== null);
  for (let z = 15; z <= 25; z++) for (let x = 15; x <= 25; x++) final[z * S + x] += 0.03;
  L.absorb({ x0: 15, z0: 15, x1: 25, z1: 25 }, null, id, { history: true });
  ok("history: …but takes a redo", near(final[i], g[i] + 0.03));
  L.removeLayer(id);
  for (let z = 15; z <= 25; z++) for (let x = 15; x <= 25; x++) final[z * S + x] -= 0.03;
  L.absorb({ x0: 15, z0: 15, x1: 25, z1: 25 }, null, id, { history: true });
  ok("history: a step of a deleted layer is refused", near(final[i], g[i]) && L.takeDiscard()?.target === id);
}

// ── 9. Layers under a river: the river works on GROUND = BASE + layers ─────
{
  const pts = [[0.1, 0.5], [0.9, 0.5]];
  const final = new Float32Array(S * S);
  const L = createHeightLayers({ final, size: S });
  L.reset(makeGround());
  L.setRiver(buildRiverTerrainOp(makeRiver([pts])));
  const id = L.addLayer();
  const outside = 10 * S + 64;
  stroke(final, L, 60, 5, 68, 15, 0.03);
  ok("layers+river: a layer edit away from the river lands", near(final[outside], makeGround()[outside] + 0.03));
  L.setLayer(id, { visible: false });
  ok("layers+river: hiding it puts the ground back", near(final[outside], makeGround()[outside]));
}

// ── 10. Layers saved for another terrain size are dropped, heights kept ─────
{
  const final = new Float32Array(S * S);
  const L = createHeightLayers({ final, size: S });
  const g = makeGround();
  L.reset(g, { meta: { size: S * 2, tile: 64, layers: [{ id: 1, tiles: [0] }] }, data: new Float32Array(4096) });
  ok("layers: wrong-size layers are dropped", L.listLayers().length === 1);
  ok("layers: …and the heightmap is used as it is", final.every((v, k) => v === g[k]));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
