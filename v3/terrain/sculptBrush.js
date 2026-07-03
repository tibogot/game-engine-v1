import * as THREE from "three";
import { QuadMesh } from "three/webgpu";
import {
  Fn,
  float,
  vec2,
  vec4,
  vec3,
  min,
  max,
  mix,
  clamp,
  length,
  pow,
  floor,
  step,
  texture,
  uv,
  uniform,
  mx_noise_float,
} from "three/tsl";
import { HEIGHTMAP_SIZE, WORLD_SIZE, MAX_HEIGHT } from "./heightmapTexture.js";

// Height RT precision: half-float quantizes stored heights into ~5-25 cm steps
// (mantissa is only 10 bits), which reads as contour-line banding in anything
// shaded from the heightmap — invisible on textured rock, glaring on snow.
// Upgraded to full float in createSculptBrush when the GPU can filter it.
let heightRTType = THREE.HalfFloatType;

function makeHeightRT(w = HEIGHTMAP_SIZE, h = HEIGHTMAP_SIZE) {
  const rt = new THREE.RenderTarget(w, h, {
    format:          THREE.RGBAFormat,
    type:            heightRTType,
    minFilter:       THREE.LinearFilter,
    magFilter:       THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer:     false,
    colorSpace:      THREE.NoColorSpace,
  });
  rt.texture.flipY = false;
  return rt;
}

export function createSculptBrush(renderer, initialDataTex, heightTexNode, initialMaskTex) {
  if (renderer?.backend?.device?.features?.has("float32-filterable")) {
    heightRTType = THREE.FloatType;
  }

  // ── Render targets ─────────────────────────────────────────────────────────
  // rtMain      — the one canonical heightmap. heightTexNode.value points here
  //               permanently, so every consumer (terrain, ocean, snow, grass)
  //               always samples live data — no ping-pong texture swaps.
  // rtScratch   — read source for brush passes. Each stamp copies the brush
  //               neighbourhood main→scratch, then the brush shader reads
  //               scratch and writes main (both passes scissored to the rect).
  // rtPreStroke — full copy taken at beginStroke(); endStroke() snapshots the
  //               stroke's dirty rect out of it into a rect-sized undo entry.
  const rtMain      = makeHeightRT();
  const rtScratch   = makeHeightRT();
  const rtPreStroke = makeHeightRT();

  // ── Shared brush uniforms ─────────────────────────────────────────────────
  const uBrushUV   = uniform(new THREE.Vector2(0.5, 0.5));
  const uRadius    = uniform(0.05);
  const uStrength  = uniform(0.004);
  const uFalloff   = uniform(2.0);   // exponent: 0.5 feathered → 4.0 hard edge
  const uDir       = uniform(1.0);   // +1 raise, -1 lower
  const uClampMin       = uniform(-2.0);  // normalized minimum (-2.0 = off — digging below 0 allowed)
  const uClampMax       = uniform(2.0);   // normalized maximum (2.0 = off by default)
  const uTerraceStep      = uniform(0.04);  // terrace step height in normalized units (~20 m)
  const uTerraceSharpness = uniform(0.6);   // terrace blend sharpness: 0=soft, 1=hard snap
  const uNoiseScale       = uniform(0.5);   // noise frequency multiplier
  const uNoiseOctaves     = uniform(3.0);   // FBM octave count (1-4)
  const uSmudgeDir        = uniform(new THREE.Vector2(0, 1)); // normalized stroke direction in UV space
  // Flatten levels toward a target captured at stroke START (main.js samples the
  // CPU mirror on mousedown) — resampling under the cursor per stamp made the
  // target drift downhill/uphill during a drag.
  const uFlattenTarget    = uniform(0.0);
  // Thermal talus threshold in normalized height units per texel; 30° default
  // (matches the slider's HTML default — main.js re-syncs it on startup anyway).
  const uThermalSlope     = uniform(Math.tan(30 * Math.PI / 180) * WORLD_SIZE / HEIGHTMAP_SIZE / MAX_HEIGHT);
  const uRampA            = uniform(new THREE.Vector2(0.3, 0.5));
  const uRampB            = uniform(new THREE.Vector2(0.7, 0.5));
  const uRampWidth        = uniform(0.02);  // ramp half-width in UV space
  const uMaskRotation     = uniform(0.0);   // brush mask rotation in radians

  // Read source for all brush passes (scratch copy of the brush neighbourhood).
  const srcNode = texture(rtMain.texture);

  // Brush mask node — .value is swapped when the user changes the mask preset or loads a PNG.
  const maskNode = texture(initialMaskTex);

  const texel = float(1.0 / HEIGHTMAP_SIZE);

  // ── Edge fade helper ──────────────────────────────────────────────────────
  const EDGE_BORDER = float(4.0 / HEIGHTMAP_SIZE);
  const edgeFade = Fn(([uvCoord]) => {
    const eu = min(uvCoord.x, float(1).sub(uvCoord.x));
    const ev = min(uvCoord.y, float(1).sub(uvCoord.y));
    return clamp(min(eu, ev).div(EDGE_BORDER), float(0), float(1));
  });

  // ── Brush falloff via mask texture ────────────────────────────────────────
  // Replaces the old radial (1 - d/radius) falloff. The soft-circle mask preset
  // reproduces identical behaviour; other presets give shaped brush footprints.
  // Out-of-bounds brush UVs return 0 via the inBounds gate (ignoring clamp mode).
  const getBrushFalloff = Fn(([uvCoord]) => {
    const maskUV   = uvCoord.sub(uBrushUV).div(uRadius.mul(float(2))).add(float(0.5));
    const c        = maskUV.sub(float(0.5));
    const cosR     = uMaskRotation.cos();
    const sinR     = uMaskRotation.sin();
    const rotUV    = vec2(
      c.x.mul(cosR).sub(c.y.mul(sinR)).add(float(0.5)),
      c.x.mul(sinR).add(c.y.mul(cosR)).add(float(0.5)),
    );
    const inBoundsX = step(float(0), rotUV.x).mul(step(rotUV.x, float(1)));
    const inBoundsY = step(float(0), rotUV.y).mul(step(rotUV.y, float(1)));
    return texture(maskNode, rotUV).r.mul(inBoundsX).mul(inBoundsY);
  });

  // ── Raise / lower brush ───────────────────────────────────────────────────
  const raiseMat = new THREE.MeshBasicNodeMaterial();
  raiseMat.fragmentNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;
    const falloff  = getBrushFalloff(uvCoord);
    const delta    = pow(falloff, uFalloff).mul(uStrength).mul(uDir).mul(edgeFade(uvCoord));
    return vec4(clamp(currentH.add(delta), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const raiseQuad = new QuadMesh(raiseMat);

  // ── Smooth brush ──────────────────────────────────────────────────────────
  const smoothMat = new THREE.MeshBasicNodeMaterial();
  smoothMat.fragmentNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;

    const hL  = texture(srcNode, vec2(uvCoord.x.sub(texel), uvCoord.y)).r;
    const hR  = texture(srcNode, vec2(uvCoord.x.add(texel), uvCoord.y)).r;
    const hD  = texture(srcNode, vec2(uvCoord.x, uvCoord.y.sub(texel))).r;
    const hU  = texture(srcNode, vec2(uvCoord.x, uvCoord.y.add(texel))).r;
    const hLD = texture(srcNode, vec2(uvCoord.x.sub(texel), uvCoord.y.sub(texel))).r;
    const hRD = texture(srcNode, vec2(uvCoord.x.add(texel), uvCoord.y.sub(texel))).r;
    const hLU = texture(srcNode, vec2(uvCoord.x.sub(texel), uvCoord.y.add(texel))).r;
    const hRU = texture(srcNode, vec2(uvCoord.x.add(texel), uvCoord.y.add(texel))).r;
    const avg = hL.add(hR).add(hD).add(hU).add(hLD).add(hRD).add(hLU).add(hRU).mul(0.125);

    const falloff  = getBrushFalloff(uvCoord);
    const blendAmt = clamp(pow(falloff, uFalloff).mul(uStrength).mul(float(20)).mul(edgeFade(uvCoord)), float(0), float(1));

    return vec4(clamp(mix(currentH, avg, blendAmt), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const smoothQuad = new QuadMesh(smoothMat);

  // ── Flatten brush ─────────────────────────────────────────────────────────
  const flattenMat = new THREE.MeshBasicNodeMaterial();
  flattenMat.fragmentNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;
    const targetH  = uFlattenTarget;

    const falloff  = getBrushFalloff(uvCoord);
    const blendAmt = clamp(pow(falloff, uFalloff).mul(uStrength).mul(float(20)).mul(edgeFade(uvCoord)), float(0), float(1));

    return vec4(clamp(mix(currentH, targetH, blendAmt), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const flattenQuad = new QuadMesh(flattenMat);

  // ── Noise brush (coherent Perlin FBM) ─────────────────────────────────────
  // The FBM lattice lives in fixed UV space (not brush space) so overlapping
  // stamps along a stroke reinforce the same bumps instead of averaging to mush.
  const noiseMat = new THREE.MeshBasicNodeMaterial();
  noiseMat.fragmentNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;

    // uNoiseScale 0.1..3.0 → 10..300 lattice cells across the map (205 m..7 m features).
    const freq = uNoiseScale.mul(float(100));
    const px   = uvCoord.x.mul(freq);
    const py   = uvCoord.y.mul(freq);

    const use2 = step(float(1.5), uNoiseOctaves);
    const use3 = step(float(2.5), uNoiseOctaves);
    const use4 = step(float(3.5), uNoiseOctaves);

    // Distinct z-slices decorrelate the octaves.
    const n1 = mx_noise_float(vec3(px, py, float(7.3)));
    const n2 = mx_noise_float(vec3(px.mul(float(2.02)), py.mul(float(2.02)), float(19.1)));
    const n3 = mx_noise_float(vec3(px.mul(float(4.05)), py.mul(float(4.05)), float(31.7)));
    const n4 = mx_noise_float(vec3(px.mul(float(8.11)), py.mul(float(8.11)), float(53.9)));

    const raw = n1.mul(float(0.5))
      .add(n2.mul(float(0.25)).mul(use2))
      .add(n3.mul(float(0.125)).mul(use3))
      .add(n4.mul(float(0.0625)).mul(use4));
    const maxRaw = float(0.5)
      .add(float(0.25).mul(use2))
      .add(float(0.125).mul(use3))
      .add(float(0.0625).mul(use4));

    const noiseVal = raw.div(maxRaw); // ≈ [-1, 1]
    const falloff  = getBrushFalloff(uvCoord);
    const delta    = pow(falloff, uFalloff).mul(noiseVal).mul(uStrength).mul(float(6)).mul(edgeFade(uvCoord));

    return vec4(clamp(currentH.add(delta), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const noiseQuad = new QuadMesh(noiseMat);

  // ── Terrace brush ─────────────────────────────────────────────────────────
  const terraceMat = new THREE.MeshBasicNodeMaterial();
  terraceMat.fragmentNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;

    const stepped  = floor(currentH.div(uTerraceStep)).add(float(0.5)).mul(uTerraceStep);

    const falloff  = getBrushFalloff(uvCoord);
    const blendAmt = clamp(pow(falloff, uFalloff).mul(uTerraceSharpness).mul(float(8)).mul(edgeFade(uvCoord)), float(0), float(1));

    return vec4(clamp(mix(currentH, stepped, blendAmt), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const terraceQuad = new QuadMesh(terraceMat);

  // ── Plateau brush ─────────────────────────────────────────────────────────
  // Stamp shape uses radial distance for the plateau profile; mask modulates
  // the per-pixel influence so the shape clips to the current brush footprint.
  const plateauMat = new THREE.MeshBasicNodeMaterial();
  plateauMat.fragmentNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;
    const d        = length(uvCoord.sub(uBrushUV));
    const t        = clamp(d.div(uRadius), float(0), float(1));
    const tOuter   = clamp(t.sub(float(0.5)).div(float(0.5)), float(0), float(1));
    const plateauFalloff = float(1).sub(pow(tOuter, uFalloff));
    const maskFactor = getBrushFalloff(uvCoord);
    const delta    = plateauFalloff.mul(maskFactor).mul(uStrength).mul(uDir).mul(edgeFade(uvCoord));
    return vec4(clamp(currentH.add(delta), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const plateauQuad = new QuadMesh(plateauMat);

  // ── Crater brush ──────────────────────────────────────────────────────────
  const craterMat = new THREE.MeshBasicNodeMaterial();
  craterMat.fragmentNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;
    const d        = length(uvCoord.sub(uBrushUV));
    const t        = clamp(d.div(uRadius), float(0), float(1));
    const craterProfile = t.mul(t).mul(float(2)).sub(float(1))
      .mul(pow(max(float(0), float(1).sub(t)), float(0.5)));
    const maskFactor = getBrushFalloff(uvCoord);
    const delta    = craterProfile.mul(maskFactor).mul(uStrength).mul(float(5)).mul(uDir).mul(edgeFade(uvCoord));
    return vec4(clamp(currentH.add(delta), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const craterQuad = new QuadMesh(craterMat);

  // ── Smudge / Push brush ───────────────────────────────────────────────────
  const smudgeMat = new THREE.MeshBasicNodeMaterial();
  smudgeMat.fragmentNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;

    const falloff = getBrushFalloff(uvCoord);

    const smearOffset = uRadius.mul(float(0.5)).mul(falloff);
    const smearUV     = uvCoord.sub(vec2(uSmudgeDir.x.mul(smearOffset), uSmudgeDir.y.mul(smearOffset)));
    const smearH      = texture(srcNode, smearUV).r;

    const blendAmt = clamp(pow(falloff, uFalloff).mul(uStrength).mul(float(20)).mul(edgeFade(uvCoord)), float(0), float(1));
    return vec4(clamp(mix(currentH, smearH, blendAmt), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const smudgeQuad = new QuadMesh(smudgeMat);

  // ── Contrast brush ────────────────────────────────────────────────────────
  const contrastMat = new THREE.MeshBasicNodeMaterial();
  contrastMat.fragmentNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;

    const hL  = texture(srcNode, vec2(uvCoord.x.sub(texel), uvCoord.y)).r;
    const hR  = texture(srcNode, vec2(uvCoord.x.add(texel), uvCoord.y)).r;
    const hD  = texture(srcNode, vec2(uvCoord.x, uvCoord.y.sub(texel))).r;
    const hU  = texture(srcNode, vec2(uvCoord.x, uvCoord.y.add(texel))).r;
    const hLD = texture(srcNode, vec2(uvCoord.x.sub(texel), uvCoord.y.sub(texel))).r;
    const hRD = texture(srcNode, vec2(uvCoord.x.add(texel), uvCoord.y.sub(texel))).r;
    const hLU = texture(srcNode, vec2(uvCoord.x.sub(texel), uvCoord.y.add(texel))).r;
    const hRU = texture(srcNode, vec2(uvCoord.x.add(texel), uvCoord.y.add(texel))).r;
    const avg  = hL.add(hR).add(hD).add(hU).add(hLD).add(hRD).add(hLU).add(hRU).mul(float(0.125));

    const diff    = currentH.sub(avg);
    const falloff = getBrushFalloff(uvCoord);
    const amplify = clamp(pow(falloff, uFalloff).mul(uStrength).mul(float(40)).mul(edgeFade(uvCoord)), float(0), float(1));

    return vec4(clamp(currentH.add(diff.mul(amplify)), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const contrastQuad = new QuadMesh(contrastMat);

  // ── Thermal erosion brush ─────────────────────────────────────────────────
  const thermalMat = new THREE.MeshBasicNodeMaterial();
  thermalMat.fragmentNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;

    const hL = texture(srcNode, vec2(uvCoord.x.sub(texel), uvCoord.y)).r;
    const hR = texture(srcNode, vec2(uvCoord.x.add(texel), uvCoord.y)).r;
    const hD = texture(srcNode, vec2(uvCoord.x, uvCoord.y.sub(texel))).r;
    const hU = texture(srcNode, vec2(uvCoord.x, uvCoord.y.add(texel))).r;

    const lossL = max(float(0), currentH.sub(hL).sub(uThermalSlope)).mul(float(0.25));
    const lossR = max(float(0), currentH.sub(hR).sub(uThermalSlope)).mul(float(0.25));
    const lossD = max(float(0), currentH.sub(hD).sub(uThermalSlope)).mul(float(0.25));
    const lossU = max(float(0), currentH.sub(hU).sub(uThermalSlope)).mul(float(0.25));
    const gainL = max(float(0), hL.sub(currentH).sub(uThermalSlope)).mul(float(0.25));
    const gainR = max(float(0), hR.sub(currentH).sub(uThermalSlope)).mul(float(0.25));
    const gainD = max(float(0), hD.sub(currentH).sub(uThermalSlope)).mul(float(0.25));
    const gainU = max(float(0), hU.sub(currentH).sub(uThermalSlope)).mul(float(0.25));

    const totalDelta = gainL.add(gainR).add(gainD).add(gainU)
      .sub(lossL).sub(lossR).sub(lossD).sub(lossU);

    const falloff  = getBrushFalloff(uvCoord);
    const brushAmt = pow(falloff, uFalloff).mul(edgeFade(uvCoord));

    return vec4(clamp(currentH.add(totalDelta.mul(brushAmt)), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const thermalQuad = new QuadMesh(thermalMat);

  // ── Ramp brush ────────────────────────────────────────────────────────────
  // Applied once on second click. Uses lateral distance from A→B segment rather
  // than a brush-centered mask; mask does not apply to this tool.
  const rampMat = new THREE.MeshBasicNodeMaterial();
  rampMat.fragmentNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;

    const hA = texture(srcNode, uRampA).r;
    const hB = texture(srcNode, uRampB).r;

    const ABx = uRampB.x.sub(uRampA.x);
    const ABy = uRampB.y.sub(uRampA.y);
    const APx = uvCoord.x.sub(uRampA.x);
    const APy = uvCoord.y.sub(uRampA.y);
    const dotAP_AB = APx.mul(ABx).add(APy.mul(ABy));
    const dotAB_AB = max(ABx.mul(ABx).add(ABy.mul(ABy)), float(0.0001));
    const t        = clamp(dotAP_AB.div(dotAB_AB), float(0), float(1));

    const closestX    = uRampA.x.add(ABx.mul(t));
    const closestY    = uRampA.y.add(ABy.mul(t));
    const distToRamp  = length(vec2(uvCoord.x.sub(closestX), uvCoord.y.sub(closestY)));

    const targetH  = mix(hA, hB, t);
    const lateral  = clamp(float(1).sub(distToRamp.div(uRampWidth)), float(0), float(1));
    const blendAmt = pow(lateral, uFalloff).mul(edgeFade(uvCoord));

    return vec4(clamp(mix(currentH, targetH, blendAmt), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const rampQuad = new QuadMesh(rampMat);

  // ── Copy / snapshot / restore passes ──────────────────────────────────────
  const copyMat = new THREE.MeshBasicNodeMaterial();
  copyMat.fragmentNode = Fn(() =>
    vec4(texture(srcNode, uv()).r, float(0), float(0), float(1)),
  )();
  const copyQuad = new QuadMesh(copyMat);

  // Snapshot: read a sub-rect of a big RT into a small rect-sized RT.
  const snapSrcNode = texture(rtMain.texture);
  const uSnapOffset = uniform(new THREE.Vector2(0, 0));
  const uSnapScale  = uniform(new THREE.Vector2(1, 1));
  const snapMat = new THREE.MeshBasicNodeMaterial();
  snapMat.fragmentNode = Fn(() =>
    vec4(texture(snapSrcNode, uv().mul(uSnapScale).add(uSnapOffset)).r, float(0), float(0), float(1)),
  )();
  const snapQuad = new QuadMesh(snapMat);

  // Restore: write a small rect RT back into its sub-rect of rtMain (scissored).
  const restSrcNode = texture(rtMain.texture);
  const uRestOffset = uniform(new THREE.Vector2(0, 0));
  const uRestScale  = uniform(new THREE.Vector2(1, 1));
  const restMat = new THREE.MeshBasicNodeMaterial();
  restMat.fragmentNode = Fn(() =>
    vec4(texture(restSrcNode, uv().sub(uRestOffset).div(uRestScale)).r, float(0), float(0), float(1)),
  )();
  const restQuad = new QuadMesh(restMat);

  // ── Render helpers ────────────────────────────────────────────────────────
  // rect is in logical texel coords ({x, y, w, h}, y = row index in uv space).
  // On WebGPU, QuadMesh uvs are pre-flipped (uv.y=0 at NDC top) and WGSL never
  // flips sampling (isFlipY() === false), so logical v == storage row == the
  // top-origin scissor y — the rect passes through unchanged. autoClear must be
  // OFF for scissored passes: WebGPU's clear loadOp ignores scissor and would
  // wipe the rest of the map.
  function _render(quad, dstRT, rect) {
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    if (rect) {
      dstRT.scissor.set(rect.x, rect.y, rect.w, rect.h);
      renderer.setScissorTest(true);
    }
    renderer.setRenderTarget(dstRT);
    quad.render(renderer);
    renderer.setRenderTarget(null);
    if (rect) renderer.setScissorTest(false);
    renderer.autoClear = prevAutoClear;
  }

  function _clampRect(x0, y0, x1, y1) {
    const S = HEIGHTMAP_SIZE;
    x0 = Math.max(0, Math.min(S, x0));
    y0 = Math.max(0, Math.min(S, y0));
    x1 = Math.max(0, Math.min(S, x1));
    y1 = Math.max(0, Math.min(S, y1));
    if (x1 - x0 < 1 || y1 - y0 < 1) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function _rectFromUV(u0, v0, u1, v1, marginTexels = 2) {
    const S = HEIGHTMAP_SIZE;
    return _clampRect(
      Math.floor(u0 * S) - marginTexels,
      Math.floor(v0 * S) - marginTexels,
      Math.ceil(u1 * S) + marginTexels,
      Math.ceil(v1 * S) + marginTexels,
    );
  }

  // Rotated square masks reach out to radius·√2; 1.45 covers all brush shapes.
  const BRUSH_REACH = 1.45;

  function _brushRect() {
    const c = uBrushUV.value;
    const r = uRadius.value * BRUSH_REACH;
    return _rectFromUV(c.x - r, c.y - r, c.x + r, c.y + r);
  }

  function _expandRect(rect, m) {
    return _clampRect(rect.x - m, rect.y - m, rect.x + rect.w + m, rect.y + rect.h + m);
  }

  function _unionRect(a, b) {
    if (!a) return b ? { ...b } : null;
    if (!b) return { ...a };
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  const FULL_RECT = { x: 0, y: 0, w: HEIGHTMAP_SIZE, h: HEIGHTMAP_SIZE };

  // ── Stroke + history state ────────────────────────────────────────────────
  const MAX_HISTORY = 25;
  const undoStack   = []; // entries: { rt, rect }
  const redoStack   = [];
  let strokeOpen  = false;
  let strokeRect  = null;

  function blitFull(srcTexture, dstRT) {
    srcNode.value = srcTexture;
    _render(copyQuad, dstRT, null);
  }

  function snapshotRect(srcRT, rect) {
    const S  = HEIGHTMAP_SIZE;
    const rt = makeHeightRT(rect.w, rect.h);
    snapSrcNode.value = srcRT.texture;
    uSnapOffset.value.set(rect.x / S, rect.y / S);
    uSnapScale.value.set(rect.w / S, rect.h / S);
    _render(snapQuad, rt, null);
    return { rt, rect: { ...rect } };
  }

  function restoreRect(entry) {
    const S = HEIGHTMAP_SIZE;
    restSrcNode.value = entry.rt.texture;
    uRestOffset.value.set(entry.rect.x / S, entry.rect.y / S);
    uRestScale.value.set(entry.rect.w / S, entry.rect.h / S);
    _render(restQuad, rtMain, entry.rect);
  }

  function trimStack(stack) {
    while (stack.length >= MAX_HISTORY) stack.shift().rt.dispose();
  }

  function disposeStack(stack) {
    for (const entry of stack) entry.rt.dispose();
    stack.length = 0;
  }

  // ── Core stamp pass ───────────────────────────────────────────────────────
  // 1. Copy the read neighbourhood (write rect + tap margin) main → scratch.
  // 2. Run the brush shader reading scratch, writing main, scissored to the
  //    write rect. Stamp cost scales with brush size, not map size.
  function _applyBrush(quad, writeRect, readMarginTexels = 4) {
    if (!writeRect) return;
    if (!strokeOpen) beginStroke(); // defensive — callers should beginStroke first
    const readRect = _expandRect(writeRect, readMarginTexels) ?? writeRect;
    srcNode.value = rtMain.texture;
    _render(copyQuad, rtScratch, readRect);
    srcNode.value = rtScratch.texture;
    _render(quad, rtMain, writeRect);
    strokeRect = _unionRect(strokeRect, writeRect);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function paint(brushUVx, brushUVy, direction, stamp = "smooth") {
    uBrushUV.value.set(brushUVx, brushUVy);
    uDir.value = direction;
    const quad = stamp === "plateau" ? plateauQuad
               : stamp === "crater"  ? craterQuad
               : raiseQuad;
    _applyBrush(quad, _brushRect());
  }

  function smooth(brushUVx, brushUVy) {
    uBrushUV.value.set(brushUVx, brushUVy);
    _applyBrush(smoothQuad, _brushRect());
  }

  function flatten(brushUVx, brushUVy) {
    uBrushUV.value.set(brushUVx, brushUVy);
    _applyBrush(flattenQuad, _brushRect());
  }

  function noise(brushUVx, brushUVy) {
    uBrushUV.value.set(brushUVx, brushUVy);
    _applyBrush(noiseQuad, _brushRect());
  }

  function terrace(brushUVx, brushUVy) {
    uBrushUV.value.set(brushUVx, brushUVy);
    _applyBrush(terraceQuad, _brushRect());
  }

  function smudge(brushUVx, brushUVy) {
    uBrushUV.value.set(brushUVx, brushUVy);
    // Smudge reads up to radius·0.5 behind the write rect.
    const smearMargin = Math.ceil(uRadius.value * 0.5 * HEIGHTMAP_SIZE) + 2;
    _applyBrush(smudgeQuad, _brushRect(), smearMargin);
  }

  function contrast(brushUVx, brushUVy) {
    uBrushUV.value.set(brushUVx, brushUVy);
    _applyBrush(contrastQuad, _brushRect());
  }

  const thermalConfig = { iterations: 5 };

  function thermal(brushUVx, brushUVy) {
    uBrushUV.value.set(brushUVx, brushUVy);
    const rect = _brushRect();
    for (let i = 0; i < thermalConfig.iterations; i++) _applyBrush(thermalQuad, rect);
  }

  function ramp(aUV, bUV) {
    uRampA.value.set(aUV.u, aUV.v);
    uRampB.value.set(bUV.u, bUV.v);
    const w = uRampWidth.value;
    const rect = _rectFromUV(
      Math.min(aUV.u, bUV.u) - w, Math.min(aUV.v, bUV.v) - w,
      Math.max(aUV.u, bUV.u) + w, Math.max(aUV.v, bUV.v) + w,
    );
    _applyBrush(rampQuad, rect);
  }

  /**
   * Run a full-map generator pass (e.g. GPU procedural terrain). The quad's
   * material must not read srcNode. Caller manages begin/endStroke so a burst
   * of live slider updates collapses into one undo entry.
   */
  function runGeneratorPass(quad) {
    if (!strokeOpen) beginStroke();
    _render(quad, rtMain, null);
    strokeRect = _unionRect(strokeRect, FULL_RECT);
  }

  function beginStroke() {
    if (strokeOpen) endStroke();
    blitFull(rtMain.texture, rtPreStroke);
    strokeRect = null;
    strokeOpen = true;
  }

  /** Close the stroke and push its dirty rect (pre-stroke content) onto undo. */
  function endStroke() {
    if (!strokeOpen) return;
    strokeOpen = false;
    if (!strokeRect) return; // click without stamps — nothing to record
    disposeStack(redoStack);
    trimStack(undoStack);
    undoStack.push(snapshotRect(rtPreStroke, strokeRect));
    strokeRect = null;
  }

  function undo() {
    endStroke();
    if (undoStack.length === 0) return false;
    trimStack(redoStack);
    const entry = undoStack.pop();
    redoStack.push(snapshotRect(rtMain, entry.rect));
    restoreRect(entry);
    entry.rt.dispose();
    return true;
  }

  function redo() {
    endStroke();
    if (redoStack.length === 0) return false;
    trimStack(undoStack);
    const entry = redoStack.pop();
    undoStack.push(snapshotRect(rtMain, entry.rect));
    restoreRect(entry);
    entry.rt.dispose();
    return true;
  }

  function replaceHeightData(heights) {
    const expected = HEIGHTMAP_SIZE * HEIGHTMAP_SIZE;
    if (heights.length !== expected) {
      throw new Error(`Expected ${expected} height samples, got ${heights.length}`);
    }

    const data = heights instanceof Float32Array ? heights : new Float32Array(heights);
    const tex = new THREE.DataTexture(
      data,
      HEIGHTMAP_SIZE,
      HEIGHTMAP_SIZE,
      THREE.RedFormat,
      THREE.FloatType,
    );
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;

    // Wrapped in a stroke so Generate / Load / carve commits are undoable
    // instead of silently wiping the history like the old implementation.
    beginStroke();
    blitFull(tex, rtMain);
    strokeRect = { ...FULL_RECT };
    endStroke();
    tex.dispose();
  }

  // ── Initial upload ────────────────────────────────────────────────────────
  {
    const initNode  = texture(initialDataTex);
    const uploadMat = new THREE.MeshBasicNodeMaterial();
    uploadMat.fragmentNode = Fn(() =>
      vec4(texture(initNode, uv()).r, float(0), float(0), float(1)),
    )();
    const q = new QuadMesh(uploadMat);
    _render(q, rtMain, null);
    uploadMat.dispose();
  }

  // Permanent binding — rtMain never changes identity, so consumers that grab
  // heightTexNode.value once (snow, ocean) stay valid forever.
  heightTexNode.value = rtMain.texture;

  return {
    paint,
    smooth,
    flatten,
    noise,
    terrace,
    smudge,
    contrast,
    thermal,
    ramp,
    beginStroke,
    endStroke,
    undo,
    redo,
    replaceHeightData,
    runGeneratorPass,
    maskNode,
    uMaskRotation,
    uBrushUV,
    uRadius,
    uStrength,
    uFalloff,
    uClampMin,
    uClampMax,
    uTerraceStep,
    uTerraceSharpness,
    uNoiseScale,
    uNoiseOctaves,
    uSmudgeDir,
    uFlattenTarget,
    uThermalSlope,
    uRampWidth,
    thermalConfig,
    getCurrentRT: () => rtMain,
  };
}
