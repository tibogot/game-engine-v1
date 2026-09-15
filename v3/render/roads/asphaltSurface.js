/**
 * v3/render/roads/asphaltSurface.js — THE shared asphalt: the modular-road city
 * street's surface, re-keyed to a road frame so any road can use it.
 *
 * WHY THIS FILE EXISTS. games/modular-road-v3/modularRoadCityStreets.js holds
 * the best asphalt in the repo — cellular stones in the albedo AND the relief,
 * a streaked macro tone, resurfacing patches with sealant seams, gloss that
 * follows the aggregate, edge-eaten paint wear, a wet film. But it is welded to
 * the city's axis-aligned block grid (`layout()` derives everything from world
 * x/z), and it was itself a hand copy of the track asphalt that kept drifting
 * from it. The fix recorded in the project notes is to share ONE surface taking
 * an explicit frame; this is that surface. The lane road uses it first; the
 * city street and the track deck can move onto it later, each A/B'd.
 *
 * WHAT A CALLER PROVIDES — `frame()`, called inside every node slot (normalNode
 * and clearcoatNormalNode are sub-builds and cannot read another slot's
 * variables, so the frame must be cheap to rebuild):
 *   along     metres along the road (the streak axis)
 *   across    metres across the road
 *   lateral   −1..1 across a LANE — where the wheel paths are
 *   drain     −1..1 across a CARRIAGEWAY, 0 at the crown — where water runs to
 *
 * WHAT IS PORTED, term for term from the city street (defaults included):
 *   - macro tone: 3-octave value noise on (along/streak, across), streak 14
 *   - stones: 2D cellular chips (binder darkening, per-stone tone), band-limited
 *     on the ACROSS footprint (the grazing-angle fix the city street found)
 *   - resurfacing patches + sealant seams, darker and glossier — laid out in the
 *     road frame, so they line up with the road instead of the world grid
 *   - roughness: deck + macro/aggregate variation − wheel-path polish − patches
 *   - relief: grit + the SAME cellular stones, as a normal map
 *   - wet: wetRoad.js (film, ponding, clearcoat ripple), with drainage
 *     keyed to `drain`
 *   - paint: a caller hook (v3/render/roads/laneRoadPaint.js) shaded with the
 *     track's paint terms (lineRough / lineWet / lineCoat / lineCoatRough)
 *
 * ONE DELIBERATE DIFFERENCE: the relief normal. The city street differentiates
 * its height in SCREEN space, which is fine on its two-triangle ground plane;
 * modularRoadSurfaceV2 measured that the same trick stripes along triangle
 * edges on a tessellated road. So the height is sampled three times in road
 * metres (centre, +along, +across) with tap spacing following the pixel
 * footprint, as V2 does.
 *
 * NOT PORTED: the city's night terms (lamp pools, neon wash, checkpoint ring)
 * and its planar car reflection — they belong to the game's lamps and car.
 */
import * as THREE from "three";
import { MeshStandardNodeMaterial, MeshPhysicalNodeMaterial } from "three/webgpu";
import {
  Fn, float, vec2, vec3, vec4, uniform, attribute, uv, floor, fract, mix, min, max, sqrt, abs, step, smoothstep,
  saturate, oneMinus, fwidth, uint, hash, normalMap, length, positionWorld, cameraPosition,
} from "three/tsl";
import { WET_DEFAULTS, WET_COLORS, createWetShading, wetClearcoatNormal } from "./wetRoad.js";

/** City street defaults (modularRoadCityStreets.js STREET_DEFAULTS) for the terms this file carries. */
export const ASPHALT_DEFAULTS = {
  // Tone — "LIGHTER AND FINER THAN THE TRACK, on purpose".
  asphaltDark: 0x2b2f34,
  asphaltLight: 0x6a7076,
  deckBrightness: 1.0,
  grainScale: 1.0,
  streak: 14,
  macroScale: 0.06,
  aggScale: 7.5,
  aggWeight: 0.55,
  // Stones.
  chipScale: 24,
  chipJitter: 0.9,
  chipSharp: 0.30,
  chipVary: 0.30,
  binderDepth: 0.38,
  chipStretch: 2.0,
  chipFadeRate: 1.0,
  // Gloss.
  deckRough: 0.93,
  roughVary: 0.10,
  wheelDarken: 0.10,
  wheelRough: 0.12,
  // Resurfacing patches.
  patchAmount: 0.55,
  patchScale: 9.0,
  patchChance: 0.22,
  patchDarken: 0.30,
  patchSeam: 0.45,
  patchSeamWidth: 0.07,
  // Relief.
  gritRelief: 0.008,
  chipRelief: 0.014,
  reliefFade: 1.5,
  detailNear: 25,
  detailFar: 240,
  // Paint as a material (track terms; the city street uses the same numbers).
  lineRough: 0.55,
  lineWet: 0.35,
  lineCoat: 1.4,
  lineCoatRough: 0.5,
  // Wet — the city's values over the wet model's defaults.
  ...WET_DEFAULTS,
  wetCoatStrength: 0.55,
  wetDarken: 0.48,
  wetRough: 0.32,
  wetCoatRough: 0.10,
  puddleScale: 0.2,
  puddleStreak: 3.0,
  puddleThreshold: 0.58,
  puddleSoft: 0.035,
  puddleDarken: 0.42,
  puddleCoatRough: 0.012,
  wetDrainStart: 0.3,
  wetCamber: 1.0,
  wetDrainStrength: 0.22,
  wetWheelClear: 0.45,
  rippleAmp: 0.05,
  rippleScale: 1.6,
  rippleStretch: 2.5,
  rippleDamp: 0.9,
};

const COLOR_KEYS = new Set(["asphaltDark", "asphaltLight", ...WET_COLORS]);

/* ── Noise, from the city street (2D, integer PCG hash — no 3D Perlin) ──────── */

export const ihash2 = (i) => hash(
  uint(i.x.add(1 << 16)).mul(uint(73856093)).bitXor(uint(i.y.add(1 << 16)).mul(uint(19349663))),
);

/** 2D value noise, −0.5..0.5. */
export const vnoise = /*#__PURE__*/ Fn(([p]) => {
  const i = floor(p), f = fract(p);
  const w = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  const a = ihash2(i), b = ihash2(i.add(vec2(1.0, 0.0)));
  const c = ihash2(i.add(vec2(0.0, 1.0))), d = ihash2(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y).sub(0.5);
});

/** 2D cellular: vec2(distance to the nearest feature point, that cell's tone 0..1). */
export const cellular = /*#__PURE__*/ Fn(([p, jitter]) => {
  const ip = floor(p).toVar();
  const fp = p.sub(ip).toVar();
  const best = float(8.0).toVar();
  const tone = float(0.5).toVar();
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const off = vec2(ox, oy);
      const cell = ip.add(off);
      const jx = ihash2(cell);
      const jy = ihash2(cell.add(vec2(37.0, 17.0)));
      const pt = off.add(vec2(jx, jy).sub(0.5).mul(jitter).add(0.5));
      const dv = pt.sub(fp);
      const d2 = dv.dot(dv);
      tone.assign(mix(tone, ihash2(cell.add(vec2(-11.0, 53.0))), step(d2, best)));
      best.assign(min(best, d2));
    }
  }
  return vec2(sqrt(best), tone);
});

export const vfbm = (p) => vnoise(p).add(vnoise(p.mul(2.17)).mul(0.5));
export const vfbm3 = (p) => vfbm(p).add(vnoise(p.mul(4.7)).mul(0.25));

/** Anti-aliased "x inside [lo, hi]". */
const band = (x, lo, hi, aa) => smoothstep(lo.sub(aa), lo.add(aa), x).mul(smoothstep(hi.add(aa), hi.sub(aa), x));

/**
 * @param {object} opts
 * @param {() => {along, across, lateral, drain}} opts.frame   see the header
 * @param {object} [opts.params]   ASPHALT_DEFAULTS overrides
 * @param {(u, ctx) => {coverage, color}} [opts.paint]   paint hook; ctx.surface = vec4(macro, agg, wheelPath, fade)
 * @param {boolean} [opts.wet]     compile the water film in (build-time, like the track material)
 * @param {number} [opts.side]
 * @returns {THREE.Material} with `_asphaltUniforms`
 */
export function createAsphaltMaterial({ frame, params = {}, paint = null, wet = false, side = THREE.FrontSide } = {}) {
  const P = { ...ASPHALT_DEFAULTS, ...params };
  const u = {};
  for (const [k, v] of Object.entries(P)) {
    if (typeof v === "number") u[k] = uniform(COLOR_KEYS.has(k) ? new THREE.Color(v) : v);
  }

  const mat = wet
    ? new MeshPhysicalNodeMaterial({ roughness: 0.92, metalness: 0, side })
    : new MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0, side });

  const wheelPathOf = (lateral) => smoothstep(0.18, 0.42, abs(lateral)).mul(oneMinus(smoothstep(0.55, 0.8, abs(lateral))));

  /**
   * vec4(macro, aggregate/stone tone, wheel path, aggregate fade) — the same
   * packing the track material's `surface` uses, so the paint hook can key its
   * wear off it. Built ONCE and referenced by every slot that can share it.
   */
  const surface = Fn(() => {
    const F = frame();
    const acrossPx = fwidth(F.across).toVar();
    const macro = vfbm3(vec2(F.along.div(u.streak), F.across).mul(u.macroScale)).add(0.5);
    const chipFade = saturate(oneMinus(acrossPx.mul(u.chipScale).mul(2.0).mul(u.chipFadeRate)));
    const cell = cellular(vec2(F.along.div(u.chipStretch), F.across).mul(u.chipScale), u.chipJitter);
    const edge = mix(float(0.85), float(0.28), u.chipSharp);
    const stone = oneMinus(smoothstep(edge.mul(0.35), edge, cell.x)).mul(chipFade);
    const vary = cell.y.sub(0.5).mul(u.chipVary);
    const agg = saturate(float(0.5).add(stone.sub(0.5).mul(u.binderDepth)).add(vary.mul(stone)));
    return vec4(macro, agg, wheelPathOf(F.lateral), chipFade);
  })();

  /** vec2(patch, seam) — resurfacing rectangles on a jittered grid in the road frame. */
  const patches = Fn(() => {
    const F = frame();
    const px = max(fwidth(F.along), fwidth(F.across));
    const pc = vec2(F.along, F.across).div(u.patchScale);
    const pcell = floor(pc), fpc = fract(pc);
    const on = step(ihash2(pcell), u.patchChance);
    const ix = ihash2(pcell.add(vec2(31.0, 17.0))).mul(0.18).add(0.08);
    const iz = ihash2(pcell.add(vec2(-13.0, 41.0))).mul(0.18).add(0.08);
    const aaP = px.div(u.patchScale).add(1e-4);
    const inside = band(fpc.x, ix, float(1.0).sub(ix), aaP).mul(band(fpc.y, iz, float(1.0).sub(iz), aaP));
    const sw = u.patchSeamWidth.div(u.patchScale);
    const outer = band(fpc.x, ix.sub(sw), float(1.0).sub(ix).add(sw), aaP)
      .mul(band(fpc.y, iz.sub(sw), float(1.0).sub(iz).add(sw), aaP));
    const amt = on.mul(u.patchAmount);
    return vec2(inside.mul(amt), outer.sub(inside).max(0.0).mul(amt));
  })();

  const paintNodes = paint ? paint(u, { surface }) : { coverage: float(0), color: vec3(1, 1, 1) };
  const paintAmt = paintNodes.coverage;

  // The wet model reads aLateral (camber) and aCurve (bank): answer both from
  // the frame — water drains across the CARRIAGEWAY to its kerbs, and a flat
  // city road has no bank.
  const wetAttr = (name, type) => (name === "aLateral" ? frame().drain : name === "aCurve" ? float(0) : attribute(name, type));
  const W = wet ? createWetShading(u, surface.z, { attr: wetAttr }) : null;

  mat.colorNode = Fn(() => {
    const macro = surface.x, agg = surface.y, wheel = surface.z;
    const tone = macro.mul(oneMinus(u.aggWeight)).add(agg.mul(u.aggWeight));
    const shaped = saturate(tone.sub(0.5).mul(u.grainScale).add(0.5));
    let deck = mix(u.asphaltDark, u.asphaltLight, shaped);
    deck = deck.mul(oneMinus(wheel.mul(u.wheelDarken)));
    deck = deck.mul(oneMinus(patches.x.mul(u.patchDarken))).mul(oneMinus(patches.y.mul(u.patchSeam)));
    deck = deck.mul(u.deckBrightness);
    if (W) deck = deck.mul(W.albedoScale).mul(W.tint);
    let lineCol = paintNodes.color;
    if (W) {
      const lw = W.film.mul(u.lineWet);
      lineCol = lineCol.mul(mix(float(1), u.wetDarken, lw)).mul(mix(vec3(1, 1, 1), u.wetTint, lw));
    }
    return mix(deck, lineCol, paintAmt);
  })();

  mat.roughnessNode = Fn(() => {
    const macro = surface.x, agg = surface.y, wheel = surface.z;
    const roughN = macro.sub(0.5).mul(u.roughVary).add(agg.sub(0.5).mul(u.roughVary).mul(0.5));
    let r = u.deckRough.add(roughN).sub(wheel.mul(u.wheelRough)).sub(patches.x.mul(0.10)).sub(patches.y.mul(0.22));
    if (W) r = mix(r, W.substrateRough, W.film);
    const paintRough = W ? mix(u.lineRough, W.substrateRough, W.film) : u.lineRough;
    return saturate(mix(r, paintRough, paintAmt)).max(0.05);
  })();

  if (W) {
    mat.clearcoatNode = saturate(W.coat.mul(mix(float(1), u.lineCoat, paintAmt)));
    mat.clearcoatRoughnessNode = mix(W.coatRough, W.coatRough.mul(u.lineCoatRough), paintAmt);
    mat.clearcoatNormalNode = wetClearcoatNormal(W);
  }

  /**
   * RELIEF — grit + the stones, sampled in road metres. A sub-build: it rebuilds
   * the frame and its own fields (it cannot read the colour pass's variables).
   * Tap spacing follows the pixel footprint on each axis (never under 4 mm),
   * which both filters the relief at distance and keeps the difference from
   * spiking at triangle edges the way a screen-space derivative does.
   */
  mat.normalNode = Fn(() => {
    const F = frame();
    const eA = max(fwidth(F.along), 0.004).toVar();
    const eC = max(fwidth(F.across), 0.004).toVar();
    const acrossPx = fwidth(F.across);
    const aggFade = saturate(oneMinus(acrossPx.mul(u.aggScale).mul(2.0))).toVar();
    const chipFade = saturate(oneMinus(acrossPx.mul(u.chipScale).mul(u.reliefFade))).toVar();
    const edge = mix(float(0.85), float(0.28), u.chipSharp).toVar();
    const heightAt = (a, c) => {
      const grit = vnoise(vec2(a.div(u.streak), c).mul(u.aggScale)).mul(aggFade);
      const cell = cellular(vec2(a.div(u.chipStretch), c).mul(u.chipScale), u.chipJitter);
      const chip = oneMinus(smoothstep(edge.mul(0.35), edge, cell.x)).sub(0.5).mul(chipFade);
      return grit.mul(u.gritRelief).add(chip.mul(u.chipRelief));
    };
    const h0 = heightAt(F.along, F.across);
    const hA = heightAt(F.along.add(eA), F.across);
    const hC = heightAt(F.along, F.across.add(eC));
    const detail = smoothstep(u.detailFar, u.detailNear, length(positionWorld.sub(cameraPosition)));
    const sA = hA.sub(h0).div(eA).mul(detail);
    const sC = hC.sub(h0).div(eC).mul(detail);
    // Tangent space = (along, across): three derives it from the uv
    // derivatives, and uv IS (along, across) on the road.
    return normalMap(vec3(sA.negate(), sC.negate(), 1.0).normalize().mul(0.5).add(0.5));
  })();

  mat._asphaltUniforms = u;
  mat._asphaltWet = wet;
  return mat;
}

/** Push panel values into a material's uniforms (colours as hex). */
export function syncAsphaltUniforms(mat, params) {
  const u = mat?._asphaltUniforms;
  if (!u) return;
  for (const [k, v] of Object.entries(params)) {
    if (!u[k]) continue;
    if (COLOR_KEYS.has(k)) u[k].value.set(v);
    else if (typeof v === "number") u[k].value = v;
  }
}

/** The lane-road frame: uv = (station, lateral t), per-lane aLateral, carriageway drain in aPiece.y. */
export function laneRoadFrame() {
  return {
    along: uv().x,
    across: uv().y,
    lateral: attribute("aLateral", "float"),
    drain: attribute("aPiece", "vec2").y,
  };
}
