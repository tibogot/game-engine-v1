// QUEUED ORDERS (2026-10-22, Company of Heroes' Shift — you: "do 1 and 2 together"). Shift + right-click ADDS an order
// to the end of each selected unit's list instead of replacing what it is doing: here, then there, then attack that.
// GAME-AGNOSTIC: the selection (selection.js) queues, the game's fixed step runs stepOrderQueues.
//
//   u.orderQueue   the orders still to come: { kind: "move", x, z, face } (his own spot in the squad's formation and
//                  the order's facing, worked out when it was given) | { kind: "attack", target }
//   u._qCur        the queued order under way, and how long it has run
// A queued order starts when the one before it is DONE: a move when he has stopped on his spot, an attack when the
// target is dead (or he was given another). Any order NOT queued (a plain right-click, Halt, an ability's walk)
// drops the list (units.js dropQueue); the runner marks its own orders (_qRunning) so they do not.

/** Add `entry` to the end of `u`'s queued orders. */
export function queueOrder(u, entry) {
  (u.orderQueue ??= []).push(entry);
}

/** The fixed step: each unit with a queue goes on to its next order when the current one is done. */
export function stepOrderQueues(units, dt) {
  for (const u of units.list) {
    if (!u.orderQueue?.length && !u._qCur) continue;
    if (!u.alive) { u.orderQueue = null; u._qCur = null; continue; }
    const c = u._qCur;
    if (c) {
      c.t += dt;
      const done = c.kind === "move" ? c.t > 0.5 && !u.isMoving
        : c.kind === "attack" ? !c.target?.alive || (c.t > 0.5 && u.attackTarget !== c.target)
          : true;
      if (!done) continue;
      u._qCur = null;
    } else if (u.isMoving || u.attackTarget?.alive) continue;   // (the order he had before the first Shift: let it finish)
    const e = u.orderQueue?.shift();
    if (!u.orderQueue?.length) u.orderQueue = null;
    if (!e) continue;
    if (e.kind === "attack" && !e.target?.alive) continue;   // (killed meanwhile: on to the next, next tick)
    u._qRunning = true;
    if (e.kind === "move") {
      u.moveOrder(e.x, e.z);
      if (e.face != null && !u.isAir) u.faceAngle = e.face;
    } else if (e.kind === "attack") {
      u.holdFire = false;
      u.attack(e.target);
    }
    u._qRunning = false;
    u._qCur = { ...e, t: 0 };
  }
}

/** Where each unit's queue goes, for the waypoint marks: [{ x, z, kind }] per unit (the order under way first). */
export function queuedPoints(u) {
  const out = [];
  const at = (e) => (e.kind === "attack" ? (e.target?.alive ? { x: e.target.position.x, z: e.target.position.z, kind: "attack" } : null) : { x: e.x, z: e.z, kind: e.kind });
  if (u._qCur) { const p = at(u._qCur); if (p) out.push(p); }
  for (const e of u.orderQueue ?? []) { const p = at(e); if (p) out.push(p); }
  return out;
}
