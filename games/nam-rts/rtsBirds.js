// RTS birds — flocks that CROSS the map and leave, egrets that SETTLE on the
// river banks, and flocks FLUSHED out of the canopy by explosions.
//
// Not modular-road's flocks: those wheel on circles around a wandering centre,
// ambience for a car. Here birds do three jobs:
//
//   · TRANSIT — a flock appears at the edge of what you are looking at, flies
//     across in a line and leaves; then a quiet gap, so the sky is never busy.
//     White egrets in a loose V (the rice-paddy image), crows, or hornbills.
//   · SETTLED — a stand of egrets on OPEN ground (a river bank or the
//     shallows where the map has them; on nam-valley, whose river runs
//     through jungle end to end, its few open meadows and tracks), walking
//     and pecking. Egret flocks glide in and LAND there. Men walking up, a
//     helicopter, gunfire or a blast nearby and they lift off and leave: a
//     white stand going up is a sign someone is coming. Standing egrets are
//     drawn 1.5x (birdShapes.js) — true size, the grass hid all but the head.
//   · FLUSH — something explodes near the jungle and the canopy EMPTIES: the
//     bigger the blast the more birds, in two or three flocks of different
//     kinds bursting in different directions, in a wave rather than all at
//     once, beating fast in panic until they are well clear.
//
// ONE draw (+ one for the shadows): an InstancedMesh of four bird shapes
// (birdShapes.js). The CPU moves each flock's centre and steers every bird to
// its slot; the wing beat's PHASE is advanced on the CPU too, so a panicked
// bird can beat faster without its wings jumping (a rate change in the shader
// times the clock would jump the phase by minutes of beats).
//
// Nature is real size (egret ~1 m span), not the 1.3x of units and buildings.
// Birds never draw smaller than `minPixels`: a sub-pixel triangle does not
// fade, it crawls.
import * as THREE from "three";
import {
  Fn, abs, attribute, cos, float, hash, instanceIndex, max, mix, positionLocal, select, sin, smoothstep, step, uniform, vec3,
} from "three/tsl";
import { SPECIES, birdShapes } from "./birdShapes.js";

export const RTS_BIRD_PARAMS = {
  enabled: true,
  maxBirds: 256,
  // Transit: how many flocks at once, the gap between them, where they fly.
  maxTransit: 2,
  gapMin: 12, gapMax: 35,          // seconds of empty sky between flocks
  spawnRadius: 230,                // metres from the view centre they appear at
  cruiseAlt: [20, 32],             // metres above the ground under the flock
  speed: [10, 15],                 // m/s
  // Settled egrets: stands on the river banks.
  maxStands: 3,                    // on the whole map at once
  standSize: [4, 9],
  landChance: 0.5,                 // of a transit slot, when a bank is free
  standSpacing: 90,                // metres between two stands
  standCooldown: 70,               // seconds before a flushed bank is used again
  // How open a place must be: nothing over these densities within clearR
  // metres. nam-valley has 3 places at (5 m, 0.1, 0.05) — two of them by the
  // helipad — and 9 at (3 m, 0.2, 0.1).
  clearR: 3, clearFoliage: 0.2, clearTall: 0.1,
  // What sends them up: a man within `fleeFoot`, a vehicle within
  // `fleeVehicle`, a helicopter within `fleeAir`, a shot or blast within
  // `fleeShot` (disturb / flush).
  fleeFoot: 26, fleeVehicle: 40, fleeAir: 85, fleeShot: 90,
  // Flush.
  flushCooldown: 22,               // seconds before the same spot flushes again
  flushRadius: 45,                 // "the same spot"
  // Look.
  span: 1.0,                       // metres, before the pixel floor
  minPixels: 2.6,
  flapAmp: 0.6,
  // Ground shadows (a flattened copy of each bird, down the sun ray).
  shadows: true,
  shadowOpacity: 0.3,
  // Laid over the grass TIPS, not the soil: on the ground the blades hid all
  // but a few pixels of it, and most of the map is grass.
  shadowLift: 0.8,
};

const KIND_INDEX = { egret: 0, crow: 1, hornbill: 2, egretStanding: 3 };

const rand = (a, b) => a + Math.random() * (b - a);
const TAU = Math.PI * 2;

export function createRtsBirds({ app, units = null, params = {} }) {
  const P = { ...RTS_BIRD_PARAMS, ...params };
  const geo = birdShapes();
  // Per bird: (shape, wing-beat phase, panic). One buffer, not three: the
  // mesh sits close to WebGPU's 8 vertex buffers.
  const iBird = new THREE.InstancedBufferAttribute(new Float32Array(P.maxBirds * 3), 3);
  iBird.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("iBird", iBird);
  const uTime = uniform(0);
  const bySpecies = (sp, vals) => select(sp.lessThan(0.5), float(vals[0]),
    select(sp.lessThan(1.5), float(vals[1]), select(sp.lessThan(2.5), float(vals[2]), float(vals[3]))));

  /** The bird in its own frame: other shapes collapsed, the wings beating, a standing bird pecking. */
  const birdLocal = Fn(() => {
    const inst = attribute("iBird", "vec3");
    const vtx = attribute("aBird", "vec3");
    const sp = inst.x, panic = inst.z;
    const mine = step(abs(vtx.x.sub(sp)), float(0.5));
    const stand = step(2.5, sp);
    const h = hash(instanceIndex.add(7));
    const beat = sin(inst.y);
    // Flap-and-glide: each species glides its own share of the time; a
    // panicked bird never glides.
    const glideShare = bySpecies(sp, SPECIES.map((q) => q.glide));
    const flapping = max(
      smoothstep(glideShare.sub(0.25), glideShare.add(0.25), sin(uTime.mul(0.4).add(h.mul(13))).mul(0.5).add(0.5)),
      panic);
    // The wing ROTATES about the body (a lift alone stretched it into a needle
    // at the top of the beat), and the hand turns further than the arm, so the
    // wing CURLS through the beat. Gliding: held in a shallow dihedral.
    const x = abs(positionLocal.x);
    const side = select(positionLocal.x.lessThan(0), float(-1), float(1));
    const hand = vtx.y;
    const amp = float(P.flapAmp).mul(panic.mul(0.35).add(1));
    const angle = beat.mul(amp).mul(mix(float(0.75), float(1.35), hand)).mul(flapping)
      .add(float(0.12).mul(float(1).sub(flapping)))
      .mul(float(1).sub(stand));
    const nx = x.mul(cos(angle)).mul(side);
    const ny0 = positionLocal.y.add(x.mul(sin(angle)));
    // A standing egret pecks: now and then the neck and head dip forward and
    // down about the shoulder, and come back up.
    const pulse = smoothstep(0.8, 1.0, sin(uTime.mul(0.7).add(h.mul(37))).mul(0.5).add(0.5));
    const pa = pulse.mul(1.2).mul(vtx.z).mul(stand);
    const dy = ny0.sub(0.64), dz = positionLocal.z.sub(0.13);
    const ny = dy.mul(cos(pa)).sub(dz.mul(sin(pa))).add(0.64);
    const nz = dz.mul(cos(pa)).add(dy.mul(sin(pa))).add(0.13);
    return vec3(nx, ny, nz).mul(mine);
  });

  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
  mat.name = "RtsBirds";
  mat.positionNode = birdLocal();
  mat.colorNode = attribute("color", "vec3");
  const mesh = new THREE.InstancedMesh(geo, mat, P.maxBirds);
  mesh.name = "RtsBirds";
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.count = 0;
  app.scene.add(mesh);

  // SHADOWS: the same bird, flattened onto the ground where the sun throws it.
  // A dark shape sweeping over the terrain under a flock is how a player
  // looking down notices birds at all. One more draw; no shadow-map pass.
  const shadowMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
  });
  shadowMat.name = "RtsBirdShadows";
  shadowMat.positionNode = birdLocal();
  shadowMat.colorNode = vec3(0.02, 0.03, 0.02);
  shadowMat.opacityNode = float(P.shadowOpacity);
  shadowMat.polygonOffset = true;
  shadowMat.polygonOffsetFactor = -2;
  shadowMat.polygonOffsetUnits = -2;
  const shadows = new THREE.InstancedMesh(geo, shadowMat, P.maxBirds);
  shadows.name = "RtsBirdShadows";
  shadows.frustumCulled = false;
  shadows.castShadow = shadows.receiveShadow = false;
  shadows.count = 0;
  shadows.renderOrder = 3;
  app.scene.add(shadows);

  const flocks = [];
  const stands = [];     // settled egrets: { site, birds: [...] }
  const recentFlush = [];
  let clock = 0;
  let nextTransit = rand(3, 8);

  const ground = (x, z) => app.getWorldHeight?.(x, z) ?? 0;
  /** A prop, a building or a wall there (the units' nav grid). */
  const blocked = (x, z) => app.navGrid?.isBlockedAtWorld?.(x, z) ?? false;
  const viewCentre = () => app.controls?.target ?? app.camera.position;
  const liveBirds = () => flocks.reduce((s, f) => s + f.birds.length, 0) + stands.reduce((s, g) => s + g.birds.length, 0);

  // ── Where egrets stand: the river banks ───────────────────────────────────
  // Scanned once, the first time it is asked (12 ms on nam-valley): OPEN,
  // level ground at the water's edge (the sand strip, 4 m), or water no deeper
  // than a wading egret's legs. Open means no ground foliage AND no tall
  // plants — the first scan only looked at the ferns and stood a stand of
  // egrets under the palms, where nobody could see them. Grouped into BANKS
  // 40 m apart — a stand picks a bank.
  let banks = null;
  function scanBanks() {
    banks = [];
    if (!app.getWaterLevelAt) return;
    const W = app.worldSize ?? 1024, half = W / 2, G = 4, N = Math.floor(W / G);
    const depth = new Float32Array(N * N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const x = -half + i * G + G / 2, z = -half + j * G + G / 2;
      depth[i * N + j] = app.getWaterLevelAt(x, z) - ground(x, z);
    }
    // Distance to open water, in cells (a breadth-first flood from it).
    const dist = new Float32Array(N * N).fill(1e9);
    const queue = [];
    for (let k = 0; k < N * N; k++) if (depth[k] > 0.15) { dist[k] = 0; queue.push(k); }
    for (let h = 0; h < queue.length; h++) {
      const k = queue[h], i = (k / N) | 0, j = k % N;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
        const kk = ii * N + jj;
        if (dist[kk] > dist[k] + 1) { dist[kk] = dist[k] + 1; queue.push(kk); }
      }
    }
    // Two kinds of place, both OPEN: the BANK (the water's edge, 8 m, or
    // wading depth; up to ~24°), and the MEADOW (level open grass — where
    // cattle egrets actually feed). nam-valley's river runs through jungle
    // from end to end, so on this map the stands are on its few open
    // meadows (5 of them, none on the bank); a map with an open river
    // gets them on the water. Banks nearer the water are preferred.
    // The canopy trees (the game's jungle field, jungleCanopy.js) spread their
    // crowns 10-15 m past the trunk: a stand needs open sky round it, not
    // only an open floor under it.
    const jf = app.jungleField;
    const underTrees = (x, z) => {
      if (!jf) return false;
      if (jf.fringe(x, z) > 0.3) return true;                        // the palm margin
      for (const [ox, oz] of [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8]]) {
        const px = x + ox, pz = z + oz;
        if (jf.open(px, pz) * jf.forest(px, pz) > 0.05) return true;
      }
      return false;
    };
    // Not beside a camp or a gun: they would only ever be flushed by it.
    const built = (app.structures?.list ?? []).filter((s) => s.alive).map((s) => s.position);
    // OPEN means a clear 5 m ROUND the spot, not an empty texel: banana
    // leaves and fan palms overhang their paint by metres (MEASURED on
    // nam-valley: spots at 0 density had 0.7 foliage within 6 m, and the
    // stand drew under the leaves).
    // …and no PROP in it either: the nav grid already knows every ruin wall,
    // hut and rock (a first stand stood inside the temple's galleries).
    const clear = (x, z) => {
      for (let dx = -P.clearR; dx <= P.clearR; dx += P.clearR) for (let dz = -P.clearR; dz <= P.clearR; dz += P.clearR) {
        if ((app.sampleFoliageDensity?.(x + dx, z + dz) ?? 0) > P.clearFoliage) return false;
        if ((app.sampleTallPlantDensity?.(x + dx, z + dz) ?? 0) > P.clearTall) return false;
        if (blocked(x + dx, z + dz)) return false;
      }
      return true;
    };
    const pts = [];
    for (let i = 3; i < N - 3; i += 2) for (let j = 3; j < N - 3; j += 2) {
      const k = i * N + j, d = depth[k], cells = dist[k];
      const wade = d > 0.02 && d < 0.35;
      if (cells === 0 && !wade) continue;
      const x = -half + i * G + G / 2, z = -half + j * G + G / 2, gy = ground(x, z);
      const slope = Math.max(Math.abs(ground(x + 3, z) - gy), Math.abs(ground(x, z + 3) - gy)) / 3;
      const edge = wade || cells <= 2;
      if (slope > (edge ? 0.45 : 0.2)) continue;
      if (!clear(x, z) || underTrees(x, z)) continue;
      if (built.some((p) => Math.hypot(p.x - x, p.z - z) < 60)) continue;
      pts.push({ x, z, wade, water: cells * G });
    }
    for (const p of pts) {
      let b = banks.find((k) => Math.hypot(k.x - p.x, k.z - p.z) < 40);
      if (!b) { b = { x: p.x, z: p.z, pts: [], coolUntil: 0, water: Infinity }; banks.push(b); }
      b.pts.push(p);
      b.water = Math.min(b.water, p.water);
    }
    banks = banks.filter((b) => b.pts.length >= 3);
  }

  /** Anyone close enough to put a stand up? Returns the threat's (x, z) or null. */
  function threatNear(x, z) {
    for (const u of units?.list ?? []) {
      if (!u.alive || u.isStructure) continue;
      const r = u.isAir ? P.fleeAir : u.typeKey === "soldier" ? P.fleeFoot : P.fleeVehicle;
      const dx = u.position.x - x, dz = u.position.z - z;
      if (dx * dx + dz * dz < r * r) return u.position;
    }
    return null;
  }

  function freeBank(near = null, maxDist = Infinity) {
    if (!banks) scanBanks();
    const ok = banks.filter((b) => clock >= b.coolUntil
      && !stands.some((g) => Math.hypot(g.site.x - b.x, g.site.z - b.z) < P.standSpacing)
      && !flocks.some((f) => f.land && Math.hypot(f.land.site.x - b.x, f.land.site.z - b.z) < P.standSpacing)
      && !threatNear(b.x, b.z)
      && (!near || Math.hypot(near.x - b.x, near.z - b.z) < maxDist));
    if (!ok.length) return null;
    // Nearer the water first: one of the three wettest free places.
    ok.sort((a, b) => a.water - b.water);
    return ok[(Math.random() * Math.min(3, ok.length)) | 0];
  }

  /** Ground spots for a stand of n on a bank: its points, a metre or two apart. */
  function spotsOn(bank, n) {
    const out = [];
    const pts = [...bank.pts].sort(() => Math.random() - 0.5);
    for (let i = 0; i < n; i++) {
      const p = pts[i % pts.length];
      let x = p.x + rand(-1.6, 1.6), z = p.z + rand(-1.6, 1.6);
      if (blocked(x, z)) { x = p.x; z = p.z; }
      out.push({ x, z });
    }
    return out;
  }

  function standingBird(x, z, yaw = rand(0, TAU)) {
    return { x, z, yaw, tx: x, tz: z, walkT: rand(1, 6), size: P.span * SPECIES[3].size * rand(0.9, 1.1) };
  }

  /** Put a stand straight onto a bank (boot: there are egrets on the river already). */
  function seedStand() {
    const bank = freeBank();
    if (!bank) return null;
    const n = Math.round(rand(...P.standSize));
    const g = { site: bank, birds: spotsOn(bank, n).map((s) => standingBird(s.x, s.z)) };
    stands.push(g);
    return g;
  }

  // ── Flocks ────────────────────────────────────────────────────────────────
  /** Formation slots: a loose V for egrets, a straggle for crows. */
  function slots(n, kind) {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (kind === "hornbill") {
        // A loose follow-my-leader line, well spaced (they fly in ones and twos).
        out.push(new THREE.Vector3(rand(-2, 2), rand(-1, 1), -i * rand(5, 8)));
      } else if (kind === "egret") {
        const k = Math.ceil(i / 2), side = i % 2 ? 1 : -1;
        out.push(new THREE.Vector3(side * k * rand(1.8, 2.4), rand(-0.6, 0.6), -k * rand(1.6, 2.2)));
      } else {
        out.push(new THREE.Vector3(rand(-6, 6), rand(-2, 2), rand(-8, 4)));
      }
    }
    return out;
  }

  function newBird(slot, pos, vel, kind) {
    return {
      slot, pos, vel, size: P.span * SPECIES[KIND_INDEX[kind]].size * rand(0.88, 1.12),
      bank: 0, phase: rand(0, TAU), rateMul: rand(0.85, 1.15), panic: 0, delay: 0,
    };
  }

  function addFlock({ kind, n, x, y, z, dir, speed, alt }) {
    n = Math.min(n, P.maxBirds - liveBirds());
    if (n < 3) return null;
    const f = {
      kind, dir: dir.clone().setY(0).normalize(), speed, alt, age: 0, travelled: 0, isFlush: false,
      centre: new THREE.Vector3(x, y, z), birds: [], land: null,
    };
    const sl = slots(n, kind);
    for (let i = 0; i < n; i++) {
      f.birds.push(newBird(sl[i], new THREE.Vector3(x, y, z).add(sl[i]), f.dir.clone().multiplyScalar(speed), kind));
    }
    flocks.push(f);
    return f;
  }

  function spawnTransit(force = null) {
    const c = viewCentre();
    const a = rand(0, TAU);
    const x = c.x + Math.cos(a) * P.spawnRadius, z = c.z + Math.sin(a) * P.spawnRadius;
    // Across the view, not straight through its centre.
    const side = rand(-70, 70);
    const tx = c.x + Math.cos(a + Math.PI / 2) * side, tz = c.z + Math.sin(a + Math.PI / 2) * side;
    const dir = new THREE.Vector3(tx - x, 0, tz - z);
    const r = Math.random();
    const kind = force ?? (r < 0.5 ? "egret" : r < 0.8 ? "crow" : "hornbill");
    const n = kind === "egret" ? Math.round(rand(7, 15)) : kind === "crow" ? Math.round(rand(6, 13)) : Math.round(rand(3, 5));
    const alt = rand(...P.cruiseAlt) + (kind === "hornbill" ? 8 : 0);   // hornbills fly over the canopy
    return addFlock({ kind, n, x, y: ground(x, z) + alt, z, dir, speed: rand(...P.speed) * (kind === "hornbill" ? 0.8 : 1), alt });
  }

  /**
   * An egret flock flies in from the edge of the view and LANDS on a free
   * bank near it. `bank` for the dev panel/tests; otherwise one is chosen.
   */
  function spawnLanding(bank = null) {
    const c = viewCentre();
    bank = bank ?? freeBank(c, 380);
    if (!bank) return null;
    const a = rand(0, TAU), R = P.spawnRadius;
    const x = bank.x + Math.cos(a) * R, z = bank.z + Math.sin(a) * R;
    const alt = rand(...P.cruiseAlt);
    const f = addFlock({ kind: "egret", n: Math.round(rand(...P.standSize)), x, y: ground(x, z) + alt, z,
      dir: new THREE.Vector3(bank.x - x, 0, bank.z - z), speed: rand(...P.speed), alt });
    if (!f) return null;
    const g = { site: bank, birds: [], landing: f };
    stands.push(g);
    f.land = { site: bank, stand: g, spots: spotsOn(bank, f.birds.length) };
    f.birds.forEach((b, i) => { b.spot = f.land.spots[i]; });
    return f;
  }

  /** A stand goes up: every bird lifts, turning away from `from`, and gathers into a flock. */
  function lift(g, from = null) {
    const i = stands.indexOf(g);
    if (i >= 0) stands.splice(i, 1);
    g.site.coolUntil = clock + P.standCooldown;
    if (g.landing) {
      // The rest of the flock was still coming down (braked to a stop over
      // the bank): it gives up, climbs back to cruise and flies on out.
      const f = g.landing, land = f.land;
      f.land = null;
      f.alt = land?.cruiseAlt ?? rand(...P.cruiseAlt);
      f.speed = land?.cruise ?? rand(...P.speed);
      f.isFlush = true;                         // leaves; does not count as a transit
      f.travelled = P.spawnRadius;              // half way out already
      for (const b of f.birds) { b.spot = null; b.panic = Math.max(b.panic, 0.6); }
    }
    if (!g.birds.length) return;
    let cx = 0, cz = 0;
    for (const b of g.birds) { cx += b.x; cz += b.z; }
    cx /= g.birds.length; cz /= g.birds.length;
    const away = from ? new THREE.Vector3(cx - from.x, 0, cz - from.z) : new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1));
    if (away.lengthSq() < 1e-3) away.set(1, 0, 0);
    away.normalize();
    const gy = ground(cx, cz);
    const f = {
      kind: "egret", dir: away, speed: rand(9, 12), alt: rand(16, 24), age: 0, travelled: 0, isFlush: true,
      centre: new THREE.Vector3(cx, gy + 2, cz), birds: [], land: null,
    };
    const sl = slots(g.birds.length, "egret");
    g.birds.forEach((s, k) => {
      const b = newBird(sl[k], new THREE.Vector3(s.x, ground(s.x, s.z) + 0.6, s.z),
        new THREE.Vector3(away.x * rand(2, 5), rand(4, 7), away.z * rand(2, 5)), "egret");
      b.panic = 0.7;
      b.delay = k * rand(0.02, 0.12);          // they go up one after another
      f.birds.push(b);
    });
    flocks.push(f);
    app.onBirdsLift?.(cx, cz);
  }

  /** A shot or a blast at (x, z): stands within `r` go up. Cheap: stands are few. */
  function disturb(x, z, r = P.fleeShot) {
    for (let i = stands.length - 1; i >= 0; i--) {
      const g = stands[i];
      if (!g.birds.length) continue;
      if (Math.hypot(g.site.x - x, g.site.z - z) < r) lift(g, { x, z });
    }
  }

  /**
   * An explosion at (x, z) of `size` (explosionField's size): the canopy
   * empties. Needs jungle to flush from, and a spot does not flush twice in
   * `flushCooldown` — unless it is a BIG blast and a few seconds have passed.
   */
  function flush(x, z, { force = false, size = 10 } = {}) {
    if (!P.enabled) return false;
    disturb(x, z, Math.max(P.fleeShot, size * 7));
    // Birds already in the air near it shy away and beat hard.
    for (const f of flocks) {
      const d = Math.hypot(f.centre.x - x, f.centre.z - z);
      if (d > 110) continue;
      for (const b of f.birds) {
        b.panic = Math.max(b.panic, 0.8);
        b.vel.x += (b.pos.x - x) / Math.max(d, 10) * 6;
        b.vel.z += (b.pos.z - z) / Math.max(d, 10) * 6;
        b.vel.y += rand(2, 5);
      }
    }
    if (!force) {
      const big = size >= 18;
      for (const r of recentFlush) {
        if (Math.hypot(r.x - x, r.z - z) >= P.flushRadius) continue;
        if (clock - r.t < (big ? 6 : P.flushCooldown)) return false;
      }
      const cover = app.sampleFoliageDensity?.(x, z) ?? 1;
      if (cover < 0.15) return false;
    }
    recentFlush.push({ x, z, t: clock });
    if (recentFlush.length > 16) recentFlush.shift();

    // How many: a grenade-sized blast lifts a dozen, napalm or a shell forty.
    const total = Math.round(THREE.MathUtils.clamp(size * 1.6, 12, 44));
    const nFlocks = size < 9 ? 1 : size < 16 ? 2 : 3;
    const kinds = ["egret", "crow", size >= 16 ? "hornbill" : "egret"];
    const base = rand(0, TAU);
    // They come out of the TOP of what grows there: the canopy trees stand
    // ~26 m, palms and bananas ~10. Bursting at 5-12 m put the whole flush
    // inside the crowns, where nobody saw it for its first three seconds.
    const jf = app.jungleField;
    const canopy = jf ? jf.open(x, z) * jf.forest(x, z) : 0;
    const gy = ground(x, z) + (canopy > 0.3 ? 20 : 4);
    let any = false;
    for (let k = 0; k < nFlocks; k++) {
      const kind = kinds[k];
      let n = kind === "hornbill" ? Math.round(rand(3, 5)) : Math.round(total / nFlocks);
      n = Math.min(n, P.maxBirds - liveBirds());
      if (n < 3) break;
      const heading = base + (k - (nFlocks - 1) / 2) * rand(0.7, 1.2);
      const dir = new THREE.Vector3(Math.cos(heading), 0, Math.sin(heading));
      const f = {
        // 9-12 m/s, not 13-17: at that the flush was gone from the view in 4 s.
        kind, dir, speed: rand(9, 12), alt: rand(20, 32) + (kind === "hornbill" ? 8 : 0),
        age: 0, travelled: 0, isFlush: true, centre: new THREE.Vector3(x, gy + rand(6, 10), z), birds: [], land: null,
      };
      const sl = slots(n, kind);
      for (let i = 0; i < n; i++) {
        // Out of the canopy all round the blast, bursting up and out along
        // this flock's way — not all at once: a wave over a second or so.
        const a = heading + rand(-1.3, 1.3);
        const r0 = rand(3, 14);
        const pos = new THREE.Vector3(x + Math.cos(a) * r0, gy + rand(5, 12), z + Math.sin(a) * r0);
        const out = rand(7, 13);
        const b = newBird(sl[i], pos, new THREE.Vector3(Math.cos(a) * out, rand(8, 13), Math.sin(a) * out), kind);
        b.panic = 1;
        b.delay = Math.pow(Math.random(), 1.6) * 1.2;
        f.birds.push(b);
      }
      flocks.push(f);
      any = true;
    }
    return any;
  }

  // ── The frame ─────────────────────────────────────────────────────────────
  const _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, "YXZ"), _m = new THREE.Matrix4();
  const _s = new THREE.Vector3(), _want = new THREE.Vector3(), _off = new THREE.Vector3(), _des = new THREE.Vector3();
  const _cam = new THREE.Vector3(), _p = new THREE.Vector3();
  const _sp = new THREE.Vector3(), sun = new THREE.Vector3();
  let seeded = false, ready = false, threatT = 0, n = 0, pxPerRad = 1;

  function put(pos, q, size, shape, phase, panic, shadowY = null, yaw = 0) {
    if (n >= P.maxBirds) return;
    const s = Math.max(size, (P.minPixels * pos.distanceTo(_cam)) / pxPerRad);
    _m.compose(pos, q, _s.set(s, s, s));
    mesh.setMatrixAt(n, _m);
    iBird.setXYZ(n, shape, phase, panic);
    // The shadow: down the sun ray to the ground, flattened, same heading.
    const gy = ground(pos.x, pos.z);
    const k = (pos.y - gy) / Math.max(0.25, sun.y);
    _sp.set(pos.x - sun.x * k, 0, pos.z - sun.z * k);
    _sp.y = shadowY ?? ground(_sp.x, _sp.z) + P.shadowLift;
    _e.set(0, yaw, 0);
    _m.compose(_sp, _q.setFromEuler(_e), _s.set(s, 0.02, s));
    shadows.setMatrixAt(n, _m);
    n++;
  }

  function update(dt) {
    if (!P.enabled) { mesh.count = 0; shadows.count = 0; return; }
    dt = Math.min(dt, 0.1);
    clock += dt;
    uTime.value = clock;

    // Egrets on the river from the start — once the world is built.
    if (ready && !seeded) { seeded = true; seedStand(); seedStand(); }

    const transits = flocks.filter((f) => !f.isFlush).length;
    nextTransit -= dt;
    if (nextTransit <= 0 && transits < P.maxTransit) {
      const settled = ready && stands.length < P.maxStands && Math.random() < P.landChance && spawnLanding();
      if (!settled) spawnTransit();
      nextTransit = rand(P.gapMin, P.gapMax);
    }

    // Stands look up four times a second.
    threatT -= dt;
    if (threatT <= 0) {
      threatT = 0.25;
      for (let i = stands.length - 1; i >= 0; i--) {
        const g = stands[i];
        if (!g.birds.length) continue;
        const t = threatNear(g.site.x, g.site.z);
        if (t) lift(g, t);
      }
    }

    const cam = app.camera;
    _cam.copy(cam.position);
    // Toward the sun (unit); a low sun is clamped so the shadows stay under
    // the flock instead of streaking across the map.
    const L = app.environment?.getLightDirection?.();
    sun.set(L?.x ?? 0.4, Math.max(0.35, L?.y ?? 0.8), L?.z ?? 0.3).normalize();
    const vh = app.renderer?.domElement?.clientHeight || 1080;
    pxPerRad = vh / (2 * Math.tan(((cam.fov ?? 50) * Math.PI) / 360));

    n = 0;
    // ── Standing egrets: a few steps now and then, and the peck (shader) ──
    for (const g of stands) {
      for (const b of g.birds) {
        b.walkT -= dt;
        if (b.walkT <= 0) {
          b.walkT = rand(2, 9);
          const p = g.site.pts[(Math.random() * g.site.pts.length) | 0];
          const tx = THREE.MathUtils.lerp(b.x, p.x + rand(-1.5, 1.5), 0.35);
          const tz = THREE.MathUtils.lerp(b.z, p.z + rand(-1.5, 1.5), 0.35);
          if (!blocked(tx, tz)) { b.tx = tx; b.tz = tz; }
        }
        const dx = b.tx - b.x, dz = b.tz - b.z, d = Math.hypot(dx, dz);
        if (d > 0.05) {
          const step = Math.min(d, 0.45 * dt);
          b.x += (dx / d) * step; b.z += (dz / d) * step;
          const want = Math.atan2(dx, dz);
          let dy = want - b.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          b.yaw += dy * Math.min(1, dt * 5);
        }
        _p.set(b.x, ground(b.x, b.z), b.z);
        _e.set(0, b.yaw, 0);
        _q.setFromEuler(_e);
        put(_p, _q, b.size, 3, 0, 0, _p.y + 0.05, b.yaw);
      }
    }

    // ── Flocks ───────────────────────────────────────────────────────────
    for (let fi = flocks.length - 1; fi >= 0; fi--) {
      const f = flocks[fi];
      f.age += dt;
      const land = f.land;
      if (land) {
        // Head for the bank; come down over the last stretch and slow.
        const dx = land.site.x - f.centre.x, dz = land.site.z - f.centre.z;
        const d = Math.hypot(dx, dz);
        if (d > 1) f.dir.set(dx / d, 0, dz / d);
        const k = THREE.MathUtils.clamp((d - 20) / 90, 0, 1);            // 1 far → 0 at the bank
        land.cruise ??= f.speed;
        land.cruiseAlt ??= f.alt;
        f.speed = d < 6 ? 0 : THREE.MathUtils.lerp(5, land.cruise, k);
        f.alt = THREE.MathUtils.lerp(1.5, land.cruiseAlt, k);
      }
      // The centre flies its line, holding its height over the ground.
      f.centre.addScaledVector(f.dir, f.speed * dt);
      f.travelled += f.speed * dt;
      const gy = ground(f.centre.x, f.centre.z) + f.alt;
      f.centre.y += (gy - f.centre.y) * Math.min(1, dt * 0.6);
      const yaw = Math.atan2(f.dir.x, f.dir.z);
      if (!land && f.travelled > P.spawnRadius * 2 + 120) { flocks.splice(fi, 1); continue; }
      const gather = Math.min(1, f.age / 3.5);          // flushed birds scatter first
      for (let bi = f.birds.length - 1; bi >= 0; bi--) {
        const b = f.birds[bi];
        if (b.delay > 0) { b.delay -= dt; continue; }  // still in the canopy
        b.panic = Math.max(0, b.panic - dt / 4);
        const rate = SPECIES[KIND_INDEX[f.kind]].rate;
        b.phase = (b.phase + dt * TAU * rate * b.rateMul * (1 + 1.3 * b.panic)) % (TAU * 64);

        const prevYaw = Math.atan2(b.vel.x, b.vel.z);
        const spot = land && b.spot;
        const dSpot = spot ? Math.hypot(spot.x - b.pos.x, spot.z - b.pos.z) : Infinity;
        if (spot && dSpot < 45) {
          // Final approach: glide down onto its own spot, braking.
          const sy = ground(spot.x, spot.z);
          _des.set(spot.x - b.pos.x, sy + 0.2 - b.pos.y, spot.z - b.pos.z);
          const len = _des.length();
          _des.multiplyScalar(Math.min(8, 1.2 + len * 0.5) / Math.max(len, 1e-3));
          b.vel.lerp(_des, Math.min(1, dt * 2.5));
          b.pos.addScaledVector(b.vel, dt);
          if (len < 0.9) {
            // Down: it becomes a standing bird on the bank.
            land.stand.birds.push(standingBird(spot.x, spot.z, Math.atan2(b.vel.x, b.vel.z)));
            f.birds.splice(bi, 1);
            continue;
          }
        } else {
          // Steer toward the slot (slot turned to the flock's heading).
          _off.copy(b.slot).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
          _want.copy(f.centre).add(_off).sub(b.pos);
          _des.copy(f.dir).multiplyScalar(f.speed).addScaledVector(_want, 0.9 * gather);
          b.vel.lerp(_des, Math.min(1, dt * (0.8 + 1.6 * gather)));
          b.pos.addScaledVector(b.vel, dt);
          const floor = ground(b.pos.x, b.pos.z) + 3;
          if (b.pos.y < floor) { b.pos.y = floor; b.vel.y = Math.abs(b.vel.y); }
        }
        // Heading, pitch from the climb, bank into the turn.
        const vYaw = Math.atan2(b.vel.x, b.vel.z);
        let dYaw = vYaw - prevYaw;
        dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
        b.bank += (THREE.MathUtils.clamp(-dYaw / Math.max(dt, 1e-3) * 0.25, -0.8, 0.8) - b.bank) * Math.min(1, dt * 4);
        const pitch = -Math.atan2(b.vel.y, Math.hypot(b.vel.x, b.vel.z));
        _e.set(pitch, vYaw, b.bank);
        _q.setFromEuler(_e);
        put(b.pos, _q, b.size, KIND_INDEX[f.kind], b.phase, b.panic, null, vYaw);
      }
      if (land && !f.birds.length) { land.stand.landing = null; flocks.splice(fi, 1); }
    }
    mesh.count = n;
    mesh.visible = n > 0;
    mesh.instanceMatrix.needsUpdate = true;
    shadows.count = P.shadows ? n : 0;
    shadows.visible = P.shadows && n > 0;
    shadows.instanceMatrix.needsUpdate = true;
    iBird.clearUpdateRanges();
    iBird.addUpdateRange(0, Math.max(1, n) * 3);
    iBird.needsUpdate = true;
  }

  return {
    mesh,
    params: P,
    update,
    flush,
    disturb,
    /** Send a transit flock across the view now (dev). */
    spawnTransit,
    /** Send an egret flock to land on a bank near the view now (dev). */
    spawnLanding,
    /**
     * The world is built (river, canopy, props): scan the banks afresh and
     * put the first stands down. Called by the game after every load.
     */
    worldReady() {
      banks = null;
      stands.length = 0;
      for (let i = flocks.length - 1; i >= 0; i--) if (flocks[i].land) flocks.splice(i, 1);
      ready = true;
      seeded = false;
    },
    setEnabled(on) {
      P.enabled = !!on;
      if (!on) { flocks.length = 0; stands.length = 0; mesh.count = 0; shadows.count = 0; }
    },
    get count() { return mesh.count; },
    /** Dev: the live flocks, stands and banks (look tests move them into view). */
    get flocks() { return flocks; },
    get stands() { return stands; },
    get banks() { if (!banks) scanBanks(); return banks; },
    dispose() { app.scene.remove(mesh); app.scene.remove(shadows); geo.dispose(); mat.dispose(); shadowMat.dispose(); },
  };
}
