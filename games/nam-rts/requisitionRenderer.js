// Requisition point RENDERER — the masts, the flags and the zones.
//
//   · masts: the kit's relay mast (rtsBuildables), one InstancedMesh — every
//     point on the map is one draw, and one more for the red lights at the heads
//   · flags: the US flag and the NLF's (red over blue, the yellow star) as
//     REAL CLOTH — the engine's Verlet flag, like the HQ's (your ask,
//     2026-09-26). A flag CLIMBS its pole as a side captures — theirs slides
//     down to the foot first, then yours goes up: the capture bar is on the
//     map, where you are looking, not in a panel. Only a flag that is up, on
//     screen and within 300 m is simulated.
//   · zones: a thin draped ring round each point, neutral khaki, yours blue,
//     theirs red; it pulses while the point is being taken or is contested
import * as THREE from "three";
import { makeBloomMaterial, BLOOM } from "./bloom.js";
import { drawUsFlagDataUrl } from "./baseFlag.js";
import { createFlag } from "../../v3/props/liveProps.js";
import { createSelectionRingField } from "./selectionRingField.js";
import { rtsObjectMaterial } from "../../v3/render/objects/rtsObjectProps.js";
import { buildRequisitionMast } from "../../v3/render/objects/rtsBuildables.js";

const FLAG_W = 3.0, FLAG_H = FLAG_W / 1.9 * 1.0;
const TINT = { neutral: 0xd8cfae, player: 0x6ab0ff, enemy: 0xff6a5a };

/** The National Liberation Front's flag: red over blue, a yellow star. */
export function drawNlfFlag(h = 256) {
  const w = Math.round(h * 1.5);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#c8102e"; g.fillRect(0, 0, w, h / 2);
  g.fillStyle = "#0f6fc6"; g.fillRect(0, h / 2, w, h / 2);
  g.fillStyle = "#ffcd00";
  g.beginPath();
  const cx = w / 2, cy = h / 2, R = h * 0.3;
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5, r = k % 2 === 0 ? R : R * 0.382;
    g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  g.closePath(); g.fill();
  return c;
}

/** One cloth flag, no pole of its own (it flies from the mast's): its group's
 *  origin is the foot of the hoist, the cloth's top edge FLAG_H above it. */
function clothFlag(scene, textureUrl) {
  const f = createFlag({
    poleHeight: FLAG_H, poleRadius: 0.05, clothWidth: FLAG_W, clothHeight: FLAG_H,
    xSegs: 10, ySegs: 6, flagColor: "#ffffff",
    windIntensity: 260, windSpeed: 1000, windDirection: 0, showPole: false,
  });
  f.setParam("textureUrl", textureUrl);
  f.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  f.group.visible = false;
  scene.add(f.group);
  return f;
}

export function createRequisitionRenderer({ app, requisition, fogOfWar = null }) {
  const { scene } = app;
  const max = Math.max(1, requisition.points.length);
  const mastGeo = buildRequisitionMast();
  const pole = mastGeo.userData.pole;
  const [lx, ly, lz] = mastGeo.userData.light;

  const masts = new THREE.InstancedMesh(mastGeo, rtsObjectMaterial(), max);
  masts.castShadow = masts.receiveShadow = true;
  const lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.28, 10, 6),
    makeBloomMaterial({ color: 0xff3a2a, blending: THREE.NormalBlending, depthWrite: true, transparent: false }, BLOOM.beacon), max);
  for (const m of [masts, lights]) { m.frustumCulled = false; m.count = 0; scene.add(m); }
  // Two cloths per point, ours and theirs; only the one the capture leans to flies.
  const usUrl = drawUsFlagDataUrl(256), nlfUrl = drawNlfFlag(256).toDataURL("image/png");
  const cloths = requisition.points.map(() => ({ player: clothFlag(scene, usUrl), enemy: clothFlag(scene, nlfUrl) }));
  const frustum = new THREE.Frustum(), _pv = new THREE.Matrix4(), _sph = new THREE.Sphere(new THREE.Vector3(), 4);

  const zones = createSelectionRingField({ app, max: 32, inner: 0.965, segments: 96, opacity: 0.75 });

  const _m = new THREE.Matrix4();
  const _c = new THREE.Color();
  let t = 0;

  // The masts never move: written once (and again after a world reload).
  function placeMasts() {
    requisition.points.forEach((p, i) => {
      _m.makeTranslation(p.position.x, p.position.y, p.position.z);
      masts.setMatrixAt(i, _m);
      _m.makeTranslation(p.position.x + lx, p.position.y + ly, p.position.z + lz);
      lights.setMatrixAt(i, _m);
    });
    masts.count = lights.count = requisition.points.length;
    masts.instanceMatrix.needsUpdate = lights.instanceMatrix.needsUpdate = true;
  }
  placeMasts();

  function sync(dt) {
    t += dt;
    const cam = app.camera;
    _pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(_pv);
    zones.begin();
    requisition.points.forEach((p, i) => {
      // The flag: whichever side the capture leans to, at the height it has got to.
      const a = Math.abs(p.progress);
      const side = p.progress > 0 ? "player" : "enemy";
      for (const k of ["player", "enemy"]) {
        const f = cloths[i]?.[k];
        if (!f) continue;
        const up = a > 0.001 && k === side;
        f.group.visible = up;
        if (!up) continue;
        const y = p.position.y + pole.bottom + (pole.top - pole.bottom - FLAG_H) * a;
        f.group.position.set(p.position.x + pole.x, y, p.position.z + pole.z);
        // The cloth only moves where somebody can see it move.
        _sph.center.set(f.group.position.x + FLAG_W / 2, y + FLAG_H / 2, f.group.position.z);
        if (frustum.intersectsSphere(_sph) && cam.position.distanceTo(_sph.center) < 300) f.update(Math.min(dt, 1 / 30));
      }
      // The zone: the owner's colour, pulsing while it is being fought over.
      const seen = !fogOfWar?.enabled || fogOfWar.isExplored?.(p.position.x, p.position.z);
      if (!seen) return;
      _c.set(TINT[p.owner ?? "neutral"]);
      if (p.contested || p.capturing) {
        const k = 0.6 + 0.4 * Math.sin(t * (p.contested ? 9 : 5));
        _c.lerp(new THREE.Color(p.contested ? 0xffffff : TINT[p.capturing > 0 ? "player" : "enemy"]), 1 - k);
      }
      zones.add(p.position.x, p.position.z, p.radius, _c.getHex());
    });
    zones.commit();
    // The head lights blink slowly, as aviation lights do.
    lights.visible = Math.sin(t * 2.2) > -0.3;
  }

  return { sync, placeMasts };
}
