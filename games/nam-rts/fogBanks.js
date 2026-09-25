// FOG BANKS — mist at PLACES on the map, not fog by distance or height
// everywhere (your ask 2026-09-25: "realistic fog in some places, not
// everywhere… no interactive fog if it hurts the perf"). GAME code. The
// map's own fog (distance haze, the level's look) is not touched: this is a
// separate layer, drawn in the post chain's scene-colour hook, BEFORE the fog
// of war (so unexplored ground darkens its mist with it).
//
// A bank is a soft ELLIPSOID lying on the ground: stretched along a river,
// round in a valley. Its density falls off smoothly from its heart to its
// skin (1 - r² in its own frame).
//
// A SCREEN PASS WITH THE SCENE'S DEPTH, not boxes in the scene. The first
// version drew each bank as a box and ran its fog to the GROUND, so anything
// standing inside a bank — a crown, a tower — was cut by a hard line where
// the box face crossed it (your screenshot, 2026-09-25). Here every pixel
// knows the distance to the first thing it sees (the scene pass's depth,
// handed to the hook — no screen copy) and the mist stops there.
//
// Two looks, one switch (`mode`):
//   "volume"   (default) the banks RAYMARCHED at HALF resolution — the fog
//              lab's look without its simulation: 12 jittered steps through
//              a density that billows in 3D (two octaves of drifting noise,
//              offset with height), lit — bright on top, darker in its depths,
//              warmer toward the sun — then upscaled and laid over the scene
//   "analytic" the fog along the ray integrated in CLOSED FORM (the density
//              is a cubic in the ray parameter) with flat 2D wisps: cheaper,
//              and it reads as a veil rather than a volume
import * as THREE from "three";
import {
  Fn, If, clamp, dot, exp, float, fract, max, min, mix, normalize, pow, rtt,
  screenCoordinate, screenUV, smoothstep, texture, time, uniform, uniformArray, vec2, vec3, vec4,
} from "three/tsl";

export const FOG_BANK_PARAMS = {
  enabled: true,
  mode: "volume",         // "volume" | "analytic"
  color: "#e2e8e6",       // day mist: near-white, a breath of green-grey
  shade: "#9aa6a4",       // the mist's own shadowed depths (volume)
  sunTint: "#fff0d8",     // warmed where you look toward the sun
  density: 1.0,           // global multiplier on every bank's own density
  drift: 0.6,             // m/s the wisps move
  wisps: 0.75,            // 0 = smooth, 1 = strongly broken up
  steps: 12,              // volume: march steps (compile-time)
  scale: 0.5,             // volume: resolution of the march (0.5 = half)
  height: 1.0,            // every bank's height, x (3 = as deep as the canopy)
  size: 1.0,              // every bank's length and width, x
};

const MAX_BANKS = 8;

// Your settings from Dev → Fog banks outlive a reload.
const STORE = "namrts.fogBanks";
const SAVED = ["enabled", "mode", "color", "shade", "sunTint", "density", "drift", "wisps", "steps", "scale", "height", "size"];
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORE) || "null"); } catch { return null; }
}

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
  const saved = loadSaved() ?? {};
  const P = { ...FOG_BANK_PARAMS, ...params };
  for (const k of SAVED) if (saved[k] !== undefined) P[k] = saved[k];
  const uColor = uniform(new THREE.Color(P.color));
  const uShade = uniform(new THREE.Color(P.shade));
  const uSunTint = uniform(new THREE.Color(P.sunTint));
  const uDensity = uniform(P.density);
  const uDrift = uniform(P.drift);
  const uWisps = uniform(P.wisps);
  const uEnabled = uniform(P.enabled ? 1 : 0);
  const uSun = uniform(new THREE.Vector3(0.4, 0.8, 0.3));
  const uCount = uniform(0);
  // The camera, for the view ray (synced per frame, like the fog of war's).
  const uInvProj = uniform(new THREE.Matrix4());
  const uCamWorld = uniform(new THREE.Matrix4());
  const uCamPos = uniform(new THREE.Vector3());
  // Per bank: A = (centre.xyz, rotY), B = (along, height, across, density).
  const aData = Array.from({ length: MAX_BANKS }, () => new THREE.Vector4());
  const bData = Array.from({ length: MAX_BANKS }, () => new THREE.Vector4(1, 1, 1, 0));
  const uA = uniformArray(aData, "vec4");
  const uB = uniformArray(bData, "vec4");
  const noise = makeNoiseTexture();
  const banks = [];

  // ── The view ray and the distance to the first thing on it ────────────────
  const viewRay = () => {
    const ndc = vec2(screenUV.x, float(1).sub(screenUV.y)).mul(2).sub(1);
    const n4 = uInvProj.mul(vec4(ndc.x, ndc.y, -1, 1)), f4 = uInvProj.mul(vec4(ndc.x, ndc.y, 1, 1));
    const nv = n4.xyz.div(n4.w), fv = f4.xyz.div(f4.w);
    const viewDir = normalize(fv.sub(nv));
    const d = normalize(uCamWorld.mul(vec4(viewDir, 0)).xyz);
    return { d, viewDir };
  };
  /** Metres along the ray to the scene (the depth), or far for the sky. */
  const sceneDistance = (scenePass, viewDir) => {
    const viewZ = scenePass.getViewZNode();                       // negative, metres
    // (Not .min(cameraFar): in a post pass that is the screen QUAD's camera,
    // whose far plane is 1 — it clamped every distance to a metre.)
    return viewZ.div(min(viewDir.z, -1e-4)).min(1e5);
  };

  /** Bank i's frame: the ray in its unit-sphere space. */
  const bankRay = (i, o, d) => {
    const A = uA.element(i), B = uB.element(i);
    const dx = o.x.sub(A.x), dy = o.y.sub(A.y), dz = o.z.sub(A.z);
    const cr = A.w.cos(), sr = A.w.sin();
    const ol = vec3(cr.mul(dx).sub(sr.mul(dz)).div(B.x), dy.div(B.y), sr.mul(dx).add(cr.mul(dz)).div(B.z));
    const dl = vec3(cr.mul(d.x).sub(sr.mul(d.z)).div(B.x), d.y.div(B.y), sr.mul(d.x).add(cr.mul(d.z)).div(B.z));
    const aa = dot(dl, dl), bb = dot(ol, dl), cc = dot(ol, ol);
    const disc = bb.mul(bb).sub(aa.mul(cc.sub(1)));
    const sq = disc.max(0).sqrt();
    const t0 = bb.negate().sub(sq).div(aa).max(0);
    const t1 = bb.negate().add(sq).div(aa);
    const live = disc.greaterThan(0).and(float(i).lessThan(uCount));
    return { ol, dl, aa, bb, cc, t0, t1, live, rho: B.w, A, B };
  };

  const mistColor = (d, lit) => {
    const toSun = clamp(dot(d, normalize(uSun)), 0, 1);
    const base = mix(vec3(uShade), vec3(uColor), lit);
    return mix(base, vec3(uSunTint), pow(toSun, 4).mul(0.5).mul(lit));
  };

  // ── ANALYTIC: closed-form integral, flat wisps ────────────────────────────
  const analytic = (color, scenePass) => Fn(() => {
    const { d, viewDir } = viewRay();
    const o = uCamPos;
    const tScene = sceneDistance(scenePass, viewDir);
    const tau = float(0).toVar();
    for (let i = 0; i < MAX_BANKS; i++) {
      const r = bankRay(i, o, d);
      If(r.live, () => {
        const t1 = min(r.t1, tScene);
        const F = (t) => t.sub(r.cc.mul(t)).sub(r.bb.mul(t).mul(t)).sub(r.aa.mul(t).mul(t).mul(t).div(3));
        const depth = max(F(t1).sub(F(r.t0)), 0);
        const mid = o.add(d.mul(r.t0.add(t1).mul(0.5)));
        const drift = time.mul(uDrift);
        const n1 = texture(noise, vec2(mid.x.add(drift), mid.z.add(drift.mul(0.4))).div(90)).r;
        const n2 = texture(noise, vec2(mid.x.sub(drift.mul(0.7)), mid.z.add(drift)).div(33)).r;
        const wisp = mix(float(1), n1.mul(0.65).add(n2.mul(0.35)).mul(1.7), uWisps);
        tau.addAssign(depth.mul(r.rho).mul(wisp));
      });
    }
    const T = exp(tau.mul(uDensity).mul(uEnabled).negate());
    if (P.debug === 1) return vec4(vec3(tScene.div(300)), 1);
    if (P.debug === 2) return vec4(vec3(tau.div(3)), 1);
    return vec4(color.rgb.mul(T).add(mistColor(d, float(0.85)).mul(float(1).sub(T))), color.a);
  })();

  // ── VOLUME: a half-resolution march, lit ──────────────────────────────────
  const volumeNode = (scenePass) => Fn(() => {
    const STEPS = Math.max(4, Math.min(32, P.steps | 0));   // read at each (re)build
    const { d, viewDir } = viewRay();
    const o = uCamPos;
    const tScene = sceneDistance(scenePass, viewDir);
    // The span covered by any bank, cut at the scene.
    const tA = float(1e9).toVar(), tB = float(0).toVar();
    const rays = [];
    for (let i = 0; i < MAX_BANKS; i++) {
      const r = bankRay(i, o, d);
      rays.push(r);
      If(r.live, () => {
        tA.assign(min(tA, r.t0));
        tB.assign(max(tB, min(r.t1, tScene)));
      });
    }
    const T = float(1).toVar();
    const acc = vec3(0).toVar();
    If(tB.greaterThan(tA), () => {
      const dt = tB.sub(tA).div(STEPS);
      // Interleaved-gradient noise: a per-pixel offset hides the steps.
      const ign = fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715)))));
      const drift = time.mul(uDrift);
      for (let s = 0; s < STEPS; s++) {
        const t = tA.add(dt.mul(float(s).add(ign)));
        const p = o.add(d.mul(t));
        // Density: every bank's soft shape here…
        let sigma = float(0);
        let lit = float(0);
        for (let i = 0; i < MAX_BANKS; i++) {
          const r = rays[i];
          const q = r.ol.add(r.dl.mul(t));
          const shape = max(float(1).sub(dot(q, q)), 0).mul(r.live.select(1, 0));
          sigma = sigma.add(shape.mul(r.rho));
          // How high in its bank: the top of a bank catches the light.
          lit = max(lit, smoothstep(-0.6, 0.7, q.y).mul(shape.greaterThan(0).select(1, 0)));
        }
        // …broken into billows: two octaves, offset with height so it is 3D.
        const n1 = texture(noise, vec2(p.x.add(drift).add(p.y.mul(0.9)), p.z.add(drift.mul(0.4))).div(70)).r;
        const n2 = texture(noise, vec2(p.x.sub(drift.mul(0.7)), p.z.add(drift).sub(p.y.mul(1.3))).div(24)).r;
        const billow = mix(float(1), smoothstep(0.25, 0.85, n1.mul(0.65).add(n2.mul(0.35))).mul(2.0), uWisps);
        const ext = sigma.mul(billow).mul(uDensity).mul(dt);
        const a = float(1).sub(exp(ext.negate()));
        acc.addAssign(mistColor(d, lit.mul(0.8).add(n2.mul(0.2))).mul(a).mul(T));
        T.mulAssign(float(1).sub(a));
      }
    });
    // (brightness, the depth this texel saw, -, transmittance): the depth is
    // what lets the full-size pass pick the RIGHT half-size texel at an edge.
    // The mist's hue is all but constant, so brightness is all it needs.
    return vec4(dot(acc, vec3(1 / 3)), tScene.min(6e4), 0, T);
  })();

  // The half-resolution target, sized by hand (RTTNode only auto-sizes to full).
  let volRtt = null;
  function makeVolume(scenePass) {
    volRtt = rtt(volumeNode(scenePass), 1, 1, { type: THREE.HalfFloatType });
    volRtt.name = "FogBanksVolume";
    sizeVolume();
    return volRtt;
  }
  const _sz = new THREE.Vector2();
  function sizeVolume() {
    if (!volRtt) return;
    app.renderer.getDrawingBufferSize(_sz);
    const w = Math.max(1, Math.floor(_sz.x * P.scale)), h = Math.max(1, Math.floor(_sz.y * P.scale));
    const rt = volRtt.renderTarget;
    if (rt.width !== w || rt.height !== h) volRtt.setSize(w, h);
    uHalfSize.value.set(w, h);
  }
  const uHalfSize = uniform(new THREE.Vector2(1, 1));

  /**
   * DEPTH-AWARE UPSCALE. A plain bilinear stretch of the half-size mist bled
   * it across every edge — each half-size texel spans leaf AND gap, and the
   * crowns came out speckled white. Each full-size pixel takes its four
   * half-size neighbours, weighted by how close the depth THEY saw is to its
   * own: a leaf takes the leaf's mist, the gap beside it the gap's.
   */
  const composite = (color, scenePass, vol) => Fn(() => {
    const { d, viewDir } = viewRay();
    const tFull = sceneDistance(scenePass, viewDir).min(6e4);
    const g = screenUV.mul(uHalfSize).sub(0.5);
    const base = g.floor(), f = g.fract();
    // `vol` itself stays in the graph (×0) so its pass still renders each
    // frame; the four taps read its texture at exact texel centres.
    let wSum = float(1e-5).add(vol.a.mul(0)), lum = float(0), T = float(0);
    for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const v = texture(vol.value, base.add(vec2(cx + 0.5, cy + 0.5)).div(uHalfSize));
      const wb = (cx ? f.x : float(1).sub(f.x)).mul(cy ? f.y : float(1).sub(f.y));
      const rel = v.g.sub(tFull).abs().div(max(tFull, 1));
      const w = wb.add(0.02).mul(exp(rel.mul(-40)));
      wSum = wSum.add(w);
      lum = lum.add(v.r.mul(w));
      T = T.add(v.a.mul(w));
    }
    lum = lum.div(wSum);
    T = T.div(wSum);
    const hue = mistColor(d, float(1));
    const mist = hue.mul(lum.div(max(dot(hue, vec3(1 / 3)), 1e-3)));
    return vec4(mix(color.rgb, color.rgb.mul(T).add(mist), uEnabled), color.a);
  })();

  /** The post hook: (sceneColor, { scenePass }) → sceneColor with the mist. */
  function node(color, ctx = {}) {
    const scenePass = ctx.scenePass;
    if (!scenePass || !banks.length) return color;
    if (P.mode === "analytic") return analytic(color, scenePass);
    return composite(color, scenePass, makeVolume(scenePass));
  }

  function sync() {
    uCount.value = Math.min(MAX_BANKS, banks.length);
    for (let i = 0; i < MAX_BANKS; i++) {
      const b = banks[i]?.def;
      if (!b) { bData[i].set(1, 1, 1, 0); continue; }
      aData[i].set(b.x, b.floor, b.z, b.rotY);
      // Height and Size scale every bank (Dev → Fog banks): a bank as deep as
      // the canopy is what swallows the trees whole.
      bData[i].set(b.along * P.size, b.height * P.height, b.across * P.size, b.density);
    }
  }

  /**
   * One bank. x/z its centre, floor the height its densest layer sits at,
   * along/across its half-lengths (m), height its half-height, rotY its
   * heading (along = its local X), density how thick (per metre at its heart).
   */
  function add({ x, z, floor, along, across, height, rotY = 0, density = 0.12, name = "bank" }) {
    if (banks.length >= MAX_BANKS) { console.warn("[fog banks] at most", MAX_BANKS); return null; }
    const bank = { name, def: { x, z, floor, along, across, height, rotY, density, sited: density } };
    banks.push(bank);
    sync();
    return bank;
  }

  /** Mode and steps are baked into the shader: the game rebuilds the post hook. */
  let onRebuild = null;
  const rebuild = () => onRebuild?.();
  const save = () => {
    try {
      const keep = {};
      for (const k of SAVED) keep[k] = P[k];
      keep.banks = banks.map((b) => b.def.density);
      localStorage.setItem(STORE, JSON.stringify(keep));
    } catch { /* private window */ }
  };

  return {
    params: P, add, node, sync,
    get banks() { return banks; },
    /** The game hands in how to rebuild its post hook (mode / steps changes). */
    set onRebuild(fn) { onRebuild = fn; },
    /** One bank's own density (per metre at its heart). */
    setBankDensity(i, v) {
      const b = banks[i];
      if (!b) return;
      b.def.density = v;
      sync();
      save();
    },
    /** Back to the defaults, the banks to the densities they were sited with. */
    reset() {
      try { localStorage.removeItem(STORE); } catch { /* ignore */ }
      for (const k of SAVED) this.set(k, FOG_BANK_PARAMS[k], { quiet: true });
      for (const b of banks) b.def.density = b.def.sited;
      sync();
      rebuild();
    },
    /** After siting: your saved per-bank densities, if the banks are the same set. */
    restoreBanks() {
      const saved = loadSaved()?.banks;
      if (!Array.isArray(saved) || saved.length !== banks.length) return;
      saved.forEach((v, i) => { if (Number.isFinite(v)) banks[i].def.density = v; });
      sync();
    },
    /** Per frame: the camera and the sun, and the half-res target's size. */
    update() {
      const cam = app.camera;
      uInvProj.value.copy(cam.projectionMatrixInverse);
      uCamWorld.value.copy(cam.matrixWorld);
      uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
      const L = app.environment?.getLightDirection?.();
      if (L) uSun.value.copy(L);
      sizeVolume();
    },
    set(key, value, { quiet = false } = {}) {
      P[key] = value;
      if (key === "color") uColor.value.set(value);
      if (key === "shade") uShade.value.set(value);
      if (key === "sunTint") uSunTint.value.set(value);
      if (key === "density") uDensity.value = value;
      if (key === "drift") uDrift.value = value;
      if (key === "wisps") uWisps.value = value;
      if (key === "enabled") uEnabled.value = value ? 1 : 0;
      if (key === "scale") sizeVolume();
      if (key === "height" || key === "size") sync();
      if (!quiet && (key === "mode" || key === "steps")) rebuild();
      if (!quiet) save();
    },
    dispose() { noise.dispose(); volRtt?.renderTarget?.dispose(); },
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
      placed.push(fog.add({ name: "river", x, z, floor: y + 1.5, along: 42, across: 20, height: 7, rotY: -la, density: 0.13 }));
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
        along: 55, across: 45, height: Math.max(8, best.dip * 0.8), density: 0.09 }));
    }
  }
  return placed;
}
