/**
 * A fixed-timestep clock for the simulation.
 *
 * WHY THE SIM MUST NOT STEP ON RENDER dt
 *
 * Everything that decides an OUTCOME — how fast a unit walks, when a weapon
 * comes off cooldown, when a building finishes, when a wave spawns — was being
 * advanced by however long the last frame happened to take. That makes the game
 * behave differently on a 144 Hz monitor than a 60 Hz one, and differently again
 * across a hitch. It is the same bug the RTS camera had (pan and rotation were
 * per FRAME, not per second), and it survives for the same reason: it is
 * invisible on the machine it was written on, where dt is always 1/60.
 *
 * So the sim advances in whole steps of a fixed size and the renderer runs as
 * often as it likes. A frame hands over its real dt; this decides how many sim
 * steps that buys.
 *
 * THE SPIRAL, which is the one thing a naive accumulator gets wrong: if a frame
 * takes long enough to owe several steps, and running those steps takes longer
 * than a frame, the next frame owes more still, and the game walks itself into
 * a freeze it cannot leave. Two guards, because they catch different things:
 *
 *   maxFrame  clamps the dt going IN. A tab restore or a shader compile can
 *             hand over whole seconds; without this the accumulator would try
 *             to replay all of it.
 *   maxSteps  caps the steps coming OUT, and DROPS the remainder rather than
 *             carrying it. Carrying it is the spiral. Dropping it means the
 *             world briefly runs slow, which is survivable; the freeze is not.
 *
 * 60 Hz deliberately, matching the display: the sim then runs one step per
 * frame in the normal case, so no interpolation is needed. A cheaper 30 Hz sim
 * would want the renderer to interpolate between the last two states, which is
 * a bigger change and buys nothing while there is ~13 ms of CPU headroom
 * (MEASURED: 60 FPS holds through +12 ms of injected per-frame work).
 */

/**
 * @param {object} [o]
 *   hz        sim steps per second (default 60)
 *   maxSteps  most steps one frame may run before the rest is dropped
 *   maxFrame  seconds; the largest dt allowed to enter the accumulator
 */
export function createSimClock({ hz = 60, maxSteps = 5, maxFrame = 0.25 } = {}) {
  const dtStep = 1 / hz;
  let acc = 0;
  let steps = 0;      // steps run on the last advance()
  let dropped = 0;    // times the cap has fired, ever — a hitch counter
  let simTime = 0;    // seconds of SIMULATED time, which is not wall time

  return {
    get stepSeconds() { return dtStep; },
    get simTime() { return simTime; },
    /** Steps run on the most recent advance() — 0 is normal and not an error. */
    get lastSteps() { return steps; },
    /** How many times maxSteps has clamped. Non-zero means the game hitched. */
    get droppedFrames() { return dropped; },

    /**
     * Run `step(dtStep)` as many whole steps as `dt` has bought.
     * @param {number} dt seconds since the last frame
     * @param {(dtStep: number) => void} step
     * @returns {number} steps run
     */
    advance(dt, step) {
      acc += Math.min(Number.isFinite(dt) && dt > 0 ? dt : 0, maxFrame);
      steps = 0;
      while (acc >= dtStep && steps < maxSteps) {
        step(dtStep);
        simTime += dtStep;
        acc -= dtStep;
        steps++;
      }
      // Hit the cap and still owe time: drop it. See the spiral note above.
      if (steps === maxSteps && acc >= dtStep) {
        acc = 0;
        dropped++;
      }
      return steps;
    },

    /** After a load or a mode switch, so buffered time is not replayed. */
    reset() {
      acc = 0;
      steps = 0;
    },
  };
}
