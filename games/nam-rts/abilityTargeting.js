/**
 * ABILITY TARGETING — the cursor half. UX only; it never casts anything.
 *
 * Modelled on buildPlacement.js and it borrows that file's event discipline
 * deliberately, because getting it wrong is invisible until it is infuriating:
 * pointerdown is listened for in the CAPTURE phase so selection.js never sees
 * the click and box-selects instead of casting, and the cancel rides on
 * `contextmenu` rather than pointerdown because that is where selection's move
 * order lives. Both are swallowed with stopImmediatePropagation.
 *
 * ── TWO SHAPES ──────────────────────────────────────────────────────────────
 *
 *   point — a ring the size of the effect. One click.
 *   run   — a corridor. Press to set where it starts, DRAG to aim it, release
 *           to commit. A napalm run denies a corridor, and which way that
 *           corridor points is the whole tactical decision, so it has to be an
 *           input rather than something inferred. A drag shorter than a few
 *           metres falls back to aiming away from the caster, so an
 *           impatient click still does something sensible instead of nothing.
 *
 * ── RANGE IS SHOWN, NOT JUST ENFORCED ───────────────────────────────────────
 *
 * The ghost turns red out of range and the click is refused. A button that
 * silently does nothing reads as a broken game; a red cursor reads as a rule.
 */
import * as THREE from "three";
import { Fn, cos, positionLocal, sin, uniform, vec3 } from "three/tsl";
import { drapedPosition } from "./terrainDrape.js";

const OK = new THREE.Color(0x3ddc60);
const BAD = new THREE.Color(0xe4483a);

/**
 * A DRAPED material — the ghost hugs the ground instead of floating over it.
 *
 * A flat slab laid at one height is invisible the moment the ground is not
 * flat: on nam-valley's dunes the far half of a 70 m corridor simply
 * disappeared into a rise. This is craterSystem's recipe (terrainDrape.js),
 * which samples the live heightmap in the VERTEX stage, so the ghost bends
 * over exactly the surface it is describing.
 *
 * `uOrigin` and `uYaw` are uniforms rather than the object's own transform
 * because draping needs each vertex's WORLD position, and an object transform
 * is applied after the position node has already run.
 */
function drapedGhost(heightTexNode, geo, { opacity, lift = 0.35 }) {
  const mat = new THREE.MeshBasicNodeMaterial({
    color: OK, transparent: true, opacity, depthWrite: false,
    side: THREE.DoubleSide, fog: false, toneMapped: false,
  });
  const uOrigin = uniform(new THREE.Vector3());
  const uYaw = uniform(0);
  const uLen = uniform(1);
  mat.positionNode = Fn(() => {
    const p = vec3(positionLocal.x, positionLocal.y, positionLocal.z.mul(uLen));
    const c = cos(uYaw), s = sin(uYaw);
    // Yaw about Y, then into world space.
    const wx = p.x.mul(c).add(p.z.mul(s)).add(uOrigin.x);
    const wz = p.z.mul(c).sub(p.x.mul(s)).add(uOrigin.z);
    return drapedPosition(heightTexNode, wx, wz, lift);
  })();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.userData = { uOrigin, uYaw, uLen, mat };
  return mesh;
}

/** A flat ring on the ground: the effect's footprint. */
function makeRing(heightTexNode, radius) {
  const g = new THREE.Group();
  const disc = drapedGhost(heightTexNode, new THREE.CircleGeometry(radius, 44).rotateX(-Math.PI / 2),
    { opacity: 0.22 });
  const rim = drapedGhost(heightTexNode, new THREE.RingGeometry(radius * 0.94, radius, 44).rotateX(-Math.PI / 2),
    { opacity: 0.85, lift: 0.4 });
  g.add(disc, rim);
  g.userData.parts = [disc, rim];
  g.userData.mats = [disc.userData.mat, rim.userData.mat];
  return g;
}

/**
 * The corridor. Built along +Z as a UNIT-length strip whose length is carried
 * by a uniform, not by the object scale — scaling the group stretched the
 * arrow head 70x along with the body, which is what it looked like.
 */
function makeCorridor(heightTexNode, width, length) {
  const g = new THREE.Group();
  // SUBDIVIDED, and it has to be: draping happens per VERTEX, so a 70 m strip
  // with four corners touches the ground only at those corners and cuts
  // straight through everything between them. Over nam-valley's dunes that
  // read as a torn sheet rather than a corridor. craterSystem subdivides 28x
  // for a decal a few metres across; a run is an order of magnitude longer, so
  // the segments go along its LENGTH, where the ground actually changes.
  const body = drapedGhost(heightTexNode,
    new THREE.PlaneGeometry(width, 1, 4, 64).rotateX(-Math.PI / 2).translate(0, 0, 0.5),
    { opacity: 0.24 });
  body.userData.uLen.value = length;
  // A head at the far end so the heading is unmistakable — a plain rectangle
  // reads the same both ways round. Its own mesh, so the body's length uniform
  // never touches it.
  const head = drapedGhost(heightTexNode,
    new THREE.CircleGeometry(width * 0.5, 3).rotateX(-Math.PI / 2).rotateY(Math.PI / 6),
    { opacity: 0.9, lift: 0.4 });
  g.add(body, head);
  g.userData.parts = [body, head];
  g.userData.head = head;
  g.userData.body = body;
  g.userData.mats = [body.userData.mat, head.userData.mat];
  return g;
}

/**
 * @param {object} o
 *   app        engine handle (scene, renderer, pickWorldAtClient, getWorldHeight)
 *   abilities  createAbilities()
 *   getSelection  () => the current selection
 *   onCast     (ability, at) — fired only on a VALID commit
 */
export function createAbilityTargeting({
  app, abilities, getSelection = () => [], onCast = () => {},
}) {
  const { scene } = app;
  const dom = app.renderer.domElement;

  let ability = null;
  let ghost = null;
  let caster = null;
  let valid = false;
  let at = null;            // { x, z, dirX, dirZ }
  let dragFrom = null;      // set between press and release, for a "run"

  const state = { get active() { return !!ability; }, get ability() { return ability; } };

  function setTint(good) {
    if (ghost) for (const m of ghost.userData.mats) m.color.copy(good ? OK : BAD);
  }

  function groundAt(clientX, clientY) {
    return app.pickWorldAtClient?.(clientX, clientY)?.point ?? null;
  }

  /** Lay the ghost out for the current cursor position (and drag, if any). */
  function place(p) {
    if (!p) { valid = false; if (ghost) ghost.visible = false; return; }
    ghost.visible = true;

    if (ability.target === "run") {
      const from = dragFrom ?? p;
      let dx = p.x - from.x, dz = p.z - from.z;
      // Too short a drag to mean anything: aim the run AWAY from the caster,
      // which is the direction an air strike would sensibly come in on.
      if (Math.hypot(dx, dz) < 5) {
        dx = from.x - caster.position.x;
        dz = from.z - caster.position.z;
        if (Math.hypot(dx, dz) < 1e-3) { dx = 0; dz = 1; }
      }
      const m = Math.hypot(dx, dz);
      at = { x: from.x, z: from.z, dirX: dx / m, dirZ: dz / m };
      const yaw = Math.atan2(at.dirX, at.dirZ);
      ghost.userData.body.userData.uOrigin.value.set(from.x, 0, from.z);
      ghost.userData.body.userData.uYaw.value = yaw;
      // The head rides at the far END of the run, in world space.
      ghost.userData.head.userData.uOrigin.value.set(
        from.x + at.dirX * ability.length, 0, from.z + at.dirZ * ability.length);
      ghost.userData.head.userData.uYaw.value = yaw;
    } else {
      at = { x: p.x, z: p.z, dirX: 0, dirZ: 1 };
      for (const part of ghost.userData.parts) part.userData.uOrigin.value.set(p.x, 0, p.z);
    }

    const d = Math.hypot(at.x - caster.position.x, at.z - caster.position.z);
    valid = d <= ability.range && abilities.check(ability, getSelection()).ok;
    setTint(valid);
  }

  function end() {
    if (ghost) { scene.remove(ghost); ghost = null; }
    ability = null; caster = null; valid = false; at = null; dragFrom = null;
    dom.removeEventListener("pointermove", onMove);
    dom.removeEventListener("pointerdown", onDown, true);
    dom.removeEventListener("pointerup", onUp, true);
    dom.removeEventListener("contextmenu", onContext, true);
    window.removeEventListener("keydown", onKey);
  }

  function onMove(e) { if (ability) place(groundAt(e.clientX, e.clientY)); }

  function onDown(e) {
    if (!ability || e.button !== 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();     // selection must not box-select this click
    const p = groundAt(e.clientX, e.clientY);
    if (!p) return;
    if (ability.target === "run") { dragFrom = { x: p.x, z: p.z }; place(p); return; }
    commit();
  }

  function onUp(e) {
    if (!ability || e.button !== 0 || ability.target !== "run") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!dragFrom) return;
    place(groundAt(e.clientX, e.clientY));
    commit();
  }

  function commit() {
    if (!valid || !at) return;       // out of range / unaffordable: stay in targeting
    const a = ability, target = at;  // end() clears both
    end();
    onCast(a, target);
  }

  function onContext(e) {
    if (!ability) return;
    e.preventDefault();
    e.stopImmediatePropagation();    // beat selection's move order
    end();
  }

  function onKey(e) { if (e.key === "Escape" && ability) end(); }

  return {
    state,
    /** Enter targeting for `a`. No-op when nothing in the selection can cast it. */
    begin(a) {
      if (!a) return;
      if (ability) end();
      const sel = getSelection();
      const c = abilities.pickCaster(a, sel);
      if (!c) return;
      ability = a;
      caster = c;
      ghost = a.target === "run"
        ? makeCorridor(app.heightTexNode, a.radius * 2, a.length)
        : makeRing(app.heightTexNode, a.radius);
      ghost.visible = false;
      scene.add(ghost);
      dom.addEventListener("pointermove", onMove);
      dom.addEventListener("pointerdown", onDown, true);
      dom.addEventListener("pointerup", onUp, true);
      dom.addEventListener("contextmenu", onContext, true);
      window.addEventListener("keydown", onKey);
    },
    cancel() { if (ability) end(); },
    dispose() { end(); },
  };
}
