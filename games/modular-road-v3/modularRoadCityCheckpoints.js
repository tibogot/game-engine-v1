// ============================================================================
// CITY CHECKPOINTS — a checkpoint rush through the streets.
//
// ── WHAT IT COSTS, WHICH IS THE POINT ────────────────────────────────────────
//
// ONE CHECKPOINT IS LIVE AT A TIME. That single decision is the whole cost
// model: there is never a set to draw, a set to test, or a set to keep sorted.
//
//   detection   ONE squared-distance compare per frame against ONE position.
//               No trigger volume, no physics body, no BVH, no collision — you
//               drive straight through it. This is less work than one of the
//               ~1900 collision queries the chassis already does every frame.
//   the ring    drawn by the CITY STREET SHADER from two uniforms, so it costs
//               no mesh, no draw call and no transform (see `markerOn` in
//               modularRoadCityStreets — a build-time gate, so with the
//               feature off the term is not even in the shader).
//   the beam    ONE thin emissive cylinder, and only ever one. A city has
//               100 m towers; a ring on the ground is invisible two blocks
//               away, and the beam is how you find the thing at all.
//   the HUD     two DOM nodes, written only when the text changes.
//
// ── AND IT COMES OUT CLEAN ───────────────────────────────────────────────────
//
// `enabled: false` is not "runs and does nothing": no beam is built, no HUD is
// created, `update` returns on its first line, and the street's ring term is
// compiled out by its own gate. Deleting the two call sites in roadGame.js and
// this file removes the feature entirely — nothing else knows it exists.
//
// ── WHY OPAQUE, EVERYWHERE ───────────────────────────────────────────────────
//
// The obvious marker is a big translucent cylinder. r184 blends only the
// `output` MRT attachment, so a transparent surface ERASES the emissive buffer
// behind it — a translucent column standing in a street would punch a hole in
// the bloom of every lit window behind it. Both halves of this marker are
// therefore opaque and emissive: the ring is part of the road, and the beam is
// a solid cylinder that writes emissive like a lamp does.
// ============================================================================
import * as THREE from "three";
import { Fn, float, vec3, vec4, uniform, positionGeometry, smoothstep, mix } from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";

export const CHECKPOINT_DEFAULTS = {
  enabled: true,
  /** How many to reach before the run is complete. */
  count: 12,
  /** Metres between consecutive checkpoints. A leg wants to be 10-20 seconds
   *  of driving: long enough to be a route, short enough to be a rush. */
  legMin: 190,
  legMax: 420,
  /** Reaching one counts inside this radius, measured on the ground plane.
   *  Generous on purpose — a rush is about the route, not about threading a
   *  gate, and a marker you can clip the edge of feels mean. */
  hitRadius: 7.0,
  /** Vertical tolerance, so a checkpoint cannot be collected from a flyover. */
  hitHeight: 6.0,

  /** Seconds on the clock at the start, and seconds added per checkpoint. */
  startTime: 30,
  bonusTime: 11,

  /** The beam: how tall, how wide, and how far away it stays drawn. */
  beamHeight: 46,
  beamRadius: 1.15,
  /** Beyond this the beam is hidden — it has already done its job, and a
   *  1 px column across the skyline is aliasing, not guidance. */
  beamRange: 900,
  color: 0x35ff9a,
  /** Emissive level of the beam, day and night. */
  beamDay: 1.5,
  beamNight: 2.6,
};

const _v = new THREE.Vector3();

/**
 * @param {object} o
 * @param {THREE.Object3D} o.scene       where the beam lives
 * @param {object} o.city                for streetSpawnNear and the street uniforms
 * @param {HTMLElement} [o.hudParent]    where the two HUD lines go
 * @param {object} [o.params]
 */
export function createCityCheckpoints({ scene, city, hudParent = null, params = {} }) {
  const P = { ...CHECKPOINT_DEFAULTS, ...params };
  if (!P.enabled || !scene || !city) return null;

  const col = new THREE.Color(P.color);
  const uNight = uniform(0);

  /*
   * THE BEAM. A cylinder with no caps, brightest at the ground and fading out
   * before its top — a hard-ended column reads as a prop, a fading one reads
   * as light. The fade is in geometry space so it costs nothing per instance,
   * and it is emissive rather than transparent for the reason at the top of
   * this file.
   */
  const beamGeo = new THREE.CylinderGeometry(P.beamRadius, P.beamRadius * 1.35, P.beamHeight, 10, 1, true);
  beamGeo.translate(0, P.beamHeight / 2, 0);
  const beamMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  beamMat.name = "CityCheckpointBeam";
  const beamGlow = Fn(() => {
    const t = positionGeometry.y.div(P.beamHeight);
    const fade = smoothstep(float(1.0), float(0.12), t);
    return vec3(col.r, col.g, col.b).mul(fade).mul(mix(float(P.beamDay), float(P.beamNight), uNight));
  })();
  beamMat.colorNode = beamGlow;
  applyBloomMRT(beamMat, vec4(beamGlow, 1.0));
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.name = "CityCheckpointBeam";
  beam.frustumCulled = false;      // one object; a cull test costs more than it saves
  beam.visible = false;
  beam.castShadow = false;
  beam.receiveShadow = false;
  scene.add(beam);

  // ── HUD: two lines, written only when the text actually changes ───────────
  let hud = null, hudTime = null, hudInfo = null, hudSay = null;
  let lastTimeText = "", lastInfoText = "", sayTimer = 0;
  if (hudParent && typeof document !== "undefined") {
    hud = document.createElement("div");
    hud.className = "road-cp-hud";
    hudTime = document.createElement("div");
    hudTime.className = "road-cp-time";
    hudInfo = document.createElement("div");
    hudInfo.className = "road-cp-info";
    hud.appendChild(hudTime);
    hud.appendChild(hudInfo);
    hud.style.display = "none";
    hudParent.appendChild(hud);
    /*
     * ITS OWN MESSAGE LINE, not the race HUD's `#race-flash`. That element is
     * rewritten every frame by the lap system, so anything posted to it from
     * here would be cleared before it painted.
     */
    hudSay = document.createElement("div");
    hudSay.className = "road-cp-say";
    hudParent.appendChild(hudSay);
  }
  /** A short message of this system's own. Cleared by the update tick. */
  function say(text, seconds = 2.6) {
    if (!hudSay) return;
    hudSay.textContent = text;
    hudSay.className = "road-cp-say show";
    sayTimer = seconds;
  }

  const route = [];
  const state = { running: false, index: 0, time: 0, reached: 0, best: 0, dist: 0 };

  /**
   * Build a route of on-road points.
   *
   * `streetSpawnNear` snaps to the centre of the nearest street, so every
   * point is guaranteed to be ON the carriageway rather than inside a tower —
   * which is the whole reason this reuses it instead of sampling the plane.
   * The walk turns by a random angle each leg, so the route wanders the grid
   * instead of running off in one direction and leaving the city.
   */
  function buildRoute(fromX, fromZ) {
    route.length = 0;
    let x = fromX, z = fromZ;
    let heading = Math.random() * Math.PI * 2;
    const extent = city.params?.extent ?? 1200;
    for (let i = 0; i < P.count; i++) {
      let placed = null;
      // A few tries, then take what we get: a leg that would leave the city is
      // turned back rather than clamped, or the route piles up on the edge.
      for (let attempt = 0; attempt < 8; attempt++) {
        const leg = P.legMin + Math.random() * (P.legMax - P.legMin);
        const a = heading + (Math.random() - 0.5) * 2.4;
        const nx = x + Math.cos(a) * leg, nz = z + Math.sin(a) * leg;
        if (Math.abs(nx) > extent * 0.82 || Math.abs(nz) > extent * 0.82) {
          heading += Math.PI * (0.6 + Math.random() * 0.8);
          continue;
        }
        const st = city.streetSpawnNear(nx, nz);
        placed = { x: st.x, z: st.z };
        heading = a;
        break;
      }
      if (!placed) {
        const st = city.streetSpawnNear(x, z);
        placed = { x: st.x, z: st.z };
      }
      route.push(placed);
      x = placed.x; z = placed.z;
    }
    return route.length;
  }

  /** Push the live target into the street shader and move the beam. */
  function showTarget() {
    const t = route[state.index];
    if (!t) {
      city.setCheckpointMarker?.(0, 0, 0);
      beam.visible = false;
      return;
    }
    city.setCheckpointMarker?.(t.x, t.z, 1);
    beam.position.set(t.x, city.params?.groundY ?? 0, t.z);
  }

  function start(fromX = 0, fromZ = 0) {
    buildRoute(fromX, fromZ);
    state.running = true;
    state.index = 0;
    state.reached = 0;
    state.time = P.startTime;
    showTarget();
    if (hud) hud.style.display = "";
    return route.length;
  }

  function stop() {
    state.running = false;
    beam.visible = false;
    city.setCheckpointMarker?.(0, 0, 0);
    if (hud) hud.style.display = "none";
  }

  /**
   * Every frame. `carPos` is read, never written.
   *
   * The entire per-frame cost of the feature is below: one subtract, one dot,
   * two compares, and a DOM write that only happens when the text changes.
   */
  function update(dt, carPos, night = 0) {
    if (sayTimer > 0) {
      sayTimer -= dt;
      if (sayTimer <= 0 && hudSay) hudSay.className = "road-cp-say";
    }
    if (!state.running || !carPos) return null;
    uNight.value = night;

    state.time -= dt;
    if (state.time <= 0) {
      state.time = 0;
      stop();
      return { kind: "timeout", reached: state.reached };
    }

    const t = route[state.index];
    let event = null;
    if (t) {
      const dx = carPos.x - t.x, dz = carPos.z - t.z;
      const d2 = dx * dx + dz * dz;
      state.dist = Math.sqrt(d2);
      const dy = Math.abs(carPos.y - (city.params?.groundY ?? 0));
      if (d2 <= P.hitRadius * P.hitRadius && dy <= P.hitHeight) {
        state.reached++;
        state.index++;
        state.time += P.bonusTime;
        if (state.index >= route.length) {
          const finished = state.reached;
          stop();
          return { kind: "finish", reached: finished, time: state.time };
        }
        showTarget();
        event = { kind: "checkpoint", reached: state.reached, remaining: route.length - state.index };
      }
      // The beam earns its keep at distance and is noise up close, where the
      // ring on the road has already taken over.
      beam.visible = state.dist < P.beamRange && state.dist > P.hitRadius * 0.8;
    }

    if (hudTime) {
      const txt = state.time.toFixed(1);
      if (txt !== lastTimeText) { hudTime.textContent = txt; lastTimeText = txt; }
      const info = `${state.reached}/${route.length}  ·  ${Math.round(state.dist)} m`;
      if (info !== lastInfoText) { hudInfo.textContent = info; lastInfoText = info; }
    }
    return event;
  }

  return {
    params: P,
    start,
    stop,
    update,
    say,
    get running() { return state.running; },
    get state() { return state; },
    /** The route, for a test or a minimap. */
    get route() { return route; },
    dispose() {
      stop();
      scene.remove(beam);
      beamGeo.dispose();
      beamMat.dispose();
      hud?.remove();
      hudSay?.remove();
    },
  };
}
