import * as THREE from "three";

/**
 * Swept "depth road" geometry — a thick drivable slab (top deck + side walls +
 * underside + kerb lips) swept along a 3D curve. Honors the curve's Y so the
 * road can climb into the sky and loop; banking leans the deck into turns.
 *
 * Validated in v2/spline-road-lab.html. Uses **rotation-minimizing frames**
 * (double-reflection, Wang et al.) instead of Frenet frames so vertical climbs
 * and loops don't twist or pinch.
 *
 * @param {THREE.Curve} curve  a 3D curve (centripetal CatmullRomCurve3 in v2)
 * @param {object} opts  { width, thickness, bank, bankSmooth, segments,
 *                         deckColor?, sideColor?, kerbColor? }
 * @returns {THREE.BufferGeometry} position + color + normal, indexed.
 *          `geo.userData.frames = { P, T, ups }` for debug / future colliders.
 */
export function buildSplineRoadGeometry(curve, opts) {
  const segs = Math.max(2, opts.segments | 0);
  const halfW = Math.max(0.1, opts.width) * 0.5;
  const thick = Math.max(0.05, opts.thickness);
  const bank = opts.bank ?? 0.6;
  const bankSmooth = THREE.MathUtils.clamp(opts.bankSmooth ?? 0.12, 0, 0.49);

  const deckColor = new THREE.Color(opts.deckColor ?? 0x2c3138);
  const sideColor = new THREE.Color(opts.sideColor ?? 0x6f757c);
  const kerbColor = new THREE.Color(opts.kerbColor ?? 0xd23b3b);

  const P = [];
  const T = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    P.push(curve.getPointAt(t));
    T.push(curve.getTangentAt(t).normalize());
  }

  // Initial up: world-up projected perpendicular to T0 (fallback if vertical).
  const up0 = new THREE.Vector3(0, 1, 0);
  if (Math.abs(up0.dot(T[0])) > 0.99) up0.set(1, 0, 0);
  up0.addScaledVector(T[0], -up0.dot(T[0])).normalize();

  // Rotation-minimizing frames (double reflection).
  const ups = [up0];
  const tmp = new THREE.Vector3();
  for (let i = 0; i < segs; i++) {
    const r0 = ups[i];
    const t0 = T[i];
    const t1 = T[i + 1];
    const v1 = tmp.copy(P[i + 1]).sub(P[i]);
    const c1 = v1.dot(v1) || 1e-8;
    const rL = r0.clone().addScaledVector(v1, (-2 / c1) * v1.dot(r0));
    const tL = t0.clone().addScaledVector(v1, (-2 / c1) * v1.dot(t0));
    const v2 = t1.clone().sub(tL);
    const c2 = v2.dot(v2) || 1e-8;
    const r1 = rL.addScaledVector(v2, (-2 / c2) * v2.dot(rL));
    r1.addScaledVector(t1, -r1.dot(t1)).normalize();
    ups.push(r1);
  }

  // Auto-bank roll from signed horizontal curvature, smoothed both directions.
  const roll = new Float32Array(segs + 1);
  const cross = new THREE.Vector3();
  for (let i = 1; i < segs; i++) {
    cross.crossVectors(T[i - 1], T[i]);
    roll[i] = THREE.MathUtils.clamp(cross.dot(ups[i]) * 40 * bank, -1.2, 1.2);
  }
  if (bankSmooth > 0) {
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i <= segs; i++) roll[i] += (roll[i - 1] - roll[i]) * bankSmooth;
      for (let i = segs - 1; i >= 0; i--) roll[i] += (roll[i + 1] - roll[i]) * bankSmooth;
    }
  }

  // Per-point manual roll (radians), interpolated by control-point fraction and
  // ADDED on top of auto-bank. Set the global `bank` to 0 for fully-manual roll
  // (banked walls, corkscrews, barrel rolls — roll can wind a full 360°+).
  const pr = opts.pointRolls;
  if (Array.isArray(pr) && pr.length >= 2) {
    for (let i = 0; i <= segs; i++) {
      const f = (i / segs) * (pr.length - 1);
      const i0 = Math.floor(f);
      const i1 = Math.min(pr.length - 1, i0 + 1);
      roll[i] += THREE.MathUtils.lerp(pr[i0] || 0, pr[i1] || 0, f - i0);
    }
  }

  // Oriented profile corners per ring.
  const topL = [];
  const topR = [];
  const botL = [];
  const botR = [];
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const q = new THREE.Quaternion();
  for (let i = 0; i <= segs; i++) {
    up.copy(ups[i]);
    right.crossVectors(T[i], up).normalize();
    if (roll[i] !== 0) {
      q.setFromAxisAngle(T[i], roll[i]);
      up.applyQuaternion(q);
      right.applyQuaternion(q);
    }
    const c = P[i];
    topL.push(c.clone().addScaledVector(right, -halfW));
    topR.push(c.clone().addScaledVector(right, halfW));
    botL.push(topL[i].clone().addScaledVector(up, -thick));
    botR.push(topR[i].clone().addScaledVector(up, -thick));
  }

  // Append a quad ribbon between edge `a` and edge `b` into a target buffer set.
  function makeStrip(tgt, a, b, color) {
    const base = tgt.pos.length / 3;
    for (let i = 0; i <= segs; i++) {
      tgt.pos.push(a[i].x, a[i].y, a[i].z);
      tgt.col.push(color.r, color.g, color.b);
      tgt.pos.push(b[i].x, b[i].y, b[i].z);
      tgt.col.push(color.r, color.g, color.b);
    }
    for (let i = 0; i < segs; i++) {
      const r0 = base + i * 2;
      const r1 = base + (i + 1) * 2;
      tgt.idx.push(r0, r0 + 1, r1 + 1, r0, r1 + 1, r1);
    }
  }
  function finalize(tgt) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(tgt.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(tgt.col, 3));
    g.setIndex(tgt.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  // ── Deck mesh (drive surface) ────────────────────────────────────────────
  const deck = { pos: [], col: [], idx: [] };
  makeStrip(deck, topL, topR, deckColor); // drivable deck
  makeStrip(deck, topR, botR, sideColor); // right wall
  makeStrip(deck, botR, botL, sideColor); // underside
  makeStrip(deck, botL, topL, sideColor); // left wall
  // Kerb lips along both deck edges.
  const lip = 0.12;
  const lipUp = 0.18;
  function kerb(edge, sign) {
    const inner = [];
    const outerTop = [];
    for (let i = 0; i <= segs; i++) {
      up.copy(ups[i]);
      right.crossVectors(T[i], up).normalize();
      if (roll[i] !== 0) {
        q.setFromAxisAngle(T[i], roll[i]);
        up.applyQuaternion(q);
        right.applyQuaternion(q);
      }
      inner.push(edge[i].clone());
      outerTop.push(edge[i].clone().addScaledVector(up, lipUp).addScaledVector(right, sign * lip));
    }
    makeStrip(deck, inner, outerTop, kerbColor);
  }
  kerb(topR, 1);
  kerb(topL, -1);
  const deckGeo = finalize(deck);
  deckGeo.userData.frames = { P, T, ups };

  // ── Side barriers (separate mesh → fed as chassis-collision solids) ───────
  // A low wall with real depth (box section) along each deck edge: inner face
  // flush with the edge, extruded outward by `depth` and up by `height`.
  let barrierGeo = null;
  const b = opts.barrier;
  if (b && b.enabled) {
    const barr = { pos: [], col: [], idx: [] };
    const bcol = new THREE.Color(b.color ?? 0x9aa3ad);
    const bh = Math.max(0.05, b.height ?? 0.7);
    const bd = Math.max(0.05, b.depth ?? 0.3);
    for (const [edge, sign] of [[topR, 1], [topL, -1]]) {
      const innerB = [];
      const outerB = [];
      const innerT = [];
      const outerT = [];
      for (let i = 0; i <= segs; i++) {
        up.copy(ups[i]);
        right.crossVectors(T[i], up).normalize();
        if (roll[i] !== 0) {
          q.setFromAxisAngle(T[i], roll[i]);
          up.applyQuaternion(q);
          right.applyQuaternion(q);
        }
        const ib = edge[i].clone(); // inner bottom (at the deck edge)
        const ob = edge[i].clone().addScaledVector(right, sign * bd); // outward by depth
        innerB.push(ib);
        outerB.push(ob);
        innerT.push(ib.clone().addScaledVector(up, bh));
        outerT.push(ob.clone().addScaledVector(up, bh));
      }
      makeStrip(barr, innerB, innerT, bcol); // inner face (toward the road)
      makeStrip(barr, innerT, outerT, bcol); // top
      makeStrip(barr, outerT, outerB, bcol); // outer face
    }
    barrierGeo = finalize(barr);
  }

  return { road: deckGeo, barrier: barrierGeo };
}

/**
 * Build the centripetal CatmullRom curve for a set of control points. Centripetal
 * (alpha 0.5) avoids the cusps / self-loops that the default "cardinal" type can
 * produce on unevenly-spaced points — keeps road curves clean and smooth.
 */
export function makeSplineRoadCurve(points, closed = false, tension = 0.5) {
  if (!points || points.length < 2) return null;
  return new THREE.CatmullRomCurve3(
    points.map((p) => (p.isVector3 ? p.clone() : new THREE.Vector3(p.x, p.y, p.z))),
    !!closed,
    "centripetal",
    tension,
  );
}
