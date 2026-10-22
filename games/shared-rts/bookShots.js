// ONE-SHOT BAKED BOOKS in a game (2026-10-16 — the mortar's launch and impact, from the fire-bake
// lab; you: "we should keep using this for new ones"). GAME code, shared.
//
// A pool of book cards per book (v3/fire-bake-lab: fp_<key>_{a,b,mv}.webp + .json), made at load
// and reused — a barrage must not build cards (materials, pipelines) mid-battle; the timeline
// lab's player builds per effect, which is right for a lab and wrong here. All full: the oldest
// card gives way.
//
//   play(key, x, z, { size, tint, fireK, wind })
//     size    the card's width, m (default: the book's own)
//     tint    smoke colour [r, g, b] linear (default: the book's own)
//     wind    [wx, wz]: a book whose smoke drifts to its +X (the launch's column) is MIRRORED
//             when the wind blows to the screen's left, so it drifts the right way
//     lift    m: the book raised off the ground (a tube on a rise of its own: a pit's parapet)
//     opacity 0..1: the whole card thinner (a pale column the book bakes too dense)
//     fadeIn  0..1 of its life: faded in (a LOOP book played once starts on a full cloud — the
//             construction dust, algBuild.js — and would pop in)
//     life    s: a LOOP book cycled for this long (a wreck burning — algCombat.js), faded in over its
//             first 0.8 s and out over its last 2.5 s
//
// Lit as flameStreamFx (the scene's sun and sky); fades into the real ground (heightmap tap).
import * as THREE from "three";
import { createBookCards, loadBookTextures } from "../../v3/fire-bake-lab/bookCard.js";
import { drapeY } from "./terrainDrape.js";
import { RENDER_ORDER } from "./renderOrder.js";

const BASE = "/textures/fx/firepro/fp_";

/**
 * @param {object} o
 * @param {object} o.app
 * @param {Record<string, { pool?: number, fireK?: number, bloom?: number, speed?: number }>} o.books
 * @returns {Promise<{ play: Function, update: Function, has: (key:string)=>boolean, clear: Function }>}
 */
export async function createBookShots({ app, books }) {
  const groundAt = app.heightTexNode ? (x, z) => drapeY(app.heightTexNode, x, z) : null;
  const sets = new Map();   // key → { meta, cards: [{ c, t0, life, ... }], opts }
  await Promise.all(Object.entries(books).map(async ([key, opts]) => {
    const b = await loadBookTextures(`${BASE}${key}`).catch((e) => { console.warn(`bookShots: no ${key}`, e); return null; });
    if (!b) return;
    // ONE material for the pool (createBookCards: one shader build, not one a card)
    const cards = createBookCards(opts.pool ?? 6, { groundAt }).map((c) => {
      c.setBook(b.tex, b.meta);
      c.u.uGroundFade.value = 0.5;
      c.u.uBloom.value = opts.bloom ?? 0.12;
      c.mesh.visible = false;
      c.mesh.renderOrder = RENDER_ORDER.SMOKE;
      app.scene.add(c.mesh);
      return { c, t0: -1e9, life: 0, x: 0, z: 0, size: 0, mirror: 1, tint: null };
    });
    sets.set(key, { meta: b.meta, cards, opts });
  }));

  let clock = 0;
  const _cam = new THREE.Vector3(), _right = new THREE.Vector3(), _ctr = new THREE.Vector3();
  const _sun = new THREE.Vector3(0.3, 0.8, 0.4), _col = new THREE.Color(), _sky = new THREE.Color();

  function play(key, x, z, { size = null, tint = null, fireK = null, wind = null, lift = 0, opacity = 1, fadeIn = 0, life = null } = {}) {
    const s = sets.get(key);
    if (!s) return false;
    const card = s.cards.reduce((a, b) => (a.t0 + a.life < b.t0 + b.life ? a : b));   // free, else the oldest
    const speed = s.opts.speed ?? 1;
    Object.assign(card, { t0: clock, life: life ?? s.meta.duration / speed, loopDur: life ? s.meta.duration / speed : 0, x, z, size: size ?? s.meta.size, tint, fireK: fireK ?? s.opts.fireK ?? 0.5, wind, lift, opacity, fadeIn });
    card.c.mesh.visible = true;
    return true;
  }

  /** Every rendered frame (the cards face the camera; a paused game still draws them). */
  function update(dt, camera) {
    clock += dt;
    const L = app.light, sun = L?.sun, hemi = L?.hemi, dir = L?.getDirection?.();
    if (dir) _sun.copy(dir).normalize();
    if (sun) _col.copy(sun.color).multiplyScalar(sun.intensity * (0.4 / 0.65));
    if (hemi && hemi.intensity > 0.01) _sky.copy(hemi.color).multiplyScalar(hemi.intensity * 0.75);
    else _sky.setRGB(0.55, 0.62, 0.75).multiplyScalar((sun?.intensity ?? 3) * 0.1 * 0.75);
    camera.matrixWorld.extractBasis(_right, _cam, _cam);
    _right.y = 0; _right.normalize();
    for (const [, s] of sets) {
      const m = s.meta, bc = m.bake?.center ?? [0, m.size / 2, 0];
      for (const k of s.cards) {
        const t = clock - k.t0, age = t / k.life;
        k.c.mesh.visible = age >= 0 && age < 1;
        if (!k.c.mesh.visible) continue;
        const sc = k.size / m.size;
        // The wind on the screen: blowing left, the book (drifting to its +X) is mirrored.
        const mirror = k.wind && (k.wind[0] * _right.x + k.wind[1] * _right.z) < 0 ? -1 : 1;
        k.c.u.uFireK.value = k.fireK;
        k.c.u.uFade.value = (k.opacity ?? 1) * (k.loopDur
          ? THREE.MathUtils.smoothstep(t, 0, 0.8) * (1 - THREE.MathUtils.smoothstep(t, k.life - 2.5, k.life))
          : (1 - THREE.MathUtils.smoothstep(age, 0.85, 1)) * (k.fadeIn > 0 ? THREE.MathUtils.smoothstep(age, 0, k.fadeIn) : 1));
        k.c.u.uTint.value.fromArray(k.tint ?? m.tint ?? [0.2, 0.2, 0.2]);
        // The book's point of origin (its emitter at x 0) on the ground at (x, z): the card's
        // centre sits the box's offset away along the screen's right (mirrored with the card).
        const cx = k.x + _right.x * bc[0] * sc * mirror, cz = k.z + _right.z * bc[0] * sc * mirror;
        const gy = (app.getWorldHeight?.(k.x, k.z) ?? 0) + (k.lift ?? 0);
        k.c.update({ age: k.loopDur ? (t / k.loopDur) % 1 : age, camera, size: k.size, sunDir: _sun, sunColor: _col, ambient: _sky, center: _ctr.set(cx, gy + bc[1] * sc, cz) });
        if (mirror < 0) {
          k.c.mesh.scale.x = -k.size;
          k.c.u.uSunL.value.x *= -1;   // the light mirrored with it
        }
      }
    }
  }

  function clear() { for (const [, s] of sets) for (const k of s.cards) { k.t0 = -1e9; k.c.mesh.visible = false; } }

  return { play, update, clear, has: (key) => sets.has(key), meta: (key) => sets.get(key)?.meta ?? null };
}
