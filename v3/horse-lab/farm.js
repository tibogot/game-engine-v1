// ── Horse lab: the farm (a small pasture with a sheep herd) ──────────────────
// A second, smaller scene beside the parkour, for herd behaviour with the
// horse: a ~90 × 70 m pasture inside a dry-stone wall the horse cannot jump
// (1.8 m), a FOLD with a 4 m gate and funnel wings (drive the herd in), a small
// pen with its own gate, a barn, a water trough and a few rocks. 24 sheep from
// the Animal Lab's builder (v3/props/animalMorph.js — the pack's donkey
// reshaped; same rig and clips as the donkey) graze in the open.
//
// Returns the level contract { ground, blockers, half, spawn, zoneAt } plus
// init() (loads + builds the sheep), update(dt, { ctrl, rider }) and addGui(gui).
import * as THREE from "three";
import { float, mix, positionWorld, smoothstep, vec3, max, fract, mx_noise_float } from "three/tsl";
import { createHerd, HERD } from "./herd.js";
import { boxProxy, lineProxy } from "./collision.js";
import { createSigns } from "./signs.js";

const X0 = -45, X1 = 45, Z0 = -35, Z1 = 35;            // inside of the wall

function grassMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
  const p = positionWorld.xz;
  const n1 = mx_noise_float(vec3(p.mul(0.06), 0.0)).mul(0.5).add(0.5);
  const n2 = mx_noise_float(vec3(p.mul(0.9), 3.1));
  // linear colours: a low-poly pasture green, mottled, with mown bands
  const band = smoothstep(0.35, 0.65, fract(p.x.mul(0.1)).sub(0.5).abs().mul(2));
  let c = mix(vec3(0.07, 0.15, 0.035), vec3(0.13, 0.22, 0.05), n1).mul(n2.mul(0.08).add(1)).mul(mix(float(0.94), float(1.04), band));
  // a faint 5 m grid (distances for debugging), barely there
  const g = fract(p.mul(0.2)).sub(0.5).abs();
  c = mix(c, c.mul(1.25), smoothstep(0.485, 0.5, max(g.x, g.y)).mul(0.6));
  m.colorNode = c;
  return m;
}

const FLAT = new Map(), FLAT_VC = {};                 // one material per colour: the level merges meshes that share one
function flatMat(hex, rough = 0.9) {
  const key = hex + "|" + rough;
  if (!FLAT.has(key)) {
    const m = new THREE.MeshStandardMaterial({ color: hex, roughness: rough, flatShading: true });
    m.userData.family = "flat|" + rough;                    // mergeStatic: one draw for every flat colour
    m.userData.vertexColored = () => (FLAT_VC[rough] ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: rough, flatShading: true }));
    FLAT.set(key, m);
  }
  return FLAT.get(key);
}


export function buildFarm(scene, renderer) {
  const ground = [], blockers = [], segments = [];
  const add = (m, kind) => {
    m.castShadow = kind !== "floor"; m.receiveShadow = true;
    scene.add(m);
    if (kind === "ground" || kind === "floor") ground.push(m);
    if (kind === "block") blockers.push(m);
    return m;
  };

  const fl = new THREE.Mesh(new THREE.PlaneGeometry(260, 220), grassMaterial());
  fl.rotation.x = -Math.PI / 2;
  add(fl, "floor");

  // ── dry-stone wall round the pasture (1.8 m: the horse refuses it) ──
  const stone = flatMat(0x8b8478);
  {
    const H = 1.8, T = 0.8;
    for (const [x, z, sx, sz] of [[0, Z0 - T / 2, X1 - X0 + 2 * T, T], [0, Z1 + T / 2, X1 - X0 + 2 * T, T], [X0 - T / 2, 0, T, Z1 - Z0], [X1 + T / 2, 0, T, Z1 - Z0]]) {
      const geo = new THREE.BoxGeometry(sx, H, sz, Math.max(1, Math.round(sx / 1.5)), 3, Math.max(1, Math.round(sz / 1.5)));
      const p = geo.attributes.position;               // rough stones: jitter the top and faces a little
      for (let i = 0; i < p.count; i++) {
        const h = Math.sin(p.getX(i) * 3.1 + p.getZ(i) * 2.3) * Math.cos(p.getY(i) * 5.1 + p.getX(i));
        p.setXYZ(i, p.getX(i) + h * 0.05, p.getY(i) + (p.getY(i) > 0 ? h * 0.07 : 0), p.getZ(i) + h * 0.05);
      }
      geo.computeVertexNormals();
      const w = new THREE.Mesh(geo, stone);
      w.position.set(x, H / 2, z);
      add(w, "none");                                     // drawn; the rays hit a plain box
      blockers.push(boxProxy(sx, H, sz, x, H / 2, z));
    }
    segments.push({ ax: X0, az: Z0, bx: X1, bz: Z0 }, { ax: X1, az: Z0, bx: X1, bz: Z1 }, { ax: X1, az: Z1, bx: X0, bz: Z1 }, { ax: X0, az: Z1, bx: X0, bz: Z0 });
  }

  // ── wooden fences (post and three rails, 1.05 m: the horse can jump them) ──
  const posts = [], rails = [];
  const fence = (ax, az, bx, bz) => {
    const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / 2.4)), ry = Math.atan2(bx - ax, bz - az);
    for (let i = 0; i <= n; i++) posts.push([ax + (bx - ax) * i / n, az + (bz - az) * i / n, ry]);
    for (let i = 0; i < n; i++) {
      const mx = ax + (bx - ax) * (i + 0.5) / n, mz = az + (bz - az) * (i + 0.5) / n;
      for (const y of [0.32, 0.65, 0.98]) rails.push([mx, y, mz, ry, len / n]);
    }
    segments.push({ ax, az, bx, bz });
    blockers.push(lineProxy(ax, az, bx, bz, 1.2));           // the rays hit one box per fence line, not every rail
  };
  // a pen: corners in order, the gate a gap of `gate` m centred on side `gateSide`
  const pen = (pts, gateSide, gate) => {
    for (let i = 0; i < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[(i + 1) % pts.length];
      if (i !== gateSide) { fence(ax, az, bx, bz); continue; }
      const L = Math.hypot(bx - ax, bz - az), u = (L - gate) / 2 / L;
      fence(ax, az, ax + (bx - ax) * u, az + (bz - az) * u);
      fence(bx - (bx - ax) * u, bz - (bz - az) * u, bx, bz);
    }
    return pts;
  };
  // the FOLD, north-east: 18 × 13 m, gate (4 m) on its south side, with wings
  // opening out into the pasture (a funnel)
  const FOLD = pen([[22, 31], [40, 31], [40, 18], [22, 18]], 2, 4);
  fence(33, 18, 37, 11); fence(29, 18, 25, 11);           // the wings
  // the small pen, west: 10 × 9 m, gate (3 m) facing east
  const PEN = pen([[-41, 6], [-31, 6], [-31, -3], [-41, -3]], 1, 3);

  const wood = flatMat(0x8a5a33, 0.85);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
  // posts and rails: one unit box sized per instance — one draw (drawn only: the rays hit the proxies)
  const parts = [...posts.map(([x, z, ry]) => [x, 0.6, z, ry, 0.16, 1.2, 0.16]), ...rails.map(([x, y, z, ry, l]) => [x, y, z, ry, 0.08, 0.12, l])];
  const fenceIM = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), wood, parts.length);
  parts.forEach(([x, y, z, ry, sx, sy, sz], i) => fenceIM.setMatrixAt(i, m4.compose(ps.set(x, y, z), q.setFromEuler(e.set(0, ry, 0)), sc.set(sx, sy, sz))));
  fenceIM.computeBoundingSphere();
  add(fenceIM, "none");

  // ── barn (north-west), trough, rocks ──
  const box = (sx, sy, sz, x, y, z, mat, kind = "block", ry = 0) => { const b = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat); b.position.set(x, y, z); b.rotation.y = ry; return add(b, kind); };
  const boxSeg = (cx, cz, sx, sz) => { const a = [[cx - sx / 2, cz - sz / 2], [cx + sx / 2, cz - sz / 2], [cx + sx / 2, cz + sz / 2], [cx - sx / 2, cz + sz / 2]]; for (let i = 0; i < 4; i++) segments.push({ ax: a[i][0], az: a[i][1], bx: a[(i + 1) % 4][0], bz: a[(i + 1) % 4][1] }); };
  {
    box(12, 4.2, 8, -30, 2.1, 27, flatMat(0x9a3b2c));
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 6.9, 2.6, 4, 1), flatMat(0x4a4038));
    roof.rotation.y = Math.PI / 4; roof.scale.set(1.25, 1, 0.85); roof.position.set(-30, 5.5, 27);
    add(roof, "none");
    box(3.2, 3, 0.1, -30, 1.5, 22.95, flatMat(0x6d2a1f), "none");   // the door
    boxSeg(-30, 27, 12, 8);
  }
  box(3, 0.55, 0.7, 6, 0.275, 20, flatMat(0x6b6158));              // trough
  box(2.6, 0.12, 0.45, 6, 0.5, 20, new THREE.MeshStandardMaterial({ color: 0x6d93a8, roughness: 0.15 }), "none");
  boxSeg(6, 20, 3, 0.7);
  {
    let s = 5;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (const [x, z, r] of [[-12, -22, 1.4], [18, -8, 1.0], [-22, 14, 1.1]]) {
      const g = new THREE.IcosahedronGeometry(r, 0), p = g.attributes.position;
      for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * (0.8 + rnd() * 0.4), p.getY(i) * (0.5 + rnd() * 0.3), p.getZ(i) * (0.8 + rnd() * 0.4));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, flatMat(0x7d7b72));
      m.position.set(x, r * 0.25, z);
      add(m, "block");
      const n = 8;                                          // its footprint for the sheep: an octagon
      for (let k = 0; k < n; k++) { const a0 = k / n * 6.283, a1 = (k + 1) / n * 6.283; segments.push({ ax: x + Math.cos(a0) * r, az: z + Math.sin(a0) * r, bx: x + Math.cos(a1) * r, bz: z + Math.sin(a1) * r }); }
    }
  }
  const signs = createSigns();
  signs.add("FOLD — drive them in", 31, 2.4, 17.4, Math.PI, 0.7);   // over the gate, facing the field
  signs.add("small pen", -30.6, 2.0, 1.5, Math.PI / 2, 0.6);        // by its gate, facing east
  signs.build(scene);

  // ── the herd ──
  let herd = null, status = "loading sheep…";
  async function init() {
    const [{ getSharedGltfLoader }, morph] = await Promise.all([import("../../v2/core/foliage/glbLoader.js"), import("../props/animalMorph.js")]);
    const gltf = await getSharedGltfLoader().loadAsync("/models/Donkey_compressed.glb");
    await morph.initAnimalMorph(gltf);
    morph.setMorphDiagnostics(false);
    const tpl = morph.createMorphTemplate("sheep");
    // 24 sheep (a few lambs) grazing west of the middle
    let s = 77;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const spots = [];
    for (let i = 0; i < 24; i++) { const a = rnd() * 6.283, d = Math.sqrt(rnd()) * 7; spots.push({ x: -8 + Math.cos(a) * d, z: 2 + Math.sin(a) * d, lamb: i > 4 && rnd() < 0.15 }); }
    herd = createHerd(scene, tpl, spots, { segments, renderer });
    status = "";
    return herd;
  }

  function update(dt, { ctrl, rider }) {
    if (!herd) return;
    const threats = [];
    if (rider?.mode === "ground" || rider?.mode === "approach") {
      const M = rider.mountSys;
      threats.push({ x: M.gpos.x, z: M.gpos.z, v: M.gv ?? 0, yaw: M.gyaw, foot: true });
    }
    // the horse: a threat when ridden or moving (a horse standing alone grazing-close is tolerated)
    if (rider?.mode === "riding" || Math.abs(ctrl.v) > 0.2) threats.push({ x: ctrl.pos.x, z: ctrl.pos.z, v: ctrl.v, vMax: ctrl.gallopV(), yaw: ctrl.yaw, body: { half: ctrl.h.halfLen + 0.35, r: 0.4 } });
    else threats.push({ x: ctrl.pos.x, z: ctrl.pos.z, v: 0, yaw: ctrl.yaw, body: { half: ctrl.h.halfLen + 0.35, r: 0.4 }, quiet: true });   // only its body: they walk round it
    herd.update(dt, threats);
  }

  function addGui(gui) {
    const f = gui.addFolder("Herd (farm)");
    f.add(HERD, "flight", 1, 15, 0.5).name("flight zone (m)");
    f.add(HERD, "flightRun", 0, 20, 0.5).name("+ at a gallop (m)");
    f.add(HERD, "flee", 0, 3, 0.05).name("flee");
    f.add(HERD, "bunch", 0, 2, 0.05).name("bunch when pressed");
    f.add(HERD, "follow", 0, 2, 0.05).name("follow the others");
    f.add(HERD, "space", 0.4, 2, 0.05).name("personal space (m)");
    f.add(HERD, "runMax", 1, 8, 0.1).name("run speed (m/s)");
    f.add(HERD, "calmAfter", 0, 10, 0.1).name("calm after (s)");
    f.add(HERD, "showZone").name("show flight zone");
    return f;
  }

  const zoneAt = () => herd ? `Farm · ${herd.countIn(FOLD)} / ${herd.sheep.length} in the fold · ${herd.countIn(PEN)} in the pen` : `Farm · ${status}`;
  return { ground, blockers, half: X1, spawn: { x: 0, z: -24, yaw: 0 }, zoneAt, init, update, addGui, segments, get herd() { return herd; }, FOLD, PEN };
}
