// ── Horse lab: the RIDING KIT — the horse, the rider and how you play them, for a GAME page ─────────
// (user, 2026-10-21: the horse on real terrain, in a game built like the others — the engine's
// startV3App + an editor level.) What the lab page does for play, without its editors / tools:
//   the armoured horse, the rider (the robot, or Y Bot with ?rider=ybot), the saddle, the headgear,
//   the riding postures and get-on / get-off, the bow (V) and the lance (L), the camera-relative
//   controls (the mouse is the camera; W A S D relative to it; aiming holds the horse's line) and the
//   third-person camera. The page owns the renderer, the scene, the camera and the loop: call
//   kit.update(dt) once a frame before the camera is used (the engine: app.addPreUpdateHook).
//
// world: { ground: Mesh[], blockers: Mesh[], heightAt?(x, z), normalAt?(x, z) } — a terrain level
// gives heightAt / normalAt (the engine's getWorldHeight / getWorldNormal); meshes may sit on it.
//
// The lab page (horse-lab.html) still has its own copy of this glue — it moves onto the kit next.
import * as THREE from "three";
import { loadHorse, HorseController, GEARS } from "./horse.js";
import { loadRider, RiderController, RP, applyRidingData, seatDepth } from "./rider.js";
import { loadYBot } from "./ybot.js";
import { Tack } from "./tack.js";
import { addHat } from "./hat.js";
import { addHelmet } from "./helmet.js";
import { mergeSkinned, mergeRigid } from "./optimize.js";
import { Archer, BP } from "./bow.js";
import { bakedFromJSON } from "./retarget.js";
import { createLanceSight } from "./lanceContact.js";

const V3 = THREE.Vector3;
const lerpK = (rate, dt) => 1 - Math.exp(-rate * dt);
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const json = async (url) => { const r = await fetch(url + "?" + Date.now()); return r.ok && (r.headers.get("content-type") ?? "").includes("json") ? r.json() : null; };

/**
 * @param o.scene, o.renderer, o.camera   the page's
 * @param o.controls   the engine's orbit controls, if any: they look at the kit's camera target
 *                     (the engine updates them after the game's hook — the truck's way)
 * @param o.world   the level contract (above)
 * @param o.spawn   { x, z, yaw }
 * @param o.riderKind   "robot" | "ybot"
 * @param o.onStatus   (text) => void
 */
export async function createRidingKit({ scene, renderer, camera, controls = null, world, spawn = { x: 0, z: 0, yaw: 0 }, riderKind = "robot", onStatus = () => {} }) {
  const canvas = renderer.domElement;

  // ── the horse: the armoured model on the Quaternius skeleton ─────────────
  onStatus("loading the horse…");
  const { initGlbLoaderRenderer, getSharedGltfLoader } = await import("../render/foliage/glbLoader.js");
  initGlbLoaderRenderer(renderer);                         // (its textures are KTX2)
  const armorScene = (await getSharedGltfLoader().loadAsync("/models/armored_horse_compressed.glb")).scene;
  const horse = await loadHorse("/models/Horse by Quaternius -_compressed.glb", { height: 2.02, body: armorScene });
  scene.add(horse.rig);
  const { trimArmorPieces } = await import("./horseBody.js");
  trimArmorPieces(horse);
  const ctrl = new HorseController(horse, world);

  // ── the rider ─────────────────────────────────────────────────────────────
  onStatus("loading the rider…");
  const robotData = await loadRider("/models/UA1+UA2_compressed.glb", { height: 1.78 });
  let riderData = robotData;
  if (riderKind === "ybot") {
    for (const f of ["Y Bot.fbx", "Shooting Arrow.fbx"]) {
      try { riderData = await loadYBot(`/v3/horse-lab/refs/${encodeURIComponent(f)}`, robotData, { height: 1.78 }); break; }
      catch (e) { console.warn("[ridingKit] Y Bot from", f, "failed:", e.message); }
    }
  }
  riderData.kind ??= "robot";
  mergeSkinned(riderData.model ?? riderData.rig);
  scene.add(riderData.rig);
  const rider = new RiderController(riderData, ctrl, scene);
  if (riderData !== robotData) { const sit = (d) => d.clips.Sitting_Idle_Loop_Armature; rider.seatAdj = seatDepth(riderData, sit(riderData)) - seatDepth(robotData, sit(robotData)); }
  addHat(rider); addHelmet(rider);
  const tack = new Tack(horse, rider);
  tack.setVisible(false);                                   // (the armoured model has its own saddle; ours gives the seat)
  mergeRigid(tack.group, { roughness: 0.8, flatShading: true, side: THREE.DoubleSide });
  if (rider.hat) mergeRigid(rider.hat, { roughness: 0.85 });
  const setHeadgear = (v) => { if (rider.hat) rider.hat.visible = v === "hat"; if (rider.helmet) rider.helmet.visible = v === "helmet"; };
  setHeadgear("hat");
  await rider.mountSys.loadAnims();
  try {
    const own = await json(`/v3/horse-lab/anims/${riderData.kind === "ybot" ? "riding-ybot" : "riding"}.json`);
    const data = own ?? await json("/v3/horse-lab/anims/riding.json");
    if (data) applyRidingData(data, rider.stirrups.STRAP);
    if (riderData.kind === "ybot" && !own) rider.stirrups.STRAP.len *= 0.52 / 0.56;
  } catch { /* the built-in postures */ }

  // ── the bow and the lance ────────────────────────────────────────────────
  const archer = new Archer({ rider, scene, world, range: null });
  try {
    archer.anim = await json("/v3/horse-lab/anims/bow-fetch.json") ?? archer.anim;
    const shot = await json(`/v3/horse-lab/anims/bow-shot-mocap${riderData.kind === "ybot" ? "-ybot" : ""}.json`);
    if (shot) { archer.base = bakedFromJSON(shot, rider.r.model); archer.calibrateBase(); }
    const walk = await json(`/v3/horse-lab/anims/bow-aimwalk${riderData.kind === "ybot" ? "-ybot" : ""}.json`);
    if (walk) archer.aimWalk = Object.fromEntries(Object.entries(walk.clips).map(([n, c]) => [n, Object.assign(bakedFromJSON(c, rider.r.model), { speed: c.speed, arrowYaw: c.arrowYaw })]));
  } catch { /* keyed arms only */ }
  const lanceSight = createLanceSight(scene);
  const LA = { off: [0, 0], lock: false, mode: false };
  const lookRay = new THREE.Ray();
  // the lance follows the look (Mount & Blade), lock-on (right mouse) and the assist — as the lab
  const lanceAimUpdate = () => {
    const lt = RP.lanceLen - RP.lanceBack, cone = [RP.lanceAimYaw, RP.lanceAimPitch];
    const tgt = lanceSight.best, need = tgt ? rider.lanceOffFor(tgt.p) : null;
    {
      const f = new V3(Math.sin(ctrl.yaw), 0, Math.cos(ctrl.yaw));
      camera.getWorldPosition(lookRay.origin); camera.getWorldDirection(lookRay.direction);
      const P0 = tgt ? tgt.p : new V3(ctrl.pos.x, ctrl.y, ctrl.pos.z).addScaledVector(f, 12), dn = lookRay.direction.dot(f);
      if (dn > 0.2) { const t = P0.clone().sub(lookRay.origin).dot(f) / dn; if (t > 0) LA.off = rider.lanceOffFor(lookRay.at(t, new V3())); }
    }
    LA.off = LA.off.map((x, i) => THREE.MathUtils.clamp(x, -cone[i], cone[i]));
    let want = LA.off;
    if (LA.lock && need) want = need;
    else if (RP.lanceAssist && need) {
      const d = Math.hypot(need[0] - LA.off[0], need[1] - LA.off[1]) * lt, w = THREE.MathUtils.smoothstep(1 - d / 0.4, 0, 1) * 0.85;
      want = LA.off.map((x, i) => x + (need[i] - x) * w);
    }
    lanceSight.locked = LA.lock && !!need;
    rider.lanceAimOff = want;
  };
  const aims = [];                                          // (lance targets: a game adds { p, test } / { p, obj })

  // ── place the horse (and the rider in the saddle) ───────────────────────
  const groundY = (x, z) => world.heightAt?.(x, z) ?? 0;
  function placeAt({ x, z, yaw }) {
    ctrl.teleport(x, z, yaw, groundY(x, z));
    camYaw = yaw;
  }

  // ── input ─────────────────────────────────────────────────────────────────
  const down = new Set();
  let shiftDownAt = -1, gearUp = false, gearDown = false, note = "", noteT = 0;
  const btn = { aim: false, fire: false };
  addEventListener("keydown", (e) => {
    if (e.target?.closest?.("input, textarea, select")) return;
    down.add(e.code);
    if (e.key === "Shift" && shiftDownAt < 0) shiftDownAt = performance.now();
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === "x") gearDown = true;
    if (e.code === "Space") ctrl.queueJump();
    if (k === "f") {
      const res = rider.mountSys.toggle();
      const msg = { moving: "stop the horse first", blocked: "no room to get off on either side", far: "get closer to the horse" }[res];
      if (msg) { note = msg; noteT = 2.5; }
    }
    if (k === "r") ctrl.startRear();
    if (k === "l") { RP.lance = true; RP.lanceDown = !RP.lanceDown; }
    if (k === "v") BP.on = !BP.on;
    // FREE CAMERA (C): the mouse only orbits — the riding direction is held where it was, so the horse
    // goes on its line while you look at it from any side (checking the legs)
    if (k === "c") { DBG.free = !DBG.free; DBG.rideYaw = camYaw; note = DBG.free ? "free camera: the mouse orbits, the horse keeps its line (C: back)" : "camera steers again"; noteT = 2.5; }
    if (k === ",") { DBG.slow = DBG.slow === 1 ? 0.25 : 1; note = DBG.slow < 1 ? "slow motion ×0.25 (, : normal)" : "normal speed"; noteT = 2; }
    if (k === "p") { DBG.paused = !DBG.paused; note = DBG.paused ? "paused (P)" : ""; noteT = DBG.paused ? 1e9 : 0; }
  });
  addEventListener("keyup", (e) => {
    down.delete(e.code);
    if (e.key === "Shift") { if (shiftDownAt >= 0 && performance.now() - shiftDownAt < 250) gearUp = true; shiftDownAt = -1; }
  });
  addEventListener("blur", () => { down.clear(); shiftDownAt = -1; btn.aim = btn.fire = false; LA.lock = false; });
  canvas.addEventListener("mousedown", (e) => { if (e.button === 2 && LA.mode) LA.lock = true; if (!archer.active) return; if (e.button === 2) btn.aim = true; if (e.button === 0) btn.fire = true; });
  addEventListener("mouseup", (e) => { if (e.button === 2) { btn.aim = false; LA.lock = false; } if (e.button === 0) btn.fire = false; });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  const input = () => {
    const i = {
      fwd: (down.has("KeyW") || down.has("ArrowUp") ? 1 : 0) - (down.has("KeyS") || down.has("ArrowDown") ? 1 : 0),
      turn: (down.has("KeyA") || down.has("ArrowLeft") ? 1 : 0) - (down.has("KeyD") || down.has("ArrowRight") ? 1 : 0),
      run: shiftDownAt >= 0 && performance.now() - shiftDownAt >= 250, gearUp, gearDown,
    };
    gearUp = gearDown = false;
    return i;
  };
  // camera-relative riding (the lab's RIDE): W A S D relative to the camera; aiming holds the line
  const RIDE = { mode: "camera" };
  const DBG = { free: false, rideYaw: 0, slow: 1, paused: false };
  const steerInput = (i) => {
    if (RIDE.mode !== "camera" || (archer.active && archer.aiming) || LA.mode) return i;
    const x = i.turn, z = i.fwd;
    if (!x && !z) return { ...i, fwd: 0, turn: 0 };
    const diff = angDiff((DBG.free ? DBG.rideYaw : camYaw) + Math.atan2(x, z), ctrl.yaw);   // (free camera: relative to the held riding direction)
    const spinFirst = Math.abs(diff) > 1.75 && Math.abs(ctrl.v) < 0.6;
    return { ...i, fwd: spinFirst ? 0 : 1, turn: THREE.MathUtils.clamp(diff / 0.45, -1, 1) };
  };

  // ── the camera: third person, the mouse orbits (pointer lock on click) ───
  let camYaw = spawn.yaw, camPitch = 0.28, camDist = 7.5, lastMouse = -1e9, lanceCamW = 0;
  const camTarget = new V3();
  canvas.addEventListener("click", () => canvas.requestPointerLock?.());
  addEventListener("mousemove", (e) => {
    const locked = document.pointerLockElement === canvas;
    if (!locked && !(e.buttons & 1)) return;
    if (!locked && e.target !== canvas) return;
    camYaw -= e.movementX * 0.0028;
    camPitch = THREE.MathUtils.clamp(camPitch + e.movementY * 0.0022, archer.aiming ? -0.6 : DBG.free ? -0.45 : -0.1, DBG.free ? 1.5 : 1.25);   // (free: from below the belly to straight down)
    lastMouse = performance.now();
  });
  canvas.addEventListener("wheel", (e) => { camDist = THREE.MathUtils.clamp(camDist * (e.deltaY > 0 ? 1.1 : 0.9), 3, 30); }, { passive: true });
  function updateCamera(dt) {
    // (debug / tools: a fixed view — DBG.view = { pos: [x, y, z], target: [x, y, z] } relative to the horse's
    // heading frame round its hooves: x left, y up, z forward)
    if (DBG.view) {
      const f = new V3(Math.sin(ctrl.yaw), 0, Math.cos(ctrl.yaw)), l = new V3(f.z, 0, -f.x), o = new V3(ctrl.pos.x, ctrl.y, ctrl.pos.z);
      const at = ([x, y, z]) => o.clone().addScaledVector(l, x).add(new V3(0, y, 0)).addScaledVector(f, z);
      camera.position.copy(at(DBG.view.pos)); const t = at(DBG.view.target); camera.lookAt(t); camera.updateMatrixWorld(); controls?.target.copy(t);
      return;
    }
    const foot = rider.mode === "ground" || rider.mode === "approach", M = rider.mountSys;
    const tgt = foot ? { x: M.gpos.x, y: rider.r.rig.position.y - 0.4, z: M.gpos.z, yaw: M.gyaw, v: M.gv } : { x: ctrl.pos.x, y: ctrl.y + ctrl.lift * 0.6, z: ctrl.pos.z, yaw: ctrl.yaw, v: ctrl.v };
    if (!DBG.free && Math.abs(tgt.v) > 0.3 && performance.now() - lastMouse > 1500 && !(RIDE.mode === "camera" && !foot && ["KeyA", "KeyD", "KeyS", "ArrowLeft", "ArrowRight", "ArrowDown"].some((c) => down.has(c)))) camYaw += angDiff(tgt.yaw, camYaw) * lerpK(1.6, dt);
    const want = new V3(tgt.x, tgt.y + 1.8, tgt.z);
    const aw = archer.active ? archer.aimW * archer.aimW * (3 - 2 * archer.aimW) : 0;
    if (aw > 0) { const hp = rider.B.head.getWorldPosition(new V3()); want.lerp(hp.add(new V3(-Math.cos(camYaw), 0, Math.sin(camYaw)).multiplyScalar(0.62)).add(new V3(0, 0.12, 0)), aw); }
    lanceCamW += ((LA.mode ? 1 : 0) - lanceCamW) * lerpK(4, dt);
    if (lanceCamW > 0.001) want.add(new V3(Math.cos(camYaw), 0, -Math.sin(camYaw)).multiplyScalar(1.1 * lanceCamW)).add(new V3(0, -0.35 * lanceCamW, 0));
    if (camTarget.lengthSq() === 0) camTarget.copy(want);
    camTarget.lerp(want, lerpK(aw > 0 ? 18 : 10, dt));
    const dist = (camDist + (2.3 - camDist) * aw) * (1 - 0.3 * lanceCamW), cp = Math.cos(camPitch), sp = Math.sin(camPitch);
    camera.position.set(camTarget.x - Math.sin(camYaw) * cp * dist, camTarget.y + sp * dist, camTarget.z - Math.cos(camYaw) * cp * dist);
    camera.position.y = Math.max(camera.position.y, groundY(camera.position.x, camera.position.z) + 0.4);   // (never under the ground)
    camera.lookAt(camTarget);
    camera.updateMatrixWorld();
    controls?.target.copy(camTarget);
  }

  // the crosshair (bow aim, lance)
  const cross = document.createElement("div");
  cross.style.cssText = "position:fixed;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;z-index:15;pointer-events:none;display:none;background:radial-gradient(circle,#fff 0 1.5px,transparent 2px),linear-gradient(#fff,#fff) 50% 0/1.5px 6px no-repeat,linear-gradient(#fff,#fff) 50% 100%/1.5px 6px no-repeat,linear-gradient(#fff,#fff) 0 50%/6px 1.5px no-repeat,linear-gradient(#fff,#fff) 100% 50%/6px 1.5px no-repeat;filter:drop-shadow(0 0 1px #000)";
  document.body.appendChild(cross);

  // start in the saddle at the spawn
  placeAt(spawn);
  {
    const ms = rider.mountSys;
    ms.edit = null; ms.mode = "riding"; ms.blend = null; rider.seatY = null; rider.sitAction.reset().play(); ms.cur?.stop(); ms.cur = null;
  }

  // ── one frame ─────────────────────────────────────────────────────────────
  function update(dt) {
    const rawDt = Math.min(Math.max(0, dt), 0.1);
    dt = DBG.paused ? 0 : rawDt * DBG.slow;
    const inp = input(), onHorse = rider.mode === "riding";
    ctrl.update(dt, onHorse ? steerInput(inp) : { fwd: 0, turn: 0, run: false });
    const couched = onHorse && RP.lance && !RP.banner && !BP.on && (rider.lanceA ?? 0) > 0.5;
    LA.mode = couched && RP.lanceAim;
    if (LA.mode) lanceAimUpdate(); else { rider.lanceAimOff = null; if (!couched) LA.off = [0, 0]; }
    rider.update(dt, { lookYaw: camYaw, input: onHorse ? {} : { ...inp, hold: archer.active && archer.aiming, aimYaw: archer.aimYawLast } });
    lanceSight.update(couched ? rider.lance : null, ctrl.yaw, couched ? aims : [], camera);
    archer.update(dt, { camera, aim: btn.aim || down.has("KeyG"), fire: btn.fire || down.has("KeyT") });
    cross.style.display = (archer.active && archer.aimW > 0.6) || LA.mode ? "block" : "none";
    cross.style.opacity = archer.outOfArc ? 0.3 : 1;
    updateCamera(rawDt);                                     // (the camera at real speed: orbit a paused / slowed horse)
    noteT -= rawDt;
  }

  const status = () => ({
    gear: GEARS[ctrl.effGear ?? 0], gait: ctrl.rearT >= 0 ? "Rear" : ctrl.oneShot ? ctrl.oneShotName : ctrl.gaitName,
    speed: ctrl.v, pitchDeg: THREE.MathUtils.radToDeg(-ctrl.pitch), rollDeg: THREE.MathUtils.radToDeg(ctrl.roll),
    rider: rider.mode, note: noteT > 0 ? note : "",
  });

  return {
    horse, ctrl, rider, tack, archer, lanceSight, LA, RIDE, RP, BP, DBG, aims, update, placeAt, setHeadgear, status,
    setCam: (yaw, pitch) => { camYaw = yaw; camPitch = pitch; lastMouse = performance.now() + 1e9; },
    setZoom: (d) => (camDist = d),
    get camYaw() { return camYaw; },
  };
}
