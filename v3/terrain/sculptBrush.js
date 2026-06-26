import * as THREE from "three";
import { QuadMesh } from "three/webgpu";
import {
  Fn,
  float,
  vec2,
  vec4,
  min,
  max,
  mix,
  clamp,
  length,
  pow,
  floor,
  fract,
  sin,
  step,
  texture,
  uv,
  uniform,
} from "three/tsl";
import { HEIGHTMAP_SIZE } from "./heightmapTexture.js";

function makeHeightRT() {
  const rt = new THREE.RenderTarget(HEIGHTMAP_SIZE, HEIGHTMAP_SIZE, {
    format:          THREE.RGBAFormat,
    type:            THREE.HalfFloatType,
    minFilter:       THREE.LinearFilter,
    magFilter:       THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer:     false,
    colorSpace:      THREE.NoColorSpace,
  });
  rt.texture.flipY = false;
  return rt;
}

export function createSculptBrush(renderer, initialDataTex, heightTexNode) {
  const rts = [makeHeightRT(), makeHeightRT()];
  let readIdx = 0;

  // ── Upload CPU heightmap into rts[0] ──────────────────────────────────────
  {
    const initNode  = texture(initialDataTex);
    const uploadMat = new THREE.MeshBasicNodeMaterial();
    uploadMat.colorNode = Fn(() =>
      vec4(texture(initNode, uv()).r, float(0), float(0), float(1)),
    )();
    const q = new QuadMesh(uploadMat);
    renderer.setRenderTarget(rts[0]);
    q.render(renderer);
    renderer.setRenderTarget(null);
    uploadMat.dispose();
  }

  heightTexNode.value = rts[0].texture;

  // ── Shared brush uniforms ─────────────────────────────────────────────────
  const uBrushUV   = uniform(new THREE.Vector2(0.5, 0.5));
  const uRadius    = uniform(0.05);
  const uStrength  = uniform(0.004);
  const uFalloff   = uniform(2.0);   // exponent: 0.5 feathered → 4.0 hard edge
  const uDir       = uniform(1.0);   // +1 raise, -1 lower
  const uClampMin       = uniform(0.0);   // normalized minimum sculpt height
  const uClampMax       = uniform(2.0);   // normalized maximum (2.0 = off by default)
  const uTerraceStep      = uniform(0.04);  // terrace step height in normalized units (~20 m)
  const uTerraceSharpness = uniform(0.6);   // terrace blend sharpness: 0=soft, 1=hard snap
  const uNoiseScale       = uniform(0.5);   // noise frequency multiplier
  const uNoiseOctaves     = uniform(3.0);   // FBM octave count (1-4)
  const uThermalSlope     = uniform(0.018); // thermal erosion talus threshold (~30° default)
  const uRampA            = uniform(new THREE.Vector2(0.3, 0.5));
  const uRampB            = uniform(new THREE.Vector2(0.7, 0.5));
  const uRampWidth        = uniform(0.02);  // ramp half-width in UV space

  // Ping-pong source node — .value is swapped per stroke.
  const srcNode = texture(rts[0].texture);

  const texel = float(1.0 / HEIGHTMAP_SIZE);

  // ── Edge fade helper ──────────────────────────────────────────────────────
  // Returns 0.0 at the heightmap boundary, ramping to 1.0 over EDGE_BORDER texels.
  // Multiplied into every brush delta so sculpting near the edge can't create cliffs.
  const EDGE_BORDER = float(4.0 / HEIGHTMAP_SIZE);
  const edgeFade = Fn(([uvCoord]) => {
    const eu = min(uvCoord.x, float(1).sub(uvCoord.x));
    const ev = min(uvCoord.y, float(1).sub(uvCoord.y));
    return clamp(min(eu, ev).div(EDGE_BORDER), float(0), float(1));
  });

  // ── Raise / lower brush ───────────────────────────────────────────────────
  const raiseMat = new THREE.MeshBasicNodeMaterial();
  raiseMat.colorNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;
    const d        = length(uvCoord.sub(uBrushUV));
    const falloff  = max(float(0), float(1).sub(d.div(uRadius)));
    const delta    = pow(falloff, uFalloff).mul(uStrength).mul(uDir).mul(edgeFade(uvCoord));
    return vec4(clamp(currentH.add(delta), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const raiseQuad = new QuadMesh(raiseMat);

  // ── Smooth brush ──────────────────────────────────────────────────────────
  // Blends each texel toward its 4-neighbour average, weighted by the brush
  // falloff. Strength controls the lerp amount per frame.
  const smoothMat = new THREE.MeshBasicNodeMaterial();
  smoothMat.colorNode = Fn(() => {
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

    const d       = length(uvCoord.sub(uBrushUV));
    const falloff = max(float(0), float(1).sub(d.div(uRadius)));
    // uStrength * 20 maps the [0.001..0.05] raise range to [0.02..1.0] smooth range.
    const blendAmt = clamp(pow(falloff, uFalloff).mul(uStrength).mul(float(20)).mul(edgeFade(uvCoord)), float(0), float(1));

    return vec4(clamp(mix(currentH, avg, blendAmt), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const smoothQuad = new QuadMesh(smoothMat);

  // ── Flatten brush ───────────────────────────────────────────────────────────
  // Lerp toward height at brush center (v2: flatten to stroke-start sample).
  const flattenMat = new THREE.MeshBasicNodeMaterial();
  flattenMat.colorNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;
    const targetH  = texture(srcNode, uBrushUV).r;

    const d       = length(uvCoord.sub(uBrushUV));
    const falloff = max(float(0), float(1).sub(d.div(uRadius)));
    const blendAmt = clamp(pow(falloff, uFalloff).mul(uStrength).mul(float(20)).mul(edgeFade(uvCoord)), float(0), float(1));

    return vec4(clamp(mix(currentH, targetH, blendAmt), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const flattenQuad = new QuadMesh(flattenMat);

  // ── Noise brush (FBM) ────────────────────────────────────────────────────────
  // 4-octave fractal Brownian motion. uNoiseOctaves gates contributions with step()
  // so runtime octave count changes without recompiling. Each octave doubles the
  // frequency and halves the amplitude; the sum is normalized to [-1,1].
  const noiseMat = new THREE.MeshBasicNodeMaterial();
  noiseMat.colorNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;

    const freq = uNoiseScale.mul(float(HEIGHTMAP_SIZE));
    const sx   = uBrushUV.x.mul(float(973.1));
    const sy   = uBrushUV.y.mul(float(831.7));

    // Octave 1 — base frequency
    const px1 = uvCoord.x.mul(freq).add(sx);
    const py1 = uvCoord.y.mul(freq).add(sy);
    const r1  = fract(sin(px1.mul(float(127.1)).add(py1.mul(float(311.7)))).mul(float(43758.5453)));

    // Octave 2 — ×2 freq, different seed offset to break correlation
    const px2 = uvCoord.x.mul(freq.mul(float(2))).add(sx.mul(float(1.7))).add(float(100));
    const py2 = uvCoord.y.mul(freq.mul(float(2))).add(sy.mul(float(1.3))).add(float(200));
    const r2  = fract(sin(px2.mul(float(127.1)).add(py2.mul(float(311.7)))).mul(float(43758.5453)));

    // Octave 3 — ×4 freq
    const px3 = uvCoord.x.mul(freq.mul(float(4))).add(sx.mul(float(2.3))).add(float(300));
    const py3 = uvCoord.y.mul(freq.mul(float(4))).add(sy.mul(float(1.9))).add(float(400));
    const r3  = fract(sin(px3.mul(float(127.1)).add(py3.mul(float(311.7)))).mul(float(43758.5453)));

    // Octave 4 — ×8 freq
    const px4 = uvCoord.x.mul(freq.mul(float(8))).add(sx.mul(float(0.7))).add(float(500));
    const py4 = uvCoord.y.mul(freq.mul(float(8))).add(sy.mul(float(2.7))).add(float(600));
    const r4  = fract(sin(px4.mul(float(127.1)).add(py4.mul(float(311.7)))).mul(float(43758.5453)));

    // Gate higher octaves with step() — step(edge, x) = 0 if x<edge else 1
    const use2 = step(float(1.5), uNoiseOctaves);
    const use3 = step(float(2.5), uNoiseOctaves);
    const use4 = step(float(3.5), uNoiseOctaves);

    const raw    = r1.mul(float(0.5))
      .add(r2.mul(float(0.25)).mul(use2))
      .add(r3.mul(float(0.125)).mul(use3))
      .add(r4.mul(float(0.0625)).mul(use4));
    const maxRaw = float(0.5)
      .add(float(0.25).mul(use2))
      .add(float(0.125).mul(use3))
      .add(float(0.0625).mul(use4));

    // Normalize to [-1, 1] regardless of active octave count, then scale
    const noiseVal = raw.div(maxRaw).mul(float(2)).sub(float(1));
    const d        = length(uvCoord.sub(uBrushUV));
    const falloff  = max(float(0), float(1).sub(d.div(uRadius)));
    const delta    = pow(falloff, uFalloff).mul(noiseVal).mul(uStrength).mul(float(6)).mul(edgeFade(uvCoord));

    return vec4(clamp(currentH.add(delta), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const noiseQuad = new QuadMesh(noiseMat);

  // ── Terrace brush ─────────────────────────────────────────────────────────────
  // Snaps height to discrete steps (uTerraceStep) within the brush area.
  // uTerraceSharpness controls how hard the snap is (0=soft blend, 1=instant).
  const terraceMat = new THREE.MeshBasicNodeMaterial();
  terraceMat.colorNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;

    const stepped  = floor(currentH.div(uTerraceStep)).add(float(0.5)).mul(uTerraceStep);

    const d        = length(uvCoord.sub(uBrushUV));
    const falloff  = max(float(0), float(1).sub(d.div(uRadius)));
    const blendAmt = clamp(pow(falloff, uFalloff).mul(uTerraceSharpness).mul(float(8)).mul(edgeFade(uvCoord)), float(0), float(1));

    return vec4(clamp(mix(currentH, stepped, blendAmt), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const terraceQuad = new QuadMesh(terraceMat);

  // ── Plateau brush ─────────────────────────────────────────────────────────────
  // Flat top across the inner 50% of the brush radius; drops off at the outer 50%.
  const plateauMat = new THREE.MeshBasicNodeMaterial();
  plateauMat.colorNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;
    const d        = length(uvCoord.sub(uBrushUV));
    const t        = clamp(d.div(uRadius), float(0), float(1));
    const tOuter   = clamp(t.sub(float(0.5)).div(float(0.5)), float(0), float(1));
    const plateauFalloff = float(1).sub(pow(tOuter, uFalloff));
    const delta    = plateauFalloff.mul(uStrength).mul(uDir).mul(edgeFade(uvCoord));
    return vec4(clamp(currentH.add(delta), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const plateauQuad = new QuadMesh(plateauMat);

  // ── Crater brush ──────────────────────────────────────────────────────────────
  // Depression at center with a small rim at ~70% radius; tapers to zero at edge.
  // Formula: (2t²−1)·(1−t)^0.5 → negative at center, positive rim, zero at boundary.
  const craterMat = new THREE.MeshBasicNodeMaterial();
  craterMat.colorNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;
    const d        = length(uvCoord.sub(uBrushUV));
    const t        = clamp(d.div(uRadius), float(0), float(1));
    const craterProfile = t.mul(t).mul(float(2)).sub(float(1))
      .mul(pow(max(float(0), float(1).sub(t)), float(0.5)));
    const delta    = craterProfile.mul(uStrength).mul(float(5)).mul(uDir).mul(edgeFade(uvCoord));
    return vec4(clamp(currentH.add(delta), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const craterQuad = new QuadMesh(craterMat);

  // ── Thermal erosion brush ────────────────────────────────────────────────────
  // Each pass: pixels steeper than uThermalSlope shed material to lower neighbors
  // and gain material from steeper neighbors. Mass-approximate single-pass version —
  // not perfectly conservative but visually accurate for sculpting purposes.
  // Run multiple iterations per dab (thermalConfig.iterations) for visible effect.
  const thermalMat = new THREE.MeshBasicNodeMaterial();
  thermalMat.colorNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;

    const hL = texture(srcNode, vec2(uvCoord.x.sub(texel), uvCoord.y)).r;
    const hR = texture(srcNode, vec2(uvCoord.x.add(texel), uvCoord.y)).r;
    const hD = texture(srcNode, vec2(uvCoord.x, uvCoord.y.sub(texel))).r;
    const hU = texture(srcNode, vec2(uvCoord.x, uvCoord.y.add(texel))).r;

    // Material shed to lower neighbors (loss) and received from higher ones (gain)
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

    const d       = length(uvCoord.sub(uBrushUV));
    const falloff = max(float(0), float(1).sub(d.div(uRadius)));
    const brushAmt = pow(falloff, uFalloff).mul(edgeFade(uvCoord));

    return vec4(clamp(currentH.add(totalDelta.mul(brushAmt)), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const thermalQuad = new QuadMesh(thermalMat);

  // ── Ramp brush ────────────────────────────────────────────────────────────────
  // Blends terrain toward a straight slope from uRampA to uRampB. Applied once
  // on second click (not a drag stroke). uFalloff controls lateral blend hardness.
  const rampMat = new THREE.MeshBasicNodeMaterial();
  rampMat.colorNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;

    // Sample height at both endpoints from the current terrain
    const hA = texture(srcNode, uRampA).r;
    const hB = texture(srcNode, uRampB).r;

    // Project uvCoord onto A→B segment; manual dot product (no dot() import needed)
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

  // ── GPU copy (undo / redo snapshots) ────────────────────────────────────────
  const copyMat = new THREE.MeshBasicNodeMaterial();
  copyMat.colorNode = Fn(() =>
    vec4(texture(srcNode, uv()).r, float(0), float(0), float(1)),
  )();
  const copyQuad = new QuadMesh(copyMat);

  const MAX_HISTORY = 25;
  const undoStack   = [];
  const redoStack   = [];

  function blitToRT(srcTexture, dstRT) {
    srcNode.value = srcTexture;
    renderer.setRenderTarget(dstRT);
    copyQuad.render(renderer);
    renderer.setRenderTarget(null);
  }

  function cloneCurrentHeight() {
    const rt = makeHeightRT();
    blitToRT(rts[readIdx].texture, rt);
    return rt;
  }

  function restoreFrom(snapshotRT) {
    blitToRT(snapshotRT.texture, rts[readIdx]);
    heightTexNode.value = rts[readIdx].texture;
  }

  function trimStack(stack) {
    while (stack.length >= MAX_HISTORY) stack.shift().dispose();
  }

  function disposeStack(stack) {
    for (const rt of stack) rt.dispose();
    stack.length = 0;
  }

  // ── Internal ping-pong step ───────────────────────────────────────────────
  function _runPass(quad) {
    const writeIdx = 1 - readIdx;
    srcNode.value = rts[readIdx].texture;

    renderer.setRenderTarget(rts[writeIdx]);
    quad.render(renderer);
    renderer.setRenderTarget(null);

    readIdx = writeIdx;
    heightTexNode.value = rts[readIdx].texture;
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function paint(brushUVx, brushUVy, direction, stamp = "smooth") {
    uBrushUV.value.set(brushUVx, brushUVy);
    uDir.value = direction;
    if      (stamp === "plateau") _runPass(plateauQuad);
    else if (stamp === "crater")  _runPass(craterQuad);
    else                          _runPass(raiseQuad);
  }

  function smooth(brushUVx, brushUVy) {
    uBrushUV.value.set(brushUVx, brushUVy);
    _runPass(smoothQuad);
  }

  function flatten(brushUVx, brushUVy) {
    uBrushUV.value.set(brushUVx, brushUVy);
    _runPass(flattenQuad);
  }

  function noise(brushUVx, brushUVy) {
    uBrushUV.value.set(brushUVx, brushUVy);
    _runPass(noiseQuad);
  }

  function terrace(brushUVx, brushUVy) {
    uBrushUV.value.set(brushUVx, brushUVy);
    _runPass(terraceQuad);
  }

  const thermalConfig = { iterations: 5 };

  function thermal(brushUVx, brushUVy) {
    uBrushUV.value.set(brushUVx, brushUVy);
    for (let i = 0; i < thermalConfig.iterations; i++) _runPass(thermalQuad);
  }

  function ramp(aUV, bUV) {
    uRampA.value.set(aUV.u, aUV.v);
    uRampB.value.set(bUV.u, bUV.v);
    _runPass(rampQuad);
  }

  /** Push a GPU snapshot before the first dab of a stroke (one undo step per drag). */
  function beginStroke() {
    disposeStack(redoStack);
    trimStack(undoStack);
    undoStack.push(cloneCurrentHeight());
  }

  function undo() {
    if (undoStack.length === 0) return false;
    trimStack(redoStack);
    redoStack.push(cloneCurrentHeight());
    const prev = undoStack.pop();
    restoreFrom(prev);
    prev.dispose();
    return true;
  }

  function redo() {
    if (redoStack.length === 0) return false;
    trimStack(undoStack);
    undoStack.push(cloneCurrentHeight());
    const next = redoStack.pop();
    restoreFrom(next);
    next.dispose();
    return true;
  }

  /** Replace both ping-pong RTs from normalized height samples; clears undo history. */
  function replaceHeightData(heights) {
    const expected = HEIGHTMAP_SIZE * HEIGHTMAP_SIZE;
    if (heights.length !== expected) {
      throw new Error(`Expected ${expected} height samples, got ${heights.length}`);
    }

    disposeStack(undoStack);
    disposeStack(redoStack);

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

    blitToRT(tex, rts[0]);
    blitToRT(tex, rts[1]);
    readIdx = 0;
    heightTexNode.value = rts[0].texture;
    tex.dispose();
  }

  return {
    paint,
    smooth,
    flatten,
    noise,
    terrace,
    thermal,
    ramp,
    beginStroke,
    undo,
    redo,
    replaceHeightData,
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
    uThermalSlope,
    uRampWidth,
    thermalConfig,
    getCurrentRT: () => rts[readIdx],
  };
}
