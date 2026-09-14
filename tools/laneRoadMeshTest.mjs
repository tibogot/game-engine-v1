// Lane-road 3D meshes (v3/roads/mesh/) — headless checks on the typed arrays
// the editor turns into BufferGeometry.
//
// What a look pass in the editor cannot prove: no NaN, every triangle faces the
// way its normal says, pads and carriageways have no holes, sidewalks are
// covered at curb height, curb faces exist along the corner returns, and the
// asphalt's texture coordinate runs along the road in metres.
import { buildRoadNetwork } from "../v3/roads/roadNetwork.js";
import { buildLaneRoadMesh, MESH_DEFAULTS } from "../v3/roads/mesh/laneRoadMesh.js";
import { PREVIEW_SCENES, flattenNetwork } from "../v3/roads/mesh/previewScenes.js";
import { pointInPolygon, polylineLength } from "../v3/roads/roadMath.js";
import { rng } from "../v3/roads/roadMath.js";

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const Y0 = 12;
function build(key) {
  const data = flattenNetwork(PREVIEW_SCENES[key].build(), Y0);
  const result = buildRoadNetwork(data, { ground: () => Y0 - 0.1, blocks: false });
  const mesh = buildLaneRoadMesh(result);
  return { data, result, mesh };
}

const finite = (arr) => arr.every((v) => Number.isFinite(v));

/** Triangles of a part as plain records, with the geometric normal. */
function tris(part) {
  const P = part.position, I = part.index, Nn = part.normal;
  const out = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
    const cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const vnx = Nn[a * 3] + Nn[b * 3] + Nn[c * 3], vny = Nn[a * 3 + 1] + Nn[b * 3 + 1] + Nn[c * 3 + 1], vnz = Nn[a * 3 + 2] + Nn[b * 3 + 2] + Nn[c * 3 + 2];
    out.push({ ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz, agree: nx * vnx + ny * vny + nz * vnz });
  }
  return out;
}

function covered(T, x, z, yWant, tol = 0.01) {
  for (const t of T) {
    if (t.ny < 0.9) continue;
    if (x < Math.min(t.ax, t.bx, t.cx) - 1e-4 || x > Math.max(t.ax, t.bx, t.cx) + 1e-4) continue;
    if (z < Math.min(t.az, t.bz, t.cz) - 1e-4 || z > Math.max(t.az, t.bz, t.cz) + 1e-4) continue;
    const d1 = (x - t.bx) * (t.az - t.bz) - (t.ax - t.bx) * (z - t.bz);
    const d2 = (x - t.cx) * (t.bz - t.cz) - (t.bx - t.cx) * (z - t.cz);
    const d3 = (x - t.ax) * (t.cz - t.az) - (t.cx - t.ax) * (z - t.az);
    const neg = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9, pos = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
    if (neg && pos) continue;
    if (yWant == null || Math.abs(t.ay - yWant) < tol) return true;
  }
  return false;
}

function samplePoly(poly, count, rand, reject = () => false) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of poly) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const out = [];
  for (let guard = 0; out.length < count && guard < count * 200; guard++) {
    const x = minX + (maxX - minX) * rand(), z = minZ + (maxZ - minZ) * rand();
    if (!pointInPolygon(x, z, poly) || reject(x, z)) continue;
    // Keep off the outline itself: a point ON a shared edge can fall between floats.
    let near = false;
    for (let i = 0; i < poly.length && !near; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const dx = q[0] - p[0], dz = q[1] - p[1], L2 = dx * dx + dz * dz || 1;
      const u = Math.max(0, Math.min(1, ((x - p[0]) * dx + (z - p[1]) * dz) / L2));
      near = Math.hypot(x - p[0] - dx * u, z - p[1] - dz * u) < 0.05;
    }
    if (!near) out.push([x, z]);
  }
  return out;
}

console.log("— every scene builds clean —");
for (const key of Object.keys(PREVIEW_SCENES)) {
  const { mesh } = build(key);
  let ok = true, why = "";
  for (const name of ["asphalt", "concrete", "grass", "paint"]) {
    const p = mesh[name];
    if (!finite(p.position) || !finite(p.normal) || !finite(p.uv)) { ok = false; why = `${name} NaN`; }
    for (const a of Object.values(p.attributes)) if (!finite(a.array)) { ok = false; why = `${name} attr NaN`; }
    for (const i of p.index) if (i >= p.vertexCount) { ok = false; why = `${name} index out of range`; break; }
    const bad = tris(p).filter((t) => t.agree <= 0).length;
    if (bad) { ok = false; why = `${name}: ${bad} triangles wound against their normal`; }
  }
  check(`${key}: finite, indexed, wound to their normals`, ok && mesh.asphalt.triangleCount > 0 && mesh.concrete.triangleCount > 0, why ||
    `${mesh.stats.triangles} tris, ${mesh.stats.vertices} verts, ${mesh.stats.ms.toFixed(1)} ms`);
}

console.log("— straight road —");
{
  const { result, mesh } = build("straight");
  const A = tris(mesh.asphalt);
  const rr = result.roads[0];
  const rand = rng(7);
  let miss = 0, n = 0;
  for (let k = 0; k < 300; k++) {
    const i = Math.floor(rand() * (rr.smp.s.length - 1));
    const lay = rr.lays[i];
    const e = rr.edgesPts;
    const f = 0.02 + rand() * 0.96;
    const x = e.curbR[i][0] + (e.curbL[i][0] - e.curbR[i][0]) * f, z = e.curbR[i][1] + (e.curbL[i][1] - e.curbR[i][1]) * f;
    n++;
    if (!covered(A, x, z, Y0)) miss++;
    void lay;
  }
  check("carriageway fully paved at road height", miss === 0, `${miss}/${n} probes uncovered`);

  // Texture runs along the road: u (metres) grows with x on this west→east road.
  const P = mesh.asphalt.position, UV = mesh.asphalt.uv, Nn = mesh.asphalt.normal;
  let worst = 0;
  for (let v = 0; v < mesh.asphalt.vertexCount; v++) {
    if (Nn[v * 3 + 1] < 0.9) continue;
    worst = Math.max(worst, Math.abs(UV[v * 2] - (P[v * 3] - result.roads[0].smp.x[0] + result.roads[0].smp.s[0])));
  }
  check("asphalt u = metres along the road (no stretch)", worst < 1e-3, `worst ${worst.toExponential(2)}`);

  let yMax = -Infinity, yMin = Infinity;
  for (let v = 0; v < mesh.concrete.vertexCount; v++) { yMax = Math.max(yMax, mesh.concrete.position[v * 3 + 1]); yMin = Math.min(yMin, mesh.concrete.position[v * 3 + 1]); }
  check("sidewalks top out at curb height", Math.abs(yMax - (Y0 + MESH_DEFAULTS.curbHeight)) < 1e-4, `top ${(yMax - Y0).toFixed(3)} m`);
  check("back faces run below ground", yMin < Y0 - 0.5, `bottom ${(yMin - Y0).toFixed(2)} m`);

  const C = tris(mesh.concrete);
  const vertical = C.filter((t) => Math.abs(t.ny) < 0.05);
  const curbLen = polylineLength(rr.edgesPts.curbL) + polylineLength(rr.edgesPts.curbR);
  let faceLen = 0;
  for (const t of vertical) {
    const top = Math.max(t.ay, t.by, t.cy);
    if (top < Y0 + 0.1 || Math.min(t.ay, t.by, t.cy) < Y0 - 0.01) continue; // curb faces only (not back faces)
    faceLen += Math.max(Math.hypot(t.bx - t.ax, t.bz - t.az), Math.hypot(t.cx - t.ax, t.cz - t.az), Math.hypot(t.cx - t.bx, t.cz - t.bz)) / 2;
  }
  // Two triangles per face segment, each reporting half its longest edge ≈ one segment length.
  check("curb face along both road edges", faceLen > curbLen * 0.95, `${faceLen.toFixed(1)} m of face for ${curbLen.toFixed(1)} m of curb (+ dead-end curbs)`);
}

console.log("— 4-way junction —");
{
  const { result, mesh } = build("junction");
  const node = result.nodes.find((n) => n.kind === "junction");
  check("scene has a 4-arm junction", node && node.arms.length === 4);
  const A = tris(mesh.asphalt), C = tris(mesh.concrete);
  const rand = rng(11);
  const pts = samplePoly(node.pad, 400, rand);
  const miss = pts.filter(([x, z]) => !covered(A, x, z, Y0)).length;
  check("junction pad has no holes", miss === 0, `${miss}/${pts.length} probes uncovered`);
  let sMiss = 0, sN = 0, sw = 0;
  for (const c of node.corners) {
    if (!c.sw) continue;
    sw++;
    const poly = [...c.curbChain, ...c.propChain.slice().reverse()];
    const inset = MESH_DEFAULTS.bevel + 0.03;
    for (const [x, z] of samplePoly(poly, 60, rand)) {
      // Skip the bevel strip along the curb: its top edge is at curb height but it slopes.
      let dCurb = Infinity;
      for (let i = 0; i + 1 < c.curbChain.length; i++) {
        const p = c.curbChain[i], q = c.curbChain[i + 1];
        const dx = q[0] - p[0], dz = q[1] - p[1], L2 = dx * dx + dz * dz || 1;
        const u = Math.max(0, Math.min(1, ((x - p[0]) * dx + (z - p[1]) * dz) / L2));
        dCurb = Math.min(dCurb, Math.hypot(x - p[0] - dx * u, z - p[1] - dz * u));
      }
      if (dCurb < inset) continue;
      sN++;
      if (!covered(C, x, z, Y0 + MESH_DEFAULTS.curbHeight)) sMiss++;
    }
  }
  check("4 corner sidewalks covered at curb height", sw === 4 && sMiss === 0, `${sMiss}/${sN} probes uncovered`);
  // Curb face at the middle of every corner return.
  let found = 0;
  for (const c of node.corners) {
    const mid = c.curbChain[Math.floor(c.curbChain.length / 2)];
    const hit = C.some((t) => Math.abs(t.ny) < 0.05 && Math.min(t.ay, t.by, t.cy) > Y0 - 0.01 &&
      Math.hypot((t.ax + t.bx + t.cx) / 3 - mid[0], (t.az + t.bz + t.cz) / 3 - mid[1]) < 0.6);
    if (hit) found++;
  }
  check("curb face along every corner return", found === 4, `${found}/4`);
  let yMax = -Infinity;
  for (let v = 0; v < mesh.grass.vertexCount; v++) yMax = Math.max(yMax, mesh.grass.position[v * 3 + 1]);
  check("raised median is grass at median height", mesh.grass.triangleCount > 0 && Math.abs(yMax - (Y0 + MESH_DEFAULTS.medianHeight)) < 1e-4, `${mesh.grass.triangleCount} tris`);
}

console.log("— roundabout —");
{
  const { result, mesh } = build("roundabout");
  const node = result.nodes.find((n) => n.kind === "roundabout");
  const A = tris(mesh.asphalt), C = tris(mesh.concrete), G = tris(mesh.grass);
  const { Ri, apron } = node.ring;
  const rand = rng(5);
  const ringPts = samplePoly(node.pad, 400, rand, (x, z) => Math.hypot(x - node.x, z - node.z) < Ri + 0.05);
  const miss = ringPts.filter(([x, z]) => !covered(A, x, z, Y0)).length;
  check("ring carriageway has no holes", miss === 0, `${miss}/${ringPts.length} probes uncovered`);
  const holeHits = [];
  for (let k = 0; k < 100; k++) {
    const a = rand() * Math.PI * 2, r = rand() * (Ri - 0.1);
    const x = node.x + Math.cos(a) * r, z = node.z + Math.sin(a) * r;
    if (covered(A, x, z, null)) holeHits.push([x, z]);
  }
  check("no asphalt under the central island (cut as a hole)", holeHits.length === 0, `${holeHits.length}/100`);
  let apronMiss = 0, grassMiss = 0;
  for (let k = 0; k < 120; k++) {
    const a = rand() * Math.PI * 2;
    const rA = Ri - apron + MESH_DEFAULTS.bevel + 0.05 + rand() * (apron - 2 * MESH_DEFAULTS.bevel - 0.1);
    if (!covered(C, node.x + Math.cos(a) * rA, node.z + Math.sin(a) * rA, Y0 + MESH_DEFAULTS.apronHeight)) apronMiss++;
    const rG = rand() * (Ri - apron - MESH_DEFAULTS.bevel - MESH_DEFAULTS.curbBand - 0.1);
    if (!covered(G, node.x + Math.cos(a) * rG, node.z + Math.sin(a) * rG, Y0 + MESH_DEFAULTS.islandHeight)) grassMiss++;
  }
  check("apron covered at apron height", apronMiss === 0, `${apronMiss}/120`);
  check("central island grass at island height", grassMiss === 0, `${grassMiss}/120`);
  const splitters = node.islands.filter((i) => i.kind === "raised").length;
  check("splitter islands on the two-way arms", splitters >= 3, `${splitters}`);
  const tops = C.filter((t) => t.ny > 0.9 && Math.abs(t.ay - (Y0 + MESH_DEFAULTS.curbHeight)) < 1e-4);
  let onSplitters = 0;
  for (const isl of node.islands.filter((i) => i.kind === "raised")) {
    const c = isl.poly.reduce((s, p) => [s[0] + p[0] / isl.poly.length, s[1] + p[1] / isl.poly.length], [0, 0]);
    if (covered(tops, c[0], c[1], Y0 + MESH_DEFAULTS.curbHeight)) onSplitters++;
  }
  check("splitter islands raised to curb height", onSplitters === splitters, `${onSplitters}/${splitters}`);
}

console.log("— markings —");
{
  const lift = MESH_DEFAULTS.paintLift;
  for (const key of ["straight", "junction", "roundabout"]) {
    const { result, mesh } = build(key);
    const P = mesh.paint.position;
    let off = 0;
    for (let v = 0; v < mesh.paint.vertexCount; v++) if (Math.abs(P[v * 3 + 1] - (Y0 + lift)) > 1e-4) off++;
    check(`${key}: paint present, all of it ${lift * 100} cm above the asphalt`, mesh.paint.triangleCount > 0 && off === 0, `${mesh.paint.triangleCount} tris, ${off} verts off-height`);

    // Paint lies on asphalt, never on a sidewalk or an island.
    const A = tris(mesh.asphalt);
    const T = tris(mesh.paint);
    let offRoad = 0;
    for (const t of T) {
      const cx = (t.ax + t.bx + t.cx) / 3, cz = (t.az + t.bz + t.cz) / 3;
      if (!covered(A, cx, cz, Y0)) offRoad++;
    }
    check(`${key}: every paint triangle sits over asphalt`, offRoad === 0, `${offRoad}/${T.length} off the road`);

    // Painted area matches the data: dash fraction × length × width, plus polygons.
    let want = 0;
    for (const rr of result.roads) {
      for (const l of rr.lines) {
        const len = polylineLength(l.pts);
        const pieces = l.dash ? (() => { let s = 0; for (let d = 0; d < len - 0.05; d += l.dash[0] + l.dash[1]) { const e = Math.min(len, d + l.dash[0]); if (e - d >= 0.2) s += e - d; } return s; })() : len;
        want += pieces * l.width;
      }
    }
    const shoelace = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a / 2); };
    for (const n of result.nodes) {
      for (const m of n.markings) {
        if (m.kind === "poly") want += shoelace(m.pts);
        else if (m.kind === "line") want += polylineLength(m.pts) * m.width * (m.dash ? m.dash[0] / (m.dash[0] + m.dash[1]) : 1);
      }
    }
    let got = 0;
    for (const t of T) got += Math.abs((t.bx - t.ax) * (t.cz - t.az) - (t.cx - t.ax) * (t.bz - t.az)) / 2;
    check(`${key}: painted area matches the marking data`, Math.abs(got - want) / want < 0.06, `${got.toFixed(1)} m² vs ${want.toFixed(1)} m²`);
  }
  {
    const { result, mesh } = build("junction");
    const node = result.nodes.find((n) => n.kind === "junction");
    const T = tris(mesh.paint);
    const bars = node.markings.filter((m) => m.tag === "zebra");
    const hit = bars.filter((m) => {
      const c = m.pts.reduce((s, p) => [s[0] + p[0] / m.pts.length, s[1] + p[1] / m.pts.length], [0, 0]);
      return covered(T, c[0], c[1], Y0 + lift);
    }).length;
    check("junction: every crosswalk bar painted", bars.length > 0 && hit === bars.length, `${hit}/${bars.length}`);
  }
  {
    // Dashes: a [3, 5] lane line over 24 m paints 3 dashes of 3 m.
    const pieces = (await import("../v3/roads/mesh/laneRoadMesh.js")).dashPieces([[0, 0], [10, 0], [24, 0]], [3, 5]);
    check("dashes cut in metres along the line", pieces.length === 3 && pieces.every((p) => Math.abs(polylineLength(p) - 3) < 1e-9), pieces.map((p) => polylineLength(p).toFixed(2)).join(", "));
  }
  {
    const { mesh } = build("all");
    const off = buildLaneRoadMesh(build("all").result, { markings: false });
    check("markings can be switched off", off.paint.triangleCount === 0 && mesh.paint.triangleCount > 0);
  }
}

console.log("— budget —");
{
  for (const key of ["straight", "junction", "roundabout", "all"]) {
    const { mesh } = build(key);
    console.log(`  ${key.padEnd(10)} asphalt ${mesh.asphalt.triangleCount}  concrete ${mesh.concrete.triangleCount}  grass ${mesh.grass.triangleCount}  paint ${mesh.paint.triangleCount}  = ${mesh.stats.triangles} tris  ${mesh.stats.ms.toFixed(1)} ms`);
  }
  const { mesh } = build("all");
  check("all three scenes under 20k triangles", mesh.stats.triangles < 20000, `${mesh.stats.triangles}`);
}

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
