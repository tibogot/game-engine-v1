// THUNDERLINE'S TYRE SMOKE (user, 2026-10-22: "the best looking AAA game tyre smoke"). Built on the RTS games'
// LIT SMOKE (games/shared-rts/litSmoke.js) — its six-way book (each frame lit from ±X ±Y ±Z, weighted by where
// the sun is: dark undersides, a bright sun side, at any time of day), its motion-vector frame blend (the puff
// flows, it doesn't cross-dissolve) and its shape (ONE instanced draw for every puff; a puff's row written once
// when it is born, its whole life a function of the clock in the shader) — made for a racer:
//   - EMITTED BY EACH WHEEL'S REAL SLIP: sideways slide (drift), the handbrake, wheelspin and locked brakes
//     (a tyre past its grip lengthwise); how hard sets the rate, the size and the density;
//   - CONTINUOUS AT ANY SPEED: the puffs are laid along the path the wheel ran since the last frame (and at
//     least every DENSITY m of it), never one blob a frame (the old trail broke into blobs at 190 km/h);
//   - THROWN, THEN STOPPED BY THE AIR: a puff leaves with a part of the wheel's slide and the air's drag stops
//     it (exp), then it climbs and drifts with the wind — a drift leaves a wall of smoke where it happened;
//   - SOFT ON THE ROAD: each puff knows the plane of the road it came off and fades into it per pixel (a card
//     crossing the road cut a hard line — also on a bank, a wall, a loop);
//   - NEVER ON THE LENS: thinned within a few metres of the camera (a drift filled the chase view);
//   - BACK-LIT: thin smoke glows towards a low sun behind it (forward scattering).
import * as THREE from "three";
import {
  Fn, attribute, cameraPosition, cameraWorldMatrix, cos, dot, exp, float, floor, fract, max, mix, normalize,
  output, positionLocal, positionWorld, pow, saturate, select, sin, smoothstep, step, texture, uniform, uv,
  varying, vec2, vec3, vec4, length,
} from "three/tsl";

// THE BOOK: ONE PUFF OF RUBBER SMOKE, baked in the Fire Pro lab (v3/fire-bake-lab, preset tyreSmoke; user, 2026-10-29:
// "the best looking AAA smoke" — on the generic smoke6 book the drift read as two tidy white ropes). Its whole life is
// in the frames: a dense ball at the tyre that rolls over, swells to ~5 m and thins low and wide — so the card is the
// bake box, constant, and the code adds almost no growth. `anchor`: where the source (the tyre) is on the card, from
// its centre in card widths (+x right, +y up): the card is placed so that point sits on the tyre.
export const SMOKE_BOOK = {
  a: "/textures/fx/firepro/fp_tyreSmoke_a.webp", b: "/textures/fx/firepro/fp_tyreSmoke_b.webp", mv: "/textures/fx/firepro/fp_tyreSmoke_mv.webp",
  cols: 8, rows: 8, cell: 192, mvScale: 15.415, fill: 0.995, anchor: [0.229, -0.27], // (fp_tyreSmoke.json; the bake box centre −1.6, 2.2 of 7 m from the source; from 0.45 s of the puff: torn already)
};

export const TYRE_SMOKE = {
  tint: [0.86, 0.86, 0.88], // linear albedo: rubber smoke is a pale, slightly cool white
  slipMin: 0.22, slipFull: 0.8, // sideways / along at the wheel: from here it smokes … fully here
  brakeK: 0.8, // a tyre past its grip lengthwise (wheelspin, locked brakes)
  handbrake: 0.75, // the rear wheels on the handbrake (moving)
  minSpeed: 3, // m/s of the wheel over the road before any smoke
  rate: 24, // puffs a second per wheel at full smoke (each a whole rolling puff now: big cards, fewer of them)
  density: 0.8, // and at least one puff per this many metres of the wheel's path (continuity at speed)
  size: [4, 6.5], // the card (m): the bake box — light → full slip
  grow: [0.05, 0.15], // swells to size × (1 + grow): the book swells by itself
  growTime: 1.0, // s for most of the swell
  life: [1.6, 3.4], // s (the book's 3 s, played faster or slower)
  opacity: [0.5, 0.9],
  spin: 0.15, // rad either way: the card's turn (the book has a ground under it: a big turn tipped it)
  front: 0.3, // the front wheels smoke this much (a drift smokes at the REAR: user, 2026-10-29)
  throwK: 0.32, // of the wheel's velocity over the road the puff leaves with…
  drag: 2.4, // …lost to the air (1/s)
  rise: 0.45, // m/s up
  wind: [0.5, 0, 0.2], // m/s
  nearFade: [1.2, 6], // m from the camera
  soft: 0.35, // m of fade into its road plane
  sunK: 0.42, skyK: 0.8, // the book's lit fractions → this smoke's brightness (litSmoke's calibration)
  backlit: 0.9, // forward-scattering glow of the thin smoke towards the sun
};

const MAX = 1024;

class SmokeMRTNode extends THREE.MRTNode {
  // the scene's MRT: colour only, nothing into the bloom (as litSmoke)
  static get type() { return "TyreSmokeMRTNode"; }
  setup(builder) {
    const textures = builder.renderer.getRenderTarget()?.textures;
    const anyNamed = !!textures && textures.some((t) => this.outputNodes[t.name] !== undefined);
    if (anyNamed) return super.setup(builder);
    this.members = [vec4(output)];
    return THREE.Node.prototype.setup.call(this, builder);
  }
}

export function createTyreSmoke(app, settings = TYRE_SMOKE) {
  const s = settings, F = SMOKE_BOOK;
  const load = (url, srgb) => {
    const t = new THREE.Texture();
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    fetch(url).then((r) => r.blob()).then((b) => createImageBitmap(b, { premultiplyAlpha: "none" }))
      .then((bmp) => { t.image = bmp; t.needsUpdate = true; })
      .catch((e) => console.warn(`tyreSmoke: ${url}`, e));
    return t;
  };
  const texA = load(F.a, true), texB = load(F.b, true), texM = load(F.mv, false);

  const uTime = uniform(0);
  const uSunDir = uniform(new THREE.Vector3(0.3, 0.8, 0.4));
  const uSun = uniform(new THREE.Color(3, 3, 3));
  const uSky = uniform(new THREE.Color(0.6, 0.7, 0.8));
  const uSunK = uniform(s.sunK), uSkyK = uniform(s.skyK), uBack = uniform(s.backlit);
  const uDrag = uniform(s.drag), uGrowT = uniform(s.growTime);
  const uRise = uniform(new THREE.Vector3(s.wind[0], s.rise + s.wind[1], s.wind[2]));
  const uNear = uniform(new THREE.Vector2(...s.nearFade)), uSoft = uniform(s.soft);

  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute("position", quad.attributes.position);
  geo.setAttribute("uv", quad.attributes.uv);
  quad.dispose();
  //   iPos    x, y, z, size at birth (m)
  //   iLife   start, duration, seed, opacity
  //   iVel    thrown vx, vy, vz (m/s), grow
  //   iPlane  the road's normal nx, ny, nz, and d (n·p on the road)
  const attrs = {};
  for (const k of ["iPos", "iLife", "iVel", "iPlane"]) {
    attrs[k] = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    attrs[k].setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(k, attrs[k]);
  }
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

  const vAge = varying(float(0), "v_ts_age");
  const vMirror = varying(float(0), "v_ts_mirror");
  const vL = varying(vec3(0, 1, 0), "v_ts_light");
  const vOpacity = varying(float(1), "v_ts_opacity");
  const vPlane = varying(vec4(0, 1, 0, 0), "v_ts_plane");
  const vBack = varying(float(0), "v_ts_back");

  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending, side: THREE.FrontSide });
  material.name = "TyreSmoke";
  material.fog = true;

  material.positionNode = Fn(() => {
    const p = attribute("iPos", "vec4"), l = attribute("iLife", "vec4"), v = attribute("iVel", "vec4");
    const secs = uTime.sub(l.x);
    const age = secs.div(max(l.y, float(1e-3)));
    const alive = step(float(0), age).mul(step(age, float(1))).mul(step(float(1e-3), l.y));
    const t = max(secs, float(0));
    // thrown, stopped by the air: ∫ v e^(−k t) = v (1 − e^(−k t)) / k; then the climb and the wind
    const thrown = v.xyz.mul(float(1).sub(exp(uDrag.negate().mul(t))).div(uDrag));
    const centre = vec3(p.x, p.y, p.z).add(thrown).add(vec3(uRise).mul(t));
    // swells fast, then slowly: size × (1 + grow (1 − e^(−t/T)))
    const size = p.w.mul(float(1).add(v.w.mul(float(1).sub(exp(t.negate().div(uGrowT)))))).mul(alive);
    // toward the camera a little (litSmoke's third of a small puff; the baked card is the whole 5 m puff's box)
    const lifted = centre.add(normalize(cameraPosition.sub(centre)).mul(size.mul(0.08)));
    const rot = l.z.sub(0.5).mul(2 * s.spin);
    const cr = cos(rot), sr = sin(rot);
    const right = cameraWorldMatrix[0].xyz, up = cameraWorldMatrix[1].xyz;
    const ax = right.mul(cr).add(up.mul(sr));
    const ay = right.mul(sr.negate()).add(up.mul(cr));
    const toCam = normalize(cameraPosition.sub(lifted));
    const mirror = step(float(0.5), fract(l.z.mul(7.31)));
    // the book's source on the tyre: the card moved by its anchor (mirrored with the picture)
    const anchored = lifted.sub(ax.mul(size.mul(F.anchor?.[0] ?? 0).mul(float(1).sub(mirror.mul(2))))).sub(ay.mul(size.mul(F.anchor?.[1] ?? 0)));
    const L = uSunDir;
    vL.assign(normalize(vec3(dot(L, ax).mul(float(1).sub(mirror.mul(2))), dot(L, ay), dot(L, toCam))));
    vAge.assign(saturate(age));
    vMirror.assign(mirror);
    // never on the lens: thinned near the camera (by the puff's near side)
    const dCam = length(cameraPosition.sub(centre)).sub(size.mul(0.5));
    vOpacity.assign(l.w.mul(smoothstep(uNear.x, uNear.y, dCam)));
    vPlane.assign(attribute("iPlane", "vec4"));
    // the sun BEHIND the smoke as seen from the camera: forward scattering
    vBack.assign(pow(saturate(dot(toCam.negate(), L)), float(6)));
    return anchored.add(ax.mul(positionLocal.x.mul(size))).add(ay.mul(positionLocal.y.mul(size)));
  })();

  const frames = F.cols * F.rows, inset = 0.5 / F.cell;
  const cellUV = (idx, local) => {
    const col = idx.mod(F.cols), row = floor(idx.div(F.cols));
    const q = local.clamp(inset, 1 - inset);
    return vec2(col.add(q.x).div(F.cols), float(F.rows - 1).sub(row).add(q.y).div(F.rows));
  };
  const tint = vec3(...s.tint);
  const shade = Fn(() => {
    // the book's life: its first frames are the dense young puff, its last the thin wisps
    const f = vAge.mul(frames - 1);
    const f0 = floor(f), f1 = f0.add(1).min(frames - 1), w = fract(f);
    const local = vec2(mix(uv().x, float(1).sub(uv().x), vMirror), uv().y);
    const mv = texture(texM, cellUV(f0, local)).xy.sub(0.5).div(F.mvScale);
    const l0 = local.sub(mv.mul(w)), l1 = local.add(mv.mul(float(1).sub(w)));
    const A = mix(texture(texA, cellUV(f0, l0)), texture(texA, cellUV(f1, l1)), w);
    const B = mix(texture(texB, cellUV(f0, l0)).xyz, texture(texB, cellUV(f1, l1)).xyz, w);
    const L = vL, L2 = L.mul(L);
    const lit = L2.x.mul(select(L.x.greaterThan(0), A.x, B.x))
      .add(L2.y.mul(select(L.y.greaterThan(0), A.y, B.y)))
      .add(L2.z.mul(select(L.z.greaterThan(0), A.z, B.z)));
    const sky = A.y.mul(0.7).add(B.y.mul(0.3));
    let rgb = tint.mul(vec3(uSun).mul(lit).mul(uSunK).add(vec3(uSky).mul(sky).mul(uSkyK)));
    // back-lit: the THIN smoke glows (the dense core stays shaded)
    rgb = rgb.add(vec3(uSun).mul(tint).mul(vBack.mul(uBack).mul(float(1).sub(A.w).mul(A.w).mul(2.2))));
    // in GENTLY (a puff appearing whole at the tyre read as a round lump: the ones the chase camera sees most — user,
    // 2026-10-29), out over its second half
    const fade = smoothstep(float(0.02), float(0.14), vAge).mul(float(1).sub(smoothstep(float(0.55), float(1), vAge)));
    const e = uv().min(float(1).sub(uv()));
    const border = smoothstep(float(0), float(0.12), e.x).mul(smoothstep(float(0), float(0.12), e.y));
    // soft into the road it came off (its plane, per pixel)
    const above = dot(positionWorld, vPlane.xyz).sub(vPlane.w);
    const ground = saturate(above.div(uSoft));
    return vec4(rgb, A.w.mul(fade).mul(border).mul(ground).mul(vOpacity));
  })();
  material.colorNode = shade.xyz;
  material.opacityNode = shade.w;
  material.mrtNode = new SmokeMRTNode({ emissive: vec4(0, 0, 0, 0) });

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = "TyreSmoke";
  mesh.frustumCulled = false;
  mesh.renderOrder = 17; // after the road's marks, before the sparks
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.visible = false;
  app.scene.add(mesh);

  let clock = 0, cursor = 0, used = 0, seedN = 0, liveUntil = -1, fresh = true, enabled = true;
  const _c = new THREE.Color(), _v = new THREE.Vector3(), _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Vector3();
  const wheels = [0, 1, 2, 3].map(() => ({ prev: new THREE.Vector3(), has: false, carry: 0 }));

  function puff(pos, n, vel, k, startOffset) {
    const i = cursor;
    cursor = (cursor + 1) % MAX;
    used = Math.max(used, cursor === 0 ? MAX : cursor);
    seedN = (seedN + 0.6180339887) % 1;
    const r = Math.random();
    const size = THREE.MathUtils.lerp(s.size[0], s.size[1], k) * (0.8 + 0.4 * r);
    const life = THREE.MathUtils.lerp(s.life[0], s.life[1], k) * (0.75 + 0.5 * Math.random());
    const start = clock - startOffset; // puffs laid back along this frame's path are already a little older
    const card = size / F.fill;
    const P = attrs.iPos.array, Lf = attrs.iLife.array, V = attrs.iVel.array, N = attrs.iPlane.array, o = i * 4;
    P[o] = pos.x + n.x * 0.15; P[o + 1] = pos.y + n.y * 0.15; P[o + 2] = pos.z + n.z * 0.15; // (at the tyre: the anchor places the card)
    P[o + 3] = card;
    Lf[o] = start; Lf[o + 1] = life; Lf[o + 2] = seedN; Lf[o + 3] = THREE.MathUtils.lerp(s.opacity[0], s.opacity[1], k);
    V[o] = vel.x * s.throwK + (Math.random() - 0.5) * 1.2; V[o + 1] = vel.y * s.throwK + 0.4 + Math.random() * 0.6; V[o + 2] = vel.z * s.throwK + (Math.random() - 0.5) * 1.2;
    V[o + 3] = THREE.MathUtils.lerp(s.grow[0], s.grow[1], Math.random());
    N[o] = n.x; N[o + 1] = n.y; N[o + 2] = n.z; N[o + 3] = n.x * pos.x + n.y * pos.y + n.z * pos.z;
    if (fresh) { for (const a in attrs) attrs[a].clearUpdateRanges(); fresh = false; }
    for (const a in attrs) { attrs[a].addUpdateRange(o, 4); attrs[a].needsUpdate = true; }
    geo.instanceCount = used;
    liveUntil = Math.max(liveUntil, start + life);
    mesh.visible = true;
  }

  return {
    mesh, settings: s, params: { uSunK, uSkyK, uBack, uDrag, uNear, uSoft },
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; if (!enabled) this.reset(); },
    reset() { liveUntil = -1; mesh.visible = false; for (const w of wheels) { w.has = false; w.carry = 0; } },
    /** Each frame after the car moved (the tyres' contacts are this frame's). dt 0 = paused. */
    update(vehicle, dt) {
      if (dt > 0) clock += dt;
      uTime.value = clock;
      fresh = true;
      if (enabled && dt > 0 && vehicle?.enabled) {
        const body = vehicle.body;
        _fwd.set(0, 0, 1).applyQuaternion(body.quat);
        _right.set(1, 0, 0).applyQuaternion(body.quat);
        const handbrake = !!vehicle.input?.handbrake;
        for (let i = 0; i < vehicle.tires.length && i < wheels.length; i++) {
          const tire = vehicle.tires[i], w = wheels[i];
          if (!tire.grounded) { w.has = false; w.carry = 0; continue; }
          body.getVelocityAtPoint(tire.worldPos, _v);
          _v.addScaledVector(tire.hitNormal, -_v.dot(tire.hitNormal)); // over the road
          const speed = _v.length();
          const gate = THREE.MathUtils.smoothstep(speed, s.minSpeed, s.minSpeed * 3);
          const slip = Math.abs(_v.dot(_right)) / Math.max(Math.abs(_v.dot(_fwd)), 3.5);
          let k = THREE.MathUtils.clamp((slip - s.slipMin) / (s.slipFull - s.slipMin), 0, 1);
          k = Math.max(k, THREE.MathUtils.clamp((tire.overDemand ?? 0) * s.brakeK, 0, 1));
          if (handbrake && !tire.canSteer) k = Math.max(k, s.handbrake);
          k *= gate * (tire.canSteer ? s.front : 1);
          _p.copy(tire.hitPoint);
          if (k > 0.04) {
            // along this frame's path: by time (rate) and by distance (density), whichever asks more
            const dist = w.has ? w.prev.distanceTo(_p) : 0;
            const want = Math.max(s.rate * k * dt, dist > 4 ? 0 : dist / s.density * Math.min(1, k * 1.6)) + w.carry;
            const n = Math.min(12, Math.floor(want));
            w.carry = want - n;
            for (let j = 0; j < n; j++) {
              const f = n === 1 ? 1 : (j + 1) / n;
              const at = w.has && dist <= 4 ? _q.copy(w.prev).lerp(_p, f) : _p;
              puff(at, tire.hitNormal, _v, k, dt * (1 - f));
            }
          } else w.carry = 0;
          w.prev.copy(_p);
          w.has = true;
        }
      }
      if (clock > liveUntil) { if (mesh.visible) mesh.visible = false; return; }
      // the light: the engine's sun and sky (as litSmoke)
      const Lt = app.light;
      const dir = Lt?.getDirection?.();
      if (dir) uSunDir.value.copy(dir).normalize();
      const sun = Lt?.sun, hemi = Lt?.hemi;
      if (sun) uSun.value.copy(_c.copy(sun.color).multiplyScalar(sun.intensity));
      if (hemi && hemi.intensity > 0.01) uSky.value.copy(_c.copy(hemi.color).multiplyScalar(hemi.intensity));
      else if (sun) uSky.value.setRGB(0.55, 0.62, 0.75).multiplyScalar(sun.intensity * 0.1);
    },
    active() { return mesh.visible ? used : 0; },
  };
}
