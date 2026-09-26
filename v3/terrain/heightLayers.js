/**
 * v3/terrain/heightLayers.js — the terrain height as a STACK, not one buffer.
 *
 *     FINAL = STAMPS( RIVER( GROUND ) )
 *
 *   GROUND  the natural terrain. Sculpting, erosion, import, terracing tools and
 *           every editor tool that writes heights end up here. It is what a
 *           project saves (the old "river base" blob was exactly this).
 *   RIVER   an OPERATOR, not a buffer: River v2 shapes GROUND inside its own
 *           footprint and nowhere else (riverV2Terrain.js). It stores no copy
 *           of anything.
 *   STAMPS  pads, bridge landings, berms, paddies — analytic edits a game (or a
 *           tool) places ON TOP, in order. Kept as the function that makes
 *           them, so they are re-applied whenever what is under them changes.
 *
 * WHY. The river used to rewrite the whole heightmap from its own copy of the
 * ground, and every other edit had to be folded into that copy to survive
 * (markExternalEdit, editBase, coversRect, a debounced rebase). Anything that
 * missed the fold was erased — nam-rts's building pads, then its paddies and
 * berms by the river. In a stack nothing can erase anything: each layer only
 * ever writes its own contribution, and the order is fixed.
 *
 * FINAL is the engine's CPU height mirror (`cpuHeightmap` in main.js), so
 * getWorldHeight and everything else that reads it see the composed ground the
 * moment a layer changes. The GPU gets the changed rect afterwards (takePending
 * → sculpt.uploadHeightRect); nothing is read back to find out what happened.
 *
 * EDITS THAT DO NOT KNOW ABOUT LAYERS. Most height writers predate this and
 * write the mirror (or the GPU) directly. They still work: `absorb` diffs the
 * mirror against what the stack last composed, adds the difference to GROUND,
 * and recomposes — so a sculpt stroke or an erosion pass lands in GROUND, and
 * the river and the stamps are re-applied on top of it.
 *
 * All heights are normalized (metres / MAX_HEIGHT), texel (x, z) at index
 * z * size + x, its centre at world ((x + 0.5) / size − 0.5) * worldSize.
 * Rects are INCLUSIVE texel bounds { x0, z0, x1, z1 }.
 */

/** @typedef {{x0:number,z0:number,x1:number,z1:number}} TexelRect */

export function unionRect(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return {
    x0: Math.min(a.x0, b.x0), z0: Math.min(a.z0, b.z0),
    x1: Math.max(a.x1, b.x1), z1: Math.max(a.z1, b.z1),
  };
}

function intersectRect(a, b) {
  const r = {
    x0: Math.max(a.x0, b.x0), z0: Math.max(a.z0, b.z0),
    x1: Math.min(a.x1, b.x1), z1: Math.min(a.z1, b.z1),
  };
  return r.x1 < r.x0 || r.z1 < r.z0 ? null : r;
}

/**
 * @param {object} o
 * @param {Float32Array} o.final   the engine's CPU height mirror — composed into
 * @param {number}       o.size    texels per side
 * @param {(rect:TexelRect)=>void} [o.onComposed]  FINAL changed in `rect`
 */
export function createHeightLayers({ final, size, onComposed = null }) {
  const N = size * size;
  const FULL = { x0: 0, z0: 0, x1: size - 1, z1: size - 1 };
  const ground = new Float32Array(N);
  /** What FINAL held after the stack last wrote it — the baseline `absorb` diffs. */
  const last = new Float32Array(N);
  /** key → { rect, apply(map, rect) }, in the order they apply. */
  const stamps = new Map();
  /**
   * The operators between GROUND and STAMPS, applied in insertion order:
   * name → { rect, apply(out, ground, rect) }. River v2 is "river", River v3
   * "riverV3" — each owns its own slot and never overwrites the other.
   */
  const operators = new Map();
  /** Union of rects composed since the last takePending (not yet on the GPU). */
  let pending = null;
  let version = 0;
  let stampSeq = 0;

  const clamp = (r) => intersectRect(r, FULL);

  /** Recompose FINAL inside `r` from the layers. */
  function compose(r) {
    r = r && clamp(r);
    if (!r) return;
    for (let z = r.z0; z <= r.z1; z++) {
      const o = z * size;
      for (let x = r.x0; x <= r.x1; x++) final[o + x] = ground[o + x];
    }
    for (const op of operators.values()) op.apply(final, ground, r);
    for (const s of stamps.values()) {
      const sr = intersectRect(s.rect, r);
      if (sr) s.apply(final, sr);
    }
    for (let z = r.z0; z <= r.z1; z++) {
      const o = z * size;
      for (let x = r.x0; x <= r.x1; x++) last[o + x] = final[o + x];
    }
    pending = unionRect(pending, r);
    version++;
    onComposed?.(r);
  }

  /** Does anything above GROUND touch `r`? */
  function layeredIn(r) {
    for (const op of operators.values()) if (intersectRect(op.rect, r)) return true;
    for (const s of stamps.values()) if (intersectRect(s.rect, r)) return true;
    return false;
  }

  return {
    ground,
    get version() { return version; },
    get river() { return operators.get("river") ?? null; },
    operator(name) { return operators.get(name) ?? null; },
    get stampCount() { return stamps.size; },

    compose,

    /**
     * Replace the river operator (null = no river). Recomposes the old and new
     * footprints only — the rest of the map is not the river's business.
     * @param {TexelRect|false|null} [dirty] where the old and new operator can
     *   differ, if the caller knows (riverDirtyRect): a rect, or false for
     *   "nowhere". Default: both whole footprints.
     */
    setRiver(op, dirty = null) { this.setOperator("river", op, dirty); },

    /** As setRiver, for any named operator slot (null op = remove it). */
    setOperator(name, op, dirty = null) {
      const old = operators.get(name)?.rect ?? null;
      if (op) operators.set(name, op); else operators.delete(name);
      if (dirty === false) return;
      compose(dirty ?? unionRect(old, op?.rect ?? null));
    },

    /**
     * Put a stamp on top of the stack (or replace the one with the same key,
     * which then moves to the top: the latest edit of a thing wins).
     * `apply(map, rect)` edits `map` inside `rect` (already clipped to the
     * stamp's own rect) from what is under it, and must be a pure function of
     * that — it runs again whenever the layers under it change.
     * @param {string|null} key  null = always a new stamp
     */
    addStamp(key, rect, apply) {
      rect = clamp(rect);
      if (!rect) return null;
      const k = key ?? `#${++stampSeq}`;
      const old = stamps.get(k);
      stamps.delete(k);
      stamps.set(k, { rect, apply });
      compose(unionRect(old?.rect ?? null, rect));
      return k;
    },

    removeStamp(key) {
      const s = stamps.get(key);
      if (!s) return false;
      stamps.delete(key);
      compose(s.rect);
      return true;
    },

    /**
     * Something wrote FINAL behind the stack's back (a legacy CPU writer, or a
     * GPU edit that has just been read back into the mirror). Take the change
     * into GROUND and re-apply the layers over it.
     *
     * @param {TexelRect} [r] where to look (default: the whole map)
     * @param {(v:number)=>number} [quantize] how the incoming values were
     *   stored: a half-float readback cannot reproduce a float mirror, so the
     *   baseline is quantized the same way first, or every untouched texel
     *   would read as an edit of a few centimetres
     * @returns {TexelRect|null} the rect the external edit changed (null =
     *   nothing). Where a river or stamp covers it FINAL was recomposed, so it
     *   now differs from what was written; that part is in the pending rect.
     */
    absorb(r = FULL, quantize = null) {
      r = clamp(r);
      if (!r) return null;
      let hit = null;
      for (let z = r.z0; z <= r.z1; z++) {
        const o = z * size;
        for (let x = r.x0; x <= r.x1; x++) {
          const i = o + x;
          const base = quantize ? quantize(last[i]) : last[i];
          const d = final[i] - base;
          if (d === 0) { final[i] = last[i]; continue; }
          ground[i] += d;
          last[i] = final[i];
          if (!hit) hit = { x0: x, z0: z, x1: x, z1: z };
          else {
            if (x < hit.x0) hit.x0 = x; if (x > hit.x1) hit.x1 = x;
            if (z < hit.z0) hit.z0 = z; if (z > hit.z1) hit.z1 = z;
          }
        }
      }
      if (!hit) return null;
      version++;
      // Under a river or a stamp the new ground has to go back through them.
      // Everywhere else FINAL already is GROUND and there is nothing to redo.
      if (layeredIn(hit)) compose(hit);
      return hit;
    },

    /**
     * A whole new GROUND (a project load): no stamps, no river until it is
     * imported again, FINAL = GROUND.
     */
    reset(heights) {
      ground.set(heights);
      last.set(heights);
      final.set(heights);
      stamps.clear();
      operators.clear();
      pending = null;
      version++;
    },

    /** Take the rect FINAL changed in since the last call (null = nothing). */
    takePending() {
      const p = pending;
      pending = null;
      return p;
    },

    /** Bilinear GROUND height in normalized units, the solver's convention
     *  (texel i at u = i / (size − 1), as riverV2System's sampleNormalized). */
    sampleGroundNormalized(u, v) {
      if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
      const res = size - 1;
      const fx = u * res, fz = v * res;
      const ix0 = Math.floor(fx), iz0 = Math.floor(fz);
      const ix1 = Math.min(ix0 + 1, res), iz1 = Math.min(iz0 + 1, res);
      const tx = fx - ix0, tz = fz - iz0;
      const h0 = ground[iz0 * size + ix0] * (1 - tx) + ground[iz0 * size + ix1] * tx;
      const h1 = ground[iz1 * size + ix0] * (1 - tx) + ground[iz1 * size + ix1] * tx;
      return h0 * (1 - tz) + h1 * tz;
    },
  };
}
