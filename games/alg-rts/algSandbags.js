// SANDBAGS, THE NEW STANDARD (2026-10-14, you: "the sandbags we used look so cheap — do you think you can
// do better?"). The kit's bag (v3/render/objects/rtsParts.js buildSandbag, shared with nam-rts and left
// as it is) was a smooth little box, the same one in a brick grid, in the kit's flat colour. What a real
// wall shows (assets-src/refs/sandbags/: Ypres, Da Nang, Kabul, a flood wall), and where it comes from:
//
//   the BAG       a filled pillow: flat where it lies, domed on top, its sides bulging under the bags
//                 above; the TIED end narrower and lower, its corners drawn out into "ears"; a seam along
//                 its side; lumpy (sand settles). 8 variants, ~220 triangles each
//   the LAYING    courses STAGGERED by half a bag, the bags pressed into each other (overlapping, a
//                 dark crease between courses), each turned, tilted and sized a little; the lower
//                 courses flatter (weight); stretcher courses two bags thick, header courses across;
//                 the tied ends both ways; the wall leaning in as it rises (batter)
//   the CLOTH     the burlap photo (hessian_230) with its normal map, in the piece's own space (no UVs);
//                 every bag its own shade — new pale jute, khaki, faded grey, a few olive — and its foot
//                 darker (sand-soaked, dusty)
//   the COST      a whole wall merged into ONE mesh, ONE material shared by every bag in the game
import { groundBlend } from "./algGroundBlend.js";
import * as THREE from "three";
import { abs, atan, attribute, clamp as tslClamp, cross, dot, exp, float, mix, mx_noise_float, normalGeometry, normalize, positionGeometry, positionLocal, positionView, pow, select, sin, smoothstep as tslSmoothstep, step as tslStep, texture, transformNormalToView, uniform, vec2, vec3 } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { simplifierReady, simplifyGeometry } from "../../v3/render/instancing/autoLod.js";

/** The bag (m: a filled French army jute bag ~ 62 × 34 × 17 cm). */
export const BAG = { L: 0.7, W: 0.42, H: 0.21 };
export const SANDBAG_LOOK = { tile: 0.42, normalStr: 0.9, foldStr: 1.0 };
/** The shader folds' strength over the simulated bags (they have real ones): 0.25. */

function stream(seed) { let s = (seed * 9301 + 49297) >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ── THE BAG ──────────────────────────────────────────────────────────────────────────────────────
/**
 * One bag: a FABRIC PILLOW (2026-10-14, you, a Fab asset: "they still look cheap — they should look
 * like a realistic pillow"). Not a rounded box: two cloth faces sewn along their edge — thick in the
 * middle, thinning to a crisp seam all round, the four corners pinched out into points; the TIED end
 * (+X) narrower, flatter, its ears longer; the top fuller than the underside (it lies flat); lumps.
 * Two grids (top, underside) meeting at the seam: 8 × 6 cells each, ~190 triangles. Local: length
 * along X, width along Z, the seam's plane at y = BAG.H * 0.3, the bottom near 0. `dirt`: its underside.
 */
function bagGeometry(seed) {
  const R = stream(seed);
  const NU = 8, NV = 6;
  const lumps = [0, 1, 2].map(() => [R() * 6.28, R() * 6.28, 1.5 + R() * 2.5, 0.06 + R() * 0.06]);
  const earL = 0.012 + R() * 0.018, earR = 0.012 + R() * 0.018, tie = 0.6 + R() * 0.2;   // (6-11 cm: spikes, fins)
  const pos = [], dirt = [], buv = [], idx = [];
  const H = BAG.H, seamY = H * 0.18;   // (0.3: the underside showed as a pale strip between courses)
  const vert = (u, v, top) => {
    // the footprint: a rectangle, its corners pinched OUT (the ears), the tied end (+u) narrower
    const t = Math.max(0, u);   // 0 .. 1 toward the tied end
    const halfW = (BAG.W / 2) * (1 - 0.28 * t * t);
    const corner = Math.abs(u) ** 8 * Math.abs(v) ** 8;
    const ear = corner * (u > 0 ? (v > 0 ? earL : earR) * 1.8 : 0.03);
    let x = u * (BAG.L / 2) + Math.sign(u) * ear;
    let z = v * halfW + Math.sign(v) * ear * 0.6;
    // the edges draw in a little between the corners (the cloth pulled by the fill)
    x *= 1 - 0.05 * (1 - v * v);
    z *= 1 - 0.07 * (1 - u * u);
    // the fill: thick in the middle, a crisp seam at the edge; the tied end flatter
    const fill = Math.max(0, (1 - u * u)) ** 0.33 * Math.max(0, (1 - v * v)) ** 0.42 * (1 - (1 - tie) * t * t);
    let lump = 0;
    for (const [a, b, f, k] of lumps) lump += Math.sin(u * f + a) * Math.sin(v * f * 1.4 + b) * k;
    const y = top ? seamY + (H - seamY) * fill * (1 + lump) : seamY - seamY * Math.min(1, fill * 1.6) * (1 + lump * 0.5);
    pos.push(x, Math.max(0, y), z);
    dirt.push(top ? (1 - fill) * 0.35 : 0.45);
    buv.push(u, v, 0, top ? 1 : 0);
  };
  for (const top of [true, false]) {
    const base = pos.length / 3;
    for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) vert(-1 + (2 * i) / NU, -1 + (2 * j) / NV, top);
    for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
      const a = base + j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1;
      if (top) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("dirt", new THREE.Float32BufferAttribute(dirt, 1));
  g.setAttribute("bagUV", new THREE.Float32BufferAttribute(buv, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
/**
 * THE CLOTH-SIMULATED BAGS (2026-10-14, you: "it looks very rigid — like a real cloth simulation pillow,
 * the kind of thing we do in Blender"): tools/blender/sandbagSim.py drops a pressure-filled cloth box
 * under gravity onto the ground (6 `ground` variants) or across two bags end to end (6 `valley`
 * variants: they drape into the joint) → public/models/alg/sandbags.glb, ~400 faces a bag, 121 KB.
 * Loaded ONCE (loadSandbags, at the boot / the lab); the procedural bag stays the fallback.
 * A valley bag's y = 0 is the top of the course it rests on (it hangs below, into the joint).
 */
let _sim = null, _simP = null;
export function loadSandbags() {
  return (_simP ??= import("three/addons/loaders/GLTFLoader.js").then(({ GLTFLoader }) => new GLTFLoader().loadAsync("/models/alg/sandbags.glb")).then((gltf) => {
    const ground = [], valley = [];
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", o.geometry.getAttribute("position").clone());
      g.setIndex(o.geometry.index.clone());
      g.computeVertexNormals();
      prepSim(g);
      (/valley/.test(o.name) ? valley : ground).push(g);
    });
    _sim = { ground, valley };
    return _sim;
  }).catch((e) => { console.warn("[sandbags] the simulated bags did not load — the procedural ones:", e); return null; }));
}
/** A simulated bag's per-vertex data, as the procedural one's: bagUV (u, v, seed, top) and its foot. */
function prepSim(g) {
  const P = g.getAttribute("position"), Nn = g.getAttribute("normal"), n = P.count;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { lo = Math.min(lo, P.getY(i)); hi = Math.max(hi, P.getY(i)); }
  const buv = new Float32Array(n * 4), dirt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const top = Nn.getY(i) > -0.25;
    buv.set([P.getX(i) / (BAG.L / 2), P.getZ(i) / (BAG.W / 2), 0, top ? 1 : 0], i * 4);
    dirt[i] = top ? 1 - smoothstep(lo + 0.02, lo + (hi - lo) * 0.6, P.getY(i)) : 0.45;
  }
  g.setAttribute("bagUV", new THREE.BufferAttribute(buv, 4));
  g.setAttribute("dirt", new THREE.BufferAttribute(dirt, 1));
}
let _bags = null;
const procedural = () => (_bags ??= Array.from({ length: 8 }, (_, k) => bagGeometry(101 + k * 37)));
/** A bag's shape: a simulated one if loaded (`valley` for a bag across a joint), else the procedural. */
const bags = (valley = false) => (_sim ? (valley && _sim.valley.length ? _sim.valley : _sim.ground) : procedural());

/** Every bag its own shade (× the photo): pale new jute, khaki, faded grey, darker, a few olive. */
const SHADES = [[1.0, 0.97, 0.9], [0.93, 0.86, 0.72], [0.82, 0.8, 0.74], [0.74, 0.68, 0.56], [1.05, 1.0, 0.92], [0.7, 0.72, 0.56], [0.88, 0.82, 0.7]];
const SHADE_W = [3, 4, 2, 2, 2, 1, 3];
function shade(R) {
  let u = R() * SHADE_W.reduce((a, b) => a + b, 0), k = 0;
  while ((u -= SHADE_W[k]) > 0) k++;
  const c = SHADES[k], v = 0.92 + R() * 0.16;
  return [c[0] * v, c[1] * v, c[2] * v];
}

/** A bag placed: a variant, turned (yaw about Y, then tilt), sized, its shade baked in a `tint` attribute. */
function placedBag(R, x, y, z, yaw, { squash = 1, flip = false, droop = 0, valley = false } = {}) {
  const list = bags(valley), g = list[Math.floor(R() * list.length)].clone();
  if (_sim) { squash = 1; droop *= 0.4; }   // (the simulated bags have their own weight and lean)
  g.setAttribute("bagUV", g.getAttribute("bagUV").clone());
  const s = 0.94 + R() * 0.12;
  g.scale(s * (0.97 + R() * 0.06), squash * (0.92 + R() * 0.14), s * (0.95 + R() * 0.1));
  if (flip) g.rotateY(Math.PI);
  // (droop: a bag on the edge of the course below tips over it — the front row to the front)
  g.rotateZ((R() - 0.5) * 0.12).rotateX(droop * (0.7 + R() * 0.6) + (R() - 0.5) * 0.1).rotateY(yaw + (R() - 0.5) * 0.16);
  g.translate(x + (R() - 0.5) * 0.03, y, z + (R() - 0.5) * 0.04);
  const c = shade(R), n = g.attributes.position.count, tint = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) tint.set(c, i * 3);
  g.setAttribute("tint", new THREE.BufferAttribute(tint, 3));
  // its folds' seed (the shader's creases differ bag to bag)
  const buv = g.getAttribute("bagUV"), sd = R();
  for (let i = 0; i < buv.count; i++) buv.setZ(i, sd);
  return g;
}

// ── THE WALL ─────────────────────────────────────────────────────────────────────────────────────
/**
 * A straight wall along X, centred, its FRONT (the enemy side) at −Z: `courses` courses, two bags thick
 * (stretchers) with a header course across every third; staggered; leaning in as it rises. Returns the
 * bags' geometries (to merge with others into one mesh).
 */
export function sandbagWallBags({ length = 5, courses = 5, seed = 3, batter = 0.035, thick = 2, x0 = 0, z0 = 0, yaw = 0 } = {}) {
  const R = stream(seed * 7 + 11);
  const out = [];
  const step = BAG.L * 0.9;   // pressed end to end
  let y = 0;
  for (let c = 0; c < courses; c++) {
    const header = c % 3 === 2 && thick > 1;
    const squash = 0.86 + 0.14 * (c / Math.max(1, courses - 1));   // the lower, the flatter
    const len = length - c * batter * 2 * 2.2;
    const lean = c * batter * 0.9;   // the face steps back as it rises (+Z)
    if (header) {
      // across the wall: bags side by side, their ends to the front and the back
      const stepH = BAG.W * 0.92, n = Math.max(1, Math.round(len / stepH));
      for (let i = 0; i < n; i++) {
        const x = -len / 2 + (i + 0.5) * (len / n);
        out.push(placedBag(R, x, y, BAG.W * 0.5 + lean, Math.PI / 2, { squash, flip: R() < 0.5 }));
      }
    } else {
      const n = Math.max(1, Math.round(len / step)), off = (c % 2) * step * 0.5;
      for (let row = 0; row < thick; row++) {
        for (let i = 0; i < n; i++) {
          let x = -len / 2 + (i + 0.5) * (len / n) + off * (row === 0 ? 1 : -1) * 0.6;
          if (Math.abs(x) > len / 2) continue;
          out.push(placedBag(R, x, y + (row ? 0.01 : 0), row * BAG.W * 0.92 + lean, 0, { squash, flip: R() < 0.5, droop: row === 0 ? -0.06 : thick > 1 ? 0.05 : 0, valley: c > 0 }));
        }
      }
    }
    // the next course rests on this one's tops (simulated: a settled bag is ~0.17 m, the one above
    // hangs into its joints from there; procedural: sunk into the course below)
    y += _sim ? (c === 0 ? 0.165 : 0.15) : BAG.H * squash * 0.74;
  }
  if (x0 || z0 || yaw) {
    const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(x0, 0, z0);
    for (const g of out) g.applyMatrix4(m);
  }
  return out;
}

// ── THE MATERIAL ─────────────────────────────────────────────────────────────────────────────────
let _mat = null;
// THE GROUND BLEND (2026-10-24, algGroundBlend): the game hands the app over before the first wall is built — the bags'
// lowest 30 cm in the ground's colour (the shared material rebuilt if one was made before)
let _gbApp = null;
export function setSandbagGroundBlend(app) { _gbApp = app; _mat = null; }
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
/** ONE material for every bag: the burlap photo in the piece's space (the face's dominant axis), its
 *  weave's gaps filled (sand behind the jute, not holes), × the bag's shade, its foot darker. */
export function sandbagMaterial(build = null) {
  if (_mat && !build) return _mat;
  const D = photo("/textures/build/hessian_230/hessian_230_diff_1k.jpg", true), N = photo("/textures/build/hessian_230/hessian_230_nor_gl_1k.jpg");
  const n = normalGeometry.normalize();
  const wx = pow(abs(n.x), float(4)), wy = pow(abs(n.y), float(4)), wz = pow(abs(n.z), float(4));
  const p = positionGeometry.div(SANDBAG_LOOK.tile);
  const isX = wx.greaterThan(wy).and(wx.greaterThan(wz)), isY = wy.greaterThan(wz);
  const uv = select(isX, vec2(p.z, p.y), select(isY, vec2(p.x, p.z), vec2(p.x, p.y)));
  let c = texture(D, uv).rgb;
  const lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // the weave's dark gaps half filled (sand behind the jute, not holes), the jute toward dusty khaki
  // (lifted to ~ sRGB 150-135-110: the first try, ×1.38 over a lifted grey, read WHITE at game zoom)
  c = mix(c, vec3(0.13, 0.11, 0.08), float(0.35));
  c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, float(0.9)).mul(vec3(1.2, 0.99, 0.72));   // warm burlap brown (the Fab reference); khaki-cream read cheap   // (×1.75 read cream-yellow beside the ground)
  c = c.mul(attribute("tint", "vec3"));
  c = mix(c, c.mul(vec3(0.42, 0.37, 0.31)), attribute("dirt", "float").mul(0.85));   // the foot: a dark crease under every bag
  const t1 = texture(N, uv).xyz.mul(2).sub(1).mul(vec3(SANDBAG_LOOK.normalStr, SANDBAG_LOOK.normalStr, 1));
  const nXs = vec3(t1.xy.add(vec2(n.z, n.y)), abs(t1.z).mul(n.x)).zyx;
  const nYs = vec3(t1.xy.add(vec2(n.x, n.z)), abs(t1.z).mul(n.y)).xzy;
  const nZs = vec3(t1.xy.add(vec2(n.x, n.y)), abs(t1.z).mul(n.z));
  const nn = select(isX, nXs, select(isY, nYs, nZs)).normalize();
  // THE FOLDS (2026-10-14, "still cheap — we can make far better"): what a real filled bag shows, as a
  // height in metres over the bag's own (u, v) — no triangles added: creases RADIATING from each
  // corner (the cloth pulled tight to its points), GATHERS across the tied end, soft wrinkles over the
  // top — turned into a normal from its screen derivatives (bump mapping).
  const bu = attribute("bagUV", "vec4"), u = bu.x, v = bu.y, sd = bu.z.mul(40.0);
  const corner = (su, sv) => {
    const d = vec2(float(su).sub(u), float(sv).sub(v)), r = d.length();
    return sin(atan(d.y, d.x).mul(9.0).add(sd).add(r.mul(4.0))).mul(exp(r.mul(-2.6))).mul(0.011);
  };
  const tied = tslSmoothstep(0.45, 1.0, u).mul(sin(v.mul(17.0).add(sd.mul(0.7)))).mul(0.008);
  const soft = mx_noise_float(vec3(u.mul(2.6), v.mul(3.4), sd)).mul(0.006);
  const foldK = float(_sim ? 0.25 : 1);
  const fold = corner(1, 1).add(corner(1, -1)).add(corner(-1, 1).mul(0.55)).add(corner(-1, -1).mul(0.55)).add(tied).add(soft).mul(bu.w)
    // (faded out at the seam: at the corners the creases' angle is undefined and the bump drew bright lines)
    .mul(tslSmoothstep(0.0, 0.18, float(1).sub(u.abs()))).mul(tslSmoothstep(0.0, 0.18, float(1).sub(v.abs())));
  const nView = transformNormalToView(nn).normalize();
  const sx = positionView.dFdx(), sy = positionView.dFdy();
  const r1 = cross(sy, nView), r2 = cross(nView, sx), det = dot(sx, r1);
  const grad = r1.mul(fold.dFdx()).add(r2.mul(fold.dFdy())).mul(det.sign());
  const bumped = normalize(nView.mul(det.abs()).sub(grad.mul(foldK.mul(SANDBAG_LOOK.foldStr))));
  // the wall's shade, and dust settled on what looks up (the top course most)
  c = c.mul(attribute("ao", "float"));
  const upW = tslSmoothstep(0.55, 0.9, normalGeometry.y).mul(bu.w);
  // (2026-10-17, you: "those white marks on their texture don't read nice" — the dust was a PALE grey sand,
  // lighter than the jute: blotchy white patches on every top. Now it is the ground's own dust, a touch
  // darker than the jute and warm, and half as strong: the tops dusty, not bleached.)
  const dust = upW.mul(tslSmoothstep(0.35, 0.75, mx_noise_float(positionGeometry.mul(2.2)).mul(0.5).add(0.5))).mul(0.22);
  c = mix(c, c.mul(vec3(0.86, 0.8, 0.72)), dust);
  // (Physical: its specular switched OFF on the undersides — their grazing sky reflection drew blue
  // lines between the courses)
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 1, metalness: 0 });
  m.name = "Sandbags";
  m.colorNode = c;
  if (_gbApp && !build) { m.userData.gbBase = c; m.colorNode = groundBlend(_gbApp, c, { fade: 0.3, tint: 0.25 }); }
  m.normalNode = bumped;
  m.roughnessNode = float(1.0);
  m.specularIntensityNode = bu.w.mul(0.6);
  if (build) {
    // A SITE's bags (algBuild): each hidden until its moment (`bagT` — bagOrder), then dropped into place over the
    // last 4 %; hidden ones sunk far below, the shadow pass too.
    const t = attribute("bagT", "float");
    const shown = tslStep(t, build);
    // (a short settle, 12 cm over 2 %: a 45 cm drop over 4 % left bags hanging in the air whenever the work paused —
    // the lab's slider, 2026-10-21)
    const k = tslClamp(build.sub(t).div(0.02), 0, 1);
    m.positionNode = positionLocal.add(vec3(0, float(1).sub(k).mul(float(1).sub(k)).mul(0.12).sub(float(1).sub(shown).mul(200)), 0));
    m.castShadowPositionNode = m.positionNode;
    m.name = "SandbagsSite";
    return m;
  }
  _mat = m;
  return m;
}

/** Bags' geometries → ONE mesh (casting and receiving shadows). */
export function sandbagMesh(list, name = "Sandbags") {
  const g = mergeGeometries(list.map((q) => { const o = new THREE.BufferGeometry(); for (const k of ["position", "normal", "tint", "dirt", "bagUV"]) o.setAttribute(k, q.getAttribute(k)); o.setIndex(q.index); return o; }));
  for (const q of list) q.dispose();
  // THE WALL'S SHADE (cheap AO): the bags low in the wall sit in the others' shadow, the gaps between
  // them dark — per vertex, from its height in the wall and whether it is an underside
  const P = g.getAttribute("position"), B = g.getAttribute("bagUV");
  let top = 0;
  for (let i = 0; i < P.count; i++) top = Math.max(top, P.getY(i));
  const ao = new Float32Array(P.count);
  for (let i = 0; i < P.count; i++) {
    const h = Math.min(1, P.getY(i) / Math.max(0.3, top * 0.92));
    ao[i] = (0.5 + 0.5 * h * h * (3 - 2 * h)) * (B.getW(i) > 0.5 ? 1 : 0.5)   // (the undersides SHOW where a bag tips forward: near black, the sky's light read them BLUE);
  }
  g.setAttribute("ao", new THREE.BufferAttribute(ao, 1));
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, sandbagMaterial());
  m.name = name;
  m.castShadow = m.receiveShadow = true;
  return m;
}

// ── THE WALL SIMULATED WHOLE (2026-10-14, you: "see the gap between the bags — compare to the Fab
// asset") ──────────────────────────────────────────────────────────────────────────────────────────
// tools/blender/sandbagWall.py drops every bag of the wall, one by one, onto the bags already laid:
// they rest on and press into each other (no gaps, no floating), each a flat sewn sack inflated into a
// pillow with pointed ears. One mesh, its bags' shades in COLOR_0. Loaded once; the wall builder uses
// it when present (else the bag-by-bag one above).
let _wallP = null;
/** The simulated pieces (tools/blender/sandbagWall.py layouts), each { near, far }: the wall, the
 *  breached wall, the MG nest's ring. */
const SIM = {};
const SIM_FILES = { wall: "sandbagWall", breach: "sandbagBreach", ring: "sandbagRing", fort: "sandbagFort", pit: "sandbagPit",
  chicane: "sandbagChicane", tower: "sandbagTower", lookout: "sandbagLookout", postpit: "sandbagPostPit",
  mirador: "sandbagMirador",   // (the Blender mirador's cabin parapet, 2026-10-21 — algSangar.js loadMirador)
  slshed: "sandbagSlShed",     // (the searchlight tower's generator shed — loadSearchlight)
  radio: "sandbagRadio",       // (the forward post's horseshoe — loadForwardPost)
  sas: "sandbagSas" };         // (the SAS post's sandbagged corner — loadSasPost)     // (the forward post's horseshoe — loadForwardPost)
/** A glb's one mesh → the bag material's attributes (shade from COLOR_0, foot, top/underside, the wall's shade). */
function prepWall(gltf) {
  let src = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { if (o.isMesh && !src) src = o; });
  const g = src.geometry.clone().applyMatrix4(src.matrixWorld);
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  const P = g.getAttribute("position"), Nn = g.getAttribute("normal"), C = g.getAttribute("color"), n = P.count;
  let top = 0;
  for (let i = 0; i < n; i++) top = Math.max(top, P.getY(i));
  const tint = new Float32Array(n * 3), dirt = new Float32Array(n), buv = new Float32Array(n * 4), ao = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (C) tint.set([C.getX(i), C.getY(i), C.getZ(i)], i * 3); else tint.set([0.9, 0.85, 0.75], i * 3);
    const up = Nn.getY(i) > -0.25;
    dirt[i] = up ? 0 : 0.45;
    buv.set([0, 0, 0, up ? 1 : 0], i * 4);
    const h = Math.min(1, P.getY(i) / Math.max(0.3, top * 0.92));
    ao[i] = (0.5 + 0.5 * h * h * (3 - 2 * h)) * (up ? 1 : 0.6);
  }
  for (const k of Object.keys(g.attributes)) if (!["position", "normal"].includes(k)) g.deleteAttribute(k);
  g.setAttribute("tint", new THREE.BufferAttribute(tint, 3));
  g.setAttribute("dirt", new THREE.BufferAttribute(dirt, 1));
  g.setAttribute("bagUV", new THREE.BufferAttribute(buv, 4));
  g.setAttribute("ao", new THREE.BufferAttribute(ao, 1));
  g.setAttribute("bagT", new THREE.BufferAttribute(bagOrder(g), 1));
  g.computeBoundingSphere();
  return g;
}
/**
 * EACH BAG'S MOMENT in the construction (2026-10-21 — the walls were stretched out of the ground): the merged wall's
 * bags are its separate islands (union-find over the triangles); laid course by course — by the bag's BOTTOM height,
 * then along the wall — each its 0..1 rank. One float a vertex (`bagT`); sandbagMaterial(build) reads it. (By its
 * CENTRE an upright end bag ranked with the top course, and a bag lying on it came before it: floating in the air
 * mid-build — you, in the lab, 2026-10-25. A bag rests on bags whose bottoms are lower.)
 */
function bagOrder(g) {
  const P = g.getAttribute("position"), n = P.count, idx = g.index?.array;
  const par = new Int32Array(n).map((_, i) => i);
  const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  if (idx) for (let t = 0; t < idx.length; t += 3) { const a = find(idx[t]); for (const v of [idx[t + 1], idx[t + 2]]) { const b = find(v); if (a !== b) par[b] = a; } }
  const sums = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let s = sums.get(r); if (!s) sums.set(r, (s = [0, 0, 0, 0, Infinity, -Infinity]));
    s[0] += P.getX(i); s[1] += P.getY(i); s[2] += P.getZ(i); s[3]++; s[4] = Math.min(s[4], P.getY(i)); s[5] = Math.max(s[5], P.getY(i));
  }
  const bags = [...sums.entries()].map(([r, s]) => ({ r, x: s[0] / s[3], y: s[4], top: s[5], z: s[2] / s[3], lv: 0 }));
  // (a bag's COURSE: one over the highest bag it rests on — lower bottom, its top reaching this one's bottom, the
  // two centres within a bag's length; bottom-up, so every support is ranked first)
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const b of bags) { x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x); z0 = Math.min(z0, b.z); z1 = Math.max(z1, b.z); }
  const alongX = x1 - x0 >= z1 - z0;
  bags.sort((a, b) => a.y - b.y);
  for (let i = 0; i < bags.length; i++) {
    const B = bags[i];
    for (let j = 0; j < i; j++) {
      const A = bags[j];
      if (A.y < B.y - 0.02 && A.top > B.y - 0.04 && Math.hypot(A.x - B.x, A.z - B.z) < 0.55) B.lv = Math.max(B.lv, A.lv + 1);
    }
  }
  bags.sort((a, b) => a.lv - b.lv || (alongX ? a.x - b.x : a.z - b.z));
  const rank = new Map(bags.map((b, k) => [b.r, bags.length > 1 ? k / (bags.length - 1) : 0]));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rank.get(find(i));
  return out;
}
/**
 * A CONSTRUCTION SITE's simulated bags (algBuild, the lab — 2026-10-21): every bag mesh under `mesh` (material
 * "Sandbags…") gets ONE site material (a uniform: bagT, laid course by course). The piece is NOT stretched (the
 * caller leaves its scale at 1): its earth and timbers stand from the start — dug and set first — the bags go on
 * them, and its other parts (the gun, a crew's things) come last. (Stretching the kit while keeping the bags whole left
 * the MG nest's roof bags and gun floating over a half-risen berm — you, 2026-10-21.) Null when it has none.
 *   set(progress): the bags in [0.1, 0.9] of the work, the rest at 0.94 · finish(): the shared material back
 */
export function siteBags(mesh) {
  const bagMeshes = [];
  // (either name: a copy made while another site held the cached bags carries their site material)
  mesh.traverse((o) => { if (o.isMesh && /^Sandbags/.test(o.material?.name ?? "")) bagMeshes.push(o); });
  if (!bagMeshes.length) return null;
  const u = uniform(0), mat = sandbagMaterial(u);
  for (const o of bagMeshes) o.material = mat;
  // the parts that come last: the piece's own children holding no bags (the gun…); inside a group that holds bags
  // (the mortar pit's), its non-bag children are its earth and crates — they stand from the start
  const holds = (o) => { let b = false; o.traverse((q) => { if (bagMeshes.includes(q)) b = true; }); return b; };
  const last = mesh.children.filter((c) => !holds(c) && c.userData.late == null);
  return {
    set(p) {
      // (to 1.02, not 1: the last bags' settle — 12 cm over 2 % of the work — done by 90 %; at 1 the top course hung
      // 12 cm over the wall in a finished lab piece, 2026-10-25)
      u.value = Math.min(1.02, Math.max(0, ((p - 0.1) / 0.8) * 1.02));
      for (const c of last) c.visible = p >= 0.94;
    },
    finish() {
      for (const o of bagMeshes) o.material = sandbagMaterial();
      for (const c of last) c.visible = true;
      mat.dispose();
    },
  };
}
/** Load the simulated wall, near and far (tools/blender/sandbagWall.py), once. Null if missing. */
export function loadSandbagWall() {
  return (_wallP ??= import("three/addons/loaders/GLTFLoader.js").then(async ({ GLTFLoader }) => {
    const ld = new GLTFLoader(), get = (u) => ld.loadAsync(u).catch(() => null);
    await Promise.all(Object.entries(SIM_FILES).map(async ([k, base]) => {
      const [near, far] = await Promise.all([get(`/models/alg/${base}.glb`), get(`/models/alg/${base}_far.glb`)]);
      if (near) SIM[k] = { near: prepWall(near), far: far ? prepWall(far) : null };
    }));
    return SIM.wall?.near ?? null;
  }).catch((e) => { console.warn("[sandbags] the simulated wall did not load:", e); return null; }));
}
/** The far version's distance (m from the camera): the RTS camera sits 50-130 m off the ground. */
export const WALL_FAR = 55;
/** The simulated wall as a mesh — an LOD (near / far) when the far version exists. Null if not loaded. */
export function simulatedWallMesh(name = "SandbagWall", kind = "wall") {
  const S = SIM[kind];
  if (!S) return null;
  const _wall = S.near, _wallFar = S.far;
  const mk = (g, n) => { const m = new THREE.Mesh(g, sandbagMaterial()); m.name = n; m.castShadow = m.receiveShadow = true; return m; };
  if (!_wallFar) return mk(_wall, name);
  const lod = new THREE.LOD();
  lod.name = name;
  lod.addLevel(mk(_wall, name + ":near"), 0);
  lod.addLevel(mk(_wallFar, name + ":far"), WALL_FAR);
  return lod;
}

/**
 * THE GAME'S PIECE (algBuild "sandbags", the showroom's walls): the kit wall's geometry kept for
 * what the game reads off it — its footprint, the nav, the placement ghost, the breach swap
 * (algDamage) — drawn by nothing itself (an invisible material), the simulated wall its `extra`.
 * The kit wall alone if the simulated one is not loaded.
 */
/** The MG nest (algBuild, showroom): the kit's berm, timbers, boxes and gun; its bags the simulated ring. */
export function buildMgNestPiece(kitNest) {
  const ring = simulatedWallMesh("SandbagRing", "ring");
  if (!ring) return kitNest({});
  const geo = kitNest({ noBags: true });
  // (simulated at the kit's true size — finish() scales every kit piece x1.3 — on its berm and timbers)
  geo.userData = { ...geo.userData, extra: [...(geo.userData.extra ?? []), ring] };
  return geo;
}

/** The fortified point (algBuild): the kit's ammunition box and jerrican; its three walls simulated. */
export function buildFortPointPiece(kitFort) {
  const walls = simulatedWallMesh("SandbagFort", "fort");
  if (!walls) return kitFort({});
  const geo = kitFort({ noBags: true });
  geo.userData = { ...geo.userData, extra: [...(geo.userData.extra ?? []), walls] };
  return geo;
}

/** The French post (showroom): its gate chicane, tower guns' rings, look-out and mortar ring simulated. */
export function buildFrenchPostPiece(kitPost) {
  if (!["chicane", "tower", "lookout", "postpit"].every((k) => SIM[k])) return kitPost({});
  const geo = kitPost({ noBags: true });
  const extra = (geo.userData.bagSlots ?? []).map((b, i) => {
    const m = simulatedWallMesh("PostBags" + i, b.kind);
    m.position.set(...b.pos);
    m.rotation.y = b.yaw;
    return m;
  });
  geo.userData = { ...geo.userData, extra: [...(geo.userData.extra ?? []), ...extra] };
  return geo;
}

/** The helipad (showroom, the buildings lab — 2026-10-19, you: "you are still using the old sandbags, I
 *  have way better ones"): its fuel point's and radio corner's walls laid from the cloth-simulated bags in
 *  the kit's slots (rtsAlgeria `bagSlots`, kit scale), all four ONE mesh. The kit's walls if not loaded. */
export function buildHelipadPiece(kitPad) {
  if (!_sim) return kitPad({});
  const geo = kitPad({ noBags: true });
  const list = [];
  for (const b of geo.userData.bagSlots ?? []) {
    const bags = sandbagWallBags({ length: b.length, courses: b.courses, thick: 2, seed: b.seed, x0: b.x, z0: b.z, yaw: b.yaw });
    for (const g of bags) g.translate(0, b.y, 0);
    list.push(...bags);
  }
  if (!list.length) return geo;
  // NEAR / FAR, as the simulated walls (WALL_FAR): ~35k triangles of bags were drawn whole from the RTS
  // camera (50-130 m out) and into the shadow map; past WALL_FAR a meshopt-simplified copy (~15 %) —
  // the shadow camera picks it too.
  const near = sandbagMesh(list, "HelipadBags");
  if (!_simplerOk) { geo.userData = { ...geo.userData, extra: [...(geo.userData.extra ?? []), near] }; return geo; }
  const far = new THREE.Mesh(simplifyGeometry(near.geometry, { ratio: 0.15, error: 0.03 }), near.material);
  far.name = "HelipadBagsFar";
  far.castShadow = far.receiveShadow = true;
  const lod = new THREE.LOD();
  lod.name = "HelipadBags";
  lod.addLevel(near, 0);
  lod.addLevel(far, WALL_FAR);
  geo.userData = { ...geo.userData, extra: [...(geo.userData.extra ?? []), lod] };
  return geo;
}
let _simplerOk = false;
simplifierReady.then(() => { _simplerOk = true; });

export function buildSandbagWallPiece(kitWall) {
  const geo = kitWall();
  const wall = simulatedWallMesh();
  if (!wall) return geo;
  geo.userData = { ...geo.userData, labMaterial: _hidden ??= new THREE.MeshBasicMaterial({ visible: false }), extra: [wall], simWall: true };
  return geo;
}
let _hidden = null;
