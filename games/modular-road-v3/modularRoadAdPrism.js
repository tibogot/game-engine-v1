import * as THREE from "three";
import {
  materialColor, attribute, uniform, positionLocal, normalLocal,
  float, vec2, vec3, max, mix, clamp, floor, sin, cos, smoothstep, step,
  texture, uv,
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
import { AD_BILLBOARD } from "./modularRoadAdBillboard.js";

/**
 * Trackside tri-vision — same mast / catwalk / flood-can language as the
 * static Ad billboard, but the face is a row of triangular prisms. Each slat
 * carries three solid colours and rolls 120° in a left-to-right stagger.
 *
 * One mesh, vertex-shader rotation (same trick as the track flags): a handful
 * of draws, no InstancedMesh, and the flip survives the scenery merge. Each
 * face can wear its own image; the default is a solid colour so the motion
 * reads before anything is uploaded.
 */

export const AD_PRISM = {
  ...AD_BILLBOARD,
  slats: 30,
  gap: 0.012,
  rest: 3.25,
  flip: 0.72,
  stagger: 0.048,
  scale: 2,
};

const TURN = (Math.PI * 2) / 3;

const FACE_HEX = [0xd32f2f, 0x1565c0, 0xf9a825];
const CAP_HEX = 0x12141a;
const RIM_HEX = 0x1a1d24;
export const PRISM_PX = [1024, 576];
const FACE_COUNT = 3;

function propMat(hex, opts = {}) {
  const m = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(hex),
    roughness: opts.roughness ?? 0.55,
    metalness: opts.metalness ?? 0.35,
    emissive: new THREE.Color(opts.emissive ?? 0x000000),
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    side: opts.side ?? THREE.FrontSide,
  });
  m.envMapIntensity = 0;
  m.colorNode = materialColor;
  if (opts.bloom) applyBloomMRT(m, materialColor);
  return m;
}

const _placeholders = [null, null, null];
function facePlaceholder(i) {
  if (_placeholders[i]) return _placeholders[i];
  const hex = FACE_HEX[i] ?? 0x222222;
  if (typeof document === "undefined") {
    const col = new THREE.Color(hex);
    const tex = new THREE.DataTexture(new Uint8Array([
      Math.round(col.r * 255), Math.round(col.g * 255), Math.round(col.b * 255), 255,
    ]), 1, 1);
    tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    _placeholders[i] = tex;
    return tex;
  }
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 8;
  const ctx = c.getContext("2d");
  ctx.fillStyle = `#${hex.toString(16).padStart(6, "0")}`;
  ctx.fillRect(0, 0, 8, 8);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  _placeholders[i] = tex;
  return tex;
}

function bindPrismColor(mat, maps) {
  const face = attribute("aFace", "float");
  const slat = attribute("aSlat", "float");
  const nSlats = float(AD_PRISM.slats);
  const base = uv();
  const stu = vec2(slat.add(base.x).div(nSlats), base.y);
  const nodes = maps.map((t) => texture(t, stu));
  const sampled = mix(mix(nodes[0], nodes[1], step(0.5, face)), nodes[2], step(1.5, face));
  // Rims/caps stay dark metal. Ad faces use the texture alone — vertexColors
  // would multiply the default red/blue/yellow on top of an upload.
  const rim = vec3(0.09, 0.1, 0.12);
  const useMap = step(float(0), face);
  mat.colorNode = mix(rim, sampled.xyz, useMap);
  mat.userData.adMaps = maps;
  mat.userData.adTexNodes = nodes;
}

function slatMat() {
  const m = new THREE.MeshBasicNodeMaterial({
    color: new THREE.Color(0xffffff),
  });
  m.toneMapped = true;

  const uTime = uniform(0);
  m.userData.uTime = uTime;
  armPrismClock(uTime);
  bindPrismColor(m, [0, 1, 2].map(facePlaceholder));

  const idx = attribute("aSlat", "float");
  const center = attribute("aCenter", "vec3");
  const rest = float(AD_PRISM.rest);
  const flip = float(AD_PRISM.flip);
  const cycle = rest.add(flip);
  const raw = uTime.sub(idx.mul(AD_PRISM.stagger));
  const u = max(raw, float(0));
  const n = floor(u.div(cycle));
  const local = u.sub(n.mul(cycle));
  const extra = smoothstep(0, 1, clamp(local.sub(rest).div(flip), 0, 1))
    .mul(step(rest, local));
  const ang = mix(float(0), n.add(extra).mul(TURN), step(float(0), raw));
  const c = cos(ang);
  const s = sin(ang);

  m.positionNode = (() => {
    const p = positionLocal.sub(center);
    return vec3(
      p.x.mul(c).add(p.z.mul(s)),
      p.y,
      p.z.mul(c).sub(p.x.mul(s)),
    ).add(center);
  })();

  m.normalNode = (() => {
    const nr = normalLocal;
    return vec3(
      nr.x.mul(c).add(nr.z.mul(s)),
      nr.y,
      nr.z.mul(c).sub(nr.x.mul(s)),
    );
  })();

  return m;
}

const _clocks = new Set();
let _raf = 0;
function armPrismClock(uTime) {
  _clocks.add(uTime);
  if (_raf || typeof requestAnimationFrame !== "function") return;
  const loop = (now) => {
    _raf = requestAnimationFrame(loop);
    const t = now * 0.001;
    for (const u of _clocks) u.value = t;
  };
  _raf = requestAnimationFrame(loop);
}

function tickPrismSlats() {
  const u = this.material?.userData?.uTime;
  if (u) u.value = performance.now() * 0.001;
}

function buildSlatsGeometry(nSlats, faceW, height, x0, pitch, cy, axisZ) {
  const prism = triPrismGeometry(faceW, height);
  const parts = [];
  for (let i = 0; i < nSlats; i++) {
    const g = prism.clone();
    const cx = x0 + i * pitch;
    g.translate(cx, cy, axisZ);
    const count = g.attributes.position.count;
    const aCenter = new Float32Array(count * 3);
    const aSlat = new Float32Array(count);
    for (let v = 0; v < count; v++) {
      aCenter[v * 3] = cx;
      aCenter[v * 3 + 1] = cy;
      aCenter[v * 3 + 2] = axisZ;
      aSlat[v] = i;
    }
    g.setAttribute("aCenter", new THREE.Float32BufferAttribute(aCenter, 3));
    g.setAttribute("aSlat", new THREE.Float32BufferAttribute(aSlat, 1));
    parts.push(g);
  }
  prism.dispose();
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  return merged;
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

function hexRgb(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

function pushTri(pos, nrm, col, uvs, faces, p0, p1, p2, n, rgb, uv0, uv1, uv2, faceId) {
  pos.push(...p0, ...p1, ...p2);
  nrm.push(...n, ...n, ...n);
  col.push(...rgb, ...rgb, ...rgb);
  uvs.push(...uv0, ...uv1, ...uv2);
  faces.push(faceId, faceId, faceId);
}

function pushQuad(pos, nrm, col, uvs, faces, p0, p1, p2, p3, n, rgb, uv00, uv10, uv11, uv01, faceId) {
  pushTri(pos, nrm, col, uvs, faces, p0, p1, p2, n, rgb, uv00, uv10, uv11, faceId);
  pushTri(pos, nrm, col, uvs, faces, p0, p2, p3, n, rgb, uv00, uv11, uv01, faceId);
}

/**
 * Equilateral triangular prism, origin at the centroid, Y up. Face 0 sits on
 * z = +apothem and looks down +Z — rest pose is flush with the board opening.
 */
function triPrismGeometry(faceW, height) {
  const apo = (faceW * Math.sqrt(3)) / 6;
  const y0 = -height * 0.5;
  const y1 = height * 0.5;
  const A = { x: -faceW * 0.5, z: apo };
  const B = { x: faceW * 0.5, z: apo };
  const C = { x: 0, z: -2 * apo };

  const pos = [];
  const nrm = [];
  const col = [];
  const uvs = [];
  const faces = [];
  const rim = hexRgb(RIM_HEX);
  const cap = hexRgb(CAP_HEX);
  const faceCols = FACE_HEX.map(hexRgb);
  const rimW = Math.min(0.018, faceW * 0.09);
  const rimH = Math.min(0.022, height * 0.035);
  const lift = 0.0012;
  const UV0 = [0, 0], UV1 = [1, 0], UV2 = [1, 1], UV3 = [0, 1];
  const UVZ = [0, 0];

  const corners = [A, B, C];
  const normals = [
    [0, 0, 1],
    [Math.sqrt(3) / 2, 0, -0.5],
    [-Math.sqrt(3) / 2, 0, -0.5],
  ];

  for (let f = 0; f < 3; f++) {
    const p = corners[f];
    const q = corners[(f + 1) % 3];
    const n = normals[f];
    const Ab = [p.x, y0, p.z];
    const At = [p.x, y1, p.z];
    const Bb = [q.x, y0, q.z];
    const Bt = [q.x, y1, q.z];
    pushQuad(pos, nrm, col, uvs, faces, Ab, Bb, Bt, At, n, rim, UVZ, UVZ, UVZ, UVZ, -1);

    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const tx = dx / len;
    const tz = dz / len;
    const u0 = rimW;
    const u1 = len - rimW;
    const inner = (u, y, extra = 0) => [
      p.x + tx * u + n[0] * extra,
      y,
      p.z + tz * u + n[2] * extra,
    ];
    pushQuad(
      pos, nrm, col, uvs, faces,
      inner(u0, y0 + rimH, lift),
      inner(u1, y0 + rimH, lift),
      inner(u1, y1 - rimH, lift),
      inner(u0, y1 - rimH, lift),
      n,
      faceCols[f],
      UV0, UV1, UV2, UV3,
      f,
    );
  }

  const topA = [A.x, y1, A.z];
  const topB = [B.x, y1, B.z];
  const topC = [C.x, y1, C.z];
  const botA = [A.x, y0, A.z];
  const botB = [B.x, y0, B.z];
  const botC = [C.x, y0, C.z];
  pushTri(pos, nrm, col, uvs, faces, topA, topC, topB, [0, 1, 0], cap, UVZ, UVZ, UVZ, -1);
  pushTri(pos, nrm, col, uvs, faces, botA, botB, botC, [0, -1, 0], cap, UVZ, UVZ, UVZ, -1);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("aFace", new THREE.Float32BufferAttribute(faces, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * @param {{ params?: object }} [o]
 * @returns {THREE.Group}
 */
export function buildAdPrismMesh({ params = {} } = {}) {
  const p = { ...AD_PRISM, ...params };
  const W = p.panelW;
  const H = p.panelH;
  const y0 = p.panelBottom;
  const cy = y0 + H * 0.5;
  const ft = p.frame;
  const fz = p.frameZ;
  const post = p.post;
  const postX = W * 0.34;
  const postH = y0 + H + 0.55;
  const inset = 0.05;
  const liveW = W - inset * 2;
  const liveH = H - 0.08;
  const nSlats = p.slats;
  const faceW = (liveW - (nSlats - 1) * p.gap) / nSlats;
  const apo = (faceW * Math.sqrt(3)) / 6;
  const frontZ = 0.1;
  const axisZ = frontZ - apo;

  const steel = [];
  const dark = [];

  for (const sx of [-1, 1]) {
    steel.push(boxAt(post, postH, post, sx * postX, postH * 0.5, -0.38));
    steel.push(boxAt(0.72, 0.1, 0.72, sx * postX, 0.05, -0.38));
    steel.push(boxAt(post + 0.08, 0.08, post + 0.08, sx * postX, postH + 0.04, -0.38));
  }
  steel.push(boxAt(postX * 2 + post, 0.18, 0.14, 0, y0 + 0.35, -0.72));
  steel.push(boxAt(postX * 2 + post, 0.14, 0.12, 0, cy, -0.7));

  // Back far enough that the rear vertex clears it at rest and mid-flip.
  dark.push(boxAt(W + 0.08, H + 0.08, 0.1, 0, cy, -0.34));

  steel.push(boxAt(W + ft * 2, ft, fz, 0, cy + H * 0.5 + ft * 0.5, 0.02));
  steel.push(boxAt(W + ft * 2, ft, fz, 0, cy - H * 0.5 - ft * 0.5, 0.02));
  steel.push(boxAt(ft, H, fz, -W * 0.5 - ft * 0.5, cy, 0.02));
  steel.push(boxAt(ft, H, fz, W * 0.5 + ft * 0.5, cy, 0.02));
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      steel.push(boxAt(0.42, 0.42, fz + 0.02, sx * (W * 0.5 + 0.02), cy + sy * (H * 0.5 + 0.02), 0.04));
    }
  }

  const walkY = y0 - 0.08;
  const walkZ = 0.62;
  dark.push(boxAt(W + 0.5, 0.06, 0.95, 0, walkY, walkZ));
  dark.push(boxAt(W + 0.5, 0.12, 0.04, 0, walkY + 0.09, walkZ + 0.46));
  const railY = walkY + 0.55;
  for (let i = 0; i < 7; i++) {
    const x = -W * 0.48 + (i / 6) * W * 0.96;
    steel.push(boxAt(0.04, 0.52, 0.04, x, walkY + 0.32, walkZ + 0.44));
  }
  steel.push(boxAt(W + 0.4, 0.04, 0.04, 0, railY, walkZ + 0.44));
  steel.push(boxAt(W + 0.4, 0.03, 0.03, 0, walkY + 0.28, walkZ + 0.44));

  const lx = -postX;
  for (let i = 0; i < 12; i++) {
    const y = 0.35 + i * 0.55;
    if (y > y0 - 0.2) break;
    steel.push(boxAt(0.42, 0.035, 0.035, lx, y, 0.05));
  }
  steel.push(boxAt(0.05, y0 - 0.15, 0.05, lx - 0.2, (y0 - 0.15) * 0.5, 0.05));
  steel.push(boxAt(0.05, y0 - 0.15, 0.05, lx + 0.2, (y0 - 0.15) * 0.5, 0.05));

  const x0 = -liveW * 0.5 + faceW * 0.5;
  const pitch = faceW + p.gap;
  for (let i = 0; i < nSlats; i++) {
    const x = x0 + i * pitch;
    steel.push(boxAt(0.02, 0.07, 0.02, x, cy + liveH * 0.5 + 0.035, axisZ));
    steel.push(boxAt(0.02, 0.07, 0.02, x, cy - liveH * 0.5 - 0.035, axisZ));
  }

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
  steelMesh.name = "AdPrismSteel";
  steelMesh.castShadow = true;
  steelMesh.receiveShadow = false;

  const darkMesh = new THREE.Mesh(
    merge(dark),
    propMat(0x0c0d10, { roughness: 0.85, metalness: 0.15 }),
  );
  darkMesh.name = "AdPrismBack";
  darkMesh.castShadow = true;

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
  bulbMesh.name = "AdPrismBulbs";
  bulbMesh.castShadow = false;
  bulbMesh.userData.noCastShadow = true;
  bulbMesh.userData.noCollide = true;

  const slats = new THREE.Mesh(
    buildSlatsGeometry(nSlats, faceW, liveH, x0, pitch, cy, axisZ),
    slatMat(),
  );
  slats.name = "AdPrismSlats";
  slats.castShadow = true;
  slats.receiveShadow = false;
  slats.userData.noMerge = true;
  slats.userData.noCollide = true;
  slats.userData.adPoster = true;
  slats.userData.adPrism = true;
  slats.userData.adPx = PRISM_PX;
  slats.userData.adFaces = FACE_COUNT;
  slats.onBeforeRender = tickPrismSlats;

  const group = new THREE.Group();
  group.name = "AdPrism";
  const visual = new THREE.Group();
  visual.name = "AdPrismVisual";
  visual.scale.setScalar(p.scale ?? 1);
  visual.add(steelMesh, darkMesh, slats, bulbMesh);
  group.add(visual);
  return group;
}

export function findAdPrismSlats(root) {
  let found = null;
  root?.traverse((o) => {
    if (o.userData?.adPrism) found = o;
  });
  return found;
}

export function isAdPrism(root) {
  return !!findAdPrismSlats(root);
}

/**
 * Give this placement its own texture nodes so an upload cannot retint every
 * prism on the track. Shares the rotation graph (and its clock) with the
 * template.
 */
export function uniquifyAdPrismMaterial(mesh) {
  if (!mesh?.material) return;
  const src = mesh.material;
  const mat = src.clone();
  mat.positionNode = src.positionNode;
  mat.normalNode = src.normalNode;
  bindPrismColor(mat, [0, 1, 2].map(facePlaceholder));
  if (src.userData?.uTime) mat.userData.uTime = src.userData.uTime;
  mesh.material = mat;
}

function setFaceMap(mat, i, tex) {
  const maps = mat.userData.adMaps;
  const nodes = mat.userData.adTexNodes;
  if (!maps || !nodes?.[i]) return;
  const prev = maps[i];
  maps[i] = tex;
  nodes[i].value = tex;
  if (prev?.userData?.adOwned) prev.dispose();
}

function normalizeFaces(value) {
  if (!value) return [null, null, null];
  if (Array.isArray(value)) {
    return [value[0] || null, value[1] || null, value[2] || null];
  }
  return [value, null, null];
}

/**
 * Apply up to three JPEG data URLs, one per rotating face. `null` slots restore
 * the solid-colour placeholder.
 */
export function setAdPrismImages(root, value) {
  const mesh = findAdPrismSlats(root);
  if (!mesh?.material) return;
  const mat = mesh.material;
  const faces = normalizeFaces(value);
  for (let i = 0; i < FACE_COUNT; i++) {
    const dataUrl = faces[i];
    if (!dataUrl) {
      setFaceMap(mat, i, facePlaceholder(i));
      continue;
    }
    new THREE.TextureLoader().load(dataUrl, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = 8;
      tex.flipY = true;
      tex.userData.adOwned = true;
      setFaceMap(mat, i, tex);
    });
  }
}
