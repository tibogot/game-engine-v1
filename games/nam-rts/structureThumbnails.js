// Structure thumbnails — portraits for the HQ, every building and the enemy's
// nests, baked by the same baker as the units (thumbnails.js) into the same
// map, under thumbKeyOf's keys. Each `make` builds the model the game draws.
import * as THREE from "three";
import { bakeThumbnails } from "./thumbnails.js";
import { buildRadioTower } from "./radioKit.js";
import { buildQuonsetHQ } from "../../v3/render/objects/rtsQuonset.js";
import { rtsObjectMaterial } from "../../v3/render/objects/rtsObjectProps.js";
import { buildColonialHQ } from "../../v3/render/objects/rtsColonial.js";
import {
  ZPU_MOUNT_Y, ZPU_TRUNNION_Y,
  buildMortarPit, buildMortarTube, buildTunnelEntrance, buildZpuBody, buildZpuGuns, buildZpuMount,
} from "../../v3/render/objects/rtsEnemyKit.js";
import { stencilMesh } from "../../v3/render/objects/rtsStencils.js";
import {
  GUN_PIT_HEAD_Y, NEST_HEAD_Y, buildBunker, buildGunPitBody, buildGunPitGun, buildHelipad, buildMedicTent,
  buildNestBody, buildNestGun, buildRadioPost, buildSandbagWallPiece, buildWatchTower,
} from "../../v3/render/objects/rtsBuildables.js";

/** A kit geometry as a mesh, its markings riding along. */
function kit(geo) {
  const m = new THREE.Mesh(geo, rtsObjectMaterial());
  const st = stencilMesh(geo.userData.stencil);
  if (st) m.add(st);
  return m;
}

/** A pit with its gun on the post, turned a little toward the camera. */
function withGun(body, gun, headY) {
  const g = new THREE.Group();
  g.add(kit(body));
  const m = kit(gun);
  m.position.y = headY;
  m.rotation.y = 0.7;
  g.add(m);
  return g;
}

const ITEMS = [
  ["struct:base", () => buildQuonsetHQ({}).group],
  ["struct:helipad", () => kit(buildHelipad())],
  ["struct:turret", () => withGun(buildGunPitBody(), buildGunPitGun(), GUN_PIT_HEAD_Y)],
  ["struct:radio", () => kit(buildRadioPost())],
  ["struct:captureNode", () => buildRadioTower("capture")],
  ["struct:watchTower", () => kit(buildWatchTower())],
  ["struct:medicTent", () => kit(buildMedicTent())],
  ["struct:sandbagWall", () => kit(buildSandbagWallPiece())],
  ["struct:bunker", () => kit(buildBunker())],
  ["struct:enemy:turret", () => withGun(buildNestBody(), buildNestGun(), NEST_HEAD_Y)],
  ["struct:enemy:enemyBase", () => kit(buildColonialHQ())],
  ["struct:enemy:tunnel", () => kit(buildTunnelEntrance())],
  ["struct:enemy:mortar", () => {
    const g = new THREE.Group();
    g.add(kit(buildMortarPit()));
    const tube = kit(buildMortarTube());
    tube.rotation.y = 0.5;
    g.add(tube);
    return g;
  }],
  ["struct:enemy:zpu", () => {
    // Turned toward the camera, the guns up at 30°: the four barrels read.
    const g = new THREE.Group();
    g.add(kit(buildZpuBody()));
    const mount = kit(buildZpuMount());
    mount.position.y = ZPU_MOUNT_Y; mount.rotation.y = 0.7;
    g.add(mount);
    const guns = kit(buildZpuGuns());
    guns.position.y = ZPU_TRUNNION_Y; guns.rotation.set(-0.5, 0.7, 0, "YXZ");
    g.add(guns);
    return g;
  }],
];

/** Bake every structure portrait into `into` (the units' thumbnail map). */
export async function bakeStructureThumbnails(renderer, into) {
  const made = [];
  const baked = await bakeThumbnails({
    renderer,
    // A slightly tighter fill than the units: buildings are wide and low.
    fill: 0.95,
    // radioKit may share its geometry with the live relays: never freed here.
    items: ITEMS.map(([key, make]) => ({ key, make: () => { const o = make(); if (key !== "struct:captureNode") made.push(o); return o; } })),
  });
  for (const [k, v] of baked) into.set(k, v);
  // These models are built for the portrait alone: free their geometry.
  for (const o of made) o.traverse((m) => { if (m.isMesh) m.geometry.dispose(); });
  return baked.size;
}
