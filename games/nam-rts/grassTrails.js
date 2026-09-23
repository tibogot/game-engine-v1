// GRASS TRAILS — the grass bends where your men and vehicles have walked.
//
// The engine already has the field (v3/render/grass/grassPushField.js, reached
// through app.stampGrassPush): a 256² map over 64 m round the camera, with its
// own recovery rate, into which anything can stamp a push. Nothing in this
// game was stamping into it, so the grass stood up through the tracks of a
// tank. This wires the units in.
//
// WHAT KEEPS IT CHEAP, which is the condition it was asked for under:
//
//   · ONLY WHAT IS IN THE FIELD. The push field only covers ~32 m round the
//     camera's focus, so a unit outside that is skipped before anything else
//     is computed — in a battle across the map that is nearly all of them.
//   · ONLY GROUND UNITS. A helicopter at 24 m bends nothing.
//   · A BUDGET. At most `maxStamps` a frame, nearest first, so a hundred men
//     in one place cost the same as sixteen.
//   · The field itself already skips work when a still object's stamps have
//     not changed, so a parked column is free after the first frame.
//
// It runs on the RENDER step, not the sim: a trail is a visual, and stamping
// it at a fixed 60 Hz while the renderer runs at another rate would make the
// trail's length depend on the frame rate.
import * as THREE from "three";

export const GRASS_TRAILS = {
  /** Metres from the camera's focus that are worth stamping (the field is ~32). */
  range: 34,
  /** Most stamps in one frame; the nearest units win. */
  maxStamps: 16,
  /** How wide each kind of thing presses, in metres. */
  footRadius: 1.1,
  vehicleRadius: 2.6,
  strength: 0.85,
};

/**
 * `app.stampGrassPush(x, z, radius, strength, dirX, dirZ)` per pusher per
 * frame. `units` is the unit manager; `focus` returns the point the camera is
 * looking at (the push field is built round it).
 */
export function createGrassTrails({ app, units, focus, params = GRASS_TRAILS }) {
  let enabled = true;
  let lastStamps = 0;
  const near = [];
  const _v = new THREE.Vector3();

  function step() {
    if (!enabled || !app?.stampGrassPush) { lastStamps = 0; return 0; }
    const f = focus?.();
    if (!f) return 0;
    // The unit manager's spatial grid does the "who is near" question in one
    // call — this is the same query combat uses, not a scan of every unit.
    const list = units.near?.(f.x, f.z, params.range, near) ?? units.list;
    let n = 0;
    // Nearest first, so the budget spends itself where the player is looking.
    if (list.length > params.maxStamps) {
      list.sort((a, b) => (
        (a.position.x - f.x) ** 2 + (a.position.z - f.z) ** 2
        - ((b.position.x - f.x) ** 2 + (b.position.z - f.z) ** 2)
      ));
    }
    for (const u of list) {
      if (n >= params.maxStamps) break;
      if (!u.alive || u.isAir) continue;
      const foot = u.typeKey === "soldier";
      const r = foot ? params.footRadius : params.vehicleRadius;
      // Direction only while moving: a standing man flattens the grass under
      // him, he does not comb it (grassPushField leans the blades along dir).
      const moving = u.isMoving === true;
      const dx = moving ? Math.sin(u.heading ?? 0) : 0;
      const dz = moving ? Math.cos(u.heading ?? 0) : 0;
      app.stampGrassPush(u.position.x, u.position.z, r, params.strength, dx, dz);
      n++;
    }
    lastStamps = n;
    return n;
  }

  return {
    step,
    /** What the last frame actually stamped — the dev panel shows it. */
    get lastStamps() { return lastStamps; },
    get enabled() { return enabled; },
    setEnabled(on) { enabled = !!on; },
    params,
  };
}
