// THE BRIDGES — the map's crossings rebuilt as Vietnam bridges (your ask,
// 2026-09-26: "not large enough for vehicles… they don't read Vietnam at all").
//
// nam-valley keeps its two bridge props (they say WHERE: see the bridges
// memory — a span is measured at deck height); this file decides WHAT stands
// there and hides the old arched bridge from another game:
//   • the northern crossing (32 m) → a BAILEY, the US engineers' panel bridge;
//   • the southern one (38 m, wider water) → a TIMBER TRESTLE on log bents;
//   • and a third, new: a cầu khỉ (monkey bridge) of bamboo half way between
//     them — INFANTRY ONLY (navGrid foot-only cells), so a squad can take a
//     short cut the vehicles have to drive round.
// Vehicle decks are 8 m (a tank is ~4.7 m wide at game scale): one lane.
//
// Every consumer reads the plan, app.namBridges: the landings (ramps at each
// end), the decks (what a unit stands on, with side walls), the nav carve.
// Each entry: { style, x, z, y, ax, az, half, halfWidth, footOnly, deckAt(s) }
// — (ax, az) the span direction, s metres along it from the centre, y the road
// surface at the ends.
import * as THREE from "three";
import { rtsObjectMaterial } from "../../v3/render/objects/rtsObjectProps.js";
import { buildBaileyBridge, buildTrestleBridge, buildMonkeyBridge, monkeyDeckRise } from "../../v3/render/objects/rtsBridges.js";
import { listBridgeProps } from "./bridgeLandings.js";

const VEHICLE_DECK = 8;        // m, kerb to kerb
const FOOT_DECK = 1.6;         // m, the bamboo walkway
const MONKEY_RISE = 0.6;       // m the walkway arches over its ends

/**
 * The footbridge's site: along the river, the station FARTHEST from both
 * bridges whose banks both reach deck height within a short span and match.
 */
function footbridgeSite(app, avoid) {
  const c = app.getRiverChannels?.()?.[0];
  if (!c || !app.getWorldHeight) return null;
  const H = (x, z) => app.getWorldHeight(x, z);
  let best = null;
  for (let i = 3; i < c.count - 3; i++) {
    const tx = c.x[i + 2] - c.x[i - 2], tz = c.z[i + 2] - c.z[i - 2], tl = Math.hypot(tx, tz) || 1;
    const nx = -tz / tl, nz = tx / tl;
    const x = c.x[i], z = c.z[i];
    const away = Math.min(...avoid.map((b) => Math.hypot(b.x - x, b.z - z)));
    if (away < 60 || (best && away <= best.away)) continue;
    const deck = c.level[i] + 1.6;
    const reach = (s) => { for (let d = 1; d <= 20; d += 0.5) if (H(x + nx * s * d, z + nz * s * d) >= deck) return d; return null; };
    const dl = reach(-1), dr = reach(1);
    if (dl == null || dr == null || dl + dr > 26) continue;
    const span = dl + dr + 2;             // a metre onto each bank
    const cx = x + (nx * (dr - dl)) / 2, cz = z + (nz * (dr - dl)) / 2;
    const eL = H(cx - nx * (span / 2 + 3), cz - nz * (span / 2 + 3)), eR = H(cx + nx * (span / 2 + 3), cz + nz * (span / 2 + 3));
    if (Math.abs(eL - eR) > 2.5) continue;
    best = { away, x: cx, z: cz, y: deck, ax: nx, az: nz, half: span / 2 };
  }
  return best;
}

/** Decide the bridges. Call once the world (and its river) is loaded, before the nav grid. */
export function planNamBridges(app) {
  const props = listBridgeProps(app);
  if (!props.length) return [];
  // The first prop in the map is the northern (Bailey) crossing; any others trestles.
  const byNorth = [...props].sort((a, b) => a.z - b.z).reverse();
  const plan = byNorth.map((b, k) => ({
    style: k === 0 ? "bailey" : "trestle",
    x: b.x, z: b.z, y: b.y, ax: b.ax, az: b.az, half: b.half,
    halfWidth: VEHICLE_DECK / 2, footOnly: false, propIdx: b.propIdx,
    deckAt: () => b.y,
  }));
  const foot = footbridgeSite(app, plan);
  if (foot) {
    plan.push({
      style: "monkey", ...foot, halfWidth: FOOT_DECK / 2, footOnly: true, propIdx: -1,
      deckAt: (s) => foot.y + monkeyDeckRise(s, foot.half * 2, MONKEY_RISE),
    });
  }
  return plan;
}

/** Build every planned bridge, hide the old props. Returns the meshes. */
export function buildNamBridges(app, plan) {
  const mat = rtsObjectMaterial();
  const meshes = [];
  for (const b of plan) {
    if (b.propIdx >= 0) {
      const old = app.getLivePropObject?.(b.propIdx);
      if (old) old.visible = false;
    }
    // Local (x along, z across) → world; the drop from the road to the ground.
    const cx = -b.az, cz = b.ax;
    const depthAt = (x, z) => b.y - app.getWorldHeight(b.x + b.ax * x + cx * z, b.z + b.az * x + cz * z);
    const span = b.half * 2;
    const geo = b.style === "bailey" ? buildBaileyBridge({ span, width: VEHICLE_DECK, depthAt })
      : b.style === "trestle" ? buildTrestleBridge({ span, width: VEHICLE_DECK, depthAt })
      : buildMonkeyBridge({ span, width: FOOT_DECK, rise: MONKEY_RISE, depthAt });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `bridge:${b.style}`;
    // Basis: local X = the span, Y up, Z = across (X × Y).
    mesh.matrixAutoUpdate = false;
    mesh.matrix.makeBasis(new THREE.Vector3(b.ax, 0, b.az), new THREE.Vector3(0, 1, 0), new THREE.Vector3(cx, 0, cz));
    mesh.matrix.setPosition(b.x, b.y, b.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    app.scene.add(mesh);
    meshes.push(mesh);
    // Nothing grows through the deck: the old arch stood clear of the grass,
    // these decks sit at ground height at their ends.
    const n = Math.ceil((b.half * 2 + 6) / 3);
    for (let k = 0; k <= n; k++) {
      const s = -b.half - 3 + (k * (b.half * 2 + 6)) / n;
      app.clearVegetation?.(b.x + b.ax * s, b.z + b.az * s, b.halfWidth + 2, { grass: b.halfWidth + 1.5 });
    }
  }
  console.log(`[bridges] ${plan.map((b) => `${b.style} ${Math.round(b.half * 2)} m`).join(", ")}`);
  return meshes;
}
