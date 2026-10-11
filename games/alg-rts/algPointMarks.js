// THE POINT'S GROUND MARKS (you, 2026-10-11, the training camp beside Company of Heroes 3: "the
// requisition points don't use a perfect circular line … only when taken it's a perfect circle and
// becomes blue … an awesome circular animation from its centre and blue glow lines that go up";
// then, the first cut seen: "we can make this point look way better, and the animation when
// taken far better").
//
// Matched to CoH 3's frames (assets-src/refs/coh3/point-*.png):
//   RING     neutral: OPAQUE white, DASH-DOT (a long dash, a dot), a faint dark edge so it reads on
//            bright sand. The capturer's colour fills it clockwise from the top as the hold grows;
//            held: a SOLID line in the holder's colour — NO glow (you, 2026-10-11: "the main ring shouldn't glow").
//   DISC     a third of the ring, ONLY DURING THE CAPTURE (you, 2026-10-11: "when the animation is done
//            only the outer blue circle should remain … dissolve with opacity"): ICY — the holder's colour,
//            brighter toward its edge, a solid white rim and short ticks just outside it; it swells in
//            with the flash, then DISSOLVES from the centre outward (a wavy edge), the ticks last.
//   CAPTURE  ~1.8 s at the moment of taking it: a white flash through ring and disc; two waves out
//            from the centre (a sharp front, a soft one behind); the disc swells in past its size
//            and settles; a COLUMN of light round the mast; inside it a FEW thin lines close to the mast,
//            each rising at its own moment to its own height (2026-10-11, you: "thinner, a smaller
//            radius, way less … not at the same level"; the column kept its width).
//
// One point = five meshes, all TSL; the animation is uniforms only (no rebuild). FIRST IN THE
// BUILDING LAB; the game's ring pool (selectionRingField.js) is untouched until the look is
// settled. Not draped yet: flat at `lift` above y = 0 — the game's port drapes it (terrainDrape.js).
import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import { RENDER_ORDER } from "../shared-rts/renderOrder.js";
import { Fn, abs, atan, clamp, exp, float, fract, fwidth, length, max, min, mix, positionLocal, pow, sin, smoothstep, time, uniform, uv, vec3 } from "three/tsl";

/** The sides' colours — the game's own ring colours (algUnits.js villageRings); `cut`: a French
 *  point held but CUT OFF from the post (no supply line): amber, it pays nothing. */
export const POINT_COLOURS = { player: 0x58a8ff, enemy: 0xff6a5a, neutral: 0xffffff, cut: 0xe0a040 };

export const POINT_MARKS = {
  ringWidth: 0.025,     // the ring's band × its radius …
  ringMin: 0.3,         // … never thinner than this (m): 0.3 at CoH's 11 m
  dashes: 22,           // dash-dot periods round the ring (CoH: ~20 at its 11 m)
  discFrac: 0.33,       // the centre disc's radius / the ring's
  discTicks: 28,        // the short ticks round the disc
  captureS: 2.4,        // the capture animation's length (1.8 before the disc's dissolve)
  streaks: 4,           // (26, then 7: "way less", "too many")
  streakH: 13,          // m: how high the light streaks rise
  pillarH: 15,          // m: the column of light round the mast
};

const TAU = Math.PI * 2;
// Soft 0..1 band between a and b with feathered edges `e` wide.
const band = (x, a, b, e) => smoothstep(a, float(a).add(e), x).mul(float(1).sub(smoothstep(float(b).sub(e), b, x)));

/**
 * @param {object} o
 * @param {number} [o.radius]  the capture radius
 * @param {number} [o.lift]    m above y = 0
 */
export function createPointMark({ radius = 11, lift = 0.06 } = {}) {
  const P = POINT_MARKS;
  const group = new THREE.Group();
  group.name = "pointMark";

  // ── Uniforms: the whole state ─────────────────────────────────────────────
  const U = {
    base: uniform(new THREE.Color(POINT_COLOURS.neutral)),   // the dash-dots' colour
    fill: uniform(new THREE.Color(POINT_COLOURS.player)),    // the capturer's / holder's colour
    progress: uniform(0),                                    // 0..1 of the ring filled
    burst: uniform(1),                                       // 0..1 of the capture animation (1 = over)
  };
  // The capture's envelopes, from `burst` (all 0 outside the animation).
  const T = U.burst;
  const live = T.lessThan(1).select(float(1), float(0));
  const flash = exp(T.mul(-9)).mul(live);                                     // white, at once, then gone
  const swell = mix(float(1), float(1.14), sin(clamp(T.mul(3.2), 0, 1).mul(Math.PI)));   // the disc past its size and back

  const flatMat = (blending = THREE.NormalBlending) => {
    const m = new MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, blending,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    m.toneMapped = false;       // a mark, not a lit surface: its colours exact
    m.forceSinglePass = true;
    return m;
  };
  // The angle round the centre as 0..1, clockwise seen from above, from the top (−z: away from the
  // camera, CoH's 12 o'clock).
  const turn = Fn(() => fract(atan(positionLocal.x, positionLocal.z.negate()).div(TAU).add(1)));
  const W = Math.max(P.ringMin, radius * P.ringWidth);

  // ── RING (with room either side for its dark edge) ───────────────────────────
  const GLOW = W * 1.2;   // (the mesh's margin either side: room for the dark edge only now)
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius - W - GLOW, radius + GLOW, 256, 1).rotateX(-Math.PI / 2), flatMat());
  {
    const m = ring.material;
    const a = turn(), r = length(positionLocal.xz);
    const rw = fwidth(r).mul(1.2);
    const core = band(r, radius - W, radius, rw);
    // DASH-DOT: a long dash, a gap, a dot, a gap.
    const d = a.mul(P.dashes), f = fract(d), fw = fwidth(d);
    const dashDot = max(band(f, 0, 0.58, fw), band(f, 0.7, 0.79, fw));
    const filled = float(1).sub(smoothstep(U.progress.sub(fwidth(a).mul(1.5)), U.progress, a));
    // Either side of the band: a faint dark edge (neutral, legible on sand).
    const off = max(r.sub(radius).max(0), float(radius - W).sub(r).max(0)).div(GLOW);   // 0 at the band, 1 at the mesh's edge
    const halo = exp(off.mul(-4)).mul(float(1).sub(core));
    // (no glow round the held ring — you; the flash still runs through the line itself)
    const darkA = halo.mul(0.22).mul(float(1).sub(filled)).mul(band(r, radius - W - W * 0.9, radius + W * 0.9, rw));
    const lineA = mix(dashDot, float(1), filled).mul(core);
    const lineCol = mix(U.base, U.fill, filled).add(flash.mul(0.9));
    m.colorNode = mix(mix(vec3(0.05, 0.05, 0.05), U.fill.mul(1.3), filled), lineCol, core);
    m.opacityNode = clamp(lineA.add(darkA), 0, 1);
  }

  // ── DISC (icy, rim-lit, a white rim, ticks outside it) ──────────────────────
  const r0 = radius * P.discFrac;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(r0 * 1.16, 160).rotateX(-Math.PI / 2), flatMat());
  {
    const m = disc.material;
    // The swell scales the whole disc (its rim and ticks with it).
    m.positionNode = vec3(positionLocal.x.mul(swell), positionLocal.y, positionLocal.z.mul(swell));
    const rn = length(positionLocal.xz).div(r0);                          // 0 centre .. 1 rim (.. 1.16 the ticks)
    const fw = fwidth(rn).mul(1.2);
    const ice = mix(U.fill, vec3(1, 1, 1), 0.22);   // (0.38 read grey-white beside CoH's pale blue)
    const body = float(0.3).add(smoothstep(0.45, 0.97, rn).mul(0.32)).mul(float(1).sub(smoothstep(float(0.985).sub(fw), 0.985, rn)));
    const rim = band(rn, 0.955, 1.0, fw);
    const d = turn().mul(P.discTicks), df = fract(d), dfw = fwidth(d);
    const ticks = band(rn, 1.06, 1.14, fw).mul(band(df, 0.15, 0.6, dfw));
    const breathe = sin(time.mul(1.6)).mul(0.04).add(1);
    m.colorNode = mix(ice, vec3(1, 1, 1), max(rim, ticks).mul(0.85).add(flash.mul(0.7)).min(1));
    // THE DISSOLVE: over the last 45 % of the capture an edge sweeps from the centre out past the
    // ticks, wavy round the disc; behind it the disc is gone. After the capture: nothing (live = 0).
    const fadeT = clamp(T.sub(0.55).div(0.45), 0, 1);
    const edge = fadeT.mul(1.35).sub(0.12);
    const wobble = sin(turn().mul(TAU * 7).add(rn.mul(9))).mul(0.05);
    const dissolve = smoothstep(edge, edge.add(0.16), rn.add(wobble));
    const appear = clamp(T.mul(14), 0, 1);                               // in with the flash
    m.opacityNode = clamp(body.mul(breathe).add(rim.mul(0.95)).add(ticks.mul(0.9)).add(flash.mul(0.35).mul(smoothstep(1.0, 0.0, rn))), 0, 1).mul(dissolve).mul(appear).mul(live);
  }

  // ── CAPTURE: two waves out to the ring + the centre's burst (additive) ───────
  const wave = new THREE.Mesh(new THREE.CircleGeometry(radius * 1.04, 192).rotateX(-Math.PI / 2), flatMat(THREE.AdditiveBlending));
  {
    const m = wave.material;
    const r = length(positionLocal.xz).div(radius);
    const ease = (t) => float(1).sub(pow(float(1).sub(clamp(t, 0, 1)), 3));
    const f1 = ease(T.mul(2)), f2 = ease(T.mul(2).sub(0.18));   // (×2 over the 2.4 s capture: out to the ring in ~1.2 s, as before)
    // (they die fast once at the ring: a slow fade lingered on it like the glow you did not want)
    const sharp = exp(abs(r.sub(f1)).div(0.022).negate()).mul(pow(float(1).sub(T), 2.4));
    const soft = exp(abs(r.sub(f2)).div(0.09).negate()).mul(0.45).mul(pow(float(1).sub(T), 2.8));
    // The ground between the centre and the front lit, then fading.
    const sweep = smoothstep(f1, f1.sub(0.5), r).mul(0.18).mul(pow(float(1).sub(T), 2));
    const burst = exp(r.mul(-10)).mul(flash).mul(2.2);
    const k = sharp.add(soft).add(sweep).add(burst).mul(live);
    m.colorNode = mix(U.fill.mul(1.7), vec3(1, 1, 1), min(burst.add(sharp.mul(0.35)), 1));
    m.opacityNode = clamp(k, 0, 1);
  }

  // ── CAPTURE: the column of light round the mast (additive, open cylinder) ────
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.6, P.pillarH, 40, 1, true).translate(0, P.pillarH / 2, 0), flatMat(THREE.AdditiveBlending));
  {
    const m = pillar.material;
    const v = uv().y, a = uv().x;                                         // up the column, round it
    const rise = clamp(T.mul(5), 0, 1);                                   // it shoots up first
    const env = rise.mul(pow(float(1).sub(T), 1.4));
    const fade = float(1).sub(smoothstep(rise.mul(0.85), rise, v)).mul(pow(float(1).sub(v), 1.3));
    // Streaks round it, scrolling up.
    const s = fract(a.mul(14).add(sin(a.mul(71)).mul(0.3)));
    const stripes = band(s, 0.2, 0.5, 0.08).mul(0.7).add(0.3);
    const scroll = fract(v.mul(3).sub(time.mul(1.6)).add(a.mul(5)));
    const shimmer = smoothstep(0, 0.4, scroll).mul(float(1).sub(smoothstep(0.6, 1, scroll))).mul(0.5).add(0.5);
    m.colorNode = mix(U.fill.mul(1.6), vec3(1, 1, 1), 0.25);
    m.opacityNode = clamp(fade.mul(stripes).mul(shimmer).mul(env).mul(0.75), 0, 1).mul(live);
  }

  // ── CAPTURE: light streaks rising out of the disc (additive, crossed quads) ──
  const streaks = new THREE.Mesh(buildStreaks(P.streaks, 0.45), flatMat(THREE.AdditiveBlending));
  {
    const m = streaks.material;
    const ph = uv().x;                                                    // per streak: its delay 0..1
    const v = uv().y;                                                     // 0 foot .. 1 head
    // Each line its own moment and its own height (you: "they shouldn't be at the same level"): it
    // starts 0-0.4 into the capture and climbs to 45-100 % of streakH.
    const local = clamp(T.sub(ph.mul(0.4)).mul(1.9), 0, 1);
    const reach = fract(ph.mul(7.31)).mul(0.55).add(0.45);
    const rise = float(1).sub(pow(float(1).sub(local), 2.2));
    const len = mix(float(5), float(2.2), local);
    const y = rise.mul(reach).mul(P.streakH).add(v.mul(len)).sub(len.mul(0.4));
    m.positionNode = vec3(positionLocal.x, max(y, 0), positionLocal.z);
    const shape = smoothstep(0, 0.45, v).mul(float(1).sub(smoothstep(0.7, 1, v)));
    const on = local.greaterThan(0).select(float(1), float(0)).mul(float(1).sub(smoothstep(0.55, 1, local)));
    m.colorNode = mix(U.fill.mul(1.9), vec3(1, 1, 1), 0.35);
    m.opacityNode = shape.mul(on).mul(0.95).mul(live);
  }
  streaks.frustumCulled = pillar.frustumCulled = false;

  for (const mesh of [ring, disc, wave]) mesh.position.y = lift;
  // The bands (renderOrder.js): the marks lie ON the ground, the column and the streaks stand in
  // the AIR. (Disc and ring never overlap; the wave is additive — its order against them does not show.)
  disc.renderOrder = ring.renderOrder = wave.renderOrder = RENDER_ORDER.ON_GROUND;
  pillar.renderOrder = streaks.renderOrder = RENDER_ORDER.AIR;
  group.add(disc, ring, wave, pillar, streaks);

  // ── State ─────────────────────────────────────────────────────────────────
  let burstT = 1;           // the capture animation, 0..1 (1 = over)
  const api = {
    group,
    uniforms: U,
    /**
     * @param {object} s
     * @param {"player"|"enemy"|null} s.owner      who holds it (null: nobody)
     * @param {"player"|"enemy"|null} [s.capturer] who is filling it (the owner's colour when held)
     * @param {number} [s.progress]                0..1 of the ring filled by the capturer
     * @param {boolean} [s.cut]                    held by France but cut off from the post: amber
     */
    set({ owner = null, capturer = owner, progress = owner ? 1 : 0, cut = false }) {
      U.fill.value.set(cut && owner === "player" ? POINT_COLOURS.cut : POINT_COLOURS[capturer ?? owner ?? "player"]);
      U.progress.value = owner ? 1 : progress;
    },
    /** The moment of capture: the flash, the waves, the column, the streaks; the disc swells in. */
    capture(owner) {
      api.set({ owner });
      burstT = 0;
    },
    update(dt) {
      if (burstT < 1) burstT = Math.min(1, burstT + dt / P.captureS);
      U.burst.value = burstT;
      // (the disc too: it lives only in the capture now)
      disc.visible = streaks.visible = wave.visible = pillar.visible = burstT < 1;
    },
    dispose() {
      for (const mesh of [ring, disc, wave, pillar, streaks]) { mesh.geometry.dispose(); mesh.material.dispose(); }
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
    const a = (i / n) * TAU + rnd() * 0.4, r = 0.25 + rnd() * spread;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r, w = 0.018 + rnd() * 0.017, delay = rnd();
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
