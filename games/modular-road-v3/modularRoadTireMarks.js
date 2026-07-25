import * as THREE from "three";
// Marks are sized from the fitted wheel (see MARK_WIDTH_FRAC). No import cycle:
// the vehicle module knows nothing about tyre marks.
import { WHEEL } from "../../v3/play/modularRoadVehicle.js";

/**
 * Rear-wheel skid ribbons for modular-road test drive.
 * Pattern follows v2 play-mode drift marks (ring buffer, vertex alpha) but is
 * standalone — no imports from v2 or Starter-Kit-Racing.
 */

const MAX_SEGMENTS = 4096;
const VERTS_PER_SEGMENT = 6;
const FLOATS_PER_SEGMENT = VERTS_PER_SEGMENT * 3;
const COLOR_FLOATS_PER_SEGMENT = VERTS_PER_SEGMENT * 4;
const UV_FLOATS_PER_SEGMENT = VERTS_PER_SEGMENT * 2;

/**
 * TEXTURED SKID MARKS — an alternative look, switchable at runtime against the
 * original flat ribbon (`setStyle`). Both styles share this one geometry and
 * ring buffer, so switching is just a material swap: nothing to rebuild, and
 * the flat ribbon stays available as a fallback.
 *
 * Kept as one class rather than two because the emit logic — drift detection,
 * contact points, ring buffer, fade — is identical for both. Only the material
 * differs. UVs are written unconditionally (+192 KB) so a switch needs no
 * regeneration.
 */
export const SKID_TEXTURE_URL = "/textures/skid_mark01.png";

/** Metres of track per repeat of the texture along the mark. */
const TILE_LENGTH = 6.0;

/**
 * Contact-patch width as a fraction of the TYRE's width.
 *
 * Derived from `WHEEL.thickness` rather than hardcoded, so it follows whichever
 * wheel is fitted — the procedural wheel is 0.24 m but the Lotus GLB is 0.289 m,
 * and a fixed number would be wrong for one of them. `setWheelStyle` rewrites
 * WHEEL.thickness on the swap, so the marks re-width for free.
 *
 * Slightly under 1: a tyre's shoulders carry less load than the centre, so the
 * mark it leaves is a little narrower than the carcass.
 *
 * (Was a flat 0.09 HALF-width — a 0.18 m mark under a 0.24 m tyre, i.e. 75%.
 * Too narrow to read as a tyre print.)
 */
const MARK_WIDTH_FRAC = 0.92;
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

    // u runs ALONG the mark (distance / TILE_LENGTH), v ACROSS it (0..1).
    // Written for both styles so switching never has to regenerate anything.
    const uvs = new Float32Array(MAX_SEGMENTS * UV_FLOATS_PER_SEGMENT);
    const uvAttr = new THREE.BufferAttribute(uvs, 2);
    uvAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("uv", uvAttr);

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
    this.uvs = uvs;
    this.geometry = geometry;
    this.segmentIndex = 0;
    this.drawCount = 0;
    // `dist` is metres laid down since this mark started — it drives u, so the
    // texture flows continuously along the streak instead of per-segment.
    this.states = [
      { prev: new THREE.Vector3(), active: false, dist: 0 },
      { prev: new THREE.Vector3(), active: false, dist: 0 },
    ];

    this.style = "solid";
    this._solidMaterial = material;
    this._texturedMaterial = null;
    this._skidTexture = null;
  }

  /**
   * Swap the look: "solid" (flat dark ribbon) or "textured" (skid_mark01.png).
   * Geometry is shared, so this is a material swap and nothing more — the solid
   * ribbon is always available as a fallback if the texture doesn't convince.
   */
  setStyle(style) {
    const want = style === "textured" ? "textured" : "solid";
    this.style = want;
    if (want === "solid") {
      this.mesh.material = this._solidMaterial;
      return want;
    }
    if (!this._texturedMaterial) {
      this._texturedMaterial = new THREE.MeshBasicMaterial({
        // The PNG is pure black with all its detail in ALPHA, so the tint stays
        // white and the texture carries the look. Vertex alpha still fades the
        // ribbon in/out with drift intensity, multiplying the texture's own.
        color: 0xffffff,
        transparent: true,
        vertexColors: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
      new THREE.TextureLoader().load(
        SKID_TEXTURE_URL,
        (tex) => {
          // MIRRORED repeat along the mark, and this is the important bit:
          // measured, the texture does NOT tile — its left edge fades to alpha 0
          // but its right edge is still at 0.53, so plain RepeatWrapping shows a
          // hard seam every TILE_LENGTH. Mirroring makes each repeat a flip of
          // the last, so 0.53 always meets 0.53 and 0 meets 0 — continuous.
          tex.wrapS = THREE.MirroredRepeatWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping; // v is across the mark: never tile
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8; // marks are viewed at a very grazing angle
          this._skidTexture = tex;
          this._texturedMaterial.map = tex;
          this._texturedMaterial.needsUpdate = true;
        },
        undefined,
        (err) => {
          console.warn("[modular-road] skid texture failed, staying solid:", SKID_TEXTURE_URL, err);
          this.setStyle("solid");
        },
      );
    }
    this.mesh.material = this._texturedMaterial;
    return want;
  }

  reset() {
    this.segmentIndex = 0;
    this.drawCount = 0;
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
    this.states[0].active = false;
    this.states[1].active = false;
    this.states[0].dist = 0;
    this.states[1].dist = 0;
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
    // Restart the texture run whenever a new mark begins, so every streak opens
    // at u=0 (the texture's faded end) instead of mid-pattern.
    if (emit && !state.active) state.dist = 0;
    if (emit && state.active) this._addSegment(state.prev, point, intensity, state);
    state.prev.copy(point);
    state.active = emit;
  }

  _addSegment(prev, curr, intensity, state) {
    _dir.subVectors(curr, prev);
    _dir.y = 0;
    const len = _dir.length();
    if (len < MIN_SEGMENT_LENGTH) return;
    _dir.divideScalar(len);

    // Half-width, read from the fitted wheel each segment so a wheel-style swap
    // is picked up immediately (see MARK_WIDTH_FRAC).
    _side.set(_dir.z, 0, -_dir.x).multiplyScalar(WHEEL.thickness * MARK_WIDTH_FRAC * 0.5);
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

    // UVs — u advances with real distance travelled so the texture flows along
    // the streak continuously rather than restarting per segment. Vertex order
    // is (pL, pR, cL, pR, cR, cL); v is 0 on the left edge, 1 on the right.
    const u0 = state.dist / TILE_LENGTH;
    state.dist += len;
    const u1 = state.dist / TILE_LENGTH;
    const uvOffset = this.segmentIndex * UV_FLOATS_PER_SEGMENT;
    const uv = this.uvs;
    uv[uvOffset + 0] = u0; uv[uvOffset + 1] = 0;  // pL
    uv[uvOffset + 2] = u0; uv[uvOffset + 3] = 1;  // pR
    uv[uvOffset + 4] = u1; uv[uvOffset + 5] = 0;  // cL
    uv[uvOffset + 6] = u0; uv[uvOffset + 7] = 1;  // pR
    uv[uvOffset + 8] = u1; uv[uvOffset + 9] = 1;  // cR
    uv[uvOffset + 10] = u1; uv[uvOffset + 11] = 0; // cL

    const posAttr = this.geometry.attributes.position;
    posAttr.addUpdateRange(offset, FLOATS_PER_SEGMENT);
    posAttr.needsUpdate = true;
    const colorAttr = this.geometry.attributes.color;
    colorAttr.addUpdateRange(colorOffset, COLOR_FLOATS_PER_SEGMENT);
    colorAttr.needsUpdate = true;
    const uvAttr = this.geometry.attributes.uv;
    uvAttr.addUpdateRange(uvOffset, UV_FLOATS_PER_SEGMENT);
    uvAttr.needsUpdate = true;

    this.segmentIndex = (this.segmentIndex + 1) % MAX_SEGMENTS;
    if (this.drawCount < MAX_SEGMENTS * VERTS_PER_SEGMENT) {
      this.drawCount += VERTS_PER_SEGMENT;
      this.geometry.setDrawRange(0, this.drawCount);
    }
    this.mesh.visible = this.drawCount > 0;
  }
}
