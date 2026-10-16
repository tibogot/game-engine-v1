import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { seededRand } from "./woodUtils.js";

/**
 * Procedural festival string lights along a spline: simple posts conforming
 * to the terrain, wires sagging between their tops, and glowing chinese
 * lanterns hanging from the wires (per-lantern size jitter, seeded).
 *
 * NO real lights — the lanterns are emissive geometry that blooms via the
 * gallery's selective-bloom pass, same trick as the bridge lanterns.
 * Cost per string: ONE merged vertex-colored opaque mesh (posts, wires,
 * cords, caps) + ONE merged emissive mesh (all lantern papers). 2 draw calls
 * no matter how long the string is.
 */

export const STRING_LIGHTS_DEFAULTS = {
  poleSpacing: 6, // metres between posts
  poleHeight: 2.6,
  poleWidth: 0.1,
  poleLean: 1.5, // random post lean in degrees

  wireSag: 0.4, // mid-span drop between two posts
  wireRadius: 0.012,

  lanternSpacing: 0.85, // metres between lanterns along a span
  lanternSize: 0.15, // lantern height
  lanternDrop: 0.1, // cord length from wire to lantern top
  sizeVar: 0.15, // per-lantern size jitter
  lanternShape: "oval", // "oval" (tall pill) | "round" (classic squashed)

  lanternColor: "#ffb46b",
  lanternIntensity: 4.0,

  poleColor: "#4a4640",
  wireColor: "#2b2620",
  capColor: "#2a2118",
  roughness: 0.85,
  metalness: 0.0,
  seed: 5,
};

const WORLD_UP = new THREE.Vector3(0, 1, 0);

// Bake a solid color into every vertex of a geometry (in-place).
function bakeColor(geo, color) {
  const n = geo.attributes.position.count;
  const buf = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    buf[i * 3] = color.r;
    buf[i * 3 + 1] = color.g;
    buf[i * 3 + 2] = color.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(buf, 3));
  return geo;
}

// ── builder ────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {THREE.Vector3[]|{x,y,z}[]} opts.points
 * @param {boolean} [opts.closed]
 * @param {object} [opts.params]
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group|null}
 */
export function buildStringLightsMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const p = { ...STRING_LIGHTS_DEFAULTS, ...params };

  const pts3 = points.map((pt) => new THREE.Vector3(pt.x, 0, pt.z));
  const curve = new THREE.CatmullRomCurve3(pts3, !!closed, "catmullrom", 0.5);
  const length = curve.getLength();

  const group = new THREE.Group();
  group.name = "StringLights";

  // Opaque parts (posts, wire, cords, caps) merge into one mesh; lantern
  // papers merge into the second, emissive mesh.
  const allGeos = [];
  const paperGeos = [];
  const _c = new THREE.Color();

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  unitBox.deleteAttribute("uv");
  const unitLantern = new THREE.SphereGeometry(1, 10, 7);
  unitLantern.deleteAttribute("uv");

  const m = new THREE.Matrix4();
  const rot = new THREE.Matrix4();
  const eul = new THREE.Euler();
  const scl = new THREE.Vector3();
  const deg = Math.PI / 180;

  const pushBox = (matrix, color) => {
    const g = unitBox.clone();
    g.applyMatrix4(matrix);
    bakeColor(g, color);
    allGeos.push(g);
  };

  // thin box oriented from point a to point b (wire segments, drop cords)
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const pushStick = (a, b, r, color) => {
    fwd.subVectors(b, a);
    const len = fwd.length();
    if (len < 1e-4) return;
    fwd.normalize();
    right.crossVectors(WORLD_UP, fwd);
    if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
    right.normalize();
    up.crossVectors(fwd, right).normalize();
    scl.set(r * 2, r * 2, len * 1.02);
    m.makeBasis(right, up, fwd)
      .scale(scl)
      .setPosition((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
    pushBox(m, color);
  };

  // ── posts at even arc-length stations, conforming to the terrain ──
  const poleCount = Math.max(2, Math.floor(length / Math.max(1, p.poleSpacing)) + 1);
  const tops = [];
  const poleCol = new THREE.Color(p.poleColor);
  for (let i = 0; i < poleCount; i++) {
    const t = i / (poleCount - 1);
    const c = curve.getPointAt(t);
    const gY = getWorldHeight(c.x, c.z);
    const sink = 0.25;
    const h = p.poleHeight + sink;
    const leanA = (seededRand(p.seed, i * 3 + 1) - 0.5) * 2 * p.poleLean * deg;
    const leanB = (seededRand(p.seed, i * 3 + 2) - 0.5) * 2 * p.poleLean * deg;
    scl.set(p.poleWidth, h, p.poleWidth);
    m.makeRotationFromEuler(eul.set(leanA, 0, leanB))
      .scale(scl)
      .setPosition(c.x, gY - sink + h * 0.5, c.z);
    const v = (seededRand(p.seed, i * 3) - 0.5) * 0.15;
    _c.copy(poleCol).offsetHSL(0, 0, v);
    pushBox(m, _c);
    // wire attaches just under the post top (respecting the lean, roughly)
    tops.push(new THREE.Vector3(c.x, gY + p.poleHeight - 0.05, c.z));
  }

  // ── spans: sagging wire + hanging lanterns between consecutive tops ──
  const wireCol = new THREE.Color(p.wireColor);
  const capCol = new THREE.Color(p.capColor);
  const wireAt = (a, b, u) =>
    new THREE.Vector3().lerpVectors(a, b, u).setY(
      a.y + (b.y - a.y) * u - p.wireSag * 4 * u * (1 - u),
    );
  const lampW = p.lanternShape === "round" ? 0.62 : 0.42; // width/height ratio
  const lampH = p.lanternShape === "round" ? 0.42 : 0.5;
  let lampIdx = 0;
  for (let i = 0; i < tops.length - 1; i++) {
    const a = tops[i];
    const b = tops[i + 1];
    const chord = a.distanceTo(b);
    if (chord < 0.2) continue;

    // wire as a chain of short sticks along the sag curve
    const wsegs = Math.max(6, Math.min(18, Math.round(chord * 2)));
    let prev = wireAt(a, b, 0);
    for (let k = 1; k <= wsegs; k++) {
      const cur = wireAt(a, b, k / wsegs);
      pushStick(prev, cur, p.wireRadius, wireCol);
      prev = cur;
    }

    // lanterns hanging from this span
    const count = Math.max(1, Math.floor(chord / Math.max(0.25, p.lanternSpacing)));
    for (let j = 0; j < count; j++) {
      const u = (j + 0.5) / count;
      const w = wireAt(a, b, u);
      const size =
        p.lanternSize * (1 + (seededRand(p.seed, lampIdx * 4 + 7) - 0.5) * 2 * p.sizeVar);
      const topY = w.y - p.lanternDrop;
      const cy = topY - size * lampH; // lantern centre

      // drop cord wire → lantern
      pushStick(w, new THREE.Vector3(w.x, topY, w.z), p.wireRadius * 0.8, wireCol);

      // paper body (emissive mesh)
      const g = unitLantern.clone();
      m.makeScale(size * lampW, size * lampH, size * lampW).setPosition(w.x, cy, w.z);
      g.applyMatrix4(m);
      paperGeos.push(g);

      // little dark caps top + bottom
      scl.set(size * lampW * 0.7, size * 0.12, size * lampW * 0.7);
      m.makeScale(scl.x, scl.y, scl.z).setPosition(w.x, topY, w.z);
      pushBox(m, capCol);
      m.makeScale(scl.x * 0.6, scl.y, scl.z * 0.6).setPosition(
        w.x,
        cy - size * lampH,
        w.z,
      );
      pushBox(m, capCol);
      lampIdx++;
    }
  }

  // ── merge: one opaque mesh + one emissive mesh ──
  unitBox.dispose();
  unitLantern.dispose();

  const merged = mergeGeometries(allGeos, false);
  allGeos.forEach((g) => g.dispose());
  if (merged) {
    const mesh = new THREE.Mesh(
      merged,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: p.roughness,
        metalness: p.metalness,
      }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  const mergedPapers = mergeGeometries(paperGeos, false);
  paperGeos.forEach((g) => g.dispose());
  if (mergedPapers) {
    const paperMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(p.lanternColor).multiplyScalar(0.4),
      emissive: new THREE.Color(p.lanternColor),
      emissiveIntensity: p.lanternIntensity,
      roughness: 0.6,
      metalness: 0,
    });
    group.add(new THREE.Mesh(mergedPapers, paperMat));
  }

  return group;
}

/** Fixed hero span — three posts, two sagging spans for close-up tuning. */
export const STRING_LIGHTS_HERO_POINTS = [
  { x: -8, y: 0, z: -14 },
  { x: 8, y: 0, z: -14 },
];
