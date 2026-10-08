// ── Horse lab: jousting targets for the couched lance (RP.lance) ─────────────
// A tilt lane on the parkour field: QUINTAINS (a post with a pivoting arm — a
// shield one end, a sandbag the other: strike the shield and the arm spins)
// and RING stands (a small ring hung from an arm: thread it with the lance tip
// and it is taken, sliding down the shaft toward the hand).
//
// Hits are tested against the lance TIP's swept path each frame (from where it
// was to where it is: at a gallop it moves ~10 cm a frame, more than a ring).
// The targets stand on the lance side (the rider's LEFT), at the height and
// reach the couched lance has at a gallop (measured — see horse-lab TODO).
import * as THREE from "three";

const V3 = THREE.Vector3;

export const JOUST = {
  laneZ: 35, x0: -48, x1: 48,          // the lane (riding east, +x; the targets on the left: −z)
  reach: 0.91,                         // m left of the lane centre the targets stand (where the steady tip passes at a gallop)
  height: 2.19,                        // m: the tip's height at a gallop (measured, ±4 cm)
  shield: [0.42, 0.56],                // m (width, height) of the quintain's shield
  ring: 0.1,                           // m: the ring's radius (inner): the tip wanders ±6 cm at a gallop
  spinDrag: 1.6,                       // 1/s: how fast a struck quintain arm slows
};

function mats() {
  return {
    wood: new THREE.MeshStandardMaterial({ color: 0x7a5534, roughness: 0.85 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x4a3322, roughness: 0.9 }),
    iron: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.35, metalness: 0.85 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xd9a632, roughness: 0.35, metalness: 0.9 }),
    red: new THREE.MeshStandardMaterial({ color: 0xa8222b, roughness: 0.6 }),
    cream: new THREE.MeshStandardMaterial({ color: 0xece2c6, roughness: 0.7 }),
    sack: new THREE.MeshStandardMaterial({ color: 0xb59a6a, roughness: 0.95 }),
    flagR: new THREE.MeshStandardMaterial({ color: 0xa8222b, roughness: 0.8, side: THREE.DoubleSide }),
    flagB: new THREE.MeshStandardMaterial({ color: 0x23468f, roughness: 0.8, side: THREE.DoubleSide }),
  };
}
const shadowed = (o) => { o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } }); return o; };

// a shield: a heater shape, quartered red / cream, an iron rim
function shieldMesh(M, w, h) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, h / 2); s.lineTo(w / 2, h / 2); s.lineTo(w / 2, 0);
  s.quadraticCurveTo(w / 2, -h * 0.32, 0, -h / 2); s.quadraticCurveTo(-w / 2, -h * 0.32, -w / 2, 0); s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.04, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.01, bevelSegments: 2 });
  geo.translate(0, 0, -0.02);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, M.cream));
  const q = new THREE.Mesh(new THREE.PlaneGeometry(w / 2, h / 2), M.red); q.position.set(-w / 4, h / 4, 0.032); g.add(q);   // quartered
  const q2 = q.clone(); q2.position.set(w / 4, -h / 6, 0.032); q2.scale.set(1, 0.65, 1); g.add(q2);
  const boss = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.gold); boss.rotation.x = Math.PI / 2; boss.position.z = 0.03; g.add(boss);
  return g;
}

function quintain(M) {
  const g = new THREE.Group();
  const H = JOUST.height;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, H + 0.2, 12), M.wood); post.position.y = (H + 0.2) / 2; g.add(post);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.42, 0.12, 14), M.dark); foot.position.y = 0.06; g.add(foot);
  // the arm pivots about the post's top (y axis)
  const arm = new THREE.Group(); arm.position.y = H + 0.1; g.add(arm);
  const beam = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 0.1), M.wood); arm.add(beam);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 12), M.iron); arm.add(cap);
  // the shield end (+x of the arm), hanging so its centre is at the tip's height
  const shield = shieldMesh(M, ...JOUST.shield); shield.position.set(0.95, -0.12, 0); arm.add(shield);
  // the sandbag end: a rope and a sack
  const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.45, 6), M.dark); rope.position.set(-1.0, -0.25, 0); arm.add(rope);
  const sack = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10), M.sack); sack.scale.set(1, 1.3, 1); sack.position.set(-1.0, -0.6, 0); arm.add(sack);
  shadowed(g);
  return { g, arm, shield, spin: 0, hits: 0 };
}

function ringStand(M) {
  const g = new THREE.Group();
  const H = JOUST.height;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, H + 0.45, 10), M.wood); post.position.y = (H + 0.45) / 2; g.add(post);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.1, 12), M.dark); foot.position.y = 0.05; g.add(foot);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.9), M.wood); arm.position.set(0, H + 0.42, -0.42); g.add(arm);   // reaching over the lane side
  const clip = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.36, 6), M.iron); clip.position.set(0, H + 0.24, -0.82); g.add(clip);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(JOUST.ring, 0.012, 10, 28), M.gold);
  ring.position.set(0, H, -0.82); ring.rotation.y = Math.PI / 2; g.add(ring);   // its plane faces along the lane (the tip threads it)
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.26), M.flagB); flag.position.set(0, H + 0.6, 0.2); g.add(flag);
  shadowed(g);
  return { g, ring, clip, taken: false };
}

// the lane: start / end posts with flags, a low painted kerb on the far side
export function buildJoust(scene) {
  const M = mats(), root = new THREE.Group(); root.name = "joust";
  const { laneZ: Z, x0, x1, reach } = JOUST, side = Z - reach;   // the lance side (−z when riding east)
  const quintains = [], rings = [];
  const n = 6;
  for (let i = 0; i < n; i++) {
    const x = x0 + 10 + (x1 - x0 - 20) * i / (n - 1);
    if (i % 2 === 0) {
      const q = quintain(M);
      q.g.position.set(x, 0, side - 0.95);                     // post beyond the reach; the shield swings out over it
      q.arm.rotation.y = -Math.PI / 2;                         // shield out over the lane (+z), its face toward the rider coming from −x
      q.g.userData.x = x; root.add(q.g); quintains.push(q);
    } else {
      const r = ringStand(M);
      r.g.position.set(x, 0, side + 0.82);                     // the ring hangs at side (z)
      root.add(r.g); rings.push(r);
    }
  }
  for (const x of [x0, x1]) {
    for (const dz of [-1.4, 1.4]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 3, 8), M.wood); p.position.set(x, 1.5, Z + dz); root.add(p);
      const f = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.38), dz < 0 ? M.flagR : M.flagB); f.position.set(x + 0.32, 2.75, Z + dz); root.add(f);
    }
  }
  const kerb = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.08, 0.12), M.cream); kerb.position.set(0, 0.04, Z + 1.6); root.add(kerb);
  shadowed(root);
  scene.add(root);

  // score
  const hud = document.createElement("div");
  hud.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:20;background:rgba(14,18,22,.8);color:#f1e3c0;font:600 14px system-ui;padding:8px 12px;border-radius:6px;border-left:4px solid #d9a632;display:none";
  document.body.appendChild(hud);
  let last = null, msg = "", msgT = 0;
  const say = (s) => { msg = s; msgT = 1.6; };

  const tipOf = (rider) => rider.lance.localToWorld(new V3(0, 0, 3.6));
  // the swept tip a→b against a disc (centre c, normal nrm, radius r): crossing its plane inside r
  const throughDisc = (a, b, c, nrm, r) => {
    const da = a.clone().sub(c).dot(nrm), db = b.clone().sub(c).dot(nrm);
    if (da * db > 0 || da === db) return false;
    const p = a.clone().lerp(b, da / (da - db));
    return p.distanceTo(c) < r;
  };

  function update(dt, rider, ctrl) {
    const on = !!rider?.lance?.visible;
    hud.style.display = on ? "block" : "none";
    // quintains spin down; taken rings ride on the lance
    for (const q of quintains) { q.arm.rotation.y += q.spin * dt; q.spin *= Math.exp(-JOUST.spinDrag * dt); }
    for (const r of rings) if (r.taken) {
      r.slide = Math.max(1.22 + 0.05 * r.order, r.slide - dt * 1.2);   // slides down to the vamplate, stacked behind the ones already there
      r.ring.position.copy(rider.lance.localToWorld(new V3(0, 0, r.slide)));
      r.ring.quaternion.copy(rider.lance.getWorldQuaternion(new THREE.Quaternion()));
    }
    if (!on) { last = null; return; }
    const tip = tipOf(rider), a = last ?? tip;
    last = tip.clone();
    const speed = ctrl ? Math.abs(ctrl.v) : 0;
    // quintain shields: the tip crossing the shield's face, inside its outline
    for (const q of quintains) {
      q.shield.updateMatrixWorld(true);
      const c = q.shield.getWorldPosition(new V3()), nrm = new V3(0, 0, 1).transformDirection(q.shield.matrixWorld);
      const [w, h] = JOUST.shield;
      if (throughDisc(a, tip, c, nrm, Math.min(w, h) * 0.55) && q.cool !== true && speed > 1) {
        q.spin = (q.spin || 0) + Math.sign(nrm.dot(tip.clone().sub(a))) * (2 + speed * 1.4);   // struck: the arm spins away from the blow
        q.hits++; q.cool = true; setTimeout(() => (q.cool = false), 600);
        say(speed > 4 ? "a clean strike!" : "hit");
      }
    }
    // rings: the tip threading the ring (through its plane, inside it)
    for (const r of rings) {
      if (r.taken) continue;
      r.ring.updateMatrixWorld(true);
      const c = r.ring.getWorldPosition(new V3()), nrm = new V3(0, 0, 1).transformDirection(r.ring.matrixWorld);
      if (throughDisc(a, tip, c, nrm, JOUST.ring)) {
        r.order = rings.filter((o) => o.taken).length; r.taken = true; r.slide = 3.5; r.g.remove(r.ring); scene.add(r.ring);
        say("ring taken!");
      }
    }
    msgT -= dt;
    const ringsTaken = rings.filter((r) => r.taken).length, struck = quintains.filter((q) => q.hits > 0).length;
    hud.innerHTML = `⚔ Tilt — rings <b>${ringsTaken}/${rings.length}</b> · quintains <b>${struck}/${quintains.length}</b>${msgT > 0 ? ` · <span style="color:#ffd76a">${msg}</span>` : ""}`;
  }

  function reset() {
    for (const q of quintains) { q.spin = 0; q.hits = 0; q.arm.rotation.y = -Math.PI / 2; }
    for (const r of rings) if (r.taken) { r.taken = false; scene.remove(r.ring); r.g.add(r.ring); r.ring.position.set(0, JOUST.height, -0.82); r.ring.rotation.set(0, Math.PI / 2, 0); }
  }
  // start of the lane, facing down it (for the panel's "go to the tilt")
  const start = { x: JOUST.x0 - 14, z: JOUST.laneZ, yaw: Math.PI / 2 };
  return { root, update, reset, start, quintains, rings };
}
