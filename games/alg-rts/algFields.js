// THE FIELDS — the land the villages work, and the hedges round it (you,
// 2026-10-01: "the terrain still looks empty for an RTS"; the CoH bocage,
// Aurès-style). Placed at load by a deterministic search; cheap by
// construction:
//
//   SURFACE   every field's ground — ploughed furrows, stubble, green barley —
//             is ONE draw: an instanced quad per field, draped on the live
//             heightmap in the vertex shader (shared-rts/terrainDrape.js), the
//             rows drawn in the fragment shader. "2× multiply" blending
//             (dst × 2·src, 0.5 = untouched) scales the LIT ground darker or
//             paler, so a field reads the same in sun and in shadow.
//   WALLS     knee-high dry stone along most sides, a gap for the gate: 2 m
//             segments (rtsAlgVillage.js buildFieldWallSegment, 220 tris),
//             INSTANCED — three variants, one draw each (+ shadow), however
//             many fields. Hard cover along them (algCover.js reads
//             coverCircles()); men and vehicles step over.
//   HEDGES    prickly pear (the showroom's PlacedFoliage "pricklyPear": no
//             new draws) along some field sides and along the pistes near the
//             villages, with gaps. Concealment beside them (concealAt(): the
//             ambush lines); they block nothing.
//
// The plots: around each village (algEconomy points), 18-150 m out, on gentle
// ground (< 11°, < 3.5 m of relief), off the tracks, the wadi, the cliffs,
// water and every placed piece (+4 m), 4 m lanes between them, long side
// along the contour. Their scrub and grass are cleared (it is worked land).
// ?fields=0 = without.
import * as THREE from "three";
import { Fn, attribute, positionLocal, uv, sin, cos, float, vec2, vec3, vec4, mix, smoothstep, min, max, abs, fract, floor, step, normalize, varying, texture, dFdx, dFdy, log2, exp2, transformNormalToView, uniform, uniformArray, Loop, int } from "three/tsl";
import { drapeY, drapedPosition } from "../shared-rts/terrainDrape.js";
import { buildFieldWallSegment } from "../../v3/render/objects/rtsAlgVillage.js";
import { TRACK_LINES } from "./algTracks.js";
import { LAYOUT, PLAY } from "./layout.js";
import { kitView } from "./showroom.js";
import { FOLIAGE_PRESETS } from "../../v3/app/state/foliageScatterState.js";

/** Buildings that can clear the fields under them (the field shader's hole list). */
const MAX_HOLES = 24;

const P = {
  perVillage: { hamlet: 10, dechra: 12, ksar: 15 },
  ring: [14, 190],            // m out from the village's edge… (its site radius added)
  w: [16, 30], d: [11, 20],   // plot size, world metres
  // 11° / 3.5 m found 18 plots of 43 (the villages sit on slopes): terraced
  // hill fields are real, and the walls step down with the ground.
  maxTiltDeg: 15, maxRelief: 5.5,
  gap: 4,                     // lanes between plots and round placed pieces
  trackClear: 6,              // m from a track's centre line
  tries: 2500,
  wallSide: 0.72,             // chance a side has a wall
  seg: 2.0,                   // wall segment spacing
  hedgeSide: 0.4,             // chance of a hedge outside one more side
  // 1.6 m single file read as a row of posts: 1.05 m, and a second row
  // staggered behind it half the time — a hedge, not a fence.
  hedgeStep: 1.05, hedgeDouble: 0.5,
  trackHedge: { near: 150, offset: 4.2, run: [24, 60], every: 0.55 },
  concealR: 1.8,
};
const KINDS = [["plough", 0.45], ["stubble", 0.35], ["green", 0.2]];

/** A seeded random stream (the same fields every load). */
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

export function createAlgFields(app, { economy, navGrid = null, showroom = {}, plants = null }) {
  const R = rng(19560);
  const H = (x, z) => app.getWorldHeight(x, z);
  const cosTilt = Math.cos((P.maxTiltDeg * Math.PI) / 180);

  // ── What is already there (oriented boxes, world) ─────────────────────────
  const boxes = [];
  for (const m of Object.values(showroom)) {
    const fp = m?.isObject3D ? m.geometry?.userData?.footprint : null;
    if (!fp || !m.parent) continue;
    const c = Math.cos(m.rotation.y), s = Math.sin(m.rotation.y);
    boxes.push({ x: m.position.x + fp.cx * c + fp.cz * s, z: m.position.z - fp.cx * s + fp.cz * c, hx: fp.hx, hz: fp.hz, yaw: m.rotation.y });
  }
  for (const s of LAYOUT.sites) if (s.kind === "french" || s.kind === "aln") boxes.push({ x: s.x, z: s.z, hx: s.r + 20, hz: s.r + 20, yaw: 0 });
  // Separating-axis test for two oriented rectangles, `gap` apart at least.
  const axes = (b) => [[Math.cos(b.yaw), -Math.sin(b.yaw)], [Math.sin(b.yaw), Math.cos(b.yaw)]];
  const overlaps = (a, b, gap) => {
    for (const [ax, az] of [...axes(a), ...axes(b)]) {
      const proj = (r) => {
        const [u, v] = axes(r);
        return Math.abs(u[0] * ax + u[1] * az) * r.hx + Math.abs(v[0] * ax + v[1] * az) * r.hz;
      };
      const d = Math.abs((b.x - a.x) * ax + (b.z - a.z) * az);
      if (d > proj(a) + proj(b) + gap) return false;
    }
    return true;
  };
  const trackPts = TRACK_LINES.flatMap((t) => t.line);
  const nearTrack = (x, z, r) => trackPts.some((p) => Math.abs(p.x - x) < r && Math.abs(p.z - z) < r && Math.hypot(p.x - x, p.z - z) < r);
  const toWorld = (b, lx, lz) => { const c = Math.cos(b.yaw), s = Math.sin(b.yaw); return [b.x + lx * c + lz * s, b.z - lx * s + lz * c]; };

  function plotOk(b) {
    if (boxes.some((o) => overlaps(b, o, P.gap))) return false;
    let lo = Infinity, hi = -Infinity;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const [x, z] = toWorld(b, (i / 2) * b.hx, (j / 2) * b.hz);
      if (!(x > PLAY.x0 + 8 && x < PLAY.x1 - 8 && z > PLAY.z0 + 8 && z < PLAY.z1 - 8)) return false;
      const h = H(x, z);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
      if ((app.getWaterLevelAt?.(x, z) ?? -Infinity) > h - 0.3) return false;
      if ((app.getWorldNormal?.(x, z)?.y ?? 1) < cosTilt) return false;
      const w = app.samplePaintWeights?.(x, z);
      if (w && (w[4] > 0.35 || w[5] > 0.3 || w[6] > 0.25 || w[3] > 0.4)) return false;   // wadi, cliff, track, oasis grove
      if (navGrid?.isBlockedAtWorld?.(x, z)) return false;
      if (nearTrack(x, z, P.trackClear)) return false;
    }
    return hi - lo <= P.maxRelief;
  }

  // ── The plots ─────────────────────────────────────────────────────────────
  const plots = [];
  for (const v of economy.points) {
    const site = LAYOUT.sites.find((s) => s.name === v.name);
    const r0 = (site?.r ?? 35) + P.ring[0], r1 = P.ring[1];
    const want = P.perVillage[v.kind] ?? 9;
    let got = 0;
    for (let t = 0; t < P.tries && got < want; t++) {
      const a = R() * Math.PI * 2, r = r0 + Math.sqrt(R()) * (r1 - r0);
      const x = v.position.x + Math.cos(a) * r, z = v.position.z + Math.sin(a) * r;
      // Long side along the contour (or the village's own lines on the flat).
      const gx = H(x + 2, z) - H(x - 2, z), gz = H(x, z + 2) - H(x, z - 2), g = Math.hypot(gx, gz);
      const yaw = g > 0.25 ? Math.atan2(gx / g, -gz / g) : (site?.turn ?? 0) * (Math.PI / 180) + (R() - 0.5) * 0.4;
      const w = P.w[0] + R() * (P.w[1] - P.w[0]), d = P.d[0] + R() * (P.d[1] - P.d[0]);
      const b = { x, z, hx: w / 2, hz: d / 2, yaw };
      if (!plotOk(b)) continue;
      let u = R(), kind = KINDS[0][0];
      for (const [k, p] of KINDS) { if ((u -= p) <= 0) { kind = k; break; } }
      b.kind = kind;
      b.seed = R();
      plots.push(b);
      boxes.push(b);
      got++;
    }
  }

  // ── Their ground: one draped draw ─────────────────────────────────────────
  const surface = buildSurface(app, plots);

  // ── The walls: instanced segments ─────────────────────────────────────────
  const variants = [1964, 1965, 1966].map((seed) => buildFieldWallSegment({ seed }));
  const segs = [[], [], []];   // per variant: matrices
  const cover = [];            // { x, z }
  const hedge = [];            // [x, z]
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), qz = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  const Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
  for (const b of plots) {
    // The four sides, each as [from, to] in plot-local metres, outward normal.
    const sides = [
      { a: [-b.hx, -b.hz], c: [b.hx, -b.hz], n: [0, -1] },
      { a: [b.hx, -b.hz], c: [b.hx, b.hz], n: [1, 0] },
      { a: [b.hx, b.hz], c: [-b.hx, b.hz], n: [0, 1] },
      { a: [-b.hx, b.hz], c: [-b.hx, -b.hz], n: [-1, 0] },
    ];
    const walled = sides.map(() => R() < P.wallSide);
    if (!walled.some(Boolean)) walled[Math.floor(R() * 4)] = true;
    const gateSide = walled.findIndex(Boolean);
    sides.forEach((sd, k) => {
      const L = Math.hypot(sd.c[0] - sd.a[0], sd.c[1] - sd.a[1]);
      const dir = [(sd.c[0] - sd.a[0]) / L, (sd.c[1] - sd.a[1]) / L];
      if (walled[k]) {
        const gate = k === gateSide ? L * (0.25 + R() * 0.5) : -99;
        for (let s = P.seg / 2; s < L - 0.3; s += P.seg) {
          if (Math.abs(s - gate) < 1.8) continue;               // the gate: a 3.6 m gap
          const lx = sd.a[0] + dir[0] * s, lz = sd.a[1] + dir[1] * s;
          const [x, z] = toWorld(b, lx, lz);
          // Along the wall: its yaw; and the slope along it, so it steps down a hill.
          const wy = b.yaw + Math.atan2(-dir[1], dir[0]);
          const [x0, z0] = toWorld(b, lx - dir[0], lz - dir[1]), [x1, z1] = toWorld(b, lx + dir[0], lz + dir[1]);
          const pitch = Math.atan2(H(x1, z1) - H(x0, z0), 2);
          q.setFromAxisAngle(Y, wy).multiply(qz.setFromAxisAngle(Z, pitch * 0.8));
          const vi = Math.floor(R() * 3);
          segs[vi].push(m4.compose(new THREE.Vector3(x, H(x, z) - 0.06, z), q, one).clone());
          cover.push({ x, z });
        }
      } else if (R() < P.hedgeSide) {
        // A hedge outside an open side.
        for (let s = 0.5; s < L - 0.3; s += P.hedgeStep) {
          if (R() < 0.12) continue;
          const lx = sd.a[0] + dir[0] * s + sd.n[0] * 1.1, lz = sd.a[1] + dir[1] * s + sd.n[1] * 1.1;
          hedge.push(toWorld(b, lx + (R() - 0.5) * 0.3, lz + (R() - 0.5) * 0.3));
          // The second, staggered row, further out.
          if (R() < P.hedgeDouble) hedge.push(toWorld(b, lx + sd.n[0] * 0.8 + dir[0] * 0.5, lz + sd.n[1] * 0.8 + dir[1] * 0.5));
        }
      }
    });
  }
  const walls = variants.map((geo, i) => {
    const mesh = new THREE.InstancedMesh(geo, kitView(geo).material, Math.max(1, segs[i].length));
    segs[i].forEach((m, k) => mesh.setMatrixAt(k, m));
    mesh.count = segs[i].length;
    mesh.name = `FieldWalls${i}`;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    app.scene.add(mesh);
    return mesh;
  });

  // ── Hedges along the pistes near the villages ─────────────────────────────
  const TH = P.trackHedge;
  for (const t of TRACK_LINES) {
    let run = 0, side = R() < 0.5 ? 1 : -1, on = false;
    for (let i = 1; i < t.line.length; i++) {
      const p = t.line[i], q0 = t.line[i - 1];
      const near = economy.points.some((v) => Math.hypot(v.position.x - p.x, v.position.z - p.z) < TH.near);
      if (!near) { on = false; continue; }
      if (run <= 0) { on = R() < TH.every; side = -side; run = TH.run[0] + R() * (TH.run[1] - TH.run[0]); }
      const step = Math.hypot(p.x - q0.x, p.z - q0.z);
      run -= step;
      if (!on) continue;
      const tx = (p.x - q0.x) / (step || 1), tz = (p.z - q0.z) / (step || 1);
      for (let s = 0; s < step; s += P.hedgeStep) {
        if (R() < 0.15) continue;
        const x = q0.x + tx * s + tz * TH.offset * side, z = q0.z + tz * s - tx * TH.offset * side;
        if ((app.getWaterLevelAt?.(x, z) ?? -Infinity) > H(x, z) - 0.3 || navGrid?.isBlockedAtWorld?.(x, z)) continue;
        if (boxes.some((o) => overlaps({ x, z, hx: 0.6, hz: 0.6, yaw: 0 }, o, 0.5))) continue;
        hedge.push([x + (R() - 0.5) * 0.3, z + (R() - 0.5) * 0.3]);
        if (R() < P.hedgeDouble) hedge.push([x + tz * 0.8 * side + tx * 0.5, z - tx * 0.8 * side + tz * 0.5]);
      }
    }
  }
  if (plants) {
    // The showroom registers it when a garden has a hedge; here otherwise.
    if (!plants.types.has("pricklyPear")) plants.setType("pricklyPear", structuredClone(FOLIAGE_PRESETS.pricklyPear));
    hedge.forEach(([x, z], k) => {
      const f = k * 0.618;
      plants.add("pricklyPear", x, H(x, z) - 0.05, z, { rotY: f * 7, scale: 0.75 + (f % 1) * 0.5, seed: (f + 0.29) % 1 });
    });
  }

  // ── Worked land: no scrub, no tufts, no stones in the fields ──────────────
  for (const b of plots) {
    const r = Math.min(b.hx, b.hz) * 0.95;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const [x, z] = toWorld(b, i * b.hx * 0.55, j * b.hz * 0.55);
      app.clearVegetation?.(x, z, r, { grass: b.kind === "green" ? 0 : r, edge: 0.7 });
    }
  }
  const inPlot = (x, z) => plots.some((b) => {
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw), dx = x - b.x, dz = z - b.z;
    return Math.abs(c * dx - s * dz) < b.hx + 0.5 && Math.abs(s * dx + c * dz) < b.hz + 0.5;
  });
  const stonesCleared = app.algStones?.clearWhere?.(inPlot) ?? 0;

  // ── Concealment beside the hedges (a 6 m hash of their points) ────────────
  const CELL = 6, hash = new Map();
  for (const [x, z] of hedge) {
    const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    (hash.get(k) ?? hash.set(k, []).get(k)).push(x, z);
  }
  function concealAt(x, z) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL), r2 = P.concealR * P.concealR;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const a = hash.get(`${cx + i},${cz + j}`);
      if (!a) continue;
      for (let k = 0; k < a.length; k += 2) if ((a[k] - x) ** 2 + (a[k + 1] - z) ** 2 < r2) return 0.9;
    }
    return 0;
  }

  return {
    params: P, plots, walls, surface, hedge,
    concealAt,
    /** A building put down here clears the field under it (algBuild.js). */
    cutHole: (x, z, hx, hz, yaw) => surface?.userData?.cutHole?.(x, z, hx, hz, yaw) ?? false,
    /** Hard cover along the walls, for the cover bake (algCover.js). */
    *coverCircles() { for (const c of cover) yield { x: c.x, z: c.z, radius: 1.1, size: 0.8, hard: true }; },
    stats: { plots: plots.length, wallSegments: cover.length, hedgePlants: hedge.length, stonesCleared },
  };
}

/**
 * One instanced, draped quad per field — PHOTOGRAPHED soil (you, 2026-10-02:
 * the procedural soil "looks not realistic compared to the image textures we
 * use in the game"). ONE draw for every field on the map.
 *
 * The four Poly Haven (CC0) sets of tools/fetchFieldMaterials.mjs, in one 2x2
 * atlas pair (colour; normal + height): ploughed furrows, raked stubble,
 * sparse grass (the crop), farm soil. A field reads its own cell and the soil
 * cell — 4 taps — tinted to this valley's earth:
 *   PLOUGHED  the furrow photo, scaled up so a furrow is ~1.3 m (real ones
 *             are under a pixel at play zoom); tiled MIRRORED across the rows
 *             (the photo is a patch, cropped to its clean middle).
 *   STUBBLE   raked earth with straw on it, warmed toward straw.
 *   BARLEY    the grass photo in rows over the soil photo, gaps where it failed.
 *   HEADLAND  2-3 m of plain soil round every field, where the plough turned.
 * Each photo's normal map lights it with our sun, laid on the TERRAIN'S
 * normal (4 heightmap taps a vertex). The mip level is chosen here and capped,
 * and the cell is inset by half a texel of it, so the atlas cells never bleed
 * into each other.
 */
const FIELD_ATLAS = { c: "/textures/fields/fields_c.webp", n: "/textures/fields/fields_n.webp", cell: 1024, maxLod: 5 };
/** Metres a tile covers, per atlas cell (plough, stubble, crop, soil). */
const TILE_M = [6.5, 4, 3, 3];

function buildSurface(app, plots) {
  const N = Math.max(1, plots.length);
  const src = new THREE.PlaneGeometry(1, 1, 16, 16).rotateX(-Math.PI / 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = src.index;
  geo.setAttribute("position", src.attributes.position);
  geo.setAttribute("uv", src.attributes.uv);
  const a0 = new Float32Array(N * 4), a1 = new Float32Array(N * 4);
  const KIND = { plough: 0, stubble: 1, green: 2 };
  plots.forEach((b, i) => {
    a0.set([b.x, b.z, b.yaw, b.hx * 2], i * 4);
    a1.set([b.hz * 2, KIND[b.kind], b.seed, 0], i * 4);
  });
  geo.setAttribute("aField", new THREE.InstancedBufferAttribute(a0, 4));
  geo.setAttribute("aField2", new THREE.InstancedBufferAttribute(a1, 4));
  geo.instanceCount = plots.length;

  const load = (url, srgb) => {
    const t = new THREE.TextureLoader().load(url);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    return t;
  };
  const texC = load(FIELD_ATLAS.c, true), texN = load(FIELD_ATLAS.n, false);

  // LIT and opaque-ish, its own soil: worked soil REPLACES the ground; the sun
  // and the shadows light it like the terrain (receiveShadow).
  const mat = new THREE.MeshStandardNodeMaterial({
    transparent: true, depthTest: true, depthWrite: false, roughness: 1, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  mat.forceSinglePass = true;
  const HT = app.heightTexNode;
  const vN = varying(vec3(0, 1, 0), "vFieldGroundN");
  const vW = varying(vec2(0, 0), "vFieldWorld");
  // HOLES (2026-10-03, you: "the field stays on top of the construction"):
  // a building put down on a field clears it under its footprint (+0.6 m),
  // as CoH does. Up to MAX_HOLES rectangles: (x, z, cos, sin) + (hx, hz).
  const holeA = Array.from({ length: MAX_HOLES }, () => new THREE.Vector4(0, 0, 1, 0));
  const holeB = Array.from({ length: MAX_HOLES }, () => new THREE.Vector4(0, 0, 0, 0));
  const uHoleA = uniformArray(holeA, "vec4"), uHoleB = uniformArray(holeB, "vec4");
  const uHoles = uniform(0);
  mat.positionNode = Fn(() => {
    const f = attribute("aField", "vec4"), f2 = attribute("aField2", "vec4");
    const s = sin(f.z), c = cos(f.z);
    const lx = positionLocal.x.mul(f.w), lz = positionLocal.z.mul(f2.x);
    const wx = lx.mul(c).add(lz.mul(s)).add(f.x), wz = lz.mul(c).sub(lx.mul(s)).add(f.y);
    // The terrain's normal under the vertex (central differences, 1 m).
    const hx = drapeY(HT, wx.sub(1), wz).sub(drapeY(HT, wx.add(1), wz));
    const hz = drapeY(HT, wx, wz.sub(1)).sub(drapeY(HT, wx, wz.add(1)));
    vN.assign(normalize(vec3(hx, float(2), hz)));
    vW.assign(vec2(wx, wz));
    return drapedPosition(HT, wx, wz, 0.1);
  })();

  // ── The field's terms (fragment), shared by the colour and the normal ────
  const f = attribute("aField", "vec4"), f2 = attribute("aField2", "vec4");
  const mx = uv().x.mul(f.w), mz = uv().y.mul(f2.x);          // metres across the plot
  const kind = f2.y, seed = f2.z;
  const isPlough = float(1).sub(smoothstep(0.5, 0.6, kind)), isGreen = smoothstep(1.5, 1.6, kind);
  const isStub = float(1).sub(isPlough).sub(isGreen);
  const edgeM = min(min(mx, f.w.sub(mx)), min(mz, f2.x.sub(mz)));
  const rag = sin(mx.mul(1.3).add(mz.mul(0.9)).add(seed.mul(31))).mul(0.35);
  const rows = smoothstep(1.8, 3.2, edgeM.add(rag.mul(1.5)));   // 0 on the headland, 1 in the field

  // Tile coordinates (continuous; a per-field offset so no two fields match).
  const tileM = mix(mix(float(TILE_M[0]), float(TILE_M[1]), isStub), float(TILE_M[2]), isGreen);
  const off = vec2(seed.mul(7.13), seed.mul(3.71));
  const tMain = vec2(mx, mz).div(tileM).add(off);
  const tSoil = vec2(mx, mz).div(TILE_M[3]).add(off.yx);
  // Ploughed: tiled MIRRORED both ways (the photo is cropped groove to
  // groove down the rows, so a seam there is a groove meeting itself).
  const tri = (x) => float(1).sub(fract(x.mul(0.5)).mul(2).sub(1).abs());
  const signOf = (x) => float(1).sub(step(0.5, fract(x.mul(0.5))).mul(2));          // d(tri)/dx's sign: + then −
  const mirrorSign = vec2(signOf(tMain.x), signOf(tMain.y));
  const lMain = mix(fract(tMain), vec2(tri(tMain.x), tri(tMain.y)), isPlough);
  const lSoil = fract(tSoil);
  const cellMain = kind.round();
  // The mip level from the continuous coordinates (one cell = cell px), capped.
  const lodOf = (t) => {
    const dx = dFdx(t).mul(FIELD_ATLAS.cell), dy = dFdy(t).mul(FIELD_ATLAS.cell);
    return log2(max(max(dx.dot(dx), dy.dot(dy)).sqrt(), 1)).clamp(0, FIELD_ATLAS.maxLod);
  };
  const lodMain = lodOf(tMain), lodSoil = lodOf(tSoil);
  // A cell's uv in the atlas (row 0 at the top of the image: v from 0.5 up).
  const atlasUV = (cell, l, lod) => {
    const inset = exp2(lod).mul(0.5 / FIELD_ATLAS.cell);
    const q = l.clamp(inset, float(1).sub(inset));
    const col = cell.mod(2), row = floor(cell.div(2));
    return vec2(col.add(q.x).div(2), float(1).sub(row).add(q.y).div(2));
  };
  const uvMain = atlasUV(cellMain, lMain, lodMain), uvSoil = atlasUV(float(3), lSoil, lodSoil);
  const cMain = texture(texC, uvMain).level(lodMain).xyz, cSoil = texture(texC, uvSoil).level(lodSoil).xyz;
  const nMain = texture(texN, uvMain).level(lodMain).xyz, nSoil = texture(texN, uvSoil).level(lodSoil).xyz;

  // ROWS read from the RTS camera, on the photos (CoH does the same): the
  // crop in rows (1.1 m, wavy) with gaps, soil between; the stubble in straw
  // bands (windrows, 1.4 m) with soil showing between. Ploughed: its own.
  const wav = sin(mx.mul(0.21).add(seed.mul(40))).mul(0.3);
  const crest = cos(fract(mz.add(wav).div(mix(float(1.1), float(1.4), isStub))).mul(Math.PI * 2)).mul(0.5).add(0.5);
  const gaps = smoothstep(-0.3, 0.3, sin(mx.mul(0.37).add(seed.mul(11))).add(sin(mx.mul(0.91).add(mz.mul(0.23)).add(seed.mul(5))).mul(0.6)));
  const cropMask = float(1).sub(isGreen).sub(isStub)
    .add(smoothstep(0.25, 0.65, crest).mul(gaps.mul(0.6).add(0.4)).mul(isGreen))
    .add(smoothstep(0.15, 0.7, crest).mul(0.65).add(0.35).mul(isStub));
  // How much of the field's own photo shows (the rest: plain soil).
  const own = rows.mul(cropMask);
  // Big soft patches (moister, drier): a field is not a flat print.
  const patch = sin(mx.mul(0.13).add(seed.mul(17))).mul(sin(mz.mul(0.17).add(seed.mul(9)))).mul(0.5).add(0.5);

  // ── Colour: the photos, tinted to this valley's earth (linear) ───────────
  const TINT_PLOUGH = vec3(1.18, 1.02, 0.86), TINT_STUB = vec3(1.55, 1.32, 0.82), TINT_GREEN = vec3(0.8, 1.08, 0.55), TINT_SOIL = vec3(1.0, 0.92, 0.84);
  mat.colorNode = Fn(() => {
    const tint = TINT_PLOUGH.mul(isPlough).add(TINT_STUB.mul(isStub)).add(TINT_GREEN.mul(isGreen));
    // The soil between rows a little darker (shaded by the crop / damp).
    const soil = cSoil.mul(TINT_SOIL).mul(mix(float(1), float(0.78), rows.mul(float(1).sub(isPlough))));
    const col = mix(soil, cMain.mul(tint), own);
    return col.mul(mix(float(0.9), float(1.07), patch));
  })();

  // ── Normal: the photo's, on the terrain's (the plot's axes as tangents) ──
  mat.normalNode = Fn(() => {
    const decode = (n) => vec2(n.x.mul(2).sub(1), n.y.mul(2).sub(1));
    const nm = decode(nMain).mul(mix(vec2(1, 1), mirrorSign, isPlough));
    const nt = mix(decode(nSoil), nm, own).mul(1.4);                    // a little stronger: the RTS camera is far
    const s = sin(f.z), c = cos(f.z);
    const ax = vec3(c, 0, s.negate()), az = vec3(s, 0, c);               // the plot's x (u) and z (v) in the world
    return transformNormalToView(normalize(vN.add(ax.mul(nt.x)).add(az.mul(nt.y))));
  })();
  // Feathered, uneven edges (a worked field has no ruled border).
  mat.opacityNode = Fn(() => {
    const keep = float(1).toVar();
    Loop({ start: int(0), end: int(uHoles) }, ({ i }) => {
      const A = uHoleA.element(i), B = uHoleB.element(i);
      const d = vW.sub(A.xy);
      const lx = abs(d.x.mul(A.z).sub(d.y.mul(A.w))), lz = abs(d.x.mul(A.w).add(d.y.mul(A.z)));
      // Soft by 0.5 m outside the footprint.
      const out = max(lx.sub(B.x), lz.sub(B.y));
      keep.mulAssign(smoothstep(0, 0.5, out));
    });
    return smoothstep(0.2, 1.5, edgeM.add(rag)).mul(0.97).mul(keep);
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "FieldSurfaces";
  mesh.renderOrder = 40;      // under the tyre marks (41) and craters (42)
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;    // lit like the ground round it
  app.scene.add(mesh);
  /** Clear the fields under a footprint (centre, half sizes, yaw); false when full. */
  mesh.userData.cutHole = (x, z, hx, hz, yaw = 0) => {
    const n = uHoles.value;
    if (n >= MAX_HOLES) return false;
    holeA[n].set(x, z, Math.cos(yaw), Math.sin(yaw));
    holeB[n].set(hx + 0.6, hz + 0.6, 0, 0);
    uHoles.value = n + 1;
    return true;
  };
  return mesh;
}
