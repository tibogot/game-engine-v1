/**
 * The room the terrarium sits in — built only so the glass has something to reflect.
 *
 * This is the load-bearing module of the whole page. Glass has almost no colour of its
 * own: what you read as "glass" is a reflection of a room, and a pane with nothing to
 * reflect looks like grey plastic no matter how good the shader is. The same is true of
 * the water surface and of every wet or glossy surface in the tank.
 *
 * So rather than ship an HDRI, we build a crude room out of flat emissive boxes and
 * prefilter it with PMREM. Nobody ever looks at this scene directly — it only ever
 * appears smeared across a curved highlight — so "crude" is genuinely enough, and it
 * costs one bake at boot instead of a multi-megabyte download.
 *
 * It is rebuilt (not animated) when the day/night slider settles, because the window
 * going dark has to change what the glass reflects, not just how bright the lamps are.
 */
import * as THREE from "three/webgpu";

/** Room extents in metres, with the terrarium's baseboard at y = 0 on a table. */
const ROOM = { w: 5.0, h: 2.9, d: 4.2, tableY: 0.0, floorY: -0.75 };

function panel(scene, w, h, d, color, pos, rot = null) {
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, toneMapped: false });
  // MeshBasic colour IS the radiance the PMREM sees, and the cube target is half-float,
  // so light sources are just colours multiplied past 1. That is the whole trick.
  mat.color.copy(color);
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(pos[0], pos[1], pos[2]);
  if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
  scene.add(m);
  return m;
}

const c = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);

/**
 * Build the room scene for a given time of day.
 *
 * @param {number} dayNight 1 = midday through the window, 0 = night with the lamp only.
 * @param {number} lampGlow how much warm bounce the basking lamp throws into the room.
 */
export function buildRoomScene(dayNight = 1, lampGlow = 1) {
  const scene = new THREE.Scene();
  const day = Math.max(0, Math.min(1, dayNight));

  // Night is not "day, but darker" — it is a different colour. Daylight through a window
  // is cool and very bright; a dark room lit only by a red night bulb is warm and dim,
  // and the glass has to reflect that difference or the night look reads as broken day.
  const wallTone = new THREE.Color().lerpColors(c(0x2a2118, 0.10), c(0xb9b2a6, 0.35), day);
  const ceilTone = new THREE.Color().lerpColors(c(0x1e1813, 0.08), c(0xd8d4cc, 0.45), day);
  const floorTone = new THREE.Color().lerpColors(c(0x1c1512, 0.05), c(0x6b4f3a, 0.16), day);

  // Shell. Slightly oversized boxes; only their inner faces are ever sampled.
  panel(scene, ROOM.w, 0.02, ROOM.d, floorTone, [0, ROOM.floorY, 0]);
  panel(scene, ROOM.w, 0.02, ROOM.d, ceilTone, [0, ROOM.floorY + ROOM.h, 0]);
  panel(scene, 0.02, ROOM.h, ROOM.d, wallTone, [-ROOM.w / 2, ROOM.floorY + ROOM.h / 2, 0]);
  panel(scene, 0.02, ROOM.h, ROOM.d, wallTone, [ROOM.w / 2, ROOM.floorY + ROOM.h / 2, 0]);
  panel(scene, ROOM.w, ROOM.h, 0.02, wallTone, [0, ROOM.floorY + ROOM.h / 2, -ROOM.d / 2]);
  panel(scene, ROOM.w, ROOM.h, 0.02, wallTone, [0, ROOM.floorY + ROOM.h / 2, ROOM.d / 2]);

  // The table the tank stands on — a dark matte slab right under the glass. This is what
  // the bottom few centimetres of every pane reflects, so leaving it out makes the tank
  // look like it is floating.
  panel(scene, 1.9, 0.05, 1.0, c(0x2a211b, 0.10), [0, -0.03, 0]);

  // The window. Big, cool, off to -X so its reflection rakes across the front panes at
  // the default camera angle — a long soft highlight is what says "this is glass" faster
  // than any amount of refraction at 6 mm thickness.
  const winI = 0.15 + day * 5.2;
  panel(scene, 0.03, 1.45, 1.7, c(0xbdd6ff, winI), [-ROOM.w / 2 + 0.03, 0.55, -0.35]);
  // Sky bounce on the floor below it, so the window is not a lone rectangle in the dark.
  panel(scene, 1.1, 0.02, 1.6, c(0x9db4d6, 0.05 + day * 0.5), [-1.6, ROOM.floorY + 0.02, -0.35]);

  // Ceiling fixture — always on, and at night it is nearly all of what the room gives
  // the glass to reflect. Night here is "evening, room lamp on, window dark", not "3am
  // with the lights out": the latter is realistic and leaves the tank an unreadable
  // black rectangle, which is not a state a game can sit in.
  const roomI = 0.55 + (1 - day) * 0.95;
  panel(scene, 0.75, 0.02, 0.24, c(0xfff0dc, roomI), [0.4, ROOM.floorY + ROOM.h - 0.04, 0.5]);

  // The basking lamp's own bounce, sitting where the real fixture will be. Without this
  // the tank's own key light is missing from its reflections, which reads subtly wrong.
  const lampCol = new THREE.Color().lerpColors(c(0xff3b12, 0.9), c(0xffb877, 2.2), day);
  panel(scene, 0.16, 0.02, 0.16, lampCol.multiplyScalar(lampGlow), [-0.26, 0.60, 0.02]);

  return scene;
}

/**
 * Bake a room into a prefiltered environment and hand back the texture.
 *
 * Returns the PMREM render target as well so the caller can dispose it — this gets
 * rebaked whenever the day/night slider settles, and leaking a cube target per drag
 * would be a slow memory bleed rather than an obvious crash.
 */
export function bakeRoomEnvironment(renderer, dayNight, lampGlow) {
  const roomScene = buildRoomScene(dayNight, lampGlow);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(roomScene, 0.02);
  pmrem.dispose();

  // The room scene itself is throwaway; only the cube target outlives this call.
  roomScene.traverse((o) => {
    if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
  });

  return rt;
}
