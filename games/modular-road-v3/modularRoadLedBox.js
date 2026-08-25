import * as THREE from "three";
import { materialColor } from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";

/**
 * Trackside LED chevron box — shallow square cabinet, no legs.
 *
 * Materials match every other v3 prop (`MeshStandardNodeMaterial` + `.color` +
 * `colorNode = materialColor`). MeshBasic with only a colour *node* is what
 * turned the placed copies white: the prop instancer is on in the editor, and
 * it (and InstancedMesh) read `.color`, which defaulted to white.
 *
 * Chevrons are real square cells with a gap, same construction as the boost-pad
 * pixel chevrons. No second plane on the face — that was the z-fight.
 */

export const LED_BOX_DEFAULTS = {
  size: 2.8,
  frameDepth: 0.38,
  cols: 21,
  rows: 21,
  /** Black bezel as a fraction of the face, each side. */
  inset: 0.05,
  colorFrame: 0x0a0a0c,
  colorLed: 0xd4ff28,
};

function propMat(hex, opts = {}) {
  const m = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(hex),
    roughness: opts.roughness ?? 1,
    metalness: opts.metalness ?? 0,
    emissive: new THREE.Color(opts.emissive ?? 0x000000),
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    side: opts.side ?? THREE.FrontSide,
  });
  m.envMapIntensity = 0;
  m.colorNode = materialColor;
  if (opts.bloom) applyBloomMRT(m, materialColor);
  return m;
}

/**
 * Two stacked down-V's, packed in the middle of the grid. Each arm is two
 * cells thick toward the centre — a hollow chevron, not a filled triangle.
 */
function litCells(cols, rows) {
  const lit = new Set();
  const cx = (cols - 1) >> 1;
  const arm = 8;
  const vH = arm + 1;
  const gap = 2;
  const pairH = vH * 2 + gap;
  const top = Math.max(0, Math.round((rows - pairH) / 2));

  const add = (c, r) => {
    if (c >= 0 && r >= 0 && c < cols && r < rows) lit.add(`${c},${r}`);
  };

  const paintV = (tip) => {
    for (let i = 0; i <= arm; i++) {
      const r = tip - i;
      add(cx - i, r);
      add(cx + i, r);
      if (i > 0) {
        add(cx - i + 1, r);
        add(cx + i - 1, r);
      }
    }
  };

  paintV(top + arm);
  paintV(top + vH + gap + arm);

  return [...lit].map((k) => {
    const [c, r] = k.split(",").map(Number);
    return { c, r };
  });
}

/**
 * @param {{ params?: object }} [o]
 * @returns {THREE.Group}
 */
export function buildLedChevronBoxMesh({ params = {} } = {}) {
  const p = { ...LED_BOX_DEFAULTS, ...params };
  const S = Math.max(0.8, p.size);
  const depth = Math.max(0.12, p.frameDepth);
  const cols = Math.max(8, Math.round(p.cols));
  const rows = Math.max(8, Math.round(p.rows));
  const inset = Math.max(0.04, Math.min(0.35, p.inset)) * S;
  const cy = S * 0.5;

  const frameZ = -depth / 2;
  const frameGeo = new THREE.BoxGeometry(S, S, depth);
  frameGeo.translate(0, cy, frameZ);

  const field = S - inset * 2;
  const cell = field / cols;
  // Square LEDs with a hairline gap. Cubes were wrong here: their side faces
  // stuck out past the cabinet and read as a green tab on the silhouette.
  // Front-facing quads sit just off the face (same trick as the boost-pad pixels).
  const led = cell * 0.78;
  const half = led * 0.5;
  const zLed = 0.02;
  const pos = [];
  const nrm = [];
  for (const { c, r } of litCells(cols, rows)) {
    const x = -field / 2 + (c + 0.5) * cell;
    const y = cy + field / 2 - (r + 0.5) * cell;
    pos.push(
      x - half, y - half, zLed, x + half, y - half, zLed, x + half, y + half, zLed,
      x - half, y - half, zLed, x + half, y + half, zLed, x - half, y + half, zLed,
    );
    for (let i = 0; i < 6; i++) nrm.push(0, 0, 1);
  }
  const ledsGeo = new THREE.BufferGeometry();
  ledsGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  ledsGeo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));

  const frame = new THREE.Mesh(frameGeo, propMat(p.colorFrame));
  frame.castShadow = true;
  frame.receiveShadow = false;
  const leds = new THREE.Mesh(
    ledsGeo,
    propMat(p.colorLed, {
      roughness: 0.35,
      emissive: p.colorLed,
      emissiveIntensity: 5,
      bloom: true,
      side: THREE.FrontSide,
    }),
  );
  leds.castShadow = false;
  leds.receiveShadow = false;
  leds.userData.noCastShadow = true;
  leds.userData.noCollide = true;

  const group = new THREE.Group();
  group.name = "LedChevronBox";
  group.add(frame, leds);
  return group;
}
