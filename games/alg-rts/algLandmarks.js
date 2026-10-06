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
import { buildBurntFarm, buildFarmstead, buildRomanRuin, buildRuinedHut, buildTerraces } from "../../v3/render/objects/rtsAlgVillage.js";
import { buildArmsCache, buildLookout, buildRefuge, buildRockOutcrop } from "../../v3/render/objects/rtsAlgeria.js";
import { FOLIAGE_PRESETS } from "../../v3/app/state/foliageScatterState.js";
import { kitView } from "./showroom.js";

const P = {
  farmsteads: 7, roman: 2, burnt: 1,
  huts: 6, hutSpacing: 45,   // ruined gourbis between the rest (2026-10-07, the AAA list's density)
  terraces: 4, terraceSlope: [8, 17],   // almond terraces on the open slopes between the villages
  caches: 3,              // hidden arms caches (plus the camp's own)
  refuges: 2, lookouts: 3,
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
  const ok = (x, z, needTrack, spacing = P.spacing) => {
    if (!(x > PLAY.x0 + 30 && x < PLAY.x1 - 30 && z > PLAY.z0 + 30 && z < PLAY.z1 - 30)) return false;
    for (const s of LAYOUT.sites) {
      const big = ["hamlet", "dechra", "ksar", "french", "aln"].includes(s.kind);
      if (Math.hypot(s.x - x, s.z - z) < (s.r ?? 20) + (big ? P.siteClear : P.minorClear)) return false;
    }
    for (const e of list) if (Math.hypot(e.x - x, e.z - z) < P.pieceClear) return false;
    for (const p of placed) if (Math.hypot(p.x - x, p.z - z) < spacing) return false;
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
    // Last, and closer together: small, they fill the gaps the big pieces left.
    ...Array.from({ length: P.huts }, (_, i) => ({ key: `ruinedHut${i + 1}`, build: (o) => buildRuinedHut({ ...o, seed: 2010 + i * 3 }), track: false, spacing: P.hutSpacing })),
  ];
  const out = [];
  // HIDDEN ARMS CACHES (2026-10-01): the FLN's armouries in the hills — each
  // arms two FM gunners (algAI.js). In its half of the map (nearer the cave
  // than the post), OFF the tracks, on gentle ground in scrub (the best of
  // many candidates: concealment first), apart from each other. A pad piece:
  // the showroom levels its ground. Hidden under the fog until found.
  const cave = LAYOUT.sites.find((s) => s.kind === "aln"), fr = LAYOUT.sites.find((s) => s.kind === "french");
  for (let k = 0; k < P.caches; k++) {
    let best = null, bestS = -Infinity;
    for (let t = 0; t < 900; t++) {
      const x = PLAY.x0 + 30 + R() * (PLAY.x1 - PLAY.x0 - 60), z = PLAY.z0 + 30 + R() * (PLAY.z1 - PLAY.z0 - 60);
      if (Math.hypot(x - fr.x, z - fr.z) < 260 || Math.hypot(x - cave.x, z - cave.z) > Math.hypot(x - fr.x, z - fr.z) + 40) continue;
      if (Math.hypot(x - cave.x, z - cave.z) < 70) continue;
      if (LAYOUT.sites.some((s) => ["hamlet", "dechra", "ksar"].includes(s.kind) && Math.hypot(s.x - x, s.z - z) < (s.r ?? 30) + 70)) continue;
      if (list.some((e) => Math.hypot(e.x - x, e.z - z) < 30) || [...out, ...placed].some((p) => Math.hypot(p.x - x, p.z - z) < 110)) continue;
      if (trackDist(x, z) < 28) continue;
      let lo = Infinity, hi = -Infinity, wet = false;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const h = H(x + i * 4, z + j * 4); lo = Math.min(lo, h); hi = Math.max(hi, h);
        if ((app.getWaterLevelAt?.(x + i * 4, z + j * 4) ?? -Infinity) > h - 0.3) wet = true;
      }
      if (wet || hi - lo > 2.6) continue;
      const s = (app.sampleFoliageDensity?.(x, z) ?? 0) + (app.sampleTallPlantDensity?.(x, z) ?? 0) + R() * 0.15;
      if (s > bestS) { bestS = s; best = { x, z }; }
    }
    if (!best) continue;
    const e = { key: `armsCache${k + 2}`, build: () => buildArmsCache({ seed: 1957 + k * 11 }), x: best.x, z: best.z, yaw: VIEW_YAW + 0.5 + (R() - 0.5) * 0.6, rim: 5 };
    out.push(e);
  }
  // REFUGES (casemates): toward the middle of the map, where the bands strike
  // (they withdraw to the nearest instead of the far cave); in scrub, off the
  // tracks, 60 m+ from the villages, 180 m+ from the post.
  for (let k = 0; k < P.refuges; k++) {
    let best = null, bestS = -Infinity;
    for (let t = 0; t < 900; t++) {
      const x = PLAY.x0 + 40 + R() * (PLAY.x1 - PLAY.x0 - 80), z = PLAY.z0 + 40 + R() * (PLAY.z1 - PLAY.z0 - 80);
      // The FLN's half (nearer the cave than the post, as the caches), not on the cave.
      if (Math.hypot(x - fr.x, z - fr.z) < 200 || Math.hypot(x - cave.x, z - cave.z) < 140 || Math.hypot(x - cave.x, z - cave.z) > Math.hypot(x - fr.x, z - fr.z) + 60) continue;
      if (LAYOUT.sites.some((s) => ["hamlet", "dechra", "ksar"].includes(s.kind) && Math.hypot(s.x - x, s.z - z) < (s.r ?? 30) + 60)) continue;
      if (list.some((e) => Math.hypot(e.x - x, e.z - z) < 30) || [...out, ...placed].some((p) => Math.hypot(p.x - x, p.z - z) < 120)) continue;
      if (trackDist(x, z) < 25) continue;
      let lo = Infinity, hi = -Infinity;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const h = H(x + i * 4, z + j * 4); lo = Math.min(lo, h); hi = Math.max(hi, h); }
      if (hi - lo > 3 || (app.getWaterLevelAt?.(x, z) ?? -Infinity) > lo - 0.3) continue;
      const s = (app.sampleFoliageDensity?.(x, z) ?? 0) + (app.sampleTallPlantDensity?.(x, z) ?? 0) + R() * 0.1;
      if (s > bestS) { bestS = s; best = { x, z }; }
    }
    if (best) out.push({ key: `refuge${k + 1}`, build: () => buildRefuge({ seed: 1997 + k * 13 }), x: best.x, z: best.z, yaw: VIEW_YAW + 0.5 + (R() - 0.5) * 0.8, rim: 5 });
  }
  // LOOKOUTS on the CRESTS: the highest points over their surroundings
  // (ground 5 m+ above the land 50 m round), 170 m+ from the post, apart.
  for (let k = 0; k < P.lookouts; k++) {
    let best = null, bestS = -Infinity;
    for (let t = 0; t < 1200; t++) {
      const x = PLAY.x0 + 30 + R() * (PLAY.x1 - PLAY.x0 - 60), z = PLAY.z0 + 30 + R() * (PLAY.z1 - PLAY.z0 - 60);
      if (Math.hypot(x - fr.x, z - fr.z) < 170) continue;
      if ([...out, ...placed].some((p) => Math.hypot(p.x - x, p.z - z) < 100) || list.some((e) => Math.hypot(e.x - x, e.z - z) < 30)) continue;
      const h = H(x, z);
      let ring = 0;
      for (let a = 0; a < 8; a++) ring += H(x + Math.cos(a * 0.785) * 50, z + Math.sin(a * 0.785) * 50);
      const rise = h - ring / 8;
      let lo = Infinity, hi = -Infinity;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const g = H(x + i * 2.5, z + j * 2.5); lo = Math.min(lo, g); hi = Math.max(hi, g); }
      if (rise < 5 || hi - lo > 2.5) continue;
      const s = rise + R() * 2;
      if (s > bestS) { bestS = s; best = { x, z }; }
    }
    if (best) out.push({ key: `lookout${k + 1}`, build: () => buildLookout({ seed: 1998 + k * 7 }), x: best.x, z: best.z, yaw: VIEW_YAW + (R() - 0.5), rim: 3 });
  }
  for (const w of want) {
    for (let t = 0; t < P.tries; t++) {
      const x = PLAY.x0 + R() * (PLAY.x1 - PLAY.x0), z = PLAY.z0 + R() * (PLAY.z1 - PLAY.z0);
      if (!ok(x, z, w.track, w.spacing)) continue;
      // Fronts toward the player's camera, three-quarters (your rule).
      const e = { key: w.key, build: w.build, x, z, yaw: VIEW_YAW + (R() < 0.5 ? 0.5 : -0.5) + (R() - 0.5) * 0.3, ground: true };
      placed.push(e);
      out.push(e);
      break;
    }
  }
  // TERRACES on the open slopes (2026-10-07, the AAA list): the villages' own are by hand
  // (showroom.js); these fill the bare hillsides between, near the same rule — 8-17° along the piece
  // under 4° of side tilt, turned to climb straight uphill (yaw = the slope's, measured to match).
  const slope = (x, z) => {
    const gx = (H(x + 4, z) - H(x - 4, z)) / 8, gz = (H(x, z + 4) - H(x, z - 4)) / 8;
    return { deg: Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI, yaw: Math.atan2(gx, gz) };
  };
  for (let k = 0, t = 0; k < P.terraces && t < P.tries; t++) {
    const x = PLAY.x0 + 40 + R() * (PLAY.x1 - PLAY.x0 - 80), z = PLAY.z0 + 40 + R() * (PLAY.z1 - PLAY.z0 - 80);
    const c = slope(x, z);
    if (c.deg < P.terraceSlope[0] || c.deg > P.terraceSlope[1]) continue;
    const ux = Math.sin(c.yaw), uz = Math.cos(c.yaw), sx = uz, sz = -ux;
    // Every point of the piece on the same kind of slope, and level across it.
    let good = true;
    for (const a of [-10, 0, 10]) for (const b of [-10, 0, 10]) {
      const px = x + ux * a + sx * b, pz = z + uz * a + sz * b, q = slope(px, pz);
      if (q.deg < P.terraceSlope[0] - 2 || q.deg > P.terraceSlope[1] + 3 || Math.abs(((q.yaw - c.yaw + 9.42) % 6.28) - 3.14) > 0.5) { good = false; break; }
      if ((app.getWaterLevelAt?.(px, pz) ?? -Infinity) > H(px, pz) - 0.3) { good = false; break; }
      const w = app.samplePaintWeights?.(px, pz);
      if (w && (w[4] > 0.3 || w[5] > 0.25 || w[3] > 0.4 || w[6] > 0.4)) { good = false; break; }
    }
    if (!good) continue;
    if (Math.abs(H(x + sx * 10, z + sz * 10) - H(x - sx * 10, z - sz * 10)) > 1.4) continue;   // < 4° side tilt
    if (trackDist(x, z) < 22) continue;
    if (LAYOUT.sites.some((s) => Math.hypot(s.x - x, s.z - z) < (s.r ?? 20) + P.minorClear + 10)) continue;
    if (list.some((e) => Math.hypot(e.x - x, e.z - z) < 40) || out.some((p) => Math.hypot(p.x - x, p.z - z) < 50)) continue;
    out.push({ key: `terracesOpen${k + 1}`, build: (o) => buildTerraces({ ...o, seed: 2030 + k * 5, rows: 3 + (k % 2) }), x, z, yaw: c.yaw, ground: true });
    k++;
  }
  return out;
}

const Q = {
  outcrops: 42, outcropSpacing: 34, outcropSlope: [9, 32],   // degrees
  trees: 24, treeSpacing: 55,
  deadTrees: 18, deadSpacing: 38,   // snags on the open plain (2026-10-07)
  betoums: 10, betoumSpacing: 70,   // the landmark shade trees (2026-10-03)
  tamariskGroups: 9,                // along the wadis and the oasis edge
  mastShare: 0.13,        // agaves with their flower mast
  broomClumps: 14,
  agaveRun: 0.35,         // chance of a row at a track point near a village
  clear: 8,               // m from tracks, fields, pieces
  // BOULDER CLUSTERS on the FLATS (the AAA gap list, 2026-10-07: the outcrops only sit on slopes, the
  // open flats had nothing): groups of 3-5 boulders, hard cover, apart from each other and the crags.
  clusters: 34, clusterSpacing: 42, clusterSlope: 9,
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

  // The FLN's hidden places: the trees and scrub OFF them (a lookout under a
  // cedar's crown could neither see nor be seen); the caches and refuges keep
  // the scrub round them — only their own ground is cleared.
  for (const [key, m] of Object.entries(showroom)) {
    const k = /^(armsCache|refuge|lookout)\d+$/.exec(key)?.[1];
    if (!k || !m?.parent) continue;
    app.clearVegetation?.(m.position.x, m.position.z, k === "lookout" ? 10 : 5, { grass: 3, edge: 0.6 });
  }

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
  // ── Boulder clusters on the flats ────────────────────────────────────────
  const centres = [];
  for (let t = 0; t < 8000 && centres.length < Q.clusters; t++) {
    const x = PLAY.x0 + R() * (PLAY.x1 - PLAY.x0), z = PLAY.z0 + R() * (PLAY.z1 - PLAY.z0);
    if (slopeDeg(x, z) > Q.clusterSlope || !free(x, z, 5)) continue;
    if (centres.some((c) => Math.hypot(c.x - x, c.z - z) < Q.clusterSpacing)) continue;
    if (rocks.some((r) => Math.hypot(r.x - x, r.z - z) < Q.clusterSpacing * 0.6)) continue;
    centres.push({ x, z });
    const n = 4 + Math.floor(R() * 3), a0 = R() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * Math.PI * 2 + (R() - 0.5) * 0.8, d = i === 0 ? 0 : 2.4 + R() * 2.6;
      const bx = x + Math.cos(a) * d, bz = z + Math.sin(a) * d;
      if (i && !free(bx, bz, 1)) continue;
      const k = i === 0 ? 0.9 + R() * 0.3 : 0.5 + R() * 0.3;   // (0.6 / 0.32 read as pebbles from the RTS camera)
      rocks.push({ x: bx, z: bz, k, v: Math.floor(R() * variants.length), yaw: R() * Math.PI * 2 });
    }
    taken.push({ x, z, r: 6 });
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
    if (R() < 0.6 && trackPts.length) {
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

  // ── DEAD TREES (2026-10-07, the AAA list's "map density"): grey snags alone
  // on the open plain and the lower slopes — what a dry fought-over valley has
  // that a garden doesn't. Away from the living trees, not on the tracks.
  const dead = [];
  for (let t = 0; t < 4000 && dead.length < Q.deadTrees; t++) {
    const x = PLAY.x0 + 8 + R() * (PLAY.x1 - PLAY.x0 - 16), z = PLAY.z0 + 8 + R() * (PLAY.z1 - PLAY.z0 - 16);
    if (slopeDeg(x, z) > 24) continue;
    if (taken.some((tk) => Math.hypot(tk.x - x, tk.z - z) < tk.r + 4)) continue;
    if ((app.getWaterLevelAt?.(x, z) ?? -Infinity) > H(x, z) - 0.3 || navGrid?.isBlockedAtWorld?.(x, z)) continue;
    if (nearTrack(x, z, 6)) continue;
    if (trees.some((tr) => Math.hypot(tr.x - x, tr.z - z) < 20)) continue;
    if (dead.some((d) => Math.hypot(d.x - x, d.z - z) < Q.deadSpacing)) continue;
    dead.push({ x, z });
  }
  if (plants && dead.length) {
    if (!plants.types.has("deadTree")) plants.setType("deadTree", structuredClone(FOLIAGE_PRESETS.deadTree));
    for (const d of dead) {
      plants.add("deadTree", d.x, H(d.x, d.z) - 0.1, d.z, { rotY: R() * 6.28, scale: 0.8 + R() * 0.6, seed: R() });
    }
  }

  // ── BETOUMS (Atlas pistachio, 2026-10-03): the landmark shade trees — alone
  // on the open plain, near the villages, a few in the wide wadi beds. Big
  // (11 m), so far apart; their ground under the crown cleared of scrub.
  const paint = (x, z) => app.samplePaintWeights?.(x, z) ?? null;
  const betoums = [];
  const villages = LAYOUT.sites.filter((s) => ["hamlet", "dechra", "ksar"].includes(s.kind));
  for (let t = 0; t < 8000 && betoums.length < Q.betoums; t++) {
    let x, z;
    const u = R();
    if (u < 0.35 && villages.length) {
      // Near a village, 35-90 m out.
      const v = villages[Math.floor(R() * villages.length)], a = R() * Math.PI * 2, d = 35 + R() * 55;
      x = v.x + Math.cos(a) * d; z = v.z + Math.sin(a) * d;
    } else { x = PLAY.x0 + R() * (PLAY.x1 - PLAY.x0); z = PLAY.z0 + R() * (PLAY.z1 - PLAY.z0); }
    if (slopeDeg(x, z) > 14 || !free(x, z, 5)) continue;
    const w = paint(x, z);
    if (w && (w[5] > 0.2 || w[3] > 0.4)) continue;              // not on cliffs, not in the oasis grove
    if ([...betoums, ...trees].some((b) => Math.hypot(b.x - x, b.z - z) < Q.betoumSpacing)) continue;
    betoums.push({ x, z });
    taken.push({ x, z, r: 6 });
  }
  // ── TAMARISKS: small groups along the wadis and the oasis edge ───────────
  const tamarisks = [];
  for (let t = 0; t < 8000 && tamarisks.length < Q.tamariskGroups * 4; t++) {
    const cx = PLAY.x0 + R() * (PLAY.x1 - PLAY.x0), cz = PLAY.z0 + R() * (PLAY.z1 - PLAY.z0);
    const w = paint(cx, cz);
    if (!w || !(w[4] > 0.35 || (w[3] > 0.2 && w[3] < 0.6))) continue;   // a wadi bed, or the grove's edge
    if (tamarisks.some((b) => Math.hypot(b.x - cx, b.z - cz) < 40)) continue;
    const n = 2 + Math.floor(R() * 4);
    for (let k = 0; k < n; k++) {
      const a = R() * Math.PI * 2, r = 2 + R() * 7, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (slopeDeg(x, z) > 22 || !free(x, z, 2.5)) continue;
      if (tamarisks.some((b) => Math.hypot(b.x - x, b.z - z) < 4)) continue;
      tamarisks.push({ x, z });
      taken.push({ x, z, r: 3 });
    }
  }
  if (plants) {
    for (const [kind, list, sc] of [["betoum", betoums, [0.85, 0.35]], ["tamariskTree", tamarisks, [0.75, 0.45]]]) {
      if (!list.length || !FOLIAGE_PRESETS[kind]) continue;
      if (!plants.types.has(kind)) plants.setType(kind, structuredClone(FOLIAGE_PRESETS[kind]));
      for (const b of list) {
        plants.add(kind, b.x, H(b.x, b.z) - 0.05, b.z, { rotY: R() * 6.28, scale: sc[0] + R() * sc[1], seed: R() });
        app.clearVegetation?.(b.x, b.z, kind === "betoum" ? 4 : 2.5, { grass: 0, edge: 0.6 });
      }
    }
  }

  // ── Agaves: planted by people — a row before each farmstead's yard, short
  // rows along the pistes near the villages; one in ~8 has its flower mast ──
  const agaves = [];
  // `byFarm`: the farmstead's own footprint is in `taken` — its row skips that test.
  const plantAgave = (x, z, byFarm = false) => {
    if (byFarm ? ((app.getWaterLevelAt?.(x, z) ?? -Infinity) > H(x, z) - 0.3 || navGrid?.isBlockedAtWorld?.(x, z) || nearTrack(x, z, 4)) : !free(x, z, 1.2)) return;
    if (slopeDeg(x, z) > 22) return;

    if (agaves.some((a) => Math.hypot(a.x - x, a.z - z) < 2.2)) return;
    agaves.push({ x, z, mast: R() < Q.mastShare });
    taken.push({ x, z, r: 1.4 });
  };
  for (const [key, m] of Object.entries(showroom)) {
    if (!/^mechtaFarm/.test(key) || !m?.parent) continue;
    const c = Math.cos(m.rotation.y), s = Math.sin(m.rotation.y);
    for (let lx = -8; lx <= 12; lx += 2.6 + R() * 0.8) {
      const lz = -10.5 + (R() - 0.5) * 1.2;
      plantAgave(m.position.x + lx * c + lz * s, m.position.z - lx * s + lz * c, true);
    }
  }
  for (const t of TRACK_LINES) {
    for (let i = 2; i < t.line.length - 2; i += 9) {
      const p = t.line[i], q0 = t.line[i - 1];
      if (!villages.some((v) => Math.hypot(v.x - p.x, v.z - p.z) < 170) || R() > Q.agaveRun) continue;
      const tx = p.x - q0.x, tz = p.z - q0.z, tl = Math.hypot(tx, tz) || 1, side = R() < 0.5 ? 1 : -1;
      const n = 3 + Math.floor(R() * 4);
      for (let k = 0; k < n; k++) {
        const along = k * 2.6;
        plantAgave(p.x + (tx / tl) * along + (tz / tl) * 6.5 * side, p.z + (tz / tl) * along - (tx / tl) * 6.5 * side);
      }
    }
  }
  if (plants) {
    if (!plants.types.has("agave")) plants.setType("agave", structuredClone(FOLIAGE_PRESETS.agave));
    const masts = plants.types.has("agaveMast") || plants.types.size < 16;   // PlacedFoliage MAX_TYPES
    if (masts && !plants.types.has("agaveMast")) plants.setType("agaveMast", structuredClone(FOLIAGE_PRESETS.agaveMast));
    for (const a of agaves) {
      const y = H(a.x, a.z) - 0.08;
      plants.add("agave", a.x, y, a.z, { rotY: R() * 6.28, scale: 0.8 + R() * 0.45, seed: R() });
      if (a.mast && masts) plants.add("agaveMast", a.x + 0.2, y, a.z, { rotY: R() * 6.28, scale: 0.85 + R() * 0.3, seed: R() });
      app.clearVegetation?.(a.x, a.z, 1.8, { grass: 0, edge: 0.6 });
    }
  }

  // ── Broom: clumps of yellow-flowered bushes on the slopes ─────────────────
  const brooms = [];
  for (let t = 0; t < 4000 && brooms.length < Q.broomClumps * 5; t++) {
    const cx = PLAY.x0 + R() * (PLAY.x1 - PLAY.x0), cz = PLAY.z0 + R() * (PLAY.z1 - PLAY.z0);
    const s = slopeDeg(cx, cz);
    if (s < 8 || s > 30 || !free(cx, cz, 4)) continue;
    if (brooms.some((b) => Math.hypot(b.x - cx, b.z - cz) < 45)) continue;
    const n = 3 + Math.floor(R() * 5);
    for (let k = 0; k < n; k++) {
      const a = R() * Math.PI * 2, r = 1.5 + R() * 6, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (free(x, z, 0.8)) brooms.push({ x, z });
    }
  }
  if (plants && brooms.length) {
    if (!plants.types.has("broom")) plants.setType("broom", structuredClone(FOLIAGE_PRESETS.broom));
    for (const b of brooms) plants.add("broom", b.x, H(b.x, b.z) - 0.05, b.z, { rotY: R() * 6.28, scale: 0.8 + R() * 0.5, seed: R() });
  }

  return {
    rocks, trees, meshes, agaves, brooms, betoums, tamarisks,
    /** Hard cover round the outcrops, for the cover bake (algCover.js). */
    *coverCircles() { for (const r of rocks) yield { x: r.x, z: r.z, radius: 2.4 * r.k, size: 1, hard: true }; },
    stats: { outcrops: rocks.length, clusters: centres.length, trees: trees.length, dead: dead.length, agaves: agaves.length, masts: agaves.filter((a) => a.mast).length, brooms: brooms.length, betoums: betoums.length, tamarisks: tamarisks.length },
  };
}
