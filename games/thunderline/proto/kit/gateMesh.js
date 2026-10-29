// The gate arches (race.js gates): two posts and a beam across the road, standing on the deck.
// Checkpoint = bolt blue, finish = checkered, start = white. Shared by the drive page and the builder.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { physKit, ViewLOD } from "./physProps.js";
import { ledSignMaterial, ledLamp } from "./ledSigns.js";

let checker = null;
function checkerTexture() {
  if (checker) return checker;
  const c = document.createElement("canvas");
  c.width = 64; c.height = 16;
  const g = c.getContext("2d");
  for (let x = 0; x < 16; x++) for (let y = 0; y < 4; y++) { g.fillStyle = (x + y) % 2 ? "#0b0f1a" : "#f2f4f8"; g.fillRect(x * 4, y * 4, 4, 4); }
  checker = new THREE.CanvasTexture(c);
  checker.colorSpace = THREE.SRGBColorSpace;
  checker.magFilter = THREE.NearestFilter;
  return checker;
}

/** An AIR RING (race.js ring gate): a glowing hoop of radius g.hw, facing along the flight (g.T). */
export function makeRingMesh(g, { material = null } = {}) {
  const glow = material ?? new THREE.MeshStandardMaterial({ color: 0x3fd2ff, emissive: 0x3fd2ff, emissiveIntensity: 1.6, roughness: 0.4 });
  const hoop = new THREE.Mesh(new THREE.TorusGeometry(g.hw, 0.42, 10, 56), glow);
  const group = new THREE.Group();
  group.add(hoop);
  if (!material) {
    // four dark clamps so the hoop reads as an object, not a line
    const clamp = new THREE.MeshStandardMaterial({ color: 0x1a2236, roughness: 0.6, metalness: 0.3 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const m = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), clamp);
      m.position.set(Math.cos(a) * g.hw, Math.sin(a) * g.hw, 0);
      group.add(m);
    }
  }
  // the torus lies in its XY plane (axis Z): X across, Y up, Z along the flight
  const R = new THREE.Vector3().crossVectors(g.T, g.U).normalize();
  const U = new THREE.Vector3().crossVectors(R, g.T).normalize();
  group.matrixAutoUpdate = false;
  group.matrix.makeBasis(R, U, g.T.clone().normalize()).setPosition(g.P);
  group.userData.gate = g;
  return group;
}

/** @param g {kind, P, T, U, hw} — P is on (or 0.7 m above) the deck centre */
export function makeGateMesh(g, { height = 7.5, lift = 0.7 } = {}) {
  if (g.ring) return makeRingMesh(g);
  if (g.kind === "start" || g.kind === "finish") {
    // the ARCH from its Blender kit (below); its old procedural pylons removed (user, 2026-10-28: "delete the old one
    // also and use the new ones") — if the kit's file is missing, the paint alone (and lamps that light nothing)
    const kit = physKit("arch");
    return orient(kit ? archGantry(g, kit) : archMissing(g), g, lift);
  }
  const group = new THREE.Group();
  const color = g.kind === "cp" ? 0x3fd2ff : 0xf2f4f8;
  const post = new THREE.MeshStandardMaterial({ color: 0x1a2236, roughness: 0.6, metalness: 0.3 });
  const glow = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: g.kind === "cp" ? 1.4 : 0.25, roughness: 0.5 });
  const banner = g.kind === "finish"
    ? new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.7 })
    : glow;
  const w = g.hw + 1.2; // posts just outside the guardrails
  for (const sx of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, height, 0.6), post);
    m.position.set(sx * w, height / 2, 0);
    group.add(m);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.2, height * 0.8, 0.64), glow);
    strip.position.set(sx * (w - 0.3), height * 0.45, 0);
    group.add(strip);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(w * 2 + 0.6, 1.4, 0.5), banner);
  beam.position.set(0, height - 0.7, 0);
  group.add(beam);
  return orient(mergeParts(group), g, lift);
}

/**
 * ONE MESH PER MATERIAL (performance pass, 2026-10-22: the start, finish and checkpoint gates were 14 draws
 * for three gates): a gate's parts sharing a material (and a shadow flag) are baked into one geometry. The
 * header (two materials on one box) and the start lamps (each its own material, lit one by one) stay apart.
 * Mirrored parts (the left pylon, scale.x −1) get their triangles turned back: baking a mirror flips them.
 */
function mergeParts(group) {
  const buckets = new Map();
  for (const m of group.children.slice()) {
    if (!m.isMesh || Array.isArray(m.material)) continue;
    const k = `${m.material.uuid}|${m.castShadow}|${m.receiveShadow}|${m.renderOrder}`;
    (buckets.get(k) ?? buckets.set(k, []).get(k)).push(m);
  }
  for (const parts of buckets.values()) {
    if (parts.length < 2) continue;
    const geos = parts.map((m) => {
      m.updateMatrix();
      const geo = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrix);
      for (const name of Object.keys(geo.attributes)) if (!["position", "normal", "uv"].includes(name)) geo.deleteAttribute(name);
      if (m.matrix.determinant() < 0) {
        for (const a of Object.values(geo.attributes)) {
          const n = a.itemSize, arr = a.array;
          for (let t = 0; t < a.count; t += 3) for (let c = 0; c < n; c++) { const i1 = (t + 1) * n + c, i2 = (t + 2) * n + c; [arr[i1], arr[i2]] = [arr[i2], arr[i1]]; }
        }
      }
      return geo;
    });
    const merged = mergeGeometries(geos);
    if (!merged) continue; // (attribute sets differ: keep the parts)
    const mesh = new THREE.Mesh(merged, parts[0].material);
    mesh.castShadow = parts[0].castShadow;
    mesh.receiveShadow = parts[0].receiveShadow;
    mesh.renderOrder = parts[0].renderOrder;
    for (const m of parts) { group.remove(m); m.geometry.dispose(); }
    group.add(mesh);
  }
  return group;
}

// orient: local X across the road, Y up the deck, Z along the travel (the arch faces the car). X = U × T:
// a rotation — T × U made a MIRROR, unseen on the symmetric arches, the gantries' words read backwards.
function orient(group, g, lift) {
  const T = g.T.clone().normalize();
  const R = new THREE.Vector3().crossVectors(g.U, T).normalize();
  const U = new THREE.Vector3().crossVectors(T, R).normalize();
  group.matrixAutoUpdate = false;
  group.matrix.makeBasis(R, U, g.T.clone().normalize()).setPosition(g.P.clone().addScaledVector(U, -lift)); // lift: how far above the deck g.P is (drive ride: 0.7)
  group.userData.gate = g;
  return group;
}

// ---------- START / FINISH: the paint on the deck (the gantry is the arch kit, further down) ----------
const BOLT = "#3fd2ff";
const signs = new Map();
function decalTexture(kind) {
  const key = `decal:${kind}`;
  if (signs.has(key)) return signs.get(key);
  const c = document.createElement("canvas");
  const g = c.getContext("2d");
  if (kind === "slot") { // the car's grid box: a white bracket open toward the line, a bolt chevron
    c.width = 128; c.height = 256;
    g.fillStyle = "#f2f4f8";
    g.fillRect(0, 0, 10, 256); g.fillRect(118, 0, 10, 256); g.fillRect(0, 246, 128, 10);
    g.fillStyle = BOLT;
    g.beginPath(); g.moveTo(64, 20); g.lineTo(100, 56); g.lineTo(86, 56); g.lineTo(64, 34); g.lineTo(42, 56); g.lineTo(28, 56); g.closePath(); g.fill();
  } else { // the finish band: checkered
    c.width = 256; c.height = 32;
    for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) { g.fillStyle = (x + y) % 2 ? "#0b0f1a" : "#f2f4f8"; g.fillRect(x * 16, y * 16, 16, 16); }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  if (kind !== "slot") tex.magFilter = THREE.NearestFilter;
  signs.set(key, tex);
  return tex;
}
const PAINT_LIFT = 0.04; // as the boost pad (obstacles.js BOOST_PAD.lift), drawn over the deck by offset
const paint = (map, transparent) => new THREE.MeshStandardMaterial({ map, color: map ? 0xffffff : 0xf2f4f8, roughness: 0.7, transparent, alphaTest: transparent ? 0.5 : 0, depthWrite: !transparent, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
function flat(w, d, mat, z) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  m.rotation.set(-Math.PI / 2, 0, Math.PI); // flat on the deck, the plane's +Y (the texture's top) → +Z, the way ahead
  m.position.set(0, PAINT_LIFT, z);
  m.receiveShadow = true;
  return m;
}

function archMissing(g) {
  const group = new THREE.Group();
  group.userData.setLights = () => {};
  linePaint(group, g, g.kind === "finish");
  return group;
}

/** THE START LIGHTS (user, 2026-10-28: "better traffic lights in the dotted style"): each lamp a round cluster of LEDs
 * (ledSigns.js ledLamp) on its own material; `lamps` = [{ mesh, set }] left to right as the driver sees them.
 * group.userData.setLights(n): n red lamps (0–3), or "go" (all green), or 0 / null (all off — dark red dots). */
function startLamps(group, lamps) {
  for (const l of lamps) group.add(l.mesh);
  let last = null;
  group.userData.setLights = (n) => {
    if (n === last) return;
    last = n;
    lamps.forEach((l, i) => l.set(n === "go" ? "green" : typeof n === "number" && i < n ? "red" : "off"));
  };
}
/** PAINT on the deck: the start's line and the car's grid box behind it; the finish's checkered band on the line
 * (inside the Finish piece: it starts 2 m before). */
function linePaint(group, g, finish) {
  if (!finish) {
    group.add(flat(g.hw * 2 - 0.4, 0.8, paint(null, false), 0));
    if (g.slot > 0) group.add(flat(3.4, 6, paint(decalTexture("slot"), true), -g.slot));
    return;
  }
  const band = paint(decalTexture("band"), false);
  band.map = band.map.clone();
  band.map.wrapS = band.map.wrapT = THREE.RepeatWrapping;
  band.map.repeat.set(g.hw / 2, 1.5);
  band.map.needsUpdate = true;
  group.add(flat(g.hw * 2 - 0.4, 3, band, 0));
}

// ---------- THE ARCH from Blender (2026-10-28, user: "the start and finish arch gantry … they are floating and look
// very cheap"): tools/blender/thunderArch.py's KIT assembled to this road — a box-truss leg beside each edge of the
// deck, the top truss tiled across, an I-beam UNDER the slab from leg to leg (the frame closes round the road: it
// stands on the track, not on the air), a powder-coated header whose two faces are LED dots (v3 ledMatrix.js, image
// mode: the word, bolt blue for START, white with checkered rows for FINISH), the start lights' pod. One mesh per
// material per level (ViewLOD: 60 / 160 m). ----------
export const ARCH_LOD_FAR = [60, 160];
const SLAB = { 4: 0.7, 6: 0.7, 8: 0.9, 12: 0.9, 24: 1.1 }; // the deck's thickness per road half width (kit.js SECTIONS; 12 / 6: the 24 m road and its planks)
const LED = { y0: 7.25, y1: 9.15, z: 0.55, pitch: 0.09 }; // the header's LED faces (thunderArch.py HY0 + LIP …, LZ)
const POD = { y: 6.3, z: -0.225, lamps: [1.2, 0, -1.2], r: 0.34 };
const _M = new THREE.Matrix4(), _S = new THREE.Matrix4();
function archGantry(g, kit) {
  const finish = g.kind === "finish";
  const group = new THREE.Group();
  const lx = g.hw + 1.6, slab = SLAB[g.hw] ?? 0.9;
  const span = 2 * lx, nb = Math.ceil(span / 2), bw = span / nb;
  const wh = Math.min(2 * g.hw + 2, 18), nh = Math.max(1, Math.round(wh)), sw = wh / nh;
  const lod = new ViewLOD();
  for (let i = 0; i < 3; i++) {
    const byMat = new Map();
    const put = (part, x, y = 0, sx = 1) => {
      const geo = kit.parts[part][i].clone().applyMatrix4(_M.makeTranslation(x, y, 0).multiply(_S.makeScale(sx, 1, 1)));
      if (sx < 0) { const ix = geo.index.array; for (let t = 0; t < ix.length; t += 3) { const k = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = k; } }
      const mat = kit.material[part];
      (byMat.get(mat) ?? byMat.set(mat, []).get(mat)).push(geo);
    };
    for (const s of [-1, 1]) put("leg", s * lx);
    for (let k = 0; k < nb; k++) { const x = -lx + bw * (k + 0.5); put("bay", x, 0, bw / 2); put("beam", x, -slab, bw / 2); }
    for (let k = 0; k < nh; k++) put("head", -wh / 2 + sw * (k + 0.5), 0, sw);
    put("cap", wh / 2); put("cap", -wh / 2, 0, -1);
    if (!finish) put("pod", 0);
    const level = new THREE.Group();
    for (const [mat, geos] of byMat) {
      const m = new THREE.Mesh(mergeGeometries(geos), mat);
      for (const q of geos) q.dispose();
      m.castShadow = m.receiveShadow = true;
      level.add(m);
    }
    lod.addLevel(level, i ? ARCH_LOD_FAR[i - 1] : 0);
  }
  group.add(lod);
  // the header's LED faces: toward the car (−z) and the other way, each reading the right way round
  const led = ledSignMaterial(kit, { word: finish ? "FINISH" : "START", w: wh, h: LED.y1 - LED.y0, checker: finish, palette: finish ? "finish" : "start" });
  for (const sz of [-1, 1]) {
    const face = new THREE.Mesh(new THREE.PlaneGeometry(wh, LED.y1 - LED.y0), led);
    face.position.set(0, (LED.y0 + LED.y1) / 2, sz * LED.z);
    if (sz < 0) face.rotation.y = Math.PI;
    group.add(face);
  }
  if (!finish) {
    startLamps(group, POD.lamps.map((x) => {
      const lamp = ledLamp(kit, POD.r);
      const mesh = new THREE.Mesh(new THREE.CircleGeometry(POD.r, 40).rotateY(Math.PI), lamp.material);
      mesh.position.set(x, POD.y, POD.z - 0.03); // inside its hood, 3 cm in front of the pod's face
      return { mesh, set: lamp.set };
    }));
  }
  linePaint(group, g, finish);
  return group;
}

