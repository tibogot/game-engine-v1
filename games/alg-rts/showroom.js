// SHOWROOM — the Algeria game's new assets, placed on the real map under the
// real light, so they are judged where they will be played (the lab has its
// own light and no terrain). Temporary: it goes when gameplay places things.
//
// Each entry is levelled onto its own pad (app.flattenRect) and drawn with the
// kit's one atlas material, markings as a child — exactly how nam-rts draws
// its buildings (buildingRenderer.kitView).
import * as THREE from "three";
import { rtsObjectMaterialTinted } from "../../v3/render/objects/rtsObjectProps.js";
import { stencilMesh } from "../../v3/render/objects/rtsStencils.js";
import { buildFrenchPost } from "../../v3/render/objects/rtsFrenchPost.js";
import { rtsRunningGearMaterial } from "../../v3/render/objects/rtsVehicles.js";
import { FR_PAINT_TINT, buildAMX13, buildAlouette, buildEBR, buildGMC, buildHalfTrack, buildWillys } from "../../v3/render/objects/rtsVehiclesFr.js";
import { buildMechta } from "../../v3/render/objects/rtsMechta.js";
import { PlacedFoliage } from "../../v3/render/foliage/placedFoliage.js";
import { plantPostFlag } from "./algFlag.js";
import { FOLIAGE_PRESETS } from "../../v3/app/state/foliageScatterState.js";

/** What to show, and where (world x/z, yaw). Vehicles park by the post's gate. */
export const SHOWROOM = [
  { key: "frenchPost", build: buildFrenchPost, x: 40, z: 150, yaw: 0.35 },
  { key: "ebr", build: buildEBR, x: 22, z: 108, yaw: 0.35 + 0.5, vehicle: true },
  { key: "willys", build: buildWillys, x: 30, z: 103, yaw: 0.35 - 0.3, vehicle: true },
  { key: "gmc", build: buildGMC, x: 12, z: 118, yaw: 0.35 + 1.2, vehicle: true },
  { key: "alouette", build: buildAlouette, x: 72, z: 118, yaw: 2.4, vehicle: true },
  { key: "amx13", build: buildAMX13, x: 4, z: 100, yaw: 0.35 + 0.4, vehicle: true },
  { key: "halftrack", build: buildHalfTrack, x: 38, z: 92, yaw: 0.35 - 0.2, vehicle: true },
  // The hamlet up the valley from the post.
  { key: "mechta", build: buildMechta, x: 150, z: 60, yaw: 0.9 },
];

let _glass = null;
/** Cockpit glass: dark, slightly blue, glossy, mostly see-through. */
function glassMaterial() {
  if (!_glass) {
    _glass = new THREE.MeshStandardNodeMaterial({
      color: 0x2a3a44, roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.32,
      depthWrite: false, side: THREE.DoubleSide,
    });
    _glass.name = "CockpitGlass";
  }
  return _glass;
}

function kitView(geo) {
  // The French side's paint (FR_PAINT_TINT) on everything of this game's.
  const m = new THREE.Mesh(geo, rtsObjectMaterialTinted(FR_PAINT_TINT));
  m.castShadow = m.receiveShadow = true;
  const st = stencilMesh(geo.userData.stencil);
  if (st) m.add(st);
  // A vehicle's wheels and tracks: their own geometry on the rolling-gear
  // material, which reads a per-INSTANCE odometer — so an InstancedMesh of one.
  const gearGeo = geo.userData.gear;
  if (gearGeo) {
    const gear = new THREE.InstancedMesh(gearGeo, rtsRunningGearMaterial(FR_PAINT_TINT), 1);
    gear.setMatrixAt(0, new THREE.Matrix4());
    gear.castShadow = gear.receiveShadow = true;
    gear.frustumCulled = false;
    m.add(gear);
  }
  // A helicopter's rotors: meshes on their pivots, turned every frame (the
  // unit renderer does the same by name: MainRotor about Y, TailRotor about X).
  // A canopy: glass you can see the crew through (the kit's atlas material is
  // opaque). One shared material; drawn after the opaque pass, no depth write.
  if (geo.userData.glass) {
    const gm = new THREE.Mesh(geo.userData.glass, glassMaterial());
    gm.name = "Glass";
    gm.renderOrder = 2;
    m.add(gm);
  }
  // A turret: its own mesh on the ring (the unit renderer turns it about Y).
  const tur = geo.userData.turret;
  if (tur) {
    const tm = new THREE.Mesh(tur.geo, rtsObjectMaterialTinted(FR_PAINT_TINT));
    tm.name = "Turret";
    tm.position.set(...tur.pivot);
    tm.castShadow = tm.receiveShadow = true;
    m.add(tm);
  }
  const rotors = geo.userData.rotors;
  if (rotors) {
    const mat = rtsObjectMaterialTinted(FR_PAINT_TINT);
    for (const [key, name] of [["main", "MainRotor"], ["tail", "TailRotor"]]) {
      const r = rotors[key];
      const rm = new THREE.Mesh(r.geo, mat);
      rm.name = name;
      rm.position.set(...r.pivot);
      rm.castShadow = true;
      m.add(rm);
    }
  }
  return m;
}

/**
 * The Aurès plants (FOLIAGE_PRESETS atlasCedar / holmOak / juniperScrub /
 * alfa), hand-placed through the engine's PlacedFoliage like nam-rts's
 * ornamentals — the map's paint slots stay untouched until the look is agreed.
 * Cedars up on the massif, where they grow; the rest round the post, to be
 * judged against the buildings.
 */
const PLANT_KINDS = ["atlasCedar", "holmOak", "juniperScrub", "alfa", "datePalm", "canaryPalm", "doumPalm", "typha"];
/** The oasis the map carries (tools/algOasis.mjs). */
const OASIS = { x: 132, z: 128, r: 20 };

function placePlants(app) {
  const pf = new PlacedFoliage({ scene: app.scene });
  for (const k of PLANT_KINDS) pf.setType(k, structuredClone(FOLIAGE_PRESETS[k]));
  let s = 91;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  // Nothing grows inside the post's wire or on the vehicles' spot.
  const wet = (x, z) => Math.hypot(x - OASIS.x, z - OASIS.z) < OASIS.r * 1.05;
  const clear = (x, z) => Math.hypot(x - 40, z - 150) < 30 || Math.hypot(x - 22, z - 102) < 26 || Math.hypot(x - 72, z - 118) < 12 || Math.hypot(x - 150, z - 60) < 45 || wet(x, z);
  const put = (kind, x, z, scale = 1) => {
    if (clear(x, z)) return;
    pf.add(kind, x, app.getWorldHeight(x, z) - 0.05, z, { rotY: r() * 6.28, scale, seed: Math.floor(r() * 1e6) });
  };
  // A cedar stand on the NW massif.
  for (let i = 0; i < 14; i++) put("atlasCedar", -190 + (r() - 0.5) * 120, -150 + (r() - 0.5) * 110, 0.75 + r() * 0.5);
  // Holm oaks on the slope behind the post, and a pair beside it.
  for (let i = 0; i < 8; i++) put("holmOak", 70 + (r() - 0.5) * 70, 200 + (r() - 0.5) * 50, 0.8 + r() * 0.5);
  put("holmOak", 68, 150, 1); put("holmOak", 72, 162, 0.85);
  // Scrub and alfa scattered round the post and down the valley.
  for (let i = 0; i < 70; i++) put("juniperScrub", 40 + (r() - 0.5) * 150, 130 + (r() - 0.5) * 140, 0.7 + r() * 0.7);
  for (let i = 0; i < 160; i++) put("alfa", 40 + (r() - 0.5) * 160, 120 + (r() - 0.5) * 150, 0.7 + r() * 0.6);
  // THE OASIS: a grove of date palms round the pool, in clumps (a date palm
  // throws offshoots at its foot), tallest near the water; reed-mace in the
  // shallows' edge.
  for (let c = 0; c < 9; c++) {
    const a = (c / 9) * Math.PI * 2 + r() * 0.5, d = OASIS.r * (1.2 + r() * 1.0);
    const cx = OASIS.x + Math.cos(a) * d, cz = OASIS.z + Math.sin(a) * d;
    const n = 2 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) put("datePalm", cx + (r() - 0.5) * 6, cz + (r() - 0.5) * 6, (0.75 + r() * 0.45) * (d < OASIS.r * 1.6 ? 1.1 : 0.9));
  }
  for (let k = 0; k < 40; k++) {
    const a = r() * Math.PI * 2, d = OASIS.r * (1.05 + r() * 0.12);
    const x = OASIS.x + Math.cos(a) * d, z = OASIS.z + Math.sin(a) * d;
    pf.add("typha", x, app.getWorldHeight(x, z) - 0.05, z, { rotY: r() * 6.28, scale: 0.8 + r() * 0.5, seed: Math.floor(r() * 1e6) });
  }
  // Doum clumps on the slopes of the valley sides, and two Canary palms the
  // army planted at the post's gate.
  for (let i = 0; i < 45; i++) put("doumPalm", 110 + (r() - 0.5) * 220, 190 + (r() - 0.5) * 120, 0.7 + r() * 0.6);
  put("canaryPalm", 26, 126, 1); put("canaryPalm", 40, 130, 0.95);
  app.addPreRenderHook(() => {
    const d = app.environment?.getLightDirection?.();
    if (d) pf.setSunDir(d);
    pf.update(app.camera);
  });
  return pf;
}

export async function placeShowroom(app, list = SHOWROOM) {
  const placed = {};
  for (const e of list) {
    const geo = e.build();
    const f = geo.userData.footprint ?? { cx: 0, cz: 0, hx: 5, hz: 5 };
    // Pad height: the mean ground under the footprint, so the cut and the
    // fill balance instead of burying one side.
    let sum = 0, n = 0;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      sum += app.getWorldHeight(e.x + (i / 2) * f.hx, e.z + (j / 2) * f.hz); n++;
    }
    const y = sum / n;
    const c = Math.cos(e.yaw), s = Math.sin(e.yaw);
    const px = e.x + f.cx * c + f.cz * s, pz = e.z - f.cx * s + f.cz * c;
    // Buildings get a pad; a vehicle just sits on the ground where it is.
    if (!e.vehicle) await app.flattenRect(px, pz, f.hx, f.hz, y, { rim: 10, rotY: e.yaw });
    const mesh = kitView(geo);
    mesh.position.set(e.x, y, e.z);
    mesh.rotation.y = e.yaw;
    mesh.name = `showroom:${e.key}`;
    app.scene.add(mesh);
    placed[e.key] = mesh;
  }
  placed.plants = placePlants(app);
  // The post's tricolour: live cloth on its flag mount.
  const flags = [];
  for (const o of Object.values(placed)) {
    const mount = o.geometry?.userData?.flagMount;
    if (mount) flags.push(plantPostFlag(app, o, mount));
  }
  app.addPreRenderHook((dt) => { for (const f of flags) f.update(dt); });
  placed.flags = flags;
  // Rotors turning: an idling helicopter on the pad (~5 rev/s main, 25 tail).
  // Found ONCE: a per-frame getObjectByName walks every hierarchy.
  const objs = Object.values(placed).filter((o) => o.isObject3D);
  const mains = objs.map((o) => o.getObjectByName("MainRotor")).filter(Boolean);
  const tails = objs.map((o) => o.getObjectByName("TailRotor")).filter(Boolean);
  app.addPreRenderHook((dt) => {
    for (const r of mains) r.rotateY(dt * 31);
    for (const r of tails) r.rotateX(dt * 150);
  });
  return placed;
}
