// Thunderline piece lab (P5). Shows every tile, chains a ~2 km test track (flights placed on the
// 60 m/s arc), instanced per tile, and rides it at 216 km/h to judge the look at speed.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TILES, integrate, deckFrame, socketMatrix, leanIn, SECTIONS, DEG } from "./kit.js";
import { buildOldLook, createOldLookMaterials } from "./oldLook.js";
import { layoutTestTrack, buildTrackMeshes } from "./testTrack.js";

const $ = (id) => document.getElementById(id);
const V = THREE.Vector3;
const Y = new V(0, 1, 0);
const G = 9.81;
const SPEED = 60;

// ---------- renderer ----------
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
$("view").appendChild(renderer.domElement);
await renderer.init();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb8e0);
scene.add(new THREE.HemisphereLight(0xe2efff, 0x6f6a62, 1.4));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.8);
sun.position.set(-0.5, 0.8, 0.35).multiplyScalar(500);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 9000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// ---------- tiles ----------
// The OLD game's road, kerbs, guardrail and posts on the NEW paths (oldLook.js).
const mats = createOldLookMaterials();
const t0 = performance.now();
const built = {};
for (const [id, t] of Object.entries(TILES)) {
  built[id] = { b: integrate(t), guarded: buildOldLook(t, true), open: buildOldLook(t, false) };
}
let showEdges = true;
const buildMs = performance.now() - t0;

const trisOf = (g) => (g ? (g.index ? g.index.count : g.getAttribute("position").count) / 3 : 0);
/** Meshes for one tile in one edge mode: deck + rail + instanced posts (piece-local). */
function pieceGroup(look) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(look.deck, mats.road));
  if (look.rail) g.add(new THREE.Mesh(look.rail, mats.rail));
  if (look.posts?.template && look.posts.matrices.length) {
    const im = new THREE.InstancedMesh(look.posts.template, mats.rail, look.posts.matrices.length);
    look.posts.matrices.forEach((m, i) => im.setMatrixAt(i, m));
    im.computeBoundingSphere();
    g.add(im);
  }
  return g;
}

// showcase: every tile once, side by side
const showcase = new THREE.Group();
scene.add(showcase);
const labels = [];
{
  let x = 0;
  for (const [id, t] of Object.entries(TILES)) {
    const mesh = new THREE.Group();
    mesh.add(pieceGroup(built[id].guarded));
    mesh.userData.id = id;
    mesh.rotation.x = -(t.landAngle ?? 0) * DEG; // shown the way you meet it: tipped down along the arc
    mesh.updateMatrixWorld();
    const bb = new THREE.Box3().setFromObject(mesh);
    mesh.position.set(x - bb.min.x, 0, 0);
    showcase.add(mesh);
    labels.push({ text: t.label, at: new V(x - bb.min.x, Math.max(bb.max.y, 2) + 6, 0) });
    x += bb.max.x - bb.min.x + 30;
  }
  showcase.position.set(-x / 2, 40, 0);
}

// ---------- test track ----------
const track = new THREE.Group();
scene.add(track);
const { placements, ride, arcPts, length, warnings } = layoutTestTrack({ built, speed: SPEED });
const meshes = buildTrackMeshes(placements, built, mats);
track.add(meshes.group);
const trackTris = meshes.tris;
// flight arcs, dashed
{
  const segs = [];
  for (let i = 0; i + 1 < arcPts.length; i++) if (arcPts[i] && arcPts[i + 1]) segs.push(arcPts[i], arcPts[i + 1]);
  const lg = new THREE.BufferGeometry().setFromPoints(segs);
  const line = new THREE.LineSegments(lg, new THREE.LineDashedMaterial({ color: 0xff7a1a, dashSize: 4, gapSize: 4 }));
  line.computeLineDistances();
  track.add(line);
}

// ---------- views ----------
let view = "showcase";
let rideState = null;
function setView(v) {
  view = v;
  for (const b of document.querySelectorAll("#views button[data-v]")) b.classList.toggle("on", b.dataset.v === v);
  $("hud").style.display = v === "ride" ? "block" : "none";
  controls.enabled = v !== "ride";
  if (v === "showcase") {
    controls.target.set(0, 40, 0);
    camera.position.set(-120, 160, 420);
  } else if (v === "track") {
    const box = new THREE.Box3().setFromObject(track);
    const c = box.getCenter(new V());
    controls.target.copy(c);
    camera.position.copy(c).add(new V(-500, 650, 700));
  } else {
    rideState = { k: 0, f: 0, time: 0 };
  }
  camera.fov = v === "ride" ? 72 : 55;
  camera.updateProjectionMatrix();
}
for (const b of document.querySelectorAll("#views button[data-v]")) b.onclick = () => setView(b.dataset.v);
function setEdges(on) {
  showEdges = on;
  for (const holder of showcase.children) {
    holder.clear();
    holder.add(pieceGroup(on ? built[holder.userData.id].guarded : built[holder.userData.id].open));
  }
  $("b-edges").textContent = `Edges: ${on ? "guarded" : "open"}`;
  $("b-edges").classList.toggle("on", on);
}
$("b-edges").onclick = () => setEdges(!showEdges);
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "e") setEdges(!showEdges);
  if (k === "1") setView("showcase");
  if (k === "2") setView("track");
  if (k === "3" || k === "r") setView("ride");
});

const camLook = new V();
function stepRide(dt) {
  let left = SPEED * dt;
  while (left > 0 && rideState.k < ride.length - 1) {
    const a = ride[rideState.k].P, b = ride[rideState.k + 1].P;
    const seg = a.distanceTo(b) || 1e-3;
    const rem = (1 - rideState.f) * seg;
    if (rem > left) { rideState.f += left / seg; left = 0; } else { left -= rem; rideState.k++; rideState.f = 0; }
  }
  rideState.time += dt;
  if (rideState.k >= ride.length - 1) { rideState.k = 0; rideState.f = 0; rideState.time = 0; }
  const A = ride[rideState.k], B = ride[rideState.k + 1];
  const P = A.P.clone().lerp(B.P, rideState.f);
  const T = A.T.clone().lerp(B.T, rideState.f).normalize();
  const flat = new V(T.x, 0, T.z);
  if (flat.lengthSq() < 0.05) flat.copy(camLook).sub(camera.position).setY(0);
  flat.normalize();
  const want = P.clone().addScaledVector(flat, -12).add(new V(0, 4.2, 0));
  const k = 1 - Math.exp(-dt * 9);
  camera.position.lerp(want, k);
  camLook.lerp(P.clone().addScaledVector(flat, 14).add(new V(0, 1, 0)), k);
  camera.lookAt(camLook);
  $("hud").textContent = `216 km/h · ${rideState.time.toFixed(1)} s${A.air ? " · AIR" : ""}`;
}

// ---------- stats + labels ----------
const labelEls = labels.map((l) => {
  const el = document.createElement("div");
  el.className = "lbl";
  el.textContent = l.text;
  $("labels").appendChild(el);
  return el;
});
function renderStats(draws) {
  $("stats").innerHTML =
    `<h1>Piece lab</h1>` +
    `<div class="row"><span>tiles</span><b>${Object.keys(TILES).length}</b></div>` +
    `<div class="row"><span>build all tiles</span><b>${buildMs.toFixed(1)} ms</b></div>` +
    `<div class="row"><span>test track</span><b>${(length / 1000).toFixed(2)} km</b></div>` +
    `<div class="row"><span>track triangles</span><b>${Math.round(trackTris).toLocaleString()}</b></div>` +
    `<div class="row"><span>per metre</span><b>${(trackTris / length).toFixed(1)} (old ~110)</b></div>` +
    `<div class="row"><span>draw calls (frame)</span><b>${draws}</b></div>` +
    (warnings.length ? `<div style="color:#ff4d5e">${warnings.join("<br>")}</div>` : "");
}

setView("showcase");
let last = performance.now();
let frame = 0;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  showcase.visible = view === "showcase";
  track.visible = view !== "showcase";
  if (view === "ride") stepRide(dt);
  else controls.update();
  renderer.render(scene, camera);
  labels.forEach((l, i) => {
    const p = l.at.clone().add(showcase.position).project(camera);
    const vis = view === "showcase" && p.z < 1;
    labelEls[i].style.display = vis ? "block" : "none";
    if (vis) { labelEls[i].style.left = `${(p.x * 0.5 + 0.5) * innerWidth}px`; labelEls[i].style.top = `${(-p.y * 0.5 + 0.5) * innerHeight}px`; }
  });
  if (++frame % 30 === 0) renderStats(renderer.info.render.drawCalls);
});
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
window.__lab = {
  setView, camera, controls, showcase,
  /** Look at showcase tile `id` from a 3/4 chase-height view. */
  look(id, dist = 60, height = 25, side = 0.6) {
    const i = Object.keys(TILES).indexOf(id);
    const at = labels[i].at.clone().add(showcase.position);
    at.y -= 6;
    controls.target.copy(at).add(new V(0, 0, -20));
    camera.position.copy(at).add(new V(dist * side, height, dist));
  },
  built, placements, warnings, ride, get length() { return length; }, trackTris: () => trackTris };
