// ============================================================================
// ROUND TOWERS — the one shape the kit could never make.
//
// Every tower in this city is a box, and the facade shader is built on that:
// it finds a wall's face from its axis-aligned normal and lays windows out on
// it. A skyline of boxes reads as a grid from any distance, however good each
// wall is. A cylinder breaks that silhouette on its own, and on a CORNER lot —
// where it turns two streets at once — it is the building people give
// directions by.
//
// ── WHY IT IS NOT A KIT ARCHETYPE ────────────────────────────────────────────
//
// An archetype is shared by every system that reads the lot grid: the facade
// (windows from flat faces), the collider (one BVH per archetype), the rooftop
// clutter, the AC units and fire escapes (from the facade's window grid), the
// hero adverts (bolted to flat walls). A round tower is wrong for every one of
// them. So, like the gates, it RESERVES its lot before the lot loop and brings
// its own geometry, material and collider; nothing else in the city has to
// learn what a curve is.
//
// ── ONE DRAW FOR EVERY ROUND TOWER IN THE CITY ───────────────────────────────
//
// The towers never move, so all of them are merged into one geometry carrying
// per-vertex `aCenter` (the tower's axis) and `aTower` = (radius, mullion
// pitch, style, kind) packed into one vec4. The shader works in cylindrical
// coordinates about `aCenter`: metres AROUND the drum and metres UP, which is
// all a window grid needs.
//
// THE SEAM. `atan2` jumps from +π to −π on one line of every drum, so two
// things are done about it: the mullion pitch is chosen per tower so a WHOLE
// number of bays goes round (`aPitch`), and the anti-aliasing width comes from
// fwidth of world XZ, which is continuous, rather than of the angle, which is
// not — or every tower would carry one blurred vertical stripe.
//
// ── TWO STYLES ───────────────────────────────────────────────────────────────
//
//   GLASS      a curtain wall: slim spandrels, mullions at ~1.6 m, reflective.
//   BANDED     concrete floor bands with ribbon windows between them, mullions
//              at ~3.2 m — the 1960s drum, and a very different read at night.
// ============================================================================
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  float, vec2, vec3, uniform, attribute, positionWorld, normalWorld, cameraPosition,
  abs, floor, fract, smoothstep, mix, step, max, min, clamp, hash, fwidth, atan, length,
  normalize, dot, reflect, pow,
} from "three/tsl";

export const ROUND_TOWER_DEFAULTS = {
  roundTowers: true,
  /** Coarse cells of this many blocks a side each roll for one tower. */
  cellBlocks: 3,
  cellChance: 0.45,
  /** Only where the downtown falloff makes a tall enough tower. */
  minHeight: 60,
  maxHeight: 230,
  /** Drum radius range, metres — footprints of 23-29 m, inside a 34 m lot. */
  radiusMin: 11.5,
  radiusMax: 14.5,
  /** Share of towers that roll the banded concrete style. */
  bandedShare: 0.4,
  /** Keep clear of the landmark core — the three supertalls own it. */
  minRadiusFromCentre: 230,

  floorHeight: 3.8,
  podiumHeight: 7.6,
  podiumGrow: 1.4,
  crownHeight: 9.0,
  crownShrink: 0.8,
  mastHeight: 18,

  colorGlass: 0x24313d,
  colorSpandrelGlass: 0x3a444d,
  colorConcrete: 0xb9b6ad,
  colorMetal: 0x4a5057,
  litShare: 0.36,
};

export const ROUND_KIND = { shaft: 0, podium: 1, cap: 2, trim: 3, beacon: 4 };

// ── Planning ────────────────────────────────────────────────────────────────

/**
 * Decide where round towers go, BEFORE any lot is built — the same contract as
 * planCityGates: per coarse cell, on that cell's own dice, vetoed but never
 * re-rolled by static structures, and a runtime corridor veto that only removes.
 *
 * @returns {{towers: object[], reserved: Set<string>}|null}
 */
export function planRoundTowers({
  P, rand, isPlaza = null, keepOut = null, under = null, taken = null, heightAt = null,
  originCellX = 0, originCellZ = 0, extent = P.extent, params = {},
}) {
  const T = { ...ROUND_TOWER_DEFAULTS, ...params };
  if (!T.roundTowers || !rand) return null;
  const L = P.lotSize;
  const pitch = P.blockLots + P.streetLots;
  const N = Math.max(2, Math.round(T.cellBlocks));
  const blocksHalf = Math.ceil(extent / (pitch * L)) + 1;
  const cMin = Math.floor(-blocksHalf / N) - 1, cMax = Math.ceil(blocksHalf / N) + 1;

  const towers = [];
  const reserved = new Set();
  for (let gi = cMin; gi <= cMax; gi++) {
    for (let gj = cMin; gj <= cMax; gj++) {
      // Purpose keys apart from the gates' (401-407) and the plaza's (31).
      const I = gi * 7933 + 300007, J = gj * 7937 + 400009;
      if (rand(I, J, 501) >= T.cellChance) continue;
      const bx = gi * N + Math.floor(rand(I, J, 502) * N);
      const bz = gj * N + Math.floor(rand(I, J, 503) * N);
      // A CORNER lot: it turns two streets, which is the whole point of a drum.
      const cornerX = rand(I, J, 504) < 0.5 ? 0 : P.blockLots - 1;
      const cornerZ = rand(I, J, 505) < 0.5 ? 0 : P.blockLots - 1;
      const cx = originCellX + bx * pitch + cornerX;
      const cz = originCellZ + bz * pitch + cornerZ;
      const x = (cx + 0.5) * L, z = (cz + 0.5) * L;

      const r = Math.hypot(x - P.centerX, z - P.centerZ);
      if (r > extent || r < T.minRadiusFromCentre) continue;
      const fall = Math.pow(Math.max(0, 1 - r / extent), P.downtownPower ?? 2.2);
      const height = (T.minHeight + fall * (T.maxHeight - T.minHeight) * 1.6) * (0.85 + rand(I, J, 506) * 0.3);
      if (height < T.minHeight) continue;
      if (Number.isFinite(P.bounds)
        && (Math.abs(x) > P.bounds - P.boundsMargin || Math.abs(z) > P.bounds - P.boundsMargin)) continue;
      const key = `${cx},${cz}`;
      if (taken && taken.has(key)) continue;
      if (isPlaza && isPlaza(cx, cz)) continue;
      const radius = T.radiusMin + rand(I, J, 507) * (T.radiusMax - T.radiusMin);
      /*
       * ON TERRAIN, the same fit a box tower gets in the layout: the base is the
       * LOWEST of five samples over the footprint minus the sink, and a lot
       * steeper than `slopeLimit` is skipped. Without it a drum on a hillside
       * stood at street height — floating on one side, buried on the other.
       */
      let baseY = P.groundY;
      if (heightAt) {
        const f = radius + T.podiumGrow;
        const hs = [heightAt(x, z), heightAt(x - f, z - f), heightAt(x + f, z - f), heightAt(x - f, z + f), heightAt(x + f, z + f)];
        const lo = Math.min(...hs), hi = Math.max(...hs);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo > (P.slopeLimit ?? 6)) continue;
        baseY = lo - (P.sinkBias ?? 0.6);
      }
      const blocked = (wx, wz) => (keepOut && keepOut(wx, wz)) || (under && under(wx, wz));
      let clear = true;
      for (let k = 0; k < 12 && clear; k++) {
        const a = (k / 12) * Math.PI * 2;
        if (blocked(x + Math.cos(a) * (radius + T.podiumGrow), z + Math.sin(a) * (radius + T.podiumGrow))) clear = false;
      }
      if (!clear || blocked(x, z)) continue;

      reserved.add(key);
      towers.push({
        x, z, y: baseY, cx, cz, cell: key,
        radius, height, top: baseY + height + T.crownHeight + T.mastHeight,
        style: rand(I, J, 508) < T.bandedShare ? "banded" : "glass",
      });
    }
  }
  return { towers, reserved, params: T };
}

/** Does the track corridor come within `radius` of this tower's drum? */
export function roundTowerMeetsCorridor(t, avoid, radius) {
  const R = t.radius + 1.4;
  for (let k = 0; k <= 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const px = k === 12 ? t.x : t.x + Math.cos(a) * R;
    const pz = k === 12 ? t.z : t.z + Math.sin(a) * R;
    if (avoid(px, pz, t.top) < radius) return true;
  }
  return false;
}

/** True inside any tower's drum, grown by `margin`. */
export function roundTowerFootprint(plan, margin = 0.8) {
  if (!plan?.towers?.length) return null;
  const T = plan.params;
  const list = plan.towers.map((t) => [t.x, t.z, (t.radius + T.podiumGrow + margin) ** 2]);
  return (x, z) => {
    for (const [tx, tz, r2] of list) if ((x - tx) ** 2 + (z - tz) ** 2 <= r2) return true;
    return false;
  };
}

// ── Geometry ────────────────────────────────────────────────────────────────

/** An open or capped cylinder segment with the per-tower attributes baked in. */
function drum(t, T, r0, r1, y0, y1, kind, { segments = 48, capTop = false } = {}) {
  // Capped drums cap both ends; the bottom cap sits on the solid below and is
  // never seen, which costs a handful of triangles.
  const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, segments, 1, !capTop, 0, Math.PI * 2);
  g.translate(t.x, t.y + (y0 + y1) / 2, t.z);
  return finish(g, t, T, kind);
}

function finish(geo, t, T, kind) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  for (const n of Object.keys(g.attributes)) if (n !== "position" && n !== "normal") g.deleteAttribute(n);
  const count = g.getAttribute("position").count;
  const circ = Math.PI * 2 * t.radius;
  const want = t.style === "banded" ? 3.2 : 1.6;
  // A WHOLE number of bays round the drum, so the atan2 seam lands on a mullion.
  const pitch = circ / Math.max(8, Math.round(circ / want));
  const fill = (n, v) => new THREE.Float32BufferAttribute(new Float32Array(count * n).map((_, i) => v[i % n]), n);
  g.setAttribute("aCenter", fill(3, [t.x, t.y, t.z]));
  g.setAttribute("aTower", fill(4, [t.radius, pitch, t.style === "banded" ? 1 : 0, kind]));
  return g;
}

/**
 * Every tower in the plan, merged into ONE drawn geometry and ONE collider.
 *
 * Per tower: a podium drum a little wider than the shaft (shopfront glazing), the
 * shaft, a set-back glazed crown, a metal cap with a fascia ring, a mast and a
 * beacon. About 450 triangles a tower.
 */
export function buildRoundTowerGeometry(plan) {
  const T = plan.params;
  const K = ROUND_KIND;
  const parts = [];
  const colParts = [];
  for (const t of plan.towers) {
    const R = t.radius, H = t.height;
    const Rp = R + T.podiumGrow, Rc = R * T.crownShrink;
    parts.push(drum(t, T, Rp, Rp, 0, T.podiumHeight, K.podium, { capTop: true }));
    parts.push(drum(t, T, R, R, T.podiumHeight, H, K.shaft));
    // Fascia ring where the shaft stops and the crown steps in.
    parts.push(drum(t, T, R + 0.5, R + 0.5, H, H + 1.2, K.trim, { capTop: true }));
    parts.push(drum(t, T, Rc, Rc, H + 1.2, H + T.crownHeight, K.shaft));
    parts.push(drum(t, T, Rc + 0.35, Rc * 0.9, H + T.crownHeight, H + T.crownHeight + 1.0, K.cap, { capTop: true }));
    const mastBase = H + T.crownHeight + 1.0;
    parts.push(drum(t, T, 0.55, 0.22, mastBase, mastBase + T.mastHeight, K.trim, { segments: 8, capTop: true }));
    parts.push(drum(t, T, 0.45, 0.45, mastBase + T.mastHeight, mastBase + T.mastHeight + 0.9, K.beacon, { segments: 8, capTop: true }));

    // Collider: podium, shaft and crown as three 20-sided drums. The mast is
    // twenty metres above anything a car can reach.
    for (const [r, y0, y1] of [[Rp, 0, T.podiumHeight], [R, T.podiumHeight, H + 1.2], [Rc, H + 1.2, H + T.crownHeight + 1.0]]) {
      const c = new THREE.CylinderGeometry(r, r, y1 - y0, 20, 1, false);
      c.translate(t.x, t.y + (y0 + y1) / 2, t.z);
      const nc = c.toNonIndexed();
      c.dispose();
      for (const n of Object.keys(nc.attributes)) if (n !== "position") nc.deleteAttribute(n);
      colParts.push(nc);
    }
  }
  const geometry = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  const collision = mergeGeometries(colParts, false);
  for (const p of colParts) p.dispose();
  if (!geometry || !collision) throw new Error("[CityRoundTowers] merge returned null");
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, collision };
}

// ── Material ────────────────────────────────────────────────────────────────

/**
 * ONE material for every round tower. No `If`, every derivative at top level.
 *
 * Cylindrical coordinates about each vertex's `aCenter`: `around` in metres
 * along the drum, `up` in metres from the street. Floors and bays from those;
 * glass reflects a computed sky like the skybridges (the city has no
 * environment map for it to use); a hashed share of rooms light up at night.
 */
export function makeRoundTowerMaterial({ uNight = uniform(0), params = {} } = {}) {
  const T = { ...ROUND_TOWER_DEFAULTS, ...params };
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.0 });
  mat.name = "CityRoundTowers";

  const cGlass = uniform(new THREE.Color(T.colorGlass));
  const cSpandrel = uniform(new THREE.Color(T.colorSpandrelGlass));
  const cConcrete = uniform(new THREE.Color(T.colorConcrete));
  const cMetal = uniform(new THREE.Color(T.colorMetal));
  const uLit = uniform(T.litShare);

  const center = attribute("aCenter", "vec3");
  const tower = attribute("aTower", "vec4");
  const radius = tower.x, pitch = tower.y, banded = tower.z, kind = tower.w;
  const is = (k) => step(float(k - 0.5), kind).mul(float(1).sub(step(float(k + 0.5), kind)));
  const isShaft = is(ROUND_KIND.shaft), isPodium = is(ROUND_KIND.podium);
  const isCap = is(ROUND_KIND.cap), isTrim = is(ROUND_KIND.trim), isBeacon = is(ROUND_KIND.beacon);

  const pw = positionWorld;
  const rel = pw.xz.sub(center.xz);
  const around = atan(rel.y, rel.x).mul(radius);        // metres round the drum
  const up = pw.y.sub(center.y);
  // Continuous AA widths — see the header on the seam.
  const aaAround = max(length(fwidth(pw.xz)), float(1e-4));
  const aaUp = max(fwidth(up), float(1e-4));
  const vertical = float(1).sub(step(0.5, abs(normalWorld.y)));

  /** 1 on a band of half-width `hw` (metres) around every multiple of `period`. */
  const lines = (v, period, hw, aa) => {
    const d = abs(fract(v.div(period)).sub(0.5)).mul(period);
    return float(1).sub(smoothstep(hw, hw.add(aa), d));
  };

  // ── Floors: spandrel bands ────────────────────────────────────────────────
  const fh = float(T.floorHeight);
  const floorIdx = floor(up.div(fh));
  const inFloor = fract(up.div(fh)).mul(fh);            // metres up this floor
  // Glass: a slim 0.9 m spandrel at the slab. Banded: a deep 1.7 m concrete band.
  const spandrelH = mix(float(0.9), float(1.7), banded);
  const spandrel = float(1).sub(smoothstep(spandrelH, spandrelH.add(aaUp), inFloor));
  const mullion = lines(around, pitch, mix(float(0.05), float(0.09), banded), aaAround);

  // ── Glass that reflects a sky ─────────────────────────────────────────────
  const V = normalize(cameraPosition.sub(pw));
  const N = normalize(normalWorld);
  const R = reflect(V.negate(), N);
  const fres = float(0.06).add(float(0.94).mul(pow(float(1).sub(clamp(dot(N, V), 0.0, 1.0)), 5.0)));
  const sky = mix(vec3(0.34, 0.40, 0.47), vec3(0.16, 0.25, 0.38), smoothstep(-0.05, 0.6, R.y))
    .mul(mix(float(0.6), float(1.0), smoothstep(-0.25, 0.05, R.y)));
  const reflection = sky.mul(fres.mul(0.38).add(0.14)).mul(float(1).sub(uNight.mul(0.85)));

  // Rooms: one id per floor and bay, a fixed share lit at night.
  // A ROOM spans several panes. One pane per room (1.6 m) read as a tower of
  // lit slits at night; three on the glass drum, one wide ribbon bay (3.2 m)
  // on the banded one.
  const bay = floor(around.div(pitch.mul(mix(float(3.0), float(1.0), banded))));
  const roomId = hash(floorIdx.mul(113.0).add(bay.mul(7.0)).add(center.x.mul(0.37)).add(center.z.mul(0.53)));
  const lit = step(roomId, uLit);
  const warm = mix(vec3(1.0, 0.76, 0.48), vec3(0.92, 0.95, 1.0), hash(roomId.mul(71.0)).mul(0.6));

  const pane = float(1).sub(max(spandrel, mullion));
  const frameCol = mix(cSpandrel, cConcrete, banded);
  const shaftCol = mix(cGlass, frameCol, max(spandrel, mullion));

  // ── Podium: a tall shopfront and a concrete band over it ─────────────────
  const shopTop = float(T.podiumHeight - 1.6);
  const shopGlass = step(0.4, up).mul(float(1).sub(step(shopTop, up)));
  const shopMullion = lines(around, float(2.4), float(0.07), aaAround);
  const podiumPane = shopGlass.mul(float(1).sub(shopMullion));
  const podiumCol = mix(cConcrete.mul(0.9), cGlass.mul(0.8), podiumPane);

  const base = shaftCol.mul(isShaft)
    .add(podiumCol.mul(isPodium))
    .add(cMetal.mul(isCap.add(isTrim)))
    .add(vec3(0.3, 0.05, 0.04).mul(isBeacon));
  mat.colorNode = base;

  const glassArea = isShaft.mul(pane).add(isPodium.mul(podiumPane)).mul(vertical);
  mat.roughnessNode = mix(float(0.8), float(0.08), glassArea).sub(isCap.add(isTrim).mul(0.35));
  mat.metalnessNode = isCap.add(isTrim).mul(0.6).add(isShaft.mul(max(spandrel, mullion)).mul(float(1).sub(banded)).mul(0.5));

  const rooms = warm.mul(lit).mul(isShaft).mul(pane).mul(uNight).mul(0.75);
  const shops = vec3(1.0, 0.85, 0.62).mul(isPodium).mul(podiumPane).mul(mix(float(0.15), float(1.1), uNight));
  const beacon = vec3(1.0, 0.12, 0.08).mul(isBeacon).mul(mix(float(0.4), float(4.0), uNight));
  mat.emissiveNode = reflection.mul(glassArea).add(rooms).add(shops).add(beacon);

  return { material: mat, uniforms: { cGlass, cSpandrel, cConcrete, cMetal, uLit } };
}

// ── Build ───────────────────────────────────────────────────────────────────

export function createRoundTowers({ plan, uNight = uniform(0), castShadows = true } = {}) {
  if (!plan?.towers?.length) return null;
  const { geometry, collision } = buildRoundTowerGeometry(plan);
  const { material, uniforms } = makeRoundTowerMaterial({ uNight, params: plan.params });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "CityRoundTowers";
  mesh.castShadow = castShadows;
  mesh.receiveShadow = true;
  // One mesh spans the whole city; culling it as a whole would only ever keep it.
  mesh.frustumCulled = false;
  const group = new THREE.Group();
  group.name = "CityRoundTowersGroup";
  group.add(mesh);

  const collider = new THREE.Mesh(collision, material);
  collider.name = "CityRoundTowerCollision";
  collider.visible = false;
  collider.updateMatrixWorld(true);

  const tris = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
  return {
    group, mesh, uniforms, plan,
    collisionMeshes() { return { deck: [], solids: [collider] }; },
    stats: { towers: plan.towers.length, draws: 1, tris: tris(geometry), collisionTris: tris(collision) },
    dispose() { geometry.dispose(); collision.dispose(); material.dispose(); },
  };
}
