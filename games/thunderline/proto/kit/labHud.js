// THE PHYSICS LAB's OVERLAY (PHYSICS_LAB.md): while driving in the lab — TELEMETRY (what the car does, measured every
// frame), the TUNING sliders (the arcade car's numbers and the stunt helpers, live: the car changes as you drag), and
// the ZONE keys (1–7: the car put at a test area, standing, facing it).
import * as THREE from "three";
import { ARCADE } from "./arcadeCar.js";
import { STUNT } from "./stuntCar.js";
import { LAB_ZONES, zoneSpawn } from "./physicsLab.js";

const TUNE_KEY = "thunderline.lab.tune";
// [object, path, label, min, max, step]
const SLIDERS = [
  ["Steering", [
    [ARCADE, "steer.low", "turn rate, slow (rad/s)", 0.5, 4, 0.05],
    [ARCADE, "steer.high", "turn rate, top speed (rad/s)", 0.2, 2.5, 0.05],
    [ARCADE, "steer.response", "steering response (/s)", 2, 25, 0.5],
    [ARCADE, "steer.handbrakeBoost", "handbrake turn ×", 1, 3, 0.05],
  ]],
  ["Grip & drift", [
    [ARCADE, "grip.g", "side grip (g)", 0.5, 5, 0.05],
    [ARCADE, "grip.peakDeg", "grip peaks at (° slide)", 2, 20, 0.5],
    [ARCADE, "grip.slide", "grip once sliding (×)", 0.2, 1, 0.05],
    [ARCADE, "grip.handbrake", "handbrake grip (×)", 0.05, 1, 0.05],
    [ARCADE, "grip.aero", "downforce adds grip (×, 0 off)", 0, 2, 0.05],
  ]],
  ["Engine", [
    [ARCADE, "drive.accel", "acceleration (m/s²)", 3, 25, 0.5],
    [ARCADE, "drive.brake", "brakes (m/s²)", 5, 40, 1],
    [ARCADE, "drive.top", "engine top speed (m/s; 100 = 360 km/h, drag tops it ~315)", 40, 120, 1],
  ]],
  ["Road", [
    [ARCADE, "align.rate", "stays flat on the road (/s)", 2, 30, 0.5],
    [ARCADE, "road.coyote", "on the road after a wheel lifts (s)", 0, 0.6, 0.01],
    [ARCADE, "wall.from", "walls & loops: holds from tilt (up.y)", 0.3, 0.95, 0.01],
    [ARCADE, "guide.rate", "walls & loops: follows the road (/s, 0 off)", 0, 12, 0.25],
    [ARCADE, "stick.k", "downforce (×v²)", 0, 0.008, 0.0002],
    [ARCADE, "ride.k", "spring (N/m)", 10000, 80000, 1000],
    [ARCADE, "ride.c", "damper, compressing (N·s/m)", 500, 12000, 100],
    [ARCADE, "ride.rebound", "damper, extending (N·s/m)", 1000, 40000, 500],
  ]],
  ["Air", [
    [ARCADE, "air.roll", "roll rate (rad/s)", 1, 8, 0.1],
    [ARCADE, "air.pitch", "pitch rate (rad/s)", 1, 8, 0.1],
    [ARCADE, "air.yaw", "yaw rate (rad/s)", 1, 8, 0.1],
    [ARCADE, "air.hold", "holds its attitude (/s)", 0, 12, 0.25],
    [ARCADE, "air.follow", "nose follows the flight, pitch only (/s, 0 off)", 0, 6, 0.1],
  ]],
  ["Helpers (stunt + arcade)", [
    [STUNT, "takeoff.maxDeg", "take-off guide (° max)", 0, 20, 0.5],
    [STUNT, "catch.maxDeg", "landing catch (° max)", 0, 60, 1],
    [STUNT, "catch.settle", "landing settle (s)", 0.05, 0.6, 0.01],
  ]],
];
const get = (o, path) => path.split(".").reduce((a, k) => a[k], o);
const set = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };
const DEFAULTS = SLIDERS.flatMap(([, rows]) => rows.map(([o, p]) => [o, p, get(o, p)]));
const keyOf = (o, p) => `${o === ARCADE ? "ARCADE" : "STUNT"}.${p}`;

// ONLY WHAT YOU MOVED is kept (format v2): a whole snapshot pinned every slider, so a new default in code never
// reached a lab that had been tuned once. The first format's air.follow is dropped (its default changed, 10-29).
function applySaved() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(TUNE_KEY)) ?? {}; } catch {}
  if (saved.v === 2) saved = saved.values ?? {};
  else delete saved["ARCADE.air.follow"];
  for (const [, rows] of SLIDERS) for (const [o, p] of rows) if (keyOf(o, p) in saved) set(o, p, saved[keyOf(o, p)]);
}
function save() {
  const out = {};
  for (const [o, p, d] of DEFAULTS) if (get(o, p) !== d) out[keyOf(o, p)] = get(o, p);
  try { localStorage.setItem(TUNE_KEY, JSON.stringify({ v: 2, values: out })); } catch {}
  return out;
}

/**
 * @param o.getVehicle () => the car while driving, else null
 * @param o.isDriving () => boolean
 */
export function createLabHud({ getVehicle, isDriving }) {
  applySaved(); // (the lab's own tune: remembered between visits — the game's defaults stay in code)
  const css = "font:500 12px Barlow, sans-serif;color:#e6edf6;background:rgba(13,20,36,.88);border:1px solid #233149;padding:8px 10px;";
  const tele = document.createElement("div");
  tele.style.cssText = `position:fixed;left:16px;top:96px;z-index:30;min-width:230px;${css}display:none;pointer-events:none;white-space:pre;font-family:Consolas, monospace;font-size:12px;line-height:1.45`;
  const panel = document.createElement("div");
  panel.style.cssText = `position:fixed;right:16px;top:96px;z-index:30;width:300px;max-height:calc(100vh - 230px);overflow:auto;${css}display:none`;
  document.body.append(tele, panel);

  // ---- the tuning panel
  const rowsHtml = SLIDERS.map(([title, rows]) => `<div style="font:700 13px 'Barlow Condensed';letter-spacing:.06em;text-transform:uppercase;color:#3fd2ff;margin:8px 0 4px">${title}</div>` +
    rows.map(([o, p, label, min, max, step]) => `<label style="display:grid;grid-template-columns:1fr 54px;gap:2px 6px;margin:3px 0"><span>${label}</span><b data-v="${keyOf(o, p)}" style="text-align:right;font-weight:600"></b>
      <input type="range" data-k="${keyOf(o, p)}" min="${min}" max="${max}" step="${step}" style="grid-column:1 / 3;width:100%"></label>`).join("")).join("");
  panel.innerHTML = `<div style="font:700 16px 'Barlow Condensed';letter-spacing:.06em;text-transform:uppercase">Tuning <small style="opacity:.6;font:500 11px Barlow">— live, the arcade car</small></div>
    <div data-note style="opacity:.75;margin:4px 0"></div>${rowsHtml}
    <div style="display:flex;gap:6px;margin-top:10px"><button data-a="copy">Copy values</button><button data-a="reset">Reset</button></div>
    <div style="opacity:.6;margin-top:6px">Keys while driving: ${LAB_ZONES.map((z) => `<b>${z.key}</b> ${z.label.split(" (")[0]}`).join(" · ")}</div>`;
  const all = SLIDERS.flatMap(([, rows]) => rows);
  const sync = () => {
    for (const [o, p, , , , step] of all) {
      const v = get(o, p), k = keyOf(o, p);
      panel.querySelector(`input[data-k="${k}"]`).value = v;
      panel.querySelector(`b[data-v="${k}"]`).textContent = step < 0.01 ? v.toFixed(4) : step < 1 ? (+v).toFixed(2) : Math.round(v);
    }
  };
  sync();
  panel.addEventListener("input", (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    const row = all.find(([o, p]) => keyOf(o, p) === k);
    set(row[0], row[1], Number(e.target.value));
    save();
    sync();
  });
  panel.addEventListener("click", async (e) => {
    const a = e.target.dataset.a;
    if (a === "copy") { const txt = JSON.stringify(save(), null, 1); try { await navigator.clipboard.writeText(txt); e.target.textContent = "Copied"; } catch { prompt("The values:", txt); } setTimeout(() => (e.target.textContent = "Copy values"), 1200); }
    if (a === "reset") { for (const [o, p, v] of DEFAULTS) set(o, p, v); try { localStorage.removeItem(TUNE_KEY); } catch {} sync(); }
  });
  // (keys typed in the panel are not the car's)
  panel.addEventListener("keydown", (e) => e.stopPropagation());

  // ---- the zone keys
  addEventListener("keydown", (e) => {
    if (!isDriving() || e.repeat || e.ctrlKey || e.altKey) return;
    // (by the key's PLACE — the top row or the keypad: on an AZERTY keyboard the unshifted top row types & é " …)
    const sp = zoneSpawn(/^(?:Digit|Numpad)(\d)$/.exec(e.code)?.[1] ?? e.key);
    const v = getVehicle();
    if (!sp || !v) return;
    e.preventDefault(); e.stopImmediatePropagation();
    v.respawnAt(new THREE.Vector3(sp.x, sp.y, sp.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)); // (the chassis' front is +Z: facing −Z)
    v.body.vel.set(0, 0, 0); v.body.angVel.set(0, 0, 0);
    last.landing = null;
  }, true);

  // ---- the telemetry, every frame
  const last = { air: 0, airMax: 0, landing: null, vBefore: 0, pending: null };
  const up = new THREE.Vector3(), fwd = new THREE.Vector3(), left = new THREE.Vector3(), n = new THREE.Vector3();
  let t0 = performance.now();
  function frame() {
    requestAnimationFrame(frame);
    const v = isDriving() ? getVehicle() : null;
    tele.style.display = panel.style.display = v ? "" : "none";
    if (!v) return;
    const now = performance.now(), dt = Math.min(0.1, (now - t0) / 1000);
    t0 = now;
    const b = v.body, q = b.quat;
    up.set(0, 1, 0).applyQuaternion(q); fwd.set(0, 0, 1).applyQuaternion(q); left.set(1, 0, 0).applyQuaternion(q);
    const speed = b.vel.length(), vF = b.vel.dot(fwd), vL = b.vel.dot(left);
    const yaw = b.angVel.dot(up);
    const slip = speed > 2 ? Math.atan2(vL, Math.abs(vF)) * 180 / Math.PI : 0;
    let down = 0;
    n.set(0, 0, 0);
    for (const t of v.tires) if (t.grounded && t.compression > 0) { down++; n.add(t._rawNormal); }
    if (!down) { last.air += dt; last.airMax = last.air; if (last.air < 0.05) last.vBefore = speed; }
    else {
      if (last.air >= 0.5) {
        n.normalize();
        const err = Math.acos(THREE.MathUtils.clamp(up.dot(n), -1, 1)) * 180 / Math.PI;
        last.landing = { err, air: last.air, grade: err <= 6 ? "PERFECT" : err > 30 ? "ROUGH" : "OK", vIn: speed, t: now };
        last.pending = last.landing;
      }
      last.air = 0;
    }
    if (last.pending && now - last.pending.t > 1000) { last.pending.kept = speed / Math.max(1, last.pending.vIn); last.pending = null; }
    const car = v.isArcadeCar ? "ARCADE" : v.isStuntCar ? "STUNT" : "OLD";
    const L = last.landing;
    tele.textContent =
      `car         ${car}\n` +
      `speed       ${(speed * 3.6).toFixed(0).padStart(4)} km/h\n` +
      `lateral     ${((yaw * Math.abs(vF)) / 9.81).toFixed(2).padStart(5)} g\n` +
      `turn rate   ${((yaw * 180) / Math.PI).toFixed(0).padStart(4)} °/s\n` +
      `slide       ${slip.toFixed(1).padStart(5)} °\n` +
      `wheels      ${down}/4${down ? "" : `   air ${last.air.toFixed(2)} s`}\n` +
      `steer / gas ${(+v.input.steer).toFixed(2)} / ${(+v.input.throttle).toFixed(2)}${v.input.handbrake ? "  HANDBRAKE" : ""}\n` +
      (v.stuntEvents ? `take-off    guided ${v.stuntEvents.takeoffDeg.toFixed(1)}°\n` : "") +
      (v.arcade ? `road        ${v.arcade.onRoad ? "on it" : "flying"}${v.arcade.stunt > 0.01 ? ` · stunt gravity ${(v.arcade.stunt * 100).toFixed(0)}%` : ""}\n` : "") +
      (L ? `landing     ${L.grade} ${L.err.toFixed(0)}° after ${L.air.toFixed(1)} s air${L.kept ? ` · kept ${(L.kept * 100).toFixed(0)}%` : ""}` : "landing     —");
    panel.querySelector("[data-note]").textContent = v.isArcadeCar ? "" : `(the ${car.toLowerCase()} car: only the helpers apply — switch to arcade with the Car button)`;
  }
  requestAnimationFrame(frame);
}
