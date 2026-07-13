// RTS unit LOGIC — GAME code. Deliberately contains NO three.js meshes.
//
// A unit here is plain data + behaviour: position, heading, hp, orders,
// pathfinding, local avoidance. unitRenderer.js turns that data into visuals.
//
// Why the split: rendering one clone per unit is fine for dozens of units, but
// hundreds needs InstancedMesh. Keeping logic mesh-free means that jump is a
// swap of the RENDER layer only — combat, orders and AI written against this
// data survive untouched.
//
// ── Why units don't deadlock ────────────────────────────────────────────────
// Push-apart separation ALONE cannot solve head-on conflicts: two units facing
// each other push symmetrically, both keep driving, neither yields — they grind
// forever (and, if heading is taken from "direction to target", they slowly spin
// on the spot). Real RTS engines solve this with LOCAL AVOIDANCE, so we do too:
//
//   1. AVOIDANCE STEERING — a unit steers around neighbours that are ahead of
//      it, instead of ramming them.
//   2. SYMMETRY BREAKING — in a head-on, both units pass on their RIGHT (a
//      traffic rule). Mirrored units then step to opposite sides of the world
//      and slide past, instead of mirroring each other into a lock.
//   3. HEADING FROM ACTUAL MOTION — a unit only turns when it really moved, so
//      a blocked unit can never spin like a top.
//   4. STUCK ESCAPE — if a unit makes no progress for a moment, it sidesteps
//      hard for a beat to break any remaining tangle.
//   5. SEPARATION stays, but only as a last-resort overlap fix, not the plan.
import * as THREE from "three";
import { UNIT_TYPES, UNIT_TYPE_KEYS } from "./unitTypes.js";

/** Shortest-way angular step from a → b, clamped to maxStep. */
function turnToward(a, b, maxStep) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + THREE.MathUtils.clamp(d, -maxStep, maxStep);
}

function makeUnit(app, type, navGrid, x, z, getUnits) {
  const pos = new THREE.Vector3(x, 0, z);
  const target = new THREE.Vector3(x, 0, z);
  const waypoints = [];
  // `arrived` — reached the destination and now just holding station.
  // Air units never use waypoints, so "no waypoints" is NOT a usable stand-in:
  // treating it as arrived made every separation nudge cancel a heli's order.
  let arrived = true;
  let heading = 0;
  let stuckT = 0;             // seconds without a NEW closest-distance to the waypoint
  let bestTgtDist = Infinity; // closest we've ever been to the current waypoint
  let escapeT = 0;   // seconds left of the "sidestep hard" escape
  let reverseT = 0;  // seconds left of backing up
  let phaseT = 0;    // seconds left of "phase through friendlies" (unit.ghost)
  let repathCd = 0;  // cooldown so a jammed unit doesn't re-run A* every frame
  let escalation = 0;     // which rung the NEXT intervention uses (0 = gentlest)
  let sinceIntervene = 9; // seconds since the last intervention (big = calm)
  // The ORDERED destination, kept separate from `target` (the current waypoint).
  // Needed to re-plan from wherever the unit actually ended up.
  const goal = new THREE.Vector3(x, 0, z);
  let hasGoal = false;

  const groundAt = (gx, gz) => (app.getWorldHeight ? app.getWorldHeight(gx, gz) : 0);
  const blocked = (bx, bz) => !type.isAir && !!navGrid?.isBlockedAtWorld(bx, bz);
  const inBlocked = () => blocked(pos.x, pos.z);

  /** Move to (nx,nz), sliding along terrain obstacles rather than stopping dead. */
  function tryMove(nx, nz) {
    // If we're ALREADY inside blocked terrain, allow any move — otherwise the
    // unit can never climb out, because every neighbouring cell is blocked too
    // and each candidate move gets rejected. That's a permanent freeze.
    if (inBlocked()) { pos.x = nx; pos.z = nz; return; }
    if (!blocked(nx, nz)) { pos.x = nx; pos.z = nz; return; }
    if (!blocked(nx, pos.z)) { pos.x = nx; return; }
    if (!blocked(pos.x, nz)) { pos.z = nz; return; }
  }

  /**
   * Steer around neighbours that lie ahead. Returns a lateral vector to add to
   * the desired direction. The head-on case is forced to ONE side so mirrored
   * units break symmetry instead of locking.
   */
  function avoidance(dirX, dirZ) {
    const units = getUnits();
    const look = type.radius * 5;
    let ax = 0, az = 0;
    // "Right" of our heading, on the ground plane.
    const px = dirZ, pz = -dirX;

    if (unit.ghost) return { x: 0, z: 0 }; // phasing through — steer for nobody
    for (const other of units) {
      if (other === unit || other.isAir !== type.isAir || other.ghost) continue;
      const ox = other.position.x - pos.x;
      const oz = other.position.z - pos.z;
      const dist = Math.hypot(ox, oz);
      if (dist > look || dist < 1e-4) continue;

      // Only care about units roughly in front of us.
      const ahead = (ox * dirX + oz * dirZ) / dist;
      if (ahead < 0.2) continue;

      const minD = type.radius + other.radius;
      const side = ox * px + oz * pz; // >0 → they're on our right

      let sgn;
      if (Math.abs(side) < minD * 0.4) {
        // Nearly head-on: no meaningful side. Both units pass on their own
        // RIGHT — because they face opposite ways, that sends them to opposite
        // sides of the world and they slide past instead of deadlocking.
        sgn = 1;
      } else {
        sgn = side > 0 ? -1 : 1; // steer away from whichever side they're on
      }

      // Formation-mates moving the SAME direction get gentle avoidance only.
      // Full-strength steering around a mover just ahead makes a group weave
      // and stall against itself (the downhill formation jitter). Stationary
      // or oncoming units keep the full push — those are real conflicts.
      let w = 1;
      if (other.isMoving) {
        const same = Math.sin(other.heading) * dirX + Math.cos(other.heading) * dirZ;
        if (same > 0.5) w = 0.25;
      }

      const strength = (1 - dist / look) * ahead * w;
      ax += px * sgn * strength;
      az += pz * sgn * strength;
    }
    // CLAMP the total. Summed over several neighbours this can grow large; if it
    // overpowers the forward direction the unit's velocity flips BACKWARD, then
    // forward again next frame — that's the forward/back jitter. Capping it below
    // 1 guarantees `normalize(forward + steer)` always keeps a forward component.
    const AV_MAX = 0.75;
    const len = Math.hypot(ax, az);
    if (len > AV_MAX) { ax = (ax / len) * AV_MAX; az = (az / len) * AV_MAX; }
    return { x: ax, z: az };
  }

  const unit = {
    kind: "unit",
    type,
    typeKey: type.typeKey,
    name: type.name,
    team: "player",
    isAir: !!type.isAir,
    isStructure: false,
    radius: type.radius,
    maxHp: type.maxHp,
    hp: type.maxHp,
    alive: true,
    speedScale: 1,
    selected: false,
    // ── combat (driven by combat.js) ──────────────────────────────────────────
    range: type.range ?? 0,
    damage: type.damage ?? 0,
    fireRate: type.fireRate ?? 1,
    canHitAir: !!type.canHitAir,
    cooldown: 0,
    chaseCd: 0,
    target: null,        // auto-acquired
    attackTarget: null,  // explicitly ordered (takes priority)

    /** Explicit attack order (right-click an enemy). */
    attack(enemy) { unit.attackTarget = enemy; unit.chaseCd = 0; },
    // While `ghost` is on, the unit ignores (and is ignored by) friendly
    // collision — the last rung of the unstick ladder.
    ghost: false,
    get position() { return pos; },
    get heading() { return heading; },
    get isMoving() { return !arrived; },

    setSelected(v) { unit.selected = !!v; },

    moveTo(tx, tz) {
      waypoints.length = 0; target.set(tx, 0, tz);
      goal.set(tx, 0, tz); hasGoal = true;
      arrived = false; stuckT = 0; bestTgtDist = Infinity; escalation = 0;
    },
    /** Stop moving but KEEP any attack order — used once we're in firing range. */
    haltMovement() {
      waypoints.length = 0; target.copy(pos);
      hasGoal = false; arrived = true;
      stuckT = 0; escapeT = 0; reverseT = 0; bestTgtDist = Infinity; escalation = 0;
    },

    /** Full stop: halt AND forget what we were attacking. */
    stop() {
      unit.haltMovement();
      unit.attackTarget = null;
    },

    /**
     * Player MOVE order — cancels any attack. (combat.js chases with orderTo(),
     * which must NOT clear the attack target, hence the separate entry point.)
     */
    moveOrder(tx, tz) {
      unit.attackTarget = null;
      unit.target = null;
      unit.orderTo(tx, tz);
    },

    takeDamage(n) {
      if (!unit.alive) return;
      unit.hp -= n;
      if (unit.hp <= 0) { unit.hp = 0; unit.alive = false; }
    },

    orderTo(tx, tz) {
      if (type.isAir || !navGrid) { unit.moveTo(tx, tz); return; }
      goal.set(tx, 0, tz); hasGoal = true;
      const path = navGrid.findPath(pos.x, pos.z, tx, tz);
      if (path?.length) {
        waypoints.length = 0; waypoints.push(...path);
        arrived = false; stuckT = 0; repathCd = 0; bestTgtDist = Infinity; escalation = 0;
      }
      // else: no route — hold rather than drive through the obstacle.
    },

    /**
     * Overlap fix (separation pass). Never turns the unit.
     * Returns TRUE if it actually moved — the caller needs to know, because a
     * nudge that silently fails (blocked terrain) leaves units interpenetrating
     * with no way out.
     */
    nudge(dx, dz) {
      let nx = pos.x + dx, nz = pos.z + dz;
      if (blocked(nx, nz)) {
        if (!blocked(pos.x + dx, pos.z)) { nx = pos.x + dx; nz = pos.z; }
        else if (!blocked(pos.x, pos.z + dz)) { nx = pos.x; nz = pos.z + dz; }
        else return false;
      }
      pos.x = nx; pos.z = nz;
      // Only an ARRIVED unit carries its hold-point along. A unit still
      // travelling must keep its destination, or the nudge cancels its order.
      if (arrived) target.copy(pos);
      return true;
    },

    /**
     * Force the unit out of an overlap even into blocked terrain. Overlap MUST
     * always be resolvable; the escape-blocked-terrain step will walk it back
     * to open ground next frame. Being briefly on a bad cell beats being stuck
     * inside another unit forever.
     */
    forceNudge(dx, dz) {
      pos.x += dx; pos.z += dz;
      if (arrived) target.copy(pos);
    },

    /** Debug snapshot — used by the dev panel to see why a unit is stuck. */
    debugState() {
      return {
        name: type.typeKey,
        arrived, ghost: unit.ghost,
        stuck: +stuckT.toFixed(2),
        distToTgt: +Math.hypot(target.x - pos.x, target.z - pos.z).toFixed(1),
        distToGoal: hasGoal ? +Math.hypot(goal.x - pos.x, goal.z - pos.z).toFixed(1) : null,
        waypoints: waypoints.length,
        reversing: reverseT > 0,
        escalation,
        inBlocked: inBlocked(),
        pos: [Math.round(pos.x), Math.round(pos.z)],
      };
    },

    update(dt) {
      const prevX = pos.x, prevZ = pos.z;
      if (repathCd > 0) repathCd -= dt;
      sinceIntervene += dt;

      // ── Escape blocked terrain ────────────────────────────────────────────
      // If a unit somehow ends up inside a blocked cell (shoved to a boundary,
      // terrain re-baked under it, wedged in a rocky gap), getting OUT beats any
      // other order. Without this it would sit there forever: every move it
      // wants to make is into blocked ground, so it never moves and never
      // re-plans.
      if (!type.isAir && navGrid && inBlocked()) {
        const open = navGrid.nearestOpenWorld(pos.x, pos.z);
        const ex = open.x - pos.x, ez = open.z - pos.z;
        const el = Math.hypot(ex, ez);
        if (el > 1e-3) {
          const step = Math.min(type.speed * unit.speedScale * dt, el);
          pos.x += (ex / el) * step;
          pos.z += (ez / el) * step;
          heading = turnToward(heading, Math.atan2(ex, ez), (type.turnRate ?? 3) * dt);
        }
        // Re-plan from the open ground we're heading to.
        if (hasGoal && repathCd <= 0) {
          const path = navGrid.findPath(pos.x, pos.z, goal.x, goal.z);
          if (path?.length) { waypoints.length = 0; waypoints.push(...path); arrived = false; }
          repathCd = 0.5;
        }
        pos.y = groundAt(pos.x, pos.z) + (type.hover ?? 0);
        return;
      }

      // Advance through reached waypoints; steer toward the next.
      while (waypoints.length) {
        const wp = waypoints[0];
        const arrive = waypoints.length > 1 ? Math.max(2, type.speed * dt * 1.5) : 0.6;
        if (Math.hypot(wp.x - pos.x, wp.z - pos.z) <= arrive) {
          waypoints.shift();
          stuckT = 0; bestTgtDist = Infinity; // new waypoint → fresh progress window
        } else { target.set(wp.x, 0, wp.z); break; }
      }

      // LOOKAHEAD: if we can already walk straight to the waypoint AFTER the
      // current one, drop the current one. This kills two real misbehaviours:
      //   • a fresh path's first point is the CURRENT CELL'S CENTRE — often a
      //     few metres BEHIND the unit, so after every repath the unit briefly
      //     drove backward to touch it (the forward/back jitter on open ground);
      //   • cell-centre zig-zags on otherwise straight runs.
      let skips = 2; // capped — LOS marches the grid, keep it cheap per frame
      while (skips-- > 0 && waypoints.length > 1 && navGrid?.hasLOS?.(
        pos.x, pos.z, waypoints[1].x, waypoints[1].z,
      )) {
        waypoints.shift();
        target.set(waypoints[0].x, 0, waypoints[0].z);
        stuckT = 0; bestTgtDist = Infinity;
      }

      const dx = target.x - pos.x, dz = target.z - pos.z;
      const dh = Math.hypot(dx, dz);

      if (dh > 0.4) {
        let dirX = dx / dh, dirZ = dz / dh;

        if (reverseT > 0) {
          // Backing up: drive straight back the way we're facing. Creates the
          // space a head-on jam needs, and is how a real vehicle un-wedges.
          reverseT -= dt;
          dirX = -Math.sin(heading);
          dirZ = -Math.cos(heading);
          // Fresh start when the manoeuvre ends, so we don't instantly re-judge
          // the unit as stuck off the back of its own reversing.
          if (reverseT <= 0) { stuckT = 0; bestTgtDist = Infinity; }
        } else {
          // Steer around neighbours rather than into them. `av` is already
          // clamped < 1, so adding it to the unit-length forward direction can
          // never point the unit backward.
          const av = avoidance(dirX, dirZ);
          dirX += av.x;
          dirZ += av.z;

          // Still jammed? Sidestep hard for a beat to break the tangle.
          if (escapeT > 0) {
            escapeT -= dt;
            dirX += dz / dh;   // perpendicular of the goal direction (right)
            dirZ += -dx / dh;
          }
        }

        const len = Math.hypot(dirX, dirZ) || 1;
        dirX /= len; dirZ /= len;

        const step = Math.min(type.speed * unit.speedScale * dt, dh);
        tryMove(pos.x + dirX * step, pos.z + dirZ * step);
        arrived = false;
      } else if (!waypoints.length) {
        arrived = true;
        stuckT = 0; escapeT = 0; reverseT = 0; unit.ghost = false; escalation = 0;
      }

      // ── Heading from ACTUAL motion ────────────────────────────────────────
      // Never from "direction to target": a blocked unit would keep turning and
      // spin on the spot. If we didn't really move, we don't really turn.
      const movedX = pos.x - prevX, movedZ = pos.z - prevZ;
      const moved = Math.hypot(movedX, movedZ);
      // While reversing, keep facing forward — a vehicle backing up doesn't spin
      // around to look where it's going.
      if (moved > 1e-3 && reverseT <= 0) {
        heading = turnToward(heading, Math.atan2(movedX, movedZ), (type.turnRate ?? 3) * dt);
      }

      // ── Unstick ladder ────────────────────────────────────────────────────
      // Escalates so a unit can NEVER be permanently stuck. `stuckT` is only
      // reset by genuine movement, so each rung is actually reached.
      if (unit.ghost && phaseT > 0) { phaseT -= dt; if (phaseT <= 0) unit.ghost = false; }

      if (!arrived) {
        // PROGRESS = "have we gotten CLOSER to the waypoint than ever before?"
        // Per-frame closing-speed checks were too twitchy: group avoidance
        // legitimately deflects a moving unit sideways for a second or two, its
        // per-frame progress dips, and the ladder fired repath/sidestep/reverse
        // on a unit that was flowing normally around a neighbour — that was the
        // downhill formation jitter. Best-distance asks only whether the detour
        // EVENTUALLY pays off; it tolerates lateral flow but still catches
        // orbiting, head-on grinds and dead ends (distance never improves in
        // any of those).
        const distToTgt = Math.hypot(target.x - pos.x, target.z - pos.z);
        if (reverseT > 0 || escapeT > 0) {
          stuckT = 0; // deliberately not progressing — don't judge mid-manoeuvre
        } else if (distToTgt < bestTgtDist - 0.35) {
          bestTgtDist = distToTgt;
          stuckT = 0;
        } else {
          stuckT += dt;
        }

        const distToGoal = hasGoal ? Math.hypot(goal.x - pos.x, goal.z - pos.z) : Infinity;

        // ARRIVAL TOLERANCE — a group ordered to one spot has several units
        // aiming at the same open cell; only one can stand there. If we're
        // jammed but already near enough, we're there.
        const slack = type.radius * 3.5 + 2;
        if (stuckT > 0.5 && distToGoal < slack) {
          unit.stop();
        } else if (stuckT > 0.9) {
          // ── Escalating interventions ──────────────────────────────────────
          // One intervention per 0.9 s window of zero progress, each with a
          // fresh window afterwards. The rung only ESCALATES when the previous
          // intervention just failed (re-trigger within 4 s); after a calm
          // stretch we restart at the gentlest rung. Threshold-chains couldn't
          // express this: either the low rung matched forever, or rungs fired
          // off the back of each other's own non-progress.
          stuckT = 0; bestTgtDist = Infinity;
          escalation = sinceIntervene < 4 ? Math.min(escalation + 1, 4) : 0;
          sinceIntervene = 0;

          const canRepath = !type.isAir && navGrid && hasGoal && repathCd <= 0;
          switch (escalation) {
            case 0:
              if (canRepath) {
                const path = navGrid.findPath(pos.x, pos.z, goal.x, goal.z);
                if (path?.length) { waypoints.length = 0; waypoints.push(...path); }
                else unit.stop();          // genuinely unreachable — don't grind
                repathCd = 0.8;
              } else {
                escalation = 1;            // air units skip repath — start here
                escapeT = 0.5;
              }
              break;
            case 1: escapeT = 0.5; break;                    // sidestep
            case 2: reverseT = 0.5; break;                   // back up, make room
            case 3: unit.ghost = true; phaseT = 1.5; break;  // phase through
            default: unit.stop(); break;                     // give up, don't grind
          }
        }
      }

      // Ground height; air units ride above the water surface too.
      let surf = groundAt(pos.x, pos.z);
      if (type.isAir && app.getWaterLevelAt) {
        const wl = app.getWaterLevelAt(pos.x, pos.z);
        if (wl > surf) surf = wl;
      }
      pos.y = surf + (type.hover ?? 0);
    },
  };
  return unit;
}

export function createUnits({ app, navGrid, spawn = { jeep: 8, helicopter: 4, soldier: 6 } } = {}) {
  const units = [];
  const getUnits = () => units;
  const origins = {
    jeep: { x: 26, z: 0 },
    helicopter: { x: -26, z: 0 },
    soldier: { x: 0, z: 30 },
  };

  for (const key of UNIT_TYPE_KEYS) {
    const type = UNIT_TYPES[key];
    const n = spawn[key] ?? 0;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    const gap = type.radius * 3.2;
    for (let i = 0; i < n; i++) {
      const gx = (i % cols) - (cols - 1) / 2;
      const gz = Math.floor(i / cols) - (cols - 1) / 2;
      let x = origins[key].x + gx * gap;
      let z = origins[key].z + gz * gap;
      // Ground units must not spawn in a lake or on a cliff.
      if (!type.isAir && navGrid) ({ x, z } = navGrid.nearestOpenWorld(x, z));
      units.push(makeUnit(app, type, navGrid, x, z, getUnits));
    }
  }

  // ── Separation ──────────────────────────────────────────────────────────────
  // A LAST-RESORT overlap fix, not the collision plan — avoidance steering above
  // is what actually keeps units apart. O(n²) is fine for dozens; swap in a
  // spatial hash before this reaches hundreds.
  const SEP_PASSES = 2;
  function separate() {
    for (let pass = 0; pass < SEP_PASSES; pass++) {
      for (let i = 0; i < units.length; i++) {
        const a = units[i];
        if (a.ghost || !a.alive) continue; // phasing through a tangle / dead
        for (let j = i + 1; j < units.length; j++) {
          const b = units[j];
          if (a.isAir !== b.isAir || b.ghost || !b.alive) continue; // air flies over ground
          let dx = b.position.x - a.position.x;
          let dz = b.position.z - a.position.z;
          const minD = a.radius + b.radius;
          let d2 = dx * dx + dz * dz;
          if (d2 >= minD * minD) continue;

          let d = Math.sqrt(d2);
          if (d < 1e-4) {
            // Exactly coincident: no axis to push along. Pick a deterministic
            // direction so they still separate — skipping this case is what let
            // units lock together permanently.
            const ang = (i * 2.399963 + j * 0.7) % (Math.PI * 2);
            dx = Math.cos(ang); dz = Math.sin(ang); d = 1;
          }
          const push = (minD - d) * 0.5 + 0.01;
          const nx = dx / d, nz = dz / d;

          const movedA = a.nudge(-nx * push, -nz * push);
          const movedB = b.nudge(nx * push, nz * push);

          // A nudge can FAIL (blocked terrain). If it silently fails for both,
          // the units stay interpenetrating with no way out — which is exactly
          // how they locked together on rocky ground. Overlap must ALWAYS be
          // resolvable, so: give the whole push to whoever can take it, and if
          // neither can, force it. The escape-blocked-terrain step walks the
          // forced unit back to open ground next frame.
          if (movedA && !movedB) a.nudge(-nx * push, -nz * push);
          else if (movedB && !movedA) b.nudge(nx * push, nz * push);
          else if (!movedA && !movedB) {
            a.forceNudge(-nx * push, -nz * push);
            b.forceNudge(nx * push, nz * push);
          }
        }
      }
    }
  }

  // The renderer subscribes so units built at runtime get their visuals.
  let onSpawn = () => {};

  return {
    list: units,
    /** Called by unitRenderer so it can build a view for runtime-spawned units. */
    setOnSpawn(fn) { onSpawn = fn ?? (() => {}); },

    /** Build a new unit at runtime (base production). */
    spawn(typeKey, x, z) {
      const type = UNIT_TYPES[typeKey];
      if (!type) return null;
      let px = x, pz = z;
      if (!type.isAir && navGrid) ({ x: px, z: pz } = navGrid.nearestOpenWorld(x, z));
      const u = makeUnit(app, type, navGrid, px, pz, getUnits);
      units.push(u);
      onSpawn(u);
      return u;
    },

    /** Driven by the single game loop in rtsGame.js. */
    update(dt) {
      for (const u of units) if (u.alive) u.update(dt);
      separate();
    },
    setSpeedScale(s) { for (const u of units) u.speedScale = s; },
    get alive() { return units.filter((u) => u.alive); },
  };
}
