/**
 * Height of the terrain MESH at world XZ — the exact triangle the clipmap
 * draws there, rebuilt from the same inputs (see v3/terrain/terrainLOD.js).
 *
 * The heightmap and the mesh are NOT the same surface: a clipmap vertex sits
 * on a lattice of its level's step and reads one filtered tap, so anything
 * that stands on the ground by sampling the heightmap floats over a crest the
 * coarse mesh cuts under, or sinks into it. Grass hit this first
 * (hybridGrassSystem, where this code lived); the revo grass tile needs the
 * same answer, hence one shared helper rather than two copies of the math.
 *
 * - Level: level 0 spans ±halfCells·baseStep around the centre; ring L ≥ 1
 *   spans [halfCells/2, halfCells)·baseStep·2^L.
 * - Vertices sit on a world lattice of that level's step (the centre is
 *   snapped to the coarsest step), and each samples the heightmap LINEARLY
 *   at its own UV — so a vertex height is one filtered tap at that point.
 * - A normal quad splits along the B–C diagonal (indices A,C,B / B,C,D).
 * - The row of quads bordering a ring's hole is a 3-triangle FAN around a
 *   midpoint M on the hole edge (T-junction stitching). All four sides are
 *   the same fan after a swap/flip of the local axes, so one canonical fan
 *   covers them: apex (0,0), M (0.5,1), triangles {apex,(0,1),M},
 *   {apex,M,(1,1)}, {apex,(1,1),(1,0)}.
 * - Every case is one triangle, so it is always exactly 3 taps — the case
 *   only changes WHERE they are taken and how they are weighted.
 * - Vertices outside the map read 0, like the terrain's hmInBounds.
 */
import {
  abs,
  clamp,
  float,
  floor,
  log2,
  max,
  mix,
  pow,
  step,
  texture,
  uniform,
  vec2,
} from "three/tsl";

/**
 * @param {object} surface  { centerXZ: Vector2 (the clipmap's live centre),
 *                            baseStep, levels, halfCells }
 * @returns {(worldX, worldZ, heightTex, uTerrainSize) => Node} the mesh Y.
 *   The centre uniform is created once per caller and holds the SAME Vector2
 *   the clipmap updates, so it tracks lod.update() with no per-frame work.
 */
export function createClipmapGroundY(surface) {
  let uClipCenter = null;

  return function clipmapGroundY(worldX, worldZ, heightTex, uTerrainSize) {
    const s = surface;
    uClipCenter ??= uniform(s.centerXZ);
    const c = uClipCenter;
    const base = float(s.baseStep);
    const inner = s.halfCells * 0.5;
    const one = float(1);

    const m = max(abs(worldX.sub(c.x)), abs(worldZ.sub(c.y)));
    const lvl = clamp(
      floor(log2(max(m, float(1e-3)).div(base.mul(inner)))),
      float(0),
      float(s.levels - 1),
    );
    // round: pow(2, n) is not guaranteed exact on every driver
    const stepW = base.mul(floor(pow(float(2), lvl).add(0.5)));

    // The lattice is offset half a heightmap texel (terrainLOD GRID_OFFSET),
    // so its cell walls sit there too.
    const off = float(s.gridOffset ?? 0);
    const gx = worldX.sub(off).div(stepW);
    const gz = worldZ.sub(off).div(stepW);
    const cellX = floor(gx);
    const cellZ = floor(gz);
    const fx = gx.sub(cellX);
    const fz = gz.sub(cellZ);

    // ── Normal quad: triangle A,B,C below the diagonal, D,C,B above ──
    const k = step(one, fx.add(fz));
    const nP0 = vec2(k, k);                 // A (0,0) or D (1,1)
    const nW0 = abs(fx.add(fz).sub(1));
    const nW1 = mix(fx, one.sub(fz), k);    // B (1,0)
    const nW2 = mix(fz, one.sub(fx), k);    // C (0,1)

    // ── Fan row? Cell offset from the centre, in cells of this level ──
    const rx = cellX.sub(floor(c.x.sub(off).div(stepW).add(0.5)));
    const rz = cellZ.sub(floor(c.y.sub(off).div(stepW).add(0.5)));
    const eq = (a, n) => step(float(n - 0.5), a).mul(step(a, float(n + 0.5)));
    const span = (a) => step(float(-inner - 0.5), a).mul(step(a, float(inner - 0.5)));
    const bot = eq(rz, -inner - 1).mul(span(rx));
    const top = eq(rz, inner).mul(span(rx));
    const left = eq(rx, -inner - 1).mul(span(rz));
    const right = eq(rx, inner).mul(span(rz));
    const fan = bot.add(top).add(left).add(right).mul(step(float(0.5), lvl)); // level 0 is a full grid
    // canonical frame: swap = left|right, flip = top|right
    const swap = left.add(right);
    const flip = top.add(right);
    const ca = mix(fx, fz, swap);
    const cb = mix(fz, fx, swap);
    const cu = ca;
    const cv = mix(cb, one.sub(cb), flip);
    const t1 = step(cu, cv.mul(0.5));                 // {apex,(0,1),M}
    const t3 = step(cv, cu).mul(one.sub(t1));         // {apex,(1,1),(1,0)}
    const t2 = one.sub(t1).sub(t3);                   // {apex,M,(1,1)}
    const cV1 = vec2(t2.mul(0.5).add(t3), one);
    const cV2 = vec2(t1.mul(0.5).add(t2).add(t3), t1.add(t2));
    const fW0 = t1.add(t2).mul(one.sub(cv)).add(t3.mul(one.sub(cu)));
    const fW1 = t1.mul(cv.sub(cu.mul(2))).add(t2.mul(cv.sub(cu).mul(2))).add(t3.mul(cv));
    const fW2 = t1.mul(cu.mul(2)).add(t2.mul(cu.mul(2).sub(cv))).add(t3.mul(cu.sub(cv)));
    // canonical (u,v) → local cell (fx,fz)
    const toLocal = (p) => {
      const b = mix(p.y, one.sub(p.y), flip);
      return vec2(mix(p.x, b, swap), mix(b, p.x, swap));
    };

    const p0 = mix(nP0, toLocal(vec2(0, 0)), fan);
    const p1 = mix(vec2(1, 0), toLocal(cV1), fan);
    const p2 = mix(vec2(0, 1), toLocal(cV2), fan);
    const w0 = mix(nW0, fW0, fan);
    const w1 = mix(nW1, fW1, fan);
    const w2 = mix(nW2, fW2, fan);

    const tap = (p) => {
      const wx = cellX.add(p.x).mul(stepW).add(off);
      const wz = cellZ.add(p.y).mul(stepW).add(off);
      const tu = wx.div(uTerrainSize).add(0.5);
      const tv = wz.div(uTerrainSize).add(0.5);
      const inB = step(float(0), tu).mul(step(tu, one))
        .mul(step(float(0), tv)).mul(step(tv, one));
      return texture(heightTex, vec2(tu, tv)).x.mul(inB);
    };
    return tap(p0).mul(w0).add(tap(p1).mul(w1)).add(tap(p2).mul(w2));
  };
}
