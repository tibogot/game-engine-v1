// Bridge decks — what a unit stands on when it crosses a bridge.
//
// Units took their height from the TERRAIN (app.getWorldHeight), and under a
// bridge the terrain is the riverbed: a jeep driving across walked along the
// bottom of the river, through the bridge (your report, 2026-09-24). The nav
// grid already opens the deck (navGrid carveBridges); this gives it a height.
//
// At boot each bridge's deck is MEASURED, not assumed: rays straight down its
// centre line, one a metre, against the bridge's own meshes (the map's bridges
// are arched, so the deck is a curve, not a plane). A unit whose position falls
// inside a deck's rectangle stands on the higher of deck and ground.
//
// Cost: a boot-time raycast per metre of bridge; per query, a rectangle test
// per bridge (two on nam-valley) and one lerp. No per-frame raycasts.
//
// GETTING ON IT (your report 2026-09-26: "they go under and instantly snap on
// top"). MEASURED: a squad sent across at an angle walked the bank BESIDE the
// deck for 6 m — 3-4 m off its centre line, up to 2.6 m below it, under the
// arch — then stepped sideways into the deck band and jumped +2.1-2.7 m in one
// frame. The pathfinder's 4 m cells know nothing of decks: walkable bank next
// to a bridge is as good as the bridge. So, two rules:
//   • anchorPath: a path that CROSSES a deck is rewritten to go to the near
//     end, along the centre line, and out of the far end (navGrid pulls the
//     string between these anchors, never across them);
//   • sideWall: a deck has walls — nobody steps onto it, or off it, from the
//     side along its span (a shove can't drop a man into the river either).
import * as THREE from "three";
import { listBridges } from "./bridgeLandings.js";

/** Half the deck's usable width, metres (the deck is 5.5 m wide). */
const HALF_WIDTH = 2.9;
/** The last metres at each end where stepping on/off from the side is allowed. */
const END_ZONE = 1.5;
/**
 * Beside a deck a unit may stand at most STEP below it, and it may step on or
 * off from the side at most STEP_ON. STEP_ON > STEP, with room: equal, a man
 * standing exactly STEP below it (the boundary) could go neither on nor on
 * forward — stuck for good (measured, every run, same spot).
 */
const STEP = 0.5, STEP_ON = 0.65;
/** The anchors stand this far out past each end, on the landing. */
const END_OUT = 2.5;
/** Path cells this near a deck (past its ends / to its sides) are routed through it. */
const ZONE_END = 6, ZONE_SIDE = 10;

/**
 * Measure every bridge's deck. Returns { heightAt(x, z) -> deck Y or null, decks }.
 */
export function measureBridgeDecks(app) {
  const decks = [];
  const ps = app.propStore;
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const bridges = listBridges(app);
  let bi = 0;
  for (let i = 0; !app.namBridges && i < (ps?.instances?.length ?? 0); i++) {
    const type = ps.types?.[ps.instances[i].typeIdx];
    if (!type || !/bridge/i.test(type.name || "")) continue;
    const b = bridges[bi++];
    const obj = app.getLivePropObject?.(i) ?? null;
    if (!b || !obj) continue;
    obj.updateMatrixWorld(true);
    const meshes = [];
    obj.traverse((o) => { if (o.isMesh) meshes.push(o); });
    // One sample a metre along the span, from above the deck straight down.
    const n = Math.max(2, Math.ceil(b.half * 2));
    const ys = new Float32Array(n + 1);
    let found = 0;
    for (let k = 0; k <= n; k++) {
      const s = -b.half + (2 * b.half * k) / n;
      const x = b.x + b.ax * s, z = b.z + b.az * s;
      ray.set(new THREE.Vector3(x, b.y + 30, z), down);
      ray.far = 60;
      const hit = ray.intersectObjects(meshes, false)[0];
      // No hit (a gap between planks): take the neighbour's, filled below.
      ys[k] = hit ? hit.point.y : NaN;
      if (hit) found++;
    }
    if (!found) continue;
    // Fill any gaps from the nearest measured sample.
    for (let k = 0; k <= n; k++) {
      if (!Number.isNaN(ys[k])) continue;
      for (let d = 1; d <= n; d++) {
        const l = k - d >= 0 ? ys[k - d] : NaN, r = k + d <= n ? ys[k + d] : NaN;
        const v = !Number.isNaN(l) ? l : r;
        if (!Number.isNaN(v)) { ys[k] = v; break; }
      }
    }
    decks.push({ ...b, n, ys, hw: HALF_WIDTH });
  }
  // The PLANNED bridges (namBridges.js) know their own deck: no raycasts.
  if (app.namBridges) {
    decks.length = 0;
    for (const b of app.namBridges) {
      const n = Math.max(2, Math.ceil(b.half * 2));
      const ys = new Float32Array(n + 1);
      for (let k = 0; k <= n; k++) ys[k] = b.deckAt(-b.half + (2 * b.half * k) / n);
      decks.push({ ...b, n, ys, hw: b.halfWidth });
    }
  }

  /** Deck Y under (x, z), or null when (x, z) is not on a deck. */
  function heightAt(x, z) {
    for (const d of decks) {
      const rx = x - d.x, rz = z - d.z;
      const along = rx * d.ax + rz * d.az;
      if (Math.abs(along) > d.half) continue;
      const across = -rx * d.az + rz * d.ax;
      if (Math.abs(across) > d.hw) continue;
      const f = ((along + d.half) / (2 * d.half)) * d.n;
      const k = Math.min(d.n - 1, Math.floor(f));
      return d.ys[k] + (d.ys[k + 1] - d.ys[k]) * (f - k);
    }
    return null;
  }
  /** Where along / across deck d a point is. */
  const local = (d, x, z) => {
    const rx = x - d.x, rz = z - d.z;
    return { along: rx * d.ax + rz * d.az, across: -rx * d.az + rz * d.ax };
  };
  const onBand = (d, l) => Math.abs(l.along) <= d.half && Math.abs(l.across) <= d.hw;

  /**
   * True when a move from (ox, oz) to (nx, nz) goes through a deck's SIDE
   * where deck and ground are not level (onto it from below, off it into a
   * drop), or walks in beside it where the ground falls away under it.
   */
  function sideWall(ox, oz, nx, nz) {
    for (const d of decks) {
      const o = local(d, ox, oz), n = local(d, nx, nz);
      const onO = onBand(d, o), onN = onBand(d, n);
      if (onO !== onN) {
        // On or off over the edge: only where the deck and the ground beside
        // it are level — a step up from under it is the pop, a step off it
        // mid-span is a fall. (At the ends they meet, so that is where.)
        if (!app.getWorldHeight) { if (Math.abs((onN ? n : o).along) < d.half - END_ZONE) return true; continue; }
        // …except climbing BACK ON from beside it: nobody walks in there (below),
        // but the crowd's overlap push (forceNudge, which must always succeed)
        // can shove a man off a 1.6 m walkway, and he must not be stranded.
        if (onN && low(d, o, ox, oz)) continue;
        const from = onO ? deckY(d, o.along) : app.getWorldHeight(ox, oz);
        const to = onN ? deckY(d, n.along) : app.getWorldHeight(nx, nz);
        if (Math.abs(to - from) > STEP_ON) return true;
        continue;
      }
      // BESIDE the deck, where the ground falls away under it (the water, the
      // bank under the arch): nobody walks in. The nav corridor is whole 4 m
      // cells — far wider than a 1.6 m footbridge — and a man jostled off the
      // walkway at its end waded the river alongside it (measured 2026-09-26).
      // Walking OUT of there is allowed, so no one is ever trapped in it.
      // (By HEIGHT at both ends, not by place: men entered the strip at the
      // end, where the bank is level with the walkway, and walked on beside it
      // as the bank fell away under the arch.)
      if (!onN && app.getWorldHeight && low(d, n, nx, nz) && !low(d, o, ox, oz)) return true;
    }
    return false;
  }
  /**
   * The overlap push, kept ON a deck: a unit on a deck pushed toward its side
   * stops at the edge (the push along the deck is kept). The crowd's
   * forceNudge must always succeed, and on a 1.6 m walkway it was shoving men
   * into the river — who then climbed back on in a 2-4 m pop. Returns the
   * clamped point, or null when (ox, oz) is not on a deck's span.
   */
  function keepOnDeck(ox, oz, nx, nz) {
    for (const d of decks) {
      const o = local(d, ox, oz);
      if (!onBand(d, o) || Math.abs(o.along) >= d.half - END_ZONE) continue;
      const n = local(d, nx, nz);
      if (Math.abs(n.across) <= d.hw) return null;
      const c = Math.sign(n.across) * d.hw * 0.98;
      return { x: d.x + d.ax * n.along - d.az * c, z: d.z + d.az * n.along + d.ax * c };
    }
    return null;
  }
  const BESIDE = 3;
  /**
   * Beside the deck and more than a STEP under it. The SAME step as getting on:
   * with 0.7 here and 0.5 there, men stood beside the walkway 0.6 m below it —
   * allowed to be there, not allowed up, stuck for good (measured).
   */
  function low(d, l, x, z) {
    return inBeside(d, l) && app.getWorldHeight(x, z) < deckY(d, l.along) - STEP;
  }
  function inBeside(d, l) {
    return Math.abs(l.along) < d.half - END_ZONE && Math.abs(l.across) > d.hw && Math.abs(l.across) < d.hw + BESIDE;
  }
  function deckY(d, along) {
    const f = Math.max(0, Math.min(d.n, ((along + d.half) / (2 * d.half)) * d.n));
    const k = Math.min(d.n - 1, Math.floor(f));
    return d.ys[k] + (d.ys[k + 1] - d.ys[k]) * (f - k);
  }

  /**
   * navGrid's path-anchor hook: `pts` are the path's cell centres. A run of
   * them near a deck that goes from one end's side to the other becomes two
   * anchors — the entry end, the exit end — on the centre line.
   */
  function anchorPath(pts, sx, sz, tx, tz) {
    let out = pts;
    for (const d of decks) {
      const zone = (p) => { const l = local(d, p.x, p.z); return Math.abs(l.along) <= d.half + ZONE_END && Math.abs(l.across) <= ZONE_SIDE; };
      const i = out.findIndex(zone);
      if (i < 0) continue;
      let j = i;
      while (j + 1 < out.length && zone(out[j + 1])) j++;
      const sA = local(d, sx, sz), tA = local(d, tx, tz);
      const before = i > 0 ? local(d, out[i - 1].x, out[i - 1].z) : sA;
      const after = j + 1 < out.length ? local(d, out[j + 1].x, out[j + 1].z) : tA;
      const inSign = Math.sign(before.along) || -1, outSign = Math.sign(after.along) || 1;
      if (inSign === outSign) continue;              // skirts the bridge, doesn't cross it
      const end = (s) => ({ x: d.x + d.ax * s * (d.half + END_OUT), z: d.z + d.az * s * (d.half + END_OUT), anchor: true });
      const mid = [];
      if (!onBand(d, sA)) mid.push(end(inSign));      // already on the deck: no turning back
      if (!onBand(d, tA)) mid.push(end(outSign));     // the click was ON the deck: stop there
      out = [...out.slice(0, i), ...mid, ...out.slice(j + 1)];
    }
    return out;
  }

  /**
   * Near a deck (its span and the landings past each end): a sideways pull
   * toward its centre line, growing with the distance off it; else null.
   */
  function lanePull(x, z) {
    for (const d of decks) {
      const l = local(d, x, z);
      if (Math.abs(l.along) > d.half + END_OUT + 2 || Math.abs(l.across) > d.hw + 3) continue;
      const k = -Math.max(-1, Math.min(1, l.across / d.hw)) * 0.8;
      return { x: -d.az * k, z: d.ax * k };
    }
    return null;
  }

  return { decks, heightAt, sideWall, anchorPath, lanePull, keepOnDeck };
}
