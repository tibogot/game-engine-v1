// ============================================================================
// ELEVATOR — the cage lift that carries the car between track levels.
//
// It replaces a 10×12 grey slab with two rail-shaped boxes bolted to it. What
// was wrong with the slab was not detail, it was that nothing about it said
// "this thing moves, and this is where it goes": a platform with no shaft reads
// as a floating plate, and at 10 m it was narrower than the 16 m road it is
// supposed to join, so it never lined up with anything you could build.
//
// So: a real hoist. A STATIC lattice shaft that stays put and shows the travel,
// and a MOVING cage that runs up and down inside it, walled in the same
// chain-link weave as the objects-lab fence (the texture is literally shared —
// see chainLinkTexture in v2/objects/chainLinkFence.js).
//
// ── WHAT IT COSTS, AND WHY THAT IS THE INTERESTING PART ────────────────────
// Detail on something that moves is the expensive kind. Three rules keep it
// affordable, and every one of them is load-bearing:
//
//  1. ONE TEMPLATE, CLONED. `make()` is called per placement, so building the
//     geometry there would mean N sets of buffers and N shader compiles for N
//     elevators. The template is built once; placements are `clone()`, which in
//     three shares geometry AND materials by reference. Twenty elevators are
//     twenty draws of one geometry with one compiled program.
//
//  2. MERGED BY ROLE, NOT BY PART. The mast lattice is ~40 boxes and the cage
//     another ~50; drawn as parts that would be 90 draw calls each way. They are
//     merged into one static mesh and one moving mesh, tinted with vertex
//     colours so a single material still covers galvanised steel, painted
//     yellow and rust. Five draws for the whole thing, however detailed it gets.
//
//  3. THE COLLIDERS ARE NOT THE VISUALS. The deck the wheels ride is a 12-tri
//     box, and the walls the chassis hits are two thin boxes — 36 triangles of
//     physics under ~9k triangles of look. `RoadBvh.bakeFromMeshes` reads a
//     mesh's own geometry and never its children, so everything hanging off the
//     platform is free by construction (the same trick the rotating tube's glow
//     rims use).
// ============================================================================
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { float, materialColor, materialEmissive, mix, positionView, smoothstep } from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
import { markSharedGeometry } from "./modularRoadBatching.js";
import { chainLinkTexture } from "../../v2/objects/chainLinkFence.js";

/**
 * Deck a touch WIDER than the 16 m road (roadParams.width), on purpose: an
 * elevator you have to hit dead centre is an elevator you fall off, and the
 * extra 20 cm a side means the kerbs of a joining straight land on plate
 * rather than over the edge.
 */
export const ELEVATOR = {
  deckW: 16.4,   // X — across the road
  deckL: 13.0,   // Z — along the road (the drive-through axis)
  deckT: 0.55,   // plate thickness
  // ── LIFT HEIGHT, IN METRES OF DECK SURFACE ──────────────────────────────
  // Parked, the deck's TOP FACE is flush with the root's own y — the plate sits
  // in a pit, so you drive on without a step. Raised, that same face is exactly
  // `rise` metres up. Both halves matter: it means the number on the slider is
  // the height you build the upper road at, with no plate thickness to subtract,
  // and 16 puts the deck at exactly 16.0 — two cells of the builder's 8 m grid.
  rise: 8.0,
  cageH: 3.9,    // cage height above the deck
  postR: 0.16,   // half-section of a corner post
  mastR: 0.22,   // half-section of a shaft mast
  mastGap: 0.55, // clearance between the deck edge and a mast
  headroom: 1.6, // shaft above the top of travel
  liftSpeed: 2.4, // m/s of climb
  kerbH: 0.34,   // toe board
  railY: 1.25,   // mid rail height
};

const COLORS = {
  steel: 0x9aa3ab,   // galvanised mast / frame
  dark: 0x4a5158,    // shadow-side members, plate underside
  paint: 0xd8b02a,   // safety yellow
  hazard: 0x1a1c1f,  // hazard stripe dark
  deck: 0x6e767e,    // chequer plate
  rust: 0x6e4a33,
};

/* ------------------------------------------------------------------ */
/* geometry helpers                                                    */
/* ------------------------------------------------------------------ */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

/** Bake a flat colour into a geometry so many parts can share one material. */
function tint(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const buf = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    buf[i * 3] = c.r; buf[i * 3 + 1] = c.g; buf[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(buf, 3));
  return geo;
}

/**
 * A coloured box, positioned and optionally rotated, ready to merge.
 * UVs are deleted: mergeGeometries refuses a set whose attributes differ, and
 * nothing in the merged meshes is textured.
 */
function bar(w, h, d, x, y, z, hex, rot = null) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.deleteAttribute("uv");
  if (rot) {
    _m.compose(
      new THREE.Vector3(x, y, z),
      _q.setFromEuler(_e.set(rot[0] ?? 0, rot[1] ?? 0, rot[2] ?? 0)),
      _s.set(1, 1, 1),
    );
  } else {
    _m.makeTranslation(x, y, z);
  }
  g.applyMatrix4(_m);
  return tint(g, hex);
}

/**
 * One shaft mast: a square tube with rungs up it.
 *
 * The rungs are what make it read as a lattice from the car rather than as a
 * plain post, and they are the cheapest possible version of that — a box every
 * `step` metres, merged into the same buffer as everything else.
 */
function mast(x, z, height, out) {
  out.push(bar(ELEVATOR.mastR * 2, height, ELEVATOR.mastR * 2, x, height / 2, z, COLORS.steel));
  const step = 1.45;
  const t = ELEVATOR.mastR * 0.55;
  for (let y = step; y < height - 0.4; y += step) {
    // A short diagonal stub either side — a whole X-brace per bay is four times
    // the geometry for a pattern you read at 30 m/s as "lattice" either way.
    out.push(bar(t, t * 0.9, ELEVATOR.mastR * 3.2, x, y, z, COLORS.dark, [0.62, 0, 0]));
  }
  // Foot plate.
  out.push(bar(ELEVATOR.mastR * 3.4, 0.18, ELEVATOR.mastR * 3.4, x, 0.09, z, COLORS.dark));
}

/**
 * The hazard band along an open end of the deck.
 *
 * Alternating quads rather than a striped texture, because vertex colours merge
 * into the cage's single buffer and a texture would cost the cage its own
 * material and its own draw call. 2 tris per stripe.
 */
function hazardBand(zSign, out) {
  const { deckW, deckL, deckT } = ELEVATOR;
  const n = 22;
  const w = deckW / n;
  const z = zSign * (deckL / 2 + 0.012);
  for (let i = 0; i < n; i++) {
    const x = -deckW / 2 + w * (i + 0.5);
    out.push(bar(w, deckT * 0.62, 0.03, x, -deckT * 0.08, z, i % 2 ? COLORS.hazard : COLORS.paint));
  }
}

/* ------------------------------------------------------------------ */
/* the template                                                        */
/* ------------------------------------------------------------------ */

let _template = null;
let _materials = null;

/** Materials are built once and SHARED by every placement — see rule 1 up top. */
function elevatorMaterials() {
  if (_materials) return _materials;

  const steel = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    roughness: 0.52,
    metalness: 0.72,
  });
  // Keeps the fog live. The shaft never moves, and three's WebGPU backend only
  // re-uploads a render object's uniforms when its material carries a NODE
  // property — so a plain material on the static masts would freeze whatever
  // fog it first rendered with while the track around it updated.
  steel.colorNode = materialColor;

  const deck = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(COLORS.deck),
    roughness: 0.78,
    metalness: 0.35,
  });
  deck.colorNode = materialColor;

  // The diamond weave, straight from the objects-lab fence. `meshWire / pitch`
  // is the same ratio that builder passes, so the diamonds come out the size
  // they do on a real fence rather than as a coarse grid.
  const tex = chainLinkTexture("#b9c0c6", 0.02 / 0.14);
  const curtain = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(0xb9c0c6),
    map: tex,
    alphaMap: tex,
    transparent: false, // alpha TEST, not blend — no sorting, writes depth
    side: THREE.DoubleSide,
    roughness: 0.6,
    metalness: 0.55,
  });
  curtain.colorNode = materialColor;

  // ── THE CUT HAS TO FALL WITH DISTANCE ─────────────────────────────────────
  // A fixed alpha test makes thin wire DISAPPEAR far away, and measurably so:
  // at a flat 0.45 the whole weave was gone by 40 m, leaving an elevator with a
  // frame and no walls. Nothing is wrong with the texture — the mip chain is
  // averaging a mostly-empty tile, so the sampled alpha falls below the cut long
  // before the wall should stop being visible.
  //
  // Lowering the cut with view distance keeps the coverage instead: crisp
  // diamonds up close, and far away the averaged weave survives as the grey
  // haze that real chain-link actually reads as, rather than as a hole.
  curtain.alphaTestNode = mix(float(0.42), float(0.05), smoothstep(float(14), float(50), positionView.length()));

  const glow = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(0xffb43c),
    emissive: new THREE.Color(0xffb43c),
    emissiveIntensity: 5,
    roughness: 0.4,
  });
  // v3's bloom is selective: intensity alone does nothing without the MRT.
  applyBloomMRT(glow, materialEmissive);

  _materials = { steel, deck, curtain, glow };
  return _materials;
}

/** The chain-link curtain on one side: a single quad, UV'd in diamond units. */
function curtainPanel(xSign) {
  const { deckW, deckL, cageH, kerbH } = ELEVATOR;
  const y0 = kerbH;
  const y1 = cageH - 0.18;
  const x = xSign * (deckW / 2 - 0.1);
  const pitch = 0.34; // metres per diamond on the cage — coarser than a fence
  const u = deckL / pitch;
  const v = (y1 - y0) / pitch;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([
    x, y0, -deckL / 2, x, y0, deckL / 2, x, y1, deckL / 2, x, y1, -deckL / 2,
  ], 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, u, 0, u, v, 0, v], 2));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(
    [xSign, 0, 0, xSign, 0, 0, xSign, 0, 0, xSign, 0, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/**
 * The static shaft, as ONE merged geometry for a given lift height.
 *
 * Per-instance rather than shared, and that is the whole reason the height
 * slider can exist: a shaft is only legible if it is as tall as the travel it
 * encloses, so a shared 8 m shaft would leave a 20 m elevator climbing out
 * through its own roof. It is ~40 boxes and rebuilding it costs ~4 ms, against
 * one extra buffer per placed elevator — of which a track has a handful.
 *
 * @param {number} rise lift height, metres
 */
function shaftGeometry(rise) {
  const { deckW, deckL, cageH, mastR, mastGap, headroom } = ELEVATOR;
  const parts = [];
  const mx = deckW / 2 + mastGap + mastR;
  const mz = deckL / 2 + mastGap + mastR;
  // Tall enough to still enclose the cage at the top of the travel. Measured
  // from the root, which is where the shaft's feet sit.
  const shaftH = rise + cageH + headroom;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) mast(sx * mx, sz * mz, shaftH, parts);
  // Head beams tie the masts together ALONG X only — a beam across the ±Z ends
  // would cap the drive-through, which is the one thing the shaft must not do.
  for (const sz of [-1, 1]) {
    parts.push(bar(mx * 2 + mastR * 2, mastR * 1.6, mastR * 1.6, 0, shaftH - mastR, sz * mz, COLORS.steel));
  }
  // Side rails at the top of travel, tying each pair front-to-back.
  for (const sx of [-1, 1]) {
    parts.push(bar(mastR * 1.4, mastR * 1.4, mz * 2, sx * mx, shaftH - mastR * 3.4, 0, COLORS.dark));
  }

  // ── LANDING MARK: WHERE THE UPPER ROAD GOES ───────────────────────────────
  // A painted band round each mast at exactly the height the raised deck's top
  // face reaches. It is an authoring aid first: the platform is parked at the
  // BOTTOM the whole time you are building (nothing calls it, because there is
  // no car), so without this the upper level is a number in the inspector and
  // nothing you can see or line a piece up against. It doubles as the thing that
  // tells a driver at ground level how far the ride goes.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    parts.push(bar(mastR * 2.5, 0.26, mastR * 2.5, sx * mx, rise, sz * mz, COLORS.paint));
  }
  // ...and a rail joining them down each side, so the level reads as a PLANE
  // rather than four unrelated blobs. Along Z only: across the ends would put a
  // bar through the drive-through at exactly deck height.
  for (const sx of [-1, 1]) {
    parts.push(bar(0.09, 0.09, mz * 2, sx * mx, rise, 0, COLORS.paint));
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  return merged;
}

function buildTemplate() {
  const { deckW, deckL, deckT, cageH, postR, mastR, mastGap, rise,
          kerbH, railY } = ELEVATOR;
  const mats = elevatorMaterials();

  const root = new THREE.Group();
  root.name = "Elevator";

  // ── STATIC SHAFT ──────────────────────────────────────────────────────────
  // In ROOT space and never parented to the platform, so it stays put while the
  // cage runs. This is the part that makes the thing legible: you can see where
  // the platform is going before it gets there.
  const shaft = new THREE.Mesh(shaftGeometry(rise), mats.steel);
  shaft.name = "ElevatorShaft";
  shaft.castShadow = true;
  shaft.receiveShadow = true;
  root.add(shaft);

  // ── THE PLATFORM: the collision mesh, and the parent of everything moving ──
  // A plain box on purpose. The wheels ride this and nothing else, so it is
  // twelve triangles; every part below hangs off it as a CHILD and is therefore
  // invisible to the collision bake.
  const platform = new THREE.Mesh(new THREE.BoxGeometry(deckW, deckT, deckL), mats.deck);
  platform.name = "ElevatorPlatform";
  platform.castShadow = true;
  platform.receiveShadow = true;
  root.add(platform);

  // ── MOVING CAGE ───────────────────────────────────────────────────────────
  const cage = [];
  const top = deckT / 2;
  const px = deckW / 2 - postR;
  const pz = deckL / 2 - postR;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    cage.push(bar(postR * 2, cageH, postR * 2, sx * px, top + cageH / 2, sz * pz, COLORS.steel));
  }
  for (const sx of [-1, 1]) {
    // top rail, mid rail and toe board down each walled side
    cage.push(bar(postR * 1.5, postR * 1.5, deckL, sx * px, top + cageH - postR, 0, COLORS.steel));
    cage.push(bar(postR * 1.2, postR * 1.2, deckL, sx * px, top + railY, 0, COLORS.paint));
    cage.push(bar(0.12, kerbH, deckL, sx * (deckW / 2 - 0.06), top + kerbH / 2, 0, COLORS.paint));
  }
  // Head rails across the open ends, high enough to drive under (cage roof line).
  for (const sz of [-1, 1]) {
    cage.push(bar(deckW, postR * 1.5, postR * 1.5, 0, top + cageH - postR, sz * pz, COLORS.steel));
  }
  // Plate underside: a rim so the platform is not a floating slice from below.
  cage.push(bar(deckW + 0.12, 0.16, 0.16, 0, -deckT / 2 - 0.05, deckL / 2, COLORS.dark));
  cage.push(bar(deckW + 0.12, 0.16, 0.16, 0, -deckT / 2 - 0.05, -deckL / 2, COLORS.dark));
  for (const sx of [-1, 1]) {
    cage.push(bar(0.16, 0.16, deckL, sx * (deckW / 2 + 0.02), -deckT / 2 - 0.05, 0, COLORS.dark));
  }
  // Guide shoes: the blocks that ride the masts. Small, but they are the reason
  // the cage looks attached to the shaft instead of passing through it.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    cage.push(bar(mastGap + 0.3, 0.5, 0.42, sx * (deckW / 2 + mastGap / 2), top + 0.9, sz * pz, COLORS.dark));
  }
  hazardBand(1, cage);
  hazardBand(-1, cage);
  const cageMesh = new THREE.Mesh(mergeGeometries(cage, false), mats.steel);
  cageMesh.name = "ElevatorCage";
  cage.forEach((g) => g.dispose());
  cageMesh.castShadow = true;
  cageMesh.receiveShadow = true;
  platform.add(cageMesh);

  // ── CHAIN-LINK CURTAINS ───────────────────────────────────────────────────
  const curtain = new THREE.Mesh(
    mergeGeometries([curtainPanel(-1), curtainPanel(1)], false),
    mats.curtain,
  );
  curtain.name = "ElevatorMesh";
  curtain.position.y = deckT / 2;
  // Casts, does not receive: the weave self-shadowing at this scale is noise,
  // and the alpha-tested shadow pass is the expensive half of an alpha material.
  curtain.castShadow = true;
  curtain.receiveShadow = false;
  platform.add(curtain);

  // ── GLOW STRIP ────────────────────────────────────────────────────────────
  // Under the top rail on both walled sides. It is how you spot the platform
  // from across the map and, more usefully, where it is in its travel.
  const strips = [];
  for (const sx of [-1, 1]) {
    strips.push(bar(0.09, 0.13, deckL - 0.5, sx * (px - postR - 0.05), top + cageH - postR * 2.4, 0, 0xffffff));
  }
  const glow = new THREE.Mesh(mergeGeometries(strips, false), mats.glow);
  glow.name = "ElevatorGlow";
  strips.forEach((g) => g.dispose());
  platform.add(glow);

  // ── SOLID WALLS (invisible) ───────────────────────────────────────────────
  // The chassis has to be stopped by the cage sides, and a chain-link curtain is
  // a single flat quad — precisely the thing the hull's triangle sampling
  // slips through. Two thin boxes, 24 triangles, never drawn.
  const wallGeos = [];
  for (const sx of [-1, 1]) {
    wallGeos.push(bar(0.14, cageH - kerbH, deckL, sx * (deckW / 2 - 0.07), top + kerbH + (cageH - kerbH) / 2, 0, 0xffffff));
  }
  const walls = new THREE.Mesh(mergeGeometries(wallGeos, false), mats.steel);
  walls.name = "ElevatorWalls";
  wallGeos.forEach((g) => g.dispose());
  walls.visible = false;
  platform.add(walls);

  markSharedGeometry(root);
  // ...except the shaft. It is the ONE part that is per-instance, because its
  // height tracks the stroke — so each placement owns its buffer and must free
  // it. Un-marking here rather than never marking keeps `markSharedGeometry` a
  // single blanket call that cannot miss a new part someone adds later.
  shaft.geometry.userData.sharedTemplate = false;
  return root;
}

/**
 * A placement: a clone of the shared template, with the bind wired to the
 * CLONE's meshes (the template's own must never be animated).
 *
 * @returns {{root: THREE.Object3D, bind: object}}
 */
export function makeElevator() {
  if (!_template) _template = buildTemplate();
  const root = _template.clone(true);

  const platform = root.getObjectByName("ElevatorPlatform");
  const walls = root.getObjectByName("ElevatorWalls");

  // The clone shares the template's shaft geometry by reference; give this
  // placement its own so `setElevatorRise` can rebuild it without every other
  // elevator on the track changing height too.
  const shaft = root.getObjectByName("ElevatorShaft");
  shaft.geometry = shaftGeometry(ELEVATOR.rise);

  const bind = {
    mesh: platform,
    solidMesh: walls,
    // CALLED, not cyclic: it waits at the bottom for the car and waits at the
    // top until the car leaves. See ParkourMover._updateLift for why an
    // elevator is the one mover that must not be a sine wave.
    mode: "lift",
    speed: ELEVATOR.liftSpeed,
    amplitude: ELEVATOR.rise,
    isDeck: true,
    slideOrigin: new THREE.Vector3(),
    /**
     * Called by the palette inspector when the height slider moves. Declared on
     * the BIND so the mover manager can drive it without importing anything
     * about elevators — any future mover whose look depends on its amplitude can
     * declare the same hook.
     */
    onAmplitude: (r, a) => setElevatorRise(r, a),
  };
  setElevatorRise(root, ELEVATOR.rise, bind);
  return { root, bind };
}

/**
 * Re-height one elevator for a new stroke.
 *
 * Two things have to move together or the object stops making sense: the shaft
 * has to be tall enough to enclose the cage at the top of the stroke, and the
 * platform's slide ORIGIN has to sit half a stroke up so that the bottom of the
 * travel is still ground level. Getting the second wrong sinks the platform into
 * the ground for the bottom half of every cycle.
 *
 * @param {THREE.Object3D} root the placement
 * @param {number} rise HALF-stroke, metres (the mover's `amplitude`)
 * @param {object} [bind] defaults to the root's own
 */
export function setElevatorRise(root, rise, bind = root.userData.moverBind) {
  const clamped = Math.max(0.5, rise);
  const platform = root.getObjectByName("ElevatorPlatform");
  const shaft = root.getObjectByName("ElevatorShaft");
  if (!platform || !shaft) return;

  // PARKED POSITION: deck top flush with the root's y, so the plate is recessed
  // and you drive on without a step. The lift then adds `rise` on top of it,
  // which is what makes the slider read as "the height of the upper road".
  const parkedY = -ELEVATOR.deckT / 2;
  platform.position.set(0, parkedY, 0);
  if (bind) {
    bind.amplitude = clamped;
    bind.slideOrigin.set(0, parkedY, 0);
  }
  // The live mover holds its own copy of the origin (ParkourMover clones it at
  // construction), so a height change has to reach that too.
  const mover = root.userData.moverPropInstance?.mover;
  if (mover) {
    mover.origin.set(0, parkedY, 0);
    mover.amplitude = clamped;
  }

  // Quantised: a slider drag would otherwise rebuild ~40 boxes and a merge on
  // every pointermove. Half a metre is finer than you can see on a mast.
  const step = Math.round(clamped * 2) / 2;
  if (shaft.userData.builtRise === step) return;
  shaft.userData.builtRise = step;
  shaft.geometry?.dispose();
  shaft.geometry = shaftGeometry(step);
}

/** Free the shared template — full teardown only, never per placement. */
export function disposeElevatorTemplate() {
  _template?.traverse((o) => {
    if (o.isMesh) o.geometry?.dispose?.();
  });
  _template = null;
  if (_materials) {
    for (const m of Object.values(_materials)) m.dispose?.();
    _materials = null;
  }
}
