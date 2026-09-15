/**
 * v3/render/water/oceanUnderwater.js — inside the V2 ocean
 *
 * Two meshes, both hidden (and so costing nothing — not a draw, not a copy)
 * whenever the camera is clear of the water. worldOceanV2.js decides that on the
 * CPU from one comparison per frame.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. THE WATER — one full-screen triangle, drawn last
 *
 *    WHY A MESH IN THE SCENE AND NOT A POST PASS. The editor renders through
 *    one of three paths (plain `renderer.render`, PostFxPipeline, or its cloud
 *    split), and a post node would have to be threaded through all three plus
 *    every game's own. A triangle in the scene, with `vertexNode` ignoring the
 *    camera, rides every one of them unchanged — it is just the last transparent
 *    object. Same trick the ocean itself uses to read the backbuffer.
 *
 *    ITS OWN VIEWPORT COPIES, not the shared ones. three copies the framebuffer
 *    once per render per TEXTURE, at the first object that reads it — and the
 *    ocean reads the shared pair first, before it has drawn. Sharing them here
 *    would hand this pass a depth buffer with no sea in it, so every pixel of
 *    the surface seen from below would be hazed by the distance to the SKY.
 *
 *    THE WATERLINE is evaluated where the lens actually is: each pixel's point
 *    on the camera's near plane, against the displaced wave height above it
 *    (oceanSurface's own `waterHeightAt`, so it is the same wave the mesh is).
 *    Below it the pixel is under water, above it untouched. The line is that
 *    boundary, anti-aliased with its own screen derivative, darkened (a meniscus
 *    is a thin lens that bends light AWAY from the eye) and dragging the image a
 *    few pixels on the water side.
 *
 *    THE WATER BETWEEN is single scattering in closed form, per channel:
 *
 *        colour = scene · exp(-σ·D) · exp(-σ·depth(P))  +  inscatter
 *
 *    `exp(-σ·D)` is the view path. `exp(-σ·depth(P))` is the SUNLIGHT's path from
 *    the surface down to the thing seen — without it a seabed 30 m down is as
 *    brightly lit as a beach, and deep water never gets dark close-up.
 *
 *    The inscatter integral has an exact solution when the light also falls off
 *    with depth. Along a ray from depth d0 in direction y (up = +1), the light at
 *    distance t is L·exp(-σ(d0 - y·t)), so
 *
 *        ∫₀ᴰ σ·S·L·e^{-σ(d0 - y t)}·e^{-σ t} dt  =  S·L·e^{-σ d0} · (1 - e^{-σ(1-y)D}) / (1 - y)
 *
 *    which is why looking DOWN goes dark, looking UP goes bright, and going
 *    deeper dims everything — from one line, no march, no LUT.
 *
 * 2. MARINE SNOW — one instanced draw
 *
 *    Specks in a box that wraps around the camera. They sit still in the WORLD,
 *    so moving the camera gives parallax — that parallax is how you can tell you
 *    are moving at all in a featureless blue.
 *
 * COST, argued not measured: the water pass is 2 framebuffer copies + ~6 texture
 * taps + closed-form maths per pixel, plus the light-shaft march (10 steps × 2
 * noise taps, under-water pixels only), and only while the camera is within
 * `uwActiveBand` of the sea. The snow is ~1400 quads additive.
 */

import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  Fn, float, vec2, vec3, vec4, attribute, varying, varyingProperty,
  mix, smoothstep, step, exp, pow, max, min, abs, saturate, length, normalize,
  dot, sin, cos, floor, fract, fwidth, Discard, If, Loop, texture,
  positionGeometry, screenUV, screenSize, screenCoordinate,
  cameraPosition, cameraNear, cameraFar, cameraWorldMatrix, cameraViewMatrix,
  cameraProjectionMatrix, cameraProjectionMatrixInverse,
  viewportTexture, viewportDepthTexture, perspectiveDepthToViewZ,
} from "three/tsl";
import { applyBloomMRT } from "../bloomMRT.js";

/** Snow instances allocated once; `uwSnowCount` only changes how many draw. */
const SNOW_MAX = 4000;

/** Light-shaft march steps. TSL unrolls Loop counts, so this is compile-time. */
const SHAFT_STEPS = 10;

/**
 * Tileable smooth value noise, 256² R8 — the light-shaft pattern.
 *
 * A texture rather than hashing in the shader because the march reads it 20
 * times per pixel; a filtered tap is a fraction of the cost of the 8 hashes
 * two value-noise octaves would take, per tap. Two octaves baked in, lattice
 * periods that divide the texture so it wraps seamlessly.
 */
let _shaftNoiseTex = null;
function shaftNoiseTexture() {
  if (_shaftNoiseTex) return _shaftNoiseTex;
  const N = 256;
  const data = new Uint8Array(N * N);
  let seed = 1337;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const octave = (cells) => {
    const lat = new Float32Array(cells * cells);
    for (let i = 0; i < lat.length; i++) lat[i] = rand();
    return (x, y) => {
      const fx = (x / N) * cells, fy = (y / N) * cells;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      const tx = fx - ix, ty = fy - iy;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const at = (i, j) => lat[((j % cells) * cells) + (i % cells)];
      const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
      return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
    };
  };
  const o1 = octave(8), o2 = octave(16);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      data[y * N + x] = Math.round((o1(x, y) * 0.7 + o2(x, y) * 0.3) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  _shaftNoiseTex = tex;
  return tex;
}

/**
 * @param {object} deps
 * @param {object} deps.surface — createOceanSurface() result (uniforms + helpers)
 */
export function createOceanUnderwater({ surface }) {
  const u = surface.uniforms;
  const { waterHeightAt, shoreAt } = surface.helpers;

  const sigma = u.uwExtinction.mul(u.uwDensity);
  const shaftNoise = shaftNoiseTexture();

  /** Henyey-Greenstein, normalised so the sphere average is 1. */
  const hgRatio = (cosT, g) => {
    const g2 = g.mul(g);
    return float(1).sub(g2).div(pow(max(float(1).add(g2).sub(g.mul(cosT).mul(2)), float(1e-4)), float(1.5)));
  };

  /**
   * Radiance scattered into a ray of length `D` leaving depth `d0` along `dir`.
   * See the header for the integral.
   */
  const sunPhase = (dir) =>
    mix(float(1), hgRatio(dot(dir, u.uwSunDirUnder), u.uwSunGlowG), u.uwSunGlow);

  const inscatter = (dir, d0, D) => {
    const oneMinusY = max(float(1).sub(dir.y), float(1e-3));
    const light = u.uwLightAmb.add(u.uwLightSun.mul(sunPhase(dir)));
    const reach = float(1).sub(exp(sigma.mul(oneMinusY).mul(D).negate())).div(oneMinusY);
    return u.uwScatterColor.mul(light).mul(exp(sigma.mul(d0).negate())).mul(reach);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. THE WATER
  // ═══════════════════════════════════════════════════════════════════════════

  const sceneColorTex = viewportTexture();
  const sceneDepthTex = viewportDepthTexture(screenUV, null, new THREE.DepthTexture());

  // A point on each pixel's view ray, in view space. Unprojected per VERTEX and
  // interpolated: every vertex of the triangle has w = 1, so the interpolation is
  // linear and exact, and — unlike projecting world points back — it cannot
  // disagree with `screenUV` about which way is up.
  const viewRay = varying(Fn(() => {
    const p = cameraProjectionMatrixInverse.mul(vec4(positionGeometry.xy, float(0.5), float(1)));
    return p.xyz.div(p.w);
  })());

  const waterColor = Fn(() => {
    const rayV = viewRay.toVar();
    const fwd = rayV.z.negate().toVar();                       // > 0
    const dirW = normalize(cameraWorldMatrix.mul(vec4(rayV, 0)).xyz).toVar();

    // ── Where the lens is: this pixel's point on the near plane ──────────────
    const nearOff = cameraWorldMatrix.mul(vec4(rayV.mul(cameraNear.div(fwd)), 0)).xyz;
    const lensP = cameraPosition.add(nearOff).toVar();
    const surfY = waterHeightAt(lensP.xz).toVar();
    // Signed metres above the water at the lens; the shore field says whether
    // there is sea here at all (a dry basin below sea level is not underwater).
    const s = lensP.y.sub(surfY).toVar();
    const isSea = step(float(-1.5), shoreAt(lensP.xz).x).toVar();

    // Anti-aliased coverage and the line, both from one screen derivative so the
    // line is the same number of pixels wide whatever the wave is doing.
    const fw = max(fwidth(s), float(1e-5)).toVar();
    const inside = saturate(float(0.5).sub(s.div(fw))).mul(isSea).toVar();
    const onLine = float(1).sub(smoothstep(float(0), max(u.uwLineWidth, float(0.25)), abs(s).div(fw)))
      .mul(isSea).toVar();

    // ── Scene, dragged a few pixels just below the line ──────────────────────
    const wob = sin(screenUV.x.mul(60).add(u.time.mul(2.3))).mul(0.5).add(0.5);
    const dragPx = onLine.mul(inside).mul(u.uwLineDistort).mul(wob.mul(0.6).add(0.4));
    const uvW = screenUV.add(vec2(0, dragPx.div(screenSize.y))).toVar();

    const above = sceneColorTex.sample(screenUV).rgb.toVar();
    const behind = sceneColorTex.sample(uvW).rgb.toVar();
    const rawDepth = sceneDepthTex.sample(uvW).r.toVar();

    // ── Distance along the ray, and how deep the thing we see is ─────────────
    const viewZ = perspectiveDepthToViewZ(rawDepth, cameraNear, cameraFar).negate();
    const D = min(viewZ.mul(length(rayV)).div(fwd), float(5000)).toVar();
    const hitY = cameraPosition.y.add(dirW.y.mul(D));
    const hitDepth = max(u.waterY.sub(hitY), float(0));
    const camDepth = max(surfY.sub(cameraPosition.y), float(0));

    const view = exp(sigma.mul(D).negate());
    const sunPath = exp(sigma.mul(hitDepth).negate());
    const wet = behind.mul(sunPath).mul(view).add(inscatter(dirW, camDepth, D)).toVar();

    /*
     * ── LIGHT SHAFTS ─────────────────────────────────────────────────────────
     * The analytic inscatter above assumes the sunlight under the surface is
     * uniform. It is not: the waves focus it into columns. So march the first
     * `uwShaftDistance` metres of the ray, and at each step follow the sunlight
     * back UP along the refracted sun direction to the point on the surface it
     * came through, and ask how bright the surface pattern is there.
     *
     * Every point on one refracted sun ray reads the same surface point, which
     * is exactly what makes the result a SHAFT — a streak leaning toward the
     * sun — rather than a cloud of noise. Brightness falls off with the light's
     * own path (depth) and the view path (t), per channel, so shafts go
     * blue-green and die with depth by themselves.
     *
     * Additive on top of the uniform term: the pattern is the focused EXTRA
     * light, and the shafts' average brightening is what `uwShaftIntensity`
     * trades against `uwLightGain`.
     *
     * 10 steps, jittered per pixel (interleaved gradient noise) so the steps
     * do not show as bands. Real branch: only pixels actually under water pay,
     * and the taps carry explicit LODs so they are legal inside it.
     */
    // Assigned at top level first: a TSL var first touched inside an If is
    // declared inside it, and the read after the branch would find nothing.
    const shaftLight = vec3(0).toVar();
    shaftLight.assign(vec3(0));
    If(u.uwShaftsEnabled.greaterThan(0).and(inside.greaterThan(0.002)), () => {
      const L = min(D, u.uwShaftDistance).toVar();
      const dt = L.div(float(SHAFT_STEPS)).toVar();
      const jit = fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))))).toVar();
      const sunU = u.uwSunDirUnder;
      // Metres sideways the light travels per metre of depth. Clamped so a sun
      // on the horizon (refracted to ~48°) cannot throw the lookup to infinity.
      const lean = sunU.xz.div(max(sunU.y, float(0.3))).toVar();
      const wind = vec2(cos(u.windAngle), sin(u.windAngle));
      const drift = wind.mul(u.time.mul(u.uwShaftSpeed)).toVar();
      const acc = vec3(0).toVar();

      Loop(SHAFT_STEPS, ({ i }) => {
        const t = float(i).add(jit).mul(dt);
        const p = cameraPosition.add(dirW.mul(t)).toVar();
        const depthP = max(u.waterY.sub(p.y), float(0)).toVar();
        const atSurface = p.xz.add(lean.mul(depthP)).toVar();
        // Two ridged layers at unrelated scales and drift directions: their
        // product is a web that shifts and re-forms instead of sliding by.
        const q1 = atSurface.mul(u.uwShaftScale).add(drift.mul(u.uwShaftScale));
        const q2 = vec2(
          atSurface.x.mul(0.6).sub(atSurface.y.mul(0.8)),
          atSurface.x.mul(0.8).add(atSurface.y.mul(0.6)),
        ).mul(u.uwShaftScale.mul(1.37)).sub(drift.mul(u.uwShaftScale.mul(0.9)));
        const n1 = texture(shaftNoise, q1).level(0).r;
        const n2 = texture(shaftNoise, q2).level(0).r;
        const ridge = float(1).sub(abs(n1.mul(2).sub(1)))
          .mul(float(1).sub(abs(n2.mul(2).sub(1))));
        const s = pow(ridge, max(u.uwShaftSharpness, float(0.5)));
        acc.addAssign(exp(sigma.mul(depthP.add(t)).negate()).mul(s));
      });

      shaftLight.assign(
        u.uwScatterColor.mul(u.uwLightSun).mul(sunPhase(dirW))
          .mul(acc).mul(sigma).mul(dt).mul(u.uwShaftIntensity),
      );
    });
    wet.addAssign(shaftLight);

    const col = mix(above, wet, inside).toVar();
    col.mulAssign(float(1).sub(onLine.mul(u.uwLineDarken)));

    // Nothing to do this pixel: leave the frame (and its emissive) exactly as
    // it was. LAST, after every sample — a discard ahead of an implicit-
    // derivative sample breaks WGSL's uniform-control-flow rule.
    Discard(inside.add(onLine).lessThan(0.002));
    return vec4(col, 1);
  });

  const tri = new THREE.BufferGeometry();
  tri.setAttribute("position", new THREE.BufferAttribute(
    new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3,
  ));
  tri.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

  const waterMat = new MeshBasicNodeMaterial({
    transparent: true, depthTest: false, depthWrite: false,
  });
  waterMat.vertexNode = vec4(positionGeometry.xy, float(0.5), float(1));
  waterMat.colorNode = waterColor();
  waterMat.fog = false;
  waterMat.name = "OceanUnderwater";
  // Zero-alpha emissive: the frame's glow buffer passes through untouched
  // instead of being stamped black wherever this pass covers.
  applyBloomMRT(waterMat, vec4(0));

  const water = new THREE.Mesh(tri, waterMat);
  water.name = "OceanUnderwater";
  water.frustumCulled = false;
  water.renderOrder = 1e6;          // after every transparent, so they get hazed too
  water.matrixAutoUpdate = false;
  water.visible = false;

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. MARINE SNOW
  // ═══════════════════════════════════════════════════════════════════════════

  const quad = new THREE.PlaneGeometry(1, 1);
  const snowGeo = new THREE.InstancedBufferGeometry();
  snowGeo.index = quad.index;
  snowGeo.setAttribute("position", quad.getAttribute("position"));
  const seeds = new Float32Array(SNOW_MAX * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  snowGeo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
  snowGeo.instanceCount = 0;
  snowGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

  const snowFade = varyingProperty("float", "vUwSnowFade");
  const snowCol = varyingProperty("vec3", "vUwSnowCol");

  const snowVertex = Fn(() => {
    const seed = attribute("aSeed", "vec4");
    const box = max(u.uwSnowBox, float(2));
    // A slow current plus a per-speck wander, then wrapped into a box centred
    // on the camera — so specks are fixed in the world and endless.
    const drift = vec3(0.12, -0.03, 0.07).mul(u.time)
      .add(vec3(
        sin(u.time.mul(0.31).add(seed.w.mul(40))),
        sin(u.time.mul(0.23).add(seed.x.mul(40))).mul(0.5),
        cos(u.time.mul(0.27).add(seed.y.mul(40))),
      ).mul(0.25));
    const origin = seed.xyz.mul(box).add(drift);
    // Floored modulo. TSL's `mod` is WGSL `%`, which keeps the dividend's sign,
    // so every speck on the negative side of the camera would escape the box.
    const rel = origin.sub(cameraPosition);
    const wrapped = rel.sub(box.mul(floor(rel.div(box))));
    const p = wrapped.sub(box.mul(0.5)).add(cameraPosition).toVar();

    const size = u.uwSnowSize.mul(seed.w.mul(1.4).add(0.3));
    const viewC = cameraViewMatrix.mul(vec4(p, 1)).xyz.toVar();
    const viewP = viewC.add(vec3(positionGeometry.xy.mul(size), 0));

    // Out of the water, too close to resolve, or out at the box edge where the
    // wrap would pop: faded, never cut.
    const d = length(viewC);
    const inWater = step(p.y, waterHeightAt(p.xz));
    const nearF = smoothstep(float(0.25), float(0.9), d);
    const farF = float(1).sub(smoothstep(box.mul(0.3), box.mul(0.5), d));
    const T = exp(sigma.mul(d).negate());
    snowFade.assign(inWater.mul(nearF).mul(farF).mul(dot(T, vec3(0.33))));
    snowCol.assign(u.uwLightAmb.add(u.uwLightSun).mul(u.uwSnowIntensity).mul(0.35));

    return cameraProjectionMatrix.mul(vec4(viewP, 1));
  });

  const snowColor = Fn(() => {
    const r = length(positionGeometry.xy);
    const a = float(1).sub(smoothstep(float(0.15), float(0.5), r)).mul(snowFade);
    Discard(a.lessThan(0.003));
    return vec4(snowCol.mul(a), 1);
  });

  const snowMat = new MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  snowMat.vertexNode = snowVertex();
  snowMat.colorNode = snowColor();
  snowMat.fog = false;
  snowMat.name = "OceanMarineSnow";

  const snow = new THREE.Mesh(snowGeo, snowMat);
  snow.name = "OceanMarineSnow";
  snow.frustumCulled = false;
  snow.renderOrder = 1e6 + 1;       // after the water pass, which would bury it
  snow.matrixAutoUpdate = false;
  snow.visible = false;

  const group = new THREE.Group();
  group.name = "OceanUnderwater";
  group.add(water, snow);

  return {
    group,
    water,
    snow,
    /** How many specks draw (clamped to the allocation). No recompile. */
    setSnowCount(n) { snowGeo.instanceCount = Math.max(0, Math.min(SNOW_MAX, Math.round(n))); },
    dispose() {
      tri.dispose();
      quad.dispose();
      snowGeo.dispose();
      waterMat.dispose();
      snowMat.dispose();
    },
  };
}
