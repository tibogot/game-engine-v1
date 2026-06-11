/**
 * Procedural collectibles (coin / heart / key) — shared geometry + material per kind.
 *
 * Design goals
 *   - Zero per-instance shader compile: one MeshBasicNodeMaterial per kind, shared across all instances.
 *   - Zero per-instance geometry alloc: one buffer geometry per kind, built lazily on first use.
 *   - Per-instance state limited to transform + spin/bob phase.
 *   - Shadows preserved (cylinders/hearts/keys cast normal shadows via depth pass).
 *   - GLB extensibility: `registerGlbCollectibleKind()` hangs a custom kind off the same registry,
 *     so a future Treasure/Weapon GLB plugs in without touching the runtime or the props pipeline.
 *
 * Returns the same shape as flagFactory: { group, update, dispose, setParam, getParams, kind, pickupRadius, burstColor }.
 * Color / emissive / intensity are kind-level (shared), so per-instance setParam for those is a no-op;
 * spin/bob params remain per-instance because they're tied to mesh.userData state.
 */
import * as THREE from "three";
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from "three";
import {
  uniform, float, mix, abs, sin, time, normalView, oneMinus, vec3,
  materialEmissive,
} from "three/tsl";

/* ─────────── module-level kind registry ─────────── */

/** Map<kindName, KindAssets> */
const _kinds = new Map();

/**
 * KindAssets shape:
 *   buildGroup(params) → THREE.Group   // creates a new group of shared-geo meshes for one instance
 *   defaults: object                   // default params (only animation params consulted at runtime)
 *   pickupRadius: number               // default pickup radius
 *   burstColor: THREE.Color            // shared burst tint
 *   baseY: number                      // float offset above ground
 *   sharedAssets: () => void           // ensures geo+mat are built (idempotent)
 *   dispose: () => void                // disposes shared geo+mat (called at app shutdown)
 */
function _registerKind(name, kindAssets) {
  _kinds.set(name, kindAssets);
}

/** Internal helper — build a kind-shared "glow basic" material once per kind. */
function _buildSharedMaterial({ baseColor, emissive, intensity, rimStrength }) {
  const mat = new MeshBasicNodeMaterial({
    toneMapped: true,
  });
  const uBase = uniform(new THREE.Color(baseColor));
  const uEmissive = uniform(new THREE.Color(emissive));
  const uIntensity = uniform(intensity);
  const uRim = uniform(rimStrength);

  // Pulse uses the global TSL time — all instances of this kind pulse in sync.
  const pulse = mix(float(0.7), float(1.3), sin(time.mul(3.0)).mul(0.5).add(0.5));
  const rim = oneMinus(abs(normalView.z)).pow(2.0);

  mat.colorNode = uBase
    .add(uEmissive.mul(uIntensity).mul(pulse))
    .add(uEmissive.mul(rim).mul(uRim));

  // Material is shared, but we expose its uniforms for kind-level adjustment.
  mat.userData = { uBase, uEmissive, uIntensity, uRim };
  return mat;
}

/* ─────────── shared animation: spin + bob (per-instance state) ─────────── */

function _applySpinBob(obj, opts) {
  const { spinSpeed, bobAmp, bobSpeed, baseY } = opts;
  let t = Math.random() * 100;
  obj.userData._anim = (dt) => {
    t += dt;
    obj.rotation.y += spinSpeed * dt;
    obj.position.y = baseY + Math.sin(t * bobSpeed) * bobAmp;
  };
}

/* ─────────── COIN ─────────── */

export const COIN_DEFAULTS = {
  radius: 0.4,
  thickness: 0.08,
  color: "#ffcc33",
  emissive: "#ffaa00",
  intensity: 1.0,
  spinSpeed: 2.2,
  bobAmp: 0.15,
  bobSpeed: 1.6,
  pickupRadius: 1.2,
};

export function coinBoundingBox(params) {
  const p = { ...COIN_DEFAULTS, ...params };
  const r = p.radius;
  return new THREE.Box3(
    new THREE.Vector3(-r, 0, -r),
    new THREE.Vector3(r, p.radius * 2 + p.bobAmp, r),
  );
}

let _coinShared = null;
function _coinAssets() {
  if (_coinShared) return _coinShared;
  const r = COIN_DEFAULTS.radius;
  const geo = new THREE.CylinderGeometry(r, r, COIN_DEFAULTS.thickness, 32, 1);
  geo.rotateX(Math.PI / 2);
  const mat = _buildSharedMaterial({
    baseColor: COIN_DEFAULTS.color,
    emissive: COIN_DEFAULTS.emissive,
    intensity: COIN_DEFAULTS.intensity,
    rimStrength: 0.8,
  });
  _coinShared = { geo, mat };
  return _coinShared;
}

export function createCoinProp(params = {}) {
  const p = { ...COIN_DEFAULTS, ...params };
  const { geo, mat } = _coinAssets();

  const baseY = p.radius + 0.2;
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.position.y = baseY;
  _applySpinBob(mesh, { spinSpeed: p.spinSpeed, bobAmp: p.bobAmp, bobSpeed: p.bobSpeed, baseY });
  group.add(mesh);

  function update(dt) { mesh.userData._anim?.(dt); }
  function dispose() { /* shared assets, do not dispose */ }
  function setParam(key, value) {
    if (key === "pickupRadius") api.pickupRadius = value;
    // spin/bob params can be live-tuned via re-applying anim
    else if (key === "spinSpeed" || key === "bobAmp" || key === "bobSpeed") {
      p[key] = value;
      _applySpinBob(mesh, { spinSpeed: p.spinSpeed, bobAmp: p.bobAmp, bobSpeed: p.bobSpeed, baseY });
    }
    // color/emissive/intensity are kind-level; ignored per-instance to preserve material sharing.
  }
  function getParams() { return { ...p }; }

  const api = {
    group, update, dispose, setParam, getParams,
    kind: "coin",
    pickupRadius: p.pickupRadius,
    burstColor: new THREE.Color(COIN_DEFAULTS.emissive),
  };
  return api;
}

/* ─────────── HEART ─────────── */

export const HEART_DEFAULTS = {
  size: 0.45,
  color: "#ff4d6d",
  emissive: "#ff1f4f",
  intensity: 1.2,
  spinSpeed: 1.4,
  bobAmp: 0.18,
  bobSpeed: 1.4,
  pickupRadius: 1.4,
};

export function heartBoundingBox(params) {
  const p = { ...HEART_DEFAULTS, ...params };
  const s = p.size;
  return new THREE.Box3(
    new THREE.Vector3(-s, 0, -s * 0.4),
    new THREE.Vector3(s, p.size * 2 + p.bobAmp, s * 0.4),
  );
}

function _buildHeartGeometry(size) {
  const shape = new THREE.Shape();
  const s = size;
  shape.moveTo(0, -s * 0.6);
  shape.bezierCurveTo(s * 1.4, s * 0.3, s * 0.4, s * 1.3, 0, s * 0.6);
  shape.bezierCurveTo(-s * 0.4, s * 1.3, -s * 1.4, s * 0.3, 0, -s * 0.6);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: s * 0.35,
    bevelEnabled: true,
    bevelThickness: s * 0.08,
    bevelSize: s * 0.08,
    bevelSegments: 3,
    curveSegments: 18,
  });
  geo.center();
  geo.computeVertexNormals();
  return geo;
}

let _heartShared = null;
function _heartAssets() {
  if (_heartShared) return _heartShared;
  const geo = _buildHeartGeometry(HEART_DEFAULTS.size);
  const mat = _buildSharedMaterial({
    baseColor: HEART_DEFAULTS.color,
    emissive: HEART_DEFAULTS.emissive,
    intensity: HEART_DEFAULTS.intensity,
    rimStrength: 1.0,
  });
  _heartShared = { geo, mat };
  return _heartShared;
}

export function createHeartProp(params = {}) {
  const p = { ...HEART_DEFAULTS, ...params };
  const { geo, mat } = _heartAssets();

  const baseY = p.size + 0.2;
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.position.y = baseY;
  _applySpinBob(mesh, { spinSpeed: p.spinSpeed, bobAmp: p.bobAmp, bobSpeed: p.bobSpeed, baseY });
  group.add(mesh);

  function update(dt) { mesh.userData._anim?.(dt); }
  function dispose() { /* shared assets, do not dispose */ }
  function setParam(key, value) {
    if (key === "pickupRadius") api.pickupRadius = value;
    else if (key === "spinSpeed" || key === "bobAmp" || key === "bobSpeed") {
      p[key] = value;
      _applySpinBob(mesh, { spinSpeed: p.spinSpeed, bobAmp: p.bobAmp, bobSpeed: p.bobSpeed, baseY });
    }
  }
  function getParams() { return { ...p }; }

  const api = {
    group, update, dispose, setParam, getParams,
    kind: "heart",
    pickupRadius: p.pickupRadius,
    burstColor: new THREE.Color(HEART_DEFAULTS.emissive),
  };
  return api;
}

/* ─────────── KEY ─────────── */

export const KEY_DEFAULTS = {
  size: 0.5,
  color: "#dfe4ff",
  emissive: "#7aa8ff",
  intensity: 0.9,
  spinSpeed: 1.8,
  bobAmp: 0.12,
  bobSpeed: 1.8,
  pickupRadius: 1.1,
};

export function keyBoundingBox(params) {
  const p = { ...KEY_DEFAULTS, ...params };
  const s = p.size;
  return new THREE.Box3(
    new THREE.Vector3(-s * 0.3, 0, -s * 0.6),
    new THREE.Vector3(s * 0.3, p.size * 2 + p.bobAmp, s * 0.6),
  );
}

/** Build the key as ONE merged BufferGeometry (4 parts → single draw per instance). */
function _buildKeyGeometry(size) {
  const s = size;
  const parts = [];

  const ring = new THREE.TorusGeometry(s * 0.28, s * 0.07, 12, 24);
  ring.translate(0, s * 0.3, 0);
  parts.push(ring);

  const shaft = new THREE.CylinderGeometry(s * 0.05, s * 0.05, s * 0.7, 10);
  shaft.translate(0, s * 0.3 - s * 0.45, 0);
  parts.push(shaft);

  const tooth1 = new THREE.BoxGeometry(s * 0.18, s * 0.06, s * 0.08);
  tooth1.translate(s * 0.09, s * 0.3 - s * 0.62, 0);
  parts.push(tooth1);

  const tooth2 = new THREE.BoxGeometry(s * 0.13, s * 0.06, s * 0.08);
  tooth2.translate(s * 0.07, s * 0.3 - s * 0.78, 0);
  parts.push(tooth2);

  // Merge — manually concat positions/normals/indices to avoid needing BufferGeometryUtils import.
  const merged = _mergeBufferGeometries(parts);
  for (const g of parts) g.dispose();
  return merged;
}

function _mergeBufferGeometries(geos) {
  let totalVerts = 0;
  let totalIndices = 0;
  for (const g of geos) {
    totalVerts += g.attributes.position.count;
    totalIndices += g.index ? g.index.count : g.attributes.position.count;
  }
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);

  let vOff = 0, iOff = 0;
  for (const g of geos) {
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    positions.set(p, vOff * 3);
    normals.set(n, vOff * 3);
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) indices[iOff + i] = src[i] + vOff;
      iOff += src.length;
    } else {
      for (let i = 0; i < g.attributes.position.count; i++) indices[iOff + i] = vOff + i;
      iOff += g.attributes.position.count;
    }
    vOff += g.attributes.position.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

let _keyShared = null;
function _keyAssets() {
  if (_keyShared) return _keyShared;
  const geo = _buildKeyGeometry(KEY_DEFAULTS.size);
  const mat = _buildSharedMaterial({
    baseColor: KEY_DEFAULTS.color,
    emissive: KEY_DEFAULTS.emissive,
    intensity: KEY_DEFAULTS.intensity,
    rimStrength: 0.7,
  });
  _keyShared = { geo, mat };
  return _keyShared;
}

export function createKeyProp(params = {}) {
  const p = { ...KEY_DEFAULTS, ...params };
  const { geo, mat } = _keyAssets();

  const baseY = p.size + 0.3;
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.position.y = baseY;
  _applySpinBob(mesh, { spinSpeed: p.spinSpeed, bobAmp: p.bobAmp, bobSpeed: p.bobSpeed, baseY });
  group.add(mesh);

  function update(dt) { mesh.userData._anim?.(dt); }
  function dispose() { /* shared assets, do not dispose */ }
  function setParam(key, value) {
    if (key === "pickupRadius") api.pickupRadius = value;
    else if (key === "spinSpeed" || key === "bobAmp" || key === "bobSpeed") {
      p[key] = value;
      _applySpinBob(mesh, { spinSpeed: p.spinSpeed, bobAmp: p.bobAmp, bobSpeed: p.bobSpeed, baseY });
    }
  }
  function getParams() { return { ...p }; }

  const api = {
    group, update, dispose, setParam, getParams,
    kind: "key",
    pickupRadius: p.pickupRadius,
    burstColor: new THREE.Color(KEY_DEFAULTS.emissive),
  };
  return api;
}

/* ─────────── GLB-collectible extension hook (future) ───────────
 *
 * To add a GLB-based collectible (chest, sword, etc.):
 *
 *   import { registerGlbCollectibleKind } from "./collectibleFactory.js";
 *   const treasure = registerGlbCollectibleKind("Treasure", gltfScene, {
 *     pickupRadius: 1.5,
 *     burstColor: "#ffd56a",
 *     spinSpeed: 1.0,
 *     bobAmp: 0.1,
 *     bobSpeed: 1.0,
 *   });
 *   // Then in main.js: livePropManager.registerFactory(treasure.factoryId, treasure.create);
 *   //                  defs[name] = { factoryId, defaults, bbox }
 *   // and add a button to the Add Live Prop section.
 *
 * The runtime (collectibleRuntime.js) only checks for `kind` membership in COLLECTIBLE_KINDS,
 * so we register the new kind name there too.
 */
export function registerGlbCollectibleKind(name, gltfScene, opts = {}) {
  const {
    pickupRadius = 1.3,
    burstColor = "#ffffff",
    spinSpeed = 1.5,
    bobAmp = 0.15,
    bobSpeed = 1.4,
    baseYOffset = 0.3,
    glow = true,           // attach rim Fresnel + pulse emissive overlay
    glowIntensity = 0.55,  // overlay strength (additive on top of any existing emissive)
  } = opts;

  const kindKey = name.toLowerCase();
  COLLECTIBLE_KINDS.add(kindKey);

  // Pre-extract shared meshes from the GLB scene; we'll clone references at instance time.
  // Each unique material+geometry pair already lives in the GLB — we don't duplicate them.
  const submeshes = [];
  gltfScene.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(gltfScene.matrixWorld).invert();
  gltfScene.traverse((child) => {
    if (!child.isMesh) return;
    const localMatrix = new THREE.Matrix4().multiplyMatrices(rootInv, child.matrixWorld);
    submeshes.push({ geometry: child.geometry, material: child.material, localMatrix });
  });

  const mergedBox = new THREE.Box3();
  for (const sm of submeshes) {
    if (!sm.geometry.boundingBox) sm.geometry.computeBoundingBox();
    const localBox = sm.geometry.boundingBox.clone().applyMatrix4(sm.localMatrix);
    mergedBox.union(localBox);
  }
  const baseY = -mergedBox.min.y + baseYOffset;

  const defaults = { pickupRadius, spinSpeed, bobAmp, bobSpeed };
  const burstColorObj = new THREE.Color(burstColor);

  /**
   * Glow-material cache. One node material per UNIQUE source material in the GLB —
   * shared across all instances of this kind. Renderer batches identical materials,
   * so this preserves draw-call count and triggers only N shader compiles (N = unique mats)
   * at import time rather than per-instance.
   */
  const glowMatCache = new Map();
  function _glowMatFor(srcMat) {
    if (!glow) return srcMat;
    if (glowMatCache.has(srcMat)) return glowMatCache.get(srcMat);

    const node = new MeshStandardNodeMaterial();
    // Copy PBR properties — texture maps share references (no extra memory).
    if (srcMat.color)        node.color.copy(srcMat.color);
    if (srcMat.emissive)     node.emissive.copy(srcMat.emissive);
    if ("emissiveIntensity" in srcMat) node.emissiveIntensity = srcMat.emissiveIntensity;
    if ("roughness" in srcMat) node.roughness = srcMat.roughness;
    if ("metalness" in srcMat) node.metalness = srcMat.metalness;
    if ("opacity" in srcMat)   node.opacity   = srcMat.opacity;
    if (srcMat.transparent)    node.transparent = true;
    if (srcMat.alphaTest)      node.alphaTest = srcMat.alphaTest;
    if (srcMat.side != null)   node.side = srcMat.side;
    if (srcMat.map)          node.map = srcMat.map;
    if (srcMat.normalMap)    node.normalMap = srcMat.normalMap;
    if (srcMat.roughnessMap) node.roughnessMap = srcMat.roughnessMap;
    if (srcMat.metalnessMap) node.metalnessMap = srcMat.metalnessMap;
    if (srcMat.aoMap)        node.aoMap = srcMat.aoMap;
    if (srcMat.emissiveMap)  node.emissiveMap = srcMat.emissiveMap;

    // Emissive overlay: keep the GLB's existing emissive contribution, ADD rim + pulse on top.
    const uGlowColor = uniform(burstColorObj.clone());
    const uGlow = uniform(glowIntensity);
    const pulse = mix(float(0.7), float(1.3), sin(time.mul(3.0)).mul(0.5).add(0.5));
    const rim = oneMinus(abs(normalView.z)).pow(2.0);
    node.emissiveNode = materialEmissive.add(uGlowColor.mul(uGlow).mul(pulse).mul(rim));

    glowMatCache.set(srcMat, node);
    return node;
  }

  function create(params = {}) {
    const p = { ...defaults, ...params };
    const group = new THREE.Group();
    const inner = new THREE.Group();
    for (const sm of submeshes) {
      const m = new THREE.Mesh(sm.geometry, _glowMatFor(sm.material));
      m.applyMatrix4(sm.localMatrix);
      m.castShadow = true;
      m.receiveShadow = false;
      inner.add(m);
    }
    inner.position.y = baseY;
    _applySpinBob(inner, { spinSpeed: p.spinSpeed, bobAmp: p.bobAmp, bobSpeed: p.bobSpeed, baseY });
    group.add(inner);

    function update(dt) { inner.userData._anim?.(dt); }
    function dispose() { /* GLB assets are shared and owned externally */ }
    function setParam(key, value) {
      if (key === "pickupRadius") api.pickupRadius = value;
      else if (key === "spinSpeed" || key === "bobAmp" || key === "bobSpeed") {
        p[key] = value;
        _applySpinBob(inner, { spinSpeed: p.spinSpeed, bobAmp: p.bobAmp, bobSpeed: p.bobSpeed, baseY });
      }
    }
    function getParams() { return { ...p }; }
    const api = {
      group, update, dispose, setParam, getParams,
      kind: kindKey,
      pickupRadius: p.pickupRadius,
      burstColor: burstColorObj.clone(),
    };
    return api;
  }

  return {
    name,
    kind: kindKey,
    factoryId: kindKey,
    defaults,
    boundingBox: () => mergedBox.clone(),
    create,
  };
}

/* ─────────── meta ─────────── */

export const COLLECTIBLE_KINDS = new Set(["coin", "heart", "key"]);

/** Optional: dispose shared assets at app shutdown. Not strictly needed (browser cleans up). */
export function disposeAllCollectibleAssets() {
  if (_coinShared)  { _coinShared.geo.dispose();  _coinShared.mat.dispose();  _coinShared = null; }
  if (_heartShared) { _heartShared.geo.dispose(); _heartShared.mat.dispose(); _heartShared = null; }
  if (_keyShared)   { _keyShared.geo.dispose();   _keyShared.mat.dispose();   _keyShared = null; }
}
