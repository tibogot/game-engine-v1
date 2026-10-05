// ── Horse lab: stirrups ──────────────────────────────────────────────────────
// A leather strap of FIXED length hanging from each side of the saddle, with an
// iron at the bottom. A foot in the stirrup carries the iron (its tread under
// the ball of the foot, the strap pulled straight); a foot out of it leaves the
// iron to hang and swing as a damped pendulum, kept off the horse's side.
// The fixed length is the point: mounting now has to lift the foot to where a
// real stirrup is, instead of the old invisible "let-down" one.
import * as THREE from "three";

const V3 = THREE.Vector3;
const clamp = THREE.MathUtils.clamp;

export const STRAP = { len: 0.78 };   // long, like the reference: the foot reaches it from the ground   // × k; tunable (the lab panel and the tests change it)

// saddle frame: x = the horse's left, y = up (0 = saddle surface), z = forward
export function stirrupGeom(k) {
  return {
    hang: (s) => new V3(s * 0.33 * k, -0.06, 0.28),       // the stirrup bar: straight ABOVE the riding iron (measured: the ball of the foot at x 0.36, z 0.28)
    len: STRAP.len * k,                                    // strap + iron, hang point → tread (m)
    barrel: 0.24 * k,                                      // the iron is kept at least this far out (horse's side)
    ankleAboveTread: 0.09,
  };
}

export class Stirrups {
  constructor(scene, saddle, k) {
    this.S = saddle;
    this.k = k;
    this.g = stirrupGeom(k);
    this.STRAP = STRAP;           // live settings (tests reach them through here)
    const leather = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.75 });
    const iron = new THREE.MeshStandardMaterial({ color: 0x8c8f94, roughness: 0.35, metalness: 0.8 });
    this.side = [1, -1].map((s) => {
      const strap = new THREE.Mesh(new THREE.BoxGeometry(0.032, 1, 0.006), leather);
      const ring = new THREE.Group();
      // sized for a boot: ~13 cm across inside, ~15 cm tall, tread 8 cm deep
      const arch = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.009, 6, 16, Math.PI), iron);   // upper half-ring
      arch.scale.set(1, 2.1, 1);                               // taller than wide, like a real iron
      const tread = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.016, 0.08), iron);
      tread.position.y = -0.002;
      ring.add(arch, tread);
      for (const m of [strap, arch, tread]) { m.castShadow = true; m.receiveShadow = true; }
      scene.add(strap, ring);
      return { s, strap, ring, p: null, q: null, inW: 0 };   // p = tread centre (saddle frame), q = previous
    });
  }

  setVisible(v) { for (const sd of this.side) { sd.strap.visible = v; sd.ring.visible = v; } }

  // feet: [{ in: 0..1, ankle: world V3 | null, fwd: world V3, extra: m the strap is let down } for left, right]
  update(dt, feet) {
    this.g = stirrupGeom(this.k);  // strap length may have been changed
    const S = this.S, g = this.g;
    S.updateMatrixWorld(true);
    const toL = (w) => S.worldToLocal(w.clone());
    const sq = S.getWorldQuaternion(new THREE.Quaternion());
    const upW = new V3(0, 1, 0).applyQuaternion(sq);
    this.side.forEach((sd, i) => {
      const f = feet[i], H = g.hang(sd.s);
      if (!sd.p) { sd.p = H.clone().add(new V3(sd.s * 0.04, -g.len, 0)); sd.q = sd.p.clone(); }
      // free swing: verlet with gravity (in the saddle frame — the horse's
      // motion shows up as the hang point moving under it)
      const h = Math.min(dt, 1 / 30);
      if (h > 0) {
        const v = sd.p.clone().sub(sd.q).multiplyScalar(0.94);
        sd.q.copy(sd.p);
        sd.p.add(v).add(new V3(0, -9.8 * h * h, 0));
      }
      // foot in the stirrup: the tread sits under the ball of the foot
      sd.inW += ((f.in > 0.5 ? 1 : 0) - sd.inW) * (1 - Math.exp(-14 * dt));
      if (f.ankle && sd.inW > 0.01) {
        const tread = f.ball ? toL(f.ball.clone().addScaledVector(upW, -0.035)) : toL(f.ankle.clone().addScaledVector(upW, -g.ankleAboveTread).addScaledVector(f.fwd, 0.04));   // under the ball of the foot (sole)
        sd.p.lerp(tread, sd.inW);
      }
      // the strap cannot stretch, and the iron stays off the horse's side
      const d = sd.p.clone().sub(H), len = g.len + (f.extra ?? 0);
      if (d.length() > len) sd.p.copy(H).addScaledVector(d.normalize(), len);
      if (sd.p.x * sd.s < g.barrel && sd.p.y < -0.05) sd.p.x = sd.s * g.barrel;
      // draw: strap from the hang point to the top of the iron, iron upright along the strap
      const P = S.localToWorld(sd.p.clone()), Hw = S.localToWorld(H.clone());
      const dir = Hw.clone().sub(P).normalize();
      const top = P.clone().addScaledVector(dir, 0.07 * 2.1 + 0.01);   // top of the arch
      const sl = Math.max(0.01, Hw.distanceTo(top));
      sd.strap.position.copy(Hw).add(top).multiplyScalar(0.5);
      sd.strap.scale.set(1, sl, 1);
      const fwdW = new V3(0, 0, 1).applyQuaternion(sq);
      const x = new V3().crossVectors(dir, fwdW).normalize(), z = new V3().crossVectors(x, dir);
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, dir, z));
      sd.strap.quaternion.copy(q);
      sd.ring.position.copy(P);
      // the arch spans across the horse; the foot goes through it front to back
      sd.ring.quaternion.copy(q);
    });
  }

  // world position of a stirrup's tread (for feet that want to find it)
  treadWorld(i) { return this.S.localToWorld(this.side[i].p.clone()); }
}
