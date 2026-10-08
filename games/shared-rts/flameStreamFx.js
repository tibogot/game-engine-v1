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
import { createBookCard, loadBookTextures } from "../../v3/fire-bake-lab/bookCard.js";
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
};

const ease = THREE.MathUtils.smoothstep;

export async function createFlameStreamFx({ app, params = FLAME_STREAM, onState = null } = {}) {
  const P = params;
  const [loop, start, stop] = await Promise.all(["flamethrower", "flamethrowerStart", "flamethrowerStop"].map((k) => loadBookTextures(`${P.base}${k}`)));
  const books = [start, loop, stop];
  const anchor = loop.meta.anchor ?? [0.05, 0.42];

  // The pool: `max` slots of three cards, handed to streams as they light.
  const slots = Array.from({ length: P.max }, () => books.map((b) => {
    // Into the REAL ground under each pixel (one heightmap tap, as litSmoke): a slope rising
    // through the stream was cut in a hard line at a single fade height (you, 2026-10-09).
    const c = createBookCard({ groundAt: app.heightTexNode ? (x, z) => drapeY(app.heightTexNode, x, z) : null });
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

  const _sun = new THREE.Vector3(0.3, 0.8, 0.4), _col = new THREE.Color(), _sky = new THREE.Color();
  function update(dt, camera) {
    clock += dt;
    // The scene's light, as litSmoke reads it.
    const L = app.light, sun = L?.sun, hemi = L?.hemi;
    const dir = L?.getDirection?.();
    if (dir) _sun.copy(dir).normalize();
    if (sun) _col.copy(sun.color).multiplyScalar(sun.intensity * (0.4 / 0.65));
    if (hemi && hemi.intensity > 0.01) _sky.copy(hemi.color).multiplyScalar(hemi.intensity * 0.75);
    else _sky.setRGB(0.55, 0.62, 0.75).multiplyScalar((sun?.intensity ?? 3) * 0.1 * 0.75);

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
    params: P, fire, isFiring, update,
    /** The streams lit now (for sounds, lights): [{ key, nozzle, axis, firing }]. */
    streams: () => [...streams].map(([key, s]) => ({ key, nozzle: s.nozzle, axis: s.axis, firing: s.firing })),
    /** How far the stream reaches from its nozzle (m), at full length. */
    reach: () => P.card * (P.reachShare - anchor[0]),
    clear() { for (const s of streams.values()) { for (const c of s.cards) c.mesh.visible = false; free.push(s.cards); } streams.clear(); },
    dispose() {
      for (const cards of slots) for (const c of cards) { app.scene.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh.material.dispose(); }
      streams.clear();
    },
  };
}
