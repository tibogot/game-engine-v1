// ============================================================================
// LED DISPLAY — a new scenery prop, left apart from LED board / Billboard /
// Ad billboard on purpose. Those stay frozen until this one proves the split:
//
//   • Frame and legs stay instanced for every placement.
//   • A board still on the default chevron stays in that cheap face batch.
//   • Only a board you author (text or image) leaves the batch, and only the
//     FACE does — a cloned LED material, not a rebuilt shader graph for the
//     whole prop.
//
// The lab LED object already supports source/text/image as uniforms. This file
// is the road-builder adapter: per-placement content, unique face material,
// shared everything else.
// ============================================================================
import * as THREE from "three";
import {
  applyLedMatrixParams,
  makeLedMatrixMaterial,
  makeTextTexture,
} from "../../v2/objects/shared/ledMatrix.js";
import { advertFileToDataUrl } from "./modularRoadAdBillboard.js";

/** Physical board — same stamp as the frozen LED board, so the comparison is fair. */
export const LED_DISPLAY_PARAMS = {
  source: "chevron",
  boardW: 7.2,
  boardH: 2.2,
  standHeight: 2.6,
  legs: true,
  cols: 84,
  rows: 24,
  shape: "round",
};

export const LED_DISPLAY_CONTENT_DEFAULTS = {
  source: "chevron", // chevron | text | image
  text: "RACE  •  CHAMPIONS  •  ",
  image: null, // JPEG data URL, saved with the track
  rgb: false,
  threshold: 0.5,
  panSpeed: 0.4,
};

/** True when this placement cannot share the instanced chevron face. */
export function isLedDisplayUnique(content) {
  const src = content?.source ?? "chevron";
  return src === "text" || src === "image";
}

export function findLedDisplayFace(root) {
  let found = null;
  root?.traverse((o) => {
    if (o.userData?.ledDisplayFace) found = o;
  });
  return found;
}

/**
 * After flatten/merge, tag the LED panel so the instancer can instance the
 * frame and leave this mesh out of the face batch when it is authored.
 */
export function tagLedDisplayFace(root) {
  const W = root.userData?.ledMatrix?.boardW ?? LED_DISPLAY_PARAMS.boardW;
  const H = root.userData?.ledMatrix?.boardH ?? LED_DISPLAY_PARAMS.boardH;
  root.traverse((o) => {
    if (!o.isMesh || !o.material?.userData?.led) return;
    o.name = "LedDisplayFace";
    o.userData.ledDisplayFace = true;
    o.userData.ledBoardW = W;
    o.userData.ledBoardH = H;
    o.userData.noCastShadow = true;
    o.castShadow = false;
  });
}

let _dummy = null;
function dummyTexture() {
  if (_dummy) return _dummy;
  _dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
  _dummy.needsUpdate = true;
  return _dummy;
}

function dropOwnedTexture(mat) {
  const tex = mat?.userData?.led?.contentNode?.value;
  if (tex?.userData?.ledOwned) {
    tex.dispose();
    if (mat.userData.led.contentNode) mat.userData.led.contentNode.value = dummyTexture();
  }
}

function disposeOwnedFace(mesh) {
  if (!mesh.userData.ledFaceOwned || !mesh.material) return;
  dropOwnedTexture(mesh.material);
  mesh.material.dispose();
  mesh.userData.ledFaceOwned = false;
}

function boardParams(content) {
  return {
    ...LED_DISPLAY_PARAMS,
    ...LED_DISPLAY_CONTENT_DEFAULTS,
    ...content,
    useRamp: true,
    mode: content?.source ?? "chevron",
  };
}

function bindContent(mat, texture, aspect, content) {
  const led = mat.userData?.led;
  if (!led) return;
  dropOwnedTexture(mat);
  led.contentNode.value = texture || dummyTexture();
  led.sourceAspect = aspect || 1;
  const W = LED_DISPLAY_PARAMS.boardW;
  const H = LED_DISPLAY_PARAMS.boardH;
  applyLedMatrixParams(mat, boardParams(content), W, H);
}

function uniquifyFace(mesh) {
  if (mesh.userData.ledFaceOwned) return mesh.material;
  const shared = mesh.userData.ledSharedMaterial ?? mesh.material;
  mesh.userData.ledSharedMaterial = shared;
  const W = mesh.userData.ledBoardW ?? LED_DISPLAY_PARAMS.boardW;
  const H = mesh.userData.ledBoardH ?? LED_DISPLAY_PARAMS.boardH;
  mesh.material = makeLedMatrixMaterial({
    boardW: W,
    boardH: H,
    params: boardParams({ source: "chevron" }),
    contentTexture: null,
    sourceAspect: 1,
  });
  mesh.userData.ledFaceOwned = true;
  return mesh.material;
}

function restoreSharedFace(mesh) {
  const shared = mesh.userData.ledSharedMaterial;
  if (!shared || mesh.material === shared) return;
  disposeOwnedFace(mesh);
  mesh.material = shared;
}

/**
 * Push `content` onto this placement's LED face. Chevron restores the shared
 * template material. Text/image clones a face material once, then writes
 * uniforms and the content texture — the compiled LED program is not rebuilt
 * on every keystroke.
 */
export function applyLedDisplayContent(root, content) {
  const mesh = findLedDisplayFace(root);
  if (!mesh) return;
  const p = { ...LED_DISPLAY_CONTENT_DEFAULTS, ...content };
  mesh.userData.ledContentGen = (mesh.userData.ledContentGen | 0) + 1;
  const gen = mesh.userData.ledContentGen;

  if (!isLedDisplayUnique(p)) {
    restoreSharedFace(mesh);
    return;
  }

  uniquifyFace(mesh);

  if (p.source === "text") {
    const { texture, aspect } = makeTextTexture(p.text);
    bindContent(mesh.material, texture, aspect, p);
    return;
  }

  // Image: switch the unique face to image mode immediately so we don't keep
  // drawing the shared chevron on a mesh that just left the instance batch.
  bindContent(mesh.material, null, 1, p);
  if (!p.image) return;

  const loader = new THREE.TextureLoader();
  loader.load(p.image, (tex) => {
    if (mesh.userData.ledContentGen !== gen) {
      tex.dispose();
      return;
    }
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.userData.ledOwned = true;
    const img = tex.image;
    const aspect = img?.width && img?.height ? img.width / img.height : 1;
    bindContent(mesh.material, tex, aspect, p);
  });
}

/** Fit an upload to the board aspect and return a JPEG data URL. */
export function ledDisplayFileToDataUrl(file) {
  const W = 1024;
  const H = Math.max(256, Math.round(W * LED_DISPLAY_PARAMS.boardH / LED_DISPLAY_PARAMS.boardW));
  return advertFileToDataUrl(file, W, H);
}
