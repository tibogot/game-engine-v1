// THE LOOK — the table and the plastics (step 3 of PLAN.md starts here).
//
// Moulded toy plastic is never a perfect CG surface: its gloss varies (handling, dust, the mould's
// polish), so every plastic gets a slow roughness breakup in world space. The table is light
// varnished oak, drawn procedurally (no wood texture in the repo suits a table top).
import * as THREE from "three";
import { float, fract, mix, mx_fractal_noise_float, mx_noise_float, positionWorld, smoothstep, vec3 } from "three/tsl";

export function oakMaterial() {
  const m = new THREE.MeshStandardNodeMaterial();
  const p = positionWorld.xz;
  // the grain runs along x: growth rings stretched, warped by slow noise; fine fibres on top
  const warp = mx_fractal_noise_float(vec3(p.x.mul(0.9), p.y.mul(9.0), 0.0), 3, 2.0, 0.5);
  const drift = mx_noise_float(vec3(p.x.mul(0.35), p.y.mul(2.5), 3.0));
  const ring = fract(p.y.mul(48.0).add(warp.mul(1.3)).add(drift.mul(2.0)));
  const late = smoothstep(0.55, 0.9, ring).mul(smoothstep(1.0, 0.93, ring)).mul(0.6);
  const fibre = mx_noise_float(vec3(p.x.mul(6.0), p.y.mul(520.0), 1.0)).mul(0.5).add(0.5);
  const patch = mx_noise_float(vec3(p.x.mul(0.8), p.y.mul(0.8), 7.0)).mul(0.5).add(0.5);
  const light = vec3(0.66, 0.48, 0.28), dark = vec3(0.5, 0.35, 0.19);
  m.colorNode = mix(light, dark, late.mul(0.65).add(fibre.mul(0.18)).add(patch.mul(0.12)));
  m.roughnessNode = float(0.42).add(fibre.mul(0.12)).add(late.mul(0.08));
  return m;
}

// a plastic: base colour, base roughness, a slow gloss breakup (± amount)
export function plastic(color, roughness, { breakup = 0.08, clearcoat = 0, scale = 18 } = {}) {
  const m = new THREE.MeshPhysicalNodeMaterial({ color, roughness, clearcoat, clearcoatRoughness: 0.18 });
  const n = mx_fractal_noise_float(positionWorld.mul(scale), 3, 2.0, 0.5);
  m.roughnessNode = float(roughness).add(n.mul(breakup)).clamp(0.04, 1.0);
  return m;
}

// the room the plastics reflect: dim walls, a big window on the left, ceiling panels. Built here (not three's
// RoomEnvironment addon): the dev server's pre-bundler can give that addon its own copy of three, whose PointLight
// the WebGPU renderer does not know ("Multiple instances of Three.js"). Unlit materials only: no light needed.
export function roomEnvironment() {
  const room = new THREE.Scene();
  const panel = (k) => new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(k), side: THREE.BackSide });
  const walls = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 10), panel(0.75));
  walls.position.y = 2;
  room.add(walls);
  const light = (w, h, d, x, y, z, k) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(k) }));
    m.position.set(x, y, z);
    room.add(m);
  };
  light(0.1, 2.4, 4.0, -4.9, 2.2, 0.5, 9);     // the window, left
  light(3.0, 0.1, 2.0, 0.0, 4.4, 0.0, 5);      // ceiling panels
  light(1.5, 0.1, 1.5, 2.5, 4.4, -2.5, 3);
  light(4.0, 1.2, 0.1, 0.5, 1.6, 4.9, 1.6);    // a pale wall behind the viewer
  light(10, 0.1, 10, 0, -0.45, 0, 0.5);        // the floor, warm-ish grey
  return room;
}
