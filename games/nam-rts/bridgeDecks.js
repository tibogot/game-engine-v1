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
import * as THREE from "three";
import { listBridges } from "./bridgeLandings.js";

/** Half the deck's usable width, metres (the deck is 5.5 m wide). */
const HALF_WIDTH = 2.9;

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
  for (let i = 0; i < (ps?.instances?.length ?? 0); i++) {
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
    decks.push({ ...b, n, ys });
  }

  /** Deck Y under (x, z), or null when (x, z) is not on a deck. */
  function heightAt(x, z) {
    for (const d of decks) {
      const rx = x - d.x, rz = z - d.z;
      const along = rx * d.ax + rz * d.az;
      if (Math.abs(along) > d.half) continue;
      const across = -rx * d.az + rz * d.ax;
      if (Math.abs(across) > HALF_WIDTH) continue;
      const f = ((along + d.half) / (2 * d.half)) * d.n;
      const k = Math.min(d.n - 1, Math.floor(f));
      return d.ys[k] + (d.ys[k + 1] - d.ys[k]) * (f - k);
    }
    return null;
  }
  return { decks, heightAt };
}
