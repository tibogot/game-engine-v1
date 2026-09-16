/**
 * Waterfall spray and mist — GPU particles (TSL compute / WebGPU).
 *
 * TWO fields, one system, two draw calls in total however many waterfalls are
 * in the scene:
 *
 *   SPRAY — droplets torn off the impact and off the falling sheet. They are
 *     thrown out ballistically, stretched along the way they travel (a droplet
 *     moving 10 m/s covers 16 cm in a 60th of a second, and drawing it as a
 *     round dot is what makes cheap particles read as confetti), and die out
 *     quickly.
 *   MIST — the cloud that hangs in the gorge. Slow, big, soft, rising and
 *     drifting, fading into whatever it touches (scene depth), and LIT: it
 *     scatters sunlight forward, so it glows when you look toward the sun
 *     through it, and takes its ambient from the sky colour.
 *
 * Everything is simulated on the GPU. The CPU only writes the emitters: one
 * vec4 pair per waterfall (where the impact is, how wide, how hard it hits, and
 * which way the water was going), updated when a fall is re-solved.
 *
 * Particles are spawned from an emitter chosen by the particle's own index, so
 * the field divides itself between the waterfalls on screen with no CPU work
 * and no per-fall buffers.
 */
import * as THREE from "three";
import {
  Fn, If, uniform, uniformArray, float, int, vec2, vec3, vec4, instancedArray, instanceIndex,
  hash, time, deltaTime, uv, cameraPosition, cameraViewMatrix, cameraProjectionMatrix, positionLocal,
  screenUV, cameraNear, cameraFar, perspectiveDepthToViewZ, smoothstep, saturate, mix, dot, normalize,
  pow, sin, cos, select, length,
} from "three/tsl";
import { sceneDepthGrab } from "../water/lakeMaterial.js";

/** Waterfalls that can emit at once. Beyond this the nearest ones win. */
export const MAX_EMITTERS = 8;

const TAU = Math.PI * 2;

/**
 * @param {object} o
 * @param {THREE.Renderer} o.renderer
 * @param {object} o.look          waterfallState look
 * @param {number} [o.maxSpray]
 * @param {number} [o.maxMist]
 */
export function createWaterfallSpray({ renderer, look, maxSpray = 3000, maxMist = 900 }) {
  // Emitter rows: (x, y, z, radius) and (dirX, dirZ, strength, height of the fall).
  const emitA = [], emitB = [];
  for (let i = 0; i < MAX_EMITTERS; i++) { emitA.push(new THREE.Vector4()); emitB.push(new THREE.Vector4()); }
  const uEmitA = uniformArray(emitA, "vec4");
  const uEmitB = uniformArray(emitB, "vec4");
  const uEmitCount = uniform(0);

  const u = {
    sprayAmount: uniform(look.sprayAmount),
    spraySpeed: uniform(look.spraySpeed),
    sprayLife: uniform(look.sprayLife),
    spraySize: uniform(look.spraySize),
    sprayOpacity: uniform(look.sprayOpacity),
    mistAmount: uniform(look.mistAmount),
    mistRise: uniform(look.mistRise),
    mistLife: uniform(look.mistLife),
    mistSize: uniform(look.mistSize),
    mistGrow: uniform(look.mistGrow),
    mistOpacity: uniform(look.mistOpacity),
    mistSpread: uniform(look.mistSpread),
    wind: uniform(new THREE.Vector2(look.windX, look.windZ)),
    color: uniform(new THREE.Color(look.sprayColor)),
    sunDir: uniform(new THREE.Vector3(0.4, 0.6, 0.3).normalize()),
    sunColor: uniform(new THREE.Color(1, 0.97, 0.92)),
    sunIntensity: uniform(3),
    skyColor: uniform(new THREE.Color(0.55, 0.68, 0.85)),
    ambientColor: uniform(new THREE.Color(0.85, 0.9, 1)),
    ambientIntensity: uniform(1),
    scatter: uniform(look.mistScatter),
    sprayStretch: uniform(look.sprayStretch),
    softDepth: uniform(look.spraySoftDepth),
    fadeDistance: uniform(look.sprayDistance),
  };

  const gravity = float(9.81);

  /** One field: positions, velocities, and (age, ttl, seed) per particle. */
  function makeField(maxCount, isMist) {
    const posBuf = instancedArray(maxCount, "vec3");
    const velBuf = instancedArray(maxCount, "vec3");
    const lifeBuf = instancedArray(maxCount, "vec3");   // age, ttl, seed

    const rand = (salt) => hash(instanceIndex.toFloat().add(salt).add(time.mul(1731)));
    const fixed = (salt) => hash(instanceIndex.toFloat().add(salt));

    /**
     * Put this particle back at one of the emitters. A plain JS helper, NOT an
     * `Fn`: an Fn takes its arguments by value, so assignments inside one would
     * never reach the storage buffer.
     */
    const spawn = (pos, vel, life) => {
      // Which waterfall: fixed per particle, so the field splits evenly and a
      // particle keeps its fall for its whole life.
      const e = int(fixed(7.3).mul(uEmitCount.toFloat().max(1)).floor().min(uEmitCount.toFloat().sub(1).max(0)));
      const A = uEmitA.element(e), B = uEmitB.element(e);
      const radius = A.w, strength = B.z, height = B.w;
      const ang = rand(11).mul(TAU);
      const rr = rand(12).sqrt();

      if (isMist) {
        // Mist rises from the whole plunge area and up the face of the fall.
        const up = rand(13);
        pos.assign(vec3(
          A.x.add(cos(ang).mul(rr).mul(radius).mul(u.mistSpread)),
          A.y.add(up.mul(height.mul(0.55).add(2))),
          A.z.add(sin(ang).mul(rr).mul(radius).mul(u.mistSpread)),
        ));
        vel.assign(vec3(
          rand(14).sub(0.5).mul(0.6).add(u.wind.x),
          u.mistRise.mul(rand(15).mul(0.6).add(0.7)),
          rand(16).sub(0.5).mul(0.6).add(u.wind.y),
        ));
        life.assign(vec3(0, u.mistLife.mul(rand(17).mul(0.5).add(0.75)), fixed(18)));
      } else {
        // Spray is thrown from the impact itself, mostly up and downstream.
        pos.assign(vec3(
          A.x.add(cos(ang).mul(rr).mul(radius).mul(0.7)),
          A.y.add(rand(19).mul(0.6)),
          A.z.add(sin(ang).mul(rr).mul(radius).mul(0.7)),
        ));
        const sp = u.spraySpeed.mul(strength).mul(rand(20).mul(0.7).add(0.5));
        vel.assign(vec3(
          cos(ang).mul(rr).mul(sp).add(B.x.mul(sp).mul(0.35)),
          sp.mul(rand(21).mul(0.6).add(0.75)),
          sin(ang).mul(rr).mul(sp).add(B.y.mul(sp).mul(0.35)),
        ));
        life.assign(vec3(0, u.sprayLife.mul(rand(22).mul(0.6).add(0.7)), fixed(23)));
      }
    };

    const computeInit = Fn(() => {
      const pos = posBuf.element(instanceIndex);
      const vel = velBuf.element(instanceIndex);
      const life = lifeBuf.element(instanceIndex);
      spawn(pos, vel, life);
      // Spread the first cycle out, or the whole field pulses together.
      life.x = fixed(29).mul(life.y);
    })().compute(maxCount);

    const computeUpdate = Fn(() => {
      const pos = posBuf.element(instanceIndex);
      const vel = velBuf.element(instanceIndex);
      const life = lifeBuf.element(instanceIndex);
      // A tab returning from the background hands over several seconds at once.
      const dt = deltaTime.min(0.05).toVar();

      life.x = life.x.add(dt);
      // The amount slider kills the particles above its share of the field, so
      // the slider costs simulation rather than only hiding particles.
      const share = isMist ? u.mistAmount : u.sprayAmount;
      const dead = fixed(31).greaterThanEqual(share).or(uEmitCount.lessThanEqual(0));

      If(life.x.greaterThan(life.y).or(dead), () => {
        spawn(pos, vel, life);
        // A particle over the share is parked: respawned, then aged out at once.
        If(dead, () => { life.x = life.y.add(1); });
      }).Else(() => {
        if (isMist) {
          // Mist is carried, not thrown: heavy drag, gentle lift, wind.
          const drag = float(1).sub(dt.mul(0.9)).max(0);
          vel.x = vel.x.mul(drag).add(u.wind.x.mul(dt.mul(0.9)));
          vel.z = vel.z.mul(drag).add(u.wind.y.mul(dt.mul(0.9)));
          vel.y = vel.y.mul(drag).add(u.mistRise.mul(dt.mul(0.9)));
        } else {
          vel.y = vel.y.sub(gravity.mul(dt));
          const drag = float(1).sub(dt.mul(0.55)).max(0);
          vel.x = vel.x.mul(drag).add(u.wind.x.mul(dt.mul(0.4)));
          vel.z = vel.z.mul(drag).add(u.wind.y.mul(dt.mul(0.4)));
        }
        pos.assign(pos.add(vel.mul(dt)));
      });
    })().compute(maxCount);

    // ── Draw ──
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = false;
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendSrc = THREE.SrcAlphaFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = THREE.ZeroFactor;
    material.blendDstAlpha = THREE.OneFactor;
    material.depthWrite = false;
    material.depthTest = true;
    material.side = THREE.DoubleSide;
    material.fog = true;

    const worldPos = posBuf.toAttribute();
    const lifeAttr = lifeBuf.toAttribute();
    const velAttrRef = velBuf.toAttribute();
    const ageFrac = saturate(lifeAttr.x.div(lifeAttr.y.max(0.01)));

    // Size: spray is small and constant, mist swells as it drifts.
    const size = isMist
      ? u.mistSize.mul(mix(0.5, u.mistGrow, ageFrac)).mul(lifeAttr.z.mul(0.6).add(0.7))
      : u.spraySize.mul(lifeAttr.z.mul(0.8).add(0.6));

    // A view-space billboard, written out rather than using `billboarding()`,
    // for two reasons: the size is PER PARTICLE (that helper takes it from the
    // mesh's matrix), and a droplet is stretched along the direction it is
    // actually travelling — a fast droplet drawn as a round dot reads as
    // confetti, not as water.
    material.vertexNode = Fn(() => {
      const centre = cameraViewMatrix.mul(vec4(worldPos, 1)).toVar();
      const local = positionLocal.xy.toVar();
      const offset = vec2(local.x.mul(size), local.y.mul(size)).toVar();
      if (!isMist) {
        const vView = cameraViewMatrix.mul(vec4(velAttrRef, 0)).xy.toVar();
        const speed = length(vView).toVar();
        // Only stretch when it is really moving, and never into a needle.
        const dir = select(speed.greaterThan(0.25), vView.div(speed.max(1e-4)), vec2(0, 1)).toVar();
        const stretch = float(1).add(saturate(speed.mul(0.06)).mul(u.sprayStretch));
        const perp = vec2(dir.y, dir.x.negate());
        offset.assign(perp.mul(local.x.mul(size)).add(dir.mul(local.y.mul(size).mul(stretch))));
      }
      return cameraProjectionMatrix.mul(vec4(centre.xy.add(offset), centre.z, centre.w));
    })();

    material.colorNode = Fn(() => {
      const toCam = normalize(worldPos.sub(cameraPosition));
      // Forward scattering: water droplets throw light on toward the viewer, so
      // mist lights up when the sun is behind it (Henyey-Greenstein, cheap form).
      const cosA = dot(toCam, u.sunDir);
      const g = float(0.6);
      const hg = float(1).sub(g.mul(g)).div(
        pow(float(1).add(g.mul(g)).sub(g.mul(2).mul(cosA)).max(1e-3), 1.5),
      ).mul(0.35);
      const sun = u.sunColor.mul(u.sunIntensity).mul(hg.mul(u.scatter).add(0.25));
      // Ambient comes from the scene's own fill light, with a touch of the sky's
      // colour for the time of day. Taking it from the sky ZENITH alone made the
      // mist deep blue at noon, which is the colour straight up, not the light.
      const ambient = u.ambientColor.mul(u.ambientIntensity).mul(0.75).add(u.skyColor.mul(0.2));
      return u.color.mul(ambient.add(sun));
    })();

    material.opacityNode = Fn(() => {
      const t = uv();
      // A round soft blob; spray is stretched by the geometry, not here.
      const d = t.sub(vec2(0.5)).length().mul(2);
      // Mist is a soft puff with no edge at all; a droplet keeps a core.
      const shape = isMist ? smoothstep(1, 0.08, d) : saturate(float(1).sub(d)).pow(2.2);
      // In and out over the particle's life.
      const fade = smoothstep(0, 0.12, ageFrac).mul(smoothstep(1, isMist ? 0.45 : 0.7, ageFrac));
      // Soft where it meets the ground, the cliff or the water. The depth has to
      // come from the particle's WORLD position: the billboard vertex node
      // replaces the vertex position, so `positionView` would describe where the
      // quad would have been, not where it is.
      const sceneDist = perspectiveDepthToViewZ(sceneDepthGrab.sample(screenUV).r, cameraNear, cameraFar).negate();
      const viewZ = cameraViewMatrix.mul(vec4(worldPos, 1)).z.negate();
      const soft = smoothstep(0, u.softDepth.add(0.02), sceneDist.sub(viewZ));
      // Out of sight, out of cost.
      const dist = worldPos.sub(cameraPosition).length();
      const far = float(1).sub(smoothstep(u.fadeDistance.mul(0.7), u.fadeDistance, dist));
      const near = smoothstep(0.35, 1.6, dist);
      return shape.mul(fade).mul(soft).mul(far).mul(near).mul(isMist ? u.mistOpacity : u.sprayOpacity);
    })();

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = isMist ? "WaterfallMist" : "WaterfallSpray";
    mesh.count = maxCount;
    mesh.frustumCulled = false;
    mesh.renderOrder = isMist ? 112 : 111;
    mesh.visible = false;

    return { mesh, material, computeInit, computeUpdate };
  }

  const spray = makeField(maxSpray, false);
  const mist = makeField(maxMist, true);
  let seeded = false;

  /** Emitters from the solved falls: [{ fall, solved }], nearest first. */
  function setEmitters(entries, look) {
    const n = Math.min(MAX_EMITTERS, entries.length);
    for (let i = 0; i < n; i++) {
      const { fall, solved } = entries[i];
      const im = solved.impact;
      emitA[i].set(im.x, im.y, im.z, Math.max(1, im.width * 0.5));
      // Strength: how hard it lands, softened so a 100 m fall is not 10× a 10 m one.
      const strength = Math.min(2.5, Math.sqrt(Math.max(0.5, im.speed)) * 0.45) * (fall.foam ?? 1);
      emitB[i].set(im.dirX, im.dirZ, strength, Math.max(1, solved.drop));
    }
    uEmitCount.value = n;
    const on = n > 0;
    spray.mesh.visible = on && look.sprayEnabled !== false && look.sprayAmount > 0.001;
    mist.mesh.visible = on && look.mistEnabled !== false && look.mistAmount > 0.001;
    return n;
  }

  function update() {
    if (!spray.mesh.visible && !mist.mesh.visible) return;
    if (!seeded) {
      renderer.compute(spray.computeInit);
      renderer.compute(mist.computeInit);
      seeded = true;
    }
    if (spray.mesh.visible) renderer.compute(spray.computeUpdate);
    if (mist.mesh.visible) renderer.compute(mist.computeUpdate);
  }

  function syncParams(look) {
    u.sprayAmount.value = look.sprayAmount;
    u.spraySpeed.value = look.spraySpeed;
    u.sprayLife.value = look.sprayLife;
    u.spraySize.value = look.spraySize;
    u.sprayOpacity.value = look.sprayOpacity;
    u.mistAmount.value = look.mistAmount;
    u.mistRise.value = look.mistRise;
    u.mistLife.value = look.mistLife;
    u.mistSize.value = look.mistSize;
    u.mistGrow.value = look.mistGrow;
    u.mistOpacity.value = look.mistOpacity;
    u.mistSpread.value = look.mistSpread;
    u.scatter.value = look.mistScatter;
    u.wind.value.set(look.windX, look.windZ);
    u.color.value.set(look.sprayColor);
    u.sprayStretch.value = look.sprayStretch;
    u.softDepth.value = look.spraySoftDepth;
    u.fadeDistance.value = look.sprayDistance;
  }

  return {
    sprayMesh: spray.mesh,
    mistMesh: mist.mesh,
    uniforms: u,
    setEmitters,
    update,
    syncParams,
    setSunDir(v) { u.sunDir.value.copy(v).normalize(); },
    setSunLight(color, intensity) { u.sunColor.value.copy(color); u.sunIntensity.value = intensity; },
    setSkyColor(c) { u.skyColor.value.copy(c); },
    setAmbient(color, intensity) { u.ambientColor.value.copy(color); u.ambientIntensity.value = intensity; },
    dispose() {
      spray.mesh.geometry.dispose(); spray.material.dispose();
      mist.mesh.geometry.dispose(); mist.material.dispose();
    },
  };
}
