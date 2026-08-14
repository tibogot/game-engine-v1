// Glass road — a lacquered straight with a square window you drive over.
//
// The whole trick is that ONE piece hands out two different decks and they must
// disagree in exactly one way:
//
//   the deck you SEE      has a hole punched clean through the slab, so you can
//                         look down through it (and up through it from below);
//   the deck you DRIVE    has no hole at all. It goes to the BVH as
//                         `deckCollision`, the same stand-in mechanism the half
//                         tubes use for their rim caps.
//
// Get that backwards — or let the two drift apart in size — and the piece either
// swallows the car through a window that is supposed to be solid, or shows a
// pane with a hole around it. Both are one edited constant away, so both are
// asserted here by dropping a wheel ray through the middle of the window.
//
// The second thing under test is FLICKER, for the same reason the hole walls
// have a coplanar-face sweep: the pane sits inside a hole in a slab, which is
// three surfaces trying to occupy the same neighbourhood. The pane is recessed
// and oversize precisely so none of them are coplanar, and those margins are
// numbers that survive only as long as somebody checks them.
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER_SRC = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js"), "utf8");
const MAT_SRC = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadMaterial.js"), "utf8");
const GAME_SRC = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");
const THUMB_SRC = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadThumbnails.js"), "utf8");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

const {
  PIECE_BY_ID, pieceParams, roadParams,
  buildGlassDeckGeometry, buildGlassPaneGeometry,
} = await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);

const PP = { ...pieceParams, glassLength: 32, glassWidth: 16, glassHole: 9 };
const RP = roadParams;
const HALF = PP.glassHole / 2; // 4.5 m
const CZ = -PP.glassLength / 2;

/* ══ The piece ════════════════════════════════════════════════════════════ */
console.log("— piece definition —");
const def = PIECE_BY_ID.get("glass_road");
check("glass_road is in the catalog", !!def);
check("it authors its own geometry (a hole is not expressible as a sweep)",
  typeof def?.geometry === "function");
check("it hands the BVH its own deck stand-in", typeof def?.deckCollision === "function");
check("it has a glazing channel", typeof def?.glass === "function");
check("no kerbs or paint lines on a lacquered panel",
  def?.noKerb === true && def?.plain === true);

/* ══ Seen vs driven ═══════════════════════════════════════════════════════ */
console.log("\n— the window is a hole to look through, not to fall through —");
const seen = def.geometry(PP, RP);
const driven = def.deckCollision(PP, RP);
const pane = def.glass(PP, RP);

// Geometry positions are float32, so "equal" here means equal to a hundredth of
// a millimetre, not bit-identical: 0.8 comes back as 0.800000011920929.
const close = (a, b, eps = 1e-5) => Math.abs(a - b) < eps;
const meshOf = (g) => { const m = new THREE.Mesh(g); m.updateMatrixWorld(true); return m; };
const ray = new THREE.Raycaster();
const down = new THREE.Vector3(0, -1, 0);
/** Where a wheel ray dropped at (x, z) lands, or null. */
const dropAt = (geo, x, z) => {
  ray.set(new THREE.Vector3(x, 6, z), down);
  const hit = ray.intersectObject(meshOf(geo), false)[0];
  return hit ? hit.point.y : null;
};

check("you can see through the window (the visible deck really is open)",
  dropAt(seen, 0, CZ) === null, "a ray down the middle passes clean through the mesh");
check("you do NOT fall through it (the driven deck is unbroken)",
  close(dropAt(driven, 0, CZ) ?? NaN, 0), "the collision slab is at y = 0 over the window");
for (const [x, z, where] of [[0, -2, "near end"], [6, CZ, "beside the window"], [0, -30, "far end"]]) {
  check(`both decks agree everywhere else (${where})`,
    close(dropAt(seen, x, z) ?? NaN, 0) && close(dropAt(driven, x, z) ?? NaN, 0));
}
// The frame has to survive its own clamp: a window bigger than the piece would
// leave a rim too thin to land on, so it is clamped, not trusted.
const huge = buildGlassDeckGeometry({ ...PP, glassHole: 999 }, RP);
huge.computeBoundingBox();
check("an oversized window is clamped, not allowed to eat the deck",
  dropAt(huge, PP.glassWidth / 2 - 0.5, CZ) !== null,
  "a 1 m frame survives at the edge even at glassHole 999");

seen.computeBoundingBox();
const bb = seen.boundingBox;
check("same footprint as any other straight of its length",
  close(bb.max.x, PP.glassWidth / 2) && close(bb.min.z, -PP.glassLength) &&
  close(bb.min.y, -RP.thickness),
  `${PP.glassWidth} × ${PP.glassLength} m, ${RP.thickness} m thick`);

/* ══ The deck is the lacquer zone, not asphalt ════════════════════════════ */
console.log("\n— lacquer —");
const zones = seen.getAttribute("aZone").array;
const zoneSet = new Set(zones);
check("the deck band is zone 5 (the lacquered panel)", zoneSet.has(5),
  `zones present: ${[...zoneSet].sort().join(", ")}`);
check("no asphalt zone anywhere on it — it is a painted panel end to end",
  !zoneSet.has(1));
check("the driven stand-in carries the same zones (it is the same builder)",
  new Set(driven.getAttribute("aZone").array).has(5));
check("zone 5 is wired into the material's colour chain",
  /col = mix\(col, u\.panelColor, step\(4\.5, zone\)\)/.test(MAT_SRC));
check("…and into its roughness chain, which is what makes it read as lacquer",
  /r = mix\(r, u\.panelRough, step\(4\.5, zone\)\)/.test(MAT_SRC));
// Anything missing from the look lists silently stops being tunable — the same
// trap `linesOn` fell into. roadUniformSyncTest guards the general rule; this
// pins the two new ones.
check("panelColor / panelRough are in the exportable look",
  /"panelColor"/.test(MAT_SRC) && /"panelRough"/.test(MAT_SRC));

/* ══ The pane ═════════════════════════════════════════════════════════════ */
console.log("\n— the pane —");
pane.computeBoundingBox();
const pb = pane.boundingBox;
const recess = PP.glassRecess ?? 0.025;
const flange = PP.glassFlange ?? 0.15;
check("the pane fills the window and then some (it tucks under the deck)",
  close(pb.max.x, HALF + flange) && close(pb.min.x, -(HALF + flange)),
  `${(2 * (HALF + flange)).toFixed(2)} m across a ${PP.glassHole} m window`);
check("it is centred in the window", close((pb.max.z + pb.min.z) / 2, CZ));
check("it is RECESSED — nothing of it is level with the road",
  close(pb.max.y, -recess) && pb.max.y < 0,
  `top face ${pb.max.y * 100} cm under the deck`);
check("it never reaches the underside of the slab",
  pb.min.y > -RP.thickness + 1e-6,
  `pane bottom ${pb.min.y.toFixed(3)} m vs slab bottom ${(-RP.thickness).toFixed(2)} m`);
// The clamp above matters most when someone asks for a fat pane in a thin slab.
const fat = buildGlassPaneGeometry({ ...PP, glassThick: 99 }, RP);
fat.computeBoundingBox();
check("a too-thick pane is clamped inside the slab rather than poking out",
  fat.boundingBox.min.y > -RP.thickness,
  `clamped to ${(fat.boundingBox.max.y - fat.boundingBox.min.y).toFixed(2)} m thick`);

// FLICKER: every pane face must clear every deck face it could share a plane
// with. Three pairs, and all three were coplanar in the obvious authoring.
const EPS = 1e-6;
check("pane top is not coplanar with the deck top", Math.abs(pb.max.y - 0) > 0.005);
check("pane sides are not coplanar with the window reveal",
  Math.abs(pb.max.x - HALF) > 0.02 && Math.abs(pb.max.z - (CZ + HALF)) > 0.02);
check("pane bottom is not coplanar with the slab underside",
  Math.abs(pb.min.y + RP.thickness) > 0.02);

/* ══ Wiring ═══════════════════════════════════════════════════════════════ */
console.log("\n— wiring —");
check("the pane rides its own mesh channel through the builder",
  /add\(p\.glassMesh, this\.glassMaterial, "glass"\)/.test(BUILDER_SRC) &&
  /built\.glassGeometry && this\.glassMaterial/.test(BUILDER_SRC));
check("a window casts no shadow (an opaque square under the road is not a window)",
  /glassMesh\.castShadow = false/.test(BUILDER_SRC) &&
  /grp\.role !== "decor" && grp\.role !== "glass"/.test(BUILDER_SRC));
check("the game builds a pane material and hands it to the builder",
  /createRoadGlassMaterial\(\)/.test(GAME_SRC) && /\n    glassMaterial,/.test(GAME_SRC));
check("palette thumbnails include the pane", /materials\.glass/.test(THUMB_SRC));
check("glass_road lands on the Straight tab", /\n  glass_road: "straight",/.test(BUILDER_SRC));
for (const id of ["glass_str", "glass_str_wide"]) {
  const tile = BUILDER_SRC.match(new RegExp(`\\{[^{}]*id: "${id}"[\\s\\S]*?\\n    \\},`))?.[0] ?? "";
  // No `preview:` artwork any more — the tile is a render of the pane itself,
  // baked off base + params (see tools/thumbnailCacheTest.mjs), which is why
  // "palette thumbnails include the pane" above is the check that matters.
  check(`"${id}" is a Straight tile on the glass piece`,
    tile.length > 0 && /base: "glass_road"/.test(tile));
}
check("the pane material exists and is physical (ior/transmission are physical-only)",
  /MeshPhysicalNodeMaterial/.test(MAT_SRC) && /ior: g\.ior/.test(MAT_SRC));
check("real transmission is ON — measured free here, and alpha cannot do it",
  /transmission: 1,/.test(MAT_SRC));
// A transmissive surface is composited against a backdrop copy, so it sorts as
// OPAQUE. Leaving `transparent: true` on it puts it in the blended queue as
// well, which is how glass ends up invisible behind other glass.
check("a transmissive pane sorts as opaque, not as a blended surface",
  /transparent: !transmissive/.test(MAT_SRC) && /depthWrite: transmissive/.test(MAT_SRC));
check("the cheap Fresnel-alpha path is kept as a documented fallback",
  /if \(!transmissive\)/.test(MAT_SRC) && /pow\(5\)/.test(MAT_SRC));

console.log(fail === 0 ? "\nAll glass-road checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
