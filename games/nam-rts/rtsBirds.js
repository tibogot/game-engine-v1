// RTS birds — flocks that CROSS the map and leave, and flocks FLUSHED out of
// the canopy by explosions.
//
// Not modular-road's flocks: those wheel on circles around a wandering centre,
// ambience for a car. Here birds do two jobs:
//
//   · TRANSIT — a flock appears at the edge of what you are looking at, flies
//     across in a line and leaves; then a quiet gap, so the sky is never busy.
//     White egrets in a loose V (the rice-paddy image) or a straggle of crows.
//   · FLUSH — something explodes near the jungle and a flock bursts out of the
//     canopy, scatters, climbs and gathers into a line heading away. A signal
//     the player reads from across the map, under fog of war: something is
//     happening over there.
//
// ONE draw: an InstancedMesh of three-triangle birds. The CPU moves each
// flock's centre in a line and steers every bird toward its slot in the
// flock (that one rule is what makes a flushed flock burst and then gather);
// the wing beat is in the vertex stage. No shadows, no compute.
//
// Nature is real size (egret ~1 m span), not the 1.3x of units and buildings.
// Like modular-road's birds they never draw smaller than `minPixels`: a
// sub-pixel triangle does not fade, it crawls.
import * as THREE from "three";
import { Fn, attribute, float, hash, instanceIndex, positionLocal, sin, smoothstep, uniform, vec3 } from "three/tsl";

export const RTS_BIRD_PARAMS = {
  enabled: true,
  maxBirds: 192,
  // Transit: how many flocks at once, the gap between them, where they fly.
  maxTransit: 2,
  gapMin: 12, gapMax: 35,          // seconds of empty sky between flocks
  spawnRadius: 230,                // metres from the view centre they appear at
  cruiseAlt: [20, 32],             // metres above the ground under the flock
  speed: [10, 15],                 // m/s
  // Flush.
  flushCooldown: 22,               // seconds before the same spot flushes again
  flushRadius: 45,                 // "the same spot"
  // Look.
  span: 1.0,                       // metres, before the pixel floor
  minPixels: 2.6,
  flapRate: 4.2,                   // beats per second
  flapAmp: 0.6,
};

const EGRET = new THREE.Color(0.9, 0.89, 0.84);
const CROW = new THREE.Color(0.11, 0.11, 0.12);

/** Three triangles, local +Z forward; aFlap tags the two wing tips. */
function birdGeometry() {
  const V = [
    0, 0, -0.55, 0, 0.13, -0.55, 0, 0, 0.95,
    0, 0, -0.42, -0.62, 0, 0.10, 0, 0, 0.42,
    0, 0, 0.42, 0.62, 0, 0.10, 0, 0, -0.42,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(V, 3));
  g.setAttribute("aFlap", new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0, 0, 1, 0], 1));
  g.computeVertexNormals();
  return g;
}

const rand = (a, b) => a + Math.random() * (b - a);

export function createRtsBirds({ app, params = {} }) {
  const P = { ...RTS_BIRD_PARAMS, ...params };
  const geo = birdGeometry();
  const uTime = uniform(0);
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
  mat.name = "RtsBirds";
  // Wing beat: the tips swing, the roots stay on the body. Each bird has its
  // own rate and phase, and a slow gate lets it glide now and then.
  mat.positionNode = Fn(() => {
    const h = hash(instanceIndex.add(7));
    const rate = float(P.flapRate).mul(h.mul(0.5).add(0.75));
    const beat = sin(uTime.mul(rate).mul(6.2832).add(h.mul(40)));
    const glide = smoothstep(-0.3, 0.4, sin(uTime.mul(0.35).add(h.mul(13))));
    const lift = beat.mul(P.flapAmp).mul(glide).mul(attribute("aFlap", "float"));
    return positionLocal.add(vec3(0, lift, 0));
  })();
  const mesh = new THREE.InstancedMesh(geo, mat, P.maxBirds);
  mesh.name = "RtsBirds";
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.count = 0;
  for (let i = 0; i < P.maxBirds; i++) mesh.setColorAt(i, CROW);
  app.scene.add(mesh);

  const flocks = [];
  const recentFlush = [];
  let clock = 0;
  let nextTransit = rand(3, 8);

  const ground = (x, z) => app.getWorldHeight?.(x, z) ?? 0;
  const viewCentre = () => app.controls?.target ?? app.camera.position;

  /** Formation slots: a loose V for egrets, a straggle for crows. */
  function slots(n, kind) {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (kind === "egret") {
        const k = Math.ceil(i / 2), side = i % 2 ? 1 : -1;
        out.push(new THREE.Vector3(side * k * rand(1.8, 2.4), rand(-0.6, 0.6), -k * rand(1.6, 2.2)));
      } else {
        out.push(new THREE.Vector3(rand(-6, 6), rand(-2, 2), rand(-8, 4)));
      }
    }
    return out;
  }

  function addFlock({ kind, n, x, y, z, dir, speed, alt, burst = 0 }) {
    const used = flocks.reduce((s, f) => s + f.birds.length, 0);
    n = Math.min(n, P.maxBirds - used);
    if (n < 3) return null;
    const f = {
      kind, dir: dir.clone().normalize(), speed, alt, age: 0, travelled: 0, isFlush: burst > 0,
      centre: new THREE.Vector3(x, y, z),
      birds: [],
    };
    const sl = slots(n, kind);
    for (let i = 0; i < n; i++) {
      const b = {
        slot: sl[i],
        pos: new THREE.Vector3(x, y, z),
        vel: f.dir.clone().multiplyScalar(speed),
        size: P.span * rand(0.85, 1.15),
        bank: 0,
      };
      if (burst) {
        // Out of the canopy: scattered over the trees, bursting up and out.
        b.pos.add(new THREE.Vector3(rand(-1, 1) * burst, rand(0, 3), rand(-1, 1) * burst));
        const a = rand(0, Math.PI * 2);
        b.vel.set(Math.cos(a) * rand(3, 8), rand(5, 9), Math.sin(a) * rand(3, 8));
      } else {
        b.pos.add(b.slot);
      }
      f.birds.push(b);
    }
    flocks.push(f);
    return f;
  }

  function spawnTransit() {
    const c = viewCentre();
    const a = rand(0, Math.PI * 2);
    const x = c.x + Math.cos(a) * P.spawnRadius, z = c.z + Math.sin(a) * P.spawnRadius;
    // Across the view, not straight through its centre.
    const side = rand(-70, 70);
    const tx = c.x + Math.cos(a + Math.PI / 2) * side, tz = c.z + Math.sin(a + Math.PI / 2) * side;
    const dir = new THREE.Vector3(tx - x, 0, tz - z);
    const egret = Math.random() < 0.6;
    const alt = rand(...P.cruiseAlt);
    addFlock({ kind: egret ? "egret" : "crow", n: egret ? Math.round(rand(7, 15)) : Math.round(rand(6, 13)),
      x, y: ground(x, z) + alt, z, dir, speed: rand(...P.speed), alt });
  }

  /**
   * An explosion at (x, z): flush a flock if there is jungle there to flush
   * from, and this spot has not flushed in the last `flushCooldown` seconds.
   */
  function flush(x, z, { force = false } = {}) {
    if (!P.enabled) return false;
    if (!force) for (const r of recentFlush) if (clock - r.t < P.flushCooldown && Math.hypot(r.x - x, r.z - z) < P.flushRadius) return false;
    const cover = app.sampleFoliageDensity?.(x, z) ?? 1;
    if (!force && cover < 0.15) return false;
    recentFlush.push({ x, z, t: clock });
    if (recentFlush.length > 16) recentFlush.shift();
    const a = rand(0, Math.PI * 2);
    // Mostly WHITE birds: a flush is a signal, and dark birds over dark canopy
    // vanish from above. Egrets and herons are what burst out of paddies anyway.
    const crow = Math.random() < 0.25;
    addFlock({ kind: crow ? "crow" : "egret", n: Math.round(rand(10, 20)), x, y: ground(x, z) + rand(5, 9), z,
      dir: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), speed: rand(12, 16), alt: rand(18, 28), burst: 10 });
    return true;
  }

  const _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, "YXZ"), _m = new THREE.Matrix4();
  const _s = new THREE.Vector3(), _want = new THREE.Vector3(), _off = new THREE.Vector3();
  const _cam = new THREE.Vector3();

  function update(dt) {
    if (!P.enabled) { mesh.count = 0; return; }
    dt = Math.min(dt, 0.1);
    clock += dt;
    uTime.value = clock;

    const transits = flocks.filter((f) => !f.isFlush).length;
    nextTransit -= dt;
    if (nextTransit <= 0 && transits < P.maxTransit) {
      spawnTransit();
      nextTransit = rand(P.gapMin, P.gapMax);
    }

    const cam = app.camera;
    _cam.copy(cam.position);
    const vh = app.renderer?.domElement?.clientHeight || 1080;
    const pxPerRad = vh / (2 * Math.tan(((cam.fov ?? 50) * Math.PI) / 360));

    let n = 0;
    for (let fi = flocks.length - 1; fi >= 0; fi--) {
      const f = flocks[fi];
      f.age += dt;
      // The centre flies its line, holding its height over the ground.
      f.centre.addScaledVector(f.dir, f.speed * dt);
      f.travelled += f.speed * dt;
      const gy = ground(f.centre.x, f.centre.z) + f.alt;
      f.centre.y += (gy - f.centre.y) * Math.min(1, dt * 0.6);
      const yaw = Math.atan2(f.dir.x, f.dir.z);
      if (f.travelled > P.spawnRadius * 2 + 120) { flocks.splice(fi, 1); continue; }
      for (const b of f.birds) {
        // Steer toward the slot (slot turned to the flock's heading).
        _off.copy(b.slot).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
        _want.copy(f.centre).add(_off).sub(b.pos);
        const gather = Math.min(1, f.age / 3.5);          // flushed birds scatter first
        const desired = f.dir.clone().multiplyScalar(f.speed).addScaledVector(_want, 0.9 * gather);
        const prevYaw = Math.atan2(b.vel.x, b.vel.z);
        b.vel.lerp(desired, Math.min(1, dt * (0.8 + 1.6 * gather)));
        b.pos.addScaledVector(b.vel, dt);
        const floor = ground(b.pos.x, b.pos.z) + 3;
        if (b.pos.y < floor) { b.pos.y = floor; b.vel.y = Math.abs(b.vel.y); }
        // Heading, pitch from the climb, bank into the turn.
        const vYaw = Math.atan2(b.vel.x, b.vel.z);
        let dYaw = vYaw - prevYaw;
        dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
        b.bank += (THREE.MathUtils.clamp(-dYaw / Math.max(dt, 1e-3) * 0.25, -0.8, 0.8) - b.bank) * Math.min(1, dt * 4);
        const pitch = -Math.atan2(b.vel.y, Math.hypot(b.vel.x, b.vel.z));
        _e.set(pitch, vYaw, b.bank);
        _q.setFromEuler(_e);
        // Never below the pixel floor.
        const dist = b.pos.distanceTo(_cam);
        const s = Math.max(b.size, (P.minPixels * dist) / pxPerRad);
        _m.compose(b.pos, _q, _s.set(s, s, s));
        if (n >= P.maxBirds) break;
        mesh.setMatrixAt(n, _m);
        mesh.setColorAt(n, f.kind === "egret" ? EGRET : CROW);
        n++;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  return {
    mesh,
    params: P,
    update,
    flush,
    /** Send a transit flock across the view now (dev). */
    spawnTransit,
    setEnabled(on) { P.enabled = !!on; if (!on) { flocks.length = 0; mesh.count = 0; } },
    get count() { return mesh.count; },
    dispose() { app.scene.remove(mesh); geo.dispose(); mat.dispose(); },
  };
}
