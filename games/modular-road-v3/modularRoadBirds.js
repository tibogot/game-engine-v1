// ── BIRDS ────────────────────────────────────────────────────────────────────
//
// Flocks wheeling over the city. One draw call, no compute, no simulation.
//
// ── WHY NOT THE OFFICIAL BOIDS EXAMPLE ───────────────────────────────────────
//
// three.js ships `webgpu_compute_birds`, and it is a proper GPGPU boids sim:
//
//     const BIRDS = 8192;
//     Loop( { start: uint(0), end: uint(BIRDS), ... } )    // inside computeVelocity
//
// Every bird reads every other bird. That is 8192² = 67 MILLION neighbour
// interactions per frame, each with a distance test and steering math, plus two
// compute pipelines and four ping-ponged storage textures.
//
// It is also invisible. Flocking is a behaviour you read at ten metres; birds
// in a driving game are read at two hundred, where what registers is the
// silhouette, the wing beat, and whether the group moves together. None of
// those need a bird to know that any other bird exists.
//
// So this is CLOSED FORM. Each bird's position is a function of the clock and
// its own seed — a flock centre wandering on slow sines, the bird orbiting it
// with its own phase and radius. Evaluated twice per vertex (once at t, once a
// moment later) to get a heading, which also gives the bank into the turn for
// free. No compute passes, no storage buffers, and ONE pipeline rather than
// three — which matters more here than the arithmetic does, because the first
// frame of this game is already spent compiling shaders.
//
// ── THE SUB-PIXEL TRAP ───────────────────────────────────────────────────────
//
// A three-triangle bird two hundred metres away is smaller than a pixel, and a
// sub-pixel triangle does not fade out politely — it crawls, sparkles, and
// drops in and out of existence between frames. The starfield in this same game
// was invisible for exactly this reason. So a bird has a MINIMUM SCREEN SIZE:
// below it, the bird is scaled up in world space to hold a constant pixel size,
// which is a lie about its distance that nobody has ever been able to see.

import * as THREE from "three";
import {
  Fn, attribute, uniform, float, vec3, sin, cos, cross, normalize, max,
  clamp, length, cameraPosition, mix, positionLocal,
} from "three/tsl";

export const BIRD_DEFAULTS = {
  /** Off and nothing is built. */
  birds: true,
  /** Total birds. Divided evenly between `flocks`. */
  count: 420,
  flocks: 7,

  /** Where the flocks are scattered, metres from `center`. */
  spreadMin: 220,
  spreadMax: 900,
  /** Flock altitude band, metres above the ground. Above the mid-rise roofs
   *  and below the tower crowns, which is where gulls actually are. */
  heightMin: 55,
  heightMax: 150,

  /** How far a flock wanders from its anchor, and how slowly. */
  wander: 90,
  wanderSpeed: 0.035,

  /** A bird's own orbit around its flock centre. */
  orbitMin: 14,
  orbitMax: 46,
  /** Radians per second. Signed per flock, so some wheel the other way. */
  orbitSpeed: 0.22,
  /** Vertical wallow within the orbit. */
  bob: 6.5,

  /** Wing span, metres, before the pixel floor. */
  size: 1.5,
  sizeSpread: 0.45,
  /** Wing beats per second, and how far the tips travel. */
  flapRate: 3.2,
  flapAmp: 0.55,
  /** How hard they bank into the turn, radians at full orbit speed. */
  bank: 0.85,

  /** The pixel floor described in the header. */
  minPixels: 2.4,

  color: 0x2a2b2f,
  /** A bird lit from the side is paler on one flank; this is that, faked, and
   *  it is the difference between a bird and a moving hole in the sky. */
  colorLit: 0x6b6a66,
  /** Birds go to roost. 1 = gone at full night. */
  nightFade: 0.9,
};

/**
 * THE BIRD: body, two wings, three triangles — the same shape the three.js
 * example uses, because it is the right one. Local +Z is forward.
 *
 * `aFlap` tags the two WING TIPS and nothing else, so the flap in the vertex
 * stage moves the tips and leaves the roots attached to the body. Tagging by
 * vertex index instead (as the example does) would break the moment anybody
 * merged or reordered this geometry.
 */
function birdGeometry() {
  const V = [
    // body: a thin upright fin, tail to head
    0, 0, -0.55, 0, 0.13, -0.55, 0, 0, 0.95,
    // left wing: root fore, TIP, root aft
    0, 0, -0.42, -0.62, 0, 0.10, 0, 0, 0.42,
    // right wing
    0, 0, 0.42, 0.62, 0, 0.10, 0, 0, -0.42,
  ];
  const flap = [0, 0, 0, 0, 1, 0, 0, 1, 0];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(V, 3));
  g.setAttribute("aFlap", new THREE.Float32BufferAttribute(flap, 1));
  return g;
}

/**
 * Build the flocks.
 *
 * @param {object} [opts]
 * @param {object} [opts.params]   overrides on BIRD_DEFAULTS
 * @param {{x:number,z:number}} [opts.center]
 * @param {number} [opts.groundY]
 * @param {object} [opts.uNight]   the world's night uniform, 0 day … 1 night
 * @param {() => number} [opts.rand]  deterministic source
 */
export function createBirdFlock({
  params = {}, center = { x: 0, z: 0 }, groundY = 0, uNight = null, rand = Math.random,
} = {}) {
  const B = { ...BIRD_DEFAULTS, ...params };
  if (!B.birds || B.count <= 0) return null;

  const n = B.count;
  const flocks = Math.max(1, B.flocks);
  const aFlock = new Float32Array(n * 4);      // flock centre xyz, wander phase
  const aBird = new Float32Array(n * 4);       // orbit phase, radius, speed, size

  // Flock anchors first, so every bird in one shares a centre exactly. A
  // per-bird anchor with the same distribution would look like a cloud of
  // singles, which is the one thing a flock must not look like.
  const anchors = [];
  for (let f = 0; f < flocks; f++) {
    const a = rand() * Math.PI * 2;
    const r = B.spreadMin + rand() * (B.spreadMax - B.spreadMin);
    anchors.push({
      x: center.x + Math.cos(a) * r,
      y: groundY + B.heightMin + rand() * (B.heightMax - B.heightMin),
      z: center.z + Math.sin(a) * r,
      phase: rand() * 100,
      // Signed, so some flocks wheel clockwise and some the other way. All one
      // way reads as a mechanism.
      spin: (rand() < 0.5 ? -1 : 1) * (0.7 + rand() * 0.6),
    });
  }

  for (let i = 0; i < n; i++) {
    const a = anchors[i % flocks];
    aFlock[i * 4] = a.x; aFlock[i * 4 + 1] = a.y; aFlock[i * 4 + 2] = a.z;
    aFlock[i * 4 + 3] = a.phase;
    aBird[i * 4] = rand() * Math.PI * 2;
    aBird[i * 4 + 1] = B.orbitMin + rand() * (B.orbitMax - B.orbitMin);
    aBird[i * 4 + 2] = a.spin * B.orbitSpeed * (0.8 + rand() * 0.4);
    aBird[i * 4 + 3] = B.size * (1 - B.sizeSpread + rand() * B.sizeSpread * 2);
  }

  const base = birdGeometry();
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", base.attributes.position);
  geo.setAttribute("aFlap", base.attributes.aFlap);
  geo.setAttribute("aFlock", new THREE.InstancedBufferAttribute(aFlock, 4));
  geo.setAttribute("aBird", new THREE.InstancedBufferAttribute(aBird, 4));
  geo.instanceCount = n;
  // Everything moves in the vertex stage, so the CPU has no idea where any of
  // this is. A bounding sphere big enough to hold every flock, and no culling.
  geo.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(center.x, groundY + B.heightMax, center.z), B.spreadMax * 2,
  );

  const uTime = uniform(0);
  /** Whose uniform this is decides whether `setNight` may touch it: handed one
   *  from outside, the world owns the clock and writing to it here would fight
   *  whatever else drives it. */
  const ownsNight = !uNight;
  const uNightU = uNight || uniform(0);
  /** screenHeight / (2 tan(fovY/2)) — pixels per world unit at one metre. */
  const uPixelScale = uniform(600);
  const uColor = uniform(new THREE.Color(B.color));
  const uColorLit = uniform(new THREE.Color(B.colorLit));

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.name = "Birds";
  mat.side = THREE.DoubleSide;   // wings are single triangles, seen from both

  /*
   * ── THE FLIGHT PATH, CLOSED FORM ───────────────────────────────────────────
   *
   * `at(t)` is the whole simulation. A flock centre on three slow sines of
   * different periods — deliberately incommensurate, so the path never visibly
   * repeats — and the bird on a circle around it, wallowing vertically at a
   * rate that does not divide the orbit.
   */
  const at = Fn(([t]) => {
    const fl = attribute("aFlock", "vec4");
    const bd = attribute("aBird", "vec4");
    const ph = fl.w;
    const w = float(B.wander), ws = float(B.wanderSpeed);
    const centre = vec3(
      fl.x.add(sin(t.mul(ws).add(ph)).mul(w)),
      fl.y.add(sin(t.mul(ws.mul(0.63)).add(ph.mul(1.7))).mul(w.mul(0.18))),
      fl.z.add(cos(t.mul(ws.mul(0.81)).add(ph.mul(0.6))).mul(w)),
    );
    const th = bd.x.add(t.mul(bd.z));
    return centre.add(vec3(
      cos(th).mul(bd.y),
      sin(th.mul(0.7).add(ph)).mul(B.bob),
      sin(th).mul(bd.y),
    ));
  });

  mat.positionNode = Fn(() => {
    const bd = attribute("aBird", "vec4");
    const p0 = at(uTime).toVar();
    /*
     * HEADING BY FINITE DIFFERENCE, not by differentiating `at`. The closed
     * form is differentiable, but the derivative is four more sines and has to
     * be kept in step with the path by hand forever. Two evaluations is a
     * dozen extra instructions and cannot fall out of sync with anything.
     */
    const p1 = at(uTime.add(0.08)).toVar();
    const fwd = normalize(p1.sub(p0)).toVar();

    // An orthonormal frame around the heading. World up is never parallel to it
    // because a bird on a wheeling orbit is never in a vertical climb.
    const right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd)).toVar();
    const up = cross(fwd, right).toVar();
    /*
     * BANK INTO THE TURN. A bird that stays level through a circle reads as a
     * paper dart on a wire; the roll is most of what says "flying". Signed by
     * the orbit direction, so the flocks that wheel the other way lean the
     * other way too.
     */
    const b = clamp(bd.z.mul(float(B.bank / Math.max(1e-4, B.orbitSpeed))), -1.2, 1.2).toVar();
    const cb = cos(b), sb = sin(b);
    const rightB = right.mul(cb).add(up.mul(sb)).toVar();
    const upB = up.mul(cb).sub(right.mul(sb)).toVar();

    /*
     * SIZE, WITH A FLOOR IN PIXELS. See the header: below about two pixels a
     * three-triangle bird stops being a bird and becomes a sparkle. Growing it
     * in world space to hold a constant screen size is a lie about its distance
     * that is not visible, and the alternative — fading it out — loses the
     * flock exactly where a flock is most of what you see.
     */
    const dist = length(p0.sub(cameraPosition)).toVar();
    const minWorld = float(B.minPixels).mul(dist).div(uPixelScale);
    const night = float(1.0).sub(uNightU.mul(float(B.nightFade)));
    const s = max(bd.w, minWorld).mul(night).toVar();

    const lp = positionLocal.toVar();
    // The flap moves the TIPS only — `aFlap` tags them — so the wing hinges at
    // the body instead of the whole triangle sliding.
    const flap = sin(uTime.mul(float(B.flapRate)).add(bd.x.mul(3.1))).mul(float(B.flapAmp));
    lp.y.addAssign(attribute("aFlap", "float").mul(flap));

    return p0.add(rightB.mul(lp.x.mul(s))).add(upB.mul(lp.y.mul(s))).add(fwd.mul(lp.z.mul(s)));
  })();

  /*
   * COLOUR: unlit, and deliberately. A distant bird against a bright sky IS a
   * silhouette — running it through the lighting model would cost a normal that
   * `positionNode` has already invalidated (the stock normals are still those
   * of the rest pose) to produce very nearly this colour anyway. The one thing
   * worth faking is that the flanks are not equally dark, which is the wing
   * catching the sky as it rolls.
   */
  mat.colorNode = Fn(() => {
    const flankUp = attribute("aFlap", "float").mul(0.5).add(0.1);
    return mix(uColor, uColorLit, flankUp);
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "Birds";
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 1;

  return {
    mesh,
    params: B,
    stats: { birds: n, flocks, draws: 1, tris: n * 3 },
    /** Seconds. Every frame. */
    setTime(t) { uTime.value = t; },
    /** 0 day … 1 night. Ignored when the world handed in its own night uniform. */
    setNight(v) {
      if (ownsNight) uNightU.value = Math.max(0, Math.min(1, v || 0));
    },
    /**
     * The pixel floor needs to know how big a metre is on screen.
     *
     * `pixelsPerMetreAt1m = height / (2 tan(fovY/2))`, so at distance d one
     * metre is that over d. Fed from the real camera and viewport rather than
     * assumed, because both change — a resize or a FOV shift would otherwise
     * silently move the size floor and start the shimmer again.
     */
    setViewport(pixelHeight, fovYDeg) {
      const f = Math.tan((fovYDeg * Math.PI) / 360);
      uPixelScale.value = Math.max(1, pixelHeight / (2 * Math.max(1e-4, f)));
    },
    dispose() {
      geo.dispose();
      base.dispose();
      mat.dispose();
    },
  };
}
