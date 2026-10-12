// THE ORDER MARKS (you, 2026-10-03, from Company of Heroes screenshots): a
// right-click drops, over EACH SQUAD's spot (its middle man's; one a squad, as CoH 3 — 2026-10-12;
// it was one a man), FOUR small arrows
// in a ring, tilted like petals, all pointing in and down at the spot — they
// close in on it, hold, then shrink away. Flat and unlit, bright (not a lit
// 3D chevron, not a pulsing ring). Their colour is the COVER there, as CoH:
//   GREEN   heavy cover (a wall, sandbags, a bank: algCover ≥ HEAVY)
//   YELLOW  light cover or open ground
// An attack order: one red set over the target.
//
// THE PREVIEW (2026-10-07, "cover at the cursor"): the same marks, still and smaller, where each
// man WOULD stand while the cursor is over the ground (algCoverCursor.js) — and two more colours:
//   PALE    open ground (no cover)
//   CYAN    open but concealed (scrub: not seen)
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
  light: 0.1,      // … YELLOW from here (below: open)
  hidden: 0.3,     // concealment from which an open spot is CYAN
  spots: 64,
  previews: 48,
};

const COL = {
  heavy: new THREE.Color(0x6cf04e),
  light: new THREE.Color(0xffcc1a),
  attack: new THREE.Color(0xff4a2a),
  open: new THREE.Color(0xd8d2c0),
  hidden: new THREE.Color(0x4ee0e8),
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
  const max = (P.spots + P.previews) * 4;
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

  /**
   * ONE mark per SQUAD (you, 2026-10-12, from a CoH 3 video: "not for all the soldiers, only one
   * per squad"): [{ x, z, key }] → the squad's middle, snapped to its man's spot nearest it (a real
   * spot, so its cover colour is true). `key` = the squad (a man without one is his own).
   */
  function perSquad(spots) {
    const groups = new Map();
    for (const s of spots) { const g = groups.get(s.key); if (g) g.push(s); else groups.set(s.key, [s]); }
    const out = [];
    for (const g of groups.values()) {
      let mx = 0, mz = 0;
      for (const s of g) { mx += s.x; mz += s.z; }
      mx /= g.length; mz /= g.length;
      let best = g[0], bd = Infinity;
      for (const s of g) { const d = (s.x - mx) ** 2 + (s.z - mz) ** 2; if (d < bd) { bd = d; best = s; } }
      out.push(best);
    }
    return out;
  }

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
  /** The preview's four kinds (open and concealed told apart). */
  function previewKind(x, z) {
    const cv = app.algCover;
    const c = cv?.coverAt?.(x, z) ?? 0;
    if (c >= P.heavy) return "heavy";
    if (c >= P.light) return "light";
    return (cv?.concealmentAt?.(x, z) ?? 0) >= P.hidden ? "hidden" : "open";
  }
  let previewSpots = [];
  /** Show the preview at these spots ([{ x, z }]), or none ([] / null). */
  function preview(spots) {
    previewSpots = perSquad((spots ?? []).map((p) => ({ x: p.x, z: p.z, key: p.squad ?? p }))).slice(0, P.previews).map((p) => ({ x: p.x, z: p.z, y: app.getWorldHeight?.(p.x, p.z) ?? 0, col: COL[previewKind(p.x, p.z)] }));
  }

  /** Each frame (render side). */
  function frame(dt) {
    if (pending) {
      // Each man's end of route (set by now), else the order's point — one mark a squad.
      const ends = [];
      for (const u of pending.units) {
        if (!u.alive) continue;
        const r = u.route;
        const end = r?.length ? r[r.length - 1] : u.isAir ? { x: pending.x, z: pending.z } : null;
        if (end) ends.push({ x: end.x, z: end.z, key: u.squad ?? u });
      }
      for (const e of perSquad(ends)) add(e.x, e.z, coverKind(e.x, e.z));
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
    // The preview: still, square to the world, a little BIGGER than an order's (0.72 read as specks
    // at play zoom).
    const kp = P.size * 1.15, rp = P.rTo + 0.3;
    for (const m of previewSpots) {
      for (let q = 0; q < 4; q++) {
        const a = Math.PI / 4 + q * Math.PI / 2, ox = Math.cos(a), oz = Math.sin(a);
        Y.set(ox * ct, st, oz * ct);
        X.set(-oz, 0, ox);
        Z.crossVectors(X, Y);
        m4.makeBasis(X, Y, Z);
        sc.makeScale(kp, kp, kp);
        m4.multiply(sc);
        m4.setPosition(m.x + ox * rp, m.y + P.lift, m.z + oz * rp);
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

  return { params: P, order, preview, previewKind, frame, dispose() { app.scene.remove(mesh); mesh.geometry.dispose(); mat.dispose(); } };
}
