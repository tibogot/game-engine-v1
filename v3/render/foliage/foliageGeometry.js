/**
 * Foliage plants built from numbers — no textures, no alpha test.
 *
 * Same reasoning as the flowers (flowerGeometry.js): the silhouette IS the
 * geometry, so a fern's fronds stay crisp at any distance, antialias with MSAA
 * like any mesh edge, and never shimmer the way an alpha-tested card does. No
 * fragment is discarded, so hidden plants are rejected by the depth test before
 * they are shaded — which matters when a field holds tens of thousands.
 *
 * A FERN, the way game fern packs build it: fronds radiate from one crown,
 * spreading wide and arching down. Each frond is a stalk (rachis) that is bare
 * for its first stretch, then carries LEAFLETS down both sides — separate,
 * elongated, round-tipped blades, alternating left and right, pointing forward
 * toward the frond's tip, smallest at the base and the tip, longest a third of
 * the way along. Every leaflet is its own little strip.
 *
 * One plant in a unit frame: base at the origin, about 1 unit across. The
 * vertex shader scales it, bends it with the wind and places it per plant.
 *
 * Attributes
 *   position, normal, uv
 *   aPlant vec4 = (part, t, rand, along)
 *     part   0 leaflet / blade (thin: flutters, lets light through)
 *            1 stalk (solid)
 *     t      how far along its frond this vertex hangs, 0 crown → 1 tip
 *            (the bend is stiff at the base and loose at the tip)
 *     rand   per frond, 0..1 — colour and flutter variety
 *     along  0 at a leaflet's base → 1 at its tip (flutter weight, tip colour)
 *
 * Three levels of detail, one silhouette:
 *   0 NEAR  every leaflet a strip (~1,000-1,500 triangles: a hero plant)
 *   1 MID   one sheet per frond side, its edge cut into leaflets (~300)
 *   2 FAR   the same sheet uncut, fewer fronds (~100)
 */
import * as THREE from "three";
import { buildBamboo } from "./bambooGeometry.js";
import { buildPalm } from "./palmGeometry.js";
import { buildJungleTree } from "./jungleTreeGeometry.js";
import { buildAreca } from "./arecaGeometry.js";
import { buildFanPalm } from "./fanPalmGeometry.js";
import { buildCardFern } from "./fernCardGeometry.js";
import { buildBanana } from "./bananaGeometry.js";
import { buildTravellersPalm } from "./travellersPalmGeometry.js";
import { buildBanyan } from "./banyanGeometry.js";
import { buildDipterocarp } from "./dipterocarpGeometry.js";
import { buildAtlasCedar } from "./cedarGeometry.js";
import { buildBetoum } from "./betoumGeometry.js";
import { buildPandanus } from "./pandanusGeometry.js";

export const FOLIAGE_LODS = 3;

/**
 * ── ROUNDED LEAF NORMALS ─────────────────────────────────────────────────────
 *
 * Diagnosed 2026-09-20 in the editor: with the foliage not casting shadows at
 * all, a fern field still went black under a 14° sun. Every leaf's shading
 * normal was bent 95% to straight UP in the shader (foliageSystem.js), so at
 * a low sun NO leaf faced the light — only the stalks, which keep their true
 * normal, showed as bright slivers. The undersides going black in the evening
 * is this, not the shadow map.
 *
 * The fix is the trick every tree renderer uses: bend each leaf's normal
 * toward the direction from the plant's CENTRE out through the leaf, so a
 * plant shades as a rounded mass — sunward side lit, far side falling off,
 * and at a low sun the leaves facing the sun still catch it. Baked here into
 * the normal attribute (free) rather than computed in the shader (which has
 * no spare uniform row for a centre). The shader then blends only about half
 * way to up, instead of 95%.
 *
 * Per kind: where the centre sits (in plant heights) and how far to round.
 * A ground rosette's centre sits BELOW the ground so every normal points up
 * and out — a hemisphere — and no leaf underside is ever lit from below by a
 * normal that points down. A bush is a near-sphere. A palm rounds only a
 * little, so its V-folded halves keep their contrast, and from the crown.
 * Stalks (part 1) and culms/trunks (part 3) keep their true normals.
 */
const LEAF_ROUNDING = {
  fern:      [-0.15, 0.7],
  cardFern:  [-0.15, 0.7],
  blades:    [0.1, 0.6],
  typha:     [0.2, 0.55],
  plume:     [0.2, 0.55],
  pampas:    [0.2, 0.55],
  susuki:    [0.2, 0.55],
  broadleaf: [0.05, 0.75],
  bush:      [0.4, 0.85],
  bamboo:    [0.75, 0.5],
  palm:      [1.0, 0.4],
  banana:    [0.8, 0.5],
  // The fan is a flat plane: round only a little, from low on the trunk so
  // even the drooping blades under the fan keep a normal that points up.
  travellersPalm: [0.3, 0.35],
  // The banyan's dome shades as ONE rounded mass, from the crown's middle:
  // the clumps on its shaded side fall off into the dark, as in every photo.
  banyan:    [0.55, 0.8],
  // The dipterocarp's clumps already carry their own SUB-CROWN's normal
  // (each head shades as a ball); round only a little toward the crown's
  // middle, high up, so the heads still read as one umbrella.
  dipterocarp: [0.85, 0.3],
  // The grown tamarisk: one rounded crown, from its middle.
  tamariskTree: [0.68, 0.8],
  // The cedar's cards carry their own PLATE's normal (a shelf shades as a
  // slab); round only a touch, high up, so the tiers still read as one tree.
  atlasCedar: [0.8, 0.2],
  taro:      [0.05, 0.6],
  // Each pandanus tuft is a star of swords high on the plant: round a little,
  // from about its tufts' height, so the lit tops and hanging undersides read.
  pandanus:  [0.75, 0.35],
  // The agave's thick leaves carry their own V-section normals (the lit and
  // shaded halves of each leaf ARE its look): round only a little, so the
  // rosette still shades as one mass.
  agave:     [0.3, 0.22],
  // The prickly pear rounds from the middle of the bush (a pad keeps a little
  // of its own face, so a pad still reads as a pad).
  opuntia:   [0.45, 0.45],
  // The oleander shades as one dome, from its middle.
  oleander:  [0.5, 0.8],
  // The betoum's cards carry their own CLUMP's normal (betoumGeometry.js):
  // round only a little more, from the crown's middle, so the whole dome reads.
  betoum:    [0.62, 0.08],
  agaveMast: [0.6, 0.15],
};

function roundLeafNormals(type, P, N, A) {
  const [cyRel, k] = LEAF_ROUNDING[type.kind] ?? [0.1, 0.6];
  let h = 0;
  for (let i = 1; i < P.length; i += 3) if (P[i] > h) h = P[i];
  const cy = cyRel * Math.max(h, 0.01);
  for (let v = 0, n = A.length / 4; v < n; v++) {
    const part = A[v * 4];
    if (part > 0.5 && part < 1.5) continue;   // stalk
    if (part > 2.5 && part < 3.5) continue;   // culm / trunk
    const x = P[v * 3], y = P[v * 3 + 1] - cy, z = P[v * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    let nx = N[v * 3] * (1 - k) + (x / l) * k;
    let ny = N[v * 3 + 1] * (1 - k) + (y / l) * k;
    let nz = N[v * 3 + 2] * (1 - k) + (z / l) * k;
    const nl = Math.hypot(nx, ny, nz) || 1;
    N[v * 3] = nx / nl; N[v * 3 + 1] = ny / nl; N[v * 3 + 2] = nz / nl;
  }
}

/**
 * ── SELF-OCCLUSION (2026-10-02, the plant pass: "they look almost all too
 * flat") ──────────────────────────────────────────────────────────────────────
 *
 * Every leaf and pad took the same light, deep inside the plant or on its
 * rim, so a bush read as one green cut-out. Baked here per vertex, once, at
 * build time: the plant's vertices and triangle centres fill a coarse voxel
 * grid; from each vertex (stepped just off its own surface) 14 short rays go
 * up and out, and the share that run into the plant is its occlusion. The
 * heart, the foot and the undersides go dark; the outer tips stay lit.
 *
 * Stored in the NORMAL's LENGTH (foliageSystem reads length(normalLocal) as
 * vAO and darkens the colour by it): no extra vertex buffer — the placed
 * plants are at 6 of WebGPU's 8. Kinds without an entry keep unit normals.
 *   [strength 0..1, darkest allowed]
 */
const SELF_OCCLUSION = {
  opuntia: [1, 0.25],
  thistle: [0.7, 0.45],
  asphodel: [0.6, 0.5],
  blades: [0.7, 0.45],
  agave: [0.8, 0.4],
  agaveMast: [0.6, 0.5],
  broom: [0.8, 0.4],
  oleander: [0.9, 0.35],
  betoum: [0.85, 0.4],
  typha: [0.6, 0.5],
  // The canopy tree (alg-rts tamarisk, nam-rts dipterocarps): the crown's
  // heart and underside darker (the Plant Lab's before / after, 2026-10-02).
  dipterocarp: [0.75, 0.42],
  tamariskTree: [0.85, 0.35],
};
const AO_DIRS = (() => {
  // 14 directions over the upper hemisphere and a little below the horizon
  // (light comes from the sky and the bright ground bounce), golden spiral.
  const out = [];
  for (let i = 0; i < 14; i++) {
    const y = 1 - (i + 0.5) / 14 * 1.2;              // 1 → −0.2
    const r = Math.sqrt(Math.max(0, 1 - y * y)), a = i * 2.39996;
    out.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return out;
})();

function bakeSelfOcclusion(type, P, N, I) {
  const cfg = SELF_OCCLUSION[type.kind];
  // `selfOcclusion: false` on a type opts it out (the Plant Lab's "before").
  if (!cfg || type.selfOcclusion === false || P.length < 9) return;
  const [strength, floor] = cfg;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]);
    y0 = Math.min(y0, P[i + 1]); y1 = Math.max(y1, P[i + 1]);
    z0 = Math.min(z0, P[i + 2]); z1 = Math.max(z1, P[i + 2]);
  }
  const G = 24, cell = Math.max(x1 - x0, y1 - y0, z1 - z0, 1e-3) / G * 1.0001;
  const occ = new Uint8Array(G * G * G);
  const idx = (x, y, z) => {
    const i = Math.floor((x - x0) / cell), j = Math.floor((y - y0) / cell), k = Math.floor((z - z0) / cell);
    return i < 0 || j < 0 || k < 0 || i >= G || j >= G || k >= G ? -1 : (j * G + k) * G + i;
  };
  const mark = (x, y, z) => { const c = idx(x, y, z); if (c >= 0) occ[c] = 1; };
  for (let i = 0; i < P.length; i += 3) mark(P[i], P[i + 1], P[i + 2]);
  // Triangle centres too, so a big pad is a solid wall, not a ring of points.
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    mark((P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3);
  }
  const steps = 8;
  for (let v = 0; v < P.length; v += 3) {
    let nx = N[v], ny = N[v + 1], nz = N[v + 2];
    // Step off the vertex's own cell, out along its normal (either side of a
    // thin leaf: the ray loop below starts from both and keeps the brighter).
    let best = 0;
    for (const side of [1, -1]) {
      const sx = P[v] + nx * cell * 1.2 * side, sy = P[v + 1] + ny * cell * 1.2 * side, sz = P[v + 2] + nz * cell * 1.2 * side;
      let open = 0, n = 0;
      for (const d of AO_DIRS) {
        // Only rays leaving on this side: a ray back into the leaf's own
        // surface would darken every pad that faces sideways.
        if ((d[0] * nx + d[1] * ny + d[2] * nz) * side < -0.05) continue;
        n++;
        let hit = false;
        for (let s = 1; s <= steps && !hit; s++) {
          const c = idx(sx + d[0] * cell * s, sy + d[1] * cell * s, sz + d[2] * cell * s);
          if (c >= 0 && occ[c]) hit = true;
        }
        if (!hit) open++;
      }
      if (n) best = Math.max(best, open / n);
    }
    const ao = Math.max(floor, 1 - (1 - best) * strength);
    N[v] = nx * ao; N[v + 1] = ny * ao; N[v + 2] = nz * ao;
  }
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

/**
 * The curve a frond follows: starts leaning out of the crown, arches over and
 * droops. Points with the angle from vertical at each.
 */
function archCurve(rows, len, tilt, arch) {
  const pts = [];
  let r = 0, y = 0;
  const ds = len / rows;
  for (let j = 0; j <= rows; j++) {
    const v = j / rows;
    // A continuous arch, steepening toward the drooping tip.
    const th = tilt + arch * Math.pow(v, 1.5);
    pts.push({ v, r, y, th });
    const thm = tilt + arch * Math.pow((j + 0.5) / rows, 1.5);
    r += Math.sin(thm) * ds;
    y += Math.cos(thm) * ds;
  }
  return pts;
}

/**
 * @param {object} type  a foliage type (see foliageScatterState.js)
 * @param {{ lod?: number }} [o]  0 near · 1 mid · 2 far
 * @returns {{ geometry: THREE.BufferGeometry, triangles: number }}
 */
/**
 * Which alpha-card texture a kind's card parts use, or null for a plant that
 * is solid geometry throughout. foliageSystem.js keeps one material per key.
 *   plume  part 2 heads — pampas, susuki (plumeTexture.js)
 *   spray  part 4 sprays — bamboo (bambooSprayTexture.js)
 *   frond  part 5 half-fronds — palm, areca (palmFrondTexture.js)
 *   fan    part 5 leaf blades — the palmate palms (fanLeafTexture.js)
 *   fern   part 5 half-fronds — the card fern (fernFrondTexture.js)
 */
export function cardTextureOf(kind) {
  switch (kind) {
    case "pampas": case "susuki": case "tamariskTree": return "plume";
    case "bamboo": return "spray";
    case "palm": case "areca": return "frond";
    case "fanPalm": return "fan";
    case "bush": case "broadleaf": case "oleander": return "lance";
    case "jungleTree": return "canopy";
    case "cardFern": return "fern";
    case "banana": case "travellersPalm": return "banana";
    // Sprays of real leaves with sky between them (leafSprayCard.js) — the
    // banyan card's solid blob made both crowns read as green sheets.
    case "banyan": case "dipterocarp": return "leafSpray";
    case "betoum": return "betoumLeaf";
    // Rosettes of short needles in flat mats (cedarNeedleTexture.js).
    case "atlasCedar": return "needle";
    case "taro": return "taro";
    default: return null;
  }
}

/** Plants whose head is drawn with the plume strand texture (their own, alpha-tested material). */
export function usesPlumeTexture(kind) {
  return cardTextureOf(kind) === "plume";
}

export function createFoliageTypeGeometry(type, { lod = 0, variant = 0 } = {}) {
  const near = lod === 0, far = lod === 2;
  const P = [], N = [], UV = [], A = [], I = [];
  // A shape variant is the same plant grown from another seed (variant 0 =
  // the seed every plant always had).
  const rand = rng(131 + Math.round((type.fronds ?? 7) * 37 + (type.arch ?? 1) * 500 + (type.leaflets ?? 10) * 11) + variant * 7919);

  const push = (p, n, u, v, a) => {
    P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); UV.push(u, v); A.push(a[0], a[1], a[2], a[3]);
    return P.length / 3 - 1;
  };
  const vcount = () => P.length / 3;
  const finish = () => {
    roundLeafNormals(type, P, N, A);
    bakeSelfOcclusion(type, P, N, I);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(P), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(N), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(UV), 2));
    geometry.setAttribute("aPlant", new THREE.BufferAttribute(new Float32Array(A), 4));
    geometry.setIndex(I);
    return { geometry, triangles: I.length / 3 };
  };

  // Plants that are not pinnate have their own builders.
  if (type.kind === "bamboo") return buildBamboo(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "palm") return buildPalm(type, { near, far, rand, push, vcount, I, finish, variant });
  if (type.kind === "jungleTree") return buildJungleTree(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "areca") return buildAreca(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "fanPalm") return buildFanPalm(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "cardFern") return buildCardFern(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "banana" || type.kind === "taro") return buildBanana(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "travellersPalm") return buildTravellersPalm(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "banyan") return buildBanyan(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "dipterocarp") return buildDipterocarp(type, { near, far, rand, push, vcount, I, finish });
  // The new tamarisk TREE (2026-10-02): its own grown skeleton + weeping
  // sprays (buildTamariskTree); the old "tamarisk" (dipterocarp) is untouched.
  if (type.kind === "betoum") return buildBetoum(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "tamariskTree") return buildTamariskTree(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "atlasCedar") return buildAtlasCedar(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "pandanus") return buildPandanus(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "opuntia") return buildOpuntia(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "agave") return buildAgave(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "agaveMast") return buildAgaveMast(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "thistle") return buildThistle(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "asphodel") return buildAsphodel(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "broom") return buildBroom(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "oleander") return buildOleander(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "blades") return buildBlades(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "typha" || type.kind === "plume" || type.kind === "pampas" || type.kind === "susuki") {
    const head = type.kind === "typha" ? "capsule" : type.kind === "plume" ? "hairs" : type.kind === "susuki" ? "fan" : "plume";
    return buildStalked(type, { near, far, rand, push, vcount, I, finish }, head);
  }
  if (type.kind === "broadleaf" || type.kind === "bush") {
    return buildLeafy(type, { near, far, rand, push, vcount, I, finish, bush: type.kind === "bush" });
  }

  // Far drops fronds: at that distance the rosette reads by its outline, and
  // that is where most of the plants in a field are.
  const fronds = Math.max(1, Math.round((type.fronds ?? 8) * (far ? 0.6 : 1)));
  const leafletsPerSide = Math.max(3, Math.round(type.leaflets ?? 16));
  const leafletWidth = type.leafletWidth ?? 1;
  const leafletAngle = ((type.leafletAngle ?? 50) * Math.PI) / 180;
  const spread = type.spread ?? 1.0;           // how far the fronds lean out of the crown
  const arch = type.arch ?? 0.7;               // how far a frond bends over
  const droop = type.droop ?? 0.3;             // how much the leaflets hang
  const bare = type.bareStalk ?? 0.15;         // stalk with no leaflets, share of the length
  const stemW = 0.007 * (type.stemWidth ?? 1);

  // Blade half-width along a frond: nothing on the bare stalk, opens quickly,
  // widest a third along, then a long taper to the tip. The same outline
  // drives the leaflet lengths (near) and the sheet (mid, far).
  const outline = (v) => {
    if (v <= bare) return 0;
    const s = (v - bare) / (1 - bare);
    // Base leaflets already 40% of full; widest a third along; a long even
    // taper that ends in a fine point.
    return Math.min(1, s / 0.25 + 0.25) * Math.pow(Math.max(0, 1 - s), 0.9);
  };
  // A frond's blade is about a quarter as wide as it is long.
  const bladeHalf = (len) => len * 0.16 * leafletWidth;

  for (let f = 0; f < fronds; f++) {
    // Two short fronds stand up in the middle; the rest form an even outer
    // ring of similar length, leaning far out — the rosette.
    const uprightCount = Math.min(2, Math.round(fronds * 0.25));
    const upright = f < uprightCount;
    const ring = upright ? uprightCount : fronds - uprightCount;
    const k = upright ? f : f - uprightCount;
    const a = (k / ring) * Math.PI * 2 + (upright ? 0.9 : 0) + (rand() - 0.5) * 0.25;
    const fr = rand();
    const len = (type.frondLength ?? 1.0) * (upright ? 0.62 : 0.9 + fr * 0.1) * (0.94 + rand() * 0.12);
    const dir = [Math.cos(a), 0, Math.sin(a)];
    const side = [-Math.sin(a), 0, Math.cos(a)];
    const tilt = spread * (upright ? 0.4 + fr * 0.2 : 0.8 + fr * 0.3);
    // Mid keeps the outline with about half the notches — it is the level most
    // of a field sits in, so it has to be much cheaper than near.
    const rows = near ? 24 : far ? 6 : Math.max(6, Math.round(leafletsPerSide * 0.6));
    const line = archCurve(rows, len, tilt, arch);

    /** Point on the stalk at row j (fractional allowed), with its frame. */
    const at = (jf) => {
      const j0 = Math.min(rows - 1, Math.floor(jf)), k = jf - j0;
      const L0 = line[j0], L1 = line[j0 + 1];
      const r = L0.r + (L1.r - L0.r) * k, y = L0.y + (L1.y - L0.y) * k, th = L0.th + (L1.th - L0.th) * k;
      return {
        p: [dir[0] * r, y, dir[2] * r],
        fwd: norm([Math.sin(th) * dir[0], Math.cos(th), Math.sin(th) * dir[2]]),
        v: jf / rows,
      };
    };

    if (near) {
      // ── Leaflets: alternate down both sides, each its own round-tipped strip ──
      const n0 = bare, n1 = 0.97;
      const step = (n1 - n0) / leafletsPerSide;
      for (let side2 = -1; side2 <= 1; side2 += 2) {
        for (let k = 0; k < leafletsPerSide; k++) {
          // The other side sits half a step further along: alternate, not paired.
          const v = n0 + (k + (side2 > 0 ? 0.5 : 0.0) + 0.3) * step;
          if (v > n1) continue;
          const { p, fwd } = at(v * rows);
          const L = bladeHalf(len) * outline(v) * (0.92 + rand() * 0.16);
          if (L < 0.004) continue;
          const lr = rand();
          // Points forward along the frond and out to its side; lies in the
          // frond's own plane, then hangs by `droop` toward its tip.
          const ca = Math.cos(leafletAngle), sa = Math.sin(leafletAngle);
          const out = norm(add([fwd[0] * ca, fwd[1] * ca, fwd[2] * ca], side, side2 * sa));
          const planeN0 = norm(cross(fwd, side));
          const planeN = planeN0[1] < 0 ? [-planeN0[0], -planeN0[1], -planeN0[2]] : planeN0;
          const wide0 = norm(cross(planeN, out));
          // ROLLED, alternating and jittered, about the leaflet's own length.
          // The leaflets used to be exactly coplanar with their frond, so a
          // frond seen edge-on drew as a HAIRLINE streak across the view — a
          // whole blade one pixel wide. Rolled, they never present one flat
          // plane: edge-on, half of them still catch the light. It costs
          // nothing (the same vertices, moved) and a real pinnate leaf is
          // V-ed like this anyway.
          const roll = (k % 2 ? 1 : -1) * 0.22 + (lr - 0.5) * 0.5;
          const wide = norm(add(add([0, 0, 0], wide0, Math.cos(roll)), planeN, Math.sin(roll)));
          const nRoll0 = norm(cross(out, wide));
          const nRoll = nRoll0[0] * planeN[0] + nRoll0[1] * planeN[1] + nRoll0[2] * planeN[2] < 0
            ? [-nRoll0[0], -nRoll0[1], -nRoll0[2]] : nRoll0;
          // Each leaflet also lifts a little off the frond plane, alternating,
          // so the blade has thickness instead of reading as a flat cut-out.
          const lift = (k % 2 ? 1 : -1) * 0.05 + (lr - 0.5) * 0.06;
          const n = norm(add(nRoll, wide, lift * side2));
          // Narrower than the gap between neighbours (measured across the
          // leaflet, so the forward lean is accounted for): the gaps are what
          // make them read as leaflets instead of one serrated blade.
          // Leaflets sit close: cut nearly to the stalk but with only a small
          // gap to the neighbour (about a fifth of a leaflet's width).
          const pitchAcross = step * len * Math.sin(leafletAngle);
          // Strap-shaped, about 4× longer than wide, with a gap to the next
          // leaflet of about a fifth of its width.
          // The gap to the neighbour stays the same all along the frond: the
          // short leaflets near the tip are stubbier, not sparser.
          const width = Math.min(L * 0.3, pitchAcross * 0.85);
          const base = P.length / 3;
          // Pairs along the leaflet and a tip point: a strap that keeps its
          // width for two thirds of its length, then a ROUNDED end, bending a
          // little toward the frond's tip. The small leaflets near the crown
          // and tip get one pair fewer.
          // A leaflet is 5 triangles (two quads and a rounded end); the short
          // ones near the crown and the tip get 3. At arm's length that reads
          // the same as a finer strip and costs half as much across a field.
          const rowsL = L > bladeHalf(len) * 0.5
            ? [[0.0, 0.82], [0.38, 1.0], [0.78, 0.82]]
            : [[0.0, 0.85], [0.62, 1.0]];
          const pt = (t) => add(add(add(p, out, L * t), [0, -1, 0], droop * L * t * t), fwd, L * 0.12 * t * t);
          for (const [t, w] of rowsL) {
            const c = add(pt(t), planeN, lift * L * t);
            for (const cs of [-1, 1]) {
              push(add(c, wide, cs * width * w), n, cs * 0.5 + 0.5, t, [0, v, fr, t]);
            }
          }
          const tip = add(pt(1), planeN, lift * L);
          push(tip, n, 0.5, 1, [0, v, fr, 1]);
          for (let q = 0; q < rowsL.length - 1; q++) {
            const i0 = base + q * 2;
            I.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
          }
          const last = base + (rowsL.length - 1) * 2;
          I.push(last, last + 2, last + 1);
        }
      }
      // The terminal leaflet, straight on.
      {
        const { p, fwd } = at(rows);
        const L = bladeHalf(len) * 0.2;
        const planeN = norm(cross(fwd, side));
        const base = P.length / 3;
        for (const [t, w] of [[0, 0.5], [0.5, 1.0]]) {
          const c = add(p, fwd, L * t);
          for (const cs of [-1, 1]) push(add(c, side, cs * L * 0.28 * w), planeN, cs * 0.5 + 0.5, t, [0, 1, fr, t]);
        }
        push(add(p, fwd, L), planeN, 0.5, 1, [0, 1, fr, 1]);
        I.push(base, base + 2, base + 1, base + 1, base + 2, base + 3, base + 2, base + 4, base + 3);
      }
    } else {
      // ── Mid / far: one sheet down each side of the stalk ──
      // Mid cuts the edge into leaflets (one notch per row); far leaves it
      // whole at the near outline's AVERAGE width so it is not fatter.
      const notchDepth = far ? 0 : 0.85;
      const match = far ? 0.72 : 1;
      const lean = Math.cos(leafletAngle);
      for (const s2 of [-1, 1]) {
        const base = P.length / 3;
        for (let j = 0; j <= rows; j++) {
          const { p, fwd, v } = at(j);
          const w = bladeHalf(len) * outline(v) * (1 - (j % 2) * notchDepth) * match;
          const out = norm([
            side[0] * s2 + fwd[0] * lean * 0.6, fwd[1] * lean * 0.25 - droop * 0.5, side[2] * s2 + fwd[2] * lean * 0.6,
          ]);
          const n = norm(cross(fwd, out));
          if (n[1] < 0) { n[0] = -n[0]; n[1] = -n[1]; n[2] = -n[2]; }
          push([p[0], p[1] + w * 0.12, p[2]], n, 0, v, [0, v, fr, 0]);
          push(add(p, out, w), n, 1, v, [0, v, fr, 1]);
        }
        for (let j = 0; j < rows; j++) {
          const i0 = base + j * 2;
          if (s2 < 0) I.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
          else I.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
        }
      }
    }

    // ── Stalk (near only): the pale rachis, as a CROSS of two strips ──
    // One strip turned edge-on is a flat sheet, and a sheet running the whole
    // length of a frond draws as a HAIRLINE streak across the view. Crossed,
    // the stalk always shows a face. 12 triangles a frond.
    if (near) {
      const segs = 6;
      for (const across of [true, false]) {
        const base = P.length / 3;
        for (let q = 0; q <= segs; q++) {
          const { p, fwd, v } = at((q / segs) * rows);
          const w = stemW * (1 - v * 0.75);
          // Strip 1 lies in the frond's plane, strip 2 stands perpendicular
          // to it — both follow the frond's arch.
          const axis = across ? side : norm(cross(fwd, side));
          const n = norm(cross(fwd, axis));
          for (const s of [-1, 1]) {
            push(add(p, axis, s * w), n, s * 0.5 + 0.5, v, [1, v, fr, 0]);
          }
        }
        for (let q = 0; q < segs; q++) {
          const i0 = base + q * 2;
          I.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
        }
      }
    }
  }

  return finish();
}

/**
 * BLADES — reeds, sedge, a tuft of tall grass: a fan of long tapered blades
 * rising from one point, each bending over and twisting a little. No leaflets,
 * so it is cheap: one strip per blade.
 */
function buildBlades(type, ctx) {
  const { near, far } = ctx;
  // NESTED (2026-10-07): every level grows the same tuft and the coarse ones leave blades out; only
  // FAR widens what it keeps (a dense tussock of 60 wiry blades is 24 broad ones at 140 m). Each
  // level used to grow its own fan — every blade turned at the switch (mid matched 27%).
  const n = type.fronds ?? 14;
  const keep = far ? (n > 30 ? 0.4 : 0.55) : near ? 1 : 0.75;
  addBladeFan(ctx, {
    count: Math.max(3, Math.round(n)), keep,
    rows: near ? 5 : far ? 2 : 4,
    len: type.frondLength ?? 1.0,
    width: 0.035 * (type.leafletWidth ?? 1) * (far ? Math.sqrt(1 / keep) : 1),
    spread: type.spread ?? 0.35,
    arch: type.arch ?? 0.9,
    dry: type.dry ?? 0,
  });
  return ctx.finish();
}

/**
 * A fan of long tapered blades rising from one point, each bending over and
 * twisting so it is not a flat ribbon. The base of a reed clump or a cattail.
 */
function addBladeFan({ rand, push, vcount, I }, { count, rows, len: baseLen, width, spread, arch, dry = 0, keep = 1 }) {
  // `keep` < 1: a coarse level — the same blades (the full count's angles and draws), a golden-ratio
  // share of them drawn, so the level is a SUBSET of the near one, not a different tuft.
  for (let b = 0; b < count; b++) {
    const a = (b / count) * Math.PI * 2 + rand() * 0.8;
    const br = rand();
    // A DRY blade (straw, the shader's rand 1..1.5 flag): `dry` of them.
    // (No extra rand() unless asked: every other fan keeps its exact shape.)
    const flag = dry > 0 && rand() < dry ? 1 + br * 0.45 : br;
    if (keep < 1 && ((b * 0.6180339887) % 1) >= keep) continue;
    const len = baseLen * (0.6 + br * 0.7);
    const dir = [Math.cos(a), 0, Math.sin(a)];
    const side = [-Math.sin(a), 0, Math.cos(a)];
    const line = archCurve(rows, len, spread * (0.4 + br), arch * (0.6 + br * 0.8));
    const base = vcount();
    for (let j = 0; j <= rows; j++) {
      const L = line[j];
      const p = [dir[0] * L.r, L.y, dir[2] * L.r];
      const fwd = norm([Math.sin(L.th) * dir[0], Math.cos(L.th), Math.sin(L.th) * dir[2]]);
      // Tapers to a point, and twists so it is not a flat ribbon.
      const w = width * len * Math.pow(Math.max(0, 1 - L.v), 0.7) * (1 - L.v * 0.15);
      const twist = L.v * (br - 0.5) * 1.2;
      const across = norm([
        side[0] * Math.cos(twist) + fwd[0] * Math.sin(twist) * 0.3,
        Math.sin(twist) * 0.35,
        side[2] * Math.cos(twist) + fwd[2] * Math.sin(twist) * 0.3,
      ]);
      const n = norm(cross(fwd, across));
      if (n[1] < 0) { n[0] = -n[0]; n[1] = -n[1]; n[2] = -n[2]; }
      for (const s of [-1, 1]) push(add(p, across, s * w), n, s * 0.5 + 0.5, L.v, [0, L.v, flag, Math.abs(s)]);
    }
    for (let j = 0; j < rows; j++) {
      const i0 = base + j * 2;
      I.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
    }
  }
}

/**
 * STALKED — a clump of blades with tall stems rising out of it, each carrying a
 * head: a cattail's brown sausage (`typha`, grows at the water's edge) or the
 * soft pale plume of reed grass (`plume`).
 *
 * The head is `part` 2, so the material gives it its own colour.
 *
 * `susuki` (head "fan") is pampas with a different head: several plumes
 * fanning out of the stalk's tip instead of one running down it, and a
 * stiffer, thicker stalk that ENDS where the plumes begin — so the join reads.
 */
function buildStalked(type, ctx, head) {
  const plume = head !== "capsule";
  const { near, far, rand, push, vcount, I, finish } = ctx;
  const height = type.frondLength ?? 1.0;

  // The clump of leaves it grows out of. A cattail's strap leaves stand
  // TALLER than its flower stalks (2026-10-02: they stopped short of them,
  // so the heads stood on bare sticks over a tuft).
  addBladeFan(ctx, {
    count: Math.max(2, Math.round(type.fronds ?? 7)), keep: far ? 0.5 : near ? 1 : 0.75,
    rows: near ? 5 : far ? 2 : 3,
    len: height * (plume ? 0.8 : 1.1),
    width: (plume ? 0.03 : 0.026) * (type.leafletWidth ?? 1),
    spread: type.spread ?? 0.3,
    arch: type.arch ?? 0.8,
  });

  const stems = Math.max(1, Math.round((type.leaflets ?? 5) * (far ? 0.5 : near ? 1 : 0.75)));
  const segs = near ? 5 : far ? 2 : 3;
  const sides = near ? 7 : far ? 4 : 5;
  // A plume needs more rings than a sausage: its ragged edge IS the feathering.
  const rings = plume ? (near ? 9 : far ? 3 : 5) : (near ? 5 : far ? 2 : 3);
  const headR = (plume ? 0.032 : 0.023) * (type.leafletWidth ?? 1) * height;
  // Where the head starts up the stem, and how far it runs. A plume is a long
  // slim ear (about 6× longer than wide); a cattail is a short fat sausage.
  const fan = head === "fan";
  const h0 = head === "plume" ? 0.58 : fan ? 0.7 : plume ? 0.64 : 0.7, h1 = plume ? 0.99 : 0.9;
  // Where the stem strip stops. A fan's stalk runs a little way INTO the base
  // of its plumes: the plume texture is faint at its root, and a stalk that
  // stopped exactly there would read as not joined.
  const stemTop = fan ? Math.min(h1, h0 + 0.08) : h1;

  for (let k = 0; k < stems; k++) {
    const a = k * 2.39996 + rand() * 0.7;
    const sr = rand();
    // Cattail heads at many heights; the plumes keep their even crown.
    const len = height * (plume ? 0.85 + sr * 0.3 : 0.7 + sr * 0.45);
    const dir = [Math.cos(a), 0, Math.sin(a)];
    const side = [-Math.sin(a), 0, Math.cos(a)];
    // Nearly upright, leaning a little and bending under the head's weight.
    // Susuki stalks are cane-like: they barely lean and do not bow.
    const lean = fan ? 0.03 + sr * 0.07 : 0.06 + sr * 0.14;
    const bend = (type.droop ?? 0.3) * (fan ? 0.08 : plume ? 0.5 : 0.22);
    const line = archCurve(Math.max(segs, rings + 2), len, lean, bend);
    const at = (t) => {
      const jf = t * (line.length - 1);
      const j0 = Math.min(line.length - 2, Math.floor(jf)), f = jf - j0;
      const L0 = line[j0], L1 = line[j0 + 1];
      const r = L0.r + (L1.r - L0.r) * f, y = L0.y + (L1.y - L0.y) * f, th = L0.th + (L1.th - L0.th) * f;
      return { p: [dir[0] * r, y, dir[2] * r], fwd: norm([Math.sin(th) * dir[0], Math.cos(th), Math.sin(th) * dir[2]]) };
    };

    // ── The stem ──
    // A susuki cane is a CYLINDER: it is a stiff round stalk, not a blade of
    // grass, and a flat strip turned edge-on to the camera disappears — which
    // is what made the plumes look unattached. Every other stalked plant keeps
    // the cheap strip.
    if (fan) {
      const r0 = 0.004 * (type.stemWidth ?? 1) * height;
      const sides2 = near ? 5 : far ? 3 : 4;
      const base = vcount();
      for (let q = 0; q <= segs; q++) {
        const t = q / segs;
        const { p, fwd } = at(t * stemTop);
        const across = norm(cross(fwd, side));
        const r = r0 * (1 - 0.25 * t);            // tapers a little toward the head
        // The seam vertex is pushed twice so the ring's uv runs 0..1.
        for (let k3 = 0; k3 <= sides2; k3++) {
          const ang = (k3 / sides2) * Math.PI * 2;
          const off = add(add([0, 0, 0], across, Math.cos(ang) * r), side, Math.sin(ang) * r);
          push(add(p, off), norm(off), k3 / sides2, t, [1, t, sr, 0]);
        }
      }
      for (let q = 0; q < segs; q++) {
        for (let k3 = 0; k3 < sides2; k3++) {
          const i0 = base + q * (sides2 + 1) + k3, i1 = i0 + 1;
          const i2 = i0 + (sides2 + 1), i3 = i2 + 1;
          I.push(i0, i2, i1, i1, i2, i3);
        }
      }
    } else {
      const w = 0.006 * (type.stemWidth ?? 1) * height;
      const base = vcount();
      for (let q = 0; q <= segs; q++) {
        const t = q / segs;
        const { p, fwd } = at(t * stemTop);
        const n = norm(cross(fwd, side));
        for (const s of [-1, 1]) push(add(p, side, s * w), n, s * 0.5 + 0.5, t, [1, t, sr, 0]);
      }
      for (let q = 0; q < segs; q++) {
        const i0 = base + q * 2;
        I.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
      }
    }

    if (head === "hairs") {
      // ── A BOTTLEBRUSH ear: short hairs all around the stem's top stretch,
      // angled up toward its tip. The susuki idea of building a plume out of
      // strands — with no alpha texture, the HAIRS are the feathering. ──
      const levels = near ? 8 : far ? 3 : 5;
      const hairs = near ? 6 : far ? 3 : 4;
      const earLen = h1 - h0;
      for (let q = 0; q < levels; q++) {
        const t = (q + 0.5) / levels;
        const { p, fwd } = at(h0 + earLen * t);
        const across = norm(cross(fwd, side));
        // Fullest a third up, tapering to a soft point at the tip.
        const spanT = Math.pow(Math.sin(Math.PI * (0.14 + 0.86 * t)), 0.55) * (1 - t * 0.25);
        for (let h = 0; h < hairs; h++) {
          const hr = rand();
          const ring = ((h + (q % 2) * 0.5) / hairs) * Math.PI * 2 + hr * 0.3;
          const hairLen = headR * 2.6 * spanT * (0.75 + hr * 0.5);
          if (hairLen < 1e-4) continue;
          const outDir = norm(add(add(add([0, 0, 0], fwd, 0.95),
            across, Math.cos(ring) * 0.85), side, Math.sin(ring) * 0.85));
          const wide = norm(cross(outDir, fwd));
          const n = norm(cross(outDir, wide));
          const w = headR * 0.16 * (0.7 + hr * 0.6);
          const base = vcount();
          for (const [v, k] of [[0, 1], [0.6, 0.7]]) {
            const c = add(add(p, outDir, hairLen * v), [0, -1, 0], (type.droop ?? 0.4) * hairLen * v * v * 0.3);
            for (const s of [-1, 1]) push(add(c, wide, s * w * k), n, s * 0.5 + 0.5, v, [2, t, hr, v]);
          }
          const tipH = add(add(p, outDir, hairLen), [0, -1, 0], (type.droop ?? 0.4) * hairLen * 0.3);
          push(tipH, n, 0.5, 1, [2, t, hr, 1]);
          I.push(base, base + 2, base + 1, base + 1, base + 2, base + 3, base + 2, base + 4, base + 3);
        }
      }
    } else if (fan) {
      // ── A FAN of plumes out of the stalk's tip, the miscanthus flower head:
      // each plume is two crossed cards carrying the strand texture, leaving
      // the tip at its own angle round the stalk and drooping outward. ──
      const count = Math.max(1, Math.round((type.plumesPerStem ?? 4) * (far ? 0.5 : 1)));
      const spread = ((type.plumeSpread ?? 30) * Math.PI) / 180;
      const segsP = near ? 5 : far ? 2 : 3;
      const tip = at(h0);
      const across = norm(cross(tip.fwd, side));
      const plumeLen = (h1 - h0) * len * 1.35;
      for (let k2 = 0; k2 < count; k2++) {
        const pr = rand();
        // Round the stalk, the first plume carrying on straight up the middle.
        const ring = k2 * 2.39996 + pr * 0.6;
        const tilt = count === 1 || k2 === 0 ? spread * 0.2 : spread * (0.6 + pr * 0.5);
        const radial = norm(add(add([0, 0, 0], across, Math.cos(ring)), side, Math.sin(ring)));
        const dir = norm(add(add([0, 0, 0], tip.fwd, Math.cos(tilt)), radial, Math.sin(tilt)));
        const Lk = plumeLen * (0.8 + pr * 0.35);
        const halfW = Lk * 0.2 * (type.leafletWidth ?? 1);
        // Plumes rise and only arc over toward their tips.
        const droop = (type.droop ?? 0.5) * 0.2;
        for (const cardAngle of [0, Math.PI / 2]) {
          const ca = Math.cos(cardAngle), sa = Math.sin(cardAngle);
          const dAcross = norm(cross(dir, [0, 1, 0.001]));
          const dUp = norm(cross(dAcross, dir));
          const wide = norm(add(add([0, 0, 0], dAcross, ca), dUp, sa));
          const n = norm(cross(dir, wide));
          const base = vcount();
          for (let q = 0; q <= segsP; q++) {
            const v = q / segsP;
            // Droops with length: the plume hangs from the tip, heaviest at its end.
            const c = add(add(tip.p, dir, Lk * v), [0, -1, 0], droop * Lk * v * v);
            for (const s of [-1, 1]) push(add(c, wide, s * halfW), n, s * 0.5 + 0.5, v, [2, v, pr, v]);
          }
          for (let q = 0; q < segsP; q++) {
            const i0 = base + q * 2;
            I.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
          }
        }
      }
    } else if (head === "plume") {
      // ── ONE plume per stem, the susuki way: two crossed cards carrying the
      // plume texture, whose alpha holds the hundreds of fine strands. The
      // cards bend along the stem so the plume hangs rather than standing
      // stiff. ──
      const segsP = near ? 5 : far ? 2 : 3;
      const halfW = (h1 - h0) * len * 0.26 * (type.leafletWidth ?? 1);
      for (const cardAngle of [0, Math.PI / 2]) {
        const ca = Math.cos(cardAngle), sa = Math.sin(cardAngle);
        const base = vcount();
        for (let q = 0; q <= segsP; q++) {
          const v = q / segsP;
          const { p, fwd } = at(h0 + (h1 - h0) * v);
          const across = norm(cross(fwd, side));
          const wide = norm(add(add([0, 0, 0], across, ca), side, sa));
          const n = norm(cross(fwd, wide));
          for (const s of [-1, 1]) push(add(p, wide, s * halfW), n, s * 0.5 + 0.5, v, [2, v, sr, v]);
        }
        for (let q = 0; q < segsP; q++) {
          const i0 = base + q * 2;
          I.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
        }
      }
    } else {
      // ── A cattail's head: a CAPSULE — straight sides, rounded at both ends ──
      const base = vcount();
      const cap = 0.16;
      for (let q = 0; q <= rings; q++) {
        const t = q / rings;
        const { p, fwd } = at(h0 + (h1 - h0) * t);
        const across = norm(cross(fwd, side));
        const profile = t < cap ? Math.sqrt(Math.max(0, 1 - ((cap - t) / cap) ** 2))
          : t > 1 - cap ? Math.sqrt(Math.max(0, 1 - ((t - (1 - cap)) / cap) ** 2))
          : 1;
        const r = headR * Math.max(0.04, profile);
        for (let s = 0; s < sides; s++) {
          const ang = (s / sides) * Math.PI * 2;
          const off = add(add([0, 0, 0], across, Math.cos(ang) * r), side, Math.sin(ang) * r);
          push(add(p, off), norm(off), s / sides, t, [2, t, sr, t]);
        }
      }
      for (let q = 0; q < rings; q++) {
        for (let s = 0; s < sides; s++) {
          const i0 = base + q * sides + s, i1 = base + q * sides + ((s + 1) % sides);
          I.push(i0, i1, i0 + sides, i1, i1 + sides, i0 + sides);
        }
      }
      // Real cattails carry a thin spike above the sausage.
      const { p } = at(Math.min(1, h1 + 0.12));
      const tip = push(p, [0, 1, 0], 0.5, 1, [1, 1, sr, 1]);
      const last = base + rings * sides;
      for (let s = 0; s < sides; s++) I.push(last + s, last + ((s + 1) % sides), tip);
    }
  }
  return finish();
}

/**
 * LEAFY — clover and ground cover (`broadleaf`), or a shrub (`bush`): rounded
 * leaves on short stalks. Ground cover lays them almost flat in a low patch; a
 * bush spreads them over a dome so the plant has volume from every side.
 */
/**
 * BUSH and GROUND COVER — the soft broadleaf mass of a jungle floor: wild
 * ginger, heliconia, the stuff that fills the space between the ferns.
 *
 * REBUILT 2026-09-23 from photographs (Alpinia, Wikimedia Commons), because
 * these two were the worst-looking plants on the map and both for the same
 * reason: their leaves were GEOMETRY. Each was a three-segment polygon strip
 * whose outline was the leaf's outline, so every leaf was an angular slab with
 * five triangles in it and no taper, no curve and no point. They read as
 * painted cardboard beside the ferns, and they cover more of the screen than
 * anything else on the map.
 *
 * Now each leaf is ONE CARD with the shape in its alpha (lanceLeafTexture.js):
 * two triangles instead of five, a real silhouette, and two variants in the
 * texture so a clump is not fifty copies of one leaf.
 *
 * THE TWO PLANTS DIFFER IN ARCHITECTURE, not just in size:
 *   · a BUSH is a ginger clump — upright canes, each carrying leaves
 *     ALTERNATELY up two ranks, arching out and over. Its silhouette is
 *     vertical and layered.
 *   · GROUND COVER is a low rosette, leaves fanning out near the floor.
 * Giving both the same rosette (which is what the old builder did) is why a
 * jungle floor read as one repeated plant at two sizes.
 */
/**
 * PRICKLY PEAR (Opuntia) — the hedge round every Maghreb village and garden:
 * flat oval PADS growing out of the rims of older pads, three or four tiers,
 * on a short grey woody base. Unit frame (height ~1, the preset's `size`
 * scales it). Pads are closed flattened ellipsoids in colorHead (part 2 —
 * solid colour, soft-body shading); the base is the stalk part.
 *   fronds   pads on the ground tier
 *   leaflets tiers
 */
function buildOpuntia(type, { near, far, rand, push, vcount, I, finish }) {
  const tiers = Math.max(2, Math.round(type.leaflets ?? 4) - (far ? 1 : 0));
  // `rings` draws the pad's OUTLINE (2 × rings points round it): 5 read as
  // octagons up close. `seg` only rounds its thin section.
  const seg = far ? 5 : near ? 8 : 6, rings = far ? 3 : near ? 8 : 6;
  const PAD = 2;
  /**
   * One pad: centre `c`, its long axis `up`, its flat face's normal `n`.
   * The shader draws its surface from the vertex data (foliageSystem: a
   * cactus pad): uv = the pad's own frame (across, along: 0..1 — the areole
   * lattice and the pale rim), rand = per pad (tone, and the odd dried
   * one), along = 2 + its age (0 the old pads at the foot, 1 the young top).
   */
  const pad = (c, up, n, len, wid, thick, tone) => {
    const side = norm(cross(up, n));
    const base = vcount();
    const pr = rand();
    for (let r = 0; r <= rings; r++) {
      const th = (r / rings) * Math.PI;                       // along the pad
      for (let s = 0; s < seg; s++) {
        const ph = (s / seg) * Math.PI * 2;                   // round its section
        const ex = Math.cos(th), ey = Math.sin(th) * Math.cos(ph), ez = Math.sin(th) * Math.sin(ph);
        const p = add(add(add(c, up, ex * len), side, ey * wid), n, ez * thick);
        // The ellipsoid's normal: each axis's coordinate over its radius.
        const nn = norm([0, 1, 2].map((i) => up[i] * ex / len + side[i] * ey / wid + n[i] * ez / thick));
        push(p, nn, ey * 0.5 + 0.5, ex * 0.5 + 0.5, [PAD, 0.4 + tone * 0.6, pr, 2 + tone]);
      }
    }
    for (let r = 0; r < rings; r++) for (let s = 0; s < seg; s++) {
      const a = base + r * seg + s, b = base + r * seg + ((s + 1) % seg), c2 = a + seg, d = b + seg;
      I.push(a, c2, b, b, c2, d);
    }
  };
  // The woody base: a stub, near only.
  if (!far) {
    const w = 0.035, b = vcount();
    for (const [y, v] of [[0, 0], [0.16, 1]]) for (const s of [-1, 1]) push([s * w, y, 0], [0, 0, -1], s * 0.5 + 0.5, v, [1, v, 0.3, 0]);
    I.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  }
  // Tiers: each pad sprouts 1-2 pads from its upper rim, tilted apart.
  let front = [];
  const n0 = Math.max(2, Math.round((type.fronds ?? 4) * (far ? 0.6 : 1)));
  for (let k = 0; k < n0; k++) {
    const az = (k / n0) * Math.PI * 2 + rand() * 0.8;
    const lean = 0.15 + rand() * 0.3;
    const up = norm([Math.cos(az) * Math.sin(lean), Math.cos(lean), Math.sin(az) * Math.sin(lean)]);
    const face = norm(cross(up, [-Math.sin(az), 0, Math.cos(az)]));
    front.push({ tip: [Math.cos(az) * 0.05, 0.1, Math.sin(az) * 0.05], up, face, len: 0.11, depth: 0 });
  }
  const all = [];
  for (let t = 0; t < tiers; t++) {
    const next = [];
    for (const f of front) {
      // The old pads at the foot are the biggest and thickest; the young
      // ones up top smaller and rounder.
      const len = f.len * (0.9 + rand() * 0.25) * (t === 0 ? 1.15 : 1), wid = len * (0.68 + rand() * 0.1), thick = len * (t === 0 ? 0.16 : 0.12);
      const c = add(f.tip, f.up, len);
      all.push({ c, up: f.up, face: f.face, len, wid, thick, tone: t / Math.max(1, tiers - 1) });
      if (t === tiers - 1) continue;
      const kids = rand() < 0.55 ? 2 : 1;
      for (let q = 0; q < kids; q++) {
        const tilt = (q === 0 ? -1 : 1) * (0.35 + rand() * 0.45) * (kids === 1 ? (rand() - 0.5) * 2 : 1);
        const side = norm(cross(f.up, f.face));
        const up = norm(add(add(f.up, side, Math.sin(tilt)), [0, 1, 0], 0.25));
        const spin = (rand() - 0.5) * 1.2;
        const face = norm(add(f.face, side, spin));
        next.push({ tip: add(add(c, f.up, len * 0.8), side, Math.sin(tilt) * wid * 0.6), up, face, len: len * 0.95, depth: t + 1 });
      }
    }
    front = next;
  }
  for (const p of all) pad(p.c, p.up, p.face, p.len, p.wid, p.thick, p.tone);
  // THE FRUIT (figues de barbarie, late summer): small eggs along the upper
  // rims of the top pads — what makes a hedge read alive, not green paddles.
  // A leaf part flagged FRUIT (rand ≥ 3): foliageSystem colours it with the
  // type's colorBase, which the pads (head colour) leave free. (The "dead"
  // leaf brown read pale cream: a linear colour, shown in sRGB.)
  if (!far && (type.fruit ?? 0) > 0) {
    const top = all.filter((p) => p.tone >= 1 - 1e-6);
    const fseg = near ? 6 : 4, frings = near ? 4 : 3;
    for (const p of top) {
      // Not every top pad fruits, and a fruiting one carries a few, each at
      // its own ripeness (the shader: green → orange → the type's colour).
      if (rand() < 0.3) continue;
      const nF = Math.round(type.fruit * (0.4 + rand() * 0.9));
      const side = norm(cross(p.up, p.face));
      for (let k = 0; k < nF; k++) {
        // Round the pad's upper rim: an angle across its top half.
        const a = (k + 0.5) / nF * Math.PI - Math.PI / 2 + (rand() - 0.5) * 0.3;
        const rim = add(add(p.c, p.up, Math.cos(a) * p.len * 0.95), side, Math.sin(a) * p.wid * 0.95);
        const out = norm(add(add([0, 0, 0], p.up, Math.cos(a)), side, Math.sin(a)));
        const fl = p.len * (0.2 + rand() * 0.05), fw = fl * 0.66;
        const ripe = Math.min(1, 0.25 + rand() * 0.95);
        const c = add(rim, out, fl * 0.7);
        const fn = norm(cross(out, p.face));
        const base = vcount();
        for (let r = 0; r <= frings; r++) {
          const th = (r / frings) * Math.PI;
          for (let s2 = 0; s2 < fseg; s2++) {
            const ph = (s2 / fseg) * Math.PI * 2;
            const ex = Math.cos(th), ey = Math.sin(th) * Math.cos(ph), ez = Math.sin(th) * Math.sin(ph);
            const q = add(add(add(c, out, ex * fl), fn, ey * fw), p.face, ez * fw);
            const nn = norm([0, 1, 2].map((i) => out[i] * ex / fl + fn[i] * ey / fw + p.face[i] * ez / fw));
            push(q, nn, 0.25, 0.5, [0, 0.9, 3.2, ripe]);   // rand 3.2: FRUIT (foliageSystem: colorBase), along = ripeness
          }
        }
        for (let r = 0; r < frings; r++) for (let s2 = 0; s2 < fseg; s2++) {
          const a0 = base + r * fseg + s2, b0 = base + r * fseg + ((s2 + 1) % fseg);
          I.push(a0, a0 + fseg, b0, b0, a0 + fseg, b0 + fseg);
        }
      }
    }
  }
  return finish();
}

/**
 * AGAVE (Agave americana) — the big blue-grey rosette planted along every
 * farm track and hedge in the Maghreb: 20-30 thick, stiff, V-section leaves
 * from one root, the inner ones standing up, the outer ones spreading and
 * arching their tips down, a few old ones folded over at mid-length. Solid
 * geometry throughout (part 2, the head colour; `along` 0 at the root, 1 at
 * the spine, so the leaves pale toward their tips). Unit frame (height ~1).
 *   fronds  leaves
 */
function buildAgave(type, { near, far, rand, push, vcount, I, finish }) {
  const leaves = Math.max(8, Math.round((type.fronds ?? 26) * (far ? 0.4 : near ? 1 : 0.7)));
  const rings = far ? 3 : near ? 7 : 5;
  const L0 = type.frondLength ?? 1;
  for (let l = 0; l < leaves; l++) {
    const age = l / (leaves - 1);                       // 0 inner/young … 1 outer/old
    const az = l * 2.39996 + rand() * 0.4;
    const elev = (1.35 - age * 1.0) + (rand() - 0.5) * 0.15;     // up in the middle, out at the rim
    const curl = 0.15 + age * 0.75;                     // the tip bends down this much more
    const fold = age > 0.6 && rand() < 0.22;            // an old leaf broken over
    const len = L0 * (0.62 + age * 0.38) * (0.85 + rand() * 0.3);
    const W = len * (0.14 + rand() * 0.03), thick = W * 0.45;
    const out = [Math.cos(az), 0, Math.sin(az)];
    const side = [-Math.sin(az), 0, Math.cos(az)];
    // Walk the leaf: its spine bends as it goes.
    let p = [out[0] * 0.03, 0.02, out[2] * 0.03];
    const base = vcount();
    for (let r = 0; r <= rings; r++) {
      const t = r / rings;
      let e = elev - curl * t * t;
      if (fold && t > 0.55) e -= 1.6 * (t - 0.55) / 0.45;   // snapped down past the middle
      const dir = norm([out[0] * Math.cos(e), Math.sin(e), out[2] * Math.cos(e)]);
      if (r > 0) p = add(p, dir, len / rings);
      const up = norm(cross(side, dir));                // the leaf's face normal (up-ish)
      const w = W * Math.pow(1 - t, 0.75) * (0.75 + 0.25 * Math.min(1, t * 4));
      const th = thick * (1 - t * 0.85);
      // The section: edge, the V's floor (top face dips), edge, the keel below.
      const sec = [
        [add(p, side, -w), norm(add(up, side, -0.6))],
        [add(p, up, -th * 0.35), up],
        [add(p, side, w), norm(add(up, side, 0.6))],
        [add(p, up, -th), norm([-up[0], -up[1], -up[2]])],
      ];
      // Part 2.25: an AGAVE leaf (foliageSystem: waxy bloom, a darker
      // margin, a pale band where the next leaf pressed on it). uv.x = which
      // edge of the section (0 / 1 the margins, 0.5 the V's floor).
      sec.forEach(([q, n], k) => push(q, n, [0, 0.5, 1, 0.5][k], t, [2.25, t, rand(), t]));
    }
    for (let r = 0; r < rings; r++) {
      const a = base + r * 4, b = a + 4;
      // top: L-C-R, bottom: L-K-R
      I.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
      I.push(a, a + 3, b, b, a + 3, b + 3, a + 3, a + 2, b + 3, b + 3, a + 2, b + 2);
    }
  }
  return finish();
}

// ── Small shared pieces for the Aurès wildflowers ───────────────────────────

/** A tapered tube from a to b (`sides` faces), one part, `t` 0→1 along it. */
function tubeTo({ push, vcount, I }, a, b, r0, r1, part, sides) {
  const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  const u = norm(cross(d, Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), v = norm(cross(d, u));
  const base = vcount();
  for (const [p, r, t] of [[a, r0, 0], [b, r1, 1]]) {
    for (let s = 0; s < sides; s++) {
      const ph = (s / sides) * Math.PI * 2, n = norm(add(add([0, 0, 0], u, Math.cos(ph)), v, Math.sin(ph)));
      push(add(p, n, r), n, s / sides, t, [part, t, 0.3, 0]);
    }
  }
  for (let s = 0; s < sides; s++) {
    const s1 = (s + 1) % sides;
    I.push(base + s, base + sides + s, base + s1, base + s1, base + sides + s, base + sides + s1);
  }
}

/**
 * A squashed ball at `c` (radii rx, ry): one part; `along` from its bottom (0)
 * to its top (1). `rnd` the rand channel (3.2 = FRUIT: `along` is then ripeness).
 */
function blob({ push, vcount, I }, c, rx, ry, part, segs, rings, alongLo = 0, alongHi = 1, rnd = 0.5) {
  const base = vcount();
  for (let r = 0; r <= rings; r++) {
    const th = (r / rings) * Math.PI;
    for (let s = 0; s < segs; s++) {
      const ph = (s / segs) * Math.PI * 2;
      const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      const al = alongHi - (alongHi - alongLo) * (r / rings);
      push(add(c, [n[0] * rx, n[1] * ry, n[2] * rx]), n, 0.25, 0.5, [part, 1, rnd, al]);
    }
  }
  for (let r = 0; r < rings; r++) for (let s = 0; s < segs; s++) {
    const a = base + r * segs + s, b = base + r * segs + ((s + 1) % segs);
    I.push(a, a + segs, b, b, a + segs, b + segs);
  }
}

/**
 * THISTLE (Silybum / Onopordum) — the purple-headed thistles of the rough
 * ground by every track and village of the Maghreb in summer: a low rosette
 * of broad, spiny-lobed, silvery leaves flat on the ground, one to three stiff
 * stalks, each topped by a purple head in a cup of green spiny bracts.
 * Leaves part 0 (colorBase → colorTip), stalks + bract cups part 1, the
 * flower tufts part 2 (colorHead). Unit frame (height ~1).
 *   fronds  rosette leaves · leaflets  stalks
 */
function buildThistle(type, ctx) {
  const { near, far, rand } = ctx;
  // The rosette: long, deeply toothed leaves, folded along the midrib and
  // waved up and down lobe by lobe (2026-10-02: the flat grey star read as
  // paper cut-outs).
  const leaves = Math.max(5, Math.round((type.fronds ?? 9) * (far ? 0.5 : near ? 1.3 : 1)));
  for (let l = 0; l < leaves; l++) {
    const az = l * 2.39996 + rand() * 0.4;
    const len = 0.32 + rand() * 0.18;
    spinyLeaf(ctx, [0, 0.02, 0], az, 0.15 + rand() * 0.25, len, len * 0.3, far ? 3 : near ? 12 : 5, 0.3);
  }
  // Two to four stalks, each with a clasping leaf or two, a head on top and
  // now and then a side branch with a smaller one.
  const stalks = Math.max(1, Math.round(type.leaflets ?? 2) + (rand() < 0.4 ? 1 : 0));
  for (let k = 0; k < stalks; k++) {
    const az = rand() * Math.PI * 2, lean = 0.06 + rand() * 0.2, h = 0.6 + rand() * 0.4;
    const top = [Math.cos(az) * Math.sin(lean) * h, Math.cos(lean) * h, Math.sin(az) * Math.sin(lean) * h];
    tubeTo(ctx, [0, 0, 0], top, 0.013, 0.008, 1, far ? 3 : 5);
    if (near) {
      for (const f of [0.3, 0.55]) {
        const at = [top[0] * f, top[1] * f, top[2] * f];
        spinyLeaf(ctx, at, az + Math.PI * (0.6 + rand() * 0.8), 0.7 + rand() * 0.3, 0.13 + rand() * 0.05, 0.04, near ? 6 : 4, 0.6);
      }
    }
    thistleHead(ctx, top, 0.05 * (0.85 + rand() * 0.3), rand() < 0.2);
    if (!far && rand() < 0.5) {
      const at = [top[0] * 0.7, top[1] * 0.7, top[2] * 0.7], baz = az + Math.PI * (0.5 + rand());
      const tip = add(at, norm([Math.cos(baz) * 0.6, 1, Math.sin(baz) * 0.6]), 0.18 + rand() * 0.1);
      tubeTo(ctx, at, tip, 0.007, 0.005, 1, 3);
      thistleHead(ctx, tip, 0.038, rand() < 0.4);
    }
  }
  return ctx.finish();
}

/**
 * A thistle leaf: a strip folded along its midrib (three points a row, the
 * rib raised), its edge cut into spiny teeth and waved lobe by lobe. Part 0
 * (colorBase → colorTip). `rise` lifts its tip off the ground.
 */
function spinyLeaf({ rand, push, vcount, I }, at, az, rise, len, W, rows, fold) {
  const out = [Math.cos(az), 0, Math.sin(az)], side = [-Math.sin(az), 0, Math.cos(az)];
  const base = vcount();
  const ph = rand() * 6.28, rr = rand();
  for (let r = 0; r <= rows; r++) {
    const v = r / rows;
    const p = add(add(at, out, len * v * Math.cos(rise)), [0, 1, 0], len * (Math.sin(rise) * v + 0.12 * Math.sin(v * Math.PI)));
    // Teeth: a sawtooth on top of the leaf's outline (wide a third of the way, a point at the tip).
    const tooth = [1, 0.62, 0.42][r % 3];
    const w = W * Math.sin(Math.min(1, v * 1.25) * Math.PI * 0.92 + 0.12) * (1 - v * 0.35) * tooth;
    const wave = Math.sin(v * 9 + ph) * W * 0.25;               // the lobes go up and down
    const up = norm([out[0] * -0.2, 1, out[2] * -0.2]);
    const rib = add(p, [0, 1, 0], W * fold * 0.5);
    for (const s of [-1, 0, 1]) {
      const q = s === 0 ? rib : add(add(p, side, s * w), [0, 1, 0], wave * s * 0.5 + wave * 0.5);
      const n = s === 0 ? up : norm(add(up, side, s * 0.45));
      // Part 0.25: a MARBLED leaf (foliageSystem: white veins and patches,
      // glossy) — still a leaf to everything that tests part < 0.5.
      push(q, n, s * 0.5 + 0.5, v, [0.25, 0.25 + v * 0.55, rr, v * 0.5]);
    }
  }
  for (let r = 0; r < rows; r++) {
    const a = base + r * 3, b = a + 3;
    I.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
}

/** A thin pointed blade from `a` toward `dir` (one triangle pair): a spine or a floret. */
function spike({ push, vcount, I }, a, dir, len, w, flags, n) {
  const d = norm(dir);
  const s = norm(cross(d, Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const nn = n ?? norm(cross(s, d));
  const base = vcount();
  push(add(a, s, -w), nn, 0, 0, [flags[0], flags[1], flags[2], flags[3] * 0.3]);
  push(add(a, s, w), nn, 1, 0, [flags[0], flags[1], flags[2], flags[3] * 0.3]);
  push(add(a, d, len), nn, 0.5, 1, flags);
  I.push(base, base + 1, base + 2);
}

/**
 * A thistle head: a green globe of bracts with spines sticking out round
 * it, and on top — unless it is still a BUD — the purple brush of florets
 * (part 2, colorHead, paler at the tips). The globe and spines are FRUIT
 * flagged (rand 3.2, ripeness 0: the shader's olive green).
 */
function thistleHead(ctx, top, hr, bud) {
  const { near, far, rand } = ctx;
  const c = add(top, [0, hr * 0.6, 0]);
  blob(ctx, c, hr, hr * 0.85, 0, far ? 4 : near ? 7 : 5, far ? 2 : near ? 4 : 3, 0, 0, 3.2);
  if (near) {
    const ns = 12;
    for (let k = 0; k < ns; k++) {
      const a = (k / ns) * Math.PI * 2 + rand() * 0.3, el = -0.3 + rand() * 0.7;
      const d = [Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)];
      spike(ctx, add(c, d, hr * 0.8), d, hr * 0.9, hr * 0.12, [0, 0.9, 3.2, 0.15]);
    }
  }
  if (bud) return;
  const nf = far ? 5 : near ? 22 : 9;
  for (let k = 0; k < nf; k++) {
    const a = k * 2.39996, rr = Math.sqrt((k + 0.5) / nf);
    const d = norm([Math.cos(a) * rr * 0.8, 1, Math.sin(a) * rr * 0.8]);
    const at = add(c, [Math.cos(a) * rr * hr * 0.6, hr * 0.7, Math.sin(a) * rr * hr * 0.6]);
    spike(ctx, at, d, hr * (1.1 + rand() * 0.3), hr * 0.16, [2, 1, 0.5, 1], [0, 1, 0]);
  }
}

/**
 * ASPHODEL (Asphodelus ramosus) — the sign of an over-grazed Mediterranean
 * hillside: a tuft of long narrow leaves and a branched stalk ~1 m tall,
 * its upper branches lined with flowers — in late summer gone to pale,
 * drying buds and seed capsules. Blades part 0, stalk part 1, buds part 2.
 *   fronds  leaves · leaflets  branches
 */
function buildAsphodel(type, ctx) {
  // Near and mid: the real plant (2026-10-02, you: "very cheap, very low
  // poly, not convincing at all"). Far: the light version below.
  if (!ctx.far) return buildAsphodelFine(type, ctx);
  return buildAsphodelFar(type, ctx);
}

/**
 * ASPHODEL up close (Asphodelus ramosus), from the plant:
 *   · a rosette of long, narrow, KEELED leaves (a V down the middle — the
 *     fold catches the light), arching out and flopping toward the ground;
 *   · one stalk, gently curved, branching from about half way into a
 *     loose candelabra — every stem a smooth curved tube, olive (part 1.25);
 *   · up each branch, as a raceme opens from the bottom: round green seed
 *     pods (FRUIT, unripe), then open flowers — six separate pointed white
 *     tepals in a shallow cup, each with the reddish-brown MIDRIB stripe the
 *     plant is known by (part 2.1, foliageSystem) and orange stamens in the
 *     middle (FRUIT, half ripe = orange) — then closed teardrop buds at the tip.
 *   fronds  leaves · leaflets  branches
 */
function buildAsphodelFine(type, ctx) {
  const { near, rand, push, vcount, I } = ctx;
  const sides = near ? 6 : 4;
  /** A smooth curved tube along a quadratic curve a → c (control b), part 1.25. */
  const curveTube = (a, b, c, r0, r1, segs) => {
    const P = (t) => [0, 1, 2].map((i) => (1 - t) * (1 - t) * a[i] + 2 * (1 - t) * t * b[i] + t * t * c[i]);
    const base = vcount();
    for (let q = 0; q <= segs; q++) {
      const t = q / segs, p = P(t), p2 = P(Math.min(1, t + 0.02)), p1 = P(Math.max(0, t - 0.02));
      const d = norm([p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]]);
      const u = norm(cross(d, Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), v = norm(cross(d, u));
      const r = r0 + (r1 - r0) * t;
      for (let s = 0; s < sides; s++) {
        const ph = (s / sides) * Math.PI * 2, n = norm(add(add([0, 0, 0], u, Math.cos(ph)), v, Math.sin(ph)));
        push(add(p, n, r), n, s / sides, t, [1.25, Math.min(1, p[1]), 0.3, 0]);
      }
    }
    for (let q = 0; q < segs; q++) for (let s = 0; s < sides; s++) {
      const i0 = base + q * sides + s, i1 = base + q * sides + ((s + 1) % sides);
      I.push(i0, i0 + sides, i1, i1, i0 + sides, i1 + sides);
    }
    return P;
  };

  // ── The rosette: keeled strap leaves ──
  const nLeaves = Math.max(10, Math.round((type.fronds ?? 14) * (near ? 1.7 : 1.2)));
  const rows = near ? 7 : 4;
  for (let l = 0; l < nLeaves; l++) {
    const az = l * 2.39996 + rand() * 0.5, br = rand();
    const out = [Math.cos(az), 0, Math.sin(az)], side = [-Math.sin(az), 0, Math.cos(az)];
    const len = 0.5 * (0.7 + br * 0.5);
    const line = archCurve(rows, len, 0.35 + br * 0.45, 1.1 + br * 0.6);
    const W = 0.03 * (0.85 + rand() * 0.3);
    const base = vcount();
    for (let j = 0; j <= rows; j++) {
      const L = line[j];
      const p = [out[0] * L.r, L.y, out[2] * L.r];
      const fwd = norm([Math.sin(L.th) * out[0], Math.cos(L.th), Math.sin(L.th) * out[2]]);
      const up = norm(cross(side, fwd));
      const w = W * Math.pow(Math.max(0, 1 - L.v), 0.6) * (0.6 + 0.4 * Math.min(1, L.v * 5));
      const keel = w * 0.45;
      // Edge, keel (the fold sits low), edge.
      push(add(p, side, -w), norm(add(up, side, -0.55)), 0, L.v, [0, L.v, br, L.v]);
      push(add(p, up, -keel), up, 0.5, L.v, [0, L.v, br, L.v]);
      push(add(p, side, w), norm(add(up, side, 0.55)), 1, L.v, [0, L.v, br, L.v]);
    }
    for (let j = 0; j < rows; j++) {
      const a = base + j * 3, b = a + 3;
      I.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
    }
  }

  // ── The stalk and its branches: smooth curves ──
  const H = 0.75 + rand() * 0.2;
  const lean = [(rand() - 0.5) * 0.08, 0, (rand() - 0.5) * 0.08];
  const top = [lean[0], H, lean[2]];
  const P0 = curveTube([0, 0, 0], [lean[0] * 0.2, H * 0.5, lean[2] * 0.2], top, 0.009, 0.0035, near ? 8 : 5);
  const racemes = [];   // { P: t → point, t0, t1 }
  racemes.push({ P: P0, t0: 0.62, t1: 1 });
  const nb = Math.max(3, Math.round((type.leaflets ?? 3) * 1.6) + (near ? 1 : 0));
  for (let k = 0; k < nb; k++) {
    const f = 0.42 + (k / nb) * 0.28 + rand() * 0.05;
    const at = P0(f), az = k * 2.39996 + rand() * 0.5;
    const out = [Math.cos(az), 0, Math.sin(az)];
    const reach = 0.11 + rand() * 0.06, rise = 0.22 + rand() * 0.12;
    const ctrl = add(at, [out[0] * reach, rise * 0.25, out[2] * reach]);
    const tip = add(ctrl, [out[0] * reach * 0.25, rise, out[2] * reach * 0.25]);
    const P = curveTube(at, ctrl, tip, 0.004, 0.0018, near ? 6 : 4);
    racemes.push({ P, t0: 0.35, t1: 1 });
  }

  // ── Along each raceme: pods, flowers, buds ──
  const per = near ? 12 : 7;
  for (const { P, t0, t1 } of racemes) {
    for (let k = 0; k < per; k++) {
      const s = k / (per - 1);
      const t = t0 + (t1 - t0) * s;
      const c = P(t), c2 = P(Math.min(1, t + 0.02));
      const d = norm([c2[0] - c[0], c2[1] - c[1], c2[2] - c[2]]);
      const az = k * 2.39996 + rand();
      const outv = norm(add([Math.cos(az), 0, Math.sin(az)], d, -[Math.cos(az), 0, Math.sin(az)].reduce((m, x, i) => m + x * d[i], 0)));
      const pedicel = add(c, outv, 0.012);
      if (s < 0.3) {
        // A seed pod: round, green.
        blob(ctx, pedicel, 0.009, 0.01, 0, near ? 6 : 5, near ? 4 : 3, 0, 0, 3.2);
      } else if (s > 0.8) {
        // A bud: a closed teardrop, pointing up the branch.
        blob(ctx, add(pedicel, d, 0.006), 0.0055, 0.013, 2, near ? 6 : 4, near ? 4 : 3, 0.35, 0.55, 0.5);
      } else {
        asphodelFlower(ctx, pedicel, norm(add(outv, [0, 1, 0], 0.5)), 0.03 * (0.85 + rand() * 0.3), rand() * 6.28, near);
      }
    }
  }
  return ctx.finish();
}

/**
 * One asphodel flower facing `face`: six separate pointed tepals in a shallow
 * cup (part 2.1: white with a reddish-brown midrib down uv.x 0.5) and a
 * little knot of orange stamens (FRUIT, half ripe).
 */
function asphodelFlower(ctx, c, face, r, spin, near) {
  const { push, vcount, I } = ctx;
  const u = norm(cross(face, Math.abs(face[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), v = norm(cross(face, u));
  for (let k = 0; k < 6; k++) {
    const a = spin + (k / 6) * Math.PI * 2;
    const out = norm(add(add([0, 0, 0], u, Math.cos(a)), v, Math.sin(a)));
    const side = norm(cross(face, out));
    // The tepal rises a little out of the cup: out along `out`, up along `face`.
    const dir = norm(add(out, face, 0.35));
    const n = norm(cross(dir, side));
    const w = r * 0.32;
    const base = vcount();
    const pts = near ? [[0, 0.12], [0.45, 1], [0.8, 0.75], [1, 0]] : [[0, 0.12], [0.5, 1], [1, 0]];
    for (const [t, wf] of pts) {
      const p = add(add(c, dir, r * t), face, r * 0.12 * t * t);
      for (const s of [-1, 1]) push(add(p, side, s * w * wf), n, s * 0.5 + 0.5, t, [2.1, 1, 0.5, 0.55 + t * 0.45]);
    }
    for (let q = 0; q < pts.length - 1; q++) { const i0 = base + q * 2; I.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3); }
  }
  // Stamens: a small orange knot in the heart.
  blob(ctx, add(c, face, r * 0.12), r * 0.16, r * 0.12, 0, near ? 5 : 4, 2, 0.5, 0.5, 3.2);
}

/** The asphodel far away: a tuft, a stalk, a few white stars. */
function buildAsphodelFar(type, ctx) {
  const { near, far, rand } = ctx;
  addBladeFan(ctx, {
    count: Math.max(6, Math.round((type.fronds ?? 14) * 1.7)), keep: far ? 0.45 : near ? 1 : 0.7,
    // Soft, long, flopping out toward the ground (stiff ones read as a yucca).
    rows: near ? 5 : 2, len: 0.55, width: 0.034, spread: 0.85, arch: 1.35,
  });
  // The stalk — shorter than the old 1 m — branching like a candelabra
  // from about half way, each branch curving up.
  const H = 0.7 + rand() * 0.2;
  const top = [(rand() - 0.5) * 0.06, H, (rand() - 0.5) * 0.06];
  tubeTo(ctx, [0, 0, 0], top, 0.011, 0.006, 1, far ? 3 : 4);
  const branches = [[[top[0] * 0.6, H * 0.6, top[2] * 0.6], top]];
  const nb = Math.max(2, Math.round((type.leaflets ?? 3) * 1.6) - (far ? 3 : near ? 0 : 1));
  for (let k = 0; k < nb; k++) {
    const f = 0.42 + rand() * 0.25, at = [top[0] * f, H * f, top[2] * f], az = k * 2.39996 + rand() * 0.5;
    // Out sideways first, then up: a candelabra, not a bundle.
    const out = 0.6 + rand() * 0.35;
    const mid = add(at, norm([Math.cos(az), 0.35, Math.sin(az)]), 0.13 * out);
    const tip = add(mid, [Math.cos(az) * 0.06, 0.2 + rand() * 0.12, Math.sin(az) * 0.06]);
    if (!far) { tubeTo(ctx, at, mid, 0.005, 0.0045, 1, 3); tubeTo(ctx, mid, tip, 0.0045, 0.003, 1, 3); }
    branches.push([mid, tip]);
  }
  // Up each branch: seed capsules (green, FRUIT-flagged, ripeness 0) low
  // down, open star flowers (part 2, colorHead) through the middle, closed
  // buds (brown: rand 2, the dead flag) at the tip — the way a raceme opens
  // from the bottom up.
  // Far: only the open stars (what reads from a distance), fewer of them.
  const per = far ? 3 : near ? 11 : 6;
  for (const [a, b] of branches) {
    const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    for (let k = 0; k < per; k++) {
      const t = far ? 0.35 + (k / per) * 0.45 : 0.05 + (k / per) * 0.95;
      const c = add([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], [(rand() - 0.5) * 0.015, 0, (rand() - 0.5) * 0.015]);
      if (t < 0.3) blob(ctx, c, 0.011, 0.012, 0, near ? 4 : 3, 2, 0, 0, 3.2);
      else if (t > 0.8) blob(ctx, c, 0.008, 0.016, 0, near ? 4 : 3, 2, 0.5, 0.5, 2.2);
      else {
        // A star of six petals, facing out from the branch and a little up.
        const az = k * 2.39996 + rand();
        const face = norm(add([Math.cos(az), 0.6, Math.sin(az)], d, -0.3));
        starFlower(ctx, c, face, 0.034 * (0.85 + rand() * 0.3), far ? 5 : 6);
      }
    }
  }
  return ctx.finish();
}

/**
 * A flat star flower facing `face`: `petals` points round a centre (one
 * triangle fan), part 2 (colorHead), `along` 0.25 at the heart → 1 at the
 * petal tips, so the shader pales it outward.
 */
function starFlower({ push, vcount, I }, c, face, r, petals) {
  const u = norm(cross(face, Math.abs(face[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), v = norm(cross(face, u));
  const base = vcount();
  push(c, face, 0.5, 0.5, [2, 1, 0.5, 0.25]);
  const n = petals * 2;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2, rr = k % 2 ? r * 0.38 : r;
    push(add(add(c, u, Math.cos(a) * rr), v, Math.sin(a) * rr), face, 0.5, 0.5, [2, 1, 0.5, k % 2 ? 0.6 : 1]);
  }
  for (let k = 0; k < n; k++) I.push(base, base + 1 + k, base + 1 + ((k + 1) % n));
}

/**
 * BROOM (Spartium / Retama — genêt) — the rounded bush of thin grey-green
 * rods on the Aurès slopes, almost leafless, yellow pea-flowers along the
 * upper half of its rods. Rods part 0 (thin solid strips, colorBase →
 * colorTip), flowers part 2 (colorHead) as small 5-point stars.
 *   fronds  rods · flowers  flowers per rod
 */
function buildBroom(type, ctx) {
  const { near, far } = ctx;
  // Near and mid: ROUND rods that fork into twigs (2026-10-02: flat strips
  // with one shared normal read as a fan of planks). Far: the old strips,
  // which keep the bush's mass at a few triangles.
  if (!far) return buildBroomRods(type, ctx, near);
  const { rand, push, vcount, I, finish } = ctx;
  const rods = Math.max(10, Math.round((type.fronds ?? 70) * 0.3));
  const segs = 2;
  for (let k = 0; k < rods; k++) {
    const az = rand() * Math.PI * 2, open = 0.2 + rand() * 0.75, L = 0.7 + rand() * 0.35;
    const out = [Math.cos(az), 0, Math.sin(az)], side = [-Math.sin(az), 0, Math.cos(az)];
    // Fat (2-4 cm on a 2 m bush), fatter far: thin rods read as a wisp, not a bush (seen 2026-10-01).
    const w = 0.02 * (far ? 1.8 : 1.2);
    let p = [out[0] * 0.03, 0, out[2] * 0.03];
    const pts = [p];
    for (let s = 1; s <= segs; s++) {
      const t = s / segs, e = Math.PI / 2 - open * (0.4 + t * 0.7);
      p = add(p, [out[0] * Math.cos(e), Math.sin(e), out[2] * Math.cos(e)], L / segs);
      pts.push(p);
    }
    const base = vcount();
    pts.forEach((q, s) => { for (const sg of [-1, 1]) push(add(q, side, sg * w), norm(add(out, [0, 1, 0], 0.6)), sg * 0.5 + 0.5, s / segs, [0, 0.3 + (s / segs) * 0.6, rand(), 0]); });
    for (let s = 0; s < segs; s++) { const a = base + s * 2; I.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    // Flowers on the upper half.
    const nf = Math.round((type.flowers ?? 3) * (far ? 0.6 : 1));
    for (let f = 0; f < nf; f++) {
      const t = 0.5 + rand() * 0.5, i = Math.min(segs - 1, Math.floor(t * segs)), ft = t * segs - i;
      const c = add(pts[i], [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]], ft);
      const n = norm(add(out, [0, 1, 0], 0.8)), u = norm(cross(n, side)), v = norm(cross(n, u));
      const r = 0.03 * (0.8 + rand() * 0.4), b = vcount();
      push(c, n, 0.25, 0.5, [2, 1, 0.5, 0.2]);
      for (let q = 0; q < 6; q++) {
        const a = (q / 6) * Math.PI * 2, rr = q % 2 ? r * 0.5 : r;
        push(add(add(c, u, Math.cos(a) * rr), v, Math.sin(a) * rr), n, 0.25, 0.5, [2, 1, 0.5, 1]);
      }
      for (let q = 0; q < 6; q++) I.push(b, b + 1 + q, b + 1 + ((q + 1) % 6));
    }
  }
  return finish();
}

/**
 * The broom up close: each rod a thin three-sided tube rising out of the
 * crown and arching outward, forking in its upper half into two or three
 * twigs; yellow pea-flowers (part 2) strung along the twigs, denser toward
 * their tips. `t` (vHeight) runs up the whole bush, so the colour ramp and
 * the wind bend follow height, not each piece.
 */
function buildBroomRods(type, ctx, near) {
  const { rand, push, vcount, I } = ctx;
  const sides = 3;
  const rods = Math.max(10, Math.round((type.fronds ?? 70) * (near ? 0.6 : 0.45)));
  /** A tapered three-sided tube a → b; ta/tb the bush height fraction at each end. */
  const rod = (a, b, r0, r1, ta, tb, rr) => {
    const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const u = norm(cross(d, Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), v = norm(cross(d, u));
    const base = vcount();
    for (const [p, r, t] of [[a, r0, ta], [b, r1, tb]]) {
      for (let s = 0; s < sides; s++) {
        const ph = (s / sides) * Math.PI * 2, n = norm(add(add([0, 0, 0], u, Math.cos(ph)), v, Math.sin(ph)));
        push(add(p, n, r), n, s / sides, t, [0, t, rr, 0]);
      }
    }
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides;
      I.push(base + s, base + sides + s, base + s1, base + s1, base + sides + s, base + sides + s1);
    }
  };
  const flower = (c, out) => {
    // A pea-flower: a little yellow star turned outward and up.
    const n = norm(add(out, [0, 1, 0], 0.9));
    starFlower(ctx, c, n, 0.024 * (0.8 + rand() * 0.5), 4);
  };
  const H = 1.05;
  // Flowers per twig: the triangle budget lives here (a star is 8).
  const nf = Math.min(type.flowers ?? 3, near ? 3 : 2);
  for (let k = 0; k < rods; k++) {
    const az = rand() * Math.PI * 2, open = 0.15 + rand() * 0.7, L = 0.65 + rand() * 0.4, rr = rand();
    const out = [Math.cos(az), 0, Math.sin(az)];
    const dirAt = (t) => { const e = Math.PI / 2 - open * (0.3 + t * 0.8); return [out[0] * Math.cos(e), Math.sin(e), out[2] * Math.cos(e)]; };
    // The rod: two pieces, bending outward as it climbs.
    const p0 = [out[0] * 0.02, 0, out[2] * 0.02];
    const p1 = add(p0, dirAt(0.25), L * 0.5);
    const p2 = add(p1, dirAt(0.75), L * 0.5);
    rod(p0, p1, 0.011, 0.008, 0, p1[1] / H, rr);
    rod(p1, p2, 0.008, 0.004, p1[1] / H, p2[1] / H, rr);
    // Twigs from the upper half, splaying a little further out.
    const twigs = near ? 2 + (rand() < 0.5 ? 1 : 0) : 1;
    for (let q = 0; q < twigs; q++) {
      const f = 0.35 + rand() * 0.5;
      const at = add(p1, [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]], f);
      const taz = az + (rand() - 0.5) * 1.6, tout = [Math.cos(taz), 0, Math.sin(taz)];
      const tip = add(at, norm(add(tout, [0, 1, 0], 1.1 + rand())), L * (0.2 + rand() * 0.15));
      rod(at, tip, 0.005, 0.0025, at[1] / H, tip[1] / H, rr);
      for (let fi = 0; fi < nf; fi++) {
        const ft = 0.45 + (fi / nf) * 0.55;
        flower(add(at, [tip[0] - at[0], tip[1] - at[1], tip[2] - at[2]], ft), tout);
      }
    }
    for (let fi = 0; fi < Math.ceil(nf / 2); fi++) flower(add(p1, [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]], 0.6 + fi * 0.15), out);
  }
  return ctx.finish();
}

/**
 * AGAVE MAST — the flower stalk an agave sends up once, at the end of its
 * life: a straight pole 5-7 m tall, short arms in its upper third like a
 * candelabrum, each holding a clump of (late-summer, drying) flowers. Placed
 * beside one agave in a few (alg-rts algLandmarks.js). Stalk = part 1, the
 * clumps = part 2 (colorHead). Unit frame (height 1).
 */
function buildAgaveMast(type, ctx) {
  return buildAgaveMastV2(type, ctx);
}

/**
 * AGAVE MAST v2 (2026-10-02, you: "the agave in flower looks so cheap that
 * it's unusable"). The real thing (Agave americana): a stout asparagus-like
 * spear ~10 cm thick at its foot, tapering, clad in small papery bracts; in
 * its upper half 15-20 side branches — long low down, short near the top, so
 * the whole reads as a candelabrum / pine silhouette — each rising and
 * ending in an UPWARD brush of yellow tubular flowers with long stamens
 * (a flat-topped tuft, not a ball). Late summer: some tufts gone brown.
 *   stalk + branches  part 1.25 (a woody stalk: colorBase → colorTip by height)
 *   fresh flowers     part 2 (colorHead), `along` 0 at the tuft's heart → 1 at the tips
 *   dried flowers     part 0 with rand 2.2 (the shader's dead-leaf brown)
 *   bracts            part 1.25
 * Unit frame (height ~1; the preset's size makes it 6 m).
 */
function buildAgaveMastV2(type, ctx) {
  const { near, far, rand, push, vcount, I } = ctx;
  const sides = far ? 4 : near ? 8 : 6;
  /** A tapered tube a → b, part 1.25, `t` = height fraction at each end. */
  const tube = (a, b, r0, r1) => {
    const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const u = norm(cross(d, Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), v = norm(cross(d, u));
    const base = vcount();
    for (const p of [a, b]) {
      const r = p === a ? r0 : r1;
      for (let s = 0; s < sides; s++) {
        const ph = (s / sides) * Math.PI * 2, n = norm(add(add([0, 0, 0], u, Math.cos(ph)), v, Math.sin(ph)));
        push(add(p, n, r), n, s / sides, p[1], [1.25, Math.min(1, Math.max(0, p[1])), 0.3, 0]);
      }
    }
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides;
      I.push(base + s, base + sides + s, base + s1, base + s1, base + sides + s, base + sides + s1);
    }
  };
  // The spear: a few segments, a gentle lean that curves back.
  const lx = (rand() - 0.5) * 0.05, lz = (rand() - 0.5) * 0.05;
  const at = (f) => [lx * Math.sin(f * Math.PI * 0.8), f, lz * Math.sin(f * Math.PI * 0.8)];
  const R = (f) => 0.011 * (1 - f * 0.78);
  const nSeg = far ? 3 : 6;
  for (let s = 0; s < nSeg; s++) tube(at(s / nSeg), at((s + 1) / nSeg), R(s / nSeg), R((s + 1) / nSeg));
  // Bracts: papery scales up the lower spear.
  if (near) {
    for (let k = 0; k < 14; k++) {
      const f = 0.06 + k * 0.032, az = k * 2.39996, o = [Math.cos(az), 0, Math.sin(az)];
      const c = add(at(f), o, R(f) * 0.9);
      spike(ctx, c, add(o, [0, 1, 0], 2.2), 0.035, R(f) * 0.9, [1.25, f, 0.3, 0], norm(add(o, [0, 1, 0], 0.3)));
    }
  }
  // The branches: from 45% up to the top, golden-angle round the spear.
  const nb = far ? 9 : near ? 19 : 14;
  for (let k = 0; k < nb; k++) {
    const f = 0.45 + (k / nb) * 0.53;
    const az = k * 2.39996 + rand() * 0.3, o = [Math.cos(az), 0, Math.sin(az)];
    const reach = 0.035 + (1 - (f - 0.45) / 0.55) * 0.085 * (0.85 + rand() * 0.3);
    const p0 = at(f);
    const mid = add(add(p0, o, reach * 0.65), [0, reach * 0.25, 0]);
    const tip = add(add(mid, o, reach * 0.35), [0, reach * 0.35, 0]);
    if (!far) { tube(p0, mid, R(f) * 0.38, R(f) * 0.25); tube(mid, tip, R(f) * 0.25, R(f) * 0.18); }
    else tube(p0, tip, R(f) * 0.35, R(f) * 0.2);
    // The tuft: tubular flowers fanning UP and out from the branch tip.
    const dry = rand() < 0.3;
    // (2026-10-02: bigger "cushion" tufts were tried and read worse — you
    // preferred these small open star tufts.)
    const cr = 0.022 + (1 - (f - 0.45) / 0.55) * 0.012;
    if (far) {
      blob(ctx, add(tip, [0, cr * 0.5, 0]), cr * 1.2, cr * 0.6, dry ? 0 : 2, 5, 2, 0.3, 1, dry ? 2.2 : 0.5);
      continue;
    }
    const nfl = near ? 22 : 11;
    for (let q = 0; q < nfl; q++) {
      const a = q * 2.39996 + rand() * 0.4, rr = Math.sqrt((q + 0.5) / nfl);
      const dir = norm([Math.cos(a) * rr * 0.9, 1.1 - rr * 0.4, Math.sin(a) * rr * 0.9]);
      const c = add(tip, [Math.cos(a) * rr * cr * 0.35, 0, Math.sin(a) * rr * cr * 0.35]);
      const len = cr * (0.9 + rand() * 0.4);
      // (A dry tuft is a dead LEAF to the shader: keep its flutter weight low.)
      spike(ctx, c, dir, len, cr * 0.14, dry ? [0, 0.9, 2.2, 0.15] : [2, 1, 0.5, 1]);
    }
    // The tuft's dense heart, so it never reads as a sparse comb.
    blob(ctx, add(tip, [0, cr * 0.3, 0]), cr * 0.55, cr * 0.4, dry ? 0 : 2, near ? 6 : 4, 2, 0, 0.4, dry ? 2.2 : 0.5);
  }
  return ctx.finish();
}

/**
 * OLEANDER (Nerium oleander) — its own builder (2026-10-02, you: "we can
 * really make it look far better"; it was the ginger cane-clump, a funnel
 * of loose cards on pale sticks). The real shrub of every wadi:
 *   · a VASE of many stems straight out of the ground, splaying outward;
 *   · narrow, dark, leathery leaves in WHORLS OF THREE, crowded toward the
 *     stem ends, pointing out and up (the lower ones droop);
 *   · side shoots off the upper stems, so the top is a full dome;
 *   · a CLUSTER of five-petal pink blossoms at every stem and shoot tip.
 * Leaves are cards in the lance-leaf texture (part 5.25: a DOME card —
 * foliageSystem keeps the baked dome normal, no flip to the viewer),
 * stems a woody stalk (part 1.25: colorBase → colorTip), blossoms part 2.
 * Unit frame (height ~1).
 *   fronds  stems × 10 · flowers  blossoms per cluster / 2
 */
function buildOleander(type, ctx) {
  const { near, far, rand, push, vcount, I } = ctx;
  const LEAF = 5.25;
  const stems = far ? 7 : near ? 15 : 11;
  const whorlStep = far ? 0.13 : near ? 0.05 : 0.075;
  const leafLen = (type.frondLength ?? 1) * (far ? 0.2 : 0.16);
  const wide = (type.leafletWidth ?? 1) * (far ? 1.6 : 1.3);
  const droop = type.droop ?? 0.2;

  const card = (hinge, dir, len, halfW, lr, t) => {
    const side = norm(cross(dir, [0, 1, 0.001]));
    const n0 = norm(cross(dir, side));
    const n = n0[1] < 0 ? [-n0[0], -n0[1], -n0[2]] : n0;
    const u0 = lr < 0.5 ? 0 : 0.5;
    const base = vcount();
    for (const vv of [0, 1]) for (const uu of [0, 1]) {
      push(add(add(hinge, dir, len * vv), side, (uu - 0.5) * halfW * 2), n, u0 + uu * 0.5, vv, [LEAF, t, lr, vv]);
    }
    I.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  };
  const stemTube = (a, b, r0, r1) => {
    if (far) return;
    const sides = near ? 4 : 3;
    const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const u = norm(cross(d, Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), v = norm(cross(d, u));
    const base = vcount();
    for (const [p, r] of [[a, r0], [b, r1]]) {
      for (let s = 0; s < sides; s++) {
        const ph = (s / sides) * Math.PI * 2, n = norm(add(add([0, 0, 0], u, Math.cos(ph)), v, Math.sin(ph)));
        push(add(p, n, r), n, s / sides, p[1], [1.25, Math.min(1, p[1]), 0.3, 0]);
      }
    }
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides;
      I.push(base + s, base + sides + s, base + s1, base + s1, base + sides + s, base + sides + s1);
    }
  };
  /** Whorls of three leaves up a shoot from `a` to `b`, from fraction f0. */
  const leafy = (a, b, f0) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L = Math.hypot(d[0], d[1], d[2]);
    const n = Math.max(1, Math.floor((L * (1 - f0)) / whorlStep));
    for (let w = 0; w < n; w++) {
      const f = f0 + (1 - f0) * ((w + 0.5) / n);
      const at = add(a, d, f);
      const rot = w * 1.05 + rand();
      for (let k = 0; k < 3; k++) {
        const az = rot + (k / 3) * Math.PI * 2;
        const out = [Math.cos(az), 0, Math.sin(az)];
        // Out and up near the tip; the lower whorls droop.
        const rise = 0.9 - (1 - f) * (0.6 + droop * 1.5);
        const lr = rand();
        const len = leafLen * (0.8 + lr * 0.4) * (0.75 + 0.25 * f);
        card(at, norm([out[0], rise, out[2]]), len, len * 0.22 * wide, lr, at[1]);
      }
    }
  };
  /** A cluster of blossoms in a dome at `tip`. */
  const cluster = (tip, scale) => {
    // (The triangle budget is here: a blossom is 15 near, 10 mid, 6 far.)
    const nb = Math.round((type.flowers ?? 3) * (far ? 1 : near ? 2.7 : 1.5) * scale);
    const R = 0.05 * scale;
    // Five ROUND petals: three points a petal — its two shoulders full, the
    // join between petals pinched in (a star's sharp points read as maple
    // leaves). Far: three lobes, two points each.
    const lobes = far ? 3 : 5, per = near ? 3 : 2, steps = lobes * per;
    for (let k = 0; k < nb; k++) {
      const a = k * 2.39996, rr = Math.sqrt((k + 0.5) / nb);
      const off = [Math.cos(a) * rr * R, (1 - rr * rr) * R * 0.5, Math.sin(a) * rr * R];
      const c = add(tip, off);
      const n = norm(add([off[0], 0, off[2]], [0, 1, 0], R * 1.2));
      const u = norm(cross(n, [0.3, 0.1, 1])), v2 = norm(cross(n, u));
      const s = 0.021 * (0.85 + rand() * 0.3) * (far ? 1.6 : near ? 1 : 1.2);
      const spin = rand() * Math.PI * 2;
      const b = vcount();
      push(add(c, n, s * 0.15), n, 0.25, 0.5, [2, 1, 0.5, 0]);
      for (let q = 0; q < steps; q++) {
        const ang = spin + (q / steps) * Math.PI * 2;
        const rad = s * (q % per === 0 ? 0.6 : 0.97);
        push(add(add(c, u, Math.cos(ang) * rad), v2, Math.sin(ang) * rad), n, 0.25, 0.5, [2, 1, 0.5, q % per === 0 ? 0.6 : 1]);
      }
      for (let q = 0; q < steps; q++) I.push(b, b + 1 + q, b + 1 + ((q + 1) % steps));
    }
  };

  for (let s = 0; s < stems; s++) {
    const az = s * 2.39996 + rand() * 0.4;
    const out = [Math.cos(az), 0, Math.sin(az)];
    // The vase: inner stems tall and upright, outer ones shorter and leaning.
    const outer = (s % 3) / 2;
    const lean = 0.12 + outer * 0.3 + rand() * 0.08;
    const H = 1 - outer * 0.28 - rand() * 0.1;
    const root = [out[0] * 0.04, 0, out[2] * 0.04];
    const mid = add(root, [out[0] * Math.sin(lean) * 0.8, Math.cos(lean), out[2] * Math.sin(lean) * 0.8], H * 0.55);
    const tip = add(mid, [out[0] * Math.sin(lean * 1.4), Math.cos(lean * 1.4), out[2] * Math.sin(lean * 1.4)], H * 0.45);
    stemTube(root, mid, 0.012, 0.008);
    stemTube(mid, tip, 0.008, 0.004);
    leafy(mid, tip, 0);
    leafy(root, mid, 0.55);
    cluster(tip, 1);
    // Side shoots off the upper stem, filling the dome.
    const shoots = far ? 1 : near ? 2 : 1;
    for (let q = 0; q < shoots; q++) {
      const f = 0.25 + rand() * 0.5;
      const at = add(mid, [tip[0] - mid[0], tip[1] - mid[1], tip[2] - mid[2]], f);
      const saz = az + (rand() - 0.5) * 2.2;
      const sTip = add(at, norm([Math.cos(saz), 0.9, Math.sin(saz)]), H * (0.22 + rand() * 0.1));
      stemTube(at, sTip, 0.005, 0.003);
      leafy(at, sTip, 0.2);
      cluster(sTip, 0.75);
    }
  }
  return ctx.finish();
}

/**
 * TAMARISK TREE, GROWN (2026-10-02, you: "build the best convincing tree and
 * foliage"; the dipterocarp-based one read as a spoke umbrella of stamped
 * cards). A real Tamarix of the wadi banks:
 *   · 2-3 LEANING trunks of dark reddish bark from one foot, each forking
 *     again and again at uneven heights — a recursive skeleton, every limb
 *     curving a little, thinner and shorter each generation (no two trees
 *     alike: the seed grows it);
 *   · on the last two generations, hundreds of thin WANDS of feathery
 *     scale-leaves (the plume strand texture, crossed cards, part 2.4: the
 *     dome normal, no flip) that rise, arch over and WEEP — the outline
 *     ragged, see-through at the edges, drooping tips;
 *   · late summer: some wands carry the pink flower plumes (the shader tints
 *     part 2.4 with rand > 0.9).
 * Unit frame (height ~1). Woody parts 1.25 (colorBase → colorTip = bark).
 *   fronds  trunks
 */
function buildTamariskTree(type, ctx) {
  const { near, far, rand, push, vcount, I } = ctx;
  const sides = far ? 3 : near ? 5 : 4;
  const tube = (a, b, r0, r1) => {
    const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const u = norm(cross(d, Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), v = norm(cross(d, u));
    const base = vcount();
    for (const [p, r] of [[a, r0], [b, r1]]) {
      for (let s = 0; s < sides; s++) {
        const ph = (s / sides) * Math.PI * 2, n = norm(add(add([0, 0, 0], u, Math.cos(ph)), v, Math.sin(ph)));
        push(add(p, n, r), n, s / sides, p[1], [1.25, Math.min(1, Math.max(0, p[1])), 0.3, 0]);
      }
    }
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides;
      I.push(base + s, base + sides + s, base + s1, base + s1, base + sides + s, base + sides + s1);
    }
  };
  const segsW = near ? 3 : 2;
  /** A weeping wand: two crossed strand cards from `a`, heading `dir`. */
  const wand = (a, dir, L, halfW, wr) => {
    for (const cardAngle of [0, Math.PI / 2]) {
      const ca = Math.cos(cardAngle), sa = Math.sin(cardAngle);
      const dAcross = norm(cross(dir, [0, 1, 0.001]));
      const dUp = norm(cross(dAcross, dir));
      const wide = norm(add(add([0, 0, 0], dAcross, ca), dUp, sa));
      const n = norm(cross(dir, wide));
      const base = vcount();
      for (let q = 0; q <= segsW; q++) {
        const v = q / segsW;
        const c = add(add(a, dir, L * v), [0, -1, 0], L * 0.55 * v * v);
        const w = halfW * (0.5 + 0.5 * Math.sin(Math.PI * Math.min(1, v * 1.1)));
        for (const s of [-1, 1]) push(add(c, wide, s * w), n, s * 0.5 + 0.5, v, [2.4, Math.min(1, c[1]), wr, v]);
      }
      for (let q = 0; q < segsW; q++) {
        const i0 = base + q * 2;
        I.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
      }
    }
  };

  const maxDepth = far ? 2 : near ? 4 : 3;
  // A FULL crown (4 a twig left the limbs bare): the wands are the tree.
  const wandsPerTwig = far ? 5 : near ? 7 : 7;
  const wandW = far ? 0.1 : near ? 0.07 : 0.08;
  /** Grow a limb from `p` along `dir`: `len`, radius r, generation g. */
  const grow = (p, dir, len, r, g) => {
    // The limb itself, in two bent pieces.
    const bendAx = norm(cross(dir, [rand() - 0.5, 0.2, rand() - 0.5]));
    const mid = add(add(p, dir, len * 0.5), bendAx, len * 0.08 * (rand() - 0.5) * 2);
    const dir2 = norm(add(dir, [0, 0.12, 0], 1));
    const end = add(mid, norm(add(dir2, bendAx, 0.15 * (rand() - 0.5))), len * 0.5);
    if (!far || g < 2) { tube(p, mid, r, r * 0.85); tube(mid, end, r * 0.85, r * 0.7); }
    // Wands on the last two generations, along the limb and at its end.
    if (g >= maxDepth - 1) {
      const n = g === maxDepth ? wandsPerTwig + 1 : wandsPerTwig - 1;
      for (let w = 0; w < n; w++) {
        const f = 0.35 + (w / Math.max(1, n - 1)) * 0.65;
        const at = f < 0.5 ? add(p, [mid[0] - p[0], mid[1] - p[1], mid[2] - p[2]], f * 2) : add(mid, [end[0] - mid[0], end[1] - mid[1], end[2] - mid[2]], (f - 0.5) * 2);
        const az = rand() * Math.PI * 2;
        const wd = norm(add(add(dir, [Math.cos(az), 0, Math.sin(az)], 0.9), [0, 1, 0], 0.35 + rand() * 0.5));
        wand(at, wd, 0.16 + rand() * 0.12, wandW * (0.8 + rand() * 0.4), rand());
      }
    }
    if (g >= maxDepth) return;
    // Children: 2-3, splaying from the limb's upper half at uneven heights.
    const kids = 2 + (rand() < 0.45 ? 1 : 0);
    for (let k = 0; k < kids; k++) {
      const f = k === 0 ? 1 : 0.45 + rand() * 0.45;
      const at = f >= 1 ? end : add(mid, [end[0] - mid[0], end[1] - mid[1], end[2] - mid[2]], (f - 0.45) / 0.55);
      const side = norm(cross(dir, [Math.cos(k * 2.4 + rand()), 0.3, Math.sin(k * 2.4 + rand())]));
      const spreadA = (0.35 + rand() * 0.4) * (k === 0 ? 0.6 : 1);
      // Up and out — the outer generations lean out further and droop.
      const cd = norm(add(add(dir, side, Math.tan(spreadA)), [0, 1, 0], g < 2 ? 0.15 : -0.05));
      grow(at, cd, len * (0.62 + rand() * 0.14), r * 0.62, g + 1);
    }
  };

  const trunks = Math.max(2, Math.min(3, Math.round(type.fronds ?? 3)));
  for (let t = 0; t < trunks; t++) {
    const az = t * 2.39996 + rand() * 0.8;
    const lean = 0.2 + rand() * 0.3;
    const dir = norm([Math.cos(az) * Math.sin(lean), Math.cos(lean), Math.sin(az) * Math.sin(lean)]);
    grow([Math.cos(az) * 0.02, 0, Math.sin(az) * 0.02], dir, 0.36 + rand() * 0.08, 0.026 - t * 0.003, 0);
  }
  return ctx.finish();
}

function buildLeafy(type, { near, far, rand, push, vcount, I, finish, bush }) {
  const leaves = Math.max(3, Math.round((type.fronds ?? 9) * (far ? 0.45 : near ? 1 : 0.7)));
  const size = (type.frondLength ?? 1) * (bush ? 0.45 : 0.6);
  // 1 = the texture's own proportions. The half-texture a card samples is
  // 256x512, so an undistorted card is half as wide as it is long, and the
  // blade drawn inside it does the rest.
  const wide = (type.leafletWidth ?? 1) * (bush ? 0.95 : 1.15);
  const droop = type.droop ?? 0.3;
  // 5 + the normal lift in the fraction. 0.85, the ground fern's value: these
  // sit low and flat, and at the palm's 0.5 the ones facing away from the sun
  // go black — which is what the whole map was just cleaned of.
  const LEAF = 5.85;
  const STALK = 1;

  /** One leaf card, hung from `hinge`, pointing `dir`, `wide` across. */
  const card = (hinge, dir, side, len, halfW, lr, t) => {
    const n0 = norm(cross(dir, side));
    const n = n0[1] < 0 ? [-n0[0], -n0[1], -n0[2]] : n0;
    // Which of the two leaves in the texture: whole on the left half, torn on
    // the right. Per leaf, so a clump carries both.
    const u0 = lr < 0.5 ? 0 : 0.5;
    const base = vcount();
    for (const vv of [0, 1]) {
      for (const uu of [0, 1]) {
        const p = add(add(hinge, dir, len * vv), side, (uu - 0.5) * halfW * 2);
        push(p, n, u0 + uu * 0.5, vv, [LEAF, t, lr, vv]);
      }
    }
    I.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  };

  if (bush) {
    // ── A ginger clump ──────────────────────────────────────────────────
    // Canes of different ages leaning out of one root, each with leaves up
    // two ranks. The leaves nearest the top are the youngest and stand up;
    // the lower ones arch further over.
    const canes = Math.max(2, Math.round(2 + (leaves / 14)));
    const perCane = Math.max(2, Math.round(leaves / canes));
    const clumpAz = rand() * Math.PI * 2;
    for (let c = 0; c < canes; c++) {
      const age = 1 - (c / canes) * 0.45 - rand() * 0.12;
      const caneH = size * (1.5 * age);
      const az = clumpAz + (c / canes) * Math.PI * 2 + (rand() - 0.5) * 0.8;
      const lean = 0.12 + rand() * 0.22;
      const outD = [Math.cos(az), 0, Math.sin(az)];
      const top = [outD[0] * Math.sin(lean) * caneH, Math.cos(lean) * caneH, outD[2] * Math.sin(lean) * caneH];
      // The cane itself: a thin strip, near only.
      if (near) {
        const w = size * 0.012 * (type.stemWidth ?? 1);
        const sd = norm(cross(norm(top), [0, 1, 0.001]));
        const b = vcount();
        for (const [pt, v] of [[[0, 0, 0], 0], [top, 1]]) {
          for (const s of [-1, 1]) push(add(pt, sd, s * w), [0, 1, 0], s * 0.5 + 0.5, v, [STALK, v, 0.3, 0]);
        }
        I.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
      for (let l = 0; l < perCane; l++) {
        const f = perCane === 1 ? 1 : 0.28 + 0.72 * (l / (perCane - 1));
        const lr = rand();
        // Two ranks: alternate sides, as a ginger's leaves do.
        const rank = (l % 2 === 0 ? 1 : -1);
        const la = az + rank * (1.25 + (rand() - 0.5) * 0.5);
        const at = [top[0] * f, top[1] * f, top[2] * f];
        const outward = [Math.cos(la), 0, Math.sin(la)];
        // Young leaves at the top stand up; older ones below arch right over.
        const rise = 0.75 - f * 0.15 - droop * (1 - f) * 1.1;
        const dir = norm([outward[0], rise, outward[2]]);
        const side = norm(cross(dir, [0, 1, 0.001]));
        const len = size * (0.72 + lr * 0.4) * (0.7 + 0.3 * f);
        card(at, dir, side, len, len * 0.25 * wide, lr, f);
      }
      // FLOWERS (type.flowers, e.g. oleander): a cluster of small blossom
      // cards at the cane's top, in colorHead (part 2; uv in the leaf
      // texture's solid middle, so they draw as solid colour, not a leaf
      // outline). Kept on the far level too — from the RTS camera the pink
      // is the whole point of an oleander line.
      //
      // Each FLOWER is a real blossom: five rounded petals as a lobed star
      // (a fan of triangles round a darker centre — `along` 0 at the heart,
      // 1 at the petal tips, which the head colour ramps over), turned out
      // and up from the cluster's middle. Two crossed flat quads per flower
      // read as pink paper squares close up (you, 2026-10-01). A cane's
      // cluster has `flowers` × 2 of them, bunched in a dome at its top.
      // Petals EXAGGERATED (~10 cm across on a 3.6 m bush) so the pink
      // still reads from the RTS camera.
      const fl = Math.round((type.flowers ?? 0) * (far ? 1.5 : 3));
      const lobes = far ? 3 : 5, steps = lobes * 2;
      for (let k = 0; k < fl; k++) {
        const r = size * 0.11;
        const off = [(rand() - 0.5) * r * 2, (rand() - 0.2) * r, (rand() - 0.5) * r * 2];
        const c = add(top, off);
        const n = norm(add(off, [0, 1, 0], r * 1.5));                // facing out of the dome
        const u = norm(cross(n, [0.3, 0.1, 1]));
        const v2 = norm(cross(n, u));
        const s = r * (0.42 + rand() * 0.18);    // big enough to carry the pink at play zoom
        const spin = rand() * Math.PI * 2;
        const b = vcount();
        push(add(c, n, s * 0.12), n, 0.25, 0.5, [2, 1, 0.5, 0]);       // the heart, a little raised
        for (let q = 0; q < steps; q++) {
          const a = spin + (q / steps) * Math.PI * 2;
          const rr = q % 2 === 0 ? s : s * 0.55;                      // petal tip / notch
          const p = add(add(c, u, Math.cos(a) * rr), v2, Math.sin(a) * rr);
          push(p, n, 0.25, 0.5, [2, 1, 0.5, q % 2 === 0 ? 1 : 0.6]);
        }
        for (let q = 0; q < steps; q++) I.push(b, b + 1 + q, b + 1 + ((q + 1) % steps));
      }
    }
    return finish();
  }

  // ── Ground cover: a low rosette ────────────────────────────────────────
  for (let l = 0; l < leaves; l++) {
    // Golden angle: leaves never line up, whatever the count.
    const a = l * 2.39996 + rand() * 0.5;
    const lr = rand();
    const rise = 0.12 + lr * 0.25;
    const out = norm([Math.cos(a) * (1 - rise * 0.55), rise, Math.sin(a) * (1 - rise * 0.55)]);
    const side = norm(cross(out, [0, 1, 0.001]));
    const stalk = size * (0.3 + lr * 0.3);
    const root = [0, 0.01, 0];
    const hinge = add(root, out, stalk);
    const leafLen = size * (0.6 + lr * 0.5);
    const leafDir = norm([out[0], out[1] - droop * (0.4 + lr * 0.5), out[2]]);
    card(hinge, leafDir, side, leafLen, leafLen * 0.25 * wide, lr, rise);

    if (near && stalk > 0.02) {
      const w = 0.008 * (type.stemWidth ?? 1);
      const sN = norm(cross(out, side));
      const sBase = vcount();
      for (const [pt, v] of [[root, 0], [hinge, 1]]) {
        for (const s of [-1, 1]) push(add(pt, side, s * w), sN, s * 0.5 + 0.5, v, [STALK, v, lr, 0]);
      }
      I.push(sBase, sBase + 2, sBase + 1, sBase + 1, sBase + 2, sBase + 3);
    }
  }
  return finish();
}

