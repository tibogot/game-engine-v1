// WILD HERD — a kind of animal as ONE GPU crowd draw: they graze, wander a few
// metres from home, look up, and BOLT from soldiers. Moved from
// nam-rts/wildAnimals.js (2026-09-27) when alg-rts's goats and sheep needed the
// same behaviour; nam's wildAnimals.js re-exports it unchanged.
//
// A template is { root, source, clips } — the donkey-pack format: `source` a
// SkinnedMesh (position / normal / skin / colour) bound at identity, `root`
// the object holding its bones, `clips` the pack's clips by name.
import * as THREE from "three";
import { createCrowdField } from "./crowdSkinning.js";

const CLIP_NAMES = { eat: "Eating", idle: "Idle", look: "Idle_2", low: "Idle_Headlow", walk: "Walk", run: "Gallop" };

/**
 * One kind of animal as a crowd: `spots` [{ x, z, height }] (height in metres,
 * per animal), `canStand(x, z)` → ground y or null, `threats()` → positions of
 * whoever makes them bolt. Returns { update(dt), mesh, count, herd }.
 * `bolt: false` — working animals (a tethered donkey) never run from soldiers;
 * `roam` — how far one grazes from its spot (m). Defaults: the wild behaviour.
 *
 * A MOVING HOME (optional, per spot — nam's wild animals use none): `anchor`
 * { x, z, yaw, moving } that the GAME moves, and `off` { x, z } the animal's
 * place in the anchor's frame (x right, z forward). Its home follows. With
 * `follow: "loose"` (a flock) it grazes as ever and walks to catch up when the
 * home has drifted past `roam`, trotting when far behind — the flock drifts
 * across a pasture in bursts, bunched, and regroups after a bolt (with
 * `anchor.trail`, the home's recent points, it follows the home's own way
 * round what is in between). With
 * `follow: "tight"` (a donkey on a lead) it keeps walking at the home while
 * the anchor moves, and only grazes when it stops.
 */
export function createWildHerd(app, tpl, spots, { canStand, threats = () => [], walkSpeed = 0.9, runSpeed = 7, name = "Wild", bolt = true, roam = 20, clipNames = CLIP_NAMES } = {}) {
  if (!spots.length) return null;
  const box = new THREE.Box3().setFromObject(tpl.root);
  const baseH = Math.max(0.01, box.max.y - box.min.y);
  const clips = {};
  // `clipNames`: another pack's clips for the same behaviours (alg-rts' hens:
  // one idle with its own pecking for eat / idle / look / low).
  for (const [k, n] of Object.entries(clipNames)) { const c = tpl.clips.find((q) => q.name === n); if (c) clips[k] = c; }
  const field = createCrowdField({
    scene: app.scene, renderer: app.renderer, source: tpl.source, animRoot: tpl.root, clips, max: spots.length, castShadow: true,
  });
  field.mesh.name = name;
  let seed = 7331 + spots.length * 17;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const herd = spots.map((s) => ({
    x: s.x, z: s.z, y: canStand(s.x, s.z) ?? app.getWorldHeight(s.x, s.z), yaw: rnd() * Math.PI * 2,
    scale: s.height / baseH, home: { x: s.x, z: s.z },
    cur: "eat", tCur: rnd() * 10, prev: "eat", tPrev: 0, fade: 1, rate: 0.85 + rnd() * 0.3,
    state: "eat", timer: 3 + rnd() * 10, target: null, speed: walkSpeed,
    anchor: s.anchor ?? null, off: s.off ?? null, follow: s.follow ?? "loose", vel: 0,
    // `anyGround`: goes wherever its lead goes (a pack animal led by men over
    // ground its herd's canStand refuses — alg-rts' FLN mule train).
    anyGround: !!s.anyGround,
  }));
  /** An anchored animal's home: its place in the anchor's (moving) frame. */
  const homeFromAnchor = (h) => {
    const A = h.anchor, c = Math.cos(A.yaw ?? 0), s = Math.sin(A.yaw ?? 0);
    h.home.x = A.x + h.off.x * c + h.off.z * s;
    h.home.z = A.z - h.off.x * s + h.off.z * c;
  };
  const go = (h, state, key, timer) => {
    const next = clips[key] ? key : "eat";
    if (next !== h.cur) { h.prev = h.cur; h.tPrev = h.tCur; h.cur = next; h.tCur = 0; h.fade = 0; }
    h.state = state;
    h.timer = timer;
    h.clearTo = false;   // a new walk: its line is not known to be clear
  };
  const pathClear = (h, x, z) => {
    for (let f = 0.2; f <= 1.001; f += 0.2) if (canStand(h.x + (x - h.x) * f, h.z + (z - h.z) * f) == null) return false;
    return true;
  };
  /** Every 2 m (pathClear's five samples miss a house on a 60 m line). */
  const lineClear = (h, x, z) => {
    const n = Math.max(1, Math.ceil(Math.hypot(x - h.x, z - h.z) / 2));
    // Starting on blocked ground (see the escape in update): the first few
    // metres out of it don't count against the line.
    const stuck = canStand(h.x, h.z) == null;
    for (let k = 1; k <= n; k++) {
      if (stuck && k * 2 <= 5) continue;
      if (canStand(h.x + ((x - h.x) * k) / n, h.z + ((z - h.z) * k) / n) == null) return false;
    }
    return true;
  };
  /** Fresh grazing 2-6 m off, not straying far from home. */
  const pickGraze = (h) => {
    for (let k = 0; k < 16; k++) {
      const a = rnd() * Math.PI * 2, d = Math.min(2, roam * 0.5) + rnd() * Math.min(4, roam * 0.5);
      const x = h.x + Math.sin(a) * d, z = h.z + Math.cos(a) * d;
      if (Math.hypot(x - h.home.x, z - h.home.z) > roam) continue;
      if (pathClear(h, x, z)) return { x, z };
    }
    return null;
  };
  /** Away from the threat, 40-70 m, the most open of a few headings. */
  const pickFlight = (h, t) => {
    const away = Math.atan2(h.x - t.x, h.z - t.z);
    for (const off of [0, 0.5, -0.5, 1, -1, 1.5, -1.5]) {
      const a = away + off + (rnd() - 0.5) * 0.3, d = 40 + rnd() * 30;
      const x = h.x + Math.sin(a) * d, z = h.z + Math.cos(a) * d;
      if (pathClear(h, x, z)) return { x, z };
    }
    return null;
  };
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  // Near the view only (2026-10-01, as the soldiers and vehicles): an animal
  // off screen — and too far for its shadow to reach it — is not skinned,
  // drawn or shadowed. Its walk/graze state still advances.
  const frustum = new THREE.Frustum(), viewProj = new THREE.Matrix4(), sphere = new THREE.Sphere();
  let alarmT = 0;
  return {
    mesh: field.mesh, count: spots.length,
    get herd() { return herd.map((h) => ({ state: h.state, at: [+h.x.toFixed(1), +h.z.toFixed(1)] })); },
    /** Dev: the animals' own records (state, target, home, timer…). */
    get raw() { return herd; },
    /** Dev: can this herd stand at (x, z)? */
    canStand,
    update(dt) {
      dt = Math.min(dt, 0.1);
      // Who is near? Checked a few times a second, not every frame.
      alarmT -= dt;
      let near = null;
      if (bolt && alarmT <= 0) {
        alarmT = 0.3;
        const T = threats();
        for (const h of herd) {
          if (h.state === "run") continue;
          for (const t of T) {
            if ((t.x - h.x) ** 2 + (t.z - h.z) ** 2 < 35 * 35) { near = t; break; }
          }
          if (near) break;
        }
      }
      const cam = app.camera;
      if (cam) frustum.setFromProjectionMatrix(viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
      field.begin();
      for (const h of herd) {
        // One of them spooked: its group bolts (whoever is within 60 m of the
        // threat — not every deer of the kind on the map), each its own way.
        // (A WALKING deer with no clear flight kept its walk target: assigning
        // the null left it walking at nothing — "reading 'x'", 2026-09-26.)
        const flee = near && h.state !== "run" && (near.x - h.x) ** 2 + (near.z - h.z) ** 2 < 60 * 60 ? pickFlight(h, near) : null;
        if (flee) { h.target = flee; h.speed = runSpeed * (0.9 + rnd() * 0.2); go(h, "run", "run", 14); }
        // A MOVING HOME: keep up with it (see the header).
        if (h.anchor) {
          homeFromAnchor(h);
          if (h.state !== "run") {
            const dH = Math.hypot(h.home.x - h.x, h.home.z - h.z);
            if (h.follow === "tight" && h.anchor.moving) {
              // On the lead: walk AT the home the whole time it moves.
              if (dH > 0.6 && h.state !== "walk") { h.speed = walkSpeed; go(h, "walk", "walk", 1e9); }
              if (h.state === "walk") { h.target = h.home; h.timer = 1e9; }
            } else if (h.follow === "tight" && h.state === "walk" && h.timer > 1e8) {
              h.timer = 20;                               // the lead stopped: arrive as ever
            } else if (h.follow !== "tight" && h.state !== "walk" && dH > roam * (h.state === "eat" ? 1.6 : 1)) {
              // Left behind: to its place in the flock (a trot when far) —
              // straight if nothing is in the way, else along the TRAIL the
              // home left (anchor.trail, recent points, oldest first): the
              // home went round a house, and a sheep walking straight at it
              // stood behind the wall for good (measured: stragglers 80 m back).
              const a = rnd() * Math.PI * 2, j = rnd() * roam * 0.4;
              h.target = { x: h.home.x + Math.sin(a) * j, z: h.home.z + Math.cos(a) * j };
              const tr = h.anchor.trail;
              if (tr?.length && !lineClear(h, h.target.x, h.target.z)) {
                // The NEWEST crumb it can walk to straight (the furthest along
                // the home's way), else the nearest one.
                let p = null;
                for (let i = tr.length - 1; i >= 0 && !p; i--) if (lineClear(h, tr[i].x, tr[i].z)) p = tr[i];
                if (!p) p = tr.reduce((b, q) => ((q.x - h.x) ** 2 + (q.z - h.z) ** 2 < (b.x - h.x) ** 2 + (b.z - h.z) ** 2 ? q : b));
                h.target = { x: p.x, z: p.z };
              }
              // Still no clear line (too steep for it, a wall across): a
              // SIDESTEP, 6 m at an angle, its own side first so it works
              // round the obstacle instead of dithering — measured: animals
              // stood at a slope's edge in "look" with the flock 100 m on.
              if (!lineClear(h, h.target.x, h.target.z)) {
                h.side ??= rnd() < 0.5 ? 1 : -1;
                const base = Math.atan2(h.target.x - h.x, h.target.z - h.z);
                let hop = null;
                for (const o of [0.5, 1, 1.5, 2.2, 2.8]) {
                  for (const sgn of [h.side, -h.side]) {
                    const a2 = base + o * sgn, x = h.x + Math.sin(a2) * 6, z = h.z + Math.cos(a2) * 6;
                    if (lineClear(h, x, z)) { hop = { x, z }; if (sgn !== h.side) h.side = sgn; break; }
                  }
                  if (hop) break;
                }
                if (hop) h.target = hop;
              }
              h.speed = walkSpeed * (dH > roam * 3 ? 1.8 : 1);
              // Its line was checked every 2 m: a sliver between the samples
              // (a cell corner, the slope limit's edge) does not stop it (below).
              go(h, "walk", "walk", 40);
              h.clearTo = lineClear(h, h.target.x, h.target.z);
            }
          }
        }
        // An anchored animal's walk clip runs at the pace it actually moves (a
        // flock trotting to catch up, a donkey held back by the lead): no
        // sliding feet. The wild ones keep the clip's own rate.
        const walkRate = h.anchor ? Math.max(0.35, Math.min(2, h.vel / walkSpeed)) : 1;
        h.tCur += dt * h.rate * (h.state === "run" ? h.speed / runSpeed : h.state === "walk" ? walkRate : 1);
        h.tPrev += dt * h.rate;
        h.fade = Math.min(1, h.fade + dt / (h.state === "run" ? 0.2 : 0.5));
        h.timer -= dt;
        if (h.state === "walk" || h.state === "run") {
          const t = h.target;
          const dx = t.x - h.x, dz = t.z - h.z, dist = Math.hypot(dx, dz);
          const dA = Math.atan2(Math.sin(Math.atan2(dx, dz) - h.yaw), Math.cos(Math.atan2(dx, dz) - h.yaw));
          const turn = h.state === "run" ? 3 : 1.2;
          h.yaw += Math.max(-turn * dt, Math.min(turn * dt, dA));
          const step = Math.min(dist, h.speed * dt * Math.max(0.2, Math.cos(dA)));
          const nx = h.x + Math.sin(h.yaw) * step, nz = h.z + Math.cos(h.yaw) * step;
          let y = canStand(nx, nz);
          // An anchored animal standing where it can't (a cell that became
          // blocked under it) may walk OUT: stuck, it was lost to its flock
          // for good (measured: a sheep 87 m back on a garden wall's cell).
          if (y == null && h.anchor && (h.anyGround || canStand(h.x, h.z) == null || (h.clearTo && Math.abs(dA) < 0.35))) y = app.getWorldHeight(nx, nz);
          if (y != null) { h.x = nx; h.z = nz; h.y += (y - h.y) * Math.min(1, dt * 6); }
          h.vel = y != null ? step / Math.max(1e-4, dt) : 0;
          const onLead = h.follow === "tight" && h.anchor?.moving;
          // Blocked while still TURNING toward its target (it steps along its
          // heading): an anchored animal keeps turning on the spot, and gives
          // up only when it faces the target and is still blocked. Stopping at
          // the first blocked step left sheep facing a wall for good (measured:
          // "look", the line home clear, the flock 100 m on).
          const turning = y == null && h.anchor && Math.abs(dA) > 0.35 && h.timer > 0;
          if (!turning && ((dist < 0.5 && !onLead) || y == null || h.timer < 0)) {
            if (h.state === "run" && !h.anchor) h.home = { x: h.x, z: h.z };   // settles where it stopped (an anchored one goes back to its flock)
            h.speed = walkSpeed;
            go(h, "look", "idle", 2 + rnd() * 3);                 // stands and listens first
          }
        } else if (h.timer <= 0) {
          const r = rnd();
          if (h.state === "eat" && r < 0.4) go(h, "look", r < 0.2 ? "idle" : "look", 2 + rnd() * 4);
          else if (r < 0.75 && (h.target = pickGraze(h))) { h.speed = walkSpeed; go(h, "walk", "walk", 10); }   // (not walking here: a null is harmless)
          else go(h, "eat", rnd() < 0.25 ? "low" : "eat", 5 + rnd() * 10);
        }
        if (cam) {
          sphere.center.set(h.x, h.y + baseH * h.scale * 0.5, h.z);
          sphere.radius = baseH * h.scale + 12;
          if (!frustum.intersectsSphere(sphere)) continue;
        }
        p.set(h.x, h.y, h.z);
        q.setFromAxisAngle(up, h.yaw);
        m.compose(p, q, sc.setScalar(h.scale));
        field.addPose(m, h.prev, h.tPrev, h.cur, h.tCur, h.fade);
      }
      field.commit();
    },
  };
}
