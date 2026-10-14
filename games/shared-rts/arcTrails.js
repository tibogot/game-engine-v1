// ARC TRAILS (2026-10-14, alg-rts — you: "a trail on the grenade like Company of Heroes; it should adapt
// to the distance"). A thin RIBBON along the path a thrown grenade has really flown: its own positions,
// kept as it goes — a short lob leaves a short low curve, a long throw a long high one, nothing tuned
// per distance. Widest just behind the grenade, tapering and fading toward the tail; it stays a moment
// after the grenade lands and fades out.
//
// ONE draw for every trail: a fixed vertex buffer (TRAILS × POINTS × 2), the strips turned to the
// camera on the CPU (a few hundred vertices a frame), unlit, additive-free (a pale streak, not a glow),
// no depth write. Empty trails cost nothing but their zeroed vertices (degenerate, culled).
import * as THREE from "three";
import { RENDER_ORDER } from "./renderOrder.js";

const TRAILS = 32, POINTS = 28;
const SPACING = 0.22;        // m between two kept points
const LIFE = 0.8;            // s a point lives (the trail's length in time: it adapts to the throw)
const LINGER = 0.5;          // s after landing before it is gone

export function createArcTrails(scene, { width = 0.24, color = 0xeeeae0, opacity = 0.8 } = {}) {
  const V = TRAILS * POINTS * 2;
  const pos = new Float32Array(V * 3), col = new Float32Array(V * 4);
  const idx = [];
  for (let t = 0; t < TRAILS; t++) for (let i = 0; i < POINTS - 1; i++) {
    const a = (t * POINTS + i) * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(idx);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
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
      map.set(owner, s);
    }
    const last = s.pts[s.pts.length - 1];
    if (!last || Math.hypot(x - last.x, y - last.y, z - last.z) >= SPACING) {
      s.pts.push({ x, y, z, t: now });
      if (s.pts.length > POINTS) s.pts.shift();
    } else { last.x = x; last.y = y; last.z = z; }   // (the head follows the grenade between points)
  }
  /** The grenade landed: its trail fades out. */
  function end(owner, now) {
    const s = map.get(owner);
    if (!s) return;
    s.done = now;
    s.owner = null;
    map.delete(owner);
  }

  const _a = new THREE.Vector3(), _d = new THREE.Vector3(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
  function update(now, camera) {
    let any = false;
    for (let t = 0; t < TRAILS; t++) {
      const s = slots[t];
      // Points older than LIFE go (a landed trail: all of them over LINGER).
      const life = s.done >= 0 ? Math.max(0.01, LIFE - (now - s.done) * (LIFE / LINGER)) : LIFE;
      while (s.pts.length && now - s.pts[0].t > life + (s.done >= 0 ? 0 : 0)) s.pts.shift();
      if (s.done >= 0 && now - s.done > LINGER) s.pts.length = 0;
      const n = s.pts.length, o = t * POINTS * 2;
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
        const p = s.pts[i], q = s.pts[Math.min(n - 1, i + 1)], r = s.pts[Math.max(0, i - 1)];
        _d.set(q.x - r.x, q.y - r.y, q.z - r.z).normalize();
        _v.set(p.x - camera.position.x, p.y - camera.position.y, p.z - camera.position.z);
        _s.crossVectors(_d, _v).normalize();
        // Width and fade: 0 at the tail (i = 0), full near the head; a landed trail fades overall.
        const f = i / (n - 1), fade = s.done >= 0 ? Math.max(0, 1 - (now - s.done) / LINGER) : 1;
        const w = s.w * (0.25 + 0.75 * f) * 0.5;
        _a.set(p.x, p.y, p.z);
        pos[k] = _a.x + _s.x * w; pos[k + 1] = _a.y + _s.y * w; pos[k + 2] = _a.z + _s.z * w;
        pos[k + 3] = _a.x - _s.x * w; pos[k + 4] = _a.y - _s.y * w; pos[k + 5] = _a.z - _s.z * w;
        const al = opacity * f * f * fade;
        col[c] = col[c + 4] = base.r; col[c + 1] = col[c + 5] = base.g; col[c + 2] = col[c + 6] = base.b;
        col[c + 3] = col[c + 7] = al;
      }
    }
    mesh.visible = any;
    if (any) { geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true; }
  }

  return { point, end, update, mesh, params: { SPACING, LIFE, LINGER } };
}
