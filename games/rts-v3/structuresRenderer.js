// Structures RENDERER — procedural geometry for the base and enemy turrets.
// Mirrors unitRenderer: all visuals here, logic stays mesh-free in structures.js.
import * as THREE from "three";
import { materialColor } from "three/tsl";
import { makeHealthBar } from "./healthBar.js";
import { makeBloomMaterial, BLOOM } from "./bloom.js";

export const structureByMesh = new WeakMap();

/**
 * Structures never move, and that makes them a trap for scene-level fog.
 *
 * three's NodeMaterialObserver only re-uploads a render object's uniforms when
 * the material carries a node, the mesh is skinned, or its world matrix /
 * material properties changed. Everything else is treated as static and keeps
 * the uniform buffer it was first rendered with — including the scene fogNode's
 * uniforms. A plain material on a never-moving mesh therefore FREEZES the fog it
 * booted with: toggle height fog off and the base and turret bodies stay stuck
 * in the old mist while the terrain and the (moving) units clear up.
 *
 * A node material with a `colorNode` flips the observer to "always refresh".
 * `materialColor` just reads the material's own color uniform, so `.color` still
 * works exactly as before.
 */
const _standardMat = (params) => {
  const m = new THREE.MeshStandardNodeMaterial(params);
  m.colorNode = materialColor;
  return m;
};

const _matBody = () => _standardMat({ color: 0x5a6472, roughness: 0.85, metalness: 0.15 });
const _matDark = () => _standardMat({ color: 0x333a45, roughness: 0.9, metalness: 0.2 });
const _matEnemy = () => _standardMat({ color: 0x6e4a4a, roughness: 0.85, metalness: 0.2 });

/** Procedural player HQ: platform, main block, corner pillars, glowing beacon. */
function buildBase() {
  const g = new THREE.Group();
  const body = _matBody(), dark = _matDark();

  const platform = new THREE.Mesh(new THREE.CylinderGeometry(15, 16.5, 1.6, 24), dark);
  platform.position.y = 0.8;
  g.add(platform);

  const block = new THREE.Mesh(new THREE.BoxGeometry(16, 9, 16), body);
  block.position.y = 6;
  g.add(block);

  const upper = new THREE.Mesh(new THREE.BoxGeometry(10, 4, 10), body);
  upper.position.y = 12.5;
  g.add(upper);

  for (const [px, pz] of [[-7.5, -7.5], [7.5, -7.5], [-7.5, 7.5], [7.5, 7.5]]) {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.6, 13, 10), dark);
    pillar.position.set(px, 6.5, pz);
    g.add(pillar);
  }

  // Beacon mast + glowing tip (writes to the emissive buffer → blooms).
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 6, 8), dark);
  mast.position.y = 17.5;
  g.add(mast);
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(1.1, 14, 10),
    makeBloomMaterial({ color: 0x64d2ff, blending: THREE.NormalBlending, depthWrite: true, transparent: false }, BLOOM.beacon),
  );
  beacon.position.y = 21;
  g.add(beacon);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

/** Unarmed practice target — bright so it's easy to spot near the base. */
function buildTrainingDummy() {
  const g = new THREE.Group();
  const body = _matEnemy();
  const mark = _standardMat({ color: 0xff6a3a, roughness: 0.75, metalness: 0.1 });

  const pad = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 0.5, 12), _matDark());
  pad.position.y = 0.25;
  g.add(pad);

  const crate = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), body);
  crate.position.y = 2;
  g.add(crate);

  const stripe = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.5, 3.1), mark);
  stripe.position.y = 2.8;
  g.add(stripe);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

/** Procedural enemy turret: base, rotating head + barrel, glowing eye. */
function buildTurret() {
  const g = new THREE.Group();
  const body = _matEnemy(), dark = _matDark();

  const pad = new THREE.Mesh(new THREE.CylinderGeometry(4, 4.6, 1.2, 16), dark);
  pad.position.y = 0.6;
  g.add(pad);

  const column = new THREE.Mesh(new THREE.CylinderGeometry(2, 2.4, 3.5, 12), body);
  column.position.y = 2.8;
  g.add(column);

  // Head is a child group so we can yaw it toward the target.
  const head = new THREE.Group();
  head.position.y = 5.2;
  g.add(head);

  const housing = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.4, 3.6), body);
  head.add(housing);

  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.42, 5, 10), dark);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.2, 2.6); // points along +Z of the head
  head.add(barrel);

  const eye = new THREE.Mesh(
    new THREE.SphereGeometry(0.45, 12, 8),
    makeBloomMaterial({ color: 0xff4a3a, blending: THREE.NormalBlending, depthWrite: true, transparent: false }, BLOOM.beacon),
  );
  eye.position.set(0, 0.95, 1.1);
  head.add(eye);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { group: g, head, muzzleLocal: new THREE.Vector3(0, 0.2, 5.1) };
}

export function createStructuresRenderer({ app, structures }) {
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

    const bar = makeHealthBar(s.type.barWidth ?? 6);
    scene.add(group, bar.group);
    roots.push(group);
    views.set(s, { group, head, muzzleLocal, bar });
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
        v.bar.group.visible = false;
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

      const frac = THREE.MathUtils.clamp(s.hp / s.maxHp, 0, 1);
      v.bar.set(
        frac, camera,
        s.position.x, s.position.y + (s.type.barY ?? 10), s.position.z,
        s.team === "enemy",
      );
    }
  }

  return {
    roots,
    structureByMesh,
    muzzleOf,
    sync,
    dispose() {
      for (const v of views.values()) scene.remove(v.group, v.bar.group);
      views.clear();
    },
  };
}
