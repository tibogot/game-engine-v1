// FLAME STREAMS — a flamethrower's fire in a game, from the baked Fire Pro books
// (v3/fire-bake-lab: Flamethrower, … start, … stop; judged in the FX compare lab and the
// soldier lab, 2026-10-09). Shared, opt-in: a game asks for a stream by key (its unit).
//
//   fire(key, nozzle, axis)   call every step the weapon fires: the stream lights if it was
//                             out (START: the burning head shoots out, the rope unrolls behind
//                             it), runs its LOOP while the calls keep coming, and when they stop
//                             (`hold` s) plays STOP (it breaks off at the nozzle and burns out).
//                             A stream let go during its ignition finishes it first: STOP
//                             starts from a whole stream.
//   update(dt, camera)        every rendered frame.
//
// Each stream is three AXIAL book cards (bookCard.updateAxial: laid along the aim from the
// nozzle, turned about it to face the camera), lit as the game's lit smoke (litSmoke.js: the
// sun ×0.4, a pale sky when there is no hemisphere light), the flame's light into the bloom
// buffer, faded softly into the ground under the nozzle. `onState(key, "start" | "stop")`
// tells the game (its sounds) when a stream lights or is let go.
import * as THREE from "three";
import { createBookCards, loadBookTextures } from "../../v3/fire-bake-lab/bookCard.js";
import { RENDER_ORDER } from "./renderOrder.js";
import { drapeY } from "./terrainDrape.js";

export const FLAME_STREAM = {
  base: "/textures/fx/firepro/fp_",
  card: 28.5,        // m: the card — the stream reaches (0.574 - its nozzle 0.046) of it: 15 m
  reachShare: 0.574, // the stream's end along the card from its nozzle (fp_flamethrower)
  ignite: 0.8,       // s: the START book played in this (the sim's ignition is slow)
  speed: 1.4,        // × the LOOP and STOP books' own pace
  fireK: 1,          // × the flame's light
  bloom: 0.35,       // share of it in the bloom buffer
  hold: 0.35,        // s without a fire() call before the stream is let go
  max: 6,            // streams at once (3 cards each)
  // BURNING GROUND where a stream comes down: the burning-fuel book (fp_fuelFire — a few
  // scattered puddles, low flames, little smoke; the napalm book before it read as a square
  // sheet of fire under black smoke, 2026-10-16), one billboard per patch.
  patches: 14,       // patches at once (the oldest gives way)
  patchCard: 3.6,    // m: the card (its puddles spread ~2.6 m)
};

const ease = THREE.MathUtils.smoothstep;

export async function createFlameStreamFx({ app, params = FLAME_STREAM, onState = null } = {}) {
  const P = params;
  const [loop, start, stop] = await Promise.all(["flamethrower", "flamethrowerStart", "flamethrowerStop"].map((k) => loadBookTextures(`${P.base}${k}`)));
  const books = [start, loop, stop];
  const anchor = loop.meta.anchor ?? [0.05, 0.42];
  const groundBook = await loadBookTextures(`${P.base}fuelFire`)
    .catch(() => loadBookTextures(`${P.base}napalmFire`)).catch(() => null);
  const groundAt = app.heightTexNode ? (x, z) => drapeY(app.heightTexNode, x, z) : null;

  // The pool: `max` slots of three cards, handed to streams as they light. Each BOOK's cards share
  // one material (createBookCards: one shader build a book, not one a card — 2026-10-16).
  const byBook = books.map(() => createBookCards(P.max, { groundAt }));
  const slots = Array.from({ length: P.max }, (_, i) => books.map((b, j) => {
    // Into the REAL ground under each pixel (one heightmap tap, as litSmoke): a slope rising
    // through the stream was cut in a hard line at a single fade height (you, 2026-10-09).
    const c = byBook[j][i];
    c.setBook(b.tex, b.meta);
    c.u.uGroundFade.value = 1.0;
    c.mesh.visible = false;
    c.mesh.renderOrder = RENDER_ORDER.SMOKE;
    c.u.uBloom.value = P.bloom;
    c.u.uTint.value.fromArray(b.meta.tint ?? [0.19, 0.19, 0.19]);
    app.scene.add(c.mesh);
    return c;
  }));
  const free = [...slots];

  // The burning-ground cards: { c, x, z, t0, end, phase } (end < clock: free).
  const patches = groundBook ? createBookCards(P.patches, { groundAt }).map((c) => {
    c.setBook(groundBook.tex, groundBook.meta);
    c.u.uGroundFade.value = 0.5;
    c.u.uBloom.value = P.bloom;
    c.u.uTint.value.fromArray(groundBook.meta.tint ?? [0.08, 0.08, 0.09]);
    c.mesh.visible = false;
    c.mesh.renderOrder = RENDER_ORDER.SMOKE;
    app.scene.add(c.mesh);
    return { c, x: 0, z: 0, t0: 0, end: -1, phase: 0 };
  }) : [];
  /** The ground burns at (x, z) for `life` s (the oldest patch gives way when all burn). */
  function burnGround(x, z, life = 7) {
    if (!patches.length) return false;
    const p = patches.find((q) => q.end < clock) ?? patches.reduce((a, b) => (a.t0 < b.t0 ? a : b));
    Object.assign(p, { x, z, t0: clock, end: clock + life, phase: Math.random() * 10 });
    return true;
  }
  const streams = new Map();   // key → { cards, firing, since, stop, last, nozzle, axis }
  let clock = 0;

  function fire(key, nozzle, axis) {
    let s = streams.get(key);
    if (!s) {
      const cards = free.pop();
      if (!cards) return false;          // every slot burning: this one goes without
      s = { cards, firing: false, since: 0, stop: -1e9, last: 0, nozzle: new THREE.Vector3(), axis: new THREE.Vector3(1, 0, 0) };
      streams.set(key, s);
    }
    if (!s.firing) { s.firing = true; s.since = clock; onState?.(key, "start"); }
    s.last = clock;
    s.nozzle.copy(nozzle);
    s.axis.copy(axis).normalize();
    return true;
  }
  const isFiring = (key) => !!streams.get(key)?.firing;

  const _sun = new THREE.Vector3(0.3, 0.8, 0.4), _col = new THREE.Color(), _sky = new THREE.Color(), _ctr = new THREE.Vector3();
  function update(dt, camera) {
    clock += dt;
    // The scene's light, as litSmoke reads it.
    const L = app.light, sun = L?.sun, hemi = L?.hemi;
    const dir = L?.getDirection?.();
    if (dir) _sun.copy(dir).normalize();
    if (sun) _col.copy(sun.color).multiplyScalar(sun.intensity * (0.4 / 0.65));
    if (hemi && hemi.intensity > 0.01) _sky.copy(hemi.color).multiplyScalar(hemi.intensity * 0.75);
    else _sky.setRGB(0.55, 0.62, 0.75).multiplyScalar((sun?.intensity ?? 3) * 0.1 * 0.75);

    // Burning ground: in over 0.4 s, out over its last 1.5 s.
    for (const p of patches) {
      p.c.mesh.visible = p.end > clock;
      if (!p.c.mesh.visible) continue;
      const m = groundBook.meta, k = P.patchCard / m.size;
      const gy = app.getWorldHeight?.(p.x, p.z) ?? 0;
      p.c.u.uFireK.value = P.fireK;
      p.c.u.uFade.value = ease(clock - p.t0, 0, 0.4) * (1 - ease(clock, p.end - 1.5, p.end));
      p.c.update({ age: (clock + p.phase) / m.duration, camera, size: P.patchCard, sunDir: _sun, sunColor: _col, ambient: _sky,
        center: _ctr.set(p.x, gy + (m.bake?.center?.[1] ?? m.size / 2) * k, p.z) });
    }
    for (const [key, s] of streams) {
      const sa = (clock - s.since) / P.ignite;
      // Let go (no call for `hold` s) — but not before the stream is out.
      if (s.firing && clock - s.last > P.hold && sa >= 1) { s.firing = false; s.stop = clock; onState?.(key, "stop"); }
      const so = (clock - s.stop) * P.speed / stop.meta.duration;
      if (!s.firing && so >= 1) {          // burnt out: the slot goes back
        for (const c of s.cards) c.mesh.visible = false;
        free.push(s.cards);
        streams.delete(key);
        continue;
      }
      // start → loop over the start's last 15%; loop → stop over the stop's first 6%.
      const w = s.firing ? [1 - ease(sa, 0.85, 1), ease(sa, 0.85, 1), 0] : [0, 1 - ease(so, 0, 0.06), ease(so, 0, 0.03) * (1 - ease(so, 0.8, 1))];
      const age = [Math.min(sa, 1), (clock * P.speed) / loop.meta.duration, Math.min(so, 1)];
      const groundY = app.getWorldHeight?.(s.nozzle.x, s.nozzle.z) ?? 0;
      s.cards.forEach((c, i) => {
        c.mesh.visible = w[i] > 0.002;
        if (!c.mesh.visible) return;
        c.u.uFireK.value = P.fireK;
        c.u.uGroundY.value = groundY;
        const side = c.updateAxial({ age: age[i], camera, nozzle: s.nozzle, axis: s.axis, anchor, size: P.card, sunDir: _sun, sunColor: _col, ambient: _sky });
        c.u.uFade.value = w[i] * ease(side, 0.18, 0.5);
      });
    }
  }

  return {
    params: P, fire, isFiring, update, burnGround,
    /** The ground burning now (for sounds): [{ x, z, left }]. */
    burning: () => patches.filter((p) => p.end > clock).map((p) => ({ key: p, x: p.x, z: p.z, left: p.end - clock })),
    /** The streams lit now (for sounds, lights): [{ key, nozzle, axis, firing }]. */
    streams: () => [...streams].map(([key, s]) => ({ key, nozzle: s.nozzle, axis: s.axis, firing: s.firing })),
    /** How far the stream reaches from its nozzle (m), at full length. */
    reach: () => P.card * (P.reachShare - anchor[0]),
    clear() { for (const s of streams.values()) { for (const c of s.cards) c.mesh.visible = false; free.push(s.cards); } streams.clear(); for (const p of patches) { p.end = -1; p.c.mesh.visible = false; } },
    dispose() {
      for (const c of [...slots.flat(), ...patches.map((p) => p.c)]) { app.scene.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh.material.dispose(); }
      streams.clear();
    },
  };
}
