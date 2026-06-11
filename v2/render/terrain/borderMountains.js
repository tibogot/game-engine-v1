import * as THREE from "three";

// ── Smooth value noise with quintic interpolation ───────────────────────

function _hash(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function _sn(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  return (
    _hash(ix, iy) * (1 - u) * (1 - v) +
    _hash(ix + 1, iy) * u * (1 - v) +
    _hash(ix, iy + 1) * (1 - u) * v +
    _hash(ix + 1, iy + 1) * u * v
  );
}

function _fbm(x, y, oct) {
  let s = 0, a = 0.5, f = 1, m = 0;
  for (let i = 0; i < oct; i++) {
    s += _sn(x * f, y * f) * a;
    m += a;
    a *= 0.5;
    f *= 2.0;
  }
  return s / m;
}

// ── Height sampling ─────────────────────────────────────────────────────

function borderHeightAt(wx, wz, half, terrainStore, p) {
  const edgeX = Math.max(-half, Math.min(half, wx));
  const edgeZ = Math.max(-half, Math.min(half, wz));

  const dx = Math.max(0, Math.abs(wx) - half);
  const dz = Math.max(0, Math.abs(wz) - half);
  const dist = Math.sqrt(dx * dx + dz * dz);

  const edgeH = terrainStore.getChunkHeightfieldHeight(edgeX, edgeZ);

  if (dist <= 0) return edgeH;

  const t = Math.min(1, dist / p.extent);
  const rise = Math.pow(t, p.steepness);

  const seed = p.seed * 100;
  const freq = p.noiseScale * 0.005;

  const macro = _fbm(wx * freq * 0.15 + seed, wz * freq * 0.15 + seed + 50, 2);
  const macroShaped = Math.pow(Math.max(0, macro * 1.5 - 0.2), 1.2);

  const detail = _fbm(
    wx * freq + seed + 7.3,
    wz * freq + seed + 13.1,
    Math.round(p.noiseOctaves),
  );

  const noise = macroShaped * (0.55 + 0.45 * detail);

  return edgeH + rise * p.height * noise;
}

const _nEps = 2.0;
const _nVec = new THREE.Vector3();

function borderNormalAt(wx, wz, half, terrainStore, p, out) {
  const hL = borderHeightAt(wx - _nEps, wz, half, terrainStore, p);
  const hR = borderHeightAt(wx + _nEps, wz, half, terrainStore, p);
  const hD = borderHeightAt(wx, wz - _nEps, half, terrainStore, p);
  const hU = borderHeightAt(wx, wz + _nEps, half, terrainStore, p);
  const inv = 1 / (2 * _nEps);
  out.set((hL - hR) * inv, 1, (hD - hU) * inv).normalize();
}

// ── Geometry builder ────────────────────────────────────────────────────

function buildRingGeometry(half, terrainStore, params) {
  const extent = params.extent;
  const halfExt = half + extent;
  const segSize = 25;

  const segsEdge = Math.max(4, Math.ceil((half * 2) / segSize));
  const segsExt = Math.max(2, Math.ceil(extent / segSize));

  const allPos = [];
  const allNrm = [];
  const allUv = [];
  const allIdx = [];
  let vertOff = 0;

  function addPatch(xMin, xMax, zMin, zMax, segsX, segsZ) {
    const base = vertOff;
    const wX = segsX + 1;

    for (let iz = 0; iz <= segsZ; iz++) {
      const z = zMin + (iz / segsZ) * (zMax - zMin);
      for (let ix = 0; ix <= segsX; ix++) {
        const x = xMin + (ix / segsX) * (xMax - xMin);
        const y = borderHeightAt(x, z, half, terrainStore, params);
        allPos.push(x, y, z);

        borderNormalAt(x, z, half, terrainStore, params, _nVec);
        allNrm.push(_nVec.x, _nVec.y, _nVec.z);

        allUv.push((x + halfExt) / (halfExt * 2), (z + halfExt) / (halfExt * 2));
      }
    }

    for (let iz = 0; iz < segsZ; iz++) {
      for (let ix = 0; ix < segsX; ix++) {
        const a = base + iz * wX + ix;
        const b = a + 1;
        const c = a + wX;
        const d = c + 1;
        allIdx.push(a, c, b, b, c, d);
      }
    }

    vertOff += wX * (segsZ + 1);
  }

  // 4 side strips
  addPatch(-half, half, half, halfExt, segsEdge, segsExt);   // North
  addPatch(-half, half, -halfExt, -half, segsEdge, segsExt);  // South
  addPatch(half, halfExt, -half, half, segsExt, segsEdge);    // East
  addPatch(-halfExt, -half, -half, half, segsExt, segsEdge);  // West

  // 4 corner patches
  addPatch(half, halfExt, half, halfExt, segsExt, segsExt);      // NE
  addPatch(-halfExt, -half, half, halfExt, segsExt, segsExt);    // NW
  addPatch(half, halfExt, -halfExt, -half, segsExt, segsExt);    // SE
  addPatch(-halfExt, -half, -halfExt, -half, segsExt, segsExt);  // SW

  const geo = new THREE.BufferGeometry();
  geo.setIndex(allIdx);
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(allPos), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(allNrm), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(allUv), 2));
  // The tile material's opacityNode reads `aSkirt` (shared with terrain chunks).
  // Border mountains have no skirt, so fill zeros — keeps the WebGPU pipeline
  // layout consistent with the terrain meshes that DO have a skirt.
  geo.setAttribute(
    "aSkirt",
    new THREE.BufferAttribute(new Float32Array(allPos.length / 3), 1),
  );
  geo.computeBoundingSphere();

  return geo;
}

// ── Public API ──────────────────────────────────────────────────────────

export class BorderMountains {
  constructor(config) {
    this.config = config;
    this.group = new THREE.Group();
    this.group.name = "borderMountains";
    this.mesh = null;
    this.material = null;
  }

  rebuild(terrainStore, params, onMeshCreated) {
    this.dispose();
    if (!params.enabled) return;

    const half = this.config.world.size / 2;
    const geometry = buildRingGeometry(half, terrainStore, params);

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    if (onMeshCreated) onMeshCreated(this.mesh);
  }

  setMaterial(mat) {
    this.material = mat;
    if (this.mesh) this.mesh.material = mat;
  }

  dispose() {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.group.remove(this.mesh);
      this.mesh = null;
    }
  }
}
