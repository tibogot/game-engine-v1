// alg-rts LANGUAGES: every t("…") in the game has its English (games/alg-rts/i18n/i18n.js).
//
// Scans the game's code for t() calls whose first argument is a string literal ("…", '…' or a
// `…` with no ${}), and checks:
//   1. the English dictionary has it (a missing one shows in French to an English player);
//   2. its English uses the SAME {placeholders} (a dropped {name} prints nothing; an extra one
//      prints "{name}" on screen);
//   3. no English entry is an empty string.
// Dictionary entries the code no longer uses are reported, not failed (dead lines are harmless).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAME = join(ROOT, "games", "alg-rts");

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
  if (!ok) fail++;
};

function* walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== "i18n" && f !== "terrain") yield* walk(p); }
    else if (p.endsWith(".js") || p.endsWith("alg.html")) yield p;   // (alg.html: the loading screen)
  }
}

// t( "…" | '…' | `…` ) — the literal's raw text, unescaped like JS would.
const CALL = /(?<![\w.$])t\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\$]|\\.|\$(?!\{))*)`)/g;
const unescape = (s) => s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (m, c) => {
  if (c[0] === "u") return String.fromCodePoint(parseInt(c.replace(/[u{}]/g, ""), 16));
  if (c[0] === "x") return String.fromCharCode(parseInt(c.slice(1), 16));
  return { n: "\n", t: "\t", r: "\r", "0": "\0" }[c] ?? c;
});

const used = new Map();   // key → "file:line"
for (const file of walk(GAME)) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(CALL)) {
    const key = unescape(m[1] ?? m[2] ?? m[3]);
    if (!used.has(key)) used.set(key, `${relative(ROOT, file)}:${src.slice(0, m.index).split("\n").length}`);
  }
}

const EN = (await import(pathToFileURL(join(GAME, "i18n", "en", "index.js")).href)).default;
const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

const missing = [...used].filter(([k]) => !(k in EN)).map(([k, at]) => `${at}  "${k.slice(0, 90)}"`);
check(`every t() line has its English (${used.size} lines in the code)`, missing.length === 0, missing.slice(0, 40).join("\n      ") + (missing.length > 40 ? `\n      … ${missing.length - 40} more` : ""));

const badPh = [...used].filter(([k]) => k in EN && ph(k) !== ph(EN[k])).map(([k, at]) => `${at}  {${ph(k)}} vs English {${ph(EN[k])}}`);
check("the English keeps the same {placeholders}", badPh.length === 0, badPh.join("\n      "));

const empty = Object.entries(EN).filter(([, v]) => typeof v !== "string" || !v.trim()).map(([k]) => `"${k.slice(0, 80)}"`);
check("no empty English line", empty.length === 0, empty.join("\n      "));

// The same French in two parts must read the same in English (the merge keeps only the last).
const parts = {};
for (const f of readdirSync(join(GAME, "i18n", "en"))) {
  if (f === "index.js" || !f.endsWith(".js")) continue;
  parts[f] = (await import(pathToFileURL(join(GAME, "i18n", "en", f)).href)).default;
}
const seen = new Map(), clash = [];
for (const [f, d] of Object.entries(parts)) for (const [k, v] of Object.entries(d)) {
  const prev = seen.get(k);
  if (prev && prev.v !== v) clash.push(`"${k.slice(0, 50)}": ${prev.f} "${prev.v.slice(0, 40)}" vs ${f} "${v.slice(0, 40)}"`);
  else if (!prev) seen.set(k, { f, v });
}
check("a French line has ONE English across the parts", clash.length === 0, clash.join("\n      "));

const dead = Object.keys(EN).filter((k) => !used.has(k));
if (dead.length) console.log(`note: ${dead.length} English line(s) no t() uses any more`);

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
