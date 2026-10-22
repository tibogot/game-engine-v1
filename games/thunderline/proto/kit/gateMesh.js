// The gate arches (race.js gates): two posts and a beam across the road, standing on the deck.
// Checkpoint = bolt blue, finish = checkered, start = white. Shared by the drive page and the builder.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

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
  if (g.kind === "start" || g.kind === "finish") return orient(mergeParts(makeLineGantry(g)), g, lift);
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

// ---------- START / FINISH GANTRIES (user, 2026-10-22: "the start and finish should have something we
// recognize immediately … a real start and a real finish look") ----------
// Our own look (bolt blue, graphite, white): two leaning pylons, a header with the word on both faces,
// paint on the road. START: three countdown lights under the header (red one by one on 3-2-1, green at
// GO: userData.setLights), the line and the car's grid box. FINISH: taller, checkered, a checkered band.
const NAVY = "#0d1424", BOLT = "#3fd2ff";
const signs = new Map();
function signTexture(word) {
  if (signs.has(word)) return signs.get(word);
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 192;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const draw = () => {
    const g = c.getContext("2d");
    g.fillStyle = NAVY; g.fillRect(0, 0, c.width, c.height);
    if (word === "FINISH") { // checkered bands top and bottom
      for (let x = 0; x < 64; x++) for (let y = 0; y < 2; y++) {
        g.fillStyle = (x + y) % 2 ? "#0b0f1a" : "#f2f4f8";
        g.fillRect(x * 16, y * 16, 16, 16); g.fillRect(x * 16, c.height - 32 + y * 16, 16, 16);
      }
    } else { g.fillStyle = BOLT; g.fillRect(0, 0, c.width, 14); g.fillRect(0, c.height - 14, c.width, 14); }
    g.fillStyle = "#f2f4f8";
    g.font = '800 128px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.textAlign = "center"; g.textBaseline = "middle";
    if (g.letterSpacing !== undefined) g.letterSpacing = "18px";
    g.fillText(word, c.width / 2, c.height / 2 + 6);
    tex.needsUpdate = true;
  };
  draw();
  document.fonts?.load('800 128px "Barlow Condensed"').then(draw, () => {}); // the web font may come late
  signs.set(word, tex);
  return tex;
}
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

function makeLineGantry(g) {
  const finish = g.kind === "finish";
  const group = new THREE.Group();
  const H = finish ? 9.5 : 8.5, w = g.hw + 1.7;
  const graphite = new THREE.MeshStandardMaterial({ color: 0x1a2236, roughness: 0.55, metalness: 0.35 });
  const edge = new THREE.MeshStandardMaterial({ color: finish ? 0xf2f4f8 : 0x3fd2ff, emissive: finish ? 0xf2f4f8 : 0x3fd2ff, emissiveIntensity: finish ? 0.6 : 1.2, roughness: 0.4 });
  // PYLONS: a trapezoid (1.9 m at the foot, 0.9 m at the top), the inner side upright, the outer leaning in
  for (const sx of [-1, 1]) {
    const s = new THREE.Shape();
    s.moveTo(0, 0); s.lineTo(1.9, 0); s.lineTo(0.9, H); s.lineTo(0, H); s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth: 1.3, bevelEnabled: false });
    geo.translate(0, 0, -0.65);
    const p = new THREE.Mesh(geo, graphite);
    p.scale.x = sx; // mirrored on the left (three flips the winding of a mirrored mesh itself)
    p.position.x = sx * w; // x from the inner face (w) outward
    p.castShadow = true;
    group.add(p);
    // the glowing strip on the inner face, standing 4 cm proud of it (never in its plane)
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.14, H * 0.82, 0.3), edge);
    strip.position.set(sx * (w - 0.03), H * 0.43, 0);
    group.add(strip);
  }
  // HEADER: the word on both faces (box faces ±Z), graphite ends
  const sign = new THREE.MeshStandardMaterial({ map: signTexture(finish ? "FINISH" : "START"), roughness: 0.6, emissive: 0xffffff, emissiveMap: signTexture(finish ? "FINISH" : "START"), emissiveIntensity: 0.18 });
  const hw = w + 1.0, hh = 2.6;
  // (a graphite box + the two sign faces 1 cm proud of it: a box with six materials was six draws)
  const header = new THREE.Mesh(new THREE.BoxGeometry(hw * 2, hh, 1.1), graphite);
  header.position.set(0, H - hh / 2 + 0.3, 0);
  header.castShadow = true;
  group.add(header);
  for (const sz of [-1, 1]) {
    const face = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, hh), sign);
    face.position.set(0, H - hh / 2 + 0.3, sz * 0.56);
    if (sz < 0) face.rotation.y = Math.PI; // the back face reads the right way round from behind
    group.add(face);
  }
  // a lit edge under the header
  const under = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 - 0.2, 0.12, 1.16), edge);
  under.position.set(0, H - hh + 0.3 - 0.04, 0);
  group.add(under);

  if (!finish) {
    // START LIGHTS: three lamps on a bar under the header, facing the car (−Z)
    const bar = new THREE.Mesh(new THREE.BoxGeometry(5.6, 1.4, 0.6), graphite);
    const barY = H - hh + 0.3 - 0.85; // its top 5 cm under the lit edge's underside
    bar.position.set(0, barY, 0);
    group.add(bar);
    const lamps = [1.8, 0, -1.8].map((x) => { // left to right as the driver sees them (local +X is his left)
      const mat = new THREE.MeshStandardMaterial({ color: 0x2a0d12, emissive: 0x000000, roughness: 0.3 });
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.12, 24), mat);
      m.rotation.x = Math.PI / 2;
      m.position.set(x, barY, -0.32); // half inside the bar (its face at −0.3): no shared plane
      group.add(m);
      return mat;
    });
    const RED = new THREE.Color(0xff2a3d), GREEN = new THREE.Color(0x3dff7a), OFF = new THREE.Color(0x000000);
    let last = null;
    /** n red lamps (0–3), or "go" (all green), or 0 / null (all off) */
    group.userData.setLights = (n) => {
      if (n === last) return;
      last = n;
      lamps.forEach((mat, i) => {
        const on = n === "go" || (typeof n === "number" && i < n);
        mat.emissive.copy(!on ? OFF : n === "go" ? GREEN : RED);
        mat.emissiveIntensity = on ? 0.5 : 0; // (3, even 1.2, bloomed the whole gantry and the road ahead green)
        mat.color.set(on ? 0x111111 : 0x2a0d12);
      });
    };
    // PAINT: the line across the road at the gate, the car's grid box behind it
    group.add(flat(g.hw * 2 - 0.4, 0.8, paint(null, false), 0));
    if (g.slot > 0) group.add(flat(3.4, 6, paint(decalTexture("slot"), true), -g.slot));
  } else {
    // the header's top: a checkered banner standing on it
    const flag = new THREE.MeshStandardMaterial({ map: decalTexture("band"), roughness: 0.7, side: THREE.DoubleSide });
    flag.map.wrapS = THREE.RepeatWrapping;
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, 0.8), flag);
    banner.position.set(0, H + 0.3 + 0.4, 0);
    group.add(banner);
    // PAINT: a checkered band across the road, on the line (inside the Finish piece: it starts 2 m before)
    const band = paint(decalTexture("band"), false);
    band.map = band.map.clone();
    band.map.wrapS = band.map.wrapT = THREE.RepeatWrapping;
    band.map.repeat.set(g.hw / 2, 1.5);
    band.map.needsUpdate = true;
    group.add(flat(g.hw * 2 - 0.4, 3, band, 0));
  }
  return group;
}
