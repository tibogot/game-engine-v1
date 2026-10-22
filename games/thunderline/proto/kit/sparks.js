// THUNDERLINE'S RAIL SPARKS (user, 2026-10-22: "the sparkles when touching guardrails"). From the old
// game's modularRoadSparks.js (left as it is: the parts bin), changed where it failed on our car:
//   - they flew AWAY from the rail at their own small speed — straight under the car's body, unseen
//     from the chase camera (25 alive, none on screen). Now they keep part of the CAR's speed and spray
//     up and out: a rooster tail streaming behind the contact, the way a scrape throws them;
//   - 4 cm wide and a quarter second long: now longer, wider streaks stretched by their speed;
//   - a hot FLARE at the contact point while it lasts (a soft fan of vertex colour: no texture).
// The same perf shape: ONE mesh for every spark (a fixed pool, drawRange to the live count, additive,
// no depth write, no texture) + one small mesh for the flare; both hidden when nothing scrapes. Unlit:
// they opt into the selective bloom themselves (bloomMRT.js, `output` — an unlit material has no emissive).
import * as THREE from "three";
import { output } from "three/tsl";
import { applyBloomMRT } from "../../../../v3/render/bloomMRT.js";

export const SPARKS = {
  emitRate: 420, // sparks per second at a full scrape
  minSpeed: 3, // m/s along the rail before anything flies
  fullSpeed: 30, // m/s for the full shower
  lifeMin: 0.22, lifeMax: 0.6,
  // of the car's velocity: well under 1, so they stream BACK out of the car's silhouette at once (at
  // 0.45-0.8 they rode along inside the body, hidden: 90 alive, a handful seen)
  inheritMin: 0.3, inheritMax: 0.65,
  sprayMin: 4, sprayMax: 12, // m/s across the rail's plane: up, over the rail, into the road
  width: 0.045, // (0.08 read as little orange bars up close)
  stretch: 0.075, // metres of streak per m/s — of the spark's speed AGAINST THE CAMERA (motion blur is)
  maxStreak: 1.1,
  nearFade: [1.5, 5], // m from the camera: a spark flying past the lens fades out (at 137 km/h they
  // streamed back past the chase camera as huge white bars)
  gravity: 14,
  drag: 1.3,
  bounce: 0.4, // one skitter off the road
  colorHot: "#fff3c4",
  colorCool: "#ff6a14",
  intensity: 2.3,
  flare: { size: 0.75, color: "#ffb04a", intensity: 2.2 },
};

const POOL = 640;
const VERTS = 6;
const POS_F = VERTS * 3, COL_F = VERTS * 4;
const FAN = 10; // flare: a fan of 10 triangles
const _CORNERS = [[-1, -1], [1, -1], [-1, 1], [1, -1], [1, 1], [-1, 1]];
const _hot = new THREE.Color(), _cool = new THREE.Color(), _tint = new THREE.Color(), _flare = new THREE.Color();
const _dir = new THREE.Vector3(), _tan = new THREE.Vector3(), _bit = new THREE.Vector3(), _side = new THREE.Vector3();
const _cam = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _along = new THREE.Vector3();
const _cr = new THREE.Vector3(), _cu = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

function makeMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  applyBloomMRT(m, output);
  return m;
}
function dynamicGeometry(verts) {
  const g = new THREE.BufferGeometry();
  const pa = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const ca = new THREE.BufferAttribute(new Float32Array(verts * 4), 4).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute("position", pa);
  g.setAttribute("color", ca);
  g.setDrawRange(0, 0);
  return g;
}

export function createSparks(scene, settings = SPARKS) {
  const s = settings;
  const geometry = dynamicGeometry(POOL * VERTS);
  const mesh = new THREE.Mesh(geometry, makeMaterial());
  mesh.frustumCulled = false; // one mesh spanning the track
  mesh.renderOrder = 24; // over the smoke
  mesh.visible = false;
  scene.add(mesh);
  const flareGeo = dynamicGeometry(FAN * 3);
  flareGeo.setDrawRange(0, FAN * 3);
  const flare = new THREE.Mesh(flareGeo, mesh.material);
  flare.frustumCulled = false;
  flare.renderOrder = 25;
  flare.visible = false;
  scene.add(flare);
  const positions = geometry.attributes.position.array, colors = geometry.attributes.color.array;
  const particles = Array.from({ length: POOL }, () => ({ life: 0, maxLife: 1, pos: new THREE.Vector3(), vel: new THREE.Vector3(), groundY: -1e9, bounced: false }));
  let next = 0, accum = 0, flareK = 0, enabled = true;

  function emit(point, normal, carVel, k, groundY) {
    const p = particles[next];
    next = (next + 1) % POOL;
    // along the rail: the car's velocity without its part into the rail
    _along.copy(carVel).addScaledVector(normal, -carVel.dot(normal));
    const L = _along.length();
    if (L > 1e-3) _along.multiplyScalar(1 / L); else _along.set(0, 0, 0);
    p.pos.copy(point).addScaledVector(normal, 0.06).addScaledVector(_along, (Math.random() - 0.5) * 0.5);
    p.pos.y += (Math.random() - 0.3) * 0.2;
    // spray: a FAN across the rail's plane — up, out over the rail or back into the road — so seen from
    // behind (the chase camera) the streaks cross the view instead of pointing at it
    _dir.copy(normal).multiplyScalar(Math.random() < 0.55 ? -(0.3 + Math.random() * 0.9) : 0.2 + Math.random() * 0.7);
    _dir.y += 0.5 + Math.random() * 1.1;
    _dir.addScaledVector(_along, (Math.random() - 0.5) * 0.6);
    _dir.normalize();
    const spray = THREE.MathUtils.lerp(s.sprayMin, s.sprayMax, Math.random()) * (0.6 + 0.4 * k);
    p.vel.copy(carVel).multiplyScalar(THREE.MathUtils.lerp(s.inheritMin, s.inheritMax, Math.random())).addScaledVector(_dir, spray);
    p.maxLife = p.life = THREE.MathUtils.lerp(s.lifeMin, s.lifeMax, Math.random());
    p.groundY = groundY;
    p.bounced = false;
  }

  /** A quad along the spark's motion SEEN FROM THE CAMERA (its velocity less the camera's), stretched by
   * that speed, facing the camera; brightest at the lead. */
  function write(i, p, alpha) {
    _tan.copy(p.vel).sub(camVel);
    const speed = _tan.length();
    if (speed > 1e-4) _tan.multiplyScalar(1 / speed); else _tan.set(0, 1, 0);
    _side.copy(_cam).sub(p.pos);
    _bit.crossVectors(_tan, _side);
    if (_bit.lengthSq() < 1e-8) _bit.set(1, 0, 0); else _bit.normalize();
    const half = Math.min(s.maxStreak, s.width + speed * s.stretch) * 0.5, wide = s.width * 0.5;
    const po = i * POS_F, co = i * COL_F;
    for (let v = 0; v < VERTS; v++) {
      const [u, w] = _CORNERS[v];
      _a.copy(_tan).multiplyScalar(u * half);
      _b.copy(_bit).multiplyScalar(w * wide);
      const o = po + v * 3;
      positions[o] = p.pos.x + _a.x + _b.x;
      positions[o + 1] = p.pos.y + _a.y + _b.y;
      positions[o + 2] = p.pos.z + _a.z + _b.z;
      const lead = u > 0 ? 1 : 0.25;
      const c = co + v * 4;
      colors[c] = _tint.r * lead; colors[c + 1] = _tint.g * lead; colors[c + 2] = _tint.b * lead; colors[c + 3] = alpha * lead;
    }
  }

  /** The contact's flare: a soft disc facing the camera (hot centre, the rim at 0), flickering. */
  function writeFlare(point, normal, k) {
    const pa = flareGeo.attributes.position.array, ca = flareGeo.attributes.color.array;
    _cr.setFromMatrixColumn(camera.matrixWorld, 0);
    _cu.setFromMatrixColumn(camera.matrixWorld, 1);
    const r = s.flare.size * (0.55 + 0.45 * k) * (0.8 + Math.random() * 0.4);
    _a.copy(point).addScaledVector(normal, 0.08);
    const a = s.flare.intensity * (0.6 + 0.4 * k);
    for (let t = 0; t < FAN; t++) {
      const a0 = (t / FAN) * Math.PI * 2, a1 = ((t + 1) / FAN) * Math.PI * 2;
      const pts = [[0, 0, 1], [Math.cos(a0), Math.sin(a0), 0], [Math.cos(a1), Math.sin(a1), 0]];
      for (let j = 0; j < 3; j++) {
        const [x, y, centre] = pts[j];
        const o = (t * 3 + j) * 3, c = (t * 3 + j) * 4;
        pa[o] = _a.x + (_cr.x * x + _cu.x * y) * r;
        pa[o + 1] = _a.y + (_cr.y * x + _cu.y * y) * r;
        pa[o + 2] = _a.z + (_cr.z * x + _cu.z * y) * r;
        ca[c] = _flare.r * centre; ca[c + 1] = _flare.g * centre; ca[c + 2] = _flare.b * centre; ca[c + 3] = a * centre;
      }
    }
    flareGeo.attributes.position.needsUpdate = true;
    flareGeo.attributes.color.needsUpdate = true;
  }

  let camera = null;
  const camVel = new THREE.Vector3(), lastCam = new THREE.Vector3();
  let hasLastCam = false;
  function reset() {
    for (const p of particles) p.life = 0;
    accum = 0; flareK = 0;
    geometry.setDrawRange(0, 0);
    mesh.visible = flare.visible = false;
  }

  return {
    settings: s, mesh, flare, particles, reset,
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; if (!enabled) reset(); },
    /** Each frame, after the car and the camera moved. */
    updateFromVehicle(vehicle, cam, dt) {
      camera = cam;
      camera.updateMatrixWorld();
      _cam.setFromMatrixPosition(camera.matrixWorld);
      // the camera's velocity (it follows the car): kept when paused (dt 0), so a frozen frame looks as it moved
      if (dt > 0) {
        if (hasLastCam) camVel.copy(_cam).sub(lastCam).multiplyScalar(1 / dt);
        if (camVel.lengthSq() > 200 * 200) camVel.set(0, 0, 0); // a cut (respawn, camera switch)
        lastCam.copy(_cam);
        hasLastCam = true;
      }
      _hot.set(s.colorHot); _cool.set(s.colorCool); _flare.set(s.flare.color);
      let k = 0;
      // the vehicle's LATCHED scrape (it holds across the tick-rate flicker of the contact)
      if (enabled && dt > 0 && vehicle?.enabled && vehicle.scraping && vehicle.scrapeSpeed > s.minSpeed) {
        k = THREE.MathUtils.clamp((vehicle.scrapeSpeed - s.minSpeed) / (s.fullSpeed - s.minSpeed), 0, 1);
      }
      if (k > 0) {
        accum += s.emitRate * (0.25 + 0.75 * k) * dt;
        const groundY = vehicle.body.pos.y - 0.6;
        while (accum >= 1) { emit(vehicle.scrapePoint, vehicle.scrapeNormal, vehicle.body.vel, k, groundY); accum -= 1; }
      } else accum = 0;
      // the flare follows the scrape, fading out over a few frames
      flareK = k > 0 ? Math.max(flareK, k) : Math.max(0, flareK - dt * 8);
      if (dt > 0) {
        flare.visible = flareK > 0.02;
        if (flare.visible) writeFlare(vehicle.scrapePoint, vehicle.scrapeNormal, flareK);
      }

      let alive = 0;
      for (const p of particles) {
        if (p.life <= 0) continue;
        p.life -= dt;
        if (p.life <= 0) continue;
        p.vel.y -= s.gravity * dt;
        p.vel.multiplyScalar(Math.max(0, 1 - s.drag * dt));
        p.pos.addScaledVector(p.vel, dt);
        if (!p.bounced && p.pos.y < p.groundY && p.vel.y < 0) {
          p.pos.y = p.groundY;
          p.vel.y *= -s.bounce;
          p.vel.x *= 0.7; p.vel.z *= 0.7;
          p.bounced = true;
        }
        const age = 1 - p.life / p.maxLife;
        _tint.copy(_hot).lerp(_cool, Math.min(1, age * 2.5)); // white-hot only at the start
        const near = THREE.MathUtils.smoothstep(p.pos.distanceTo(_cam), s.nearFade[0], s.nearFade[1]);
        write(alive++, p, (1 - age * age) * s.intensity * near);
      }
      geometry.setDrawRange(0, alive * VERTS);
      mesh.visible = alive > 0;
      if (alive) {
        geometry.attributes.position.addUpdateRange(0, alive * POS_F);
        geometry.attributes.position.needsUpdate = true;
        geometry.attributes.color.addUpdateRange(0, alive * COL_F);
        geometry.attributes.color.needsUpdate = true;
      }
    },
    /** live sparks (the lab's readout) */
    alive() { return particles.reduce((n, p) => n + (p.life > 0 ? 1 : 0), 0); },
  };
}
