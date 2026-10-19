// The audio lab (v3/audio-lab.html): the mixer on the NAM test slots, heard by a still chase listener
// at the origin facing −Z. window.__audioLab.selfTest() measures it over CDP (peak / rms while playing,
// silence after stop, mute and pause really silent).
import * as THREE from "three";
import { createMixer } from "./mixer.js";
import { chaseListener } from "./listeners.js";

const $ = (id) => document.getElementById(id);
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000); // at the origin, looking down −Z
const mixer = createMixer({
  storeKey: "v3.audioLab.mix",
  defaults: { muted: false },
  listener: chaseListener({ camera }),
  manifestUrl: "/sounds/nam/manifest.json",
});

// ---------- the mix ----------
function slider(key, label) {
  return `<label>${label} <input type="range" min="0" max="100" value="${Math.round((mixer.settings[key] ?? 1) * 100)}" data-k="${key}"></label>`;
}
$("mix").innerHTML = slider("master", "Master") + ["music", "sfx", "ambience", "ui"].map((b) => slider(b, b)).join("") +
  `<br><button id="mute">Mute</button><button id="pause">Pause</button>`;
for (const el of $("mix").querySelectorAll("input")) el.oninput = () => mixer.set(el.dataset.k, el.value / 100);
$("mute").onclick = () => { mixer.set("muted", !mixer.settings.muted); $("mute").classList.toggle("on", mixer.settings.muted); };
$("pause").onclick = () => { if (mixer.paused) mixer.resume(); else mixer.pause(); $("pause").classList.toggle("on", mixer.paused); };

// ---------- one-shots round the listener ----------
const SPOTS = { "here (no position)": null, "left 20 m": [-20, 0, -5], "right 20 m": [20, 0, -5], "ahead 60 m": [0, 0, -60], "far 400 m": [0, 0, -400] };
await mixer.ready;
const oneShots = Object.entries(mixer.slots).filter(([, s]) => !s.loop).map(([n]) => n);
$("shots").innerHTML = oneShots.map((n) => `<div>${n}: ${Object.keys(SPOTS).map((k) => `<button data-n="${n}" data-s="${k}">${k}</button>`).join("")}</div>`).join("");
for (const b of $("shots").querySelectorAll("button")) b.onclick = () => {
  const p = SPOTS[b.dataset.s];
  if (p) mixer.play(b.dataset.n, ...p); else mixer.play(b.dataset.n);
};

// ---------- loops (a provider asked every frame) ----------
const on = new Set();
const loopNames = Object.entries(mixer.slots).filter(([, s]) => s.loop).map(([n]) => n);
$("loops").innerHTML = loopNames.map((n) => `<button data-l="${n}">${n}</button>`).join("");
for (const b of $("loops").querySelectorAll("button")) b.onclick = () => { if (on.has(b.dataset.l)) on.delete(b.dataset.l); else on.add(b.dataset.l); b.classList.toggle("on"); };
mixer.addLoopProvider(() => [...on].map((n) => ({ slot: n, key: n, x: 0, y: 0, z: -15, level: 1 })));

// ---------- the meter ----------
function frame() {
  requestAnimationFrame(frame);
  mixer.update();
  const m = mixer.meter();
  $("bar").style.width = `${Math.max(0, Math.min(100, (m.peakDb + 60) * (100 / 60)))}%`;
  $("meter").textContent = `peak ${m.peakDb} dB   rms ${m.rmsDb} dB   compressor ${m.reductionDb} dB   voices ${mixer.voices}   context ${mixer.ctx.state}`;
}
frame();

// ---------- the self-test (CDP, with a user gesture) ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const peakOver = async (ms) => { let pk = -200; const t0 = performance.now(); while (performance.now() - t0 < ms) { pk = Math.max(pk, mixer.meter().peakDb); await wait(20); } return pk; };
window.__audioLab = {
  mixer,
  async selfTest() {
    mixer.set("muted", false);
    mixer.resume();
    mixer.unlock();
    await wait(300);
    const out = { context: mixer.ctx.state, slots: Object.keys(mixer.slots).length };
    out.silenceDb = await peakOver(300);
    mixer.play("rifle"); out.rifleHereDb = await peakOver(600);
    await wait(400);
    mixer.play("rifle", 0, 0, -400); out.rifleFar400Db = await peakOver(600);
    await wait(400);
    on.add("jeep"); out.loopDb = await peakOver(1500);
    on.delete("jeep"); await wait(1200); out.afterLoopStopDb = await peakOver(400);
    on.add("jeep"); await wait(800); mixer.pause(); await wait(200); out.pausedState = mixer.ctx.state;
    mixer.resume(); await wait(300); out.resumedState = mixer.ctx.state;
    mixer.set("muted", true); await wait(200); out.mutedState = mixer.ctx.state;
    mixer.set("muted", false); on.delete("jeep");
    out.voices = mixer.voices;
    return out;
  },
};
