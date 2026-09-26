/**
 * PLAN VIEW of an Algeria map — a top-down image to design a layout on:
 * hillshade, ground past the 34° nav limit in red, water in blue, a 100 m
 * grid (labels in world metres, north up = -Z), and the layout's sites.
 *
 *   node tools/algPlanView.mjs --file public/levels/alg-aures.v3proj --out plan.png [--layout games/alg-rts/layout.js]
 *
 * Also prints per-quadrant walkable % and the heights of the named sites, so
 * a layout can be argued with numbers, not only by eye.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";
import { readProject } from "./lib/v3proj.mjs";
import { NAV_MAX_SLOPE_DEG } from "./lib/rtsMapMetrics.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const FILE = args.file ?? "public/levels/alg-aures.v3proj";
const OUT = args.out ?? "plan.png";
const P = +(args.px ?? 1024);

const project = await readProject(FILE);
const man = project.manifest;
const { worldSize: W, heightmapSize: N, maxHeight: TOP } = man.terrain;
const hb = project.blobs.get("heightmap");
const hm = new Float32Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.length));
const lakes = man.lakes?.lakes ?? [];
const layout = args.layout ? await import(pathToFileURL(path.resolve(args.layout)).href) : null;

const H = (x, z) => {
  const fu = Math.max(0, Math.min(N - 1.001, ((x + W / 2) / W) * (N - 1)));
  const fv = Math.max(0, Math.min(N - 1.001, ((z + W / 2) / W) * (N - 1)));
  const x0 = fu | 0, y0 = fv | 0, tx = fu - x0, ty = fv - y0;
  const a = hm[y0 * N + x0], b = hm[y0 * N + x0 + 1], c = hm[(y0 + 1) * N + x0], d = hm[(y0 + 1) * N + x0 + 1];
  return ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty) * TOP;
};

// ── Image ───────────────────────────────────────────────────────────────────
const rgb = new Uint8Array(P * P * 3);
const m = W / P;
for (let py = 0; py < P; py++) for (let px = 0; px < P; px++) {
  const x = (px + 0.5) * m - W / 2, z = (py + 0.5) * m - W / 2;
  const e = m;
  const dx = (H(x + e, z) - H(x - e, z)) / (2 * e), dz = (H(x, z + e) - H(x, z - e)) / (2 * e);
  const slope = (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
  const lit = Math.max(0, (dx * 0.6 + dz * 0.6 + 1) / Math.hypot(dx, 1, dz) / 1.4);
  const h = H(x, z);
  // Height tint: low = warm tan, high = pale.
  const t = Math.min(1, h / 110);
  let r = (150 + 70 * t) * (0.45 + 0.7 * lit), g = (120 + 70 * t) * (0.45 + 0.7 * lit), b = (85 + 70 * t) * (0.45 + 0.7 * lit);
  if (slope > NAV_MAX_SLOPE_DEG) { r = r * 0.5 + 110; g *= 0.5; b *= 0.5; }
  for (const l of lakes) {
    if (h < l.level && Math.abs(x - l.cx) < l.sizeX / 2 && Math.abs(z - l.cz) < l.sizeZ / 2) { r = 40; g = 90; b = 140; }
  }
  const o = (py * P + px) * 3;
  rgb[o] = Math.min(255, r); rgb[o + 1] = Math.min(255, g); rgb[o + 2] = Math.min(255, b);
}
const put = (px, py, c) => {
  if (px < 0 || py < 0 || px >= P || py >= P) return;
  const o = (py * P + px) * 3; rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
};
const toPx = (x) => Math.round(((x + W / 2) / W) * P);
// Grid every 100 m, the axes stronger.
for (let v = -500; v <= 500; v += 100) {
  const k = toPx(v);
  for (let i = 0; i < P; i++) { put(k, i, v === 0 ? [30, 30, 30] : [70, 60, 50]); put(i, k, v === 0 ? [30, 30, 30] : [70, 60, 50]); }
}
// Tiny 3x5 digit font for the grid labels.
const DIG = { "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111", "4": "101101111001001", "5": "111100111001111", "6": "111100111101111", "7": "111001001001001", "8": "111101111101111", "9": "111101111001111", "-": "000000111000000" };
const text = (s, px, py, c = [20, 20, 20], sc = 2) => {
  [...s].forEach((ch, i) => {
    const f = DIG[ch]; if (!f) return;
    for (let k = 0; k < 15; k++) if (f[k] === "1") for (let a = 0; a < sc; a++) for (let b2 = 0; b2 < sc; b2++) put(px + i * 4 * sc + (k % 3) * sc + a, py + ((k / 3) | 0) * sc + b2, c);
  });
};
for (let v = -400; v <= 400; v += 100) { text(String(v), toPx(v) + 3, 3); text(String(v), 3, toPx(v) + 3); }
// Wadis: the route dotted, each ford a bright square.
for (const w of layout?.LAYOUT?.wadis ?? []) {
  const pts = w.points;
  const seg = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) { const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); seg.push(l); total += l; }
  const at = (f) => {
    let d = f * total;
    for (let i = 0; i < seg.length; i++) {
      if (d <= seg[i]) { const t = d / seg[i]; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t]; }
      d -= seg[i];
    }
    return pts[pts.length - 1];
  };
  for (let k = 0; k <= 400; k += 2) { const [x, z] = at(k / 400); put(toPx(x), toPx(z), [60, 40, 20]); put(toPx(x) + 1, toPx(z), [60, 40, 20]); }
  for (const f of w.fords) {
    const [x, z] = at(f);
    for (let a = -4; a <= 4; a++) for (let b2 = -4; b2 <= 4; b2++) put(toPx(x) + a, toPx(z) + b2, [120, 255, 120]);
  }
}
// Sites: filled discs of their radius, a colour per kind.
const KIND = { french: [40, 80, 220], aln: [200, 40, 40], point: [250, 220, 40], hamlet: [240, 240, 240], oasis: [40, 200, 200], pass: [250, 140, 30] };
const sites = layout?.LAYOUT?.sites ?? [];
for (const s of sites) {
  const c = KIND[s.kind] ?? [255, 0, 255];
  const R = Math.max(3, Math.round((s.r ?? 12) / m));
  const cx = toPx(s.x), cy = toPx(s.z);
  for (let a = 0; a < 360; a += 1) {
    const rad = (a * Math.PI) / 180;
    for (let w = 0; w < 3; w++) put(Math.round(cx + Math.cos(rad) * (R - w)), Math.round(cy + Math.sin(rad) * (R - w)), c);
  }
  for (let a = -2; a <= 2; a++) for (let b2 = -2; b2 <= 2; b2++) put(cx + a, cy + b2, c);
}

// ── PNG out ─────────────────────────────────────────────────────────────────
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};
const raw = Buffer.alloc(P * (P * 3 + 1));
for (let y = 0; y < P; y++) Buffer.from(rgb.buffer, y * P * 3, P * 3).copy(raw, y * (P * 3 + 1) + 1);
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(P, 0); ihdr.writeUInt32BE(P, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(OUT, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));

// ── Numbers ─────────────────────────────────────────────────────────────────
const quad = (x0, z0) => {
  let w = 0, n = 0;
  for (let z = z0; z < z0 + W / 2; z += 4) for (let x = x0; x < x0 + W / 2; x += 4) {
    const e = 2, dx = (H(x + e, z) - H(x - e, z)) / (2 * e), dz = (H(x, z + e) - H(x, z - e)) / (2 * e);
    n++; if ((Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI <= NAV_MAX_SLOPE_DEG) w++;
  }
  return Math.round((100 * w) / n);
};
console.log(`walkable %: NW ${quad(-W / 2, -W / 2)}  NE ${quad(0, -W / 2)}  SW ${quad(-W / 2, 0)}  SE ${quad(0, 0)}`);
for (const s of sites) {
  // Relief across the site's own disc: a base wants < ~4 m to level cleanly.
  let lo = Infinity, hi = -Infinity;
  const r = s.r ?? 12;
  for (let a = -r; a <= r; a += r / 4) for (let b = -r; b <= r; b += r / 4) {
    if (a * a + b * b > r * r) continue;
    const h = H(s.x + a, s.z + b); lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  console.log(`${s.kind.padEnd(7)} ${String(s.name).padEnd(24)} (${s.x}, ${s.z})  ground ${H(s.x, s.z).toFixed(1)} m  relief ${(hi - lo).toFixed(1)} m`);
}
console.log(`written ${OUT}`);
