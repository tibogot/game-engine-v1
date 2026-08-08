/**
 * Headless checks for the road-piece-lab guardrail.
 *
 * The rail lives inline in games/modular-road-v3/road-piece-lab.html (it is a
 * look-dev sandbox, not kit code), so this pulls the pure builders straight out
 * of the file rather than importing them. That keeps the lab a single file while
 * still letting the geometry be tested — which matters, because two of the
 * failure modes here are SILENT: mergeGeometries returns null when indexed and
 * non-indexed geometry are mixed (empty rail, no error), and a section whose
 * winding disagrees with its supplied normals shades inside-out rather than
 * disappearing.
 *
 *   node tools/labGuardrailTest.mjs
 */
import fs from "node:fs";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const LAB = "games/modular-road-v3/road-piece-lab.html";
const src = fs.readFileSync(new URL(`../${LAB}`, import.meta.url), "utf8");

/** Lift one top-level `function name(...) {...}` out of the lab by brace match. */
function grab(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${LAB}: missing function ${name}`);
  let depth = 0;
  for (let k = src.indexOf("{", i); k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(`${LAB}: unbalanced braces in ${name}`);
}

const NAMES = [
  "straightFrames", "signedArea", "dedupe", "filletPolyline", "polylineNormals",
  "railProfile", "sweepRail", "ensureIndexed", "chamferBox", "iBeamPost",
  "boltHead", "buildPostTemplate", "placePosts", "buildLabRails",
];
const lab = new Function(
  "THREE",
  "mergeGeometries",
  `const _m = new THREE.Matrix4();
   const _pos = new THREE.Vector3();
   ${NAMES.map(grab).join("\n")}
   return { ${NAMES.join(", ")} };`,
)(THREE, mergeGeometries);

const RAIL = {
  mirrorSides: true, flipW: false, style: 3,
  height: 0.8, depth: 0.26, gap: 0.18, valleyGap: 0.3, backAmp: 0.35, plateau: 0.22,
  bendRadius: 0.05, bendSeg: 4, beadSeg: 10,
  posts: true, postSpacing: 2.8, postWidth: 0.15, postDepth: 0.17,
  flangeT: 0.022, webT: 0.018, postRise: 0.06, blockout: 0.11,
  basePlate: true, bolts: true, boltRadius: 0.034, bevel: 0.006,
};
const RP = { width: 16, thickness: 0.8, railWidth: 0.5, railHeight: 0.22, segLen: 1.6 };

let failed = 0;
const check = (ok, msg) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};
const note = (msg) => console.log(`     ${msg}`);

/* ── 1. the 2-D section ─────────────────────────────────────────────────── */

/** Even-odd point-in-polygon in the (z, y) plane. */
function inside(pts, y, z) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if ((a.y > y) !== (b.y > y) && z < ((b.z - a.z) * (y - a.y)) / (b.y - a.y) + a.z) c = !c;
  }
  return c;
}

function segmentsCross(a, b, c, d) {
  const cr = (p, q, r) => (q.z - p.z) * (r.y - p.y) - (q.y - p.y) * (r.z - p.z);
  return ((cr(c, d, a) > 0) !== (cr(c, d, b) > 0)) && ((cr(a, b, c) > 0) !== (cr(a, b, d) > 0));
}

console.log("— section —");
const SECTIONS = [
  ["thrie (default)", { ...RAIL, humps: 3, flip: false }],
  ["W-beam", { ...RAIL, humps: 2, flip: false }],
  ["box beam", { ...RAIL, humps: 1, flip: false }],
  ["field-facing", { ...RAIL, humps: 3, flip: true }],
  // deeper than it is tall — the bull-nose radius has to clamp
  ["squat + deep", { ...RAIL, height: 0.3, depth: 0.45, valleyGap: 0.6, plateau: 0.45, bendRadius: 0.12, bendSeg: 8, beadSeg: 20, humps: 3, flip: false }],
  ["no bend, no flat", { ...RAIL, valleyGap: 0.05, plateau: 0, bendRadius: 0, bendSeg: 1, beadSeg: 3, humps: 3, flip: false }],
  ["flat back", { ...RAIL, backAmp: 0, humps: 3, flip: false }],
  // asks for more back relief than the wall thickness allows — must clamp, not
  // let the two faces cross
  ["over-relieved back", { ...RAIL, backAmp: 1.5, humps: 3, flip: false }],
  ["thin wall", { ...RAIL, valleyGap: 0.06, backAmp: 0.5, humps: 3, flip: false }],
];

for (const [name, opts] of SECTIONS) {
  const p = lab.railProfile({ ...opts });
  const pts = p.pts;
  const n = pts.length;
  const bad = [];

  if (pts.some((q) => !Number.isFinite(q.y) || !Number.isFinite(q.z))) bad.push("NaN point");
  if (p.normals.some((q) => !Number.isFinite(q.y) || !Number.isFinite(q.z))) bad.push("NaN normal");
  if (lab.signedArea(pts) <= 0) bad.push("ring is not CCW");

  let crossings = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) crossings++;
    }
  }
  if (crossings) bad.push(`${crossings} self-intersections`);

  // Step off each segment along its own normal: out must leave the solid, in
  // must stay inside it. A centroid test would be useless — a corrugation
  // valley legitimately faces back toward the middle of the section.
  const eps = 2e-4;
  let intoSolid = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const l = Math.hypot(b.y - a.y, b.z - a.z) || 1;
    const ny = -(b.z - a.z) / l;
    const nz = (b.y - a.y) / l;
    const my = (a.y + b.y) * 0.5;
    const mz = (a.z + b.z) * 0.5;
    if (inside(pts, my + ny * eps, mz + nz * eps)) intoSolid++;
    else if (!inside(pts, my - ny * eps, mz - nz * eps)) intoSolid++;
  }
  if (intoSolid) bad.push(`${intoSolid}/${n} segment normals point into the solid`);

  for (let i = 0; i < n && !bad.some((s) => s.startsWith("vertex")); i++) {
    for (const k of [(i - 1 + n) % n, i]) {
      const a = pts[k];
      const b = pts[(k + 1) % n];
      const l = Math.hypot(b.y - a.y, b.z - a.z) || 1;
      const dot = p.normals[i].y * (-(b.z - a.z) / l) + p.normals[i].z * ((b.y - a.y) / l);
      if (dot <= 0) bad.push(`vertex normal ${i} disagrees with its segment`);
    }
  }

  const h = Math.max(...pts.map((q) => q.y)) - Math.min(...pts.map((q) => q.y));
  const d = Math.max(...pts.map((q) => q.z)) - Math.min(...pts.map((q) => q.z));
  const wantD = Math.min(opts.depth, opts.height * 0.9);
  if (Math.abs(h - opts.height) > 1e-6) bad.push(`height ${h.toFixed(4)} != ${opts.height}`);
  if (Math.abs(d - wantD) > 1e-6) bad.push(`depth ${d.toFixed(4)} != ${wantD}`);
  if (Math.abs(p.depth - wantD) > 1e-9) bad.push("reported depth disagrees with the ring");

  const wantValleys = Math.max(0, opts.humps - 1);
  if (p.valleys.length !== wantValleys) bad.push(`${p.valleys.length} valleys, want ${wantValleys}`);
  for (const v of p.valleys) {
    if (Math.abs(v.z) > wantD * 0.5 + 1e-9 || Math.abs(v.y) > opts.height * 0.5) {
      bad.push("a bolt valley lies outside the section");
    }
  }

  check(bad.length === 0, `${name.padEnd(17)} pts=${String(n).padStart(3)} valleys=${p.valleys.length} h=${h.toFixed(3)} d=${d.toFixed(3)}`);
  for (const b of bad) note(b);
}

/* ── 2. the swept shell ─────────────────────────────────────────────────── */

console.log("\n— shell —");
const prof = lab.railProfile({ ...RAIL, humps: RAIL.style, flip: RAIL.flipW });
const frames = lab.straightFrames(32, RP.segLen);
const centerV = RP.railHeight + RAIL.gap + RAIL.height * 0.5;

// Edges are keyed by rounded POSITION, not vertex index: the sweep duplicates
// the seam column and the caps carry their own hard-normal copies of the ring,
// so an index-keyed test would report a shell that is geometrically watertight
// as wide open.
for (const zSign of [1, -1]) {
  const beam = lab.sweepRail(frames, prof, 7.75 * zSign, zSign, centerV);
  const idx = beam.index.array;
  const pos = beam.attributes.position.array;
  const key = (v) => {
    const q = (x) => Math.round(x * 1e5);
    return `${q(pos[v * 3])},${q(pos[v * 3 + 1])},${q(pos[v * 3 + 2])}`;
  };
  const edges = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const u = key(idx[t + a]);
      const v = key(idx[t + b]);
      const k = u < v ? `${u}|${v}` : `${v}|${u}`;
      const e = edges.get(k) ?? { fwd: 0, rev: 0 };
      if (u < v) e.fwd++;
      else e.rev++;
      edges.set(k, e);
    }
  }
  let unpaired = 0;
  let inconsistent = 0;
  for (const e of edges.values()) {
    if (e.fwd + e.rev !== 2) unpaired++;
    else if (e.fwd !== 1 || e.rev !== 1) inconsistent++;
  }
  check(unpaired === 0, `zSign=${zSign} closed shell (${unpaired} unpaired edges)`);
  check(inconsistent === 0, `zSign=${zSign} consistent winding (${inconsistent} flipped edges)`);
  beam.dispose();
}

/* ── 3. post hardware ───────────────────────────────────────────────────── */

console.log("\n— posts —");
const tpl = lab.buildPostTemplate(prof, RAIL, RP.railHeight, centerV);
check(tpl != null, "post template merges (indexed + non-indexed mix)");
const box = new THREE.Box3().setFromBufferAttribute(tpl.attributes.position);
note(
  `template x[${box.min.x.toFixed(3)}, ${box.max.x.toFixed(3)}] ` +
  `y[${box.min.y.toFixed(3)}, ${box.max.y.toFixed(3)}]`,
);
const beamTop = centerV + prof.height * 0.5;
check(box.min.x > -prof.depth * 0.5, "nothing pokes out through the traffic face");
check(box.max.x > prof.backZ, "hardware reaches past the beam onto the field side");
check(box.min.y >= RP.railHeight - 1e-6, "nothing dips below the kerb top");
check(
  Math.abs(box.max.y - (beamTop + RAIL.postRise)) < 1e-3,
  `post top = beam top + rise (${box.max.y.toFixed(3)} vs ${(beamTop + RAIL.postRise).toFixed(3)})`,
);

for (const [len, spacing] of [[32, 2.8], [32, 6], [12, 2.8]]) {
  const out = [];
  lab.placePosts(lab.straightFrames(len, RP.segLen), tpl, 7.75, 1, spacing, out);
  const want = Math.max(2, Math.round(len / spacing) + 1);
  check(out.length === want, `${len} m @ ${spacing} m spacing → ${out.length} posts (want ${want})`);
  for (const g of out) g.dispose();
}

/* ── 4. every toggle still builds ───────────────────────────────────────── */

console.log("\n— variants —");
const whole = lab.buildLabRails(32, RP, RAIL);
check(whole != null, "default rail builds");
if (whole) {
  note(`${whole.attributes.position.count} verts / ${Math.round(whole.index.count / 3)} tris`);
  const nrm = whole.attributes.normal.array;
  let badN = 0;
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]);
    if (!Number.isFinite(l) || Math.abs(l - 1) > 0.02) badN++;
  }
  check(badN === 0, `all normals unit length (${badN} bad)`);
  whole.dispose();
}

for (const style of [1, 2, 3]) {
  for (const flipW of [false, true]) {
    for (const mirrorSides of [false, true]) {
      const g = lab.buildLabRails(32, RP, { ...RAIL, style, flipW, mirrorSides });
      check(g != null && g.index.count > 0, `style=${style} flip=${flipW} mirror=${mirrorSides}`);
      g?.dispose();
    }
  }
}
for (const key of ["posts", "bolts", "basePlate"]) {
  const g = lab.buildLabRails(32, RP, { ...RAIL, [key]: false });
  check(g != null && g.index.count > 0, `${key} off`);
  g?.dispose();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall guardrail checks pass");
process.exit(failed ? 1 : 0);
