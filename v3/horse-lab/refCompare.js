// ── Horse lab: compare with the reference game's screenshots ─────────────────
// The reference screenshots (v3/horse-lab/refs/*.png — kept OUT of git, they
// are someone else's game) were taken by an unknown camera. For each one the
// pixel positions of a few horse landmarks are written down below; the camera
// is fitted so OUR horse's landmarks land on those pixels (position, look-at,
// lens), then our rider is rendered through that camera at the screenshot's
// exact size — no squeeze — beside it and overlaid on it.
//
// The reference horse is the armored horse, ours the Quaternius one: the fit
// is good to ~20–25 px, so small differences are noise; big ones are real.
//
// rider landmarks (optional): reference joints, compared in pixels with ours.
import * as THREE from "three";

const V3 = THREE.Vector3;

export const REFS = {
  mount1: { size: [609, 496], horse: { nose: [42, 152], poll: [68, 71], tail: [446, 184], foreNear: [181, 446], hindNear: [420, 439] },
    rider: { hip: [336, 207], knee: [258, 216], ankle: [278, 300], head: [329, 107] } },   // left (near) leg raised into the iron
  mount2: { size: [551, 483], horse: { nose: [45, 150], poll: [72, 78], tail: [445, 190], foreNear: [192, 405], hindNear: [400, 393] } },   // approximate
  mount3: { size: [624, 414], horse: { nose: [45, 148], poll: [72, 45], tail: [445, 180], foreNear: [192, 378], hindNear: [402, 370] } },   // approximate
  mount4: { size: [614, 501], horse: { nose: [58, 296], poll: [76, 192], tail: [440, 214], foreNear: [186, 455], hindNear: [445, 460] } },
  mount5: { size: [591, 459], horse: { nose: [55, 270], poll: [72, 175], tail: [425, 205], foreNear: [180, 420], hindNear: [425, 425] } },   // landmarks approximate
  dismount4: { size: [486, 406], horse: { nose: [57, 160], poll: [74, 100], tail: [366, 220], foreNear: [154, 366], hindNear: [320, 394] } },   // read off a grid
  dismount5: { size: [412, 378], horse: { nose: [35, 132], poll: [46, 80], tail: [318, 166], foreNear: [134, 322], hindNear: [292, 330] } },   // approximate
  dismount6: { size: [407, 323], horse: { nose: [32, 128], poll: [62, 70], tail: [325, 140], foreNear: [158, 285], hindNear: [295, 248] } },   // approximate
  mount10: { size: [489, 388], horse: { nose: [25, 172], poll: [48, 104], tail: [348, 182], foreNear: [154, 366], hindNear: [308, 361] },
    rider: { hip: [217, 151], knee: [194, 202], ankle: [212, 265], head: [195, 45] } },
};

function horseLandmarks(H) {
  const h = H.horse, c = H.ctrl, rd = H.rider;
  const bone = (n) => { let b; h.rig.traverse((o) => { if (o.name === n) b = o; }); return b.getWorldPosition(new V3()); };
  h.rig.updateMatrixWorld(true);
  return {
    nose: rd.bits[0].getWorldPosition(new V3()).add(rd.bits[1].getWorldPosition(new V3())).multiplyScalar(0.5),
    poll: bone("Head"), tail: bone("Tail1"),
    foreNear: bone("FFL").setY(c.y), hindNear: bone("FFBL").setY(c.y),
  };
}

// q = [camera offset x y z, look-at offset x y z, fov] relative to the horse
function makeProject(H, W, Hh) {
  const cam = new THREE.PerspectiveCamera(30, W / Hh, 0.05, 500), c = H.ctrl;
  const set = (q) => { cam.fov = q[6]; cam.aspect = W / Hh; cam.position.set(c.pos.x + q[0], c.y + q[1], c.pos.z + q[2]); cam.lookAt(c.pos.x + q[3], c.y + q[4], c.pos.z + q[5]); cam.updateProjectionMatrix(); cam.updateMatrixWorld(); };
  const proj = (p) => { const v = p.clone().project(cam); return [(v.x + 1) / 2 * W, (1 - v.y) / 2 * Hh, v.z]; };
  return { cam, set, proj };
}

export function fitRefCamera(H, name) {
  const ref = REFS[name], [W, Hh] = ref.size;
  const key = `${H.horse.height}`;
  if (ref._q?.[key]) return ref._q[key];   // (cached per horse height)
  const L = horseLandmarks(H), names = Object.keys(ref.horse);
  const { set, proj } = makeProject(H, W, Hh);
  // a game camera: above the ground, a normal lens (a planar set of points also fits a camera under the floor)
  const err = (q) => { if (q[1] < 0.6 || q[6] < 25 || q[6] > 65) return 1e9; set(q); let e = 0; for (const n of names) { const r = proj(L[n]); if (r[2] > 1) return 1e9; e += (r[0] - ref.horse[n][0]) ** 2 + (r[1] - ref.horse[n][1]) ** 2; } return e; };
  let best = [3.6, 1.3, 0.6, 0.2, 0.8, 0, 30], be = err(best);
  // deterministic search: shrinking coordinate steps (reproducible fits)
  for (let step = 0.8; step > 0.002; step *= 0.7) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let j = 0; j < 7; j++) for (const s of [-1, 1]) {
        const q = best.slice(); q[j] += s * step * (j === 6 ? 12 : 1);
        if (j === 6) q[6] = Math.max(8, Math.min(90, q[6]));
        const e = err(q); if (e < be) { be = e; best = q; improved = true; }
      }
    }
  }
  (ref._q ??= {})[key] = best;
  ref._rms = Math.sqrt(be / names.length);
  return best;
}

// pairs: [[refName, clip, frame], …]; clip "ride:idle" etc. holds a riding posture.
export async function compareRefs(H, pairs, { scale = 0.6 } = {}) {
  const E = H.editor, R0 = H.renderer, rd = H.rider;
  const out = [];
  const rows = [];
  for (const [name, clip, frame] of pairs) {
    const ref = REFS[name], [W, Hh] = ref.size, q = fitRefCamera(H, name);
    const im = new Image(); im.src = `/v3/horse-lab/refs/${name}.png`; await im.decode();
    E.open(clip);
    if (!clip.startsWith("ride:")) E.setT(frame / 60);
    E.playing = false;
    const { cam, set, proj } = makeProject(H, W, Hh);
    const helpers = [...Object.values(E.handles), ...Object.values(E.paths), E.tc.getHelper(), ...E.kneeArrows];
    for (let r = 0; r < 3; r++) {
      await new Promise((rr) => requestAnimationFrame(rr));
      R0.setSize(W, Hh, false); for (const h of helpers) h.visible = false; set(q); R0.render(H.scene, cam);
    }
    const shot = document.createElement("canvas"); shot.width = R0.domElement.width; shot.height = R0.domElement.height;
    shot.getContext("2d").drawImage(R0.domElement, 0, 0);
    // joints in pixels
    let joints = null;
    if (ref.rider) {
      const g = rd.B.legs[0], w = (b) => b.getWorldPosition(new V3());
      const ours = { hip: w(g.u), knee: w(g.l), ankle: w(g.tip), head: w(rd.B.head) };
      joints = {};
      for (const [k, p] of Object.entries(ref.rider)) { const r = proj(ours[k]); joints[k] = { ours: [Math.round(r[0]), Math.round(r[1])], ref: p, dx: Math.round(r[0] - p[0]), dy: Math.round(r[1] - p[1]) }; }
    }
    rows.push({ im, shot, W, Hh, label: `${name} | ${clip}${clip.startsWith("ride:") ? "" : " f" + frame}`, rms: ref._rms });
    out.push({ name, clip, frame, fitRmsPx: +ref._rms.toFixed(1), joints });
  }
  R0.setSize(innerWidth, innerHeight, true);
  E.tc.getHelper().visible = true; E.close();
  // sheet: reference | ours | overlay, one row each, every image at its own true aspect
  const colW = Math.max(...rows.map((r) => r.W)) * scale;
  const sheet = document.createElement("canvas");
  sheet.width = colW * 3; sheet.height = rows.reduce((s, r) => s + r.Hh * scale, 0);
  const g = sheet.getContext("2d");
  let y = 0;
  for (const r of rows) {
    const w = r.W * scale, h = r.Hh * scale;
    g.drawImage(r.im, 0, y, w, h);
    g.drawImage(r.shot, colW, y, w, h);
    g.drawImage(r.shot, colW * 2, y, w, h); g.globalAlpha = 0.5; g.drawImage(r.im, colW * 2, y, w, h); g.globalAlpha = 1;
    g.fillStyle = "#000"; g.font = "14px sans-serif";
    g.fillText("reference", 6, y + 16); g.fillText(`ours — ${r.label}`, colW + 6, y + 16); g.fillText(`overlay (fit ±${r.rms.toFixed(0)} px)`, colW * 2 + 6, y + 16);
    y += h;
  }
  document.getElementById("sheet")?.remove();
  const img = document.createElement("img"); img.id = "sheet"; img.src = sheet.toDataURL();
  img.style.cssText = "position:fixed;left:0;top:0;z-index:50;max-width:100vw;max-height:100vh;background:#888";
  img.onclick = () => img.remove();
  document.body.appendChild(img);
  return out;
}

// One pose, big, for review: the reference screenshot (left) beside ours
// (right), same picture size, through a hand-set camera (offset from the horse,
// look-at offset, lens). Stays on screen until clicked.
export const POSE_CAMS = {
  dismount4: { pos: [2.52, 2.89, -0.88], look: [0, 1.36, -0.07], fov: 45 },   // fitted (azimuth 108°, elevation 30°, 3.1 m), rms 18 px
  dismount5: { pos: [2.93, 2.66, -0.53], look: [0, 1.13, -0.02], fov: 45 },   // fitted, rms 14 px
  dismount6: { pos: [3.9, 2.3, 0.6], look: [0, 0.95, -0.1], fov: 40 },   // set by hand (the landmark fit went too close)
  mount2: { pos: [2.5, 1.45, -1.9], look: [0.05, 0.85, 0.2], fov: 46 },   // set by hand: behind his back, close, eye about at the horse's back
  behindLeft: { pos: [0.75, 1.95, -3.0], look: [0.35, 1.05, 0.3], fov: 42 },   // mountB1–B3 (behind the horse, a little to its left)
  frontLeft: { pos: [4.3, 2.5, 1.3], look: [0.2, 1.05, -0.25], fov: 38 },   // dismount4 / dismount5
  side: { pos: [-4.6, 1.75, 0.6], look: [0, 1.05, 0.15], fov: 40 },   // the horse's right side, facing right in the picture (idleSide)
  behind: { pos: [0.2, 2.75, -3.9], look: [0, 1.4, 0], fov: 40 },   // matched to dismountB1–B3
};
export async function showPose(H, ref, clip, frame, camName = "behind", label = "") {
  const E = H.editor, c = H.ctrl, R0 = H.renderer;
  // "fit": the camera fitted to the screenshot's horse landmarks (REFS)
  let C = POSE_CAMS[camName];
  if (camName === "fit") { const q = fitRefCamera(H, ref); C = { pos: q.slice(0, 3), look: q.slice(3, 6), fov: q[6] }; }
  const im = new Image(); im.src = `/v3/horse-lab/refs/${ref}.png`; await im.decode();
  const Hh = Math.min(innerHeight - 20, 760), W = Math.round(Hh * im.width / im.height);
  E.open(clip); E.playing = false;
  if (!clip.startsWith("ride:")) {
    // play up to the frame at 60 fps (as the game does): released irons fall, smoothing settles
    const ms = H.rider.mountSys; ms.groundW = null; ms.ironW = null; ms.ikIronW = null; ms.polePrev = null; ms.armPolePrev = null; ms.tgtPrev = null; ms.poleTurn = null;
    for (let i = 0; i <= frame; i++) { ms.edit = { clip, t: i / 60, playing: i > 0 }; H.rider.update(i ? 1 / 60 : 0, {}); }
    E.setT(frame / 60);
  }
  const cam = new THREE.PerspectiveCamera(C.fov, W / Hh, 0.05, 500);
  const helpers = [...Object.values(E.handles), ...Object.values(E.paths), E.tc.getHelper(), ...E.kneeArrows];
  H.D.paused = true;   // hold the stepped state while rendering
  for (let r = 0; r < 3; r++) {
    await new Promise((rr) => requestAnimationFrame(rr));
    R0.setSize(W, Hh, false); for (const h of helpers) h.visible = false;
    // offsets are in the HORSE's frame (x = its left, z = forward): turn them with it
    const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), rot = (v) => [v[0] * cy + v[2] * sy, v[1], -v[0] * sy + v[2] * cy];
    const cp = rot(C.pos), cl = rot(C.look);
    cam.position.set(c.pos.x + cp[0], c.y + cp[1], c.pos.z + cp[2]); cam.lookAt(c.pos.x + cl[0], c.y + cl[1], c.pos.z + cl[2]); cam.updateMatrixWorld();
    R0.render(H.scene, cam);
  }
  const sheet = document.createElement("canvas"); sheet.width = W * 2 + 10; sheet.height = Hh;
  const g = sheet.getContext("2d"); g.fillStyle = "#222"; g.fillRect(0, 0, sheet.width, Hh);
  g.drawImage(im, 0, 0, W, Hh); g.drawImage(R0.domElement, W + 10, 0, W, Hh);
  g.fillStyle = "#fff"; g.font = "bold 20px sans-serif";
  g.fillText("REFERENCE", 10, 28); g.fillText(`OURS  ${label}`, W + 20, 28);
  H.D.paused = false;
  R0.setSize(innerWidth, innerHeight, true); E.tc.getHelper().visible = true; E.close();
  document.getElementById("sheet")?.remove();
  const img = document.createElement("img"); img.id = "sheet"; img.src = sheet.toDataURL();
  img.style.cssText = "position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:50;max-width:98vw;max-height:96vh;border:2px solid #fff";
  img.title = "click to close"; img.onclick = () => img.remove();
  document.body.appendChild(img);
}
