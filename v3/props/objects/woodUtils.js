import * as THREE from "three";

/** @param {number} seed @param {number} index */
export function seededRand(seed, index) {
  const x = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function makeWoodMaterial(p, color) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: p.roughness,
    metalness: p.metalness,
    flatShading: !!p.flatShading,
  });
}

export function pickWoodColor(p, rand) {
  const main = new THREE.Color(p.colorMain);
  const alt = new THREE.Color(p.colorAlt);
  const t = Math.pow(rand, 0.85) * Math.max(0, p.colorVariation);
  return main.lerp(alt, t);
}
