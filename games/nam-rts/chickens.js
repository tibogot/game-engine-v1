// CHICKENS round the hamlet — procedural, one draw. GAME code.
// Your ask (2026-09-25): "for the chicken you can make them procedurally".
//
// One small model built here (body, tail fan, neck and head, beak, comb and
// wattle, two legs), every vertex tagged with the PART it belongs to, so the
// vertex shader can move the parts: the head pecks down to the ground and
// back, the legs swing and the body bobs while walking. Each hen wanders
// round her own spot in the village on the CPU — peck, stand and look,
// trot a metre or two — and writes three numbers a frame.
//
// COST. All the chickens are ONE instanced draw (~200 triangles each), no
// shadow (a 40 cm bird's shadow is a smudge nobody sees from the RTS camera).
import * as THREE from "three";
import {
  Fn, attribute, cos, float, mix, normalize, sin, smoothstep, step, time,
  transformNormalToView, varying, vec3,
} from "three/tsl";

const PART = { body: 0, head: 1, legL: 2, legR: 3 };
const PLUMAGE = ["#8a4a22", "#5e2c17", "#d8d0bd", "#262320", "#b07a36", "#8a4a22", "#d8d0bd"];

/** The hen: facing +Z, standing on y = 0, about 0.4 m tall. */
function henGeometry() {
  const pos = [], nor = [], col = [], part = [], plume = [];
  const add = (geo, m, c, p, isPlume) => {
    const g = geo.toNonIndexed();
    g.applyMatrix4(m);
    g.computeVertexNormals();
    const P = g.attributes.position, N = g.attributes.normal;
    const cc = new THREE.Color(c);
    for (let i = 0; i < P.count; i++) {
      pos.push(P.getX(i), P.getY(i), P.getZ(i));
      nor.push(N.getX(i), N.getY(i), N.getZ(i));
      col.push(cc.r, cc.g, cc.b);
      part.push(p);
      plume.push(isPlume);
    }
  };
  const M = (x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  // Body: a plump egg, tilted tail-up.
  add(new THREE.SphereGeometry(1, 8, 6), M(0, 0.21, -0.01, 0.1, 0.095, 0.14, -0.25), "#ffffff", PART.body, 1);
  // Tail: a fan of feathers up and back.
  add(new THREE.ConeGeometry(0.06, 0.16, 5), M(0, 0.3, -0.13, 1, 1, 0.5, -0.7), "#ffffff", PART.body, 0.6);
  // Neck and head.
  add(new THREE.CylinderGeometry(0.035, 0.05, 0.1, 6), M(0, 0.29, 0.09, 1, 1, 1, 0.45), "#ffffff", PART.head, 1);
  add(new THREE.SphereGeometry(0.048, 7, 5), M(0, 0.345, 0.12), "#ffffff", PART.head, 1);
  add(new THREE.ConeGeometry(0.014, 0.04, 4), M(0, 0.34, 0.175, 1, 1, 1, Math.PI / 2), "#d9a326", PART.head, 0);   // beak
  add(new THREE.BoxGeometry(0.012, 0.035, 0.05), M(0, 0.39, 0.115), "#c0271c", PART.head, 0);                         // comb
  add(new THREE.SphereGeometry(0.012, 4, 3), M(0, 0.312, 0.155, 1, 1.5, 1), "#c0271c", PART.head, 0);                // wattle
  // Legs.
  for (const [s, p] of [[-1, PART.legL], [1, PART.legR]]) {
    add(new THREE.CylinderGeometry(0.007, 0.007, 0.13, 4), M(s * 0.035, 0.07, 0.0), "#d9a326", p, 0);
    add(new THREE.BoxGeometry(0.03, 0.006, 0.05), M(s * 0.035, 0.004, 0.015), "#d9a326", p, 0);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(part, 1));
  g.setAttribute("aPlume", new THREE.Float32BufferAttribute(plume, 1));
  return g;
}

/**
 * `homes`: [{ x, z }] — a hen wanders within `roam` metres of hers.
 * `blocked(x, z)` — where she may not step (a house, water, a slope).
 * Returns { mesh, update(dt), count }.
 */
export function createChickens(app, homes, { roam = 7, blocked = () => false } = {}) {
  const N = homes.length;
  if (!N) return null;
  const geo = henGeometry();
  // Per hen: iPos (x, y, z, yaw), iAnim (walk 0-1, peck 0-1, phase, plumage row).
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
  const iAnim = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
  const iTint = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  for (const a of [iPos, iAnim]) a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("iPos", iPos);
  geo.setAttribute("iAnim", iAnim);
  geo.setAttribute("iTint", iTint);
  geo.instanceCount = N;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  mat.name = "Chickens";
  const ip = attribute("iPos", "vec4"), an = attribute("iAnim", "vec4");
  const part = attribute("aPart", "float"), p0 = attribute("position", "vec3"), n0 = attribute("normal", "vec3");
  const isHead = float(1).sub(smoothstep(0.5, 0.6, part.sub(1).abs().mul(2)));
  const legR = step(2.5, part), legL = step(1.5, part).sub(legR);
  const legSide = legR.sub(legL);            // -1 left leg, +1 right leg, 0 else
  const t = time.mul(11).add(an.z.mul(6.28));
  const walk = an.x, peck = an.y;
  // Local pose.
  const pose = Fn(() => {
    let p = p0.toVar();
    // Head: pitch down about the neck's base (y 0.25, z 0.06) to peck.
    const ang = peck.mul(1.25).mul(isHead);
    const py = p.y.sub(0.25), pz = p.z.sub(0.06);
    const ca = cos(ang), sa = sin(ang);
    p.assign(vec3(p.x, py.mul(ca).sub(pz.mul(sa)).add(0.25), py.mul(sa).add(pz.mul(ca)).add(0.06)));
    // Legs swing about the hip (y 0.14) while walking, the two out of step.
    const swing = sin(t).mul(0.55).mul(walk).mul(legSide);
    const ly = p.y.sub(0.14), lz = p.z;
    const cs = cos(swing), ss = sin(swing);
    const isLeg = legSide.abs();
    p.assign(vec3(p.x, mix(p.y, ly.mul(cs).sub(lz.mul(ss)).add(0.14), isLeg), mix(p.z, ly.mul(ss).add(lz.mul(cs)), isLeg)));
    // Body bob, and the head's forward jerk of a walking hen.
    const bob = sin(t.mul(2)).abs().mul(0.012).mul(walk).mul(float(1).sub(isLeg));
    p.assign(p.add(vec3(0, bob, sin(t).mul(0.015).mul(walk).mul(isHead))));
    return p;
  })();
  const yaw = ip.w, cy = cos(yaw), sy = sin(yaw);
  mat.positionNode = vec3(pose.x.mul(cy).add(pose.z.mul(sy)), pose.y, pose.z.mul(cy).sub(pose.x.mul(sy))).add(ip.xyz);
  const nW = varying(normalize(vec3(n0.x.mul(cy).add(n0.z.mul(sy)), n0.y, n0.z.mul(cy).sub(n0.x.mul(sy)))));
  mat.normalNode = transformNormalToView(nW);
  const plumeK = attribute("aPlume", "float");
  // Plumage parts take the hen's own colour (the tail darker); beak, comb and legs keep theirs.
  mat.colorNode = mix(attribute("color", "vec3"), attribute("iTint", "vec3").mul(plumeK.mul(0.6).add(0.4)), step(0.01, plumeK));

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "Chickens";
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  app.scene.add(mesh);

  const brain = henBrain(homes, { roam, blocked });
  const c = new THREE.Color();
  brain.hens.forEach((h, i) => {
    c.set(PLUMAGE[Math.floor(h.phase * 997) % PLUMAGE.length]).multiplyScalar(0.85 + h.phase * 0.3);
    iTint.setXYZ(i, c.r, c.g, c.b);
  });
  iTint.needsUpdate = true;

  return {
    mesh, count: N,
    update(dt) {
      brain.step(dt);
      brain.hens.forEach((h, i) => {
        iPos.setXYZW(i, h.x, app.getWorldHeight(h.x, h.z), h.z, h.yaw);
        iAnim.setXYZW(i, h.walk, h.peck, h.phase, 0);
      });
      iPos.needsUpdate = true;
      iAnim.needsUpdate = true;
    },
  };
}

/**
 * What the hens DO, for either look (this file's procedural hen or the GLB
 * flock, chickenFlock.js): each wanders round her home — pecks, stands and
 * looks, trots 0.5-2 m (now and then a dash) — never into `blocked` ground.
 * Per hen: x, z, yaw, walk 0-1 and peck 0-1 (eased), speed, phase.
 */
export function henBrain(homes, { roam = 7, blocked = () => false } = {}) {
  let seed = 777;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const hens = homes.map((h) => {
    const x = h.x + (rnd() - 0.5) * 2, z = h.z + (rnd() - 0.5) * 2;
    return { home: h, x, z, yaw: rnd() * 6.28, state: "peck", timer: rnd() * 3, walk: 0, peck: 0, phase: rnd(), tx: x, tz: z, speed: 0.5 };
  });
  return {
    hens,
    step(dt) {
      dt = Math.min(dt, 0.1);
      for (const h of hens) {
        h.timer -= dt;
        if (h.timer <= 0) {
          const r = rnd();
          if (h.state !== "walk" && r < 0.45) {
            for (let k = 0; k < 8; k++) {
              const a = rnd() * 6.28, d = 0.5 + rnd() * 1.5;
              let tx = h.x + Math.cos(a) * d, tz = h.z + Math.sin(a) * d;
              if (Math.hypot(tx - h.home.x, tz - h.home.z) > roam) { tx = h.home.x + (tx - h.home.x) * 0.5; tz = h.home.z + (tz - h.home.z) * 0.5; }
              if (blocked(tx, tz)) continue;
              h.tx = tx; h.tz = tz; h.speed = rnd() < 0.15 ? 1.6 : 0.55;
              h.state = "walk"; h.timer = 5;
              break;
            }
            if (h.state !== "walk") { h.state = "stand"; h.timer = 1 + rnd() * 2; }
          } else if (r < 0.8) { h.state = "peck"; h.timer = 1.5 + rnd() * 3; }
          else { h.state = "stand"; h.timer = 0.8 + rnd() * 2; }
        }
        let walkT = 0, peckT = 0;
        if (h.state === "walk") {
          const dx = h.tx - h.x, dz = h.tz - h.z, d = Math.hypot(dx, dz);
          const want = Math.atan2(dx, dz);
          const dA = Math.atan2(Math.sin(want - h.yaw), Math.cos(want - h.yaw));
          h.yaw += Math.max(-6 * dt, Math.min(6 * dt, dA));
          const stp = Math.min(d, h.speed * dt);
          h.x += Math.sin(h.yaw) * stp; h.z += Math.cos(h.yaw) * stp;
          walkT = 1;
          if (d < 0.05) { h.state = rnd() < 0.6 ? "peck" : "stand"; h.timer = 1 + rnd() * 3; }
        } else if (h.state === "peck") {
          // Peck, peck — up — peck: a quick pulse on a slower beat.
          const beat = (performance.now() / 1000 * 2.2 + h.phase * 3) % 1;
          peckT = beat < 0.35 ? Math.sin((beat / 0.35) * Math.PI) : 0.25;
        } else {
          // Standing: the little turns of a hen looking round.
          h.yaw += Math.sin(performance.now() / 700 + h.phase * 20) * dt * 0.8;
        }
        h.walk += (walkT - h.walk) * Math.min(1, dt * 8);
        h.peck += (peckT - h.peck) * Math.min(1, dt * 18);
      }
    },
  };
}
