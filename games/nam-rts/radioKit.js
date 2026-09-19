// Procedural radio / relay meshes — shared by the Radio Station and Capture Nodes.
//
// One merged static shell per variant (1 draw + shadow), plus a few emissive
// bloom parts (dish rim, beacon, ground ring) — same pattern as structuresRenderer.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { materialColor } from "three/tsl";
import { makeBloomMaterial, BLOOM } from "./bloom.js";

const C_CONCRETE = 0x4a5058;
const C_POLE = 0x3a4048;
const C_ARM = 0x505860;
const C_DISH = 0x6a7078;

function paint(geo, hex) {
  const c = new THREE.Color(hex);
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

function structureMat() {
  const m = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 0.82,
    metalness: 0.28,
    vertexColors: true,
  });
  m.colorNode = materialColor;
  return m;
}

/**
 * Build a satellite-relay tower.
 * @param {"radio"|"capture"} variant — radio is taller; capture has a wider pad.
 */
export function buildRadioTower(variant = "radio") {
  const group = new THREE.Group();
  const scale = variant === "radio" ? 1 : 0.82;
  const shell = [];
  const add = (geo, hex) => shell.push(paint(geo, hex));

  const padR = variant === "radio" ? 7.5 : 9;
  add(new THREE.CylinderGeometry(padR, padR + 0.6, 0.8, 24).translate(0, 0.4, 0), C_CONCRETE);
  add(new THREE.CylinderGeometry(0.35 * scale, 0.5 * scale, 14 * scale, 10).translate(0, 7.5 * scale, 0), C_POLE);

  add(new THREE.BoxGeometry(5 * scale, 0.35, 0.35).translate(0, 11 * scale, 0), C_ARM);
  add(new THREE.BoxGeometry(0.35, 0.35, 4 * scale).translate(0, 11 * scale, 0), C_ARM);

  const dish = new THREE.SphereGeometry(2.4 * scale, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.42);
  dish.rotateX(-Math.PI / 2);
  dish.translate(0, 12.5 * scale, 1.2 * scale);
  add(dish, C_DISH);

  add(new THREE.BoxGeometry(1.4, 1.0, 0.9).translate(0.9, 8.5 * scale, 0), C_ARM);

  const merged = mergeGeometries(shell, false);
  if (!merged) throw new Error("[radioKit] merge failed");
  const body = new THREE.Mesh(merged, structureMat());
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const lip = new THREE.Mesh(
    new THREE.TorusGeometry(2.35 * scale, 0.12, 8, 28),
    makeBloomMaterial({ color: 0x7ae8ff, blending: THREE.NormalBlending, depthWrite: true, transparent: false }, BLOOM.beacon),
  );
  lip.rotation.x = Math.PI / 2;
  lip.position.set(0, 12.5 * scale, 1.2 * scale);
  group.add(lip);

  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.55 * scale, 12, 10),
    makeBloomMaterial({ color: 0xff6a4a, blending: THREE.NormalBlending, depthWrite: true, transparent: false }, BLOOM.beacon * 1.15),
  );
  beacon.position.set(0, 14.8 * scale, 0);
  group.add(beacon);

  let ring = null;
  if (variant === "capture") {
    ring = new THREE.Mesh(
      new THREE.TorusGeometry(padR - 0.8, 0.22, 8, 40),
      makeBloomMaterial({ color: 0x48c8ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85 }, BLOOM.beacon),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.12;
    group.add(ring);
  }

  group.userData.height = 16 * scale;
  group.userData.beacon = beacon;
  group.userData.lip = lip;
  group.userData.ring = ring;
  group.userData.variant = variant;
  return group;
}
