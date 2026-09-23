/**
 * Wheel ruts and track marks in a FEW places, not along every path — and only
 * where the path runs straight.
 *
 * A rut decal is a straight 10 m box. The paths curve, so a chain of straight
 * boxes laid along them kinks at every joint (a quarter of the joints turn 16°
 * or more, a tenth over 40°) and the ruts visibly fail to follow the path.
 * Real wear is patchy anyway: ruts show where a truck bogged, not as a stencil
 * down every metre of track. So (your call, 2026-09-24):
 *
 *   1. group the segments back into the strips they were split from (same
 *      yaw, collinear, within a strip's length of each other),
 *   2. measure each strip's BEND — the larger of its turns to its two nearest
 *      neighbouring strips,
 *   3. keep a short patch (the middle segment, sometimes one more) only on
 *      strips bending under MAX_BEND, at least SPACING metres apart,
 *   4. drop the rest.
 *
 * Also drops the aprons that the first decal pass laid on a 14 m grid, under
 * no building at all: the game now stamps an apron under every structure at
 * the moment it levels its pad (see games/nam-rts/buildingAprons.js).
 *
 *   node tools/namThinRuts.mjs [--dry] [--spacing 70] [--bend 8]
 */
import fs from "node:fs";
import { readProject, writeProject } from "./lib/v3proj.mjs";

const LEVEL = "public/levels/nam-valley.v3proj";
const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const num = (flag, def) => { const i = argv.indexOf(flag); return i >= 0 ? Number(argv[i + 1]) : def; };
const SPACING = num("--spacing", 70);
const MAX_BEND = num("--bend", 8);

const { manifest, blobs, fileBytes } = await readProject(LEVEL);
const D = manifest.decals;
const name = (d) => D.slots[d.slot]?.name ?? "";
const isStrip = (d) => /^(ruts|tankTracks)/.test(name(d));
const isApron = (d) => /^apron/.test(name(d));

const yaw = (d) => Math.atan2(2 * (d.qw * d.qy + d.qx * d.qz), 1 - 2 * (d.qy * d.qy + d.qx * d.qx));
/** Angle between two undirected lines, 0..90°. */
const turn = (a, b) => {
  let t = Math.abs(a - b) % Math.PI;
  if (t > Math.PI / 2) t = Math.PI - t;
  return (t * 180) / Math.PI;
};
const hash = (x, z) => {
  let h = Math.imul(Math.round(x * 10), 73856093) ^ Math.imul(Math.round(z * 10), 19349663);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h >>> 0) / 4294967296;
};

// ── 1. strips ───────────────────────────────────────────────────────────────
const segs = D.decals.filter(isStrip);
const groups = [];
const seen = new Set();
for (const s of segs) {
  if (seen.has(s)) continue;
  const g = [s];
  seen.add(s);
  const y = yaw(s);
  const ax = Math.sin(y), az = Math.cos(y);
  for (const t of segs) {
    if (seen.has(t) || t.slot === undefined) continue;
    if (Math.abs(yaw(t) - y) > 1e-3) continue;
    const dx = t.px - s.px, dz = t.pz - s.pz;
    const along = dx * ax + dz * az, across = Math.abs(dx * az - dz * ax);
    if (across < 0.05 && Math.abs(along) < 20) { g.push(t); seen.add(t); }
  }
  // Order along the strip.
  g.sort((a, b) => (a.px - s.px) * ax + (a.pz - s.pz) * az - ((b.px - s.px) * ax + (b.pz - s.pz) * az));
  const cx = g.reduce((v, d) => v + d.px, 0) / g.length;
  const cz = g.reduce((v, d) => v + d.pz, 0) / g.length;
  groups.push({ segs: g, cx, cz, yaw: y });
}

// ── 2. bend ─────────────────────────────────────────────────────────────────
for (const g of groups) {
  const near = groups
    .filter((o) => o !== g)
    .map((o) => ({ o, d: Math.hypot(o.cx - g.cx, o.cz - g.cz) }))
    .filter((e) => e.d < 32)
    .sort((a, b) => a.d - b.d)
    .slice(0, 2);
  // An isolated strip has nothing to kink against: treat it as straight.
  g.bend = near.length ? Math.max(...near.map((e) => turn(g.yaw, e.o.yaw))) : 0;
}

// ── 3. pick patches ─────────────────────────────────────────────────────────
const cands = groups.filter((g) => g.bend < MAX_BEND).sort((a, b) => hash(a.cx, a.cz) - hash(b.cx, b.cz));
const chosen = [];
for (const g of cands) {
  if (chosen.some((c) => Math.hypot(c.cx - g.cx, c.cz - g.cz) < SPACING)) continue;
  chosen.push(g);
}
const keep = new Set();
for (const g of chosen) {
  const mid = Math.floor(g.segs.length / 2);
  keep.add(g.segs[mid]);
  // Half the patches run a segment longer, so they are not all one length.
  if (g.segs.length > 1 && hash(g.cz, g.cx) < 0.5) keep.add(g.segs[Math.min(g.segs.length - 1, mid + 1)]);
}

// ── 4. write ────────────────────────────────────────────────────────────────
const aprons = D.decals.filter(isApron).length;
const out = D.decals.filter((d) => (isStrip(d) ? keep.has(d) : !isApron(d)));
const bends = groups.map((g) => g.bend).sort((a, b) => a - b);
console.log(`${LEVEL}  ${(fileBytes / 1e6).toFixed(1)} MB`);
console.log(`strips ${groups.length} (bend p50 ${bends[bends.length >> 1].toFixed(1)}°, p75 ${bends[Math.floor(bends.length * 0.75)].toFixed(1)}°)`);
console.log(`straight (< ${MAX_BEND}°) ${cands.length}  ->  patches ${chosen.length} (>= ${SPACING} m apart)`);
console.log(`rut/track segments ${segs.length} -> ${keep.size}`);
console.log(`grid aprons dropped ${aprons}`);
console.log(`decals ${D.decals.length} -> ${out.length}`);
if (dry) { console.log("\ndry run — nothing written"); process.exit(0); }

manifest.decals = { ...D, decals: out };
fs.copyFileSync(LEVEL, `${LEVEL}.bak`);
const w = await writeProject(LEVEL, { manifest, blobs });
console.log(`\nwrote ${(w / 1e6).toFixed(1)} MB; previous kept at nam-valley.v3proj.bak`);
