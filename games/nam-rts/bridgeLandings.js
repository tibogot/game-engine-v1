// Bridge landings — every bridge on the map gets a ramp of ground at each end
// that meets its deck.
//
// A bridge was placed where both banks stood at deck height (see the bridges
// memory: a span is measured at DECK height), but the map has been reshaped
// since — terracing, the lift — and MEASURED on nam-valley both crossings had
// stopped being crossings: the north bridge's east landing sat 11 m above its
// deck on a 60° wall, the south one ended on 36–42° river banks with rocks on
// them. carveBridges() opens the deck in nav, but a deck you cannot step onto
// joins nothing, and the river cut the map in two again.
//
// So the ground comes to the bridge: from each deck end, walk outward along the
// span until a gentle slope (RAMP_MAX) reaches the natural ground, and grade a
// straight ramp between the two (app.gradeRamp). Rocks on the ramp go. Runtime,
// every boot, like the camp berm — the map keeps its saved ground.

const RAMP_MAX = Math.tan((16 * Math.PI) / 180);  // well inside the 34° nav limit
const HALF_WIDTH = 4;     // the deck is 5.5 m wide
const SHOULDER = 9;       // eased back into the ground over this much

/** Every bridge prop: its centre, span axis, half-length and deck height. */
export function listBridges(app) {
  const ps = app.propStore;
  const out = [];
  if (!ps?.instances) return out;
  for (let i = 0; i < ps.instances.length; i++) {
    const inst = ps.instances[i];
    const type = ps.types?.[inst.typeIdx];
    if (!type || !/bridge/i.test(type.name || "")) continue;
    const box = type.live ? app.getLivePropLocalBox?.(i) : type.mergedBox;
    if (!box) continue;
    const r = ((inst.ry ?? 0) * Math.PI) / 180;       // propStore rotations are DEGREES
    out.push({
      x: inst.px, z: inst.pz, y: inst.py,
      ax: Math.cos(r), az: -Math.sin(r),               // local +X (the span) in world
      half: Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) * (inst.sx ?? 1),
    });
  }
  return out;
}

export async function gradeBridgeLandings(app) {
  if (!app.gradeRamp) return [];
  const ps = app.propStore;
  const ramps = [];
  const decks = [];
  for (const b of listBridges(app)) {
    // The deck itself too: jungle painted under a bridge grew up through its planks.
    decks.push({ from: { x: b.x - b.ax * b.half, z: b.z - b.az * b.half }, to: { x: b.x + b.ax * b.half, z: b.z + b.az * b.half } });
    for (const side of [-1, 1]) {
      const ex = b.x + b.ax * side * b.half, ez = b.z + b.az * side * b.half;
      // The shortest run whose slope to the natural ground is gentle enough.
      let L = 44, gy = app.getWorldHeight(ex + b.ax * side * L, ez + b.az * side * L);
      for (let l = 6; l <= 44; l += 2) {
        const g = app.getWorldHeight(ex + b.ax * side * l, ez + b.az * side * l);
        if (Math.abs(g - b.y) / l <= RAMP_MAX) { L = l; gy = g; break; }
      }
      // Start a metre under the deck's end so the ramp meets the abutment.
      const from = { x: ex - b.ax * side, z: ez - b.az * side, y: b.y };
      const to = { x: ex + b.ax * side * L, z: ez + b.az * side * L, y: gy };
      await app.gradeRamp(from, to, { halfWidth: HALF_WIDTH, shoulder: SHOULDER });
      ramps.push({ from, to });
    }
  }
  // Nothing may stand on a ramp: rocks from the map, and the jungle.
  for (const { from, to } of ramps) {
    const dx = to.x - from.x, dz = to.z - from.z, L2 = dx * dx + dz * dz || 1;
    for (let i = (ps?.instances?.length ?? 0) - 1; i >= 0; i--) {
      const inst = ps.instances[i];
      if (/bridge/i.test(ps.types?.[inst.typeIdx]?.name || "")) continue;
      const t = Math.max(0, Math.min(1, ((inst.px - from.x) * dx + (inst.pz - from.z) * dz) / L2));
      if (Math.hypot(inst.px - (from.x + dx * t), inst.pz - (from.z + dz * t)) < HALF_WIDTH + 3) ps.removeInstance(i);
    }
  }
  for (const { from, to } of [...ramps, ...decks]) {
    const dx = to.x - from.x, dz = to.z - from.z;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 6));
    for (let k = 0; k <= n; k++) {
      app.clearVegetation?.(from.x + (dx * k) / n, from.z + (dz * k) / n, HALF_WIDTH + 3, { grass: 0 });
    }
  }
  return ramps;
}
