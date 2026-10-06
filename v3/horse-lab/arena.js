// ── Horse lab arena ──────────────────────────────────────────────────────────
// A test yard modelled on the Godot "Horse Riding Simulator" screenshots: a
// white/grey checker floor, grey boundary walls, split-rail fences and a
// corral, green arches, checkered ramps and platforms, stairs, one long slope,
// a side-tilted bank (for roll), low bumps (for hoof IK) and low-poly rocks.
// Floor zones (Grass / Dirt / Dirt-1 / Concrete) are tints in the floor shader
// (no overlay geometry, so nothing can z-fight) with floating labels.
//
// Returns two lists for the horse:
//   ground   — surfaces the horse stands on (down rays)
//   blockers — things it must not walk through (chest-height forward rays)
import * as THREE from "three";
import { lineProxy } from "./collision.js";
import { float, floor, mix, positionWorld, smoothstep, vec3, max, abs, fract, normalWorld, select } from "three/tsl";

export const ZONES = [
  { name: "Grass", x0: -62, x1: -30, z0: -62, z1: -28, tint: [0.72, 0.86, 0.66] },
  { name: "Dirt", x0: 30, x1: 62, z0: -62, z1: -28, tint: [0.86, 0.74, 0.58] },
  { name: "Dirt-1", x0: 30, x1: 62, z0: 28, z1: 62, tint: [0.8, 0.68, 0.55] },
  { name: "Concrete", x0: -62, x1: -30, z0: 28, z1: 62, tint: [0.7, 0.72, 0.75] },
];
export function zoneAt(x, z) {
  for (const zn of ZONES) if (x > zn.x0 && x < zn.x1 && z > zn.z0 && z < zn.z1) return zn.name;
  return "Floor";
}

const HALF = 70;                      // walls at ±70 m

function floorMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  const p = positionWorld.xz;
  // 2 m checker, 1 m thin lines, 4 m stronger lines (the prototype-grid look)
  const c = floor(p.x.mul(0.5)).add(floor(p.y.mul(0.5))).mod(2);
  const base = mix(float(0.93), float(0.8), abs(c));
  const g1 = fract(p).sub(0.5).abs();
  const l1 = smoothstep(0.485, 0.5, max(g1.x, g1.y));
  const g4 = fract(p.mul(0.25)).sub(0.5).abs();
  const l4 = smoothstep(0.494, 0.5, max(g4.x, g4.y));
  let col = vec3(base).mul(float(1).sub(l1.mul(0.18))).mul(float(1).sub(l4.mul(0.3)));
  for (const zn of ZONES) {
    const inX = smoothstep(zn.x0, zn.x0 + 0.05, p.x).mul(smoothstep(zn.x1, zn.x1 - 0.05, p.x));
    const inZ = smoothstep(zn.z0, zn.z0 + 0.05, p.y).mul(smoothstep(zn.z1, zn.z1 - 0.05, p.y));
    col = mix(col, col.mul(vec3(...zn.tint)), inX.mul(inZ));
  }
  m.colorNode = col;
  return m;
}

// 3-D checker in world space: works on every face of ramps, steps and blocks.
function checkerMaterial(a = 0.22, b = 0.86, size = 0.5) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
  // nudge along the normal so faces lying exactly on a cell boundary don't flicker
  const q = positionWorld.sub(normalWorld.mul(0.01)).div(size);
  const c = floor(q.x).add(floor(q.y)).add(floor(q.z)).mod(2);
  m.colorNode = vec3(select(abs(c).lessThan(0.5), float(a), float(b)));
  return m;
}

function labelSprite(text, h = 2.2) {
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d");
  const font = "600 96px system-ui, sans-serif";
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 40;
  cv.width = w; cv.height = 140;
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.lineWidth = 10; ctx.strokeStyle = "rgba(40,44,52,0.85)";
  ctx.strokeText(text, 20, 72);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, 20, 72);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(h * w / 140, h, 1);
  return s;
}

export function buildArena(scene) {
  const ground = [], blockers = [];
  const add = (m, kind) => {
    m.castShadow = kind !== "floor"; m.receiveShadow = true;
    scene.add(m);
    if (kind === "ground" || kind === "floor") ground.push(m);
    if (kind === "block") blockers.push(m);
    return m;
  };

  // Floor
  const fl = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2 + 40, HALF * 2 + 40), floorMaterial());
  fl.rotation.x = -Math.PI / 2;
  add(fl, "floor");

  // Boundary walls
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x9ba2ab, roughness: 0.95 });
  for (const [x, z, sx, sz] of [[0, -HALF, HALF * 2 + 2, 1], [0, HALF, HALF * 2 + 2, 1], [-HALF, 0, 1, HALF * 2], [HALF, 0, 1, HALF * 2]]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(sx, 5, sz), wallMat);
    w.position.set(x, 2.5, z);
    add(w, "block");
  }

  const chk = checkerMaterial();
  const chkLight = checkerMaterial(0.55, 0.9, 0.5);
  const box = (sx, sy, sz, x, y, z, mat = chk, kind = "ground") => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    b.position.set(x, y, z);
    return add(b, kind);
  };
  // A ramp that rises along +X (dir 1) or −X (dir −1) from y0 to y1 over `len`.
  const rampX = (x0, z, len, width, y0, y1, dir = 1, mat = chk) => {
    const rise = y1 - y0, th = 0.4, L = Math.hypot(len, rise), a = Math.atan2(rise, len);
    const r = new THREE.Mesh(new THREE.BoxGeometry(L, th, width), mat);
    r.rotation.z = a * dir;
    const cx = x0 + dir * len / 2, cy = (y0 + y1) / 2 - (th / 2) / Math.cos(a);
    r.position.set(cx, cy, z);
    return add(r, "ground");
  };
  const rampZ = (x, z0, len, width, y0, y1, dir = 1, mat = chk) => {
    const rise = y1 - y0, th = 0.4, L = Math.hypot(len, rise), a = Math.atan2(rise, len);
    const r = new THREE.Mesh(new THREE.BoxGeometry(width, th, L), mat);
    r.rotation.x = -a * dir;
    const cz = z0 + dir * len / 2, cy = (y0 + y1) / 2 - (th / 2) / Math.cos(a);
    r.position.set(x, cy, cz);
    return add(r, "ground");
  };

  // Platform A (1.5 m) with a gentle ramp (east) and stairs (north)
  box(12, 1.5, 12, -36, 0.75, 0);
  rampX(-30, 0, 9, 6, 1.5, 0, 1);                      // from the platform edge down to the floor
  for (let i = 0; i < 6; i++) {                         // 6 steps × 0.25 m
    const h = 0.25 * (i + 1);
    box(5, h, 0.8, -36, h / 2, -6 - 0.8 * (6 - i) + 0.4, chkLight);
  }
  // Platform B (2.5 m) with a steep ramp (20°)
  box(10, 2.5, 8, 0, 1.25, -50);
  rampZ(0, -46, 2.5 / Math.tan(THREE.MathUtils.degToRad(20)), 5, 2.5, 0, 1);

  // The long slope (12°) up to a plateau against the north wall
  const sTop = 30 + 32, sH = 32 * Math.tan(THREE.MathUtils.degToRad(12));
  rampZ(0, sTop, 32, 26, sH, 0, -1, chkLight);
  box(26, sH, HALF - sTop, 0, sH / 2, sTop + (HALF - sTop) / 2, chkLight);

  // Side-tilted bank (15° across, for roll): a heightfield that rises from the
  // floor at both ends, so it is ridden onto lengthwise. Only its edge LINES
  // touch the floor (no coplanar area → no z-fight); the high side is closed
  // by a skirt.
  {
    const w = 14, len = 34, ramp = 8, cx = 42, tanA = Math.tan(THREE.MathUtils.degToRad(15));
    const nx = 14, nz = 34;
    const hAt = (u, z) => {                              // u = 0 (low edge) … w (high edge)
      const d = Math.min(z + len / 2, len / 2 - z);
      const t = THREE.MathUtils.smoothstep(d, 0, ramp);
      return u * tanA * t;
    };
    const top = new THREE.PlaneGeometry(w, len, nx, nz);
    top.rotateX(-Math.PI / 2);
    const tp = top.attributes.position;
    for (let i = 0; i < tp.count; i++) tp.setY(i, hAt(tp.getX(i) + w / 2, tp.getZ(i)));
    top.computeVertexNormals();
    const topM = new THREE.Mesh(top, chkLight);
    topM.position.set(cx, 0, 0);
    add(topM, "ground");
    const sk = [], idx = [];
    for (let j = 0; j <= nz; j++) {
      const z = -len / 2 + len * j / nz;
      sk.push(w / 2, hAt(w, z), z, w / 2, 0, z);
      if (j < nz) { const a = j * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const skirt = new THREE.BufferGeometry();
    skirt.setAttribute("position", new THREE.Float32BufferAttribute(sk, 3));
    skirt.setIndex(idx);
    skirt.computeVertexNormals();
    const skM = new THREE.Mesh(skirt, new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.9, side: THREE.DoubleSide }));
    skM.position.set(cx, 0, 0);
    add(skM, "block");
  }

  // Bumps across a lane (half cylinders) — uneven ground for the hooves
  {
    const geo = new THREE.CylinderGeometry(0.35, 0.35, 6, 16, 1, false, 0, Math.PI);
    for (let i = 0; i < 6; i++) {
      const c = new THREE.Mesh(geo, chkLight);
      c.rotation.z = Math.PI / 2;                       // axis along X, the +x half becomes the top half
      c.position.set(16, 0, -8 - i * 2.2);
      add(c, "ground");
    }
  }

  // Green arches
  const green = new THREE.MeshStandardMaterial({ color: 0x4ad44a, roughness: 0.7, flatShading: true });
  const archGeo = new THREE.TorusGeometry(3.4, 0.5, 6, 14, Math.PI);
  for (const [x, z, ry] of [[0, 18, 0], [-12, 26, 0.5], [14, 28, -0.4], [-22, -18, Math.PI / 2]]) {
    const a = new THREE.Mesh(archGeo, green);
    a.position.set(x, 0, z);
    a.rotation.y = ry;
    add(a, "block");
  }

  // Low-poly green rocks
  {
    let s = 9;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (const [x, z, r] of [[-48, -10, 1.6], [-52, -6, 1.0], [24, 46, 1.4], [27, 49, 0.9], [-20, 44, 1.2], [50, 22, 1.3]]) {
      const g = new THREE.IcosahedronGeometry(r, 0);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i) * (0.8 + rnd() * 0.5), pos.getY(i) * (0.55 + rnd() * 0.3), pos.getZ(i) * (0.8 + rnd() * 0.5));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, green);
      m.position.set(x, r * 0.3, z);
      m.rotation.y = rnd() * 6;
      add(m, "block");
    }
  }

  // Split-rail fences (two instanced meshes: posts + rails)
  const posts = [], rails = [];
  const fence = (ax, az, bx, bz, gapAt = -1) => {
    const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / 2.6)), ry = Math.atan2(bx - ax, bz - az);
    for (let i = 0; i <= n; i++) posts.push([ax + (bx - ax) * i / n, az + (bz - az) * i / n, ry]);
    for (let i = 0; i < n; i++) {
      if (i === gapAt) continue;
      const mx = ax + (bx - ax) * (i + 0.5) / n, mz = az + (bz - az) * (i + 0.5) / n;
      rails.push([mx, 0.55, mz, ry, len / n]);
      rails.push([mx, 1.05, mz, ry, len / n]);
    }
    // the rays hit one plain box per run of rails (the door gap stays open)
    const at = (i) => [ax + (bx - ax) * i / n, az + (bz - az) * i / n];
    const runs = gapAt < 0 ? [[0, n]] : [[0, gapAt], [gapAt + 1, n]];
    for (const [i0, i1] of runs) if (i1 > i0) { const [x0, z0] = at(i0), [x1, z1] = at(i1); blockers.push(lineProxy(x0, z0, x1, z1, 1.18)); }
  };
  fence(-58, -58, -36, -58); fence(-36, -58, -36, -36, 3); fence(-36, -36, -58, -36); fence(-58, -36, -58, -58);   // corral
  fence(-24, -30, 24, -30);                                       // a long run
  fence(-24, -30, -24, -16); fence(24, -30, 24, -16);
  const wood = new THREE.MeshStandardMaterial({ color: 0x9a6a33, roughness: 0.85 });
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
  const postIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 1.18, 0.16), wood, posts.length);
  posts.forEach(([x, z, ry], i) => postIM.setMatrixAt(i, m4.compose(ps.set(x, 0.59, z), q.setFromEuler(e.set(0, ry, 0)), sc.set(1, 1, 1))));
  const railIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.12, 1), wood, rails.length);
  rails.forEach(([x, y, z, ry, l], i) => railIM.setMatrixAt(i, m4.compose(ps.set(x, y, z), q.setFromEuler(e.set(0, ry, 0)), sc.set(1, 1, l))));
  postIM.computeBoundingSphere(); railIM.computeBoundingSphere();
  add(postIM, "none"); add(railIM, "none");             // drawn only: the rays hit the proxies
  // Corral door frame at the gap
  {
    const gx = -36, gz = -58 + 22 * 3.5 / 8;          // middle of rail section 3 of 8
    box(0.25, 3, 0.25, gx, 1.5, gz - 1.375, wood, "block");
    box(0.25, 3, 0.25, gx, 1.5, gz + 1.375, wood, "block");
    box(0.3, 0.3, 2.85, gx, 3, gz, wood, "none");
  }

  // Zone labels
  for (const zn of ZONES) {
    const s = labelSprite(zn.name, 2.4);
    s.position.set((zn.x0 + zn.x1) / 2, 5.5, (zn.z0 + zn.z1) / 2);
    scene.add(s);
  }

  return { ground, blockers, half: HALF };
}
