/**
 * Sun-anchored lens flare (no post-processing), ported from `splatmap-chunks.html`.
 * Group follows the camera; quads in camera-local space. Uses TSL `MeshBasicNodeMaterial`.
 */
import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import { mul, texture, uniform, uv, vec2, vec3, dot, exp } from "three/tsl";

function makeRadialTex(size, power, innerWhite) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const half = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half) / half;
      const dy = (y - half) / half;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const a = Math.pow(1 - r, power);
      const core = innerWhite ? Math.pow(1 - r, power * 3) : 0;
      const v = Math.min(1, a + core);
      const idx = (y * size + x) * 4;
      img.data[idx] = 255;
      img.data[idx + 1] = 255;
      img.data[idx + 2] = 255;
      img.data[idx + 3] = Math.round(v * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * ANAMORPHIC STREAK. The old one was a radial gradient stretched sideways, which reads
 * as a smear. A real anamorphic flare has a razor-thin bright core with a much softer,
 * wider skirt, and it is not uniform along its length — it breaks into fine bands where
 * the lens coatings interfere. Both are baked here: two Gaussians of very different
 * width, and a band-limited grain along x.
 */
function makeStreakTex(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(w, h);
  // Band-limited grain along the streak: a smoothed random walk, so the bands are a
  // few pixels wide rather than per-pixel noise.
  const bands = new Float32Array(w);
  let v = 0.5;
  for (let x = 0; x < w; x++) { v += (Math.random() - 0.5) * 0.35; v = Math.max(0.15, Math.min(1, v * 0.96 + 0.02)); bands[x] = v; }
  for (let y = 0; y < h; y++) {
    const ny = (y + 0.5) / h * 2 - 1;
    const core = Math.exp(-ny * ny * 42);
    const skirt = Math.exp(-ny * ny * 5) * 0.28;
    for (let x = 0; x < w; x++) {
      const nx = (x + 0.5) / w * 2 - 1;
      const len = Math.pow(Math.max(0, 1 - Math.abs(nx)), 1.35);
      const grain = 0.62 + 0.38 * bands[x];
      const a = Math.min(1, (core + skirt) * len * grain);
      const idx = (y * w + x) * 4;
      img.data[idx] = 255;
      img.data[idx + 1] = 255;
      img.data[idx + 2] = 255;
      img.data[idx + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function makeHexTex(size) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const cx = size * 0.5;
  const cy = size * 0.5;
  const r = size * 0.42;
  const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.6, "rgba(255,255,255,0.45)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grd;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * STARBURST — diffraction spikes from the aperture blades. This is the single most
 * recognisable "photographed sun" cue and the old flare had none of it. N thin spikes
 * with a fast radial falloff, streaked with fine angular grain so they read as light
 * rather than as drawn lines, over a small hot core.
 */
function makeStarburstTex(size, spikes = 8) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const half = size * 0.5;
  // Angular grain, band-limited like the streak's.
  const G = 720;
  const grain = new Float32Array(G);
  let v = 0.5;
  for (let i = 0; i < G; i++) { v += (Math.random() - 0.5) * 0.5; v = Math.max(0.1, Math.min(1, v * 0.9 + 0.05)); grain[i] = v; }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const th = Math.atan2(dy, dx);
      const spike = Math.pow(Math.abs(Math.cos(th * spikes * 0.5)), 26);
      const gi = ((th / (Math.PI * 2) + 0.5) * G) | 0;
      const g = 0.55 + 0.45 * grain[Math.max(0, Math.min(G - 1, gi))];
      const fall = Math.exp(-r * 5.2) * (1 - r);
      const core = Math.exp(-r * r * 90) * 0.9;
      const a = Math.min(1, spike * fall * g * 1.6 + core);
      const idx = (y * size + x) * 4;
      img.data[idx] = 255;
      img.data[idx + 1] = 255;
      img.data[idx + 2] = 255;
      img.data[idx + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** A hollow ring — bright rim, empty middle. Ghosts of this shape are what most people
 *  picture when they picture a lens flare; the old set had only filled shapes. */
function makeRingTex(size, inner = 0.78) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const half = size * 0.5;
  const g = ctx.createRadialGradient(half, half, 0, half, half, half);
  /*
   * THE RING HAS TO REACH ZERO BEFORE THE TEXTURE EDGE.
   *
   * The chromatic samples in makeGhostMat read this texture at up to 1/(1-ca) of the
   * radius, which is OUTSIDE [0,1]. The sampler clamps, so whatever alpha sits on the
   * last texel is smeared outward forever — and if the ring is still bright there, that
   * smear draws as a hard-edged disc: the halo looked CUT OFF with a rim rather than
   * fading out. Ending the ramp at 0.94 leaves the outer band genuinely transparent, so
   * a clamped fetch returns nothing and there is no edge to see.
   *
   * The band is also wider and softer than it was. A narrow bright ring is what made the
   * chromatic split read as a rainbow rather than as a fringe (see makeGhostMat's ca).
   */
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(Math.max(0, inner - (1 - inner) * 0.35), "rgba(255,255,255,0)");
  g.addColorStop(inner + (1 - inner) * 0.45, "rgba(255,255,255,1)");
  g.addColorStop(inner + (1 - inner) * 0.72, "rgba(255,255,255,0.42)");
  g.addColorStop(0.94, "rgba(255,255,255,0)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * LENS DIRT, and why the old one read as "some small dots".
 *
 * The first version scattered 400 one-pixel points and 30 hairlines and lit the whole
 * sheet uniformly. That is what dust on a SENSOR looks like, in focus, and it is not what
 * anyone means by lens dirt. Dirt on the front element is far outside the focal plane, so
 * every speck renders as a BOKEH DISC: a soft fill with a brighter rim, sized by the
 * aperture rather than by the speck. Fewer of them, larger, softer, and no hard points.
 *
 * The other half of the look is not in this texture at all — see makeDirtMat: dirt is lit
 * by the light SOURCE, so only the smudges near the sun should glow, fading out across
 * the frame. A uniformly lit sheet is a screen overlay; a source-lit one is a lens.
 */
function makeDirtTex(size) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);

  // Out-of-focus specks: bokeh discs with a bright rim.
  const disc = (x, y, r, a) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0.0, `rgba(255,255,255,${(a * 0.45).toFixed(3)})`);
    g.addColorStop(0.72, `rgba(255,255,255,${(a * 0.6).toFixed(3)})`);
    g.addColorStop(0.93, `rgba(255,255,255,${a.toFixed(3)})`);
    g.addColorStop(1.0, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  for (let i = 0; i < 46; i++) {
    const r = 5 + Math.pow(Math.random(), 1.6) * 34;
    disc(Math.random() * size, Math.random() * size, r, 0.10 + Math.random() * 0.22);
  }
  // A few large, very faint smudges — the fingerprint and haze layer.
  for (let i = 0; i < 9; i++) {
    const r = 45 + Math.random() * 110;
    const x = Math.random() * size, y = Math.random() * size;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.025 + Math.random() * 0.045;
    g.addColorStop(0, `rgba(255,255,255,${a.toFixed(3)})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Soft, wide fibres — lint, not scratches.
  for (let i = 0; i < 10; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    const len = 30 + Math.random() * 90;
    const ang = Math.random() * Math.PI * 2;
    ctx.strokeStyle = `rgba(255,255,255,${(0.03 + Math.random() * 0.06).toFixed(3)})`;
    ctx.lineWidth = 3 + Math.random() * 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(
      x + Math.cos(ang + 0.6) * len * 0.5, y + Math.sin(ang + 0.6) * len * 0.5,
      x + Math.cos(ang) * len, y + Math.sin(ang) * len,
    );
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function makeFlareMat(tex, colorHex) {
  const m = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const uCol = uniform(new THREE.Color(colorHex).convertSRGBToLinear());
  const uInt = uniform(1.0);
  const sampled = texture(tex, uv());
  m.colorNode = mul(sampled.rgb, uCol);
  m.opacityNode = mul(sampled.a, uInt);
  m.fog = false;
  m.userData = { uCol, uInt };
  return m;
}

/**
 * GHOSTS WITH CHROMATIC ABERRATION. A flare ghost is the source imaged through the wrong
 * pair of lens surfaces, and glass focuses red and blue at different distances — so a
 * real ghost's edge fringes red on one side and blue on the other. Three samples of the
 * same shape at three radial scales; additive blend sums them straight into rgb. This is
 * cheap (three fetches on a few small quads) and it is most of what separates a rendered
 * flare from a photographed one.
 */
function makeGhostMat(tex, colorHex, ca = 0.055) {
  const m = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const uCol = uniform(new THREE.Color(colorHex).convertSRGBToLinear());
  const uInt = uniform(1.0);
  const c = uv().sub(0.5);
  const aR = texture(tex, c.mul(1.0 / (1.0 + ca)).add(0.5)).a;
  const aG = texture(tex, uv()).a;
  const aB = texture(tex, c.mul(1.0 / (1.0 - ca)).add(0.5)).a;
  m.colorNode = vec3(aR, aG, aB).mul(uCol);
  m.opacityNode = uInt;
  m.fog = false;
  m.userData = { uCol, uInt };
  return m;
}

/**
 * The dirt sheet's own material. Same additive setup as the other quads, plus a glow
 * centred on the sun's SCREEN position: the specks nearest the source catch its light and
 * the rest of the frame stays almost clean. That gradient is most of the difference
 * between a lens and an overlay. Keeps `uCol`/`uInt` under the same names so the
 * zero-intensity cull and the colour drive treat it like every other quad.
 */
function makeDirtMat(tex) {
  const m = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const uCol = uniform(new THREE.Color(1, 1, 1));
  const uInt = uniform(1.0);
  const uSunUv = uniform(new THREE.Vector2(0.5, 0.5));
  const uAspect = uniform(1.0);
  /** Falloff rate of the glow, in aspect-corrected screen units. */
  const uGlowK = uniform(5.5);
  const sampled = texture(tex, uv());
  const d = uv().sub(uSunUv).mul(vec2(uAspect, 1.0));
  // exp(-k·d²): a broad soft pool around the source, with a small floor so the sheet
  // never disappears entirely while the sun is in frame.
  const glow = exp(dot(d, d).mul(uGlowK).negate()).mul(0.9).add(0.1);
  m.colorNode = mul(sampled.rgb, uCol);
  m.opacityNode = mul(sampled.a, uInt).mul(glow);
  m.fog = false;
  m.userData = { uCol, uInt, uSunUv, uAspect, uGlowK };
  return m;
}

function swapFlareTexture(mesh, newTex, colorHex) {
  newTex.colorSpace = THREE.SRGBColorSpace;
  newTex.needsUpdate = true;
  const oldMat = mesh.material;
  const newMat = makeFlareMat(newTex, colorHex);
  newMat.userData.uCol.value.copy(oldMat.userData.uCol.value);
  newMat.userData.uInt.value = oldMat.userData.uInt.value;
  mesh.material = newMat;
  oldMat.dispose();
}

/*
 * ── THE GHOST CHAIN ───────────────────────────────────────────────────────────────
 *
 * Three things separate a photographed ghost chain from a drawn one, and the first
 * version of this table had none of them.
 *
 * 1. BRIGHTNESS IS NOT UNIFORM. Every ghost here used to be drawn at exactly
 *    `ghostOpacity`, so the chain read as a row of equal beads — the single loudest tell
 *    that a flare was authored. A real chain is dominated by one or two bright elements
 *    with everything else faint enough that you only notice it when you look. `w` is that
 *    weight, and most of these are deliberately low.
 *
 * 2. GHOSTS ARE THE COLOUR OF THE SOURCE, not of a palette. A ghost is the sun imaged
 *    through the wrong pair of surfaces, so it starts as the sun's own colour and is then
 *    SHIFTED by the coating it bounced off. The old table authored seven saturated hues
 *    (orange, gold, sky blue, violet, cyan) with no relationship to the light, which is
 *    why the chain read as confetti. `tint` is now only the coating, mixed onto the live
 *    source colour at `tintMix` — so the whole chain warms at sunset with the sun instead
 *    of staying a fixed rainbow.
 *
 * 3. FURTHER OUT MEANS BIGGER AND SOFTER. Ghosts far along the axis are further from
 *    focus, so they spread and dim. The sizes below rise with `t` rather than wandering.
 *
 * 4. THE CHAIN IS NOT A RULED LINE. Every element sat exactly on the sun->centre axis, so
 *    the ghosts read as beads threaded on a wire. In a real lens each bounce is between a
 *    different PAIR of surfaces, with its own centring and its own tilt, so the chain
 *    wanders a little either side of the axis. `n` is that nudge, perpendicular to the
 *    axis, alternating sign so the chain weaves instead of drifting.
 * 5. GHOSTS ARE NOT CIRCLES OFF-AXIS. The aperture is a circle seen straight on, but the
 *    barrel in front of it cuts the oblique bundle — mechanical vignetting, the "cat's eye"
 *    — so an element far from the frame centre is an ellipse with its long axis pointing
 *    back at the centre. `ar` is a base aspect and `ghostCatsEye` grows it with how far
 *    off-centre the element actually lands, which is the part that changes as you turn.
 *
 * `t` is the position along the sun->centre axis; 1 mirrors the source through the centre.
 * The shape mix matters too — an all-disc chain is a row of blobs whatever else is right.
 */
const GHOST_DEFS = [
  { t: 0.10, size: 0.045, tint: "#ffd9b8", tintMix: 0.30, kind: "iris", w: 0.30, n: 0.012, ar: 1.00 },
  { t: 0.22, size: 0.030, tint: "#ffe6c8", tintMix: 0.25, kind: "disc", w: 0.16, n: -0.018, ar: 1.00 },
  { t: 0.36, size: 0.075, tint: "#cfe6ff", tintMix: 0.45, kind: "ring", w: 0.22, n: 0.026, ar: 1.06 },
  { t: 0.48, size: 0.040, tint: "#ffd2b0", tintMix: 0.30, kind: "iris", w: 0.14, n: -0.009, ar: 1.00 },
  // The two that carry the chain. Real flares have a couple of dominant elements and
  // the eye reads the rest as their company.
  { t: 0.62, size: 0.115, tint: "#bcd8ff", tintMix: 0.50, kind: "ring", w: 1.00, n: 0.015, ar: 1.10 },
  { t: 0.78, size: 0.060, tint: "#ffe0bc", tintMix: 0.28, kind: "disc", w: 0.34, n: -0.030, ar: 1.00 },
  { t: 0.95, size: 0.150, tint: "#c8ddff", tintMix: 0.48, kind: "disc", w: 0.70, n: 0.021, ar: 1.14 },
  { t: 1.12, size: 0.085, tint: "#ffdcc0", tintMix: 0.26, kind: "iris", w: 0.20, n: -0.014, ar: 1.00 },
  { t: 1.30, size: 0.190, tint: "#bcd0ff", tintMix: 0.52, kind: "ring", w: 0.26, n: 0.034, ar: 1.18 },
  { t: 1.52, size: 0.070, tint: "#ffe8cc", tintMix: 0.22, kind: "iris", w: 0.12, n: -0.020, ar: 1.00 },
];

/** Scratch for the per-ghost source/coating mix — reused, allocates nothing. */
const _ghostCol = new THREE.Color();
const _srcCol = new THREE.Color();

/**
 * @param {object} opts
 * @param {THREE.Scene} opts.scene
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {() => THREE.Vector3} opts.getSunDir — world-space sun direction (unit), same as v1 `sunDir`.
 * @param {() => object} opts.getParams — lens flare settings object (mutated by Tweakpane).
 * @param {{ halation?: string, ghosts?: string }} [opts.textureUrls] — optional PNG upgrades (v1 paths).
 */
export function createLensFlareSystem({
  scene,
  camera,
  getSunDir,
  getParams,
  textureUrls = {
    halation: "./textures/lensflare0.png",
    ghosts: "./textures/lensflare3.png",
  },
}) {
  const halationTex = makeRadialTex(256, 2.0, true);
  const ghostTexByKind = {
    iris: makeHexTex(128),
    disc: makeRadialTex(128, 1.6, false),
    ring: makeRingTex(128),
  };
  const streakTex = makeStreakTex(512, 48);
  const starTex = makeStarburstTex(512, 8);
  const haloTex = makeRingTex(512, 0.72);
  const dirtTex = makeDirtTex(512);

  const group = new THREE.Group();
  group.renderOrder = 9999;
  scene.add(group);

  const params0 = getParams();
  const halationMat = makeFlareMat(halationTex, params0.halationColor);
  const halation = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), halationMat);
  halation.renderOrder = 9998;
  halation.frustumCulled = false;
  group.add(halation);

  const streakMat = makeFlareMat(streakTex, params0.streakColor);
  const streak = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), streakMat);
  streak.renderOrder = 9998;
  streak.frustumCulled = false;
  group.add(streak);

  const ghosts = GHOST_DEFS.map((def) => {
    const mat = makeGhostMat(ghostTexByKind[def.kind] ?? ghostTexByKind.disc, def.tint);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.renderOrder = 9998;
    mesh.frustumCulled = false;
    mesh.userData.def = def;
    group.add(mesh);
    return mesh;
  });

  // Diffraction spikes, sitting on the source.
  const starMat = makeFlareMat(starTex, params0.halationColor);
  const starburst = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), starMat);
  starburst.renderOrder = 9998;
  starburst.frustumCulled = false;
  group.add(starburst);

  // The big chromatic halo, also centred on the source — the wide ring a bright point
  // throws through a coated lens. Chromatic like the ghosts, only more so.
  /*
   * ca 0.09 SPLIT THE HALO INTO A RAINBOW. The three chromatic samples sit at radial
   * scales 1/(1+ca), 1 and 1/(1-ca) — at 0.09 that is a spread of ~0.18 of the radius,
   * which was the entire width of the old ring band. Red and blue therefore landed on
   * completely separate circles instead of fringing one, and the halo read as a drawn
   * rainbow. A real coated lens fringes its halo; it does not disperse it into a prism.
   * 0.028 against the wider band is a spread of about a third of the ring's width.
   */
  const haloMat = makeGhostMat(haloTex, "#ffffff", 0.028);
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), haloMat);
  halo.renderOrder = 9998;
  halo.frustumCulled = false;
  group.add(halo);

  const dirtMat = makeDirtMat(dirtTex);
  const dirt = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), dirtMat);
  dirt.renderOrder = 9997;
  dirt.frustumCulled = false;
  group.add(dirt);

  const loader = new THREE.TextureLoader();
  if (textureUrls.halation) {
    loader.load(
      textureUrls.halation,
      (tex) => {
        swapFlareTexture(halation, tex, getParams().halationColor);
      },
      undefined,
      () => {},
    );
  }
  if (textureUrls.ghosts) {
    loader.load(
      textureUrls.ghosts,
      (tex) => {
        for (const g of ghosts) {
          swapFlareTexture(g, tex, g.userData.def.color);
        }
      },
      undefined,
      () => {},
    );
  }

  /**
   * How big the SOURCE is, relative to the size this flare was authored against.
   *
   * A lens flare is not one thing: some of it is an image of the SOURCE and some of it is
   * an image of the LENS. They scale differently, and treating them alike is what makes a
   * flare feel stuck to the screen rather than attached to the sun.
   *
   *   • Halation and the starburst core are the source, smeared. A bigger sun makes them
   *     bigger, near enough linearly.
   *   • Ghosts are images of the APERTURE STOP, not of the sun — their size is a property
   *     of the lens, and they stay put however large the source grows. So is the halo.
   *   • The streak is anamorphic: it thickens with the source but its LENGTH is the lens.
   *
   * 1 is the authoring reference, so a caller that never touches this gets exactly the
   * flare it had before.
   */
  let sourceScale = 1;
  /** 0 = sun fully blocked, 1 = clear line of sight. See setOcclusion. */
  let occlusion = 1;
  const sunLocal = new THREE.Vector3();
  const camQuatInv = new THREE.Quaternion();

  function update() {
    const p = getParams();
    if (!p.enabled) {
      group.visible = false;
      return;
    }
    group.position.copy(camera.position);
    group.quaternion.copy(camera.quaternion);

    const sunDir = getSunDir();
    camQuatInv.copy(camera.quaternion).invert();
    sunLocal.copy(sunDir).applyQuaternion(camQuatInv);

    if (sunLocal.z >= -0.001) {
      group.visible = false;
      return;
    }
    group.visible = true;

    const horizonVis = THREE.MathUtils.smoothstep(sunDir.y, -0.02, 0.18);

    const invZ = 1 / -sunLocal.z;
    const sxView = sunLocal.x * invZ;
    const syView = sunLocal.y * invZ;
    const fovRad = (camera.fov * Math.PI) / 180;
    const halfH = Math.tan(fovRad * 0.5);
    const halfW = halfH * camera.aspect;
    const ndcX = sxView / halfW;
    const ndcY = syView / halfH;

    const radius = Math.sqrt(ndcX * ndcX + ndcY * ndcY);
    const screenVis = 1 - THREE.MathUtils.smoothstep(radius, 0.4, 2.0);
    const offFrameVis = 1 - THREE.MathUtils.smoothstep(radius, 0.0, 3.0);

    /*
     * OCCLUSION. This system has never had any: its only gates are "sun in front of
     * camera", "sun above the horizon" and a screen-radius falloff, and every quad is
     * depthTest:false. That is fine over an empty sky and badly wrong the moment
     * anything stands between the camera and the sun — a flare blazing through a solid
     * cloud is the classic tell that one was bolted on.
     *
     * Rather than raycast the scene from in here (which cannot see GPU-displaced terrain,
     * instanced foliage, or a cloud deck that is a shader rather than geometry), the
     * owner supplies the answer through setOcclusion(). Whoever draws the occluders is
     * the only code that can cheaply say how much of the sun survives.
     */
    const master = p.intensity * horizonVis * occlusion;
    if (master < 0.001) {
      group.visible = false;
      return;
    }

    const Z = -1.0;
    const worldPerNdcX = halfW;
    const worldPerNdcY = halfH;
    const sunWX = ndcX * worldPerNdcX;
    const sunWY = ndcY * worldPerNdcY;

    halation.position.set(sunWX, sunWY, Z);
    const halScale = p.halationSize * halfH * 1.4 * sourceScale;
    halation.scale.set(halScale, halScale, 1);
    halation.material.userData.uInt.value = master * screenVis * 1.4;
    halation.material.userData.uCol.value.set(p.halationColor).convertSRGBToLinear();

    streak.position.set(sunWX, sunWY, Z);
    // Length is the lens; thickness follows the source.
    streak.scale.set(p.streakLength * halfW * 4.0, halfH * 0.12 * sourceScale, 1);
    streak.material.userData.uInt.value = master * screenVis * p.streakOpacity;
    streak.material.userData.uCol.value.set(p.streakColor).convertSRGBToLinear();

    starburst.position.set(sunWX, sunWY, Z);
    const starS = (p.starburstSize ?? 0.9) * halfH * 2.0 * sourceScale;
    starburst.scale.set(starS, starS, 1);
    starburst.material.userData.uInt.value = master * screenVis * (p.starburst ?? 0.55);
    starburst.material.userData.uCol.value.set(p.halationColor).convertSRGBToLinear();

    halo.position.set(sunWX, sunWY, Z);
    const haloS = (p.haloSize ?? 0.55) * halfH * 2.0;
    halo.scale.set(haloS, haloS, 1);
    halo.material.userData.uInt.value = master * screenVis * (p.haloOpacity ?? 0.28);

    for (let i = 0; i < ghosts.length; i++) {
      const g = ghosts[i];
      const def = g.userData.def;
      const t = def.t * p.ghostSpacing;
      /*
       * The chain runs sun -> centre -> mirrored, with a small perpendicular nudge per
       * element (see `n` in the table) so it weaves rather than being threaded on a wire.
       */
      const axLen = Math.hypot(sunWX, sunWY) || 1e-4;
      const ax = sunWX / axLen;
      const ay = sunWY / axLen;
      const gx = sunWX * (1 - t * 2) + -ay * (def.n ?? 0) * halfH;
      const gy = sunWY * (1 - t * 2) + ax * (def.n ?? 0) * halfH;
      g.position.set(gx, gy, Z);
      /*
       * CAT'S EYE. The lens barrel clips the oblique bundle, so an element far from the
       * frame centre is an ellipse pointing back at it. Stretch along the chain axis by
       * how far off-centre this element ended up, then rotate the quad onto that axis.
       */
      const gr = Math.hypot(gx, gy) / halfH;
      const stretch = 1 + (p.ghostCatsEye ?? 0.5) * Math.min(gr, 1.6);
      const s = def.size * halfH * 2.0;
      g.scale.set(s * (def.ar ?? 1) * stretch, s, 1);
      g.rotation.z = Math.atan2(ay, ax);
      /*
       * The source's own colour, shifted by this element's coating. Read live from the
       * params rather than baked at construction, so the chain follows the sun into
       * sunset instead of staying the colour it was authored at noon.
       */
      _srcCol.set(p.halationColor);
      _ghostCol.set(def.tint).lerp(_srcCol, 1 - def.tintMix);
      g.material.userData.uCol.value.copy(_ghostCol).convertSRGBToLinear();
      g.material.userData.uInt.value = master * offFrameVis * p.ghostOpacity * def.w;
    }

    dirt.position.set(0, 0, Z);
    dirt.scale.set(halfW * 2, halfH * 2, 1);
    dirt.material.userData.uInt.value = master * screenVis * p.dirtOpacity * 0.9;
    // The sheet's uv runs 0..1 across the view with +v up, so the sun's NDC maps
    // straight onto it; aspect makes the glow round on screen rather than an ellipse.
    dirt.material.userData.uSunUv.value.set(ndcX * 0.5 + 0.5, ndcY * 0.5 + 0.5);
    dirt.material.userData.uAspect.value = camera.aspect;
    // Dirt catches the SOURCE's colour, not white.
    dirt.material.userData.uCol.value.set(p.halationColor).convertSRGBToLinear();

    /*
     * DO NOT DRAW WHAT CANNOT BE SEEN. Every quad here is alpha-blended with
     * depthTest:false, and the dirt one is FULLSCREEN — so a flare at zero intensity
     * still cost a fullscreen blend plus a screenful of overdraw from the halation.
     * That is paid on every frame the sun is up, and with occlusion now driving the
     * intensity to zero behind cloud it would have been paid most of the time.
     */
    for (const m of allQuads) m.visible = m.material.userData.uInt.value > 0.002;
  }

  function dispose() {
    scene.remove(group);
    halationTex.dispose();
    for (const t of Object.values(ghostTexByKind)) t.dispose();
    streakTex.dispose();
    starTex.dispose();
    haloTex.dispose();
    dirtTex.dispose();
    starburst.geometry.dispose();
    starburst.material.dispose();
    halo.geometry.dispose();
    halo.material.dispose();
    halation.geometry.dispose();
    streak.geometry.dispose();
    dirt.geometry.dispose();
    halation.material.dispose();
    streak.material.dispose();
    dirt.material.dispose();
    for (const g of ghosts) {
      g.geometry.dispose();
      g.material.dispose();
    }
  }

  /**
   * How much of the sun reaches the lens, 0..1. Called by whoever owns the occluders —
   * clouds, terrain, the track — because only they can answer cheaply. Defaults to 1, so
   * a caller that never sets it gets exactly the previous behaviour.
   */
  /** Source diameter relative to the authoring reference. See `sourceScale`. */
  function setSourceScale(v) {
    sourceScale = Math.max(0.05, Number.isFinite(v) ? v : 1);
  }

  function setOcclusion(v) {
    occlusion = Math.max(0, Math.min(1, v));
  }

  /** Every quad, for the zero-intensity cull in update(). */
  const allQuads = [halation, streak, starburst, halo, dirt, ...ghosts];

  return { group, update, dispose, setOcclusion, setSourceScale };
}
