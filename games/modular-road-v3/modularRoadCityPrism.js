// ── THE ROOFTOP PRISM BILLBOARD ──────────────────────────────────────────────
//
// One trivision board — three posters on rotating triangular slats — standing
// on the roof of a downtown tower. ONE of them, deliberately: this is a
// landmark, not a class of signage. The city already has 145 boards and a
// 96 m LED wall; what it did not have was something you can navigate by.
//
// IT REUSES THE TRACK BUILDER'S PROP RATHER THAN REBUILDING IT. The board, its
// slats, its rotation clock and its three face textures are all
// modularRoadAdPrism.js, which the builder has been shipping for months. The
// only thing added there was `legs: false` — a roadside board stands on posts
// and a roof-mounted one has nothing to stand on.
//
// WHAT IT COSTS, stated plainly rather than implied: four draw calls, once,
// for the whole city. That is not instanced and does not need to be — it is a
// single object, and instancing one of something buys nothing. The slats
// animate in a vertex shader off a shared clock, so the rotation is free on
// the CPU; there is no per-frame work here at all.
//
// WHY A ROOF AND NOT A WALL. The LED wall already takes the best wall, and it
// picks the run NEAREST downtown so the player drives past it. A prism read
// from below is mostly its own underside, so this one goes for HEIGHT instead
// and is scored to sit clear of the skyline — the two landmarks then answer
// different questions: the wall is what you pass, the prism is what you steer
// by.

import * as THREE from "three";
import { buildAdPrismMesh, AD_PRISM } from "./modularRoadAdPrism.js";

export const CITY_PRISM_DEFAULTS = {
  /** Off and it costs nothing at all — the prop is never built. */
  prism: true,
  /** WHERE IT STANDS. "plaza" puts it in one of the empty blocks, on its own
   *  legs, where you drive past it; "roof" puts it on a downtown tower, where
   *  it is a skyline landmark instead. Plaza falls back to roof if the seed
   *  produced no square big enough. */
  prismSite: "plaza",
  /** A board in a square is read from across the block, not from across the
   *  city, so it does not need to be as big. */
  prismPlazaScale: 3.2,
  /** The prop's own scale. `AD_PRISM.scale` is 2 for a roadside board; a
   *  rooftop landmark has to read from the far side of the city. */
  prismScale: 6.5,
  /** A tower has to be at least this tall to carry it, or the "landmark" is
   *  lost among the buildings around it. */
  prismMinHeight: 72,
  /** How much the distance from downtown counts against height when picking.
   *  0 takes the tallest tower wherever it is; large values hug the origin. */
  prismNearWeight: 0.30,
  /** Lifted clear of the roof so the bottom rail does not z-fight the slab. */
  prismLift: 0.8,
};

/**
 * Pick the tower and build the board. Returns `{ group, at }`, or null when
 * there is no building tall enough — which is a legitimate outcome for a
 * low-rise seed, not an error.
 *
 * `buildings` are the city's placed lots (`x, y, z, arch, scaleY`) and
 * `archetypes` their shapes; both are exactly what createCitySigns is given,
 * so this needs no new data plumbed through the city.
 */
/**
 * WHICH SQUARE THE BOARD TAKES — the one nearest downtown, where the track
 * and the player are.
 *
 * Exported because the car parks have to exclude it, and the only safe way to
 * agree on "the plaza the prism took" is for both to ask the same function. A
 * second copy of "nearest to the origin" would agree right up until either
 * rule was tuned, and the symptom would be a hundred cars parked around a
 * billboard.
 */
export function pickPrismPlaza(plazas) {
  let best = null, bd = Infinity;
  for (const pz of plazas) {
    const d = Math.hypot(pz.x, pz.z);
    if (d < bd) { bd = d; best = pz; }
  }
  return best;
}

export function placeCityPrism({ buildings, archetypes, plazas = [], params = {} } = {}) {
  const P = { ...CITY_PRISM_DEFAULTS, ...params };
  if (!P.prism || !buildings?.length) return null;

  /*
   * A SQUARE FIRST, IF THERE IS ONE.
   *
   * The plazas are the only open ground in this city, and an empty paved
   * block reads as missing content until something stands in it. A trivision
   * board is exactly what does stand in one — and unlike the roof, it is then
   * at the scale you actually meet it, from a car, on its own legs.
   *
   * It falls back to a roof rather than refusing: `plazas` is a rolled
   * feature, and a seed that produced none must still get its landmark.
   */
  if (P.prismSite === "plaza" && plazas.length) {
    const pz = pickPrismPlaza(plazas);
    const group = buildAdPrismMesh({
      params: { ...AD_PRISM, legs: true, scale: P.prismPlazaScale },
    });
    group.name = "CityAdPrism";
    // Sat on the ground by its own measured underside, for the same reason
    // the roof version is: the prop's lowest geometry is not its bottom rail.
    const box = new THREE.Box3().setFromObject(group);
    group.position.set(pz.x, pz.y - box.min.y, pz.z);
    // Facing the middle of the city, so the side you approach from is the
    // side with the pictures on it.
    const len = Math.hypot(pz.x, pz.z) || 1;
    group.rotation.y = Math.atan2(-pz.x / len, -pz.z / len);
    group.traverse((o) => {
      if (!o.isMesh) return;
      o.userData.noCollide = true;
      o.userData.noMerge = true;
    });
    return {
      group,
      at: { x: pz.x, y: pz.y, z: pz.z, height: 0, scale: P.prismPlazaScale, site: "plaza" },
      dispose() {
        group.traverse((o) => {
          if (!o.isMesh) return;
          o.geometry?.dispose?.();
          const m = o.material;
          if (Array.isArray(m)) m.forEach((mm) => mm?.dispose?.());
          else m?.dispose?.();
        });
      },
    };
  }

  let best = null;
  for (const b of buildings) {
    const a = archetypes?.[b.arch];
    if (!a) continue;
    const top = b.top != null ? b.top : b.y + (a.height ?? 0) * (b.scaleY ?? 1);
    const height = top - b.y;
    if (!(height > P.prismMinHeight)) continue;
    /*
     * TALL FIRST, NEAR SECOND. Minimising `-height + dist * w` reads as "the
     * tallest tower, unless a much closer one is nearly as tall". The LED wall
     * scores the other way round on purpose; if both used the same rule the
     * city would put its two landmarks on the same block.
     */
    const score = -height + Math.hypot(b.x, b.z) * P.prismNearWeight;
    if (!best || score < best.score) best = { b, a, top, height, score };
  }
  if (!best) return null;

  const { b, a, top } = best;
  const group = buildAdPrismMesh({
    params: { ...AD_PRISM, legs: false, scale: P.prismScale },
  });
  group.name = "CityAdPrism";

  /*
   * THE LIFT IS MEASURED OFF THE PROP, not computed from its parameters.
   *
   * Deriving it as `(panelBottom - frame) * scale` looked exact and put the
   * board 18 m INTO the tower: the prop's lowest geometry is not its bottom
   * rail — the backing slab and the spine hang below it, and with the legs
   * removed there was nothing left to make that obvious. A bounding box asks
   * the object what it actually is, so it stays right if the prop is ever
   * re-proportioned, and it cost one line instead of a correction.
   */
  const box = new THREE.Box3().setFromObject(group);
  group.position.set(b.x, top + P.prismLift - box.min.y, b.z);

  /*
   * FACING DOWNTOWN. The board's live face is its +Z, the same convention the
   * hero quads use, so the yaw is atan2 of the direction TO the origin — the
   * side the track and the player are on. A landmark turned away from where
   * anyone drives is just a shape on a roof.
   */
  const dx = -b.x, dz = -b.z;
  const len = Math.hypot(dx, dz) || 1;
  group.rotation.y = Math.atan2(dx / len, dz / len);

  // Nothing here should ever be swept into the collision bake or the merger:
  // it is 90 m up and the slats move.
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.userData.noCollide = true;
    o.userData.noMerge = true;
  });

  return {
    group,
    at: { x: b.x, y: top, z: b.z, height: best.height, scale: P.prismScale, site: "roof" },
    dispose() {
      group.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry?.dispose?.();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((mm) => mm?.dispose?.());
        else m?.dispose?.();
      });
    },
  };
}
