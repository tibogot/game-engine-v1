import * as THREE from "three";
import {
  buildPiece,
  initialConnector,
  roadParams,
  guardrailParams,
  pieceParams,
} from "./modularRoadKit.js";

/**
 * Live thumbnail baker. Renders a small 3/4 view of each road piece / preset
 * with the REAL road materials, so palette tiles match what actually gets built
 * (replacing the hand-drawn SVG silhouettes). Runs once at startup and returns
 * Map(key -> PNG data-URL); no files to manage. The same render path can later
 * be promoted to an offline PNG bake for the v2 port.
 *
 * @param {object} o
 * @param {THREE.WebGPURenderer} o.renderer
 * @param {{road:THREE.Material, rail?:THREE.Material, shell?:THREE.Material, decor?:THREE.Material}} o.materials
 * @param {{key:string, pieceId?:string, params?:object, make?:()=>THREE.Object3D}[]} o.items
 * @param {THREE.Texture} [o.environment] optional IBL (the main scene's PMREM) for correct lighting
 * @param {number} [o.size=128]
 * @returns {Promise<Map<string,string>>}
 */
export async function bakeRoadThumbnails({ renderer, materials, items, environment = null, size = 128 }) {
  const out = new Map();
  if (!renderer || !materials?.road || !Array.isArray(items)) return out;

  const rt = new THREE.RenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.SRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    samples: 4,
  });

  const scene = new THREE.Scene();
  if (environment) scene.environment = environment;
  const hemi = new THREE.HemisphereLight(0xdfeaff, 0x3a3a42, 2.4);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xfff2e0, 2.8);
  dir.position.set(5, 9, 6);
  scene.add(dir);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 5000);
  const group = new THREE.Group();
  scene.add(group);

  const box = new THREE.Box3();
  const sphere = new THREE.Sphere();
  const center = new THREE.Vector3();
  const camDir = new THREE.Vector3(0.78, 0.82, 0.95).normalize();

  const prevTarget = renderer.getRenderTarget();
  const prevClearAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0); // transparent thumbnails

  const clearGroup = () => {
    while (group.children.length) {
      const c = group.children.pop();
      c.traverse?.((o) => {
        if (o.isMesh) o.geometry?.dispose?.();
      });
    }
  };

  try {
    for (const item of items) {
      clearGroup();

      if (item.make) {
        group.add(item.make());
      } else {
        const pp = { ...pieceParams, ...(item.params || {}) };
        let built;
        try {
          built = buildPiece(
            item.pieceId,
            initialConnector(),
            pp,
            roadParams,
            guardrailParams,
            guardrailParams.enabled,
          );
        } catch {
          continue;
        }
        const addMesh = (geo, mat) => {
          if (!geo || !mat) return;
          group.add(new THREE.Mesh(geo, mat));
        };
        if (!built.def.noMesh) addMesh(built.geometry, materials.road);
        addMesh(built.railGeometry, materials.rail);
        addMesh(built.shellGeometry, materials.shell);
        addMesh(built.decorGeometry, materials.decor);
      }

      if (!group.children.length) continue;

      // Frame by bounding sphere so every piece (long straight, wide curve,
      // tall loop) is centred and fully visible at a uniform 3/4 angle.
      box.setFromObject(group);
      box.getBoundingSphere(sphere);
      center.copy(sphere.center);
      const r = Math.max(sphere.radius, 0.5);
      const dist = (r / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.12;
      camera.position.copy(center).addScaledVector(camDir, dist);
      camera.lookAt(center);
      camera.updateMatrixWorld(true);

      renderer.setRenderTarget(rt);
      renderer.render(scene, camera); // renderer already init()-ed (renderAsync is deprecated)
      // r0.184: returns the pixel buffer (Uint8Array for UnsignedByteType).
      const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size);
      out.set(item.key, pixelsToDataURL(new Uint8Array(buf.buffer ?? buf), size));
    }
  } catch (err) {
    console.warn("[modular-road] thumbnail bake failed; falling back to SVG.", err);
  } finally {
    clearGroup();
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(0x000000, prevClearAlpha);
    rt.dispose();
  }

  return out;
}

/** RGBA byte buffer → PNG data-URL via a 2D canvas. WebGPU readRenderTargetPixelsAsync
 *  returns top-first rows (same as canvas ImageData); do not flip Y (that was for WebGL). */
function pixelsToDataURL(buf, size) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  img.data.set(buf.subarray(0, size * size * 4));
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}
