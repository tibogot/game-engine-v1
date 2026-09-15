/**
 * Flower meshes, built from numbers — no textures, no alpha test.
 *
 * The silhouette IS the geometry: every petal is its own curved strip, so the
 * outline is exact at any distance, edges antialias with MSAA like any mesh,
 * and the GPU can reject hidden fragments early (an alpha-tested card can do
 * neither). Normals are analytic, so petals shade as smooth bowls rather than
 * facets.
 *
 * One flower in a unit frame: bloom diameter ~1, bloom centre at the origin,
 * stem below it. The vertex shader scales, sways and places it per plant.
 *
 * Attributes
 *   position, normal, uv
 *   aFlower vec4 = (part, t, rand, along)
 *     part   0 petal · 1 centre · 2 stem · 3 leaf
 *     t      height on the stem, 0 ground → 1 bloom (a leaf's attach height)
 *     rand   per petal / leaf, 0..1 — colour and flutter variety
 *     along  0 at a petal's or leaf's base → 1 at its tip (flutter weight)
 *
 * Two levels of detail, same shape: NEAR (~250-350 triangles with leaves) and
 * FAR (~40-70: diamond petals, a 6-sided cap, a 3-sided stem, no leaves).
 */
import * as THREE from "three";

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/** @returns {{ geometry: THREE.BufferGeometry, triangles: number }} */
export function createFlowerTypeGeometry(type, { lod = 0 } = {}) {
  const near = lod === 0;
  const P = [], N = [], UV = [], A = [], I = [];
  const rand = rng(97 + Math.round((type.petals ?? 5) * 131 + (type.cup ?? 0) * 1000));

  const push = (p, n, u, v, a) => {
    P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); UV.push(u, v); A.push(a[0], a[1], a[2], a[3]);
    return P.length / 3 - 1;
  };

  // ── Petals ─────────────────────────────────────────────────────────────
  const centreR = Math.max(0.02, (type.centreSize ?? 0.25) * 0.5);
  const addPetalRing = ({ count, length, width, cup, curl, pointed, rotate }) => {
    // Many thin petals need less detail each: a daisy reads fine with 3 rows
    // and no midrib column, a 5-petal poppy wants all of it.
    const rows = near ? (count > 10 ? 3 : 4) : 2;
    const many = count > 16;
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + rotate + (rand() - 0.5) * (0.35 / count);
      const pr = rand();
      const lenK = length * (0.9 + rand() * 0.2);
      const dir = [Math.cos(a), 0, Math.sin(a)];
      const tan = [-Math.sin(a), 0, Math.cos(a)];
      const cols = near && !many ? [-1, 0, 1] : [-1, 1];

      // March the centre line: angle rises with cup, bends with curl toward the tip.
      const line = [];
      let r = centreR * 0.75, y = 0;
      const ds = lenK / rows;
      for (let j = 0; j <= rows; j++) {
        const v = j / rows;
        const th = cup * 1.35 + curl * v * v * 1.6;
        line.push({ v, r, y, th });
        const vm = (j + 0.5) / rows;
        const thm = cup * 1.35 + curl * vm * vm * 1.6;
        r += Math.cos(thm) * ds;
        y += Math.sin(thm) * ds;
      }
      const profile = (v) => Math.pow(Math.sin(Math.PI * (0.06 + 0.94 * v)), 0.45 + pointed * 0.95);

      const surf = (u, j) => {
        const L = line[j];
        const w = width * lenK * 0.5 * profile(L.v);
        // Petal-local "up" tilts with the centre line, so a cupped petal's
        // edges lift off its own surface, not off the world.
        const up = [-Math.sin(L.th) * dir[0], Math.cos(L.th), -Math.sin(L.th) * dir[2]];
        const bowl = u * u * w * 0.35;
        return [
          dir[0] * L.r + tan[0] * u * w + up[0] * bowl,
          L.y + up[1] * bowl,
          dir[2] * L.r + tan[2] * u * w + up[2] * bowl,
        ];
      };

      const base = P.length / 3;
      // Far: a diamond (base point, widest row, tip point) — 2 triangles.
      const rowIdx = near ? line.map((_, j) => j) : [0, 1, 2];
      for (const j of rowIdx) {
        const L = line[j];
        const singlePoint = !near && (j === 0 || j === rows);
        const us = singlePoint ? [0] : cols;
        for (const u of us) {
          const p = surf(u, j);
          // Normal from the surface's own derivatives.
          const e = 0.02;
          const pu = surf(Math.min(1, u + e), j), pu2 = surf(Math.max(-1, u - e), j);
          const jn = Math.min(rows, j + 1), jp = Math.max(0, j - 1);
          const pv = surf(u, jn), pv2 = surf(u, jp);
          const du = [pu[0] - pu2[0], pu[1] - pu2[1], pu[2] - pu2[2]];
          const dv = [pv[0] - pv2[0], pv[1] - pv2[1], pv[2] - pv2[2]];
          let n = [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]];
          if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
          let len = Math.hypot(n[0], n[1], n[2]);
          // A pointed tip has zero width, so no surface derivative across it:
          // use the centre line's own up there.
          if (len < 1e-6) { n = [-Math.sin(L.th) * dir[0], Math.cos(L.th), -Math.sin(L.th) * dir[2]]; len = 1; }
          push(p, [n[0] / len, n[1] / len, n[2] / len], u * 0.5 + 0.5, L.v, [0, 1, pr, L.v]);
        }
      }
      if (near) {
        const c = cols.length;
        for (let j = 0; j < rows; j++) {
          for (let q = 0; q < c - 1; q++) {
            const i0 = base + j * c + q, i1 = i0 + 1, i2 = i0 + c, i3 = i2 + 1;
            I.push(i0, i2, i1, i1, i2, i3);
          }
        }
      } else {
        // 0 base, 1-2 widest, 3 tip
        I.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }
  };

  const petals = Math.max(3, Math.round(type.petals ?? 5));
  const width = type.petalWidth ?? 0.5;
  const pointed = type.pointed ?? 0;
  addPetalRing({
    count: petals, length: type.petalLength ?? 0.45, width, cup: type.cup ?? 0.2,
    curl: type.curl ?? 0, pointed, rotate: 0,
  });
  if (type.doubleLayer) {
    addPetalRing({
      count: petals, length: (type.petalLength ?? 0.45) * 0.72, width: width * 0.9,
      cup: Math.min(1.1, (type.cup ?? 0.2) + 0.25), curl: (type.curl ?? 0) * 0.6, pointed,
      rotate: Math.PI / petals,
    });
  }

  // ── Centre: a low dome ─────────────────────────────────────────────────
  {
    const sides = near ? 10 : 6;
    const rings = near ? 3 : 1;
    const h = type.centreHeight ?? 0.1;
    const base = P.length / 3;
    push([0, h, 0], [0, 1, 0], 0.5, 0.5, [1, 1, 0, 0]);
    for (let q = 1; q <= rings; q++) {
      const rr = (q / rings) * centreR;
      const yy = h * (1 - (q / rings) ** 2) + 0.004;
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
        // Gradient of y = h(1 - r²/R²): slope -2h r / R².
        const slope = (-2 * h * rr) / (centreR * centreR);
        const n = [-Math.cos(a) * slope, 1, -Math.sin(a) * slope];
        const nl = Math.hypot(n[0], n[1], n[2]);
        push([x, yy, z], [n[0] / nl, n[1] / nl, n[2] / nl], x / (2 * centreR) + 0.5, z / (2 * centreR) + 0.5, [1, 1, q / rings, 0]);
      }
    }
    for (let s = 0; s < sides; s++) I.push(base, base + 1 + ((s + 1) % sides), base + 1 + s);
    for (let q = 1; q < rings; q++) {
      const r0 = base + 1 + (q - 1) * sides, r1 = base + 1 + q * sides;
      for (let s = 0; s < sides; s++) {
        const a = r0 + s, b = r0 + ((s + 1) % sides), c = r1 + s, d = r1 + ((s + 1) % sides);
        I.push(a, b, c, b, d, c);
      }
    }
  }

  // ── Stem: unit tube, t 0 → 1 (the shader gives it height, radius and bend) ─
  {
    const sides = near ? 5 : 3;
    const segs = near ? 4 : 1;
    const base = P.length / 3;
    for (let j = 0; j <= segs; j++) {
      const t = j / segs;
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        push([Math.cos(a), t, Math.sin(a)], [Math.cos(a), 0, Math.sin(a)], s / sides, t, [2, t, 0, 0]);
      }
    }
    for (let j = 0; j < segs; j++) {
      for (let s = 0; s < sides; s++) {
        const a = base + j * sides + s, b = base + j * sides + ((s + 1) % sides);
        const c = a + sides, d = b + sides;
        I.push(a, b, c, b, d, c);
      }
    }
  }

  // ── Leaves (near only): strips springing up and out, drooping at the tip ─
  const leaves = near ? Math.max(0, Math.min(3, Math.round(type.leaves ?? 0))) : 0;
  for (let l = 0; l < leaves; l++) {
    const tAttach = 0.22 + l * 0.2;
    const a = l * 2.4 + rand() * 0.8;
    const lr = rand();
    const len = 0.32 * (type.leafSize ?? 1) * (0.85 + rand() * 0.3);
    const dir = [Math.cos(a), 0, Math.sin(a)];
    const tan = [-Math.sin(a), 0, Math.cos(a)];
    const rows = 4;
    const base = P.length / 3;
    let r = 0, y = 0;
    const ds = len / rows;
    for (let j = 0; j <= rows; j++) {
      const v = j / rows;
      const th = 0.75 - 1.5 * v * v;
      const w = len * 0.22 * Math.sin(Math.PI * (0.05 + 0.95 * v)) ** 0.7;
      const n = [-Math.sin(th) * dir[0], Math.cos(th), -Math.sin(th) * dir[2]];
      for (const u of [-1, 0, 1]) {
        const fold = Math.abs(u) * w * 0.25;      // a slight V fold along the midrib
        push([dir[0] * r + tan[0] * u * w + n[0] * fold, y + n[1] * fold, dir[2] * r + tan[2] * u * w + n[2] * fold],
          n, u * 0.5 + 0.5, v, [3, tAttach, lr, v]);
      }
      const thm = 0.75 - 1.5 * ((j + 0.5) / rows) ** 2;
      r += Math.cos(thm) * ds;
      y += Math.sin(thm) * ds;
    }
    for (let j = 0; j < rows; j++) {
      for (let q = 0; q < 2; q++) {
        const i0 = base + j * 3 + q, i1 = i0 + 1, i2 = i0 + 3, i3 = i2 + 1;
        I.push(i0, i2, i1, i1, i2, i3);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(P), 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(N), 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(UV), 2));
  geometry.setAttribute("aFlower", new THREE.BufferAttribute(new Float32Array(A), 4));
  geometry.setIndex(I);
  return { geometry, triangles: I.length / 3 };
}
