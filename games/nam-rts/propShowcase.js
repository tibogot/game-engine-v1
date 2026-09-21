// Prop showcase — DEV ONLY, off unless the URL says ?showcase=1.
//
// Places every prop being judged around the player's HQ, so the pieces can be
// looked at in the game from both cameras before they go into the editor as
// placeable types. Nothing here is gameplay: no nav, no cover, no saving.
import * as THREE from "three";
import {
  buildConex, buildConexYard, buildContainer, buildCrateStack, buildFuelDump, buildGuardTower, buildGunPit, buildMinesSign, buildRadioStation, buildTent,
} from "../../v3/render/objects/rtsFirebaseProps.js";
import { MAT } from "../../v3/render/objects/rtsParts.js";
import { buildBillboard, buildPostSign } from "../../v3/render/objects/rtsSigns.js";
import { rtsObjectMaterial } from "../../v3/render/objects/rtsObjectProps.js";
import { stencilMesh } from "../../v3/render/objects/rtsStencils.js";
import { ATLAS_COLS, ATLAS_ROWS, rtsAtlas } from "../../v3/render/objects/rtsTextures.js";
import { abs, clamp, dot, fract, normalLocal, positionLocal, select, texture, uv, vec2, vec3 } from "three/tsl";
import { getSharedGltfLoader } from "../../v2/core/foliage/glbLoader.js";

/** Real size x 1.3, like the units (unitTypes.js RTS_SCALE). */
const S = 1.3;

/**
 * Repaint an imported model: keep its texture's LIGHT AND DARK (ribs, dents,
 * grime) and replace its colour — a flat paint, or the kit's camouflage laid
 * on in object space (the model's own UVs know nothing of the pattern).
 */
function repaint(root, { color = null, camo = false } = {}) {
  const atlas = camo ? rtsAtlas() : null;
  const tint = new THREE.Color(color ?? "#58623a");
  root.traverse((m) => {
    if (!m.isMesh) return;
    const src = m.material;
    const nm = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.1, normalMap: src.normalMap ?? null });
    const base = src.map ? texture(src.map, uv()).rgb : vec3(0.5);
    // The model's value, normalised around its typical level: detail survives,
    // the hue does not.
    const detail = clamp(dot(base, vec3(0.2126, 0.7152, 0.0722)).mul(3.2), 0.35, 1.5);
    let paint = vec3(tint.r, tint.g, tint.b);
    if (camo) {
      // Pick the plane the face is most aligned with; 5 m per tile, as on the kit.
      const n = abs(normalLocal);
      const p = positionLocal.mul(0.2);
      const st = select(n.x.greaterThan(0.6), p.zy, select(n.z.greaterThan(0.6), p.xy, p.xz));
      const cell = clamp(fract(st), 0.004, 0.996);
      const id = MAT.camo, col = id % ATLAS_COLS, row = ATLAS_ROWS - 1 - Math.floor(id / ATLAS_COLS);
      paint = texture(atlas, vec2(cell.x.add(col).div(ATLAS_COLS), cell.y.add(row).div(ATLAS_ROWS))).rgb;
    }
    nm.colorNode = paint.mul(detail);
    m.material = nm;
  });
  return root;
}

export async function placePropShowcase(app) {
  const base = app.structures?.base;
  if (!base) return null;
  const bp = base.position;
  const group = new THREE.Group();
  group.name = "PropShowcase";
  app.scene.add(group);
  const mat = rtsObjectMaterial();

  // Offsets from the base point in world metres; the HQ's door faces -Z.
  // Everything is collected first, pads are levelled, then things are placed —
  // so no pad's rim tilts the ground under a piece already standing.
  const items = [];
  const add = (obj, dx, dz, rotY, scale = 1, clear = 0, pad = false) => items.push({ obj, dx, dz, rotY, scale, clear, pad });
  // A kit piece, with its painted markings (if any) riding as a child.
  const kit = (geo) => {
    const m = new THREE.Mesh(geo, mat);
    const st = stencilMesh(geo.userData.stencil);
    if (st) m.add(st);
    return m;
  };

  // Built in code. `pad`: level the ground to the piece's own footprint, turned
  // with it — how a building sits on a slope (the HQ has one too).
  // The camera looks up +Z, so a door on a piece's +Z end faces it at rotY ≈ PI.
  add(kit(buildGuardTower()), -30, -10, 0.3, 1, 7, true);
  add(kit(buildFuelDump()), -26, 2, 0.3, 1, 5, true);
  add(kit(buildGunPit()), 13, -22, Math.PI, 1, 6, true);
  add(kit(buildCrateStack()), 15, 16, -0.2, 1, 4, true);
  add(kit(buildTent()), 34, 4, Math.PI / 2 + 0.05, 1, 11, true);
  add(kit(buildTent({ medic: true, seed: 19 })), 50, -50, Math.PI / 2 - 0.05, 1, 11, true);
  add(kit(buildConexYard()), -34, 14, 0.2, 1, 7, true);
  add(kit(buildConex({ mat: MAT.camo })), -26, 22, Math.PI - 0.4, 1, 4, true);
  add(kit(buildContainer({ mat: MAT.camo })), -44, -22, Math.PI + 0.35, 1, 7, true);
  add(kit(buildContainer({ seed: 31 })), -44, -34, Math.PI - 0.25, 1, 7, true);
  add(kit(buildContainer({ seed: 37, mat: MAT.metal })), -34, -40, Math.PI / 2 + 0.05, 1, 7, true);
  add(kit(buildRadioStation()), -20, -50, 0.4, 1, 9, true);
  add(buildMinesSign(), 3, -36, Math.PI + 0.1);
  add(buildBillboard({ face: "firebase" }), -9, -27, Math.PI + 0.15, 1, 3.5);
  add(buildBillboard({ face: "entering", width: 5, posts: 4 }), 9, -40, Math.PI - 0.2, 1, 4);
  add(buildPostSign({ face: "danger" }), -3, -36, Math.PI);
  add(buildPostSign({ face: "helipad", width: 1.4, clear: 1.3 }), 4, -24, Math.PI - 0.3);

  // The old game's models, for comparison.
  const loader = getSharedGltfLoader();
  const glb = async (name) => (await loader.loadAsync(`/models/rts/${name}_compressed.glb`)).scene;
  // The old tower and tent are retired (the kit's are better); the container
  // and the radio station stay, the container repainted out of its orange.
  try {
    add(repaint(await glb("container_001"), { color: "#58623a" }), -21, 9, 0.1, S, 6, true);
    add(repaint(await glb("container_001"), { camo: true }), -54, -28, Math.PI + 0.3, S, 6, true);
    add(await glb("radiostation_001"), 22, -12, -0.3, S, 7, true);
    const trap = await glb("hedgehog_001");
    for (let k = 0; k < 5; k++) add(k ? trap.clone(true) : trap, -10 + k * 5, -30 + (k % 2) * 1.5, k * 0.7, S, 2.5);
  } catch (e) {
    console.warn("[showcase] old models failed to load:", e);
  }

  // 1) Level a pad under every piece that asks for one.
  const box = new THREE.Box3();
  for (const it of items) {
    it.x = bp.x + it.dx; it.z = bp.z + it.dz;
    it.obj.scale.setScalar(it.scale);
    it.obj.rotation.y = it.rotY;
    if (!it.pad || !app.flattenRect) continue;
    // Footprint in the piece's own frame (unscaled, unrotated), plus half a
    // metre of apron.
    box.makeEmpty();
    it.obj.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(it.obj.matrixWorld).invert();
    it.obj.traverse((m) => {
      if (!m.isMesh) return;
      m.geometry.computeBoundingBox();
      box.union(m.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)));
    });
    let hx = ((box.max.x - box.min.x) * it.scale) / 2 + 0.5, hz = ((box.max.z - box.min.z) * it.scale) / 2 + 0.5;
    let cx = ((box.max.x + box.min.x) * it.scale) / 2, cz = ((box.max.z + box.min.z) * it.scale) / 2;
    // A piece that declares where it stands (guys, ropes and masts reach
    // further than its base) is levelled to that instead.
    const fp = it.obj.geometry?.userData?.footprint;
    if (fp) { hx = fp.hx * it.scale; hz = fp.hz * it.scale; cx = fp.cx * it.scale; cz = fp.cz * it.scale; }
    const c = Math.cos(it.rotY), s = Math.sin(it.rotY);
    const px = it.x + cx * c + cz * s, pz = it.z - cx * s + cz * c;
    // Level to the mean of the ground under the four corners and the centre:
    // cut on the high side, fill on the low, as a bulldozer would.
    let y = app.getWorldHeight(px, pz), n = 1;
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const lx = sx * hx, lz = sz * hz;
      y += app.getWorldHeight(px + lx * c + lz * s, pz - lx * s + lz * c); n++;
    }
    await app.flattenRect(px, pz, hx, hz, y / n, { rotY: it.rotY, rim: 3 });
    // The pad takes its footprint back from the map's props (rocks), as the
    // HQ does: any prop whose bounding circle reaches into the rectangle.
    const ps = app.propStore;
    if (ps?.instances) {
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
  }
  // 2) Then stand everything on the final ground.
  for (const it of items) {
    it.obj.position.set(it.x, app.getWorldHeight(it.x, it.z) - (it.pad ? 0.02 : 0.05), it.z);
    it.obj.traverse((m) => { if (m.isMesh) m.castShadow = m.receiveShadow = true; });
    group.add(it.obj);
    if (it.clear) app.clearVegetation?.(it.x, it.z, it.clear + 2, { grass: it.clear });
  }
  return group;
}
