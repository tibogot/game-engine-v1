// FOG BANKS — nam's siting (river, temple, jungle hollow). The machinery is
// shared (games/shared-rts/fogBanks.js).
export { FOG_BANK_PARAMS, createFogBanks } from "../shared-rts/fogBanks.js";

/**
 * WHERE, on a map with no authored banks: mist along a stretch of the river,
 * the valley floor round the temple, and one hollow in the jungle. Found from
 * the map itself (water, heights, the canopy field), so it follows the map.
 */
export function siteFogBanks(app, fog, { temples = [], field = null } = {}) {
  const W = app.worldSize ?? 1024, half = W / 2;
  const ground = (x, z) => app.getWorldHeight?.(x, z) ?? 0;
  const water = (x, z) => (app.getWaterLevelAt?.(x, z) ?? -Infinity);
  const placed = [];

  // ── The river: its middle stretch, as a chain of long banks along it ──────
  const G = 8, N = Math.floor(W / G);
  const wet = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x = -half + i * G + G / 2, z = -half + j * G + G / 2;
    if (water(x, z) > ground(x, z) + 0.3) wet.push({ x, z, y: water(x, z) });
  }
  if (wet.length > 20) {
    // Order the wet cells along the river's main direction and take the
    // stretch through the middle of the map (where the play is).
    let mx = 0, mz = 0;
    for (const w of wet) { mx += w.x; mz += w.z; }
    mx /= wet.length; mz /= wet.length;
    let sxx = 0, sxz = 0, szz = 0;
    for (const w of wet) { const dx = w.x - mx, dz = w.z - mz; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
    const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    const ax = Math.cos(ang), az = Math.sin(ang);
    const along = (w) => (w.x - mx) * ax + (w.z - mz) * az;
    // Nearest wet cells to the map's middle first, then walk ±120 m along.
    const byMid = [...wet].sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
    const c = byMid[0];
    const s0 = along(c);
    const stretch = wet.filter((w) => Math.abs(along(w) - s0) < 140);
    // Chain: every ~55 m along, a bank on the local middle of the water.
    for (let s = s0 - 120; s <= s0 + 120; s += 55) {
      const cells = stretch.filter((w) => Math.abs(along(w) - s) < 28);
      if (cells.length < 2) continue;
      let x = 0, z = 0, y = 0;
      for (const w of cells) { x += w.x; z += w.z; y += w.y; }
      x /= cells.length; z /= cells.length; y /= cells.length;
      // Local heading from the cells' own spread.
      let lxx = 0, lxz = 0, lzz = 0;
      for (const w of cells) { const dx = w.x - x, dz = w.z - z; lxx += dx * dx; lxz += dx * dz; lzz += dz * dz; }
      const la = 0.5 * Math.atan2(2 * lxz, lxx - lzz);
      placed.push(fog.add({ name: "river", x, z, floor: y + 1.5, along: 42, across: 20, height: 7, rotY: -la, density: 0.13 }));
    }
  }

  // ── The temple's valley floor ─────────────────────────────────────────────
  for (const t of temples) {
    let lo = { y: Infinity, x: t.x, z: t.z };
    for (let r = 20; r <= 160; r += 20) for (let a = 0; a < 16; a++) {
      const x = t.x + Math.cos((a / 16) * Math.PI * 2) * r, z = t.z + Math.sin((a / 16) * Math.PI * 2) * r;
      const y = ground(x, z);
      if (y < lo.y && water(x, z) < y) lo = { x, z, y };
    }
    // ON the temple, leaning a third of the way toward its low ground, the
    // densest layer just over the temple's own floor: its courts in mist and
    // its towers standing out of it. (Sited on the low ground itself, the
    // bank lay on a slope 100 m off, where nobody looks.)
    const x = (lo.x + t.x * 2) / 3, z = (lo.z + t.z * 2) / 3;
    placed.push(fog.add({ name: "temple", x, z, floor: ground(t.x, t.z) + 1.5, along: 95, across: 75, height: 10,
      rotY: -Math.atan2(lo.z - t.z, lo.x - t.x), density: 0.055 }));
  }

  // ── A hollow in the jungle: the deepest dip under the canopy ──────────────
  if (field) {
    let best = null;
    for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j++) {
      const x = -half + (i + 0.5) * (W / 60), z = -half + (j + 0.5) * (W / 60);
      if (field.open(x, z) * field.forest(x, z) < 0.5) continue;
      const y = ground(x, z);
      if (water(x, z) > y) continue;
      let ring = 0;
      for (let a = 0; a < 8; a++) ring += ground(x + Math.cos(a * 0.785) * 45, z + Math.sin(a * 0.785) * 45);
      const dip = ring / 8 - y;
      if (Math.abs(x) > half * 0.8 || Math.abs(z) > half * 0.8) continue;   // not the map's rim
      if (!best || dip > best.dip) best = { x, z, y, dip };
    }
    if (best && best.dip > 4) {
      placed.push(fog.add({ name: "hollow", x: best.x, z: best.z, floor: best.y + best.dip * 0.4,
        along: 55, across: 45, height: Math.max(8, best.dip * 0.8), density: 0.09 }));
    }
  }
  return placed;
}
