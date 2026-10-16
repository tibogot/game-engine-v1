// STYLIZED LAB — Genshin-style cliffs (and later rocks, bushes…) for the
// off-road game, judged in the engine's own light.
//
// Fifth pass (2026-10-09, the user's Genshin + Fab refs and the building-lab
// sandstone rocks): a KIT of chunky chipped blocks from the engine's rock
// generator with its sandstone options (genshinKit.js), shown in a row, and
// assembled on the mountain (tools/stylizedLabLevel.mjs) into TIERED CLIFFS —
// blocks stacked up each steep drop, each tier set back with grass on its
// ledge — boulders and stones below; the Genshin-style material with the
// photo relief for the cracks (stylizedRockMaterial.js).
// ?row=1 adds the earlier test row (sandstone assemblies + the engine's Crag
// Wall) in the meadow for comparison. ?tod=<hour> sets the time of day.
import * as THREE from "three";
import { startV3App, createLevelLoader } from "../../v3/engine.js";
import { simplifierReady } from "../../v3/render/instancing/autoLod.js";
import { getRockGeometry, ROCK_CLIFF_PRESETS } from "../../v3/props/proceduralRock.js";
import { GENSHIN_CLIFFS, buildCliffSkin, buildGenshinCliff, placePiece, prewarmGenshinCliffs } from "./genshinCliffs.js";
import { buildKitShowcase, buildTieredCliffs, prewarmKit } from "./genshinKit.js";
import { createCliffTopGrass } from "./cliffTopGrass.js";
import { createStylizedRockMaterial } from "./stylizedRockMaterial.js";

const LEVEL = "/levels/stylized-lab.v3proj";
const ROW_Z = 40;
const ROW = [
  { name: "grandWall", x: -125 },
  { name: "stepped", x: -40 },
  { name: "pillars", x: 30 },
  { name: "boulders", x: 85 },
];
const OLD = { x: 140, label: "OLD: engine Crag Wall (same material)" };
const REGION = { x0: -235, x1: 235, z0: -235, z1: 150 };
const SHOW_Z = 175;   // the kit row, in the meadow south of the path's end

export async function startStylizedLab({ container, hud, onStatus = () => {} } = {}) {
  onStatus("Starting engine…");
  const app = await startV3App({
    container, skyMode: "skypro", cloudShadows: true,
    terrainFeatures: { cursor: false }, splatFeatures: { solo: false }, preloadPaintTextures: false,
  });
  await createLevelLoader(app, { defaultUrl: LEVEL, onStatus }).loadBoot();
  const params = new URLSearchParams(location.search);
  app.sky?.setMode?.("skypro");
  app.sky?.set?.({ latitude: 40, dayOfYear: 170 });
  app.sky?.setTimeOfDay?.(params.has("tod") ? Number(params.get("tod")) : 14.5);
  app.fog?.setHeight?.({ enabled: false });
  app.fog?.setDistance?.({ enabled: false });
  await simplifierReady;

  onStatus("Generating cliff pieces (workers)…");
  const t0 = performance.now();
  const showRow = params.get("row") === "1";
  const [, kit] = await Promise.all([showRow ? prewarmGenshinCliffs(undefined, { hillside: false }) : null, prewarmKit()]);
  console.log(`[stylized-lab] pieces generated in ${Math.round(performance.now() - t0)} ms`);

  // the rock runs the terrain's own "Rock" layer maths with the same texture,
  // scale, tint and strengths (stylizedRockMaterial.js ROCK_LOOK_DEFAULTS =
  // tools/stylizedLabLevel.mjs "Rock")
  const material = createStylizedRockMaterial({
    worldSize: app.worldSize ?? 512,
    terrain: { heightTexNode: app.heightTexNode, worldSize: app.worldSize ?? 512, maxHeight: app.maxHeight ?? 140 },
  });
  const group = new THREE.Group();
  group.name = "StylizedLabCliffs";
  app.scene.add(group);

  /** Sit a piece on the LOWEST ground under its footprint, sunk 1.5 m. */
  const place = (mesh, x, z, sink = 1.5) => {
    const b = mesh.geometry.boundingBox;
    let lo = Infinity;
    for (const fx of [0, 0.25, 0.5, 0.75, 1]) for (const fz of [0, 0.5, 1]) {
      lo = Math.min(lo, app.getWorldHeight(x + b.min.x + (b.max.x - b.min.x) * fx, z + b.min.z + (b.max.z - b.min.z) * fz));
    }
    mesh.position.set(x, lo - sink, z);
    mesh.castShadow = mesh.receiveShadow = true;
  };
  for (const c of showRow ? ROW : []) {
    const geo = buildGenshinCliff(c.name);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `Cliff:${c.name}`;
    place(mesh, c.x, ROW_Z, c.name === "boulders" ? 0.5 : 1.5);
    group.add(mesh);
    console.log(`[stylized-lab] ${c.name}: ${geo.userData.cliff.pieces} pieces, ${geo.userData.cliff.triangles} tris, ${geo.userData.cliff.height} m tall`);
  }
  const crag = ROCK_CLIFF_PRESETS.find((p) => p.name === "Cliff: Crag Wall");
  if (crag && showRow) {
    const old = new THREE.Mesh(placePiece(getRockGeometry(crag.params)), material);
    old.name = "Cliff:old-crag";
    old.scale.setScalar(1.2);
    old.geometry.computeBoundingBox();
    place(old, OLD.x, ROW_Z);
    group.add(old);
  }

  // The kit: a showcase row in the meadow, and the pieces reused on the mountain.
  const t1 = performance.now();
  const height = (x, z) => app.getWorldHeight(x, z);
  const normal = (x, z) => {
    const e = 1.5, dx = height(x + e, z) - height(x - e, z), dz = height(x, z + e) - height(x, z - e);
    const l = Math.hypot(dx, 2 * e, dz);
    return { x: -dx / l, y: (2 * e) / l, z: -dz / l };
  };
  const addMesh = (geo, name) => {
    if (!geo) return null;
    const m = new THREE.Mesh(geo, material);
    m.name = name;
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    console.log(`[stylized-lab] ${name}: ${JSON.stringify(geo.userData.kit)}`);
    return m;
  };
  addMesh(buildKitShowcase(kit, { x0: -150, z: SHOW_Z, height }), "Kit:showcase");
  // THE HERO CLIFF first (the Genshin ref: two tiers of blocks, grass ledges):
  // each step of the hero hill traced at mid-height, blocks chained along it,
  // each block's front at the step's foot, its flat top at the ledge's rim.
  // (The mountain's cliffs wait until this one reads right: ?mountain=1.)
  const heroGeo = buildCliffSkin({
    height, normal, faces: [...kit.block, ...kit.bench], overlap: 0.34, overhang: 0.03, rimLift: 0.3, bury: 0.7, window: 7, yawJitter: 0.25,
    lines: [{ kind: "lineX", level: 17.5, x0: 40, x1: 200, z0: 55, z1: 190 }, { kind: "lineX", level: 26, x0: 40, x1: 200, z0: 55, z1: 190 }],
  });
  if (heroGeo) heroGeo.userData.kit = heroGeo.userData.skin;
  const heroMesh = addMesh(heroGeo, "Kit:hero");
  const worldGeo = params.get("mountain") === "1" ? buildTieredCliffs(kit, { height, normal, region: REGION }) : null;
  addMesh(worldGeo, "Kit:cliffs");
  const placed = (worldGeo?.userData.stacks ?? []).map((e) => ({ ...e, r: e.w / 2 }));
  console.log(`[stylized-lab] kit placed in ${Math.round(performance.now() - t1)} ms`);
  // Revo grass on the cliffs' flat tops (cliffTopGrass.js), the level's own revo look.
  const cliffMeshes = group.children.filter((m) => m.name === "Kit:hero" || m.name === "Kit:cliffs");
  const topGrass = params.get("topgrass") === "0" || !cliffMeshes.length ? null : await createCliffTopGrass(app, cliffMeshes);
  if (topGrass) console.log(`[stylized-lab] cliff-top grass: ${topGrass.cells} m² of tops`);

  // Views: the kit row, the mountain, then close looks at placed pieces.
  const views = [];
  const look = (label, x, z, up, tx, tz, tUp) => views.push({ label, pos: [x, height(x, z) + up, z], target: [tx, height(tx, tz) + tUp, tz] });
  look("Kit — the pieces in a row", -40, SHOW_Z + 75, 22, -40, SHOW_Z, 6);
  look("Kit — boulders and pebbles", -125, SHOW_Z + 48, 6, -125, SHOW_Z + 24, 1);
  look("Hero cliff — the two tiers, close", 62, 128, 2.5, 100, 118, 8);
  look("Hero cliff — along it", 70, 70, 4, 92, 150, 8);
  look("Mountain — from the meadow", 0, 140, 6, 0, -120, 20);
  const big = [...placed].sort((a, b) => b.drop - a.drop);
  for (const [i, p] of big.slice(0, 4).entries()) {
    const n = normal(p.x, p.z), hl = Math.hypot(n.x, n.z) || 1, d = 30 + p.r * 1.5;
    const cx = p.x + (n.x / hl) * d + (n.z / hl) * d * 0.35, cz = p.z + (n.z / hl) * d - (n.x / hl) * d * 0.35;
    look(`Cliff ${i + 1} — ${p.tiers} tier(s), ${p.drop} m drop`, cx, cz, 5, p.x, p.z, 4);
  }
  if (showRow) {
    views.push({ label: "Old row", pos: [0, 45, ROW_Z + 90], target: [0, 18, ROW_Z] });
    const g = app.getWorldHeight(OLD.x, ROW_Z + 34);
    views.push({ label: OLD.label, pos: [OLD.x + 16, g + 9, ROW_Z + 34], target: [OLD.x, g + 8, ROW_Z - 4] });
  }

  const buttons = [];
  const go = (i) => {
    const v = views[i];
    if (!v) return;
    app.camera.position.set(...v.pos);
    app.controls.target.set(...v.target);
    app.controls.update();
    buttons.forEach((b, k) => b.classList.toggle("on", k === i));
  };
  const u = material.userData.rock;
  const cycles = [
    { key: "M", label: "Moss on tops", get: () => (u.mossOn.value > 0.5 ? "on" : "off"), next: () => { u.mossOn.value = u.mossOn.value > 0.5 ? 0 : 1; } },

  ];
  if (hud) {
    const title = document.createElement("div");
    title.textContent = "Stylized lab · Genshin-style cliffs";
    hud.append(title);
    views.forEach((v, i) => {
      const b = document.createElement("button");
      b.textContent = `${i + 1}  ${v.label}`;
      b.onclick = () => go(i);
      buttons.push(b);
      hud.append(b);
    });
    for (const c of cycles) {
      const b = document.createElement("button");
      const paint = () => { b.textContent = `${c.key}  ${c.label}: ${c.get()}`; };
      b.onclick = () => { c.next(); paint(); };
      c.button = b;
      paint();
      hud.append(b);
    }
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = "Drag to orbit, wheel to zoom. ?tod=H sets the hour.";
    hud.append(note);
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const n = e.key === "0" ? 10 : Number(e.key);
      if (n >= 1 && n <= views.length) go(n - 1);
      for (const c of cycles) if (e.key.toLowerCase() === c.key.toLowerCase()) c.button.click();
    });
  }
  go(0);
  return { app, material, group, go, topGrass };
}
