// Structures RENDERER — procedural geometry for the base and enemy turrets.
// Mirrors unitRenderer: all visuals here, logic stays mesh-free in structures.js.
//
// Every structure is built from boxes and cylinders and NEVER changes shape, so
// each KIND of rigid piece is baked into one geometry (per-part color kept in a
// vertex-color attribute) and drawn as a single InstancedMesh shared by every
// structure of that kind. Six turrets are one draw, not six — and a seventh
// turret, or a sixtieth, costs nothing.
//
// Only pieces that genuinely differ stay apart:
//   • enemy MG nests and their guns are instanced kinds (the kit's DShK nest)
//   • beacons are their own meshes — emissive MRT material (they bloom)
import * as THREE from "three";
import { makeBloomMaterial, BLOOM } from "./bloom.js";
import { buildQuonsetHQ } from "../../v3/render/objects/rtsQuonset.js";
import {
  GUN_PIT_HEAD_Y, GUN_PIT_MUZZLE, NEST_HEAD_Y, NEST_MUZZLE, buildNestBody, buildNestGun,
} from "../../v3/render/objects/rtsBuildables.js";
import { rtsObjectMaterial } from "../../v3/render/objects/rtsObjectProps.js";
import { buildTrainingTarget } from "../../v3/render/objects/rtsFirebaseProps.js";
import { buildColonialHQ } from "../../v3/render/objects/rtsColonial.js";
import {
  MORTAR_MUZZLE, SPIDER_MUZZLE, ZPU_MOUNT_Y, ZPU_MUZZLE, ZPU_TRUNNION_Y,
  buildBoobyTrap, buildMortarPit, buildMortarTube, buildPunjiPit, buildSpiderHole, buildSpiderMan,
  buildSupplyCache, buildTunnelEntrance, buildZpuBody, buildZpuGuns, buildZpuMount,
} from "../../v3/render/objects/rtsEnemyKit.js";
import { mayCastShadow, stencilMesh } from "../../v3/render/objects/rtsStencils.js";
import { WATCHTOWER_GUN_Y, buildBambooWatchtower } from "../../v3/render/objects/rtsEnemyCamp.js";

const MAX_PER_KIND = 64; // instance capacity per structure kind

/** Found traps get a ring on the ground: orange for a pit, red for a charge. */
const TRAP_RING = { punji: 0xff8a3a, boobyTrap: 0xff4438 };

// ── The rigid geometry of each kind, built once ──────────────────────────────

// The practice targets are the camp's RANGE now — an earth-and-sandbag butt
// with an E-type silhouette staked in front of it (rtsFirebaseProps
// buildTrainingTarget), instanced on the kit's atlas material like every other
// dug-in thing. They were three painted boxes, which read as placeholder art
// standing in the jungle outside a finished camp.

// Turret geometry lives in v3/render/objects/rtsBuildables.js: the enemy's DShK
// nest here, the player's M60 gun pit in buildingRenderer.js.

export const structureByMesh = new WeakMap(); // kept for API compatibility

export function createStructuresRenderer({ app, structures, healthBars, fogOfWar = null }) {
  const { scene } = app;

  const bloom = (color) => makeBloomMaterial(
    { color, blending: THREE.NormalBlending, depthWrite: true, transparent: false },
    BLOOM.beacon,
  );

  /** An instanced kind: `n` live instances this frame, `at[i]` → the structure. */
  const makeKind = (geometry, material, { shadow = false } = {}) => {
    const im = new THREE.InstancedMesh(geometry, material, MAX_PER_KIND);
    im.count = 0;
    im.castShadow = shadow && mayCastShadow(material);   // never a stencil: see mayCastShadow
    im.receiveShadow = shadow;
    im.frustumCulled = false;
    scene.add(im);
    return { im, n: 0, at: [] };
  };

  const kitMat = rtsObjectMaterial();
  const kinds = {
    // The nest and its gun, instanced: two draws for every enemy MG on the map,
    // and both hidden together under the fog of war.
    nest: makeKind(buildNestBody(), kitMat, { shadow: true }),
    head: makeKind(buildNestGun(), kitMat, { shadow: true }),
    // The Front's watchtowers (enemyLine.js): the tower, and the nest's own gun
    // on its platform (drawn in the `head` kind with the nests' guns).
    tower: makeKind(buildBambooWatchtower(), kitMat, { shadow: true }),
    // The Front's tunnel entrances: one draw for all of them.
    tunnel: makeKind(buildTunnelEntrance(), kitMat, { shadow: true }),
    // ZPU-4s: the pit (still), the mount (turns), the guns (turn and elevate).
    // Mortar pits: the pit and crew (still) and the tube (turns to its aim).
    mortarBody: makeKind(buildMortarPit(), kitMat, { shadow: true }),
    mortarTube: makeKind(buildMortarTube(), kitMat, { shadow: true }),
    zpuBody: makeKind(buildZpuBody(), kitMat, { shadow: true }),
    zpuMount: makeKind(buildZpuMount(), kitMat, { shadow: true }),
    zpuGuns: makeKind(buildZpuGuns(), kitMat, { shadow: true }),
    // The cheap nasty kit. These are drawn ONLY once your men have found them
    // (traps.js sets `hidden`), so the instance count is the number of traps
    // you know about, not the number that are out there.
    punji: makeKind(buildPunjiPit(), kitMat, { shadow: true }),
    boobyTrap: makeKind(buildBoobyTrap(), kitMat, { shadow: true }),
    cache: makeKind(buildSupplyCache(), kitMat, { shadow: true }),
    spiderHole: makeKind(buildSpiderHole(), kitMat, { shadow: true }),
    spiderMan: makeKind(buildSpiderMan(), kitMat, { shadow: true }),
    // The camp's range: a butt and a silhouette, one draw for the whole line.
    trainingDummy: makeKind(buildTrainingTarget(), kitMat, { shadow: true }),
  };
  const _x = new THREE.Vector3(1, 0, 0);
  const _qp = new THREE.Quaternion();
  /** A ZPU's guns: at the trunnions, turned to its yaw, elevated to its pitch. */
  const zpuGunMatrix = (s, out) => {
    const sink = (1 - (s.deploy ?? 1)) * 1.2;
    _q.setFromAxisAngle(_up, s.turretYaw ?? 0).multiply(_qp.setFromAxisAngle(_x, -(s.turretPitch ?? 0.15)));
    return out.compose(_pivot.set(s.position.x, s.position.y + ZPU_TRUNNION_Y - sink, s.position.z), _q, _one);
  };
  const _spot = [];
  /** A tunnel shows its bar only once found: one of yours near it, or it has been hit or picked. */
  const spotted = (s) => s.selected || s.hp < s.maxHp
    || (app.units?.near(s.position.x, s.position.z, 35, _spot) ?? []).some((u) => u.team === "player" && u.alive);

  const kindOfMesh = new Map(Object.values(kinds).map((k) => [k.im, k]));

  // ── Base views: animated hangar groups (player + optional enemy HQ) ─────────
  // The PLAYER'S HQ is a Quonset (v3/render/objects/rtsQuonset.js): the building
  // of the American war, at the game's 1.3x scale, with hinged doors that swing
  // open while it produces. It exposes the same userData the old hangar did —
  // beacon, lamps as `strips` — plus setDoor(t), which the sync below prefers.
  // The enemy's HQ keeps the old model until the other side gets its own.
  const quonset = buildQuonsetHQ({}, bloom);
  const baseView = quonset.group;
  baseView.userData = { beacon: quonset.beacon, strips: quonset.lamps, setDoor: quonset.setDoor };
  if (structures.base) {
    const bp = structures.base.position;
    baseView.position.set(bp.x, bp.y, bp.z);
    // Door faces the camera (−Z) from the player's starting view.
    baseView.rotation.y = Math.PI;
    scene.add(baseView);
  }

  // The ENEMY'S HQ: the French colonial résidence the Front has taken over
  // (v3/render/objects/rtsColonial.js), on the kit's atlas material, its
  // banner and star on the stencil sheet. Built with its front toward -Z.
  const enemyBaseView = new THREE.Group();
  {
    const geo = buildColonialHQ();
    const body = new THREE.Mesh(geo, kitMat);
    body.castShadow = body.receiveShadow = true;
    enemyBaseView.add(body);
    const st = stencilMesh(geo.userData.stencil);
    if (st) enemyBaseView.add(st);
  }
  enemyBaseView.visible = false;
  scene.add(enemyBaseView);

  let doorOpen = 0;
  let _t2 = 0;

  const roots = [];
  const refreshRoots = () => {
    roots.length = 0;
    for (const k of Object.values(kinds)) roots.push(k.im);
    roots.push(baseView);
    if (structures.enemyBase?.alive) roots.push(enemyBaseView);
  };

  const _m = new THREE.Matrix4();
  const _head = new THREE.Matrix4();
  const _muzzle = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _one = new THREE.Vector3(1, 1, 1);
  const _up = new THREE.Vector3(0, 1, 0);
  const _pivot = new THREE.Vector3();
  /** A gun's world matrix: on its post (pit or nest), yawed at its target. */
  const headMatrix = (s, out) => out.compose(
    _pivot.set(s.position.x, s.position.y + (s.isBuilding ? GUN_PIT_HEAD_Y : s.typeKey === "tower" ? WATCHTOWER_GUN_Y : NEST_HEAD_Y), s.position.z),
    _q.setFromAxisAngle(_up, s.turretYaw ?? 0), _one,
  );

  const push = (kind, matrix, s) => {
    if (kind.n >= MAX_PER_KIND) return;
    kind.im.setMatrixAt(kind.n, matrix);
    kind.at[kind.n] = s;
    kind.n++;
  };

  /** World-space muzzle point of a turret (where its tracer should start). */
  function muzzleOf(s) {
    if (s.typeKey === "zpu") return ZPU_MUZZLE.clone().applyMatrix4(zpuGunMatrix(s, _head));
    if (s.typeKey === "mortar") {
      return MORTAR_MUZZLE.clone()
        .applyAxisAngle(_up, s.turretYaw ?? 0)
        .add(_muzzle.set(s.position.x, s.position.y, s.position.z));
    }
    if (s.typeKey === "spiderHole") {
      return SPIDER_MUZZLE.clone()
        .applyAxisAngle(_up, s.turretYaw ?? 0)
        .add(_muzzle.set(s.position.x, s.position.y, s.position.z));
    }
    if (s.typeKey !== "turret" && s.typeKey !== "tower") {
      return _muzzle.set(s.position.x, s.position.y + 6, s.position.z).clone();
    }
    // The player's built turret is the M60 gun pit (buildingRenderer.js), the
    // enemy's the DShK nest.
    headMatrix(s, _head);
    return (s.isBuilding ? GUN_PIT_MUZZLE : NEST_MUZZLE).clone().applyMatrix4(_head);
  }

  /** Resolve a raycast hit to its structure (base view, merged body, or a kind). */
  function structureFromHit(hit) {
    for (let o = hit.object; o; o = o.parent) {
      if (o === baseView) return structures.base;
      if (o === enemyBaseView) return structures.enemyBase;
    }

    const kind = kindOfMesh.get(hit.object);
    if (kind) return kind.at[hit.instanceId] ?? null;

    return null;
  }

  function sync(dt, camera) {
    _t2 += dt;
    // The static bodies only change when a structure dies or the world reloads —
    // a cheap signature catches both without rebuilding every frame. Y MUST be
    // in the key: re-seating after a terrain swap often keeps x/z and only moves
    // y, and without it the merged bodies stayed floating at the old altitude.
    // The raycast targets change when the enemy HQ appears or something dies.
    // The set is a dozen meshes now that nothing is merged into a world-space
    // body, so rebuilding the list each frame is cheaper than the signature
    // that used to guard it.
    refreshRoots();

    for (const k of Object.values(kinds)) k.n = 0;

    // ── Player base view ───────────────────────────────────────────────────────
    const base = structures.base;
    if (base) {
      baseView.visible = base.alive;
      if (base.alive) {
        baseView.position.set(base.position.x, base.position.y, base.position.z);
        const producing = (base.queue?.length ?? 0) > 0 || (base.progress ?? 0) > 0;
        doorOpen += ((producing ? 1 : 0) - doorOpen) * Math.min(1, dt * 4);
        const ud = baseView.userData;
        ud.setDoor(doorOpen);
        // Work lamps: steady when idle, pulsing while a unit is being built.
        const s = producing ? 1.15 + 0.35 * Math.sin(_t2 * 6) : 0.85;
        for (const l of ud.strips.children) l.scale.setScalar(s);
      }
    }

    // ── Enemy HQ (match mode) ───────────────────────────────────────────────────
    const enemyBase = structures.enemyBase;
    const showEnemyHq = enemyBase?.alive
      && (!fogOfWar?.enabled || fogOfWar.canSeeEntity(enemyBase));
    enemyBaseView.visible = !!showEnemyHq;
    if (showEnemyHq) {
      enemyBaseView.position.set(enemyBase.position.x, enemyBase.position.y, enemyBase.position.z);
    }

    for (const s of structures.list) {
      if (!s.alive) continue;
      if (s.isBuilding) continue;
      // Not found yet: no mesh, no bar, no ring, nothing to raycast. The only
      // honest way to hide something is not to draw it (traps.js).
      if (s.hidden) continue;

      if (s.typeKey === "turret") {
        if (s.team === "enemy" && fogOfWar?.enabled && !fogOfWar.canSeeEntity(s)) continue;
        // Head tracks its target, and the eye rides in head space.
        if (s.target?.alive) {
          const dx = s.target.position.x - s.position.x;
          const dz = s.target.position.z - s.position.z;
          s.turretYaw = Math.atan2(dx, dz);
        }
        _m.makeTranslation(s.position.x, s.position.y, s.position.z);
        push(kinds.nest, _m, s);
        headMatrix(s, _head);
        push(kinds.head, _head, s);
      }

      if (s.typeKey === "tower") {
        if (s.team === "enemy" && fogOfWar?.enabled && !fogOfWar.canSeeEntity(s)) continue;
        if (s.target?.alive) {
          s.turretYaw = Math.atan2(s.target.position.x - s.position.x, s.target.position.z - s.position.z);
        }
        // The tower keeps the heading it was built with; the gun turns on top.
        _m.compose(_pivot.set(s.position.x, s.position.y, s.position.z), _q.setFromAxisAngle(_up, s.facing ?? 0), _one);
        push(kinds.tower, _m, s);
        headMatrix(s, _head);
        push(kinds.head, _head, s);
      }

      if (s.typeKey === "mortar") {
        if (s.team === "enemy" && fogOfWar?.enabled && !fogOfWar.canSeeEntity(s)) continue;
        _m.makeTranslation(s.position.x, s.position.y, s.position.z);
        push(kinds.mortarBody, _m, s);
        const sink = (1 - (s.deploy ?? 1)) * 0.9;
        _head.compose(_pivot.set(s.position.x, s.position.y - sink, s.position.z), _q.setFromAxisAngle(_up, s.turretYaw ?? 0), _one);
        push(kinds.mortarTube, _head, s);
      }

      if (s.typeKey === "zpu") {
        if (s.team === "enemy" && fogOfWar?.enabled && !fogOfWar.canSeeEntity(s)) continue;
        // Turn and elevate on the target: an aircraft is aimed at where it
        // flies, a man at his chest. Clamped to the mount's real arc.
        const t = s.target?.alive ? s.target : null;
        if (t) {
          const dx = t.position.x - s.position.x, dz = t.position.z - s.position.z;
          s.turretYaw = Math.atan2(dx, dz);
          const dy = t.position.y + (t.isAir ? 0 : 1) - (s.position.y + ZPU_TRUNNION_Y);
          s.turretPitch = Math.max(-0.08, Math.min(1.4, Math.atan2(dy, Math.hypot(dx, dz))));
        }
        _m.makeTranslation(s.position.x, s.position.y, s.position.z);
        push(kinds.zpuBody, _m, s);
        const sink = (1 - (s.deploy ?? 1)) * 1.2;
        _head.compose(_pivot.set(s.position.x, s.position.y + ZPU_MOUNT_Y - sink, s.position.z), _q.setFromAxisAngle(_up, s.turretYaw ?? 0), _one);
        push(kinds.zpuMount, _head, s);
        push(kinds.zpuGuns, zpuGunMatrix(s, _head), s);
      }

      if (s.typeKey === "tunnel") {
        if (fogOfWar?.enabled && !fogOfWar.canSeeEntity(s)) continue;
        _m.makeTranslation(s.position.x, s.position.y, s.position.z);
        push(kinds.tunnel, _m, s);
        if (!spotted(s)) continue;
      }

      // The range targets: the silhouette faces the firing point (-Z, where
      // the camp is), which is the way every piece of this kit is built.
      if (s.typeKey === "trainingDummy") {
        _m.makeTranslation(s.position.x, s.position.y, s.position.z);
        push(kinds.trainingDummy, _m, s);
      }

      // ── The cheap nasty kit, once found ──────────────────────────────────
      if (kinds[s.typeKey] && s.concealed) {
        if (fogOfWar?.enabled && !fogOfWar.canSeeEntity(s)) continue;
        _m.makeTranslation(s.position.x, s.position.y, s.position.z);
        push(kinds[s.typeKey], _m, s);
        // The man in the hole turns to whoever he is shooting at, rifle and all.
        if (s.typeKey === "spiderHole") {
          const t = s.target?.alive ? s.target : null;
          if (t) s.turretYaw = Math.atan2(t.position.x - s.position.x, t.position.z - s.position.z);
          _head.compose(_pivot.set(s.position.x, s.position.y, s.position.z), _q.setFromAxisAngle(_up, s.turretYaw ?? 0), _one);
          push(kinds.spiderMan, _head, s);
        }
        // A DANGER RING on ground you now know is mined. This is the whole
        // reward for finding one: the trap is still there, but from here on it
        // is a place on the map you can see and walk around.
        const danger = TRAP_RING[s.typeKey];
        if (danger) app.selectionRings?.add(s.position.x, s.position.z, (s.type.trap?.trigger ?? 3) + 0.6, danger);
      }

      if (s.typeKey === "enemyBase" && !showEnemyHq) continue;

      // Selected: brackets round a building with a declared footprint (the HQ's
      // pad), a ring round the rest (turrets). Enemy red.
      if (s.selected) {
        const tint = s.team === "enemy" ? 0xff6a5a : undefined;
        // The building's own outline if it declares one (the HQ: the barrel and
        // its blast walls, not the whole levelled pad), held to its floor.
        const pad = s.type.frame ?? s.type.pad;
        if (pad) app.selectionFrames?.add(s.position.x + (pad.dx ?? 0), s.position.z + (pad.dz ?? 0), pad.halfX, pad.halfZ, 0, tint, s.position.y + 0.8);
        else app.selectionRings?.add(s.position.x, s.position.z, (s.radius ?? 4) + 1.5, tint);
      }

      // Health bar — one instance in the shared field (see healthBar.js).
      healthBars.add(
        s.position.x, s.position.y + (s.type.barY ?? 10), s.position.z,
        s.type.barWidth ?? 6,
        s.hp / s.maxHp,
        s.team === "enemy",
        camera,
      );
    }

    for (const k of Object.values(kinds)) {
      k.im.count = k.n;
      k.im.instanceMatrix.needsUpdate = true;
    }
  }

  return {
    roots,             // raycast targets for selection
    structureByMesh,   // legacy; structures have no per-structure mesh any more
    structureFromHit,  // resolves a raycast hit to its structure
    muzzleOf,
    sync,
    dispose() {
      for (const k of Object.values(kinds)) scene.remove(k.im);
    },
  };
}
