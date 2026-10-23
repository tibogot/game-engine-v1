// The P5/P3 test track: tiles chained end to end, flights placed on the arc at a given speed.
// Shared by the lab (look) and the drive page (the real car), so both use the same track.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { TILES, deckFrame, socketMatrix, leanIn, SECTIONS, DEG } from "./kit.js";
import { closureAt, wallAt } from "./tubeLook.js";
import { buildOldLook, edgesOf, lookKey } from "./oldLook.js";

const V = THREE.Vector3;
const Y = new V(0, 1, 0);
const G = 9.81;

// Guarded by default; "!" = OPEN: the run-ups to the kickers, the landings and the catch pad are
// open (that's where falling off is the risk you take), the fast turns, loop and wallride guarded.
const S = "straight_64";
// "@x" = the piece's HAND comes from variable x (R or L): a bank-in, its turn and its bank-out share
// one variable so they lean the same way. "!" = placed open. layoutCheck.mjs searches the hands for
// a layout with no road overlap and clear flight corridors; TEST_HANDS is the one it found.
export const TEST_TRACK = [
  [S, S, "bank_in_22@a", "fast_turn_128@a", "bank_out_22@a", "straight_64!", "kicker_20!"],
  ["fly", "landing_turn_20@b!", 20],
  ["fast_turn_128@b", "bank_out_22@b", "boost_32", S, "loop_28@c", S, "brake_turn_32@d", S, "straight_64!", "kicker_20!"],
  ["fly", "banked_landing_20@e!", 20],
  // the extra straight moves jump 3: its wide catch pad overhung the end of flight 1
  ["fast_turn_128@e", "bank_out_22@e", S, "wallride_90@f", S, S, "kicker_20!"],
  ["fly", "catch_pad!", 8],
  // slope_down_12: the last section used to pass ~5 m over the first kicker's lip, and the car leaving
  // the lip hit its underside (a one-tick vy 18 → −7 m/s, P3 2026-10-18). The builder must check
  // FLIGHT CORRIDORS for clearance, not only road against road.
  ["slope_down_12", "straight_64!", "brake_turn_32@g", S, "bank_in_22@h", "fast_turn_128@h", "fast_turn_128@h", "bank_out_22@h", S],
];
// alternating right/left: one of the 128 clean layouts of 256 (layoutCheck --search), chosen so the
// car meets left- and right-hand versions of every turning piece
export const TEST_HANDS = { a: "R", b: "L", c: "R", d: "L", e: "R", f: "L", g: "R", h: "L" };

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
export function layoutTestTrack({ built, speed = 60, speedMin = speed * 0.93, jumpSpeeds = null, airDrag = 0.45 / 1400, origin = new V(0, 120, 600), plan = TEST_TRACK, hands = TEST_HANDS }) {
  // EACH FLIGHT HAS ITS OWN take-off speed (P3, 2026-10-18): a kicker after a brake turn and a short
  // run-up was reached at 174 km/h when the global "0.91 × top" said 206, and the car fell short.
  // `jumpSpeeds[i]` = measured take-off speed of flight i (m/s); the band floor is 93% of it.
  let flightIndex = 0;
  const placements = [];
  const ride = [];
  const arcPts = [];
  const warnings = [];
  let cur = { p: origin.clone(), T: new V(0, 0, -1), U: Y.clone(), R: new V(1, 0, 0), lean: 0 };
  let length = 0;
  const start = socketMatrix(cur);

  const place = (spec) => {
    const open = spec.endsWith("!");
    const [base, handVar] = (open ? spec.slice(0, -1) : spec).split("@");
    const id = handVar && hands[handVar] === "L" ? `${base}_L` : base;
    const t = TILES[id];
    if (Math.abs(leanIn(t) - cur.lean) > 1e-6) warnings.push(`${id}: lean ${(leanIn(t) / DEG).toFixed(0)}° on a ${(cur.lean / DEG).toFixed(0)}° end`);
    const M = socketMatrix(cur);
    placements.push({ id, open, M });
    const { b } = built[id];
    const hw = SECTIONS[t.section ?? "road"].hw;
    for (const r of b.rings) {
      const f = deckFrame(r, hw);
      ride.push({ P: f.P.clone().addScaledVector(f.U, 0.7).applyMatrix4(M), T: r.T.clone().transformDirection(M), U: f.U.clone().transformDirection(M), piece: placements.length - 1, id });
    }
    const e = b.exit;
    cur = { p: e.p.clone().applyMatrix4(M), T: e.T.clone().transformDirection(M), U: e.U.clone().transformDirection(M), R: e.R.clone().transformDirection(M), lean: e.lean };
    length += b.L;
  };

  // Fly off the current end and put `spec` where the SLOWEST car of the band (speedMin) comes down
  // at `angleDeg`; the arc drawn and ridden is that one, the faster cars land further on.
  const fly = (spec, angleDeg) => {
    const own = jumpSpeeds?.[flightIndex++];
    // 97% of the MEASURED take-off: at 200 km/h a 7% band is ~15% of range (~28 m on a 180 m jump),
    // more than a 52 m landing can catch — see PIECES.md "fitted landings"
    const speed = own ? own * 0.97 : speedMin;
    // THE CAR'S AIR MODEL, not a parabola: gravity + its aero drag (AERO.drag·v² / mass; downforce is
    // off in the air). Drag costs ~1 m/s² at 55 m/s: a gravity-only arc overshot by ~5% (~9 m).
    const vel = cur.T.clone().multiplyScalar(speed);
    const P = cur.p.clone();
    const dt = 1 / 120;
    const target = Math.tan(angleDeg * DEG);
    let steps = 0;
    for (let i = 0; i < 120 * 20; i++) {
      const sp = vel.length();
      vel.addScaledVector(vel, -airDrag * sp * dt);
      vel.y -= G * dt;
      P.addScaledVector(vel, dt);
      if (++steps % 6 === 0) {
        ride.push({ P: P.clone().add(new V(0, 0.7, 0)), T: vel.clone().normalize(), U: Y.clone(), air: true });
        arcPts.push(P.clone());
      }
      const vh = Math.hypot(vel.x, vel.z);
      if (vel.y < 0 && -vel.y / vh >= target) break; // falling at the landing's angle
    }
    arcPts.push(P.clone());
    const T = vel.clone().normalize();
    const R = new V().crossVectors(T, Y).normalize();
    cur = { p: P.clone(), T, U: new V().crossVectors(R, T), R, lean: 0 };
    arcPts.push(null);
    place(spec);
  };

  for (const step of plan) {
    if (step[0] === "fly") fly(step[1], step[2]);
    else step.forEach(place);
  }
  // FLIGHT CORRIDOR CLEARANCE: no road may pass within 6 m above (or 9 m beside) a flight path —
  // a car leaving a lip under an overpass hits its underside (found in P3).
  const roads = ride.filter((r) => !r.air);
  let hits = 0;
  const culprits = new Set();
  for (const a of ride) {
    if (!a.air) continue;
    for (const r of roads) {
      const dy = r.P.y - a.P.y;
      if (dy > 0.5 && dy < 6 && Math.hypot(r.P.x - a.P.x, r.P.z - a.P.z) < 9) { hits++; culprits.add(`#${r.piece} ${r.id}`); break; }
    }
  }
  if (hits) warnings.push(`flight corridor blocked: ${hits} flight points have road < 6 m above them (${[...culprits].join(", ")})`);
  // ROAD OVERLAP: two pieces that are not neighbours may not come within a road width sideways and
  // 6 m vertically (the user saw the test track run through itself). Grid-hashed: O(n).
  const cellOf = (P) => `${Math.floor(P.x / 16)},${Math.floor(P.z / 16)}`;
  const grid = new Map();
  for (const r of roads) { const k = cellOf(r.P); (grid.get(k) ?? grid.set(k, []).get(k)).push(r); }
  const pairs = new Set();
  for (const r of roads) {
    const cx = Math.floor(r.P.x / 16), cz = Math.floor(r.P.z / 16);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const o of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
        if (Math.abs(o.piece - r.piece) <= 1) continue;
        if (Math.abs(o.P.y - r.P.y) < 6 && Math.hypot(o.P.x - r.P.x, o.P.z - r.P.z) < 16) {
          const a = Math.min(o.piece, r.piece), b = Math.max(o.piece, r.piece);
          pairs.add(`#${a} ${placements[a].id} × #${b} ${placements[b].id}`);
        }
      }
    }
  }
  if (pairs.size) warnings.push(`road overlap: ${[...pairs].join("; ")}`);
  return { placements, ride, arcPts, length, warnings, start };
}

/**
 * A BUILT track (from the builder): placements with their own world matrices, no flights computed.
 * Returns the same shape as layoutTestTrack so the drive page can run either.
 * @param {{id: string, open: boolean, M: number[]}[]} pieces
 */
export function layoutFromPlacements({ built, pieces }) {
  // (a piece laid BESIDE the road — `sideOf` — is deck and rails, not part of the line the car rides)
  const placements = pieces.map((p) => ({ id: p.id, open: !!p.open, rail: p.rail, side: p.sideOf != null, M: new THREE.Matrix4().fromArray(p.M) }));
  const ride = [];
  let length = 0;
  placements.forEach((pl, k) => {
    if (pl.side) return;
    const t = TILES[pl.id];
    const hw = SECTIONS[t.section ?? "road"].hw;
    for (const r of built[pl.id].b.rings) {
      const f = deckFrame(r, hw);
      // the line 0.7 m above the deck — on a twist, its roll axis (r.pivot)
      ride.push({ P: f.P.clone().addScaledVector(f.U, r.pivot ?? 0.7).applyMatrix4(pl.M), T: r.T.clone().transformDirection(pl.M), U: f.U.clone().transformDirection(pl.M), piece: k, id: pl.id, tube: TILES[pl.id]?.tube ? closureAt(TILES[pl.id], r.s, built[pl.id].b.L) : TILES[pl.id]?.halfpipe ? 0.5 * wallAt(TILES[pl.id], r.s, built[pl.id].b.L) : 0, air: !!r.air });
    }
    length += built[pl.id].b.L;
  });
  return { placements, ride, arcPts: [], length, warnings: [], start: placements[0]?.M.clone() ?? new THREE.Matrix4() };
}

/** Instanced meshes for the placements: one draw per tile kind for deck, rail and posts. */
export function buildTrackMeshes(placements, built, mats) {
  const group = new THREE.Group();
  const byKey = {};
  // the look per placement's edges: both rails, none, or one side (oldLook.js edgesOf / lookKey), built
  // on first use for the one-sided ones
  for (const p of placements) {
    const e = edgesOf(p), k = lookKey(e);
    if (built[p.id] && !built[p.id][k]) built[p.id][k] = buildOldLook(TILES[p.id], e);
    (byKey[`${p.id}|${k}`] ??= []).push(p.M);
  }
  const trisOf = (g) => (g ? (g.index ? g.index.count : g.getAttribute("position").count) / 3 : 0);
  let tris = 0;
  const posts = [], chunkParts = [], c = new THREE.Vector3();
  for (const look of Object.values(built)) for (const l of [look?.guarded, look?.open, look?.railL, look?.railR]) if (l?.deck && !l.deckBox) { l.deck.computeBoundingBox(); l.deckBox = l.deck.boundingBox.clone(); }
  for (const [key, list] of Object.entries(byKey)) {
    const [id, kind] = key.split("|");
    const look = built[id][kind];
    // every placed piece's parts go to its CHUNK (merged below): deck / stripes always, the rail with a
    // far version (its collision walls) for distance detail
    for (const M of list) {
      const at = c.setFromMatrixPosition(M).clone();
      if (look.deckBox) at.copy(look.deckBox.getCenter(new THREE.Vector3()).applyMatrix4(M)); // the piece's middle, not its entry
      const parts = [[look.deck, TILES[id]?.tube || TILES[id]?.halfpipe ? mats.tube : mats.road, "near"], [look.under, mats.stripe, "near"], [look.rail, look.trim ? mats.trim : mats.rail, look.trim ? "near" : "rail"]];
      for (const [geo, m, band] of parts) {
        if (!geo) continue;
        chunkParts.push({ geo, m, band, M, at, far: band === "rail" ? look.railCollision : null });
        tris += trisOf(geo);
      }
    }
    // the posts are gathered for all pieces, then laid out in chunks (below)
    const P = look.posts;
    if (P?.template && P.matrices.length) for (const M of list) for (const pm of P.matrices) posts.push({ template: P.template, W: new THREE.Matrix4().multiplyMatrices(M, pm) });
  }
  // END CAPS (oldLook.js): a lid on every end no other piece covers — another end in the same plane, facing
  // it, tilted the same, at least as wide across it (off-centre too: a road leaving a platform from its side
  // half) and with the same rails (a flat plate does not close a kerb; a tube or an old-kit piece closes any).
  // The lids at a gap jump's inner ends are always there. Into the chunks with the decks: same material.
  const ends = [];
  for (const [key, list] of Object.entries(byKey)) {
    const [id, kind] = key.split("|");
    const look = built[id][kind];
    for (const M of list) {
      if (look.capsFixed) { chunkParts.push({ geo: look.capsFixed, m: mats.road, band: "near", M, at: c.setFromMatrixPosition(M).clone(), far: null }); tris += trisOf(look.capsFixed); }
      for (const e of look.ends ?? []) ends.push({ M, e, pos: e.pos.clone().applyMatrix4(M), out: e.out.clone().transformDirection(M), up: e.up.clone().transformDirection(M), right: e.right.clone().transformDirection(M) });
    }
  }
  const d = new THREE.Vector3();
  const covers = (a, b) => {
    if (a.out.dot(b.out) > -0.995 || a.up.dot(b.up) < 0.995) return false;
    d.subVectors(b.pos, a.pos);
    if (Math.abs(d.dot(a.out)) > 0.08 || Math.abs(d.dot(a.up)) > 0.08) return false;
    if (Math.abs(d.dot(a.right)) + a.e.hw > b.e.hw + 0.02) return false;
    return b.e.sig === "*" || b.e.sig === a.e.sig || a.e.sig === "";
  };
  let lids = 0;
  for (const a of ends) {
    if (!a.e.geo || ends.some((b) => b !== a && covers(a, b))) continue;
    lids++;
    chunkParts.push({ geo: a.e.geo, m: mats.road, band: "near", M: a.M, at: a.pos, far: null });
    tris += trisOf(a.e.geo);
  }
  globalThis.__trackLids = { ends: ends.length, lids }; // (tests read it)
  // POSTS IN CHUNKS WITH DISTANCE DETAIL (user, 2026-10-20: "as optimized as possible"). Per CHUNK cell of
  // the ground, one LOD: the real post (54 tris) up close, a box (12) from POST_BOX m, nothing from POST_NONE
  // m. A whole track's posts used to be one instanced mesh: never culled, drawn complete into the live
  // shadow map every frame too. The level is picked from the GAME camera (updateLod) — the shadow passes
  // look from the sun, far away, and would pick "no posts"; a bake asks for full detail (fullDetail).
  // THE TRACK IN CHUNKS (user, 2026-10-20: performance). One mesh per material per CHUNK cell, 256 m (a piece goes
  // to the cell its middle is in): a few draws per chunk, chunks out of view (or out of the live shadow map)
  // skipped. Per piece TYPE, instancing drew whole tracks that could never be culled. RAILS with distance
  // detail: the W-beam near, its collision walls from RAIL_FAR m, none from RAIL_NONE m. Parts that won't
  // merge (other attribute sets: the old kit's pieces) stay one mesh each, still in their chunk.
  const RAIL_FAR = 200, RAIL_NONE = 700, CHUNK = globalThis.__CHUNK ?? 256;
  const lods = [];
  const chunkCells = new Map();
  for (const q of chunkParts) {
    const key = `${Math.floor(q.at.x / CHUNK)},${Math.floor(q.at.z / CHUNK)}`;
    (chunkCells.get(key) ?? chunkCells.set(key, []).get(key)).push(q);
  }
  const mergeIn = (list, pick) => {
    const geos = list.map((q) => pick(q)?.clone().applyMatrix4(q.M)).filter(Boolean);
    if (!geos.length) return null;
    let g = null;
    try { g = geos.length === 1 ? geos[0] : mergeGeometries(geos, false); } catch { g = null; }
    if (!g) return geos; // not mergeable: separate meshes
    g.computeBoundingSphere();
    return [g];
  };
  for (const list of chunkCells.values()) {
    const byMat = new Map();
    for (const q of list) { const k = `${q.m.uuid}|${q.band}`; (byMat.get(k) ?? byMat.set(k, []).get(k)).push(q); }
    for (const qs of byMat.values()) {
      const { m, band } = qs[0];
      const near = mergeIn(qs, (q) => q.geo);
      if (!near) continue;
      if (band !== "rail") { for (const g of near) group.add(new THREE.Mesh(g, m)); continue; }
      const far = mergeIn(qs, (q) => q.far);
      const lod = new THREE.LOD();
      lod.autoUpdate = false;
      const level = (gs) => { const o = new THREE.Group(); for (const g of gs ?? []) o.add(new THREE.Mesh(g, m)); return o; };
      // the LOD's distance is measured from its position: the chunk's middle; its children stay in world space
      const mid = new THREE.Vector3();
      for (const q of qs) mid.add(q.at);
      mid.divideScalar(qs.length);
      lod.position.copy(mid);
      const back = new THREE.Matrix4().makeTranslation(-mid.x, -mid.y, -mid.z);
      const l0 = level(near), l1 = level(far ?? near);
      for (const o of [l0, l1]) o.applyMatrix4(back);
      lod.addLevel(l0, 0);
      lod.addLevel(l1, RAIL_FAR);
      lod.addLevel(new THREE.Object3D(), RAIL_NONE);
      lod.levels.forEach((v, i) => (v.object.visible = i === 0));
      group.add(lod);
      lods.push(lod);
    }
  }
  const POST_BOX = 150, POST_NONE = 420;
  const cells = new Map();
  for (const q of posts) {
    c.setFromMatrixPosition(q.W);
    const key = `${Math.floor(c.x / CHUNK)},${Math.floor(c.z / CHUNK)},${q.template.uuid}`;
    (cells.get(key) ?? cells.set(key, []).get(key)).push(q);
  }
  const boxOf = new Map();
  const box = (tpl) => {
    if (!boxOf.has(tpl.uuid)) {
      tpl.computeBoundingBox();
      const b = tpl.boundingBox, size = b.getSize(new THREE.Vector3()), mid = b.getCenter(new THREE.Vector3());
      boxOf.set(tpl.uuid, new THREE.BoxGeometry(size.x, size.y, size.z).translate(mid.x, mid.y, mid.z));
    }
    return boxOf.get(tpl.uuid);
  };
  for (const list of cells.values()) {
    const mid = new THREE.Vector3();
    for (const q of list) mid.add(c.setFromMatrixPosition(q.W));
    mid.divideScalar(list.length);
    const lod = new THREE.LOD();
    lod.position.copy(mid);
    lod.autoUpdate = false; // updateLod: the game camera picks the level, every pass uses it
    const toLocal = new THREE.Matrix4().makeTranslation(-mid.x, -mid.y, -mid.z), tmp = new THREE.Matrix4();
    const inst = (geo) => {
      const im = new THREE.InstancedMesh(geo, mats.rail, list.length);
      list.forEach((q, i) => im.setMatrixAt(i, tmp.multiplyMatrices(toLocal, q.W)));
      im.computeBoundingSphere();
      return im;
    };
    lod.addLevel(inst(list[0].template), 0);
    lod.addLevel(inst(box(list[0].template)), POST_BOX);
    lod.addLevel(new THREE.Object3D(), POST_NONE);
    lod.levels.forEach((v, i) => (v.object.visible = i === 0)); // full detail until a camera picks (lab.js never does)
    group.add(lod);
    lods.push(lod);
    tris += trisOf(list[0].template) * list.length;
  }
  let forced = false;
  return {
    group, tris, chunks: chunkCells.size, lodCount: lods.length,
    /** the game camera picks each chunk's detail (every pass this frame then uses it) */
    updateLod(camera) { if (!forced) for (const l of lods) l.update(camera); },
    /** full detail on every chunk (the shadow bake), or back to the camera's pick */
    fullDetail(on) { forced = on; if (on) for (const l of lods) { l.levels.forEach((v, i) => (v.object.visible = i === 0)); } },
  };
}
