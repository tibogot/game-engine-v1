// GROUND CONTACT SHADE — the "ambient occlusion" of the image pass, BAKED (2026-10-07, you: "AO
// yes, but the most optimised way"). Screen-space AO (the engine's N8AO) MEASURED over Mechta
// Ouled Ali at game zoom (gpuAB, interleaved): +0.35 ms half-res Low at dist 45 — most of it the
// normal attachment it adds to the scene pass (+0.31 alone) — and +0.8 ms half-res Medium, for a
// barely visible line under the walls from the RTS camera: not worth it. (A first reading of
// "+3.4 ms" was a noisy close-zoom run — spread ±5 ms.) What grounds a building, a wall, a rock seen from above is the ground
// DARKENING round its foot, and that never moves: it is laid here once as ground splats (the
// ground cache bakes them with the rest — algSplats.js, v3/terrain/groundCache.js), `match: 1`
// (the splat takes the ground's own colour) with a dark tint, so it shades the ground in place,
// soft-edged. ZERO cost per frame.
//
//   BUILDINGS  each blocking block of a piece (its navRects: a village's houses, a post's walls),
//              else its footprint, a little beyond its walls
//   WALLS      the field walls, the piste walls (their cover circles)
//   ROCKS      the outcrops and boulder clusters (their cover circles)
// Pieces lying flat on the ground (pads, threshing floors, fields) get none.

export const CONTACT = {
  tint: [0.6, 0.58, 0.56],   // how dark at its heart (× the ground's own colour)
  opacity: 0.7,
  soft: 0.75,                // most of the patch is falloff
  margin: 1.4,               // m past a building's block
  wall: 1.5,                 // m half-size round a wall stone circle
  rock: 1.3,                 // × a rock's cover radius
  minHeight: 1.2,            // m: lower pieces lie flat, no shade
};

/** The contact splats for everything standing on the map (call once its pieces exist). */
export function contactSplats(app, matIndex) {
  const C = CONTACT, out = [];
  const base = { mat: matIndex, opacity: C.opacity, tint: C.tint, tile: 3, soft: C.soft, push: 0, warp: 0.15, normal: 0, match: 1, _layer: 50 };
  // Buildings: their blocks (or footprint), turned with them.
  for (const o of Object.values(app.showroom ?? {})) {
    const ud = o?.geometry?.userData;
    if (!o?.isMesh || !ud?.footprint || !o.visible) continue;
    if ((ud.height ?? 0) < C.minHeight) continue;
    const ry = o.rotation.y, c = Math.cos(ry), s = Math.sin(ry);
    const rects = ud.navRects?.length ? ud.navRects : [ud.footprint];
    for (const r of rects) {
      const wx = o.position.x + r.cx * c + r.cz * s, wz = o.position.z - r.cx * s + r.cz * c;
      // w, l are FULL sizes (groundCache setSplats). A thin wall rect shades a band, not a block.
      out.push({ ...base, x: wx, z: wz, w: 2 * (r.hx + C.margin), l: 2 * (r.hz + C.margin), yaw: -ry });
    }
  }
  // Walls and rocks: their cover circles.
  for (const c of app.algFields?.coverCircles?.() ?? []) out.push({ ...base, x: c.x, z: c.z, w: 2 * C.wall, l: 2 * C.wall, yaw: 0 });
  for (const c of app.algLandmarks?.coverCircles?.() ?? []) {
    const r = 2 * c.radius * C.rock;
    out.push({ ...base, x: c.x, z: c.z, w: r, l: r, yaw: (c.x * 7.3 + c.z) % 6.28 });
  }
  return out;
}
