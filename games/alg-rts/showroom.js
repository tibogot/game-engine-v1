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
import { LAYOUT } from "./layout.js";

const BASE = LAYOUT.sites.find((s) => s.kind === "french");
const HAMLETS = LAYOUT.sites.filter((s) => s.kind === "hamlet");

/**
 * The post's vehicle park and helipad, in the POST'S frame: `lx` to its
 * right, `lz` forward (out of the gate, which faces the post's local -Z),
 * `yaw` relative to the post. They follow the post wherever the layout puts it.
 */
export const BASE_PARK = [
  { key: "ebr", build: buildEBR, lx: -8, lz: 44, yaw: 0.5 },
  { key: "willys", build: buildWillys, lx: 3, lz: 48, yaw: -0.3 },
  { key: "gmc", build: buildGMC, lx: -24, lz: 34, yaw: 1.2 },
  { key: "amx13", build: buildAMX13, lx: -24, lz: 54, yaw: 0.4 },
  { key: "halftrack", build: buildHalfTrack, lx: 16, lz: 58, yaw: -0.2 },
  { key: "alouette", build: buildAlouette, lx: 36, lz: 26, yaw: 2.0 },
];

/** Post-local → world (the post's local -Z is its gate). */
function fromBase(lx, lz) {
  const c = Math.cos(BASE.yaw), s = Math.sin(BASE.yaw);
  // Local +X → world (cos, -sin); local -Z (forward) → world (-sin, -cos).
  return [BASE.x + lx * c - lz * s, BASE.z - lx * s - lz * c];
}

/** What to show, and where (world x/z, yaw). */
export const SHOWROOM = [
  { key: "frenchPost", build: buildFrenchPost, x: BASE.x, z: BASE.z, yaw: BASE.yaw },
  ...BASE_PARK.map((v) => { const [x, z] = fromBase(v.lx, v.lz); return { key: v.key, build: v.build, x, z, yaw: BASE.yaw + v.yaw, vehicle: true }; }),
  // The two hamlets (layout.js), each its own houses.
  { key: "mechta", build: buildMechta, x: HAMLETS[0].x, z: HAMLETS[0].z, yaw: 0.9 },
  { key: "mechta2", build: () => buildMechta({ seed: 1957, count: 7 }), x: HAMLETS[1].x, z: HAMLETS[1].z, yaw: -0.4 },
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
 * The vegetation lives IN THE MAP now (tools/algVegetation.mjs: species in its
 * plant slots, density in its paint), so the editor shows and edits it. The
 * only plants placed here are the ones a PLACE puts down by hand: the two
 * Canary palms the army planted at the post's gate.
 */
function placePlants(app) {
  const pf = new PlacedFoliage({ scene: app.scene });
  pf.setType("canaryPalm", structuredClone(FOLIAGE_PRESETS.canaryPalm));
  // Either side of the gate, a few metres out (post-local).
  for (const [lx, lz, scale, seed] of [[-7, 22, 1, 17], [7, 22, 0.95, 29]]) {
    const [x, z] = fromBase(lx, lz);
    pf.add("canaryPalm", x, app.getWorldHeight(x, z) - 0.05, z, { rotY: seed, scale, seed });
  }
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
