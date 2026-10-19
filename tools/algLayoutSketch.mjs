/**
 * A MAP'S LAYOUT, SKETCHED (2026-10-19, the Oued Abdi plan: games/alg-rts/AURES2_PLAN.md) — before any
 * ground exists: the play box, a 50 m grid, the oued and its fords, the gullies, the pistes, the sites,
 * the capture points and supply — and the DEAD ZONES measured: the share of the box farther than 90 / 120 m
 * from anything to fight over (the old Aurès: 48 % / 28 % before its late supply points; CoH: a point every
 * 60-80 m). Writes an SVG.
 *
 *   node tools/algLayoutSketch.mjs games/alg-rts/maps/abdi.js out.svg
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [, , mapFile = "games/alg-rts/maps/abdi.js", out = "layout.svg"] = process.argv;
const M = await import(pathToFileURL(path.resolve(mapFile)).href);
const { PLAY, LAYOUT } = M;
const W = PLAY.x1 - PLAY.x0, D = PLAY.z1 - PLAY.z0, PX = 900 / Math.max(W, D), pad = 40;
const X = (x) => pad + (x - PLAY.x0) * PX, Z = (z) => pad + (z - PLAY.z0) * PX;
const poly = (pts) => pts.map(([x, z]) => `${X(x).toFixed(1)},${Z(z).toFixed(1)}`).join(" ");

// what is fought over: the points and the supply
const targets = [...LAYOUT.sites.filter((s) => s.point || s.kind === "french" || s.kind === "aln"), ...LAYOUT.supply];
const cells = [];
let far90 = 0, far120 = 0, n = 0;
for (let z = PLAY.z0 + 5; z < PLAY.z1; z += 10) for (let x = PLAY.x0 + 5; x < PLAY.x1; x += 10) {
  const d = Math.min(...targets.map((t) => Math.hypot(t.x - x, t.z - z)));
  n++; if (d > 90) far90++; if (d > 120) far120++;
  if (d > 70) cells.push(`<rect x="${X(x - 5)}" y="${Z(z - 5)}" width="${10 * PX}" height="${10 * PX}" fill="#d0402a" fill-opacity="${Math.min(0.55, (d - 70) / 120)}"/>`);
}
const fr = LAYOUT.sites.find((s) => s.kind === "french"), aln = LAYOUT.sites.find((s) => s.kind === "aln");
const startGap = Math.hypot(fr.x - aln.x, fr.z - aln.z);
const pts = LAYOUT.sites.filter((s) => s.point);
const nearest = pts.map((p) => Math.min(...pts.filter((q) => q !== p).map((q) => Math.hypot(p.x - q.x, p.z - q.z))));
const stats = [
  `box ${W} × ${D} m · starts ${startGap.toFixed(0)} m apart`,
  `${pts.length} points + 2 homes · ${LAYOUT.supply.length} supply`,
  `point to its nearest point: ${Math.min(...nearest).toFixed(0)}-${Math.max(...nearest).toFixed(0)} m (mean ${(nearest.reduce((a, b) => a + b, 0) / nearest.length).toFixed(0)})`,
  `dead zones: ${((far90 / n) * 100).toFixed(0)} % > 90 m · ${((far120 / n) * 100).toFixed(0)} % > 120 m (old Aurès 48 % / 28 %)`,
];
const COL = { french: "#3a7bd5", aln: "#c0392b", cave: "#c0392b", town: "#f2f2f2", oasis: "#3fb6a0", hamlet: "#b9895a", farm: "#b9895a", dechra: "#9c8b75", koubba: "#e8e2d4", pass: "#e0a24a", point: "#e0a24a", motorPool: "#3a7bd5", helipad: "#3a7bd5" };
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * PX + pad * 2}" height="${D * PX + pad * 2 + 110}" font-family="Segoe UI, sans-serif">
<rect width="100%" height="100%" fill="#1b1610"/>
<rect x="${X(PLAY.x0)}" y="${Z(PLAY.z0)}" width="${W * PX}" height="${D * PX}" fill="#6e5a3e"/>
<path d="M ${X(PLAY.x0)} ${Z(PLAY.z0)} L ${X(PLAY.x1)} ${Z(PLAY.z0)} L ${X(PLAY.x1)} ${Z(-120)} Q ${X(-60)} ${Z(-190)} ${X(PLAY.x0)} ${Z(20)} Z" fill="#4a3d2b"/>
<text x="${X(-200)}" y="${Z(-225)}" fill="#c9b48e" font-size="13">DJEBEL (FLN)</text>
${cells.join("")}
${Array.from({ length: Math.floor(W / 50) + 1 }, (_, i) => PLAY.x0 + i * 50).map((x) => `<line x1="${X(x)}" y1="${Z(PLAY.z0)}" x2="${X(x)}" y2="${Z(PLAY.z1)}" stroke="#ffffff" stroke-opacity="0.08"/><text x="${X(x) + 2}" y="${Z(PLAY.z1) + 14}" fill="#8a7a5c" font-size="10">${x}</text>`).join("")}
${Array.from({ length: Math.floor(D / 50) + 1 }, (_, i) => PLAY.z0 + i * 50).map((z) => `<line x1="${X(PLAY.x0)}" y1="${Z(z)}" x2="${X(PLAY.x1)}" y2="${Z(z)}" stroke="#ffffff" stroke-opacity="0.08"/><text x="${X(PLAY.x0) - 30}" y="${Z(z) + 4}" fill="#8a7a5c" font-size="10">${z}</text>`).join("")}
${LAYOUT.wadis.map((w) => `<polyline points="${poly(w.points)}" fill="none" stroke="#5b8fa8" stroke-width="${w.width * PX}" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>` + w.fords.map((f) => { const i = f * (w.points.length - 1), a = w.points[Math.floor(i)], b = w.points[Math.min(w.points.length - 1, Math.floor(i) + 1)], t = i % 1; return `<circle cx="${X(a[0] + (b[0] - a[0]) * t)}" cy="${Z(a[1] + (b[1] - a[1]) * t)}" r="6" fill="#d9c9a0" stroke="#000" stroke-width="1"/>`; }).join("")).join("")}
${LAYOUT.gullies.map((g) => `<polyline points="${poly(g.points)}" fill="none" stroke="#2a2118" stroke-width="${9 * PX}" stroke-linecap="round" opacity="0.9"/>`).join("")}
${LAYOUT.pistes.map((p) => `<polyline points="${poly(p)}" fill="none" stroke="#e8dcc0" stroke-width="2.5" stroke-dasharray="6 4" opacity="0.8"/>`).join("")}
${LAYOUT.sites.filter((s) => s.knoll).map((s) => `<circle cx="${X(s.knoll[0])}" cy="${Z(s.knoll[1])}" r="${s.knoll[2] * PX}" fill="#8f7754" opacity="0.6"/>`).join("")}
${LAYOUT.sites.map((s) => `<circle cx="${X(s.x)}" cy="${Z(s.z)}" r="${s.r * PX}" fill="${COL[s.kind] ?? "#aaa"}" fill-opacity="0.35" stroke="${COL[s.kind] ?? "#aaa"}" stroke-width="${s.point ? 3 : 1.5}"/>${s.point ? `<circle cx="${X(s.x)}" cy="${Z(s.z)}" r="5" fill="#ffd34a" stroke="#000"/>` : ""}<text x="${X(s.x) + s.r * PX + 4}" y="${Z(s.z) + 4}" fill="#fff" font-size="12" font-weight="600" paint-order="stroke" stroke="#000" stroke-width="3">${s.name}</text>`).join("")}
${LAYOUT.supply.map((s) => `<rect x="${X(s.x) - 5}" y="${Z(s.z) - 5}" width="10" height="10" fill="${s.res === "fuel" ? "#e67e22" : "#9b59b6"}" stroke="#000"/>`).join("")}
${stats.map((t, i) => `<text x="${pad}" y="${D * PX + pad + 34 + i * 18}" fill="#f1e6cc" font-size="14">${t}</text>`).join("")}
<text x="${pad}" y="${D * PX + pad + 34 + stats.length * 18}" fill="#a8987a" font-size="12">yellow dot = capture point · square = supply (orange fuel, purple munitions) · red = far from anything to fight over · dashed = piste · dark = gully · blue = oued (beige = ford)</text>
</svg>`;
fs.writeFileSync(out, svg);
console.log(stats.join("\n"));
console.log("→", out);
