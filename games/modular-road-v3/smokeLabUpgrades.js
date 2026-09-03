import * as THREE from "three";
import {
  attribute, cameraFar, cameraNear, cameraPosition, Discard, dot, exp, float,
  floor, fract, Fn, length, max, min, mix, normalize, perspectiveDepthToViewZ,
  positionView, positionWorld, pow, saturate, screenUV, sin, smoothstep, sqrt,
  texture, uniform, uv, vec2, vec3, vec4, viewportDepthTexture,
} from "three/tsl";
import { ModularRoadDriftSmoke } from "./modularRoadDriftSmoke.js";

/**
 * LAB-ONLY smoke upgrades — smoke-lab.html imports this; the game does not.
 *
 * The shipping class stays byte-identical while these are judged. Everything
 * here is a candidate DIFF against modularRoadDriftSmoke.js: once a change
 * survives the lab A/B, the marked ── UPGRADE ── blocks get ported into the
 * game file and this subclass shrinks until it can be deleted.
 *
 * The two fragment builders are copied from the parent rather than wrapped,
 * because TSL graphs cannot be edited after the fact — a node function is
 * built once and compiled. The copies are kept line-for-line except where an
 * UPGRADE banner says otherwise, so a diff against the parent shows exactly
 * the candidate change and nothing else.
 *
 * WHAT IS BEING TESTED, and why each is worth a shader fork:
 *
 *   1. INTERNAL CHURN (puff shader). Stock puffs SLIDE their noise window
 *      over life, which reads as a picture panning behind a mask. Real smoke
 *      BOILS — features appear, distort and dissolve in place. Cheapest
 *      honest version: crossfade the quad-space density between re-seeded
 *      windows on a per-particle clock (a two-frame procedural flipbook,
 *      re-randomised every cycle). One extra texture tap.
 *
 *   2. HEMISPHERE AMBIENT (both shaders). Stock ambient is a flat scalar, so
 *      the unlit side of a puff is the same colour whether it faces the sky
 *      or the tarmac. Real smoke is blue-grey lit from above and dark
 *      underneath — that vertical gradient is a big part of what grounds a
 *      plume in the scene. sky/ground colours dotted against the REAL sphere
 *      normal the shader already has; two uniforms, zero taps.
 *
 * The third experiment — curl-noise turbulence — is CPU-side and lives in
 * smoke-lab.html itself (no subclass needed: the lab owns the step loop's
 * inputs and can accelerate particles before update()).
 */

/** Same scene-depth grab as the parent (module-private there). While a lab
 *  page runs BOTH classes' materials this means a second framebuffer copy —
 *  irrelevant to judging the look, and gone once the diff is ported. */
const _sceneDepthTex = /*#__PURE__*/ viewportDepthTexture();

export class UpgradedDriftSmoke extends ModularRoadDriftSmoke {
  /**
   * New uniforms are created lazily inside the node builders (`??=`) because
   * those run DURING the parent constructor, before any subclass field
   * initialiser could — super() builds the materials.
   */

  /** Hemisphere ambient: what colour the smoke's top and underside are lit
   *  by. Defaults to white/white, which reproduces the stock flat ambient
   *  exactly — the A/B baseline costs nothing. */
  setAmbientColors(sky, ground) {
    if (this.uSkyCol && sky) this.uSkyCol.value.copy(sky);
    if (this.uGroundCol && ground) this.uGroundCol.value.copy(ground);
  }

  /** Churn dials, forwarded by the lab GUI. amount 0 = byte-identical look
   *  to stock (both taps land on the same texel). */
  setChurn(amount, rate) {
    if (this.uChurn) this.uChurn.value = amount;
    if (this.uChurnRate) this.uChurnRate.value = rate;
  }

  update(dt, points, emit, intensity, velocityX, velocityZ, camera) {
    // The churn clock. Advanced by the (already slow-motion-scaled) dt so
    // the boil slows down with the rest of the world under the lab's T key.
    if (this.uTime) this.uTime.value += dt;
    super.update(dt, points, emit, intensity, velocityX, velocityZ, camera);
  }

  /**
   * Copy of the parent's `_buildShadedNode` with the two UPGRADE blocks.
   * See the parent for the full commentary; comments here are kept only
   * where the code differs.
   */
  _buildShadedNode() {
    const st = uv();
    const tint = attribute("aTint", "vec4");
    const nParams = attribute("aNoise", "vec4");
    const sphere = attribute("aSphere", "vec4");
    const cls = attribute("aClass", "vec2");
    const softDepth = this.uSoftDepth;
    const erodeSoft = this.uErodeSoft;
    const noiseMap = this.noiseMap;
    const {
      uSunWorld, uLightAmount, uAmbient, uSunStrength, uAbsorb, uScatter, uHgG,
      uSunColor, uWorldMix, uWorldScale, uWorldDrift,
    } = this;

    // ── UPGRADE: lazy uniforms (created here because super() calls this) ──
    this.uTime ??= uniform(0);
    this.uChurn ??= uniform(0.6);
    this.uChurnRate ??= uniform(0.7);
    this.uSkyCol ??= uniform(new THREE.Color(1, 1, 1));
    this.uGroundCol ??= uniform(new THREE.Color(1, 1, 1));
    const { uTime, uChurn, uChurnRate, uSkyCol, uGroundCol } = this;

    return Fn(() => {
      const camToFrag = positionWorld.sub(cameraPosition);
      const dist = length(camToFrag).toVar();
      const rd = camToFrag.div(dist).toVar();
      const centre = sphere.xyz;
      const radius = sphere.w;

      const oc = cameraPosition.sub(centre);
      const b = dot(oc, rd);
      const cTerm = dot(oc, oc).sub(radius.mul(radius));
      const h = b.mul(b).sub(cTerm);
      Discard(h.lessThan(0));
      const sq = sqrt(max(h, float(0)));
      const t0 = b.negate().sub(sq).toVar();
      const t1 = b.negate().add(sq).toVar();

      const sceneViewZ = perspectiveDepthToViewZ(
        _sceneDepthTex.sample(screenUV).r, cameraNear, cameraFar,
      ).negate();
      const fragViewZ = positionView.z.negate();
      const sceneT = sceneViewZ.mul(dist).div(max(fragViewZ, float(1e-4)));

      const tEnter = max(t0, float(0)).toVar();
      const tExit = min(t1, sceneT);
      const chord = max(tExit.sub(tEnter), float(0));
      const thick = saturate(chord.div(radius.mul(2)));

      // ── UPGRADE 1: INTERNAL CHURN ─────────────────────────────────────────
      // Was: one tap at st*scale + drift offset (a sliding window). Now: a
      // per-particle clock picks an integer "frame", each frame hashes to its
      // own window into the same tiling texture, and adjacent frames
      // crossfade. Features therefore dissolve INTO different features in
      // place, which is the boil. The hash offsets are scaled by uChurn, so
      // 0 collapses both taps onto the stock coordinate — the A/B baseline
      // renders exactly the stock image.
      //
      // The clock is seeded from the particle's own random noise offset
      // (nParams.xy is per-particle random), so the pool never boils in sync.
      const seed = fract(nParams.x.mul(0.6180339).add(nParams.y.mul(0.7548776)));
      const clock = uTime.mul(uChurnRate).add(seed.mul(64.0));
      const frame = floor(clock);
      const blend = fract(clock);
      // Cheap per-frame hash → a window offset in tiles.
      const hashOf = (f) => vec2(
        fract(sin(f.mul(12.9898)).mul(43758.5453)),
        fract(sin(f.mul(78.2330)).mul(24634.6345)),
      );
      const uvBase = st.mul(nParams.z).add(nParams.xy);
      const offA = hashOf(frame).mul(uChurn);
      const offB = hashOf(frame.add(1)).mul(uChurn);
      const nQuadA = texture(noiseMap, uvBase.add(offA));
      const nQuadB = texture(noiseMap, uvBase.add(offB));
      // Smoothstep on the blend, so a frame change never shows as a linear
      // pop at the cycle boundary.
      const w = blend.mul(blend).mul(float(3).sub(blend.mul(2)));
      const detailQuad = mix(
        mix(nQuadA.r, nQuadA.g, 0.35),
        mix(nQuadB.r, nQuadB.g, 0.35),
        w,
      );
      // ── end UPGRADE 1 ─────────────────────────────────────────────────────

      const mid = cameraPosition.add(rd.mul(b.negate()));
      const wuv = vec2(
        mid.x.add(mid.y.mul(0.37)),
        mid.z.add(mid.y.mul(0.61)),
      ).mul(uWorldScale.mul(cls.y)).add(uWorldDrift);
      const nWorld = texture(noiseMap, wuv);
      const detailWorld = mix(nWorld.r, nWorld.g, 0.35);

      const detail = mix(detailQuad, detailWorld, saturate(uWorldMix.mul(cls.x)));
      const density = thick.mul(float(0.32).add(detail.mul(0.95))).toVar();

      const thresh = nParams.w;
      const alpha = smoothstep(thresh, thresh.add(erodeSoft), density)
        .mul(tint.w)
        .toVar();

      alpha.mulAssign(saturate(sceneT.sub(t0).div(max(softDepth, float(1e-3)))));

      Discard(alpha.lessThan(0.003));

      const nrm = normalize(cameraPosition.add(rd.mul(tEnter)).sub(centre));
      const ndl = dot(nrm, uSunWorld);
      const wrapped = saturate(ndl.mul(0.5).add(0.5));
      const transmit = exp(density.mul(uAbsorb).negate());

      const c = dot(uSunWorld, rd);
      const gg = uHgG.mul(uHgG);
      const denom = pow(
        max(float(1e-4), float(1).add(gg).sub(uHgG.mul(2).mul(c))),
        float(1.5),
      );
      const phase = float(1).sub(gg).div(denom).div(12.566);

      // ── UPGRADE 2: HEMISPHERE AMBIENT ─────────────────────────────────────
      // Was: `.add(uAmbient)` — a flat scalar, same on the sky side and the
      // tarmac side of every puff. Now the scalar scales a sky/ground colour
      // picked by the REAL sphere normal's upness, so the plume is cool-lit
      // on top and dark underneath even with the sun term at zero. White
      // defaults reproduce stock exactly.
      const hemiCol = mix(uGroundCol, uSkyCol, nrm.y.mul(0.5).add(0.5));
      const lit = uSunColor
        .mul(uSunStrength.mul(wrapped).add(uScatter.mul(phase)))
        .mul(transmit)
        .add(hemiCol.mul(uAmbient));
      // ── end UPGRADE 2 ─────────────────────────────────────────────────────
      const rgb = tint.xyz.mul(mix(vec3(1), lit, uLightAmount));

      return vec4(rgb, alpha);
    })();
  }

  /**
   * Copy of the parent's `_buildBankNode` with UPGRADE 2 only — the bank's
   * triplanar world-space noise already parallaxes and fuses, so it does not
   * get the churn (a 14 m mass that re-seeds its texture would shimmer).
   */
  _buildBankNode() {
    const tint = attribute("iTint", "vec4");
    const thresh = attribute("iThresh", "float");
    const sphere = attribute("iSphere", "vec4");
    const noiseMap = this.noiseMap;
    const softDepth = this.uSoftDepth;
    const erodeSoft = this.uErodeSoft;
    const {
      uSunWorld, uLightAmount, uAmbient, uSunStrength, uAbsorb, uScatter, uHgG,
      uSunColor, uWorldScale, uWorldDrift, uBankScale,
    } = this;

    // ── UPGRADE: shared with _buildShadedNode; whichever builds first
    // creates them (construction order is puffs first, but ??= keeps this
    // safe against reordering).
    this.uSkyCol ??= uniform(new THREE.Color(1, 1, 1));
    this.uGroundCol ??= uniform(new THREE.Color(1, 1, 1));
    const { uSkyCol, uGroundCol } = this;

    return Fn(() => {
      const camToFrag = positionWorld.sub(cameraPosition);
      const dist = length(camToFrag).toVar();
      const rd = camToFrag.div(dist).toVar();
      const centre = sphere.xyz;
      const radius = sphere.w;

      const oc = cameraPosition.sub(centre);
      const b = dot(oc, rd);
      const cTerm = dot(oc, oc).sub(radius.mul(radius));
      const h = b.mul(b).sub(cTerm);
      Discard(h.lessThan(0));
      const sq = sqrt(max(h, float(0)));
      const t0 = b.negate().sub(sq);
      const t1 = b.negate().add(sq);

      const sceneViewZ = perspectiveDepthToViewZ(
        _sceneDepthTex.sample(screenUV).r, cameraNear, cameraFar,
      ).negate();
      const fragViewZ = positionView.z.negate();
      const sceneT = sceneViewZ.mul(dist).div(max(fragViewZ, float(1e-4)));

      const tEnter = max(t0, float(0)).toVar();
      const tExit = min(t1, sceneT).toVar();
      const chord = max(tExit.sub(tEnter), float(0));
      const thick = saturate(chord.div(radius.mul(2)));

      const N = normalize(cameraPosition.add(rd.mul(tEnter)).sub(centre)).toVar();

      const mid = cameraPosition.add(rd.mul(tEnter.add(tExit).mul(0.5))).toVar();
      const aN = N.abs();
      const bl = aN.div(aN.x.add(aN.y).add(aN.z).add(0.0001));
      const wp = mid.mul(uWorldScale.mul(uBankScale));
      const off = uWorldDrift;
      const sX = texture(noiseMap, wp.yz.add(off)).r;
      const sY = texture(noiseMap, wp.xz.add(off)).r;
      const sZ = texture(noiseMap, wp.xy.add(off)).r;
      const detail = sX.mul(bl.x).add(sY.mul(bl.y)).add(sZ.mul(bl.z));

      const density = thick.mul(float(0.32).add(detail.mul(0.95))).toVar();

      const alpha = smoothstep(thresh, thresh.add(erodeSoft), density)
        .mul(tint.w)
        .toVar();

      alpha.mulAssign(saturate(sceneT.sub(t0).div(max(softDepth, float(1e-3)))));
      Discard(alpha.lessThan(0.003));

      const ndl = dot(N, uSunWorld);
      const wrapped = saturate(ndl.mul(0.5).add(0.5));
      const transmit = exp(density.mul(uAbsorb).negate());

      const c = dot(uSunWorld, rd);
      const gg = uHgG.mul(uHgG);
      const denom = pow(
        max(float(1e-4), float(1).add(gg).sub(uHgG.mul(2).mul(c))),
        float(1.5),
      );
      const phase = float(1).sub(gg).div(denom).div(12.566);

      // ── UPGRADE 2: hemisphere ambient (same as the puffs) ────────────────
      const hemiCol = mix(uGroundCol, uSkyCol, N.y.mul(0.5).add(0.5));
      const lit = uSunColor
        .mul(uSunStrength.mul(wrapped).add(uScatter.mul(phase)))
        .mul(transmit)
        .add(hemiCol.mul(uAmbient));
      return vec4(tint.xyz.mul(mix(vec3(1), lit, uLightAmount)), alpha);
    })();
  }
}
