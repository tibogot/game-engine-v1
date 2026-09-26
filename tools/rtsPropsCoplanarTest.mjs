/**
 * RTS PROPS: NO COPLANAR OVERLAPS (z-fighting).
 *
 * Two triangles of one merged prop lying in the same plane and overlapping
 * shimmer as the camera moves — the depth test cannot decide between them.
 * Every case found on the firebase kit (2026-09) was a part ending EXACTLY on
 * another's face: a roof sheet on a casting, a wall on a post, a crossed brace
 * in its partner's plane, a triangle-fan cap folding over itself. Each fix
 * tucked one part into the other or stood it off by a centimetre.
 *
 * Checked: every pair of triangles that share a plane (normal to ~1°, offset
 * to 2.5 mm) and whose outlines overlap once shrunk 3% toward their centres —
 * the shrink leaves triangles that only share an EDGE (the two halves of a
 * box face) alone. Downward faces at ground level are exempt: they are the
 * bottoms of things standing on the terrain and can never be seen.
 *
 *   node tools/rtsPropsCoplanarTest.mjs
 */
import {
  buildConex, buildConexYard, buildContainer, buildCrateStack, buildFuelDump, buildGuardTower, buildGunPit,
  buildGate, buildRadioStation, buildTent, buildTrainingTarget,
} from "../v3/render/objects/rtsFirebaseProps.js";
import { buildCorrugatedPanel, buildTrapezoidPanel, MAT } from "../v3/render/objects/rtsParts.js";

import { buildDoorLeaf, buildQuonsetShellGeometry } from "../v3/render/objects/rtsQuonset.js";
import { buildHueyWreck, buildM113, buildM151, buildM35, buildM48, buildM551, buildMolotova, buildPT76, buildUH1 } from "../v3/render/objects/rtsVehicles.js";
import { buildColonialHQ } from "../v3/render/objects/rtsColonial.js";
import {
  buildBoobyTrap, buildMortarPit, buildMortarTube, buildPunjiPit, buildSpiderHole, buildSpiderMan,
  buildSupplyCache, buildTunnelEntrance, buildZpuBody, buildZpuGuns, buildZpuMount,
} from "../v3/render/objects/rtsEnemyKit.js";
import {
  buildBambooClump, buildBananaClump, buildBigRoofHouse, buildCookHearth, buildDryingRack,
  buildFence, buildGranary, buildJarCluster, buildOxCart, buildPigPen, buildShrine,
  buildStrawRick, buildWashingLine, buildWell,
} from "../v3/render/objects/rtsVillage.js";
import {
  buildFigRoots, buildHeadPikes, buildNagaBalustrade, buildSkullMidden, buildTempleGallery, buildTempleGopura,
  buildTempleHearth, buildTempleLeanTo, buildTempleRubble, buildTempleTotem, buildTempleTower,
} from "../v3/render/objects/rtsTemple.js";
import * as campKit from "../v3/render/objects/rtsEnemyCamp.js";
import { buildBaileyBridge, buildMonkeyBridge, buildTrestleBridge } from "../v3/render/objects/rtsBridges.js";
import { buildGunPitBody, buildGunPitGun, buildBunker, buildHelipad, buildNestBody, buildNestGun, buildRequisitionMast, buildSandbagWallPiece } from "../v3/render/objects/rtsBuildables.js";

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  else { failed++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

/** Visible coplanar overlapping pairs in a geometry, with the first one found. */
function coplanarOverlaps(geo) {
  const p = geo.attributes.position, idx = geo.index;
  const nt = idx ? idx.count / 3 : p.count / 3;
  const vi = (k) => (idx ? idx.getX(k) : k);
  const V = (i) => [p.getX(i), p.getY(i), p.getZ(i)];
  const buckets = new Map();
  for (let t = 0; t < nt; t++) {
    const a = V(vi(3 * t)), b = V(vi(3 * t + 1)), c = V(vi(3 * t + 2));
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-7) continue;
    n = n.map((x) => x / len);
    const y = (a[1] + b[1] + c[1]) / 3;
    if (n[1] < -0.9 && y < 0.35) continue;               // a bottom on the ground
    const d = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
    // Coarse buckets (normal to ~3 deg, offset to 1 cm), each face in its offset
    // bin AND the next, so no pair is lost across a bin edge; `truly` below
    // does the exact test. (Fine bins hid real pairs by the model's orientation.)
    const nk = n.map((x) => Math.round(x * 20)).join(",");
    const dk = Math.floor(d * 100);
    const ax = Math.abs(n[0]) > Math.abs(n[1]) ? (Math.abs(n[0]) > Math.abs(n[2]) ? 0 : 2) : (Math.abs(n[1]) > Math.abs(n[2]) ? 1 : 2);
    const pr = (q) => (ax === 0 ? [q[1], q[2]] : ax === 1 ? [q[0], q[2]] : [q[0], q[1]]);
    let P = [pr(a), pr(b), pr(c)];
    const cx = (P[0][0] + P[1][0] + P[2][0]) / 3, cy = (P[0][1] + P[1][1] + P[2][1]) / 3;
    P = P.map(([x, z]) => [cx + (x - cx) * 0.97, cy + (z - cy) * 0.97]);
    const entry = { t, P, n, d, V: [a, b, c], at: [a, b, c].map((q) => q.map((x) => +x.toFixed(2))) };
    for (const key of [nk + "|" + dk, nk + "|" + (dk + 1)]) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(entry);
    }
  }
  const separated = (A, B) => {
    for (const T of [A, B]) {
      for (let i = 0; i < 3; i++) {
        const [x1, y1] = T[i], [x2, y2] = T[(i + 1) % 3];
        const nx = y2 - y1, ny = x1 - x2;
        let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
        for (const q of A) { const s = q[0] * nx + q[1] * ny; amin = Math.min(amin, s); amax = Math.max(amax, s); }
        for (const q of B) { const s = q[0] * nx + q[1] * ny; bmin = Math.min(bmin, s); bmax = Math.max(bmax, s); }
        if (amax <= bmin || bmax <= amin) return true;
      }
    }
    return false;
  };
  // The bucket key is only a pre-filter: a plane's offset is measured from the
  // ORIGIN, so on geometry metres away a sub-degree tilt moves it by
  // centimetres and faces 1.6 cm apart (the Huey's glazing over its skin) can
  // share a bucket. A pair counts only if it REALLY is coplanar: normals within
  // 1.5 deg and every corner of each within 2.5 mm of the other's plane.
  const truly = (A, B) => {
    if (A.n[0] * B.n[0] + A.n[1] * B.n[1] + A.n[2] * B.n[2] < Math.cos(1.5 * Math.PI / 180)) return false;
    const off = (T, q) => Math.abs(T.n[0] * q[0] + T.n[1] * q[1] + T.n[2] * q[2] - T.d);
    return B.V.every((q) => off(A, q) < 0.0025) && A.V.every((q) => off(B, q) < 0.0025);
  };
  let pairs = 0, first = null;
  const seen = new Set();
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!truly(list[i], list[j])) continue;
        const id = list[i].t < list[j].t ? list[i].t * 1e7 + list[j].t : list[j].t * 1e7 + list[i].t;
        if (seen.has(id)) continue;
        seen.add(id);
        if (!separated(list[i].P, list[j].P)) { pairs++; first ??= [list[i].at, list[j].at]; }
      }
    }
  }
  return { pairs, first, tris: nt };
}

const check = (name, geo) => {
  const r = coplanarOverlaps(geo);
  ok(`${name} has no coplanar overlaps`, r.pairs === 0,
    r.pairs ? `${r.pairs} pairs, e.g. ${JSON.stringify(r.first)}` : `${r.tris} tris`);
};

console.log("sheet parts");
check("corrugated panel (strip-capped ends)", buildCorrugatedPanel({ width: 2, height: 1.8, ribs: 9 }));
check("trapezoid panel", buildTrapezoidPanel({ width: 3, height: 2.5 }));

console.log("firebase props");
check("guard tower", buildGuardTower());
check("fuel dump", buildFuelDump());
check("gun pit", buildGunPit());
check("crate stack", buildCrateStack());
check("tent (blast wall)", buildTent());
check("tent (open)", buildTent({ blastWall: false }));
check("conex", buildConex());
check("conex yard", buildConexYard());
check("container (olive)", buildContainer());
check("container (camo)", buildContainer({ mat: MAT.camo }));
check("radio station", buildRadioStation());
check("camp gate", buildGate());
check("range target", buildTrainingTarget());
check("helipad", buildHelipad());
check("gun pit body (M60 post)", buildGunPitBody());
check("M60", buildGunPitGun());
check("DShK nest", buildNestBody());
check("DShK", buildNestGun());
check("sandbag wall", buildSandbagWallPiece());
check("bunker", buildBunker());
check("requisition mast", buildRequisitionMast());

console.log("vehicles");
{
  const m = buildM113();
  check("M113 ACAV hull", m);
  check("M113 ACAV turret", m.userData.turret.geo);
  check("M113 ACAV running gear", m.userData.gear);
}
{
  const m = buildM48();
  check("M48A3 hull", m);
  check("M48A3 turret", m.userData.turret.geo);
  check("M48A3 running gear", m.userData.gear);
}
{
  const m = buildM151();
  check("M151 hull", m);
  check("M151 turret (M60 + gunner)", m.userData.turret.geo);
  check("M151 wheels", m.userData.gear);
}
{
  const m = buildUH1();
  check("UH-1H fuselage", m);
  check("UH-1H main rotor", m.userData.rotors.main.geo);
  check("UH-1H tail rotor", m.userData.rotors.tail.geo);
}
{
  const m = buildM551();
  check("M551 hull", m);
  check("M551 turret", m.userData.turret.geo);
  check("M551 running gear", m.userData.gear);
}
{
  const m = buildPT76();
  check("PT-76 hull", m);
  check("PT-76 turret", m.userData.turret.geo);
  check("PT-76 running gear", m.userData.gear);
}
{
  const m = buildMolotova();
  check("Molotova truck", m);
  check("Molotova wheels", m.userData.gear);
}
{
  const m = buildM35();
  check("M35 truck", m);
  check("M35 wheels", m.userData.gear);
}

console.log("Quonset HQ");
check("quonset shell", buildQuonsetShellGeometry().shellGeo);
check("quonset door leaf", buildDoorLeaf(3.94, 5.45, 51));

console.log("Enemy buildings");
check("French colonial HQ", buildColonialHQ());
check("tunnel entrance", buildTunnelEntrance());
check("mortar pit + crew", buildMortarPit());
check("mortar tube", buildMortarTube());
check("ZPU-4 pit + carriage", buildZpuBody());
check("ZPU-4 mount + gunner", buildZpuMount());
check("ZPU-4 guns", buildZpuGuns());
check("punji pit", buildPunjiPit());
check("booby trap", buildBoobyTrap());
check("supply cache", buildSupplyCache());
check("spider hole", buildSpiderHole());
check("spider hole fighter", buildSpiderMan());

console.log("Hamlet kit");
check("big-roofed house", buildBigRoofHouse());
check("rice granary", buildGranary());
check("village well", buildWell());
check("spirit shrine", buildShrine());
check("bamboo fence", buildFence());
check("water jars", buildJarCluster());
check("drying rack", buildDryingRack());
check("straw rick", buildStrawRick());
check("cooking hearth", buildCookHearth());
check("ox cart", buildOxCart());
check("bamboo clump", buildBambooClump());
check("banana clump", buildBananaClump());
check("pig pen", buildPigPen());
check("washing line", buildWashingLine());

console.log("Khmer ruins");
check("temple tower", buildTempleTower());
check("temple gallery", buildTempleGallery());
check("temple gopura", buildTempleGopura());
check("temple rubble", buildTempleRubble());
check("naga balustrade", buildNagaBalustrade());
check("strangler fig", buildFigRoots());

// Added 2026-09-26 — the pieces built since this list was written.
console.log("the Front's camp (2026-09-26)");
for (const [name, fn] of Object.entries(campKit)) if (name.startsWith("build")) check(name, fn());
console.log("Kurtz's people");
check("lean-to", buildTempleLeanTo());
check("hearth", buildTempleHearth());
check("skull midden", buildSkullMidden());
check("totem", buildTempleTotem());
check("head pikes", buildHeadPikes());
console.log("bridges and the wreck");
check("Bailey bridge", buildBaileyBridge({ span: 32 }));
check("trestle bridge", buildTrestleBridge({ span: 38 }));
check("monkey bridge", buildMonkeyBridge({ span: 24 }));
check("Huey wreck", buildHueyWreck());

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
