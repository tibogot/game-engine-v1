import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { seededRand } from "./woodUtils.js";
import { legSpan } from "./trestle.js";

/**
 * Procedural boat dock / mooring pier along a Catmull-Rom spline.
 *
 * Unlike the arched bridge, the deck is DEAD FLAT: a level walkway of wooden
 * boards held above the water by round timber piles ("feet") that stand in
 * the water. The pile depth below the deck is adjustable so the feet can
 * reach whatever water depth the dock is placed over. Piles poke a little
 * above the deck like real mooring posts, and small warm post lamps line the
 * edges for decoration (they bloom via the gallery's selective-bloom pass).
 *
 * Every opaque part bakes its color into vertex colors and merges into ONE
 * mesh (1 draw call, 1 shadow caster); the emissive lamp heads are the only
 * second mesh.
 */

export const BOAT_DOCK_DEFAULTS = {
  width: 2.4,
  pathSegments: 40,

  deckHeight: 0.75, // deck top above the shore-end ground/water line
  deckThickness: 0.1,

  plankWidth: 0.3, // board size along the path
  plankGap: 0.035, // gap between boards
  plankToneVar: 0.12, // per-board colour jitter

  stringerW: 0.14,
  stringerH: 0.2,
  stringerInset: 0.28, // inset from the deck edge

  fender: true, // side rub-rail board hiding the plank ends
  fenderH: 0.16,
  fenderT: 0.05,

  pileSpacing: 2.6, // metres between pile pairs
  pileRadius: 0.09,
  pileEmbed: 0.4, // how far each foot sinks INTO the seabed below it
  pileMaxLength: 8, // clamp so a deep hole doesn't grow an absurd spike (0 = off)
  pileOver: 0.45, // pile sticking up above the deck top (mooring post)
  pileLean: 1.2, // random pile lean in degrees
  pileSides: 8,
  pileCaps: true, // little cap disc on top of each pile

  lights: true,
  lightSpacing: 3.5,
  lightHeight: 0.55, // lamp post height above the deck
  lightSize: 0.11,
  lightColor: "#ffd9a0",
  lightIntensity: 3.5,

  woodMain: "#a9805a", // deck boards
  woodAlt: "#7e5c3a", // stringers / headers / fender
  pileColor: "#6d4c2e",
  darkColor: "#33261a", // pile caps + lamp posts
  roughness: 0.85,
  metalness: 0.0,
  seed: 7,
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
export function buildBoatDockMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const p = { ...BOAT_DOCK_DEFAULTS, ...params };

  const pts3 = points.map((pt) => new THREE.Vector3(pt.x, 0, pt.z));
  const curve = new THREE.CatmullRomCurve3(pts3, !!closed, "catmullrom", 0.5);
  const length = curve.getLength();
  const halfW = Math.max(0.4, p.width) * 0.5;

  // dead-flat deck: level with the higher endpoint (usually the shore end)
  const y0 = getWorldHeight(points[0].x, points[0].z);
  const yN = getWorldHeight(
    points[points.length - 1].x,
    points[points.length - 1].z,
  );
  const deckTopY = Math.max(y0, yN) + p.deckHeight;

  const deckPos = (t) => {
    const c = curve.getPointAt(THREE.MathUtils.clamp(t, 0, 1));
    return new THREE.Vector3(c.x, deckTopY, c.z);
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

  const group = new THREE.Group();
  group.name = "BoatDock";

  // Everything opaque collects here and merges into one vertex-colored mesh.
  const allGeos = [];
  const _c = new THREE.Color();

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  unitBox.deleteAttribute("uv");
  const unitPile = new THREE.CylinderGeometry(
    1,
    1.06, // feet flare slightly at the waterline — reads as driven timber
    1,
    Math.max(5, p.pileSides | 0),
  );
  unitPile.deleteAttribute("uv");

  const m = new THREE.Matrix4();
  const scl = new THREE.Vector3();
  const eul = new THREE.Euler();

  const pushBox = (matrix, color) => {
    const g = unitBox.clone();
    g.applyMatrix4(matrix);
    bakeColor(g, color);
    allGeos.push(g);
  };
  const pushPile = (matrix, color) => {
    const g = unitPile.clone();
    g.applyMatrix4(matrix);
    bakeColor(g, color);
    allGeos.push(g);
  };

  // ── deck boards (flat, tone + size jitter baked into vertex colors) ──
  const segs = Math.max(12, p.pathSegments | 0);
  const plankPitch = Math.max(0.08, p.plankWidth + p.plankGap);
  const plankCount = Math.max(2, Math.floor(length / plankPitch));
  const baseCol = new THREE.Color(p.woodMain);
  for (let i = 0; i < plankCount; i++) {
    const t = (i + 0.5) / plankCount;
    const f = frameAt(t);
    const pos = deckPos(t).addScaledVector(f.up, -p.deckThickness * 0.5);
    const lenJit = 1 + (seededRand(p.seed, i * 3 + 1) - 0.5) * 0.05;
    scl.set(p.width * lenJit, p.deckThickness, p.plankWidth);
    m.makeBasis(f.right, f.up, f.fwd).scale(scl).setPosition(pos);
    const v = (seededRand(p.seed, i * 3 + 2) - 0.5) * 2 * p.plankToneVar;
    _c.copy(baseCol).offsetHSL(0, v * 0.15, v).multiply(baseCol);
    pushBox(m, _c);
  }

  // helpers to sample a side path (offset on right + up) for sweeps
  const sidePath = (sign, rightOff, upOff) => {
    const centers = [];
    const frames = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const f = frameAt(t);
      const c = deckPos(t)
        .addScaledVector(f.right, sign * rightOff)
        .addScaledVector(f.up, upOff);
      centers.push(c);
      frames.push(f);
    }
    return { centers, frames };
  };
  const addSweep = (sign, rightOff, upOff, hr, hu, colorHex) => {
    const { centers, frames } = sidePath(sign, rightOff, upOff);
    const g = sweepRect(centers, frames, hr, hu);
    bakeColor(g, _c.set(colorHex));
    allGeos.push(g);
  };

  // ── stringers (under both deck edges + centre when wide) ──
  const stringerUp = -p.deckThickness - p.stringerH * 0.5;
  for (const s of [-1, 1]) {
    addSweep(s, halfW - p.stringerInset, stringerUp, p.stringerW * 0.5, p.stringerH * 0.5, p.woodAlt);
  }
  if (p.width > 2.0) {
    addSweep(1, 0, stringerUp, p.stringerW * 0.5, p.stringerH * 0.5, p.woodAlt);
  }

  // ── fender rub-rail boards along both deck edges ──
  if (p.fender) {
    for (const s of [-1, 1]) {
      addSweep(s, halfW + p.fenderT * 0.5, -p.fenderH * 0.45, p.fenderT * 0.5, p.fenderH * 0.5, p.woodAlt);
    }
  }

  // ── piles ("feet") + header beams at regular stations ──
  // Each foot reaches the SEABED BENEATH ITSELF: the ground is sampled at the
  // pile's own xz (offset sideways from the path), so a sloping bottom gives
  // short piles near the shore and long ones out in deep water. The deck stays
  // dead flat above them.
  const pileOut = halfW + (p.fender ? p.fenderT : 0) + p.pileRadius * 0.8;
  const stations = Math.max(2, Math.floor(length / Math.max(0.8, p.pileSpacing)) + 1);
  const pileCol = new THREE.Color(p.pileColor);
  const darkCol = new THREE.Color(p.darkColor);
  const headerCol = new THREE.Color(p.woodAlt);
  let deepestPile = deckTopY;
  for (let i = 0; i < stations; i++) {
    const t = stations === 1 ? 0.5 : i / (stations - 1);
    const f = frameAt(t);

    for (const s of [-1, 1]) {
      const k = i * 2 + (s > 0 ? 1 : 0);
      const top = deckPos(t)
        .addScaledVector(f.right, s * pileOut)
        .addScaledVector(f.up, p.pileOver);
      const leg = legSpan(top.y, getWorldHeight(top.x, top.z), {
        embed: p.pileEmbed,
        maxLength: p.pileMaxLength,
        minLength: p.deckThickness + p.stringerH + 0.2,
      });
      deepestPile = Math.min(deepestPile, leg.bottomY);

      const mid = top.clone().addScaledVector(f.up, -leg.length * 0.5);
      const leanA = ((seededRand(p.seed, k * 7 + 3) - 0.5) * 2 * p.pileLean * Math.PI) / 180;
      const leanB = ((seededRand(p.seed, k * 7 + 4) - 0.5) * 2 * p.pileLean * Math.PI) / 180;
      scl.set(p.pileRadius, leg.length, p.pileRadius);
      m.makeRotationFromEuler(eul.set(leanA, 0, leanB)).scale(scl).setPosition(mid);
      const v = (seededRand(p.seed, k * 7 + 5) - 0.5) * 0.2;
      _c.copy(pileCol).offsetHSL(0, 0, v);
      pushPile(m, _c);

      // cap disc on top of the mooring post
      if (p.pileCaps) {
        scl.set(p.pileRadius * 1.35, p.pileRadius * 0.5, p.pileRadius * 1.35);
        m.makeRotationFromEuler(eul.set(leanA, 0, leanB))
          .scale(scl)
          .setPosition(top.x, top.y + p.pileRadius * 0.2, top.z);
        pushPile(m, darkCol);
      }
    }

    // header beam tying the pile pair together under the stringers
    const hPos = deckPos(t).addScaledVector(
      f.up,
      -p.deckThickness - p.stringerH - p.stringerW * 0.5,
    );
    scl.set(pileOut * 2 + p.pileRadius, p.stringerW, p.stringerW * 1.1);
    m.makeBasis(f.right, f.up, f.fwd).scale(scl).setPosition(hPos);
    pushBox(m, headerCol);
  }

  // ── small post lamps along the edges (alternating sides) ──
  if (p.lights && length > 1) {
    const count = Math.max(2, Math.floor(length / Math.max(1, p.lightSpacing)) + 1);
    const ls = p.lightSize;
    const headTemplate = new THREE.BoxGeometry(ls, ls * 0.9, ls);
    const headGeos = [];
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const f = frameAt(t);
      const s = i % 2 === 0 ? 1 : -1; // alternate sides — cuter, less runway-like
      const base = deckPos(t).addScaledVector(f.right, s * (halfW - ls));

      // dark post
      scl.set(ls * 0.35, p.lightHeight, ls * 0.35);
      m.makeBasis(f.right, f.up, f.fwd)
        .scale(scl)
        .setPosition(
          base.x + f.up.x * p.lightHeight * 0.5,
          base.y + f.up.y * p.lightHeight * 0.5,
          base.z + f.up.z * p.lightHeight * 0.5,
        );
      pushBox(m, darkCol);

      // little roof cap above the glowing head
      const headY = p.lightHeight + ls * 0.45;
      scl.set(ls * 1.3, ls * 0.22, ls * 1.3);
      m.makeBasis(f.right, f.up, f.fwd)
        .scale(scl)
        .setPosition(
          base.x + f.up.x * (headY + ls * 0.55),
          base.y + f.up.y * (headY + ls * 0.55),
          base.z + f.up.z * (headY + ls * 0.55),
        );
      pushBox(m, darkCol);

      const hg = headTemplate.clone();
      hg.translate(
        base.x + f.up.x * headY,
        base.y + f.up.y * headY,
        base.z + f.up.z * headY,
      );
      headGeos.push(hg);
    }
    headTemplate.dispose();
    const mergedHeads = mergeGeometries(headGeos, false);
    headGeos.forEach((g) => g.dispose());
    if (mergedHeads) {
      const headMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(p.lightColor).multiplyScalar(0.4),
        emissive: new THREE.Color(p.lightColor),
        emissiveIntensity: p.lightIntensity,
        roughness: 0.6,
        metalness: 0,
      });
      group.add(new THREE.Mesh(mergedHeads, headMat));
    }
  }

  // ── merge everything opaque into ONE vertex-colored mesh ──
  unitBox.dispose();
  unitPile.dispose();
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

/** Fixed hero span — a straight jetty for close-up tuning. */
export const BOAT_DOCK_HERO_POINTS = [
  { x: -8, y: 0, z: -14 },
  { x: 8, y: 0, z: -14 },
];
