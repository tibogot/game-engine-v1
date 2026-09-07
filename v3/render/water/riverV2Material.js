/**
 * v3/render/water/riverV2Material.js — River v2 surface (TSL / WebGPU)
 *
 * A river is not a lake with a current. Three things make it its own shader:
 *
 *  1. FLOW IS PER-VERTEX, NOT GLOBAL. Every ribbon vertex carries the solved
 *     downstream direction and speed for its station (`aFlow`), so a reach that
 *     steepens or narrows genuinely runs faster on screen. A single flowSpeed
 *     uniform can only ever produce a conveyor belt.
 *
 *  2. THE SURFACE IS ADVECTED IN TWO PHASES, NOT SCROLLED. Scrolling UVs at a
 *     per-fragment rate tears the texture apart the moment neighbouring
 *     fragments move at different speeds — which, given (1), they always do.
 *     The standard fix (Vlachos' flow-map trick) is to run two copies of the
 *     advection half a period out of step and cross-fade them, so each one is
 *     reset before its distortion becomes visible. Both the normal layers and
 *     the whitewater noise go through it.
 *
 *  3. WHITEWATER HAS THREE CAUSES, and they are not the same as a lake's shore
 *     foam. Turbulence comes from the solved slope×speed of the reach (rapids
 *     appear where the profile steepens, with no authoring). Shallows come from
 *     the depth buffer (bank edges, gravel bars). Wake comes from looking a
 *     short way UPSTREAM in screen space and asking the depth buffer whether the
 *     water is still there — if it is not, something solid is standing in the
 *     river and this fragment is behind it. That last one is why a rock dropped
 *     in the water grows a foam tail with no per-object work, no bake and no
 *     collision query: it costs two extra depth taps and works for rocks,
 *     bridge piers, the player, and anything else that ever gets drawn.
 *
 * Shared with the lake shader by DESIGN, not by inheritance: the depth-buffer
 * thickness, Beer-Lambert absorption and the SSR march are the same proven
 * technique, and both sample the same two engine-wide framebuffer grabs
 * (sceneColorGrab / sceneDepthGrab) so no extra copies are made.
 */

import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  Fn, If, Break, uniform, float, vec2, vec3, vec4,
  mix, smoothstep, step, dot, cross, exp, pow, max, min, abs, saturate,
  floor, fract, sin, Loop, uv, attribute,
  normalize, reflect, texture, positionWorld, positionView, cameraPosition,
  cameraNear, cameraFar, cameraViewMatrix, cameraProjectionMatrix,
  screenUV, Discard, perspectiveDepthToViewZ,
} from "three/tsl";
import { sceneColorGrab, sceneDepthGrab, waterSsrMasterNode } from "./lakeMaterial.js";

const SSR_STEPS = 20;
const SSR_REFINE = 4;

/** Metres upstream of each wake tap, as a fraction of `wakeDistance`. */
const WAKE_TAPS = [
  [0.35, 0.55],   // [distance fraction, weight]
  [0.75, 0.3],
  [1.0, 0.2],
];

// ─── Noise ───────────────────────────────────────────────────────────────────

const _nHash = /*#__PURE__*/ Fn(([p]) => {
  const pp = fract(p.mul(vec2(127.1, 311.7)));
  const d = dot(pp, pp.add(45.32));
  return fract(pp.x.add(d).mul(pp.y.add(d)));
});

const _vnoise = /*#__PURE__*/ Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const uu = f.mul(f).mul(float(3).sub(f.mul(2)));
  const n00 = _nHash(i);
  const n10 = _nHash(i.add(vec2(1, 0)));
  const n01 = _nHash(i.add(vec2(0, 1)));
  const n11 = _nHash(i.add(vec2(1, 1)));
  return mix(mix(n00, n10, uu.x), mix(n01, n11, uu.x), uu.y);
});

/** 3-octave value FBM. Ridged on the last octave so foam reads as filaments. */
const _fbm3 = /*#__PURE__*/ Fn(([p_immutable]) => {
  const p = p_immutable.toVar();
  const v = float(0).toVar();
  const amp = float(0.55).toVar();
  const total = float(0).toVar();
  Loop(3, () => {
    v.addAssign(amp.mul(_vnoise(p)));
    total.addAssign(amp);
    p.assign(p.mul(2.17).add(vec2(3.1, 1.7)));
    amp.assign(amp.mul(0.5));
  });
  return v.div(max(total, float(1e-4)));
});

/** Reoriented Normal Mapping. Both inputs are unpacked, normalised. */
const blendRNM = /*#__PURE__*/ Fn(([n1, n2]) =>
  vec3(
    n1.z.mul(n2.x).add(n1.x.mul(n2.z)),
    n1.z.mul(n2.y).add(n1.y.mul(n2.z)),
    n1.z.mul(n2.z).sub(n1.x.mul(n2.x).add(n1.y.mul(n2.y))),
  ).normalize(),
);

export const RIVER_MATERIAL_DEFAULTS = {
  absorption: [0.42, 0.14, 0.1],
  absorptionScale: 14,
  inscatterTint: "#0d2a26",
  inscatterStrength: 0.7,
  depthDistance: 2.6,

  normalTiling: 0.09,
  normalStrength: 0.22,
  normalTiling2: 0.026,
  normalStrength2: 0.35,
  advectPeriod: 1.6,
  flowBias: 0,

  refractionStrength: 0.045,
  fresnelScale: 0.55,
  skyZenithColor: "#3a6ea5",
  skyHorizonColor: "#bcd4e6",
  skyReflectIntensity: 1,

  ssrEnabled: false,
  ssrStrength: 1,
  ssrMaxDistance: 50,
  ssrThickness: 1.2,
  ssrEdgeFade: 0.15,

  sunColor: "#fff4e0",
  shininess: 420,
  glintStrength: 3,
  glintFresnel: 0.35,
  glintSpread: 0.4,
  glintShoreFade: 0.06,

  shoreFade: 0.06,
  surfaceOpacity: 1,

  foamEnabled: true,
  foamColor: "#eef6f7",
  turbulence: 0.9,
  turbulenceCutoff: 0.18,
  shallowDepth: 0.35,
  shallows: 0.85,
  wake: 1.1,
  wakeDistance: 2.4,
  foamScale: 0.55,
  foamBreakup: 0.75,
  foamSharpness: 1.3,
  foamCutoff: 0.4,
  foamTransition: 0.16,

  streakStrength: 0.12,
  streakScale: 0.35,
};

/**
 * @param {object}        deps
 * @param {THREE.Texture} deps.normalMap — tiling water normal map (NoColorSpace, RepeatWrapping)
 * @param {object}        [deps.params]  — partial RIVER_MATERIAL_DEFAULTS override
 *
 * Geometry contract (see riverV2System._buildRibbon):
 *   uv     — (x = arc length downstream in METRES, y = across-stream in METRES,
 *             signed, 0 on the centreline). Metres on both axes, so the normal
 *             map keeps a square aspect whatever the river's width.
 *   aFlow  — vec4(tangentX, tangentZ, speed m/s, halfWidth m) per vertex.
 *   aTurb  — float 0..1, the solved turbulence of this station.
 */
export function createRiverMaterial({ normalMap, params = {} }) {
  const p = { ...RIVER_MATERIAL_DEFAULTS, ...params };

  const u = {
    time: uniform(0),

    absorption: uniform(new THREE.Vector3(...p.absorption)),
    absorptionScale: uniform(p.absorptionScale),
    inscatterTint: uniform(new THREE.Color(p.inscatterTint)),
    inscatterStrength: uniform(p.inscatterStrength),
    depthDistance: uniform(p.depthDistance),

    normalTiling: uniform(p.normalTiling),
    normalStrength: uniform(p.normalStrength),
    normalTiling2: uniform(p.normalTiling2),
    normalStrength2: uniform(p.normalStrength2),
    advectPeriod: uniform(p.advectPeriod),
    flowBias: uniform(p.flowBias),

    refractionStrength: uniform(p.refractionStrength),
    fresnelScale: uniform(p.fresnelScale),
    skyZenithColor: uniform(new THREE.Color(p.skyZenithColor)),
    skyHorizonColor: uniform(new THREE.Color(p.skyHorizonColor)),
    skyReflectIntensity: uniform(p.skyReflectIntensity),

    ssrEnabled: uniform(p.ssrEnabled ? 1 : 0),
    ssrStrength: uniform(p.ssrStrength),
    ssrMaxDistance: uniform(p.ssrMaxDistance),
    ssrThickness: uniform(p.ssrThickness),
    ssrEdgeFade: uniform(p.ssrEdgeFade),

    sunDir: uniform(new THREE.Vector3(0.4, 0.55, 0.3).normalize()),
    sunColor: uniform(new THREE.Color(p.sunColor)),
    shininess: uniform(p.shininess),
    glintStrength: uniform(p.glintStrength),
    glintFresnel: uniform(p.glintFresnel),
    glintSpread: uniform(p.glintSpread),
    glintShoreFade: uniform(p.glintShoreFade),

    shoreFade: uniform(p.shoreFade),
    surfaceOpacity: uniform(p.surfaceOpacity),

    foamEnabled: uniform(p.foamEnabled ? 1 : 0),
    foamColor: uniform(new THREE.Color(p.foamColor)),
    turbulence: uniform(p.turbulence),
    turbulenceCutoff: uniform(p.turbulenceCutoff),
    shallowDepth: uniform(p.shallowDepth),
    shallows: uniform(p.shallows),
    wake: uniform(p.wake),
    wakeDistance: uniform(p.wakeDistance),
    foamScale: uniform(p.foamScale),
    foamBreakup: uniform(p.foamBreakup),
    foamSharpness: uniform(p.foamSharpness),
    foamCutoff: uniform(p.foamCutoff),
    foamTransition: uniform(p.foamTransition),

    streakStrength: uniform(p.streakStrength),
    streakScale: uniform(p.streakScale),
  };

  const material = new MeshBasicNodeMaterial();
  material.fog = true;
  material.transparent = false;   // composited against the grabbed backbuffer
  material.depthWrite = false;    // the ribbon overhangs its banks by design
  material.depthTest = true;
  // A ribbon's winding flips with the sign of the centreline's curvature, so it
  // can present either face.
  material.side = THREE.DoubleSide;

  /** Scene distance from camera, in metres, at a screen UV. */
  const sceneDistAt = Fn(([suv = vec2(0)]) =>
    perspectiveDepthToViewZ(sceneDepthGrab.sample(suv).r, cameraNear, cameraFar).negate(),
  );

  /** World point -> (screen uv, distance from camera). */
  const projectWorld = Fn(([wp = vec3(0)]) => {
    const pv = cameraViewMatrix.mul(vec4(wp, 1)).xyz;
    const clip = cameraProjectionMatrix.mul(vec4(pv, 1));
    const suv = clip.xy.div(clip.w.max(1e-5)).mul(0.5).add(0.5);
    return vec3(suv.x, suv.y, pv.z.negate());
  });

  material.colorNode = Fn(() => {
    // ── 0. Per-station flow, straight off the mesh ──────────────────────────
    const flow = attribute("aFlow", "vec4").toVar();
    const flowDir = normalize(vec3(flow.x, 0, flow.y)).toVar();
    const speed = flow.z.add(u.flowBias).max(0.01).toVar();
    const halfW = flow.w.max(0.25).toVar();
    const turbA = attribute("aTurb", "float").toVar();

    const arc = uv().x;          // metres downstream
    const across = uv().y;       // metres from the centreline, signed

    // ── 1. Two-phase advection (see header note 2) ─────────────────────────
    // Each phase runs for `advectPeriod` seconds and is then reset; the pair is
    // half a period out of step and cross-faded by `w`, which is 0 exactly when
    // a phase is mid-life and 1 when it resets. Nothing is ever displaced by
    // more than one period's worth of travel, however fast the reach flows.
    const period = u.advectPeriod.max(0.05);
    const phase = u.time.div(period);

    /** Advected FBM/normal UV pair + cross-fade weight, for one layer. */
    const p1 = fract(phase).toVar();
    const p2 = fract(phase.add(0.5)).toVar();
    const blend = abs(p1.mul(2).sub(1)).toVar();
    const travel1 = speed.mul(p1).mul(period).toVar();
    const travel2 = speed.mul(p2).mul(period).toVar();

    // Ripples — fine, fast, tiled tightly.
    const rippleA = texture(normalMap,
      vec2(arc.sub(travel1), across).mul(u.normalTiling)).rgb.mul(2).sub(1);
    const rippleB = texture(normalMap,
      vec2(arc.sub(travel2), across).mul(u.normalTiling).add(vec2(0.5, 0.5))).rgb.mul(2).sub(1);
    const ripple = mix(rippleA, rippleB, blend).normalize();

    // Swell — coarse, slower, offset by a third of a period so the two layers
    // never reset on the same frame (which would read as a global pulse).
    const phaseB = phase.mul(0.55).add(0.37);
    const q1 = fract(phaseB).toVar();
    const q2 = fract(phaseB.add(0.5)).toVar();
    const blendB = abs(q1.mul(2).sub(1)).toVar();
    const swellA = texture(normalMap,
      vec2(arc.sub(speed.mul(q1).mul(period).mul(1.8)), across)
        .mul(u.normalTiling2).add(vec2(0.13, 0.61))).rgb.mul(2).sub(1);
    const swellB = texture(normalMap,
      vec2(arc.sub(speed.mul(q2).mul(period).mul(1.8)), across)
        .mul(u.normalTiling2).add(vec2(0.63, 0.11))).rgb.mul(2).sub(1);
    const swell = mix(swellA, swellB, blendB).normalize();

    const nR = vec3(ripple.xy.mul(u.normalStrength), ripple.z).normalize();
    const nS = vec3(swell.xy.mul(u.normalStrength2), swell.z).normalize();
    const tsn = blendRNM(nS, nR).toVar();

    // ── 2. Tangent frame from the flow, not from the world ─────────────────
    // T runs downstream, so wave crests sit ACROSS the current the way they do
    // in a real channel. Using world up for N is a deliberate approximation:
    // river gradients are a few percent, and the profile is smooth by solve.
    const up = vec3(0, 1, 0);
    const bino = cross(flowDir, up).normalize();
    const normal = flowDir.mul(tsn.x).add(bino.mul(tsn.y)).add(up.mul(tsn.z)).normalize().toVar();

    // ── 3. Water thickness from the depth buffer ───────────────────────────
    const fragDist = positionView.z.negate().toVar();
    const thickness = sceneDistAt(screenUV).sub(fragDist).toVar();

    // The ribbon deliberately overhangs its banks so the waterline is found per
    // pixel rather than by the mesh edge. This is where that gets cut.
    Discard(thickness.lessThanEqual(0));

    // ── 4. Refraction ──────────────────────────────────────────────────────
    const distortion = tsn.xy.mul(
      mix(u.refractionStrength, u.refractionStrength.mul(1.5),
        thickness.div(u.depthDistance).clamp()),
    );
    const refractedUv = screenUV.add(distortion);
    const refractedDist = sceneDistAt(refractedUv).toVar();
    // Reject an offset that lands on something in FRONT of the water, or a rock
    // standing in the river bleeds its silhouette across the surface.
    const isSafe = step(fragDist, refractedDist).toVar();
    const safeUv = mix(screenUV, refractedUv, isSafe).clamp();

    const screenColor = sceneColorGrab.sample(safeUv).rgb.toVar();
    const refractedThick = refractedDist.sub(fragDist).max(0);
    const waterThickness = mix(thickness, refractedThick, isSafe).toVar();

    // Thickness runs along the VIEW RAY and stretches at grazing angles, so
    // every band keyed to a depth in metres uses the vertical drop instead.
    const rayDir = normalize(positionWorld.sub(cameraPosition));
    const verticalDepth = waterThickness.mul(rayDir.y.abs()).toVar();

    // ── 5. Reflection: sky gradient, optionally overlaid with SSR ──────────
    const viewDir = normalize(cameraPosition.sub(positionWorld)).toVar();
    const reflectVec = reflect(viewDir.negate(), normal);
    const skyColor = mix(u.skyHorizonColor, u.skyZenithColor, saturate(reflectVec.y.abs()))
      .mul(u.skyReflectIntensity);
    const reflectedColor = skyColor.toVar();

    If(waterSsrMasterNode.mul(u.ssrEnabled).greaterThan(0), () => {
      const vsNrm = cameraViewMatrix.mul(vec4(normal, 0)).xyz.normalize().toVar();
      const vsPos = positionView.add(vsNrm.mul(0.05)).toVar();
      const vsDir = reflect(normalize(vsPos), vsNrm).normalize().toVar();

      const stepLen = u.ssrMaxDistance.div(float(SSR_STEPS)).toVar();
      const hitUv = vec2(0).toVar();
      const crossed = float(0).toVar();
      const tNear = float(0).toVar();
      const tFar = float(0).toVar();

      Loop(SSR_STEPS, ({ i }) => {
        const t = stepLen.mul(float(i).add(1)).toVar();
        const q = vsPos.add(vsDir.mul(t));
        If(q.z.greaterThan(cameraNear.negate()), () => { Break(); });

        const clip = cameraProjectionMatrix.mul(vec4(q, 1));
        const suv = clip.xy.div(clip.w).mul(0.5).add(0.5).toVar();
        If(suv.x.lessThan(0).or(suv.x.greaterThan(1))
          .or(suv.y.lessThan(0)).or(suv.y.greaterThan(1)), () => { Break(); });

        // Only bracket the crossing here. Testing thickness on the coarse step
        // is what produces salt-and-pepper noise at grazing angles.
        If(q.z.negate().sub(sceneDistAt(suv)).greaterThan(0), () => {
          crossed.assign(1);
          hitUv.assign(suv);
          tNear.assign(t.sub(stepLen));
          tFar.assign(t);
          Break();
        });
      });

      If(crossed.greaterThan(0), () => {
        const finalDiff = float(0).toVar();
        Loop(SSR_REFINE, () => {
          const tMid = tNear.add(tFar).mul(0.5).toVar();
          const q = vsPos.add(vsDir.mul(tMid));
          const clip = cameraProjectionMatrix.mul(vec4(q, 1));
          const suv = clip.xy.div(clip.w).mul(0.5).add(0.5);
          const diff = q.z.negate().sub(sceneDistAt(suv)).toVar();
          If(diff.greaterThan(0), () => {
            tFar.assign(tMid);
            hitUv.assign(suv);
            finalDiff.assign(diff);
          }).Else(() => {
            tNear.assign(tMid);
          });
        });

        const valid = float(1).sub(smoothstep(u.ssrThickness, u.ssrThickness.mul(2), finalDiff));
        const e = u.ssrEdgeFade.max(1e-4);
        const edge = smoothstep(0, e, hitUv.x).mul(smoothstep(0, e, float(1).sub(hitUv.x)))
          .mul(smoothstep(0, e, hitUv.y)).mul(smoothstep(0, e, float(1).sub(hitUv.y)));
        const backfacing = saturate(vsDir.z.negate().mul(4));
        const w = valid.mul(edge).mul(backfacing).mul(u.ssrStrength).clamp();
        reflectedColor.assign(mix(skyColor, sceneColorGrab.sample(hitUv).rgb, w));
      });
    });

    // ── 6. Fresnel (Schlick, F0 = 0.02) ────────────────────────────────────
    const cosTheta = saturate(dot(normal, viewDir));
    const F0 = float(0.02);
    const g = float(1).sub(cosTheta).toVar();
    const g2 = g.mul(g);
    const fresnel = F0.add(float(1).sub(F0).mul(g2.mul(g2).mul(g))).toVar();
    const fresnelWeight = fresnel.mul(u.fresnelScale).clamp();

    // ── 7. Beer-Lambert ────────────────────────────────────────────────────
    const sigma = u.absorption.mul(u.absorptionScale);
    const depth01 = waterThickness.div(u.depthDistance).clamp();
    const transmittance = exp(sigma.negate().mul(depth01));
    const inscatter = u.inscatterTint.mul(u.inscatterStrength);
    const throughWater = mix(inscatter, screenColor, transmittance).toVar();

    // ── 8. Lengthwise flow streaks ─────────────────────────────────────────
    // Faint banding aligned with the current. Cheap, and it is what reads as
    // "this water is moving" even where the surface is otherwise glassy.
    If(u.streakStrength.greaterThan(0), () => {
      const sUv = vec2(across.mul(u.streakScale), arc.sub(travel1).mul(u.streakScale.mul(0.08)));
      const streak = _vnoise(sUv).sub(0.5).mul(u.streakStrength);
      throughWater.assign(throughWater.mul(float(1).add(streak)));
    });

    // ── 9. Whitewater ──────────────────────────────────────────────────────
    const foam = float(0).toVar();

    If(u.foamEnabled.greaterThan(0), () => {
      // (a) Rapids — the reach itself is steep and fast. Solved, not authored.
      const turbSrc = saturate(
        turbA.sub(u.turbulenceCutoff).div(max(float(1).sub(u.turbulenceCutoff), float(1e-3))),
      ).mul(u.turbulence);

      // (b) Shallows — thin water over the bank edge and over gravel bars.
      const shallowSrc = float(1)
        .sub(smoothstep(0, u.shallowDepth.max(1e-3), verticalDepth))
        .mul(u.shallows);

      // (c) Wake — is the water still there a short way UPSTREAM? Where it is
      // not, something solid stands in the river and this fragment is in its
      // lee. Each tap costs one depth sample; the taps stack into a tail that
      // fades with distance behind the obstruction.
      const wakeSrc = float(0).toVar();
      If(u.wake.greaterThan(0), () => {
        for (const [frac, weight] of WAKE_TAPS) {
          const wp = positionWorld.sub(flowDir.mul(u.wakeDistance.mul(frac)));
          const pr = projectWorld(wp).toVar();
          const onScreen = step(0, pr.x).mul(step(pr.x, 1))
            .mul(step(0, pr.y)).mul(step(pr.y, 1));
          // Thickness at that upstream point. <= 0 means dry or solid.
          const upThick = sceneDistAt(pr.xy).sub(pr.z);
          const blocked = float(1).sub(smoothstep(0, u.shallowDepth.max(1e-3), upThick));
          wakeSrc.addAssign(blocked.mul(onScreen).mul(weight));
        }
        // A wake belongs in water that is itself deep enough to have a surface —
        // without this the taps just re-detect the bank and double the shore foam.
        wakeSrc.mulAssign(
          smoothstep(u.shallowDepth, u.shallowDepth.mul(2.5), verticalDepth).mul(u.wake),
        );
      });

      // One advected noise field breaks up all three, so they read as the same
      // water rather than three effects layered on one surface. Two phases for
      // the same reason the normals need them.
      const nUv1 = vec2(arc.sub(travel1), across).mul(u.foamScale);
      const nUv2 = vec2(arc.sub(travel2), across).mul(u.foamScale).add(vec2(11.3, 7.7));
      const noise = mix(_fbm3(nUv1), _fbm3(nUv2), blend).toVar();

      const raw = saturate(turbSrc.add(shallowSrc).add(wakeSrc));
      const shaped = pow(max(raw, float(1e-4)), u.foamSharpness)
        .mul(mix(float(1), noise.mul(1.6), u.foamBreakup));

      const cutLo = max(u.foamCutoff.sub(u.foamTransition), float(0));
      const cutHi = min(u.foamCutoff.add(u.foamTransition), float(1.5));
      foam.assign(smoothstep(cutLo, cutHi, shaped).clamp());
    });

    // ── 10. Sun glint, off a flattened normal so the streak spreads ────────
    const glintNormal = flowDir.mul(tsn.x.mul(u.glintSpread))
      .add(bino.mul(tsn.y.mul(u.glintSpread))).add(up.mul(tsn.z)).normalize();
    const reflectedSun = reflect(u.sunDir.negate(), glintNormal);
    const align = max(dot(reflectedSun, viewDir), 0);
    const spec = pow(align, u.shininess);
    const glintF = mix(float(1), fresnel, u.glintFresnel);
    const glintShore = smoothstep(0, u.glintShoreFade, waterThickness);
    const sunGlint = u.sunColor.mul(spec.mul(u.glintStrength).mul(glintF)).mul(glintShore);

    // ── 11. Composite ──────────────────────────────────────────────────────
    const opacity = smoothstep(0, u.shoreFade, waterThickness).mul(u.surfaceOpacity).clamp();
    const shadedWater = mix(throughWater, reflectedColor, fresnelWeight);
    const withWater = mix(screenColor, shadedWater, opacity);
    // Foam sits on the water but under the glint — wet foam does not glint.
    const withFoam = mix(withWater, u.foamColor, foam);
    return withFoam.add(sunGlint.mul(float(1).sub(foam)));
  })();

  const _c = (hex, target) => target.set(hex);

  function syncParams(sp) {
    if (!sp) return;
    if (sp.absorption != null) u.absorption.value.set(...sp.absorption);
    if (sp.absorptionScale != null) u.absorptionScale.value = sp.absorptionScale;
    if (sp.inscatterTint != null) _c(sp.inscatterTint, u.inscatterTint.value);
    if (sp.inscatterStrength != null) u.inscatterStrength.value = sp.inscatterStrength;
    if (sp.depthDistance != null) u.depthDistance.value = sp.depthDistance;

    if (sp.normalTiling != null) u.normalTiling.value = sp.normalTiling;
    if (sp.normalStrength != null) u.normalStrength.value = sp.normalStrength;
    if (sp.normalTiling2 != null) u.normalTiling2.value = sp.normalTiling2;
    if (sp.normalStrength2 != null) u.normalStrength2.value = sp.normalStrength2;
    if (sp.advectPeriod != null) u.advectPeriod.value = sp.advectPeriod;
    if (sp.flowBias != null) u.flowBias.value = sp.flowBias;

    if (sp.refractionStrength != null) u.refractionStrength.value = sp.refractionStrength;
    if (sp.fresnelScale != null) u.fresnelScale.value = sp.fresnelScale;
    if (sp.skyReflectIntensity != null) u.skyReflectIntensity.value = sp.skyReflectIntensity;

    if (sp.ssrEnabled != null) u.ssrEnabled.value = sp.ssrEnabled ? 1 : 0;
    if (sp.ssrStrength != null) u.ssrStrength.value = sp.ssrStrength;
    if (sp.ssrMaxDistance != null) u.ssrMaxDistance.value = sp.ssrMaxDistance;
    if (sp.ssrThickness != null) u.ssrThickness.value = sp.ssrThickness;
    if (sp.ssrEdgeFade != null) u.ssrEdgeFade.value = sp.ssrEdgeFade;

    if (sp.sunColor != null) _c(sp.sunColor, u.sunColor.value);
    if (sp.shininess != null) u.shininess.value = sp.shininess;
    if (sp.glintStrength != null) u.glintStrength.value = sp.glintStrength;
    if (sp.glintFresnel != null) u.glintFresnel.value = sp.glintFresnel;
    if (sp.glintSpread != null) u.glintSpread.value = sp.glintSpread;
    if (sp.glintShoreFade != null) u.glintShoreFade.value = sp.glintShoreFade;

    if (sp.shoreFade != null) u.shoreFade.value = sp.shoreFade;
    if (sp.surfaceOpacity != null) u.surfaceOpacity.value = sp.surfaceOpacity;

    if (sp.foamEnabled != null) u.foamEnabled.value = sp.foamEnabled ? 1 : 0;
    if (sp.foamColor != null) _c(sp.foamColor, u.foamColor.value);
    if (sp.turbulence != null) u.turbulence.value = sp.turbulence;
    if (sp.turbulenceCutoff != null) u.turbulenceCutoff.value = sp.turbulenceCutoff;
    if (sp.shallowDepth != null) u.shallowDepth.value = sp.shallowDepth;
    if (sp.shallows != null) u.shallows.value = sp.shallows;
    if (sp.wake != null) u.wake.value = sp.wake;
    if (sp.wakeDistance != null) u.wakeDistance.value = sp.wakeDistance;
    if (sp.foamScale != null) u.foamScale.value = sp.foamScale;
    if (sp.foamBreakup != null) u.foamBreakup.value = sp.foamBreakup;
    if (sp.foamSharpness != null) u.foamSharpness.value = sp.foamSharpness;
    if (sp.foamCutoff != null) u.foamCutoff.value = sp.foamCutoff;
    if (sp.foamTransition != null) u.foamTransition.value = sp.foamTransition;

    if (sp.streakStrength != null) u.streakStrength.value = sp.streakStrength;
    if (sp.streakScale != null) u.streakScale.value = sp.streakScale;
  }

  function update(dt, elapsed) { u.time.value = elapsed; }

  /** @param {THREE.Vector3} v unit vector pointing TOWARD the sun */
  function setSunDir(v) { if (v) u.sunDir.value.copy(v).normalize(); }

  function setSkyColors(zenith, horizon) {
    if (zenith) u.skyZenithColor.value.copy(zenith);
    if (horizon) u.skyHorizonColor.value.copy(horizon);
  }

  return { material, uniforms: u, syncParams, update, setSunDir, setSkyColors };
}
