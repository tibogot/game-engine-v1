// MASONRY — the buildings built the way the sandstone rocks are (2026-10-11, you: "everything but the
// new rocks reads cheap; we are supposed to make it look way better — and very optimized").
//
// What the kit's houses lacked, and where it comes from here:
//   the SHAPE      not a box: a wall a real thickness, its corners rounded, leaning in a little as it
//                  rises, its face bulging stone by stone; the parapet's top broken; the openings set
//                  into the wall's depth with timber lintels; the roof a sagging earth terrace inside
//                  the parapet; the beams' ends through the walls
//   the MATERIAL   real photos (Poly Haven, CC0 — tools/fetchBuildingMaterials.mjs) projected in the
//                  piece's own space with their normal maps (no UVs to unwrap, no stretching), the
//                  colour pulled to the map's ochre; the foot in its own dust
//   the COST       one material per SURFACE (stone, earth, timber, planks), shared by every building
//                  made here: a whole site merged into one mesh per material — a few draws for a camp
// In the BUILDINGS LAB first (the camp's stone house): one piece to prove it.
import * as THREE from "three";
import { abs, dot, float, mix, normalGeometry, positionGeometry, pow, smoothstep, texture, transformNormalToView, uniform, vec2, vec3 } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// ── MATERIALS ───────────────────────────────────────────────────────────────────────────────────
const BUILD = (id, m) => `/textures/build/${id}/${id}_${m}_1k.jpg`;
const GROUND = (id, m) => `/textures/ground/${id}/${id}_${m}_1k.jpg`;
const _tex = new Map();
function photo(url, srgb) {
  if (_tex.has(url)) return _tex.get(url);
  const t = new THREE.TextureLoader().load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  _tex.set(url, t);
  return t;
}

/** The surfaces: the photo, metres a tile, its colour pulled to the map (tint × saturation). */
export const SURFACES = {
  // (the photo is a dark grey-brown slate: lifted and pulled to the Aurès' ochre)
  stone: { url: BUILD, id: "rabdentse_ruins_wall", tile: 2.2, tint: [2.7, 2.2, 1.6], sat: 0.45, rough: 0.95, foot: 0.32 },
  earth: { url: GROUND, id: "brown_mud_dry", tile: 3.0, tint: [0.95, 0.82, 0.66], sat: 0.75, rough: 1, foot: 0 },
  timber: { url: BUILD, id: "bark_willow_02", tile: 1.4, tint: [0.55, 0.46, 0.38], sat: 0.6, rough: 0.9, foot: 0 },
  planks: { url: BUILD, id: "raw_plank_wall", tile: 1.9, tint: [0.68, 0.58, 0.48], sat: 0.55, rough: 0.85, foot: 0 },
};
/** Live tunables (the lab). */
export const masonryLook = { footDark: uniform(1), footHeight: uniform(0.9) };

const _mats = new Map();
/**
 * A surface's material: its photo TRIPLANAR in the piece's own space (positionGeometry) — whatever
 * a face's turn, it shows the photo the right size and the right way up — and its normal map's relief
 * whiteout-blended into the geometry's normal (as the sandstone). The foot darker, toward the dust.
 */
export function surfaceMaterial(kind) {
  if (_mats.has(kind)) return _mats.get(kind);
  const s = SURFACES[kind];
  const D = photo(s.url(s.id, "diff"), true), N = photo(s.url(s.id, "nor_gl"));
  const n = normalGeometry.normalize();
  const wx = pow(abs(n.x), float(4)).add(1e-4), wy = pow(abs(n.y), float(4)).add(1e-4), wz = pow(abs(n.z), float(4)).add(1e-4);
  const sum = wx.add(wy).add(wz);
  const p = positionGeometry.div(s.tile);
  const uvX = vec2(p.z, p.y), uvY = vec2(p.x, p.z), uvZ = vec2(p.x, p.y);
  let col = texture(D, uvX).rgb.mul(wx).add(texture(D, uvY).rgb.mul(wy)).add(texture(D, uvZ).rgb.mul(wz)).div(sum);
  col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, float(s.sat)).mul(vec3(...s.tint));
  // The foot: dust and shade up to ~0.9 m (a wall stands in the ground, not on it).
  if (s.foot) {
    const f = float(1).sub(smoothstep(-0.2, masonryLook.footHeight, positionGeometry.y));
    col = mix(col, col.mul(vec3(0.62, 0.55, 0.47)), f.mul(s.foot).mul(masonryLook.footDark));
  }
  const tn = (uv) => texture(N, uv).xyz.mul(2).sub(1);
  const nX = tn(uvX), nY = tn(uvY), nZ = tn(uvZ);
  const wX = vec3(nX.xy.add(vec2(n.z, n.y)), abs(nX.z).mul(n.x)).zyx;
  const wY = vec3(nY.xy.add(vec2(n.x, n.z)), abs(nY.z).mul(n.y)).xzy;
  const wZ = vec3(nZ.xy.add(vec2(n.x, n.y)), abs(nZ.z).mul(n.z));
  const nObj = wX.mul(wx).add(wY.mul(wy)).add(wZ.mul(wz)).normalize();
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: s.rough, metalness: 0 });
  mat.name = `Masonry:${kind}`;
  mat.colorNode = col;
  mat.normalNode = transformNormalToView(nObj).normalize();
  _mats.set(kind, mat);
  return mat;
}
let _dark = null;
const darkMaterial = () => (_dark ??= new THREE.MeshBasicNodeMaterial({ color: 0x0a0806, name: "Masonry:dark" }));

// ── NOISE (value noise; Math.imul — a float multiply lost the hash's bits) ───────────────────────
function hash2(i, j, seed) {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise2(x, y, seed) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(i, j, seed), b = hash2(i + 1, j, seed), c = hash2(i, j + 1, seed), d = hash2(i + 1, j + 1, seed);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

// ── GEOMETRY HELPERS ────────────────────────────────────────────────────────────────────────────
/** An indexed grid of quads from a vertex function f(i, j) → [x,y,z], (ni+1)×(nj+1) vertices; `keep(i,j)` per quad. */
function grid(ni, nj, f, keep = () => true, closeI = false) {
  const pos = [], idx = [];
  const NI = closeI ? ni : ni + 1;
  for (let j = 0; j <= nj; j++) for (let i = 0; i < NI; i++) pos.push(...f(i, j));
  const at = (i, j) => j * NI + (closeI ? i % ni : i);
  for (let j = 0; j < nj; j++) for (let i = 0; i < ni; i++) {
    if (!keep(i, j)) continue;
    const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
    idx.push(a, d, c, a, c, b);   // (faces out of a perimeter walked as `base` does; up for a roof)
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
/** Quads as a geometry: each { q: [a, b, c, d], dir } — turned so its face looks along `dir`. */
function quads(list) {
  const pos = [];
  for (const { q, dir } of list) {
    let [a, b, c, d] = q;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] < 0) [b, d] = [d, b];
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
const strip = (g) => { for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal") g.deleteAttribute(k); if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]); return g; };

// ── THE STONE HOUSE ─────────────────────────────────────────────────────────────────────────────
/**
 * A dry-stone house of the Aurès with an earth terrace roof (world metres, the game's scale: the
 * kit's real × 1.3). Origin: the ground at its centre; its front (the door) looks down −Z.
 * Returns { group: one mesh per surface, footprint, door }.
 */
export function buildStoneHouse({ w = 11.7, d = 7.8, h = 3.5, t = 0.62, r = 0.5, seed = 1, door = { x: 0, w: 1.15, h: 2.2 }, windows = [{ x: -3.3, w: 0.62, y: 1.45, h: 0.58 }, { x: 3.3, w: 0.62, y: 1.45, h: 0.58 }] } = {}) {
  // THE PERIMETER: a rounded rectangle, s along it from the front's left end (x = −w/2 + r, z = −d/2).
  const fw = w - 2 * r, fd = d - 2 * r, arc = (Math.PI / 2) * r, L = 2 * fw + 2 * fd + 4 * arc;
  const segs = [
    { len: fw, f: (u) => [-w / 2 + r + u, -d / 2, 0, -1] },
    { len: arc, f: (u) => { const a = -Math.PI / 2 + u / r; return [w / 2 - r + Math.cos(a) * r, -d / 2 + r + Math.sin(a) * r, Math.cos(a), Math.sin(a)]; } },
    { len: fd, f: (u) => [w / 2, -d / 2 + r + u, 1, 0] },
    { len: arc, f: (u) => { const a = u / r; return [w / 2 - r + Math.cos(a) * r, d / 2 - r + Math.sin(a) * r, Math.cos(a), Math.sin(a)]; } },
    { len: fw, f: (u) => [w / 2 - r - u, d / 2, 0, 1] },
    { len: arc, f: (u) => { const a = Math.PI / 2 + u / r; return [-w / 2 + r + Math.cos(a) * r, d / 2 - r + Math.sin(a) * r, Math.cos(a), Math.sin(a)]; } },
    { len: fd, f: (u) => [-w / 2, d / 2 - r - u, -1, 0] },
    { len: arc, f: (u) => { const a = Math.PI + u / r; return [-w / 2 + r + Math.cos(a) * r, -d / 2 + r + Math.sin(a) * r, Math.cos(a), Math.sin(a)]; } },
  ];
  const base = (s) => {
    s = ((s % L) + L) % L;
    for (const g of segs) { if (s <= g.len) return g.f(s); s -= g.len; }
    return segs[0].f(0);
  };
  const frontS = (x) => x + w / 2 - r;   // s of a point on the front at x
  // THE OPENINGS (s0, s1, y0, y1 on the face) and the LINTELS over them (filled by a beam).
  const holes = [];
  const addHole = (x, ww, y0, hh, kind) => {
    holes.push({ s0: frontS(x - ww / 2), s1: frontS(x + ww / 2), y0, y1: y0 + hh, kind });
    holes.push({ s0: frontS(x - ww / 2 - 0.28), s1: frontS(x + ww / 2 + 0.28), y0: y0 + hh, y1: y0 + hh + 0.2, kind: "lintel" });
  };
  addHole(door.x, door.w, 0, door.h, "door");
  for (const wn of windows) addHole(wn.x, wn.w, wn.y, wn.h, "window");
  // Columns (every ~0.28 m, + the openings' edges) and rows (every ~0.3 m, + their edges).
  const sCols = new Set();
  for (let s = 0; s < L; s += 0.28) sCols.add(+s.toFixed(4));
  for (const o of holes) { sCols.add(+o.s0.toFixed(4)); sCols.add(+o.s1.toFixed(4)); }
  const S_ = [...sCols].sort((a, b) => a - b);
  const yRows = new Set([-0.3]);
  for (let y = 0; y < h; y += 0.32) yRows.add(+y.toFixed(4));
  for (const o of holes) { yRows.add(+o.y0.toFixed(4)); yRows.add(+o.y1.toFixed(4)); }
  yRows.add(h);
  const Y_ = [...yRows].sort((a, b) => a - b);
  // The parapet's broken top, per column; the roof's level inside it.
  const top = S_.map((s) => h + 0.42 + noise2(s * 0.9, 3.1, seed) * 0.13 + noise2(s * 3.1, 7.7, seed) * 0.05);
  const roofY = h + 0.06;
  // A wall point: the base line, out along its normal by the stones' bulge, in by the batter.
  const bulge = (s, y) => noise2(s * 1.6, y * 2.1, seed) * 0.035 + noise2(s * 0.45, y * 0.6, seed + 7) * 0.06 - Math.max(0, y) / h * 0.07;
  const outer = (s, y) => { const [x, z, nx, nz] = base(s), b = bulge(s, y); return [x + nx * b, y, z + nz * b]; };
  const inner = (s, y) => { const [x, z, nx, nz] = base(s); return [x - nx * t, y, z - nz * t]; };
  const inHole = (s, y) => holes.find((o) => s > o.s0 + 1e-4 && s < o.s1 - 1e-4 && y > o.y0 + 1e-4 && y < o.y1 - 1e-4);
  const NI = S_.length, NJ = Y_.length;   // rows 0..NJ-1, then the parapet row (index NJ) = top
  // THE OUTER WALL: an indexed grid round the perimeter (closed), the openings left out.
  const wallY = (i, j) => (j < NJ ? Y_[j] : top[i % NI]);
  const outerG = grid(NI, NJ, (i, j) => outer(S_[i], wallY(i, j)), (i, j) => {
    const s = (S_[i] + (S_[(i + 1) % NI] + (i + 1 === NI ? L : 0))) / 2, y = (wallY(i, j) + wallY(i, j + 1)) / 2;
    return !inHole(s, y);
  }, true);
  // THE CAP (the parapet's top, outer to inner) and THE PARAPET'S INNER FACE down to the roof.
  const cap = [], innerFace = [];
  for (let i = 0; i < NI; i++) {
    const i2 = (i + 1) % NI, sa = S_[i], sb = i2 ? S_[i2] : L, [, , nx, nz] = base((sa + sb) / 2);
    cap.push({ q: [outer(sa, top[i]), inner(sa, top[i] - 0.03), inner(sb, top[i2] - 0.03), outer(sb, top[i2])], dir: [0, 1, 0] });
    innerFace.push({ q: [inner(sa, top[i] - 0.03), inner(sa, roofY - 0.05), inner(sb, roofY - 0.05), inner(sb, top[i2] - 0.03)], dir: [-nx, 0, -nz] });
  }
  // THE OPENINGS' REVEALS (the wall's depth round a door or a window; a lintel's hole is filled).
  const reveal = [], planks = [], dark = [];
  for (const o of holes) {
    if (o.kind === "lintel") continue;
    const cols = S_.filter((s) => s >= o.s0 - 1e-4 && s <= o.s1 + 1e-4), rows = Y_.filter((y) => y >= o.y0 - 1e-4 && y <= o.y1 + 1e-4);
    // (the openings are on the front: the reveal's sides look along ±x into the hole, the sill up)
    for (let k = 0; k < rows.length - 1; k++) {
      reveal.push({ q: [outer(o.s0, rows[k]), inner(o.s0, rows[k]), inner(o.s0, rows[k + 1]), outer(o.s0, rows[k + 1])], dir: [1, 0, 0] });
      reveal.push({ q: [outer(o.s1, rows[k]), inner(o.s1, rows[k]), inner(o.s1, rows[k + 1]), outer(o.s1, rows[k + 1])], dir: [-1, 0, 0] });
    }
    if (o.y0 > 0.01) for (let k = 0; k < cols.length - 1; k++) {
      reveal.push({ q: [outer(cols[k], o.y0), inner(cols[k], o.y0), inner(cols[k + 1], o.y0), outer(cols[k + 1], o.y0)], dir: [0, 1, 0] });   // the sill
    }
    // What fills it, set back ~55% of the wall: the plank door, or a window's dark.
    const [x0] = base(o.s0), [x1] = base(o.s1), zb = -d / 2 + t * 0.55;
    const q = { q: [[x0, o.y0, zb], [x1, o.y0, zb], [x1, o.y1, zb], [x0, o.y1, zb]], dir: [0, 0, -1] };
    (o.kind === "door" ? planks : dark).push(q);
  }
  // THE LINTELS: a squared beam through the wall's thickness over each opening, a little bigger than
  // its hole (no crack at its edges) and proud of the face (never flush with it: no z-fight).
  const timberG = [];
  for (const o of holes.filter((q) => q.kind === "lintel")) {
    const [xa] = base(o.s0), [xb] = base(o.s1);
    timberG.push(new THREE.BoxGeometry(xb - xa + 0.06, o.y1 - o.y0 + 0.05, t + 0.16).translate((xa + xb) / 2, (o.y0 + o.y1) / 2 + 0.01, -d / 2 + t / 2 - 0.1));
  }
  // THE BEAMS of the roof: across the house (front to back), their ends out through both walls.
  for (let x = -w / 2 + r + 0.6; x < w / 2 - r - 0.3; x += 0.95 + noise2(x, 1, seed) * 0.15) {
    const g = new THREE.CylinderGeometry(0.11, 0.12, d + 0.44, 8).rotateX(Math.PI / 2).translate(x, h - 0.16, noise2(x, 2, seed) * 0.08);
    g.rotateY(noise2(x, 3, seed) * 0.03);
    timberG.push(g);
  }
  // THE ROOF: an earth terrace inside the parapet, sagging between the walls, a rise in the middle.
  const rx = w / 2 - t + 0.05, rz = d / 2 - t + 0.05, ni = Math.ceil((2 * rx) / 0.45), nj = Math.ceil((2 * rz) / 0.45);
  const roofG = grid(ni, nj, (i, j) => {
    const x = -rx + (2 * rx * i) / ni, z = -rz + (2 * rz * j) / nj;
    const edge = Math.min(1, Math.min(rx - Math.abs(x), rz - Math.abs(z)) / 1.2);
    return [x, roofY + edge * 0.12 + noise2(x * 0.7, z * 0.7, seed + 3) * 0.05 * edge, z];
  });
  // Two drain spouts out of the front parapet (a hollow log each).
  for (const sx of [-w * 0.28, w * 0.31]) timberG.push(new THREE.CylinderGeometry(0.07, 0.08, 0.9, 7).rotateX(Math.PI / 2 - 0.15).translate(sx, roofY + 0.1, -d / 2 - 0.15));
  // MERGE per surface.
  const stoneG = mergeGeometries([strip(outerG), strip(quads(cap)), strip(quads(innerFace)), strip(quads(reveal))]);
  const meshes = [
    [stoneG, "stone"], [strip(roofG), "earth"], [mergeGeometries(timberG.map(strip)), "timber"],
    [planks.length ? strip(quads(planks)) : null, "planks"], [dark.length ? strip(quads(dark)) : null, "dark"],
  ];
  const group = new THREE.Group();
  group.name = "StoneHouse";
  for (const [g, kind] of meshes) {
    if (!g) continue;
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, kind === "dark" ? darkMaterial() : surfaceMaterial(kind));
    m.name = `StoneHouse:${kind}`;
    m.castShadow = kind !== "dark";
    m.receiveShadow = true;
    group.add(m);
  }
  const tris = meshes.reduce((n, [g]) => n + (g ? (g.index ? g.index.count : g.attributes.position.count) / 3 : 0), 0);
  return { group, tris, footprint: { cx: 0, cz: 0, hx: w / 2, hz: d / 2 }, door: [door.x, -d / 2 - 1.2] };
}
