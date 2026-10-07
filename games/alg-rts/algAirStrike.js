// THE AIR STRIKE (you, 2026-10-07: "the Alouette shouldn't keep bombs — we switch to a called-in
// air strike, as in CoH") — the post radios the T-6s:
//
//   select the POST → FRAPPE AÉRIENNE (L, "largage" — V is the cover view) on the command card → a ring follows the cursor →
//   left-click calls it, right-click / Esc cancels.
//
// After the radio's delay a T-6 Texan comes in from the post's side, low: it STRAFES a line that
// ends on the point (its wing guns walking their rounds up to it), lets go its two bombs — they
// fall ahead of it onto the point — and climbs away. CoH's strafing run + bomb in one pass. The
// rounds and bombs hurt only the FLN (combat.splashAt skips the owner's team), but a bomb on a
// village wrecks it (algDamage). The French pay MUNITIONS; the post has a cooldown.
import * as THREE from "three";
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";
import { FR_PAINT_TINT, buildT6 } from "../../v3/render/objects/rtsVehiclesFr.js";
import { rtsObjectMaterialTinted } from "../../v3/render/objects/rtsObjectProps.js";
import { stencilMesh } from "../../v3/render/objects/rtsStencils.js";
import { t } from "./i18n/i18n.js";

export const AIRSTRIKE = {
  cost: { mun: 120 },
  cooldown: 150,    // s, the post's
  delay: 4,         // s from the call to the plane over the point (the radio, the approach)
  speed: 62,        // m/s (~220 km/h, a T-6 in a dive)
  cruise: 85,       // m: its height coming in and going away
  low: 34,          // m: its height on the run
  strafe: 45,       // m: the strafing line, ending on the point
  rounds: 26,       // over the line
  strafeDamage: 12, strafeSplash: 2.4,
  bombs: 2, bombDamage: 85, bombSplash: 9,
  radius: 10,       // m: the ring shown (the bombs' reach)
};

/**
 * @param {object} o
 * @param {object} o.app
 * @param {object} o.selection
 * @param {object} o.projectiles  (spawn: the strafe's rounds; spawnArc: the bombs)
 * @param {object} o.combat       (splashAt: the strafe's hits)
 * @param {object} [o.purse]      the French purse (munitions); none = free
 */
export function createAlgAirStrike({ app, selection, projectiles, combat, purse = null }) {
  const P = AIRSTRIKE;
  const dom = app.renderer.domElement;
  const rings = createSelectionRingField({ app, max: 4, inner: 0.93, opacity: 0.75 });
  let targeting = null;   // { post, at }
  const runs = [];        // { post, x, z, dir, t, plane, rounds, bombs }
  const cooling = new Set();   // posts with a cooldown running
  const isPost = (s) => s?.alive && s.isStructure && s.typeKey === "post" && s.team === "player";
  const groundY = (x, z) => app.getWorldHeight?.(x, z) ?? 0;

  // The plane: one mesh set, cloned per run (kit material, cockades, a spinning propeller).
  const proto = buildT6();
  const makePlane = () => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(proto, rtsObjectMaterialTinted(FR_PAINT_TINT));
    body.castShadow = true;
    const st = stencilMesh(proto.userData.stencil);
    if (st) body.add(st);
    const prop = new THREE.Mesh(proto.userData.prop.geo, body.material);
    prop.position.fromArray(proto.userData.prop.pivot);
    g.add(body, prop);
    g.userData.prop = prop;
    return g;
  };

  function ability(sel) {
    if (sel.length !== 1 || !isPost(sel[0])) return null;
    const s = sel[0], cd = Math.max(0, s.airCd ?? 0), busy = runs.some((r) => r.post === s);
    // THE LINE CUT (algTelegraph.js): no line to Algiers, no aircraft.
    if (app.algTelegraph?.cut) return { key: "airStrike", label: t("Ligne coupée"), cost: purse ? P.cost : undefined, hint: t("Le FLN a coupé la ligne télégraphique : le poste ne peut plus demander d'avion. Des sapeurs peuvent la réparer (clic droit sur le poteau abattu)."), ready: false, cooldown: 0 };
    return {
      key: "airStrike", label: busy ? t("Avion en route") : t("Frappe aérienne"), cost: purse ? P.cost : undefined,
      hint: t("Un T-6 mitraille une ligne de {strafe} m jusqu'au point, puis y largue {bombs} bombes. ~{delay} s pour arriver, depuis le poste. Les abris ne protègent pas des bombes. L.", { strafe: P.strafe, bombs: P.bombs, delay: P.delay }),
      ready: !busy && cd <= 0 && (!purse || purse.canAfford(P.cost)), cooldown: Math.ceil(cd),
    };
  }

  function begin(sel = selection.selected) {
    const post = (sel ?? []).find(isPost);
    if (!post || app.algTelegraph?.cut || (post.airCd ?? 0) > 0 || runs.some((r) => r.post === post) || (purse && !purse.canAfford(P.cost))) return false;
    targeting = { post, at: null };
    dom.style.cursor = "crosshair";
    return true;
  }
  function cancel() { targeting = null; dom.style.cursor = ""; }
  function aimAt(e) {
    const hit = app.pickWorldAtClient?.(e.clientX, e.clientY);
    targeting.at = hit?.point ? { x: hit.point.x, z: hit.point.z } : null;
  }
  const onMove = (e) => { if (targeting) aimAt(e); };
  const onDown = (e) => {
    if (!targeting) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.button !== 0) { cancel(); return; }
    aimAt(e);
    const { post, at } = targeting;
    cancel();
    if (at) call(post, at.x, at.z);
  };
  const onKey = (e) => { if (e.key === "Escape" && targeting) cancel(); };
  const onContext = (e) => { if (targeting) { e.preventDefault(); e.stopImmediatePropagation(); cancel(); } };
  dom.addEventListener("pointerdown", onDown, true);
  dom.addEventListener("contextmenu", onContext, true);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("keydown", onKey);

  /**
   * Call it on (x, z). The run comes in along the line from the post to the point (from the
   * French side: over their own heads, as the pilots were told), or `dir` if given.
   */
  function call(post, x, z, dir = null) {
    if (purse && !purse.spend(P.cost)) return false;
    post.airCd = P.cooldown;
    cooling.add(post);
    const d = dir ?? new THREE.Vector2(x - post.position.x, z - post.position.z);
    if (d.lengthSq() < 1) d.set(0, 1);
    d.normalize();
    const plane = makePlane();
    plane.visible = false;
    app.scene.add(plane);
    runs.push({ post, x, z, dir: d, t: -P.delay, plane, rounds: 0, bombs: 0 });
    app.algSounds?.radio?.();
    return true;
  }

  // Where the plane is at run time t (0 = over the point): along the line, its height a dive in
  // and a climb out; pitch from the slope.
  const _p = new THREE.Vector3(), _q = new THREE.Vector3();
  function planeAt(r, t, out) {
    const s = t * P.speed;   // metres past the point (negative: before it)
    const h = s < -260 ? P.cruise : s < -110 ? P.cruise + (P.low - P.cruise) * ((s + 260) / 150) : s < 40 ? P.low : P.low + (s - 40) * 0.45;
    return out.set(r.x + r.dir.x * s, groundY(r.x, r.z) + Math.min(h, 160), r.z + r.dir.y * s);
  }

  /** Fixed clock: the cooldowns, each run's plane, rounds and bombs. */
  function step(dt) {
    for (const s of cooling) if ((s.airCd -= dt) <= 0) { s.airCd = 0; cooling.delete(s); }
    for (let i = runs.length - 1; i >= 0; i--) {
      const r = runs[i];
      r.t += dt;
      // The STRAFE: the rounds walk up the line from its start to the point, fired from the wing
      // guns ~120 m back along the run (where the plane is when each lands, roughly).
      const strafeT0 = -(P.strafe + 120) / P.speed, strafeT1 = -120 / P.speed;
      while (r.rounds < P.rounds && r.t >= strafeT0 + (strafeT1 - strafeT0) * (r.rounds / P.rounds)) {
        const f = r.rounds / (P.rounds - 1);
        const back = P.strafe * (1 - f);
        const side = (r.rounds % 2 ? 1 : -1) * 1.6;
        const gx = r.x - r.dir.x * back - r.dir.y * side + (Math.random() - 0.5) * 1.2;
        const gz = r.z - r.dir.y * back + r.dir.x * side + (Math.random() - 0.5) * 1.2;
        planeAt(r, r.t, _p);
        const at = new THREE.Vector3(gx, groundY(gx, gz), gz);
        projectiles.spawn(_p.clone(), { position: at, isAir: false, isStructure: false }, 0, { weapon: "mg", team: "player" }, null, { miss: true, exact: true });
        // A ROUND, not a blast (splashAt drew a 6 m explosion per round: a wall of dust): the FLN
        // within reach of it take a bullet, through combat's own hit (blood, suppression).
        for (const u of app.algUnits?.units?.list ?? []) {
          if (!u.alive || u.team !== "enemy" || u.inside) continue;
          if ((u.position.x - gx) ** 2 + (u.position.z - gz) ** 2 > P.strafeSplash ** 2) continue;
          combat.onImpact(u, P.strafeDamage, at, r.post, { bullet: true });
        }
        r.rounds++;
      }
      // The BOMBS: let go so they fall onto the point (a 1.6 s fall from the run's height, carried
      // forward by the plane's speed), a beat apart.
      const fall = Math.sqrt((2 * P.low) / 34);
      while (r.bombs < P.bombs && r.t >= -fall + (r.bombs - (P.bombs - 1) / 2) * 0.15) {
        planeAt(r, r.t, _p);
        const k = r.bombs - (P.bombs - 1) / 2;
        const to = new THREE.Vector3(r.x + r.dir.x * k * 4, 0, r.z + r.dir.y * k * 4);
        to.y = groundY(to.x, to.z);
        projectiles.spawnArc(_p.clone().add(_q.set(0, -1.2, 0)), to, { damage: P.bombDamage, splash: P.bombSplash, owner: r.post, flight: fall });
        r.bombs++;
      }
      if (r.t > 12) { app.scene.remove(r.plane); runs.splice(i, 1); }
    }
  }

  /** Every frame: the plane where its run puts it; the rings. */
  function frame() {
    const now = performance.now() / 1000;
    for (const r of runs) {
      const vis = r.t > -P.delay + 0.2 && r.t < 11.5;
      r.plane.visible = vis;
      if (!vis) continue;
      planeAt(r, r.t, _p);
      planeAt(r, r.t + 0.05, _q);
      r.plane.position.copy(_p);
      r.plane.lookAt(_q);   // its +Z (the nose) along the path: it dives and climbs with it
      r.plane.userData.prop.rotation.z = now * 60;
    }
    rings.begin();
    if (targeting?.at) rings.add(targeting.at.x, targeting.at.z, P.radius, 0x58e070);
    for (const r of runs) rings.add(r.x, r.z, P.radius, 0xffb020);
    rings.commit();
  }

  return {
    params: P, ability, begin, cancel, call, step, frame,
    get targeting() { return !!targeting; },
    get running() { return runs.length; },
    dispose() {
      dom.removeEventListener("pointerdown", onDown, true);
      dom.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey);
      for (const r of runs) app.scene.remove(r.plane);
    },
  };
}
