// ── THE UNDERPASS ────────────────────────────────────────────────────────────
//
// A road that dips below the city, runs under two or three cross streets, and
// comes back up. The streets above it carry on at grade, unaware.
//
// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
//
// It is not the track kit's `Road tunnel` piece, which already exists and is
// excellent — vaulted concrete, wall LEDs, the lot — and which the player can
// place on their own track today. That is a tunnel you BUILD. This is a tunnel
// the CITY HAS, cut into the ground it is already standing on.
//
// ── THREE OF THE FOUR PIECES ALREADY EXISTED ─────────────────────────────────
//
// The road is `computeFrames` + `buildSweepGeometry`, exactly as the viaduct
// is, and the swept mesh IS its own collision surface. The vault is
// `buildVaultTunnel`, which sweeps along arbitrary frames and hands back a
// shell, a decimated collision proxy and the LED glow. Both materials are
// already built and compiled in the game, because the track's tunnel piece
// uses them — so the whole interior costs no new pipeline.
//
// The fourth piece is the only new idea here, and it is a hole in the ground.
//
// ── THE HOLE ─────────────────────────────────────────────────────────────────
//
// The city's street is TWO TRIANGLES at y = 0 with everything else done in the
// shader, and `streetHeightAt` is a flat `groundY`. Both have to stop being
// true inside the trench, in two completely different ways:
//
//   · VISUALLY the street plane draws straight over the hole, so the street
//     shader discards inside the trench rectangles. That is the one new
//     per-pixel cost in this feature, and it is a couple of rectangle tests on
//     a plane that is mostly off-screen anyway.
//   · PHYSICALLY `streetHeightAt` returns NaN there, which is a mechanism it
//     ALREADY HAS — it returns NaN outside the city and with terrain on, and
//     everything downstream reads NaN as "no ground here". Without it the car
//     drives across the hole on the street it is supposed to be under.
//
// AND THE COVERED SECTION NEEDS NO HOLE AT ALL, which is the nice part: the
// street plane IS the tunnel's lid. Only the open trench at each end is cut.
//
// ── WHAT IT COSTS ────────────────────────────────────────────────────────────
//
// Four draws: road, vault shell, its LED glow, and the trench walls. Materials
// shared with the track throughout, so no compile.

import * as THREE from "three";
import { Fn, uniform, vec3, mix, smoothstep, float, positionWorld, vertexColor } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  computeFrames, buildSweepGeometry, buildProfile, buildVaultTunnel,
  roadParams, pieceParams,
} from "./modularRoadKit.js";
import { concreteDetail } from "./modularRoadCityViaduct.js";

export const UNDERPASS_DEFAULTS = {
  /** Off and nothing is built. */
  underpass: true,
  /** Which street it runs along. Defaulted across the viaduct's axis so the
   *  two structures cross rather than fight over the same street. */
  underpassAxis: "z",
  /** Which street, in block pitches off centre. */
  underpassOffset: 0,

  /**
   * ── THE DEPTH, AND WHY IT IS THIS NUMBER ───────────────────────────────────
   *
   * The vault's crown stands `tunnelHeight` above the road and its shell is
   * about 0.4 m thick, so the road has to be at least that far down or the
   * tunnel's back breaks through the street it is running under — and it does
   * not look like a mistake from above, it looks like a concrete kerb nobody
   * ordered. 5.6 m of interior is generous for a car and keeps the excavation
   * shallow, which keeps the ramps short.
   */
  depth: 7.0,
  tunnelHeight: 5.6,

  /** The roofed part, and the open descent at each end. */
  coveredLength: 380,
  rampLength: 175,
  /** Fraction of the ramp still level before it starts down — the same eased
   *  crest the viaduct's slip roads use, for the same reason. */
  rampHold: 0.10,

  /** Road width down there. Narrower than the street above it. */
  roadWidth: 15,
  /** Station spacing. Tight through the portals, where the eye is. */
  step: 10,

  /** Trench walls: how far out from the road edge, and how thick. */
  wallGap: 0.35,
  wallThick: 0.5,
  /** The lip that runs along the top of the trench at street level. */
  lipWidth: 0.7,

  colorWall: 0x8d8c85,
  colorWallDirt: 0x46443f,
};

const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * ── WHERE THE UNDERPASS IS ───────────────────────────────────────────────────
 *
 * PURE. The geometry, the collision, the hole in the street plane and the
 * height function all need the same answer, and four systems only agree about a
 * structure if they ask one function rather than each deriving it.
 */
export function underpassLayout({ P, originCellX = 0, originCellZ = 0, params = {} }) {
  const U = { ...UNDERPASS_DEFAULTS, ...params };
  if (!U.underpass) return null;

  const pitch = (P.blockLots + P.streetLots) * P.lotSize;
  const blockW = P.blockLots * P.lotSize;
  const streetW = Math.max(P.streetLots * P.lotSize, 1);
  const ox = originCellX * P.lotSize, oz = originCellZ * P.lotSize;
  const half = P.extent;
  const axis = U.underpassAxis === "x" ? "x" : "z";

  const oAcross = axis === "x" ? oz : ox;
  const cAcross = axis === "x" ? P.centerZ : P.centerX;
  const cAlong = axis === "x" ? P.centerX : P.centerZ;
  const k = Math.round((cAcross - oAcross - blockW - streetW / 2) / pitch) + U.underpassOffset;
  const across = oAcross + k * pitch + blockW + streetW / 2;
  if (Math.abs(across - cAcross) > half) return null;

  const roadY = P.groundY - U.depth;
  const total = U.coveredLength + U.rampLength * 2;
  const a0 = cAlong - total / 2;
  const a1 = cAlong + total / 2;
  if (a0 < cAlong - half || a1 > cAlong + half) return null;

  /*
   * THE CENTRELINE. Down, along, and back up. The 2 cm at each end is the same
   * lip the viaduct's slip roads land on: a road ending exactly coplanar with
   * the street plane is a z-fight across the whole mouth, and 2 cm is far below
   * anything the suspension notices.
   */
  const top = P.groundY + 0.02;
  const path = [];
  const at = (a, y) => (axis === "x" ? new THREE.Vector3(a, y, across)
    : new THREE.Vector3(across, y, a));
  const depthAt = (a) => {
    // 0 at both mouths, 1 across the covered middle.
    const dIn = (a - a0) / U.rampLength;
    const dOut = (a1 - a) / U.rampLength;
    const t = Math.min(dIn, dOut);
    if (t >= 1) return 1;
    return ease((t - U.rampHold) / (1 - U.rampHold));
  };
  const n = Math.max(8, Math.round(total / U.step));
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    path.push(at(a, top - (top - roadY) * depthAt(a)));
  }

  /*
   * WHERE THE ROOF IS. The covered run, pulled in slightly at each end so the
   * portal stands where the trench has reached full depth rather than part way
   * down it — a vault mouth on a slope is a shape that cannot be built.
   */
  const cov0 = a0 + U.rampLength;
  const cov1 = a1 - U.rampLength;

  /*
   * ── THE HOLE ───────────────────────────────────────────────────────────────
   *
   * Two rectangles, one per open trench, in world XZ. Deliberately NOT one
   * rectangle over the whole run: the covered middle needs no hole because the
   * street plane is the tunnel's lid, and cutting it there would open a slot
   * down the middle of a street that is supposed to be intact.
   *
   * They start where the road has actually dropped below the plane. Cutting
   * from the very first station would leave a hole around a road still at
   * street level, which reads as the street simply missing.
   */
  const holeHalf = U.roadWidth / 2 + U.wallGap + U.wallThick + U.lipWidth;
  const sink = 0.35;
  let hIn = a0, hOut = a1;
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    if (top - path[i].y > sink) { hIn = a; break; }
  }
  for (let i = n; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / n;
    if (top - path[i].y > sink) { hOut = a; break; }
  }
  const rect = (lo, hi) => (axis === "x"
    ? { minX: lo, maxX: hi, minZ: across - holeHalf, maxZ: across + holeHalf }
    : { minX: across - holeHalf, maxX: across + holeHalf, minZ: lo, maxZ: hi });
  const openRects = [rect(hIn, cov0), rect(cov1, hOut)];

  return {
    axis, across, roadY, top, a0, a1, cov0, cov1, path, openRects, holeHalf,
    params: U,
  };
}

/**
 * Is (x, z) over open trench? Used by the street's height function, which has
 * to answer "no ground here" there — see the header.
 */
export function underpassOpenAt(layout) {
  if (!layout) return null;
  const r = layout.openRects;
  return (x, z) => {
    for (let i = 0; i < r.length; i++) {
      const q = r[i];
      if (x >= q.minX && x <= q.maxX && z >= q.minZ && z <= q.maxZ) return true;
    }
    return false;
  };
}

/** The whole run's footprint, for keeping buildings and furniture off it. */
export function underpassFootprint(layout, pad = 0) {
  if (!layout) return null;
  const h = layout.holeHalf + pad;
  const lo = Math.min(layout.a0, layout.a1), hi = Math.max(layout.a0, layout.a1);
  const axis = layout.axis;
  return (x, z) => {
    const along = axis === "x" ? x : z;
    const acr = axis === "x" ? z : x;
    return along >= lo && along <= hi && Math.abs(acr - layout.across) <= h;
  };
}

/** Concrete for the trench walls — the same faked pour the viaduct's piers use. */
function wallMaterial(U) {
  const detail = concreteDetail(U);
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.0 });
  m.name = "CityUnderpassWall";
  const base = uniform(new THREE.Color(U.colorWall));
  const dirt = uniform(new THREE.Color(U.colorWallDirt));
  const uTop = uniform(0);
  m.colorNode = Fn(() => {
    /*
     * A TRENCH WALL STAINS FROM THE BOTTOM, which is the opposite of a pier.
     * A pier is streaked by rain running off the deck above it; a retaining
     * wall stands in the water that collects at its foot, so the dark is at the
     * road and it fades upward.
     */
    const up = positionWorld.y.sub(uTop).toVar();
    const damp = smoothstep(float(2.6), float(0.0), up).mul(0.34);
    const cast = base.mul(vertexColor().rgb.r.mul(0.2).add(0.8)).mul(detail());
    return mix(cast, dirt, damp);
  })();
  return { material: m, uTop };
}

/**
 * Build the underpass.
 *
 * @param {object} opts
 * @param {ReturnType<typeof underpassLayout>} opts.layout
 * @param {THREE.Material} [opts.roadMaterial]   the game's road surface
 * @param {THREE.Material} [opts.vaultMaterial]  the track tunnel's shell
 * @param {THREE.Material} [opts.glowMaterial]   its LED battens
 */
export function createCityUnderpass({
  layout, roadMaterial = null, vaultMaterial = null, glowMaterial = null,
  castShadows = false,
}) {
  if (!layout) return null;
  const U = layout.params;
  const group = new THREE.Group();
  group.name = "CityUnderpass";
  const owned = [];
  const fallback = (name, opts) => {
    const m = new THREE.MeshStandardNodeMaterial(opts);
    m.name = name;
    owned.push(m);
    return m;
  };

  const rp = { ...roadParams, width: U.roadWidth };
  const profile = buildProfile(rp, true);
  const frames = computeFrames(layout.path);

  // ── The road ───────────────────────────────────────────────────────────────
  const roadGeo = buildSweepGeometry(frames, profile);
  {
    // The road material reads per-PIECE constants the sweep does not write —
    // see the same note in the viaduct. Without them the whole underpass reads
    // zero and its surface grain lines up with every other run that also has
    // none.
    const c = roadGeo.getAttribute("position").count;
    const d = new Float32Array(c * 2);
    const h = Math.abs(Math.sin(layout.a0 * 12.9898 + layout.across * 78.233) * 43758.5453);
    for (let i = 0; i < c; i++) { d[i * 2] = (h - Math.floor(h)) * 100; d[i * 2 + 1] = -1e4; }
    roadGeo.setAttribute("aPiece", new THREE.Float32BufferAttribute(d, 2));
  }
  const road = new THREE.Mesh(roadGeo,
    roadMaterial || fallback("UnderpassRoadFallback", { color: 0x3b3b3e, roughness: 0.92 }));
  road.name = "CityUnderpassRoad";
  road.receiveShadow = true;
  road.castShadow = false;
  road.frustumCulled = false;
  group.add(road);

  /*
   * ── THE VAULT ──────────────────────────────────────────────────────────────
   *
   * Swept along the covered stations only. `buildVaultTunnel` hands back the
   * shell, a DECIMATED collision proxy and the LED glow as three separate
   * geometries — the proxy matters here for the same reason the guardrail's
   * does: the thing the chassis is sampled against should not be the thing with
   * the ribs and the portal bevels on it.
   */
  const alongOf = (i) => (layout.axis === "x" ? frames[i].pos.x : frames[i].pos.z);
  const covFrames = frames.filter((_, i) => alongOf(i) >= layout.cov0 - 1e-6
    && alongOf(i) <= layout.cov1 + 1e-6);
  let vault = null, glow = null, vaultCollider = null;
  if (covFrames.length > 2) {
    const pp = { ...pieceParams, tunnelHeight: U.tunnelHeight };
    const built = buildVaultTunnel(covFrames, profile, pp);
    if (built?.shell) {
      vault = new THREE.Mesh(built.shell,
        vaultMaterial || fallback("UnderpassVaultFallback", { color: 0x6f6f6b, roughness: 0.95 }));
      vault.name = "CityUnderpassVault";
      vault.receiveShadow = true;
      vault.castShadow = castShadows;
      vault.frustumCulled = false;
      group.add(vault);
    }
    if (built?.glow) {
      glow = new THREE.Mesh(built.glow,
        glowMaterial || fallback("UnderpassGlowFallback", { color: 0xfff0d0 }));
      glow.name = "CityUnderpassGlow";
      glow.frustumCulled = false;
      group.add(glow);
    }
    if (built?.collision) {
      // Never drawn, only collided with — the same arrangement the viaduct's
      // guardrail proxy uses.
      vaultCollider = new THREE.Mesh(built.collision, road.material);
      vaultCollider.name = "CityUnderpassVaultCollision";
      vaultCollider.visible = false;
      vaultCollider.updateMatrixWorld();
    }
  }

  /*
   * ── THE TRENCH WALLS ───────────────────────────────────────────────────────
   *
   * Built by hand rather than with the kit's `channel`, and the reason is one
   * line of that function: its wall height is `channelRadius`, a constant. A
   * trench's wall height IS its depth, which is the whole point of a trench and
   * changes at every station. So this sweeps a wall from the road edge up to
   * street level, per station, which costs about thirty lines and is correct.
   *
   * A box rather than a sheet, because the chassis is SAMPLED against triangles
   * and a single-sided plane is something a fast car can find its way through.
   */
  const { material: wallMat, uTop } = wallMaterial(U);
  owned.push(wallMat);
  uTop.value = layout.roadY;
  let walls = null;
  {
    const inner = U.roadWidth / 2 + U.wallGap;
    const outer = inner + U.wallThick;
    const lip = outer + U.lipWidth;
    const pos = [], col = [], idx = [];
    const push = (p, shade) => {
      pos.push(p.x, p.y, p.z);
      col.push(shade, 0, 0);
      return pos.length / 3 - 1;
    };
    const quad = (a, b, c, d) => { idx.push(a, b, c, a, c, d); };
    const V = new THREE.Vector3();
    const atFrame = (i, lat, y) => {
      const f = frames[i];
      return V.copy(f.pos).addScaledVector(f.right, lat).setY(y);
    };
    for (let i = 0; i < frames.length; i++) {
      const y = frames[i].pos.y;
      // Only where there is actually a wall to build.
      if (layout.top - y < 0.08) continue;
      for (const s of [-1, 1]) {
        const a = push(atFrame(i, s * inner, y), 1.0);       // inner foot
        const b = push(atFrame(i, s * inner, layout.top), 1.0); // inner top
        const c = push(atFrame(i, s * outer, layout.top), 0.9); // outer top
        const d = push(atFrame(i, s * lip, layout.top), 0.8);   // lip edge
        void a; void b; void c; void d;
      }
    }
    // Stitch consecutive stations. Four verts per side per station, laid out
    // side -1 then side +1, so the stride is eight.
    const per = 8;
    const rows = pos.length / 3 / per;
    for (let r = 0; r + 1 < rows; r++) {
      for (let s = 0; s < 2; s++) {
        const o0 = r * per + s * 4, o1 = (r + 1) * per + s * 4;
        // inner face, top of wall, and the lip
        if (s === 0) {
          quad(o0 + 1, o0 + 0, o1 + 0, o1 + 1);
          quad(o0 + 2, o0 + 1, o1 + 1, o1 + 2);
          quad(o0 + 3, o0 + 2, o1 + 2, o1 + 3);
        } else {
          quad(o0 + 0, o0 + 1, o1 + 1, o1 + 0);
          quad(o0 + 1, o0 + 2, o1 + 2, o1 + 1);
          quad(o0 + 2, o0 + 3, o1 + 3, o1 + 2);
        }
      }
    }
    if (idx.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      walls = new THREE.Mesh(g, wallMat);
      walls.name = "CityUnderpassWalls";
      walls.receiveShadow = true;
      walls.castShadow = false;
      walls.frustumCulled = false;
      group.add(walls);
    }
  }

  const tri = (m) => (m ? (m.geometry.index ? m.geometry.index.count / 3
    : m.geometry.attributes.position.count / 3) : 0);

  return {
    group,
    layout,
    /** `{deck, solids}` — the shape the game's collision bake collects. */
    collisionMeshes() {
      const solids = [];
      if (vaultCollider) solids.push(vaultCollider);
      if (walls) solids.push(walls);
      return { deck: [road], solids };
    },
    stats: {
      draws: 1 + (vault ? 1 : 0) + (glow ? 1 : 0) + (walls ? 1 : 0),
      lengthM: Math.round(layout.a1 - layout.a0),
      coveredM: Math.round(layout.cov1 - layout.cov0),
      depthM: +(layout.top - layout.roadY).toFixed(1),
      roadTris: tri(road),
      vaultTris: tri(vault),
      wallTris: tri(walls),
    },
    dispose() {
      roadGeo.dispose();
      if (vault) vault.geometry.dispose();
      if (glow) glow.geometry.dispose();
      if (vaultCollider) vaultCollider.geometry.dispose();
      if (walls) walls.geometry.dispose();
      for (const m of owned) m.dispose();
    },
  };
}
