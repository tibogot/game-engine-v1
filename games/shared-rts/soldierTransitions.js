// SOLDIER CLIP TRANSITIONS — how long the crowd crossfades between two clips,
// per PAIR (your ask, 2026-09-30: "look at all of them and see if everything
// is right and natural"). Read by the game (unitRenderer.js) and judged in
// games/shared-rts/transition-lab.html, which plays every pair the way the
// game does — the crowd's own skinning, which mixes the two poses' skinned
// VERTEX POSITIONS (crowdSkinning.js), not bone rotations: a long fade across
// a big pose change (standing → prone) slides every vertex in a straight line
// and the body shrinks through the middle. Such a pair wants a transition
// clip, not a longer fade.
//
// Keys are the pack's clip names (tools/packMixamo.mjs), either order.

export const FADE_DEFAULT = 0.2;

/**
 * Seconds per pair ("a|b", sorted). Pairs not listed fade FADE_DEFAULT.
 * JUDGED in the lab 2026-09-30, from film strips of each pair (0-100 %):
 *   the SHOT pairs short — the 0.27 s recoil clip was mostly eaten by a
 *     0.2 s fade and the kick barely read;
 *   standing ⇄ kneeling: clean through the blend (one knee down, the rifle
 *     in both hands) but a drop at 0.2 s — a man ducking at 0.35;
 *   into / out of PRONE: the blend passes squat → hands and knees → flat, a
 *     believable drop given time; a blink at 0.2 s;
 *   the work and the throw: a little longer to bend and to wind up.
 * Pairs not listed (idle ⇄ run, idle ⇄ aim, run → aim, the deaths from
 * standing) looked right at 0.2 s.
 */
export const FADES = {
  "rifle_aim_idle|rifle_firing": 0.08,
  "rifle_crouch_firing|rifle_crouch_idle": 0.08,
  "rifle_crouch_idle|rifle_idle": 0.35,
  "rifle_aim_idle|rifle_crouch_idle": 0.35,
  "rifle_crouch_idle|rifle_crouch_walk": 0.25,
  "rifle_crouch_walk|rifle_run": 0.3,
  "rifle_idle|rifle_prone_idle": 0.5,
  "rifle_aim_idle|rifle_prone_idle": 0.5,
  "rifle_crouch_idle|rifle_prone_idle": 0.45,
  "rifle_crouch_walk|rifle_prone_idle": 0.45,
  "dig|rifle_idle": 0.35,
  "grenade_throw|rifle_aim_idle": 0.25,
  "grenade_throw|rifle_idle": 0.25,
};

const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** The crossfade from clip `a` to clip `b`, seconds. */
export function fadeFor(a, b) {
  return FADES[key(a, b)] ?? FADE_DEFAULT;
}

/** Set a pair's fade (the lab's slider). */
export function setFade(a, b, s) { FADES[key(a, b)] = s; }

/**
 * Every pair the game switches between (unitRenderer.js soldierClip: work,
 * posture, target, firing, deaths). What the lab lists.
 */
export const GAME_PAIRS = [
  ["rifle_idle", "rifle_run", "moving / stopping"],
  ["rifle_idle", "rifle_aim_idle", "a target in range"],
  ["rifle_aim_idle", "rifle_firing", "a shot"],
  ["rifle_run", "rifle_aim_idle", "stops to fire"],
  ["rifle_idle", "rifle_crouch_idle", "into cover"],
  ["rifle_aim_idle", "rifle_crouch_idle", "suppressed while aiming"],
  ["rifle_crouch_idle", "rifle_crouch_firing", "a shot, kneeling"],
  ["rifle_run", "rifle_crouch_walk", "suppressed on the move"],
  ["rifle_crouch_walk", "rifle_crouch_idle", "stops, suppressed"],
  ["rifle_idle", "rifle_prone_idle", "pinned (standing)"],
  ["rifle_crouch_idle", "rifle_prone_idle", "pinned (kneeling)"],
  ["rifle_prone_idle", "rifle_crouch_walk", "pinned, ordered to move"],
  ["rifle_idle", "dig", "a sapper starts work"],
  ["rifle_aim_idle", "grenade_throw", "a throw"],
  ["rifle_idle", "death_forward", "killed standing"],
  ["rifle_crouch_idle", "death_backward", "killed kneeling"],
  ["rifle_prone_idle", "death_forward", "killed lying"],
];

/**
 * How a man DIES from the clip he was in: { clip, t, fade }. Every death clip
 * starts STANDING — faded into from prone, a pinned man stood back up to fall
 * (seen in the lab's strip, 2026-09-30). So:
 *   PRONE    → the END of the forward fall (face down, as he lay), held,
 *              faded into slowly: he goes limp where he lies;
 *   KNEELING → the chosen fall from a third of the way in, where he is
 *              already going down — not up to his feet first;
 *   else     → the chosen fall from its start.
 * `pick` is the death the game rolled (the man's seed); `durationOf(clip)`.
 */
export function deathFrom(prevClip, pick, deaths, durationOf) {
  if (/prone/.test(prevClip)) {
    const clip = deaths.find((d) => /forward/.test(d)) ?? pick;
    return { clip, t: durationOf(clip) * 0.999, fade: 0.6 };
  }
  if (/crouch/.test(prevClip)) return { clip: pick, t: durationOf(pick) * 0.33, fade: 0.3 };
  return { clip: pick, t: 0, fade: fadeFor(prevClip, pick) };
}
