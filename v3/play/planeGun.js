import * as THREE from "three";

const GUN_FIRE_RATE = 12;
const GUN_BULLET_SPEED = 240;
const GUN_BULLET_MAX_DIST = 600;
const GUN_BULLET_SIZE = 0.7;
const GUN_BULLET_POOL = 64;
const GUN_TRACER_COLOR = 0xfff0a0;

const _bFwd = new THREE.Vector3();
const _bMuz = new THREE.Vector3();
const _bToCam = new THREE.Vector3();
const _bRight = new THREE.Vector3();
const _bPerp = new THREE.Vector3();
const _bMat4 = new THREE.Matrix4();
const _bStep = new THREE.Vector3();

/** Tracer bullet pool — v2 playMode port. */
export function createPlaneGun(scene) {
  const geo = new THREE.PlaneGeometry(0.18, 1.4);
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(GUN_TRACER_COLOR),
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const group = new THREE.Group();
  group.frustumCulled = false;
  scene.add(group);

  const pool = [];
  for (let i = 0; i < GUN_BULLET_POOL; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    m.visible = false;
    m.renderOrder = 11;
    group.add(m);
    pool.push({
      mesh: m,
      pos: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      dist: 0,
      alive: false,
    });
  }

  let cooldown = 0;
  let muzzleIdx = 0;
  const muzzleOffsets = [];

  function setupMuzzles(inner) {
    muzzleOffsets.length = 0;
    if (!inner) return;
    inner.updateMatrixWorld(true);
    const wingBox = new THREE.Box3().setFromObject(inner);
    if (wingBox.isEmpty()) return;
    const wbSz = new THREE.Vector3();
    wingBox.getSize(wbSz);
    const zFront = wingBox.min.z + wbSz.z * 0.05;
    const wingHalfX = wbSz.x * 0.5;
    const muzzleHalfSpan = wingHalfX * 0.42;
    const cxW = (wingBox.min.x + wingBox.max.x) * 0.5;
    const yMid = (wingBox.min.y + wingBox.max.y) * 0.5;
    const tmpW = new THREE.Vector3();
    tmpW.set(cxW - muzzleHalfSpan, yMid, zFront);
    inner.worldToLocal(tmpW);
    muzzleOffsets.push(tmpW.clone());
    tmpW.set(cxW + muzzleHalfSpan, yMid, zFront);
    inner.worldToLocal(tmpW);
    muzzleOffsets.push(tmpW.clone());
  }

  function fire(origin, dir) {
    for (const b of pool) {
      if (!b.alive) {
        b.alive = true;
        b.pos.copy(origin);
        b.dir.copy(dir).normalize();
        b.dist = 0;
        b.mesh.visible = true;
        return;
      }
    }
  }

  function update(dt, camera, firing, planeRoot, planeInner) {
    if (cooldown > 0) cooldown -= dt;
    if (
      firing &&
      muzzleOffsets.length > 0 &&
      planeRoot &&
      planeInner &&
      cooldown <= 0
    ) {
      planeInner.updateMatrixWorld(true);
      _bFwd.set(0, 0, -1).applyQuaternion(planeRoot.quaternion);
      const muz = muzzleOffsets[muzzleIdx];
      muzzleIdx = (muzzleIdx + 1) % muzzleOffsets.length;
      _bMuz.copy(muz);
      planeInner.localToWorld(_bMuz);
      fire(_bMuz, _bFwd);
      cooldown = 1 / GUN_FIRE_RATE;
    }

    for (const b of pool) {
      if (!b.alive) continue;
      _bStep.copy(b.dir).multiplyScalar(GUN_BULLET_SPEED * dt);
      b.pos.add(_bStep);
      b.dist += GUN_BULLET_SPEED * dt;
      if (b.dist > GUN_BULLET_MAX_DIST) {
        b.alive = false;
        b.mesh.visible = false;
        continue;
      }
      _bToCam.subVectors(camera.position, b.pos);
      _bRight.crossVectors(b.dir, _bToCam);
      if (_bRight.lengthSq() < 1e-6) _bRight.set(1, 0, 0);
      else _bRight.normalize();
      _bPerp.crossVectors(_bRight, b.dir).normalize();
      const sz = GUN_BULLET_SIZE;
      _bRight.multiplyScalar(sz);
      const dScaled = _bStep.copy(b.dir).multiplyScalar(sz);
      _bPerp.multiplyScalar(sz);
      _bMat4.makeBasis(_bRight, dScaled, _bPerp);
      _bMat4.setPosition(b.pos);
      b.mesh.matrix.copy(_bMat4);
    }
  }

  function clear() {
    for (const b of pool) {
      b.alive = false;
      b.mesh.visible = false;
    }
    cooldown = 0;
  }

  function dispose() {
    clear();
    scene.remove(group);
    geo.dispose();
    mat.dispose();
  }

  return { setupMuzzles, update, clear, dispose };
}
