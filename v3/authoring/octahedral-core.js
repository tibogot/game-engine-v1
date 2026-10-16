/**
 * Octahedral impostor core — v3 bake pipeline + materials (shared by editor and forest).
 */
import * as THREE from "three";
import {
  Fn, If, normalize, sub, mul, add, div, abs, vec2, vec3, vec4, sign, dot, cross,
  floor, fract, min, max, clamp, saturate, texture, cameraPosition, cameraViewMatrix,
  positionWorld, positionLocal, positionView, float, uniform, varying, select,
  length, negate, mix, smoothstep, step, fwidth, pow, sin, cos, normalWorld,
  tangentLocal, viewportCoordinate, uv, instanceIndex, screenCoordinate,
} from "three/tsl";
// ═══════════════════════════════════════════════════════════════════════════
//  Octahedral mapping helpers (CPU side — used for active-cell overlay)
// ═══════════════════════════════════════════════════════════════════════════

function hemiOctaGridToDir(gx, gy, out) {
  out.set(gx - gy, 0, -1 + gx + gy);
  out.y = 1 - Math.abs(out.x) - Math.abs(out.z);
  return out.normalize();
}

function fullOctaGridToDir(gx, gy, out) {
  const ox = gx * 2 - 1, oz = gy * 2 - 1;
  const oy = 1 - Math.abs(ox) - Math.abs(oz);
  if (oy >= 0) out.set(ox, oy, oz);
  else out.set((1 - Math.abs(oz)) * (ox >= 0 ? 1 : -1), oy, (1 - Math.abs(ox)) * (oz >= 0 ? 1 : -1));
  return out.normalize();
}

function hemiOctaEncodeCPU(dir) {
  const sx = Math.sign(dir.x) || 1;
  const sy = Math.sign(dir.y) || 1;
  const sz = Math.sign(dir.z) || 1;
  const d = dir.x * sx + dir.y * sy + dir.z * sz;
  return { u: 0.5 * (1 + dir.x / d + dir.z / d), v: 0.5 * (1 + dir.z / d - dir.x / d) };
}

function countTris(meshData) {
  let t = 0;
  for (const { geometry } of meshData) {
    if (!geometry) continue;
    if (geometry.index) t += geometry.index.count / 3;
    else t += (geometry.attributes?.position?.count || 0) / 3;
  }
  return Math.floor(t);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Per-cell alpha-weighted mipmaps + sRGB + dilation
// ═══════════════════════════════════════════════════════════════════════════

// Stop generating mip levels once cells drop below this many pixels — past
// here the per-cell averages become noise and just confuse trilinear filtering.
const MIN_CELL_PIXELS_FOR_MIP = 4;

function generatePerCellMipmaps(pixels, atlasSize, grid) {
  const levels = [pixels];
  let prevSize = atlasSize;
  while (prevSize > 1) {
    const nextSize = prevSize >> 1;
    if (nextSize < 1) break;
    if (nextSize / grid < MIN_CELL_PIXELS_FOR_MIP) break;
    const prev = levels[levels.length - 1];
    const next = new Uint8Array(nextSize * nextSize * 4);
    const prevCS = prevSize / grid, nextCS = nextSize / grid;
    for (let row = 0; row < grid; row++) {
      for (let col = 0; col < grid; col++) {
        const nx0 = Math.floor(col * nextCS), ny0 = Math.floor(row * nextCS);
        const nw = Math.floor((col + 1) * nextCS) - nx0;
        const nh = Math.floor((row + 1) * nextCS) - ny0;
        for (let dy = 0; dy < nh; dy++) {
          for (let dx = 0; dx < nw; dx++) {
            const sx = Math.floor(col * prevCS) + dx * 2;
            const sy = Math.floor(row * prevCS) + dy * 2;
            const sxMax = Math.floor((col + 1) * prevCS) - 1;
            const syMax = Math.floor((row + 1) * prevCS) - 1;
            let r = 0, g = 0, b = 0, a = 0, cnt = 0;
            for (let oy = 0; oy < 2; oy++) {
              for (let ox = 0; ox < 2; ox++) {
                const px = Math.min(sx + ox, sxMax), py = Math.min(sy + oy, syMax);
                const idx = (py * prevSize + px) * 4;
                const sa = prev[idx + 3];
                if (sa > 0) { r += prev[idx] * sa; g += prev[idx + 1] * sa; b += prev[idx + 2] * sa; a += sa; cnt++; }
              }
            }
            const di = ((ny0 + dy) * nextSize + (nx0 + dx)) * 4;
            if (a > 0) {
              next[di] = Math.round(r / a);
              next[di + 1] = Math.round(g / a);
              next[di + 2] = Math.round(b / a);
              next[di + 3] = Math.round(a / Math.max(cnt, 1));
            }
          }
        }
      }
    }
    levels.push(next);
    prevSize = nextSize;
  }
  return levels;
}

function makeTexWithMips(mipLevels, atlasSize, maxAniso, srgb) {
  const t = new THREE.DataTexture(mipLevels[0], atlasSize, atlasSize, THREE.RGBAFormat);
  t.mipmaps = [];
  let sz = atlasSize;
  for (let i = 0; i < mipLevels.length; i++) {
    t.mipmaps.push({ data: mipLevels[i], width: sz, height: sz });
    sz >>= 1;
  }
  t.needsUpdate = true;
  t.flipY = false;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  return t;
}

function linearToSrgb(pixels) {
  for (let i = 0; i < pixels.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      let v = pixels[i + c] / 255;
      v = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
      pixels[i + c] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
}

function downsample2x(src, srcSize) {
  const dstSize = srcSize >> 1;
  const dst = new Uint8Array(dstSize * dstSize * 4);
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const si = ((y * 2 + dy) * srcSize + (x * 2 + dx)) * 4;
          const sa = src[si + 3];
          r += src[si] * sa; g += src[si + 1] * sa; b += src[si + 2] * sa; a += sa;
        }
      }
      const di = (y * dstSize + x) * 4;
      if (a > 0) {
        dst[di] = Math.round(r / a);
        dst[di + 1] = Math.round(g / a);
        dst[di + 2] = Math.round(b / a);
        dst[di + 3] = Math.round(a / 4);
      }
    }
  }
  return dst;
}

function dilateAtlasEdges(pixels, size, grid, iterations = 8) {
  const cs = size / grid;
  const tmp = new Uint8Array(pixels.length);
  for (let iter = 0; iter < iterations; iter++) {
    tmp.set(pixels);
    for (let cy = 0; cy < grid; cy++) {
      for (let cx = 0; cx < grid; cx++) {
        const x0 = Math.floor(cx * cs), y0 = Math.floor(cy * cs);
        const x1 = Math.floor((cx + 1) * cs), y1 = Math.floor((cy + 1) * cs);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * size + x) * 4;
            if (pixels[i + 3] > 0) continue;
            let r = 0, g = 0, b = 0, cnt = 0;
            for (let dy = -1; dy <= 1; dy++) {
              const ny = y + dy;
              if (ny < y0 || ny >= y1) continue;
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx;
                if (nx < x0 || nx >= x1) continue;
                const ni = (ny * size + nx) * 4;
                if (pixels[ni + 3] > 0) {
                  r += pixels[ni]; g += pixels[ni + 1]; b += pixels[ni + 2]; cnt++;
                }
              }
            }
            if (cnt > 0) {
              tmp[i] = Math.round(r / cnt);
              tmp[i + 1] = Math.round(g / cnt);
              tmp[i + 2] = Math.round(b / cnt);
              tmp[i + 3] = 1;
            }
          }
        }
      }
    }
    pixels.set(tmp);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Atlas bake — 4 passes (color, normal, RM, depth) — supersample 2× + AA
// ═══════════════════════════════════════════════════════════════════════════

const BAKE_SPHERE_MARGIN = 1.02;

async function bakeAtlases(renderer, meshData, opts) {
  const { grid, atlasSize, maxAniso, cellPad = 4, fullOctahedral = false } = opts;
  const gridToDir = fullOctahedral ? fullOctaGridToDir : hemiOctaGridToDir;
  const cs = Math.floor(atlasSize / grid);
  const pad = cellPad;
  const innerCS = cs - pad * 2;

  // Bounds
  const box = new THREE.Box3();
  for (const { geometry } of meshData) {
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox);
  }
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const radius = sphere.radius * BAKE_SPHERE_MARGIN;
  const center = sphere.center.clone();

  const ortho = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.001, radius * 4);
  const dir = new THREE.Vector3();

  const colorScene = new THREE.Scene();
  const normalScene = new THREE.Scene();
  const rmScene = new THREE.Scene();
  const depthScene = new THREE.Scene();

  const BAKE_ALPHA = 0.02;
  const depthNear = radius;
  const depthSpan = 2 * radius;

  for (const { geometry, material } of meshData) {
    const hasAlpha = !!(material.map || material.alphaMap);
    const hasVColors = !!(geometry.attributes.color && material.vertexColors);

    if (material.normalMap && !geometry.attributes.tangent) {
      try { geometry.computeTangents(); } catch (e) { /* skip */ }
    }

    // Color
    const colorMat = new THREE.MeshBasicMaterial({
      color: material.color ? material.color.clone() : new THREE.Color(0xffffff),
      map: material.map || null,
      vertexColors: hasVColors,
      alphaTest: hasAlpha ? BAKE_ALPHA : 0,
      alphaMap: material.alphaMap || null,
      side: THREE.DoubleSide,
    });
    colorScene.add(new THREE.Mesh(geometry, colorMat));

    // Normal — bake world-space normal with normal map applied
    const alphaNode = material.map ? texture(material.map, uv()).a : float(1);
    let bakeNormal = normalWorld;
    if (material.normalMap && geometry.attributes.tangent) {
      const T = normalize(tangentLocal.xyz);
      const N = normalWorld;
      const B = mul(normalize(cross(N, T)), tangentLocal.w);
      const mapSamp = texture(material.normalMap, uv());
      const mapN = sub(mul(mapSamp.xyz, float(2)), float(1));
      bakeNormal = normalize(add(add(mul(T, mapN.x), mul(B, mapN.y)), mul(N, mapN.z)));
    }
    const nMat = new THREE.MeshBasicNodeMaterial({
      side: THREE.DoubleSide,
      colorNode: vec4(mul(add(bakeNormal, 1), 0.5), alphaNode),
    });
    if (hasAlpha) nMat.alphaTest = BAKE_ALPHA;
    normalScene.add(new THREE.Mesh(geometry.clone(), nMat));

    // R/M
    const r = material.roughness !== undefined ? material.roughness : 0.5;
    const m = material.metalness !== undefined ? material.metalness : 0.0;
    let rNode = float(r), mNode = float(m);
    if (material.roughnessMap) rNode = mul(texture(material.roughnessMap, uv()).g, float(r));
    if (material.metalnessMap) mNode = mul(texture(material.metalnessMap, uv()).b, float(m));
    const rmMat = new THREE.MeshBasicNodeMaterial({
      side: THREE.DoubleSide,
      colorNode: vec4(rNode, mNode, float(0), alphaNode),
    });
    if (hasAlpha) rmMat.alphaTest = BAKE_ALPHA;
    rmScene.add(new THREE.Mesh(geometry.clone(), rmMat));

    // Depth (linear 0..1 from near to far along view dir)
    const depthVal = saturate(div(sub(negate(positionView.z), float(depthNear)), float(depthSpan)));
    const dMat = new THREE.MeshBasicNodeMaterial({
      side: THREE.DoubleSide,
      colorNode: vec4(depthVal, depthVal, depthVal, alphaNode),
    });
    if (hasAlpha) dMat.alphaTest = BAKE_ALPHA;
    depthScene.add(new THREE.Mesh(geometry.clone(), dMat));
  }

  // Supersample 2× then downsample
  const ssScale = 2;
  const ssCS = innerCS * ssScale;
  const cellRT = new THREE.RenderTarget(ssCS, ssCS, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.LinearSRGBColorSpace,
    samples: 1,
  });

  const savedTM = renderer.toneMapping;
  const savedOCS = renderer.outputColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(0x000000, 0);

  await renderer.compileAsync(colorScene, ortho);
  await renderer.compileAsync(normalScene, ortho);
  await renderer.compileAsync(rmScene, ortho);
  await renderer.compileAsync(depthScene, ortho);

  const colorPixels = new Uint8Array(atlasSize * atlasSize * 4);
  const normalPixels = new Uint8Array(atlasSize * atlasSize * 4);
  const rmPixels = new Uint8Array(atlasSize * atlasSize * 4);
  const depthPixels = new Uint8Array(atlasSize * atlasSize * 4);

  const ssTightRow = ssCS * 4;
  const ssPaddedRow = Math.ceil(ssTightRow / 256) * 256;
  const ssFlipped = new Uint8Array(ssCS * ssCS * 4);

  const scenes = [
    [colorScene, colorPixels],
    [normalScene, normalPixels],
    [rmScene, rmPixels],
    [depthScene, depthPixels],
  ];

  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      gridToDir(gx / (grid - 1), gy / (grid - 1), dir);
      const _poleT = THREE.MathUtils.smoothstep(Math.abs(dir.y), 0.9, 1.0);
      ortho.up.set(0, 1 - _poleT, _poleT); // match the render's blended pole up-ref
      ortho.position.copy(center).addScaledVector(dir, radius * 2);
      ortho.lookAt(center);
      ortho.updateMatrixWorld(true);

      for (const [sc, dest] of scenes) {
        renderer.setRenderTarget(cellRT);
        renderer.autoClear = true;
        renderer.render(sc, ortho);

        const buf = await renderer.readRenderTargetPixelsAsync(cellRT, 0, 0, ssCS, ssCS);
        const src = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        const srcStride = src.length > ssCS * ssCS * 4 ? ssPaddedRow : ssTightRow;

        for (let row = 0; row < ssCS; row++) {
          const srcOff = (ssCS - 1 - row) * srcStride;
          const dstOff = row * ssTightRow;
          ssFlipped.set(src.subarray(srcOff, srcOff + ssTightRow), dstOff);
        }

        const dsCell = downsample2x(ssFlipped, ssCS);
        const dsRow = innerCS * 4;
        for (let row = 0; row < innerCS; row++) {
          const dy = gy * cs + pad + row;
          const dstOff = (dy * atlasSize + gx * cs + pad) * 4;
          const srcOff = row * dsRow;
          dest.set(dsCell.subarray(srcOff, srcOff + dsRow), dstOff);
        }
      }
    }
  }

  cellRT.dispose();
  renderer.setRenderTarget(null);
  renderer.autoClear = true;
  renderer.toneMapping = savedTM;
  renderer.outputColorSpace = savedOCS;

  linearToSrgb(colorPixels);

  dilateAtlasEdges(colorPixels,  atlasSize, grid, 8);
  dilateAtlasEdges(normalPixels, atlasSize, grid, 8);
  dilateAtlasEdges(rmPixels,     atlasSize, grid, 8);
  dilateAtlasEdges(depthPixels,  atlasSize, grid, 8);

  return {
    colorTex:  makeTexWithMips(generatePerCellMipmaps(colorPixels,  atlasSize, grid), atlasSize, maxAniso, true),
    normalTex: makeTexWithMips(generatePerCellMipmaps(normalPixels, atlasSize, grid), atlasSize, maxAniso, false),
    rmTex:     makeTexWithMips(generatePerCellMipmaps(rmPixels,     atlasSize, grid), atlasSize, maxAniso, false),
    depthTex:  makeTexWithMips(generatePerCellMipmaps(depthPixels,  atlasSize, grid), atlasSize, maxAniso, false),
    colorPixels, normalPixels, rmPixels, depthPixels,
    radius, center, grid, atlasSize, cellPad: pad,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Impostor materials — MeshStandardNodeMaterial + shadow caster
// ═══════════════════════════════════════════════════════════════════════════

function createImpostorMaterials(textures, opts) {
  const { colorTex, normalTex, rmTex, depthTex } = textures;
  const { impostorScale, gridVal, atlasSize, cellPad, fullOctahedral = false } = opts;

  // ── Uniforms (shared between main + depth materials) ────────────────────
  const uSPS         = uniform(float(gridVal));
  const uScale       = uniform(float(impostorScale));
  const uCenter      = uniform(new THREE.Vector3());
  const uTime        = uniform(float(0));

  const uNormStr     = uniform(float(1.0));
  const uAlphaCutoff = uniform(float(0.5));
  const uEdgeSmooth  = uniform(float(1.5));
  const uParallaxStr = uniform(float(0.0));

  const uUseBary     = uniform(float(0));   // 0=dominant, 1=bary — albedo/alpha only
  const uNormRmBary  = uniform(float(0));   // 0=dominant, 1=bary — normals/R/M/AO (can ghost)
  const uUseParallax = uniform(float(0));   // 0=off, 1=on
  const uUseDither   = uniform(float(0));   // 0=hard, 1=dither cross-fade

  const uFreeze      = uniform(float(0));
  const uFreezeDir   = uniform(new THREE.Vector3(0, 0, 1));

  const uWindAmp     = uniform(float(0));   // 0 = no wind
  const uWindFreq    = uniform(float(1.5));

  // Translucency (back-lit SSS — added via emissiveNode)
  const uTransAmt    = uniform(float(0));
  const uTransPow    = uniform(float(3.0));
  const uTransTint   = uniform(new THREE.Vector3(0.9, 1.0, 0.7));
  const uSunDir      = uniform(new THREE.Vector3(0.5, 0.7, 0.5).normalize());
  const uSunColor    = uniform(new THREE.Vector3(1, 1, 1));

  // Atlas geometry
  const uCellFrac    = uniform(float(1 / gridVal));
  const uPadFrac     = uniform(float(cellPad / atlasSize));
  const uInnerFrac   = uniform(float(1 / gridVal - (2 * cellPad) / atlasSize));

  // Debug
  const uDebugMode   = uniform(float(0)); // 0=PBR, 1=normals, 2=raw atlas
  const uUnlit       = uniform(float(0)); // 1 = show baked colour UNLIT (emissive), no relight
  const uFade        = uniform(float(1)); // LOD crossfade: screen-door dither, 1=solid 0=gone

  // Vertex→fragment varyings
  const vWeight = varying(vec4(0, 0, 0, 0), "vW");
  const vS1     = varying(vec2(0, 0), "vS1");
  const vS2     = varying(vec2(0, 0), "vS2");
  const vS3     = varying(vec2(0, 0), "vS3");
  const vUV1    = varying(vec2(0, 0), "vUV1");
  const vUV2    = varying(vec2(0, 0), "vUV2");
  const vUV3    = varying(vec2(0, 0), "vUV3");

  // ── Octa encode / decode (hemi or full) ──────────────────────────────────
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

  // Build orthonormal frame on the cell plane
  const planeTangent = Fn(([n]) => {
    // Blend the up-reference toward horizontal (+Z) as n nears vertical, so
    // cross(up, n) never collapses at the pole (top view). MUST match the bake
    // camera up (set per-cell in the bake loops) or the top cell renders rotated.
    const up = mix(vec3(0, 1, 0), vec3(0, 0, 1), smoothstep(float(0.9), float(1.0), abs(n.y)));
    return normalize(cross(up, n));
  });
  const planeUp = Fn(([n, t]) => {
    // Same blended reference as planeTangent (so render up == bake camera up).
    const ref = mix(vec3(0, 1, 0), vec3(0, 0, 1), smoothstep(float(0.9), float(1.0), abs(n.y)));
    const proj = sub(ref, mul(n, dot(n, ref)));
    const len = length(proj);
    // Exact-pole fallback: a vector PERPENDICULAR to the tangent (not the tangent).
    return select(len.lessThan(float(0.001)), normalize(cross(n, t)), normalize(proj));
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

  // ── Vertex stage: billboard + cell triplet + wind ────────────────────────
  const positionFn = Fn(() => {
    const nm1 = vec2(sub(uSPS, 1), sub(uSPS, 1));
    const camLocal = mul(sub(cameraPosition, uCenter), div(1, uScale));
    const faceDir = normalize(camLocal);
    const lookupDir = select(uFreeze.greaterThan(float(0.5)), uFreezeDir, faceDir);

    const bv = projectVert(faceDir);
    const viewDir = normalize(sub(bv, camLocal));

    // Cell triplet (hemi octa barycentric)
    const grid = mul(encode(lookupDir), nm1);
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
    vS1.assign(s1); vS2.assign(s2); vS3.assign(s3);

    const pn1 = decode(s1, nm1); const pt1 = planeTangent(pn1);
    const pn2 = decode(s2, nm1); const pt2 = planeTangent(pn2);
    const pn3 = decode(s3, nm1); const pt3 = planeTangent(pn3);
    vUV1.assign(planeUV(pn1, pt1, camLocal, viewDir));
    vUV2.assign(planeUV(pn2, pt2, camLocal, viewDir));
    vUV3.assign(planeUV(pn3, pt3, camLocal, viewDir));

    // Wind sway — base-anchored, horizontal in local space
    // heightW = 0 at bottom edge (localY = -0.5), 1 at top edge (localY = 0.5)
    const heightW = add(positionLocal.y, float(0.5));
    const phase = add(mul(uTime, uWindFreq), mul(uCenter.x, float(0.37)));
    const phaseZ = add(mul(uTime, mul(uWindFreq, float(0.83))), mul(uCenter.z, float(0.41)));
    const swayX = mul(sin(phase), uWindAmp);
    const swayZ = mul(cos(phaseZ), mul(uWindAmp, float(0.4)));
    const windOffset = mul(vec3(swayX, float(0), swayZ), heightW);

    return add(bv, windOffset);
  });

  // ── Atlas UV with padding ────────────────────────────────────────────────
  const getUV = Fn(([uvf, frame]) => {
    const clamped = clamp(vec2(uvf.x, uvf.y), float(0), float(1));
    return add(mul(frame, uCellFrac), add(uPadFrac, mul(clamped, uInnerFrac)));
  });

  // ── Depth parallax (3-step iterative) — skipped entirely when uUseParallax=0 ──
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
      const uv1 = add(localUV, mul(viewTS, mul(sub(float(0.5), d0), uParallaxStr)));
      const d1 = texture(depthTex, getUV(uv1, frame)).r;
      const uv2 = add(localUV, mul(viewTS, mul(sub(float(0.5), d1), uParallaxStr)));
      const d2 = texture(depthTex, getUV(uv2, frame)).r;
      const uv3 = add(localUV, mul(viewTS, mul(sub(float(0.5), d2), uParallaxStr)));
      out.assign(getUV(uv3, frame));
    });
    return out;
  });

  // ── Fragment: sample 3 cells, blend or pick dominant ─────────────────────
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

  const isDom1 = vWeight.x.greaterThanEqual(vWeight.y).and(vWeight.x.greaterThanEqual(vWeight.z));
  const isDom2 = vWeight.y.greaterThanEqual(vWeight.z);
  const domAlpha = select(isDom1, c1.a, select(isDom2, c2.a, c3.a));
  const domRgb = select(isDom1, c1.rgb, select(isDom2, c2.rgb, c3.rgb));

  const wSum = add(add(vWeight.x, vWeight.y), vWeight.z);
  const nw1 = div(vWeight.x, max(wSum, float(0.001)));
  const nw2 = div(vWeight.y, max(wSum, float(0.001)));
  const nw3 = div(vWeight.z, max(wSum, float(0.001)));
  const baryRgb = add(add(mul(c1.rgb, nw1), mul(c2.rgb, nw2)), mul(c3.rgb, nw3));
  const baryAlpha = add(add(mul(c1.a, nw1), mul(c2.a, nw2)), mul(c3.a, nw3));

  // Dither stochastic selection (alternative to soft blend)
  const px = viewportCoordinate.xy;
  const ign = fract(mul(float(52.9829189),
    fract(add(mul(float(0.06711056), px.x), mul(float(0.00583715), px.y)))));
  const nw12 = add(nw1, nw2);
  const ditS1 = ign.lessThan(nw1);
  const ditS2 = ign.lessThan(nw12);
  const ditRgb = select(ditS1, c1.rgb, select(ditS2, c2.rgb, c3.rgb));
  const ditAlpha = select(ditS1, c1.a, select(ditS2, c2.a, c3.a));

  // Selection logic:
  //   dither path overrides color when uUseDither
  //   else: uUseBary chooses barycentric vs dominant for albedo/alpha only
  const baryOrDomRgb = mix(domRgb, baryRgb, uUseBary);
  const baryOrDomA   = mix(domAlpha, baryAlpha, uUseBary);
  const finalAlbedo  = mix(baryOrDomRgb, ditRgb,   uUseDither);
  const finalAlphaR  = mix(baryOrDomA,   ditAlpha, uUseDither);

  // Edge AA via fwidth on the chosen alpha (smoothstep around cutoff)
  const edgeW = mul(fwidth(finalAlphaR), uEdgeSmooth);
  const smoothAlpha = smoothstep(sub(uAlphaCutoff, edgeW), add(uAlphaCutoff, edgeW), finalAlphaR);

  // Normals — bary or dominant
  const n1 = texture(normalTex, puv1).xyz;
  const n2 = texture(normalTex, puv2).xyz;
  const n3 = texture(normalTex, puv3).xyz;
  const wN1 = normalize(sub(mul(n1, 2.0), 1.0));
  const wN2 = normalize(sub(mul(n2, 2.0), 1.0));
  const wN3 = normalize(sub(mul(n3, 2.0), 1.0));
  const baryN = normalize(add(add(mul(wN1, nw1), mul(wN2, nw2)), mul(wN3, nw3)));
  const domN  = select(isDom1, wN1, select(isDom2, wN2, wN3));
  const atlasN = normalize(mix(domN, baryN, uNormRmBary));
  // Normal strength = lerp from flat-up to atlas normal
  const finalWorldN = normalize(mix(vec3(0, 1, 0), atlasN, uNormStr));

  // Roughness / metalness — dominant by default (view-dependent per cell)
  const rm1 = texture(rmTex, puv1);
  const rm2 = texture(rmTex, puv2);
  const rm3 = texture(rmTex, puv3);
  const baryRM = add(add(mul(rm1.xy, nw1), mul(rm2.xy, nw2)), mul(rm3.xy, nw3));
  const domRM  = select(isDom1, rm1.xy, select(isDom2, rm2.xy, rm3.xy));
  const finalRM = mix(domRM, baryRM, uNormRmBary);
  const finalRough = clamp(finalRM.x, float(0.05), float(1));
  const finalMetal = clamp(finalRM.y, float(0), float(1));

  // Depth-based AO
  const dep1 = texture(depthTex, puv1).r;
  const dep2 = texture(depthTex, puv2).r;
  const dep3 = texture(depthTex, puv3).r;
  const baryDepth = add(add(mul(dep1, nw1), mul(dep2, nw2)), mul(dep3, nw3));
  const domDepth = select(isDom1, dep1, select(isDom2, dep2, dep3));
  const atlasDepth = mix(domDepth, baryDepth, uNormRmBary);
  const ao = saturate(sub(float(1), mul(float(0.5), atlasDepth)));

  // Translucency / back-lit SSS — only inside silhouette, scales with sun
  const viewDirW = normalize(sub(cameraPosition, positionWorld));
  const backLit = pow(saturate(dot(viewDirW, negate(uSunDir))), uTransPow);
  const translucency = mul(mul(mul(backLit, uTransAmt), mul(finalAlbedo, uTransTint)), uSunColor);

  // Debug overrides
  const isNormViz = uDebugMode.greaterThan(float(0.5)).and(uDebugMode.lessThan(float(1.5)));
  const isRawViz  = uDebugMode.greaterThan(float(1.5));
  const normVizCol = mul(add(finalWorldN, float(1)), float(0.5));
  const displayColor = select(isRawViz, finalAlbedo, select(isNormViz, normVizCol, finalAlbedo));
  const displayEmissive = select(isRawViz, vec3(0, 0, 0), select(isNormViz, normVizCol, translucency));

  // ── Main material (MeshStandardNodeMaterial — full scene lighting) ───────
  const mainMat = new THREE.MeshStandardNodeMaterial();
  mainMat.side = THREE.FrontSide;
  mainMat.transparent = false;
  mainMat.alphaTest = 0.5;
  // alphaToCoverage default OFF — when ON, MSAA stippling on the fwidth-smoothed
  // alpha shatters foliage silhouettes without TAA to resolve. Toggle from GUI.
  mainMat.alphaToCoverage = false;
  mainMat.depthWrite = true;
  mainMat.positionNode  = positionFn();
  mainMat.colorNode     = mix(displayColor, vec3(0, 0, 0), uUnlit);
  // World->view: three lighting consumes normalNode in VIEW space, but our atlas
  // stores WORLD normals. Without this the terminator is correct only near the
  // front (world≈view) and mirrors as you orbit to the back. (TEST)
  mainMat.normalNode    = normalize(mul(cameraViewMatrix, vec4(finalWorldN, 0)).xyz);
  mainMat.roughnessNode = finalRough;
  mainMat.metalnessNode = finalMetal;
  mainMat.aoNode        = ao;
  mainMat.opacityNode   = mul(smoothAlpha, step(ign, uFade)); // × LOD crossfade dither
  mainMat.emissiveNode  = mix(displayEmissive, finalAlbedo, uUnlit);

  // Shadow casting — Renderer._getShadowNodes() picks these up per-draw and
  // patches them onto the shared ShadowPassMaterial. cameraPosition during the
  // shadow pass IS the sun position, so positionFn() orients the billboard
  // toward the sun and the atlas alpha samples at the sun's view direction →
  // the shadow silhouette matches what the sun actually sees.
  mainMat.castShadowPositionNode = positionFn();
  mainMat.castShadowNode         = vec4(float(0), float(0), float(0), smoothAlpha);

  return {
    mainMat,
    uniforms: {
      uSPS, uScale, uCenter, uTime,
      uNormStr, uAlphaCutoff, uEdgeSmooth, uParallaxStr,
      uUseBary, uNormRmBary, uUseParallax, uUseDither,
      uFreeze, uFreezeDir,
      uWindAmp, uWindFreq,
      uTransAmt, uTransPow, uTransTint,
      uSunDir, uSunColor,
      uDebugMode, uUnlit, uFade,
    },
  };
}
// ═══════════════════════════════════════════════════════════════════════════
//  Color-only bake of a LIVE object (renders with its OWN materials)
//  — for custom-shader trees (stylized billboard foliage) where the generic
//  material-substitution bake (bakeAtlases) can't reproduce the look. Captures
//  the final lit/stylized appearance in RGB + coverage in alpha. No normal/RM/
//  depth (pair with flat aux atlases for an unlit/lightly-relit impostor).
// ═══════════════════════════════════════════════════════════════════════════
async function bakeColorAtlasFromObject(renderer, objects, opts) {
  const { grid, atlasSize, maxAniso = 8, cellPad = 4, fullOctahedral = false } = opts;
  const gridToDir = fullOctahedral ? fullOctaGridToDir : hemiOctaGridToDir;
  const cs = Math.floor(atlasSize / grid);
  const pad = cellPad;
  const innerCS = cs - pad * 2;

  // Isolated bake scene — clone each source object so the page scene
  // (ground / sky / other tree) isn't captured. Clones share materials, so the
  // foliage still billboards toward the bake camera and keeps its stylized color.
  const bakeScene = new THREE.Scene();
  for (const o of objects) if (o) bakeScene.add(o.clone(true));
  // Lights so MeshStandard trunks aren't black — the color bake captures the LIT
  // look (the foliage's stylized colour is mostly self-lit via its own shader).
  if (opts.lights) {
    for (const L of opts.lights) {
      const lc = L.clone();
      bakeScene.add(lc);
      if (lc.target && L.target) { lc.target.position.copy(L.target.position); bakeScene.add(lc.target); }
    }
  }
  bakeScene.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(bakeScene);
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const radius = sphere.radius * BAKE_SPHERE_MARGIN;
  const center = sphere.center.clone();

  const ortho = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.001, radius * 4);
  const dir = new THREE.Vector3();

  const ssScale = 2;
  const ssCS = innerCS * ssScale;
  const cellRT = new THREE.RenderTarget(ssCS, ssCS, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
    colorSpace: THREE.LinearSRGBColorSpace, samples: 1,
  });

  const savedTM = renderer.toneMapping;
  const savedOCS = renderer.outputColorSpace;
  const savedTarget = renderer.getRenderTarget();
  const savedAutoClear = renderer.autoClear;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  await renderer.compileAsync(bakeScene, ortho);

  const colorPixels = new Uint8Array(atlasSize * atlasSize * 4);
  const ssTightRow = ssCS * 4;
  const ssPaddedRow = Math.ceil(ssTightRow / 256) * 256;
  const ssFlipped = new Uint8Array(ssCS * ssCS * 4);

  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      gridToDir(gx / (grid - 1), gy / (grid - 1), dir);
      const _poleT = THREE.MathUtils.smoothstep(Math.abs(dir.y), 0.9, 1.0);
      ortho.up.set(0, 1 - _poleT, _poleT); // match the render's blended pole up-ref
      ortho.position.copy(center).addScaledVector(dir, radius * 2);
      ortho.lookAt(center);
      ortho.updateMatrixWorld(true);

      renderer.setRenderTarget(cellRT);
      renderer.autoClear = true;
      renderer.render(bakeScene, ortho);

      const buf = await renderer.readRenderTargetPixelsAsync(cellRT, 0, 0, ssCS, ssCS);
      const src = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const srcStride = src.length > ssCS * ssCS * 4 ? ssPaddedRow : ssTightRow;
      for (let row = 0; row < ssCS; row++) {
        const srcOff = (ssCS - 1 - row) * srcStride;
        ssFlipped.set(src.subarray(srcOff, srcOff + ssTightRow), row * ssTightRow);
      }
      const dsCell = downsample2x(ssFlipped, ssCS);
      const dsRow = innerCS * 4;
      for (let row = 0; row < innerCS; row++) {
        const dy = gy * cs + pad + row;
        const dstOff = (dy * atlasSize + gx * cs + pad) * 4;
        colorPixels.set(dsCell.subarray(row * dsRow, row * dsRow + dsRow), dstOff);
      }
    }
  }

  cellRT.dispose();
  renderer.setRenderTarget(savedTarget);
  renderer.autoClear = savedAutoClear;
  renderer.toneMapping = savedTM;
  renderer.outputColorSpace = savedOCS;

  linearToSrgb(colorPixels);
  dilateAtlasEdges(colorPixels, atlasSize, grid, 8);

  const colorTex = makeTexWithMips(
    generatePerCellMipmaps(colorPixels, atlasSize, grid), atlasSize, maxAniso, true,
  );
  return { colorTex, colorPixels, atlasSize, grid, cellPad: pad, center, radius };
}

// Tiny uniform aux atlases for a color-only impostor: flat world-up normal,
// uniform roughness/metalness, mid depth. Lets createImpostorMaterials run with
// a color-only bake (lighting reads ~flat normals → reads stylized-flat).
function makeFlatAuxTextures() {
  const mk = (r, g, b, a, srgb) => {
    const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1, THREE.RGBAFormat);
    t.needsUpdate = true; t.flipY = false;
    t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
    t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return {
    normalTex: mk(128, 255, 128, 255, false), // (0,1,0) world-up
    rmTex:     mk(230, 0, 0, 255, false),      // rough ~0.9, metal 0
    depthTex:  mk(0, 0, 0, 255, false),  // depth 0 -> ao 1 (no spurious AO dim on relit impostor)
  };
}

export {
  BAKE_SPHERE_MARGIN,
  bakeAtlases,
  bakeColorAtlasFromObject,
  makeFlatAuxTextures,
  createImpostorMaterials,
  hemiOctaGridToDir,
  fullOctaGridToDir,
  hemiOctaEncodeCPU,
  countTris,
};
export const STORAGE_KEY = "octa-v2-state";
export const LEGACY_STORAGE_KEY = "octa-v3-state";
export const QUALITY_PRESETS = {
  Low:    { useBary: 0, useParallax: 0, edgeSmooth: 1.2 },
  Medium: { useBary: 1, useParallax: 0, edgeSmooth: 1.5 },
  High:   { useBary: 1, useParallax: 1, edgeSmooth: 1.5 },
};
export function loadV3State() {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ||
      localStorage.getItem(LEGACY_STORAGE_KEY) ||
      "{}";
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}
