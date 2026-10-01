// WEAPON GRIPS — the hand-placed corrections to where a weapon sits (your
// ask, 2026-10-01: "fine-tune the weapons in the hand and on the back").
// Set by eye in the soldier lab's GRIP EDITOR (soldier-lab.html), pasted here.
//
// The pack tool works out each clip's hold on its own (tools/packMixamo.mjs:
// shouldered for aim/fire clips, hand to hand for the carries, along the
// forearm for the crawl, the average grip for the rest). These nudge it:
//
//   clips    per CLIP — a hold is a hand pose, so a wrong hold is wrong for
//            every weapon in that clip. BAKED into the pack's weapon bone
//            (re-run the pack): free in the game. On an aim/fire clip the
//            right hand follows the rifle (the pack's arm IK aims at it).
//   weapons  per WEAPON — the models differ (the MAT 49 is short with its
//            magazine in front, the FM 24/29 long with a bipod). Baked into
//            the weapon's geometry when it is built (procWeapons.js): free.
//   sling    the rifle slung on the back (dig, the throw): one place.
//   tool     the SHOVEL (dig): aimed from the right fist to the left one,
//            then this — p[2] slides it along the handle (+ toward the blade).
//   hand     THE HAND POINT — where the right fist really closes, as a shift
//            { p: [x, y, z] cm } along the RIGHT HAND bone's own axes (+Y
//            toward the fingers) from the pack's point (halfway from the
//            wrist to the index knuckle: on this cartoon hand that is the
//            wrist, measured 2026-10-01 — every clip was off the same way).
//            ONE fix for every clip: a carry hangs the rifle from it, an
//            aim/fire clip bends the arm so it lands on the grip. Fix it
//            first; the per-clip corrections are for what is left.
//   handLeft the LEFT hand's point, the same way in the left hand bone's
//            frame (mirrored: its x runs the other way). The shovel's lower
//            fist and the lab's left-hand auto-fit use it.
//            Both MEASURED (2026-10-01): the middle of each fist's own mesh
//            (the vertices that follow the hand and finger bones), steady to
//            ~1 cm across idle, aim, run, dig and prone.
//
// Each { p: [x, y, z] centimetres, r: [x, y, z] degrees } in the weapon's own
// frame (procWeapons.js: origin at the pistol grip, +Z to the muzzle, +Y up,
// +X to his left): p moves it, r turns it about the grip — x tips the muzzle
// down (+) / up, y swings it to his left (+) / right, z rolls it.
// Missing = no correction.
import * as THREE from "three";

export const GRIPS = {
  // Set 2026-10-01/02 in the soldier lab by Claude — measured, then judged in
  // close-ups of each fist (and checked: around the held line, the fist's
  // skin leaves no gap over 87° on any frame of these clips — the hand
  // surrounds it; the first setup left 206-248°: beside the hand).
  // LEFT-HAND auto-fit: the barrel line through the left fist (it was 5-11
  // cm to his right). Carries turn in the right fist; aim/fire clips turn
  // about the butt (it stays in the shoulder). Clips whose left hand leaves
  // the rifle (reload, crawl, posture moves) have none.
  clips: {
    rifle_aim_idle: { p: [-1.4, 1.8, -0.1], r: [-3.2, -2.5, 0] },
    rifle_crouch_firing: { p: [-1.5, 2, -0.1], r: [-3.5, -2.6, 0] },
    rifle_crouch_idle: { p: [0, 0, 0], r: [-1.8, -13.4, 0.1] },
    rifle_crouch_strafe: { p: [0, 0, 0], r: [5.1, -16, 1.1] },
    rifle_crouch_walk: { p: [0, 0, 0], r: [-4.3, -12.9, -0.2] },
    rifle_firing: { p: [-1.8, 1.8, -0.1], r: [-3.1, -3.1, 0] },
    rifle_idle: { p: [0, 0, 0], r: [-0.6, -18, 0.3] },
    rifle_prone_firing: { p: [-1.9, 2.2, -0.1], r: [-3.7, -3.2, -0.1] },
    rifle_prone_idle: { p: [0, 0, 0], r: [-4, -12.6, -0.1] },
    rifle_run: { p: [0, 0, 0], r: [-5.2, -12.5, -0.3] },
    rifle_walk: { p: [0, 0, 0], r: [2.4, -14.8, 0.6] },
  },
  weapons: {},
  // Flat on his back (it lay underside-in, held 8 cm off by the magazine).
  sling: { p: [0, -6, 0], r: [0, 0, 90] },
  // The shovel: slid 15 cm along the handle — the top (right) fist wraps the
  // shaft with the D-grip clear above the knuckles; the lower fist just above
  // the socket; the blade reaches the ground at the bottom of the stroke.
  tool: { p: [0, 0, 15], r: [0, 0, 0] },
  // The middle of his RIGHT fist's mesh (measured; the stock wrist runs through it).
  hand: { p: [3.1, 6, 1.6], r: [0, 0, 0] },
  // The middle of his LEFT fist's mesh (measured).
  handLeft: { p: [-4.1, 4.2, 1.8], r: [0, 0, 0] },
};

const D2R = Math.PI / 180;

/** The correction as a matrix (null / empty → identity). */
export function gripMatrix(off, out = new THREE.Matrix4()) {
  if (!off) return out.identity();
  const [px = 0, py = 0, pz = 0] = off.p ?? [];
  const [rx = 0, ry = 0, rz = 0] = off.r ?? [];
  return out.compose(
    new THREE.Vector3(px / 100, py / 100, pz / 100),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx * D2R, ry * D2R, rz * D2R, "XYZ")),
    new THREE.Vector3(1, 1, 1),
  );
}

/** True when the correction moves nothing. */
export function isZeroGrip(off) {
  return !off || [...(off.p ?? []), ...(off.r ?? [])].every((v) => !v);
}
