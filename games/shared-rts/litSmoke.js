// LIT SMOKE — dust and smoke puffs lit by the GAME'S SUN (you, 2026-10-02:
// "can we have better than the flipbook?"). Shared, opt-in (combatFx
// `litSmoke`): nam keeps its book.
//
// The old book (explosionField.js, Unity's Explosion01) has its light painted
// in from one side, so every cloud is lit the same whatever the sun does. This
// book is SIX-WAY (tools/bakeSixWaySmoke.mjs): each frame stores the puff lit
// from +X, -X, +Y, -Y, +Z, -Z of the card, and the shader weights them by
// where the sun is relative to the card — dark undersides, a bright top on the
// sun's side, edges that glow against a low sun. The sky lights it too (the
// top and bottom maps, mixed), coloured by the engine's own hemisphere light.
//
// SMOOTH WITH 64 FRAMES: each frame carries where its smoke moves in the next
// one (motion vectors); the two frames either side of the clock are slid
// toward each other before they are mixed, so it flows instead of
// cross-dissolving.
//
// COST: one instanced draw for every puff in the battle (ring buffer of
// `max`); five texture reads a pixel. A puff's row is written once, when it
// starts — growth, drift, fade are functions of the clock in the shader.
// Nothing alive: the mesh is hidden (no draw).
import * as THREE from "three";
import {
  Fn, attribute, cameraPosition, cameraWorldMatrix, cos, dot, float, floor, fract, max, mix,
  normalize, output, positionLocal, saturate, select, sin, smoothstep, step, texture, uniform, uv,
  varying, vec2, vec3, vec4, positionWorld,
} from "three/tsl";
import { drapeY } from "./terrainDrape.js";

export const SMOKE6_ATLAS = {
  a: "/textures/fx/smoke6_a.webp", b: "/textures/fx/smoke6_b.webp", mv: "/textures/fx/smoke6_mv.webp",
  cols: 8, rows: 8, cell: 192, mvScale: 24,
  /** The cloud fills ~80% of its card at its biggest (the bake's radius + lumps). */
  fill: 0.8,
};

/** Dust (this valley's earth) and gun smoke (burnt propellant): linear albedo. */
export const SMOKE_TINTS = { dust: [0.46, 0.36, 0.25], grey: [0.42, 0.42, 0.43], soot: [0.09, 0.085, 0.08] };

// The scene's MRT: write colour only, nothing emissive (as explosionField's).
class SmokeMRTNode extends THREE.MRTNode {
  static get type() { return "SmokeMRTNode"; }
  setup(builder) {
    const textures = builder.renderer.getRenderTarget()?.textures;
    const anyNamed = !!textures && textures.some((t) => this.outputNodes[t.name] !== undefined);
    if (anyNamed) return super.setup(builder);
    this.members = [vec4(output)];
    return THREE.Node.prototype.setup.call(this, builder);
  }
}

export function createLitSmoke({ app, max: MAX = 384, name = "LitSmoke" } = {}) {
  const F = SMOKE6_ATLAS;
  const load = (url, srgb) => {
    const t = new THREE.TextureLoader().load(url);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    return t;
  };
  const texA = load(F.a, true), texB = load(F.b, true), texM = load(F.mv, false);

  const uTime = uniform(0);
  const uSunDir = uniform(new THREE.Vector3(0.3, 0.8, 0.4));
  const uSun = uniform(new THREE.Color(3, 3, 3));
  const uSky = uniform(new THREE.Color(0.6, 0.7, 0.8));
  // Calibration (live: the lab). The six-way maps hold a lit FRACTION; these
  // turn the engine's light into this material's brightness, judged against
  // the sandbags and the ground in the same light.
  const uSunK = uniform(0.4), uSkyK = uniform(0.75);
  // A HOT puff (heat > 0): fire in its core, cooling to smoke — how bright.
  const uFireK = uniform(22);

  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute("position", quad.attributes.position);
  geo.setAttribute("uv", quad.attributes.uv);
  quad.dispose();
  //   iPos   x, y, z, size (m: the card at its biggest)
  //   iLife  start, duration, seed, opacity
  //   iVel   drift vx, vy, vz (m/s), growth (the card's swell over the life)
  //   iTint  linear albedo r, g, b, heat (0: smoke; 1: a fireball that cools to it)
  const attrs = {};
  for (const k of ["iPos", "iLife", "iVel", "iTint"]) {
    attrs[k] = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    attrs[k].setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(k, attrs[k]);
  }
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

  const vAge = varying(float(0), `v_${name}_age`);
  const vMirror = varying(float(0), `v_${name}_mirror`);
  const vL = varying(vec3(0, 1, 0), `v_${name}_light`);
  const vTint = varying(vec4(1, 1, 1, 1), `v_${name}_tint`);
  const vHeat = varying(float(0), `v_${name}_heat`);
  const vSoft = varying(float(1), `v_${name}_soft`);

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending, side: THREE.FrontSide,
  });
  material.name = name;
  material.fog = false;

  material.positionNode = Fn(() => {
    const p = attribute("iPos", "vec4");
    const l = attribute("iLife", "vec4");
    const v = attribute("iVel", "vec4");
    const secs = uTime.sub(l.x);
    const age = secs.div(max(l.y, float(1e-3)));
    const alive = step(float(0), age).mul(step(age, float(1))).mul(step(float(1e-3), l.y));
    const a = saturate(age);
    const size = p.w.mul(mix(float(1), float(1).add(v.w), a)).mul(alive);
    // Drift (wind, the climb of warm air), slowing as the puff loses its push.
    const t = max(secs, float(0));
    const centre = vec3(p.x, p.y, p.z).add(v.xyz.mul(t.mul(float(1).sub(a.mul(0.35)))));
    // Toward the camera by a third of its size: no hard line where it meets ground.
    const lifted = centre.add(normalize(cameraPosition.sub(centre)).mul(p.w.mul(0.33)));
    // Rolled ±25° and mirrored on half (in the UV: a mirrored quad would turn its back).
    const rot = l.z.sub(0.5).mul(0.9);
    const cr = cos(rot), sr = sin(rot);
    const right = cameraWorldMatrix[0].xyz, up = cameraWorldMatrix[1].xyz;
    const ax = right.mul(cr).add(up.mul(sr));                  // the card's +X in the world
    const ay = right.mul(sr.negate()).add(up.mul(cr));          // its +Y
    const az = normalize(cameraPosition.sub(lifted));           // its +Z: toward the viewer
    const mirror = step(float(0.5), fract(l.z.mul(7.31)));
    // The sun in the card's frame (the bake's frame); X flips with the mirror.
    const L = uSunDir;
    vL.assign(normalize(vec3(dot(L, ax).mul(float(1).sub(mirror.mul(2))), dot(L, ay), dot(L, az))));
    vAge.assign(a);
    vMirror.assign(mirror);
    const tint = attribute("iTint", "vec4");
    vTint.assign(vec4(tint.xyz, l.w));
    vHeat.assign(tint.w);
    vSoft.assign(max(p.w.mul(0.18), float(0.4)));
    const lx = positionLocal.x, ly = positionLocal.y;
    return lifted.add(ax.mul(lx.mul(size))).add(ay.mul(ly.mul(size)));
  })();

  const frames = F.cols * F.rows;
  const inset = 0.5 / F.cell;
  const cellUV = (idx, local) => {
    const col = idx.mod(F.cols), row = floor(idx.div(F.cols));
    const q = local.clamp(inset, 1 - inset);
    return vec2(col.add(q.x).div(F.cols), float(F.rows - 1).sub(row).add(q.y).div(F.rows));
  };
  const shade = Fn(() => {
    const f = vAge.mul(frames - 1);
    const f0 = floor(f), f1 = f0.add(1).min(frames - 1), w = fract(f);
    const local = vec2(mix(uv().x, float(1).sub(uv().x), vMirror), uv().y);
    // Motion: where this pixel's smoke goes by the next frame (cell uv).
    const mv = texture(texM, cellUV(f0, local)).xy.sub(0.5).div(F.mvScale);
    const l0 = local.sub(mv.mul(w)), l1 = local.add(mv.mul(float(1).sub(w)));
    const A = mix(texture(texA, cellUV(f0, l0)), texture(texA, cellUV(f1, l1)), w);
    const B = mix(texture(texB, cellUV(f0, l0)).xyz, texture(texB, cellUV(f1, l1)).xyz, w);
    // Six-way: each axis's map on the sun's side of it, weighted by L² (sums to 1).
    const L = vL, L2 = L.mul(L);
    const lit = L2.x.mul(select(L.x.greaterThan(0), A.x, B.x))
      .add(L2.y.mul(select(L.y.greaterThan(0), A.y, B.y)))
      .add(L2.z.mul(select(L.z.greaterThan(0), A.z, B.z)));
    // The sky from above mostly; the ground bounces a little into the underside.
    const sky = A.y.mul(0.7).add(B.y.mul(0.3));
    const smoke = vTint.xyz.mul(vec3(uSun).mul(lit).mul(uSunK).add(vec3(uSky).mul(sky).mul(uSkyK)));
    // FIRE: a hot puff burns in its thick core over the first half of its
    // life — yellow-white, orange, dark red — and is smoke after (the tint
    // is the smoke it leaves: soot). HDR, so it reads as light.
    // Hot where it is THICK and lit through (the maps' own structure): the
    // thin edges cool first to dark red, the core stays yellow — not a flat
    // orange cut-out (the first try, 2026-10-02).
    const h0 = vHeat.mul(float(1).sub(smoothstep(float(0), float(0.5), vAge)));
    const h = h0.mul(smoothstep(float(0.1), float(0.85), A.w)).mul(A.z.mul(0.7).add(B.z.mul(0.5)).add(0.15)).clamp(0, 1);
    const fireCol = mix(vec3(0.5, 0.04, 0.01), mix(vec3(1, 0.34, 0.05), vec3(1, 0.8, 0.45), smoothstep(float(0.55), float(0.95), h)), smoothstep(float(0.1), float(0.5), h));
    const rgb = smoke.add(fireCol.mul(h.mul(h)).mul(uFireK));
    // In over the first frames (the book's first frame is already a cloud), out at the end.
    const fade = smoothstep(float(0), float(0.04), vAge).mul(float(1).sub(smoothstep(float(0.85), float(1), vAge)));
    // Nothing at the card's own border: the mips and the motion slide pull in
    // a sliver of the next frame there, which drew each card's outline as a
    // pale line through a cloud of them (seen 2026-10-02).
    const e = uv().min(float(1).sub(uv()));
    const border = smoothstep(float(0), float(0.12), e.x).mul(smoothstep(float(0), float(0.12), e.y));
    // Into the ground softly (one heightmap tap, as the flames): a card that
    // cuts the terrain drew a hard straight line there.
    const ground = app.heightTexNode ? saturate(positionWorld.y.sub(drapeY(app.heightTexNode, positionWorld.x, positionWorld.z)).div(vSoft)) : float(1);
    return vec4(rgb, A.w.mul(fade).mul(vTint.w).mul(border).mul(ground));
  })();
  material.colorNode = shade.xyz;
  material.opacityNode = shade.w;
  material.mrtNode = new SmokeMRTNode({ emissive: vec4(0, 0, 0, 0) });

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  // AFTER every ground layer (fields 40, tyre marks 41, craters + blood pools 42, cover overlay 44): smoke at 12 drew under them and a ploughed field showed THROUGH a dust cloud (you, 2026-10-02).
  mesh.renderOrder = 50;   // with the other smoke (explosionField)
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.visible = false;
  app.scene.add(mesh);

  let cursor = 0, used = 0, seedN = 0, liveUntil = -1;
  let fresh = true;   // the first puff since the last upload clears the update ranges
  const _c = new THREE.Color();

  return {
    mesh,
    params: { uSunK, uSkyK, uFireK },
    /**
     * A puff at (x, y, z). `size`: the cloud's width at its biggest (m);
     * `duration` s; `delay` s; `tint` linear albedo (SMOKE_TINTS); `opacity`;
     * `vel` [vx, vy, vz] drift m/s; `grow` how much the card swells beyond
     * the book's own growth; `heat` 0..1 a fireball (cools to `tint`).
     */
    puff(x, y, z, { size = 3, duration = 1.6, delay = 0, tint = SMOKE_TINTS.dust, opacity = 1, vel = null, grow = 0.25, heat = 0 } = {}) {
      const i = cursor;
      cursor = (cursor + 1) % MAX;
      used = Math.max(used, cursor === 0 ? MAX : cursor);
      seedN = (seedN + 0.6180339887) % 1;
      const start = uTime.value + delay, card = size / F.fill;
      attrs.iPos.array.set([x, y, z, card], i * 4);
      attrs.iLife.array.set([start, duration, seedN, opacity], i * 4);
      attrs.iVel.array.set([vel?.[0] ?? 0, vel?.[1] ?? size * 0.12, vel?.[2] ?? 0, grow], i * 4);
      attrs.iTint.array.set([tint[0], tint[1], tint[2], heat], i * 4);
      if (fresh) { for (const k in attrs) attrs[k].clearUpdateRanges(); fresh = false; }
      for (const k in attrs) { attrs[k].addUpdateRange(i * 4, 4); attrs[k].needsUpdate = true; }
      geo.instanceCount = used;
      liveUntil = Math.max(liveUntil, start + duration);
      mesh.visible = true;
    },
    /** PER FRAME: the clock, and the light from the engine's sun and sky. */
    render(elapsed) {
      uTime.value = elapsed;
      fresh = true;
      if (elapsed > liveUntil && mesh.visible) mesh.visible = false;
      if (!mesh.visible) return;
      const L = app.light;
      const dir = L?.getDirection?.();
      if (dir) uSunDir.value.copy(dir).normalize();
      const sun = L?.sun, hemi = L?.hemi;
      if (sun) uSun.value.copy(_c.copy(sun.color).multiplyScalar(sun.intensity));
      // No hemisphere light (Sky Pro lights its ambient from the sky itself):
      // a pale sky-blue a tenth of the sun, which is what a desert sky gives.
      if (hemi && hemi.intensity > 0.01) uSky.value.copy(_c.copy(hemi.color).multiplyScalar(hemi.intensity));
      else if (sun) uSky.value.setRGB(0.55, 0.62, 0.75).multiplyScalar(sun.intensity * 0.1);
    },
    activeCount: () => (mesh.visible ? used : 0),
    clear() { liveUntil = -1; mesh.visible = false; },
    dispose() { app.scene.remove(mesh); geo.dispose(); material.dispose(); texA.dispose(); texB.dispose(); texM.dispose(); },
  };
}
