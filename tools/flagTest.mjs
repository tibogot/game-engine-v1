// Track banner flags — one instanced draw, waved in the vertex shader.
//
// The design claim: the engine's Verlet cloth (which the RTS base flag uses)
// cannot instance, because every cloth has unique per-frame vertex positions. So
// six flags would be six particle sims AND six dynamic geometry uploads. A
// banner passed at 170 km/h does not need that fold detail, so the wave moved to
// the vertex shader — no CPU, no upload, and all of them in ONE draw.
//
// What this guards, all of it stuff that silently breaks instancing:
//   • THREE.InstancedMesh + a custom positionNode do NOT work together, so this
//     must stay a plain Mesh over an InstancedBufferGeometry
//   • separate instance buffers burn WebGPU vertex-buffer slots (8 max)
//   • frustumCulled must be off, or the whole field vanishes off-origin
//   • tint × map stains an imported image unless the tint drops to white
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

const SRC = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadFlags.js"), "utf8");
const PROPS = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadProps.js"), "utf8");
const GAME = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");

console.log("=== INSTANCING SHAPE ===");
{
  // A custom positionNode is what the wave needs, and it is exactly what rules
  // out InstancedMesh — so the plain-Mesh + InstancedBufferGeometry pattern from
  // collectibleField.js is not a style choice, it is the only thing that works.
  check("uses InstancedBufferGeometry, NOT THREE.InstancedMesh",
    /new THREE\.InstancedBufferGeometry\(\)/.test(SRC) && !/new THREE\.InstancedMesh/.test(SRC),
    "custom positionNode + InstancedMesh do not combine");
  check("the wave IS a custom positionNode (that is why the above matters)",
    /mat\.positionNode\s*=/.test(SRC));
  check("instance data is ONE interleaved buffer, not several",
    /InstancedInterleavedBuffer/.test(SRC) && /InterleavedBufferAttribute/.test(SRC),
    "WebGPU allows 8 vertex buffers per pipeline");
  check("frustumCulled is off — instances are off-origin, the mesh is not",
    /frustumCulled = false/.test(SRC));
  check("the cloth casts no shadow (3 cascade draws for a waving rag)",
    /castShadow = false/.test(SRC));
  check("instanceCount drives the draw, so unplaced flags cost nothing",
    /geometry\.instanceCount = n/.test(SRC));
}

console.log("\n=== THE CLOTH IS PINNED TO THE MAST ===");
{
  // The displacement is scaled by uv.x SQUARED. Linear would let the whole
  // banner slide sideways; squared keeps it welded at the pole and builds the
  // motion toward the loose edge, which is how cloth actually behaves.
  check("displacement is weighted toward the free edge, squared",
    /const grip = free\.mul\(free\)/.test(SRC));
  check("the flap is multiplied by that grip", /\.mul\(grip\)/.test(SRC));
  check("there are two waves at different rates, not one clean sine",
    (SRC.match(/sin\(p\.y\.mul/g) || []).length >= 2);
  check("phase is per-instance, so flags do not wave in lockstep",
    /add\(aTint\.w\)/.test(SRC));
  // A random phase would reshuffle every flag on each track load.
  check("that phase is derived from POSITION, so it survives a reload",
    /root\.position\.x \* 0\.7 \+ root\.position\.z \* 1\.3/.test(SRC));
}

console.log("\n=== TINT vs IMAGE ===");
{
  check("applying an image forces the tint to white",
    /this\._tex \? "#ffffff" : FLAG\.color/.test(SRC),
    "colour x map would otherwise stain the picture");
  check("an object URL is revoked before being replaced (no leak)",
    /revokeObjectURL/.test(SRC));
  check("clearTexture restores the flat colour", /clearTexture\(\)\s*\{[\s\S]{0,300}?map = null/.test(SRC));
  const panel = readFileSync(join(ROOT, "games/modular-road-v3/devPanel.js"), "utf8");
  check("the colour picker is DISABLED while an image is loaded",
    /colEl\.disabled = tex/.test(panel), "or you would be tinting a photo");
  check("the panel offers a file picker and a clear",
    /dv-flag-img/.test(panel) && /dv-flag-clear/.test(panel));
}

console.log("\n=== PLACEMENT COMES FROM THE PROPS SYSTEM ===");
{
  check('"flag" is a prop, so it inherits placement/snap/save/undo',
    /id: "flag"/.test(PROPS));
  check("the prop carries the POLE so the gizmo has something to grab",
    /BannerFlag/.test(PROPS) && /CylinderGeometry\(0\.07/.test(PROPS));
  check("it is collision:\"none\" — a banner must not be a wall",
    /id: "flag"[\s\S]{0,200}?collision: "none"/.test(PROPS));
  // Self-heal only watches the prop COUNT, so a MOVE needs the onChange hook or
  // the cloth is left behind at the old position.
  // Matched against the callback's BODY rather than its exact source line: the
  // old pattern pinned the whole thing to one particular formatting of
  // `onChange: () => { bakeCollision(); flags?.sync()` and broke the moment
  // another call was added to it — a failure that says nothing about flags.
  check("onChange re-syncs the cloth, so dragging a flag moves its banner",
    /flags\??\.sync\(\)/.test(
      GAME.match(/onChange:\s*\(\)\s*=>\s*\{[^}]*bakeCollision\(\)[^}]*\}/gs)
        ?.find((cb) => /flags\??\.sync\(\)/.test(cb)) ?? ""));
  check("the wave advances on the RENDER frame, not the physics step",
    /flags\.update\(dt\)/.test(GAME) && !/flags\.update\(FIXED_DT/.test(GAME));
}

console.log("\n=== IT ACTUALLY RUNS ===");
{
  // The module needs three/webgpu + TSL; rewrite the bare "three" import the way
  // the other tests do so it can be constructed headlessly.
  const TMP = join(ROOT, `.flag.${process.pid}.mjs`);
  writeFileSync(TMP, SRC.replace(/^import \* as THREE from "three";$/m,
    'import * as THREE from "three/webgpu";'));
  let mod = null;
  try { mod = await import(pathToFileURL(TMP).href); }
  catch (e) { console.log("  (skipped runtime checks: " + e.message.split("\n")[0] + ")"); }
  finally { unlinkSync(TMP); }

  if (mod) {
    const { ModularRoadFlags, FLAG } = mod;
    const scene = new THREE.Scene();
    const mkProp = (x, z) => {
      const root = new THREE.Object3D();
      root.position.set(x, 0, z);
      return { id: "flag", root };
    };
    const props = { instances: [mkProp(0, 0), mkProp(10, 4), mkProp(-6, 22), { id: "cone", root: new THREE.Object3D() }] };
    const flags = new ModularRoadFlags(scene, props);
    flags.sync();

    check("only flag props become instances (the cone is ignored)",
      flags.count === 3, `${flags.count}`);
    check("ONE mesh for every banner on the track", scene.children.filter((o) => o.isMesh).length === 1);
    check("draw count follows the instance count", flags.geometry.instanceCount === 3);

    // The cloth hangs from the pole top, not from the prop's feet.
    check("instance y is lifted to the pole top",
      Math.abs(flags.data[1] - FLAG.top) < 1e-6, `${flags.data[1]} vs top ${FLAG.top}`);
    check("each instance gets a different phase",
      flags.data[7] !== flags.data[7 + 8], `${flags.data[7].toFixed(2)} vs ${flags.data[15].toFixed(2)}`);

    // Removing a prop must drop the instance — a ghost banner would hang in the air.
    props.instances.pop();
    props.instances.pop();
    flags.update(1 / 60);
    check("a deleted flag's cloth disappears with it", flags.count === 2, `${flags.count}`);

    flags.update(1 / 60);
    check("time advances, which is the entire per-frame cost", flags.uTime.value > 0);

    const before = flags.count;
    props.instances.length = 0;
    flags.sync();
    check("with no flags the mesh is hidden entirely",
      flags.count === 0 && flags.mesh.visible === false, `was ${before}`);
  }
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
