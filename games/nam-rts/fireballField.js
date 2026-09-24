// FIREBALLS — the rolling ball of flame at the moment napalm lands (and, later,
// the fire half of a big explosion). GAME code, nam-rts only.
//
// A flipbook, not a noise field: Unity Labs' CC0 "FireBall01" (8x8 frames,
// 1024², a real fire simulation baked to an image sequence). A fireball is
// the one fire effect whose SHAPE matters — the ball turning itself inside out
// as it climbs — and no amount of noise on a blob makes that shape; a
// simulation does, so the frames come from one.
//
// Each fireball is one camera-facing card that plays the book ONCE over its
// life, grows as it rolls out and climbs a little. Additive, and written into
// the emissive MRT buffer like fireSystem's flames, so it blooms. The card is
// lifted toward the camera by half its size so it never slices the ground with
// a hard line (the same trick as the banyan's billboards).
//
// One instanced draw for every fireball on the map. Per-frame CPU: rewriting
// the rows of the ones alive (a handful), nothing else — the frame, size and
// fades are functions of the clock in the vertex stage.
import * as THREE from "three";
import {
  Fn, attribute, cameraPosition, cameraWorldMatrix, cos, float, floor, fract, max, mix,
  normalize, output, positionLocal, saturate, sin, smoothstep, step, texture, uniform, uv,
  varying, vec2, vec3, vec4,
} from "three/tsl";

export const FIREBALL_ATLAS = {
  url: "/textures/fx/fireball01_8x8.png",
  cols: 8, rows: 8, size: 1024,
};

const MAX_FIREBALLS = 48;

/** Same MRT fallback as fireSystem / bloom.js — a plain RT has no `emissive`. */
class FireballMRTNode extends THREE.MRTNode {
  static get type() { return "FireballMRTNode"; }
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
 *   intensity  multiplier on the atlas colour
 *   bloom      share of it written to the emissive (bloom) buffer
 */
export function createFireballField({ app, intensity = 1.0, bloom = 0.45 } = {}) {
  const uTime = uniform(0);
  const uIntensity = uniform(intensity);
  // Only part of the colour goes to the bloom. At 3.2x with the whole colour
  // blooming, every fireball blew out to a white disc and the flipbook's
  // shape — the whole point of it — was gone.
  const uBloom = uniform(bloom);

  const atlas = new THREE.TextureLoader().load(FIREBALL_ATLAS.url);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;

  // ── Geometry: one quad per fireball, placed in the vertex stage ───────────
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute("position", quad.attributes.position);
  geo.setAttribute("uv", quad.attributes.uv);
  //   iPos  x, y, z, size (metres, at the end of the roll)
  //   iLife startTime, duration, seed, 0 (duration 0 = free slot)
  const posArr = new Float32Array(MAX_FIREBALLS * 4);
  const lifeArr = new Float32Array(MAX_FIREBALLS * 4);
  const iPos = new THREE.InstancedBufferAttribute(posArr, 4);
  const iLife = new THREE.InstancedBufferAttribute(lifeArr, 4);
  iPos.setUsage(THREE.DynamicDrawUsage);
  iLife.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("iPos", iPos);
  geo.setAttribute("iLife", iLife);
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  quad.dispose();

  const vAge = varying(float(0), "v_fb_age");
  const vSeed = varying(float(0), "v_fb_seed");

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, side: THREE.FrontSide, toneMapped: true,
  });
  material.name = "NamFireball";
  material.fog = false;

  material.positionNode = Fn(() => {
    const p = attribute("iPos", "vec4");
    const l = attribute("iLife", "vec4");
    const age = uTime.sub(l.x).div(max(l.y, float(1e-3)));
    const alive = step(float(0), age).mul(step(age, float(1))).mul(step(float(1e-3), l.y));
    // Rolls OUT fast then slows (ease-out), and climbs about a third of its
    // size over its life: a fireball rises off the ground as it burns out.
    const grow = mix(float(0.45), float(1), float(1).sub(float(1).sub(saturate(age)).pow(2.2)));
    const size = p.w.mul(grow).mul(alive);
    const centre = vec3(p.x, p.y.add(p.w.mul(0.32)).add(p.w.mul(0.35).mul(saturate(age))), p.z);
    // Toward the camera by half its size: no hard line where it meets ground.
    const toCam = normalize(cameraPosition.sub(centre));
    const lifted = centre.add(toCam.mul(size.mul(0.5)));
    // A per-fireball roll, so two never share an orientation.
    const rot = l.z.mul(6.2831);
    const cr = cos(rot), sr = sin(rot);
    const right = cameraWorldMatrix[0].xyz, up = cameraWorldMatrix[1].xyz;
    const lx = positionLocal.x.mul(cr).sub(positionLocal.y.mul(sr));
    const ly = positionLocal.x.mul(sr).add(positionLocal.y.mul(cr));
    vAge.assign(saturate(age));
    vSeed.assign(l.z);
    return lifted.add(right.mul(lx.mul(size))).add(up.mul(ly.mul(size)));
  })();

  // The frame: the whole book once over the life, crossfaded between cells.
  const F = FIREBALL_ATLAS;
  const frames = F.cols * F.rows;
  const inset = 0.5 / (F.size / F.cols);
  const cellUV = (idx) => {
    const col = idx.mod(F.cols), row = floor(idx.div(F.cols));
    const local = uv().clamp(inset, 1 - inset);
    return vec2(col.add(local.x).div(F.cols), float(F.rows - 1).sub(row).add(local.y).div(F.rows));
  };
  const colour = Fn(() => {
    const f = vAge.mul(frames - 1);
    const f0 = floor(f), f1 = f0.add(1).min(frames - 1);
    const c = mix(texture(atlas, cellUV(f0)).rgb, texture(atlas, cellUV(f1)).rgb, fract(f));
    // In over the first few percent, out over the last third.
    const fade = smoothstep(float(0), float(0.04), vAge).mul(float(1).sub(smoothstep(float(0.62), float(1), vAge)));
    return c.mul(uIntensity).mul(fade);
  })();
  material.colorNode = colour;
  material.mrtNode = new FireballMRTNode({ emissive: colour.mul(uBloom) });

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = "NamFireballs";
  mesh.frustumCulled = false;
  mesh.renderOrder = 13;   // after the smoke (12): fire glows through its own pall
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.visible = false;
  app.scene.add(mesh);

  // ── Slots ──────────────────────────────────────────────────────────────────
  const slots = [];          // { start, dur, x, y, z, size, seed }
  let seedN = 0;

  function writeAll() {
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      posArr.set([s.x, s.y, s.z, s.size], i * 4);
      lifeArr.set([s.start, s.dur, s.seed, 0], i * 4);
    }
    iPos.clearUpdateRanges(); iLife.clearUpdateRanges();
    iPos.addUpdateRange(0, slots.length * 4); iLife.addUpdateRange(0, slots.length * 4);
    iPos.needsUpdate = iLife.needsUpdate = true;
    geo.instanceCount = slots.length;
    mesh.visible = slots.length > 0;
  }

  return {
    mesh,
    params: { uIntensity, uBloom },

    /**
     * A fireball at (x, y, z), `size` metres across at the end of its roll,
     * starting `delay` seconds from now and lasting `duration`.
     */
    spawn(x, y, z, { size = 18, duration = 1.7, delay = 0 } = {}) {
      if (slots.length >= MAX_FIREBALLS) slots.shift();   // oldest goes first
      seedN = (seedN + 0.6180339887) % 1;
      slots.push({ start: uTime.value + delay, dur: duration, x, y, z, size, seed: seedN });
      writeAll();
    },

    /** PER FRAME — the render clock, and retiring the finished ones. */
    render(elapsed) {
      uTime.value = elapsed;
      let changed = false;
      for (let i = slots.length - 1; i >= 0; i--) {
        if (elapsed > slots[i].start + slots[i].dur) { slots.splice(i, 1); changed = true; }
      }
      if (changed) writeAll();
    },

    activeCount: () => slots.length,
    clear() { slots.length = 0; writeAll(); },
    dispose() { app.scene.remove(mesh); geo.dispose(); material.dispose(); atlas.dispose(); },
  };
}
