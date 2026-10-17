/**
 * v3/tools/riverV3/riverV3Rocks.js — the ROCKS of a stepped river.
 *
 * Real steps form around keystones: boulders jammed across the channel that
 * the water then falls over and between (step-pool geomorphology). Without
 * them a cascade is water falling over a clean curve, which reads as a built
 * weir or a fountain. So every cascade the network solve makes
 * (riverV3Network applyStepPools → S.steps) gets, from its own seed:
 *
 *   KEYSTONES  along the crest, standing a little above the upper pool, with
 *              gaps; never in the crest's NOTCH, which stays the open chute
 *              the water pours through.
 *   FRAMERS    sometimes one big boulder at either end, half in the bank.
 *   STONES     one or two small ones in the plunge pool below.
 *
 * Everything follows the crest's own shape (crestShift), so a tilted crest
 * gets a tilted row. Rocks are placed from the solved levels and seated on the
 * FINAL ground (their base below the bed, so none floats in clear water), and
 * rebuilt whenever the river is — they are part of the river, not props.
 *
 * Same generator and shading as the level's rock props (proceduralRock.js,
 * rockShading.js), so they read as the same stone; wet (darker, glossier)
 * below their water line.
 */
import * as THREE from "three";
import { mix, smoothstep, positionWorld, attribute, float } from "three/tsl";
import { crestShift } from "./riverV3Network.js";
import { getRockGeometry, rockKitParams, prewarmRockGeometries } from "../../props/proceduralRock.js";
import { applyRockShading, ROCK_BASE_COLOR } from "../../props/rockShading.js";

/**
 * The kit shapes the river uses: [name, role, triangle budget]. Roles: big
 * (crest, framer), small (pool). The budgets are the river's own: these rocks
 * are 0.5-2.4 m, and the kit's 1,000-1,200 (sized for props up close, drawn
 * again in every shadow cascade) made ~100 rocks cost 380k triangles a frame.
 */
export const RIVER_ROCK_SHAPES = [
  ["Rock: Boulder A", "big", 500], ["Rock: Boulder B", "big", 500], ["Rock: Lump A", "big", 450],
  ["Rock: Lump B", "big", 450], ["Rock: Stone A", "small", 200], ["Rock: Stone B", "small", 200],
];

/** A deterministic random stream from integer seeds. */
function stream(...seeds) {
  let s = 0x9e3779b9;
  for (const v of seeds) s = Math.imul(s ^ (v | 0), 0x85ebca6b) ^ (s >>> 13);
  s = (s >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * Where the rocks go — pure, for the system and the tests.
 * @param {Map<any, object>} reaches  solved reaches (id → S with steps)
 * @param {object} o
 * @param {number} o.amount            × how many (0 = none)
 * @param {(x:number, z:number) => number} o.groundAt  FINAL ground height (m)
 * @param {number[]} o.shapeHeights    each RIVER_ROCK_SHAPES entry's height at scale 1
 * @returns {Array<{shape:number, x:number, y:number, z:number, yaw:number, tiltX:number,
 *   tiltZ:number, sx:number, sy:number, sz:number, waterY:number, kind:string}>}
 */
export function placeRiverRocks(reaches, { amount = 1, groundAt, shapeHeights }) {
  const out = [];
  if (!(amount > 0)) return out;
  const big = [], small = [];
  RIVER_ROCK_SHAPES.forEach(([, role], i) => (role === "big" ? big : small).push(i));
  for (const [id, S] of reaches) {
    if (!S?.steps?.length || S.count < 2) continue;
    const at = (arr, a) => {
      if (a <= S.arc[0]) return arr[0];
      if (a >= S.arc[S.count - 1]) return arr[S.count - 1];
      let lo = 0, hi = S.count - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S.arc[m] > a) hi = m; else lo = m; }
      const t = (a - S.arc[lo]) / Math.max(S.arc[hi] - S.arc[lo], 1e-9);
      return arr[lo] + (arr[hi] - arr[lo]) * t;
    };
    /** World point at arc `s`, `a` half-widths across (+ = the ribbon's +across side). */
    const point = (s, a) => {
      let tx = at(S.tanX, s), tz = at(S.tanZ, s);
      const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      const hw = at(S.width, s) * 0.5;
      return { x: at(S.x, s) - tz * a * hw, z: at(S.z, s) + tx * a * hw, tx, tz, hw };
    };
    const push = (kind, shape, p, h, top, waterY, rnd) => {
      const hs = shapeHeights[shape] || 1;
      const k = h / hs;
      const sx = k * (0.85 + 0.35 * rnd()), sz = k * (0.85 + 0.35 * rnd());
      const ground = groundAt(p.x, p.z);
      // The top stands where it was asked to; the base is pushed below the bed
      // so no rock floats in clear water (a tall one just sinks deeper).
      let y = top - h;
      if (y > ground - 0.15) { const extra = y - (ground - 0.15); y -= extra; }
      const hh = top - y;
      out.push({
        kind, shape, x: p.x, y, z: p.z,
        yaw: rnd() * Math.PI * 2, tiltX: (rnd() - 0.5) * 0.3, tiltZ: (rnd() - 0.5) * 0.3,
        sx, sy: hh / hs, sz, waterY,
      });
    };
    S.steps.forEach((st, k) => {
      const rnd = stream(Number(id) || 0, k, 7919);
      const sh = (a) => crestShift(st.A, st.B, st.N, st.P, a);
      const upper = at(S.level, Math.max(S.arc[0], st.brink - Math.abs(sh(0)) - 1.5));
      const lower = at(S.level, Math.min(S.arc[S.count - 1], st.toe + 1.5));
      const H = Math.max(0.2, upper - lower);
      const W = at(S.width, st.brink);
      // KEYSTONES: about one per 2.4 m of crest, with gaps.
      const n = Math.max(1, Math.round((W / 2.4) * amount * (0.7 + 0.6 * rnd())));
      const notch = st.N > 0.15 ? st.P : 9;          // the chute stays open
      for (let j = 0; j < n; j++) {
        let a = -0.85 + (1.7 * (j + 0.5)) / n + (rnd() - 0.5) * (1.4 / n);
        a = Math.max(-0.9, Math.min(0.9, a));
        if (Math.abs(a - notch) < 0.25) continue;
        if (rnd() < 0.25) continue;                   // gaps between them
        const s = st.brink - sh(a) + (0.05 + 0.4 * rnd()) * st.c;
        const h = Math.max(0.5, Math.min(2.4, (0.55 + 0.55 * H) * (0.7 + 0.6 * rnd())));
        push("keystone", big[Math.floor(rnd() * big.length)], point(s, a), h, upper + (0.1 + 0.25 * rnd()) * h, upper, rnd);
      }
      // FRAMERS: a big boulder half in the bank at either end, sometimes.
      for (const side of [-1, 1]) {
        if (rnd() > 0.55 * Math.min(1, amount)) continue;
        const a = side * (1.0 + 0.15 * rnd());
        const s = st.brink - sh(a) + rnd() * st.c;
        const h = Math.max(0.9, Math.min(3.2, (0.9 + 0.7 * H) * (0.8 + 0.5 * rnd())));
        push("framer", big[Math.floor(rnd() * big.length)], point(s, a), h, upper + (0.3 + 0.35 * rnd()) * h, upper, rnd);
      }
      // STONES in the plunge pool, some just breaking the surface.
      const m = Math.round(2 * amount * rnd());
      for (let j = 0; j < m; j++) {
        const a = (rnd() * 2 - 1) * 0.7;
        const s = st.toe + (0.5 + 1.5 * rnd()) * Math.max(1, H);
        const h = 0.35 + 0.5 * rnd();
        push("stone", small[Math.floor(rnd() * small.length)], point(s, a), h, lower + (rnd() * 0.35 - 0.1), lower, rnd);
      }
    });
  }
  return out;
}

/** Instances per shape the meshes are allocated for (rebuilds refill, never reallocate). */
const CAPACITY = 1024;

/**
 * The rocks' scene objects: one InstancedMesh per shape, allocated once and
 * refilled on every rebuild (a drag rebuilds many times a second).
 */
export class RiverRocks {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.name = "RiverV3:rocks";
    parent.add(this.group);
    this._meshes = null;
    this._heights = null;
    this._ready = null;
    this.count = 0;
    // The level's rock look, wet below the water line: darker and glossier.
    const mat = new THREE.MeshStandardNodeMaterial({ color: ROCK_BASE_COLOR, roughness: 0.6 });
    applyRockShading(mat);
    const waterY = attribute("aWaterY", "float");
    const wet = float(1).sub(smoothstep(waterY.add(0.03), waterY.add(0.4), positionWorld.y));
    mat.colorNode = mat.colorNode.mul(mix(float(1), float(0.5), wet));
    mat.roughnessNode = mix(float(0.62), float(0.22), wet);
    this.material = mat;
  }

  /** Generate (or fetch from the props' memo) the shapes; resolves once. */
  ready() {
    this._ready ??= (async () => {
      const params = RIVER_ROCK_SHAPES.map(([name, , tris]) => ({ ...rockKitParams(name), targetTriangles: tris }));
      await prewarmRockGeometries(params).catch(() => {});
      this._heights = [];
      this._meshes = params.map((p, si) => {
        const kit = getRockGeometry(p);
        if (!kit.boundingBox) kit.computeBoundingBox();
        this._heights.push(Math.max(0.05, kit.boundingBox.max.y - kit.boundingBox.min.y));
        // The kit geometry is shared with the level's rock props: wrap its
        // attributes (same buffers) rather than add a per-instance one to it.
        const g = new THREE.BufferGeometry();
        g.setIndex(kit.index);
        for (const [name, attr] of Object.entries(kit.attributes)) g.setAttribute(name, attr);
        g.setAttribute("aWaterY", new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY), 1));
        const mesh = new THREE.InstancedMesh(g, this.material, CAPACITY);
        mesh.count = 0;
        mesh.name = `RiverV3:rocks:${si}`;
        // Pool stones sit in the water: their shadow is not worth a draw per cascade.
        mesh.castShadow = RIVER_ROCK_SHAPES[si][1] === "big";
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;      // bounds change with every rebuild
        this.group.add(mesh);
        return mesh;
      });
    })();
    return this._ready;
  }

  /** Rebuild from the solved reaches (no-op until the shapes are ready). */
  rebuild(reaches, { enabled, amount, groundAt }) {
    if (!this._meshes) return;
    const items = enabled && reaches ? placeRiverRocks(reaches, { amount, groundAt, shapeHeights: this._heights }) : [];
    const byShape = this._meshes.map(() => []);
    for (const it of items) byShape[it.shape].push(it);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
    let n = 0;
    byShape.forEach((list, si) => {
      const mesh = this._meshes[si], wy = mesh.geometry.attributes.aWaterY;
      const k = Math.min(CAPACITY, list.length);
      for (let i = 0; i < k; i++) {
        const it = list[i];
        e.set(it.tiltX, it.yaw, it.tiltZ); q.setFromEuler(e);
        m4.compose(v.set(it.x, it.y, it.z), q, sc.set(it.sx, it.sy, it.sz));
        mesh.setMatrixAt(i, m4);
        wy.array[i] = it.waterY;
      }
      mesh.count = k;
      mesh.instanceMatrix.needsUpdate = true;
      wy.needsUpdate = true;
      n += k;
    });
    this.count = n;
  }

  set visible(v) { this.group.visible = v; }
}
