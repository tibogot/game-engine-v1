// THE PARADROP (2026-10-12, you: "paratroopers — the plane should drop them; no Mixamo clip for it,
// can we do it ourselves?"). A Nord 2501 NORATLAS (rtsVehiclesFr.js buildNoratlas, bare metal —
// algAluminium.js) comes in low over the drop zone; the stick jumps from its two side doors, one man
// after another; the static lines open the canopies; they come down swaying and land in a crouch.
//   THE MEN are real units from the moment they leave the door: up there they are easy targets —
//     every rifle on the ground can hit them (the landing is the paras' dangerous minute), and they
//     cannot fire back until they are down. A shot man falls with his canopy.
//   THEIR BODY: no clip of a man hanging in a harness exists, so it is ours — the standing idle,
//     the body swinging under the risers (unitRenderer `lean`, `hanging`), the kneel on landing
//     (their posture: the renderer's own kneel), then up.
//   THE CANOPIES: one procedural dome (16 gores, scalloped skirt, the vent, the rigging lines),
//     instanced — one draw for every canopy in the air. They open from a streamer, and collapse
//     on the ground and are gathered in.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { buildNoratlas } from "../../v3/render/objects/rtsVehiclesFr.js";
import { stencilMesh } from "../../v3/render/objects/rtsStencils.js";
import { aluminiumMaterial } from "./algAluminium.js";
import { VET } from "./algVeterancy.js";

export const PARADROP = {
  height: 24,         // m over the zone: the RTS camera is only ~55 m up and looks down at ~44° — at 62, 40 and 30 m the
                      // plane crossed above the top of the screen (measured); the jump compressed to match (a real one: ~150 m)
  speed: 46,          // m/s, the plane (slowed for the run, as a real drop)
  lead: 520,          // m of approach before the zone, and as far out after it
  every: 0.2,         // s between two men out of the doors (both doors at once: a short stick on the ground)
  freefall: 0.85,     // s before the static line opens the canopy
  open: 1.0,          // s for the canopy to fill
  sink: 4.4,          // m/s under the canopy
  steer: 7,           // m/s at most toward his spot
  spread: 9,          // m either side of the zone, along the track: the stick lands in a line
  kneel: 1.3,         // s crouched after touching down
  gather: 9,          // s for the canopy to collapse and be gathered in
  canopy: { r: 4.4, h: 2.7, lines: 5.6 },   // m (game scale)
};
const P = PARADROP;

/** The canopy: the dome (16 gores, the skirt scalloped between the lines), the vent; the lines down to the risers. */
function canopyGeometry() {
  const { r, h, lines } = P.canopy, G = 16, R = 6;
  const pos = [], idx = [];
  for (let i = 0; i <= R; i++) {
    const v = i / R, phi = v * Math.PI * 0.5;               // 0 at the vent → the skirt
    for (let j = 0; j <= G * 2; j++) {
      const a = (j / (G * 2)) * Math.PI * 2;
      const gore = j % 2 ? 1 : 0.9;                          // the cloth bellies out between the seams
      const rr = (0.12 + Math.sin(phi) * 0.88) * r * (i ? gore : 1);
      const scallop = i === R ? (j % 2 ? 0.18 : 0) : 0;      // the skirt pulled in at each line
      pos.push(Math.cos(a) * rr, lines + Math.cos(phi) * h + scallop, Math.sin(a) * rr);
    }
  }
  const row = G * 2 + 1;
  for (let i = 0; i < R; i++) for (let j = 0; j < G * 2; j++) {
    const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const dome = new THREE.BufferGeometry();
  dome.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  dome.setIndex(idx);
  dome.computeVertexNormals();
  // The lines: a thin strip from each seam at the skirt to the risers over his shoulders.
  const lp = [], li = [];
  for (let j = 0; j < G; j++) {
    const a = (j / G) * Math.PI * 2, x = Math.cos(a) * r * 0.96, z = Math.sin(a) * r * 0.96;
    const k = lp.length / 3, w = 0.025;
    lp.push(x - w, lines + 0.1, z, x + w, lines + 0.1, z, (j % 2 ? 0.18 : -0.18) + w, 1.55, 0, (j % 2 ? 0.18 : -0.18) - w, 1.55, 0);
    li.push(k, k + 1, k + 2, k, k + 2, k + 3);
  }
  const rig = new THREE.BufferGeometry();
  rig.setAttribute("position", new THREE.Float32BufferAttribute(lp, 3));
  rig.setIndex(li);
  rig.computeVertexNormals();
  return mergeGeometries([dome, rig]);
}

/**
 * @param {object} app
 * @param {object} o
 * @param {object} o.units
 * @param {object} o.squads
 */
export function createAlgParadrop(app, { units, squads, navGrid = null }) {
  const groundY = (x, z) => app.getWorldHeight?.(x, z) ?? 0;
  const runs = [];      // the planes: { mesh, props, t, end, from, dir, y, jumps: [], fired }
  const jumpers = [];   // men in the air or just down: { u, phase, t, p, v, spot, seed, canopy }
  const gathered = [];  // canopies on the ground: { m: Matrix4, t, at, yaw }

  // ── The plane ──────────────────────────────────────────────────────────────
  const proto = buildNoratlas();
  const metal = aluminiumMaterial();
  function planeMesh() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(proto, metal);
    body.castShadow = true;
    const st = stencilMesh(proto.userData.stencil); if (st) body.add(st);
    g.add(body);
    if (proto.userData.glass) g.add(new THREE.Mesh(proto.userData.glass, new THREE.MeshStandardNodeMaterial({ color: 0x1a2228, roughness: 0.1, metalness: 0.3 })));
    const props = proto.userData.props.map((pr) => { const m = new THREE.Mesh(pr.geo, metal); m.position.fromArray(pr.pivot); g.add(m); return m; });
    g.userData.props = props;
    return g;
  }

  // ── The canopies: one instanced mesh ──────────────────────────────────────
  const MAXC = 48;
  const canopyMat = new THREE.MeshStandardNodeMaterial({ color: 0x6f6a4c, roughness: 0.92, side: THREE.DoubleSide });   // the khaki of French military canopies
  const canopies = new THREE.InstancedMesh(canopyGeometry(), canopyMat, MAXC);
  canopies.castShadow = true;
  canopies.frustumCulled = false;
  canopies.count = 0;
  canopies.name = "ParaCanopies";
  app.scene.add(canopies);

  /**
   * A stick of `count` men of `key` dropped on (x, z), the plane coming from `from` (a point it
   * flies from: the post). `elite`: the drop's men with a star (the doctrine's passive).
   * Returns false when there is no room for them (the population cap: checked by the caller).
   */
  function drop(x, z, { key = "para", count = 5, from = null, elite = false, onLanded = null } = {}) {
    const fx = from?.x ?? x - 400, fz = from?.z ?? z - 400;
    let dx = x - fx, dz = z - fz;
    const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    // Their spots: a short line along the track, a little to either side, on open ground.
    const spots = [];
    for (let k = 0; k < count; k++) {
      const along = (k / Math.max(1, count - 1) - 0.5) * P.spread * 2, side = (k % 2 ? 1 : -1) * 2.2;
      const sx = x + dx * along - dz * side, sz = z + dz * along + dx * side;
      spots.push(navGrid?.nearestOpenWorld?.(sx, sz, true) ?? { x: sx, z: sz });
    }
    // The run: high enough over everything on the way in.
    let top = groundY(x, z);
    for (let s = -P.lead; s <= 0; s += 40) top = Math.max(top, groundY(x + dx * s, z + dz * s) - 20);
    const y = top + P.height;
    const mesh = planeMesh();
    app.scene.add(mesh);
    const run = { mesh, t: 0, end: (P.lead * 2) / P.speed, x0: x - dx * P.lead, z0: z - dz * P.lead, dx, dz, y, jumps: [], key, elite, men: [], count, onLanded };
    // Each man jumps when the plane is a little short of his spot (he carries its speed on, then steers).
    const carry = P.speed * (P.freefall * 0.55);
    spots.forEach((spot, k) => {
      const along = (spot.x - run.x0) * dx + (spot.z - run.z0) * dz;
      run.jumps.push({ at: Math.max(0.5, (along - carry) / P.speed), k, spot, done: false });
    });
    // Stagger them at least `every` apart, in order.
    run.jumps.sort((a, b) => a.at - b.at);
    const ideal = run.jumps.map((j) => j.at);
    for (let i = 1; i < run.jumps.length; i++) run.jumps[i].at = Math.max(run.jumps[i].at, run.jumps[i - 1].at + P.every);
    // …centred on the zone: the stagger pushed the last men late (and long); share it out.
    const late = run.jumps.reduce((a, j, i) => a + j.at - ideal[i], 0) / run.jumps.length;
    for (const j of run.jumps) j.at = Math.max(0.5, j.at - late);
    runs.push(run);
    app.algSounds?.audio?.play?.("plane", x, y, z, { peakIn: P.lead / P.speed });
    return true;
  }

  const _door = new THREE.Vector3();
  function jump(run, j) {
    const door = proto.userData.doors[j.k % 2];
    run.mesh.updateMatrixWorld(true);
    _door.fromArray(door).applyMatrix4(run.mesh.matrixWorld);
    const u = units.spawn(run.key, _door.x, _door.z, { team: "player", lookRole: j.k });
    if (!u) return;
    u.ghost = true;              // nobody bumps a man in the air
    u._holdBefore = u.holdFire; u.holdFire = true;
    u.hanging = true;
    u.position.y = _door.y;
    run.men.push(u);
    // Out of the door sideways, at the plane's speed.
    const side = j.k % 2 ? -1 : 1;
    jumpers.push({
      u, phase: "fall", t: 0, seed: Math.random() * 10, spot: j.spot,
      p: new THREE.Vector3(_door.x, _door.y, _door.z),
      v: new THREE.Vector3(run.dx * P.speed - run.dz * side * 2, 0, run.dz * P.speed + run.dx * side * 2),
      yaw: Math.atan2(run.dx, run.dz), open: 0,
    });
    // The whole stick out: one squad.
    if (run.men.length === run.count) {
      squads.adopt(run.men, run.key);
      const s = squads.of(run.men[0]);
      if (s && run.elite) { s.xp = Math.max(s.xp ?? 0, VET.thresholds[0]); s.stars = Math.max(s.stars ?? 0, 1); }
    }
  }

  function land(J) {
    const u = J.u;
    u.hanging = false;
    u.lean = null;
    u.ghost = false;
    u.holdFire = u._holdBefore ?? false;
    u.position.set(J.p.x, groundY(J.p.x, J.p.z), J.p.z);
    u.haltMovement?.();
    u.posture = "kneel";         // the landing crouch (the renderer's own kneel)
    J.phase = "down"; J.t = 0;
    gathered.push({ x: J.p.x, z: J.p.z, yaw: J.yaw + 0.6, t: 0, lean: J.leanNow ?? [0, 0] });
  }

  function step(dt) {
    for (let i = runs.length - 1; i >= 0; i--) {
      const r = runs[i];
      r.t += dt;
      for (const j of r.jumps) if (!j.done && r.t >= j.at) { j.done = true; jump(r, j); }
      if (r.t >= r.end) { app.scene.remove(r.mesh); runs.splice(i, 1); }
    }
    for (let i = jumpers.length - 1; i >= 0; i--) {
      const J = jumpers[i], u = J.u;
      J.t += dt;
      if (!u.alive) {
        // Shot in the air: he falls, the canopy with him (gathered where he lies).
        if (J.phase !== "down") gathered.push({ x: J.p.x, z: J.p.z, yaw: J.yaw, t: 0, lean: [0, 0] });
        jumpers.splice(i, 1);
        continue;
      }
      if (J.phase === "down") {
        // Held crouched (the posture system rewrites it every step, before this one).
        if (J.t < P.kneel) u.posture = "kneel"; else jumpers.splice(i, 1);
        continue;
      }
      if (J.phase === "fall" && J.t >= P.freefall) { J.phase = "open"; J.t = 0; }
      // Air: the plane's speed bleeds off (fast once the canopy bites); he sinks, steering for his spot.
      const drag = J.phase === "fall" ? 1.6 : 3.2;
      J.v.x *= Math.exp(-drag * dt); J.v.z *= Math.exp(-drag * dt);
      if (J.phase === "fall") J.v.y = Math.max(-22, J.v.y - 9.8 * dt);
      else {
        J.open = Math.min(1, J.t / P.open);
        J.v.y += (-P.sink - J.v.y) * Math.min(1, dt * 2.5);
        const ex = J.spot.x - J.p.x, ez = J.spot.z - J.p.z, el = Math.hypot(ex, ez);
        if (el > 0.3) {
          const k = Math.min(P.steer, el) / el;
          J.v.x += (ex * k - J.v.x) * Math.min(1, dt * 1.6);
          J.v.z += (ez * k - J.v.z) * Math.min(1, dt * 1.6);
        }
      }
      J.p.addScaledVector(J.v, dt);
      const g = groundY(J.p.x, J.p.z);
      if (J.p.y <= g) { land(J); continue; }
      // His body under the risers: a slow pendulum, the swing bigger as the canopy fills.
      const s = J.seed, tt = J.t + s;
      const amp = J.phase === "fall" ? 0.35 : 0.14 * (1.2 - J.open * 0.4);
      J.leanNow = [Math.sin(tt * 1.25) * amp + (J.phase === "fall" ? 0.4 : 0), Math.sin(tt * 0.9 + 1.3) * amp * 0.8];
      J.yaw += Math.sin(tt * 0.35) * dt * 0.25;
      u.position.set(J.p.x, J.p.y, J.p.z);
      u.lean = J.leanNow;
      u.faceToward?.(J.p.x + Math.sin(J.yaw), J.p.z + Math.cos(J.yaw));
      u.haltMovement?.();
    }
    for (let i = gathered.length - 1; i >= 0; i--) if ((gathered[i].t += dt) >= P.gather) gathered.splice(i, 1);
  }

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _pp = new THREE.Vector3();
  function frame() {
    const now = performance.now() / 1000;
    for (const r of runs) {
      const s = r.t * P.speed;
      r.mesh.position.set(r.x0 + r.dx * s, r.y, r.z0 + r.dz * s);
      r.mesh.rotation.set(0, Math.atan2(r.dx, r.dz), 0);
      for (const pm of r.mesh.userData.props) pm.rotation.z = now * 45;
    }
    let n = 0;
    for (const J of jumpers) {
      if (J.phase === "down" || n >= MAXC) continue;
      const o = J.phase === "fall" ? 0 : J.open;
      // From a streamer (narrow, long) to the full dome; the lean of his swing, the canopy above him.
      const w = J.phase === "fall" ? Math.min(0.12, J.t * 0.2) : 0.12 + 0.88 * (o * o * (3 - 2 * o));
      const hgt = J.phase === "fall" ? Math.min(1, J.t / P.freefall) * 1.6 : 1.6 - 0.6 * o;
      _e.set(-(J.leanNow?.[0] ?? 0) * 0.5, J.yaw, -(J.leanNow?.[1] ?? 0) * 0.5);
      _q.setFromEuler(_e);
      _s.set(w, hgt, w);
      _pp.set(J.p.x, J.p.y, J.p.z);
      canopies.setMatrixAt(n++, _m.compose(_pp, _q, _s));
    }
    // On the ground: the cloth slumps downwind and is gathered in.
    for (const c of gathered) {
      if (n >= MAXC) break;
      const k = Math.min(1, c.t / 1.2), fade = 1 - Math.max(0, (c.t - P.gather * 0.5) / (P.gather * 0.5));
      _e.set(1.25 * k, c.yaw, 0);
      _q.setFromEuler(_e);
      _s.set(Math.max(0.01, (1 - 0.35 * k) * fade), Math.max(0.01, (1 - 0.85 * k) * fade), Math.max(0.01, fade));
      _pp.set(c.x, groundY(c.x, c.z) - 0.2 * k, c.z);
      canopies.setMatrixAt(n++, _m.compose(_pp, _q, _s));
    }
    canopies.count = n;
    canopies.instanceMatrix.needsUpdate = true;
  }

  return {
    params: P, drop, step, frame,
    /** Men still in the air. */
    get airborne() { return jumpers.filter((J) => J.phase !== "down").length; },
    dispose() {
      for (const r of runs) app.scene.remove(r.mesh);
      app.scene.remove(canopies);
    },
  };
}
