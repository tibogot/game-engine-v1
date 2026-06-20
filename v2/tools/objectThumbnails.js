import * as THREE from "three";

/**
 * Offscreen WebGPU thumbnail bake for UI asset pickers.
 * Adapted from rts-chibs/public/rtsThumbnails.js — auto-frames each object
 * with a 3/4 camera angle and returns PNG data URLs.
 *
 * @param {object} o
 * @param {THREE.WebGPURenderer} o.renderer
 * @param {{ key: string, make: () => THREE.Object3D }[]} o.items
 * @param {THREE.Texture} [o.environment]
 * @param {number} [o.environmentIntensity=0.35]
 * @param {number} [o.size=128]
 * @param {number} [o.fill=0.88]
 * @returns {Promise<Map<string, string>>}
 */
export async function bakeObjectThumbnails({
  renderer,
  items,
  environment = null,
  environmentIntensity = 0.35,
  size = 128,
  fill = 0.88,
}) {
  const out = new Map();
  if (!renderer || !Array.isArray(items)) return out;

  const rt = new THREE.RenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.SRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    samples: 4,
  });

  const scene = new THREE.Scene();
  if (environment) {
    scene.environment = environment;
    scene.environmentIntensity = environmentIntensity;
  }
  const hemi = new THREE.HemisphereLight(0xb8dfff, 0x3d6b20, 0.9);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xfff8e8, 1.4);
  dir.position.set(5, 12, 4);
  scene.add(dir);

  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 5000);
  const group = new THREE.Group();
  scene.add(group);

  const box = new THREE.Box3();
  const sphere = new THREE.Sphere();
  const center = new THREE.Vector3();
  const camDir = new THREE.Vector3(0.72, 0.55, 0.95).normalize();

  const prevTarget = renderer.getRenderTarget();
  const prevClearAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);

  const clearGroup = () => {
    group.position.set(0, 0, 0);
    while (group.children.length) group.children.pop();
  };

  try {
    for (const item of items) {
      if (!item?.make) continue;
      clearGroup();
      group.add(item.make());

      box.setFromObject(group);
      if (!box.isEmpty()) group.position.y -= box.min.y;

      box.setFromObject(group);
      if (box.isEmpty()) continue;

      box.getBoundingSphere(sphere);
      center.copy(sphere.center);
      const r = Math.max(sphere.radius, 0.5);
      const halfFov = THREE.MathUtils.degToRad(camera.fov) * 0.5;
      const dist = r / (Math.tan(halfFov) * fill);
      camera.position.copy(center).addScaledVector(camDir, dist);
      camera.lookAt(center);
      camera.updateMatrixWorld(true);

      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      const buf = await renderer.readRenderTargetPixelsAsync(
        rt,
        0,
        0,
        size,
        size,
      );
      out.set(
        item.key,
        pixelsToDataURL(new Uint8Array(buf.buffer ?? buf), size),
      );
    }
  } catch (err) {
    console.warn("[Arborist] thumbnail bake failed:", err);
  } finally {
    clearGroup();
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(0x000000, prevClearAlpha);
    rt.dispose();
  }

  return out;
}

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
