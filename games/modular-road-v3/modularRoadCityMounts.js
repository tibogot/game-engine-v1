// ── THINGS BOLTED TO WINDOWS ─────────────────────────────────────────────────
//
// Air-conditioning units in some of the windows, balconies under some of the
// others, a fire escape zig-zagging up one face of some mid-rises. Three's
// city generator has the first (12% of shaft windows, louvred, streaked with
// condensate) and it is the single cheapest thing that breaks a tower's grid:
// a small box hanging off a wall says someone lives there.
//
// All of them need to know where the windows ARE, which the shader decides per pixel
// and the CPU never knew — see modularRoadCityFacadeLayout.js, which is that
// arithmetic transcribed. Everything here reads it and nothing here guesses.
//
// ── COST ─────────────────────────────────────────────────────────────────────
//
// Four instanced meshes, four draws. Tens of thousands of candidates across the
// city, but a unit is 40 cm tall and unreadable past a couple of hundred
// metres, so the LOD tick fills each mesh with what is near and in view —
// buildings first (two thousand tests), then only the windows of the ones that
// passed — and cuts at a capacity. Matrices are stored flat, sixteen floats
// each, not as Matrix4 objects: seventy thousand of those is fourteen
// megabytes of headers.

import * as THREE from "three";
import { Fn, vec3, mix, uv, step, fract, float, normalLocal, vertexColor } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { BUILDING_TYPE, DISTRICT } from "./modularRoadCityFacade.js";
import { lotDice, faceLayout, windowsOf, tierFaces, pcgHash } from "./modularRoadCityFacadeLayout.js";
import { shareInstancePipeline } from "../../v3/render/instancePipeline.js";

export const MOUNT_DEFAULTS = {
  acUnits: true,
  /** Fraction of eligible windows with a unit. The example's 0.12. */
  acChance: 0.12,
  acW: 0.66, acH: 0.40,
  /** Deep enough to sit on the sill inside the recess and still stand 12 cm
   *  proud of the wall, which is where you notice it. */
  acD: 0.70,
  /** Draw range and the mesh's capacity. Past the range a unit is a pixel. */
  acRange: 230,
  acMax: 9000,

  balconies: true,
  /** Fraction of ELIGIBLE buildings — masonry, not industrial, low enough to
   *  be flats rather than offices — and of windows on their two chosen faces. */
  balconyBuildings: 0.30,
  balconyFraction: 0.65,
  balconyMaxHeight: 42,
  balconyDepth: 1.1,
  balconySlab: 0.14,
  railHeight: 1.0,
  balconyRange: 320,
  balconyMax: 7000,

  /**
   * ── FIRE ESCAPES ─────────────────────────────────────────────────────────
   * One face of some masonry mid-rises: a landing at every floor across two
   * bays, a stair run between landings alternating direction, a ladder
   * hanging from the lowest. The single most "city" thing a brick wall can
   * carry, and a zig-zag of shadow across it in the afternoon.
   */
  fireEscapes: true,
  escapeBuildings: 0.35,
  /** Mid-rises only: below the hero adverts (which stand off 45 cm — a landing
   *  would run through one), above the two-storey shops. */
  escapeMinHeight: 14,
  escapeMaxHeight: 40,
  escapeDepth: 1.2,
  escapeRange: 320,
  escapeMax: 4000,
};

/**
 * @param {object} o
 * @param {Array}  o.buildings     the city's placed buildings
 * @param {Array}  o.archetypes    the kit's archetypes (for tiers)
 * @param {object} o.facadeParams  the facade's LIVE params — bayFit and friends
 * @param {number} o.lotSize
 * @param {object} [o.params]      overrides on MOUNT_DEFAULTS
 */
export function createCityMounts({ buildings, archetypes, facadeParams, lotSize, params = {} }) {
  const M = { ...MOUNT_DEFAULTS, ...params };
  const group = new THREE.Group();
  group.name = "CityMounts";

  // ── Per-building candidate lists ───────────────────────────────────────────
  /** {x,y,z, ac: Float32Array[], bal: Float32Array[]} per building with any. */
  const perBuilding = [];
  let acTotal = 0, balTotal = 0, escTotal = 0;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  /** A stable 0..1 roll from a few small integers — the same PCG the facade uses. */
  const roll = (a, b, c, d, e) => pcgHash((((a * 73856093) ^ (b * 19349663) ^ (c * 83492791) ^ (d * 1299709) ^ (e * 15485863)) >>> 0));

  for (const b of buildings) {
    const a = archetypes[b.arch];
    if (!a || !a.tiers) continue;
    const isPunched = b.btype === BUILDING_TYPE.punched;
    const isIndustrial = b.district === DISTRICT.industrial;
    const scaleY = b.scaleY || 1;
    const dice = lotDice(b.x, b.z, lotSize);
    const bh = a.massHeight * scaleY;

    // Balconies: a building-level decision, then two faces of it.
    const balconyBuilding = M.balconies && isPunched && !isIndustrial
      && bh <= M.balconyMaxHeight && roll(b.cx, b.cz, 11, 0, 0) < M.balconyBuildings;
    const balFace0 = Math.floor(roll(b.cx, b.cz, 12, 0, 0) * 4);
    const balFace1 = (balFace0 + 1 + Math.floor(roll(b.cx, b.cz, 13, 0, 0) * 3)) % 4;

    /*
     * The fire escape: a building-level decision, ONE face, never a balcony
     * face, and its two bays keep their windows clear of AC units. Decided
     * before the window loop so the units can defer to it.
     */
    const escapeBuilding = M.fireEscapes && isPunched && !isIndustrial
      && bh >= M.escapeMinHeight && bh <= M.escapeMaxHeight
      && roll(b.cx, b.cz, 14, 0, 0) < M.escapeBuildings;
    let escFace = Math.floor(roll(b.cx, b.cz, 15, 0, 0) * 4);
    if (balconyBuilding) { while (escFace === balFace0 || escFace === balFace1) escFace = (escFace + 1) % 4; }
    let escBay = -1;   // the first of its two bays, on tier 0 of `escFace`

    const ac = [], bal = [], esc = [], escS = [];
    a.tiers.forEach((t, ti) => {
      const tierBottom = b.y + t.y * scaleY;
      const Hf = t.h * scaleY;
      const faces = tierFaces(b.x, b.z, t);
      faces.forEach((f, fi) => {
        const L = faceLayout({ P: facadeParams, dice, btype: b.btype, district: b.district, W: f.W, Hf, groundTier: ti === 0 });
        if (L.flat) return;
        const yaw = Math.atan2(f.n[0], f.n[1]);       // local +z → the face normal
        _q.setFromAxisAngle(UP, yaw);
        const wins = windowsOf(L, { groundTier: ti === 0 });

        // ── The fire escape, on tier 0 of its face, two bays wide.
        if (escapeBuilding && ti === 0 && fi === escFace && L.count >= 2 && L.nF >= 4) {
          escBay = Math.floor(roll(b.cx, b.cz, 16, 0, 0) * (L.count - 1));
          const uc = (L.oL + L.oR) * 0.5 - L.slotL;
          const cu = L.uOrigin + (escBay + 0.5) * L.bay + uc;          // between the two windows
          const width = L.bay + (L.oR - L.oL) + 0.4;
          const cx = f.origin[0] + f.along[0] * cu, cz = f.origin[1] + f.along[1] * cu;
          const D = M.escapeDepth;
          const topF = L.nF - 1;
          // Landings at every floor from the first to the top.
          for (let k = 1; k <= topF; k++) {
            if (L.hasBase && k < L.nBase) continue;
            _p.set(cx, tierBottom + k * L.fh + 0.05, cz);
            _s.set(width, 1, 1);
            esc.push(new Float32Array(_m.compose(_p, _q, _s).elements));
          }
          // A stair between each pair of landings, alternating direction, and a
          // ladder hanging from the lowest one. Built from the LOW end so the
          // pitch stays under 90° and the treads keep facing up; direction is
          // a half-turn of yaw, which is why the stair has rails on both sides.
          const run = Math.max(width - 1.4, 1.2);
          const rise = L.fh;
          const len = Math.hypot(run, rise), pitch = Math.atan2(rise, run);
          const qs = new THREE.Quaternion(), qz = new THREE.Quaternion();
          const first = L.hasBase ? Math.max(1, L.nBase) : 1;
          for (let k = first; k < topF; k++) {
            const dir = (k % 2 === 0) ? 1 : -1;
            const x0 = -dir * run * 0.5, y0 = k * rise + 0.05;
            const mx = cx + f.along[0] * (x0 + dir * run * 0.5), mz = cz + f.along[1] * (x0 + dir * run * 0.5);
            qs.setFromAxisAngle(UP, yaw + (dir < 0 ? Math.PI : 0));
            qz.setFromAxisAngle(new THREE.Vector3(0, 0, 1), pitch);
            qs.multiply(qz);
            _p.set(mx + f.n[0] * D * 0.55, tierBottom + y0 + rise * 0.5, mz + f.n[1] * D * 0.55);
            _s.set(len, 1, 1);
            escS.push(new Float32Array(_m.compose(_p, _q.copy(qs), _s).elements));
          }
          // The drop ladder: a short vertical run below the first landing, at
          // its outer edge. It stops two metres up — a car roof is 1.3.
          {
            const ladder = Math.max(0.5, Math.min(2.0, first * rise - 1.9));
            qs.setFromAxisAngle(UP, yaw);
            qz.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
            qs.multiply(qz);
            _p.set(cx + f.n[0] * (D - 0.3), tierBottom + first * rise - ladder * 0.5, cz + f.n[1] * (D - 0.3));
            _s.set(ladder, 1, 0.6);
            escS.push(new Float32Array(_m.compose(_p, _q.copy(qs), _s).elements));
          }
          _q.setFromAxisAngle(UP, yaw);   // restore for the windows below
        }

        for (const w of wins) {
          const wx = f.origin[0] + f.along[0] * w.u, wz = f.origin[1] + f.along[1] * w.u;
          // A window the fire escape lands on keeps its sill clear.
          const underEscape = escapeBuilding && ti === 0 && fi === escFace && escBay >= 0
            && (w.bi === escBay || w.bi === escBay + 1);
          // ── The unit: on the sill, back against the glass, nose out past the wall.
          if (M.acUnits && isPunched && !underEscape && roll(b.cx, b.cz, 20 + fi, ti * 97 + w.fi, w.bi) < M.acChance) {
            const inset = (facadeParams.pierDepth + facadeParams.reveal) - M.acD * 0.5;
            _p.set(wx - f.n[0] * inset, tierBottom + w.sill + M.acH * 0.5 + 0.03, wz - f.n[1] * inset);
            _s.set(1, 1, 1);
            ac.push(new Float32Array(_m.compose(_p, _q, _s).elements));
          }
          // ── The balcony: slab at floor level under the window, rails around it.
          if (balconyBuilding && (fi === balFace0 || fi === balFace1) && w.fi >= 1
            && roll(b.cx, b.cz, 30 + fi, ti * 97 + w.fi, w.bi) < M.balconyFraction) {
            const width = Math.min(w.w + 0.6, L.bay - 0.1);
            _p.set(wx, tierBottom + w.floorY, wz);
            _s.set(width, 1, 1);
            bal.push(new Float32Array(_m.compose(_p, _q, _s).elements));
          }
        }
      });
    });
    if (ac.length || bal.length || esc.length) {
      perBuilding.push({ x: b.x, y: b.y + bh * 0.5, z: b.z, r: Math.hypot(a.footprint, bh) * 0.5, ac, bal, esc, escS });
      acTotal += ac.length; balTotal += bal.length; escTotal += esc.length + escS.length;
    }
  }

  // ── The unit ───────────────────────────────────────────────────────────────
  // A box, off-white, with a dark louvred grille on its outward face — the
  // face is found from the local normal, the louvres from the box's own uv.
  const acGeo = new THREE.BoxGeometry(M.acW, M.acH, M.acD);
  const acMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.62, metalness: 0.0 });
  acMat.name = "CityAcUnits";
  acMat.colorNode = Fn(() => {
    const body = vec3(0.80, 0.79, 0.74);
    const grille = vec3(0.22, 0.23, 0.25).mul(float(0.85).add(step(0.5, fract(uv().y.mul(9.0))).mul(0.3)));
    const front = step(0.5, normalLocal.z);
    return mix(body, grille, front);
  })();
  const acMesh = shareInstancePipeline(new THREE.InstancedMesh(acGeo, acMat, Math.max(1, Math.min(M.acMax, acTotal))));
  acMesh.name = "CityAcUnits";
  acMesh.count = 0;
  acMesh.castShadow = true;
  acMesh.receiveShadow = true;
  acMesh.frustumCulled = false;
  group.add(acMesh);

  // ── The balcony ────────────────────────────────────────────────────────────
  // Slab plus three rails, one merged geometry at unit width; the instance
  // scales X to the window. A vertex-colour channel tells the material which
  // is slab (concrete) and which is rail (dark metal).
  const tint = (g, r) => {
    const n = g.attributes.position.count, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c[i * 3] = r;
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    return g;
  };
  const D = M.balconyDepth, S = M.balconySlab, RH = M.railHeight, RT = 0.05;
  const slab = new THREE.BoxGeometry(1, S, D); slab.translate(0, -S / 2, D / 2);
  const railF = new THREE.BoxGeometry(1, RH, RT); railF.translate(0, RH / 2, D - RT / 2);
  const railL = new THREE.BoxGeometry(RT, RH, D - RT); railL.translate(-0.5 + RT / 2, RH / 2, (D - RT) / 2);
  const railR = new THREE.BoxGeometry(RT, RH, D - RT); railR.translate(0.5 - RT / 2, RH / 2, (D - RT) / 2);
  const balGeo = mergeGeometries([tint(slab, 1), tint(railF, 0), tint(railL, 0), tint(railR, 0)], false);
  for (const g of [slab, railF, railL, railR]) g.dispose();
  const balMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.0 });
  balMat.name = "CityBalconies";
  balMat.colorNode = Fn(() => mix(vec3(0.16, 0.17, 0.18), vec3(0.62, 0.60, 0.56), vertexColor().r))();
  const balMesh = shareInstancePipeline(new THREE.InstancedMesh(balGeo, balMat, Math.max(1, Math.min(M.balconyMax, balTotal))));
  balMesh.name = "CityBalconies";
  balMesh.count = 0;
  balMesh.castShadow = true;
  balMesh.receiveShadow = true;
  balMesh.frustumCulled = false;
  group.add(balMesh);

  // ── The fire escape ────────────────────────────────────────────────────────
  // Landings: a grating slab with a rail on three sides, unit width, scaled to
  // two bays. Stairs: a tread slab with a rail on BOTH sides (see the note on
  // direction), unit length, scaled to the run. One dark-metal material with
  // a grating on horizontal faces and tread stripes along the stair.
  const ED = M.escapeDepth, ES = 0.06;
  const landSlab = new THREE.BoxGeometry(1, ES, ED); landSlab.translate(0, -ES / 2, ED / 2);
  const landF = new THREE.BoxGeometry(1, RH, RT); landF.translate(0, RH / 2, ED - RT / 2);
  const landL = new THREE.BoxGeometry(RT, RH, ED - RT); landL.translate(-0.5 + RT / 2, RH / 2, (ED - RT) / 2);
  const landR = new THREE.BoxGeometry(RT, RH, ED - RT); landR.translate(0.5 - RT / 2, RH / 2, (ED - RT) / 2);
  const landGeo = mergeGeometries([tint(landSlab, 1), tint(landF, 0), tint(landL, 0), tint(landR, 0)], false);
  for (const g of [landSlab, landF, landL, landR]) g.dispose();
  const stairSlab = new THREE.BoxGeometry(1, 0.08, 0.9);
  const stairA = new THREE.BoxGeometry(1, 0.9, RT); stairA.translate(0, 0.45, 0.45 - RT / 2);
  const stairB = new THREE.BoxGeometry(1, 0.9, RT); stairB.translate(0, 0.45, -0.45 + RT / 2);
  const stairGeo = mergeGeometries([tint(stairSlab, 1), tint(stairA, 0), tint(stairB, 0)], false);
  for (const g of [stairSlab, stairA, stairB]) g.dispose();
  const escMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.5 });
  escMat.name = "CityFireEscapes";
  escMat.colorNode = Fn(() => {
    const metal = vec3(0.13, 0.13, 0.14);
    // Grating on the walking surfaces: a fine mesh the eye reads as open steel.
    const flat = step(0.5, normalLocal.y);
    const mesh = step(0.5, fract(uv().x.mul(18.0))).add(step(0.5, fract(uv().y.mul(18.0)))).clamp(0.0, 1.0);
    const surf = mix(metal, metal.mul(0.55), flat.mul(mesh).mul(vertexColor().r));
    return surf;
  })();
  const escLandMesh = shareInstancePipeline(new THREE.InstancedMesh(landGeo, escMat, Math.max(1, Math.min(M.escapeMax, escTotal))));
  escLandMesh.name = "CityFireEscapeLandings";
  escLandMesh.count = 0;
  escLandMesh.castShadow = true;
  escLandMesh.receiveShadow = true;
  escLandMesh.frustumCulled = false;
  group.add(escLandMesh);
  const escStairMesh = shareInstancePipeline(new THREE.InstancedMesh(stairGeo, escMat, Math.max(1, Math.min(M.escapeMax, escTotal))));
  escStairMesh.name = "CityFireEscapeStairs";
  escStairMesh.count = 0;
  escStairMesh.castShadow = true;
  escStairMesh.receiveShadow = true;
  escStairMesh.frustumCulled = false;
  group.add(escStairMesh);

  /** What each mesh was sized for — see the note in `applyLod`. */
  const capacity = {
    ac: Math.max(1, Math.min(M.acMax, acTotal)),
    bal: Math.max(1, Math.min(M.balconyMax, balTotal)),
    esc: Math.max(1, Math.min(M.escapeMax, escTotal)),
    escS: Math.max(1, Math.min(M.escapeMax, escTotal)),
  };
  const stats = {
    acUnits: acTotal, balconies: balTotal, fireEscapes: escTotal, buildings: perBuilding.length,
    acDrawn: 0, balconiesDrawn: 0, escapesDrawn: 0,
  };

  /**
   * Fill both meshes with what is near and in view. Buildings are tested
   * first and sorted nearest-first, so when a mesh hits its capacity it is
   * the far ones that go.
   */
  const near = [];
  function applyLod(view) {
    const cam = view.pos;
    const rAc = M.acRange, rBal = M.balconyRange, rEsc = M.escapeRange;
    const rMax = Math.max(rAc, rBal, rEsc);
    near.length = 0;
    for (const pb of perBuilding) {
      const dx = pb.x - cam.x, dy = pb.y - cam.y, dz = pb.z - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > (rMax + pb.r) * (rMax + pb.r)) continue;
      if (!view.inView(pb.x, pb.y, pb.z, pb.r)) continue;
      pb.d2 = d2;
      near.push(pb);
    }
    near.sort((a, b) => a.d2 - b.d2);
    let na = 0, nb = 0, ne = 0, ns = 0;
    const acArr = acMesh.instanceMatrix.array, balArr = balMesh.instanceMatrix.array;
    const escArr = escLandMesh.instanceMatrix.array, escSArr = escStairMesh.instanceMatrix.array;
    // The capacity each mesh was BUILT with. Not `instanceMatrix.count`: the
    // matrix attribute is padded past three's uniform-buffer cliff so every
    // mesh shares one pipeline (v3/render/instancePipeline.js), so the
    // attribute is larger than the mesh is meant to draw.
    const capA = capacity.ac, capB = capacity.bal, capE = capacity.esc, capS = capacity.escS;
    for (const pb of near) {
      if (pb.d2 < (rAc + pb.r) * (rAc + pb.r)) {
        for (const e of pb.ac) {
          if (na >= capA) break;
          if (!view.inView(e[12], e[13], e[14], 0.6)) continue;
          acArr.set(e, na * 16); na++;
        }
      }
      if (pb.d2 < (rBal + pb.r) * (rBal + pb.r)) {
        for (const e of pb.bal) {
          if (nb >= capB) break;
          if (!view.inView(e[12], e[13], e[14], 1.5)) continue;
          balArr.set(e, nb * 16); nb++;
        }
      }
      if (pb.d2 < (rEsc + pb.r) * (rEsc + pb.r)) {
        for (const e of pb.esc) {
          if (ne >= capE) break;
          if (!view.inView(e[12], e[13], e[14], 3.0)) continue;
          escArr.set(e, ne * 16); ne++;
        }
        for (const e of pb.escS) {
          if (ns >= capS) break;
          if (!view.inView(e[12], e[13], e[14], 3.0)) continue;
          escSArr.set(e, ns * 16); ns++;
        }
      }
    }
    acMesh.count = na; acMesh.instanceMatrix.needsUpdate = true;
    balMesh.count = nb; balMesh.instanceMatrix.needsUpdate = true;
    escLandMesh.count = ne; escLandMesh.instanceMatrix.needsUpdate = true;
    escStairMesh.count = ns; escStairMesh.instanceMatrix.needsUpdate = true;
    stats.acDrawn = na; stats.balconiesDrawn = nb; stats.escapesDrawn = ne + ns;
  }

  return {
    group, stats, applyLod,
    /** The candidate lists, for a harness to check against the windows. */
    perBuilding,
    dispose() {
      group.remove(acMesh); acGeo.dispose(); acMat.dispose(); acMesh.dispose();
      group.remove(balMesh); balGeo.dispose(); balMat.dispose(); balMesh.dispose();
      group.remove(escLandMesh); landGeo.dispose(); escLandMesh.dispose();
      group.remove(escStairMesh); stairGeo.dispose(); escStairMesh.dispose();
      escMat.dispose();
    },
  };
}
