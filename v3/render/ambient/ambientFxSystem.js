/**
 * AMBIENT FX — what the particles LOOK like, and how editor state reaches the
 * GPU. The placement, simulation, culling and draw machinery is the shared
 * field (ambientField.js); this file is only the card's material and the
 * state → uniform-row packing.
 *
 * Same split as foliageSystem.js over scatterField.js, for the same reason:
 * the next effect should be an entry in AMBIENT_PRESETS, not another module.
 *
 * ── ONE MATERIAL FOR EVERY CARD EFFECT ──────────────────────────────────────
 *
 * A butterfly and a falling leaf are the same draw call. What differs is all
 * read from the effect's uniform rows in the shader: two colours, a size, an
 * atlas tile, a hinge behaviour and a translucency. That is the whole reason
 * the mode costs one draw however many effects are painted — and the reason
 * to resist giving any one effect "just its own material".
 *
 * ── THE VERTEX STAGE BUILDS THE CARD FROM SCRATCH ───────────────────────────
 *
 * `position` in the geometry is a resting pose nobody reads. Every vertex is
 * rebuilt from `aCard` (side, u, v) plus the particle's own frame, because the
 * hinge angle and the orientation are per particle AND per frame — baking any
 * of it into a buffer would be work thrown away every frame.
 *
 * ── THE FADE IS PER PARTICLE, NOT PER PIXEL ─────────────────────────────────
 *
 * These cards are ALPHA TESTED and live in the opaque pass, which buys early-Z
 * over a great many small overlapping quads. That leaves no way to fade one
 * out smoothly — so a particle instead vanishes when its age-fade drops below
 * its OWN stable random threshold. Individual cards pop; the effect does not,
 * because a hundred of them pop at a hundred different moments. It is the same
 * stochastic-thinning idiom the distance, screen-size and near gates use.
 */
import * as THREE from "three";
import {
  Discard, Fn, attribute, cameraPosition, cameraViewMatrix, cos, dot, faceDirection, float,
  floor, instanceIndex, int, mix, normalize, pow, saturate, sin, texture, uniform, varying,
  vec2, vec3, vec4,
} from "three/tsl";
import { AmbientField } from "./ambientField.js";
import { createAmbientAtlas, ATLAS_TILES, AMBIENT_ART } from "./ambientAtlas.js";
import { createCardGeometry } from "./ambientShapes.js";
import { ageFade, cardFrame, cardRoll } from "./ambientMotion.js";
import { terrainShade, terrainSunVisibilityHere } from "../lighting/terrainSunShadow.js";
import {
  AMBIENT_EFFECT_COUNT, AMBIENT_MAX_PARTICLES, AMBIENT_ROWS, dayWindow, sliceBudgets,
} from "../../app/state/ambientFxState.js";

/** Shape classes. One indirect draw each; this slice ships only the card. */
const SHAPE_CARD = 0;
const SHAPE_COUNT = 1;

/** How long a card is along its spine, as a fraction of its span. */
const CARD_ASPECT = 0.85;

export class AmbientFxSystem {
  /**
   * @param {object} o
   *   scene, renderer, worldSize
   *   heightTex, terrainNormalTex, windTex
   *   densityTex  painted density, one effect per channel (or null)
   *   fx   ambient FX state (createAmbientFxState shape)
   */
  constructor({ scene, renderer, heightTex, terrainNormalTex, windTex, densityTex = null, worldSize, fx }) {
    this.renderer = renderer;
    this.effectCount = AMBIENT_EFFECT_COUNT;

    const field = (this.field = new AmbientField({
      scene, renderer, name: "AmbientFX",
      effectCount: AMBIENT_EFFECT_COUNT,
      rows: AMBIENT_ROWS,
      maxParticles: AMBIENT_MAX_PARTICLES,
      shapeCount: SHAPE_COUNT,
      worldSize, heightTex, terrainNormalTex, windTex, densityTex,
    }));
    this.group = field.group;

    // The texture exists now and the artwork is drawn into it as it arrives,
    // so nothing waits on the network and the material never recompiles.
    const { texture: atlas, ready } = createAmbientAtlas();
    this._atlas = atlas;
    this.artReady = ready.then((r) => {
      if (r.failed.length) console.warn(`[Ambient FX] ${r.failed.length} of ${AMBIENT_ART.length} images missing`);
      return r;
    });
    const u = (this.u = {
      uSunDir: uniform(new THREE.Vector3(0.5, 0.8, 0.3).normalize()),
      /** Global look scale, so the panel can dim the whole mode at once. */
      uGlow: uniform(1),
    });

    field.attachShapes([this._buildCardMaterial(atlas, u)], () => createCardGeometry());
    this.syncFromState(fx);
  }

  /* ── the card material ─────────────────────────────────────────────────── */
  _buildCardMaterial(atlas, u) {
    const field = this.field;
    const { bufA, bufB, bufC, compactBuf } = field.nodes;

    const mat = new THREE.MeshStandardNodeMaterial({
      side: THREE.DoubleSide,     // a wing is seen from underneath half the time
      roughness: 0.78,
      metalness: 0,
    });
    mat.envMapIntensity = 0.4;

    const vTile = varying(vec2(0), "v_am_tile");
    const vU = varying(float(0), "v_am_u");
    const vEffect = varying(float(0), "v_am_effect");
    const vJitter = varying(float(0), "v_am_jitter");
    const vNormal = varying(vec3(0, 1, 0), "v_am_normal");
    const vWorld = varying(vec3(0), "v_am_world");
    const vFade = varying(float(1), "v_am_fade");

    mat.positionNode = Fn(() => {
      // The compact list is sliced by firstInstance, so `instanceIndex` in the
      // vertex stage already addresses this draw's own slice — the same trick
      // scatterField uses.
      const slot = compactBuf.element(instanceIndex);
      const a = bufA.element(slot);
      const b = bufB.element(slot);
      const c = bufC.element(slot);

      const pos = a.xyz;
      const age = a.w;
      const vel = b.xyz;
      const life = b.w;
      const state = c.z;

      const e = field.effectOf(slot);
      const row = (r) => field.u.uRows.element(e.mul(AMBIENT_ROWS).add(r));
      const r0 = row(0), r1 = row(1), r2 = row(2), r4 = row(4), r5 = row(5), r6 = row(6);

      // Salt 41 — the SAME random the compute's screen-size gate sized this
      // card with. Two different randoms here and the gate would be culling a
      // card that is not the one being drawn.
      const size = r0.w.mul(mix(float(1).sub(r1.w), float(1).add(r1.w), field.slotRand(slot, 41)));
      const phase = field.slotRand(slot, 31);
      const seed = field.slotRand(slot, 32);

      const card = attribute("aCard", "vec4");
      const side = card.x, cu = card.y, cv = card.z;

      const fwd = vec3(0, 0, 1).toVar();
      const rgt = vec3(1, 0, 0).toVar();
      const upv = vec3(0, 1, 0).toVar();
      const hinge = float(0).toVar();
      cardFrame({
        motionId: r2.x, vel, state, age, phase, seed,
        flapRate: r4.y, flapAmp: r6.z, fwd, rgt, upv, hinge,
      });

      // The hinge opens MORE toward the tip than at the spine, so a wing
      // curves through the stroke instead of hinging like a shutter.
      const ang = hinge.mul(float(0.55).add(cu.mul(0.45)));
      const span = size.mul(0.5);
      const x0 = side.mul(cu).mul(span).mul(cos(ang));
      const y0 = cu.mul(span).mul(sin(ang));
      const z0 = cv.sub(0.5).mul(size).mul(CARD_ASPECT);

      // Roll about the spine — how a falling leaf tumbles.
      const roll = cardRoll(r2.x, state, age, phase, r4.y, r4.w);
      const cr = cos(roll), sr = sin(roll);
      const xr = x0.mul(cr).sub(y0.mul(sr));
      const yr = x0.mul(sr).add(y0.mul(cr));

      // The card's own normal, through the same hinge and roll.
      const n0 = vec3(side.negate().mul(sin(ang)), cos(ang), 0);
      const nx = n0.x.mul(cr).sub(n0.y.mul(sr));
      const ny = n0.x.mul(sr).add(n0.y.mul(cr));

      const world = pos.add(rgt.mul(xr)).add(upv.mul(yr)).add(fwd.mul(z0));

      // The atlas tile. Each tile holds a WHOLE butterfly or leaf, and the
      // card's two halves take the painting's two halves — so a wing carries
      // its own painted half, asymmetry and all, and the fold still happens
      // at the body.
      //
      // flipY is off on the atlas, so v counts DOWN the canvas and the card's
      // v (0 at the tail) is flipped into it. Kept in floats: integer div/mod
      // on a node is one more place for a backend to disagree, and a tile
      // index is a small whole number anyway.
      const tile = r2.y;
      const col = tile.mod(float(ATLAS_TILES));
      const rowT = floor(tile.div(float(ATLAS_TILES)));
      const inv = float(1 / ATLAS_TILES);
      const tu = float(0.5).add(side.mul(cu).mul(0.5));
      vTile.assign(vec2(col.add(tu).mul(inv), rowT.add(float(1).sub(cv)).mul(inv)));

      vU.assign(cu);
      vEffect.assign(float(e));
      vJitter.assign(field.slotRand(slot, 45).sub(0.5).mul(2).mul(r5.w));
      vNormal.assign(normalize(rgt.mul(nx).add(upv.mul(ny))));
      vWorld.assign(world);
      // Salt 51 — this particle's own dissolve threshold. See the header.
      vFade.assign(ageFade(age, life, state).sub(field.slotRand(slot, 51).mul(0.9)));

      return world;
    })();

    // Always toward the viewer: a wing showing its underside must not go black
    // next to a lit one. Same argument as the foliage's leaflets.
    const nView = cameraViewMatrix.mul(vec4(normalize(vNormal), 0)).xyz.normalize();
    mat.normalNode = nView.mul(faceDirection);

    const sunVis = terrainSunVisibilityHere();
    const detail = texture(atlas, vTile);

    const baseColor = Fn(() => {
      const row = (r) => field.u.uRows.element(int(vEffect.add(0.5)).mul(AMBIENT_ROWS).add(r));
      // The PAINTING is the colour. The effect's two colours are a tint over
      // it, spine to tip, and at tint 0 they do nothing at all — a painted
      // Ulysses does not want recolouring, while a drift of one photographed
      // maple does want a little variety.
      const tintCol = mix(row(0).xyz, row(1).xyz, saturate(vU));
      const col = detail.rgb.mul(mix(vec3(1), tintCol.mul(2), row(6).w)).toVar();
      // Per-individual drift on top, so a swarm is not one image repeated.
      const j = vJitter;
      return col.mul(vec3(float(1).add(j.mul(0.5)), float(1).add(j.mul(0.2)), float(1).sub(j.mul(0.4))));
    });
    const col = baseColor();
    mat.colorNode = terrainShade(col, sunVis);
    mat.terrainSunShadowNode = sunVis;

    // Sun through the wing. A butterfly backlit is most of what makes one
    // read at all, so this is not a garnish.
    mat.emissiveNode = Fn(() => {
      const row = (r) => field.u.uRows.element(int(vEffect.add(0.5)).mul(AMBIENT_ROWS).add(r));
      const V = normalize(cameraPosition.sub(vWorld));
      const behind = pow(saturate(dot(V, u.uSunDir.negate())), 3).mul(sunVis);
      return col.mul(behind.mul(row(6).x).mul(u.uGlow).mul(1.1));
    })();

    // Shape from the atlas alpha; the particle's own dissolve on top of it.
    mat.opacityNode = Fn(() => {
      Discard(vFade.lessThan(0));
      Discard(detail.a.lessThan(0.45));
      return float(1);
    })();
    // NOTE for anyone tempted to switch casting on: the shadow pass ignores
    // opacityNode, so these cards would throw solid rectangles. They would
    // need a maskShadowNode off the atlas alpha — and a butterfly's shadow is
    // not worth a cascade, which is why nothing here casts at all.

    return mat;
  }

  get triangles() { return this.field.triangles; }
  get meshes() { return this.field.meshes; }

  /**
   * Editor state → uniform rows and slices. Cheap enough to call every frame,
   * but the editor calls it on change.
   * @param {object} fx    createAmbientFxState shape
   * @param {object} [gp]  grassState — the shared wind
   * @param {THREE.Vector3} [sunDir]  toward the sun
   */
  syncFromState(fx, gp = null, sunDir = null) {
    const field = this.field;
    const slices = sliceBudgets(fx.effects, AMBIENT_MAX_PARTICLES);
    field.setSlices(slices, fx.effects.map(() => SHAPE_CARD));
    field.syncCommon({
      volumeXZ: fx.volumeXZ,
      volumeY: fx.volumeY,
      tier: fx.tier,
      wind: gp,
      windMul: fx.windMul,
    });
    if (sunDir) this.u.uSunDir.value.copy(sunDir).normalize();

    const c = new THREE.Color();
    const rows = field.effectRows;
    for (let i = 0; i < this.effectCount; i++) {
      const e = fx.effects[i];
      const o = i * AMBIENT_ROWS;
      c.set(e.colorA); rows[o].set(c.r, c.g, c.b, e.size);
      c.set(e.colorB); rows[o + 1].set(c.r, c.g, c.b, e.sizeVar);
      rows[o + 2].set(e.motion, e.tile, e.speed, e.lifetime);
      rows[o + 3].set(e.altMin, e.altMax, e.heightMin ?? -1e5, e.heightMax ?? 1e5);
      rows[o + 4].set(e.slopeMinY, e.flapRate, e.windCoupling, e.turbulence);
      // fadeEnd must stay clear of the box wall, or a particle would be killed
      // for leaving while still fully visible — the one way this design shows
      // its seams.
      const wall = fx.volumeXZ * 0.46;
      const fadeEnd = Math.min(e.fadeEnd, wall);
      rows[o + 5].set(Math.min(e.fadeStart, fadeEnd - 1), fadeEnd, e.minPixels, e.colorVar);
      rows[o + 6].set(e.translucency, e.settleTime, e.flapAmp, e.tint ?? 0);
      const w = dayWindow(e.dayStart, e.dayEnd, e.daySoft);
      rows[o + 7].set(e.area === "painted" ? 0 : 1, w.s01, w.len01, w.soft01);
    }

    // Nothing painted, nothing budgeted: skip the draw entirely.
    this._anyLive = slices.total > 0;
    field.setShapeUsed([this._anyLive]);
  }

  /** True while at least one effect has live slots. */
  get anyLive() { return !!this._anyLive; }

  /** The world's clock, 0..24. */
  setHour(h) { this.field.setHour(h); }

  init(camera) { return this.field.init(camera); }
  setEnabled(on) { this.field.setEnabled(on); }
  setViewportHeight(h) { this.field.setViewportHeight(h); }
  update(anchorPos, camera, dt, forwardOffset) {
    this.field.update(anchorPos, camera, dt, forwardOffset);
  }
  dispose() {
    this._atlas?.dispose();
    this.field.dispose();
  }
}
