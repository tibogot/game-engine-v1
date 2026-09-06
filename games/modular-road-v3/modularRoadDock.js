/**
 * games/modular-road-v3/modularRoadDock.js — the drift dock
 *
 * A set of concrete/asphalt platforms standing out of open water, for the drift
 * category: a big slab to slide on, a couple of outlying pads to jump between,
 * and nothing else in the world but sea and sky.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT V3 TERRAIN.
 *
 * The obvious way to build "flat ground above water" is to sculpt a plateau in
 * the v3 editor and load it as a .v3proj. It works, and it costs about 2.5 ms of
 * GPU for a surface that is FLAT — measured on an otherwise empty v3 scene, and
 * it is the reason this game already has a "disable terrain" switch in its dev
 * panel.
 *
 * That cost is not geometry, it is the tile material: v3 terrain is
 * fragment-bound, it fills the screen, and it is paying for splat blending,
 * tri-planar sampling and a normal/height bake that a flat concrete slab uses
 * none of. A dock covers a small fraction of the frame with one PBR material.
 * Different animal entirely — the "a procedural terrain would not be faster"
 * result does not transfer, because that was about something that still filled
 * the screen.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE PART THAT MATTERS: A HEIGHTMAP IS DATA, NOT A THING YOU DRAW.
 *
 * The ocean needs to know where land is — a Float32Array to bake its shoreline
 * distance field from, and a texture of the same for the vertex-stage run-up. It
 * has no opinion about who drew that land, or whether anyone did.
 *
 * So this module emits BOTH from one description:
 *
 *   • a small height field (512² over ~900 m) that goes to the ocean
 *   • a mesh, one draw, that goes to the screen and to the collision BVH
 *
 * Both are evaluated from the same signed-distance function, so the waterline
 * the ocean draws lands exactly on the edge the car drives off. That is the
 * whole trick, and it is why the dock and the sea can never drift apart.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THE SEA DOES AT A QUAY, AND WHY IT LOOKS RIGHT FOR FREE.
 *
 * `edgeWidth` is small — a couple of metres — so the height field falls ~45 m
 * over ~2.5 m at the rim. The shoreline field reports that as a near-vertical
 * seabed slope, and the ocean's own rules then do the right thing without being
 * told this is a dock rather than a beach:
 *
 *   • run-up switches itself OFF (`runupMaxSlope` — water climbs sand, not
 *     concrete), so no sheet washes up over the deck
 *   • the slope channel drives the breaker toward PLUNGING: a tight bright line
 *     at the wall instead of a wide spilling band
 *   • the water stays deep right up to the wall, so it reads opaque and dark
 *     against the foam line, which is exactly how a deep-water quay looks
 *
 * The skirt is extruded all the way to the seabed on purpose: the ocean takes
 * its thickness from the DEPTH BUFFER, so a wall that stopped short of the bed
 * would leave the water with nothing behind it to measure against.
 *
 * @see v3/render/water/worldOceanV2.js — the consumer of the height field
 */

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const ASPHALT_URL = "/textures/pbr_materials/asphalt_track/asphalt_track";

export const DOCK_DEFAULTS = {
  enabled: false,

  /** Metres the height field covers, centred on the origin. Outside it the ocean
   *  clamps to the border value, which is open water — exactly what we want. */
  worldSize: 1100,
  /** Height-field texels per side. 512 over 1100 m is 2.1 m/texel, fine enough
   *  to resolve a 2.5 m rim, and a ~50 ms shoreline bake. */
  fieldRes: 512,

  /** World Y of the dock surface. The track is built at 0, so the dock is too. */
  topY: 0,
  /** Metres the deck stands above the water. A quay wants real presence — at 5
   *  the wall is there but reads as a kerb, not as something you could fall off. */
  freeboard: 9,
  /** Metres of water below sea level. Deep enough to read opaque at the wall. */
  depth: 40,
  /** Metres over which the height field falls at the rim. Small = a wall. */
  edgeWidth: 2.5,

  /** Metres per repeat of the asphalt texture. */
  tileMetres: 7,
  /** Normal map strength. */
  normalScale: 1.0,
  /**
   * Albedo lift. The asphalt diffuse averages ~0.14 linear — real road asphalt,
   * and correct, but under a low sun with no bounce it renders as a black hole
   * in the frame. `color` multiplies the map, so this is the one knob that
   * decides whether the deck reads as concrete or as a void.
   */
  deckBrightness: 1.9,
  deckTint: "#ffffff",

  /**
   * The platforms. Each is a rounded rectangle; `rise` lifts it above `topY` so
   * pads can sit at different levels.
   *
   * ONE big apron by default. It is still a LIST because the generator does not
   * care how many there are and an outlying pad to jump to costs nothing to add
   * later — but a drift level wants uninterrupted room to hold a slide, and a
   * scatter of islands is a different game mode, not this one.
   *
   * 380 x 300 m: long enough for a full third-gear drift down the length, wide
   * enough to link two of them, and the 46 m corner radius gives a continuous
   * banked-feeling arc to lean on instead of a square corner to clip.
   */
  pads: [
    { x: 0, z: 0, sizeX: 380, sizeZ: 300, radius: 46, rotDeg: 0, rise: 0 },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Footprint maths. One SDF, used by both the height field and the mesh.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Signed distance to a rotated rounded rectangle in the XZ plane.
 * Negative inside. The standard 2D rounded-box SDF, with the point rotated into
 * the pad's frame first.
 */
function padSdf(x, z, pad) {
  const a = -(pad.rotDeg || 0) * (Math.PI / 180);
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = x - pad.x;
  const dz = z - pad.z;
  const px = dx * c - dz * s;
  const pz = dx * s + dz * c;

  const r = Math.min(pad.radius || 0, Math.min(pad.sizeX, pad.sizeZ) * 0.5);
  const bx = pad.sizeX * 0.5 - r;
  const bz = pad.sizeZ * 0.5 - r;
  const qx = Math.abs(px) - bx;
  const qz = Math.abs(pz) - bz;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qz, 0));
  return outside + Math.min(Math.max(qx, qz), 0) - r;
}

/** Perimeter points of a rounded rectangle, CCW, in the pad's own frame. */
function padOutline(pad, cornerSegs = 7) {
  const r = Math.min(pad.radius || 0, Math.min(pad.sizeX, pad.sizeZ) * 0.5);
  const bx = pad.sizeX * 0.5 - r;
  const bz = pad.sizeZ * 0.5 - r;
  const pts = [];
  // Four corner arcs, each centred on the inset rectangle's corner.
  const corners = [
    [+bx, +bz, 0],
    [-bx, +bz, Math.PI * 0.5],
    [-bx, -bz, Math.PI],
    [+bx, -bz, Math.PI * 1.5],
  ];
  for (const [cx, cz, a0] of corners) {
    for (let i = 0; i <= cornerSegs; i++) {
      const a = a0 + (i / cornerSegs) * Math.PI * 0.5;
      pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
  }
  return pts;
}

/** Pad frame → world XZ. */
function padToWorld(pad, px, pz) {
  const a = (pad.rotDeg || 0) * (Math.PI / 180);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [pad.x + px * c - pz * s, pad.z + px * s + pz * c];
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} p — DOCK_DEFAULTS shape
 * @returns {{ heights: Float32Array, size: number, worldSize: number,
 *             maxHeight: number, heightBase: number, seaLevel: number }}
 */
export function buildDockHeightField(p) {
  const size = p.fieldRes;
  const seaLevel = p.topY - p.freeboard;
  const bedY = seaLevel - p.depth;

  // The stored range has to bracket everything with room to spare, because the
  // texture only carries 0..1 and the ocean reconstructs `r * maxHeight + base`.
  const heightBase = bedY - 10;
  const maxHeight = (p.topY + 40) - heightBase;

  const heights = new Float32Array(size * size);
  const span = p.worldSize / size;
  const half = p.worldSize * 0.5;
  const edge = Math.max(p.edgeWidth, 0.05);

  for (let j = 0; j < size; j++) {
    const z = (j + 0.5) * span - half;
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) * span - half;

      // Nearest pad wins. `sd` is negative inside a pad, and `top` is that pad's
      // deck height — taking them together rather than max-ing the heights keeps
      // the rim of a low pad from being swallowed by a taller neighbour's ramp.
      let best = Infinity;
      let top = p.topY;
      for (const pad of p.pads) {
        const d = padSdf(x, z, pad);
        if (d < best) { best = d; top = p.topY + (pad.rise || 0); }
      }

      // 1 on the deck, 0 in open water, falling over `edgeWidth` OUTSIDE the
      // footprint. Outward, not inward, and the direction matters: running the
      // ramp inward would make `sizeX` describe the bottom of the wall, leaving
      // the drivable deck `edgeWidth` smaller than the footprint the collision
      // mesh uses — the car would reach an edge the water thought was seabed.
      // This way the footprint IS the deck, and the wall falls away outside it.
      const t = Math.min(Math.max(1 - best / edge, 0), 1);
      const k = t * t * (3 - 2 * t);
      const y = bedY + (top - bedY) * k;
      heights[j * size + i] = Math.min(1, Math.max(0, (y - heightBase) / maxHeight));
    }
  }

  return { heights, size, worldSize: p.worldSize, maxHeight, heightBase, seaLevel };
}

/**
 * A filterable height texture the ocean's vertex stage can sample.
 *
 * Created ONCE and refilled in place by `writeHeightTexture`. Making a new one
 * per rebuild leaves the ocean's node pointing at a texture that has just been
 * disposed — which does not throw, it just silently stops being the terrain.
 */
function makeHeightTexture(size) {
  const tex = new THREE.DataTexture(
    new Uint16Array(size * size), size, size, THREE.RedFormat, THREE.HalfFloatType,
  );
  tex.name = "DockHeightField";
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  // Matches the v3 heightmap convention; a flipped field would put the sea on
  // the wrong side of every pad and look almost plausible while doing it.
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

function writeHeightTexture(tex, heights) {
  const d = tex.image.data;
  for (let i = 0; i < heights.length; i++) d[i] = THREE.DataUtils.toHalfFloat(heights[i]);
  tex.needsUpdate = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One pad: a triangle-fanned top face plus a skirt dropping to the seabed.
 *
 * UVs are built by hand rather than left to a generator because the two faces
 * want different parameterisations — the deck tiles in WORLD XZ so neighbouring
 * pads share one continuous asphalt grain, while the skirt tiles by perimeter
 * arc length and depth so the wall keeps square texels however long it is.
 */
function buildPadGeometry(pad, p, bedY, forCollision) {
  const outline = padOutline(pad);
  const n = outline.length;
  const topY = p.topY + (pad.rise || 0);
  const inv = 1 / p.tileMetres;

  const pos = [];
  const nor = [];
  const uv = [];
  const idx = [];

  // ── Top face: fan from the centroid ──────────────────────────────────────
  pos.push(pad.x, topY, pad.z);
  nor.push(0, 1, 0);
  uv.push(pad.x * inv, pad.z * inv);
  for (const [px, pz] of outline) {
    const [wx, wz] = padToWorld(pad, px, pz);
    pos.push(wx, topY, wz);
    nor.push(0, 1, 0);
    uv.push(wx * inv, wz * inv);
  }
  // Reversed relative to the outline's own order. The outline runs CCW in the
  // pad's (x, z) frame, but looking DOWN at the XZ plane from +Y flips the sense
  // of that — screen-up is −Z — so the naive order is back-facing and the deck is
  // culled away entirely. The symptom is not a missing polygon: it is a dock that
  // looks like it is sitting flush at sea level, because you are seeing straight
  // through the deck to whatever is behind it.
  for (let i = 0; i < n; i++) {
    idx.push(0, 1 + ((i + 1) % n), 1 + i);
  }

  if (forCollision) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  }

  // ── Skirt: quads from the rim down to the seabed ─────────────────────────
  const base = pos.length / 3;
  let arc = 0;
  const vTop = 0;
  const vBot = (topY - bedY) * inv;
  for (let i = 0; i <= n; i++) {
    const [px, pz] = outline[i % n];
    const [wx, wz] = padToWorld(pad, px, pz);
    if (i > 0) {
      const [qx, qz] = outline[(i - 1) % n];
      const [pwx, pwz] = padToWorld(pad, qx, qz);
      arc += Math.hypot(wx - pwx, wz - pwz);
    }
    // Outward normal = ∇(SDF), evaluated numerically in world space.
    // The cheap version — "direction away from the pad centre" — is only correct
    // at the corners: on a long straight edge it points diagonally, and the wall
    // then catches the light as though it were curved.
    const e = 0.05;
    let nx = (padSdf(wx + e, wz, pad) - padSdf(wx - e, wz, pad)) / (2 * e);
    let nz = (padSdf(wx, wz + e, pad) - padSdf(wx, wz - e, pad)) / (2 * e);
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl; nz /= nl;

    pos.push(wx, topY, wz);
    nor.push(nx, 0, nz);
    uv.push(arc * inv, vTop);

    pos.push(wx, bedY, wz);
    nor.push(nx, 0, nz);
    uv.push(arc * inv, vBot);
  }
  // Wound so the OUTWARD face is the front face. Backwards, the whole skirt is
  // culled and the dock looks like a raft floating flush on the water — the wall
  // is there, you just cannot see it, and nothing else in the frame says so.
  for (let i = 0; i < n; i++) {
    const a = base + i * 2;
    idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  // three's aoMap reads a second UV channel on some paths; duplicating it here
  // is a few KB and removes a whole class of "the AO is missing" confusion.
  g.setAttribute("uv1", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
// Material
// ─────────────────────────────────────────────────────────────────────────────

let _asphaltMaps = null;
let _asphaltPending = null;

/**
 * The ARM convention: one texture whose R is ambient occlusion, G is roughness
 * and B is metalness. three reads exactly those channels when the same map is
 * handed to `aoMap` / `roughnessMap` / `metalnessMap`, so it is bound three
 * times and sampled once.
 */
export function preloadAsphalt() {
  if (_asphaltPending) return _asphaltPending;
  const loader = new THREE.TextureLoader();
  const pending = [];
  const load = (suffix, srgb) => {
    let done;
    pending.push(new Promise((r) => { done = r; }));
    const tex = loader.load(
      `${ASPHALT_URL}_${suffix}_2k.jpg`,
      () => done(),
      undefined,
      () => { console.warn("[ModularRoad-v3] asphalt map failed:", suffix); done(); },
    );
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = 8;
    return tex;
  };
  _asphaltMaps = {
    color: load("diff", true),
    normal: load("nor_gl", false),
    arm: load("arm", false),
  };
  _asphaltPending = Promise.all(pending).then(() => _asphaltMaps);
  return _asphaltPending;
}

/** `color` multiplies the albedo map, so values above 1 are a legitimate lift. */
function applyDeckTint(mat, p) {
  mat.color.set(p.deckTint).multiplyScalar(p.deckBrightness);
}

function asphaltMaterial(p) {
  if (!_asphaltMaps) preloadAsphalt();
  const m = _asphaltMaps;
  const mat = new THREE.MeshStandardNodeMaterial({
    map: m.color,
    normalMap: m.normal,
    // Same texture, three different channels — see preloadAsphalt().
    aoMap: m.arm,
    roughnessMap: m.arm,
    metalnessMap: m.arm,
    // The maps MULTIPLY these, so 1 lets the texture own the value outright.
    roughness: 1,
    metalness: 1,
  });
  mat.name = "DockAsphalt";
  mat.normalScale = new THREE.Vector2(p.normalScale, p.normalScale);
  applyDeckTint(mat, p);
  return mat;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object}       o
 * @param {THREE.Scene}  o.scene
 * @param {object}       [o.params] — DOCK_DEFAULTS overrides
 */
export function createDock({ scene, params = {} }) {
  const p = { ...DOCK_DEFAULTS, ...params };

  const group = new THREE.Group();
  group.name = "DriftDock";
  group.visible = !!p.enabled;
  scene.add(group);

  let material = null;
  let mesh = null;
  let deckGeo = null;
  let field = null;
  // Stable for the life of the dock: the ocean binds this once.
  const heightTexture = makeHeightTexture(p.fieldRes);

  function disposeBuilt() {
    if (mesh) {
      group.remove(mesh);
      mesh.geometry.dispose();
      mesh = null;
    }
    if (deckGeo) { deckGeo.dispose(); deckGeo = null; }
  }

  function rebuild(next = {}) {
    Object.assign(p, next);
    disposeBuilt();

    field = buildDockHeightField(p);
    writeHeightTexture(heightTexture, field.heights);

    const bedY = field.seaLevel - p.depth;
    const visual = p.pads.map((pad) => buildPadGeometry(pad, p, bedY, false));
    const collide = p.pads.map((pad) => buildPadGeometry(pad, p, bedY, true));

    if (!material) {
      material = asphaltMaterial(p);
    } else {
      material.normalScale.set(p.normalScale, p.normalScale);
      applyDeckTint(material, p);
    }

    // One draw for every pad. mergeGeometries is unforgiving about attribute
    // mismatches — it returns null rather than throwing — so every pad geometry
    // is built by the same function with the same attribute set.
    const merged = mergeGeometries(visual, false);
    for (const g of visual) g.dispose();
    if (!merged) {
      console.warn("[ModularRoad-v3] dock merge failed — attribute mismatch");
      return;
    }
    merged.computeBoundingSphere();
    mesh = new THREE.Mesh(merged, material);
    mesh.name = "DockSlabs";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    deckGeo = mergeGeometries(collide, false);
    for (const g of collide) g.dispose();
    group.visible = !!p.enabled;
  }

  rebuild();

  return {
    group,
    params: p,
    get seaLevel() { return field.seaLevel; },
    heightTexture,
    get heights() { return field.heights; },
    get fieldSize() { return field.size; },
    get maxHeight() { return field.maxHeight; },
    get heightBase() { return field.heightBase; },

    setEnabled(v) { p.enabled = !!v; group.visible = !!v; },
    rebuild,

    /**
     * Look-only. `rebuild` costs ~100 ms (height field + shoreline bake + mesh),
     * which is fine for a shape change and absurd for dragging a brightness
     * slider — so the two paths are separate and the panel picks the right one.
     */
    setLook(next = {}) {
      Object.assign(p, next);
      if (!material) return;
      material.normalScale.set(p.normalScale, p.normalScale);
      applyDeckTint(material, p);
    },

    /**
     * Deck only — the top faces. The skirt is deliberately absent: a car that
     * leaves the edge should fall into the sea, not slide down a wall.
     * Shape matches what roadGame's collision collector expects from props.
     */
    collisionMeshes() {
      if (!p.enabled || !deckGeo) return { deck: [], solids: [] };
      return {
        deck: [{ geometry: deckGeo, matrixWorld: group.matrixWorld, updateMatrixWorld() {} }],
        solids: [],
      };
    },

    dispose() {
      disposeBuilt();
      heightTexture.dispose();
      material?.dispose();
      scene.remove(group);
    },
  };
}
