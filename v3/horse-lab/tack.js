// ── Horse lab: the saddle (procedural, fitted to the Quaternius horse) ───────
// The armored horse's saddle did not suit this low-poly horse (another body,
// another style), so the saddle is built here, ON this horse's back: every
// vertex is placed a set thickness above the skin, found by casting a ray at
// the barrel's axis — so it sits on the back and wraps the ribs, whatever the
// horse's shape. Low-poly and flat-shaded like the horse.
//
//   pad      saddle cloth, dark red, the widest layer
//   seat     the tree + seat: low in the middle, pommel in front, cantle behind
//   flaps    one per side, down the ribs under the rider's thigh; the stirrup
//            leathers come out from under the skirt at their top (stirrups.js
//            hang point) and hang outside them
//   girth    the strap round the belly that holds it all
//
// It hangs on the rider's saddle frame (Torso2 bone): x = the horse's left,
// y = up (0 = the seat), z = forward.
import * as THREE from "three";

const V3 = THREE.Vector3;
const DEG = Math.PI / 180;
const smooth = (u) => { u = Math.min(1, Math.max(0, u)); return u * u * (3 - 2 * u); };

export const SADDLE = {
  axisY: -0.24,          // the barrel's axis under the saddle (back 0.05, belly −0.53)
  seatZ: [-0.24, 0.30],  // seat length (m, × k): the cantle rises just behind the rider
  padZ: [-0.34, 0.38],
  seatT: 0.025,          // seat leather above the pad at its lowest point
  pommel: 0.09,          // extra height of the pommel (front) …
  cantle: 0.11,          // … and of the cantle (back)
};

export class Tack {
  constructor(horse, rider) {
    this.rider = rider;
    const S = rider.saddle, k = rider.k, P = SADDLE;
    horse.rig.updateMatrixWorld(true);
    const meshes = [];
    horse.model.traverse((o) => o.isSkinnedMesh && meshes.push(o));
    const ray = new THREE.Raycaster();
    // skin radius from the axis at (z, angle): angle 0 = straight up, + = the horse's left
    const cache = new Map();
    const skin = (z, a) => {
      const key = `${z.toFixed(3)}:${a.toFixed(3)}`;
      if (cache.has(key)) return cache.get(key);
      const d = new V3(Math.sin(a), Math.cos(a), 0);
      const c = new V3(0, P.axisY, z), o = c.clone().addScaledVector(d, 1.5);
      const ow = S.localToWorld(o.clone()), cw = S.localToWorld(c.clone());
      ray.set(ow, cw.sub(ow).normalize()); ray.far = 1.5;
      const hit = ray.intersectObjects(meshes, false)[0];
      const r = hit ? S.worldToLocal(hit.point.clone()).sub(new V3(0, P.axisY, 0)).setZ(0).length() : 0.2;
      cache.set(key, r);
      return r;
    };
    const at = (z, a, off) => { const r = skin(z, a) + off; return new V3(Math.sin(a) * r, P.axisY + Math.cos(a) * r, z); };

    // A slab conformed to the body: a (z × angle) grid, `top` and `bot`
    // thickness above the skin, closed round its border so it has an edge.
    // aRange(u) → [aLo, aHi] for u ∈ 0..1 along z (lets the outline be shaped).
    const slab = ({ z0, z1, aRange, top, bot, nz, na }) => {
      const T = [], Bt = [];
      for (let i = 0; i <= nz; i++) {
        const u = i / nz, z = (z0 + (z1 - z0) * u) * k, [lo, hi] = aRange(u);
        for (let j = 0; j <= na; j++) {
          const v = j / na, a = lo + (hi - lo) * v;
          T.push(at(z, a, top(u, v, a))); Bt.push(at(z, a, bot));
        }
      }
      const pos = [], tri = (a, b, c) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      const id = (i, j) => i * (na + 1) + j;
      for (let i = 0; i < nz; i++) for (let j = 0; j < na; j++) {
        const a = id(i, j), b = id(i + 1, j), c = id(i + 1, j + 1), d = id(i, j + 1);
        tri(T[a], T[b], T[c]); tri(T[a], T[c], T[d]);       // top (faces out)
      }
      // border: walk the grid outline, a wall from top down to bottom
      const ring = [];
      for (let j = 0; j <= na; j++) ring.push(id(0, j));
      for (let i = 1; i <= nz; i++) ring.push(id(i, na));
      for (let j = na - 1; j >= 0; j--) ring.push(id(nz, j));
      for (let i = nz - 1; i >= 1; i--) ring.push(id(i, 0));
      for (let n = 0; n < ring.length; n++) {
        const a = ring[n], b = ring[(n + 1) % ring.length];
        tri(T[a], Bt[a], Bt[b]); tri(T[a], Bt[b], T[b]);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();                              // non-indexed: flat, faceted like the horse
      return g;
    };

    const mat = (color, rough = 0.8) => new THREE.MeshStandardMaterial({ color, roughness: rough, flatShading: true, side: THREE.DoubleSide });
    const leather = mat(0x5e3a22, 0.65), cloth = mat(0x7d2a24, 0.95), dark = mat(0x3b2618, 0.7);
    this.group = new THREE.Group();
    const add = (g, m) => { const x = new THREE.Mesh(g, m); x.castShadow = x.receiveShadow = true; this.group.add(x); return x; };

    // pad: rounded at its four lower corners (narrower in angle near the ends)
    add(slab({
      z0: P.padZ[0], z1: P.padZ[1], nz: 10, na: 16,
      aRange: (u) => { const r = 1 - 0.22 * (1 - smooth(Math.min(u, 1 - u) / 0.18)); return [-112 * DEG * r, 112 * DEG * r]; },
      top: () => 0.014, bot: 0.002,
    }), cloth);
    // seat: thickness = leather + pommel / cantle, highest on the spine
    const sT = P.seatT;
    add(slab({
      z0: P.seatZ[0], z1: P.seatZ[1], nz: 12, na: 10,
      aRange: (u) => { const w = 52 - 14 * smooth((u - 0.75) / 0.25) - 10 * smooth((0.2 - u) / 0.2); return [-w * DEG, w * DEG]; },
      top: (u, v, a) => {
        const mid = Math.cos(a * 1.6) ** 2;                    // full on the spine, falling off down the sides
        const front = smooth((u - 0.78) / 0.22) * P.pommel, back = smooth((0.3 - u) / 0.3) * P.cantle;
        const dip = 0.014 + sT + (front + back) * (0.35 + 0.65 * mid);
        return 0.014 + (dip - 0.014) * (0.45 + 0.55 * Math.cos(a * 1.3));
      },
      bot: 0.014,
    }), leather);
    // flaps: on the forward half, slanting forward at the bottom (under the knee)
    for (const s of [1, -1]) {
      add(slab({
        z0: -0.06, z1: 0.32, nz: 6, na: 8,
        aRange: () => (s > 0 ? [40 * DEG, 104 * DEG] : [-104 * DEG, -40 * DEG]),
        top: () => 0.03, bot: 0.016,
      }), leather);
    }
    // girth: under the belly from flap to flap
    add(slab({ z0: 0.14, z1: 0.22, nz: 1, na: 14, aRange: () => [100 * DEG, 260 * DEG], top: () => 0.024, bot: 0.006 }), dark);

    S.add(this.group);
    this.fit = { seatTop: +at(0, 0, 0.014 + sT).y.toFixed(3), backAt0: +(skin(0, 0) + P.axisY).toFixed(3), flapOuterAtBar: +(at(0.18 * k, 58 * DEG, 0.03).x).toFixed(3) };
  }

  setVisible(v) { this.group.visible = v; }
}
