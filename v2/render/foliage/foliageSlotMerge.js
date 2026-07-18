/**
 * FoliageMergeGroups — groups tree slots that sample the SAME shared leaf
 * atlas (billboard mode) so the chunked renderer can draw all of them as ONE
 * mesh per cell per LOD tier instead of one per slot. Draw calls stop scaling
 * with the number of loaded tree/bush presets.
 *
 * Each group owns one merged material (createMergedFoliageMaterial): leaf
 * instances carry a group-local slot index in aLeafScale.z, and every
 * per-slot parameter lives in a uniform array indexed by it. Live panel
 * edits keep working because syncParams() mirrors each member preset's own
 * uniforms into the arrays every frame (a few dozen float copies — free).
 *
 * The group's card geometry is the trim octagon of the UNION of the member
 * cells' masks (one mesh = one vertex layout, so per-slot trims are
 * impossible; the union costs a little extra fill over a per-cell trim but
 * keeps the big win over a plain quad).
 *
 * Ordering contract: the renderer must remove + dispose all group meshes and
 * pooled meshes BEFORE calling rebuild() — merged meshes share the card
 * geometry's vertex buffers, which rebuild() disposes when membership changes.
 */
import * as THREE from "three";
import {
  createMergedFoliageMaterial,
  setFoliageTexture,
  MAX_MERGED_SLOTS,
} from "./foliageMaterial.js";
import {
  computeLeafTrimPolygon,
  buildLeafCardGeometry,
} from "../../core/foliage/leafCardTrim.js";

export class FoliageMergeGroups {
  constructor() {
    /** mergeKey -> group */
    this.groups = new Map();
    /** slotIdx -> group (only slots actually merged; overflow slots absent) */
    this.slotToGroup = new Map();
  }

  /** Recompute membership from the current slot presets. */
  rebuild(slotPresets) {
    // Desired membership per atlas key.
    const want = new Map(); // key -> slotIdx[]
    slotPresets.forEach((preset, si) => {
      if (!preset?.mergeKey) return;
      let arr = want.get(preset.mergeKey);
      if (!arr) want.set(preset.mergeKey, (arr = []));
      arr.push(si);
    });

    // Drop groups whose atlas is no longer used at all. The material is kept
    // while the key survives (pipeline stays warm across membership changes).
    for (const key of [...this.groups.keys()]) {
      if (!want.has(key)) {
        const g = this.groups.get(key);
        g.cardGeometry?.dispose();
        g.material.dispose();
        this.groups.delete(key);
      }
    }

    this.slotToGroup.clear();
    for (const [key, slots] of want) {
      if (slots.length > MAX_MERGED_SLOTS) {
        console.warn(
          `[FoliageMerge] atlas "${key}": ${slots.length} slots > ${MAX_MERGED_SLOTS} — overflow slots render per-slot`,
        );
        slots.length = MAX_MERGED_SLOTS;
      }
      let g = this.groups.get(key);
      const first = slotPresets[slots[0]];
      if (!g) {
        const built = createMergedFoliageMaterial({ atlasGrid: first.atlasGridArr });
        g = {
          key,
          material: built.material,
          uniforms: built.uniforms,
          leafMapNode: built.leafMapNode,
          arrays: built.arrays,
          members: new Map(),
          cardGeometry: null,
          cardGen: 0,
        };
        this.groups.set(key, g);
      }

      // Share the first member's loaded atlas texture (same file for all).
      const tex = first.leafMapNode?.value;
      if (tex && g.leafMapNode.value !== tex) {
        setFoliageTexture({ leafMapNode: g.leafMapNode, uniforms: g.uniforms }, tex);
        g.uniforms.maskInAlpha.value = 0; // shared atlas mask lives in RED
      }
      g.material.roughness = first.material?.roughness ?? 0.88;

      g.members = new Map(slots.map((si, mi) => [si, mi]));
      for (const si of slots) this.slotToGroup.set(si, g);

      this._rebuildUnionCard(g, slotPresets);
      g.cardGen++;
      this.syncGroupParams(g, slotPresets);
    }
  }

  /** Union-of-cells trim octagon shared by every card of the group. */
  _rebuildUnionCard(g, slotPresets) {
    g.cardGeometry?.dispose();
    let poly = null;
    const img = g.leafMapNode.value?.image;
    if (img) {
      try {
        const S = 64;
        const cv = document.createElement("canvas");
        cv.width = cv.height = S;
        const ctx = cv.getContext("2d");
        ctx.globalCompositeOperation = "lighten"; // per-pixel max ≈ mask union
        const iw = img.width ?? img.naturalWidth;
        const ih = img.height ?? img.naturalHeight;
        for (const si of g.members.keys()) {
          const r = slotPresets[si]?.atlasCellRect;
          if (!r) continue;
          ctx.drawImage(img, r.x * iw, r.y * ih, r.w * iw, r.h * ih, 0, 0, S, S);
        }
        poly = computeLeafTrimPolygon(cv, { maskInAlpha: false });
      } catch (_) { /* tainted canvas etc. — quad fallback */ }
    }
    g.cardGeometry = buildLeafCardGeometry(poly);
  }

  /** Mirror one group's member preset uniforms into its packed uniform array
   *  (PARAM_ROWS vec4 rows per slot — see createMergedFoliageMaterial). */
  syncGroupParams(g, slotPresets) {
    const rows = g.arrays.params.array;
    const R = g.arrays.PARAM_ROWS;
    for (const [si, mi] of g.members) {
      const u = slotPresets[si]?.uniforms;
      if (!u) continue;
      const o = mi * R;
      const bc = u.bottomColor.value, tc = u.topColor.value;
      const sc = u.sssColor.value, rc = u.rimColor.value;
      rows[o].set(bc.r, bc.g, bc.b, u.colorVar.value);
      rows[o + 1].set(tc.r, tc.g, tc.b, u.treeColorVar.value);
      rows[o + 2].set(sc.r, sc.g, sc.b, u.sssStr.value);
      rows[o + 3].set(rc.r, rc.g, rc.b, u.rimStr.value);
      rows[o + 4].set(
        u.alphaCutoff.value, u.normalBias.value, u.leafWarp.value, u.aoStr.value,
      );
      rows[o + 5].set(
        u.sssPow.value, u.rimPow.value, u.aoRadius.value, u.atlasCell.value,
      );
      rows[o + 6].set(
        u.windSpeed.value, u.windStr.value, u.windMicro.value, u.billboardYaw.value,
      );
    }
  }

  /** Per-frame: keep arrays following live panel edits on member presets. */
  syncParams(slotPresets) {
    for (const [, g] of this.groups) this.syncGroupParams(g, slotPresets);
  }

  dispose() {
    for (const [, g] of this.groups) {
      g.cardGeometry?.dispose();
      g.material.dispose();
    }
    this.groups.clear();
    this.slotToGroup.clear();
  }
}
