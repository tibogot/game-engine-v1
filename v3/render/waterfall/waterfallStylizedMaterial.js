/**
 * Waterfall sheet — stylized surface (TSL / WebGPU).
 *
 * THE OLD WATERFALL'S LOOK, term for term (v2/tools/waterfall/waterfallSystem.js
 * `waterfallColorNode`), on the new solved sheet: the dark→body noise gradient,
 * the cyan shimmer band, the two warped cell-noise foam layers (the wide "red"
 * one and the bright "green" one) and the vertical cell-noise DRIP streaks —
 * same noise functions, same default numbers, same band masks.
 *
 * Two things had to change, and only two:
 *   - The old sheet was one flat plane, so its UV was the plane's. Here the
 *     across coordinate is the real half width (the sheet fans out as it falls)
 *     and the along coordinate is the fraction down the fall, measured from the
 *     lip — the old shader's `uv.y` ran the other way, so it is flipped here.
 *   - The noise is periodic along the scroll axis (waterfallNoise.js), so the
 *     shader clock can wrap without the whole pattern jumping.
 *
 * Only the BODY layer is drawn: the old waterfall was a single sheet, and
 * drawing the outer veil with the same pattern reads as a double image.
 *
 * Flat and unlit, like the old one. Alpha-blended in the opaque queue
 * (AUDIT #100) for the soft fade into the ground; same geometry contract and
 * returned interface as waterfallMaterial.js.
 */
import * as THREE from "three";
import {
  Fn, Discard, uniform, float, vec2, attribute, mix, smoothstep, clamp, pow, abs,
  positionView, cameraNear, cameraFar, screenUV, perspectiveDepthToViewZ,
} from "three/tsl";
import { sceneDepthGrab } from "../water/lakeMaterial.js";
import { SCROLL_PERIOD, gnoiseY, voroFbmScroll, bandMask } from "./waterfallNoise.js";

/** State key → uniform, for everything the panel (and River v2) can set. */
const NUMBERS = {
  styOpacity: "opacity", styFlowSpeed: "flowSpeed", styDepthStrength: "depthStrength",
  styShimmer: "shimmer", styFoamThreshold: "foamThresh", styFoamInner: "foamWide",
  styFoamOuter: "foamBright", styStreaks: "drip", styStreakThreshold: "dripThresh",
  styFoamLength: "foamLength",
  softDepth: "softDepth", bottomFade: "bottomFade",
};
const COLORS = {
  styDarkColor: "darkColor", styBodyColor: "bodyColor", styShimmerColor: "shimColor",
  styFoamColor: "foamColor", styStreakColor: "dripColor",
};

export function createWaterfallStylizedMaterial(look) {
  const u = { time: uniform(0) };
  for (const [k, name] of Object.entries(NUMBERS)) u[name] = uniform(look[k]);
  for (const [k, name] of Object.entries(COLORS)) u[name] = uniform(new THREE.Color(look[k]));

  const material = new THREE.MeshBasicNodeMaterial();
  material.transparent = false;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.SrcAlphaFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.depthWrite = false;
  material.depthTest = true;
  material.side = THREE.DoubleSide;
  material.fog = true;

  const flow = attribute("aFlow", "vec4");
  const fall = attribute("aFall", "vec4");
  const side = attribute("aSide", "vec4");
  const misc = attribute("aMisc", "vec4");

  // The old shader's uv: x across 0..1, y 0 at the foot of the fall, 1 at the lip.
  const vx = flow.x.div(side.w.max(0.1).mul(2)).add(0.5).toVar("wfsX");
  const vy = float(1).sub(fall.y).toVar("wfsY");
  const t = u.time.mul(u.flowSpeed).toVar("wfsT");

  // WHERE THE FOAM SITS. The old shader put its foam in bands of the MESH
  // (0.45..0.82 of a hand-built plane, which on that plane was the lip and the
  // curve). A solved fall can be 5 m or 60 m, so a fraction cannot mean the same
  // thing twice: the foam is anchored to the lip instead, by time of flight, and
  // the flat crest above the lip carries none — it is still river.
  const tFly = flow.y;
  const notCrest = float(1).sub(misc.w).toVar("wfsNotCrest");
  const atLip = float(1).sub(smoothstep(0, u.foamLength.max(0.02), tFly)).mul(notCrest).toVar("wfsLip");
  const belowLip = float(1).sub(smoothstep(0, u.foamLength.mul(2.6).max(0.05), tFly)).mul(notCrest).toVar("wfsBelow");

  material.colorNode = Fn(() => {
    // Body: a noise gradient between the dark and the body colour (v2 scales 2.0 / 1.65).
    const depthN = gnoiseY(vec2(vx.mul(2), vy.mul(1.65).add(t.mul(0.5))));
    const col = mix(u.darkColor, u.bodyColor, depthN.mul(u.depthStrength)).toVar();

    // Cyan shimmer band down the middle of the fall (v2: band 0.3..0.8).
    const cyanN = gnoiseY(vec2(vx.mul(12), vy.mul(12).add(t.mul(3))));
    const cyanBand = bandMask(vy, float(0.3), float(0.8), cyanN, float(0.3), float(0.02));
    col.assign(mix(col, u.shimColor, clamp(cyanBand.mul(u.shimmer), 0, 1)));

    // The wide foam layer ("red" in v2): a long tail below the lip, scales 7 × 4.
    const wideThresh = mix(float(1.2), u.foamThresh, belowLip);
    const wideF1 = voroFbmScroll(vec2(vx.mul(7), vy.mul(4).add(t)), float(0.55), float(0.83), float(1.6), float(1.2));
    const wide = smoothstep(wideThresh.sub(0.02), wideThresh.add(0.02), wideF1);
    col.assign(mix(col, u.foamColor, clamp(wide.mul(u.foamWide), 0, 1)));

    // The bright foam layer ("green" in v2): right at the lip, where the water
    // tears off the edge and goes white. Offset so the two layers differ.
    const brightThresh = mix(float(1.2), u.foamThresh, atLip);
    const brightF1 = voroFbmScroll(vec2(vx.mul(7).add(5.3), vy.mul(4).add(t)), float(0.55), float(0.83), float(1.6), float(1.2));
    const bright = smoothstep(brightThresh.sub(0.02), brightThresh.add(0.02), brightF1);
    col.assign(mix(col, u.foamColor, clamp(bright.mul(u.foamBright), 0, 1)));

    // Drips: tall thin cell-noise streaks down the whole fall (v2 scales 14 × 1.8).
    const dripN = gnoiseY(vec2(vx.mul(6), vy.mul(2)));
    const dripBand = bandMask(vy, float(0), float(1), dripN, float(0.08), float(0.04));
    const dripF1 = voroFbmScroll(vec2(vx.mul(14), vy.mul(1.8).add(t)), float(1), float(0.25), float(1.5), float(4));
    const drip = smoothstep(u.dripThresh.sub(0.03), u.dripThresh.add(0.03), dripF1);
    col.assign(mix(col, u.dripColor, clamp(drip.mul(dripBand).mul(u.drip).mul(notCrest), 0, 1)));
    return col;
  })();

  material.opacityNode = Fn(() => {
    // One sheet only: the veil layer would draw the same pattern twice.
    Discard(fall.w.greaterThan(0.5));
    const edge = smoothstep(0, 0.4, side.w.sub(abs(flow.x)));
    // The crest lies over the river's own surface; its upstream end fades away
    // so the two waters join instead of ending on a line.
    const crestFade = float(1).sub(smoothstep(0.55, 1, misc.w));
    const bottom = float(1).sub(smoothstep(float(1).sub(u.bottomFade.max(0.001)), 1, fall.y));
    const sceneDist = perspectiveDepthToViewZ(sceneDepthGrab.sample(screenUV).r, cameraNear, cameraFar).negate();
    const soft = smoothstep(0, u.softDepth.add(0.02), sceneDist.sub(positionView.z.negate()));
    const a = u.opacity.mul(edge).mul(bottom).mul(soft).mul(crestFade);
    Discard(a.lessThan(0.004));
    return a;
  })();

  function syncParams(look) {
    for (const [k, name] of Object.entries(NUMBERS)) if (look[k] != null) u[name].value = look[k];
    for (const [k, name] of Object.entries(COLORS)) if (look[k] != null) u[name].value.set(look[k]);
  }

  return {
    material,
    uniforms: u,
    syncParams,
    // The scroll wraps on a whole number of noise cells, so nothing jumps.
    update(elapsed) { u.time.value = elapsed % (SCROLL_PERIOD / Math.max(0.001, u.flowSpeed.value)); },
    setSunDir() {},
    setSunLight() {},
  };
}
