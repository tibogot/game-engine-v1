// What one second of dragging a gizmo costs the builder, on a real track.
//
// CPU only — the InstancedMesh churn this also removes is a GPU-side cost that
// does not show up here at all, so treat the number as a floor.
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { ModularRoadBuilder } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);

const file = process.argv[2] ?? "games/modular-road-v3/rushline.json";
const track = JSON.parse(readFileSync(join(ROOT, file), "utf8"));

const scene = new THREE.Scene();
const mat = () => new THREE.MeshBasicMaterial();
const b = new ModularRoadBuilder({
  scene,
  roadMaterial: mat(), railMaterial: mat(), shellMaterial: mat(),
  decorMaterial: mat(), glassMaterial: mat(), tubeMaterial: mat(),
  isBuildMode: () => true,
});
b.setInstancing(true);
b.importTrackPieces(track.pieces);

// The ghost sits on whatever the palette last selected — bench the cheap case
// (a straight) and the expensive one (a loop), since that choice used to decide
// whether a drag ran at 60 fps or at 90.
for (const ghost of ["straight", "loop"]) {
  b.setActivePiece(ghost);
  b.rebuildAll({ reuse: true });          // warm

  const FRAMES = 60;
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    b.chains[0].anchor = new THREE.Matrix4().setPosition(f * 0.05, 0, 0);
    b.rebuildAll({ reuse: true });        // exactly what the gizmo's `change` does
  }
  const ms = (performance.now() - t0) / FRAMES;
  console.log(
    `${track.pieces.length} pieces, ghost = ${ghost.padEnd(9)}  ` +
    `${ms.toFixed(2)} ms/frame   (${(1000 / ms).toFixed(0)} fps ceiling from this alone)`,
  );
}
