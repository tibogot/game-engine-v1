// Prop showcase — DEV ONLY, off unless the URL says ?showcase=1.
//
// Places every prop being judged around the player's HQ, so the pieces can be
// looked at in the game from both cameras before they go into the editor as
// placeable types. Nothing here is gameplay: no nav, no cover, no saving.
import * as THREE from "three";
import { buildCrateStack, buildFuelDump, buildGuardTower, buildGunPit, buildMinesSign } from "../../v3/render/objects/rtsFirebaseProps.js";
import { buildBillboard, buildPostSign } from "../../v3/render/objects/rtsSigns.js";
import { rtsObjectMaterial } from "../../v3/render/objects/rtsObjectProps.js";
import { getSharedGltfLoader } from "../../v2/core/foliage/glbLoader.js";

/** Real size x 1.3, like the units (unitTypes.js RTS_SCALE). */
const S = 1.3;

export async function placePropShowcase(app) {
  const base = app.structures?.base;
  if (!base) return null;
  const bp = base.position;
  const group = new THREE.Group();
  group.name = "PropShowcase";
  app.scene.add(group);
  const mat = rtsObjectMaterial();

  // Offsets from the base point in world metres; the HQ's door faces -Z.
  const add = (obj, dx, dz, rotY, scale = 1, clear = 0) => {
    const x = bp.x + dx, z = bp.z + dz;
    obj.scale.setScalar(scale);
    obj.position.set(x, app.getWorldHeight(x, z) - 0.05, z);
    obj.rotation.y = rotY;
    obj.traverse((m) => { if (m.isMesh) m.castShadow = m.receiveShadow = true; });
    group.add(obj);
    if (clear) app.clearVegetation?.(x, z, clear + 2, { grass: clear });
  };
  const kit = (geo) => new THREE.Mesh(geo, mat);

  // Built in code.
  add(kit(buildGuardTower()), -30, -10, 0.3, 1, 7);
  add(kit(buildFuelDump()), -26, 2, 0.3, 1, 5);
  add(kit(buildGunPit()), 13, -22, Math.PI, 1, 6);
  add(kit(buildCrateStack()), 15, 16, -0.2, 1, 4);
  add(buildMinesSign(), 3, -36, Math.PI + 0.1);
  add(buildBillboard({ face: "firebase" }), -9, -27, Math.PI + 0.15, 1, 3.5);
  add(buildBillboard({ face: "entering", width: 5, posts: 4 }), 9, -40, Math.PI - 0.2, 1, 4);
  add(buildPostSign({ face: "danger" }), -3, -36, Math.PI);
  add(buildPostSign({ face: "helipad", width: 1.4, clear: 1.3 }), 4, -24, Math.PI - 0.3);

  // The old game's models, for comparison.
  const loader = getSharedGltfLoader();
  const glb = async (name) => (await loader.loadAsync(`/models/rts/${name}_compressed.glb`)).scene;
  try {
    add(await glb("tower_001"), -20, -8, 0.4, S, 7);
    add(await glb("tent_001"), 21, 6, Math.PI / 2, S, 9);
    add(await glb("container_001"), -21, 9, 0.1, S, 6);
    add(await glb("radiostation_001"), 22, -12, -0.3, S, 7);
    const trap = await glb("hedgehog_001");
    for (let k = 0; k < 5; k++) add(k ? trap.clone(true) : trap, -10 + k * 5, -30 + (k % 2) * 1.5, k * 0.7, S, 2.5);
  } catch (e) {
    console.warn("[showcase] old models failed to load:", e);
  }
  return group;
}
