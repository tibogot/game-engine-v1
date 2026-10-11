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
import { abs, attribute, dot, float, mix, normalGeometry, positionGeometry, pow, smoothstep, texture, transformNormalToView, uniform, vec2, vec3 } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { grainSack as grainSackGeo } from "../../v3/render/objects/rtsAlgeria.js";
import { buildDechra } from "../../v3/render/objects/rtsAlgVillage.js";

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
  // (warmed to the sandstone's colour: the Aurès build with the rock they stand on)
  stone: { url: BUILD, id: "rabdentse_ruins_wall", tile: 2.2, tint: [3.0, 2.15, 1.42], sat: 0.55, rough: 0.95, foot: 0.32 },
  // (the roofs: PACKED CLAY, beaten smooth and cracked dry — the gravelly mud read as a stony path)
  earth: { url: GROUND, id: "mud_cracked_dry_03", tile: 1.5, tint: [0.52, 0.45, 0.36], sat: 0.7, rough: 1, foot: 0 },
  timber: { url: BUILD, id: "bark_willow_02", tile: 1.4, tint: [0.55, 0.46, 0.38], sat: 0.6, rough: 0.9, foot: 0 },
  // (darker: in a shadowed wall the pale planks caught the sky and glowed blue, like panes)
  planks: { url: BUILD, id: "raw_plank_wall", tile: 1.9, tint: [0.4, 0.33, 0.26], sat: 0.55, rough: 0.97, foot: 0 },
  reed: { url: BUILD, id: "reed_roof_04", tile: 1.0, tint: [0.36, 0.3, 0.21], sat: 0.6, rough: 1, foot: 0 },
  // (a pit's spoil, a berm: the gravelly dug earth)
  spoil: { url: GROUND, id: "brown_mud_dry", tile: 2.4, tint: [0.82, 0.7, 0.55], sat: 0.75, rough: 1, foot: 0 },
  // (whitewash: the mosque, the koubba — the clay plaster lifted to an old white)
  lime: { url: BUILD, id: "clay_plaster", tile: 2.0, tint: [1.75, 1.68, 1.5], sat: 0.15, rough: 0.95, foot: 0.3 },
  hessian: { url: BUILD, id: "hessian_230", tile: 0.55, tint: [0.7, 0.58, 0.42], sat: 0.6, rough: 1, foot: 0 },
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
  let nObj = wX.mul(wx).add(wY.mul(wy)).add(wZ.mul(wz)).normalize();
  // THE STONE'S WEAR (its geometry's `wear`: x = the mud plaster left on it, y = grime): the plaster
  // photo where it survives — its edge broken by the plaster's own grain, not a stencil — smoother
  // there (it fills the joints); the drains' streaks darker.
  if (kind === "earth") col = col.mul(float(1).sub(attribute("wear", "vec2").x.mul(0.38)));
  if (kind === "stone") {
    const wear = attribute("wear", "vec2");
    const PD = photo(BUILD("clay_plaster", "diff"), true), pp = positionGeometry.div(1.8);
    const pl = texture(PD, vec2(pp.z, pp.y)).rgb.mul(wx).add(texture(PD, vec2(pp.x, pp.z)).rgb.mul(wy)).add(texture(PD, vec2(pp.x, pp.y)).rgb.mul(wz)).div(sum);
    const lum = dot(pl, vec3(0.2126, 0.7152, 0.0722));
    const plaster = mix(vec3(lum), pl, float(0.55)).mul(vec3(1.16, 0.98, 0.76));
    const mask = smoothstep(0.36, 0.47, wear.x.add(lum.sub(0.42).mul(0.9)));   // (the wear averages ~0.25: a quarter of the walls plastered)
    // Its LIP: a coat has a thickness — a little darker where it ends on the stone.
    const lip = mask.mul(float(1).sub(mask)).mul(4);
    col = mix(col, plaster, mask).mul(float(1).sub(lip.mul(0.28))).mul(float(1).sub(wear.y.max(0).mul(0.55)));
    // The limewash (wear.y < 0): white over the stone, the stones' relief still under it, its edge
    // broken by the plaster's grain.
    const limeMask = smoothstep(0.35, 0.6, wear.y.negate().add(lum.sub(0.45).mul(0.5)));
    // (an old wash, warm: a clean white caught the sky in a shadowed wall and read as glass)
    col = mix(col, vec3(0.62, 0.55, 0.44).mul(lum.mul(0.5).add(0.75)), limeMask);
    // The plaster's own relief (its photo's normal map), not the stones' under it.
    const PN = photo(BUILD("clay_plaster", "nor_gl")), uPX = vec2(pp.z, pp.y), uPY = vec2(pp.x, pp.z), uPZ = vec2(pp.x, pp.y);
    const tp = (uv) => texture(PN, uv).xyz.mul(2).sub(1);
    const qX = tp(uPX), qY = tp(uPY), qZ = tp(uPZ);
    const pX = vec3(qX.xy.add(vec2(n.z, n.y)), abs(qX.z).mul(n.x)).zyx;
    const pY = vec3(qY.xy.add(vec2(n.x, n.z)), abs(qY.z).mul(n.y)).xzy;
    const pZ = vec3(qZ.xy.add(vec2(n.x, n.y)), abs(qZ.z).mul(n.z));
    const plasterN = pX.mul(wx).add(pY.mul(wy)).add(pZ.mul(wz)).normalize();
    nObj = mix(nObj, plasterN, mask).normalize();
  }
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: s.rough, metalness: 0 });
  mat.name = `Masonry:${kind}`;
  mat.colorNode = col;
  mat.normalNode = transformNormalToView(nObj).normalize();
  _mats.set(kind, mat);
  return mat;
}
let _dark = null;
// (an opening's inside: a dim room, lit a little — pure black read as a hole cut in the picture)
const darkMaterial = () => (_dark ??= new THREE.MeshStandardNodeMaterial({ color: 0x1d150e, roughness: 1, metalness: 0, name: "Masonry:dark" }));

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
/** Only position, normal (and the stone's `wear`), indexed: what mergeGeometries needs alike. */
const strip = (g) => {
  for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal" && k !== "wear" && k !== "color") g.deleteAttribute(k);
  if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
  return g;
};

// ── A STONE BLOCK: one rounded-rectangle room, its walls, its roof, its openings ─────────────────
/**
 * World metres (the game's scale); (cx, cz) its centre; its front looks down −Z. `door` / `windows`:
 * x along the front (from the block's centre). `spouts`: x of the roof's drain logs on the front.
 * Returns geometries per surface ({ stone, earth, timber, planks, dark }) and its stone's WEAR
 * sources (where the plaster survives, where the drains streak it) — read per vertex below.
 */
function stoneBlock({ cx = 0, cz = 0, w, d, h, t = 0.62, r = 0.5, seed = 1, door = null, windows = [], spouts = [], lime = false }) {
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
    for (const g of segs) { if (s <= g.len) { const [x, z, nx, nz] = g.f(s); return [x + cx, z + cz, nx, nz]; } s -= g.len; }
    return segs[0].f(0);
  };
  const frontS = (x) => x + w / 2 - r;
  const holes = [];
  const addHole = (x, ww, y0, hh, kind) => {
    holes.push({ s0: frontS(x - ww / 2), s1: frontS(x + ww / 2), y0, y1: y0 + hh, kind, x });
    holes.push({ s0: frontS(x - ww / 2 - 0.28), s1: frontS(x + ww / 2 + 0.28), y0: y0 + hh, y1: y0 + hh + 0.2, kind: "lintel" });
  };
  if (door) addHole(door.x, door.w, 0, door.h, "door");
  for (const wn of windows) addHole(wn.x, wn.w, wn.y, wn.h, "window");
  const sCols = new Set();
  // COLUMNS (2026-10-11, the optimisation pass: 0.28 m everywhere was 62k triangles a hamlet for a
  // bulge that is gentle): ~0.7 m along the straight runs, 4 steps round each corner's arc.
  { let s0 = 0;
    for (const g of segs) {
      const n = g.len === arc ? 4 : Math.max(1, Math.round(g.len / 0.7));
      for (let k = 0; k < n; k++) sCols.add(+(s0 + (g.len * k) / n).toFixed(4));
      s0 += g.len;
    } }
  for (const o of holes) { sCols.add(+o.s0.toFixed(4)); sCols.add(+o.s1.toFixed(4)); }
  const S_ = [...sCols].sort((a, b) => a - b);
  const yRows = new Set([-0.3]);
  for (let y = 0; y < h; y += 0.6) yRows.add(+y.toFixed(4));   // (0.32 before the pass)
  for (const o of holes) { yRows.add(+o.y0.toFixed(4)); yRows.add(+o.y1.toFixed(4)); }
  yRows.add(h);
  const Y_ = [...yRows].sort((a, b) => a - b);
  const top = S_.map((s) => h + 0.42 + noise2(s * 0.9, 3.1, seed) * 0.13 + noise2(s * 3.1, 7.7, seed) * 0.05);
  const roofY = h + 0.06;
  const bulge = (s, y) => noise2(s * 1.6, y * 2.1, seed) * 0.035 + noise2(s * 0.45, y * 0.6, seed + 7) * 0.06 - Math.max(0, y) / h * 0.07;
  const outer = (s, y) => { const [x, z, nx, nz] = base(s), b = bulge(s, y); return [x + nx * b, y, z + nz * b]; };
  const inner = (s, y) => { const [x, z, nx, nz] = base(s); return [x - nx * t, y, z - nz * t]; };
  const inHole = (s, y) => holes.find((o) => s > o.s0 + 1e-4 && s < o.s1 - 1e-4 && y > o.y0 + 1e-4 && y < o.y1 - 1e-4);
  const NI = S_.length, NJ = Y_.length;
  const wallY = (i, j) => (j < NJ ? Y_[j] : top[i % NI]);
  const outerG = grid(NI, NJ, (i, j) => outer(S_[i], wallY(i, j)), (i, j) => {
    const s = (S_[i] + (S_[(i + 1) % NI] + (i + 1 === NI ? L : 0))) / 2, y = (wallY(i, j) + wallY(i, j + 1)) / 2;
    return !inHole(s, y);
  }, true);
  const cap = [], innerFace = [];
  for (let i = 0; i < NI; i++) {
    const i2 = (i + 1) % NI, sa = S_[i], sb = i2 ? S_[i2] : L, [, , nx, nz] = base((sa + sb) / 2);
    cap.push({ q: [outer(sa, top[i]), inner(sa, top[i] - 0.03), inner(sb, top[i2] - 0.03), outer(sb, top[i2])], dir: [0, 1, 0] });
    innerFace.push({ q: [inner(sa, top[i] - 0.03), inner(sa, roofY - 0.05), inner(sb, roofY - 0.05), inner(sb, top[i2] - 0.03)], dir: [-nx, 0, -nz] });
  }
  const reveal = [], planks = [], dark = [], timber = [], stoneExtra = [];
  const front = cz - d / 2;
  for (const o of holes) {
    if (o.kind === "lintel") continue;
    const cols = S_.filter((s) => s >= o.s0 - 1e-4 && s <= o.s1 + 1e-4), rows = Y_.filter((y) => y >= o.y0 - 1e-4 && y <= o.y1 + 1e-4);
    for (let k = 0; k < rows.length - 1; k++) {
      reveal.push({ q: [outer(o.s0, rows[k]), inner(o.s0, rows[k]), inner(o.s0, rows[k + 1]), outer(o.s0, rows[k + 1])], dir: [1, 0, 0] });
      reveal.push({ q: [outer(o.s1, rows[k]), inner(o.s1, rows[k]), inner(o.s1, rows[k + 1]), outer(o.s1, rows[k + 1])], dir: [-1, 0, 0] });
    }
    if (o.y0 > 0.01) for (let k = 0; k < cols.length - 1; k++) {
      reveal.push({ q: [outer(cols[k], o.y0), inner(cols[k], o.y0), inner(cols[k + 1], o.y0), outer(cols[k + 1], o.y0)], dir: [0, 1, 0] });
    }
    const [x0] = base(o.s0), [x1] = base(o.s1), zb = front + t * 0.55;
    (o.kind === "door" ? planks : dark).push({ q: [[x0, o.y0, zb], [x1, o.y0, zb], [x1, o.y1, zb], [x0, o.y1, zb]], dir: [0, 0, -1] });
    if (o.kind === "door") {
      // A flat stone for a step, and the door's frame posts in the reveal.
      stoneExtra.push(new THREE.BoxGeometry(x1 - x0 + 0.7, 0.16, 0.75).translate((x0 + x1) / 2, 0.03, front - 0.32).rotateY(0));
      for (const x of [x0 + 0.06, x1 - 0.06]) timber.push(new THREE.BoxGeometry(0.12, o.y1 - o.y0, 0.14).translate(x, (o.y0 + o.y1) / 2, zb - 0.09));
    }
  }
  for (const o of holes.filter((q) => q.kind === "lintel")) {
    const [xa] = base(o.s0), [xb] = base(o.s1);
    timber.push(new THREE.BoxGeometry(xb - xa + 0.06, o.y1 - o.y0 + 0.05, t + 0.16).translate((xa + xb) / 2, (o.y0 + o.y1) / 2 + 0.01, front + t / 2 - 0.1));
  }
  for (let x = -w / 2 + r + 0.6; x < w / 2 - r - 0.3; x += 0.95 + noise2(x, 1, seed) * 0.15) {
    timber.push(new THREE.CylinderGeometry(0.11, 0.12, d + 0.44, 8).rotateX(Math.PI / 2).rotateY(noise2(x, 3, seed) * 0.03).translate(cx + x, h - 0.16, cz + noise2(x, 2, seed) * 0.08));
  }
  const rx = w / 2 - t + 0.05, rz = d / 2 - t + 0.05, ni = Math.ceil((2 * rx) / 0.45), nj = Math.ceil((2 * rz) / 0.45);
  const roof = grid(ni, nj, (i, j) => {
    const x = -rx + (2 * rx * i) / ni, z = -rz + (2 * rz * j) / nj;
    const edge = Math.min(1, Math.min(rx - Math.abs(x), rz - Math.abs(z)) / 1.2);
    return [cx + x, roofY + edge * 0.12 + noise2(x * 0.7, z * 0.7, seed + 3) * 0.05 * edge, cz + z];
  });
  for (const sx of spouts) timber.push(new THREE.CylinderGeometry(0.07, 0.08, 0.9, 7).rotateX(Math.PI / 2 - 0.15).translate(cx + sx, roofY + 0.1, front - 0.15));
  // THE WEAR on the stone (per vertex: x = plaster left on it, y = grime): plaster in PATCHES —
  // low on the walls and round the door, where people pass and the render was renewed — and a dark
  // STREAK under each drain, down the front.
  const doorX = door ? cx + door.x : null;
  const wearAt = (x, y, z, noLime = false) => {
    let p = noise2(x * 0.32 + z * 0.29, y * 0.42, seed + 11) * 0.5 + 0.5;
    p *= 1 - Math.min(1, Math.max(0, (y - h * 0.55) / (h * 0.5)));
    if (doorX != null && Math.abs(x - doorX) < 1.6 && z < front + 0.4 && y < 2.8) p += 0.45 * (1 - Math.abs(x - doorX) / 1.6);
    let g = 0;
    if (z < front + 0.35) for (const sx of spouts) g += Math.exp(-(((x - cx - sx) / 0.32) ** 2)) * Math.min(1, Math.max(0, (roofY - y) / 0.4)) * Math.max(0, 1 - (roofY - y) / 3.2);
    // THE LIMEWASHED DOORWAY (the Chaouia houses' one bright thing, seen from afar): a white
    // surround round the door, ragged at its edge (the noise), on the front only. wear.y < 0.
    if (lime && !noLime && doorX != null && z < front + 0.12) {   // (the outer face only: on the door's reveals it read as a pale pane)
      const ex = Math.abs(x - doorX) - (door.w / 2 + 0.62), ey = y - (door.h + 0.62);
      const edge = Math.max(ex, ey) + noise2(x * 2.7, y * 2.7, seed + 31) * 0.12;
      if (edge < 0) return [Math.min(1, p) * 0.3, -Math.min(1, -edge * 6)];
    }
    return [Math.min(1, p), Math.min(1, g)];
  };
  const stone = [strip(outerG), strip(quads(cap)), strip(quads(innerFace)), strip(quads(reveal)), ...stoneExtra.map(strip)];
  // (The limewash on the OUTER WALL only — stone[0]: on a reveal it read as a pale pane.)
  stone.forEach((g, gi) => {
    const p = g.attributes.position, wear = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { const [a, b] = wearAt(p.getX(i), p.getY(i), p.getZ(i), gi !== 0); wear[i * 2] = a; wear[i * 2 + 1] = b; }
    g.setAttribute("wear", new THREE.BufferAttribute(wear, 2));
  });
  return {
    stone, earth: [withStains(strip(roof), seed)], timber: timber.map(strip),
    planks: planks.length ? [strip(quads(planks))] : [], dark: dark.length ? [strip(quads(dark))] : [],
    roofY, top: h + 0.42, front,
  };
}

/** The earth's wear (x: a stain — older, darker clay — in patches; y: unused): every earth geometry has it. */
function withStains(g, seed) {
  const p = g.attributes.position, wear = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const v = noise2(p.getX(i) * 0.45, p.getZ(i) * 0.45, seed + 21) * 0.5 + 0.5, v2 = noise2(p.getX(i) * 1.6, p.getZ(i) * 1.6, seed + 22) * 0.5 + 0.5;
    wear[i * 2] = Math.min(1, Math.max(0, v * 1.4 - 0.45) + Math.max(0, v2 - 0.75));
  }
  g.setAttribute("wear", new THREE.BufferAttribute(wear, 2));
  return g;
}

/** Pieces of timber: a LADDER leaning from (x, z0) on the ground to the wall at z1, its top at y1. */
function ladder(x, z0, z1, y1) {
  const out = [], len = Math.hypot(y1, z1 - z0), tilt = Math.atan2(z1 - z0, y1);
  for (const dx of [-0.24, 0.24]) out.push(new THREE.CylinderGeometry(0.045, 0.05, len + 0.5, 6).rotateX(tilt).translate(x + dx, (y1 + 0.5) / 2, (z0 + z1) / 2));
  for (let k = 0.35; k < y1; k += 0.42) {
    const f = k / y1;
    out.push(new THREE.CylinderGeometry(0.03, 0.03, 0.52, 5).rotateZ(Math.PI / 2).translate(x, k, z0 + (z1 - z0) * f));
  }
  return out;
}
/** A FIREWOOD stack: logs laid in a pile at (x, y, z), along `yaw`. */
function firewood(x, y, z, yaw, seed) {
  const out = [];
  for (let k = 0; k < 11; k++) {
    const row = k < 5 ? 0 : k < 9 ? 1 : 2, i = k - [0, 5, 9][row], n = [5, 4, 2][row];
    const lx = (i - (n - 1) / 2) * 0.2 + row * 0.02, ly = 0.09 + row * 0.16;
    const g = new THREE.CylinderGeometry(0.08, 0.09, 1.1 + noise2(k, 9, seed) * 0.2, 6).rotateX(Math.PI / 2).translate(lx, ly, 0).rotateY(yaw).translate(x, y, z);
    out.push(g);
  }
  return out;
}

// ── A SITE: pieces add geometry per surface; the site merges it (one mesh per surface) ──────────
export const newSite = () => ({ stone: [], lime: [], earth: [], spoil: [], timber: [], planks: [], reed: [], hessian: [], metal: [], cloth: [], dark: [] });
let _cloth = null;
/** Cloth (laundry, rugs): its colour per vertex — white, indigo, madder red, ochre. */
const clothMaterial = () => (_cloth ??= new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, name: "Masonry:cloth" }));
const CLOTH = [[0.82, 0.8, 0.74], [0.2, 0.24, 0.42], [0.55, 0.16, 0.12], [0.7, 0.52, 0.22], [0.78, 0.74, 0.62]];
/** A cloth (thin box) of one colour. */
function cloth(w, h, d, col) {
  const g = new THREE.BoxGeometry(w, h, d);
  const n = g.attributes.position.count, c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set(col, i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  return g;
}
let _metal = null;
const metalMaterial = () => (_metal ??= new THREE.MeshStandardNodeMaterial({ color: 0x2b2a27, roughness: 0.55, metalness: 0.55, name: "Masonry:metal" }));
/** The site's meshes: one per surface (the materials shared by every site). */
// THE DETAIL LEVEL (2026-10-11, the optimisation pass, you: "be very careful they are perfectly
// optimized — maybe LOD"): the SMALL things — sacks, jars, laundry, metal — in a THREE.LOD that
// shows them only within DETAIL_FAR of the camera, and never in the sun's shadow pass (the LOD picks
// its level per camera: the shadow camera is far, so they never cast — a sack's shadow is noise).
// The buildings (stone, earth, timber, planks) stay at every distance: from the RTS camera a house is
// always on screen as a house.
export const DETAIL_FAR = 70;
const DETAIL = new Set(["hessian", "cloth", "metal", "spoil"]);
export function siteGroup(site, name = "Site") {
  const group = new THREE.Group();
  group.name = name;
  const detail = new THREE.Group();
  detail.name = `${name}:detail`;
  let tris = 0;
  for (const [kind, list] of Object.entries(site)) {
    if (!list.length) continue;
    const g = mergeGeometries(list.map(strip));
    if (!g) { console.warn(`[masonry] ${name}:${kind} did not merge`); continue; }
    g.computeBoundingSphere();
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    const m = new THREE.Mesh(g, kind === "dark" ? darkMaterial() : kind === "metal" ? metalMaterial() : kind === "cloth" ? clothMaterial() : surfaceMaterial(kind));
    m.name = `${name}:${kind}`;
    m.castShadow = kind !== "dark";
    m.receiveShadow = true;
    (DETAIL.has(kind) ? detail : group).add(m);
  }
  if (detail.children.length) {
    const lod = new THREE.LOD();
    lod.name = `${name}:lod`;
    lod.addLevel(detail, 0);
    lod.addLevel(new THREE.Object3D(), DETAIL_FAR);
    group.add(lod);
  }
  return { group, tris };
}
export { ladder, firewood, stoneBlock };

// ── THE STONE HOUSE (the camp's PC): a main room and a lower annex ──────────────────────────────
/**
 * A dry-stone house of the Aurès with earth terrace roofs: the main room and a lower annex beside it,
 * set back (world metres, the game's scale). (ox, oz): the main room's centre; the front (the doors)
 * looks down −Z. Added to `site`; returns where its main room stands and its door.
 */
export function addStoneHouse(site, { ox = 0, oz = 0, seed = 1, doorX = -1.3, windows = [doorX - 3.0, doorX + 3.7] } = {}) {
  const add = (b) => { for (const k of Object.keys(b)) if (Array.isArray(b[k]) && site[k]) site[k].push(...b[k]); return b; };
  const main = add(stoneBlock({
    cx: ox, cz: oz, w: 11.7, d: 7.8, h: 3.5, seed,
    door: { x: doorX, w: 1.15, h: 2.2 }, windows: windows.map((x) => ({ x, w: 0.62, y: 1.45, h: 0.58 })), spouts: [-3.1, 4.2],
  }));
  const annex = add(stoneBlock({
    cx: ox + 7.9, cz: oz + 1.5, w: 5.4, d: 5.6, h: 2.6, r: 0.45, seed: seed + 5,
    door: { x: 0.3, w: 1.0, h: 1.9 }, windows: [], spouts: [-1.4],
  }));
  site.timber.push(...ladder(ox + 9.6, annex.front - 1.1, annex.front - 0.12, annex.top + 0.35));
  site.timber.push(...firewood(ox - 3.6, main.roofY + 0.08, oz + 2.0, 0.15, seed));
  site.timber.push(...firewood(ox + 9.0, annex.roofY + 0.06, oz + 2.6, 1.4, seed + 1));
  return { main: { x: ox, z: oz, w: 11.7, d: 7.8 }, annex: { x: ox + 7.9, z: oz + 1.5, w: 5.4, d: 5.6 }, door: [ox + doorX, main.front - 1.2], roofY: main.roofY };
}

/** The house alone (the lab's piece). */
export function buildStoneHouse({ seed = 1 } = {}) {
  const site = newSite();
  addStoneHouse(site, { seed });
  const { group, tris } = siteGroup(site, "StoneHouse");
  return { group, tris, footprint: { cx: 2.3, cz: 0.5, hx: 8.6, hz: 4.2 } };
}

// ── THE MECHTA, NEW STANDARD (2026-10-11, you: "let's start the mechta in the lab") ──────────────
// The Chaouia house of the Aurès hamlets (rtsMechta.js's, the kit's), rebuilt from the same pieces
// as the PC: dry-stone walls with their wear, a packed-clay terrace inside a broken parapet, beam ends
// under it, a low door in a timber frame, small openings high up; some with an UPPER ROOM open on a
// loggia (Ghoufi), some with a LEAN-TO of reed on poles behind low dry walls; firewood on a roof.

/** A small seeded stream (the house's own: the village's layout never shifts). */
function stream(seed) { let s = (seed * 9301 + 49297) >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

/** Move every geometry of a local site into `site`, turned by `yaw` about Y and set at (x, y, z). */
function placeInto(site, local, x, z, yaw, y = 0) {
  const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z);
  for (const [k, list] of Object.entries(local)) for (const g of list) { g.applyMatrix4(m); site[k].push(g); }
}
/** Push a stoneBlock's surfaces into a local site, lifted by `y`. */
function addBlock(local, b, y = 0) {
  for (const k of Object.keys(local)) if (Array.isArray(b[k])) for (const g of b[k]) { if (y) g.translate(0, y, 0); local[k].push(g); }
  return b;
}

/**
 * A DRY-STONE WALL from a to b (x/z, metres), `h` high, 0.55 thick: a box cut into a grid, every
 * vertex pushed by a noise of its own position (shared corners move together), the top wandering,
 * leaning in as it rises — on the stone surface (its wear: none).
 */
export function dryWall(a, b, h = 1.4, seed = 1, t = 0.55) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const g = new THREE.BoxGeometry(len, h, t, Math.max(2, Math.round(len / 0.9)), 2, 1)   // (the pass: was every 0.45 m by 0.35 m);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), f = (y + h / 2) / h;
    const top = y > h / 2 - 1e-4 ? noise2(x * 0.7, 3.3, seed) * 0.12 : 0;
    p.setXYZ(i, x + noise2(y * 2, z * 3 + 5, seed) * 0.03, y + top, z * (1 - 0.18 * f) + noise2(x * 1.7, y * 2.1, seed) * 0.05);
  }
  g.translate(0, h / 2 - 0.08, 0);
  g.rotateY(-Math.atan2(b[1] - a[1], b[0] - a[0]));
  g.translate((a[0] + b[0]) / 2, 0, (a[1] + b[1]) / 2);
  g.computeVertexNormals();
  const s = strip(g);
  s.setAttribute("wear", new THREE.BufferAttribute(new Float32Array(s.attributes.position.count * 2), 2));
  return s;
}

/** THE TABOUNA: a domed clay oven, its dark mouth, a flat stone before it. */
export function addOven(site, x, z, yaw) {
  const dome = new THREE.SphereGeometry(0.78, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.scale(1, 0.92, 1).rotateY(yaw).translate(x, -0.05, z);
  site.spoil.push(dome);
  site.dark.push(new THREE.PlaneGeometry(0.38, 0.32).translate(0, 0.2, 0.765).rotateY(yaw).translate(x, 0, z));
}

/**
 * ONE VILLAGE HOUSE into `site`. (x, z): its centre; `yaw` turns it (its door looks down its local
 * −Z); w × d × h its walls (world metres). Returns its door (world) and walls' box for a garrison.
 */
export function addMechtaHouse(site, { x = 0, z = 0, yaw = 0, w = 7.5, d = 5.6, h = 3.4, storey2 = false, leanTo = null, seed = 1 } = {}) {
  const R = stream(seed);
  const local = newSite();
  const dx = (R() - 0.5) * (w - 2.4);
  const winX = dx > 0 ? -w * 0.3 : w * 0.3;
  const low = addBlock(local, stoneBlock({
    w, d, h, t: 0.5, r: 0.38, seed,
    door: { x: dx, w: 0.95, h: 1.85 }, windows: R() < 0.8 ? [{ x: winX, w: 0.44, y: h - 0.95, h: 0.36 }] : [],
    spouts: R() < 0.7 ? [dx > 0 ? -w * 0.32 : w * 0.34] : [], lime: R() < 0.7,
  }));
  // LIFE ON THE ROOF (the kit's houses had it, and it read): sacks, jars, a laundry line, a rug
  // over the parapet. The upper room's side is kept clear.
  {
    const ry = low.roofY + 0.05, rw = w / 2 - 0.9, rd = d / 2 - 0.8;
    const at = () => [(R() - 0.5) * 2 * rw * (storey2 ? 0.5 : 1) + (storey2 ? -Math.sign(dx || 1) * rw * 0.4 : 0), (R() - 0.5) * 2 * rd];
    if (R() < 0.6) { const [ax, az] = at(); for (let k = 0; k < 2 + Math.floor(R() * 2); k++) local.hessian.push(grainSackGeo(0.7, 0.36, 0.48, seed + k).rotateY(R() * 3).translate(ax + k * 0.55, ry, az + (R() - 0.5) * 0.4)); }
    if (R() < 0.6) { const [ax, az] = at(); for (let k = 0; k < 1 + Math.floor(R() * 3); k++) local.spoil.push(new THREE.SphereGeometry(0.24, 10, 7).scale(1, 1.3, 1).translate(ax + k * 0.45, ry + 0.28, az)); }
    if (R() < 0.55) {
      const [ax, az] = at(), len = 2.2 + R() * 1.2, yy = ry + 1.35;
      for (const e of [-len / 2, len / 2]) local.timber.push(new THREE.CylinderGeometry(0.035, 0.04, 1.4, 5).translate(ax + e, ry + 0.7, az));
      // The line itself (cloth hung on nothing read as floating panes from above), and the cloths
      // the dyed colours — white sheets glared as glass at the RTS camera.
      local.timber.push(new THREE.CylinderGeometry(0.012, 0.012, len, 4).rotateZ(Math.PI / 2).translate(ax, yy, az));
      for (let k = 0; k < 3; k++) local.cloth.push(cloth(0.36 + R() * 0.2, 0.42 + R() * 0.2, 0.02, CLOTH[1 + Math.floor(R() * 3)]).translate(ax - len / 2 + 0.4 + k * (len - 0.8) / 2, yy - 0.26, az));
    }
    // (No rug over the parapet: its broken top left a draped box floating or sunk — seen close.)
  }
  // THE UPPER ROOM: set back on part of the roof, open to the front on a loggia (a wide opening,
  // its dark room behind), its own roof and beams.
  if (storey2) {
    const w2 = Math.max(3.4, w * 0.58), d2 = d * 0.78, h2 = 2.4, ox = ((w - w2) / 2 - 0.15) * (R() < 0.5 ? -1 : 1);
    const up = addBlock(local, stoneBlock({
      cx: ox, cz: d * 0.08, w: w2, d: d2, h: h2, t: 0.42, r: 0.28, seed: seed + 3,
      windows: [{ x: 0, w: w2 - 1.3, y: 0.35, h: h2 - 0.85 }], spouts: [],
    }), low.roofY - 0.02);
    // The loggia's POSTS and their beam, in the opening's depth (Ghoufi: the upper room on posts).
    const y0 = low.roofY - 0.02 + 0.35, hh = h2 - 0.85, zf = up.front + 0.16, half = (w2 - 1.3) / 2;
    const np = Math.max(2, Math.round((w2 - 1.3) / 1.1));
    for (let k = 1; k < np; k++) local.timber.push(new THREE.CylinderGeometry(0.08, 0.09, hh, 7).translate(ox - half + (k * 2 * half) / np, y0 + hh / 2, zf));
    local.timber.push(new THREE.BoxGeometry(2 * half + 0.2, 0.16, 0.18).translate(ox, y0 + hh - 0.08, zf));
  }
  // THE LEAN-TO at one end: low dry walls, two poles, a reed roof sloping off the house.
  const lt = leanTo ?? R() < 0.45;
  let lean = null;
  if (lt) {
    const lw = 2.6 + R() * 0.8, side = R() < 0.5 ? -1 : 1, ex = side * (w / 2 + lw / 2 - 0.1);
    lean = { ex, lw };
    local.stone.push(dryWall([ex - lw / 2, d / 2 - 0.3], [ex + lw / 2, d / 2 - 0.3], 1.25, seed + 11));
    local.stone.push(dryWall([ex + side * (lw / 2 - 0.25), d / 2 - 0.3], [ex + side * (lw / 2 - 0.25), -d / 2 + 0.6], 1.15, seed + 12));
    for (const pz of [-d / 2 + 0.55, d / 2 - 0.55]) local.timber.push(new THREE.CylinderGeometry(0.07, 0.09, 2.2, 7).translate(ex + side * (lw / 2 - 0.2), 1.1, pz));
    // Its roof: poles laid side by side across, sloping off the house (the reed photo read as boards).
    for (let zp = -d / 2 + 0.05; zp < d / 2; zp += 0.17) {
      local.timber.push(new THREE.CylinderGeometry(0.075, 0.08, lw + 0.5, 6).rotateZ(Math.PI / 2 + side * 0.2 + (R() - 0.5) * 0.04).translate(ex + side * 0.05, 2.18 + (R() - 0.5) * 0.04, zp));
    }
  }
  // What lies on a roof: firewood for the oven, now and then; a ladder up the front.
  if (R() < 0.5) local.timber.push(...firewood((R() - 0.5) * w * 0.4, low.roofY + 0.06, (R() - 0.5) * d * 0.3, R() * 3, seed));
  if (!storey2 && R() < 0.35) local.timber.push(...ladder(dx + (dx > 0 ? -1.4 : 1.4), low.front - 1.05, low.front - 0.1, low.top + 0.3));
  placeInto(site, local, x, z, yaw);
  const c = Math.cos(yaw), s = Math.sin(yaw), dz = -d / 2 - 1.2;
  return { x, z, yaw, w, d, lean, door: [x + dx * c + dz * s, z - dx * s + dz * c] };
}

/** One village house on its own (the buildings lab): a loggia and a lean-to. */
export function buildMechtaHouseV2({ seed = 7 } = {}) {
  const site = newSite();
  addMechtaHouse(site, { w: 8.3, d: 6.2, h: 3.6, storey2: true, leanTo: true, seed });
  const { group, tris } = siteGroup(site, "Mechta");
  return { group, tris };
}

// ── THE HAMLET, NEW STANDARD: rtsMechta buildMechta's arrangement on the new houses ─────────────
/**
 * A hamlet of `count` houses in attached rows either side of a lane (the lane along +Z through the
 * origin, the doors on it), yards walled in dry stone behind some, an oven in a few — the kit's
 * layout (rtsMechta.js) at the game's scale, every house addMechtaHouse. Returns the CARRIER the game
 * reads (geometry.userData: footprint, houses, navRects, coverLines) with the hamlet as its `extra`.
 */
export function buildMechtaV2({ seed = 1954, count = 10 } = {}) {
  const K = 1.3, R = stream(seed), site = newSite();
  const houses = [], nav = [], cover = [];
  const rectOf = (x, z, w, d, yaw, m = 1.15) => {
    const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
    return { cx: x, cz: z, hx: (c * w) / 2 + (s * d) / 2 + m, hz: (s * w) / 2 + (c * d) / 2 + m };
  };
  let zL = -count * 3.2 * K, zR = (-count * 3.2 + 2.5) * K;
  for (let i = 0; i < count; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const w = (4.5 + R() * 3.5) * K, d = (3.8 + R() * 1.8) * K, h = (2.5 + R() * 0.9) * K;
    const zc = (side < 0 ? zL : zR) + w / 2, xc = side * (2.6 * K + d / 2 + R() * 0.5 * K);
    const yaw = side * Math.PI / 2 + (R() - 0.5) * 0.06;
    const hh = addMechtaHouse(site, { x: xc, z: zc, yaw, w, d, h, storey2: R() < 0.35, seed: seed * 31 + i * 7 });
    houses.push(hh);
    const r = rectOf(xc, zc, w, d, yaw);
    nav.push(r);
    cover.push({ hard: true, pts: [[r.cx - r.hx + 1.15, r.cz - r.hz + 1.15], [r.cx + r.hx - 1.15, r.cz - r.hz + 1.15], [r.cx + r.hx - 1.15, r.cz + r.hz - 1.15], [r.cx - r.hx + 1.15, r.cz + r.hz - 1.15], [r.cx - r.hx + 1.15, r.cz - r.hz + 1.15]] });
    if (hh.lean) { const lx = xc + hh.lean.ex * Math.cos(yaw), lz = zc - hh.lean.ex * Math.sin(yaw); nav.push(rectOf(lx, lz, hh.lean.lw, d, yaw, 0.6)); }
    const gap = R() < 0.25 ? (1.8 + R()) * K : 0.05;
    if (side < 0) zL += w + gap; else zR += w + gap;
    // A YARD behind some: three dry-stone walls, an oven in half of them.
    if (R() < 0.6) {
      const back = side * (3.2 * K + d + 1.2), far = back + side * (5 + R() * 3) * K;
      const runs = [[[back, zc - w / 2], [far, zc - w / 2]], [[far, zc - w / 2], [far, zc + w / 2]], [[far, zc + w / 2], [back, zc + w / 2]]];
      runs.forEach(([a, b], k) => {
        site.stone.push(dryWall(a, b, 1.35 + R() * 0.3, seed + i * 5 + k));
        nav.push({ cx: (a[0] + b[0]) / 2, cz: (a[1] + b[1]) / 2, hx: Math.abs(b[0] - a[0]) / 2 + 1.2, hz: Math.abs(b[1] - a[1]) / 2 + 1.2 });
        cover.push({ hard: true, pts: [a, b] });
      });
      if (R() < 0.5) addOven(site, (back + far) / 2, zc + (R() - 0.5) * 2, R() * 6);
    }
  }
  const { group, tris } = siteGroup(site, "Hamlet");
  const bb = new THREE.Box3();
  group.traverse((o) => { if (o.isMesh) { o.geometry.computeBoundingBox(); bb.union(o.geometry.boundingBox); } });
  const carrier = new THREE.BufferGeometry();
  carrier.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  carrier.setIndex([0, 1, 2]);
  Object.assign(carrier.userData, {
    footprint: { cx: (bb.min.x + bb.max.x) / 2, cz: (bb.min.z + bb.max.z) / 2, hx: (bb.max.x - bb.min.x) / 2, hz: (bb.max.z - bb.min.z) / 2 },
    houses: houses.map((h) => ({ door: h.door, x: h.x, z: h.z, w: h.w, d: h.d, yaw: h.yaw })),
    navRects: nav, coverLines: cover, coverPerimeter: false, height: 6 * K, tris,
    extra: [group], labMaterial: new THREE.MeshBasicMaterial({ visible: false }),
  });
  return carrier;
}

// ── THE DECHRA, NEW STANDARD (2026-10-11): rtsAlgVillage buildDechra's village — its rows climbing
// the real slope, the lanes' stairs, the yards' places, the garrison's houses, the stork's nest — with
// its HOUSES, their SOCLES, its MOSQUE and its YARD WALLS drawn here (the kit's builder hands them:
// onHouse / onMosque / onYard, pre-scale). The kit geometry keeps the lane stairs and the yards' ovens
// and jars, and carries the village's data; the new houses are its `extra`.

/** A whitewashed block: a stoneBlock whose walls go to the LIME surface. */
function limeBlock(o) {
  const b = stoneBlock(o);
  b.lime = b.stone; b.stone = [];
  return b;
}
/** A socle (the terrace a house stands on): from below the ground to `top`, a little wider. */
function socle(cx, cz, w, d, low, top, seed) {
  const h = top - low + 0.5, g = new THREE.BoxGeometry(w, h, d, Math.max(1, Math.round(w / 0.9)), 1, Math.max(1, Math.round(d / 0.9)));
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) + noise2(p.getY(i) * 3, p.getZ(i) * 2, seed) * 0.04);
  g.translate(cx, top - h / 2, cz);
  g.computeVertexNormals();
  const s = strip(g);
  s.setAttribute("wear", new THREE.BufferAttribute(new Float32Array(s.attributes.position.count * 2), 2));
  return s;
}

export function buildDechraV2(o = {}) {
  const K = 1.3, site = newSite();
  const push = (b, y) => { for (const k of Object.keys(site)) if (Array.isArray(b[k])) for (const g of b[k]) { g.translate(0, y, 0); site[k].push(g); } };
  const onHouse = (hh) => {
    const x = hh.x * K, z = hh.z * K, y = hh.y * K, w = hh.w * K, d = hh.d * K, h = hh.h * K, s = 3100 + hh.seed * 13;
    const R = stream(s);
    const b = stoneBlock({ cx: x, cz: z, w, d, h, t: 0.5, r: 0.36, seed: s,
      door: { x: hh.doorX * K, w: 0.95, h: 1.85 }, windows: R() < 0.7 ? [{ x: (hh.doorX > 0 ? -w * 0.28 : w * 0.28), w: 0.44, y: h - 0.95, h: 0.36 }] : [],
      spouts: R() < 0.6 ? [hh.doorX > 0 ? -w * 0.3 : w * 0.32] : [], lime: R() < 0.55 });
    push(b, y);
    if (hh.storey2) {
      const w2 = Math.max(3.2, w * 0.58), ox = ((w - w2) / 2 - 0.15) * (R() < 0.5 ? -1 : 1);
      push(stoneBlock({ cx: x + ox, cz: z + d * 0.08, w: w2, d: d * 0.78, h: 2.3, t: 0.42, r: 0.28, seed: s + 3,
        windows: [{ x: 0, w: 0.5, y: 1.0, h: 0.42 }], door: null, spouts: [] }), y + b.roofY - 0.02);
    }
    if (R() < 0.45) site.timber.push(...firewood(x + (R() - 0.5) * w * 0.4, y + b.roofY + 0.06, z + (R() - 0.5) * d * 0.3, R() * 3, s));
    if (R() < 0.45) { for (let k = 0; k < 1 + Math.floor(R() * 3); k++) site.spoil.push(new THREE.SphereGeometry(0.24, 10, 7).scale(1, 1.3, 1).translate(x + (R() - 0.5) * w * 0.5 + k * 0.45, y + b.roofY + 0.33, z + (R() - 0.5) * d * 0.4)); }
    site.stone.push(socle(x, z, w + 0.4, d + 0.4, hh.low * K - 0.4, y + hh.lip * K * 0.5, s));
  };
  let mosque = null;
  const onMosque = (m) => { mosque = m; };
  const onYard = (pts) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = [pts[i][0] * K, pts[i][1] * K], b = [pts[i + 1][0] * K, pts[i + 1][1] * K];
      const gy = (o.groundAt ?? (() => 0))((pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2) * K;
      site.stone.push(dryWall(a, b, 1.3, 7700 + i + Math.round(a[0] * 10)).translate(0, gy, 0));
    }
  };
  const kit = buildDechra({ ...o, onHouse, onMosque, onYard });
  // THE MOSQUE: a whitewashed hall on its socle, its green door, the minaret with its gallery and
  // lantern, the stork's nest on top.
  if (mosque) {
    const m = mosque, x = m.x * K, z = m.z * K, y = m.y * K, w = m.w * K, d = m.d * K, h = m.h * K;
    const hall = limeBlock({ cx: x, cz: z, w, d, h, t: 0.55, r: 0.3, seed: 911, door: { x: -1.2 * K, w: 1.3, h: 2.5 },
      windows: [{ x: 1.2 * K, w: 0.55, y: 2.0, h: 0.9 }, { x: 2.9 * K, w: 0.55, y: 2.0, h: 0.9 }], spouts: [] });
    push(hall, y);
    site.stone.push(socle(x, z, w + 0.5, d + 0.5, m.low * K - 0.4, y + 0.3, 912));
    const mn = m.minaret, mx = mn.x * K, mz = mn.z * K, my = mn.y * K, MH = mn.h * K;
    const shaft = limeBlock({ cx: mx, cz: mz, w: 2.2 * K, d: 2.2 * K, h: MH, t: 0.45, r: 0.12, seed: 913,
      windows: [{ x: 0, w: 0.35, y: MH - 2.2, h: 0.9 }], door: null, spouts: [] });
    push(shaft, my);
    site.stone.push(socle(mx, mz, 2.2 * K + 0.5, 2.2 * K + 0.5, mn.low * K - 0.4, my + 0.4, 914));
    const lantern = limeBlock({ cx: mx, cz: mz, w: 1.25 * K, d: 1.25 * K, h: 1.5, t: 0.25, r: 0.08, seed: 915, windows: [], door: null, spouts: [] });
    push(lantern, my + shaft.roofY - 0.02);
    if (m.nest) {
      const nx = m.nest[0] * K - 0.22 * K, ny = my + shaft.roofY + lantern.roofY + 0.1, nz = m.nest[2] * K;
      site.timber.push(new THREE.CylinderGeometry(0.75, 0.6, 0.28, 10).translate(nx, ny, nz));
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        site.timber.push(new THREE.CylinderGeometry(0.025, 0.025, 1.0, 4).rotateZ(Math.PI / 2).rotateY(a + 0.9).translate(nx + Math.cos(a) * 0.6, ny + 0.12, nz + Math.sin(a) * 0.6));
      }
      kit.userData.nest = { x: nx, y: ny + 0.2, z: nz };
    }
  }
  const { group } = siteGroup(site, "Dechra");
  kit.userData.extra = [group];
  return kit;
}
