// Thumbnail baker for RTS UI tiles — GAME code. Renders each unit model to a
// RenderTarget with the engine's WebGPU renderer and returns a data-URL image.
// Ported from the rts-chibs rtsThumbnails baker.
import * as THREE from "three";

/**
 * @param {object} o
 * @param {THREE.WebGPURenderer} o.renderer
 * @param {{key:string, make:()=>THREE.Object3D}[]} o.items
 * @returns {Promise<Map<string,string>>}  key → PNG data URL
 */
export async function bakeThumbnails({ renderer, items, size = 256, fill = 0.9 }) {
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
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444455, 1.1);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(5, 9, 6);
  scene.add(dir);

  const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 5000);
  const group = new THREE.Group();
  scene.add(group);

  const box = new THREE.Box3();
  const sphere = new THREE.Sphere();
  const center = new THREE.Vector3();
  const camDir = new THREE.Vector3(0.78, 0.82, 0.95).normalize();

  const prevTarget = renderer.getRenderTarget();
  const prevClearAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);

  // Never dispose geometries here — make() returns clones sharing the template's
  // GPU buffers with live units; disposing would destroy them mid-frame.
  const clearGroup = () => { group.position.set(0, 0, 0); while (group.children.length) group.children.pop(); };

  try {
    for (const item of items) {
      if (!item?.make) continue;
      clearGroup();
      group.add(item.make());

      box.setFromObject(group);
      if (!box.isEmpty()) group.position.y -= box.min.y; // sit on y=0
      box.setFromObject(group);
      if (box.isEmpty()) continue;

      box.getBoundingSphere(sphere);
      center.copy(sphere.center);
      const r = Math.max(sphere.radius, 0.5);
      const dist = r / (Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * fill);
      camera.position.copy(center).addScaledVector(camDir, dist);
      camera.lookAt(center);
      camera.updateMatrixWorld(true);

      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size);
      out.set(item.key, pixelsToDataURL(new Uint8Array(buf.buffer ?? buf), size));
    }
  } catch (err) {
    console.warn("[rts-v3] thumbnail bake failed; tiles will show text.", err);
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
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  img.data.set(buf.subarray(0, size * size * 4));
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}
