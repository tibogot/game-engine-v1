// ── SKYBRIDGES ───────────────────────────────────────────────────────────────
//
// Glazed links thrown across a street between two towers. Half a dozen of them
// in a city, and they do something no amount of facade detail can: they put
// something IN the gap between buildings. A grid of blocks is read as a grid
// because the space between the blocks is always empty; one bridge across it
// says the two sides were built to relate to each other.
//
// They are also the best value on the list from the track. You fly over the
// canyons; a bridge is the only thing that ever crosses one.
//
// ── HOW A PAIR IS FOUND ──────────────────────────────────────────────────────
//
// Two buildings face each other across a street when their lot cells differ by
// `streetLots + 1` on one axis and nothing on the other — the last lot of one
// block and the first lot of the next, with the street between them. That is
// the only geometric fact needed, and it comes straight off the lot grid, so
// there is no search and no spatial index.
//
// ── ONE DRAW, AND THE SCALE IS IN X ALONE ────────────────────────────────────
//
// One InstancedMesh. The geometry is a unit-length bridge — real dimensions in
// Y and Z, length 1 in X — so the per-instance matrix scales ONLY its span.
// That matters: the sill, the glazing and the roof cap are bands baked into
// the geometry, and scaling Y to fit a longer bridge would stretch them. A
// longer bridge is longer, not taller.

import * as THREE from "three";
import { mix, float, vec3, uniform, vertexColor, positionGeometry, abs, step } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { shareInstancePipeline } from "../../v3/render/instancePipeline.js";

export const BRIDGE_DEFAULTS = {
  /** Off and nothing is built. */
  bridges: true,
  /** Chance a facing pair gets one. A skybridge is an event, not a feature —
   *  at 0.06 a 2.4 km city gets a handful. */
  bridgeChance: 0.055,
  /** Both towers must be at least this tall, or the "sky" bridge is a
   *  footbridge and reads as one. */
  bridgeMinHeight: 45,
  /** Where on the shorter tower it crosses, as a fraction of that height.
   *  Kept clear of the top so it never looks like a roof. */
  bridgeLow: 0.35,
  bridgeHigh: 0.72,
  /** The deck itself, metres. */
  bridgeWidth: 4.2,
  bridgeHeight: 3.6,
  /** How far the ends push INTO each tower, so a bridge never floats with a
   *  gap at the wall. */
  bridgeBite: 2.2,
  /** Lit inside at night — a walkway is always lit, and a dark tube between
   *  two lit towers reads as a mistake. */
  bridgeGlow: 1.6,
};

const SILL = 0.30, CAP = 0.34;

/**
 * A unit-length bridge: 1 m along X, real size in Y and Z.
 *
 * Three bands, merged and vertex-coloured, so ONE material covers frame and
 * glass. The glass band is tagged in the colour's green channel rather than by
 * position, because the instance matrix scales X and a position test would
 * then mean something different on every bridge.
 */
export function buildBridgeGeometry(P) {
  const W = P.bridgeWidth, H = P.bridgeHeight;
  const glassH = Math.max(0.4, H - SILL - CAP);
  const parts = [];
  const push = (h, y, r, g, b) => {
    const q = new THREE.BoxGeometry(1, h, W).toNonIndexed();
    q.translate(0, y, 0);
    const n = q.getAttribute("position").count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b; }
    q.setAttribute("color", new THREE.BufferAttribute(col, 3));
    parts.push(q);
  };
  // Sill, glazing, roof cap. Green channel 1.0 marks the glass to the shader.
  push(SILL, SILL * 0.5, 0.34, 0.0, 0.36);
  push(glassH, SILL + glassH * 0.5, 0.09, 1.0, 0.13);
  push(CAP, SILL + glassH + CAP * 0.5, 0.30, 0.0, 0.32);
  const g = mergeGeometries(parts, false);
  for (const q of parts) q.dispose();
  if (!g) throw new Error("[CityBridges] merge returned null");
  return g;
}

export function makeBridgeMaterial(uNight, P) {
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.42, metalness: 0.25, vertexColors: true,
  });
  mat.name = "CityBridges";
  const uGlow = uniform(P.bridgeGlow);
  /*
   * THE GLASS IS FOUND BY ITS TAG, NOT ITS HEIGHT. `positionGeometry.y` would
   * work only until the first bridge with a different deck height, and the
   * green channel is already carried per vertex for free.
   */
  const isGlass = step(float(0.5), vertexColor().g);
  // `.rgb`: vertexColor() is a vec4, and mixing it with a vec3 is the same
  // type mismatch that had the roofs asking for a five-component vec4.
  mat.colorNode = mix(vertexColor().rgb, vec3(0.055, 0.062, 0.075), isGlass);
  // Lit inside. Warm, because a walkway is; a dark tube strung between two lit
  // towers reads as something broken rather than something built.
  mat.emissiveNode = vec3(1.0, 0.90, 0.74).mul(isGlass).mul(uNight).mul(uGlow);
  return { material: mat, uGlow };
}

/**
 * Find the facing pairs and place a bridge across some of them.
 *
 * `buildings` and `archetypes` are what createCitySigns is handed, so this
 * needs nothing new plumbed through the city. Returns null when the seed
 * produced no eligible pair, which is a legitimate outcome and not an error.
 */
export function placeCityBridges({ buildings, archetypes, rand, params = {} } = {}) {
  const P = { ...BRIDGE_DEFAULTS, ...params };
  if (!P.bridges || !buildings?.length) return null;

  const byCell = new Map();
  for (const b of buildings) byCell.set(`${b.cx},${b.cz}`, b);
  const gap = (P.streetLots ?? 1) + 1;

  const spans = [];
  const half = (b, alongX) => {
    const a = archetypes?.[b.arch];
    if (!a) return 0;
    // The footprint measured ACROSS the street the bridge crosses.
    return (alongX ? a.width : a.depth) * 0.5;
  };
  for (const b of buildings) {
    const hA = b.top - b.y;
    if (hA < P.bridgeMinHeight) continue;
    // Only +x and +z, so each pair is considered once rather than twice.
    for (const [dx, dz] of [[gap, 0], [0, gap]]) {
      const o = byCell.get(`${b.cx + dx},${b.cz + dz}`);
      if (!o) continue;
      const hB = o.top - o.y;
      if (hB < P.bridgeMinHeight) continue;
      if (rand(b.cx, b.cz, dx ? 41 : 43) >= P.bridgeChance) continue;
      const alongX = dx !== 0;
      /*
       * THE DECK SITS ON THE SHORTER TOWER'S SCALE. Fractioning the taller
       * one puts the bridge above the shorter roof, where it is not a bridge
       * between two buildings any more — it is a bridge into a wall that
       * ends below it.
       */
      const lowTop = Math.min(b.top, o.top);
      const base = Math.max(b.y, o.y);
      const f = P.bridgeLow + rand(b.cx, b.cz, dx ? 45 : 47) * (P.bridgeHigh - P.bridgeLow);
      const y = base + (lowTop - base) * f;
      // End to end, biting into each tower so no gap can open at the wall.
      const c0 = (alongX ? b.x : b.z) + half(b, alongX) - P.bridgeBite;
      const c1 = (alongX ? o.x : o.z) - half(o, alongX) + P.bridgeBite;
      const span = c1 - c0;
      if (span < 6) continue;                  // the towers already touch
      // The two cells are recorded so a test can check the bridge against the
      // towers it claims to join, rather than against the numbers that placed
      // it — which would only prove the arithmetic was copied correctly.
      spans.push({
        x: alongX ? (c0 + c1) * 0.5 : b.x,
        z: alongX ? b.z : (c0 + c1) * 0.5,
        y, span, alongX,
        a: `${b.cx},${b.cz}`, b: `${o.cx},${o.cz}`,
      });
    }
  }
  if (!spans.length) return null;

  const geo = buildBridgeGeometry(P);
  const { material, uGlow } = makeBridgeMaterial(params.uNight ?? uniform(0), P);
  const mesh = shareInstancePipeline(new THREE.InstancedMesh(geo, material, spans.length));
  mesh.name = "CityBridges";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3(), scl = new THREE.Vector3();
  spans.forEach((s, i) => {
    // Length is X, so a z-running span turns a quarter turn. ONLY X scales.
    q.setFromAxisAngle(up, s.alongX ? 0 : Math.PI / 2);
    pos.set(s.x, s.y, s.z);
    scl.set(s.span, 1, 1);
    mesh.setMatrixAt(i, m.compose(pos, q, scl));
  });
  mesh.instanceMatrix.needsUpdate = true;

  const group = new THREE.Group();
  group.name = "CityBridgesGroup";
  group.add(mesh);
  return {
    group, mesh, uGlow, count: spans.length, spans,
    dispose() { geo.dispose(); material.dispose(); mesh.dispose(); },
  };
}
