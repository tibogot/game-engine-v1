import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { seededRand } from "./woodUtils.js";

/**
 * Procedural adventure rope bridge (Indiana Jones style) along a spline.
 *
 * The inverse of the arch bridge: the deck SPANS the gap but SAGS downward
 * on a catenary-ish curve between the two endpoints' ground heights. Place
 * one spline point on each cliff and the bridge hangs itself between them —
 * a height difference between the ends gives the classic tilted look for
 * free. Two main ropes carry a run of jittery planks (yaw/roll/tone jitter,
 * some missing, some broken half-planks), hand ropes sag above with thin
 * vertical hanger ropes, and chunky leaning anchor posts ground both ends.
 *
 * Every part bakes its color into vertex colors and merges into ONE mesh
 * (1 draw call, 1 shadow caster). Static on purpose: sway would break the
 * single-merged-mesh pattern (a TSL time-node vertex offset can come later).
 */

export const ROPE_BRIDGE_DEFAULTS = {
  width: 1.6,
  pathSegments: 60,

  sag: 1.3, // mid-span drop below the endpoint chord
  deckClearance: 0.2, // deck ends above the endpoint ground

  plankWidth: 0.24, // plank size along the path
  plankGap: 0.14, // gap between planks
  plankThickness: 0.05,
  plankLenVar: 0.18, // per-plank length jitter (fraction of width)
  plankYawJitter: 6, // degrees, around the vertical
  plankRollJitter: 7, // degrees, around the walking direction
  plankToneVar: 0.16,
  damage: 0.15, // 0..0.6 — missing planks + broken half-planks

  ropeRadius: 0.035,
  railHeight: 1.05, // hand ropes above the deck at the ends
  railExtraSag: 0.25, // hand ropes sag a bit more than the deck
  hangerSpacing: 0.9, // metres between vertical hanger ropes

  anchors: true,
  anchorLean: 14, // degrees, posts lean outward

  plankColor: "#8a6a42",
  ropeColor: "#b09a6e",
  postColor: "#6b4a2c",
  roughness: 0.9,
  metalness: 0.0,
  seed: 23,
};

const WORLD_UP = new THREE.Vector3(0, 1, 0);

// ── geometry helpers (same scheme as bridge.js) ──────────────────────────

// Sweep a rectangular cross-section (2*hr wide, 2*hu tall) along an array of
// world-space centre points, oriented by per-point {right, up} frames.
function sweepRect(centers, frames, hr, hu) {
  const rings = centers.length;
  const pos = new Float32Array(rings * 4 * 3);
  const idx = [];
  const r = new THREE.Vector3();
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();

  let o = 0;
  for (let i = 0; i < rings; i++) {
    const c = centers[i];
    r.copy(frames[i].right);
    u.copy(frames[i].up);
    const corners = [
      [hr, hu],
      [-hr, hu],
      [-hr, -hu],
      [hr, -hu],
    ];
    for (const [a, b] of corners) {
      v.copy(c).addScaledVector(r, a).addScaledVector(u, b);
      pos[o++] = v.x;
      pos[o++] = v.y;
      pos[o++] = v.z;
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      const A = i * 4 + k;
      const B = i * 4 + k2;
      const C = (i + 1) * 4 + k2;
      const D = (i + 1) * 4 + k;
      idx.push(A, B, C, A, C, D);
    }
  }
  idx.push(0, 2, 1, 0, 3, 2);
  const last = (rings - 1) * 4;
  idx.push(last, last + 1, last + 2, last, last + 2, last + 3);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

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
export function buildRopeBridgeMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const p = { ...ROPE_BRIDGE_DEFAULTS, ...params };

  const pts3 = points.map((pt) => new THREE.Vector3(pt.x, 0, pt.z));
  const curve = new THREE.CatmullRomCurve3(pts3, !!closed, "catmullrom", 0.5);
  const length = curve.getLength();
  const halfW = Math.max(0.3, p.width) * 0.5;
  const y0 = getWorldHeight(points[0].x, points[0].z);
  const yN = getWorldHeight(
    points[points.length - 1].x,
    points[points.length - 1].z,
  );

  // deck height: endpoint chord MINUS a parabolic sag (the arch, inverted)
  const deckY = (t) =>
    y0 + (yN - y0) * t + p.deckClearance - p.sag * 4 * t * (1 - t);
  // hand ropes: parallel to the deck plus a little extra sag of their own
  const railY = (t) => deckY(t) + p.railHeight - p.railExtraSag * 4 * t * (1 - t);

  const deckPos = (t) => {
    const c = curve.getPointAt(THREE.MathUtils.clamp(t, 0, 1));
    return new THREE.Vector3(c.x, deckY(t), c.z);
  };
  const frameAt = (t) => {
    const e = 0.5 / Math.max(2, p.pathSegments);
    const a = deckPos(Math.max(0, t - e));
    const b = deckPos(Math.min(1, t + e));
    const fwd = b.sub(a).normalize();
    const right = new THREE.Vector3().crossVectors(WORLD_UP, fwd);
    if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(fwd, right).normalize();
    return { right, up, fwd };
  };
  const railPos = (t, s) => {
    const f = frameAt(t);
    const c = curve.getPointAt(THREE.MathUtils.clamp(t, 0, 1));
    return new THREE.Vector3(c.x, railY(t), c.z).addScaledVector(
      f.right,
      s * (halfW + 0.06),
    );
  };

  const group = new THREE.Group();
  group.name = "RopeBridge";

  // Everything collects here and merges into one vertex-colored mesh.
  const allGeos = [];
  const _c = new THREE.Color();

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  unitBox.deleteAttribute("uv");

  const m = new THREE.Matrix4();
  const rot = new THREE.Matrix4();
  const eul = new THREE.Euler();
  const scl = new THREE.Vector3();

  const pushBox = (matrix, color) => {
    const g = unitBox.clone();
    g.applyMatrix4(matrix);
    bakeColor(g, color);
    allGeos.push(g);
  };

  const segs = Math.max(24, p.pathSegments | 0);

  // rope sweep along a sampled path of world points (square section — at
  // 3.5cm nobody can tell, and it merges with everything else)
  const addRope = (samplePos, radius) => {
    const centers = [];
    const frames = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      centers.push(samplePos(t));
      frames.push(frameAt(t));
    }
    const g = sweepRect(centers, frames, radius, radius);
    bakeColor(g, _c.set(p.ropeColor));
    allGeos.push(g);
  };

  // ── two main carrying ropes under the plank edges ──
  for (const s of [-1, 1]) {
    addRope((t) => {
      const f = frameAt(t);
      return deckPos(t).addScaledVector(f.right, s * halfW);
    }, p.ropeRadius);
  }

  // ── hand ropes on both sides ──
  for (const s of [-1, 1]) {
    addRope((t) => railPos(t, s), p.ropeRadius * 0.85);
  }

  // ── planks: jittered, some missing, some broken ──
  const plankPitch = Math.max(0.1, p.plankWidth + p.plankGap);
  const plankCount = Math.max(2, Math.floor(length / plankPitch));
  const plankBase = new THREE.Color(p.plankColor);
  const missingChance = p.damage;
  const brokenChance = p.damage * 0.7;
  const deg = Math.PI / 180;
  for (let i = 0; i < plankCount; i++) {
    const t = (i + 0.5) / plankCount;
    const roll = seededRand(p.seed, i * 5 + 1);
    // keep the first/last plank so the ends never look unmoored
    const isEnd = i === 0 || i === plankCount - 1;
    if (!isEnd && roll < missingChance) continue;
    const broken = !isEnd && roll < missingChance + brokenChance;

    const f = frameAt(t);
    const pos = deckPos(t).addScaledVector(
      f.up,
      p.ropeRadius + p.plankThickness * 0.5,
    );
    let len = p.width * (1 + (seededRand(p.seed, i * 5 + 2) - 0.5) * 2 * p.plankLenVar);
    if (broken) {
      // half a plank, shoved to one side — the snapped-board look
      const side = seededRand(p.seed, i * 5 + 3) < 0.5 ? -1 : 1;
      len *= 0.45;
      pos.addScaledVector(f.right, side * p.width * 0.24);
    }
    const yaw = (seededRand(p.seed, i * 5 + 3) - 0.5) * 2 * p.plankYawJitter * deg;
    const tilt = (seededRand(p.seed, i * 5 + 4) - 0.5) * 2 * p.plankRollJitter * deg;
    scl.set(len, p.plankThickness, p.plankWidth);
    m.makeBasis(f.right, f.up, f.fwd)
      .multiply(rot.makeRotationFromEuler(eul.set(0, yaw, tilt)))
      .scale(scl)
      .setPosition(pos);
    const v = (seededRand(p.seed, i * 5 + 0) - 0.5) * 2 * p.plankToneVar;
    _c.copy(plankBase).offsetHSL(0, v * 0.15, v).multiply(plankBase);
    pushBox(m, _c);
  }

  // ── vertical hanger ropes: hand rope → main rope, both sides ──
  const hangDir = new THREE.Vector3();
  const hx = new THREE.Vector3();
  const hz = new THREE.Vector3();
  const hangerCount = Math.max(2, Math.floor(length / Math.max(0.3, p.hangerSpacing)));
  _c.set(p.ropeColor);
  for (let i = 1; i < hangerCount; i++) {
    const t = i / hangerCount;
    const f = frameAt(t);
    for (const s of [-1, 1]) {
      const top = railPos(t, s);
      const bot = deckPos(t).addScaledVector(f.right, s * halfW);
      hangDir.subVectors(top, bot);
      const h = hangDir.length();
      if (h < 0.05) continue;
      hangDir.normalize();
      hx.crossVectors(hangDir, f.fwd);
      if (hx.lengthSq() < 1e-9) hx.copy(f.right);
      hx.normalize();
      hz.crossVectors(hx, hangDir).normalize();
      const r = p.ropeRadius * 0.45;
      scl.set(r * 2, h, r * 2);
      m.makeBasis(hx, hangDir, hz)
        .scale(scl)
        .setPosition(
          (top.x + bot.x) * 0.5,
          (top.y + bot.y) * 0.5,
          (top.z + bot.z) * 0.5,
        );
      pushBox(m, _c);
    }
  }

  // ── anchor posts at both ends: chunky, leaning outward, plus a beam ──
  if (p.anchors) {
    const postCol = new THREE.Color(p.postColor);
    const postR = 0.09;
    for (const tEnd of [0, 1]) {
      const f = frameAt(tEnd);
      const gY = tEnd === 0 ? y0 : yN;
      const topY = railY(tEnd) + 0.3;
      const h = Math.max(0.6, topY - gY + 0.45); // sunk 0.45 into the ground
      const endC = curve.getPointAt(tEnd);
      for (const s of [-1, 1]) {
        const pos = new THREE.Vector3(endC.x, gY - 0.45 + h * 0.5, endC.z)
          .addScaledVector(f.right, s * (halfW + 0.2));
        scl.set(postR * 2, h, postR * 2);
        m.makeBasis(f.right, f.up, f.fwd)
          .multiply(rot.makeRotationFromEuler(eul.set(0, 0, -s * p.anchorLean * deg)))
          .scale(scl)
          .setPosition(pos);
        pushBox(m, postCol);
      }
      // lashed cross-beam between the two posts, just under the rope tops
      scl.set((halfW + 0.2) * 2 + 0.35, postR * 1.6, postR * 1.6);
      m.makeBasis(f.right, f.up, f.fwd)
        .scale(scl)
        .setPosition(endC.x, topY - 0.12, endC.z);
      pushBox(m, postCol);
    }
  }

  // ── merge everything into ONE vertex-colored mesh ──
  unitBox.dispose();
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

  return group;
}

/** Fixed hero span — a clear hanging span for close-up tuning. */
export const ROPE_BRIDGE_HERO_POINTS = [
  { x: -10, y: 0, z: -14 },
  { x: 10, y: 0, z: -14 },
];
