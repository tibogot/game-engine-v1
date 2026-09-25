// FOG BANKS — mist at PLACES on the map, not fog by distance or height
// everywhere (your ask 2026-09-25: "realistic fog in some places, not
// everywhere… no interactive fog if it hurts the perf"). GAME code. The
// map's own fog (distance haze, the level's look) is not touched: this is a
// separate layer drawn over it.
//
// A bank is a soft ELLIPSOID lying on the ground: stretched along a river,
// round in a valley. Its density falls off smoothly from its middle to its
// skin (1 - r² in the ellipsoid's own frame), and THAT is what makes it cheap:
// the fog along a view ray through such a shape is a cubic in the ray
// parameter, so it is INTEGRATED IN CLOSED FORM — no raymarch, the idea
// behind Unreal 5's local fog volumes. Per pixel:
//
//   · where the ray enters and leaves the ellipsoid (a quadratic)
//   · where it meets the GROUND: four (bilinear) heightmap samples along it, the first
//     one under the ground interpolated (no depth buffer, no screen copy) —
//     so the mist pools in low ground and whatever stands above it stays clear
//   · the integral between the two, times a slow-drifting two-octave noise so
//     it breaks into wisps instead of sitting there like a frozen cloud
//
// Each bank is drawn as its own box: only the pixels it covers pay anything.
// Lit like the day: the mist's colour, warmed toward the sun on the side you
// look into it. Decoration only for now (it does not block line of sight).
import * as THREE from "three";
import {
  Fn, cameraPosition, clamp, dot, exp, float, max, min, mix, modelWorldMatrixInverse, normalize,
  positionWorld, pow, sqrt, texture, time, uniform, vec2, vec3, vec4,
} from "three/tsl";

export const FOG_BANK_PARAMS = {
  enabled: true,
  color: "#dde4e2",       // day mist: near-white, a breath of green-grey
  sunTint: "#fff0d8",     // warmed where you look toward the sun
  density: 1.0,           // global multiplier on every bank's own density
  drift: 0.6,             // m/s the wisps move
  wisps: 0.75,            // 0 = smooth banks, 1 = strongly broken up
};

/** A tileable value-noise texture for the wisps (made once). */
function makeNoiseTexture(size = 128, seed = 7) {
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const G = 16, grid = Array.from({ length: G * G }, r);
  const data = new Uint8Array(size * size * 4);
  const at = (i, j) => grid[((j % G + G) % G) * G + ((i % G + G) % G)];
  const sm = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0, amp = 0.5, f = 1;
    for (let o = 0; o < 3; o++) {
      const gx = (x / size) * G * f, gy = (y / size) * G * f;
      const i = Math.floor(gx), j = Math.floor(gy), fx = sm(gx - i), fy = sm(gy - j);
      const a = at(i, j) * (1 - fx) + at(i + 1, j) * fx;
      const b = at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx;
      v += (a * (1 - fy) + b * fy) * amp;
      amp *= 0.5; f *= 2;
    }
    const k = (y * size + x) * 4;
    data[k] = data[k + 1] = data[k + 2] = Math.round(Math.min(1, v / 0.875) * 255);
    data[k + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export function createFogBanks({ app, params = {} }) {
  const P = { ...FOG_BANK_PARAMS, ...params };
  const W = app.worldSize ?? 1024;
  const uColor = uniform(new THREE.Color(P.color));
  const uSunTint = uniform(new THREE.Color(P.sunTint));
  const uDensity = uniform(P.density);
  const uDrift = uniform(P.drift);
  const uWisps = uniform(P.wisps);
  const uSun = uniform(new THREE.Vector3(0.4, 0.8, 0.3));
  const noise = makeNoiseTexture();
  const group = new THREE.Group();
  group.name = "FogBanks";
  app.scene.add(group);
  const box = new THREE.BoxGeometry(2, 2, 2);
  const banks = [];

  // The ground under a point, BILINEAR by hand: the heightmap is a float
  // texture read unfiltered, and the ray's ground hit then jumped a whole
  // texel at a time on steep ground. (The stair-step checker on the gorge
  // wall turned out to be the TERRAIN's own shading — it is there with the
  // mist off — but the hit is smoother bilinear all the same.)
  const HN = app.heightTexNode?.value?.image?.width ?? 512;
  const groundY = (x, z) => {
    const g = vec2(x.add(W * 0.5).div(W), z.add(W * 0.5).div(W)).mul(HN).sub(0.5);
    const f = g.fract(), i0 = g.floor().add(0.5).div(HN), s = 1 / HN;
    const h00 = texture(app.heightTexNode, i0).r;
    const h10 = texture(app.heightTexNode, i0.add(vec2(s, 0))).r;
    const h01 = texture(app.heightTexNode, i0.add(vec2(0, s))).r;
    const h11 = texture(app.heightTexNode, i0.add(vec2(s, s))).r;
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y).mul(app.maxHeight);
  };

  const step01 = (x) => clamp(x.mul(1e6), 0, 1);   // 0 if the ray misses, 1 if it hits

  function material(uBankDensity) {
    const m = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, depthTest: true, side: THREE.FrontSide,
    });
    m.name = "FogBank";
    const shade = Fn(() => {
      // The view ray, in world units (t is metres along it).
      const o = cameraPosition;
      const d = normalize(positionWorld.sub(o));
      // …and in the bank's own unit-sphere frame (the mesh's inverse matrix:
      // the box is the ellipsoid's bounds, scaled and turned).
      const ol = modelWorldMatrixInverse.mul(vec4(o, 1)).xyz;
      const dl = modelWorldMatrixInverse.mul(vec4(d, 0)).xyz;
      const aa = dot(dl, dl), bb = dot(ol, dl), cc = dot(ol, ol);
      // Entry and exit: |ol + t dl|² = 1.
      const disc = bb.mul(bb).sub(aa.mul(cc.sub(1)));
      const sq = sqrt(max(disc, 0));
      const t0 = max(bb.negate().sub(sq).div(aa), 0);
      let t1 = bb.negate().add(sq).div(aa);
      // Where the ray meets the ground inside the bank: FOUR samples along it
      // and the first one that has gone below the heightmap, interpolated.
      // (A fixed-point solve — the decals' trick — overshot on the gorge's
      // near-vertical walls and drew a hard straight edge in the mist.)
      const S = 4;
      const ts = [], hs = [];
      for (let k = 0; k <= S; k++) {
        const tk = mix(t0, t1, k / S);
        const p = o.add(d.mul(tk));
        ts.push(tk);
        hs.push(p.y.sub(groundY(p.x, p.z)));
      }
      let tHit = t1;
      for (let k = S; k >= 1; k--) {
        const crosses = hs[k].lessThan(0).and(hs[k - 1].greaterThanEqual(0));
        const tk = ts[k - 1].add(ts[k].sub(ts[k - 1]).mul(hs[k - 1].div(max(hs[k - 1].sub(hs[k]), 1e-4))));
        tHit = crosses.select(tk, tHit);
      }
      tHit = hs[0].lessThan(0).select(t0, tHit);   // entering under the ground: nothing to see
      t1 = min(t1, tHit);
      // ∫ (1 - |ol + t dl|²) dt, closed form.
      const F = (t) => t.sub(cc.mul(t)).sub(bb.mul(t).mul(t)).sub(aa.mul(t).mul(t).mul(t).div(3));
      const depth = max(F(t1).sub(F(t0)), 0).mul(step01(disc));
      // Wisps: two octaves of drifting noise at the middle of the path.
      const mid = o.add(d.mul(t0.add(t1).mul(0.5)));
      const drift = time.mul(uDrift);
      const n1 = texture(noise, vec2(mid.x.add(drift), mid.z.add(drift.mul(0.4))).div(90)).r;
      const n2 = texture(noise, vec2(mid.x.sub(drift.mul(0.7)), mid.z.add(drift)).div(33)).r;
      const wisp = mix(float(1), n1.mul(0.65).add(n2.mul(0.35)).mul(1.7), uWisps);
      const tau = depth.mul(uBankDensity).mul(uDensity).mul(wisp);
      const alpha = float(1).sub(exp(tau.negate()));
      // Lit: toward the sun the mist glows warmer (forward scattering).
      const toSun = clamp(dot(d, normalize(uSun)), 0, 1);
      const col = mix(vec3(uColor), vec3(uSunTint), pow(toSun, 4).mul(0.55));
      return vec4(col, min(alpha, 0.92));
    });
    const out = shade();
    m.colorNode = out.xyz;
    m.opacityNode = out.w;
    return m;
  }

  /**
   * One bank. x/z its centre, floor the height its densest layer sits at,
   * along/across its half-lengths (m), height its half-height, rotY its
   * heading (along = its local X), density how thick (per metre at its heart).
   */
  function add({ x, z, floor, along, across, height, rotY = 0, density = 0.12, name = "bank" }) {
    const uBankDensity = uniform(density);
    const mesh = new THREE.Mesh(box, material(uBankDensity));
    mesh.name = `FogBank:${name}`;
    mesh.position.set(x, floor, z);
    mesh.rotation.y = rotY;
    mesh.scale.set(along, height, across);
    mesh.renderOrder = 11;           // after the river (10.5), before smoke (12)
    mesh.frustumCulled = true;
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.updateMatrixWorld(true);
    group.add(mesh);
    const bank = { name, mesh, uBankDensity, def: { x, z, floor, along, across, height, rotY, density } };
    banks.push(bank);
    return bank;
  }

  return {
    params: P, group, add,
    get banks() { return banks; },
    /** Per frame: the sun direction (for the warm side). */
    update() {
      const L = app.environment?.getLightDirection?.();
      if (L) uSun.value.copy(L);
    },
    set(key, value) {
      P[key] = value;
      if (key === "color") uColor.value.set(value);
      if (key === "sunTint") uSunTint.value.set(value);
      if (key === "density") uDensity.value = value;
      if (key === "drift") uDrift.value = value;
      if (key === "wisps") uWisps.value = value;
      if (key === "enabled") group.visible = !!value;
    },
    dispose() { app.scene.remove(group); box.dispose(); noise.dispose(); for (const b of banks) b.mesh.material.dispose(); },
  };
}

/**
 * WHERE, on a map with no authored banks: mist along a stretch of the river,
 * the valley floor round the temple, and one hollow in the jungle. Found from
 * the map itself (water, heights, the canopy field), so it follows the map.
 */
export function siteFogBanks(app, fog, { temples = [], field = null } = {}) {
  const W = app.worldSize ?? 1024, half = W / 2;
  const ground = (x, z) => app.getWorldHeight?.(x, z) ?? 0;
  const water = (x, z) => (app.getWaterLevelAt?.(x, z) ?? -Infinity);
  const placed = [];

  // ── The river: its middle stretch, as a chain of long banks along it ──────
  const G = 8, N = Math.floor(W / G);
  const wet = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x = -half + i * G + G / 2, z = -half + j * G + G / 2;
    if (water(x, z) > ground(x, z) + 0.3) wet.push({ x, z, y: water(x, z) });
  }
  if (wet.length > 20) {
    // Order the wet cells along the river's main direction and take the
    // stretch through the middle of the map (where the play is).
    let mx = 0, mz = 0;
    for (const w of wet) { mx += w.x; mz += w.z; }
    mx /= wet.length; mz /= wet.length;
    let sxx = 0, sxz = 0, szz = 0;
    for (const w of wet) { const dx = w.x - mx, dz = w.z - mz; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
    const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    const ax = Math.cos(ang), az = Math.sin(ang);
    const along = (w) => (w.x - mx) * ax + (w.z - mz) * az;
    // Nearest wet cells to the map's middle first, then walk ±120 m along.
    const byMid = [...wet].sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
    const c = byMid[0];
    const s0 = along(c);
    const stretch = wet.filter((w) => Math.abs(along(w) - s0) < 140);
    // Chain: every ~55 m along, a bank on the local middle of the water.
    for (let s = s0 - 120; s <= s0 + 120; s += 55) {
      const cells = stretch.filter((w) => Math.abs(along(w) - s) < 28);
      if (cells.length < 2) continue;
      let x = 0, z = 0, y = 0;
      for (const w of cells) { x += w.x; z += w.z; y += w.y; }
      x /= cells.length; z /= cells.length; y /= cells.length;
      // Local heading from the cells' own spread.
      let lxx = 0, lxz = 0, lzz = 0;
      for (const w of cells) { const dx = w.x - x, dz = w.z - z; lxx += dx * dx; lxz += dx * dz; lzz += dz * dz; }
      const la = 0.5 * Math.atan2(2 * lxz, lxx - lzz);
      placed.push(fog.add({ name: "river", x, z, floor: y + 1.5, along: 42, across: 20, height: 7, rotY: -la, density: 0.07 }));
    }
  }

  // ── The temple's valley floor ─────────────────────────────────────────────
  for (const t of temples) {
    let lo = { y: Infinity, x: t.x, z: t.z };
    for (let r = 20; r <= 160; r += 20) for (let a = 0; a < 16; a++) {
      const x = t.x + Math.cos((a / 16) * Math.PI * 2) * r, z = t.z + Math.sin((a / 16) * Math.PI * 2) * r;
      const y = ground(x, z);
      if (y < lo.y && water(x, z) < y) lo = { x, z, y };
    }
    // ON the temple, leaning a third of the way toward its low ground, the
    // densest layer just over the temple's own floor: its courts in mist and
    // its towers standing out of it. (Sited on the low ground itself, the
    // bank lay on a slope 100 m off, where nobody looks.)
    const x = (lo.x + t.x * 2) / 3, z = (lo.z + t.z * 2) / 3;
    placed.push(fog.add({ name: "temple", x, z, floor: ground(t.x, t.z) + 1.5, along: 95, across: 75, height: 10,
      rotY: -Math.atan2(lo.z - t.z, lo.x - t.x), density: 0.055 }));
  }

  // ── A hollow in the jungle: the deepest dip under the canopy ──────────────
  if (field) {
    let best = null;
    for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j++) {
      const x = -half + (i + 0.5) * (W / 60), z = -half + (j + 0.5) * (W / 60);
      if (field.open(x, z) * field.forest(x, z) < 0.5) continue;
      const y = ground(x, z);
      if (water(x, z) > y) continue;
      let ring = 0;
      for (let a = 0; a < 8; a++) ring += ground(x + Math.cos(a * 0.785) * 45, z + Math.sin(a * 0.785) * 45);
      const dip = ring / 8 - y;
      if (Math.abs(x) > half * 0.8 || Math.abs(z) > half * 0.8) continue;   // not the map's rim
      if (!best || dip > best.dip) best = { x, z, y, dip };
    }
    if (best && best.dip > 4) {
      placed.push(fog.add({ name: "hollow", x: best.x, z: best.z, floor: best.y + best.dip * 0.4,
        along: 55, across: 45, height: Math.max(8, best.dip * 0.8), density: 0.06 }));
    }
  }
  return placed;
}
