// ONE WIND for the Algeria game: the flags, the windsock and, later, smoke,
// dust and the sandstorm all read the same direction and strength, so they
// never disagree on screen.
//
// Direction is in degrees in the flags' own convention (v2 flagFactory: the
// cloth is pushed along world (cos d, 0, sin d)). Strength 0..1: 0 = still,
// 1 = a strong sirocco. Gusts ride on top.
import * as THREE from "three";
import { rtsObjectMaterialTinted } from "../../v3/render/objects/rtsObjectProps.js";
import { FR_PAINT_TINT } from "../../v3/render/objects/rtsVehiclesFr.js";

export function createWind({ dirDeg = 200, strength = 0.55, gust = 0.6 } = {}) {
  const w = {
    dirDeg, strength, gust,
    /** Wind speed 0..~1.4 at time t (s): the strength with slow gusts on it. */
    speed(t) {
      const g = 0.35 * Math.sin(t * 0.7) + 0.25 * Math.sin(t * 1.9 + 1.3) + 0.1 * Math.sin(t * 5.3 + 0.4);
      return Math.max(0, w.strength * (1 + w.gust * g));
    },
    /** Direction in radians, with a small gusty swing. */
    dirRad(t) {
      return (w.dirDeg * Math.PI) / 180 + w.gust * (0.12 * Math.sin(t * 0.43 + 2) + 0.05 * Math.sin(t * 1.7));
    },
    listeners: new Set(),
    /** Change the wind; flags and anything else subscribed follow. */
    set(p) { Object.assign(w, p); for (const f of w.listeners) f(w); },
    onChange(f) { w.listeners.add(f); f(w); return () => w.listeners.delete(f); },
  };
  return w;
}


const RINGS = 16, SEGS = 14, COLS = SEGS + 1;   // COLS: the UV seam needs its column twice

let _sockTex = null;
/**
 * The sock's cloth: five crisp bands (red at both ends), sun-faded, a nylon
 * weave, a stitched seam at every band edge. A texture, not vertex colours:
 * colours on 8 rings smeared into pink gradients (you saw it).
 */
function sockTexture() {
  if (_sockTex) return _sockTex;
  const W = 64, H = 512, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d"), img = g.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) {
    const v = y / H, band = Math.min(4, Math.floor(v * 5)), edge = Math.abs(v * 5 - Math.round(v * 5));
    const red = band % 2 === 0;
    for (let x = 0; x < W; x++) {
      // Weave: fine threads both ways, plus a little per-pixel grain.
      const weave = ((x % 2) ^ (y % 2)) * 6 + (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453 % 1) * 8;
      let r = red ? 184 : 232, gg = red ? 52 : 226, b = red ? 44 : 212;
      r += weave - 7; gg += weave - 7; b += weave - 7;
      // Stitching along the band edges.
      if (edge < 0.012) { r *= 0.72; gg *= 0.72; b *= 0.72; }
      const i = (y * W + x) * 4;
      d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  _sockTex = new THREE.CanvasTexture(c);
  _sockTex.colorSpace = THREE.SRGBColorSpace;
  _sockTex.anisotropy = 4;
  return _sockTex;
}

/**
 * A windsock that turns into the wind, fills and lifts with its speed,
 * droops limp when it dies, and ripples toward the tail. Not a cloth sim:
 * ~450 vertices placed along a bending axis each frame (CPU, ~0.03 ms).
 *
 * Smooth by construction: the cloth reacts to a LOW-PASSED wind speed, and
 * its waves run on ACCUMULATED phases (a phase of time × speed jumps every
 * time the speed changes — that was the jitter).
 *
 * `spec` is the helipad's `userData.windsock` (its frame); `mesh` the placed
 * helipad. Returns { group, update(dt) }.
 */
export function createWindsock(app, mesh, spec, wind) {
  mesh.updateMatrixWorld(true);
  const group = new THREE.Group();
  group.position.copy(mesh.localToWorld(new THREE.Vector3(...spec.pivot)));
  const swivel = new THREE.Mesh(spec.swivel, rtsObjectMaterialTinted(FR_PAINT_TINT));
  swivel.castShadow = true;
  group.add(swivel);

  // Two skins in one geometry, outer and (reversed, a hair smaller) inner, so
  // the open mouth shows the inside without DoubleSide (which renders black).
  const nPer = RINGS * COLS, pos = new Float32Array(nPer * 2 * 3), uv = new Float32Array(nPer * 2 * 2);
  const idx = [];
  for (let skin = 0; skin < 2; skin++) {
    const o = skin * nPer;
    for (let r = 0; r < RINGS - 1; r++) for (let s = 0; s < SEGS; s++) {
      const a = o + r * COLS + s, b = a + 1, c = a + COLS, d = b + COLS;
      if (skin === 0) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
    }
    for (let r = 0; r < RINGS; r++) for (let s = 0; s < COLS; s++) {
      const k = (o + r * COLS + s) * 2;
      uv[k] = s / SEGS; uv[k + 1] = 1 - r / (RINGS - 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const cloth = new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial({ map: sockTexture(), roughness: 0.82, metalness: 0 }));
  cloth.name = "Windsock";
  cloth.castShadow = true;
  cloth.frustumCulled = false;       // the bounds move every frame
  cloth.position.x = spec.mouth;
  group.add(cloth);
  app.scene.add(group);

  let t = Math.random() * 100, yaw = -wind.dirRad(t), speed = wind.speed(t), fill = 0.5;
  let phFlap = 0, phRipple = 0;
  const nrm = () => geo.attributes.normal;
  function update(dt) {
    dt = Math.min(dt, 0.1);
    t += dt;
    // Cloth has weight: it follows the wind slowly, the direction slower still.
    speed += (wind.speed(t) - speed) * Math.min(1, dt * 1.2);
    const target = -wind.dirRad(t);
    let dy = target - yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    yaw += dy * Math.min(1, dt * 1.5);
    group.rotation.y = yaw;
    fill += (THREE.MathUtils.smoothstep(speed, 0.06, 0.85) - fill) * Math.min(1, dt * 1.5);
    phFlap += dt * (2.2 + 4.5 * speed);
    phRipple += dt * (4 + 6 * speed);

    const L = spec.length, step = L / (RINGS - 1);
    let cx = 0, cy = 0;
    for (let r = 0; r < RINGS; r++) {
      const u = r / (RINGS - 1);
      if (r) {
        // The axis bends down along its length when the sock is slack.
        const ang = THREE.MathUtils.lerp(1.3, 0.05, fill) + (1 - fill) * 0.35 * u;
        cx += Math.cos(ang) * step; cy -= Math.sin(ang) * step;
      }
      // A slow side-to-side flap running down the cloth, strongest at the tail.
      const amp = L * 0.045 * u * u * (0.3 + fill);
      const wv = phFlap - u * 3.2;
      const cz = Math.sin(wv) * amp, cyy = cy + Math.sin(wv * 0.7 + 1) * amp * 0.35;
      // Radius: tapers to the tail; an empty sock collapses from the tail.
      const rad = THREE.MathUtils.lerp(spec.mouthR, spec.tailR, u) * THREE.MathUtils.lerp(1 - 0.55 * u, 1, fill);
      for (let s = 0; s < COLS; s++) {
        const a = (s / SEGS) * Math.PI * 2;
        // Ripples round the cloth, small, only when it is full.
        const rr = rad * (1 + 0.035 * u * fill * Math.sin(3 * a + phRipple - u * 6));
        const y = Math.cos(a) * rr, z = Math.sin(a) * rr;
        const i = (r * COLS + s) * 3, j = i + nPer * 3;
        pos[i] = cx; pos[i + 1] = cyy + y; pos[i + 2] = cz + z;
        pos[j] = cx; pos[j + 1] = cyy + y * 0.96; pos[j + 2] = cz + z * 0.96;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
    // Weld the seam's normals (its column is doubled for the UVs).
    const n = nrm().array;
    for (let skin = 0; skin < 2; skin++) for (let r = 0; r < RINGS; r++) {
      const a = (skin * nPer + r * COLS) * 3, b = a + SEGS * 3;
      for (let k = 0; k < 3; k++) { const m = (n[a + k] + n[b + k]) * 0.5; n[a + k] = m; n[b + k] = m; }
    }
  }
  update(0);
  return { group, update };
}
