// LIFE ON THE MAP, CHEAP (you, 2026-09-30): dust behind the vehicles, smoke
// from the villages' bread ovens. Each is ONE instanced draw of soft,
// unlit sprites (shared-rts/spriteField.js), drifting with the game's one
// wind (algWind.js) — no lights, no compute, a few hundred quads at most.
//
//   DUST   a moving vehicle (not the men, not the aircraft) throws a puff off
//          its rear every ~0.1 s, more the faster it goes: tan, growing to a
//          few metres, blown downwind, gone in ~3 s.
//   SMOKE  a few houses in each village have their tabouna lit: a thin grey
//          plume rising and leaning with the wind. Not every house, not all
//          day — each oven burns for a while, then rests.
import * as THREE from "three";
import { createSpriteField } from "../shared-rts/spriteField.js";
import { createTrackMarks } from "../shared-rts/trackMarks.js";
import { LAYOUT } from "./layout.js";

const DUST = { max: 360, every: 0.09, life: 2.8, minSpeed: 2 };
const SMOKE = { perVillage: 3, every: 0.15, life: 6 };
// TYRE AND TRACK MARKS (shared-rts/trackMarks.js, one draw): a stretch every
// 1.8 m a vehicle moves. Half gauge and rut width per vehicle, real × 1.3
// (the man-made scale); `track`: links, not a tyre (the half-track's rear).
const MARKS = { step: 1.8, life: 50 };
const GAUGE = {
  willys: { gauge: 0.82, rut: 0.3 },
  gmc: { gauge: 1.12, rut: 0.42 },
  ebr: { gauge: 1.3, rut: 0.42 },
  halftrack: { gauge: 1.1, rut: 0.42, track: true },
  amx13: { gauge: 1.42, rut: 0.5, track: true },
};

export function createAlgAmbience(app, { units, showroom, wind = null }) {
  // Normal blending (dust and smoke hide what is behind them; they do not
  // glow), no bloom.
  const dust = createSpriteField({
    scene: app.scene, max: DUST.max, color: 0xe2d2b4, size: 1, bloomScale: 0, blending: THREE.NormalBlending,
    scaleAt: (p) => 1.4 + (1 - p) * 4.2, fadeAt: (p) => 0.6 * Math.min(1, (1 - p) * 6) * Math.sqrt(p),
  });
  dust.mesh.name = "VehicleDust";
  const smoke = createSpriteField({
    scene: app.scene, max: 960, color: 0x6d6a66, size: 1, bloomScale: 0, blending: THREE.NormalBlending,
    scaleAt: (p) => 0.9 + (1 - p) * 4.4, fadeAt: (p) => 0.85 * Math.min(1, (1 - p) * 8) * Math.sqrt(p),
  });
  smoke.mesh.name = "OvenSmoke";
  /*
   * THE SMOKE AND DUST AT NIGHT. They are unlit sprites of a fixed colour: at night the oven
   * plumes stood out bright white over the dark ksar (2026-10-04). Their colour follows the
   * light: x1 by day, x~0.025 at full night — the moonlit ground's share of the sunlit ground's
   * radiance after exposure (MEASURED: 0.0034 vs ~0.3, exposure 2.2 vs 1.26).
   */
  const DUST_RGB = new THREE.Color(0xe2d2b4), SMOKE_RGB = new THREE.Color(0x6d6a66);
  let litNight = -1;
  app.addPreRenderHook(function algSmokeAtNight() {
    const n = app.sky?.night ?? 0;
    if (Math.abs(n - litNight) < 0.005) return;
    litNight = n;
    const k = 1 + (0.025 - 1) * n;
    dust.mesh.material.color.copy(DUST_RGB).multiplyScalar(k);
    smoke.mesh.material.color.copy(SMOKE_RGB).multiplyScalar(k);
    // the fog of war's shroud grey and unexplored black: the same fixed-colour problem
    app.fogOfWar?.setLightLevel?.(k);
  });
  const marks = createTrackMarks({ app, life: MARKS.life });
  const laidAt = new Map();     // vehicle → { x, z } of its last mark

  // ── The ovens: a few houses per village, their roofs ───────────────────
  const ovens = [];
  const ray = new THREE.Raycaster();
  let seed = 977;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const [key, o] of Object.entries(showroom ?? {})) {
    const houses = o?.isObject3D ? o.geometry?.userData?.houses : null;
    if (!houses?.length || !/^(mechta|dechra|ksar)/.test(key)) continue;
    const c = Math.cos(o.rotation.y), s = Math.sin(o.rotation.y);
    const pool = houses.filter((h) => !h.mosque);
    for (let k = 0; k < SMOKE.perVillage && pool.length; k++) {
      const h = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
      const x = o.position.x + h.x * c + h.z * s, z = o.position.z - h.x * s + h.z * c;
      // From the ROOF it stands on (a ray down onto the village: a ksar house
      // is 6 m tall on a slope — a fixed height put the plume inside it).
      ray.set(new THREE.Vector3(x, 400, z), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObject(o, false)[0];
      ovens.push({ x, z, y: (hit ? hit.point.y : app.getWorldHeight(x, z) + 4) + 0.6, t: rnd() * SMOKE.every, burn: rnd() < 0.7, next: 30 + rnd() * 90 });
    }
  }

  const last = new Map();       // unit → { x, z, t }
  let clock = 0;
  function frame(dt) {
    dt = Math.min(dt, 0.1);
    clock += dt;
    // The wind: direction (flags' convention: along (cos d, sin d)) and speed.
    const wd = wind ? wind.dirRad(clock) : 3.5, ws = wind ? wind.speed(clock) : 0.5;
    const wx = Math.cos(wd) * ws * 2.2, wz = Math.sin(wd) * ws * 2.2;

    for (const u of units?.list ?? []) {
      if (!u.alive || u.isAir || u.type?.foot || u.isStructure) continue;
      const p = u.position;
      let L = last.get(u);
      if (!L) { last.set(u, { x: p.x, z: p.z, t: 0 }); continue; }
      const v = Math.hypot(p.x - L.x, p.z - L.z) / Math.max(dt, 1e-3);
      L.x = p.x; L.z = p.z;
      // Its marks: every MARKS.step metres, from the last mark to here.
      const g = GAUGE[u.typeKey];
      if (g) {
        const M = laidAt.get(u);
        if (!M) laidAt.set(u, { x: p.x, z: p.z });
        else {
          const dx = p.x - M.x, dz = p.z - M.z, d = Math.hypot(dx, dz);
          if (d > 6) { M.x = p.x; M.z = p.z; }            // a jump (spawned, teleported): no streak
          else if (d >= MARKS.step) {
            const mx = (p.x + M.x) / 2, mz = (p.z + M.z) / 2;
            if ((app.getWaterLevelAt?.(mx, mz) ?? -Infinity) < app.getWorldHeight(mx, mz)) {
              marks.lay(mx, mz, Math.atan2(dx, dz), d + 0.3, g.gauge, g.rut, !!g.track);
            }
            M.x = p.x; M.z = p.z;
          }
        }
      }
      if (v < DUST.minSpeed) continue;
      L.t -= dt * Math.min(2, v / 8);
      if (L.t > 0) continue;
      L.t = DUST.every;
      const h = u.heading ?? 0, back = (u.radius ?? 3) * 0.75, side = (Math.random() - 0.5) * (u.radius ?? 3) * 0.6;
      const x = p.x - Math.sin(h) * back + Math.cos(h) * side, z = p.z - Math.cos(h) * back - Math.sin(h) * side;
      const y = app.getWorldHeight(x, z) + 0.6;
      if ((app.getWaterLevelAt?.(x, z) ?? -Infinity) > y - 0.6) continue;    // no dust off water
      dust.spawn(x, y, z, DUST.life * (0.8 + Math.random() * 0.4), {
        vx: wx + (Math.random() - 0.5) * 0.6, vy: 0.35 + Math.random() * 0.3, vz: wz + (Math.random() - 0.5) * 0.6,
        scale: 0.8 + Math.min(1, v / 14) * 0.7,
      });
    }
    for (const o of ovens) {
      o.next -= dt;
      if (o.next <= 0) { o.burn = !o.burn; o.next = o.burn ? 60 + Math.random() * 120 : 40 + Math.random() * 80; }
      if (!o.burn) continue;
      o.t -= dt;
      if (o.t > 0) continue;
      o.t = SMOKE.every * (0.7 + Math.random() * 0.6);
      smoke.spawn(o.x + (Math.random() - 0.5) * 0.4, o.y, o.z + (Math.random() - 0.5) * 0.4, SMOKE.life * (0.8 + Math.random() * 0.4), {
        vx: wx * 0.7, vy: 0.8 + Math.random() * 0.3, vz: wz * 0.7, scale: 0.9 + Math.random() * 0.4,
      });
    }
    // Burning and smouldering places (algDamage.js): dense dark smoke, fading
    // out over the last third of their time.
    for (let i = smoulders.length - 1; i >= 0; i--) {
      const o = smoulders[i];
      o.left -= dt;
      if (o.left <= 0) { smoulders.splice(i, 1); continue; }
      o.t -= dt;
      if (o.t > 0) continue;
      const k = Math.min(1, o.left / (o.total / 3));
      o.t = (SMOKE.every * 0.6) / Math.max(0.25, k * o.strength);
      smoke.spawn(o.x + (Math.random() - 0.5) * o.r, o.y, o.z + (Math.random() - 0.5) * o.r, SMOKE.life * 1.3, {
        vx: wx * 0.8, vy: 1.1 + Math.random() * 0.5, vz: wz * 0.8, scale: (1.3 + Math.random() * 0.6) * (0.6 + 0.4 * o.strength),
      });
    }
    dust.update(dt, app.camera);
    smoke.update(dt, app.camera);
    marks.tick(dt);
  }
  const smoulders = [];
  app.addPreRenderHook(frame);
  return {
    dust, smoke, ovens, marks,
    /**
     * A place that burns and smokes for `seconds` (a shelled house, a
     * damaged building): `strength` 0-1 how thick, `r` how wide it rises.
     * Returns a handle; `stop(h)` ends it early.
     */
    smoulder(x, y, z, seconds, { strength = 1, r = 1.5 } = {}) {
      const h = { x, y, z, left: seconds, total: seconds, t: 0, strength, r };
      smoulders.push(h);
      return h;
    },
    stop(h) { const i = smoulders.indexOf(h); if (i >= 0) smoulders.splice(i, 1); },
  };
}
