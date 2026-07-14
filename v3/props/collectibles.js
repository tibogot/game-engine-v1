/**
 * Collectible kinds (coin / heart / key / imported GLB) — v3 native.
 *
 * A "kind" is a shared geometry + shared node material. Every instance of a kind is drawn
 * by ONE draw call (see collectibleField.js) and animated entirely on the GPU:
 *
 *   spin, bob, magnet-pull toward the player, pickup pop, distance cull
 *
 * all read per-instance attributes, so the CPU never writes a transform per frame — instance
 * buffers are uploaded only when props are placed/edited, and a single float when one is picked up.
 *
 * That is the main difference from v2, where each collectible was a THREE.Group whose matrix was
 * recomposed on the CPU every frame.
 */
import * as THREE from "three";
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from "three";
import {
  Fn, attribute, uniform, positionLocal, normalLocal, cameraPosition,
  float, vec3, sin, cos, cross, abs, max, clamp, smoothstep, mix, step, length,
  time, oneMinus, normalView, materialEmissive,
} from "three/tsl";
import { applyBloomMRT } from "../render/bloomMRT.js";

/* ─────────── shared uniforms (one set for every kind) ─────────── */

export const collectibleUniforms = {
  /** Seconds since app start; also the clock pickup birth-times are stamped against. */
  clock: uniform(0),
  /** Player position; magnet pull is measured from this. */
  player: uniform(new THREE.Vector3(0, -1e6, 0)),
  /** 1 while play mode is running — gates the magnet off in the editor. */
  playing: uniform(0),
  /** Magnet reach = pickupRadius * this. */
  magnetMult: uniform(2.4),
  /** Pickup pop duration (seconds). */
  pickupDur: uniform(0.24),
  /** Collectibles further than this from the camera collapse to zero area. */
  maxDist: uniform(400),
  /**
   * HDR multiplier into the emissive MRT buffer. This is bloom energy, NOT display
   * brightness — raising it makes the halo blaze without washing out the coin's own
   * surface. Shared by every kind, so one write retunes the whole field.
   */
  bloom: uniform(5.0),
};

/** Pickup-pop shape — matches the numbers the burst/sfx were tuned against. */
const POP_PEAK = 0.65;   // fraction of the anim spent inflating
const POP_SCALE = 1.6;
const POP_LIFT = 0.7;    // metres
const MAGNET_BITE = 0.92; // how far into the player the pull drags the collectible

/* ─────────── TSL helpers ─────────── */

const rotateY = (v, angle) => {
  const c = cos(angle);
  const s = sin(angle);
  return vec3(
    v.x.mul(c).add(v.z.mul(s)),
    v.y,
    v.z.mul(c).sub(v.x.mul(s)),
  );
};

/** Rotate v by quaternion q (xyzw). */
const rotateQuat = (q, v) => {
  const t = cross(q.xyz, v).mul(2);
  return v.add(t.mul(q.w)).add(cross(q.xyz, t));
};

/**
 * Build the vertex program shared by every collectible material.
 *
 * Per-instance attributes:
 *   aPos   vec4  (x, y, z, animation phase)
 *   aQuat  vec4  authored rotation
 *   aScl   vec4  (sx, sy, sz, pickupRadius)
 *   aAnim  vec4  (spinSpeed, bobAmp, bobSpeed, baseY)
 *   aBirth float  -2 = hidden, -1 = alive, >= 0 = clock time it was collected
 *
 * Also rewrites normalLocal so lighting/rim follow the spin.
 */
function collectibleVertex() {
  return Fn(() => {
    const aPos = attribute("aPos", "vec4");
    const aQuat = attribute("aQuat", "vec4");
    const aScl = attribute("aScl", "vec4");
    const aAnim = attribute("aAnim", "vec4");
    const aBirth = attribute("aBirth", "float");

    const clock = collectibleUniforms.clock;
    const t = clock.add(aPos.w);

    // --- pickup pop -------------------------------------------------------
    const collected = step(float(0), aBirth);            // 1 once picked up
    const hidden = step(aBirth, float(-1.5));            // 1 while explicitly hidden
    const p = clamp(clock.sub(aBirth).div(collectibleUniforms.pickupDur), 0, 1);
    const q1 = clamp(p.div(POP_PEAK), 0, 1);             // inflate 0 → 1
    const q2 = clamp(p.sub(POP_PEAK).div(1 - POP_PEAK), 0, 1); // shrink-out 0 → 1
    const popScale = mix(float(1), float(POP_SCALE), q1).mul(oneMinus(q2));
    const lift = q1.mul(POP_LIFT).mul(collected);

    // --- distance cull ----------------------------------------------------
    const camD = length(cameraPosition.xz.sub(aPos.xz));
    const inRange = oneMinus(step(collectibleUniforms.maxDist, camD));

    const scale = mix(float(1), popScale, collected).mul(oneMinus(hidden)).mul(inRange);

    // --- spin + bob (prop-local) ------------------------------------------
    const spin = aAnim.x.mul(t);
    const bob = sin(t.mul(aAnim.z)).mul(aAnim.y);

    const vLocal = rotateY(positionLocal.mul(scale), spin);
    const vBobbed = vec3(vLocal.x, vLocal.y.add(aAnim.w).add(bob).add(lift), vLocal.z);

    // --- authored TRS ------------------------------------------------------
    const world = rotateQuat(aQuat, vBobbed.mul(aScl.xyz)).add(aPos.xyz);

    // --- magnet pull (stateless: a function of distance, so it needs no CPU state) ---
    const center = vec3(aPos.x, aPos.y.add(aAnim.w), aPos.z);
    const toPlayer = collectibleUniforms.player.sub(center);
    const dxz = length(toPlayer.xz);
    const dySoft = max(abs(toPlayer.y).sub(2.0), 0);
    const dist = length(vec3(dxz, dySoft, 0));
    const pickR = aScl.w;
    const magR = pickR.mul(collectibleUniforms.magnetMult);
    // 0 outside the magnet → 1 at the pickup edge (smoothstep wants edge0 < edge1, so invert).
    const k = oneMinus(smoothstep(pickR, magR, dist)).pow(2);
    const pull = vec3(toPlayer.x, 0, toPlayer.z)
      .mul(k.mul(MAGNET_BITE).mul(collectibleUniforms.playing));

    // Normals follow the spin so the rim/lighting isn't frozen to the geometry.
    normalLocal.assign(rotateQuat(aQuat, rotateY(normalLocal, spin)));

    return world.add(pull);
  })();
}

/** Glow look shared by the procedural kinds: flat base + pulsing emissive + Fresnel rim. */
function buildGlowMaterial({ color, emissive, intensity, rim }) {
  const mat = new MeshBasicNodeMaterial({ toneMapped: true });
  const uBase = uniform(new THREE.Color(color));
  const uEmis = uniform(new THREE.Color(emissive));
  const uInt = uniform(intensity);
  const uRim = uniform(rim);

  const pulse = mix(float(0.7), float(1.3), sin(time.mul(3.0)).mul(0.5).add(0.5));
  const fresnel = oneMinus(abs(normalView.z)).pow(2.0);

  const glow = uEmis.mul(uInt).mul(pulse).add(uEmis.mul(fresnel).mul(uRim));
  mat.colorNode = uBase.add(glow);
  mat.positionNode = collectibleVertex();

  // v3 runs SELECTIVE bloom off the emissive MRT buffer, and an unlit material writes nothing
  // there by default — so the glow has to be published explicitly or coins stay matte.
  applyBloomMRT(mat, glow.mul(collectibleUniforms.bloom));

  mat.userData = { uBase, uEmis, uInt, uRim };
  return mat;
}

/* ─────────── procedural kinds ─────────── */

export const COIN_DEFAULTS = {
  radius: 0.4, color: "#ffcc33", emissive: "#ffaa00", intensity: 1.0,
  spinSpeed: 2.2, bobAmp: 0.15, bobSpeed: 1.6, pickupRadius: 1.2,
};
export const HEART_DEFAULTS = {
  size: 0.45, color: "#ff4d6d", emissive: "#ff1f4f", intensity: 1.2,
  spinSpeed: 1.4, bobAmp: 0.18, bobSpeed: 1.4, pickupRadius: 1.4,
};
export const KEY_DEFAULTS = {
  size: 0.5, color: "#dfe4ff", emissive: "#7aa8ff", intensity: 0.9,
  spinSpeed: 1.8, bobAmp: 0.12, bobSpeed: 1.8, pickupRadius: 1.1,
};

function coinGeometry() {
  const r = COIN_DEFAULTS.radius;
  const geo = new THREE.CylinderGeometry(r, r, 0.08, 24, 1);
  geo.rotateX(Math.PI / 2);
  return geo;
}

function heartGeometry() {
  const s = HEART_DEFAULTS.size;
  const shape = new THREE.Shape();
  shape.moveTo(0, -s * 0.6);
  shape.bezierCurveTo(s * 1.4, s * 0.3, s * 0.4, s * 1.3, 0, s * 0.6);
  shape.bezierCurveTo(-s * 0.4, s * 1.3, -s * 1.4, s * 0.3, 0, -s * 0.6);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: s * 0.35,
    bevelEnabled: true,
    bevelThickness: s * 0.08,
    bevelSize: s * 0.08,
    bevelSegments: 2,
    curveSegments: 12,
  });
  geo.center();
  geo.computeVertexNormals();
  return geo;
}

function keyGeometry() {
  const s = KEY_DEFAULTS.size;
  const parts = [
    [new THREE.TorusGeometry(s * 0.28, s * 0.07, 8, 16), 0, s * 0.3, 0],
    [new THREE.CylinderGeometry(s * 0.05, s * 0.05, s * 0.7, 8), 0, s * 0.3 - s * 0.45, 0],
    [new THREE.BoxGeometry(s * 0.18, s * 0.06, s * 0.08), s * 0.09, s * 0.3 - s * 0.62, 0],
    [new THREE.BoxGeometry(s * 0.13, s * 0.06, s * 0.08), s * 0.07, s * 0.3 - s * 0.78, 0],
  ];
  const geos = parts.map(([g, x, y, z]) => {
    g.translate(x, y, z);
    g.deleteAttribute("uv"); // torus/box/cylinder uv sets differ in nothing but we don't shade with them
    return g;
  });
  const merged = mergePositionNormal(geos);
  for (const g of geos) g.dispose();
  return merged;
}

/** Minimal position+normal merge — avoids attribute-set mismatches between primitive types. */
function mergePositionNormal(geos) {
  let vCount = 0;
  let iCount = 0;
  for (const g of geos) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const positions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  const indices = new Uint32Array(iCount);

  let vOff = 0;
  let iOff = 0;
  for (const g of geos) {
    positions.set(g.attributes.position.array, vOff * 3);
    normals.set(g.attributes.normal.array, vOff * 3);
    const n = g.attributes.position.count;
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) indices[iOff + i] = src[i] + vOff;
      iOff += src.length;
    } else {
      for (let i = 0; i < n; i++) indices[iOff + i] = vOff + i;
      iOff += n;
    }
    vOff += n;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  out.computeBoundingSphere();
  return out;
}

/* ─────────── kind registry ─────────── */

/**
 * A kind spec:
 *   parts:      [{ geometry, material }]      — one draw call each
 *   defaults:   authored params
 *   baseY(p):   float height the mesh hovers at, in prop-local space
 *   unitScale(p): extra local scale so size/radius sliders actually resize the mesh
 *   radius:     bounding radius (picking + grid)
 *   burstColor: pickup particle tint
 */
const _kinds = new Map();
const _builders = new Map();

function defineKind(kind, build) {
  _builders.set(kind, build);
}

/** Lazily builds (and caches) a kind's geometry + material. */
export function getCollectibleKind(kind) {
  let spec = _kinds.get(kind);
  if (spec) return spec;
  const build = _builders.get(kind);
  if (!build) return null;
  spec = build();
  spec.kind = kind;
  _kinds.set(kind, spec);
  return spec;
}

defineKind("coin", () => {
  const geometry = coinGeometry();
  return {
    parts: [{ geometry, material: buildGlowMaterial({ ...COIN_DEFAULTS, rim: 0.8 }) }],
    defaults: COIN_DEFAULTS,
    baseY: (p) => (p.radius ?? COIN_DEFAULTS.radius) + 0.2,
    unitScale: (p) => (p.radius ?? COIN_DEFAULTS.radius) / COIN_DEFAULTS.radius,
    radius: COIN_DEFAULTS.radius * 1.3,
    burstColor: new THREE.Color(COIN_DEFAULTS.emissive),
  };
});

defineKind("heart", () => {
  const geometry = heartGeometry();
  return {
    parts: [{ geometry, material: buildGlowMaterial({ ...HEART_DEFAULTS, rim: 1.0 }) }],
    defaults: HEART_DEFAULTS,
    baseY: (p) => (p.size ?? HEART_DEFAULTS.size) + 0.2,
    unitScale: (p) => (p.size ?? HEART_DEFAULTS.size) / HEART_DEFAULTS.size,
    radius: HEART_DEFAULTS.size * 1.6,
    burstColor: new THREE.Color(HEART_DEFAULTS.emissive),
  };
});

defineKind("key", () => {
  const geometry = keyGeometry();
  return {
    parts: [{ geometry, material: buildGlowMaterial({ ...KEY_DEFAULTS, rim: 0.7 }) }],
    defaults: KEY_DEFAULTS,
    baseY: (p) => (p.size ?? KEY_DEFAULTS.size) + 0.3,
    unitScale: (p) => (p.size ?? KEY_DEFAULTS.size) / KEY_DEFAULTS.size,
    radius: KEY_DEFAULTS.size * 1.4,
    burstColor: new THREE.Color(KEY_DEFAULTS.emissive),
  };
});

/** Every registered collectible kind — also the set of factoryIds the field owns. */
export const COLLECTIBLE_KINDS = new Set(["coin", "heart", "key"]);

export function isCollectibleFactoryId(factoryId) {
  return COLLECTIBLE_KINDS.has(factoryId);
}

/* ─────────── GLB collectibles ─────────── */

/**
 * Turn an imported GLB into a collectible kind. Each submesh becomes one instanced draw call
 * sharing the same per-instance attribute buffers, so a 3-material chest costs 3 draws total,
 * not 3 per placed chest.
 *
 * @param {string} name                 display name (also the slot name)
 * @param {Array<{geometry, material, localMatrix}>} submeshes
 */
export function registerGlbCollectibleKind(name, submeshes, opts = {}) {
  const {
    pickupRadius = 1.5,
    burstColor = "#ffd56a",
    spinSpeed = 1.2,
    bobAmp = 0.15,
    bobSpeed = 1.4,
    baseYOffset = 0.3,
    glow = true,
    glowIntensity = 0.55,
  } = opts;

  // Unique kind id — importing two GLBs with the same name must not collide.
  let kind = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (COLLECTIBLE_KINDS.has(kind)) {
    let n = 2;
    while (COLLECTIBLE_KINDS.has(`${kind}_${n}`)) n++;
    kind = `${kind}_${n}`;
  }

  const tint = new THREE.Color(burstColor);
  const bbox = new THREE.Box3();
  const parts = [];
  const matCache = new Map();

  for (const sm of submeshes) {
    // Bake the submesh's place in the GLB hierarchy into the geometry — the instanced draw
    // has no per-part object matrix to lean on.
    const geometry = sm.geometry.clone();
    if (sm.localMatrix) geometry.applyMatrix4(sm.localMatrix);
    geometry.computeBoundingBox();
    bbox.union(geometry.boundingBox);

    let material = matCache.get(sm.material);
    if (!material) {
      material = glbCollectibleMaterial(sm.material, { glow, glowIntensity, tint });
      matCache.set(sm.material, material);
    }
    parts.push({ geometry, material });
  }

  const size = bbox.getSize(new THREE.Vector3());
  const spec = {
    kind,
    name,
    parts,
    defaults: { pickupRadius, spinSpeed, bobAmp, bobSpeed },
    baseY: () => -bbox.min.y + baseYOffset,
    unitScale: () => 1,
    radius: Math.max(size.x, size.y, size.z) * 0.6 || 1,
    burstColor: tint,
    bbox: bbox.clone(),
  };

  _kinds.set(kind, spec);
  COLLECTIBLE_KINDS.add(kind);
  return spec;
}

/** Clone a GLB material into a node material with the collectible vertex program + rim glow. */
function glbCollectibleMaterial(src, { glow, glowIntensity, tint }) {
  const mat = new MeshStandardNodeMaterial();
  if (src) {
    if (src.color) mat.color.copy(src.color);
    if (src.emissive) mat.emissive.copy(src.emissive);
    if ("emissiveIntensity" in src) mat.emissiveIntensity = src.emissiveIntensity;
    if ("roughness" in src) mat.roughness = src.roughness;
    if ("metalness" in src) mat.metalness = src.metalness;
    if (src.transparent) mat.transparent = true;
    if (src.alphaTest) mat.alphaTest = src.alphaTest;
    if (src.side != null) mat.side = src.side;
    for (const key of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"]) {
      if (src[key]) mat[key] = src[key];
    }
  }

  mat.positionNode = collectibleVertex();

  if (glow) {
    const uGlow = uniform(glowIntensity);
    const uTint = uniform(tint.clone());
    const pulse = mix(float(0.7), float(1.3), sin(time.mul(3.0)).mul(0.5).add(0.5));
    const fresnel = oneMinus(abs(normalView.z)).pow(2.0);
    const emissiveNode = materialEmissive.add(uTint.mul(uGlow).mul(pulse).mul(fresnel));
    mat.emissiveNode = emissiveNode;
    // A lit material already writes emissive to the MRT, but overriding it lets the shared
    // bloom knob drive how hard it glows without also brightening the lit surface.
    applyBloomMRT(mat, emissiveNode.mul(collectibleUniforms.bloom));
  }
  return mat;
}

/**
 * Placement-ghost group for a kind — plain (non-instanced) meshes at their resting height.
 * PropPlacementPreview swaps in its own ghost material, so the kind's instanced material
 * (which needs per-instance attributes) never gets drawn here.
 */
export function buildCollectibleGhostGroup(kind) {
  const spec = getCollectibleKind(kind);
  if (!spec) return null;
  const group = new THREE.Group();
  const inner = new THREE.Group();
  for (const part of spec.parts) inner.add(new THREE.Mesh(part.geometry));
  inner.position.y = spec.baseY(spec.defaults);
  const unit = spec.unitScale(spec.defaults);
  inner.scale.setScalar(unit);
  group.add(inner);
  return group;
}

/**
 * Per-instance attribute layout — ONE interleaved buffer, not five.
 *
 * WebGPU allows at most 8 vertex buffers per pipeline. A GLB submesh can easily bring
 * position/normal/uv/uv1/tangent/color on its own, so five separate instance buffers would
 * overflow the limit and the pipeline would fail to create. Interleaving costs one slot.
 *
 * Offsets are in floats; every vec4 lands on a 16-byte boundary.
 */
export const INSTANCE_STRIDE = 20;
export const INSTANCE_ATTRS = [
  { name: "aPos", size: 4, offset: 0 },
  { name: "aQuat", size: 4, offset: 4 },
  { name: "aScl", size: 4, offset: 8 },
  { name: "aAnim", size: 4, offset: 12 },
  { name: "aBirth", size: 1, offset: 16 },
];
/** Float offset of aBirth within one instance's stride — the only value written at runtime. */
export const BIRTH_OFFSET = 16;

export function disposeCollectibleKinds() {
  for (const spec of _kinds.values()) {
    for (const part of spec.parts) {
      part.geometry.dispose();
      part.material.dispose();
    }
  }
  _kinds.clear();
}
