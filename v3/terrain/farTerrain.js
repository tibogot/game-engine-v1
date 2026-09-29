/**
 * FAR TERRAIN — the ground beyond the heightmap, drawn by the terrain itself.
 *
 * Outside its heightmap the clipmap used to lay flat ground at 0 m: right for
 * a coast, wrong for a valley ringed by mountains, where the map's edge reads
 * as a table with the world cut off round it. A project can now carry a FAR
 * HEIGHTMAP — a coarser grid covering a much wider square round the map (the
 * real country round a DEM-cut map, say) — and the SAME terrain shader draws
 * it: its own layer textures, height blend, macro variation, lighting and
 * haze, so there is no seam and nothing that looks like a separate backdrop
 * (a separate mesh was tried first and never matched: 2026-09-29).
 *
 * WHAT IT DOES, OUTSIDE THE MAP ONLY (inside, nothing changes):
 *   height  the far grid, blended over `blend` metres from the heightmap's own
 *           edge heights (so the edge is exact), and "stood up" with distance
 *           by `stand` from `standStart` to `standEnd` metres past the edge (far
 *           ridges shrink with distance; at map scale they read as dunes);
 *   normal  from the far ground itself, in the vertex stage;
 *   paint   the layer weights from a slope/height RULE (splatOverlayTsl.js
 *           blend: flat / high / scree / cliff → four chosen layer slots),
 *           since there is no splatmap out there.
 *
 * NO SAMPLER: the grid is an R32F texture read with textureLoad and a hand
 * bilinear, so it costs the terrain's fragment stage nothing against WebGPU's
 * 16-sampler limit (ref_terrain_sampler_limit). All reads are in the VERTEX
 * stage anyway.
 *
 * Project data (projectIO.js): manifest.farTerrain = { n, extent, stand,
 * standStart, standEnd, blend, rule } + blob "farHeight" (Float32, n × n, map
 * metres, row 0 = −z). The extra clipmap rings that reach the horizon are
 * built only while it is on (terrainLOD.js setFarLevels).
 */
import * as THREE from "three";
import { acos, float, int, ivec2, clamp, floor, max, abs, mix, smoothstep, textureLoad, uniform, vec3, normalize } from "three/tsl";

export const FAR_TERRAIN_DEFAULTS = {
  enabled: false,
  n: 0,
  extent: 3900,        // metres: the grid covers ±extent round the map centre
  stand: 2.5,          // relief multiplier far out
  standStart: 100,     // metres past the edge where it starts
  standEnd: 1500,      // … and where it is full
  blend: 250,          // metres past the edge over which edge heights become the grid
  // The paint rule: slope (degrees) and height (metres) bands, and the layer
  // slot (0-based) each class paints with; -1 = leave to the base colour.
  rule: {
    flatSlot: 0, highSlot: 1, screeSlot: 2, cliffSlot: 5,
    screeLo: 8, screeHi: 16, cliffLo: 20, cliffHi: 30, highLo: 45, highHi: 75,
  },
};

export function createFarTerrain() {
  const params = structuredClone(FAR_TERRAIN_DEFAULTS);
  // A 2×2 placeholder until a grid arrives (a node needs a texture to build).
  // A new grid gets a NEW texture (a GPU texture can't change size in place)
  // and every read node is pointed at it (texNodes).
  const makeTex = (arr, n) => {
    const t = new THREE.DataTexture(arr, n, n, THREE.RedFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;   // no sampler bound
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };
  let tex = makeTex(new Float32Array(4), 2);
  const texNodes = [];
  const load = (ix, iy) => { const nd = textureLoad(tex, ivec2(ix, iy)); texNodes.push(nd); return nd; };
  let data = null;   // the CPU copy (Float32Array), for heightAt on the CPU

  const u = {
    uEnabled: uniform(0),
    uN: uniform(2),
    uExtent: uniform(params.extent),
    uStand: uniform(params.stand),
    uStandStart: uniform(params.standStart),
    uStandEnd: uniform(params.standEnd),
    uBlend: uniform(params.blend),
    // rule
    uFlatSlot: uniform(params.rule.flatSlot), uHighSlot: uniform(params.rule.highSlot),
    uScreeSlot: uniform(params.rule.screeSlot), uCliffSlot: uniform(params.rule.cliffSlot),
    uScreeLo: uniform(params.rule.screeLo), uScreeHi: uniform(params.rule.screeHi),
    uCliffLo: uniform(params.rule.cliffLo), uCliffHi: uniform(params.rule.cliffHi),
    uHighLo: uniform(params.rule.highLo), uHighHi: uniform(params.rule.highHi),
  };

  /** Raw grid height at world (x, z), hand bilinear on the R32F texture (TSL). */
  function gridHeight(wx, wz) {
    const nM1 = u.uN.sub(1);
    const cell = u.uExtent.mul(2).div(nM1);
    const fu = clamp(wx.add(u.uExtent).div(cell), 0, nM1.sub(1.001));
    const fv = clamp(wz.add(u.uExtent).div(cell), 0, nM1.sub(1.001));
    const x0 = floor(fu), y0 = floor(fv), tx = fu.sub(x0), ty = fv.sub(y0);
    const ix = int(x0), iy = int(y0);
    const h00 = load(ix, iy).r, h10 = load(ix.add(1), iy).r;
    const h01 = load(ix, iy.add(1)).r, h11 = load(ix.add(1), iy.add(1)).r;
    return mix(mix(h00, h10, tx), mix(h01, h11, tx), ty);
  }

  /**
   * The ground's height (metres) at world (x, z) OUTSIDE the map (TSL):
   * edgeHeight(x, z) → the heightmap's height at the nearest edge point.
   */
  function outsideHeight(wx, wz, halfWorld, edgeHeight) {
    const d = max(abs(wx), abs(wz)).sub(halfWorld);          // metres past the edge (Chebyshev)
    const stand = float(1).add(u.uStand.sub(1).mul(smoothstep(u.uStandStart, u.uStandEnd, d)));
    const g = max(gridHeight(wx, wz), 0).mul(stand);
    return mix(edgeHeight, g, smoothstep(float(0), u.uBlend, d));
  }

  /** Its normal, by central differences over `e` metres (TSL). */
  function outsideNormal(wx, wz, halfWorld, edgeHeightAt, e = 6) {
    const E = float(e);
    const hx0 = outsideHeight(wx.sub(E), wz, halfWorld, edgeHeightAt(wx.sub(E), wz));
    const hx1 = outsideHeight(wx.add(E), wz, halfWorld, edgeHeightAt(wx.add(E), wz));
    const hz0 = outsideHeight(wx, wz.sub(E), halfWorld, edgeHeightAt(wx, wz.sub(E)));
    const hz1 = outsideHeight(wx, wz.add(E), halfWorld, edgeHeightAt(wx, wz.add(E)));
    return normalize(vec3(hx0.sub(hx1), E.mul(2), hz0.sub(hz1)));
  }

  /** The rule's layer weights at slope `ny` (normal.y) and height `y` (TSL): { flat, high, scree, cliff }. */
  function ruleWeights(ny, y) {
    const slope = acos(clamp(ny, 0, 1)).mul(180 / Math.PI);
    const cliff = smoothstep(u.uCliffLo, u.uCliffHi, slope);
    const scree = smoothstep(u.uScreeLo, u.uScreeHi, slope).mul(float(1).sub(cliff));
    const rest = float(1).sub(cliff).sub(scree);
    const high = smoothstep(u.uHighLo, u.uHighHi, y).mul(rest);
    return { flat: rest.sub(high), high, scree, cliff };
  }

  /** Apply params (any subset). */
  function set(p = {}) {
    Object.assign(params, { ...p, rule: { ...params.rule, ...(p.rule ?? {}) } });
    u.uExtent.value = params.extent; u.uStand.value = params.stand;
    u.uStandStart.value = params.standStart; u.uStandEnd.value = params.standEnd; u.uBlend.value = params.blend;
    const r = params.rule;
    u.uFlatSlot.value = r.flatSlot; u.uHighSlot.value = r.highSlot; u.uScreeSlot.value = r.screeSlot; u.uCliffSlot.value = r.cliffSlot;
    u.uScreeLo.value = r.screeLo; u.uScreeHi.value = r.screeHi; u.uCliffLo.value = r.cliffLo; u.uCliffHi.value = r.cliffHi;
    u.uHighLo.value = r.highLo; u.uHighHi.value = r.highHi;
    u.uEnabled.value = params.enabled && data ? 1 : 0;
  }

  /** Hand it a grid (Float32Array n×n, map metres, row 0 = −z) — or null to clear. */
  function setGrid(grid, n, extent = params.extent) {
    if (!grid) { data = null; params.n = 0; params.enabled = false; set(); return; }
    if (grid.length !== n * n) throw new Error(`farTerrain: grid is ${grid.length}, expected ${n}²`);
    data = grid;
    const old = tex;
    tex = makeTex(grid, n);
    for (const nd of texNodes) nd.value = tex;
    old.dispose();
    params.n = n; params.extent = extent;
    u.uN.value = n;
    set({ enabled: true });
  }

  return {
    params, u,
    get tex() { return tex; },
    gridHeight, outsideHeight, outsideNormal, ruleWeights,
    set, setGrid,
    get enabled() { return !!(params.enabled && data); },
    get grid() { return data; },
    /** For the save: { manifest, blob } or null. */
    exportData() {
      if (!data) return null;
      const { enabled, n, extent, stand, standStart, standEnd, blend, rule } = params;
      return { manifest: { enabled, n, extent, stand, standStart, standEnd, blend, rule }, blob: data };
    },
  };
}
