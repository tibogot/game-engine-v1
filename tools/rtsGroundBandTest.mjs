/**
 * RTS KIT: NOTHING LIES FLAT IN THE GROUND BAND (z-fighting with the terrain).
 *
 * placedObjects stands a piece 2 cm BELOW its levelled pad (5 cm under the
 * terrain when it has no pad). So an UPWARD face of a piece that lies within a
 * few centimetres of the piece's own y = 0 ends up coplanar with — or a hair
 * under — the ground, and the two shimmer as the camera moves. Found by eye,
 * one at a time, far too often (2026-09-26: the lean-to's sleeping mat at
 * Kurtz's place; before it a flat scorch disc under the Huey wreck, the bridge
 * decks' ground). This makes it impossible to ship another.
 *
 * Rule: an upward-facing triangle (normal.y > 0.9) whose centroid lies in
 * [BAND_LO, BAND_HI) of the piece's local height FAILS. Either lift it to
 * BAND_HI or above (6 cm: 4 cm clear of a pad, and a pad is flat), sink it
 * below BAND_LO (hidden), or — for anything that must hug UNEVEN ground (ash,
 * scorch, stains, paths) — make it a projected DECAL, never geometry.
 *
 *   node tools/rtsGroundBandTest.mjs
 */
import * as camp from "../v3/render/objects/rtsEnemyCamp.js";
import * as temple from "../v3/render/objects/rtsTemple.js";
import * as village from "../v3/render/objects/rtsVillage.js";
import * as firebase from "../v3/render/objects/rtsFirebaseProps.js";
import * as enemyKit from "../v3/render/objects/rtsEnemyKit.js";
import * as buildables from "../v3/render/objects/rtsBuildables.js";
import { buildColonialHQ } from "../v3/render/objects/rtsColonial.js";
import { buildHueyWreck } from "../v3/render/objects/rtsVehicles.js";

export const BAND_LO = -0.02, BAND_HI = 0.06;

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  else { failed++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

/** Upward triangles lying in the ground band: count, and the first one's centroid. */
function inBand(geo) {
  const p = geo.attributes.position, idx = geo.index;
  const nt = idx ? idx.count / 3 : p.count / 3;
  const vi = (k) => (idx ? idx.getX(k) : k);
  let n = 0, first = null;
  for (let t = 0; t < nt; t++) {
    const a = vi(3 * t), b = vi(3 * t + 1), c = vi(3 * t + 2);
    const ux = p.getX(b) - p.getX(a), uy = p.getY(b) - p.getY(a), uz = p.getZ(b) - p.getZ(a);
    const wx = p.getX(c) - p.getX(a), wy = p.getY(c) - p.getY(a), wz = p.getZ(c) - p.getZ(a);
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9 || ny / len <= 0.9) continue;
    const y = (p.getY(a) + p.getY(b) + p.getZ(0) * 0 + p.getY(c)) / 3;
    if (y >= BAND_LO && y < BAND_HI) {
      n++;
      first ??= [(p.getX(a) + p.getX(b) + p.getX(c)) / 3, y, (p.getZ(a) + p.getZ(b) + p.getZ(c)) / 3].map((v) => +v.toFixed(3));
    }
  }
  return { n, first, tris: nt };
}

const check = (name, geo) => {
  const r = inBand(geo);
  ok(`${name}: nothing flat in the ground band`, r.n === 0,
    r.n ? `${r.n} upward tris in [${BAND_LO}, ${BAND_HI}) m, e.g. at ${JSON.stringify(r.first)} — lift it to >= ${BAND_HI} m, sink it, or make it a decal` : `${r.tris} tris`);
};

/** Every ground-standing builder of a kit module (default options). */
function all(label, mod, skip = []) {
  console.log(label);
  for (const [name, fn] of Object.entries(mod)) {
    if (!name.startsWith("build") || typeof fn !== "function" || skip.includes(name)) continue;
    let geo;
    try { geo = fn(); } catch { continue; }                 // builders needing args are covered elsewhere
    if (geo?.isBufferGeometry) check(name, geo);
    else if (geo?.isObject3D) geo.traverse((o) => { if (o.isMesh && o.geometry) check(`${name} / ${o.name || "mesh"}`, o.geometry); });
  }
}

all("the Front's camp", camp);
// The river stair's y = 0 is its TOP tread (it descends into a graded cut) and
// the pikes/figs have no ground parts; the rest stands on the ground.
all("the temple", temple, ["buildRiverStair"]);
all("the village", village);
all("the firebase", firebase, ["buildFirebasePreviewSet"]);
// Parts mounted ON something (a carriage, a pit, a man in a hole) — their y = 0 is not the ground.
all("the enemy kit", enemyKit, ["buildZpuGuns", "buildMortarTube", "buildSpiderMan"]);
all("buildables", buildables, ["buildGunPitGun", "buildNestGun"]);
console.log("singles");
check("colonial HQ", buildColonialHQ());
check("Huey wreck", buildHueyWreck());

console.log(failed ? `\n${failed} FAILED` : "\nall ground-band checks passed");
process.exit(failed ? 1 : 0);
