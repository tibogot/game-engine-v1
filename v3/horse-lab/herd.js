// ── Horse lab: a sheep herd that reacts to the horse ─────────────────────────
// The start of herding. Each sheep steers by a few simple urges, summed:
//
//   flee        away from a threat inside its FLIGHT ZONE (the horse — wider
//               the faster it comes — or the robot on foot), harder the closer
//   bunch       toward the neighbours it can see: pressed, sheep pull together
//               (the flock instinct is what lets a rider move them as one)
//   follow      the neighbours' way when they move (one bolts, the rest go)
//   space       never on top of each other
//   walls       fences and walls push them off and make them slide along
//               (driven at a fence they flow along it — toward a gate)
//   calm        no pressure: graze, take a step now and then, drift back to
//               the group when left behind
//
// Drawn as ONE GPU crowd (v3/render/crowdSkinning.js): the clips are baked
// once, every sheep is a matrix + two clip times + a blend — one draw (and one
// shadow draw) for the whole herd, no mixer per sheep.
//
// Moves are along the sheep's own heading (turn, then walk — no sliding
// sideways), and the clip follows the speed: Eating / Idle_2 (look up, alert) /
// Walk (time-scaled) / Gallop (the run). Hard limits after the steering: never
// through a fence, never inside the horse's body.
//
// Segments: [{ ax, az, bx, bz }] — fences and walls as lines on the ground.
import * as THREE from "three";
import { createCrowdField } from "../render/crowdSkinning.js";

export const HERD = {
  flight: 5,            // m: flight zone of a walking horse (or the robot on foot: 0.7×)
  flightRun: 8,         // m more at a gallop
  flee: 1.0,            // flee urge
  bunch: 0.55,          // pull toward the neighbours when pressed (calm: a fifth)
  follow: 0.45,         // match the moving neighbours
  space: 0.9,           // m: personal space
  wall: 1.6,            // m: a fence starts to push from here
  runMax: 4.2,          // m/s: top speed of a running sheep
  calmAfter: 2.5,       // s with no pressure before they graze again
  sight: 7,             // m: neighbours it reacts to
  showZone: true,       // draw the horse's flight zone on the ground
};

const V = THREE.Vector3;
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

// closest point on a segment, and the distance to it
function closest(s, x, z) {
  const dx = s.bx - s.ax, dz = s.bz - s.az, L2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / L2));
  const px = s.ax + dx * t, pz = s.az + dz * t;
  return { px, pz, d: Math.hypot(x - px, z - pz) };
}
// does the move a→b cross the segment?
function crosses(s, ax, az, bx, bz) {
  const o = (px, pz, qx, qz, rx, rz) => Math.sign((qx - px) * (rz - pz) - (qz - pz) * (rx - px));
  return o(ax, az, bx, bz, s.ax, s.az) !== o(ax, az, bx, bz, s.bx, s.bz) && o(s.ax, s.az, s.bx, s.bz, ax, az) !== o(s.ax, s.az, s.bx, s.bz, bx, bz);
}

export function createHerd(scene, tpl, spots, { segments = [], renderer } = {}) {
  let seed = 9001;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const clip = (n) => tpl.clips.find((c) => c.name === n);
  const CL = { eat: clip("Eating"), idle: clip("Idle"), look: clip("Idle_2") ?? clip("Idle"), low: clip("Idle_Headlow") ?? clip("Eating"), walk: clip("Walk"), run: clip("Gallop") };
  const field = createCrowdField({ scene, renderer, source: tpl.source, animRoot: tpl.root, clips: CL, max: spots.length, castShadow: true });
  field.mesh.name = "Sheep";
  field.mesh.receiveShadow = true;
  const R = 0.38;                                          // body radius (m)
  // the template's root is unscaled: its BUILT size is tpl.height (the walk /
  // run speeds are at that size) — scale each sheep to it × its own variation
  const box = new THREE.Box3().setFromObject(tpl.root), base = tpl.height / Math.max(0.01, box.max.y - box.min.y);

  const sheep = spots.map((s, i) => {
    const k = s.lamb ? 0.6 : 0.9 + rnd() * 0.2;
    const sh = {
      i, k, x: s.x, z: s.z, yaw: rnd() * Math.PI * 2, v: 0,
      vx: 0, vz: 0, press: 0, calm: 0, timer: rnd() * 6, goal: null, rate: 0.9 + rnd() * 0.2,
      anim: "", t: 0, ts: 1, prev: "eat", tPrev: 0, tsPrev: 1, fade: 1,      // the crowd pose: prev → anim by fade
    };
    play(sh, rnd() < 0.7 ? "eat" : "low", rnd());
    return sh;
  });

  function play(sh, name, phase = 0) {
    if (sh.anim === name) return;
    if (sh.anim) { sh.prev = sh.anim; sh.tPrev = sh.t; sh.tsPrev = sh.ts; sh.fade = 0; }
    else { sh.prev = name; sh.fade = 1; }
    sh.anim = name; sh.t = phase * field.duration(name); sh.ts = 1;
  }
  const mtx = new THREE.Matrix4(), qY = new THREE.Quaternion(), pV = new THREE.Vector3(), sV = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);

  // flight-zone ring (debug)
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 64), new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0.55, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.renderOrder = 2;
  scene.add(ring);

  const walkV = tpl.walkSpeed, runV = tpl.runSpeed;   // at the built size (k = 1)

  /**
   * threats: [{ x, z, v, yaw, body?: { half, r } }] — the horse (with its body
   * as a capsule along its yaw) and / or the robot on foot.
   */
  function update(dt, threats) {
    if (dt <= 0) return;
    // the horse's flight zone, for the ring and the sheep
    const zones = threats.map((t) => ({ ...t, R: t.quiet ? 0 : (t.foot ? 0.7 : 1) * (HERD.flight + HERD.flightRun * Math.min(1, Math.abs(t.v) / (t.vMax ?? 5))) }));
    const H0 = zones.find((t) => !t.foot && !t.quiet);
    ring.visible = HERD.showZone && !!H0;
    if (H0) { ring.position.x = H0.x; ring.position.z = H0.z; ring.scale.setScalar(H0.R); }

    for (const sh of sheep) {
      let fx = 0, fz = 0, press = 0;
      // flee
      for (const t of zones) {
        const dx = sh.x - t.x, dz = sh.z - t.z, d = Math.hypot(dx, dz) || 1e-3;
        if (d < t.R) {
          const p = 1 - d / t.R;
          press = Math.max(press, p);
          fx += dx / d * p * HERD.flee * 2.2; fz += dz / d * p * HERD.flee * 2.2;
        }
      }
      // neighbours
      let cx = 0, cz = 0, n = 0, ax = 0, az = 0, an = 0, sx = 0, sz = 0, pressN = 0;
      for (const o of sheep) {
        if (o === sh) continue;
        const dx = o.x - sh.x, dz = o.z - sh.z, d = Math.hypot(dx, dz);
        if (d > HERD.sight) continue;
        cx += o.x; cz += o.z; n++;
        if (o.v > 0.3) { ax += o.vx; az += o.vz; an++; }
        pressN = Math.max(pressN, o.press * (1 - d / HERD.sight));   // a neighbour running scares it too
        if (d < HERD.space && d > 1e-3) { const q = (HERD.space - d) / HERD.space; sx -= dx / d * q * 2.5; sz -= dz / d * q * 2.5; }
      }
      press = Math.max(press, pressN * 0.6);
      sh.press = press;
      if (press > 0.02) sh.calm = 0; else sh.calm += dt;
      const bunchW = HERD.bunch * (press > 0.02 ? 1 : 0.2);
      if (n) { const dx = cx / n - sh.x, dz = cz / n - sh.z, d = Math.hypot(dx, dz) || 1; const w = bunchW * Math.min(1, d / 3); fx += dx / d * w; fz += dz / d * w; }
      if (an && press > 0.02) { fx += ax / an / Math.max(1, runV) * HERD.follow * 2; fz += az / an / Math.max(1, runV) * HERD.follow * 2; }
      fx += sx; fz += sz;

      // calm: graze, the odd step, back to the group
      if (press <= 0.02 && sh.calm > HERD.calmAfter) {
        sh.timer -= dt;
        if (sh.goal) {
          const dx = sh.goal.x - sh.x, dz = sh.goal.z - sh.z, d = Math.hypot(dx, dz);
          if (d < 0.3 || sh.timer < -8) sh.goal = null;
          else { fx += dx / d * 0.35; fz += dz / d * 0.35; }
        } else if (sh.timer <= 0) {
          sh.timer = 4 + rnd() * 9;
          const far = n === 0 || Math.hypot(cx / Math.max(1, n) - sh.x, cz / Math.max(1, n) - sh.z) > 5;
          if (far && n) sh.goal = { x: cx / n + (rnd() - 0.5) * 2, z: cz / n + (rnd() - 0.5) * 2 };
          else if (rnd() < 0.5) { const a = rnd() * 6.283, d = 0.8 + rnd() * 2; sh.goal = { x: sh.x + Math.cos(a) * d, z: sh.z + Math.sin(a) * d }; }
        }
      } else sh.goal = null;

      // walls: push off, and slide along when driven at them
      for (const s of segments) {
        const c = closest(s, sh.x, sh.z);
        if (c.d < HERD.wall && c.d > 1e-3) {
          const nx = (sh.x - c.px) / c.d, nz = (sh.z - c.pz) / c.d, q = (HERD.wall - c.d) / HERD.wall;
          const into = -(fx * nx + fz * nz);                     // how hard it is pushed into the fence
          if (into > 0) { fx += nx * into; fz += nz * into; }   // that part is cancelled: it slides along
          fx += nx * q * q * 1.5; fz += nz * q * q * 1.5;
        }
      }

      // speed + heading from the urge
      const want = Math.hypot(fx, fz);
      let tv = 0;
      if (want > 0.12) tv = press > 0.02 ? Math.min(HERD.runMax * sh.k, walkV * sh.k + want * HERD.runMax * 0.9) : Math.min(walkV * sh.k, want * walkV * 2.5);
      const tyaw = want > 0.05 ? Math.atan2(fx, fz) : sh.yaw;
      const turn = (press > 0.02 ? 5 : 2.2) * dt;
      sh.yaw += Math.max(-turn, Math.min(turn, angDiff(tyaw, sh.yaw)));
      const along = Math.max(0, Math.cos(angDiff(tyaw, sh.yaw)));   // turn first, then go
      const acc = tv > sh.v ? 5 : 3.5;
      sh.v += Math.max(-acc * dt, Math.min(acc * dt, tv * along - sh.v));
      sh.vx = Math.sin(sh.yaw) * sh.v; sh.vz = Math.cos(sh.yaw) * sh.v;
      let nx = sh.x + sh.vx * dt, nz = sh.z + sh.vz * dt;

      // hard limits: never through a fence, never in the horse
      for (const s of segments) {
        if (crosses(s, sh.x, sh.z, nx, nz)) { nx = sh.x; nz = sh.z; sh.v *= 0.3; }
        const c = closest(s, nx, nz);
        if (c.d < R && c.d > 1e-4) { nx = c.px + (nx - c.px) / c.d * R; nz = c.pz + (nz - c.pz) / c.d * R; }
      }
      for (const t of threats) {
        if (!t.body) continue;
        const fwx = Math.sin(t.yaw), fwz = Math.cos(t.yaw);
        const s = { ax: t.x - fwx * t.body.half, az: t.z - fwz * t.body.half, bx: t.x + fwx * t.body.half, bz: t.z + fwz * t.body.half };
        const c = closest(s, nx, nz), r = t.body.r + R;
        if (c.d < r && c.d > 1e-4) { nx = c.px + (nx - c.px) / c.d * r; nz = c.pz + (nz - c.pz) / c.d * r; }
      }
      sh.x = nx; sh.z = nz;

      // clip from speed
      const sp = sh.v / sh.k;                                  // in the clip's own units (a smaller sheep steps faster)
      if (sh.v < 0.06) play(sh, press > 0.05 || sh.calm < HERD.calmAfter ? "look" : sh.anim === "low" ? "low" : "eat");
      else if (sh.v < walkV * 1.7 * sh.k) { play(sh, "walk"); sh.ts = Math.max(0.4, sp / walkV); }
      else { play(sh, "run"); sh.ts = Math.max(0.6, Math.min(1.6, sp / runV)); }
      if (sh.v < 0.06) sh.ts = sh.rate;
      sh.t += dt * sh.ts; sh.tPrev += dt * sh.tsPrev; sh.fade = Math.min(1, sh.fade + dt / 0.3);
    }
    // draw: one pose per sheep into the crowd
    field.begin();
    for (const sh of sheep) {
      mtx.compose(pV.set(sh.x, 0, sh.z), qY.setFromAxisAngle(UP, sh.yaw), sV.setScalar(base * sh.k));
      field.addPose(mtx, sh.prev, sh.tPrev, sh.anim, sh.t, sh.fade);
    }
    field.commit();
  }

  // sheep inside a polygon pen ([[x, z], …])
  const inside = (poly, x, z) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i], [xj, zj] = poly[j];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  const countIn = (poly) => sheep.filter((s) => inside(poly, s.x, s.z)).length;

  return { sheep, update, countIn, ring, field };
}
