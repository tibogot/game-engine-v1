import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { seededRand } from "./woodUtils.js";

/**
 * Procedural chain-link security fence with barbed wire on top — the
 * military / prison-perimeter kind, deliberately nothing like the wood
 * picket + plank fences: round steel pipe posts, a diamond mesh curtain,
 * top/bottom tension rails, and angled outrigger arms carrying barbed
 * strands (out, in, or a Y on both sides), with optional concertina coil.
 *
 * The diamond mesh is the interesting part: drawing real chain-link as
 * geometry would cost thousands of verts per panel, so it is a single
 * terrain-following ribbon (2 tris per segment) textured with a procedurally
 * drawn, alpha-tested diamond pattern. A 50 m fence's curtain is ~100 verts.
 *
 * Cost: ONE merged vertex-colored opaque mesh (posts, rails, arms, barbed
 * strands, barbs) + ONE alpha-tested mesh (the curtain). 2 draw calls.
 */

export const CHAIN_LINK_FENCE_DEFAULTS = {
  height: 2.4,
  pathSegments: 60,

  postSpacing: 3.0,
  postRadius: 0.045,
  postSides: 8,
  postOver: 0.06, // post cap poking above the top rail
  postLean: 1.0, // random lean in degrees
  postSink: 0.3,

  topRail: true,
  bottomRail: false,
  railRadius: 0.03,

  meshPitch: 0.14, // diamond size (metres)
  meshWire: 0.02, // apparent wire thickness in the curtain
  meshGroundGap: 0.04, // curtain bottom above the ground
  meshColor: "#b9c0c6",
  meshOpacityCut: 0.45, // alpha test threshold

  arms: true,
  armSide: "out", // "out" | "in" | "both" (Y-arm)
  armAngle: 45, // degrees from vertical
  armLength: 0.45,
  armRadius: 0.03,

  strands: 3,
  strandRadius: 0.012,
  strandBarbs: true,
  barbSpacing: 0.35,
  barbSize: 0.045,

  coil: false, // concertina coil sitting on the arms
  coilRadius: 0.22,
  coilPitch: 0.3,

  postColor: "#8e959b",
  railColor: "#828990",
  wireColor: "#9aa0a6",
  rustColor: "#6e4a33",
  rust: 0.2,
  roughness: 0.6,
  metalness: 0.55,
  seed: 9,
};

const WORLD_UP = new THREE.Vector3(0, 1, 0);

// ── chain-link curtain texture (procedural, cached per look) ───────────────

const _texCache = new Map();

/**
 * Draw one diamond-mesh tile to a canvas → alpha-tested repeating texture.
 * One tile = one diamond pitch, so UV repeat maps 1 unit → 1 diamond.
 *
 * Exported because the diamond weave is the LOOK, not just this builder's
 * internals: the modular-road elevator cages its platform in the same mesh, and
 * the cache key means both share one 64×64 texture rather than drawing a canvas
 * each. Anything reusing it must also reuse `disposeChainLinkTextures` as the
 * single owner — never dispose the returned texture directly.
 */
export function chainLinkTexture(color, wireFrac) {
  if (typeof document === "undefined") return null; // node (bbox/thumbnail probes)
  const key = `${color}|${wireFrac.toFixed(3)}`;
  const hit = _texCache.get(key);
  if (hit) return hit;

  const S = 64;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, S * wireFrac);
  ctx.lineCap = "square";
  // Two diagonals per tile, wrapped — tiles into a continuous diamond weave.
  for (const [x0, y0, x1, y1] of [
    [-S, 0, 0, S],
    [0, 0, S, S],
    [S, 0, 2 * S, S],
    [0, S, S, 0],
    [S, S, 2 * S, 0],
    [-S, S, 0, 0],
  ]) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  _texCache.set(key, tex);
  return tex;
}

/** Free the cached curtain textures (call on a full lab teardown). */
export function disposeChainLinkTextures() {
  for (const t of _texCache.values()) t.dispose();
  _texCache.clear();
}

// ── geometry helpers ──────────────────────────────────────────────────────

// Sweep a square cross-section along world-space centres (rails, strands).
function sweepSquare(centers, r) {
  const rings = centers.length;
  const pos = new Float32Array(rings * 4 * 3);
  const idx = [];
  const fwd = new THREE.Vector3();
  const rt = new THREE.Vector3();
  const up = new THREE.Vector3();
  const v = new THREE.Vector3();

  let o = 0;
  for (let i = 0; i < rings; i++) {
    const a = centers[Math.max(0, i - 1)];
    const b = centers[Math.min(rings - 1, i + 1)];
    fwd.subVectors(b, a).normalize();
    if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, 1);
    rt.crossVectors(WORLD_UP, fwd);
    if (rt.lengthSq() < 1e-9) rt.set(1, 0, 0);
    rt.normalize();
    up.crossVectors(fwd, rt).normalize();
    const c = centers[i];
    for (const [x, y] of [
      [r, r],
      [-r, r],
      [-r, -r],
      [r, -r],
    ]) {
      v.copy(c).addScaledVector(rt, x).addScaledVector(up, y);
      pos[o++] = v.x;
      pos[o++] = v.y;
      pos[o++] = v.z;
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      idx.push(i * 4 + k, i * 4 + k2, (i + 1) * 4 + k2);
      idx.push(i * 4 + k, (i + 1) * 4 + k2, (i + 1) * 4 + k);
    }
  }
  idx.push(0, 2, 1, 0, 3, 2);
  const last = (rings - 1) * 4;
  idx.push(last, last + 1, last + 2, last, last + 2, last + 3);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function bakeColor(geo, color) {
  const n = geo.attributes.position.count;
  const buf = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    buf[i * 3] = color.r;
    buf[i * 3 + 1] = color.g;
    buf[i * 3 + 2] = color.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(buf, 3));
  return geo;
}

// ── builder ────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {THREE.Vector3[]|{x,y,z}[]} opts.points
 * @param {boolean} [opts.closed]
 * @param {object} [opts.params]
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group|null}
 */
export function buildChainLinkFenceMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const p = { ...CHAIN_LINK_FENCE_DEFAULTS, ...params };

  const pts3 = points.map((pt) => new THREE.Vector3(pt.x, 0, pt.z));
  const curve = new THREE.CatmullRomCurve3(pts3, !!closed, "catmullrom", 0.5);
  const length = curve.getLength();
  const segs = Math.max(12, p.pathSegments | 0);

  const group = new THREE.Group();
  group.name = "ChainLinkFence";

  const allGeos = [];
  const _c = new THREE.Color();
  const wireCol = new THREE.Color(p.wireColor);
  const rustCol = new THREE.Color(p.rustColor);
  const deg = Math.PI / 180;

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  unitBox.deleteAttribute("uv");
  const unitPost = new THREE.CylinderGeometry(1, 1, 1, Math.max(5, p.postSides | 0));
  unitPost.deleteAttribute("uv");

  const m = new THREE.Matrix4();
  const rot = new THREE.Matrix4();
  const eul = new THREE.Euler();
  const scl = new THREE.Vector3();

  const push = (tmpl, matrix, color) => {
    const g = tmpl.clone();
    g.applyMatrix4(matrix);
    bakeColor(g, color);
    allGeos.push(g);
  };

  const frameAt = (t) => {
    const e = 0.002;
    const a = curve.getPointAt(THREE.MathUtils.clamp(t - e, 0, 1));
    const b = curve.getPointAt(THREE.MathUtils.clamp(t + e, 0, 1));
    const fwd = b.sub(a).setY(0).normalize();
    if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, 1);
    const right = new THREE.Vector3().crossVectors(WORLD_UP, fwd).normalize();
    return { right, fwd };
  };
  const groundAt = (t) => {
    const c = curve.getPointAt(THREE.MathUtils.clamp(t, 0, 1));
    return new THREE.Vector3(c.x, getWorldHeight(c.x, c.z), c.z);
  };
  // rusted variant of a base color, patchy along the run
  const weather = (base, k) => {
    const patch = Math.pow(seededRand(p.seed, k), 1.6) * p.rust;
    return _c.copy(base).lerp(rustCol, THREE.MathUtils.clamp(patch, 0, 1));
  };

  // ── posts (round pipe + cap) ──
  const postCount = Math.max(2, Math.floor(length / Math.max(0.5, p.postSpacing)) + 1);
  const postCol = new THREE.Color(p.postColor);
  for (let i = 0; i < postCount; i++) {
    const t = i / (postCount - 1);
    const g = groundAt(t);
    const h = p.height + p.postOver + p.postSink;
    const la = (seededRand(p.seed, i * 3 + 1) - 0.5) * 2 * p.postLean * deg;
    const lb = (seededRand(p.seed, i * 3 + 2) - 0.5) * 2 * p.postLean * deg;
    scl.set(p.postRadius, h, p.postRadius);
    m.makeRotationFromEuler(eul.set(la, 0, lb))
      .scale(scl)
      .setPosition(g.x, g.y - p.postSink + h * 0.5, g.z);
    push(unitPost, m, weather(postCol, i * 17 + 3));
  }

  // ── rails + curtain-following helpers ──
  const railCol = new THREE.Color(p.railColor);
  const addRail = (heightOff, r, color) => {
    const centers = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const g = groundAt(t);
      centers.push(new THREE.Vector3(g.x, g.y + heightOff, g.z));
    }
    const geo = sweepSquare(centers, r);
    bakeColor(geo, color);
    allGeos.push(geo);
  };
  if (p.topRail) addRail(p.height, p.railRadius, railCol);
  if (p.bottomRail) addRail(p.meshGroundGap + 0.02, p.railRadius * 0.8, railCol);

  // ── outrigger arms + barbed strands on top ──
  const sides =
    !p.arms || p.armSide === "both"
      ? p.arms
        ? [1, -1]
        : []
      : p.armSide === "in"
        ? [-1]
        : [1];

  if (p.arms && sides.length) {
    const armCol = new THREE.Color(p.railColor);
    // arm direction in the (right, up) plane, per side
    const armDirFor = (right, s) =>
      new THREE.Vector3()
        .addScaledVector(WORLD_UP, Math.cos(p.armAngle * deg))
        .addScaledVector(right, s * Math.sin(p.armAngle * deg))
        .normalize();

    // arms at every post
    for (let i = 0; i < postCount; i++) {
      const t = i / (postCount - 1);
      const f = frameAt(t);
      const g = groundAt(t);
      const top = new THREE.Vector3(g.x, g.y + p.height, g.z);
      for (const s of sides) {
        const dir = armDirFor(f.right, s);
        const mid = top.clone().addScaledVector(dir, p.armLength * 0.5);
        const x = new THREE.Vector3().crossVectors(dir, f.fwd).normalize();
        const z = new THREE.Vector3().crossVectors(x, dir).normalize();
        scl.set(p.armRadius * 2, p.armLength, p.armRadius * 2);
        m.makeBasis(x, dir, z).scale(scl).setPosition(mid);
        push(unitBox, m, weather(armCol, i * 23 + 11));
      }
    }

    // barbed strands running along the arms, plus crossed barbs
    const nStrands = Math.max(1, p.strands | 0);
    const barbEvery = Math.max(0.08, p.barbSpacing);
    for (const s of sides) {
      for (let k = 0; k < nStrands; k++) {
        const frac = nStrands === 1 ? 1 : (k + 1) / nStrands;
        const centers = [];
        for (let i = 0; i <= segs; i++) {
          const t = i / segs;
          const f = frameAt(t);
          const g = groundAt(t);
          const dir = armDirFor(f.right, s);
          centers.push(
            new THREE.Vector3(g.x, g.y + p.height, g.z).addScaledVector(
              dir,
              p.armLength * frac,
            ),
          );
        }
        const geo = sweepSquare(centers, p.strandRadius);
        bakeColor(geo, weather(wireCol, k * 31 + 5));
        allGeos.push(geo);

        if (p.strandBarbs) {
          const nBarbs = Math.max(1, Math.floor(length / barbEvery));
          const bx = new THREE.Vector3();
          const by = new THREE.Vector3();
          const bd = new THREE.Vector3();
          for (let b = 0; b < nBarbs; b++) {
            const t = (b + 0.5) / nBarbs;
            const f = frameAt(t);
            const g = groundAt(t);
            const dir = armDirFor(f.right, s);
            const pos = new THREE.Vector3(g.x, g.y + p.height, g.z).addScaledVector(
              dir,
              p.armLength * frac,
            );
            bd.copy(f.fwd);
            bx.crossVectors(bd, WORLD_UP).normalize();
            by.crossVectors(bd, bx).normalize();
            const col = weather(wireCol, b * 13 + k);
            for (const a of [45, -45]) {
              scl.set(p.barbSize, p.strandRadius * 1.6, p.strandRadius * 1.6);
              m.makeBasis(bx, by, bd)
                .multiply(rot.makeRotationFromEuler(eul.set(0, 0, a * deg)))
                .scale(scl)
                .setPosition(pos);
              push(unitBox, m, col);
            }
          }
        }
      }
    }

    // ── optional concertina coil nested on top of the arms ──
    if (p.coil) {
      const segsRev = 8;
      const revs = Math.max(2, Math.floor(length / Math.max(0.05, p.coilPitch)));
      const rings = Math.min(16000, revs * segsRev);
      const centers = [];
      // coil sits above the post tops, centred between the arms
      for (let i = 0; i <= rings; i++) {
        const t = i / rings;
        const f = frameAt(t);
        const g = groundAt(t);
        const th = (i / segsRev) * Math.PI * 2;
        const base = new THREE.Vector3(
          g.x,
          g.y + p.height + p.coilRadius + p.armLength * 0.35,
          g.z,
        );
        centers.push(
          base
            .addScaledVector(f.right, Math.cos(th) * p.coilRadius)
            .setY(base.y + Math.sin(th) * p.coilRadius * 0.85),
        );
      }
      const geo = sweepSquare(centers, p.strandRadius);
      bakeColor(geo, weather(wireCol, 77));
      allGeos.push(geo);
    }
  }

  // ── chain-link curtain: one terrain-following ribbon, alpha-tested ──
  {
    const pos = [];
    const uv = [];
    const idx = [];
    const y0 = p.meshGroundGap;
    const y1 = p.height;
    const span = Math.max(0.01, y1 - y0);
    let dist = 0;
    let prev = null;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const g = groundAt(t);
      if (prev) dist += Math.hypot(g.x - prev.x, g.z - prev.z);
      prev = g;
      const u = dist / Math.max(0.02, p.meshPitch);
      const v = span / Math.max(0.02, p.meshPitch);
      pos.push(g.x, g.y + y0, g.z);
      uv.push(u, 0);
      pos.push(g.x, g.y + y1, g.z);
      uv.push(u, v);
    }
    for (let i = 0; i < segs; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    const curtain = new THREE.BufferGeometry();
    curtain.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    curtain.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    curtain.setIndex(idx);
    curtain.computeVertexNormals();

    const tex = chainLinkTexture(p.meshColor, p.meshWire / Math.max(0.02, p.meshPitch));
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(p.meshColor),
      map: tex,
      alphaMap: tex,
      alphaTest: p.meshOpacityCut,
      transparent: false,
      side: THREE.DoubleSide,
      roughness: p.roughness,
      metalness: p.metalness,
    });
    const curtainMesh = new THREE.Mesh(curtain, mat);
    curtainMesh.castShadow = true;
    curtainMesh.receiveShadow = true;
    group.add(curtainMesh);
  }

  // ── merge the metalwork into ONE vertex-colored mesh ──
  unitBox.dispose();
  unitPost.dispose();
  const merged = mergeGeometries(allGeos, false);
  allGeos.forEach((g) => g.dispose());
  if (merged) {
    const mesh = new THREE.Mesh(
      merged,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: p.roughness,
        metalness: p.metalness,
      }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  return group;
}

/** Fixed hero span — a straight run for close-up tuning. */
export const CHAIN_LINK_FENCE_HERO_POINTS = [
  { x: -8, y: 0, z: -14 },
  { x: 8, y: 0, z: -14 },
];
