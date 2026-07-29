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
const { CONTAINER_SIZE, CONTAINER_SCALE, CONTAINER_LIVERIES, CONTAINER_URL } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadContainer.js")).href);
const { dequantize } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBatching.js")).href);

console.log("=== THE MODEL IS WHERE WE SAY IT IS ===");
{
  const path = join(ROOT, "public", CONTAINER_URL.replace(/^\//, ""));
  check("the GLB the module points at exists", existsSync(path), CONTAINER_URL);
}

console.log("\n=== ISO PROPORTIONS, SCALED UP FOR THE GAME ===");
{
  // The model's own ratio is 2.44 : 1 : 1, which is a 20 ft box (2.48 : 1.06 : 1)
  // and not a 40 ft one (5 : 1.06 : 1) — so 20 ft PROPORTIONS are the target.
  const ISO = { length: 6.058, height: 2.591, width: 2.438 };
  for (const k of ["length", "height", "width"]) {
    check(`${k} keeps the ISO proportion`,
      Math.abs(CONTAINER_SIZE[k] - ISO[k] * CONTAINER_SCALE) < 1e-9,
      `${CONTAINER_SIZE[k].toFixed(2)} = ${ISO[k]} x ${CONTAINER_SCALE}`);
  }

  // WHY IT IS SCALED AT ALL. At true size a 20 ft container is 6.06 x 2.59 m
  // against a 4.97 x 1.26 m car — 1.22x its length and 1.05x its width, so parked
  // beside each other they read as roughly the same object. Accurate, and wrong:
  // what "shipping container" means to anyone looking at it is the big one.
  const CAR = { length: 4.97, height: 1.26, width: 2.32 };
  check("it is clearly longer than the car, not merely comparable",
    CONTAINER_SIZE.length / CAR.length > 1.5,
    `${(CONTAINER_SIZE.length / CAR.length).toFixed(2)}x (true ISO would be 1.22x)`);
  check("...and towers over it",
    CONTAINER_SIZE.height / CAR.height > 2.5,
    `${(CONTAINER_SIZE.height / CAR.height).toFixed(2)}x`);

  const src = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadContainer.js"), "utf8");
  // UNIFORM, not a stretch: taking it to 40 ft length instead would double the
  // corrugation rib spacing and read as coarse up close.
  check("the scale is uniform, so silhouette and rib spacing stay right",
    /length: ISO_20FT\.length \* CONTAINER_SCALE/.test(src)
    && /height: ISO_20FT\.height \* CONTAINER_SCALE/.test(src)
    && /width: ISO_20FT\.width \* CONTAINER_SCALE/.test(src));
  // ...on top of a PER-AXIS normalisation, because one factor off the model's
  // length leaves the proportions 4% short and 2% wide.
  check("...over a per-axis normalisation of the model",
    /CONTAINER_SIZE\.length \/ src\.x/.test(src)
    && /CONTAINER_SIZE\.height \/ src\.y/.test(src)
    && /CONTAINER_SIZE\.width \/ src\.z/.test(src));
  check("...and re-seated so it sits on y=0 and centres on its footprint",
    /-MODEL\.min\.y \* s\.y/.test(src) && /-mid\.x \* s\.x/.test(src));
  // ONE number to tune. Otherwise the collider, the stack height and the decal
  // placement drift away from what is drawn.
  check("collider, stack and decal all derive from CONTAINER_SIZE",
    /BoxGeometry\(CONTAINER_SIZE\.length, CONTAINER_SIZE\.height, CONTAINER_SIZE\.width\)/.test(src));
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

console.log("\n=== THE DECAL IS A QUAD, NOT A SECOND MAP ===");
// A per-container `map` means a per-container material means a draw call each —
// forty containers would go from 4 draws to 160. The sticker is its own shared
// instanced quad instead: ONE extra draw for the whole track.
{
  const decals = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadDecals.js"), "utf8");
  const props = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadProps.js"), "utf8");
  const instancer = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadPropInstancer.js"), "utf8");

  check("the container declares faces rather than carrying a texture",
    /decal: \{[\s\S]*?url: DECAL_URL/.test(props) && /faces: \[/.test(props));
  check("the decal texture is shared per URL, not per prop",
    /_materials\.has\(url\)/.test(decals) && /_materials\.set\(url, m\)/.test(decals));

  // THE ALPHA TRAP. `colorNode = materialColor` is the fog fix used everywhere
  // in v3, and on a cut-out it silently breaks alphaTest: setupDiffuseColor does
  // vec4(vec3) so the alpha becomes 1 and nothing is discarded — the logo would
  // render as an opaque square.
  check("alpha comes from opacityNode, because colorNode would force it to 1",
    /m\.opacityNode = tslTexture\(tex\)\.a;/.test(decals) && /m\.alphaTest = 0\.5;/.test(decals));
  check("...and the fog fix is still applied alongside it",
    /m\.colorNode = materialColor;/.test(decals));

  // A quad flat on a wall is the textbook z-fight, and a physical offset alone
  // only moves the distance at which it starts (the swing gate's stripe).
  check("z-fighting is held off by a depth bias, not just an offset",
    /m\.polygonOffset = true;/.test(decals) && /DECAL_OFFSET/.test(decals));

  // Fixed stride: faces.length instances per prop whether it wears one or not.
  // A compacted list would remap every index on every toggle.
  check("undecorated props get a zero-scaled instance, not a rebuilt buffer",
    /im\.setMatrixAt\(k\+\+, _ZERO\)/.test(instancer));
  check("...and the batch is keyed apart from the prop's own",
    /`\$\{id\}::decal`/.test(instancer));
  check("...so the type-cleanup pass does not tear it down every sync",
    /if \(batch\.decal \|\| wanted\.has\(id\)\) continue;/.test(instancer));
  check("a flat sticker does not cast a shadow", /im\.castShadow = false;/.test(instancer));

  // EVERY decal number derived from CONTAINER_SIZE. The height and patch size
  // were literals sized against the unscaled box, so raising CONTAINER_SCALE
  // left the logo 0.56 m below centre and proportionally too small — the wall
  // grew and the sticker did not.
  check("the decal is centred on the wall at any scale",
    /pos: \[0, CONTAINER_SIZE\.height \/ 2, CONTAINER_SIZE\.width \/ 2 \+ DECAL_OFFSET\]/.test(props));
  check("...on both faces", /-\(CONTAINER_SIZE\.width \/ 2 \+ DECAL_OFFSET\)/.test(props));
  check("...and its size scales with the wall too",
    /size: \[CONTAINER_SIZE\.height \* 0\.58, CONTAINER_SIZE\.height \* 0\.58\]/.test(props));
  check("...with nothing about it hardcoded", !/pos: \[0, 1\.32,/.test(props)
    && !/size: \[1\.5, 1\.5\]/.test(props));

  check("which containers wear one is saved with the track",
    /\.\.\.\(inst\.decal \? \{ decal: true \} : \{\}\)/.test(props)
    && /inst\.decal = !!item\.decal;/.test(props));
  // OFF by default: branding is a decision, and a random scatter is not
  // authorable — you cannot tell what you asked for from what the dice gave you.
  check("...and NONE are decalled by default",
    /inst\.decal = false;/.test(props) && !/Math\.random\(\) < 0\.45/.test(props));

  const panel = readFileSync(join(ROOT, "games/modular-road-v3/devPanel.js"), "utf8");
  const game = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");
  check("there is a toggle for it, and a key", /dv-decal/.test(panel) && /case "KeyV":/.test(props));
  check("...hidden for props that have no decal at all",
    /sel\?\.hasDecal \? "" : "none"/.test(panel));
  check("the game exposes it to the panel", /setPropDecal:/.test(game) && /hasDecal:/.test(game));

  // decalMaterial() is synchronous — the instancer calls it while building a
  // batch — so the texture must already be in hand or the batch is skipped.
  check("the texture is settled before anything can be drawn",
    /await Promise\.all\(\[[\s\S]*?settleDecals\(\)/.test(game));
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
    /await Promise\.all\(\[\s*\n\s*preloadContainer\(\),/.test(game));
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
