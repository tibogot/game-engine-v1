// EXPLOSIONS — a shell landing, a vehicle or a building going up, and the dust
// a man kicks up as he goes down. GAME code, nam-rts only.
//
// Flipbooks of a real simulation, Unity Labs' CC0 "Explosion01" set (5x5
// frames, 1024², straight alpha): the fireball that turns to a boiling dark
// cloud and thins to grey is one image sequence, so the shape of the thing —
// what the old additive orange sprite never had — comes for free.
//
//   BLAST  Explosion01          — fire, then smoke. Shells, wrecks, buildings.
//   DUST   Explosion01-nofire   — the same cloud with no fire, tinted to the
//                                 valley's earth. A soldier's death, a dud.
//
// Unlike the fire effects these are ALPHA-blended, not additive: a dark cloud
// has to darken what is behind it. The fire in the first frames still glows:
// its orange (red well above blue) is written into the emissive MRT buffer, so
// the bloom picks up the flash and leaves the smoke alone.
//
// Each burst is one camera-facing card that plays the book ONCE, rolled and
// mirrored per burst (the sim drifts to one side; a roll hides that every
// blast drifts the same way), lifted toward the camera so it never slices the
// ground. One instanced draw per book; rows are written only when a burst
// starts or ends — size, rise and frame are functions of the clock.
import * as THREE from "three";
import {
  Fn, attribute, cameraPosition, cameraWorldMatrix, cos, float, floor, fract, max, mix,
  normalize, output, positionLocal, saturate, sin, smoothstep, step, texture, uniform, uv,
  varying, vec2, vec3, vec4,
} from "three/tsl";

export const EXPLOSION_ATLAS = {
  blast: "/textures/fx/explosion01_5x5.webp",
  dust: "/textures/fx/explosion01_nofire_5x5.webp",
  cols: 5, rows: 5, size: 1024,
  /** The cloud fills ~70% of its cell by the last frame: card = cloud / 0.7. */
  fill: 0.7,
};

class ExplosionMRTNode extends THREE.MRTNode {
  static get type() { return "ExplosionMRTNode"; }
  setup(builder) {
    const textures = builder.renderer.getRenderTarget()?.textures;
    const anyNamed = !!textures && textures.some((t) => this.outputNodes[t.name] !== undefined);
    if (anyNamed) return super.setup(builder);
    this.members = [vec4(output)];
    return THREE.Node.prototype.setup.call(this, builder);
  }
}

/** One book: one texture, one instanced mesh, a pool of bursts. */
function createBook({ app, url, max: MAX, tint, shade, lift = 0, bloom, name }) {
  const uTime = uniform(0);
  const uShade = uniform(shade);
  const uBloom = uniform(bloom);

  const atlas = new THREE.TextureLoader().load(url);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;

  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute("position", quad.attributes.position);
  geo.setAttribute("uv", quad.attributes.uv);
  //   iPos   x, y, z, size (metres: the card, at the end of the book)
  //   iLife  start, duration, seed, grey (0 = the book's tint, 1 = neutral grey)
  const posArr = new Float32Array(MAX * 4);
  const lifeArr = new Float32Array(MAX * 4);
  const iPos = new THREE.InstancedBufferAttribute(posArr, 4);
  const iLife = new THREE.InstancedBufferAttribute(lifeArr, 4);
  geo.setAttribute("iPos", iPos);
  geo.setAttribute("iLife", iLife);
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  quad.dispose();

  const vAge = varying(float(0), `v_${name}_age`);
  const vMirror = varying(float(0), `v_${name}_mirror`);
  const vGrey = varying(float(0), `v_${name}_grey`);

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.NormalBlending, side: THREE.FrontSide,
  });
  material.name = name;
  material.fog = false;

  material.positionNode = Fn(() => {
    const p = attribute("iPos", "vec4");
    const l = attribute("iLife", "vec4");
    const age = uTime.sub(l.x).div(max(l.y, float(1e-3)));
    const alive = step(float(0), age).mul(step(age, float(1))).mul(step(float(1e-3), l.y));
    const a = saturate(age);
    // The book already grows the cloud; the card only swells a little more as
    // the smoke spreads, and the whole thing climbs.
    const size = p.w.mul(mix(float(0.85), float(1.2), a)).mul(alive);
    const centre = vec3(p.x, p.y.add(p.w.mul(0.28)).add(p.w.mul(0.3).mul(a)), p.z);
    // Toward the camera by 0.4 of its size: no hard line where it meets ground.
    const lifted = centre.add(normalize(cameraPosition.sub(centre)).mul(p.w.mul(0.4)));
    // Rolled a little (±25°, a cloud still rises) and mirrored on half of them
    // — in the UV, not the vertices: a mirrored quad turns its back on the
    // camera and front-face culling dropped every other blast (the first try).
    const rot = l.z.sub(0.5).mul(0.9);
    const cr = cos(rot), sr = sin(rot);
    const lx = positionLocal.x.mul(cr).sub(positionLocal.y.mul(sr));
    const ly = positionLocal.x.mul(sr).add(positionLocal.y.mul(cr));
    vAge.assign(a);
    vMirror.assign(step(float(0.5), fract(l.z.mul(7.31))));
    vGrey.assign(l.w);
    const right = cameraWorldMatrix[0].xyz, up = cameraWorldMatrix[1].xyz;
    return lifted.add(right.mul(lx.mul(size))).add(up.mul(ly.mul(size)));
  })();

  const F = EXPLOSION_ATLAS;
  const frames = F.cols * F.rows;
  const inset = 0.5 / (F.size / F.cols);
  const cellUV = (idx) => {
    const col = idx.mod(F.cols), row = floor(idx.div(F.cols));
    const u0 = mix(uv().x, float(1).sub(uv().x), vMirror);
    const local = vec2(u0, uv().y).clamp(inset, 1 - inset);
    return vec2(col.add(local.x).div(F.cols), float(F.rows - 1).sub(row).add(local.y).div(F.rows));
  };
  const sample = Fn(() => {
    const f = vAge.mul(frames - 1);
    const f0 = floor(f), f1 = f0.add(1).min(frames - 1);
    return mix(texture(atlas, cellUV(f0)), texture(atlas, cellUV(f1)), fract(f));
  })();
  // Out over the last quarter: the book's last frame is still a whole cloud.
  const fade = float(1).sub(smoothstep(float(0.72), float(1), vAge));
  const alpha = sample.a.mul(fade);
  // Fire, not smoke, blooms: orange is red well above blue; grey is neither.
  const fireMask = saturate(sample.r.sub(sample.b).mul(2.5));
  // The book's smoke is baked for a dark backdrop: ~0.2 grey, near black once
  // decoded, so a blast read as a pitch-black mushroom at midday (the first
  // try). The smoke is lifted by uShade; the fire keeps its own colour.
  // `lift` is a floor under the smoke's colour: the no-fire book's first
  // frames are near black, and dust is never darker than the earth it is made of.
  // `grey` swaps the tint for neutral: a gun's smoke is burnt propellant, not earth.
  const hue = mix(vec3(...tint), vec3(1, 1, 1.02), vGrey);
  const smokeCol = sample.rgb.mul(hue).mul(uShade).add(hue.mul(lift));
  const rgb = mix(smokeCol, sample.rgb, fireMask);
  material.colorNode = rgb;
  material.opacityNode = alpha;
  material.mrtNode = new ExplosionMRTNode({ emissive: sample.rgb.mul(fireMask).mul(alpha).mul(uBloom) });

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = 12;   // with the smoke; the additive flames draw after
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.visible = false;
  app.scene.add(mesh);

  const slots = [];   // { start, dur, x, y, z, size, seed }
  let seedN = 0;

  function writeAll() {
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      posArr.set([s.x, s.y, s.z, s.size], i * 4);
      lifeArr.set([s.start, s.dur, s.seed, s.grey], i * 4);
    }
    iPos.clearUpdateRanges(); iLife.clearUpdateRanges();
    iPos.addUpdateRange(0, slots.length * 4); iLife.addUpdateRange(0, slots.length * 4);
    iPos.needsUpdate = iLife.needsUpdate = true;
    geo.instanceCount = slots.length;
    mesh.visible = slots.length > 0;
  }

  return {
    mesh,
    params: { uShade, uBloom },
    spawn(x, y, z, size, duration, delay = 0, grey = 0) {
      if (slots.length >= MAX) slots.shift();   // oldest goes first
      seedN = (seedN + 0.6180339887) % 1;
      slots.push({ start: uTime.value + delay, dur: duration, x, y, z, size, seed: seedN, grey });
      writeAll();
    },
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

/**
 * @param {object} o
 *   app    the engine handle (scene)
 */
export function createExplosionField({ app } = {}) {
  const blast = createBook({
    app, url: EXPLOSION_ATLAS.blast, max: 32, name: "NamBlast",
    tint: [1, 1, 1], shade: 2.6, bloom: 0.6,
  });
  // Earth, not soot: the valley's dust is a warm tan, and a soldier going down
  // should raise a puff of it, not a black mushroom.
  const dust = createBook({
    app, url: EXPLOSION_ATLAS.dust, max: 96, name: "NamDust",
    tint: [1.25, 1.08, 0.86], shade: 2.2, lift: 0.16, bloom: 0,
  });

  return {
    blast, dust,
    /** A fire-and-smoke blast; `size` is the cloud's width in metres. */
    explode(x, y, z, { size = 10, duration = 2.6, delay = 0 } = {}) {
      blast.spawn(x, y, z, size / EXPLOSION_ATLAS.fill, duration, delay);
    },
    /** A puff of dust, no fire. */
    puff(x, y, z, { size = 3, duration = 1.4, delay = 0, grey = 0 } = {}) {
      dust.spawn(x, y, z, size / EXPLOSION_ATLAS.fill, duration, delay, grey);
    },
    /** PER FRAME — the render clock. */
    render(elapsed) { blast.render(elapsed); dust.render(elapsed); },
    activeCount: () => blast.activeCount() + dust.activeCount(),
    clear() { blast.clear(); dust.clear(); },
  };
}
