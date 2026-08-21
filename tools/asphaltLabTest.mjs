// Asphalt lab — cheap paint + FrontSide, not wired into the game yet.
//
// Same split the tubes used: a lab A/B first (full graph vs cheap, DoubleSide
// vs FrontSide), then decide. This asserts the lab exists and the GAME still
// ships the full DoubleSide asphalt.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAT = join(ROOT, "games/modular-road-v3/modularRoadMaterial.js");
const GAME = join(ROOT, "games/modular-road-v3/roadGame.js");
const LAB = join(ROOT, "games/modular-road-v3/asphalt-lab.html");

const matSrc = readFileSync(MAT, "utf8");
const gameSrc = readFileSync(GAME, "utf8");
const labSrc = readFileSync(LAB, "utf8");

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const cheapFn = matSrc.slice(
  matSrc.indexOf("export function createCheapAsphaltMaterial"),
  matSrc.indexOf("export const CHEAP_ASPHALT_COLORS"),
);
const roadFn = matSrc.slice(
  matSrc.indexOf("export function createRoadMaterial"),
  matSrc.indexOf("export const ROAD_GLASS"),
);

console.log("— cheap asphalt (lab) —");
check("createCheapAsphaltMaterial is exported",
  /export function createCheapAsphaltMaterial/.test(matSrc));
check("it is FrontSide", /side: THREE\.FrontSide/.test(cheapFn));
check("it does not compile the asphalt noise graph",
  !/mx_noise/.test(cheapFn) && !/mx_fractal_noise/.test(cheapFn)
  && !/driftField/.test(cheapFn) && !/applyBloomMRT/.test(cheapFn));
check("look sync exists", /export function syncCheapAsphaltUniforms/.test(matSrc));

console.log("\n— the game is unchanged —");
check("createRoadMaterial is still DoubleSide",
  /side: THREE\.DoubleSide/.test(roadFn));
check("the game does not import the cheap asphalt shader",
  !/createCheapAsphaltMaterial/.test(gameSrc)
  && !/syncCheapAsphaltUniforms/.test(gameSrc));

console.log("\n— lab wiring —");
check("asphalt-lab.html exists and A/Bs both shaders",
  /createRoadMaterial/.test(labSrc)
  && /createCheapAsphaltMaterial/.test(labSrc)
  && /ctl\.shader/.test(labSrc)
  && /doubleSide/.test(labSrc));
check("the lab has a fill camera and an under-slab camera",
  /function fillCamera/.test(labSrc) && /function underCamera/.test(labSrc));
check("the lab says the game is not touched",
  /Game files are not touched/.test(labSrc));

console.log(fail === 0 ? "\nAll asphalt-lab checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
