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
//                  uniform) sinks the parts not yet laid 8 m under the ground and DROPS each one into place
//                  over the last 6 % before its moment. GPU only. Done: the shared material back.
//   CLOSE UP       (2026-10-21, you: "the stones look a bit too smooth from close"): the baked atlas spreads one
//                  2048 texture over every stone of three states — soft. The SCAN'S OWN relief is tiled over the
//                  stones in the shader (rock_boulder_dry's normal and height, triplanar in the piece's space,
//                  ~0.45 m a tile): its normal added to the baked one, its height darkening the pits (cavity).
//                  6 texture taps, no new mesh.
import * as THREE from "three";
import { abs, attribute, clamp, float, mix, normalGeometry, normalMap, normalize, positionGeometry, positionLocal, pow, smoothstep, step, texture, transformNormalToView, uniform, vec3 } from "three/tsl";
import { HOUSE_FAR, houseMesh, loadHouses } from "./algHouse.js";
import { loadTexture } from "../../v3/render/textureLoad.js";
import { buildArmsCache, buildSangar } from "../../v3/render/objects/rtsAlgeria.js";

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
function loadBlenderPiece(kit, type, old) {
  const key = `${kit}:${type}`;
  if (_pieces.has(key)) return _pieces.get(key).p;
  const rec = { geo: null, p: null };
  _pieces.set(key, rec);
  rec.p = Promise.all([loadHouses(kit), detailTextures().catch(() => null)]).then(([parts, T]) => {
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
    g.userData.labMaterial = stoneMaterial(near.material, T);
    g.userData.siteMaterial = () => siteMaterial(near.material, g.attributes.color?.itemSize === 3 ? "vec3" : "vec4");
    g.userData.blender = true;
    g.userData.farGeometry = far;
    if (far) far.userData = g.userData;   // (the same data at either level: footprint, gun, materials)
    rec.geo = g;
    return true;
  }).catch((e) => { console.warn(`[${kit}] the Blender piece did not load:`, e); return false; });
  return rec.p;
}
const pieceGeometry = (kit, type) => _pieces.get(`${kit}:${type}`)?.geo ?? null;

/** The sangar (tools/blender/sangar.py). */
export const loadSangar = () => loadBlenderPiece("sangar", "sangar", () => buildSangar());
/** The arms cache (tools/blender/armsCache.py). */
export const loadArmsCache = () => loadBlenderPiece("armscache", "arms", () => buildArmsCache());
export const armsCacheGeometry = () => pieceGeometry("armscache", "arms");

/**
 * The pre-placed copies of a piece (the showroom's, the landmarks' — built with the old geometry before the Blender
 * one loaded): their geometry and material swapped, each keeping its own data (footprint, name).
 */
export function swapPlaced(showroom, re, geo, app = null) {
  if (!geo) return 0;
  let n = 0;
  for (const [name, mesh] of Object.entries(showroom ?? {})) {
    if (!re.test(name) || !mesh?.isMesh) continue;
    const g = geo.clone();
    g.userData = { ...geo.userData, ...mesh.geometry.userData, labMaterial: geo.userData.labMaterial };
    mesh.geometry = g;
    mesh.material = geo.userData.labMaterial;
    if (geo.userData.farGeometry) {
      // (its far level carries this copy's data too)
      const f = geo.userData.farGeometry.clone(); f.userData = g.userData; g.userData.farGeometry = f;
      trackLod(app, mesh);
    }
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
      const want = p.distanceTo(cam.position) < HOUSE_FAR ? L.near : L.far;
      if (m.geometry !== want) m.geometry = want;
    }
  });
}
/** Stop tracking (a cancelled site): its own near geometry back, so disposing it never frees the shared far one. */
export function untrackLod(mesh) {
  if (!mesh?.userData?.lod) return;
  mesh.geometry = mesh.userData.lod.near;
  _tracked.delete(mesh);
  delete mesh.userData.lod;
}

/** A construction site's material: { material, set(progress 0..1) }. */
export function siteMaterial(src, colorType = "vec4") {
  const progress = uniform(0);
  const t = attribute("color", colorType).x;                      // the part's moment
  const dt = progress.sub(t);
  const hidden = float(1).sub(step(t, progress));                 // not laid yet
  const fall = clamp(float(1).sub(dt.div(0.06)), 0, 1).mul(step(0.001, t));   // over its last 6 %
  // (the finished material itself — its colour, relief and detail: a different one shifted the tone the moment it was done)
  const m = stoneMaterial(src, _detail);
  m.positionNode = positionLocal.add(vec3(0, fall.mul(fall).mul(0.7).sub(hidden.mul(8)), 0));
  return { material: m, set(p) { progress.value = p; } };
}
