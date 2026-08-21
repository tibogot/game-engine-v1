// Cheap tube material — tubes leave the asphalt graph.
//
// The hitch inside a bore was fill: every tube pixel evaluated createRoadMaterial
// (noise, lines, wet, PBR, MRT) then threw it away. createTubeMaterial is the
// lab shader. This asserts the wiring, not GPU ms (no WebGPU in node).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = join(ROOT, "games/modular-road-v3/modularRoadBuilder.js");
const GAME = join(ROOT, "games/modular-road-v3/roadGame.js");
const MAT = join(ROOT, "games/modular-road-v3/modularRoadMaterial.js");
const THUMBS = join(ROOT, "games/modular-road-v3/modularRoadThumbnails.js");

const builderSrc = readFileSync(BUILDER, "utf8");
const gameSrc = readFileSync(GAME, "utf8");
const matSrc = readFileSync(MAT, "utf8");
const thumbSrc = readFileSync(THUMBS, "utf8");

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const { PIECE_BY_ID } =
  await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);

const TUBE_IDS = [
  "tube", "tube_curve", "tube_in", "tube_out",
  "half_tube", "half_tube_curve", "half_tube_in", "half_tube_out",
  "half_pipe", "half_pipe_curve",
];
const ROAD_IDS = ["straight", "channel", "tunnel", "quarterpipe"];

console.log("— catalog —");
for (const id of TUBE_IDS) {
  check(`${id} is flagged tubeShader`, PIECE_BY_ID.get(id)?.tubeShader === true);
}
for (const id of ROAD_IDS) {
  check(`${id} stays on the asphalt material`, !PIECE_BY_ID.get(id)?.tubeShader);
}

console.log("\n— material —");
const tubeFn = matSrc.slice(
  matSrc.indexOf("export function createTubeMaterial"),
  matSrc.indexOf("export const TUBE_LOOK_COLORS"),
);
check("createTubeMaterial is exported", /export function createTubeMaterial/.test(matSrc));
check("it is FrontSide (the lab fill win)", /side: THREE\.FrontSide/.test(tubeFn));
check("it does not compile the asphalt graph",
  /mat\._tubeUniforms = u;/.test(tubeFn)
  && !/asphaltDark/.test(tubeFn)
  && !/mx_noise/.test(tubeFn));
check("look sync copies the shared tube/neon keys",
  /export function syncTubeUniforms/.test(matSrc)
  && /TUBE_LOOK_COLORS/.test(matSrc));

console.log("\n— builder / drive merge / thumbnails —");
check("the builder accepts a tubeMaterial",
  /tubeMaterial = null/.test(builderSrc) && /this\.tubeMaterial = tubeMaterial/.test(builderSrc));
check("tube pieces pick the cheap shader, not this.material",
  /_deckMaterial/.test(builderSrc) && /_isTubePiece/.test(builderSrc));
check("drive merge has a tube role (so asphalt does not swallow the bore)",
  /p\.mesh\?\.material === tubeMaterial/.test(gameSrc)
  && /mat: \(\) => tubeMaterial/.test(gameSrc));
check("weather rebuilds keep the tube look in sync",
  /syncTubeUniforms\(tubeMaterial, roadLook\)/.test(gameSrc));
check("palette thumbnails bake tubes with the cheap shader",
  /built\.def\.tubeShader && materials\.tube/.test(thumbSrc));

console.log(fail === 0 ? "\nAll tube-material checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
