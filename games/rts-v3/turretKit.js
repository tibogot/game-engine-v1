// Turret geometry — SHARED by both turret renderers.
//
// Enemy turrets are placed at boot and merged into the static structure mesh
// (structuresRenderer.js). Player turrets are BUILT at runtime, rise out of the
// ground, and are instanced (buildingRenderer.js). Same turret, two very different
// render paths — so the shape lives here, once, and each side supplies its team
// palette. Change the silhouette here and both teams get it.
//
// The head is a separate geometry from the body because it YAWS to track a target;
// the body never moves relative to its structure.
//
// Layout constants (HEAD_Y / MUZZLE_LOCAL / EYE_LOCAL) are exported so combat's
// tracers leave the actual barrel tip rather than a guessed point.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Head pivot height above the structure's ground origin. */
export const HEAD_Y = 5.2;
/** Barrel tip, in HEAD space (the yaw pivot's frame). */
export const MUZZLE_LOCAL = new THREE.Vector3(0, 0.2, 5.1);
/**
 * Sensor eye, in HEAD space — centre of the sphere that seats into the sensor pod
 * on the head's deck. Re-check this against the pod if the head silhouette changes:
 * it was originally tuned for an older, taller head and ended up buried in the hull.
 */
export const EYE_LOCAL = new THREE.Vector3(0, 1.5, 0.3);

/** Team palettes. `armor` is the big readable colour; the rest is shared hardware. */
export const TURRET_PALETTE = {
  player: { armor: 0x44607e, trim: 0x6ab0ff, eye: 0x64d2ff },
  enemy:  { armor: 0x6e4a4a, trim: 0xff6a3a, eye: 0xff4a3a },
};

const C_DARK = 0x333a45; // gunmetal — barrels, plinth, hardware

/** Tag every vertex of `geo` with `hex` so merged parts keep their own colour. */
function paint(geo, hex) {
  const c = new THREE.Color(hex); // already in linear working space
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

/**
 * mergeGeometries returns null on ANY attribute mismatch, which would silently
 * delete a whole turret. Throw instead of shipping an invisible emplacement.
 */
function mergePainted(parts, name) {
  const geo = mergeGeometries(parts, false);
  if (!geo) throw new Error(`[rts-v3] ${name}: mergeGeometries failed (attribute mismatch)`);
  return geo;
}

/**
 * Turret BODY — the part that never rotates: an octagonal armoured plinth, a
 * sloped skirt in the team colour, the pedestal column and its bearing collar.
 *
 * Octagonal (8 radial segments) rather than round: it reads as fabricated armour
 * instead of a pipe, and costs a third of the vertices of the old 16-segment cylinder.
 */
export function turretBodyGeometry(team = "enemy") {
  const { armor, trim } = TURRET_PALETTE[team] ?? TURRET_PALETTE.enemy;
  return mergePainted([
    // Ground plinth — widest, darkest, reads as a poured footing.
    paint(new THREE.CylinderGeometry(4.3, 5.0, 0.9, 8).translate(0, 0.45, 0), C_DARK),
    // Armoured skirt in the team colour — the shape you identify at a distance.
    paint(new THREE.CylinderGeometry(3.2, 4.1, 1.6, 8).translate(0, 1.7, 0), armor),
    // A trim band around the skirt's top edge — catches the light, marks the team.
    paint(new THREE.CylinderGeometry(3.25, 3.25, 0.25, 8).translate(0, 2.6, 0), trim),
    // Pedestal column carrying the head.
    paint(new THREE.CylinderGeometry(1.5, 2.1, 2.1, 12).translate(0, 3.7, 0), C_DARK),
    // Bearing collar the head sits on.
    paint(new THREE.CylinderGeometry(2.3, 2.3, 0.5, 12).translate(0, 4.9, 0), C_DARK),
  ], "turretBody");
}

/**
 * Turret HEAD — yaws to track. Origin is the yaw pivot (HEAD_Y above the body),
 * barrels along +Z.
 *
 */
export function turretHeadGeometry(team = "enemy") {
  const { armor, trim } = TURRET_PALETTE[team] ?? TURRET_PALETTE.enemy;

  // Twin barrels, side by side.
  const barrel = (x) => {
    const b = paint(new THREE.CylinderGeometry(0.26, 0.32, 4.6, 8), C_DARK);
    b.rotateX(Math.PI / 2);          // lay it along +Z
    b.translate(x, 0.2, 2.5);        // …pointing out of the head
    return b;
  };
  // Muzzle brakes — a fatter stub at each barrel tip.
  const brake = (x) => {
    const m = paint(new THREE.CylinderGeometry(0.42, 0.42, 0.7, 8), C_DARK);
    m.rotateX(Math.PI / 2);
    m.translate(x, 0.2, 4.6);
    return m;
  };

  // No mantlet block at the barrel root. An angled wedge there reads as a stray
  // cube stuck on the front at RTS zoom — the barrels are rooted well inside the
  // housing (they start at z 0.2, the front face is at z 1.6), so they emerge
  // from it cleanly with nothing extra needed.
  return mergePainted([
    // Main housing — top face at y 0.9.
    paint(new THREE.BoxGeometry(3.0, 1.8, 3.2), armor),
    // Shoulder trim along the REAR of the deck — team colour, read from above.
    // Kept behind the sensor pod so the two don't intersect.
    paint(new THREE.BoxGeometry(2.2, 0.22, 1.3).translate(0, 0.95, -0.95), trim),
    // Sensor pod: the eye seats INTO this, instead of floating on the hull.
    paint(new THREE.BoxGeometry(0.9, 0.5, 0.9).translate(0, 1.05, 0.3), C_DARK),
    // Rear counterweight, balancing the barrels visually.
    paint(new THREE.BoxGeometry(2.2, 1.3, 0.9).translate(0, -0.1, -1.9), C_DARK),
    barrel(-0.55), barrel(0.55),
    brake(-0.55), brake(0.55),
  ], "turretHead");
}

/**
 * Sensor-eye geometry (emissive, drawn by the caller's bloom material).
 *
 * 0.38 rather than 0.45: it needs to seat cleanly into the sensor pod (0.9 wide)
 * without poking out the far side.
 */
export function turretEyeGeometry() {
  return new THREE.SphereGeometry(0.38, 12, 8);
}

const _up = new THREE.Vector3(0, 1, 0);
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);

/**
 * World matrix of a turret's head (its yaw pivot).
 *
 * `yOffset` lets a turret that is still rising out of the ground keep its head
 * attached to its body — the construction animation sinks the whole emplacement.
 */
export function turretHeadMatrix(s, out, yOffset = 0) {
  return out.compose(
    _pos.set(s.position.x, s.position.y + HEAD_Y + yOffset, s.position.z),
    _quat.setFromAxisAngle(_up, s.turretYaw ?? 0),
    _scale,
  );
}
