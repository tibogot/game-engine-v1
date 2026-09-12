// ============================================================================
// ROOFTOPS — the surface of the city you actually look at.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// This is a SKY-TRACK game. The facades get seen edge-on at 200 km/h; the
// ROOFS fill the bottom of the frame every time you look down, and every one
// of them was a bare tinted plate with a mast. All the facade work in
// modularRoadCityFacade.js is spent on the surface you see least.
//
// Real roofs are the messiest part of a city: air-handling plant, water tanks,
// vent stacks, duct runs, dish clusters. That mess is the whole read.
//
// ── WHY NOT BAKE IT INTO THE ARCHETYPE ──────────────────────────────────────
//
// The parapet IS baked (see modularRoadCityKit.js) because a wall round the
// deck is the same for every instance and costs no draw at all. Clutter is
// not: 2107 buildings share 21 archetypes, so baked clutter would repeat 100
// times over, in the one place where the mess is the point. It also rides the
// instance's Y-SCALE — a water tank stretched 1.22x vertically — because the
// towers are scaled 0.8-1.22 in Y and never in X or Z.
//
// So clutter is placed PER BUILDING, at unit scale, from the building's own
// lot hash. Four merged kinds, four InstancedMeshes, four draws for the city.
//
// ── AND WHY IT IS DISTANCE-CULLED HARD ──────────────────────────────────────
//
// A 2 m plant box is under a pixel long before the tower it stands on is, so
// this culls at its own range on the city's LOD timer — the same partition the
// street furniture uses. Roof clutter is silhouette at close range and noise
// at distance; drawing it to the horizon buys nothing and costs everything.
// ============================================================================
import * as THREE from "three";
import {
  Fn, float, vec3, vec4, uniform, positionWorld, mix,
  vertexColor, varyingProperty,
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
import { shareInstancePipeline } from "../../v3/render/instancePipeline.js";

export const ROOF_DEFAULTS = {
  /** Items per roof, before the deck's own size trims it. */
  minItems: 2,
  maxItems: 7,
  /** A roof smaller than this (metres either way) gets nothing: on a 12 m deck
   *  a plant box IS the roof, and it reads as a hat rather than as clutter. */
  minDeck: 11,
  /** How far a roof still draws its clutter. */
  range: 620,
  /** Fraction of roofs that carry a helipad ring instead of a stack. */
  helipadFraction: 0.06,
  nightAmount: 0,
  /** Night skyglow, matched to the rest of the city. */
  glowColor: 0x2a3348,
  glowAmount: 0.5,
  /** Obstruction lights on the tall plant, so a roof reads at night too. */
  beaconColor: 0xff3a26,
  beaconBoost: 3.0,
};

/** Integer hash → 0..1. Same shape the furniture uses, so placements are stable. */
function h2(a, b, c = 0) {
  let x = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x85ebca6b)) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39) >>> 0;
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

/** A box sitting on y = 0, centred at (x, z), with a flat vertex colour. */
function box(w, h, d, x = 0, y = 0, z = 0, tone = 1) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return tint(g, tone);
}

function cyl(r, h, x = 0, y = 0, z = 0, seg = 8, tone = 1) {
  const g = new THREE.CylinderGeometry(r, r, h, seg, 1, false).toNonIndexed();
  g.translate(x, y + h / 2, z);
  return tint(g, tone);
}

/**
 * Flat vertex colour, and NON-INDEXED.
 *
 * mergeGeometries returns null — silently — for a mixed indexed/non-indexed
 * set, and BoxGeometry is indexed while a `.toNonIndexed()` cylinder is not.
 * Everything goes through here so the whole kit shares one layout.
 */
function tint(g, tone) {
  const ng = g.index ? g.toNonIndexed() : g;
  if (ng !== g) g.dispose();
  const n = ng.getAttribute("position").count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) c[i] = tone;
  ng.setAttribute("color", new THREE.BufferAttribute(c, 3));
  return ng;
}

function merge(parts, name) {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error(`[CityRoofs] mergeGeometries returned null for ${name}`);
  for (const p of parts) p.dispose();
  return g;
}

/**
 * @param {object}   opts
 * @param {object}   opts.P            city params (groundY, centre, extent)
 * @param {object[]} opts.buildings    the placed buildings
 * @param {object[]} opts.archetypes   the kit's archetypes (each with `roof`)
 * @param {object}   [opts.params]     overrides on ROOF_DEFAULTS
 */
export function createCityRoofs({ P, buildings, archetypes, params: overrides = {} }) {
  const R = { ...ROOF_DEFAULTS, ...overrides };
  const group = new THREE.Group();
  group.name = "CityRoofs";

  const uNight = uniform(R.nightAmount);
  const uGlow = uniform(new THREE.Color(R.glowColor));
  const uGlowAmt = uniform(R.glowAmount);
  const uBeacon = uniform(new THREE.Color(R.beaconColor));

  // ── THE KIT ───────────────────────────────────────────────────────────────
  // Four kinds, each merged into one geometry. Tones are vertex colours, so a
  // single instanceColor per item still separates duct from casing from grille.

  /** Air handling: a casing, a recessed grille face, and a fan cowl on top. */
  const plantGeo = merge([
    box(2.6, 1.5, 1.9, 0, 0, 0, 1.0),
    box(2.2, 0.10, 1.6, 0, 1.5, 0, 0.55),          // dark grille lid
    cyl(0.62, 0.42, 0.55, 1.55, 0, 10, 0.75),      // fan cowl
    cyl(0.68, 0.08, 0.55, 1.97, 0, 10, 0.35),      // fan guard
    box(0.5, 0.55, 0.5, -0.95, 1.5, 0.55, 0.8),    // control box
  ], "plant");

  /** The NYC water tank: a staved drum on a steel frame, with a conical lid. */
  const tankGeo = (() => {
    const parts = [
      cyl(1.35, 2.6, 0, 2.2, 0, 12, 0.95),
      cyl(1.38, 0.18, 0, 4.72, 0, 12, 0.6),
    ];
    for (const [x, z] of [[-0.95, -0.95], [0.95, -0.95], [-0.95, 0.95], [0.95, 0.95]]) {
      parts.push(box(0.16, 2.2, 0.16, x, 0, z, 0.45));
    }
    return merge(parts, "tank");
  })();

  /** Vent stacks: three pipes of different heights and a duct run between them. */
  const stackGeo = merge([
    cyl(0.30, 3.4, -0.7, 0, 0, 8, 0.7),
    cyl(0.36, 0.16, -0.7, 3.4, 0, 8, 0.4),         // rain cap
    cyl(0.24, 2.3, 0.35, 0, 0.5, 8, 0.7),
    cyl(0.20, 1.6, 0.55, 0, -0.75, 8, 0.7),
    box(1.9, 0.55, 0.55, 0, 0.35, 0, 0.85),        // duct run
  ], "stack");

  /** A dish cluster on a short mast — the thing that says "this is downtown". */
  const dishGeo = (() => {
    const dish = new THREE.SphereGeometry(0.85, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.42);
    dish.rotateX(Math.PI * 0.62);
    dish.translate(0, 2.1, 0.25);
    return merge([
      cyl(0.14, 2.4, 0, 0, 0, 6, 0.5),
      tint(dish, 0.95),
      cyl(0.07, 1.5, 0.62, 1.4, -0.3, 5, 0.6),     // whip antenna
      box(0.7, 0.24, 0.7, 0, 0, 0, 0.45),          // base plate
    ], "dish");
  })();

  /** A painted helipad ring — flat, so it never fights the parapet. */
  const padGeo = (() => {
    const g = new THREE.RingGeometry(3.2, 3.9, 28).toNonIndexed();
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.05, 0);
    return tint(g, 1.0);
  })();

  // ── PLACEMENT ─────────────────────────────────────────────────────────────
  const lists = { plant: [], tank: [], stack: [], dish: [], pad: [] };
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
  const _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
  const UP = new THREE.Vector3(0, 1, 0);
  /** Rough footprint radius per kind, for the keep-apart test. */
  const FOOT = { plant: 1.8, tank: 1.7, stack: 1.4, dish: 1.2, pad: 4.1 };

  for (const b of buildings) {
    const a = archetypes[b.arch];
    const roof = a?.roof;
    if (!roof) continue;
    const w = roof.w, d = roof.d;
    if (Math.min(w, d) < R.minDeck) continue;

    // Usable deck, inside the parapet.
    const hx = w / 2 - roof.inset, hz = d / 2 - roof.inset;
    if (hx <= 1 || hz <= 1) continue;
    // X and Z are never scaled; only Y is. So the deck's world height is the
    // local roof height times the instance scale — the same rule the aviation
    // beacons follow for the mast tip.
    const y = b.y + roof.y * b.scaleY;
    // Keep out of the mechanical penthouse standing in the middle.
    const cx = roof.crownW / 2, cz = roof.crownD / 2;

    const n = R.minItems + Math.floor(h2(b.cx, b.cz, 91) * (R.maxItems - R.minItems + 1));
    const placed = [];
    const wantPad = h2(b.cx, b.cz, 97) < R.helipadFraction && hx > 4.5 && hz > 4.5 && cx === 0;

    for (let i = 0; i < n; i++) {
      // The helipad takes the middle of the deck and the first slot.
      const kindRoll = h2(b.cx, b.cz, 100 + i);
      const kind = (wantPad && i === 0) ? "pad"
        : kindRoll < 0.44 ? "plant"
          : kindRoll < 0.68 ? "tank"
            : kindRoll < 0.88 ? "stack" : "dish";
      const foot = FOOT[kind];

      let x = 0, z = 0, ok = false;
      // A few tries, then give up on this item rather than force an overlap —
      // a small deck should simply carry less, not the same amount stacked.
      for (let t = 0; t < 6 && !ok; t++) {
        x = (h2(b.cx, b.cz, 200 + i * 7 + t) * 2 - 1) * (hx - foot * 0.5);
        z = (h2(b.cx, b.cz, 400 + i * 7 + t) * 2 - 1) * (hz - foot * 0.5);
        if (kind === "pad") { x = 0; z = 0; }
        // Not through the penthouse — and only when there IS one. Written
        // without the guard, a crown-free deck (cx = cz = 0) rejected a disc
        // of radius `foot` at its own centre, which is precisely where the
        // helipad goes: not one was ever placed.
        if ((cx > 0 || cz > 0) && Math.abs(x) < cx + foot && Math.abs(z) < cz + foot) continue;
        // ...and not through anything already up here.
        ok = true;
        for (const q of placed) {
          const dx = x - q.x, dz = z - q.z;
          if (dx * dx + dz * dz < (foot + q.foot) * (foot + q.foot) * 0.55) { ok = false; break; }
        }
      }
      if (!ok) continue;
      placed.push({ x, z, foot });

      _p.set(b.x + x, y, b.z + z);
      _q.setFromAxisAngle(UP, h2(b.cx, b.cz, 600 + i) * Math.PI * 2);
      // A little tonal spread per item, so a roof of identical grey boxes does
      // not read as a texture atlas.
      const g = 0.62 + h2(b.cx, b.cz, 800 + i) * 0.5;
      lists[kind].push({ m: _m.compose(_p, _q, _s).clone(), tone: g, x: _p.x, y: _p.y, z: _p.z });
      if (kind === "pad") break;               // a pad owns the deck
    }
  }

  // ── MATERIAL ──────────────────────────────────────────────────────────────
  // One for everything: plant is painted steel, and the vertex tones plus the
  // per-instance tint carry all the variation this needs.
  const vTint = varyingProperty("vec3", "vRoofTint");
  const mat = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff, roughness: 0.62, metalness: 0.28, vertexColors: true,
  });
  mat.name = "CityRoofs";
  {
    // The city's night skyglow, multiplied by the surface's own albedo so a
    // pale casing picks it up and a dark duct barely does — an ambient light,
    // not a fog laid over the top. Same model the street and facade use.
    /*
     * `.rgb`, AND IT IS NOT COSMETIC. `vertexColor()` is a vec4 — the colour
     * attribute may carry alpha — so this was a vec4 all the way down and
     * `vec4(glow, 1.0)` below asked for five components. Three warned about it
     * on every city load and carried on, which is the worst of both: a real
     * type error that never failed loudly enough to fix itself.
     */
    const albedo = vertexColor().rgb.mul(vTint);
    const glow = albedo.mul(uGlow).mul(uGlowAmt).mul(uNight);
    mat.emissiveNode = glow;
    applyBloomMRT(mat, vec4(glow, 1.0));
  }

  const _c = new THREE.Color();
  function instanced(list, geo, name) {
    if (!list.length) { geo.dispose(); return null; }
    const im = shareInstancePipeline(new THREE.InstancedMesh(geo, mat, list.length));
    im.name = name;
    im.frustumCulled = false;
    im.castShadow = false;      // measured before turning on: see the header
    im.receiveShadow = true;
    list.forEach((e, i) => {
      im.setMatrixAt(i, e.m);
      im.setColorAt(i, _c.setScalar(e.tone));
    });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    group.add(im);
    return im;
  }

  const plantMesh = instanced(lists.plant, plantGeo, "CityRoofPlant");
  const tankMesh = instanced(lists.tank, tankGeo, "CityRoofTanks");
  const stackMesh = instanced(lists.stack, stackGeo, "CityRoofStacks");
  const dishMesh = instanced(lists.dish, dishGeo, "CityRoofDishes");
  const padMesh = instanced(lists.pad, padGeo, "CityRoofPads");

  const kinds = [
    { mesh: plantMesh, list: lists.plant },
    { mesh: tankMesh, list: lists.tank },
    { mesh: stackMesh, list: lists.stack },
    { mesh: dishMesh, list: lists.dish },
    { mesh: padMesh, list: lists.pad },
  ].filter((k) => k.mesh);

  const stats = {
    plant: lists.plant.length, tanks: lists.tank.length, stacks: lists.stack.length,
    dishes: lists.dish.length, pads: lists.pad.length,
    total: Object.values(lists).reduce((a, l) => a + l.length, 0),
    drawn: 0,
  };

  /**
   * Distance cull, on the city's own LOD timer.
   *
   * Each list is partitioned near-first and `count` cut at `range` — the same
   * trick the street furniture uses, and for the same reason: one mesh with
   * `frustumCulled = false` otherwise draws the whole city's roofs from
   * anywhere at all.
   */
  function applyLod(view) {
    const cam = view.pos;
    const r2 = R.range * R.range;
    let drawn = 0;
    for (const k of kinds) {
      const list = k.list;
      let lo = 0;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const dx = e.x - cam.x, dy = e.y - cam.y, dz = e.z - cam.z;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        // Nothing up here casts a shadow, so all of it takes the frustum test.
        if (!view.inView(e.x, e.y + 2.0, e.z, 3.0)) continue;
        if (i !== lo) {
          const t = list[i]; list[i] = list[lo]; list[lo] = t;
        }
        lo++;
      }
      // Only re-upload what is actually drawn.
      for (let i = 0; i < lo; i++) {
        k.mesh.setMatrixAt(i, list[i].m);
        k.mesh.setColorAt(i, _c.setScalar(list[i].tone));
      }
      k.mesh.count = lo;
      k.mesh.instanceMatrix.needsUpdate = true;
      if (k.mesh.instanceColor) k.mesh.instanceColor.needsUpdate = true;
      drawn += lo;
    }
    stats.drawn = drawn;
  }

  const params = new Proxy(R, {
    set(t, k, v) {
      if (!(k in t)) return true;
      t[k] = v;
      if (k === "nightAmount") uNight.value = v;
      else if (k === "glowAmount") uGlowAmt.value = v;
      else if (k === "glowColor") uGlow.value.set(v);
      else if (k === "beaconColor") uBeacon.value.set(v);
      return true;
    },
  });

  return {
    group,
    params,
    stats,
    applyLod,
    setNight(n) { uNight.value = Math.max(0, Math.min(1, n || 0)); },
    setGlow(hex, amount) {
      if (hex != null) uGlow.value.set(hex);
      if (amount != null) uGlowAmt.value = amount;
    },
    dispose() {
      for (const k of kinds) { k.mesh.geometry.dispose(); k.mesh.dispose(); }
      mat.dispose();
    },
  };
}
