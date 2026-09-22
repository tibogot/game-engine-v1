/**
 * STENCILS — painted army markings on props: the medic's red cross, U.S. ARMY,
 * unit codes, the white star.
 *
 * Not decals: the engine's projected decals are ground-only on purpose (they
 * fade out 0.35 m above the terrain, or wheel ruts painted the jeeps). A
 * marking here is a thin patch that FOLLOWS the surface it is painted on — a
 * container's corrugation, a tent's sagging canvas — lifted a few millimetres
 * off it, on one shared cut-out sheet (transparent background, alpha-tested,
 * so no sorting). Every marking in the game is one material; a prop's markings
 * are one merged geometry riding as a child of the prop.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const SHEET = 1024;

/** Cells on the stencil sheet, in pixels. `aspect` = width / height. */
export const STENCILS = {
  // Red cross on a white square: the roof marking of an aid station.
  medicSquare:  { x: 0,   y: 0,   w: 512, h: 512 },
  // The cross alone, for walls and flaps.
  medicCross:   { x: 512, y: 0,   w: 256, h: 256 },
  // The Army star in its ring, white.
  star:         { x: 768, y: 0,   w: 256, h: 256 },
  armyWhite:    { x: 512, y: 256, w: 512, h: 128 },
  armyBlack:    { x: 512, y: 384, w: 512, h: 128 },
  unitCode:     { x: 0,   y: 512, w: 512, h: 128 },
  containerId:  { x: 0,   y: 640, w: 512, h: 128 },
  medical:      { x: 512, y: 512, w: 512, h: 128 },
  noSmoking:    { x: 512, y: 640, w: 512, h: 128 },
  // The landing H in its ring, white, for a helipad's deck.
  helipadH:     { x: 0,   y: 768, w: 256, h: 256 },
  // Red and white bands across the cell (t runs along them): a windsock's cloth.
  sockBands:    { x: 256, y: 768, w: 64,  h: 256 },
  // One PSP plank's punched holes and pressed ribs, laid along a plank.
  pspHoles:     { x: 320, y: 768, w: 512, h: 48 },
  // A vehicle's bumper code, white, for trim vanes and bumpers.
  bumperCode:   { x: 320, y: 832, w: 512, h: 96 },
  // A helicopter's tail number, black, for the fin.
  tailNumber:   { x: 320, y: 928, w: 384, h: 96 },
};
for (const s of Object.values(STENCILS)) s.aspect = s.w / s.h;

const FONT = "'Stencil', 'Stencil Std', Impact, 'Arial Black', sans-serif";

function drawSheet() {
  const cv = document.createElement("canvas");
  cv.width = cv.height = SHEET;
  const g = cv.getContext("2d");
  g.clearRect(0, 0, SHEET, SHEET);
  const cross = (cx, cy, arm, w, col) => {
    g.fillStyle = col;
    g.fillRect(cx - w / 2, cy - arm, w, arm * 2);
    g.fillRect(cx - arm, cy - w / 2, arm * 2, w);
  };
  // Worn paint: knock small holes out of what was just drawn in a cell.
  const wear = (x, y, w, h, n = 260) => {
    g.save();
    g.globalCompositeOperation = "destination-out";
    let s = x * 7 + y * 13 + 1;
    const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < n; i++) { g.globalAlpha = 0.3 + r() * 0.7; g.fillRect(x + r() * w, y + r() * h, 1 + r() * 5, 1 + r() * 3); }
    g.restore();
  };
  const text = (str, x, y, w, h, col, px) => {
    g.fillStyle = col;
    g.font = `bold ${px}px ${FONT}`;
    g.textAlign = "center"; g.textBaseline = "middle";
    const m = g.measureText(str).width;
    g.save(); g.translate(x + w / 2, y + h / 2 + px * 0.04);
    if (m > w * 0.92) g.scale((w * 0.92) / m, 1);
    g.fillText(str, 0, 0); g.restore();
  };
  let c = STENCILS.medicSquare;
  g.fillStyle = "#ece8dc"; g.fillRect(c.x + 8, c.y + 8, c.w - 16, c.h - 16);
  cross(c.x + c.w / 2, c.y + c.h / 2, 190, 128, "#b3201b");
  wear(c.x, c.y, c.w, c.h, 400);
  c = STENCILS.medicCross;
  cross(c.x + c.w / 2, c.y + c.h / 2, 110, 74, "#b3201b");
  wear(c.x, c.y, c.w, c.h, 120);
  c = STENCILS.star;
  {
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    g.strokeStyle = "#e9e6dc"; g.lineWidth = 12;
    g.beginPath(); g.arc(cx, cy, 112, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "#e9e6dc"; g.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 5, r = k % 2 === 0 ? 100 : 38;
      g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    g.closePath(); g.fill();
    wear(c.x, c.y, c.w, c.h, 150);
  }
  c = STENCILS.armyWhite; text("U.S. ARMY", c.x, c.y, c.w, c.h, "#e9e6dc", 104); wear(c.x, c.y, c.w, c.h);
  c = STENCILS.armyBlack; text("U.S. ARMY", c.x, c.y, c.w, c.h, "#1d1d1a", 104); wear(c.x, c.y, c.w, c.h);
  c = STENCILS.unitCode; text("1-35 INF   HQ 7", c.x, c.y, c.w, c.h, "#e9e6dc", 76); wear(c.x, c.y, c.w, c.h);
  c = STENCILS.containerId; text("USAU 204518", c.x, c.y, c.w, c.h, "#e9e6dc", 84); wear(c.x, c.y, c.w, c.h);
  c = STENCILS.medical; text("BN AID STATION", c.x, c.y, c.w, c.h, "#b3201b", 72); wear(c.x, c.y, c.w, c.h);
  c = STENCILS.noSmoking; text("NO SMOKING", c.x, c.y, c.w, c.h, "#b3201b", 88); wear(c.x, c.y, c.w, c.h);
  c = STENCILS.helipadH;
  {
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    g.strokeStyle = "#e9e6dc"; g.lineWidth = 14;
    g.beginPath(); g.arc(cx, cy, 108, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "#e9e6dc";
    g.fillRect(cx - 52, cy - 66, 26, 132);
    g.fillRect(cx + 26, cy - 66, 26, 132);
    g.fillRect(cx - 26, cy - 12, 52, 24);
    wear(c.x, c.y, c.w, c.h, 260);
  }
  c = STENCILS.sockBands;
  // Canvas y runs DOWN the cell and t runs UP it: band 0 (the mouth, t = 0)
  // is the bottom one. Five bands, red at the mouth and the tail. Opaque, so
  // the cloth is solid under the alpha test.
  for (let k = 0; k < 5; k++) {
    g.fillStyle = k % 2 === 0 ? "#c4401e" : "#e9e6dc";
    g.fillRect(c.x, c.y + c.h - ((k + 1) * c.h) / 5, c.w, c.h / 5 + 1);
  }
  c = STENCILS.tailNumber; text("69-15078", c.x, c.y, c.w, c.h, "#1d1d1a", 70); wear(c.x, c.y, c.w, c.h, 60);
  c = STENCILS.bumperCode; text("11 ACR   A-13", c.x, c.y, c.w, c.h, "#e9e6dc", 64); wear(c.x, c.y, c.w, c.h, 140);
  c = STENCILS.pspHoles;
  {
    // M8A1 plank: a row of punched holes down the middle, each with the lip
    // the punch pressed up round it catching the light, and a pressed rib
    // either side. Dark earth shows through the holes.
    const n = 16, cy = c.y + c.h / 2;
    g.fillStyle = "#8d8474";
    g.fillRect(c.x + 6, c.y + 5, c.w - 12, 4);
    g.fillRect(c.x + 6, c.y + c.h - 9, c.w - 12, 4);
    for (let k = 0; k < n; k++) {
      const cx = c.x + ((k + 0.5) * c.w) / n;
      g.fillStyle = "#9a907e";
      g.beginPath(); g.ellipse(cx, cy, 13, 12, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#231d15";
      g.beginPath(); g.ellipse(cx, cy, 10, 9, 0, 0, Math.PI * 2); g.fill();
    }
  }
  return cv;
}

let _mat = null;
/** The one material every stencil in the game shares. */
export function stencilMaterial() {
  if (_mat) return _mat;
  const tex = new THREE.CanvasTexture(drawSheet());
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  _mat = new THREE.MeshStandardNodeMaterial({
    map: tex, alphaTest: 0.5, roughness: 0.9, metalness: 0,
    // Belt and braces on top of the lift off the surface: paint is a
    // coplanar layer by nature, and at RTS distance millimetres are nothing.
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  _mat.name = "RtsStencil";
  return _mat;
}

/**
 * A stencil laid on a surface. `surface(s, t)` maps the patch's own
 * coordinates (s across, t up, both 0..1) to `{ p: Vector3, n: Vector3 }` on
 * the object — a flat face, a corrugated wall, a sagging roof — and the patch
 * is lifted `lift` metres along n. `segS` x `segT` is how finely it follows.
 */
export function stencilPatch(cell, surface, { segS = 1, segT = 1, lift = 0.006, sList = null } = {}) {
  const c = STENCILS[cell];
  const u0 = c.x / SHEET, u1 = (c.x + c.w) / SHEET;
  const v0 = 1 - (c.y + c.h) / SHEET, v1 = 1 - c.y / SHEET;
  // `sList`: explicit s stations (sorted 0..1) — put a column on every corner
  // of a folded surface, so the paint does not cut across it.
  const ss = sList ?? Array.from({ length: segS + 1 }, (_, i) => i / segS);
  segS = ss.length - 1;
  const pos = [], nrm = [], uvs = [], idx = [];
  for (let j = 0; j <= segT; j++) {
    for (let i = 0; i <= segS; i++) {
      const s = ss[i], t = j / segT;
      const { p, n } = surface(s, t);
      pos.push(p.x + n.x * lift, p.y + n.y * lift, p.z + n.z * lift);
      nrm.push(n.x, n.y, n.z);
      uvs.push(u0 + (u1 - u0) * s, v0 + (v1 - v0) * t);
    }
  }
  const row = segS + 1;
  for (let j = 0; j < segT; j++) {
    for (let i = 0; i < segS; i++) {
      const a = j * row + i;
      idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  // Winding follows the surface's own normal, whichever way s and t run.
  const a = new THREE.Vector3().fromArray(pos, 0), b = new THREE.Vector3().fromArray(pos, 3), d = new THREE.Vector3().fromArray(pos, row * 3);
  const face = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a));
  if (face.dot(new THREE.Vector3(nrm[0], nrm[1], nrm[2])) < 0) {
    for (let k = 0; k < idx.length; k += 3) { const tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; }
    g.setIndex(idx);
  }
  return g;
}

/**
 * A flat face: centre, the face's outward normal and its "right" direction;
 * `width` metres wide, height from the cell's aspect.
 */
export function flatSurface(center, normal, right, width, cell) {
  const n = new THREE.Vector3(...normal).normalize();
  const r = new THREE.Vector3(...right).normalize();
  const up = new THREE.Vector3().crossVectors(n, r).normalize();
  const h = width / STENCILS[cell].aspect;
  const c = new THREE.Vector3(...center);
  return (s, t) => ({ p: c.clone().addScaledVector(r, (s - 0.5) * width).addScaledVector(up, (t - 0.5) * h), n });
}

/** Merge a prop's stencil patches into the one geometry its child mesh draws. */
export function mergeStencils(patches) {
  const list = patches.filter(Boolean);
  if (!list.length) return null;
  const g = mergeGeometries(list, false);
  for (const p of list) p.dispose();
  return g;
}

/** A mesh for a prop's merged stencils (null-safe), ready to add as its child. */
export function stencilMesh(geo) {
  if (!geo) return null;
  const m = new THREE.Mesh(geo, stencilMaterial());
  m.name = "Stencils";
  m.castShadow = false;
  m.receiveShadow = true;
  return m;
}
