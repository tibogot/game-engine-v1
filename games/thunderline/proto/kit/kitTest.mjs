// node games/thunderline/proto/kit/kitTest.mjs
// Every tile: the last ring IS the exit socket; the path is unit-speed; turns/climbs hit their
// angle; lean in/out are what the tile says; triangles per metre stay in budget (PIECES.md §6).
import * as THREE from "three";
import { TILES, integrate, buildGeometry, leanIn, leanOut, DEG } from "./kit.js";

let fails = 0;
const fail = (m) => { fails++; console.log("FAIL", m); };
const BUDGET = 30; // triangles per metre

console.log("tile".padEnd(20), "length".padStart(7), "rings".padStart(6), "tris g/open".padStart(11), "tris/m".padStart(7), " exit (x, y, z) heading° pitch° lean°");
let totalTris = 0, totalLen = 0, totalOpen = 0;
for (const [id, t] of Object.entries(TILES)) {
  const b = integrate(t);
  const g = buildGeometry(t, b, { edges: true });
  const gOpen = buildGeometry(t, b, { edges: false });
  const tris = g.index.count / 3;
  const trisOpen = gOpen.index.count / 3;
  if (trisOpen >= tris) fail(`${id}: open should be cheaper than guarded`);
  for (const geo of [g, gOpen]) {
    for (const a of ["position", "normal", "uv", "zone", "mark"]) if (!geo.attributes[a]) fail(`${id}: missing ${a}`);
    const pos = geo.attributes.position.array;
    for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) { fail(`${id}: NaN in positions`); break; }
  }
  const last = b.rings[b.rings.length - 1];
  if (last.p.distanceTo(b.exit.p) > 1e-9) fail(`${id}: last ring is not at the exit`);
  if (Math.abs(last.lean - b.exit.lean) > 1e-9) fail(`${id}: last ring lean ≠ exit lean`);
  // modulo a full turn: a twist leaves at 360°, the same road as 0°
  const dl = b.exit.lean - leanOut(t), wrap = dl - 2 * Math.PI * Math.round(dl / (2 * Math.PI));
  if (Math.abs(wrap) > 1e-6) fail(`${id}: exit lean ${b.exit.lean / DEG} ≠ declared ${leanOut(t) / DEG}`);
  if (Math.abs(b.rings[0].lean - leanIn(t)) > 1e-9) fail(`${id}: entry lean wrong`);
  // frame stays orthonormal
  const e = b.exit;
  if (Math.abs(e.T.length() - 1) > 1e-9 || Math.abs(e.T.dot(e.U)) > 1e-9 || Math.abs(e.R.dot(e.T)) > 1e-9) fail(`${id}: exit frame not orthonormal`);
  // angles: total turn and pitch match the segments
  const wantTurn = t.segs.reduce((a, s) => a + (s.turn ?? 0), 0);
  const wantPitch = t.segs.reduce((a, s) => a + (s.pitch ?? 0), 0);
  const heading = Math.atan2(e.T.x, -e.T.z); // + = turned right
  // (atan2 with the forward part, not asin: asin stops at 90° — the 94° Quarter pipe read as 86° and failed
  // from the day it was added, unseen: this suite wasn't in npm test until 2026-10-28)
  const pitch = Math.atan2(e.T.y, -e.T.z);
  const turnErr = Math.atan2(Math.sin(heading - wantTurn), Math.cos(heading - wantTurn)); // a helix turns a full 360°
  if (!t.segs.some((s) => s.pitch) && Math.abs(turnErr) > 1e-4) fail(`${id}: turned ${heading / DEG}° want ${wantTurn / DEG}°`);
  if (!t.segs.some((s) => s.turn) && Math.abs(wantPitch) < Math.PI && Math.abs(pitch - wantPitch) > 1e-4) fail(`${id}: pitched ${pitch / DEG}° want ${wantPitch / DEG}°`);
  if (Math.abs(wantPitch - 2 * Math.PI) < 1e-9 && (Math.abs(e.T.z + 1) > 1e-4 || Math.abs(e.p.y) > 1e-3)) fail(`${id}: loop doesn't come out level and forward (T ${e.T.toArray()}, y ${e.p.y})`);
  const tpm = tris / b.L;
  if (tpm > BUDGET) fail(`${id}: ${tpm.toFixed(1)} tris/m over the ${BUDGET} budget`);
  totalTris += tris; totalLen += b.L; totalOpen += trisOpen;
  console.log(id.padEnd(20), b.L.toFixed(0).padStart(7), String(b.rings.length).padStart(6), `${tris}/${trisOpen}`.padStart(11), tpm.toFixed(1).padStart(7),
    ` (${e.p.x.toFixed(2)}, ${e.p.y.toFixed(2)}, ${e.p.z.toFixed(2)}) ${(heading / DEG).toFixed(1)} ${(pitch / DEG).toFixed(1)} ${(e.lean / DEG).toFixed(1)}`);
}
console.log(`average ${(totalTris / totalLen).toFixed(1)} tris/m guarded, ${(totalOpen / totalLen).toFixed(1)} open (old kit ~110); ${fails} failures`);
process.exit(fails ? 1 : 0);
