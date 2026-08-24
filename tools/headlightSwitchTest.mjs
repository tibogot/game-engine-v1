// ============================================================================
// Headlight switch harness — the regression guard for the "pressing H freezes
// the game" stall.
//
// The stall was never the lights. Toggling `SpotLight.visible` REMOVES the light
// from the scene's light set (three's `Renderer._projectObject` skips invisible
// objects), and that set is hashed into `LightsNode.customCacheKey()`, which is
// folded into every RenderObject's cache key — so one keypress rebuilt the WGSL
// and the GPURenderPipeline for every visible material in the world, through the
// synchronous `device.createRenderPipeline`. Switching back off released those
// pipelines again, so it was not even a one-time cost.
//
// The fix is to switch with `intensity` and leave `visible` alone. This test
// asserts that using the REAL LightsNode from three: the cache key computed over
// the lights that would actually reach the render list must be IDENTICAL with
// the headlights on and off. If someone reintroduces a `visible` toggle, the two
// keys diverge and this fails.
//
// Run:  node tools/headlightSwitchTest.mjs
//
// Headless-only shims: the Vehicle builds node materials for the lamp faces, so
// the two GPU-only imports are stripped and `three` is resolved to `three/webgpu`
// the way vite's alias does in the app. The rig is exercised on a bare
// Object.create(Vehicle.prototype) — none of this touches the physics.
// ============================================================================
import * as THREE from "three/webgpu";
import { lights } from "three/tsl";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "v3/play/modularRoadVehicle.js");
const TMP = join(ROOT, `.headlightTest.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(SRC, "utf8")
  .replace(/^import \* as THREE from "three";$/m, 'import * as THREE from "three/webgpu";')
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));

const { Vehicle, HEADLIGHTS } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * A Vehicle with ONLY the light rig on it. `_buildHeadlights` needs nothing but
 * `chassisMesh`, and `_applyChassisStyle` needs the two body handles plus the
 * tail-light array — so the whole rigid body, the wheels and the BVHs stay out
 * of this entirely.
 */
function makeRig({ style = "procedural" } = {}) {
  const v = Object.create(Vehicle.prototype);
  v.chassisMesh = new THREE.Object3D();
  v._chassisStyle = style;
  v._chassisGlb = style === "glb" ? new THREE.Object3D() : null;
  v._chassisProc = new THREE.Object3D();
  v._headlampMounts = null;
  v.taillights = [];
  v._buildHeadlights();
  return v;
}

/**
 * What the renderer would see. Mirrors `Renderer._projectObject` — invisible
 * objects never reach `renderList.pushLight` — and then asks the real LightsNode
 * for the key that ends up in every shader's cache key.
 */
function lightSetCacheKey(root) {
  const visible = [];
  // A faithful copy of _projectObject's walk: an invisible node prunes its whole
  // subtree, so this is NOT Object3D.traverse (which descends regardless).
  (function project(o) {
    if (o.visible === false) return;
    if (o.isLight) visible.push(o);
    for (const child of o.children) project(child);
  })(root);
  return { key: lights(visible).customCacheKey(), count: visible.length };
}

// ── 1) the switch must not change the scene's light set ────────────────────
console.log("\nlight set is invariant across the switch");
{
  HEADLIGHTS.enabled = false;
  const v = makeRig();
  v.setHeadlights(false);
  const off = lightSetCacheKey(v.chassisMesh);
  v.setHeadlights(true);
  const on = lightSetCacheKey(v.chassisMesh);
  v.setHeadlights(false);
  const offAgain = lightSetCacheKey(v.chassisMesh);

  check("both beams reach the render list while OFF", off.count === 2, `count=${off.count}`);
  check("both beams reach the render list while ON", on.count === 2, `count=${on.count}`);
  check(
    "LightsNode cache key identical off→on (no shader rebuild)",
    off.key === on.key,
    `off=${off.key} on=${on.key}`,
  );
  check(
    "LightsNode cache key identical on→off (no shader rebuild)",
    on.key === offAgain.key,
    `on=${on.key} off=${offAgain.key}`,
  );
  check("no beam is ever hidden", v.headlights.every((l) => l.visible === true));
}

// ── 2) the switch still actually switches ──────────────────────────────────
console.log("\nthe switch still lights the road");
{
  HEADLIGHTS.enabled = false;
  const v = makeRig();

  v.setHeadlights(false);
  check("OFF ⇒ zero beam intensity", v.headlights.every((l) => l.intensity === 0));
  check("OFF ⇒ lamp faces hidden", v.headlamps.every((m) => m.visible === false));

  v.setHeadlights(true);
  check(
    "ON ⇒ full beam intensity",
    v.headlights.every((l) => l.intensity === HEADLIGHTS.intensity),
    v.headlights.map((l) => l.intensity).join(),
  );
  check("ON ⇒ lamp faces visible", v.headlamps.every((m) => m.visible === true));

  v.setHeadlights(false);
  check("back OFF ⇒ zero again", v.headlights.every((l) => l.intensity === 0));
}

// ── 3) the beam slider must not switch the lights on ───────────────────────
// applyHeadlightParams is the Lights-panel path. It used to write
// `l.intensity = H.intensity` unconditionally, which would light a car whose
// headlights are off the moment the slider moved.
console.log("\nbeam slider respects the switch");
{
  HEADLIGHTS.enabled = false;
  const v = makeRig();
  const original = HEADLIGHTS.intensity;
  try {
    v.setHeadlights(false);
    HEADLIGHTS.intensity = 3000;
    v.applyHeadlightParams();
    check("slider moved while OFF ⇒ still dark", v.headlights.every((l) => l.intensity === 0));

    v.setHeadlights(true);
    check("switched ON ⇒ picks up the new slider value", v.headlights.every((l) => l.intensity === 3000));

    HEADLIGHTS.intensity = 800;
    v.applyHeadlightParams();
    check("slider moved while ON ⇒ follows live", v.headlights.every((l) => l.intensity === 800));
  } finally {
    HEADLIGHTS.intensity = original;
  }
}

// ── 4) GLB body: its own lenses light, the procedural faces stay hidden ────
// _applyChassisStyle set the lamp visibility and THEN called
// applyHeadlightParams, which overwrote the answer with a style-blind
// `m.visible = H.enabled` — so a lit GLB car showed both sets of lamps.
console.log("\nGLB style keeps the procedural lamp faces hidden");
{
  HEADLIGHTS.enabled = false;
  const v = makeRig({ style: "procedural" });
  v.setHeadlights(true);
  check("procedural style, lit ⇒ faces shown", v.headlamps.every((m) => m.visible === true));

  v._chassisGlb = new THREE.Object3D();
  v.setChassisStyle("glb");
  check("glb style, lit ⇒ faces hidden", v.headlamps.every((m) => m.visible === false));
  check("glb style, lit ⇒ beams still on", v.headlights.every((l) => l.intensity === HEADLIGHTS.intensity));

  v.setHeadlights(false);
  v.setHeadlights(true);
  check("re-switching in glb style keeps faces hidden", v.headlamps.every((m) => m.visible === false));

  v.setChassisStyle("procedural");
  check("back to procedural ⇒ faces shown again", v.headlamps.every((m) => m.visible === true));
}

// ── 5) a fresh car must obey the caller, not the leftover module state ─────
// HEADLIGHTS is module-level and shared. A Vehicle built while `enabled` is true
// comes up lit; the game's setHeadlights(false) at boot has to actually reach the
// rig or the HUD and the beams disagree.
console.log("\nboot state cannot desync");
{
  HEADLIGHTS.enabled = true;          // leftover from a previous car / the panel
  const v = makeRig();
  check("built while enabled ⇒ comes up lit", v.headlights.every((l) => l.intensity === HEADLIGHTS.intensity));
  v.setHeadlights(false);             // what roadGame.js does at boot
  check("boot setHeadlights(false) reaches the rig", v.headlights.every((l) => l.intensity === 0));
  check("boot setHeadlights(false) hides the faces", v.headlamps.every((m) => m.visible === false));
  HEADLIGHTS.enabled = false;
}

console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
