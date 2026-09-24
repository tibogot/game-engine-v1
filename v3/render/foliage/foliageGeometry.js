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
  taro:      [0.05, 0.6],
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
    case "pampas": case "susuki": return "plume";
    case "bamboo": return "spray";
    case "palm": case "areca": return "frond";
    case "fanPalm": return "fan";
    case "bush": case "broadleaf": return "lance";
    case "jungleTree": return "canopy";
    case "cardFern": return "fern";
    case "banana": case "travellersPalm": return "banana";
    case "banyan": return "banyan";
    case "taro": return "taro";
    default: return null;
  }
}

/** Plants whose head is drawn with the plume strand texture (their own, alpha-tested material). */
export function usesPlumeTexture(kind) {
  return cardTextureOf(kind) === "plume";
}

export function createFoliageTypeGeometry(type, { lod = 0 } = {}) {
  const near = lod === 0, far = lod === 2;
  const P = [], N = [], UV = [], A = [], I = [];
  const rand = rng(131 + Math.round((type.fronds ?? 7) * 37 + (type.arch ?? 1) * 500 + (type.leaflets ?? 10) * 11));

  const push = (p, n, u, v, a) => {
    P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); UV.push(u, v); A.push(a[0], a[1], a[2], a[3]);
    return P.length / 3 - 1;
  };
  const vcount = () => P.length / 3;
  const finish = () => {
    roundLeafNormals(type, P, N, A);
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
  if (type.kind === "palm") return buildPalm(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "jungleTree") return buildJungleTree(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "areca") return buildAreca(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "fanPalm") return buildFanPalm(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "cardFern") return buildCardFern(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "banana" || type.kind === "taro") return buildBanana(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "travellersPalm") return buildTravellersPalm(type, { near, far, rand, push, vcount, I, finish });
  if (type.kind === "banyan") return buildBanyan(type, { near, far, rand, push, vcount, I, finish });
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
  addBladeFan(ctx, {
    count: Math.max(3, Math.round((type.fronds ?? 14) * (far ? 0.55 : near ? 1 : 0.8))),
    rows: near ? 5 : far ? 2 : 3,
    len: type.frondLength ?? 1.0,
    width: 0.035 * (type.leafletWidth ?? 1),
    spread: type.spread ?? 0.35,
    arch: type.arch ?? 0.9,
  });
  return ctx.finish();
}

/**
 * A fan of long tapered blades rising from one point, each bending over and
 * twisting so it is not a flat ribbon. The base of a reed clump or a cattail.
 */
function addBladeFan({ rand, push, vcount, I }, { count, rows, len: baseLen, width, spread, arch }) {
  for (let b = 0; b < count; b++) {
    const a = (b / count) * Math.PI * 2 + rand() * 0.8;
    const br = rand();
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
      for (const s of [-1, 1]) push(add(p, across, s * w), n, s * 0.5 + 0.5, L.v, [0, L.v, br, Math.abs(s)]);
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

  // The clump of leaves it grows out of.
  addBladeFan(ctx, {
    count: Math.max(2, Math.round((type.fronds ?? 7) * (far ? 0.5 : near ? 1 : 0.75))),
    rows: near ? 5 : far ? 2 : 3,
    len: height * (plume ? 0.8 : 0.95),
    width: (plume ? 0.03 : 0.022) * (type.leafletWidth ?? 1),
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
    const len = height * (0.85 + sr * 0.3);
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

