import * as THREE from "three";
import { materialColor } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";

/**
 * Trackside advertising billboard — two posts, catwalk, flood cans, a framed
 * poster. The poster is a real map so a placement can wear its own image;
 * that is also why this type is not instanced (one material cannot hold five
 * different ads).
 */

export const AD_BILLBOARD = {
  panelW: 8.0,
  panelH: 4.5,
  panelBottom: 3.15,
  frame: 0.22,
  frameZ: 0.16,
  post: 0.22,
};

const POSTER_PX_W = 1024;
const POSTER_PX_H = 576;
const TOTEM_PX_W = 640;
const TOTEM_PX_H = 1024;

function posterMat(map) {
  const m = new THREE.MeshBasicNodeMaterial({
    color: new THREE.Color(0xffffff),
    map,
  });
  m.map = map;
  m.colorNode = materialColor;
  m.toneMapped = true;
  return m;
}

function propMat(hex, opts = {}) {
  const m = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(hex),
    roughness: opts.roughness ?? 0.55,
    metalness: opts.metalness ?? 0.35,
    emissive: new THREE.Color(opts.emissive ?? 0x000000),
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    map: opts.map ?? null,
    side: opts.side ?? THREE.FrontSide,
  });
  m.envMapIntensity = 0;
  m.colorNode = materialColor;
  if (opts.bloom) applyBloomMRT(m, materialColor);
  return m;
}

const _placeholders = new Map();
function placeholderTexture(w = POSTER_PX_W, h = POSTER_PX_H) {
  const key = `${w}x${h}`;
  const hit = _placeholders.get(key);
  if (hit) return hit;
  if (typeof document === "undefined") {
    const tex = new THREE.DataTexture(new Uint8Array([18, 20, 26, 255]), 1, 1);
    tex.needsUpdate = true;
    _placeholders.set(key, tex);
    return tex;
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#12141a";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#252a36";
  ctx.lineWidth = Math.max(24, w * 0.04);
  for (let x = -h; x < w + h; x += Math.round(w * 0.09)) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + h, h);
    ctx.stroke();
  }
  const m = Math.round(Math.min(w, h) * 0.06);
  ctx.strokeStyle = "#c8a44a";
  ctx.lineWidth = 8;
  ctx.strokeRect(m, m, w - m * 2, h - m * 2);
  ctx.strokeStyle = "#3a4150";
  ctx.lineWidth = 3;
  ctx.strokeRect(m + 14, m + 14, w - (m + 14) * 2, h - (m + 14) * 2);
  ctx.fillStyle = "#e8ecf4";
  ctx.font = `700 ${Math.round(w * 0.09)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("YOUR AD", w / 2, h / 2 - h * 0.04);
  ctx.fillText("HERE", w / 2, h / 2 + h * 0.06);
  ctx.fillStyle = "#8b93a7";
  ctx.font = `500 ${Math.round(w * 0.035)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText("Select · Upload image", w / 2, h / 2 + h * 0.16);
  const data = ctx.getImageData(0, 0, w, h);
  const tex = new THREE.DataTexture(data.data, w, h);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = true;
  tex.needsUpdate = true;
  tex.anisotropy = 8;
  tex.userData.adOwned = false;
  _placeholders.set(key, tex);
  return tex;
}

function boxAt(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function merge(parts) {
  const geo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return geo;
}

/**
 * @param {{ params?: object }} [o]
 * @returns {THREE.Group}
 */
export function buildAdBillboardMesh({ params = {} } = {}) {
  const p = { ...AD_BILLBOARD, ...params };
  const W = p.panelW;
  const H = p.panelH;
  const y0 = p.panelBottom;
  const cy = y0 + H * 0.5;
  const ft = p.frame;
  const fz = p.frameZ;
  const post = p.post;
  const postX = W * 0.34;
  const postH = y0 + H + 0.55;

  const steel = [];
  const dark = [];

  // Twin posts — square tube, slight splay in Z so they plant behind the face.
  for (const sx of [-1, 1]) {
    steel.push(boxAt(post, postH, post, sx * postX, postH * 0.5, -0.38));
    // Base plate
    steel.push(boxAt(0.72, 0.1, 0.72, sx * postX, 0.05, -0.38));
    // Cap
    steel.push(boxAt(post + 0.08, 0.08, post + 0.08, sx * postX, postH + 0.04, -0.38));
  }
  // Horizontal ties between the posts.
  steel.push(boxAt(postX * 2 + post, 0.18, 0.14, 0, y0 + 0.35, -0.72));
  steel.push(boxAt(postX * 2 + post, 0.14, 0.12, 0, cy, -0.7));

  // Panel back
  dark.push(boxAt(W + 0.08, H + 0.08, 0.1, 0, cy, -0.08));

  // Frame: four bars around the artwork
  const inset = 0.04;
  steel.push(boxAt(W + ft * 2, ft, fz, 0, cy + H * 0.5 + ft * 0.5, 0.02));
  steel.push(boxAt(W + ft * 2, ft, fz, 0, cy - H * 0.5 - ft * 0.5, 0.02));
  steel.push(boxAt(ft, H, fz, -W * 0.5 - ft * 0.5, cy, 0.02));
  steel.push(boxAt(ft, H, fz, W * 0.5 + ft * 0.5, cy, 0.02));
  // Corner plates
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      steel.push(boxAt(0.42, 0.42, fz + 0.02, sx * (W * 0.5 + 0.02), cy + sy * (H * 0.5 + 0.02), 0.04));
    }
  }

  // Catwalk under the face (in front), with kickplate and rail
  const walkY = y0 - 0.08;
  const walkZ = 0.62;
  dark.push(boxAt(W + 0.5, 0.06, 0.95, 0, walkY, walkZ));
  dark.push(boxAt(W + 0.5, 0.12, 0.04, 0, walkY + 0.09, walkZ + 0.46)); // kick
  // Rail posts + top rail
  const railY = walkY + 0.55;
  for (let i = 0; i < 7; i++) {
    const x = -W * 0.48 + (i / 6) * W * 0.96;
    steel.push(boxAt(0.04, 0.52, 0.04, x, walkY + 0.32, walkZ + 0.44));
  }
  steel.push(boxAt(W + 0.4, 0.04, 0.04, 0, railY, walkZ + 0.44));
  steel.push(boxAt(W + 0.4, 0.03, 0.03, 0, walkY + 0.28, walkZ + 0.44));

  // Ladder on the left post
  const lx = -postX;
  for (let i = 0; i < 12; i++) {
    const y = 0.35 + i * 0.55;
    if (y > y0 - 0.2) break;
    steel.push(boxAt(0.42, 0.035, 0.035, lx, y, 0.05));
  }
  steel.push(boxAt(0.05, y0 - 0.15, 0.05, lx - 0.2, (y0 - 0.15) * 0.5, 0.05));
  steel.push(boxAt(0.05, y0 - 0.15, 0.05, lx + 0.2, (y0 - 0.15) * 0.5, 0.05));

  // Flood-can housings (merged with the steel so they actually draw)
  const bulbs = [];
  for (let i = 0; i < 4; i++) {
    const x = -W * 0.36 + (i / 3) * W * 0.72;
    const can = new THREE.CylinderGeometry(0.11, 0.13, 0.22, 10);
    can.rotateX(-0.85);
    can.translate(x, walkY + 0.22, walkZ + 0.12);
    steel.push(can);
    const bulb = new THREE.CircleGeometry(0.09, 12);
    bulb.rotateX(-0.85 + Math.PI / 2);
    bulb.translate(x, walkY + 0.32, walkZ + 0.02);
    bulbs.push(bulb);
  }

  const steelMesh = new THREE.Mesh(
    merge(steel),
    propMat(0x1c2028, { roughness: 0.42, metalness: 0.72 }),
  );
  steelMesh.name = "AdBoardSteel";
  steelMesh.castShadow = true;
  steelMesh.receiveShadow = false;

  const darkMesh = new THREE.Mesh(
    merge(dark),
    propMat(0x0c0d10, { roughness: 0.85, metalness: 0.15 }),
  );
  darkMesh.name = "AdBoardBack";
  darkMesh.castShadow = true;

  // Poster — unique material per placement (cloned in makeSceneryProp).
  const pw = W - inset * 2;
  const ph = H - inset * 2;
  const poster = new THREE.Mesh(
    new THREE.PlaneGeometry(pw, ph),
    posterMat(placeholderTexture()),
  );
  poster.name = "AdBoardPoster";
  poster.position.set(0, cy, 0.095);
  poster.userData.adPoster = true;
  poster.userData.adPx = [POSTER_PX_W, POSTER_PX_H];
  poster.userData.noCollide = true;
  poster.castShadow = false;

  const bulbMesh = new THREE.Mesh(
    merge(bulbs),
    propMat(0xffe2a8, {
      roughness: 0.4,
      metalness: 0,
      emissive: 0xffe2a8,
      emissiveIntensity: 4.5,
      bloom: true,
    }),
  );
  bulbMesh.name = "AdBoardBulbs";
  bulbMesh.castShadow = false;
  bulbMesh.userData.noCastShadow = true;
  bulbMesh.userData.noCollide = true;

  const group = new THREE.Group();
  group.name = "AdBillboard";
  group.add(steelMesh, darkMesh, poster, bulbMesh);
  return group;
}

export const AD_TOTEM = {
  panelW: 1.28,
  panelH: 2.22,
  baseH: 0.14,
  frame: 0.09,
  depth: 0.16,
};

/**
 * Bus-stop citylight — portrait poster in a slim ground cabinet. No masts,
 * no catwalk. Same upload path as the big board (`userData.adPoster`).
 */
export function buildAdTotemMesh({ params = {} } = {}) {
  const p = { ...AD_TOTEM, ...params };
  const W = p.panelW;
  const H = p.panelH;
  const base = p.baseH;
  const ft = p.frame;
  const d = p.depth;
  const cy = base + H * 0.5;

  const steel = [];
  const dark = [];

  // Plinth
  steel.push(boxAt(W + 0.28, base, d + 0.22, 0, base * 0.5, 0));
  // Cabinet back
  dark.push(boxAt(W + ft * 2, H, d * 0.55, 0, cy, -d * 0.22));
  // Frame
  steel.push(boxAt(W + ft * 2, ft, d, 0, cy + H * 0.5 + ft * 0.5, 0));
  steel.push(boxAt(W + ft * 2, ft, d, 0, cy - H * 0.5 - ft * 0.5, 0));
  steel.push(boxAt(ft, H, d, -W * 0.5 - ft * 0.5, cy, 0));
  steel.push(boxAt(ft, H, d, W * 0.5 + ft * 0.5, cy, 0));
  // Cap
  steel.push(boxAt(W + ft * 2 + 0.06, 0.05, d + 0.04, 0, base + H + ft + 0.04, 0));

  const steelMesh = new THREE.Mesh(
    merge(steel),
    propMat(0x1c2028, { roughness: 0.42, metalness: 0.72 }),
  );
  steelMesh.name = "AdTotemSteel";
  steelMesh.castShadow = true;

  const darkMesh = new THREE.Mesh(
    merge(dark),
    propMat(0x0c0d10, { roughness: 0.85, metalness: 0.12 }),
  );
  darkMesh.name = "AdTotemBack";
  darkMesh.castShadow = true;

  const inset = 0.03;
  const poster = new THREE.Mesh(
    new THREE.PlaneGeometry(W - inset * 2, H - inset * 2),
    posterMat(placeholderTexture(TOTEM_PX_W, TOTEM_PX_H)),
  );
  poster.name = "AdTotemPoster";
  poster.position.set(0, cy, d * 0.52);
  poster.userData.adPoster = true;
  poster.userData.adPx = [TOTEM_PX_W, TOTEM_PX_H];
  poster.userData.noCollide = true;
  poster.castShadow = false;

  const group = new THREE.Group();
  group.name = "AdTotem";
  group.add(steelMesh, darkMesh, poster);
  return group;
}

/**
 * Has this placement left the stock "YOUR AD HERE" placeholder?
 *
 * The instancer uses this to decide the DRAW PATH: a stock board shares one
 * instanced poster draw with every other stock board, an authored one leaves
 * that batch for a live mesh. `advert` is a data URL, or an ARRAY of them for a
 * multi-face prism — an array of nulls is still unauthored, which is the state
 * a prism sits in until someone uploads a face.
 */
export function isAdvertAuthored(advert) {
  return Array.isArray(advert) ? advert.some(Boolean) : !!advert;
}

export function findAdPoster(root) {
  let found = null;
  root?.traverse((o) => {
    if (o.userData?.adPoster) found = o;
  });
  return found;
}

/**
 * Put `dataUrl` on this board's poster, or restore the placeholder when null.
 * Safe to call on a clone whose material was already uniqued.
 */
export function setAdPosterImage(root, dataUrl) {
  const mesh = findAdPoster(root);
  if (!mesh?.material) return;
  const mat = mesh.material;
  const dropOwned = () => {
    if (mat.map?.userData?.adOwned) {
      mat.map.dispose();
      mat.map = null;
    }
  };
  if (!dataUrl) {
    dropOwned();
    const [pw, ph] = mesh.userData.adPx ?? [POSTER_PX_W, POSTER_PX_H];
    mat.map = placeholderTexture(pw, ph);
    mat.needsUpdate = true;
    return;
  }
  const loader = new THREE.TextureLoader();
  loader.load(dataUrl, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.userData.adOwned = true;
    dropOwned();
    mat.map = tex;
    mat.needsUpdate = true;
  });
}

/**
 * Fit an image file onto the poster and return a JPEG data URL.
 * Cover-crops so a square upload does not letterbox.
 *
 * @param {File} file
 * @param {number} [tw]
 * @param {number} [th]
 */
export function advertFileToDataUrl(file, tw = POSTER_PX_W, th = POSTER_PX_H) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const c = document.createElement("canvas");
      c.width = tw;
      c.height = th;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, tw, th);
      const ir = img.width / img.height;
      const tr = tw / th;
      let dw, dh, dx, dy;
      if (ir > tr) {
        dh = th;
        dw = th * ir;
        dx = (tw - dw) / 2;
        dy = 0;
      } else {
        dw = tw;
        dh = tw / ir;
        dx = 0;
        dy = (th - dh) / 2;
      }
      ctx.drawImage(img, dx, dy, dw, dh);
      resolve(c.toDataURL("image/jpeg", 0.86));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image load failed"));
    };
    img.src = url;
  });
}
