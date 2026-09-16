// Waterfall path solver (v3/render/waterfall/waterfallPath.js): free fall,
// landing in water, clinging to a slope, cascading off a ledge, flow thinning.
import { solveFall, downhillYaw, GRAVITY } from "../v3/render/waterfall/waterfallPath.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};
const near = (a, b, eps) => Math.abs(a - b) < eps;
const flatN = { nx: 0, ny: 1, nz: 0 };

// A 50 m cliff: ground 50 for z < 0, 0 beyond.
const cliff = (x, yFrom, z) => ({ y: z < 0 ? 50 : 0, ...flatN });
const lip = { px: 0, py: 50, pz: -0.02, yaw: 0, width: 6, speed: 3, depth: 0.5, spread: 0 };

{
  const s = solveFall(lip, { sampleGround: cliff });
  const tFall = Math.sqrt((2 * 50) / GRAVITY);
  check("free fall lands where the ballistic arc says", near(s.impact.z, -0.02 + 3 * tFall, 0.6), `z ${s.impact.z.toFixed(2)} vs ${(-0.02 + 3 * tFall).toFixed(2)}`);
  check("…after the ballistic fall time", near(s.impact.time, tFall, 0.15), `t ${s.impact.time.toFixed(2)} vs ${tFall.toFixed(2)}`);
  check("…on the ground, not water", !s.impact.onWater && near(s.impact.y, 0, 0.3));
  check("the grid has columns across and rows down", s.cols >= 3 && s.rows >= 6 && s.position.length === s.cols * s.rows * 3);
  let monotone = true, thinning = true;
  for (let j = 0; j < s.cols; j++) {
    for (let i = 1; i < s.rows; i++) {
      const v = j * s.rows + i;
      if (s.time[v] < s.time[v - 1] - 1e-5) monotone = false;
      if (s.speed[v] > s.speed[v - 1] + 0.05 && s.thickness[v] > s.thickness[v - 1] + 1e-4) thinning = false;
    }
  }
  check("flight time increases down every column", monotone);
  check("the sheet thins as it speeds up", thinning);
  const top = s.thickness[0], bottom = s.thickness[s.rows - 1];
  check("…by the speed ratio (discharge conserved)", near(bottom / top, s.speed[0] / s.speed[s.rows - 1], 0.05), `${(bottom / top).toFixed(3)}`);
  check("the drop is the cliff height", near(s.drop, 50, 0.5));
}

{
  const water = (x, z) => (z > 0 ? 10 : -Infinity);
  const s = solveFall(lip, { sampleGround: cliff, sampleWater: water });
  const t = Math.sqrt((2 * 40) / GRAVITY);
  check("a fall into a lake ends ON the water surface", s.impact.onWater && near(s.impact.y, 10, 1e-3), `y ${s.impact.y}`);
  check("…at the arc's crossing", near(s.impact.z, -0.02 + 3 * t, 0.6));
}

{
  // Half the sheet reaches a lake, half stops on the bank above it: the landing
  // must be ON the water, not averaged into the air between the two.
  const bank = (x, yFrom, z) => ({ y: z < 0 ? 50 : x < 0 ? 0 : 20, ...flatN });
  const s = solveFall({ ...lip, width: 20 }, { sampleGround: bank, sampleWater: (x) => (x < 0 ? 10 : -Infinity) });
  check("a split landing sits where most of the water goes", s.impact.onWater && near(s.impact.y, 10, 0.5), `y ${s.impact.y.toFixed(2)}`);
}

{
  // The crest: flat water carried upstream of the lip, at the lip's level.
  const s = solveFall({ ...lip, crest: 4 }, { sampleGround: cliff });
  let crestVerts = 0, offLevel = 0, belowCrest = 0;
  for (let v = 0; v < s.count; v++) {
    if (s.crest[v] > 0.01) {
      crestVerts++;
      if (Math.abs(s.position[v * 3 + 1] - lip.py) > 1e-3) offLevel++;
      if (s.position[v * 3 + 2] > lip.pz + 1e-3) belowCrest++;
      if (s.time[v] > 1e-6) offLevel++;
    }
  }
  check("the crest carries flat water upstream of the lip", crestVerts > 0, `${crestVerts} vertices`);
  check("…level with the lip, and upstream of it, at no flight time", offLevel === 0 && belowCrest === 0);
  const back = Math.min(...Array.from({ length: s.cols }, (_, j) => s.position[(j * s.rows) * 3 + 2]));
  check("…reaching the full crest length back", near(back, lip.pz - 4, 0.3), `z ${back.toFixed(2)}`);
  check("…without moving where the water lands", near(s.impact.z, solveFall({ ...lip, crest: 0 }, { sampleGround: cliff }).impact.z, 0.3));
}

{
  // A lake rectangle whose level is BELOW the ground where the water lands: dry land.
  const water = () => -5;
  const s = solveFall(lip, { sampleGround: cliff, sampleWater: water });
  check("a lake level under the ground is not water", !s.impact.onWater && near(s.impact.y, 0, 0.3));
}

{
  // The lip sits IN its river: water at the lip must not end the fall at once.
  const s = solveFall(lip, { sampleGround: cliff, sampleWater: () => 50 });
  check("the river the lip sits in does not end the fall", s.drop > 45);
}

{
  // A 45° slope from the lip down to z = 50: the water slides down it.
  const slope = (x, yFrom, z) => {
    if (z < 0) return { y: 50, ...flatN };
    if (z < 50) return { y: 50 - z, nx: 0, ny: Math.SQRT1_2, nz: Math.SQRT1_2 };
    return { y: 0, ...flatN };
  };
  const s = solveFall({ ...lip, speed: 0.5 }, { sampleGround: slope });
  let clings = 0, under = 0;
  for (let v = 0; v < s.count; v++) {
    if (s.contact[v] > 0.5) clings++;
    const z = s.position[v * 3 + 2], y = s.position[v * 3 + 1];
    if (y < slope(0, 0, z).y - 0.05) under++;
  }
  check("on a slope the water clings to the rock", clings > s.count * 0.5, `${clings}/${s.count}`);
  check("…and never goes under it", under === 0, `${under} below`);
  check("…and reaches the bottom", s.impact.y < 2);
}

{
  // A ledge 20 m down, 3 m deep: a slow lip lands on it and cascades off.
  const ledge = (x, yFrom, z) => ({ y: z < 0 ? 50 : z < 3 ? 30 : 0, ...flatN });
  const s = solveFall({ ...lip, speed: 0.6, friction: 0.2 }, { sampleGround: ledge });
  let onLedge = 0;
  for (let v = 0; v < s.count; v++) if (s.contact[v] > 0.5 && near(s.position[v * 3 + 1], 30.12, 0.2)) onLedge++;
  check("a ledge catches the sheet", onLedge > 0, `${onLedge} vertices on the ledge`);
  check("…and it cascades off to the ground below", near(s.impact.y, 0, 0.5), `y ${s.impact.y.toFixed(2)}`);
}

{
  // Half the lip sits in a bank that stands above the water: those columns
  // carry no water and must be marked dead, or the mesh joins them to the
  // columns that fell 50 m and stretches a quad the length of the fall.
  const bankedLip = (x, yFrom, z) => {
    if (x < -1) return { y: 60, ...flatN };        // a bank beside the lip
    return { y: z < 0 ? 50 : 0, ...flatN };
  };
  const s = solveFall({ ...lip, width: 12 }, { sampleGround: bankedLip });
  const dead = Array.from(s.colDead);
  check("columns whose lip is in the bank are dead", dead.some((d) => d) && dead.some((d) => !d), dead.join(""));
  let worst = 0;
  for (let j = 0; j < s.cols - 1; j++) {
    if (s.colDead[j] || s.colDead[j + 1]) continue;
    for (let i = 0; i < s.rows; i++) {
      const a = (j * s.rows + i) * 3, b = ((j + 1) * s.rows + i) * 3;
      worst = Math.max(worst, Math.hypot(s.position[a] - s.position[b], s.position[a + 1] - s.position[b + 1], s.position[a + 2] - s.position[b + 2]));
    }
  }
  check("…and the live columns beside each other stay together", worst < 12, `worst neighbour gap ${worst.toFixed(1)} m`);
  check("…the landing ignores the dead ones", near(s.impact.y, 0, 0.5), `y ${s.impact.y.toFixed(2)}`);
}

{
  // Water thrown at a wall drops down its face instead of passing through.
  const wall = (x, yFrom, z) => ({ y: z < 0 ? 50 : z < 4 ? 0 : 80, ...flatN });
  const s = solveFall({ ...lip, speed: 6 }, { sampleGround: wall });
  let maxZ = -Infinity;
  for (let v = 0; v < s.count; v++) maxZ = Math.max(maxZ, s.position[v * 3 + 2]);
  check("a wall stops the water going through it", maxZ < 4.5, `max z ${maxZ.toFixed(2)}`);
}

{
  const s = solveFall({ ...lip, spread: 0.3 }, { sampleGround: cliff });
  check("spread fans the sheet out", s.impact.width > lip.width * 1.5, `${s.impact.width.toFixed(2)} m`);
}

{
  const h = (x, z) => (x > 2 ? 0 : 40);
  const yaw = downhillYaw(0, 0, h);
  check("downhill yaw points over the edge", yaw !== null && near(Math.sin(yaw), 1, 0.05), `yaw ${yaw}`);
  check("no downhill on flat ground", downhillYaw(0, 0, () => 5) === null);
}

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
