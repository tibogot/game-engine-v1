// Placed plants (v3/tools/placedPlants.js): the brush planner for imported GLB
// plants — density, spacing, slope limit, lean, sinking, map edge, erase.
import * as THREE from "three";
import {
  PLACED_PLANT_DEFAULTS, SpacingGrid, planPlacedPlants, removePlantsInRadius, groundNormal,
} from "../v3/tools/placedPlants.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};
// Deterministic random.
const rng = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const flat = () => 10;
const W = 2048;

// ── Density and spacing ──
{
  const grid = new SpacingGrid(2);
  const s = { ...PLACED_PLANT_DEFAULTS, density: 12, minSpacing: 1.5 };
  const out = planPlacedPlants({ wx: 0, wz: 0, radius: 10, settings: s, typeIdx: 3, typeHeight: 2, getHeight: flat, grid, worldSize: W, rand: rng(7) });
  const expected = Math.ceil(Math.PI * 100 / 100 * 12);
  check("a stamp tries density × area and places most of them", out.length > expected * 0.6 && out.length <= expected, `${out.length} of ${expected}`);
  let minD = Infinity;
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    minD = Math.min(minD, Math.hypot(out[i].px - out[j].px, out[i].pz - out[j].pz));
  }
  check("no two plants closer than the spacing", minD >= 1.5, minD.toFixed(2));
  check("every plant inside the brush", out.every((p) => Math.hypot(p.px, p.pz) <= 10));
  check("records carry the type", out.every((p) => p.typeIdx === 3));
  const again = planPlacedPlants({ wx: 0, wz: 0, radius: 10, settings: s, typeIdx: 3, typeHeight: 2, getHeight: flat, grid, worldSize: W, rand: rng(9) });
  const all = [...out, ...again];
  let minAll = Infinity;
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    minAll = Math.min(minAll, Math.hypot(all[i].px - all[j].px, all[i].pz - all[j].pz));
  }
  check("a second stamp on the same spot respects the first (the grid remembers)", minAll >= 1.5, minAll.toFixed(2));
  const half = planPlacedPlants({ wx: 50, wz: 0, radius: 10, strength: 0.5, settings: s, typeIdx: 3, getHeight: flat, grid: new SpacingGrid(2), worldSize: W, rand: rng(7) });
  check("half strength places about half", half.length < out.length && half.length > out.length * 0.3, `${half.length} vs ${out.length}`);
}

// ── Scale, sinking, upright on flat ground ──
{
  const s = { ...PLACED_PLANT_DEFAULTS, scaleMin: 0.5, scaleMax: 2, sink: 0.1 };
  const out = planPlacedPlants({ wx: 0, wz: 0, radius: 8, settings: s, typeIdx: 0, typeHeight: 3, getHeight: flat, grid: new SpacingGrid(2), worldSize: W, rand: rng(3) });
  check("scale within the range, uniform", out.every((p) => p.sx >= 0.5 && p.sx <= 2 && p.sx === p.sy && p.sy === p.sz));
  check("sunk by sink × height × scale", out.every((p) => Math.abs(p.py - (10 - 0.1 * 3 * p.sx)) < 1e-9));
  // (A yaw past 90° decomposes to rx = rz = 180° in XYZ order — same rotation,
  // so check where the plant's up points, not the angles.)
  const upOf0 = (p) => new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(p.rx * Math.PI / 180, p.ry * Math.PI / 180, p.rz * Math.PI / 180, "XYZ"));
  check("upright on flat ground (only yaw)", out.every((p) => upOf0(p).y > 1 - 1e-9));
  const yaws = new Set(out.map((p) => Math.round(p.ry / 30)));
  check("yaw varies", yaws.size >= 4, `${yaws.size} buckets`);
}

// ── Slope: limit and lean ──
{
  // 30° slope rising toward +x.
  const slope30 = (x) => Math.tan(30 * Math.PI / 180) * x;
  const n = groundNormal((x) => slope30(x), 0, 0);
  check("ground normal of a 30° slope", Math.abs(Math.acos(n.y) * 180 / Math.PI - 30) < 0.01);
  const blocked = planPlacedPlants({ wx: 0, wz: 0, radius: 8, settings: { maxSlope: 25 }, typeIdx: 0, getHeight: (x) => slope30(x), grid: new SpacingGrid(2), worldSize: W, rand: rng(5) });
  check("steeper than max slope grows nothing", blocked.length === 0, `${blocked.length}`);
  const leaning = planPlacedPlants({ wx: 0, wz: 0, radius: 8, settings: { maxSlope: 40, alignToNormal: 1 }, typeIdx: 0, getHeight: (x) => slope30(x), grid: new SpacingGrid(2), worldSize: W, rand: rng(5) });
  const upOf = (p) => new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(p.rx * Math.PI / 180, p.ry * Math.PI / 180, p.rz * Math.PI / 180, "XYZ"));
  check("align 1: the plant's up IS the ground normal, whatever its yaw",
    leaning.length > 0 && leaning.every((p) => upOf(p).angleTo(n) < 1e-4), `${leaning.length} plants`);
  const half = planPlacedPlants({ wx: 0, wz: 0, radius: 8, settings: { maxSlope: 40, alignToNormal: 0.5 }, typeIdx: 0, getHeight: (x) => slope30(x), grid: new SpacingGrid(2), worldSize: W, rand: rng(5) });
  const tilt = half.map((p) => upOf(p).angleTo(new THREE.Vector3(0, 1, 0)) * 180 / Math.PI);
  check("align 0.5 leans part way (between 0° and 30°)", tilt.every((t) => t > 5 && t < 25), `${Math.min(...tilt).toFixed(1)}-${Math.max(...tilt).toFixed(1)}°`);
}

// ── Map edge ──
{
  const out = planPlacedPlants({ wx: W / 2, wz: 0, radius: 20, settings: {}, typeIdx: 0, getHeight: flat, grid: new SpacingGrid(2), worldSize: W, rand: rng(11) });
  check("nothing off the map", out.length > 0 && out.every((p) => p.px <= W / 2));
}

// ── Erase ──
{
  const inst = [
    { typeIdx: 1, px: 0, pz: 0 }, { typeIdx: 2, px: 1, pz: 0 }, { typeIdx: 1, px: 30, pz: 0 }, { typeIdx: 5, px: 0.5, pz: 0.5 },
  ];
  const plants = new Set([1, 2]);
  const n = removePlantsInRadius(inst, 0, 0, 5, (t) => plants.has(t));
  check("erase removes plants in the disc only", n === 2 && inst.length === 2);
  check("a non-plant prop (a rock) under the brush stays", inst.some((p) => p.typeIdx === 5));
  check("a plant outside the disc stays", inst.some((p) => p.px === 30));
  const only = [{ typeIdx: 1, px: 0, pz: 0 }, { typeIdx: 2, px: 1, pz: 0 }];
  removePlantsInRadius(only, 0, 0, 5, (t) => t === 2);
  check("erase-selected-only keeps the other plant", only.length === 1 && only[0].typeIdx === 1);
}

console.log(fail === 0 ? "\nall passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
