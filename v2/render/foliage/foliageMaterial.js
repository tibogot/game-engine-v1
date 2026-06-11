/**
 * TSL foliage material for v2 — sphere normals, wind, SSS, rim, AO.
 * One material per tree preset (each has its own leaf texture + colors).
 */
import * as THREE from "three";
import {
  Fn, float, vec2, vec3, vec4,
  uniform, attribute,
  texture, uv,
  mix, step, smoothstep, clamp, fract,
  sin, cos, abs, max, pow, dot, cross, normalize, length, sub, negate,
  positionLocal, positionWorld,
  normalLocal, normalWorld,
  cameraPosition, modelWorldMatrix,
} from "three/tsl";
import { MeshStandardNodeMaterial } from "three";

export function createFoliageMaterial(opts = {}) {
  const u = {
    time:         uniform(0.0),
    yMin:         uniform(opts.yMin ?? 0.0),
    yMax:         uniform(opts.yMax ?? 8.0),
    bottomColor:  uniform(new THREE.Color(opts.bottomColor ?? "#2d5a1b")),
    topColor:     uniform(new THREE.Color(opts.topColor ?? "#5aaa2a")),
    colorVar:     uniform(opts.colorVar ?? 0.12),
    alphaCutoff:  uniform(opts.alphaCutoff ?? 0.45),
    sssColor:     uniform(new THREE.Color(opts.sssColor ?? "#c8e070")),
    sssStr:       uniform(opts.sssStr ?? 0.0),
    sssPow:       uniform(opts.sssPow ?? 2.0),
    rimColor:     uniform(new THREE.Color(opts.rimColor ?? "#c8ffaa")),
    rimStr:       uniform(opts.rimStr ?? 0.07),
    rimPow:       uniform(opts.rimPow ?? 2.5),
    aoStr:        uniform(opts.aoStr ?? 0.70),
    sunDir:       uniform(new THREE.Vector3(5, 12, 4).normalize()),
    windSpeed:    uniform(opts.windSpeed ?? 0.9),
    windStr:      uniform(opts.windStr ?? 0.0),
    windMicro:    uniform(opts.windMicro ?? 0.0),
    canopyCenter: uniform(new THREE.Vector3(0, 4, 0)),
    aoRadius:     uniform(opts.aoRadius ?? 6.0),
    normalBias:   uniform(opts.normalBias ?? 1.0),
    leafWarp:     uniform(opts.leafWarp ?? 0.28),
    treeColorVar: uniform(opts.treeColorVar ?? 0.0),
    // 0 -> sample mask from .r (grayscale/RGB PNGs), 1 -> .a (RGBA PNGs).
    // setFoliageTexture() auto-detects and writes this on load.
    maskInAlpha:  uniform(0.0),
    // Billboard mode: 0 = use baked per-leaf rotation/scale (instance matrix),
    // 1 = camera-facing quad with size driven by aLeafScale.
    // Must match how the renderer composed the instance matrices for this preset.
    billboard:    uniform(opts.billboard ? 1.0 : 0.0),
    billboardYaw: uniform(opts.billboardYawOnly === false ? 0.0 : 1.0),
  };

  const leafTex = new THREE.Texture();
  const leafMapNode = texture(leafTex);
  // Selects mask channel based on the loaded texture's format.
  const leafMaskCh = mix(leafMapNode.r, leafMapNode.a, u.maskInAlpha);

  const aRand = attribute("aRand", "vec2");
  // Per-instance leaf center (world space — written by the chunked renderer).
  const aLeafCenter = attribute("aLeafCenter", "vec3");
  const instanceCenterW = modelWorldMatrix.mul(vec4(aLeafCenter, 1)).xyz;
  // Per-instance tree canopy center (world space). Every leaf of one tree
  // shares this value; trees in different world positions get different ones.
  // Replaces the old u.canopyCenter (which was trunk-local and shared across
  // every tree of the slot — wrong once trees are placed away from origin).
  const aTreeCenter = attribute("aTreeCenter", "vec3");
  const treeCenterW = modelWorldMatrix.mul(vec4(aTreeCenter, 1)).xyz;
  // Per-leaf size; only consulted in billboard mode (instance matrices are
  // pure translation there, so the size lives on the attribute instead).
  const aLeafScale = attribute("aLeafScale", "float");

  const positionNode = Fn(() => {
    const phase     = aRand.x.mul(6.2832);
    const tipFactor = positionLocal.y.add(0.5);
    const sway      = sin(u.time.mul(u.windSpeed).add(phase)).mul(u.windStr).mul(tipFactor);
    const micro     = sin(u.time.mul(3.1).add(phase.mul(2.6))).mul(u.windMicro).mul(tipFactor);
    const swayZ     = cos(u.time.mul(u.windSpeed.mul(0.8)).add(phase.mul(1.3))).mul(u.windStr.mul(0.5)).mul(tipFactor);
    // World-space wind delta (must NOT be projected into the camera basis or
    // it appears to rotate with the view).
    const wo = vec3(sway.add(micro), float(0), swayZ);

    // Camera basis around the per-instance leaf world center.
    const pivotW = instanceCenterW;
    const toCam = normalize(sub(cameraPosition, pivotW));
    const horiz = vec3(toCam.x, float(0), toCam.z);
    const hLen = length(horiz);
    const useH = step(float(0.0001), hLen);
    const yawDir = normalize(
      normalize(horiz).mul(useH).add(vec3(0, 0, float(1)).mul(float(1).sub(useH)))
    );
    const face = normalize(mix(toCam, yawDir, u.billboardYaw));
    const worldUp = vec3(0, 1, 0);
    // NaN-safe basis: pick non-degenerate cross BEFORE normalizing.
    const cA = cross(worldUp, face);
    const cB = cross(vec3(-1, 0, 0), face);
    const right = normalize(mix(cA, cB, step(float(0.99), abs(face.y))));
    const upv = normalize(cross(face, right));
    // Per-leaf 2D rotation of the camera-aligned quad around the face axis.
    // Breaks the "all billboards point the same way" tell. Uses aRand.x —
    // matches arborist exactly so the same preset produces the same texture
    // orientations in both editors.
    const ang = aRand.x.mul(6.2831853);
    const cosA = cos(ang);
    const sinA = sin(ang);
    const rRight = right.mul(cosA).add(upv.mul(sinA));
    const rUp = upv.mul(cosA).sub(right.mul(sinA));

    // Camera-aligned quad from positionLocal; size comes from aLeafScale
    // (in billboard mode, instance matrices are pure translation so size
    // is NOT baked into the matrix).
    const bbQuad = rRight.mul(positionLocal.x.mul(aLeafScale))
      .add(rUp.mul(positionLocal.y.mul(aLeafScale)));
    // World-space wind, scaled with leaf size.
    const windWorld = wo.mul(aLeafScale);
    const bb3 = bbQuad.add(windWorld);

    // Non-billboard branch: keep wind in local space (existing v2 behavior).
    const localWindy = positionLocal.add(wo);
    return mix(localWindy, bb3, u.billboard);
  })();

  // Stylized foliage lighting: every leaf uses world-up as its normal so the
  // entire canopy lights as one uniform "puff." Per-leaf sphereDir variation
  // produces visible per-leaf shading noise that swings as the camera orbits.
  // Uniform world-up gives a stable, angle-independent appearance; shape
  // comes from AO and the height gradient.
  const sphereDir = vec3(0, 1, 0);
  // SSS uses the per-leaf outward direction (not the uniform sphereDir) so
  // backlit leaves on the anti-sun hemisphere still glow with the SSS color.
  // Kept separate so Lambert stays uniform but SSS gives the stylized highlight.
  const sphereDirForSSS = normalize(instanceCenterW.sub(treeCenterW));
  // Non-billboard normal: local quad normal warped by UV (gives leaves a fake curvature).
  const warpedNormal = normalize(normalLocal.add(sin(uv().x.mul(10)).mul(u.leafWarp)));
  // Billboard normal: camera-facing (or yaw-facing) direction at the leaf's pivot.
  // Without this branch, billboarded leaves render with the UV-stripe warp from
  // warpedNormal — that's where the vertical "banding" gradient on the canopy comes from.
  const leafBillboardFace = Fn(() => {
    const pivotW = instanceCenterW;
    const toCam = normalize(sub(cameraPosition, pivotW));
    const horiz = vec3(toCam.x, float(0), toCam.z);
    const hLen = length(horiz);
    const useH = step(float(0.0001), hLen);
    const yawDir = normalize(
      normalize(horiz).mul(useH).add(vec3(0, 0, float(1)).mul(float(1).sub(useH)))
    );
    return normalize(mix(toCam, yawDir, u.billboardYaw));
  })();
  const geomForMix  = normalize(mix(warpedNormal, leafBillboardFace, u.billboard));
  const finalNormal = normalize(mix(geomForMix, sphereDir, u.normalBias));

  const colorNode = Fn(() => {
    const h1 = aRand.x;
    const h2 = aRand.y;
    const heightFactor = clamp(
      positionWorld.y.sub(u.yMin).div(max(u.yMax.sub(u.yMin), float(0.001))),
      float(0), float(1)
    );
    let col = mix(u.bottomColor, u.topColor, heightFactor);
    const varMul = h1.mul(u.colorVar.mul(2.0)).add(float(1.0).sub(u.colorVar));
    col = col.mul(varMul);
    const hueShift = h2.sub(0.5).mul(u.colorVar.mul(0.4));
    col = vec3(col.x.add(hueShift.mul(0.3)), col.y, col.z.sub(hueShift.mul(0.2)));

    const treeOrigin = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
    const treeSeed = fract(sin(dot(treeOrigin.xz, vec2(127.1, 311.7))).mul(43758.5453));
    const treeBright = treeSeed.sub(0.5).mul(u.treeColorVar);
    const treeHue = fract(sin(treeSeed.mul(78.233)).mul(43758.5453)).sub(0.5).mul(u.treeColorVar.mul(0.6));
    col = vec3(
      col.x.add(treeHue.mul(0.4)).add(treeBright),
      col.y.add(treeBright),
      col.z.sub(treeHue.mul(0.3)).add(treeBright)
    );

    const aoHeight = mix(float(1.0).sub(u.aoStr), float(1.0), heightFactor.mul(0.8).add(0.2));
    col = col.mul(aoHeight);

    const distC = clamp(length(sub(positionWorld, treeCenterW)).div(max(u.aoRadius, float(0.001))), float(0), float(1));
    const aoSphere = mix(float(1.0).sub(u.aoStr), float(1.0), distC);
    col = col.mul(aoSphere);

    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const n = normalWorld;
    // SSS uses per-leaf sphere direction so backlit anti-sun leaves glow,
    // while Lambert (via normalWorld = uniform world-up) stays stable.
    const backDot = max(dot(negate(u.sunDir), sphereDirForSSS), float(0));
    const sss = pow(backDot, u.sssPow).mul(u.sssStr);
    col = col.add(u.sssColor.mul(sss));

    // Rim uses per-leaf sphere direction so it activates on leaves whose
    // outward direction is perpendicular to view — i.e. the canopy silhouette
    // from any camera angle, regardless of normalBias.
    const rimDot = float(1.0).sub(max(dot(sphereDirForSSS, viewDir), float(0)));
    const rim = pow(rimDot, u.rimPow).mul(u.rimStr);
    col = col.add(u.rimColor.mul(rim));

    return clamp(col, float(0), float(2));
  })();

  const opacityNode = Fn(() => {
    const camDist = length(cameraPosition.sub(positionWorld));
    const distFade = clamp(camDist.div(float(150.0)), float(0), float(1));
    const adaptiveCutoff = mix(u.alphaCutoff, float(0.15), distFade);
    return smoothstep(adaptiveCutoff.sub(0.05), adaptiveCutoff.add(0.05), leafMaskCh);
  })();

  const mat = new MeshStandardNodeMaterial({
    side:        THREE.DoubleSide,
    transparent: false,
    alphaTest:   0.3,
    roughness:   0.88,
    metalness:   0.0,
    depthWrite:  true,
  });
  mat.positionNode = positionNode;
  mat.normalNode   = finalNormal;
  mat.colorNode    = colorNode;
  mat.opacityNode  = opacityNode;
  mat.envMapIntensity = 0;

  mat.castShadowNode = Fn(() => {
    // Match the visible pass: same channel select and same alphaTest threshold (0.3),
    // so the shadow silhouette aligns with the leaf silhouette.
    const a = smoothstep(u.alphaCutoff.sub(0.05), u.alphaCutoff.add(0.05), leafMaskCh);
    a.lessThan(float(0.3)).discard();
    return vec4(0, 0, 0, 1);
  })();

  return { material: mat, uniforms: u, leafMapNode };
}

// Detects whether an image's alpha channel carries meaningful (<255) data.
// PNGs with the mask in the alpha channel (e.g. RGBA leaves) return true;
// grayscale or RGB-only PNGs return false.
export function detectAlphaChannel(image) {
  try {
    const w = image.width || image.naturalWidth;
    const h = image.height || image.naturalHeight;
    if (!w || !h) return false;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 16) {
      if (data[i] < 255) return true;
    }
    return false;
  } catch (_) {
    // Cross-origin tainted canvas etc. — fall back to red-channel.
    return false;
  }
}

export function setFoliageTexture(foliageMat, tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  foliageMat.leafMapNode.value = tex;
  // Auto-select mask channel based on the loaded texture's format.
  if (tex.image && foliageMat.uniforms && foliageMat.uniforms.maskInAlpha) {
    foliageMat.uniforms.maskInAlpha.value = detectAlphaChannel(tex.image) ? 1.0 : 0.0;
  }
}

export function applyPresetMaterial(foliageMat, preset) {
  const u = foliageMat.uniforms;
  const m = preset.material || {};
  const w = preset.wind || {};

  if (m.bottomColor) u.bottomColor.value.set(m.bottomColor);
  if (m.topColor)    u.topColor.value.set(m.topColor);
  if (m.colorVar != null)    u.colorVar.value    = m.colorVar;
  if (m.treeColorVar != null) u.treeColorVar.value = m.treeColorVar;
  if (m.alphaCutoff != null) u.alphaCutoff.value  = m.alphaCutoff;
  if (m.roughness != null)   foliageMat.material.roughness = m.roughness;
  if (m.sssColor)            u.sssColor.value.set(m.sssColor);
  if (m.sssStr != null)      u.sssStr.value       = m.sssStr;
  if (m.sssPow != null)      u.sssPow.value       = m.sssPow;
  if (m.rimColor)            u.rimColor.value.set(m.rimColor);
  if (m.rimStr != null)      u.rimStr.value        = m.rimStr;
  if (m.rimPow != null)      u.rimPow.value        = m.rimPow;
  if (m.aoStr != null)       u.aoStr.value         = m.aoStr;
  if (m.normalBias != null)  u.normalBias.value    = m.normalBias;
  if (m.leafWarp != null)    u.leafWarp.value      = m.leafWarp;
  // Billboard mode (matches arborist preview).
  if (m.billboardLeaves != null)  u.billboard.value    = m.billboardLeaves ? 1.0 : 0.0;
  if (m.billboardYawOnly != null) u.billboardYaw.value = m.billboardYawOnly ? 1.0 : 0.0;

  if (w.windSpeed != null) u.windSpeed.value = w.windSpeed;
  if (w.windStr != null)   u.windStr.value   = w.windStr;
  if (w.windMicro != null) u.windMicro.value = w.windMicro;
}

export function updateFoliageBounds(foliageMat, yMin, yMax, canopyCenter, aoRadius) {
  const u = foliageMat.uniforms;
  u.yMin.value = yMin;
  u.yMax.value = yMax;
  u.canopyCenter.value.copy(canopyCenter);
  u.aoRadius.value = aoRadius;
}
