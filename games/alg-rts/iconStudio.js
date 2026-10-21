// THE ICON STUDIO (2026-10-22 — you: "some of our assets are really good looking now, do we still need images? a
// thumbnail of them would look cool … the grenade is different, never built a AAA one"). The HUD's icons RENDERED
// from the game's own models, ONE house style for all:
//
//   the render   a fixed three-quarter camera fitted to the piece (or to a CROP of it — the mirador's cabin, not its
//                9 m of legs), a warm key light from the upper left, a cool fill, a rim from behind that separates it
//                from the dark; a transparent background.
//   the tile     composited in 2D: a dark warm backdrop (a soft radial glow behind the object), a thin dark OUTLINE
//                round the object (its alpha dilated) and a soft shadow under it, a touch of contrast — the object
//                reads at 48 px on the command card.
//   the orders   stay SYMBOLS (a hand for stop …): the same tile, the glyph in brass — things are pictures, commands are
//                symbols, told apart at a glance.
//
// Today's style test: five icons (sandbags, mirador, MG nest, the grenade, stop). Each tile at 256 px; window.__ICONS
// .png(name) gives its PNG (a data URL) to save.
import * as THREE from "three";
import { initGlbLoaderRenderer } from "../../v3/render/foliage/glbLoader.js";
import { loadSandbagWall, simulatedWallMesh } from "./algSandbags.js";
import * as P from "./algSangar.js";
const { loadMirador, miradorGeometry, loadMgNest, mgNestGeometry } = P;
import { kitView } from "./showroom.js";
import { houseMesh, loadHouses } from "./algHouse.js";
import { ICON } from "./ui/icons.js";
import { PlacedFoliage } from "../../v3/render/foliage/placedFoliage.js";
import { FOLIAGE_PRESETS } from "../../v3/app/state/foliageScatterState.js";

const R = 512, OUT = 256;          // the render, the tile

/** The F1 defensive grenade (the French army's, 1950s): a segmented cast-iron body, the fuze, the lever, the pin's ring. */
function grenade() {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0x4f5638, roughness: 0.55, metalness: 0.25 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x8d8d84, roughness: 0.35, metalness: 0.85 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb4924a, roughness: 0.35, metalness: 0.9 });
  // the body: an egg, its surface cut into the classic segments (5 rings × 8 columns of raised blocks)
  const prof = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40, y = -0.055 + 0.11 * t;
    prof.push(new THREE.Vector2(0.028 * Math.sin(Math.PI * Math.min(1, t * 1.02)) ** 0.75 + 0.0001, y));
  }
  const body = new THREE.LatheGeometry(prof, 64);
  const p = body.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), r = Math.hypot(x, z);
    if (r < 1e-4) continue;
    const a = Math.atan2(z, x), ring = (y + 0.055) / 0.11;
    const gv = Math.abs(Math.sin(ring * Math.PI * 5)), gh = Math.abs(Math.sin(a * 4));
    const groove = Math.min(gv, gh) < 0.16 ? 0.82 : 1;              // the grooves between the blocks
    p.setX(i, x * groove); p.setZ(i, z * groove);
  }
  body.computeVertexNormals();
  g.add(new THREE.Mesh(body, paint));
  // the fuze on top, its collar; the lever along the side; the pin and its ring
  const fuze = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.011, 0.024, 20), brass);
  fuze.position.y = 0.064; g.add(fuze);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.006, 20), steel);
  collar.position.y = 0.054; g.add(collar);
  // the lever: a strip from the fuze's head down the body's side, 3 mm off its surface (a box beside it floated)
  const rAt = (y) => { const t = (y + 0.055) / 0.11; return 0.028 * Math.sin(Math.PI * Math.min(1, Math.max(0, t * 1.02))) ** 0.75; };
  const pts = [];
  for (let k = 0; k <= 12; k++) { const y = 0.074 - (0.074 + 0.012) * (k / 12); pts.push(new THREE.Vector3(Math.max(0.012, rAt(y) + 0.0035), y, 0)); }
  const lv = [], li = [];
  pts.forEach((p) => { lv.push(p.x, p.y, -0.0045, p.x, p.y, 0.0045); });
  for (let k = 0; k < pts.length - 1; k++) { const a = k * 2; li.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.Float32BufferAttribute(lv, 3)); lg.setIndex(li); lg.computeVertexNormals();
  const lever = new THREE.Mesh(lg, new THREE.MeshStandardMaterial({ color: 0x8d8d84, roughness: 0.35, metalness: 0.85, side: THREE.DoubleSide }));
  g.add(lever);
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.006, 0.008), steel);
  top.position.set(0.006, 0.075, 0); g.add(top);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.013, 0.0018, 8, 32), steel);
  ring.position.set(-0.018, 0.07, 0.004); ring.rotation.y = 0.5; g.add(ring);
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.0012, 0.0012, 0.024, 6), steel);
  pin.rotation.z = Math.PI / 2; pin.position.set(-0.006, 0.07, 0.002); g.add(pin);
  g.rotation.z = 0.32;                                                  // slightly tilted, as the prompt had it
  return g;
}

/** Today's five. `view`: the camera's yaw / pitch (deg); `crop`: the part of the height to frame (0 the foot, 1 the top). */
const ICONS = [
  { name: "sandbags", title: "Sandbags", key: null, svg: "sandbags",
    make: async () => { await loadSandbagWall(); const w = simulatedWallMesh(); return w?.isLOD ? w.levels[0].object : w; }, view: [-22, 20], zoom: 0.4, light: 2.2 },   // (close on its middle: the whole 5 m wall was a thin strip)
  { name: "mirador", title: "Mirador", svg: "mirador",
    make: async () => { await loadMirador(); return kitView(miradorGeometry()); }, view: [-35, 12], crop: [0.62, 1.0], zoom: 0.72 },   // (the cabin and the top of its legs)
  { name: "mgNest", title: "MG nest", svg: "mgNest",
    // (FRAMED ON ITS GUN — the berm read as a pale disc at 48 px: the AA-52 over its ring of bags, the roof's edge behind)
    make: async () => { await loadMgNest(); return kitView(mgNestGeometry()); }, view: [150, 12], focus: "Gun", focusR: 0.85 },   // (from the FRONT: the gun toward us over the bags — from behind the roof hid it)   // (low and close: the gun over its ring, the berm cut by the frame)
  { name: "grenade", title: "Grenade", key: "G", svg: "grenade", view: [-24, 10], zoom: 0.82,
    // the Blender F1 (tools/blender/smallProps.py), baked like the buildings — the set's look
    make: async () => { await loadHouses("smallprops"); const m = houseMesh("grenade", "intact", 1); const o = m.children[0].levels[0].object.clone(); o.rotation.z = -0.3; return o; } },
  { name: "stop", title: "Stop (an order: a symbol)", key: "H", svg: "stop", symbol: true },
  // ── THE ABILITIES' KIT (tools/blender/smallProps.py) ──
  ...[["smoke", "Smoke", [-25, 14]], ["flare", "Flare", [-70, 10]], ["cutters", "Cut wire", [-20, 55]], ["mine", "Mine (FLN)", [-25, 32]],
    ["helmet", "Reinforce (helmet)", [-25, 20]], ["kepi", "Tier (kepi)", [-30, 18]], ["jerrycan", "Fuel", [-35, 16]], ["ammobox", "Munitions", [-25, 40]],
    ["detonator", "Detonate (FLN)", [-30, 20]], ["detector", "Sweep mines", [-60, 14]]]
    .map(([p, title, view]) => ({ name: p, title, svg: p, view, zoom: 0.85,
      make: async () => { await loadHouses("smallprops"); return houseMesh(p, "intact", 1).children[0].levels[0].object.clone(); } })),
  // ── THE REST OF THE BUILDINGS (2026-10-22): the Blender pieces, each framed on what says what it is ──
  ...[
    ["wire", "Barbed wire", "BarbedWire", "barbedWire", { view: [-20, 14], zoom: 0.26, light: 3.2, glow: 1 }],   // (thin strands: close on the coil, more light, a brighter backdrop behind it)
    ["mortarPit", "Mortar pit", "MortarPit", "mortarPit", { view: [120, 16], focus: "Gun", focusR: 1.0 }],   // (close on the tube: the weapon first)
    ["searchlight", "Searchlight tower", "Searchlight", "searchlight", { view: [150, 8], focus: "Lamp", focusR: 2.6 }],
    ["fortPoint", "Fortified point", "FortPoint", "fortPoint", { view: [-20, 34], focus: "SandbagFort", focusR: 3.6 }],   // (from behind, inside: the bags and the stores)
    ["forwardPost", "Forward post", "ForwardPost", "forwardPost", { view: [-35, 30], focus: "RadioBags", focusR: 3.4 }],   // (the post under its tarp, not its 10 m mast)
    ["aidStation", "Aid station", "AidStation", "aidStation", { view: [-40, 24], zoom: 0.7 }],
    ["sangar", "Sangar (FLN)", "Sangar", "sangar", { view: [150, 22], zoom: 0.72 }],
    ["armsCache", "Arms cache (FLN)", "ArmsCache", "armsCache", { view: [-35, 26], zoom: 0.72 }],
    ["ambushScreen", "Ambush screen (FLN)", "AmbushScreen", "ambushScreen", { view: [150, 20], zoom: 0.6, plants: true }],
    ["refuge", "Refuge (FLN)", "Refuge", "refuge", { view: [160, 18], zoom: 0.7, plants: true }],
    ["infirmary", "Infirmary (FLN)", "Infirmary", "infirmary", { view: [-30, 26], zoom: 0.68 }],
  ].map(([name, title, L, G, o]) => ({ name, title, svg: name, ...o,
    make: async () => { await P[`load${L}`](); const g = P[`${G}Geometry`](); const m = kitView(g); if (g.userData.labMaterial) m.material = g.userData.labMaterial; return o.plants ? withPlants(m, g) : m; } })),
];

/** A piece with its SCRUB (the game's plants — algSangar screenPlantSpots / refugePlantSpots), as the lab draws it. */
function withPlants(m, g) {
  const grp = new THREE.Group(); grp.add(m);
  const pf = new PlacedFoliage({ scene: grp, lodDistances: [70, 140], shadowLods: 2 });
  for (const k of ["broomCut", "juniperScrub"]) pf.setType(k, structuredClone(FOLIAGE_PRESETS[k]));
  for (const p of g.userData.screenPlants ?? []) pf.add(p.kind, p.x, p.y, p.z, { rotY: p.rot, scale: p.scale, seed: p.seed });
  grp.userData.pf = pf;
  return grp;
}

export async function startIconStudio() {
  const renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.setSize(R, R, false);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  await renderer.init();
  initGlbLoaderRenderer(renderer);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xd8d0bc, 0x2a2016, 0.9));
  const key = new THREE.DirectionalLight(0xffe2b8, 3.2);
  const fill = new THREE.DirectionalLight(0x9fb4d0, 0.8);
  const rim = new THREE.DirectionalLight(0xfff0d8, 2.4);
  scene.add(key, fill, rim, key.target, fill.target, rim.target);
  const camera = new THREE.PerspectiveCamera(22, 1, 0.01, 500);

  async function renderObject(obj, ic) {
    scene.add(obj);
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const [c0, c1] = ic.crop ?? [0, 1];
    const h = box.max.y - box.min.y;
    const fit = box.clone(); fit.min.y = box.min.y + h * c0; fit.max.y = box.min.y + h * c1;
    let sph = fit.getBoundingSphere(new THREE.Sphere());
    if (ic.focus) {   // a part of it in the frame (its world box's centre, a radius round it)
      const part = obj.getObjectByName(ic.focus);
      if (part) { const c = new THREE.Box3().setFromObject(part).getCenter(new THREE.Vector3()); sph = new THREE.Sphere(c, ic.focusR ?? 2); }
    }
    const yaw = THREE.MathUtils.degToRad(ic.view[0]), pitch = THREE.MathUtils.degToRad(ic.view[1]);
    const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const dist = (sph.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * (ic.zoom ?? 1);
    camera.position.copy(sph.center).addScaledVector(dir, dist);
    camera.near = dist * 0.05; camera.far = dist * 4;
    camera.lookAt(sph.center);
    camera.updateProjectionMatrix();
    // the lights in the camera's frame: key upper left in front, fill right, rim behind
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize().negate();
    const at = (x, y, z) => sph.center.clone().addScaledVector(right, x * dist).add(new THREE.Vector3(0, y * dist, 0)).addScaledVector(dir, z * dist);
    // (`light`: a piece whose material is tuned for the game's strong sun — the sandbags — gets more)
    const k = ic.light ?? 1;
    key.intensity = 3.2 * k; fill.intensity = 0.8 * k; rim.intensity = 2.4 * Math.sqrt(k);
    key.position.copy(at(-0.8, 1.0, 0.7)); fill.position.copy(at(1.0, 0.2, 0.5)); rim.position.copy(at(0.3, 0.8, -1.0));
    for (const l of [key, fill, rim]) l.target.position.copy(sph.center);
    // (the plants: their foliage built and placed for this camera over a few frames)
    if (obj.userData.pf) for (let k = 0; k < 30; k++) { obj.userData.pf.update(camera); await renderer.renderAsync(scene, camera); await new Promise((r) => setTimeout(r, 60)); }
    await renderer.renderAsync(scene, camera);
    const shot = document.createElement("canvas");
    shot.width = shot.height = R;
    shot.getContext("2d").drawImage(renderer.domElement, 0, 0);
    scene.remove(obj);
    return shot;
  }

  /** The house style: backdrop, shadow, outline, the object, contrast — at OUT px. */
  function tile(shot, ic = {}) {
    const c = document.createElement("canvas"); c.width = c.height = R;
    const x = c.getContext("2d");
    // the backdrop: dark warm, a soft glow behind the object, a vignette at the corners
    const g = x.createRadialGradient(R * 0.5, R * 0.42, R * 0.05, R * 0.5, R * 0.5, R * 0.75);
    g.addColorStop(0, ic.glow ? "#6a5a40" : "#3a2e1f"); g.addColorStop(0.55, "#1d1610"); g.addColorStop(1, "#0a0806");
    x.fillStyle = g; x.fillRect(0, 0, R, R);
    if (shot) {
      // the OUTLINE: the object's alpha dilated (a ring of offset copies), filled near-black
      const o = document.createElement("canvas"); o.width = o.height = R;
      const ox = o.getContext("2d");
      const w = 5;
      for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; ox.drawImage(shot, Math.cos(a) * w, Math.sin(a) * w); }
      ox.globalCompositeOperation = "source-in"; ox.fillStyle = "#070503"; ox.fillRect(0, 0, R, R);
      // a soft shadow under it
      x.save(); x.filter = "blur(10px)"; x.globalAlpha = 0.55; x.drawImage(o, 0, 10); x.restore();
      x.globalAlpha = 0.9; x.drawImage(o, 0, 0); x.globalAlpha = 1;
      x.save(); x.filter = "contrast(1.12) saturate(1.08)"; x.drawImage(shot, 0, 0); x.restore();
    }
    return down(c, OUT);
  }
  /** A symbol on the same tile: the glyph in brass, a dark outline. */
  async function symbolTile(svg) {
    const img = new Image();
    img.src = `/textures/ui/icons/${svg}.svg`;
    await img.decode();
    const glyph = document.createElement("canvas"); glyph.width = glyph.height = R;
    const gx = glyph.getContext("2d");
    const m = R * 0.18;
    gx.drawImage(img, m, m, R - 2 * m, R - 2 * m);
    gx.globalCompositeOperation = "source-in";
    const gg = gx.createLinearGradient(0, m, 0, R - m); gg.addColorStop(0, "#ffe3a3"); gg.addColorStop(1, "#d9a43c");
    gx.fillStyle = gg; gx.fillRect(0, 0, R, R);
    return tile(glyph);
  }
  /** Step-down resampling (halving): crisp at small sizes, no shimmer. */
  function down(src, size) {
    let c = src;
    while (c.width / 2 >= size) {
      const n = document.createElement("canvas"); n.width = n.height = c.width / 2;
      const nx = n.getContext("2d"); nx.imageSmoothingQuality = "high"; nx.drawImage(c, 0, 0, n.width, n.height);
      c = n;
    }
    if (c.width !== size) { const n = document.createElement("canvas"); n.width = n.height = size; const nx = n.getContext("2d"); nx.imageSmoothingQuality = "high"; nx.drawImage(c, 0, 0, size, size); c = n; }
    return c;
  }

  const grid = document.getElementById("grid"), status = document.getElementById("status");
  const out = {}, made = {};
  for (const ic of ICONS) {
    status.textContent = `Rendering ${ic.title}…`;
    let t;
    try {
      if (ic.symbol) t = await symbolTile(ic.svg);
      else { const o = await ic.make(); made[ic.name] = o.children.map((c) => c.name + ":" + c.type); t = tile(await renderObject(o, ic), ic); }
    } catch (e) { console.warn("[icons]", ic.name, e); continue; }
    out[ic.name] = t;
    const small = down(t, 48);
    const card = document.createElement("div"); card.className = "card";
    card.innerHTML = `<h2>${ic.title}</h2><div class="row"></div>`;
    const row = card.querySelector(".row");
    const big = document.createElement("img"); big.className = "big"; big.src = down(t, 128).toDataURL(); row.append(big);
    const sizes = document.createElement("div"); sizes.className = "sizes";
    const keyHtml = ic.key ? `<span class="key">${ic.key}</span>` : "";
    sizes.innerHTML = `<div class="pair"><div class="btn"><img src="${small.toDataURL()}">${keyHtml}</div><span>new, 48 px</span></div>
      <div class="pair"><div class="btn"><div class="mask" style="-webkit-mask-image:url(/textures/ui/icons/${ic.svg}.svg);mask-image:url(/textures/ui/icons/${ic.svg}.svg)"></div>${keyHtml}</div><span>today's</span></div>`;
    row.append(sizes);
    grid.append(card);
  }
  status.textContent = `${Object.keys(out).length} icons rendered.`;

  /**
   * THE ATLAS (the game's command card: ui/iconAtlas.js): every key the HUD has (ui/icons.js ICON, not the veterancy
   * chevrons and alert marks) as a 96 px tile — its RENDER where one is made (RENDER_FOR: the game key → the render),
   * else its silhouette as a brass SYMBOL on the same tile (the orders; the abilities still without a model).
   */
  const RENDER_FOR = { cutWire: "cutters", flnMine: "mine", flnWire: "mine", flnDetonate: "detonator", reinforce: "helmet", tier: "kepi", sweepMines: "detector" };
  async function atlas(size = 96, cols = 8) {
    const keys = Object.keys(ICON).filter((k) => !/^(vet\d|alert)/.test(k));
    const tiles = [];
    for (const k of keys) {
      const r = out[RENDER_FOR[k] ?? k];
      tiles.push(down(r && !ICONS.find((i) => i.name === (RENDER_FOR[k] ?? k))?.symbol ? r : await symbolTile(ICON[k]), size));
    }
    const rows = Math.ceil(tiles.length / cols);
    const c = document.createElement("canvas"); c.width = cols * size; c.height = rows * size;
    const x = c.getContext("2d");
    tiles.forEach((t, i) => x.drawImage(t, (i % cols) * size, Math.floor(i / cols) * size));
    return { keys, cols, rows, size, canvas: c };
  }
  /** Save the atlas (a download: alg-icons.webp) and give its index. */
  async function saveAtlas() {
    const A = await atlas();
    const a = document.createElement("a"); a.download = "alg-icons.webp"; a.href = A.canvas.toDataURL("image/webp", 0.92); a.click();
    return { keys: A.keys, cols: A.cols, rows: A.rows, size: A.size };
  }
  return { renderer, made, saveAtlas, png: (name) => out[name]?.toDataURL("image/png") ?? null, names: Object.keys(out) };
}
