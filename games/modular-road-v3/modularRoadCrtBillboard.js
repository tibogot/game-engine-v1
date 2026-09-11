// ============================================================================
// CRT BILLBOARD — Night City megascreen, not a retro TV shader.
//
// Lab-only. Tune in crt-billboard-lab.html before wiring into the city.
//
// What CP2077 rooftop boards read as (from the street):
//   • HORIZONTAL scan structure — the raster, not vertical RGB grille
//   • The ad stays READABLE — gaps are soft, not black zebra bars
//   • Bright areas BLOOM across lines (phosphor + beam spread), then post bloom
//   • Cool phosphor glow, slight chroma at edges, almost no VHS junk
//
// What they are NOT:
//   • A 240p emulator filter (crt-geom / heavy mask / rolling bar)
//   • An LED dot grid
//
// Shader model (crt-easymode + Lottes ideas, one quad, 5 taps):
//   Vertical smear → scanline weight → mix back highlights → tint → bloom MRT
// ============================================================================

import * as THREE from "three";
import {
  abs,
  clamp,
  color,
  cos,
  float,
  floor,
  fract,
  fwidth,
  hash,
  materialColor,
  mix,
  pow,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";

export const CRT_ADS = [
  "/city-ads/ad-01.jpg",
  "/city-ads/ad-02.jpg",
  "/city-ads/ad-03.jpg",
  "/city-ads/ad-04.jpg",
  "/city-ads/ad-05.jpg",
  "/city-ads/ad-06.jpg",
  "/city-ads/ad-07.jpg",
  "/city-ads/ad-08.jpg",
  "/city-ads/ad-09.jpg",
  "/city-ads/ad-10.jpg",
  "/city-ads/ad-11.jpg",
  "/city-ads/ad-12.jpg",
  "/city-ads/ad-13.jpg",
];

/** Megaboard defaults — 16:9 rooftop screen, CP night look. */
export const CRT_DEFAULTS = {
  boardW: 14.0,
  boardH: 7.875,
  panelBottom: 6.2,
  frame: 0.22,
  frameZ: 0.22,
  post: 0.28,

  enabled: 1,
  emissive: 4.8,
  phosphor: "#dce8ff",

  // ~480i-ish line count on the face — fewer, softer bands than retro TV
  scanlines: 52,
  scan: 0.38,
  beamMin: 1.8,
  beamMax: 4.2,
  scanFloor: 0.62,
  scanBrightMin: 0.35,
  scanBrightMax: 0.92,
  bleed: 0.22,

  grilleCount: 200,
  grille: 0.0,

  barrel: 0.018,
  chroma: 0.0014,
  vignette: 0.14,
  flicker: 0.006,
  rollSpeed: 0.0,
  rollAmount: 0.0,
  rollWidth: 0.03,
  noise: 0.008,
  glass: 0.045,
  refresh: 59.94,
};

const PI = 3.14159265359;

let _dummy = null;
function dummyTexture() {
  if (_dummy) return _dummy;
  _dummy = new THREE.DataTexture(new Uint8Array([18, 20, 28, 255]), 1, 1, THREE.RGBAFormat);
  _dummy.needsUpdate = true;
  return _dummy;
}

function resolve(p) {
  return { ...CRT_DEFAULTS, ...p };
}

export function applyCrtParams(material, p = {}) {
  const crt = material.userData?.crt;
  if (!crt) return;
  const d = resolve(p);
  const u = crt.u;
  u.enabled.value = d.enabled ? 1 : 0;
  u.emissive.value = d.emissive;
  u.phosphor.value.set(d.phosphor);
  u.scanlines.value = Math.max(8, d.scanlines);
  u.scan.value = d.scan;
  u.beamMin.value = Math.max(0.5, d.beamMin);
  u.beamMax.value = Math.max(d.beamMin, d.beamMax);
  u.scanFloor.value = d.scanFloor;
  u.scanBrightMin.value = d.scanBrightMin;
  u.scanBrightMax.value = Math.max(d.scanBrightMin, d.scanBrightMax);
  u.bleed.value = d.bleed;
  u.grilleCount.value = Math.max(8, d.grilleCount);
  u.grille.value = d.grille;
  u.barrel.value = d.barrel;
  u.chroma.value = d.chroma;
  u.vignette.value = d.vignette;
  u.flicker.value = d.flicker;
  u.rollSpeed.value = d.rollSpeed;
  u.rollAmount.value = d.rollAmount;
  u.rollWidth.value = Math.max(0.004, d.rollWidth);
  u.noise.value = d.noise;
  u.glass.value = d.glass;
  u.refresh.value = Math.max(1, d.refresh);
}

export function setCrtTexture(material, map) {
  const crt = material.userData?.crt;
  if (!crt) return;
  crt.contentNode.value = map || dummyTexture();
}

export function makeCrtMaterial({ params = {}, contentTexture = null } = {}) {
  const u = {
    enabled: uniform(float(1)),
    emissive: uniform(float(CRT_DEFAULTS.emissive)),
    phosphor: uniform(color(CRT_DEFAULTS.phosphor)),
    scanlines: uniform(float(CRT_DEFAULTS.scanlines)),
    scan: uniform(float(CRT_DEFAULTS.scan)),
    beamMin: uniform(float(CRT_DEFAULTS.beamMin)),
    beamMax: uniform(float(CRT_DEFAULTS.beamMax)),
    scanFloor: uniform(float(CRT_DEFAULTS.scanFloor)),
    scanBrightMin: uniform(float(CRT_DEFAULTS.scanBrightMin)),
    scanBrightMax: uniform(float(CRT_DEFAULTS.scanBrightMax)),
    bleed: uniform(float(CRT_DEFAULTS.bleed)),
    grilleCount: uniform(float(CRT_DEFAULTS.grilleCount)),
    grille: uniform(float(CRT_DEFAULTS.grille)),
    barrel: uniform(float(CRT_DEFAULTS.barrel)),
    chroma: uniform(float(CRT_DEFAULTS.chroma)),
    vignette: uniform(float(CRT_DEFAULTS.vignette)),
    flicker: uniform(float(CRT_DEFAULTS.flicker)),
    rollSpeed: uniform(float(CRT_DEFAULTS.rollSpeed)),
    rollAmount: uniform(float(CRT_DEFAULTS.rollAmount)),
    rollWidth: uniform(float(CRT_DEFAULTS.rollWidth)),
    noise: uniform(float(CRT_DEFAULTS.noise)),
    glass: uniform(float(CRT_DEFAULTS.glass)),
    refresh: uniform(float(CRT_DEFAULTS.refresh)),
  };

  const contentNode = texture(contentTexture || dummyTexture());
  const baseUV = uv();

  const p = baseUV.mul(2).sub(1);
  const r2 = p.dot(p);
  const suv = p.mul(float(1).add(u.barrel.mul(r2))).mul(0.5).add(0.5);

  const inside = smoothstep(float(0), float(0.004), suv.x)
    .mul(smoothstep(float(1), float(0.996), suv.x))
    .mul(smoothstep(float(0), float(0.004), suv.y))
    .mul(smoothstep(float(1), float(0.996), suv.y));

  const fromC = suv.sub(0.5);

  // Sample with slight RGB beam offset (convergence error at tube edges).
  const sampleRgb = (coord) => vec3(
    contentNode.sample(coord.add(fromC.mul(u.chroma))).r,
    contentNode.sample(coord).g,
    contentNode.sample(coord.sub(fromC.mul(u.chroma))).b,
  );

  const stepY = float(1).div(u.scanlines);
  const imgC = sampleRgb(suv);
  const imgU = sampleRgb(suv.sub(vec2(0, stepY)));
  const imgD = sampleRgb(suv.add(vec2(0, stepY)));

  // Phosphor bleed between scanlines — stops the gaps going dead black.
  const img = imgC.mul(float(1).sub(u.bleed.mul(2)))
    .add(imgU.mul(u.bleed))
    .add(imgD.mul(u.bleed));

  const luma = img.r.mul(0.299).add(img.g.mul(0.587)).add(img.b.mul(0.114));
  const bright = img.r.max(img.g).max(img.b).add(luma).mul(0.5);

  // crt-easymode scanline: cos lobes, beam width from brightness, soft floor.
  const lineCoord = suv.y.mul(u.scanlines);
  const scanCos = cos(lineCoord.mul(PI)).mul(0.5).add(0.5);
  const beam = clamp(bright.mul(u.beamMax), u.beamMin, u.beamMax);
  const scanShape = pow(scanCos, beam);
  const scanMul = mix(u.scanFloor, float(1), scanShape);
  const scanWeight = mix(float(1), scanMul, u.scan);

  const scanFw = fwidth(lineCoord);
  const scanSharp = smoothstep(float(1.2), float(0.15), scanFw);
  const scanAvg = mix(float(1), u.scanFloor.add(float(1).sub(u.scanFloor).mul(0.5)), u.scan.mul(0.5));
  const scan = mix(scanAvg, scanWeight, scanSharp);

  const scanned = img.mul(scan);

  // Bright pixels keep the un-scanned image — the CP billboard still reads.
  const preserve = smoothstep(u.scanBrightMin, u.scanBrightMax, bright);
  const picture = mix(scanned, img, preserve);

  // Optional Trinitron mask — close-up only, off by default.
  const gx = suv.x.mul(u.grilleCount).mul(PI);
  const gFw = fwidth(suv.x.mul(u.grilleCount));
  const gSharp = smoothstep(float(1.0), float(0.14), gFw);
  const gAmt = u.grille.mul(gSharp);
  const grille = mix(
    vec3(1),
    vec3(
      cos(gx).mul(0.5).add(0.5),
      cos(gx.add(2.094)).mul(0.5).add(0.5),
      cos(gx.add(4.189)).mul(0.5).add(0.5),
    ),
    gAmt,
  );

  const vig = float(1).sub(u.vignette.mul(r2));

  const frameId = floor(time.mul(u.refresh));
  const flick = float(1).add(hash(frameId).mul(2).sub(1).mul(u.flicker));

  const rollY = fract(suv.y.sub(time.mul(u.rollSpeed)));
  const bar = smoothstep(u.rollWidth, float(0), abs(rollY.sub(0.06)));
  const roll = float(1).add(bar.mul(u.rollAmount));

  const grain = hash(suv.mul(vec2(180, 97)).add(vec2(frameId, frameId.mul(1.31))))
    .sub(0.5)
    .mul(u.noise);

  const analog = picture
    .mul(u.phosphor)
    .mul(grille)
    .mul(vig)
    .mul(flick)
    .mul(roll)
    .add(grain)
    .mul(u.emissive)
    .mul(inside);

  const spec = clamp(float(1).sub(abs(suv.x.add(suv.y).sub(1)).mul(3.2)), 0, 1)
    .mul(u.glass)
    .mul(inside);
  const crtOut = analog.add(spec.mul(u.phosphor));

  const raw = contentNode.sample(baseUV).rgb.mul(u.emissive);
  const out = mix(raw, crtOut, u.enabled);

  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.FrontSide });
  mat.colorNode = out;
  mat.toneMapped = true;
  applyBloomMRT(mat, out);
  mat.userData.crt = { u, contentNode };
  applyCrtParams(mat, params);
  return mat;
}

function boxAt(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function merge(parts) {
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

function steelMat() {
  const m = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(0x1a1e26),
    roughness: 0.42,
    metalness: 0.72,
  });
  m.colorNode = materialColor;
  return m;
}

function backMat() {
  const m = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(0x0a0b0e),
    roughness: 0.88,
    metalness: 0.12,
  });
  m.colorNode = materialColor;
  return m;
}

export function buildCrtBillboard({
  params = {},
  contentTexture = null,
  material = null,
} = {}) {
  const p = resolve(params);
  const W = Math.max(0.6, p.boardW);
  const H = Math.max(0.4, p.boardH);
  const ft = p.frame;
  const d = p.frameZ;
  const y0 = p.panelBottom;
  const cy = y0 + H * 0.5;
  const postX = W * 0.38;

  const steel = [];
  const dark = [];

  steel.push(boxAt(p.post, y0 + 0.12, p.post, -postX, (y0 + 0.12) * 0.5, 0));
  steel.push(boxAt(p.post, y0 + 0.12, p.post, postX, (y0 + 0.12) * 0.5, 0));
  steel.push(boxAt(W + 0.36, 0.1, 0.28, 0, 0.05, 0));

  steel.push(boxAt(W + ft * 2, ft, d, 0, cy + H * 0.5 + ft * 0.5, 0));
  steel.push(boxAt(W + ft * 2, ft, d, 0, cy - H * 0.5 - ft * 0.5, 0));
  steel.push(boxAt(ft, H, d, -W * 0.5 - ft * 0.5, cy, 0));
  steel.push(boxAt(ft, H, d, W * 0.5 + ft * 0.5, cy, 0));

  dark.push(boxAt(W + ft * 1.4, H + ft * 1.4, d * 0.55, 0, cy, -d * 0.28));

  const steelMesh = new THREE.Mesh(merge(steel), steelMat());
  steelMesh.name = "CrtBillboardSteel";
  steelMesh.castShadow = true;

  const darkMesh = new THREE.Mesh(merge(dark), backMat());
  darkMesh.name = "CrtBillboardBack";
  darkMesh.castShadow = true;

  const mat = material ?? makeCrtMaterial({ params: p, contentTexture });
  const inset = 0.03;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(W - inset * 2, H - inset * 2), mat);
  face.name = "CrtBillboardFace";
  face.position.set(0, cy, d * 0.52);
  face.castShadow = false;
  face.userData.crtFace = true;
  face.userData.noCastShadow = true;
  face.userData.noCollide = true;

  const group = new THREE.Group();
  group.name = "CrtBillboard";
  group.add(steelMesh, darkMesh, face);
  group.userData.crt = { params: p, material: mat };
  return group;
}

export function findCrtFace(root) {
  let found = null;
  root?.traverse((o) => {
    if (o.userData?.crtFace) found = o;
  });
  return found;
}

export const CRT_PRESETS = {
  nightCity: { ...CRT_DEFAULTS },
  street: {
    ...CRT_DEFAULTS,
    scanlines: 44,
    scan: 0.32,
    bleed: 0.28,
    scanFloor: 0.68,
    emissive: 5.2,
  },
  close: {
    ...CRT_DEFAULTS,
    scanlines: 64,
    scan: 0.42,
    bleed: 0.18,
    scanFloor: 0.58,
    grille: 0.22,
    grilleCount: 160,
  },
  retro: {
    ...CRT_DEFAULTS,
    scanlines: 72,
    scan: 0.55,
    scanFloor: 0.48,
    bleed: 0.12,
    rollSpeed: 0.04,
    rollAmount: 0.06,
    noise: 0.025,
    flicker: 0.02,
  },
  raw: { ...CRT_DEFAULTS, enabled: 0 },
};
