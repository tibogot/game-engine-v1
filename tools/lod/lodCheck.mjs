/**
 * THE LOD CHECK — a far level must look like its near where the game switches (2026-10-31, you: "SOLID with no problems
 * at all"). Every <name> / <name>_Far pair of a GLB rendered in software, textured and lit, from the RTS camera: at the
 * switch distance, its pitch, from 8 directions round the piece, at the game's resolution. A pixel counts as DIFFERENT
 * only if no pixel within 1 px of it in the other image is close in colour (the far's budget is one pixel of shape:
 * a silhouette moved by 1 px is the promise kept, not a fault). The share of the piece's pixels that differ is printed;
 * past `--bar` (%) the check FAILS. A diff image per failing pair (the near | the far | the difference) is written.
 *
 *   node tools/lod/lodCheck.mjs <file.glb> [--switch 60] [--scale 1.3] [--px 1440] [--fov 26] [--pitch 43] [--bar 1]
 *        [--out <dir>] [--only <substring>]
 *
 * The texture is the material's base colour (bilinear, mip 0 — at the switch the game magnifies a house's atlas), lit
 * by one sun and a sky term with the level's own NORMALS (a far shading unlike its near is caught here too).
 */
import fs from "node:fs";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import sharp from "sharp";

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const num = (k, d) => Number(arg(k, d));
const O = { switchAt: num("--switch", 60), scale: num("--scale", 1.3), px: num("--px", 1440), fov: num("--fov", 26), pitch: num("--pitch", 43), bar: num("--bar", 1), tol: num("--tol", 48) };
const OUT = arg("--out", null), ONLY = arg("--only", null);

// ── small maths ──
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const xf = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const xn = (m, n) => norm([m[0] * n[0] + m[4] * n[1] + m[8] * n[2], m[1] * n[0] + m[5] * n[1] + m[9] * n[2], m[2] * n[0] + m[6] * n[1] + m[10] * n[2]]);

/** A piece's triangles in world space: { P: Float32Array xyz, N, UV, tex } per primitive. */
async function trianglesOf(node, texCache) {
  const m = node.getWorldMatrix(), out = [];
  for (const prim of node.getMesh().listPrimitives()) {
    const pos = prim.getAttribute("POSITION"), nor = prim.getAttribute("NORMAL"), uv = prim.getAttribute("TEXCOORD_0");
    const idx = prim.getIndices()?.getArray() ?? Uint32Array.from({ length: pos.getCount() }, (_, i) => i);
    const n = pos.getCount(), P = new Float32Array(n * 3), N = new Float32Array(n * 3), U = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      P.set(xf(m, pos.getElement(i, [])), i * 3);
      N.set(nor ? xn(m, nor.getElement(i, [])) : [0, 1, 0], i * 3);
      if (uv) U.set(uv.getElement(i, []), i * 2);
    }
    const mat = prim.getMaterial(), t = mat?.getBaseColorTexture();
    let tex = null;
    if (t) {
      if (!texCache.has(t)) {
        const { data, info } = await sharp(Buffer.from(t.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        texCache.set(t, { data, w: info.width, h: info.height });
      }
      tex = texCache.get(t);
    }
    const f = mat?.getBaseColorFactor() ?? [1, 1, 1, 1];
    out.push({ P, N, U, idx, tex, f });
  }
  return out;
}

/** Bilinear texture sample (sRGB bytes → 0..255 floats), repeat wrap, V flipped as glTF. */
function sample(tex, u, v, o) {
  const x = (u - Math.floor(u)) * tex.w - 0.5, y = (v - Math.floor(v)) * tex.h - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const at = (xi, yi) => (((yi % tex.h) + tex.h) % tex.h * tex.w + ((xi % tex.w) + tex.w) % tex.w) * 4;
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1), D = tex.data;
  for (let k = 0; k < 3; k++) o[k] = (D[a + k] * (1 - fx) + D[b + k] * fx) * (1 - fy) + (D[c + k] * (1 - fx) + D[d + k] * fx) * fy;
  return o;
}

/** Renders `tris` from the camera { eye, fwd, right, up, f (px focal) } into a W×H RGB + coverage image. */
function render(tris, cam, W, H, cx, cy) {
  const img = new Float32Array(W * H * 3), zb = new Float32Array(W * H).fill(Infinity), cov = new Uint8Array(W * H);
  const L = norm([-0.45, 0.8, -0.35]), col = [0, 0, 0];
  const proj = (p) => { const d = sub(p, cam.eye), z = dot(d, cam.fwd); return [cx + (dot(d, cam.right) * cam.f) / z, cy - (dot(d, cam.up) * cam.f) / z, z]; };
  for (const pr of tris) {
    const { P, N, U, idx, tex, f } = pr, n = P.length / 3, S = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) S.set(proj([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]), i * 3);
    for (let t = 0; t < idx.length; t += 3) {
      const ia = idx[t], ib = idx[t + 1], ic = idx[t + 2];
      const ax = S[ia * 3], ay = S[ia * 3 + 1], az = S[ia * 3 + 2], bx = S[ib * 3], by = S[ib * 3 + 1], bz = S[ib * 3 + 2], qx = S[ic * 3], qy = S[ic * 3 + 1], qz = S[ic * 3 + 2];
      if (az <= 0.1 || bz <= 0.1 || qz <= 0.1) continue;
      const area = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax); if (Math.abs(area) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, qx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, qx)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, qy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, qy)));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        let w0 = ((bx - px) * (qy - py) - (by - py) * (qx - px)) / area, w1 = ((qx - px) * (ay - py) - (qy - py) * (ax - px)) / area, w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        // perspective-correct weights
        const iz = w0 / az + w1 / bz + w2 / qz, z = 1 / iz, k = y * W + x;
        if (z >= zb[k]) continue;
        zb[k] = z; cov[k] = 1;
        const p0 = w0 / az / iz, p1 = w1 / bz / iz, p2 = w2 / qz / iz;
        const nx = N[ia * 3] * p0 + N[ib * 3] * p1 + N[ic * 3] * p2, ny = N[ia * 3 + 1] * p0 + N[ib * 3 + 1] * p1 + N[ic * 3 + 1] * p2, nz = N[ia * 3 + 2] * p0 + N[ib * 3 + 2] * p1 + N[ic * 3 + 2] * p2;
        const nl = Math.hypot(nx, ny, nz) || 1, lit = 0.35 + 0.65 * Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / nl);
        if (tex) sample(tex, U[ia * 2] * p0 + U[ib * 2] * p1 + U[ic * 2] * p2, U[ia * 2 + 1] * p0 + U[ib * 2 + 1] * p1 + U[ic * 2 + 1] * p2, col);
        else { col[0] = col[1] = col[2] = 200; }
        img[k * 3] = col[0] * f[0] * lit; img[k * 3 + 1] = col[1] * f[1] * lit; img[k * 3 + 2] = col[2] * f[2] * lit;
      }
    }
  }
  return { img, cov };
}

/** Pixels of `a` with no close-coloured pixel within 1 px in `b` (both ways), over the pieces' pixels. */
function compare(A, B, W, H, tol) {
  let px = 0, bad = 0; const mask = new Uint8Array(W * H);
  const near = (I, J, k) => Math.abs(I.img[k * 3] - J.img[k * 3]) + Math.abs(I.img[k * 3 + 1] - J.img[k * 3 + 1]) + Math.abs(I.img[k * 3 + 2] - J.img[k * 3 + 2]);
  const matchIn = (I, J, x, y) => {
    const k = y * W + x;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const j = yy * W + xx;
      if (I.cov[k] !== J.cov[j]) continue;
      if (!I.cov[k]) return true;
      if (Math.abs(I.img[k * 3] - J.img[j * 3]) + Math.abs(I.img[k * 3 + 1] - J.img[j * 3 + 1]) + Math.abs(I.img[k * 3 + 2] - J.img[j * 3 + 2]) < tol) return true;
    }
    return false;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x; if (!A.cov[k] && !B.cov[k]) continue;
    px++;
    if (!matchIn(A, B, x, y) || !matchIn(B, A, x, y)) { bad++; mask[k] = 1; }
  }
  return { px, bad, mask };
}

async function diffImage(file, A, B, mask, W, H) {
  const out = Buffer.alloc(W * 3 * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x;
    for (const [s, I] of [[0, A], [1, B]]) { const o = (y * W * 3 + s * W + x) * 3; for (let c = 0; c < 3; c++) out[o + c] = I.cov[k] ? Math.min(255, I.img[k * 3 + c]) : 30; }
    const o = (y * W * 3 + 2 * W + x) * 3; out[o] = mask[k] ? 255 : A.cov[k] ? 60 : 20; out[o + 1] = mask[k] ? 40 : A.cov[k] ? 60 : 20; out[o + 2] = mask[k] ? 40 : A.cov[k] ? 60 : 20;
  }
  await sharp(out, { raw: { width: W * 3, height: H, channels: 3 } }).png().toFile(file);
}

/** Checks every near/far pair of a GLB. Returns [{ name, worst %, views }]. */
export async function lodCheck(file, o = O) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(file), nodes = doc.getRoot().listNodes(), byName = new Map(nodes.map((n) => [n.getName(), n]));
  const texCache = new Map(), res = [];
  const fpx = o.px / 2 / Math.tan((o.fov * Math.PI) / 360);   // focal length in pixels at the game's resolution
  const d = o.switchAt / o.scale, pitch = (o.pitch * Math.PI) / 180;
  for (const nd of nodes) {
    const far = byName.get(`${nd.getName()}_Far`);
    if (!nd.getMesh() || !far || (ONLY && !nd.getName().includes(ONLY))) continue;
    const A = await trianglesOf(nd, texCache), B = await trianglesOf(far, texCache);
    // the piece's centre and size (its near)
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (const pr of A) for (let i = 0; i < pr.P.length; i += 3) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], pr.P[i + c]); mx[c] = Math.max(mx[c], pr.P[i + c]); }
    const ctr = mn.map((v, c) => (v + mx[c]) / 2), R = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2;
    const S = Math.ceil((2 * R * fpx) / d) + 8, W = S, H = S;   // (the piece's size on screen, at the switch)
    let worst = 0, views = [];
    for (let v = 0; v < 8; v++) {
      const yaw = (v / 8) * Math.PI * 2;
      const back = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
      const eye = [ctr[0] + back[0] * d, ctr[1] + back[1] * d, ctr[2] + back[2] * d];
      const fwd = norm(sub(ctr, eye)), right = norm(cross(fwd, [0, 1, 0])), up = cross(right, fwd);
      const cam = { eye, fwd, right, up, f: fpx };
      const ra = render(A, cam, W, H, W / 2, H / 2), rb = render(B, cam, W, H, W / 2, H / 2);
      const c = compare(ra, rb, W, H, o.tol), pct = c.px ? (100 * c.bad) / c.px : 0;
      views.push(+pct.toFixed(2));
      if (pct > worst) { worst = pct; if (OUT && pct > o.bar) { fs.mkdirSync(OUT, { recursive: true }); await diffImage(path.join(OUT, `${nd.getName()}_v${v}.png`), ra, rb, c.mask, W, H); } }
    }
    res.push({ name: nd.getName(), worst: +worst.toFixed(2), views, size: S });
  }
  return res;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("tools/lod/lodCheck.mjs")) {
  const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  if (!file) { console.log("usage: node tools/lod/lodCheck.mjs <file.glb> [--switch 60] [--scale 1.3] [--px 1440] [--fov 26] [--pitch 43] [--bar 1] [--out dir]"); process.exit(1); }
  let fail = 0;
  for (const r of await lodCheck(file)) {
    const bad = r.worst > O.bar; if (bad) fail++;
    console.log(`LODCHECK ${bad ? "FAIL" : "ok  "} ${r.name}  worst ${r.worst} % of its pixels differ  [${r.views.join(" ")}]  (${r.size} px)`);
  }
  console.log(fail ? `LODCHECK ${fail} pair(s) over ${O.bar} %` : "LODCHECK all pairs pass");
  process.exit(fail ? 1 : 0);
}
