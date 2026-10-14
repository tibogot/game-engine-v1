// ARC TRAILS (2026-10-14, alg-rts — you: "a trail on the grenade like Company of Heroes; it should adapt
// to the distance"). A thin streak of smoke along the path a thrown grenade has really flown: its own
// positions, kept as it goes — a short lob leaves a short low curve, a long throw a long high one,
// nothing tuned per distance.
//
// CoH's (your screenshot, same day: "ours looks cheap"): the WHOLE arc stays drawn, hand to ground; it
// is a thread with FEATHERED edges, not a flat strip; and it is smoke — each bit of it spreads wider
// and thinner as it ages, and the streak hangs a moment after the grenade lands before it is gone.
//
// ONE draw for every trail: a fixed vertex buffer (TRAILS × POINTS × 2), the strips turned to the
// camera on the CPU (a few hundred vertices a frame), unlit, no depth write; the soft edge is a tiny
// alpha ramp across the strip (uv.x). Unused vertices collapse onto their trail's last point.
import * as THREE from "three";
import { RENDER_ORDER } from "./renderOrder.js";

const TRAILS = 32, POINTS = 64;
const SPACING = 0.45;        // m between two kept points (64 × 0.45 m: a 40 m throw's whole arc)
const LIFE = 2.6;            // s a point lives in flight (longer than any throw: the whole arc stays)
const LINGER = 1.3;          // s the streak hangs after the landing, fading
const SPREAD = 1.4;          // its width grows by this × per second of age (smoke diffusing)
const RISE = 0.18, DRIFT = 0.3;    // m/s the old smoke lifts, and drifts on the wind (one way per streak,
                                   // a slow sway along it: random per POINT zig-zagged)

/** The strip's cross-section: 0 at both edges, a soft core (smoke, not a ribbon). */
function edgeTexture() {
  const N = 64, d = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const x = (i + 0.5) / N * 2 - 1;                     // -1 … 1 across the strip
    const a = Math.exp(-x * x * 4.5) * (1 - x * x);       // gaussian core, exactly 0 at the edges
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = Math.round(255 * a); d[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(d, N, 1, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

export function createArcTrails(scene, { width = 0.2, color = 0xf2eee6, opacity = 0.62 } = {}) {
  const V = TRAILS * POINTS * 2;
  const pos = new Float32Array(V * 3), col = new Float32Array(V * 4), uv = new Float32Array(V * 2);
  const idx = [];
  for (let t = 0; t < TRAILS; t++) for (let i = 0; i < POINTS - 1; i++) {
    const a = (t * POINTS + i) * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  for (let v = 0; v < V; v++) uv[v * 2] = v & 1;          // across the strip: 0 | 1
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, alphaMap: edgeTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = RENDER_ORDER.TRACERS;   // (a streak in the air, with the tracers: over the smoke)
  mesh.name = "ArcTrails";
  mesh.visible = false;
  scene.add(mesh);
  const base = new THREE.Color(color);

  const slots = Array.from({ length: TRAILS }, () => ({ owner: null, pts: [], done: -1, w: width }));
  const map = new Map();   // owner (a shell record) → slot

  /** Where `owner` (a shell) is now; `scale`: its width × (a smoke can's thicker). */
  function point(owner, x, y, z, now, scale = 1) {
    let s = map.get(owner);
    if (!s) {
      s = slots.find((q) => !q.owner && !q.pts.length) ?? slots.reduce((a, b) => (a.pts.length < b.pts.length ? a : b));
      if (s.owner) map.delete(s.owner);
      s.owner = owner; s.pts.length = 0; s.done = -1; s.w = width * scale;
      const a = Math.random() * Math.PI * 2;
      s.wx = Math.cos(a); s.wz = Math.sin(a); s.ph = Math.random() * 6.3; s.k = 0;
      map.set(owner, s);
    }
    const last = s.pts[s.pts.length - 1];
    if (!last || s.pts.length < 2 || Math.hypot(x - s.pts[s.pts.length - 2].x, y - s.pts[s.pts.length - 2].y, z - s.pts[s.pts.length - 2].z) >= SPACING) {
      // Each bit its own density (puffs along the streak); the drift is the streak's wind, swaying.
      const sw = 0.6 + 0.4 * Math.sin(s.k++ * 0.35 + s.ph);
      s.pts.push({ x, y, z, t: now, n: 0.6 + Math.random() * 0.6, dx: s.wx * sw, dz: s.wz * sw });
      if (s.pts.length > POINTS) s.pts.shift();
    } else { last.x = x; last.y = y; last.z = z; }   // (the head follows the grenade between points)
  }
  /** The grenade landed: its streak hangs, then fades out. */
  function end(owner, now) {
    const s = map.get(owner);
    if (!s) return;
    s.done = now;
    s.owner = null;
    map.delete(owner);
  }

  const _p = new THREE.Vector3(), _d = new THREE.Vector3(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
  function update(now, camera) {
    let any = false;
    for (let t = 0; t < TRAILS; t++) {
      const s = slots[t];
      if (s.done >= 0 && now - s.done > LINGER) s.pts.length = 0;
      else while (s.pts.length && now - s.pts[0].t > LIFE) s.pts.shift();
      const n = s.pts.length, o = t * POINTS * 2;
      // A landed streak fades as a whole (smoothly: it thins, it does not blink out).
      const fade = s.done >= 0 ? 1 - THREE.MathUtils.smoothstep(now - s.done, 0, LINGER) : 1;
      // The length along it, for the soft head and tail.
      let L = 0;
      for (let i = 1; i < n; i++) L += Math.hypot(s.pts[i].x - s.pts[i - 1].x, s.pts[i].y - s.pts[i - 1].y, s.pts[i].z - s.pts[i - 1].z);
      let along = 0;
      for (let i = 0; i < POINTS; i++) {
        const k = (o + i * 2) * 3, c = (o + i * 2) * 4;
        // Unused points COLLAPSE onto the last real one (zero-width, transparent). Parked at the world
        // origin, the last real segment was joined to it: a second ribbon across the sky (you, 2026-10-14).
        if (i >= n || n < 2) {
          const h = n ? s.pts[n - 1] : null;
          for (let j = 0; j < 6; j += 3) { pos[k + j] = h ? h.x : 0; pos[k + j + 1] = h ? h.y : -1e4; pos[k + j + 2] = h ? h.z : 0; }
          col.fill(0, c, c + 8);
          continue;
        }
        any = true;
        const p0 = s.pts[i], q = s.pts[Math.min(n - 1, i + 1)], r = s.pts[Math.max(0, i - 1)];
        if (i > 0) along += Math.hypot(p0.x - r.x, p0.y - r.y, p0.z - r.z);
        // The smoke where it is now: lifted and drifted by its age (the head, new, sits on the grenade).
        const age = now - p0.t, dr = DRIFT * age;
        const p = _p.set(p0.x + p0.dx * dr, p0.y + RISE * age, p0.z + p0.dz * dr);
        _d.set(q.x - r.x, q.y - r.y, q.z - r.z).normalize();
        _v.set(p.x - camera.position.x, p.y - camera.position.y, p.z - camera.position.z);
        _s.crossVectors(_d, _v).normalize();
        // Smoke: each bit spreads and thins with its age; the thread is thinnest at the grenade.
        const w = s.w * (0.55 + age * SPREAD) * 0.5;
        pos[k] = p.x + _s.x * w; pos[k + 1] = p.y + _s.y * w; pos[k + 2] = p.z + _s.z * w;
        pos[k + 3] = p.x - _s.x * w; pos[k + 4] = p.y - _s.y * w; pos[k + 5] = p.z - _s.z * w;
        // Opacity: thins as it spreads (the same smoke over a wider strip), a soft start at the hand
        // (2 m) and a short soft head behind the grenade (0.6 m), and the landed fade.
        const thin = 1 / (1 + age * SPREAD * 0.9);
        const tail = Math.min(1, along / 2), head = Math.min(1, (L - along) / 0.6 + 0.25);
        // Uneven density (its neighbours' average: puffs, not speckle), evening out at the fresh head.
        const dens = (p0.n * 2 + q.n + r.n) / 4, nn = 1 + (dens - 0.9) * Math.min(1, age * 3);
        const al = opacity * thin * tail * head * fade * nn;
        col[c] = col[c + 4] = base.r; col[c + 1] = col[c + 5] = base.g; col[c + 2] = col[c + 6] = base.b;
        col[c + 3] = col[c + 7] = al;
      }
    }
    mesh.visible = any;
    if (any) { geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true; }
  }

  return { point, end, update, mesh, params: { SPACING, LIFE, LINGER, SPREAD } };
}
