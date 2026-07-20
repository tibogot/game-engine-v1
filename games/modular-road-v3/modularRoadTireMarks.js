import * as THREE from "three";

/**
 * Rear-wheel skid ribbons for modular-road test drive.
 * Pattern follows v2 play-mode drift marks (ring buffer, vertex alpha) but is
 * standalone — no imports from v2 or Starter-Kit-Racing.
 */

const MAX_SEGMENTS = 4096;
const VERTS_PER_SEGMENT = 6;
const FLOATS_PER_SEGMENT = VERTS_PER_SEGMENT * 3;
const COLOR_FLOATS_PER_SEGMENT = VERTS_PER_SEGMENT * 4;

const MARK_WIDTH = 0.09;
const MARK_Y_OFFSET = 0.045;
const MIN_SEGMENT_LENGTH = 0.035;
const INTENSITY_MIN = 0.15;
const INTENSITY_MAX = 0.9;
const INV_INTENSITY_RANGE = 1 / (INTENSITY_MAX - INTENSITY_MIN);

/** Minimum horizontal speed (m/s) before marks are emitted. */
const ENTRY_SPEED = 8;
const DRIFT_ANGLE_MIN = 0.1;

const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _pL = new THREE.Vector3();
const _pR = new THREE.Vector3();
const _cL = new THREE.Vector3();
const _cR = new THREE.Vector3();
const _chassisFwd = new THREE.Vector3();
const _velHoriz = new THREE.Vector3();
const _rearContact0 = new THREE.Vector3();
const _rearContact1 = new THREE.Vector3();
const _scratchVel = new THREE.Vector3();
const _wheelFwd = new THREE.Vector3();
const _wheelRight = new THREE.Vector3();

export class ModularRoadTireMarks {
  constructor(scene) {
    const positions = new Float32Array(MAX_SEGMENTS * FLOATS_PER_SEGMENT);
    const colors = new Float32Array(MAX_SEGMENTS * COLOR_FLOATS_PER_SEGMENT);
    for (let i = 0; i < MAX_SEGMENTS * VERTS_PER_SEGMENT; i++) {
      const o = i * 4;
      colors[o] = 1;
      colors[o + 1] = 1;
      colors[o + 2] = 1;
    }

    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", posAttr);

    const colorAttr = new THREE.BufferAttribute(colors, 4);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("color", colorAttr);
    geometry.setDrawRange(0, 0);

    const material = new THREE.MeshBasicMaterial({
      color: 0x111111,
      transparent: true,
      vertexColors: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.positions = positions;
    this.colors = colors;
    this.geometry = geometry;
    this.segmentIndex = 0;
    this.drawCount = 0;
    this.states = [
      { prev: new THREE.Vector3(), active: false },
      { prev: new THREE.Vector3(), active: false },
    ];
  }

  reset() {
    this.segmentIndex = 0;
    this.drawCount = 0;
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
    this.states[0].active = false;
    this.states[1].active = false;
  }

  /** @param {import("./modularRoadVehicle.js").Vehicle} vehicle */
  update(vehicle) {
    if (!vehicle?.enabled) {
      this._track(null, false, 0, this.states[0]);
      this._track(null, false, 0, this.states[1]);
      return;
    }

    const body = vehicle.body;
    _velHoriz.copy(body.vel);
    _velHoriz.y = 0;
    const speed = _velHoriz.length();

    _chassisFwd.set(0, 0, 1).applyQuaternion(body.quat);
    _chassisFwd.y = 0;
    if (_chassisFwd.lengthSq() > 1e-8) _chassisFwd.normalize();

    let driftAngle = 0;
    if (speed > 0.5 && _chassisFwd.lengthSq() > 1e-8) {
      driftAngle = Math.acos(
        THREE.MathUtils.clamp(_velHoriz.dot(_chassisFwd) / speed, -1, 1),
      );
    }

    const driftAmount = THREE.MathUtils.clamp(
      (driftAngle - DRIFT_ANGLE_MIN) / 0.5,
      0,
      1,
    );
    const handbrake = !!vehicle.input?.handbrake;
    const handbrakeAmount = handbrake
      ? THREE.MathUtils.smoothstep(speed, ENTRY_SPEED, ENTRY_SPEED * 2.2)
      : 0;

    let rearSlip = 0;
    let rearIdx = 0;
    let p0 = null;
    let p1 = null;
    let g0 = false;
    let g1 = false;
    for (const tire of vehicle.tires) {
      if (tire.canSteer) continue;
      const contact = rearIdx === 0 ? _rearContact0 : _rearContact1;
      if (tire.grounded) {
        contact.copy(tire.hitPoint).addScaledVector(tire.hitNormal, MARK_Y_OFFSET);
        if (rearIdx === 0) {
          p0 = _rearContact0;
          g0 = true;
        } else {
          p1 = _rearContact1;
          g1 = true;
        }

        body.getVelocityAtPoint(tire.worldPos, _scratchVel);
        _wheelFwd.set(0, 0, 1).applyQuaternion(body.quat);
        _wheelRight.set(1, 0, 0).applyQuaternion(body.quat);
        const vLat = Math.abs(_scratchVel.dot(_wheelRight));
        const vLong = Math.abs(_scratchVel.dot(_wheelFwd));
        const vRef = Math.max(vLong, 3.5);
        rearSlip = Math.max(rearSlip, vLat / vRef);
      }
      rearIdx++;
    }

    const slipAmount = THREE.MathUtils.clamp(rearSlip * 0.85, 0, 1);
    const driftIntensity = Math.max(driftAmount, handbrakeAmount, slipAmount);
    const inAir = vehicle.groundedCount === 0;
    const emit =
      !inAir &&
      speed > ENTRY_SPEED &&
      driftIntensity > INTENSITY_MIN;

    this._track(p0, emit && g0, driftIntensity, this.states[0]);
    this._track(p1, emit && g1, driftIntensity, this.states[1]);
  }

  _track(point, emit, intensity, state) {
    if (!point) {
      state.active = false;
      return;
    }
    if (emit && state.active) this._addSegment(state.prev, point, intensity);
    state.prev.copy(point);
    state.active = emit;
  }

  _addSegment(prev, curr, intensity) {
    _dir.subVectors(curr, prev);
    _dir.y = 0;
    const len = _dir.length();
    if (len < MIN_SEGMENT_LENGTH) return;
    _dir.divideScalar(len);

    _side.set(_dir.z, 0, -_dir.x).multiplyScalar(MARK_WIDTH);
    _pL.copy(prev).add(_side);
    _pR.copy(prev).sub(_side);
    _cL.copy(curr).add(_side);
    _cR.copy(curr).sub(_side);

    const offset = this.segmentIndex * FLOATS_PER_SEGMENT;
    const p = this.positions;
    p[offset + 0] = _pL.x;
    p[offset + 1] = _pL.y;
    p[offset + 2] = _pL.z;
    p[offset + 3] = _pR.x;
    p[offset + 4] = _pR.y;
    p[offset + 5] = _pR.z;
    p[offset + 6] = _cL.x;
    p[offset + 7] = _cL.y;
    p[offset + 8] = _cL.z;
    p[offset + 9] = _pR.x;
    p[offset + 10] = _pR.y;
    p[offset + 11] = _pR.z;
    p[offset + 12] = _cR.x;
    p[offset + 13] = _cR.y;
    p[offset + 14] = _cR.z;
    p[offset + 15] = _cL.x;
    p[offset + 16] = _cL.y;
    p[offset + 17] = _cL.z;

    const alpha = THREE.MathUtils.clamp(
      (intensity - INTENSITY_MIN) * INV_INTENSITY_RANGE,
      0,
      1,
    );
    const colorOffset = this.segmentIndex * COLOR_FLOATS_PER_SEGMENT;
    for (let i = 0; i < VERTS_PER_SEGMENT; i++) {
      this.colors[colorOffset + i * 4 + 3] = alpha;
    }

    const posAttr = this.geometry.attributes.position;
    posAttr.addUpdateRange(offset, FLOATS_PER_SEGMENT);
    posAttr.needsUpdate = true;
    const colorAttr = this.geometry.attributes.color;
    colorAttr.addUpdateRange(colorOffset, COLOR_FLOATS_PER_SEGMENT);
    colorAttr.needsUpdate = true;

    this.segmentIndex = (this.segmentIndex + 1) % MAX_SEGMENTS;
    if (this.drawCount < MAX_SEGMENTS * VERTS_PER_SEGMENT) {
      this.drawCount += VERTS_PER_SEGMENT;
      this.geometry.setDrawRange(0, this.drawCount);
    }
    this.mesh.visible = this.drawCount > 0;
  }
}
