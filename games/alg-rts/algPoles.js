// THE TELEGRAPH LINE — PTT poles along the pistes (you, 2026-10-01): the
// road read from far off, the 1950s in one line of poles.
//
// Every pole on the map is ONE instanced draw (rtsAlgeria.js
// buildTelegraphPole on the kit material; it casts its shadow), and every
// wire ONE draw of line segments (1 px: a real wire is thinner than a pixel at
// play zoom, and a line costs nothing). Built once at load; no per-frame work.
//
// A pole every ~42 m, 5.5 m off the track's centre on one side; where that
// spot is water, too steep or inside a building it slides along the track a
// little, or the line skips it (a long gap breaks the wire). The plants round
// each foot are cleared. ?poles=0 = without.
import * as THREE from "three";
import { buildTelegraphPole } from "../../v3/render/objects/rtsAlgeria.js";
import { TRACK_LINES } from "./algTracks.js";
import { kitView } from "./showroom.js";
import { PLAY } from "./layout.js";

// sagPerM: 2.6% of the span (1.1 m on 42 m: a PTT line hangs visibly); wireHalf:
// the ribbon half-width, drawn fat (a real wire is under a pixel at play zoom).
const P = { spacing: 42, offset: 5.5, start: 12, sagPerM: 0.026, segs: 16, wireHalf: 0.022, maxNormalTilt: 0.86 };

export function createAlgPoles(app, { navGrid = null } = {}) {
  const geo = buildTelegraphPole();
  const wiresLocal = geo.userData.wires;

  // ── Where: along each piste ──────────────────────────────────────────────
  const poles = [];   // { x, y, z, yaw, track, s }
  const okAt = (x, z) => {
    if (!(x > PLAY.x0 + 3 && x < PLAY.x1 - 3 && z > PLAY.z0 + 3 && z < PLAY.z1 - 3)) return false;
    const y = app.getWorldHeight(x, z);
    if ((app.getWaterLevelAt?.(x, z) ?? -Infinity) > y - 0.3) return false;
    if ((app.getWorldNormal?.(x, z)?.y ?? 1) < P.maxNormalTilt) return false;
    return !navGrid?.isBlockedAtWorld?.(x, z);
  };
  for (const t of TRACK_LINES) {
    if (t.kind !== "piste" || t.line.length < 3) continue;
    // Arc length along the resampled line.
    const L = t.line, acc = [0];
    for (let i = 1; i < L.length; i++) acc.push(acc[i - 1] + Math.hypot(L[i].x - L[i - 1].x, L[i].z - L[i - 1].z));
    const at = (s) => {
      let i = 1;
      while (i < L.length - 1 && acc[i] < s) i++;
      const f = (s - acc[i - 1]) / Math.max(1e-6, acc[i] - acc[i - 1]);
      const dx = L[i].x - L[i - 1].x, dz = L[i].z - L[i - 1].z, d = Math.hypot(dx, dz) || 1;
      return { x: L[i - 1].x + dx * f, z: L[i - 1].z + dz * f, tx: dx / d, tz: dz / d };
    };
    const total = acc[acc.length - 1];
    for (let s = P.start; s < total - 4; s += P.spacing) {
      // Try the spot, then a little either way along the track.
      for (const ds of [0, 6, -6, 12, -12]) {
        const q = at(Math.min(total, Math.max(0, s + ds)));
        // To the track's right (its normal), the same side all along.
        const x = q.x + q.tz * P.offset, z = q.z - q.tx * P.offset;
        if (!okAt(x, z)) continue;
        poles.push({ x, y: app.getWorldHeight(x, z) - 0.15, z, yaw: Math.atan2(q.tx, q.tz), track: t.name, s: s + ds });
        break;
      }
    }
  }

  // ── The poles: one InstancedMesh ─────────────────────────────────────────
  const material = kitView(geo).material;
  const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, poles.length));
  mesh.name = "TelegraphPoles";
  mesh.castShadow = mesh.receiveShadow = true;
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  poles.forEach((p, i) => {
    // A pole leans a degree or two, never quite plumb.
    q4.setFromAxisAngle(up, p.yaw).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler((Math.random() - 0.5) * 0.04, 0, (Math.random() - 0.5) * 0.04)));
    p.q = q4.clone();
    mesh.setMatrixAt(i, m4.compose(new THREE.Vector3(p.x, p.y, p.z), q4, one));
    app.clearVegetation?.(p.x, p.z, 1.3, { grass: 0 });
    // Solid: a tank drove through one (seen 2026-10-01). A 2 × 2 m block,
    // one nav cell — men and vehicles go round.
    navGrid?.addFootprint?.(p.x, p.z, 1, 1, p.yaw);
  });
  mesh.count = poles.length;
  mesh.computeBoundingSphere();
  app.scene.add(mesh);

  // ── The wires: one mesh of thin ribbons, hanging between neighbours ──────
  // They were 1 px GL lines with a 1.4% sag and read as ruled straight lines
  // (you, 2026-10-01). Now each wire is a CROSS of two ribbons (flat and
  // upright, so it reads from the RTS camera above and from a low view),
  // drawn FAT (the barbed wire's trick: a real 4 mm wire is under a pixel),
  // a visible sag that varies span to span, 16 segments a span. One draw.
  const pos = [], nrm = [], idx = [];
  const v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
  const tip = (p, k, out) => out.set(...wiresLocal[k]).applyQuaternion(p.q).add(v.set(p.x, p.y, p.z));
  const W = P.wireHalf;
  const ribbon = (pts, side, n) => {
    // A strip along `pts`, offset ±`side` (a unit vector), normal `n`.
    const base = pos.length / 3;
    for (const q of pts) {
      pos.push(q.x - side.x * W, q.y - side.y * W, q.z - side.z * W, q.x + side.x * W, q.y + side.y * W, q.z + side.z * W);
      nrm.push(n.x, n.y, n.z, n.x, n.y, n.z);
    }
    for (let j = 0; j < pts.length - 1; j++) {
      const o = base + j * 2;
      idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
    }
  };
  const UPV = new THREE.Vector3(0, 1, 0);
  let spans = 0;
  // Each span's run of indices (algTelegraph.js drops the wires of a felled pole's spans).
  const spanList = [];   // { a, b: pole indices, i0, i1: index range }
  for (let i = 1; i < poles.length; i++) {
    const p0 = poles[i - 1], p1 = poles[i];
    if (p0.track !== p1.track || p1.s - p0.s > P.spacing * 2.2) continue;    // a gap: the line breaks
    spans++;
    const i0 = idx.length;
    const span = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    const sag = span * P.sagPerM * (0.85 + ((i * 0.618) % 1) * 0.3);
    for (let k = 0; k < wiresLocal.length; k++) {
      tip(p0, k, a); tip(p1, k, b);
      const pts = [];
      for (let j = 0; j <= P.segs; j++) {
        const f = j / P.segs;
        pts.push(new THREE.Vector3(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f - sag * 4 * f * (1 - f), a.z + (b.z - a.z) * f));
      }
      const along = new THREE.Vector3().subVectors(b, a).setY(0).normalize();
      const flatSide = new THREE.Vector3().crossVectors(UPV, along).normalize();
      ribbon(pts, flatSide, UPV);                   // seen from above
      ribbon(pts, UPV, flatSide);                   // seen from the side
    }
    spanList.push({ a: i - 1, b: i, i0, i1: idx.length });
  }
  const wgeo = new THREE.BufferGeometry();
  wgeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  wgeo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  wgeo.setIndex(idx);
  wgeo.computeBoundingSphere();
  const wires = new THREE.Mesh(wgeo, new THREE.MeshStandardMaterial({ color: 0x2b2722, roughness: 0.55, metalness: 0.35, side: THREE.DoubleSide }));
  wires.name = "TelegraphWires";
  wires.castShadow = false;       // a hair-thin shadow is noise in the shadow map
  wires.receiveShadow = true;
  app.scene.add(wires);


  /** The spans' wires minus those of `hidden` (a Set of spanList entries): a rare rebuild (a pole felled / mended). */
  function setHiddenSpans(hidden) {
    const keep = [];
    let from = 0;
    for (const sp of spanList) {
      if (!hidden.has(sp)) continue;
      for (let k = from; k < sp.i0; k++) keep.push(idx[k]);
      from = sp.i1;
    }
    for (let k = from; k < idx.length; k++) keep.push(idx[k]);
    wgeo.setIndex(keep);
  }
  /** Pole `i` standing (true) or FELLED (lying across the verge, its foot where it stood). */
  function setStanding(i, standing) {
    const p = poles[i];
    if (standing) m4.compose(new THREE.Vector3(p.x, p.y, p.z), p.q, one);
    else {
      // Toppled away from the track about its own foot, a little skewed.
      // (About the track's tangent; negative = the top goes out to the verge, not onto the road.)
      const fall = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw)), -1.45);
      m4.compose(new THREE.Vector3(p.x, p.y + 0.12, p.z), fall.multiply(p.q), one);
    }
    // Through the static batch when the poles are in it (algGame.js batchStaticInstances).
    if (app.algStaticBatch) app.algStaticBatch.setMatrixAt(mesh, i, m4);
    else { mesh.setMatrixAt(i, m4); mesh.instanceMatrix.needsUpdate = true; }
  }

  return { poles, mesh, wires, spans, spanList, setHiddenSpans, setStanding, dispose() { app.scene.remove(mesh, wires); wgeo.dispose(); geo.dispose(); } };
}
