// ROCK LAB (2026-10-23, you: the sandstone rocks "look all almost the same … maybe you need a lab to work on them?").
// One formation at a time (rockFormations.js) beside the game's rock as it is now, in a light scene with the game's
// sun, shadow and exposure (the plant lab's) — no map, it loads in seconds. The CoH 3 reference in the corner.
//
//   left    the game's rock today (algSandstone: the "mesa" shape, seed 1)
//   right   the new formation: its kind, its seed, its sliders — rebuilt on each change (worker threads)
//   COMPOSE  your own formations (you: "allow me with some gizmo to blend those big rocks together, rotate them, scale
//            them"): pieces added, picked with a click, moved / turned / stretched with the gizmo, saved by name; each
//            piece's stretch and turn BAKED into its shape when the gizmo lets go (the stone's layers lie as the game's)
//   views   Play zoom (the RTS camera's 40° lens, ~53° down, ~65 m) · Close · Orbit with the mouse
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PlacedFoliage } from "../../v3/render/foliage/placedFoliage.js";
import { FOLIAGE_PRESETS } from "../../v3/app/state/foliageScatterState.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { FORMATIONS, PIECES, buildFormation, defaultsOf, formationItems, pieceGeometry, pieceParams, prewarmPieces } from "./rockFormations.js";

import { SANDSTONE_COLOURS, buildSandstoneRock, sandstoneLook, sandstoneMaterial, setSandstoneColour } from "./algSandstone.js";

/** The game's sun (alg-rts, Partly cloudy, 15:12 — the plant and vehicle labs'). */
const SUN = { dir: new THREE.Vector3(-0.739, 0.65, 0.175).normalize(), intensity: 10, color: 0xfff2dd };

function gradientSky() {
  const W = 64, H = 32, d = new Float32Array(W * H * 4);
  const zen = [0.18, 0.36, 0.75], hor = [0.95, 0.98, 1.0], gnd = [0.32, 0.24, 0.16];
  for (let y = 0; y < H; y++) {
    const el = (1 - (y + 0.5) / H) * 2 - 1;
    const c = el > 0 ? hor.map((h, i) => h + (zen[i] - h) * Math.pow(el, 0.55)) : gnd;
    for (let x = 0; x < W; x++) d.set([...c.map((q) => q * 1.6), 1], (y * W + x) * 4);
  }
  const t = new THREE.DataTexture(d, W, H, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const OLD_X = -34, NEW_X = 14;   // the old rock on the left, the new formation on the right

export async function startRockLab(container) {
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.55;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);
  await renderer.init();

  const scene = new THREE.Scene();
  scene.background = scene.environment = gradientSky();
  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 2000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;

  const sun = new THREE.DirectionalLight(SUN.color, SUN.intensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 600 });
  sun.shadow.bias = 0; sun.shadow.normalBias = 0.03; sun.shadow.radius = 2;   // (~3 cm texel: the game's fitted shadow's)
  sun.position.copy(SUN.dir).multiplyScalar(300);
  scene.add(sun, sun.target);

  const loader = new THREE.TextureLoader();
  const tex = (f, srgb) => {
    const t = loader.load(`/textures/ground/dry_mud_field_001/dry_mud_field_001_${f}_1k.jpg`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(40, 40); t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2),
    new THREE.MeshStandardNodeMaterial({ map: tex("diff", true), normalMap: tex("nor_gl"), roughness: 1, color: 0xd8c6a8 }));
  ground.receiveShadow = true;
  scene.add(ground);

  const mat = sandstoneMaterial();
  // the new rocks WEATHERED (dust on the tops, streaks, dark undersides, the seams between pieces): the game's rock
  // keeps the plain one, to compare
  const matW = sandstoneMaterial({ weather: true });
  const noContact = (g) => { if (!g.attributes.rockContact) g.setAttribute("rockContact", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count), 1)); return g; };
  setSandstoneColour("aures");
  // The game's rock as it is (sunk as the game sinks it: 0.3 m)
  const old = new THREE.Mesh(buildSandstoneRock("mesa", 1), mat);
  old.position.set(OLD_X, -0.3, 0); old.rotation.y = 0.4; old.castShadow = old.receiveShadow = true;
  scene.add(old);

  // ── the panel ──
  const state = { kind: "mesa", seed: 1, opts: defaultsOf("mesa"), colour: "aures" };
  const ui = document.createElement("div");
  ui.style.cssText = "position:fixed;left:12px;top:12px;width:260px;padding:12px;background:rgba(18,14,10,.88);color:#e8dcc8;font:12px system-ui,sans-serif;border:1px solid #5a4a36;border-radius:6px;z-index:10;max-height:94vh;overflow:auto";
  document.body.appendChild(ui);
  const ref = document.createElement("img");
  ref.style.cssText = "position:fixed;right:12px;top:12px;width:360px;border:1px solid #5a4a36;border-radius:4px;z-index:10;cursor:zoom-in";
  ref.title = "CoH 3 reference — click to enlarge";
  ref.onclick = () => { ref.style.width = ref.style.width === "360px" ? "900px" : "360px"; };
  document.body.appendChild(ref);
  const label = document.createElement("div");
  label.style.cssText = "position:fixed;bottom:12px;left:50%;transform:translateX(-50%);color:#e8dcc8;font:12px system-ui;background:rgba(18,14,10,.75);padding:4px 10px;border-radius:4px";
  label.textContent = "left: the game's rock today · right: the new formation";
  document.body.appendChild(label);

  let mesh = null, busy = false, again = false;
  async function rebuild() {
    if (busy) { again = true; return; }
    busy = true;
    status.textContent = "building…";
    const t0 = performance.now();
    try {
      const geo = await buildFormation(state.kind, state.seed, state.opts);
      if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); }
      mesh = new THREE.Mesh(noContact(geo), matW);
      mesh.position.set(NEW_X, -0.3, 0); mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
      const f = geo.userData.formation, bb = geo.boundingBox;
      status.textContent = `${f.parts} parts · ${Math.round(f.triangles).toLocaleString()} tris · ${(bb.max.x - bb.min.x).toFixed(0)} × ${(bb.max.z - bb.min.z).toFixed(0)} × ${(bb.max.y - bb.min.y).toFixed(1)} m · ${Math.round(performance.now() - t0)} ms`;
    } catch (e) { status.textContent = "failed: " + e.message; console.error(e); }
    busy = false;
    if (again) { again = false; rebuild(); }
  }

  const row = (html) => { const d = document.createElement("div"); d.style.margin = "6px 0"; d.innerHTML = html; ui.appendChild(d); return d; };
  row(`<b style="font-size:14px">Rock Lab</b>`);
  const kindSel = row(`Formation <select id="rk-kind">${Object.entries(FORMATIONS).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join("")}</select>`).querySelector("select");
  const seedRow = row(`Seed <button id="rk-prev">◀</button> <span id="rk-seed">1</span> <button id="rk-next">▶</button>`);
  const colSel = row(`Colour <select>${Object.entries(SANDSTONE_COLOURS).map(([k, c]) => `<option value="${k}"${k === "aures" ? " selected" : ""}>${c.label}</option>`).join("")}</select>`).querySelector("select");
  const sliders = document.createElement("div"); ui.appendChild(sliders);
  // the weathering, live
  const wx = document.createElement("div"); ui.appendChild(wx);
  for (const [k, name, max] of [["dust", "Dust on tops", 1], ["streaks", "Streaks down the walls", 1], ["under", "Dark undersides", 1], ["seams", "Seams between pieces", 1], ["heightBands", "Colour bands by height", 1]]) {
    const d = document.createElement("div"); d.style.margin = "6px 0";
    d.innerHTML = `<div style="display:flex;justify-content:space-between"><span>${name}</span><span>${sandstoneLook[k].value}</span></div><input type="range" min="0" max="${max}" step="0.05" value="${sandstoneLook[k].value}" style="width:100%">`;
    const inp = d.querySelector("input"), out = d.querySelector("span:last-child");
    inp.oninput = () => { sandstoneLook[k].value = Number(inp.value); out.textContent = inp.value; };
    wx.appendChild(d);
  }
  const views = row(`<button data-v="play">Play zoom</button> <button data-v="close">Close</button> <button data-v="both">Both rocks</button>`);
  const status = row(`<span style="color:#b9a888"></span>`).firstElementChild;

  function buildSliders() {
    sliders.innerHTML = "";
    for (const [key, name, min, max, step] of FORMATIONS[state.kind].controls) {
      const d = document.createElement("div"); d.style.margin = "6px 0";
      d.innerHTML = `<div style="display:flex;justify-content:space-between"><span>${name}</span><span>${state.opts[key]}</span></div><input type="range" min="${min}" max="${max}" step="${step}" value="${state.opts[key]}" style="width:100%">`;
      const inp = d.querySelector("input"), out = d.querySelector("span:last-child");
      inp.oninput = () => { out.textContent = inp.value; };
      inp.onchange = () => { state.opts[key] = Number(inp.value); rebuild(); };
      sliders.appendChild(d);
    }
    ref.src = `/assets-src/refs/coh3/${FORMATIONS[state.kind].ref}`;
  }
  kindSel.onchange = () => { state.kind = kindSel.value; state.opts = defaultsOf(state.kind); buildSliders(); rebuild(); };
  const seedOut = seedRow.querySelector("#rk-seed");
  seedRow.querySelector("#rk-prev").onclick = () => { state.seed = Math.max(1, state.seed - 1); seedOut.textContent = state.seed; rebuild(); };
  seedRow.querySelector("#rk-next").onclick = () => { state.seed++; seedOut.textContent = state.seed; rebuild(); };
  colSel.onchange = () => { setSandstoneColour(colSel.value); };

  // The RTS camera: 40° lens, ~53° down, ~65 m from what it looks at
  function view(v) {
    const at = v === "both" ? new THREE.Vector3((OLD_X + NEW_X) / 2, 2, 0) : new THREE.Vector3(NEW_X, 2, 0);
    const dist = v === "close" ? 26 : v === "both" ? 95 : 65, down = v === "close" ? 0.55 : 0.92, head = -0.35;
    controls.target.copy(at);
    camera.position.set(at.x + Math.sin(head) * Math.cos(down) * dist, at.y + Math.sin(down) * dist, at.z + Math.cos(head) * Math.cos(down) * dist);
  }
  views.querySelectorAll("button").forEach((b) => (b.onclick = () => view(b.dataset.v)));

  // ── COMPOSE ──────────────────────────────────────────────────────────────────────────────────────────────────
  const comp = { items: [], selected: null };   // item: { params, M: Matrix4 (piece → formation), mesh }
  const group = new THREE.Group(); group.position.set(NEW_X, -0.3, 0); scene.add(group);
  const tc = new TransformControls(camera, renderer.domElement);
  scene.add(tc.getHelper());
  // UNDO (you: "we need an undo in the rock lab"): every change first records the composition as it was (Ctrl+Z / Ctrl+Y)
  const past = [], future = [];
  const snap = () => { past.push(JSON.stringify(dump())); if (past.length > 80) past.shift(); future.length = 0; };
  async function restore(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(dump()));
    await addItems(JSON.parse(from.pop()), true);
    compStatus.textContent += `  (undo ${past.length} · redo ${future.length})`;
  }
  const undo = () => restore(past, future), redo = () => restore(future, past);
  tc.addEventListener("dragging-changed", (e) => { controls.enabled = !e.value; if (e.value) snap(); else if (comp.selected) bake(comp.selected); });
  // A piece: its shape with M baked in, IN THE COMPOSITION'S SPACE (the photos, the dust and the streaks run on across
  // pieces as one rock's), the mesh under a PIVOT at the piece's middle — the gizmo moves the pivot; on release the
  // pivot's move / turn / stretch go into M (M' = pivot · T(−centre) · M), the shape is rebuilt, the pivot reset.
  const centreOf = (it) => { const g = pieceGeometry(it.params).clone().applyMatrix4(it.M); g.computeBoundingBox(); const c = g.boundingBox.getCenter(new THREE.Vector3()); return { g, c }; };
  function shape(it) {
    const { g, c } = centreOf(it);
    if (it.mesh) { it.mesh.geometry.dispose(); it.mesh.geometry = noContact(g); }
    else {
      it.pivot = new THREE.Object3D(); group.add(it.pivot);
      it.mesh = new THREE.Mesh(noContact(g), matW); it.mesh.castShadow = it.mesh.receiveShadow = true; it.mesh.userData.item = it; it.pivot.add(it.mesh);
    }
    it.c = c;
    it.pivot.position.copy(c); it.pivot.quaternion.identity(); it.pivot.scale.set(1, 1, 1); it.pivot.updateMatrix();
    it.mesh.position.copy(c).negate();
    contactSoon();
  }
  function bake(it) {
    it.pivot.updateMatrix();
    it.M = it.pivot.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(-it.c.x, -it.c.y, -it.c.z)).multiply(it.M);
    shape(it); tc.attach(it.pivot); info();
  }
  // THE SEAMS (you: hide them): every vertex's distance to the OTHER pieces' surfaces (their vertices, a grid) — the
  // weathering's crease shade and grit (algSandstone: rockContact). Recomputed a moment after any change.
  let contactT = null;
  function contactSoon() { clearTimeout(contactT); contactT = setTimeout(contactAll, 120); }
  function contactAll() {
    const R = 1.4, cell = R, grid = new Map(), key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    comp.items.forEach((it, k) => { const p = it.mesh.geometry.attributes.position; for (let i = 0; i < p.count; i += 2) { const kk = key(p.getX(i), p.getY(i), p.getZ(i)); let l = grid.get(kk); if (!l) grid.set(kk, (l = [])); l.push(p.getX(i), p.getY(i), p.getZ(i), k); } });
    comp.items.forEach((it, k) => {
      const p = it.mesh.geometry.attributes.position, out = new Float32Array(p.count);
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i), gx = Math.floor(x / cell), gy = Math.floor(y / cell), gz = Math.floor(z / cell);
        let best = R * R;
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
          const l = grid.get(`${gx + a},${gy + b},${gz + c}`); if (!l) continue;
          for (let j = 0; j < l.length; j += 4) { if (l[j + 3] === k) continue; const dx = l[j] - x, dy = l[j + 1] - y, dz = l[j + 2] - z, d = dx * dx + dy * dy + dz * dz; if (d < best) best = d; }
        }
        const d = Math.sqrt(best) / R; out[i] = (1 - d) * (1 - d);
      }
      it.mesh.geometry.setAttribute("rockContact", new THREE.BufferAttribute(out, 1));
    });
    sowSoon?.();
  }
  async function addItems(list, replace = false) {
    if (replace) { for (const it of comp.items) { group.remove(it.pivot); it.mesh.geometry.dispose(); } comp.items = []; select(null); }
    if (!list.length) { info(); return null; }
    compStatus.textContent = "building pieces…";
    await prewarmPieces(list.map((i) => i.params));
    for (const i of list) { const it = { params: i.params, M: i.M ?? new THREE.Matrix4().fromArray(i.matrix) }; shape(it); comp.items.push(it); }
    info();
    return comp.items[comp.items.length - 1];
  }
  function select(it) {
    comp.selected = it;
    if (it) tc.attach(it.pivot); else tc.detach();
    info();
  }
  function info() {
    const tris = comp.items.reduce((a, it) => a + it.mesh.geometry.index.count / 3, 0);
    compStatus.textContent = `${comp.items.length} pieces · ${Math.round(tris).toLocaleString()} tris` + (comp.selected ? ` · selected: ${comp.selected.params._kind ?? "piece"} (seed ${comp.selected.params.seed})` : "");
  }
  const look = () => ({ round: state.opts.round ?? 0.55, breaks: state.opts.breaks ?? 0.6, strata: state.opts.strata ?? 2, undercut: state.opts.undercut ?? 0.15, relief: { lumps: state.opts.lumps ?? 0.5, blocks: state.opts.blocks ?? 0.45, runnels: state.opts.runnels ?? 0.35 }, sharp: state.opts.sharp ?? 0.7 });
  async function addPiece(kind) {
    snap();
    const seed = 1 + Math.floor(Math.random() * 9999), params = { ...pieceParams({ kind, seed, ...look() }), _kind: kind };
    const at = comp.selected ? comp.selected.pivot.position.clone().add(new THREE.Vector3(3, 0, 0)) : new THREE.Vector3((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 4);
    const it = await addItems([{ params, M: new THREE.Matrix4().makeTranslation(at.x, 0, at.z) }]);
    if (mesh) mesh.visible = false;
    select(it);
  }
  // click: pick a piece (not a gizmo drag)
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null;
  renderer.domElement.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || tc.dragging || tc.axis) return;
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(comp.items.map((it) => it.mesh), false)[0];
    select(hit ? hit.object.userData.item : null);
  });
  addEventListener("keydown", async (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    const k = e.key.toLowerCase();   // (AZERTY: e.key is the letter on the key)
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
    if (e.ctrlKey || e.metaKey) return;
    if (k === "w" || k === "z") tc.setMode("translate"); else if (k === "e") tc.setMode("rotate"); else if (k === "r") tc.setMode("scale");
    else if (k === "q" || k === "a") tc.setSpace(tc.space === "local" ? "world" : "local");
    else if ((k === "delete" || k === "backspace") && comp.selected) { snap(); const it = comp.selected; select(null); group.remove(it.pivot); it.mesh.geometry.dispose(); comp.items.splice(comp.items.indexOf(it), 1); info(); contactSoon(); }
    else if (k === "d" && comp.selected) { snap(); const it = comp.selected; const M = new THREE.Matrix4().makeTranslation(2, 0, 1).multiply(it.M); select(await addItems([{ params: it.params, M }])); }
    else if (k === "escape") select(null);
  });
  // the compose panel
  row(`<hr style="border-color:#5a4a36"><b>Compose</b><br><span style="color:#b9a888">click a piece · W (Z) move · E turn · R stretch · Q (A) local/world · D duplicate · Del delete · Esc · Ctrl+Z undo · Ctrl+Y redo</span>`);
  const pal = row(Object.entries(PIECES).map(([k, p]) => `<button data-p="${k}" style="margin:2px">+ ${p.label}</button>`).join(""));
  pal.querySelectorAll("button").forEach((b) => (b.onclick = () => addPiece(b.dataset.p)));
  const ops = row(`<button id="c-reshape">Reshape selected</button> <button id="c-look">Sliders' look → selected</button> <button id="c-lookall">→ all pieces</button>`);
  ops.querySelector("#c-reshape").onclick = async () => {
    const it = comp.selected; if (!it) return;
    snap();
    it.params = { ...it.params, seed: 1 + Math.floor(Math.random() * 9999) };
    await prewarmPieces([it.params]); shape(it); tc.attach(it.pivot); info();
  };
  ops.querySelector("#c-look").onclick = async () => {
    const it = comp.selected; if (!it || !it.params._kind) return;
    snap();
    it.params = { ...pieceParams({ kind: it.params._kind, seed: it.params.seed, ...look() }), _kind: it.params._kind };
    await prewarmPieces([it.params]); shape(it); tc.attach(it.pivot); info();
  };
  ops.querySelector("#c-lookall").onclick = async () => {
    const list = comp.items.filter((it) => it.params._kind);
    snap();
    for (const it of list) it.params = { ...pieceParams({ kind: it.params._kind, seed: it.params.seed, ...look() }), _kind: it.params._kind };
    compStatus.textContent = "rebuilding…";
    await prewarmPieces(list.map((it) => it.params)); for (const it of list) shape(it); if (comp.selected) tc.attach(comp.selected.pivot); info();
  };
  const fromF = row(`<button id="c-undo">↶ Undo</button> <button id="c-redo">↷ Redo</button> <button id="c-from">Formation → pieces</button> <button id="c-clear">Clear</button>`);
  fromF.querySelector("#c-undo").onclick = () => undo(); fromF.querySelector("#c-redo").onclick = () => redo();
  fromF.querySelector("#c-from").onclick = async () => { snap(); await addItems(formationItems(state.kind, state.seed, state.opts), true); if (mesh) mesh.visible = false; };
  fromF.querySelector("#c-clear").onclick = async () => { snap(); await addItems([], true); if (mesh) mesh.visible = true; };
  const KEY = "rockLab.compositions";
  const saved = () => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; } };
  const sv = row(`<input id="c-name" placeholder="name" style="width:80px"> <button id="c-save">Save</button> <select id="c-load"><option value="">load…</option></select> <button id="c-json">Copy JSON</button>`);
  const fillLoad = () => { const sel = sv.querySelector("#c-load"); sel.innerHTML = `<option value="">load…</option>` + Object.keys(saved()).map((n) => `<option>${n}</option>`).join(""); };
  const dump = () => comp.items.map((it) => ({ params: it.params, matrix: it.M.toArray().map((v) => +v.toFixed(4)) }));
  sv.querySelector("#c-save").onclick = () => {
    const name = sv.querySelector("#c-name").value.trim() || `rock ${Object.keys(saved()).length + 1}`;
    const all = saved(); all[name] = dump();
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch {}
    fillLoad(); compStatus.textContent = `saved "${name}" (${comp.items.length} pieces)`;
  };
  sv.querySelector("#c-load").onchange = async (e) => { const c = saved()[e.target.value]; if (c) { snap(); await addItems(c, true); if (mesh) mesh.visible = false; } };
  sv.querySelector("#c-json").onclick = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(dump())); compStatus.textContent = "copied to the clipboard"; } catch { compStatus.textContent = "(clipboard refused)"; }
  };
  const compStatus = row(`<span style="color:#b9a888"></span>`).firstElementChild;
  fillLoad();
  // ── LIFE ON THE LEDGES and THE TALUS (you: "continue" — the cliff list's 4 and 5) ──────────────────────────────
  // PLANTS: the game's own (PlacedFoliage, FOLIAGE_PRESETS — alfa tussocks, broom, a little juniper) on every ledge and
  // top that faces up, kept off the edges, as dense as the slider; re-sown after every change.
  const pf = new PlacedFoliage({ scene, lodDistances: [60, 140], shadowLods: 2 });
  pf.setSunDir(SUN.dir);
  for (const k of ["alfa", "broom", "juniperScrub"]) if (FOLIAGE_PRESETS[k]) pf.setType(k, structuredClone(FOLIAGE_PRESETS[k]));
  const life = { plants: 0.5 };
  function sow() {
    pf.removeWhere(() => true);
    if (!(life.plants > 0) || !comp.items.length) return;
    const rnd = (() => { let a = 987; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
    const v = new THREE.Vector3(), nrm = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), rc = new THREE.Raycaster();
    const meshes = comp.items.map((it) => it.mesh);
    for (const it of comp.items) {
      it.mesh.updateMatrixWorld(true);
      const p = it.mesh.geometry.attributes.position, n = it.mesh.geometry.attributes.normal, idx = it.mesh.geometry.index;
      for (let t = 0; t < idx.count; t += 3) {
        const a = idx.getX(t);
        nrm.set(n.getX(a), n.getY(a), n.getZ(a));
        if (nrm.y < 0.85 || rnd() > life.plants * 0.02) continue;
        v.set(p.getX(a), p.getY(a), p.getZ(a)).applyMatrix4(it.mesh.matrixWorld);
        if (v.y < 0.6) continue;                                           // (the ground has its own plants)
        // nothing over it (a ledge under an overhang stays bare), and not on the very edge (a test 0.6 m in each way)
        rc.set(v.clone().add(new THREE.Vector3(0, 0.05, 0)), up); if (rc.intersectObjects(meshes, false).length) continue;
        let edge = false;
        for (const [dx, dz] of [[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]]) { rc.set(new THREE.Vector3(v.x + dx, v.y + 0.5, v.z + dz), up.clone().negate()); const h = rc.intersectObjects(meshes, false)[0]; if (!h || Math.abs(h.point.y - v.y) > 0.35) { edge = true; break; } }
        if (edge) continue;
        const r = rnd(), key = r < 0.72 ? "alfa" : r < 0.92 ? "broom" : "juniperScrub";
        if (!pf.types.has(key)) continue;
        pf.add(key, v.x, v.y - 0.04, v.z, { rotY: rnd() * 6.28, scale: (key === "alfa" ? 0.55 : 0.4) + rnd() * 0.45, seed: rnd() });
      }
    }
  }
  let sowT = null;
  const sowSoon = () => { clearTimeout(sowT); sowT = setTimeout(sow, 300); };
  // TALUS: fallen blocks and scree round the foot of the composition — real pieces (editable, undoable), small pillows
  // and loaves sunk into the ground, thickest against the walls, a few rolled further out
  async function talus(count = 40) {
    if (!comp.items.length) return;
    snap();
    const rnd = Math.random, list = [];
    const foot = [];
    for (const it of comp.items) {
      const p = it.mesh.geometry.attributes.position;
      // (a piece's geometry is already in the composition's space: its pivot and its offset cancel)
      for (let i = 0; i < p.count; i += 7) if (p.getY(i) < 0.8) foot.push([p.getX(i), p.getZ(i)]);
    }
    if (!foot.length) return;
    const cx = foot.reduce((a, q) => a + q[0], 0) / foot.length, cz = foot.reduce((a, q) => a + q[1], 0) / foot.length;
    // (not inside a piece or under it: a ray down from above must reach the ground first — half the first ones were
    // buried in the walls, seen)
    const rc = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0), meshes = comp.items.map((it) => it.mesh);
    group.updateMatrixWorld(true);
    const clear = (x, z) => { rc.set(new THREE.Vector3(x + group.position.x, 60, z + group.position.z), down); const h = rc.intersectObjects(meshes, false)[0]; return !h || h.point.y < 0.3; };
    for (let k = 0, tries = 0; k < count && tries < count * 20; tries++) {
      const [fx, fz] = foot[Math.floor(rnd() * foot.length)];
      const dx = fx - cx, dz = fz - cz, L = Math.hypot(dx, dz) || 1, out = 0.2 + Math.pow(rnd(), 2) * 3.5;
      const x = fx + (dx / L) * out, z = fz + (dz / L) * out;
      if (!clear(x, z)) continue;
      k++;
      const big = rnd() < 0.3, s = big ? 0.32 + rnd() * 0.3 : 0.1 + rnd() * 0.18;   // (a big fallen block 1-3 m, scree 0.3-1 m)
      const kind = rnd() < 0.6 ? "pillow" : "loaf";
      const params = { ...pieceParams({ kind, seed: 1 + Math.floor(rnd() * 9999), ...look() }), _kind: kind };
      const M = new THREE.Matrix4().compose(new THREE.Vector3(x, -0.15 * s * 3, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.6, rnd() * 6.28, (rnd() - 0.5) * 0.6)),
        new THREE.Vector3(s * (0.8 + rnd() * 0.5), s * (0.6 + rnd() * 0.4), s * (0.8 + rnd() * 0.5)));
      list.push({ params, M });
    }
    await addItems(list);
  }
  const lifeRow = row(`<hr style="border-color:#5a4a36"><b>Foot and ledges</b>`);
  void lifeRow;
  for (const [key, name, obj, min, max, apply] of [
    ["plants", "Plants on the ledges", life, 0, 1, () => sowSoon()],
    ["groundBlend", "Foot into the ground", null, 0, 1, null],
    ["groundRise", "… how high (m)", null, 0.2, 3, null],
  ]) {
    const val = obj ? obj[key] : sandstoneLook[key].value;
    const d = row(`<div style="display:flex;justify-content:space-between"><span>${name}</span><span>${val}</span></div><input type="range" min="${min}" max="${max}" step="0.05" value="${val}" style="width:100%">`);
    const inp = d.querySelector("input"), out = d.querySelectorAll("span")[1];
    inp.oninput = () => { out.textContent = inp.value; if (obj) obj[key] = Number(inp.value); else sandstoneLook[key].value = Number(inp.value); apply?.(); };
  }
  const tal = row(`<button id="c-talus">+ Talus (fallen blocks, scree)</button>`);
  tal.querySelector("#c-talus").onclick = () => talus();

  buildSliders();
  view("play");
  await rebuild();
  addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
  renderer.setAnimationLoop(() => { controls.update(); pf.update(camera); renderer.render(scene, camera); });
  return { scene, camera, controls, state, rebuild, view, comp, addPiece, select, bake, talus, sow, life, dump: () => comp.items.map((it) => ({ params: it.params, matrix: it.M.toArray() })), get mesh() { return mesh; } };
}
