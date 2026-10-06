// ── Horse lab: the parkour (jump course) ─────────────────────────────────────
// A debug course for riding and jumping, on a Unity-style prototype grid
// (grey tiles, 1 m lines, stronger 5 m and 10 m lines — distances read at a
// glance). Every obstacle is numbered, with its height on a sign above it.
//
//   Lane 1 (z = 0, ride east):  1–4 single verticals 0.6 → 1.2 m, 18 m apart
//                               5 one-stride double (7.5 m), 6 two-stride (11 m)
//                               7 oxer (1.2 m wide), 8 solid wall 1.0 m
//   East loop:                  9–11 on a curve (r 35 m)
//   Lane 2 (z = 70, ride west): 12 fence at 30° · 13 log pile · 14 bank up
//                               1.0 m and drop · 15–16 on a hill (up, down
//                               the slope) · 17 high vertical 1.4 m
//   West loop:                  18 on the curve back to the start
//   Test lane (z = −30):        bounce (3.5 m) · too tall 1.6 m · wall 1.9 m
//                               (must refuse) · ground pole 0.25 m (step over)
//
// The strip x −8…8, z −28…15 stays empty: the motion audit runs there.
// Returns { ground, blockers, half, spawn, zoneAt, fences } like the arena.
import * as THREE from "three";
import { boxProxy, lineProxy } from "./collision.js";
import { createSigns } from "./signs.js";
import { attribute, instancedBufferAttribute, float, floor, mix, positionWorld, positionGeometry, smoothstep, vec3, max, abs, fract, normalWorld, select } from "three/tsl";

const FX = 137, Z0 = -45, Z1 = 115;   // walls

function gridMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
  const p = positionWorld.xz;
  // 10 m tiles, two greys (the prototype-texture look); then lines
  const t = floor(p.x.mul(0.1)).add(floor(p.y.mul(0.1))).mod(2);
  const base = mix(float(0.105), float(0.135), abs(t))   /* linear: ≈ #5b5b5b / #666 on screen */;
  const line = (scale, w) => { const g = fract(p.mul(scale)).sub(0.5).abs(); return smoothstep(0.5 - w * scale, 0.5, max(g.x, g.y)); };
  const l1 = line(1, 0.025), l5 = line(0.2, 0.04), l10 = line(0.1, 0.07);
  let c = vec3(base);
  c = mix(c, vec3(0.19), l1.mul(0.8));
  c = mix(c, vec3(0.27), l5.mul(0.9));
  c = mix(c, vec3(0.42), l10);
  m.colorNode = c;
  return m;
}

// prototype-style solid: flat colour, a darker 0.5 m checker on every face
// (one material per colour; mergeStatic bakes the colours of a family into one draw)
const PROTO = new Map(), PROTO_VC = {};
const protoShade = (dark) => {
  const q = positionWorld.sub(normalWorld.mul(0.01)).div(0.5);
  const c = floor(q.x).add(floor(q.y)).add(floor(q.z)).mod(2);
  return select(abs(c).lessThan(0.5), float(1), float(dark));
};
function protoMaterial(hex, dark = 0.86) {
  const key = hex + "|" + dark;
  if (PROTO.has(key)) return PROTO.get(key);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 });
  m.colorNode = vec3(...new THREE.Color(hex).toArray()).mul(protoShade(dark));
  m.userData.family = "proto|" + dark;
  m.userData.bakeColor = new THREE.Color(hex);
  m.userData.vertexColored = () => {
    if (!PROTO_VC[dark]) { PROTO_VC[dark] = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 }); PROTO_VC[dark].colorNode = attribute("color", "vec3").mul(protoShade(dark)); }
    return PROTO_VC[dark];
  };
  PROTO.set(key, m);
  return m;
}

// show-jumping pole: six stripes along its length, whatever the length
// colour per pole (an instanced attribute): every pole of the course in one draw
function poleMaterial(colAttr, b) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 });
  const s = fract(positionGeometry.z.add(0.5).mul(6)).lessThan(0.5);
  m.colorNode = select(s, instancedBufferAttribute(colAttr), vec3(...new THREE.Color(b).toArray()));
  return m;
}


export function buildParkour(scene) {
  const signs = createSigns();                             // every board in one draw
  const ground = [], blockers = [], fences = [];
  const add = (m, kind) => {
    m.castShadow = kind !== "floor"; m.receiveShadow = true;
    scene.add(m);
    if (kind === "ground" || kind === "floor") ground.push(m);
    if (kind === "block") blockers.push(m);
    return m;
  };

  const fl = new THREE.Mesh(new THREE.PlaneGeometry(FX * 2 + 80, Z1 - Z0 + 80), gridMaterial());
  fl.rotation.x = -Math.PI / 2;
  fl.position.set(0, 0, (Z0 + Z1) / 2);
  add(fl, "floor");

  const wallMat = protoMaterial(0x8d949d);
  for (const [x, z, sx, sz] of [[0, Z0, FX * 2 + 2, 1], [0, Z1, FX * 2 + 2, 1], [-FX, (Z0 + Z1) / 2, 1, Z1 - Z0], [FX, (Z0 + Z1) / 2, 1, Z1 - Z0]]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(sx, 3, sz), wallMat);
    w.position.set(x, 1.5, z);
    add(w, "block");
  }

  // ── fence parts (instanced: poles, standards, wings) ──
  const stands = [], wings = [];
  const white = 0xf2f2ee, orange = 0xe8742c, blue = 0x2f6fd6, red = 0xd23a32;
  const poleColor = { orange, blue, red };
  const polesBy = { orange: [], blue: [], red: [] };

  // A fence across the path at (x, z): `dir` is the riding direction (rad,
  // 0 = +z, π/2 = +x); `skew` turns the fence line off square (an angled fence).
  // type: vertical | oxer | wall | logs | pole
  // base: the ground it stands on (a hill), m
  const fence = (n, x, z, dir, h, { type = "vertical", width = 4, spread = 1.2, skew = 0, color = "orange", label, base = 0 } = {}) => {
    const ry = dir + skew;                                   // the poles lie along the fence line: local z after a yaw of ry + π/2
    const along = new THREE.Vector3(Math.cos(ry), 0, -Math.sin(ry));   // fence line (perpendicular to the path)
    const fwd = new THREE.Vector3(Math.sin(ry), 0, Math.cos(ry));
    const rails = (cx, cz, top) => {
      const k = top > 1.05 ? 4 : top > 0.7 ? 3 : 2;
      for (let i = 0; i < k; i++) polesBy[color].push([cx, base + top - i * (top - 0.25) / Math.max(1, k - 1) - 0.055, cz, ry + Math.PI / 2, width]);
      // the rays see one solid box for the rail line + standards (nothing slips between rails)
      blockers.push(lineProxy(cx - along.x * (width / 2 + 0.17), cz - along.z * (width / 2 + 0.17), cx + along.x * (width / 2 + 0.17), cz + along.z * (width / 2 + 0.17), base + top, 0.14));
      for (const s of [-1, 1]) {
        stands.push([cx + along.x * s * (width / 2 + 0.1), cz + along.z * s * (width / 2 + 0.1), base + top + 0.3, ry]);
        // wings: a slanted board out from each standard (the run-out guide)
        const wx = cx + along.x * s * (width / 2 + 0.75) - fwd.x * 0.35, wz = cz + along.z * s * (width / 2 + 0.75) - fwd.z * 0.35, wh = base + Math.max(0.9, top);
        wings.push([wx, wz, wh, ry + s * 0.45]);
        blockers.push(boxProxy(0.08, wh, 1.3, wx, wh / 2, wz, ry + s * 0.45));
      }
    };
    let top = h;
    if (type === "vertical") rails(x, z, h);
    else if (type === "oxer") {
      rails(x - fwd.x * spread / 2, z - fwd.z * spread / 2, h - 0.1);
      rails(x + fwd.x * spread / 2, z + fwd.z * spread / 2, h);
    } else if (type === "wall") {
      const b = new THREE.Mesh(new THREE.BoxGeometry(width, h, 0.5), protoMaterial(h > 1.5 ? 0x7a4bc4 : 0xb75a3c, 0.88));
      b.position.set(x, h / 2, z); b.rotation.y = ry;
      add(b, "block");
    } else if (type === "logs") {
      const g = new THREE.CylinderGeometry(0.2, 0.2, width, 10); g.rotateZ(Math.PI / 2);
      const m = protoMaterial(0x8a5a32, 0.9);
      for (const [o, y] of [[-0.21, 0.2], [0.21, 0.2], [0, 0.55]]) {
        const c = new THREE.Mesh(g, m);
        c.position.set(x + fwd.x * o, y, z + fwd.z * o); c.rotation.y = ry;
        add(c, "block");
      }
      top = 0.75;
    } else if (type === "pole") { polesBy[color].push([x, h - 0.06, z, ry + Math.PI / 2, width]); blockers.push(lineProxy(x - along.x * width / 2, z - along.z * width / 2, x + along.x * width / 2, z + along.z * width / 2, h, 0.12)); }
    // the sign stands beside the fence, past the wing: above it, it hid the horse mid-jump
    signs.add(label ?? `${n} · ${top.toFixed(2)} m`, x + along.x * (width / 2 + 2.6), base + 1.9, z + along.z * (width / 2 + 2.6), ry + Math.PI);   // facing the rider coming at it
    fences.push({ n, x, z, dir: ry, h: top, type, base });   // dir: square to the fence line
  };

  const E = Math.PI / 2, W = -Math.PI / 2;
  // Lane 1 — east along z = 0
  fence(1, -80, 0, E, 0.6);
  fence(2, -62, 0, E, 0.8);
  fence(3, -44, 0, E, 1.0, { color: "blue" });
  fence(4, -26, 0, E, 1.2, { color: "red" });
  fence("5a", 14, 0, E, 0.9, { label: "5a · 0.90 m · one stride →" });
  fence("5b", 21.5, 0, E, 0.9);
  fence("6a", 38, 0, E, 1.0, { color: "blue", label: "6a · 1.00 m · two strides →" });
  fence("6b", 49, 0, E, 1.0, { color: "blue" });
  fence(7, 66, 0, E, 1.0, { type: "oxer", label: "7 · oxer 1.00 m × 1.2 m" });
  fence(8, 84, 0, E, 1.0, { type: "wall", label: "8 · wall 1.00 m" });
  // East loop: centre (95, 35), r 35 — ridden anticlockwise seen from above (north turn)
  // tangent of the path at angle a (going from z=0 up to z=70 round the east end: a from −90° to +90°)
  for (const [n, deg, h] of [[9, -45, 0.8], [10, 0, 0.9], [11, 45, 0.8]]) {
    const a = THREE.MathUtils.degToRad(deg), x = 95 + 35 * Math.cos(a), z = 35 + 35 * Math.sin(a);
    const tx = -Math.sin(a), tz = Math.cos(a);                // direction of travel (a increasing)
    fence(n, x, z, Math.atan2(tx, tz), h, { color: n === 10 ? "blue" : "orange" });
  }
  // Lane 2 — west along z = 70
  fence(12, 70, 70, W, 1.0, { skew: 0.52, color: "blue", label: "12 · 1.00 m · angled 30°" });
  fence(13, 50, 70, W, 0.75, { type: "logs", label: "13 · logs 0.75 m" });
  // 14: a bank — jump up 1.0 m onto it, ride 12 m, drop off
  {
    const b = new THREE.Mesh(new THREE.BoxGeometry(12, 1.0, 10), protoMaterial(0x6f9a4e, 0.9));
    b.position.set(24, 0.5, 70);
    add(b, "ground");
    signs.add("14 · bank up 1.00 m, drop off", 30, 2.6, 75.5, Math.PI / 2);
    fences.push({ n: 14, x: 30, z: 70, dir: W, h: 1.0, type: "bank" });
  }
  // 15–16: a hill (rise 1.6 m over 16 m), a fence on the top and one on the way down
  {
    const m = protoMaterial(0x9aa3ad, 0.9), H = 1.6, L = 16, wd = 14, th = 0.4;
    const ramp = (x0, dirX, y0, y1) => {
      const rise = y1 - y0, Lr = Math.hypot(L, rise), a = Math.atan2(rise, L);
      const r = new THREE.Mesh(new THREE.BoxGeometry(Lr, th, wd), m);
      r.rotation.z = a * dirX;
      r.position.set(x0 + dirX * L / 2, (y0 + y1) / 2 - (th / 2) / Math.cos(a), 70);
      add(r, "ground");
    };
    ramp(8, -1, 0, H);                                       // up, riding west from x = 8 to −8
    const top = new THREE.Mesh(new THREE.BoxGeometry(16, H, wd), m);
    top.position.set(-16, H / 2, 70);
    add(top, "ground");
    ramp(-24, -1, H, 0);                                     // down from −24 to −40
    fence(15, -16, 70, W, 0.9, { base: H });                 // on the hilltop
    const yAt = (x) => H * (1 - (-24 - x) / L);              // on the slope: the ramp's surface
    fence(16, -33, 70, W, 0.8, { base: yAt(-33), label: "16 · 0.80 m · downhill" });
  }
  fence(17, -62, 70, W, 1.4, { color: "red", label: "17 · 1.40 m (near max)" });
  // West loop: centre (−95, 35), r 35, from z = 70 back down to z = 0
  {
    const a = Math.PI, x = -95 + 35 * Math.cos(a), z = 35;
    fence(18, x, z, Math.PI, 1.0, { color: "blue" });          // riding south (−z) at the far west point
  }
  // Test lane — z = −30, east
  fence("T1", -66, -30, E, 0.8, { label: "T1 · bounce: 2 fences 3.5 m apart" });
  fence("T1b", -62.5, -30, E, 0.8, { label: " " });
  fence("T2", -36, -30, E, 1.6, { color: "red", label: "T2 · 1.60 m — must refuse" });
  fence("T3", 30, -30, E, 1.9, { type: "wall", width: 5, label: "T3 · wall 1.90 m — must refuse" });
  fence("T4", 60, -30, E, 0.25, { type: "pole", label: "T4 · ground pole 0.25 m — step over" });

  // instance the parts
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
  const pg = new THREE.CylinderGeometry(0.06, 0.06, 1, 10); pg.rotateX(Math.PI / 2);   // length along local z
  // all poles in one instanced mesh (their colour per instance)
  const poles = Object.entries(polesBy).flatMap(([k, list]) => list.map((r) => [...r, poleColor[k]]));
  const colAttr = new THREE.InstancedBufferAttribute(new Float32Array(poles.length * 3), 3);
  const col = new THREE.Color();
  const im = new THREE.InstancedMesh(pg, poleMaterial(colAttr, white), poles.length);
  poles.forEach(([x, y, z, ry, l, hex], i) => {
    im.setMatrixAt(i, m4.compose(ps.set(x, y, z), q.setFromEuler(e.set(0, ry, 0)), sc.set(1, 1, l)));
    col.setHex(hex); colAttr.setXYZ(i, col.r, col.g, col.b);
  });
  im.computeBoundingSphere();
  add(im, "none");                                           // drawn only: the rays hit the proxies
  // standards and wings: one unit box, sized per instance — one draw
  const boxes = [...stands.map(([x, z, h, ry]) => [x, z, h, ry, 0.14, 0.14]), ...wings.map(([x, z, h, ry]) => [x, z, h, ry, 0.08, 1.3])];
  const bIM = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), protoMaterial(white, 0.9), boxes.length);
  boxes.forEach(([x, z, h, ry, sx, sz], i) => bIM.setMatrixAt(i, m4.compose(ps.set(x, h / 2, z), q.setFromEuler(e.set(0, ry, 0)), sc.set(sx, h, sz))));
  bIM.computeBoundingSphere();
  add(bIM, "none");

  // start pad marker
  signs.add("START → lane 1", -90, 2.2, -6, -Math.PI / 2, 0.7);
  signs.build(scene);

  const zoneAt = (x, z) => {
    let best = null, bd = 1e9;
    for (const f of fences) { const d = Math.hypot(f.x - x, f.z - z); if (d < bd) { bd = d; best = f; } }
    return best && bd < 25 ? `Parkour · next to ${best.n}` : "Parkour";
  };
  return { ground, blockers, half: FX, spawn: { x: -100, z: 0, yaw: E }, zoneAt, fences };
}
