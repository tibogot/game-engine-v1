// ============================================================================
// A HEIGHTFIELD NORMAL BESIDE A HOLE
//
// `getTerrainHeight` returns NaN for "there is no ground here", and it means
// it: outside the city, with terrain off, and over the underpass, where the
// street has an actual hole cut in it.
//
// The normal is a central difference over four neighbours, and one NaN
// neighbour makes the whole vector NaN. That normal goes to a wheel, the wheel
// makes a NaN force, and one frame later the pose is non-finite and the game
// respawns the car — with the console line
//
//     [roadGame] vehicle pose went non-finite — respawning
//
// The cruel part is WHERE it fires. The centre sample is finite: the car is on
// solid street. It is a neighbour `eps` away that is not. So the trigger is a
// ring 0.6 m wide around a hole the player never reaches, and the underpass was
// unenterable rather than merely dangerous.
// ============================================================================
import { register } from "node:module";

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { createVehicleGround } = await import("../v3/play/modularRoadGround.js");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${extra ? `  — ${extra}` : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  — ${extra}` : ""}`); }
};

/** A flat street at y = 0 with a hole in it, exactly like the underpass cuts. */
const HOLE = { minX: -9, maxX: 9, minZ: -50, maxZ: 50 };
const getTerrainHeight = (x, z) => {
  if (x >= HOLE.minX && x <= HOLE.maxX && z >= HOLE.minZ && z <= HOLE.maxZ) return NaN;
  if (Math.abs(x) > 400 || Math.abs(z) > 400) return NaN;   // and the world ends
  return 0;
};

// The adapter exposes two CHANNELS — `ground` is the drive surface the wheels
// probe, `solids` is what the chassis is blocked by. The heightfield lives in
// the first, which is the one the wheels take their normal from.
const adapter = createVehicleGround({ getTerrainHeight });
const ground = adapter.ground;
check("a ground channel was built", !!ground && typeof ground.raycastFirst === "function",
  ground ? Object.keys(ground).join(", ") : "none");

const finite = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/*
 * THE RING AROUND THE HOLE. Every one of these is on ground the car can stand
 * on — the height under each is exactly 0 — but each is within a neighbour's
 * reach of the hole. Before the fix every single one produced a NaN normal.
 */
{
  let bad = 0, tested = 0, worst = null;
  for (let d = 0.05; d <= 0.6; d += 0.05) {
    for (const [x, z] of [
      [HOLE.minX - d, 0], [HOLE.maxX + d, 0],
      [0, HOLE.minZ - d], [0, HOLE.maxZ + d],
      [HOLE.minX - d, HOLE.minZ - d], [HOLE.maxX + d, HOLE.maxZ + d],
    ]) {
      const h = ground.raycastFirst({ x, y: 0.5, z }, { x: 0, y: -1, z: 0 }, 5);
      tested++;
      if (!h) continue;                       // no ground is a legitimate answer
      if (!finite(h.normal) || !Number.isFinite(h.distance)) {
        bad++;
        if (!worst) worst = `(${x.toFixed(2)}, ${z.toFixed(2)})`;
      }
    }
  }
  check("no NaN normal anywhere on the lip of the hole", bad === 0,
    `${bad} of ${tested} probes NaN${worst ? `, first at ${worst}` : ""}`);
}

// Beside the hole the ground is flat, so the normal must be straight up — not
// merely finite. A fallback that invented a slope at the lip would tip the car
// into the hole it was trying to keep it out of.
{
  const h = ground.raycastFirst({ x: HOLE.minX - 0.2, y: 0.5, z: 0 }, { x: 0, y: -1, z: 0 }, 5);
  check("and the lip reads as flat, not as a slope",
    !!h && finite(h.normal) && h.normal.y > 0.999,
    h ? `normal y ${h.normal.y.toFixed(4)}` : "no hit");
}

// The same failure exists at the edge of the world, where it has always been
// possible and simply never mattered — the car was leaving anyway.
{
  const h = ground.raycastFirst({ x: 399.8, y: 0.5, z: 0 }, { x: 0, y: -1, z: 0 }, 5);
  check("nor at the edge of the ground plane",
    !h || (finite(h.normal) && Number.isFinite(h.distance)),
    h ? `normal (${h.normal.x.toFixed(2)}, ${h.normal.y.toFixed(2)}, ${h.normal.z.toFixed(2)})` : "no ground, fine");
}

// And inside the hole there is genuinely nothing, which must stay true: the
// underpass road is a BVH mesh, and the heightfield claiming a surface there
// would put a phantom floor across the top of the trench.
{
  const h = ground.raycastFirst({ x: 0, y: 0.5, z: 0 }, { x: 0, y: -1, z: 0 }, 5);
  check("there is still no heightfield inside the hole", !h,
    h ? `unexpected hit at y ${h.point.y}` : "none, as intended");
}

void THREE;
console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILURE(S)`}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
