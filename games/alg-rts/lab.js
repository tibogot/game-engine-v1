// THE LAB, REBUILT (2026-10-19, you: "a better-looking building lab, readable, UI/UX friendly … one for the
// whole game"). One page, every building of the game, no reload between them:
//   SECTIONS    Buildings · Plants & foliage · Rocks (2026-10-25, you: "the plants and the buildings should not be in the
//               same menu … everything in the same page but separated") — the list, filters, search and ← → per section
//   CATALOGUE   the old lab's pieces (buildingLab.js BUILDINGS — their builders, versions, tags, notes) with
//               labCatalog.js's side / kind / maps / status: search, filter chips, thumbnail cards
//   THE PIECE   its versions side by side (old / new / damaged / ruin…), tabs to isolate one
//   VIEWS       the game's RTS camera (its 26° lens, 38 / 102 / 134 m), a close-up, an orbit; day / dusk / night
//   NUMBERS     triangles (near / far for an LOD), draws, textures, the LOD distance — and the frame's draws and
//               triangles live (renderer.info)
//   PLAYERS     a piece's construction (0-100 %, play — the helipad, the sangar: entries with `construction`)
//   KEYS        ← → the previous / next piece of the list, / search, 1-4 the views, Esc clears the search
//   FIRE        a piece with a mortar tube lobs the game's bombs at a target 80 m out (follow the shell, slow ×0.1)
//   PLANTS      every species the game grows, a bed of three, and the steppe (plant-lab.html folded in, 2026-10-25)
//   PIECE       a piece's own tools: a seeded piece's variants, a rock's look, the supply point's capture
//               (buildingLab.js pieceTools — the old page's panels; building-lab.html deleted 2026-10-25: one lab)
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { color, mx_noise_float, normalMap, texture, uv, vec3 } from "three/tsl";
import { hexSample } from "../../v3/render/hexTiling.js";
import { initGlbLoaderRenderer } from "../../v3/render/foliage/glbLoader.js";
import { BUILDINGS, LAB_STONES, applyLabStone, labSite, labTick, pieceTools } from "./buildingLab.js";
import { NIGHT, SUN, gradientSky, vehicleOf } from "./vehicleLab.js";
import { KINDS, MAPS, NAMES, SIDES, STATUS, enTag, metaOf } from "./labCatalog.js";
import { createCombatFx } from "../shared-rts/combatFx.js";
import { kitPhotoMaterial } from "./algKitPhoto.js";
import { FR_PAINT_TINT } from "../../v3/render/objects/rtsVehiclesFr.js";
import { createProjectiles } from "../shared-rts/projectiles.js";
const nameOf = (k) => NAMES[k] ?? BUILDINGS[k]?.label ?? k;

const $ = (id) => document.getElementById(id);
const SIDE_W = 330;
const store = {
  get(k, d) { try { const v = localStorage.getItem(`lab.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`lab.${k}`, JSON.stringify(v)); } catch { /* private window: no memory, fine */ } },
};
const ICON = { base: "⛺", defense: "🛡", village: "🏠", fln: "⛰", ruine: "🏛", nature: "🪨", plant: "🌿", field: "🌾", prop: "🪵", point: "📍", autre: "▫" };

export async function startLab() {
  // ── The scene: the old lab's light and sky, a bigger ground (villages) ──────────────────────
  const view = $("view");
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(view.clientWidth, view.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.55;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  view.appendChild(renderer.domElement);
  await renderer.init();
  initGlbLoaderRenderer(renderer);
  await applyLabStone("aures");   // (the Aurès stone: the « Wall stone » box compares the old one)

  const scene = new THREE.Scene();
  const skyDay = gradientSky(1), skyDusk = gradientSky(0.45), skyNight = gradientSky(0.035);
  scene.environment = scene.background = skyDay;
  const camera = new THREE.PerspectiveCamera(26, view.clientWidth / view.clientHeight, 0.1, 3000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  const sun = new THREE.DirectionalLight(SUN.color, SUN.intensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = 0; sun.shadow.normalBias = 0.12; sun.shadow.radius = 2;
  scene.add(sun, sun.target);
  const loader = new THREE.TextureLoader();
  const tex = (f, srgb) => {
    const t = loader.load(`/textures/ground/dry_mud_field_001/dry_mud_field_001_${f}_1k.jpg`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  // THE GROUND WITHOUT ITS TILE (2026-10-25, you: "the terrain texture is tiling … even if it's a lab it will look
  // better"): the terrain's hex tiling (v3/render/hexTiling.js hexSample — every cell of a hex lattice a different window of
  // the photo, offsets only: turned cells point a scanned photo's baked shadows every which way) for its colour and
  // its relief, and a faint 30 m colour drift so a big ground does not read flat. 4 m a repeat, as before (640 / 160).
  const gUv = uv().mul(160), drift = mx_noise_float(vec3(uv().mul(21), 0.0)).mul(0.09).add(1);
  const gMat = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
  gMat.colorNode = hexSample(texture(tex("diff", true)), gUv, null, { rotate: false }).rgb.mul(color(0xd8c6a8)).mul(drift);
  gMat.normalNode = normalMap(hexSample(texture(tex("nor_gl")), gUv, null, { rotate: false }).rgb);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(640, 640).rotateX(-Math.PI / 2), gMat);
  ground.receiveShadow = true;
  scene.add(ground);
  // a man at the game's scale, for size
  const man = new THREE.Mesh(new THREE.CapsuleGeometry(0.29, 1.7, 4, 10), new THREE.MeshStandardNodeMaterial({ color: 0x6f6a4c, roughness: 0.9 }));
  man.castShadow = true;
  scene.add(man);

  // ── State ───────────────────────────────────────────────────────────────────────────────────
  const keys = Object.keys(BUILDINGS);
  const filters = store.get("filters", { side: [], kind: [], map: [], status: [] });
  // THE SECTIONS: by the piece's kind (labCatalog KINDS)
  const SECTIONS = [["build", "Buildings", (k) => k !== "plant" && k !== "nature"], ["plant", "Plants & foliage", (k) => k === "plant"], ["rock", "Rocks", (k) => k === "nature"]];
  const sectionOf = (key) => SECTIONS.find(([, , inS]) => inS(metaOf(key).kind))?.[0] ?? "build";
  let section = store.get("section", "build");
  const inSection = (key) => sectionOf(key) === section;
  let query = "";
  let cur = null;          // { key, versions: [{ label, group, stats }], focus: -1 }
  let viewMode = store.get("view", "rts");
  let light = "day";
  let busy = false;
  const thumbs = new Map();
  for (const k of keys) { const t = store.get(`thumb.${k}`, null); if (t) thumbs.set(k, t); }

  // ── The catalogue panel ─────────────────────────────────────────────────────────────────────
  const GROUPS = [["side", "Side", SIDES], ["kind", "Kind", KINDS], ["map", "Map", MAPS], ["status", "Status", STATUS]];
  function renderFilters() {
    // (Kind: only the section's kinds — a row of one chip says nothing, so it goes)
    const kinds = Object.fromEntries(Object.entries(KINDS).filter(([k]) => SECTIONS.find(([s]) => s === section)[2](k)));
    // (the Side — French, FLN, civilian — is a building's: not a plant's or a rock's)
    $("filters").innerHTML = GROUPS.map(([g, label, opts]) => [g, label, g === "kind" ? kinds : opts]).filter(([g, , opts]) => Object.keys(opts).length > 1 && (g !== "side" || section === "build"))
      .map(([g, label, opts]) => `<div class="frow"><span>${label}</span>${Object.entries(opts).map(([k, v]) => `<button class="chip" data-g="${g}" data-k="${k}">${v}</button>`).join("")}</div>`).join("");
    syncChips();
  }
  function renderSections() {
    $("sections").innerHTML = SECTIONS.map(([s, label]) => `<button class="sec${s === section ? " on" : ""}" data-s="${s}">${label}<small>${keys.filter((k) => sectionOf(k) === s).length} pieces</small></button>`).join("");
  }
  function setSection(s, { open = true } = {}) {
    if (s === section && $("sections").innerHTML) return;
    section = s; store.set("section", s);
    filters.kind = filters.kind.filter((k) => SECTIONS.find(([x]) => x === s)[2](k)); store.set("filters", filters);
    renderSections(); renderFilters(); renderList();
    $("stoneBox").style.display = s === "build" ? "" : "none";   // (the kit's wall stone: buildings only)
    if (open && !inSection(cur?.key)) { const first = visible()[0]; if (first) show(first); }
  }
  $("sections").addEventListener("click", (e) => { const b = e.target.closest(".sec"); if (b) setSection(b.dataset.s); });
  const syncChips = () => { for (const b of $("filters").querySelectorAll(".chip")) b.classList.toggle("on", filters[b.dataset.g].includes(b.dataset.k)); };
  $("filters").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    const arr = filters[b.dataset.g], i = arr.indexOf(b.dataset.k);
    if (i >= 0) arr.splice(i, 1); else arr.push(b.dataset.k);
    store.set("filters", filters); syncChips(); renderList();
  });
  $("search").addEventListener("input", (e) => { query = e.target.value.trim().toLowerCase(); renderList(); });
  const visible = () => keys.filter((k) => {
    const m = metaOf(k), e = BUILDINGS[k];
    if (!inSection(k)) return false;
    if (filters.side.length && !filters.side.includes(m.side)) return false;
    if (filters.kind.length && !filters.kind.includes(m.kind)) return false;
    if (filters.map.length && !m.maps.some((x) => filters.map.includes(x))) return false;
    if (filters.status.length && !filters.status.includes(m.status)) return false;
    if (query && !`${nameOf(k)} ${e.label ?? ""} ${k} ${(e.tags ?? []).map(enTag).join(" ")}`.toLowerCase().includes(query)) return false;
    return true;
  });
  function renderList() {
    const list = visible();
    $("count").innerHTML = `<span>${list.length} / ${keys.filter(inSection).length} pieces</span><button id="mkthumbs" title="Takes a thumbnail of every piece in the list">Make thumbnails</button>`;
    $("list").innerHTML = list.map((k) => {
      const m = metaOf(k), t = thumbs.get(k);
      return `<button class="card${cur?.key === k ? " on" : ""}" data-k="${k}"><div class="thumb" style="${t ? `background-image:url(${t})` : ""}">${t ? "" : ICON[m.kind] ?? "▫"}</div>
        <div class="t">${nameOf(k)}<br><span class="badge b-${m.status}">${STATUS[m.status] ?? m.status}</span></div></button>`;
    }).join("");
    $("mkthumbs").onclick = () => makeThumbs(list);
  }
  $("list").addEventListener("click", (e) => { const c = e.target.closest(".card"); if (c) show(c.dataset.k); });

  // ── The tools panel ─────────────────────────────────────────────────────────────────────────
  const VIEWS = { rts: "RTS (102 m)", near: "RTS near (38 m)", far: "RTS far (134 m)", close: "Close-up", orbit: "Orbit" };
  $("tools").innerHTML = `
    <div class="box"><h3>View</h3><div class="btns" id="views">${Object.entries(VIEWS).map(([k, v], i) => `<button class="btn" data-v="${k}" title="${i + 1}">${v}</button>`).join("")}</div></div>
    <div class="box"><h3>Light (simple — not the game's look)</h3><div class="btns" id="lights"><button class="btn" data-l="day">Day</button><button class="btn" data-l="dusk">Dusk</button><button class="btn" data-l="night">Night</button></div></div>
    <div class="box" id="fireBox" style="display:none"><h3>Fire</h3><div class="btns" id="fireBtns"><button class="btn" data-f="fire">Fire</button><button class="btn" data-f="follow">Follow the shell</button><button class="btn" data-f="slow">Slow ×0.1</button></div></div>
    <div class="box" id="pieceBox" style="display:none"><h3>Piece</h3><div id="pieceTools"></div></div>
    <div class="box" id="buildBox" style="display:none"><h3>Construction</h3><input type="range" id="buildP" min="0" max="100" value="100" /><div class="btns" style="margin-top:6px"><button class="btn" id="buildPlay">▶ Play (22 s)</button><span id="buildPct" class="keys" style="align-self:center"></span></div></div>
    <div class="box" id="stoneBox"><h3>Wall stone (the old kit's walls)</h3><div class="btns" id="stones">${Object.entries(LAB_STONES).map(([k, v]) => `<button class="btn" data-s="${k}">${v}</button>`).join("")}</div></div>
    <div class="box"><h3>Numbers</h3><table class="stats" id="stats"></table></div>
    <div class="box"><h3>Frame</h3><table class="stats" id="live"></table></div>
    <div class="box keys">← → previous / next piece · / search · 1-5 views · Esc clears</div>`;
  $("views").addEventListener("click", (e) => { const b = e.target.closest(".btn"); if (b) setView(b.dataset.v); });
  $("lights").addEventListener("click", (e) => { const b = e.target.closest(".btn"); if (b) setLight(b.dataset.l); });
  $("stones").addEventListener("click", (e) => { const b = e.target.closest(".btn"); if (b) { applyLabStone(b.dataset.s); markOn("stones", "s", b.dataset.s); } });
  const markOn = (box, attr, val) => { for (const b of $(box).querySelectorAll(".btn")) b.classList.toggle("on", b.dataset[attr] === val); };

  function setLight(l) {
    light = l;
    const d = l === "dusk" ? new THREE.Vector3(-0.8, 0.22, 0.4).normalize() : SUN.dir;
    sun.position.copy(d).multiplyScalar(300).add(sun.target.position);
    sun.intensity = l === "night" ? NIGHT.intensity : l === "dusk" ? 6 : SUN.intensity;
    sun.color.set(l === "night" ? NIGHT.color : l === "dusk" ? 0xffc58a : SUN.color);
    scene.environment = scene.background = l === "night" ? skyNight : l === "dusk" ? skyDusk : skyDay;
    renderer.toneMappingExposure = l === "night" ? NIGHT.exposure * 0.55 : l === "dusk" ? 0.66 : 0.55;
    markOn("lights", "l", l);
  }

  // What is framed: the isolated version, else all of them.
  const framed = () => (cur ? (cur.focus >= 0 ? [cur.versions[cur.focus]] : cur.versions) : []);
  function box() {
    const b = new THREE.Box3();
    for (const v of framed()) b.expandByObject(v.group);
    if (b.isEmpty()) b.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 5, 5));
    return b;
  }
  function setView(v) {
    viewMode = v; store.set("view", v); markOn("views", "v", v);
    const b = box(), c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3());
    controls.autoRotate = v === "orbit"; controls.autoRotateSpeed = 0.8;
    const rts = { rts: 102, near: 38, far: 134 }[v];
    if (rts) {
      // the game's camera: its 26° lens, pitched ~47°, the yaw the old lab looked from
      camera.fov = 26; camera.updateProjectionMatrix();
      const p = (47 * Math.PI) / 180;
      controls.target.set(c.x, 0.8, c.z);
      camera.position.set(c.x + Math.sin(0.35) * Math.cos(p) * rts, Math.sin(p) * rts, c.z + Math.cos(0.35) * Math.cos(p) * rts);
    } else {
      camera.fov = 40; camera.updateProjectionMatrix();
      const r = Math.max(size.x, size.y * 1.4, size.z) * (v === "close" ? 0.75 : 1.1) + 4;
      controls.target.set(c.x, Math.min(size.y * 0.4, 4), c.z);
      camera.position.set(c.x + r * 0.42, Math.max(3, size.y * 0.6 + r * 0.4), c.z + r * 0.9);
    }
    controls.update();
  }
  function fitShadow() {
    const b = box(), c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
    const h = Math.max(s.x, s.z) * 0.75 + 8;
    sun.target.position.set(c.x, 0, c.z);
    Object.assign(sun.shadow.camera, { left: -h, right: h, top: h, bottom: -h, near: 1, far: 900 });
    sun.shadow.camera.updateProjectionMatrix();
    setLight(light);
  }

  // ── The numbers ─────────────────────────────────────────────────────────────────────────────
  function statsOf(group) {
    let near = 0, far = 0, draws = 0, lodAt = 0;
    const tex = new Map();
    const tri = (m) => ((m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position?.count ?? 0) / 3) * (m.isInstancedMesh ? m.count : 1);
    const walk = (o, level) => {
      if (o.visible === false) return;   // (a hidden subtree: the construction's dressing, a lab-only extra)
      if (o.isLOD) {
        lodAt = Math.max(lodAt, o.levels[1]?.distance ?? 0);
        o.levels.forEach((l, i) => walk(l.object, i === 0 ? "near" : "far"));
        return;
      }
      if (o.isMesh && o.visible !== false && o.material?.visible !== false) {
        const t = tri(o);
        if (level !== "far") near += t;
        if (level !== "near") far += t;
        if (level !== "far") draws++;
        for (const m of [].concat(o.material)) if (m?.map?.image) tex.set(m.map, m.map.image.width ?? 0);
      }
      for (const c of o.children) walk(c, level);
    };
    for (const c of group.children) walk(c, null);
    return { near: Math.round(near), far: lodAt ? Math.round(far) : null, draws, lodAt, tex: [...tex.values()] };
  }
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  function renderStats() {
    if (!cur) return;
    $("stats").innerHTML = cur.versions.map((v) => {
      const s = v.stats;
      return `<tr class="h"><td colspan="2">${v.label}</td></tr>
        <tr><td>Triangles${s.far != null ? " near / far" : ""}</td><td>${k(s.near)}${s.far != null ? ` / ${k(s.far)}` : ""}</td></tr>
        <tr><td>Draws</td><td>${s.draws}</td></tr>
        <tr><td>Textures</td><td>${s.tex.length ? s.tex.join(", ") : "kit atlas"}</td></tr>
        ${s.lodAt ? `<tr><td>LOD far from</td><td>${s.lodAt} m</td></tr>` : `<tr><td>LOD</td><td>—</td></tr>`}`;
    }).join("");
  }
  let liveT = 0;
  function renderLive(dt) {
    liveT += dt;
    if (liveT < 0.5) return;
    liveT = 0;
    const i = renderer.info.render;
    const d = camera.position.distanceTo(controls.target);
    $("live").innerHTML = `<tr><td>Draws (incl. shadow)</td><td>${i.drawCalls ?? i.calls ?? "?"}</td></tr><tr><td>Triangles drawn</td><td>${k(i.triangles ?? 0)}</td></tr><tr><td>Camera</td><td>${d.toFixed(0)} m</td></tr>`;
  }

  // ── Show a piece ────────────────────────────────────────────────────────────────────────────
  async function show(key) {
    if (busy || !BUILDINGS[key]) return;
    busy = true;
    $("loading").style.display = "block";
    try {
      const E = BUILDINGS[key];
      if (E.prepare) await E.prepare(renderer);
      for (const v of cur?.versions ?? []) scene.remove(v.group);
      const geos = [E.before ? E.before() : E.build?.(), E.middle?.(), E.after ? E.after() : E.build?.({ detail: 2, crew: false })].filter(Boolean);
      const tags = E.tags ?? (geos.length === 2 ? ["Old", "New"] : geos.map((_, i) => `Version ${i + 1}`));
      const gap = E.gap ?? 8, yaw = E.yaw ?? -0.6;
      const xs = geos.length === 3 ? [-gap, 0, gap] : geos.length === 2 ? [-gap, gap] : [0];
      const versions = geos.map((g, i) => {
        // (a kit piece in the GAME's material — showroom kitView: the kit's colours with the photos' grain and relief,
        // on by default — not the vehicle lab's plain one: every old kit piece read unlike the game, 2026-10-25)
        if (g.isBufferGeometry && !g.userData.labMaterial) g.userData.labMaterial = kitPhotoMaterial(FR_PAINT_TINT);
        const v = vehicleOf(g, key);
        v.group.position.x = xs[i];
        v.group.rotation.y = yaw;
        scene.add(v.group);
        return { label: enTag(tags[i] ?? `Version ${i + 1}`), group: v.group, stats: statsOf(v.group), v };
      });
      cur = { key, versions, focus: -1 };
      man.position.set(0, 1.14, (box().max.z) + 3);
      // the bar
      $("title").textContent = nameOf(key);
      const m = metaOf(key);
      $("note").textContent = `${SIDES[m.side] ?? m.side} · ${KINDS[m.kind] ?? m.kind} · ${m.maps.map((x) => MAPS[x]).join(", ") || "—"} · ${STATUS[m.status] ?? ""}`;
      $("tabs").innerHTML = (versions.length > 1 ? `<button class="btn on" data-f="-1">All</button>` : "") + versions.map((v, i) => `<button class="btn" data-f="${i}">${v.label}</button>`).join("");
      fitShadow();
      setView(viewMode === "orbit" ? "rts" : viewMode);
      renderStats();
      // the helipad's construction
      const site = BUILDINGS[key]?.construction ? labSite() : null;   // (an entry that plays its construction: the helipad, the sangar)
      $("buildBox").style.display = site ? "" : "none";
      if (site) { $("buildP").value = 100; setBuild(1); }
      setFire(versions);
      // its own tools (variants, a rock's look, the point's capture)
      tools?.dispose(); tools = pieceTools(key, versions);
      $("pieceBox").style.display = tools ? "" : "none";
      const el = $("pieceTools").cloneNode(false); $("pieceTools").replaceWith(el);   // (the last piece's listeners gone)
      if (tools) { el.innerHTML = tools.html; tools.bind(el); }
      history.replaceState(null, "", `${location.pathname}?p=${key}`);   // (not "?p=": the page's <base href="/v3/"> would take it)
      for (const c of $("list").querySelectorAll(".card")) c.classList.toggle("on", c.dataset.k === key);
      $("list").querySelector(`.card[data-k="${key}"]`)?.scrollIntoView({ block: "nearest" });
      // its thumbnail, once it has settled
      if (!thumbs.has(key)) setTimeout(() => { if (cur?.key === key) snap(key); }, 1500);
    } catch (e) {
      console.error("[lab]", key, e);
      $("err").textContent = `${key}: ${e?.message ?? e}`;
    } finally {
      $("loading").style.display = "none";
      busy = false;
    }
  }
  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".btn"); if (!b || !cur) return;
    cur.focus = Number(b.dataset.f);
    cur.versions.forEach((v, i) => { v.group.visible = cur.focus < 0 || i === cur.focus; });
    for (const x of $("tabs").querySelectorAll(".btn")) x.classList.toggle("on", x === b);
    fitShadow(); setView(viewMode === "orbit" ? "orbit" : viewMode);
  });

  let tools = null;   // the shown piece's own tools (pieceTools)

  // ── Fire: a mortar lobs the game's own bombs (projectiles + combatFx, as the old lab's vehicle scene did —
  // the 81 mm's look, 2026-10-14) at a target 80 m in front of its tube; its tube kicks back ─────────────────
  let fire = null;   // { fx, shots, shooters, on, follow, scale }
  function setFire(versions) {
    const guns = versions.filter((q) => q.v?.gun?.muzzle && q.v.gunMesh);
    if (fire) { for (const t of fire.targets) scene.remove(t); fire.shooters = []; fire.targets = []; fire.on = fire.follow = false; for (const b of $("fireBtns").querySelectorAll(".btn")) b.classList.remove("on"); }
    $("fireBox").style.display = guns.length ? "" : "none";
    if (!guns.length) return;
    if (!fire) {
      const app = { scene, renderer, camera, getWorldHeight: () => 0, light: { getDirection: () => sun.position.clone().normalize(), sun, hemi: null } };
      const fx = createCombatFx({ app, style: "coh", litSmoke: true });
      fx.shellLaunch ??= (p, d) => { fx.cannon?.(p.x + d.x * 0.3, p.y + d.y * 0.3, p.z + d.z * 0.3); };
      const shots = createProjectiles({ app, fx, weapons: {}, onImpact: () => {}, onArcImpact: (at) => fx.explosion?.(at.x, at.y, at.z, { size: 7 }) });
      fire = { fx, shots, shooters: [], targets: [], on: false, follow: false, scale: 1 };
    }
    for (const q of guns) {
      const sh = { v: q.v, cd: 0, target: new THREE.Vector3(q.group.position.x, 0, -80) };
      const t = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.4, 3.2), new THREE.MeshStandardNodeMaterial({ color: 0x4a4a3c, roughness: 0.9 }));
      t.position.set(sh.target.x, 0.7, sh.target.z); t.castShadow = true;
      scene.add(t); fire.targets.push(t); fire.shooters.push(sh);
    }
  }
  $("fireBtns").addEventListener("click", (e) => {
    const b = e.target.closest(".btn"); if (!b || !fire) return;
    if (b.dataset.f === "fire") fire.on = !fire.on;
    if (b.dataset.f === "follow") fire.follow = !fire.follow;
    if (b.dataset.f === "slow") fire.scale = fire.scale === 1 ? 0.1 : 1;
    b.classList.toggle("on", b.dataset.f === "fire" ? fire.on : b.dataset.f === "follow" ? fire.follow : fire.scale !== 1);
  });
  function fireStep(dt0) {
    if (!fire) return;
    const dt = dt0 * fire.scale;
    for (const sh of fire.shooters) {
      if (fire.on && (sh.cd -= dt) <= 0) {
        sh.cd = 3.5;
        sh.v.group.updateMatrixWorld(true);
        const from = new THREE.Vector3(...sh.v.gun.muzzle).applyMatrix4(sh.v.gunMesh.matrixWorld);
        fire.shots.spawnArc(from, sh.target.clone().add(new THREE.Vector3((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6)), { damage: 0, splash: 0, owner: null, kind: sh.v.gun.kind ?? "mortar81" });
        sh.recoil = 1;
      }
      // the tube driven back down its own line into the baseplate (kick = recoil²)
      sh.recoil = Math.max(0, (sh.recoil ?? 0) - dt * 2);
      sh.base ??= sh.v.gunMesh.position.clone();
      sh.v.gunMesh.position.copy(sh.base).addScaledVector(new THREE.Vector3(...(sh.v.gun.axis ?? [0, 1, 0])), -0.16 * sh.recoil ** 2);
    }
    fire.shots.update(dt, camera);
    fire.fx.update(dt, camera);
    if (fire.follow) {   // the camera beside the newest bomb in the air
      const s = fire.shots.shells.at(-1);
      if (s) { controls.target.copy(s.pos); camera.position.copy(s.pos).add(new THREE.Vector3(6.5, 1.6, -2.4)); }
    }
  }

  // ── The helipad's construction ──────────────────────────────────────────────────────────────
  let playT = null;
  function setBuild(p) {
    const site = labSite(); if (!site) return;
    site.set(p);
    cur?.versions.at(-1)?.group.traverse((o) => { if (o.material?.name === "RtsStencil") o.visible = site.stencilShown(p); });
    if (site.sock) site.sock.visible = p >= 0.9;
    $("buildPct").textContent = `${Math.round(p * 100)} %`;
  }
  $("buildP").addEventListener("input", (e) => { playT = null; setBuild(e.target.value / 100); });
  $("buildPlay").addEventListener("click", () => { playT = 0; });

  // ── Thumbnails: the canvas as it is, framed at the RTS view ─────────────────────────────────
  async function snap(key) {
    renderer.render(scene, camera);   // (read back in the same task: the canvas still holds this frame)
    const src = renderer.domElement, c = document.createElement("canvas");
    c.width = 220; c.height = 140;
    const s = Math.min(src.width / 220, src.height / 140), w = 220 * s, h = 140 * s;
    c.getContext("2d").drawImage(src, (src.width - w) / 2, (src.height - h) / 2, w, h, 0, 0, 220, 140);
    const url = c.toDataURL("image/jpeg", 0.72);
    if (url.length < 3000) return;   // (a blank capture: keep the icon)
    thumbs.set(key, url);
    store.set(`thumb.${key}`, url);
    const el = $("list").querySelector(`.card[data-k="${key}"] .thumb`);
    if (el) { el.style.backgroundImage = `url(${url})`; el.textContent = ""; }
  }
  async function makeThumbs(list) {
    const back = cur?.key, vm = viewMode;
    viewMode = "rts";
    for (const k of list) { await show(k); await new Promise((r) => setTimeout(r, 1200)); await snap(k); }
    viewMode = vm;
    if (back) show(back);
  }

  // ── Keys ────────────────────────────────────────────────────────────────────────────────────
  addEventListener("keydown", (e) => {
    if (e.target === $("search")) { if (e.key === "Escape") { $("search").value = ""; query = ""; renderList(); $("search").blur(); } return; }
    const list = visible(), i = list.indexOf(cur?.key);
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); show(list[(i + 1) % list.length]); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); show(list[(i - 1 + list.length) % list.length]); }
    else if (e.key === "/") { e.preventDefault(); $("search").focus(); }
    else if (/^[1-5]$/.test(e.key)) setView(Object.keys(VIEWS)[Number(e.key) - 1]);
  });
  addEventListener("resize", () => {
    renderer.setSize(view.clientWidth, view.clientHeight);
    camera.aspect = view.clientWidth / view.clientHeight; camera.updateProjectionMatrix();
  });

  // ── Go ──────────────────────────────────────────────────────────────────────────────────────
  const first = new URLSearchParams(location.search).get("p");
  section = BUILDINGS[first] ? sectionOf(first) : section;   // (a piece's link opens its section)
  renderSections(); renderFilters();
  renderList();
  $("stoneBox").style.display = section === "build" ? "" : "none";
  setLight("day");
  markOn("stones", "s", "aures");
  const timer = new THREE.Timer();
  renderer.setAnimationLoop(() => {
    timer.update();
    const dt = timer.getDelta();
    if (playT != null) { playT += dt; const p = Math.min(1, playT / 22); $("buildP").value = p * 100; setBuild(p); if (p >= 1) playT = null; }
    controls.update();
    labTick(camera);   // (the pieces' own per-frame work: the screen's plants)
    tools?.tick(dt);
    fireStep(dt);
    renderer.render(scene, camera);
    renderLive(dt);
  });
  await show(BUILDINGS[first] ? first : visible()[0] ?? keys[0]);
  return { renderer, scene, camera, controls, show, setView, setLight, get current() { return cur; } };
}
