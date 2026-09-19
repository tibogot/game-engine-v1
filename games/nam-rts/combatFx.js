// Combat FX — GAME code. Muzzle flashes, impact sparks and explosions.
// (Tracers are gone: shots are now visible rockets — see projectiles.js.)
//
// Each KIND is one instanced sprite field (spriteField.js), so a battlefield full
// of flashes costs 3 draw calls, not one per flash. Every field writes to the
// emissive MRT buffer, so v3's existing selective-bloom pass makes them glow with
// no pipeline work.
import { createSpriteField } from "./spriteField.js";
import { BLOOM } from "./bloom.js";

const FLASH_LIFE = 0.07;
const IMPACT_LIFE = 0.24;
const EXPLOSION_LIFE = 0.6;

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
  const blasts = createSpriteField({
    scene, max: 16, color: 0xff6a1e, size: 12, bloomScale: BLOOM.fire, scaleAt: grow,
  });

  return {
    muzzle:    (x, y, z) => flashes.spawn(x, y, z, FLASH_LIFE),
    impact:    (x, y, z) => impacts.spawn(x, y, z, IMPACT_LIFE),
    explosion: (x, y, z) => blasts.spawn(x, y + 1.5, z, EXPLOSION_LIFE),

    update(dt, camera) {
      flashes.update(dt, camera);
      impacts.update(dt, camera);
      blasts.update(dt, camera);
    },
  };
}
