// The gate arches (race.js gates): two posts and a beam across the road, standing on the deck.
// Checkpoint = bolt blue, finish = checkered, start = white. Shared by the drive page and the builder.
import * as THREE from "three";

let checker = null;
function checkerTexture() {
  if (checker) return checker;
  const c = document.createElement("canvas");
  c.width = 64; c.height = 16;
  const g = c.getContext("2d");
  for (let x = 0; x < 16; x++) for (let y = 0; y < 4; y++) { g.fillStyle = (x + y) % 2 ? "#0b0f1a" : "#f2f4f8"; g.fillRect(x * 4, y * 4, 4, 4); }
  checker = new THREE.CanvasTexture(c);
  checker.colorSpace = THREE.SRGBColorSpace;
  checker.magFilter = THREE.NearestFilter;
  return checker;
}

/** An AIR RING (race.js ring gate): a glowing hoop of radius g.hw, facing along the flight (g.T). */
export function makeRingMesh(g, { material = null } = {}) {
  const glow = material ?? new THREE.MeshStandardMaterial({ color: 0x3fd2ff, emissive: 0x3fd2ff, emissiveIntensity: 1.6, roughness: 0.4 });
  const hoop = new THREE.Mesh(new THREE.TorusGeometry(g.hw, 0.42, 10, 56), glow);
  const group = new THREE.Group();
  group.add(hoop);
  if (!material) {
    // four dark clamps so the hoop reads as an object, not a line
    const clamp = new THREE.MeshStandardMaterial({ color: 0x1a2236, roughness: 0.6, metalness: 0.3 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const m = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), clamp);
      m.position.set(Math.cos(a) * g.hw, Math.sin(a) * g.hw, 0);
      group.add(m);
    }
  }
  // the torus lies in its XY plane (axis Z): X across, Y up, Z along the flight
  const R = new THREE.Vector3().crossVectors(g.T, g.U).normalize();
  const U = new THREE.Vector3().crossVectors(R, g.T).normalize();
  group.matrixAutoUpdate = false;
  group.matrix.makeBasis(R, U, g.T.clone().normalize()).setPosition(g.P);
  group.userData.gate = g;
  return group;
}

/** @param g {kind, P, T, U, hw} — P is on (or 0.7 m above) the deck centre */
export function makeGateMesh(g, { height = 7.5, lift = 0.7 } = {}) {
  if (g.ring) return makeRingMesh(g);
  const group = new THREE.Group();
  const color = g.kind === "cp" ? 0x3fd2ff : 0xf2f4f8;
  const post = new THREE.MeshStandardMaterial({ color: 0x1a2236, roughness: 0.6, metalness: 0.3 });
  const glow = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: g.kind === "cp" ? 1.4 : 0.25, roughness: 0.5 });
  const banner = g.kind === "finish"
    ? new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.7 })
    : glow;
  const w = g.hw + 1.2; // posts just outside the guardrails
  for (const sx of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, height, 0.6), post);
    m.position.set(sx * w, height / 2, 0);
    group.add(m);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.2, height * 0.8, 0.64), glow);
    strip.position.set(sx * (w - 0.3), height * 0.45, 0);
    group.add(strip);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(w * 2 + 0.6, 1.4, 0.5), banner);
  beam.position.set(0, height - 0.7, 0);
  group.add(beam);
  // orient: local X across the road, Y up the deck, Z along the travel (the arch faces the car)
  const R = new THREE.Vector3().crossVectors(g.T, g.U).normalize();
  const U = new THREE.Vector3().crossVectors(R, g.T).normalize();
  group.matrixAutoUpdate = false;
  group.matrix.makeBasis(R, U, g.T.clone().normalize()).setPosition(g.P.clone().addScaledVector(U, -lift)); // lift: how far above the deck g.P is (drive ride: 0.7)
  group.userData.gate = g;
  return group;
}
