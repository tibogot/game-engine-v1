// ── Horse lab: lance CONTACT — a debug view and a lane of physical targets ────
// The couched lance is tested as a SEGMENT (from just ahead of the vamplate to
// the tip, 2.6 m: any of it can strike, the tip is reported), swept between
// frames in substeps (a gallop moves it ~10 cm a frame). Each target is a few
// simple shapes (spheres, boxes) and its own small physics:
//
//   bag     a sandbag on a rope from a gallows — a pendulum, swings and settles
//   crates  a stack on a table — knocked off, they fall, bounce, tumble
//   jar     a clay jar on a post — shatters into shards
//   dummy   a straw man on a sprung hinge — tips back and springs up again
//
// The DEBUG view (panel "Tilt" → show contacts) draws the lance's striking part,
// every target's hit shapes, the tip's trail, a flash where a contact happened,
// and for each target passed without a hit, by how much and which way it missed.
import * as THREE from "three";

const V3 = THREE.Vector3;
export const CONTACT = {
  laneZ: 49, x0: -48, x1: 48,
  reach: 0.91, height: 2.19,          // where the couched tip passes at a gallop (as the tilt lane)
  from: 1.0, to: 3.6,                 // the striking part of the lance (m from its butt)
  radius: 0.045,                      // its thickness there
  g: 9.8,
};

export const contactMats = () => ({
  wood: new THREE.MeshStandardMaterial({ color: 0x7a5534, roughness: 0.85 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x4a3322, roughness: 0.9 }),
  crate: new THREE.MeshStandardMaterial({ color: 0xa47a48, roughness: 0.8 }),
  sack: new THREE.MeshStandardMaterial({ color: 0xb59a6a, roughness: 0.95 }),
  rope: new THREE.MeshStandardMaterial({ color: 0x8a7650, roughness: 0.9 }),
  clay: new THREE.MeshStandardMaterial({ color: 0xb8643a, roughness: 0.7 }),
  straw: new THREE.MeshStandardMaterial({ color: 0xd9c070, roughness: 0.9 }),
  red: new THREE.MeshStandardMaterial({ color: 0xa8222b, roughness: 0.6 }),
  cream: new THREE.MeshStandardMaterial({ color: 0xece2c6, roughness: 0.7 }),
});
export const shadowed = (o) => { o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } }); return o; };

// the striking part of the lance now (world): a → b, tip = b
export function lanceSegment(lance) {
  lance.updateMatrixWorld(true);
  return { a: lance.localToWorld(new V3(0, 0, CONTACT.from)), b: lance.localToWorld(new V3(0, 0, CONTACT.to)) };
}
const closestOnSeg = (p, a, b) => { const ab = b.clone().sub(a), t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq())); return { q: a.clone().addScaledVector(ab, t), t }; };

// ── the debug view ───────────────────────────────────────────────────────────
export function createLanceDebug(scene) {
  const root = new THREE.Group(); root.name = "lanceDebug"; root.visible = false; scene.add(root);
  const lineMat = (c) => new THREE.LineBasicMaterial({ color: c, depthTest: false, transparent: true });
  const meshMat = (c, o = 0.9) => new THREE.MeshBasicMaterial({ color: c, depthTest: false, transparent: true, opacity: o });
  // the lance's striking part + its tip
  const segGeo = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(6, 3));
  const seg = new THREE.Line(segGeo, lineMat(0x3dff8a)); seg.renderOrder = 999; root.add(seg);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(CONTACT.radius * 1.4, 12, 8), meshMat(0x3dff8a)); tip.renderOrder = 999; root.add(tip);
  // the tip's trail (last ~1.5 s)
  const TRAIL = 90, trailGeo = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(TRAIL * 3, 3));
  const trail = new THREE.Line(trailGeo, lineMat(0xffe14d)); trail.renderOrder = 998; trail.frustumCulled = false; root.add(trail);
  const trailPts = [];
  // contact flashes
  const flashes = [];
  const flashGeo = new THREE.SphereGeometry(0.09, 14, 10);
  // the targets' shapes, as wireframes that follow them
  const shapes = [];
  const shapeMat = lineMat(0x4fc3ff);
  function addShape(obj, shape) {
    const geo = shape.type === "sphere" ? new THREE.WireframeGeometry(new THREE.SphereGeometry(shape.r, 10, 6))
      : shape.type === "disc" ? new THREE.EdgesGeometry(new THREE.CircleGeometry(shape.r, 24))
      : new THREE.EdgesGeometry(new THREE.BoxGeometry(shape.half.x * 2, shape.half.y * 2, shape.half.z * 2));
    const w = new THREE.LineSegments(geo, shapeMat.clone()); w.renderOrder = 997; w.frustumCulled = false;
    root.add(w); shapes.push({ obj, w, shape });
  }
  // HUD lines
  const hud = document.createElement("div");
  hud.style.cssText = "position:fixed;right:12px;bottom:56px;z-index:20;background:rgba(14,18,22,.82);color:#cfe8ff;font:12px ui-monospace,monospace;padding:7px 10px;border-radius:6px;border-left:4px solid #4fc3ff;display:none;max-width:420px;white-space:pre";
  document.body.appendChild(hud);
  const log = [];
  const note = (s) => { log.unshift(s); log.length = Math.min(log.length, 6); };

  return {
    root, addShape, note,
    get on() { return root.visible; },
    set on(v) { root.visible = v; hud.style.display = v ? "block" : "none"; },
    flash(p, color = 0xff3b3b) { const m = new THREE.Mesh(flashGeo, meshMat(color)); m.position.copy(p); m.renderOrder = 999; root.add(m); flashes.push({ m, t: 0 }); },
    update(dt, lance, hitNow) {
      for (const f of flashes) { f.t += dt; f.m.scale.setScalar(1 + f.t * 2.5); f.m.material.opacity = Math.max(0, 0.9 - f.t / 1.4); }
      while (flashes.length && flashes[0].t > 1.4) { const f = flashes.shift(); root.remove(f.m); f.m.material.dispose(); }
      if (!root.visible) return;
      const vis = !!lance?.visible;
      seg.visible = tip.visible = trail.visible = vis;
      if (vis) {
        const { a, b } = lanceSegment(lance);
        segGeo.attributes.position.setXYZ(0, a.x, a.y, a.z); segGeo.attributes.position.setXYZ(1, b.x, b.y, b.z); segGeo.attributes.position.needsUpdate = true;
        tip.position.copy(b);
        const col = hitNow ? 0xff3b3b : 0x3dff8a; seg.material.color.setHex(col); tip.material.color.setHex(col);
        trailPts.push(b.clone()); if (trailPts.length > TRAIL) trailPts.shift();
        const P = trailGeo.attributes.position;
        for (let i = 0; i < TRAIL; i++) { const q = trailPts[Math.min(i, trailPts.length - 1)]; P.setXYZ(i, q.x, q.y, q.z); }
        P.needsUpdate = true;
      }
      for (const s of shapes) {
        s.obj.updateMatrixWorld(true);
        s.w.visible = s.obj.visible !== false && (s.shape.live?.() ?? true);
        s.w.position.setFromMatrixPosition(s.obj.matrixWorld);
        s.w.quaternion.setFromRotationMatrix(s.obj.matrixWorld);
        if (s.shape.offset) s.w.position.add(s.shape.offset.clone().applyQuaternion(s.w.quaternion));
      }
      hud.textContent = "lance contacts (debug)\n" + (log.length ? log.join("\n") : "—");
    },
  };
}

// ── shape tests: the swept segment against a shape ───────────────────────────
// samples: substeps between last frame and now × points along the segment;
// → the first contact { p (world), along (0 = vamplate … 1 = tip), vel } or null
function sweep(prev, cur, dt, test) {
  const S = 5, N = 14;
  for (let s = 1; s <= S; s++) {
    const u = s / S, a = prev.a.clone().lerp(cur.a, u), b = prev.b.clone().lerp(cur.b, u);
    for (let k = N; k >= 0; k--) {                           // from the tip back: the tip strikes first
      const t = k / N, p = a.clone().lerp(b, t);
      if (test(p)) {
        const p0 = prev.a.clone().lerp(prev.b, t);
        return { p, along: t, vel: p.clone().sub(p0).divideScalar(Math.max(1e-4, dt)) };
      }
    }
  }
  return null;
}
export function shapeTest(obj, shape, p, r = CONTACT.radius) {
  obj.updateMatrixWorld(true);
  const c = obj.getWorldPosition(new V3());
  if (shape.offset) c.add(shape.offset.clone().applyQuaternion(obj.getWorldQuaternion(new THREE.Quaternion())));
  if (shape.type === "sphere") return p.distanceTo(c) < shape.r + r;
  const l = obj.worldToLocal(p.clone()); if (shape.offset) l.sub(shape.offset);
  return Math.abs(l.x) < shape.half.x + r && Math.abs(l.y) < shape.half.y + r && Math.abs(l.z) < shape.half.z + r;
}
const shapeCentre = (obj, shape) => { const c = obj.getWorldPosition(new V3()); if (shape.offset) c.add(shape.offset.clone().applyQuaternion(obj.getWorldQuaternion(new THREE.Quaternion()))); return c; };

// ── the targets ──────────────────────────────────────────────────────────────
export function gallows(M, H) {
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.4, 0.16), M.wood); post.position.set(0, 1.7, -1.3); g.add(post);
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 1.5), M.wood); beam.position.set(0, 3.36, -0.6); g.add(beam);
  const foot = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.1, 0.7), M.dark); foot.position.set(0, 0.05, -1.3); g.add(foot);
  const pivot = new V3(0, 3.3, 0), L = pivot.y - H;
  const bag = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), M.sack); bag.scale.set(1, 1.35, 1); g.add(bag);
  const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 6), M.rope); g.add(rope);
  const s = { sx: 0, sz: 0, wx: 0, wz: 0 };
  const place = () => {
    const bx = L * Math.sin(s.sx), bz = L * Math.sin(s.sz), by = -Math.sqrt(Math.max(0.01, L * L - bx * bx - bz * bz));
    bag.position.set(pivot.x + bx, pivot.y + by, pivot.z + bz);
    const mid = pivot.clone().add(bag.position).multiplyScalar(0.5); rope.position.copy(mid);
    rope.scale.y = pivot.distanceTo(bag.position) - 0.25;
    rope.quaternion.setFromUnitVectors(new V3(0, 1, 0), pivot.clone().sub(bag.position).normalize());
  };
  place();
  return {
    kind: "sandbag", g, shapes: [{ obj: bag, shape: { type: "sphere", r: 0.27 } }],
    hit(c, wq) {                                              // momentum into the swing (a light bag: it takes most of the lance's speed)
      const v = c.vel.clone().applyQuaternion(wq.clone().invert());
      s.wx += (v.x * 0.55) / L; s.wz += (v.z * 0.55) / L;
      return `swings at ${(Math.hypot(v.x, v.z) * 0.55).toFixed(1)} m/s`;
    },
    update(dt) {
      for (const [a, w] of [["sx", "wx"], ["sz", "wz"]]) { s[w] += -(CONTACT.g / L) * Math.sin(s[a]) * dt; s[w] *= Math.exp(-0.35 * dt); s[a] = Math.max(-1.4, Math.min(1.4, s[a] + s[w] * dt)); }
      place();
    },
    reset() { Object.assign(s, { sx: 0, sz: 0, wx: 0, wz: 0 }); place(); },
  };
}

export function crateStack(M, H) {
  const g = new THREE.Group();
  const top = H - 0.42;                                       // the table top: the middle row is at the tip's height
  const table = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 1.2), M.dark); table.position.set(0, top - 0.05, 0); g.add(table);
  for (const [x, z] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.1, top - 0.1, 0.1), M.wood); l.position.set(x, (top - 0.1) / 2, z); g.add(l); }
  const S = 0.36, crates = [];
  const slots = [[-0.2, 0, -0.2], [0.2, 0, -0.2], [-0.2, 0, 0.2], [0.2, 0, 0.2], [0, 1, -0.2], [0, 1, 0.2], [0, 2, 0]];
  for (const [x, row, z] of slots) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(S, S, S), M.crate);
    const band = new THREE.Mesh(new THREE.BoxGeometry(S * 1.02, S * 0.12, S * 1.02), M.dark); m.add(band);
    const home = new V3(x, top + S / 2 + row * S, z);
    m.position.copy(home); g.add(m);
    crates.push({ m, home, vel: new V3(), w: new V3(), awake: false });
  }
  const onTable = (p) => Math.abs(p.x) < 0.6 && Math.abs(p.z) < 0.6;
  return {
    kind: "crates", g, shapes: crates.map((c) => ({ obj: c.m, shape: { type: "box", half: new V3(S / 2, S / 2, S / 2) }, crate: c })),
    hit(c, wq, sh) {
      const v = c.vel.clone().applyQuaternion(wq.clone().invert());
      const k = sh.crate; k.vel.add(v.multiplyScalar(0.6)).add(new V3(0, 1.2, 0)); k.w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(9); k.awake = true;
      // what it held up falls too
      for (const o of crates) if (o !== k && o.m.position.y > k.m.position.y + 0.1 && !o.awake) { o.awake = true; o.vel.add(v.clone().multiplyScalar(0.25)); o.w.set(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(3); }
      return `knocked at ${k.vel.length().toFixed(1)} m/s`;
    },
    update(dt) {
      const q = new THREE.Quaternion();
      for (const c of crates) {
        if (!c.awake) continue;
        c.vel.y -= CONTACT.g * dt;
        c.m.position.addScaledVector(c.vel, dt);
        const wl = c.w.length(); if (wl > 1e-4) c.m.quaternion.premultiply(q.setFromAxisAngle(c.w.clone().divideScalar(wl), wl * dt));
        const floor = (onTable(c.m.position) ? top : 0) + S / 2;
        if (c.m.position.y < floor) {
          c.m.position.y = floor;
          if (c.vel.y < 0) c.vel.y *= -0.3;
          c.vel.x *= 0.7; c.vel.z *= 0.7; c.w.multiplyScalar(0.6);
          if (c.vel.length() < 0.15 && c.w.length() < 0.4) { c.awake = false; c.vel.set(0, 0, 0); c.w.set(0, 0, 0); }
        }
      }
    },
    reset() { for (const c of crates) { c.m.position.copy(c.home); c.m.quaternion.identity(); c.vel.set(0, 0, 0); c.w.set(0, 0, 0); c.awake = false; } },
  };
}

export function jar(M, H) {
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, H - 0.2, 10), M.wood); post.position.y = (H - 0.2) / 2; g.add(post);
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.03, 14), M.dark); plate.position.y = H - 0.2; g.add(plate);
  const prof = [[0.05, 0], [0.13, 0.04], [0.17, 0.14], [0.15, 0.26], [0.08, 0.34], [0.07, 0.4], [0.09, 0.43]].map(([r, y]) => new THREE.Vector2(r, y));
  const body = new THREE.Mesh(new THREE.LatheGeometry(prof, 18), M.clay); body.position.y = H - 0.2; g.add(body);
  const shards = []; let broken = false;
  const shardGeo = new THREE.TetrahedronGeometry(0.06);
  return {
    kind: "jar", g, shapes: [{ obj: body, shape: { type: "sphere", r: 0.19, offset: new V3(0, 0.2, 0), live: () => !broken } }],
    hit(c, wq) {
      if (broken) return null;
      broken = true; body.visible = false;
      const v = c.vel.clone().applyQuaternion(wq.clone().invert()), at = body.position.clone().add(new V3(0, 0.2, 0));
      for (let i = 0; i < 18; i++) {
        const m = new THREE.Mesh(shardGeo, M.clay); m.position.copy(at).add(new V3(Math.random() - 0.5, Math.random() * 0.4, Math.random() - 0.5).multiplyScalar(0.25));
        m.scale.setScalar(0.5 + Math.random()); m.castShadow = true; g.add(m);
        shards.push({ m, vel: v.clone().multiplyScalar(0.35 + Math.random() * 0.4).add(new V3((Math.random() - 0.5) * 3, 1 + Math.random() * 2.5, (Math.random() - 0.5) * 3)), w: new V3(Math.random(), Math.random(), Math.random()).multiplyScalar(14) });
      }
      return "shattered";
    },
    update(dt) {
      const q = new THREE.Quaternion();
      for (const s of shards) {
        if (s.rest) continue;
        s.vel.y -= CONTACT.g * dt; s.m.position.addScaledVector(s.vel, dt);
        s.m.quaternion.premultiply(q.setFromAxisAngle(s.w.clone().normalize(), s.w.length() * dt));
        if (s.m.position.y < 0.03) { s.m.position.y = 0.03; s.vel.y *= -0.25; s.vel.x *= 0.6; s.vel.z *= 0.6; s.w.multiplyScalar(0.5); if (s.vel.length() < 0.1) s.rest = true; }
      }
    },
    reset() { for (const s of shards) g.remove(s.m); shards.length = 0; broken = false; body.visible = true; },
  };
}

export function dummy(M, H) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.42, 0.12, 14), M.dark); base.position.y = 0.06; g.add(base);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.35, 10), M.wood); post.position.y = 0.68; g.add(post);
  const spring = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.02, 6, 14), M.dark); spring.rotation.x = Math.PI / 2; spring.position.y = 1.36; g.add(spring);
  const hinge = new THREE.Group(); hinge.position.y = 1.38; g.add(hinge);
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 1.0, 14), M.straw); torso.position.y = 0.55; hinge.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10), M.straw); head.position.y = 1.22; hinge.add(head);
  const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 20), M.red); shield.rotation.z = Math.PI / 2; shield.position.set(-0.26, 0.75, 0); hinge.add(shield);
  const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.04, 12), M.cream); boss.rotation.z = Math.PI / 2; boss.position.set(-0.28, 0.75, 0); hinge.add(boss);
  const s = { a: 0, w: 0, b: 0, wb: 0 };
  return {
    kind: "straw man", g, shapes: [{ obj: torso, shape: { type: "box", half: new V3(0.26, 0.6, 0.26) } }, { obj: head, shape: { type: "sphere", r: 0.17 } }],
    hit(c, wq) {
      const v = c.vel.clone().applyQuaternion(wq.clone().invert());
      s.w += -v.x * 0.45; s.wb += v.z * 0.3;                     // tipped back along the blow; a little sideways
      return `tipped at ${Math.abs(v.x * 0.45).toFixed(1)} rad/s`;
    },
    update(dt) {
      // a sprung hinge: k 38, damped — back up in about a second
      for (const [a, w] of [["a", "w"], ["b", "wb"]]) { s[w] += (-38 * s[a] - 3.2 * s[w]) * dt; s[a] = Math.max(-1.3, Math.min(1.3, s[a] + s[w] * dt)); }
      hinge.rotation.set(s.b, 0, s.a);
    },
    reset() { Object.assign(s, { a: 0, w: 0, b: 0, wb: 0 }); hinge.rotation.set(0, 0, 0); },
  };
}

// ── the lane ─────────────────────────────────────────────────────────────────
export function buildContactLane(scene, debug) {
  const M = contactMats(), root = new THREE.Group(); root.name = "contactLane";
  const { laneZ: Z, x0, x1, reach, height: H } = CONTACT, side = Z - reach;
  const makers = [gallows, crateStack, jar, dummy, jar, gallows, dummy, crateStack];
  const targets = makers.map((mk, i) => {
    const t = mk(M, H), x = x0 + 8 + (x1 - x0 - 16) * i / (makers.length - 1);
    t.g.position.set(x, 0, side); root.add(t.g); shadowed(t.g);
    t.x = x; t.near = false; t.best = null; t.hits = 0; t.cool = 0;
    for (const s of t.shapes) debug?.addShape(s.obj, s.shape);
    return t;
  });
  for (const x of [x0, x1]) for (const dz of [-1.4, 1.4]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 3, 8), M.wood); p.position.set(x, 1.5, Z + dz); root.add(p); }
  const kerb = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.08, 0.12), M.cream); kerb.position.set(0, 0.04, Z + 1.6); root.add(kerb);
  shadowed(root); scene.add(root);

  let prev = null;
  function update(dt, rider, ctrl) {
    for (const t of targets) { t.update(dt); t.cool = Math.max(0, t.cool - dt); }
    const lance = rider?.lance;
    if (!lance?.visible) { prev = null; return false; }
    const cur = lanceSegment(lance), pv = prev ?? cur;
    prev = { a: cur.a.clone(), b: cur.b.clone() };
    const lft = ctrl ? new V3(Math.cos(ctrl.yaw), 0, -Math.sin(ctrl.yaw)) : new V3(0, 0, -1);
    let hitNow = false;
    for (const t of targets) {
      // contact
      if (t.cool <= 0) for (const sh of t.shapes) {
        if (sh.shape.live && !sh.shape.live()) continue;
        const c = sweep(pv, cur, dt, (p) => shapeTest(sh.obj, sh.shape, p));
        if (!c) continue;
        const wq = t.g.getWorldQuaternion(new THREE.Quaternion());
        const res = t.hit(c, wq, sh);
        if (res === null) continue;
        t.hits++; t.cool = 0.4; hitNow = true; t.near = false;
        debug?.flash(c.p);
        debug?.note(`HIT ${t.kind} x${t.x.toFixed(0)}: ${(c.vel.length()).toFixed(1)} m/s, lance at ${Math.round(c.along * 100)} % (${c.along > 0.9 ? "tip" : "shaft"}) — ${res}`);
        break;
      }
      // a miss report: the closest the striking part came to the target's centre on this pass
      const centre = shapeCentre(t.shapes[0].obj, t.shapes[0].shape), { q } = closestOnSeg(centre, cur.a, cur.b), d = q.distanceTo(centre);
      if (d < 3) { t.near = true; if (!t.best || d < t.best.d) t.best = { d, off: q.clone().sub(centre) }; }
      else if (t.near) {
        t.near = false;
        if (t.best && t.cool <= 0 && t.hits === 0) {
          const o = t.best.off, up = o.y, lat = o.dot(lft);
          debug?.note(`miss ${t.kind} x${t.x.toFixed(0)}: by ${(t.best.d * 100).toFixed(0)} cm — ${Math.abs(up) > Math.abs(lat) ? (up > 0 ? "too HIGH" : "too LOW") : (lat > 0 ? "too far LEFT" : "too far RIGHT")}`);
        }
        t.best = null;
      }
    }
    return hitNow;
  }
  function reset() { for (const t of targets) { t.reset(); t.hits = 0; t.best = null; t.near = false; } }
  const start = { x: x0 - 14, z: Z, yaw: Math.PI / 2 };
  return { root, update, reset, start, targets };
}
