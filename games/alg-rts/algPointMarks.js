// THE POINT'S GROUND MARKS (you, 2026-10-11, the training camp beside Company of Heroes 3: "the
// requisition points don't use a perfect circular line … only when taken it's a perfect circle and
// becomes blue … an awesome circular animation from its centre and blue glow lines that go up").
//
//   RING     DASHED white while nobody holds it; the capturer's colour FILLS it round, clockwise
//            from the top, as the hold grows; SOLID in the holder's colour once held.
//   DISC     at the centre, a third of the ring: the holder's colour, brightest in the middle, a
//            dashed rim — only while held (it fades in with the capture).
//   CAPTURE  ~1.6 s at the moment of taking it: a wave of light runs out along the ground to the
//            ring, the centre flashes, light streaks rise round the pole.
//
// One point = four flat meshes, all TSL; the animation is uniforms only (no rebuild). FIRST IN THE
// BUILDING LAB ("Point de ravitaillement"); the game's ring pool (selectionRingField.js) is
// untouched until the look is settled. Not draped yet: flat at `lift` above y = 0 (the lab's
// ground) — the game's port drapes it (terrainDrape.js) and pools it.
import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import { RENDER_ORDER } from "../shared-rts/renderOrder.js";
import { Fn, abs, atan, clamp, exp, float, fract, fwidth, length, max, mix, positionLocal, pow, sin, smoothstep, time, uniform, uv, vec3 } from "three/tsl";

/** The sides' colours — the game's own ring colours (algUnits.js villageRings). */
export const POINT_COLOURS = { player: 0x58a8ff, enemy: 0xff6a5a, neutral: 0xf4efe2 };

export const POINT_MARKS = {
  ringWidth: 0.42,      // m: the ring's band
  dashes: 44,           // round the ring while nobody holds it
  dashDuty: 0.62,       // of each dash period, drawn
  discFrac: 0.3,        // the centre disc's radius / the ring's
  discDashes: 36,
  captureS: 1.6,        // the capture animation's length
  streaks: 16,
  streakH: 9,           // m: how high the light streaks rise
};

const TAU = Math.PI * 2;

/**
 * @param {object} o
 * @param {number} [o.radius]  the capture radius (a supply point 22 m, a village 40 m)
 * @param {number} [o.lift]    m above y = 0
 */
export function createPointMark({ radius = 22, lift = 0.06 } = {}) {
  const P = POINT_MARKS;
  const group = new THREE.Group();
  group.name = "pointMark";

  // ── Uniforms: the whole state ─────────────────────────────────────────────
  const U = {
    base: uniform(new THREE.Color(POINT_COLOURS.neutral)),   // the dashes' colour
    fill: uniform(new THREE.Color(POINT_COLOURS.player)),    // the capturer's / holder's colour
    progress: uniform(0),                                    // 0..1 of the ring filled
    held: uniform(0),                                        // 0..1: the disc (fades in)
    burst: uniform(1),                                       // 0..1 of the capture animation (1 = over)
  };

  const flatMat = (blending = THREE.NormalBlending) => {
    const m = new MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, blending,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    m.toneMapped = false;       // a mark, not a lit surface: its colours exact
    m.forceSinglePass = true;
    return m;
  };
  // The angle round the centre as 0..1, clockwise seen from above, starting at the top (−z: away
  // from the camera, CoH's 12 o'clock).
  const turn = Fn(() => fract(atan(positionLocal.x, positionLocal.z.negate()).div(TAU).add(1)));

  // ── RING ──────────────────────────────────────────────────────────────────
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius - P.ringWidth, radius, 256, 1).rotateX(-Math.PI / 2), flatMat());
  {
    const m = ring.material;
    const a = turn();
    const d = a.mul(P.dashes);
    const fw = fwidth(d);
    const f = fract(d);
    // A dash with soft (antialiased) ends.
    const dash = smoothstep(0, fw, f).mul(float(1).sub(smoothstep(float(P.dashDuty).sub(fw), P.dashDuty, f)));
    const filledEdge = fwidth(a).mul(1.5);
    const filled = float(1).sub(smoothstep(U.progress.sub(filledEdge), U.progress, a));
    // The band's two edges, soft.
    const r = length(positionLocal.xz);
    const rw = fwidth(r).mul(1.2);
    const band = smoothstep(radius - P.ringWidth, float(radius - P.ringWidth).add(rw), r).mul(float(1).sub(smoothstep(float(radius).sub(rw), radius, r)));
    m.colorNode = mix(U.base, U.fill, filled);
    m.opacityNode = mix(dash.mul(0.85), float(0.95), filled).mul(band);
  }

  // ── DISC ──────────────────────────────────────────────────────────────────
  const r0 = radius * P.discFrac;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(r0, 128).rotateX(-Math.PI / 2), flatMat());
  {
    const m = disc.material;
    const rn = length(positionLocal.xz).div(r0);               // 0 centre .. 1 rim
    const glow = pow(float(1).sub(rn), 1.6).mul(0.42).add(0.12);
    // A slow breath, so a held point is alive (2 % of its light).
    const breathe = sin(time.mul(1.7)).mul(0.04).add(1);
    // The rim: a thin dashed line just inside the edge.
    const d = turn().mul(P.discDashes);
    const fw = fwidth(d);
    const rimDash = smoothstep(0, fw, fract(d)).mul(float(1).sub(smoothstep(float(0.55).sub(fw), 0.55, fract(d))));
    const rimBand = float(1).sub(smoothstep(0, 0.025, abs(rn.sub(0.94))));
    const outer = float(1).sub(smoothstep(0.985, 1, rn));
    m.colorNode = mix(U.fill, vec3(1, 1, 1), rimBand.mul(rimDash).mul(0.55));
    m.opacityNode = max(glow.mul(breathe), rimBand.mul(rimDash).mul(0.9)).mul(outer).mul(U.held);
  }

  // ── CAPTURE: the ground wave + the centre flash (additive) ───────────────────
  const wave = new THREE.Mesh(new THREE.CircleGeometry(radius, 160).rotateX(-Math.PI / 2), flatMat(THREE.AdditiveBlending));
  {
    const m = wave.material;
    const t = U.burst;
    const r = length(positionLocal.xz).div(radius);              // 0..1
    const front = float(1).sub(pow(float(1).sub(t), 3));          // ease-out: fast, then settles
    const width = mix(float(0.09), float(0.03), t);
    const ringW = exp(abs(r.sub(front)).div(width).negate().mul(2.2));
    const trail = smoothstep(front.sub(0.35), front, r).mul(float(1).sub(smoothstep(front, front.add(0.01), r))).mul(0.25);
    const flash = exp(r.mul(9).negate()).mul(pow(float(1).sub(t), 2)).mul(1.6);
    const fade = pow(float(1).sub(t), 1.4);
    const k = ringW.add(trail).mul(fade).add(flash).mul(t.lessThan(1).select(1, 0));
    m.colorNode = U.fill.mul(1.6).add(vec3(0.25, 0.25, 0.25).mul(flash));
    m.opacityNode = clamp(k, 0, 1);
  }

  // ── CAPTURE: light streaks rising round the pole (additive, crossed quads) ────
  const streaks = new THREE.Mesh(buildStreaks(P.streaks, 2.4), flatMat(THREE.AdditiveBlending));
  {
    const m = streaks.material;
    const t = U.burst;
    const ph = uv().x;                                            // per streak: its delay 0..1 (uv.x)
    const v = uv().y;                                             // 0 foot .. 1 head of the streak
    const local = clamp(t.mul(1.35).sub(ph.mul(0.35)), 0, 1);     // this streak's own 0..1
    const rise = float(1).sub(pow(float(1).sub(local), 2));
    const len = mix(float(2.6), float(1.2), local);
    const y = rise.mul(P.streakH).add(v.mul(len)).sub(len.mul(0.5));
    m.positionNode = vec3(positionLocal.x, max(y, 0), positionLocal.z);
    const shape = smoothstep(0, 0.35, v).mul(float(1).sub(smoothstep(0.55, 1, v)));
    const live = local.greaterThan(0).select(1, 0).mul(float(1).sub(smoothstep(0.6, 1, local)));
    m.colorNode = U.fill.mul(1.8).add(vec3(0.35, 0.35, 0.35));
    m.opacityNode = shape.mul(live).mul(0.9);
  }
  streaks.frustumCulled = false;

  for (const mesh of [ring, disc, wave]) mesh.position.y = lift;
  // The bands (renderOrder.js): the marks lie ON the ground, the streaks stand in the AIR. (Disc and
  // ring never overlap; the wave is additive — its order against them does not show.)
  disc.renderOrder = ring.renderOrder = wave.renderOrder = RENDER_ORDER.ON_GROUND;
  streaks.renderOrder = RENDER_ORDER.AIR;
  group.add(disc, ring, wave, streaks);

  // ── State ─────────────────────────────────────────────────────────────────
  let burstT = 1;           // seconds into the capture animation / captureS
  let heldTarget = 0;
  const api = {
    group,
    uniforms: U,
    /**
     * @param {object} s
     * @param {"player"|"enemy"|null} s.owner      who holds it (null: nobody)
     * @param {"player"|"enemy"|null} [s.capturer] who is filling it (the owner's colour when held)
     * @param {number} [s.progress]                0..1 of the ring filled by the capturer
     */
    set({ owner = null, capturer = owner, progress = owner ? 1 : 0 }) {
      U.fill.value.set(POINT_COLOURS[capturer ?? owner ?? "player"]);
      U.progress.value = owner ? 1 : progress;
      heldTarget = owner ? 1 : 0;
    },
    /** The moment of capture: the wave and the streaks (and the disc fades in). */
    capture(owner) {
      api.set({ owner });
      burstT = 0;
    },
    update(dt) {
      if (burstT < 1) burstT = Math.min(1, burstT + dt / P.captureS);
      U.burst.value = burstT;
      U.held.value += (heldTarget - U.held.value) * Math.min(1, dt * 2.5);
      streaks.visible = wave.visible = burstT < 1;
    },
    dispose() {
      for (const mesh of [ring, disc, wave, streaks]) { mesh.geometry.dispose(); mesh.material.dispose(); }
    },
  };
  api.update(0);
  return api;
}

/**
 * `n` streaks round the centre within `spread` m, each two crossed vertical quads (seen from any
 * side): uv.x = the streak's delay (0..1), uv.y = 0 at its foot, 1 at its head. Height is set in
 * the shader.
 */
function buildStreaks(n, spread) {
  const pos = [], uvs = [], idx = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rnd() * 0.4, r = 0.5 + rnd() * spread;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r, w = 0.05 + rnd() * 0.05, delay = rnd();
    for (const yaw of [0, Math.PI / 2]) {
      const dx = Math.cos(yaw) * w, dz = Math.sin(yaw) * w, b = pos.length / 3;
      pos.push(cx - dx, 0, cz - dz, cx + dx, 0, cz + dz, cx + dx, 0, cz + dz, cx - dx, 0, cz - dz);
      uvs.push(delay, 0, delay, 0, delay, 1, delay, 1);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}
