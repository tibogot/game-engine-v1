/**
 * SMOKE — one draw, no per-frame particle work, and it blocks line of sight.
 *
 * TWO REPRESENTATIONS, ONE TRUTH. The SIM owns a handful of analytic columns
 * (a position, a radius that blooms, an age); the RENDERER makes each column
 * look like smoke with a few hundred puffs. Sight is tested against the
 * COLUMNS, never against the puffs.
 *
 * That split is the whole design, and either half alone would be wrong.
 * Testing sight against particles would be non-deterministic — they are a
 * function of render time, which differs per machine and per frame rate — and
 * expensive. Drawing only the column would look like a cylinder. A screening
 * grenade has to mean the same thing everywhere, so the thing that MEANS
 * something is a couple of dozen numbers, and the thing that is beautiful is
 * 3,072 quads that nothing depends on.
 *
 * ── NO PER-FRAME PARTICLE WORK ──────────────────────────────────────────────
 *
 * A puff's position is an ANALYTIC function of (its own stable seed, its
 * source's age, the clock). There is no compute pass and no instance buffer
 * rewrite: the vertex stage rebuilds every puff from a uniform row and two
 * attributes. Writing ~24 source rows is the entire per-frame CPU cost.
 *
 * The engine's ambient FX uses a compute pass because its particles wrap
 * around a moving camera and read painted density — they cannot be written
 * down as a formula. Smoke can, so it should be. The trade is real and worth
 * naming: these puffs cannot collide, be pushed by a passing helicopter, or
 * respond to anything the formula does not already contain. If smoke ever
 * needs rotor wash, this becomes a compute field and the LOS half stays as is.
 *
 * ── WHY NOT A FLIPBOOK ──────────────────────────────────────────────────────
 *
 * A flipbook card is a billboard, and from a camera that ORBITS at a fixed
 * pitch a column of billboards gives itself away: the silhouette never changes
 * as you turn with Q/E. Ground-level games get away with it. Here the
 * silhouette has to come from the arrangement of many differently sized puffs,
 * which reads from any angle because it really is three-dimensional.
 *
 * Fire is the opposite case and stays as it is in fireSystem.js: emissive,
 * fast, self-similar and small on screen, which is exactly what a flipbook or
 * a noise field is good at.
 *
 * ── BLENDING ────────────────────────────────────────────────────────────────
 *
 * Transparent, depth-tested, depth-write OFF, and deliberately UNSORTED. 3,072
 * quads inside one instanced draw cannot be sorted, and for smoke that is
 * acceptable precisely because the medium is near-uniform in colour: two puffs
 * of the same grey in the wrong order produce nearly the same pixel. This
 * would be indefensible for anything with varied colour, and it is the reason
 * each preset's two colours are close together rather than a wide ramp.
 */
import * as THREE from "three";
import {
  Fn, attribute, cameraPosition, cameraWorldMatrix, cos, dot, float, floor, fract, int,
  max, mix, normalize, positionLocal, pow, saturate, sin, smoothstep, step, texture, uniform,
  uniformArray, uv, varying, vec2, vec3, vec4,
} from "three/tsl";

/**
 * ── THE FLIPBOOK LOOK (2026-09-24) ──────────────────────────────────────────
 *
 * Each puff can wear a frame of your modular-road smoke atlas (Unity Labs'
 * CC0 "WispySmoke", 8x8 frames, RGB = baked self-shadow grey, A = density)
 * instead of the procedural soft disc. Only the PIXELS change: the columns,
 * the sight rule, the budget and the one draw are exactly as before, and so
 * is the 3D arrangement of the puffs that gives a column its silhouette from
 * every Q/E angle. The note below ("why not a flipbook") argued against a FEW
 * BIG cards; many small textured puffs is how Company of Heroes does it.
 *
 * Every puff loops the atlas from its own start frame and crossfades between
 * adjacent frames, so nothing animates in step and there is no frame-step
 * tell. `setLook("procedural")` brings the old disc back for an A/B.
 */
export const SMOKE_ATLAS = {
  url: "/textures/smoke/wispy02_8x8.png",
  cols: 8, rows: 8, size: 1024,
  fps: 12,
  /** The atlas's own alpha is thin (mean ~0.22 in 02); this sets the puff's. */
  alphaMul: 2.2,
  /** Brightness of the baked grey (linear mean ~0.13 in 02, so this is a lift). */
  bakedGain: 3.2,
};

/** Columns the sim can hold at once. Sight tests are O(this) per query. */
export const MAX_SOURCES = 24;
/** Puffs per column. The silhouette comes from this many, at varied sizes. */
export const PUFFS_PER_SOURCE = 128;

/**
 * THE RENDER BUDGET — columns' worth of full-detail puffs, however many burn.
 *
 * Smoke is the one battle effect that costs real frame time, and all of it is
 * pixels: MEASURED at full zoom-out, 4 / 12 / 24 columns = +0.2 / +2.0 / +4.4 ms
 * at 1919x888 (12.5 ms at 2x), ~0.18 ms a column. Up to this many columns draw
 * all their puffs; past it, EVERY column draws a share, so the whole field
 * costs about this many columns' worth. A cap on the LOOK, never on the rule:
 * the sim still holds MAX_SOURCES columns and every one of them still blocks
 * sight exactly as before — nobody loses a smoke screen to a perf setting.
 */
export const FULL_DETAIL_COLUMNS = 8;
/** Share of the rank range over which a dropped puff fades rather than pops. */
const PUFF_FADE_BAND = 0.1;
/** Seconds the drawn share takes to follow a change (a column lit or gone). */
const KEEP_EASE = 0.8;
/** Surviving puffs scale by keep^-this (see the vertex stage). */
const SIZE_COMPENSATION = 0.2;

/** vec4 rows per source in the uniform array. */
const ROWS = 5;

/**
 * Presets.
 *
 * `losOpacity` is the SIM number — how much of a sight line one full-strength
 * column eats — and is deliberately separate from `density`, which is only how
 * thick it looks. Smoke can be made prettier without changing the game, and
 * balance can change without touching the shader. Violet sits at 0 on purpose:
 * a capture marker that blinded people would be a trap, not a signal.
 *
 * `density` is the alpha of ONE puff, and it is low on purpose. A hundred
 * puffs at 0.8 read as a hundred distinct bubbles, because the eye finds the
 * edge of every one; the same hundred at 0.25 pile up into something with no
 * countable parts, which is what smoke is. Thickness comes from overlap.
 *
 * `puffLife` is how long one puff takes to climb `height`, in seconds, and is
 * independent of `life` — see the note in the vertex stage.
 */
export const SMOKE_KINDS = {
  /** M18 violet — the Apocalypse Now capture marker. A signal, not cover. */
  violet: {
    colorLow: 0x7d3a93, colorHigh: 0xe089ff,
    puffLife: 6.0, spread: 0.28, radius: 3.4, growth: 1.0, height: 34, bloom: 2.0,
    puffSize: 2.4, puffGrow: 2.6, density: 0.20, losOpacity: 0.0, life: 14,
  },
  /** A screening grenade: low, wide, and it really does blind. */
  screen: {
    colorLow: 0x63605b, colorHigh: 0xaeaaa2,
    puffLife: 6.5, spread: 0.40, radius: 9.0, growth: 3.2, height: 13, bloom: 3.5,
    puffSize: 4.8, puffGrow: 2.0, density: 0.26, losOpacity: 0.85, life: 22,
  },
  /** Oily black off a burning wreck — thin, fast, leaning. */
  wreck: {
    colorLow: 0x1a1714, colorHigh: 0x4a443e,
    puffLife: 5.0, spread: 0.32, radius: 2.2, growth: 1.2, height: 38, bloom: 4.0,
    puffSize: 2.2, puffGrow: 3.2, density: 0.22, losOpacity: 0.25, life: 30,
  },
  /** Napalm: a broad low pall that hangs over the burn. */
  napalm: {
    colorLow: 0x140f0c, colorHigh: 0x574839,
    puffLife: 7.5, spread: 0.35, radius: 13, growth: 3.0, height: 30, bloom: 3.0,
    puffSize: 6.5, puffGrow: 2.4, density: 0.32, losOpacity: 0.60, life: 40,
  },
};

/**
 * How much smoke sits between two points, 0..1.
 *
 * ── THIS IS BEER-LAMBERT, NOT A COVERAGE FRACTION ───────────────────────────
 *
 * Optical depth accumulates along the path and the answer is 1 - exp(-tau).
 * The obvious alternative — what fraction of the sight line is inside a cloud
 * — is wrong in a way that only shows up in play: a 24 m cloud across a 120 m
 * line would come out at 0.2, so a grenade that visibly blots out its target
 * would never cross a 0.5 threshold, while the SAME cloud at 30 m range would
 * read 0.8. How far away the shooter is standing does not change how much
 * smoke is in the way.
 *
 * ── AND A GAUSSIAN COLUMN, NOT A CYLINDER ───────────────────────────────────
 *
 * Column density falls off smoothly from the centre instead of being a hard
 * disc. A cylinder's chord is 2*sqrt(R^2 - d^2), whose slope is INFINITE at
 * the rim: a unit sidestepping one metre near the edge would jump from seen to
 * hidden. Smoke does not have an edge, and modelling it as if it did produces
 * exactly the flicker the chord was meant to avoid. The Gaussian has bounded
 * slope everywhere and is cheaper — no square root.
 *
 * `losOpacity` is calibrated as "occlusion straight through the middle of a
 * fully bloomed cloud", so the preset number means something a designer can
 * reason about, and the extinction coefficient is derived from it.
 *
 * Flat in XZ on purpose: these are RTS units on the ground, and a column tall
 * enough to matter reaches far above every one of them.
 *
 * Pure, and exported separately from the field, so the half the game depends
 * on can be tested without a GPU.
 */
export function occlusionAlong(sources, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const segLen = Math.hypot(dx, dz);
  if (segLen < 1e-3) return 0;
  const inv = 1 / (segLen * segLen);
  let tau = 0;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (!s.alive) continue;
    const k = SMOKE_KINDS[s.kind] ?? SMOKE_KINDS.screen;
    if (k.losOpacity <= 0) continue;
    // The same bloom and fade curves the shader uses, so a cloud starts and
    // stops blocking at the moment it starts and stops looking thick.
    const bloom = Math.min(1, s.age / Math.max(0.01, k.bloom));
    const fade = 1 - Math.max(0, (s.age - s.life * 0.55) / Math.max(0.01, s.life * 0.45));
    const amount = s.strength * bloom * Math.max(0, Math.min(1, fade));
    if (amount <= 0) continue;

    const R = (k.radius + k.growth) * (0.35 + 0.65 * bloom);
    // Closest approach of the SEGMENT (clamped, not the infinite line) — a
    // cloud sitting behind the shooter must not block.
    const t = Math.max(0, Math.min(1, ((s.x - ax) * dx + (s.z - az) * dz) * inv));
    const cx = ax + dx * t, cz = az + dz * t;
    const d2 = (s.x - cx) ** 2 + (s.z - cz) ** 2;
    // Past ~2.2 R the Gaussian is under 1e-5. Cutting it here makes distant
    // clouds cost one compare and makes "blocks nothing" exactly zero.
    const cut = R * 2.2;
    if (d2 >= cut * cut) continue;

    const dMax = 2 * (k.radius + k.growth);              // full-bloom diameter
    const sigma = -Math.log(1 - Math.min(0.999, k.losOpacity)) / dMax;
    // How much smoke the path crosses, capped by the path itself: two units
    // five metres apart INSIDE a cloud have only five metres between them.
    const column = Math.min(segLen, 2 * R * Math.exp(-2.5 * d2 / (R * R)));
    tau += sigma * column * amount;
  }
  return tau <= 0 ? 0 : 1 - Math.exp(-tau);
}

/** Age the columns. Pure over the list, so the test can drive it too. */
export function stepSources(sources, dt) {
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (!s.alive) continue;
    s.age += dt;
    if (s.age >= s.life) s.alive = false;
  }
}

/**
 * @param {object} o
 *   app             the v3 engine handle (scene, getWorldHeight)
 *   maxSources      simultaneous columns
 *   puffsPerSource  quads per column
 */
export function createSmokeField({
  app, maxSources = MAX_SOURCES, puffsPerSource = PUFFS_PER_SOURCE,
} = {}) {
  const scene = app.scene;
  const count = maxSources * puffsPerSource;

  // ── SIM state. Plain objects: there are at most a couple of dozen. ─────────
  const sources = Array.from({ length: maxSources }, () => ({
    alive: false, x: 0, y: 0, z: 0, kind: "screen", age: 0, life: 0, strength: 1,
  }));

  // ── The uniform rows the vertex stage reads ───────────────────────────────
  //   0  x, y, z, sourceAge          (age < 0 = dead; the quad collapses)
  //   1  puffLife, swirl (fraction of the local radius), columnRadius, columnHeight
  //   2  puffSize, puffGrow, per-puff alpha, sourceLife
  //   3  colorLow.rgb, -
  //   4  colorHigh.rgb, -
  const rowData = Array.from({ length: maxSources * ROWS }, () => new THREE.Vector4());
  const uRows = uniformArray(rowData, "vec4");
  const uTime = uniform(0);
  const uSunDir = uniform(new THREE.Vector3(0.5, 0.6, 0.4).normalize());
  const uOpacity = uniform(1);
  // Share of each column's puffs drawn (see FULL_DETAIL_COLUMNS), eased.
  const uKeep = uniform(1);

  // ── Geometry: one quad per puff, rebuilt in the vertex stage ──────────────
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.attributes.position = quad.attributes.position;
  geo.attributes.uv = quad.attributes.uv;
  geo.instanceCount = count;
  const seeds = new Float32Array(count);
  const slots = new Float32Array(count);
  const ranks = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    seeds[i] = (i * 0.6180339887498949) % 1;   // golden ratio: even, no clumps
    slots[i] = Math.floor(i / puffsPerSource);
    // A puff's place in its column, 0..1. The budget keeps the LOWEST ranks,
    // and because the seeds are a golden-ratio sequence, any prefix of a
    // column is itself evenly spread — dropping the top half leaves an even
    // half, not a lopsided column.
    ranks[i] = (i % puffsPerSource) / puffsPerSource;
  }
  geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
  geo.setAttribute("aSlot", new THREE.InstancedBufferAttribute(slots, 1));
  geo.setAttribute("aRank", new THREE.InstancedBufferAttribute(ranks, 1));
  quad.dispose();

  // FrontSide, and it matters: three renders a DOUBLE-sided TRANSPARENT
  // material in two passes to sort back faces against front. A quad built from
  // the camera's own right and up never shows its back, so one pass is right.
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    side: THREE.FrontSide, toneMapped: true,
  });
  material.name = "NamSmoke";
  material.fog = true;

  const vAlpha = varying(float(0), "v_sm_a");
  const vCol = varying(vec3(0), "v_sm_c");
  // The puff's own seed, for its flipbook start frame.
  const vSeed = varying(float(0), "v_sm_s");

  // The flipbook atlas, loaded once; until it arrives the look stays procedural.
  const uFlip = uniform(0);          // 1 = flipbook look, 0 = procedural disc
  let wantFlip = true;
  const atlas = new THREE.TextureLoader().load(SMOKE_ATLAS.url, () => { uFlip.value = wantFlip ? 1 : 0; });
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;

  material.positionNode = Fn(() => {
    const seed = attribute("aSeed", "float");
    const base = int(attribute("aSlot", "float")).mul(ROWS);
    const r0 = uRows.element(base);
    const r1 = uRows.element(base.add(1));
    const r2 = uRows.element(base.add(2));
    const cLow = uRows.element(base.add(3)).xyz;
    const cHigh = uRows.element(base.add(4)).xyz;

    const srcAge = r0.w;
    const life = max(r2.w, float(0.01));

    // A puff's own age cycles independently, offset by its seed, so a column is
    // a continuous stream rather than a pulse.
    //
    // puffLife is the kind's OWN number and not derived from the source's life,
    // which it used to be. That coupling was wrong in a way worth recording:
    // a long-lived source stretched every puff's rise to match, so asking for a
    // fifteen-minute marker sent its puffs two kilometres into the air. How
    // fast smoke climbs and how long a grenade burns are unrelated facts.
    const t = fract(uTime.div(r1.x).add(seed)).toVar();

    // Three stable randoms per puff: where it sits on the disc, how far out,
    // and how big it is.
    const h1 = fract(sin(seed.mul(127.1)).mul(43758.5453));
    const h2 = fract(sin(seed.mul(311.7)).mul(21943.1));
    const h3 = fract(sin(seed.mul(74.7)).mul(9137.77));

    const rise = t.mul(r1.w);   // t maps straight onto the column's height

    // The COLUMN blooms with the SOURCE's age — a grenade opens out over its
    // first seconds rather than arriving at full width. Same bloom curve
    // occlusionAlong() uses, so what you see is what blocks.
    const bloom = saturate(srcAge.div(max(uRows.element(base.add(3)).w, float(0.01))));
    // ...and each puff drifts outward as it climbs, which is what gives a
    // plume its cone. EVERYTHING horizontal is a fraction of this one radius,
    // so a column can never wander outside the cylinder the sim is testing.
    const rNow = r1.z.mul(mix(float(0.35), float(1), bloom)).mul(mix(float(0.4), float(1), t));

    // sqrt of a uniform random fills a disc evenly; without it every column has
    // a dense core and a bald rim.
    const ring = h1.mul(6.2831);
    const rad = pow(h2, float(0.5)).mul(rNow);
    // Two out-of-phase circles at different rates read as billowing; one alone
    // reads as a corkscrew. Scaled by the local radius, not by absolute height.
    const swirl = rNow.mul(r1.y);
    const a1 = seed.mul(6.2831).add(t.mul(2.2));
    const a2 = seed.mul(11.7).sub(t.mul(1.35));
    const offX = cos(a1).mul(swirl).add(cos(a2).mul(swirl.mul(0.5)));
    const offZ = sin(a1).mul(swirl).add(sin(a2).mul(swirl.mul(0.5)));

    const world = vec3(r0.x, r0.y, r0.z).add(vec3(
      cos(ring).mul(rad).add(offX),
      rise,
      sin(ring).mul(rad).add(offZ),
    )).toVar();

    // Varied per puff AND growing as it disperses. The variation matters more
    // than it sounds: a column of equal-sized blobs reads as bubbles, because
    // a repeated circle is the one shape the eye refuses to merge.
    // Under the render budget each surviving puff grows a little to close the
    // gaps its dropped neighbours leave — keep^-0.2: 1.25x at a third drawn.
    // Bigger puffs cost pixels, so this gives back part of the saving; it is
    // the price of the column staying a haze instead of turning into lumps.
    const budgetGrow = pow(max(uKeep, float(0.05)), float(-SIZE_COMPENSATION));
    const size = r2.x.mul(mix(float(0.55), float(1.5), h3)).mul(mix(float(1), r2.y, t)).mul(budgetGrow);

    // ── FADES, all multiplied into one alpha ──
    const fadeIn = smoothstep(float(0), float(0.12), t);
    const fadeOut = float(1).sub(smoothstep(float(0.45), float(1), t));
    // The source: in fast, out slowly over its last 45%.
    const srcFade = saturate(srcAge.div(1.2))
      .mul(float(1).sub(smoothstep(life.mul(0.55), life, srcAge)));
    // A dead slot carries age -1. Rather than branch, the gate collapses the
    // quad to a point AND zeroes its alpha, so the instance costs one vertex
    // shader and no fragments.
    const liveGate = saturate(srcAge.mul(1e6));
    // The render budget: puffs ranked past the drawn share collapse the same
    // way a dead slot does (one vertex shader, no fragments), and the ones
    // just inside it fade over PUFF_FADE_BAND, so a share that moves makes
    // puffs thin away rather than blink out.
    const rank = attribute("aRank", "float");
    // Stretched by the band so a share of 1 leaves every puff at full alpha —
    // the unbudgeted look, untouched.
    const keepGate = smoothstep(float(0), float(PUFF_FADE_BAND), uKeep.mul(1 + PUFF_FADE_BAND).sub(rank));
    const drawGate = liveGate.mul(keepGate);
    vAlpha.assign(fadeIn.mul(fadeOut).mul(srcFade).mul(r2.z).mul(uOpacity).mul(drawGate));
    vSeed.assign(seed);

    // ── LIGHT ──
    // This is what stops smoke reading as grey paint. The top of a column sees
    // the sky and the sun; the base sits in the column's own shadow. Plus a
    // forward-scattering rim toward the sun — a plume between you and a low
    // sun GLOWS at its edge, and with the map's sun at 29 degrees that happens
    // constantly.
    const up = saturate(rise.div(max(r1.w, float(1))));
    const lit = mix(cLow, cHigh, saturate(up.mul(0.85).add(0.15)));
    const fromCam = normalize(world.sub(cameraPosition));
    const rim = pow(saturate(dot(fromCam, uSunDir)), float(3.0)).mul(0.22);
    vCol.assign(lit.add(vec3(rim).mul(mix(float(0.35), float(1), up))));

    // ── The camera-facing quad ──
    const camRight = cameraWorldMatrix[0].xyz;
    const camUp = cameraWorldMatrix[1].xyz;
    const corner = positionLocal.xy.mul(size).mul(step(float(1e-5), drawGate));
    return world.add(camRight.mul(corner.x)).add(camUp.mul(corner.y));
  })();

  // A soft round puff. Squaring the falloff gives a dense core with a long
  // thin edge, which is also what keeps a quad from showing a hard line where
  // it crosses the ground — no depth texture needed.
  // The flipbook frame for this puff: a looping frame index from its own start,
  // and the two neighbouring cells blended by the fraction between them.
  const F = SMOKE_ATLAS;
  const frames = F.cols * F.rows;
  const inset = 0.5 / (F.size / F.cols);          // half a texel, in cell units
  const cellUV = (idx) => {
    const col = idx.mod(F.cols), row = floor(idx.div(F.cols));
    // Rows run top to bottom in the atlas; three's v runs up.
    const local = uv().clamp(inset, 1 - inset);
    return vec2(col.add(local.x).div(F.cols), float(F.rows - 1).sub(row).add(local.y).div(F.rows));
  };
  const flipbook = Fn(() => {
    const f = vSeed.mul(frames).add(uTime.mul(F.fps));
    const f0 = floor(f).mod(frames), f1 = f0.add(1).mod(frames);
    const a = texture(atlas, cellUV(f0)), b = texture(atlas, cellUV(f1));
    return mix(a, b, fract(f));
  });

  material.colorNode = Fn(() => {
    const d = uv().sub(0.5).length().mul(2);
    const soft = float(1).sub(smoothstep(float(0.2), float(1), d));
    // The flipbook: the atlas's density, and its baked self-shadow on the
    // game's light. The procedural disc stays as the other side of the mix.
    const fb = flipbook();
    const fbAlpha = fb.a.mul(F.alphaMul).min(1);
    const shape = mix(soft.mul(soft), fbAlpha, uFlip);
    const shade = mix(float(1), fb.rgb.x.mul(F.bakedGain).min(1.4), uFlip);
    const a = vAlpha.mul(shape);
    // Fewer layers, same smoke: k layers of alpha a let through (1 - a)^k, so
    // a share `keep` of them must each let through (1 - a)^(1/keep) to leave
    // the column as opaque as before — the same Beer-Lambert the sight rule
    // uses. At keep = 1 this is a exactly.
    const keep = max(uKeep, float(0.05));
    return vec4(vCol.mul(shade), float(1).sub(pow(float(1).sub(a.min(0.999)), float(1).div(keep))));
  })();

  const mesh = new THREE.Mesh(geo, material);
  // The puffs are placed in world space by the vertex stage, so the geometry's
  // own bound means nothing — culling it would cull the whole field at once.
  mesh.frustumCulled = false;
  mesh.renderOrder = 12;    // after opaque, before the HUD
  mesh.name = "NamSmoke";
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  scene.add(mesh);

  const budget = { fullColumns: FULL_DETAIL_COLUMNS, viewKeep: 1 };

  const _c = new THREE.Color();
  function writeSlot(i) {
    const s = sources[i];
    const k = SMOKE_KINDS[s.kind] ?? SMOKE_KINDS.screen;
    const o = i * ROWS;
    rowData[o].set(s.x, s.y, s.z, s.alive ? s.age : -1);
    rowData[o + 1].set(k.puffLife, k.spread, k.radius + k.growth, k.height);
    rowData[o + 2].set(k.puffSize, k.puffGrow, k.density * s.strength, s.life || k.life);
    _c.set(k.colorLow); rowData[o + 3].set(_c.r, _c.g, _c.b, k.bloom);
    _c.set(k.colorHigh); rowData[o + 4].set(_c.r, _c.g, _c.b, 0);
  }
  for (let i = 0; i < maxSources; i++) writeSlot(i);

  const api = {
    mesh,
    sources,
    params: { uOpacity },

    /**
     * Start a column. Oldest-first reuse when full, so a fresh grenade is
     * never silently dropped — losing the oldest column is the lesser
     * surprise, and it is the one already fading.
     * @returns {number} slot index
     */
    spawn({ x, z, y = null, kind = "screen", life = null, strength = 1 } = {}) {
      let slot = sources.findIndex((s) => !s.alive);
      if (slot < 0) {
        slot = 0;
        for (let i = 1; i < maxSources; i++) if (sources[i].age > sources[slot].age) slot = i;
      }
      const k = SMOKE_KINDS[kind] ?? SMOKE_KINDS.screen;
      const s = sources[slot];
      s.alive = true; s.kind = kind; s.age = 0;
      s.life = life ?? k.life; s.strength = strength;
      s.x = x; s.z = z;
      s.y = (y ?? app.getWorldHeight?.(x, z) ?? 0) + 0.3;
      writeSlot(slot);
      return slot;
    },

    /** Put a column out early — it fades rather than vanishing. */
    extinguish(slot) {
      const s = sources[slot];
      if (!s?.alive) return;
      s.age = Math.max(s.age, s.life * 0.6);
      writeSlot(slot);
    },

    /** FIXED-STEP. Ages the columns; the puffs read the render clock instead. */
    step(dt) {
      stepSources(sources, dt);
      for (let i = 0; i < maxSources; i++) if (rowData[i * ROWS].w >= 0 || sources[i].alive) writeSlot(i);
    },

    /** PER FRAME — the clock the puffs ride, and the sun they are lit by. */
    render(elapsed, sunDir) {
      const dt = Math.min(0.25, Math.max(0, elapsed - uTime.value));
      uTime.value = elapsed;
      if (sunDir) uSunDir.value.copy(sunDir).normalize();
      // The drawn share: every puff up to `fullColumns` live columns, then a
      // share that keeps the field at about that many columns' worth — times
      // whatever the game asks for the current view. Eased, so a column lit
      // or burnt out thins the others gradually instead of at once.
      let live = 0;
      for (const s of sources) if (s.alive) live++;
      const target = Math.min(1, budget.fullColumns / Math.max(1, live)) * budget.viewKeep;
      const k = dt > 0 ? 1 - Math.exp(-dt / KEEP_EASE * 3) : 1;
      uKeep.value += (target - uKeep.value) * k;
    },

    /**
     * The render budget (see FULL_DETAIL_COLUMNS). `fullColumns`: how many
     * columns may draw every puff before all of them share. `viewKeep` 0..1: a
     * further share for the current view, e.g. from camera zoom — looking
     * straight down a column stacks all its puffs on the same pixels. Neither
     * touches the sim: sight is still tested against every live column.
     */
    setBudget({ fullColumns, viewKeep } = {}) {
      if (Number.isFinite(fullColumns)) budget.fullColumns = Math.max(1, fullColumns);
      if (Number.isFinite(viewKeep)) budget.viewKeep = Math.max(0.05, Math.min(1, viewKeep));
    },
    get budget() { return { ...budget, drawn: uKeep.value }; },

    /** "flipbook" (default) or "procedural" — the A/B for the puffs' look. */
    setLook(look) {
      wantFlip = look !== "procedural";
      if (atlas.image) uFlip.value = wantFlip ? 1 : 0;
    },
    get look() { return uFlip.value > 0.5 ? "flipbook" : "procedural"; },

    /** How much smoke sits between two points, 0..1. See occlusionAlong. */
    occlusionBetween(ax, az, bx, bz) { return occlusionAlong(sources, ax, az, bx, bz); },

    /** True when the line is smoked enough to break a lock. */
    blocksLineOfSight(ax, az, bx, bz, threshold = 0.5) {
      return api.occlusionBetween(ax, az, bx, bz) >= threshold;
    },

    /** Live columns, for the HUD and for tests. */
    activeCount() { return sources.reduce((n, s) => n + (s.alive ? 1 : 0), 0); },

    clear() {
      for (let i = 0; i < maxSources; i++) { sources[i].alive = false; writeSlot(i); }
    },
    dispose() { scene.remove(mesh); geo.dispose(); material.dispose(); },
  };
  return api;
}
