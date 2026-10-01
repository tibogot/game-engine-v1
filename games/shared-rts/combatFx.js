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
import { SMOKE_TINTS, createLitSmoke } from "./litSmoke.js";
import * as THREE from "three";

const FLASH_LIFE = 0.07;
const IMPACT_LIFE = 0.24;
const BLAST_FLASH_LIFE = 0.28;

// Shared growth curve: expand as it fades (p is remaining life, 1 → 0).
const grow = (p) => (1 + (1 - p) * 1.5) * (0.35 + p * 0.65);

/**
 * `style`: "flipbook" (nam, as it was) or "coh" (alg-rts, 2026-10-01 — your
 * ask: the explosion flipbook "looks not so good for this game"; CoH
 * research in alg-rts/TODO.md): a SHORT flash, a SMALL fireball, a FAN of
 * dirt clods thrown up and falling back (gravity), a tall dust column that
 * lingers — in the desert, dust dominates fire. And a gun smoke wisp after
 * every shot.
 */
export function createCombatFx({ app, pool = 40, style = "flipbook", litSmoke = false }) {
  const { scene } = app;
  const coh = style === "coh";
  // Thrown dirt: dark clods, normal blending (dirt doesn't glow), gravity.
  const clods = coh ? createSpriteField({
    scene, max: 260, color: 0x3a2b1e, size: 1.5, bloomScale: 0, blending: THREE.NormalBlending,   // soft round blobs (0.55 m: invisible; hard quads: black squares)
    scaleAt: () => 1, fadeAt: (p) => Math.min(1, p * 4), gravity: 22,
  }) : null;
  // Muzzle smoke: a pale grey-tan wisp, rising a little, gone in ~0.8 s.
  const wisps = coh ? createSpriteField({
    scene, max: 160, color: 0xbab3a4, size: 0.6, bloomScale: 0, blending: THREE.NormalBlending,
    scaleAt: (p) => 0.6 + (1 - p) * 1.2, fadeAt: (p) => 0.18 * p,   // (0.35 / 0.9 m: grey blobs round every rifleman)
  }) : null;
  // SPARKS: tiny white-hot specks, additive (they glow), thrown and falling,
  // gone in ~0.2 s — a bullet off metal. (CoH: speed-stretched sparks;
  // these are short enough that the speck reads as one.)
  const sparks = coh ? createSpriteField({
    scene, max: 200, color: 0xffd99a, size: 0.45, bloomScale: BLOOM.impact, gravity: 14,
    scaleAt: (p) => 0.4 + p * 0.6, fadeAt: (p) => p,
  }) : null;
  // TRAIL: a tank shell's thin smoke, left along its flight, fading over ~1.5 s.
  const trail = coh ? createSpriteField({
    scene, max: 240, color: 0xc9c2b4, size: 1.2, bloomScale: 0, blending: THREE.NormalBlending,
    scaleAt: (p) => 0.7 + (1 - p) * 1.1, fadeAt: (p) => 0.3 * p,
  }) : null;
  const groundAt = (x, z, y) => app.getWorldHeight?.(x, z) ?? y;
  /** A fan of clods: `n` thrown up and outward, biased one way (a CoH jet). */
  function throwDirt(x, y, z, n, power) {
    const dir = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = dir + (Math.random() - 0.5) * 2.2, h = power * (0.25 + Math.random() * 0.55);
      clods.spawn(x, y + 0.3, z, 1.1 + Math.random() * 0.9, {
        vx: Math.cos(a) * h, vz: Math.sin(a) * h, vy: power * (0.8 + Math.random() * 0.9),
        scale: 0.6 + Math.random() * 0.9,
      });
    }
  }

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

  // LIT SMOKE (litSmoke.js, opt-in): every puff of dust and smoke — the
  // blasts' columns, a man going down, dirt kicks, the gun smoke, the shell's
  // trail — lit by the game's sun instead of the old book's painted light.
  // setLitSmoke(false) puts the old look back, live (the battle lab's A/B).
  const lit = litSmoke ? createLitSmoke({ app }) : null;
  let litOn = !!lit;
  const bookPuff = books.puff;
  books.puff = (x, y, z, o = {}) => {
    if (!litOn) return bookPuff(x, y, z, o);
    const size = o.size ?? 3;
    // The old card sat ~0.3 of its size up and climbed 0.3 more: the same here.
    lit.puff(x, y + size * 0.3, z, { size, duration: o.duration ?? 1.4, delay: o.delay ?? 0, tint: o.grey ? SMOKE_TINTS.grey : SMOKE_TINTS.dust, vel: [0, (size * 0.3) / (o.duration ?? 1.4), 0] });
  };

  return {
    books,
    muzzle: (x, y, z) => {
      flashes.spawn(x, y, z, coh ? 0.045 : FLASH_LIFE);
      if (litOn) lit.puff(x, y, z, { size: 0.8, duration: 1.1 + Math.random() * 0.5, tint: SMOKE_TINTS.grey, opacity: 0.35, grow: 0.7, vel: [(Math.random() - 0.5) * 0.4, 0.45, (Math.random() - 0.5) * 0.4] });
      else if (wisps) wisps.spawn(x, y, z, 0.6 + Math.random() * 0.4, { vy: 0.5, vx: (Math.random() - 0.5) * 0.4, vz: (Math.random() - 0.5) * 0.4, scale: 0.8 + Math.random() * 0.5 });
    },
    impact:    (x, y, z) => impacts.spawn(x, y, z, IMPACT_LIFE),
    /** (coh) A bullet off a vehicle (sparks) or a wall (stone chips + a dust kick). */
    bulletHit: coh ? (x, y, z, { metal = true } = {}) => {
      if (metal) {
        for (let k = 0; k < 5; k++) {
          sparks.spawn(x, y, z, 0.28 + Math.random() * 0.14, { vx: (Math.random() - 0.5) * 9, vy: 1 + Math.random() * 4, vz: (Math.random() - 0.5) * 9, scale: 0.6 + Math.random() * 0.6 });
        }
      } else {
        for (let k = 0; k < 3; k++) {
          clods.spawn(x, y, z, 0.5 + Math.random() * 0.3, { vx: (Math.random() - 0.5) * 3, vy: 1.5 + Math.random() * 2, vz: (Math.random() - 0.5) * 3, scale: 0.2 + Math.random() * 0.15 });
        }
        books.puff(x, y - 0.5, z, { size: 1.0, duration: 0.8, grey: 0.6 });
      }
    } : undefined,
    /** (coh) A tank shell's smoke at a point of its flight. */
    trail: coh ? (x, y, z) => (litOn
      ? lit.puff(x, y, z, { size: 1.2, duration: 1.4 + Math.random() * 0.5, tint: SMOKE_TINTS.grey, opacity: 0.5, grow: 0.6, vel: [0, 0.3, 0] })
      : trail.spawn(x, y, z, 1.2 + Math.random() * 0.5, { vy: 0.3, scale: 0.7 + Math.random() * 0.4 })) : undefined,
    /** The lit smoke on or off (live); null without it. */
    get litSmoke() { return lit ? litOn : null; },
    setLitSmoke(on) { if (lit) { litOn = !!on; if (!litOn) lit.clear(); } },
    lit,
    /**
     * `size` is the cloud's width in metres (10 ≈ a vehicle); `dust` makes it
     * a puff of earth with no fire and no flash.
     */
    explosion(x, y, z, { size = 10, dust = false } = {}) {
      if (dust) { books.puff(x, y, z, { size, duration: 1.2 + size * 0.08 }); return; }
      if (coh) {
        // CoH: flash (a blink), a small fireball, the dirt jet, then the dust
        // column — big, slow, staged a few hundredths of a second apart.
        blasts.spawn(x, y + 1.2, z, 0.16);
        books.explode(x, y - 0.4, z, { size: size * 0.7, duration: 1.0 });
        throwDirt(x, y, z, Math.round(10 + size * 1.6), 7 + size * 0.55);
        books.puff(x, y, z, { size: size * 1.15, duration: 4 + size * 0.2, delay: 0.35 });   // after the fireball shows
        books.puff(x, y + size * 0.25, z, { size: size * 1.5, duration: 6 + size * 0.25, delay: 0.6 });
        // Where the clods come down: a ring of small secondary puffs.
        for (let k = 0; k < 4; k++) {
          const a = Math.random() * Math.PI * 2, r = size * (0.5 + Math.random() * 0.6);
          books.puff(x + Math.cos(a) * r, y, z + Math.sin(a) * r, { size: size * 0.3, duration: 1.4, delay: 1.0 + Math.random() * 0.5 });
        }
        return;
      }
      blasts.spawn(x, y + 1.5, z, BLAST_FLASH_LIFE);
      // Bigger blasts linger longer: a mortar bomb is gone in two seconds,
      // a fuel dump hangs over the camp.
      books.explode(x, y, z, { size, duration: 1.9 + size * 0.07 });
    },

    /**
     * A GRENADE going off: not a fireball — a sharp small flash, a short dark
     * burst and the earth it throws up (alg-rts, 2026-09-30: the mortar
     * blast it had read as a bomb).
     */
    grenade(x, y, z) {
      if (coh) {
        impacts.spawn(x, y + 0.4, z, 0.1);
        throwDirt(x, y, z, 9, 6);
        books.puff(x, y, z, { size: 4.2, duration: 2.6 });
        books.puff(x, y + 1, z, { size: 5.5, duration: 3.6, delay: 0.25 });
        return;
      }
      impacts.spawn(x, y + 0.4, z, IMPACT_LIFE * 1.5);
      books.explode(x, y - 0.3, z, { size: 2.6, duration: 0.8 });
      books.puff(x, y, z, { size: 3.4, duration: 1.6 });
    },

    /** A tank gun: a flash big enough to bloom, and a puff of grey gun smoke. */
    cannon(x, y, z) {
      blasts.spawn(x, y, z, 0.12);
      if (coh) {
        // The blast raises the dust off the ground under and ahead of the
        // gun: a low ring of puffs (dry ground — this map is all dry).
        const g = groundAt(x, z, y - 2);
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2 + Math.random() * 0.5, r = 1.8 + Math.random() * 1.4;
          books.puff(x + Math.cos(a) * r, g - 0.6, z + Math.sin(a) * r, { size: 2.6, duration: 1.6 + Math.random() * 0.6 });
        }
      }
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
      clods?.update(dt, camera);
      wisps?.update(dt, camera);
      sparks?.update(dt, camera);
      trail?.update(dt, camera);
      books.render(clock);
      lit?.render(clock);
    },
  };
}
