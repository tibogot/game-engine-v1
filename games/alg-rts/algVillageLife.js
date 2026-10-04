// VILLAGE LIFE (you, 2026-10-04: "fill the map — life around the villages"):
// the small things a lived-in village has round its edge, so a village no
// longer stops dead at its last wall —
//   HAYSTACKS   gathered in a stackyard (3-5), one per village
//   FIREWOOD    piles by the houses
//   TABOUNA     the clay bread oven out in a yard
//   BEEHIVES    a row of cork hives a little further out
// (the kit: v3/render/objects/rtsAlgVillage.js buildHaystack / buildWoodpile /
// buildTabouna / buildBeehives — in the ground-band and coplanar tests.)
//
// CHEAP BY CONSTRUCTION: two variants a kind, each ONE InstancedMesh (+ its
// shadow) for every village on the map: 8 draws. Placed once at load by a
// deterministic search (the same every game), on gentle open ground just
// outside the village's ring: off the fields, the placed pieces, the tracks,
// the water, the blocked cells. Each blocks the nav grid where it stands (men
// walk round a haystack), and clears the scrub and stones under it.
// ?life=0 = without.
import * as THREE from "three";
import { buildBeehives, buildHaystack, buildTabouna, buildWoodpile } from "../../v3/render/objects/rtsAlgVillage.js";
import { TRACK_LINES } from "./algTracks.js";
import { LAYOUT, PLAY } from "./layout.js";
import { kitView } from "./showroom.js";

const P = {
  // per village kind: [haystacks, woodpiles, ovens, hive rows]
  counts: { hamlet: [4, 3, 2, 1], dechra: [5, 4, 2, 2], ksar: [4, 5, 3, 1] },
  ring: { near: [3, 16], far: [10, 34] },   // m outside the village's radius
  stackyard: 7,                              // m: the haystacks round their yard's centre
  maxTiltDeg: 14,
  gap: 2,                                    // m between pieces (and from fields, buildings)
  trackClear: 5,
  tries: 900,
};

/** A seeded random stream (the same places every load). */
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

export function createAlgVillageLife(app, { navGrid = null, showroom = {}, fields = null, plants = null } = {}) {
  const R = rng(20461);
  const H = (x, z) => app.getWorldHeight(x, z);
  const cosTilt = Math.cos((P.maxTiltDeg * Math.PI) / 180);

  // Two variants of each piece (their footprints: the placement's box sizes).
  const KINDS = {
    haystack: [buildHaystack({ seed: 2101 }), buildHaystack({ seed: 2111 })],
    woodpile: [buildWoodpile({ seed: 2102 }), buildWoodpile({ seed: 2112 })],
    tabouna: [buildTabouna({ seed: 2103 }), buildTabouna({ seed: 2113 })],
    beehives: [buildBeehives({ seed: 2104 }), buildBeehives({ seed: 2114 })],
  };

  // ── What is already there (oriented boxes, world) ─────────────────────────
  const boxes = [];
  for (const m of Object.values(showroom)) {
    const fp = m?.isObject3D ? m.geometry?.userData?.footprint : null;
    if (!fp || !m.parent) continue;
    const c = Math.cos(m.rotation.y), s = Math.sin(m.rotation.y);
    boxes.push({ x: m.position.x + fp.cx * c + fp.cz * s, z: m.position.z - fp.cx * s + fp.cz * c, hx: fp.hx, hz: fp.hz, yaw: m.rotation.y });
  }
  for (const b of fields?.plots ?? []) boxes.push(b);
  const axes = (b) => [[Math.cos(b.yaw), -Math.sin(b.yaw)], [Math.sin(b.yaw), Math.cos(b.yaw)]];
  const overlaps = (a, b, gap) => {
    for (const [ax, az] of [...axes(a), ...axes(b)]) {
      const proj = (r) => { const [u, v] = axes(r); return Math.abs(u[0] * ax + u[1] * az) * r.hx + Math.abs(v[0] * ax + v[1] * az) * r.hz; };
      if (Math.abs((b.x - a.x) * ax + (b.z - a.z) * az) > proj(a) + proj(b) + gap) return false;
    }
    return true;
  };
  // The placed trees and shrubs (gardens, lone trees, orchards, hedges): no
  // haystack under an olive. Their crowns ~2.5 m × their scale.
  const trees = (plants?.plants ?? []).map((p) => ({ x: p.x, z: p.z, r: 2.5 * (p.scale ?? 1) }));
  const underTree = (x, z, r) => trees.some((t) => Math.abs(t.x - x) < t.r + r && Math.abs(t.z - z) < t.r + r && Math.hypot(t.x - x, t.z - z) < t.r + r);
  // …nor in an oasis's grove: palms, then the tamarisk ring painted round them
  // (the ground field — out to ~3.4 pool radii, tools/algVegetation.mjs).
  const oases = LAYOUT.sites.filter((s) => s.kind === "oasis");
  const inGrove = (x, z) => oases.some((o) => Math.hypot(x - o.x, z - o.z) < (o.r ?? 20) * 2.2 + 12);
  const trackPts = TRACK_LINES.flatMap((t) => t.line);
  const nearTrack = (x, z, r) => trackPts.some((p) => Math.abs(p.x - x) < r && Math.abs(p.z - z) < r && Math.hypot(p.x - x, p.z - z) < r);

  /** Can a piece with footprint `fp` stand at (x, z) turned `yaw`? */
  function spotOk(x, z, yaw, fp) {
    const b = { x, z, hx: fp.hx, hz: fp.hz, yaw };
    if (!(x > PLAY.x0 + 10 && x < PLAY.x1 - 10 && z > PLAY.z0 + 10 && z < PLAY.z1 - 10)) return null;
    if (boxes.some((o) => overlaps(b, o, P.gap))) return null;
    if (nearTrack(x, z, P.trackClear + Math.max(fp.hx, fp.hz))) return null;
    if (underTree(x, z, Math.max(fp.hx, fp.hz)) || inGrove(x, z)) return null;
    // …nor under the PAINTED trees (the tall-plant field: holm oaks, scrub) —
    // their trunks under it are cleared, but a crown 3-4 m off still overhangs.
    const rr = Math.max(fp.hx, fp.hz) + 3;
    for (const [i, j] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if ((app.sampleTallPlantDensity?.(x + i * rr, z + j * rr) ?? 0) > 0.12) return null;
    }
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let low = Infinity;
    for (const [i, j] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) {
      const px = x + i * fp.hx * c + j * fp.hz * s, pz = z - i * fp.hx * s + j * fp.hz * c;
      const h = H(px, pz);
      low = Math.min(low, h);
      if ((app.getWaterLevelAt?.(px, pz) ?? -Infinity) > h - 0.3) return null;
      if ((app.getWorldNormal?.(px, pz)?.y ?? 1) < cosTilt) return null;
      if (navGrid?.isBlockedAtWorld?.(px, pz)) return null;
      const w = app.samplePaintWeights?.(px, pz);
      if (w && (w[4] > 0.35 || w[5] > 0.3 || w[6] > 0.25)) return null;   // wadi, cliff, track
    }
    return { b, low };
  }

  // ── Place ──────────────────────────────────────────────────────────────────
  const placed = { haystack: [[], []], woodpile: [[], []], tabouna: [[], []], beehives: [[], []] };
  const all = [];   // { kind, x, z, yaw, fp }
  function put(kind, x, z, yaw) {
    const v = Math.floor(R() * 2);
    const fp = KINDS[kind][v].userData.footprint;
    const ok = spotOk(x, z, yaw, fp);
    if (!ok) return false;
    placed[kind][v].push({ x, y: ok.low - 0.06, z, yaw });
    boxes.push(ok.b);
    all.push({ kind, x, z, yaw, fp });
    return true;
  }
  const ringPoint = (site, [a0, a1]) => {
    const a = R() * Math.PI * 2, r = site.r + a0 + R() * (a1 - a0);
    return [site.x + Math.cos(a) * r, site.z + Math.sin(a) * r, a];
  };
  for (const site of LAYOUT.sites) {
    const want = P.counts[site.kind];
    if (!want) continue;
    const [hay, wood, ovens, hives] = want;
    // The stackyard: a centre on the far ring, the stacks round it.
    for (let t = 0, got = 0; t < P.tries && got < hay; t++) {
      if (t % 60 === 0) site._yard = ringPoint(site, P.ring.far);
      const [cx, cz] = site._yard;
      const a = R() * Math.PI * 2, r = R() * P.stackyard;
      if (put("haystack", cx + Math.cos(a) * r, cz + Math.sin(a) * r, R() * Math.PI * 2)) got++;
    }
    delete site._yard;
    // Firewood and ovens by the houses (the near ring), turned to face the village.
    for (const [kind, n] of [["woodpile", wood], ["tabouna", ovens]]) {
      for (let t = 0, got = 0; t < P.tries && got < n; t++) {
        const [x, z, a] = ringPoint(site, P.ring.near);
        if (put(kind, x, z, -a + Math.PI / 2 + (R() - 0.5) * 0.6)) got++;
      }
    }
    // The hives a little further out, their row across the slope.
    for (let t = 0, got = 0; t < P.tries && got < hives; t++) {
      const [x, z, a] = ringPoint(site, P.ring.far);
      if (put("beehives", x, z, -a + (R() - 0.5) * 0.4)) got++;
    }
  }

  // ── Draw: one InstancedMesh a variant ──────────────────────────────────────
  const meshes = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), Y = new THREE.Vector3(0, 1, 0);
  for (const [kind, vars] of Object.entries(KINDS)) {
    vars.forEach((geo, v) => {
      const list = placed[kind][v];
      if (!list.length) return;
      const mesh = new THREE.InstancedMesh(geo, kitView(geo).material, list.length);
      list.forEach((p, k) => mesh.setMatrixAt(k, m4.compose(new THREE.Vector3(p.x, p.y, p.z), q.setFromAxisAngle(Y, p.yaw), one)));
      mesh.name = `VillageLife:${kind}${v}`;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      app.scene.add(mesh);
      meshes.push(mesh);
    });
  }

  // ── Men walk round them; nothing grows under them ──────────────────────────
  for (const p of all) {
    navGrid?.addFootprint?.(p.x, p.z, p.fp.hx, p.fp.hz, p.yaw);
    app.clearVegetation?.(p.x, p.z, Math.max(p.fp.hx, p.fp.hz) + 0.5, { grass: Math.max(p.fp.hx, p.fp.hz), edge: 0.7 });
  }
  const inOne = (x, z) => all.some((p) => Math.hypot(x - p.x, z - p.z) < Math.max(p.fp.hx, p.fp.hz) + 0.3);
  const stonesCleared = app.algStones?.clearWhere?.(inOne) ?? 0;

  const count = (k) => placed[k][0].length + placed[k][1].length;
  return {
    params: P, meshes, pieces: all,
    stats: { haystacks: count("haystack"), woodpiles: count("woodpile"), ovens: count("tabouna"), hives: count("beehives"), draws: meshes.length, stonesCleared },
  };
}
