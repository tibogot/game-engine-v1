/**
 * VIETNAMESE VILLAGE HOUSE — bamboo frame, woven walls, palm thatch.
 *
 * The building the setting is actually made of. Corrugated iron is the military
 * side of a firebase; this is every hamlet in the delta, and it is what makes a
 * map read as Vietnam rather than as generic jungle.
 *
 * WHAT CARRIES IT, in order:
 *
 *   1. THE ROOF. It is most of the silhouette and most of the read. Steeply
 *      pitched, very deep overhang (the eaves come down past head height and
 *      shade the walls), a thick rounded ridge, and a lower edge that is RAGGED
 *      — thatch is cut with a knife, not a saw. Built as overlapping courses so
 *      the layering is visible, not as a surface with a thatch picture on it.
 *   2. STILTS. Raising the floor is the delta signature, and the dark gap
 *      underneath gives the object a base shadow no amount of AO can fake.
 *   3. BAMBOO NODES. A smooth pole reads as pipe; the swollen collar every
 *      35 cm is what says bamboo at a glance, even at RTS distance.
 *   4. The woven wall panels, which only really read up close.
 *
 * One mesh, one draw. Thatch, bamboo and matting are told apart per-vertex and
 * sampled from one atlas — see rtsTextures.makeSurfaceAtlas for why that is an
 * atlas and not seven textures.
 */
import * as THREE from "three";
import {
  MAT, assemble, bakeContactAO, buildBambooPole, buildCorrugatedPanel,
  buildLadder, buildThatchSlope, rng, triCount,
} from "./rtsParts.js";

/*
 * SIZED FOR AN RTS CAMERA, NOT FOR A TAPE MEASURE.
 *
 * A real hut of this kind is about 4.4 m across, and at that size it renders
 * SMALLER THAN A HUEY (12 m long, 8.8 m rotor) — which reads as an object the
 * units walk past rather than a place they go to. RTS buildings are drawn
 * oversized for exactly this reason. MEASURED side by side at 1.0 / 1.6 / 2.2
 * against the units: 1.6 puts a building at roughly helicopter scale, which is
 * what a player expects; 2.2 starts to read as a monument.
 *
 * The SPANS are scaled, not the whole model — plank, rib and pole thickness
 * stay real, so it reads as a bigger building rather than a zoomed one.
 */
export const VILLAGE_HUT_DEFAULTS = {
  width: 8.0,           // along X, the gable ends
  depth: 6.4,           // along Z, the eaves sides
  stilt: 1.2,           // floor height above ground; 0 sits it on the earth
  wallHeight: 2.8,
  pitch: 0.95,          // rise / half span — thatch is STEEP so rain sheds
  overhang: 1.5,        // deep eaves, shading the walls
  gableOverhang: 0.65,
  courses: 9,           // thatch bundles up each slope
  ragged: 0.22,
  thatchThickness: 0.14,
  thatchTone: 0.3,      // 0.1 = weathered grey-brown, 0.6 = new straw
  thatchToneSpread: 0.6,
  poleRadius: 0.055,
  internodes: 6,
  wallPanels: 4,
  doorWidth: 1.45,
  ladder: 1,
  seed: 9,
  aoStrength: 0.55,
};

/** Bamboo uprights and the rails that tie them together. */
function frame(o, r, floorY) {
  const parts = [];
  const hx = o.width / 2, hz = o.depth / 2;
  const postY = floorY + o.wallHeight;
  // Corner and mid posts run the WHOLE way from ground to eave on a stilt house
  // — the floor hangs off them rather than sitting on separate legs.
  const xs = [-hx, 0, hx], zs = [-hz, hz];
  for (const x of xs) {
    for (const z of zs) {
      parts.push({
        geo: buildBambooPole({
          height: postY, radius: o.poleRadius * (0.95 + r() * 0.15),
          internodes: o.internodes, seg: 7,
        }),
        mat: MAT.bamboo, tone: r(),
        pos: [x, 0, z], rot: [(r() - 0.5) * 0.02, r() * 6.28, (r() - 0.5) * 0.02],
      });
    }
  }
  // Rails: floor level and eave level, round the perimeter.
  const rail = (len, axis) => buildBambooPole({
    height: len, radius: o.poleRadius * 0.8, internodes: Math.max(2, Math.round(len / 0.45)), seg: 6,
  });
  for (const y of [floorY, postY]) {
    for (const z of zs) {
      parts.push({
        geo: rail(o.width), mat: MAT.bamboo, tone: r(),
        pos: [-hx, y, z], rot: [0, 0, -Math.PI / 2],
      });
    }
    for (const x of [-hx, hx]) {
      parts.push({
        geo: rail(o.depth), mat: MAT.bamboo, tone: r(),
        pos: [x, y, -hz], rot: [Math.PI / 2, 0, 0],
      });
    }
  }
  return parts;
}

/**
 * The roof: two thatched slopes plus a ridge bundle.
 *
 * Placed with an explicit basis — the slope's local +Y must run up the pitch
 * and its +X along the ridge. Euler angles for this are order-dependent and got
 * it wrong once already on the corrugated hut.
 */
function thatchRoof(o, r, eaveY) {
  const half = o.width / 2 + o.overhang;
  const rise = half * o.pitch;
  const slope = Math.hypot(half, rise);
  const depth = o.depth + o.gableOverhang * 2;
  const parts = [];
  const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();
  for (let side = -1; side <= 1; side += 2) {
    const geo = buildThatchSlope({
      width: depth, slope, courses: o.courses,
      thickness: o.thatchThickness, ragged: o.ragged,
      // How weathered this roof is (rtsParts THATCH_DEFAULTS): new straw is
      // pale, a roof that has stood two monsoons is grey-brown. A hamlet wants
      // both, or every house in it reads as the same house.
      tone: o.thatchTone, toneSpread: o.thatchToneSpread,
      // Segments follow the course count: LOD1 halves the courses, so this
      // halves with them. Left fixed, LOD1 costs almost what LOD0 does.
      seg: Math.max(6, Math.round(depth * 1.4 * Math.min(1, o.courses / 9))),
      seed: o.seed * 7 + side,
    });
    // Y up the pitch, Z the OUTWARD normal, X derived so the basis is
    // right-handed. Deriving Z from a fixed X instead flips the handedness on
    // one of the two slopes: the thatch course is a single-sided strip, so that
    // slope is simply backface-culled and the roof comes out half missing.
    // (The corrugated hut got away with the same mistake because its panels are
    // closed solids.)
    Y.set(-side * half, rise, 0).normalize();
    Z.set(side * rise, half, 0).normalize();
    X.crossVectors(Y, Z).normalize();
    const m = new THREE.Matrix4().makeBasis(X, Y, Z);
    m.setPosition(side * half, eaveY, 0);
    parts.push({ geo, matrix: m });
  }
  // Ridge: a fat bundle capping the join, the thickest part of any thatch roof.
  const ridge = new THREE.CylinderGeometry(o.thatchThickness * 2.3, o.thatchThickness * 2.3, depth, 7, 1);
  ridge.rotateX(Math.PI / 2);
  parts.push({ geo: ridge, mat: MAT.thatch, tone: 0.35, pos: [0, eaveY + rise + o.thatchThickness, 0] });
  return parts;
}

/** Woven matting between the posts, with a doorway in the +Z side. */
function walls(o, r, floorY) {
  const parts = [];
  const hx = o.width / 2, hz = o.depth / 2;
  const panel = (span, doorFrom, doorTo) => {
    const out = [];
    const w = span / o.wallPanels;
    for (let i = 0; i < o.wallPanels; i++) {
      const x0 = -span / 2 + i * w, x1 = x0 + w;
      if (doorFrom != null && x1 > doorFrom && x0 < doorTo) continue;
      // A woven mat is flat: the corrugated builder with no ribs is just a
      // thin slab, and reusing it keeps one extrusion path in the kit.
      out.push({
        geo: buildCorrugatedPanel({
          width: w * 0.97, height: o.wallHeight * 0.96, ribs: 1, ribDepth: 0.004, thickness: 0.03,
        }),
        mat: MAT.woven, tone: r(),
        x: x0 + w / 2,
        rot: [(r() - 0.5) * 0.02, (r() - 0.5) * 0.03, (r() - 0.5) * 0.015],
      });
    }
    return out;
  };
  for (const p of panel(o.width, -o.doorWidth / 2, o.doorWidth / 2)) {
    parts.push({ geo: p.geo, mat: p.mat, tone: p.tone, pos: [p.x, floorY, hz], rot: p.rot });
  }
  for (const p of panel(o.width)) {
    parts.push({ geo: p.geo, mat: p.mat, tone: p.tone, pos: [p.x, floorY, -hz], rot: p.rot });
  }
  for (const side of [-1, 1]) {
    for (const p of panel(o.depth)) {
      parts.push({
        geo: p.geo, mat: p.mat, tone: p.tone,
        pos: [side * hx, floorY, p.x], rot: [p.rot[0], Math.PI / 2 + p.rot[1], p.rot[2]],
      });
    }
  }
  return parts;
}

export function buildVillageHutLod0(opts = {}) {
  const o = { ...VILLAGE_HUT_DEFAULTS, ...opts };
  const r = rng(o.seed);
  const floorY = o.stilt;
  const parts = [];

  parts.push(...frame(o, r, floorY));
  parts.push(...walls(o, r, floorY));

  // Floor: a bamboo deck. One slab, since you only ever see its edge.
  const deck = new THREE.BoxGeometry(o.width + 0.1, 0.09, o.depth + 0.1);
  parts.push({ geo: deck, mat: MAT.bamboo, tone: 0.5, pos: [0, floorY, 0] });

  parts.push(...thatchRoof(o, r, floorY + o.wallHeight));

  if (o.ladder > 0 && floorY > 0.3) {
    parts.push({
      geo: buildLadder({ height: floorY + 0.35, width: 0.46, rail: 0.05, rungs: Math.max(2, Math.round(floorY * 3)), rung: 0.04 }),
      mat: MAT.bamboo, tone: 0.6,
      pos: [0, 0, o.depth / 2 + 0.34], rot: [-0.20, 0, 0],
    });
  }

  const geo = assemble(parts);
  for (const p of parts) p.geo.dispose();
  bakeContactAO(geo, { cell: 0.2, radius: 2, strength: o.aoStrength, groundFade: 0.3 });
  return geo;
}

/** LOD1 — fewer thatch courses and wall panels; the silhouette is unchanged. */
export function buildVillageHutLod1(opts = {}) {
  const o = { ...VILLAGE_HUT_DEFAULTS, ...opts };
  return buildVillageHutLod0({
    ...opts,
    courses: Math.max(3, Math.round(o.courses / 3)),
    wallPanels: 1,
    internodes: 3,
    ladder: 0,
  });
}

/** LOD2 — box, prism, legs. Footprint, height, ridge. */
export function buildVillageHutLod2(opts = {}) {
  const o = { ...VILLAGE_HUT_DEFAULTS, ...opts };
  const half = o.width / 2 + o.overhang;
  const rise = half * o.pitch;
  const eaveY = o.stilt + o.wallHeight;
  const body = new THREE.BoxGeometry(o.width, o.wallHeight, o.depth);
  body.translate(0, o.stilt + o.wallHeight / 2, 0);
  const prism = new THREE.CylinderGeometry(half * 1.02, half * 1.02, o.depth + o.gableOverhang * 2, 3, 1);
  prism.rotateZ(Math.PI / 2);
  prism.rotateY(Math.PI / 2);
  prism.scale(1, 1, rise / half);
  prism.translate(0, eaveY, 0);
  const parts = [
    { geo: body, mat: MAT.woven, tone: 0.4 },
    { geo: prism, mat: MAT.thatch, tone: 0.35 },
  ];
  if (o.stilt > 0.3) {
    const leg = new THREE.BoxGeometry(0.12, o.stilt, 0.12);
    leg.translate(0, o.stilt / 2, 0);
    for (const x of [-o.width / 2, o.width / 2]) {
      for (const z of [-o.depth / 2, o.depth / 2]) parts.push({ geo: leg, mat: MAT.bamboo, tone: 0.5, pos: [x, 0, z] });
    }
  }
  const geo = assemble(parts);
  for (const p of parts) p.geo.dispose();
  bakeContactAO(geo, { cell: 0.5, radius: 1, strength: 0.35, groundFade: 0.3 });
  return geo;
}

export function buildVillageHut(opts = {}) {
  const lods = [buildVillageHutLod0(opts), buildVillageHutLod1(opts), buildVillageHutLod2(opts)];
  return { lods, tris: lods.map(triCount) };
}

export const VILLAGE_HUT_OBJECT = {
  id: "villageHut",
  label: "Vietnamese village house",
  build: buildVillageHut,
  defaults: VILLAGE_HUT_DEFAULTS,
  footprintRadius: 3.6,
  tier: "hero",
  schema: [
    { key: "width", label: "Width", min: 2.5, max: 10, step: 0.1 },
    { key: "depth", label: "Depth", min: 2.5, max: 10, step: 0.1 },
    { key: "stilt", label: "Stilt height", min: 0, max: 2.5, step: 0.05 },
    { key: "wallHeight", label: "Wall height", min: 1.2, max: 3.2, step: 0.05 },
    { key: "pitch", label: "Roof pitch", min: 0.4, max: 1.8, step: 0.02 },
    { key: "overhang", label: "Eave overhang", min: 0.2, max: 2.2, step: 0.05 },
    { key: "gableOverhang", label: "Gable overhang", min: 0, max: 1.5, step: 0.05 },
    { key: "courses", label: "Thatch courses", min: 3, max: 16, step: 1 },
    { key: "ragged", label: "Thatch ragged", min: 0, max: 0.6, step: 0.02 },
    { key: "thatchThickness", label: "Thatch depth", min: 0.03, max: 0.35, step: 0.01 },
    { key: "poleRadius", label: "Pole radius", min: 0.02, max: 0.14, step: 0.005 },
    { key: "internodes", label: "Bamboo nodes", min: 2, max: 12, step: 1 },
    { key: "wallPanels", label: "Wall panels", min: 1, max: 6, step: 1 },
    { key: "doorWidth", label: "Door width", min: 0.5, max: 2.2, step: 0.05 },
    { key: "ladder", label: "Ladder", min: 0, max: 1, step: 1 },
    { key: "aoStrength", label: "Contact AO", min: 0, max: 1, step: 0.02 },
    { key: "seed", label: "Seed", min: 1, max: 999, step: 1 },
  ],
};
