// Requisition points — GAME LOGIC (mesh-free). The economy: supplies come
// from ground you HOLD, not from crates you haul. Replaces harvesting (which
// survives as ?econ=harvest).
//
// A point is a relay mast on a site across the map. INFANTRY standing in its
// zone capture it, the way Company of Heroes does it:
//   · yours in the zone, none of theirs → the capture moves your way
//   · theirs in, none of yours          → it moves theirs
//   · both                              → contested, nothing moves
//   · nobody                            → it stays where it is
// `progress` runs -1 (enemy's) .. +1 (yours). A point you hold must be pulled
// back through 0 (neutral) before the other side can take it. Owning pays
// supplies every second. Men, not vehicles: a jeep parked on a hill holds
// nothing — it is the rifle squad that makes it yours.
import * as THREE from "three";
import { findBuildSite } from "./sitePlanner.js";

export const REQUISITION = {
  radius: 16,           // the zone, metres from the mast
  captureTime: 12,      // seconds for ONE man from neutral to held
  crowdBonus: 0.35,     // each extra man up to `crowdCap` adds this much speed
  crowdCap: 4,
  incomePerPoint: 1.6,  // supplies per second per held point (~96 a minute)
  count: 7,
  firstDist: 95,        // the same fan the resource nodes used
  spacing: 80,
};

/** Can this unit capture? Infantry only. */
const captures = (u) => u.alive && !u.isAir && u.typeKey === "soldier";

export function createRequisition({ app, resources, params = REQUISITION, onCapture = null, onLost = null }) {
  const points = [];

  /** Fan the points out in front of the base, alternating sides, widening. */
  function placePoints(basePos) {
    for (let i = 0; i < params.count; i++) {
      const dist = params.firstDist + i * params.spacing;
      const ang = (i % 2 ? 1 : -1) * (0.32 + i * 0.11);
      const x = basePos.x + Math.sin(ang) * dist;
      const z = basePos.z + Math.cos(ang) * dist;
      const site = findBuildSite(app, x, z, 6, { searchRadius: 140, maxSpread: 6 });
      if (!site) { console.warn(`[requisition] no ground for point ${i} — skipped`); continue; }
      points.push({
        kind: "requisitionPoint",
        id: i,
        name: `Point ${String.fromCharCode(65 + i)}`,   // A, B, C…
        position: new THREE.Vector3(site.x, site.y, site.z),
        radius: params.radius,
        progress: 0,
        owner: null,          // null | "player" | "enemy"
        contested: false,
        capturing: 0,         // -1 enemy / 0 / +1 player, this step
      });
    }
    return points;
  }

  /** FIXED-STEP: run every point's capture from who is standing in it. */
  function step(dt, units) {
    for (const p of points) {
      let mine = 0, theirs = 0;
      const r2 = p.radius * p.radius;
      for (const u of units) {
        if (!captures(u)) continue;
        const dx = u.position.x - p.position.x, dz = u.position.z - p.position.z;
        if (dx * dx + dz * dz > r2) continue;
        if (u.team === "player") mine++; else if (u.team === "enemy") theirs++;
      }
      p.contested = mine > 0 && theirs > 0;
      p.capturing = p.contested ? 0 : mine > 0 ? 1 : theirs > 0 ? -1 : 0;
      if (!p.capturing) continue;
      const n = Math.min(params.crowdCap, p.capturing > 0 ? mine : theirs);
      const rate = (1 + params.crowdBonus * (n - 1)) / params.captureTime;
      p.progress = Math.max(-1, Math.min(1, p.progress + p.capturing * rate * dt));
      // A held point is lost when it has been pulled back to neutral…
      if ((p.owner === "player" && p.progress <= 0) || (p.owner === "enemy" && p.progress >= 0)) {
        const was = p.owner;
        p.owner = null;
        onLost?.(p, was);
      }
      // …and taken when a side runs it all the way to its own end.
      if (!p.owner && Math.abs(p.progress) >= 1) {
        p.owner = p.progress > 0 ? "player" : "enemy";
        onCapture?.(p, p.owner);
      }
    }
    // Income from what you hold.
    const held = points.reduce((n, p) => n + (p.owner === "player" ? 1 : 0), 0);
    if (held) resources?.earn?.(held * params.incomePerPoint * dt);
  }

  return {
    points,
    placePoints,
    step,
    params,
    get held() { return points.filter((p) => p.owner === "player").length; },
    get heldByEnemy() { return points.filter((p) => p.owner === "enemy").length; },
    /** Supplies per minute from the points you hold, for the HUD. */
    get incomePerMinute() { return Math.round(this.held * params.incomePerPoint * 60); },
    /** The point whose zone contains (x, z), or null. */
    pointAt(x, z) {
      for (const p of points) if (Math.hypot(x - p.position.x, z - p.position.z) <= p.radius) return p;
      return null;
    },
  };
}
