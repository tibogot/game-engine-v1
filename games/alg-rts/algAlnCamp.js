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
import { addStoneHouse, newSite, siteGroup, stoneBlock } from "./algMasonry.js";
import { grainSack } from "../../v3/render/objects/rtsAlgeria.js";

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

// ── THE CAMP, NEW STANDARD (2026-10-11, you: "everything but the rocks reads cheap — make it way
// better, and very optimized") ───────────────────────────────────────────────────────────────────
// Every piece in the masonry standard (algMasonry.js): the stone house (the PC: a room and an annex,
// plaster patches, beams through the walls, a ladder, firewood), the DUGOUT (a low stone room half in
// the ground, an earth roof), the STORE (a reed lean-to on posts, burlap sacks, plank crates), the
// sangars' guns; the dry stone (sangars, forecourt walls, the fire's ring, the flag's cairn) and the
// rock behind in the sandstone (above). One mesh per surface for the whole camp + the rock's: ~9
// draws. The game reads its data as the kit camp's (geometry.userData: nav, cover, the house for a
// garrison, the flag's mount) — the geometry itself an empty carrier, the camp its `extra`.
export function buildCampV2({ seed = 1954, colour = "aures" } = {}) {
  const W = S;   // kit metres → world
  const site = newSite();
  // THE PC: the door inside the forecourt's gap (kit −7..−3 → world −9.1..−3.9).
  const house = addStoneHouse(site, { ox: -8.5, oz: 2.6, seed, doorX: 1.6, windows: [-3.4, 4.4] });
  // The wilaya's radio: a whip aerial off its roof.
  site.timber.push(new THREE.CylinderGeometry(0.035, 0.05, 6.5, 6).translate(-5.0, house.roofY + 3.25, 4.6));
  // THE DUGOUT: a low stone room, half its height in the ground, an earth roof; its door at the west.
  const dug = stoneBlock({ cx: 10.4, cz: -1.3, w: 7.8, d: 5.2, h: 0.95, t: 0.5, r: 0.6, seed: seed + 9, door: { x: -2.4, w: 0.85, h: 0.82 }, windows: [], spouts: [] });
  for (const k of Object.keys(site)) if (Array.isArray(dug[k])) site[k].push(...dug[k]);
  // THE STORE: a reed lean-to on four posts, sacks under it, ammunition crates.
  {
    const lx = -19.5, lz = -3.9;
    for (const [px, pz, ph] of [[-2.7, -1.9, 2.75], [2.7, -1.9, 2.75], [-2.7, 1.9, 2.05], [2.7, 1.9, 2.05]]) {
      site.timber.push(new THREE.CylinderGeometry(0.08, 0.1, ph, 7).translate(lx + px, ph / 2, lz + pz));
    }
    site.reed.push(new THREE.BoxGeometry(6.4, 0.16, 4.9).rotateX(Math.atan2(0.7, 3.8)).translate(lx, 2.46, lz));
    for (let k = 0; k < 9; k++) {
      const row = k < 5 ? 0 : 1, i = row ? k - 5 : k;
      site.hessian.push(grainSack(0.95, 0.5, 0.62, seed + k).rotateY((hash01(k, seed) - 0.5) * 0.4).translate(lx - 2.0 + i * 0.98 + row * 0.45, row * 0.42, lz + 0.9));
    }
    for (let k = 0; k < 3; k++) site.planks.push(new THREE.BoxGeometry(1.15, 0.5, 0.62).rotateY((hash01(k + 20, seed) - 0.5) * 0.25).translate(lx - 1.2 + k * 1.25, 0.25 + (k === 1 ? 0.5 : 0), lz - 1.0));
  }
  // THE COOKING FIRE: logs across the ring (the ring's stones below), a pot on three stones.
  {
    const fx = -3 * W, fz = -4 * W;
    for (let k = 0; k < 3; k++) {
      const a = k * 1.05;
      site.timber.push(new THREE.CylinderGeometry(0.06, 0.07, 0.95, 6).rotateZ(Math.PI / 2 - 0.15).rotateY(a).translate(fx, 0.1, fz));
    }
    site.metal.push(new THREE.CylinderGeometry(0.3, 0.24, 0.36, 12).translate(fx + 0.95, 0.45, fz + 0.2));
  }
  // THE SANGARS' GUNS: a light machine gun on its bipod over each ring's front lip.
  for (const sg of SANGARS) {
    const gx = (sg.x + Math.cos(sg.face) * 1.45) * W, gz = (sg.z + Math.sin(sg.face) * 1.45) * W, yaw = -sg.face + Math.PI / 2;
    site.metal.push(new THREE.CylinderGeometry(0.035, 0.04, 1.3, 6).rotateX(Math.PI / 2).translate(0, 0, 0.3).rotateY(yaw).translate(gx, 1.12, gz));
    site.timber.push(new THREE.BoxGeometry(0.1, 0.14, 0.55).translate(0, 0, -0.45).rotateY(yaw).translate(gx, 1.08, gz));
  }
  const { group } = siteGroup(site, "FlnCamp");

  // THE ROCK AND THE DRY STONE (the sandstone: one more mesh).
  setSandstoneColour(colour);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), rnd = rngFrom(seed);
  const geos = [], nav = [], cover = [];
  const rect = (cx, cz, hx, hz, vehicleOnly = false) => nav.push({ cx, cz, hx, hz, vehicleOnly });
  const box = (cx, cz, hx, hz) => cover.push({ hard: true, pts: [[cx - hx, cz - hz], [cx + hx, cz - hz], [cx + hx, cz + hz], [cx - hx, cz + hz], [cx - hx, cz - hz]] });
  for (const r of ROCKS) {
    const g = getRockGeometry(sandstoneParams(r.shape, r.seed)).clone();
    e.set(0, r.yaw, r.lean ?? 0);
    g.applyMatrix4(m.compose(new THREE.Vector3(...r.at).multiplyScalar(S), q.setFromEuler(e), new THREE.Vector3(...r.k).multiplyScalar(S)));
    geos.push(g);
    g.computeBoundingBox();
    const b = g.boundingBox, cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2, hx = (b.max.x - b.min.x) * 0.4, hz = (b.max.z - b.min.z) * 0.4;
    rect(cx, cz, hx, hz); box(cx, cz, hx, hz);
  }
  const put = (x, y, z, k, yaw) => geos.push(pebble(m, q, e, rnd, x, y, z, k, yaw));
  for (const [a, b] of WALLS) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), yaw = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
    for (let c = 0; c < 3; c++) for (let s = c % 2 ? 0.28 : 0; s <= len; s += 0.56 + rnd() * 0.12) {
      const f = s / len;
      put(a[0] + (b[0] - a[0]) * f, c * 0.27 - 0.03, a[1] + (b[1] - a[1]) * f, 1.0 - c * 0.08, yaw);
    }
    rect(((a[0] + b[0]) / 2) * W, ((a[1] + b[1]) / 2) * W, (Math.abs(b[0] - a[0]) / 2 + 0.9) * W, (Math.abs(b[1] - a[1]) / 2 + 0.9) * W, true);
    cover.push({ hard: true, pts: [[a[0] * W, a[1] * W], [b[0] * W, b[1] * W]] });
  }
  for (const sg of SANGARS) {
    for (let c = 0; c < 3; c++) {
      const n = 11 - c;
      for (let k = 0; k < n; k++) {
        const a = sg.face - Math.PI * 0.65 + ((k + (c % 2) * 0.5) / n) * Math.PI * 1.3;
        put(sg.x + Math.cos(a) * (1.9 - c * 0.05), c * 0.3 - 0.03, sg.z + Math.sin(a) * (1.9 - c * 0.05), 1.05 - c * 0.08, -a - Math.PI / 2);
      }
    }
    rect(sg.x * W, sg.z * W, 2.6 * W, 2.6 * W, true);
    cover.push({ hard: true, pts: Array.from({ length: 8 }, (_, k) => { const a = sg.face - Math.PI * 0.65 + (k / 7) * Math.PI * 1.3; return [(sg.x + Math.cos(a) * 1.9) * W, (sg.z + Math.sin(a) * 1.9) * W]; }) });
  }
  for (let k = 0; k < 9; k++) { const a = (k / 9) * Math.PI * 2 + rnd() * 0.25; put(-3 + Math.cos(a) * 0.58, -0.02, -4 + Math.sin(a) * 0.58, 0.55); }
  for (let k = 0; k < 3; k++) put(-3 + 0.73 + Math.cos(k * 2.1) * 0.15, -0.02, -4 + 0.15 + Math.sin(k * 2.1) * 0.15, 0.45);
  for (let k = 0; k < 9; k++) { const c = k < 6 ? 0 : 1, a = (k / (c ? 3 : 6)) * Math.PI * 2 + rnd(); put(-9 + Math.cos(a) * (c ? 0.22 : 0.45), c * 0.28 - 0.02, -3.5 + Math.sin(a) * (c ? 0.22 : 0.45), 0.85); }
  const rockGeo = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  rockGeo.computeBoundingSphere();
  const rock = new THREE.Mesh(rockGeo, sandstoneMaterial());
  rock.name = "FlnCamp:sandstone";
  rock.castShadow = rock.receiveShadow = true;
  // THE BUILDINGS' blocks and cover.
  const blocks = [[house.main.x, house.main.z, house.main.w / 2 + 0.5, house.main.d / 2 + 0.5], [house.annex.x, house.annex.z, house.annex.w / 2 + 0.4, house.annex.d / 2 + 0.4], [10.4, -1.3, 4.3, 3.0], [-19.5, -3.9, 3.2, 2.4]];
  for (const [cx, cz, hx, hz] of blocks) { rect(cx, cz, hx, hz); box(cx, cz, hx - 0.4, hz - 0.4); }
  // THE CARRIER: an empty geometry with the camp's data; the camp its `extra`.
  const carrier = new THREE.BufferGeometry();
  carrier.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  carrier.setIndex([0, 1, 2]);
  Object.assign(carrier.userData, {
    footprint: { cx: 0, cz: 0, hx: 22 * S, hz: 20 * S }, height: 8 * S,
    flagMount: { pos: [-9 * S, 0.5 * S, -3.5 * S], poleHeight: 7 * S },
    navRects: nav, coverLines: cover, coverPerimeter: false,
    houses: [{ x: house.main.x, z: house.main.z, w: house.main.w, d: house.main.d, yaw: 0, door: house.door }],
    campfire: [-3 * W, 0, -4 * W],   // its cooking fire (algGame lights it; algNightLamps' campfire)
    extra: [group, rock], labMaterial: new THREE.MeshBasicMaterial({ visible: false }),
  });
  return carrier;
}
// The kit camp's sangars and forecourt walls (kit metres), the new layout keeps them.
const SANGARS = [{ x: -17, z: -11, face: -Math.PI / 2 - 0.5 }, { x: 4, z: -12, face: -Math.PI / 2 }, { x: 19, z: -6, face: -Math.PI / 2 + 0.6 }];
const WALLS = [[[-11, -6.5], [-7, -6.5]], [[-3, -6.5], [1, -6.5]], [[-11, -6.5], [-11, -1.5]], [[1, -6.5], [1, -1.5]]];
function hash01(i, seed) { let h = Math.imul(i + 1, 374761393) ^ Math.imul(seed, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
