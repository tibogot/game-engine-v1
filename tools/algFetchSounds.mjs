// ALG-RTS SOUNDS — fetch the Algeria game's own recordings from freesound.org,
// CC0 ONLY (Creative Commons 0: no attribution required; we keep it anyway):
// for each slot a search, the top few results, their HQ previews downloaded
// to public/sounds/alg/<slot>/<id>.mp3, and public/sounds/alg/manifest.json
// written in the shared mixer's format (games/shared-rts/rtsAudio.js).
//
//   node tools/algFetchSounds.mjs [--n 3] [--only slot,slot]
//
// Loudness (`gain`) and trimmed silence (`start`/`end`) are measured AFTER, in
// the browser (it decodes mp3; there is no ffmpeg here): see measure() in
// games/alg-rts/algSounds.js (__ALG.algSounds.measure()), then bake the result.
// Candidates are swappable live in Dev → Sound; `use` picks the first.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const N = +(args.includes("--n") ? args[args.indexOf("--n") + 1] : 3);
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const DIR = "public/sounds/alg";
const UA = { "User-Agent": "Mozilla/5.0 (game-engine-v1 sound fetch)" };

/**
 * The slots. `q`: the search; `dur`: [min, max] seconds wanted (a loop needs
 * length, a shot must be short); the rest is the mixer's own per-slot setup.
 */
export const SLOTS = {
  // Guns: the French MAS-36/49 and the ALN's mixed bolt-action rifles.
  rifle:     { q: "rifle single shot", dur: [0.5, 4], bus: "sfx", vol: 0.55, voices: 8, ref: 45, pitch: 0.06, gap: 0.025 },
  boltRifle: { q: "gunshot", dur: [0.3, 6], bus: "sfx", vol: 0.55, voices: 8, ref: 45, pitch: 0.06, gap: 0.025 },
  mg:        { q: "machine gun burst", dur: [0.5, 5], bus: "sfx", vol: 0.6, voices: 5, ref: 55, pitch: 0.04, gap: 0.04 },
  cannon:    { q: "tank cannon shot", dur: [0.5, 6], bus: "sfx", vol: 0.9, voices: 4, ref: 90, pitch: 0.05, gap: 0.05 },
  impact:    { q: "bullet impact dirt", dur: [0.1, 2], bus: "sfx", vol: 0.25, voices: 6, ref: 20, pitch: 0.12, gap: 0.03 },
  explosion: { q: "explosion", dur: [1, 8], bus: "sfx", vol: 1, voices: 6, ref: 90, pitch: 0.08, gap: 0.04, far: "explFar", farAt: 260 },
  explFar:   { q: "distant explosion", dur: [1, 10], bus: "sfx", vol: 0.8, voices: 4, ref: 200, pitch: 0.08, gap: 0.08 },
  incoming:  { q: "mortar whistle incoming", dur: [0.8, 4], bus: "sfx", vol: 0.6, voices: 3, ref: 60, pitch: 0.05, gap: 0.2 },
  cry:       { q: "man pain scream", dur: [0.3, 3], bus: "sfx", vol: 0.4, voices: 2, ref: 30, pitch: 0.08, gap: 1.2 },
  // Machines.
  jeep:      { q: "car engine", dur: [3, 90], bus: "sfx", vol: 0.35, loops: 2, ref: 30, loop: true },
  truck:     { q: "truck engine loop", dur: [4, 60], bus: "sfx", vol: 0.4, loops: 2, ref: 40, loop: true },
  heli:      { q: "helicopter loop", dur: [4, 60], bus: "sfx", vol: 0.55, loops: 2, ref: 60, loop: true },
  fireLoop:  { q: "fire crackling loop", dur: [4, 60], bus: "sfx", vol: 0.5, loops: 2, ref: 35, loop: true },
  build:     { q: "shovel digging", dur: [1, 20], bus: "sfx", vol: 0.4, voices: 2, ref: 30, pitch: 0.05, gap: 0.5 },
  // The land (ambience bed + places).
  wind:      { q: "desert wind loop", dur: [10, 120], bus: "ambience", vol: 0.08, loops: 1, loop: true },
  cicadas:   { q: "cicadas", dur: [8, 120], bus: "ambience", vol: 0.05, loops: 1, loop: true },
  adhan:     { q: "muezzin", dur: [10, 600], bus: "sfx", vol: 0.5, voices: 1, ref: 140, pitch: 0, gap: 30 },
  dog:       { q: "dog barking distant", dur: [0.5, 8], bus: "sfx", vol: 0.35, voices: 2, ref: 60, pitch: 0.06, gap: 1.5 },
  goat:      { q: "goat bleat", dur: [0.3, 4], bus: "sfx", vol: 0.3, voices: 2, ref: 35, pitch: 0.1, gap: 1 },
  donkey:    { q: "donkey bray", dur: [1, 8], bus: "sfx", vol: 0.35, voices: 1, ref: 60, pitch: 0.05, gap: 8 },
  // UI.
  uiClick:   { q: "ui click", dur: [0.02, 0.6], bus: "ui", vol: 0.5, voices: 3, pitch: 0.03, gap: 0.03 },
  radio:     { q: "radio squelch", dur: [0.1, 3], bus: "ui", vol: 0.45, voices: 2, pitch: 0.04, gap: 0.25 },
};

const get = async (url) => { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r; };

async function search(q) {
  const url = `https://freesound.org/search/?q=${encodeURIComponent(q)}&f=license:%22Creative+Commons+0%22&s=Downloads+(most+first)`;
  const html = await (await get(url)).text();
  return [...new Set([...html.matchAll(/\/people\/([^/"]+)\/sounds\/(\d+)\//g)].map((m) => `${m[1]}|${m[2]}`))].map((s) => { const [by, id] = s.split("|"); return { by, id: +id }; });
}

async function details({ by, id }) {
  const page = `https://freesound.org/people/${by}/sounds/${id}/`;
  const html = await (await get(page)).text();
  const mp3 = html.match(/https:\/\/cdn\.freesound\.org\/previews\/[^"]*-hq\.mp3/)?.[0];
  const cc0 = /Creative Commons 0|publicdomain\/zero/i.test(html);
  const title = (html.match(/<title>"?([^<"]*?)"? by [^<]*<\/title>/)?.[1] ?? html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "").trim();
  const d = html.match(/data-duration="([\d.]+)"/)?.[1] ?? html.match(/"duration"\s*:\s*([\d.]+)/)?.[1];
  return { page, mp3, cc0, title, dur: d ? +d : null };
}

const old = fs.existsSync(`${DIR}/manifest.json`) ? JSON.parse(fs.readFileSync(`${DIR}/manifest.json`, "utf8")) : { slots: {} };
const manifest = {
  note: "alg-rts sounds. All CC0 (Creative Commons 0) from freesound.org (HQ previews); url = the source page. gain = measured loudness normalised (browser, algSounds.measure()); start/end = trimmed silence. use = the chosen candidate(s); Dev -> Sound swaps them live. Fetched by tools/algFetchSounds.mjs.",
  slots: { ...old.slots },
};
for (const [slot, S] of Object.entries(SLOTS)) {
  if (ONLY && !ONLY.includes(slot)) continue;
  const { q, dur, ...mix } = S;
  const files = [];
  try {
    for (const hit of await search(q)) {
      if (files.length >= N) break;
      const d = await details(hit);
      if (!d.mp3 || !d.cc0) continue;
      if (d.dur != null && (d.dur < dur[0] || d.dur > dur[1])) continue;
      const rel = `${slot}/${hit.id}.mp3`;
      fs.mkdirSync(path.join(DIR, slot), { recursive: true });
      if (!fs.existsSync(path.join(DIR, rel))) fs.writeFileSync(path.join(DIR, rel), Buffer.from(await (await get(d.mp3)).arrayBuffer()));
      files.push({ f: rel, id: hit.id, by: hit.by, t: d.title, url: d.page, gain: 1, dur: d.dur ?? 0 });
    }
  } catch (e) { console.warn(`${slot}: ${e.message}`); }
  if (!files.length) { console.warn(`${slot}: nothing CC0 in range for "${q}"`); continue; }
  manifest.slots[slot] = { use: [0], ...mix, files };
  console.log(`${slot.padEnd(10)} ${files.length} × ${files.map((f) => `${f.id} (${f.dur ?? "?"} s)`).join(", ")}`);
}
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1));
console.log(`wrote ${DIR}/manifest.json`);
