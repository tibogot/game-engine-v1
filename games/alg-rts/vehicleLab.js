// VEHICLE LAB — one asset at a time, BEFORE and AFTER side by side (you, 2026-10-06: "start
// with one of them, then only if I see we can do better, we add and compare step by step").
// The plant lab's light scene (plantLab.js): the game's sun, shadow and exposure, a stand-in
// sky, one ground photo — loads in seconds. Judge here; give what you keep one look in the game.
//
//   left   AVANT — the game's half-track (rtsVehiclesFr.js buildHalfTrack, detail 1)
//   right  APRÈS — the same builder at detail 2 (rounded plates, rivets, seams, stowage, treads)
//   views  close up · the RTS play zoom (40° lens, ~42°, 77 m) · turntable on / off · day / night
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { getSharedGltfLoader, initGlbLoaderRenderer } from "../../v2/core/foliage/glbLoader.js";
import { FR_PAINT_TINT, FR_PAINT_TINT_OLD, buildAMX13, buildAlouette, buildEBR, buildGMC, buildHalfTrack, buildWillys } from "../../v3/render/objects/rtsVehiclesFr.js";
import { rtsObjectMaterialTinted } from "../../v3/render/objects/rtsObjectProps.js";
import { rtsRunningGearMaterial } from "../../v3/render/objects/rtsVehicles.js";
import { stencilMesh } from "../../v3/render/objects/rtsStencils.js";
import { RENDER_ORDER } from "../shared-rts/renderOrder.js";

/** The game's sun (alg-rts, Partly cloudy, 15:12) and a moonlit night. */
const SUN = { dir: new THREE.Vector3(-0.739, 0.65, 0.175).normalize(), intensity: 10, color: 0xfff2dd };
const NIGHT = { intensity: 0.9, color: 0x8ea6d8, exposure: 1.4 };

function gradientSky(k = 1) {
  const W = 64, H = 32, d = new Float32Array(W * H * 4);
  const zen = [0.18, 0.36, 0.75], hor = [0.95, 0.98, 1.0], gnd = [0.32, 0.24, 0.16];
  for (let y = 0; y < H; y++) {
    const v = 1 - (y + 0.5) / H, el = v * 2 - 1;
    const c = el > 0 ? hor.map((h, i) => h + (zen[i] - h) * Math.pow(el, 0.55)) : gnd;
    for (let x = 0; x < W; x++) d.set([...c.map((q) => q * 1.6 * k), 1], (y * W + x) * 4);
  }
  const t = new THREE.DataTexture(d, W, H, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * PAINT candidates (you, 2026-10-06: "lets do the paint colour"). The atlas olive is ~sRGB
 * (108, 115, 64); the tint multiplies it in linear. The old [0.74, 0.66, 0.5] kept almost no
 * blue: yellow-green in the sun. The French photos' vert armée is greyer and browner — each
 * candidate is (target linear) / (atlas linear), the target sRGB in its name. OLIVE BRUN is the
 * game's now (FR_PAINT_TINT); "Ancien" stays here while you choose.
 */
const PAINTS = {
  ancien: { label: "Ancien (lime)", tint: FR_PAINT_TINT_OLD },
  brun: { label: "Olive brun (jeu)", tint: FR_PAINT_TINT },     // ~ (86, 89, 58)
  sombre: { label: "Olive sombre", tint: [0.5, 0.47, 0.66] },   // ~ (78, 81, 53): olive brun, darker
  kaki: { label: "Kaki", tint: [0.81, 0.6, 0.92] },             // ~ (98, 90, 62); red over green: lilac in the shade
};

/** The vehicles in the lab (?v=): the builder, the gear channel, the panel's name. */
const VEHICLES = {
  halftrack: { build: buildHalfTrack, label: "Half-track M3" },
  willys: { build: buildWillys, label: "Jeep Willys MB" },
  gmc: { build: buildGMC, label: "Camion GMC (bâché)" },
  gmcOpen: { build: (o) => buildGMC({ ...o, tilt: !o }), label: "Camion GMC (ouvert)" },
  alouette: { build: buildAlouette, label: "Alouette II" },
  ebr: { build: buildEBR, label: "Panhard EBR" },
  amx13: { build: buildAMX13, label: "AMX-13" },
};

/** The canopy's glass (the showroom's): see-through, after the opaque pass, no depth write. */
let _glass = null;
const glassMaterial = () => _glass ??= Object.assign(new THREE.MeshStandardNodeMaterial({
  color: 0x2a3a44, roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide,
}), { name: "CockpitGlass" });

/** A vehicle as the game draws it: the body, its decals, its running gear (a helicopter: its glass, its rotors). */
function vehicleOf(geo, key) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(geo, rtsObjectMaterialTinted(FR_PAINT_TINT));
  body.castShadow = body.receiveShadow = true;
  const st = stencilMesh(geo.userData.stencil);
  if (st) body.add(st);
  g.add(body);
  let gear = null;
  if (geo.userData.gear) {
    gear = new THREE.Mesh(geo.userData.gear, rtsRunningGearMaterial(FR_PAINT_TINT, key));
    gear.castShadow = gear.receiveShadow = true;
    g.add(gear);
  }
  const rotors = [];
  const tur = geo.userData.turret;
  if (tur) { const tm = new THREE.Mesh(tur.geo, rtsObjectMaterialTinted(FR_PAINT_TINT)); tm.position.fromArray(tur.pivot); tm.castShadow = tm.receiveShadow = true; g.add(tm); }
  if (geo.userData.glass) { const gm = new THREE.Mesh(geo.userData.glass, glassMaterial()); gm.renderOrder = RENDER_ORDER.GLASS; g.add(gm); }
  for (const [axis, r] of [["y", geo.userData.rotors?.main], ["x", geo.userData.rotors?.tail]]) {
    if (!r) continue;
    const m = new THREE.Mesh(r.geo, rtsObjectMaterialTinted(FR_PAINT_TINT));
    m.position.fromArray(r.pivot);
    m.castShadow = true;
    g.add(m);
    rotors.push({ m, axis });
  }
  const tris = [geo, geo.userData.gear, geo.userData.glass, geo.userData.rotors?.main?.geo, geo.userData.rotors?.tail?.geo].reduce((n, x) => n + (x ? (x.index ? x.index.count : x.attributes.position.count) / 3 : 0), 0);
  /** Repaint (the lab's candidates): the body and the gear's painted parts. */
  // Each tint its OWN program: three keys a node material by its graph's shape, and the tints
  // differ only in a constant — the first one compiled was drawn for all (measured in the lab).
  const own = (m, k) => { m.customProgramCacheKey = () => k; return m; };
  const paint = (tint) => {
    body.material = own(rtsObjectMaterialTinted(tint), `vlab-body:${tint.join(",")}`);
    if (gear) gear.material = own(rtsRunningGearMaterial(tint, `${key}:${tint.join(",")}`), `vlab-gear:${tint.join(",")}`);
  };
  return { group: g, tris, paint, rotors };
}

/**
 * The CREW: the game's own soldier (soldiers.glb, soldier1 — the French body) on every seat the
 * builder gives out (userData.seats), each on its clip from a different moment. Plain mixers here;
 * the game would draw them in the crowd. Parented to the vehicle: they ride its turntable.
 */
async function addCrew(group, seats, renderer) {
  if (!seats?.length) return { mixers: [], men: [] };
  initGlbLoaderRenderer(renderer);
  const gltf = await new Promise((res, rej) => getSharedGltfLoader().load("/models/soldiers/soldiers.glb", res, undefined, rej));
  const clips = new Map(gltf.animations.map((c) => [c.name, c]));
  const mixers = [], men = [];
  seats.forEach((seat, i) => {
    const man = SkeletonUtils.clone(gltf.scene);
    man.traverse((o) => {
      if (o.isSkinnedMesh) { o.visible = o.name === "soldier1"; o.castShadow = o.receiveShadow = true; o.frustumCulled = false; }
    });
    man.scale.setScalar(1.3);                       // the pack is 1.8 m; the game's men are 1.8 × 1.3
    man.position.fromArray(seat.p);
    man.rotation.y = seat.yaw;
    group.add(man);
    const clip = clips.get(seat.clip) ?? clips.get("sit");
    const mixer = new THREE.AnimationMixer(man);
    mixer.clipAction(clip).play();
    mixer.setTime((i * 1.618 % 1) * clip.duration);
    mixers.push(mixer);
    men.push(man);
  });
  return { mixers, men };
}

/**
 * `catalog` (the buildings lab passes its own): { key: { build({ detail, crew }), label } };
 * `title`, `kind` (the panel's heading), `def` (the key shown first).
 */
export async function startVehicleLab(container, { catalog = VEHICLES, title = "Vehicle Lab", kind = "Véhicule", def = "halftrack", gap = 4.2 } = {}) {
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
  const skyDay = gradientSky(1), skyNight = gradientSky(0.035);
  scene.environment = skyDay;
  scene.background = skyDay;

  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 2000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;

  const sun = new THREE.DirectionalLight(SUN.color, SUN.intensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 600 });
  sun.shadow.bias = 0;
  sun.shadow.normalBias = 0.12;
  sun.shadow.radius = 2;
  sun.position.copy(SUN.dir).multiplyScalar(300);
  scene.add(sun, sun.target);

  const loader = new THREE.TextureLoader();
  const tex = (f, srgb) => {
    const t = loader.load(`/textures/ground/dry_mud_field_001/dry_mud_field_001_${f}_1k.jpg`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(40, 40);
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(160, 160).rotateX(-Math.PI / 2),
    new THREE.MeshStandardNodeMaterial({ map: tex("diff", true), normalMap: tex("nor_gl"), roughness: 1, color: 0xd8c6a8 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  // BEFORE / AFTER, 5 m apart either side of the middle, each on a turntable.
  const vKey = catalog[new URLSearchParams(location.search).get("v")] ? new URLSearchParams(location.search).get("v") : def;
  const V = catalog[vKey];
  const before = vehicleOf(V.build(), vKey);
  const afterGeo = V.build({ detail: 2, crew: false });
  const after = vehicleOf(afterGeo, vKey);
  const GAP = typeof gap === "function" ? gap(vKey) : gap;
  before.group.position.x = -GAP;
  after.group.position.x = GAP;
  scene.add(before.group, after.group);
  after.paint(PAINTS.brun.tint);   // the closest to the French photos; the panel switches
  const crew = await addCrew(after.group, afterGeo.userData.seats, renderer);

  // A man at the game's 1.3 scale, between them.
  {
    const man = new THREE.Mesh(new THREE.CapsuleGeometry(0.29, 1.7, 4, 10), new THREE.MeshStandardNodeMaterial({ color: 0x6f6a4c, roughness: 0.9 }));
    man.position.set(0, 1.14, 3.2);
    man.castShadow = true;
    scene.add(man);
  }

  let spin = true, yaw = -0.6;
  const setYaw = () => { before.group.rotation.y = yaw; after.group.rotation.y = yaw; };
  setYaw();
  function close() { controls.target.set(0, 1.2, 0); camera.position.set(4, 5.5, 13); controls.update(); }
  /** The RTS camera: its 40° lens, pitched ~42°, 77 m out (and a nearer play zoom). */
  function play(dist = 77, pitchDeg = 42) {
    const p = (pitchDeg * Math.PI) / 180;
    controls.target.set(0, 0.8, 0);
    camera.position.set(0, Math.sin(p) * dist, Math.cos(p) * dist);
    controls.update();
  }
  function night(on) {
    sun.intensity = on ? NIGHT.intensity : SUN.intensity;
    sun.color.set(on ? NIGHT.color : SUN.color);
    scene.environment = scene.background = on ? skyNight : skyDay;
    renderer.toneMappingExposure = on ? NIGHT.exposure * 0.55 : 0.55;
  }

  const el = document.createElement("div");
  el.innerHTML = `<style>
    #vlab { position: fixed; left: 12px; top: 12px; z-index: 50; width: 250px; padding: 12px 14px 14px;
      background: rgba(22,17,12,.92); color: #e8dcc4; font: 12px "Segoe UI", system-ui, sans-serif;
      border: 1px solid #4a3a28; border-radius: 6px; }
    #vlab h1 { margin: 0 0 8px; font-size: 13px; letter-spacing: .12em; text-transform: uppercase; }
    #vlab h2 { margin: 12px 0 6px; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: #b8a27e; }
    #vlab .g { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
    #vlab button { padding: 5px 6px; font: inherit; color: #e8dcc4; background: #2c2218; border: 1px solid #4a3a28; border-radius: 4px; cursor: pointer; }
    #vlab button:hover { background: #3a2c1f; }
    #vlab table { width: 100%; border-collapse: collapse; margin-top: 4px; font-variant-numeric: tabular-nums; }
    #vlab td { padding: 2px 0; border-bottom: 1px solid #3a2c1f; } #vlab td + td { text-align: right; }
    #vlab p { margin: 8px 0 0; color: #9c8b70; line-height: 1.4; }
    .vlab-tag { position: fixed; z-index: 40; transform: translate(-50%, -100%); padding: 2px 8px; border-radius: 3px;
      font: 700 11px "Segoe UI", sans-serif; letter-spacing: .12em; color: #f1e6c4; background: rgba(22,17,12,.85); border: 1px solid #6b5636; pointer-events: none; }
  </style>
  <div id="vlab"><h1>${title}</h1>
    <p style="margin-top:0">${V.label} — <b>avant</b> (gauche, le jeu) / <b>après</b> (droite, détail 2).</p>
    <h2>${kind}</h2><div class="g">${Object.entries(catalog).map(([k, v]) => `<button data-veh="${k}">${v.label}</button>`).join("")}</div>
    <h2>Vues</h2><div class="g"><button data-v="close">Gros plan</button><button data-v="play">Zoom de jeu</button><button data-v="play2">Zoom proche</button><button data-v="spin">Rotation</button></div>
    <h2>Peinture (après)</h2><div class="g">${Object.entries(PAINTS).map(([k, p]) => `<button data-paint="${k}">${p.label}</button>`).join("")}</div>
    <h2>Lumière</h2><div class="g"><button data-v="day">Jour</button><button data-v="night">Nuit</button></div>
    <h2>Coût</h2><table><tr><td>Avant</td><td>${before.tris.toLocaleString()} tris</td></tr><tr><td>Après</td><td>${after.tris.toLocaleString()} tris</td></tr></table>
    <p>Le soleil, l'ombre et l'exposition du jeu ; un ciel de remplacement. Glisser pour tourner, molette pour zoomer.</p></div>`;
  document.body.appendChild(el);
  const tags = ["AVANT", "APRÈS"].map((t) => { const d = document.createElement("div"); d.className = "vlab-tag"; d.textContent = t; document.body.appendChild(d); return d; });
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.veh) { location.search = `?v=${b.dataset.veh}`; return; }
    if (b.dataset.paint) { after.paint(PAINTS[b.dataset.paint].tint); return; }
    const v = b.dataset.v;
    if (v === "close") close();
    if (v === "play") play(77, 42);
    if (v === "play2") play(32, 36);
    if (v === "spin") spin = !spin;
    if (v === "day") night(false);
    if (v === "night") night(true);
  });

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  close();
  const v = new THREE.Vector3();
  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (spin) { yaw += dt * 0.25; setYaw(); }
    for (const m of crew.mixers) m.update(dt);
    for (const v of [before, after]) for (const r of v.rotors) r.m.rotation[r.axis] += dt * (r.axis === "y" ? 4 : 18);
    controls.update();
    [[before.group, tags[0]], [after.group, tags[1]]].forEach(([g, t]) => {
      v.set(g.position.x, 4.2, 0).project(camera);
      t.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
      t.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
      t.style.display = v.z < 1 ? "" : "none";
    });
    renderer.render(scene, camera);
  });
  return { renderer, scene, camera, controls, before, after, crew, paints: PAINTS, close, play, night, setYaw: (y) => { yaw = y; setYaw(); }, spin: (on) => { spin = on; } };
}
