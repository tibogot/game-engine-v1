// ── CAR PARKS IN THE SQUARES ─────────────────────────────────────────────────
//
// Some of the plazas become surface car parks: painted bays, and cars standing
// in them.
//
// ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────
//
// An empty paved block breaks the grid, which was the point of plazas — but a
// completely bare one reads as MISSING rather than as open, and the eye is
// good at telling the difference. A car park is the cheapest way to say the
// square is empty on purpose: it is still open ground, still breaks the
// skyline, and it now has a reason.
//
// ── WHAT IT COSTS ────────────────────────────────────────────────────────────
//
// One draw for every car park in the city, and nothing at all for the cars.
// The bay markings are one instanced quad per park with the lines drawn
// procedurally; the cars are extra INSTANCES in the four body meshes the
// street already has, so a hundred more parked cars is a hundred more
// matrices and not one more draw.
//
// ── THE BAYS AND THE LINES COME FROM ONE DESCRIPTION ─────────────────────────
//
// The single thing that can go wrong here is cars that do not line up with the
// paint, and that happens the moment the shader and the placer each know the
// bay pitch separately. So the geometry of a car park is defined ONCE, in
// `bayLayout`, and both read it: the placer walks it to put cars down, and the
// material is handed the same numbers as uniforms. There is no second copy to
// drift.

import * as THREE from "three";
import {
  uniform, uv, vec2, vec3, float, fract, abs, smoothstep, max, min, step, mix, floor,
} from "three/tsl";

export const CARPARK_DEFAULTS = {
  /** Off and the squares stay empty. */
  carParks: true,
  /** Chance a plaza becomes one. Not all of them: an open square and a car
   *  park say different things, and a city wants both. */
  carParkChance: 0.6,
  /** Margin from the block edge to the first bay line, metres. */
  parkMargin: 7.0,
  /** One bay. */
  bayWidth: 2.65,
  bayDepth: 5.4,
  /** Between two ranks parked nose to nose. */
  parkAisle: 6.4,
  /** How many bays have a car in them. Never 1: a full car park with every
   *  space taken is the one arrangement a real one is never in. */
  parkOccupancy: 0.62,
  /** Paint. */
  parkLineW: 0.12,
  parkLineColor: 0xc9c6ba,
  parkSurface: 0x2b2c30,
  /** Lifted off the walk so it cannot z-fight the street plane. */
  parkLift: 0.035,
};

/**
 * THE ONE DESCRIPTION OF A CAR PARK'S GEOMETRY.
 *
 * Returns the numbers the placer walks and the shader is given. Both callers
 * take them from here, so a car can never stand between two painted bays.
 */
export function bayLayout(P, blockW) {
  const usable = Math.max(blockW - P.parkMargin * 2, P.bayDepth * 2);
  const rowPitch = P.bayDepth * 2 + P.parkAisle;   // two ranks and the aisle
  const rows = Math.max(1, Math.floor(usable / rowPitch));
  const cols = Math.max(1, Math.floor(usable / P.bayWidth));
  // Centre the whole arrangement in the block rather than letting it grow from
  // one corner: the remainder is split, so a car park looks laid out.
  const spanZ = rows * rowPitch - P.parkAisle;
  const spanX = cols * P.bayWidth;
  return {
    rows, cols, rowPitch, spanX, spanZ,
    x0: -spanX * 0.5,
    z0: -spanZ * 0.5,
    bayWidth: P.bayWidth, bayDepth: P.bayDepth, aisle: P.parkAisle,
  };
}

/**
 * Which squares become car parks, and where every car in them stands.
 *
 * `skip` is the plaza something else has already taken — the prism stands in
 * one, and parking a hundred cars around it would be two ideas about the same
 * square.
 */
export function planCarParks({ plazas = [], blockW, rand, skip = null, params = {} } = {}) {
  const P = { ...CARPARK_DEFAULTS, ...params };
  if (!P.carParks || !plazas.length) return [];
  const L = bayLayout(P, blockW);
  const parks = [];
  for (const pz of plazas) {
    if (skip && pz.bx === skip.bx && pz.bz === skip.bz) continue;
    if (rand(pz.bx, pz.bz, 57) >= P.carParkChance) continue;
    const bays = [];
    for (let r = 0; r < L.rows; r++) {
      const rz = L.z0 + r * L.rowPitch;
      for (let rank = 0; rank < 2; rank++) {
        // Nose to nose: the near rank faces +z, the far rank faces -z, so the
        // two meet at the line between them the way a real double row does.
        const cz = rz + (rank === 0 ? L.bayDepth * 0.5 : L.bayDepth * 1.5);
        const yaw = rank === 0 ? 0 : Math.PI;
        for (let c = 0; c < L.cols; c++) {
          if (rand(pz.bx * 131 + r * 17 + rank, pz.bz * 71 + c, 59) >= P.parkOccupancy) continue;
          const cx = L.x0 + (c + 0.5) * L.bayWidth;
          bays.push({
            x: pz.x + cx,
            z: pz.z + cz,
            // A car is never quite square in its bay, and every car being
            // exactly square is more obviously wrong than any single one
            // being crooked.
            yaw: yaw + (rand(pz.bx + c, pz.bz + r, 61) - 0.5) * 0.10,
          });
        }
      }
    }
    parks.push({ x: pz.x, z: pz.z, y: pz.y, bx: pz.bx, bz: pz.bz, bays });
  }
  return parks;
}

/**
 * The painted surface: one instanced quad per park.
 *
 * Every park is one block, so the metres-per-UV scale is the same for all of
 * them and one material serves the lot with no per-instance data at all.
 */
export function buildCarParkGround(parks, P, blockW) {
  if (!parks.length) return null;
  const L = bayLayout(P, blockW);
  const geo = new THREE.PlaneGeometry(blockW, blockW);
  geo.rotateX(-Math.PI / 2);

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.86, metalness: 0.0 });
  mat.name = "CityCarPark";
  const uBlock = uniform(blockW);
  const uBayW = uniform(L.bayWidth);
  const uBayD = uniform(L.bayDepth);
  const uPitch = uniform(L.rowPitch);
  const uX0 = uniform(L.x0 + blockW * 0.5);
  const uZ0 = uniform(L.z0 + blockW * 0.5);
  const uSpanX = uniform(L.spanX);
  const uSpanZ = uniform(L.spanZ);
  const uLineW = uniform(P.parkLineW);
  const uLine = uniform(new THREE.Color(P.parkLineColor));
  const uSurf = uniform(new THREE.Color(P.parkSurface));

  // Metres across the block, from the same corner the layout measures from.
  const p = uv().mul(uBlock);
  const px = p.x.sub(uX0).toVar();
  const pz = p.y.sub(uZ0).toVar();
  // Inside the marked area at all?
  const inside = step(float(0.0), px).mul(step(px, uSpanX))
    .mul(step(float(0.0), pz)).mul(step(pz, uSpanZ));

  const aa = float(0.035);
  const half = uLineW.mul(0.5);
  const lineAt = (d) => smoothstep(half.add(aa), half.sub(aa), abs(d));

  // The bay dividers: one every bay width, but only across the two ranks —
  // never across the aisle, which is exactly what tells you it IS an aisle.
  const rowV = fract(pz.div(uPitch)).mul(uPitch).toVar();
  const inRank = step(rowV, uBayD.mul(2.0));
  const div = lineAt(fract(px.div(uBayW)).sub(0.5).mul(uBayW)).mul(inRank);
  // The head of each rank, and the line the two ranks meet on.
  const heads = max(max(lineAt(rowV), lineAt(rowV.sub(uBayD.mul(2.0)))), lineAt(rowV.sub(uBayD)));
  const paint = max(div, heads).mul(inside);

  mat.colorNode = mix(uSurf, uLine, paint);
  mat.roughnessNode = mix(float(0.88), float(0.7), paint);

  const mesh = new THREE.InstancedMesh(geo, mat, parks.length);
  mesh.name = "CityCarPark";
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  const m = new THREE.Matrix4();
  parks.forEach((pk, i) => {
    m.makeTranslation(pk.x, pk.y + P.parkLift, pk.z);
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  return {
    mesh,
    dispose() { geo.dispose(); mat.dispose(); mesh.dispose(); },
  };
}
