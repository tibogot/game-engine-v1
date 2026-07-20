import * as THREE from "three";
import { RoadBvh } from "../../v3/play/modularRoadBvh.js";

/**
 * Shared geometry + ParkourMover — used by placeable static props and moving obstacles.
 */

/** Enable directional-light shadows on every mesh under root. */
export function enableMeshShadows(root) {
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
}

/* ----------------------------------------------------------------------- */
/* Geometry helpers                                                         */
/* ----------------------------------------------------------------------- */

/** Drive ramp: low edge at y=0, z=0 (local); rises toward -Z. */
export function rampGeometry(w, l, angleRad) {
  const H = l * Math.sin(angleRad);
  const hw = w / 2;
  const zN = 0;
  const zF = -l;
  const Al = [-hw, 0, zN],
    Bl = [-hw, 0, zF],
    Cl = [-hw, H, zF];
  const Ar = [hw, 0, zN],
    Br = [hw, 0, zF],
    Cr = [hw, H, zF];
  const pos = [];
  const quad = (a, b, c, d) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  quad(Al, Ar, Cr, Cl);
  quad(Al, Bl, Br, Ar);
  quad(Bl, Cl, Cr, Br);
  tri(Al, Cl, Bl);
  tri(Ar, Br, Cr);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Five side-by-side test ramps (15°–55°), centred on XZ with feet on y=0. */
export function buildSlopeLabGroup() {
  const group = new THREE.Group();
  group.name = "SlopeLab";
  const slopeAngles = [15, 25, 35, 45, 55];
  const w = 12;
  const l = 22;
  const z = 48;
  for (let i = 0; i < slopeAngles.length; i++) {
    const tint = 0.52 - i * 0.055;
    const color = new THREE.Color().setHSL(0.085, 0.42, tint).getHex();
    const m = new THREE.Mesh(
      rampGeometry(w, l, THREE.MathUtils.degToRad(slopeAngles[i])),
      new THREE.MeshStandardMaterial({ color, roughness: 0.85, side: THREE.DoubleSide }),
    );
    m.position.set(-42 + i * 21, 0, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }
  const box = new THREE.Box3().setFromObject(group);
  const cx = (box.min.x + box.max.x) * 0.5;
  const cz = (box.min.z + box.max.z) * 0.5;
  for (const child of group.children) {
    child.position.x -= cx;
    child.position.z -= cz;
  }
  return group;
}

/**
 * Jump-lab counterpart to buildSlopeLabGroup: five side-by-side concave jump
 * ramps (kicker scoop) of increasing rise, so the takeoff lip gets steeper
 * left→right — same flat-entry shape as the "Jump ramp" prop, laid out as a
 * test row. Feet on y = 0, centred on XZ.
 */
export function buildJumpLabGroup() {
  const group = new THREE.Group();
  group.name = "JumpLab";
  const rises = [4, 7, 10, 14, 18]; // increasing lip steepness ≈ different takeoff angles
  const w = 12;
  const l = 22;
  const z = 48;
  for (let i = 0; i < rises.length; i++) {
    const tint = 0.52 - i * 0.055;
    const color = new THREE.Color().setHSL(0.085, 0.42, tint).getHex();
    const m = new THREE.Mesh(
      jumpRampGeometry(w, l, rises[i]),
      new THREE.MeshStandardMaterial({ color, roughness: 0.85, side: THREE.DoubleSide }),
    );
    m.position.set(-42 + i * 21, 0, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }
  const box = new THREE.Box3().setFromObject(group);
  const cx = (box.min.x + box.max.x) * 0.5;
  const cz = (box.min.z + box.max.z) * 0.5;
  for (const child of group.children) {
    child.position.x -= cx;
    child.position.z -= cz;
  }
  return group;
}

/**
 * Curved drive ramp: starts at local (0,0,0) heading −Z, turns by `angleDeg`
 * (curveDir ±1), rises to `rise` with smoothstep. Low edge at y = 0.
 */
function curveRampGeometry(w, radius, angleDeg, rise, curveDir = 1, segments = 32) {
  const R = Math.max(4, radius);
  const A = THREE.MathUtils.degToRad(Math.min(120, Math.max(15, angleDeg)));
  const dir = curveDir >= 0 ? 1 : -1;
  const hw = w / 2;
  const n = Math.max(8, segments);
  const center = new THREE.Vector3(dir * R, 0, 0);
  const radius0 = new THREE.Vector3(-dir * R, 0, 0);

  const centerline = [];
  const rights = [];
  const _off = new THREE.Vector3();
  const _tan = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _right = new THREE.Vector3();

  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const phi = A * t;
    const sm = t * t * (3 - 2 * t);
    _off.copy(radius0).applyAxisAngle(_up, -dir * phi);
    centerline.push(new THREE.Vector3(center.x + _off.x, rise * sm, center.z + _off.z));
  }

  for (let i = 0; i <= n; i++) {
    const prev = centerline[Math.max(0, i - 1)];
    const next = centerline[Math.min(n, i + 1)];
    _tan.subVectors(next, prev);
    if (_tan.lengthSq() < 1e-10) _right.set(dir, 0, 0);
    else {
      _tan.normalize();
      _right.crossVectors(_up, _tan);
      if (_right.lengthSq() < 1e-10) _right.set(1, 0, 0);
      else _right.normalize();
    }
    rights.push(_right.clone());
  }

  const pos = [];
  const quad = (a, b, c, d) => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    pos.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
  };
  const tri = (a, b, c) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);

  const L = (i, side) => {
    const p = centerline[i];
    const r = rights[i];
    return new THREE.Vector3(p.x + r.x * hw * side, p.y, p.z + r.z * hw * side);
  };
  const ground = (v) => new THREE.Vector3(v.x, 0, v.z);

  for (let i = 0; i < n; i++) {
    quad(L(i, -1), L(i, 1), L(i + 1, 1), L(i + 1, -1));
  }
  for (let i = 0; i < n; i++) {
    const lt0 = L(i, -1);
    const lt1 = L(i + 1, -1);
    quad(lt0, lt1, ground(lt1), ground(lt0));
    const rt0 = L(i, 1);
    const rt1 = L(i + 1, 1);
    quad(rt0, ground(rt0), ground(rt1), rt1);
  }
  tri(L(0, -1), L(0, 1), ground(L(0, 1)));
  tri(L(0, -1), ground(L(0, 1)), ground(L(0, -1)));
  tri(L(n, -1), ground(L(n, -1)), ground(L(n, 1)));
  tri(L(n, -1), ground(L(n, 1)), L(n, 1));

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Solid extruded kicker: flat entry z=0, profile supplied by heightAt(t) where t∈[0,1]. */
function solidKickerExtrusion(w, length, rise, segments, heightAt) {
  const hw = w / 2;
  const n = Math.max(8, segments);
  const L = Math.max(4, length);
  const H = Math.max(0.5, rise);
  const pos = [];
  const quad = (a, b, c, d) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);

  const topL = [];
  const topR = [];
  const botL = [];
  const botR = [];

  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const z = -L * t;
    const y = heightAt(t, H);
    topL.push([-hw, y, z]);
    topR.push([hw, y, z]);
    botL.push([-hw, 0, z]);
    botR.push([hw, 0, z]);
  }

  for (let i = 0; i < n; i++) quad(topL[i], topR[i], topR[i + 1], topL[i + 1]);
  for (let i = 0; i < n; i++) quad(botL[i], botL[i + 1], botR[i + 1], botR[i]);
  for (let i = 0; i < n; i++) quad(botL[i], topL[i], topL[i + 1], botL[i + 1]);
  for (let i = 0; i < n; i++) quad(botR[i], botR[i + 1], topR[i + 1], topR[i]);
  quad(botL[n], topL[n], topR[n], botR[n]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Convex kicker — surface bulges above the straight chord (y = rise×sin(t×π/2)).
 */
export function kickerRampGeometry(w, length, rise, segments = 32) {
  return solidKickerExtrusion(w, length, rise, segments, (t, H) => H * Math.sin((Math.PI / 2) * t));
}

/**
 * Concave jump ramp — scooped transition below the chord (y = rise×(1−cos(t×π/2))).
 * Flat entry, steep lip; typical stunt jump profile.
 */
export function jumpRampGeometry(w, length, rise, segments = 32) {
  return solidKickerExtrusion(w, length, rise, segments, (t, H) => H * (1 - Math.cos((Math.PI / 2) * t)));
}

/* ----------------------------------------------------------------------- */
/* Dynamic movers — rebaked each frame, push the chassis via surface velocity */
/* ----------------------------------------------------------------------- */

const _pivotW = new THREE.Vector3();
const _r = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class ParkourMover {
  /**
   * @param {object} o
   * @param {THREE.Mesh} o.mesh collision + visual mesh
   * @param {"spin-y"|"slide-z"|"slide-y"|"pendulum-x"} o.mode
   * @param {number} o.speed rad/s or phase speed
   * @param {THREE.Object3D} [o.pivot] required for spin-y / pendulum-x
   * @param {number} [o.amplitude] slide distance (m) or swing angle (rad)
   * @param {THREE.Vector3} [o.origin] rest position for slide modes
   * @param {boolean} [o.isDeck] when true, mesh is rebaked into the wheel deck BVH each frame
   * @param {number} [o.phase0] initial motion phase (e.g. −π/2 starts elevator at bottom)
   */
  constructor({
    mesh,
    mode,
    speed,
    pivot = null,
    amplitude = 8,
    origin = null,
    isDeck = false,
    phase0 = 0,
  }) {
    this.mesh = mesh;
    this.pivot = pivot;
    this.mode = mode;
    this.speed = speed;
    this.amplitude = amplitude;
    this.origin = origin ? origin.clone() : mesh.position.clone();
    this.isDeck = isDeck;
    this.phase = phase0;
    this.bvh = new RoadBvh();
    this.label = mesh.name || mode;

    this._linVel = new THREE.Vector3();
    this._angVelW = new THREE.Vector3();
  }

  update(dt) {
    this.phase += this.speed * dt;
    if (this.mode === "spin-y" && this.pivot) {
      this.pivot.rotation.x = 0;
      this.pivot.rotation.y = this.phase;
      this._angVelW.set(0, this.speed, 0).applyQuaternion(this.pivot.getWorldQuaternion(_q));
      this._linVel.set(0, 0, 0);
    } else if (this.mode === "slide-z") {
      const offset = this.amplitude * Math.sin(this.phase);
      this.mesh.position.set(this.origin.x, this.origin.y, this.origin.z + offset);
      this._linVel.set(0, 0, this.amplitude * this.speed * Math.cos(this.phase));
      this._angVelW.set(0, 0, 0);
    } else if (this.mode === "slide-y") {
      const y = this.origin.y + this.amplitude * Math.sin(this.phase);
      this.mesh.position.set(this.origin.x, y, this.origin.z);
      this._linVel.set(0, this.amplitude * this.speed * Math.cos(this.phase), 0);
      this._angVelW.set(0, 0, 0);
    } else if (this.mode === "pendulum-x" && this.pivot) {
      const angle = this.amplitude * Math.sin(this.phase);
      this.pivot.rotation.x = angle;
      const angSpeed = this.amplitude * this.speed * Math.cos(this.phase);
      this._angVelW.set(angSpeed, 0, 0).applyQuaternion(this.pivot.getWorldQuaternion(_q));
      this._linVel.set(0, 0, 0);
    }
    this.mesh.updateMatrixWorld(true);
    if (!this.isDeck) this.bvh.bakeFromMeshes([this.mesh]);
  }

  /** Surface velocity at a world-space contact point (for chassis coupling). */
  velocityAt(worldPoint, out) {
    if ((this.mode === "spin-y" || this.mode === "pendulum-x") && this.pivot) {
      this.pivot.getWorldPosition(_pivotW);
      _r.subVectors(worldPoint, _pivotW);
      return out.crossVectors(this._angVelW, _r);
    }
    return out.copy(this._linVel);
  }
}
