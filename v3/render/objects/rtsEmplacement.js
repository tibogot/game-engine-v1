/**
 * TURRET EMPLACEMENT — the first object composed from the parts kit.
 *
 * WHY THIS ONE FIRST, ahead of the HQ. It is small (nam-rts gives `turret` a
 * radius of 4), it is the structure placed most often so it is the one that has
 * to survive being instanced, and it is a sandbag ring plus dressing — so it
 * proves the kit with a single part before anything depends on six.
 *
 * It deliberately does NOT model a weapon. nam-rts already has turretKit.js
 * geometry shared by both teams; this is the position that gun sits in, so the
 * two compose instead of competing.
 *
 * THREE LODs, because an RTS places hundreds and an object without them is an
 * object that cannot ship:
 *
 *   LOD0  every bag individually, for the 18 m minimum zoom
 *   LOD1  the parapet as one swept ring with a scalloped top — the bag RHYTHM
 *         survives, the bags do not. This is the LOD that does the work: at
 *         40-120 m the eye reads the silhouette and the scallop, never a bag.
 *   LOD2  a plain tapered ring. Footprint and height, nothing else.
 *
 * The scallop matters more than it sounds. Dropping to a smooth ring at LOD1 is
 * what makes distant emplacements read as concrete paddling pools; keeping the
 * top bumpy at a fraction of the cost keeps them reading as sandbags.
 */
import * as THREE from "three";
import {
  MAT, SANDBAG_DEFAULTS, assemble, buildOilDrum, buildPost, buildSandbagRing, rng, triCount,
} from "./rtsParts.js";

export const EMPLACEMENT_DEFAULTS = {
  radius: 3.4,        // parapet centreline; nam-rts turret radius is 4
  courses: 5,
  gapDeg: 52,         // entrance, facing -Z
  batter: 0.05,       // each course steps in, so the wall leans like a real one
  seed: 7,
  jitter: 1,
  bagLength: 0.52,
  bagHeight: 0.19,
  bagWidth: 0.30,
  round: 3.1,
  slump: 0.22,
  drums: 2,           // dressing: fuel/ammo at the rear
  stakes: 3,          // short posts, so the ring is not perfectly regular
  segPerBag: 3,       // LOD1 columns per bag — see buildEmplacementLod1
};

function bagOpts(o) {
  return {
    ...SANDBAG_DEFAULTS,
    length: o.bagLength, width: o.bagWidth, height: o.bagHeight,
    round: o.round, slump: o.slump,
  };
}

/** Dressing shared by LOD0 and LOD1 — drums and stakes read at both ranges. */
function dressing(o, top) {
  const r = rng(o.seed * 61 + 11);
  const parts = [];
  if (o.drums > 0) {
    const drum = buildOilDrum({});
    for (let i = 0; i < o.drums; i++) {
      const a = Math.PI * 0.5 + (i - (o.drums - 1) / 2) * 0.42 + (r() - 0.5) * 0.1;
      const rad = o.radius - 0.75;
      parts.push({ geo: drum, mat: MAT.metal, pos: [Math.cos(a) * rad, 0, Math.sin(a) * rad], rot: [0, r() * 6.28, 0] });
    }
  }
  if (o.stakes > 0) {
    const post = buildPost({ height: top + 0.55, width: 0.11, depth: 0.11, taper: 0.1 });
    for (let i = 0; i < o.stakes; i++) {
      const a = -Math.PI * 0.5 + (i + 0.5) * (Math.PI * 2 / (o.stakes + 1.6));
      parts.push({
        geo: post, mat: MAT.timber,
        pos: [Math.cos(a) * (o.radius + 0.06), 0, Math.sin(a) * (o.radius + 0.06)],
        rot: [(r() - 0.5) * 0.08, 0, (r() - 0.5) * 0.08],
      });
    }
  }
  return parts;
}

/** LOD0 — individual bags. */
export function buildEmplacementLod0(opts = {}) {
  const o = { ...EMPLACEMENT_DEFAULTS, ...opts };
  const ring = buildSandbagRing({
    radius: o.radius, courses: o.courses, seed: o.seed,
    bag: bagOpts(o), gapDeg: o.gapDeg, batter: o.batter, jitter: o.jitter,
  });
  const top = o.courses * o.bagHeight * 0.9;
  const parts = [{ geo: ring }, ...dressing(o, top)];
  const out = assemble(parts);
  for (const p of parts) p.geo.dispose();
  return out;
}

/**
 * LOD1 — one swept ring. The top scallops at the bag pitch so the rhythm of
 * the courses survives; the sides step per course so the batter still reads.
 */
export function buildEmplacementLod1(opts = {}) {
  const o = { ...EMPLACEMENT_DEFAULTS, ...opts };
  const top = o.courses * o.bagHeight * 0.9;
  const gap = (o.gapDeg * Math.PI) / 180;
  const inner = o.radius - o.bagWidth * 0.5 - o.batter * o.courses;
  const outer = o.radius + o.bagWidth * 0.5;
  const bagsAround = Math.max(8, Math.round((2 * Math.PI * o.radius) / (o.bagLength * 0.94)));
  /*
   * The sweep resolution is DERIVED from the bag count, never set independently.
   * A fixed 40 columns against ~44 bags undersamples the scallop and it aliases
   * flat — the ring then reads as a moulded concrete paddling pool, which is the
   * exact failure this LOD exists to avoid. Three columns per bag is the least
   * that still shows a bump.
   */
  const seg = Math.max(24, Math.round(bagsAround * Math.max(1, o.segPerBag)));

  const pos = [], uvs = [], idx = [];
  // Ring profile: inner-bottom, inner-top, outer-top, outer-bottom.
  const cols = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const d = Math.abs(Math.atan2(Math.sin(a + Math.PI / 2), Math.cos(a + Math.PI / 2)));
    if (d < gap / 2) { cols.push(null); continue; }
    // Scallop: one bump per bag, plus a slow wobble so it is not a pure sine.
    const s = Math.sin(a * bagsAround) * 0.5 + 0.5;
    const wob = Math.sin(a * 3.7 + o.seed) * 0.5 + 0.5;
    const h = top - o.bagHeight * (0.16 + 0.30 * s + 0.10 * wob);
    const ci = Math.cos(a) * inner, si = Math.sin(a) * inner;
    const co = Math.cos(a) * outer, so = Math.sin(a) * outer;
    const base = pos.length / 3;
    pos.push(ci, 0, si, ci, h, si, co, h, so, co, 0, so);
    for (let k = 0; k < 4; k++) uvs.push(i / seg, k / 3);
    cols.push(base);
  }
  for (let i = 0; i < cols.length - 1; i++) {
    const a = cols[i], b = cols[i + 1];
    if (a == null || b == null) continue;
    for (let k = 0; k < 3; k++) {
      idx.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();

  const parts = [{ geo: g }, ...dressing(o, top)];
  const out = assemble(parts);
  for (const p of parts) p.geo.dispose();
  return out;
}

/** LOD2 — footprint and height only. */
export function buildEmplacementLod2(opts = {}) {
  const o = { ...EMPLACEMENT_DEFAULTS, ...opts };
  const top = o.courses * o.bagHeight * 0.9;
  const outer = o.radius + o.bagWidth * 0.5;
  const g = new THREE.CylinderGeometry(outer - o.batter * o.courses, outer, top, 12, 1, true);
  g.translate(0, top * 0.5, 0);
  return assemble([{ geo: g }]);
}

/** All three, plus their triangle counts — the lab and the engine both want this. */
export function buildEmplacement(opts = {}) {
  const lods = [buildEmplacementLod0(opts), buildEmplacementLod1(opts), buildEmplacementLod2(opts)];
  return { lods, tris: lods.map(triCount) };
}

export const RTS_OBJECTS = {
  emplacement: {
    id: "emplacement",
    label: "Turret emplacement",
    build: buildEmplacement,
    defaults: EMPLACEMENT_DEFAULTS,
    /** Matches nam-rts STRUCTURE_TYPES.turret, so it drops in without touching placement. */
    footprintRadius: 4,
    tier: "scattered",        // placed often — instance it, do not merge per placement
    schema: [
      { key: "radius", label: "Ring radius", min: 1.5, max: 6, step: 0.05 },
      { key: "courses", label: "Courses", min: 1, max: 7, step: 1 },
      { key: "gapDeg", label: "Entrance °", min: 0, max: 160, step: 1 },
      { key: "batter", label: "Batter", min: 0, max: 0.2, step: 0.005 },
      { sep: true },
      { key: "bagLength", label: "Bag length", min: 0.25, max: 0.9, step: 0.01 },
      { key: "bagWidth", label: "Bag width", min: 0.15, max: 0.6, step: 0.01 },
      { key: "bagHeight", label: "Bag height", min: 0.08, max: 0.35, step: 0.005 },
      { key: "round", label: "Bag squareness", min: 2, max: 6, step: 0.05 },
      { key: "slump", label: "Bag slump", min: 0, max: 0.6, step: 0.01 },
      { key: "jitter", label: "Stack jitter", min: 0, max: 2.5, step: 0.05 },
      { sep: true },
      { key: "drums", label: "Oil drums", min: 0, max: 6, step: 1 },
      { key: "stakes", label: "Stakes", min: 0, max: 8, step: 1 },
      { key: "segPerBag", label: "LOD1 cols/bag", min: 1, max: 6, step: 1 },
      { key: "seed", label: "Seed", min: 1, max: 999, step: 1 },
    ],
  },
};
