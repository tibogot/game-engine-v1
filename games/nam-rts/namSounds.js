// What the war SOUNDS like — GAME code, nam-rts only. namAudio.js is the
// mixer (voices, distance, loops); this file decides which game event makes
// which sound, and at what weight.
//
//   shots        projectiles.js tells `sfx` every shot: a rifle is an M16 for
//                you and an AK for the Front (the two are told apart by ear
//                in every Vietnam film); an MG, a tank gun, the gunship's
//                minigun and its rockets are their own.
//   impacts      rounds landing near the camera: a soft thud, quiet — the gun
//                is the event, the dirt is texture.
//   explosions   fx.explosion, weighted by its size; far away it becomes a
//                different recording (a crack becomes a rumble). A man going
//                down (the "dust" puff) makes no bang.
//   mortars      the whistle on the way down, ending as it lands.
//   napalm       the big fireball of each splash.
//   loops        Hueys (rotor), moving vehicles (engine), fire, a building
//                going up (hammering) and the jungle under everything.
//   ui/radio     button clicks; a radio squelch when you give an order.
//
// Every choice of recording lives in public/sounds/nam/manifest.json and is
// swappable live in Dev → SOUND.
import { createNamAudio } from "./namAudio.js";

const TANKS = new Set(["tank", "bigtank", "lightTank", "pt76"]);

export function createNamSounds({ app, rtsCamera, units, buildings = null, fx, fire = null, fireballs = null, smoke = null, birds = null }) {
  const audio = createNamAudio({ app, getView: () => rtsCamera.getView?.() });

  // ── Shots ─────────────────────────────────────────────────────────────────
  const sfx = {
    shot(owner, w, at) {
      const key = owner?.weapon ?? "rifle";
      const slot = key === "rifle" ? (owner?.team === "enemy" ? "ak" : "rifle")
        : key === "gunship" ? "minigun" : key;   // mg, cannon
      audio.play(slot, at.x, at.y, at.z);
    },
    rocket(at) { audio.play("rocket", at.x, at.y, at.z); },
    impact(at) { audio.play("impact", at.x, at.y, at.z); },
    /** A shell comes down in `left` seconds: the whistle is timed to end then. */
    incoming(at, left) {
      const S = audio.slots.incoming;
      const f = S?.files[S.use?.[0] ?? 0];
      const len = f ? (f.end ?? f.dur) - (f.start ?? 0) : 1.6;
      audio.play("incoming", at.x, at.y + 20, at.z, { delay: Math.max(0, left - len) });
    },
  };

  // ── Explosions, napalm, smoke, birds: wrapped, as the bird flush is ──────────
  {
    const explosion = fx.explosion;
    fx.explosion = (x, y, z, opts = {}) => {
      explosion(x, y, z, opts);
      const size = opts.size ?? 10;
      if (opts.dust || size < 5) return;          // a man going down: no bang
      audio.play("explosion", x, y, z, { gain: Math.min(1.3, Math.max(0.55, size / 14)), rate: size > 20 ? 0.85 : 1 });
    };
    const shellHit = fx.shellHit?.bind(fx);
    if (shellHit) fx.shellHit = (x, y, z) => { shellHit(x, y, z); audio.play("explosion", x, y, z, { gain: 0.5, rate: 1.15 }); };
  }
  if (fireballs) {
    const spawn = fireballs.spawn.bind(fireballs);
    // Only the splash's main ball (the side balls come with a delay).
    fireballs.spawn = (x, y, z, o = {}) => { const r = spawn(x, y, z, o); if (!o.delay) audio.play("napalm", x, y, z); return r; };
  }
  if (smoke) {
    const spawn = smoke.spawn.bind(smoke);
    smoke.spawn = (o = {}) => {
      const r = spawn(o);
      const kind = o.kind ?? "screen";
      if (kind === "screen" || kind === "violet") audio.play("smoke", o.x, o.y ?? app.getWorldHeight?.(o.x, o.z) ?? 0, o.z);
      return r;
    };
  }
  if (birds) {
    const flush = birds.flush.bind(birds);
    birds.flush = (x, z, o) => {
      const r = flush(x, z, o);
      if (r) audio.play("birdFlush", x, app.getWorldHeight?.(x, z) ?? 0, z, { delay: 0.15 });
      return r;
    };
    // A stand of egrets lifting off the river bank.
    app.onBirdsLift = (x, z) => audio.play("birdFlush", x, app.getWorldHeight?.(x, z) ?? 0, z, { gain: 0.7 });
  }

  // ── Loops ─────────────────────────────────────────────────────────────────
  // Rotors and engines: every candidate is offered; the mixer keeps the
  // nearest few per slot.
  audio.addLoopProvider(() => {
    const out = [];
    for (const u of units.list) {
      if (!u.alive) continue;
      if (u.isAir) {
        // A Huey holding over the pad is a drone under the base, not an event:
        // measured, three of them sat level with a firefight. Flying, full.
        out.push({ slot: "huey", key: u, x: u.position.x, y: u.position.y, z: u.position.z,
          level: u.isMoving ? 1 : 0.25, rate: u.isMoving ? 1.04 : 1 });
      } else if (u.typeKey !== "soldier" && u.isMoving) {
        out.push({ slot: TANKS.has(u.typeKey) ? "tank" : "jeep", key: u,
          x: u.position.x, y: u.position.y, z: u.position.z, level: 1 });
      }
    }
    return out;
  });
  if (fire?.fires) {
    audio.addLoopProvider(() => {
      const now = fire.now ?? 0;
      const out = [];
      for (const f of fire.fires) {
        const left = f.end - now;
        if (left <= 0) continue;
        out.push({ slot: "fireLoop", key: f, x: f.x, y: f.y, z: f.z,
          level: Math.min(1.2, 0.35 + f.radius * 0.18) * Math.min(1, left / 2) });
      }
      return out;
    });
  }
  if (buildings?.list) {
    audio.addLoopProvider(() => buildings.list
      .filter((b) => b.alive && b.constructing && b.team !== "enemy")
      .map((b) => ({ slot: "build", key: b, x: b.position.x, y: b.position.y, z: b.position.z, level: 1 })));
  }
  // The jungle: always there, a touch quieter from high up.
  audio.addLoopProvider(() => {
    const zoomT = rtsCamera.getView?.()?.zoomT ?? 0.5;
    return [{ slot: "jungle", key: "jungle", level: 1 - zoomT * 0.35 }];
  });

  // ── UI: clicks on HUD buttons, the radio on an order ────────────────────────
  // Buttons outside the Dev panel (it has its own audition buttons).
  const onDown = (e) => {
    const b = e.target.closest?.("button, .cc-btn, [role=button]");
    if (!b || b.closest("#rts-dev")) return;
    audio.play("uiClick");
  };
  window.addEventListener("pointerdown", onDown, true);

  let lastOrder = -1;
  function order(kind, list) {
    const now = audio.ctx.currentTime;
    if (now - lastOrder < 0.35) return;          // a click-spam is one answer
    lastOrder = now;
    if (!list?.some?.((u) => !u.isStructure)) return;
    audio.play("radio", null, 0, 0, { rate: kind === "attack" ? 1.05 : 1 });
  }

  return {
    audio, sfx, order,
    getView: () => rtsCamera.getView?.(),
    /** Something of yours finished (a building): the radio says so. */
    done() { audio.play("radio", null, 0, 0, { rate: 0.95, gain: 0.8 }); },
    update() { audio.update(); },
    dispose() { window.removeEventListener("pointerdown", onDown, true); audio.ctx.close(); },
  };
}
