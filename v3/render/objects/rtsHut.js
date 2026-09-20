/**
 * CORRUGATED-IRON HUT — the Vietnam-war shack, and the kit's real test.
 *
 * Chosen over the sandbag emplacement as the first finished asset because it
 * has somewhere to put the detail: rusted sheet, timber frame, a sagging roof
 * with an overhang, sandbags stacked against the blast wall. An emplacement is
 * a ring of beige; a hut has silhouette, material contrast and shade.
 *
 * It is ONE mesh and ONE draw. Iron, timber and hessian are told apart by a
 * per-vertex `matId` and shaded from three canvas textures in the material, not
 * by splitting the object into three meshes — a building placed across a map
 * cannot afford to triple its draws for the sake of three surfaces.
 *
 * WHAT MAKES IT READ, in the order the eye notices:
 *   1. Contact AO. Under the eaves, between stacked bags, inside the doorway.
 *      Without it the whole thing is a flat cut-out whatever texture is on it.
 *   2. Per-panel tone. Real sheds are patched: panels replaced at different
 *      times weather differently. A wall of identical sheets reads as plastic.
 *   3. Sag and lean. Nothing in a field shed is plumb. Every panel gets a small
 *      random tilt and the roof ridge dips.
 *   4. Only then the texture itself.
 */
import * as THREE from "three";
import {
  MAT, assemble, bakeContactAO, buildCorrugatedPanel, buildOilDrum, buildPost,
  buildSandbagWall, rng, triCount,
} from "./rtsParts.js";

export const HUT_DEFAULTS = {
  width: 4.4,          // along X — the door wall
  depth: 3.6,          // along Z
  wallHeight: 2.35,
  pitch: 0.30,         // roof rise / half span
  overhang: 0.42,
  postWidth: 0.15,
  panelsPerWall: 4,
  ribs: 7,
  ribDepth: 0.032,
  lean: 1.0,           // how far from plumb the panels sit
  sag: 0.09,           // ridge dip, in metres
  doorWidth: 1.05,
  sandbags: 3,         // courses stacked against the back wall
  drums: 1,
  stovepipe: 1,
  seed: 5,
  aoStrength: 0.55,
};

/** Wall of overlapping sheets down one side, with an optional doorway gap. */
function wall({ span, height, panels, ribs, ribDepth, lean, r, doorFrom = null, doorTo = null }) {
  const parts = [];
  const w = span / panels;
  for (let i = 0; i < panels; i++) {
    const x0 = -span / 2 + i * w;
    const x1 = x0 + w;
    // Skip any sheet that would cross the doorway.
    if (doorFrom !== null && x1 > doorFrom && x0 < doorTo) continue;
    const geo = buildCorrugatedPanel({
      width: w * 1.04,          // sheets overlap at the seam, they do not butt
      height: height * (1 - 0.01 * r()),
      ribs, ribDepth, thickness: 0.022,
      offset: (i % 2) * 0.016, // ...and every other one laps OVER its neighbour
    });
    parts.push({
      geo, mat: MAT.metal, tone: r(),
      pos: [x0 + w / 2, 0, 0],
      // A field shed is never plumb, and this is most of why it reads as built
      // rather than modelled.
      rot: [(r() - 0.5) * 0.030 * lean, (r() - 0.5) * 0.045 * lean, (r() - 0.5) * 0.022 * lean],
    });
  }
  return parts;
}

/**
 * Pitched roof of sheets laid up each slope, with a dipping ridge.
 *
 * Placed with an explicit BASIS rather than Euler angles. A panel is built
 * standing — width along X, height along Y, thickness along Z — and a roof
 * sheet needs its HEIGHT to run up the slope and its WIDTH to run along the
 * building's depth. Stating that as three axes is unambiguous; stating it as an
 * Euler triple depends on rotation order and the first attempt had the sheets
 * flying off the building.
 */
function roof(o, r) {
  const half = o.width / 2 + o.overhang;
  const rise = half * o.pitch;
  const slope = Math.hypot(half, rise);
  const depth = o.depth + o.overhang * 2;
  const sheets = Math.max(2, Math.round(depth / 1.0));
  const sw = depth / sheets;
  const parts = [];
  const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();

  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < sheets; i++) {
      const z = -depth / 2 + (i + 0.5) * sw;
      // The ridge dips in the middle — an old roof always does.
      const dip = o.sag * Math.sin(((i + 0.5) / sheets) * Math.PI);
      const geo = buildCorrugatedPanel({
        width: sw * 1.05, height: slope, ribs: o.ribs, ribDepth: o.ribDepth, thickness: 0.022,
        offset: (i % 2) * 0.016,
      });
      // Up-slope, from this side's eave toward the ridge.
      Y.set(-side * half, rise, 0).normalize();
      X.set(0, 0, 1);                                  // along the building depth
      Z.crossVectors(X, Y).normalize();                // the roof's own normal
      const m = new THREE.Matrix4().makeBasis(X, Y, Z);
      // The sheet's origin is its bottom edge, so it starts AT the eave.
      m.setPosition(side * half, o.wallHeight - dip, z);
      parts.push({ geo, mat: MAT.metal, tone: r() * 0.85 + 0.1, matrix: m });
    }
  }
  // Ridge cap.
  parts.push({
    geo: new THREE.BoxGeometry(0.22, 0.1, depth), mat: MAT.metal, tone: 0.2,
    pos: [0, o.wallHeight + rise - o.sag * 0.45, 0],
  });
  return parts;
}

/** LOD0 — every sheet, every bag. */
export function buildHutLod0(opts = {}) {
  const o = { ...HUT_DEFAULTS, ...opts };
  const r = rng(o.seed);
  const parts = [];

  // Frame: corner posts plus a mid post per long wall.
  const px = o.width / 2 - o.postWidth * 0.5;
  const pz = o.depth / 2 - o.postWidth * 0.5;
  for (const [x, z] of [[-px, -pz], [px, -pz], [-px, pz], [px, pz], [0, -pz], [0, pz]]) {
    parts.push({
      geo: buildPost({ height: o.wallHeight + 0.08, width: o.postWidth, depth: o.postWidth, taper: 0.04 }),
      mat: MAT.timber, tone: r(),
      pos: [x, 0, z], rot: [(r() - 0.5) * 0.02, 0, (r() - 0.5) * 0.02],
    });
  }

  const wallOpts = { height: o.wallHeight, panels: o.panelsPerWall, ribs: o.ribs, ribDepth: o.ribDepth, lean: o.lean, r };
  // Front (+Z) carries the doorway.
  for (const p of wall({ ...wallOpts, span: o.width, doorFrom: -o.doorWidth / 2, doorTo: o.doorWidth / 2 })) {
    parts.push({ ...p, pos: [p.pos[0], 0, o.depth / 2] });
  }
  for (const p of wall({ ...wallOpts, span: o.width })) {
    parts.push({ ...p, pos: [p.pos[0], 0, -o.depth / 2] });
  }
  for (const side of [-1, 1]) {
    for (const p of wall({ ...wallOpts, span: o.depth, panels: Math.max(2, o.panelsPerWall - 1) })) {
      parts.push({
        ...p,
        pos: [side * o.width / 2, 0, p.pos[0]],
        rot: [p.rot[0], Math.PI / 2 + p.rot[1], p.rot[2]],
      });
    }
  }

  parts.push(...roof(o, r));

  // Sandbags stacked against the back wall — the kit tying itself together.
  if (o.sandbags > 0) {
    parts.push({
      geo: buildSandbagWall({ length: o.width * 0.82, courses: o.sandbags, seed: o.seed * 3, jitter: 1.1 }),
      pos: [0, 0, -o.depth / 2 - 0.30],
    });
  }
  if (o.drums > 0) {
    for (let i = 0; i < o.drums; i++) {
      parts.push({
        geo: buildOilDrum({}), mat: MAT.metal, tone: r(),
        pos: [o.width / 2 - 0.55 - i * 0.7, 0, o.depth / 2 + 0.55], rot: [0, r() * 6.28, 0],
      });
    }
  }
  if (o.stovepipe > 0) {
    const rise = (o.width / 2 + o.overhang) * o.pitch;
    parts.push({
      geo: new THREE.CylinderGeometry(0.075, 0.085, 1.15, 8), mat: MAT.metal, tone: 0.1,
      pos: [-o.width * 0.28, o.wallHeight + rise * 0.55 + 0.5, -o.depth * 0.2],
      rot: [0, 0, 0.06],
    });
  }

  const geo = assemble(parts);
  for (const p of parts) p.geo.dispose();
  bakeContactAO(geo, { cell: 0.2, radius: 2, strength: o.aoStrength, groundFade: 0.35 });
  return geo;
}

/** LOD1 — same silhouette, coarser sheets, no loose dressing. */
export function buildHutLod1(opts = {}) {
  return buildHutLod0({
    ...opts,
    ribs: 4, panelsPerWall: 2, sandbags: Math.min(2, opts.sandbags ?? HUT_DEFAULTS.sandbags),
    drums: 0, stovepipe: opts.stovepipe ?? HUT_DEFAULTS.stovepipe,
  });
}

/** LOD2 — a box and a roof prism. Footprint, height, ridge. Nothing else. */
export function buildHutLod2(opts = {}) {
  const o = { ...HUT_DEFAULTS, ...opts };
  const half = o.width / 2 + o.overhang;
  const rise = half * o.pitch;
  const body = new THREE.BoxGeometry(o.width, o.wallHeight, o.depth);
  body.translate(0, o.wallHeight / 2, 0);
  // Prism: a 3-sided cylinder is a wedge once it is turned to lie along Z.
  const prism = new THREE.CylinderGeometry(half * 1.02, half * 1.02, o.depth + o.overhang * 2, 3, 1);
  prism.rotateZ(Math.PI / 2);
  prism.rotateY(Math.PI / 2);
  prism.scale(1, 1, rise / half);
  prism.translate(0, o.wallHeight, 0);
  const geo = assemble([
    { geo: body, mat: MAT.metal, tone: 0.4 },
    { geo: prism, mat: MAT.metal, tone: 0.25 },
  ]);
  body.dispose(); prism.dispose();
  bakeContactAO(geo, { cell: 0.5, radius: 1, strength: 0.4, groundFade: 0.4 });
  return geo;
}

export function buildHut(opts = {}) {
  const lods = [buildHutLod0(opts), buildHutLod1(opts), buildHutLod2(opts)];
  return { lods, tris: lods.map(triCount) };
}

export const HUT_OBJECT = {
  id: "hut",
  label: "Corrugated hut",
  build: buildHut,
  defaults: HUT_DEFAULTS,
  footprintRadius: 3.2,
  tier: "hero",
  schema: [
    { key: "width", label: "Width", min: 2, max: 10, step: 0.1 },
    { key: "depth", label: "Depth", min: 2, max: 10, step: 0.1 },
    { key: "wallHeight", label: "Wall height", min: 1.6, max: 4, step: 0.05 },
    { key: "pitch", label: "Roof pitch", min: 0.05, max: 0.8, step: 0.01 },
    { key: "overhang", label: "Overhang", min: 0, max: 1.2, step: 0.02 },
    { key: "doorWidth", label: "Door width", min: 0.6, max: 2.4, step: 0.05 },
    { key: "panelsPerWall", label: "Sheets / wall", min: 2, max: 8, step: 1 },
    { key: "ribs", label: "Ribs / sheet", min: 3, max: 16, step: 1 },
    { key: "ribDepth", label: "Rib depth", min: 0.005, max: 0.08, step: 0.002 },
    { key: "lean", label: "Lean", min: 0, max: 3, step: 0.05 },
    { key: "sag", label: "Ridge sag", min: 0, max: 0.35, step: 0.005 },
    { key: "sandbags", label: "Sandbag courses", min: 0, max: 6, step: 1 },
    { key: "drums", label: "Oil drums", min: 0, max: 4, step: 1 },
    { key: "stovepipe", label: "Stovepipe", min: 0, max: 1, step: 1 },
    { key: "aoStrength", label: "Contact AO", min: 0, max: 1, step: 0.02 },
    { key: "seed", label: "Seed", min: 1, max: 999, step: 1 },
  ],
};
