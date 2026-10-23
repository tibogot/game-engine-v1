// ROCK FORMATIONS (2026-10-23, you: "they look all almost the same … we could scale them, rotate them and also
// stack some of them to make better rocks"; the CoH 3 references: assets-src/refs/coh3/rocks-*.png). A formation is
// several layered sandstone pieces (rockLayered.js — stacked rings: their ledges crisp, never saw-toothed) composed
// into ONE mesh, the way CoH's desert outcrops are built:
//
//   SHELVES   a mesa in stepped tiers, each smaller and set back on the one below — the ledges between them
//   LIPS      each tier's top edge rolled round (soft profile, a wide soft edge), its foot eaten back under the
//             lip above (the undercut): the dark band under every shelf
//   CRACK     the mass split right through: each tier cut in two halves (the same seed: the faces match) and the
//             halves set a crack's width apart
//   STRETCH   every part its own length, width and height (never one shape scaled up), its own turn
//
// The parts are made (~30 ms each), then baked into place and merged: one draw.
// The material is the game's sandstone (algSandstone.js), so what is judged in the rock lab is the game's rock.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { getRockGeometry, prewarmRockGeometries } from "../../v3/props/proceduralRock.js";
import { layeredCached } from "./rockLayered.js";

/** A part's geometry: a LAYERED piece (rockLayered.js — rings, no saw-tooth) or the engine's chipped egg (older saves). */
export const pieceGeometry = (params) => (params.layered ? layeredCached(params) : getRockGeometry(params));
/** Make the parts ready: the engine's in worker threads; the layered ones are made on the spot (~30 ms each). */
export const prewarmPieces = (list) => prewarmRockGeometries(list.filter((p) => !p.layered));

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One part's params: a slab `h` m tall — its outline rounded or boxy, broken, its walls banded and ledged, its lip
 * rolled, its foot undercut — built as a LAYERED piece (rockLayered.js). */
function tierParams(seed, { sx, h, sz, round, undercut, strata, joints, breaks = 0.5, relief = { lumps: 0.5, blocks: 0.45, runnels: 0.35 }, sharp = 0.7 }) {
  return { layered: 1, seed, sx, h, sz, round, breaks, undercut, strata, sharp, relief, joints: joints ?? 2 };
}

/** A rounded BLOCK `h` m tall (a loaf, a pillow, a slab on edge). */
function blockParams(seed, { sx, h, sz, round, undercut, strata, breaks, relief, sharp }) {
  return tierParams(seed, { sx, h, sz, round, undercut, strata, breaks, relief, sharp, joints: 2 + (seed % 3) });
}

/** The formation kinds and their controls (the lab's sliders: key, label, min, max, step, default). */
export const FORMATIONS = {
  mesa: {
    label: "Stepped mesa",
    ref: "rocks-mesa-shelves.png",
    controls: [
      ["lumps", "Lumps (warped bulges)", 0, 1, 0.05, 0.5],
      ["blocks", "Blocks (joint grooves)", 0, 1, 0.05, 0.45],
      ["runnels", "Runnels (erosion, vertical)", 0, 1, 0.05, 0.35],
      ["sharp", "Ledge sharpness", 0, 1, 0.05, 0.7],
      ["length", "Length (m)", 10, 40, 1, 28],
      ["tiers", "Shelves", 1, 4, 1, 3],
      ["tierHeight", "Shelf height (m)", 0.8, 4, 0.1, 1.7],
      ["setBack", "Set back per shelf", 0.04, 0.45, 0.01, 0.12],
      ["round", "Lip roundness", 0, 1, 0.05, 0.4],
      ["breaks", "Sharp breaks", 0, 1, 0.05, 0.6],
      ["undercut", "Undercut under the lip", 0, 0.35, 0.01, 0.2],
      ["crack", "Cleft width (m, 0 = none)", 0, 2.5, 0.1, 0],
      ["strata", "Bedding bands per shelf", 0, 6, 1, 2],
    ],
  },
  // the CoH screenshot's right side: a wall of rounded LOAVES, each its own height, deep clefts between them
  loaves: {
    label: "Loaf cliff (rounded blocks)",
    ref: "rocks-cluster-tanks.png",
    controls: [
      ["lumps", "Lumps (warped bulges)", 0, 1, 0.05, 0.5],
      ["blocks", "Blocks (joint grooves)", 0, 1, 0.05, 0.45],
      ["runnels", "Runnels (erosion, vertical)", 0, 1, 0.05, 0.35],
      ["sharp", "Ledge sharpness", 0, 1, 0.05, 0.7],
      ["length", "Length (m)", 8, 40, 1, 22],
      ["count", "Loaves", 2, 9, 1, 5],
      ["height", "Height (m)", 2, 9, 0.1, 5],
      ["round", "Roundness", 0.2, 1, 0.05, 0.65],
      ["breaks", "Sharp breaks", 0, 1, 0.05, 0.55],
      ["cleft", "Cleft width (m)", 0, 1.5, 0.05, 0.35],
      ["rows", "Rows (deep)", 1, 3, 1, 2],
      ["strata", "Bedding bands", 0, 8, 1, 3],
    ],
  },
  // the CoH screenshot's lone slab: one big rounded mass, a flat top, its foot eaten back
  boulder: {
    label: "Lone slab (pillow)",
    ref: "rocks-cluster-tanks.png",
    controls: [
      ["lumps", "Lumps (warped bulges)", 0, 1, 0.05, 0.5],
      ["blocks", "Blocks (joint grooves)", 0, 1, 0.05, 0.45],
      ["runnels", "Runnels (erosion, vertical)", 0, 1, 0.05, 0.35],
      ["sharp", "Ledge sharpness", 0, 1, 0.05, 0.7],
      ["length", "Length (m)", 6, 24, 1, 13],
      ["height", "Height (m)", 1.5, 6, 0.1, 3.4],
      ["round", "Roundness", 0.2, 1, 0.05, 0.7],
      ["breaks", "Sharp breaks", 0, 1, 0.05, 0.45],
      ["undercut", "Undercut", 0, 0.4, 0.01, 0.28],
      ["strata", "Bedding bands", 0, 6, 1, 2],
    ],
  },
  // the CoH screenshot's top left: a long ridge of slabs leaning on one another, like fallen books
  ridge: {
    label: "Slab ridge (leaning)",
    ref: "rocks-cluster-tanks.png",
    controls: [
      ["lumps", "Lumps (warped bulges)", 0, 1, 0.05, 0.5],
      ["blocks", "Blocks (joint grooves)", 0, 1, 0.05, 0.45],
      ["runnels", "Runnels (erosion, vertical)", 0, 1, 0.05, 0.35],
      ["sharp", "Ledge sharpness", 0, 1, 0.05, 0.7],
      ["length", "Length (m)", 10, 45, 1, 28],
      ["count", "Slabs", 2, 8, 1, 5],
      ["height", "Slab height (m)", 1.5, 6, 0.1, 3.6],
      ["lean", "Lean (deg)", 0, 35, 1, 18],
      ["round", "Roundness", 0.1, 1, 0.05, 0.35],
      ["breaks", "Sharp breaks", 0, 1, 0.05, 0.7],
      ["strata", "Bedding bands", 0, 6, 1, 3],
    ],
  },
};
export const defaultsOf = (kind) => Object.fromEntries(FORMATIONS[kind].controls.map((c) => [c[0], c[5]]));

/**
 * The PARTS of a formation: [{ params, x, y, z, yaw }] — each part a generated rock placed in the formation's frame
 * (metres, y up, its foot at y 0, the long side along x).
 */
export function formationParts(kind, seed, opts = {}) {
  const o = { ...defaultsOf(kind), ...opts }, R = mulberry32(seed * 7919 + 13), parts = [];
  if (kind === "mesa") {
    // The base: as long as asked, ~0.55 as deep; each shelf up smaller, set back toward a random side.
    let lx = o.length / 2, lz = lx * (0.5 + R() * 0.15), cx = 0, cz = 0, y = 0;
    // The crack: one line across the whole mass, near its middle (a little turned).
    const crackYaw = Math.PI / 2 + (R() - 0.5) * 0.5, nx = Math.cos(crackYaw), nz = Math.sin(crackYaw);
    for (let t = 0; t < o.tiers; t++) {
      const h = o.tierHeight * (0.85 + R() * 0.3), sy = h / 2, sd = seed * 31 + t * 7;
      const common = { h, round: o.round, undercut: o.undercut, strata: o.strata, breaks: o.breaks, relief: { lumps: o.lumps, blocks: o.blocks, runnels: o.runnels }, sharp: o.sharp };
      // A shelf's outline is LOBED (CoH's are never ovals — seen: ours read as stacked ovals): the main slab and
      // 1-3 smaller ones overlapping its edge, each its own size, turn and seed.
      const blobs = [{ dx: 0, dz: 0, sx: lx, sz: lz, yaw: (R() - 0.5) * 0.25, seed: sd }];
      // (one PLATEAU, not a pile — seen: big lobes on every shelf read as stacked boulders: the lobes only bend
      // the outline, along the long sides)
      const nLobe = 1 + Math.floor(R() * 2);
      for (let k = 0; k < nLobe; k++) {
        const a = (R() < 0.5 ? 0 : Math.PI) + (R() - 0.5) * 1.2, f = 0.35 + R() * 0.2;
        blobs.push({ dx: Math.cos(a) * lx * 0.6, dz: Math.sin(a) * lz * 0.45, sx: lx * f, sz: lz * (f + 0.1), yaw: R() * Math.PI, seed: sd + 100 + k });
      }
      // a shelf sits 30 % into the one below (its own base cut and the lower's top cut meet inside)
      const py = Math.max(0, y - sy * 0.6);
      // THE CLEFT (you: the knife cut "doesn't make sense"): no slicing — the shelf's blobs on either side of the
      // crack line are pushed apart, and the MAIN slab is two rounded masses (each half its length, the cleft between
      // their rolled edges: wide at the top, closing at the foot, as a weathered joint).
      const ux = Math.cos(crackYaw), uz = Math.sin(crackYaw);
      const list = [];
      if (o.crack > 0 && lx > 4) {
        const m = blobs.shift(), tx = -uz, tz = ux;                  // along the crack line
        const ext = 1 / Math.hypot(ux / m.sx, uz / m.sz);            // the main slab's half-width across the crack
        for (const side of [-1, 1]) {
          const w = ext * (0.5 + (R() - 0.5) * 0.2);
          list.push({ ...m, seed: m.seed + (side > 0 ? 50 : 0), dx: m.dx + side * ux * (ext - w), dz: m.dz + side * uz * (ext - w),
            sx: Math.abs(ux) > 0.7 ? w : m.sx, sz: Math.abs(uz) > 0.7 ? w : m.sz, side });
        }
        void tx; void tz;
      }
      for (const b of blobs) list.push({ ...b, side: Math.sign((cx + b.dx) * ux + (cz + b.dz) * uz) || 1 });
      for (const b of list) {
        const push = o.crack > 0 ? b.side * o.crack / 2 : 0;
        parts.push({ params: tierParams(b.seed, { ...common, sx: b.sx, sz: b.sz, joints: 2 + Math.round(R() * 3) }),
          x: cx + b.dx + ux * push, y: py, z: cz + b.dz + uz * push, yaw: b.yaw });
      }
      y = py + sy * 2 * 0.95;
      // the next shelf: smaller, pushed toward one side (CoH's shelves are not centred)
      const k = 1 - o.setBack;
      cx += (R() - 0.5) * lx * o.setBack * 0.8; cz += (R() - 0.5) * lz * o.setBack * 0.8;
      lx *= k * (0.92 + R() * 0.16); lz *= k * (0.92 + R() * 0.16);
    }
  }
  if (kind === "loaves") {
    // rows of rounded blocks side by side along x, each its own width, height and depth, the back row taller
    for (let r = 0; r < o.rows; r++) {
      let x = -o.length / 2;
      const n = Math.max(1, Math.round(o.count * (r ? 0.7 : 1)));
      const wAvg = o.length / n;
      for (let i = 0; i < n && x < o.length / 2; i++) {
        const w = wAvg * (1.0 + R() * 0.6), hh = o.height * (r ? 1.15 : 0.85) * (0.6 + R() * 0.55), d = wAvg * (1.1 + R() * 0.6);
        const cxp = x + w / 2;
        parts.push({ params: blockParams(seed * 53 + r * 17 + i, { sx: w / 2, h: hh, sz: d / 2, round: o.round, undercut: 0.12, strata: o.strata, breaks: o.breaks, relief: { lumps: o.lumps, blocks: o.blocks, runnels: o.runnels }, sharp: o.sharp }),
          x: cxp, y: 0, z: -r * wAvg * 0.6 + (R() - 0.5) * wAvg * 0.25, yaw: (R() - 0.5) * 0.35 });
        x += w * 0.72 + o.cleft * (0.5 + R());   // (overlapping: one wall, the clefts the rounded edges' V)
      }
    }
  }
  if (kind === "boulder") {
    const lx = o.length / 2, lz = lx * (0.55 + R() * 0.2);
    parts.push({ params: blockParams(seed * 61, { sx: lx, h: o.height, sz: lz, round: o.round, undercut: o.undercut, strata: o.strata, breaks: o.breaks, relief: { lumps: o.lumps, blocks: o.blocks, runnels: o.runnels }, sharp: o.sharp }), x: 0, y: 0, z: 0, yaw: 0 });
    // a smaller mass grown into one end (never a perfect pillow)
    const a = R() * Math.PI * 2;
    parts.push({ params: blockParams(seed * 61 + 1, { sx: lx * 0.45, h: o.height * (0.6 + R() * 0.3), sz: lz * 0.6, round: o.round, undercut: o.undercut, strata: o.strata, breaks: o.breaks, relief: { lumps: o.lumps, blocks: o.blocks, runnels: o.runnels }, sharp: o.sharp }),
      x: Math.cos(a) * lx * 0.7, y: 0, z: Math.sin(a) * lz * 0.6, yaw: R() * 3 });
  }
  if (kind === "ridge") {
    // slabs in a row, each leaning on the next (turned about the ridge's line), some lower, the gaps irregular
    const step = o.length / o.count;
    for (let i = 0; i < o.count; i++) {
      const w = step * (1.3 + R() * 0.5), hh = o.height * (0.65 + R() * 0.5), d = Math.max(hh * 1.1, step * 0.9) * (0.8 + R() * 0.4);
      const lean = ((o.lean * (0.6 + R() * 0.7)) * Math.PI) / 180;
      parts.push({ params: blockParams(seed * 71 + i, { sx: w / 2, h: hh, sz: d / 2, round: o.round, undercut: 0.08, strata: o.strata, breaks: o.breaks, relief: { lumps: o.lumps, blocks: o.blocks, runnels: o.runnels }, sharp: o.sharp }),
        x: -o.length / 2 + step * (i + 0.5) + (R() - 0.5) * step * 0.25, y: -0.4, z: (R() - 0.5) * 1.5, yaw: (R() - 0.5) * 0.3, roll: lean * (i % 2 || R() < 0.3 ? 1 : 0.4) });
    }
  }
  return parts;
}

/** Generate a formation's parts (worker threads) and merge them into one geometry, its foot at y 0. */
export async function buildFormation(kind, seed, opts = {}) {
  const parts = formationParts(kind, seed, opts);
  await prewarmPieces(parts.map((p) => p.params));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  const geos = parts.map((p) => {
    const g = pieceGeometry(p.params).clone();
    q.setFromEuler(new THREE.Euler(p.tilt ?? 0, p.yaw, p.roll ?? 0, "YXZ"));   // (a ridge's slabs lean onto the next: a roll about z)
    g.applyMatrix4(m.compose(new THREE.Vector3(p.x, p.y, p.z), q, one));
    return g;
  });
  const geo = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  geo.computeBoundingBox();
  geo.translate(0, -geo.boundingBox.min.y, 0);
  geo.computeBoundingBox(); geo.computeBoundingSphere();
  geo.userData.formation = { kind, seed, parts: parts.length, triangles: geo.index.count / 3 };
  return geo;
}

// ── THE COMPOSER'S PIECES (2026-10-23, you: "allow me with some gizmo to blend some of those big rocks together, rotate
// them, scale them"): one rock each, about 4 m, its shape stretched and turned by the rock lab's gizmo. The look
// (round, breaks, strata) is the piece's own. ──
export const PIECES = {
  slab: { label: "Slab (flat)", size: [4, 1.6, 3] },
  loaf: { label: "Loaf (rounded block)", size: [2.6, 3.6, 2.4] },
  pillow: { label: "Pillow (low, round)", size: [3.6, 2.2, 2.8] },
  pillar: { label: "Pillar (tall)", size: [1.5, 5, 1.4] },
  // (you, 2026-10-23: "mostly flat-looking, not big-height cliff"): a WALL 10 m high — deep vertical joints splitting it into
  // columns, a few strong bands, an overhang under its top; stacked and overlapped into a cliff face
  cliff: { label: "Cliff wall (tall)", size: [4.5, 10, 1.9], cliff: true },
};
/** A piece's generator params ({ kind, seed, round, breaks, strata, undercut }). */
export function pieceParams({ kind, seed, round = 0.55, breaks = 0.6, strata = 2, undercut = 0.15, relief = { lumps: 0.5, blocks: 0.45, runnels: 0.35 }, sharp = 0.6 }) {
  const [sx, h, sz] = PIECES[kind].size;
  // (boxy — a rounded outline and a tall bulge read as BARRELS, seen: square in plan, the overhang only a ledge under the top)
  if (PIECES[kind].cliff) return { ...tierParams(seed, { sx, h, sz, round: Math.min(round, 0.2) * 0.5, undercut: undercut * 0.4, strata: Math.max(strata, 5), breaks, relief, sharp: Math.max(sharp, 0.85), joints: 5 + (seed % 3) }), jointDepth: 0.85, overhang: 0.16 };
  return tierParams(seed, { sx, h, sz, round, undercut, strata, breaks, relief, sharp, joints: kind === "pillar" ? 1 : 2 + (seed % 3) });
}
/** A merged mesh of placed pieces: [{ params, matrix: number[16] }] — the game's form of a composition. */
export async function buildComposition(items) {
  await prewarmPieces(items.map((i) => i.params));
  const geos = items.map((i) => pieceGeometry(i.params).clone().applyMatrix4(new THREE.Matrix4().fromArray(i.matrix)));
  const geo = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  geo.computeBoundingBox(); geo.translate(0, -geo.boundingBox.min.y, 0); geo.computeBoundingBox(); geo.computeBoundingSphere();
  return geo;
}
/** A formation's parts as composer items (their matrices). */
export function formationItems(kind, seed, opts = {}) {
  return formationParts(kind, seed, opts).map((p) => ({
    params: p.params,
    matrix: new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(p.tilt ?? 0, p.yaw, p.roll ?? 0, "YXZ")), new THREE.Vector3(1, 1, 1)).toArray(),
  }));
}
