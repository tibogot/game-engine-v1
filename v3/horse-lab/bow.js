// ── Horse lab: the BOW (the robot on foot) ───────────────────────────────────
// The robot has no archery clip: its idle / walk clips play under the legs and
// the upper body is posed on top, the same way the lance and the banner are
// held — spine, head, two-bone arm IK, hands turned to a direction, fingers
// curled per joint:
//
//   stance   aiming, the body turns side-on to the target (left shoulder to
//            it), the chest a little open, the head turned back along the arrow;
//            aiming up / down the upper body bends sideways at the waist (the
//            archer's "T" stays square), not just the arms
//   bow arm  the left arm almost straight along the arrow, the fist round the
//            grip (knuckles canted), the elbow turned out of the string's way
//   draw     the right hand hooks the string (three fingers, pinky tucked) and
//            takes it from the bow to an anchor under the cheek; the arrow lies
//            from the string to the rest on the bow
//   the bow  a recurve whose limbs BEND with the draw: the string keeps its
//            length, so the limbs bend as far as the nock is pulled (solved
//            every frame) — the tips come back and in, the recurves unroll
//   shoot    release: the string snaps forward and rings, the bow hand flicks,
//            the draw hand flies back past the ear; the arrow flies with gravity
//            and sticks where it hits (targets, ground, fences); next arrow
//            from the quiver on the back (reach, pull, bring, nock)
//
// Controls (bow on, on foot): hold RIGHT mouse (or G) to aim, hold LEFT mouse
// (or T) to draw, let go to shoot. V: bow on / off.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { rotateWorld, solveTwoBone } from "./horse.js";
import { gallows, crateStack, jar, dummy, contactMats, shadowed, shapeTest } from "./lanceContact.js";

const V3 = THREE.Vector3, Q = THREE.Quaternion;
const clamp = THREE.MathUtils.clamp;
const lerpK = (rate, dt) => 1 - Math.exp(-rate * dt);
const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };
const wpos = (o) => o.getWorldPosition(new V3());
const UP = new V3(0, 1, 0);
const G = 9.8, DRAG = 0.0012;                                     // air drag: dv/dt = −DRAG·|v|·v (per m)
// one step of an arrow's flight — the SAME for the arrows, the aim and the debug arc
function stepFlight(p, v, dt) { v.y -= G * dt; v.multiplyScalar(Math.exp(-DRAG * v.length() * dt)); p.addScaledVector(v, dt); }
// the launch angle that drops onto (x ahead, y up) at speed v, with drag (bisection on the flight itself)
function launchAngle(x, y, v) {
  const heightAt = (th) => {
    const p = new V3(), u = new V3(Math.cos(th) * v, Math.sin(th) * v, 0), q = new V3();
    for (let i = 0; i < 600; i++) { q.copy(p); stepFlight(p, u, 1 / 120); if (p.x >= x) return q.y + (p.y - q.y) * (x - q.x) / (p.x - q.x || 1); }
    return -1e9;
  };
  let lo = -0.7, hi = 0.75;
  for (let it = 0; it < 18; it++) { const m = (lo + hi) / 2; if (heightAt(m) < y) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

export const BP = {
  on: false,            // the bow, on foot (V)
  drawTime: 0.8,        // s from brace to full draw (Mixamo "Shooting Arrow": 1.95 → 2.75 s)
  minSpeed: 20, maxSpeed: 62,   // m/s off the string: a light draw … a full draw
  hipOpen: 0.32,        // rad the feet stay turned toward the target from side-on
  chestOpen: 0.25,      // rad the chest stays turned toward the target from side-on
  bend: 0.75,           // share of the aim's pitch taken by the waist (sideways bend)
  anchor: [0.075, 0.07, 0.025],    // the anchor from the head bone: m forward, right, up (under the right cheek bone)
  bowReach: 0.97,       // the bow arm's reach (share of its length)
  cant: 0.1,            // rad the bow leans (top to the right)
  lookReady: 0.45,      // share of the turn to the target the head makes while fetching / nocking
  lookDown: 0.3,        // rad the head tips down onto the hands then
  readyRoll: 1.0,       // rad the READY bow (nocking) is rolled round the arrow: its lower limb out toward the target and the ground, the top back toward the right shoulder (0: the lower limb crossed the thighs)
  readyIn: -0.1,        // m the ready bow is held in from the bow shoulder toward the middle (−: out; Mixamo nocks in front of the left hip)
  readyDown: 0.36,      // m below the bow shoulder (chest frame)
  readyFwd: 0.36,       // m in front of it        // m the ready bow is held in from the bow shoulder toward the middle
  followThrough: 0.1,   // s the arms stay up after a shot (Mixamo: 0.1 s, then they lower)
  lowerTime: 0.8,       // s the arms take to lower after it (Mixamo 4.0 → 4.8 s); the next arrow is fetched from rest
  repeatFromHold: false, // true: the next arrow straight from the follow-through (the hand up by the neck)
  fetchTime: 3.15,       // s: hand to the quiver, arrow out, onto the string (reach 1.1, close 0.2, pull 0.55, bring 0.85, nock 0.3)
  aimTime: 0.28,        // s to raise / lower the bow
  tauGrab: -35,         // the right forearm's roll at the quiver (degrees, −90 relaxed, 0 palm up)
  tauHook: -70,         // … and on the string
  quiverNocks: [-0.06, 0.34, -0.08],   // m from the right shoulder (right, up, forward): where the hand takes an arrow
  quiverAxis: [0.3, 0.94, 0.085],       // the quiver's slant (same frame): up, toward the right shoulder, tops a touch forward
  mocap: true,          // the whole body from the retargeted Mixamo clip (anims/bow-shot-mocap.json) when loaded; the IK only corrects
  keyed: true,          // the fetch from the timeline editor (anims/bow-fetch.json) when there is one
  debug: false,
};

// ── seeded noise for the painted textures ────────────────────────────────────
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const canvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return [c, c.getContext("2d")]; };
const tex = (c, rep = [1, 1]) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...rep); t.anisotropy = 8; return t; };

// The bow's wood, laid along its length (u: round the limb, v: tip to tip):
// a honey-coloured back, a darker belly, lamination lines on the sides, long
// wavy grain, a walnut riser in the middle, horn caps on the tips
function bowWoodTexture() {
  const W = 128, H = 1024, [c, g] = canvas(W, H), r = rng(7);
  const band = (u0, u1, col) => { g.fillStyle = col; g.fillRect(u0 * W, 0, (u1 - u0) * W, H); };
  band(0, 1, "#8d5527");
  band(0.12, 0.38, "#b07636");                                   // the back (faces the target): lighter
  band(0.62, 0.88, "#6e3f1d");                                   // the belly: darker
  for (const u of [0.1, 0.4, 0.6, 0.9]) band(u - 0.012, u + 0.012, "rgba(40,20,8,0.55)");   // lamination glue lines on the sides
  // long grain
  for (let i = 0; i < 90; i++) {
    const x0 = r() * W, w = 0.4 + r() * 1.8, a = 0.08 + r() * 0.22, ph = r() * 6, amp = 1 + r() * 4, fq = 0.004 + r() * 0.01;
    g.strokeStyle = r() < 0.7 ? `rgba(55,25,8,${a})` : `rgba(235,180,110,${a * 0.8})`; g.lineWidth = w;
    g.beginPath(); for (let y = 0; y <= H; y += 8) { const x = x0 + Math.sin(y * fq + ph) * amp + Math.sin(y * fq * 3.1 + ph * 2) * amp * 0.3; y ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
  }
  // the riser (the middle 22 %): walnut, its own grain
  const r0 = 0.39 * H, r1 = 0.61 * H;
  const gr = g.createLinearGradient(0, r0, 0, r1); gr.addColorStop(0, "rgba(58,30,14,0)"); gr.addColorStop(0.08, "rgba(58,30,14,0.92)"); gr.addColorStop(0.92, "rgba(58,30,14,0.92)"); gr.addColorStop(1, "rgba(58,30,14,0)");
  g.fillStyle = gr; g.fillRect(0, r0, W, r1 - r0);
  for (let i = 0; i < 40; i++) { const x0 = r() * W; g.strokeStyle = `rgba(${r() < 0.5 ? "25,10,4" : "120,70,35"},${0.15 + r() * 0.25})`; g.lineWidth = 0.5 + r() * 1.5; g.beginPath(); for (let y = r0; y <= r1; y += 6) { const x = x0 + Math.sin(y * 0.03 + i) * 3; y === r0 ? g.moveTo(x, y) : g.lineTo(x, y); } g.stroke(); }
  // horn tip caps, an ivory ring where they meet the wood
  for (const [y0, y1] of [[0, 0.028 * H], [H - 0.028 * H, H]]) { g.fillStyle = "#2a1d14"; g.fillRect(0, y0, W, y1 - y0); for (let i = 0; i < 12; i++) { g.fillStyle = `rgba(110,85,60,${r() * 0.3})`; g.fillRect(r() * W, y0, 1 + r() * 2, y1 - y0); } }
  g.fillStyle = "#e9dcc0"; g.fillRect(0, 0.028 * H, W, 5); g.fillRect(0, H - 0.028 * H - 5, W, 5);
  // pores / specks
  for (let i = 0; i < 1600; i++) { g.fillStyle = `rgba(30,12,4,${r() * 0.18})`; g.fillRect(r() * W, r() * H, 1, 1 + r() * 4); }
  return tex(c);
}
// a leather strip wound round the grip (diagonal turns, worn edges, stitches)
function leatherWrapTexture() {
  const W = 128, H = 128, [c, g] = canvas(W, H), r = rng(11);
  g.fillStyle = "#3c2416"; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 2600; i++) { g.fillStyle = `rgba(${r() < 0.5 ? "20,10,5" : "95,62,40"},${r() * 0.25})`; g.fillRect(r() * W, r() * H, 1 + r() * 2, 1 + r() * 2); }
  g.save(); g.translate(W / 2, H / 2); g.rotate(-0.35); g.translate(-W, -H);
  for (let y = -H; y < 3 * H; y += 32) {
    const gr = g.createLinearGradient(0, y, 0, y + 32); gr.addColorStop(0, "rgba(0,0,0,0.55)"); gr.addColorStop(0.18, "rgba(120,80,50,0.25)"); gr.addColorStop(0.5, "rgba(0,0,0,0)"); gr.addColorStop(0.9, "rgba(0,0,0,0.25)"); gr.addColorStop(1, "rgba(0,0,0,0.6)");
    g.fillStyle = gr; g.fillRect(0, y, 3 * W, 32);
  }
  g.restore();
  return tex(c, [2, 3]);
}
// cord whipping: tight turns of dark thread with a light tracer
function cordTexture() {
  const [c, g] = canvas(64, 64);
  g.fillStyle = "#151210"; g.fillRect(0, 0, 64, 64);
  for (let y = 0; y < 64; y += 4) { g.fillStyle = "rgba(255,255,255,0.13)"; g.fillRect(0, y, 64, 1); g.fillStyle = "rgba(0,0,0,0.6)"; g.fillRect(0, y + 3, 64, 1); }
  g.fillStyle = "#c9b48a"; for (const y of [0, 32]) g.fillRect(0, y + 1, 64, 2);   // the light tracer turns (the reference's bands)
  return tex(c, [1, 4]);
}
// arrow shaft: pale ash, painted cresting below the fletching, a dark nock
function shaftTexture() {
  const W = 32, H = 512, [c, g] = canvas(W, H), r = rng(23);
  g.fillStyle = "#d7b47a"; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 24; i++) { const x = r() * W; g.fillStyle = `rgba(120,80,40,${0.1 + r() * 0.2})`; g.fillRect(x, 0, 0.6 + r(), H); }
  for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(90,55,25,${r() * 0.2})`; g.fillRect(r() * W, r() * H, 1, 2 + r() * 6); }
  // v runs nock (0) → head (1): cresting at 0.26–0.32 (just ahead of the fletching), the nock 0–0.025
  const band = (v0, v1, col) => { g.fillStyle = col; g.fillRect(0, v0 * H, W, (v1 - v0) * H); };
  band(0.255, 0.28, "#8d1b1f"); band(0.285, 0.291, "#141414"); band(0.296, 0.321, "#8d1b1f");
  band(0, 0.026, "#1f2b22");
  return tex(c);
}
// fletching: two feathers in one picture (top: grey-white hen feathers,
// bottom: the barred cock feather), shield-cut, barbs raking back
function featherTexture() {
  const W = 256, H = 128, [c, g] = canvas(W, H), r = rng(5);
  for (const [y0, base, bar] of [[0, "#e8e4da", "rgba(110,110,105,0.5)"], [64, "#b8362c", "rgba(40,15,10,0.45)"]]) {
    g.save(); g.beginPath();
    // x = along the arrow (0 back … 1 front), y = out from the shaft (bottom edge = the shaft)
    g.moveTo(4, y0 + 60); g.lineTo(4, y0 + 8); g.quadraticCurveTo(70, y0 + 2, 150, y0 + 22); g.quadraticCurveTo(220, y0 + 42, 252, y0 + 60); g.closePath(); g.clip();
    g.fillStyle = base; g.fillRect(0, y0, W, 64);
    for (let x = -60; x < W + 60; x += 2.2) { g.strokeStyle = r() < 0.5 ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.12)"; g.lineWidth = 1; g.beginPath(); g.moveTo(x, y0 + 62); g.lineTo(x - 28, y0); g.stroke(); }
    for (let k = 0; k < 4; k++) { g.fillStyle = bar; const x = 30 + k * 52; g.beginPath(); g.moveTo(x, y0 + 64); g.lineTo(x + 14, y0 + 64); g.lineTo(x - 14, y0); g.lineTo(x - 28, y0); g.fill(); }
    g.restore();
    g.fillStyle = "#3a3026"; g.fillRect(0, y0 + 58, W, 6);           // the quill along the shaft
  }
  const t = tex(c); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t;
}
// quiver leather: oiled brown hide, a stitched seam, scuffs
function quiverLeatherTexture() {
  const W = 256, H = 512, [c, g] = canvas(W, H), r = rng(31);
  g.fillStyle = "#6a4024"; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(${r() < 0.5 ? "30,14,6" : "150,100,60"},${r() * 0.12})`; g.fillRect(r() * W, r() * H, 1 + r() * 3, 1 + r() * 3); }
  for (let i = 0; i < 40; i++) { g.strokeStyle = `rgba(30,15,5,${0.1 + r() * 0.15})`; g.lineWidth = 0.5 + r(); g.beginPath(); const x = r() * W, y = r() * H; g.moveTo(x, y); g.bezierCurveTo(x + r() * 40 - 20, y + r() * 40, x + r() * 60 - 30, y + r() * 60, x + r() * 80 - 40, y + r() * 90); g.stroke(); }
  // the seam (u ≈ 0.5 → the back of the quiver)
  g.fillStyle = "rgba(25,12,5,0.7)"; g.fillRect(W / 2 - 2, 0, 4, H);
  for (let y = 4; y < H; y += 12) { g.fillStyle = "#d8c9a4"; g.fillRect(W / 2 - 9, y, 5, 2); g.fillRect(W / 2 + 4, y + 6, 5, 2); }
  return tex(c);
}

// ── geometry helpers ─────────────────────────────────────────────────────────
// a lathe along +z with its texture v proportional to LENGTH (z0 → z1)
function latheZ(profile, seg = 16) {
  const geo = new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(r, z)), seg);
  geo.rotateX(Math.PI / 2);
  const P = geo.attributes.position, U = geo.attributes.uv, z0 = profile[0][1], z1 = profile[profile.length - 1][1];
  for (let i = 0; i < P.count; i++) U.setY(i, (P.getZ(i) - z0) / (z1 - z0));
  return geo;
}

// the meshes under `group` (but not under `keep`) → one mesh per material,
// textures kept (draw calls: the quiver with its arrows was 30+ meshes)
function mergeByMaterial(group, keep = null) {
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert(), by = new Map();
  group.traverse((o) => {
    if (!o.isMesh) return;
    for (let p = o; p; p = p.parent) if (p === keep) return;
    if (!by.has(o.material)) by.set(o.material, []);
    by.get(o.material).push(o);
  });
  for (const [mat, list] of by) {
    if (list.length < 2) continue;
    const geos = list.map((m) => {
      const g0 = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone(), g = new THREE.BufferGeometry();
      for (const n of ["position", "normal", "uv"]) g.setAttribute(n, g0.attributes[n].clone());
      g.applyMatrix4(inv.clone().multiply(m.matrixWorld));
      return g;
    });
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
    mesh.castShadow = list.some((m) => m.castShadow); mesh.receiveShadow = list.some((m) => m.receiveShadow);
    for (const m of list) m.removeFromParent();
    group.add(mesh);
  }
}

// ── the bow ──────────────────────────────────────────────────────────────────
// Local frame: the GRIP (where the palm closes) at the origin, +y up the
// limbs, +z the bow's back (toward the target), the string on −z.
const RISER = 0.17, LIMB = 0.6, SEG = 14, NL = 40, NR = 26;
// cross-section (half width x, half thickness, belly bulge) at arc distance a from the middle
function section(a) {
  a = Math.abs(a);
  if (a < RISER) {
    const g = 1 - smooth((a - 0.05) / 0.09);                   // the grip: deep and narrow, bulging toward the hand
    return { w: 0.019 - 0.003 * g, t: 0.017 + 0.011 * g, bulge: -0.008 * g };
  }
  const u = (a - RISER) / LIMB;
  const tipCap = smooth((u - 0.955) / 0.03);
  return { w: (0.021 - 0.013 * u ** 0.9) * (1 + 0.15 * tipCap), t: (0.0085 - 0.003 * u) * (1 + 0.5 * tipCap), bulge: 0 };
}
// the upper half's centre line for a bend b (0 braced … ~1 full draw): points
// [y, z, angle] from the middle outward; the lower half mirrors it
function halfLine(b, out) {
  let y = 0, z = 0, th = 0;
  for (let i = 0; i <= NR / 2; i++) {                            // the riser: straight, the limb pockets set forward (reflex)
    const s = (i / (NR / 2)) * RISER;
    out.push([s, 0.016 * smooth((s - 0.05) / 0.12), 0]);
  }
  y = RISER; z = 0.016; th = 0.1;
  const dl = LIMB / NL;
  for (let i = 1; i <= NL; i++) {
    const l = i * dl;
    // working limb: bends back (toward the archer) more as the bow is drawn;
    // the last quarter curls forward (the recurve), and unrolls a little at full draw
    const k = l < 0.44 ? (0.95 + 1.75 * b) * (1 - 0.35 * l / 0.44) : l < 0.47 ? 0 : -(3.3 - 1.4 * b);
    th += k * dl;
    y += Math.cos(th) * dl; z -= Math.sin(th) * dl;
    out.push([y, z, th]);
  }
  return out;
}
function makeBow() {
  const group = new THREE.Group(); group.name = "bow";
  const ringsUp = [];
  halfLine(0, ringsUp);
  const N = ringsUp.length * 2 - 1;                              // lower (mirrored, tip first) + upper
  const pos = new Float32Array(N * (SEG + 1) * 3), uv = new Float32Array(N * (SEG + 1) * 2), idx = [];
  for (let i = 0; i < N - 1; i++) for (let j = 0; j < SEG; j++) {
    const a = i * (SEG + 1) + j, b2 = a + 1, c = a + SEG + 1, d = c + 1;
    idx.push(a, c, b2, b2, c, d);                                 // outward (worked out: (lower, upper, lower+1) faced in)
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const wood = new THREE.MeshPhysicalMaterial({ map: bowWoodTexture(), roughness: 0.42, clearcoat: 0.55, clearcoatRoughness: 0.32 });
  const limbs = new THREE.Mesh(geo, wood); limbs.castShadow = true; limbs.frustumCulled = false; group.add(limbs);

  // fill the ring vertices for bend b; returns the tips' string grooves (local)
  const line = [];
  function build(b) {
    line.length = 0; halfLine(b, line);
    const pts = [];
    for (let i = line.length - 1; i >= 1; i--) { const [y, z, th] = line[i]; pts.push([-y, z, -th, -(i <= NR / 2 ? (i / (NR / 2)) * RISER : RISER + (i - NR / 2) / NL * LIMB)]); }
    for (let i = 0; i < line.length; i++) { const [y, z, th] = line[i]; pts.push([y, z, th, i <= NR / 2 ? (i / (NR / 2)) * RISER : RISER + (i - NR / 2) / NL * LIMB]); }
    const total = 2 * (RISER + LIMB);
    for (let i = 0; i < pts.length; i++) {
      const [y, z, , a] = pts[i];
      // tangent from the neighbours (the mirrored half runs downward in y: its angle sign flips)
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(pts.length - 1, i + 1)];
      let ty = p1[0] - p0[0], tz = p1[1] - p0[1]; const tl = Math.hypot(ty, tz) || 1; ty /= tl; tz /= tl;
      const ny = -tz, nz = ty;                                      // ⟂ the tangent, toward the back (+z on a straight limb)
      const s = section(a), end = Math.abs(a) > RISER + LIMB - 1e-4 ? 0.35 : 1;   // the very tip rounded off
      for (let j = 0; j <= SEG; j++) {
        const ph = (j / SEG) * Math.PI * 2, cx = Math.cos(ph), sx = Math.sin(ph);
        const ex = Math.sign(cx) * Math.abs(cx) ** 0.6, ez = Math.sign(sx) * Math.abs(sx) ** 0.6;   // a rounded rectangle
        const off = s.w * ex * end, off2 = (s.t * ez + s.bulge * Math.max(0, -sx)) * end;
        const k = (i * (SEG + 1) + j);
        pos[k * 3] = off; pos[k * 3 + 1] = y + ny * off2; pos[k * 3 + 2] = z + nz * off2;
        uv[k * 2] = j / SEG; uv[k * 2 + 1] = (a + total / 2) / total;
      }
    }
    geo.attributes.position.needsUpdate = true; geo.computeVertexNormals(); geo.computeBoundingSphere();
    const tip = line[line.length - 3];                              // the string groove: just short of the very end
    return { top: new V3(0, tip[0], tip[1] - 0.004), bot: new V3(0, -tip[0], tip[1] - 0.004) };
  }

  // the grip's leather wrap and the cord whipping either side of it (static: the riser does not bend)
  const sleeve = (a0, a1, grow, mat, n = 10) => {
    const P = [], I = [], U = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * i / n, s = section(a);
      for (let j = 0; j <= SEG; j++) {
        const ph = (j / SEG) * Math.PI * 2, cx = Math.cos(ph), sx = Math.sin(ph);
        const ex = Math.sign(cx) * Math.abs(cx) ** 0.6, ez = Math.sign(sx) * Math.abs(sx) ** 0.6;
        P.push((s.w + grow) * ex, a, (s.t + grow) * ez + s.bulge * Math.max(0, -sx) + 0.016 * smooth((Math.abs(a) - 0.05) / 0.12));
        U.push(j / SEG, (a - a0) / 0.06);
      }
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < SEG; j++) { const a = i * (SEG + 1) + j, b2 = a + 1, c = a + SEG + 1, d = c + 1; I.push(a, c, b2, b2, c, d); }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2)); g.setIndex(I); g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat); m.castShadow = true; group.add(m); return m;
  };
  const leather = new THREE.MeshStandardMaterial({ map: leatherWrapTexture(), roughness: 0.82 });
  const cord = new THREE.MeshStandardMaterial({ map: cordTexture(), roughness: 0.55 });
  sleeve(-0.06, 0.055, 0.0025, leather, 12);
  const cords = new THREE.Group(); group.add(cords);
  for (const [a0, a1] of [[-0.085, -0.062], [0.057, 0.08], [0.15, 0.172], [-0.172, -0.15]]) cords.attach(sleeve(a0, a1, 0.0035, cord, 3));
  mergeByMaterial(cords);
  // an arrow shelf: a small ledge of horn on the left side above the grip
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.006, 0.03), new THREE.MeshStandardMaterial({ color: 0x2a1d14, roughness: 0.5 }));
  shelf.position.set(0.019, 0.058, 0.002); group.add(shelf);

  // the string: two lengths and the serving at the nocking point (unit cylinders, placed each frame)
  const strMat = new THREE.MeshStandardMaterial({ color: 0x24201c, roughness: 0.55 });
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 6); unitCyl.translate(0, 0.5, 0);
  const str = [0, 1].map(() => { const m = new THREE.Mesh(unitCyl, strMat); m.castShadow = true; group.add(m); return m; });
  const serving = new THREE.Mesh(unitCyl, new THREE.MeshStandardMaterial({ color: 0x0f0d0c, roughness: 0.35, metalness: 0.2 })); group.add(serving);
  const between = (m, a, b, r) => { const d = b.clone().sub(a), L = d.length(); m.position.copy(a); m.quaternion.setFromUnitVectors(UP, d.divideScalar(L || 1)); m.scale.set(r, L, r); };

  let lastB = -1, tips = build(0);
  const Lstring = 2 * tips.top.y * 1.0 + 0;                         // straight between the grooves at brace
  const braceZ = tips.top.z;
  // the bend at which the string, pulled to the local nock point n, keeps its length
  const tipAt = (b) => { const l = []; halfLine(b, l); const t = l[l.length - 3]; return [t[0], t[1] - 0.004]; };
  function bendFor(n) {
    const dz = Math.min(0, n.z - braceZ);
    if (dz > -0.002) return 0;
    let lo = 0, hi = 1.6;
    for (let it = 0; it < 18; it++) {
      const m = (lo + hi) / 2, [ty, tz] = tipAt(m);
      const L = Math.hypot(ty - n.y, tz - n.z) + Math.hypot(ty + n.y, tz - n.z);
      if (L > Lstring) lo = m; else hi = m;
    }
    return (lo + hi) / 2;
  }
  return {
    group, braceZ, Lstring,
    /** pose the bow: n = the string's nocking point in bow space (null: at rest);
     *  extraBend = the limbs' ring after a shot (added, decaying) */
    set(n, extraBend = 0) {
      const b = Math.max(0, (n ? bendFor(n) : 0) + extraBend);
      if (Math.abs(b - lastB) > 0.004) { tips = build(b); lastB = b; }   // (a rebuild + normals: only when the bend really moves)
      const nk = n ?? new V3(0, 0, tips.top.z);
      between(str[0], tips.bot, nk, 0.0016); between(str[1], nk, tips.top, 0.0016);
      const d = tips.top.clone().sub(nk).normalize();
      between(serving, nk.clone().addScaledVector(d, -0.05), nk.clone().addScaledVector(d, 0.07), 0.0024);
      return b;
    },
    get tips() { return tips; },
  };
}

// ── the arrow ────────────────────────────────────────────────────────────────
// +z from the nock throat (0) to the point (0.76 m: the robot draws ~64 cm); shared geometry and materials
const ARROW_LEN = 0.84;   // (longer than the draw, ~0.77 m at full draw with the bow arm straight)
const TWIST_R0 = -165, TWIST_R1 = 5, TWIST_R = [TWIST_R0, TWIST_R1];   // the right forearm's roll range (forearmTwist), relaxed −90
let ARROW = null;
function arrowParts() {
  if (ARROW) return ARROW;
  const shaftMat = new THREE.MeshStandardMaterial({ map: shaftTexture(), roughness: 0.6 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.28, metalness: 0.95 });
  const feather = new THREE.MeshStandardMaterial({ map: featherTexture(), roughness: 0.9, side: THREE.DoubleSide, alphaTest: 0.5 });
  // shaft with its nock: a flared nock, a slim shaft, a little taper to the head
  const shaft = latheZ([[0.0001, -0.012], [0.0052, -0.011], [0.0058, 0.0], [0.0047, 0.018], [0.0043, 0.03], [0.0043, 0.68], [0.0039, 0.7]], 10);
  // the head: a ferrule (socket) and a leaf-shaped two-edged blade with a midrib
  const ferrule = latheZ([[0.0041, 0.692], [0.0052, 0.7], [0.0049, 0.715], [0.0028, 0.73]], 10).toNonIndexed();
  const leaf = new THREE.Shape(); leaf.moveTo(0, 0); leaf.quadraticCurveTo(0.014, 0.012, 0.0125, 0.026); leaf.quadraticCurveTo(0.009, 0.042, 0, 0.058); leaf.quadraticCurveTo(-0.009, 0.042, -0.0125, 0.026); leaf.quadraticCurveTo(-0.014, 0.012, 0, 0);
  const blade = new THREE.ExtrudeGeometry(leaf, { depth: 0.0012, bevelEnabled: true, bevelThickness: 0.0007, bevelSize: 0.0009, bevelSegments: 2, curveSegments: 10 });
  blade.translate(0, 0, -0.0006); blade.rotateX(Math.PI / 2); blade.translate(0, 0, 0.706);
  const rib = new THREE.ConeGeometry(0.0024, 0.05, 4); rib.rotateX(Math.PI / 2); rib.translate(0, 0, 0.74);
  const strip = (g) => { const n = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(n.attributes)) if (!["position", "normal", "uv"].includes(k)) n.deleteAttribute(k); return n; };
  const head = mergeGeometries([strip(ferrule), strip(blade), strip(rib)]);
  head.computeVertexNormals();
  // three vanes, shield-cut, set with a slight helix; the cock feather (barred)
  // stands straight out from the bow (k = 0)
  const P = [], U = [], I = [];
  for (let k = 0; k < 3; k++) {
    const a0 = Math.PI / 2 + (k * 2 * Math.PI) / 3, base = P.length / 3, n = 8;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= 1; j++) {
      const t = i / n, z = 0.035 + t * 0.125, a = a0 + 0.07 * t, r = 0.0042 + j * 0.0175;
      P.push(Math.cos(a) * r, Math.sin(a) * r, z);
      U.push(t, (k === 0 ? 0.5 : 0) + 0.04 + j * 0.45);                 // v: the bottom row of the picture is the quill (canvas y down: flip)
    }
    for (let i = 0; i < n; i++) { const a = base + i * 2; I.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  for (let i = 1; i < U.length; i += 2) U[i] = 1 - U[i];
  const vanes = new THREE.BufferGeometry(); vanes.setAttribute("position", new THREE.Float32BufferAttribute(P, 3)); vanes.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2)); vanes.setIndex(I); vanes.computeVertexNormals();
  // (keyed for a 0.76 m arrow: the shaft is stretched, the head moved to the new tip)
  const S = ARROW_LEN / 0.76; shaft.scale(1, 1, S); head.translate(0, 0, ARROW_LEN - 0.76);
  ARROW = { shaft, head, vanes, shaftMat, steel, feather };
  return ARROW;
}
function makeArrow() {
  const A = arrowParts(), g = new THREE.Group(); g.name = "arrow";
  for (const [geo, mat] of [[A.shaft, A.shaftMat], [A.head, A.steel], [A.vanes, A.feather]]) { const m = new THREE.Mesh(geo, mat); m.castShadow = true; g.add(m); }
  return g;
}

// ── the quiver (on the back, its mouth at the right shoulder) ────────────────
const QUIVER_LEN = 0.48, QUIVER_N = 6;   // ~2/3 of the arrow: they stand ~30 cm out of it
function makeQuiver() {
  const g = new THREE.Group(); g.name = "quiver";
  const lth = new THREE.MeshStandardMaterial({ map: quiverLeatherTexture(), roughness: 0.75 });
  const band = new THREE.MeshStandardMaterial({ color: 0x3d4a57, roughness: 0.6 });      // the reference's blue-grey straps
  const brass = new THREE.MeshStandardMaterial({ color: 0xb08a4a, roughness: 0.35, metalness: 0.85 });
  const latheY = (prof, mat, seg = 28) => { const m = new THREE.Mesh(new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), seg), mat); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
  // body: a slightly flared tube, a rolled lip at the mouth, closed at the bottom
  latheY([[0.0, 0.0], [0.05, 0.004], [0.056, 0.02], [0.057, 0.3], [0.062, QUIVER_LEN - 0.02], [0.067, QUIVER_LEN], [0.06, QUIVER_LEN + 0.004], [0.056, QUIVER_LEN - 0.01]], lth);
  latheY([[0.0, -0.012], [0.054, -0.012], [0.059, 0.0], [0.059, 0.05], [0.0, 0.05]], band);          // the base cup
  // the INSIDE: the tube above is single-sided — seen through its mouth, its inner
  // wall was not drawn and the ground showed through. An inner wall (the profile
  // run downward: its faces point in) in darker, shaded leather, and a floor
  const inner = new THREE.MeshStandardMaterial({ map: lth.map, color: 0x5a4a3e, roughness: 0.9 });
  latheY([[0.056, QUIVER_LEN - 0.01], [0.0555, QUIVER_LEN - 0.08], [0.053, 0.3], [0.052, 0.03], [0.0, 0.025]], inner);
  for (const y of [0.13, QUIVER_LEN - 0.1]) latheY([[0.0595, y - 0.022], [0.0615, y - 0.018], [0.0615, y + 0.018], [0.0595, y + 0.022]], band);
  for (const y of [0.13, QUIVER_LEN - 0.1]) for (const s of [-1, 1]) { const r = new THREE.Mesh(new THREE.TorusGeometry(0.009, 0.0025, 6, 12), brass); r.position.set(s * 0.063, y, 0); r.rotation.y = Math.PI / 2; g.add(r); }   // strap rings
  // the arrows in it, nocks up, fletchings out of the mouth
  const arrows = [];
  for (let i = 0; i < QUIVER_N; i++) {
    const a = makeArrow(), ang = (i / QUIVER_N) * Math.PI * 2 + 0.3, r = i === 0 ? 0 : 0.03;
    a.position.set(Math.cos(ang) * r * 1.0, ARROW_LEN + 0.02 + (i % 3) * 0.015, Math.sin(ang) * r);   // resting on the bottom
    a.quaternion.setFromUnitVectors(new V3(0, 0, 1), new V3(-Math.cos(ang) * 0.05, -1, -Math.sin(ang) * 0.05).normalize());
    a.rotateZ(i * 1.3);
    g.add(a); arrows.push(a);
  }
  // all but the one taken out to shoot merge with the quiver (one mesh per material)
  mergeByMaterial(g, arrows[0]);
  return { group: g, arrows: [arrows[0]], mouthY: QUIVER_LEN };
}

// a point a share s (0..1) of the way ALONG a smooth curve through pts
// (centripetal Catmull-Rom, by arc length: the speed follows s, not the keys)
function pathAt(pts, s) {
  const P = [pts[0].clone().multiplyScalar(2).sub(pts[1]), ...pts, pts[pts.length - 1].clone().multiplyScalar(2).sub(pts[pts.length - 2])];
  const cr = (p0, p1, p2, p3, t) => {
    const a = (x, y) => Math.max(1e-4, Math.sqrt(x.distanceTo(y)));
    const t0 = 0, t1 = a(p0, p1), t2 = t1 + a(p1, p2), t3 = t2 + a(p2, p3), u = t1 + (t2 - t1) * t;
    const L = (pa, pb, ta, tb) => pa.clone().multiplyScalar((tb - u) / (tb - ta)).addScaledVector(pb, (u - ta) / (tb - ta));
    const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3), B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
    return L(B1, B2, t1, t2);
  };
  const samp = [pts[0].clone()], len = [0];
  for (let i = 1; i < P.length - 2; i++) for (let k = 1; k <= 64; k++) { const q = cr(P[i - 1], P[i], P[i + 1], P[i + 2], k / 64); len.push(len[len.length - 1] + q.distanceTo(samp[samp.length - 1])); samp.push(q); }
  const want = clamp(s, 0, 1) * len[len.length - 1];
  let j = 1; while (j < len.length - 1 && len[j] < want) j++;
  const f = (want - len[j - 1]) / Math.max(1e-6, len[j] - len[j - 1]);
  return samp[j - 1].clone().lerp(samp[j], clamp(f, 0, 1));
}

// ── the keyed fetch (bow timeline editor, U) ──────────────────────────────────
// A channel is keys [t, value] (value a number or [x, y, z]); between keys a
// monotone cubic per component (Fritsch–Butland: no overshoot past a key, so a
// hand keyed beside the body never swings into it), flat at the ends.
// Positions / directions are in the right SHOULDER's frame: x right, y up the
// back, z forward (the chest's axes, from the right shoulder joint).
export const FETCH_CHANNELS = [
  { name: "hand", type: "vec", label: "right hand (after a shot)", color: 0x4fd06a },
  { name: "handLow", type: "vec", label: "right hand (from rest) — start", color: 0x2f9a4a, low: true },
  { name: "elbow", type: "dir", label: "elbow points (after a shot)", color: 0xf0b030 },
  { name: "elbowLow", type: "dir", label: "elbow points (from rest) — start", color: 0xb07e1a, low: true },
  { name: "roll", type: "num", label: "forearm roll ° (−90 relaxed, 0 palm up)", min: TWIST_R0, max: TWIST_R1 },
  { name: "fingers", type: "num", label: "fingers: 0 open · 1 pinch · 2 hook", min: 0, max: 2 },
  { name: "wristNocks", type: "num", label: "wrist: fingers down to the nocks", min: 0, max: 1 },
  { name: "wristString", type: "num", label: "wrist: hand along the arrow", min: 0, max: 1 },
  { name: "bowReady", type: "num", label: "bow raised to ready (from rest)", min: 0, max: 1 },
  { name: "turn", type: "num", label: "torso turn ° (+ toward the bow)", min: -40, max: 40 },
  { name: "lean", type: "num", label: "torso lean ° (+ forward)", min: -15, max: 40 },
  { name: "look", type: "num", label: "head turned to target (share)", min: 0, max: 1 },
  { name: "headDown", type: "num", label: "head tipped down (rad)", min: -0.2, max: 0.8 },
];
const CH_DEFAULT = { bowReady: 1, turn: 0, lean: 0, look: 0.45, headDown: 0.3, fingers: 0, wristNocks: 0, wristString: 0, roll: -90 };
const mjE = (x) => { x = clamp(x, 0, 1); return x * x * x * (10 - 15 * x + 6 * x * x); };
export function keyAt(keys, t) {
  const n = keys.length; if (!n) return null;
  if (n === 1 || t <= keys[0][0]) return keys[0][1];
  if (t >= keys[n - 1][0]) return keys[n - 1][1];
  let i = 0; while (keys[i + 1][0] < t) i++;
  const arr = Array.isArray(keys[0][1]), get = (j, c) => (arr ? keys[j][1][c] : keys[j][1]);
  const tt = (j) => keys[j][0], h = tt(i + 1) - tt(i), u = (t - tt(i)) / h;
  const d = (j, c) => (get(j + 1, c) - get(j, c)) / Math.max(1e-6, tt(j + 1) - tt(j));
  const tan = (j, c) => {
    if (j === 0 || j === n - 1) return 0;
    const d0 = d(j - 1, c), d1 = d(j, c); if (d0 * d1 <= 0) return 0;
    const h0 = tt(j) - tt(j - 1), h1 = tt(j + 1) - tt(j), w0 = 2 * h1 + h0, w1 = h1 + 2 * h0;
    return (w0 + w1) / (w0 / d0 + w1 / d1);
  };
  const u2 = u * u, u3 = u2 * u;
  const one = (c) => (2 * u3 - 3 * u2 + 1) * get(i, c) + (u3 - 2 * u2 + u) * h * tan(i, c) + (-2 * u3 + 3 * u2) * get(i + 1, c) + (u3 - u2) * h * tan(i + 1, c);
  return arr ? keys[i][1].map((_, c) => one(c)) : one(0);
}
// the fetch's channel values at t; from rest a "…Low" channel replaces its main
// one until its last key, then hands over in 0.3 s
export function fetchKeysAt(anim, t, fromHold) {
  const C = anim.channels, out = {};
  for (const ch of FETCH_CHANNELS) {
    if (ch.low) continue;
    if (!C[ch.name]?.keys.length) { out[ch.name] = CH_DEFAULT[ch.name] ?? 0; continue; }
    let v = keyAt(C[ch.name].keys, t);
    const L = !fromHold && C[ch.name + "Low"]?.keys.length ? C[ch.name + "Low"].keys : null;
    if (L) {
      const tL = L[L.length - 1][0];
      if (t <= tL) v = keyAt(L, t);
      else {
        const a = keyAt(L, tL), b = keyAt(C[ch.name].keys, tL), k = 1 - mjE((t - tL) / 0.3);
        v = Array.isArray(v) ? v.map((x, i) => x + (a[i] - b[i]) * k) : v + (a - b) * k;
      }
    }
    out[ch.name] = v;
  }
  return out;
}

// ── the archer ───────────────────────────────────────────────────────────────
export class Archer {
  constructor({ rider, scene, world, range = null }) {
    this.rd = rider; this.scene = scene; this.world = world; this.range = range;
    this.bow = makeBow(); scene.add(this.bow.group); this.bow.group.visible = false;
    this.quiver = makeQuiver(); scene.add(this.quiver.group); this.quiver.group.visible = false;
    this.nocked = makeArrow(); scene.add(this.nocked); this.nocked.visible = false;
    this.flying = []; this.stuck = [];
    this.aimW = 0; this.draw = 0; this.phase = "empty"; this.t = 0; this.ring = 0; this.ringT = 9;
    this.aimHeld = false; this.fireHeld = false;
    const b = rider.r.bone;
    this.fb = { // the finger tips for the hook point (the string lies in the last joints)
      i3: b("index_03_r"), m3: b("middle_03_r"), t4: b("thumb_04_leaf_r"), i4: b("index_04_leaf_r"),
    };
    // bind-pose locals of the finger bones: a curl is set absolutely from these
    let skin = null; rider.r.model.traverse((o) => { if (o.isSkinnedMesh && !skin) skin = o; });
    const sk = skin.skeleton, bindW = (bn) => sk.boneInverses[sk.bones.indexOf(bn)].clone().invert();
    for (const hd of rider.hands) for (const c of hd.curl) {
      const m = bindW(c.b), pm = sk.bones.includes(c.b.parent) ? bindW(c.b.parent) : new THREE.Matrix4();
      const loc = pm.clone().invert().multiply(m), q = new Q(); loc.decompose(new V3(), q, new V3()); c.bindQ = q;
    }
    // the thumb's OPPOSITION: the swing across in front of the palm (round the
    // index's metacarpal line) — curling alone left it 5–14 cm from the index tip
    for (const [hd, s] of [[rider.hands[0], "l"], [rider.hands[1], "r"]]) {
      const p = (n) => new V3().setFromMatrixPosition(bindW(b(n)));
      const axW = p(`index_01_${s}`).sub(p(`hand_${s}`)).normalize();
      const t1 = b(`thumb_01_${s}`), qT = new Q(); bindW(t1).decompose(new V3(), qT, new V3());
      hd.oppAxis = axW.applyQuaternion(qT.invert()).normalize();   // in thumb_01's own (bind) frame
      hd.thumb1 = hd.curl.findIndex((c) => c.b === t1);
    }
    // the collarbones' bind (local) rotations: at full draw an archer's shoulders sit DOWN
    // and level — the mocap base eases them back toward these as the bow comes up
    this.clavBind = [0, 1].map((i) => { const c = rider.B.arms[i].u.parent; const q = new Q(); bindW(c.parent).invert().multiply(bindW(c)).decompose(new V3(), q, new V3()); return { bone: c, q }; });
    this.debug = createBowDebug(scene);
  }
  get aiming() { return this.aimW > 0.02 || this.aimHeld; }
  // the keyed fetch (anims/bow-fetch.json) plays instead of the coded one
  useKeys() { return !!this.anim && BP.keyed && !this.useCode; }
  useBase() { return !!this.base && !!this.bowInHand && BP.mocap && !this.useCode && !!this.anim; }
  fetchLen() { return this.useKeys() || this.useBase() ? this.anim.phases.nock[1] : BP.fetchTime; }
  fetchPhases() { return this.useKeys() || this.useBase() ? this.anim.phases : { reach: [0, 1.1], close: [1.1, 1.3], pull: [1.3, 1.85], bring: [1.85, 2.7], nock: [2.7, 3.15] }; }
  // HOW THE CLIP HOLDS THE BOW, learnt once from it: at its nock (1.6 s) the string
  // fingers are ON its string, so the arrow runs from them through the bow hand; the
  // limbs lie across the knuckles. Kept as the bow's turn in the left hand (a bow does not
  // turn in the fist). (Taken as "the arrow along the knuckles", the clip's fist pointed
  // our arrow at the ground and put the string 21 cm out of the draw arm's reach.)
  calibrateBase() {
    if (!this.base) return;
    const rd = this.rd, saved = [];
    rd.r.model.traverse((o) => { if (o.isBone) saved.push([o, o.quaternion.clone(), o.position.clone()]); });
    this.base.apply(1.6, 1);
    const hdL = rd.hands[0];
    const z = this.gripPoint(hdL).sub(this.pinchPoint()).normalize();
    const k = wpos(hdL.index).sub(wpos(hdL.pinky)); if (k.y < 0) k.negate();
    const y = k.addScaledVector(z, -k.dot(z)).normalize(), x = new V3().crossVectors(y, z);
    this.bowInHand = hdL.hand.getWorldQuaternion(new Q()).invert().multiply(new Q().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)));
    // where the robot's (retargeted) fingers are at the grab, in the right shoulder's frame —
    // the grab correction onto this quiver starts from there
    const tG = this.anim?.phases?.close?.[0] ?? 0.83;
    this.base.apply(tG, 1);
    const ch = this.chest(), SR = wpos(rd.B.arms[1].u), Rt = ch.L.clone().negate(), d = this.pinchPoint().sub(SR);
    this.baseGrab = [d.dot(Rt), d.dot(ch.u), d.dot(ch.f)];
    for (const [b, q, p] of saved) { b.quaternion.copy(q); b.position.copy(p); }
    rd.r.model.updateMatrixWorld(true);
  }
  // a point kept off the HEAD (the helmet's shell when it is worn, the head inside it
  // otherwise) by `m` m: pushed straight out from the head's axis. Its frame and size
  // are the helmet's (built for every rider, hidden or not).
  keepOffHead(p, m) {
    const hl = this.rd.helmet, sh = hl?.userData.shell; if (!sh) return p;
    const pad = hl.visible ? 0 : sh.pad;
    hl.updateMatrixWorld(true);
    const l = hl.worldToLocal(p.clone());
    // its shape: a SMOOTH rounded box round the shell (a squared-off ellipsoid, power 4: the
    // barrel's straight sides and its crown edge) — pushed straight out from its middle, so
    // the push turns smoothly from sideways to over the top (choosing one or the other, the
    // hand jumped 25 cm in a frame)
    const cy = sh.H * 0.45, a = sh.rx - pad + m, c = sh.rz - pad + m, b = sh.H - pad + m - cy;
    const dy = l.y - cy, f = (Math.hypot(l.x / a, l.z / c)) ** 4 + (dy / b) ** 4;
    if (f >= 1 || f < 1e-8) return p;
    const k = f ** -0.25;
    l.x *= k; l.z *= k; l.y = cy + dy * k;
    return hl.localToWorld(l);
  }
  // the clip's time for this moment of the shot (Mixamo "Shooting Arrow": fetch 0–1.95,
  // draw 1.95–2.8, hold, release 3.85, arms down by 4.8)
  baseTime() {
    const ph = this.anim?.phases?.nock?.[1] ?? 1.95;
    if (this.phase === "fetch") return this.t;
    if (this.phase === "nocked") return ph + 0.85 * this.draw + (this.holdT ?? 0);   // (held at full draw: the clip's own hold plays, to 3.85)
    if (this.phase === "release") return Math.min(3.85 + this.t, this.base.duration);
    return 0;
  }
  // the timeline editor: a fetch from its start, the aim held fixed
  // (edit = { aim: { P, d }, fromHold }; the editor then steps update() itself)
  // (from rest it starts as the game does: the bow down, aim pressed — the fetch
  // begins as the bow comes up, aimW 0.55, the body still turning)
  editReset(fromHold) {
    Object.assign(this, { phase: fromHold ? "fetch" : "empty", t: 0, fetchStart: null, fetchFree: 0, arrowTaken: false, elbowDir: null, twistPrev: undefined, fetchFromHold: fromHold, ext: fromHold ? 1 : 0, aimW: fromHold ? 1 : 0, draw: 0 });
  }
  get active() { return BP.on && this.rd.mode === "ground"; }

  // the chest's frame from the bones: S (spine_03), u up the back, L to the left, f forward
  chest() {
    const B = this.rd.B, u = wpos(B.neck).sub(wpos(B.spine2)).normalize();
    const L = wpos(B.arms[0].u).sub(wpos(B.arms[1].u)); L.addScaledVector(u, -L.dot(u)).normalize();
    return { S: wpos(B.spine3), u, L, f: new V3().crossVectors(L, u) };
  }
  // fingers: per joint curl [index, middle, ring, pinky, thumb] × 3, blended in by w
  // ang[5] (optional): [thumb opposition, rad] — swings the thumb across the palm
  curl(hd, ang, w = 1) {
    const q = new Q(), qo = new Q();
    hd.curl.forEach((c, i) => {
      const f = Math.floor(i / 3), j = i % 3, a = ang[f][j];
      const tq = c.bindQ.clone();
      if (i === hd.thumb1 && ang[5]) tq.multiply(qo.setFromAxisAngle(hd.oppAxis, ang[5][0] * -hd.side));   // (mirrored on the left hand)
      tq.multiply(q.setFromAxisAngle(c.axis, a));
      c.b.quaternion.slerp(tq, w);
    });
    hd.hand.updateMatrixWorld(true);
  }
  gripPoint(hd) { return wpos(hd.middle).lerp(wpos(hd.tipM), 0.5); }
  hookPoint() { return wpos(this.fb.i3).lerp(wpos(this.fb.m3), 0.5); }
  // between the thumb tip and the index's last joint: where a pinched arrow is held
  pinchPoint() { return wpos(this.fb.t4).lerp(wpos(this.fb.i3).lerp(wpos(this.fb.i4), 0.45), 0.5); }
  // the forearm's roll: the palm against the elbow's bend plane, degrees
  // (right arm: −90 = relaxed, thumb forward; 0 = palm up (supinated); −180 = palm down)
  forearmTwist(arm, hd) {
    const S = wpos(arm.u), E = wpos(arm.l), Wr = wpos(arm.tip), F = Wr.clone().sub(E).normalize();
    const ref = S.clone().sub(E); ref.addScaledVector(F, -ref.dot(F)).normalize();
    const N = new V3().crossVectors(wpos(hd.index).sub(Wr), wpos(hd.pinky).sub(Wr)).normalize().multiplyScalar(hd.palmSign);
    N.addScaledVector(F, -N.dot(F)).normalize();
    return { tw: Math.atan2(new V3().crossVectors(ref, N).dot(F), ref.dot(N)) * 180 / Math.PI, F };
  }
  // Two-bone IK so that a point carried by the hand (pt()) lands on T, for a
  // natural arm: the wrist bends at most maxWrist rad off the forearm (the hand's
  // direction is asked RELATIVE to the arm — world directions bent it 159°), the
  // forearm's roll stays in `twist` (degrees, forearmTwist), the target never
  // past maxReach, and the right elbow is continuous frame to frame.
  reachNatural(arm, hd, T, pole, Dw, N, fingers, pt, w, maxReach, maxWrist, twist = null, softK = 0.9) {
    if (w <= 0.001) return;
    try { return this._reachNatural(arm, hd, T, pole, Dw, N, fingers, pt, w, maxReach, maxWrist, twist, softK); }
    finally { if (twist && this.twistPrevNext !== undefined) this.twistPrev = this.twistPrevNext; }
  }
  _reachNatural(arm, hd, T, pole, Dw, N, fingers, pt, w, maxReach, maxWrist, twist, softK) {
    const S = wpos(arm.u), start = pt(), want = start.clone().lerp(T, w);
    // (a SOFT reach limit: from 90 % of it the target eases in to the limit — a hard clamp
    // at a near-straight arm (Mixamo's reach over the shoulder) missed by 3.5 cm and snapped)
    { const d = want.clone().sub(S), n = d.length(), k0 = maxReach * softK;
      if (n > k0) want.copy(S).addScaledVector(d.normalize(), k0 + (maxReach - k0) * Math.tanh((n - k0) / (maxReach - k0))); }
    let tgt = wpos(arm.tip).add(want.clone().sub(start));
    // the ELBOW is continuous: it starts where it was last frame and turns toward
    // the asked side at a limited rate, round the shoulder→wrist line. (A fixed
    // pole that lines up with that line leaves the solver no side: it missed by
    // 32 cm and flipped the elbow up to 52° in a frame.)
    if (arm === this.rd.B.arms[1]) {
      const S0 = wpos(arm.u), ax = tgt.clone().sub(S0).normalize(), perp = (v) => v.clone().addScaledVector(ax, -v.dot(ax));
      const pref = perp(pole), strength = clamp((pref.length() - 0.2) / 0.4, 0, 1);
      let cur = this.elbowDir ? perp(this.elbowDir) : perp(wpos(arm.l).sub(S0));
      if (cur.lengthSq() < 1e-6) cur = pref.clone();
      cur.normalize();
      if (strength > 0) {
        const pn = pref.normalize(), ang = cur.angleTo(pn), stp = Math.min(ang, 3.2 * strength * (this._dt ?? 1 / 60));
        if (ang > 1e-4) cur.applyAxisAngle(new V3().crossVectors(cur, pn).normalize(), stp);
      }
      this.elbowDir = cur.clone(); pole = cur;
      // (part weight — easing on / off the IK: the elbow is the clip's as much as the hand
      // is; the IK's full side at a weight near 0 put the elbow 14 cm off the clip's and
      // it snapped back as the IK let go)
      if (w < 0.999) { const ce = perp(wpos(arm.l).sub(S0)); if (ce.lengthSq() > 1e-6) pole = ce.normalize().lerp(cur, smooth(w)).normalize(); }
    }
    this.twistPrevNext = undefined;
    for (let it = 0; it < 8; it++) {                                // (the carried point is ~10 cm off the wrist and turns with it: 3 passes left 15 cm)
      solveTwoBone(arm.u, arm.l, wpos(arm.tip), tgt, pole, new V3(), true);
      // Dw: null = the wrist straight; { toward, k } = bent toward a direction by k
      const F = wpos(arm.tip).sub(wpos(arm.l)).normalize();
      let D = F.clone();
      if (Dw) { const want = F.clone().lerp(Dw.toward, Dw.k).normalize(), a = F.angleTo(want); D = a <= maxWrist ? want : F.clone().applyAxisAngle(new V3().crossVectors(F, want).normalize(), maxWrist); }
      // N: a palm direction, or a NUMBER = the forearm's roll in degrees (the palm
      // from the elbow's bend plane, round the forearm) — how a body sets its hand
      if (N?.isQuaternion) {
        // (mocap: the hand keeps the clip's own orientation in the world — re-derived from a
        // roll number after the arm's correction, it drifted 15–30° and flipped at 1.05 s)
        const pq = hd.hand.parent.getWorldQuaternion(new Q()).invert();
        hd.hand.quaternion.slerp(pq.multiply(N), w); hd.hand.updateMatrixWorld(true);
        if (fingers) this.curl(hd, fingers, w);
        const err0 = want.clone().sub(pt());
        if (err0.lengthSq() < 1e-6) break;
        tgt.add(err0);
        continue;
      }
      let Nw = N;
      if (typeof N === "number") {
        const ref = wpos(arm.u).sub(wpos(arm.l)); ref.addScaledVector(F, -ref.dot(F)).normalize();
        Nw = ref.applyAxisAngle(F, N * Math.PI / 180);
      }
      this.rd.orientHandTo(hd, D, Nw, w);
      // a forearm only rolls ~85° each way from relaxed: past that the hand is turned back
      // the forearm's ROLL, as a body controls it: the asked palm gives a roll,
      // which is clamped into the forearm's range (taken round from the middle of
      // the range, so an out-of-reach palm goes to the nearer end) and may change
      // at most ~800°/s — a clamp alone flipped 150° in a frame between its ends
      if (twist) {
        const { tw: raw, F: F2 } = this.forearmTwist(arm, hd), mid = (twist[0] + twist[1]) / 2;
        const want = clamp(raw + 360 * Math.round((mid - raw) / 360), twist[0], twist[1]);
        const prev = this.twistPrev ?? want, rate = 800 * (this._dt ?? 1 / 60);   // (°/s: a fast fetch rolls the forearm ~1000°/s — Mixamo; 300 lagged and then jerked)
        const c = prev + clamp(want - prev, -rate, rate);
        const now = raw + 360 * Math.round((c - raw) / 360);
        if (Math.abs(c - now) > 0.01) rotateWorld(hd.hand, new Q().setFromAxisAngle(F2, (c - now) * Math.PI / 180));
        this.twistPrevNext = c;
      }
      if (fingers) this.curl(hd, fingers, w);
      const err = want.clone().sub(pt());
      if (err.lengthSq() < 1e-6) break;
      tgt.add(err);
      if (arm === this.rd.B.arms[1]) { const S1 = wpos(arm.u), d1 = tgt.clone().sub(S1), m = this.armMax(arm); if (d1.length() > m) tgt.copy(S1).addScaledVector(d1.normalize(), m); }
      else {
        // the bow arm: its wrist eases into full reach over the last 1.5 % (near straight, 2 cm
        // of reach swing the elbow ~28°: crossing the arm's length in a frame snapped it straight)
        const S1 = wpos(arm.u), d1 = tgt.clone().sub(S1), n1 = d1.length(), m = (S1.distanceTo(wpos(arm.l)) + wpos(arm.l).distanceTo(wpos(arm.tip))) * 1.004, k1 = m * (0.975 + 0.029 * (1 - (this._softL ?? 1)));   // (mocap: off while the clip's own arm hangs — on at once, it bent the near-straight arm 7 cm)   // (ends just past full length: still near straight at full draw)
        if (n1 > k1) tgt.copy(S1).addScaledVector(d1.normalize(), k1 + (m - k1) * Math.tanh((n1 - k1) / (m - k1)));
      }
    }
  }
  // the wrist's furthest from the shoulder: 93 % of the arm (the elbow keeps ~35° of bend)
  armMax(arm) { return (arm.l.position.length() * arm.u.getWorldScale(new V3()).x + arm.tip.position.length() * arm.l.getWorldScale(new V3()).x) * 0.93; }

  // the aim point under the crosshair (camera centre ray), and the launch
  // direction from the anchor that drops onto it at full draw
  aimFrom(camera, C) {
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(0, 0), camera); ray.far = 220;
    const objs = [...(this.world.ground ?? []), ...(this.world.blockers ?? []), ...(this.range ? [this.range.root] : [])];
    const hit = ray.intersectObjects(objs, true).find((h) => h.distance > 1.5);
    const P = hit ? hit.point : ray.ray.origin.clone().addScaledVector(ray.ray.direction, 150);
    const dx = P.x - C.x, dz = P.z - C.z, x = Math.hypot(dx, dz), y = P.y - C.y;
    // (the solve is ~10k flight steps: kept while the target moves < 1 cm)
    const c = this.aimCache;
    const th = x <= 0.5 ? Math.atan2(y, x) : c && Math.abs(c.x - x) < 0.01 && Math.abs(c.y - y) < 0.01 && c.v === BP.maxSpeed ? c.th : (this.aimCache = { x, y, v: BP.maxSpeed, th: launchAngle(x, y, BP.maxSpeed) }).th;
    return { P, d: new V3(dx / (x || 1) * Math.cos(th), Math.sin(th), dz / (x || 1) * Math.cos(th)).normalize() };
  }

  update(dt, { camera, aim = false, fire = false } = {}) {
    this._dt = dt;
    const rd = this.rd, on = this.active;
    if (this.edit) { aim = true; fire = false; }
    this.bow.group.visible = this.quiver.group.visible = on;
    this.updateArrows(dt);
    this.range?.update(dt);
    if (!on) { this.nocked.visible = false; this.phase = "empty"; this.aimW = 0; this.draw = 0; this.debug.update(dt, null); return; }
    const B = rd.B, ms = rd.mountSys, rig = rd.r.rig;
    this.aimHeld = aim;
    this.aimW = clamp(this.aimW + (aim ? 1 : -1) * dt / BP.aimTime, 0, 1);
    const aw = smooth(this.aimW);
    const base = this.useBase();
    const KF = this.phase === "fetch" && this.useKeys() && !base ? fetchKeysAt(this.anim, this.t, this.fetchFromHold) : null;
    if (base) {
      // THE MOCAP BASE: the whole body as captured (collarbones, spine, hips, legs, head,
      // hands); everything below only corrects it — onto this quiver, this string, the aim
      for (const c of this.clavBind) (c.clip ??= new Q()).copy(c.bone.quaternion);   // (the idle's relaxed shoulders, before the clip's)
      this.holdT = this.phase === "nocked" && this.draw >= 1 ? Math.min(1.0, (this.holdT ?? 0) + dt) : this.phase === "nocked" ? 0 : this.holdT;
      // (each phase change crossfades over 0.15 s from where the clip WAS — the hold into
      // the release, the arms-down end into the next fetch's start: 6–8 cm steps)
      const mt = this.baseTime();
      if (this.phase !== this.basePhase) { this.baseFrom = this.baseMt ?? mt; this.baseBlend = 0; this.basePhase = this.phase; }
      this.baseBlend = (this.baseBlend ?? 1) + dt;
      if (this.baseBlend < 0.15) { this.base.apply(this.baseFrom, aw); this.base.apply(mt, aw * smooth(this.baseBlend / 0.15)); }
      else this.base.apply(mt, aw);
      this.baseMt = mt;
      // (Mixamo shrugs the draw shoulder up at full draw — 7 cm above the bow shoulder, the
      // draw elbow 18 cm over the arrow line; archers keep the shoulders down and level)
      const down = smooth(this.ext ?? 0) * 0.85 * aw;
      if (down > 0) for (const c of this.clavBind) c.bone.quaternion.slerp(c.clip, down);   // (toward the idle's shoulders: the bind's sat higher, the draw elbow 10 cm over the arrow)
      // what the clip's own arms do this frame (the corrections start from them)
      const aR = B.arms[1], aL = B.arms[0];
      this.baseArm = {
        pinch: this.pinchPoint(), hook: this.hookPoint(), elbowR: wpos(aR.l).sub(wpos(aR.u)).normalize(), rollR: this.forearmTwist(aR, rd.hands[1]).tw,
        handDirR: wpos(rd.hands[1].middle).sub(wpos(aR.tip)).normalize(), elbowL: wpos(aL.l).sub(wpos(aL.u)).normalize(),
        handQR: rd.hands[1].hand.getWorldQuaternion(new Q()),
      };
    }

    // ── where to shoot: the camera's crosshair ─────────────────────────────
    // solved from where the arrow will leave: its nock in the fingers (last frame), else the head
    const from = this.lastHook && this.aimW > 0.5 ? this.lastHook : wpos(B.head);
    const { P, d: dAim } = this.edit?.aim ?? this.aimFrom(camera, from);
    this.aimPoint = P;
    const aimYaw = Math.atan2(dAim.x, dAim.z), aimPitch = Math.asin(clamp(dAim.y, -1, 1));
    // ── stance: side-on to the target (the feet turn; next frame's walk/idle
    // follows, the rig is turned now)
    if (aw > 0) {
      const want = base ? aimYaw - this.base.arrowYaw : aimYaw - Math.PI / 2 + BP.hipOpen;   // (mocap: turned so ITS arrow line points at the target)
      const dy = Math.atan2(Math.sin(want - ms.gyaw), Math.cos(want - ms.gyaw));
      ms.gyaw += dy * lerpK(9 * aw, dt);
      rig.quaternion.setFromAxisAngle(UP, ms.gyaw); rig.updateMatrixWorld(true);
    }
    const dh = new V3(dAim.x, 0, dAim.z).normalize(), h = new V3().crossVectors(dAim, UP).normalize();   // h: the aim's right
    // ── spine: twist the chest side-on (+ chestOpen), bend at the waist with the pitch
    if (aw > 0) {
      const ch = this.chest();
      const want = new V3().copy(dh).applyAxisAngle(UP, -(Math.PI / 2 - BP.chestOpen));
      // (mocap: the clip's own turn while fetching; the archer's chest-open as the bow comes up —
      // the clip's chest stayed fully side-on, the neck turned 94°)
      const tw = Math.atan2(new V3().crossVectors(ch.f.clone().setY(0).normalize(), want).y, ch.f.clone().setY(0).normalize().dot(want)) * aw * (base ? smooth(this.ext ?? 0) : 1);
      const q = new Q();
      [[B.spine1, 0.3], [B.spine2, 0.35], [B.spine3, 0.35]].forEach(([bn, k]) => rotateWorld(bn, q.setFromAxisAngle(UP, tw * k)));
      const bend = aimPitch * BP.bend * aw;
      [[B.spine1, 0.35], [B.spine2, 0.35], [B.spine3, 0.3]].forEach(([bn, k]) => rotateWorld(bn, q.setFromAxisAngle(h, bend * k)));
      if (base && (this.ext ?? 0) > 0) {
        // (mocap, as the bow comes up: the shoulders LEVEL — the clip's tilted 7 cm, its draw
        // elbow rode 10 cm over the arrow line)
        const cl = this.chest(), tilt = Math.asin(clamp(cl.L.y, -1, 1)) + bend * 0;
        [[B.spine2, 0.5], [B.spine3, 0.5]].forEach(([bn, k]) => rotateWorld(bn, q.setFromAxisAngle(cl.f, -tilt * k * smooth(this.ext))));
      }
      // the keyed torso (Mixamo: it turns ~28° toward the bow and leans ~28° forward over it to nock)
      // (on the string the fetch's last turn / lean straightens out over 0.55 s — Mixamo's
      // lean goes 25° → 7° as it raises the bow; dropped at once, the head jumped 19 cm)
      if (KF) this.keyEnd = { turn: KF.turn, lean: KF.lean };
      const out = KF ? 1 : this.phase === "nocked" && this.keyEnd ? 1 - mjE(this.t / 0.55) : 0;
      const TL = KF ?? (out > 0 ? this.keyEnd : null);
      if (TL && (TL.turn || TL.lean)) {
        const L0 = this.chest().L;
        [[B.spine1, 0.3], [B.spine2, 0.35], [B.spine3, 0.35]].forEach(([bn, k]) => rotateWorld(bn, q.setFromAxisAngle(UP, TL.turn * out * Math.PI / 180 * aw * k)));
        [[B.spine1, 0.4], [B.spine2, 0.35], [B.spine3, 0.25]].forEach(([bn, k]) => rotateWorld(bn, q.setFromAxisAngle(L0, TL.lean * out * Math.PI / 180 * aw * k)));
      }
      // head: turned back along the arrow, level
      const ch2 = this.chest(), f2 = ch2.f.clone().setY(0).normalize();
      // (fetching / nocking the head looks at the hands — forward and down, turned only
      // part way; it turns to the target as the bow comes up. Turned to the target the
      // whole time, the neck read as wrenched round)
      const up2 = smooth(this.ext ?? 0), KV = KF;
      const lookK = KV ? KV.look : BP.lookReady + (1 - BP.lookReady) * up2, downK = KV ? KV.headDown : BP.lookDown * (1 - up2);
      this._look = lookK; this._down = downK;
      // (measured from where the HEAD faces — not the chest: the clip's head is already
      // turned a little, and adding the full chest-to-target turn on top put it 17° past the arrow)
      const hf = new V3(0, 0, 1).applyQuaternion(B.head.getWorldQuaternion(new Q())).setY(0).normalize();
      const look = Math.atan2(new V3().crossVectors(hf, dh).y, hf.dot(dh)) * aw * (base ? smooth(this.ext ?? 0) : lookK);   // (mocap: the clip's head while fetching; on the arrow as the bow comes up)
      rotateWorld(B.neck, q.setFromAxisAngle(UP, look * 0.45));
      rotateWorld(B.head, q.setFromAxisAngle(UP, look * 0.55));
      if (!base) rotateWorld(B.head, q.setFromAxisAngle(ch2.L.clone().negate(), -downK * aw));   // eyes down onto the hands
      rotateWorld(B.head, q.setFromAxisAngle(dAim, -bend * 0.8));   // eyes level again after the side bend
      rotateWorld(B.head, q.setFromAxisAngle(h, aimPitch * (1 - BP.bend) * 0.5 * aw - 0.08 * aw));   // and a touch down onto the arrow
    }
    // ── the anchor and the arrow line
    const hb = wpos(B.head), [af, ar0, au] = BP.anchor;
    // (a helmet on: the string hand anchors against its cheek, not inside it)
    const helm = rd.helmet?.visible ? rd.helmet.userData.side : 0, ar = Math.max(ar0, helm + 0.012);
    const C = hb.clone().addScaledVector(dh, af).addScaledVector(h, ar).addScaledVector(UP, au);
    const ch = this.chest();
    // ── the shot's phases (empty → fetch → nocked / drawing → release) ─────
    this.t += dt;
    const fire0 = this.fireHeld; this.fireHeld = fire;
    if (this.edit) this.t = Math.min(this.t, this.fetchLen());   // (the editor: the fetch only)
    if (this.phase === "empty" && this.aimW > 0.55 && !this.edit?.fromHold) { this.phase = "fetch"; this.t = 0; this.fetchStart = null; this.fetchFree = 0; this.arrowTaken = false; this.elbowDir = null; this.twistPrev = undefined; this.fetchFromHold = false; }
    if ((this.phase === "fetch" || this.phase === "nocked") && this.aimW < 0.3) { this.phase = "empty"; this.draw = 0; }   // lowered: the arrow back in the quiver
    if (this.phase === "fetch" && this.t >= this.fetchLen() && !this.edit) { this.phase = "nocked"; this.t = 0; }
    if (this.phase === "nocked") {
      if (fire && this.aimW > 0.9) this.draw = Math.min(1, this.draw + dt / BP.drawTime);
      else if (!fire && fire0 && this.draw > 0.22) this.shoot();
      else if (!fire) this.draw = Math.max(0, this.draw - dt / 0.35);   // let down gently
    }
    // FOLLOW-THROUGH: the bow arm stays up and the string hand stays back by the neck
    // for ~0.9 s after the shot (coaching: "hold the follow-through"); the next arrow
    // is then fetched straight from there (it dropped to the hip at 0.45 s, then climbed)
    const fromHold = BP.repeatFromHold && !base;
    if (this.phase === "release" && this.t > (base ? 4.8 - 3.85 : BP.followThrough + (fromHold ? 0 : BP.lowerTime))) {
      if (this.aimW > 0.55) { this.phase = "fetch"; this.t = 0; this.fetchStart = null; this.fetchFree = 0; this.arrowTaken = false; this.fetchFromHold = fromHold; if (!fromHold) { this.elbowDir = null; this.twistPrev = undefined; } }   // (the elbow and the forearm's roll carry on from the release)   // (straight on: no frame with the hand let go)
      else { this.phase = "empty"; this.t = 0; }
    }
    // ── bow arm ───────────────────────────────────────────────────────────
    // NOCKING happens with the bow LOW (the "ready" position: bow arm bent, the
    // arrow pointing at the ground ahead) — at full arm's length the string sits
    // ~0.9 m from the right shoulder, out of the draw arm's reach (measured: the
    // arm locked straight, the wrist bent 77°). Drawing RAISES the bow onto the
    // aim line as the string comes back (push–pull), at full extension by half draw.
    // (after the shot, from rest: up for the follow-through, then the arms lower)
    const lowerK = this.phase === "release" && !BP.repeatFromHold ? smooth((this.t - BP.followThrough) / BP.lowerTime) : this.phase === "release" && base ? smooth((this.t - 0.1) / 0.8) : 0;
    const extWant = this.phase === "release" ? 1 : this.phase === "nocked" ? smooth(this.draw / 0.5) : 0;
    this.ext = (this.ext ?? 0) + (extWant - (this.ext ?? 0)) * lerpK(extWant > (this.ext ?? 0) ? 14 : 4, dt);
    if (lowerK > 0) this.ext = Math.min(this.ext, 1 - lowerK);   // (lowering: on the arms' eased curve — dropped at its fastest first, the near-straight bow elbow snapped 7 cm)
    const ex = this.ext;
    // (mocap: the arms' aim correction follows the CLIP's own raise — it lifts the bow over
    // the whole draw; by half-draw ours had bent the bow elbow 59° where the clip's is 13°)
    const exA = base && this.phase === "nocked" ? Math.min(ex, smooth(this.draw)) : ex;
    const arm = B.arms[0], hdL = rd.hands[0];
    const armLen = wpos(arm.u).distanceTo(wpos(arm.l)) + wpos(arm.l).distanceTo(wpos(arm.tip));
    // aim: the rest on the arrow line where the arm reaches
    // (the hand's own length counted: wrist → grip → arrow rest, ~17 cm — with a flat
    // 7 cm the wrist reached 87 % of the arm and the bow elbow bent to 120°; elite
    // archers hold it near straight)
    const handLen = this.bowHandLen ?? 0.17;
    const SL = wpos(arm.u), w0 = C.clone().sub(SL), bq = dAim.dot(w0), r = armLen * BP.bowReach + handLen;
    const disc = bq * bq - (w0.lengthSq() - r * r), tR = disc > 0 ? -bq + Math.sqrt(disc) : Math.max(0.3, -bq);
    const Raim = C.clone().addScaledVector(dAim, tR);
    this.drawFull = tR;
    // the READY position: the bow low but in FRONT of the body's middle (held far left
    // and low, the string hand had to cross the belly with its forearm flat)
    // (the keys read again: the phase may have just changed — read before it, the bow
    // flashed up to "ready" for one frame as each fetch from rest began)
    const KFb = this.phase === "fetch" && this.useKeys() ? fetchKeysAt(this.anim, this.t, this.fetchFromHold) : null;
    const bowW = (KFb && !this.fetchFromHold ? clamp(KFb.bowReady, 0, 1) : this.phase === "empty" && this.useKeys() ? 0 : 1) * (1 - lowerK), awB = aw * bowW;   // (keyed: the bow stays down while the aim comes in — the fetch's keys raise it)   // (the bow arm's share of the aim)
    const Rready = SL.clone().addScaledVector(ch.u, -BP.readyDown).addScaledVector(ch.f, BP.readyFwd).addScaledVector(ch.L, -BP.readyIn).addScaledVector(dAim, 0.06);
    const R = Rready.lerp(Raim, ex);
    const dReady = dAim.clone().multiplyScalar(0.75).addScaledVector(UP, -0.6).addScaledVector(h, 0.15).normalize();
    const dArrow = dReady.lerp(dAim, ex).normalize();               // the arrow's line now
    // the bow's frame from the fist: palm toward the string side, knuckles along the arm
    const DA = dArrow.clone().addScaledVector(h, 0.12).normalize(), NA = h.clone().applyAxisAngle(dArrow, BP.cant + BP.readyRoll * (1 - ex));   // (ready: the bow rolled round the arrow)
    // relaxed: the bow low in the left hand, top forward-up
    const DR = ch.f.clone().multiplyScalar(0.75).addScaledVector(ch.u, -0.45).normalize(), NR2 = ch.L.clone().negate();   // the wrist cocked up: the bow leans forward ~60°, not flat
    const Dl = DR.clone().lerp(DA, awB).normalize(), Nl = NR2.clone().lerp(NA, awB).normalize();
    // (mocap: the bow sits in the fist as the clip holds it, its z IS the arrow — so the aim's
    // frame is the arrow line itself; the knuckles' 7° (DA) turned the arrow 5° off the aim and
    // brought the string hand 7.5 cm into the head at full draw)
    const Dl2 = base ? DR.clone().lerp(dArrow, awB).normalize() : Dl;
    const yB = new V3().crossVectors(Nl, Dl2).normalize(), zB = Dl2.clone().addScaledVector(yB, -Dl2.dot(yB)).normalize(), xB = new V3().crossVectors(yB, zB);
    const REST = new V3(0.021, 0.064, 0.002);                       // the arrow on the shelf (bow space)
    const restOff = xB.clone().multiplyScalar(REST.x).addScaledVector(yB, REST.y).addScaledVector(zB, REST.z);
    const Tgrip = R.clone().sub(restOff);
    const Trel = SL.clone().addScaledVector(ch.u, -0.5).addScaledVector(ch.f, 0.13).addScaledVector(ch.L, 0.06);
    const Tl = Trel.clone().lerp(Tgrip, awB);
    const poleL = ch.L.clone().multiplyScalar(0.3).addScaledVector(ch.u, -0.4).addScaledVector(ch.f, -0.6).normalize().lerp(h.clone().negate().multiplyScalar(0.8).addScaledVector(UP, -0.45).normalize(), awB).normalize();
    // follow-through: the bow hand gives forward and the bow tips forward after the shot
    const ft = this.phase === "release" ? Math.sin(Math.min(1, this.t / 0.45) * Math.PI) * (1 - this.t / 0.6) : 0;
    if (ft > 0) Tl.addScaledVector(dAim, 0.03 * ft).addScaledVector(UP, -0.05 * ft);
    const FIST = [[1.0, 1.25, 0.9], [1.05, 1.3, 0.9], [1.05, 1.3, 0.9], [1.1, 1.3, 0.9], [0.45, 0.5, 0.35], [-0.5]];
    // the wrist within 30° of the forearm; the BOW follows the fist as it ends up
    // (forcing the bow's direction on the hand bent the wrist 67° at "ready")
    if (base) {
      // the clip's bow arm; onto the aim line as the bow comes up (push–pull) — the elbow
      // from the clip's at a part weight (the aim's own side only as it takes over)
      // (the clip's own fist round its bow — ours forced on it no longer matched the clip)
      // (the fist turned so the bow, held as the clip holds it, lies on the aim)
      const qAim = new Q().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xB, yB, zB)).multiply(this.bowInHand.clone().invert());
      // NOCKING: the bow brought in so its string is where the clip's string fingers are.
      // (The robot's chest is far broader than the clip's: rotations carried over, its bow
      // hand ended 13 cm further out and the string past the draw arm's reach — locked straight.)
      const qH = hdL.hand.getWorldQuaternion(new Q()), qb0 = qH.clone().multiply(this.bowInHand);
      const grip0 = this.gripPoint(hdL), z0 = new V3(0, 0, 1).applyQuaternion(qb0);
      const nock0 = grip0.clone().add(new V3(0.021, 0.064, 0.002).applyQuaternion(qb0)).addScaledVector(z0, -(-this.bow.braceZ + 0.002));
      const STp = this.fetchPhases(), mjL = (x) => { x = clamp(x, 0, 1); return x * x * x * (10 - 15 * x + 6 * x * x); };
      const wN = this.phase === "fetch" ? mjL((this.t - STp.bring[0]) / (STp.nock[0] - STp.bring[0])) : this.phase === "nocked" ? 1 : 0;
      // (the clip's fingers sit BEHIND the string — it starts drawing as it nocks: the string
      // follows them back. Only the SIDEWAYS gap (a string can't bend sideways) — and any gap
      // in front of it — is closed, half by each hand: pushing the whole gap onto the bow
      // bent the bow elbow 80–106° where the clip's is straight)
      const gap = this.baseArm.pinch.clone().sub(nock0), along = gap.dot(z0);
      const corr = gap.clone().addScaledVector(z0, -along).addScaledVector(z0, Math.max(0, along)).multiplyScalar(0.5);
      this.nockCorr = corr.clone().multiplyScalar(wN);
      if (wN > 0.001 || exA > 0.001) {
        // (round the shoulder, not straight across: both ends are near arm's length — the chord
        // between them passed inside the reach and bent the elbow 75° where the clip's is 28°)
        const SLb = wpos(arm.u), a0 = grip0.clone().addScaledVector(corr, wN).sub(SLb), a1 = Tgrip.clone().addScaledVector(dAim, 0.03 * ft).addScaledVector(UP, -0.05 * ft).sub(SLb);
        const la = a0.length(), lb = a1.length(), qd = new Q().setFromUnitVectors(a0.clone().normalize(), a1.clone().normalize());
        const T = SLb.clone().add(a0.clone().normalize().applyQuaternion(new Q().slerp(qd, exA)).multiplyScalar(la + (lb - la) * exA));
        this._softL = exA;
        // (the clip's elbow side — but its hanging arm is near straight, where that side is
        // undefined: the solver flipped it 7 cm a frame. Below ~8 cm of bend, a steady side)
        const S0 = wpos(arm.u), axL = wpos(arm.tip).sub(S0).normalize(), eP = wpos(arm.l).sub(S0); eP.addScaledVector(axL, -eP.dot(axL));
        const sK = clamp(eP.length() / 0.08, 0, 1), poleB = eP.normalize().multiplyScalar(sK).addScaledVector(poleL, 1 - sK).normalize();
        this.reachNatural(arm, hdL, T, poleB.lerp(poleL, exA).normalize(), null, qH.slerp(qAim, exA), null, () => this.gripPoint(hdL), 1, 9, 0.52);
        this._softL = 1;
      }
    } else this.reachNatural(arm, hdL, Tl, poleL, { toward: Dl, k: 1 }, Nl, FIST, () => this.gripPoint(hdL), 1, 9, 0.52);   // (its wrist's reach eases in: _reachNatural)
    const grip = this.gripPoint(hdL);
    this.bowHandLen = wpos(arm.tip).distanceTo(grip) + restOff.length();
    if (base) {                                                     // (mocap: the bow as the clip holds it)
      const qb = hdL.hand.getWorldQuaternion(new Q()).multiply(this.bowInHand);
      xB.set(1, 0, 0).applyQuaternion(qb); yB.set(0, 1, 0).applyQuaternion(qb); zB.set(0, 0, 1).applyQuaternion(qb);
    } else {
      const Hh = wpos(hdL.hand), Da = wpos(hdL.middle).sub(Hh).normalize();
      const Na = new V3().crossVectors(wpos(hdL.index).sub(Hh), wpos(hdL.pinky).sub(Hh)).normalize().multiplyScalar(hdL.palmSign);
      yB.crossVectors(Na, Da).normalize(); zB.copy(Da).addScaledVector(yB, -Da.dot(yB)).normalize(); xB.crossVectors(yB, zB);
    }
    // the bow in the fist
    const bq2 = new Q().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xB, yB, zB));
    if (ft > 0) bq2.premultiply(new Q().setFromAxisAngle(h, 0.35 * ft));
    this.bow.group.position.copy(grip); this.bow.group.quaternion.copy(bq2); this.bow.group.updateMatrixWorld(true);
    const restW = this.bow.group.localToWorld(REST.clone());

    // ── the draw hand and the arrow ───────────────────────────────────────
    const armR = B.arms[1], hdR = rd.hands[1];
    const brace = -this.bow.braceZ;                                  // string to grip at rest
    const dE = this.draw * this.draw * (3 - 2 * this.draw);
    const Rn = base ? restW : R, dArrowN = base ? zB.clone() : dArrow;   // (mocap: the bow where the clip's fist holds it)
    const nockAt = (k) => Rn.clone().addScaledVector(dArrowN, -(brace + REST.z) - (Math.max(brace, this.drawFull - 0.015) - brace) * k).addScaledVector(xB, -REST.x).addScaledVector(yB, -REST.y * 0.15);
    // finger poses [index, middle, ring, pinky, thumb] × 3 joints, + [thumb opposition]
    // PINCH: searched on this hand — thumb swung across (opposition 1 rad), its
    // pad ~8 mm from the index's last pad (the shaft between); the old one left 14 cm
    const HOOK = [[0.15, 1.15, 0.6], [0.2, 1.2, 0.6], [0.25, 1.25, 0.65], [1.1, 1.45, 1.0], [0.45, 0.5, 0.35], [-0.5]];
    const OPEN = [[0.1, 0.25, 0.15], [0.12, 0.3, 0.15], [0.15, 0.32, 0.2], [0.25, 0.45, 0.3], [0.15, 0.2, 0.1], [-0.25]];
    const PINCH = [[0.75, 0.8, 0.15], [0.85, 1.0, 0.5], [1.0, 1.15, 0.7], [1.1, 1.25, 0.8], [0.05, 0.1, 0.15], [-1.0]];
    // the draw hand: knuckles run FORWARD along the arrow (a little in toward the
    // string), the fingers curl back round it; palm to the jaw, thumb up
    const DH = dArrow.clone().multiplyScalar(0.85).addScaledVector(h, -0.3).addScaledVector(UP, -0.05).normalize();
    // the hook: palm toward the FACE (back-left), thumb up — the fingers then curl
    // back round the string. (Palm forward-right had the hand turned over: the
    // forearm at its full pronation and the fingers curling the wrong way.)
    const NH = h.clone().negate().addScaledVector(dArrow, -0.15).normalize();
    // the draw elbow: back, out and up at full draw — but nocking, with the bow still low,
    // it hangs DOWN by the side (aimed up there it stuck out forward: a chicken wing)
    const poleDraw = dArrow.clone().multiplyScalar(-0.7).addScaledVector(h, 0.55).addScaledVector(UP, 0.25).normalize();
    const poleNock = this.chest().L.clone().multiplyScalar(-0.45).addScaledVector(UP, -0.85).addScaledVector(dArrow, -0.15).normalize();
    const poleR = poleNock.lerp(poleDraw, smooth(this.ext ?? 0)).normalize();
    let nockW = null, arrowFrom = null, arrowDir = null;
    const q = this.quiverFrame();
    if (this.phase === "fetch") {
      // Taking an arrow from a back quiver, built from how a body does it:
      //   GRIP     the arrow is pinched between the thumb tip and the index; its
      //            nock is AT the pinch and it can only pivot there (never through
      //            the hand)
      //   reach    0.00-0.85 s  the hand rises in front of the chest, then out
      //            beside the ear and up behind the head - like scratching the
      //            upper back: upper arm out to the side, elbow sharply bent, the
      //            forearm up behind the head, fingers up, palm to the quiver
      //   close    0.85-1.00 s  thumb and index close on one arrow below its nock
      //   pull     1.00-1.50 s  the elbow opens upward; the arrow slides out
      //            along the quiver, hanging behind the palm, pivoting on the lip
      //   bring    1.50-2.25 s  out beside the shoulder and down to the chest,
      //            the arrow swinging in the fingers to point at the bow
      //   nock     2.25-2.50 s  the nock onto the string; the fingers change
      //            from the pinch to the hook
      // Each movement is one smooth curve with a bell-shaped speed (minimum
      // jerk), the wrist within 30 deg of the forearm, the reach never locked.
      const T0 = this.t, mj = (x) => { x = clamp(x, 0, 1); return x * x * x * (10 - 15 * x + 6 * x * x); };
      const ST = this.fetchPhases();
      const pr = (k) => clamp((T0 - ST[k][0]) / (ST[k][1] - ST[k][0]), 0, 1);
      const SR = wpos(armR.u), Rt = ch.L.clone().negate(), cu = ch.u, cf = ch.f, Lf = ch.L;
      const toW = (x, y, z) => SR.clone().addScaledVector(Rt, x).addScaledVector(cu, y).addScaledVector(cf, z);
      // (the editor's "after a shot": where the follow-through leaves the hand — the full-draw anchor, 13 cm back)
      const holdHand = () => Raim.clone().addScaledVector(dAim, -(brace + REST.z) - (Math.max(brace, this.drawFull - 0.015) - brace) - 0.13).addScaledVector(h, 0.06).addScaledVector(UP, -0.02);
      if (!this.fetchStart) { const d = (this.fetchFromHold && this.edit ? holdHand() : this.fetchFromHold && this.lastHook ? this.lastHook.clone() : this.pinchPoint()).sub(SR);   // (from the follow-through: where the hand WAS — before this frame's IK the bones are the hanging clip's)
        this.fetchStart = [d.dot(Rt), d.dot(cu), d.dot(cf)];
        this.twistPrev = this.fetchTau0 = this.fetchFromHold ? (this.twistPrev ?? BP.tauHook) : this.forearmTwist(armR, hdR).tw; }   // (the roll starts from the clip's, or the release's)
      const armLenR = wpos(armR.u).distanceTo(wpos(armR.l)) + wpos(armR.l).distanceTo(wpos(armR.tip));
      const reachMax = armLenR * 0.86 + wpos(armR.tip).distanceTo(this.pinchPoint());   // the elbow never straight (it locked at 7° pulling up)
      const grab = q.mouth.clone().addScaledVector(q.axis, ARROW_LEN + 0.02 - QUIVER_LEN - 0.035);   // just below the nocks
      let pull = 0.62; while (pull > 0.05 && grab.clone().addScaledVector(q.axis, pull).distanceTo(SR) > reachMax) pull -= 0.02;
      const pulled = grab.clone().addScaledVector(q.axis, pull);
      const nv = (x, y, z) => Rt.clone().multiplyScalar(x).addScaledVector(cu, y).addScaledVector(cf, z).normalize();
      const tau0 = this.fetchTau0 ?? -90;
      const REACH = [[0.3, 0.4, 0.25], [0.35, 0.5, 0.3], [0.4, 0.55, 0.3], [0.45, 0.6, 0.35], [0.15, 0.2, 0.1], [-0.35]];   // relaxed: curled a little, more toward the pinky
      const mixF = (a, b2, k) => a.map((r, x) => r.map((v, y) => v + (b2[x][y] - v) * k));
      let T, pole, N2, Dw, fing, pt, fingW = null;
      if (base) {
        // ── MOCAP: the clip's own fingertips, elbow, roll and wrist; corrected onto this
        // quiver's nocks (the grab) and this bow's string (the nock) — from the keys the
        // clip made (its hand in the shoulder's frame), the same windows as keyed
        // (no nock correction: the bow hand brings the string to these fingers)
        const BA = this.baseArm;
        T = BA.pinch.clone();
        const rl = ST.reach[1] - ST.reach[0];
        const gW = mj((T0 - (ST.close[0] - rl / 2)) / (rl / 2)) * (1 - mj(pr("bring")));
        if (gW > 0) T.add(grab.clone().sub(toW(...this.baseGrab)).multiplyScalar(gW));
        const kN2 = mj(pr("nock"));
        pole = BA.elbowR.clone(); N2 = BA.handQR; Dw = null;
        if (this.nockCorr) T.sub(this.nockCorr);               // (the other half of the sideways gap)
        // KEPT OFF THE HEAD, last (after the pull toward the quiver, which drew the wrist 58 %
        // into a helmet as the hand came over the top): the fingers, and the wrist as the
        // clip's hand carries it, a hand's width clear
        {
          const wOff = this.wristFromPinch ?? wpos(armR.tip).sub(BA.pinch);   // (the hand as it WAS last frame, fingers curled — the clip's straight fingers put the wrist 15 cm off)
          const want = new V3();
          for (const [off, m] of [[new V3(), 0.025], [wOff, 0.045]]) { const q0 = T.clone().add(off).add(want); want.add(this.keepOffHead(q0, m).sub(q0)); }
          // (eased in and out over a few frames — on at full the instant it touched, it snapped)
          if (T0 < 0.05) this.headPush = new V3();
          this.headPush = (this.headPush ?? new V3()).lerp(want, lerpK(18, dt));
          T.add(this.headPush);
        }
        this.elbowDir = null; this.twistPrev = undefined;    // (the clip's elbow and roll — no lag behind them)
        fing = null;
        fingW = T0 < ST.pull[0] ? [PINCH, mj(pr("close"))] : [mixF(PINCH, HOOK, kN2), 1];
        pt = () => (kN2 > 0 ? this.pinchPoint().lerp(this.hookPoint(), kN2) : this.pinchPoint());
      } else if (this.useKeys()) {
        // ── KEYED (the timeline editor): the keys are where the hand is ASKED to
        // be — the same IK and limits as the coded fetch carry it there
        const K = fetchKeysAt(this.anim, T0, this.fetchFromHold), K0 = fetchKeysAt(this.anim, 0, this.fetchFromHold);
        const fade = 1 - mj(T0 / 0.6);                      // (from where the hand really is to the keys)
        T = toW(...K.hand.map((x, i) => x + (this.fetchStart[i] - K0.hand[i]) * fade));
        // onto the string: the keys were made with a level arrow; the real nock point is blended in over the bring
        const kN = fetchKeysAt(this.anim, ST.nock[0], this.fetchFromHold).hand;
        T.add(nockAt(0).sub(toW(...kN)).multiplyScalar(mj(pr("bring"))));
        // at the arrows: the keys at the grab are drawn onto this quiver's nocks — from the
        // second half of the reach, through the close and the pull, let go over the bring
        const kG = fetchKeysAt(this.anim, ST.close[0], this.fetchFromHold).hand, rl = ST.reach[1] - ST.reach[0];
        const gW = mj((T0 - (ST.close[0] - rl / 2)) / (rl / 2)) * (1 - mj(pr("bring")));   // (in over the reach's second half, out over the whole bring: faster, the hand jerked)
        if (gW > 0) T.add(grab.clone().sub(toW(...kG)).multiplyScalar(gW));
        pole = nv(...K.elbow);
        N2 = K.roll + (tau0 - K0.roll) * (1 - mj(T0 / 0.6));
        // NOCKING ends exactly in the pose the string holds next (the nock point, the draw
        // elbow, the hook's roll): the keys hand over across the nock phase — at the end
        // they were 13–15 cm off it and the hand jumped as the draw began
        const kN2 = mj(pr("nock"));
        if (kN2 > 0) { T.lerp(nockAt(0), kN2); pole.lerp(poleR, kN2).normalize(); N2 += (BP.tauHook - N2) * kN2; }
        const wn = clamp(K.wristNocks, 0, 1), ws = clamp(K.wristString, 0, 1);
        Dw = ws > 0.001 || wn > 0.01 ? { toward: q.axis.clone().negate().multiplyScalar(wn).addScaledVector(DH, ws).normalize(), k: Math.max(wn, ws) } : null;
        const fl = clamp(K.fingers, 0, 2);
        fing = fl <= 1 ? mixF(REACH, PINCH, fl) : mixF(PINCH, HOOK, fl - 1);
        pt = () => (fl > 1 ? this.pinchPoint().lerp(this.hookPoint(), fl - 1) : this.pinchPoint());
      } else {
      if (T0 < ST.close[0]) T = pathAt(this.fetchFromHold || this.fetchStart[1] > 0 ? [toW(...this.fetchStart), toW(0.03, 0.36, 0.02), grab] : [toW(...this.fetchStart), toW(-0.06, -0.14, 0.24), toW(-0.02, 0.16, 0.25), toW(0.03, 0.36, 0.02), grab], mj(pr("reach")));   // (from the follow-through, the hand is already up by the neck: straight over the shoulder)
      else if (T0 < ST.pull[0]) T = grab.clone();
      else if (T0 < ST.bring[0]) T = grab.clone().lerp(pulled, mj(pr("pull")));
      else if (T0 < ST.nock[0]) T = pathAt([pulled, toW(0.2, 0.18, 0.12), toW(0.14, -0.04, 0.3), nockAt(0)], mj(pr("bring")))   // (down in front of the right shoulder to the chest: out to the side first, the forearm swung round flat);
      else T = nockAt(0);
      // (bringing the arrow down to the bow the elbow stays OUT at the side, then drops to
      // the nock's — steered forward-down it swung in across the chest and the upper arm
      // sank into the body at 2.3 s)
      // the elbow — always steered ACROSS the arm, never along it (along it the
      // solver had no side to choose and flipped 15° a frame): hanging → out and
      // forward (reaching back past the ear) → forward (pulling up) → down and
      // forward (bringing round) → the draw's
      pole = (this.fetchFromHold ? nv(0.55, 0.3, 0.6) : nv(0.5, -0.6, -0.2)).lerp(nv(0.55, -0.1, 0.8), mj(T0 / 0.5)).lerp(nv(0.3, 0.75, 0.6), mj((T0 - 0.45) / 0.6)).lerp(nv(0.35, 0.45, 0.8), mj(pr("pull"))).lerp(nv(0.75, -0.25, 0.4), mj(pr("bring") / 0.5)).lerp(poleR, mj((pr("bring") - 0.5) / 0.5)).normalize();
      // the palm: toward the head while rising, toward the back of the head at the
      // quiver (the scratching-the-back hand, fingers up), toward the body as it
      // comes round, toward the face on the string — the forearm's roll is limited too
      // the forearm's roll (degrees; −90 relaxed, 0 palm up, −165 palm down):
      // from the clip's, through the reach, at the nocks, pulling, bringing, to the hook
      N2 = tau0 + (-55 - tau0) * mj(T0 / 0.6) + (BP.tauGrab - -55) * mj((T0 - 0.5) / 0.6) + (-85 - BP.tauGrab) * mj(pr("pull")) + (-100 - -85) * mj(pr("bring")) + (BP.tauHook - -100) * mj(pr("nock"));
      const downK = mj((T0 - 0.5) / 0.5) * (1 - mj(pr("pull") / 0.6));        // fingers down onto the nocks
      Dw = pr("nock") > 0 ? { toward: DH, k: mj(pr("nock")) } : downK > 0.01 ? { toward: q.axis.clone().negate(), k: downK } : null;
      fing = T0 < ST.pull[0] ? mixF(REACH, PINCH, mj(pr("close"))) : mixF(PINCH, HOOK, mj(pr("nock")));
      // eased in from the clip's pose (no snap of the hand or fingers at the start)
      pt = () => (pr("nock") > 0 ? this.pinchPoint().lerp(this.hookPoint(), mj(pr("nock"))) : this.pinchPoint());
      // (the editor's "rebuild from code": what the coded fetch asks, in the shoulder's frame)
      if (this.rec) {
        const loc = (v) => [v.dot(Rt), v.dot(cu), v.dot(cf)];
        this.rec.push({ t: T0, hand: loc(T.clone().sub(SR)), elbow: loc(pole), roll: N2, fingers: T0 < ST.pull[0] ? mj(pr("close")) : 1 + mj(pr("nock")),
          wristNocks: pr("nock") > 0 ? 0 : downK, wristString: pr("nock") > 0 ? mj(pr("nock")) : 0, look: this._look, headDown: this._down });
      }
      }
      const wIn = this.fetchFromHold || base ? aw : aw * mj(T0 / 0.3);   // (from the follow-through the arm is already on IK: no ease-in from the hanging clip pose)
      this.fetchFrame = { SR, Rt, cu, cf };                   // (the editor's handles)
      this.reachNatural(armR, hdR, T, pole, Dw, N2, fing, pt, wIn, base ? 9 : reachMax * (1 + 2 * mj(pr("nock"))), base ? 1.2 : 0.52 + 0.08 * mj(pr("nock")), base ? null : TWIST_R);   // (the reach and wrist limits hand over to the string's across the nock: switched at once, the hand stepped 3.8 cm)
      if (fingW) this.curl(hdR, fingW[0], fingW[1] * aw);    // (mocap: the clip's fingers until they close on the arrow)
      this.wristFromPinch = wpos(armR.tip).sub(this.pinchPoint());
      this.arrowTaken = T0 >= ST.close[0] + 0.1;
      if (!this.arrowTaken) this.arrowPath = null;
      this.fetchT = T;
      if (this.arrowTaken) {
        // the arrow: its nock in the pinch, pivoting on the quiver lip while it is
        // still in, then swinging in the fingers (in the hand's D-N plane) to the bow
        const Hh = wpos(hdR.hand), Dh = wpos(hdR.middle).sub(Hh).normalize();
        const Nh = new V3().crossVectors(wpos(hdR.index).sub(Hh), wpos(hdR.pinky).sub(Hh)).normalize().multiplyScalar(hdR.palmSign);
        arrowFrom = this.pinchPoint().addScaledVector(Dh, 0.01).addScaledVector(Nh, 0.008);
        const toLip = q.mouth.clone().sub(arrowFrom), inside = ARROW_LEN - toLip.length();
        this.fetchFree = Math.max(this.fetchFree ?? 0, mj(-inside / 0.1), mj((pr("pull") - 0.7) / 0.3) * mj((T0 - ST.pull[1]) / 0.15 + 1));
        // carried: it hangs DOWN in the fingers, a little out from the body, while
        // the hand comes round (laid along the forearm it swept through the chest),
        // and turns toward the bow only once the hand is out in front
        const gEnd = restW.clone().sub(arrowFrom).normalize();
        const hang = cu.clone().multiplyScalar(-0.85).addScaledVector(Rt, 0.4).addScaledVector(Nh, 0.5).normalize();   // down, on the PALM side (straight down it ran past the wrist), leaning out from the body (it grazed the flank coming over the shoulder)
        if (this.useKeys() || base) {
          // KEYED (fast, Mixamo): the arrow TRAILS along the hand's own path, as a shaft
          // held by its nock does — out along the quiver, over the top, then turned to the
          // bow. (Hanging down, it went through the head as the hand whipped over it.)
          const lp = arrowFrom.clone().sub(SR), path = (this.arrowPath ??= []), last = path[path.length - 1];
          const cur = [lp.dot(Rt), lp.dot(cu), lp.dot(cf)];
          if (!last || Math.hypot(cur[0] - last[0], cur[1] - last[1], cur[2] - last[2]) > 0.005) path.push(cur);
          let need = ARROW_LEN * 0.9, p = arrowFrom.clone(), tip = null;
          for (let i = path.length - 2; i >= 0 && !tip; i--) {
            const w = this.keepOffHead(toW(...path[i]), 0.02), d = w.distanceTo(p);   // (the trail's older points move with the shoulder, the head differently: kept off it)
            if (d >= need) tip = p.clone().lerp(w, need / d); else { need -= d; p = w; }
          }
          if (!tip) tip = p.addScaledVector(q.axis, -need);              // (the rest of it still in the quiver)
          arrowDir = tip.sub(arrowFrom).normalize().lerp(gEnd, mj((pr("bring") - 0.68) / 0.32)).normalize();
          // (straight, between points of a path curving round the head, the shaft cut through the
          // helmet: it pivots in the fingers until clear — toward its most buried point pushed out)
          for (let it = 0; it < 4; it++) {
            let worst = null, wd = 0;
            for (let kk = 0.1; kk <= ARROW_LEN; kk += 0.08) { const pa = arrowFrom.clone().addScaledVector(arrowDir, kk), q2 = this.keepOffHead(pa, 0.015), d = q2.distanceTo(pa); if (d > wd) { wd = d; worst = q2; } }
            if (!worst) break;
            arrowDir.copy(worst.sub(arrowFrom).normalize());
          }
        } else arrowDir = toLip.normalize().lerp(hang, this.fetchFree).normalize().lerp(gEnd, mj((pr("bring") - 0.68) / 0.32)).normalize();
        if (pr("nock") > 0.15) nockW = arrowFrom.clone();
      }
    } else if (this.phase === "nocked") {
      let qDraw = null;
      if (base) {
        // (mocap: the clip's hand at the nock; the archer's HOOK grip as the bow comes up —
        // knuckles along the arrow, palm to the face: the clip's wrist lifted the draw elbow
        // 10 cm over the arrow line)
        const keep = hdR.hand.quaternion.clone();
        this.rd.orientHandTo(hdR, DH, NH, 1);
        const qHook = hdR.hand.getWorldQuaternion(new Q());
        hdR.hand.quaternion.copy(keep); hdR.hand.updateMatrixWorld(true);
        qDraw = this.baseArm.handQR.clone().slerp(qHook, smooth(exA));
        this.drawHandQ = qDraw.clone();
      }
      const Tn = base ? this.baseArm.pinch.clone().sub(this.nockCorr ?? new V3()).lerp(nockAt(dE), smooth(exA)) : nockAt(dE);   // (mocap: the clip's own nock / early draw, onto the archer's draw line as the bow comes up)
      this.reachNatural(armR, hdR, Tn, base ? this.baseArm.elbowR.clone().lerp(poleR, smooth(exA)).normalize() : poleR, base ? null : { toward: DH, k: 1 }, base ? qDraw : BP.tauHook, HOOK, () => this.hookPoint(), aw, 9, 0.6, base ? null : TWIST_R);   // (the wrist within 35° of the forearm)
      nockW = this.hookPoint();
      arrowFrom = nockW; arrowDir = restW.clone().sub(nockW).normalize();
    } else if (this.phase === "release") {
      // the hand flies back past the ear, fingers open
      const k = smooth(this.t / 0.18), back = this.relFrom.clone().addScaledVector(dAim, -0.13 * k).addScaledVector(h, 0.06 * k).addScaledVector(UP, -0.02 * k);
      if (base) {
        // (mocap: a short snap back, then the clip lowers the arms itself)
        const wr = aw * (1 - smooth(this.t / 0.25));   // (the elbow carries on from the draw's; the part weight hands it to the clip's)
        const qRel = this.drawHandQ ? this.drawHandQ.clone().slerp(this.baseArm.handQR, smooth(this.t / 0.25)) : this.baseArm.handQR;   // (from the hook grip back to the clip's hand: switched at once, it jumped 20 cm)
        if (wr > 0.001) this.reachNatural(armR, hdR, back, poleR, null, qRel, OPEN, () => this.hookPoint(), wr, 9, 0.6, null);
      } else if (lowerK > 0) {
        // LOWERING (Mixamo 4.0–4.8 s): the hand comes down IN FRONT of the chest, then out
        // to hang — along its path (shoulder frame), the elbow turning down; the IK lets go
        // only at the end, where the hand already hangs. (Fading the weight dragged the
        // target through the shoulder of the folded arm: the hand dropped 32 cm in a frame.)
        const chL = this.chest(), SRl = wpos(armR.u), Rtl = chL.L.clone().negate();
        const toWl = (x, y, z) => SRl.clone().addScaledVector(Rtl, x).addScaledVector(chL.u, y).addScaledVector(chL.f, z);
        const Tl2 = pathAt([back, toWl(-0.17, 0.06, 0.24), toWl(-0.07, -0.25, 0.33), toWl(0.09, -0.55, 0.25), this.hookPoint()], lowerK);
        const poleDown = Rtl.clone().multiplyScalar(0.45).addScaledVector(chL.u, -0.85).addScaledVector(chL.f, -0.1).normalize();
        this.reachNatural(armR, hdR, Tl2, poleR.clone().lerp(poleDown, lowerK).normalize(), lowerK < 0.6 ? { toward: DH, k: 1 - lowerK / 0.6 } : null, BP.tauHook + (-95 - BP.tauHook) * lowerK, OPEN, () => this.hookPoint(), aw * (1 - smooth((lowerK - 0.8) / 0.2)), 9, 0.6, TWIST_R);
      } else this.reachNatural(armR, hdR, back, poleR, { toward: DH, k: 1 }, BP.tauHook, OPEN, () => this.hookPoint(), aw * (this.aimHeld || !BP.repeatFromHold ? 1 : 1 - smooth((this.t - 0.3) / 0.25)), 9, 0.6, TWIST_R);   // (held while aiming: the fetch takes over from here)
    }
    // ── the bow bends with the string; after a shot the limbs ring
    this.ringT += dt;
    const ringB = 0.12 * Math.exp(-this.ringT * 9) * Math.sin(this.ringT * 70);
    let nLocal = null;
    if (nockW) { nLocal = this.bow.group.worldToLocal(nockW.clone()); nLocal.x = 0; }
    else if (this.ringT < 0.5) nLocal = new V3(0, 0, this.bow.braceZ - ringB * 0.25);
    this.bend = this.bow.set(nLocal, nockW ? 0 : Math.max(0, ringB));
    // the arrow
    this.nocked.visible = !!arrowFrom;
    if (arrowFrom) {                                               // the cock feather (local +y) stands away from the bow
      const yA = xB.clone().addScaledVector(arrowDir, -xB.dot(arrowDir)).normalize(), xA = new V3().crossVectors(yA, arrowDir);
      this.nocked.position.copy(arrowFrom); this.nocked.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xA, yA, arrowDir)); this.nocked.updateMatrixWorld(true);
    }
    this.dAim = dAim; this.C = C; this.R = R; this.lastHook = this.hookPoint();
    this.placeQuiver(q);
    this.debug.update(dt, this);
  }

  shoot() {
    const v = BP.minSpeed + (BP.maxSpeed - BP.minSpeed) * this.draw ** 1.5;
    const a = makeArrow(); a.position.copy(this.nocked.position); a.quaternion.copy(this.nocked.quaternion); this.scene.add(a);
    const f = { m: a, vel: this.dAim.clone().multiplyScalar(v), t: 0, path: [a.position.clone()], draw: this.draw, v };
    this.flying.push(f);
    this.debug.shot(f);
    this.relFrom = (this.lastHook ?? this.hookPoint()).clone();   // where the hand WAS (this frame its bones are back at the clip's pose)
    this.phase = "release"; this.t = 0; this.draw = 0; this.ringT = 0;
    this.nocked.visible = false;
  }

  // ── arrows in flight: gravity, a little drag, nose along the velocity;
  // the point's path each frame is tested against the targets and the world
  updateArrows(dt) {
    const ray = new THREE.Raycaster(), solids = [...(this.world.ground ?? []), ...(this.world.blockers ?? []), ...(this.range?.solids ?? [])];
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const f = this.flying[i], a = f.m;
      f.t += dt;
      const dir0 = f.vel.clone().normalize(), tip0 = a.position.clone().addScaledVector(dir0, ARROW_LEN);
      stepFlight(a.position, f.vel, dt);
      const dir = f.vel.clone().normalize();
      a.quaternion.setFromUnitVectors(new V3(0, 0, 1), dir); a.rotateZ(Math.PI / 2 + f.t * 25);   // it spins (the helix)
      const tip = a.position.clone().addScaledVector(dir, ARROW_LEN);
      f.path.push(a.position.clone());
      // targets first (they move), then the static world
      const hit = this.range?.arrowHit(tip0, tip, f.vel, this.debug) ?? null;
      let stop = null;
      if (hit) {
        if (hit.passThrough) f.vel.multiplyScalar(0.6);
        else stop = { p: hit.p, obj: hit.obj, depth: hit.depth ?? 0.14 };
      } else {
        const seg = tip.clone().sub(tip0), L = seg.length();
        ray.set(tip0, seg.divideScalar(L || 1)); ray.far = L;
        const h = ray.intersectObjects(solids, true)[0];
        if (h) { stop = { p: h.point, obj: null, depth: 0.12 }; this.debug.note(`arrow: in the ${h.object === this.world.ground?.[0] ? "ground" : "wood"} at ${Math.hypot(h.point.x - f.path[0].x, h.point.z - f.path[0].z).toFixed(1)} m (${f.v.toFixed(0)} m/s)`); }
      }
      if (stop) {
        // stuck: the point sunk in past the contact
        a.position.copy(stop.p).addScaledVector(dir, stop.depth - ARROW_LEN);
        a.updateMatrixWorld(true);
        if (stop.obj) stop.obj.attach(a);
        this.debug.flash(stop.p, hit ? 0xffd23b : 0xff7a3b);
        this.flying.splice(i, 1); this.stuck.push(a);
        this.debug.landed(f);
        while (this.stuck.length > 24) { const o = this.stuck.shift(); o.removeFromParent(); }
      } else if (f.t > 6 || a.position.y < -5) { a.removeFromParent(); this.flying.splice(i, 1); }
    }
  }
  clearArrows() { for (const a of [...this.stuck, ...this.flying.map((f) => f.m)]) a.removeFromParent(); this.stuck.length = 0; this.flying.length = 0; }

  // the quiver on the back: its mouth by the right shoulder, leaning across the back
  quiverFrame() {
    // placed by where the hand takes an arrow: the nocks just behind the neck (Mixamo
    // "Shooting Arrow" grabs there), the quiver slanting down to the left hip
    const ch = this.chest(), SR = wpos(this.rd.B.arms[1].u), Rt = ch.L.clone().negate();
    const fr = (v) => Rt.clone().multiplyScalar(v[0]).addScaledVector(ch.u, v[1]).addScaledVector(ch.f, v[2]);
    const axis = fr(BP.quiverAxis).normalize();
    const nocks = SR.clone().add(fr(BP.quiverNocks));
    const mouth = nocks.addScaledVector(axis, -(ARROW_LEN + 0.02 - QUIVER_LEN - 0.035));
    return { axis, bottom: mouth.clone().addScaledVector(axis, -QUIVER_LEN), mouth, ch };
  }
  placeQuiver(q) {
    const g = this.quiver.group, ch = q.ch;
    const zq = ch.f.clone().negate(); zq.addScaledVector(q.axis, -zq.dot(q.axis)).normalize();
    const xq = new V3().crossVectors(q.axis, zq);
    g.position.copy(q.bottom); g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xq, q.axis, zq));
    // one arrow fewer while one is in the hand, on the string or in the air
    const out = this.phase === "fetch" ? (this.arrowTaken ? 1 : 0) : this.phase === "nocked" ? 1 : 0;
    this.quiver.arrows.forEach((a, i) => (a.visible = i >= out));
  }
}

// ── the debug view: the predicted flight, the last flights, where they landed ─
function createBowDebug(scene) {
  const root = new THREE.Group(); root.name = "bowDebug"; scene.add(root);
  const mat = (c, o = 1) => new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: o, depthTest: false });
  const N = 240, predGeo = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(N * 3, 3));
  const pred = new THREE.Line(predGeo, mat(0x6fd8ff, 0.9)); pred.frustumCulled = false; pred.renderOrder = 999; root.add(pred);
  const aimDot = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshBasicMaterial({ color: 0x6fd8ff, depthTest: false, transparent: true, opacity: 0.8 })); aimDot.renderOrder = 999; root.add(aimDot);
  const trails = [], flashes = [];
  const flashGeo = new THREE.SphereGeometry(0.07, 12, 8);
  const hud = document.createElement("div");
  hud.style.cssText = "position:fixed;left:12px;bottom:34px;z-index:20;background:rgba(14,18,22,.82);color:#ffe7b8;font:12px ui-monospace,monospace;padding:7px 10px;border-radius:6px;border-left:4px solid #ffb84d;display:none;max-width:460px;white-space:pre";
  document.body.appendChild(hud);
  const log = [];
  const api = {
    note(s) { log.unshift(s); log.length = Math.min(log.length, 7); },
    flash(p, color) { const m = new THREE.Mesh(flashGeo, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 })); m.position.copy(p); m.renderOrder = 999; m.visible = BP.debug; root.add(m); flashes.push({ m, t: 0 }); },
    shot(f) { f.line = null; },
    landed(f) {
      if (!BP.debug) return;
      const g = new THREE.BufferGeometry().setFromPoints(f.path), l = new THREE.Line(g, mat(0xffb84d, 0.85)); l.frustumCulled = false; l.renderOrder = 998; root.add(l); trails.push(l);
      while (trails.length > 6) { const o = trails.shift(); root.remove(o); o.geometry.dispose(); }
    },
    clear() { for (const t of trails) { root.remove(t); t.geometry.dispose(); } trails.length = 0; },
    update(dt, ar) {
      for (const f of flashes) { f.t += dt; f.m.scale.setScalar(1 + f.t * 2); f.m.material.opacity = Math.max(0, 0.9 - f.t / 1.2); }
      while (flashes.length && flashes[0].t > 1.2) { const f = flashes.shift(); root.remove(f.m); f.m.material.dispose(); }
      root.visible = BP.debug; hud.style.display = BP.debug ? "block" : "none";
      if (!BP.debug) return;
      const show = !!ar && ar.aimW > 0.5 && ar.nocked.visible;
      pred.visible = aimDot.visible = show;
      if (show) {
        // the flight this draw would give (from the arrow's point), until it meets something
        const v = BP.minSpeed + (BP.maxSpeed - BP.minSpeed) * Math.max(ar.draw, 0.001) ** 1.5;
        const p = ar.nocked.position.clone().addScaledVector(ar.dAim, ARROW_LEN), vel = ar.dAim.clone().multiplyScalar(ar.draw > 0.05 ? v : BP.maxSpeed);
        const P = predGeo.attributes.position; let last = p.clone();
        for (let i = 0; i < N; i++) { if (last.y > -0.05) stepFlight(last, vel, 1 / 60); P.setXYZ(i, last.x, Math.max(last.y, 0.02), last.z); }
        P.needsUpdate = true;
        aimDot.position.copy(ar.aimPoint);
      }
      const st = ar ? `draw ${(ar.draw * 100).toFixed(0)} % · ${ar.phase} · bow bend ${(ar.bend ?? 0).toFixed(2)} · arrow ${(BP.minSpeed + (BP.maxSpeed - BP.minSpeed) * ar.draw ** 1.5).toFixed(0)} m/s` : "bow off";
      hud.textContent = `bow (debug) — ${st}\n` + (log.length ? log.join("\n") : "—");
    },
  };
  return api;
}

// ── the archery range (parkour field, north side): butts at 10–60 m, and the
// lance lane's physical targets to shoot at ──────────────────────────────────
export const RANGE = { z: 100, x0: -24 };
function buttFaceTexture() {
  const S = 512, [c, g] = canvas(S, S), r = rng(3);
  // straw first (the rim shows), then the painted face: gold, red, blue, black, white (FITA, 10 rings)
  g.fillStyle = "#c9a95e"; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 4000; i++) { g.strokeStyle = `rgba(${r() < 0.5 ? "120,90,40" : "235,210,140"},${0.3 + r() * 0.4})`; g.lineWidth = 1; const x = r() * S, y = r() * S, a = r() * Math.PI; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * 14, y + Math.sin(a) * 14); g.stroke(); }
  const cols = ["#f5f2ea", "#f5f2ea", "#1d1d1d", "#1d1d1d", "#2f7cc9", "#2f7cc9", "#d23a2c", "#d23a2c", "#f2c531", "#f2c531"];
  const R = S * 0.46;
  for (let k = 0; k < 10; k++) { g.fillStyle = cols[k]; g.beginPath(); g.arc(S / 2, S / 2, R * (1 - k / 10), 0, Math.PI * 2); g.fill(); g.strokeStyle = k === 2 || k === 3 ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.45)"; g.lineWidth = 1.5; g.stroke(); }
  g.strokeStyle = "rgba(0,0,0,0.6)"; g.lineWidth = 1; g.beginPath(); g.moveTo(S / 2 - 6, S / 2); g.lineTo(S / 2 + 6, S / 2); g.moveTo(S / 2, S / 2 - 6); g.lineTo(S / 2, S / 2 + 6); g.stroke();
  for (let i = 0; i < 1500; i++) { g.fillStyle = `rgba(60,40,20,${r() * 0.12})`; g.fillRect(r() * S, r() * S, 2, 2); }   // weathered paint
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
export function buildRange(scene, notes = null) {
  const root = new THREE.Group(); root.name = "archeryRange";
  const M = contactMats(), solids = [], targets = [];
  const faceTex = buttFaceTexture();
  const straw = new THREE.MeshStandardMaterial({ color: 0xc9a95e, roughness: 0.95 });
  const face = new THREE.MeshStandardMaterial({ map: faceTex, roughness: 0.85 });
  const { z: Z, x0: X } = RANGE;
  // the shooting line and a rack
  const line = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 14), M.cream); line.position.set(X, 0.01, Z); root.add(line);
  // butts: a straw boss on an A-frame stand, the face toward the line (−x), leaning back 12°
  const RB = 0.62, DEPTH = 0.32;
  for (const [dist, dz] of [[10, -4], [20, 3.5], [30, -2], [45, 2], [60, 0]]) {   // staggered: none in another's line from the shooting line
    const g = new THREE.Group(); g.position.set(X + dist, 0, Z + dz); g.rotation.y = -Math.PI / 2; root.add(g);   // local +z → −x (toward the line)
    const boss = new THREE.Group(); boss.position.set(0, 1.25, 0); boss.rotation.x = -0.2; g.add(boss);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(RB, RB, DEPTH, 40, 1, true), straw); body.rotation.x = Math.PI / 2; boss.add(body);
    const front = new THREE.Mesh(new THREE.CircleGeometry(RB, 48), face); front.position.z = DEPTH / 2; boss.add(front);
    const back = new THREE.Mesh(new THREE.CircleGeometry(RB, 32), straw); back.position.z = -DEPTH / 2; back.rotation.y = Math.PI; boss.add(back);
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.0, 0.08), M.wood); leg.position.set(s * 0.55, 1.0, -0.15); leg.rotation.x = -0.12; g.add(leg); solids.push(leg);
      const back2 = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.9, 0.07), M.wood); back2.position.set(s * 0.55, 0.9, -0.6); back2.rotation.x = 0.45; g.add(back2);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.08, 0.1), M.wood); bar.position.set(0, 0.62, -0.05); g.add(bar); solids.push(bar);
    targets.push({ kind: "butt", dist, g, boss, shapes: [] });
  }
  // the lance lane's targets, at shooting heights
  const H = 1.45;
  for (const [mk, dist, dz] of [[jar, 15, 6], [dummy, 25, -6], [gallows, 35, 8.5], [crateStack, 40, -7], [jar, 52, 6]]) {
    const t = mk(M, H); t.g.position.set(X + dist, 0, Z + dz); root.add(t.g); t.dist = dist;   // as on the lance lane: struck travelling +x
    targets.push(t);
  }
  shadowed(root); scene.add(root);
  const ARROW_R = 0.012, MASS = 0.055;                              // an arrow pushes like a ~3 kg·m/s blow: × its share
  const segTest = (a, b, test) => { const n = Math.max(2, Math.ceil(a.distanceTo(b) / 0.04)); for (let k = 0; k <= n; k++) { const p = a.clone().lerp(b, k / n); if (test(p)) return p; } return null; };
  return {
    root, solids, targets,
    update(dt) { for (const t of targets) t.update?.(dt); },
    reset() { for (const t of targets) t.reset?.(); },
    /** the arrow's point moved a → b this frame: what did it hit? */
    arrowHit(a, b, vel, debug) {
      for (const t of targets) {
        if (t.kind === "butt") {
          const p = segTest(a, b, (p) => { const l = t.boss.worldToLocal(p.clone()); return Math.abs(l.z) < DEPTH / 2 && l.x * l.x + l.y * l.y < RB * RB; });
          if (!p) continue;
          const l = t.boss.worldToLocal(p.clone()), rr = Math.hypot(l.x, l.y), ring = Math.max(1, 10 - Math.floor(rr / (RB * 0.92 / 10)));
          const name = ring >= 9 ? "gold" : ring >= 7 ? "red" : ring >= 5 ? "blue" : ring >= 3 ? "black" : "white";
          const off = p.clone().sub(t.boss.getWorldPosition(new V3())), side = new V3(-vel.z, 0, vel.x).normalize().dot(off);   // + = right of the centre (seen from the line)
          debug?.note(`HIT butt ${t.dist} m: ${ring} (${name}), ${(rr * 100).toFixed(0)} cm from the centre — ${Math.abs(off.y) > Math.abs(side) ? (off.y > 0 ? "high" : "low") : side > 0 ? "right" : "left"} (${(off.y * 100).toFixed(0)} up, ${(side * 100).toFixed(0)} right)`);
          notes?.(t, ring);
          return { p, obj: t.boss, depth: 0.2 };
        }
        for (const sh of t.shapes) {
          if (sh.shape.live && !sh.shape.live()) continue;
          const p = segTest(a, b, (p) => shapeTest(sh.obj, sh.shape, p, ARROW_R));
          if (!p) continue;
          const wq = t.g.getWorldQuaternion(new Q());
          const res = t.hit({ p, along: 1, vel: vel.clone().multiplyScalar(MASS) }, wq, sh);
          if (res === null) continue;
          debug?.note(`HIT ${t.kind} ${t.dist} m (${vel.length().toFixed(0)} m/s) — ${res}`);
          return t.kind === "jar" ? { p, passThrough: true } : { p, obj: sh.obj, depth: t.kind === "crates" ? 0.06 : 0.16 };
        }
      }
      return null;
    },
    start: { x: X - 1.5, z: Z, yaw: Math.PI / 2 },
  };
}
