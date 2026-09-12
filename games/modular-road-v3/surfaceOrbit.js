import * as THREE from "three";

/**
 * ── ORBIT AROUND WHAT YOU POINT AT ───────────────────────────────────────────
 *
 * OrbitControls turns around ONE point, `controls.target`, and nothing moves
 * it but a pan. In the track builder you could right-click a piece and press
 * `.` to put the pivot on it, which is a good idea that needs a SELECTION —
 * and the city has none: two thousand buildings in a handful of instanced
 * meshes, nothing to right-click. So orbiting a building meant panning the
 * pivot to it by hand, every time.
 *
 * This is the rule SketchUp, Fusion and Blender's auto-depth all settled on,
 * because nobody has to learn it: THE PIVOT IS WHATEVER IS UNDER THE CURSOR
 * WHEN THE DRAG STARTS. One raycast on the orbit button going down, and if it
 * hits a surface, the drag turns the camera around that point.
 *
 * ── WHY IT IS NOT JUST `controls.target.copy(hit)` ───────────────────────────
 *
 * OrbitControls always looks AT its target, so moving the target to a point
 * under the cursor — off the screen's centre — swings the view to centre it:
 * a jump, on every drag. The way round it is to leave OrbitControls alone for
 * that drag and rotate BOTH the camera and its target rigidly about the pivot:
 * the view direction turns with the camera, nothing re-aims, and when the
 * drag ends OrbitControls simply carries on from where the two ended up.
 * Only the drag that started on a surface is taken over; start one on the sky
 * and OrbitControls orbits its own target exactly as before.
 *
 * Wheel zoom goes toward the cursor (`zoomToCursor`, OrbitControls' own flag),
 * and a double-press of the orbit button FRAMES the surface you pressed on.
 *
 * ── COST ─────────────────────────────────────────────────────────────────────
 *
 * One raycast per press of the orbit button. Nothing per frame.
 */
export const SURFACE_ORBIT = {
  /** Radians per pixel of drag. Same as the debug cam. */
  rotateSpeed: 0.0055,
  /** Keep the camera off the pivot's poles, where the azimuth is undefined. */
  minPolar: 0.04,
  /** A second press within this window and distance is a double-press. */
  dblMs: 350,
  dblPx: 6,
  /** Framing distance bounds, metres. */
  fitMin: 3,
  fitMax: 600,
  /** Ground ray-march: first step, growth per step, and how far to look. */
  marchStep: 2.0,
  marchGrow: 1.01,
  marchFar: 3000,
};

/**
 * @param {object} o
 * @param {THREE.Camera} o.camera
 * @param {import("three/addons/controls/OrbitControls.js").OrbitControls} o.controls
 * @param {HTMLElement} o.domElement
 * @param {() => THREE.Object3D[]} o.targets   roots to raycast, evaluated per press
 * @param {() => Iterable<THREE.Object3D>} [o.exclude]  objects (and their subtrees) never hit
 * @param {(x: number, z: number) => number} [o.groundHeight]  a height sampler for
 *   ground that is not raycastable geometry (the GPU clipmap); NaN = no ground
 * @param {() => boolean} [o.active]   whether orbiting is the camera's mode now
 * @param {number} [o.button]          the orbit mouse button (1 = middle)
 */
export function createSurfaceOrbit({
  camera, controls, domElement, targets, exclude = () => [], groundHeight = null,
  active = () => true, button = 1, params = {},
}) {
  const P = { ...SURFACE_ORBIT, ...params };
  const raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const _pivot = new THREE.Vector3();
  const _offC = new THREE.Vector3(), _offT = new THREE.Vector3();
  const _right = new THREE.Vector3(), _fwd = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _sph = new THREE.Sphere();
  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  let drag = null;          // {x, y}
  let lastDown = null;      // {t, x, y}
  let excludeSet = null;

  const ndcFrom = (x, y) => {
    const r = domElement.getBoundingClientRect();
    _ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    return _ndc;
  };

  /** True when the object or any ancestor is hidden or excluded. */
  const barred = (o) => {
    for (let n = o; n; n = n.parent) {
      if (!n.visible) return true;
      if (excludeSet && excludeSet.has(n)) return true;
      if (n.isTransformControlsRoot || n.isTransformControls) return true;
    }
    return false;
  };

  /** A framing radius for what was hit, instance-aware where it can be. */
  function radiusOf(hit) {
    const o = hit.object;
    const g = o.geometry;
    if (!g) return 8;
    if (!g.boundingSphere) g.computeBoundingSphere();
    let r = g.boundingSphere ? g.boundingSphere.radius : 8;
    let scale = 1;
    if (o.isInstancedMesh && hit.instanceId != null) {
      o.getMatrixAt(hit.instanceId, _m);
      scale = Math.max(_m.elements[0], _m.elements[5], _m.elements[10]);
    } else if (o.isBatchedMesh && hit.batchId != null && o.getBoundingSphereAt) {
      try { o.getBoundingSphereAt(hit.batchId, _sph); return Math.max(_sph.radius, 1); } catch (_) { /* fall through */ }
    } else {
      o.getWorldScale(_p);
      scale = Math.max(_p.x, _p.y, _p.z);
    }
    return Math.max(r * scale, 1);
  }

  /**
   * What is under the client-space point: the nearest raycast hit on the
   * targets, or the ground sampler's surface, whichever is closer.
   * @returns {{point: THREE.Vector3, radius: number, object: THREE.Object3D|null}|null}
   */
  function pickAt(x, y) {
    // The camera may have been moved by this module a moment ago and not yet
    // rendered; the ray must come from where it IS, not where it was drawn.
    camera.updateMatrixWorld(true);
    raycaster.setFromCamera(ndcFrom(x, y), camera);
    excludeSet = new Set(exclude() ?? []);
    const roots = (targets() ?? []).filter((o) => o && !barred(o));
    let best = null;
    if (roots.length) {
      const hits = raycaster.intersectObjects(roots, true);
      for (const h of hits) {
        if (barred(h.object)) continue;
        best = { point: h.point.clone(), radius: radiusOf(h), object: h.object, distance: h.distance };
        break;
      }
    }
    if (groundHeight) {
      const o = raycaster.ray.origin, d = raycaster.ray.direction;
      const far = best ? best.distance : P.marchFar;
      let t = 0.5, step = P.marchStep, prevT = 0;
      let prevAbove = true;
      while (t < far) {
        const h = groundHeight(o.x + d.x * t, o.z + d.z * t);
        if (Number.isFinite(h)) {
          const above = o.y + d.y * t > h;
          if (!above && prevAbove && prevT > 0) {
            // Bisect between the last point above and this one below.
            let lo = prevT, hi = t;
            for (let i = 0; i < 16; i++) {
              const mid = (lo + hi) * 0.5;
              const hm = groundHeight(o.x + d.x * mid, o.z + d.z * mid);
              if (Number.isFinite(hm) && o.y + d.y * mid > hm) lo = mid; else hi = mid;
            }
            const tg = (lo + hi) * 0.5;
            if (!best || tg < best.distance) {
              best = { point: _p.copy(o).addScaledVector(d, tg).clone(), radius: 8, object: null, distance: tg };
            }
            break;
          }
          prevAbove = above;
        }
        prevT = t;
        t += step;
        step *= P.marchGrow;
      }
    }
    return best;
  }

  /** Rotate camera and target rigidly about the pivot. */
  function orbitBy(dx, dy) {
    _offC.subVectors(camera.position, _pivot);
    _offT.subVectors(controls.target, _pivot);
    // Yaw about world up.
    _q.setFromAxisAngle(UP, -dx * P.rotateSpeed);
    _offC.applyQuaternion(_q); _offT.applyQuaternion(_q);
    // Pitch about the camera's right axis, unless it would take the camera
    // over a pole of the pivot or outside OrbitControls' own polar limits
    // about its target — either would jump on the next update().
    _fwd.subVectors(controls.target, camera.position).normalize();
    _right.crossVectors(_fwd, UP);
    if (_right.lengthSq() > 1e-8) {
      _right.normalize();
      _q.setFromAxisAngle(_right, -dy * P.rotateSpeed);
      const c2 = _offC.clone().applyQuaternion(_q), t2 = _offT.clone().applyQuaternion(_q);
      const polarPivot = Math.acos(THREE.MathUtils.clamp(c2.y / Math.max(c2.length(), 1e-6), -1, 1));
      const rel = c2.clone().sub(t2);
      const polarTarget = Math.acos(THREE.MathUtils.clamp(rel.y / Math.max(rel.length(), 1e-6), -1, 1));
      const lo = Math.max(P.minPolar, controls.minPolarAngle ?? 0);
      const hi = Math.min(Math.PI - P.minPolar, controls.maxPolarAngle ?? Math.PI);
      if (polarPivot > P.minPolar && polarPivot < Math.PI - P.minPolar && polarTarget >= lo && polarTarget <= hi) {
        _offC.copy(c2); _offT.copy(t2);
      }
    }
    camera.position.copy(_pivot).add(_offC);
    controls.target.copy(_pivot).add(_offT);
    camera.up.copy(UP);
    controls.update?.();
    camera.updateMatrixWorld(true);
  }

  /** Put the pivot on what is under (x, y) and fit it into view. */
  function frameAt(x, y) {
    const hit = pickAt(x, y);
    if (!hit) return false;
    _fwd.subVectors(camera.position, controls.target);
    if (_fwd.lengthSq() < 1e-8) _fwd.set(0.65, 0.35, 0.65);
    _fwd.normalize();
    const fov = THREE.MathUtils.degToRad(camera.fov ?? 60);
    const dist = THREE.MathUtils.clamp(hit.radius / Math.sin(fov * 0.5) * 1.15, P.fitMin, P.fitMax);
    controls.target.copy(hit.point);
    camera.position.copy(hit.point).addScaledVector(_fwd, dist);
    camera.up.copy(UP);
    controls.update?.();
    return true;
  }

  // ── Pointer handling — CAPTURE, ahead of OrbitControls on the same element.
  function onDown(e) {
    if (!active() || e.button !== button) return;
    const now = performance.now();
    const dbl = lastDown && now - lastDown.t < P.dblMs
      && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < P.dblPx;
    lastDown = { t: now, x: e.clientX, y: e.clientY };
    if (dbl) {
      lastDown = null;
      if (frameAt(e.clientX, e.clientY)) { e.stopImmediatePropagation(); e.preventDefault(); }
      return;
    }
    const hit = pickAt(e.clientX, e.clientY);
    if (!hit) return;                       // sky: OrbitControls' own orbit
    _pivot.copy(hit.point);
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
    e.stopImmediatePropagation();
    e.preventDefault();
    try { domElement.setPointerCapture(e.pointerId); } catch (_) { /* not all elements */ }
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    e.stopImmediatePropagation();
    orbitBy(e.clientX - drag.x, e.clientY - drag.y);
    drag.x = e.clientX; drag.y = e.clientY;
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    e.stopImmediatePropagation();
    drag = null;
    try { domElement.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  }
  domElement.addEventListener("pointerdown", onDown, true);
  domElement.addEventListener("pointermove", onMove, true);
  domElement.addEventListener("pointerup", onUp, true);
  domElement.addEventListener("pointercancel", onUp, true);
  // The orbit button is the middle one, which browsers otherwise use for
  // autoscroll on some platforms.
  const onAux = (e) => { if (e.button === button && active()) e.preventDefault(); };
  domElement.addEventListener("auxclick", onAux);

  return {
    pickAt, frameAt, orbitBy,
    /** Set the pivot explicitly (a harness, or a selection). */
    setPivot(p) { _pivot.copy(p); },
    get pivot() { return _pivot; },
    get dragging() { return !!drag; },
    dispose() {
      domElement.removeEventListener("pointerdown", onDown, true);
      domElement.removeEventListener("pointermove", onMove, true);
      domElement.removeEventListener("pointerup", onUp, true);
      domElement.removeEventListener("pointercancel", onUp, true);
      domElement.removeEventListener("auxclick", onAux);
    },
  };
}
