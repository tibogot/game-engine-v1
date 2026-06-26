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
  cos,
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

export function createSculptBrush(renderer, initialDataTex, heightTexNode, initialMaskTex) {
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
  const uSmudgeDir        = uniform(new THREE.Vector2(0, 1)); // normalized stroke direction in UV space
  const uThermalSlope     = uniform(0.018); // thermal erosion talus threshold (~30° default)
  const uRampA            = uniform(new THREE.Vector2(0.3, 0.5));
  const uRampB            = uniform(new THREE.Vector2(0.7, 0.5));
  const uRampWidth        = uniform(0.02);  // ramp half-width in UV space
  const uMaskRotation     = uniform(0.0);   // brush mask rotation in radians

  // Ping-pong source node — .value is swapped per stroke.
  const srcNode = texture(rts[0].texture);

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
    const cosR     = cos(uMaskRotation);
    const sinR     = sin(uMaskRotation);
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
  raiseMat.colorNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;
    const falloff  = getBrushFalloff(uvCoord);
    const delta    = pow(falloff, uFalloff).mul(uStrength).mul(uDir).mul(edgeFade(uvCoord));
    return vec4(clamp(currentH.add(delta), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const raiseQuad = new QuadMesh(raiseMat);

  // ── Smooth brush ──────────────────────────────────────────────────────────
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

    const falloff  = getBrushFalloff(uvCoord);
    const blendAmt = clamp(pow(falloff, uFalloff).mul(uStrength).mul(float(20)).mul(edgeFade(uvCoord)), float(0), float(1));

    return vec4(clamp(mix(currentH, avg, blendAmt), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const smoothQuad = new QuadMesh(smoothMat);

  // ── Flatten brush ─────────────────────────────────────────────────────────
  const flattenMat = new THREE.MeshBasicNodeMaterial();
  flattenMat.colorNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;
    const targetH  = texture(srcNode, uBrushUV).r;

    const falloff  = getBrushFalloff(uvCoord);
    const blendAmt = clamp(pow(falloff, uFalloff).mul(uStrength).mul(float(20)).mul(edgeFade(uvCoord)), float(0), float(1));

    return vec4(clamp(mix(currentH, targetH, blendAmt), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const flattenQuad = new QuadMesh(flattenMat);

  // ── Noise brush (FBM) ─────────────────────────────────────────────────────
  const noiseMat = new THREE.MeshBasicNodeMaterial();
  noiseMat.colorNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;

    const freq = uNoiseScale.mul(float(HEIGHTMAP_SIZE));
    const sx   = uBrushUV.x.mul(float(973.1));
    const sy   = uBrushUV.y.mul(float(831.7));

    const px1 = uvCoord.x.mul(freq).add(sx);
    const py1 = uvCoord.y.mul(freq).add(sy);
    const r1  = fract(sin(px1.mul(float(127.1)).add(py1.mul(float(311.7)))).mul(float(43758.5453)));

    const px2 = uvCoord.x.mul(freq.mul(float(2))).add(sx.mul(float(1.7))).add(float(100));
    const py2 = uvCoord.y.mul(freq.mul(float(2))).add(sy.mul(float(1.3))).add(float(200));
    const r2  = fract(sin(px2.mul(float(127.1)).add(py2.mul(float(311.7)))).mul(float(43758.5453)));

    const px3 = uvCoord.x.mul(freq.mul(float(4))).add(sx.mul(float(2.3))).add(float(300));
    const py3 = uvCoord.y.mul(freq.mul(float(4))).add(sy.mul(float(1.9))).add(float(400));
    const r3  = fract(sin(px3.mul(float(127.1)).add(py3.mul(float(311.7)))).mul(float(43758.5453)));

    const px4 = uvCoord.x.mul(freq.mul(float(8))).add(sx.mul(float(0.7))).add(float(500));
    const py4 = uvCoord.y.mul(freq.mul(float(8))).add(sy.mul(float(2.7))).add(float(600));
    const r4  = fract(sin(px4.mul(float(127.1)).add(py4.mul(float(311.7)))).mul(float(43758.5453)));

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

    const noiseVal = raw.div(maxRaw).mul(float(2)).sub(float(1));
    const falloff  = getBrushFalloff(uvCoord);
    const delta    = pow(falloff, uFalloff).mul(noiseVal).mul(uStrength).mul(float(6)).mul(edgeFade(uvCoord));

    return vec4(clamp(currentH.add(delta), uClampMin, uClampMax), float(0), float(0), float(1));
  })();
  const noiseQuad = new QuadMesh(noiseMat);

  // ── Terrace brush ─────────────────────────────────────────────────────────
  const terraceMat = new THREE.MeshBasicNodeMaterial();
  terraceMat.colorNode = Fn(() => {
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
  plateauMat.colorNode = Fn(() => {
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
  craterMat.colorNode = Fn(() => {
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
  smudgeMat.colorNode = Fn(() => {
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
  contrastMat.colorNode = Fn(() => {
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
  thermalMat.colorNode = Fn(() => {
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
  rampMat.colorNode = Fn(() => {
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

  // ── GPU copy (undo / redo snapshots) ─────────────────────────────────────
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

  function smudge(brushUVx, brushUVy) {
    uBrushUV.value.set(brushUVx, brushUVy);
    _runPass(smudgeQuad);
  }

  function contrast(brushUVx, brushUVy) {
    uBrushUV.value.set(brushUVx, brushUVy);
    _runPass(contrastQuad);
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
    smudge,
    contrast,
    thermal,
    ramp,
    beginStroke,
    undo,
    redo,
    replaceHeightData,
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
    uThermalSlope,
    uRampWidth,
    thermalConfig,
    getCurrentRT: () => rts[readIdx],
  };
}
