// Burning wrecks — GAME code. Instanced flame blobs with the rts-chibs fire
// recipe: triplanar noise erosion over a per-blob life, hot→orange→dark colour
// ramp, additive, written into the emissive MRT buffer so it blooms.
//
// Self-contained: the cellular noise texture is generated on a canvas rather
// than loaded, so there's no asset to ship.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  attribute, positionLocal, normalLocal, normalWorld, positionWorld,
  cameraPosition, texture, uniform, float, vec2, vec3, mix, smoothstep, dot, output, vec4,
} from "three/tsl";

const MAX_BLOBS = 160;

/** Same MRT fallback as bloom.js — a plain RT has no `emissive` attachment. */
class FireMRTNode extends THREE.MRTNode {
  static get type() { return "FireMRTNode"; }
  setup(builder) {
    const textures = builder.renderer.getRenderTarget()?.textures;
    const anyNamed = !!textures && textures.some((t) => this.outputNodes[t.name] !== undefined);
    if (anyNamed) return super.setup(builder);
    this.members = [vec4(output)];
    return THREE.Node.prototype.setup.call(this, builder);
  }
}

/** Cellular (voronoi-ish) noise → a repeating texture, generated at runtime. */
function makeNoiseTexture(size = 256, cells = 8) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);

  // Seed points on a wrapping grid so the texture tiles.
  const pts = [];
  for (let gy = 0; gy < cells; gy++) {
    for (let gx = 0; gx < cells; gx++) {
      pts.push([(gx + Math.random()) / cells, (gy + Math.random()) / cells]);
    }
  }
  const step = 1 / cells;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ux = x / size, uy = y / size;
      let best = 1e9;
      for (const [px, py] of pts) {
        // wrap-aware distance
        let dx = Math.abs(ux - px); if (dx > 0.5) dx = 1 - dx;
        let dy = Math.abs(uy - py); if (dy > 0.5) dy = 1 - dy;
        const d = dx * dx + dy * dy;
        if (d < best) best = d;
      }
      const v = Math.min(1, Math.sqrt(best) / (step * 1.1));
      const c = (v * 255) | 0;
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = c;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** A lumpy blob — three overlapping icospheres, like the chibs flame. */
function makeBlobGeometry() {
  const a = new THREE.IcosahedronGeometry(1.0, 2);
  const b = new THREE.IcosahedronGeometry(0.8, 2).translate(0.95, 0.45, 0.15);
  const c = new THREE.IcosahedronGeometry(0.78, 2).translate(-0.7, 0.55, -0.35);
  const g = mergeGeometries([a, b, c]);
  g.deleteAttribute("uv");
  g.center();
  return g;
}

export function createFireSystem({ app }) {
  const { scene } = app;
  const noise = makeNoiseTexture();

  const u = {
    time:         uniform(0),
    tiling:       uniform(0.42),
    panSpeed:     uniform(0.55),
    holeDepth:    uniform(0.85),
    edgeNoise:    uniform(0.35),
    cutoff:       uniform(0.18),
    erode:        uniform(0.62),
    fadeIn:       uniform(0.12),
    dissolveSoft: uniform(0.22),
    opacity:      uniform(1.0),
    midPoint:     uniform(0.42),
    intensity:    uniform(2.6), // HDR > 1 → the emissive buffer, i.e. bloom
    colHot:       uniform(new THREE.Color(0xfff0a8)),
    colMid:       uniform(new THREE.Color(0xff7418)),
    colTip:       uniform(new THREE.Color(0x481003)),
  };

  const geo = makeBlobGeometry();
  const iSeedArr = new Float32Array(MAX_BLOBS);
  const iLifeArr = new Float32Array(MAX_BLOBS);
  const iSeedAttr = new THREE.InstancedBufferAttribute(iSeedArr, 1);
  const iLifeAttr = new THREE.InstancedBufferAttribute(iLifeArr, 1);
  iLifeAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("iSeed", iSeedAttr);
  geo.setAttribute("iLife", iLifeAttr);

  // ── Material: triplanar noise erosion + life colour ramp (chibs recipe) ─────
  const iSeed = attribute("iSeed", "float");
  const iLife = attribute("iLife", "float");

  const p = positionLocal.mul(u.tiling);
  const aN = normalLocal.abs();
  const bl = aN.div(aN.x.add(aN.y).add(aN.z).add(0.0001));
  const t = u.time.mul(u.panSpeed);
  const off = vec2(iSeed, iSeed.mul(1.7)).add(vec2(t.mul(0.3), t.negate()));
  const sX = texture(noise, p.yz.add(off)).r;
  const sY = texture(noise, p.xz.add(off)).r;
  const sZ = texture(noise, p.xy.add(off)).r;
  const V = sX.mul(bl.x).add(sY.mul(bl.y)).add(sZ.mul(bl.z));

  const N = normalWorld.normalize();
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const facing = dot(N, viewDir).clamp(0, 1);

  const holed = facing.mul(mix(float(1), V, u.holeDepth));
  const edged = holed.add(V.sub(0.5).mul(u.edgeNoise));
  const thr = u.cutoff.add(iLife.mul(u.erode));
  const fadeIn = smoothstep(float(0), u.fadeIn, iLife);
  const alpha = smoothstep(thr, thr.add(u.dissolveSoft), edged).mul(fadeIn).mul(u.opacity);

  const c1 = mix(vec3(u.colHot), vec3(u.colMid), smoothstep(float(0), u.midPoint, iLife));
  const ramp = mix(c1, vec3(u.colTip), smoothstep(u.midPoint, float(1), iLife));
  const col = ramp.mul(u.intensity);

  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  mat.colorNode = col;
  mat.opacityNode = alpha;
  // Full HDR ramp into emissive (no ×alpha) — alpha only gates the beauty pass.
  mat.mrtNode = new FireMRTNode({ emissive: col });

  const mesh = new THREE.InstancedMesh(geo, mat, MAX_BLOBS);
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = MAX_BLOBS;
  scene.add(mesh);

  // ── Blob pool ───────────────────────────────────────────────────────────────
  const blobs = [];
  for (let i = 0; i < MAX_BLOBS; i++) {
    blobs.push({ fire: null, life: 1, speed: 1, size: 1, x: 0, y: 0, z: 0, vy: 0, drift: 0 });
    iSeedArr[i] = Math.random() * 10;
  }
  iSeedAttr.needsUpdate = true;

  const fires = [];   // { x, y, z, radius, timeLeft }
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const _p = new THREE.Vector3();
  const HIDDEN = new THREE.Vector3(0, -99999, 0);

  function respawn(b, fire) {
    b.fire = fire;
    b.life = 0;
    b.speed = 0.45 + Math.random() * 0.5;
    b.size = fire.radius * (0.35 + Math.random() * 0.45);
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * fire.radius * 0.55;
    b.x = fire.x + Math.cos(a) * r;
    b.z = fire.z + Math.sin(a) * r;
    b.y = fire.y + Math.random() * 0.6;
    b.vy = fire.radius * (0.5 + Math.random() * 0.6);
    b.drift = (Math.random() - 0.5) * 0.6;
  }

  /** Start a fire (a burning wreck). */
  function addFire(x, y, z, radius = 3, duration = 12) {
    const fire = { x, y, z, radius, timeLeft: duration };
    fires.push(fire);
    // Claim a share of the pool for it.
    let claimed = 0;
    const want = Math.min(26, Math.round(radius * 7));
    for (const b of blobs) {
      if (claimed >= want) break;
      if (!b.fire) { respawn(b, fire); claimed++; }
    }
    return fire;
  }

  function update(dt, elapsed) {
    u.time.value = elapsed;

    for (let i = fires.length - 1; i >= 0; i--) {
      fires[i].timeLeft -= dt;
      if (fires[i].timeLeft <= 0) fires.splice(i, 1);
    }

    for (let i = 0; i < MAX_BLOBS; i++) {
      const b = blobs[i];
      if (!b.fire) {
        _m.compose(HIDDEN, _q.identity(), _s.set(0.001, 0.001, 0.001));
        mesh.setMatrixAt(i, _m);
        iLifeArr[i] = 1;
        continue;
      }

      b.life += dt * b.speed;
      if (b.life >= 1) {
        // Fire still burning? Recycle the blob. Otherwise release it.
        if (b.fire.timeLeft > 0) respawn(b, b.fire);
        else { b.fire = null; continue; }
      }

      b.y += b.vy * dt;
      b.x += b.drift * dt;
      const grow = 0.6 + b.life * 0.8;
      _p.set(b.x, b.y, b.z);
      _s.setScalar(b.size * grow);
      _m.compose(_p, _q.identity(), _s);
      mesh.setMatrixAt(i, _m);
      iLifeArr[i] = b.life;
    }

    mesh.instanceMatrix.needsUpdate = true;
    iLifeAttr.needsUpdate = true;
  }

  return { addFire, update, params: u };
}
