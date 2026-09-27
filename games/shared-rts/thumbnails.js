// Thumbnail baker for RTS UI tiles — GAME code. Renders each unit model to a
// RenderTarget with the engine's WebGPU renderer and returns an image URL.
// Ported from the rts-chibs rtsThumbnails baker.
import * as THREE from "three";

/**
 * The thumbnail key for anything selectable. Units by type; structures under
 * "struct:" (structureThumbnails.js) — the enemy's by team too, since its
 * "turret" is a DShK nest, not the player's M60 pit.
 */
export function thumbKeyOf(e) {
  if (!e?.isStructure) return e?.typeKey;
  return e.team === "enemy" ? `struct:enemy:${e.typeKey}` : `struct:${e.typeKey}`;
}

/**
 * @param {object} o
 * @param {THREE.WebGPURenderer} o.renderer
 * @param {{key:string, make:()=>THREE.Object3D}[]} o.items
 * @returns {Promise<Map<string,string>>}  key → PNG blob URL (img src / CSS url())
 */
export async function bakeThumbnails({ renderer, items, size = 256, fill = 0.9 }) {
  const out = new Map();
  if (!renderer || !Array.isArray(items)) return out;

  // No MSAA — readRenderTargetPixelsAsync on a multi-sample WebGPU target reads
  // the unresolved buffer and returns garbage (see v2/tools/objectThumbnails.js).
  //
  // ONE TARGET PER PORTRAIT, READ BACK TOGETHER. A readback is a GPU round
  // trip (~115 ms here) almost regardless of size, and this used to render,
  // AWAIT the readback, then render the next — ~30 portraits in series, most
  // of the "Building unit visuals" boot stage spent waiting. Rendering every
  // portrait into its own small target first and then awaiting all the
  // readbacks at once lets those waits overlap. (256² RGBA × ~30 ≈ 8 MB, freed
  // before this returns.)
  const makeRT = () => new THREE.RenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.SRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const targets = [];

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

  const pending = [];   // { key, read: Promise<pixels> }
  try {
    for (const item of items) {
      if (!item?.make) continue;
      clearGroup();
      group.add(item.make());

      // SkeletonUtils.clone leaves boneMatrices zeroed. Box3.setFromObject for a
      // SkinnedMesh skins vertices on the CPU from those matrices, so without an
      // update the AABB collapses to ~origin (feet) while the GPU render still
      // poses the full body — camera zooms into the boots.
      prepareSkinnedBounds(group);

      box.setFromObject(group);
      if (!box.isEmpty()) group.position.y -= box.min.y; // sit on y=0
      prepareSkinnedBounds(group);
      box.setFromObject(group);
      if (box.isEmpty()) continue;

      box.getBoundingSphere(sphere);
      center.copy(sphere.center);
      const r = Math.max(sphere.radius, 0.5);
      const dist = r / (Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * fill);
      camera.position.copy(center).addScaledVector(camDir, dist);
      camera.lookAt(center);
      camera.updateMatrixWorld(true);

      const rt = makeRT();
      targets.push(rt);
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      // Started, NOT awaited: the copy is queued behind this render, and the
      // group can be refilled for the next portrait straight away.
      pending.push({ key: item.key, read: renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size) });
    }
    // No await inside the loop above, so the game loop (which shares this
    // renderer) never ran between a setRenderTarget and its render.
    renderer.setRenderTarget(prevTarget);
    const bufs = await Promise.all(pending.map((p) => p.read));
    const urls = await Promise.all(bufs.map((b) => pixelsToImageURL(b, size)));
    pending.forEach((p, i) => out.set(p.key, urls[i]));
  } catch (err) {
    console.warn("[rts-v3] thumbnail bake failed; tiles will show text.", err);
  } finally {
    clearGroup();
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(0x000000, prevClearAlpha);
    for (const rt of targets) rt.dispose();
  }
  return out;
}

/** Update bone matrices and clear cached AABBs so setFromObject frames skinned meshes. */
function prepareSkinnedBounds(root) {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isSkinnedMesh || !o.skeleton) return;
    o.skeleton.update();
    o.boundingBox = null;
    o.boundingSphere = null;
  });
}

/**
 * Pixels → an image URL the UI can use as `<img src>` or CSS `url()`.
 *
 * A BLOB URL, encoded by OffscreenCanvas.convertToBlob — asynchronous, off the
 * main thread. It used to be canvas.toDataURL("image/png"): a synchronous PNG
 * encode, 1.8 s of main thread for the 24 portraits at boot (the biggest item
 * in the trace after three's node building). The blobs live for the page,
 * like the data URLs did.
 */
async function pixelsToImageURL(buf, size) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  const tightRow = size * 4;

  if (buf instanceof Float32Array) {
    const n = tightRow * size;
    for (let i = 0; i < n; i++) img.data[i] = Math.max(0, Math.min(255, buf[i] * 255 + 0.5)) | 0;
  } else {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer ?? buf);
    // WebGPU copyTextureToBuffer pads each row to a 256-byte boundary.
    const alignedRow = Math.ceil(tightRow / 256) * 256;
    if (u8.length > tightRow * size) {
      for (let y = 0; y < size; y++)
        img.data.set(u8.subarray(y * alignedRow, y * alignedRow + tightRow), y * tightRow);
    } else {
      img.data.set(u8.subarray(0, tightRow * size));
    }
  }
  ctx.putImageData(img, 0, 0);
  return URL.createObjectURL(await canvas.convertToBlob({ type: "image/png" }));
}
