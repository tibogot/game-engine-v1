// THE KIT WITH PHOTO DETAIL (2026-10-11, you: "the new buildings look better but before there was
// more contrast and colour, it read better" — option B, your go). The kit's buildings keep their
// shapes AND their painted palette (the post's white, the ochres, the coloured doors: what reads from
// the RTS camera); real photos (Poly Haven, CC0) add only GRAIN and RELIEF on top, by family:
//   PLASTER  whitewash, stucco, plaster (pale)       clay_plaster
//   STONE    rubble, limestone, ashlar, sandstone     rabdentse_ruins_wall
//   EARTH    earth, spoil                            mud_cracked_dry_03
//   WOOD     timber                                  raw_plank_wall
// CHEAP BY CONSTRUCTION: the four photos' grain packed in ONE texture (a channel each, each centred on
// its own mean), their relief in TWO (two families' normal XY each) — 3 texture reads a pixel, one
// projection (the face's dominant axis), on top of the kit's own atlas read. Built at load from the
// 512 px maps; until then the detail is flat (the kit as it was).
import * as THREE from "three";
import { abs, attribute, dot, float, mix, normalGeometry, positionGeometry, select, step, texture, transformNormalToView, uniform, uv, vec2, vec3 } from "three/tsl";
import { rtsAtlasColor } from "../../v3/render/objects/rtsObjectProps.js";

const FAMILIES = [
  { id: "plaster", url: "/textures/build/clay_plaster/clay_plaster", mats: [11, 14, 22, 23, 10] },   // (+ concrete: the post's roof slabs and copings)
  { id: "stone", url: "/textures/build/rabdentse_ruins_wall/rabdentse_ruins_wall", mats: [19, 21, 24, 16] },
  { id: "earth", url: "/textures/ground/mud_cracked_dry_03/mud_cracked_dry_03", mats: [3, 20] },
  { id: "wood", url: "/textures/build/raw_plank_wall/raw_plank_wall", mats: [2] },
];
const N = 512;

/** Live tunables (the lab). */
export const kitPhotoLook = { grain: uniform(3), relief: uniform(1.6), tile: uniform(2.0) };   // (1.15 / 0.9 were invisible: the lab)

function canvasTex(srgb) {
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d");
  g.fillStyle = srgb ? "#808080" : "rgb(128,128,128)";
  g.fillRect(0, 0, N, N);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.NoColorSpace;   // packed data, not a colour
  return t;
}
const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
function pixels(img) {
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, N, N);
  return g.getImageData(0, 0, N, N).data;
}

let _packed = null;
/** The packed textures: { grain (RGBA = the 4 families' luminance about 0.5), nA (plaster.xy stone.xy), nB (earth.xy wood.xy) }. */
function packed() {
  if (_packed) return _packed;
  const grain = canvasTex(false), nA = canvasTex(false), nB = canvasTex(false);
  _packed = { grain, nA, nB };
  Promise.all(FAMILIES.map((f) => Promise.all([load(`${f.url}_diff_1k.jpg`), load(`${f.url}_nor_gl_1k.jpg`)]))).then((imgs) => {
    const G = new Uint8ClampedArray(N * N * 4), A = new Uint8ClampedArray(N * N * 4), B = new Uint8ClampedArray(N * N * 4);
    imgs.forEach(([d, n], fi) => {
      const dp = pixels(d), np = pixels(n);
      // Luminance, centred on its own mean (each photo's average brightness differs: the GRAIN only).
      const lum = new Float32Array(N * N);
      let mean = 0;
      for (let i = 0; i < N * N; i++) { lum[i] = (0.2126 * dp[i * 4] + 0.7152 * dp[i * 4 + 1] + 0.0722 * dp[i * 4 + 2]) / 255; mean += lum[i]; }
      mean /= N * N;
      for (let i = 0; i < N * N; i++) G[i * 4 + fi] = Math.max(0, Math.min(255, Math.round((lum[i] - mean + 0.5) * 255)));
      const T = fi < 2 ? A : B, o = (fi % 2) * 2;
      for (let i = 0; i < N * N; i++) { T[i * 4 + o] = np[i * 4]; T[i * 4 + o + 1] = np[i * 4 + 1]; }
    });
    for (const [tex, data] of [[grain, G], [nA, A], [nB, B]]) {
      tex.image.getContext("2d").putImageData(new ImageData(data, N, N), 0, 0);
      tex.needsUpdate = true;
    }
  }).catch((e) => console.warn("[kit photo] maps failed:", e));
  return _packed;
}

const _mats = new Map();
/**
 * The kit's material (rtsObjectMaterialTinted's: the atlas colour, the paint tint) with the photo
 * detail on top. One per paint tint.
 */
export function kitPhotoMaterial(paintTint) {
  const key = paintTint.join(",");
  if (_mats.has(key)) return _mats.get(key);
  const { grain, nA, nB } = packed();
  const id = attribute("matId", "float");
  const isPaint = step(float(6.5), id).mul(step(id, float(7.5)));
  const base = rtsAtlasColor(uv()).mul(mix(vec3(1, 1, 1), vec3(...paintTint), isPaint));
  // The family weights from the material id (exact ids: 0 or 1 each).
  const is = (k) => step(abs(id.sub(k)), float(0.25));
  const fam = FAMILIES.map((f) => f.mats.reduce((a, k) => a.add(is(k)), float(0)).min(1));
  // One projection: the face's dominant axis.
  const n = normalGeometry.normalize(), ax = abs(n);
  const isX = ax.x.greaterThan(ax.y).and(ax.x.greaterThan(ax.z)), isY = ax.y.greaterThan(ax.z);
  const p = positionGeometry.div(kitPhotoLook.tile);
  const puv = select(isX, vec2(p.z, p.y), select(isY, vec2(p.x, p.z), vec2(p.x, p.y)));
  // GRAIN: the family's channel, about 0 — brightens and darkens the kit's own colour.
  const g = texture(grain, puv);
  const grainV = g.r.mul(fam[0]).add(g.g.mul(fam[1])).add(g.b.mul(fam[2])).add(g.a.mul(fam[3])).sub(fam[0].add(fam[1]).add(fam[2]).add(fam[3]).min(1).mul(0.5));
  const col = base.mul(float(1).add(grainV.mul(kitPhotoLook.grain).mul(1.6)));
  // RELIEF: the family's normal XY, whiteout onto the face (Z rebuilt).
  const a = texture(nA, puv), b = texture(nB, puv);
  let txy = a.xy.mul(fam[0]).add(a.zw.mul(fam[1])).add(b.xy.mul(fam[2])).add(b.zw.mul(fam[3]));
  const any = fam[0].add(fam[1]).add(fam[2]).add(fam[3]).min(1);
  txy = txy.mul(2).sub(any.mul(1)).mul(kitPhotoLook.relief);   // (0..1 → −1..1 for the family hit; 0 elsewhere)
  const tz = float(1).sub(dot(txy, txy).min(1)).sqrt();
  const nX = vec3(txy.add(vec2(n.z, n.y)), tz.mul(n.x)).zyx;
  const nY = vec3(txy.add(vec2(n.x, n.z)), tz.mul(n.y)).xzy;
  const nZ = vec3(txy.add(vec2(n.x, n.y)), tz.mul(n.z));
  const nObj = select(isX, nX, select(isY, nY, nZ)).normalize();
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0 });
  m.name = `KitPhoto:${key}`;
  m.colorNode = col;
  m.normalNode = transformNormalToView(nObj).normalize();
  _mats.set(key, m);
  return m;
}
