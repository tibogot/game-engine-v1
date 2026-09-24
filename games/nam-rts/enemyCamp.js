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
  buildBambooWatchtower, buildBicycleRow, buildCamoNet, buildCookHouse, buildFoxhole, buildLongHouse,
  buildMapTable, buildPropagandaBoard, buildTigerCage, buildTrenchBerm, buildWeaponsRack,
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

/** Place the camp round the enemy HQ with `placed` (createPlacedObjects). */
export async function placeEnemyCamp(app, placed) {
  const hq = app.structures?.enemyBase;
  if (!hq) return 0;
  const p = hq.position;
  const items = [];
  const add = (obj, dx, dz, rotY, o = {}) => items.push({ obj, x: p.x + dx, z: p.z + dz, rotY, ...o });

  // THE FRONT: two lashed towers on the flanks, trench berms and foxholes
  // facing south, the propaganda board by the forecourt.
  add(kit(buildBambooWatchtower({ seed: 101 })), -31, -24, 0.25, { clear: 6 });
  add(kit(buildBambooWatchtower({ seed: 107 })), 38, -12, -0.3, { clear: 6 });
  add(kit(buildTrenchBerm({ seed: 211, length: 9 })), -42, -32, 0.35, { clear: 5 });
  add(kit(buildTrenchBerm({ seed: 217, length: 9 })), 45, -27, -0.45, { clear: 5 });
  add(kit(buildFoxhole({ seed: 201 })), -33, -39, 0.2, { clear: 3 });
  add(kit(buildFoxhole({ seed: 203 })), -9, -45, 0, { clear: 3 });
  add(kit(buildFoxhole({ seed: 205 })), 31, -40, -0.2, { clear: 3 });
  add(kit(buildPropagandaBoard()), -16, -30, 0.1, { clear: 4, cover: false });

  // WEST: the platoon's long houses, the weapons rack between them and the
  // HQ, the tiger cages out at the edge on the mud.
  add(kit(buildLongHouse({ seed: 111, bays: 5 })), -39, 4, Math.PI / 2 + 0.06, { clear: 5 });
  add(kit(buildLongHouse({ seed: 117, bays: 4 })), -41, 27, Math.PI / 2 - 0.1, { clear: 5 });
  add(kit(buildWeaponsRack()), -26, -6, Math.PI / 2, { clear: 2.5 });
  add(kit(buildTigerCage({ seed: 191, prisoner: true })), -52, -14, 0.3, { clear: 3 });
  add(kit(buildTigerCage({ seed: 193 })), -53, -6, 0.2, { clear: 3 });
  add(kit(buildTigerCage({ seed: 197 })), -50, -21, 0.45, { clear: 3 });

  // EAST: the cook house (its smoke trench runs to the back, +Z), the rice
  // granary under the netting, the jars, the well.
  add(kit(buildCookHouse()), 30, 16, Math.PI + 0.1, { clear: 5 });
  add(kit(buildCamoNet({ seed: 151, w: 10, d: 8 })), 42, 36, 0.15, { clear: 4, cover: false, nav: false, pad: false });
  add(kit(buildGranary({ seed: 157 })), 44, 36, 0.2, { clear: 4 });
  add(kit(buildJarCluster({ seed: 161 })), 22, 8, 0.4, { clear: 2 });
  add(kit(buildWell({ seed: 163 })), 18, 32, 0, { clear: 3 });
  add(kit(buildMapTable()), 21, -7, 0.2, { clear: 4 });

  // BEHIND: the bicycles that brought the rice, the washing line.
  add(kit(buildBicycleRow({ seed: 171, bikes: 5 })), -14, 34, 0.1, { clear: 3 });
  add(kit(buildWashingLine({ seed: 173 })), -24, 44, 0.3, { clear: 2, cover: false });

  // Green in the camp: bamboo and banana where people plant them.
  const green = { pad: false, nav: false, cover: false };
  add(kit(buildBambooClump({ seed: 181 })), -52, 38, 0, green);
  add(kit(buildBambooClump({ seed: 183, poles: 9 })), 54, 12, 0.5, green);
  add(kit(buildBananaClump({ seed: 185 })), -6, 48, 0.3, green);
  add(kit(buildBananaClump({ seed: 187, plants: 4 })), 34, 44, 1.2, green);

  await placed.place(items);
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
