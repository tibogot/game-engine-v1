// THE FRONT'S BASE CAMP round the résidence — placed at every boot
// (?enemycamp=0 turns it off), through placedObjects.js like our camp
// (campLayout.js): each piece on a levelled pad, blocking nav on its real
// footprint, giving cover, merged into a few draws.
//
// Your ask (2026-09-23): "their base is still empty next to ours". The pieces
// are rtsEnemyCamp.js (bamboo tower, long houses, cook house and its smoke
// trench, weapons rack, map table, camouflage net, bicycles, propaganda board,
// tiger cages, foxholes, trench berms) and the hamlet kit (granary, well,
// jars, washing line, bamboo and banana clumps).
//
// Offsets are from the HQ point in world metres. The attack comes from the
// south (-Z, where our camp is and where the camera looks from), so the
// fighting positions face that way, the life of the camp sits behind and
// beside the résidence, and the FORECOURT stays open — the recruits come out
// of the front door (enemyAI.js doorOf) — as do the ZPU pit, the spider hole,
// the punji pits and the cache, which are structures, not dressing.
import * as THREE from "three";
import {
  buildArmsBench, buildBambooWatchtower, buildBicycleRow, buildCamoNet, buildCookHouse, buildCraterLatrine,
  buildFoxhole, buildJarCache, buildLogBunker, buildLongHouse, buildMapTable, buildPowPit, buildPropagandaBoard,
  buildSupplyStack, buildTigerCage, buildTrenchBerm, buildWeaponsRack,
} from "../../v3/render/objects/rtsEnemyCamp.js";
import {
  buildBambooClump, buildBananaClump, buildGranary, buildJarCluster, buildWashingLine, buildWell,
} from "../../v3/render/objects/rtsVillage.js";
import { rtsObjectMaterial } from "../../v3/render/objects/rtsObjectProps.js";
import { stencilMesh } from "../../v3/render/objects/rtsStencils.js";
import { createFlag } from "../../v3/props/liveProps.js";
import { drawNlfFlag } from "./requisitionRenderer.js";

/** A kit piece, with its painted markings (if any) riding as a child. */
function kit(geo) {
  const m = new THREE.Mesh(geo, rtsObjectMaterial());
  const st = stencilMesh(geo.userData.stencil);
  if (st) m.add(st);
  return m;
}

/**
 * Place the camp round the enemy HQ with `placed` (createPlacedObjects).
 *
 * SECOND PASS (2026-09-26, "fill their base"): the first spread ~25 small
 * pieces over a 110 x 90 m square of open grass — from the RTS camera an
 * empty meadow with sheds in it. A base camp is COMPACT and DUG IN. The ground
 * here rises ~5 m to a crest 30 m in front (south) of the résidence and falls
 * ~6 m behind it, so: the fighting line on the crest — a zig-zag trench across
 * it with log bunkers and foxholes, open in the middle where the recruits
 * come out — and the life of the camp packed in behind and beside the house,
 * downhill: long houses, the POW compound (cages and the pit), the arms bench
 * by the rack, supplies by the bicycles, the jar cache, the latrine out back.
 * Pieces of the LINE are flagged `noPath` (the dressing wears paths to the
 * buildings, not to every trench segment).
 */
export async function placeEnemyCamp(app, placed) {
  const hq = app.structures?.enemyBase;
  if (!hq) return 0;
  const p = hq.position;
  const items = [];
  const add = (obj, dx, dz, rotY, o = {}) => items.push({ obj, x: p.x + dx, z: p.z + dz, rotY, ...o });
  // Keep off the Front's own structures (the ZPU pit, spider holes, punji
  // pits, the cache: gameplay, not dressing).
  const taken = (app.structures?.list ?? []).filter((q) => q !== hq && q.team !== "player")
    .map((q) => ({ x: q.position.x - p.x, z: q.position.z - p.z }));
  const free = (dx, dz, r) => taken.every((q) => (q.x - dx) ** 2 + (q.z - dz) ** 2 > r * r);
  const line = { noPath: true };

  // THE LINE ON THE CREST: a zig-zag trench, west and east of a gap in the
  // middle (the recruits' way out, the forecourt's axis), bunkers in it.
  const trench = (x0, x1, z, seed) => {
    const seg = 7.2, n = Math.max(1, Math.round((x1 - x0) / seg));
    for (let k = 0; k < n; k++) {
      const x = x0 + (k + 0.5) * ((x1 - x0) / n), zz = z + (k % 2 ? 1.6 : -1.6);
      if (!free(x, zz, 7)) continue;
      add(kit(buildTrenchBerm({ seed: seed + k, length: seg / 1.3 })), x, zz, k % 2 ? 0.42 : -0.42, { clear: 3, nav: false, ...line });
    }
  };
  trench(-50, -8, -31, 300);
  trench(9, 50, -29, 320);
  add(kit(buildLogBunker({ seed: 221 })), -24, -27, 0.05, { clear: 5, ...line });
  add(kit(buildLogBunker({ seed: 223 })), 36, -25, -0.1, { clear: 5, ...line });
  add(kit(buildLogBunker({ seed: 227 })), -47, -18, 0.6, { clear: 5, ...line });
  add(kit(buildFoxhole({ seed: 201 })), -36, -38, 0.2, { clear: 3, ...line });
  add(kit(buildFoxhole({ seed: 203 })), -8, -41, 0, { clear: 3, ...line });
  add(kit(buildFoxhole({ seed: 205 })), 44, -36, -0.2, { clear: 3, ...line });
  // The towers behind the line, where they see over it.
  add(kit(buildBambooWatchtower({ seed: 101 })), -33, -16, 0.25, { clear: 6 });
  add(kit(buildBambooWatchtower({ seed: 107 })), 40, -12, -0.3, { clear: 6 });
  add(kit(buildPropagandaBoard()), -13, -21, 0.1, { clear: 4, cover: false });

  // WEST: the platoon's long houses; the weapons rack and the arms bench
  // between them and the house; the POW compound (three cages, the pit)
  // out on the western edge.
  add(kit(buildLongHouse({ seed: 111, bays: 5 })), -32, 3, Math.PI / 2 + 0.06, { clear: 5 });
  add(kit(buildLongHouse({ seed: 117, bays: 4 })), -34, 25, Math.PI / 2 - 0.1, { clear: 5 });
  add(kit(buildWeaponsRack()), -21, -6, Math.PI / 2, { clear: 2.5 });
  add(kit(buildArmsBench({ seed: 241 })), -21, 3, Math.PI / 2 + 0.15, { clear: 2.5 });
  add(kit(buildTigerCage({ seed: 191, prisoner: true })), -45, -4, 0.3, { clear: 3 });
  add(kit(buildTigerCage({ seed: 193 })), -46, 3, 0.2, { clear: 3 });
  add(kit(buildTigerCage({ seed: 197 })), -44, -11, 0.45, { clear: 3 });
  add(kit(buildPowPit({ seed: 231 })), -47, 13, 0.1, { clear: 4 });

  // EAST: the cook house (its smoke trench runs to the back, +Z), the rice
  // granary under the netting, jars, the well, supplies, the map table.
  add(kit(buildCookHouse()), 26, 13, Math.PI + 0.1, { clear: 5 });
  add(kit(buildCamoNet({ seed: 151, w: 10, d: 8 })), 38, 31, 0.15, { clear: 4, cover: false, nav: false, pad: false });
  add(kit(buildGranary({ seed: 157 })), 40, 31, 0.2, { clear: 4 });
  add(kit(buildJarCluster({ seed: 161 })), 18, 5, 0.4, { clear: 2 });
  add(kit(buildWell({ seed: 163 })), 15, 27, 0, { clear: 3 });
  add(kit(buildMapTable()), 19, -9, 0.2, { clear: 4 });
  add(kit(buildSupplyStack({ seed: 271 })), 36, 5, -0.2, { clear: 3 });

  // BEHIND (downhill): a third long house, the bicycles that brought the rice
  // and what came off them, the jar cache, the washing line, the latrine.
  add(kit(buildLongHouse({ seed: 119, bays: 4 })), 6, 40, 0.08, { clear: 5 });
  add(kit(buildBicycleRow({ seed: 171, bikes: 5 })), -14, 30, 0.1, { clear: 3 });
  add(kit(buildSupplyStack({ seed: 277 })), -22, 36, 0.3, { clear: 3 });
  if (free(-19, 19, 5)) add(kit(buildJarCache({ seed: 261 })), -19, 19, 0.2, { clear: 3 });
  add(kit(buildWashingLine({ seed: 173 })), 22, 42, 0.3, { clear: 2, cover: false });
  add(kit(buildCraterLatrine({ seed: 251 })), 46, 48, 2.6, { clear: 4 });

  // Green in the camp: bamboo and banana where people plant them.
  const green = { pad: false, nav: false, cover: false, noPath: true };
  add(kit(buildBambooClump({ seed: 181 })), -50, 32, 0, green);
  add(kit(buildBambooClump({ seed: 183, poles: 9 })), 50, 12, 0.5, green);
  add(kit(buildBananaClump({ seed: 185 })), -6, 50, 0.3, green);
  add(kit(buildBananaClump({ seed: 187, plants: 4 })), 30, 48, 1.2, green);
  add(kit(buildBananaClump({ seed: 189, plants: 3 })), -40, 42, 0.7, green);

  const first = placed.pieces.length;
  await placed.place(items);
  items.forEach((it, k) => { if (it.noPath && placed.pieces[first + k]) placed.pieces[first + k].noPath = true; });
  return items.length;
}

/**
 * THE FLAG over the camp: the engine's Verlet CLOTH flag, like the one over
 * our HQ (baseFlag.js) — your call, 2026-09-24: not a flat panel. Smaller
 * than ours (a bamboo mast, not a 30 m pole). Its sim is skipped while it is
 * off screen, so it costs nothing when you are not looking at it.
 */
export function createEnemyCampFlag({ app, structures, offset = { x: 3, z: -38 } }) {
  const hq = structures.enemyBase?.position;
  if (!hq) return null;
  const flag = createFlag({
    poleHeight: 16, poleRadius: 0.16, clothWidth: 6.3, clothHeight: 4.2,
    xSegs: 10, ySegs: 7, flagColor: "#ffffff",
    windIntensity: 300, windSpeed: 1000, windDirection: 0, showPole: true,
  });
  const x = hq.x + offset.x, z = hq.z + offset.z;
  flag.group.position.set(x, app.getWorldHeight?.(x, z) ?? 0, z);
  app.scene.add(flag.group);
  flag.setParam("textureUrl", drawNlfFlag(256).toDataURL("image/png"));
  app.clearVegetation?.(x, z, 3, { grass: 2 });

  const sphere = new THREE.Sphere(new THREE.Vector3(x, (app.getWorldHeight?.(x, z) ?? 0) + 12, z), 12);
  const frustum = new THREE.Frustum(), m = new THREE.Matrix4();
  return {
    group: flag.group,
    /** Verlet step — only while on screen. */
    update(dt, camera) {
      if (camera) {
        m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(m);
        if (!frustum.intersectsSphere(sphere)) return;
      }
      flag.update(dt);
    },
    dispose() { app.scene.remove(flag.group); flag.dispose(); },
  };
}
