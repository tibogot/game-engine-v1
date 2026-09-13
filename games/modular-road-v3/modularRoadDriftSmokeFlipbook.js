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
  /** Which atlas the puffs use (key of SMOKE_ATLASES). */
  puffAtlas: "02",
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
  alphaMul: 1.4,
  /** How much of the atlas's baked grey shading to use (0 = flat white card). */
  baked: 1,
  /** Brightness of the baked RGB — the atlas tops out at ~183/255. */
  bakedGain: 2.0,
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
  to._sprayAlive = from._sprayAlive;
  for (const e of ["puffEmitter", "hazeEmitter", "sprayEmitter"]) {
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
    this._flipPos = null;

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
    // Frame indices are a PUFF thing; the spray class writes its own buffers
    // with the streak shader and must not have its aClass touched.
    if (this._target !== this._puffTarget) return;
    const rec = this._flipByPos?.get(this._flipPos);
    if (!rec) return;
    const { p, slot } = rec;
    const f = this.flip;
    const frames = f.cols * f.rows;
    let frame;
    if (f.playMode === "life") {
      const age = 1 - p.life / p.maxLife;
      frame = Math.min(age * frames, frames - 1.001);
    } else {
      frame = (p.maxLife - p.life) * f.fps + this._seed(p, slot) * frames;
    }
    const classes = this._puffTarget.classes;
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
    const u = (this._flipU = {
      uScale: uniform(1), uAlphaMul: uniform(1), uBaked: uniform(1),
      uBakedGain: uniform(2), uErode: uniform(0), uCols: uniform(8), uRows: uniform(8),
      uAtlasSize: uniform(1024), uBlend: uniform(1), uShadowMul: uniform(0.25),
      uBankScale: uniform(1), uBankAlpha: uniform(1), uBankBright: uniform(3), uInsideFog: uniform(0.35),
      uCamRight: uniform(new THREE.Vector3(1, 0, 0)), uCamUp: uniform(new THREE.Vector3(0, 1, 0)),
    });
    const st = uv();
    const tint = attribute("aTint", "vec4");
    const nParams = attribute("aNoise", "vec4");
    const sphere = attribute("aSphere", "vec4");
    const cls = attribute("aClass", "vec2");
    const lampIn = attribute("aLamp", "vec3");
    const { uSoftDepth, uErodeSoft, uLightAmount } = this;

    return Fn(() => {
      const s = st.sub(0.5).div(u.uScale).add(0.5).toVar();
      const { smp: smpRaw, nodes, vignette } = sampleAtlas(atlas, s, cls.x, u);
      this._puffTexNodes = nodes;
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
