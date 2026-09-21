/**
 * SIGNS — boards on posts, all faces on ONE sign sheet.
 *
 * A sign is the one prop that carries lettering, so it cannot live on the
 * parts kit's atlas. Instead every sign shares a single 1024² canvas sheet:
 * a strip of weathered plank down the left edge (posts, braces, board edges and
 * backs) and the painted faces packed beside it. One material for every sign
 * in the game, so a road of them is still a handful of draws.
 *
 * Each face's cell on the sheet has the SAME aspect as the board it lands on,
 * so lettering is drawn plain and lands square — no pre-stretch to keep in
 * step with the geometry.
 *
 * Sizes are real x PROP_SCALE (1.3), like the units and the rest of the props.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { rng } from "./rtsParts.js";

const S = 1.3;
const SHEET = 1024;
const PLANK_U1 = 120 / SHEET; // the plank strip: u 0 .. this

/**
 * Face cells on the sheet, in pixels. `aspect` is the board's width / height —
 * a board built for a face uses exactly that ratio.
 */
export const SIGN_FACES = {
  // The big base board: two lines, a crest, a battery strip. 2 : 1.
  firebase:  { x: 128, y: 0,   w: 896, h: 448 },
  // DANGER / NGUY HIỂM — red on white, square-ish. 3 : 2.
  danger:    { x: 128, y: 456, w: 384, h: 256 },
  // HELIPAD → arrow board. 4 : 1.
  helipad:   { x: 520, y: 456, w: 504, h: 126 },
  // MOTOR POOL → arrow board. 4 : 1.
  motorpool: { x: 520, y: 590, w: 504, h: 126 },
  // "YOU ARE ENTERING…" style warning board. 2 : 1.
  entering:  { x: 128, y: 720, w: 600, h: 300 },
};
for (const f of Object.values(SIGN_FACES)) f.aspect = f.w / f.h;

// ── The sheet ────────────────────────────────────────────────────────────────
function grime(g, x, y, w, h, R, n = 400, a = 0.1) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = `rgba(60,50,35,${R() * a})`;
    g.fillRect(x + R() * w, y + R() * h, 2 + R() * 10, 1 + R() * 3);
  }
  // Rain streaks from the top edge: the wear every board outdoors has.
  for (let i = 0; i < 30; i++) {
    const sx = x + R() * w;
    const grd = g.createLinearGradient(0, y, 0, y + h * (0.2 + R() * 0.5));
    grd.addColorStop(0, `rgba(40,35,25,${0.08 + R() * 0.1})`);
    grd.addColorStop(1, "rgba(40,35,25,0)");
    g.fillStyle = grd;
    g.fillRect(sx, y, 2 + R() * 5, h * 0.7);
  }
}

function text(g, str, x, y, font, color, maxW) {
  g.font = font;
  g.fillStyle = color;
  const w = g.measureText(str).width;
  if (maxW && w > maxW) {
    g.save(); g.translate(x, y); g.scale(maxW / w, 1); g.fillText(str, 0, 0); g.restore();
  } else g.fillText(str, x, y);
}

function drawPlank(g, R) {
  g.fillStyle = "#5e5140"; g.fillRect(0, 0, 124, SHEET);
  for (let i = 0; i < 140; i++) {
    g.strokeStyle = `rgba(${35 + R() * 30},${28 + R() * 20},${18 + R() * 15},${0.25 + R() * 0.35})`;
    g.lineWidth = 1 + R() * 2;
    const x = R() * 124;
    g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + (R() - 0.5) * 8, 340, x + (R() - 0.5) * 8, 680, x, SHEET); g.stroke();
  }
}

function drawFirebase(g, f, R) {
  const { x, y, w, h } = f;
  g.fillStyle = "#23281c"; g.fillRect(x, y, w, h);
  g.strokeStyle = "#d9b62c"; g.lineWidth = 14; g.strokeRect(x + 16, y + 16, w - 32, h - 32);
  // Crest: a shield with a lightning bolt, the shape a player reads from the air.
  const cx = x + 150, cy = y + 190;
  g.fillStyle = "#d9b62c";
  g.beginPath(); g.moveTo(cx - 80, cy - 105); g.lineTo(cx + 80, cy - 105); g.lineTo(cx + 80, cy + 10);
  g.quadraticCurveTo(cx + 80, cy + 95, cx, cy + 130); g.quadraticCurveTo(cx - 80, cy + 95, cx - 80, cy + 10); g.closePath(); g.fill();
  g.fillStyle = "#23281c";
  g.beginPath(); g.moveTo(cx + 20, cy - 85); g.lineTo(cx - 35, cy + 15); g.lineTo(cx + 2, cy + 15);
  g.lineTo(cx - 20, cy + 105); g.lineTo(cx + 40, cy - 5); g.lineTo(cx + 5, cy - 5); g.closePath(); g.fill();
  g.textAlign = "left"; g.textBaseline = "alphabetic";
  text(g, "FIREBASE", x + 262, y + 110, "bold 72px Impact, 'Arial Black', sans-serif", "#e8e2cf", 590);
  text(g, "HAWK", x + 258, y + 265, "bold 176px Impact, 'Arial Black', sans-serif", "#d9b62c", 600);
  text(g, "1ST BN · 35TH INFANTRY", x + 262, y + 330, "bold 44px 'Arial Black', Arial, sans-serif", "#e8e2cf", 590);
  // The battery strip along the foot, red with white, as on a real base board.
  g.fillStyle = "#8e1b16"; g.fillRect(x + 30, y + h - 92, w - 60, 62);
  g.textAlign = "center";
  text(g, "MORTAR BATTERY", x + w / 2, y + h - 42, "bold 50px 'Arial Black', Arial, sans-serif", "#f1ede0", w - 120);
  grime(g, x, y, w, h, R, 600, 0.12);
}

function drawDanger(g, f, R) {
  const { x, y, w, h } = f;
  g.fillStyle = "#e3dccb"; g.fillRect(x, y, w, h);
  g.fillStyle = "#9b1d17"; g.fillRect(x, y, w, 96);
  g.textAlign = "center"; g.textBaseline = "alphabetic";
  text(g, "DANGER", x + w / 2, y + 80, "bold 78px Impact, 'Arial Black', sans-serif", "#f3efe4", w - 40);
  text(g, "NGUY HIỂM", x + w / 2, y + 160, "bold 52px 'Arial Black', Arial, sans-serif", "#1c1c1a", w - 40);
  text(g, "KEEP OUT · CẤM VÀO", x + w / 2, y + 222, "bold 32px Arial, sans-serif", "#9b1d17", w - 50);
  grime(g, x, y, w, h, R, 250, 0.14);
}

function drawArrow(g, f, R, label) {
  const { x, y, w, h } = f;
  g.fillStyle = "#d8d0b6"; g.fillRect(x, y, w, h);
  // Arrow-shaped plate painted onto the board: the point is on the right.
  g.fillStyle = "#23281c";
  g.beginPath(); g.moveTo(x + 10, y + 12); g.lineTo(x + w - 90, y + 12); g.lineTo(x + w - 10, y + h / 2);
  g.lineTo(x + w - 90, y + h - 12); g.lineTo(x + 10, y + h - 12); g.closePath(); g.fill();
  g.textAlign = "center"; g.textBaseline = "middle";
  text(g, label, x + (w - 80) / 2, y + h / 2 + 4, "bold 76px Impact, 'Arial Black', sans-serif", "#e8e2cf", w - 150);
  grime(g, x, y, w, h, R, 200, 0.12);
}

function drawEntering(g, f, R) {
  const { x, y, w, h } = f;
  g.fillStyle = "#d9b62c"; g.fillRect(x, y, w, h);
  g.fillStyle = "#1c1c1a"; g.fillRect(x + 14, y + 14, w - 28, h - 28);
  g.textAlign = "center"; g.textBaseline = "alphabetic";
  text(g, "YOU ARE ENTERING", x + w / 2, y + 82, "bold 46px 'Arial Black', Arial, sans-serif", "#e8e2cf", w - 70);
  text(g, "HOSTILE AREA", x + w / 2, y + 180, "bold 96px Impact, 'Arial Black', sans-serif", "#d9b62c", w - 60);
  text(g, "WEAPONS LOCKED & LOADED", x + w / 2, y + 248, "bold 34px Arial, sans-serif", "#e8e2cf", w - 70);
  grime(g, x, y, w, h, R, 300, 0.12);
}

let _mat = null;
/** The one material every sign shares. */
export function signSheetMaterial() {
  if (_mat) return _mat;
  const cv = document.createElement("canvas");
  cv.width = cv.height = SHEET;
  const g = cv.getContext("2d");
  const R = rng(41);
  g.fillStyle = "#5e5140"; g.fillRect(0, 0, SHEET, SHEET);
  drawPlank(g, R);
  drawFirebase(g, SIGN_FACES.firebase, R);
  drawDanger(g, SIGN_FACES.danger, R);
  drawArrow(g, SIGN_FACES.helipad, R, "HELIPAD");
  drawArrow(g, SIGN_FACES.motorpool, R, "MOTOR POOL");
  drawEntering(g, SIGN_FACES.entering, R);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  _mat = new THREE.MeshStandardNodeMaterial({ map: tex, roughness: 0.85, metalness: 0 });
  _mat.name = "RtsSignSheet";
  return _mat;
}

// ── Geometry ─────────────────────────────────────────────────────────────────
/** Point all of a box's UVs at the plank strip (grain runs along the box's v). */
function plank(geo) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * PLANK_U1);
  geo.clearGroups();
  return geo;
}

/** A board whose +Z face shows `face` and whose other faces are plank. */
function board(w, h, t, face) {
  const geo = new THREE.BoxGeometry(w, h, t);
  const uv = geo.attributes.uv;
  const done = new Set();
  const u0 = face.x / SHEET, u1 = (face.x + face.w) / SHEET;
  // Canvas y runs down, texture v runs up (flipY): v = 1 - y / SHEET.
  const v0 = 1 - (face.y + face.h) / SHEET, v1 = 1 - face.y / SHEET;
  for (const grp of geo.groups) {
    for (let k = grp.start; k < grp.start + grp.count; k++) {
      const vi = geo.index.getX(k);
      if (done.has(vi)) continue;
      done.add(vi);
      if (grp.materialIndex === 4) uv.setXY(vi, u0 + uv.getX(vi) * (u1 - u0), v0 + uv.getY(vi) * (v1 - v0));
      else uv.setX(vi, uv.getX(vi) * PLANK_U1);
    }
  }
  geo.clearGroups();
  return geo;
}

const box = (w, h, d) => plank(new THREE.BoxGeometry(w, h, d));

/** A box from a to b (a length-wise timber), `s` square. */
function beam(a, b, s) {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  const g = plank(new THREE.BoxGeometry(s, len, s));
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  g.applyQuaternion(q);
  const m = a.clone().add(b).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  return g;
}

/**
 * A billboard: `face` on a board raised on 2 or 4 posts, each post held by a
 * diagonal brace behind it and the board carried on two stringers — the base
 * board every firebase had at its gate.
 *
 * `width` is the board's width in REAL metres; its height follows the face's
 * aspect. `clear` is the height of the board's foot above the ground (real).
 */
export function buildBillboardGeometry({ face = "firebase", width = 4.4, clear = 1.3, posts = 2 } = {}) {
  const F = SIGN_FACES[face];
  const bw = width * S, bh = bw / F.aspect, bt = 0.04 * S;
  const ps = 0.16 * S; // a 6x6 post
  const y0 = clear * S, top = y0 + bh;
  const parts = [];
  // Board, standing in front of the posts.
  parts.push(board(bw, bh, bt, F).translate(0, y0 + bh / 2, ps / 2 + bt / 2 + 0.05 * S));
  // A drip cap along the top, the edge that says "made of timber".
  parts.push(box(bw + 0.12 * S, 0.06 * S, bt + 0.12 * S).translate(0, top + 0.03 * S, ps / 2 + bt / 2 + 0.05 * S));
  // Stringers across the posts' faces, behind the board.
  for (const sy of [y0 + bh * 0.22, y0 + bh * 0.78]) {
    parts.push(box(bw * 0.98, 0.1 * S, 0.05 * S).translate(0, sy, ps / 2 + 0.025 * S));
  }
  // Posts: 2 at the thirds, or 4 evenly across. Each runs a little above the
  // board and is braced from behind to a foot on the ground.
  const xs = posts >= 4 ? [-0.42, -0.14, 0.14, 0.42].map((t) => t * bw) : [-0.3, 0.3].map((t) => t * bw);
  const postTop = top + 0.12 * S;
  for (const px of xs) {
    parts.push(box(ps, postTop + 0.3 * S, ps).translate(px, (postTop - 0.3 * S) / 2, 0));
    const reach = Math.max(1.1 * S, y0 * 0.9);
    parts.push(beam(new THREE.Vector3(px, y0 + bh * 0.3, -ps / 2), new THREE.Vector3(px, -0.1 * S, -ps / 2 - reach), 0.11 * S));
    // The foot block the brace is nailed to.
    parts.push(box(0.14 * S, 0.14 * S, 0.4 * S).translate(px, 0.02 * S, -ps / 2 - reach + 0.1 * S));
  }
  // A cross-brace between the outer posts at the back: keeps the pair square.
  if (xs.length >= 2) {
    const a = xs[0], b = xs[xs.length - 1];
    parts.push(beam(new THREE.Vector3(a, 0.2 * S, -ps / 2 - 0.04 * S), new THREE.Vector3(b, y0 * 0.95, -ps / 2 - 0.04 * S), 0.07 * S));
  }
  const geo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!geo) throw new Error("rtsSigns.buildBillboardGeometry: merge failed");
  geo.computeBoundingBox();
  return geo;
}

/** A small sign: one board on one post (width real metres). */
export function buildPostSignGeometry({ face = "danger", width = 1.2, clear = 0.9, lean = 0.03 } = {}) {
  const F = SIGN_FACES[face];
  const bw = width * S, bh = bw / F.aspect, bt = 0.035 * S;
  const ps = 0.1 * S, y0 = clear * S, top = y0 + bh;
  const parts = [
    board(bw, bh, bt, F).translate(0, y0 + bh / 2, ps / 2 + bt / 2 + 0.01 * S),
    box(ps, top + 0.35 * S, ps).translate(0, (top - 0.35 * S) / 2 + 0.05 * S, 0),
  ];
  const geo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  geo.rotateZ(lean);
  geo.computeBoundingBox();
  return geo;
}

export function buildBillboard(opts = {}) {
  const m = new THREE.Mesh(buildBillboardGeometry(opts), signSheetMaterial());
  m.name = "Billboard";
  m.castShadow = m.receiveShadow = true;
  return m;
}

export function buildPostSign(opts = {}) {
  const m = new THREE.Mesh(buildPostSignGeometry(opts), signSheetMaterial());
  m.name = "PostSign";
  m.castShadow = m.receiveShadow = true;
  return m;
}
