// THE PROJECTEUR WORKS (you, 2026-09-29: "cool, but it should work as a
// projecteur"). Every searchlight tower — pre-placed or built by a sapper —
// sweeps its arc and LOCKS onto an ALN man it finds; where its pool of light
// lands, men are SPOTTED: concealment beaten (cover.js reveal — scrub hides
// nobody in the light) and the ground seen through the fog of war.
//
// No real light (a shadowed spotlight costs a full shadow pass): the beam is
// an additive cone, the pool an additive disc on the ground, both unlit and
// without depth write — two tiny draws per tower. Faint by day, bright at
// dusk and night (the sun's elevation).
import * as THREE from "three";
import { float, mix, normalView, positionGeometry, smoothstep, uniform, uv, vec3 } from "three/tsl";

const RANGE = 75;          // m: how far the beam reaches / finds a man
const POOL_R = 6;          // m: the pool of light
const SWEEP = 1.1;         // rad either side of the tower's front
const SWEEP_SPEED = 0.35;  // rad/s
const TRACK_SPEED = 1.6;   // rad/s: turning onto a man

/** A unit cone along +Z from 0 (radius 0) to 1 (radius 1), open ends. */
function coneGeometry() {
  const g = new THREE.CylinderGeometry(1, 0.001, 1, 20, 1, true);
  g.translate(0, 0.5, 0);
  g.rotateX(Math.PI / 2);
  return g;
}

export function createAlgSearchlights(app, { structures, units, cover = null }) {
  // Intensity: 1 at night, ~0.12 in full sun (a lamp by day barely shows).
  const uGlow = uniform(0.15);
  const warm = vec3(1.0, 0.93, 0.78);

  // The beam: brightest at the lamp, fading along its length; the cone's
  // edge softer than its axis (the side walls seen edge-on read as a glow).
  const beamMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
  beamMat.name = "SearchlightBeam";
  beamMat.colorNode = warm;
  // Seen edge-on (the cone's silhouette) it fades out: without that the beam
  // read as a solid wedge with hard edges (2026-09-29).
  const faceOn = normalView.z.abs().pow(1.5);
  beamMat.opacityNode = uGlow.mul(0.16).mul(faceOn).mul(float(1).sub(smoothstep(0.1, 1.0, positionGeometry.z)));
  // The pool: a soft disc, brightest at its heart.
  const poolMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  poolMat.name = "SearchlightPool";
  poolMat.colorNode = warm;
  const r = uv().sub(0.5).length().mul(2);
  poolMat.opacityNode = uGlow.mul(mix(float(0.55), float(0), smoothstep(0.35, 1.0, r)));
  const cone = coneGeometry();
  const disc = new THREE.CircleGeometry(1, 28);

  const lights = [];   // { rec, lamp, beam, pool, yaw0, yaw, pitch, target, t, at }
  const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _z = new THREE.Vector3(0, 0, 1);

  function adopt(rec) {
    const lamp = rec.mesh.getObjectByName("Lamp");
    if (!lamp) return;
    lamp.rotation.order = "YXZ";
    const beam = new THREE.Mesh(cone, beamMat);
    const pool = new THREE.Mesh(disc, poolMat);
    beam.frustumCulled = pool.frustumCulled = false;
    beam.renderOrder = pool.renderOrder = 4;
    app.scene.add(beam, pool);
    const L = { rec, lamp, beam, pool, yaw: 0, pitch: 0, target: null, t: Math.random() * 10, at: new THREE.Vector3(), beamAt: rec.mesh.geometry.userData.lamp?.beam ?? [0, 0.8, 0] };
    lights.push(L);
  }

  /** Searchlights appear as sappers finish them: look for new ones now and then. */
  let scanT = 0;
  function scan() {
    for (const rec of structures.records) {
      if (rec.s.typeKey !== "searchlight" || lights.some((l) => l.rec === rec)) continue;
      adopt(rec);
    }
  }

  /** Fixed clock: sweep, find, lock, reveal. */
  function step(dt) {
    if ((scanT -= dt) <= 0) { scanT = 1; scan(); }
    for (const L of lights) {
      const s = L.rec.s, m = L.rec.mesh;
      if (!s.alive) { L.target = null; continue; }
      const px = m.position.x, pz = m.position.z;
      // Keep the man it has while he is in range; else the nearest in range.
      if (L.target && (!L.target.alive || Math.hypot(L.target.position.x - px, L.target.position.z - pz) > RANGE)) L.target = null;
      if (!L.target) {
        let best = null, bd = RANGE;
        for (const u of units.list) {
          if (!u.alive || u.team === s.team || u.isAir) continue;
          const d = Math.hypot(u.position.x - px, u.position.z - pz);
          if (d < bd) { bd = d; best = u; }
        }
        // It finds a man only when the sweep passes near him (not through walls
        // of scrub by magic): within 0.35 rad of where the beam points.
        if (best) {
          const want = Math.atan2(-(best.position.x - px), -(best.position.z - pz)) - m.rotation.y;
          const off = Math.atan2(Math.sin(want - L.yaw), Math.cos(want - L.yaw));
          if (Math.abs(off) < 0.35) L.target = best;
        }
      }
      let wantYaw, dist;
      if (L.target) {
        const dx = L.target.position.x - px, dz = L.target.position.z - pz;
        wantYaw = Math.atan2(-dx, -dz) - m.rotation.y;    // the lamp's front is its local -Z
        dist = Math.hypot(dx, dz);
      } else {
        L.t += dt;
        wantYaw = Math.sin(L.t * SWEEP_SPEED) * SWEEP;
        dist = RANGE * (0.6 + 0.25 * Math.sin(L.t * 0.23));
      }
      const d = Math.atan2(Math.sin(wantYaw - L.yaw), Math.cos(wantYaw - L.yaw));
      L.yaw += Math.max(-TRACK_SPEED * dt, Math.min(TRACK_SPEED * dt, d));
      L.dist = L.dist == null ? dist : L.dist + (dist - L.dist) * Math.min(1, dt * 2);
      // Where the pool lands, on the ground.
      const wy = m.rotation.y + L.yaw;
      L.at.set(px - Math.sin(wy) * L.dist, 0, pz - Math.cos(wy) * L.dist);
      L.at.y = app.getWorldHeight(L.at.x, L.at.z);
      // Everyone in the light is SPOTTED.
      for (const u of units.list) {
        if (!u.alive || u.team === s.team || u.isAir) continue;
        if (Math.hypot(u.position.x - L.at.x, u.position.z - L.at.z) < POOL_R) cover?.reveal?.(u);
      }
    }
  }

  /** Every frame: the lamp's aim, the beam and the pool; the glow by the sun. */
  function frame() {
    const sy = app.environment?.getLightDirection?.()?.y ?? 0.6;
    uGlow.value = 0.12 + 0.88 * (1 - THREE.MathUtils.smoothstep(sy, 0.02, 0.35));
    for (const L of lights) {
      const on = L.rec.s.alive && L.rec.mesh.visible && !!L.rec.mesh.parent;
      L.beam.visible = L.pool.visible = on;
      if (!on) continue;
      const m = L.rec.mesh;
      // The drum tips down to the pool.
      m.updateMatrixWorld(true);
      L.lamp.rotation.y = L.yaw;
      const o = m.localToWorld(_v.set(...L.beamAt));
      L.lamp.rotation.x = -Math.atan2(o.y - L.at.y, Math.max(1, L.dist));
      // The beam: from the lens to the pool, its far radius the pool's.
      const len = o.distanceTo(L.at);
      L.beam.position.copy(o);
      L.beam.lookAt(L.at);
      // (the cone is ~0 wide at the lamp: its first metres read as the lens)
      L.beam.scale.set(POOL_R * 0.8, POOL_R * 0.8, len);
      // The pool: on the ground, turned to its slope, lifted off it a little.
      const nr = app.getWorldNormal?.(L.at.x, L.at.z);
      _n.set(nr?.x ?? 0, nr?.y ?? 1, nr?.z ?? 0);
      L.pool.position.copy(L.at).addScaledVector(_n, 0.25);
      L.pool.quaternion.setFromUnitVectors(_z, _n);
      L.pool.scale.setScalar(POOL_R);
    }
  }

  scan();
  return {
    step, frame, lights,
    /** For the fog of war: each pool, seen as a small vision source. */
    get pools() { return lights.filter((l) => l.rec.s.alive).map((l) => ({ alive: true, team: "player", built: 1, position: l.at, vision: POOL_R + 4 })); },
  };
}
