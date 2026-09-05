// ============================================================================
// THE BOLT — the channel itself, for the strikes you actually see.
//
// ── WHY IT IS A RIBBON AND NOT A LIGHT, A SPRITE, OR A POST EFFECT ──────────
//
// Not a light: adding one rebuilds every material in the world (see the note in
// modularRoadLightning.js). Not a sprite: a bolt is not billboard-shaped, it is
// a long thin branching path and a quad cannot be one. Not a screen-space
// shader: that pays fill over the whole sky on every frame of the game to draw
// something that is on screen for a fifth of a second, a few times a minute.
//
// So it is ONE mesh, generated on the CPU when a strike happens, drawn as
// camera-facing ribbons, and `visible = false` the rest of the time. Toggling a
// MESH's visibility is free — it is only lights whose visibility is hashed into
// every shader's cache key.
//
// ── COST ────────────────────────────────────────────────────────────────────
//
// One draw, at most `maxSegments * 2` triangles, and only while a bolt is
// alive. The buffers are allocated ONCE at their maximum and refilled in place
// on each strike, so a strike allocates nothing and triggers no reallocation —
// only `needsUpdate` on three attributes and a draw-range change. Idle cost is
// one `visible` check.
//
// ── WHY MIDPOINT DISPLACEMENT ───────────────────────────────────────────────
//
// A real channel is jagged at every scale: it is the same shape zoomed in. That
// is a fractal, and the cheapest fractal that produces it is the one this uses —
// take a segment, push its midpoint sideways by an amount proportional to its
// own length, recurse. Straight lines with random kinks do not look like this;
// they look like a crack, because the kinks are all the same size.
//
// Branches fall out of the same recursion for free: at a midpoint, sometimes
// start a second path heading off at an angle with a shorter budget. Real bolts
// branch DOWNWARD and the forks never rejoin, which is why a branch here only
// ever spawns from a midpoint and never terminates on the main channel.
// ============================================================================

import * as THREE from "three";
import {
  Fn, attribute, uniform, vec3, vec4, float,
  normalize, cross, mix, cameraPosition, cameraProjectionMatrix, cameraViewMatrix,
} from "three/tsl";

export const BOLT_DEFAULTS = {
  /** Subdivisions of the main channel. 6 gives 64 segments, which is more than
   *  enough detail at the distances a bolt is ever seen from. */
  generations: 6,
  /** Sideways push at the FIRST subdivision, as a fraction of the channel's
   *  length. Each generation halves it, which is what makes the jaggedness
   *  look the same at every scale instead of turning to noise. */
  jitter: 0.16,
  /** Chance that a midpoint also throws a branch, per subdivision. */
  branchChance: 0.28,
  /** Branches get this fraction of the remaining generations, so a fork off a
   *  late midpoint is a short spur rather than a second bolt. */
  branchGenerations: 3,
  /** How far a branch travels, as a fraction of its parent segment. */
  branchLength: 0.7,
  /** Core half-width at the top of the channel, metres. Tapers to a point. */
  width: 9,
  /** Branch width as a fraction of the trunk's at that height. */
  branchWidth: 0.5,
  /** Hard ceiling on geometry. Buffers are sized for this once, at boot. */
  maxSegments: 320,
  color: 0xdCE8FF,
  /** Multiplies the emissive. High: this is the brightest thing in the frame
   *  and it is what the selective bloom pass keys off. */
  brightness: 14,
};

/**
 * Build a branching channel between two points.
 *
 * Pure, and exported for the test: given a seeded rng this returns the same
 * path every time, so the branch count and the jaggedness can be asserted
 * without a GPU.
 *
 * @returns {Array<{a: THREE.Vector3, b: THREE.Vector3, w0: number, w1: number}>}
 */
export function makeBoltPath(from, to, opts = {}, rng = Math.random) {
  const p = { ...BOLT_DEFAULTS, ...opts };
  const out = [];
  const _up = new THREE.Vector3();
  const _side = new THREE.Vector3();

  /**
   * One channel, subdivided in place.
   *
   * `wA`/`wB` are the half-widths at each end, carried down so a branch is
   * born at whatever the trunk's width was where it left, and tapers from
   * there — a fork that starts as thick as the trunk reads as two bolts.
   */
  function subdivide(a, b, gen, amp, wA, wB, canBranch) {
    if (out.length >= p.maxSegments) return;
    if (gen <= 0) {
      out.push({ a: a.clone(), b: b.clone(), w0: wA, w1: wB });
      return;
    }
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-4) return;
    dir.divideScalar(len);

    // A perpendicular that does not collapse when the channel runs vertically —
    // which is the common case, so picking world-up as the reference would fail
    // for almost every bolt rather than almost none.
    _up.set(0, 1, 0);
    if (Math.abs(dir.dot(_up)) > 0.95) _up.set(1, 0, 0);
    _side.copy(dir).cross(_up).normalize();
    const _side2 = _side.clone().cross(dir).normalize();

    const push = len * amp;
    mid.addScaledVector(_side, (rng() - 0.5) * 2 * push);
    mid.addScaledVector(_side2, (rng() - 0.5) * 2 * push);

    const wMid = (wA + wB) * 0.5;
    subdivide(a, mid, gen - 1, amp * 0.5, wA, wMid, canBranch);
    subdivide(mid, b, gen - 1, amp * 0.5, wMid, wB, canBranch);

    // The fork. Downward-biased and shorter than the segment it left, so it
    // reads as a spur off the trunk rather than a second strike.
    if (canBranch && rng() < p.branchChance && out.length < p.maxSegments - 8) {
      const bDir = dir.clone();
      bDir.x += (rng() - 0.5) * 1.4;
      bDir.z += (rng() - 0.5) * 1.4;
      bDir.y -= rng() * 0.5;
      bDir.normalize();
      const end = mid.clone().addScaledVector(bDir, len * p.branchLength);
      const bw = wMid * p.branchWidth;
      // `canBranch` false: branches do not branch again. Two levels of forking
      // costs geometry fast and reads as a bush, not a bolt.
      subdivide(mid, end, Math.min(gen - 1, p.branchGenerations), amp * 0.8, bw, 0, false);
    }
  }

  subdivide(
    from.clone(), to.clone(), p.generations, p.jitter,
    p.width, p.width * 0.15, true,
  );
  return out;
}

/**
 * The mesh. One of these lives for the session; strikes refill it.
 *
 * @param {THREE.Scene} scene
 * @param {object} [opts] overrides on BOLT_DEFAULTS
 */
export function createBolt(scene, opts = {}) {
  const params = { ...BOLT_DEFAULTS, ...opts };
  const MAX = params.maxSegments;

  // Six vertices per segment: two triangles, a quad about the segment's axis.
  // Non-indexed, because an index buffer for a strip this small saves nothing
  // and costs a second attribute to keep in sync.
  const VERTS = MAX * 6;
  const aP0 = new Float32Array(VERTS * 3);
  const aP1 = new Float32Array(VERTS * 3);
  const aSide = new Float32Array(VERTS);
  const aT = new Float32Array(VERTS);
  const aW = new Float32Array(VERTS);

  const geom = new THREE.BufferGeometry();
  // `position` exists only because three requires it to compute a draw count;
  // the vertex shader ignores it entirely and builds the ribbon from aP0/aP1.
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(VERTS * 3), 3));
  geom.setAttribute("boltP0", new THREE.BufferAttribute(aP0, 3));
  geom.setAttribute("boltP1", new THREE.BufferAttribute(aP1, 3));
  geom.setAttribute("boltSide", new THREE.BufferAttribute(aSide, 1));
  geom.setAttribute("boltT", new THREE.BufferAttribute(aT, 1));
  geom.setAttribute("boltW", new THREE.BufferAttribute(aW, 1));
  // Never culled: the geometry is rebuilt in world space every strike and its
  // bounds would be a frame stale, which on a 4 km bolt is a bolt that vanishes.
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const uFade = uniform(1);
  const uBright = uniform(params.brightness);
  const uColor = uniform(new THREE.Color(params.color));

  const mat = new THREE.MeshBasicNodeMaterial();

  /*
   * THE RIBBON, BUILT IN THE VERTEX SHADER.
   *
   * The CPU stores each segment's two endpoints and nothing else; the width is
   * applied here, perpendicular to BOTH the segment and the view. Doing it on
   * the CPU would mean rebuilding the whole mesh every frame the camera moves,
   * which for a chase camera is every frame.
   */
  mat.vertexNode = Fn(() => {
    const p0 = attribute("boltP0", "vec3");
    const p1 = attribute("boltP1", "vec3");
    const t = attribute("boltT", "float");
    const side = attribute("boltSide", "float");
    const w = attribute("boltW", "float");

    const pos = mix(p0, p1, t).toVar();
    const dir = normalize(p1.sub(p0));
    const toCam = normalize(cameraPosition.sub(pos));
    // Perpendicular to the channel and to the eye: the ribbon always presents
    // its full width, whatever angle the bolt is seen from.
    const off = normalize(cross(dir, toCam));
    pos.addAssign(off.mul(side.mul(w)));
    return cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(pos, 1.0));
  })();

  // Flat emissive core. No falloff across the ribbon: a lightning channel is
  // overexposed in every photograph ever taken of one, and the soft glow around
  // it is the bloom pass's job, not a gradient's.
  mat.colorNode = uColor.mul(uBright);
  mat.opacityNode = uFade;
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = true;
  mat.side = THREE.DoubleSide;
  mat.toneMapped = false;
  mat.fog = false;
  mat.forceSinglePass = true;

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = "LightningBolt";
  mesh.frustumCulled = false;
  mesh.renderOrder = 14;
  mesh.visible = false;
  scene.add(mesh);

  /** Write a path into the buffers and show it. */
  function show(segments) {
    const n = Math.min(segments.length, MAX);
    for (let i = 0; i < n; i++) {
      const s = segments[i];
      // Two triangles: (0,0,-1) (0,0,+1) (1,1,-1) and (0,0,+1) (1,1,+1) (1,1,-1),
      // where the triple is (endpoint, t, side).
      const corners = [
        [0, -1, s.w0], [0, 1, s.w0], [1, -1, s.w1],
        [0, 1, s.w0], [1, 1, s.w1], [1, -1, s.w1],
      ];
      for (let c = 0; c < 6; c++) {
        const v = i * 6 + c;
        aP0[v * 3] = s.a.x; aP0[v * 3 + 1] = s.a.y; aP0[v * 3 + 2] = s.a.z;
        aP1[v * 3] = s.b.x; aP1[v * 3 + 1] = s.b.y; aP1[v * 3 + 2] = s.b.z;
        aT[v] = corners[c][0];
        aSide[v] = corners[c][1];
        aW[v] = corners[c][2];
      }
    }
    for (const k of ["boltP0", "boltP1", "boltSide", "boltT", "boltW"]) {
      geom.getAttribute(k).needsUpdate = true;
    }
    // Only the segments written are drawn, so a short bolt costs less than a
    // long one and the tail of the buffer is never touched.
    geom.setDrawRange(0, n * 6);
    mesh.visible = true;
  }

  return {
    mesh,
    params,
    show,
    hide() { mesh.visible = false; },
    setFade(v) { uFade.value = v; },
    get visible() { return mesh.visible; },
    dispose() {
      scene.remove(mesh);
      geom.dispose();
      mat.dispose();
    },
  };
}
