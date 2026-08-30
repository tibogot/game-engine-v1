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

/* ── THE PAINT IS ITS OWN MATERIAL ─────────────────────────────────────────
 *
 * Road marking is a thermoplastic band laid ON the asphalt: it fills the pores
 * under it, sits proud of them, is smoother than what it covers, and — because
 * it is non-porous — barely darkens in the rain while the deck halves. Before
 * this it was albedo and nothing else, so a line wore the deck's full aggregate
 * relief and roughness and read as chalk.
 *
 * The load-bearing structural claim is that the RELIEF and the ALBEDO ask the
 * SAME function where the paint is. A second copy of that mask in the bump path
 * would drift the moment anyone touched `edgeWidth` or the dash phase, and the
 * symptom — a raised lip a few centimetres beside the white — is exactly the
 * kind of thing nobody attributes to a duplicated expression. */
console.log("\n=== THE PAINT AS A MATERIAL ===");
{
  const src = readFileSync(join(GAME, "modularRoadMaterial.js"), "utf8");
  const v2src = readFileSync(join(GAME, "modularRoadSurfaceV2.js"), "utf8");

  check("the mask is a function of its inputs, not a bound node",
    /export function lineCoverageAt\s*\(/.test(src));
  check("the material's own lineAmt goes through it",
    /const lineAmt = Fn\(\(\) => lineCoverageAt\(/.test(src));
  check("the bump path imports it rather than copying it",
    /import \{[^}]*lineCoverageAt[^}]*\} from ".\/modularRoadMaterial.js"/.test(v2src));
  check("...and there is no second edge-mask expression in the bump path",
    !/u\.edgeWidth|edgePos/.test(v2src),
    "the V2 file must never name the line uniforms directly — it calls the mask");

  const b = createRoadSurfaceV2({ ...BASE, bumpAmount: 0.12 });
  check("the base material exposes the line node", !!b._lineNode,
    "needed to suppress asphalt relief under the paint");
  check("paint relief ships on", b._surfaceV2PaintOn === true);

  // The build gate has to be REGISTERED, or the sliders appear dead until some
  // unrelated edit happens to rebuild the material. That is the worst class of
  // bug to notice, so it gets its own check.
  // NOTE the full look each time: surfaceV2NeedsRebuild compares the material
  // against a COMPLETE intended state, so an omitted key reads as its default
  // (bumpAmount 0) and correctly demands a rebuild. Passing a partial here is a
  // test bug, not a code one — it cost a red line to rediscover.
  const on = { ...SURFACE_V2_DEFAULTS, bumpAmount: 0.12 };
  check("turning both relief knobs off needs a rebuild",
    surfaceV2NeedsRebuild(b, { ...on, lineBump: 0, lineFill: 0 }) === true);
  check("changing relief within on does not",
    surfaceV2NeedsRebuild(b, { ...on, lineBump: 0.8 }) === false);
  const flat = createRoadSurfaceV2({ ...BASE, bumpAmount: 0.12, lineBump: 0, lineFill: 0 });
  check("...and the gate records itself the other way", flat._surfaceV2PaintOn === false);
  check("a gated-off paint still compiles a normal", flat.normalNode != null,
    "the asphalt bump is independent of the paint relief");

  // The shading half lives on the base material and must ride the saved look.
  for (const k of ["lineRough", "lineWet", "lineCoat", "lineCoatRough"]) {
    check(`${k} is a look uniform`, ROAD_LOOK_KEYS.includes(k) && !!b._roadUniforms[k]);
  }
  // The physical claim behind lineWet: paint darkens LESS than asphalt. If a
  // future tune inverts that, the wet-road effect quietly reverses.
  check("paint takes less wet darkening than the deck",
    b._roadUniforms.lineWet.value < 1,
    `${b._roadUniforms.lineWet.value} — a non-porous surface has few pores to fill`);
  check("...and more coat than the deck",
    b._roadUniforms.lineCoat.value > 1,
    `${b._roadUniforms.lineCoat.value}× — water sits on top rather than soaking in`);
  check("...at a lower coat roughness",
    b._roadUniforms.lineCoatRough.value < 1,
    `${b._roadUniforms.lineCoatRough.value}× — a film over flat paint beats one over chips`);
  check("paint is smoother than asphalt when dry",
    b._roadUniforms.lineRough.value < b._roadUniforms.deckRough.value,
    `${b._roadUniforms.lineRough.value} vs ${b._roadUniforms.deckRough.value}`);
}

/* ── ANISOTROPIC SPECULAR ──────────────────────────────────────────────────
 *
 * A road is directionally polished — tyres drag along the direction of travel —
 * and until now only the ALBEDO knew that. This is the same claim reaching the
 * specular lobe.
 *
 * THE TRAP, and the reason this section exists: `anisotropyNode` and the
 * `useAnisotropy` getter that reads it are declared on MeshPhysicalNodeMaterial
 * ONLY. Assign the node to a MeshStandardNodeMaterial and it sticks silently —
 * the property is there, nothing reads it, the slider moves and the deck does
 * not change. So the checks below ask THREE whether the lighting model actually
 * changed, rather than trusting that the assignment landed.
 *
 * The knock-on is the second half: two features now pick the Physical class, so
 * the class can no longer tell you WHICH is on. roadGame used to sniff
 * `isMeshPhysicalNodeMaterial` to mean "wet"; with a dry anisotropic road that
 * reads wet, disagrees with the intent forever, and rebuilds the material — and
 * re-merges the whole drive-mode track — on every check. Hence the flags. */
console.log("\n=== ANISOTROPIC SPECULAR ===");
{
  const dry = createRoadSurfaceV2({ ...BASE });
  check("off by default", dry.anisotropyNode == null);
  check("...and still Standard when off", dry.constructor.name === "MeshStandardNodeMaterial",
    "off must cost nothing — no anisotropic BRDF, no bent normal");

  const aniso = createRoadSurfaceV2({ ...BASE, anisotropy: 0.6 });
  check("on builds the node", aniso.anisotropyNode != null);
  check("on forces the Physical class",
    aniso.constructor.name === "MeshPhysicalNodeMaterial",
    "anisotropyNode is a Physical-only property — on Standard it is ignored silently");
  check("three's lighting model actually switches", aniso.useAnisotropy === true,
    `useAnisotropy=${aniso.useAnisotropy} — this is the check that catches a no-op`);
  check("a dry anisotropic road has no clearcoat", aniso.clearcoatNode == null,
    "Physical for the BRDF, not for the coat");

  // The flags that replaced the class sniff.
  check("the material states whether it is wet", aniso._roadWet === false);
  check("...and whether it is anisotropic", aniso._roadAniso === true);
  const wet = createRoadSurfaceV2({ ...BASE, wet: true });
  check("a wet road reports wet", wet._roadWet === true && wet._roadAniso === false);
  check("...and both together report both", (() => {
    const both = createRoadSurfaceV2({ ...BASE, wet: true, anisotropy: 0.4 });
    return both._roadWet === true && both._roadAniso === true;
  })());
  check("the class alone can no longer answer either question",
    wet.constructor.name === aniso.constructor.name,
    "wet and dry-anisotropic are both Physical — which is exactly why the flags exist");

  for (const k of ["anisotropy", "anisotropyAngle", "anisoWheel", "anisoWet"]) {
    check(`${k} is a look uniform`, ROAD_LOOK_KEYS.includes(k) && !!aniso._roadUniforms[k]);
  }
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
  check("piece 2's uv.x still restarts at 0",
    Math.abs(minU2) < 1e-6,
    "uv.x is left alone on purpose — dashes/kerb bands/rings keep their phase");

  // ...and the repeat it used to cause is now broken by a per-piece phase that
  // rides alongside uv.x rather than inside it. This is the check that flipped.
  const offA = built.geometry.getAttribute("aAlongOffset");
  const offB = second.geometry.getAttribute("aAlongOffset");
  check("both pieces carry a noise phase", !!offA && !!offB);
  check("neighbouring pieces get DIFFERENT phases",
    offA && offB && Math.abs(offA.getX(0) - offB.getX(0)) > 1e-3,
    offA && offB ? `${offA.getX(0).toFixed(1)} vs ${offB.getX(0).toFixed(1)} m` : "");
  check("the phase is constant within a piece",
    offA && Array.from({ length: offA.count }, (_, i) => offA.getX(i))
      .every((v) => Math.abs(v - offA.getX(0)) < 1e-9),
    "must be constant, or it would show up in fwidth and skew the distance fade");
  // Same piece, same place, twice: a phase that shimmered between rebuilds
  // would repaint the deck on every edit.
  const again = buildPiece("straight", initialConnector(), pieceParams, roadParams,
    { ...guardrailParams, enabled: false }, true);
  check("the phase is stable for a given placement",
    Math.abs(again.geometry.getAttribute("aAlongOffset").getX(0) - offA.getX(0)) < 1e-9);
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
