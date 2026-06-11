import * as THREE from "three";

const TEX_RES = 1024;

/**
 * Build two DataArrayTextures (albedo + ORM) from TextureLibrary slots.
 * Each array has `slotIds.length` layers, one per paint overlay layer.
 *
 * @param {ReturnType<import("../textures/textureLibrary.js").createTextureLibrary>} textureLibrary
 * @param {string[]} slotIds — 7 slot IDs for overlay layers 1..7
 * @returns {{ albedoArrayTex: THREE.DataArrayTexture, ormArrayTex: THREE.DataArrayTexture }}
 */
export function buildLayerArrayTextures(textureLibrary, slotIds) {
  const count = slotIds.length;
  const pixels = TEX_RES * TEX_RES;
  const stride = pixels * 4;

  const albedoData = new Uint8Array(stride * count);
  const ormData = new Uint8Array(stride * count);

  const tmpCanvas = document.createElement("canvas");
  tmpCanvas.width = tmpCanvas.height = TEX_RES;
  const tmpCtx = tmpCanvas.getContext("2d", { willReadFrequently: true });

  for (let i = 0; i < count; i++) {
    const slot = textureLibrary.getSlot(slotIds[i]);
    if (!slot) continue;
    const off = i * stride;

    // Albedo: read CanvasTexture image data
    const albCanvas = slot.albedoTex.image;
    tmpCtx.clearRect(0, 0, TEX_RES, TEX_RES);
    tmpCtx.drawImage(albCanvas, 0, 0, TEX_RES, TEX_RES);
    const srcAlb = tmpCtx.getImageData(0, 0, TEX_RES, TEX_RES).data;
    albedoData.set(srcAlb, off);

    // ORM: DataTexture — copy directly
    const srcOrm = slot.ormTex.image.data;
    ormData.set(srcOrm.subarray(0, stride), off);
  }

  const albedoArrayTex = new THREE.DataArrayTexture(albedoData, TEX_RES, TEX_RES, count);
  albedoArrayTex.format = THREE.RGBAFormat;
  albedoArrayTex.type = THREE.UnsignedByteType;
  albedoArrayTex.wrapS = albedoArrayTex.wrapT = THREE.RepeatWrapping;
  albedoArrayTex.minFilter = THREE.LinearMipMapLinearFilter;
  albedoArrayTex.magFilter = THREE.LinearFilter;
  albedoArrayTex.colorSpace = THREE.SRGBColorSpace;
  albedoArrayTex.generateMipmaps = true;
  albedoArrayTex.needsUpdate = true;

  const ormArrayTex = new THREE.DataArrayTexture(ormData, TEX_RES, TEX_RES, count);
  ormArrayTex.format = THREE.RGBAFormat;
  ormArrayTex.type = THREE.UnsignedByteType;
  ormArrayTex.wrapS = ormArrayTex.wrapT = THREE.RepeatWrapping;
  ormArrayTex.minFilter = THREE.LinearMipMapLinearFilter;
  ormArrayTex.magFilter = THREE.LinearFilter;
  ormArrayTex.colorSpace = THREE.LinearSRGBColorSpace;
  ormArrayTex.generateMipmaps = true;
  ormArrayTex.needsUpdate = true;

  return { albedoArrayTex, ormArrayTex };
}
