/**
 * THE AMBIENT FIELD — the GPU machinery every ambient effect shares.
 *
 * It owns WHERE particles are and WHEN they live and die. An effect module
 * owns what they look like. This is the same division of labour as
 * v3/render/scatter/scatterField.js, and several of the moving parts are
 * literally the same code (gpuCull.js). What is NOT the same is the thing that
 * decides the whole architecture:
 *
 *     scatterField is STATELESS PLACEMENT. A plant's position is derived every
 *     frame from its tile slot and the anchor delta; nothing integrates. The
 *     wrap tile works precisely because plants do not move.
 *
 *     this is STATEFUL SIMULATION. A leaf has a velocity, an age and a moment
 *     where it lands. So there is no wrap tile: there is a camera-following
 *     BOX, and a particle that leaves it or dies is RESPAWNED by its effect's
 *     spawn rule.
 *
 * ── THE POOL IS STATICALLY SLICED ───────────────────────────────────────────
 *
 * One pool of `maxParticles` slots. Slot i belongs to effect e because i falls
 * inside e's slice, and an effect's BUDGET IS ITS SLICE LENGTH. No free list,
 * no allocation atomics, no spawn-rate bookkeeping — the whole per-effect
 * budget question answered by arithmetic on a uniform array.
 *
 * The slices come from sliceBudgets() on the CPU, which is pure and tested, so
 * a budget slider is a uniform write and never a reallocation.
 *
 * SCALABILITY TIERS fall out of the same arithmetic: `uTier` scales how much
 * of each slice may be alive. Slots above the line simply never spawn. Nothing
 * is freed, nothing is rebuilt, and it is free to change every frame.
 *
 * ── RESPAWN IS REJECTION SAMPLING ───────────────────────────────────────────
 *
 * A dead slot picks a candidate position, taps the world maps there, and
 * accepts with probability = the effect's rule at that point. Zero CPU, no
 * prefix sum, and it self-balances: where the rule is rarely satisfied, fewer
 * particles are alive, which is exactly right.
 *
 * Its one weakness is refill rate — if the rule is satisfied over 2% of the
 * box, a slot takes ~50 tries to be born and the field fades up over a second
 * after a teleport. So a slot REMEMBERS the position it last spawned at and
 * samples a disc around it most of the time, falling back to a uniform sample
 * often enough to keep finding new ground. Inside a region that works, refill
 * is immediate.
 *
 * ── FOUR CULL GATES, ALL IN THE COMPUTE ─────────────────────────────────────
 *
 *   frustum       gpuCull.frustumVisibleAtClip — the SAME test the plants use
 *   distance      stochastic thinning to fadeEnd, so nothing pops
 *   screen size   below minPixels a card is not drawn at all; a sub-pixel
 *                 triangle does not fade, it CRAWLS (the starfield lesson)
 *   near camera   a card at the near plane is a screen-wide smear
 *
 * All four are stochastic on a STABLE per-slot hash, never a per-frame one:
 * thinning a particle by a fresh random number every frame is a strobe.
 *
 * ── DRAWS ───────────────────────────────────────────────────────────────────
 *
 * One indirect draw per SHAPE CLASS, not per effect — every card effect shares
 * one material and one draw, and tells itself apart through its uniform row.
 * One compact list with a slice per shape, one indirect buffer, `firstInstance`
 * pointing at each slice, exactly as scatterField does it. This slice of the
 * work ships one shape class, so the whole mode is 1 compute and 1 draw.
 *
 * ── STORAGE, THREE vec4 PER PARTICLE ────────────────────────────────────────
 *
 *   bufA  (pos.xyz, age)
 *   bufB  (vel.xyz, life)      — a SETTLED leaf has no velocity, so its
 *                                ground normal is written over vel.xyz
 *   bufC  (hint.xz, state, hintValid)
 *
 * Size, colour jitter, lifetime spread and flap phase all come from
 * hash(slot), so none of them is stored.
 */
import * as THREE from "three";
import {
  Fn, If, abs, atomicAdd, atomicStore, clamp, cos, float, fract, hash, instanceIndex,
  instancedArray, int, length, max, min, mix, sin, smoothstep, sqrt, step, storage, texture, time,
  uint, uniform, uniformArray, vec2, vec3, vec4, PI2,
} from "three/tsl";
import { frustumVisibleAtClip, screenRadiusPixels, worldSizeForPixels } from "../scatter/gpuCull.js";
import { integrateMotion } from "./ambientMotion.js";

/** Never integrate more than this in one step: a hitch must not teleport the field. */
const MAX_DT = 1 / 20;

export class AmbientField {
  /**
   * @param {object} o
   *   scene, renderer
   *   name            group and mesh name prefix
   *   effectCount     effects (one uniform row block, one paint channel each)
   *   rows            vec4 uniform rows per effect
   *   maxParticles    the pool
   *   shapeCount      shape classes — one indirect draw each
   *   worldSize       terrain edge, metres
   *   heightTex       RGBA float, .x = terrain world Y
   *   terrainNormalTex RGBA float, .xyz = terrain normal
   *   windTex         the shared wind texture (grass / susuki / flowers)
   *   densityTex      painted density, one effect per channel — a single
   *                   texture, or an array when there are more than four
   *                   effects (four fit in one RGBA page). Null = no paint,
   *                   and every effect behaves as "everywhere".
   *   hintRadius      how far a respawn looks around its last success, metres
   */
  constructor({
    scene, renderer, name = "AmbientFX",
    effectCount, rows, maxParticles, shapeCount = 1,
    worldSize, heightTex, terrainNormalTex, windTex, densityTex = null, hintRadius = 9,
  }) {
    this.renderer = renderer;
    this.name = name;
    this.effectCount = effectCount;
    this.rows = rows;
    this.shapeCount = shapeCount;
    const count = (this.count = maxParticles);

    this.group = new THREE.Group();
    this.group.name = name;
    this.group.visible = false;
    scene.add(this.group);

    this.effectRows = Array.from({ length: effectCount * rows }, () => new THREE.Vector4());
    this._sliceStart = new Array(effectCount).fill(0);
    this._sliceLen = new Array(effectCount).fill(0);
    this._shapeOf = new Array(effectCount).fill(0);

    const u = (this.u = {
      uRows: uniformArray(this.effectRows, "vec4"),
      uSliceStart: uniformArray(this._sliceStart, "float"),
      uSliceLen: uniformArray(this._sliceLen, "float"),
      uShapeOf: uniformArray(this._shapeOf, "float"),
      uTier: uniform(1),

      /** The camera-following box. */
      uCenter: uniform(new THREE.Vector3()),
      uVolumeXZ: uniform(80),
      /** How far ABOVE THE GROUND the box reaches, metres — not a half-extent. */
      uVolumeY: uniform(34),
      uHintRadius: uniform(hintRadius),

      uWorldSize: uniform(worldSize),
      uDt: uniform(0),
      /** The world's clock, 0..24. Drives each effect's time-of-day window. */
      uHour: uniform(12),
      /** Bumped every frame — the ONLY place a per-frame random is wanted. */
      uSeed: uniform(0),

      /** Wind as a world velocity: direction, strength, and a gust scale. */
      uWindDir: uniform(new THREE.Vector2(1, 0)),
      uWindStrength: uniform(1.2),
      uWindGust: uniform(0.5),
      uWindWaveScale: uniform(0.12),
      uWindSpeed: uniform(0.2),

      uCameraMatrix: uniform(new THREE.Matrix4()),
      uCamPos: uniform(new THREE.Vector3()),
      uFx: uniform(1),
      uFy: uniform(1),
      uViewportH: uniform(1080),
      uCullPadNdc: uniform(0.25),
      /** Metres: a card closer than this to the camera thins out. */
      uNearFade: uniform(0.8),
    });

    const densityPages = densityTex ? (Array.isArray(densityTex) ? densityTex : [densityTex]) : [];

    const bufA = instancedArray(count, "vec4");   // pos.xyz, age
    const bufB = instancedArray(count, "vec4");   // vel.xyz (or ground normal), life
    const bufC = instancedArray(count, "vec4");   // hint.xz, state, hintValid
    const compactBuf = instancedArray(count * shapeCount, "uint");
    this.nodes = { bufA, bufB, bufC, compactBuf };

    // One indirect buffer: 5 args per shape draw; firstInstance = its slice.
    const args = new Uint32Array(shapeCount * 5);
    for (let m = 0; m < shapeCount; m++) args[m * 5 + 4] = m * count;
    const indirect = new THREE.IndirectStorageBufferAttribute(args, 5);
    this._indirect = indirect;
    const indirectStorage = storage(indirect, "uint", shapeCount * 5).toAtomic();

    this.computeReset = Fn(() => {
      for (let m = 0; m < shapeCount; m++) atomicStore(indirectStorage.element(m * 5 + 1), uint(0));
    })().compute(1, [1]);

    // Every slot starts dead, so frame one is entirely spawning.
    this.computeInit = Fn(() => {
      bufA.element(instanceIndex).assign(vec4(0, 0, 0, 1));
      bufB.element(instanceIndex).assign(vec4(0, 0, 0, 0));
      bufC.element(instanceIndex).assign(vec4(0, 0, 0, 0));
    })().compute(count, [64]);

    /* ── the one pass ────────────────────────────────────────────────────── */
    this.computeUpdate = Fn(() => {
      const a = bufA.element(instanceIndex);
      const b = bufB.element(instanceIndex);
      const c = bufC.element(instanceIndex);

      // Stable per-slot randoms (never frame-varying — see the header) and
      // per-frame ones for respawn only.
      const fi = float(instanceIndex);
      const sRnd = (salt) => hash(fi.mul(19.0).add(salt));
      const fRnd = (salt) => hash(fi.mul(19.0).add(u.uSeed).add(salt));

      // Which effect owns this slot: count how many slice starts it is past.
      // An empty effect's start equals its neighbour's, so it is skipped for
      // free and every effect keeps its uniform row block either way.
      const e = int(0).toVar();
      for (let k = 1; k < effectCount; k++) {
        e.addAssign(int(step(u.uSliceStart.element(k), fi)));
      }
      const row = (r) => u.uRows.element(e.mul(rows).add(r));
      // r0 (colorA.rgb, size)          r1 (colorB.rgb, sizeVar)
      // r2 (motion, tile, speed, lifetime)
      // r3 (altMin, altMax, heightMin, heightMax)
      // r4 (slopeMinY, flapRate, windCoupling, turbulence)
      // r5 (fadeStart, fadeEnd, minPixels, colorVar)
      // r6 (translucency, settleTime, flapAmp, -)
      // r7 (area "everywhere", day start01, day len01, day soft01)
      // r8 (faceCamera, pulseRate, pulseAmount, glow)   r9 (pixelFloor, -, -, -)
      const r2 = row(2), r3 = row(3), r4 = row(4), r5 = row(5), r6 = row(6), r7 = row(7),
        r9 = row(9);

      // Inside the live part of its slice? `uTier` scales every slice at once.
      const localIdx = fi.sub(u.uSliceStart.element(e));
      const allowed = step(localIdx.add(0.5), u.uSliceLen.element(e).mul(u.uTier));

      const pos = a.xyz.toVar();
      const vel = b.xyz.toVar();
      const age = a.w.toVar();
      const life = b.w.toVar();
      const state = c.z.toVar();
      const hint = c.xy.toVar();
      const hintValid = c.w.toVar();

      const halfXZ = u.uVolumeXZ.mul(0.5);
      const centerXZ = vec2(u.uCenter.x, u.uCenter.z);

      If(allowed.lessThan(0.5), () => {
        // Outside the tier's live budget. Held dead; costs nothing else.
        age.assign(1);
        life.assign(0);
      }).Else(() => {
        age.addAssign(u.uDt);

        If(age.greaterThanEqual(life), () => {
          /* ── RESPAWN ─────────────────────────────────────────────────── */
          // Mostly a disc around where this slot last succeeded, sometimes a
          // fresh uniform sample — see the header on refill rate.
          const nearHint = step(fRnd(11), 0.78).mul(hintValid);
          const ang = fRnd(12).mul(PI2);
          const rad = sqrt(fRnd(13)).mul(u.uHintRadius);
          const fromHint = hint.add(vec2(cos(ang), sin(ang)).mul(rad));
          const fromBox = centerXZ.add(vec2(fRnd(14).sub(0.5), fRnd(15).sub(0.5)).mul(u.uVolumeXZ));
          const cand = mix(fromBox, fromHint, nearHint).toVar();
          // A hint the camera has since driven away from must not spawn
          // anything outside the box.
          cand.assign(clamp(cand, centerXZ.sub(halfXZ), centerXZ.add(halfXZ)));

          const uvT = cand.div(u.uWorldSize).add(0.5);
          const gY = texture(heightTex, uvT).x;
          const gN = texture(terrainNormalTex, uvT).xyz;

          // ── THE RULE ──────────────────────────────────────────────────
          // Everything multiplies, and the product is a PROBABILITY, not a
          // yes/no: half-painted ground gets half as many butterflies, and
          // the edge of a brush stroke thins out instead of ending on a line.
          const band = smoothstep(r3.z.sub(2), r3.z.add(2), gY)
            .mul(float(1).sub(smoothstep(r3.w.sub(2), r3.w.add(2), gY)));
          const slope = smoothstep(r4.x, r4.x.add(0.12), gN.y);
          const mapHalf = u.uWorldSize.mul(0.5);
          const inMap = float(1).sub(smoothstep(mapHalf.sub(3), mapHalf, max(abs(cand.x), abs(cand.y))));

          // Painted density — one effect per channel, four to a page. An
          // effect set to "everywhere" (r7.x) ignores it entirely.
          const paint = float(1).toVar();
          if (densityPages.length) {
            const chans = [];
            for (const tex of densityPages) {
              const d = texture(tex, uvT);
              chans.push(d.x, d.y, d.z, d.w);
            }
            const picked = float(0).toVar();
            for (let k = 0; k < Math.min(effectCount, chans.length); k++) {
              If(e.equal(k), () => { picked.assign(chans[k]); });
            }
            paint.assign(mix(picked, float(1), r7.x));
          }

          // Time of day. The window wraps (fireflies at 19 → 5), and len01 = 1
          // is the "always" case the CPU flags rather than encoding as a
          // zero-length span.
          const day = float(1).toVar();
          If(r7.z.lessThan(0.999), () => {
            const t = fract(u.uHour.div(24).sub(r7.y));
            day.assign(smoothstep(float(0), r7.w, t)
              .mul(float(1).sub(smoothstep(r7.z.sub(r7.w), r7.z, t))));
          });

          const accept = step(fRnd(16), band.mul(slope).mul(inMap).mul(paint).mul(day));

          If(accept.greaterThan(0.5), () => {
            pos.assign(vec3(cand.x, gY.add(mix(r3.x, r3.y, fRnd(17))), cand.y));
            age.assign(0);
            // Spread so a whole effect never dies together and flickers.
            life.assign(r2.w.mul(mix(float(0.65), float(1.35), sRnd(18))));
            state.assign(0);
            hint.assign(cand);
            hintValid.assign(1);
            vel.assign(vec3(fRnd(19).sub(0.5), 0, fRnd(20).sub(0.5)).mul(r2.z));
          }).Else(() => {
            // Still dead. Pin the age so it cannot drift out of precision
            // while a slot waits for ground its rule likes.
            age.assign(life);
          });
        }).Else(() => {
          /* ── INTEGRATE ───────────────────────────────────────────────── */
          const uvT = vec2(pos.x, pos.z).div(u.uWorldSize).add(0.5);
          const gY = texture(heightTex, uvT).x;
          const gN = texture(terrainNormalTex, uvT).xyz;

          // The world's wind as a velocity: the same baked channels the grass
          // and the susuki read, so a gust moves the meadow and the
          // butterflies over it together.
          const tBase = time.mul(u.uWindSpeed);
          const gustUV = vec2(
            pos.x.mul(u.uWindWaveScale).mul(0.25).add(u.uWindDir.x.mul(tBase).mul(0.3)).div(3.0),
            pos.z.mul(u.uWindWaveScale).mul(0.25).add(u.uWindDir.y.mul(tBase).mul(0.3)).div(3.0),
          );
          const gust = texture(windTex, gustUV).y.mul(2).sub(1).mul(u.uWindGust);
          const windMag = u.uWindStrength.mul(float(1).add(gust));
          const wind = vec3(u.uWindDir.x.mul(windMag), 0, u.uWindDir.y.mul(windMag));

          integrateMotion({
            motionId: r2.x, pos, vel, state, age, life,
            dt: u.uDt, phase: sRnd(31), seed: sRnd(32),
            groundY: gY, groundN: gN, wind,
            band: vec2(r3.x, r3.y),
            speed: r2.z, turbulence: r4.w, flapRate: r4.y,
            windCoupling: r4.z, settleTime: r6.y,
          });

          // Left the box: die now, which respawns it next frame somewhere the
          // rule allows. It is not drawn this frame either — the compaction
          // test below is `age < life`, which this makes false.
          //
          // The VERTICAL test is against the GROUND under the particle, not
          // against the box's centre. The centre rides the camera, and an
          // editor camera is routinely a hundred metres up looking down — a
          // centre-relative test would then kill every particle the moment it
          // spawned, and the mode would look broken from any aerial view.
          const dXZ = max(abs(pos.x.sub(u.uCenter.x)), abs(pos.z.sub(u.uCenter.z)));
          const dY = pos.y.sub(gY);
          const outside = max(
            step(halfXZ, dXZ),
            max(step(u.uVolumeY, dY), step(dY, float(-2))),
          );
          If(outside.greaterThan(0.5), () => { age.assign(life); });
        });

        /* ── CULL AND COMPACT ──────────────────────────────────────────── */
        If(age.lessThan(life), () => {
          const authored = row(0).w.mul(mix(float(1).sub(row(1).w), float(1).add(row(1).w), sRnd(41)));
          const dist = length(pos.sub(u.uCamPos));
          // The pixel floor is applied HERE as well as in the material, and
          // it has to be: the screen-size gate below would otherwise cull a
          // particle at its authored size that the vertex stage was about to
          // grow, and the two would disagree about what is on screen.
          const size = max(authored,
            worldSizeForPixels(r9.x, dist, u.uFy, u.uViewportH)).toVar();
          const clip = u.uCameraMatrix.mul(vec4(pos, 1));
          const vis = frustumVisibleAtClip(clip, u.uFx, u.uFy, size,
            u.uCullPadNdc, u.uCullPadNdc, u.uCullPadNdc);

          // Thinned out across the whole fade window, not switched off at the
          // end of it, so the edge of the field is never a line.
          const distKeep = step(sRnd(42),
            min(float(1).sub(smoothstep(r5.x, r5.y, dist)).mul(1.5), float(1)));
          // Half, because `size` is tip to tip and this wants a radius.
          const px = screenRadiusPixels(size.mul(0.5), clip.w, u.uFy, u.uViewportH);
          const pxKeep = step(sRnd(43), smoothstep(r5.z.mul(0.6), r5.z, px));
          const nearKeep = step(sRnd(44), smoothstep(u.uNearFade.mul(0.35), u.uNearFade, dist));

          If(vis.mul(distKeep).mul(pxKeep).mul(nearKeep).greaterThan(0.5), () => {
            // One draw per shape class; the effect's row says which.
            const shape = int(u.uShapeOf.element(e).add(0.5));
            for (let s = 0; s < shapeCount; s++) {
              If(shape.equal(s), () => {
                const slot = atomicAdd(indirectStorage.element(s * 5 + 1), uint(1));
                compactBuf.element(slot.add(uint(s * count))).assign(instanceIndex);
              });
            }
          });
        });
      });

      a.assign(vec4(pos, age));
      b.assign(vec4(vel, life));
      c.assign(vec4(hint, state, hintValid));
    })().compute(count, [64]);

    this.meshes = [];
    this.triangles = new Array(shapeCount).fill(0);
    this._clock = 0;
    this._seed = 0;
    this._fwd = new THREE.Vector3();
    this._cameraMatrix = new THREE.Matrix4();
    this._initDone = false;
    this._enabled = false;
  }

  /** The uniform row `r` of the effect a particle carries. */
  rowOf(effectNode, r) {
    return this.u.uRows.element(int(effectNode.add(0.5)).mul(this.rows).add(r));
  }

  /**
   * Which effect owns a slot — the SAME derivation the compute uses, exposed
   * so the vertex stage reaches the same answer. Duplicating this by hand in a
   * material is how a particle ends up shaded as one effect and simulated as
   * another.
   * @returns {Node<int>}
   */
  effectOf(slotNode) {
    const fi = float(slotNode);
    const e = int(0).toVar();
    for (let k = 1; k < this.effectCount; k++) {
      e.addAssign(int(step(this.u.uSliceStart.element(k), fi)));
    }
    return e;
  }

  /**
   * A stable per-slot random, 0..1. The vertex stage MUST use the same salt as
   * the compute for anything both of them need (a card's size is culled on in
   * the compute and drawn with here — two different randoms and the screen-size
   * gate would be measuring a card that is not the one on screen).
   */
  slotRand(slotNode, salt) {
    return hash(float(slotNode).mul(19.0).add(salt));
  }

  /**
   * Create the shape meshes. One material per shape class.
   * @param {THREE.Material[]} materials one per shape class
   * @param {(shape:number) => { geometry: THREE.BufferGeometry, triangles: number }} makeGeometry
   */
  attachShapes(materials, makeGeometry) {
    for (let s = 0; s < this.shapeCount; s++) {
      const { geometry, triangles } = makeGeometry(s);
      this._indirect.array[s * 5] = geometry.index.count;
      geometry.setIndirect(this._indirect, s * 5 * 4);
      const mesh = new THREE.Mesh(geometry, materials[Math.min(s, materials.length - 1)]);
      mesh.count = this.count;
      mesh.frustumCulled = false;   // the compute culls, per particle
      mesh.castShadow = false;      // a butterfly's shadow is not worth a cascade
      mesh.receiveShadow = false;
      // Positions are ABSOLUTE world metres — unlike scatterField, there is no
      // wrap tile to be relative to — so the mesh must stay at the origin.
      mesh.position.set(0, 0, 0);
      mesh.name = `${this.name}:shape${s}`;
      this.meshes.push(mesh);
      this.triangles[s] = triangles;
      this.group.add(mesh);
    }
    this._indirect.needsUpdate = true;
  }

  /**
   * Re-slice the pool from the effects' budgets, and take the per-effect
   * settings that are not uniform rows.
   * @param {{starts:number[], lengths:number[]}} slices  from sliceBudgets()
   * @param {number[]} shapeOf  shape class per effect
   */
  setSlices(slices, shapeOf) {
    for (let i = 0; i < this.effectCount; i++) {
      this._sliceStart[i] = slices.starts[i] ?? 0;
      this._sliceLen[i] = slices.lengths[i] ?? 0;
      this._shapeOf[i] = shapeOf[i] ?? 0;
    }
  }

  /** The camera-following box and the world's wind. */
  syncCommon({ volumeXZ, volumeY, tier, nearFade, wind = null, windMul = 1 }) {
    const u = this.u;
    const set = (uni, v) => { if (v !== undefined) uni.value = v; };
    set(u.uVolumeXZ, volumeXZ);
    set(u.uVolumeY, volumeY);
    set(u.uTier, tier);
    set(u.uNearFade, nearFade);
    if (wind) {
      u.uWindSpeed.value = wind.windSpeed ?? 0.2;
      u.uWindStrength.value = (wind.windStrength ?? 1.4) * windMul;
      u.uWindGust.value = wind.windGust ?? 0.3;
      u.uWindWaveScale.value = wind.windWaveScale ?? 0.12;
      const wr = ((wind.windAngle ?? 0) * Math.PI) / 180;
      u.uWindDir.value.set(Math.cos(wr), Math.sin(wr));
    }
  }

  async init(camera) {
    await this.renderer.computeAsync(this.computeInit);
    this._initDone = true;
    for (const m of this.meshes) await this.renderer.compileAsync(m, camera);
  }

  get ready() { return this._initDone; }

  setEnabled(on) {
    this._enabled = !!on;
    this.group.visible = this._enabled;
  }

  /** Hide a shape's draw when no effect using it has any budget. */
  setShapeUsed(used) {
    for (let s = 0; s < this.shapeCount; s++) this.meshes[s].visible = !!used[s];
  }

  /**
   * Per frame: move the box, then run the one compute.
   * @param {THREE.Vector3} anchorPos  camera in the editor, player in play mode
   * @param {THREE.Camera} camera
   * @param {number} dt  seconds since the last frame
   * @param {number} forwardOffset  fraction of volumeXZ to push the box ahead
   */
  update(anchorPos, camera, dt, forwardOffset = 0) {
    if (!this._initDone || !this._enabled) return;
    const u = this.u;

    // The box sits ahead of the anchor along the view: at any speed the budget
    // belongs on the ground you are about to reach, not the ground behind you.
    this._fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    this._fwd.y = 0;
    if (this._fwd.lengthSq() > 1e-6) this._fwd.normalize();
    const push = u.uVolumeXZ.value * forwardOffset;
    u.uCenter.value.set(
      anchorPos.x + this._fwd.x * push,
      anchorPos.y,
      anchorPos.z + this._fwd.z * push,
    );

    u.uDt.value = Math.min(Math.max(dt, 0), MAX_DT);
    // Kept well inside float's exact-integer range: the compute adds it to a
    // slot index and hashes the sum, and a seed that loses its low bits would
    // quietly stop being random.
    this._seed = (this._seed + 9973) % 8388608;
    u.uSeed.value = this._seed;

    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    this._cameraMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.uCameraMatrix.value.copy(this._cameraMatrix);
    const el = camera.projectionMatrix.elements;
    u.uFx.value = el[0];
    u.uFy.value = el[5];

    this.renderer.compute([this.computeReset, this.computeUpdate]);
  }

  /** The world's clock, 0..24 — each effect's time-of-day window reads it. */
  setHour(h) { this.u.uHour.value = h; }

  /** Render height in pixels — the screen-size cull needs it. */
  setViewportHeight(h) { this.u.uViewportH.value = Math.max(1, h); }

  dispose() {
    for (const m of this.meshes) m.geometry?.dispose();
    this.group.parent?.remove(this.group);
  }
}
