// Structures RENDERER — procedural geometry for the base and enemy turrets.
// Mirrors unitRenderer: all visuals here, logic stays mesh-free in structures.js.
//
// Every structure is built from a handful of boxes and cylinders, and it NEVER
// changes shape. So the parts are MERGED into one geometry per rigid piece, with
// the per-part color baked into a vertex-color attribute: the base went from 9
// draws to 2, a turret from 5 to 3. Only pieces that must move independently stay
// separate — the turret head (it yaws at its target) and the glowing beacon/eye
// (a different, emissive-MRT material).
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { materialColor } from "three/tsl";
import { makeBloomMaterial, BLOOM } from "./bloom.js";

export const structureByMesh = new WeakMap();

const C_BODY = 0x5a6472;
const C_DARK = 0x333a45;
const C_ENEMY = 0x6e4a4a;
const C_MARK = 0xff6a3a;

/**
 * The shared material for every merged structure piece.
 *
 * `vertexColors` carries the per-part color that used to live in one material per
 * part (three multiplies colorNode by the vertex color).
 *
 * The `colorNode` is NOT cosmetic: structures never move, and three's
 * NodeMaterialObserver only re-uploads a render object's uniforms when the
 * material carries a node, the mesh is skinned, or its matrix / material
 * properties changed. A plain material on a never-moving mesh therefore FREEZES
 * the scene fogNode uniforms it first rendered with — toggle height fog off and
 * the base stays stuck in the old mist. A colorNode flips the observer to "always
 * refresh"; `materialColor` just reads the material's own (white) color uniform.
 */
function makeStructureMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff, // white: the vertex colors ARE the color
    roughness: 0.87,
    metalness: 0.18,
    vertexColors: true,
  });
  m.colorNode = materialColor;
  return m;
}

/** Tag every vertex of `geo` with `hex`, so merged parts keep their colors. */
function paint(geo, hex) {
  const c = new THREE.Color(hex); // already in linear working space
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

/**
 * Merge painted parts into one shadow-casting mesh.
 *
 * mergeGeometries returns null on ANY attribute mismatch, so an untagged part
 * would silently delete the whole structure — assert instead of shipping a
 * missing base.
 */
function mergePainted(parts, name) {
  const geo = mergeGeometries(parts, false);
  if (!geo) throw new Error(`[rts-v3] ${name}: mergeGeometries failed (attribute mismatch)`);
  const mesh = new THREE.Mesh(geo, makeStructureMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Procedural player HQ: platform, main block, corner pillars, glowing beacon. */
function buildBase() {
  const g = new THREE.Group();

  const parts = [
    paint(new THREE.CylinderGeometry(15, 16.5, 1.6, 24).translate(0, 0.8, 0), C_DARK),
    paint(new THREE.BoxGeometry(16, 9, 16).translate(0, 6, 0), C_BODY),
    paint(new THREE.BoxGeometry(10, 4, 10).translate(0, 12.5, 0), C_BODY),
    paint(new THREE.CylinderGeometry(0.35, 0.35, 6, 8).translate(0, 17.5, 0), C_DARK), // beacon mast
  ];
  for (const [px, pz] of [[-7.5, -7.5], [7.5, -7.5], [-7.5, 7.5], [7.5, 7.5]]) {
    parts.push(paint(new THREE.CylinderGeometry(1.3, 1.6, 13, 10).translate(px, 6.5, pz), C_DARK));
  }
  g.add(mergePainted(parts, "base"));

  // Beacon tip stays its own mesh — emissive MRT material (it blooms).
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(1.1, 14, 10),
    makeBloomMaterial({ color: 0x64d2ff, blending: THREE.NormalBlending, depthWrite: true, transparent: false }, BLOOM.beacon),
  );
  beacon.position.y = 21;
  beacon.castShadow = true;
  g.add(beacon);

  return g;
}

/** Unarmed practice target — bright so it's easy to spot near the base. */
function buildTrainingDummy() {
  const g = new THREE.Group();
  g.add(mergePainted([
    paint(new THREE.CylinderGeometry(2.2, 2.6, 0.5, 12).translate(0, 0.25, 0), C_DARK),
    paint(new THREE.BoxGeometry(3, 3, 3).translate(0, 2, 0), C_ENEMY),
    paint(new THREE.BoxGeometry(3.1, 0.5, 3.1).translate(0, 2.8, 0), C_MARK),
  ], "trainingDummy"));
  return g;
}

/** Procedural enemy turret: base, rotating head + barrel, glowing eye. */
function buildTurret() {
  const g = new THREE.Group();

  g.add(mergePainted([
    paint(new THREE.CylinderGeometry(4, 4.6, 1.2, 16).translate(0, 0.6, 0), C_DARK),
    paint(new THREE.CylinderGeometry(2, 2.4, 3.5, 12).translate(0, 2.8, 0), C_ENEMY),
  ], "turret"));

  // Head is a child group so we can yaw it toward the target — so its geometry
  // merges separately from the static pedestal.
  const head = new THREE.Group();
  head.position.y = 5.2;
  g.add(head);

  const barrel = paint(new THREE.CylinderGeometry(0.36, 0.42, 5, 10), C_DARK);
  barrel.rotateX(Math.PI / 2);          // lay it along +Z
  barrel.translate(0, 0.2, 2.6);        // …pointing out of the head
  head.add(mergePainted([
    paint(new THREE.BoxGeometry(3.4, 2.4, 3.6), C_ENEMY),
    barrel,
  ], "turretHead"));

  const eye = new THREE.Mesh(
    new THREE.SphereGeometry(0.45, 12, 8),
    makeBloomMaterial({ color: 0xff4a3a, blending: THREE.NormalBlending, depthWrite: true, transparent: false }, BLOOM.beacon),
  );
  eye.position.set(0, 0.95, 1.1);
  eye.castShadow = true;
  head.add(eye);

  return { group: g, head, muzzleLocal: new THREE.Vector3(0, 0.2, 5.1) };
}

export function createStructuresRenderer({ app, structures, healthBars }) {
  const { scene } = app;
  const views = new Map();
  const roots = [];

  for (const s of structures.list) {
    let group, head = null, muzzleLocal = null;
    if (s.typeKey === "base") {
      group = buildBase();
    } else if (s.typeKey === "trainingDummy") {
      group = buildTrainingDummy();
    } else {
      const t = buildTurret();
      group = t.group; head = t.head; muzzleLocal = t.muzzleLocal;
    }
    group.position.set(s.position.x, s.position.y, s.position.z);
    group.traverse((o) => { if (o.isMesh) structureByMesh.set(o, s); });

    scene.add(group);
    roots.push(group);
    views.set(s, { group, head, muzzleLocal });
  }

  const _muzzleWorld = new THREE.Vector3();

  /** World-space muzzle point of a turret (where its tracer should start). */
  function muzzleOf(s) {
    const v = views.get(s);
    if (!v?.head || !v.muzzleLocal) {
      return _muzzleWorld.set(s.position.x, s.position.y + 6, s.position.z).clone();
    }
    v.head.updateMatrixWorld(true);
    return _muzzleWorld.copy(v.muzzleLocal).applyMatrix4(v.head.matrixWorld).clone();
  }

  function sync(dt, camera) {
    for (const s of structures.list) {
      const v = views.get(s);
      if (!v) continue;

      if (!s.alive) {
        v.group.visible = false;
        continue;
      }

      v.group.position.set(s.position.x, s.position.y, s.position.z);

      // Turret head tracks its target.
      if (v.head) {
        if (s.target?.alive) {
          const dx = s.target.position.x - s.position.x;
          const dz = s.target.position.z - s.position.z;
          s.turretYaw = Math.atan2(dx, dz);
        }
        v.head.rotation.y = s.turretYaw;
      }

      // Health bar — one instance in the shared field (see healthBar.js).
      healthBars.add(
        s.position.x, s.position.y + (s.type.barY ?? 10), s.position.z,
        s.type.barWidth ?? 6,
        s.hp / s.maxHp,
        s.team === "enemy",
        camera,
      );
    }
  }

  return {
    roots,
    structureByMesh,
    muzzleOf,
    sync,
    dispose() {
      for (const v of views.values()) scene.remove(v.group);
      views.clear();
    },
  };
}
