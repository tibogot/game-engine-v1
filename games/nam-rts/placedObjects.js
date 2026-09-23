// Placed objects — ONE path for anything that stands on the map as a piece of
// the world: the camp's decoration today, the builder's buildings next.
//
// Each piece gets, in this order:
//   1. a PAD — the ground levelled to its own footprint, turned with it (all
//      pads first, so no pad's rim tilts the ground under a piece already
//      standing); the map's rocks inside the pad are removed
//   2. its place on the final ground, and the grass/foliage cleared round it
//   3. NAV — its real footprint (an oriented rectangle, not a bounding circle)
//      blocked in the nav grid, kept across rebuilds
//   4. COVER — the footprint as a row of circles for the cover bake, so the
//      piece that stops your feet also stops bullets
//
// Draw calls: static kit pieces sharing a material are MERGED into one mesh
// per material (the kit, its stencils, the sign sheet…), so forty pieces cost
// a handful of draws. Imported models (GLBs) stay as they are.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Footprint of `obj` in its own frame (scaled, not rotated): {cx, cz, hx, hz}. */
function footprintOf(obj, scale) {
  const fp = obj.geometry?.userData?.footprint;
  if (fp) return { cx: fp.cx * scale, cz: fp.cz * scale, hx: fp.hx * scale, hz: fp.hz * scale };
  const box = new THREE.Box3();
  obj.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const rel = new THREE.Matrix4();
  obj.traverse((m) => {
    if (!m.isMesh) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox.clone().applyMatrix4(rel.multiplyMatrices(inv, m.matrixWorld)));
  });
  return {
    cx: ((box.max.x + box.min.x) * scale) / 2, cz: ((box.max.z + box.min.z) * scale) / 2,
    hx: ((box.max.x - box.min.x) * scale) / 2, hz: ((box.max.z - box.min.z) * scale) / 2,
  };
}

/** Attribute layout key: mergeGeometries returns null on any mismatch. */
const layoutKey = (g) => Object.keys(g.attributes).sort().map((k) => `${k}${g.attributes[k].itemSize}`).join(",") + (g.index ? "|i" : "|n");

export function createPlacedObjects(app) {
  const group = new THREE.Group();
  group.name = "PlacedObjects";
  app.scene.add(group);
  const pieces = [];   // { x, z, rotY, fp: {px, pz, hx, hz}, cover, nav }

  /**
   * Place a batch. Each item: { obj, x, z, rotY = 0, scale = 1, pad = true,
   * clear = 0 (m of vegetation), nav = pad, cover = pad, apron = 0.5,
   * merge = true (static; false for anything that animates or is a GLB),
   * ground = the apron decal under the pad: "laterite" (default), "swept"
   * (a village yard) or "none" — see buildingAprons.js }.
   */
  async function place(items) {
    const c0 = Math.cos, s0 = Math.sin;
    // 1) Pads.
    for (const it of items) {
      it.rotY ??= 0; it.scale ??= 1; it.pad ??= true; it.clear ??= 0; it.apron ??= 0.5;
      it.nav ??= it.pad; it.cover ??= it.pad;
      it.obj.scale.setScalar(it.scale);
      it.obj.rotation.y = it.rotY;
      it.obj.position.set(0, 0, 0);
      const f = footprintOf(it.obj, it.scale);
      const c = c0(it.rotY), s = s0(it.rotY);
      // Local → world for a yaw of rotY (three.js: x' = x·c + z·s, z' = −x·s + z·c).
      it.fp = { px: it.x + f.cx * c + f.cz * s, pz: it.z - f.cx * s + f.cz * c, hx: f.hx + it.apron, hz: f.hz + it.apron, c, s };
      if (!it.pad || !app.flattenRect) continue;
      const { px, pz, hx, hz } = it.fp;
      // Level to the mean of the ground under the four corners and the centre:
      // cut on the high side, fill on the low, as a bulldozer would.
      let y = app.getWorldHeight(px, pz), n = 1;
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const lx = sx * hx, lz = sz * hz;
        y += app.getWorldHeight(px + lx * c + lz * s, pz - lx * s + lz * c); n++;
      }
      await app.flattenRect(px, pz, hx, hz, y / n, { rotY: it.rotY, rim: 3, ground: it.ground });
      removeMapPropsIn(it.fp);
    }

    // 2) Stand them on the final ground; collect static meshes for merging.
    const buckets = new Map();   // material → layout → [geometry in world space]
    const sources = new Set();   // the pieces' own geometries, freed once merged
    for (const it of items) {
      it.obj.position.set(it.x, app.getWorldHeight(it.x, it.z) - (it.pad ? 0.02 : 0.05), it.z);
      it.obj.updateMatrixWorld(true);
      if (it.clear) app.clearVegetation?.(it.x, it.z, it.clear + 2, { grass: it.clear });
      if (it.merge === false) {
        it.obj.traverse((m) => { if (m.isMesh) m.castShadow = m.receiveShadow = true; });
        group.add(it.obj);
      } else {
        it.obj.traverse((m) => {
          if (!m.isMesh) return;
          // Clone without userData: clone() JSON-copies it, stencil geometry and all.
          const ud = m.geometry.userData;
          m.geometry.userData = {};
          const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
          m.geometry.userData = ud;
          g.clearGroups();
          sources.add(m.geometry);
          let byLayout = buckets.get(m.material);
          if (!byLayout) buckets.set(m.material, (byLayout = { list: new Map(), shadow: m.castShadow || m.material.name !== "RtsStencil" }));
          const key = layoutKey(g);
          if (!byLayout.list.has(key)) byLayout.list.set(key, []);
          byLayout.list.get(key).push(g);
        });
      }
      pieces.push({ x: it.x, z: it.z, rotY: it.rotY, fp: it.fp, nav: it.nav, cover: it.cover, navHandle: null });
    }
    for (const [material, { list, shadow }] of buckets) {
      for (const geos of list.values()) {
        const merged = mergeGeometries(geos, false);
        for (const g of geos) g.dispose();
        if (!merged) { console.warn("[placed] merge failed for", material.name); continue; }
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, material);
        mesh.name = `Placed:${material.name || "mat"}`;
        mesh.castShadow = shadow;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
    }
    for (const g of sources) g.dispose();

    // 3) Nav footprints.
    for (const p of pieces) {
      if (!p.nav || p.navHandle || !app.navGrid?.addFootprint) continue;
      p.navHandle = app.navGrid.addFootprint(p.fp.px, p.fp.pz, p.fp.hx, p.fp.hz, p.rotY);
    }
  }

  /** The pad takes its footprint back from the map's props (rocks). */
  function removeMapPropsIn({ px, pz, hx, hz, c, s }) {
    const ps = app.propStore;
    if (!ps?.instances) return;
    for (let i = ps.instances.length - 1; i >= 0; i--) {
      const inst = ps.instances[i];
      const pb = ps.types[inst.typeIdx]?.mergedBox;
      if (!pb) continue;
      const r = Math.max(Math.abs(pb.min.x), Math.abs(pb.max.x), Math.abs(pb.min.z), Math.abs(pb.max.z))
        * Math.max(Math.abs(inst.sx ?? 1), Math.abs(inst.sz ?? 1));
      const dx = inst.px - px, dz = inst.pz - pz;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;   // into the pad's frame
      const qx = Math.max(-hx, Math.min(lx, hx)), qz = Math.max(-hz, Math.min(lz, hz));
      if (Math.hypot(lx - qx, lz - qz) < r) ps.removeInstance(i);
    }
  }

  /**
   * Cover obstacles: each footprint as circles of the short half-width along
   * its long axis — a 12 m tent is three circles, not one 6 m disc that would
   * hand cover to the empty ground past its ends.
   */
  function* coverCircles() {
    for (const p of pieces) {
      if (!p.cover) continue;
      const { px, pz, hx, hz, c, s } = p.fp;
      const r = Math.min(hx, hz), long = Math.max(hx, hz);
      // The long axis in world space: local X → (c, −s), local Z → (s, c).
      const [ax, az] = hx >= hz ? [c, -s] : [s, c];
      const n = Math.max(1, Math.ceil((long - r) / r) + 1);
      for (let k = 0; k < n; k++) {
        const t = n === 1 ? 0 : -1 + (2 * k) / (n - 1);
        yield { x: px + ax * (long - r) * t, z: pz + az * (long - r) * t, radius: r };
      }
    }
  }

  return {
    group, pieces, place, coverCircles,
    dispose() {
      for (const p of pieces) if (p.navHandle) app.navGrid?.removeFootprint?.(p.navHandle);
      pieces.length = 0;
      app.scene.remove(group);
      group.traverse((m) => m.isMesh && m.geometry.dispose());
    },
  };
}
