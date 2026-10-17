/**
 * v3/terrain/heightLayers.js — the terrain height as a STACK, not one buffer.
 *
 *     FINAL = STAMPS( RIVER( GROUND ) )
 *     GROUND = BASE + Σ visible SCULPT LAYERS × strength
 *
 *   GROUND  the natural terrain. Sculpting, erosion, import, terracing tools and
 *           every editor tool that writes heights end up here. It is what a
 *           project saves (the old "river base" blob was exactly this).
 *   BASE + SCULPT LAYERS (2026-10-17, the editor's layer panel, Unreal's edit
 *           layers): GROUND is itself a sum. BASE is what Generate and a
 *           heightmap import write; each sculpt layer holds the edits made
 *           while it was active, as offsets, in 64×64 tiles that exist only
 *           where it was touched. A layer can be hidden, scaled (strength),
 *           locked, cleared, merged down — and the base regenerated under it
 *           without losing it. The sum is additive, so the ORDER of the layers
 *           does not change the heights. A project without layers is BASE only,
 *           and GROUND is still the one heightmap a project saves and a game reads.
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
/** Sculpt layer tiles: texels per side. */
export const LAYER_TILE = 64;

export function createHeightLayers({ final, size, onComposed = null }) {
  const N = size * size;
  const FULL = { x0: 0, z0: 0, x1: size - 1, z1: size - 1 };
  const ground = new Float32Array(N);
  /** GROUND minus the sculpt layers: what Generate and an import write. */
  const base = new Float32Array(N);
  const tilesX = Math.ceil(size / LAYER_TILE);
  /**
   * The sculpt layers, bottom to top (display order; the sum ignores it):
   * { id, name, visible, strength, locked, tiles: Map<tileIndex, Float32Array> }.
   * A tile holds the layer's own offsets (normalized height units) BEFORE its
   * strength is applied, so a strength change is exact and reversible.
   */
  const layers = [];
  /** id 0 = BASE. */
  const baseInfo = { id: 0, name: "Base", locked: false };
  let activeId = 0;
  let nextLayerId = 1;
  /** Set by absorb when the edit hit a layer that cannot take it. */
  let lastDiscard = null;
  /** What FINAL held after the stack last wrote it — the baseline `absorb` diffs. */
  const last = new Float32Array(N);
  /** key → { rect, apply(map, rect) }, in the order they apply. */
  const stamps = new Map();
  /**
   * The operators between GROUND and STAMPS, applied in insertion order:
   * name → { rect, apply(out, ground, rect), first? }. River v2 is "river",
   * River v3 "riverV3" — each owns its own slot and never overwrites the other.
   * The erosion filter is "erosion" with `first`: it shapes the ground the
   * rivers then carve (erosionOperator.js).
   */
  const operators = new Map();
  /** Union of rects composed since the last takePending (not yet on the GPU). */
  let pending = null;
  let version = 0;
  /**
   * Bumped only when GROUND itself changes (an absorbed edit, a layer shown /
   * scaled / cleared, a reset) — not when a stamp or an operator recomposes. A
   * stamp that READS the ground (a pad that follows it, padSystem.js) watches
   * this to know when to re-measure, without looping on its own recompose.
   */
  let groundVersion = 0;
  let stampSeq = 0;

  const clamp = (r) => intersectRect(r, FULL);

  // ── Sculpt layers ──────────────────────────────────────────────────────────
  const layerById = (id) => layers.find((l) => l.id === id) ?? null;
  const tileOf = (x, z) => Math.floor(z / LAYER_TILE) * tilesX + Math.floor(x / LAYER_TILE);
  const inTile = (x, z) => (z % LAYER_TILE) * LAYER_TILE + (x % LAYER_TILE);
  const contributes = (l) => l.visible && l.strength !== 0 && l.tiles.size > 0;

  /** Can edits land in this layer? A hidden, zero-strength or locked one cannot. */
  function editable(id) {
    if (id === 0) return !baseInfo.locked;
    const l = layerById(id);
    return !!l && l.visible && l.strength !== 0 && !l.locked;
  }

  /** The texel rect a layer's tiles cover (null = empty layer). */
  function layerRect(l) {
    let r = null;
    for (const t of l.tiles.keys()) {
      const tx = t % tilesX, tz = Math.floor(t / tilesX);
      r = unionRect(r, {
        x0: tx * LAYER_TILE, z0: tz * LAYER_TILE,
        x1: Math.min(size - 1, tx * LAYER_TILE + LAYER_TILE - 1),
        z1: Math.min(size - 1, tz * LAYER_TILE + LAYER_TILE - 1),
      });
    }
    return r;
  }

  /** GROUND = BASE + the visible layers, inside `r`. */
  function recomputeGround(r) {
    r = r && clamp(r);
    if (!r) return;
    groundVersion++;
    const live = layers.filter(contributes);
    for (let z = r.z0; z <= r.z1; z++) {
      const o = z * size;
      for (let x = r.x0; x <= r.x1; x++) {
        let h = base[o + x];
        if (live.length) {
          const t = tileOf(x, z), k = inTile(x, z);
          for (const l of live) {
            const tile = l.tiles.get(t);
            if (tile) h += tile[k] * l.strength;
          }
        }
        ground[o + x] = h;
      }
    }
  }

  /** A layer's heights changed (shown, hidden, scaled, cleared…) inside `r`. */
  function relayer(r) {
    if (!r) return;
    recomputeGround(r);
    compose(r);
  }

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

  /**
   * Bring saved layers back (exportLayers' { meta, data }) over a GROUND that
   * already contains them — the project's heightmap is GROUND — so BASE is
   * GROUND minus what the visible ones add. Layers saved for another
   * heightmap size are dropped (GROUND still has their shape, flattened in).
   */
  function importLayers(meta, data) {
    const T = LAYER_TILE * LAYER_TILE;
    if (meta.size !== size || meta.tile !== LAYER_TILE || !data) {
      if (meta.layers?.length) console.warn("[heightLayers] saved layers are for another terrain size; kept flattened into the ground.");
      return;
    }
    let at = 0;
    for (const s of meta.layers ?? []) {
      const tiles = new Map();
      for (const t of s.tiles ?? []) {
        if (at + T > data.length) break;
        tiles.set(t, data.slice(at, at + T));
        at += T;
      }
      layers.push({
        id: s.id, name: s.name ?? `Layer ${s.id}`, visible: s.visible !== false,
        strength: Number.isFinite(s.strength) ? s.strength : 1, locked: !!s.locked, tiles,
      });
      nextLayerId = Math.max(nextLayerId, s.id + 1);
    }
    baseInfo.locked = !!meta.baseLocked;
    activeId = layerById(meta.active) ? meta.active : 0;
    // BASE = GROUND − what the visible layers add.
    for (const l of layers) {
      if (!contributes(l)) continue;
      for (const [t, tile] of l.tiles) {
        const tx = t % tilesX, tz = Math.floor(t / tilesX);
        for (let j = 0; j < tile.length; j++) {
          const x = tx * LAYER_TILE + (j % LAYER_TILE), z = tz * LAYER_TILE + Math.floor(j / LAYER_TILE);
          if (x < size && z < size) base[z * size + x] -= tile[j] * l.strength;
        }
      }
    }
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
    get groundVersion() { return groundVersion; },
    /** GROUND (read-only by contract): what an operator that bakes from it reads. */
    get ground() { return ground; },
    /** Remove every stamp whose key starts with `prefix` (a system clearing its own). */
    removeStampsWithPrefix(prefix) {
      let r = null;
      for (const [k, s] of stamps) if (k.startsWith(prefix)) { r = unionRect(r, s.rect); stamps.delete(k); }
      if (r) compose(r);
      return !!r;
    },
    /** Is there a stamp under this key? */
    hasStamp(key) { return stamps.has(key); },
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
      if (op && op.first && !operators.has(name)) {
        // `first`: applied before every other operator (the erosion filter
        // shapes the ground the rivers then carve). Map order is insertion
        // order, so rebuild it with this one at the front.
        const rest = [...operators];
        operators.clear();
        operators.set(name, op);
        for (const [k, v] of rest) operators.set(k, v);
      } else if (op) operators.set(name, op); else operators.delete(name);
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
     * @param {number} [target] the layer the edit belongs to (default: the
     *   active one; 0 = BASE). A layer that cannot take edits (hidden, zero
     *   strength, locked) DISCARDS it: FINAL goes back to what the layers make
     *   and the rect is marked for upload, so the GPU edit is undone too.
     * @param {{history?: boolean}} [o] history: the edit is an UNDO / REDO of
     *   a step made in `target`. It goes back into that layer even when the
     *   layer is now locked or hidden; a hidden layer takes it without it
     *   showing (FINAL is put back, as for a refusal, but nothing is reported).
     * @returns {TexelRect|null} the rect the external edit changed (null =
     *   nothing). Where a river or stamp covers it FINAL was recomposed, so it
     *   now differs from what was written; that part is in the pending rect.
     */
    absorb(r = FULL, quantize = null, target = activeId, { history = false } = {}) {
      r = clamp(r);
      if (!r) return null;
      const layer = target === 0 ? null : layerById(target);
      const exists = target === 0 || !!layer;
      const keep = history ? exists && (!layer || layer.strength !== 0) : editable(target);
      // A history step into a hidden layer: into the layer, not onto the terrain.
      const unseen = keep && history && layer && !layer.visible;
      const inv = layer ? 1 / layer.strength : 1;
      let hit = null;
      for (let z = r.z0; z <= r.z1; z++) {
        const o = z * size;
        for (let x = r.x0; x <= r.x1; x++) {
          const i = o + x;
          const was = quantize ? quantize(last[i]) : last[i];
          const d = final[i] - was;
          if (d === 0) { final[i] = last[i]; continue; }
          if (!keep) {
            final[i] = last[i];
          } else {
            if (layer) {
              const t = tileOf(x, z);
              let tile = layer.tiles.get(t);
              if (!tile) layer.tiles.set(t, (tile = new Float32Array(LAYER_TILE * LAYER_TILE)));
              tile[inTile(x, z)] += d * inv;
            } else {
              base[i] += d;
            }
            if (unseen) {
              final[i] = last[i];
            } else {
              ground[i] += d;
              last[i] = final[i];
            }
          }
          if (!hit) hit = { x0: x, z0: z, x1: x, z1: z };
          else {
            if (x < hit.x0) hit.x0 = x; if (x > hit.x1) hit.x1 = x;
            if (z < hit.z0) hit.z0 = z; if (z > hit.z1) hit.z1 = z;
          }
        }
      }
      if (!hit) return null;
      version++;
      if (!keep || unseen) {
        // FINAL is back to what the layers make; put that back on the GPU.
        if (!keep) lastDiscard = { target, rect: hit };
        pending = unionRect(pending, hit);
        onComposed?.(hit);
        return hit;
      }
      groundVersion++;
      // Under a river or a stamp the new ground has to go back through them.
      // Everywhere else FINAL already is GROUND and there is nothing to redo.
      if (layeredIn(hit)) compose(hit);
      return hit;
    },

    /** The last edit a layer refused ({ target, rect }), once; null = none. */
    takeDiscard() {
      const d = lastDiscard;
      lastDiscard = null;
      return d;
    },

    /**
     * A whole new GROUND (a project load): no stamps, no river until it is
     * imported again, FINAL = GROUND. `saved` (from exportLayers) brings the
     * sculpt layers back; BASE is what is left of GROUND without them.
     */
    reset(heights, saved = null) {
      ground.set(heights);
      last.set(heights);
      final.set(heights);
      stamps.clear();
      operators.clear();
      layers.length = 0;
      activeId = 0;
      baseInfo.locked = false;
      base.set(heights);
      if (saved?.meta) importLayers(saved.meta, saved.data);
      pending = null;
      version++;
      groundVersion++;
    },

    // ── Sculpt layers ────────────────────────────────────────────────────────
    get activeLayer() { return activeId; },

    /** BASE first, then the layers bottom to top — plain data for a panel. */
    listLayers() {
      return [
        { id: 0, name: baseInfo.name, visible: true, strength: 1, locked: baseInfo.locked, base: true, empty: false },
        ...layers.map((l) => ({
          id: l.id, name: l.name, visible: l.visible, strength: l.strength,
          locked: l.locked, base: false, empty: l.tiles.size === 0,
        })),
      ];
    },

    editable,

    /** Make `id` the layer edits go to. False if there is no such layer. */
    setActiveLayer(id) {
      if (id !== 0 && !layerById(id)) return false;
      activeId = id;
      version++;
      return true;
    },

    /** A new empty layer on top; it becomes the active one. Returns its id. */
    addLayer(name) {
      const id = nextLayerId++;
      layers.push({ id, name: name || `Layer ${id}`, visible: true, strength: 1, locked: false, tiles: new Map() });
      activeId = id;
      version++;
      return id;
    },

    /**
     * Change a layer's name, visibility, strength (0…2) or lock. Heights are
     * recomposed where the layer has data. BASE takes only a lock.
     */
    setLayer(id, { name, visible, strength, locked } = {}) {
      if (id === 0) {
        if (locked !== undefined) baseInfo.locked = !!locked;
        version++;
        return true;
      }
      const l = layerById(id);
      if (!l) return false;
      const s = strength === undefined ? l.strength : Math.max(0, Math.min(2, Number(strength) || 0));
      const v = visible === undefined ? l.visible : !!visible;
      const heightsChange = v !== l.visible || s !== l.strength;
      if (name !== undefined) l.name = String(name);
      if (locked !== undefined) l.locked = !!locked;
      l.visible = v;
      l.strength = s;
      version++;
      if (heightsChange) relayer(layerRect(l));
      return true;
    },

    /** Empty a layer (it stays in the list). */
    clearLayer(id) {
      const l = layerById(id);
      if (!l) return false;
      const r = layerRect(l);
      l.tiles.clear();
      version++;
      relayer(r);
      return true;
    },

    /** Delete a layer and its heights. The active layer falls back to BASE. */
    removeLayer(id) {
      const k = layers.findIndex((l) => l.id === id);
      if (k < 0) return false;
      const r = layerRect(layers[k]);
      layers.splice(k, 1);
      if (activeId === id) activeId = 0;
      version++;
      relayer(r);
      return true;
    },

    /**
     * Fold a layer into the one under it (or BASE), as it looks now, then
     * delete it. The heights do not move. Refused when it is hidden or at
     * strength 0 (nothing honest to fold), or the one below cannot take edits.
     */
    mergeDown(id) {
      const k = layers.findIndex((l) => l.id === id);
      if (k < 0) return false;
      const l = layers[k];
      const below = k > 0 ? layers[k - 1] : null;
      if (!l.visible || l.strength === 0) return false;
      if (!editable(below ? below.id : 0)) return false;
      for (const [t, tile] of l.tiles) {
        const tx = t % tilesX, tz = Math.floor(t / tilesX);
        if (below) {
          let dst = below.tiles.get(t);
          if (!dst) below.tiles.set(t, (dst = new Float32Array(LAYER_TILE * LAYER_TILE)));
          const s = l.strength / below.strength;
          for (let j = 0; j < tile.length; j++) dst[j] += tile[j] * s;
        } else {
          for (let j = 0; j < tile.length; j++) {
            const x = tx * LAYER_TILE + (j % LAYER_TILE), z = tz * LAYER_TILE + Math.floor(j / LAYER_TILE);
            if (x < size && z < size) base[z * size + x] += tile[j] * l.strength;
          }
        }
      }
      layers.splice(k, 1);
      if (activeId === id) activeId = below ? below.id : 0;
      version++;
      groundVersion++;
      return true;
    },

    /**
     * What the visible sculpt layers add to BASE (GROUND − BASE), for a pass
     * that rewrites BASE on the GPU (Generate) and must keep the layers on top.
     * Null when no layer adds anything.
     */
    layerSum() {
      if (!layers.some(contributes)) return null;
      const out = new Float32Array(N);
      for (let i = 0; i < N; i++) out[i] = ground[i] - base[i];
      return out;
    },

    /**
     * The layers for a project file: { meta, data } — meta is JSON (the list,
     * which tiles each layer has), data ONE Float32Array of every tile in that
     * order. Null when there is nothing but BASE.
     */
    exportLayers() {
      if (!layers.length && !baseInfo.locked) return null;
      const T = LAYER_TILE * LAYER_TILE;
      let n = 0;
      for (const l of layers) n += l.tiles.size;
      const data = new Float32Array(n * T);
      let at = 0;
      const meta = {
        tile: LAYER_TILE, size, active: activeId, baseLocked: baseInfo.locked,
        layers: layers.map((l) => {
          const tiles = [...l.tiles.keys()].sort((a, b) => a - b);
          for (const t of tiles) { data.set(l.tiles.get(t), at); at += T; }
          return { id: l.id, name: l.name, visible: l.visible, strength: l.strength, locked: l.locked, tiles };
        }),
      };
      return { meta, data };
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
