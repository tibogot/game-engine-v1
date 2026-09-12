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
// ── THE TWO THINGS THAT WERE WRONG WITH THEM ─────────────────────────────────
//
// 1. MOST OF THEM WERE NOT OVER A STREET. "Two cells `streetLots + 1` apart"
//    only has a street between them when the first cell is the LAST lot of its
//    block; anywhere else the cell in between is another lot. MEASURED on the
//    default city: 11 of 19 bridges crossed a lot, 10 of them straight through
//    the tower standing on it — which is why a skybridge usually read as two
//    small stubs poking out of either side of one building.
//
// 2. THEY WERE GREEN AND PURPLE. The glass was tagged by setting the vertex
//    colour's green channel to 1, and the material also declared
//    `vertexColors: true` — so three multiplied that tag in as a COLOUR. The
//    frame came out (0.34, 0, 0.36), purple, and the glass green. The same trap
//    the underpass walls fell into, where a shade packed in red rendered red.
//
// Now: a concrete deck and roof slab carrying the viaduct's own faked-concrete
// detail (no new noise), a recessed glazed band with the mullions and the
// handrail DRAWN on it, an aluminium-grey frame, and the ceiling lights showing
// through the glass after dark. The part is a real attribute, `aPart`, and
// there are no vertex colours at all.
//
// ── ONE DRAW, AND THE SCALE IS IN X ALONE ────────────────────────────────────
//
// One InstancedMesh. The geometry is a unit-length bridge — real dimensions in
// Y and Z, length 1 in X — so the per-instance matrix scales ONLY its span.
// That matters: the sill, the glazing and the roof cap are bands baked into
// the geometry, and scaling Y to fit a longer bridge would stretch them. A
// longer bridge is longer, not taller.

import * as THREE from "three";
import {
  mix, float, vec3, uniform, attribute, positionGeometry, positionWorld, normalWorldGeometry,
  abs, step, fract, smoothstep, fwidth, max, min, cameraPosition, normalWorld, normalize, dot,
  reflect, pow, clamp,
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { shareInstancePipeline } from "../../v3/render/instancePipeline.js";
import { concreteDetail } from "./modularRoadCityViaduct.js";

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
  /** Metres between mullions along the glazing. */
  mullionPitch: 1.8,
  /** Concrete, frame and glass. */
  colorConcrete: 0x9c9d99,
  colorFrame: 0x8a9096,
  colorGlass: 0x1b2530,
};

/** Deck slab, roof slab, and how far the glass is set back from both. */
const DECK = 0.85, ROOF = 0.62, INSET = 0.14, LIP = 0.22;
/** `aPart` values. */
export const BRIDGE_PART = { concrete: 0, glass: 1 };

/**
 * A unit-length bridge: 1 m along X, real size in Y and Z.
 *
 * Three boxes: the deck slab, the glazed band set back from it, and a roof slab
 * that oversails the glass by `LIP` so it throws a shadow line down the top of
 * the glazing — the detail that makes a band of glass read as recessed rather
 * than painted on. Tagged by `aPart`, never by colour.
 */
export function buildBridgeGeometry(P) {
  const W = P.bridgeWidth, H = P.bridgeHeight;
  const glassH = Math.max(0.6, H - DECK - ROOF);
  const parts = [];
  const push = (h, y, d, part) => {
    const q = new THREE.BoxGeometry(1, h, d).toNonIndexed();
    q.translate(0, y + h / 2, 0);
    q.deleteAttribute("uv");
    const n = q.getAttribute("position").count;
    q.setAttribute("aPart", new THREE.Float32BufferAttribute(new Float32Array(n).fill(part), 1));
    parts.push(q);
  };
  push(DECK, 0, W, BRIDGE_PART.concrete);
  push(glassH, DECK, W - INSET * 2, BRIDGE_PART.glass);
  push(ROOF, DECK + glassH, W + LIP * 2, BRIDGE_PART.concrete);
  const g = mergeGeometries(parts, false);
  for (const q of parts) q.dispose();
  if (!g) throw new Error("[CityBridges] merge returned null");
  return g;
}

/**
 * ONE small material. No `If`: two surfaces blended by `aPart`, every
 * derivative at the top level.
 *
 * The concrete is the viaduct's `concreteDetail` — form-panel seams, blotch
 * and speckle already written, already measured cheap, and it makes a bridge
 * read as the same concrete as the motorway it shares a skyline with.
 *
 * THE GLASS REFLECTS A SKY IT COMPUTES ITSELF. The first version leaned on the
 * scene environment for its reflection — and there is none: the city's towers
 * fake their own, so these panes rendered black from every angle. A reflected
 * direction, a two-colour sky gradient and a Schlick fresnel is a dot, a
 * reflect and a pow; it fades out at night, when the room inside takes over.
 */
export function makeBridgeMaterial(uNight, P) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0.0 });
  mat.name = "CityBridges";
  const uGlow = uniform(P.bridgeGlow);
  const cConcrete = uniform(new THREE.Color(P.colorConcrete ?? BRIDGE_DEFAULTS.colorConcrete));
  const cFrame = uniform(new THREE.Color(P.colorFrame ?? BRIDGE_DEFAULTS.colorFrame));
  const cGlass = uniform(new THREE.Color(P.colorGlass ?? BRIDGE_DEFAULTS.colorGlass));
  const pitch = float(P.mullionPitch ?? BRIDGE_DEFAULTS.mullionPitch);

  const isGlass = step(float(0.5), attribute("aPart", "float"));
  const detail = concreteDetail();

  /*
   * ALONG THE BRIDGE, in metres. The instance matrix scales X by the span, so
   * geometry X is a fraction and cannot place a mullion. World position can,
   * and the long glazed faces are exactly the ones whose normal is across the
   * bridge — so whichever of x and z that normal is NOT along is the length.
   */
  const pw = positionWorld;
  const along = mix(pw.x, pw.z, step(float(0.5), abs(normalWorldGeometry.x)));
  // Height up the glass, in metres from the deck: X-only scaling leaves Y real.
  const up = positionGeometry.y.sub(DECK);
  const glassH = Math.max(0.6, P.bridgeHeight - DECK - ROOF);

  const lineMask = (v, period, halfW) => {
    const f = abs(fract(v.div(period)).sub(0.5)).mul(period);   // metres to the nearest line
    const aa = max(fwidth(v), float(1e-4));
    return float(1).sub(smoothstep(float(halfW), float(halfW).add(aa), f));
  };
  const mullion = lineMask(along.add(pitch.mul(0.5)), pitch, 0.045);
  // Frame at the head and sill of the glass, and the handrail a metre up.
  const band = (y0, h) => {
    const aa = max(fwidth(up), float(1e-4));
    return smoothstep(float(y0 - h).sub(aa), float(y0 - h), up).mul(
      float(1).sub(smoothstep(float(y0 + h), float(y0 + h).add(aa), up)));
  };
  const frameH = max(max(band(0.05, 0.06), band(glassH - 0.05, 0.06)), band(1.05, 0.035));
  const frame = max(mullion, frameH).mul(isGlass);

  // A faint lighter reflection toward the top of each pane, so the glass is not
  // one flat colour where the environment reflection is weak.
  const sheen = smoothstep(float(0.2), float(glassH), up).mul(0.35);
  const glass = cGlass.mul(float(1).add(sheen));
  // `detail()`, CALLED: concreteDetail hands back a Fn, and multiplying by the
  // Fn itself instead of its result is what first rendered these slabs black.
  const concrete = cConcrete.mul(detail());

  let col = mix(concrete, glass, isGlass);
  col = mix(col, cFrame, frame);
  mat.colorNode = col;
  mat.roughnessNode = mix(float(0.86), mix(float(0.06), float(0.45), frame), isGlass);
  mat.metalnessNode = frame.mul(0.6);

  /*
   * LIT INSIDE after dark: a ceiling strip seen through the top of the glass,
   * and a softer warm fill below it. Warm, because a walkway is; a dark tube
   * strung between two lit towers reads as something broken.
   */
  const ceiling = smoothstep(float(glassH - 0.55), float(glassH - 0.15), up);
  const fill = float(0.18);
  const pane = isGlass.mul(float(1).sub(frame));
  // By day only the ceiling strip shows through; the warm fill of the room is a
  // night thing — by day it greyed every pane, which is not what glass does.
  const lit = pane.mul(ceiling.mul(mix(float(0.25), float(0.9), uNight)).add(fill.mul(uNight)));
  const lightsOn = float(1.0);

  const V = normalize(cameraPosition.sub(positionWorld));
  const N = normalize(normalWorld);
  const R = reflect(V.negate(), N);
  const cosV = clamp(dot(N, V), 0.0, 1.0);
  const fresnel = float(0.06).add(float(0.94).mul(pow(float(1).sub(cosV), 5.0)));
  // Kept DARK and blue on purpose, matched by eye to the tower glass either side:
  // the first pass (horizon 0.62, fresnel up to 0.97) read as frosted white.
  const sky = mix(vec3(0.34, 0.40, 0.47), vec3(0.16, 0.25, 0.38), smoothstep(-0.05, 0.6, R.y))
    // Below the horizon the pane reflects the street canyon, not the sky.
    .mul(mix(float(0.6), float(1.0), smoothstep(-0.25, 0.05, R.y)));
  /*
   * TUNED IN THE GAME, three passes, from under a bridge at street level:
   *   0.12 + 0.85·F   frosted white panes
   *   0.03 + 0.32·F   a black band; the mullions vanished into it
   *   0.14 + 0.38·F   blue-grey, reads as the same glass as the towers beside it
   * From below a pane mostly reflects the canyon, which is why the floor is not
   * lower: physically right and visually a hole in the sky.
   */
  const reflection = sky.mul(fresnel.mul(0.38).add(0.14)).mul(pane).mul(float(1).sub(uNight.mul(0.85)));

  mat.emissiveNode = vec3(1.0, 0.88, 0.70).mul(lit).mul(lightsOn).mul(uGlow).add(reflection);
  return { material: mat, uGlow };
}

/**
 * Find the facing pairs and place a bridge across some of them.
 *
 * `buildings` and `archetypes` are what createCitySigns is handed, so this
 * needs nothing new plumbed through the city. Returns null when the seed
 * produced no eligible pair, which is a legitimate outcome and not an error.
 */
export function placeCityBridges({ buildings, archetypes, rand, originCellX = 0, originCellZ = 0, params = {} } = {}) {
  const P = { ...BRIDGE_DEFAULTS, ...params };
  if (!P.bridges || !buildings?.length) return null;

  const byCell = new Map();
  for (const b of buildings) byCell.set(`${b.cx},${b.cz}`, b);
  const gap = (P.streetLots ?? 1) + 1;
  const blockLots = P.blockLots ?? 4;
  const pitch = blockLots + (P.streetLots ?? 1);
  const pmod = (v, m) => ((v % m) + m) % m;

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
      /*
       * A STREET IS ONLY BETWEEN THEM IF `b` ENDS ITS BLOCK. Anywhere else the
       * cell in between is another lot — the bug that put most of this city's
       * bridges through the middle of a tower. See the header.
       */
      const idx = dx ? pmod(b.cx - originCellX, pitch) : pmod(b.cz - originCellZ, pitch);
      if (idx !== blockLots - 1) continue;
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
