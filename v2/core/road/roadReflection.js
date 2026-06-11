import * as THREE from "three";

export class RoadPlanarReflection {
  constructor({ renderer, scene, camera, resScale = 0.35 }) {
    this.renderer = renderer;
    this.scene = scene;
    this.srcCamera = camera;
    this.resScale = resScale;
    this.reflectY = 0;
    this.reflectCenter = null; // Optional: center reflection on this XZ position instead of camera

    const w = Math.floor(window.innerWidth * resScale);
    const h = Math.floor(window.innerHeight * resScale);
    this.reflectRT = new THREE.RenderTarget(w, h, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
    });

    this.refCamera = new THREE.PerspectiveCamera();
    this.reflectVP = new THREE.Matrix4();
    this._clipPlane = new THREE.Vector4();
    this._reflectMatrix = new THREE.Matrix4();

    this._excludeSet = new Set();

    window.addEventListener("resize", () => this._onResize());
  }

  _onResize() {
    const w = Math.floor(window.innerWidth * this.resScale);
    const h = Math.floor(window.innerHeight * this.resScale);
    this.reflectRT.setSize(w, h);
  }

  setReflectY(y) {
    this.reflectY = y;
  }

  // Set the XZ center for reflection (e.g., player/car position)
  // This makes reflection coverage centered on the car, not the camera behind it
  setReflectCenter(pos) {
    this.reflectCenter = pos ? pos.clone() : null;
  }

  excludeFromReflection(obj) {
    this._excludeSet.add(obj);
  }

  removeExclusion(obj) {
    this._excludeSet.delete(obj);
  }

  render(roadMeshes) {
    if (!roadMeshes || roadMeshes.length === 0) return;

    const src = this.srcCamera;
    const ref = this.refCamera;
    const waterY = this.reflectY;

    // Use VERY wide FOV to capture entire visible road - avoids "edge update" artifacts
    ref.fov = 160;
    ref.aspect = src.aspect;
    ref.near = src.near;
    ref.far = src.far * 2;
    ref.updateProjectionMatrix();

    // Position reflection camera at player position if available, else camera position
    if (this.reflectCenter) {
      ref.position.set(this.reflectCenter.x, src.position.y, this.reflectCenter.z);
    } else {
      ref.position.copy(src.position);
    }
    ref.position.y = 2 * waterY - ref.position.y;
    
    // Look in the same direction as main camera but mirrored
    ref.quaternion.copy(src.quaternion);
    ref.up.set(0, -1, 0);
    const target = new THREE.Vector3();
    src.getWorldDirection(target);
    target.y = -target.y;
    ref.lookAt(ref.position.clone().add(target));
    ref.updateMatrixWorld(true);

    ref.updateProjectionMatrix();
    this.reflectVP.multiplyMatrices(ref.projectionMatrix, ref.matrixWorldInverse);

    const savedVis = [];
    for (const obj of this._excludeSet) {
      savedVis.push({ obj, vis: obj.visible });
      obj.visible = false;
    }
    for (const rm of roadMeshes) {
      savedVis.push({ obj: rm, vis: rm.visible });
      rm.visible = false;
    }

    const oldRT = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.reflectRT);
    this.renderer.render(this.scene, ref);
    this.renderer.setRenderTarget(oldRT);

    for (const { obj, vis } of savedVis) {
      obj.visible = vis;
    }
  }

  get texture() {
    return this.reflectRT.texture;
  }

  dispose() {
    this.reflectRT.dispose();
  }
}
