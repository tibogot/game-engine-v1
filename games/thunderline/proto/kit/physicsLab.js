// THE PHYSICS LAB's TEST GROUND (games/thunderline/PHYSICS_LAB.md; user, 2026-10-29: "a lab with some of the pieces on
// the ground that I can try … jumps, poles … fine-tune drifting, air control … you place some, I can place them
// manually"). A track (the builder's format) laid on the floor: zones side by side, every road heading −Z from z = 0,
// the open ground between them drivable. Each zone a chain of pieces (`parent`: the builder lays each one on the end
// of the one before); obstacles stand on the floor (props without `on`). Yours to change in the lab; Reset rebuilds it.
import * as THREE from "three";

export const LAB_Y = 0.05; // the roads' surface: just over the floor (their slab goes into it, unseen)

/** the zones (x: where they stand across the ground) — `key` jumps there while driving */
export const LAB_ZONES = [
  { key: "1", label: "Start · acceleration / braking strip", x: 0, chain: ["start_line", "straight_64", "straight_64", "straight_64", "straight_64", "straight_64", "straight_64"] },
  { key: "2", label: "Ramps 10° · 15° · 20° · 30° · 45°", x: 40, ramps: [10, 15, 20, 30, 45], lane: 34 }, // (34: 10 m of floor between 24 m roads — at 26 the gap was a car wide)
  { key: "3", label: "Loop", x: 220, chain: ["straight_64", "straight_64", "loop_28", "straight_64", "straight_64"] },
  { key: "4", label: "Rollers, slopes, crests", x: 300, chain: ["straight_64", "rollers_64", "rollers_64", "straight_64", "slope_up_12", "slope_down_12", "straight_64"] },
  { key: "5", label: "Drift circle (open ground, cones R 30 m)", x: 360, circle: 30, z: -90 },
  { key: "6", label: "Slalom (poles every 18 m) · obstacles to hit (right of it)", x: 430, slalom: 8, hits: 466 },
  // (the LEFT wall ride: the right one turned back across the acceleration strip; it ends heading −X at z ≈ −211, x
  // −90 → −300 — keep that ground clear)
  { key: "7", label: "Wall ride", x: -90, chain: ["straight_64", "straight_64", "wallride_90_L", "straight_64", "straight_64"] },
  // (user, 2026-10-29: "not only roads … obstacles to debug drift angles … small obstacles on the ground to check
  // the wheels react well")
  { key: "8", label: "Circuit (four 90° turns, closed — lap it)", x: 520, chain: ["straight_64", "turn_48_90", "straight_64", "turn_48_90", "straight_64", "turn_48_90", "straight_64", "turn_48_90"] },
  { key: "9", label: "Speed bumps · washboard · hairpin · narrow planks", x: 760, chain: ["straight_64", "bumps_32", "straight_64", "washboard_32", "straight_64", "hairpin_24", "straight_64", "plank_64", "plank_32"] },
  { key: "0", label: "Drift arena (48 m wide, cone figure-eight)", x: 880, chain: ["platform_128", "platform_128"], eight: [{ z: -70, r: 13 }, { z: -130, r: 13 }] },
  // ON THE GROUND (user, 2026-10-29: "ramps I place on the ground, like my old game … collision … things to debug
  // suspension"): obstacles.js GROUND, on the floor. Shift + the key.
  { key: "S1", label: "Ground ramps: jump · convex kicker · 20° slope (run-up 100 m)", x: 1000, items: [
    { kind: "ob_ramp_jump", x: 0, z: -60 }, { kind: "ob_ramp_kicker", x: 30, z: -60 }, { kind: "ob_ramp_slope", x: 60, z: -60 },
    // a jump onto a table: the block 30 m past the jump ramp's lip
    { kind: "ob_ramp_jump", x: 90, z: -60 }, { kind: "ob_block", x: 90, z: -122 },
  ] },
  { key: "S2", label: "Suspension: kerbs one side · side ramp · step · kerbs left / right", x: 1150, items: [
    { kind: "ob_kerb", x: -0.9, z: -20 }, { kind: "ob_kerb", x: -0.9, z: -32 }, { kind: "ob_kerb", x: -0.9, z: -44 },
    { kind: "ob_ramp_side", x: 29.1, z: -30 },
    { kind: "ob_step", x: 60, z: -30 },
    { kind: "ob_kerb", x: 89.1, z: -20 }, { kind: "ob_kerb", x: 90.9, z: -40 }, { kind: "ob_kerb", x: 89.1, z: -60 }, { kind: "ob_kerb", x: 90.9, z: -80 },
  ] },
  { key: "S3", label: "Movers: pendulum · sliding wall · low spinning bar · sweeper", x: 1300, items: [
    { kind: "ob_pendulum", x: 0, z: -50 }, { kind: "ob_slider", x: 30, z: -50 }, { kind: "ob_lowbar", x: 60, z: -50 }, { kind: "ob_sweeper", x: 90, z: -50 },
  ] },
];

/** The test ground as a track: { pieces, nextUid, props, world } */
export function makeLabTrack() {
  const pieces = [], props = [];
  let uid = 1;
  const M = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z).toArray();
  const chain = (ids, x, z = 0) => {
    let parent = null;
    for (const id of ids) {
      const pc = { uid: uid++, id, open: false, M: M(x, LAB_Y, z), parent, flightFrom: null };
      pieces.push(pc);
      parent = pc.uid;
    }
  };
  for (const zone of LAB_ZONES) {
    if (zone.chain) chain(zone.chain, zone.x);
    // a lane per ramp, after a 128 m run-up; the landing is the open ground (place landings on their arcs to try them)
    if (zone.ramps) zone.ramps.forEach((a, k) => chain(["straight_64", "straight_64", `adj_kicker_${a}_${Math.max(16, Math.round((28 * a) / 20 / 4) * 4)}_r`], zone.x + k * zone.lane));
    if (zone.circle) {
      const n = 16;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        props.push({ uid: uid++, kind: "ob_cone", M: M(zone.x + Math.cos(a) * zone.circle, 0, zone.z + Math.sin(a) * zone.circle) });
      }
    }
    if (zone.items) for (const it of zone.items) props.push({ uid: uid++, kind: it.kind, M: M(zone.x + it.x, 0, it.z) });
    if (zone.slalom) for (let k = 0; k < zone.slalom; k++) props.push({ uid: uid++, kind: "ob_pole", M: M(zone.x + (k % 2 ? 3 : -3), 0, -40 - k * 18) });
    // things to drive into: how the car takes a knock (tyre stacks, barrels, cones, a concrete block), two of each
    if (zone.hits) ["ob_tyres", "ob_barrel", "ob_cones", "ob_block", "ob_tyres", "ob_barrel", "ob_cones", "ob_block"].forEach((kind, k) => props.push({ uid: uid++, kind, M: M(zone.hits + (k % 2 ? 6 : -6), 0, -40 - k * 22) }));
    // a figure-eight of cones ON the arena's deck (two rings, the car crosses between them)
    if (zone.eight) for (const c of zone.eight) for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      props.push({ uid: uid++, kind: "ob_cone", M: M(zone.x + Math.cos(a) * c.r, LAB_Y, c.z + Math.sin(a) * c.r) });
    }
  }
  return { pieces, nextUid: uid, props, world: "flat_grid" };
}

/** where to put the car for zone `key` (a spawn on the ground, before the zone, heading −Z) */
export function zoneSpawn(key) {
  const z = LAB_ZONES.find((q) => q.key === key);
  if (!z) return null;
  const x = z.ramps ? z.x + 2 * z.lane : z.x;
  return { x, y: 1.2, z: z.circle ? z.z + z.circle + 25 : 40 };
}
