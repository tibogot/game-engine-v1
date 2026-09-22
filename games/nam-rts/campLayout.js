// The camp's dressing — placed at every boot (?camp=0 turns it off), through
// placedObjects.js: each piece on a levelled pad, blocking nav on its real
// footprint, giving cover, merged into a few draws.
//
// Offsets are from the base point, in world metres; the HQ's door faces -Z and
// the road runs from it south to the gate (campPerimeter.js) — kept clear, as
// are the rally point (0, -36) and the flag (30, -16). The camera looks up +Z,
// so a door on a piece's +Z end faces it at rotY ≈ PI.
import * as THREE from "three";
import {
  buildConex, buildConexYard, buildContainer, buildCrateStack, buildFuelDump, buildGuardTower, buildGunPit, buildMinesSign, buildTent,
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
export function repaint(root, { color = null, camo = false } = {}) {
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

/** A kit piece, with its painted markings (if any) riding as a child. */
function kit(geo) {
  const m = new THREE.Mesh(geo, rtsObjectMaterial());
  const st = stencilMesh(geo.userData.stencil);
  if (st) m.add(st);
  return m;
}

/** Place the camp's pieces with `placed` (createPlacedObjects). */
export async function placeCampLayout(app, placed) {
  const base = app.structures?.base;
  if (!base) return;
  const bp = base.position;
  const items = [];
  // clear: metres of vegetation cleared round it. Pieces with a pad block nav
  // and give cover; signs and traps stand on the ground as it is.
  const add = (obj, dx, dz, rotY, o = {}) => items.push({ obj, x: bp.x + dx, z: bp.z + dz, rotY, ...o });

  // West: stores and the motor-pool side.
  add(kit(buildGuardTower()), -30, -10, 0.3, { clear: 7 });
  add(kit(buildFuelDump()), -26, 2, 0.3, { clear: 5 });
  add(kit(buildConexYard()), -34, 14, 0.2, { clear: 7 });
  add(kit(buildConex({ mat: MAT.camo })), -26, 22, Math.PI - 0.4, { clear: 4 });
  add(kit(buildContainer({ mat: MAT.camo })), -44, -22, Math.PI + 0.35, { clear: 7 });
  add(kit(buildContainer({ seed: 31 })), -44, -34, Math.PI - 0.25, { clear: 7 });
  add(kit(buildContainer({ seed: 37, mat: MAT.metal })), -34, -40, Math.PI / 2 + 0.05, { clear: 7 });
  // East: the gun pit covering the road, living and aid tents.
  add(kit(buildGunPit()), 13, -22, Math.PI, { clear: 6 });
  add(kit(buildCrateStack()), 15, 16, -0.2, { clear: 4 });
  add(kit(buildTent()), 34, 4, Math.PI / 2 + 0.05, { clear: 11 });
  add(kit(buildTent({ medic: true, seed: 19 })), 30, -36, Math.PI / 2 - 0.05, { clear: 11 });
  // Signs: inside on the road, and at the gate for whoever arrives.
  const sign = { pad: false, nav: false, cover: false };
  add(buildBillboard({ face: "firebase" }), -9, -27, Math.PI + 0.15, { ...sign, clear: 3.5 });
  add(buildPostSign({ face: "helipad", width: 1.4, clear: 1.3 }), 9, -27, Math.PI - 0.3, sign);
  add(buildBillboard({ face: "entering", width: 5, posts: 4 }), 18, -80, Math.PI - 0.2, { ...sign, clear: 4 });
  add(buildPostSign({ face: "danger" }), -9, -79, Math.PI, { ...sign, clear: 1.5 });
  add(buildMinesSign(), -22, -80, Math.PI + 0.1, { ...sign, clear: 1.5 });

  // Imported models: the container repainted out of its orange, tank traps
  // staggered across the approach outside the wire. (No radio station: that is
  // the builder's Radio Station, rtsBuildables.js, not dressing.)
  const loader = getSharedGltfLoader();
  const glb = async (name) => (await loader.loadAsync(`/models/rts/${name}_compressed.glb`)).scene;
  try {
    add(repaint(await glb("container_001"), { color: "#58623a" }), -21, 9, 0.1, { scale: S, clear: 6, merge: false });
    add(repaint(await glb("container_001"), { camo: true }), -54, -28, Math.PI + 0.3, { scale: S, clear: 6, merge: false });
    const trap = await glb("hedgehog_001");
    const traps = [[-16, -84], [-10, -87], [-4, -84], [14, -86], [20, -83], [26, -86]];
    traps.forEach(([dx, dz], k) => add(k ? trap.clone(true) : trap, dx, dz, k * 0.7,
      { scale: S, clear: 2.5, pad: false, nav: false, cover: true, merge: false }));
  } catch (e) {
    console.warn("[camp] models failed to load:", e);
  }

  await placed.place(items);
}
