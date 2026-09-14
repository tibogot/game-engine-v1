// ============================================================================
// PER-PASS INSTANCED CULLING — skip a city mesh in the passes that cannot see it.
//
// ── THE PROBLEM ─────────────────────────────────────────────────────────────
//
// Every city InstancedMesh is `frustumCulled = false`: its instances span the
// whole city, so three's one bounding sphere would pass every camera anyway.
// The city's LOD tick already culls per INSTANCE for the main view
// (modularRoadCityLodView.js) — but it cannot do that for anything that casts,
// because the shadow passes draw the same mesh with the same `count`, and an
// instance dropped for being off-screen would also drop the shadow it throws
// into the frame. So every caster went to the main pass AND to both cascades,
// every frame, whether any of its instances were anywhere near that camera.
//
// The shadow pass is not triangle bound here (proj_modular_road_shadow_budget):
// it is paid per SUBMITTED MESH, ~20-75 us each. Measured on the open street
// at x=153: ~43 submissions a frame go to a camera that holds none of their
// instances.
//
// ── WHAT THIS DOES ──────────────────────────────────────────────────────────
//
// Wraps `renderer.renderObject` — the one call every pass funnels through,
// shadows included (ShadowNode swaps the render-object FUNCTION, and that
// function calls renderObject). For an enrolled mesh it asks the camera
// actually drawing: does any instance's bounding sphere touch your frustum?
// If not, the submission is skipped. The answer is decided by the same planes
// the GPU clips against, padded, so it is lossless — a skipped mesh would have
// produced zero fragments in that pass.
//
//   · shadow cameras test the 4 SIDE planes only. A caster between the light
//     and the cascade's near plane still has to be considered conservative.
//   · the main camera (and any other) tests all 6.
//   · results are cached per mesh x camera x render call, so a mesh drawn by
//     the same camera twice in one render is tested once.
//
// A side effect the city wanted: an L0 tower behind the camera is dropped
// from the MAIN pass but still casts, because the cascades test it for
// themselves.
//
// ── THE SHADOW COUNT ────────────────────────────────────────────────────────
//
// A mesh whose owner packs its instances near-first may also publish
// `userData.shadowCount`: in shadow passes only the first that-many instances
// are drawn. That is how small furniture gets a short shadow distance without
// a second mesh (and a second pipeline compile) — the owner already
// partitions on its LOD tick; it just partitions the shadow range first.
//
// ── WHAT MAY BE ENROLLED ────────────────────────────────────────────────────
//
// Only meshes whose instance matrix IS where the geometry is drawn. A material
// with a `positionNode` or `vertexNode` moves vertices on the GPU, and the
// CPU sphere would be a lie (v3's engine has one such mesh with 4505
// instances). `enroll()` refuses those, and anything already frustum-culled
// by three itself.
// ============================================================================
import { WebGPUCoordinateSystem } from "three";

const _planes = 6;

/**
 * @param {object} renderer  three WebGPURenderer
 * @param {object} [opts]
 * @param {number} [opts.pad]  metres added to every instance radius
 */
export function installPassCull(renderer, opts = {}) {
  const state = {
    /** Master switch. Off = every submission goes through untouched. */
    enabled: true,
    /** Honour `userData.shadowCount` in shadow passes. */
    shadowCounts: true,
    pad: opts.pad ?? 0.5,
  };
  const stats = { skipped: 0, trimmed: 0, tested: 0 };

  /** mesh -> { spheres, version, count, byCam: Map<camera, {key, visible}> }
   *  Weak, so a disposed city's meshes are never held alive by this. */
  let enrolled = new WeakMap();
  let enrolledCount = 0;
  /** camera -> { key, shadow, p: Float32Array(24) } */
  const cams = new WeakMap();

  function acceptable(mesh) {
    if (!mesh?.isInstancedMesh || mesh.frustumCulled) return false;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) if (!m || m.positionNode || m.vertexNode) return false;
    return true;
  }

  function enroll(mesh) {
    if (!acceptable(mesh) || enrolled.has(mesh)) return false;
    enrolled.set(mesh, { spheres: null, version: -1, count: -1, byCam: new Map() });
    enrolledCount++;
    return true;
  }

  /** Enroll every acceptable InstancedMesh under `root`. Returns how many. */
  function enrollTree(root) {
    let n = 0;
    root?.traverse?.((o) => { if (enroll(o)) n++; });
    return n;
  }

  function release(mesh) {
    if (enrolled.delete(mesh)) enrolledCount--;
  }

  /** Forget every enrolment (a rebuild replaced the meshes). */
  function reset() {
    enrolled = new WeakMap();
    enrolledCount = 0;
  }

  // ── Instance spheres ──────────────────────────────────────────────────────
  // Rebuilt only when the owner rewrote the matrices (attribute version) or
  // changed `count`. Static meshes build once; traffic rebuilds per frame,
  // which is a few hundred spheres.
  function spheresOf(mesh, e) {
    const attr = mesh.instanceMatrix;
    const count = mesh.count;
    if (e.spheres && e.version === attr.version && e.count === count) return e.spheres;
    const geo = mesh.geometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const bs = geo.boundingSphere;
    const cx = bs.center.x, cy = bs.center.y, cz = bs.center.z;
    const br = bs.radius;
    if (!e.spheres || e.spheres.length < count * 4) e.spheres = new Float32Array(Math.max(4, count * 4));
    const s = e.spheres;
    const a = attr.array;
    for (let i = 0; i < count; i++) {
      const o = i * 16, k = i * 4;
      const m0 = a[o], m1 = a[o + 1], m2 = a[o + 2];
      const m4 = a[o + 4], m5 = a[o + 5], m6 = a[o + 6];
      const m8 = a[o + 8], m9 = a[o + 9], m10 = a[o + 10];
      s[k] = m0 * cx + m4 * cy + m8 * cz + a[o + 12];
      s[k + 1] = m1 * cx + m5 * cy + m9 * cz + a[o + 13];
      s[k + 2] = m2 * cx + m6 * cy + m10 * cz + a[o + 14];
      const sx = m0 * m0 + m1 * m1 + m2 * m2;
      const sy = m4 * m4 + m5 * m5 + m6 * m6;
      const sz = m8 * m8 + m9 * m9 + m10 * m10;
      s[k + 3] = br * Math.sqrt(Math.max(sx, sy, sz)) * 1.02;
    }
    e.version = attr.version;
    e.count = count;
    e.byCam.clear();
    return s;
  }

  // ── Camera planes ─────────────────────────────────────────────────────────
  // Keyed on the renderer's render-call counter: a camera's planes are built
  // at most once per render() call, and a camera re-used by a later render
  // (moved in between) gets fresh ones.
  function planesOf(camera, shadow) {
    const key = renderer.info.calls;
    let c = cams.get(camera);
    if (!c) { c = { key: -1, shadow, p: new Float32Array(24) }; cams.set(camera, c); }
    if (c.key === key && c.shadow === shadow) return c;
    c.key = key;
    c.shadow = shadow;
    // projection x view, both current: render() has already updated
    // matrixWorldInverse by the time objects are submitted.
    const pe = camera.projectionMatrix.elements;
    const ve = camera.matrixWorldInverse.elements;
    const me = _m;
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        me[col * 4 + row] =
          pe[row] * ve[col * 4] + pe[4 + row] * ve[col * 4 + 1] +
          pe[8 + row] * ve[col * 4 + 2] + pe[12 + row] * ve[col * 4 + 3];
      }
    }
    const p = c.p;
    // Rows of the clip matrix (column-major storage): plane = row3 +/- rowN.
    const r0x = me[0], r0y = me[4], r0z = me[8], r0w = me[12];
    const r1x = me[1], r1y = me[5], r1z = me[9], r1w = me[13];
    const r2x = me[2], r2y = me[6], r2z = me[10], r2w = me[14];
    const r3x = me[3], r3y = me[7], r3z = me[11], r3w = me[15];
    setPlane(p, 0, r3x + r0x, r3y + r0y, r3z + r0z, r3w + r0w);   // left
    setPlane(p, 1, r3x - r0x, r3y - r0y, r3z - r0z, r3w - r0w);   // right
    setPlane(p, 2, r3x + r1x, r3y + r1y, r3z + r1z, r3w + r1w);   // bottom
    setPlane(p, 3, r3x - r1x, r3y - r1y, r3z - r1z, r3w - r1w);   // top
    // WebGPU clip z is [0, w]: near is row2 alone. A WebGL-convention camera
    // ([-w, w]) needs row3 + row2 — using row2 there would cut at mid-depth.
    if (camera.coordinateSystem === WebGPUCoordinateSystem) setPlane(p, 4, r2x, r2y, r2z, r2w);
    else setPlane(p, 4, r3x + r2x, r3y + r2y, r3z + r2z, r3w + r2w);   // near
    setPlane(p, 5, r3x - r2x, r3y - r2y, r3z - r2z, r3w - r2w);   // far
    return c;
  }

  function anyInside(mesh, e, camera, shadow, n) {
    const c = planesOf(camera, shadow);
    // Spheres first: a rebuild clears the per-camera memos.
    const s = spheresOf(mesh, e);
    let memo = e.byCam.get(camera);
    if (memo && memo.key === c.key && memo.n === n && memo.shadow === shadow) return memo.visible;
    const p = c.p;
    const np = shadow ? 4 : _planes;
    const pad = state.pad;
    let visible = false;
    stats.tested++;
    for (let i = 0; i < n && !visible; i++) {
      const k = i * 4;
      const x = s[k], y = s[k + 1], z = s[k + 2], r = -(s[k + 3] + pad);
      let inside = true;
      for (let j = 0; j < np; j++) {
        const q = j * 4;
        if (p[q] * x + p[q + 1] * y + p[q + 2] * z + p[q + 3] < r) { inside = false; break; }
      }
      visible = inside;
    }
    if (!memo) { memo = {}; e.byCam.set(camera, memo); }
    memo.key = c.key; memo.n = n; memo.shadow = shadow; memo.visible = visible;
    return visible;
  }

  const orig = renderer.renderObject;
  renderer.renderObject = function (object, scene, camera, ...rest) {
    const e = state.enabled && object.isInstancedMesh ? enrolled.get(object) : undefined;
    if (e === undefined) return orig.call(this, object, scene, camera, ...rest);
    // A shadow pass runs with ShadowNode's render-object function installed,
    // which three tags with its `shadowType`.
    const fn = this.getRenderObjectFunction();
    const shadow = !!fn && fn.shadowType !== undefined;
    const full = object.count;
    let n = full;
    if (shadow && state.shadowCounts) {
      const sc = object.userData.shadowCount;
      if (sc != null && sc < n) n = sc;
    }
    if (n <= 0 || !anyInside(object, e, camera, shadow, n)) { stats.skipped++; return; }
    if (n === full) return orig.call(this, object, scene, camera, ...rest);
    stats.trimmed++;
    object.count = n;
    try { return orig.call(this, object, scene, camera, ...rest); }
    finally { object.count = full; }
  };

  return {
    state,
    stats,
    enroll,
    enrollTree,
    release,
    reset,
    get enrolledCount() { return enrolledCount; },
    resetStats() { stats.skipped = 0; stats.trimmed = 0; stats.tested = 0; },
    uninstall() { renderer.renderObject = orig; },
  };
}

const _m = new Float32Array(16);

function setPlane(p, i, x, y, z, w) {
  const inv = 1 / Math.hypot(x, y, z);
  const q = i * 4;
  p[q] = x * inv; p[q + 1] = y * inv; p[q + 2] = z * inv; p[q + 3] = w * inv;
}
