/**
 * GPU cull lab — does Hi-Z occlusion culling pay, and where?
 *
 * One scene, built to answer that and nothing else:
 *   - hilly terrain (1.6 km), villages of box buildings, and cliffs from the
 *     rock generator: the OCCLUDERS, drawn as ordinary meshes;
 *   - props (the rock kit + columns, 3 LODs each) and foliage (trees, bushes)
 *     as two GpuInstanceFields: the OCCLUDEES, culled per instance on the GPU;
 *   - camera presets for the two cases that matter: a ground-level open-world
 *     view (the editor's big worlds, play mode) and an RTS view.
 *
 * Keys: O occlusion · R show what occlusion removed (red, through walls) ·
 * F freeze the cull camera and fly out to look at it · T fast turn (180°/s,
 * the popping check) · 1/2/3 presets · WASD or ZQSD move, E/C up/down, right-drag look, Shift fast.
 *
 * Console: `await __CULL_LAB.ab()` — interleaved A/B of occlusion off vs on at
 * the current view, mean of raw per-frame GPU totals (render + compute).
 */
import * as THREE from "three";
import { pass } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { HiZPyramid } from "../render/culling/hizPyramid.js";
import { GpuInstanceField } from "../render/culling/gpuInstanceField.js";
import { getRockGeometry, rockKitParams, ROCK_CLIFF_PRESETS } from "../props/proceduralRock.js";
import { simplifierReady, simplifyGeometry } from "../render/instancing/autoLod.js";

const WORLD = 1600;
const HALF = WORLD / 2;

// ── Terrain height: value-noise fBm (Math.imul, or the hash repeats) ─────────
function hash2(ix, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
function heightAt(x, z) {
  let h = 0, amp = 1, f = 1 / 260;
  for (let o = 0; o < 5; o++) { h += amp * (vnoise(x * f + o * 17.3, z * f - o * 9.1) * 2 - 1); amp *= 0.5; f *= 2.03; }
  // Ridges: long hills that hide whole valleys from each other.
  const ridge = 1 - Math.abs(vnoise(x / 420 + 50, z / 420 - 20) * 2 - 1);
  return h * 38 + ridge * ridge * 55;
}

function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lodChain(geo, ratios = [0.45, 0.35]) {
  const out = [geo];
  for (const r of ratios) out.push(simplifyGeometry(out[out.length - 1], { ratio: r, minTriangles: 12 }));
  return out;
}

/** Instances for a set of types, placed over the terrain. */
function scatter({ types, counts, seed, scaleOf, avoid = null }) {
  const rnd = mulberry(seed);
  const N = counts.reduce((a, b) => a + b, 0);
  const sphere = new Float32Array(N * 4), rows = new Float32Array(N * 12), type = new Uint32Array(N);
  const c = new THREE.Vector3();
  let i = 0;
  for (let t = 0; t < types.length; t++) {
    const bs = types[t].lods[0].boundingSphere ?? (types[t].lods[0].computeBoundingSphere(), types[t].lods[0].boundingSphere);
    for (let n = 0; n < counts[t]; n++) {
      let x, z;
      do { x = (rnd() - 0.5) * (WORLD - 40); z = (rnd() - 0.5) * (WORLD - 40); } while (avoid && avoid(x, z));
      const s = scaleOf(t, rnd);
      const a = rnd() * Math.PI * 2, co = Math.cos(a) * s, si = Math.sin(a) * s;
      const y = heightAt(x, z) - 0.15 * s;
      rows.set([co, 0, si, x, 0, s, 0, y, -si, 0, co, z], i * 12);
      c.copy(bs.center);
      sphere.set([co * c.x + si * c.z + x, s * c.y + y, -si * c.x + co * c.z + z, bs.radius * s], i * 4);
      type[i] = t;
      i++;
    }
  }
  return { count: N, sphere, rows, type };
}

export async function startGpuCullLab() {
  const $ = (id) => document.getElementById(id);

  // ── Device + renderer, like the engine: MSAA on, so the scene pass depth is
  // multisampled exactly as the game's is ──────────────────────────────────
  if (!navigator.gpu) throw new Error("WebGPU not available in this browser.");
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice({ requiredFeatures: [...adapter.features] });
  const hasTimestamps = device.features.has("timestamp-query");
  const renderer = new THREE.WebGPURenderer({ antialias: true, device, trackTimestamp: hasTimestamps });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fb8cf);
  scene.fog = new THREE.Fog(0x9fb8cf, 300, 1500);
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.3, 4000);
  scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x5a4a38, 1.1));
  const sun = new THREE.DirectionalLight(0xfff1dd, 2.2);
  sun.position.set(300, 500, 200);
  scene.add(sun);

  // ── Occluders ──────────────────────────────────────────────────────────────
  $("s-note").textContent = "Building terrain…";
  const tGeo = new THREE.PlaneGeometry(WORLD, WORLD, 320, 320);
  tGeo.rotateX(-Math.PI / 2);
  const tp = tGeo.attributes.position;
  for (let i = 0; i < tp.count; i++) tp.setY(i, heightAt(tp.getX(i), tp.getZ(i)));
  tGeo.computeVertexNormals();
  const terrain = new THREE.Mesh(tGeo, new THREE.MeshStandardNodeMaterial({ color: 0x6f7d4a, roughness: 1 }));
  scene.add(terrain);

  const rnd = mulberry(7);
  const boxes = [];
  const villages = [];
  for (let v = 0; v < 14; v++) {
    const vx = (rnd() - 0.5) * (WORLD - 200), vz = (rnd() - 0.5) * (WORLD - 200);
    villages.push([vx, vz]);
    const houses = 20 + Math.floor(rnd() * 25);
    for (let k = 0; k < houses; k++) {
      const x = vx + (rnd() - 0.5) * 140, z = vz + (rnd() - 0.5) * 140;
      const w = 6 + rnd() * 10, d = 6 + rnd() * 10;
      const h = rnd() < 0.08 ? 22 + rnd() * 20 : 5 + rnd() * 10;
      const base = Math.min(heightAt(x - w / 2, z - d / 2), heightAt(x + w / 2, z - d / 2),
        heightAt(x - w / 2, z + d / 2), heightAt(x + w / 2, z + d / 2)) - 1;
      const g = new THREE.BoxGeometry(w, h, d);
      g.rotateY(rnd() * Math.PI);
      g.translate(x, base + h / 2, z);
      boxes.push(g);
    }
  }
  const buildings = new THREE.Mesh(mergeGeometries(boxes), new THREE.MeshStandardNodeMaterial({ color: 0xc9b89a, roughness: 0.9 }));
  scene.add(buildings);
  const inVillage = (x, z) => villages.some(([vx, vz]) => Math.abs(x - vx) < 75 && Math.abs(z - vz) < 75);

  $("s-note").textContent = "Generating rocks and cliffs…";
  await simplifierReady;
  const cliffMat = new THREE.MeshStandardNodeMaterial({ color: 0x8a8378, roughness: 0.95 });
  const cliffs = new THREE.Group();
  for (const [i, preset] of ROCK_CLIFF_PRESETS.entries()) {
    const geo = getRockGeometry(preset.params);
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    for (let k = 0; k < 5; k++) {
      const m = new THREE.Mesh(geo, cliffMat);
      const x = (rnd() - 0.5) * (WORLD - 100), z = (rnd() - 0.5) * (WORLD - 100);
      const s = 2.5 + rnd() * 2;
      m.scale.setScalar(s);
      m.rotation.y = rnd() * Math.PI * 2;
      // Seated on its lowest corner, a fifth of its height buried.
      const ground = Math.min(heightAt(x - 20, z - 20), heightAt(x + 20, z - 20), heightAt(x - 20, z + 20), heightAt(x + 20, z + 20));
      m.position.set(x, ground - (bb.min.y + (bb.max.y - bb.min.y) * 0.2) * s, z);
      m.name = `${preset.name} ${i}.${k}`;
      cliffs.add(m);
    }
  }
  scene.add(cliffs);

  // ── Occludees: props and foliage ───────────────────────────────────────────
  // ── Scene pass + Hi-Z ─────────────────────────────────────────────────────
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  pipeline.outputNode = scenePass;
  const hiz = new HiZPyramid({ renderer, depthTexture: scenePass.getTexture("depth") });
  const db = renderer.getDrawingBufferSize(new THREE.Vector2());
  hiz.resize(db.x, db.y);

  // ── Occludees: built with the pyramid, so they start in auto occlusion ────
  $("s-note").textContent = "Building prop LODs…";
  const rockType = (name, color) => ({ name, color, lods: lodChain(getRockGeometry(rockKitParams(name))) });
  const column = [new THREE.CylinderGeometry(0.4, 0.5, 4, 32, 8), new THREE.CylinderGeometry(0.4, 0.5, 4, 12, 2), new THREE.CylinderGeometry(0.4, 0.5, 4, 5, 1)]
    .map((g) => (g.translate(0, 2, 0), g));
  const propTypes = [
    rockType("Rock: Boulder A", 0x8d877c),
    rockType("Rock: Lump A", 0x7f7a70),
    rockType("Rock: Stone A", 0x958e82),
    rockType("Rock: Megalith A", 0x77726a),
    { name: "Column", color: 0xd8d0c0, lods: column },
  ];
  const propScale = [(r) => 1 + r(), (r) => 0.8 + r() * 0.8, (r) => 0.6 + r() * 0.8, (r) => 1 + r() * 0.5, () => 1];
  const props = new GpuInstanceField({
    renderer, scene, name: "Props", types: propTypes,
    instances: scatter({ types: propTypes, counts: [6000, 6000, 8000, 1000, 3000], seed: 11, scaleOf: (t, r) => propScale[t](r), avoid: inVillage }),
    lodDistances: [60, 150], fadeDistance: 700, hiz,
  });

  const tree = (seg) => {
    const trunk = new THREE.CylinderGeometry(0.25, 0.35, 3, Math.max(4, seg / 2), 1).translate(0, 1.5, 0);
    const crown = new THREE.ConeGeometry(2.6, 8, seg, Math.max(1, seg / 6)).translate(0, 6.5, 0);
    trunk.deleteAttribute("uv"); crown.deleteAttribute("uv");
    return mergeGeometries([trunk.toNonIndexed(), crown.toNonIndexed()]);
  };
  const indexed = (g) => { if (!g.index) { const idx = new Uint32Array(g.attributes.position.count).map((_, i) => i); g.setIndex(new THREE.BufferAttribute(idx, 1)); } return g; };
  const foliageTypes = [
    { name: "Tree", color: 0x3f6b35, lods: [tree(24), tree(10), tree(5)].map(indexed) },
    { name: "Bush", color: 0x557a3a, lods: [2, 1, 0].map((d) => new THREE.IcosahedronGeometry(1, d)).map((g) => { g.scale(1, 0.7, 1); g.translate(0, 0.4, 0); return indexed(g); }) },
  ];
  const foliage = new GpuInstanceField({
    renderer, scene, name: "Foliage", types: foliageTypes,
    instances: scatter({ types: foliageTypes, counts: [12000, 60000], seed: 23, scaleOf: (t, r) => (t === 0 ? 0.8 + r() * 0.7 : 0.6 + r() * 1.2), avoid: inVillage }),
    lodDistances: [45, 120], fadeDistance: 500, hiz,
  });

  const fields = [props, foliage];

  // ── Camera ─────────────────────────────────────────────────────────────────
  const cam = { yaw: 0, pitch: 0, ground: true, eye: 1.8, turn: false };
  const PRESETS = {
    ground: () => { Object.assign(cam, { yaw: 0.3, pitch: 0.02, ground: true, eye: 1.8 }); camera.position.set(-40, 0, 420); camera.fov = 60; },
    rts: () => { Object.assign(cam, { yaw: 0.3, pitch: -0.95, ground: true, eye: 70 }); camera.position.set(-40, 0, 420); camera.fov = 40; },
    overview: () => { Object.assign(cam, { yaw: 0.6, pitch: -0.45, ground: false }); camera.position.set(-250, 300, 450); camera.fov = 55; },
  };
  let preset = "ground";
  const setPreset = (p) => { preset = p; PRESETS[p](); camera.updateProjectionMatrix(); syncButtons(); };

  const keys = new Set();
  addEventListener("keydown", (e) => {
    keys.add(e.key.toLowerCase());
    const k = e.key.toLowerCase();
    if (k === "o") toggle("occ");
    if (k === "r") toggle("red");
    if (k === "f") toggle("freeze");
    if (k === "t") cam.turn = !cam.turn;
    if (k === "1" || k === "&") setPreset("ground");
    if (k === "2" || k === "é") setPreset("rts");
    if (k === "3" || k === "\"") setPreset("overview");
  });
  addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  let dragging = false;
  renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
  renderer.domElement.addEventListener("pointerdown", (e) => { if (e.button === 2 || e.button === 0) dragging = true; });
  addEventListener("pointerup", () => { dragging = false; });
  addEventListener("pointermove", (e) => {
    if (!dragging) return;
    cam.yaw -= e.movementX * 0.003;
    cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch - e.movementY * 0.003));
  });
  addEventListener("resize", () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  const fwd = new THREE.Vector3(), right = new THREE.Vector3();
  function moveCamera(dt) {
    if (cam.turn) cam.yaw += Math.PI * dt;
    const speed = (keys.has("shift") ? 120 : 25) * dt;
    fwd.set(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
    right.set(-fwd.z, 0, fwd.x);
    if (keys.has("w") || keys.has("z")) camera.position.addScaledVector(fwd, speed);
    if (keys.has("s")) camera.position.addScaledVector(fwd, -speed);
    if (keys.has("d")) camera.position.addScaledVector(right, speed);
    if (keys.has("a") || keys.has("q")) camera.position.addScaledVector(right, -speed);
    if (cam.ground) {
      if (keys.has("e")) cam.eye += speed;
      if (keys.has("c")) cam.eye = Math.max(1.2, cam.eye - speed);
      camera.position.y = heightAt(camera.position.x, camera.position.z) + cam.eye;
    } else {
      if (keys.has("e")) camera.position.y += speed;
      if (keys.has("c")) camera.position.y -= speed;
    }
    camera.rotation.set(cam.pitch, cam.yaw, 0, "YXZ");
    camera.updateMatrixWorld();
  }

  // ── Toggles + HUD ─────────────────────────────────────────────────────────
  // occ: "auto" | "on" | "off"; toggle("occ") cycles, toggle("occ", true/false) = on/off.
  const OCC_CYCLE = { auto: "on", on: "off", off: "auto" };
  const state = { occ: "auto", red: false, freeze: false, buildAlways: false };
  function toggle(k, v) {
    if (k === "occ") {
      state.occ = v === undefined ? OCC_CYCLE[state.occ] : v === true ? "on" : v === false ? "off" : v;
      for (const f of fields) f.setOcclusion(state.occ);
    } else {
      state[k] = v === undefined ? !state[k] : v;
      for (const f of fields) { f.setShowOccluded(state.red); f.setFrozen(state.freeze); }
    }
    syncButtons();
  }
  function syncButtons() {
    document.querySelectorAll("[data-toggle]").forEach((b) => b.classList.toggle("on",
      b.dataset.toggle === "occ" ? state.occ !== "off" : !!state[b.dataset.toggle]));
    const ob = document.querySelector('[data-toggle="occ"]');
    if (ob) ob.textContent = `Occlusion: ${state.occ}`;
    document.querySelectorAll("[data-preset]").forEach((b) => b.classList.toggle("on", b.dataset.preset === preset));
  }
  document.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => toggle(b.dataset.toggle)));
  document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => setPreset(b.dataset.preset)));

  // Per-frame GPU totals: render + compute (cull + pyramid), from timestamps.
  const samples = [];
  let lastCounts = null;
  let countsBusy = false;
  async function refreshCounts() {
    if (countsBusy) return;
    countsBusy = true;
    try {
      const [a, b] = await Promise.all(fields.map((f) => f.readCounts()));
      lastCounts = { props: a, foliage: b };
    } finally { countsBusy = false; }
  }

  let last = performance.now(), hudT = 0;
  let frameWaiters = [];
  const captureWaiters = [];
  /** The next rendered frame as ImageData (HUD excluded — it is DOM). */
  async function capture() {
    const bm = await new Promise((r) => captureWaiters.push(r)).then((p) => p);
    const c = new OffscreenCanvas(bm.width, bm.height);
    const g = c.getContext("2d");
    g.drawImage(bm, 0, 0);
    return g.getImageData(0, 0, bm.width, bm.height).data;
  }
  /** Pixels that differ by more than `tol` (sum of RGB) between two captures. */
  function diffPixels(a, b, tol = 24) {
    let n = 0;
    for (let k = 0; k < a.length; k += 4) {
      if (Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]) > tol) n++;
    }
    return n;
  }
  function frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    moveCamera(dt);
    for (const f of fields) f.update(camera);
    pipeline.render();
    // Snapshot for pixel diffs: createImageBitmap copies the canvas NOW, in the
    // same task as the render, before the WebGPU canvas texture is presented.
    if (captureWaiters.length) {
      const bm = createImageBitmap(renderer.domElement);
      for (const r of captureWaiters.splice(0)) r(bm);
    }
    // The pyramid only when a field will test against it next frame (or the
    // A/B is pricing copies). A frame without a build leaves the pyramid STALE
    // — its camera is no longer last frame's — so it is invalidated and the
    // test keeps everything until the next build.
    if (!state.freeze) {
      if (fields.some((f) => f.needsPyramid) || hiz.extraBuilds.length || state.buildAlways) {
        const changed = hiz.build(camera);
        if (changed) for (const f of fields) f._buildCompute();
      } else hiz.invalidate();
    }
    let gpu = 0, sample = null;
    if (hasTimestamps) {
      renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
      renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE);
      gpu = renderer.info.render.timestamp + renderer.info.compute.timestamp;
      sample = { gpu, render: renderer.info.render.timestamp, compute: renderer.info.compute.timestamp };
      samples.push(sample);
      if (samples.length > 120) samples.shift();
    }
    hudT += dt;
    if (hudT > 0.3) {
      hudT = 0;
      refreshCounts();
      const m = (k) => samples.reduce((s, x) => s + x[k], 0) / Math.max(1, samples.length);
      $("s-gpu").textContent = hasTimestamps ? `${m("gpu").toFixed(3)} ms` : "n/a";
      $("s-split").textContent = hasTimestamps ? `${m("render").toFixed(3)} / ${m("compute").toFixed(3)}` : "n/a";
      $("s-draws").textContent = renderer.info.render.drawCalls;
      if (lastCounts) {
        const f = (c) => `${c.drawn.toLocaleString()} drawn · ${c.occluded.toLocaleString()} occl. / ${c.total.toLocaleString()}`;
        $("s-props").textContent = f(lastCounts.props);
        $("s-foliage").textContent = f(lastCounts.foliage);
        $("s-tris").textContent = `${((lastCounts.props.triangles + lastCounts.foliage.triangles) / 1e6).toFixed(2)} M`;
      }
      $("s-occ").textContent = fields.map((f) => `${f.name} ${f.occlusionActive ? "on" : "off"}` +
        (f._auto.share != null ? ` (${Math.round(f._auto.share * 100)}% hid)` : "")).join(" · ") +
        (fields.some((f) => f.needsPyramid) ? "" : " · no pyramid");
      $("s-pos").textContent = `${camera.position.x.toFixed(0)}, ${camera.position.y.toFixed(0)}, ${camera.position.z.toFixed(0)}  yaw ${cam.yaw.toFixed(2)}`;
    }
    const w = frameWaiters; frameWaiters = [];
    for (const r of w) r(sample);
    requestAnimationFrame(frame);
  }
  const nextFrame = () => new Promise((r) => frameWaiters.push(r));

  /**
   * Interleaved A/B, occlusion off vs on, at the current view: every round
   * runs both cases, each settles before it is sampled, and the result is the
   * mean of raw per-frame totals (the timestamp is quantised; medians
   * collapse). Bring the tab to the front first: a background tab freezes
   * the counters and both sides come back identical.
   */
  async function ab({ rounds = 4, frames = 90, settle = 20, cases = null } = {}) {
    cases ??= { off: () => toggle("occ", "off"), on: () => toggle("occ", "on") };
    const acc = {}, counts = {};
    for (const k of Object.keys(cases)) acc[k] = [];
    const split = {};
    for (const k of Object.keys(cases)) split[k] = { render: [], compute: [] };
    for (let r = 0; r < rounds; r++) {
      for (const [name, apply] of Object.entries(cases)) {
        apply();
        for (let i = 0; i < settle; i++) await nextFrame();
        for (let i = 0; i < frames; i++) {
          const g = await nextFrame();
          if (g?.gpu > 0) { acc[name].push(g.gpu); split[name].render.push(g.render); split[name].compute.push(g.compute); }
        }
        await refreshCounts();
        counts[name] = lastCounts;
      }
    }
    toggle("occ", "auto");
    hiz.extraBuilds = [];
    const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
    const names = Object.keys(cases);
    const res = { preset, baseline: names[0] };
    for (const k of names) {
      res[k] = { ms: +mean(acc[k]).toFixed(3), render: +mean(split[k].render).toFixed(3), compute: +mean(split[k].compute).toFixed(3), n: acc[k].length,
        drawn: counts[k].props.drawn + counts[k].foliage.drawn,
        tris: +((counts[k].props.triangles + counts[k].foliage.triangles) / 1e6).toFixed(2) };
      if (k !== names[0]) res[k].delta = +(res[k].ms - res[names[0]].ms).toFixed(3);
    }
    console.log("[cull-lab] A/B", res);
    return res;
  }

  window.__CULL_LAB = { ab, capture, diffPixels, setPreset, toggle, state, cam, camera, renderer, hiz, props, foliage, heightAt, samples, refreshCounts, get counts() { return lastCounts; } };

  setPreset("ground");
  toggle("occ", "auto");
  $("s-note").textContent = "O occlusion auto/on/off · R show occluded · F freeze · T fast turn · 1/2/3 presets · WASD, E/C up/down, right-drag look";
  requestAnimationFrame(frame);
}
