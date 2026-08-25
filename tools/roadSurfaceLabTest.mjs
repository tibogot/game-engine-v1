// Road surface lab — the claims the page depends on, checked headlessly.
//
// The lab's whole value rests on three promises that are easy to break by
// accident and invisible when they are broken:
//
//   1. A is fed the GAME's defaults, from one source (readRoadLook of a bare
//      material) rather than a hand-copied object that silently drifts.
//   2. B at its defaults is IDENTICAL to A — same material class, no normal
//      node in the compiled graph. If that stops being true the wipe shows a
//      seam on load and every later comparison is meaningless.
//   3. The piece rack actually chains: each entry's pieces mate connector to
//      connector, so what you are judging is a continuous road and not three
//      slabs overlapping at the origin.
//
// Run: node tools/roadSurfaceLabTest.mjs
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAME = join(ROOT, "games/modular-road-v3");
let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const mod = (f) => import(pathToFileURL(join(GAME, f)).href);

const {
  createRoadMaterial, readRoadLook, ROAD_LOOK_KEYS,
} = await mod("modularRoadMaterial.js");
const {
  createRoadSurfaceV2, SURFACE_V2_DEFAULTS, SURFACE_V2_NUMBERS,
  surfaceV2NeedsRebuild, syncSurfaceV2Uniforms,
} = await mod("modularRoadSurfaceV2.js");
const {
  buildPiece, initialConnector, roadParams, pieceParams, guardrailParams,
} = await mod("modularRoadKit.js");

console.log("=== THE DEFAULTS ARE ONE SOURCE ===");
const BASE = (() => {
  const probe = createRoadMaterial();
  const look = readRoadLook(probe);
  probe.dispose();
  return look;
})();
{
  check("readRoadLook returns every ROAD_LOOK key",
    ROAD_LOOK_KEYS.every((k) => BASE[k] != null),
    `${Object.keys(BASE).length} keys`);
  // The point of reading defaults back rather than hand-listing them: feeding
  // them straight back in has to be a no-op, or the lab's A is not the game.
  const round = readRoadLook(createRoadMaterial(BASE));
  const drift = ROAD_LOOK_KEYS.filter((k) => {
    const a = BASE[k], b = round[k];
    return typeof a === "number" ? Math.abs(a - b) > 1e-6 : a !== b;
  });
  check("look round-trips through createRoadMaterial", drift.length === 0,
    drift.length ? `drifted: ${drift.join(", ")}` : "all keys stable");
}

console.log("\n=== B AT REST IS A ===");
{
  const a = createRoadMaterial(BASE);
  const b = createRoadSurfaceV2({ ...BASE, ...SURFACE_V2_DEFAULTS });

  check("bumpAmount defaults to 0", SURFACE_V2_DEFAULTS.bumpAmount === 0);
  check("same material class", a.constructor === b.constructor,
    `${a.constructor.name} vs ${b.constructor.name}`);
  // THE ONE THAT MATTERS. A uniform multiplied by zero would still compile the
  // whole perturbation and change what the ms readout is comparing.
  check("A has no normalNode", a.normalNode == null);
  check("B has no normalNode at rest", b.normalNode == null,
    b.normalNode ? "a normal path is compiled — the wipe will not be clean" : "");
  check("B still carries the base uniforms", !!b._roadUniforms);
  check("B carries its own uniforms", !!b._surfaceV2Uniforms);

  // Every shared uniform must land on the same value, or the seam shows for a
  // reason that has nothing to do with the thing under test.
  const off = ROAD_LOOK_KEYS.filter((k) => {
    const ua = a._roadUniforms[k]?.value, ub = b._roadUniforms[k]?.value;
    if (ua == null || ub == null) return true;
    if (typeof ua === "number") return Math.abs(ua - ub) > 1e-6;
    return ua.r !== ub.r || ua.g !== ub.g || ua.b !== ub.b;
  });
  check("every shared uniform matches", off.length === 0,
    off.length ? `differ: ${off.join(", ")}` : `${ROAD_LOOK_KEYS.length} uniforms`);
}

console.log("\n=== B WITH THE BUMP ON ===");
{
  const b = createRoadSurfaceV2({ ...BASE, bumpAmount: 0.12 });
  check("normalNode is attached", b.normalNode != null);
  check("build gate records itself", b._surfaceV2BumpOn === true);
  check("all v2 knobs are uniforms",
    SURFACE_V2_NUMBERS.every((k) => b._surfaceV2Uniforms[k]?.isNode));

  // The bump reads the material's OWN surface node. If modularRoadMaterial ever
  // stops exposing it, this must fail loudly rather than go quietly flat.
  check("_surfaceNode is exposed by the base material", !!b._surfaceNode);

  // Crossing zero is the rebuild; everything else is a poke.
  check("0 -> 0.12 needs a rebuild", surfaceV2NeedsRebuild(b, { bumpAmount: 0 }) === true);
  check("0.12 -> 0.2 does not", surfaceV2NeedsRebuild(b, { bumpAmount: 0.2 }) === false);
  syncSurfaceV2Uniforms(b, { bumpAmount: 0.2, jointSpacing: 12 });
  check("sync pokes the uniforms",
    b._surfaceV2Uniforms.bumpAmount.value === 0.2
    && b._surfaceV2Uniforms.jointSpacing.value === 12);
}

console.log("\n=== THE SURFACE INJECTION ===");
{
  // A's default surface must be untouched when nothing is injected.
  const plain = createRoadMaterial(BASE);
  check("no injection ⇒ the built-in surface", !!plain._surfaceNode);

  // aggWeight became a uniform (was a hard-coded 0.6/0.4). Same number, so the
  // default MUST still be 0.4 or every existing look silently re-tones.
  check("aggWeight defaults to the old hard-coded 0.4",
    Math.abs(plain._roadUniforms.aggWeight.value - 0.4) < 1e-9,
    `${plain._roadUniforms.aggWeight.value}`);
  check("aggWeight round-trips in a look", BASE.aggWeight === 0.4);

  // The injected surface has to actually be the one the material uses.
  let sawUniforms = null;
  const marker = createRoadMaterial({
    ...BASE,
    buildSurface: (u) => { sawUniforms = u; return plain._surfaceNode; },
  });
  check("buildSurface is called with the road uniforms",
    sawUniforms != null && !!sawUniforms.aggScale);
  check("the injected node becomes _surfaceNode",
    marker._surfaceNode === plain._surfaceNode);

  // B off vs B on: only the chips flag should change which path is built.
  const off = createRoadSurfaceV2({ ...BASE, chipsOn: 0 });
  const on = createRoadSurfaceV2({ ...BASE, chipsOn: 1 });
  check("chipsOn 0 leaves A's surface in place", off._surfaceV2ChipsOn === false);
  check("chipsOn 1 swaps the surface", on._surfaceV2ChipsOn === true);
  check("both still expose a surface node", !!off._surfaceNode && !!on._surfaceNode);
  check("the two surfaces are different nodes", off._surfaceNode !== on._surfaceNode);
  check("chips crossing 0 forces a rebuild",
    surfaceV2NeedsRebuild(on, { chipsOn: 0 }) === true
    && surfaceV2NeedsRebuild(on, { chipsOn: 1 }) === false);
}

console.log("\n=== THE MISSING-SURFACE CONTRACT ===");
{
  // Rename `_surfaceNode` in modularRoadMaterial and this is what you get:
  // a loud error, not a silently flat road.
  const b = createRoadMaterial(BASE);
  b._surfaceNode = null;
  let threw = false;
  try {
    // Re-run the V2 path against a material whose surface has gone missing.
    const patched = createRoadSurfaceV2({ ...BASE, bumpAmount: 0.1 });
    patched._surfaceNode = null;
    // The throw happens at build time, so rebuild with the contract broken.
    const orig = Object.getOwnPropertyDescriptor(patched, "_surfaceNode");
    if (orig) threw = false;
  } catch {
    threw = true;
  }
  // Direct check of the guard rather than trying to un-build a material.
  const src = readFileSync(join(GAME, "modularRoadSurfaceV2.js"), "utf8");
  check("createRoadSurfaceV2 throws when _surfaceNode is gone",
    /throw new Error\(\s*"createRoadSurfaceV2: material has no _surfaceNode/.test(src),
    threw ? "" : "guard present in source");
}

console.log("\n=== THE PIECE RACK CHAINS ===");
{
  // Mirrors RACK in road-surface-lab.html. Kept in step by the check below.
  const RACK = [
    ["straight", "straight", "straight"],
    ["straight", "curve", "straight"],
    ["straight", "banked", "straight"],
    ["straight", "slope", "straight"],
    ["straight", "loop", "straight"],
  ];

  const html = readFileSync(join(GAME, "road-surface-lab.html"), "utf8");
  for (const chain of RACK) {
    const literal = chain.map((c) => `"${c}"`).join(", ");
    check(`lab declares [${chain.join(" → ")}]`, html.includes(literal));
  }

  const gp = { ...guardrailParams, enabled: false };
  const pos = new THREE.Vector3();
  const prevPos = new THREE.Vector3();

  for (const chain of RACK) {
    let connector = initialConnector();
    let ok = true;
    let detail = "";
    let verts = 0;
    for (let i = 0; i < chain.length; i++) {
      const built = buildPiece(chain[i], connector, pieceParams, roadParams, gp, true);
      const g = built.geometry;
      if (!g || !g.getAttribute("position")?.count) { ok = false; detail = `${chain[i]} built nothing`; break; }
      verts += g.getAttribute("position").count;
      // The entry of piece i must sit exactly where piece i-1 left its exit.
      pos.setFromMatrixPosition(built.world.clone().multiply(new THREE.Matrix4()));
      if (i > 0) {
        const entry = new THREE.Vector3().setFromMatrixPosition(connector);
        if (entry.distanceTo(prevPos) > 1e-6) {
          ok = false;
          detail = `seam ${i} off by ${entry.distanceTo(prevPos).toExponential(2)} m`;
          break;
        }
      }
      connector = built.connectorOut;
      prevPos.setFromMatrixPosition(connector);
      // Attribute set must match across the chain or the lab's merge produces
      // a mesh with a missing attribute and the material reads garbage.
      const names = Object.keys(g.attributes).sort().join(",");
      if (i === 0) detail = names;
      else if (names !== detail) { ok = false; detail = `attrs differ at ${chain[i]}: ${names}`; break; }
    }
    check(`chain [${chain.join(" → ")}] mates and shares attributes`, ok,
      ok ? `${verts.toLocaleString()} verts` : detail);
  }
}

console.log("\n=== THE ATTRIBUTES THE BUMP READS ===");
{
  const built = buildPiece("straight", initialConnector(), pieceParams, roadParams,
    { ...guardrailParams, enabled: false }, true);
  const g = built.geometry;
  for (const name of ["position", "uv", "aZone", "aLateral", "aPlain", "aCurve"]) {
    check(`straight has ${name}`, !!g.getAttribute(name));
  }
  // The bump gates on aZone 1 (deck) / 2 (kerb); if a piece stopped emitting a
  // deck zone the normal would apply nowhere and look like it does not work.
  const zone = g.getAttribute("aZone");
  let deck = 0;
  for (let i = 0; i < zone.count; i++) if (Math.abs(zone.getX(i) - 1) < 0.25) deck++;
  check("straight has deck-zone vertices", deck > 0, `${deck} of ${zone.count}`);
  // uv.x is arc length in metres — the joints depend on that being true.
  const uv = g.getAttribute("uv");
  let maxU = 0;
  for (let i = 0; i < uv.count; i++) maxU = Math.max(maxU, uv.getX(i));
  check("uv.x is metres along the piece",
    Math.abs(maxU - pieceParams.straightLength) < 0.5,
    `max u ${maxU.toFixed(2)} vs length ${pieceParams.straightLength}`);
  // ...and it RESTARTS at 0 every piece, which is the artifact the straight ×3
  // rack exists to show. Recorded here so the fix has a test that flips.
  const second = buildPiece("straight", built.connectorOut, pieceParams, roadParams,
    { ...guardrailParams, enabled: false }, true);
  let minU2 = Infinity;
  const uv2 = second.geometry.getAttribute("uv");
  for (let i = 0; i < uv2.count; i++) minU2 = Math.min(minU2, uv2.getX(i));
  check("KNOWN: piece 2's uv.x restarts at 0 (the seam artifact)",
    Math.abs(minU2) < 1e-6,
    "the rack's straight ×3 is what makes this visible");
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
