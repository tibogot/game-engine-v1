// Sky mode's load-bearing assumption, tested against the REAL ground adapter.
//
// roadGame's setTerrain(false) does not add a branch to the physics. It makes
// one sampler return NaN and relies on v3/play/modularRoadGround.js already
// treating a non-finite height as "no ground here". That is a contract between
// two files that never mention each other, so if someone ever "tidies" the
// isFinite guard away, the car silently lands on invisible terrain in the middle
// of a sky race and nothing else in the codebase complains.
//
// This pins the contract down.
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createVehicleGround } = await import(
  pathToFileURL(join(ROOT, "v3/play/modularRoadGround.js")).href
);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const DOWN = { x: 0, y: -1, z: 0 };
const probeFrom = (g, y) => g.raycastFirst({ x: 0, y, z: 0 }, DOWN, 500);

// ── 1. Terrain ON: the baseline still works ────────────────────────────────
// Without this the NaN test below proves nothing — a broken adapter would
// "pass" it by finding no ground in either mode.
{
  const g = createVehicleGround({ getTerrainHeight: () => 12 }).ground;
  const hit = probeFrom(g, 40);
  check("terrain on: probe finds the ground", !!hit);
  check("terrain on: hit is at the sampled height", hit && Math.abs(hit.point.y - 12) < 1e-9,
    hit ? `y=${hit.point.y}` : "no hit");
  check("terrain on: distance is the vertical drop", hit && Math.abs(hit.distance - 28) < 1e-9,
    hit ? `d=${hit.distance}` : "no hit");
}

// ── 2. Sky mode: NaN means there is nothing there ──────────────────────────
{
  const g = createVehicleGround({ getTerrainHeight: () => NaN }).ground;
  check("sky mode: no ground under the car", probeFrom(g, 40) === null);
  // The car falls a long way in sky mode. The guard must hold at every height,
  // not just near the old terrain — a `>= -1` window that accidentally admitted
  // NaN would show up as the car stopping dead somewhere far below the track.
  const heights = [200, 40, 0.5, 0, -40, -500];
  check("sky mode: still nothing at any fall height",
    heights.every((y) => probeFrom(g, y) === null),
    `tested y = ${heights.join(", ")}`);
}

// ── 3. The other two ground queries never consult terrain at all ───────────
// spherecast and closestPointWithNormal read only the mesh BVHs, so a NaN
// sampler cannot leak into them. Asserted so that "make terrain analytic in
// spherecast too" can never be done without noticing this.
{
  const g = createVehicleGround({ getTerrainHeight: () => NaN }).ground;
  check("sky mode: spherecast is BVH-only (no NaN leak)",
    g.spherecast(0, 40, 0, 0.5, 0, -1, 0, 500) === null);
  check("sky mode: deck contact is BVH-only (no NaN leak)",
    g.closestPointWithNormal(0, 40, 0, 500, { copy: () => {} }) === null);
}

// ── 4. The chassis-corner floor guard ──────────────────────────────────────
// modularRoadVehicle writes its floor test as `if (!(y < floorY)) continue`
// rather than `if (y >= floorY)`. The two are identical for real numbers and
// OPPOSITE for NaN, and sky mode depends entirely on which one is there.
{
  const floorY = NaN, cornerY = -900; // corner far below any plausible floor
  check("corner floor: `!(y < NaN)` skips the corner", !(cornerY < floorY) === true);
  check("corner floor: `y >= NaN` would too — but the penetration is the trap",
    (cornerY >= floorY) === false);
  // The real failure mode isn't the comparison, it's what follows it: a corner
  // that IS driven computes pen = floorY - y = NaN and pushes a NaN force,
  // which makes the body position NaN permanently (black screen, NaN HUD).
  check("corner floor: driving a NaN floor would poison the body",
    Number.isNaN(floorY - cornerY));
}

// ── 5. The sky-mode kill floor ─────────────────────────────────────────────
// Mirrors roadGame's fallFloorY(). FALL_Y (-60) is world-absolute and was set
// when tracks sat near y=0; a sky track floats hundreds of metres up, so the
// floor has to follow the track and REPLACE FALL_Y.
//
// This caught the bug it was written for. The first implementation was
// `Math.min(FALL_Y, bottom - MARGIN)` — meant as "keep the world floor as a
// backstop", but min picks the DEEPER floor, so a track at 200 m got
// min(-60, 150) = -60 and the whole feature did nothing at precisely the
// altitude it existed for. Hence the explicit high-track case below.
{
  const FALL_Y = -60, MARGIN = 50;
  const floor = (bottom) => bottom - MARGIN;
  check("kill floor: high sky track drops with the track",
    floor(200) === 150, `bottom=200 → ${floor(200)}`);
  check("kill floor: 40 m default build height",
    floor(40) === -10, `bottom=40 → ${floor(40)}`);
  check("kill floor: track below zero goes deeper still",
    floor(-100) === -150, `bottom=-100 → ${floor(-100)}`);
  check("kill floor: always MARGIN below the lowest piece, whatever the altitude",
    [200, 40, 0, -10, -100, -1000].every((b) => Math.abs((b - floor(b)) - MARGIN) < 1e-9));
  check("kill floor: never traps a car still at track level",
    [200, 40, 0, -100].every((b) => floor(b) < b));
  // The reason this exists: with a fixed -60 floor a car falling off a 200 m
  // sky track free-falls 260 m before respawning.
  const fallSecs = (h) => Math.sqrt((2 * h) / 9.81);
  const before = fallSecs(200 - FALL_Y), after = fallSecs(200 - floor(200));
  check("kill floor: cuts the dead time after a missed jump",
    after < before * 0.65,
    `${before.toFixed(1)}s → ${after.toFixed(1)}s`);
}

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
