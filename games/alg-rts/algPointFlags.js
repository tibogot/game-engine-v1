// THE POINTS' FLAGS (you, 2026-10-04: "something more obvious to show we have the point — real
// flags like the one in the base"; Company of Heroes' flagpoles). Every capture point stands
// in the world:
//   VILLAGES       a flagpole on the open ground nearest the village's centre;
//   SUPPLY POINTS  a depot — fuel drums or ammunition crates (rtsAlgeria.js buildFuelDepot /
//                  buildAmmoDump) — with its flagpole beside it.
// The flag is the post's own cloth (the engine's Verlet flag, algFlag.js textures): the
// TRICOLOUR when the point leans French, the FLN's when it leans ALN, and it RISES with the
// capture — half way up at half the hold, at the top once held (CoH's flag). Neutral: a bare
// pole.
//
// CHEAP: the cloth is simulated only for flags ON SCREEN within SIM_RANGE (the others freeze
// where they are) — in play one to three move at a time; two shared textures assigned once (a
// capture never reloads or recompiles anything); the depots are two InstancedMeshes.
import * as THREE from "three";
import { createFlag } from "../../v3/props/liveProps.js";
import { buildAmmoDump, buildFuelDepot } from "../../v3/render/objects/rtsAlgeria.js";
import { drawFlnDataUrl, drawTricoloreDataUrl } from "./algFlag.js";
import { kitView } from "./showroom.js";
import { VIEW_YAW } from "./layout.js";

const P = {
  village: { pole: 7, cloth: [2.1, 1.4] },
  supply: { pole: 5, cloth: [1.6, 1.07] },
  simRange: 260,        // m from the camera: past it a flag doesn't wave
  low: 0.5,             // m: the cloth's foot at the bottom of its run
};

export function createAlgPointFlags(app, { economy, navGrid = null }) {
  const H = (x, z) => app.getWorldHeight(x, z);
  const load = (url) => { const t = new THREE.TextureLoader().load(url); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };
  const TEX = { player: load(drawTricoloreDataUrl(256)), enemy: load(drawFlnDataUrl(256)) };

  // ── The depots (one InstancedMesh a kind) ─────────────────────────────────
  const depotGeo = { fuel: buildFuelDepot(), mun: buildAmmoDump() };
  const depotAt = { fuel: [], mun: [] };
  // Fronts toward the camera at three-quarters (your rule), the flag at the depot's back corner.
  const yaw = VIEW_YAW + 0.6;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const local = (x, z, lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];

  const flags = [];
  for (const pt of economy.allPoints) {
    let fx = pt.position.x, fz = pt.position.z;
    const kind = pt.kind === "supply" ? "supply" : "village";
    if (kind === "supply") {
      const fp = depotGeo[pt.res].userData.footprint;
      depotAt[pt.res].push({ x: pt.position.x, z: pt.position.z });
      navGrid?.addFootprint?.(pt.position.x, pt.position.z, fp.hx, fp.hz, yaw);
      app.clearVegetation?.(pt.position.x, pt.position.z, Math.max(fp.hx, fp.hz) + 1, { grass: Math.max(fp.hx, fp.hz), edge: 0.7 });
      [fx, fz] = local(pt.position.x, pt.position.z, -fp.hx - 0.4, fp.hz * 0.6);
    } else {
      // The open ground nearest the village's centre (its centre is often a roof).
      const o = navGrid?.nearestOpenWorld?.(fx, fz, true);
      if (o) { fx = o.x; fz = o.z; }
    }
    const K = P[kind];
    const flag = createFlag({
      poleHeight: K.pole, poleRadius: 0.07, clothWidth: K.cloth[0], clothHeight: K.cloth[1],
      xSegs: 10, ySegs: 6, flagColor: "#ffffff", windIntensity: 300, windSpeed: 1000, windDirection: 0, showPole: true,
    });
    flag.group.position.set(fx, H(fx, fz) - 0.1, fz);
    const pole = flag.group.children[0], cloth = flag.group.children[1];
    // Both textures are the same kind of map: assigning one now builds the program once, here.
    cloth.material.map = TEX.player;
    cloth.material.needsUpdate = true;
    cloth.visible = false;
    pole.material.color.set(0x5a5650);
    app.scene.add(flag.group);
    navGrid?.addObstacle?.(fx, fz, 0.4);
    flags.push({ pt, flag, cloth, top: K.pole - K.cloth[1], side: null, sphere: new THREE.Sphere(flag.group.position.clone().setY(flag.group.position.y + K.pole / 2), K.pole) });
  }

  const meshes = [];
  for (const [res, list] of Object.entries(depotAt)) {
    if (!list.length) continue;
    const geo = depotGeo[res];
    const mesh = new THREE.InstancedMesh(geo, kitView(geo).material, list.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), one = new THREE.Vector3(1, 1, 1);
    list.forEach((p, k) => mesh.setMatrixAt(k, m4.compose(new THREE.Vector3(p.x, H(p.x, p.z) - 0.06, p.z), q, one)));
    mesh.name = `SupplyDepot:${res}`;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    app.scene.add(mesh);
    meshes.push(mesh);
  }

  // ── Every frame ───────────────────────────────────────────────────────────
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4();
  let simulated = 0;
  function frame(dt, camera) {
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    // The one wind of the post's flags and the windsock (algWind.js, showroom.js).
    const w = app.showroom?.wind;
    const windDeg = w?.dirDeg ?? 200, windK = w?.strength ?? 0.55;
    simulated = 0;
    for (const f of flags) {
      // Whose, and how far up: the influence over the hold (CoH: the flag tops out when held).
      const v = f.pt.value ?? 0, hold = economy.params.hold;
      const up = Math.min(1, Math.abs(v) / hold);
      const side = Math.abs(v) < 0.02 ? null : v > 0 ? "player" : "enemy";
      if (side !== f.side) {
        f.side = side;
        f.cloth.visible = !!side;
        if (side) f.cloth.material.map = TEX[side];
      }
      if (!side) continue;
      f.cloth.position.y = P.low + (f.top - P.low) * up;
      if (camera.position.distanceTo(f.sphere.center) > P.simRange || !frustum.intersectsSphere(f.sphere)) continue;
      f.flag.setParam("windDirection", windDeg);
      f.flag.setParam("windIntensity", 40 + 520 * windK);
      f.flag.update(Math.min(dt, 1 / 30));
      simulated++;
    }
  }

  return {
    params: P, flags, meshes, frame,
    get simulated() { return simulated; },
    stats: { flags: flags.length, depots: depotAt.fuel.length + depotAt.mun.length },
    dispose() { for (const f of flags) { app.scene.remove(f.flag.group); f.flag.dispose(); } for (const m of meshes) app.scene.remove(m); },
  };
}
