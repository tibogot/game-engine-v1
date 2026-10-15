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
//
// DETAIL (2026-10-16, you, CoH 3 ref assets-src/refs/coh3/mortar_fall_trail.png: "looks a bit too cheap…
// more like a trail of smoke and has more details"): a trail can ask for a baked SMOKE texture instead of
// the plain soft edge (a per-vertex weight, so the grenades' stays as it was): ragged, wavering edges,
// wisps of thicker and thinner smoke along it, a lit upper edge and a shaded lower one; anchored to the
// smoke (v = the distance flown when that bit was left), so the detail does not slide; and a waviness
// that grows with age.
import * as THREE from "three";
import { attribute, mix, texture, uv as uvNode, vec2, vec3 } from "three/tsl";
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

/** Tileable value noise (period `P` cells in both axes), fbm of 3 octaves, 0..1. */
function fbm2(x, y, P, seed) {
  const h = (i, j) => { let n = (((i % P) + P) % P) * 374761393 + (((j % P) + P) % P) * 668265263 + seed * 1442695041; n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
  const sm = (t) => t * t * (3 - 2 * t);
  const vn = (x, y, P) => {
    const i = Math.floor(x), j = Math.floor(y), fx = sm(x - i), fy = sm(y - j);
    const a = h(i, j), b = h(i + 1, j), c = h(i, j + 1), d = h(i + 1, j + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  let v = 0, amp = 0.55, tot = 0;
  for (let o = 0; o < 3; o++) { const f = 1 << o; v += amp * vn(x * f, y * f, P * f); tot += amp; amp *= 0.5; }
  return v / tot;
}
/**
 * The smoke streak, across (u: 0 = the upper, lit edge … 1 = the lower) × along (v, tiles every
 * DETAIL_LEN m). RGB: its light (×1.25 in the shader); A: its density.
 */
const DETAIL_LEN = 6;
function smokeTexture() {
  const W = 64, H = 256, d = new Uint8Array(W * H * 4), P = 8;
  for (let y = 0; y < H; y++) {
    const t = (y / H) * P;
    // The edges waver, each its own way; the core wanders a little.
    const eUp = 0.62 + 0.38 * fbm2(t, 0.5, P, 11), eDn = 0.62 + 0.38 * fbm2(t, 2.5, P, 23), c = (fbm2(t, 4.5, P, 37) - 0.5) * 0.3;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W * 2 - 1, X = u - c, r = Math.abs(X) / (X < 0 ? eUp : eDn);
      const core = Math.exp(-r * r * 2.6) * (1 - Math.min(1, Math.max(0, (r - 0.8) / 0.2)));
      const wisp = fbm2(t * 1.6, (u + 1) * 2.2, P, 51);                  // denser and thinner bits
      const a = Math.min(1, Math.max(0, core * (0.35 + wisp * 1.1)));
      // Lit from above: the upper edge brighter, the lower shaded, the wisps' own bumps.
      const l = Math.min(1, Math.max(0, (0.82 - X * 0.3 + (fbm2(t * 2, (u + 1) * 3, P, 77) - 0.5) * 0.35) / 1.25));
      const i = (y * W + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = Math.round(l * 255); d[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(d, W, H, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping; tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

export function createArcTrails(scene, { width = 0.2, color = 0xf2eee6, opacity = 0.62 } = {}) {
  const V = TRAILS * POINTS * 2;
  const pos = new Float32Array(V * 3), col = new Float32Array(V * 4), uv = new Float32Array(V * 2), det = new Float32Array(V);
  const idx = [];
  for (let t = 0; t < TRAILS; t++) for (let i = 0; i < POINTS - 1; i++) {
    const a = (t * POINTS + i) * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  for (let v = 0; v < V; v++) uv[v * 2] = v & 1;          // across the strip: 0 | 1
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("aDetail", new THREE.BufferAttribute(det, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(idx);
  // The plain soft edge (grenades) or the smoke texture (a trail with `detail`), by the vertex weight.
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const vc = attribute("color", "vec4"), dw = attribute("aDetail", "float");
  const edge = texture(edgeTexture(), vec2(uvNode().x, 0.5)).r;
  const smoke = texture(smokeTexture(), uvNode());
  mat.colorNode = vc.rgb.mul(mix(vec3(1), smoke.rgb.mul(1.25), dw));
  mat.opacityNode = vc.a.mul(mix(edge, smoke.a, dw));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = RENDER_ORDER.TRACERS;   // (a streak in the air, with the tracers: over the smoke)
  mesh.name = "ArcTrails";
  mesh.visible = false;
  scene.add(mesh);
  const base = new THREE.Color(color);
  const HOT = new THREE.Color(2.2, 1.6, 0.75);   // linear, over 1: glows

  const slots = Array.from({ length: TRAILS }, () => ({ owner: null, pts: [], done: -1, w: width, detail: 0, dist: 0 }));
  const map = new Map();   // owner (a shell record) → slot

  /** Where `owner` (a shell) is now; `scale`: its width × (a smoke can's thicker). `life`: s a bit of
   *  the streak lives (a mortar bomb's: only the last stretch of its fall); `hot`: s of age a bit
   *  GLOWS (warm yellow-white behind a mortar bomb, cooling to smoke — CoH 3's); `detail` 0..1: the
   *  smoke texture and its waviness (DETAIL above). */
  function point(owner, x, y, z, now, scale = 1, { life = LIFE, hot = 0, detail = 0 } = {}) {
    let s = map.get(owner);
    if (!s) {
      s = slots.find((q) => !q.owner && !q.pts.length) ?? slots.reduce((a, b) => (a.pts.length < b.pts.length ? a : b));
      if (s.owner) map.delete(s.owner);
      s.owner = owner; s.pts.length = 0; s.done = -1; s.w = width * scale; s.life = life; s.hot = hot; s.detail = detail; s.dist = Math.random() * DETAIL_LEN;
      const a = Math.random() * Math.PI * 2;
      s.wx = Math.cos(a); s.wz = Math.sin(a); s.ph = Math.random() * 6.3; s.k = 0;
      map.set(owner, s);
    }
    const last = s.pts[s.pts.length - 1];
    if (!last || s.pts.length < 2 || Math.hypot(x - s.pts[s.pts.length - 2].x, y - s.pts[s.pts.length - 2].y, z - s.pts[s.pts.length - 2].z) >= SPACING) {
      // Each bit its own density (puffs along the streak); the drift is the streak's wind, swaying.
      const sw = 0.6 + 0.4 * Math.sin(s.k++ * 0.35 + s.ph);
      if (last) s.dist += Math.hypot(x - last.x, y - last.y, z - last.z);
      s.pts.push({ x, y, z, t: now, n: 0.6 + Math.random() * 0.6, dx: s.wx * sw, dz: s.wz * sw, sd: s.dist });
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
      else while (s.pts.length && now - s.pts[0].t > (s.life ?? LIFE)) s.pts.shift();
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
        if (s.detail > 0) {
          // The texture's lit edge (u 0, the +_s side) on top; the smoke waves more as it ages.
          if (_s.y < 0) _s.negate();
          // (slow, uneven: two waves read as a wriggling snake)
          const wob = (Math.sin(p0.sd * 0.45 + s.ph) * 0.55 + Math.sin(p0.sd * 1.13 + s.ph * 2) * 0.3 + Math.sin(p0.sd * 2.9 + s.ph * 3) * 0.15) * Math.min(1, age * 1.1) * s.w * 0.4 * s.detail;
          p.addScaledVector(_s, wob);
        }
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
        // A hot head: the freshest bit glows (above 1: the bloom catches it) and is denser, cooling.
        const h = s.hot > 0 ? 1 - THREE.MathUtils.smoothstep(age, 0, s.hot) : 0;
        const al = Math.min(1, opacity * thin * tail * head * fade * nn * (1 + h * 0.8));
        col[c] = col[c + 4] = base.r + (HOT.r - base.r) * h; col[c + 1] = col[c + 5] = base.g + (HOT.g - base.g) * h; col[c + 2] = col[c + 6] = base.b + (HOT.b - base.b) * h;
        col[c + 3] = col[c + 7] = al;
        const vi = o + i * 2;
        uv[vi * 2 + 1] = uv[vi * 2 + 3] = p0.sd / DETAIL_LEN;
        det[vi] = det[vi + 1] = s.detail;
      }
    }
    mesh.visible = any;
    if (any) { geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true; geo.attributes.uv.needsUpdate = true; geo.attributes.aDetail.needsUpdate = true; }
  }

  return { point, end, update, mesh, params: { SPACING, LIFE, LINGER, SPREAD } };
}
