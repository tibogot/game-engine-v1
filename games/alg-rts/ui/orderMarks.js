// THE ORDER MARKS (you, 2026-10-03, from Company of Heroes screenshots): a
// right-click drops, over the spot EACH MAN will stand on, FOUR small arrows
// in a ring, tilted like petals, all pointing in and down at the spot — they
// close in on it, hold, then shrink away. Flat and unlit, bright (not a lit
// 3D chevron, not a pulsing ring). Their colour is the COVER there, as CoH:
//   GREEN   heavy cover (a wall, sandbags, a bank: algCover ≥ HEAVY)
//   YELLOW  light cover or open ground
// An attack order: one red set over the target.
//
// ONE instanced mesh (4 arrows x 64 spots), opaque: the ground and the walls
// hide it where they should, and it needs no see-through draw order.
import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";

const P = {
  life: 1.6,       // s a mark stays
  close: 0.22,     // s of the arrows closing in
  out: 0.25,       // s of the shrink at the end
  rFrom: 1.1,      // m from the spot the arrows start …
  rTo: 0.32,       // … and where their tips stop
  lift: 0.12,      // m over the ground at the tips
  tilt: 0.55,      // rad: the arrows' lean (0 = flat on the ground, π/2 = upright; 0.75 showed the far ones edge-on)
  size: 0.5,       // m, an arrow's length
  heavy: 0.45,     // algCover's cover from which a spot is GREEN
  spots: 64,
};

const COL = {
  heavy: new THREE.Color(0x6cf04e),
  light: new THREE.Color(0xffcc1a),
  attack: new THREE.Color(0xff4a2a),
};

/** A flat arrow, tip at the origin, its body along +Y (length 1). */
function arrowGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(0.42, 0.55);
  s.lineTo(0.15, 0.55);
  s.lineTo(0.15, 1);
  s.lineTo(-0.15, 1);
  s.lineTo(-0.15, 0.55);
  s.lineTo(-0.42, 0.55);
  s.closePath();
  return new THREE.ShapeGeometry(s);
}

/**
 * @param {object} o
 * @param {object} o.app   (scene, getWorldHeight, algCover)
 */
export function createOrderMarks({ app }) {
  const mat = new MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
  const max = P.spots * 4;
  const mesh = new THREE.InstancedMesh(arrowGeometry(), mat, max);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.name = "OrderMarks";
  for (let i = 0; i < max; i++) mesh.setColorAt(i, COL.light);
  app.scene.add(mesh);

  const marks = [];      // { x, y, z, t, col, a0 }
  let pending = null;    // the men of the last order: their spots are read next frame (the paths are set after the marker)
  const m4 = new THREE.Matrix4(), sc = new THREE.Matrix4();
  const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();

  function add(x, z, kind) {
    if (marks.length >= P.spots) return;
    marks.push({ x, y: app.getWorldHeight?.(x, z) ?? 0, z, t: 0, col: COL[kind], a0: Math.random() * Math.PI / 2 });
  }

  /** The selection's hook: an order given (x, y, z, the men, "move" | "attack" | …). */
  function order(x, y, z, units, kind = "move") {
    marks.length = 0;
    if (kind === "attack") { add(x, z, "attack"); return; }
    pending = { units: units.filter((u) => !u.isStructure), x, z };
    if (!pending.units.length) { add(x, z, "light"); pending = null; }
  }

  function coverKind(x, z) {
    const c = app.algCover?.coverAt?.(x, z) ?? 0;
    return c >= P.heavy ? "heavy" : "light";
  }

  /** Each frame (render side). */
  function frame(dt) {
    if (pending) {
      // Each man's end of route (set by now), else the order's point.
      for (const u of pending.units) {
        if (!u.alive) continue;
        const r = u.route;
        const end = r?.length ? r[r.length - 1] : u.isAir ? { x: pending.x, z: pending.z } : null;
        if (end) add(end.x, end.z, coverKind(end.x, end.z));
      }
      if (!marks.length) add(pending.x, pending.z, coverKind(pending.x, pending.z));
      pending = null;
    }
    let n = 0;
    const ct = Math.cos(P.tilt), st = Math.sin(P.tilt);
    for (let i = marks.length - 1; i >= 0; i--) {
      const m = marks[i];
      m.t += dt;
      if (m.t >= P.life) { marks.splice(i, 1); continue; }
      // Closing in (ease out), then a small in-and-out pulse; shrink at the end.
      const c = Math.min(1, m.t / P.close), ease = 1 - (1 - c) ** 3;
      const r = P.rFrom + (P.rTo - P.rFrom) * ease + Math.sin(m.t * 9) * 0.04 * c;
      const k = Math.min(1, (P.life - m.t) / P.out) * P.size;
      for (let q = 0; q < 4; q++) {
        const a = m.a0 + q * Math.PI / 2;
        const ox = Math.cos(a), oz = Math.sin(a);
        // The arrow's body runs outward and up from its tip (Y); X along the
        // ring; Z the face's normal — a petal of a cone round the spot.
        Y.set(ox * ct, st, oz * ct);
        X.set(-oz, 0, ox);
        Z.crossVectors(X, Y);
        m4.makeBasis(X, Y, Z);
        sc.makeScale(k, k, k);
        m4.multiply(sc);
        m4.setPosition(m.x + ox * r, m.y + P.lift, m.z + oz * r);
        mesh.setMatrixAt(n, m4);
        mesh.setColorAt(n, m.col);
        n++;
      }
    }
    if (n || mesh.count) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  return { params: P, order, frame, dispose() { app.scene.remove(mesh); mesh.geometry.dispose(); mat.dispose(); } };
}
