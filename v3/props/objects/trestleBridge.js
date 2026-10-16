import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { seededRand } from "./woodUtils.js";
import { legSpan, bakeColor, sweepSquare, WORLD_UP } from "./trestle.js";

/**
 * Procedural timber trestle bridge (railway / wild-west / logging road) along
 * a spline.
 *
 * The long-span counterpart to the arched bridge: a dead-flat (or graded)
 * plank deck carried by TIMBER BENTS — frames of legs that each reach the
 * ground beneath themselves, with X-bracing between them. Cross a ravine and
 * the middle bents grow tall and splayed while the ones near the rims stay
 * stubby; the deck above never changes.
 *
 * Cost: ONE merged vertex-colored mesh (deck, bents, bracing, rails).
 */

export const TRESTLE_BRIDGE_DEFAULTS = {
  width: 4.0,
  pathSegments: 60,

  deckClearance: 0.6, // deck top above the higher end's ground
  grade: 0, // % fall from start to end (0 = dead level)
  deckThickness: 0.16,

  plankWidth: 0.32,
  plankGap: 0.03,
  plankToneVar: 0.12,

  stringers: 3, // longitudinal beams under the deck
  stringerW: 0.18,
  stringerH: 0.28,

  bentSpacing: 4.0, // metres between bents (leg frames)
  legsPerBent: 3, // legs across the width (2 = simple, 4 = heavy)
  legW: 0.24,
  legSplay: 0.12, // outward lean of the outer legs, per metre of height
  legEmbed: 0.5,
  legMaxHeight: 0, // 0 = unlimited (that's the point of a trestle)

  capBeam: true, // beam across each bent's leg tops
  capH: 0.24,

  bracing: true, // X-braces between adjacent bents
  braceW: 0.1,
  braceTiers: 2, // horizontal levels of X-bracing on tall bents
  braceMinHeight: 1.6, // bents shorter than this get no bracing

  rails: true,
  railHeight: 1.0,
  railR: 0.06,
  postSpacing: 2.4,

  woodMain: "#8a6a48",
  woodAlt: "#6b4f34",
  woodDark: "#4e3a26",
  roughness: 0.9,
  metalness: 0.0,
  seed: 17,
};

// ── builder ────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {THREE.Vector3[]|{x,y,z}[]} opts.points
 * @param {boolean} [opts.closed]
 * @param {object} [opts.params]
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group|null}
 */
export function buildTrestleBridgeMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const p = { ...TRESTLE_BRIDGE_DEFAULTS, ...params };

  const pts3 = points.map((pt) => new THREE.Vector3(pt.x, 0, pt.z));
  const curve = new THREE.CatmullRomCurve3(pts3, !!closed, "catmullrom", 0.5);
  const length = curve.getLength();
  const halfW = Math.max(0.6, p.width) * 0.5;

  const y0 = getWorldHeight(points[0].x, points[0].z);
  const yN = getWorldHeight(
    points[points.length - 1].x,
    points[points.length - 1].z,
  );
  const startY = Math.max(y0, yN) + p.deckClearance;
  const fall = length * (p.grade / 100);
  const deckY = (t) => startY - fall * t;

  const group = new THREE.Group();
  group.name = "TrestleBridge";

  const allGeos = [];
  const _c = new THREE.Color();
  const mainCol = new THREE.Color(p.woodMain);
  const altCol = new THREE.Color(p.woodAlt);
  const darkCol = new THREE.Color(p.woodDark);

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  unitBox.deleteAttribute("uv");
  const m = new THREE.Matrix4();
  const scl = new THREE.Vector3();

  const pushBox = (matrix, color) => {
    const g = unitBox.clone();
    g.applyMatrix4(matrix);
    bakeColor(g, color);
    allGeos.push(g);
  };
  // a beam between two arbitrary world points (bracing, splayed legs)
  const fwd = new THREE.Vector3();
  const rt = new THREE.Vector3();
  const up = new THREE.Vector3();
  const pushBeam = (a, b, w, d, color) => {
    fwd.subVectors(b, a);
    const len = fwd.length();
    if (len < 0.02) return;
    fwd.normalize();
    rt.crossVectors(fwd, WORLD_UP);
    if (rt.lengthSq() < 1e-9) rt.set(1, 0, 0);
    rt.normalize();
    up.crossVectors(rt, fwd).normalize();
    scl.set(w, len, d);
    m.makeBasis(rt, fwd, up)
      .scale(scl)
      .setPosition((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
    pushBox(m, color);
  };

  const frameAt = (t) => {
    const e = 0.002;
    const a = curve.getPointAt(THREE.MathUtils.clamp(t - e, 0, 1));
    const b = curve.getPointAt(THREE.MathUtils.clamp(t + e, 0, 1));
    const f = b.sub(a).setY(0).normalize();
    if (f.lengthSq() < 1e-9) f.set(0, 0, 1);
    const right = new THREE.Vector3().crossVectors(WORLD_UP, f).normalize();
    return { right, fwd: f };
  };
  const at = (t) => {
    const c = curve.getPointAt(THREE.MathUtils.clamp(t, 0, 1));
    return new THREE.Vector3(c.x, deckY(t), c.z);
  };

  // ── deck planks ──
  const plankPitch = Math.max(0.08, p.plankWidth + p.plankGap);
  const plankCount = Math.max(2, Math.floor(length / plankPitch));
  for (let i = 0; i < plankCount; i++) {
    const t = (i + 0.5) / plankCount;
    const f = frameAt(t);
    const c = at(t);
    const lenJit = 1 + (seededRand(p.seed, i * 3 + 1) - 0.5) * 0.05;
    scl.set(p.width * lenJit, p.deckThickness, p.plankWidth);
    m.makeBasis(f.right, WORLD_UP, f.fwd)
      .scale(scl)
      .setPosition(c.x, c.y - p.deckThickness * 0.5, c.z);
    const v = (seededRand(p.seed, i * 3 + 2) - 0.5) * 2 * p.plankToneVar;
    _c.copy(mainCol).offsetHSL(0, v * 0.15, v).multiply(mainCol);
    pushBox(m, _c);
  }

  const segs = Math.max(12, p.pathSegments | 0);
  const deckBottom = p.deckThickness;

  // ── longitudinal stringers under the deck ──
  const nStr = Math.max(2, p.stringers | 0);
  for (let s = 0; s < nStr; s++) {
    const frac = nStr === 1 ? 0 : (s / (nStr - 1)) * 2 - 1; // -1..1
    const off = frac * (halfW - p.stringerW * 0.8);
    const centers = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const f = frameAt(t);
      const c = at(t);
      centers.push(
        new THREE.Vector3(
          c.x,
          c.y - deckBottom - p.stringerH * 0.5,
          c.z,
        ).addScaledVector(f.right, off),
      );
    }
    const g = sweepSquare(centers, Math.max(p.stringerW, p.stringerH) * 0.5);
    bakeColor(g, altCol);
    allGeos.push(g);
  }

  // ── bents: leg frames that each reach the ground ──
  const bentTopY = (t) => at(t).y - deckBottom - p.stringerH - (p.capBeam ? p.capH : 0);
  const nBents = Math.max(2, Math.floor(length / Math.max(1, p.bentSpacing)) + 1);
  const nLegs = Math.max(2, p.legsPerBent | 0);
  const bents = [];

  for (let i = 0; i < nBents; i++) {
    const t = nBents === 1 ? 0.5 : i / (nBents - 1);
    const f = frameAt(t);
    const c = at(t);
    const topY = bentTopY(t);

    // cap beam across the leg tops
    if (p.capBeam) {
      scl.set(halfW * 2, p.capH, p.legW * 1.3);
      m.makeBasis(f.right, WORLD_UP, f.fwd)
        .scale(scl)
        .setPosition(c.x, topY + p.capH * 0.5, c.z);
      pushBox(m, darkCol);
    }

    const legs = [];
    for (let k = 0; k < nLegs; k++) {
      const frac = nLegs === 1 ? 0 : (k / (nLegs - 1)) * 2 - 1; // -1..1
      const topOff = frac * (halfW - p.legW * 0.7);
      const top = new THREE.Vector3(c.x, topY, c.z).addScaledVector(
        f.right,
        topOff,
      );
      const leg = legSpan(top.y, getWorldHeight(top.x, top.z), {
        embed: p.legEmbed,
        maxLength: p.legMaxHeight,
        minLength: 0.3,
      });
      // outer legs splay outward as they get taller — the trestle silhouette
      const splay = frac * p.legSplay * leg.length;
      const bottom = new THREE.Vector3(top.x, leg.bottomY, top.z).addScaledVector(
        f.right,
        splay,
      );
      pushBeam(top, bottom, p.legW, p.legW, altCol);
      legs.push({ top, bottom, len: leg.length });
    }
    bents.push({ t, f, c, topY, legs });
  }

  // ── X-bracing between adjacent bents (and across each tall bent) ──
  if (p.bracing) {
    const tiers = Math.max(1, p.braceTiers | 0);
    for (let i = 0; i < bents.length - 1; i++) {
      const A = bents[i];
      const B = bents[i + 1];
      const hA = A.legs[0].len;
      const hB = B.legs[0].len;
      if (Math.min(hA, hB) < p.braceMinHeight) continue;

      // brace the two OUTER leg lines (left and right of the frame)
      for (const li of [0, A.legs.length - 1]) {
        const a = A.legs[li];
        const b = B.legs[li];
        for (let k = 0; k < tiers; k++) {
          const lo = k / tiers;
          const hi = (k + 1) / tiers;
          const aLo = new THREE.Vector3().lerpVectors(a.bottom, a.top, lo);
          const aHi = new THREE.Vector3().lerpVectors(a.bottom, a.top, hi);
          const bLo = new THREE.Vector3().lerpVectors(b.bottom, b.top, lo);
          const bHi = new THREE.Vector3().lerpVectors(b.bottom, b.top, hi);
          pushBeam(aLo, bHi, p.braceW, p.braceW, darkCol);
          pushBeam(bLo, aHi, p.braceW, p.braceW, darkCol);
        }
      }
    }
    // cross-brace WITHIN each tall bent (across the width)
    for (const bt of bents) {
      const h = bt.legs[0].len;
      if (h < p.braceMinHeight) continue;
      const a = bt.legs[0];
      const b = bt.legs[bt.legs.length - 1];
      const tiers2 = Math.max(1, p.braceTiers | 0);
      for (let k = 0; k < tiers2; k++) {
        const lo = k / tiers2;
        const hi = (k + 1) / tiers2;
        const aLo = new THREE.Vector3().lerpVectors(a.bottom, a.top, lo);
        const aHi = new THREE.Vector3().lerpVectors(a.bottom, a.top, hi);
        const bLo = new THREE.Vector3().lerpVectors(b.bottom, b.top, lo);
        const bHi = new THREE.Vector3().lerpVectors(b.bottom, b.top, hi);
        pushBeam(aLo, bHi, p.braceW * 0.85, p.braceW * 0.85, darkCol);
        pushBeam(bLo, aHi, p.braceW * 0.85, p.braceW * 0.85, darkCol);
      }
    }
  }

  // ── railings ──
  if (p.rails) {
    const nPosts = Math.max(2, Math.floor(length / Math.max(0.6, p.postSpacing)) + 1);
    for (let i = 0; i < nPosts; i++) {
      const t = i / (nPosts - 1);
      const f = frameAt(t);
      const c = at(t);
      for (const s of [-1, 1]) {
        const pos = new THREE.Vector3(
          c.x,
          c.y + p.railHeight * 0.5,
          c.z,
        ).addScaledVector(f.right, s * (halfW - 0.08));
        scl.set(p.railR * 1.6, p.railHeight, p.railR * 1.6);
        m.makeBasis(f.right, WORLD_UP, f.fwd).scale(scl).setPosition(pos);
        pushBox(m, altCol);
      }
    }
    for (const s of [-1, 1]) {
      const centers = [];
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const f = frameAt(t);
        const c = at(t);
        centers.push(
          new THREE.Vector3(c.x, c.y + p.railHeight, c.z).addScaledVector(
            f.right,
            s * (halfW - 0.08),
          ),
        );
      }
      const g = sweepSquare(centers, p.railR);
      bakeColor(g, mainCol);
      allGeos.push(g);
    }
  }

  // ── merge into ONE vertex-colored mesh ──
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

/** Fixed hero span — a long crossing so the bents are visible. */
export const TRESTLE_BRIDGE_HERO_POINTS = [
  { x: -20, y: 0, z: -14 },
  { x: 20, y: 0, z: -14 },
];
