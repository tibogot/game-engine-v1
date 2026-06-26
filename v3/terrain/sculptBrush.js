import * as THREE from "three";
import { QuadMesh } from "three/webgpu";
import {
  Fn,
  float,
  vec2,
  vec4,
  max,
  mix,
  clamp,
  length,
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
  const uBrushUV  = uniform(new THREE.Vector2(0.5, 0.5));
  const uRadius   = uniform(0.05);
  const uStrength = uniform(0.004);
  const uDir      = uniform(1.0);   // +1 raise, -1 lower

  // Ping-pong source node — .value is swapped per stroke.
  const srcNode = texture(rts[0].texture);

  const texel = float(1.0 / HEIGHTMAP_SIZE);

  // ── Raise / lower brush ───────────────────────────────────────────────────
  const raiseMat = new THREE.MeshBasicNodeMaterial();
  raiseMat.colorNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;
    const d        = length(uvCoord.sub(uBrushUV));
    const falloff  = max(float(0), float(1).sub(d.div(uRadius)));
    const delta    = falloff.mul(falloff).mul(uStrength).mul(uDir);
    // No upper clamp — allow mountains taller than MAX_HEIGHT by storing > 1.0.
    return vec4(max(currentH.add(delta), float(0)), float(0), float(0), float(1));
  })();
  const raiseQuad = new QuadMesh(raiseMat);

  // ── Smooth brush ──────────────────────────────────────────────────────────
  // Blends each texel toward its 4-neighbour average, weighted by the brush
  // falloff. Strength controls the lerp amount per frame.
  const smoothMat = new THREE.MeshBasicNodeMaterial();
  smoothMat.colorNode = Fn(() => {
    const uvCoord  = uv();
    const currentH = texture(srcNode, uvCoord).r;

    const hL = texture(srcNode, vec2(uvCoord.x.sub(texel), uvCoord.y)).r;
    const hR = texture(srcNode, vec2(uvCoord.x.add(texel), uvCoord.y)).r;
    const hD = texture(srcNode, vec2(uvCoord.x, uvCoord.y.sub(texel))).r;
    const hU = texture(srcNode, vec2(uvCoord.x, uvCoord.y.add(texel))).r;
    const avg = hL.add(hR).add(hD).add(hU).mul(0.25);

    const d       = length(uvCoord.sub(uBrushUV));
    const falloff = max(float(0), float(1).sub(d.div(uRadius)));
    // uStrength * 20 maps the [0.001..0.05] raise range to [0.02..1.0] smooth range.
    const blendAmt = clamp(falloff.mul(uStrength).mul(float(20)), float(0), float(1));

    return vec4(max(mix(currentH, avg, blendAmt), float(0)), float(0), float(0), float(1));
  })();
  const smoothQuad = new QuadMesh(smoothMat);

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
  function paint(brushUVx, brushUVy, direction) {
    uBrushUV.value.set(brushUVx, brushUVy);
    uDir.value = direction;
    _runPass(raiseQuad);
  }

  function smooth(brushUVx, brushUVy) {
    uBrushUV.value.set(brushUVx, brushUVy);
    _runPass(smoothQuad);
  }

  return { paint, smooth, uBrushUV, uRadius, uStrength, getCurrentRT: () => rts[readIdx] };
}
