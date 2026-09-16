/**
 * Waterfall sheet — realistic surface.
 *
 * THIS IS RIVER V2'S SHADER. Not a shader that looks like it: the same code
 * (riverV2Material.js), built with the river's own water settings, so a river
 * and the fall it pours into cannot drift apart. Two shaders tuned toward each
 * other never match — one of them is always being adjusted to chase the other,
 * and every change to the river silently breaks the pairing.
 *
 * What this file does is describe a FALLING sheet to that shader:
 *
 *   INPUTS — arc down the fall and metres across it, the flow direction (down
 *     the face, not along a horizontal channel), the solved speed, half width,
 *     and the water's own thickness, which conserves the discharge: a sheet
 *     falling three times faster is a third as thick.
 *   BASIS — the surface's tangent frame. The river's is (downstream, across,
 *     world up) because a river lies flat; a fall is vertical, and lighting it
 *     with the river's frame would light it lying down.
 *   TURBULENCE — the river's own whitewater input. On a fall it is AERATION:
 *     glassy where the water leaves the lip, white after `aerateTime` seconds
 *     of falling, whiter where it scrapes rock. That single value drives the
 *     river's existing foam machinery, so the whitewater is literally the same
 *     effect a rapid uses.
 *   COVERAGE — what a river has no notion of. A fall is not a continuous
 *     surface: it parts into ropes with gaps between them, frays at the sides,
 *     fades into the pool at the bottom, and fades out upstream where the crest
 *     lies over the river. That is alpha, and it is all this shader adds.
 *
 * The one thing that cannot transfer: a river reads its thickness from the
 * depth buffer (the bed under the surface), and a falling sheet has cliff or
 * sky behind it. It hands over its solved thickness instead.
 *
 * DRAW RULES (AUDIT #100): reads the shared scene depth and colour grabs, so it
 * sits in the opaque queue, blended (not composited — see blendOutput in
 * riverV2Material.js), after the water surfaces, and the mesh stays hidden
 * until there is a waterfall.
 *
 * Geometry contract (waterfallSystem.js):
 *   position, normal — world space (the mesh has an identity transform)
 *   aFlow  vec4(across m signed, flight time s, speed m/s, thickness m)
 *   aFall  vec4(arc m, fraction down the fall 0..1, per-fall seed, layer 0 body / 1 veil)
 *   aSide  vec4(across direction xyz, half width m)
 *   aMisc  vec4(rock contact 0..1, foam multiplier, lip depth m, over-river 0→1)
 */
import * as THREE from "three";
import {
  Fn, If, uniform, float, vec2, vec3, attribute, mix, smoothstep, saturate, pow, abs, cross,
  normalize, positionWorld, positionView, cameraPosition, cameraNear, cameraFar, screenUV,
  perspectiveDepthToViewZ, step,
} from "three/tsl";
import { sceneDepthGrab } from "../water/lakeMaterial.js";
import { createRiverMaterial } from "../water/riverV2Material.js";
import { riverWaterParams } from "../../app/state/riverV2State.js";
import { WRAP_PERIOD, periodicCells, vnoiseY } from "./waterfallNoise.js";

/** Waterfall-only look settings (everything else comes from the river's water). */
const NUMBERS = [
  "opacity", "aerateTime", "foam", "lipFoam", "lipFoamTime", "streakScale", "streakContrast",
  "breakupStart", "breakupEnd", "breakup", "edgeFade", "veil", "bottomFade", "softDepth",
  "detailDistance",
];

/**
 * Water settings a FALL has to differ on, whatever the river says. Everything
 * else — colour, absorption, refraction, reflection, glint, foam shaping — is
 * the river's, untouched.
 */
function fallWaterParams(riverWater, look) {
  const river = riverWaterParams(riverWater);
  return {
    ...river,
    // A vertical sheet mirrors the sky where a flat river does not — see
    // `reflect` in waterfallState.js.
    fresnelScale: river.fresnelScale * (look?.reflect ?? 1),
    // Solid-object wakes are found by looking upstream in SCREEN space. On a
    // vertical sheet that reads the cliff and paints the whole fall white.
    wake: 0,
    // "Shallow water" means a bank on a river. Every part of a fall is thin, so
    // the aeration below decides where it is white instead.
    shallows: 0,
    // The waterline fade belongs to a shoreline; a sheet has edges of its own.
    shoreFade: 0.001,
    // Relief comes from the ropes, not from a swell rolling along the surface.
    waveEnabled: false,
  };
}

export function createWaterfallMaterial(look, { normalMap = null, riverWater = null } = {}) {
  const u = {
    time: uniform(0),
    streakCells: uniform(periodicCells(look.streakRate)),
    ropeCells: uniform(periodicCells(look.streakRate * 0.3)),
    detailCells: uniform(periodicCells(look.streakRate * 3.1)),
  };
  for (const k of NUMBERS) u[k] = uniform(look[k]);

  const flow = attribute("aFlow", "vec4");
  const fall = attribute("aFall", "vec4");
  const side = attribute("aSide", "vec4");
  const misc = attribute("aMisc", "vec4");
  const normalAttr = attribute("normal", "vec3");

  const tFly = flow.y;
  const isVeil = fall.w;
  /** How much this point lies over the river's own surface (the crossfade). */
  const over = misc.w;
  /** The flat crest: laid-down water, which has no flight time. */
  const onCrest = float(1).sub(step(0.0001, tFly)).toVar("wfOnCrest");
  // Emission moment, kept positive (the noise wraps on whole periods).
  const emit = u.time.sub(tFly).add(WRAP_PERIOD * 4).toVar("wfEmit");
  // The veil gets its own slice of the noise: the same pattern one step in
  // front of the body would read as a double image, not as depth.
  const across = flow.x.add(fall.z.mul(53.1)).add(isVeil.mul(29.7)).toVar("wfAcross");
  const toCellY = (cells) => emit.mul(cells).div(WRAP_PERIOD);
  const sx = across.mul(u.streakScale).toVar("wfSx");

  // ── Pattern ──────────────────────────────────────────────────────────────
  // A ridge — 1 − |2n − 1| raised to a power — is a thin bright line wherever
  // the noise crosses its middle: the filament, not the blotch.
  const ridge = (n, sharp) => pow(float(1).sub(abs(n.mul(2).sub(1))), sharp);

  const streak = Fn(() => {
    const sharp = u.streakContrast.mul(2.5).max(1);
    const a = vnoiseY(vec2(sx, toCellY(u.streakCells)), u.streakCells);
    const b = vnoiseY(vec2(sx.mul(2.37).add(5.3), toCellY(u.streakCells.mul(2))), u.streakCells.mul(2));
    return saturate(ridge(a, sharp).mul(0.62).add(ridge(b, sharp.mul(1.6)).mul(0.5)));
  })().toVar("wfStreak");

  // Where the ropes are and where the gaps are: a coarse, slow pattern.
  const rope = vnoiseY(vec2(sx.mul(0.3).add(11.3), toCellY(u.ropeCells)), u.ropeCells).toVar("wfRope");

  const detail = Fn(() => {
    const d = float(0.5).toVar();
    If(positionWorld.sub(cameraPosition).length().lessThan(u.detailDistance), () => {
      d.assign(vnoiseY(vec2(sx.mul(3.1).add(7.7), toCellY(u.detailCells)), u.detailCells));
    });
    return d;
  })().toVar("wfDetail");

  // ── Aeration → the river's turbulence ────────────────────────────────────
  // Glassy at the lip, white as it falls, whiter where it scrapes rock. The
  // crest carries none: it is still river.
  const aerate = smoothstep(0, u.aerateTime.max(0.01), tFly).toVar("wfAerate");
  const turbulence = Fn(() => {
    const threads = streak.mul(aerate.mul(0.95).add(0.2));
    const body = aerate.mul(rope.mul(0.6).add(0.2));
    const scrape = misc.x.mul(0.5);
    const lip = float(1).sub(smoothstep(0, u.lipFoamTime.max(0.01), tFly)).mul(u.lipFoam).mul(detail.add(0.35));
    return saturate(threads.add(body).add(scrape).add(lip).mul(u.foam).mul(misc.y)
      .mul(detail.mul(0.4).add(0.8))).mul(float(1).sub(onCrest));
  })().toVar("wfAeration");

  // ── Coverage: the sheet is not a continuous surface ──────────────────────
  const coverage = Fn(() => {
    // Gaps between the ropes open up late in the fall.
    const b = smoothstep(u.breakupStart, u.breakupEnd.max(u.breakupStart.add(0.01)), tFly).mul(u.breakup);
    const ropeField = rope.mul(0.65).add(streak.mul(0.35));
    const gaps = mix(float(1), smoothstep(b.mul(0.55).sub(0.05), b.mul(0.55).add(0.2), ropeField), step(0.001, b));

    // Ragged sides.
    const dEdge = side.w.sub(abs(flow.x));
    const edge = smoothstep(0, u.edgeFade.mul(streak.mul(0.9).add(0.5)), dEdge);

    // Into the pool at the bottom.
    const bottom = float(1).sub(smoothstep(float(1).sub(u.bottomFade.max(0.001)), 1, fall.y));

    // Soft where it meets the ground — but not where it rides on rock by design.
    const sceneDist = perspectiveDepthToViewZ(sceneDepthGrab.sample(screenUV).r, cameraNear, cameraFar).negate();
    const soft = smoothstep(0, u.softDepth.mul(float(1).sub(misc.x.mul(0.9))).add(0.02),
      sceneDist.sub(positionView.z.negate()));

    // Over the river, the fall fades out as the river fades in. Anything else
    // stacks two sheets of water, and the light is absorbed twice: the lip
    // reads as a dark wedge sitting on a bright river.
    const crestFade = float(1).sub(over);

    // The veil is loose ropes standing off the body: no glass, and not on the crest.
    const veilA = mix(float(1),
      u.veil.mul(turbulence).mul(streak.mul(0.8).add(0.2)).mul(smoothstep(0.03, 0.2, fall.y)).mul(float(1).sub(onCrest)),
      isVeil);

    return u.opacity.mul(gaps).mul(edge).mul(bottom).mul(soft).mul(veilA).mul(crestFade).clamp();
  })().toVar("wfCoverage");

  // ── The river's surface, falling ─────────────────────────────────────────
  const river = createRiverMaterial({
    normalMap,
    params: fallWaterParams(riverWater, look),
    inputs: {
      arc: fall.x,                 // metres down the fall
      across: flow.x,              // metres across it, signed
      flowDir: side.xyz.cross(normalAttr).normalize().negate(),
      speed: flow.z,
      halfW: side.w,
      turb: turbulence,
      depth: flow.w,               // the sheet's own thickness
    },
    basis: {
      // Down the face, across it, and out of it.
      t: cross(side.xyz, normalAttr).normalize().negate(),
      b: side.xyz,
      n: normalAttr,
    },
    thicknessNode: flow.w,
    verticalDepthNode: flow.w,
    coverageNode: coverage,
    extraFoamNode: null,
    blendOutput: true,
    waves: false,
    waterlineDiscard: false,
  });

  const material = river.material;
  material.side = THREE.DoubleSide;

  function syncParams(next, nextRiverWater) {
    for (const k of NUMBERS) if (next[k] != null) u[k].value = next[k];
    u.streakCells.value = periodicCells(next.streakRate);
    u.ropeCells.value = periodicCells(next.streakRate * 0.3);
    u.detailCells.value = periodicCells(next.streakRate * 3.1);
    if (nextRiverWater) river.syncParams(fallWaterParams(nextRiverWater, next));
  }

  return {
    material,
    uniforms: u,
    river,
    syncParams,
    update(elapsed) {
      u.time.value = elapsed % WRAP_PERIOD;
      river.update(0, elapsed);
    },
    setSunDir(v) { river.setSunDir(v); },
    setSkyColors(zenith, horizon) { river.setSkyColors(zenith, horizon); },
    setSunLight() {},
  };
}
