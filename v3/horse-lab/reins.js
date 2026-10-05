// ── Horse lab: reins ─────────────────────────────────────────────────────────
// The reins are ONE strap: left bit ring → left fist → a loop over the withers
// → right fist → right bit ring. It is simulated as a single verlet rope whose
// points are pinned wherever something holds it (bit rings, inside each fist),
// so it runs continuously through the hands instead of being separate pieces
// meeting at the fist (which showed a break and a shaky loop).
//
// Leather, not string: strong damping, and a bend constraint (points two apart
// may not come closer than a share of their rest span) so it drapes in smooth
// curves instead of kinking and jiggling. Points are pushed out of oval
// capsules along the horse's neck/withers so it lies on the horse.
import * as THREE from "three";

const V3 = THREE.Vector3;
const SIDES = 6;                         // tube cross-section vertices

export class Rein {
  constructor(scene, { n = 40, width = 0.022, thick = 0.008, color = 0x8a5a32 } = {}) {
    this.n = n;
    this.p = Array.from({ length: n }, () => new V3());
    this.q = Array.from({ length: n }, () => new V3());     // previous positions
    this.ready = false;
    this.width = width; this.thick = thick;
    this.damp = 0.955;                    // velocity kept per 1/120 s step
    this.stiff = 0.8;                     // bend: i↔i+2 span may not drop below this share
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * SIDES * 3), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(n * SIDES * 3), 3));
    const idx = [];
    for (let i = 0; i < n - 1; i++) for (let s = 0; s < SIDES; s++) {
      const a = i * SIDES + s, b = i * SIDES + (s + 1) % SIDES, c = a + SIDES, d = b + SIDES;
      idx.push(a, c, b, b, c, d);
    }
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.7 }));
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  // pins: [[index, V3], …] sorted by index; seg: rest length of each of the
  // n−1 segments; neck: [{ a, b, ra: [lat, vert], rb, lat }] oval capsules.
  step(dt, pins, seg, neck) {
    const n = this.n, P = this.p, Q = this.q;
    const pinned = new Map(pins);
    if (!this.ready || dt <= 0) {                            // start straight between the pins
      for (let k = 0; k < pins.length - 1; k++) {
        const [i0, a] = pins[k], [i1, b] = pins[k + 1];
        for (let i = i0; i <= i1; i++) { P[i].lerpVectors(a, b, (i - i0) / (i1 - i0)); Q[i].copy(P[i]); }
      }
      this.ready = true;
    }
    const sub = Math.min(8, Math.max(1, Math.ceil(dt / (1 / 120)))), h = dt / sub;
    const g = -9.8 * h * h, damp = Math.pow(this.damp, h * 120);
    const tmp = new V3(), ab = new V3(), cp = new V3(), vt = new V3();
    const w = (i) => (pinned.has(i) ? 0 : 1);
    for (let s = 0; s < sub; s++) {
      for (let i = 0; i < n; i++) {                            // integrate
        if (pinned.has(i)) continue;
        tmp.copy(P[i]);
        P[i].x += (P[i].x - Q[i].x) * damp;
        P[i].y += (P[i].y - Q[i].y) * damp + g;
        P[i].z += (P[i].z - Q[i].z) * damp;
        Q[i].copy(tmp);
      }
      for (const [i, p] of pins) { Q[i].copy(P[i]); P[i].copy(p); }
      for (let it = 0; it < 12; it++) {
        for (let i = 0; i < n - 1; i++) {                      // length (a rope only pulls)
          const d = tmp.subVectors(P[i + 1], P[i]), L = d.length() || 1e-6;
          if (L <= seg[i]) continue;
          const wa = w(i), wb = w(i + 1), sum = wa + wb;
          if (!sum) continue;
          const k = (L - seg[i]) / L;
          P[i].addScaledVector(d, k * wa / sum);
          P[i + 1].addScaledVector(d, -k * wb / sum);
        }
        for (let i = 0; i < n - 2; i++) {                      // leather resists folding
          const d = tmp.subVectors(P[i + 2], P[i]), L = d.length() || 1e-6;
          const min = (seg[i] + seg[i + 1]) * this.stiff;
          if (L >= min) continue;
          const wa = w(i), wb = w(i + 2), sum = wa + wb;
          if (!sum) continue;
          const k = (L - min) / L * 0.5;
          P[i].addScaledVector(d, k * wa / sum);
          P[i + 2].addScaledVector(d, -k * wb / sum);
        }
        if (neck) for (let i = 0; i < n; i++) {                // stay on the outside of the horse
          if (pinned.has(i)) continue;
          for (const sg of neck) {
            ab.subVectors(sg.b, sg.a);
            const t = tmp.subVectors(P[i], sg.a).dot(ab) / ab.lengthSq();
            if (t < 0 || t > 1) continue;
            cp.copy(sg.a).addScaledVector(ab, t);
            const d = tmp.subVectors(P[i], cp);
            vt.crossVectors(ab, sg.lat).normalize();
            const rl = sg.ra[0] + (sg.rb[0] - sg.ra[0]) * t, rv = sg.ra[1] + (sg.rb[1] - sg.ra[1]) * t;
            const dl = d.dot(sg.lat), dv = d.dot(vt);
            const e = (dl / rl) ** 2 + (dv / rv) ** 2;
            if (e < 1 && e > 1e-9) {
              const sc = 1 / Math.sqrt(e) - 1;
              P[i].addScaledVector(sg.lat, dl * sc).addScaledVector(vt, dv * sc);
            }
          }
        }
      }
    }
    this.draw();
  }

  draw() {
    const n = this.n, P = this.p;
    const pos = this.mesh.geometry.attributes.position, nor = this.mesh.geometry.attributes.normal;
    const t = new V3(), u = new V3(), w = new V3(), up = new V3(0, 1, 0), o = new V3(), nn = new V3();
    for (let i = 0; i < n; i++) {
      t.subVectors(P[Math.min(n - 1, i + 1)], P[Math.max(0, i - 1)]).normalize();
      u.crossVectors(t, up);
      if (u.lengthSq() < 1e-6) u.set(1, 0, 0);
      u.normalize();                              // flat side of the strap faces up
      w.crossVectors(u, t).normalize();
      for (let s = 0; s < SIDES; s++) {
        const a = (s / SIDES) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
        o.copy(u).multiplyScalar(c * this.width * 0.5).addScaledVector(w, sn * this.thick * 0.5);
        nn.copy(u).multiplyScalar(c / this.width).addScaledVector(w, sn / this.thick).normalize();
        const k = i * SIDES + s;
        pos.setXYZ(k, P[i].x + o.x, P[i].y + o.y, P[i].z + o.z);
        nor.setXYZ(k, nn.x, nn.y, nn.z);
      }
    }
    pos.needsUpdate = true; nor.needsUpdate = true;
  }

  setVisible(v) { this.mesh.visible = v; if (!v) this.ready = false; }
}
