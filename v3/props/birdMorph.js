// BIRDS from the pack's chicken (public/models/Chicken_001_compressed.glb) —
// the same idea as animalMorph.js for the donkey rig: the pack's own mesh,
// skeleton and clips (idle, walk, run), recoloured per kind in the pack's flat
// low-poly look (one colour per face, no texture), one draw per kind in a crowd.
//
// The chicken is coloured by a painted TEXTURE (GPU-compressed BC7 in the GLB —
// it cannot be read back). So the model is loaded once here with the KTX2
// transcode forced to plain RGBA (CPU-readable), every triangle takes the
// texture's colour under it, and is sorted into a class: feathers, the red
// comb and wattles, the yellow beak and legs, the dark eyes. A kind repaints
// by class (white hen: feathers white, comb red, beak and legs yellow).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { setupDraco } from "../../v2/core/dracoLoader.js";

const URL_CHICKEN = "/models/Chicken_001_compressed.glb";

// Each kind: colours per class; `height` (m, standing). `speckle`: a share of
// the feather faces in a second colour (a speckled hen).
export const BIRD_KINDS = {
  hen:         { feather: "#f2eee6", featherShade: "#d6cfc1", comb: "#c42f26", beak: "#e2ad45", leg: "#dfa942", eye: "#120d0b", height: 0.42 },
  henSpeckled: { feather: "#ece7dd", featherShade: "#cfc7b8", speckle: "#6a635c", speckleShare: 0.2, comb: "#c42f26", beak: "#e2ad45", leg: "#d8a443", eye: "#120d0b", height: 0.42 },
  henBlack:    { feather: "#2b2725", featherShade: "#1c1918", comb: "#c42f26", beak: "#8a8170", leg: "#5d564f", eye: "#0b0908", height: 0.42 },
  henPack:     { pack: true, height: 0.42 },        // the pack's own colours (for comparison)
};

let SRC = null;   // { gltf, mesh, face: [{ rgb, cls, shade }] }

/** sRGB 0..1 → [h 0..360, s, v] */
function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
}

/**
 * The class of a texture colour — measured on the pack's hen (bird lab): the
 * comb is a BRIGHT red (s 0.8, v 0.9, skull only), the feathers a duller
 * red-brown (s 0.4-0.6, v 0.4-0.5 — a looser red rule took the whole neck and
 * tail for comb), the eyes dark grey (v 0.2), beak and legs yellow (h 40-50).
 */
function classOf([r, g, b]) {
  const [h, s, v] = hsv(r, g, b);
  if (v < 0.28 && s < 0.35) return "eye";
  if ((h < 20 || h > 335) && s > 0.7 && v > 0.75) return "comb";
  if (h >= 32 && h <= 62 && s > 0.45 && v > 0.55) return "yellow";
  return "feather";
}

/**
 * Load the chicken once (RGBA texture) and read each triangle's colour.
 * Returns { faces, classes } (what the texture held, for the lab).
 */
export async function initBirdMorph(url = URL_CHICKEN) {
  if (SRC) return SRC.stats;
  const ktx2 = new KTX2Loader();
  ktx2.setTranscoderPath("https://www.gstatic.com/basis-universal/versioned/2021-04-15-ba1c3e4/");
  // no compressed format supported → the transcoder writes plain RGBA
  ktx2.workerConfig = { astcSupported: false, astcHDRSupported: false, etc1Supported: false, etc2Supported: false, dxtSupported: false, bptcSupported: false, pvrtcSupported: false };
  const loader = setupDraco(new GLTFLoader());
  loader.setKTX2Loader(ktx2);
  const gltf = await loader.loadAsync(url);
  ktx2.dispose();
  let mesh = null;
  gltf.scene.traverse((o) => { if (o.isSkinnedMesh && !mesh) mesh = o; });
  const tex = mesh.material.map;
  const img = tex.mipmaps?.[0] ?? tex.image;
  const W = img.width, H = img.height, px = img.data;
  const geo = mesh.geometry, uv = geo.attributes.uv, idx = geo.index;
  const sample = (u, v) => {
    // glTF UVs: v = 0 at the top of the image (flipY false); the transcoded
    // data is stored top row first
    const x = Math.min(W - 1, Math.max(0, Math.floor(u * W))), y = Math.min(H - 1, Math.max(0, Math.floor(v * H)));
    const k = (y * W + x) * 4;
    return [px[k] / 255, px[k + 1] / 255, px[k + 2] / 255];
  };
  const T = idx ? idx.count / 3 : geo.attributes.position.count / 3;
  const face = [];
  const classes = {};
  for (let t = 0; t < T; t++) {
    const vs = [0, 1, 2].map((q) => (idx ? idx.getX(3 * t + q) : 3 * t + q));
    // the centre and the three corners pulled a little toward it: the colour
    // that covers most of the triangle
    const cu = vs.reduce((s, i) => s + uv.getX(i), 0) / 3, cv = vs.reduce((s, i) => s + uv.getY(i), 0) / 3;
    const pts = [[cu, cv], ...vs.map((i) => [cu + (uv.getX(i) - cu) * 0.6, cv + (uv.getY(i) - cv) * 0.6])];
    const votes = new Map();
    for (const [u, v] of pts) { const c = sample(u, v), k = classOf(c); const e = votes.get(k) ?? { n: 0, rgb: [0, 0, 0] }; e.n++; e.rgb = e.rgb.map((x, j) => x + c[j]); votes.set(k, e); }
    const [cls, best] = [...votes].sort((a, b) => b[1].n - a[1].n)[0];
    const rgb = best.rgb.map((x) => x / best.n);
    face.push({ cls, rgb, shade: hsv(...rgb)[2] });
    classes[cls] = (classes[cls] ?? 0) + 1;
  }
  // feather shading: the texture's light/dark feathers, normalised 0..1
  const fv = face.filter((f) => f.cls === "feather").map((f) => f.shade).sort((a, b) => a - b);
  const lo = fv[Math.floor(fv.length * 0.05)] ?? 0, hi = fv[Math.floor(fv.length * 0.95)] ?? 1;
  for (const f of face) f.shade = Math.min(1, Math.max(0, (f.shade - lo) / Math.max(1e-3, hi - lo)));
  SRC = { gltf, mesh, face, stats: { faces: T, classes, texture: [W, H] } };
  return SRC.stats;
}

const hash = (i) => { let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967296; };

/**
 * A bird of `kind` (BIRD_KINDS, + overrides): { root, source, clips, kind, height }
 * — `source` a SkinnedMesh with flat normals and a per-face `color`, bound in
 * `root` (the crowd format animalMorph's templates use).
 */
export function createBirdTemplate(kind = "hen", overrides = {}) {
  if (!SRC) throw new Error("birdMorph: await initBirdMorph() first");
  const K = { ...BIRD_KINDS[kind], ...overrides };
  const root = cloneSkinned(SRC.gltf.scene);
  let m = null;
  root.traverse((o) => { if (o.isSkinnedMesh && !m) m = o; });
  const g0 = SRC.mesh.geometry, idx = g0.index, P = g0.attributes.position, SI = g0.attributes.skinIndex, SW = g0.attributes.skinWeight;
  const T = SRC.face.length, n = T * 3;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const c = new THREE.Color(), a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), fn = new THREE.Vector3();
  const C = (hex) => new THREE.Color(hex);
  const pal = K.pack ? null : { feather: C(K.feather), shade: C(K.featherShade ?? K.feather), speckle: K.speckle ? C(K.speckle) : null, comb: C(K.comb), beak: C(K.beak), leg: C(K.leg), eye: C(K.eye) };
  // which faces are LEGS (their yellow is the leg colour, the head's the beak)
  const bones = SRC.mesh.skeleton.bones;
  const legBone = (i) => { let bw = 0, bj = 0; for (let k = 0; k < 4; k++) { const w = SW.getComponent(i, k); if (w > bw) { bw = w; bj = SI.getComponent(i, k); } } return /thigh|shin|foot|toe/i.test(bones[bj].name); };
  for (let t = 0; t < T; t++) {
    const vs = [0, 1, 2].map((q) => (idx ? idx.getX(3 * t + q) : 3 * t + q));
    a.fromBufferAttribute(P, vs[0]); b.fromBufferAttribute(P, vs[1]); d.fromBufferAttribute(P, vs[2]);
    fn.subVectors(b, a).cross(d.clone().sub(a)).normalize();
    const f = SRC.face[t];
    if (!pal) c.setRGB(f.rgb[0], f.rgb[1], f.rgb[2], THREE.SRGBColorSpace);
    else if (f.cls === "comb") c.copy(pal.comb);
    else if (f.cls === "eye") c.copy(pal.eye);
    else if (f.cls === "yellow") c.copy(legBone(vs[0]) ? pal.leg : pal.beak);
    else {
      c.copy(pal.shade).lerp(pal.feather, 0.5 + 0.5 * f.shade);              // the texture's feather shading, kept (softened)
      if (pal.speckle && hash(t * 7 + 3) < K.speckleShare) c.copy(pal.speckle).lerp(pal.feather, 0.15 * f.shade);
    }
    for (let q = 0; q < 3; q++) {
      const o = 3 * t + q, v = vs[q];
      pos.set([P.getX(v), P.getY(v), P.getZ(v)], o * 3);
      nrm.set([fn.x, fn.y, fn.z], o * 3);
      col.set([c.r, c.g, c.b], o * 3);
      for (let k = 0; k < 4; k++) { si[o * 4 + k] = SI.getComponent(v, k); sw[o * 4 + k] = SW.getComponent(v, k); }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("skinIndex", new THREE.BufferAttribute(si, 4));
  geo.setAttribute("skinWeight", new THREE.BufferAttribute(sw, 4));
  geo.computeBoundingSphere();
  m.geometry = geo;
  m.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  m.name = `${kind}Template`;
  root.updateMatrixWorld(true);
  return { root, source: m, clips: SRC.gltf.animations, kind, height: K.height };
}
