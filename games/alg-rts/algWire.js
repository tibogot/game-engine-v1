// BARBED WIRE THAT MATTERS (you, 2026-10-01; CoH's wire): a run of wire is
// a wall to men on foot and nothing to a vehicle.
//
//   BLOCKS     the sappers' wire is a NO-FOOT footprint on the nav grid
//              (navGrid.js cell 3): infantry of both sides path ROUND it —
//              the FLN's bands too, with no change to their AI.
//   CRUSHED    a vehicle drives over it and it is gone (a tank, a truck, a
//              jeep: CoH lets any vehicle through wire).
//   CUT        men on foot beside it cut a gap: 8 s for one man, faster for
//              two or three. Your sappers: the "Couper" order (the nearest
//              wire within 40 m). The FLN: app.algWire.cutNearest(men, x, z)
//              for its AI (algAI.js is yours; not wired yet).
//   BLOWN      a grenade or a shell on it (algDamage.js passes blasts on).
//
// A wire that goes leaves the nav grid at once without a rebuild
// (navGrid.clearNoFootFootprint), leaves the showroom list (so nothing counts
// it any more), and puts up a little dust. Nothing here draws.
import { canBuild } from "./algBuild.js";

const P = {
  cutTime: 8,             // s for one man
  cutReach: 3.2,          // m from the wire's footprint a man can cut from
  orderRange: 40,         // the sappers' order: the nearest wire within this
  blastReach: 1.5,        // m past the footprint a blast still cuts it
  blastMin: 5,            // explosion size (a grenade is 6)
  every: 0.2,             // s between checks
};
const WIRE = /^wire\d*$/;

export function createAlgWire(app, { units, showroom = {}, navGrid = null, ambience = null }) {
  // ── The wire on the map: every standing piece of it ──────────────────────
  const progress = new Map();   // mesh → cut progress 0..1
  const wires = () => {
    const out = [];
    for (const [name, m] of Object.entries(showroom)) {
      if (m?.isObject3D && m.parent && WIRE.test(m.userData?.kitKey ?? name)) out.push({ name, m });
    }
    return out;
  };
  // Distance outside a piece's footprint (0 inside).
  const outside = (m, x, z) => {
    const fp = m.geometry.userData.footprint;
    const c = Math.cos(m.rotation.y), s = Math.sin(m.rotation.y);
    const dx = x - m.position.x, dz = z - m.position.z;
    const lx = c * dx - s * dz - fp.cx, lz = s * dx + c * dz - fp.cz;
    return Math.hypot(Math.max(0, Math.abs(lx) - fp.hx), Math.max(0, Math.abs(lz) - fp.hz));
  };

  function remove(w, why) {
    const m = w.m;
    if (m.userData.navFootprint) navGrid?.clearNoFootFootprint?.(m.userData.navFootprint);
    m.removeFromParent();
    delete showroom[w.name];
    progress.delete(m);
    for (const u of units.list) if (u.cutting === m) { u.cutting = null; u.working = null; }
    // A puff where it went.
    const d = ambience?.dust;
    if (d) for (let k = 0; k < 6; k++) {
      const x = m.position.x + (Math.random() - 0.5) * 4, z = m.position.z + (Math.random() - 0.5) * 4;
      d.spawn(x, app.getWorldHeight(x, z) + 0.5, z, 2.2, { vx: 0, vy: 0.4, vz: 0, scale: why === "crushed" ? 1.2 : 0.8 });
    }
  }

  // ── Every 0.2 s: crushed under a vehicle, cut by the men at it ───────────
  let t = 0;
  function step(dt) {
    if ((t -= dt) > 0) return;
    t = P.every;
    const list = wires();
    if (!list.length) return;
    for (const w of list) {
      let gone = false, cutters = 0;
      for (const u of units.list) {
        if (!u.alive || u.isAir || u.isStructure) continue;
        if (!u.type?.foot) {
          // A vehicle on it: crushed.
          if (outside(w.m, u.position.x, u.position.z) < (u.type?.radius ?? 2.5) * 0.4) { gone = true; break; }
          continue;
        }
        if (u.cutting !== w.m) continue;
        if (u.isMoving || outside(w.m, u.position.x, u.position.z) > P.cutReach) { u.working = null; continue; }
        cutters++;
        if (!u.working) { u.working = { x: w.m.position.x, z: w.m.position.z }; u.faceToward?.(w.m.position.x, w.m.position.z); }
      }
      if (gone) { remove(w, "crushed"); continue; }
      if (!cutters) continue;
      // Two men 1.5x, three 1.8x (the sappers' rule: they get in the way).
      const p = (progress.get(w.m) ?? 0) + (P.every / P.cutTime) * (1 + 0.8 * (1 - 0.5 ** (cutters - 1)));
      if (p >= 1) remove(w, "cut"); else progress.set(w.m, p);
    }
  }
  app.addPreRenderHook((dt) => step(Math.min(dt, 0.1)));

  /** The nearest standing wire to (x, z) within `range`, or null. */
  function nearest(x, z, range = P.orderRange) {
    let best = null, bd = range;
    for (const w of wires()) { const d = outside(w.m, x, z); if (d < bd) { bd = d; best = w; } }
    return best;
  }
  /** Send `men` to cut wire piece `w`: each to open ground beside it, on his side. */
  function cut(men, w) {
    const m = w.m;
    for (const u of men) {
      if (!u.alive || !u.type?.foot) continue;
      const dx = u.position.x - m.position.x, dz = u.position.z - m.position.z, d = Math.hypot(dx, dz) || 1;
      // From the wire's centre toward the man, to just outside its footprint.
      let r = 1;
      while (r < 12 && outside(m, m.position.x + (dx / d) * r, m.position.z + (dz / d) * r) < 0.6) r += 0.5;
      const ex = m.position.x + (dx / d) * r, ez = m.position.z + (dz / d) * r;
      const p = navGrid?.nearestOpenWorld?.(ex, ez, true) ?? { x: ex, z: ez };
      u.cutting = m;
      u.working = null;
      u.moveOrder?.(p.x, p.z);
    }
  }

  return {
    params: P,
    get list() { return wires().map((w) => w.m); },
    nearest,
    cut,
    /** The FLN's AI (or anyone): the men cut the nearest wire to (x, z). True if there was one. */
    cutNearest(men, x, z, range = P.orderRange) {
      const w = nearest(x, z, range);
      if (!w) return false;
      cut(men, w);
      return true;
    },
    /** The sappers' order: the wire nearest the selection's centre. */
    orderCut(sel) {
      const men = sel.filter((u) => u.alive && u.team === "player" && canBuild(u, "wire"));
      if (!men.length) return false;
      const cx = men.reduce((s, u) => s + u.position.x, 0) / men.length, cz = men.reduce((s, u) => s + u.position.z, 0) / men.length;
      return this.cutNearest(men, cx, cz);
    },
    /** An explosion (algDamage.js): wire within reach is blown. */
    blast(x, z, size) {
      if (size < P.blastMin) return;
      for (const w of wires()) if (outside(w.m, x, z) < P.blastReach + size * 0.1) remove(w, "blown");
    },
    /** Cut progress of a piece, 0..1 (a bar, a test). */
    progressOf: (m) => progress.get(m) ?? 0,
  };
}
