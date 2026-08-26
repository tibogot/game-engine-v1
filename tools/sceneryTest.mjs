// Roadside scenery ported from the v2 objects lab into the road builder.
//
// Three things go wrong when a lab object is dropped into v3 unchanged, and all
// three are silent — nothing throws, you just get a worse-looking, slower game:
//
//  • FOG FREEZES. three's WebGPU backend only re-uploads a render object's
//    uniforms when the material carries a NODE property (or the mesh moved).
//    Scene-level uniforms behind `scene.fogNode` are not tracked, so a plain
//    MeshStandardMaterial on a mast that never moves keeps whatever fog it first
//    rendered with, forever, while the track around it updates.
//  • EMISSIVE DOESN'T GLOW. v3's bloom is selective and reads an MRT buffer;
//    the lab bloomed the whole scene's bright pixels, so `emissiveIntensity`
//    alone was enough there and does nothing here.
//  • SHADERS RECOMPILE PER PLACEMENT. Calling a builder per placed prop builds
//    fresh materials each time, and the LED panel shader is not cheap.
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

// Resolve `three` the way vite does, so this loads the REAL scenery module and
// the REAL node materials rather than a text-rewritten copy with the awkward
// parts stubbed out. Half of what is under test here IS the material classes.
register("./threeWebgpuHook.mjs", import.meta.url);
const { SCENERY_CATALOG, makeSceneryProp } =
  await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadScenery.js")).href);

const meshesOf = (o) => { const a = []; o.traverse((c) => { if (c.isMesh) a.push(c); }); return a; };
/**
 * Meshes that actually DRAW.
 *
 * The fog-freeze rule below is about rendering: three's WebGPU backend refuses
 * to re-upload a static object's uniforms unless its material carries a node,
 * so a plain material on something that never moves keeps its first frame's fog
 * forever. An INVISIBLE mesh has no frames to keep. The run objects' collision
 * wall is one of those, and holding it to a rendering rule would mean handing a
 * shader to a box that exists only for the BVH.
 */
const drawnMeshesOf = (o) => meshesOf(o).filter((m) => m.visible);

console.log("=== EVERY SCENERY TYPE BUILDS ===");
for (const def of SCENERY_CATALOG) {
  const g = makeSceneryProp(def.id);
  check(`"${def.id}" builds`, !!g && meshesOf(g).length > 0,
    g ? `${meshesOf(g).length} meshes` : "null");
}
check("an unknown id returns null rather than throwing", makeSceneryProp("nope") === null);

console.log("\n=== NOTHING STATIC KEEPS A PLAIN MATERIAL (THE FOG FREEZE) ===");
{
  let plain = 0, total = 0;
  const offenders = [];
  for (const def of SCENERY_CATALOG) {
    for (const m of drawnMeshesOf(makeSceneryProp(def.id))) {
      total++;
      // `isNodeMaterial` is the flag the backend's observer actually keys off.
      if (!m.material?.isNodeMaterial) { plain++; offenders.push(`${def.id}/${m.name || m.type}`); }
    }
  }
  check("every scenery material is a NODE material", plain === 0,
    plain ? offenders.join(", ") : `${total} meshes`);

  // hasNode is what flips the observer to "always refresh" — a node material
  // with no node property assigned is still frozen, so the class alone is not
  // enough and the colorNode is the actual fix.
  let noNode = 0;
  for (const def of SCENERY_CATALOG) {
    for (const m of drawnMeshesOf(makeSceneryProp(def.id))) {
      const has = !!(m.material.colorNode || m.material.fragmentNode
        || m.material.positionNode || m.material.outputNode || m.material.mrtNode);
      if (!has) noNode++;
    }
  }
  check("...and each carries a node property, not just the node class", noNode === 0,
    `${noNode} materials would still freeze`);
}

console.log("\n=== PLACEMENTS SHARE, THEY DO NOT REBUILD ===");
{
  const a = makeSceneryProp("floodlight");
  const b = makeSceneryProp("floodlight");
  check("two placements are separate objects", a !== b);
  const ma = meshesOf(a), mb = meshesOf(b);
  check("...with the same mesh count", ma.length === mb.length);
  // The whole optimisation: shared material => ONE shader compile for the type,
  // shared geometry => one upload, however many you place.
  const sharedMat = ma.every((m, i) => m.material === mb[i].material);
  const sharedGeo = ma.every((m, i) => m.geometry === mb[i].geometry);
  check("...sharing every material by reference", sharedMat);
  check("...and every geometry by reference", sharedGeo);

  // And within a single unit the builders' own material sharing must survive the
  // conversion — converting per MESH instead of per SOURCE material would
  // silently multiply the compiles again.
  for (const def of SCENERY_CATALOG) {
    const g = makeSceneryProp(def.id);
    const mats = new Set(meshesOf(g).map((m) => m.material));
    check(`"${def.id}" uses few materials, not one per mesh`,
      mats.size <= meshesOf(g).length, `${mats.size} materials / ${meshesOf(g).length} meshes`);
  }
}

console.log("\n=== DRAW-CALL COST PER PLACEMENT ===");
// Not a pass/fail budget — a number to look at before placing forty of them.
// Scenery is not merged or instanced ACROSS props (each is placed and moved
// independently in the editor), so this is what each one costs on screen.
{
  let worst = 0;
  for (const def of SCENERY_CATALOG) {
    const g = makeSceneryProp(def.id);
    const meshes = meshesOf(g);
    const inst = meshes.filter((m) => m.isInstancedMesh).length;
    worst = Math.max(worst, meshes.length);
    console.log(`  ${def.id.padEnd(12)} ${String(meshes.length).padStart(2)} draws`
      + `  (${inst} instanced)`
      + `  ${new Set(meshes.map((m) => m.material)).size} materials`);
  }
  check("no scenery type is more than a handful of draws", worst <= 5, `worst ${worst}`);
}

console.log("\n=== NOTHING BLOCKS THE DRIVE-MODE MERGE ===");
// Per-placement draws only matter so much: what actually ships is drive mode,
// where roadGame merges every static prop by material into a handful of meshes.
// Two things silently opt a prop out of that, and both were hit here.
{
  for (const def of SCENERY_CATALOG) {
    const g = makeSceneryProp(def.id);
    let instanced = 0;
    g.traverse((o) => { if (o.isInstancedMesh) instanced++; });
    // An InstancedMesh keeps its transforms in a buffer the merge cannot bake,
    // so it is skipped and stays its own draw forever. The lab builders instance
    // because THEY stamp a whole spline run per call; one placement is one unit,
    // so instancing here buys nothing and costs the merge.
    check(`"${def.id}" has no InstancedMesh left to block merging`, instanced === 0,
      instanced ? `${instanced} instanced meshes` : "flattened");
  }

  const game = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");
  const batching = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadBatching.js"), "utf8");
  check("scenery is drawn through the shared prop instancer",
    /new PropInstancer\(scene, props, PROP_CATALOG,/.test(game));
  // Keying the merge on material IDENTITY merges almost nothing, because every
  // prop's make() builds its own material objects — twenty poles are twenty
  // distinct-but-identical materials. Measured: poles stayed at 8.0 draws each
  // until this keyed on the signature instead, then fell to 0.4.
  check("...keyed on what a material RENDERS as, not its identity",
    /export function materialKey/.test(batching) && /m\.color\?\.getHexString/.test(batching));
  // A material with its own shader graph can match on every plain property and
  // still render nothing alike — so it is held back to identity unless it
  // explicitly declares its graph batchable (see propInstancerTest for why that
  // escape hatch has to exist). The LED panel must NOT declare it: its board
  // dimensions are per-material uniforms the signature cannot see.
  check("...with custom shader graphs held back to identity by default",
    /if \(custom && !m\.userData\?\.batchKey\) return m\.uuid;/.test(batching));
  const scenerySrc = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadScenery.js"), "utf8");
  check("...and the LED panel never opts in — its uniforms are per-board",
    !/batchKey/.test(scenerySrc));
  // The signature key is what makes the instancing templates collapse a prop's
  // own sub-meshes — a billboard's four materials rather than its ten boxes.
  check("...and it is what mergeByMaterial groups on",
    /materialKey\(o\.material\)/.test(batching));
}

console.log("\n=== MASTS AND LEGS ARE CAPSULES ===");
// These are round and thin — the exact case the chassis hull's triangle sampling
// cannot see (tools/postColliderRepro.mjs). They must not rely on the mesh bake.
for (const def of SCENERY_CATALOG) {
  const g = makeSceneryProp(def.id);
  const caps = [];
  let wall = null;
  g.traverse((o) => {
    if (o.userData?.capsule) caps.push(o);
    if (o.name === "SceneryWall") wall = o;
  });
  // TWO LEGAL ANSWERS, and which is right depends on the shape.
  //   A POINT object (lamp, board, floodlight) declares capsules on its masts.
  //   A RUN object (fence, wire) declares one thin solid wall down the line,
  //   because capsules dense enough to stop a car along 24 m would be twenty
  //   primitives, and the three you would actually write leave 8 m holes in a
  //   fence, which is worse than no collider: it looks like it should stop you.
  check(`"${def.id}" declares a collider`, caps.length > 0 || !!wall,
    caps.length ? `${caps.length} capsule(s)` : wall ? "solid wall" : "NONE");
  check(`  ...and as many capsules as the def asked for`,
    caps.length === (def.capsules?.length ?? 0), `${caps.length}`);
  check(`  ...each with a real radius and height`,
    caps.every((c) => c.userData.capsule.radius > 0 && c.userData.capsule.height > 0));
  // The marker sits at the capsule's MID-HEIGHT, because collisionCapsules()
  // builds the axis symmetrically about the marker's world position.
  check(`  ...sitting at mid-height so the capsule spans the ground up`,
    caps.every((c) => Math.abs(c.position.y - c.userData.capsule.height / 2) < 1e-6));
  if (def.solidWall) {
    // The wall has to be the ONLY thing left in the solid bake. A chain-link
    // curtain quad in there is a collider the hull walks straight through, and
    // 9k triangles of barbed wire is a bake nobody should be paying for.
    let collidable = 0;
    g.traverse((o) => { if (o.isMesh && !o.userData.noCollide && !o.userData.capsule) collidable++; });
    check(`  ...with the wall as the only mesh left in the solid bake`,
      collidable === 1, `${collidable}`);
    check(`  ...standing on the ground rather than centred on it`,
      Math.abs(wall.position.y - def.solidWall.height / 2) < 1e-6);
  }
}

console.log("\n=== THE CATALOG WIRES INTO THE PALETTE ===");
{
  const props = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadProps.js"), "utf8");
  check("scenery is spread into PROP_CATALOG, so it saves/loads like any prop",
    /\.\.\.SCENERY_CATALOG\.map/.test(props));
  check("...tagged into its own palette tab", /category: "scenery"/.test(props));
  const builder = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js"), "utf8");
  check("the palette has a Scenery category", /id: "scenery", label: "Scenery"/.test(builder));
  // Defaulting means adding a prop needs no edit in the builder at all.
  check("props with no category still land in Obstacles",
    /p\.category \?\? "obstacles"/.test(builder));
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
