// A PROP LYING ON THE ROAD MUST NOT CAST A SHADOW.
//
// Its shadow is coplanar with the surface it falls on, so it renders nothing
// visible and costs a shadow-map draw per cascade on top of the view draw. The
// instancer decides this from GEOMETRY rather than a catalogue flag, by total Y
// extent: "thin" is not the test, "lying down" is — a sign panel is thin in Z
// and tall in Y and must still cast.
//
// This pins the two halves that matter:
//   1. the flat props really are excluded, and the upright ones really are not;
//   2. the threshold sits in a genuine GAP in the catalogue.
//
// (2) is the one that will catch a future mistake. FLAT_PROP_HEIGHT was 0.12
// while the boost and launch pads measured 0.140 m, so they sat 2 cm the wrong
// side of it and cast shadows from a slab on the deck. Raising it to 0.2 fixed
// both. If someone later adds a prop at, say, 0.25 m it would silently stop
// casting — this fails instead, so the choice is made deliberately.
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

// Enough DOM for TextureLoader: some templates build a textured material and
// three's ImageLoader reaches for document.createElementNS. The image never
// loads and never needs to — this file only reads shadow flags and geometry.
if (typeof globalThis.document === "undefined") {
  const el = () => ({
    style: {}, addEventListener() {}, removeEventListener() {},
    setAttribute() {}, removeAttribute() {}, getContext: () => null,
    set src(_v) {}, get src() { return ""; },
  });
  globalThis.document = { createElementNS: () => el(), createElement: () => el() };
}

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { PropInstancer } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadPropInstancer.js")).href);
const { PROP_CATALOG } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadProps.js")).href);

const SRC = readFileSync(
  join(ROOT, "games/modular-road-v3/modularRoadPropInstancer.js"), "utf8");
const THRESHOLD = Number(/const FLAT_PROP_HEIGHT = ([\d.]+);/.exec(SRC)?.[1]);

function bare() {
  const it = Object.create(PropInstancer.prototype);
  it.catalog = PROP_CATALOG;
  it._templates = new Map();
  it._m4 = new THREE.Matrix4();
  return it;
}

/** Template height + cast count, or null when the template is empty (GLB props). */
function measure(id) {
  const parts = bare()._template(id);
  if (!Array.isArray(parts) || !parts.length) return null;
  let minY = Infinity, maxY = -Infinity;
  for (const p of parts) {
    p.geometry.computeBoundingBox();
    minY = Math.min(minY, p.geometry.boundingBox.min.y);
    maxY = Math.max(maxY, p.geometry.boundingBox.max.y);
  }
  return { h: maxY - minY, cast: parts.filter((p) => p.castShadow).length, n: parts.length };
}

console.log("=== THE THRESHOLD IS READABLE ===");
check("FLAT_PROP_HEIGHT parses out of the source", Number.isFinite(THRESHOLD),
  String(THRESHOLD));

console.log("\n=== FLAT PROPS DO NOT CAST ===");
for (const id of ["boostpad", "launchpad", "boostdecal", "launchdecal"]) {
  const m = measure(id);
  if (!m) { check(`${id} builds a template`, false); continue; }
  check(`${id} (${m.h.toFixed(3)} m) casts no shadow`, m.cast === 0,
    `${m.cast}/${m.n} parts still cast`);
}

console.log("\n=== UPRIGHT PROPS STILL DO ===");
for (const id of ["cone", "pole", "box", "wall", "roadblock"]) {
  const m = measure(id);
  if (!m) { check(`${id} builds a template`, false); continue; }
  check(`${id} (${m.h.toFixed(3)} m) still casts`, m.cast === m.n,
    `${m.cast}/${m.n} parts cast`);
}

console.log("\n=== THE THRESHOLD SITS IN A GAP ===");
{
  // Nothing should sit just above the line: a prop within this margin of it is
  // one tweak away from silently losing (or gaining) its shadow.
  const MARGIN = 0.15;
  const near = [];
  for (const def of PROP_CATALOG) {
    let m = null;
    try { m = measure(def.id); } catch { continue; }
    if (!m) continue;
    if (m.h >= THRESHOLD && m.h < THRESHOLD + MARGIN) near.push(`${def.id} ${m.h.toFixed(3)}m`);
  }
  check(`no prop sits within ${MARGIN} m above the ${THRESHOLD} m cutoff`,
    near.length === 0,
    near.join(", ") || "clear gap — nearest caster is well clear");
}

console.log("\n=== EVERY FLAT PROP IS COVERED, NOT JUST THE NAMED ONES ===");
{
  const wrong = [];
  for (const def of PROP_CATALOG) {
    let m = null;
    try { m = measure(def.id); } catch { continue; }
    if (!m) continue;
    if (m.h < THRESHOLD && m.cast > 0) wrong.push(`${def.id} ${m.h.toFixed(3)}m`);
  }
  check("nothing below the cutoff still casts", wrong.length === 0, wrong.join(", ") || "none");
}

console.log(fail ? `\n${fail} check(s) failed` : "\nflat props stay out of the shadow map");
process.exit(fail ? 1 : 0);
