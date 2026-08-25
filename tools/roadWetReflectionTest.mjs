// The wet road's two reflection paths, and the packed-normal bug between them.
//
// THE BUG. `wet.coatNormalPacked` is a normal stored the way `normalMap` wants
// it — `n * 0.5 + 0.5` — so it lives in 0..1 with z ≈ 1 on a near-flat surface.
// The car's planar reflection unpacked it (`.xy.sub(0.5).mul(2.0)`). The
// guardrail's did not: it read `.xz` raw off a SECOND `wetRippleNormal(u)` call.
//
// Raw `.xz` is not a zero-mean wobble, it is a near-CONSTANT offset of about
// (0.5, 1.0) scaled by reflectDistort × coatNormalGain — up to (0.025, 0.05) of
// UV at the defaults, i.e. roughly 54 px of vertical shift at 1080p, always the
// same direction, and growing with how wet the road is. A reflection sitting a
// fixed distance from the thing casting it reads as a mirror aimed wrong, which
// is what made the mirrored-rail approach look broken on slopes and crests.
//
// WHY THE CHECKS ARE STRUCTURAL. The wobble is a TSL node; evaluating it needs a
// GPU, and a headless re-implementation of the wave sum would be a second copy
// of the thing under test — exactly the divergence `_wetField` exists to avoid.
// So this asserts the SHAPE: one shared node, unpacked once, used by both.
//
// Run: node tools/roadWetReflectionTest.mjs
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
const m = await import(pathToFileURL(join(GAME, "modularRoadMaterial.js")).href);
const raw = readFileSync(join(GAME, "modularRoadMaterial.js"), "utf8");

/**
 * Source with comments stripped.
 *
 * The "is it still called?" checks below have to look at CODE. Run against the
 * raw file they trip on the comment that explains the bug — which is a test
 * failing because the fix was documented, the least useful kind of red.
 */
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/.*$/gm, "$1 ");

console.log("=== THE MATERIAL STILL BUILDS ===");
{
  const tex = new THREE.Texture();
  // railNode only exists when BOTH textures are supplied — the configuration
  // roadGame uses when the weather is on and "Rails in mirror" is enabled.
  const wet = m.createRoadMaterial({ wet: true, reflectionTexture: tex, mirrorTexture: tex });
  check("wet build is MeshPhysicalNodeMaterial", wet.isMeshPhysicalNodeMaterial === true);
  check("clearcoat lobe is compiled", wet.clearcoatNode != null);
  check("planar-mirror uniforms exist", !!wet._reflectUniforms);
  check("rail mirror runtime gate exists", !!wet._railMirrorOn);
  check("both texture nodes are assignable (ping-pong)",
    !!wet._reflectTextureNode && !!wet._mirrorTextureNode);
  check("emissive carries the reflections", wet.emissiveNode != null);

  const dry = m.createRoadMaterial();
  check("dry build stays MeshStandardNodeMaterial", dry.isMeshPhysicalNodeMaterial !== true);
  check("dry build has no clearcoat", dry.clearcoatNode == null);
  check("dry build has no reflection uniforms", !wet === false && !dry._reflectUniforms);
}

console.log("\n=== THE WOBBLE IS ONE SHARED, UNPACKED NODE ===");
{
  // The fixed shape: a single `coatWobble` built from coatNormalPacked, unpacked
  // once, then referenced by both sample sites.
  const declares = /const coatWobble = wet[\s\S]{0,240}?coatNormalPacked\.xy\.sub\(0\.5\)\.mul\(2\.0\)/.test(src);
  check("coatWobble is declared and unpacks the packed normal", declares);

  const uses = (src.match(/coatWobble/g) || []).length;
  // one declaration + two use sites
  check("coatWobble is referenced by both reflection paths", uses >= 3, `${uses} mentions`);

  check("the car's mirror uses it", /projUv\.add\(coatWobble\)/.test(src));
  check("the rail's mirror uses it", /screenUV\.add\(coatWobble\)/.test(src));
}

console.log("\n=== THE BUG CANNOT COME BACK ===");
{
  check("no raw `.xz` swizzle on a packed normal",
    !/coatNormalPacked\.xz|wetRippleNormal\([^)]*\)\.xz/.test(src));
  check("wetRippleNormal is not called here at all",
    !/wetRippleNormal\s*\(/.test(src),
    "the rail called it a second time, evaluating 6 trig twice per wet fragment");
  check("...and its import is gone with it", !/^\s*wetRippleNormal,\s*$/m.test(src));
  // Exactly one unpack in the file: the shared one. Two would mean the
  // expression got copied again rather than referenced.
  const unpacks = (src.match(/\.xy\.sub\(0\.5\)\.mul\(2\.0\)/g) || []).length;
  check("the unpack expression appears exactly once", unpacks === 1, `${unpacks} found`);
}

console.log("\n=== THE SOURCE OF TRUTH IS STILL EXPORTED ===");
{
  const wetSrc = readFileSync(join(GAME, "modularRoadWet.js"), "utf8");
  check("modularRoadWet still owns wetRippleNormal",
    /export function wetRippleNormal/.test(wetSrc));
  check("createWetShading builds coatNormalPacked from it",
    /coatNormalPacked:\s*wetRippleNormal\(u\)/.test(wetSrc),
    "one evaluation, shared by the clearcoat and both mirrors");
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
