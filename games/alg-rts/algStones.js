// STONES THAT BELONG TO THE GROUND (you, 2026-09-29/30): loose stones whose
// colour and grain are the ground layers' OWN — each kind of stone is
// textured with the very photo of the layer it lies on (triplanar), so a
// scree stone is the scree, a ridge boulder the ridge's limestone, a wadi
// stone the bed's pebbles. The kit's grey fieldStone read foreign.
//
// Shapes: the engine's chipped-egg generator (v3/props/proceduralRock.js,
// the editor's rock kit), at lower triangle budgets for scattering.
// Placement: read from the map's paint (app.samplePaintWeights):
//
//   scree (slot 2)      many small stones and pebbles
//   limestone (1)       lumps and boulders, fewer
//   valley soil (0)     a stone here and there
//   wadi bed (4)        rounded stones (fewer chips) in the dry bed
//   piste (6) EDGES     gravel along the shoulders, never on the running
//                       surface (the paint's weight between 0.08 and 0.55)
//
// Each stone is SUNK 20-35% of its height and tilted to the slope — stones
// are buried, not placed (nam-rts's rocks lesson). None inside a building's
// footprint (the nav grid), in water, on the oasis grove or outside PLAY.
// One InstancedMesh per (ground, shape): ~14 draws, no per-frame work.
import * as THREE from "three";
import { abs, float, normalWorld, positionWorld, pow, texture, vec2, vec3 } from "three/tsl";
import { createRockGeometry } from "../../v3/props/proceduralRock.js";
import { simplifierReady } from "../../v3/render/instancing/autoLod.js";
import { PLAY } from "./layout.js";

const TEX = (id, m) => `/textures/ground/${id}/${id}_${m}_1k.jpg`;

/** Per ground: its photo, how many stones per 100 m² at full weight, of which shapes. */
const GROUNDS = {
  scree:     { slot: 2, id: "rocks_ground_02",        tint: "#ffffff", per100: 5.5, shapes: [["pebble", 0.55], ["rock", 0.4], ["lump", 0.05]] },
  limestone: { slot: 1, id: "rock_boulder_dry", tint: "#ffffff", per100: 1.2, shapes: [["rock", 0.45], ["lump", 0.35], ["boulder", 0.2]] },
  soil:      { slot: 0, id: "brown_mud_dry",        tint: "#ffffff", per100: 0.35, shapes: [["pebble", 0.6], ["rock", 0.4]] },
  wadi:      { slot: 4, id: "rocky_trail",          tint: "#f4ece0", per100: 4.0, shapes: [["cobble", 0.7], ["pebble", 0.3]] },
  gravel:    { slot: 6, id: "dry_mud_field_001",    tint: "#eadcc4", per100: 9.0, shapes: [["pebble", 0.8], ["rock", 0.2]], edge: [0.08, 0.55] },
};

/** The shapes: the rock kit's classes, lighter, a few variants each. */
const SHAPES = {
  pebble:  { size: [0.16, 0.09, 0.13], tris: 48,  seeds: [3, 7],  extra: { chips: 10, detail: 12, simplifyError: 0.3 } },
  rock:    { size: [0.42, 0.27, 0.35], tris: 120, seeds: [2, 5],  extra: { chips: 18, detail: 20, baseCut: 0.18, simplifyError: 0.15 } },
  lump:    { size: [0.9, 0.6, 0.75],   tris: 360, seeds: [1, 4],  extra: { chips: 32, bigCuts: 3, baseCut: 0.2, detail: 30 } },
  boulder: { size: [0.85, 1.05, 0.75], tris: 520, seeds: [6],     extra: { chips: 40, bigCuts: 4, detail: 32 } },
  // River stones: few shallow chips, round egg — water-worn.
  cobble:  { size: [0.24, 0.13, 0.19], tris: 64,  seeds: [8, 9],  extra: { chips: 5, chipMax: 0.06, edgeSoft: 0.03, egg: 0.02, detail: 14, simplifyError: 0.25 } },
};

/** The stone material for a ground: its photo, triplanar, a tile per ~0.9 m. */
function stoneMaterial(g) {
  const load = (url, srgb) => { const t = new THREE.TextureLoader().load(url); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 4; return t; };
  const albedo = load(TEX(g.id, "diff"), true);
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  mat.name = `Stone:${g.id}`;
  const S = float(1 / 0.9);
  const w0 = pow(abs(normalWorld), vec3(4));
  const w = w0.div(w0.x.add(w0.y).add(w0.z));
  const p = positionWorld.mul(S);
  const c = texture(albedo, vec2(p.z, p.y)).rgb.mul(w.x)
    .add(texture(albedo, vec2(p.x, p.z)).rgb.mul(w.y))
    .add(texture(albedo, vec2(p.x, p.y)).rgb.mul(w.z));
  const t = new THREE.Color(g.tint);
  // A shade lighter than the ground photo: a stone's top catches the sun the
  // flat ground photo already had baked in its shadows.
  mat.colorNode = c.mul(vec3(t.r, t.g, t.b)).mul(1.12);
  return mat;
}

export async function createAlgStones(app, { seed = 1954 } = {}) {
  const t0 = performance.now();
  await simplifierReady;
  // Shapes, built once.
  const geos = {};
  for (const [k, s] of Object.entries(SHAPES)) {
    geos[k] = s.seeds.map((sd) => {
      const g = createRockGeometry({ seed: sd, sizeX: s.size[0], sizeY: s.size[1], sizeZ: s.size[2], targetTriangles: s.tris, simplifyError: 0.05, ...s.extra });
      g.computeBoundingBox();
      return g;
    });
  }
  let st = seed;
  const rnd = () => ((st = (st * 16807) % 2147483647) / 2147483647);

  // ── Where: a jittered 2 m grid over PLAY, each cell a chance per ground ──
  const CELL = 2, AREA = CELL * CELL / 100;
  const lists = {};                       // `${ground}|${shape}|${variant}` → [{x, z, s, yaw}]
  const blocked = (x, z) => app.navGrid?.isBlockedAtWorld?.(x, z);
  let n = 0;
  for (let z = PLAY.z0 + 3; z < PLAY.z1 - 3; z += CELL) {
    for (let x = PLAY.x0 + 3; x < PLAY.x1 - 3; x += CELL) {
      const w = app.samplePaintWeights?.(x, z);
      if (!w) continue;
      if (w[3] > 0.15) continue;                                       // the oasis grove
      for (const [gk, g] of Object.entries(GROUNDS)) {
        let k = w[g.slot];
        if (g.edge) k = k > g.edge[0] && k < g.edge[1] ? 1 : 0;        // the piste's shoulders only
        else if (w[6] > 0.08 && gk !== "wadi") k *= 0.1;               // not on a track
        if (k <= 0.02 || rnd() > k * g.per100 * AREA) continue;
        const px = x + (rnd() - 0.5) * CELL, pz = z + (rnd() - 0.5) * CELL;
        if (blocked(px, pz)) continue;
        const y = app.getWorldHeight(px, pz);
        if ((app.getWaterLevelAt?.(px, pz) ?? -Infinity) > y - 0.05) continue;
        // The shape, by the ground's mix.
        let r = rnd(), shape = g.shapes[0][0];
        for (const [sh, share] of g.shapes) { if ((r -= share) <= 0) { shape = sh; break; } }
        const v = Math.floor(rnd() * geos[shape].length);
        const key = `${gk}|${shape}|${v}`;
        (lists[key] ??= []).push({ x: px, z: pz, y, s: 0.65 + rnd() * 0.8, yaw: rnd() * Math.PI * 2 });
        n++;
      }
    }
  }

  // ── The meshes ─────────────────────────────────────────────────────────
  const mats = {};
  const group = new THREE.Group();
  group.name = "AlgStones";
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qy = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), nv = new THREE.Vector3();
  for (const [key, list] of Object.entries(lists)) {
    const [gk, shape, v] = key.split("|");
    const geo = geos[shape][+v];
    mats[gk] ??= stoneMaterial(GROUNDS[gk]);
    const mesh = new THREE.InstancedMesh(geo, mats[gk], list.length);
    mesh.name = `Stones:${key}`;
    const hgt = geo.boundingBox.max.y - geo.boundingBox.min.y;
    list.forEach((p, i) => {
      // Tilted to the ground (halfway: a stone rests, it does not lie flat on a
      // steep face), turned, and SUNK 20-35% of its height.
      const gn = app.getWorldNormal?.(p.x, p.z);
      nv.set(gn?.x ?? 0, gn?.y ?? 1, gn?.z ?? 0).lerp(up, 0.45).normalize();
      q.setFromUnitVectors(up, nv).multiply(qy.setFromAxisAngle(up, p.yaw));
      const s = p.s * (shape === "boulder" ? 1.2 + (i % 3) * 0.3 : 1);
      pos.set(p.x, p.y - geo.boundingBox.min.y * s - hgt * s * (0.2 + ((i * 7) % 16) / 100), p.z);
      m.compose(pos, q, sc.set(s * (0.85 + ((i * 13) % 30) / 100), s, s));
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    // Only the big ones cast (a pebble's shadow is a pixel; the shadow pass isn't free).
    mesh.castShadow = shape === "lump" || shape === "boulder";
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  app.scene.add(group);
  const counts = {};
  for (const [key, list] of Object.entries(lists)) { const gk = key.split("|")[0]; counts[gk] = (counts[gk] ?? 0) + list.length; }
  console.log(`[stones] ${n} stones in ${group.children.length} draws (${Object.entries(counts).map(([k, c]) => `${k} ${c}`).join(", ")}) in ${Math.round(performance.now() - t0)} ms`);
  return { group, counts, total: n };
}
