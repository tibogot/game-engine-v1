// THUNDERLINE'S EXHAUST (user, 2026-10-29: the AAA look — "did we do the gas smoke?"; the game had none). It follows
// the ENGINE the player hears (engineModel.js), so what you see and what you hear agree:
//   - HAZE: thin puffs from the twin tips under load, more with the revs;
//   - A PUFF AT EVERY SHIFT (the drive is cut for a moment, the mixture runs rich);
//   - POPS: lift off at high revs (the model's `pop`, the sound's crackle) → short FLAMES out of the tips, into the
//     bloom, each with a darker puff.
// The smoke is the tyre smoke's own renderer (tyreSmoke.emit: the same lit puffs, the same draw); the flames are
// two crossed glowing planes per tip, unlit, additive.
import * as THREE from "three";
import { Fn, float, mix, pow, saturate, smoothstep, uniform, uv, vec3, vec4, abs, sin } from "three/tsl";
import { applyBloomMRT } from "../../../../v3/render/bloomMRT.js";

export const EXHAUST = {
  haze: { rate: [1.5, 14], size: 0.9, life: 0.9, opacity: [0.04, 0.14], grow: 1.2, speed: 4 }, // puffs/s idle → full load at the redline
  shift: { size: 1.3, life: 1.1, opacity: 0.3, grow: 1.4, speed: 6, flame: 0.045 }, // a puff (and a lick of flame) per tip
  pop: { min: 0.15, chance: 16, flash: [0.05, 0.11], size: 1.2, life: 1.0, opacity: 0.32, grow: 1.3, speed: 5 }, // flashes/s at full pop
  flame: { length: 1.25, width: 0.36, glow: 6 },
};

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _back = new THREE.Vector3(), _up = new THREE.Vector3(), _g = new THREE.Vector3();

/**
 * @param app  the v3 app
 * @param tyreSmoke  createTyreSmoke(app)'s handle (its emit())
 */
export function createExhaust(app, tyreSmoke) {
  const S = EXHAUST;
  // ---- the flames: per tip, two crossed planes along the car's −Z (the length on the planes' x)
  const uFlame = uniform(0), uSeed = uniform(0);
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
  mat.name = "ExhaustFlame";
  const shade = Fn(() => {
    const x = uv().x, y = abs(uv().y.sub(0.5)).mul(2); // x 0 at the tip → 1 at the flame's end; y across
    const ragged = sin(x.mul(23).add(uSeed.mul(40))).mul(0.12).add(1); // a flickering edge
    const body = pow(saturate(float(1).sub(x)), float(1.6)).mul(pow(saturate(float(1).sub(y.mul(ragged).mul(float(1).add(x)))), float(2)));
    const col = mix(vec3(1.1, 1.0, 1.6), vec3(2.8, 1.05, 0.22), smoothstep(float(0.02), float(0.22), x)); // a short blue-white core at the tip, then orange flame
    const a = body.mul(uFlame);
    return vec4(col.mul(a), a);
  })();
  mat.colorNode = shade.xyz;
  mat.opacityNode = shade.w;
  applyBloomMRT(mat, shade.xyz.mul(S.flame.glow));
  const plane = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0); // (its x 0..1: the tip at the origin)
  const flames = [], group = new THREE.Group();
  group.name = "ExhaustFlames";
  for (let i = 0; i < 2; i++) {
    const g = new THREE.Group();
    const a = new THREE.Mesh(plane, mat), b = new THREE.Mesh(plane, mat);
    b.rotation.x = Math.PI / 2;
    g.add(a, b);
    // the plane's +x along the car's −Z (backwards)
    g.rotation.y = Math.PI / 2;
    const holder = new THREE.Group();
    holder.add(g);
    holder.matrixAutoUpdate = false;
    group.add(holder);
    flames.push({ holder, g });
  }
  for (const m of group.children) m.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.renderOrder = 18; o.castShadow = o.receiveShadow = false; } });
  group.visible = false;
  app.scene.add(group);

  // ---- the tips, in the body's frame: found once from the car model (as the FX lab: twin tips near the middle)
  let tips = null;
  function findTips(vehicle) {
    const root = vehicle._chassisGlb;
    if (!root) return null;
    vehicle.group.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().compose(vehicle.renderPos ?? vehicle.body.pos, vehicle.body.quat, new THREE.Vector3(1, 1, 1)).invert();
    const box = new THREE.Box3(), b = new THREE.Box3();
    root.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || !o.visible || !o.geometry || o.material?.name === "ShadowProxy") return;
      o.geometry.computeBoundingBox();
      b.copy(o.geometry.boundingBox).applyMatrix4(inv.clone().multiply(o.matrixWorld));
      if (b.min.length() < 6 && b.max.length() < 6) box.union(b);
    });
    if (!Number.isFinite(box.min.z)) return null;
    const side = 0.1 * (box.max.x - box.min.x), up = box.min.y + 0.22, back = box.min.z - 0.05;
    return [new THREE.Vector3(-side, up, back), new THREE.Vector3(side, up, back)];
  }

  let carry = 0, flameT = 0, wasShifting = false, enabled = true;
  const world = [new THREE.Vector3(), new THREE.Vector3()];

  function puffAt(i, o, vel, body) {
    _g.copy(world[i]).addScaledVector(_up, -(tips[i].y + 0.6)); // (the road under the tip, roughly)
    tyreSmoke.emit(world[i], _up, vel, { size: o.size, life: o.life, opacity: o.opacity, grow: o.grow, ground: _g });
  }
  function exhaustVel(o, body, out) {
    // the gas leaves backwards at o.speed m/s from a car moving at body.vel: the air takes the rest (the puff's drag)
    return out.copy(body.vel).addScaledVector(_back, o.speed);
  }

  return {
    group,
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; if (!enabled) this.reset(); },
    reset() { carry = 0; flameT = 0; wasShifting = false; group.visible = false; },
    /** A flame out of both tips for `t` s (the FX lab; looking at it) */
    flash(t = 0.5, k = 1) { flameT = t; uFlame.value = k; },
    /**
     * Each frame after the car and the engine moved.
     * @param vehicle  the car  @param engine  createEngineModel()'s handle (its `s`)  @param throttle 0..1  @param dt s
     */
    update(vehicle, engine, throttle, dt) {
      if (!enabled || !vehicle?.enabled || !tyreSmoke || dt <= 0) { group.visible = false; return; }
      tips ??= findTips(vehicle);
      if (!tips) return;
      const body = vehicle.body, es = engine.s, redline = 8200;
      _back.set(0, 0, -1).applyQuaternion(body.quat);
      _up.set(0, 1, 0).applyQuaternion(body.quat);
      const pos = vehicle.renderPos ?? body.pos;
      for (let i = 0; i < 2; i++) world[i].copy(tips[i]).applyQuaternion(body.quat).add(pos);
      // HAZE: by the load and the revs
      const k = Math.min(1, es.load * (es.rpm / redline) * 1.3 + (throttle > 0.5 && body.vel.length() < 8 ? 0.6 : 0));
      const H = S.haze;
      carry += (H.rate[0] + (H.rate[1] - H.rate[0]) * k) * dt;
      while (carry >= 1) {
        carry -= 1;
        const i = Math.random() < 0.5 ? 0 : 1;
        puffAt(i, { size: H.size, life: H.life, opacity: H.opacity[0] + (H.opacity[1] - H.opacity[0]) * k, grow: H.grow }, exhaustVel(H, body, _v), body);
      }
      // A SHIFT: a puff from each tip and a lick of flame
      const shifting = es.shifting > 0;
      if (shifting && !wasShifting && es.rpm > 5000) {
        for (let i = 0; i < 2; i++) puffAt(i, S.shift, exhaustVel(S.shift, body, _v), body);
        flameT = Math.max(flameT, S.shift.flame);
        uFlame.value = 0.55;
      }
      wasShifting = shifting;
      // POPS: lifting off at high revs
      const P = S.pop;
      if (es.pop > P.min && Math.random() < es.pop * P.chance * dt) {
        flameT = P.flash[0] + Math.random() * (P.flash[1] - P.flash[0]);
        uFlame.value = 0.6 + 0.4 * Math.random();
        uSeed.value = Math.random();
        const i = Math.random() < 0.5 ? 0 : 1;
        puffAt(i, P, exhaustVel(P, body, _v), body);
      }
      // the flames: on while flameT lasts, a flicker of length
      if (flameT > 0) {
        flameT -= dt;
        group.visible = true;
        const L = S.flame.length * (0.7 + 0.5 * Math.random()), W = S.flame.width * (0.8 + 0.4 * Math.random());
        for (let i = 0; i < 2; i++) {
          const f = flames[i];
          f.g.scale.set(L, W, W);
          _q.copy(body.quat);
          f.holder.matrix.compose(world[i], _q, _v.set(1, 1, 1));
          f.holder.matrixWorldNeedsUpdate = true;
        }
        uSeed.value = Math.random();
      } else group.visible = false;
    },
  };
}
