// THE ENGINE MODEL behind the engine sound (user, 2026-10-19: "start with the synthesised engine").
// The car itself has no gearbox — it's a force model. This gives the SOUND an engine: RPM, gear and
// load from the car's real speed and the player's throttle, with automatic shifts (a short throttle
// cut while the clutch is out), wheelspin at launch, free revving in the air, the rev limiter and
// lift-off pops. Pure logic, no audio: a recorded engine pack later reads the same numbers.

/** Gear top speeds (km/h at the redline) → overall ratios, from the car's wheel (carTune). */
export const ENGINE = {
  idle: 950,
  redline: 8200,
  shiftUp: 7850, // with throttle
  shiftDown: 3900,
  shiftTime: 0.13, // s with the drive cut
  gearTopKmh: [72, 112, 150, 188, 228, 268], // 6 gears; 6th tops out past the boosted speed
  wheelRadius: 0.374,
  launchRpm: 4600, // wheelspin floor in 1st with the throttle down
  freeRevUp: 9000, // rpm/s revving in the air / in neutral
  freeRevDown: 5200, // rpm/s falling off the throttle
  follow: 18, // 1/s: how fast RPM follows the wheels (drivetrain lash)
};

export function createEngineModel(cfg = ENGINE) {
  const wheelRpmAt = (kmh) => (kmh / 3.6 / (2 * Math.PI * cfg.wheelRadius)) * 60;
  const ratio = cfg.gearTopKmh.map((k) => cfg.redline / wheelRpmAt(k));
  const s = {
    rpm: cfg.idle,
    gear: 1,
    load: 0, // 0 coasting … 1 full throttle pulling
    shifting: 0, // s left in a shift
    limiter: false,
    pop: 0, // lift-off crackle strength 0..1 (decays)
    lastThrottle: 0,
  };
  return {
    s,
    ratio,
    /**
     * @param dt  s
     * @param kmh  the car's speed along its nose (km/h, ≥ 0)
     * @param throttle  0..1 (the player's accelerator; brakes are 0)
     * @param grounded  wheels on the ground (in the air the engine revs freely)
     */
    update(dt, kmh, throttle, grounded) {
      const thr = Math.max(0, Math.min(1, throttle));
      // GEAR: shift on RPM, only with the wheels down (no shifts mid-air)
      if (grounded && s.shifting <= 0) {
        const wheel = wheelRpmAt(kmh);
        const inGear = wheel * ratio[s.gear - 1];
        if (inGear > cfg.shiftUp && thr > 0.3 && s.gear < ratio.length) { s.gear++; s.shifting = cfg.shiftTime; }
        else if (inGear < cfg.shiftDown && s.gear > 1 && wheel * ratio[s.gear - 2] < cfg.shiftUp * 0.92) { s.gear--; s.shifting = cfg.shiftTime * 0.8; }
      }
      s.shifting = Math.max(0, s.shifting - dt);
      // TARGET RPM
      let target;
      if (!grounded) {
        // in the air the wheels spin free: the throttle revs the engine up to the limiter
        target = thr > 0.2 ? cfg.redline + 200 : Math.max(cfg.idle, s.rpm - cfg.freeRevDown * dt);
        const rate = thr > 0.2 ? cfg.freeRevUp : cfg.freeRevDown;
        s.rpm += Math.max(-rate * dt, Math.min(rate * dt, target - s.rpm));
      } else {
        target = wheelRpmAt(kmh) * ratio[s.gear - 1];
        if (s.gear === 1 && thr > 0.5) target = Math.max(target, cfg.launchRpm); // launch wheelspin
        target = Math.max(cfg.idle, target);
        if (s.shifting > 0) target = Math.min(target, s.rpm); // the clutch is out: no climbing
        s.rpm += (target - s.rpm) * (1 - Math.exp(-dt * cfg.follow));
      }
      // LIMITER: past the redline the ignition cuts in bursts (the "bap-bap-bap")
      s.limiter = s.rpm >= cfg.redline - 20 && thr > 0.2;
      s.rpm = Math.min(s.rpm, cfg.redline + 60);
      // LOAD: pulling with the throttle (cut during a shift)
      const wantLoad = s.shifting > 0 ? 0 : thr;
      s.load += (wantLoad - s.load) * (1 - Math.exp(-dt * 14));
      // LIFT-OFF POPS: lifting the throttle at high revs (and right after a shift up)
      if (s.lastThrottle > 0.6 && thr < 0.2 && s.rpm > 4800) s.pop = 1;
      s.pop = Math.max(0, s.pop - dt * 1.6);
      s.lastThrottle = thr;
      return s;
    },
    reset() { s.rpm = cfg.idle; s.gear = 1; s.load = 0; s.shifting = 0; s.limiter = false; s.pop = 0; },
  };
}
