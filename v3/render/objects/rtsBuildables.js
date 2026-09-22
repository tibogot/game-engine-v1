/**
 * BUILDABLES — what a builder raises in a firebase, on the parts kit.
 *
 * The same rules as rtsFirebaseProps.js (real size x 1.3, parts with weight,
 * one atlas material, markings on the shared stencil sheet) and the same
 * contract: a merged geometry, origin at the ground centre, `userData.footprint`
 * for its pad and nav, `userData.stencil` for its markings. What a game needs
 * to animate is returned separately (the gun that turns, the lights that pulse).
 *
 *   · HELIPAD  — PSP matting (perforated steel plank, laid staggered, rust
 *                patchwork), the painted H in its ring, sandbag revetments on
 *                three sides, a red-and-white windsock on a mast, corner lights
 *   · GUN PIT  — the sandbag ring with an M60 on a pintle post over the bags;
 *                the gun is its own geometry and yaws
 *   · RADIO POST — the signals shelter and guyed mast, with its markings
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { MAT, assemble, bakeContactAO, buildBox, buildPost, buildSandbagWall, rng } from "./rtsParts.js";
import { buildGunPit, buildRadioStation } from "./rtsFirebaseProps.js";
import { flatSurface, mergeStencils, stencilPatch } from "./rtsStencils.js";

const S = 1.3;

// ── Helipad ──────────────────────────────────────────────────────────────────
/**
 * `half`: half the deck's side, metres. M8A1 PSP plank: 3.05 x 0.38 m real,
 * laid in rows across the deck with every other row offset half a plank —
 * the brick bond that reads as matting from the air. Each plank's own rust
 * tone makes the patchwork every photograph of a firebase pad shows.
 *
 * userData: footprint, stencil, lights (corner light positions), height.
 */
export function buildHelipad({ seed = 51, half = 8 } = {}) {
  const R = rng(seed);
  const parts = [];
  const plankL = 3.05 * S, plankW = 0.38 * S, plankT = 0.035;
  const base = 0.12;                       // the graded earth bed under the matting
  const top = base + plankT;
  parts.push({ geo: buildBox(2 * half + 1.4, base, 2 * half + 1.4), pos: [0, base / 2, 0], mat: MAT.earth, tone: 0.4 });
  const rows = Math.round((2 * half) / plankW);
  const rowW = (2 * half) / rows;
  const holes = [];   // each plank's punched holes, painted on (stencils below)
  for (let r = 0; r < rows; r++) {
    const z = -half + (r + 0.5) * rowW;
    // Offset every other row by half a plank; clip the ends to the deck edge.
    let x = -half - (r % 2 ? plankL / 2 : 0);
    while (x < half) {
      const x0 = Math.max(-half, x), x1 = Math.min(half, x + plankL);
      if (x1 - x0 > 0.2) {
        // Mostly weathered steel; one plank in six a fresher replacement.
        const tone = R() < 0.16 ? 0.75 + R() * 0.2 : 0.35 + R() * 0.3;
        parts.push({ geo: buildBox(x1 - x0 - 0.02, plankT, rowW - 0.02), pos: [(x0 + x1) / 2, base + plankT / 2, z], mat: MAT.metal, tone });
        // A clipped plank keeps its holes' spacing: the patch covers only the
        // part of a whole plank that is there.
        holes.push({ x, z, s0: (x0 - x) / plankL, s1: (x1 - x) / plankL });
      }
      x += plankL;
    }
  }

  // Revetments: sandbag walls on both sides and the back, 1.6 m off the deck,
  // open on the front (+Z) for the approach.
  const bag = { length: 0.52 * S, width: 0.30 * S, height: 0.19 * S, segU: 6, segV: 4 };
  const off = half + 1.6, courses = 4;
  for (const sx of [-1, 1]) {
    parts.push({ geo: buildSandbagWall({ length: 2 * half + 1.2, courses, seed: seed + (sx > 0 ? 1 : 2), bag, batter: 0.04 }), pos: [sx * off, 0, -0.6], rot: [0, Math.PI / 2, 0], mat: null });
  }
  parts.push({ geo: buildSandbagWall({ length: 2 * off - 1.0, courses, seed: seed + 3, bag, batter: 0.04 }), pos: [0, 0, -off], mat: null });

  // Corner light housings; the glowing lamps on them are the game's.
  const lights = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (half + 0.45), z = sz * (half + 0.45);
    parts.push({ geo: buildBox(0.34, 0.22, 0.34), pos: [x, base + 0.11, z], mat: MAT.metal, tone: 0.15 });
    lights.push([x, base + 0.34, z]);
  }

  // Windsock mast off the front-right corner.
  const wx = half + 1.3, wz = half + 1.3, mH = 5 * S;
  parts.push({ geo: buildPost({ height: mH, width: 0.09, depth: 0.09, taper: 0.4, round: true }), pos: [wx, 0, wz], mat: MAT.metal, tone: 0.55 });
  parts.push({ geo: buildBox(0.5, 0.12, 0.5), pos: [wx, 0.06, wz], mat: MAT.concrete, tone: 0.5 });
  // The sock's frame ring at its mouth, on a short swivel arm.
  const mouthR = 0.3 * S, tailR = 0.12 * S, sockL = 1.7 * S, droop = 0.32, yaw = 0.6;
  const dir = new THREE.Vector3(Math.cos(droop) * Math.cos(yaw), -Math.sin(droop), Math.cos(droop) * Math.sin(yaw));
  const mouth = new THREE.Vector3(wx, mH - 0.1, wz).addScaledVector(dir, 0.35);
  const ring = new THREE.TorusGeometry(mouthR, 0.018, 5, 16);
  ring.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir));
  parts.push({ geo: ring, pos: [mouth.x, mouth.y, mouth.z], mat: MAT.metal, tone: 0.3 });
  parts.push({ geo: buildBox(0.04, 0.04, 0.4).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir)), pos: [wx + dir.x * 0.18, mH - 0.1 + dir.y * 0.18, wz + dir.z * 0.18], mat: MAT.metal, tone: 0.3 });

  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.3 * S, radius: 2, strength: 0.35, groundFade: 0.3, floor: 0.55 });

  // Markings: the H on the deck (its top toward +Z), and the sock's cloth —
  // a cone of red and white bands from the ring to the tail, inside and out.
  const st = [];
  for (const h of holes) {
    const surf = flatSurface([h.x + plankL / 2, top, h.z], [0, 1, 0], [1, 0, 0], plankL, "pspHoles");
    st.push(stencilPatch("pspHoles", surf, { sList: [h.s0 + 0.004, h.s1 - 0.004], lift: 0.014 }));
  }
  // The H UNDER the holes: paint on PSP never filled them.
  st.push(stencilPatch("helipadH", flatSurface([0, top, 0], [0, 1, 0], [-1, 0, 0], half * 1.25, "helipadH"), { lift: 0.005 }));
  const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
  const upv = new THREE.Vector3().crossVectors(side, dir).normalize();
  for (const inward of [false, true]) {
    st.push(stencilPatch("sockBands", (s, t) => {
      const a = s * Math.PI * 2;
      // Cloth sags toward the tail: the radius shrinks and the axis droops.
      const r = (mouthR + (tailR - mouthR) * t) * (inward ? 0.97 : 1);
      const c = mouth.clone().addScaledVector(dir, t * sockL).addScaledVector(upv, -0.12 * t * t);
      const n = side.clone().multiplyScalar(Math.cos(a)).addScaledVector(upv, Math.sin(a));
      const p = c.clone().addScaledVector(n, r);
      return { p, n: inward ? n.negate() : n };
    }, { segS: 12, segT: 6, lift: 0 }));
  }
  geo.userData.stencil = mergeStencils(st);
  geo.userData.footprint = { cx: 0, cz: -0.8, hx: off + 0.6, hz: half + 1.9 };
  geo.userData.lights = lights;
  geo.userData.height = 2.0;
  return geo;
}

// ── Gun pit (M60) ────────────────────────────────────────────────────────────
/** The gun is drawn larger than life: at x1.4 it was a few dark pixels from
 *  the RTS camera (judged in the game). x2.4 reads as a gun at the pit. */
const GUN = S * 2.4;
/** Pivot height above the pit's ground origin: on a post, over the bags. */
export const GUN_PIT_HEAD_Y = 1.5 * S;
/** Muzzle, in the gun's own frame (pivot at the origin, barrel along +Z). */
export const GUN_PIT_MUZZLE = new THREE.Vector3(0, 0.0, 0.93 * GUN);

/** The static part: the sandbag ring, its stores, and the pintle post. */
export function buildGunPitBody({ seed = 7 } = {}) {
  const pit = buildGunPit({ seed });
  const postH = GUN_PIT_HEAD_Y - 0.1 * GUN;
  const post = assemble([
    { geo: buildPost({ height: postH, width: 0.2 * S, depth: 0.2 * S, taper: 0.1 }), mat: MAT.timber, tone: 0.35 },
    // The pintle socket the gun's cradle turns in.
    { geo: new THREE.CylinderGeometry(0.06 * S, 0.06 * S, 0.1 * GUN, 8), pos: [0, postH + 0.05 * GUN, 0], mat: MAT.metal, tone: 0.1 },
  ]);
  // The pit already carries its baked AO; the post gets its own, so the two
  // have one attribute layout.
  bakeContactAO(post, { cell: 0.1 * S, radius: 1, strength: 0.3, groundFade: 0.3, floor: 0.55 });
  const geo = mergeGeometries([pit, post], false);
  pit.dispose(); post.dispose();
  if (!geo) throw new Error("buildGunPitBody: merge failed (attribute mismatch)");
  const r = 2.6 * S + 0.3 * S;
  geo.userData.footprint = { cx: 0, cz: 0, hx: r, hz: r };
  geo.userData.height = 2.2;
  return geo;
}

/** The M60 on its cradle: pivot at the origin, barrel along +Z. */
export function buildGunPitGun() {
  const g = (x) => x * GUN;
  const parts = [];
  const P = (geo, pos, mat, tone, rot) => parts.push({ geo, pos, mat, tone, rot });
  const dark = 0.06;
  P(buildBox(g(0.07), g(0.08), g(0.14)), [0, g(-0.07), 0], MAT.metal, 0.2);                      // cradle
  P(buildBox(g(0.09), g(0.13), g(0.42)), [0, 0, g(0.05)], MAT.metal, dark);                      // receiver
  P(buildBox(g(0.1), g(0.03), g(0.2)), [0, g(0.08), g(0.1)], MAT.metal, dark + 0.05);            // feed cover
  const barrel = new THREE.CylinderGeometry(g(0.022), g(0.024), g(0.56), 8).rotateX(Math.PI / 2);
  P(barrel, [0, g(0.01), g(0.54)], MAT.metal, dark);
  const gas = new THREE.CylinderGeometry(g(0.02), g(0.02), g(0.3), 8).rotateX(Math.PI / 2);
  P(gas, [0, g(-0.04), g(0.45)], MAT.metal, dark);
  const hider = new THREE.CylinderGeometry(g(0.032), g(0.03), g(0.09), 8).rotateX(Math.PI / 2);
  P(hider, [0, g(0.01), g(0.87)], MAT.metal, dark);
  P(buildBox(g(0.02), g(0.05), g(0.14)), [0, g(0.1), g(0.4)], MAT.metal, dark);                  // carry handle
  P(buildBox(g(0.065), g(0.11), g(0.32)), [0, g(-0.02), g(-0.31)], MAT.metal, 0.03);             // stock
  P(buildBox(g(0.04), g(0.11), g(0.05)), [0, g(-0.1), g(-0.08)], MAT.metal, 0.03, [0.3, 0, 0]);  // pistol grip
  // Bipod folded under the barrel.
  for (const sx of [-1, 1]) P(buildBox(g(0.015), g(0.015), g(0.3)), [sx * g(0.025), g(-0.05), g(0.62)], MAT.metal, dark);
  // The ammunition can hung on the left, the belt running up into the feed.
  P(buildBox(g(0.1), g(0.18), g(0.28)), [g(-0.12), g(-0.07), g(0.08)], MAT.paint, 0.5);
  P(buildBox(g(0.06), g(0.02), g(0.1)), [g(-0.07), g(0.04), g(0.1)], MAT.metal, 0.7, [0, 0, 0.6]);
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.05 * GUN, radius: 1, strength: 0.25, groundFade: 0, floor: 0.6 });
  return geo;
}

// ── Enemy MG nest (DShK) ─────────────────────────────────────────────────────
/**
 * What the other side dug instead of a sandbag ring: a round pit lined with
 * courses of logs, the spoil thrown up outside as a low earth mound, cut
 * leaves laid over it. The gun is a DShK 12.7 mm — the long finned barrel,
 * the big muzzle brake and the ring AA sight are what tell it from the M60
 * from above. Same pivot/muzzle contract as the gun pit.
 */
export const NEST_HEAD_Y = 1.5 * S;
export const NEST_MUZZLE = new THREE.Vector3(0, 0.0, 1.24 * GUN);

export function buildNestBody({ seed = 61 } = {}) {
  const R = rng(seed);
  const parts = [];
  const rIn = 2.3 * S;
  // The mound: a lathe from the ground outside in to the lip of the logs.
  // Profile runs OUTSIDE-IN: run the other way, the faces point down into the
  // earth and the whole mound is culled from above (measured: normal.y -0.83).
  const prof = [[rIn + 2.6 * S, 0], [rIn + 2.3 * S, 0.12], [rIn + 1.4 * S, 0.7 * S], [rIn + 0.5 * S, 1.12 * S], [rIn, 1.0 * S], [rIn - 0.05, 0]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  parts.push({ geo: new THREE.LatheGeometry(prof, 28), mat: MAT.earth, tone: 0.5 });
  // Log revetment: courses of logs in a 10-gon just inside the mound, each
  // course turned half a side so the joints do not line up.
  const sides = 10, logR = 0.13 * S, courses = 4;
  for (let c = 0; c < courses; c++) {
    const rr = rIn - logR - 0.02;
    for (let k = 0; k < sides; k++) {
      const a0 = ((k + (c % 2) * 0.5) / sides) * Math.PI * 2, a1 = a0 + (Math.PI * 2) / sides;
      const len = 2 * rr * Math.sin(Math.PI / sides) + 0.12;
      const am = (a0 + a1) / 2;
      const log = new THREE.CylinderGeometry(logR * (0.9 + R() * 0.2), logR, len, 7).rotateZ(Math.PI / 2);
      parts.push({ geo: log, pos: [Math.cos(am) * rr, logR + c * logR * 1.85, Math.sin(am) * rr], rot: [0, -am + Math.PI / 2, 0], mat: MAT.timber, tone: 0.25 + R() * 0.3 });
    }
  }
  parts.push({ geo: new THREE.CylinderGeometry(rIn - 0.2, rIn - 0.2, 0.05, 20), pos: [0, 0.025, 0], mat: MAT.earth, tone: 0.2 });
  // Cut leaves over the mound: flat thatch mats lying on its slope.
  for (let k = 0; k < 7; k++) {
    const a = R() * Math.PI * 2, r = rIn + (0.5 + R()) * S;
    parts.push({ geo: buildBox(1.4 * S, 0.06, 0.7 * S), pos: [Math.cos(a) * r, 0.95 * S, Math.sin(a) * r], rot: [0.35 * (R() - 0.5), -a, -0.35], mat: MAT.thatch, tone: 0.3 + R() * 0.4 });
  }
  // The gun's post: a log crib stake with an iron socket.
  const postH = NEST_HEAD_Y - 0.1 * GUN;
  parts.push({ geo: buildPost({ height: postH, width: 0.24 * S, depth: 0.24 * S, taper: 0.1, round: true }), mat: MAT.timber, tone: 0.3 });
  parts.push({ geo: new THREE.CylinderGeometry(0.07 * S, 0.07 * S, 0.1 * GUN, 8), pos: [0, postH + 0.05 * GUN, 0], mat: MAT.metal, tone: 0.1 });
  // An ammo box on the floor.
  parts.push({ geo: buildBox(0.5 * S, 0.3 * S, 0.3 * S), pos: [-1.1 * S, 0.15 * S + 0.05, 0.6 * S], rot: [0, 0.4, 0], mat: MAT.paint, tone: 0.35 });
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.18 * S, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  const r = rIn + 2.6 * S;
  geo.userData.footprint = { cx: 0, cz: 0, hx: r, hz: r };
  geo.userData.height = 2.2;
  return geo;
}

/** The DShK: pivot at the origin, barrel along +Z. */
export function buildNestGun() {
  const g = (x) => x * GUN;
  const parts = [];
  const P = (geo, pos, mat, tone, rot) => parts.push({ geo, pos, mat, tone, rot });
  const dark = 0.05;
  const alongZ = (r0, r1, len, seg = 10) => new THREE.CylinderGeometry(r0, r1, len, seg).rotateX(Math.PI / 2);
  P(buildBox(g(0.08), g(0.09), g(0.16)), [0, g(-0.08), 0], MAT.metal, 0.2);                      // cradle
  P(buildBox(g(0.12), g(0.14), g(0.5)), [0, 0, g(-0.04)], MAT.metal, dark);                      // receiver
  P(alongZ(g(0.03), g(0.034), g(0.95)), [0, g(0.01), g(0.68)], MAT.metal, dark);                 // barrel
  for (let k = 0; k < 7; k++) P(alongZ(g(0.052), g(0.052), g(0.025)), [0, g(0.01), g(0.26 + k * 0.055)], MAT.metal, dark + 0.04);  // cooling fins
  P(alongZ(g(0.05), g(0.045), g(0.13)), [0, g(0.01), g(1.18)], MAT.metal, dark);                 // muzzle brake
  // The ring anti-aircraft sight on its post: the DShK's silhouette.
  P(buildBox(g(0.015), g(0.12), g(0.015)), [0, g(0.12), g(0.72)], MAT.metal, dark);
  const ring = new THREE.TorusGeometry(g(0.12), g(0.008), 4, 18);
  P(ring, [0, g(0.24), g(0.72)], MAT.metal, dark + 0.1);
  // Spade grips and the butt plate.
  P(buildBox(g(0.14), g(0.1), g(0.03)), [0, 0, g(-0.3)], MAT.metal, dark);
  for (const sx of [-1, 1]) P(buildBox(g(0.025), g(0.1), g(0.025)), [sx * g(0.06), g(-0.02), g(-0.36)], MAT.timber, 0.3);
  // The ammunition box on the right, feeding across.
  P(buildBox(g(0.12), g(0.17), g(0.32)), [g(0.14), g(-0.06), g(0.02)], MAT.paint, 0.35);
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.05 * GUN, radius: 1, strength: 0.25, groundFade: 0, floor: 0.6 });
  return geo;
}

// ── Radio post ───────────────────────────────────────────────────────────────
/** The signals shelter and mast (rtsFirebaseProps), marked: U.S. ARMY on the
 *  mast side, the star on the roof between its ribs. */
export function buildRadioPost({ seed = 41 } = {}) {
  const geo = buildRadioStation({ seed });
  const W = 2.2 * S, H = 2.2 * S, lift = 0.35 * S, hw = W / 2;
  const st = [];
  st.push(stencilPatch("star", flatSurface([0, lift + H, 0], [0, 1, 0], [-1, 0, 0], 1.35 * S, "star"), { lift: 0.006 }));
  const tw = 1.2 * S;
  st.push(stencilPatch("armyWhite", flatSurface([-hw, lift + H * 0.58, 0], [-1, 0, 0], [0, 0, 1], tw, "armyWhite"), { lift: 0.035 * S }));
  geo.userData.stencil = mergeStencils(st);
  geo.userData.height = 16;
  return geo;
}
