import * as THREE from "three";
import { OBJECTS, OBJECT_MAP } from "../../objects/index.js";
import {
  preloadWindmillModel,
  updateWindmillRotors,
  disposeWindmillGroup,
  WINDMILL_DEFAULTS,
} from "../../objects/windmill.js";

/**
 * Adapter: exposes every procedural object in the registry (objects/index.js)
 * as a LivePropManager factory, so they place into the editor like the flag.
 *
 * The procedural contract is build({points, params, getWorldHeight}) → Group.
 * Props are single transforms, so we build each object at the LOCAL ORIGIN on
 * flat ground; the prop's transform (pos/rot/scale) then places it. Point
 * objects (lamp, light, windmill…) get a single point; span objects (fence,
 * bridge, power line, tyre wall, billboard…) get a centred straight segment
 * you stretch with scale (a proper path-prop can come later).
 */

const FLAT = () => 0;
const SPAN_HALF = 6; // half-length of the canonical local segment (metres)

function localPoints(desc) {
  if (desc.preview === "point" || (desc.minPoints ?? 2) < 2) {
    return [{ x: 0, y: 0, z: 0 }];
  }
  // 3 collinear points keep the CatmullRom segment straight + centred
  return [
    { x: -SPAN_HALF, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: SPAN_HALF, y: 0, z: 0 },
  ];
}

function resolveParams(desc, params) {
  const merged = { ...desc.defaults, ...(desc.initParams || {}), ...params };
  return desc.resolveParams ? desc.resolveParams(merged) : merged;
}

function buildProp(desc, params) {
  const p = resolveParams(desc, params);
  const group =
    desc.build({
      points: localPoints(desc),
      closed: false,
      params: p,
      getWorldHeight: FLAT,
    }) || new THREE.Group();

  const isWind = desc.id === "windmill";

  return {
    group,
    // self-animating objects (LED/traffic/gantry via the `time` node) need no
    // tick; only the windmill rotor is driven per-frame.
    update: isWind ? (dt) => updateWindmillRotors(group, p, dt) : undefined,
    dispose() {
      if (isWind) {
        disposeWindmillGroup(group);
        return;
      }
      group.traverse((o) => {
        o.geometry?.dispose?.();
        o.material?.dispose?.();
      });
    },
  };
}

function boundingBox(desc, params) {
  const built = buildProp(desc, params);
  const box = new THREE.Box3().setFromObject(built.group);
  built.dispose();
  if (box.isEmpty()) {
    box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  }
  return box;
}

/** Object labels in registry order — for building the palette UI. */
export const PROCEDURAL_PROP_LABELS = OBJECTS.map((o) => o.label);

/** { Label: id } for dropdowns (e.g. the spline-mode object selector). */
export const PROCEDURAL_OBJECT_OPTIONS = Object.fromEntries(
  OBJECTS.map((o) => [o.label, o.id]),
);

/** Label → { factoryId, defaults, bbox } — merge into the editor's live-prop defs. */
export const PROCEDURAL_PROP_DEFS = Object.fromEntries(
  OBJECTS.map((o) => [
    o.label,
    {
      factoryId: "obj:" + o.id,
      defaults: { ...o.defaults, ...(o.initParams || {}) },
      bbox: (params) => boundingBox(o, params ?? {}),
    },
  ]),
);

/** Freshly-built group for a placement-ghost preview, by factoryId ("obj:<id>"). */
export function buildProceduralPreviewGroup(factoryId) {
  if (typeof factoryId !== "string" || !factoryId.startsWith("obj:")) return null;
  const o = OBJECT_MAP.get(factoryId.slice(4));
  if (!o) return null;
  return buildProp(o, {}).group;
}

/** Schema (param list) for a procedural prop, by its factoryId ("obj:<id>"). */
export function proceduralSchemaFor(factoryId) {
  if (typeof factoryId !== "string" || !factoryId.startsWith("obj:")) return null;
  return OBJECT_MAP.get(factoryId.slice(4))?.schema ?? null;
}

/** Thumbnail items for bakeObjectThumbnails — keyed by label to match buttons. */
export function proceduralThumbnailItems() {
  return OBJECTS.map((o) => ({
    key: o.label,
    make: () => buildProp(o, {}).group,
  }));
}

/** Register a LivePropManager factory for every registry object. */
export function registerProceduralObjectFactories(livePropManager) {
  for (const o of OBJECTS) {
    livePropManager.registerFactory("obj:" + o.id, (params) =>
      buildProp(o, params),
    );
  }
  // windmill prop needs its GLB cached before first build
  preloadWindmillModel(WINDMILL_DEFAULTS.modelPath).catch(() => {});
}
