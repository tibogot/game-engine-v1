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
  earth: { url: GROUND, id: "mud_cracked_dry_03", tile: 1.5, tint: [0.6, 0.52, 0.42], sat: 0.7, rough: 1, foot: 0 },
  timber: { url: BUILD, id: "bark_willow_02", tile: 1.4, tint: [0.55, 0.46, 0.38], sat: 0.6, rough: 0.9, foot: 0 },
  planks: { url: BUILD, id: "raw_plank_wall", tile: 1.9, tint: [0.68, 0.58, 0.48], sat: 0.55, rough: 0.85, foot: 0 },
  reed: { url: BUILD, id: "reed_roof_04", tile: 2.0, tint: [0.48, 0.4, 0.29], sat: 0.6, rough: 1, foot: 0 },
  // (a pit's spoil, a berm: the gravelly dug earth)
  spoil: { url: GROUND, id: "brown_mud_dry", tile: 2.4, tint: [0.82, 0.7, 0.55], sat: 0.75, rough: 1, foot: 0 },
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
  if (kind === "stone") {
    const wear = attribute("wear", "vec2");
    const PD = photo(BUILD("clay_plaster", "diff"), true), pp = positionGeometry.div(1.8);
    const pl = texture(PD, vec2(pp.z, pp.y)).rgb.mul(wx).add(texture(PD, vec2(pp.x, pp.z)).rgb.mul(wy)).add(texture(PD, vec2(pp.x, pp.y)).rgb.mul(wz)).div(sum);
    const lum = dot(pl, vec3(0.2126, 0.7152, 0.0722));
    const plaster = mix(vec3(lum), pl, float(0.55)).mul(vec3(1.16, 0.98, 0.76));
    const mask = smoothstep(0.36, 0.47, wear.x.add(lum.sub(0.42).mul(0.9)));   // (the wear averages ~0.25: a quarter of the walls plastered)
    // Its LIP: a coat has a thickness — a little darker where it ends on the stone.
    const lip = mask.mul(float(1).sub(mask)).mul(4);
    col = mix(col, plaster, mask).mul(float(1).sub(lip.mul(0.28))).mul(float(1).sub(wear.y.mul(0.55)));
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
/** Only position, normal (and the stone's `wear`), indexed: what mergeGeometries needs alike. */
const strip = (g) => {
  for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal" && k !== "wear") g.deleteAttribute(k);
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
function stoneBlock({ cx = 0, cz = 0, w, d, h, t = 0.62, r = 0.5, seed = 1, door = null, windows = [], spouts = [] }) {
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
  for (let s = 0; s < L; s += 0.28) sCols.add(+s.toFixed(4));
  for (const o of holes) { sCols.add(+o.s0.toFixed(4)); sCols.add(+o.s1.toFixed(4)); }
  const S_ = [...sCols].sort((a, b) => a - b);
  const yRows = new Set([-0.3]);
  for (let y = 0; y < h; y += 0.32) yRows.add(+y.toFixed(4));
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
  const wearAt = (x, y, z) => {
    let p = noise2(x * 0.32 + z * 0.29, y * 0.42, seed + 11) * 0.5 + 0.5;
    p *= 1 - Math.min(1, Math.max(0, (y - h * 0.55) / (h * 0.5)));
    if (doorX != null && Math.abs(x - doorX) < 1.6 && z < front + 0.4 && y < 2.8) p += 0.45 * (1 - Math.abs(x - doorX) / 1.6);
    let g = 0;
    if (z < front + 0.35) for (const sx of spouts) g += Math.exp(-(((x - cx - sx) / 0.32) ** 2)) * Math.min(1, Math.max(0, (roofY - y) / 0.4)) * Math.max(0, 1 - (roofY - y) / 3.2);
    return [Math.min(1, p), Math.min(1, g)];
  };
  const stone = [strip(outerG), strip(quads(cap)), strip(quads(innerFace)), strip(quads(reveal)), ...stoneExtra.map(strip)];
  for (const g of stone) {
    const p = g.attributes.position, wear = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { const [a, b] = wearAt(p.getX(i), p.getY(i), p.getZ(i)); wear[i * 2] = a; wear[i * 2 + 1] = b; }
    g.setAttribute("wear", new THREE.BufferAttribute(wear, 2));
  }
  return {
    stone, earth: [strip(roof)], timber: timber.map(strip),
    planks: planks.length ? [strip(quads(planks))] : [], dark: dark.length ? [strip(quads(dark))] : [],
    roofY, top: h + 0.42, front,
  };
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
export const newSite = () => ({ stone: [], earth: [], spoil: [], timber: [], planks: [], reed: [], hessian: [], metal: [], dark: [] });
let _metal = null;
const metalMaterial = () => (_metal ??= new THREE.MeshStandardNodeMaterial({ color: 0x2b2a27, roughness: 0.55, metalness: 0.55, name: "Masonry:metal" }));
/** The site's meshes: one per surface (the materials shared by every site). */
export function siteGroup(site, name = "Site") {
  const group = new THREE.Group();
  group.name = name;
  let tris = 0;
  for (const [kind, list] of Object.entries(site)) {
    if (!list.length) continue;
    const g = mergeGeometries(list.map(strip));
    if (!g) { console.warn(`[masonry] ${name}:${kind} did not merge`); continue; }
    g.computeBoundingSphere();
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    const m = new THREE.Mesh(g, kind === "dark" ? darkMaterial() : kind === "metal" ? metalMaterial() : surfaceMaterial(kind));
    m.name = `${name}:${kind}`;
    m.castShadow = kind !== "dark";
    m.receiveShadow = true;
    group.add(m);
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
