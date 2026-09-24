// FLAMES — burning wrecks and burning ground, on a flipbook of a real fire.
// GAME code, nam-rts only; the same interface as fireSystem.js (addFire,
// update, clear, activeCount), which stays as the procedural A/B
// (`?fire=procedural`).
//
// THE ATLAS is Unity Labs' CC0 "Flame02-temperature": 16x5 frames of a
// simulated flame, stored as TEMPERATURE (grey) rather than colour. The shader
// turns heat into colour — near-black red at the cool edge, orange, then
// yellow-white in the core — so every fire can have its own HEAT: a soldier's
// wreck smoulders, a napalm strip roars, and nothing clips to a white blob
// because the ramp, not the bloom, decides how hot the core looks.
//
// ── SHAPE ────────────────────────────────────────────────────────────────────
// A fire is ONE BLAZE: a tall main card with one or two shorter tongues
// overlapping it, each turned to the camera about the VERTICAL axis only, so a
// flame always stands up however the camera turns. Each loops the book from
// its own start frame and crossfades adjacent frames. A card fades where the
// ground meets it (height above the terrain, one heightmap tap — NOT the
// scene-depth grab, which costs two full-screen copies), so no slope cuts it.
//
// ── COST ─────────────────────────────────────────────────────────────────────
// One instanced draw. The cards' rows are written when a fire STARTS or is put
// out, never per frame: fade-in, burn-down and fade-out are functions of the
// clock in the vertex stage (start and end times ride in the instance data).
import * as THREE from "three";
import {
  Fn, attribute, cameraPosition, float, floor, fract, mix, normalize, output, positionLocal,
  positionWorld, saturate, smoothstep, step, texture, uniform, uv, varying, vec2, vec3, vec4,
} from "three/tsl";
import { drapeY } from "./terrainDrape.js";

export const FLAME_ATLAS = {
  url: "/textures/fx/flame02_temperature_16x5.png",
  // FIVE rows of 16, not four: sliced as 16x4 (the first try) every frame was
  // a strip cut through the middle of a flame — flat tops, flat bottoms.
  cols: 16, rows: 5, width: 2048, height: 1024,
  /** Cell aspect, width / height: 128 x 204.8 px. */
  aspect: 0.625,
  fps: 24,
};

const MAX_CARDS = 256;

class FlameMRTNode extends THREE.MRTNode {
  static get type() { return "FlameMRTNode"; }
  setup(builder) {
    const textures = builder.renderer.getRenderTarget()?.textures;
    const anyNamed = !!textures && textures.some((t) => this.outputNodes[t.name] !== undefined);
    if (anyNamed) return super.setup(builder);
    this.members = [vec4(output)];
    return THREE.Node.prototype.setup.call(this, builder);
  }
}

/**
 * @param {object} o
 *   app        the engine handle (scene)
 *   intensity  overall brightness of the colour ramp
 *   bloom      share of it written to the emissive (bloom) buffer
 */
export function createFlameField({ app, intensity = 0.95, bloom = 0.3 } = {}) {
  const uTime = uniform(0);
  const uIntensity = uniform(intensity);
  const uBloom = uniform(bloom);
  /** Soft-particle fade distance, metres. */
  const uSoft = uniform(1.6);

  const atlas = new THREE.TextureLoader().load(FLAME_ATLAS.url);
  // Temperature is DATA, not colour: no sRGB decode.
  atlas.colorSpace = THREE.NoColorSpace;
  atlas.anisotropy = 4;

  const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);   // base at y = 0
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute("position", quad.attributes.position);
  geo.setAttribute("uv", quad.attributes.uv);
  //   iPos   x, y, z, height (m)
  //   iLife  start, end, seed, heat (0..1.5)
  const posArr = new Float32Array(MAX_CARDS * 4);
  const lifeArr = new Float32Array(MAX_CARDS * 4);
  const iPos = new THREE.InstancedBufferAttribute(posArr, 4);
  const iLife = new THREE.InstancedBufferAttribute(lifeArr, 4);
  geo.setAttribute("iPos", iPos);
  geo.setAttribute("iLife", iLife);
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  quad.dispose();

  const vSeed = varying(float(0), "v_fl_seed");
  const vHeat = varying(float(0), "v_fl_heat");

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, side: THREE.FrontSide, toneMapped: true,
  });
  material.name = "NamFlame";
  material.fog = false;

  const FADE_IN = 0.6, FADE_OUT = 1.8;
  material.positionNode = Fn(() => {
    const p = attribute("iPos", "vec4");
    const l = attribute("iLife", "vec4");
    // Grows in over FADE_IN, burns down over the last FADE_OUT before `end`.
    const grow = smoothstep(l.x, l.x.add(FADE_IN), uTime);
    const die = float(1).sub(smoothstep(l.y.sub(FADE_OUT), l.y, uTime));
    const alive = step(l.x, uTime).mul(step(uTime, l.y));
    const k = grow.mul(die).mul(alive);
    const h = p.w.mul(mix(float(0.35), float(1), k)).mul(step(float(1e-3), k));
    // Sunk a tenth of its height and NOT lifted toward the camera, so the
    // flame stands IN the ground. Where the terrain cuts the card it is
    // softened in the colour stage (a soft-particle depth fade): the base of
    // the flame is its hottest part, and on a slope a vertical card met the
    // ground in a hard slanted line of white (the second try sank it a fifth
    // and faded its bottom quarter; neither fixed a slope).
    const base = vec3(p.x, p.y.sub(p.w.mul(0.1)), p.z);
    // Turned to the camera about the vertical axis only: a flame stands up.
    const toCam = cameraPosition.sub(base);
    const flat = normalize(vec3(toCam.x, 0, toCam.z).add(vec3(1e-4, 0, 0)));
    const right = vec3(flat.z, 0, flat.x.negate());
    const lifted = base;
    vSeed.assign(l.z);
    vHeat.assign(l.w.mul(k));
    return lifted
      .add(right.mul(positionLocal.x.mul(h).mul(FLAME_ATLAS.aspect)))
      .add(vec3(0, positionLocal.y.mul(h), 0));
  })();

  const F = FLAME_ATLAS;
  const frames = F.cols * F.rows;
  const insetU = 0.5 / (F.width / F.cols), insetV = 0.5 / (F.height / F.rows);
  const cellUV = (idx) => {
    const col = idx.mod(F.cols), row = floor(idx.div(F.cols));
    const lu = uv().x.clamp(insetU, 1 - insetU), lv = uv().y.clamp(insetV, 1 - insetV);
    return vec2(col.add(lu).div(F.cols), float(F.rows - 1).sub(row).add(lv).div(F.rows));
  };
  const colour = Fn(() => {
    const f = vSeed.mul(frames).add(uTime.mul(F.fps));
    const f0 = floor(f).mod(frames), f1 = f0.add(1).mod(frames);
    const tRaw = mix(texture(atlas, cellUV(f0)).r, texture(atlas, cellUV(f1)).r, fract(f));
    // Heat scales the temperature: a cooler fire never reaches the white core.
    const t = tRaw.mul(vHeat);
    // Blackbody-ish ramp: dark red -> orange -> yellow -> near white.
    const c1 = mix(vec3(0.25, 0.02, 0.0), vec3(1.0, 0.28, 0.02), smoothstep(float(0.08), float(0.38), t));
    const c2 = mix(c1, vec3(1.0, 0.62, 0.12), smoothstep(float(0.35), float(0.65), t));
    const c3 = mix(c2, vec3(1.0, 0.93, 0.7), smoothstep(float(0.62), float(0.95), t));
    // Where it is cool it is transparent: additive, so brightness IS coverage.
    // SOFT PARTICLE, against the GROUND: fade within uSoft metres of the
    // terrain under the fragment — the card fades into the ground it stands
    // in instead of being cut by it. One heightmap tap. (The first version
    // read the scene-depth grab, and ANY draw that reads it makes the frame
    // pay two full-screen copies — measured 2.7 ms at x1.55 res for a river
    // one vertex on screen — so every fire on screen cost that too.)
    // And the bottom fifth of the card fades too: the flame's
    // white-hot base sits a tenth of the way up its cell, so where the card
    // hangs over LOWER ground (an apron's edge) its bottom edge showed flat.
    const ground = drapeY(app.heightTexNode, positionWorld.x, positionWorld.z);
    const soft = saturate(positionWorld.y.sub(ground).div(uSoft));
    const a = smoothstep(float(0.04), float(0.22), t).mul(smoothstep(float(0.02), float(0.22), uv().y)).mul(soft);
    return c3.mul(a).mul(uIntensity).mul(t.mul(0.8).add(0.25));
  })();
  material.colorNode = colour;
  material.mrtNode = new FlameMRTNode({ emissive: colour.mul(uBloom) });

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = "NamFlames";
  mesh.frustumCulled = false;
  mesh.renderOrder = 13;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.visible = false;
  app.scene.add(mesh);

  // ── Fires and their cards ────────────────────────────────────────────────
  const fires = [];      // { x, y, z, radius, end, cards: [card] }
  const cards = [];      // { x, y, z, h, start, end, seed, heat, fire }
  let seedN = 0;
  let dirty = false;

  function write() {
    const n = Math.min(cards.length, MAX_CARDS);
    for (let i = 0; i < n; i++) {
      const c = cards[i];
      posArr.set([c.x, c.y, c.z, c.h], i * 4);
      lifeArr.set([c.start, c.fire.end, c.seed, c.heat], i * 4);
    }
    iPos.clearUpdateRanges(); iLife.clearUpdateRanges();
    iPos.addUpdateRange(0, n * 4); iLife.addUpdateRange(0, n * 4);
    iPos.needsUpdate = iLife.needsUpdate = true;
    geo.instanceCount = n;
    mesh.visible = n > 0;
    dirty = false;
  }

  /**
   * Start a fire. Same signature as fireSystem.addFire, plus `heat`: 1 for an
   * ordinary wreck; napalm passes more. Bigger fires get more, taller cards.
   */
  function addFire(x, y, z, radius = 3, duration = 12, { heat = null } = {}) {
    const now = uTime.value;
    const fire = { x, y, z, radius, end: now + duration, cards: [] };
    // Hotter as it gets bigger, unless told: a burning HQ outshines a rifleman.
    // 0.75 for a rifleman's wreck to ~1 for a burning HQ: orange-yellow, with
    // white only in the core of the hottest. (At 0.85-1.35 every fire went
    // white-hot — the first try.)
    const h0 = heat ?? Math.min(1.0, 0.7 + radius * 0.035);
    // ONE BLAZE, not a scatter: a main card at the centre and one or two
    // smaller tongues overlapping it, close enough that they merge into a
    // single fire. Cards spread over the whole radius (the first try, 2-7 of
    // them) read as a crowd of little separate flames.
    const n = radius < 3 ? 2 : 3;
    for (let k = 0; k < n; k++) {
      seedN = (seedN + 0.6180339887) % 1;
      const a = seedN * Math.PI * 2, r = k === 0 ? 0 : radius * (0.18 + 0.1 * k);
      const card = {
        x: x + Math.cos(a) * r, y, z: z + Math.sin(a) * r,
        // The main blaze tall, the side tongues shorter, each a little varied.
        h: radius * (k === 0 ? 2.1 : 1.35 - 0.15 * k) * (0.9 + ((seedN * 7.13) % 1) * 0.2),
        start: now + k * 0.07, seed: seedN, heat: h0 * (k === 0 ? 1 : 0.85), fire,
      };
      fire.cards.push(card);
      cards.push(card);
    }
    // Oldest cards go first if the pool overflows.
    while (cards.length > MAX_CARDS) cards.shift();
    fires.push(fire);
    dirty = true;
    return fire;
  }

  /** Same call as fireSystem: the sim step and its clock. */
  function update(dt, elapsed) {
    uTime.value = elapsed;
    for (let i = fires.length - 1; i >= 0; i--) {
      const f = fires[i];
      if (elapsed < f.end) continue;
      fires.splice(i, 1);
      for (let j = cards.length - 1; j >= 0; j--) if (cards[j].fire === f) cards.splice(j, 1);
      dirty = true;
    }
    if (dirty) write();
  }

  /** Put every fire out: each burns down over FADE_OUT rather than vanishing. */
  function clear() {
    const now = uTime.value;
    for (const f of fires) f.end = Math.min(f.end, now + FADE_OUT);
    dirty = true;
  }

  function activeCount() { return fires.length; }

  return { addFire, update, clear, activeCount, params: { uIntensity, uBloom, uSoft }, mesh };
}
