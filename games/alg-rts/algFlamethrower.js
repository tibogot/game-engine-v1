// THE LANCE-FLAMMES (2026-10-09, you: "French only, a separate 2-man team, CoH style"): the
// French army's flamethrower (Mle 1950) — what it used on caves and fortified houses here.
// GAME code. The team is the `lanceFlammes` squad (algSquads): the operator (slot 0, the lance
// and the tanks: soldierLooks `appeleLanceFlammes`) and his loader with a rifle.
//
//   THE STREAM     no rounds: combat.js calls the operator's `fireAt` (its own way of firing)
//                  and the stream burns EVERYONE in it for as long as it plays — a narrow
//                  wedge out to its reach (P.range, what the baked stream shows), growing out
//                  of the nozzle as it lights. COVER DOES NOT SHELTER (fire goes round sandbags).
//   CoH            a man in it is PINNED at once, and after P.panic s he BREAKS — runs away
//                  from the flame (no order holds him); men in a HOUSE in it burn and come out
//                  (P.houseOut s): the flamethrower is how you clear a building.
//   IT SETS FIRE   the ground where the stream comes down burns a while (it hurts who stands in
//                  it) and a house's roof catches.
//   THE TANKS      the operator going down may burst them (P.tank.chance): a fireball where he
//                  fell. The CoH risk of carrying one.
//   SEEN           shared flameStreamFx.js: the baked start → loop → stop, along the aim.
//   HEARD          algSounds: the ignition, the roar while it fires, the cut-off.
import * as THREE from "three";
import { FLAME_STREAM, createFlameStreamFx } from "../shared-rts/flameStreamFx.js";

export const FLAMER = {
  range: 15,           // m: the stream's reach (= the unit's range; flameStreamFx shows this)
  ignite: 0.8,         // s: the stream reaches full length (= flameStreamFx `ignite`)
  width: 1.4,          // m either side of the aim at full reach (narrower at the nozzle)
  // 32 killed a file of six in 2.5 s, before any of them could run (battle lab, 2026-10-09):
  // CoH's flamethrower ROUTS more than it wipes. ~4 s in it kills a rifleman (60 hp).
  dps: 14,             // to a man in the stream, a second
  vehicleMul: 0.12,    // armour: a jeep feels it, a tank barely
  structureMul: 0.5,
  suppress: 1.4,       // suppression a second in the stream (pinned in well under a second)
  suppressCap: 1.6,
  panic: 0.5,          // s in the stream before a man breaks and runs
  flee: 14,            // m he runs, away from the nozzle
  houseDps: 20,        // to each man inside a house the stream reaches
  houseOut: 1.2,       // s of that before they come out
  houseR: 5,           // m: a house this near the stream's line is in it
  roofBurn: 25,        // s the roof burns
  groundEvery: 1.1,    // s between new patches of burning ground at the stream's end
  groundR: 1.7, groundLife: 7, groundDps: 9,
  tank: { chance: 0.35, damage: 45, radius: 4.5 },
};

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * @param {object} o
 * @param {object} o.app
 * @param {object} o.units
 * @param {(u:object)=>boolean} o.isFlamer   who carries the lance
 */
export async function createAlgFlamethrowers({ app, units, isFlamer }) {
  const P = FLAMER;
  const state = new Map();     // operator → { since, last, target, groundT, dead }
  const patches = [];          // burning ground: { x, z, r, end, owner }
  const near = [];
  let clock = 0;
  const combat = () => app.algCombat?.combat;
  const fireField = () => app.algCombat?.fire;

  const fx = await createFlameStreamFx({
    // The game's exposure and bloom are not the labs': at the labs' x1 / 0.35 the stream was a
    // white blaze (battle lab, 2026-10-09).
    app, params: { ...FLAME_STREAM, ignite: P.ignite, fireK: 0.45, bloom: 0.12 },
    onState: (u, s) => app.algSounds?.flame?.(s, u),
  }).catch((e) => { console.warn("lance-flammes: no stream books", e); return null; });
  // The damage reaches where the fire does: the stream card is sized to P.range (flameStreamFx).
  if (fx && Math.abs(fx.reach() - P.range) > 1) console.warn(`lance-flammes: the stream shows ${fx.reach().toFixed(1)} m, its reach is ${P.range} m`);

  /** combat.js, in reach of `tgt` and seeing him: the trigger is held. */
  function fireAt(u, tgt) {
    let s = state.get(u);
    if (!s) { s = { since: clock, last: clock, target: tgt, groundT: 0.5 }; state.set(u, s); }
    if (clock - s.last > 0.6) { s.since = clock; s.groundT = 0.5; }   // a fresh burst lights again
    s.last = clock;
    s.target = tgt;
  }
  const firing = (s) => clock - s.last < 0.4;

  // Every lance-carrier fires its own way (combat.js `fireAt`); anyone else as before.
  function arm() {
    for (const u of units.list) {
      if (!u.alive) continue;
      const want = isFlamer(u);
      if (want && !u.fireAt) u.fireAt = (tgt) => fireAt(u, tgt);
      else if (!want && u.fireAt && u._flamerArmed) delete u.fireAt;
      if (want) u._flamerArmed = true;
    }
  }

  const _dir = new THREE.Vector3(), _noz = new THREE.Vector3();
  /** The aim: from the operator to his target, flat (the stream is thrown level). */
  function aim(u, s, out) {
    const t = s.target?.position ?? u.position;
    return out.set(t.x - u.position.x, 0, t.z - u.position.z).normalize();
  }

  function burn(target, amount, owner, at) {
    combat()?.onImpact(target, amount, at ?? target.position, owner);
  }

  /** FIXED-STEP: who the streams burn, who breaks, what catches fire. */
  function step(dt) {
    clock += dt;
    arm();
    for (const [u, s] of state) {
      // THE TANKS: the operator down — the tanks may go up.
      if (!u.alive) {
        if (!s.dead) {
          s.dead = true;
          if (Math.random() < P.tank.chance) {
            const p = u.position;
            combat()?.splashAt?.(p, P.tank.damage, P.tank.radius, u);   // its own blast and crater
            fireField()?.addFire(p.x, p.y + 0.3, p.z, 2.2, 10, { heat: 1 });
          }
        }
        if (clock - s.last > 3) state.delete(u);
        continue;
      }
      if (!firing(s)) continue;
      const reach = P.range * Math.min(1, (clock - s.since) / P.ignite);
      aim(u, s, _dir);
      const ox = u.position.x, oz = u.position.z;

      // THE MEN IN IT: a wedge from the nozzle, narrow at the gun, P.width wide at full reach.
      for (const o of units.near(ox + _dir.x * reach * 0.5, oz + _dir.z * reach * 0.5, reach * 0.5 + P.width + 1, near)) {
        if (!o.alive || o.team === u.team || o.isAir || o.inside) continue;
        const rx = o.position.x - ox, rz = o.position.z - oz;
        const along = rx * _dir.x + rz * _dir.z;
        if (along < 0 || along > reach) continue;
        const side = Math.abs(rx * _dir.z - rz * _dir.x);
        if (side > (o.radius ?? 0.6) + P.width * (0.35 + 0.65 * along / P.range)) continue;
        const foot = !!o.type?.foot;
        burn(o, P.dps * dt * (foot ? 1 : o.isStructure ? P.structureMul : P.vehicleMul), u);
        if (!foot || !o.alive) continue;
        o.firedOnBy = u;
        // Running from it (below): not pinned again — a pinned man only crawls, and the first
        // cut pinned the men it routed: they "ran" at a crawl and burnt (battle lab).
        if (o._fleeing > clock) continue;
        // CoH: pinned at once…
        o.suppression = Math.min(P.suppressCap, (o.suppression ?? 0) + P.suppress * dt);
        // …and after a moment in the fire he breaks and runs from it.
        o._flameT = (o._flameT ?? 0) + dt;
        if (o._flameT >= P.panic && !(o._fleeing > clock)) {
          const k = P.flee / Math.max(1, Math.hypot(rx, rz));
          o.suppression = 0; o.pinned = false; o.suppressed = false;   // fear beats the pin: he RUNS
          o.moveOrder?.(o.position.x + rx * k, o.position.z + rz * k);
          // As a PLAYER's move: combat.js halts a man who has an enemy in reach so he can
          // shoot — a routed man must not stop to (he stood in the fire, "fleeing", and burnt).
          o.playerMove = true;
          o._fleeing = clock + 2.5;
          o._flameT = 0;
        }
      }

      // HOUSES IN IT: the men inside burn, then come out; the roof catches.
      for (const h of app.algGarrison?.houses ?? []) {
        const rx = h.x - ox, rz = h.z - oz, along = rx * _dir.x + rz * _dir.z;
        if (along < 0 || along > reach + P.houseR) continue;
        if (Math.abs(rx * _dir.z - rz * _dir.x) > P.houseR) continue;
        if (!h.roofLit || clock > h.roofLit) {
          h.roofLit = clock + P.roofBurn;
          fireField()?.addFire(h.x, app.getWorldHeight(h.x, h.z) + 3, h.z, 2.6, P.roofBurn, { heat: 1 });
        }
        const foes = h.men.filter((m) => m.alive && m.team !== u.team);
        if (!foes.length) continue;
        h._flameT = (h._flameT ?? 0) + dt;
        for (const m of foes) burn(m, P.houseDps * dt, u);
        if (h._flameT >= P.houseOut) { h._flameT = 0; app.algGarrison.exitAll(foes); }
      }

      // THE GROUND WHERE IT COMES DOWN burns a while.
      if ((s.groundT -= dt) <= 0 && reach > P.range * 0.6) {
        s.groundT = P.groundEvery;
        const gx = ox + _dir.x * reach * 0.92, gz = oz + _dir.z * reach * 0.92;
        fireField()?.addFire(gx, app.getWorldHeight(gx, gz) + 0.3, gz, P.groundR, P.groundLife, { heat: 1 });
        patches.push({ x: gx, z: gz, r: P.groundR * 1.3, end: clock + P.groundLife, owner: u });
      }
    }

    // BURNING GROUND hurts who stands in it (his own side too: it is fire).
    for (let i = patches.length - 1; i >= 0; i--) {
      const f = patches[i];
      if (clock > f.end) { patches.splice(i, 1); continue; }
      for (const o of units.near(f.x, f.z, f.r, near)) {
        if (!o.alive || o.isAir || o.inside || !o.type?.foot) continue;
        if (Math.hypot(o.position.x - f.x, o.position.z - f.z) < f.r) burn(o, P.groundDps * dt, f.owner?.alive ? f.owner : null);
      }
    }
  }

  /** Every rendered frame: the streams, from the operators' guns along their aim. */
  function frame(dt) {
    if (!fx) return;
    const r = app.algUnits?.unitRenderer;
    for (const [u, s] of state) {
      if (!u.alive || !firing(s)) continue;
      const m = r?.muzzleOf?.(u);
      if (m) _noz.copy(m); else _noz.set(u.position.x, u.position.y + 1.05, u.position.z);
      fx.fire(u, _noz, aim(u, s, _dir));
    }
    fx.update(dt, app.camera);
  }

  return {
    params: P, fx,
    step, frame,
    /** Is `u` firing now (its stream lit)? */
    isFiring: (u) => { const s = state.get(u); return !!s && firing(s); },
    clear() { state.clear(); patches.length = 0; fx?.clear(); },
  };
}
