/**
 * SHARED MACHINERY (games/shared-rts, moved from nam 2026-09-28): each game
 * passes its own numbers (`params`: nam's are tuned to its jungle, Sand &
 * Blood's to the Aurès scrub) and any obstacles of its own (`extra`).
 *
 * COVER AND CONCEALMENT — the two different things "being hidden" means.
 *
 * They are constantly confused and they are not the same rule:
 *
 *   CONCEALMENT stops you being SEEN. Jungle, elephant grass, smoke. It does
 *     not stop a bullet — foliage has never stopped anything — so it changes
 *     ACQUISITION, not damage.
 *   COVER stops you being HURT. Sandbags, a rock, a wall, a bank of earth. It
 *     does not hide you; you can be perfectly visible behind a sandbag wall and
 *     still be hard to kill.
 *
 * Keeping them apart is what makes the map tactical rather than a single
 * "hidden" stat. Jungle is where you move unseen and die fast; an emplacement
 * is where you are obvious and survive. A player who learns that has learned
 * the map.
 *
 * ── WHAT MAKES CONCEALMENT A MECHANIC RATHER THAN A BUFF ────────────────────
 *
 * Firing breaks it. A unit that shoots is spotted for a few seconds however
 * deep in the jungle it is lying. Without that rule concealment is a passive
 * damage-avoidance stat and the correct play is to sit in a bush forever; with
 * it, concealment is an AMBUSH — worth something once, at a moment you choose.
 *
 * ── WHERE THE NUMBERS COME FROM ─────────────────────────────────────────────
 *
 * Concealment reads the engine's painted vegetation directly through
 * app.sampleFoliageDensity / sampleTallPlantDensity. It is not a second map
 * maintained alongside the art: the jungle you can SEE is the jungle that
 * hides you, and painting more jungle in the editor changes the tactics with
 * no further step. That is the whole reason those accessors were added.
 *
 * Cover is baked ONCE into a coarse grid at load, from the props that were
 * already placed — rocks, sandbag emplacements, huts. Baked rather than
 * queried because props do not move, and a per-shot search through 1,300 rocks
 * is the one thing this must not be.
 *
 * ── SAMPLED, NOT RAY-MARCHED ────────────────────────────────────────────────
 *
 * Cover is read at the TARGET, along the last few metres of the incoming line,
 * not integrated across the whole shot. A rock halfway between two units
 * protects neither of them; the one you are standing behind protects you. This
 * is also why it is three samples and not a march.
 */

import * as THREE from "three";

/** Grid resolution. 4 m cells, matching navGrid, so both read the same world. */
const CELL = 4;

export const COVER = {
  /** Concealment: how much of the acquire range dense jungle takes away. */
  maxConcealment: 0.62,
  /**
   * Vegetation density below this hides nobody.
   *
   * SET FROM THE HISTOGRAM of nam-valley's walkable ground, not guessed. That
   * distribution is strongly bimodal — 33% of it under 0.1 (roads, riverbank,
   * beach, clearings) and 47% over 0.6 (jungle), with a thin 13% between — so
   * the floor belongs in the valley, and 0.45 puts it there. The first guess
   * of 0.25 sat inside the lower mode and gave 61% of the map some
   * concealment, which reads as a global accuracy debuff rather than as
   * terrain worth crossing a map for.
   *
   * What it buys at 0.45: open ground conceals nobody, ordinary jungle (0.72,
   * the 75th percentile) takes 30% off the range you are seen at, and the
   * thickest of it takes the full 62%.
   */
  concealFloor: 0.45,
  /**
   * Vegetation density at which concealment is full. 1 for nam's jungle,
   * which runs the whole range; a sparse map (the Aurès' scrub tops out near
   * 0.6) sets it lower, or its thickest cover would barely hide anyone.
   */
  concealCeil: 1,
  /** Seconds a unit stays spotted after firing. */
  revealTime: 4.0,
  /** How close you can get before concealment stops working at all, metres. */
  pointBlank: 9,

  /** Cover: the most damage a perfect piece of hard cover can take off. */
  maxCover: 0.55,
  /** The same for HARD cover — a bunker's logs and earth, not a rock or bags. */
  maxHardCover: 0.8,
  /** How far behind a prop still counts as using it, metres. */
  coverReach: 4.0,
  /** Props smaller than this are debris, not cover. */
  minPropRadius: 0.9,
  /**
   * TERRAIN COVER (0 = off, nam's): the damage a bank of earth takes off when
   * the ground a few metres toward the shooter rises into the line of fire —
   * a wadi's bank, a crest, a terrace's riser. Directional like the rest: the
   * bank protects you from the men beyond it, not from the ones beside you.
   */
  terrainCover: 0,
};

/**
 * @param {object} o
 *   app       the engine handle (sampleFoliageDensity, props)
 *   worldSize terrain edge in metres
 *   params    COVER overrides
 *   extra     a generator of the game's own hard/soft cover circles
 *   concealExtra (x, z) → 0..1: concealment that is not painted vegetation
 *             (alg-rts's ambush screens), read as a vegetation density
 */
export function createCover({ app, worldSize = 2048, params = COVER, extra = null, concealExtra = null } = {}) {
  const n = Math.max(2, Math.round(worldSize / CELL));
  const half = worldSize * 0.5;
  /** 0..255 per cell — how much hard cover stands in it. */
  const coverGrid = new Uint8Array(n * n);
  /** 0..255 per cell — the part of that cover that is HARD (bunkers). */
  const hardGrid = new Uint8Array(n * n);
  /** 0..255 per cell — terrain cover (a bank beside it), params.terrainCover only. */
  const bankGrid = new Uint8Array(n * n);

  /**
   * The same two numbers as a texture, for the ground overlay to read.
   *
   *   R = hard cover      G = concealment
   *
   * CONCEALMENT IS BAKED HERE even though concealmentAt() samples it live,
   * and the difference matters: the live sample is the authority, this is a
   * snapshot for drawing. They agree because painted vegetation does not
   * change while the match runs — the day something burns it away (napalm's
   * burnedAt is the obvious candidate) this has to be rebaked with it, or the
   * overlay will promise cover in a field of ash.
   */
  const overlayData = new Uint8Array(n * n * 4);
  const overlayTex = new THREE.DataTexture(overlayData, n, n, THREE.RGBAFormat);
  overlayTex.wrapS = overlayTex.wrapT = THREE.ClampToEdgeWrapping;
  overlayTex.minFilter = overlayTex.magFilter = THREE.LinearFilter;
  overlayTex.needsUpdate = true;

  const toCell = (v) => {
    const c = Math.floor((v + half) / CELL);
    return c < 0 ? 0 : c >= n ? n - 1 : c;
  };

  /**
   * Everything static that a unit could shelter behind, as {x, z, radius}.
   *
   * The SAME props navGrid stamps as obstacles, read the same way, and that
   * is the point: a thing you cannot walk through is a thing you can hide
   * behind. If the two lists ever diverge, a player will find the rock that
   * blocks movement but stops no bullets and will be right to call it a bug.
   *
   * Trees are deliberately NOT here. A tree trunk is cover and a tree canopy
   * is concealment, and the tree store knows only a position and a scale, so
   * including them would credit a unit standing under a canopy with hard cover
   * it is not actually behind.
   */
  function* staticObstacles() {
    const ps = app.propStore;
    for (const inst of ps?.instances ?? []) {
      const type = ps.types?.[inst.typeIdx];
      if (!type || type.live) continue;
      const box = type.mergedBox;
      if (!box) continue;
      const sx = box.max.x - box.min.x, sz = box.max.z - box.min.z;
      const radius = 0.5 * Math.max(sx, sz) * Math.max(inst.sx ?? 1, inst.sz ?? 1);
      yield { x: inst.px, z: inst.pz, radius };
    }
    // Placed camp pieces (placedObjects.js): each footprint as a row of circles
    // — the same pieces the nav grid blocks.
    for (const p of app.placed?.coverCircles?.() ?? []) yield p;
    // Buildings and the boot structures: a sandbag emplacement is the best
    // cover on the map and would otherwise be missed entirely.
    // A building can say what it stamps (buildings.js coverCirclesFor): a
    // sandbag wall as a row of circles, a bunker as one HARD one.
    for (const b of [...(app.buildings?.list ?? []), ...(app.structures?.list ?? [])]) {
      if (!b.alive || b.constructing) continue;
      if (b.coverCircles) { for (const c of b.coverCircles) yield c; continue; }
      yield { x: b.position.x, z: b.position.z, radius: b.radius ?? 0 };
    }
    // The game's own: {x, z, radius, size?, hard?} (Sand & Blood: its placed
    // buildings, walls and emplacements as rows of circles).
    if (extra) yield* extra();
  }

  /**
   * Stamp every static prop into the cover grid.
   *
   * A separate call rather than constructor work because on nam-valley the
   * rocks are placed AFTER the level loads — baking in the constructor would
   * produce an empty grid and no error, which is the worst of both.
   */
  let banksDone = false;
  /** Stamp one obstacle {x, z, radius, size?, hard?}; its cell box [c0, c1, r0, r1], or null. */
  function stampProp(p) {
    const r = p.radius;
    if (r < params.minPropRadius) return null;
    // A prop gives cover in a ring AROUND it, not inside it — you cannot
    // stand in the middle of a boulder. The band is the prop's own footprint
    // plus coverReach, and the value falls off across it.
    const reach = r + params.coverReach;
    const c0 = toCell(p.x - reach), c1 = toCell(p.x + reach);
    const r0 = toCell(p.z - reach), r1 = toCell(p.z + reach);
    for (let cz = r0; cz <= r1; cz++) {
      for (let cx = c0; cx <= c1; cx++) {
        const wx = (cx * CELL) - half + CELL * 0.5;
        const wz = (cz * CELL) - half + CELL * 0.5;
        // Distance to the nearest point of the CELL, not to its centre. With
        // 4 m cells and a 4 m band, a centre test drops cells the band runs
        // straight through — a unit standing four metres from a boulder got
        // no cover at all because the centre of its cell happened to land
        // 0.3 m outside. Cover has to be conservative at this resolution.
        const ex = Math.max(0, Math.abs(wx - p.x) - CELL * 0.5);
        const ez = Math.max(0, Math.abs(wz - p.z) - CELL * 0.5);
        const d = Math.hypot(ex, ez);
        if (d > reach) continue;
        // Full value at the prop's edge, nothing at the far end of the reach.
        const t = d <= r ? 1 : 1 - (d - r) / params.coverReach;
        // Bigger props are better cover, saturating: a 3 m boulder is not
        // three times the protection of a 1 m one, it is just enough.
        // A built piece says its own size (a sandbag wall is thin but it
        // is exactly what cover is for).
        const size = p.size ?? Math.min(1, r / 2.5);
        const v = Math.round(255 * t * (0.45 + 0.55 * size));
        const i = cz * n + cx;
        if (v > coverGrid[i]) coverGrid[i] = v;
        if (p.hard && v > hardGrid[i]) hardGrid[i] = v;
      }
    }
    return [c0, c1, r0, r1];
  }
  /** The cover overlay's texels over a cell box (the concealment read is the costly part). */
  function refreshOverlay(c0, c1, r0, r1) {
    for (let cz = Math.max(0, r0); cz <= Math.min(n - 1, r1); cz++) {
      for (let cx = Math.max(0, c0); cx <= Math.min(n - 1, c1); cx++) {
        const i = cz * n + cx;
        const wx = (cx * CELL) - half + CELL * 0.5;
        const wz = (cz * CELL) - half + CELL * 0.5;
        overlayData[i * 4] = Math.max(coverGrid[i], bankGrid[i]);
        overlayData[i * 4 + 1] = Math.round(255 * concealmentAt(wx, wz) / params.maxConcealment);
        overlayData[i * 4 + 3] = 255;
      }
    }
    overlayTex.needsUpdate = true;
  }
  function bake() {
    coverGrid.fill(0);
    hardGrid.fill(0);
    let stamped = 0;
    for (const p of staticObstacles()) if (stampProp(p)) stamped++;

    // Terrain cover, for the overlay and coverAt() (the per-shot rule is
    // terrainBetween): a cell with a BANK beside it — ground 1.2 m or more
    // above it within 4 m that then STOPS rising (8 m out no higher than half
    // as much again): a wadi's bank, a crest, a riser. A plain hillside rises
    // on and on and is not a bank. Not directional here (a snapshot); the
    // shot decides which side it covers.
    // The ground does not change in a game: the banks are found ONCE (a re-bake for a new wall
    // or wreck redid them every time — most of a 118 ms bake, measured alg-rts 2026-10-06).
    if (!banksDone && params.terrainCover > 0 && app.getWorldHeight) {
      banksDone = true;
      bankGrid.fill(0);
      const H = app.getWorldHeight;
      for (let cz = 0; cz < n; cz++) {
        for (let cx = 0; cx < n; cx++) {
          const wx = (cx * CELL) - half + CELL * 0.5, wz = (cz * CELL) - half + CELL * 0.5;
          const h = H(wx, wz);
          let rise = 0;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) {
            const r4 = H(wx + dx * 4, wz + dz * 4) - h, r8 = H(wx + dx * 8, wz + dz * 8) - h - r4;
            if (r8 < 0.5 * r4) rise = Math.max(rise, r4);
          }
          const t = Math.min(1, Math.max(0, (rise - 1.2) / 1.0));
          bankGrid[cz * n + cx] = Math.round(255 * t * (params.terrainCover / params.maxCover));
        }
      }
    }
    refreshOverlay(0, n - 1, 0, n - 1);
    return stamped;
  }
  /**
   * ADD cover without a re-bake (alg-rts's vehicle wrecks): only these circles are stamped and
   * only their cells' overlay refreshed — a whole bake is ~60 ms of hitch mid-fight (measured
   * 2026-10-06). Removing cover still needs bake().
   */
  function addCover(list) {
    for (const p of list) { const b = stampProp(p); if (b) refreshOverlay(...b); }
  }

  /** Cover standing at a world point, 0..1 (a bank counts, when terrain cover is on). */
  function coverAt(x, z) {
    const i = toCell(z) * n + toCell(x);
    return Math.max(coverGrid[i], bankGrid[i]) / 255;
  }

  /**
   * How much damage the target's surroundings take off a shot from `from`.
   *
   * Sampled along the few metres BETWEEN the target and the shooter — the side
   * the fire is coming from, which is where the thing you are sheltering
   * behind is standing. Two mistakes are easy here and both were made first:
   *
   *   Stepping the other way samples the ground behind the target, so a wall
   *   protects you from everyone EXCEPT the people it is between you and — and
   *   cover stops being directional at all, which is the only interesting
   *   thing about it.
   *
   *   Including the target's OWN cell credits a unit standing in the open
   *   beside a rock with cover from every direction at once, for the same
   *   reason. The samples start a stride out and never look at your feet.
   */
  function coverBetween(fromX, fromZ, tx, tz) {
    const dx = tx - fromX, dz = tz - fromZ;
    const m = Math.hypot(dx, dz);
    if (m < 1e-3) return 0;
    // Toward the shooter.
    const ux = -dx / m, uz = -dz / m;
    // The best of three wins: you are either behind something or you are not,
    // and an average would dilute real cover with the open ground beside it.
    // Hard cover (a bunker) counts on its own, higher, scale: the best of the
    // two wins.
    let best = 0;
    for (const s of [1.2, 2.8, 4.4]) {
      const x = tx + ux * s, z = tz + uz * s;
      const i = toCell(z) * n + toCell(x);
      const v = Math.max((coverGrid[i] / 255) * params.maxCover, (hardGrid[i] / 255) * params.maxHardCover);
      if (v > best) best = v;
    }
    if (params.terrainCover > 0) best = Math.max(best, terrainBetween(fromX, fromZ, tx, tz, ux, uz, m));
    return best;
  }
  /**
   * The bank between: the line from the shooter's eye (1.6 m) to the target's
   * chest (1.0 m), and the ground under it at strides out to 10 m toward
   * the shooter. Ground reaching the line is in the way: full terrain cover
   * at 0.25 m above it, fading to none 0.25 m below. A shooter up on the
   * crest looks DOWN over the bank, and the line clears it — height is what
   * beats a bank, as it should. (First: fading from 0.4 m below the line —
   * every hummock counted.)
   */
  function terrainBetween(fromX, fromZ, tx, tz, ux, uz, m) {
    const H = app.getWorldHeight;
    if (!H) return 0;
    const ht = H(tx, tz) + 1.0, hs = H(fromX, fromZ) + 1.6;
    let best = 0;
    // Out to 10 m, not the walls' 4.4: a man in the middle of a 12 m wadi
    // bed has the bank 6 m away, and it covers him (measured 0 at 4.4).
    for (const s of [1.2, 2.8, 4.4, 6.5, 8.5, 10.5]) {
      if (s >= m - 2) break;
      const g = H(tx + ux * s, tz + uz * s);
      const line = ht + (hs - ht) * (s / m);
      const t = Math.min(1, Math.max(0, (g - line + 0.25) / 0.5));
      if (t > best) best = t;
    }
    return best * params.terrainCover;
  }

  /**
   * How concealed a unit standing at (x, z) is, 0..1.
   *
   * Straight off the painted vegetation, with a floor: scattered ferns hide
   * nobody, and without the floor every patch of ground on a jungle map would
   * grant some concealment and the mechanic would read as a global accuracy
   * debuff rather than as terrain worth seeking out.
   */
  function concealmentAt(x, z) {
    const veg = Math.max(
      app.sampleFoliageDensity?.(x, z) ?? 0,
      app.sampleTallPlantDensity?.(x, z) ?? 0,
      concealExtra?.(x, z) ?? 0,
    );
    if (veg <= params.concealFloor) return 0;
    const ceil = params.concealCeil ?? 1;
    const t = Math.min(1, (veg - params.concealFloor) / Math.max(1e-3, ceil - params.concealFloor));
    return t * params.maxConcealment;
  }

  /**
   * The rule combat asks: how far can `seer` pick `target` up?
   *
   * Returns a MULTIPLIER on acquire range. Concealment is beaten by proximity
   * — you cannot hide in a bush from someone standing in it — and it is beaten
   * entirely by having just fired.
   */
  function acquireRangeScale(seerX, seerZ, target) {
    if (target.revealed > 0) return 1;
    const c = concealmentAt(target.position.x, target.position.z);
    if (c <= 0) return 1;
    const d = Math.hypot(target.position.x - seerX, target.position.z - seerZ);
    if (d <= params.pointBlank) return 1;
    return 1 - c;
  }

  /** A unit that fires gives itself away, however deep it is lying. */
  function reveal(e) { e.revealed = params.revealTime; }

  /** FIXED-STEP: run the reveal timers down. */
  function step(dt, entities) {
    for (const e of entities) {
      if (e.revealed > 0) e.revealed = Math.max(0, e.revealed - dt);
    }
  }

  return {
    params, bake, addCover, step, reveal,
    /** R = cover, G = concealment, both 0..1 over the whole world. */
    overlayTex,
    get gridSize() { return n; },
    concealmentAt, coverAt, coverBetween, acquireRangeScale,
    /** For the HUD and for tests. */
    describeAt(x, z) {
      return { concealment: concealmentAt(x, z), cover: coverAt(x, z) };
    },
    get cellSize() { return CELL; },
    get grid() { return coverGrid; },
  };
}
