// The shipping container: a GLB dropped in as a prop.
//
// Four things had to be got right, and three of them are silent failures — the
// model still appears, just wrong:
//
//   SIZE      the file is in arbitrary units and does not sit on its own origin
//   QUANTIZED applying a matrix to KHR_mesh_quantization geometry corrupts it
//   FOG       a GLB's MeshStandardMaterial freezes its fog in v3
//   COLLISION 1200 triangles of corrugation in the BVH, for a cuboid
//
// Measurements this pins down are in the module header and were taken with
// tools/glbInspect.mjs plus a load in the running page.
import { register } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { CONTAINER_SIZE, CONTAINER_LIVERIES, CONTAINER_URL } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadContainer.js")).href);
const { dequantize } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBatching.js")).href);

console.log("=== THE MODEL IS WHERE WE SAY IT IS ===");
{
  const path = join(ROOT, "public", CONTAINER_URL.replace(/^\//, ""));
  check("the GLB the module points at exists", existsSync(path), CONTAINER_URL);
}

console.log("\n=== SIZED AS A REAL 20 FT ISO CONTAINER ===");
{
  // 6.058 x 2.591 x 2.438 m. The model's own ratio is 2.44 : 1 : 1, which is a
  // 20 ft box (2.49 : 1.06 : 1) and not a 40 ft one — so this is the right
  // target, and the numbers are the standard's, not a guess.
  check("length is the ISO 20 ft length", Math.abs(CONTAINER_SIZE.length - 6.058) < 1e-6);
  check("height is the ISO height", Math.abs(CONTAINER_SIZE.height - 2.591) < 1e-6);
  check("width is the ISO width", Math.abs(CONTAINER_SIZE.width - 2.438) < 1e-6);
  // Exact ISO needs a PER-AXIS scale: one uniform factor off the length leaves it
  // 4% short and 2% wide, and a container's whole identity is being the size it
  // is — it has to stack and sit beside another one.
  const src = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadContainer.js"), "utf8");
  check("scaled per-axis, not uniformly",
    /CONTAINER_SIZE\.length \/ src\.x/.test(src)
    && /CONTAINER_SIZE\.height \/ src\.y/.test(src)
    && /CONTAINER_SIZE\.width \/ src\.z/.test(src));
  check("...and re-seated so it sits on y=0 and centres on its footprint",
    /-MODEL\.min\.y \* s\.y/.test(src) && /-mid\.x \* s\.x/.test(src));
}

console.log("\n=== QUANTIZED GEOMETRY IS EXPANDED BEFORE ANY MATRIX ===");
// KHR_mesh_quantization stores positions as normalized Int16 with the real scale
// folded into the node transform. BufferGeometry.applyMatrix4 writes its results
// straight back into that array — float truncated into Int16 — which mangles the
// mesh rather than failing. It bit here: a 6 m container came out 15 cm across.
{
  const g = new THREE.BufferGeometry();
  const raw = new Int16Array([32767, 0, 0, 0, 32767, 0, 0, 0, 32767]);
  g.setAttribute("position", new THREE.BufferAttribute(raw, 3, true));
  check("a normalized Int16 attribute is the case that breaks",
    g.attributes.position.normalized === true);

  dequantize(g);
  const p = g.attributes.position;
  check("dequantize hands back plain floats", p.array instanceof Float32Array && !p.normalized);
  check("...preserving the denormalized values", Math.abs(p.getX(0) - 1) < 1e-4, `${p.getX(0)}`);

  // The point of it: a matrix now survives.
  g.applyMatrix4(new THREE.Matrix4().makeScale(6, 6, 6));
  check("...so applyMatrix4 scales instead of truncating",
    Math.abs(g.attributes.position.getX(0) - 6) < 1e-3,
    `${g.attributes.position.getX(0)}`);

  const src = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadContainer.js"), "utf8");
  check("the container dequantizes before it transforms",
    src.indexOf("dequantize(o.geometry.clone())") < src.indexOf("g.applyMatrix4(o.matrixWorld)"));
}

console.log("\n=== A GLB'S MATERIALS CANNOT GO IN AS THEY ARE ===");
{
  const src = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadContainer.js"), "utf8");
  // Same fog freeze as the scenery: WebGPU only re-uploads a render object's
  // uniforms when its material carries a NODE property, and `scene.fogNode` is
  // not tracked. A container parked beside the track is exactly that case.
  check("rebuilt as a node material", /MeshStandardNodeMaterial/.test(src));
  check("...with a colorNode, which is what actually unfreezes the fog",
    /m\.colorNode = materialColor;/.test(src));
}

console.log("\n=== LIVERIES COST NOTHING ===");
{
  check("there are several", CONTAINER_LIVERIES.length >= 5, `${CONTAINER_LIVERIES.length}`);
  check("...all distinct", new Set(CONTAINER_LIVERIES).size === CONTAINER_LIVERIES.length);

  const src = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadContainer.js"), "utf8");
  // three MULTIPLIES instanceColor into the material colour
  // (NodeMaterial.setupDiffuseColor, "INSTANCED COLORS"), so leaving the shell
  // olive would filter every livery through it — blue would come out muddy green.
  check("the tintable parts are rebased to white so the tint IS the livery",
    /child\.material\.color\.setScalar\(1\)/.test(src));
  check("...and the door end keeps a fixed shade below the shell",
    /DOOR_SHADE/.test(src));

  const instancer = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadPropInstancer.js"), "utf8");
  check("colour goes through instanceColor — no extra material or draw",
    /m\.setColorAt\(i, c\)/.test(instancer) && /userData\.tintable/.test(instancer));
  // Matrices are rewritten every frame because props move; a livery is picked
  // once and then sits there.
  check("...and is only re-uploaded when it changes", /colorsDirty/.test(instancer));
  check("an untinted prop gets white, not black",
    /insts\[i\]\.tint \?\? _WHITE/.test(instancer));

  const props = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadProps.js"), "utf8");
  check("a new placement picks its own livery", /Math\.floor\(Math\.random\(\) \* def\.variants\.length\)/.test(props));
  check("...which survives save and load", /variant: inst\.variant/.test(props)
    && /setVariant\(inst, item\.variant \?\? 0\)/.test(props));
  // Old tracks must round-trip unchanged.
  check("...and props without variants add nothing to the file",
    /inst\.def\?\.variants\?\.length \? \{ variant: inst\.variant \} : \{\}/.test(props));
}

console.log("\n=== IT IS COLLIDED AS A BOX, BECAUSE IT IS ONE ===");
{
  const src = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadContainer.js"), "utf8");
  // 1200 triangles of corrugation went into BOTH the deck and solids BVH —
  // measured at 192,000 collision triangles for a 40-container yard, for a shape
  // a car cannot tell from a cuboid. The proxy is 12 triangles.
  check("the visible shell is kept OUT of the bake",
    /child\.userData\.noCollide = true;/.test(src));
  check("...replaced by a box proxy at the container's real size",
    /new THREE\.BoxGeometry\(\s*CONTAINER_SIZE\.length, CONTAINER_SIZE\.height, CONTAINER_SIZE\.width/.test(src));
  check("...which is invisible and never drawn or instanced",
    /proxy\.visible = false;/.test(src) && /proxy\.userData\.noRender = true;/.test(src));

  const props = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadProps.js"), "utf8");
  const entry = props.slice(props.indexOf('id: "container"'), props.indexOf('id: "box"'));
  check('collision is "both" — a wall to hit and a roof to land on',
    /collision: "both"/.test(entry));
}

console.log("\n=== THE LIVERY IS REACHABLE, NOT JUST IMPLEMENTED ===");
// A variant nobody can see or change is a data field, not a feature. This was
// exactly the gap: liveries were assigned and serialised with no way to pick one.
{
  const props = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadProps.js"), "utf8");
  const panel = readFileSync(join(ROOT, "games/modular-road-v3/devPanel.js"), "utf8");
  const game = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");

  check("a key cycles the selection's livery", /case "KeyC":/.test(props));
  check("...both ways", /e\.shiftKey \? -1 : 1/.test(props));
  check("swatches are drawn from the SELECTED prop's own palette",
    /function renderLiveries/.test(panel) && /game\.getSelectedProp\?\.\(\)/.test(panel));
  check("...and a prop with no liveries says so rather than showing an empty row",
    /no liveries/.test(panel));
  check("there is a re-roll for the whole type", /randomisePropVariants/.test(panel));
  check("the game exposes selection + setter to the panel",
    /getSelectedProp:/.test(game) && /setPropVariant:/.test(game));

  // The panel has to follow the selection, and `onSelect` fires BEFORE the
  // selection is assigned (its job is clearing the other gizmos), so it would
  // always render the previous prop.
  check("the panel refreshes AFTER the selection settles, not during onSelect",
    /this\.onSelectionChange\?\.\(inst\);/.test(props)
    && /onSelectionChange: \(\) => devPanel\?\.refresh\(\)/.test(game));
  check("...including on deselect", /if \(had\) this\.onSelectionChange\?\.\(null\);/.test(props));
  // Changing a livery has to reach the instance colour buffer.
  check("a livery change marks the instance colours dirty",
    /props\.onVariantChange = \(\) => \{ propInstancer\.markColorsDirty\(\)/.test(game));
}

console.log("\n=== CONTAINERS STACK ONTO EACH OTHER ===");
{
  const props = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadProps.js"), "utf8");
  const game = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");
  check("the container declares its footprint and course height",
    /stack: CONTAINER_SIZE/.test(props));
  // Snapping to the SUPPORTING PROP rather than a world grid is what makes a
  // rotated stack line up as well as an axis-aligned one.
  check("placement snaps to the prop underneath, copying its rotation",
    /stackSnap\(typeId, point\)/.test(props) && /quaternion: best\.inst\.root\.quaternion\.clone\(\)/.test(props));
  check("...tested inside that prop's own frame, so rotation does not break it",
    /_stackQuat\.copy\(inst\.root\.quaternion\)\.invert\(\)/.test(props));
  check("...and the highest roof wins, so a tower keeps going up",
    /if \(!best \|\| top > best\.top\)/.test(props));
  check("the placement brush uses it", /props\.stackSnap\(brush\.id, brush\.point\)/.test(game));
}

console.log("\n=== THE PALETTE TILE HAS A REAL THUMBNAIL ===");
{
  const game = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");
  // The bake calls make() once per catalog entry and skips whatever comes back
  // empty. The container's make() needs the GLB, so loading it afterwards left
  // it as the one tile with a hand-drawn fallback.
  check("the model is loaded BEFORE the thumbnails are baked",
    game.indexOf("await preloadContainer()") < game.indexOf("bakeRoadThumbnails("));
  check("...and awaited, not fired and forgotten",
    /await preloadContainer\(\);/.test(game));
}

console.log("\n=== A MISSING MODEL MUST NOT TAKE THE EDITOR DOWN ===");
{
  const src = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadContainer.js"), "utf8");
  check("a load failure warns and resolves rather than rejecting",
    /console\.warn\(/.test(src) && /resolve\(null\)/.test(src));
  // Resolving instead of rejecting is what keeps startup going: the load is
  // AWAITED before thumbnails, so a rejection there would take the whole editor
  // down over one missing decoration.
  check("...so an await of it can never throw", /resolve\(null\)/.test(src)
    && !/reject\(/.test(src));
  check("makeContainer still hands back a group when nothing loaded",
    /if \(_template\) for \(const c of _template\.children\)/.test(src));
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
