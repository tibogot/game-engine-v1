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
import * as algeria from "../v3/render/objects/rtsAlgeria.js";
import * as algVillage from "../v3/render/objects/rtsAlgVillage.js";
import { buildFrenchPost } from "../v3/render/objects/rtsFrenchPost.js";
import { buildMechta } from "../v3/render/objects/rtsMechta.js";
import { buildAlnCamp } from "../v3/render/objects/rtsAlnCamp.js";
import { buildAMX13, buildAlouette, buildEBR, buildGMC, buildHalfTrack, buildWillys } from "../v3/render/objects/rtsVehiclesFr.js";
import { coplanarOverlaps } from "./lib/coplanar.mjs";
import { buildGunPitBody, buildGunPitGun, buildBunker, buildHelipad, buildNestBody, buildNestGun, buildRequisitionMast, buildSandbagWallPiece } from "../v3/render/objects/rtsBuildables.js";

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  else { failed++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

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

console.log("the Algeria game");
{ const post = buildFrenchPost(); check("French post", post); for (const [k, g] of Object.entries(post.userData.parts ?? {})) check(`French post ${k}`, g); }
// (detail 2 — what the game builds; detail 1 alone let the buttress caps z-fight, 2026-10-11)
check("French post detail 2", buildFrenchPost({ detail: 2 }));
check("mechta", buildMechta());
check("ALN camp", buildAlnCamp());
for (const [name, fn] of [["EBR", buildEBR], ["Willys", buildWillys], ["GMC", buildGMC], ["AMX-13", buildAMX13], ["half-track", buildHalfTrack], ["Alouette", buildAlouette]]) {
  const m = fn();
  check(`${name} hull`, m);
  if (m.userData.gear) check(`${name} running gear`, m.userData.gear);
  if (m.userData.turret) check(`${name} turret`, m.userData.turret.geo);
  if (m.userData.rotors) { check(`${name} main rotor`, m.userData.rotors.main.geo); check(`${name} tail rotor`, m.userData.rotors.tail.geo); }
}
for (const [name, fn] of [...Object.entries(algeria), ...Object.entries(algVillage)]) {
  if (!name.startsWith("build") || typeof fn !== "function") continue;
  const g = fn();
  if (g?.isBufferGeometry) check(name, g);
  for (const sub of Object.values(g?.userData?.parts ?? {})) if (sub?.isBufferGeometry) check(`${name} part`, sub);
}
// Detail 2 (the buildings lab): the motor pool's lapped roof sheets.
check("buildMotorPool detail 2", algeria.buildMotorPool({ detail: 2 }));
check("buildRomanRuin detail 2", algVillage.buildRomanRuin({ detail: 2 }));
check("buildRomanRuin detail 2 mirrored", algVillage.buildRomanRuin({ detail: 2, seed: 1985 }));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
