// Lane-road 3D meshes (v3/roads/mesh/) — headless checks on the typed arrays
// the editor turns into BufferGeometry.
//
// What a look pass in the editor cannot prove: no NaN, every triangle faces the
// way its normal says, pads and carriageways have no holes, sidewalks are
// covered at curb height, curb faces exist along the corner returns, and the
// asphalt's texture coordinate runs along the road in metres.
import { buildRoadNetwork } from "../v3/roads/roadNetwork.js";
import { buildLaneRoadMesh, MESH_DEFAULTS, lineCode, decodeLineCode } from "../v3/roads/mesh/laneRoadMesh.js";
import { dashPieces } from "../v3/roads/mesh/markingAtlas.js";
import { PREVIEW_SCENES, flattenNetwork } from "../v3/roads/mesh/previewScenes.js";
import { pointInPolygon, polylineLength } from "../v3/roads/roadMath.js";
import { rng } from "../v3/roads/roadMath.js";
import { register } from "node:module";

// Lets the TSL materials load in node (maps "three" to the webgpu build).
register("./threeWebgpuHook.mjs", import.meta.url);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const Y0 = 12;
// The exact-height checks below are about the shapes, so they build level
// roads (no crown, no banking); crowned and terrain-fitted builds are checked
// in their own section.
const LEVEL = { crown: 0, banking: false };
function build(key) {
  const data = flattenNetwork(PREVIEW_SCENES[key].build(), Y0);
  const result = buildRoadNetwork(data, { ground: () => Y0 - 0.1, blocks: false, surface: LEVEL });
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
  for (const name of ["asphalt", "concrete", "grass"]) {
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
  // Collision-only walls round the central island and the splitters (kerbs are not walls).
  {
    const W = tris(mesh.solids);
    const vertical = W.length > 0 && W.every((t) => Math.abs(t.ny) < 1e-6);
    let top = -Infinity;
    for (let v = 0; v < mesh.solids.vertexCount; v++) top = Math.max(top, mesh.solids.position[v * 3 + 1]);
    const centre = W.some((t) => Math.abs(Math.hypot((t.ax + t.bx + t.cx) / 3 - node.x, (t.az + t.bz + t.cz) / 3 - node.z) - (Ri - apron)) < 0.3);
    check("island walls: vertical, round the central island, wall height tall", vertical && centre && Math.abs(top - (Y0 + MESH_DEFAULTS.apronHeight + MESH_DEFAULTS.islandWall)) < 1e-6,
      `${W.length} tris, top ${(top - Y0).toFixed(2)} m`);
    const none = buildLaneRoadMesh(result, { islandWall: 0 });
    check("island walls off (0): no solids, and the drawn mesh is unchanged", none.solids.triangleCount === 0 && none.stats.triangles === mesh.stats.triangles);
  }
  const tops = C.filter((t) => t.ny > 0.9 && Math.abs(t.ay - (Y0 + MESH_DEFAULTS.curbHeight)) < 1e-4);
  let onSplitters = 0;
  for (const isl of node.islands.filter((i) => i.kind === "raised")) {
    const c = isl.poly.reduce((s, p) => [s[0] + p[0] / isl.poly.length, s[1] + p[1] / isl.poly.length], [0, 0]);
    if (covered(tops, c[0], c[1], Y0 + MESH_DEFAULTS.curbHeight)) onSplitters++;
  }
  check("splitter islands raised to curb height", onSplitters === splitters, `${onSplitters}/${splitters}`);
}

console.log("— markings (shader paint data) —");
{
  // A CPU copy of laneRoadPaint.js's coverage, without wear or antialiasing:
  // find the asphalt triangle under a plan point, interpolate its attributes,
  // decode the line codes, sample the atlas. If this agrees with the engine's
  // own marking data, the shader has the right inputs.
  function surfaceAt(part, x, z) {
    const P = part.position, I = part.index, UV = part.uv, N = part.normal;
    const E = part.attributes.aEdges.array, M = part.attributes.aMark.array;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      if (N[a * 3 + 1] < 0.9) continue;
      const ax = P[a * 3], az = P[a * 3 + 2], bx = P[b * 3], bz = P[b * 3 + 2], cx = P[c * 3], cz = P[c * 3 + 2];
      if (x < Math.min(ax, bx, cx) - 1e-4 || x > Math.max(ax, bx, cx) + 1e-4 || z < Math.min(az, bz, cz) - 1e-4 || z > Math.max(az, bz, cz) + 1e-4) continue;
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-12) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const lerp = (arr, size, k) => arr[a * size + k] * l1 + arr[b * size + k] * l2 + arr[c * size + k] * l3;
      return {
        s: lerp(UV, 2, 0), t: lerp(UV, 2, 1),
        edges: [lerp(E, 4, 0), lerp(E, 4, 1), E[a * 4 + 2], E[a * 4 + 3]],
        mark: [M[a * 4], M[a * 4 + 1], M[a * 4 + 2], M[a * 4 + 3]],
      };
    }
    return null;
  }
  function lineAt(tLine, code, sf) {
    if (!code) return null;
    const st = decodeLineCode(code);
    let d = Math.abs(sf.t - tLine);
    if (st.double) d = Math.abs(d - (st.width / 2 + 0.06));
    if (d > st.width / 2) return null;
    if (st.dash) {
      const period = st.dash[0] + st.dash[1];
      const ph = (((sf.s - st.phase * period) % period) + period) % period;
      if (ph > st.dash[0]) return null;
    }
    return st;
  }
  function paintAt(mesh, x, z) {
    const sf = surfaceAt(mesh.asphalt, x, z);
    if (!sf) return { surface: false };
    const hit = lineAt(sf.edges[0], sf.edges[2], sf) || lineAt(sf.edges[1], sf.edges[3], sf);
    let shape = false;
    const at = mesh.atlas;
    if (at && sf.mark[2] > 0.5) {
      const u = x * at.scale[0] + sf.mark[0], v = z * at.scale[1] + sf.mark[1];
      const px = Math.floor(u * at.width), py = Math.floor(v * at.height);
      if (px >= 0 && py >= 0 && px < at.width && py < at.height) shape = at.data[(py * at.width + px) * 2] > 128;
    }
    return { surface: true, line: hit, shape, sf };
  }

  {
    const st = [
      { color: "white", width: 0.12, dash: [3, 5] }, { color: "yellow", width: 0.12, double: true },
      { color: "white", width: 0.1, dash: [1.5, 1.5] }, { color: "yellow", width: 0.15 },
    ];
    const ok = st.every((s) => {
      const d = decodeLineCode(lineCode(s));
      return Math.abs(d.width - s.width) < 1e-9 && String(d.dash) === String(s.dash || null) && d.yellow === (s.color === "yellow") && d.double === !!s.double;
    });
    check("line styles round-trip through one float code", ok);
  }

  for (const key of ["straight", "junction", "roundabout", "boulevard"]) {
    const { result, mesh } = build(key);
    // Every painted dash the engine emits is painted by the shader data, in its colour.
    //
    // EXACT on straight roads only. The lab measures a dash along its own offset
    // line, the shader along the road's centreline station; on a bend the two
    // differ by the line's offset × curvature (1.75% for a line 7 m out on a
    // 400 m radius), so dash phases slide apart down a curve. Invisible on the
    // road; on bent lines (curves, tapers) the painted FRACTION is checked instead.
    // A line that bends or jogs sideways (a pocket taper) is longer than its stations.
    const straightLine = (pts) => { const a = pts[0], b = pts[pts.length - 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return pts.every((p) => Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / L < 0.02); };
    let n = 0, miss = 0, wrongColour = 0;
    const misses = [];
    let fracBad = 0, fracN = 0;
    const fracNotes = [];
    for (const rr of result.roads) {
      for (const l of rr.lines) {
        if (l.pts.length === 2 && polylineLength(l.pts) < l.width * 1.01 + 3) continue; // parking ticks: checked below
        if (!straightLine(l.pts)) {
          const cum = [0];
          for (let i = 1; i < l.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(l.pts[i][0] - l.pts[i - 1][0], l.pts[i][1] - l.pts[i - 1][1]));
          const L = cum[cum.length - 1];
          if (L < 40) continue;
          let on = 0, total = 0;
          for (let d = 1; d < L - 1; d += 0.25) {
            let i = 1;
            while (i < l.pts.length - 1 && cum[i] < d) i++;
            const g = (d - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
            const p = paintAt(mesh, l.pts[i - 1][0] + (l.pts[i][0] - l.pts[i - 1][0]) * g, l.pts[i - 1][1] + (l.pts[i][1] - l.pts[i - 1][1]) * g);
            if (!p.surface) continue;
            total++;
            if (p.line) { on++; if (p.line.yellow !== (l.color === "yellow")) wrongColour++; }
          }
          if (!total) continue;
          const want = l.dash ? l.dash[0] / (l.dash[0] + l.dash[1]) : 1;
          fracN++;
          if (Math.abs(on / total - want) > 0.08) { fracBad++; if (fracNotes.length < 3) fracNotes.push(`${rr.id} ${(on / total).toFixed(2)} vs ${want.toFixed(2)}`); }
          continue;
        }
        for (const piece of dashPieces(l.pts, l.dash)) {
          const cum = [0];
          for (let i = 1; i < piece.length; i++) cum.push(cum[i - 1] + Math.hypot(piece[i][0] - piece[i - 1][0], piece[i][1] - piece[i - 1][1]));
          const L = cum[cum.length - 1];
          // Probe the middle 60% of each dash (its ends may sit on a segment boundary).
          for (const f of [0.2, 0.5, 0.8]) {
            const d = L * f;
            let i = 1;
            while (i < piece.length - 1 && cum[i] < d) i++;
            const g = (d - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
            const x = piece[i - 1][0] + (piece[i][0] - piece[i - 1][0]) * g, z = piece[i - 1][1] + (piece[i][1] - piece[i - 1][1]) * g;
            const p = paintAt(mesh, x, z);
            if (!p.surface) continue;
            n++;
            if (!p.line) { miss++; if (misses.length < 3) misses.push(`${rr.id} (${x.toFixed(1)},${z.toFixed(1)}) ${l.mark || ""}`); }
            else if (p.line.yellow !== (l.color === "yellow")) wrongColour++;
          }
        }
      }
    }
    check(`${key}: every lane/edge/centre dash is in the shader data`, (n > 0 || fracN > 0) && miss === 0 && wrongColour === 0 && fracBad === 0,
      `straight roads ${miss}/${n} missing; curved lines ${fracBad}/${fracN} off in painted fraction ${fracNotes.join("; ")}; ${wrongColour} wrong colour ${misses.join("; ")}`);

    // ...and nothing is painted where the engine paints nothing.
    const rand = rng(21);
    let probes = 0, stray = 0;
    const strays = [];
    const allPieces = [];
    for (const rr of result.roads) for (const l of rr.lines) for (const piece of dashPieces(l.pts, l.dash)) allPieces.push({ piece, hw: l.width / 2 });
    const nearLine = (x, z) => allPieces.some(({ piece, hw }) => {
      for (let i = 1; i < piece.length; i++) {
        const a = piece[i - 1], b = piece[i];
        const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2));
        if (Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t) < hw + 0.25) return true;
      }
      return false;
    });
    for (const rr of result.roads) {
      for (let k = 0; k < 120; k++) {
        const i = Math.floor(rand() * (rr.smp.s.length - 1));
        const f = rand();
        const e = rr.edgesPts;
        const x = e.curbR[i][0] + (e.curbL[i][0] - e.curbR[i][0]) * f, z = e.curbR[i][1] + (e.curbL[i][1] - e.curbR[i][1]) * f;
        const p = paintAt(mesh, x, z);
        if (!p.surface || !p.line || nearLine(x, z)) continue;
        probes++;
        stray++;
        if (strays.length < 3) strays.push(`${rr.id} (${x.toFixed(1)},${z.toFixed(1)}) t=${p.sf.t.toFixed(2)}`);
      }
      probes += 0;
    }
    check(`${key}: no stray lane paint off the engine's lines`, stray === 0, `${stray} stray ${strays.join("; ")}`);

    // Node shapes: every stop line, yield tooth, crosswalk bar and arrow head is in the atlas.
    let shapes = 0, shapeMiss = 0;
    for (const node of result.nodes) {
      for (const m of node.markings) {
        if (m.kind !== "poly") continue;
        const c = m.pts.reduce((s, q) => [s[0] + q[0] / m.pts.length, s[1] + q[1] / m.pts.length], [0, 0]);
        const p = paintAt(mesh, c[0], c[1]);
        if (!p.surface) continue;
        shapes++;
        if (!p.shape) shapeMiss++;
      }
    }
    if (key !== "straight") check(`${key}: every junction shape reaches the atlas`, shapes > 0 && shapeMiss === 0, `${shapeMiss}/${shapes} missing`);
  }

  {
    const { mesh } = build("straight");
    // Parking ticks every 6 m in the parking lanes.
    const rr = build("straight").result.roads[0];
    const ticks = rr.lines.filter((l) => l.pts.length === 2 && polylineLength(l.pts) < 3);
    let hit = 0;
    for (const l of ticks) {
      const x = (l.pts[0][0] + l.pts[1][0]) / 2, z = (l.pts[0][1] + l.pts[1][1]) / 2;
      const sf = surfaceAt(mesh.asphalt, x, z);
      if (sf && sf.mark[3] > 0.5) {
        const q = ((sf.s / 6) % 1 + 1) % 1;
        if (Math.min(q, 1 - q) * 6 < 0.05) hit++;
      }
    }
    check("parking bay ticks land on the engine's ticks", ticks.length > 0 && hit === ticks.length, `${hit}/${ticks.length}`);
  }

  {
    const { mesh } = build("all");
    check("atlas for the three test scenes stays small", mesh.atlas && mesh.atlas.stats.bytes < 16e6, mesh.atlas && `${mesh.atlas.width}×${mesh.atlas.height}, ${(mesh.atlas.stats.bytes / 1e6).toFixed(1)} MB, ${mesh.atlas.stats.ms.toFixed(1)} ms`);
    const off = buildLaneRoadMesh(build("all").result, { markings: false });
    let codes = 0;
    for (let i = 2; i < off.asphalt.attributes.aEdges.array.length; i += 4) codes += off.asphalt.attributes.aEdges.array[i] + off.asphalt.attributes.aEdges.array[i + 1];
    check("markings off: no atlas, no line codes", off.atlas === null && codes === 0);
    check("dashes cut in metres along the line", (() => { const p = dashPieces([[0, 0], [10, 0], [24, 0]], [3, 5]); return p.length === 3 && p.every((q) => Math.abs(polylineLength(q) - 3) < 1e-9); })());
  }

  {
    // The shared asphalt still builds as a plain deck with the paint hook, dry and wet.
    const { createRoadMaterial } = await import("../games/modular-road-v3/modularRoadMaterial.js");
    const { createLaneRoadPaint } = await import("../v3/render/roads/laneRoadPaint.js");
    const paint = createLaneRoadPaint();
    let ok = true, why = "";
    try {
      for (const wet of [false, true]) {
        const m = createRoadMaterial({ plainDeck: true, paint: paint.hook, wet });
        if (!m.colorNode || !m.roughnessNode || (wet && !m.clearcoatNode)) { ok = false; why = `wet=${wet} missing nodes`; }
      }
    } catch (e) { ok = false; why = e.message; }
    check("asphalt material builds as a plain deck with lane paint, dry and wet", ok, why);

    // The shared city-street asphalt the lane road actually uses.
    const { createAsphaltMaterial, laneRoadFrame } = await import("../v3/render/roads/asphaltSurface.js");
    let ok2 = true, why2 = "";
    try {
      for (const wet of [false, true]) {
        const m = createAsphaltMaterial({ frame: laneRoadFrame, paint: paint.hook, wet });
        if (!m.colorNode || !m.roughnessNode || !m.normalNode || (wet && !m.clearcoatNormalNode)) { ok2 = false; why2 = `wet=${wet} missing nodes`; }
      }
    } catch (e) { ok2 = false; why2 = e.message; }
    check("city-street asphalt builds with relief and lane paint, dry and wet", ok2, why2);
  }
}

console.log("— terrain, crown, banking (roadSurface.js) —");
{
  const { terrainFn } = await import("../v3/roads/roadTerrain.js");
  const { planeY, roadSurfaceY, groundTargetAt, SURFACE_DEFAULTS } = await import("../v3/roads/roadSurface.js");
  const { armPoint } = await import("../v3/roads/roadJunction.js");
  const { curveDesign, profileAt } = await import("../v3/roads/roadProfile.js");
  const { evalAlignment } = await import("../v3/roads/roadAlignment.js");
  const { emptyNetwork, addNode, addRoad } = await import("../v3/roads/roadEdit.js");
  const hills = terrainFn("hills");

  /** Height of the topmost upward-facing triangle of `T` over (x, z), or null. */
  function heightAt(T, x, z) {
    let best = null;
    for (const t of T) {
      if (t.ny < 0.5) continue;
      if (x < Math.min(t.ax, t.bx, t.cx) - 1e-4 || x > Math.max(t.ax, t.bx, t.cx) + 1e-4) continue;
      if (z < Math.min(t.az, t.bz, t.cz) - 1e-4 || z > Math.max(t.az, t.bz, t.cz) + 1e-4) continue;
      const det = (t.bz - t.cz) * (t.ax - t.cx) + (t.cx - t.bx) * (t.az - t.cz);
      if (Math.abs(det) < 1e-12) continue;
      const l1 = ((t.bz - t.cz) * (x - t.cx) + (t.cx - t.bx) * (z - t.cz)) / det;
      const l2 = ((t.cz - t.az) * (x - t.cx) + (t.ax - t.cx) * (z - t.cz)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const y = t.ay * l1 + t.by * l2 + t.cy * l3;
      if (best == null || y > best) best = y;
    }
    return best;
  }

  const onHills = [[150, -120], [-250, 120], [0, 0]];
  for (const [ox, oz] of onHills) {
    const ground = (x, z) => hills(x + ox, z + oz);
    const result = buildRoadNetwork(PREVIEW_SCENES.all.build(), { ground, blocks: false, roadScale: 1.3 });
    const mesh = buildLaneRoadMesh(result);
    const tag = `hills @${ox},${oz}`;

    let ok = true, why = "";
    for (const name of ["asphalt", "concrete", "grass"]) {
      const p = mesh[name];
      if (!finite(p.position) || !finite(p.normal)) { ok = false; why = `${name} NaN`; }
      const bad = tris(p).filter((t) => t.agree <= 0).length;
      if (bad) { ok = false; why = `${name}: ${bad} triangles wound against their normal`; }
    }
    check(`${tag}: builds, finite, wound to their normals`, ok && !result.issues.some((i) => i.level === "error"), why);

    let steep = [];
    for (const n of result.nodes) {
      const g = Math.hypot(n.plane.gx, n.plane.gz);
      const cap = n.kind === "junction" ? SURFACE_DEFAULTS.junctionGrade : n.kind === "roundabout" ? SURFACE_DEFAULTS.roundaboutGrade : 1;
      if (g > cap + 1e-9) steep.push(`${n.id} ${(g * 100).toFixed(1)}%`);
    }
    check(`${tag}: junction planes ≤ 5 %, roundabouts ≤ 3 %`, steep.length === 0, steep.join(", ") || result.nodes.filter((n) => n.kind === "junction" || n.kind === "roundabout").map((n) => `${n.kind} ${(Math.hypot(n.plane.gx, n.plane.gz) * 100).toFixed(1)}%`).join(", "));

    const over = result.roads.filter((rr) => Math.abs(rr.prof.maxGrade) > rr.type.maxGrade + 0.006);
    check(`${tag}: every road within its grade limit`, over.length === 0, over.map((rr) => `${rr.id} ${(rr.prof.maxGrade * 100).toFixed(1)}%`).join(", "));

    // Arm mouths: the road's surface IS the pad's plane along the whole mouth line.
    let worst = 0;
    for (const rr of result.roads) {
      for (const [arm, s, sign] of [[rr.armA, rr.s0, 1], [rr.armB, rr.s1, -1]]) {
        const e = arm.edges;
        for (let f = 0; f <= 1.0001; f += 0.125) {
          const tArm = e.curbR + (e.curbL - e.curbR) * f;
          const p = armPoint(arm, arm.trim, tArm);
          worst = Math.max(worst, Math.abs(roadSurfaceY(rr, s, sign * tArm) - planeY(arm.node, p[0], p[1])));
        }
      }
    }
    check(`${tag}: roads meet their node planes at every mouth`, worst < 1e-3, `worst ${(worst * 1000).toFixed(3)} mm`);

    // ...and the MESH has no step there: asphalt heights just either side of each junction mouth.
    const A = tris(mesh.asphalt);
    let step = 0, probes = 0;
    for (const node of result.nodes.filter((n) => n.kind === "junction" || n.kind === "roundabout")) {
      for (const arm of node.arms) {
        const e = arm.edges;
        for (const f of [0.2, 0.5, 0.8]) {
          const t = e.curbR + (e.curbL - e.curbR) * f;
          // 2 cm apart: on a 5 % plane that alone is 1 mm.
          const pIn = armPoint(arm, arm.trim - 0.01, t), pOut = armPoint(arm, arm.trim + 0.01, t);
          const hi = heightAt(A, pIn[0], pIn[1]), ho = heightAt(A, pOut[0], pOut[1]);
          if (hi == null || ho == null) continue;
          probes++;
          step = Math.max(step, Math.abs(hi - ho));
        }
      }
    }
    check(`${tag}: no step in the asphalt across junction mouths`, probes > 20 && step < 0.003, `${probes} probes, worst ${(step * 1000).toFixed(1)} mm`);
  }

  // Crown: an avenue on flat ground falls from its crown line to its kerbs.
  {
    const res = buildRoadNetwork(flattenNetwork(PREVIEW_SCENES.straight.build(), Y0), { blocks: false });
    const mesh = buildLaneRoadMesh(res);
    const rr = res.roads[0];
    const i = Math.floor(rr.smp.s.length / 2);
    const s = rr.smp.s[i];
    const { layoutEdges } = await import("../v3/roads/roadCrossSection.js");
    const ed = layoutEdges(rr.lays[i]);
    const mid = (ed.curbL + ed.curbR) / 2;
    const yc = roadSurfaceY(rr, s, mid), yl = roadSurfaceY(rr, s, ed.curbL), yr = roadSurfaceY(rr, s, ed.curbR);
    const want = SURFACE_DEFAULTS.crown * (ed.curbL - ed.curbR) / 2;
    check("crown: both kerbs lie crown × half-width below the crown line", Math.abs(yc - yl - want) < 1e-6 && Math.abs(yc - yr - want) < 1e-6,
      `${((yc - yl) * 100).toFixed(1)} / ${((yc - yr) * 100).toFixed(1)} cm, want ${(want * 100).toFixed(1)} cm`);
    const A = tris(mesh.asphalt), C = tris(mesh.concrete);
    const e = evalAlignment(rr.al, s + 1);
    const P = (t) => [e.x + Math.sin(e.th) * t, e.z - Math.cos(e.th) * t];
    const [cx, cz] = P(mid);
    const [kx, kz] = P(ed.curbL - 0.05);
    const [wx, wz] = P(ed.curbL + 0.5);
    const hc = heightAt(A, cx, cz), hk = heightAt(A, kx, kz), hw = heightAt(C, wx, wz);
    check("crown: the mesh follows (centre above the gutter)", hc != null && hk != null && Math.abs(hc - yc) < 2e-3 && hk < hc - want * 0.9, `centre ${hc?.toFixed(3)} gutter ${hk?.toFixed(3)}`);
    check("crown: the sidewalk is still a kerb height above the gutter", hw != null && Math.abs(hw - yl - MESH_DEFAULTS.curbHeight) < 2e-3, `${((hw - yl) * 100).toFixed(1)} cm`);
    // The shader's drain coordinate (aPiece.y) is ±1 exactly at the lowest vertices of a cross-section row.
    const Pp = mesh.asphalt.position, D = mesh.asphalt.attributes.aPiece.array, Nn = mesh.asphalt.normal;
    const sx = rr.smp.x[i], sz = rr.smp.z[i], th = rr.smp.th[i];
    let lo = Infinity, gutter = Infinity, rowN = 0;
    for (let v = 0; v < mesh.asphalt.vertexCount; v++) {
      if (Nn[v * 3 + 1] < 0.9) continue;
      if (Math.abs((Pp[v * 3] - sx) * Math.cos(th) + (Pp[v * 3 + 2] - sz) * Math.sin(th)) > 1e-3) continue;
      rowN++;
      lo = Math.min(lo, Pp[v * 3 + 1]);
      if (Math.abs(D[v * 2 + 1]) > 0.999) gutter = Math.min(gutter, Pp[v * 3 + 1]);
    }
    check("crown: the drain coordinate (aPiece.y = ±1) sits at the lowest point", rowN > 4 && Math.abs(lo - gutter) < 1e-6, `${rowN} row vertices, lowest ${lo.toFixed(3)}, gutter ${gutter.toFixed(3)}`);
  }

  // Banking: a rural road bends; the outside of the bend is raised to the design superelevation.
  {
    const d = emptyNetwork("eu");
    const a = addNode(d, -400, 0), b = addNode(d, 400, 0);
    addRoad(d, a, b, "rural", [{ x: 0, z: 260 }]);
    const res = buildRoadNetwork(flattenNetwork(d, Y0), { blocks: false });
    const rr = res.roads[0];
    const S = rr.smp;
    let i = 0;
    for (let k = 0; k < S.s.length; k++) if (Math.abs(S.k[k]) > Math.abs(S.k[i])) i = k;
    const s = S.s[i], k = S.k[i];
    const e = curveDesign(rr.type.speed, 1 / Math.abs(k), false).e;
    const { layoutEdges } = await import("../v3/roads/roadCrossSection.js");
    const ed = layoutEdges(rr.lays[i]);
    const yl = roadSurfaceY(rr, s, ed.curbL), yr = roadSurfaceY(rr, s, ed.curbR);
    const slope = (yl - yr) / (ed.curbL - ed.curbR);
    // k > 0 is a right-hand bend: its outside is the LEFT (+t) edge.
    check("banking: outside of the bend is the high side", Math.sign(slope) === Math.sign(k) && e > SURFACE_DEFAULTS.crown, `k ${k.toExponential(2)}, slope ${(slope * 100).toFixed(2)} %`);
    check("banking: cross slope = design superelevation", Math.abs(Math.abs(slope) - e) < 1e-6, `${(Math.abs(slope) * 100).toFixed(2)} % vs e ${(e * 100).toFixed(2)} %`);
    const straightS = rr.s0 + 20;
    const yl0 = roadSurfaceY(rr, straightS, ed.curbL), yr0 = roadSurfaceY(rr, straightS, ed.curbR);
    check("banking: back to a crown on the straight", Math.abs(yl0 - yr0) < 1e-6, `${((yl0 - yr0) * 100).toFixed(2)} cm`);
    const mesh = buildLaneRoadMesh(res);
    const bad = tris(mesh.asphalt).filter((t) => t.agree <= 0).length;
    check("banking: banked mesh is wound to its normals", bad === 0, `${bad}`);
    void profileAt;
  }

  // Terrain targets for grading.
  {
    const ground = (x, z) => hills(x + 150, z - 120);
    const res = buildRoadNetwork(PREVIEW_SCENES.junction.build(), { ground, blocks: false });
    const node = res.nodes.find((n) => n.kind === "junction");
    const rand = rng(3);
    let bad = 0;
    for (const [x, z] of samplePoly(node.pad, 50, rand)) {
      const g = groundTargetAt(res, x, z);
      if (!g || g.out !== 0 || Math.abs(g.y - planeY(node, x, z)) > 1e-9) bad++;
    }
    check("ground target inside a pad is the node plane", bad === 0, `${bad}/50`);
    const rr = res.roads[0];
    const i = Math.floor(rr.smp.s.length / 2);
    const { layoutEdges } = await import("../v3/roads/roadCrossSection.js");
    const ed = layoutEdges(rr.lays[i]);
    const s = rr.smp.s[i];
    const e = evalAlignment(rr.al, s);
    const at = (t) => [e.x + Math.sin(e.th) * t, e.z - Math.cos(e.th) * t];
    const inRoad = groundTargetAt(res, ...at(0.3));
    const beyond = groundTargetAt(res, ...at(ed.propL + 3));
    check("ground target on the road is its surface", inRoad && inRoad.out === 0 && Math.abs(inRoad.y - roadSurfaceY(rr, s, 0.3)) < 5e-3, `${inRoad && (inRoad.y - roadSurfaceY(rr, s, 0.3)).toFixed(4)}`);
    check("ground target past the property line: sidewalk top, 3 m out",
      beyond && Math.abs(beyond.out - 3) < 0.05 && Math.abs(beyond.y - (roadSurfaceY(rr, s, ed.propL) + MESH_DEFAULTS.curbHeight)) < 5e-3,
      beyond && `out ${beyond.out.toFixed(2)} m, ${(beyond.y - roadSurfaceY(rr, s, ed.propL)).toFixed(3)} m above the kerb line`);
  }
}

console.log("— budget —");
{
  for (const key of ["straight", "junction", "roundabout", "all"]) {
    const { mesh } = build(key);
    console.log(`  ${key.padEnd(10)} asphalt ${mesh.asphalt.triangleCount}  concrete ${mesh.concrete.triangleCount}  grass ${mesh.grass.triangleCount}  = ${mesh.stats.triangles} tris  ${mesh.stats.ms.toFixed(1)} ms`);
  }
  const { mesh } = build("all");
  check("all three scenes under 20k triangles", mesh.stats.triangles < 20000, `${mesh.stats.triangles}`);
}

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
