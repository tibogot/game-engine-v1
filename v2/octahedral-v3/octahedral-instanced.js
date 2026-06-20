/**
 * Instanced forest impostor material — v3 sampling + per-tree LOD crossfade.
 */
import * as THREE from "three";
import {
  Fn,
  If,
  normalize,
  sub,
  mul,
  add,
  div,
  abs,
  vec2,
  vec3,
  vec4,
  sign,
  dot,
  cross,
  floor,
  fract,
  min,
  max,
  clamp,
  saturate,
  texture,
  cameraPosition,
  positionWorld,
  positionLocal,
  float,
  uniform,
  varying,
  select,
  length,
  negate,
  mix,
  smoothstep,
  fwidth,
  pow,
  sin,
  cos,
  viewportCoordinate,
  instanceIndex,
  screenCoordinate,
} from "three/tsl";

export function createInstancedImpostorMaterials(textures, opts) {
  const { colorTex, normalTex, rmTex, depthTex } = textures;
  const {
    impostorScale,
    gridVal,
    atlasSize,
    cellPad,
    fullOctahedral = false,
    centersStorage,
    lodDistUniform,
    fadeRangeUniform,
    lodDitherUniform,
  } = opts;

  if (!centersStorage) {
    throw new Error(
      "[octahedral-core] centersStorage required for instanced impostor",
    );
  }

  const centerNode = centersStorage.element(instanceIndex).xyz;

  const uSPS = uniform(float(gridVal));
  const uScale = uniform(float(impostorScale));
  const uTime = uniform(float(0));

  const uNormStr = uniform(float(1.0));
  const uAlphaCutoff = uniform(float(0.5));
  const uEdgeSmooth = uniform(float(1.5));
  const uParallaxStr = uniform(float(0.0));

  const uUseBary = uniform(float(0));
  const uNormRmBary = uniform(float(0));
  const uUseParallax = uniform(float(0));
  const uUseDither = uniform(float(0));

  const uWindAmp = uniform(float(0));
  const uWindFreq = uniform(float(1.5));

  const uTransAmt = uniform(float(0));
  const uTransPow = uniform(float(3.0));
  const uTransTint = uniform(new THREE.Vector3(0.9, 1.0, 0.7));
  const uSunDir = uniform(new THREE.Vector3(0.5, 0.7, 0.5).normalize());
  const uSunColor = uniform(new THREE.Vector3(1, 1, 1));

  const uCellFrac = uniform(float(1 / gridVal));
  const uPadFrac = uniform(float(cellPad / atlasSize));
  const uInnerFrac = uniform(float(1 / gridVal - (2 * cellPad) / atlasSize));

  const uLodDist = lodDistUniform ?? uniform(float(80));
  const uFadeRange = fadeRangeUniform ?? uniform(float(8));
  const uLodDither = lodDitherUniform ?? uniform(float(0));

  const vWeight = varying(vec4(0, 0, 0, 0), "vW");
  const vS1 = varying(vec2(0, 0), "vS1");
  const vS2 = varying(vec2(0, 0), "vS2");
  const vS3 = varying(vec2(0, 0), "vS3");
  const vUV1 = varying(vec2(0, 0), "vUV1");
  const vUV2 = varying(vec2(0, 0), "vUV2");
  const vUV3 = varying(vec2(0, 0), "vUV3");

  const encode = fullOctahedral
    ? Fn(([d]) => {
        const l1 = add(add(abs(d.x), abs(d.y)), abs(d.z));
        const ox = div(d.x, l1);
        const oz = div(d.z, l1);
        const wrapX = mul(sub(float(1), abs(oz)), sign(d.x));
        const wrapZ = mul(sub(float(1), abs(ox)), sign(d.z));
        const isLower = d.y.lessThan(float(0));
        const uvX = select(isLower, wrapX, ox);
        const uvZ = select(isLower, wrapZ, oz);
        return mul(add(vec2(uvX, uvZ), float(1)), float(0.5));
      })
    : Fn(([d]) => {
        const s = vec3(sign(d.x), sign(d.y), sign(d.z));
        const l1 = dot(d, s);
        const o = vec3(div(d.x, l1), div(d.y, l1), div(d.z, l1));
        return mul(vec2(add(1, add(o.x, o.z)), add(1, sub(o.z, o.x))), 0.5);
      });

  const decode = fullOctahedral
    ? Fn(([gi, nm1]) => {
        const u = vec2(div(gi.x, nm1.x), div(gi.y, nm1.y));
        const ox = sub(mul(u.x, float(2)), float(1));
        const oz = sub(mul(u.y, float(2)), float(1));
        const oy = sub(sub(float(1), abs(ox)), abs(oz));
        const isLower = oy.lessThan(float(0));
        const unwrapX = mul(sub(float(1), abs(oz)), sign(ox));
        const unwrapZ = mul(sub(float(1), abs(ox)), sign(oz));
        const fx = select(isLower, unwrapX, ox);
        const fz = select(isLower, unwrapZ, oz);
        return normalize(vec3(fx, oy, fz));
      })
    : Fn(([gi, nm1]) => {
        const u = vec2(div(gi.x, nm1.x), div(gi.y, nm1.y));
        const px = sub(u.x, u.y);
        const pz = sub(add(u.x, u.y), 1);
        const py = sub(sub(1, abs(px)), abs(pz));
        return normalize(vec3(px, py, pz));
      });

  const planeTangent = Fn(([n]) => {
    const up = mix(
      vec3(0, 1, 0),
      vec3(-1, 0, 0),
      max(float(0), sign(sub(n.y, float(0.999)))),
    );
    return normalize(cross(up, n));
  });
  const planeUp = Fn(([n, t]) => {
    const worldUp = vec3(0, 1, 0);
    const proj = sub(worldUp, mul(n, dot(n, worldUp)));
    const len = length(proj);
    return select(len.lessThan(float(0.001)), t, normalize(proj));
  });
  const projectVert = Fn(([n]) => {
    const t = planeTangent(n);
    const up = planeUp(n, t);
    return add(mul(positionLocal.x, t), mul(positionLocal.y, up));
  });
  const planeUV = Fn(([n, t, camL, vd]) => {
    const denom = dot(vd, n);
    const tt = mul(dot(negate(camL), n), div(1, denom));
    const hit = add(camL, mul(vd, tt));
    const upP = planeUp(n, t);
    return add(vec2(dot(t, hit), dot(upP, hit)), float(0.5));
  });

  const positionFn = Fn(() => {
    const nm1 = vec2(sub(uSPS, 1), sub(uSPS, 1));
    const camLocal = mul(sub(cameraPosition, centerNode), div(1, uScale));
    const faceDir = normalize(camLocal);
    const bv = projectVert(faceDir);
    const viewDir = normalize(sub(bv, camLocal));

    const grid = mul(encode(faceDir), nm1);
    const gf = min(floor(grid), nm1);
    const fr = fract(grid);

    const w = vec4(
      min(sub(1, fr.x), sub(1, fr.y)),
      abs(sub(fr.x, fr.y)),
      min(fr.x, fr.y),
      max(float(0), sign(sub(fr.x, fr.y))),
    );
    vWeight.assign(w);

    const s1 = gf;
    const s2 = min(add(s1, mix(vec2(0, 1), vec2(1, 0), w.w)), nm1);
    const s3 = min(add(s1, vec2(1, 1)), nm1);
    vS1.assign(s1);
    vS2.assign(s2);
    vS3.assign(s3);

    const pn1 = decode(s1, nm1);
    const pt1 = planeTangent(pn1);
    const pn2 = decode(s2, nm1);
    const pt2 = planeTangent(pn2);
    const pn3 = decode(s3, nm1);
    const pt3 = planeTangent(pn3);
    vUV1.assign(planeUV(pn1, pt1, camLocal, viewDir));
    vUV2.assign(planeUV(pn2, pt2, camLocal, viewDir));
    vUV3.assign(planeUV(pn3, pt3, camLocal, viewDir));

    const heightW = add(positionLocal.y, float(0.5));
    const phase = add(mul(uTime, uWindFreq), mul(centerNode.x, float(0.37)));
    const phaseZ = add(
      mul(uTime, mul(uWindFreq, float(0.83))),
      mul(centerNode.z, float(0.41)),
    );
    const swayX = mul(sin(phase), uWindAmp);
    const swayZ = mul(cos(phaseZ), mul(uWindAmp, float(0.4)));
    const windOffset = mul(vec3(swayX, float(0), swayZ), heightW);

    return add(bv, windOffset);
  });

  const getUV = Fn(([uvf, frame]) => {
    const clamped = clamp(vec2(uvf.x, uvf.y), float(0), float(1));
    return add(mul(frame, uCellFrac), add(uPadFrac, mul(clamped, uInnerFrac)));
  });

  const depthParallax = Fn(([localUV, cellNorm, frame]) => {
    const out = vec2(0).toVar();
    If(uUseParallax.lessThan(float(0.5)), () => {
      out.assign(getUV(localUV, frame));
    }).Else(() => {
      const V = normalize(sub(cameraPosition, positionWorld));
      const T = planeTangent(cellNorm);
      const B = planeUp(cellNorm, T);
      const VdotN = max(dot(V, cellNorm), float(0.3));
      const viewTS = div(vec2(dot(V, T), dot(V, B)), VdotN);
      const d0 = texture(depthTex, getUV(localUV, frame)).r;
      const uv1 = add(
        localUV,
        mul(viewTS, mul(sub(float(0.5), d0), uParallaxStr)),
      );
      const d1 = texture(depthTex, getUV(uv1, frame)).r;
      const uv2 = add(
        localUV,
        mul(viewTS, mul(sub(float(0.5), d1), uParallaxStr)),
      );
      const d2 = texture(depthTex, getUV(uv2, frame)).r;
      const uv3 = add(
        localUV,
        mul(viewTS, mul(sub(float(0.5), d2), uParallaxStr)),
      );
      out.assign(getUV(uv3, frame));
    });
    return out;
  });

  const nm1f = vec2(sub(uSPS, 1), sub(uSPS, 1));
  const cn1 = decode(vS1, nm1f);
  const cn2 = decode(vS2, nm1f);
  const cn3 = decode(vS3, nm1f);

  const puv1 = depthParallax(vUV1, cn1, vS1);
  const puv2 = depthParallax(vUV2, cn2, vS2);
  const puv3 = depthParallax(vUV3, cn3, vS3);

  const c1 = texture(colorTex, puv1);
  const c2 = texture(colorTex, puv2);
  const c3 = texture(colorTex, puv3);

  const isDom1 = vWeight.x
    .greaterThanEqual(vWeight.y)
    .and(vWeight.x.greaterThanEqual(vWeight.z));
  const isDom2 = vWeight.y.greaterThanEqual(vWeight.z);
  const domAlpha = select(isDom1, c1.a, select(isDom2, c2.a, c3.a));
  const domRgb = select(isDom1, c1.rgb, select(isDom2, c2.rgb, c3.rgb));

  const wSum = add(add(vWeight.x, vWeight.y), vWeight.z);
  const nw1 = div(vWeight.x, max(wSum, float(0.001)));
  const nw2 = div(vWeight.y, max(wSum, float(0.001)));
  const nw3 = div(vWeight.z, max(wSum, float(0.001)));
  const baryRgb = add(
    add(mul(c1.rgb, nw1), mul(c2.rgb, nw2)),
    mul(c3.rgb, nw3),
  );
  const baryAlpha = add(add(mul(c1.a, nw1), mul(c2.a, nw2)), mul(c3.a, nw3));

  const px = viewportCoordinate.xy;
  const ign = fract(
    mul(
      float(52.9829189),
      fract(add(mul(float(0.06711056), px.x), mul(float(0.00583715), px.y))),
    ),
  );
  const nw12 = add(nw1, nw2);
  const ditS1 = ign.lessThan(nw1);
  const ditS2 = ign.lessThan(nw12);
  const ditRgb = select(ditS1, c1.rgb, select(ditS2, c2.rgb, c3.rgb));
  const ditAlpha = select(ditS1, c1.a, select(ditS2, c2.a, c3.a));

  const baryOrDomRgb = mix(domRgb, baryRgb, uUseBary);
  const baryOrDomA = mix(domAlpha, baryAlpha, uUseBary);
  const finalAlbedo = mix(baryOrDomRgb, ditRgb, uUseDither);
  const finalAlphaR = mix(baryOrDomA, ditAlpha, uUseDither);

  const edgeW = mul(fwidth(finalAlphaR), uEdgeSmooth);
  const smoothAlpha = smoothstep(
    sub(uAlphaCutoff, edgeW),
    add(uAlphaCutoff, edgeW),
    finalAlphaR,
  );

  const dist = length(sub(centerNode, cameraPosition));
  const wImpCross = smoothstep(
    sub(uLodDist, uFadeRange),
    add(uLodDist, uFadeRange),
    dist,
  );
  const smoothAlphaOut = mul(smoothAlpha, wImpCross);
  const fadeT = saturate(div(sub(dist, sub(uLodDist, uFadeRange)), uFadeRange));
  const fadeTSoft = smoothstep(float(0.15), float(0.85), fadeT);
  const lodPx = screenCoordinate.xy;
  const lodIgn = fract(
    mul(
      float(52.9829189),
      fract(
        add(mul(float(0.06711056), lodPx.x), mul(float(0.00583715), lodPx.y)),
      ),
    ),
  );
  const ditheredAlpha = select(
    lodIgn.greaterThan(fadeTSoft),
    float(0.0),
    smoothAlpha,
  );
  const rampLegacy = smoothstep(sub(uLodDist, uFadeRange), uLodDist, dist);
  const legacyAlphaOut = mul(ditheredAlpha, rampLegacy);
  const finalOpacity = mix(smoothAlphaOut, legacyAlphaOut, uLodDither);

  const n1 = texture(normalTex, puv1).xyz;
  const n2 = texture(normalTex, puv2).xyz;
  const n3 = texture(normalTex, puv3).xyz;
  const wN1 = normalize(sub(mul(n1, 2.0), 1.0));
  const wN2 = normalize(sub(mul(n2, 2.0), 1.0));
  const wN3 = normalize(sub(mul(n3, 2.0), 1.0));
  const baryN = normalize(
    add(add(mul(wN1, nw1), mul(wN2, nw2)), mul(wN3, nw3)),
  );
  const domN = select(isDom1, wN1, select(isDom2, wN2, wN3));
  const atlasN = normalize(mix(domN, baryN, uNormRmBary));
  const finalWorldN = normalize(mix(vec3(0, 1, 0), atlasN, uNormStr));

  const rm1 = texture(rmTex, puv1);
  const rm2 = texture(rmTex, puv2);
  const rm3 = texture(rmTex, puv3);
  const baryRM = add(add(mul(rm1.xy, nw1), mul(rm2.xy, nw2)), mul(rm3.xy, nw3));
  const domRM = select(isDom1, rm1.xy, select(isDom2, rm2.xy, rm3.xy));
  const finalRM = mix(domRM, baryRM, uNormRmBary);
  const finalRough = clamp(finalRM.x, float(0.05), float(1));
  const finalMetal = clamp(finalRM.y, float(0), float(1));

  const dep1 = texture(depthTex, puv1).r;
  const dep2 = texture(depthTex, puv2).r;
  const dep3 = texture(depthTex, puv3).r;
  const baryDepth = add(add(mul(dep1, nw1), mul(dep2, nw2)), mul(dep3, nw3));
  const domDepth = select(isDom1, dep1, select(isDom2, dep2, dep3));
  const atlasDepth = mix(domDepth, baryDepth, uNormRmBary);
  const ao = saturate(sub(float(1), mul(float(0.5), atlasDepth)));

  const viewDirW = normalize(sub(cameraPosition, positionWorld));
  const backLit = pow(saturate(dot(viewDirW, negate(uSunDir))), uTransPow);
  const translucency = mul(
    mul(mul(backLit, uTransAmt), mul(finalAlbedo, uTransTint)),
    uSunColor,
  );

  const mainMat = new THREE.MeshStandardNodeMaterial();
  mainMat.side = THREE.FrontSide;
  mainMat.transparent = false;
  // Match forest-webgpu impostor: cutout via low alphaTest, not blended transparency.
  mainMat.alphaTest = 0.005;
  mainMat.alphaToCoverage = false;
  mainMat.depthWrite = true;
  mainMat.depthTest = true;
  mainMat.fog = true;
  // Only near LOD meshes cast shadows — impostor billboards cast flat quads on the ground.
  mainMat.castShadow = false;
  mainMat.receiveShadow = true;
  mainMat.positionNode = positionFn();
  mainMat.colorNode = finalAlbedo;
  mainMat.normalNode = finalWorldN;
  mainMat.roughnessNode = finalRough;
  mainMat.metalnessNode = finalMetal;
  mainMat.aoNode = ao;
  mainMat.opacityNode = finalOpacity;
  mainMat.emissiveNode = translucency;

  return {
    mainMat,
    uniforms: {
      uSPS,
      uScale,
      uTime,
      uNormStr,
      uAlphaCutoff,
      uEdgeSmooth,
      uParallaxStr,
      uUseBary,
      uNormRmBary,
      uUseParallax,
      uUseDither,
      uWindAmp,
      uWindFreq,
      uTransAmt,
      uTransPow,
      uTransTint,
      uSunDir,
      uSunColor,
      uLodDist,
      uFadeRange,
      uLodDither,
    },
  };
}
