/**
 * v3/render/water/riverSandTsl.js — sand along a River v2 channel.
 *
 * A band of sand painted onto the terrain under AND around the river, the way
 * an auto-paint layer would do it. Deliberately NOT the lakebed treatment: no
 * caustics, no depth tint, no dependence on the water-surface map. Caustics are
 * light refracted through water and have no business on a dry bank; this is
 * just the ground next to a river being sand instead of grass.
 *
 * WHERE THE BAND COMES FROM. River v2's conform already runs a nearest-segment
 * search that leaves, per terrain texel, the distance to the closest river
 * centreline and which segment won (see riverV2System's "nearest, then resolve"
 * note). That is exactly a signed distance field for the river network, already
 * on the GPU and already updated on every edit — so the band costs one texture
 * fetch plus the channel lookup, and it follows the river's own width because
 * the winning segment carries it.
 *
 * The band is therefore measured from the CENTRELINE outwards, not from the
 * waterline: `halfWidth + width` metres, faded over the last `fade` of it. That
 * is what puts sand under the water and on the bank in one continuous sweep,
 * which is how a real river margin looks.
 *
 * The sand keeps the terrain's own detail: rather than replacing the colour it
 * multiplies the sand hue by the ground's luminance, so whatever texture is
 * painted underneath still reads through instead of going flat.
 */

import * as THREE from "three";
import {
  Fn, If, uniform, float, vec2, vec3,
  mix, smoothstep, max, min, dot, sqrt, floor, fract, positionWorld, texture,
} from "three/tsl";

/** Must match riverV2System's path texture width. */
const PATH_POINTS = 2048;
/** Distance² written by the search where nothing was found. */
const NO_RIVER = 1e8;

const _hash = /*#__PURE__*/ Fn(([p]) => {
  const pp = fract(p.mul(vec2(127.1, 311.7)));
  const d = dot(pp, pp.add(45.32));
  return fract(pp.x.add(d).mul(pp.y.add(d)));
});

const _vnoise = /*#__PURE__*/ Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  return mix(
    mix(_hash(i), _hash(i.add(vec2(1, 0))), u.x),
    mix(_hash(i.add(vec2(0, 1))), _hash(i.add(vec2(1, 1))), u.x),
    u.y,
  );
});

export const RIVER_SAND_DEFAULTS = {
  enabled: true,
  color: "#c9ab7c",
  /** How much of the sand hue replaces the ground. 1 = fully sand. */
  strength: 0.9,
  /** Metres of sand BEYOND the channel's own half-width, on each side. */
  width: 7,
  /** Metres of the outer band spent fading back to the painted ground. */
  fade: 4.5,
  /** Wobble on the outer edge, in metres, so it is not a perfect ribbon. */
  edgeNoise: 3,
  /** Noise cells per metre along that edge. */
  edgeNoiseScale: 0.05,
  /** How much of the ground's own luminance survives, so detail reads through. */
  detail: 0.5,
};

/**
 * The terrain material is built long before River v2 exists, so the texture
 * nodes are created here with a "no river anywhere" placeholder and pointed at
 * the real render targets by `setSources` once the system is up.
 *
 * @param {object} deps
 * @param {number} deps.worldSize
 */
export function createRiverSandShading({ worldSize }) {
  const p = { ...RIVER_SAND_DEFAULTS };

  // 1x1 stand-ins. The distance² channel reads far beyond any river, so the
  // band is off until real sources arrive even if `active` is somehow set.
  const blankNear = new THREE.DataTexture(
    new Float32Array([1e9, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType,
  );
  blankNear.needsUpdate = true;
  const blankPath = new THREE.DataTexture(
    new Float32Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType,
  );
  blankPath.needsUpdate = true;

  const nearNode = texture(blankNear);
  const pathNode = texture(blankPath);

  const u = {
    enabled: uniform(p.enabled ? 1 : 0),
    /** Set to 0 whenever there are no rivers, so the band cannot linger. */
    active: uniform(0),
    color: uniform(new THREE.Color(p.color)),
    strength: uniform(p.strength),
    width: uniform(p.width),
    fade: uniform(p.fade),
    edgeNoise: uniform(p.edgeNoise),
    edgeNoiseScale: uniform(p.edgeNoiseScale),
    detail: uniform(p.detail),
  };

  const apply = (baseColor) => Fn(() => {
    const out = vec3(baseColor).toVar();

    If(u.enabled.mul(u.active).greaterThan(0.5), () => {
      const wxz = positionWorld.xz;
      const near = texture(nearNode, wxz.div(float(worldSize)).add(0.5));

      If(near.r.lessThan(float(NO_RIVER)), () => {
        // Distance is stored squared and in UV units; the field is built by the
        // conform, so it is live without any extra bake.
        const dist = sqrt(max(near.r, float(0))).mul(float(worldSize));

        // The winning segment's half-width, so the band tracks a river that
        // narrows and widens along its length.
        const uA = near.g.add(0.5).div(float(PATH_POINTS));
        const uB = near.g.add(1.5).div(float(PATH_POINTS));
        const halfW = mix(
          texture(pathNode, vec2(uA, 0.25)).w,
          texture(pathNode, vec2(uB, 0.25)).w,
          near.b,
        ).mul(float(worldSize));

        // A little wander on the outer edge, or the band reads as a decal.
        const wobble = _vnoise(wxz.mul(u.edgeNoiseScale))
          .sub(0.5).mul(u.edgeNoise);
        const outer = halfW.add(u.width).add(wobble);
        const band = float(1).sub(
          smoothstep(max(outer.sub(u.fade), float(0)), max(outer, float(1e-3)), dist),
        );

        If(band.greaterThan(0.001), () => {
          // Multiply rather than replace: the ground's own luminance carries the
          // painted texture's detail through the sand instead of flattening it.
          const luma = dot(out, vec3(0.299, 0.587, 0.114));
          const shade = mix(float(1), luma.mul(2).clamp(0.35, 1.6), u.detail);
          const sand = u.color.mul(shade);
          out.assign(mix(out, sand, band.mul(u.strength).clamp()));
        });
      });
    });

    return out;
  })();

  function syncParams(s) {
    if (!s) return;
    if (s.enabled != null) u.enabled.value = s.enabled ? 1 : 0;
    if (s.color != null) u.color.value.set(s.color);
    if (s.strength != null) u.strength.value = s.strength;
    if (s.width != null) u.width.value = s.width;
    if (s.fade != null) u.fade.value = s.fade;
    if (s.edgeNoise != null) u.edgeNoise.value = s.edgeNoise;
    if (s.edgeNoiseScale != null) u.edgeNoiseScale.value = s.edgeNoiseScale;
    if (s.detail != null) u.detail.value = s.detail;
  }

  /** River v2 calls this so the band vanishes when the last river is deleted. */
  function setActive(on) { u.active.value = on ? 1 : 0; }

  /** Point at River v2's live render targets once the system exists. */
  function setSources(nearTex, pathTex) {
    if (nearTex) nearNode.value = nearTex;
    if (pathTex) pathNode.value = pathTex;
  }

  return { apply, syncParams, setActive, setSources, uniforms: u };
}
