// ============================================================================
// DECALS — a texture stuck flat on the face of a prop.
//
// Deliberately NOT part of the prop's own material. A per-prop `map` would mean
// a per-prop material, which means a per-prop draw call, and the containers only
// cost four draws in total because forty of them share one material. A decal is
// its own tiny quad instead: one extra InstancedMesh for the whole track, and a
// container without one simply has a zero-scaled instance that rasterises
// nothing.
//
// That also makes decals GENERIC. Nothing here knows about containers — a prop
// declares `decal: { url, size, faces }` and gets stickers; billboards and LED
// boards can use the same thing unchanged. The atlas version (many logos, a
// per-instance index) slots in behind this same interface later.
//
// TWO THINGS THAT LOOK RIGHT AND ARE NOT:
//
//  • ALPHA. `colorNode = materialColor` is the fog fix used everywhere else in
//    v3, and on a cut-out texture it silently breaks alphaTest:
//    NodeMaterial.setupDiffuseColor does `vec4(this.colorNode)` on a vec3, so
//    the alpha becomes 1 and NOTHING is ever discarded — the logo renders as an
//    opaque square. The texture's alpha has to be handed over separately as
//    `opacityNode`.
//
//  • Z-FIGHTING. A quad sitting flat on a wall is the classic case, and pushing
//    it out by a centimetre only moves the distance at which it starts to
//    shimmer (the swing gate's stripe made exactly this mistake). A physical
//    offset AND a depth bias, because the bias is the part that holds at range.
// ============================================================================
import * as THREE from "three";
import { materialColor, texture as tslTexture } from "three/tsl";

/** url -> Promise<THREE.Texture|null> */
const _textures = new Map();
/** url -> THREE.Material */
const _materials = new Map();

/** How far a decal floats off the surface it is stuck to (m). */
export const DECAL_OFFSET = 0.015;

/**
 * Load a decal texture once, shared by every prop that names it.
 *
 * Resolves to null on failure rather than rejecting: this is awaited during
 * startup, and a missing sticker must not take the editor down.
 */
export function preloadDecal(url) {
  if (_textures.has(url)) return _textures.get(url);
  const p = new Promise((resolve) => {
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        // Clamp, or the bilinear filter wraps the far edge of the logo around
        // and leaves a bright seam on the opposite side of the quad.
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.anisotropy = 8; // it is read at a glancing angle from a moving car
        resolve(tex);
      },
      undefined,
      () => { console.warn("[ModularRoad-v3] decal failed to load", url); resolve(null); },
    );
  });
  _textures.set(url, p);
  return p;
}

/** The shared material for a decal texture, or null if it never loaded. */
export function decalMaterial(url) {
  if (_materials.has(url)) return _materials.get(url);
  const tex = _textures.get(url)?.value ?? null;
  if (!tex) return null;
  const m = new THREE.MeshStandardNodeMaterial({
    roughness: 0.85,
    metalness: 0,
    map: tex,
  });
  // RGB and fog. materialColor multiplies the map in, and being a node property
  // is what stops three's WebGPU backend freezing this material's fog.
  m.colorNode = materialColor;
  // ALPHA, separately — see the header. Without this the cut-out is a square.
  m.opacityNode = tslTexture(tex).a;
  m.alphaTest = 0.5;
  // Depth bias, not just the physical offset: a coplanar-ish quad z-fights once
  // depth precision runs out, and no amount of pushing it outward fixes that.
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -2;
  // Batchable — every decal material is built by this one function, so what it
  // renders is fully determined by its map and its plain properties.
  m.userData.batchKey = `decal:${url}`;
  _materials.set(url, m);
  return m;
}

/** Resolve the preloads so decalMaterial() can be synchronous afterwards. */
export async function settleDecals() {
  for (const [url, p] of _textures) {
    const tex = await p;
    _textures.set(url, { value: tex });
    void url;
  }
}

/**
 * The quad a decal is drawn on, in the prop's LOCAL space.
 *
 * One geometry shared by every face of every prop using this decal — the face
 * placement is an instance matrix, not separate geometry.
 */
export function decalGeometry(width, height) {
  return new THREE.PlaneGeometry(width, height);
}
