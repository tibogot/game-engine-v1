// The P5/P3 test track: tiles chained end to end, flights placed on the arc at a given speed.
// Shared by the lab (look) and the drive page (the real car), so both use the same track.
import * as THREE from "three";
import { TILES, deckFrame, socketMatrix, leanIn, SECTIONS, DEG } from "./kit.js";

const V = THREE.Vector3;
const Y = new V(0, 1, 0);
const G = 9.81;

// Guarded by default; "!" = OPEN: the run-ups to the kickers, the landings and the catch pad are
// open (that's where falling off is the risk you take), the fast turns, loop and wallride guarded.
const S = "straight_64";
export const TEST_TRACK = [
  [S, S, "bank_in_22", "fast_turn_128", "bank_out_22", "straight_64!", "kicker_20!"],
  ["fly", "landing_turn_20!", 20],
  ["fast_turn_128", "bank_out_22", "boost_32", S, "loop_28", S, "brake_turn_32", S, "straight_64!", "kicker_20!"],
  ["fly", "banked_landing_20!", 20],
  ["fast_turn_128", "bank_out_22", S, "wallride_90", S, "kicker_20!"],
  ["fly", "catch_pad!", 8],
  ["straight_64!", "brake_turn_32", S, "bank_in_22", "fast_turn_128", "fast_turn_128", "bank_out_22", S],
];

/**
 * @param {object} o
 * @param {Record<string, {b: object}>} o.built integrate() result per tile id
 * @param {number} [o.speed] m/s used to place the flights
 * @returns {{placements: {id: string, open: boolean, M: THREE.Matrix4}[], ride: object[], arcPts: (THREE.Vector3|null)[], length: number, warnings: string[], start: THREE.Matrix4}}
 */
/**
 * LANDINGS ARE PLACED FOR A SPEED BAND, not one speed (P3, 2026-10-18): the old car arrived at a
 * kicker 4% slower than planned, came down ~11 m short (range ∝ v²) and fell. The landing now starts
 * where the SLOWEST car of the band lands (`speedMin`, default 93% of `speed`); a faster one lands
 * further along the same landing ramp.
 */
export function layoutTestTrack({ built, speed = 60, speedMin = speed * 0.93, origin = new V(0, 120, 600), plan = TEST_TRACK }) {
  const placements = [];
  const ride = [];
  const arcPts = [];
  const warnings = [];
  let cur = { p: origin.clone(), T: new V(0, 0, -1), U: Y.clone(), R: new V(1, 0, 0), lean: 0 };
  let length = 0;
  const start = socketMatrix(cur);

  const place = (spec) => {
    const open = spec.endsWith("!");
    const id = open ? spec.slice(0, -1) : spec;
    const t = TILES[id];
    if (Math.abs(leanIn(t) - cur.lean) > 1e-6) warnings.push(`${id}: lean ${(leanIn(t) / DEG).toFixed(0)}° on a ${(cur.lean / DEG).toFixed(0)}° end`);
    const M = socketMatrix(cur);
    placements.push({ id, open, M });
    const { b } = built[id];
    const hw = SECTIONS[t.section ?? "road"].hw;
    for (const r of b.rings) {
      const f = deckFrame(r, hw);
      ride.push({ P: f.P.clone().addScaledVector(f.U, 0.7).applyMatrix4(M), T: r.T.clone().transformDirection(M), U: f.U.clone().transformDirection(M) });
    }
    const e = b.exit;
    cur = { p: e.p.clone().applyMatrix4(M), T: e.T.clone().transformDirection(M), U: e.U.clone().transformDirection(M), R: e.R.clone().transformDirection(M), lean: e.lean };
    length += b.L;
  };

  // Fly off the current end and put `spec` where the SLOWEST car of the band (speedMin) comes down
  // at `angleDeg`; the arc drawn and ridden is that one, the faster cars land further on.
  const fly = (spec, angleDeg) => {
    const speed = speedMin;
    const d = cur.T.clone();
    const h = new V(d.x, 0, d.z);
    const vh = speed * h.length();
    h.normalize();
    const t = (d.y * speed + Math.tan(angleDeg * DEG) * vh) / G;
    const p0 = cur.p.clone();
    for (let k = 1; k <= 40; k++) {
      const tt = (t * k) / 40;
      const P = p0.clone().addScaledVector(h, vh * tt);
      P.y += d.y * speed * tt - 0.5 * G * tt * tt;
      const T = h.clone().multiplyScalar(vh).add(new V(0, d.y * speed - G * tt, 0)).normalize();
      ride.push({ P: P.clone().add(new V(0, 0.7, 0)), T, U: Y.clone(), air: true });
      arcPts.push(P);
    }
    const T = h.clone().multiplyScalar(vh).add(new V(0, d.y * speed - G * t, 0)).normalize();
    const R = new V().crossVectors(T, Y).normalize();
    cur = { p: arcPts[arcPts.length - 1].clone(), T, U: new V().crossVectors(R, T), R, lean: 0 };
    arcPts.push(null);
    place(spec);
  };

  for (const step of plan) {
    if (step[0] === "fly") fly(step[1], step[2]);
    else step.forEach(place);
  }
  return { placements, ride, arcPts, length, warnings, start };
}

/** Instanced meshes for the placements: one draw per tile kind for deck, rail and posts. */
export function buildTrackMeshes(placements, built, mats) {
  const group = new THREE.Group();
  const byKey = {};
  for (const p of placements) (byKey[`${p.id}|${p.open ? "open" : "edges"}`] ??= []).push(p.M);
  const trisOf = (g) => (g ? (g.index ? g.index.count : g.getAttribute("position").count) / 3 : 0);
  let tris = 0;
  for (const [key, list] of Object.entries(byKey)) {
    const [id, kind] = key.split("|");
    const look = kind === "open" ? built[id].open : built[id].guarded;
    for (const [geo, m] of [[look.deck, mats.road], [look.rail, mats.rail]]) {
      if (!geo) continue;
      const im = new THREE.InstancedMesh(geo, m, list.length);
      list.forEach((M, i) => im.setMatrixAt(i, M));
      im.computeBoundingSphere();
      group.add(im);
      tris += trisOf(geo) * list.length;
    }
    const P = look.posts;
    if (P?.template && P.matrices.length) {
      const im = new THREE.InstancedMesh(P.template, mats.rail, P.matrices.length * list.length);
      let k = 0;
      const tmp = new THREE.Matrix4();
      for (const M of list) for (const pm of P.matrices) im.setMatrixAt(k++, tmp.multiplyMatrices(M, pm));
      im.computeBoundingSphere();
      group.add(im);
      tris += trisOf(P.template) * P.matrices.length * list.length;
    }
  }
  return { group, tris };
}
