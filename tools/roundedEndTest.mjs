// Rounded end — short terminus with a semicircle nose and a U-shaped rail.
//
// Flat entry mates with any straight. The free end is a semicircle of radius
// half the road width. Kerbs are a border band; the guardrail is ONE open
// polyline on the kerb centreline (left → nose → right), not ±offset from a
// centreline.
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const {
  PIECE_BY_ID, pieceParams, roadParams, buildPiece, initialConnector,
} = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);

const def = PIECE_BY_ID.get("rounded_end");
const pp = { ...pieceParams, roundEndLength: 8 };
const hw = roadParams.width / 2;

console.log("=== CATALOG ===");
{
  check("rounded_end is in the kit", !!def);
  check("has custom plate geometry", typeof def?.geometry === "function");
  check("has railPath (U along the kerb)", typeof def?.railPath === "function");
  check("has level sockets", typeof def?.sockets === "function");
}

console.log("\n=== SILHOUETTE ===");
{
  const geo = def.geometry(pp, roadParams, true);
  const box = new THREE.Box3().setFromBufferAttribute(geo.attributes.position);
  const len = box.max.z - box.min.z; // piece goes −Z; length is |min.z|
  const tipZ = - (pp.roundEndLength + hw);
  check("sits on y=0 deck", Math.abs(box.max.y - roadParams.railHeight) < 1e-3
    || box.max.y >= roadParams.railHeight - 1e-3);
  check("entry at z≈0", Math.abs(box.max.z) < 0.05, `max.z ${box.max.z.toFixed(3)}`);
  check("nose reaches L+hw", Math.abs(box.min.z - tipZ) < 0.15,
    `min.z ${box.min.z.toFixed(2)} tip ${tipZ.toFixed(2)}`);
  check("full road width", Math.abs((box.max.x - box.min.x) - roadParams.width) < 0.05,
    `width ${(box.max.x - box.min.x).toFixed(2)}`);
  geo.dispose();
}

console.log("\n=== RAIL U ===");
{
  const frames = def.railPath(pp, roadParams);
  check("enough frames for the U", frames.length >= 12, `${frames.length} frames`);
  const first = frames[0].pos, last = frames[frames.length - 1].pos;
  check("starts on entry-left kerb", first.x < -1 && Math.abs(first.z) < 0.05,
    `(${first.x.toFixed(2)}, ${first.z.toFixed(2)})`);
  check("ends on entry-right kerb", last.x > 1 && Math.abs(last.z) < 0.05,
    `(${last.x.toFixed(2)}, ${last.z.toFixed(2)})`);
  let tip = frames[0];
  for (const f of frames) if (f.pos.z < tip.pos.z) tip = f;
  check("path visits the nose tip", tip.pos.z < -(pp.roundEndLength + hw * 0.7),
    `tip z ${tip.pos.z.toFixed(2)}`);
  check("up is +Y (not upside down)", frames.every((f) => f.up.y > 0.9),
    `min up.y ${Math.min(...frames.map((f) => f.up.y)).toFixed(3)}`);
}

console.log("\n=== ASPHALT MATCHES A STRAIGHT AT THE ENTRY ===");
{
  const straight = buildPiece("straight", initialConnector(), { ...pieceParams, straightLength: 22 });
  const rounded = buildPiece("rounded_end", initialConnector(), pp);
  const sUv = straight.geometry.attributes.uv;
  const sZn = straight.geometry.attributes.aZone;
  const sPos = straight.geometry.attributes.position;
  let sLo = 1e9, sHi = -1e9;
  for (let i = 0; i < sPos.count; i++) {
    if (sZn.getX(i) !== 1) continue;
    if (sPos.getZ(i) > -0.05) { // entry of a fresh straight
      sLo = Math.min(sLo, sUv.getY(i));
      sHi = Math.max(sHi, sUv.getY(i));
    }
  }
  const rUv = rounded.geometry.attributes.uv;
  const rZn = rounded.geometry.attributes.aZone;
  const rPos = rounded.geometry.attributes.position;
  let rLo = 1e9, rHi = -1e9;
  for (let i = 0; i < rPos.count; i++) {
    if (rZn.getX(i) !== 1) continue;
    if (rPos.getZ(i) > -0.05) {
      rLo = Math.min(rLo, rUv.getY(i));
      rHi = Math.max(rHi, rUv.getY(i));
    }
  }
  check("deck uv.y range at entry matches a straight",
    Math.abs(sLo - rLo) < 0.05 && Math.abs(sHi - rHi) < 0.05,
    `straight ${sLo.toFixed(2)}..${sHi.toFixed(2)} vs rounded ${rLo.toFixed(2)}..${rHi.toFixed(2)}`);
  straight.geometry.dispose();
  rounded.geometry.dispose();
  rounded.railGeometry?.dispose();
  rounded.railCollision?.dispose();
  rounded.railMirrorGeometry?.dispose();
}
{
  const built = buildPiece("rounded_end", initialConnector(), pp);
  check("deck mesh exists", !!built.geometry);
  check("rail mesh exists with edges on", !!built.railGeometry);
  check("rail collision proxy exists", !!built.railCollision);
  const noEdge = buildPiece("rounded_end", initialConnector(), pp, roadParams, undefined, false);
  check("no rail when edges off", !noEdge.railGeometry);
  built.geometry?.dispose();
  built.railGeometry?.dispose();
  built.railCollision?.dispose();
  built.railMirrorGeometry?.dispose();
  noEdge.geometry?.dispose();
}

console.log("\n=== RAIL IS ON THE RIGHT SIDE OF THE KERB ===");
/**
 * The beam is the INNERMOST surface of a guardrail; the blockout and posts reach
 * ~0.37 m back behind it, away from the road. sweepRail puts the section at
 * `baseLat + zSign · p.z` with the traffic face at NEGATIVE p.z, so zSign is what
 * decides the side — and buildRailAlongPath walks with the deck on +right, which
 * is the LEFT-hand case (zSign −1). Shipped as +1 it mirrored the whole section:
 * beam outboard, posts standing in the road.
 *
 * Pinned against a plain straight rather than against numbers, so retuning
 * railParams moves both sides of the comparison together.
 */
{
  const rw = Math.min(Math.max(0, roadParams.railWidth), hw * 0.45);
  const edgeAbs = hw - rw * 0.5; // kerb centreline, where both rails stand
  /**
   * Every vertex of the rail the player actually sees.
   *
   * THE POSTS ARE NO LONGER IN `railGeometry` — they are instanced, so buildPiece
   * hands back a beam plus a template and a list of transforms (see `railPosts`).
   * That matters here and not just cosmetically: this whole section detects a
   * MIRRORED rail by its asymmetry, and the beam on its own is symmetric about
   * the kerb line (±0.130). Reading `railGeometry` alone would leave every check
   * below comparing ±0.130 against ±0.130 — passing, and proving nothing.
   *
   * So the posts are put back for the measurement. What is under test is where
   * the rail sits, and the rail is both halves.
   */
  const railVerts = (built) => {
    const out = [];
    const push = (geo, mat) => {
      const p = geo.getAttribute("position");
      const v = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        v.set(p.getX(i), p.getY(i), p.getZ(i));
        if (mat) v.applyMatrix4(mat);
        out.push(v.clone());
      }
    };
    if (built.railGeometry) push(built.railGeometry, null);
    const rp2 = built.railPosts;
    if (rp2?.template) for (const m of rp2.matrices) push(rp2.template, m);
    return out;
  };
  /** Lateral spread of rail verts about their own kerb line, + = toward the deck. */
  const spread = (verts, pick, atY = null) => {
    let lo = 1e9, hi = -1e9;
    for (const v of verts) {
      if (atY !== null && Math.abs(v.y - atY) > 1e-3) continue;
      const d = pick(v.x, v.z);
      if (d === null) continue;
      lo = Math.min(lo, d); hi = Math.max(hi, d);
    }
    return { lo, hi };
  };
  /** Adapter for the collision proxies, which are still plain geometries. */
  const geoVerts = (geo) => {
    const p = geo.getAttribute("position");
    const out = [];
    for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)));
    return out;
  };
  const straight = buildPiece("straight", initialConnector(), { ...pieceParams, straightLength: 30 });
  const ref = spread(railVerts(straight), (x) => (x < 0 ? x + edgeAbs : null));
  // The proxy's SPREAD is symmetric (±backZ), so a mirrored one looks identical.
  // Its foot is not: only the traffic face reaches down to the kerb top.
  const refCol = spread(geoVerts(straight.railCollision), (x) => (x < 0 ? x + edgeAbs : null), roadParams.railHeight);
  check("reference straight has its beam inboard of its posts",
    ref.hi > 0 && ref.lo < -0.1 && ref.hi < -ref.lo,
    `left rail spans ${ref.lo.toFixed(3)} .. ${ref.hi.toFixed(3)}`);

  for (const [id, legZ] of [["rounded_end", (z) => z > -pp.roundEndLength + 1], ["rounded_start", (z) => z < -hw - 1]]) {
    const piece = buildPiece(id, initialConnector(), pp);
    const got = spread(railVerts(piece), (x, z) => (legZ(z) && x < 0 ? x + edgeAbs : null));
    check(`${id}: beam faces the road like a straight's does`,
      Math.abs(got.lo - ref.lo) < 0.01 && Math.abs(got.hi - ref.hi) < 0.01,
      `${got.lo.toFixed(3)}..${got.hi.toFixed(3)} vs ${ref.lo.toFixed(3)}..${ref.hi.toFixed(3)}`);
    const col = spread(geoVerts(piece.railCollision), (x, z) => (legZ(z) && x < 0 ? x + edgeAbs : null), roadParams.railHeight);
    check(`${id}: collision proxy foot is on the same side as the beam`,
      Math.abs(col.lo - refCol.lo) < 0.01 && Math.abs(col.hi - refCol.hi) < 0.01,
      `${col.lo.toFixed(3)}..${col.hi.toFixed(3)} vs ${refCol.lo.toFixed(3)}..${refCol.hi.toFixed(3)}`);
    piece.geometry?.dispose();
    piece.railGeometry?.dispose();
    piece.railCollision?.dispose();
    piece.railMirrorGeometry?.dispose();
  }
  straight.geometry.dispose();
  straight.railGeometry?.dispose();
  straight.railCollision?.dispose();
  straight.railMirrorGeometry?.dispose();
}

console.log("\n=== SHELL IS CLOSED ===");
/**
 * Weld by position and count edges used by exactly one triangle. A road piece is
 * a solid, so the ONLY open edges allowed are:
 *   - the mating cross-section (the socket the next piece plugs into), and
 *   - the diameter plane, where the fan's two half-edges are collinear with the
 *     stub's single deck / underside edge (a T-junction with exact coordinates,
 *     so no crack — the fan origin sits precisely on the stub's edge).
 * Anything else is a hole. Both real holes this caught — the missing kerb INNER
 * face and an underside that stopped at the deck rim instead of the outer
 * radius — sat on the arc, where you could see straight through the piece.
 */
function openEdges(geo) {
  const pos = geo.getAttribute("position");
  const idx = geo.getIndex();
  const map = new Map();
  const weld = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    if (!map.has(k)) map.set(k, map.size);
    weld[i] = map.get(k);
  }
  const seen = new Map();
  for (let t = 0; t < idx.count; t += 3) {
    const v = [weld[idx.getX(t)], weld[idx.getX(t + 1)], weld[idx.getX(t + 2)]];
    for (let e = 0; e < 3; e++) {
      const p = v[e], q = v[(e + 1) % 3];
      const k = p < q ? `${p}|${q}` : `${q}|${p}`;
      const rec = seen.get(k) || { n: 0, z: [pos.getZ(idx.getX(t + e)), pos.getZ(idx.getX(t + (e + 1) % 3))] };
      rec.n++;
      seen.set(k, rec);
    }
  }
  return [...seen.values()].filter((r) => r.n === 1);
}

for (const [id, mate, diameter] of [
  ["rounded_end", 0, -pp.roundEndLength],
  ["rounded_start", -(pp.roundEndLength + hw), -hw],
]) {
  const geo = PIECE_BY_ID.get(id).geometry(pp, roadParams, true);
  const onPlane = (z, p) => Math.abs(z - p) < 1e-3;
  const stray = openEdges(geo).filter(
    (r) => !r.z.every((z) => onPlane(z, mate)) && !r.z.every((z) => onPlane(z, diameter)),
  );
  check(`${id}: no holes outside the mating face`, stray.length === 0,
    `${stray.length} stray open edge(s)`);
  geo.dispose();
}

console.log("\n=== SMOOTH ARC (not a faceted polygon) ===");
{
  // Loose quads per arc segment give every vertex a single face normal, so the
  // nose shades as a polygon next to a smooth straight. Shared arc columns mean
  // the kerb's outer face has strictly fewer unique normals than vertices.
  const geo = PIECE_BY_ID.get("rounded_end").geometry(pp, roadParams, true);
  const pos = geo.getAttribute("position");
  const nrm = geo.getAttribute("normal");
  const cz = -pp.roundEndLength;
  let arcVerts = 0;
  const dirs = new Set();
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getZ(i) - cz);
    if (Math.abs(r - hw) > 0.05 || pos.getY(i) > roadParams.railHeight - 1e-3) continue;
    if (Math.abs(nrm.getY(i)) > 0.2) continue; // side walls only
    arcVerts++;
    dirs.add(`${Math.round(nrm.getX(i) * 200)},${Math.round(nrm.getZ(i) * 200)}`);
  }
  check("arc side normals are smoothed, not per-facet",
    arcVerts > 0 && dirs.size < arcVerts * 0.75, `${dirs.size} normals / ${arcVerts} arc verts`);
  geo.dispose();
}

console.log("\n=== ROUNDED START (nose behind the entry) ===");
{
  const def = PIECE_BY_ID.get("rounded_start");
  check("rounded_start is in the kit", !!def);
  const geo = def.geometry(pp, roadParams, true);
  const box = new THREE.Box3().setFromBufferAttribute(geo.attributes.position);
  check("tip sits AT the entry", Math.abs(box.max.z) < 0.05, `max.z ${box.max.z.toFixed(3)}`);
  check("exit at L+hw", Math.abs(box.min.z + pp.roundEndLength + hw) < 0.05,
    `min.z ${box.min.z.toFixed(2)}`);
  check("same footprint as the rounded end",
    Math.abs((box.max.x - box.min.x) - roadParams.width) < 0.05);
  // The nose tapers toward z = 0, so no vertex may sit outside the semicircle
  // envelope — half-width √(R² − (R − depth)²) until the stub takes over at R.
  const pos = geo.attributes.position;
  let outside = 0;
  let worst = 0;
  for (let i = 0; i < pos.count; i++) {
    const d = -pos.getZ(i);
    const allow = d >= hw ? hw : Math.sqrt(Math.max(0, hw * hw - (hw - d) ** 2));
    const over = Math.abs(pos.getX(i)) - allow;
    if (over > 1e-3) { outside++; worst = Math.max(worst, over); }
  }
  check("nose tapers to a point at the entry", outside === 0,
    `${outside} verts outside the arc, worst +${worst.toFixed(3)} m`);
  geo.dispose();

  const frames = def.railPath(pp, roadParams);
  check("rail U wraps the start", frames.length >= 12 && frames.every((f) => f.up.y > 0.9));
  let tip = frames[0];
  for (const f of frames) if (f.pos.z > tip.pos.z) tip = f;
  check("rail visits the nose tip", tip.pos.z > -hw * 0.4, `tip z ${tip.pos.z.toFixed(2)}`);
  // Deck on +right for the whole U — buildRailAlongPath sweeps with zSign +1 and
  // would hang the corrugation on the outside if the traversal ran the other way.
  const worstDot = Math.min(...frames.map((f) => {
    const inward = new THREE.Vector3(-f.pos.x, 0, 0).normalize();
    return inward.lengthSq() < 0.5 ? 1 : f.right.dot(inward);
  }));
  check("deck stays on +right along the U", worstDot > -0.1, `worst dot ${worstDot.toFixed(2)}`);

  const built = buildPiece("rounded_start", initialConnector(), pp);
  check("builds with a rail", !!built.geometry && !!built.railGeometry && !!built.railCollision);
  built.geometry?.dispose();
  built.railGeometry?.dispose();
  built.railCollision?.dispose();
  built.railMirrorGeometry?.dispose();
}

console.log(fail === 0 ? "\nAll rounded-end checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
