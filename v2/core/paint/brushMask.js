/**
 * BrushMask — loads PNG/JPG images as grayscale brush stamps for paint mode.
 *
 * Data: Float32Array of 0-1 grayscale, square dimensions.
 * Includes bilinear sampling and built-in procedural masks.
 */
export class BrushMask {
  constructor() {
    /** @type {Float32Array|null} */
    this.data = null;
    this.size = 0;
    this.name = "None";
    this.active = false;
    this._onChange = null;
  }

  setOnChange(fn) {
    this._onChange = fn;
  }

  _notify() {
    if (this._onChange) this._onChange();
  }

  async loadFromFile(file) {
    const bitmap = await createImageBitmap(file);
    const size = Math.max(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(bitmap, 0, 0, size, size);
    bitmap.close();
    const imageData = ctx.getImageData(0, 0, size, size);
    const pixels = imageData.data;
    const gray = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) {
      const r = pixels[i * 4];
      const g = pixels[i * 4 + 1];
      const b = pixels[i * 4 + 2];
      const a = pixels[i * 4 + 3];
      gray[i] = ((0.299 * r + 0.587 * g + 0.114 * b) / 255) * (a / 255);
    }
    this.data = gray;
    this.size = size;
    this.name = file.name.replace(/\.[^.]+$/, "");
    this.active = true;
    this._notify();
  }

  generateBuiltin(type, resolution = 128) {
    if (type === "none") {
      this.clear();
      return;
    }
    const data = new Float32Array(resolution * resolution);
    const half = resolution * 0.5;
    const invHalf = 1 / half;

    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        const nx = (x - half + 0.5) * invHalf;
        const ny = (y - half + 0.5) * invHalf;
        const d = Math.sqrt(nx * nx + ny * ny);
        const idx = y * resolution + x;

        switch (type) {
          case "soft":
            data[idx] = d < 1 ? Math.exp(-d * d * 4) : 0;
            break;
          case "hard":
            data[idx] =
              d < 0.85 ? 1 : d < 1 ? Math.max(0, (1 - d) / 0.15) : 0;
            break;
          case "splatter": {
            let v = 0;
            const seeds = [
              [0.0, 0.0, 0.35],
              [0.2, 0.3, 0.15],
              [-0.3, 0.1, 0.2],
              [0.1, -0.25, 0.18],
              [-0.15, -0.3, 0.12],
              [0.35, -0.1, 0.14],
              [-0.05, 0.4, 0.1],
              [0.25, 0.25, 0.1],
              [-0.3, -0.15, 0.16],
              [0.15, -0.4, 0.08],
              [-0.4, 0.25, 0.09],
              [0.4, 0.3, 0.07],
            ];
            for (const [sx, sy, sr] of seeds) {
              const dd = Math.sqrt((nx - sx) ** 2 + (ny - sy) ** 2);
              if (dd < sr) v = Math.max(v, 1 - dd / sr);
            }
            data[idx] = v;
            break;
          }
          case "grunge": {
            if (d >= 1) {
              data[idx] = 0;
              break;
            }
            let s = 0,
              amp = 1,
              freq = 4,
              totalAmp = 0;
            for (let o = 0; o < 4; o++) {
              const gx = Math.floor(nx * freq + 50);
              const gy = Math.floor(ny * freq + 50);
              const fx = nx * freq + 50 - gx;
              const fy = ny * freq + 50 - gy;
              const v00 = _hash(gx, gy);
              const v10 = _hash(gx + 1, gy);
              const v01 = _hash(gx, gy + 1);
              const v11 = _hash(gx + 1, gy + 1);
              const v =
                v00 * (1 - fx) * (1 - fy) +
                v10 * fx * (1 - fy) +
                v01 * (1 - fx) * fy +
                v11 * fx * fy;
              s += v * amp;
              totalAmp += amp;
              amp *= 0.5;
              freq *= 2;
            }
            s /= totalAmp;
            const edge = Math.max(0, 1 - d);
            data[idx] = s * Math.min(1, edge * 3);
            break;
          }
          default:
            data[idx] = d < 1 ? 1 - d : 0;
        }
      }
    }

    this.data = data;
    this.size = resolution;
    this.name = type.charAt(0).toUpperCase() + type.slice(1);
    this.active = true;
    this._notify();
  }

  clear() {
    this.data = null;
    this.size = 0;
    this.name = "None";
    this.active = false;
    this._notify();
  }

  renderPreview(canvas) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!this.data || !this.active) {
      ctx.fillStyle = "#222";
      ctx.fillRect(0, 0, w, h);
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, w * 0.4, 0, Math.PI * 2);
      const grad = ctx.createRadialGradient(
        w / 2,
        h / 2,
        0,
        w / 2,
        h / 2,
        w * 0.4,
      );
      grad.addColorStop(0, "#fff");
      grad.addColorStop(1, "#444");
      ctx.fillStyle = grad;
      ctx.fill();
      return;
    }
    const img = ctx.createImageData(w, h);
    const s = this.size;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = (x / w) * (s - 1);
        const sy = (y / h) * (s - 1);
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const x1 = Math.min(x0 + 1, s - 1);
        const y1 = Math.min(y0 + 1, s - 1);
        const tx = sx - x0;
        const ty = sy - y0;
        const v =
          this.data[y0 * s + x0] * (1 - tx) * (1 - ty) +
          this.data[y0 * s + x1] * tx * (1 - ty) +
          this.data[y1 * s + x0] * (1 - tx) * ty +
          this.data[y1 * s + x1] * tx * ty;
        const c = Math.round(v * 255);
        const i = (y * w + x) * 4;
        img.data[i] = c;
        img.data[i + 1] = c;
        img.data[i + 2] = c;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
}

function _hash(x, y) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}
