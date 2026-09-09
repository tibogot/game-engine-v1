// ============================================================================
// CITY CLUTTER — the things standing IN the road that you can hit.
//
// ── WHY THIS EXISTS, AND WHY IT IS NOT THE GUARDRAILS ────────────────────────
//
// The pedestrian guardrails were knockable first and it was not fun. A rail
// stands flush against the kerb with the pavement immediately behind it, so it
// has nowhere to go: you scrape along it, the barrier disappears out from under
// the contact, and what you feel is a collision that stopped working. PLAYED,
// and reverted — see the note on CITY_KNOCK.enabled.
//
// Physics belongs on things with ROOM BEHIND THEM, standing where hitting one
// is a decision you made rather than a wall you brushed. That is this file.
//
// ── SCATTER READS AS A BUG; A REASON READS AS A CITY ─────────────────────────
//
// Cones sprinkled down a street look like debris the level designer forgot to
// delete. The same cones tapering off a closed lane, with a barrier at the head
// of the closure, read instantly as roadworks — and they change how the street
// DRIVES, because the carriageway narrows and you have to pick a side. So
// nothing here is placed on its own: every object belongs to a SITE, and the
// site is what the placement decides.
//
//   ROADWORKS    a diagonal taper of cones off the kerb, a run of them along
//                the closed lane, a water barrier across the head, and a pallet
//                or two inside the closure.
//   LOADING BAY  bins and pallets at a building's kerb, pushed just far enough
//                into the road to be worth avoiding.
//
// ── NOTHING HERE IS SOLID, ON PURPOSE ────────────────────────────────────────
//
// None of it goes into the obstacle table, and that is a design decision rather
// than an omission. A traffic cone that perturbs a car is wrong — no driver has
// ever been stopped by one — and it also deletes the ordering problem that made
// the rails awkward: the vehicle resolves its capsules BEFORE the knockable
// system sees the hit, so anything solid has to be de-collided a few frames
// early (the lookahead in modularRoadCityKnockables). With no capsule there is
// no race. The car drives through, the object is launched, and the weight
// difference between a cone and a water barrier is carried entirely by mass.
//
// ── COST ─────────────────────────────────────────────────────────────────────
//
// Four kinds, four InstancedMeshes, four draws, whatever the count — and each
// one joins the furniture's existing LOD partition, so only the ones near the
// camera are drawn at all. The geometry is built ONCE and shared; a cone is 44
// triangles and there is exactly one cone in memory.
// ============================================================================
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const CLUTTER_DEFAULTS = {
  /** Chance a block side carries a roadworks site. Sparse on purpose: one
   *  closure every few blocks is a living city, one per block is a council
   *  that has lost control. */
  worksChance: 0.30,
  /** Metres of diagonal taper, then metres of closed lane behind it. */
  worksTaper: 11,
  worksRun: 17,
  /** Cone spacing along the taper and the run. Tighter than a real closure —
   *  at 2.4 m the run read as a dotted line from a moving car rather than as a
   *  barrier you must not cross. */
  conePitch: 1.8,
  /** How many closures are held with concrete rather than cones — a lane shut
   *  for a month instead of an afternoon. */
  hardChance: 0.42,
  /** A jersey barrier is 2.4 m; they are laid end to end, because a gap
   *  between two of them is a gap you could drive into. */
  jerseyLen: 2.42,
  /** How far into the road the closure reaches, metres from the kerb. A little
   *  over one lane, so the closed lane is genuinely shut. */
  worksWidth: 3.4,
  /** Chance a block side carries a loading bay instead. */
  bayChance: 0.34,
  /** How far into the road bay clutter sits. Small — it is at the kerb, it is
   *  just proud enough to be worth avoiding. */
  bayInset: 1.0,
  /** Keep clear of the junctions at each end of a block, metres. */
  endClear: 14,
};

/** A box whose BOTTOM sits at `y` — the same convention as the furniture. */
function box(w, h, d, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return g;
}

/**
 * Paint a geometry, optionally per vertex.
 *
 * Vertex colours rather than per-instance ones, because these objects are
 * MULTICOLOURED — a cone is orange with a white band, a bin is a grey body with
 * a dark lid — and `instanceColor` can only tint a whole instance. It is also
 * multiplied into colorNode by NodeMaterial whether you ask or not, which is
 * the trap the traffic signals fell into.
 *
 * @param {THREE.BufferGeometry} g
 * @param {number|((y:number,x:number,z:number)=>number)} paint hex, or a
 *        function of the vertex position returning one.
 */
export function paint(g, paintSpec) {
  const p = g.getAttribute("position");
  const arr = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  const fn = typeof paintSpec === "function" ? paintSpec : null;
  if (!fn) c.set(paintSpec);
  for (let i = 0; i < p.count; i++) {
    if (fn) c.set(fn(p.getY(i), p.getX(i), p.getZ(i)));
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(arr, 3));
  return g;
}

/**
 * The four shapes, built once. Every one is modelled with its base at y = 0 and
 * facing +Z, so a placement only ever has to supply a position and a yaw.
 */
export function buildClutterKit() {
  // ── CONE ──────────────────────────────────────────────────────────────────
  // The white band is the whole reason this reads as a cone and not as an
  // orange spike, and it is free: a cylinder with height segments, coloured by
  // vertex Y. Real cones are ~75 cm; this one is 0.70 to the tip.
  const CONE_H = 0.62;
  const coneBody = new THREE.CylinderGeometry(0.035, 0.155, CONE_H, 8, 6, true);
  coneBody.translate(0, CONE_H / 2 + 0.045, 0);
  paint(coneBody, (y) => (y > 0.30 && y < 0.44 ? 0xf2f2ee : 0xff5a12));
  const coneGeo = mergeGeometries([
    coneBody,
    paint(box(0.34, 0.045, 0.34), 0xd9490c),          // base pad
  ], false);
  coneBody.dispose();

  // ── WATER-FILLED BARRIER ──────────────────────────────────────────────────
  // The heavy one. A wide foot and a narrower body, so it reads as something
  // filled rather than as a painted plank, plus a white top rail.
  const barrierGeo = mergeGeometries([
    paint(box(1.60, 0.16, 0.52), 0xd8321a),           // foot
    paint(box(1.42, 0.58, 0.34, 0, 0.16), 0xe8401f),  // body
    paint(box(1.46, 0.10, 0.30, 0, 0.74), 0xf0efe8),  // top rail
  ], false);

  // ── WHEELIE BIN ───────────────────────────────────────────────────────────
  const binGeo = mergeGeometries([
    paint(box(0.58, 0.86, 0.62, 0, 0.09), 0x2f4636),  // body
    paint(box(0.62, 0.09, 0.66, 0, 0.95), 0x1c2a20),  // lid
    paint(box(0.10, 0.16, 0.10, -0.22, 0, 0.18), 0x15171a),   // wheels
    paint(box(0.10, 0.16, 0.10, 0.22, 0, 0.18), 0x15171a),
  ], false);

  // ── PALLET ────────────────────────────────────────────────────────────────
  // Three top slats and three feet: enough that the gaps read at street level,
  // and no more than that.
  const palletParts = [];
  for (const x of [-0.44, 0, 0.44]) palletParts.push(paint(box(0.24, 0.09, 1.16, x, 0.09), 0x8a6b45));
  for (const x of [-0.44, 0, 0.44]) palletParts.push(paint(box(0.20, 0.09, 1.10, x, 0), 0x6d5537));
  palletParts.push(paint(box(1.16, 0.04, 1.16, 0, 0.18), 0x9c7b50));
  const palletGeo = mergeGeometries(palletParts, false);
  for (const g of palletParts) g.dispose();

  // ── JERSEY BARRIER ────────────────────────────────────────────────────────
  //
  // The heavy one, and the reason it is worth a separate kind from the plastic
  // barrier above: concrete does not move. A water-filled barrier shifts when
  // you hit it and a jersey shoves YOU, and the whole point of having both is
  // that a driver learns which is which by their shape from a distance.
  //
  // The profile IS the shape — a wide foot, a sharp batter, a narrow top. Three
  // stacked boxes read as that at any speed you will ever see one, and a real
  // swept profile would cost vertices for a silhouette nobody gets close to.
  const jerseyGeo = mergeGeometries([
    paint(box(2.40, 0.16, 0.62, 0, 0.08), 0x9a988f),      // foot
    paint(box(2.40, 0.26, 0.44, 0, 0.29), 0xa9a79d),      // batter
    paint(box(2.40, 0.42, 0.26, 0, 0.63), 0xb4b2a8),      // upstand
    // The reflective band every real one carries, low on the batter.
    paint(box(2.42, 0.07, 0.455, 0, 0.30), 0xf0e9d0),
  ], false);

  // ── STEEL TRENCH PLATE ────────────────────────────────────────────────────
  //
  // Flat, and deliberately NOT knockable: a plate lies over a hole in the road
  // and is driven across. One that flew when clipped would be the single most
  // obviously wrong object in the city, so it never joins the knockable groups.
  const plateGeo = mergeGeometries([
    paint(box(2.60, 0.05, 2.00, 0, 0.025), 0x53565c),     // the plate
    paint(box(2.66, 0.02, 2.06, 0, 0.006), 0xc8a12a),     // the yellow lip under it
  ], false);

  for (const [n, g] of Object.entries({ coneGeo, barrierGeo, binGeo, palletGeo, jerseyGeo, plateGeo })) {
    if (!g) throw new Error(`[CityClutter] merge returned null for ${n}`);
  }
  return { coneGeo, barrierGeo, binGeo, palletGeo, jerseyGeo, plateGeo };
}

/**
 * Place one block side's worth of clutter.
 *
 * Called from the furniture's street loop, which already knows the geometry of
 * a block edge — there is exactly one place in this codebase that turns block
 * indices into kerb lines, and duplicating it here is how the two would drift.
 *
 * @param {object} o
 * @param {{cones:Array,barriers:Array,bins:Array,pallets:Array,signs:Array}} o.into  lists to push into
 * @param {(list:Array,x:number,z:number,yaw:number,extra?:object)=>void} o.place
 * @param {(across:number,along:number)=>[number,number]} o.at  block-space → world
 * @param {number} o.kerb    the kerb line in the across axis
 * @param {number} o.dir     +1/-1: which way is INTO the block (so -dir is into the road)
 * @param {number} o.a0      block start along the street
 * @param {number} o.a1      block end
 * @param {number} o.yawAlong  yaw of "facing along the street"
 * @param {(a:number,b:number,c:number)=>number} o.rand  the city's per-lot hash
 * @param {number} o.seed
 * @param {object} o.C       CLUTTER_DEFAULTS merged with overrides
 */
export function placeStreetClutter({ into, place, at, kerb, dir, a0, a1, yawAlong, axis, travel, rand, seed, C }) {
  const runLen = a1 - a0 - C.endClear * 2;
  if (runLen < C.worksTaper + C.worksRun + 6) return;
  const roll = rand(seed, 1, 71);

  if (roll < C.worksChance) {
    /*
     * A LANE CLOSURE, and the taper is the part that matters.
     *
     * Cones running straight down a lane say nothing; cones walking diagonally
     * out from the kerb say "this lane is shut, move over" before you can read
     * anything else, which is exactly the job real ones do. The closure then
     * runs parallel for `worksRun` and is stopped by the barrier.
     */
    const s0 = a0 + C.endClear + rand(seed, 2, 72) * (runLen - C.worksTaper - C.worksRun);
    /*
     * THE WARNING SIGN COMES FIRST, which is the whole point of a warning
     * sign: it stands on the pavement a few metres BEFORE the taper begins,
     * facing the traffic that is about to meet it. A works sign anywhere else
     * is decoration; here it is the reason the closure is readable at speed.
     *
     * "BEFORE" AND "FACING" BOTH COME FROM `travel`. This used to read the
     * kerb's inward direction instead, which is only the same thing on half
     * the streets — on the other half the sign stood at the FAR end of its
     * own closure, showing its back, warning nobody about cones they had
     * already driven through.
     */
    if (into.signs) {
      const closureEnd = s0 + C.worksTaper + C.worksRun;
      const ss = travel > 0 ? s0 - 7 : closureEnd + 7;
      const [sx, sz] = at(kerb + dir * 0.8, ss);
      place(into.signs, sx, sz, yawAlong + (travel > 0 ? Math.PI : 0),
        { tile: C.worksSignTile, axis, travel });
    }
    /*
     * CONES OR CONCRETE, and the choice is what makes two closures look like
     * different jobs rather than the same one twice. A cone taper is a lane
     * shut for the afternoon; a jersey line is a lane shut for a month, and
     * the run beside it gets a trench plate because something is dug up.
     *
     * The TAPER is always cones either way — you do not build a concrete
     * taper, you feather the traffic in with cones and then hold it with the
     * barriers.
     */
    const hard = rand(seed, 5, 83) < C.hardChance;
    const taperN = Math.max(2, Math.round(C.worksTaper / C.conePitch));
    for (let i = 0; i <= taperN; i++) {
      const t = i / taperN;
      const [x, z] = at(kerb - dir * (0.45 + t * (C.worksWidth - 0.45)), s0 + t * C.worksTaper);
      place(into.cones, x, z, rand(seed, i, 73) * 6.283, {});
    }
    const head = s0 + C.worksTaper;
    if (hard) {
      // End to end down the shut lane, and end to end matters: a gap between
      // two jersey barriers is a gap you could drive into, which is the one
      // thing a line of them exists to prevent.
      for (let s = head + C.jerseyLen * 0.5; s < head + C.worksRun; s += C.jerseyLen) {
        const [x, z] = at(kerb - dir * C.worksWidth, s);
        place(into.blocks, x, z, yawAlong, {});
      }
      if (into.plates) {
        const [px, pz] = at(kerb - dir * (C.worksWidth - 1.6), head + C.worksRun * 0.45);
        place(into.plates, px, pz, yawAlong, {});
      }
    } else {
      for (let s = head + C.conePitch; s < head + C.worksRun; s += C.conePitch) {
        const [x, z] = at(kerb - dir * C.worksWidth, s);
        place(into.cones, x, z, rand(seed, Math.round(s), 74) * 6.283, {});
      }
    }
    // The barrier closes the head of the run, ACROSS the shut lane.
    {
      const [x, z] = at(kerb - dir * (C.worksWidth * 0.55), head + C.worksRun + 0.8);
      place(into.barriers, x, z, yawAlong + Math.PI / 2, {});
    }
    // Dressing inside the closure — it is a works site, not an empty box.
    for (let k = 0; k < 2; k++) {
      const [x, z] = at(kerb - dir * (1.0 + rand(seed, k, 75) * 1.6),
        head + 2 + rand(seed, k, 76) * (C.worksRun - 4));
      place(k === 0 ? into.pallets : into.bins, x, z, rand(seed, k, 77) * 6.283, {});
    }
    return;
  }

  if (roll > 1 - C.bayChance) {
    // A loading bay: two or three things at the kerb, proud enough to matter.
    const n = 2 + (rand(seed, 3, 78) < 0.5 ? 1 : 0);
    const s0 = a0 + C.endClear + rand(seed, 4, 79) * runLen;
    for (let k = 0; k < n; k++) {
      const [x, z] = at(kerb - dir * (C.bayInset + rand(seed, k, 80) * 0.5), s0 + k * 1.5);
      const list = rand(seed, k, 81) < 0.55 ? into.bins : into.pallets;
      place(list, x, z, yawAlong + (rand(seed, k, 82) - 0.5) * 0.6, {});
    }
  }
}
