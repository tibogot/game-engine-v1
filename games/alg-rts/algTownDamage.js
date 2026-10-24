// THE TOWN'S HOUSES BREAK AND COLLAPSE (2026-10-22 — the biggest gameplay gap left: Company of Heroes' signature).
// A map's town (algGame: one instanced field, algHouse createHouseField) — every house has its health; shells, mortar
// bombs and grenades bursting on it wear it down (algDamage.blast feeds `blast`):
//
//   DAMAGED   below DAMAGED_AT of its health: its damaged model (walls holed, roof part gone), a burst of dust, a
//             heap of rubble at its foot; the men inside take more from what bursts on it (blastMul).
//   COLLAPSED at 0: its ruin model, a big burst of dust and smoke; the men inside thrown out by the door, hurt, some
//             killed; it takes no garrison again, no longer stops a shot or a look over its broken walls (sight
//             lowered), its walls only SOFT cover. (Its nav footprint stays: the ruin model keeps its broken shell.)
//
// Not repaired (CoH: a ruin stays a ruin). The mosque stands longest.
//
// THE COLLAPSE (2026-10-24, building damage B — you: "use what we have, CoH 3"): the dust first, the ruin model a moment
// later under it; masonry THROWN OUT of its walls (the rubble kit's chunks, tools/blender/rubble.py — they fly, spin,
// bounce and settle where they land, and stay); two HEAPS slumped against its walls as the dust clears — soft cover
// (algGame town coverCircles: `rubble`). Without the rubble kit loaded: the dust and the swap only.
import * as THREE from "three";

const P = {
  hp: { default: 520, tour: 700, dar: 600, souk: 480, bas: 380, cour: 380, boutique: 380, mosquee: 1100 },
  damagedAt: 0.55,
  minSize: 5,            // a grenade (6) does a little; rifle fire nothing
  // (the sizes as they are, 2026-10-24: a grenade 6 ~32, the 60 / 81 / 120 mortar 6.2 / 8 / 10.4 ~36 / 64 / 102, a tank
  // shell ~8.5 ~73, a bazooka ~10.7 ~107, the recoilless ~11.1 ~114 (algCombat shellHit), a T-6 bomb ~10-13)
  per: (size) => Math.max(0, size - 4) * 16,
  reach: 1.5,            // m past its footprint a burst still counts
  ruinTop: 1.6,          // m: the rubble's height for sight
  hurtOnCollapse: [30, 90],
  blastMulDamaged: 1.6,
  swapDelay: 0.25,       // s: the ruin model swapped in under the dust, not before it
  heapDelay: 0.6,        // s: the heaps settle in as the dust clears
  chunks: [12, 20],      // masonry thrown out (by the house's size)
  chunkSpeed: [2.5, 6],  // m/s out of the wall, and up
  heapScale: [0.85, 1.15],
};
const CHUNKS = ["chunkslab", "chunkslab", "chunkstone", "chunkblock", "chunkblock", "chunkbeam"];

/**
 * @param app
 * @param o.field     the town's house field (setState(id, state))
 * @param o.houses    MAP.town.houses rows [type, state, x, y, z, yaw, fx, fz, hx, hz] — row i is field id i
 * @param o.footprints  the nav footprints (handles), index i
 * @param o.garrisons   the garrison houses (algGarrison addHouse results), index i (null for a ruin from the start)
 * @param o.par       parapet heights by type (real metres; × 1.3)
 */
export function createTownDamage(app, { field, houses, footprints = [], garrisons = [], par = {} }) {
  const H = houses.map(([ty, st, , y, , yaw, fx, fz, hx, hz], i) => {
    const max = P.hp[ty] ?? P.hp.default;
    const hp = st === "ruin" ? 0 : st === "damaged" ? max * P.damagedAt * 0.9 : max;
    return { i, ty, state: st, y, yaw, fx, fz, hx, hz, hp, max };
  });
  const state = (i) => H[i]?.state ?? "intact";
  // THE COLLAPSE's pieces: the chunks in flight (field ids), the heaps (soft cover)
  const flying = [], rubble = [];
  const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _ax = new THREE.Vector3();
  const later = [];   // [seconds left, fn] — on the game's clock (a paused game holds its collapse)
  const S = 1.3;      // (the kits' scale)
  const local = (h, lx, lz) => { const c = Math.cos(h.yaw), s = Math.sin(h.yaw); return [h.fx + lx * c + lz * s, h.fz - lx * s + lz * c]; };
  function collapse(h) {
    const R = Math.random;
    // the masonry thrown out of its walls: from a point along a wall at mid-height, outward and up, spinning
    const n = Math.round(P.chunks[0] + Math.min(1, (h.hx + h.hz) / 14) * (P.chunks[1] - P.chunks[0]));
    for (let k = 0; k < n; k++) {
      const side = Math.floor(R() * 4), along = R() * 2 - 1;
      const [lx, lz, nx, nz] = side === 0 ? [along * h.hx, -h.hz, 0, -1] : side === 1 ? [along * h.hx, h.hz, 0, 1] : side === 2 ? [-h.hx, along * h.hz, -1, 0] : [h.hx, along * h.hz, 1, 0];
      const [x, z] = local(h, lx, lz), c = Math.cos(h.yaw), s = Math.sin(h.yaw);
      const ox = nx * c + nz * s, oz = -nx * s + nz * c, sp = P.chunkSpeed[0] + R() * (P.chunkSpeed[1] - P.chunkSpeed[0]);
      const y = h.y + 1.5 + R() * 3, sc = S * (0.8 + R() * 0.6);
      const id = field.add(CHUNKS[Math.floor(R() * CHUNKS.length)], "intact", x, y, z, R() * 6.28, sc);
      if (id == null) return;
      flying.push({ id, p: new THREE.Vector3(x, y, z), v: new THREE.Vector3(ox * sp + (R() - 0.5), sp * (0.4 + R() * 0.6), oz * sp + (R() - 0.5)),
        q: new THREE.Quaternion().setFromEuler(_e.set(R() * 6, R() * 6, R() * 6)), w: new THREE.Vector3(R() - 0.5, R() - 0.5, R() - 0.5).normalize(), rate: 4 + R() * 8, sc, life: 0 });
    }
    // the HEAPS: slumped against two of its walls (a long one: the spill along it; an end: a wide or tall one)
    later.push([P.heapDelay, () => {
      const long = h.hx >= h.hz;
      const sides = [long ? (R() < 0.5 ? 0 : 1) : (R() < 0.5 ? 2 : 3), long ? (R() < 0.5 ? 2 : 3) : (R() < 0.5 ? 0 : 1)];
      sides.forEach((side, j) => {
        const kind = j === 0 ? "spill" : R() < 0.5 ? "wide" : "tall";
        const off = side < 2 ? h.hz : h.hx, sc = S * (P.heapScale[0] + R() * (P.heapScale[1] - P.heapScale[0]));
        const [lx, lz] = side === 0 ? [(R() - 0.5) * h.hx, -off - 0.6] : side === 1 ? [(R() - 0.5) * h.hx, off + 0.6] : side === 2 ? [-off - 0.6, (R() - 0.5) * h.hz] : [off + 0.6, (R() - 0.5) * h.hz];
        const [x, z] = local(h, lx, lz);
        // its long side along the wall it fell from (the heaps are built long along x)
        const yaw = h.yaw + (side < 2 ? 0 : Math.PI / 2) + (R() - 0.5) * 0.3;
        const gy = app.getWorldHeight?.(x, z) ?? h.y;
        field.add(kind, "intact", x, gy - 0.12, z, yaw, sc);
        rubble.push({ x, z, r: (kind === "spill" ? 2.4 : 1.8) * sc / S });
      });
      app.algDamage?.coverChanged?.();
    }]);
  }
  // the clock: the chunks fly, bounce and settle; the delayed swaps and heaps
  let last = performance.now();
  app.addPreRenderHook?.(() => {
    const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000) * (app.timeScale?.value ?? 1);
    last = now;
    if (!dt) return;
    for (let i = later.length - 1; i >= 0; i--) { later[i][0] -= dt; if (later[i][0] <= 0) { const f = later[i][1]; later.splice(i, 1); f(); } }
    for (let i = flying.length - 1; i >= 0; i--) {
      const f = flying[i];
      f.life += dt;
      f.v.y -= 9.8 * dt;
      f.p.addScaledVector(f.v, dt);
      f.q.premultiply(_q.setFromAxisAngle(_ax.copy(f.w), f.rate * dt));
      const gy = app.getWorldHeight?.(f.p.x, f.p.z) ?? 0;
      if (f.p.y <= gy + 0.04) {
        f.p.y = gy + 0.04;
        if (f.v.y < -1.2 && f.life < 3) { f.v.y *= -0.25; f.v.x *= 0.5; f.v.z *= 0.5; f.rate *= 0.4; }   // a bounce
        else { f.p.y = gy - 0.03; field.move(f.id, f.p, f.q, f.sc); flying.splice(i, 1); continue; }   // settled: it stays
      }
      field.move(f.id, f.p, f.q, f.sc);
    }
  });
  const inside = (h, x, z, r) => {
    const c = Math.cos(h.yaw), s = Math.sin(h.yaw), dx = x - h.fx, dz = z - h.fz;
    const lx = c * dx - s * dz, lz = s * dx + c * dz;
    return Math.abs(lx) <= h.hx + r && Math.abs(lz) <= h.hz + r;
  };
  function dust(h, big) {
    const fx = app.algCombat?.fx;
    fx?.explosion?.(h.fx, h.y + 1.5, h.fz, { size: big ? 18 + Math.min(10, h.hx) : 9, dust: true });
    if (big) {
      // the corners too: the whole house comes down
      const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
      for (const [a, b] of [[-1, -1], [1, 1], [1, -1]]) fx?.explosion?.(h.fx + a * h.hx * 0.7 * c + b * h.hz * 0.7 * s, h.y + 1, h.fz - a * h.hx * 0.7 * s + b * h.hz * 0.7 * c, { size: 11, dust: true });
      app.algAmbience?.smoulder(h.fx, h.y + 2, h.fz, 75, { strength: 0.9, r: 2.5 });
    }
  }
  function setState(h, st) {
    if (h.state === st) return;
    h.state = st;
    // (a collapse: the ruin model swapped in a moment later, under the dust — not before it)
    if (st === "ruin") later.push([P.swapDelay, () => field.setState(h.i, "ruin")]);
    else field.setState(h.i, st);
    const g = garrisons[h.i];
    if (st === "damaged") {
      dust(h, false);
      if (g) g.blastMul = P.blastMulDamaged;
    }
    if (st === "ruin") {
      dust(h, true);
      collapse(h);
      // the men inside out by the door, hurt, some killed
      if (g) {
        const G = app.algGarrison;
        [...g.men].forEach((u, k) => {
          G?.exit?.(u, k + 1);
          u.takeDamage?.(P.hurtOnCollapse[0] + Math.random() * (P.hurtOnCollapse[1] - P.hurtOnCollapse[0]));
        });
        g.cap = 0; g.ruined = true;
      }
      // no more stopping a shot or a look: its sight box down to the rubble
      app.algSight?.setBox?.(h.fx, h.fz, h.hx, h.hz, h.yaw, h.y + P.ruinTop);
      app.fogOfWar?.rebuildHeights?.();
      // (its nav footprint STAYS: the ruin keeps its broken shell walls — men walking across went through them)
    }
    app.algDamage?.coverChanged?.();
  }
  return {
    params: P, houses: H, state, rubble,
    /** A burst at (x, z) of combat-fx `size` (algDamage.blast). */
    blast(x, z, size) {
      if (size < P.minSize) return;
      for (const h of H) {
        if (h.state === "ruin" || !inside(h, x, z, P.reach + size * 0.08)) continue;
        h.hp -= P.per(size) * (0.8 + Math.random() * 0.4);
        if (h.hp <= 0) setState(h, "ruin");
        else if (h.hp < h.max * P.damagedAt) setState(h, "damaged");
      }
    },
    /** Dev / tests: take a house to a state. */
    force(i, st) { const h = H[i]; if (!h) return; h.hp = st === "ruin" ? 0 : st === "damaged" ? h.max * P.damagedAt * 0.9 : h.max; setState(h, st); },
  };
}
