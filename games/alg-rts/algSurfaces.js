// THE SURFACES (moved out of algSangar.js 2026-10-26: the Blender pieces AND the instanced house kits read them — algHouse).
import * as THREE from "three";
import { abs, attribute, clamp, float, normalGeometry, normalMap, normalView, normalize, positionGeometry, select, texture, transformNormalToView, vec3 } from "three/tsl";
import { loadTexture } from "../../v3/render/textureLoad.js";

/**
 * EACH SURFACE ITS OWN PHOTO (2026-10-25, you on the post: "that look so cheap and not AAA rts at all, company of heroes
 * look way better"): the CoH way — a sharp tiling texture per SURFACE over the baked atlas, which keeps only what it
 * is good at (the large-scale colour, the grime, the occlusion). The Blender kit writes each face's surface into the
 * build colour's .b (drystone.surfaceClass / 8: 1 plaster, 2 stone, 3 wood, 4 metal, 5 concrete; 0 = the bake alone);
 * here that surface's photo — its relief and its light and dark — tiled in the piece's space, ONE tap per map (the
 * face's dominant axis). `mean`: the photo's own mean LINEAR luminance, measured (its light and dark taken about it). ?surface=0 =
 * the old plaster-everywhere detail.
 */
export const SURFACE_DETAIL = {
  plaster: { tex: "build/white_plaster_rough_01/white_plaster_rough_01_{k}_1k.jpg", tile: 1.6, normal: 1.2, contrast: 0.6, mean: 0.173 },
  stone: { tex: "build/seaworn_stone_tiles/seaworn_stone_tiles_{k}_1k.jpg", tile: 2.2, normal: 1.4, contrast: 0.9, mean: 0.205 },   // (dressed limestone blocks: the bordj's footing — a mossy slate wall read as camouflage)
  wood: { tex: "build/raw_plank_wall/raw_plank_wall_{k}_1k.jpg", tile: 1.4, normal: 1.1, contrast: 0.7, mean: 0.251 },
  metal: { tex: "build/Rust009/Rust009_{k}_1k.jpg", tile: 1.2, normal: 0.7, contrast: 0.6, mean: 0.111 },
  concrete: { tex: "pbr_materials/Concrete030_1K-JPG/Concrete030_1K-JPG_{k}.jpg", keys: { nor: "NormalGL", diff: "Color" }, tile: 2.0, normal: 1.0, contrast: 0.8, mean: 0.119 },
  // (the Aurès farms' and hamlets' stone: flat stones stacked dry — a kit swaps it in for "stone", loadBlenderPiece `surfaces: { stone: "drystone" }`)
  drystone: { tex: "build/rabdentse_ruins_wall/rabdentse_ruins_wall_{k}_1k.jpg", tile: 2.4, normal: 1.5, contrast: 0.7, mean: 0.05 },

  // (the M'zab's earth render: hand-floated, smoother than the bordj's lime — the plaster photo larger and softer: at 1.6 m its
  // pores read as a dotted grid over a 10 m tower, 2026-10-26)
  mudRender: { tex: "build/white_plaster_rough_01/white_plaster_rough_01_{k}_1k.jpg", tile: 3.4, normal: 0.55, contrast: 0.35, mean: 0.173 },
};
const SURFACE_ORDER = ["plaster", "stone", "wood", "metal", "concrete"];
export const SURFACE_OFF = typeof location !== "undefined" && new URLSearchParams(location.search).get("surface") === "0";
let _surfaceTex = null;
export const surfaceTextures = () => (_surfaceTex ??= Promise.all(Object.keys(SURFACE_DETAIL).map((s) => {
  const D = SURFACE_DETAIL[s], key = D.keys ?? { nor: "nor_gl", diff: "diff" };
  return Promise.all(["nor", "diff"].map((k) => loadTexture(`/textures/${D.tex.replace("{k}", key[k])}`)));
})).then((all) => {
  const T = {};
  all.forEach(([nor, diff], i) => {
    for (const t of [nor, diff]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.needsUpdate = true; }
    T[Object.keys(SURFACE_DETAIL)[i]] = { nor, diff };
  });
  return T;
}));
/** Does a geometry carry surfaces (any face's build colour .b set)? */
export function hasSurfaces(g) {
  const c = g?.attributes.color;
  if (!c || c.itemSize < 3) return false;
  for (let i = 0; i < c.count; i += 7) if (c.getZ(i) > 0.06) return true;
  return false;
}
export function surfaceMaterial(src, T, colorType, swap = {}) {   // (`swap`: a class drawn with another photo — { stone: "drystone" })
  const m = new THREE.MeshStandardNodeMaterial({ map: src.map, normalMap: src.normalMap ?? null, color: src.color, roughness: src.roughness, metalness: src.metalness, side: THREE.FrontSide });
  const cls = attribute("color", colorType).z.mul(8).round();
  const n = normalGeometry.normalize(), ax = abs(n);
  const isX = ax.x.greaterThan(ax.y).and(ax.x.greaterThan(ax.z)), isY = ax.y.greaterThan(ax.z);
  let nn = n, shade = float(1);
  SURFACE_ORDER.forEach((s, i) => {
    const D = SURFACE_DETAIL[swap[s] ?? s], W = T[swap[s] ?? s];
    const p = positionGeometry.div(D.tile);
    const uvv = select(isX, p.zy, select(isY, p.xz, p.xy));
    const k = float(D.normal);
    const t = texture(W.nor, uvv).xyz.mul(2).sub(1).mul(vec3(k, k, 1));
    const sn = normalize(select(isX, vec3(t.xy.add(n.zy), abs(t.z).mul(n.x)).zyx, select(isY, vec3(t.xy.add(n.xz), abs(t.z).mul(n.y)).xzy, vec3(t.xy.add(n.xy), abs(t.z).mul(n.z)))));
    const c = texture(W.diff, uvv).rgb, lum = c.x.mul(0.2126).add(c.y.mul(0.7152)).add(c.z.mul(0.0722)).div(D.mean);
    const sh = clamp(float(1).add(lum.sub(1).mul(D.contrast)), 0.5, 1.4);
    const on = cls.equal(i + 1);
    nn = select(on, sn, nn); shade = select(on, sh, shade);
  });
  // (the base normal three's own view normal — the INSTANCE'S turn included: from the unturned geometry normal an instanced
  // house lit from the wrong side, its shadow acne a dotted grid over the M'zab's towers, 2026-10-26)
  const baked = src.normalMap ? normalMap(texture(src.normalMap)) : normalView;
  // (the detail's turn added AFTER the transform — transformNormalToView normalises; see stoneMaterial)
  m.normalNode = normalize(baked.add(transformNormalToView(nn).sub(transformNormalToView(n))));
  m.colorNode = texture(src.map).rgb.mul(shade);
  m.normalMap = null;
  return m;
}

