// TRACERS — every bullet and tank shell in flight, as a streak of light.
// GAME code, nam-rts only.
//
// Company of Heroes reads a firefight through its tracers: long bright
// streaks that are visibly SLOWER than a real bullet (a 900 m/s round would
// cross the screen in a frame and never be seen), with a white-hot core and a
// coloured edge. The colour is the side's: the US loaded red tracer, the
// Soviet-supplied Front green — which is also the fastest read of who is
// shooting whom on a busy screen.
//
// A tracer is a straight flight from A to B between two times, so the GPU
// places it: the head is mix(A, B, s) on the clock, the tail a fixed length
// behind, and the quad is widened across the flight toward the camera. The CPU
// writes ONE row when a round is fired and never touches it again — the ring
// overwrites the oldest slot. One draw for every round on the map.
import * as THREE from "three";
import {
  Fn, attribute, cameraPosition, cross, float, length, max, min, mix, normalize, output,
  positionLocal, saturate, smoothstep, step, uniform, uv, vec3, vec4,
} from "three/tsl";

const MAX_TRACERS = 512;

/** Tracer colours, linear. The core is white-hot whatever the colour. */
export const TRACER_COLOURS = {
  red: [1.0, 0.16, 0.05],
  green: [0.25, 1.0, 0.2],
  shell: [1.0, 0.55, 0.15],
};

class TracerMRTNode extends THREE.MRTNode {
  static get type() { return "TracerMRTNode"; }
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
 *   intensity  brightness of the streaks
 *   bloom      share of it written to the emissive (bloom) buffer
 */
export function createTracerField({ app, intensity = 2.2, bloom = 0.7 } = {}) {
  const uTime = uniform(0);
  const uIntensity = uniform(intensity);
  const uBloom = uniform(bloom);

  const quad = new THREE.PlaneGeometry(1, 1);   // x across, y along (-0.5 tail .. 0.5 head)
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute("position", quad.attributes.position);
  geo.setAttribute("uv", quad.attributes.uv);
  //   iA  x0, y0, z0, t0      iB  x1, y1, z1, t1
  //   iC  width, length, r, g (blue is derived, below)
  const A = new Float32Array(MAX_TRACERS * 4);
  const B = new Float32Array(MAX_TRACERS * 4);
  const C = new Float32Array(MAX_TRACERS * 4);
  const iA = new THREE.InstancedBufferAttribute(A, 4);
  const iB = new THREE.InstancedBufferAttribute(B, 4);
  const iC = new THREE.InstancedBufferAttribute(C, 4);
  geo.setAttribute("iA", iA);
  geo.setAttribute("iB", iB);
  geo.setAttribute("iC", iC);
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  quad.dispose();

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, side: THREE.FrontSide, toneMapped: true,
  });
  material.name = "NamTracer";
  material.fog = false;

  material.positionNode = Fn(() => {
    const a = attribute("iA", "vec4");
    const b = attribute("iB", "vec4");
    const c = attribute("iC", "vec4");
    const flight = b.xyz.sub(a.xyz);
    const dist = max(length(flight), float(1e-3));
    const dir = flight.div(dist);
    const s = uTime.sub(a.w).div(max(b.w.sub(a.w), float(1e-4)));
    const alive = step(float(0), s).mul(step(s, float(1)));
    // Head on the clock; the tail a streak-length behind, never behind the
    // muzzle — so a round leaving the barrel grows out of it.
    const headD = saturate(s).mul(dist);
    const tailD = max(headD.sub(c.y), float(0));
    const along = mix(tailD, headD, positionLocal.y.add(0.5));
    const p = a.xyz.add(dir.mul(along));
    // Widened across the flight, facing the camera. side x dir points AT the
    // camera, so the quad's front face always does: FrontSide, one pass (a
    // DoubleSide transparent mesh is drawn twice by the WebGPU renderer).
    const side = normalize(cross(dir, cameraPosition.sub(p)).add(vec3(0, 1e-5, 0)));
    return p.add(side.mul(positionLocal.x.mul(c.x).mul(alive)));
  })();

  // The colour rides in iC.zw; blue is derived — every tracer colour here is
  // warm or green, so blue = min(r, g) * 0.25 is enough and keeps the
  // instance at three attributes.
  const tracerColour = Fn(() => {
    const c = attribute("iC", "vec4");
    const across = uv().x.sub(0.5).abs().mul(2);            // 0 centre .. 1 edge
    const alongT = uv().y;                                   // 0 tail .. 1 head
    const core = float(1).sub(smoothstep(float(0.0), float(0.45), across));
    const glow = float(1).sub(smoothstep(float(0.2), float(1.0), across));
    const hue = vec3(c.z, c.w, min(c.z, c.w).mul(0.25));
    // White-hot core, coloured glow; brightest at the head, fading to the tail.
    const col = mix(hue.mul(glow), vec3(1, 0.95, 0.85), core.mul(0.8));
    const fade = smoothstep(float(0.0), float(0.7), alongT);
    return col.mul(fade).mul(uIntensity);
  })();
  material.colorNode = tracerColour;
  material.mrtNode = new TracerMRTNode({ emissive: tracerColour.mul(uBloom) });

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = "NamTracers";
  mesh.frustumCulled = false;
  mesh.renderOrder = 14;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.visible = false;
  app.scene.add(mesh);

  let next = 0, used = 0, lastEnd = -1;
  // Rows written since the last upload, as one span: a burst of MG rounds is
  // one buffer write per attribute per frame, not one per round.
  let dirtyLo = Infinity, dirtyHi = -1, wrapped = false;

  return {
    mesh,
    params: { uIntensity, uBloom },

    /**
     * A round from (x0,y0,z0) to (x1,y1,z1), leaving at `t0` and arriving at
     * `t1` (the field's clock). `colour` is [r, g] of TRACER_COLOURS.
     */
    fire(x0, y0, z0, x1, y1, z1, t0, t1, { width = 0.4, length = 6, colour = TRACER_COLOURS.red } = {}) {
      const i = next;
      next = (next + 1) % MAX_TRACERS;
      used = Math.max(used, i + 1);
      A.set([x0, y0, z0, t0], i * 4);
      B.set([x1, y1, z1, t1], i * 4);
      C.set([width, length, colour[0], colour[1]], i * 4);
      if (i === 0 && dirtyHi >= 0) wrapped = true;
      dirtyLo = Math.min(dirtyLo, i); dirtyHi = Math.max(dirtyHi, i);
      geo.instanceCount = used;
      lastEnd = Math.max(lastEnd, t1);
      mesh.visible = true;
    },

    /** The clock, per frame; drops the draw once the last round has landed. */
    render(time) {
      uTime.value = time;
      if (dirtyHi >= 0) {
        const lo = wrapped ? 0 : dirtyLo, hi = wrapped ? used - 1 : dirtyHi;
        for (const at of [iA, iB, iC]) {
          at.clearUpdateRanges();
          at.addUpdateRange(lo * 4, (hi - lo + 1) * 4);
          at.needsUpdate = true;
        }
        dirtyLo = Infinity; dirtyHi = -1; wrapped = false;
      }
      if (mesh.visible && time > lastEnd) mesh.visible = false;
    },

    clear() { lastEnd = -1; mesh.visible = false; },
  };
}
