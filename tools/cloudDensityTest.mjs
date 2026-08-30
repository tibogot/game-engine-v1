/**
 * Headless probe for the modular-road cloud density field.
 *
 * Calibration, not rendering: the Nubis recipe thresholds the base mass at `1 - coverage`,
 * and whether anything clears that bar depends on four separately-normalised noise fields
 * interacting. Eyeballing that through a GPU raymarch and a screenshot is slow and
 * ambiguous — here it is a number. This is how the "empty sky" and the narrow-dynamic-range
 * bugs were found.
 *
 * The density function itself is NOT reimplemented here: it is `densityAtCPU` from
 * modularRoadCloudNoise.js, the same one the game uses to answer "is the car in a cloud".
 * One CPU mirror of the shader, one place for it to drift from.
 *
 * Run: node tools/cloudDensityTest.mjs
 */
import { pathToFileURL } from "node:url";
import {
  bakeBaseVolume, bakeDetailVolume, bakeWeatherMap, densityAtCPU,
} from "../games/modular-road-v3/modularRoadCloudNoise.js";

const NO_WIND = { x: 0, y: 0, z: 0 };

/** Vertical optical depth through the whole slab at one XZ — this is what alpha becomes. */
function opticalDepth(vols, P, x, z, slices = 44) {
  let tau = 0;
  for (let k = 0; k < slices; k++) {
    const y = P.base + P.thickness * ((k + 0.5) / slices);
    tau += densityAtCPU(vols, P, NO_WIND, x, y, z) * (P.thickness / slices);
  }
  return tau;
}

function main() {
  const P = {
    base: 260, thickness: 620, coverage: 0.9, coverageBias: 0.0,
    densityMul: 0.16, erode: 0.32, typeBias: 0.5,
    cloudTopMin: 0.18, cloudTopBias: 0.0,
  };

  process.stdout.write("baking volumes… ");
  const t0 = Date.now();
  const vols = {
    base: bakeBaseVolume(137),
    detail: bakeDetailVolume(137 ^ 0x5f3a),
    weather: bakeWeatherMap(137 ^ 0x77e1),
  };
  console.log(`${Date.now() - t0} ms`);

  // 1) Fill per height band. Empty rows here mean the coverage threshold is unreachable.
  const bands = [];
  for (const hf of [0.15, 0.3, 0.45, 0.6, 0.8]) {
    const y = P.base + P.thickness * hf;
    let n = 0, hits = 0, sum = 0, mx = 0;
    for (let ix = 0; ix < 60; ix++) {
      for (let iz = 0; iz < 60; iz++) {
        const d = densityAtCPU(vols, P, NO_WIND, (ix / 60) * 3000 - 1500, y, (iz / 60) * 3000 - 1500);
        n++; sum += d; if (d > mx) mx = d;
        if (d > 0.0005) hits++;
      }
    }
    bands.push({
      h: hf, y: Math.round(y),
      fill: `${((hits / n) * 100).toFixed(1)}%`,
      maxDensity: +mx.toFixed(4), meanDensity: +(sum / n).toFixed(5),
    });
  }
  console.log("\nDensity by height band:");
  console.table(bands);

  // 2) Sky character. "broken" is the interesting column: those are the columns a track
  //    can thread through. All-opaque is a ceiling; all-clear is a wasted system.
  const rows = [];
  for (const coverage of [0.6, 0.75, 0.9, 1.05, 1.2]) {
    const Pc = { ...P, coverage };
    let opaque = 0, clear = 0, n = 0, tauSum = 0;
    for (let ix = 0; ix < 50; ix++) {
      for (let iz = 0; iz < 50; iz++) {
        const tau = opticalDepth(vols, Pc, (ix / 50) * 3000 - 1500, (iz / 50) * 3000 - 1500);
        n++; tauSum += tau;
        if (tau > 1.5) opaque++; else if (tau < 0.05) clear++;
      }
    }
    rows.push({
      coverage, "mean tau": +(tauSum / n).toFixed(2),
      "opaque %": +((100 * opaque) / n).toFixed(1),
      "clear %": +((100 * clear) / n).toFixed(1),
      "broken %": +((100 * (n - opaque - clear)) / n).toFixed(1),
    });
  }
  console.log("\nSky character vs coverage (shipped default is 0.9):");
  console.table(rows);

  const anyFill = bands.some((b) => parseFloat(b.fill) > 1);
  if (!anyFill) {
    console.log(
      "\nEMPTY SKY — the base mass never clears the `1 - coverage` threshold.\n"
      + "Check that the bakes still run normalizeChannel(): without it the noise fields\n"
      + "occupy a narrow mid band and every remap threshold becomes all-or-nothing.",
    );
    process.exitCode = 1;
  }
}

// pathToFileURL, not string-concat: on Windows argv[1] is `c:\...` and a naive
// `file://${argv[1]}` never matches import.meta.url's `file:///c:/...`.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
