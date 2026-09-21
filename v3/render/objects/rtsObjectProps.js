/**
 * The RTS object kit, as placeable props.
 *
 * Adapter only: rtsParts/rtsEmplacement/rtsHut/rtsVillageHut already build the
 * geometry, and LivePropManager already places things. This is the seam
 * between them, the same job v2's proceduralObjectProps does for the road kit.
 *
 * WHY A SEPARATE KIT FROM v2's OBJECTS AT ALL
 *
 * MEASURED on nam-rts at the zoom it is played at — camera 34 m up, ground
 * 20-97 m out, 1919 px wide — the screen resolves about **14 px per metre at
 * the focus and 7.5 px at the far edge**. So:
 *
 *   barbed wire, 0.01 m wire     0.1 px      invisible
 *   chain-link mesh              sub-pixel   invisible
 *   a 0.25 m post                ~2-3 px     a faint mark
 *   a 1 m sandbag wall           ~10 px      reads as a shape
 *
 * v2's objects are authored for a camera standing next to them, and no amount
 * of parameter tuning fixes that: fattening the wire 3x only got it to a faint
 * dotted line. An RTS asset has to be drawn for the distance it is seen from.
 * THE RULE THIS KIT IS BUILT TO: nothing below ~0.25 m reads; anything meant
 * to be seen wants 0.5 m; anything meant to be identified wants 1 m.
 *
 * Two consequences worth keeping in mind when adding pieces:
 *   - The SILHOUETTE and the top-down footprint carry the object, not surface
 *     detail — you are looking at its roof.
 *   - With the sun at 26 degrees a 2 m post throws a 4 m shadow, and the
 *     shadow reads when the post does not. Vertical elements are cheap.
 *
 * Each object builds `{ lods: [geometry], tris: [n] }`; LOD0 is what a placed
 * prop shows. They share ONE material: a per-vertex `matId` picks a cell of a
 * 4x3 canvas atlas, so hessian, iron, timber, thatch, bamboo and matting all
 * shade from ONE texture fetch in ONE draw. (A select() over seven textures
 * would sample all seven per pixel — select is not a branch.)
 */
import * as THREE from "three";
import {
  Fn, attribute, clamp, float, floor, fract, hash, instanceIndex, mix, mod,
  step, texture, uniform, uv, vec2,
} from "three/tsl";
import { rtsAtlas, ATLAS_COLS, ATLAS_ROWS, ATLAS_PAD } from "./rtsTextures.js";
import { RTS_OBJECTS } from "./rtsEmplacement.js";
import { HUT_OBJECT } from "./rtsHut.js";
import { VILLAGE_HUT_OBJECT } from "./rtsVillageHut.js";

/** Every RTS object, by id. The lab builds its catalogue the same way. */
export const RTS_OBJECT_CATALOG = {
  ...RTS_OBJECTS,
  [HUT_OBJECT.id]: HUT_OBJECT,
  [VILLAGE_HUT_OBJECT.id]: VILLAGE_HUT_OBJECT,
};

let _material = null;

/**
 * The one material every RTS object shares. Built on first use — it bakes a
 * canvas atlas, which is not work to do at module load.
 */
export function rtsObjectMaterial() {
  if (_material) return _material;
  const atlas = rtsAtlas();
  const uTintVar = uniform(0.3);
  const uAo = uniform(1.0);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0 });
  m.name = "RtsObject";
  m.colorNode = Fn(() => {
    const id = attribute("matId", "float");
    const tone = attribute("tone", "float");
    const ao = attribute("ao", "float");
    const cols = float(ATLAS_COLS), rows = float(ATLAS_ROWS);
    const col = mod(id, cols);
    // CanvasTexture flips Y, so canvas row 0 lands at the TOP of the texture.
    // Indexing rows straight down swaps the two halves and every surface
    // samples the wrong one — flip the ROW, not the texture.
    const row = rows.sub(float(1)).sub(floor(id.div(cols)));
    const pad = float(ATLAS_PAD);
    // Tiled by hand, because an atlas cell cannot wrap; inset by ATLAS_PAD so
    // mips do not bleed into the neighbouring cell.
    // Camouflage tiles 2.5x larger than every other surface: its shapes are the
    // pattern, and at the kit's 2 m per tile they repeat as visible stripes down
    // a container or a hut. (One multiply; MAT.camo is 9.)
    const camoScale = mix(float(1), float(0.4), step(float(8.5), id).mul(step(id, float(9.5))));
    const inCell = clamp(fract(uv().mul(camoScale)), pad, float(1).sub(pad));
    const st = vec2(col.add(inCell.x).div(cols), row.add(inCell.y).div(rows));
    const surf = texture(atlas, st).rgb;
    // Per-PART tone (patched sheets, older bags) and per-INSTANCE tint, so a
    // hamlet is not one house repeated.
    const toned = surf.mul(mix(float(0.74), float(1.20), tone).mul(uTintVar).add(float(1).sub(uTintVar)));
    const inst = mix(float(0.88), float(1.10), hash(instanceIndex.add(19)));
    // Baked contact AO — what stops it reading as a flat cut-out from above.
    return toned.mul(inst).mul(mix(float(1), ao, uAo));
  })();
  _material = m;
  return m;
}

/** `{ "<label>": { factoryId, defaults } }` — the shape addLiveProp wants. */
export const RTS_PROP_DEFS = Object.fromEntries(
  Object.values(RTS_OBJECT_CATALOG).map((o) => [
    o.label,
    { factoryId: `rts:${o.id}`, defaults: { ...o.defaults } },
  ]),
);

/** Labels in catalogue order, for a panel to list. */
export const RTS_PROP_LABELS = Object.values(RTS_OBJECT_CATALOG).map((o) => o.label);

/**
 * Register every RTS object as a live prop factory.
 * @param {{ registerFactory: (id: string, make: Function) => void }} livePropManager
 */
export function registerRtsObjectFactories(livePropManager) {
  for (const o of Object.values(RTS_OBJECT_CATALOG)) {
    livePropManager.registerFactory(`rts:${o.id}`, (params) => {
      const built = o.build({ ...o.defaults, ...params });
      const geo = built?.lods?.[0];
      const group = new THREE.Group();
      group.name = o.label;
      if (geo) {
        const mesh = new THREE.Mesh(geo, rtsObjectMaterial());
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
      return {
        group,
        dispose() {
          // The MATERIAL is shared and outlives every instance; only the
          // geometry belongs to this one.
          group.traverse((c) => { if (c.isMesh) c.geometry?.dispose(); });
        },
      };
    });
  }
}
