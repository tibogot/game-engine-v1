// THUNDERLINE'S LANDING EFFECTS (2026-10-22, the FX pass: "as AAA as possible and always very optimized"):
//   - DUST at touchdown: soft puffs kicked out from each wheel that hits the road, sized and thrown by how
//     hard it hits (the speed INTO the road), dragged a little along with the car, swelling and thinning;
//   - a PERFECT landing (landing.js grade): a bolt-blue ring racing out across the road from the car, bloomed;
//   - a ROUGH landing: a heavier, darker burst.
// Cost: TWO draws when something shows (the puffs: one mesh, a fixed pool billboarded on the CPU like the
// sparks; the ring: one disc), none otherwise. No texture: the puff's soft lumpy edge is a radial falloff
// times 3D noise in the shader. The puffs are LIT (the sun and sky shade them like the road) — unlit dust
// glows in shade and goes grey at sunset.
import * as THREE from "three";
import { attribute, uv, vec3, float, smoothstep, length, mx_noise_float, positionLocal, uniform, abs, oneMinus, color, max, mix } from "three/tsl";
import { applyBloomMRT } from "../../../../v3/render/bloomMRT.js";

export const LANDING_FX = {
  touchSpeed: 3, // m/s into the road before a wheel kicks dust
  fullSpeed: 14, // m/s for the biggest burst
  perWheel: [2, 7], // puffs per wheel, light → hard
  size: [0.35, 0.9], // m radius at birth, light → hard
  grow: 1.8, // radius × (1 + grow × √age)
  life: [0.5, 1.1], // s
  spread: [2, 6], // m/s out along the road, light → hard
  rise: 1.2, // m/s up off the road
  carDrag: 0.6, // of the car's velocity the dust is thrown with (it keeps up a while, then falls behind)
  drag: 2.2,
  dust: 0x9a9690, // the dust's albedo (lit by the scene)
  roughDust: 0x5e5a56,
  alpha: 0.42,
  nearFade: [2.5, 8], // m from the camera: at speed the dust falls back past the lens (a white screen)
  ring: { color: 0x3fd2ff, from: 1.5, to: 16, time: 0.55, width: 0.09, glow: 2.4 },
};

const POOL = 96;
const VERTS = 6;
const _CORNERS = [[-1, -1], [1, -1], [-1, 1], [1, -1], [1, 1], [-1, 1]];
const _v = new THREE.Vector3(), _t = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3();
const _cr = new THREE.Vector3(), _cu = new THREE.Vector3(), _cf = new THREE.Vector3(), _q = new THREE.Quaternion();

export function createLandingFx(scene, settings = LANDING_FX) {
  const s = settings;
  // ---------- the puffs ----------
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(POOL * VERTS * 3), nor = new Float32Array(POOL * VERTS * 3);
  const corner = new Float32Array(POOL * VERTS * 2), data = new Float32Array(POOL * VERTS * 4); // alpha, seed, dark, —
  const dyn = (a, n) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", dyn(pos, 3));
  geo.setAttribute("normal", dyn(nor, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(corner, 2)); // the quad corner, 0..1 (a custom "corner" attribute never reached the shader: every puff drew as a full card)
  geo.setAttribute("aData", dyn(data, 4));
  for (let i = 0; i < POOL; i++) for (let v = 0; v < VERTS; v++) corner.set([(_CORNERS[v][0] + 1) / 2, (_CORNERS[v][1] + 1) / 2], (i * VERTS + v) * 2);
  geo.setDrawRange(0, 0);
  const mat = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, roughness: 1, metalness: 0 });
  {
    const c = uv().mul(2).sub(1), d = attribute("aData", "vec4");
    const r = length(c);
    // a lumpy soft edge: 3D noise on the quad, its own seed per puff, the noise rolling as it ages
    const n = mx_noise_float(vec3(c.mul(1.7), d.y.mul(17.3))).mul(0.5).add(0.5);
    // (× a round window: the noise pulled the edge in or out, and where it pushed it past the quad's side
    // the card's straight edge showed)
    const edge = oneMinus(smoothstep(float(0.3), float(0.95), r.add(n.sub(0.5).mul(0.45)))).mul(oneMinus(smoothstep(float(0.8), float(1), r)));
    mat.colorNode = mix(color(s.dust), color(s.roughDust), d.z).mul(n.mul(0.35).add(0.75));
    mat.opacityNode = edge.mul(d.x).mul(s.alpha);
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 18; // under the sparks
  mesh.visible = false;
  scene.add(mesh);
  const puffs = Array.from({ length: POOL }, () => ({ life: 0, max: 1, r0: 1, pos: new THREE.Vector3(), vel: new THREE.Vector3(), seed: 0, dark: 0 }));
  let next = 0;

  // ---------- the perfect ring: a disc on the road, its band drawn by the shader ----------
  const fade = uniform(0);
  const ringMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
  {
    const r = length(positionLocal.xz); // 0 … 1
    const w = float(s.ring.width);
    const sharp = oneMinus(smoothstep(float(0), w, abs(r.sub(0.94)))); // the bright rim
    const wake = smoothstep(float(0.35), float(0.94), r).mul(smoothstep(float(1), float(0.94), r)).mul(0.2); // a soft glow inside it
    const k = max(sharp, wake).mul(fade);
    ringMat.colorNode = color(s.ring.color).mul(k.mul(s.ring.glow));
    ringMat.opacityNode = k;
    applyBloomMRT(ringMat, ringMat.colorNode);
  }
  const ring = new THREE.Mesh(new THREE.CircleGeometry(1, 72).rotateX(-Math.PI / 2), ringMat);
  ring.frustumCulled = false;
  ring.renderOrder = 19;
  ring.visible = false;
  scene.add(ring);
  let ringT = -1;

  const wheels = [0, 1, 2, 3].map(() => ({ air: false }));
  const prevVel = new THREE.Vector3();
  let havePrev = false;

  function kick(point, normal, carVel, k, dark) {
    const n = Math.round(THREE.MathUtils.lerp(s.perWheel[0], s.perWheel[1], k));
    // a tangent frame on the road
    _t.set(1, 0, 0);
    if (Math.abs(normal.x) > 0.9) _t.set(0, 0, 1);
    _b.crossVectors(normal, _t).normalize();
    _t.crossVectors(_b, normal).normalize();
    for (let i = 0; i < n; i++) {
      const p = puffs[next];
      next = (next + 1) % POOL;
      const a = Math.random() * Math.PI * 2;
      const sp = THREE.MathUtils.lerp(s.spread[0], s.spread[1], k) * (0.5 + Math.random() * 0.6);
      p.r0 = THREE.MathUtils.lerp(s.size[0], s.size[1], k) * (0.7 + Math.random() * 0.5);
      p.pos.copy(point).addScaledVector(normal, p.r0 * 0.45); // its centre off the road: no hard cut into it
      p.vel.copy(_t).multiplyScalar(Math.cos(a) * sp).addScaledVector(_b, Math.sin(a) * sp)
        .addScaledVector(normal, s.rise * (0.4 + Math.random())).addScaledVector(carVel, s.carDrag);
      p.max = p.life = THREE.MathUtils.lerp(s.life[0], s.life[1], k) * (0.75 + Math.random() * 0.5);
      p.seed = Math.random();
      p.dark = dark;
    }
  }

  return {
    mesh, ring, settings: s,
    reset() {
      for (const p of puffs) p.life = 0;
      geo.setDrawRange(0, 0);
      mesh.visible = ring.visible = false;
      ringT = -1; havePrev = false;
      for (const w of wheels) w.air = false;
    },
    /** landing.js's verdict (a moment after touchdown): a PERFECT one rings, a ROUGH one adds heavy dust */
    grade(ev, vehicle) {
      const grounded = vehicle.tires.filter((t) => t.grounded);
      if (!grounded.length) return;
      _v.set(0, 0, 0); _n.set(0, 0, 0);
      for (const t of grounded) { _v.add(t.hitPoint); _n.add(t.hitNormal); }
      _v.multiplyScalar(1 / grounded.length);
      _n.normalize();
      if (ev.grade === "perfect") {
        ring.position.copy(_v).addScaledVector(_n, 0.06);
        ring.quaternion.copy(_q.setFromUnitVectors(_cu.set(0, 1, 0), _n));
        ringT = 0;
      } else if (ev.grade === "rough") {
        for (const t of grounded) kick(t.hitPoint, t.hitNormal, vehicle.body.vel, 1, 1);
      }
    },
    /** Each frame after the car moved; the camera after the chase camera moved. */
    update(vehicle, camera, dt) {
      if (dt <= 0) return;
      // TOUCHDOWN per wheel: in the air last frame, on the road now → the speed it hit at, into the road
      if (vehicle?.enabled) {
        vehicle.tires.forEach((t, i) => {
          const w = wheels[i];
          if (!w) return;
          if (t.grounded && w.air && havePrev) {
            const into = -prevVel.dot(t.hitNormal);
            if (into > s.touchSpeed) kick(t.hitPoint, t.hitNormal, vehicle.body.vel, THREE.MathUtils.clamp((into - s.touchSpeed) / (s.fullSpeed - s.touchSpeed), 0, 1), 0);
          }
          w.air = !t.grounded;
        });
        prevVel.copy(vehicle.body.vel);
        havePrev = true;
      }

      // the puffs: drift, slow, swell, thin; billboarded to the camera, their normals facing it (lit as a cloud)
      camera.updateMatrixWorld();
      _v.setFromMatrixPosition(camera.matrixWorld);
      _cr.setFromMatrixColumn(camera.matrixWorld, 0);
      _cu.setFromMatrixColumn(camera.matrixWorld, 1);
      _cf.setFromMatrixColumn(camera.matrixWorld, 2);
      let alive = 0;
      for (const p of puffs) {
        if (p.life <= 0) continue;
        p.life -= dt;
        if (p.life <= 0) continue;
        p.vel.multiplyScalar(Math.max(0, 1 - s.drag * dt));
        p.vel.y -= 0.6 * dt; // heavy dust settles
        p.pos.addScaledVector(p.vel, dt);
        const age = 1 - p.life / p.max;
        const r = p.r0 * (1 + s.grow * Math.sqrt(age));
        const near = THREE.MathUtils.smoothstep(p.pos.distanceTo(_v) - r, s.nearFade[0], s.nearFade[1]);
        const a = Math.min(1, age * 8) * (1 - age) * (1 - age) * near; // in fast, out slow; never on the lens
        const o = alive * VERTS;
        // the card pulled TOWARD THE CAMERA by its radius: a puff swelling into the road was cut by it along
        // a hard straight line (the cheap answer to soft particles: no depth read)
        _t.copy(p.pos).addScaledVector(_cf, r);
        for (let v = 0; v < VERTS; v++) {
          const [x, y] = _CORNERS[v], k = o + v;
          pos[k * 3] = _t.x + (_cr.x * x + _cu.x * y) * r;
          pos[k * 3 + 1] = _t.y + (_cr.y * x + _cu.y * y) * r;
          pos[k * 3 + 2] = _t.z + (_cr.z * x + _cu.z * y) * r;
          // the normal leans out from the centre: the puff shades like a ball, not a card
          _n.copy(_cf).multiplyScalar(0.8).addScaledVector(_cr, x * 0.45).addScaledVector(_cu, y * 0.45).normalize();
          nor[k * 3] = _n.x; nor[k * 3 + 1] = _n.y; nor[k * 3 + 2] = _n.z;
          data[k * 4] = a; data[k * 4 + 1] = p.seed; data[k * 4 + 2] = p.dark;
        }
        alive++;
      }
      geo.setDrawRange(0, alive * VERTS);
      mesh.visible = alive > 0;
      if (alive) for (const [name, n] of [["position", 3], ["normal", 3], ["aData", 4]]) {
        const at = geo.attributes[name];
        at.addUpdateRange(0, alive * VERTS * n);
        at.needsUpdate = true;
      }

      // the ring: out fast, easing, fading
      if (ringT >= 0) {
        ringT += dt / s.ring.time;
        if (ringT >= 1) { ringT = -1; ring.visible = false; }
        else {
          const e = 1 - (1 - ringT) ** 3;
          ring.scale.setScalar(THREE.MathUtils.lerp(s.ring.from, s.ring.to, e));
          fade.value = (1 - ringT) ** 1.5;
          ring.visible = true;
        }
      }
    },
    alive() { return puffs.reduce((n, p) => n + (p.life > 0 ? 1 : 0), 0); },
  };
}
