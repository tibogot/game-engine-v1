// FX TIMELINES — one effect = a list of TRACKS on a timeline: the Fire Pro books, a flash of
// light, thrown debris, a scorch on the ground, a camera shake, a sound (you, 2026-10-09: "an
// effect timeline lab… the best UI and UX"). Shared: the timeline lab (fx-timeline-lab.html)
// edits an effect and plays it through THIS code, and a game plays the saved file through it
// too — what you tune is what plays.
//
// THE FORMAT (JSON, public/textures/fx/firepro/fx_<name>.json):
//   { name, tracks: [{ id, kind, label, start, length, on, ...params }] }
//   start / length in seconds; the params are each kind's (KINDS below: label, unit, range,
//   hint — the lab's inspector is built from them, so a kind documents itself).
//
// EVERYTHING IS A FUNCTION OF TIME: an instance renders the effect AT `t` (setTime), not by
// stepping — the books are flipbooks, the debris is ballistic in closed form, the light a curve.
// So the lab can scrub to any moment, and a game just advances t.
import * as THREE from "three";
import { createBookCard, loadBookTextures } from "../../v3/fire-bake-lab/bookCard.js";
import { drapeY } from "./terrainDrape.js";
import { RENDER_ORDER } from "./renderOrder.js";

/** The baked books (v3/fire-bake-lab), by key. `loop`: plays round for the bar's length. */
export const FX_BOOKS = {
  rocket: { label: "Rocket impact" },
  wp: { label: "White phosphorus" },
  shell: { label: "Shell in sand" },
  blast: { label: "Fuel fireball" },
  napalm: { label: "Napalm splash" },
  napalmFire: { label: "Burning ground (loop)", loop: true },
  wreck: { label: "Burning wreck (loop)", loop: true },
  column: { label: "Smoke column (loop)", loop: true },
  signal: { label: "Signal smoke (loop)", loop: true },
};
const BOOK_BASE = "/textures/fx/firepro/fp_";

/**
 * The track kinds. `params`: each field — type (range | color | select | check), default, and
 * for the inspector: label, unit, min / max / step, hint. `color: null` = the book's own.
 */
export const KINDS = {
  book: {
    label: "Fire / smoke", icon: "◉", color: "#e08a3c", length: 3,
    lengthHint: "A one-shot plays once over it: longer = slower. A loop plays for that long.",
    hint: "A baked Fire Pro flipbook. A one-shot plays once over the bar; a loop plays round for as long as the bar.",
    params: {
      book: { type: "select", def: "rocket", label: "Book", options: () => Object.entries(FX_BOOKS).map(([k, b]) => [k, b.label]) },
      size: { type: "range", def: 14, min: 2, max: 40, step: 0.5, unit: "m", label: "Size", hint: "The card's width: how big the effect is." },
      x: { type: "range", def: 0, min: -20, max: 20, step: 0.1, unit: "m", label: "Offset ←→" },
      z: { type: "range", def: 0, min: -20, max: 20, step: 0.1, unit: "m", label: "Offset ↑↓", hint: "Toward / away from the camera (on the ground)." },
      brightness: { type: "range", def: 2, min: 0, max: 8, step: 0.05, unit: "×", label: "Flame light", hint: "How bright the fire glows (smoke is lit by the sun)." },
      tint: { type: "color", def: null, label: "Smoke colour", hint: "Empty = the book's own (dust, soot, white…)." },
      fadeOut: { type: "range", def: 0.2, min: 0, max: 1, step: 0.01, unit: "of bar", label: "Fade out", hint: "The last part of the bar it fades over." },
    },
  },
  light: {
    label: "Light flash", icon: "✶", color: "#f2d24b", length: 0.4,
    lengthHint: "How long the light lasts (its shape decides how it falls).",
    hint: "A point light at the effect: lights the ground and the men round it.",
    params: {
      color: { type: "color", def: "#ffb060", label: "Colour" },
      // candela: at 2 m, 120 is ~3x the RTS games' sun on the ground (their sun is ~10).
      intensity: { type: "range", def: 120, min: 0, max: 800, step: 1, unit: "", label: "Strength" },
      range: { type: "range", def: 25, min: 2, max: 80, step: 0.5, unit: "m", label: "Reach" },
      height: { type: "range", def: 2, min: 0, max: 15, step: 0.1, unit: "m", label: "Height" },
      curve: { type: "select", def: "flash", label: "Shape", options: () => [["flash", "Flash (sharp, fast fall)"], ["fade", "Fade (even)"], ["flicker", "Flicker (a fire)"]] },
    },
  },
  debris: {
    label: "Debris", icon: "⁘", color: "#a07850", length: 2.2,
    lengthHint: "Until the pieces fade away (they land long before).",
    hint: "Clods of earth or stones thrown out, falling back and resting (their bar: until they fade).",
    params: {
      count: { type: "range", def: 40, min: 1, max: 120, step: 1, unit: "", label: "How many" },
      speed: { type: "range", def: 13, min: 1, max: 40, step: 0.5, unit: "m/s", label: "Speed" },
      spread: { type: "range", def: 45, min: 0, max: 90, step: 1, unit: "°", label: "Spread", hint: "0 = straight up, 90 = flat out to the sides." },
      size: { type: "range", def: 0.25, min: 0.05, max: 1.2, step: 0.01, unit: "m", label: "Size" },
      color: { type: "color", def: "#5a4532", label: "Colour" },
      seed: { type: "range", def: 1, min: 1, max: 99, step: 1, unit: "", label: "Variation", hint: "Another throw with the same settings." },
    },
  },
  scorch: {
    label: "Scorch mark", icon: "●", color: "#6a6a6a", length: 8,
    lengthHint: "How long the mark stays on the ground.",
    hint: "A burnt patch on the ground. Its bar is how long it stays (it fades over the last quarter).",
    params: {
      radius: { type: "range", def: 3.5, min: 0.5, max: 15, step: 0.1, unit: "m", label: "Radius" },
      darkness: { type: "range", def: 0.6, min: 0, max: 1, step: 0.01, unit: "", label: "Darkness" },
      color: { type: "color", def: "#1a1612", label: "Colour" },
    },
  },
  shake: {
    label: "Camera shake", icon: "≋", color: "#7aa6d8", length: 0.6,
    lengthHint: "How long the shaking dies away over.",
    hint: "The view shakes, strongest at the start of the bar.",
    params: {
      strength: { type: "range", def: 0.35, min: 0, max: 2, step: 0.01, unit: "m", label: "Strength" },
    },
  },
  sound: {
    label: "Sound", icon: "♪", color: "#9b7ad8", length: 1.5,
    lengthHint: "Only for a looping sound (fire): it stops at the bar's end.",
    hint: "A sound from the game's set, played when the playhead reaches the bar's start.",
    params: {
      slot: { type: "select", def: "explosion", label: "Sound", options: () => SOUND_SLOTS.map((k) => [k, k]) },
      volume: { type: "range", def: 0.8, min: 0, max: 1.5, step: 0.01, unit: "", label: "Volume" },
      pitch: { type: "range", def: 1, min: 0.5, max: 2, step: 0.01, unit: "×", label: "Pitch" },
    },
  },
};
/** The sound slots a game offers (alg-rts' manifest); the lab fills it. */
export const SOUND_SLOTS = ["explosion", "explFar", "incoming", "impact", "flameIgnite", "flameLoop", "flameStop", "fireLoop", "cannon"];

let _id = 1;
/** A new track of `kind` at `start` with every param at its default. */
export function newTrack(kind, start = 0) {
  const K = KINDS[kind];
  const t = { id: `t${Date.now().toString(36)}${_id++}`, kind, label: K.label, start, length: K.length, on: true };
  for (const [k, p] of Object.entries(K.params)) t[k] = p.def;
  return t;
}
/** When the effect is over (its last bar's end). */
export const effectDuration = (fx) => Math.max(0.5, ...fx.tracks.map((t) => t.start + t.length));

// ── small deterministic helpers ─────────────────────────────────────────────────
const ease = THREE.MathUtils.smoothstep;
function rng(seed) {
  let s = (seed * 2654435761) >>> 0;
  return () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return (s >>> 8) / 16777216; };
}
function scorchTexture() {
  const N = 128, c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d"), img = g.createImageData(N, N), r = rng(7);
  const lumps = Array.from({ length: 9 }, () => [r() * 6.28, 0.75 + r() * 0.35]);
  // Mottled inside: burnt and bare patches, streaks thrown out from the centre (a flat disc
  // read as a black hole, 2026-10-09).
  const waves = Array.from({ length: 7 }, () => [r() * 9 + 3, r() * 9 + 3, r() * 6.28]);
  const rays = Array.from({ length: 5 }, () => [Math.floor(r() * 9) + 5, r() * 6.28]);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x / N * 2 - 1, dy = y / N * 2 - 1, d = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
    let edge = 0;
    for (const [p, k] of lumps) edge += Math.cos(a * 3 + p) * 0.04 * k;
    let n = 0;
    for (const [fx, fy, p] of waves) n += Math.sin(dx * fx + p) * Math.sin(dy * fy - p * 0.7);
    let ray = 0;
    for (const [k, p] of rays) ray += Math.max(0, Math.cos(a * k + p)) ** 6;
    const core = 1 - ease(d, 0.15, 0.75 + edge);
    const v = Math.max(0, Math.min(1, core * (0.55 + 0.25 * n / 3.5) + ray * 0.35 * (1 - ease(d, 0.4, 1.0)))) * (0.88 + 0.12 * r());
    const i = (y * N + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
    img.data[i + 3] = Math.round(v * 255);
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/**
 * @param {object} o
 * @param {THREE.Scene} o.scene
 * @param {object} [o.heightTexNode]  the terrain's heightmap node (cards fade into the ground)
 * @param {(x:number,z:number)=>number} [o.groundAt]  the ground's height
 * @param {(slot:string, at:THREE.Vector3, opts:{volume:number,pitch:number,length:number})=>void} [o.onSound]
 */
export function createFxPlayer({ scene, heightTexNode = null, groundAt = () => 0, onSound = null, maxLights = 3 } = {}) {
  const books = new Map();   // key → Promise<{ tex, meta }>
  const metas = new Map();   // key → meta, once loaded
  const bookOf = (key) => {
    if (!books.has(key)) books.set(key, loadBookTextures(`${BOOK_BASE}${key}`).then((b) => { metas.set(key, b.meta); return b; }).catch(() => null));
    return books.get(key);
  };
  const groundNode = heightTexNode ? (x, z) => drapeY(heightTexNode, x, z) : null;
  // Lights live in the scene from the start (adding one later recompiles every lit material).
  const lights = Array.from({ length: maxLights }, () => {
    const l = new THREE.PointLight(0xffffff, 0, 20, 2);
    l.castShadow = false;
    scene.add(l);
    return { l, busy: false };
  });
  const scorchTex = scorchTexture();
  const debrisGeo = new THREE.IcosahedronGeometry(0.5, 0);

  /** An effect playing at `origin` (on the ground). Render it at any time with setTime(t). */
  function instance(fx, origin = new THREE.Vector3()) {
    const parts = new Map();   // track id → its objects
    let lastT = 0;

    function partOf(tr) {
      let p = parts.get(tr.id);
      if (p && p.kind === tr.kind && p.sig === sigOf(tr)) return p;
      if (p) drop(tr.id);
      p = { kind: tr.kind, sig: sigOf(tr) };
      if (tr.kind === "book") {
        p.card = createBookCard({ groundAt: groundNode });
        p.card.u.uGroundFade.value = 0.6;
        p.card.mesh.visible = false;
        p.card.mesh.renderOrder = RENDER_ORDER.SMOKE;
        scene.add(p.card.mesh);
        p.ready = bookOf(tr.book).then((b) => { if (b && !p.gone) { p.book = b; p.card.setBook(b.tex, b.meta); p.card.mesh.visible = false; } });
      } else if (tr.kind === "debris") {
        const mat = new THREE.MeshStandardMaterial({ color: tr.color, roughness: 1, flatShading: true });
        p.mesh = new THREE.InstancedMesh(debrisGeo, mat, tr.count);
        p.mesh.castShadow = true;
        p.mesh.frustumCulled = false;
        const r = rng(tr.seed * 977 + 13);
        p.bits = Array.from({ length: tr.count }, () => {
          const a = r() * Math.PI * 2, tilt = (r() * tr.spread * Math.PI) / 180, v = tr.speed * (0.45 + 0.55 * r());
          return { vx: Math.sin(tilt) * Math.cos(a) * v, vy: Math.cos(tilt) * v, vz: Math.sin(tilt) * Math.sin(a) * v,
            s: tr.size * (0.55 + 0.9 * r()), spin: [r() * 6, r() * 6, r() * 6], ox: (r() - 0.5) * 0.6, oz: (r() - 0.5) * 0.6 };
        });
        scene.add(p.mesh);
      } else if (tr.kind === "scorch") {
        p.mat = new THREE.MeshBasicMaterial({ color: tr.color, alphaMap: scorchTex, transparent: true, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        p.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), p.mat);
        p.mesh.renderOrder = RENDER_ORDER.CRATERS;   // a burn on the ground, with the shell holes
        p.mesh.rotation.y = rng(tr.id.length * 31)() * 6.28;
        scene.add(p.mesh);
      }
      parts.set(tr.id, p);
      return p;
    }
    // Rebuilt when a param that shapes its objects changes (the book, the debris count…).
    const sigOf = (tr) => (tr.kind === "book" ? tr.book : tr.kind === "debris" ? `${tr.count}|${tr.seed}|${tr.speed}|${tr.spread}|${tr.size}` : "");
    function drop(id) {
      const p = parts.get(id);
      if (!p) return;
      p.gone = true;
      const m = p.card?.mesh ?? p.mesh;
      if (m) { scene.remove(m); m.geometry !== debrisGeo && m.geometry?.dispose?.(); m.material?.dispose?.(); }
      parts.delete(id);
    }

    const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();
    /**
     * The effect AT time t. `ctx`: { camera, sunDir, sunColor, sky } (the books' light).
     * Returns { shake: THREE.Vector3 } — the camera offset this moment (the host applies it).
     */
    function setTime(t, ctx, { sounds = false } = {}) {
      const shake = new THREE.Vector3();
      for (const L of lights) L.busy = false;
      const live = new Set();
      const gy = groundAt(origin.x, origin.z);
      for (const tr of fx.tracks) {
        live.add(tr.id);
        const p = tr.kind === "light" || tr.kind === "shake" || tr.kind === "sound" ? null : partOf(tr);
        const local = t - tr.start, x = local / Math.max(1e-3, tr.length);
        const inBar = tr.on && local >= 0 && local <= tr.length;
        if (tr.kind === "book") {
          const meta = p.book?.meta;
          p.card.mesh.visible = !!meta && inBar;
          if (!p.card.mesh.visible) continue;
          const loop = !!meta.loop, k = tr.size / meta.size;
          const age = loop ? local / meta.duration : x;
          const fade = (loop ? ease(local, 0, 0.3) : 1) * (1 - ease(x, 1 - Math.max(0.001, tr.fadeOut), 1));
          p.card.u.uFade.value = fade;
          p.card.u.uFireK.value = tr.brightness;
          p.card.u.uTint.value.fromArray(meta.tint ?? [0.2, 0.2, 0.2]);
          if (tr.tint) p.card.u.uTint.value.set(tr.tint);   // a hex is sRGB: set() makes it linear
          const cx = origin.x + tr.x + (meta.bake?.center?.[0] ?? 0) * k, cz = origin.z + tr.z;
          p.card.update({ age, camera: ctx.camera, size: tr.size, sunDir: ctx.sunDir, sunColor: ctx.sunColor, ambient: ctx.sky,
            center: _v.set(cx, groundAt(cx, cz) + (meta.bake?.center?.[1] ?? meta.size / 2) * k, cz) });
        } else if (tr.kind === "light") {
          if (!inBar) continue;
          const L = lights.find((q) => !q.busy);
          if (!L) continue;
          L.busy = true;
          const f = tr.curve === "flash" ? (1 - x) ** 3 : tr.curve === "fade" ? 1 - x
            : (1 - x * 0.6) * (0.72 + 0.28 * (0.5 + 0.5 * Math.sin(local * 31 + Math.sin(local * 13) * 2)));
          L.l.color.set(tr.color);
          L.l.intensity = tr.intensity * f * Math.min(1, local / 0.02 + 0.2);
          L.l.distance = tr.range;
          L.l.position.set(origin.x, gy + tr.height, origin.z);
        } else if (tr.kind === "debris") {
          p.mesh.visible = inBar;
          if (!inBar) continue;
          p.mesh.material.color.set(tr.color);
          const shrink = 1 - ease(x, 0.8, 1);
          p.bits.forEach((b, i) => {
            // Ballistic until the ground, then at rest where it landed.
            const land = (b.vy + Math.sqrt(b.vy * b.vy + 2 * 9.8 * 0.3)) / 9.8;
            const tt = Math.min(local, land);
            const px = origin.x + b.ox + b.vx * tt, pz = origin.z + b.oz + b.vz * tt;
            const py = Math.max(groundAt(px, pz) + b.s * 0.3, gy + 0.3 + b.vy * tt - 4.9 * tt * tt);
            _e.set(b.spin[0] * tt, b.spin[1] * tt, b.spin[2] * tt);
            p.mesh.setMatrixAt(i, _m.compose(_v.set(px, py, pz), _q.setFromEuler(_e), _s.setScalar(b.s * shrink)));
          });
          p.mesh.instanceMatrix.needsUpdate = true;
        } else if (tr.kind === "scorch") {
          p.mesh.visible = inBar;
          if (!inBar) continue;
          const grow = 0.6 + 0.4 * ease(local, 0, 0.15);
          p.mat.color.set(tr.color);
          p.mat.opacity = tr.darkness * ease(local, 0, 0.1) * (1 - ease(x, 0.75, 1));
          p.mesh.scale.setScalar(tr.radius * grow);
          p.mesh.position.set(origin.x + (tr.x ?? 0), gy + 0.03, origin.z + (tr.z ?? 0));
        } else if (tr.kind === "shake") {
          if (!inBar) continue;
          const a = tr.strength * (1 - x) ** 2;
          shake.x += a * Math.sin(t * 67 + 1.3);
          shake.y += a * 0.6 * Math.sin(t * 83 + 2.1);
          shake.z += a * Math.sin(t * 71 + 0.4);
        } else if (tr.kind === "sound") {
          // Played when the playhead CROSSES its start going forward (not when scrubbing back).
          if (sounds && tr.on && lastT <= tr.start && t > tr.start) onSound?.(tr.slot, origin, { volume: tr.volume, pitch: tr.pitch, length: tr.length });
        }
      }
      for (const L of lights) if (!L.busy) L.l.intensity = 0;
      for (const id of [...parts.keys()]) if (!live.has(id)) drop(id);
      lastT = t;
      return { shake };
    }

    return {
      get fx() { return fx; },
      set fx(v) { fx = v; },
      origin, setTime,
      /** A book's metadata if it has loaded (its tint, its loop flag), else null. */
      bookMetaSync: (key) => metas.get(key) ?? null,
      /** Every book this effect uses, loaded (await before the first frame for no pop-in). */
      ready: () => Promise.all(fx.tracks.filter((t) => t.kind === "book").map((t) => bookOf(t.book))),
      resetSounds() { lastT = -1; },
      dispose() { for (const id of [...parts.keys()]) drop(id); for (const L of lights) L.l.intensity = 0; },
    };
  }

  return {
    instance, bookOf,
    /** Book metadata (its loop flag, its tint) once loaded, or null. */
    async bookMeta(key) { return (await bookOf(key))?.meta ?? null; },
  };
}
