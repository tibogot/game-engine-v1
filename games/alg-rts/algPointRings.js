// THE SUPPLY POINTS' RINGS IN THE GAME (2026-10-12, you: "let's go" — the lab's marks ported; only the
// requisition points, the villages keep theirs; shown "exactly like CoH": ALWAYS, nobody selected).
//
//   RINGS     every supply point's ring in ONE instanced draw (algPointMarks.js builders: dash-dot
//             white neutral, the leaning side's colour filling it with the capture, solid when held,
//             amber when France holds it cut off), draped on the terrain in the vertex shader.
//   CAPTURE   a point changing hands plays the lab's capture: the ring's flash (its own instance
//             attribute) and, from a POOL of a few effect sets reused point to point, the disc, the
//             waves, the column of light and the thin lines — drawn only while one plays (2.4 s).
//   VILLAGES  (2026-10-22, you: "when taking a town the only thing that makes the difference is the flag") the same
//             capture, from their own small pool, AT THE VILLAGE'S FLAGPOLE and VILLAGE_FX m across (CoH's town
//             points burst at the flag, not over the whole sector); their rings stay their own (algUnits).
//
// Per frame: 9 points' state written to two small instance buffers. Nothing else when no capture runs.
import * as THREE from "three";
import { attribute, float, uniform, vec3 } from "three/tsl";
import { drapedPosition } from "../shared-rts/terrainDrape.js";
import { RENDER_ORDER } from "../shared-rts/renderOrder.js";
import { POINT_MARKS, markGeometries, markMaterials, ringStateOf } from "./algPointMarks.js";

const LIFT = 0.12;     // m over the draped ground (the ring never z-fights it)
const POOL = 3;        // capture effects at once (two points taken in the same 2.4 s is already rare)
const VILLAGE_FX = 12; // m: a village's capture burst (its ring is 22-40 m: the burst is the flag's, not the sector's)
const VILLAGE_POOL = 2;

/**
 * @param {object} app
 * @param {object} o
 * @param {object} o.economy  algEconomy (allPoints, params.hold)
 */
export function createAlgPointRings(app, { economy }) {
  const points = economy.allPoints.filter((p) => p.kind === "supply");
  const radius = points[0]?.radius ?? 11;
  const hold = economy.params.hold;
  const H = app.heightTexNode;
  const n = points.length;
  const geos = markGeometries(radius);

  // ── THE RINGS: one instanced draw ─────────────────────────────────────────
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = geos.ring.index;
  geo.setAttribute("position", geos.ring.attributes.position);
  const aCenter = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 2), 2);
  const aFill = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 3), 3);
  const aState = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 2), 2);   // progress, capture 0..1
  aFill.setUsage(THREE.DynamicDrawUsage);
  aState.setUsage(THREE.DynamicDrawUsage);
  points.forEach((p, i) => { aCenter.setXY(i, p.position.x, p.position.z); aState.setXY(i, 0, 1); });
  geo.setAttribute("aCenter", aCenter);
  geo.setAttribute("aFill", aFill);
  geo.setAttribute("aState", aState);
  geo.instanceCount = n;
  const c = attribute("aCenter", "vec2"), st = attribute("aState", "vec2");
  const ringMat = markMaterials({
    radius, only: ["ring"],
    src: { fill: attribute("aFill", "vec3"), base: vec3(1, 1, 1), progress: st.x, T: st.y },
    place: (p) => drapedPosition(H, p.x.add(c.x), p.z.add(c.y), LIFT),
  }).ring;
  const rings = new THREE.Mesh(geo, ringMat);
  rings.name = "SupplyPointRings";
  rings.frustumCulled = false;            // instances anywhere on the map
  rings.renderOrder = RENDER_ORDER.ON_GROUND;
  app.scene.add(rings);

  // ── THE CAPTURE EFFECTS: a pool, reused point to point ────────────────────
  const effects = makePool(radius, POOL, geos);
  const vGeos = markGeometries(VILLAGE_FX), vEffects = makePool(VILLAGE_FX, VILLAGE_POOL, vGeos);
  function makePool(radius, count, geos) {
  const effects = [];
  for (let k = 0; k < count; k++) {
    const U = { fill: uniform(new THREE.Color()), T: uniform(1), cx: uniform(0), cz: uniform(0) };
    const mats = markMaterials({
      radius, only: ["disc", "wave", "pillar", "streaks"],
      src: { fill: U.fill, base: vec3(1, 1, 1), progress: float(1), T: U.T },
      place: (p) => drapedPosition(H, p.x.add(U.cx), p.z.add(U.cz), LIFT + 0.02),
    });
    const mk = (key, order) => {
      const m = new THREE.Mesh(geos[key], mats[key]);
      m.frustumCulled = false;
      m.renderOrder = order;
      m.visible = false;
      app.scene.add(m);
      return m;
    };
    const fx = {
      U, t: 1, i: -1,
      disc: mk("disc", RENDER_ORDER.ON_GROUND), wave: mk("wave", RENDER_ORDER.ON_GROUND),
      pillar: mk("pillar", RENDER_ORDER.AIR), streaks: mk("streaks", RENDER_ORDER.AIR),
    };
    effects.push(fx);
  }
  return effects;
  }
  const burst = new Float32Array(Math.max(1, n)).fill(1);   // each point's capture 0..1 (the ring's flash)
  const owner = points.map((p) => p.owner ?? null);

  function playAt(pool, x, z, colour) {
    const fx = pool.find((e) => e.t >= 1) ?? pool.reduce((a, b) => (b.t > a.t ? b : a));
    fx.t = 0;
    fx.U.fill.value.set(colour);
    fx.U.cx.value = x; fx.U.cz.value = z;
    const y = app.getWorldHeight(x, z);
    fx.pillar.position.set(x, y, z);
    fx.streaks.position.set(x, y, z);
    fx.disc.visible = fx.wave.visible = fx.pillar.visible = fx.streaks.visible = true;
  }
  function play(i, colour) {
    const p = points[i];
    playAt(effects, p.position.x, p.position.z, colour);
    burst[i] = 0;
  }
  // THE VILLAGES: each one's holder watched; a change plays the burst at its flagpole (algPointFlags), else its centre
  const villages = economy.allPoints.filter((p) => p.kind !== "supply");
  const vOwner = villages.map((p) => p.owner ?? null);
  const poleOf = (p) => app.algPointFlags?.flags?.find((f) => f.pt === p)?.flag?.group?.position ?? p.position;
  function playVillage(p) { const at = poleOf(p); playAt(vEffects, at.x, at.z, ringStateOf(p, hold).colour); }

  const _c = new THREE.Color();
  function frame(dt) {
    dt = Math.min(dt, 0.1);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const s = ringStateOf(p, hold);
      // Taken: the capture plays (in the new holder's colour — amber if it is cut off at once).
      if (p.owner && p.owner !== owner[i]) play(i, s.colour);
      owner[i] = p.owner ?? null;
      if (burst[i] < 1) burst[i] = Math.min(1, burst[i] + dt / POINT_MARKS.captureS);
      _c.set(s.colour);
      aFill.setXYZ(i, _c.r, _c.g, _c.b);
      aState.setXY(i, s.progress, burst[i]);
    }
    aFill.needsUpdate = true;
    aState.needsUpdate = true;
    for (let k = 0; k < villages.length; k++) {
      const p = villages[k];
      if (p.owner && p.owner !== vOwner[k]) playVillage(p);
      vOwner[k] = p.owner ?? null;
    }
    for (const fx of [...effects, ...vEffects]) {
      if (fx.t >= 1) continue;
      fx.t = Math.min(1, fx.t + dt / POINT_MARKS.captureS);
      fx.U.T.value = fx.t;
      if (fx.t >= 1) fx.disc.visible = fx.wave.visible = fx.pillar.visible = fx.streaks.visible = false;
    }
  }

  return {
    points, rings, effects, frame, villages,
    /** Play a village's capture now (the dev console, a test). */
    playVillage: (k) => playVillage(villages[k]),
    /** Play a point's capture now (the dev console, a test). */
    play: (i) => play(i, ringStateOf(points[i], hold).colour),
    stats: { rings: n, radius },
    dispose() {
      app.scene.remove(rings); geo.dispose(); ringMat.dispose();
      for (const fx of [...effects, ...vEffects]) for (const k of ["disc", "wave", "pillar", "streaks"]) { app.scene.remove(fx[k]); fx[k].material.dispose(); }
      for (const g of [...Object.values(geos), ...Object.values(vGeos)]) g.dispose();
    },
  };
}
