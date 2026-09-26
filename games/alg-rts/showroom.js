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
import { buildAlnCamp } from "../../v3/render/objects/rtsAlnCamp.js";
import { buildAmbushScreen, buildArmsCache, buildBarbedWire, buildCaveEntrance, buildFrSandbagWall, buildHelipad, buildMgNest, buildMineMarker, buildMirador, buildMortarPit, buildMotorPool, buildSangar, buildSasPost, buildSearchlightTower } from "../../v3/render/objects/rtsAlgeria.js";
import { PlacedFoliage } from "../../v3/render/foliage/placedFoliage.js";
import { drawFlnDataUrl, plantPostFlag } from "./algFlag.js";
import { FOLIAGE_PRESETS } from "../../v3/app/state/foliageScatterState.js";
import { LAYOUT, siteYaw } from "./layout.js";

// Fronts toward the player's camera at three-quarters (layout.js siteYaw).
const BASE = { ...LAYOUT.sites.find((s) => s.kind === "french") };
BASE.yaw = siteYaw(BASE);
const ALN = LAYOUT.sites.find((s) => s.kind === "aln");
const HAMLETS = LAYOUT.sites.filter((s) => s.kind === "hamlet");

/**
 * The post's vehicle park and helipad, in the POST'S frame: `lx` to its
 * right, `lz` forward (out of the gate — the post's local -Z, which faces
 * the CAMERA), `yaw` relative to the post. On the post's FLANKS: straight
 * out of the gate is toward the camera, and on this map that is the edge.
 * They follow the post wherever the layout puts it.
 */
export const BASE_PARK = [
  { key: "ebr", build: buildEBR, lx: -42, lz: 10, yaw: 0.3 },
  { key: "amx13", build: buildAMX13, lx: -48, lz: -8, yaw: 0.2 },
  { key: "halftrack", build: buildHalfTrack, lx: -54, lz: 22, yaw: -0.2 },
  { key: "gmc", build: buildGMC, lx: -32, lz: 30, yaw: 1.4 },
  { key: "willys", build: buildWillys, lx: -14, lz: 28, yaw: -0.4 },
  // On the helipad's deck (placeShowroom: `on`).
  { key: "alouette", build: buildAlouette, lx: 56, lz: 2, yaw: 0.6, on: "helipad" },
];

/**
 * Buildables the player would place round the post (rtsAlgeria.js), shown
 * here until the build system places them. Post frame, like BASE_PARK.
 * `yaw` relative to the post, kept small: fronts stay three-quarters to
 * the camera like everything else.
 */
export const BASE_BUILDABLES = [
  // Clear of the vehicle park (which is on the post's right, lx < -30).
  // `follow`: a run of bags or wire lies ON the slope (tilted to it), the way
  // real ones are laid — no pad. Pads are for things with a floor.
  // A pad (+1.5 m margin, +4 m rim) must stay clear of the post's pad
  // (half-size 22 × 24 + 1.5): a rim cut into it left the post's wire floating.
  { key: "mirador", build: buildMirador, lx: 34, lz: 22, yaw: 0.25 },
  { key: "mgNest", build: buildMgNest, lx: -14, lz: 40, yaw: -0.2 },
  // Out in front, over the wire: the searchlight sweeps the approach.
  { key: "searchlight", build: buildSearchlightTower, lx: 26, lz: 46, yaw: 0.2 },
  // The post's left flank: the pad, the mortars behind the mirador.
  { key: "helipad", build: buildHelipad, lx: 56, lz: 2, yaw: 0 },
  { key: "mortarPit", build: buildMortarPit, lx: 36, lz: -24, yaw: 0.1 },
  // Behind the vehicle park, toward the valley.
  { key: "motorPool", build: buildMotorPool, lx: -48, lz: -30, yaw: 0 },
  { key: "sandbags1", build: buildFrSandbagWall, lx: 8, lz: 30, yaw: 0.1, follow: true },
  { key: "sandbags2", build: () => buildFrSandbagWall({ seed: 7 }), lx: 2, lz: 31, yaw: -0.15, follow: true },
  { key: "wire1", build: buildBarbedWire, lx: -2, lz: 38, yaw: 0, follow: true },
  { key: "wire2", build: () => buildBarbedWire({ seed: 21 }), lx: 10, lz: 37.5, yaw: 0.12, follow: true },
];

/** Post-local → world (the post's local -Z is its gate). */
function fromBase(lx, lz, site = BASE) {
  const c = Math.cos(site.yaw), s = Math.sin(site.yaw);
  // Local +X → world (cos, -sin); local -Z (forward) → world (-sin, -cos).
  return [site.x + lx * c - lz * s, site.z - lx * s - lz * c];
}

const ALN_SITE = { ...ALN, yaw: siteYaw(ALN) };

/**
 * The SAS post goes BESIDE a hamlet, not at the French base: it is the
 * French side's lever on that hamlet's support. Hamlet frame; the spot
 * MEASURED gentle (height spread ~1 m over its yard) and clear of the
 * hamlet's pad and rim.
 */
const HAMLET_SITE = { ...HAMLETS[0], yaw: siteYaw(HAMLETS[0]) };
export const SAS_POST = { key: "sasPost", build: buildSasPost, lx: 66, lz: 25, yaw: -0.15 };

/**
 * The ALN's buildables round its camp, in the CAMP'S frame (like BASE_PARK).
 * Pads clear of the camp's (half 28.6 × 26 m + 1.5 + a 10 m rim); the small
 * pieces follow the slope — the ALN builds on rough ground, it never levels.
 * Spots MEASURED (height spread over each footprint): the camp is a hilltop and
 * its front falls away steeply; the right flank and the back-left are gentle.
 */
export const ALN_BUILDABLES = [
  { key: "caveEntrance", build: buildCaveEntrance, lx: 58, lz: 4, yaw: -0.2 },
  { key: "armsCache", build: buildArmsCache, lx: -66, lz: -22, yaw: 0.25 },
  { key: "sangar", build: buildSangar, lx: 50, lz: 30, yaw: 0.15, follow: true },
  { key: "ambushScreen", build: buildAmbushScreen, lx: 56, lz: 46, yaw: -0.1, follow: true },
  { key: "mineMarker", build: buildMineMarker, lx: 60, lz: 60, yaw: 0.4, follow: true },
];

/** What to show, and where (world x/z, yaw). */
export const SHOWROOM = [
  { key: "frenchPost", build: buildFrenchPost, x: BASE.x, z: BASE.z, yaw: BASE.yaw },
  ...BASE_BUILDABLES.map((v) => { const [x, z] = fromBase(v.lx, v.lz); return { key: v.key, build: v.build, x, z, yaw: BASE.yaw + v.yaw, follow: v.follow, rim: 4 }; }),
  ...BASE_PARK.map((v) => { const [x, z] = fromBase(v.lx, v.lz); return { key: v.key, build: v.build, x, z, yaw: BASE.yaw + v.yaw, vehicle: true, on: v.on }; }),
  // The two hamlets (layout.js), each its own houses.
  { key: "mechta", build: buildMechta, x: HAMLETS[0].x, z: HAMLETS[0].z, yaw: siteYaw(HAMLETS[0]) },
  { key: "mechta2", build: () => buildMechta({ seed: 1957, count: 7 }), x: HAMLETS[1].x, z: HAMLETS[1].z, yaw: siteYaw(HAMLETS[1]) },
  (() => { const [x, z] = fromBase(SAS_POST.lx, SAS_POST.lz, HAMLET_SITE); return { key: SAS_POST.key, build: SAS_POST.build, x, z, yaw: HAMLET_SITE.yaw + SAS_POST.yaw, rim: 6 }; })(),
  // The ALN command post in the massif.
  { key: "alnCamp", build: buildAlnCamp, x: ALN.x, z: ALN.z, yaw: siteYaw(ALN), flag: "fln" },
  ...ALN_BUILDABLES.map((v) => { const [x, z] = fromBase(v.lx, v.lz, ALN_SITE); return { key: v.key, build: v.build, x, z, yaw: ALN_SITE.yaw + v.yaw, follow: v.follow, rim: 4 }; }),
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
  // An emplacement's gun (MG nest): its own mesh on its pivot, to traverse.
  if (geo.userData.gun) {
    const gm = new THREE.Mesh(geo.userData.gun.geo, rtsObjectMaterialTinted(FR_PAINT_TINT));
    gm.name = "Gun";
    gm.position.set(...geo.userData.gun.pivot);
    gm.castShadow = true;
    m.add(gm);
  }
  // A searchlight's lamp: its own mesh on the yoke, to sweep.
  if (geo.userData.lamp) {
    const lm = new THREE.Mesh(geo.userData.lamp.geo, rtsObjectMaterialTinted(FR_PAINT_TINT));
    lm.name = "Lamp";
    lm.position.set(...geo.userData.lamp.pivot);
    lm.castShadow = true;
    m.add(lm);
  }
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
  // Footprint-local → world, for an entry turned by its yaw.
  const toWorld = (e, lx, lz) => {
    const c = Math.cos(e.yaw), s = Math.sin(e.yaw);
    return [e.x + lx * c + lz * s, e.z - lx * s + lz * c];
  };
  // Ground under a footprint, a 5×5 grid of [lx, lz, h].
  const sampleGround = (e, f) => {
    const out = [];
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const lx = f.cx + (i / 2) * f.hx, lz = f.cz + (j / 2) * f.hz;
      out.push([lx, lz, app.getWorldHeight(...toWorld(e, lx, lz))]);
    }
    return out;
  };

  // 1) EVERY PAD FIRST. A pad's rim reshapes the ground round it, so a pad
  // cut after a piece was seated left that piece floating (measured: bags
  // 1.1 m, the post's front 0.7 m). Pads in list order — the post first — and
  // the small buildables' rims short so they don't reach into its pad.
  const built = list.map((e) => ({ e, geo: e.build() }));
  for (const b of built) {
    const { e, geo } = b;
    if (e.vehicle || e.follow) continue;
    const f = geo.userData.footprint ?? { cx: 0, cz: 0, hx: 5, hz: 5 };
    // Pad height: the mean ground under the footprint, so the cut and the
    // fill balance instead of burying one side.
    const g = sampleGround(e, f);
    b.y = g.reduce((a, p) => a + p[2], 0) / g.length;
    const [px, pz] = toWorld(e, f.cx, f.cz);
    // +1.5 m: the terrain grid cell that straddles the pad's edge already
    // slopes, and a post's perimeter wire sits 0.7 m inside it (measured
    // floating 0.1-0.25 m without the margin).
    await app.flattenRect(px, pz, f.hx + 1.5, f.hz + 1.5, b.y, { rim: e.rim ?? 10, rotY: e.yaw });
  }

  // 2) THEN SEAT, on the ground as it ended up. Pads sit at their pad height.
  // Vehicles and `follow` pieces lie on the slope: a plane fitted to the
  // ground under them gives the tilt, and the lowest corner decides the
  // height so nothing floats (the uphill side sinks a few cm instead).
  const up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), qYaw = new THREE.Quaternion();
  for (const { e, geo, y } of built) {
    const mesh = kitView(geo);
    mesh.name = `showroom:${e.key}`;
    const deck = e.on && placed[e.on];
    if (deck) {
      // Standing on another piece's deck (a helicopter on its pad).
      mesh.position.set(e.x, deck.position.y + (deck.geometry.userData.deckY ?? 0), e.z);
      mesh.rotation.y = e.yaw;
    } else if (y !== undefined) {
      mesh.position.set(e.x, y, e.z);
      mesh.rotation.y = e.yaw;
    } else {
      const f = geo.userData.footprint ?? { cx: 0, cz: 0, hx: 2, hz: 2 };
      const g = sampleGround(e, f);
      // Least-squares plane h = a + b·lx + c·lz (the grid is symmetric about
      // the footprint centre, so the terms separate).
      let sh = 0, sx = 0, sz = 0, sxx = 0, szz = 0;
      for (const [lx, lz, h] of g) {
        const dx = lx - f.cx, dz = lz - f.cz;
        sh += h; sx += dx * h; sz += dz * h; sxx += dx * dx; szz += dz * dz;
      }
      const a = sh / g.length, bx = sx / sxx, bz = sz / szz;
      // How far the ground dips below the plane anywhere under the footprint.
      let dip = 0;
      for (const [lx, lz, h] of g) dip = Math.max(dip, a + bx * (lx - f.cx) + bz * (lz - f.cz) - h);
      // Plane height at the mesh origin (local 0,0), dropped by the dip.
      const y0 = a - bx * f.cx - bz * f.cz - dip;
      // Local-frame normal of the plane, turned into the world by the yaw.
      n.set(-bx, 1, -bz).normalize();
      qYaw.setFromAxisAngle(up, e.yaw);
      n.applyQuaternion(qYaw);
      mesh.quaternion.setFromUnitVectors(up, n).multiply(qYaw);
      mesh.position.set(e.x, y0, e.z);
    }
    app.scene.add(mesh);
    placed[e.key] = mesh;
  }
  placed.plants = placePlants(app);
  // The post's tricolour: live cloth on its flag mount.
  const flags = [];
  for (const e of list) {
    const o = placed[e.key];
    const mount = o?.geometry?.userData?.flagMount;
    if (mount) flags.push(e.flag === "fln" ? plantPostFlag(app, o, mount, drawFlnDataUrl()) : plantPostFlag(app, o, mount));
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
