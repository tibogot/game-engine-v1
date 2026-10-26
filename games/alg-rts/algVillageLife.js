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
import { LAYOUT, MAP, PLAY } from "./layout.js";
import { createHouseField } from "./algHouse.js";
import { haystackField } from "./algHaystack.js";
import { kitView } from "./showroom.js";
import { FOLIAGE_PRESETS } from "../../v3/app/state/foliageScatterState.js";

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

// THE BLENDER VILLAGE PROPS (2026-10-24, tools/blender/villageProps.py — you: "the village is a circle with nothing at the
// centre"; "village props built so the game places each one on its own"): with `models` (the vprops kit loaded,
// algHouse) the same places get the Blender pieces — one instanced field, a draw per prop — and each village's SQUARE
// gets its well and trough, its jars and a bench. Their footprints: the pieces' real metres x1.3.
const VP = 1.3;
const VPROP = {
  haystack: { type: null, fp: { hx: 1.75 * VP, hz: 1.75 * VP } }, woodpile: { type: "wood", fp: { hx: 1.75 * VP, hz: 0.7 * VP } },
  tabouna: { type: "oven", fp: { hx: 1.25 * VP, hz: 0.9 * VP } }, beehives: { type: "hives", fp: { hx: 1.35 * VP, hz: 0.45 * VP } },
  well: { type: "well", fp: { hx: 1.25 * VP, hz: 1.15 * VP } }, trough: { type: "trough", fp: { hx: 1.0 * VP, hz: 0.45 * VP } },
  jars: { type: "jars", fp: { hx: 0.6 * VP, hz: 0.6 * VP } }, bench: { type: "bench", fp: { hx: 1.2 * VP, hz: 0.32 * VP } },
};
const JARS = ["jars", "jars2", "jars3"];
const SQUARE = new Set(["well", "trough", "jars", "bench"]);

export function createAlgVillageLife(app, { navGrid = null, showroom = {}, fields = null, plants = null, models = false } = {}) {
  const R = rng(20461);
  const H = (x, z) => app.getWorldHeight(x, z);
  const cosTilt = Math.cos((P.maxTiltDeg * Math.PI) / 180), cosSquare = Math.cos((22 * Math.PI) / 180);   // (a dechra's square is on its slope)

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
  // the map's town houses (algGame: MAP.town — not showroom pieces): their footprints
  for (const [, , , , , yaw, fx, fz, hx, hz] of MAP.town?.houses ?? []) boxes.push({ x: fx, z: fz, hx, hz, yaw });
  // …and the SUPPLY POINTS (their depot and mast: a house field of their own, not showroom pieces — a haystack stood in
  // the drums of the fuel point by the east gully mouth, 2026-10-24): their ring kept clear
  for (const p of MAP.supply ?? []) if (Number.isFinite(p?.x)) boxes.push({ x: p.x, z: p.z, hx: 13, hz: 13, yaw: 0 });
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
  function spotOk(x, z, yaw, fp, sq = false) {
    // (`sq`, a square's piece: tracks END in the square and its props stand before the doors — a smaller gap, the track allowed)
    const b = { x, z, hx: fp.hx, hz: fp.hz, yaw };
    if (!(x > PLAY.x0 + 10 && x < PLAY.x1 - 10 && z > PLAY.z0 + 10 && z < PLAY.z1 - 10)) return null;
    if (boxes.some((o) => overlaps(b, o, sq ? 0.5 : P.gap))) return null;
    if (!sq && nearTrack(x, z, P.trackClear + Math.max(fp.hx, fp.hz))) return null;
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
      if ((app.getWorldNormal?.(px, pz)?.y ?? 1) < (sq ? cosSquare : cosTilt)) return null;
      if (navGrid?.isBlockedAtWorld?.(px, pz)) return null;
      const w = app.samplePaintWeights?.(px, pz);
      if (w && (w[4] > 0.35 || w[5] > 0.3 || (!sq && w[6] > 0.25))) return null;   // wadi, cliff, track
    }
    return { b, low };
  }

  // ── Place ──────────────────────────────────────────────────────────────────
  const placed = { haystack: [[], []], woodpile: [[], []], tabouna: [[], []], beehives: [[], []] };
  const all = [];   // { kind, x, z, yaw, fp }
  const pads = [];  // the levelled pads under the Blender props: [x, z, hx, hz, y, opts] (algGame flattens them in turn)
  function put(kind, x, z, yaw) {
    const v = Math.floor(R() * 2);
    const fp = models ? VPROP[kind].fp : KINDS[kind][v].userData.footprint;
    const ok = spotOk(x, z, yaw, fp, SQUARE.has(kind));
    if (!ok) return false;
    let y = ok.low - 0.06;
    // A LEVELLED PAD under a Blender prop on uneven ground (2026-10-24, you: "one going inside the ground … flatten
    // under the assets when needed"): its footprint's mean height, the slope eased round it (as the town's houses)
    if (models) {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      let sum = 0, lo = Infinity, hi = -Infinity;
      for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) { const h = H(x + a * fp.hx * c + b * fp.hz * s, z - a * fp.hx * s + b * fp.hz * c); sum += h; lo = Math.min(lo, h); hi = Math.max(hi, h); }
      y = sum / 9;
      // (collected, flattened ONE AFTER ANOTHER by algGame — fired together, the height edits raced and wrote stale ground
      // over other pads: the training post sank in a pit, 2026-10-24)
      if (hi - lo > 0.12) pads.push([x, z, fp.hx + 0.4, fp.hz + 0.4, y, { rim: 2.5, rotY: yaw }]);
      y -= 0.03;
    }
    (placed[kind] ??= [[], []])[v].push({ x, y, z, yaw });
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

  // THE SQUARE (the Blender props only): a well a little south of the centre (the houses ring the north), its trough
  // beside it; jars and a bench before the houses' fronts. (A ksar's centre is its mosque: its square at the foot.)
  let squareTrees = 0;
  if (models) {
    for (const site of LAYOUT.sites) {
      if (!P.counts[site.kind]) continue;
      const sq = site.kind === "ksar" ? { x: site.x, z: site.z + site.r * 0.7 } : { x: site.x, z: site.z + 3 };
      for (let t = 0; t < 60; t++) {
        const a = R() * Math.PI * 2, r = t < 10 ? R() * 3 : R() * 9, x = sq.x + Math.cos(a) * r, z = sq.z + Math.sin(a) * r;
        if (!put("well", x, z, R() * Math.PI * 2)) continue;
        for (let u = 0; u < 30; u++) {   // the trough: 3-4 m off the well
          const b = R() * Math.PI * 2;
          if (put("trough", x + Math.cos(b) * 3.6, z + Math.sin(b) * 3.6, -b + Math.PI / 2)) break;
        }
        for (let u = 0; u < 30; u++) {   // jars set down by the well (to be filled)
          const b = R() * Math.PI * 2;
          if (put("jars", x + Math.cos(b) * 2.6, z + Math.sin(b) * 2.6, R() * 6.28)) break;
        }
        // THE SHADE TREE of the square (a fig, an olive), 7-11 m off the well, a bench under it facing the well
        // (a plant: no draw of its own — the showroom's PlacedFoliage)
        if (plants) {
          const kind = squareTrees++ % 2 ? "olive" : "fig";
          for (let u = 0; u < 40; u++) {
            const b = R() * Math.PI * 2, d = 7 + R() * 4, tx = x + Math.cos(b) * d, tz = z + Math.sin(b) * d;
            const tb = { x: tx, z: tz, hx: 1.2, hz: 1.2, yaw: 0 };
            if (boxes.some((o) => overlaps(tb, o, 1.5)) || navGrid?.isBlockedAtWorld?.(tx, tz) || nearTrack(tx, tz, 3)) continue;
            if (!plants.types.has(kind)) plants.setType(kind, structuredClone(FOLIAGE_PRESETS[kind]));
            plants.add(kind, tx, H(tx, tz) - 0.1, tz, { rotY: R() * 6.28, scale: 1.1 + R() * 0.3 });
            boxes.push(tb);
            navGrid?.addFootprint?.(tx, tz, 0.5, 0.5, 0);
            const bx = tx + Math.cos(b + Math.PI) * 2.2, bz = tz + Math.sin(b + Math.PI) * 2.2;
            put("bench", bx, bz, Math.atan2(bx - x, bz - z) + Math.PI / 2);
            break;
          }
        }
        break;
      }
      // before the fronts of the houses round the square: jars, a bench
      const fronts = (MAP.town?.houses ?? []).filter((h) => Math.hypot(h[6] - site.x, h[7] - site.z) < site.r + 10);
      let jars = 0, benches = 0;
      for (const h of fronts) {
        const [, , , , , yaw, fx, fz, hx, hz] = h, c = Math.cos(yaw), s = Math.sin(yaw);
        const side = R() < 0.5 ? -1 : 1, lx = side * hx * (0.35 + R() * 0.35), lz = -hz - 1.3;   // its front is -z
        const x = fx + lx * c + lz * s, z = fz - lx * s + lz * c;
        if (jars < 4 && R() < 0.6) { const jz = -hz - 1.9; if (put("jars", fx + lx * c + jz * s, fz - lx * s + jz * c, yaw)) jars++; }
        else if (benches < 2 && put("bench", fx + -lx * c + lz * s, fz - -lx * s + lz * c, yaw)) benches++;
      }
    }
  }

  // ── Draw: one InstancedMesh a variant ──────────────────────────────────────
  const meshes = [];
  if (models) {
    // (the Blender pieces: one instanced field, near / far by the camera — algHouse)
    const field = createHouseField();
    let jk = 0;
    const hay = haystackField();
    for (const [kind, vars] of Object.entries(placed)) for (const list of vars) for (const p of list) {
      // (the HAYSTACKS: the straw-card stack, its own instanced field — algHaystack; a little size each, never two alike)
      if (kind === "haystack") { hay.add(null, p.x, p.y + 0.02, p.z, p.yaw, 0.88 + ((p.x * 7.13 + p.z * 3.7) % 1 + 1) % 1 * 0.24); continue; }
      const type = kind === "jars" ? JARS[jk++ % 3] : VPROP[kind].type;
      field.add(type, "intact", p.x, p.y + 0.04, p.z, p.yaw, VP);
    }
    field.root.name = "VillageProps";
    app.scene.add(field.root);
    app.addPreRenderHook?.(() => field.update(app.camera));
    meshes.push(field.root);
  }
  for (const [kind, vars] of models ? [] : Object.entries(KINDS)) {
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), Y = new THREE.Vector3(0, 1, 0);
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

  const count = (k) => (placed[k]?.[0].length ?? 0) + (placed[k]?.[1].length ?? 0);
  return {
    params: P, meshes, pieces: all, pads,
    stats: { haystacks: count("haystack"), woodpiles: count("woodpile"), ovens: count("tabouna"), hives: count("beehives"), wells: count("well"), troughs: count("trough"), jars: count("jars"), benches: count("bench"), draws: meshes.length, stonesCleared },
  };
}
