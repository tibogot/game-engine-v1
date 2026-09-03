/**
 * Hardscape: rocks, a driftwood branch, moss.
 *
 * All procedural and all deliberately stylised. Two things earn their keep here:
 *
 *   - The basking rock. It is the reason the lamp has anywhere to point, it gives the
 *     hot end a silhouette, and it throws the long shadow that makes the light legible.
 *     Take it out and the -X half of the tank is an empty slope.
 *   - Moss. Fuzzy things read as alive. A wrap-lit rim on a low green mound costs almost
 *     nothing and stops the enclosure looking sterile.
 *
 * The plants are the weakest part of this page and I would rather say so than pretend:
 * procedural foliage is an art problem more than a code one, and these are placeholders
 * that fill space honestly rather than fake ones that fall apart up close.
 */
import * as THREE from "three/webgpu";
import {
  vec3, float, uniform, positionWorld, normalWorld, cameraPosition,
  normalize, dot, abs, pow, clamp, mix, oneMinus, smoothstep, mx_noise_float,
} from "three/tsl";
import { substrateHeight, BASK, DISH } from "./terrariumSubstrate.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { TANK } from "./terrariumGlass.js";
import { ridged } from "./terrariumTextures.js";

/** Deterministic RNG so the layout is identical every reload — tuning needs a fixed set. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Displace an icosphere into a rock.
 *
 * Two noise octaves at very different scales: a low one for the overall lumpiness and a
 * high one for surface tooth. Flattened on Y because rocks sitting in soil have settled,
 * and a perfect sphere reads as a potato.
 */
function rockGeometry(radius, detail, seedOff, squash = 0.62) {
  const geo = new THREE.IcosahedronGeometry(radius, detail);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = v.clone().normalize();
    const lump =
      Math.sin(n.x * 3.1 + seedOff) * Math.sin(n.y * 2.7 + seedOff * 1.7) * Math.sin(n.z * 3.4 + seedOff * 0.6);
    // Frequency kept low relative to the tessellation. At 17-19 cycles on a detail-2
    // icosphere this term was undersampled, and computeVertexNormals turned the aliasing
    // into big flat facets — the rocks read as low-poly crystals rather than as stone.
    const tooth =
      Math.sin(n.x * 9 + seedOff * 3) * Math.sin(n.y * 8 + seedOff) * Math.sin(n.z * 10 + seedOff * 2);
    const d = 1 + lump * 0.26 + tooth * 0.055;
    v.copy(n).multiplyScalar(radius * d);
    v.y *= squash;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Stone shading: banded colour off world position, dust settling on up-facing surfaces. */
function stoneMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.85 });

  const p = positionWorld.mul(vec3(9, 26, 9));
  const band = mx_noise_float(p).mul(0.5).add(0.5);
  const speck = mx_noise_float(positionWorld.mul(220)).mul(0.5).add(0.5);

  // Warm AND dark, and the warmth matters as much as the level. A neutral grey rock and
  // a warm brown soil at the same luminance behave completely differently under a hot
  // lamp: the soil saturates toward orange and still reads as a surface, the grey runs
  // out of headroom in all three channels at once and goes flat white. The first pass
  // was neutral, and the rocks looked like lumps of marble under a spotlight.
  const base = mix(vec3(0.046, 0.038, 0.030), vec3(0.098, 0.080, 0.060), band);
  const withSpeck = base.add(vec3(0.030, 0.026, 0.021).mul(smoothstep(0.82, 1.0, speck)));

  // Dust settles on top faces, so up-facing stone is paler and rougher than its flanks.
  const up = smoothstep(0.25, 0.85, normalWorld.y);
  const dusty = mix(withSpeck, withSpeck.mul(1.10).add(vec3(0.010, 0.008, 0.006)), up.mul(0.7));

  mat.colorNode = dusty;
  mat.roughnessNode = clamp(float(0.72).add(band.mul(0.20)).add(up.mul(0.10)), 0.2, 1.0);
  return mat;
}

/** Driftwood: a tapered tube along a lazy curve, with ridged grain. */
function driftwood(seed) {
  const r = rng(seed);
  const pts = [];
  const n = 6;
  let x = 0, y = 0, z = 0, dx = 1, dz = 0.25;
  for (let i = 0; i <= n; i++) {
    pts.push(new THREE.Vector3(x, y + Math.sin(i * 0.9) * 0.006, z));
    x += 0.036 * dx;
    z += 0.024 * dz;
    dx += (r() - 0.5) * 0.4;
    dz += (r() - 0.5) * 0.9;
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo = new THREE.TubeGeometry(curve, 60, 0.011, 10, false);
  // Taper toward the far end — a constant-radius tube reads as a pipe.
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.9 });
  const grain = mx_noise_float(positionWorld.mul(vec3(140, 30, 140))).mul(0.5).add(0.5);
  const rot = mx_noise_float(positionWorld.mul(11)).mul(0.5).add(0.5);
  mat.colorNode = mix(vec3(0.062, 0.046, 0.032), vec3(0.135, 0.108, 0.082), grain)
    .mul(mix(float(0.75), float(1.15), rot));
  mat.roughnessNode = clamp(float(0.82).add(grain.mul(0.15)), 0.3, 1.0);

  return new THREE.Mesh(geo, mat);
}

/**
 * Moss mound.
 *
 * The whole effect is the rim: real moss is a mat of translucent filaments, so light
 * wraps past the silhouette and the edge goes brighter and yellower than the centre.
 * Faking that with a Fresnel term is crude, and it works — a flat green lump does not.
 */
function mossMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.95 });

  // Three frequencies. The fine one is what stops a mound reading as a solid object:
  // moss is a mat of separate filaments, so at 30 cm the eye expects texture below the
  // scale of the shape itself. The first pass had only the two coarse bands and the
  // patches came out as smooth green pills lying on the soil.
  const fine = mx_noise_float(positionWorld.mul(300)).mul(0.5).add(0.5);
  const clump = mx_noise_float(positionWorld.mul(85)).mul(0.5).add(0.5);
  const patch = mx_noise_float(positionWorld.mul(22)).mul(0.5).add(0.5);

  // Much darker and much less saturated than the obvious choice. Live moss in shade is
  // a deep olive, not a bright green — a saturated mid-green at this size reads as
  // plasticine no matter how good the lighting is.
  const deep = vec3(0.016, 0.026, 0.011);
  const bright = vec3(0.040, 0.064, 0.023);
  let col = mix(deep, bright, clump.mul(0.45).add(patch.mul(0.30)).add(fine.mul(0.25)));

  // Patches of dead/dry moss. Uniform health is another tell — real cushions are
  // browning somewhere.
  col = mix(col, vec3(0.052, 0.040, 0.022), smoothstep(0.62, 0.95, patch).mul(0.55));

  const V = normalize(cameraPosition.sub(positionWorld));
  const rim = pow(oneMinus(clamp(abs(dot(normalWorld, V)), 0, 1)), 2.2);
  col = col.add(vec3(0.028, 0.036, 0.013).mul(rim));

  mat.colorNode = col;
  mat.roughnessNode = clamp(float(0.94).sub(clump.mul(0.10)), 0.5, 1.0);
  return mat;
}

/**
 * Cork-bark background panel against the inner back wall.
 *
 * Added after seeing the first render: with the back pane transparent and the studio
 * backdrop dark, the top two thirds of the tank was a black void, and the whole thing
 * read as a box floating in space rather than as an enclosure. Real vivariums are
 * backed — cork, foam rock, or at minimum a printed poster — for exactly the same
 * reason a set has a wall. It also gives the basking lamp something behind the animal
 * to fall off across, which is where most of the depth in the scene now comes from.
 */
function backgroundPanel() {
  const W = TANK.iw, H = TANK.h - 0.018;
  const NX = 140, NY = 70;
  const geo = new THREE.PlaneGeometry(W, H, NX, NY);
  const pos = geo.attributes.position;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const u = (x / W + 0.5) * 10, v = (y / H + 0.5) * 10;
    // Elongated vertically: cork bark splits along the trunk, so the ridges run up, not
    // in every direction. Isotropic noise here would read as generic rock.
    // Elongation of about 2.5:1, not the 5:1 of the first pass — that stretched the
    // noise into long smooth vertical smears and the panel read as melted wax rather
    // than as bark. A third, much finer layer puts tooth back into the surface.
    const bark = ridged(u * 2.6, v * 1.05, { octaves: 4, seed: 12 });
    const fine = ridged(u * 7, v * 3.0, { octaves: 3, seed: 34 });
    const tooth = ridged(u * 22, v * 11, { octaves: 2, seed: 56 });
    let d = bark * 0.018 + fine * 0.007 + tooth * 0.0025;
    // Flatten toward the edges so the panel meets the side panes instead of poking
    // through them.
    const edge = Math.min(1, Math.min(0.5 - Math.abs(x / W), 0.5 - Math.abs(y / H)) * 14);
    pos.setZ(i, d * Math.max(0, edge));
  }
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.95 });
  const coarse = mx_noise_float(positionWorld.mul(vec3(38, 9, 38))).mul(0.5).add(0.5);
  const speck = mx_noise_float(positionWorld.mul(190)).mul(0.5).add(0.5);
  const crev = smoothstep(0.55, 0.05, coarse);   // dark in the splits
  mat.colorNode = mix(vec3(0.058, 0.040, 0.028), vec3(0.115, 0.086, 0.060), coarse)
    .mul(mix(float(1.0), float(0.40), crev))
    .add(vec3(0.030, 0.024, 0.016).mul(smoothstep(0.84, 1.0, speck)));
  mat.roughnessNode = clamp(float(0.90).add(coarse.mul(0.09)), 0.5, 1.0);

  const mesh = new THREE.Mesh(geo, mat);
  // Just inside the back pane, facing the camera side.
  mesh.position.set(0, H / 2 + 0.006, -TANK.id / 2 + 0.002);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = "background";
  return mesh;
}

/**
 * Sit a rock in the soil with `bury` of its OWN height below the surface.
 *
 * The first pass sank things by a fraction of the bounding-sphere radius, which for a
 * squashed rock is most of its height — the basking rock ended up 7 mm proud and read as
 * a flat white patch painted on the substrate rather than as a rock. Measuring against
 * the actual bounding box means a squashed shape and a tall one both sit correctly.
 */
/**
 * A moss cushion as a CLUSTER of small blobs rather than one dome.
 *
 * This is the single change that made the moss stop looking like plasticine. Shading a
 * smooth squashed sphere green can never work at 30 cm, no matter how the colour is
 * broken up, because the SILHOUETTE is wrong — a moss cushion is an aggregate of many
 * small rounded clumps, and its outline is lumpy at a scale well below the patch itself.
 * Merging half a dozen jittered blobs gives that outline for one extra draw call's worth
 * of geometry and no shader work at all.
 */
function mossClump(radius, r) {
  const parts = [];
  const n = 6 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    const dist = radius * 0.58 * Math.sqrt(r());
    // detail 3, not 2: these blobs are 1-2 cm across and sit close to the camera, so at
    // detail 2 the flat facets are plainly visible and they read as low-poly crystals.
    const g = rockGeometry(radius * (0.28 + r() * 0.55), 3, r() * 30, 0.44);
    g.translate(Math.cos(a) * dist, (r() - 0.45) * radius * 0.14, Math.sin(a) * dist);
    parts.push(g);
  }
  // mergeGeometries returns null on any attribute mismatch rather than throwing, so a
  // silent null here would become an invisible mesh with no error anywhere.
  const merged = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  if (!merged) return rockGeometry(radius, 3, r() * 30, 0.18);
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function place(mesh, x, z, bury = 0.25) {
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox;
  const height = bb.max.y - bb.min.y;
  const h = substrateHeight(x, z);
  mesh.position.set(x, h - bury * height - bb.min.y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function createDecor() {
  const group = new THREE.Group();
  group.name = "decor";
  const stone = stoneMaterial();
  const moss = mossMaterial();
  const r = rng(1337);

  const background = backgroundPanel();
  group.add(background);

  // ── the basking rock ──────────────────────────────────────────────────────────────
  // Big, flat-topped and directly under the lamp: this is where the animal will sit, so
  // it has to look like a place rather than an obstacle.
  const bask = new THREE.Mesh(rockGeometry(0.075, 4, 1.2, 0.52), stone);
  place(bask, BASK.x, BASK.z, 0.20);
  bask.rotation.y = 0.7;
  group.add(bask);

  // Supporting rocks. Scattered, varied in size, none of them touching — evenly spaced
  // props of one size are the fastest way to make a set look procedurally generated.
  const rocks = [
    { x: -0.36, z: 0.13, s: 0.038, rot: 2.1 },
    { x: -0.14, z: -0.15, s: 0.028, rot: 0.4 },
    { x: 0.04, z: 0.14, s: 0.022, rot: 3.3 },
    { x: 0.10, z: -0.13, s: 0.033, rot: 1.1 },
    { x: 0.36, z: -0.14, s: 0.030, rot: 5.0 },
    { x: DISH.x - 0.13, z: DISH.z + 0.07, s: 0.019, rot: 2.6 },
  ];
  for (const rk of rocks) {
    const m = new THREE.Mesh(rockGeometry(rk.s, 3, r() * 10, 0.55 + r() * 0.25), stone);
    place(m, rk.x, rk.z, 0.28);
    m.rotation.set(r() * 0.3, rk.rot, r() * 0.3);
    group.add(m);
  }

  // ── driftwood ─────────────────────────────────────────────────────────────────────
  // Laid across the cool half as a climbing branch, one end resting on a rock.
  const wood = driftwood(77);
  wood.position.set(-0.02, substrateHeight(-0.02, -0.09) + 0.008, -0.09);
  wood.rotation.set(0.06, -0.5, 0.1);
  wood.castShadow = true;
  wood.receiveShadow = true;
  group.add(wood);

  // ── moss ──────────────────────────────────────────────────────────────────────────
  // Only on the cool, humid half. Moss growing next to the basking lamp would be a
  // small lie that anyone who keeps reptiles would spot immediately.
  const mossSpots = [
    { x: 0.30, z: -0.06, s: 0.038 },
    { x: 0.15, z: 0.09, s: 0.029 },
    { x: 0.39, z: 0.10, s: 0.034 },
    { x: 0.21, z: -0.15, s: 0.025 },
    { x: 0.05, z: -0.04, s: 0.021 },
    { x: 0.33, z: 0.16, s: 0.023 },
  ];
  for (const ms of mossSpots) {
    const geo = mossClump(ms.s, r);
    const m = new THREE.Mesh(geo, moss);
    m.position.set(ms.x, substrateHeight(ms.x, ms.z) - ms.s * 0.18, ms.z);
    m.rotation.y = r() * 6.28;
    m.receiveShadow = true;
    m.castShadow = true;
    group.add(m);
  }

  return { group, stone, moss, background };
}
