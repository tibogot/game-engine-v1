import * as THREE from "three";

const _Z = new THREE.Vector3(0, 0, 1);
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

const TINT_R = 245;
const TINT_G = 204;
const TINT_B = 82;
const FILL_ALPHA = 0.65;
const RING_ALPHA = 0.92;
const SIZE = 128;

export class BrushMaskCursor {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this._canvas = document.createElement("canvas");
    this._canvas.width = SIZE;
    this._canvas.height = SIZE;
    this._ctx = this._canvas.getContext("2d");

    this._texture = new THREE.CanvasTexture(this._canvas);

    const mat = new THREE.MeshBasicMaterial({
      map: this._texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    mat.fog = false;

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.mesh.visible = false;
    this.mesh.renderOrder = 8;
    scene.add(this.mesh);

    this._renderSoftCircle();
  }

  _renderSoftCircle() {
    const w = SIZE;
    const h = SIZE;
    const cx = w / 2;
    const r = w / 2;
    const img = this._ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = (x - cx + 0.5) / r;
        const ny = (y - cx + 0.5) / r;
        const d = Math.sqrt(nx * nx + ny * ny);
        const v = d < 1 ? Math.exp(-d * d * 4) : 0;
        const i = (y * w + x) * 4;
        img.data[i]     = TINT_R;
        img.data[i + 1] = TINT_G;
        img.data[i + 2] = TINT_B;
        img.data[i + 3] = Math.round(v * FILL_ALPHA * 255);
      }
    }
    this._ctx.putImageData(img, 0, 0);
    this._drawRing(cx, r);
    this._texture.needsUpdate = true;
  }

  _drawRing(cx, r) {
    this._ctx.beginPath();
    this._ctx.arc(cx, cx, r - 1.5, 0, Math.PI * 2);
    this._ctx.strokeStyle = `rgba(${TINT_R},${TINT_G},${TINT_B},${RING_ALPHA})`;
    this._ctx.lineWidth = 2.5;
    this._ctx.stroke();
  }

  /** Re-renders the cursor texture from current brush mask data. */
  syncFromMask(brushMask) {
    if (!brushMask?.active || !brushMask.data) {
      this._renderSoftCircle();
      return;
    }
    const w = SIZE;
    const h = SIZE;
    const s = brushMask.size;
    const data = brushMask.data;
    const img = this._ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = (x / w) * (s - 1);
        const sy = (y / h) * (s - 1);
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const x1 = Math.min(x0 + 1, s - 1);
        const y1 = Math.min(y0 + 1, s - 1);
        const tx = sx - x0;
        const ty = sy - y0;
        const v =
          data[y0 * s + x0] * (1 - tx) * (1 - ty) +
          data[y0 * s + x1] * tx * (1 - ty) +
          data[y1 * s + x0] * (1 - tx) * ty +
          data[y1 * s + x1] * tx * ty;
        const i = (y * w + x) * 4;
        img.data[i]     = TINT_R;
        img.data[i + 1] = TINT_G;
        img.data[i + 2] = TINT_B;
        img.data[i + 3] = Math.round(v * FILL_ALPHA * 255);
      }
    }
    this._ctx.clearRect(0, 0, w, h);
    this._ctx.putImageData(img, 0, 0);
    this._texture.needsUpdate = true;
  }

  /**
   * @param {{ point: THREE.Vector3, normal: THREE.Vector3 }} hit
   * @param {number} radius  world-space brush radius
   * @param {number} [maskRotationRad]  rotation around terrain normal
   */
  update(hit, radius, maskRotationRad = 0) {
    const nudge = 0.02 + Math.min(0.12, radius * 0.001);
    this.mesh.position.copy(hit.point).addScaledVector(hit.normal, nudge);
    // Rotate plane normal (+Z) to align with terrain normal, then spin for mask rotation
    _q1.setFromUnitVectors(_Z, hit.normal);
    _q2.setFromAxisAngle(hit.normal, maskRotationRad);
    this.mesh.quaternion.copy(_q2).multiply(_q1);
    this.mesh.scale.setScalar(radius * 2);
    this.mesh.visible = true;
  }

  hide() {
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this._texture.dispose();
  }
}
