// ============================================================================
// SCENERY — the v2 objects-lab pieces (LED board, billboard, street lamp,
// floodlight) as placeable road-builder props.
//
// The builders in v2/objects/ are already the right code and are shared with the
// lab and the v2 editor, so this does NOT re-implement them. It ADAPTS them, and
// there are exactly three things to adapt.
//
//  1. SPLINE OBJECT -> POINT PROP. Those builders take a spline and stamp copies
//     along it. The road builder places one thing where you click, so each is
//     built from a single point at the origin with flat ground, and the prop root
//     supplies the real transform.
//
//  2. PLAIN MATERIALS FREEZE THEIR FOG IN v3. three's WebGPU backend only
//     re-uploads a render object's uniforms when the material has a NODE
//     property, the mesh is skinned, or its world matrix changed — scene-level
//     uniforms behind `scene.fogNode` are not tracked. A MeshStandardMaterial on
//     a mast that never moves therefore keeps the fog it first rendered with
//     forever, and `needsUpdate` does not help. Roadside scenery is the exact
//     shape of that bug: static, world-space, and lit by the same fog as the
//     track it stands next to. So every plain material is rebuilt as its Node
//     equivalent with a colorNode, which flips `hasNode` and keeps it live.
//     (The LED panels are already MeshBasicNodeMaterial and need none of this.)
//
//  3. EMISSIVE ONLY BLOOMS THROUGH THE MRT. v3's bloom is selective — a high
//     `emissiveIntensity` alone does nothing, unlike the lab where the whole
//     scene's bright pixels bloomed. Lamps and LED faces opt in explicitly.
//
// SHARING IS THE WHOLE OPTIMISATION. A template is built ONCE per scenery type
// and every placement is a `clone()` of it, which in three shares geometry and
// material by reference. So twenty floodlights are twenty draws of ONE geometry
// with ONE shader compiled once — not twenty compiles of the same program, which
// is what calling the builder per placement would cost. The LED shader in
// particular is not cheap to compile.
// ============================================================================
import * as THREE from "three";
import { materialColor } from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
import { flattenInstanced, mergeByMaterial, markSharedGeometry } from "./modularRoadBatching.js";
import { buildLedMatrixMesh } from "../../v2/objects/ledMatrix.js";
import { buildBillboardMesh } from "../../v2/objects/billboard.js";
import { buildStreetLampMesh } from "../../v2/objects/streetLamp.js";
import { buildFloodlightMesh } from "../../v2/objects/floodlight.js";
import { buildChainLinkFenceMesh } from "../../v2/objects/chainLinkFence.js";
import { buildBarbWireMesh } from "../../v2/objects/barbWire.js";

/** Single point at the origin on flat ground — the prop root does the placing. */
const AT_ORIGIN = { points: [{ x: 0, y: 0, z: 0 }], getWorldHeight: () => 0 };

/**
 * A straight RUN through the origin, for the builders that take a spline rather
 * than a point (fences, wire). Along Z, because that is the axis a road piece
 * runs down, so a fence dropped beside a straight lines up with it instead of
 * crossing it.
 *
 * @param {number} len metres, centred on the origin
 */
const alongZ = (len) => ({
  points: [{ x: 0, y: 0, z: -len / 2 }, { x: 0, y: 0, z: len / 2 }],
  getWorldHeight: () => 0,
});

/**
 * Placeable scenery. `params` deliberately override the lab defaults that only
 * make sense for a spline run (spacing, sideOffset, side) — those describe how
 * to distribute copies, and here there is exactly one.
 *
 * `capsules` are LOCAL-space collider primitives; see PropManager.collisionCapsules.
 * Masts and legs are round and thin, which is precisely the case the chassis
 * hull's triangle sampling cannot see — so they are declared as primitives
 * rather than left to the static bake.
 */
export const SCENERY_CATALOG = [
  {
    id: "ledboard",
    label: "LED board",
    build: buildLedMatrixMesh,
    params: {
      source: "chevron",
      boardW: 7.2, boardH: 2.2,
      standHeight: 2.6, legs: true,
      cols: 84, rows: 24,
      shape: "round",
    },
    // Two legs, spread by LEG_SPREAD (0.42) of the board width in the builder.
    capsules: [
      { x: -7.2 * 0.42, radius: 0.13, height: 2.6 },
      { x: +7.2 * 0.42, radius: 0.13, height: 2.6 },
    ],
  },
  {
    id: "billboard",
    label: "Billboard",
    build: buildBillboardMesh,
    params: {
      surface: "led", boardMode: "chevron", boardShape: "square",
      panelWidth: 6.0, panelHeight: 3.0, panelBottom: 2.4,
      tiltDeg: 6,
    },
    capsules: [
      { x: -6.0 * 0.4, radius: 0.12, height: 2.4 },
      { x: +6.0 * 0.4, radius: 0.12, height: 2.4 },
    ],
  },
  {
    id: "streetlamp",
    label: "Street lamp",
    build: buildStreetLampMesh,
    params: {
      // castLight OFF, and this is the prop where that matters most. A
      // floodlight you place three of; street lamps you line a whole straight
      // with, so a real PointLight each is the one cost that scales with how
      // much you like the look. The builder's own default is `true` — this
      // overrides it for placed scenery.
      castLight: false,
      // ...but the GROUND POOL stays, and it is why turning the light off is
      // affordable: an additive radial decal on the deck, one extra quad, no
      // light. On a wet road the pool plus the lamp head's reflection is most
      // of what a real light would have given us.
      groundPool: true,
      poolRadius: 2.4,
      poolStrength: 0.5,
    },
    // The pole only. Arm, lantern and pool overhang the road and are
    // deliberately NOT solid — you drive under the light, not into it.
    // baseHeight 0.34 + poleHeight 4.4 in STREET_LAMP_DEFAULTS.
    capsules: [{ x: 0, radius: 0.14, height: 4.74 }],
  },
  {
    id: "floodlight",
    label: "Floodlight",
    build: buildFloodlightMesh,
    params: {
      mastHeight: 13,
      headTiltDeg: 28,
      lampCols: 4, lampRows: 3,
      // castLight stays OFF. A real SpotLight per mast is the single most
      // expensive thing on this list — shadow-casting or not — and a stadium
      // light reads fine from its emissive lamp faces plus the bloom. Turning it
      // on is a per-track decision, not a default.
      castLight: false,
    },
    // One fat mast. `height` spans the whole thing so a car cannot pass under it.
    capsules: [{ x: 0, radius: 0.30, height: 13 }],
  },

  // ── SPLINE OBJECTS AS A FIXED RUN ─────────────────────────────────────────
  // These three take a PATH in the lab. Here each is one placeable object, so
  // the path is a fixed straight run through the origin and the prop root
  // supplies the real position and heading — rotate it with the gizmo to line it
  // up with whatever it is fencing off.
  {
    id: "chainlinkfence",
    label: "Chain-link fence",
    build: buildChainLinkFenceMesh,
    source: () => alongZ(24),
    params: {
      height: 2.6,
      pathSegments: 40,
      postSpacing: 3.0,
      topRail: true,
      arms: true,
      armSide: "out",
      strands: 3,
      // Concertina off by default: it is ~16k rings of swept wire on a 24 m run,
      // which is the whole object's triangle budget spent on something you read
      // as "coil" from two pixels of silhouette.
      coil: false,
    },
    // ── A WALL, NOT CAPSULES ────────────────────────────────────────────────
    // Every other scenery type is a point object with one or two round masts,
    // which is exactly the case capsules exist for. A 24 m fence is not: capsules
    // dense enough to actually stop a car along that whole run would be twenty
    // primitives, and three of them (one per end, one mid-span) is a fence with
    // 8 m gaps you drive straight through — worse than no collider, because it
    // looks like it should stop you.
    //
    // A fence line IS a thin wall, so it gets one: an invisible box in the solid
    // bake, spanning the run. The curtain quad and the metalwork are excluded
    // (see solidWall in buildTemplate) so only this one shape is collided.
    solidWall: { thickness: 0.2, height: 2.6, length: 24 },
  },
  {
    id: "barbwire",
    label: "Barbed wire",
    build: buildBarbWireMesh,
    source: () => alongZ(20),
    params: {
      stacking: "pyramid",
      coilRadius: 0.55,
      coilPitch: 0.34,
      segsPerRev: 8, // the lab default of 12 triples the ring count for no gain here
      stakes: true,
      stakeSpacing: 4,
    },
    // Same wall treatment as the fence, and lower: a pyramid coil on picket
    // stakes stands about waist height, so this stops a car without pretending
    // to be a 2.6 m barrier.
    solidWall: { thickness: 0.5, height: 1.5, length: 20 },
  },
];

export const SCENERY_MAP = new Map(SCENERY_CATALOG.map((s) => [s.id, s]));

/**
 * Rebuild a plain material as its Node equivalent — see the fog note up top.
 *
 * `colorNode = materialColor` rather than a baked constant so `.color` stays the
 * authoritative property: anything that later tints this material (the dev
 * panel, a track theme) keeps working exactly as it did.
 */
function toNodeMaterial(m) {
  if (!m || m.isNodeMaterial) return m;
  const Cls = m.isMeshBasicMaterial ? THREE.MeshBasicNodeMaterial : THREE.MeshStandardNodeMaterial;
  const n = new Cls();
  // Copy across only what the object builders actually set. A blanket
  // `copy()` would drag the source's own type/uuid along with it.
  n.color.copy(m.color ?? new THREE.Color(0xffffff));
  n.map = m.map ?? null;
  n.side = m.side;
  n.transparent = m.transparent;
  n.opacity = m.opacity;
  n.depthWrite = m.depthWrite;
  // BLENDING TOO. The street lamp's ground pool is an AdditiveBlending quad,
  // and dropping the blend mode here turns a glow into a flat grey disc lying
  // on the road — the material still works, it just looks wrong, which is the
  // hardest kind of omission to spot.
  n.blending = m.blending;
  n.alphaMap = m.alphaMap ?? null;
  n.alphaTest = m.alphaTest;
  if (m.roughness !== undefined && n.roughness !== undefined) n.roughness = m.roughness;
  if (m.metalness !== undefined && n.metalness !== undefined) n.metalness = m.metalness;
  if (m.emissive && n.emissive) {
    n.emissive.copy(m.emissive);
    n.emissiveIntensity = m.emissiveIntensity;
  }
  n.colorNode = materialColor;
  n.toneMapped = m.toneMapped;
  return n;
}

/**
 * Build the shared template for one scenery type: converted materials, bloom
 * where it is meant to glow, capsule colliders attached.
 */
function buildTemplate(def) {
  const root = def.build({ ...(def.source ? def.source() : AT_ORIGIN), params: def.params });
  if (!root) return null;
  root.name = `Scenery_${def.id}`;

  // One converted material per SOURCE material, not per mesh — the object
  // builders already share a frame/leg/housing material across their units, and
  // converting per mesh would undo that and multiply the shader compiles.
  const converted = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material;
    if (Array.isArray(src)) return; // no multi-material meshes in these builders
    if (!converted.has(src)) {
      const next = toNodeMaterial(src);
      // Anything meant to read as a light source goes through v3's selective
      // bloom. The LED panels carry their own emissive in-shader and are already
      // handled by their own material; this catches the lamp faces.
      if (next !== src && next.emissive && next.emissiveIntensity > 1) {
        applyBloomMRT(next, materialColor);
      }
      converted.set(src, next);
    }
    o.material = converted.get(src);
    // Static roadside geometry: cast, but never bother receiving. These stand off
    // the racing line and self-shadowing a lattice of lamp housings is spend with
    // nothing to show for it.
    o.receiveShadow = false;
  });

  // Batch down to one draw per material. AFTER the material conversion, so the
  // grouping keys off the converted materials the meshes will actually render
  // with, and BEFORE the collider markers, which are not meshes and would not be
  // touched either way. Flatten first — an InstancedMesh cannot be merged.
  flattenInstanced(root);
  mergeByMaterial(root);

  // ── A SOLID WALL, FOR THE RUN OBJECTS ─────────────────────────────────────
  // An invisible box in the SOLID bake, and every visible mesh opted out of it,
  // so the chassis is stopped by one clean shape instead of by a chain-link
  // curtain that is a single flat quad (which the hull sampling walks through)
  // or by 9k triangles of barbed wire (which it should not have to test).
  if (def.solidWall) {
    const { thickness, height, length } = def.solidWall;
    root.traverse((o) => { if (o.isMesh) o.userData.noCollide = true; });
    const wall = new THREE.Mesh(new THREE.BoxGeometry(thickness, height, length));
    wall.name = "SceneryWall";
    wall.position.y = height / 2;
    wall.visible = false;
    root.add(wall);
  }

  // Colliders. Declared on the DEF rather than scraped off the meshes because
  // the builders emit InstancedMeshes (a floodlight's lamps, an LED board's
  // legs), whose object origin is the unit, not the individual leg.
  for (const c of def.capsules ?? []) {
    const marker = new THREE.Object3D();
    marker.name = "SceneryCapsule";
    marker.position.set(c.x ?? 0, (c.height ?? 1) / 2, c.z ?? 0);
    marker.userData.capsule = { radius: c.radius, height: c.height };
    root.add(marker);
  }

  // ── MARK THE GEOMETRY AS NOT-YOURS ────────────────────────────────────────
  //
  // `makeSceneryProp` hands out `template.clone()`, which shares the geometry by
  // reference with every placement, every brush ghost, and the prop instancer's
  // scratch copy — all of which have code that frees geometry they think they
  // own. `disposeScenery` stays the one owner. See markSharedGeometry for the
  // full account of what freeing it looks like (a null GPUBuffer at draw, every
  // frame, from an object that still reports a healthy index count).
  markSharedGeometry(root);
  return root;
}

const _templates = new Map();

/**
 * A placement of scenery `id`, sharing geometry and materials with every other
 * placement of the same id. Returns null for an unknown id so a stale saved
 * track cannot take the page down.
 */
export function makeSceneryProp(id) {
  const def = SCENERY_MAP.get(id);
  if (!def) return null;
  if (!_templates.has(id)) {
    const built = buildTemplate(def);
    // A null template is NOT cached. Every builder here is synchronous today, so
    // null means the builder genuinely made nothing — but caching it would turn
    // a one-off failure into a permanently dead palette tile, and the moment one
    // of these grows an async dependency that is exactly the bug you get.
    if (!built) return null;
    _templates.set(id, built);
  }
  const t = _templates.get(id);
  return t ? t.clone() : null;
}

/** Free the shared templates — for a full teardown, not per placement. */
export function disposeScenery() {
  for (const t of _templates.values()) {
    t?.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose();
      o.material?.dispose?.();
    });
  }
  _templates.clear();
}
