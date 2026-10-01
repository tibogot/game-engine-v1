// THE LAND BETWEEN THE VILLAGES (you, 2026-10-01: "fill the terrain, CoH
// style"): places worth holding in the empty middle of the map, rock
// outcrops to hide behind, lone trees to steer by.
//
//   FARMSTEADS + RUINS   showroom entries (showroom.js places, pads, seats,
//            stamps the nav grid, lists the cover and the trees for them):
//            rtsAlgVillage.js buildFarmstead / buildRomanRuin / buildBurntFarm,
//            each ONE merged piece built on the real ground — one draw each.
//            Placed by a seeded search: between the villages (90 m+ from any
//            site), 12-70 m off a track (a farm lies by a path), on gentle
//            ground, 140 m apart.
//   OUTCROPS + LONE TREES  createAlgLandmarks (after the showroom): instanced
//            crags (a few shapes, one draw each), hard cover; single olives,
//            carobs (holm oak) and figs on the showroom's PlacedFoliage.
//
// ?landmarks=0 = without.
import { LAYOUT, PLAY, VIEW_YAW } from "./layout.js";
import { TRACK_LINES } from "./algTracks.js";
import * as THREE from "three";
import { buildBurntFarm, buildFarmstead, buildRomanRuin } from "../../v3/render/objects/rtsAlgVillage.js";
import { buildRockOutcrop } from "../../v3/render/objects/rtsAlgeria.js";
import { FOLIAGE_PRESETS } from "../../v3/app/state/foliageScatterState.js";
import { kitView } from "./showroom.js";

const P = {
  farmsteads: 7, roman: 2, burnt: 1,
  // 3 of 10 placed with 90 m from EVERY site (the passes, springs and
  // lookouts are sites too): villages and bases 70 m, the rest 25 m.
  siteClear: 70, minorClear: 25,
  pieceClear: 32,         // m from any other showroom piece
  spacing: 115,           // between landmarks
  track: [12, 95],        // a farmstead's distance from the nearest track
  maxRelief: 4.5,         // m over its footprint (the socles take up the rest)
  tries: 4000,
};

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

/** Showroom entries for the farmsteads and ruins (call with the map loaded). */
export function landmarkEntries(app, list) {
  const R = rng(1962);
  const H = (x, z) => app.getWorldHeight(x, z);
  const trackPts = TRACK_LINES.flatMap((t) => t.line);
  const trackDist = (x, z) => { let d = Infinity; for (const p of trackPts) d = Math.min(d, Math.hypot(p.x - x, p.z - z)); return d; };
  const placed = [];
  const ok = (x, z, needTrack) => {
    if (!(x > PLAY.x0 + 30 && x < PLAY.x1 - 30 && z > PLAY.z0 + 30 && z < PLAY.z1 - 30)) return false;
    for (const s of LAYOUT.sites) {
      const big = ["hamlet", "dechra", "ksar", "french", "aln"].includes(s.kind);
      if (Math.hypot(s.x - x, s.z - z) < (s.r ?? 20) + (big ? P.siteClear : P.minorClear)) return false;
    }
    for (const e of list) if (Math.hypot(e.x - x, e.z - z) < P.pieceClear) return false;
    for (const p of placed) if (Math.hypot(p.x - x, p.z - z) < P.spacing) return false;
    const td = trackDist(x, z);
    if (td < P.track[0] || (needTrack && td > P.track[1])) return false;
    let lo = Infinity, hi = -Infinity;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const px = x + i * 6, pz = z + j * 5, h = H(px, pz);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
      if ((app.getWaterLevelAt?.(px, pz) ?? -Infinity) > h - 0.3) return false;
      const w = app.samplePaintWeights?.(px, pz);
      if (w && (w[4] > 0.3 || w[5] > 0.25 || w[3] > 0.4)) return false;     // wadi, cliff, oasis grove
    }
    return hi - lo <= P.maxRelief;
  };
  // The ruins FIRST: placed after the farmsteads they found no room (one of 3).
  const want = [
    ...Array.from({ length: P.roman }, (_, i) => ({ key: `romanRuin${i + 1}`, build: (o) => buildRomanRuin({ ...o, seed: 1980 + i * 5 }), track: false })),
    ...Array.from({ length: P.burnt }, (_, i) => ({ key: `burntFarm${i + 1}`, build: (o) => buildBurntFarm({ ...o, seed: 1990 + i }), track: true })),
    ...Array.from({ length: P.farmsteads }, (_, i) => ({ key: `mechtaFarm${i + 1}`, build: (o) => buildFarmstead({ ...o, seed: 1970 + i * 7 }), track: true })),
  ];
  const out = [];
  for (const w of want) {
    for (let t = 0; t < P.tries; t++) {
      const x = PLAY.x0 + R() * (PLAY.x1 - PLAY.x0), z = PLAY.z0 + R() * (PLAY.z1 - PLAY.z0);
      if (!ok(x, z, w.track)) continue;
      // Fronts toward the player's camera, three-quarters (your rule).
      const e = { key: w.key, build: w.build, x, z, yaw: VIEW_YAW + (R() < 0.5 ? 0.5 : -0.5) + (R() - 0.5) * 0.3, ground: true };
      placed.push(e);
      out.push(e);
      break;
    }
  }
  return out;
}

const Q = {
  outcrops: 42, outcropSpacing: 34, outcropSlope: [9, 32],   // degrees
  trees: 24, treeSpacing: 55,
  clear: 8,               // m from tracks, fields, pieces
};

/**
 * The rock outcrops (instanced, hard cover, impassable) and the lone trees
 * (the showroom's PlacedFoliage). Call after the showroom and the fields.
 */
export function createAlgLandmarks(app, { showroom = {}, fields = null, navGrid = null, plants = null }) {
  const R = rng(2000);
  const H = (x, z) => app.getWorldHeight(x, z);
  const trackPts = TRACK_LINES.flatMap((t) => t.line);
  const nearTrack = (x, z, r) => trackPts.some((p) => Math.abs(p.x - x) < r && Math.abs(p.z - z) < r && Math.hypot(p.x - x, p.z - z) < r);
  // Everything already standing, as circles (cheap and good enough here).
  const taken = [];
  for (const m of Object.values(showroom)) {
    const fp = m?.isObject3D ? m.geometry?.userData?.footprint : null;
    if (fp && m.parent) taken.push({ x: m.position.x, z: m.position.z, r: Math.hypot(fp.hx, fp.hz) });
  }
  for (const b of fields?.plots ?? []) taken.push({ x: b.x, z: b.z, r: Math.hypot(b.hx, b.hz) });
  for (const s of LAYOUT.sites) taken.push({ x: s.x, z: s.z, r: (s.r ?? 20) + 6 });
  const free = (x, z, r) => {
    if (!(x > PLAY.x0 + 6 && x < PLAY.x1 - 6 && z > PLAY.z0 + 6 && z < PLAY.z1 - 6)) return false;
    if (taken.some((t) => Math.hypot(t.x - x, t.z - z) < t.r + r)) return false;
    if (nearTrack(x, z, Q.clear + r)) return false;
    if ((app.getWaterLevelAt?.(x, z) ?? -Infinity) > H(x, z) - 0.3) return false;
    return !navGrid?.isBlockedAtWorld?.(x, z);
  };
  const slopeDeg = (x, z) => Math.acos(Math.min(1, app.getWorldNormal?.(x, z)?.y ?? 1)) * (180 / Math.PI);

  // ── Outcrops ─────────────────────────────────────────────────────────────
  const variants = [2000, 2001, 2002, 2003].map((seed) => buildRockOutcrop({ seed }));
  const lists = variants.map(() => []);
  const rocks = [];
  for (let t = 0; t < 6000 && rocks.length < Q.outcrops; t++) {
    const x = PLAY.x0 + R() * (PLAY.x1 - PLAY.x0), z = PLAY.z0 + R() * (PLAY.z1 - PLAY.z0);
    const s = slopeDeg(x, z);
    if (s < Q.outcropSlope[0] || s > Q.outcropSlope[1]) continue;
    if (!free(x, z, 4)) continue;
    if (rocks.some((r) => Math.hypot(r.x - x, r.z - z) < Q.outcropSpacing)) continue;
    const k = 0.8 + R() * 0.6;
    rocks.push({ x, z, k, v: Math.floor(R() * variants.length), yaw: R() * Math.PI * 2 });
    taken.push({ x, z, r: 4 * k });
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  for (const r of rocks) {
    lists[r.v].push(m4.compose(new THREE.Vector3(r.x, H(r.x, r.z) - 0.15, r.z), q.setFromAxisAngle(up, r.yaw), new THREE.Vector3(r.k, r.k * (0.85 + R() * 0.3), r.k)).clone());
    navGrid?.addFootprint?.(r.x, r.z, 1.6 * r.k, 1.6 * r.k, r.yaw);
    app.clearVegetation?.(r.x, r.z, 3 * r.k, { grass: 0, edge: 0.6 });
  }
  const meshes = variants.map((geo, i) => {
    const mesh = new THREE.InstancedMesh(geo, kitView(geo).material, Math.max(1, lists[i].length));
    lists[i].forEach((mm, j) => mesh.setMatrixAt(j, mm));
    mesh.count = lists[i].length;
    mesh.name = `Outcrops${i}`;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    app.scene.add(mesh);
    return mesh;
  });

  // ── Lone trees: by the tracks and on the open ground ──────────────────────
  const kinds = [["olive", 0.5], ["holmOak", 0.3], ["fig", 0.2]];
  const trees = [];
  for (let t = 0; t < 6000 && trees.length < Q.trees; t++) {
    let x, z;
    if (R() < 0.6) {
      // Beside a track, 6-11 m off it.
      const p = trackPts[Math.floor(R() * trackPts.length)], a = R() * Math.PI * 2, d = 6 + R() * 5;
      x = p.x + Math.cos(a) * d; z = p.z + Math.sin(a) * d;
    } else { x = PLAY.x0 + R() * (PLAY.x1 - PLAY.x0); z = PLAY.z0 + R() * (PLAY.z1 - PLAY.z0); }
    if (slopeDeg(x, z) > 20) continue;
    if (taken.some((tk) => Math.hypot(tk.x - x, tk.z - z) < tk.r + 3)) continue;
    if (!(x > PLAY.x0 + 6 && x < PLAY.x1 - 6 && z > PLAY.z0 + 6 && z < PLAY.z1 - 6)) continue;
    if ((app.getWaterLevelAt?.(x, z) ?? -Infinity) > H(x, z) - 0.3 || navGrid?.isBlockedAtWorld?.(x, z)) continue;
    if (nearTrack(x, z, 5)) continue;
    if (trees.some((tr) => Math.hypot(tr.x - x, tr.z - z) < Q.treeSpacing)) continue;
    let u = R(), kind = kinds[0][0];
    for (const [kk, p] of kinds) { if ((u -= p) <= 0) { kind = kk; break; } }
    trees.push({ x, z, kind });
  }
  if (plants) {
    for (const tr of trees) {
      if (!plants.types.has(tr.kind)) plants.setType(tr.kind, structuredClone(FOLIAGE_PRESETS[tr.kind]));
      // Old, big trees: a landmark is the biggest thing for 50 m round.
      plants.add(tr.kind, tr.x, H(tr.x, tr.z) - 0.05, tr.z, { rotY: R() * 6.28, scale: 1.15 + R() * 0.4, seed: R() });
      app.clearVegetation?.(tr.x, tr.z, 3, { grass: 0, edge: 0.6 });
    }
  }

  return {
    rocks, trees, meshes,
    /** Hard cover round the outcrops, for the cover bake (algCover.js). */
    *coverCircles() { for (const r of rocks) yield { x: r.x, z: r.z, radius: 2.4 * r.k, size: 1, hard: true }; },
    stats: { outcrops: rocks.length, trees: trees.length },
  };
}
