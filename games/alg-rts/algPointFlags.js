// THE POINTS' FLAGS (you, 2026-10-04: "something more obvious to show we have the point — real
// flags like the one in the base"; Company of Heroes' flagpoles). Every capture point stands
// in the world:
//   VILLAGES       a flagpole on the open ground nearest the village's centre;
//   SUPPLY POINTS  a MAST at the point's centre (algPointMast.js: guyed steel, 9 m — CoH 3's,
//                  2026-10-12) and the depot beside it — fuel drums or ammunition crates
//                  (rtsAlgeria.js buildFuelDepot / buildAmmoDump); their rings: algPointRings.js.
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
import { buildPointMast, pointMastMaterial } from "./algPointMast.js";
import { createHouseField, loadHouses, registerHouseParts } from "./algHouse.js";
import { loadSandbagWall, simulatedWallMesh } from "./algSandbags.js";

/**
 * THE POINT'S SANDBAGS (2026-10-20, you: "the sandbags don't look at all like the ones I created in Blender"):
 * not in the Blender point — YOUR simulated walls (algSandbags.js, tools/blender/sandbagWall.py), their own
 * material: the straight single-thickness "chicane" (4.8 m) behind the depot, BREACHED once the point is damaged.
 * In the point's own frame (the depot on +x, at supplyPoint.py's DX): [part, x, z, yaw].
 */
const DEPOT_X = { fuel: 4.5, mun: 4.8 };
export function pointWalls(kind, state) {
  return [[state === "intact" ? "sbChicane" : "sbBreach", DEPOT_X[kind] - 2.05, 0.05, Math.PI / 2]];
}
/** Load the simulated walls and make them house-field parts (sbChicane, sbBreach). Resolves false if missing. */
export function loadPointWalls() {
  return loadSandbagWall().then(() => {
    let ok = false;
    for (const [type, kind] of [["sbChicane", "chicane"], ["sbBreach", "breach"]]) {
      const m = simulatedWallMesh(type, kind);
      if (!m) continue;
      registerHouseParts(type, "intact", m.isLOD ? m.levels[0].object : m, m.isLOD ? m.levels[1].object : m);
      ok = true;
    }
    return ok;
  });
}
import { VIEW_YAW } from "./layout.js";

const P = {
  village: { pole: 7, cloth: [2.1, 1.4] },
  // A supply point: the MAST (algPointMast.js, 2026-10-12 — CoH 3's, at the point's centre; the thin
  // 5 m pole "read as an antenna"): the flag runs up to just under its knob.
  supply: { pole: 8.85, cloth: [1.6, 1.07], mast: 9 },
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
  const mastAt = [];   // the supply points' masts (one InstancedMesh, below)
  // Fronts toward the camera at three-quarters (your rule), the flag at the depot's back corner.
  const yaw = VIEW_YAW + 0.6;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const local = (x, z, lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];

  const flags = [];
  for (const pt of economy.allPoints) {
    let fx = pt.position.x, fz = pt.position.z;
    const kind = pt.kind === "supply" ? "supply" : "village";
    if (kind === "supply") {
      // THE MAST AT THE CENTRE (CoH 3's), the depot beside it — on the mast's local +x, the side
      // its guy wires leave free (2026-10-12; the flag stood beside the depot before).
      const fp = depotGeo[pt.res].userData.footprint;
      const [dx, dz] = local(pt.position.x, pt.position.z, fp.hx + 2.6, 0);
      depotAt[pt.res].push({ x: dx, z: dz });
      navGrid?.addFootprint?.(dx, dz, fp.hx, fp.hz, yaw);
      app.clearVegetation?.(dx, dz, Math.max(fp.hx, fp.hz) + 1, { grass: Math.max(fp.hx, fp.hz), edge: 0.7 });
      app.clearVegetation?.(pt.position.x, pt.position.z, 4.2, { grass: 2.5, edge: 0.7 });   // the mast and its guys
      mastAt.push({ x: pt.position.x, z: pt.position.z });
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
    if (kind === "supply") pole.visible = false;   // (the mast is the pole there)
    app.scene.add(flag.group);
    navGrid?.addObstacle?.(fx, fz, 0.4);
    flags.push({ pt, flag, cloth, top: K.pole - K.cloth[1], side: null, sphere: new THREE.Sphere(flag.group.position.clone().setY(flag.group.position.y + K.pole / 2), K.pole) });
  }

  // THE OLD DEPOTS AND MASTS — only if the Blender point (below) does not load. (2026-10-21, you: "the old and the
  // new overlapping": they were built at once and removed when the new one loaded — but algGame's STATIC BATCH
  // had copied the depots into its indirect draw by then; removing the originals left the copies standing.)
  const meshes = [];
  const buildOld = () => {
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
  // THE MASTS: every supply point's in one draw, turned as its depot (its guy wires away from it).
  if (mastAt.length) {
    const mast = buildPointMast({ height: P.supply.mast, guyR: P.supply.mast * 0.4, away: Math.PI });
    const mesh = new THREE.InstancedMesh(mast.geometry, pointMastMaterial(), mastAt.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), one = new THREE.Vector3(1, 1, 1);
    mastAt.forEach((p, k) => mesh.setMatrixAt(k, m4.compose(new THREE.Vector3(p.x, H(p.x, p.z) - 0.05, p.z), q, one)));
    mesh.name = "SupplyMasts";
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    app.scene.add(mesh);
    meshes.push(mesh);
  }
  };

  // THE BLENDER POINT (tools/blender/supplyPoint.py, 2026-10-20 — you: "the requisition point doesn't look AAA
  // at all"): the mast and its depot as ONE piece, the cloth-simulated sandbags, three states — an instanced
  // field (near / far). The old masts and depots above are built only if it is missing. `ready` resolves once
  // the points stand (algGame awaits it before the static batch).
  const pointField = { field: null, ready: null };
  const supplyPts = economy.allPoints.filter((p) => p.kind === "supply");
  if (supplyPts.length) {
    pointField.ready = Promise.all([loadHouses("points"), loadPointWalls()]).then(async ([parts]) => {
      if (!parts?.["fuel:intact"]) { buildOld(); return; }
      // ITS PAD (2026-10-21, you: "it's going inside the ground — are you not flattening it?"): the point is one
      // rigid piece ~11 m across (the guys' anchors to the board), seated at its mast's height it sank into the
      // slope on one side. The ground under it levelled first — the mean height under the rect (the cut and the
      // fill balance, as the showroom's pads), a 6 m rim — then the point and its flag seated on it.
      const PAD = { lx: 1.6, hx: 5.6, hz: 3.6, rim: 6 };
      for (const pt of supplyPts) {
        const px = pt.position.x, pz = pt.position.z;
        let sum = 0, n = 0;
        for (let u = -1; u <= 1.001; u += 0.25) for (let v = -1; v <= 1.001; v += 0.25) {
          const [x, z] = local(px, pz, PAD.lx + u * PAD.hx, v * PAD.hz);
          sum += H(x, z); n++;
        }
        const [cx, cz] = local(px, pz, PAD.lx, 0);
        await app.flattenRect?.(cx, cz, PAD.hx + 1, PAD.hz + 1, sum / n, { rim: PAD.rim, rotY: yaw });
      }
      for (const fl of flags) {   // (the flags were stood on the ground before it was levelled)
        if (fl.pt.kind !== "supply") continue;
        const g = fl.flag.group.position;
        g.y = H(g.x, g.z) - 0.1;
        fl.sphere.center.y = g.y + P.supply.pole / 2;
      }
      app.fogOfWar?.rebuildHeights?.();
      const f = createHouseField();
      for (const pt of supplyPts) {
        const kind = pt.res === "fuel" ? "fuel" : "mun", px = pt.position.x, pz = pt.position.z;
        f.add(kind, "intact", px, H(px, pz) - 0.05, pz, yaw, 1);
        for (const [part, lx, lz, ly] of pointWalls(kind, "intact")) {
          const [wx, wz] = local(px, pz, lx, lz);
          f.add(part, "intact", wx, H(wx, wz) - 0.03, wz, yaw + ly, 1);
        }
      }
      app.scene.add(f.root);
      app.addPreRenderHook?.(() => f.update(app.camera));
      pointField.field = f;
    }).catch((e) => { console.warn("[points] the Blender point did not load:", e); buildOld(); });
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
    pointField,   // (the Blender points: .field once loaded)
    params: P, flags, meshes, frame,
    get simulated() { return simulated; },
    stats: { flags: flags.length, depots: depotAt.fuel.length + depotAt.mun.length },
    dispose() { for (const f of flags) { app.scene.remove(f.flag.group); f.flag.dispose(); } for (const m of meshes) app.scene.remove(m); },
  };
}
