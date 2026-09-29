// LINE OF SIGHT — what stands between a shooter and his target: the GROUND
// (a ridge, a crest, the far bank of a wadi) and TALL buildings (houses, the
// post's walls and towers, the minaret). Combat asks it before a shot and
// when it picks a target (shared combat.js `blocksSight`).
//
// Low things are NOT here, on purpose: a garden wall, a terrace, sandbags, a
// threshing floor's kerb are chest high — you see and shoot over them, and
// they are COVER (algCover.js), which is the other half of the rule. Trees
// and scrub are CONCEALMENT, not sight blockers. So the three read apart:
//   · a house or a ridge between you: no shot at all (move to get one);
//   · a wall in front of him: you can shoot, he takes less (cover);
//   · scrub round him: you have to be closer to pick him up (concealment).
//
// BUILDINGS are baked once at load: every placed piece gets a BVH, and a
// vertical ray every 2 m over its footprint finds its top; cells where that
// top stands more than 2 m above the ground are blockers, at that height.
// The GROUND is the heightmap, sampled every 2 m along the line.
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

const CELL = 2;          // m, the building grid and the line's step
const TALL = 2.0;        // m above the ground: shorter is cover, not a wall to sight
const EYE = { foot: 1.6, vehicle: 2.2 };
const CHEST = { foot: 1.0, vehicle: 1.4, structure: 2.5 };

export function createAlgSight(app, { showroom = {}, worldSize = 1024 } = {}) {
  const t0 = performance.now();
  const n = Math.round(worldSize / CELL), half = worldSize / 2;
  /** Top of a tall obstacle per cell (world y), or -Infinity. */
  const tops = new Float32Array(n * n).fill(-Infinity);
  const toCell = (v) => Math.max(0, Math.min(n - 1, Math.floor((v + half) / CELL)));
  const H = app.getWorldHeight;

  // ── Bake the buildings ────────────────────────────────────────────────────
  const ray = new THREE.Ray(), inv = new THREE.Matrix4(), hitW = new THREE.Vector3();
  let pieces = 0, cells = 0;
  for (const mesh of Object.values(showroom)) {
    const geo = mesh?.isMesh ? mesh.geometry : null;
    const fp = geo?.userData?.footprint;
    if (!fp || geo.userData.gear || geo.userData.rotors) continue;   // vehicles become units
    if ((geo.userData.height ?? 99) < TALL) continue;                 // nothing tall in it
    const bvh = new MeshBVH(geo);
    mesh.updateMatrixWorld(true);
    inv.copy(mesh.matrixWorld).invert();
    const c = Math.cos(mesh.rotation.y), s = Math.sin(mesh.rotation.y);
    for (let lx = -fp.hx; lx <= fp.hx; lx += CELL) {
      for (let lz = -fp.hz; lz <= fp.hz; lz += CELL) {
        const x0 = fp.cx + lx, z0 = fp.cz + lz;
        const wx = mesh.position.x + x0 * c + z0 * s, wz = mesh.position.z - x0 * s + z0 * c;
        // Straight down from high above, in the piece's own frame.
        ray.origin.set(wx, mesh.position.y + 200, wz).applyMatrix4(inv);
        ray.direction.set(0, -1, 0).transformDirection(inv);
        const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
        if (!hit) continue;
        hitW.copy(hit.point).applyMatrix4(mesh.matrixWorld);
        if (hitW.y - H(wx, wz) < TALL) continue;
        const i = toCell(wz) * n + toCell(wx);
        if (hitW.y > tops[i]) { tops[i] = hitW.y; cells++; }
      }
    }
    pieces++;
  }
  const bakeMs = performance.now() - t0;

  const eyeOf = (e) => (e.isStructure ? CHEST.structure + 2 : e.type?.foot ? EYE.foot : EYE.vehicle);
  const chestOf = (e) => (e.isStructure ? CHEST.structure : e.type?.foot ? CHEST.foot : CHEST.vehicle);

  /**
   * What blocks the line from a to b: "ground", "building", or null (clear).
   * The ends are skipped over each one's own footprint (a structure's walls
   * do not hide its own towers' targets) and the last 2 m (the bank a man
   * lies behind is COVER, algCover.js, not a wall to sight).
   */
  function blocker(a, b) {
    if (a.isAir || b.isAir) return null;
    const ax = a.position.x, az = a.position.z, bx = b.position.x, bz = b.position.z;
    const d = Math.hypot(bx - ax, bz - az);
    if (d < 6) return null;
    const ya = H(ax, az) + eyeOf(a), yb = H(bx, bz) + chestOf(b);
    const s0 = Math.max(2, a.isStructure ? (a.radius ?? 0) * 0.7 : 0);
    const s1 = d - Math.max(2, b.isStructure ? (b.radius ?? 0) * 0.7 : 0);
    for (let s = s0; s <= s1; s += CELL) {
      const t = s / d, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const line = ya + (yb - ya) * t;
      if (H(x, z) > line) return "ground";
      if (tops[toCell(z) * n + toCell(x)] > line) return "building";
    }
    return null;
  }

  return {
    blocker,
    /** combat.js: true when the line from a to b is blocked. */
    blocksSight: (a, b) => blocker(a, b) !== null,
    stats: { pieces, cells, bakeMs: Math.round(bakeMs) },
  };
}
