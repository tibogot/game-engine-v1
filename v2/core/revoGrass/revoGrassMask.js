import * as THREE from "three";

/** World-fixed fluffy-grass allowance mask (G channel, Revo grassMap style). */
export class RevoGrassMask {
  constructor(res = 512) {
    this.res = res;
    const data = new Uint8Array(res * res * 4);
    for (let i = 0; i < res * res; i++) {
      const o = i * 4;
      data[o] = 0;
      data[o + 1] = 255;
      data[o + 2] = 0;
      data[o + 3] = 255;
    }
    this.texture = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
  }

  stamp({ cx, cz, radius, strength, falloff, worldSize, erase }) {
    const res = this.res;
    const data = this.texture.image.data;
    const half = worldSize * 0.5;
    const rPx = (radius / worldSize) * res;
    const cxPx = ((cx + half) / worldSize) * res;
    const czPx = ((cz + half) / worldSize) * res;
    const r2 = rPx * rPx;
    const minX = Math.max(0, Math.floor(cxPx - rPx));
    const maxX = Math.min(res - 1, Math.ceil(cxPx + rPx));
    const minZ = Math.max(0, Math.floor(czPx - rPx));
    const maxZ = Math.min(res - 1, Math.ceil(czPx + rPx));

    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cxPx;
        const dz = z - czPx;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const t = Math.sqrt(d2) / rPx;
        const falloffWeight = Math.pow(Math.max(0, 1 - t), falloff);
        const idx = (z * res + x) * 4 + 1;
        if (erase) {
          const sub = strength * falloffWeight * 255;
          data[idx] = Math.max(0, data[idx] - sub);
        } else {
          const add = strength * falloffWeight * 255;
          data[idx] = Math.min(255, data[idx] + add);
        }
      }
    }
    this.texture.needsUpdate = true;
  }

  getSnapshot() {
    return new Uint8Array(this.texture.image.data);
  }

  restoreSnapshot(snapshot) {
    if (snapshot.length !== this.texture.image.data.length) return false;
    this.texture.image.data.set(snapshot);
    this.texture.needsUpdate = true;
    return true;
  }

  fillAllow() {
    const data = this.texture.image.data;
    for (let i = 0; i < this.res * this.res; i++) {
      data[i * 4 + 1] = 255;
    }
    this.texture.needsUpdate = true;
  }

  clearAllow() {
    const data = this.texture.image.data;
    for (let i = 0; i < this.res * this.res; i++) {
      data[i * 4 + 1] = 0;
    }
    this.texture.needsUpdate = true;
  }

  exportData() {
    const bytes = this.texture.image.data;
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return { res: this.res, dataB64: btoa(binary) };
  }

  importData(payload) {
    if (!payload?.dataB64) return false;
    const binary = atob(payload.dataB64);
    const expected = (payload.res ?? this.res) ** 2 * 4;
    if (binary.length !== expected) return false;
    const data = this.texture.image.data;
    for (let i = 0; i < binary.length; i++) {
      data[i] = binary.charCodeAt(i);
    }
    this.texture.needsUpdate = true;
    return true;
  }

  dispose() {
    this.texture.dispose();
  }
}
