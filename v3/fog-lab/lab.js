// FOG LAB — the volumetric fog (volumetricFog.js) on an editor level, under Sky Pro, the way a
// game boots the engine. Nothing here edits the engine: the fog goes in through the engine's
// game cloud hook (app.clouds.setSystem), which hands it the linear HDR frame with the scene
// depth; Sky Pro's own haze + sun shafts and its exposure meter are called from that hook too,
// in the order the engine runs them (haze, then the fog, then the meter).
//
// The level is the lab's own (public/levels/fog-lab.v3proj, built by makeFogLabLevel.mjs: hills
// round a winding valley, tree groves). Any other level works too: the fog's defaults are fitted
// to the terrain's relief, and a level without trees gets groves planted (not saved).
//
// URL: ?world=/levels/<name>.v3proj · ?trees=0 (do not plant groves on a level without trees)

import * as THREE from "three/webgpu";
import { startV3App, createLevelLoader } from "../engine.js";
import { createVolumetricFog, VOLUMETRIC_FOG_DEFAULTS } from "./volumetricFog.js";
import { createStylizedTrees } from "./stylizedTrees.js";

const DEFAULT_LEVEL = "/levels/fog-lab.v3proj";

export async function startFogLab({ container, onStatus = () => {} }) {
  const params = new URLSearchParams(location.search);

  onStatus("Starting engine…");
  const app = await startV3App({
    container,
    // shafts need shadows well past the editor's 150 m
    csm: { maxFar: 450 },
    terrainFeatures: { cursor: false },
    splatFeatures: { solo: false },
    preloadPaintTextures: false,
  });
  const levels = createLevelLoader(app, { defaultUrl: DEFAULT_LEVEL, onStatus });
  const level = await levels.loadBoot();
  await app.refreshWorldHeights?.();
  if (app.sky.mode !== "skypro") app.sky.setMode("skypro");

  const terrain = measureTerrain(app);
  if (params.get("trees") !== "0") plantGroves(app, terrain);

  // ---- the trees: the level's placements, drawn by the lab's stylized trees (the engine's own
  // arborist trees are taken out of the store while the new ones show, and put back to compare)
  const store = app.treeEnv.treeStore;
  const placements = [];
  for (const list of store.chunks.values()) for (const t of list) placements.push([t.x, t.z, t.y, t.rotY, t.scale, t.slotIdx]);
  const trees = createStylizedTrees({
    scene: app.scene, trees: placements,
    // smooth leaf edges need the MSAA samples (?msaa=0 = the plain alpha test)
    params: { alphaToCoverage: app.renderer.samples > 1 },
  });
  const treeMode = { stylized: true };
  function setTreeMode(stylized) {
    treeMode.stylized = stylized;
    trees.setVisible(stylized);
    store.clear();
    if (!stylized) for (const t of placements) store.addTree(...t);
    app.treeEnv.syncTreeHeights?.();
  }
  setTreeMode(true);

  // ---- the fog, defaults fitted to this terrain's relief
  const fog = createVolumetricFog({
    renderer: app.renderer,
    params: {
      top: terrain.min + terrain.range * 0.32,
      falloff: Math.max(6, terrain.range * 0.14),
      topBreakup: Math.max(4, terrain.range * 0.1),
    },
  });
  const fitted = { ...fog.params };

  const dbg = window.__V3_DEBUG; // dev server only: Sky Pro's object (its light and its haze pass)
  const skyPro = () => dbg?.worldEnv?.skyPro ?? null;
  const pipeline = () => app.postFx.pipeline;
  const size = new THREE.Vector2();
  const sunDir = new THREE.Vector3();
  let frameDt = 1 / 60;

  function cascades() {
    const csm = app.shadows.csm;
    if (!csm || !app.shadows.state.enabled) return [];
    return csm.lights.map((l, i) => {
      const c = l.shadow.camera;
      return {
        light: l,
        matrix: new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse),
        depthTex: csm._shadowNodes?.[i]?.shadowMap?.depthTexture ?? null,
      };
    });
  }

  const fogSystem = {
    enabled: true,
    prepareFrame(_anchor, dt) { frameDt = dt || frameDt; return true; },
    setDepthSource() {},
    update() {},
    // Post FX off and nothing else asked for the scene depth: route the frame through the
    // pipeline's cloud path ourselves (the engine resets the depth request every frame).
    renderFrame() {
      const p = pipeline();
      if (!p) return false;
      p.setSceneDepthRequired(true);
      p.renderWithClouds(fogSystem, app.controls.target, frameDt);
      return true;
    },
    compositeOntoLinearHDR(renderer, rt) {
      const p = pipeline();
      const depthTex = p?.getSceneDepthTexture() ?? null;
      renderer.getDrawingBufferSize(size);
      const sp = skyPro();
      const cs = cascades();
      // 1. Sky Pro's air haze + sun shafts, as the engine runs them (widest cascade)
      if (sp && app.sky.skyPro.haze > 0 && depthTex) {
        const last = cs[cs.length - 1];
        const ocean = dbg?.worldToolState?.worldOcean;
        sp.postProcess(rt, {
          depthTex, light: last?.light ?? null, shadowDepth: last?.depthTex ?? null, size,
          seaLevel: ocean?.enabled ? ocean.seaLevel : 0,
        });
      }
      // 2. the fog, lit by Sky Pro's key light and sky
      const L = sp?.light();
      const key = L ? (L.keyIsMoon ? L.moonColor.toArray() : L.sunColor) : [3, 3, 3];
      if (L) sunDir.copy(L.keyDir); else sunDir.set(0.4, 0.6, 0.3).normalize();
      const irr = L?.skyIrradiance ?? [0.3, 0.35, 0.45];
      fog.composite(rt, {
        depthTex, camera: app.camera, size, dt: frameDt, sunDir, sunColor: key,
        ambient: [irr[0] / Math.PI, irr[1] / Math.PI, irr[2] / Math.PI], cascades: cs,
      });
      // 3. the auto exposure meters the finished frame
      sp?.meter(rt);
    },
  };
  app.clouds.setSystem(fogSystem);

  // the trees follow the camera's LOD and Sky Pro's key light (before the frame renders)
  app.addPreRenderHook(function fogLabTrees() {
    const L = skyPro()?.light();
    trees.update(app.camera, L ? { sunDir: L.keyDir, sunColor: L.keyIsMoon ? L.moonColor.toArray() : L.sunColor } : {});
  });

  // ---- camera: above the terrain, looking across it
  const cam = terrain.view;
  app.controls.enableZoom = true;
  app.camera.position.copy(cam.position);
  app.controls.target.copy(cam.target);
  app.controls.update();

  const panel = buildPanel({ app, fog, fitted, fogSystem, terrain, level, trees, treeMode, setTreeMode });
  return { app, fog, fogSystem, panel, terrain, trees };
}

/** Height range of the playable terrain and a starting view over its lowest ground. */
function measureTerrain(app) {
  const S = app.worldSize, half = S * 0.45, n = 48;
  let min = Infinity, max = -Infinity, low = null;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = -half + (i / (n - 1)) * 2 * half, z = -half + (j / (n - 1)) * 2 * half;
    const h = app.getWorldHeight(x, z);
    if (!Number.isFinite(h)) continue;
    if (h < min) { min = h; }
    if (h > max) max = h;
    // the lowest point not on the map's rim: where the fog will pool
    if (Math.abs(x) < half * 0.6 && Math.abs(z) < half * 0.6 && (!low || h < low.y)) low = new THREE.Vector3(x, h, z);
  }
  const range = Math.max(10, max - min);
  low ??= new THREE.Vector3(0, min, 0);
  const target = new THREE.Vector3(low.x, min + range * 0.25, low.z);
  // stand off toward the map's middle (never past its edge), above the hills
  const away = new THREE.Vector2(-low.x, -low.z);
  if (away.length() < S * 0.05) away.set(1, 1);
  away.normalize().multiplyScalar(S * 0.26);
  const px = THREE.MathUtils.clamp(low.x + away.x, -S * 0.4, S * 0.4), pz = THREE.MathUtils.clamp(low.z + away.y, -S * 0.4, S * 0.4);
  const position = new THREE.Vector3(px, max + 25, pz);
  return { min, max, range, worldSize: S, view: { position, target } };
}

/** Clumped groves over the map (seeded), so shafts have something to fall through. */
function plantGroves(app, terrain) {
  const store = app.treeEnv?.treeStore;
  if (!store) return 0;
  let existing = 0;
  for (const list of store.chunks.values()) existing += list.length;
  if (existing > 200) return 0;
  let seed = 1234567;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const half = terrain.worldSize * 0.42;
  let planted = 0;
  for (let g = 0; g < 90; g++) {
    const cx = (rnd() * 2 - 1) * half, cz = (rnd() * 2 - 1) * half;
    const r = 12 + rnd() * 35, count = 8 + Math.floor(rnd() * 40);
    for (let k = 0; k < count; k++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r;
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      const y = app.getWorldHeight(x, z);
      if (!Number.isFinite(y)) continue;
      store.addTree(x, z, y, rnd() * Math.PI * 2, 0.8 + rnd() * 0.6, 0);
      planted++;
    }
  }
  console.log(`[fog-lab] planted ${planted} trees in 90 groves`);
  return planted;
}

// ------------------------------------------------------------------ panel
function buildPanel({ app, fog, fitted, fogSystem, terrain, level, trees, treeMode, setTreeMode }) {
  const P = fog.params;
  const root = document.getElementById("panel");
  root.innerHTML = "";
  const h = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  root.append(h("div", "title", "Volumetric fog"));
  root.append(h("div", "note", `${level?.loaded ? level.name : "default terrain"} · terrain ${terrain.min.toFixed(0)}–${terrain.max.toFixed(0)} m`));

  const rows = [];
  const section = (name) => root.append(h("div", "section", name));
  const toggle = (label, get, set) => {
    const row = h("label", "row check");
    const cb = h("input");
    cb.type = "checkbox";
    cb.checked = get();
    cb.onchange = () => set(cb.checked);
    row.append(cb, h("span", null, label));
    root.append(row);
    rows.push(() => { cb.checked = get(); });
  };
  const slider = (label, key, min, max, step, fmt = (v) => v.toFixed(2), obj = P, onSet = null) => {
    const row = h("div", "row");
    const name = h("span", "name", label);
    const val = h("span", "val");
    const inp = h("input");
    inp.type = "range"; inp.min = min; inp.max = max; inp.step = step;
    const show = () => { inp.value = obj[key]; val.textContent = fmt(Number(obj[key])); };
    inp.oninput = () => { obj[key] = Number(inp.value); val.textContent = fmt(obj[key]); onSet?.(obj[key]); };
    show();
    row.append(name, inp, val);
    root.append(row);
    rows.push(show);
  };
  const m = (v) => `${v.toFixed(0)} m`;
  const m2 = (v) => `${v.toFixed(2)} m`;
  const e4 = (v) => v.toFixed(4);

  section("Fog");
  toggle("Fog on", () => P.enabled, (v) => { P.enabled = v; });
  slider("Density", "density", 0, 0.03, 0.0001, e4);
  slider("Layer top", "top", terrain.min - 20, terrain.max + 40, 0.5, m);
  slider("Falloff above", "falloff", 1, Math.max(60, terrain.range), 0.5, m);
  slider("Top breakup", "topBreakup", 0, Math.max(40, terrain.range * 0.5), 0.5, m);
  slider("Haze (everywhere)", "haze", 0, 0.004, 0.00005, e4);
  slider("Start distance", "startDist", 0, 200, 1, m);

  section("Shape");
  slider("Noise amount", "noiseAmount", 0, 1, 0.01);
  slider("Coverage", "coverage", 0, 1, 0.01);
  slider("Detail", "detail", 0, 1, 0.01);
  slider("Bank size", "noiseFreq", 1 / 600, 1 / 30, 0.0001, (v) => `${(1 / v).toFixed(0)} m`);
  slider("Wind speed", "windSpeed", 0, 20, 0.1, (v) => `${v.toFixed(1)} m/s`);
  slider("Wind direction", "windDeg", 0, 360, 1, (v) => `${v.toFixed(0)}°`);

  section("Light");
  slider("Forward scatter", "anisotropy", 0, 0.9, 0.01);
  slider("Sun", "sunScale", 0, 4, 0.01);
  slider("Ambient", "ambientScale", 0, 4, 0.01);
  slider("Multiple scatter", "multiScatter", 0, 1.5, 0.01);
  slider("Self shadow", "selfShadow", 0, 2, 0.01);
  slider("Ambient occlusion", "ambientOcclusion", 0, 2, 0.01);
  toggle("Shafts (sun shadows)", () => P.shadows, (v) => { P.shadows = v; });
  const tintRow = h("div", "row");
  const tintIn = h("input");
  tintIn.type = "color"; tintIn.value = P.tint;
  tintIn.oninput = () => { P.tint = tintIn.value; };
  tintRow.append(h("span", "name", "Tint"), tintIn);
  root.append(tintRow);
  rows.push(() => { tintIn.value = P.tint; });

  section("Quality");
  slider("Steps", "steps", 8, 128, 1, (v) => v.toFixed(0));
  slider("Distance", "maxDist", 200, 6000, 10, m);
  slider("Resolution", "resolution", 0.25, 1, 0.25, (v) => `${(v * 100).toFixed(0)} %`);
  slider("Temporal blend", "temporalBlend", 0.03, 1, 0.01);

  section("Trees");
  toggle("New stylized trees (off = the arborist ones)", () => treeMode.stylized, (v) => setTreeMode(v));
  const TP = trees.params;
  const colorRow = (label, key) => {
    const row = h("div", "row");
    const inp = h("input");
    inp.type = "color"; inp.value = TP[key];
    inp.oninput = () => { TP[key] = inp.value; };
    row.append(h("span", "name", label), inp);
    root.append(row);
    rows.push(() => { inp.value = TP[key]; });
  };
  colorRow("Top colour", "topColor");
  colorRow("Bottom colour", "bottomColor");
  slider("Inner darkening", "aoColor", 0, 1, 0.01, undefined, TP);
  slider("Light through", "translucency", 0, 1.5, 0.01, undefined, TP);
  slider("Tint spread", "tintVar", 0, 0.5, 0.01, undefined, TP);
  slider("Self-shadow lift", "shadowLift", 0, 3, 0.05, m2, TP);
  slider("Trunk height (+)", "crownLift", 0, 6, 0.1, m2, TP);
  slider("Leaves face camera", "faceCamera", 0, 1, 0.01, undefined, TP);
  slider("Detail distance", "lodDist", 40, 600, 5, m, TP);

  section("Ground");
  const ground = { textured: false };
  toggle("Ground texture (off = grid)", () => ground.textured, (v) => {
    ground.textured = v;
    const ps = window.__V3_DEBUG?.paintSys;
    if (!ps) return;
    if (v) ps.fillWithActiveLayer(); else ps.clearAll();
  });

  section("Sky");
  const sky = { hour: 8.5 };
  slider("Time of day", "hour", 4, 20, 0.05, (v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, "0")}`, sky,
    (v) => app.sky.setTimeOfDay(v));
  app.sky.setTimeOfDay(sky.hour);
  const sp = app.sky.skyPro;
  if (sp && "haze" in sp) slider("Sky Pro haze", "haze", 0, 4, 0.01, undefined, sp);
  if (sp && "shafts" in sp) slider("Sky Pro shafts", "shafts", 0, 3, 0.01, undefined, sp);

  section("Tools");
  const btns = h("div", "buttons");
  const btn = (label, fn) => { const b = h("button", null, label); b.onclick = fn; btns.append(b); return b; };
  btn("Reset to fitted", () => { Object.assign(P, fitted); rows.forEach((r) => r()); });
  btn("Reset camera", () => {
    app.camera.position.copy(terrain.view.position);
    app.controls.target.copy(terrain.view.target);
    app.controls.update();
    fog.resetHistory();
  });
  const out = h("div", "note");
  const measure = btn("Measure fog cost (GPU)", async () => {
    const dbg = window.__V3_DEBUG;
    if (!dbg?.gpuAB) { out.textContent = "No GPU timer (dev server only)."; return; }
    measure.disabled = true;
    const was = P.enabled;
    try {
      out.textContent = "Measuring… keep this tab in front and the camera still (~25 s)";
      const r = await dbg.gpuAB({
        cases: { off: () => { P.enabled = false; }, on: () => { P.enabled = true; } },
        reset: () => { P.enabled = was; },
        onProgress: (d, t) => { out.textContent = `Measuring… ${d}/${t}`; },
      });
      out.textContent = `GPU frame: off ${r.off.mean} ms · on ${r.on.mean} ms · fog +${r.deltas.on} ms (noise ±${r.noise})`;
    } catch (e) {
      out.textContent = `Measure failed: ${e.message}`;
    } finally {
      measure.disabled = false;
    }
  });
  root.append(btns, out);
  void fogSystem; void VOLUMETRIC_FOG_DEFAULTS;
  return { refresh: () => rows.forEach((r) => r()) };
}
