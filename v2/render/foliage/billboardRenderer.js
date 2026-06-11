/**
 * BillboardRenderer — per-chunk instanced billboard foliage with 3-tier geometry LOD.
 *
 * Each chunk × slot gets lod0/lod1/lod2 InstancedMeshes (fewer cross planes at distance).
 * Shared geometry + material per slot; matrices upload on FoliageStore chunk gen bump.
 */
import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { parseChunkKey, chunkMinWorldX, chunkMinWorldZ } from "../../core/terrain/chunkMath.js";
import {
  Fn,
  uv,
  vec3,
  vec4,
  sin,
  uniform,
  texture,
  positionLocal,
  color,
  normalize,
  dot,
  cameraPosition,
  positionWorld,
  max,
  mix,
} from "three/tsl";
import { detectAlphaChannel } from "./foliageMaterial.js";

const LOD_KEYS = ["lod0", "lod1", "lod2"];

function stableHash01(i, seed) {
  const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453123;
  return x - Math.floor(x);
}

function planeYawRadians(i, count, spread) {
  if (count <= 0) return 0;
  if (spread === "half") return (i / count) * Math.PI;
  return (i / count) * Math.PI * 2;
}

function planeTiltRadians(i, count, tilt, tiltMode, seed) {
  if (tiltMode === "symmetric") {
    if (count <= 1) return 0;
    const u = i / (count - 1);
    return (u - 0.5) * 2 * tilt;
  }
  return (stableHash01(i, seed) - 0.5) * 2 * tilt;
}

/** Near = full planes; mid = 2 (or 1 if slot only has 1); far = single card. */
function planeCountForLodTier(fullCount, tier) {
  const n = Math.max(1, Math.floor(fullCount));
  if (tier === 0) return n;
  if (tier === 1) return n >= 3 ? 2 : n;
  return 1;
}

export class BillboardRenderer {
  constructor(scene, config) {
    this.scene = scene;
    this.config = config;
    /**
     * slotRender[slotIdx] = {
     *   geometries: { lod0, lod1, lod2 },
     *   material, uniforms, textureObj
     * } | null
     */
    this.slotRender = [];

    /** chunkMeshes: Map<key, { gen, slots: Map<slotIdx, { lod0, lod1, lod2 }> }> */
    this._chunkMeshes = new Map();

    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._box = new THREE.Box3();
    this._worldMat = new THREE.Matrix4();
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._scl = new THREE.Vector3();
    this._yAxis = new THREE.Vector3(0, 1, 0);
    this._sunDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
  }

  _buildGeometry(slot) {
    const geometries = [];
    const n = Math.max(1, Math.floor(slot.planeCount));
    for (let i = 0; i < n; i++) {
      const p = new THREE.PlaneGeometry(slot.width, slot.height);
      p.translate(0, slot.height / 2, 0);
      p.rotateY(planeYawRadians(i, n, slot.planeSpread));
      p.rotateX(planeTiltRadians(i, n, slot.tilt, slot.tiltMode, slot.structureSeed));
      geometries.push(p);
    }
    const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
    for (const g of geometries) g.dispose();
    return merged;
  }

  _buildLodGeometries(slot) {
    const full = Math.max(1, Math.floor(slot.planeCount));
    return {
      lod0: this._buildGeometry({ ...slot, planeCount: planeCountForLodTier(full, 0) }),
      lod1: this._buildGeometry({ ...slot, planeCount: planeCountForLodTier(full, 1) }),
      lod2: this._buildGeometry({ ...slot, planeCount: planeCountForLodTier(full, 2) }),
    };
  }

  _disposeLodGeometries(geometries) {
    if (!geometries) return;
    for (const k of LOD_KEYS) geometries[k]?.dispose();
  }

  _createMaterial(slot) {
    const u = {
      time: uniform(0),
      swaySpeed: uniform(slot.swaySpeed ?? 1.2),
      swayStrength: uniform(slot.swayStrength ?? 0.12),
      sssIntensity: uniform(slot.sssIntensity ?? 1.5),
      groundOcclusion: uniform(slot.groundOcclusion ?? 0.7),
      normalBending: uniform(slot.normalBending ?? 0.6),
      colorTint: uniform(color(slot.colorTint ?? "#ffffff")),
      sunDir: uniform(this._sunDir.clone()),
      height: uniform(slot.height ?? 2.0),
      // 0 = cutout from .r (grayscale / RGB masks), 1 = .a (RGBA foliage).
      maskInAlpha: uniform(slot.maskInAlpha ?? 0.0),
    };

    const material = new THREE.MeshStandardNodeMaterial({
      side: THREE.DoubleSide,
      alphaTest: slot.alphaTest ?? 0.5,
      transparent: false,
      roughness: slot.roughness ?? 0.85,
      metalness: 0,
    });

    material.normalNode = Fn(() => {
      const viewDir = normalize(cameraPosition.sub(positionWorld));
      const upBias = vec3(0, 0.85, 0);
      const viewBias = vec3(viewDir.x.mul(0.3), 0, viewDir.z.mul(0.3));
      return normalize(upBias.add(viewBias));
    })();

    const defaultColor = vec4(0.28, 0.62, 0.22, 1.0);

    material.colorNode = Fn(() => {
      const tex = slot._textureNode ? slot._textureNode : defaultColor;
      const mask = mix(tex.r, tex.a, u.maskInAlpha);
      const ao = uv().y.smoothstep(0.0, u.groundOcclusion).add(0.15);
      const lightDir = normalize(u.sunDir);
      const viewDir = normalize(cameraPosition.sub(positionWorld));
      const backlit = max(0.0, dot(viewDir, lightDir.negate()));
      const backlitBoost = backlit.pow(1.5).mul(0.3).add(1.0);
      return vec4(tex.rgb.mul(u.colorTint).mul(ao).mul(backlitBoost), mask);
    })();

    material.emissiveNode = Fn(() => {
      const tex = slot._textureNode ? slot._textureNode : defaultColor;
      const mask = mix(tex.r, tex.a, u.maskInAlpha);
      const lightDir = normalize(u.sunDir);
      const viewDir = normalize(cameraPosition.sub(positionWorld));
      const translucency = max(0.0, dot(viewDir, lightDir.negate()));
      const translucentGlow = translucency.pow(1.2);
      const heightFade = uv().y.smoothstep(0.05, 0.6);
      const sssGlow = tex.rgb.mul(translucentGlow).mul(u.sssIntensity).mul(heightFade);
      return sssGlow.mul(mask);
    })();

    material.positionNode = Fn(() => {
      const wind = sin(u.time.mul(u.swaySpeed))
        .mul(u.swayStrength)
        .mul(uv().y.pow(1.5));
      return vec3(
        positionLocal.x.add(wind),
        positionLocal.y,
        positionLocal.z.add(wind),
      );
    })();

    return { material, uniforms: u };
  }

  _applyMaskChannel(uniforms, tex) {
    if (!uniforms?.maskInAlpha || !tex?.image) return;
    uniforms.maskInAlpha.value = detectAlphaChannel(tex.image) ? 1.0 : 0.0;
  }

  _removeChunkMesh(im) {
    if (!im) return;
    this.scene.remove(im);
    im.geometry = null;
    im.material = null;
  }

  _disposeSlotMeshes(slotMeshes) {
    if (!slotMeshes) return;
    for (const k of LOD_KEYS) this._removeChunkMesh(slotMeshes[k]);
  }

  _disposeChunkEntry(key) {
    const entry = this._chunkMeshes.get(key);
    if (!entry) return;
    for (const sm of entry.slots.values()) {
      this._disposeSlotMeshes(sm);
    }
    this._chunkMeshes.delete(key);
  }

  _disposeChunkMeshesForSlot(slotIdx) {
    for (const [, entry] of this._chunkMeshes) {
      const sm = entry.slots.get(slotIdx);
      if (sm) {
        this._disposeSlotMeshes(sm);
        entry.slots.delete(slotIdx);
      }
    }
  }

  _invalidateAllChunks() {
    for (const [, entry] of this._chunkMeshes) {
      entry.gen = -1;
    }
  }

  _uploadInstances(im, list) {
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const f = list[i];
      this._pos.set(f.x, f.y ?? 0, f.z);
      this._quat.setFromAxisAngle(this._yAxis, f.rotY);
      this._scl.setScalar(f.scale);
      this._worldMat.compose(this._pos, this._quat, this._scl);
      im.setMatrixAt(i, this._worldMat);
    }
    im.count = n;
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
  }

  rebuildSlot(slotIdx, slot) {
    const prevTex = this.slotRender[slotIdx]?.textureObj ?? null;
    this._disposeChunkMeshesForSlot(slotIdx);

    const prev = this.slotRender[slotIdx];
    if (prev) {
      this._disposeLodGeometries(prev.geometries);
      prev.material.dispose();
    }
    while (this.slotRender.length <= slotIdx) this.slotRender.push(null);
    this.slotRender[slotIdx] = null;

    if (!slot || !slot.enabled) {
      this._invalidateAllChunks();
      return;
    }

    const geometries = this._buildLodGeometries(slot);
    const slotForMat =
      prevTex != null ? { ...slot, _textureNode: texture(prevTex, uv()) } : slot;
    const { material, uniforms } = this._createMaterial(slotForMat);
    this._applyMaskChannel(uniforms, prevTex);

    this.slotRender[slotIdx] = {
      geometries,
      material,
      uniforms,
      textureObj: prevTex,
    };
    this._invalidateAllChunks();
  }

  setSlotTexture(slotIdx, tex, slotConfig = null) {
    const sr = this.slotRender[slotIdx];
    if (!sr) return;
    sr.textureObj = tex;
    const slot = { ...(slotConfig || {}), _textureNode: tex ? texture(tex, uv()) : null };
    const { material, uniforms } = this._createMaterial(slot);
    this._applyMaskChannel(uniforms, tex);
    sr.material.dispose();
    sr.material = material;
    sr.uniforms = uniforms;
    for (const [, entry] of this._chunkMeshes) {
      const sm = entry.slots.get(slotIdx);
      if (!sm) continue;
      for (const k of LOD_KEYS) {
        if (sm[k]) sm[k].material = material;
      }
    }
  }

  updateSlotUniforms(slotIdx, slot) {
    const sr = this.slotRender[slotIdx];
    if (!sr || !sr.uniforms) return;
    const u = sr.uniforms;
    if (slot.swaySpeed !== undefined) u.swaySpeed.value = slot.swaySpeed;
    if (slot.swayStrength !== undefined) u.swayStrength.value = slot.swayStrength;
    if (slot.sssIntensity !== undefined) u.sssIntensity.value = slot.sssIntensity;
    if (slot.groundOcclusion !== undefined) u.groundOcclusion.value = slot.groundOcclusion;
    if (slot.normalBending !== undefined) u.normalBending.value = slot.normalBending;
    if (slot.colorTint !== undefined) u.colorTint.value.set(slot.colorTint);
  }

  _disposeSlot(slotIdx) {
    this._disposeChunkMeshesForSlot(slotIdx);
    const sr = this.slotRender[slotIdx];
    if (!sr) return;
    this._disposeLodGeometries(sr.geometries);
    sr.material.dispose();
    this.slotRender[slotIdx] = null;
  }

  _rebuildChunkMeshes(key, items, foliageSlots) {
    let entry = this._chunkMeshes.get(key);
    if (entry) {
      for (const sm of entry.slots.values()) {
        this._disposeSlotMeshes(sm);
      }
      entry.slots.clear();
    } else {
      entry = { gen: -1, slots: new Map() };
      this._chunkMeshes.set(key, entry);
    }

    const bySlot = new Map();
    for (const f of items) {
      const si = f.slotIdx;
      if (!bySlot.has(si)) bySlot.set(si, []);
      bySlot.get(si).push(f);
    }

    for (const [slotIdx, list] of bySlot) {
      const sr = this.slotRender[slotIdx];
      const slotCfg = foliageSlots[slotIdx];
      if (!sr || !slotCfg?.enabled) continue;

      const n = list.length;
      const slotMeshes = { lod0: null, lod1: null, lod2: null };

      for (const k of LOD_KEYS) {
        const im = new THREE.InstancedMesh(sr.geometries[k], sr.material, n);
        im.castShadow = false;
        im.receiveShadow = true;
        im.frustumCulled = true;
        this._uploadInstances(im, list);
        this.scene.add(im);
        slotMeshes[k] = im;
      }

      entry.slots.set(slotIdx, slotMeshes);
    }
  }

  _applyChunkLodVisibility(slotMeshes, dist, lodCfg, showChunk) {
    const lod0D = lodCfg.lod0Distance ?? 80;
    const lod1D = lodCfg.lod1Distance ?? 200;
    const fadeD = lodCfg.fadeOutDistance ?? 600;

    let activeLod = null;
    if (showChunk && dist <= fadeD) {
      if (dist > lod1D) activeLod = "lod2";
      else if (dist > lod0D) activeLod = "lod1";
      else activeLod = "lod0";
    }

    for (const k of LOD_KEYS) {
      const im = slotMeshes[k];
      if (im) im.visible = activeLod === k;
    }
  }

  /**
   * @param {import("../../core/foliage/foliageStore.js").FoliageStore} foliageStore
   * @param {THREE.Camera} camera
   * @param {{ lod0Distance?: number, lod1Distance?: number, fadeOutDistance?: number }} lodCfg
   * @param {object[]} foliageSlots
   */
  update(foliageStore, camera, lodCfg, foliageSlots) {
    this._projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projScreen);

    const chunkSize = this.config.world.chunkSize;
    const camX = camera.position.x;
    const camZ = camera.position.z;
    const activeKeys = new Set();

    for (const [key, items] of foliageStore.chunks) {
      if (!items || items.length === 0) continue;
      activeKeys.add(key);

      const { cx, cz } = parseChunkKey(key);
      const minX = chunkMinWorldX(cx, this.config);
      const minZ = chunkMinWorldZ(cz, this.config);
      const chunkCX = minX + chunkSize * 0.5;
      const chunkCZ = minZ + chunkSize * 0.5;

      const dcx = chunkCX - camX;
      const dcz = chunkCZ - camZ;
      const chunkDist = Math.sqrt(dcx * dcx + dcz * dcz);

      const gen = foliageStore.getGen(key);
      let entry = this._chunkMeshes.get(key);
      if (!entry || entry.gen !== gen) {
        this._rebuildChunkMeshes(key, items, foliageSlots);
        entry = this._chunkMeshes.get(key);
        if (entry) entry.gen = gen;
      }

      if (!entry) continue;

      this._box.min.set(minX, -100, minZ);
      this._box.max.set(minX + chunkSize, 600, minZ + chunkSize);
      const inFrustum = this._frustum.intersectsBox(this._box);
      const showChunk = inFrustum;

      for (const sm of entry.slots.values()) {
        this._applyChunkLodVisibility(sm, chunkDist, lodCfg, showChunk);
      }
    }

    if (this._chunkMeshes.size > activeKeys.size + 16) {
      for (const key of [...this._chunkMeshes.keys()]) {
        if (!activeKeys.has(key)) {
          this._disposeChunkEntry(key);
        }
      }
    }
  }

  updateTime(t) {
    for (const sr of this.slotRender) {
      if (sr?.uniforms?.time) sr.uniforms.time.value = t;
    }
  }

  updateSunDirection(dir) {
    this._sunDir.copy(dir);
    for (const sr of this.slotRender) {
      if (sr?.uniforms?.sunDir) {
        sr.uniforms.sunDir.value.copy(dir);
      }
    }
  }

  dispose() {
    for (const key of [...this._chunkMeshes.keys()]) {
      this._disposeChunkEntry(key);
    }
    for (let i = 0; i < this.slotRender.length; i++) {
      this._disposeSlot(i);
    }
  }
}
