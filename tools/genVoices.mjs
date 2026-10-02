/**
 * GENERATE THE VOICES — ElevenLabs text-to-speech for every line of
 * tools/algVoiceLines.mjs, once, into small MP3s the game plays
 * (games/alg-rts/algVoices.js).
 *
 *   ELEVENLABS_API_KEY   your key, as an ENVIRONMENT VARIABLE (setx on Windows,
 *                        then a new terminal). Never in the repo, never pasted.
 *
 *   node tools/genVoices.mjs --list        the voices on your account (pick ids)
 *   node tools/genVoices.mjs               generate what is missing (resumable)
 *   node tools/genVoices.mjs --force       generate everything again
 *   node tools/genVoices.mjs --only fr_contact,aln_attack
 *
 * VOICES (below, VOICES): a few per side, so a squad does not speak with one
 * throat; each line is said by every voice of its side (a man keeps his voice
 * in the game). ElevenLabs' multilingual model speaks French and Arabic with
 * any voice; swap the ids for ones you like from --list or the Voice Library.
 *
 * Output: public/sounds/alg/voices/<side>/<lineId>_<text#>_<voice>.mp3 and
 * public/sounds/alg/voices/manifest.json — { lines: { id: { side, files: [{ f,
 * voice, text }] } }, voices: { side: [names] } }.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VOICE_LINES } from "./algVoiceLines.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public/sounds/alg/voices");
const KEY = process.env.ELEVENLABS_API_KEY;
const API = "https://api.elevenlabs.io/v1";
const MODEL = "eleven_multilingual_v2";

/**
 * Who speaks for each side: NATIVE speakers from the ElevenLabs Voice Library
 * (French; Algerian Arabic for the ALN). `owner` lets the tool add a library
 * voice to the account once, automatically (TTS refuses one not added).
 */
export const VOICES = {
  fr: [
    { name: "theo", id: "NBjtCdChq5Ph56VnCM8Z", owner: "b7a29aad3b6638e2a1e901d9c42cae4befac164280cc25ccad0125c1f04f426e" },   // intense, young
    { name: "lucas", id: "QEZnlKYcLy9N2ierwPEc", owner: "3f21210432bf2e576d96f4ec2607906d60d748c2c690528dcba1105cff8ba351" }, // dynamic, young
    { name: "hugo", id: "6DEjyaHWnTHsvXM5Byys", owner: "5ecac986b5974691b1317db0772f64668bb1e9c161b11b64c887a15eb1238029" },  // deep
  ],
  hq: [
    { name: "christophe", id: "M9MhEgzxZ8w5I27Tl1h5", owner: "d32aa994ad86bd829ac07c468b3332c62b5aca57a47f4e0e248f09ffe8c7edd9" }, // calm, Parisian
  ],
  aln: [
    // Algerian Arabic speakers.
    { name: "amin", id: "wZ6E1XvJnMjmRvpvp2vY", owner: "2ba9db0da3c7e5274f42dd3dab80653b2f9fc646af0f56b95701fdc6207edbce" },   // Algerian Darija
    { name: "chamsou", id: "dbXZnF5pfQqN00XGwlRF", owner: "a5c7482a6bb7d181fd73b6f409d6072b4d85fc8eef5b10f6cd85c0b233359312" },
    { name: "ilyass", id: "jpofSqItAIlT4TLP5CrK", owner: "d1cc3a9534338b86294088316ab2ce0053a52eb0adb957c07e2c66c1f5496229" },
  ],
};
/**
 * THE FREE PLAN can only use ElevenLabs' own default voices through the API
 * (library voices need a paid plan, some Creator+). They speak French and
 * Arabic through the multilingual model, with their own accent.
 * --set free picks these.
 */
export const VOICES_FREE = {
  fr: [
    { name: "harry", id: "SOYHLrjzK2X1ezoPC6cr" },    // fierce warrior
    { name: "charlie", id: "IKne3meq5aSn9XLyUdCD" },  // deep, energetic
    { name: "callum", id: "N2lVS1w4EtoT3dr4eOWO" },   // husky
  ],
  hq: [
    { name: "daniel", id: "onwK4e9ZLuTAKqWW03F9" },   // steady broadcaster
  ],
  aln: [
    { name: "adam", id: "pNInz6obpgDQGcFmaJgB" },     // dominant, firm
    { name: "brian", id: "nPczCjzI2devNBz1zQrb" },    // deep
    { name: "roger", id: "CwhRBWXzGAHq8TQ4Fs17" },    // resonant
  ],
};

/** Barks are shouted (low stability, some style); the radio is steadier. */
const SETTINGS = {
  fr: { stability: 0.32, similarity_boost: 0.8, style: 0.55, use_speaker_boost: true },
  aln: { stability: 0.3, similarity_boost: 0.8, style: 0.6, use_speaker_boost: true },
  hq: { stability: 0.55, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true },
};

const args = process.argv.slice(2);
const has = (k) => args.includes(`--${k}`);
const val = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : null; };

if (!KEY) {
  console.error("ELEVENLABS_API_KEY is not set. On Windows: setx ELEVENLABS_API_KEY \"…\" then open a NEW terminal.");
  process.exit(1);
}
const headers = { "xi-api-key": KEY, "Content-Type": "application/json" };

if (has("list")) {
  const r = await fetch(`${API}/voices`, { headers });
  if (!r.ok) { console.error(`voices: HTTP ${r.status} ${await r.text()}`); process.exit(1); }
  const j = await r.json();
  for (const v of j.voices ?? []) console.log(`${v.voice_id}  ${v.name.padEnd(24)} ${Object.values(v.labels ?? {}).join(", ")}`);
  process.exit(0);
}

if (val("set") === "free") for (const k of Object.keys(VOICES)) VOICES[k] = VOICES_FREE[k];
// Library voices into the account (once; the paid set only): TTS refuses a shared voice that is not added.
{
  const r = await fetch(`${API}/voices`, { headers });
  const mine = new Set(((await r.json()).voices ?? []).map((v) => v.voice_id));
  for (const v of Object.values(VOICES).flat()) {
    if (!v.owner || mine.has(v.id)) continue;
    const a = await fetch(`${API}/voices/add/${v.owner}/${v.id}`, { method: "POST", headers, body: JSON.stringify({ new_name: `alg-${v.name}` }) });
    console.log(`  voice ${v.name}: ${a.ok ? "added to your account" : `not added (HTTP ${a.status}) ${(await a.text()).slice(0, 160)}`}`);
  }
}

// --sample: one line per voice into a scratch folder (to choose voices before spending credits).
const SAMPLE = val("sample");
if (SAMPLE) {
  // One telling line per side, said by every voice of that side.
  const PICK = { fr: "fr_pinned", hq: "hq_postAttack", aln: "aln_contact" };
  fs.mkdirSync(SAMPLE, { recursive: true });
  for (const [side, id] of Object.entries(PICK)) {
    const text = VOICE_LINES[id].texts[0];
    for (const v of VOICES[side]) {
      const r = await fetch(`${API}/text-to-speech/${v.id}?output_format=mp3_44100_64`, {
        method: "POST", headers, body: JSON.stringify({ text, model_id: MODEL, voice_settings: SETTINGS[side] }),
      });
      if (!r.ok) { console.log(`  ${side}/${v.name}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`); continue; }
      const out = path.join(SAMPLE, `${side}_${v.name}.mp3`);
      fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
      console.log(`  ${out}  "${text}"`);
    }
  }
  process.exit(0);
}

const only = val("only")?.split(",") ?? null;
const force = has("force");
const manifestPath = path.join(OUT, "manifest.json");
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : { lines: {} };
manifest.note = "alg-rts voices — generated by tools/genVoices.mjs (ElevenLabs, " + MODEL + ") from tools/algVoiceLines.mjs.";
manifest.voices = Object.fromEntries(Object.entries(VOICES).map(([s, vs]) => [s, vs.map((v) => v.name)]));

let made = 0, kept = 0, chars = 0, failed = 0;
for (const [id, line] of Object.entries(VOICE_LINES)) {
  if (only && !only.includes(id)) continue;
  const dir = path.join(OUT, line.side);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const [ti, text] of line.texts.entries()) {
    for (const v of VOICES[line.side]) {
      const f = `${line.side}/${id}_${ti}_${v.name}.mp3`;
      const abs = path.join(OUT, f);
      if (!force && fs.existsSync(abs) && fs.statSync(abs).size > 1000) { files.push({ f, voice: v.name, text }); kept++; continue; }
      const r = await fetch(`${API}/text-to-speech/${v.id}?output_format=mp3_44100_64`, {
        method: "POST", headers,
        body: JSON.stringify({ text, model_id: MODEL, voice_settings: SETTINGS[line.side] }),
      });
      if (!r.ok) {
        failed++;
        console.error(`  ${f}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
        if (r.status === 401 || r.status === 402 || r.status === 429) { console.error("Stopping (key, quota or rate limit)."); break; }
        continue;
      }
      fs.writeFileSync(abs, Buffer.from(await r.arrayBuffer()));
      files.push({ f, voice: v.name, text });
      made++; chars += text.length;
      process.stdout.write(`\r  ${made} made, ${kept} kept — ${id}`.padEnd(70));
    }
  }
  if (files.length) manifest.lines[id] = { side: line.side, files };
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
let bytes = 0;
for (const l of Object.values(manifest.lines)) for (const f of l.files) bytes += fs.statSync(path.join(OUT, f.f)).size;
console.log(`\n${made} generated (${chars} characters), ${kept} kept, ${failed} failed — ${(bytes / 1024 / 1024).toFixed(2)} MB in public/sounds/alg/voices/`);
