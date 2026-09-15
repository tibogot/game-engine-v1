/**
 * v3/render/water/riverV2StylizedMaterial.js — River v2, stylized surface (TSL / WebGPU)
 *
 * The old River tool's "Stylized v1" look (v2/tools/river/riverSystem.js,
 * buildRiverStylizedFrag), ported term for term onto the River v2 ribbon:
 * a noise gradient between a dark and a body colour, a cyan shimmer band down
 * the middle, cell-noise foam along both banks cut into crisp blobs, and warped
 * cell-noise streaks thresholded into sharp white lines. Same noise functions,
 * same default numbers.
 *
 * Two things change, because the ribbon does:
 *
 *  - ACROSS. The old ribbon's v ran 0..1 bank to bank. River v2's uv.y is
 *    signed metres from the centreline and the ribbon overhangs its banks, so
 *    v = across / width + 0.5 with the water half-width from `aFlow.w`. The
 *    bank foam therefore sits on the waterline at any width, and the overhang
 *    (v < 0 or > 1) reads as foam until the depth test cuts it.
 *  - ALONG. The old u ran 0..1 over the WHOLE river, so its pattern stretched
 *    with river length. Here u = arc metres / `patternLength`: the same look at
 *    a fixed scale, on a short river or a long one.
 *
 * Flat and unlit like the original (no waves, refraction or reflections).
 * Composited against the grabbed backbuffer, like riverV2Material.js, with the
 * waterline found per pixel from the depth buffer. Same returned interface, so
 * riverV2System swaps one for the other.
 */

import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  Fn, uniform, float, vec2, mix, smoothstep, pow, min, length, dot, floor,
  fract, sin, cos, uv, attribute, positionView, cameraNear, cameraFar,
  screenUV, Discard, perspectiveDepthToViewZ,
} from "three/tsl";
import { sceneColorGrab, sceneDepthGrab } from "./lakeMaterial.js";
import { RIVER_STYLIZED_DEFAULTS } from "../../app/state/riverV2State.js";

// ─── Noise (verbatim from the old River's stylized shader) ──────────────────

const gradientNoise = /*#__PURE__*/ Fn(([p]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  const uu = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10));
  const rg = Fn(([ip]) => {
    const a = fract(sin(dot(ip, vec2(127.1, 311.7))).mul(43758.5453)).mul(Math.PI * 2);
    return vec2(cos(a), sin(a));
  });
  return mix(
    mix(dot(rg(i), f), dot(rg(i.add(vec2(1, 0))), f.sub(vec2(1, 0))), uu.x),
    mix(dot(rg(i.add(vec2(0, 1))), f.sub(vec2(0, 1))), dot(rg(i.add(vec2(1, 1))), f.sub(vec2(1, 1))), uu.x),
    uu.y,
  ).mul(0.5).add(0.5);
});

const voroF1 = /*#__PURE__*/ Fn(([p, jitter]) => {
  const ip = floor(p).toVar();
  const fp = fract(p).toVar();
  const md = float(10).toVar();
  for (const [nx, ny] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
    const off = vec2(float(nx), float(ny));
    const h = vec2(
      fract(sin(dot(ip.add(off), vec2(127.1, 311.7))).mul(43758.5453)),
      fract(sin(dot(ip.add(off), vec2(269.5, 183.3))).mul(43758.5453)),
    );
    md.assign(min(md, length(off.add(mix(vec2(0.5), h, jitter)).sub(fp))));
  }
  return md;
});

const voroFbm = /*#__PURE__*/ Fn(([pIn, jitter, octaves, lac, gain]) => {
  const p = pIn.toVar();
  const val = float(0).toVar();
  const amp = float(1).toVar();
  const total = float(0).toVar();
  val.addAssign(amp.mul(voroF1(p, jitter)));
  total.addAssign(amp);
  p.mulAssign(lac);
  amp.mulAssign(gain);
  const d2 = smoothstep(float(1), float(2), octaves);
  val.addAssign(amp.mul(voroF1(p, jitter)).mul(d2));
  total.addAssign(amp.mul(d2));
  p.mulAssign(lac);
  amp.mulAssign(gain);
  const d3 = smoothstep(float(2), float(3), octaves);
  val.addAssign(amp.mul(voroF1(p, jitter)).mul(d3));
  total.addAssign(amp.mul(d3));
  p.mulAssign(lac);
  amp.mulAssign(gain);
  const d4 = smoothstep(float(3), float(4), octaves);
  val.addAssign(amp.mul(voroF1(p, jitter)).mul(d4));
  total.addAssign(amp.mul(d4));
  return val.div(total);
});

const bandMask = /*#__PURE__*/ Fn(([y, low, high, n, noiseAmt, sharpness]) => {
  const nLow = low.add(n.sub(0.5).mul(noiseAmt.mul(2)));
  const nHigh = high.add(n.sub(0.5).mul(noiseAmt.mul(2)));
  return smoothstep(nLow.sub(sharpness), nLow.add(sharpness), y)
    .mul(smoothstep(nHigh.add(sharpness), nHigh.sub(sharpness), y));
});

const voroLayer = /*#__PURE__*/ Fn(([v, scaleX, scaleY, offX, offY, jitter, octaves, lac, gain, warpStr, warpScale, contrast]) => {
  const p = vec2(v.x.mul(scaleX).add(offX), v.y.mul(scaleY).add(offY)).toVar();
  const wx = gradientNoise(p.mul(warpScale)).sub(0.5);
  const wy = gradientNoise(p.mul(warpScale).add(vec2(3.7, 8.3))).sub(0.5);
  p.addAssign(vec2(wx, wy).mul(warpStr));
  return pow(voroFbm(p, jitter, octaves, lac, gain), contrast);
});

/** State key → uniform name, for every setting the panel exposes. */
const NUMBERS = {
  styFlowSpeed: "flowSpeed", styPatternLength: "patternLength", styOpacity: "opacity",
  styDepthStrength: "depthStrength", styShimmer: "shimStr", styFoamWidth: "foamWidth",
  styFoamInner: "foamAStr", styFoamOuter: "foamBStr", styFoamThreshold: "foamThresh",
  styStreaks: "streakStr", styStreakThreshold: "streakThresh",
};
const COLORS = {
  styDarkColor: "darkColor", styBodyColor: "bodyColor", styShimmerColor: "shimColor",
  styFoamColor: "foamColor", styStreakColor: "streakColor",
};

export function createRiverStylizedMaterial({ params = {} } = {}) {
  const p = { ...RIVER_STYLIZED_DEFAULTS, ...params };

  // The old shader's full uniform set; the ones not in NUMBERS/COLORS keep
  // their original values.
  const u = {
    time: uniform(0),
    flowSpeed: uniform(p.styFlowSpeed),
    patternLength: uniform(p.styPatternLength),
    opacity: uniform(p.styOpacity),
    darkColor: uniform(new THREE.Color(p.styDarkColor)),
    bodyColor: uniform(new THREE.Color(p.styBodyColor)),
    depthScaleU: uniform(1.5),
    depthScaleV: uniform(0.8),
    depthStrength: uniform(p.styDepthStrength),
    bodyBright: uniform(1.0),
    bodyContrast: uniform(1.0),
    streakScaleV: uniform(12.0),
    streakScaleU: uniform(8.0),
    streakWarpStr: uniform(0.25),
    streakWarpSc: uniform(1.5),
    streakContrast: uniform(4.0),
    streakThresh: uniform(p.styStreakThreshold),
    streakSharp: uniform(0.03),
    streakColor: uniform(new THREE.Color(p.styStreakColor)),
    streakStr: uniform(p.styStreaks),
    foamWidth: uniform(p.styFoamWidth),
    foamScaleV: uniform(10.0),
    foamScaleU: uniform(6.0),
    foamJitter: uniform(0.9),
    foamOctaves: uniform(3.0),
    foamLac: uniform(2.35),
    foamGain: uniform(0.41),
    foamWarpStr: uniform(1.2),
    foamWarpSc: uniform(1.6),
    foamContrast: uniform(2.5),
    foamThresh: uniform(p.styFoamThreshold),
    foamSharp: uniform(0.02),
    foamColor: uniform(new THREE.Color(p.styFoamColor)),
    foamAStr: uniform(p.styFoamInner),
    foamBStr: uniform(p.styFoamOuter),
    shimNScV: uniform(12.0),
    shimNScU: uniform(12.0),
    shimNoiseAmt: uniform(0.3),
    shimSharp: uniform(0.02),
    shimColor: uniform(new THREE.Color(p.styShimmerColor)),
    shimStr: uniform(p.styShimmer),
    shimFlowSpd: uniform(1.5),
  };

  const material = new MeshBasicNodeMaterial();
  material.fog = true;
  material.transparent = false;   // composited against the grabbed backbuffer
  material.depthWrite = false;    // the ribbon overhangs its banks by design
  material.depthTest = true;
  material.side = THREE.DoubleSide;

  material.colorNode = Fn(() => {
    // Waterline: the ribbon overhangs its banks; cut where the ground is in front.
    const sceneDist = perspectiveDepthToViewZ(sceneDepthGrab.sample(screenUV).r, cameraNear, cameraFar).negate();
    Discard(sceneDist.sub(positionView.z.negate()).lessThanEqual(0));

    // Old ribbon space: u along (here per pattern length), v 0..1 bank to bank.
    const halfW = attribute("aFlow", "vec4").w.max(0.25);
    const uCoord = uv().x.div(u.patternLength.max(1));
    const vCoord = uv().y.div(halfW.mul(2)).add(0.5).toVar();
    const fUV = vec2(vCoord, uCoord.sub(u.time.mul(u.flowSpeed))).toVar();

    const depthN = gradientNoise(vec2(fUV.x.mul(u.depthScaleV), fUV.y.mul(u.depthScaleU)));
    const col = mix(u.darkColor, u.bodyColor, depthN.mul(u.depthStrength)).toVar();
    col.assign(col.sub(0.5).mul(u.bodyContrast).add(0.5).mul(u.bodyBright).clamp(0, 1));

    const shimN = gradientNoise(vec2(fUV.x.mul(u.shimNScV), fUV.y.mul(u.shimNScU).add(u.time.mul(u.shimFlowSpd))));
    const shimBand = bandMask(vCoord, float(0.2), float(0.8), shimN, u.shimNoiseAmt, u.shimSharp);
    col.assign(mix(col, u.shimColor, shimBand.mul(u.shimStr).clamp(0, 1)));

    const foamAMask = smoothstep(u.foamWidth, float(0), vCoord).clamp(0, 1);
    const foamAThresh = mix(float(1.2), u.foamThresh, foamAMask);
    const foamAF1 = voroLayer(fUV, u.foamScaleV, u.foamScaleU, float(0), float(0),
      u.foamJitter, u.foamOctaves, u.foamLac, u.foamGain, u.foamWarpStr, u.foamWarpSc, u.foamContrast);
    const foamA = smoothstep(foamAThresh.sub(u.foamSharp), foamAThresh.add(u.foamSharp), foamAF1);
    col.assign(mix(col, u.foamColor, foamA.mul(u.foamAStr).clamp(0, 1)));

    const foamBMask = smoothstep(float(1).sub(u.foamWidth), float(1), vCoord).clamp(0, 1);
    const foamBThresh = mix(float(1.2), u.foamThresh, foamBMask);
    const foamBF1 = voroLayer(fUV, u.foamScaleV, u.foamScaleU, float(5.3), float(2.7),
      u.foamJitter, u.foamOctaves, u.foamLac, u.foamGain, u.foamWarpStr, u.foamWarpSc, u.foamContrast);
    const foamB = smoothstep(foamBThresh.sub(u.foamSharp), foamBThresh.add(u.foamSharp), foamBF1);
    col.assign(mix(col, u.foamColor, foamB.mul(u.foamBStr).clamp(0, 1)));

    const sUV = vec2(fUV.x.mul(u.streakScaleV), fUV.y.mul(u.streakScaleU)).toVar();
    const sWarpT = u.time.mul(u.flowSpeed).mul(0.4);
    const sWx = gradientNoise(vec2(sUV.x.mul(u.streakWarpSc), sUV.y.mul(u.streakWarpSc).add(sWarpT))).sub(0.5);
    const sWy = gradientNoise(vec2(sUV.x.mul(u.streakWarpSc).add(3.7), sUV.y.mul(u.streakWarpSc).add(8.3).add(sWarpT))).sub(0.5);
    sUV.addAssign(vec2(sWx, sWy).mul(u.streakWarpStr));
    const streakRaw = pow(voroFbm(sUV, float(1), float(2), float(2), float(0.4)), u.streakContrast);
    const streak = smoothstep(u.streakThresh.sub(u.streakSharp), u.streakThresh.add(u.streakSharp), streakRaw);
    col.assign(mix(col, u.streakColor, streak.mul(u.streakStr).clamp(0, 1)));

    // The old material blended at `opacity` over the scene; same here.
    return mix(sceneColorGrab.sample(screenUV).rgb, col, u.opacity);
  })();

  function syncParams(sp) {
    if (!sp) return;
    for (const [k, name] of Object.entries(NUMBERS)) if (sp[k] != null) u[name].value = sp[k];
    for (const [k, name] of Object.entries(COLORS)) if (sp[k] != null) u[name].value.set(sp[k]);
  }

  function update(dt, elapsed) { u.time.value = elapsed; }

  // Unlit: sun and sky do not reach it. Kept so it is a drop-in for riverV2Material.
  function setSunDir() {}
  function setSkyColors() {}

  return { material, uniforms: u, syncParams, update, setSunDir, setSkyColors };
}
