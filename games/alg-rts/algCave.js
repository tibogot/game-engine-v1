// THE FLN CAVE IN SANDSTONE (2026-10-11, you: "we worked on nice realistic rocks — couldn't we use
// them to make the cave? it should look way better than the low-poly one"). In the BUILDINGS LAB
// first (grotte), the game's cave beside it.
//
// The game cave's shoring, breastwork and gear (rtsAlgeria buildCaveEntrance, rocks: false), and
// round them the sandstone generator's blocks (algSandstone.js — the CoH 3 rocks): the HILL behind
// (a long mesa slab), two JAMBS either side of the mouth, a LINTEL slab overhanging it, outcrops
// stepping down at the sides. One merged mesh, one draw, the rocks' own material (layered sides,
// cracked top, worn edges). The mouth looks down local −Z (the producer's way out: algUnits.js).
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { buildCaveEntrance } from "../../v3/render/objects/rtsAlgeria.js";
import { SANDSTONE_SHAPES, buildSandstoneRock, sandstoneMaterial, setSandstoneColour } from "./algSandstone.js";
import { getRockGeometry } from "../../v3/props/proceduralRock.js";

// The mouth (buildCaveEntrance's): width 3, height 2.4, the tunnel 2.6 deep toward +Z.
const MW = 3.0, MH = 2.4, TD = 2.6;
// The kit's scale (rtsAlgeria finish: every building ×1.3, the units' RTS scale): the rocks and the
// dark go by it too, the layout below is in the kit's metres.
const S = 1.3;
// The lookout's ring on the hill's top (kit metres: x, top y, z).
const LOOKOUT = [1.6, 5.0, TD + 3.2];

/**
 * The rocks, local metres: shape, seed, centre (x, z; y = its foot), scale (x, y, z), yaw, a lean.
 * The generator's sizes are big (a mesa 15.8 × 5.4 × 10.6 m): scaled down per piece.
 */
const LAYOUT = [
  // the HILL the cave runs into: its face just behind the tunnel's dark end
  { shape: "mesa", seed: 1, at: [0.4, -0.2, TD + 0.35 + 3.3], k: [0.86, 0.98, 0.62], yaw: 0.06 },
  // the JAMBS: their inner faces at the timber posts, the tunnel's rubble cheeks inside them
  // (set back: their fronts no further out than the mouth — from the RTS camera's 42° a jutting
  // jamb hid the opening)
  { shape: "block", seed: 1, at: [-(MW / 2 + 2.05), -0.15, 1.75], k: [0.44, 0.62, 0.5], yaw: 0.12, lean: 0.03 },
  { shape: "block", seed: 2, at: [MW / 2 + 1.95, -0.15, 1.85], k: [0.42, 0.58, 0.48], yaw: -0.16, lean: -0.03 },
  // the LINTEL: a slab across the mouth, its front just behind the first posts (an overhang hid
  // the mouth from above)
  { shape: "low", seed: 1, at: [0.15, MH + 0.02, 2.05], k: [0.56, 0.55, 0.44], yaw: 0.04, lean: 0.02 },
  // the OUTCROPS stepping down either side (the cave in a rock band, not a box on the plain)
  { shape: "low", seed: 2, at: [-(MW / 2 + 4.6), -0.1, 2.3], k: [0.38, 0.7, 0.42], yaw: 0.5 },
  { shape: "block", seed: 2, at: [MW / 2 + 4.7, -0.2, 2.8], k: [0.33, 0.5, 0.4], yaw: -0.6, lean: 0.04 },
];

// THE CAMP'S STONES (the wall, the fire's ring, the lookout's): small SANDSTONE stones from the same
// generator at a low detail (~250 triangles), the cave's own photo and colour — the kit's faceted
// field stones read as pale beads beside the rock. Four shapes, each placed many times.
const { label: _l, ...BLOCK } = SANDSTONE_SHAPES.block;
const PEBBLE = (seed) => ({
  ...BLOCK, seed, sizeX: 0.34, sizeY: 0.21, sizeZ: 0.27, chips: 14, bigCuts: 2, strata: 2, joints: 1, undercut: 0.06,
  detail: 24, targetTriangles: 240, simplifyError: 0.06,   // (the error lets it reach ~260: at 0.005 a pebble kept 2100)
});
/** A pebble placed (kit metres; the result in the scaled world, as the rocks). */
function pebble(m, q, e, rnd, x, y, z, k = 1, yaw = rnd() * 6.3) {
  const g = getRockGeometry(PEBBLE(1 + Math.floor(rnd() * 4))).clone();
  e.set((rnd() - 0.5) * 0.25, yaw, (rnd() - 0.5) * 0.25);
  const s = k * (0.8 + rnd() * 0.45);
  g.applyMatrix4(m.compose(new THREE.Vector3(x, y, z).multiplyScalar(S), q.setFromEuler(e), new THREE.Vector3(s * (0.9 + rnd() * 0.4), s, s).multiplyScalar(S)));
  return g;
}
function campStones(seed) {
  let st = seed * 9301 + 49297;
  const rnd = () => ((st = (st * 9301 + 49297) % 233280) / 233280);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), out = [];
  // The WALL: three courses along an arc across the front, the way in on the right; each course
  // set back a little (a batter), the joints staggered.
  const cx = -0.4, cz = -0.6, rad = 5.4, a0 = Math.PI * 1.02, a1 = Math.PI * 1.56;
  for (let c = 0; c < 3; c++) {
    const len = rad * (a1 - a0);
    for (let s = c % 2 ? 0.3 : 0; s < len; s += 0.56 + rnd() * 0.14) {
      const a = a0 + (s / len) * (a1 - a0), r = rad - c * 0.06;
      out.push(pebble(m, q, e, rnd, cx + Math.cos(a) * r, c * 0.27 - 0.03, cz + Math.sin(a) * r, 1.0 - c * 0.1, -a - Math.PI / 2));   // (long side along the wall)
    }
  }
  // The FIRE's ring (the logs and pot are the kit's), and the three stones under the pot.
  const fx = 2.6, fz = -2.9;
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2 + rnd() * 0.25;
    out.push(pebble(m, q, e, rnd, fx + Math.cos(a) * 0.5, -0.02, fz + Math.sin(a) * 0.5, 0.55));
  }
  for (let k = 0; k < 3; k++) out.push(pebble(m, q, e, rnd, fx + 0.95 + Math.cos(k * 2.1) * 0.17, -0.02, fz + 0.2 + Math.sin(k * 2.1) * 0.17, 0.5));
  // The LOOKOUT's ring on the rock's top: two courses, open toward the cave's back.
  const [ox, oy, oz] = LOOKOUT;
  for (let c = 0; c < 2; c++) {
    for (let k = 0; k < 9; k++) {
      const a = Math.PI * 0.9 + (k / 8) * Math.PI * 1.5;
      out.push(pebble(m, q, e, rnd, ox + Math.cos(a) * 0.95, oy + c * 0.26 - 0.05, oz + Math.sin(a) * 0.95, 0.85, -a - Math.PI / 2));
    }
  }
  return out;
}

let _void = null;
const voidMaterial = () => (_void ??= new THREE.MeshBasicNodeMaterial({ color: 0x0b0805, name: "CaveDark" }));

/** Variants (the lab's "Variante suivante"): the rocks' seeds move on, the layout stays. */
export function buildSandstoneCave({ seed = 1956, variant = 0, colour = "aures" } = {}) {
  const kit = buildCaveEntrance({ seed, rocks: false, camp: true, campStones: false });
  setSandstoneColour(colour);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const geos = LAYOUT.map((r) => {
    const g = buildSandstoneRock(r.shape, r.seed + variant * 2);
    e.set(0, r.yaw, r.lean ?? 0);
    g.applyMatrix4(m.compose(new THREE.Vector3(...r.at).multiplyScalar(S), q.setFromEuler(e), new THREE.Vector3(...r.k).multiplyScalar(S)));
    return g;
  });
  geos.push(...campStones(seed + variant));
  const geo = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  geo.computeBoundingSphere();
  const rock = new THREE.Mesh(geo, sandstoneMaterial());
  rock.name = "CaveSandstone";
  rock.castShadow = rock.receiveShadow = true;
  // THE DARK: the tunnel's end (the kit's plate there reads blue-grey) — near black, unlit.
  const dark = new THREE.Mesh(new THREE.PlaneGeometry((MW + 0.6) * S, (MH + 0.4) * S), voidMaterial());
  dark.position.set(0, (MH / 2) * S, (TD - 0.25) * S);   // well in front of the kit plate (never z-fight)
  dark.rotation.y = Math.PI;   // facing the mouth (−Z)
  dark.name = "CaveDark";
  kit.userData.extra = [rock, dark];
  return kit;
}
