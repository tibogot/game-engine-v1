/**
 * V2 PORT of the daynight-sky lab's `cloud-layer.js`. Source of truth is the
 * repo-root `cloud-layer.js`; this is a faithful copy adapted to v2's editor
 * (skyMode === "procedural"). The cloud LOOK is unchanged — same baked 3D
 * Perlin-FBM volume, raymarch, dual-lobe phase, half-res buffer + 5-tap blur.
 * Only the OUTER seam changed: the lab `render()` owned the whole frame; here
 * `tryRenderFrame()` is the v2 dispatch entry (it still renders the scene +
 * clouds + composite to the canvas, since v2 post-FX defaults OFF). God-rays,
 * present-bloom and the terrain/ocean cloud-shadow composite are DEFERRED.
 * Do NOT edit the lab files from v2.
 *
 * Volumetric cloud LAYER — Nubis/Horizon-grade density, framed as a sky-wide slab.
 *
 * Density field (the Nubis / GPU Pro 7 recipe, replacing the old Perlin-only
 * volume): a 128³ PERLIN-WORLEY base volume (Perlin FBM dilated by inverted
 * Worley → connected cauliflower masses instead of smooth blobs, then
 * remap-eroded by higher-frequency Worley octaves) + a separate 64³ WORLEY-FBM
 * detail volume that erodes cloud edges with a height-dependent inversion
 * (wispy at the base, billowy at the top). Both are tileable: periodic Perlin
 * lattice + wrapped Worley cell grids. The SHAPE stays a curved shell: noise
 * tiled horizontally, cut by a vertical height gradient, so it reads as a
 * whole-sky cloud deck.
 *
 * Why it's still cheap for a grounded game: the camera never approaches the
 * clouds, so each ray only marches the thin slab [base, base+thickness] between
 * its analytic entry/exit (near-horizon rays are distance-capped).
 *
 * Lighting matches superjet: dual-lobe Henyey-Greenstein phase, colored
 * extinction, a short light-march for self-shadowing, powder term, and ambient
 * fill. The page hands it the sun by day and the moon by night.
 */
import * as THREE from "three/webgpu";
import {
  float, vec2, vec3, vec4, Fn, If, Loop, Break, uniform, uv, texture,
  positionWorld, cameraPosition, screenUV, texture3D,
  cameraViewMatrix, cameraProjectionMatrix,
  normalize, dot, max, min, mix, smoothstep, pow, exp, sin, fract, abs,
  length, sqrt,
} from "three/tsl";
import { createGodRaysPass } from "./godRaysPass.js";
import { bloom } from "three/addons/tsl/display/BloomNode.js";

const CLOUD_LAYER = 18;
const MAX_OCC_STEPS = 16;
// V2 NOTE: lab uses 8000, but v2's main camera has `far = 5000`, so an 8000
// dome is clip-space culled and the raymarch never rasterizes (no clouds). The
// dome is just a fragment trigger that follows the camera; the actual cloud
// distance is the analytic ray-shell intersection (uBase..uBase+uThickness), so
// the radius is cosmetic — 4000 keeps the dome inside the far plane.
const CLOUD_RADIUS = 4000;
const MAX_STEPS = 128;
const MAX_LIGHT_STEPS = 8;
const INV_4PI = 1.0 / (4.0 * Math.PI);
const EXTINCTION = new THREE.Vector3(0.6, 0.65, 0.7);

function seededRandom(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Periodic (tileable) improved Perlin noise. The lattice coordinates wrap at
 * `period`, so an FBM whose octave frequency equals its period tiles seamlessly
 * — no 8-corner blend needed (which both cost 8× and muddied the contrast).
 * Returns values in roughly [-1, 1].
 */
function makePeriodicPerlin(rng) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  function grad(hash, x, y, z) {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }

  return function noise(x, y, z, period) {
    const Xf = Math.floor(x), Yf = Math.floor(y), Zf = Math.floor(z);
    const xf = x - Xf, yf = y - Yf, zf = z - Zf;
    const X0 = ((Xf % period) + period) % period;
    const Y0 = ((Yf % period) + period) % period;
    const Z0 = ((Zf % period) + period) % period;
    const X1 = (X0 + 1) % period, Y1 = (Y0 + 1) % period, Z1 = (Z0 + 1) % period;
    const u = fade(xf), v = fade(yf), w = fade(zf);
    const h = (xi, yi, zi) => perm[perm[perm[xi] + yi] + zi];
    return lerp(
      lerp(
        lerp(grad(h(X0, Y0, Z0), xf, yf, zf), grad(h(X1, Y0, Z0), xf - 1, yf, zf), u),
        lerp(grad(h(X0, Y1, Z0), xf, yf - 1, zf), grad(h(X1, Y1, Z0), xf - 1, yf - 1, zf), u),
        v,
      ),
      lerp(
        lerp(grad(h(X0, Y0, Z1), xf, yf, zf - 1), grad(h(X1, Y0, Z1), xf - 1, yf, zf - 1), u),
        lerp(grad(h(X0, Y1, Z1), xf, yf - 1, zf - 1), grad(h(X1, Y1, Z1), xf - 1, yf - 1, zf - 1), u),
        v,
      ),
      w,
    );
  };
}

/** Tileable Perlin FBM over the unit cube; octave frequency = wrap period. */
function perlinFbm(noise, x, y, z, baseFreq, octaves) {
  let sum = 0, amp = 1, norm = 0, freq = baseFreq;
  for (let o = 0; o < octaves; o++) {
    sum += noise(x * freq, y * freq, z * freq, freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm * 0.5 + 0.5; // → 0..1
}

/**
 * Tileable inverted Worley (cellular) noise: one feature point per cell on a
 * `freq`³ grid that wraps, evaluated over the 27 neighbouring cells. Inverted
 * (1 - distance) so cloud "cells" read as puffs, not veins.
 */
function makeWorley(freq, rng) {
  const pts = new Float32Array(freq * freq * freq * 3);
  for (let i = 0; i < freq * freq * freq; i++) {
    pts[i * 3] = rng(); pts[i * 3 + 1] = rng(); pts[i * 3 + 2] = rng();
  }
  return function worley(x, y, z) {
    const fx = x * freq, fy = y * freq, fz = z * freq;
    const cx = Math.floor(fx), cy = Math.floor(fy), cz = Math.floor(fz);
    let minD2 = 1e10;
    for (let dz = -1; dz <= 1; dz++) {
      const wz = (((cz + dz) % freq) + freq) % freq;
      for (let dy = -1; dy <= 1; dy++) {
        const wy = (((cy + dy) % freq) + freq) % freq;
        for (let dx = -1; dx <= 1; dx++) {
          const wx = (((cx + dx) % freq) + freq) % freq;
          const idx = ((wz * freq + wy) * freq + wx) * 3;
          const px = cx + dx + pts[idx] - fx;
          const py = cy + dy + pts[idx + 1] - fy;
          const pz = cz + dz + pts[idx + 2] - fz;
          const d2 = px * px + py * py + pz * pz;
          if (d2 < minD2) minD2 = d2;
        }
      }
    }
    return 1 - Math.min(1, Math.sqrt(minD2));
  };
}

/**
 * Bakes the two Nubis cloud volumes (GPU Pro 7 "The Real-Time Volumetric
 * Cloudscapes of Horizon: Zero Dawn" layout):
 *
 *   BASE 128³ RGBA — R: Perlin-Worley (Perlin FBM dilated by low-freq Worley),
 *                    G/B/A: Worley FBM at rising frequencies. The shader
 *                    combines them: base = remap(R, worleyFbm(G,B,A)-1, 1, 0, 1),
 *                    which carves cauliflower structure out of the Perlin mass.
 *   DETAIL 64³ RGBA — Worley FBM at three frequencies for edge erosion
 *                    (combined + height-inverted in the shader).
 */
function bakeCloudNoiseTextures(seed) {
  const rng = seededRandom(seed >>> 0);
  const perlin = makePeriodicPerlin(rng);
  const w4 = makeWorley(4, rng);
  const w8 = makeWorley(8, rng);
  const w16 = makeWorley(16, rng);
  const w32 = makeWorley(32, rng);

  const BS = 128;
  const base = new Uint8Array(BS * BS * BS * 4);
  let i = 0;
  for (let z = 0; z < BS; z++) {
    const nz = z / BS; // divide by SIZE (not size-1) so texel 0 ≠ texel N-1 → seamless wrap
    for (let y = 0; y < BS; y++) {
      const ny = y / BS;
      for (let x = 0; x < BS; x++) {
        const nx = x / BS;
        const pf = perlinFbm(perlin, nx, ny, nz, 4, 5);
        const a4 = w4(nx, ny, nz);
        const a8 = w8(nx, ny, nz);
        const a16 = w16(nx, ny, nz);
        const a32 = w32(nx, ny, nz);
        const wf4 = a4 * 0.625 + a8 * 0.25 + a16 * 0.125;
        const wf8 = a8 * 0.625 + a16 * 0.25 + a32 * 0.125;
        const wf16 = a16 * 0.75 + a32 * 0.25;
        // Perlin-Worley: remap(perlin, 0, 1, worley, 1) — Worley "inflates" the
        // Perlin field from below, connecting it into rounded masses.
        const pw = wf4 + pf * (1 - wf4);
        base[i++] = pw * 255;
        base[i++] = wf4 * 255;
        base[i++] = wf8 * 255;
        base[i++] = wf16 * 255;
      }
    }
  }
  const baseTexture = new THREE.Data3DTexture(base, BS, BS, BS);
  baseTexture.format = THREE.RGBAFormat;
  baseTexture.minFilter = THREE.LinearFilter;
  baseTexture.magFilter = THREE.LinearFilter;
  baseTexture.wrapS = baseTexture.wrapT = baseTexture.wrapR = THREE.RepeatWrapping;
  baseTexture.needsUpdate = true;

  const d8 = makeWorley(8, rng);
  const d16 = makeWorley(16, rng);
  const d32 = makeWorley(32, rng);
  const DS = 64;
  const detail = new Uint8Array(DS * DS * DS * 4);
  i = 0;
  for (let z = 0; z < DS; z++) {
    const nz = z / DS;
    for (let y = 0; y < DS; y++) {
      const ny = y / DS;
      for (let x = 0; x < DS; x++) {
        const nx = x / DS;
        detail[i++] = d8(nx, ny, nz) * 255;
        detail[i++] = d16(nx, ny, nz) * 255;
        detail[i++] = d32(nx, ny, nz) * 255;
        detail[i++] = 255;
      }
    }
  }
  const detailTexture = new THREE.Data3DTexture(detail, DS, DS, DS);
  detailTexture.format = THREE.RGBAFormat;
  detailTexture.minFilter = THREE.LinearFilter;
  detailTexture.magFilter = THREE.LinearFilter;
  detailTexture.wrapS = detailTexture.wrapT = detailTexture.wrapR = THREE.RepeatWrapping;
  detailTexture.needsUpdate = true;

  return { baseTexture, detailTexture };
}

export function createDayNightCloudLayer({ scene, camera, renderer }) {
  const { baseTexture, detailTexture } = bakeCloudNoiseTextures(137);
  const baseTex = texture3D(baseTexture, null, 0);
  const detailTex = texture3D(detailTexture, null, 0);

  // ── Uniforms ─────────────────────────────────────────────────────────────
  const uBase = uniform(1800);
  const uThickness = uniform(1100);
  const uScale = uniform(0.0009);
  const uDetailMul = uniform(4.0);
  const uCovLow = uniform(0.35);
  const uCovHigh = uniform(0.62);
  const uErode = uniform(0.35);
  const uDensityMul = uniform(6.0);
  const uTopSoft = uniform(0.55);
  const uBaseSoft = uniform(0.2);
  const uSteps = uniform(64);
  const uLightSteps = uniform(6);
  const uOccMaxSteps = uniform(14);
  const uMaxDist = uniform(24000);
  // Empty-space skipping: advance faster through air, fine steps only inside
  // clouds. Same in-cloud sampling, far fewer wasted samples in clear sky.
  const uEmptyStepMul = uniform(2.0);    // 1 = uniform march (off)
  const uEmptyThreshold = uniform(0.01); // density below this counts as empty
  const uPlanetRadius = uniform(60000); // smaller = more horizon curvature

  const uOpacity = uniform(1.0);     // extinction strength along the view ray
  const uLightAbsorb = uniform(1.1); // extinction toward the light
  const uPhaseG = uniform(0.3);
  const uPhaseW = uniform(0.8);      // dual-lobe forward weight
  const uPowder = uniform(0.5);
  // Multiple-scattering approximation (Frostbite-style octaves). 0 = single
  // scatter (the current look) → silver-lined, glowing interior as it rises.
  const uMsAmount = uniform(0.7);        // strength of the extra octaves (0 = off)
  const uMsExtinction = uniform(0.5);    // less light extinction per octave (deeper)
  const uMsContribution = uniform(0.5);  // brightness falloff per octave
  const uMsEccentricity = uniform(0.5);  // phase broadening per octave

  const uWind = uniform(new THREE.Vector3());
  const uLightDir = uniform(new THREE.Vector3(0, 1, 0));
  const uLightColor = uniform(new THREE.Color(0xfff3d8));
  const uLightIntensity = uniform(3.0);
  const uAmbientColor = uniform(new THREE.Color(0x8fb6e0));
  const uAmbientIntensity = uniform(0.5);

  // ── Cloud shadows on the ground/ocean (composite-pass) ────────────────────
  // Applied in the final composite: reconstruct each scene pixel's world pos
  // from depth, project it up the sun ray to the cloud shell, sample the SAME
  // density field, and darken. Covers terrain AND ocean in one pass (no edit to
  // the shared ocean shader). uInvViewProj/uMainCamPos are the MAIN camera's
  // (the composite quad uses an ortho cam, so the built-in matrix nodes are the
  // wrong ones) — set each frame in render().
  const uShadowStrength = uniform(0);   // 0 = off; max darkening under dense cloud
  const uShadowSunDir = uniform(new THREE.Vector3(0, 1, 0));
  const uShadowSoftness = uniform(3.0); // density that counts as a full shadow
  const uShadowFar = uniform(6000);     // fade shadows out beyond this (skip sky/far)
  const uInvViewProj = uniform(new THREE.Matrix4());
  const uMainCamPos = uniform(new THREE.Vector3());
  const _shadowPV = new THREE.Matrix4();

  // ── Aerial perspective: distant clouds fade toward the horizon haze color, so
  // the deck recedes into the distance instead of holding full contrast to the
  // horizon. Driven by the transmittance-weighted mean march distance.
  const uAerialEnabled = uniform(1);
  const uAerialColor = uniform(new THREE.Color(0x9fb8c4)); // = scene fog away-color
  const uAerialDensity = uniform(0.00012);  // larger = haze sets in nearer
  const uAerialAmount = uniform(1.0);        // max strength of the color shift

  // ── Offscreen buffers ─────────────────────────────────────────────────────
  // Full-res scene (color + depth) so the cloud march can be occluded by world
  // geometry; half-res cloud buffer for the cheap raymarch.
  const sceneRT = new THREE.RenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
  });
  sceneRT.depthTexture = new THREE.DepthTexture(1, 1);
  const depthSampler = texture(sceneRT.depthTexture);
  // +1 for conventional depth (far = 1), -1 for reversed depth (far = 0).
  const uDepthSign = uniform(1);
  // Env-bake mode: render the cloud dome into a reflection cubemap. Skips the
  // screen-depth occlusion (no scene geometry in the bake) and marches cheaper.
  const uEnvMode = uniform(0);
  const uEnvSteps = uniform(40);

  // ── Density (samples the seamless 3D volume) ───────────────────────────────
  // Planet center sits directly under the camera at depth R (ground ≈ y 0).
  const planetCenter = () => vec3(cameraPosition.x, uPlanetRadius.negate(), cameraPosition.z);

  // Nubis base-shape combine: Perlin-Worley (R) remap-eroded from below by the
  // Worley FBM octaves (G/B/A). This is what turns smooth Perlin blobs into
  // connected cauliflower masses. Shared by the full + cheap samplers.
  const baseShape = Fn(([coord]) => {
    const b4 = baseTex.sample(coord);
    const lowFbm = b4.g.mul(0.625).add(b4.b.mul(0.25)).add(b4.a.mul(0.125));
    // remap(R, lowFbm-1, 1, 0, 1)
    return b4.r.sub(lowFbm.sub(1.0)).div(lowFbm.oneMinus().add(1.0).max(0.05)).clamp(0.0, 1.0);
  });

  const sampleDensity = Fn(([p]) => {
    // Height within the curved shell = radial distance from the planet center.
    const radial = length(p.sub(planetCenter()));
    const h = radial.sub(uPlanetRadius.add(uBase)).div(uThickness).clamp(0.0, 1.0);
    // Rounded vertical profile: thin base, full middle, eroded top.
    const grad = smoothstep(0.0, uBaseSoft, h).mul(smoothstep(1.0, uTopSoft, h));

    const coord = p.mul(uScale).add(uWind);
    const shaped = smoothstep(uCovLow, uCovHigh, baseShape(coord)).mul(grad).toVar();

    // Detail erosion (Nubis): a separate Worley-FBM volume SUBTRACTS from the
    // density and renormalizes, so the iso-surface itself moves and the detail
    // carves real shape out of the edges. Height-dependent inversion makes the
    // erosion wispy at the cloud base and billowy toward the top. Gated on
    // shaped > 0 so empty-air samples (most of the march) skip the second fetch.
    const result = float(0.0).toVar();
    If(shaped.greaterThan(0.001), () => {
      const d4 = detailTex.sample(coord.mul(uDetailMul).add(uWind.mul(2.0)));
      const dFbm = d4.r.mul(0.625).add(d4.g.mul(0.25)).add(d4.b.mul(0.125));
      const dMod = mix(dFbm, dFbm.oneMinus(), h.mul(8.0).clamp(0.0, 1.0));
      const erodeAmt = dMod.mul(uErode);
      result.assign(
        shaped.sub(erodeAmt).max(0.0).div(erodeAmt.oneMinus().max(0.05)).mul(uDensityMul),
      );
    });
    return result;
  });

  // Cheap density for the light march: skips the detail-erosion fetch (halves the
  // texture reads in the hottest inner-inner loop — up to lightSteps×march fetch
  // pairs per pixel). The (1 - 0.5·erode) factor removes the MEAN density the full
  // erosion takes out, so optical depth toward the light stays calibrated.
  const sampleDensityCheap = Fn(([p]) => {
    const radial = length(p.sub(planetCenter()));
    const h = radial.sub(uPlanetRadius.add(uBase)).div(uThickness).clamp(0.0, 1.0);
    const grad = smoothstep(0.0, uBaseSoft, h).mul(smoothstep(1.0, uTopSoft, h));
    const shaped = smoothstep(uCovLow, uCovHigh, baseShape(p.mul(uScale).add(uWind)));
    return shaped.mul(grad).mul(uErode.mul(0.5).oneMinus()).mul(uDensityMul);
  });

  const HG = Fn(([g, mu]) => {
    const g2 = g.mul(g);
    return float(1.0).sub(g2)
      .div(pow(float(1.0).add(g2).sub(g.mul(mu).mul(2.0)), 1.5))
      .mul(INV_4PI);
  });
  const phaseAt = Fn(([mu, g]) =>
    HG(g.negate(), mu).mul(uPhaseW.oneMinus())
      .add(HG(g, mu).mul(uPhaseW)),
  );

  const lightMarch = Fn(([p]) => {
    const stepLen = uThickness.div(uLightSteps.max(1)).mul(0.85);
    const tau = float(0.0).toVar();
    Loop(MAX_LIGHT_STEPS, ({ i }) => {
      If(float(i).greaterThanEqual(uLightSteps), () => Break());
      const lp = p.add(uLightDir.mul(stepLen.mul(float(i).add(1.0))));
      tau.addAssign(sampleDensityCheap(lp));
    });
    return tau.mul(stepLen); // optical depth toward the light (octaves re-extinct it)
  });

  const cloudColorNode = Fn(() => {
    const rayDir = normalize(positionWorld.sub(cameraPosition)).toVar();

    // Curved cloud shell: the region between two concentric spheres (radii
    // R+base and R+base+thickness) around a planet of radius R sitting under the
    // camera. General intersection — picks the nearest shell segment in front of
    // the camera, so it's correct whether the camera is BELOW, INSIDE, or ABOVE
    // the deck (fly-through). A ground-sphere (radius R) clips the far end so
    // nothing renders below the horizon, and grazing rays exit (no slab pinch).
    const oc = cameraPosition.sub(planetCenter());
    const b = dot(oc, rayDir);
    const ococ = dot(oc, oc);
    const rIn = uPlanetRadius.add(uBase);
    const rOut = uPlanetRadius.add(uBase).add(uThickness);
    const discIn = b.mul(b).sub(ococ.sub(rIn.mul(rIn)));
    const discOut = b.mul(b).sub(ococ.sub(rOut.mul(rOut)));
    const discG = b.mul(b).sub(ococ.sub(uPlanetRadius.mul(uPlanetRadius)));

    const sqOut = sqrt(discOut.max(0.0));
    const outerT1 = b.negate().sub(sqOut);
    const outerT2 = b.negate().add(sqOut);

    // Default: the whole outer-sphere span (no inner hole carved yet).
    const tNear = outerT1.max(0.0).toVar();
    const tFar = outerT2.toVar();
    // The inner sphere carves a hole; keep the nearest shell segment in front.
    If(discIn.greaterThan(0.0), () => {
      const sqIn = sqrt(discIn);
      const innerT1 = b.negate().sub(sqIn);
      const innerT2 = b.negate().add(sqIn);
      If(innerT1.greaterThan(0.0), () => {
        // Near segment [outerT1, innerT1] — ends where the ray enters the hole.
        tNear.assign(outerT1.max(0.0));
        tFar.assign(innerT1);
      }).Else(() => {
        // We're past/inside the inner sphere → far segment [innerT2, outerT2].
        tNear.assign(innerT2.max(0.0));
        tFar.assign(outerT2);
      });
    });

    // Ground-sphere clip (horizon): clip the far end to the ground hit.
    const tGround = b.negate().sub(sqrt(discG.max(0.0)));
    If(discG.greaterThan(0.0).and(tGround.greaterThan(0.0)), () => {
      tFar.assign(min(tFar, tGround));
    });
    tFar.assign(min(tFar, uMaxDist));

    // Scene-depth occlusion, HOISTED out of the march loop (closed form): clip(t)
    // is linear in t, so the t where the ray's depth crosses the scene depth has a
    // closed form. Clamping tFar here replaces the old per-step project-and-compare
    // (a mat4 mul + branch every sample). hasGeo gate: sky pixels hold the cleared
    // far-plane depth, and v3's far plane (~4096) is CLOSER than the cloud range —
    // without the gate, sky rays would clip the deck at the far plane. So only clip
    // where real geometry wrote depth. (skyDepth = (sign+1)/2.)
    If(uEnvMode.lessThan(0.5), () => {
      const sceneDepth = depthSampler.sample(screenUV).r;
      const skyDepth = uDepthSign.add(1.0).mul(0.5);
      const hasGeo = abs(sceneDepth.sub(skyDepth)).greaterThan(0.0001);
      If(hasGeo, () => {
        const c0 = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(cameraPosition, 1.0)));
        const cd = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(rayDir, 0.0)));
        const tHit = sceneDepth.mul(c0.w).sub(c0.z).div(cd.z.sub(sceneDepth.mul(cd.w)));
        If(tHit.greaterThan(0.0), () => { tFar.assign(min(tFar, tHit)); });
      });
    });
    const valid = discOut.greaterThan(0.0).and(tFar.greaterThan(tNear));

    const mu = dot(rayDir, normalize(uLightDir));
    // Per-octave phases (constant per ray): each octave broadens the lobe.
    const ecc1 = uPhaseG.mul(uMsEccentricity);
    const ph0 = phaseAt(mu, uPhaseG);
    const ph1 = phaseAt(mu, ecc1);
    const ph2 = phaseAt(mu, ecc1.mul(uMsEccentricity));
    const jitter = fract(sin(dot(screenUV, vec2(12.9898, 78.233))).mul(43758.5453));

    const transmittance = vec3(1.0).toVar();
    const scattered = vec3(0.0).toVar();
    // Transmittance-weighted mean distance to the visible cloud mass (for aerial).
    const distAcc = float(0.0).toVar();
    const wAcc = float(0.0).toVar();

    If(valid, () => {
      const isEnv = uEnvMode.greaterThan(0.5);
      const effSteps = isEnv.select(uEnvSteps, uSteps).toVar();
      // baseStep = the fine in-cloud step; empty regions advance by a multiple of
      // it. Integration always uses baseStep, so in-cloud quality is unchanged.
      const baseStep = tFar.sub(tNear).div(effSteps.max(1)).toVar();
      const travel = tNear.add(jitter.mul(baseStep)).toVar();
      Loop(MAX_STEPS, ({ i }) => {
        If(travel.greaterThanEqual(tFar), () => Break());
        If(transmittance.r.lessThan(0.01), () => Break());
        const p = cameraPosition.add(rayDir.mul(travel));
        const density = sampleDensity(p).toVar();
        const isEmpty = density.lessThan(uEmptyThreshold);
        const advance = isEmpty.select(baseStep.mul(uEmptyStepMul), baseStep);
        If(isEmpty.not(), () => {
          const tauL = lightMarch(p); // optical depth toward the sun
          const powder = exp(density.mul(2.0).negate()).oneMinus()
            .mul(uPowder).add(uPowder.oneMinus());
          const h = length(p.sub(planetCenter())).sub(uPlanetRadius.add(uBase))
            .div(uThickness).clamp(0.0, 1.0);
          // Multiple-scattering octaves: each is dimmer, less-extincted, broader.
          // Octave 0 is exactly the old single-scatter term (uMsAmount = 0 → off).
          const t0 = exp(tauL.mul(uLightAbsorb).negate());
          const t1 = exp(tauL.mul(uLightAbsorb).mul(uMsExtinction).negate());
          const t2 = exp(tauL.mul(uLightAbsorb).mul(uMsExtinction).mul(uMsExtinction).negate());
          const w1 = uMsContribution.mul(uMsAmount);
          const w2 = uMsContribution.mul(uMsContribution).mul(uMsAmount);
          const sunMS = t0.mul(ph0).add(t1.mul(ph1).mul(w1)).add(t2.mul(ph2).mul(w2));
          const sun = uLightColor.mul(uLightIntensity).mul(sunMS).mul(powder);
          const amb = uAmbientColor.mul(uAmbientIntensity).mul(mix(float(0.4), float(1.0), h));
          const lum = sun.add(amb).mul(density).mul(baseStep);
          const stepT = exp(density.mul(baseStep).mul(uOpacity).mul(EXTINCTION).negate());
          scattered.addAssign(transmittance.mul(lum));
          // Visible weight of this sample (light it adds before being extincted) →
          // weight its distance for the aerial-perspective mean.
          const vis = transmittance.r.mul(stepT.r.oneMinus());
          distAcc.addAssign(vis.mul(travel));
          wAcc.addAssign(vis);
          transmittance.mulAssign(stepT);
        });
        travel.addAssign(advance);
      });
    });

    const alpha = transmittance.r.oneMinus();
    // Aerial perspective: fade the (premultiplied) cloud color toward the horizon
    // haze color by the mean distance — distant clouds recede, matching the
    // terrain/ocean fog. Alpha is unchanged, so the deck still occludes.
    If(uAerialEnabled.greaterThan(0.5), () => {
      const meanDist = distAcc.div(wAcc.max(float(0.0001)));
      const fog = exp(meanDist.mul(uAerialDensity).negate()).oneMinus()
        .mul(uAerialAmount).clamp(0.0, 1.0);
      scattered.assign(mix(scattered, uAerialColor.mul(alpha), fog));
    });
    return vec4(scattered, alpha);
  });

  // Cheap silhouette for god-rays occlusion (no lighting).
  const cloudOccColorNode = Fn(() => {
    const rayDir = normalize(positionWorld.sub(cameraPosition)).toVar();
    const oc = cameraPosition.sub(planetCenter());
    const b = dot(oc, rayDir);
    const ococ = dot(oc, oc);
    const rIn = uPlanetRadius.add(uBase);
    const rOut = uPlanetRadius.add(uBase).add(uThickness);
    const discIn = b.mul(b).sub(ococ.sub(rIn.mul(rIn)));
    const discOut = b.mul(b).sub(ococ.sub(rOut.mul(rOut)));
    const discG = b.mul(b).sub(ococ.sub(uPlanetRadius.mul(uPlanetRadius)));

    const sqOut = sqrt(discOut.max(0.0));
    const tNear = b.negate().sub(sqOut).max(0.0).toVar();
    const tFar = b.negate().add(sqOut).toVar();
    If(discIn.greaterThan(0.0), () => {
      const sqIn = sqrt(discIn);
      const innerT1 = b.negate().sub(sqIn);
      const innerT2 = b.negate().add(sqIn);
      If(innerT1.greaterThan(0.0), () => {
        tNear.assign(b.negate().sub(sqOut).max(0.0));
        tFar.assign(innerT1);
      }).Else(() => {
        tNear.assign(innerT2.max(0.0));
        tFar.assign(b.negate().add(sqOut));
      });
    });
    const tGround = b.negate().sub(sqrt(discG.max(0.0)));
    If(discG.greaterThan(0.0).and(tGround.greaterThan(0.0)), () => {
      tFar.assign(min(tFar, tGround));
    });
    tFar.assign(min(tFar, uMaxDist));
    const valid = discOut.greaterThan(0.0).and(tFar.greaterThan(tNear));
    const transmittance = float(1.0).toVar();
    const jitter = fract(sin(dot(screenUV, vec2(12.9898, 78.233))).mul(43758.5453));

    If(valid, () => {
      const stepLen = tFar.sub(tNear).div(uOccMaxSteps.max(1));
      Loop(MAX_OCC_STEPS, ({ i }) => {
        If(float(i).greaterThanEqual(uOccMaxSteps), () => Break());
        If(transmittance.lessThan(0.02), () => Break());
        const t = tNear.add(float(i).add(jitter).add(0.5).mul(stepLen));
        const p = cameraPosition.add(rayDir.mul(t));
        const density = sampleDensity(p);
        If(density.greaterThan(0.01), () => {
          transmittance.mulAssign(exp(density.mul(stepLen).mul(uOpacity).negate()));
        });
      });
    });
    return vec4(vec3(0.0), float(1.0).sub(transmittance));
  });

  const cloudOccMaterial = new THREE.MeshBasicNodeMaterial();
  cloudOccMaterial.colorNode = cloudOccColorNode();
  cloudOccMaterial.side = THREE.BackSide;
  cloudOccMaterial.transparent = true;
  cloudOccMaterial.depthWrite = false;
  cloudOccMaterial.depthTest = false;
  cloudOccMaterial.fog = false;

  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = cloudColorNode();
  material.side = THREE.BackSide;
  material.transparent = true;
  material.premultipliedAlpha = true; // scattered is already transmittance-weighted
  material.depthWrite = false;
  material.depthTest = false; // rendered alone into its own buffer
  material.fog = false;
  // Tone-mapped once here (into the linear HalfFloat buffer); the composite blit
  // does NOT tone-map again, and the canvas applies the sRGB encode — so clouds
  // and the main scene get exactly one ACES pass each.

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(CLOUD_RADIUS, 32, 16), material);
  mesh.frustumCulled = false;
  mesh.name = "VolumetricCloudLayer";
  // Isolated on its own layer so the main scene render skips it; we raymarch it
  // separately at quarter resolution and composite the result back over the frame.
  mesh.layers.set(CLOUD_LAYER);

  // ── Half-res cloud buffer + final composite ───────────────────────────────
  const cloudRT = new THREE.RenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  let fullW = 0, fullH = 0, rtW = 0, rtH = 0;

  // God-rays (light shafts) — its own cloud-aware pass (occlusion silhouette uses
  // the cheap cloudOccMaterial, so shafts stream through the cloud GAPS). v2's
  // post-FX has no god-rays, and a generic one couldn't see the volumetric deck.
  const godRays = createGodRaysPass();
  const godraysTexNode = godRays.godraysTex;
  const uGodRaysMix = uniform(0);

  const postScene = new THREE.Scene();
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  postScene.add(postQuad);

  const sceneColorNode = texture(sceneRT.texture);
  const cloudTexNode = texture(cloudRT.texture);
  const uCloudTexel = uniform(new THREE.Vector2());

  // Single opaque pass straight to the canvas: scene color + a 5-tap blur of the
  // (premultiplied) low-res cloud buffer, composited as `scene*(1-a) + cloud`.
  // The blur softens the raymarch grain; linear combos of premultiplied colors
  // stay valid. Cloud shadows are applied to the scene color here (terrain AND
  // ocean in one place, no shared-shader edit). (God-rays still DEFERRED.)
  const compositeColor = Fn(() => {
    const o = uCloudTexel;
    // Render-target sampling is Y-flipped vs. the canvas in WebGPU.
    const fuv = vec2(uv().x, uv().y.oneMinus());
    const c0 = cloudTexNode.sample(fuv);
    const c1 = cloudTexNode.sample(fuv.add(vec2(o.x, o.y)));
    const c2 = cloudTexNode.sample(fuv.add(vec2(o.x.negate(), o.y)));
    const c3 = cloudTexNode.sample(fuv.add(vec2(o.x, o.y.negate())));
    const c4 = cloudTexNode.sample(fuv.add(vec2(o.x.negate(), o.y.negate())));
    const cloud = c0.mul(0.4).add(c1.add(c2).add(c3).add(c4).mul(0.15));
    const sceneCol = sceneColorNode.sample(fuv).rgb.toVar();

    // Cloud shadows: only when enabled (skips the density sample at night/off).
    If(uShadowStrength.greaterThan(0.001), () => {
      // Reconstruct world pos from scene depth (main-camera inverse VP).
      const d = depthSampler.sample(fuv).r;
      const clip = vec4(uv().x.mul(2.0).sub(1.0), uv().y.mul(2.0).sub(1.0), d, 1.0);
      const wpH = uInvViewProj.mul(clip);
      const wp = wpH.xyz.div(wpH.w);
      // Project up the sun ray to the cloud shell mid-altitude, sample density.
      const midY = uBase.add(uThickness.mul(0.5));
      const sunY = max(uShadowSunDir.y, float(0.05));
      const sp = wp.add(uShadowSunDir.mul(midY.sub(wp.y).div(sunY)));
      const cov = smoothstep(float(0.0), uShadowSoftness, sampleDensity(sp));
      const shadow = float(1.0).sub(cov.mul(uShadowStrength));
      // Masks: only surfaces BELOW the deck, NEAR the camera, and with REAL
      // geometry. The geometry mask is the key fix vs the lab: sky pixels keep
      // the cleared far-plane depth (1 normal / 0 reversed), and v2's near far
      // plane (5000 < shadowFar 6000) would otherwise let the reconstructed
      // horizon-sky point be shadowed. `skyDepth = (sign+1)/2`; geoMask is 0 only
      // when the sampled depth equals that cleared value (= no geometry = sky).
      const belowMask = smoothstep(midY, midY.sub(500.0), wp.y);
      const nearMask = smoothstep(uShadowFar, uShadowFar.mul(0.6), length(wp.sub(uMainCamPos)));
      const skyDepth = uDepthSign.add(1.0).mul(0.5);
      const geoMask = smoothstep(float(0.0), float(0.0001), abs(d.sub(skyDepth)));
      sceneCol.mulAssign(mix(float(1.0), shadow, belowMask.mul(nearMask).mul(geoMask)));
    });

    // God-ray shafts add over the scene BEFORE the clouds composite (so clouds
    // still occlude them where the deck is dense). uGodRaysMix gates it per frame.
    const raysCol = godraysTexNode.sample(fuv).rgb;
    const base = sceneCol.add(raysCol.mul(uGodRaysMix));
    return vec4(base.mul(cloud.a.oneMinus()).add(cloud.rgb), 1.0);
  });

  const compositeMat = new THREE.MeshBasicNodeMaterial();
  compositeMat.colorNode = compositeColor();
  compositeMat.toneMapped = false;
  compositeMat.depthTest = false;
  compositeMat.depthWrite = false;
  postQuad.material = compositeMat;

  // ── Post-FX pipeline path: clouds-only blend onto the LINEAR HDR buffer ─────
  // Used by PostFxPipeline.renderWithClouds() when v2 post-FX is ON: the pipeline
  // renders solids into a linear RT, then this blends the (blurred, premultiplied)
  // cloud buffer OVER it so the display chain tonemaps + blooms scene+clouds in
  // one pass. The cloud RT is stored Y-flipped in WebGPU, so it needs the SAME
  // flip as the owns-the-frame quad to come out upright (target being an RT vs
  // the canvas doesn't change that). God-rays ARE applied here (folded into the
  // premultiplied src below); cloud SHADOWS still are not.
  const cloudBlur = Fn(() => {
    const o = uCloudTexel;
    const b = vec2(uv().x, uv().y.oneMinus());
    const c0 = cloudTexNode.sample(b);
    const c1 = cloudTexNode.sample(b.add(vec2(o.x, o.y)));
    const c2 = cloudTexNode.sample(b.add(vec2(o.x.negate(), o.y)));
    const c3 = cloudTexNode.sample(b.add(vec2(o.x, o.y.negate())));
    const c4 = cloudTexNode.sample(b.add(vec2(o.x.negate(), o.y.negate())));
    return c0.mul(0.4).add(c1.add(c2).add(c3).add(c4).mul(0.15));
  });
  // Linear-path composite = blurred clouds + god-ray shafts UNDER them. With
  // premultiplied One/OneMinusSrcAlpha blending, dst' = src.rgb + dst·(1−a);
  // folding rays·(1−a) into src.rgb reproduces the owns-the-frame ordering
  // ((scene+rays)·(1−a) + cloud) exactly — dense deck still occludes shafts.
  // Tone-space note: the occlusion buffer renders through the scene's tone
  // mapping while this RT is linear HDR; the shafts get tone-mapped a second
  // time on display. Visually that only softens them slightly — exposure on
  // the god-rays panel compensates.
  const linearComposite = Fn(() => {
    const c = cloudBlur();
    const fuv = vec2(uv().x, uv().y.oneMinus());
    const rays = godraysTexNode.sample(fuv).rgb;
    return vec4(c.rgb.add(rays.mul(uGodRaysMix).mul(c.a.oneMinus())), c.a);
  });
  const linearCompositeMat = new THREE.MeshBasicNodeMaterial();
  linearCompositeMat.colorNode = linearComposite();
  linearCompositeMat.transparent = true;
  linearCompositeMat.blending = THREE.CustomBlending; // premultiplied over
  linearCompositeMat.blendSrc = THREE.OneFactor;
  linearCompositeMat.blendDst = THREE.OneMinusSrcAlphaFactor;
  linearCompositeMat.depthTest = false;
  linearCompositeMat.depthWrite = false;
  linearCompositeMat.toneMapped = false;

  // The cloud dome material is tone-mapped into cloudRT for the owns-the-frame
  // path (composited in tone-mapped space → canvas), but must be LINEAR for the
  // post-FX path (composited into the linear HDR buffer the display chain then
  // tonemaps). Toggle only on change to avoid per-frame shader recompiles.
  let _cloudTone = true;
  function setCloudToneMapped(on) {
    if (_cloudTone === on) return;
    _cloudTone = on;
    material.toneMapped = on;
    material.needsUpdate = true;
  }

  // ── Cloud bloom (owns-the-frame path only) ─────────────────────────────────
  // Lab "Bloom" hook: bloom the FINAL scene+clouds composite so bright sunlit
  // cloud edges + the sun glow bloom. v2's post-FX bloom can't reach the clouds
  // (it's solids-only, clouds composite after it), so this is complementary —
  // it lives in the owns-the-frame path (post-FX OFF). When OFF we skip the RT +
  // bloom entirely (composite straight to canvas), so there's zero cost.
  const compositeRT = new THREE.RenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  const compositeTexNode = texture(compositeRT.texture);
  const uBloomMix = uniform(0);
  let _bloomOn = false;
  // Bloom reads the composite Y-flipped (RTs are flipped vs the canvas).
  const bloomInput = texture(compositeRT.texture, vec2(uv().x, uv().y.oneMinus()));
  const bloomNode = bloom(bloomInput, 0.4, 0.6, 0.92);
  const presentColor = Fn(() => {
    const fuv = vec2(uv().x, uv().y.oneMinus());
    return vec4(compositeTexNode.sample(fuv).rgb.add(bloomNode.rgb.mul(uBloomMix)), 1);
  });
  const presentMat = new THREE.MeshBasicNodeMaterial();
  presentMat.colorNode = presentColor();
  presentMat.toneMapped = false;
  presentMat.depthTest = false;
  presentMat.depthWrite = false;

  const _bufSize = new THREE.Vector2();
  let _cloudScale = 0.5; // cloud raymarch buffer scale (0.5 half … 1.0 full)
  function ensureSize() {
    renderer.getDrawingBufferSize(_bufSize);
    const fw = Math.max(1, Math.floor(_bufSize.x));
    const fh = Math.max(1, Math.floor(_bufSize.y));
    if (fw !== fullW || fh !== fullH) {
      fullW = fw; fullH = fh;
      sceneRT.setSize(fw, fh);
      compositeRT.setSize(fw, fh);
    }
    const w = Math.max(1, Math.floor(fw * _cloudScale));
    const h = Math.max(1, Math.floor(fh * _cloudScale));
    if (w !== rtW || h !== rtH) {
      rtW = w; rtH = h;
      cloudRT.setSize(w, h);
      uCloudTexel.value.set(1 / w, 1 / h);
    }
  }

  /**
   * @param {object} P     — PARAMS slice (clouds.*)
   * @param {object} frame — { dt, lightDir, lightColor, lightIntensity,
   *                           ambientColor, ambientIntensity, camera }
   */
  function update(P, frame) {
    mesh.visible = P.enabled;
    if (!P.enabled) return;
    mesh.position.copy(frame.camera.position);

    uBase.value = P.base;
    uThickness.value = P.thickness;
    uScale.value = P.scale;
    uDetailMul.value = P.detailMul;
    uErode.value = P.erode;
    uDensityMul.value = P.densityMul;
    uSteps.value = P.steps;
    uLightSteps.value = P.lightSteps;
    uEmptyStepMul.value = P.emptySkip ?? 2.0;
    uMaxDist.value = P.maxDist;
    uPlanetRadius.value = P.planetRadius;
    uOpacity.value = P.opacity;
    uLightAbsorb.value = P.lightAbsorb;
    uPhaseG.value = P.phaseG;
    uPowder.value = P.powder;
    uMsAmount.value = P.msAmount ?? 0.7;
    uMsExtinction.value = P.msExtinction ?? 0.5;
    uMsContribution.value = P.msContribution ?? 0.5;
    uMsEccentricity.value = P.msEccentricity ?? 0.5;
    _cloudScale = P.bufferScale ?? 0.5; // ensureSize() resizes the buffer if changed

    // coverage slider → smoothstep thresholds (more coverage = lower threshold).
    const thresh = 1.0 - P.coverage;
    uCovLow.value = thresh - P.softness;
    uCovHigh.value = thresh + P.softness;

    const a = THREE.MathUtils.degToRad(P.windDeg);
    uWind.value.x += Math.cos(a) * P.windSpeed * frame.dt;
    uWind.value.z += Math.sin(a) * P.windSpeed * frame.dt;

    uLightDir.value.copy(frame.lightDir);
    uLightColor.value.copy(frame.lightColor);
    uLightIntensity.value = frame.lightIntensity;
    uAmbientColor.value.copy(frame.ambientColor);
    uAmbientIntensity.value = frame.ambientIntensity;

    // Aerial perspective: fade distant clouds toward the scene's horizon-haze
    // color (matches terrain/ocean fog for a cohesive recede).
    uAerialEnabled.value = (P.aerialEnabled ?? true) ? 1 : 0;
    uAerialDensity.value = P.aerialDensity ?? 0.00012;
    uAerialAmount.value = P.aerialAmount ?? 1.0;
    if (frame.fog) uAerialColor.value.copy(frame.fog.color);
  }

  /**
   * v2 dispatch entry (post-FX defaults OFF, so this owns the frame like the lab
   * `render()`). Renders the scene (+depth) to sceneRT, raymarches the clouds at
   * half-res with depth occlusion, then composites scene + clouds to the canvas.
   * Call `update(P, frame)` first. Returns false when clouds are disabled so the
   * caller falls back to its normal render.
   *
   * Signature matches the other v2 cloud systems' `tryRenderFrame(anchor, dt)`,
   * but accepts an optional renderOpts (god-rays config + occluders) instead —
   * the dispatch in main.js builds it. This module follows the camera + dt itself.
   *
   * @param {{godRays?:object, frame?:object, occluders?:THREE.Object3D[],
   *          skyMesh?:THREE.Object3D}} [renderOpts]
   */
  function tryRenderFrame(renderOpts = {}) {
    if (!mesh.visible) return false;
    ensureSize();
    setCloudToneMapped(true); // owns-the-frame composites in tone-mapped space
    uDepthSign.value = camera.reversedDepth ? -1 : 1;

    const prevMask = camera.layers.mask;
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevClearA = renderer.getClearAlpha();
    const prevTarget = renderer.getRenderTarget();

    // 1) Scene (+ depth) → sceneRT, with the cloud layer excluded.
    camera.layers.disable(CLOUD_LAYER);
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);

    // 2) Clouds → half-res cloudRT (cleared transparent; depth-occluded inside).
    camera.layers.set(CLOUD_LAYER);
    renderer.setRenderTarget(cloudRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    camera.layers.mask = prevMask;
    renderer.setClearColor(prevClear, prevClearA);

    // 3) God rays (cloud-aware silhouette + radial blur). Composites additively
    // in the final pass below; uGodRaysMix=0 when off / sun off-screen.
    const godP = renderOpts.godRays;
    const grFrame = renderOpts.frame;
    let raysOk = false;
    if (godP?.enabled && grFrame) {
      uOccMaxSteps.value = godP.occCloudSteps ?? 12;
      raysOk = godRays.render(renderer, {
        scene,
        camera,
        cloudMesh: mesh,
        cloudOccMaterial,
        cloudLayer: CLOUD_LAYER,
        skyMesh: renderOpts.skyMesh,
        occluders: renderOpts.occluders ?? [],
        P: godP,
        frame: grFrame,
        fullWidth: fullW,
        fullHeight: fullH,
      });
    }
    uGodRaysMix.value = raysOk ? 1 : 0;

    // Main-camera inverse view-projection for the composite's cloud-shadow
    // world-pos reconstruction (matrixWorldInverse is current after step 1).
    _shadowPV.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    uInvViewProj.value.copy(_shadowPV).invert();
    uMainCamPos.value.copy(camera.position);

    // 4) Composite scene (+ shadows + rays) + clouds. When the cloud bloom is on,
    // composite to compositeRT then present compositeRT + bloom → canvas; when
    // off, composite straight to the canvas (no bloom cost).
    if (_bloomOn) {
      postQuad.material = compositeMat;
      renderer.setRenderTarget(compositeRT);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.render(postScene, postCam);
      renderer.setClearColor(prevClear, prevClearA);

      postQuad.material = presentMat;
      renderer.setRenderTarget(null);
      renderer.render(postScene, postCam);
    } else {
      postQuad.material = compositeMat;
      renderer.setRenderTarget(null);
      renderer.render(postScene, postCam);
    }

    renderer.setRenderTarget(prevTarget);
    return true;
  }

  // God-rays config for the post-FX path, refreshed each frame by the caller
  // (setGodRaysOpts). tryRenderFrame receives the same data as an argument;
  // prepareFrame can't — PostFxPipeline calls it with (anchor, dt) only.
  let _godRaysOpts = null;
  function setGodRaysOpts(opts) {
    _godRaysOpts = opts;
  }

  /**
   * Post-FX path part 1 (called by PostFxPipeline.renderWithClouds BEFORE the
   * solids pass): raymarch the deck into cloudRT (LINEAR) with depth occlusion.
   * Renders no beauty / doesn't touch the canvas. Returns false when disabled.
   */
  function prepareFrame() {
    if (!mesh.visible) return false;
    ensureSize();
    setCloudToneMapped(false); // linear → composited into the HDR buffer
    uDepthSign.value = camera.reversedDepth ? -1 : 1;

    const prevMask = camera.layers.mask;
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevClearA = renderer.getClearAlpha();
    const prevTarget = renderer.getRenderTarget();

    // Depth for cloud occlusion (solids → sceneRT; cloud layer excluded).
    camera.layers.disable(CLOUD_LAYER);
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);

    // Clouds → half-res cloudRT (cleared transparent; depth-occluded inside).
    camera.layers.set(CLOUD_LAYER);
    renderer.setRenderTarget(cloudRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    camera.layers.mask = prevMask;
    renderer.setClearColor(prevClear, prevClearA);

    // God rays for the linear composite (mirrors tryRenderFrame's step 3).
    const godP = _godRaysOpts?.P;
    const grFrame = _godRaysOpts?.frame;
    let raysOk = false;
    if (godP?.enabled && grFrame) {
      uOccMaxSteps.value = godP.occCloudSteps ?? 12;
      raysOk = godRays.render(renderer, {
        scene,
        camera,
        cloudMesh: mesh,
        cloudOccMaterial,
        cloudLayer: CLOUD_LAYER,
        skyMesh: _godRaysOpts.skyMesh,
        occluders: _godRaysOpts.occluders ?? [],
        P: godP,
        frame: grFrame,
        fullWidth: fullW,
        fullHeight: fullH,
      });
    }
    uGodRaysMix.value = raysOk ? 1 : 0;

    renderer.setRenderTarget(prevTarget);
    return true;
  }

  /**
   * Post-FX path part 2: blend the (blurred, premultiplied, LINEAR) cloud buffer
   * OVER the pipeline's linear HDR target. The display chain then tonemaps +
   * blooms scene+clouds together. Call after prepareFrame().
   */
  function compositeOntoLinearHDR(renderer, targetRT) {
    if (!mesh.visible) return;
    postQuad.material = linearCompositeMat;
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(targetRT);
    renderer.render(postScene, postCam);
    renderer.autoClear = prevAuto;
    postQuad.material = compositeMat;
  }

  function dispose() {
    mesh.geometry.dispose();
    material.dispose();
    baseTexture.dispose();
    detailTexture.dispose();
    sceneRT.dispose();
    cloudRT.dispose();
    cloudOccMaterial.dispose();
    postQuad.geometry.dispose();
    compositeMat.dispose();
    linearCompositeMat.dispose();
    compositeRT.dispose();
    presentMat.dispose();
    godRays.dispose();
  }

  return {
    mesh,
    /** God-rays sun disc — caller must add to the scene (hidden except during the
     * god-rays occlusion pass). */
    sunMesh: godRays.sunMesh,
    update,
    tryRenderFrame,
    // Post-FX integration (PostFxPipeline.renderWithClouds) — used when v2 post-FX
    // is ON so bloom/SSAO/DOF apply over the clouds.
    prepareFrame,
    compositeOntoLinearHDR,
    setGodRaysOpts,
    layer: CLOUD_LAYER,
    /** Toggle env-bake mode (skip depth occlusion, cheaper march) for PMREM. */
    setEnvMode: (on) => { uEnvMode.value = on ? 1 : 0; },
    /**
     * Drive the composite-pass cloud shadows (terrain + ocean in one go).
     * @param {{enabled:boolean, strength:number, sunDir:THREE.Vector3, far?:number}} s
     */
    setCloudShadow: (s) => {
      uShadowStrength.value = s.enabled ? s.strength : 0;
      if (s.sunDir) uShadowSunDir.value.copy(s.sunDir);
      if (s.far !== undefined) uShadowFar.value = s.far;
    },
    /**
     * Drive the owns-the-frame cloud bloom (blooms the final scene+clouds frame).
     * @param {{enabled:boolean, strength:number, radius:number, threshold:number}} b
     */
    setBloom: (b) => {
      _bloomOn = !!b.enabled;
      uBloomMix.value = b.enabled ? 1 : 0;
      bloomNode.strength.value = b.strength;
      bloomNode.radius.value = b.radius;
      bloomNode.threshold.value = b.threshold;
    },
    dispose,
  };
}

export const CLOUD_DEFAULTS = {
  enabled: true,
  base: 1900,
  thickness: 1400,
  scale: 0.00015,
  detailMul: 4.0,
  coverage: 0.4,
  softness: 0.12,
  erode: 0.3,
  densityMul: 12.0,
  steps: 128,
  lightSteps: 8,
  emptySkip: 1.0,
  bufferScale: 0.5,
  maxDist: 24000,
  planetRadius: 160000,
  opacity: 0.7,
  lightAbsorb: 1.1,
  phaseG: 0.3,
  powder: 0.5,
  msAmount: 0.7,
  msExtinction: 0.5,
  msContribution: 0.5,
  msEccentricity: 0.5,
  windDeg: 35,
  windSpeed: 0.02,

  // Aerial perspective (distant clouds fade to the horizon-haze color).
  aerialEnabled: true,
  aerialDensity: 0.00012,
  aerialAmount: 1.0,
};
