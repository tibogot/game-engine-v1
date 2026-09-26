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
const HALF_WIDTH = 4;     // the old deck was 5.5 m wide (the planned bridges carry their own)
const SHOULDER = 9;       // eased back into the ground over this much

/**
 * Every bridge: the planned ones (namBridges.js, app.namBridges) once there is
 * a plan, else the map's bridge props. { x, z, y, ax, az, half, halfWidth? }.
 */
export function listBridges(app) {
  return app.namBridges ?? listBridgeProps(app);
}

/** The map's bridge props: centre, span axis, half-length, deck height, prop index. */
export function listBridgeProps(app) {
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
      propIdx: i,
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
      const rhw = (b.halfWidth ?? HALF_WIDTH - 1) + 1;
      let from;
      if (b.halfWidth != null) {
        // A PLANNED bridge (namBridges.js): its deck is flat at b.y out to its
        // end. gradeRamp flattens a CAPSULE — the full half-width round its
        // start too — so a ramp started under the deck laid the ground at the
        // road's own height under its first 5 m: terrain and planks in one
        // plane, z-fighting (your screenshot, 2026-09-26). Start a half-width
        // OUT from the end and 0.2 m under the road: the ground stays under the
        // planks, with a sill's step up onto the deck, as on a real bridge.
        L = Math.max(L, rhw + 4);
        from = { x: ex + b.ax * side * rhw, z: ez + b.az * side * rhw, y: b.y - 0.2 };
      } else {
        // Start a metre under the deck's end so the ramp meets the abutment.
        from = { x: ex - b.ax * side, z: ez - b.az * side, y: b.y };
      }
      const to = { x: ex + b.ax * side * L, z: ez + b.az * side * L, y: b.halfWidth != null ? app.getWorldHeight(ex + b.ax * side * L, ez + b.az * side * L) : gy };
      await app.gradeRamp(from, to, { halfWidth: rhw, shoulder: SHOULDER });
      ramps.push({ from, to });
    }
  }
  // UNDER a planned deck the ground is cut to CLEAR it: the bank rose inside
  // the ends up to 1.8 m ABOVE the road (the old landing flattened that as a
  // side effect of starting under the deck). Cut only — min(ground, deck −
  // 0.35) — so the river under the bridge is untouched; the cut eases out
  // beside the deck (1 m of depth per metre) instead of leaving a trench wall.
  if (app.remapHeights) {
    for (const b of listBridges(app)) {
      if (b.halfWidth == null || !b.deckAt) continue;
      const side = b.halfWidth + 0.8, reach = side + 4;
      const xs = [], zs = [];
      for (const s of [-1, 1]) for (const c of [-1, 1]) {
        xs.push(b.x + b.ax * s * (b.half + 1) - b.az * c * reach);
        zs.push(b.z + b.az * s * (b.half + 1) + b.ax * c * reach);
      }
      await app.remapHeights(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), (wx, wz, y) => {
        const rx = wx - b.x, rz = wz - b.z;
        const along = rx * b.ax + rz * b.az, across = Math.abs(-rx * b.az + rz * b.ax);
        // (a metre past each end too: the ramp's shoulder rose over the deck's corners)
        if (Math.abs(along) > b.half + 1 || across > reach) return null;
        const clear = b.deckAt(Math.max(-b.half, Math.min(b.half, along))) - 0.35 + Math.max(0, across - side);
        return y > clear ? clear : null;
      });
    }
  }
  // …and no rock may reach up into a deck: a "Rock: Lump" stood 0.6 m proud of
  // the Bailey's planks, left on the bank the cut above took away. Rocks that
  // stay under a deck (in the water) are kept.
  for (const b of listBridges(app)) {
    if (b.halfWidth == null || !b.deckAt) continue;
    for (let i = (ps?.instances?.length ?? 0) - 1; i >= 0; i--) {
      const inst = ps.instances[i];
      const type = ps.types?.[inst.typeIdx];
      if (!type || /bridge/i.test(type.name || "")) continue;
      const rx = inst.px - b.x, rz = inst.pz - b.z;
      const along = rx * b.ax + rz * b.az, across = -rx * b.az + rz * b.ax;
      const box = type.mergedBox;
      const reach = box ? Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.5 * Math.max(Math.abs(inst.sx ?? 1), Math.abs(inst.sz ?? 1)) : 1;
      if (Math.abs(along) > b.half + 1 + reach || Math.abs(across) > b.halfWidth + 1 + reach) continue;
      const top = inst.py + (box ? box.max.y * Math.abs(inst.sy ?? 1) : 1);
      if (top > b.deckAt(Math.max(-b.half, Math.min(b.half, along))) - 0.15) ps.removeInstance(i);
    }
  }
  // Nothing may stand on a ramp: rocks from the map, and the jungle.
  for (const { from, to } of ramps) {
    // (the jungle and rocks go off a ramp as wide as the widest deck, plus room)
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
