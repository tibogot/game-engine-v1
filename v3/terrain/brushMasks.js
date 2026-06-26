import * as THREE from "three";

const N = 128;

function makeTex(fn) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = Math.max(0, Math.min(1, fn(x / N, y / N))) * 255 | 0;
      const i = (y * N + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

// Matches original radial falloff: 1 at center, 0 at edge, linear.
// uFalloff exponent still applies on top in the shader.
function soft(nx, ny) {
  const dx = nx - 0.5, dy = ny - 0.5;
  const r = Math.sqrt(dx * dx + dy * dy) * 2; // 0=center, 1=edge
  return Math.max(0, 1 - r);
}

function hard(nx, ny) {
  const dx = nx - 0.5, dy = ny - 0.5;
  return Math.sqrt(dx * dx + dy * dy) * 2 < 1 ? 1 : 0;
}

function diamond(nx, ny) {
  const dx = Math.abs(nx - 0.5), dy = Math.abs(ny - 0.5);
  return Math.max(0, 1 - (dx + dy) * 2);
}

// 12 overlapping circles scattered within the brush area — looks organic and
// irregular. Positions/radii hardcoded for a consistently good default look.
const SPLATTER_CIRCLES = [
  [0.50, 0.50, 0.22],
  [0.25, 0.28, 0.10],
  [0.72, 0.22, 0.08],
  [0.32, 0.72, 0.11],
  [0.68, 0.68, 0.09],
  [0.18, 0.52, 0.07],
  [0.78, 0.42, 0.10],
  [0.42, 0.18, 0.08],
  [0.58, 0.80, 0.07],
  [0.15, 0.35, 0.06],
  [0.82, 0.58, 0.06],
  [0.38, 0.38, 0.08],
];

function splatter(nx, ny) {
  const dx0 = nx - 0.5, dy0 = ny - 0.5;
  if (Math.sqrt(dx0 * dx0 + dy0 * dy0) * 2 > 1) return 0;
  let v = 0;
  for (const [cx, cy, r] of SPLATTER_CIRCLES) {
    const dx = nx - cx, dy = ny - cy;
    const d = Math.sqrt(dx * dx + dy * dy) / r;
    if (d < 1) v = Math.max(v, 1 - d);
  }
  return v;
}

function grunge(nx, ny) {
  const dx = nx - 0.5, dy = ny - 0.5;
  const circle = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 2);
  let v = 0, amp = 0.5, freq = 3;
  for (let o = 0; o < 4; o++, amp *= 0.5, freq *= 2) {
    const px = nx * freq, py = ny * freq;
    const h = ((Math.sin(px * 127.1 + py * 311.7) * 43758.5453) % 1 + 1) % 1;
    v += h * amp;
  }
  return Math.min(1, v * circle * 1.8);
}

export const BRUSH_MASKS = {
  soft:     () => makeTex(soft),
  hard:     () => makeTex(hard),
  square:   () => makeTex(() => 1),
  diamond:  () => makeTex(diamond),
  splatter: () => makeTex(splatter),
  grunge:   () => makeTex(grunge),
};

export async function loadMaskPNG() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    const cleanup = (result) => { resolve(result); input.remove(); };
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return cleanup(null);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const tex = new THREE.Texture(img);
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = tex.magFilter = THREE.LinearFilter;
        tex.needsUpdate = true;
        cleanup(tex);
        URL.revokeObjectURL(url);
      };
      img.onerror = () => cleanup(null);
      img.src = url;
    });
    input.addEventListener("cancel", () => cleanup(null));
    document.body.appendChild(input);
    input.click();
  });
}
