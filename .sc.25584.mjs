// ============================================================================
// SCENERY — the v2 objects-lab pieces (LED board, billboard, floodlight) as
// placeable road-builder props.
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
import { applyBloomMRT } from "./.scb.25584.mjs";
import { buildLedMatrixMesh } from "./v2/objects/ledMatrix.js";
import { buildBillboardMesh } from "./v2/objects/billboard.js";
import { buildFloodlightMesh } from "./v2/objects/floodlight.js";

/** Single point at the origin on flat ground — the prop root does the placing. */
const AT_ORIGIN = { points: [{ x: 0, y: 0, z: 0 }], getWorldHeight: () => 0 };

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
  const root = def.build({ ...AT_ORIGIN, params: def.params });
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
  if (!_templates.has(id)) _templates.set(id, buildTemplate(def));
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
