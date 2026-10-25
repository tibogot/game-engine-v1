// THE SANGAR, THE BLENDER PIECE (tools/blender/sangar.py, 2026-10-21 — PIECES_INVENTORY "Sangar: REDO"). The ALN's
// dry-stone firing position as the sappers' buildable (algBuild BUILDS.sangar):
//
//   THE GEOMETRY   the GLB's intact near level, dequantised and at the kit's scale (×1.3), carrying the old
//                  piece's data (rtsAlgeria buildSangar: its footprint, the gun and its pivot) — so the cover,
//                  the structure, the AI and the placement ghost read it as before. Its own material
//                  (userData.labMaterial: the baked atlas — kitView draws it).
//   CONSTRUCTION   STONE BY STONE, not stretched out of the ground: every part carries the moment it is laid
//                  (COLOR_0.r, written by the Blender script — the props first, the courses one by one along
//                  the arc, the capstones, the lip, the brush). A site's own material (siteMaterial(): one
//                  uniform) sinks the parts not yet laid 200 m under the ground (8 m left a tall piece's cabin
//                  showing at its foot — the mirador) and DROPS each one into place
//                  over the last 6 % before its moment. GPU only. Done: the shared material back.
//   CLOSE UP       (2026-10-21, you: "the stones look a bit too smooth from close"): the baked atlas spreads one
//                  2048 texture over every stone of three states — soft. The SCAN'S OWN relief is tiled over the
//                  stones in the shader (rock_boulder_dry's normal and height, triplanar in the piece's space,
//                  ~0.45 m a tile): its normal added to the baked one, its height darkening the pits (cavity).
//                  6 texture taps, no new mesh.
import { KIT_BLEND, earthDetail, ensureEarthMask, groundBlend, groundBlendApp, hasEarth } from "./algGroundBlend.js";
import * as THREE from "three";
import { abs, attribute, clamp, float, mix, normalGeometry, normalMap, normalize, positionGeometry, positionLocal, pow, select, smoothstep, step, texture, transformNormalToView, uniform, vec3 } from "three/tsl";
import { HOUSE_FAR, houseMesh, loadHouses } from "./algHouse.js";
import { loadTexture } from "../../v3/render/textureLoad.js";
import { buildAmbushScreen, buildArmsCache, buildBarbedWire, buildFlnInfirmary, buildFortPoint, buildLookout, buildMgNest, buildMineMarker, buildMirador, buildRefuge, buildSangar, buildSearchlightTower } from "../../v3/render/objects/rtsAlgeria.js";
import { loadSandbagWall, simulatedWallMesh } from "./algSandbags.js";
import { buildMortarPitV2 } from "./algMortarPit.js";
import { FOLIAGE_PRESETS } from "../../v3/app/state/foliageScatterState.js";
import { buildFrenchPost } from "../../v3/render/objects/rtsFrenchPost.js";
import { buildFarmstead } from "../../v3/render/objects/rtsAlgVillage.js";
import { buildSasPost } from "../../v3/render/objects/rtsAlgeria.js";
import { MAT } from "../../v3/render/objects/rtsParts.js";
import { stencilMesh } from "../../v3/render/objects/rtsStencils.js";

/** The detail's look: its tile (m), the scan normal's strength, the cavity's depth. ?stonedetail=0 = without. */
export const STONE_DETAIL = { tile: 0.5, normal: 1.6, cavity: 0.3 };
const DETAIL_OFF = typeof location !== "undefined" && new URLSearchParams(location.search).get("stonedetail") === "0";
let _detailTex = null;
const detailTextures = () => (_detailTex ??= Promise.all(["nor_gl", "disp"].map((k) => loadTexture(`/textures/build/rock_boulder_dry/rock_boulder_dry_${k}_1k.jpg`)))
  .then(([nor, disp]) => { for (const t of [nor, disp]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.needsUpdate = true; } return { nor, disp }; }));

/** A stone material: the baked atlas (colour + its normal map) with the scan's relief tiled over it. */
function stoneMaterial(src, T) {
  const m = new THREE.MeshStandardNodeMaterial({ map: src.map, normalMap: src.normalMap, color: src.color, roughness: src.roughness, metalness: src.metalness, side: THREE.FrontSide });
  if (!T || DETAIL_OFF) return m;
  const n = normalGeometry.normalize();
  let w = pow(abs(n), vec3(4));
  w = w.div(w.x.add(w.y).add(w.z));
  const p = positionGeometry.div(STONE_DETAIL.tile);
  const tap = (tex, uvv) => texture(tex, uvv);
  // THE NORMAL, triplanar — the "whiteout" blend per axis (as the sandbags' burlap, algSandbags.js)
  const k = float(STONE_DETAIL.normal);
  const tn = (uvv) => tap(T.nor, uvv).xyz.mul(2).sub(1).mul(vec3(k, k, 1));
  const tx = tn(p.zy), ty = tn(p.xz), tz = tn(p.xy);
  const nX = vec3(tx.xy.add(n.zy), abs(tx.z).mul(n.x)).zyx;
  const nY = vec3(ty.xy.add(n.xz), abs(ty.z).mul(n.y)).xzy;
  const nZ = vec3(tz.xy.add(n.xy), abs(tz.z).mul(n.z));
  const detail = normalize(nX.mul(w.x).add(nY.mul(w.y)).add(nZ.mul(w.z)));
  // added to the BAKED normal (view space: normalNode is view space): the detail's turn away from the surface
  const baked = src.normalMap ? normalMap(texture(src.normalMap)) : transformNormalToView(n);
  // (the difference AFTER the transform: transformNormalToView NORMALISES — given the small offset itself, it came
  // out a full-length vector and threw every normal sideways, a camouflage pattern, 2026-10-21)
  m.normalNode = normalize(baked.add(transformNormalToView(detail).sub(transformNormalToView(n))));
  // THE CAVITY: the scan's height, low = a pit or a crack, darker
  const h = tap(T.disp, p.zy).x.mul(w.x).add(tap(T.disp, p.xz).x.mul(w.y)).add(tap(T.disp, p.xy).x.mul(w.z));
  const cav = mix(float(1 - STONE_DETAIL.cavity), float(1.03), smoothstep(0.1, 0.62, h));
  m.colorNode = texture(src.map).rgb.mul(cav);
  m.normalMap = null;   // (its normal is the node's now)
  return m;
}

/**
 * CLOTH, CLOSE UP (2026-10-22, you: "the cloth roof looks flat" … "a fabric material texture would read more
 * immediately"): a Blender piece's cloth (COLOR_0.g — drystone.writeBuildOrder: 1 canvas, 0.5 a wool blanket) gets a
 * real FABRIC photo (Poly Haven, CC0): the plain weave of LINEN for canvas and tarps, a HERRINGBONE wool for the
 * blankets — its normal and its threads' light and dark, in the piece's space; nothing else of the piece is touched.
 * CHEAP: the face's dominant axis picks ONE tap per map (the sandbags' way, not triplanar's three) — four taps.
 * ?clothdetail=0 = without.
 */
export const CLOTH_DETAIL = { linen: { tile: 1.1, normal: 1.4, mean: 0.7 }, wool: { tile: 0.9, normal: 1.3, mean: 0.45 }, contrast: 1.2 };   // (tiles: a HEAVY duck canvas, coarser than the photo's linen — at its real 0.27 m the threads were under a pixel from 4 m)
const CLOTH_OFF = typeof location !== "undefined" && new URLSearchParams(location.search).get("clothdetail") === "0";
let _clothTex = null;
const clothTextures = () => (_clothTex ??= Promise.all(["rough_linen/rough_linen", "poly_wool_herringbone/poly_wool_herringbone"].flatMap((p) => ["nor_gl", "diff"].map((k) => loadTexture(`/textures/build/${p}_${k}_1k.jpg`))))
  .then((ts) => { for (const t of ts) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.needsUpdate = true; } return { linen: { nor: ts[0], diff: ts[1] }, wool: { nor: ts[2], diff: ts[3] } }; }));
function clothMaterial(src, T, colorType) {
  const m = new THREE.MeshStandardNodeMaterial({ map: src.map, normalMap: src.normalMap ?? null, color: src.color, roughness: src.roughness, metalness: src.metalness, side: THREE.FrontSide });
  if (!T || CLOTH_OFF) return m;
  const g = attribute("color", colorType).y;
  const on = smoothstep(0.15, 0.35, g);                             // cloth at all
  const wool = smoothstep(0.85, 0.6, g);                            // 0.5 → the wool, 1 → the linen
  const n = normalGeometry.normalize();
  const ax = abs(n);
  const isX = ax.x.greaterThan(ax.y).and(ax.x.greaterThan(ax.z)), isY = ax.y.greaterThan(ax.z);
  const weave = (W, D) => {
    const p = positionGeometry.div(D.tile);
    const uvv = select(isX, p.zy, select(isY, p.xz, p.xy));
    const t = texture(W.nor, uvv).xyz.mul(2).sub(1).mul(vec3(D.normal, D.normal, 1));
    const nn = select(isX, vec3(t.xy.add(n.zy), abs(t.z).mul(n.x)).zyx, select(isY, vec3(t.xy.add(n.xz), abs(t.z).mul(n.y)).xzy, vec3(t.xy.add(n.xy), abs(t.z).mul(n.z))));
    const c = texture(W.diff, uvv).rgb;
    const lum = c.x.mul(0.2126).add(c.y.mul(0.7152)).add(c.z.mul(0.0722)).div(D.mean);   // ~1: the thread's light against the cloth's mean
    return { nn: normalize(nn), lum };
  };
  const a = weave(T.linen, CLOTH_DETAIL.linen), b = weave(T.wool, CLOTH_DETAIL.wool);
  const detail = normalize(mix(a.nn, b.nn, wool));
  const baked = src.normalMap ? normalMap(texture(src.normalMap)) : transformNormalToView(n);
  // (the detail's turn added AFTER the transform — transformNormalToView normalises; see stoneMaterial)
  m.normalNode = normalize(baked.add(transformNormalToView(detail).sub(transformNormalToView(n)).mul(on)));
  const lum = mix(a.lum, b.lum, wool);
  const shade = mix(float(1), clamp(float(1).add(lum.sub(1).mul(CLOTH_DETAIL.contrast)), 0.55, 1.35), on);
  m.colorNode = texture(src.map).rgb.mul(shade);
  m.normalMap = null;
  return m;
}

/**
 * LIME RENDER, CLOSE UP (2026-10-22, the Blender post — a 22 m piece's atlas is soft up close): the render's and the
 * rubble's photo detail tiled in the piece's space — the plaster's relief and its light and dark, ONE tap per map
 * (the face's dominant axis), over the baked atlas. ?plasterdetail=0 = without.
 */
export const PLASTER_DETAIL = { tile: 1.6, normal: 1.2, contrast: 0.55, mean: 0.72 };
const PLASTER_OFF = typeof location !== "undefined" && new URLSearchParams(location.search).get("plasterdetail") === "0";
let _plasterTex = null;
const plasterTextures = () => (_plasterTex ??= Promise.all(["nor_gl", "diff"].map((k) => loadTexture(`/textures/build/white_plaster_rough_01/white_plaster_rough_01_${k}_1k.jpg`)))
  .then((ts) => { for (const t of ts) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.needsUpdate = true; } return { nor: ts[0], diff: ts[1] }; }));
function plasterMaterial(src, T) {
  const m = new THREE.MeshStandardNodeMaterial({ map: src.map, normalMap: src.normalMap ?? null, color: src.color, roughness: src.roughness, metalness: src.metalness, side: THREE.FrontSide });
  if (!T || PLASTER_OFF) return m;
  const n = normalGeometry.normalize(), ax = abs(n);
  const isX = ax.x.greaterThan(ax.y).and(ax.x.greaterThan(ax.z)), isY = ax.y.greaterThan(ax.z);
  const p = positionGeometry.div(PLASTER_DETAIL.tile);
  const uvv = select(isX, p.zy, select(isY, p.xz, p.xy));
  const k = float(PLASTER_DETAIL.normal);
  const t = texture(T.nor, uvv).xyz.mul(2).sub(1).mul(vec3(k, k, 1));
  const nn = normalize(select(isX, vec3(t.xy.add(n.zy), abs(t.z).mul(n.x)).zyx, select(isY, vec3(t.xy.add(n.xz), abs(t.z).mul(n.y)).xzy, vec3(t.xy.add(n.xy), abs(t.z).mul(n.z)))));
  const baked = src.normalMap ? normalMap(texture(src.normalMap)) : transformNormalToView(n);
  m.normalNode = normalize(baked.add(transformNormalToView(nn).sub(transformNormalToView(n))));
  const c = texture(T.diff, uvv).rgb, lum = c.x.mul(0.2126).add(c.y.mul(0.7152)).add(c.z.mul(0.0722)).div(PLASTER_DETAIL.mean);
  m.colorNode = texture(src.map).rgb.mul(clamp(float(1).add(lum.sub(1).mul(PLASTER_DETAIL.contrast)), 0.6, 1.25));
  m.normalMap = null;
  return m;
}

const S = 1.3;   // the kit's scale (the Blender piece is in real metres)
let _detail = null;
const _pieces = new Map();   // "kit:type" → { p: Promise<boolean>, geo }

/** The sangar's stone material for a kit mesh (the lab's houseMesh copies): the same detail. Null until loaded. */
export function sangarStoneMaterial(src) { return _detail ? stoneMaterial(src, _detail) : null; }

/**
 * Load a BLENDER STONE PIECE once (a kit of algHouse.js: the sangar, the arms cache): its intact near level as a
 * game geometry — plain floats, the kit's scale, the OLD piece's data (`old()`: its footprint, gun… the game's
 * systems read them), the stone material, the construction material. Resolves true when pieceGeometry() has it.
 */
function loadBlenderPiece(kit, type, old, extra = null, { stone = true, cloth = false, plaster = false } = {}) {
  const key = `${kit}:${type}`;
  if (_pieces.has(key)) return _pieces.get(key).p;
  const rec = { geo: null, p: null };
  _pieces.set(key, rec);
  rec.p = Promise.all([loadHouses(kit), detailTextures().catch(() => null), cloth ? clothTextures().catch(() => null) : null, plaster ? plasterTextures().catch(() => null) : null]).then(([parts, T, CT, PT]) => {
    if (!parts?.[`${type}:intact`]) return false;
    const lod = houseMesh(type, "intact", 1)?.children[0];
    const near = lod?.levels?.[0]?.object, farM = lod?.levels?.[1]?.object;
    if (!near) return false;
    const g = plainGeometry(near);
    g.scale(S, S, S);
    g.computeBoundingBox(); g.computeBoundingSphere();
    // ITS FAR LEVEL (2026-10-21 — you: "are you optimising every asset?"): built pieces drew the near level at every
    // distance, shadows too. One far geometry shared by every copy; trackLod() swaps it in past HOUSE_FAR.
    const far = farM && farM !== near ? plainGeometry(farM) : null;
    if (far) { far.scale(S, S, S); far.computeBoundingBox(); far.computeBoundingSphere(); }
    const o = old();
    g.userData = { ...o.userData };
    o.dispose();
    _detail = T;
    // (stone pieces: the scan's close-up detail; a timber one — the mirador — its baked material as it is)
    g.userData.labMaterial = stone ? stoneMaterial(near.material, T)
      : plaster ? plasterMaterial(near.material, PT) : cloth ? clothMaterial(near.material, CT, g.attributes.color?.itemSize === 3 ? "vec3" : "vec4") : plainMaterial(near.material);
    // THE GROUND BLEND (2026-10-24, algGroundBlend KIT_BLEND — a piece's own material, built here from the kit's): its foot
    // in the ground's colour, its hue toward the ground's
    { const lm = g.userData.labMaterial, ga = groundBlendApp(), cfg = KIT_BLEND[kit];
      if (ga && cfg && lm && !lm.userData.gbBase) {
        const base = lm.colorNode ?? (lm.map ? texture(lm.map).rgb.mul(vec3(lm.color.r, lm.color.g, lm.color.b)) : vec3(lm.color.r, lm.color.g, lm.color.b));
        lm.userData.gbBase = base; lm.colorNode = groundBlend(ga, base, cfg);
      }
      // ITS EARTH (algGroundBlend earthDetail — the berm's smear): the soil photo over the faces the bake marked earth
      if (lm && (hasEarth(g) | hasEarth(far)) && !lm.userData.earth) {   // (both levels renamed: `|`, not `||`)
        lm.userData.earth = true;
        lm.colorNode = earthDetail(lm.colorNode ?? (lm.map ? texture(lm.map).rgb.mul(vec3(lm.color.r, lm.color.g, lm.color.b)) : vec3(lm.color.r, lm.color.g, lm.color.b)));
      }
      if (lm?.userData.earth) { ensureEarthMask(g); ensureEarthMask(far); }   // (each level carries the mask its material reads)
    }
    g.userData.siteMaterial = () => siteMaterial(near.material, g.attributes.color?.itemSize === 3 ? "vec3" : "vec4", stone);
    g.userData.blender = true;
    g.userData.kitType = [kit, type];   // (its damaged / ruin states: pieceState)
    g.userData.farGeometry = far;
    if (far) far.userData = g.userData;   // (the same data at either level: footprint, gun, materials)
    // ITS PAINTED WORDS (bkit.stencils — the kit's decal quads, a child of the near level): drawn with the piece
    const dec = parts[`${type}:intact`]?.decal;
    if (dec) {
      const dg = plainGeometry(dec); dg.scale(S, S, S);
      const dm = new THREE.Mesh(dg, dec.material); dm.name = "Decal"; dm.castShadow = false; dm.receiveShadow = true;
      g.userData.extra = [...(g.userData.extra ?? []), dm];
    }
    extra?.(g);
    rec.geo = g;
    return true;
  }).catch((e) => { console.warn(`[${kit}] the Blender piece did not load:`, e); return false; });
  return rec.p;
}
const pieceGeometry = (kit, type) => _pieces.get(`${kit}:${type}`)?.geo ?? null;

/** A non-stone piece's material: its baked atlas (colour, and its relief if baked), front faces. */
function plainMaterial(src) {
  return new THREE.MeshStandardNodeMaterial({ map: src.map, normalMap: src.normalMap ?? null, color: src.color, roughness: src.roughness, metalness: src.metalness, side: THREE.FrontSide });
}

/**
 * THE MIRADOR (tools/blender/mirador.py — timber, corrugated iron): its cabin's sandbags the user's cloth-simulated
 * parapet (sandbagMirador.glb — algSandbags), on the deck: an `extra` of the piece (kitView adds it), shown LATE in
 * the construction (`late`: algBuild hides it until then) — the bags go in once the plank walls stand.
 */
const MIRADOR_DECK = (6.2 + 0.13) * S;
export const loadMirador = () => loadBlenderPiece("mirador", "mirador", () => buildMirador(), null, { stone: false }).then(async (ok) => {
  if (!ok) return ok;
  const g = pieceGeometry("mirador", "mirador");
  if (g.userData.miradorBags) return ok;
  await loadSandbagWall();
  const bags = simulatedWallMesh("MiradorBags", "mirador");
  if (bags) {
    bags.position.set(0, MIRADOR_DECK, 0);
    bags.userData.late = 0.74;
    g.userData.extra = [...(g.userData.extra ?? []), bags];
    g.userData.miradorBags = true;
  }
  // ITS GEAR (the searchlight and the AA-52 — their own atlas, mirador.py buildGear): an LOD extra (near / far at
  // HOUSE_FAR), shown at the very end of the build
  const gl = houseMesh("gear", "intact", 1)?.children[0];
  const gn = gl?.levels?.[0]?.object, gf = gl?.levels?.[1]?.object;
  if (gn) {
    const mk = (src) => { const pg = plainGeometry(src); pg.scale(S, S, S); const m = new THREE.Mesh(pg, plainMaterial(src.material)); m.castShadow = m.receiveShadow = true; return m; };
    const lod = new THREE.LOD();
    lod.name = "MiradorGear";
    lod.addLevel(mk(gn), 0);
    if (gf && gf !== gn) lod.addLevel(mk(gf), HOUSE_FAR);
    lod.userData.late = 0.97;
    g.userData.extra = [...(g.userData.extra ?? []), lod];
  }
  return ok;
});
export const miradorGeometry = () => pieceGeometry("mirador", "mirador");
/**
 * THE MG NEST (tools/blender/mgNest.py, 2026-10-21 — you: "except the sandbags everything looks too cheap"): the spoil
 * platform, the roof on squared posts, the stores — and the user's simulated RING (sandbagRing: an extra, laid course
 * by course on the site — algSandbags siteBags), the AA-52 its own turning mesh (userData.gun, its own material).
 */
export const loadMgNest = () => loadBlenderPiece("mgnest", "mg", () => buildMgNest({ noBags: true }), null, { stone: false }).then(async (ok) => {
  if (!ok) return ok;
  const g = pieceGeometry("mgnest", "mg");
  if (g.userData.nestReady) return ok;
  await loadSandbagWall();
  const ring = simulatedWallMesh("SandbagRing", "ring");
  if (ring) g.userData.extra = [...(g.userData.extra ?? []), ring];
  const gunLod = houseMesh("gun", "intact", 1)?.children[0];
  const gunNear = gunLod?.levels?.[0]?.object;
  if (gunNear) {
    const gg = plainGeometry(gunNear);
    gg.scale(S, S, S);
    // (its pivot 1.2 m up, its tripod on the nest's floor (0.45) — the old piece's 1.5 m hung the new tripod in the air;
    // the barrel clears the ring's top, 0.95)
    g.userData.gun = { geo: gg, pivot: [0, 1.2 * S, -1.6 * S], material: plainMaterial(gunNear.material) };
    g.userData.parts = { ...(g.userData.parts ?? {}), gun: gg };
  }
  g.userData.nestReady = true;
  return ok;
});
export const mgNestGeometry = () => (pieceGeometry("mgnest", "mg")?.userData.nestReady ? pieceGeometry("mgnest", "mg") : null);

/**
 * THE MORTAR PIT (tools/blender/mortarPit.py, 2026-10-21): the berm, the ammunition, the aiming stakes — the user's
 * simulated ring (sandbagPit) on its crest — and the 81 mm mortar (milprops: the old piece's frame, so its pivot,
 * muzzle and axis — the crew, the shot — stay the old piece's; at the mortar teams' size, 0.82).
 */
export const loadMortarPit = () => loadBlenderPiece("mortarpit", "mortar", () => { const o = buildMortarPitV2(); o.userData.extra = []; return o; }, null, { stone: false }).then(async (ok) => {
  if (!ok) return ok;
  const g = pieceGeometry("mortarpit", "mortar");
  if (g.userData.pitReady) return ok;
  await loadSandbagWall();
  const ring = simulatedWallMesh("SandbagPit", "pit");
  g.userData.extra = ring ? [ring] : [];
  const gl = houseMesh("m81", "intact", 1)?.children[0];
  const gn = gl?.levels?.[0]?.object;
  if (gn && g.userData.gun) {
    const gg = plainGeometry(gn);
    gg.scale(S * 0.82, S * 0.82, S * 0.82);
    g.userData.gun = { ...g.userData.gun, geo: gg, material: plainMaterial(gn.material) };
    g.userData.parts = { ...(g.userData.parts ?? {}), gun: gg };
  }
  g.userData.pitReady = true;
  return ok;
});
export const mortarPitGeometry = () => (pieceGeometry("mortarpit", "mortar")?.userData.pitReady ? pieceGeometry("mortarpit", "mortar") : null);

/**
 * THE FORTIFIED POINT (tools/blender/fortPoint.py, 2026-10-21): the spoil banked outside the three walls, the stores
 * inside (crates, jerrycans, the field telephone and its reel, tools, a tarp) — the user's simulated walls (sandbagFort,
 * kit frame) an extra, laid course by course on the site. The old piece's data (footprint, cover) kept.
 */
export const loadFortPoint = () => loadBlenderPiece("fortpoint", "point", () => buildFortPoint({ noBags: true }), null, { stone: false }).then(async (ok) => {
  if (!ok) return ok;
  const g = pieceGeometry("fortpoint", "point");
  if (g.userData.fortReady) return ok;
  await loadSandbagWall();
  const walls = simulatedWallMesh("SandbagFort", "fort");
  g.userData.extra = walls ? [walls] : [];
  g.userData.fortReady = true;
  return ok;
});
export const fortPointGeometry = () => (pieceGeometry("fortpoint", "point")?.userData.fortReady ? pieceGeometry("fortpoint", "point") : null);

/**
 * THE SEARCHLIGHT TOWER (tools/blender/searchlightTower.py, 2026-10-21): the steel lattice, the deck, the caged ladder,
 * the pedestal, the generator shed — its HEAD (type "lamp": the yoke and the drum) the mesh algSearchlight sweeps, its
 * origin on the trunnions; the user's simulated wall (sandbagSlShed) in front of the shed. The old piece's data kept.
 */
const SL = { deck: 9.08, ped: 0.95, lampZ: -0.35, wall: [3.5, -1.85] };   // (searchlightTower.py DECK, PED, LAMP, the shed's front)
export const loadSearchlight = () => loadBlenderPiece("sltower", "sltower", () => buildSearchlightTower(), null, { stone: false }).then(async (ok) => {
  if (!ok) return ok;
  const g = pieceGeometry("sltower", "sltower");
  if (g.userData.slReady) return ok;
  await loadSandbagWall();
  const bags = simulatedWallMesh("SearchlightBags", "slshed");
  if (bags) bags.position.set(SL.wall[0] * S, 0, SL.wall[1] * S);
  g.userData.extra = bags ? [bags] : [];
  const hl = houseMesh("lamp", "intact", 1)?.children[0];
  const hn = hl?.levels?.[0]?.object;
  if (hn) {
    const hg = plainGeometry(hn);
    hg.scale(S, S, S);
    const y = (SL.deck + SL.ped) * S;
    g.userData.lamp = { geo: hg, pivot: [0, y, SL.lampZ * S], beam: [0, y, (SL.lampZ - 0.36) * S], material: plainMaterial(hn.material) };
    g.userData.parts = { ...(g.userData.parts ?? {}), lamp: hg };
  }
  g.userData.slReady = true;
  return ok;
});
export const searchlightGeometry = () => (pieceGeometry("sltower", "sltower")?.userData.slReady ? pieceGeometry("sltower", "sltower") : null);

/**
 * THE FIELD POSTS (tools/blender/fieldPosts.py, 2026-10-21): the FORWARD POST (a French radio post dug in — the old
 * piece was the Vietnam kit's US shelter) with the user's simulated horseshoe (sandbagRadio), and the AID STATION
 * (the army's ridge tent, the red cross). No old data worth keeping: their own footprints (game metres).
 */
const ownData = (footprint) => () => { const g = new THREE.BufferGeometry(); g.userData = { footprint }; return g; };
export const loadForwardPost = () => loadBlenderPiece("fieldposts", "fwdradio", ownData({ cx: -0.75, cz: 0, hx: 3.95, hz: 3.2, height: 3 }), null, { stone: false, cloth: true }).then(async (ok) => {
  if (!ok) return ok;
  const g = pieceGeometry("fieldposts", "fwdradio");
  if (g.userData.postReady) return ok;
  await loadSandbagWall();
  const bags = simulatedWallMesh("RadioBags", "radio");
  g.userData.extra = bags ? [bags] : [];
  g.userData.postReady = true;
  return ok;
});
export const forwardPostGeometry = () => (pieceGeometry("fieldposts", "fwdradio")?.userData.postReady ? pieceGeometry("fieldposts", "fwdradio") : null);
export const loadAidStation = () => loadBlenderPiece("fieldposts", "aidtent", ownData({ cx: -0.26, cz: -1.3, hx: 4.0, hz: 3.65, height: 3.4 }), null, { stone: false, cloth: true }).then((ok) => {
  if (!ok) return ok;
  const g = pieceGeometry("fieldposts", "aidtent");
  if (g.userData.markReady) return ok;
  const m = markDecal("intact");
  if (m) { m.userData.late = 0.95; g.userData.extra = [m]; }
  g.userData.markReady = true;
  return ok;
});
export const aidStationGeometry = () => (pieceGeometry("fieldposts", "aidtent")?.userData.markReady ? pieceGeometry("fieldposts", "aidtent") : null);
/**
 * THE RED CROSSES as a MESH DECAL (fieldPosts.py "aidmark", 2026-10-21 — you: "the red cross looks bad, why don't you
 * use decals"): cut from the tent's settled canvas a centimetre proud, its own small atlas (sharp); drawn with a depth
 * offset over the canvas, no shadow of its own. An LOD (near / far at HOUSE_FAR). `state`: the tent's.
 */
export function markDecal(state) {
  const l = houseMesh("aidmark", state, 1)?.children[0];
  const n = l?.levels?.[0]?.object, f = l?.levels?.[1]?.object;
  if (!n) return null;
  const mat = plainMaterial(n.material);
  mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2;
  const mk = (src) => { const pg = plainGeometry(src); pg.scale(S, S, S); const m = new THREE.Mesh(pg, mat); m.castShadow = false; m.receiveShadow = true; return m; };
  const lod = new THREE.LOD();
  lod.name = "AidMark";
  lod.addLevel(mk(n), 0);
  if (f && f !== n) lod.addLevel(mk(f), HOUSE_FAR);
  return lod;
}

/**
 * THE FLN'S FIELD WORKS (tools/blender/flnPosts.py, 2026-10-21): the REFUGE (a hummock dug into, a stone-lined trench
 * to a log door, a blanket across it) — its scrub the engine's plants on the mound (refugePlantSpots: the same mound
 * formula as the Blender piece), so from the air it is one more scrubby hummock; the INFIRMARY (crooked poles, a
 * patchwork tarp, straw pallets and blankets — cloth), a little scrub at its back. The old pieces' data kept.
 */
export const loadRefuge = () => loadBlenderPiece("flnposts", "refuge", () => buildRefuge(), (g) => { g.userData.screenPlants = refugePlantSpots(); }, { stone: false, cloth: true });
export const refugeGeometry = () => pieceGeometry("flnposts", "refuge");
export const loadInfirmary = () => loadBlenderPiece("flnposts", "infirm", () => buildFlnInfirmary(), (g) => { g.userData.screenPlants = infirmaryPlantSpots(); }, { stone: false, cloth: true });
export const infirmaryGeometry = () => pieceGeometry("flnposts", "infirm");
const hash01 = (i, s) => { let v = Math.imul(i * 977 + s * 131, 2654435761) >>> 0; v ^= v >>> 15; v = Math.imul(v, 2246822519) >>> 0; return (v >>> 0) / 4294967296; };
/** The refuge's mound (flnPosts.py moundBase): kit metres. */
const MOUND = { cz: 0.6, hx: 3.4, hz: 3.2, h: 1.75 };
const moundBase = (x, z) => MOUND.h * Math.max(0, 1 - (x / MOUND.hx) ** 2 - ((z - MOUND.cz) / MOUND.hz) ** 2) ** 1.6;
function refugePlantSpots() {
  const out = [];
  for (let i = 0; out.length < 13 && i < 200; i++) {
    const x = (hash01(i, 1) * 2 - 1) * 2.9, z = MOUND.cz + (hash01(i, 2) * 2 - 1) * 2.8;
    const h = moundBase(x, z);
    if (h < 0.25 || (Math.abs(x) < 1.5 && z < 0.1)) continue;          // (off the mound; clear of the door and its trench)
    if (out.some((p) => Math.hypot(p.x / S - x, p.z / S - z) < 0.9)) continue;
    // (sunk a little: the mound's noise is ±0.07 — never a shrub over a hollow)
    out.push({ kind: hash01(i, 3) < 0.6 ? "broomCut" : "juniperScrub", x: x * S, y: (h - 0.1) * S, z: z * S, rot: hash01(i, 4) * 6.28, scale: 0.75 + hash01(i, 5) * 0.45, seed: i, t: 0.8 + 0.15 * hash01(i, 6) });
  }
  return out;
}
/** The infirmary's scrub: along its back and its weather side, behind the dry-stone screen (kit z > 2.2). */
function infirmaryPlantSpots() {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const x = -2.6 + i * 0.85 + (hash01(i, 7) - 0.5) * 0.3, z = 2.35 + hash01(i, 8) * 0.6;
    out.push({ kind: i % 3 ? "broomCut" : "juniperScrub", x: x * S, y: 0, z: z * S, rot: hash01(i, 9) * 6.28, scale: 0.7 + hash01(i, 10) * 0.4, seed: 50 + i, t: 0.9 });
  }
  return out;
}

/**
 * THE FRENCH POST IN BLENDER (tools/blender/postKit.py, 2026-10-22): the bordj at the whitewashed houses' standard,
 * on the old piece's exact layout — so ITS data stays the game's: the gate and its leaves, the tower guns' muzzles,
 * the sandbag slots (the user's simulated bags, children of the placed post), the flag's mount, the footprint, the
 * cover lines; its markings the boards and the tricolour only (the walls carry their own weathering).
 */
export const loadFrenchPost = () => loadBlenderPiece("postkit", "post", () => buildFrenchPost({ detail: 2, noBags: true, signsOnly: true, footStone: MAT.limestone }), null, { stone: false, plaster: true });
export const frenchPostGeometry = () => { const g = pieceGeometry("postkit", "post"); if (g) g.userData.farFrom = 150; return g; };   // (its far level only past the widest RTS zoom)
/**
 * The placed post (the showroom's, the producer's mesh) to the Blender one: its geometry and material swapped, its
 * children kept (the gate's leaves, the flag, the simulated bags), its markings re-made (signs only), its far level.
 */
export function swapPost(mesh, app) {
  const geo = frenchPostGeometry();
  if (!geo || !mesh?.isMesh || mesh.geometry.userData.blender) return false;
  const oldGeo = mesh.geometry;
  swapPlaced({ frenchPost: mesh }, /^frenchPost$/, geo, app);
  // (the OLD geometry's extra attributes kept on the new, zero-filled — matId, tone, ao: three's SHADOW pass kept the
  // post's render state with the old attribute list and its next draw read an attribute the new geometry has not —
  // "reading 'id'", the render loop stopped, 2026-10-22; disposing the old geometry did not clear it. Both levels.)
  const L = mesh.userData.lod;
  for (const g of new Set([mesh.geometry, L?.near, L?.far].filter(Boolean))) {
    const n = g.attributes.position.count;
    for (const [k, a] of Object.entries(oldGeo.attributes)) if (!g.attributes[k]) g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(n * a.itemSize), a.itemSize));
  }
  mesh.geometry.userData.stencil = geo.userData.stencil;
  const old = mesh.getObjectByName("Stencils");
  if (old) mesh.remove(old);
  const st = stencilMesh(geo.userData.stencil);
  if (st) mesh.add(st);
  return true;
}

/** The barbed wire (tools/blender/barbedWire.py — rusted steel: no stone detail). */
export const loadBarbedWire = () => loadBlenderPiece("barbedwire", "barbed", () => buildBarbedWire(), null, { stone: false });
export const barbedWireGeometry = () => pieceGeometry("barbedwire", "barbed");

/** The sangar (tools/blender/sangar.py). */
export const loadSangar = () => loadBlenderPiece("sangar", "sangar", () => buildSangar(), seatSangarGun);
/** THE FLN'S MARKS (tools/blender/flnMarks.py, 2026-10-25 — you: "very cheap … make way better"): the lookout on its spur,
 *  the mine's cairn — the old pieces' footprints and cover kept, the Blender model drawn. */
export const loadLookout = () => loadBlenderPiece("flnmarks", "lookout", () => buildLookout());
export const lookoutGeometry = () => pieceGeometry("flnmarks", "lookout");
export const loadMineMarker = () => loadBlenderPiece("flnmarks", "minemark", () => buildMineMarker());
export const mineMarkerGeometry = () => pieceGeometry("flnmarks", "minemark");
/** THE FARMSTEAD (tools/blender/farmstead.py, 2026-10-25): the old kit's layout data (FARM — its cover, navigation, the
 *  yard's spots), the Blender model drawn; its burnt state the map's burnt farm. */
export const loadFarmstead = () => loadBlenderPiece("farmstead", "farm", () => buildFarmstead({ seed: 1970 }), null, { stone: false });
export const farmGeometry = () => pieceGeometry("farmstead", "farm");
/** THE SAS POST (tools/blender/sasPost.py, 2026-10-25 — you: "the best looking for my AAA RTS"): the old piece's data (its
 *  footprint, cover, the flag's mount, the night lamp), the Blender model drawn, YOUR simulated sandbagged corner added. */
export const loadSasPost = () => loadBlenderPiece("saspost", "sas", () => buildSasPost({}), null, { stone: false }).then(async (ok) => {
  if (!ok) return ok;
  const g = pieceGeometry("saspost", "sas");
  if (g.userData.sasReady) return ok;
  await loadSandbagWall();
  const bags = simulatedWallMesh("SasBags", "sas");
  g.userData.extra = [...(g.userData.extra ?? []), ...(bags ? [bags] : [])];   // (after its painted words)
  g.userData.stencil = null;   // (the old piece's painted boards: the model has its own)
  // ITS WELL: the village props kit's (you: "we have wells already … is it not better looking?") on its spot — tools/
  // blender/sasPost.py WELL, kit metres x1.3 (algPenProps dresses it: kitView, and algBuild after the swap)
  g.userData.pens = [{ kind: "well", x: -6.5 * S, y: 0, z: -4.5 * S, yaw: 0.3 }];
  g.userData.sasReady = true;
  return ok;
});
export const sasGeometry = () => (pieceGeometry("saspost", "sas")?.userData.sasReady ? pieceGeometry("saspost", "sas") : null);
/**
 * THE FM ON THE LIP (2026-10-25, you: the sangar's "weapon seems to be floating"): its pivot was the OLD sangar's height
 * (rtsAlgeria buildSangar, 1.28 m), level on its bipod. Unmanned, the gun LIES on the parapet (bipod folded): rays down
 * onto the Blender stones under its receiver and under its barrel, the gun set on the higher of the two (its receiver's
 * half height over it, ×1.3). Measured first try, on its bipod's feet: the receiver hung 25 cm over the stones.
 */
function seatSangarGun(g) {
  const gun = g.userData.gun;
  if (!gun?.pivot) return;
  const [px, , pz] = gun.pivot, K = 1.3, body = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  const top = (z) => new THREE.Raycaster(new THREE.Vector3(px, 10, z), new THREE.Vector3(0, -1, 0), 0, 20).intersectObject(body, false)[0]?.point.y ?? -Infinity;
  const y = Math.max(top(pz), top(pz - 0.4 * K));   // (under the receiver, under the barrel)
  if (y > -Infinity) gun.pivot = [px, y + 0.065 * K, pz];
}
/** The arms cache (tools/blender/armsCache.py). */
export const loadArmsCache = () => loadBlenderPiece("armscache", "arms", () => buildArmsCache());
export const armsCacheGeometry = () => pieceGeometry("armscache", "arms");
/** The ambush screen (tools/blender/ambushScreen.py): its stone; its SCRUB the engine's plants (screenPlantSpots). */
export const loadAmbushScreen = () => loadBlenderPiece("ambushscreen", "ambush", () => buildAmbushScreen(), (g) => { g.userData.screenPlants = screenPlantSpots(); });
export const ambushScreenGeometry = () => pieceGeometry("ambushscreen", "ambush");

/**
 * THE SCREEN'S SCRUB (2026-10-21 — the hedges' lesson: Blender sticks read cheap, the plant generator's shrubs
 * don't): CUT broom (retama — what was cut and stood up: no flowers, dry; FOLIAGE_PRESETS.broomCut) and JUNIPER stood in the footing along its line
 * (ambushScreen.py SCREEN_LINE — the same formula), a firing gap every 2.1 m; each its moment `t` in the build
 * (after the footing). Piece-local, game metres. A seeded hash: every screen the same scrub.
 */
const SCREEN = { L: 3.5, FH: 0.5 };
const screenLine = (x) => 0.22 * Math.sin(0.9 * x + 0.7);
function screenPlantSpots() {
  const h = (i, s) => { let v = Math.imul(i * 977 + s * 131, 2654435761) >>> 0; v ^= v >>> 15; v = Math.imul(v, 2246822519) >>> 0; return (v >>> 0) / 4294967296; };
  const out = [];
  let i = 0;
  for (let x = -SCREEN.L + 0.25; x < SCREEN.L - 0.2; x += 0.36 + h(i, 1) * 0.14, i++) {
    if (Math.abs(((x + SCREEN.L) % 2.1) - 1.05) < 0.24) continue;          // the firing gaps
    const juniper = h(i, 2) < 0.3;
    const sz = FOLIAGE_PRESETS[juniper ? "juniperScrub" : "broomCut"].size;
    // ~1.5 m (real) above the footing: the men crouched behind it are hidden
    out.push({ kind: juniper ? "juniperScrub" : "broomCut", x: x * S, y: (SCREEN.FH - 0.12) * S, z: (screenLine(x) + (h(i, 3) - 0.5) * 0.24) * S,
      scale: ((juniper ? 1.9 : 2.2) / sz) * (0.85 + h(i, 4) * 0.3), rot: h(i, 5) * 6.283, seed: h(i, 6), t: 0.7 + 0.27 * (x + SCREEN.L) / (2 * SCREEN.L) });
  }
  return out;
}
/**
 * Stand a screen's scrub up to `progress` (0..1): the plants whose moment has come, each tagged with the mesh's
 * owner id (dropScreenPlants takes them out). `plants`: the game's PlacedFoliage (the showroom's).
 */
export function growScreenPlants(plants, mesh, progress = 1) {
  const spots = mesh?.geometry?.userData?.screenPlants;
  if (!plants || !spots) return;
  for (const k of ["broomCut", "juniperScrub"]) if (!plants.types.has(k)) plants.setType(k, structuredClone(FOLIAGE_PRESETS[k]));
  const done = (mesh.userData.screenPlanted ??= new Set());
  const v = new THREE.Vector3();
  mesh.updateMatrixWorld(true);
  spots.forEach((p, i) => {
    if (done.has(i) || p.t > progress) return;
    v.set(p.x, p.y, p.z);
    mesh.localToWorld(v);
    plants.add(p.kind, v.x, v.y, v.z, { rotY: p.rot, scale: p.scale, seed: p.seed });
    plants.plants[plants.plants.length - 1].owner = mesh.uuid;
    done.add(i);
  });
}
/** Take a screen's scrub out (a cancelled site, a destroyed screen). */
export function dropScreenPlants(plants, mesh) {
  if (!plants || !mesh) return;
  plants.removeWhere((p) => p.owner === mesh.uuid);
  mesh.userData.screenPlanted?.clear();
}

/**
 * The pre-placed copies of a piece (the showroom's, the landmarks' — built with the old geometry before the Blender
 * one loaded): their geometry and material swapped, each keeping its own data (footprint, name).
 */
/** `q` given every attribute `from` has and it lacks, zero-filled (a drawn mesh's shadow-pass state keeps its old
 *  attribute list — the trap below; setPieceState too: the burnt farm, swapped then set burnt, 2026-10-25). */
function padAttributes(q, from) {
  if (!q || !from) return;
  const cnt = q.attributes.position.count;
  for (const [k, a] of Object.entries(from.attributes)) if (!q.attributes[k]) q.setAttribute(k, new THREE.BufferAttribute(new Float32Array(cnt * a.itemSize), a.itemSize));
}
export function swapPlaced(showroom, re, geo, app = null) {
  if (!geo) return 0;
  let n = 0;
  for (const [name, mesh] of Object.entries(showroom ?? {})) {
    if (!re.test(name) || !mesh?.isMesh) continue;
    const oldGeo = mesh.geometry;
    const g = geo.clone();
    g.userData = { ...geo.userData, ...mesh.geometry.userData, labMaterial: geo.userData.labMaterial };
    mesh.geometry = g;
    mesh.material = geo.userData.labMaterial;
    // (a Blender searchlight's HEAD: its own data and mesh — the old piece's lamp would win the merge and stay)
    if (geo.userData.lamp) {
      g.userData.lamp = geo.userData.lamp;
      const old = mesh.getObjectByName("Lamp");
      if (old) mesh.remove(old);
      const lm = new THREE.Mesh(geo.userData.lamp.geo, geo.userData.lamp.material);
      lm.name = "Lamp"; lm.position.set(...geo.userData.lamp.pivot); lm.castShadow = true;
      mesh.add(lm);
    }
    for (const x of geo.userData.extra ?? []) mesh.add(x.clone());   // (the piece's own extras: the mirador's bags)
    if (geo.userData.farGeometry) {
      // (its far level carries this copy's data too)
      const f = geo.userData.farGeometry.clone(); f.userData = g.userData; g.userData.farGeometry = f;
      trackLod(app, mesh);
    }
    // (the OLD geometry's attributes the new lacks kept, zero-filled — the kit's matId / tone / ao: a mesh already DRAWN
    // keeps its shadow-pass render state with the old attribute list, and its next draw read an attribute the new has
    // not — "reading 'id'", the render loop stopped (the post, the training's range, 2026-10-22). Both levels.)
    for (const q of [g, g.userData.farGeometry].filter(Boolean)) padAttributes(q, oldGeo);
    n++;
  }
  return n;
}

/**
 * A kit mesh's geometry in plain floats and real metres: meshopt QUANTISES the attributes (16-bit, the node's scale
 * and offset undo them) — to floats, then the node's transform. The stone detail tiles in the geometry's own space:
 * on the quantised one it tiled ~1000x too fine and averaged to a flat blue-grey (the lab, 2026-10-21).
 */
export function plainGeometry(mesh) {
  mesh.updateMatrix();
  const g = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(mesh.geometry.attributes)) {
    const n = a.count, s = a.itemSize, f = new Float32Array(n * s);
    for (let i = 0; i < n; i++) for (let j = 0; j < s; j++) f[i * s + j] = a.getComponent(i, j);
    g.setAttribute(k, new THREE.BufferAttribute(f, s));
  }
  g.setIndex(mesh.geometry.index ? Array.from(mesh.geometry.index.array) : null);
  g.applyMatrix4(mesh.matrix);
  if (g.attributes.normal) g.normalizeNormals();
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

/** The Blender sangar's geometry (shared: clone it per copy), or null until loaded. */
export function sangarGeometry() { return pieceGeometry("sangar", "sangar"); }

/**
 * NEAR / FAR for a placed Blender piece (a built sangar or cache, a swapped pre-placed one): it stays ONE Mesh — the
 * site, the structures, the cover and the picking hold it — and its GEOMETRY is swapped each frame by the camera's
 * distance (near within HOUSE_FAR, the shared far beyond; the shadow pass draws the same). No program change: the
 * two levels have the same attributes. One hook for every tracked mesh.
 */
const _tracked = new Set();
let _hooked = false;
export function trackLod(app, mesh) {
  const far = mesh?.geometry?.userData?.farGeometry;
  if (!far) return;
  mesh.userData.lod = { near: mesh.geometry, far };
  _tracked.add(mesh);
  if (_hooked || !app?.addPreRenderHook) return;
  _hooked = true;
  const p = new THREE.Vector3();
  app.addPreRenderHook(() => {
    const cam = app.camera;
    for (const m of _tracked) {
      if (!m.parent) { _tracked.delete(m); continue; }
      const L = m.userData.lod;
      m.getWorldPosition(p);
      // (a piece's own switch distance — userData.farFrom: the post, 30 m across, read its far level from the default RTS
      // zoom and lost its wire, ladders, parade stones — 2026-10-22)
      const want = p.distanceTo(cam.position) < (m.geometry.userData.farFrom ?? HOUSE_FAR) ? L.near : L.far;
      if (m.geometry !== want) m.geometry = want;
    }
  });
}
/**
 * THE DAMAGE STATES IN THE GAME (2026-10-22 — every Blender piece has its damaged and ruin models: the game now shows
 * them). A placed piece is swapped to `state` ("intact" | "damaged" | "ruin"): its near and far geometry (built once
 * per kit:type:state, shared by every copy), and its extras — the guns and the searchlight's head go with the ruin,
 * the mirador's gear takes its own state, the simulated sandbags slump in the ruin. The copy's own data (footprint,
 * name) is kept. False for a piece that is not a Blender one.
 */
const _states = new Map();   // "kit:type:state" → { near, far }
function stateGeometry(kitType, state) {
  const [kit, type] = kitType, key = `${kit}:${type}:${state}`;
  if (_states.has(key)) return _states.get(key);
  const lod = houseMesh(type, state, 1)?.children[0];
  const n = lod?.levels?.[0]?.object, f = lod?.levels?.[1]?.object;
  let rec = null;
  if (n) {
    const mk = (src) => { const g = plainGeometry(src); g.scale(S, S, S); g.computeBoundingBox(); g.computeBoundingSphere(); return g; };
    rec = { near: mk(n), far: f && f !== n ? mk(f) : null };
  }
  _states.set(key, rec);
  return rec;
}
export function setPieceState(mesh, state) {
  if (mesh?.userData?.setState) return mesh.userData.setState(state);   // (a piece with its own: the motor pool, algMotorPool)
  const L = mesh?.userData?.lod;
  const base = mesh.userData.intactGeo ?? L?.near ?? mesh.geometry;
  const ud = base?.userData;
  if (!ud?.blender || !ud.kitType) return false;
  if ((mesh.userData.pieceState ?? "intact") === state) return true;
  mesh.userData.intactGeo = base;
  mesh.userData.intactFar ??= L?.far ?? null;
  let near = base, far = mesh.userData.intactFar;
  if (state !== "intact") {
    const g = stateGeometry(ud.kitType, state);
    if (!g) return false;
    near = g.near.clone(); near.userData = ud;          // (the copy's own data on its own clone — the cover reads it)
    far = g.far ?? null;
    // (its material reads the earth mask — algGroundBlend earthDetail: the state's geometry carries one too, or the
    // draw finds no attribute — a render error "reading 'id'", the burnt farm, 2026-10-25)
    ensureEarthMask(near); if (far) ensureEarthMask(far);
    padAttributes(near, mesh.geometry); padAttributes(far, mesh.geometry);   // (the drawn mesh's attributes kept)
  }
  if (L) { L.near = near; L.far = far ?? near; mesh.geometry = near; } else mesh.geometry = near;
  mesh.userData.pieceState = state;
  const ruin = state === "ruin";
  for (const c of mesh.children) {
    if (c.name === "Gun" || c.name === "Lamp") c.visible = !ruin;
    else if (c.name === "MiradorGear") {
      // the gear's own state (the searchlight knocked down on the deck, thrown beside the wreck)
      const gg = state === "intact" ? null : stateGeometry(["mirador", "gear"], state);
      c.userData.intact ??= c.levels.map((l) => l.object.geometry);
      c.levels.forEach((l, i) => { l.object.geometry = gg ? (i === 0 ? gg.near : gg.far ?? gg.near) : c.userData.intact[i]; });
    } else if (/^(Sandbag|MiradorBags|RadioBags|SearchlightBags)/.test(c.name)) {
      // the bags slumped in the ruin (thrown down, burst); the mirador's fell with its cabin
      c.userData.scale0 ??= c.scale.clone();
      if (c.name === "MiradorBags") {
        // fell with its cabin in the ruin; in the damaged state they LEAN with it (mirador.py leanAll: −6.5° about
        // the game axis (1, 0, −1) through the opposite foot (LS, 0, LS) — Blender's frame is a proper rotation of
        // the game's, the angle carries over as it is)
        c.visible = !ruin;
        c.userData.pos0 ??= c.position.clone();
        if (state === "damaged") {
          const piv = new THREE.Vector3(2.6 * S, 0, 2.6 * S), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, -1).normalize(), -6.5 * Math.PI / 180);
          c.position.copy(c.userData.pos0).sub(piv).applyQuaternion(q).add(piv);
          c.quaternion.copy(q);
        } else { c.position.copy(c.userData.pos0); c.quaternion.identity(); }
      } else {
        // squashed from the bags' OWN foot, not the ground's (a ring on a berm 0.6 m up sank into it)
        c.userData.pos0 ??= c.position.clone();
        if (c.userData.foot == null) {
          let lo = Infinity;
          c.traverse((o) => { if (o.geometry) { o.geometry.computeBoundingBox?.(); lo = Math.min(lo, o.geometry.boundingBox?.min.y ?? 0); } });
          c.userData.foot = Number.isFinite(lo) ? lo : 0;
        }
        const k = ruin ? 0.45 : 1, s0 = c.userData.scale0;
        c.scale.set(s0.x * (ruin ? 1.06 : 1), s0.y * k, s0.z * (ruin ? 1.06 : 1));
        c.position.copy(c.userData.pos0);
        c.position.y += c.userData.foot * s0.y * (1 - k);
      }
    }
  }
  return true;
}

/** Stop tracking (a cancelled site): its own near geometry back, so disposing it never frees the shared far one. */
export function untrackLod(mesh) {
  if (!mesh?.userData?.lod) return;
  mesh.geometry = mesh.userData.lod.near;
  _tracked.delete(mesh);
  delete mesh.userData.lod;
}

/** A construction site's material: { material, set(progress 0..1) }. */
export function siteMaterial(src, colorType = "vec4", stone = true) {
  const progress = uniform(0);
  const t = attribute("color", colorType).x;                      // the part's moment
  const dt = progress.sub(t);
  const hidden = float(1).sub(step(t, progress));                 // not laid yet
  const fall = clamp(float(1).sub(dt.div(0.06)), 0, 1).mul(step(0.001, t));   // over its last 6 %
  // (the finished material itself — its colour, relief and detail: a different one shifted the tone the moment it was done)
  const m = stone ? stoneMaterial(src, _detail) : plainMaterial(src);
  m.positionNode = positionLocal.add(vec3(0, fall.mul(fall).mul(0.7).sub(hidden.mul(200)), 0));
  m.castShadowPositionNode = m.positionNode;   // (the parts to come cast no shadow — the kit's construction learnt it)
  return { material: m, set(p) { progress.value = p; } };
}
