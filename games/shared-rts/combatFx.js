// Combat FX — GAME code. Muzzle flashes, impact sparks and explosions.
// (The rounds themselves — tracers, shells, rockets — are projectiles.js.)
//
// Each KIND is one instanced sprite field (spriteField.js), so a battlefield full
// of flashes costs 3 draw calls, not one per flash. Every field writes to the
// emissive MRT buffer, so v3's existing selective-bloom pass makes them glow with
// no pipeline work.
//
// EXPLOSIONS are flipbooks (explosionField.js): the fire-then-smoke cloud of a
// real simulation, with a short additive flash under it so the bloom kicks on
// the frame it goes off. A soldier does not explode: he raises a puff of dust.
import { createSpriteField } from "./spriteField.js";
import { createExplosionField } from "./explosionField.js";
import { BLOOM } from "./bloom.js";

const FLASH_LIFE = 0.07;
const IMPACT_LIFE = 0.24;
const BLAST_FLASH_LIFE = 0.28;

// Shared growth curve: expand as it fades (p is remaining life, 1 → 0).
const grow = (p) => (1 + (1 - p) * 1.5) * (0.35 + p * 0.65);

export function createCombatFx({ app, pool = 40 }) {
  const { scene } = app;

  const flashes = createSpriteField({
    scene, max: pool, color: 0xffd27a, size: 2.4, bloomScale: BLOOM.muzzle, scaleAt: grow,
  });
  const impacts = createSpriteField({
    scene, max: pool, color: 0xff9a3c, size: 3.0, bloomScale: BLOOM.impact, scaleAt: grow,
  });
  // The flash only: the cloud is the flipbook's. Unit size, scaled per blast
  // isn't possible in a shared sprite field, so it is sized for a vehicle.
  const blasts = createSpriteField({
    scene, max: 16, color: 0xff8a3a, size: 9, bloomScale: BLOOM.fire, scaleAt: grow,
  });
  const books = createExplosionField({ app });
  let clock = 0;

  return {
    books,
    muzzle:    (x, y, z) => flashes.spawn(x, y, z, FLASH_LIFE),
    impact:    (x, y, z) => impacts.spawn(x, y, z, IMPACT_LIFE),
    /**
     * `size` is the cloud's width in metres (10 ≈ a vehicle); `dust` makes it
     * a puff of earth with no fire and no flash.
     */
    explosion(x, y, z, { size = 10, dust = false } = {}) {
      if (dust) { books.puff(x, y, z, { size, duration: 1.2 + size * 0.08 }); return; }
      blasts.spawn(x, y + 1.5, z, BLAST_FLASH_LIFE);
      // Bigger blasts linger longer: a mortar bomb is gone in two seconds,
      // a fuel dump hangs over the camp.
      books.explode(x, y, z, { size, duration: 1.9 + size * 0.07 });
    },

    /** A tank gun: a flash big enough to bloom, and a puff of grey gun smoke. */
    cannon(x, y, z) {
      blasts.spawn(x, y, z, 0.12);
      // A puff's card centres ~0.4 of its size above the point: start it low
      // so the smoke comes OUT of the muzzle rather than hanging over it.
      books.puff(x, y - 1.6, z, { size: 4.2, duration: 1.9, grey: 1 });
    },
    /** A round into the ground: a kick of dirt, no fire. */
    dirt(x, y, z, size = 1.3) {
      books.puff(x, y, z, { size, duration: 0.7 + size * 0.25 });
    },
    /** A shell hitting something: a small blast (not the death one). */
    shellHit(x, y, z) {
      blasts.spawn(x, y, z, 0.16);
      books.explode(x, y - 1, z, { size: 4.5, duration: 1.3 });
    },

    update(dt, camera) {
      clock += dt;
      flashes.update(dt, camera);
      impacts.update(dt, camera);
      blasts.update(dt, camera);
      books.render(clock);
    },
  };
}
