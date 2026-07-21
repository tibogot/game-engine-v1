import * as THREE from "three";

/**
 * Trajectory preview for gap authoring — the core aid of the air-stunt builder.
 *
 * At the instant a car leaves a ramp it's a projectile (gravity only), so a
 * cheap ballistic parabola from the open connector at a reference speed shows,
 * accurately, where a jump taken at that pace lands. You then drop a landing
 * chain on the marked point. No physics sim — just x = x0 + v0·t + ½g·t².
 *
 * Connector convention (modularRoadKit.socketMatrix): the matrix's Z column is
 * −travel, so the launch direction is the NEGATED Z axis. For a jump ramp the
 * exit tangent points up-and-forward, so the launch already carries the ramp's
 * pitch.
 */
const _exit = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _v0 = new THREE.Vector3();
const _p = new THREE.Vector3();

export class GapPreview {
  constructor({ scene, gravity = 9.81, maxPoints = 300 }) {
    this.gravity = gravity;
    this.maxPoints = maxPoints;
    this.landing = null; // { pos, vel, dist, time } | null

    const geo = new THREE.BufferGeometry();
    this._positions = new Float32Array(maxPoints * 3);
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(this._positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setDrawRange(0, 0);
    this.line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: 0x5fd4ff, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.line.name = "GapArc";
    this.line.frustumCulled = false;
    this.line.renderOrder = 3;

    // Landing marker: a flat ring + a short pole so it reads against the sky.
    this.marker = new THREE.Group();
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x35e07a, transparent: true, opacity: 0.9, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.22, 8, 32), ringMat);
    ring.rotation.x = Math.PI / 2;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4, 6), ringMat);
    pole.position.y = 2;
    this.marker.add(ring, pole);
    this.marker.name = "GapLanding";
    this.marker.visible = false;

    this.group = new THREE.Group();
    this.group.name = "GapPreview";
    this.group.add(this.line, this.marker);
    this.group.visible = false;
    scene.add(this.group);
  }

  setVisible(v) { this.group.visible = !!v; }

  /**
   * Recompute the arc from the open connector.
   * @param {THREE.Matrix4} connector  open-end connector (Z col = −travel)
   * @param {number} refSpeed          launch speed (m/s)
   * @param {number} landingDrop       metres BELOW launch height to land (0 = level)
   * @returns {{pos:THREE.Vector3, vel:THREE.Vector3, dist:number, time:number} | null}
   */
  update(connector, refSpeed, landingDrop = 0) {
    const e = connector.elements;
    _exit.setFromMatrixPosition(connector);
    _dir.set(-e[8], -e[9], -e[10]).normalize(); // launch = −Z column
    _v0.copy(_dir).multiplyScalar(refSpeed);

    const g = this.gravity;
    const dt = 1 / 30;
    const targetY = _exit.y - landingDrop;
    const minY = _exit.y - 500; // absolute stop (fell way past any landing)
    const maxT = 12;

    const pos = this._positions;
    pos[0] = _exit.x; pos[1] = _exit.y; pos[2] = _exit.z;
    let n = 1;
    let prevY = _exit.y;
    let landing = null;

    for (let t = dt; n < this.maxPoints && t < maxT; t += dt) {
      _p.set(
        _exit.x + _v0.x * t,
        _exit.y + _v0.y * t - 0.5 * g * t * t,
        _exit.z + _v0.z * t,
      );
      pos[n * 3] = _p.x; pos[n * 3 + 1] = _p.y; pos[n * 3 + 2] = _p.z;
      n++;
      // Landing = first DESCENDING crossing of the target height.
      if (prevY > targetY && _p.y <= targetY) {
        landing = {
          pos: _p.clone(),
          vel: new THREE.Vector3(_v0.x, _v0.y - g * t, _v0.z),
          dist: Math.hypot(_p.x - _exit.x, _p.z - _exit.z),
          time: t,
        };
        break; // arc ends at the landing
      }
      prevY = _p.y;
      if (_p.y < minY) break;
    }

    this.line.geometry.setDrawRange(0, n);
    this.line.geometry.attributes.position.needsUpdate = true;
    this.line.geometry.computeBoundingSphere();

    this.landing = landing;
    this.marker.visible = !!landing;
    if (landing) this.marker.position.copy(landing.pos);
    return landing;
  }

  dispose() {
    this.line.geometry.dispose();
    this.line.material.dispose();
    this.marker.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    this.group.parent?.remove(this.group);
  }
}
