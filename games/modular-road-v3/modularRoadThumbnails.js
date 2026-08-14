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
 * (replacing the hand-drawn SVG silhouettes). Returns Map(key -> PNG Blob); no
 * files to manage. The same render path can later be promoted to an offline PNG
 * bake for the v2 port.
 *
 * Blobs, not data-URLs, because the result is persisted: modularRoadThumbnailCache
 * keeps them in IndexedDB as binary, and the palette wants object URLs anyway —
 * see blobsToUrls(). This is the expensive path (a GPU readback per item); the
 * cache is what keeps it off the startup sequence.
 *
 * @param {object} o
 * @param {THREE.WebGPURenderer} o.renderer
 * @param {{road:THREE.Material, rail?:THREE.Material, shell?:THREE.Material, decor?:THREE.Material}} o.materials
 * @param {{key:string, pieceId?:string, params?:object, make?:()=>THREE.Object3D}[]} o.items
 * @param {THREE.Texture} [o.environment] optional IBL (the main scene's PMREM) for correct lighting
 * @param {number} [o.size=128]
 * @returns {Promise<Map<string,Blob>>}
 */
export async function bakeRoadThumbnails({
  renderer, materials, items, environment = null, size = 128,
}) {
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

  // Renderer state is borrowed FOR ONE SYNCHRONOUS RENDER AT A TIME and handed
  // straight back (see the per-item block below), never held across an await.
  // This bake now runs in the background with the editor's own frame loop live,
  // and the loop draws in the gaps between tiles: leaving the thumbnail RT bound
  // — or the transparent clear colour set — across an await means those frames
  // land in a 192px offscreen buffer instead of on screen.
  const prevClear = new THREE.Color();

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
        addMesh(built.glassGeometry, materials.glass);
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

      const prevTarget = renderer.getRenderTarget();
      renderer.getClearColor(prevClear);
      const prevClearAlpha = renderer.getClearAlpha();
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0); // transparent thumbnails
      renderer.render(scene, camera); // renderer already init()-ed (renderAsync is deprecated)
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevClearAlpha);

      // Readback takes `rt` explicitly, so it does not need the target bound —
      // which is what lets the state go back before this await yields a frame.
      // r0.184: returns the pixel buffer (Uint8Array for UnsignedByteType).
      const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size);
      const blob = await pixelsToBlob(new Uint8Array(buf.buffer ?? buf), size);
      if (blob) out.set(item.key, blob);
    }
  } catch (err) {
    console.warn("[modular-road] thumbnail bake failed; falling back to SVG.", err);
  } finally {
    clearGroup();
    rt.dispose();
  }

  return out;
}

/** RGBA byte buffer → PNG Blob via a 2D canvas. WebGPU readRenderTargetPixelsAsync
 *  returns top-first rows (same as canvas ImageData); do not flip Y (that was for WebGL).
 *
 *  toBlob, not toDataURL: the PNG encode is the second-biggest cost per tile and
 *  toDataURL runs it synchronously on the main thread, then base64s the result
 *  (a third bigger, and it would go into IndexedDB that way too). */
function pixelsToBlob(buf, size) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  img.data.set(buf.subarray(0, size * size * 4));
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/**
 * Map(key -> Blob) → Map(key -> object URL) for use as an <img src>, revoking
 * whatever a previous call handed out.
 *
 * The palette holds these for the life of the page, so the only leak that
 * matters is a rebake replacing a live set — hence `previous`.
 *
 * @param {Map<string,Blob>} tiles
 * @param {Map<string,string>|null} [previous] URLs to revoke once replaced
 * @returns {Map<string,string>}
 */
export function blobsToUrls(tiles, previous = null) {
  const urls = new Map();
  for (const [key, blob] of tiles) urls.set(key, URL.createObjectURL(blob));
  if (previous) for (const url of previous.values()) URL.revokeObjectURL(url);
  return urls;
}
