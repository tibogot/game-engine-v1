// Camp perimeter — DEV (placed by the ?showcase=1 path until the editor can
// author it as splines, which is where it belongs: the wire, fence, lights and
// power line below are the editor's own spline objects).
//
// A firebase was a bulldozed ring: an earth BERM, and outside it the wire —
// chain-link, then concertina — with one gate. Laid out here as a U around
// the HQ shelf on nam-valley: down the west side from the terrace foot, along
// the south with the gate on it, and up the east side into the terrace. The
// terrace wall behind the HQ closes the north.
//
// Layers, inside to out: floodlight masts · berm (on the line) · chain-link
// (+5 m) · 2+1 concertina (+9 m). The concertina is a nav BARRIER, split at
// the gate, so the gate is the only way in or out on foot or wheels.
import * as THREE from "three";
import { buildBarbWireMesh } from "../../v2/objects/barbWire.js";
import { buildChainLinkFenceMesh } from "../../v2/objects/chainLinkFence.js";
import { buildFloodlightMesh } from "../../v2/objects/floodlight.js";
import { buildPowerLineMesh } from "../../v2/objects/powerLine.js";
import { buildGate, buildGuardTower } from "../../v3/render/objects/rtsFirebaseProps.js";
import { rtsObjectMaterial } from "../../v3/render/objects/rtsObjectProps.js";

const S = 1.3; // real x 1.3, the units' scale

/** The ring's line, as offsets from the base point (door toward -Z). */
const LINE = [
  [-66, 26], [-66, -62], [66, -62], [66, 6], [46, 18],
];
const GATE = { dx: 4, dz: -62 };   // on the south side, where the road leaves
const GATE_HALF = 7;               // metres of opening either side of the gate centre

/** Offset a polyline sideways by `d` (positive = outward for this U). */
function offsetLine(pts, d) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const tx = b.x - a.x, tz = b.z - a.z, L = Math.hypot(tx, tz) || 1;
    // Outward is the tangent turned clockwise: the U runs south, east, north.
    let nx = tz / L, nz = -tx / L;
    // Miter at inner corners: push by 1/cos of the half-angle (capped).
    let k = 1;
    if (i > 0 && i < pts.length - 1) {
      const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
      const d0x = p1.x - p0.x, d0z = p1.z - p0.z, d1x = p2.x - p1.x, d1z = p2.z - p1.z;
      const l0 = Math.hypot(d0x, d0z) || 1, l1 = Math.hypot(d1x, d1z) || 1;
      const n0x = d0z / l0, n0z = -d0x / l0, n1x = d1z / l1, n1z = -d1x / l1;
      nx = n0x + n1x; nz = n0z + n1z;
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl; nz /= nl;
      k = Math.min(2, 1 / Math.max(0.5, nx * n0x + nz * n0z));
    }
    out.push({ x: pts[i].x + nx * d * k, z: pts[i].z + nz * d * k });
  }
  return out;
}

/** Cut a polyline around the gate: the two runs either side of the opening. */
function splitAtGate(pts, gate, half) {
  const runs = [[]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 1.5));
    for (let k = 0; k <= steps; k++) {
      if (i > 0 && k === 0) continue;
      const p = { x: a.x + ((b.x - a.x) * k) / steps, z: a.z + ((b.z - a.z) * k) / steps };
      const inGap = Math.abs(p.x - gate.x) < half && Math.abs(p.z - gate.z) < 14;
      if (inGap) { if (runs[runs.length - 1].length) runs.push([]); continue; }
      runs[runs.length - 1].push(p);
    }
  }
  // Thin back to spline control points (every ~6 m) — the builders smooth them.
  return runs.filter((r) => r.length > 1).map((r) => r.filter((_, i) => i % 4 === 0 || i === r.length - 1));
}

export async function placeCampPerimeter(app) {
  const base = app.structures?.base;
  if (!base) return null;
  const bp = base.position;
  const W = (dx, dz) => ({ x: bp.x + dx, z: bp.z + dz });
  const line = LINE.map(([dx, dz]) => W(dx, dz));
  const gate = W(GATE.dx, GATE.dz);
  const h = (x, z) => app.getWorldHeight(x, z);
  const group = new THREE.Group();
  group.name = "CampPerimeter";
  app.scene.add(group);

  // 0) The gate's pad FIRST: cut after the berm rose, its rim left a steep
  //    wall at the berm's end that the slope lock painted as cliff rock.
  // The gate's road runs along its local Z; the perimeter here runs along X.
  const gateGeo = buildGate();
  const fp = gateGeo.userData.footprint;
  await app.flattenRect?.(gate.x + fp.cx, gate.z + fp.cz, fp.hx, fp.hz, h(gate.x, gate.z), { rim: 3 });

  // 1) The berm, into the terrain itself (walkable at ~27°: the wire is what
  //    stops people, the berm is what they fight from).
  // Sides kept near 26° (π/2·H/(half width)): past 30° the map's slope lock
  // paints them cliff rock. A long taper at the gate, or its ends are steep too.
  await app.raiseBerm?.(line, { height: 1.8 * S, base: 13 * S, top: 1.4 * S, taper: 10, gaps: [{ x: gate.x, z: gate.z, r: GATE_HALF + 2 }] });
  app.clearVegetation?.(gate.x, gate.z, 10, { grass: 8 });

  // 2) Chain-link and concertina, each in two runs either side of the gate.
  const fence = splitAtGate(offsetLine(line, 5 * S), gate, GATE_HALF);
  const wire = splitAtGate(offsetLine(line, 9 * S), gate, GATE_HALF);
  for (const run of fence) {
    const m = buildChainLinkFenceMesh({
      points: run, getWorldHeight: h,
      params: { height: 2.4 * S, postSpacing: 3 * S, postRadius: 0.045 * S, railRadius: 0.03 * S, meshPitch: 0.14 * S,
        armLength: 0.45 * S, armRadius: 0.03 * S, strandRadius: 0.012 * S, barbSize: 0.045 * S, armSide: "out",
        meshColor: "#9ea49a", postColor: "#6e7368", railColor: "#6a6f64" },
    });
    if (m) group.add(m);
  }
  for (const run of wire) {
    const m = buildBarbWireMesh({
      points: run, getWorldHeight: h,
      params: { stacking: "pyramid", coilRadius: 0.45 * S, coilPitch: 0.22 * S, wireRadius: 0.012 * S, barbSize: 0.055 * S,
        barbSpacing: 1.4, stakeSpacing: 4 * S, stakeWidth: 0.05 * S, rust: 0.55 },
    });
    if (m) group.add(m);
    app.navGrid?.addBarrier?.(run);
  }

  // 3) Floodlight masts just inside the berm, aimed out over the wire.
  const lights = buildFloodlightMesh({
    points: offsetLine(line, -7 * S), getWorldHeight: h,
    params: { spacing: 42, sideOffset: 0, side: "left", mastHeight: 9 * S, mastRadiusBase: 0.2 * S, mastRadiusTop: 0.12 * S,
      lampCols: 2, lampRows: 1, lampW: 0.6 * S, lampH: 0.45 * S, lampGap: 0.1 * S, headTiltDeg: 24, emissive: 1.6,   // daytime: lit but not blazing; night is a later pass
      colorMast: "#4b4f47", colorHousing: "#23261f" },
  });
  if (lights) group.add(lights);

  // 4) A power line from the gate up the road to the HQ.
  const pl = buildPowerLineMesh({
    points: [W(GATE.dx - 9, GATE.dz + 8), W(-12, -34), W(-14, -16)], getWorldHeight: h,
    params: { spacing: 18 * S, poleHeight: 7 * S, poleRadius: 0.14 * S, crossarmLength: 2.4 * S, crossarmThick: 0.12 * S, wireSag: 1.2, wireRadius: 0.03 },
  });
  if (pl) group.add(pl);

  // 5) The gate itself (its pad went in first), and guard towers on the two
  //    south corners.
  const mat = rtsObjectMaterial();
  const put = (geo, x, z, ry) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, h(x, z) - 0.02, z);
    m.rotation.y = ry;
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    return m;
  };
  put(gateGeo, gate.x, gate.z, 0);
  // 16 m in from both berm lines: closer, a tower's pad cut into the berm's inner slope.
  for (const [dx, dz] of [[-50, -46], [50, -46]]) {
    const p = W(dx, dz);
    await app.flattenRect?.(p.x, p.z, 3.2 * S, 3.2 * S, h(p.x, p.z), { rim: 3 });
    put(buildGuardTower({ seed: 13 + dx }), p.x, p.z, Math.PI / 4 * Math.sign(dx));
    app.clearVegetation?.(p.x, p.z, 7, { grass: 6 });
  }

  // The ground changed (berm, pads): rebuild nav with the wire as a barrier,
  // re-stamp the buildings, re-bake cover.
  app.navGrid?.rebuild();
  for (const s of app.structures.list) if (s.alive) app.navGrid?.addStructureObstacle(s);
  app.cover?.bake?.();
  return group;
}
