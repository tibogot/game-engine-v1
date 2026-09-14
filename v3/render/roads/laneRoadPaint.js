/**
 * v3/render/roads/laneRoadPaint.js — lane-road markings, painted by the asphalt
 * shader so they share its wear and its water.
 *
 * Plugs into games/modular-road-v3/modularRoadMaterial.js through `opts.paint`:
 * this returns WHERE the paint is and its colour; that material shades it (dry
 * roughness, wet darkening, clearcoat gloss) with the same fields as the deck.
 *
 * TWO SOURCES, one coverage:
 *
 *   LINES ALONG A ROAD — analytic. Each lane strip carries the line on its two
 *   sides (aEdges: lateral position + style code, see lineCode() in
 *   v3/roads/mesh/laneRoadMesh.js). A line centred on a lane boundary is drawn
 *   half by each strip. Width, dash pattern (metres along the road), yellow and
 *   double lines are decoded here. Parking-bay ticks come from aMark.w.
 *
 *   NODE SHAPES — a signed-distance atlas (v3/roads/mesh/markingAtlas.js):
 *   crosswalks, stop and yield lines, arrows, hatching, ring lines. aMark.xy is
 *   the region's offset, sampled at plan x/z (positionLocal — the group is moved
 *   in the world, the atlas is built in plan space).
 *
 * WEAR — the modular-road city street's model, not a new one. Tyres eat paint
 * from its EDGE inward: a noise "finger" field subtracts from each line's
 * half-width, scaled by how old this stretch is (`wearAge`) and by whether it
 * lies in a wheel path. The bite is a FRACTION of the line's own width, so a
 * 12 cm lane line and a 50 cm crossing bar fray alike (the atlas stores each
 * shape's half-width for exactly this). A faint interior mottle keyed to the
 * aggregate tops keeps surviving paint from being a flat swatch.
 *
 * ANTIALIASING — each line is box-filtered against the pixel's footprint, so a
 * line thinner than a pixel fades to its true average coverage instead of
 * breaking into a crawling dotted line at distance.
 */
import * as THREE from "three";
import {
  Fn, attribute, uv, uniform, texture, positionLocal, positionWorld, float, vec2, vec3, vec4,
  abs, max, min, mix, saturate, step, smoothstep, fract, floor, fwidth, oneMinus, mx_noise_float,
} from "three/tsl";

export const PAINT_DEFAULTS = {
  paintWhite: "#d6d5cf",
  paintYellow: "#d4a12c",
  /** Peak wear on an old stretch in a wheel path, over 1 on purpose (see the city street). 0 = fresh paint. */
  wearAmount: 2.0,
  /** Fraction of a line's half-width a full-strength bite removes. */
  wearBite: 0.38,
  /** Wear away from the wheel paths, as a fraction of the wheel-path wear. */
  wearBase: 0.5,
  /** Cycles per metre of the edge fingers (~7 cm bites at 22). */
  wearFingerScale: 22,
  /** Second finger octave, as a multiple of the first. */
  wearFingerOctave: 2.7,
  /** Cycles per metre of the repaint-age field (~7 m runs at 0.15). */
  wearAgeScale: 0.15,
  /** Crossing bars and other node shapes wear at this fraction of the lane-line bite. */
  crossWear: 0.85,
  /** Interior mottle strength on the aggregate tops. */
  wearInterior: 0.04,
  wearLevel: 0.45,
  wearEdge: 0.07,
};

/** Empty 1×1 atlas so the material compiles before a network has markings. */
function emptyAtlas() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0]), 1, 1, THREE.RGFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

/**
 * @param {object} [params] PAINT_DEFAULTS overrides
 * @returns {{ hook, uniforms, setAtlas(atlas|null) }}
 *   hook     pass as createRoadMaterial({ paint: hook })
 *   setAtlas upload markingAtlas.js output (or null)
 */
export function createLaneRoadPaint(params = {}) {
  const p = { ...PAINT_DEFAULTS, ...params };
  const w = {
    paintWhite: uniform(new THREE.Color(p.paintWhite)),
    paintYellow: uniform(new THREE.Color(p.paintYellow)),
    wearAmount: uniform(p.wearAmount),
    wearBite: uniform(p.wearBite),
    wearBase: uniform(p.wearBase),
    wearFingerScale: uniform(p.wearFingerScale),
    wearFingerOctave: uniform(p.wearFingerOctave),
    wearAgeScale: uniform(p.wearAgeScale),
    crossWear: uniform(p.crossWear),
    wearInterior: uniform(p.wearInterior),
    wearLevel: uniform(p.wearLevel),
    wearEdge: uniform(p.wearEdge),
    atlasScale: uniform(new THREE.Vector2(1, 1)),
    atlasRange: uniform(0.3),
  };
  let atlasTex = emptyAtlas();
  const atlasNode = texture(atlasTex);

  function setAtlas(atlas) {
    const old = atlasTex;
    if (atlas) {
      atlasTex = new THREE.DataTexture(atlas.data, atlas.width, atlas.height, THREE.RGFormat, THREE.UnsignedByteType);
      atlasTex.magFilter = THREE.LinearFilter;
      atlasTex.minFilter = THREE.LinearFilter;
      atlasTex.generateMipmaps = false;
      atlasTex.wrapS = atlasTex.wrapT = THREE.ClampToEdgeWrapping;
      atlasTex.needsUpdate = true;
      w.atlasScale.value.set(atlas.scale[0], atlas.scale[1]);
      w.atlasRange.value = atlas.range;
    } else {
      atlasTex = emptyAtlas();
    }
    atlasNode.value = atlasTex;
    old.dispose();
  }

  /** Fraction of [centre − hw, centre + hw] inside a pixel box of width px centred at distance d. */
  const band = (d, hw, px) => saturate(min(d.add(hw), px.mul(0.5)).sub(max(d.sub(hw), px.mul(-0.5))).div(px));

  /**
   * The paint hook. `surface` = the deck's vec4(macro, aggregate, wheelPath, aggFade).
   * Returns nodes, not an Fn result object (an Fn returning an object collapses).
   */
  function hook(u, { surface }) {
    const paint = Fn(() => {
      const s = uv().x;
      const t = uv().y;
      const E = attribute("aEdges", "vec4");
      const M = attribute("aMark", "vec4");

      // ── Wear fields (city street model) ────────────────────────────────────
      const wxz = positionWorld.xz;
      const pxW = max(fwidth(wxz.x), fwidth(wxz.y));
      const wearAge = mx_noise_float(vec3(wxz.x.mul(w.wearAgeScale), 0.0, wxz.y.mul(w.wearAgeScale))).mul(0.5).add(0.5);
      const age = saturate(wearAge.mul(w.wearAmount)).toVar();
      const scrub = mix(w.wearBase, float(1.0), surface.z).mul(age).toVar();
      const fxz = wxz.mul(w.wearFingerScale);
      const fingerRaw = mx_noise_float(vec3(fxz.x, 7.3, fxz.y)).mul(0.5)
        .add(mx_noise_float(vec3(fxz.x.mul(w.wearFingerOctave), 3.1, fxz.y.mul(w.wearFingerOctave))).mul(0.25))
        .add(0.5);
      // Fingers smaller than a pixel would crawl: settle to their mean instead.
      const fingerFade = saturate(oneMinus(pxW.mul(w.wearFingerScale).mul(2.0)));
      const finger = saturate(mix(float(0.5), fingerRaw, fingerFade));
      const bite = finger.mul(scrub).mul(w.wearBite).toVar();

      // ── Lines along the road ───────────────────────────────────────────────
      const pxT = max(fwidth(t), 1e-4);
      const pxS = max(fwidth(s), 1e-4);
      const line = (tLine, packed) => {
        // Integer part = style, fraction = where this line's dash run starts (0..1 of a period).
        const code = floor(packed.add(1e-4));
        const runPhase = max(packed.sub(code), 0.0);
        const dbl = step(999.5, code);
        const c1 = code.sub(dbl.mul(1000));
        const yel = step(499.5, c1);
        const c2 = c1.sub(yel.mul(500));
        const dashI = floor(c2.add(0.5).div(50));
        const width = c2.sub(dashI.mul(50)).mul(0.01);
        // Dash tables: 1 [3,5]  2 [3,9]  3 [6,12]  4 [1.5,1.5] (metres).
        const on = step(0.5, dashI).mul(3).add(step(2.5, dashI).mul(3)).add(step(3.5, dashI).mul(-4.5));
        const period = max(step(0.5, dashI).mul(8).add(step(1.5, dashI).mul(4)).add(step(2.5, dashI).mul(6)).add(step(3.5, dashI).mul(-15)), 1.0);
        const ph = fract(s.div(period).sub(runPhase)).mul(period);
        const dashBox = saturate(min(ph.add(pxS.mul(0.5)), on).sub(max(ph.sub(pxS.mul(0.5)), 0.0)).div(pxS));
        const dash = mix(float(1), mix(dashBox, on.div(period), saturate(pxS.div(period).mul(2.0).sub(0.5))), step(0.5, dashI));
        const hw = width.mul(0.5).mul(oneMinus(bite));
        const d0 = abs(t.sub(tLine));
        const d = mix(d0, abs(d0.sub(width.mul(0.5).add(0.06))), dbl);
        const cov = band(d, hw, pxT).mul(dash).mul(step(0.001, width));
        return vec2(cov, yel);
      };
      const inner = line(E.x, E.z);
      const outer = line(E.y, E.w);

      // Parking bay ticks every 6 m across the lane.
      const q = fract(s.div(6.0));
      const tickD = min(q, oneMinus(q)).mul(6.0);
      const tick = band(tickD, float(0.05).mul(oneMinus(bite)), pxS).mul(M.w);

      // ── Node shapes from the atlas ─────────────────────────────────────────
      const auv = positionLocal.xz.mul(w.atlasScale).add(M.xy);
      const texel = atlasNode.sample(auv);
      const dA = texel.r.sub(0.5).mul(2.0).mul(w.atlasRange);
      // NOT the wheel path here: a crossing bar runs from lane asphalt (which has
      // wheel paths) onto a junction pad (which has no lanes, so none), and a
      // wheel-path term would step the worn edge exactly at the pad boundary.
      // Node shapes take the halfway wear instead, which is continuous.
      const biteShape = finger.mul(mix(w.wearBase, float(1.0), 0.5)).mul(age).mul(w.wearBite);
      const biteA = texel.g.mul(biteShape).mul(w.crossWear);
      const pxA = max(fwidth(dA), 1e-4);
      const shape = saturate(dA.sub(biteA).div(pxA).add(0.5)).mul(M.z);

      // ── Combine ────────────────────────────────────────────────────────────
      const cov = max(max(inner.x, outer.x), max(tick, shape));
      const yellow = saturate(max(inner.x.mul(inner.y), outer.x.mul(outer.y)).div(max(cov, 1e-4)));
      const wearTops = smoothstep(w.wearLevel.sub(w.wearEdge), w.wearLevel.add(w.wearEdge), surface.y);
      const worn = saturate(oneMinus(wearTops.mul(scrub).mul(w.wearInterior)));
      const color = mix(w.paintWhite, w.paintYellow, yellow);
      return vec4(color, cov.mul(worn));
    })();
    return { coverage: paint.w, color: paint.xyz };
  }

  return { hook, uniforms: w, setAtlas };
}
