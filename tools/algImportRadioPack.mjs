// IMPORT THE MILITARY VOICE PACK (2026-10-08, you: "I've found a pack of military radio voices —
// English only"). The PLACEHOLDER voices of every language version until your French recordings
// (and an Arabic FLN): each side will then speak its own language for every player.
//
//   node tools/algImportRadioPack.mjs --ffmpeg <path to ffmpeg.exe>
//
// Source (not shipped): assets-src/sounds/radio-pack/GameDev Market Military Voice Pack PRO WAV/
//   Male/       the dry voice — the soldiers you command, heard where they stand
//   MaleRadio/  the same lines through a radio — the post / HQ (`pre: true`: algVoices does not
//               filter them again)
//   Misc/       Radio Bleep 1-10 → the "radio" squelch slot (public/sounds/alg/manifest.json)
// The female voices are left out (no women on the French net in 1956), and the pack's modern or
// gamey lines ("Tango Down", "Okey Dokey", "First Blood" …).
//
// Each file: mono, 24 kHz, mp3 48 kb/s, leading / trailing silence cut (a soldier answers at once),
// loudness levelled (EBU R128, -16 LUFS). Output: public/sounds/alg/voices/<side>/… + manifest.json
// ({ lines: { id: { side, files: [{ f, voice, text, pre }] } }, voices: { side: [names] } }).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK = path.join(ROOT, "assets-src/sounds/radio-pack/GameDev Market Military Voice Pack PRO WAV");
const OUT = path.join(ROOT, "public/sounds/alg/voices");
const SFX = path.join(ROOT, "public/sounds/alg");
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const FFMPEG = arg("--ffmpeg") ?? "ffmpeg";

// Each game line (tools/algVoiceLines.mjs ids) → the pack's phrases (file names without
// "Male " and the take number). Every take of every phrase is used: variety.
const LINES = {
  // the soldiers (dry, positional)
  fr_select:      { side: "fr", phrases: ["Yes Sir", "Sir Yes Sir", "Standing By", "Reporting"] },
  fr_move:        { side: "fr", phrases: ["Move Out", "Roger", "Roger That", "Copy That", "Understood", "Order Acknowledged", "Affirmative"] },
  fr_attack:      { side: "fr", phrases: ["Engaging Enemy", "Open Fire", "Opening Fire", "Engage The Enemy", "Engaging Target"] },
  fr_vehicleMove: { side: "fr", phrases: ["Roger That", "Copy That", "Move Out", "Affirmative"] },
  fr_contact:     { side: "fr", phrases: ["Enemy Spotted", "Hostiles Detected", "Hostile", "Target Spotted"] },
  fr_underFire:   { side: "fr", phrases: ["We Are Under Fire", "Take Cover", "Get Down"] },
  fr_pinned:      { side: "fr", phrases: ["Im Under Heavy Fire", "Under Heavy Fire", "Stay Low"] },
  fr_grenade:     { side: "fr", phrases: ["Grenade", "Fire In The Hole", "Throwing Grenade"] },
  fr_manDown:     { side: "fr", phrases: ["Man Down", "Medic", "Need Medic", "Im Hit"] },
  fr_build:       { side: "fr", phrases: ["Im On It", "Order Acknowledged", "Understood"] },
  fr_victory:     { side: "fr", phrases: ["Area Secure", "All Clear"] },
  // the post / HQ (through the radio)
  hq_contact:       { side: "hq", phrases: ["Hostiles Detected", "Enemy Spotted", "Enemy Engaged"] },
  hq_enemySeen:     { side: "hq", phrases: ["Hostiles Detected", "Target Spotted", "Visual On Target"] },
  hq_enemyMG:       { side: "hq", phrases: ["Under Heavy Enemy Fire", "Take Cover"] },
  hq_villageTaken:  { side: "hq", phrases: ["Area Secure", "Captured", "All Clear"] },
  hq_villageLost:   { side: "hq", phrases: ["Objective Failed", "Fall Back"] },
  hq_villageThreat: { side: "hq", phrases: ["Need Support", "Require Support"] },
  hq_vehicleLost:   { side: "hq", phrases: ["Taking Casualties", "Status Critical"] },
  hq_buildingLost:  { side: "hq", phrases: ["Taking Casualties", "Status Critical"] },
  hq_postAttack:    { side: "hq", phrases: ["Request Immediate Support", "Need Backup", "Mayday", "Under Heavy Enemy Fire"] },
  hq_cacheFound:    { side: "hq", phrases: ["Weapons Here"] },
  hq_muleTrain:     { side: "hq", phrases: ["Target Spotted", "Visual On Target"] },
  hq_mine:          { side: "hq", phrases: ["Danger", "Watch Out"] },
  hq_reinforce:     { side: "hq", phrases: ["The Cavalry Has Arrived"] },
  hq_tier:          { side: "hq", phrases: ["Order Received"] },
  hq_victory:       { side: "hq", phrases: ["Operation Successful", "Well Done"] },
  hq_defeat:        { side: "hq", phrases: ["Abort Mission", "Fall Back Fall Back", "Retreat"] },
};
const SOURCE = { fr: { dir: "Male", prefix: "Male " }, hq: { dir: "MaleRadio", prefix: "Radio - Male " } };

const FILTER = "silenceremove=start_periods=1:start_threshold=-48dB,areverse,silenceremove=start_periods=1:start_threshold=-48dB,areverse,loudnorm=I=-16:TP=-1.5:LRA=11";
function encode(src, dst, filter = FILTER) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-i", src, "-af", filter, "-ac", "1", "-ar", "24000", "-c:a", "libmp3lame", "-b:a", "48k", dst]);
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");

const manifest = {
  note: "alg-rts voices — the GameDev Market Military Voice Pack (English placeholder, every language version), tools/algImportRadioPack.mjs.",
  voices: { fr: ["pack"], hq: ["pack"] },
  lines: {},
};
const done = new Map();   // source file → output name (a phrase used by two lines is encoded once)
let bytes = 0, missing = [];
for (const [id, { side, phrases }] of Object.entries(LINES)) {
  const { dir, prefix } = SOURCE[side];
  const files = [];
  for (const ph of phrases) {
    const takes = fs.readdirSync(path.join(PACK, dir)).filter((f) => f.startsWith(`${prefix}${ph} `) && /^\d+\.wav$/.test(f.slice(prefix.length + ph.length + 1)));
    if (!takes.length) { missing.push(`${id}: ${ph}`); continue; }
    for (const take of takes) {
      const src = path.join(PACK, dir, take);
      let f = done.get(src);
      if (!f) {
        f = `${side}/${slug(ph)}_${take.match(/(\d+)\.wav$/)[1]}.mp3`;
        encode(src, path.join(OUT, f));
        bytes += fs.statSync(path.join(OUT, f)).size;
        done.set(src, f);
      }
      files.push({ f, voice: "pack", text: ph, ...(side === "hq" ? { pre: true } : {}) });
    }
  }
  if (files.length) manifest.lines[id] = { side, files };
}
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));

// The squelch: the pack's 10 radio bleeps into the "radio" slot (the old files kept, unused).
const sm = JSON.parse(fs.readFileSync(path.join(SFX, "manifest.json"), "utf8"));
const slot = sm.slots.radio;
slot.files = slot.files.filter((x) => !String(x.f).startsWith("radio/pack_bleep_"));
const first = slot.files.length;
for (let k = 1; k <= 10; k++) {
  const f = `radio/pack_bleep_${k}.mp3`;
  encode(path.join(PACK, "Misc", `Radio Bleep ${k}.wav`), path.join(SFX, f), "loudnorm=I=-18:TP=-1.5");
  slot.files.push({ f, by: "GameDev Market Military Voice Pack PRO", t: `Radio Bleep ${k}`, gain: 1 });
  bytes += fs.statSync(path.join(SFX, f)).size;
}
slot.use = slot.files.map((_, i) => i).filter((i) => i >= first);
fs.writeFileSync(path.join(SFX, "manifest.json"), JSON.stringify(sm, null, 1));

const n = Object.values(manifest.lines).reduce((s, l) => s + l.files.length, 0);
console.log(`${Object.keys(manifest.lines).length} lines, ${n} takes (${done.size} files) + 10 bleeps, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
if (missing.length) console.log(`missing in the pack:\n  ${missing.join("\n  ")}`);
