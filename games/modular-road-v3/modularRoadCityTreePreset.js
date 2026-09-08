// ============================================================================
// CITY TREES FROM A TREE-EDITOR PRESET — by handing them to v3's tree stack.
//
// A SWITCH, not a replacement: modularRoadCityFurniture keeps its procedural
// box-and-icospheres tree in full and chooses between the two on
// `FURNITURE.treeSource`. Flip that back to "procedural" and nothing here runs.
//
// ── WHAT THIS FILE USED TO BE, AND WHY IT ISN'T ANY MORE ─────────────────────
//
// The first version baked the preset itself: it read the leaf table out of the
// preset, pre-transformed every card into world space on the CPU, and drew the
// lot as one InstancedBufferGeometry with its own hand-written distance cull.
// It worked, and it cost 6 ms more than the procedural tree it replaced —
// because it had no leaf LOD and no impostors, so 4.6k trees meant 3 M
// alpha-tested triangles at every distance, and the trunk had to be culled at
// 140 m to stay affordable at all.
//
// v3 already solves all three, properly, and it is ALREADY RUNNING in this
// game: startV3App builds a full tree environment unconditionally and ticks it
// every frame. Between them TreeLodRenderer, FoliageLodRenderer,
// LeafFieldRenderer and ImpostorFieldRenderer give trunk LOD, continuous
// per-card leaf LOD, GPU frustum + distance culling and octahedral impostors
// for the far band. None of that needed writing. It needed CALLING.
//
// So this file is now an adapter, and a short one. It loads the preset into a
// tree slot through the same path the editor's own panel uses — which also
// bakes the impostor and reads `trunkScale` into the slot's `baseScale` — and
// publishes the city's placements into the shared TreeStore. The renderers
// pick them up on their next update with no further involvement from us.
//
// THE LESSON, worth keeping: the reason the bake existed at all was that the
// leaf field's entry point (`syncGroups(mergeGroups, slotPresets, treeStore)`)
// looks like it needs editor-only structures. It does not — `loadTreePreset`
// builds them. Reading one layer further up would have saved the whole file.
// ============================================================================

export const CITY_TREE_PRESET = {
  /** Preset filename under /tree-presets/. */
  file: "tree110.json",
  /**
   * Which tree slot the city claims.
   *
   * The LAST of the eight, deliberately. Slots are shared with anything else
   * that plants trees — a loaded .v3proj paints from 0 upward — so taking the
   * far end is the least likely to collide. It is still a claim: a project that
   * fills all eight and the city cannot both have slot 7, and the city wins
   * because it loads later.
   */
  slot: 7,
  /** Extra scale on top of the preset's own trunkScale (the slot's baseScale). */
  scale: 1.0,
  /** ± this fraction of random size variation per tree, so a street is not a
   *  row of clones. The city's own placement scale is folded in on top. */
  scaleVar: 0.18,
};

/** One in-flight load per (slot, file) — the city rebuilds far more often than
 *  this changes, and re-fetching the atlas per rebuild would hitch every time. */
const _loaded = new Map();

/**
 * Put the preset in its slot, once. Uses the editor's own loadTreePreset, which
 * is what wires the trunk LODs, the foliage preset, the GPU leaf field AND the
 * octahedral impostor bake — and sets the slot's `baseScale` from the preset's
 * `trunkScale`, which is a placement scale rather than a mesh scale and is easy
 * to get wrong by hand.
 */
function ensurePreset(treeEnv, slot, file) {
  const key = `${slot}:${file}`;
  if (!_loaded.has(key)) {
    _loaded.set(key, (async () => {
      const resp = await fetch(`/tree-presets/${file}`);
      if (!resp.ok) throw new Error(`[CityTrees] /tree-presets/${file} → ${resp.status}`);
      const text = await resp.text();
      // loadTreePreset takes a File because it is the panel's file-picker path;
      // treeEnvironment's own console helper wraps JSON exactly like this.
      await treeEnv.loadTreePreset(slot, new File([text], file, { type: "application/json" }));
      // The slot's baseScale is set from this inside loadTreePreset, but the
      // number is not readable back out of treeEnv — and we need it to plant at
      // the right size. Parsing the text we already have beats adding an
      // accessor to the engine for one caller.
      return JSON.parse(text).trunkScale ?? 1;
    })().catch((e) => { _loaded.delete(key); throw e; }));
  }
  return _loaded.get(key);
}

/**
 * Publish the city's tree placements to the shared store.
 *
 * @param {object} treeEnv  app.treeEnv from startV3App
 * @param {Array}  trees    the furniture's placements ({ x, z, scale, m })
 * @param {object} [opts]   overrides for CITY_TREE_PRESET, plus `groundY`
 * @returns {Promise<{stats:object, dispose:Function}>}
 */
export async function installCityPresetTrees(treeEnv, trees, opts = {}) {
  const P = { ...CITY_TREE_PRESET, ...opts };
  const slot = P.slot;
  const noop = { stats: { trees: 0, slot }, dispose() {} };
  if (!treeEnv?.treeStore || !trees?.length) return noop;

  const presetTrunkScale = await ensurePreset(treeEnv, slot, P.file);

  const store = treeEnv.treeStore;
  // Ours and only ours — a rebuild must not double-plant, and must not touch
  // whatever else is in the store. See TreeStore.removeTreesBySlot for why the
  // radius-based remove cannot be used from here.
  store.removeTreesBySlot(slot);

  // The slot's baseScale IS the preset's trunkScale, and the store wants an
  // ABSOLUTE scale: treeSystem plants at `(scaleMin..scaleMax) * baseScale`, so
  // anything that skips the multiply gets a tree at 1/trunkScale of its size.
  const baseScale = presetTrunkScale;
  const groundY = P.groundY ?? 0;

  let n = 0;
  for (const e of trees) {
    // A hash of the position, not Math.random: the city rebuilds on every seed
    // change and a tree that resizes itself each time reads as flicker.
    const h = Math.abs(Math.sin(e.x * 12.9898 + e.z * 78.233) * 43758.5453) % 1;
    const vary = 1 + (h - 0.5) * 2 * P.scaleVar;
    const rotY = h * Math.PI * 2;
    store.addTree(e.x, e.z, groundY, rotY, baseScale * P.scale * vary * (e.scale ?? 1), slot);
    n++;
  }

  return {
    stats: { trees: n, slot, baseScale },
    dispose() { store.removeTreesBySlot(slot); },
  };
}
