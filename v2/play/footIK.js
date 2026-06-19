// footIK.js
// Foot planting: after the animation mixer sets bone poses each frame,
// this system:
//   1. Reads the world positions of both foot bones.
//   2. Raycasts down to find the actual ground under each foot.
//   3. Returns a hip-lift offset so neither foot clips through the surface.
//   4. Tilts each ankle bone to follow the terrain slope.
//
// Call buildFootIK(model) once after loading the character.
// Call FootIKSolver.update() immediately after charMixer.update().

import * as THREE from "three";

// Reusable temporaries — never allocated per frame.
const _wp    = new THREE.Vector3();
const _n     = new THREE.Vector3();
const _up    = new THREE.Vector3(0, 1, 0);
const _qw    = new THREE.Quaternion(); // world tilt
const _qp    = new THREE.Quaternion(); // parent world rotation (decomposed, no scale)
const _qi    = new THREE.Quaternion(); // scratch / inverse
const _dpos  = new THREE.Vector3();   // decompose scratch
const _dscl  = new THREE.Vector3();   // decompose scratch

// How far above rootY to start the ground-probe raycast.
const CAST_ABOVE   = 1.2;    // metres
const CAST_DIST    = 2.5;    // metres (reaches rootY − 1.3, well below any terrain)

// Common foot bone names across Mixamo, Unity humanoid, Rigify, and generic rigs.
const FOOT_CANDIDATES = {
  left: [
    "mixamorigLeftFoot", "LeftFoot", "foot.L", "DEF-foot.L",
    "Foot_L", "foot_l", "FootLeft", "Left_Foot", "BoneFootL",
  ],
  right: [
    "mixamorigRightFoot", "RightFoot", "foot.R", "DEF-foot.R",
    "Foot_R", "foot_r", "FootRight", "Right_Foot", "BoneFootR",
  ],
};

function findBone(model, candidates) {
  // Exact name match first.
  for (const name of candidates) {
    const b = model.getObjectByName(name);
    if (b) return b;
  }
  // Case-insensitive fallback across actual Bone objects.
  const lowers = candidates.map(n => n.toLowerCase());
  let hit = null;
  model.traverse(o => {
    if (hit || !o.isBone || !o.name) return;
    const nm = o.name.toLowerCase();
    if (lowers.some(l => nm === l)) hit = o;
  });
  return hit;
}

/**
 * Call once after loading the character GLTF model.
 * Returns an ikData object to pass into FootIKSolver.
 */
export function buildFootIK(model) {
  const leftFoot  = findBone(model, FOOT_CANDIDATES.left);
  const rightFoot = findBone(model, FOOT_CANDIDATES.right);

  if (!leftFoot || !rightFoot) {
    // Log every bone so the caller can identify the right names.
    const bones = [];
    model.traverse(o => { if (o.isBone && o.name) bones.push(o.name); });
    console.warn(
      "[FootIK] Foot bones not found — IK disabled.\n" +
      "Available bones:\n  " + bones.join("\n  "),
    );
    return { ready: false, leftFoot: null, rightFoot: null };
  }

  console.log("[FootIK] Ready — L:", leftFoot.name, "/ R:", rightFoot.name);
  return { ready: true, leftFoot, rightFoot };
}

export class FootIKSolver {
  constructor({ ready, leftFoot, rightFoot }) {
    this.ready  = ready;
    this._lf    = leftFoot;
    this._rf    = rightFoot;
    this._lift  = 0;   // smoothed hip-lift value
    this._blend = 0;   // 0 = airborne / IK off, 1 = grounded / IK full
  }

  /**
   * Call immediately after charMixer.update(), before rendering.
   *
   * @param {number} dt  — frame delta in seconds
   * @param {(x:number,z:number)=>number} getTerrainHeight
   * @param {object|null} collider  — must expose raycastDown(x,y,z,maxDist)
   * @param {boolean} grounded
   * @param {number} rootY  — current charRoot.position.y (capsule bottom, feet level)
   * @returns {number}  Y offset to ADD to charRoot.position.y
   */
  update(dt, getTerrainHeight, collider, grounded, rootY = 0) {
    if (!this.ready) return 0;

    // Blend IK weight: fade in when grounded, fade out when airborne.
    const blendTarget = grounded ? 1 : 0;
    this._blend += (blendTarget - this._blend) * Math.min(1, dt * 7);
    const b = this._blend;
    if (b < 0.02) { this._lift = 0; return 0; }

    // Read foot world positions: X,Z for probe location, Y as one lift reference.
    this._lf.updateWorldMatrix(true, false);
    this._rf.updateWorldMatrix(true, false);
    _wp.setFromMatrixPosition(this._lf.matrixWorld);
    const lfX = _wp.x, lfY = _wp.y, lfZ = _wp.z;
    _wp.setFromMatrixPosition(this._rf.matrixWorld);
    const rfX = _wp.x, rfY = _wp.y, rfZ = _wp.z;

    // Ground height and surface normal under each foot (cast from fixed height).
    const lHit = this._groundAt(lfX, rootY, lfZ, getTerrainHeight, collider);
    const rHit = this._groundAt(rfX, rootY, rfZ, getTerrainHeight, collider);

    // Lift: how much is each foot's ground above the character's feet level (rootY).
    // Physics places rootY at the slope under the character center; a foot that
    // sits on a higher part of the slope needs exactly (groundY - rootY) of hip lift.
    const liftL = Math.max(0, lHit.y - rootY);
    const liftR = Math.max(0, rHit.y - rootY);
    const liftTarget = Math.max(liftL, liftR);

    // Smooth: fast up (feet never clip), slower release (feels natural).
    const rate = liftTarget > this._lift ? 14 : 5;
    this._lift += (liftTarget - this._lift) * Math.min(1, dt * rate);
    const lift = this._lift * b;

    // Ankle tilt: rotate foot bones to follow the surface normal.
    this._tiltFoot(this._lf, lfX, lfZ, getTerrainHeight, b * 0.7, lHit.nx, lHit.ny, lHit.nz);
    this._tiltFoot(this._rf, rfX, rfZ, getTerrainHeight, b * 0.7, rHit.nx, rHit.ny, rHit.nz);

    // Debug — exposed for HUD display
    this._debug = { lY: lHit.y, rY: rHit.y, lNY: lHit.ny, rNY: rHit.ny, ref: rootY, lfY, rfY };

    return lift;
  }

  // x, rootY, z: foot X,Z + character root Y used as cast origin reference.
  _groundAt(x, rootY, z, getTerrainHeight, collider) {
    let gY = getTerrainHeight(x, z);
    let nx = 0, ny = 1, nz = 0;
    if (collider?.raycastDown) {
      // Cast from a fixed height above rootY so swing-phase foot bone elevation
      // doesn't influence where we look for the ground.
      const hit = collider.raycastDown(x, rootY + CAST_ABOVE, z, CAST_DIST);
      if (hit && hit.ny >= 0.4 && hit.y > gY) {
        gY = hit.y;
        if (hit.nx !== undefined) { nx = hit.nx; ny = hit.ny; nz = hit.nz; }
      }
    }
    return { y: gY, nx, ny, nz };
  }

  // Tilts the foot bone so the sole follows the surface normal.
  // snx/sny/snz: pre-computed surface normal from _groundAt (upward-facing).
  // Falls back to finite-difference when no raycast normal is available.
  _tiltFoot(footBone, x, z, getTerrainHeight, blend, snx, sny, snz) {
    if (!footBone.parent || blend < 0.01) return;

    if (snx !== undefined && sny < 0.98) {
      // Raycast gave us a real slope normal — use it directly.
      _n.set(snx, sny, snz);
    } else {
      // Finite-difference fallback (works when getTerrainHeight is a height field).
      const d  = 0.18;
      const yC = getTerrainHeight(x,     z    );
      const yX = getTerrainHeight(x + d, z    );
      const yZ = getTerrainHeight(x,     z + d);
      _n.set(yC - yX, d, yC - yZ).normalize();
      if (_n.y > 0.98) return; // nearly flat — skip
    }

    // World-space rotation: align world-up → surface normal.
    _qw.setFromUnitVectors(_up, _n);

    // Convert to foot bone's parent local space.
    // decompose() strips scale before extracting rotation, so this is correct
    // even when the character root has a non-unit scale (e.g. cm→m conversion).
    footBone.parent.updateWorldMatrix(true, false);
    footBone.parent.matrixWorld.decompose(_dpos, _qp, _dscl);
    _qi.copy(_qp).invert();
    _qw.premultiply(_qi).multiply(_qp); // _qw is now localTilt

    // Blend from identity → localTilt, then apply on top of animation pose.
    _qi.identity().slerp(_qw, blend);
    footBone.quaternion.premultiply(_qi);
    footBone.updateMatrix();
  }
}
