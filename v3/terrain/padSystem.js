/**
 * v3/terrain/padSystem.js — PADS: flattened zones placed in the level (2026-10-17).
 *
 * Unreal's "landscape patch" idea: a building pad, a paddock, an airfield, a square
 * is an OBJECT, not a sculpt stroke — move it, resize it, delete it, and the ground
 * follows. Each pad is a STAMP on the height stack (heightLayers.js), so it sits
 * above the ground, the sculpt layers and the rivers, and nothing can erase it.
 *
 * Runs in the EDITOR and in GAMES: a level carries its pads (`pads` in the
 * .v3proj) and the engine applies them on load, so a game gets them with no code.
 * The editing half (selection, gizmo, outline, history) is v3/tools/padEditor.js.
 *
 * A pad:
 *   shape       "rect" | "circle" (circle radius = halfX)
 *   x, z, rot   centre (metres) and turn about Y (radians), as three.js Y rotation
 *   halfX/Z     half-extents of the FLAT area (metres)
 *   rim         soft edge (metres): the pad eases back to the ground over it
 *   heightMode  "follow": the average of the ground under the flat area, measured
 *               again whenever the ground changes (regenerate the base, sculpt
 *               under it: the pad adapts) · "fixed": `height` metres
 *   offset      metres added to the target (a raised or sunk pad)
 *   enabled     off = no effect (kept in the level)
 *   attach      a prop id, or null: the pad takes that prop's position, turn and
 *               footprint (+ `margin` metres all round) and follows it
 *
 * COST. Nothing per frame but two comparisons, unless the ground changed (a
 * counter, heightLayers.groundVersion) or an attached prop moved; then only that
 * pad's rect is recomposed. "Follow" measures at most 32×32 samples.
 */

export const PAD_DEFAULTS = Object.freeze({
  shape: "rect",
  halfX: 5,
  halfZ: 5,
  rot: 0,
  rim: 4,
  heightMode: "follow",
  height: 0,
  offset: 0,
  enabled: true,
  attach: null,
  margin: 1,
});

const KEY_PREFIX = "pad|";
const FOLLOW_SAMPLES = 32;

/**
 * @param {object} o
 * @param {ReturnType<import("./heightLayers.js").createHeightLayers>} o.heightLayers
 * @param {number} o.worldSize
 * @param {number} o.heightmapSize
 * @param {number} o.maxHeight
 * @param {(id:number) => ({x:number, z:number, rot:number, halfX:number, halfZ:number} | null)} [o.resolveProp]
 *   an attached prop's footprint, or null when it is gone
 * @param {() => void} [o.onChanged]  a pad was added, edited or removed (panels, outlines)
 */
export function createPadSystem({ heightLayers, worldSize, heightmapSize, maxHeight, resolveProp = () => null, onChanged = null }) {
  const S = heightmapSize, W = worldSize;
  /** @type {Array<object>} */
  const pads = [];
  let nextId = 1;
  let groundSeen = -1;
  let version = 0;

  const toTexel = (w) => Math.floor(((w + W / 2) / W) * S);
  const texelCentre = (t) => ((t + 0.5) / S) * W - W / 2;
  const keyOf = (p) => KEY_PREFIX + p.id;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  /** Where the pad is and how big, after an attachment: { x, z, rot, halfX, halfZ }. */
  function footprint(p) {
    if (p.attach != null) {
      const f = resolveProp(p.attach);
      if (f) return { x: f.x, z: f.z, rot: f.rot, halfX: f.halfX + p.margin, halfZ: f.halfZ + p.margin };
    }
    return { x: p.x, z: p.z, rot: p.rot, halfX: p.halfX, halfZ: p.halfZ };
  }

  /** Distance (metres) from the flat area, 0 inside — rectangle or circle, in the pad's frame. */
  function distFrom(p, f, wx, wz) {
    const dx = wx - f.x, dz = wz - f.z;
    if (p.shape === "circle") return Math.max(0, Math.hypot(dx, dz) - f.halfX);
    const cr = Math.cos(f.rot), sr = Math.sin(f.rot);
    // Into the pad's frame — the inverse of three.js Y rotation (as flattenRect).
    const lx = dx * cr - dz * sr, lz = dx * sr + dz * cr;
    return Math.hypot(Math.max(0, Math.abs(lx) - f.halfX), Math.max(0, Math.abs(lz) - f.halfZ));
  }

  /** The texel rect the pad can touch (flat area + rim), unclipped. */
  function rectOf(p, f) {
    const reach = (p.shape === "circle" ? f.halfX : Math.hypot(f.halfX, f.halfZ)) + p.rim;
    return { x0: toTexel(f.x - reach), z0: toTexel(f.z - reach), x1: toTexel(f.x + reach), z1: toTexel(f.z + reach) };
  }

  /** Average GROUND (normalized) under the flat area: the sculpted ground, before rivers and stamps. */
  function groundAverage(p, f) {
    const g = heightLayers.ground;
    const r = rectOf({ ...p, rim: 0 }, f);
    const x0 = Math.max(0, r.x0), z0 = Math.max(0, r.z0), x1 = Math.min(S - 1, r.x1), z1 = Math.min(S - 1, r.z1);
    if (x1 < x0 || z1 < z0) return null;
    const step = Math.max(1, Math.ceil(Math.max(x1 - x0 + 1, z1 - z0 + 1) / FOLLOW_SAMPLES));
    let sum = 0, n = 0;
    for (let tz = z0; tz <= z1; tz += step) {
      for (let tx = x0; tx <= x1; tx += step) {
        if (distFrom(p, f, texelCentre(tx), texelCentre(tz)) > 0) continue;
        sum += g[tz * S + tx];
        n++;
      }
    }
    if (!n) {
      // A pad smaller than a texel: the ground at its centre.
      const tx = Math.min(S - 1, Math.max(0, toTexel(f.x))), tz = Math.min(S - 1, Math.max(0, toTexel(f.z)));
      return g[tz * S + tx];
    }
    return sum / n;
  }

  /** The height (normalized) the pad levels to. */
  function targetOf(p, f) {
    if (p.heightMode === "fixed") return clamp01((p.height + p.offset) / maxHeight);
    const avg = groundAverage(p, f);
    return avg === null ? null : clamp01(avg + p.offset / maxHeight);
  }

  const sameFootprint = (a, b) => a && b && a.x === b.x && a.z === b.z && a.rot === b.rot && a.halfX === b.halfX && a.halfZ === b.halfZ;

  /** (Re)place the pad's stamp — or take it away when it is off or has nothing under it. */
  function apply(p) {
    const f = footprint(p);
    const target = p.enabled ? targetOf(p, f) : null;
    if (target === null) {
      heightLayers.removeStamp(keyOf(p));
      p._applied = null;
      return;
    }
    const shape = p.shape, rim = Math.max(0, p.rim);
    const pp = { shape };
    heightLayers.addStamp(keyOf(p), rectOf(p, f), (map, r) => {
      for (let tz = r.z0; tz <= r.z1; tz++) {
        const wz = texelCentre(tz);
        for (let tx = r.x0; tx <= r.x1; tx++) {
          const d = distFrom(pp, f, texelCentre(tx), wz);
          if (d >= rim && d > 0) continue;
          const s = rim > 0 ? d / rim : 0;
          const w = 1 - s * s * (3 - 2 * s);
          const i = tz * S + tx;
          map[i] += (target - map[i]) * w;
        }
      }
    });
    p._applied = { f, target };
  }

  function changed() {
    version++;
    onChanged?.();
  }

  function clean(src) {
    const p = { ...PAD_DEFAULTS };
    for (const k of Object.keys(PAD_DEFAULTS)) if (src[k] !== undefined) p[k] = src[k];
    p.x = Number.isFinite(src.x) ? src.x : 0;
    p.z = Number.isFinite(src.z) ? src.z : 0;
    p.shape = p.shape === "circle" ? "circle" : "rect";
    p.heightMode = p.heightMode === "fixed" ? "fixed" : "follow";
    p.halfX = Math.max(0.25, +p.halfX || PAD_DEFAULTS.halfX);
    p.halfZ = Math.max(0.25, +p.halfZ || PAD_DEFAULTS.halfZ);
    p.rim = Math.max(0, +p.rim || 0);
    p.attach = p.attach == null ? null : Number(p.attach);
    return p;
  }

  const pub = {
    get pads() { return pads; },
    get version() { return version; },
    get(id) { return pads.find((p) => p.id === id) ?? null; },
    footprintOf(id) { const p = pub.get(id); return p ? footprint(p) : null; },
    /** The height (metres) the pad is levelled to now, or null when it has no effect. */
    levelOf(id) { const p = pub.get(id); return p?._applied ? p._applied.target * maxHeight : null; },

    /** A new pad (PAD_DEFAULTS + `props`). Returns it. */
    add(props = {}) {
      const p = clean(props);
      p.id = props.id != null && !pub.get(props.id) ? props.id : nextId;
      nextId = Math.max(nextId, p.id + 1);
      pads.push(p);
      apply(p);
      changed();
      return p;
    },

    /** Change some fields of a pad and re-level it. */
    edit(id, patch) {
      const p = pub.get(id);
      if (!p) return null;
      Object.assign(p, clean({ ...p, ...patch }), { id: p.id });
      apply(p);
      changed();
      return p;
    },

    remove(id) {
      const k = pads.findIndex((p) => p.id === id);
      if (k < 0) return false;
      heightLayers.removeStamp(keyOf(pads[k]));
      pads.splice(k, 1);
      changed();
      return true;
    },

    /** The pad whose flat area (or a little of its rim) contains (wx, wz), topmost first. */
    pick(wx, wz, slack = 0.5) {
      for (let k = pads.length - 1; k >= 0; k--) {
        const p = pads[k];
        if (distFrom(p, footprint(p), wx, wz) <= slack) return p;
      }
      return null;
    },

    /**
     * Once per frame: re-measure "follow" pads when the ground changed, and move
     * pads whose prop moved. Two comparisons when nothing happened.
     */
    update() {
      if (!pads.length) return;
      const gv = heightLayers.groundVersion;
      const groundMoved = gv !== groundSeen;
      groundSeen = gv;
      for (const p of pads) {
        if (!p.enabled) continue;
        const f = p.attach != null ? footprint(p) : null;
        const moved = f && !sameFootprint(f, p._applied?.f);
        if (moved) { apply(p); continue; }
        if (groundMoved && p.heightMode === "follow") {
          const t = targetOf(p, footprint(p));
          if (t !== null && Math.abs(t - (p._applied?.target ?? -1)) > 1e-6) apply(p);
        }
      }
      // Our own re-levels do not change GROUND, so they cannot bring us back here.
      groundSeen = heightLayers.groundVersion;
    },

    /** Re-apply every pad (after the height stack was reset, e.g. a project load). */
    reapplyAll() {
      for (const p of pads) apply(p);
      groundSeen = heightLayers.groundVersion;
    },

    /** Plain data for undo snapshots and the project file. */
    snapshot() {
      return pads.map((p) => {
        const o = { id: p.id, x: p.x, z: p.z };
        for (const k of Object.keys(PAD_DEFAULTS)) o[k] = p[k];
        return o;
      });
    },

    /** Replace every pad with a snapshot (undo, project load). */
    restore(list) {
      heightLayers.removeStampsWithPrefix(KEY_PREFIX);
      pads.length = 0;
      nextId = 1;
      for (const src of list ?? []) {
        const p = clean(src);
        p.id = Number.isFinite(src.id) ? src.id : nextId;
        nextId = Math.max(nextId, p.id + 1);
        pads.push(p);
      }
      pub.reapplyAll();
      changed();
    },

    exportData() { return pads.length ? { pads: pub.snapshot() } : null; },
    importData(data) { pub.restore(data?.pads ?? []); },
  };
  return pub;
}
