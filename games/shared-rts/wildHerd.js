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
 */
export function createWildHerd(app, tpl, spots, { canStand, threats = () => [], walkSpeed = 0.9, runSpeed = 7, name = "Wild", bolt = true, roam = 20 } = {}) {
  if (!spots.length) return null;
  const box = new THREE.Box3().setFromObject(tpl.root);
  const baseH = Math.max(0.01, box.max.y - box.min.y);
  const clips = {};
  for (const [k, n] of Object.entries(CLIP_NAMES)) { const c = tpl.clips.find((q) => q.name === n); if (c) clips[k] = c; }
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
  }));
  const go = (h, state, key, timer) => {
    const next = clips[key] ? key : "eat";
    if (next !== h.cur) { h.prev = h.cur; h.tPrev = h.tCur; h.cur = next; h.tCur = 0; h.fade = 0; }
    h.state = state;
    h.timer = timer;
  };
  const pathClear = (h, x, z) => {
    for (let f = 0.2; f <= 1.001; f += 0.2) if (canStand(h.x + (x - h.x) * f, h.z + (z - h.z) * f) == null) return false;
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
  let alarmT = 0;
  return {
    mesh: field.mesh, count: spots.length,
    get herd() { return herd.map((h) => ({ state: h.state, at: [+h.x.toFixed(1), +h.z.toFixed(1)] })); },
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
      field.begin();
      for (const h of herd) {
        // One of them spooked: its group bolts (whoever is within 60 m of the
        // threat — not every deer of the kind on the map), each its own way.
        // (A WALKING deer with no clear flight kept its walk target: assigning
        // the null left it walking at nothing — "reading 'x'", 2026-09-26.)
        const flee = near && h.state !== "run" && (near.x - h.x) ** 2 + (near.z - h.z) ** 2 < 60 * 60 ? pickFlight(h, near) : null;
        if (flee) { h.target = flee; h.speed = runSpeed * (0.9 + rnd() * 0.2); go(h, "run", "run", 14); }
        h.tCur += dt * h.rate * (h.state === "run" ? h.speed / runSpeed : 1);
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
          const y = canStand(nx, nz);
          if (y != null) { h.x = nx; h.z = nz; h.y += (y - h.y) * Math.min(1, dt * 6); }
          if (dist < 0.5 || y == null || h.timer < 0) {
            if (h.state === "run") h.home = { x: h.x, z: h.z };   // settles where it stopped
            h.speed = walkSpeed;
            go(h, "look", "idle", 2 + rnd() * 3);                 // stands and listens first
          }
        } else if (h.timer <= 0) {
          const r = rnd();
          if (h.state === "eat" && r < 0.4) go(h, "look", r < 0.2 ? "idle" : "look", 2 + rnd() * 4);
          else if (r < 0.75 && (h.target = pickGraze(h))) { h.speed = walkSpeed; go(h, "walk", "walk", 10); }   // (not walking here: a null is harmless)
          else go(h, "eat", rnd() < 0.25 ? "low" : "eat", 5 + rnd() * 10);
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
