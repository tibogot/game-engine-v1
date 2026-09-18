import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  attribute, cameraFar, cameraNear, cameraPosition, clamp, cos, Discard, dot, exp,
  float, floor, fract, Fn, length, max, min, mix, mod, normalize, oneMinus,
  perspectiveDepthToViewZ, positionView, positionWorld, pow, saturate, screenUV,
  sin, smoothstep, sqrt, texture, uniform, uv, vec2, vec3, vec4, viewportDepthTexture,
} from "three/tsl";
import { ModularRoadDriftSmoke, cancelAerial, wireSmokeOutput } from "./modularRoadDriftSmoke.js";

/**
 * DRIFT SMOKE, FLIPBOOK LOOK.
 *
 * The same system as ModularRoadDriftSmoke — emitter, launch, curl, growth,
 * fade, lamps, wet spray, pools, one draw call per class — with two pixel
 * shaders swapped for baked flipbook atlases:
 *
 *   PUFFS  — each camera-facing card plays a looping 8×8 atlas from a random
 *            start frame, lit by the game's own light model (sun wrap, HG
 *            scatter, hemisphere ambient, car lamps).
 *   BANK   — the lingering haze keeps its instanced BackSide SPHERES and paints
 *            a camera-facing sprite on each silhouette; once the camera is
 *            inside one, it crossfades to plain chord-length haze. The spheres
 *            stay because the chase camera lives inside the bank for most of a
 *            drift, and a flat card would have to fade before the near plane
 *            cut it — deleting the bank exactly when you are in it.
 *
 * Developed in smoke-lab.html (A/B against the procedural look), which imports
 * this file, so the lab and the game cannot drift apart.
 *
 * Nothing below changes a setting of the base class: `settings` is shared, so
 * every existing dev-panel slider still drives both looks. The flipbook's own
 * dials live in a second object (`flip`, DEFAULT_FLIPBOOK_SETTINGS).
 *
 * ── HOW A FRAME INDEX REACHES THE GPU ─────────────────────────────────────────
 * The base class never sends one. Puffs carry it in `aClass.x` (the world-noise
 * mix, unused by this shader); bank instances in `iThresh` (the erosion
 * threshold, unused by the flipbook bank), packed as rotation*100 + frame.
 * `_stepPool` calls `_lampAt(p.position)` immediately before `_writeParticle`
 * and `_writeBankInstance`, which is how the particle is recovered without
 * touching the base class. Consequence: those Vector3s must be COPIED into,
 * never replaced (see copyDriftSmokeState).
 *
 * ── ATLASES ───────────────────────────────────────────────────────────────────
 * 1024² 8×8 RGBA PNG, frames left→right, top→bottom, looping. RGB = baked grey
 * self-shadow, A = density. Converted losslessly from the source TGAs. PNG, not
 * KTX2: one or two atlases are ~5.5 MB of VRAM each, and a block codec softens
 * exactly the thin alpha edges that make the look.
 */

/** Atlases shipped with the game. */
export const SMOKE_ATLASES = {
  "02": { url: "/textures/smoke/wispy02_8x8.png", label: "Wispy 02 (full)" },
  "03b": { url: "/textures/smoke/wispy03b_8x8.png", label: "Wispy 03b (thin)" },
};

/** Flipbook dials, read per frame on the CPU (frame index) and via uniforms. */
export const DEFAULT_FLIPBOOK_SETTINGS = {
  cols: 8,
  rows: 8,
  /** Atlas edge in pixels — for the half-texel inset. Known up front because
   *  the shader is built before the image has necessarily arrived. */
  atlasSize: 1024,
  /**
   * Which atlas the TYRE puffs use (key of SMOKE_ATLASES).
   *
   * 03b, the thin one. 02 is a dense, dark, fully-formed ball of smoke in every
   * cell — on a plume that is already hundreds of overlapping cards it stacks
   * into a solid dark mass, which is the "the car is on fire" read. The thin
   * atlas has the same silhouette detail at a fraction of the alpha, so the
   * same number of particles integrates into a big soft cloud instead. 02 goes
   * to the pipes, where there are twenty particles and each one has to carry
   * its own shape (see `exhaustAtlas`).
   */
  puffAtlas: "03b",
  /** "loop" = play at fps from a random start frame (a looping atlas);
   *  "life" = play the atlas exactly once over each particle's life. */
  playMode: "loop",
  fps: 30,
  /** Crossfade adjacent frames (off = hard frame steps, the classic tell). */
  blendFrames: true,
  /** Random start frame per particle, so the pool never animates in sync. */
  randomStart: true,
  /** Sprite size on its card (the card already circumscribes the puff's
   *  sphere). <1 shrinks it; it can never exceed 1 without cropping the cell. */
  scale: 1,
  /**
   * ALPHA IS PER ATLAS, and the two differ by a factor of three and a half.
   *
   * Measured over all 64 cells: 02 has a mean alpha of 0.225 and 21.6% of its
   * texels above 0.5; 03b has a mean of 0.063 and 0.9% above 0.5. So the same
   * number here produces two completely different plumes, and moving the puffs
   * to 03b without moving this would have deleted them.
   *
   * 3.0 puts 03b's mean density at ~0.19 against 02's ~0.30 at the old 1.4 —
   * deliberately about two thirds, because the complaint the atlas swap is
   * answering is that the plume was a dark solid mass. The top ~6% of texels
   * still clip to 1, which is what keeps the cores opaque.
   */
  alphaMul: 3.0,
  /** How much of the atlas's baked grey shading to use (0 = flat white card). */
  baked: 1,
  /**
   * Brightness of the baked RGB, and this is the atlas's WHOLE contribution —
   * `baked` is a straight multiply on the tint, so anything under ~4 here is a
   * darkening, not a gain.
   *
   * Measured means where alpha > 0.1: 02 is 0.392 and 03b is 0.524 in sRGB,
   * which is 0.125 and 0.235 LINEAR — 02 carries a much deeper baked core
   * shadow. At 1.7 the thin atlas contributed ×0.40 and the plume came out
   * brown-grey over a pale road; 3.0 puts it at ×0.70, so the smoke is white
   * where it is thin and grey only where the atlas and `absorb` shade it.
   *
   * Per atlas, like `alphaMul`: swapping the puffs back to 02 wants roughly
   * double this to land in the same place.
   */
  bakedGain: 3.0,
  /** × the game's self-shadow (absorb). Low: the atlas has its own shadow baked in. */
  selfShadow: 0.25,
  /** Apply the game's erosion threshold on top of the texture alpha. */
  erode: 0,

  // ── The lingering bank ──────────────────────────────────────────────────
  /** "flipbook" = atlas painted on the bank spheres; "sphere" = the procedural bank. */
  bankStyle: "flipbook",
  /** Thin wisps: reads as old smoke breaking up. 02 at bank scale = cotton balls. */
  bankAtlas: "03b",
  /** Slow: a metres-wide mass that boils at puff speed reads as a sprite. */
  bankFps: 8,
  bankScale: 1,
  /**
   * × the bank's per-instance alpha. HIGH on purpose: the bank opacity setting
   * is 0.035, tuned for spheres whose whole silhouette is filled; a sprite
   * whose texture covers a fraction of the disc is invisible at that.
   */
  bankAlpha: 9,
  /** Brightness of the bank atlas's baked RGB (03b's shading is dim). */
  bankBright: 3,
  /** Opacity of the plain haze the bank becomes once the camera is INSIDE it. */
  bankInsideFog: 0.35,

  // ── The engine's plume ──────────────────────────────────────────────────
  /**
   * 02, the dense one, and this is the pairing the reference footage uses.
   *
   * A tailpipe puff is ON ITS OWN: a handful of them, small, and each one is
   * read individually rather than as part of a mass. That wants a cell that
   * already looks like a puff of smoke — opaque core, curled edges — which is
   * exactly what 02 is and exactly why it is wrong for the tyres.
   */
  exhaustAtlas: "02",
  /** Faster than the tyres': a small hot puff boils quickly. */
  exhaustFps: 34,
  /**
   * HIGHER THAN THE TYRES' ON PURPOSE, even though 02 is the denser atlas.
   *
   * What you see is per-card alpha times how many cards are stacked on that
   * pixel, and the two sources are at opposite ends of that trade: the tyre
   * plume is hundreds of thin cards integrating into a mass, the exhaust is
   * twenty puffs spread over a few metres with barely two overlapping
   * anywhere. At the tyres' density it was a rumour.
   */
  exhaustAlphaMul: 2.2,
  /**
   * The engine's own. HIGHER than the tyres' number for a DARKER result: it
   * multiplies 02, whose linear mean is 0.125 against 03b's 0.235, so 4.0 here
   * lands at ×0.50 where the puffs' 3.0 lands at ×0.70. That gap is deliberate
   * — exhaust carries some carbon — but at the old 1.7 it was ×0.21, which is
   * the sooty plume of an engine running badly.
   */
  exhaustBright: 4.0,
  exhaustScale: 1,
};

/**
 * The flipbook half of the previous look — see PREV_LOOK_SMOKE for the rest and
 * for why. Dense atlas on the tyres, and the alpha and brightness it was
 * balanced against.
 */
export const PREV_LOOK_FLIPBOOK = {
  puffAtlas: "02",      // 03b
  alphaMul: 1.4,        // 3.0
  bakedGain: 2.0,       // 3.0
};

/**
 * Load every atlas. Returns textures IMMEDIATELY (images fill in when they
 * arrive), so a constructor can be handed them synchronously; `ready` resolves
 * once all have loaded (or failed — a missing atlas logs and stays blank).
 *
 * ImageBitmap with premultiply/colour-conversion OFF: the atlas's RGB under very
 * low alpha is real data (03b averages 16/255 alpha), and a premultiply →
 * unpremultiply round trip on decode would band it.
 */
export function loadSmokeAtlases() {
  const loader = new THREE.ImageBitmapLoader();
  loader.setOptions({ imageOrientation: "none", premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const textures = {};
  const pending = Object.entries(SMOKE_ATLASES).map(([key, a]) => {
    const tex = new THREE.Texture();
    // Row 0 of the image is the TOP; flipY stays false so v = 0 is the top row.
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    textures[key] = tex;
    return loader.loadAsync(a.url).then((bitmap) => {
      tex.image = bitmap;
      tex.needsUpdate = true;
    }).catch((e) => console.warn(`[drift smoke] atlas ${key} failed to load —`, e));
  });
  return { textures, ready: Promise.all(pending) };
}

/**
 * Copy live particle state between two smoke instances (a look switch), so the
 * plume carries on instead of vanishing. Vector3s are COPIED, never replaced:
 * the flipbook keys its particle lookup on the position object's identity.
 */
export function copyDriftSmokeState(from, to) {
  const copyPool = (a, b) => {
    for (let i = 0; i < a.length; i++) {
      const p = a[i], q = b[i];
      for (const k in p) {
        const v = p[k];
        if (v && v.isVector3) q[k].copy(v);
        else q[k] = v;
      }
    }
  };
  copyPool(from.particles, to.particles);
  copyPool(from.hazeParticles, to.hazeParticles);
  copyPool(from.sprayParticles, to.sprayParticles);
  copyPool(from.exhaustParticles, to.exhaustParticles);
  to._sprayAlive = from._sprayAlive;
  to._exhaustAlive = from._exhaustAlive;
  to._engine = from._engine ? { ...from._engine } : null;
  to._prevThrottle = from._prevThrottle;
  for (const e of ["puffEmitter", "hazeEmitter", "sprayEmitter", "exhaustEmitter"]) {
    to[e].index = from[e].index;
    to[e].accum = [...from[e].accum];
  }
  to.uTime.value = from.uTime.value;
  to._curlTime = from._curlTime;
  to._worldDriftPhase = from._worldDriftPhase;
}

const _depthTex = /*#__PURE__*/ viewportDepthTexture();

/**
 * Sample one looping atlas at a fractional frame, crossfading neighbours.
 * `s` is the sprite coordinate in [0,1]². Returns the blended vec4 plus the two
 * texture nodes, so the caller can retarget them to another atlas later
 * (`node.value = tex`) without rebuilding the pipeline.
 */
function sampleAtlas(atlas, s, frameF, u) {
  // Soft vignette to the cell border: atlas alpha is not exactly zero at the
  // edges, and any residue there draws the card's straight edge.
  const edge = min(min(s.x, oneMinus(s.x)), min(s.y, oneMinus(s.y)));
  const vignette = smoothstep(0, 0.12, edge);
  // Inset so bilinear/mips never read the neighbour cell.
  const pad = float(1.5).div(u.uAtlasSize.div(u.uCols));
  const sc = clamp(s, pad, oneMinus(pad));
  const count = u.uCols.mul(u.uRows);
  const fA = floor(frameF);
  const wB = fract(frameF).mul(u.uBlend);
  const cellUv = (fr) => {
    const i = mod(fr, count);
    const col = mod(i, u.uCols);
    const row = floor(i.div(u.uCols));
    // Row 0 = top of the image = v 0; sprite v is up, so it is flipped.
    return vec2(col.add(sc.x).div(u.uCols), row.add(float(1).sub(sc.y)).div(u.uRows));
  };
  const tA = texture(atlas, cellUv(fA));
  const tB = texture(atlas, cellUv(fA.add(1)));
  return { smp: mix(tA, tB, wB), nodes: [tA, tB], vignette };
}

/** The base class's light model (sun wrap + HG + hemisphere + lamps), shared. */
function litColour(self, nrm, rd, density, shadowMul, lampIn) {
  const { uSunWorld, uAmbient, uSunStrength, uAbsorb, uScatter, uHgG, uSunColor, uSkyCol, uGroundCol } = self;
  const wrapped = saturate(dot(nrm, uSunWorld).mul(0.5).add(0.5));
  // The atlas already carries its own self-shadow in RGB, so Beer-Lambert is
  // scaled down or the puff is darkened twice.
  const transmit = exp(density.mul(uAbsorb).mul(shadowMul).negate());
  const c = dot(uSunWorld, rd);
  const gg = uHgG.mul(uHgG);
  const denom = pow(max(float(1e-4), float(1).add(gg).sub(uHgG.mul(2).mul(c))), float(1.5));
  const phase = float(1).sub(gg).div(denom).div(12.566);
  const hemiCol = mix(uGroundCol, uSkyCol, nrm.y.mul(0.5).add(0.5));
  const lamps = lampIn.mul(mix(float(0.15), float(1), transmit));
  return uSunColor
    .mul(uSunStrength.mul(wrapped).add(uScatter.mul(phase)))
    .mul(transmit)
    .add(hemiCol.mul(uAmbient))
    .add(lamps);
}

export class FlipbookDriftSmoke extends ModularRoadDriftSmoke {
  /**
   * @param {THREE.Scene} scene
   * @param {object} settings  the drift smoke settings (shared with the procedural look)
   * @param {Record<string, THREE.Texture>} atlases  keyed like SMOKE_ATLASES
   * @param {typeof DEFAULT_FLIPBOOK_SETTINGS} [flip]  live flipbook dials
   */
  constructor(scene, settings, atlases, flip = { ...DEFAULT_FLIPBOOK_SETTINGS }) {
    // The base constructor builds the materials, so the atlases have to be
    // reachable before `super` — fields cannot be set that early.
    FlipbookDriftSmoke._pending = { atlases, flip };
    try {
      super(scene, settings);
    } finally {
      FlipbookDriftSmoke._pending = null;
    }
    this.flip = flip;
    this.atlases = atlases;

    /** p.position (Vector3 identity) → { p, slot }. Built once; slots persist. */
    this._flipByPos = new Map();
    this.particles.forEach((p, i) => this._flipByPos.set(p.position, { p, slot: i }));
    this.hazeParticles.forEach((p, i) => this._flipByPos.set(p.position, { p, slot: 5003 + i }));
    this.exhaustParticles.forEach((p, i) => this._flipByPos.set(p.position, { p, slot: 9007 + i }));
    this._flipPos = null;

    // ── THE ENGINE'S MESH ─────────────────────────────────────────────────
    // The base class built it pointing at the puffs' material; it plays a
    // different atlas, so it needs its own graph. Three dials get their own
    // uniform (sprite scale, alpha, brightness) and everything else — the frame
    // layout, the light model, the self-shadow — is the same uniform object the
    // puffs use, so tuning the lighting once tunes both.
    this._flipXU = {
      ...this._flipU,
      uScale: uniform(1), uAlphaMul: uniform(1), uBakedGain: uniform(1.7),
      uSoftDepth: uniform(0.22),
    };
    const exhaustMat = new MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, depthTest: false,
      side: THREE.DoubleSide, fog: false,
    });
    wireSmokeOutput(
      exhaustMat,
      this._buildCardNode(
        this.atlases[flip.exhaustAtlas] ?? Object.values(this.atlases)[0],
        this._flipXU,
        (nodes) => { this._exhaustTexNodes = nodes; },
      ).toVar(),
    );
    this.exhaustMesh.material = exhaustMat;
    this._exhaustMat = exhaustMat;

    // The bank: keep the procedural sphere material for the "sphere" style and
    // add a flipbook one over the SAME instanced spheres. Swap = pointer write.
    this._bankSphereMat = this.bankMesh.material;
    const bankMat = new MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, side: THREE.BackSide, depthTest: false, fog: false,
    });
    const shaded = this._buildBankFlipNode().toVar();
    wireSmokeOutput(bankMat, shaded);
    this._bankFlipMat = bankMat;
    this.syncFlip();
  }

  get _bankIsFlip() {
    return this.flip.bankStyle === "flipbook";
  }

  /** Push the flipbook dials into the uniforms. Runs every update. */
  syncFlip() {
    const f = this.flip, u = this._flipU;
    u.uScale.value = Math.max(0.05, f.scale);
    u.uAlphaMul.value = f.alphaMul;
    u.uBaked.value = f.baked;
    u.uBakedGain.value = f.bakedGain;
    u.uErode.value = f.erode;
    u.uCols.value = f.cols;
    u.uRows.value = f.rows;
    u.uAtlasSize.value = f.atlasSize;
    u.uBlend.value = f.blendFrames ? 1 : 0;
    u.uShadowMul.value = f.selfShadow;
    u.uBankScale.value = Math.max(0.05, f.bankScale);
    u.uBankAlpha.value = f.bankAlpha;
    u.uBankBright.value = f.bankBright;
    u.uInsideFog.value = f.bankInsideFog;

    // Atlas choice: retarget the texture nodes, no rebuild. The handles only
    // exist once the graph has been built (TSL builds lazily, on first compile).
    const puffTex = this.atlases[f.puffAtlas];
    if (puffTex) for (const n of this._puffTexNodes ?? []) n.value = puffTex;
    const bankTex = this.atlases[f.bankAtlas];
    if (bankTex) for (const n of this._bankTexNodes ?? []) n.value = bankTex;

    const x = this._flipXU;
    if (x) {
      x.uScale.value = Math.max(0.05, f.exhaustScale ?? 1);
      x.uAlphaMul.value = f.exhaustAlphaMul ?? 1;
      x.uBakedGain.value = f.exhaustBright ?? 1.7;
      // From the settings block, not the flipbook dials: it is a property of
      // where the source SITS, so the procedural look wants the same number.
      x.uSoftDepth.value = Math.max(1e-3, this.settings.exhaust?.softDepth ?? 0.22);
      const exTex = this.atlases[f.exhaustAtlas];
      if (exTex) for (const n of this._exhaustTexNodes ?? []) n.value = exTex;
    }

    const want = this._bankIsFlip ? this._bankFlipMat : this._bankSphereMat;
    if (this.bankMesh.material !== want) this.bankMesh.material = want;
  }

  update(dt, points, emit, intensity, vx, vz, camera, spray) {
    this.syncFlip();
    // The bank sprite is laid out in the camera's plane, like the puff cards.
    if (camera) {
      this._flipU.uCamRight.value.set(1, 0, 0).applyQuaternion(camera.quaternion);
      this._flipU.uCamUp.value.set(0, 1, 0).applyQuaternion(camera.quaternion);
    }
    return super.update(dt, points, emit, intensity, vx, vz, camera, spray);
  }

  _lampAt(P, out) {
    this._flipPos = P;
    return super._lampAt(P, out);
  }

  /** Random in [0,1), stable for one particle's life (noiseU is re-rolled at birth). */
  _seed(p, slot, salt = 0) {
    if (!this.flip.randomStart && salt === 0) return 0;
    const v = Math.sin((p.noiseU + salt * 3.17) * 12.9898 + slot * 78.233) * 43758.5453;
    return v - Math.floor(v);
  }

  _writeParticle(index, ...rest) {
    super._writeParticle(index, ...rest);
    // Frame indices are a CARD thing — the puffs' mesh and the engine's. The
    // spray writes its own buffers with the streak shader, which reads aClass
    // for something else entirely and must not have it touched.
    const isPuff = this._target === this._puffTarget;
    if (!isPuff && this._target !== this._exhaustTarget) return;
    const rec = this._flipByPos?.get(this._flipPos);
    if (!rec) return;
    const { p, slot } = rec;
    const f = this.flip;
    const frames = f.cols * f.rows;
    let frame;
    if (isPuff && f.playMode === "life") {
      const age = 1 - p.life / p.maxLife;
      frame = Math.min(age * frames, frames - 1.001);
    } else {
      // The engine's plume always loops: its particles are far shorter-lived
      // than one play-through of a 64-frame atlas, so "life" mode would show
      // every one of them the same opening few cells.
      const fps = isPuff ? f.fps : f.exhaustFps;
      frame = (p.maxLife - p.life) * fps + this._seed(p, slot) * frames;
    }
    const classes = this._target.classes;
    const o = index * 12; // VERTS_PER_PARTICLE (6) × CLASS floats (2)
    for (let i = 0; i < 6; i++) classes[o + i * 2] = frame;
  }

  _writeBankInstance(index, center, size, alpha, thresh, lamp) {
    super._writeBankInstance(index, center, size, alpha, thresh, lamp);
    if (!this._bankIsFlip) return;
    const rec = this._flipByPos?.get(this._flipPos);
    if (!rec) return;
    const { p, slot } = rec;
    const frames = this.flip.cols * this.flip.rows;
    const frame = ((p.maxLife - p.life) * this.flip.bankFps + this._seed(p, slot) * frames) % frames;
    // Packed: hundreds = one of 16 fixed sprite rotations, the rest = frame.
    // A per-life rotation is what stops neighbouring bank sprites repeating.
    const rot = Math.floor(this._seed(p, slot, 1) * 16);
    this.bankThresholds[index] = rot * 100 + frame;
  }

  _buildShadedNode() {
    const { atlases, flip } = FlipbookDriftSmoke._pending;
    const atlas = atlases[flip.puffAtlas] ?? Object.values(atlases)[0];
    const u = (this._flipU = this._makeFlipUniforms());
    return this._buildCardNode(atlas, u, (nodes) => { this._puffTexNodes = nodes; });
  }

  /** @returns the flipbook's uniform set. Built once; the exhaust borrows most
   *  of it and overrides only the three dials it wants its own value of. */
  _makeFlipUniforms() {
    return {
      uScale: uniform(1), uAlphaMul: uniform(1), uBaked: uniform(1),
      uBakedGain: uniform(2), uErode: uniform(0), uCols: uniform(8), uRows: uniform(8),
      uAtlasSize: uniform(1024), uBlend: uniform(1), uShadowMul: uniform(0.25),
      uBankScale: uniform(1), uBankAlpha: uniform(1), uBankBright: uniform(3), uInsideFog: uniform(0.35),
      uCamRight: uniform(new THREE.Vector3(1, 0, 0)), uCamUp: uniform(new THREE.Vector3(0, 1, 0)),
    };
  }

  /**
   * One billboard class's shader: a flipbook cell on a camera-facing card, lit
   * on the particle's sphere normal. The tyre puffs and the engine's plume are
   * the same graph over different atlases and different `u`, which is the whole
   * reason the second source costs one draw call and no new code.
   *
   * @param {THREE.Texture} atlas
   * @param {object} u          uniform set (see `_makeFlipUniforms`)
   * @param {(nodes: any[]) => void} keepNodes  receives the two texture nodes so
   *   the caller can retarget them on an atlas change without a rebuild.
   */
  _buildCardNode(atlas, u, keepNodes) {
    const st = uv();
    const tint = attribute("aTint", "vec4");
    const nParams = attribute("aNoise", "vec4");
    const sphere = attribute("aSphere", "vec4");
    const cls = attribute("aClass", "vec2");
    const lampIn = attribute("aLamp", "vec3");
    const { uErodeSoft, uLightAmount } = this;
    // SOFT DEPTH IS PER CLASS, and the engine's plume is why.
    //
    // The tyre puffs want a metre of it: they lie across the tarmac at a
    // glancing angle and without it the quads slice the road along a razor
    // line. The exhaust is born ON the car — a few centimetres from the rear
    // valance, INSIDE the car's own silhouette from a chase camera — so the same
    // metre deleted it outright for the first stretch of its life, and the plume
    // did not appear until it was a car's length behind the bumper. Its own,
    // much tighter value lets it exist at the pipe and still soften where it
    // meets the road.
    const uSoftDepth = u.uSoftDepth ?? this.uSoftDepth;

    return Fn(() => {
      const s = st.sub(0.5).div(u.uScale).add(0.5).toVar();
      const { smp: smpRaw, nodes, vignette } = sampleAtlas(atlas, s, cls.x, u);
      keepNodes(nodes);
      const smp = smpRaw.toVar();

      const density = saturate(smp.a.mul(u.uAlphaMul)).toVar();
      const t = nParams.w.mul(u.uErode).mul(0.6);
      const erodeMask = mix(float(1), smoothstep(t, t.add(uErodeSoft), smp.a), saturate(u.uErode.mul(100)));
      const alpha = density.mul(erodeMask).mul(tint.w).mul(vignette).toVar();

      // Scene-depth fade + occlusion. The card sits on the sphere centre plane,
      // so behind a wall this goes to zero; against the tarmac it softens.
      const rawDepth = _depthTex.sample(screenUV).r.toVar();
      const sceneViewZ = perspectiveDepthToViewZ(rawDepth, cameraNear, cameraFar).negate();
      const fragViewZ = positionView.z.negate();
      alpha.mulAssign(saturate(sceneViewZ.sub(fragViewZ).div(max(uSoftDepth, float(1e-3)))));
      Discard(alpha.lessThan(0.003));

      // Lighting on the puff's sphere normal. Outside the disc the closest-
      // approach point still gives an outward normal, so card corners light
      // continuously.
      const camToFrag = positionWorld.sub(cameraPosition);
      const fragDist = length(camToFrag).toVar();
      const rd = camToFrag.div(fragDist).toVar();
      const centre = sphere.xyz;
      const radius = sphere.w;
      const oc = cameraPosition.sub(centre);
      const b = dot(oc, rd);
      const h = b.mul(b).sub(dot(oc, oc).sub(radius.mul(radius)));
      const tHit = b.negate().sub(sqrt(max(h, float(0))));
      const nrm = normalize(cameraPosition.add(rd.mul(tHit)).sub(centre));
      const lit = litColour(this, nrm, rd, density, u.uShadowMul, lampIn);

      const baked = mix(vec3(1), smp.rgb.mul(u.uBakedGain), u.uBaked);
      const rgb = tint.xyz.mul(baked).mul(mix(vec3(1), lit, uLightAmount));
      const rayDist = sceneViewZ.mul(fragDist).div(max(fragViewZ, float(1e-4)));
      return vec4(cancelAerial(rgb, rawDepth, rd, rayDist), alpha);
    })();
  }

  /**
   * The flipbook BANK: a camera-facing sprite painted onto the instanced
   * sphere's silhouette (see the file header for why spheres).
   *   outside → the sprite, laid out in the camera plane through the point of
   *             closest approach (the disc maps exactly onto the cell);
   *   inside  → crossfades to plain fog proportional to the chord through the
   *             sphere, clipped by scene depth.
   */
  _buildBankFlipNode() {
    const u = this._flipU;
    const atlas = this.atlases[this.flip.bankAtlas] ?? Object.values(this.atlases)[0];
    const tint = attribute("iTint", "vec4");
    const code = attribute("iThresh", "float");
    const sphere = attribute("iSphere", "vec4");
    const lampIn = attribute("iLamp", "vec3");
    const { uSoftDepth, uLightAmount } = this;

    return Fn(() => {
      const camToFrag = positionWorld.sub(cameraPosition);
      const dist = length(camToFrag).toVar();
      const rd = camToFrag.div(dist).toVar();
      const centre = sphere.xyz;
      const radius = sphere.w;

      const toC = centre.sub(cameraPosition);
      const tca = dot(toC, rd).toVar();
      const off = cameraPosition.add(rd.mul(tca)).sub(centre).toVar();
      const off2 = dot(off, off);
      const r2 = radius.mul(radius);
      const sq = sqrt(max(r2.sub(off2), float(0)));
      const t0 = tca.sub(sq);
      const t1 = tca.add(sq);

      const rawDepth = _depthTex.sample(screenUV).r.toVar();
      const sceneViewZ = perspectiveDepthToViewZ(rawDepth, cameraNear, cameraFar).negate();
      const fragViewZ = positionView.z.negate();
      const sceneT = sceneViewZ.mul(dist).div(max(fragViewZ, float(1e-4))).toVar();

      // ── Sprite (outside) ────────────────────────────────────────────────
      const rotCode = floor(code.div(100));
      const frameF = code.sub(rotCode.mul(100));
      const ang = rotCode.mul(0.3926991);
      const ca = cos(ang), sa = sin(ang);
      const px = dot(off, u.uCamRight).div(radius);
      const py = dot(off, u.uCamUp).div(radius);
      const s = vec2(px.mul(ca).sub(py.mul(sa)), px.mul(sa).add(py.mul(ca)))
        .div(u.uBankScale).mul(0.5).add(0.5).toVar();
      const { smp: smpRaw, nodes, vignette } = sampleAtlas(atlas, s, frameF, u);
      this._bankTexNodes = nodes;
      const smp = smpRaw.toVar();
      const density = saturate(smp.a.mul(u.uBankAlpha)).toVar();
      // In front of the lens only, and softly buried where the sprite's plane
      // (through the centre) meets the road or a wall.
      const inFront = smoothstep(0, radius.mul(0.25), tca);
      const spriteA = density.mul(vignette).mul(inFront)
        .mul(saturate(sceneT.sub(tca).div(max(uSoftDepth.mul(2), float(1e-3)))));

      // ── Fog (inside) ────────────────────────────────────────────────────
      const tEnter = max(t0, float(0));
      const chord = max(min(t1, sceneT).sub(tEnter), float(0));
      const fogA = saturate(chord.div(radius.mul(2))).mul(u.uInsideFog);

      const camDist = length(cameraPosition.sub(centre));
      const inside = smoothstep(radius, radius.mul(0.45), camDist);
      const alpha = mix(spriteA, fogA, inside).mul(tint.w).toVar();
      Discard(alpha.lessThan(0.003));

      // Front-surface normal of the sphere at this pixel.
      const nrm = normalize(off.sub(rd.mul(sq)));
      const lit = litColour(this, nrm, rd, mix(density, fogA, inside), u.uShadowMul, lampIn);
      const baked = mix(vec3(1), smp.rgb.mul(u.uBankBright), u.uBaked.mul(oneMinus(inside)));
      const rgb = tint.xyz.mul(baked).mul(mix(vec3(1), lit, uLightAmount));
      return vec4(cancelAerial(rgb, rawDepth, rd, sceneT), alpha);
    })();
  }
}
