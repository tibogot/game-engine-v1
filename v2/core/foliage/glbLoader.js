/**
 * GLB/GLTF loader utility for tree models.
 *
 * Loads a GLB file and extracts submesh data (geometry, material, localMatrix)
 * suitable for InstancedMesh rendering.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";

const _draco = new DRACOLoader();
_draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
_draco.setDecoderConfig({ type: "js" });

const _loader = new GLTFLoader();
_loader.setDRACOLoader(_draco);

export function getSharedGltfLoader() { return _loader; }

let _ktx2Ready = false;

/** Must be called once with the WebGPU renderer before loading KTX2-textured GLBs. */
export function initGlbLoaderRenderer(renderer) {
  if (_ktx2Ready) return;
  const ktx2 = new KTX2Loader();
  ktx2.setTranscoderPath("https://www.gstatic.com/basis-universal/versioned/2021-04-15-ba1c3e4/");
  ktx2.detectSupport(renderer);
  _loader.setKTX2Loader(ktx2);
  _ktx2Ready = true;
}

/**
 * Load a GLB from a File object (user-imported) and extract submesh data.
 * @param {File} file
 * @returns {Promise<{ submeshes: Array<{geometry: THREE.BufferGeometry, material: THREE.Material, localMatrix: THREE.Matrix4}>, name: string }>}
 */
export function loadTreeGlbFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    _loader.load(
      url,
      (gltf) => {
        URL.revokeObjectURL(url);
        const submeshes = extractSubmeshes(gltf.scene);
        resolve({ submeshes, name: file.name.replace(/\.\w+$/, "") });
      },
      undefined,
      (err) => {
        URL.revokeObjectURL(url);
        reject(err);
      },
    );
  });
}

/**
 * Load a GLB from a URL path (built-in default trees).
 * @param {string} url
 * @returns {Promise<{ submeshes: Array<{geometry: THREE.BufferGeometry, material: THREE.Material, localMatrix: THREE.Matrix4}> }>}
 */
export function loadTreeGlbFromUrl(url) {
  return new Promise((resolve, reject) => {
    _loader.load(
      url,
      (gltf) => {
        const submeshes = extractSubmeshes(gltf.scene);
        resolve({ submeshes });
      },
      undefined,
      reject,
    );
  });
}

/**
 * Open file picker for GLB files and return the chosen File (or null).
 */
export function openGlbPicker() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".glb,.gltf";
    input.style.display = "none";
    input.addEventListener("change", () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

function extractSubmeshes(root) {
  const submeshes = [];
  root.updateMatrixWorld(true);
  root.traverse((child) => {
    if (!child.isMesh) return;
    const geo = child.geometry.clone();
    const mat = child.material.clone?.() ?? child.material;
    fixFoliageTransparency(mat);
    const localMatrix = child.matrixWorld.clone();
    submeshes.push({ geometry: geo, material: mat, localMatrix });
  });
  return submeshes;
}

function fixFoliageTransparency(mat) {
  if (!mat.alphaMap && !mat.map) return;
  if (mat.transparent || mat.alphaTest > 0 || (mat.map && mat.map.format === THREE.RGBAFormat)) {
    mat.transparent = false;
    mat.alphaTest = mat.alphaTest > 0 ? mat.alphaTest : 0.5;
    mat.depthWrite = true;
    mat.side = THREE.DoubleSide;
  }
}
