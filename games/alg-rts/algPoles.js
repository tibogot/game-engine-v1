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

const P = { spacing: 42, offset: 5.5, start: 12, sagPerM: 0.014, segs: 10, maxNormalTilt: 0.86 };

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

  // ── The wires: one LineSegments, sagging between neighbours ──────────────
  const pts = [];
  const v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
  const tip = (p, k, out) => out.set(...wiresLocal[k]).applyQuaternion(p.q).add(v.set(p.x, p.y, p.z));
  for (let i = 1; i < poles.length; i++) {
    const p0 = poles[i - 1], p1 = poles[i];
    if (p0.track !== p1.track || p1.s - p0.s > P.spacing * 2.2) continue;    // a gap: the line breaks
    const span = Math.hypot(p1.x - p0.x, p1.z - p0.z), sag = span * P.sagPerM;
    for (let k = 0; k < wiresLocal.length; k++) {
      tip(p0, k, a); tip(p1, k, b);
      for (let j = 0; j < P.segs; j++) {
        const f0 = j / P.segs, f1 = (j + 1) / P.segs;
        for (const f of [f0, f1]) pts.push(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f - sag * 4 * f * (1 - f), a.z + (b.z - a.z) * f);
      }
    }
  }
  const wgeo = new THREE.BufferGeometry();
  wgeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const wires = new THREE.LineSegments(wgeo, new THREE.LineBasicMaterial({ color: 0x24211d }));
  wires.name = "TelegraphWires";
  wires.frustumCulled = true;
  app.scene.add(wires);

  return { poles, mesh, wires, dispose() { app.scene.remove(mesh, wires); wgeo.dispose(); geo.dispose(); } };
}
