// PER-PASS INSTANCED CULLING — a city mesh is skipped in a pass whose camera
// holds none of its instances, small casters cast only a near prefix, and the
// far cascade can run at half rate.
//
// Two halves:
//   1. modularRoadPassCull.js exercised for real against a stand-in renderer:
//      what is skipped, what is drawn, what is trimmed in shadow passes (and
//      restored after), what may not be enrolled at all;
//   2. the wiring pinned against the source: enrolment on build and rebuild,
//      the owners publishing `shadowCount`, the half-rate flag written both
//      ways (three never clears it after a render), the dev switches.
//
// Run: node tools/passCullTest.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import * as THREE from "three";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const GAME = read("games/modular-road-v3/roadGame.js");
const FURN = read("games/modular-road-v3/modularRoadCityFurniture.js");
const MOUNTS = read("games/modular-road-v3/modularRoadCityMounts.js");
const PANEL = read("games/modular-road-v3/devPanel.js");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

const { installPassCull } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadPassCull.js")).href);

console.log("\n═══ PER-PASS CULLING ═══\n");

/** A renderer with just what the culler touches. `calls` log what was drawn. */
function fakeRenderer() {
  const r = {
    info: { calls: 0 },
    drawn: [],
    _fn: null,
    getRenderObjectFunction() { return this._fn; },
    renderObject(object, scene, camera) { this.drawn.push({ object, camera, count: object.count }); },
  };
  return r;
}
const SHADOW_FN = Object.assign(() => {}, { shadowType: 1 });

function meshAt(points, material = new THREE.MeshBasicMaterial()) {
  const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, points.length);
  im.frustumCulled = false;
  const m = new THREE.Matrix4();
  points.forEach(([x, y, z], i) => im.setMatrixAt(i, m.makeTranslation(x, y, z)));
  return im;
}

// Main camera at the origin looking down -Z.
const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
cam.coordinateSystem = THREE.WebGPUCoordinateSystem;
cam.updateProjectionMatrix();
cam.updateMatrixWorld();
cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

// A "cascade": orthographic, 20 m square, centred on x = 100, looking down.
const sh = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 50);
sh.coordinateSystem = THREE.WebGPUCoordinateSystem;
sh.position.set(100, 30, 0);
sh.lookAt(100, 0, 0);
sh.updateProjectionMatrix();
sh.updateMatrixWorld();
sh.matrixWorldInverse.copy(sh.matrixWorld).invert();

console.log("=== MAIN PASS ===");
{
  const r = fakeRenderer();
  const pc = installPassCull(r);
  const front = meshAt([[0, 0, -20], [50, 0, 40]]);
  const behind = meshAt([[0, 0, 20], [5, 0, 60]]);
  const edge = meshAt([[0, 0, 30], [-11.8, 0, -20]]);   // just outside the left plane, inside the pad
  const loose = meshAt([[0, 0, 20]]);                    // never enrolled
  for (const m of [front, behind, edge]) pc.enroll(m);
  for (const m of [front, behind, edge, loose]) r.renderObject(m, null, cam);
  const drew = (m) => r.drawn.some((d) => d.object === m);
  check("a mesh with ANY instance in view is drawn", drew(front));
  check("a mesh with every instance behind the camera is skipped", !drew(behind), `skipped ${pc.stats.skipped}`);
  check("the radius and pad keep a mesh grazing the frustum", drew(edge));
  check("an unenrolled mesh is never touched", drew(loose));

  pc.state.enabled = false;
  r.drawn.length = 0;
  r.renderObject(behind, null, cam);
  check("switched off, everything goes through", drew(behind));
  pc.state.enabled = true;

  // Moving the instances must invalidate the cached answer.
  r.info.calls++;
  behind.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 0, -40));
  behind.instanceMatrix.needsUpdate = true;
  r.drawn.length = 0;
  r.renderObject(behind, null, cam);
  check("rewritten matrices are re-tested, not answered from cache", drew(behind));

  const displaced = meshAt([[0, 0, 20]]);
  displaced.material.positionNode = {};
  check("a GPU-displaced material is refused (its CPU bounds would lie)", !pc.enroll(displaced));
  const culledByThree = meshAt([[0, 0, 20]]);
  culledByThree.frustumCulled = true;
  check("a mesh three already frustum-culls is refused", !pc.enroll(culledByThree));
}

console.log("\n=== SHADOW PASS ===");
{
  const r = fakeRenderer();
  const pc = installPassCull(r);
  r._fn = SHADOW_FN;
  const inside = meshAt([[300, 0, 0], [102, 0, 3]]);
  const outside = meshAt([[0, 0, -20]]);                // in the MAIN view, not in this cascade
  const high = meshAt([[100, 200, 0]]);                 // above the cascade's near plane
  for (const m of [inside, outside, high]) pc.enroll(m);
  for (const m of [inside, outside, high]) r.renderObject(m, null, sh);
  const drew = (m) => r.drawn.some((d) => d.object === m);
  check("a caster inside the cascade is drawn", drew(inside));
  check("a caster outside the cascade is skipped, though the main camera sees it", !drew(outside));
  check("only the SIDE planes cull a cascade: a caster above its near plane still casts", drew(high));

  // shadowCount: the first N instances, and `count` restored afterwards.
  const small = meshAt([[101, 0, 0], [99, 0, 1], [100, 0, -2], [98, 0, 4]]);
  pc.enroll(small);
  small.userData.shadowCount = 2;
  r.drawn.length = 0;
  r.renderObject(small, null, sh);
  check("a shadow pass draws only the published shadowCount", r.drawn[0]?.count === 2, `drew ${r.drawn[0]?.count}`);
  check("...and gives the mesh its full count back", small.count === 4);

  small.userData.shadowCount = 0;
  r.drawn.length = 0;
  r.info.calls++;
  r.renderObject(small, null, sh);
  check("shadowCount 0 casts nothing", r.drawn.length === 0);

  r._fn = null;
  r.drawn.length = 0;
  r.renderObject(small, null, sh);
  check("the MAIN pass ignores shadowCount", r.drawn[0]?.count === 4);

  pc.state.shadowCounts = false;
  r._fn = SHADOW_FN;
  small.userData.shadowCount = 1;
  r.drawn.length = 0;
  r.info.calls++;
  r.renderObject(small, null, sh);
  check("the short-shadow switch off casts the full count", r.drawn[0]?.count === 4);

  // Only the first shadowCount instances decide visibility.
  pc.state.shadowCounts = true;
  const farTail = meshAt([[0, 0, 0], [100, 0, 0]]);    // the one in the cascade is past the prefix
  pc.enroll(farTail);
  farTail.userData.shadowCount = 1;
  r.drawn.length = 0;
  r.info.calls++;
  r.renderObject(farTail, null, sh);
  check("visibility is tested on the cast prefix only", r.drawn.length === 0);
}

console.log("\n=== THE WIRING ===");
{
  check("the game installs the culler on its renderer", /const passCull = installPassCull\(renderer\);/.test(GAME));
  check("the city is enrolled when it is built", /scene\.add\(city\.group\);\s*enrollCityPassCull\(\);/.test(GAME));
  check("...and again on every rebuild (new meshes)", /_cityRainSurfaces = surfaces;[\s\S]{0,120}enrollCityPassCull\(\);/.test(GAME));
  check("far half-rate writes needsUpdate BOTH ways (three never clears it after a render)",
    /far\.needsUpdate = _farFlip === 1;/.test(GAME));
  check("...and hands the cascade back to autoUpdate when off", /if \(!far\.autoUpdate\) far\.autoUpdate = true;/.test(GAME));
  check("far half-rate defaults OFF", /let farCascadeHalfRate = false;/.test(GAME));
  check("both handles expose the three switches",
    (GAME.match(/setFarCascadeHalfRate: \(on\) =>/g) || []).length === 2 &&
    (GAME.match(/setPassCull: \(on\) =>/g) || []).length === 2 &&
    (GAME.match(/setShortSmallShadows: \(on\) =>/g) || []).length === 2);
  check("the dev panel has the three toggles",
    ["dv-pass-cull", "dv-small-shadows", "dv-far-half"].every((id) => PANEL.includes(`id="${id}"`) && PANEL.includes(`"${id}"`)));

  check("furniture partitions the shadow range FIRST inside the drawn prefix",
    /k\.mesh\.userData\.shadowCount = ns;/.test(FURN) && /const sr = k\.small \? \(F\.smallShadowRange \?\? 0\) : 0;/.test(FURN));
  const smallKinds = (FURN.match(/small: true/g) || []).length;
  check("five small furniture kinds cast short (barriers, bins, blocks, benches, signs)", smallKinds === 5, `${smallKinds}`);
  check("parked cars and tree canopies are NOT short", !/carMeshes\.map[^\n]*small: true/.test(FURN) && !/canopyMesh[^\n]*small: true/.test(FURN));
  check("mounts publish a shadow prefix for all four meshes",
    ["acMesh", "balMesh", "escLandMesh", "escStairMesh"].every((m) => new RegExp(`setShadow\\(${m},`).test(MOUNTS)));
}

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
