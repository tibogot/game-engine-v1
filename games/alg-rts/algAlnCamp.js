// THE FLN CAMP IN SANDSTONE (2026-10-11, you: "the FLN camp looks wrong and too cheap low-poly now,
// compared to the cave"). In the BUILDINGS LAB first ("Camp du FLN"), the game's camp beside it.
//
// The camp's builder in its `modern` form (rtsAlnCamp buildAlnCamp: the house in sandstone, brush
// heaps and sacks instead of boxes, no faceted outcrops, no second cave) and, round it, what the cave
// is made of (algCave.js): the SANDSTONE generator's blocks for the rock the camp leans on, and its
// small stones for the DRY STONE — the sangars (stone, not sandbags: the French had the sandbags),
// the forecourt's walls, the fire's ring, the flagpole's cairn — where `userData.drystone` says.
// One merged rock mesh, one draw, beside the kit's.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { buildAlnCamp } from "../../v3/render/objects/rtsAlnCamp.js";
import { getRockGeometry } from "../../v3/props/proceduralRock.js";
import { sandstoneMaterial, sandstoneParams, setSandstoneColour } from "./algSandstone.js";
import { pebble } from "./algCave.js";

const S = 1.3;   // the kit's scale (rtsAlnCamp: real metres × 1.3); the layout below is in kit metres

/**
 * The rock the camp leans on (kit metres; y = its foot): the game's own sandstone shapes (made in
 * workers at the boot: algSandstone SANDSTONE_GAME), scaled per piece. Where the faceted outcrops
 * stood: a long one behind (+Z), lesser ones at the flanks.
 */
const ROCKS = [
  { shape: "mesa", seed: 2, at: [0.5, -0.3, 14.5], k: [0.95, 1.25, 0.72], yaw: 0.05 },
  { shape: "mesa", seed: 1, at: [-3.5, -0.3, 19.5], k: [0.7, 1.7, 0.55], yaw: -0.2 },        // the step behind: taller, its own foot
  { shape: "block", seed: 2, at: [-15, -0.3, 8.5], k: [0.62, 0.85, 0.6], yaw: 0.35, lean: 0.03 },
  { shape: "low", seed: 1, at: [15.5, -0.3, 10], k: [0.55, 1.1, 0.55], yaw: -0.5 },
  { shape: "low", seed: 2, at: [9.5, -0.3, 13], k: [0.45, 0.9, 0.42], yaw: 0.9 },
];

function rngFrom(seed) {
  let st = seed * 9301 + 49297;
  return () => ((st = (st * 9301 + 49297) % 233280) / 233280);
}

export function buildModernAlnCamp({ seed = 1954, colour = "aures" } = {}) {
  const kit = buildAlnCamp({ seed, modern: true });
  setSandstoneColour(colour);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), rnd = rngFrom(seed);
  const geos = [], nav = [], cover = [];
  // THE ROCK
  for (const r of ROCKS) {
    const g = getRockGeometry(sandstoneParams(r.shape, r.seed)).clone();
    e.set(0, r.yaw, r.lean ?? 0);
    g.applyMatrix4(m.compose(new THREE.Vector3(...r.at).multiplyScalar(S), q.setFromEuler(e), new THREE.Vector3(...r.k).multiplyScalar(S)));
    geos.push(g);
    if (r.at[1] > 1) continue;   // (one on top of another: the lower one blocks)
    g.computeBoundingBox();
    const b = g.boundingBox, cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2, hx = (b.max.x - b.min.x) * 0.4, hz = (b.max.z - b.min.z) * 0.4;
    nav.push({ cx, cz, hx, hz });
    cover.push({ hard: true, pts: [[cx - hx, cz - hz], [cx + hx, cz - hz], [cx + hx, cz + hz], [cx - hx, cz + hz], [cx - hx, cz - hz]] });
  }
  // THE DRY STONE (kit metres, where the camp's builder says)
  const d = kit.userData.drystone;
  const put = (x, y, z, k, yaw) => geos.push(pebble(m, q, e, rnd, x, y, z, k, yaw));
  // the forecourt's walls: three courses along each run, the joints staggered
  for (const [a, b] of d.walls) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), yaw = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);   // (a stone's long side along the run)
    for (let c = 0; c < 3; c++) {
      for (let s = c % 2 ? 0.28 : 0; s <= len; s += 0.56 + rnd() * 0.12) {
        const f = s / len;
        put(a[0] + (b[0] - a[0]) * f, c * 0.27 - 0.03, a[1] + (b[1] - a[1]) * f, 1.0 - c * 0.08, yaw);
      }
    }
  }
  // the sangars: a C of stone open at the back, waist-high (three courses), the gun over its lip
  for (const sg of d.sangars) {
    const rad = 1.9;
    for (let c = 0; c < 3; c++) {
      const n = 11 - c;
      for (let k = 0; k < n; k++) {
        // closed toward `face` (where the gun points), open at the back (men get in)
        const a = sg.face - Math.PI * 0.65 + ((k + (c % 2) * 0.5) / n) * Math.PI * 1.3;
        put(sg.x + Math.cos(a) * (rad - c * 0.05), c * 0.3 - 0.03, sg.z + Math.sin(a) * (rad - c * 0.05), 1.05 - c * 0.08, -a - Math.PI / 2);
      }
    }
  }
  // the fire's ring
  if (d.fire) for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2 + rnd() * 0.25;
    put(d.fire[0] + Math.cos(a) * 0.58, -0.02, d.fire[1] + Math.sin(a) * 0.58, 0.55);
  }
  // the flagpole's cairn: a heap, wider at the foot
  if (d.cairn) for (let k = 0; k < 9; k++) {
    const c = k < 6 ? 0 : 1, a = (k / (c ? 3 : 6)) * Math.PI * 2 + rnd();
    put(d.cairn[0] + Math.cos(a) * (c ? 0.22 : 0.45), c * 0.28 - 0.02, d.cairn[1] + Math.sin(a) * (c ? 0.22 : 0.45), 0.85);
  }
  const geo = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  geo.computeBoundingSphere();
  const rock = new THREE.Mesh(geo, sandstoneMaterial());
  rock.name = "CampSandstone";
  rock.castShadow = rock.receiveShadow = true;
  kit.userData.extra = [rock];
  kit.userData.navRects = [...(kit.userData.navRects ?? []), ...nav];
  kit.userData.coverLines = [...(kit.userData.coverLines ?? []), ...cover];
  return kit;
}
