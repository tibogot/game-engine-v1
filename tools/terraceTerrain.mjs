/**
 * TERRACING — turning a hillside into levels, cliffs and ramps.
 *
 * An RTS reads discrete ground. A cliff is a WALL you understand at a glance;
 * a ramp is a DOOR, and therefore a chokepoint worth fighting over. Continuous
 * rolling terrain photographs better and plays worse, because no part of it is
 * a decision — every slope is a little bit passable and nothing on screen says
 * where the edges are.
 *
 * This runs in NODE, against the .v3proj's heightmap blob, and not in the
 * editor, because terracing is arithmetic over a million texels whose result
 * has to be CHECKED rather than eyeballed: how steep are the new walls, did the
 * plateau stay walkable, did anything get cut off. All of that is measurable
 * here, before the map is ever loaded.
 *
 *   node tools/terraceTerrain.mjs --x -25 --z -250 --r 150 --step 8 [--dry]
 *
 * ── THE ONE SUBTLETY ────────────────────────────────────────────────────────
 *
 * Quantising height to levels does NOT by itself give you cliffs. The width of
 * the transition falls out of the ORIGINAL gradient: on ground that already
 * climbed steeply the step is abrupt, and on gentle ground the same
 * quantisation produces a gentle ramp — which is exactly backwards, because
 * gentle ground is where you most wanted a wall to appear. So the transition
 * band is expressed in METRES OF GROUND (`--cliff`) and converted into a
 * height range per texel using the local gradient. Every wall then comes out
 * the same few metres wide, whatever it was cut from.
 */
import fs from "node:fs";

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const has = (k) => argv.includes(`--${k}`);

const LEVEL = "public/levels/nam-valley.v3proj";
const OPT = {
  cx: arg("x", -25), cz: arg("z", -250), radius: arg("r", 150),
  step: arg("step", 8),          // metres between levels
  cliff: arg("cliff", 3.0),      // how wide a wall is, metres of ground
  minBand: arg("minband", 0.2),  // floor on the transition, metres of height
  feather: arg("feather", 0.22), // outer fraction blended back to the original
  maxSlope: arg("maxslope", 34), // the pathfinder's limit — see navGrid.js
  rampR: arg("rampr", 9),        // radius of a repair ramp, metres
  maxRamps: arg("maxramps", 14),
  dry: has("dry"),
};

/* ── the file ────────────────────────────────────────────────────────────── */
const buf = fs.readFileSync(LEVEL);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
if (buf.toString("ascii", 0, 4) !== "V3PJ") { console.error("bad magic"); process.exit(1); }
const version = dv.getUint32(4, true);
const manLen = dv.getUint32(8, true);
const manifest = JSON.parse(buf.toString("utf8", 12, 12 + manLen));
const payload = buf.subarray(12 + manLen);
const hb = manifest.blobs?.heightmap;
if (!hb) { console.error("no heightmap blob"); process.exit(1); }

const N = manifest.terrain.heightmapSize;
const WS = manifest.terrain.worldSize;
const MH = manifest.terrain.maxHeight;
// Aligned copy: the payload's offset inside the file is not a multiple of 4.
const hCopy = Buffer.from(payload.subarray(hb.offset, hb.offset + hb.length));
const norm = new Float32Array(hCopy.buffer, hCopy.byteOffset, hb.length / 4);
const H = new Float32Array(norm.length);          // METRES; nobody thinks in 0..1
for (let i = 0; i < H.length; i++) H[i] = norm[i] * MH;
const ORIG = Float32Array.from(H);

const M_PER_TEXEL = WS / N;
const toTexel = (w) => (w + WS / 2) / WS * (N - 1);
const idx = (ix, iz) => iz * N + ix;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, t) => {
  const x = clamp((t - a) / (b - a || 1e-9), 0, 1);
  return x * x * (3 - 2 * x);
};

/** |∇h| in metres per metre, from the ORIGINAL surface. */
function gradAt(src, ix, iz) {
  const x0 = Math.max(0, ix - 1), x1 = Math.min(N - 1, ix + 1);
  const z0 = Math.max(0, iz - 1), z1 = Math.min(N - 1, iz + 1);
  const gx = (src[idx(x1, iz)] - src[idx(x0, iz)]) / ((x1 - x0) * M_PER_TEXEL);
  const gz = (src[idx(ix, z1)] - src[idx(ix, z0)]) / ((z1 - z0) * M_PER_TEXEL);
  return Math.hypot(gx, gz);
}
const slopeDegAt = (src, ix, iz) => Math.atan(gradAt(src, ix, iz)) * 180 / Math.PI;

/* ── the terrace ─────────────────────────────────────────────────────────── */
const cxT = toTexel(OPT.cx), czT = toTexel(OPT.cz);
const rT = OPT.radius / M_PER_TEXEL;
const lo = { x: Math.max(0, Math.floor(cxT - rT - 2)), z: Math.max(0, Math.floor(czT - rT - 2)) };
const hi = { x: Math.min(N - 1, Math.ceil(cxT + rT + 2)), z: Math.min(N - 1, Math.ceil(czT + rT + 2)) };

/** Which texels the terrace touches at all, and how strongly. */
const weight = new Float32Array(N * N);
for (let iz = lo.z; iz <= hi.z; iz++) {
  for (let ix = lo.x; ix <= hi.x; ix++) {
    const d = Math.hypot(ix - cxT, iz - czT) / rT;
    // Full effect inside, feathered back to the original at the rim so the
    // plateau ties into the country around it instead of ending in a step.
    weight[idx(ix, iz)] = 1 - smoothstep(1 - OPT.feather, 1, d);
  }
}

for (let iz = lo.z; iz <= hi.z; iz++) {
  for (let ix = lo.x; ix <= hi.x; ix++) {
    const i = idx(ix, iz);
    const w = weight[i];
    if (w <= 0) continue;
    const h = ORIG[i];
    const g = gradAt(ORIG, ix, iz);

    // THE SUBTLETY, in one line: the transition is a fixed width of GROUND,
    // turned into a height range by the local gradient.
    const bandH = Math.max(OPT.minBand, g * OPT.cliff);
    const halfBand = clamp((bandH / OPT.step) * 0.5, 0.005, 0.49);

    const level = h / OPT.step;
    const f = Math.floor(level);
    const frac = level - f;
    const eased = smoothstep(0.5 - halfBand, 0.5 + halfBand, frac);
    const target = (f + eased) * OPT.step;
    H[i] = h + (target - h) * w;
  }
}

/* ── walkability, and repairing what the walls cut off ───────────────────── */
/**
 * Everything below works on the REGION ONLY, plus a margin. A terrace cannot
 * disconnect ground it never touched, and labelling a million cells to
 * discover that is wasted.
 */
const pad = 24;
const box = {
  x0: Math.max(0, lo.x - pad), x1: Math.min(N - 1, hi.x + pad),
  z0: Math.max(0, lo.z - pad), z1: Math.min(N - 1, hi.z + pad),
};
const bw = box.x1 - box.x0 + 1, bh = box.z1 - box.z0 + 1;

function walkMask(src) {
  const open = new Uint8Array(bw * bh);
  for (let z = 0; z < bh; z++) {
    for (let x = 0; x < bw; x++) {
      const ix = box.x0 + x, iz = box.z0 + z;
      // Water and props are the game's business; slope is what a terrace
      // changes, so slope is what this measures.
      open[z * bw + x] = (src[idx(ix, iz)] > 0.5 && slopeDegAt(src, ix, iz) <= OPT.maxSlope) ? 1 : 0;
    }
  }
  return open;
}

function components(open) {
  const lab = new Int32Array(bw * bh).fill(-1);
  const sizes = [];
  const st = [];
  for (let i = 0; i < open.length; i++) {
    if (!open[i] || lab[i] >= 0) continue;
    const id = sizes.length;
    let n = 0; st.length = 0; st.push(i); lab[i] = id;
    while (st.length) {
      const k = st.pop(); n++;
      const x = k % bw, z = (k / bw) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= bw || nz >= bh) continue;
        const j = nz * bw + nx;
        if (open[j] && lab[j] < 0) { lab[j] = id; st.push(j); }
      }
    }
    sizes.push(n);
  }
  return { lab, sizes };
}

const beforeOpen = walkMask(ORIG);
const beforeComp = components(beforeOpen);
const beforeWalk = beforeOpen.reduce((a, b) => a + b, 0);

/**
 * REPAIR. A wall that cuts a plateau off the map is a bug, not a feature, so
 * every piece the terrace stranded gets a ramp back: the original ground is
 * restored inside a disc at the point on that piece's edge nearest the main
 * body, which is a gap in the cliff and a door in game terms.
 *
 * Iterative because one ramp can join several pieces at once, and because the
 * only honest test of a repair is to re-measure.
 */
const ramps = [];
for (let pass = 0; pass < OPT.maxRamps; pass++) {
  const open = walkMask(H);
  const { lab, sizes } = components(open);
  if (!sizes.length) break;
  let main = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[main]) main = i;

  // The biggest stranded piece worth reconnecting.
  let worst = -1;
  for (let i = 0; i < sizes.length; i++) {
    if (i === main || sizes[i] < 40) continue;
    if (worst < 0 || sizes[i] > sizes[worst]) worst = i;
  }
  if (worst < 0) break;

  // Its cell closest to any cell of the main body.
  let best = null, bestD = Infinity;
  const mainCells = [];
  for (let i = 0; i < lab.length; i++) if (lab[i] === main) mainCells.push(i);
  const stride = Math.max(1, Math.floor(mainCells.length / 4000));
  for (let i = 0; i < lab.length; i++) {
    if (lab[i] !== worst) continue;
    const x = i % bw, z = (i / bw) | 0;
    for (let k = 0; k < mainCells.length; k += stride) {
      const j = mainCells[k];
      const d = (x - (j % bw)) ** 2 + (z - ((j / bw) | 0)) ** 2;
      if (d < bestD) { bestD = d; best = { x, z, jx: j % bw, jz: (j / bw) | 0 }; }
    }
  }
  if (!best) break;

  // Restore the original ground across the gap, midway between the two.
  const mx = (best.x + best.jx) / 2 + box.x0, mz = (best.z + best.jz) / 2 + box.z0;
  const rr = OPT.rampR / M_PER_TEXEL;
  for (let iz = Math.max(0, Math.floor(mz - rr)); iz <= Math.min(N - 1, Math.ceil(mz + rr)); iz++) {
    for (let ix = Math.max(0, Math.floor(mx - rr)); ix <= Math.min(N - 1, Math.ceil(mx + rr)); ix++) {
      const d = Math.hypot(ix - mx, iz - mz) / rr;
      if (d > 1) continue;
      const k = 1 - smoothstep(0.55, 1, d);
      const i = idx(ix, iz);
      H[i] = H[i] + (ORIG[i] - H[i]) * k;
    }
  }
  ramps.push({
    x: +((mx / (N - 1)) * WS - WS / 2).toFixed(1),
    z: +((mz / (N - 1)) * WS - WS / 2).toFixed(1),
    reconnected: sizes[worst],
  });
}

/* ── the report ──────────────────────────────────────────────────────────── */
const afterOpen = walkMask(H);
const afterComp = components(afterOpen);
const afterWalk = afterOpen.reduce((a, b) => a + b, 0);

const slopeHist = (src) => {
  const bins = { flat: 0, gentle: 0, steep: 0, wall: 0 };
  for (let iz = lo.z; iz <= hi.z; iz++) {
    for (let ix = lo.x; ix <= hi.x; ix++) {
      if (weight[idx(ix, iz)] <= 0.01) continue;
      const d = slopeDegAt(src, ix, iz);
      if (d < 6) bins.flat++; else if (d <= OPT.maxSlope) bins.gentle++;
      else if (d < 60) bins.steep++; else bins.wall++;
    }
  }
  const n = bins.flat + bins.gentle + bins.steep + bins.wall || 1;
  return Object.fromEntries(Object.entries(bins).map(([k, v]) => [k, `${(100 * v / n).toFixed(1)}%`]));
};

const pct = (v, n) => `${(100 * v / n).toFixed(1)}%`;
console.log(`${LEVEL}  ${N}x${N} @ ${M_PER_TEXEL} m/texel  maxHeight ${MH}`);
console.log(`terrace  centre (${OPT.cx}, ${OPT.cz})  radius ${OPT.radius} m  `
  + `step ${OPT.step} m  wall ${OPT.cliff} m`);
console.log(`\nslope inside the region   before -> after`);
const sb = slopeHist(ORIG), sa = slopeHist(H);
for (const k of ["flat", "gentle", "steep", "wall"]) {
  console.log(`  ${k.padEnd(7)} ${String(sb[k]).padStart(6)}  ->  ${String(sa[k]).padStart(6)}`);
}
console.log(`\nwalkable (slope only)     ${pct(beforeWalk, bw * bh)} -> ${pct(afterWalk, bw * bh)}`);
console.log(`components                ${beforeComp.sizes.length} -> ${afterComp.sizes.length}`);
const biggest = (c) => (c.sizes.length ? Math.max(...c.sizes) : 0);
console.log(`largest piece             ${pct(biggest(beforeComp), beforeWalk || 1)}`
  + ` -> ${pct(biggest(afterComp), afterWalk || 1)}`);
console.log(`ramps cut                 ${ramps.length}`);
for (const r of ramps) console.log(`  at (${r.x}, ${r.z}) reconnecting ${r.reconnected} cells`);

if (OPT.dry) { console.log("\ndry run — nothing written"); process.exit(0); }

for (let i = 0; i < H.length; i++) norm[i] = clamp(H[i] / MH, 0, 1);
const newPayload = Buffer.from(payload);
hCopy.copy(newPayload, hb.offset);
const manBuf = Buffer.from(JSON.stringify(manifest), "utf8");
const head = Buffer.alloc(12);
head.write("V3PJ", 0, "ascii");
head.writeUInt32LE(version, 4);
head.writeUInt32LE(manBuf.length, 8);
fs.copyFileSync(LEVEL, LEVEL + ".bak");
fs.writeFileSync(LEVEL, Buffer.concat([head, manBuf, newPayload]));
console.log(`\nwrote ${LEVEL}; previous kept at nam-valley.v3proj.bak`);
