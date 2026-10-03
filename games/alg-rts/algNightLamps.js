// alg-rts — THE LAMPS OF THE NIGHT: the post's gate lamps, the SAS post's courtyard, the helipad
// floodlight, lit doorways in the ksar, the dechra, the mechtas and the farmsteads, the ALN
// camp's fire and a glow in the cave mouth (2026-10-04).
//
// Engine local lights (app.localLights: tiled point lights, pooled, no shadows), placed from the
// showroom's own anchors — the post's `gate`, the mechtas' house `door`s, the villages' `houses`
// (no doors recorded there: a light ~3 m from the house's centre toward the village's middle,
// where the doorways and the street walls face). Scaled by the sky's night amount
// (app.sky.night): nothing by day.
//
// Units are Sky Pro's (moonlit ground ~0.002-0.003 linear): a 10 cd doorway lamp lights the
// wall and the ground a few metres round it; the helipad floodlight its deck.
import * as THREE from "three";
import { uniform, vec3 } from "three/tsl";
import { BloomMRTNode } from "../shared-rts/bloom.js";
import { RENDER_ORDER } from "../shared-rts/renderOrder.js";

const KIND = {
  //               colour     cd   range  height  flicker
  gateLamp:   { color: 0xffd9a0, cd: 22, range: 12, h: 3.2, flicker: 0.05 },
  courtyard:  { color: 0xffe2b8, cd: 40, range: 14, h: 4.5, flicker: 0 },
  flood:      { color: 0xf2f0ff, cd: 60, range: 18, h: 7.0, flicker: 0 },
  doorway:    { color: 0xffb46a, cd: 9,  range: 9,  h: 1.9, flicker: 0.12 },
  campfire:   { color: 0xff7a2a, cd: 30, range: 11, h: 0.7, flicker: 0.5 },
  lantern:    { color: 0xffb860, cd: 14, range: 10, h: 0,   flicker: 0.12 },
  caveGlow:   { color: 0xff9a50, cd: 7,  range: 8,  h: 1.2, flicker: 0.3 },
};

/**
 * @param {object} app  the engine app with app.showroom and app.localLights
 * @returns {{ lamps, params } | null}
 */
export function createAlgNightLamps(app) {
  const L = app.localLights, S = app.showroom;
  if (!L || !S) return null;
  const params = { enabled: true, gain: 1 };
  const lamps = [];   // { h, k }
  const _p = new THREE.Vector3();

  /** A lamp at local (x, z) of the showroom piece `obj`, `kind` above the ground. */
  function lamp(obj, x, z, kind) {
    if (!obj) return;
    obj.updateMatrixWorld(true);
    obj.localToWorld(_p.set(x, 0, z));
    const k = KIND[kind];
    const y = app.getWorldHeight(_p.x, _p.z) + k.h;
    lamps.push({ h: L.add({ position: { x: _p.x, y, z: _p.z }, color: k.color, intensity: 0, range: k.range, flicker: k.flicker, importance: 1 }), k });
  }
  /** Lit doorways: houses picked by `pick`, each lamp toward the footprint's centre. */
  function doorways(obj, pick, toward = 3) {
    const ud = obj?.geometry?.userData;
    if (!ud?.houses) return;
    const cx = ud.footprint?.cx ?? 0, cz = ud.footprint?.cz ?? 0;
    for (const hs of pick(ud.houses)) {
      if (hs.door) { lamp(obj, hs.door[0], hs.door[1], "doorway"); continue; }
      const dx = cx - hs.x, dz = cz - hs.z, d = Math.hypot(dx, dz) || 1;
      lamp(obj, hs.x + (dx / d) * toward, hs.z + (dz / d) * toward, "doorway");
    }
  }
  const every = (n) => (list) => list.filter((_, i) => i % n === 0);
  const nearest = (n, to) => (list) => {
    const c = list.find(to) ?? list[0];
    return [...list].sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z)).slice(0, n);
  };

  // ---- the French
  const gate = S.frenchPost?.geometry?.userData?.gate;
  if (gate) {
    const half = (gate.width ?? 4.4) / 2 + 0.7;
    lamp(S.frenchPost, -half, gate.z - 0.6, "gateLamp");
    lamp(S.frenchPost, half, gate.z - 0.6, "gateLamp");
  }
  const mg = S.motorPool?.geometry?.userData?.gate;
  if (mg) lamp(S.motorPool, mg.x ?? 0, (mg.z ?? 0) - 0.8, "gateLamp");
  if (S.sasPost) lamp(S.sasPost, 0, 0, "courtyard");
  const hp = S.helipad?.geometry?.userData?.footprint;
  if (hp) lamp(S.helipad, hp.cx ?? 0, hp.cz ?? 0, "flood");

  // ---- the villages: the ksar round its mosque, the dechra, the mechtas at their doors, the farms
  if (S.ksar) doorways(S.ksar, nearest(8, (h) => h.mosque));
  if (S.dechra) doorways(S.dechra, every(5));
  for (const k of ["mechta", "mechta2"]) if (S[k]) doorways(S[k], every(3));
  for (const k of Object.keys(S)) if (/^mechtaFarm/.test(k)) doorways(S[k], (l) => l.slice(0, 1));

  // ---- THE SOUK'S LANTERNS: the arcades' own lanterns (rtsAlgVillage.js arcadeRange, recorded in
  // userData.lanterns): a light each, and a warm glass that glows (blooms) at night — a box 3 cm
  // proud of the white lantern on every side (no shared faces: no z-fighting), shown only at night.
  const uGlass = uniform(0);
  let glass = null;
  const lan = S.ksar?.geometry?.userData?.lanterns;
  if (lan?.length) {
    S.ksar.updateMatrixWorld(true);
    const mat = new THREE.MeshBasicNodeMaterial({ fog: false });
    mat.name = "SoukLanternGlass";
    const warm = vec3(1.0, 0.62, 0.28);
    mat.colorNode = warm.mul(uGlass);
    mat.mrtNode = new BloomMRTNode({ emissive: warm.mul(uGlass).mul(0.6) });
    glass = new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, 0.58, 0.4), mat, lan.length);
    glass.name = "SoukLanterns";
    glass.renderOrder = RENDER_ORDER.LIGHTS ?? 0;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), ax = new THREE.Vector3(0, 1, 0);
    const kq = new THREE.Quaternion();
    S.ksar.getWorldQuaternion(kq);
    lan.forEach((l, i) => {
      S.ksar.localToWorld(_p.set(l.x, l.y, l.z));
      q.setFromAxisAngle(ax, l.yaw).premultiply(kq);
      glass.setMatrixAt(i, m4.compose(_p, q, sc));
      const k = KIND.lantern;
      lamps.push({ h: L.add({ position: { x: _p.x, y: _p.y, z: _p.z }, color: k.color, intensity: 0, range: k.range, flicker: k.flicker, importance: 1.2 }), k });
    });
    glass.visible = false;
    app.scene.add(glass);
  }

  // ---- the ALN: the camp's fire, a glow in the cave mouth
  if (S.alnCamp) lamp(S.alnCamp, 0, 0, "campfire");
  const cv = S.caveEntrance?.geometry?.userData?.footprint;
  if (cv) lamp(S.caveEntrance, cv.cx ?? 0, cv.cz ?? 0, "caveGlow");

  // ---- the night: every lamp x the night amount (written only when it moves)
  let last = -1;
  app.addPreRenderHook(function algNightLamps() {
    const n = params.enabled ? (app.sky?.night ?? 0) * params.gain : 0;
    if (Math.abs(n - last) < 0.005) return;
    last = n;
    for (const l of lamps) l.h.set({ intensity: l.k.cd * n });
    // the lanterns' glass: HDR warm (blooms) at night, hidden by day (the white lantern shows)
    if (glass) { glass.visible = n > 0.03; uGlass.value = 6 * n; }
  });

  return { lamps, params, KIND, glass };
}
