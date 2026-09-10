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
   * Three things stack up and there is very little slack in them.
   *
   * The vault's crown stands `tunnelHeight` above the road with about 0.45 m of
   * shell on it, so the road has to be at least that far down or the tunnel's
   * back breaks through the street it runs under — which from above does not
   * read as a bug, it reads as a concrete kerb nobody ordered.
   *
   * And the ramp has to reach that depth INSIDE ONE BLOCK. See `blockSpan`
   * below: that is 136 m to lose the whole depth in, which at a tolerable
   * gradient is about six and a half metres. Deeper is not better here; deeper
   * is a ramp that does not fit and a hole across somebody's street.
   */
  depth: 6.5,
  tunnelHeight: 5.6,

  /**
   * ── THE ROOF STARTS AT THE FIRST JUNCTION ──────────────────────────────────
   *
   * `coverBlocks` is how many block pitches the roofed part spans, and it is
   * counted in BLOCKS rather than metres for the reason the whole structure is
   * laid out on the grid: an underpass that ends wherever a length ran out puts
   * its open trench across a cross street, and a cross street with a hole in it
   * is a road the player drives along and falls into.
   */
  coverBlocks: 3,
  /**
   * The open descent. Must be no longer than a block — checked, not assumed —
   * and set very close to it, because the block is the only budget there is and
   * every metre left unused comes back as gradient.
   */
  rampLength: 134,
  /**
   * Fraction of the ramp still level before it starts down.
   *
   * Small, and it is not the crest smoothing — `ease` is a smoothstep and
   * already leaves the top and bottom flat. This is only breathing room at the
   * mouth, and it is expensive: it shortens the run the descent actually has,
   * and at a fixed depth that is a steeper road. At 0.10 this came out at 8.6%.
   */
  rampHold: 0.04,

  /** Road width down there. Narrower than the street above it. */
  roadWidth: 15,
  /** Station spacing. Tight through the portals, where the eye is. */
  step: 10,

  /**
   * ── THE TRENCH WALL'S INNER FACE ───────────────────────────────────────────
   *
   * 0.34, and it is not a taste value: it is exactly where the VAULT puts its
   * own wall. `_vaultInnerProfile` springs from `hw + 0.34`, so matching it
   * means the open trench's wall and the tunnel's wall are one continuous
   * surface through the portal instead of two surfaces a centimetre apart.
   *
   * A centimetre apart is worse than it sounds. Two solids in almost the same
   * place give the chassis two conflicting pushes in one frame, and the car is
   * thrown into the air — which is exactly what this did before the walls were
   * confined to the open trench.
   */
  wallGap: 0.34,
  wallThick: 0.5,
  /**
   * ── THE PARAPET ROUND THE HOLE ─────────────────────────────────────────────
   *
   * The trench is 18 m of missing street in a 34 m road, so there is still
   * street either side of it — and nothing stopping a car that drifts across
   * from dropping six and a half metres into a road it cannot see. A real one
   * has a wall; so does this. It is part of the wall mesh, which is already in
   * the solids channel, so it costs no draw and no new collision.
   */
  lipWidth: 0.7,
  parapetHeight: 0.95,

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
  const oAlong = axis === "x" ? ox : oz;

  /*
   * ── SNAPPED TO THE BLOCK GRID ──────────────────────────────────────────────
   *
   * A cell is a block then a junction: [j·pitch, j·pitch + blockW) is the
   * block, and the rest is where two streets cross. The roof therefore has to
   * start at the END of a block and end at the START of one, so that every
   * junction in between is under it — and the open trench, which is the part
   * with no roof, falls entirely inside the block before it.
   *
   * The first version measured the whole thing in metres from the centre and a
   * 135 m trench starting mid-block reached straight across the next junction.
   * The hole was correct, the geometry was correct, and driving along that
   * cross street dropped the car seven metres into a road it could not see.
   */
  const jMid = Math.round((cAlong - oAlong - blockW / 2) / pitch);
  const nCov = Math.max(1, Math.round(U.coverBlocks));
  const j0 = jMid - Math.floor(nCov / 2);
  const j1 = j0 + nCov;
  const portalIn = oAlong + j0 * pitch + blockW;
  const portalOut = oAlong + j1 * pitch;
  const a0 = portalIn - U.rampLength;
  const a1 = portalOut + U.rampLength;
  // The ramp has to fit in the block it descends through, or the hole reaches
  // the junction again and we are back where we started.
  if (U.rampLength > blockW) return null;
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
    // 0 at both mouths, 1 by the portal and all the way between them.
    const dIn = (a - a0) / U.rampLength;
    const dOut = (a1 - a) / U.rampLength;
    const t = Math.min(dIn, dOut);
    if (t >= 1) return 1;
    return ease((t - U.rampHold) / (1 - U.rampHold));
  };
  const total = a1 - a0;
  const n = Math.max(8, Math.round(total / U.step));
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    path.push(at(a, top - (top - roadY) * depthAt(a)));
  }

  /*
   * WHERE THE ROOF IS: from the end of one block to the start of another, so
   * the portals stand at the two junctions and every crossing between them is
   * roofed. It is also exactly where the road reaches full depth, which is not
   * a coincidence — the ramp length was chosen to fit the block.
   */
  const cov0 = portalIn;
  const cov1 = portalOut;

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
    blockSpan: blockW, params: U,
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

  /*
   * ── NO KERBS WHERE IT IS STILL A STREET ────────────────────────────────────
   *
   * The road is swept with the game's kerbed section, which is right for the
   * six metres of it that are in a trench and wrong for the first and last
   * twenty, where it is at grade and simply IS the street. A pair of red and
   * white kerbs running across an ordinary road is the give-away.
   *
   * Same two mechanisms as the viaduct's gore, and they are still not the same
   * mechanism: the SHAPE comes from `profileAt` and can change per station, so
   * the kerb ramps down; the PAINT comes from the reference profile's zone and
   * cannot, so the red has to end at a segment boundary. Hence two sweeps.
   */
  const kerbLerp = (pd, k, repaint) => ({
    hw: pd.hw,
    pts: pd.pts.map((q) => (q.zone === 2
      ? { ...q, y: q.y * k, zone: repaint ? 1 : q.zone } : q)),
  });
  const flat = kerbLerp(profile, 0, true);
  /*
   * Where the kerb starts, measured as the ROAD's depth below the street.
   *
   * Deeper than it looks like it needs to be, because a kerb stands
   * `railHeight` ABOVE the road it is on — start them at 0.6 m down and their
   * tops are still only 0.4 m below the street, which is close enough to grade
   * to read as kerbs across an ordinary road. The first thirty metres of the
   * ramp having none is also just correct: it is still a street there.
   */
  const kerbFrom = 1.2;
  const alongOfFrame = (i) => (layout.axis === "x" ? frames[i].pos.x : frames[i].pos.z);
  let kIn = 0, kOut = frames.length - 1;
  for (let i = 0; i < frames.length; i++) {
    if (layout.top - frames[i].pos.y > kerbFrom) { kIn = i; break; }
  }
  for (let i = frames.length - 1; i >= 0; i--) {
    if (layout.top - frames[i].pos.y > kerbFrom) { kOut = i; break; }
  }
  const taper = 3;
  const roadParts = [];
  if (kIn >= 2) {
    roadParts.push(buildSweepGeometry(frames.slice(0, kIn + 1), flat, {
      profileAt: (t, i) => kerbLerp(profile,
        Math.min(1, Math.max(0, (i - (kIn - taper)) / taper)), true),
    }));
  }
  roadParts.push(buildSweepGeometry(frames.slice(kIn, kOut + 1), profile));
  if (kOut <= frames.length - 3) {
    const tail = frames.slice(kOut);
    const n2 = tail.length - 1;
    roadParts.push(buildSweepGeometry(tail, flat, {
      profileAt: (t, i) => kerbLerp(profile, 1 - Math.min(1, i / taper), true),
    }));
    void n2;
  }
  const roadGeo = roadParts.length === 1 ? roadParts[0] : mergeGeometries(roadParts, false);
  if (roadParts.length > 1) for (const g of roadParts) g.dispose();
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
    const pos = [], col = [], idx = [], rowAlong = [];
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
    /*
     * FIVE POINTS PER SIDE, bottom to outside:
     *   0 inner foot, at the road
     *   1 inner top of the parapet   ← the face a car meets
     *   2 outer top of the parapet
     *   3 outer, back down at street level
     *   4 the lip edge, flush with the street
     *
     * The parapet only exists where the trench is OPEN. Over the covered
     * section there is no hole to fall into and a wall down the middle of an
     * intact street would be a barrier across a road with nothing wrong with it.
     */
    const alongAt = (i) => (layout.axis === "x" ? frames[i].pos.x : frames[i].pos.z);
    const isOpen = (i) => {
      const a = alongAt(i);
      return a < layout.cov0 + 1e-6 || a > layout.cov1 - 1e-6;
    };
    /*
     * ── ONLY WHERE THE TRENCH IS OPEN ──────────────────────────────────────────
     *
     * Under the roof the VAULT is the wall, and building a second one there was
     * wrong in three separate ways at once:
     *
     *   · its inner face landed a centimetre from the vault's, so the chassis
     *     got two conflicting pushes in a frame and the car was thrown;
     *   · its lip ran at street level along a section that still HAS a street,
     *     so two coplanar surfaces fought over the same pixels — the strip of
     *     "floating road" over the tunnel;
     *   · and it was several hundred metres of geometry doing nothing that the
     *     tunnel around it was not already doing.
     *
     * The range is inclusive at both portals so the trench wall and the vault
     * meet rather than leaving a gap you can see daylight through.
     */
    for (let i = 0; i < frames.length; i++) {
      const y = frames[i].pos.y;
      // Only where there is actually a wall to build.
      if (layout.top - y < 0.08) continue;
      if (!isOpen(i)) continue;
      const capY = layout.top + U.parapetHeight;
      rowAlong.push(alongAt(i));
      for (const s of [-1, 1]) {
        push(atFrame(i, s * inner, y), 1.0);        // 0 inner foot
        push(atFrame(i, s * inner, capY), 1.0);     // 1 inner top
        push(atFrame(i, s * outer, capY), 0.9);     // 2 outer top
        push(atFrame(i, s * outer, layout.top), 0.9); // 3 outer at street
        push(atFrame(i, s * lip, layout.top), 0.8);   // 4 lip edge
      }
    }
    /*
     * Stitch consecutive stations. FIVE verts per side per station, laid out
     * side -1 then side +1, so the stride is ten.
     *
     * `rowAlong` is what stops the two ends being sewn together. Stations are
     * skipped — at grade, and under the roof — so consecutive ROWS are not
     * always consecutive frames, and joining a row at the entry trench to one
     * at the exit trench would sweep a wall the length of the tunnel through
     * everything between them.
     */
    const per = 10;
    const rows = pos.length / 3 / per;
    for (let r = 0; r + 1 < rows; r++) {
      const gap = Math.abs(rowAlong[r + 1] - rowAlong[r]);
      if (gap > U.step * 2.5) continue;
      for (let s = 0; s < 2; s++) {
        const o0 = r * per + s * 5, o1 = (r + 1) * per + s * 5;
        // The two sides face opposite ways, so their winding is mirrored — a
        // trench wall backfacing is a trench you can see straight through.
        for (let k = 0; k < 4; k++) {
          if (s === 0) quad(o0 + k + 1, o0 + k, o1 + k, o1 + k + 1);
          else quad(o0 + k, o0 + k + 1, o1 + k + 1, o1 + k);
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
