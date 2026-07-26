// Dev panel structure. Static analysis of devPanel.js — no DOM needed, and the
// bugs it catches are all of the kind that FAIL SILENTLY in a browser:
//
//   • a slider() wired to an id that isn't in the markup — no error, no control
//   • a readout span missing its "-v" twin — the slider works, the number never
//     updates
//   • a DEFAULT_OPEN entry that no longer matches a header after a rename — the
//     panel just opens fully folded and nobody knows why
//   • two sections sharing a fold key — they toggle each other through
//     localStorage
//   • a group's sections not contiguous — wrapping them in place would silently
//     reorder the panel
//
// None of these throw. All of them are one typo away.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "games/modular-road-v3/devPanel.js"), "utf8");

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const headers = [...SRC.matchAll(/<div class="section-header">(.*?)<\/div>/g)].map((m) => decode(m[1]).trim());
const ids = new Set([...SRC.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));

console.log("=== SECTION / FOLD STRUCTURE ===");
console.log(`  ${headers.length} sections`);
{
  // The fold wiring requires header → .section-body as the NEXT element.
  const orphans = [];
  for (const m of SRC.matchAll(/<div class="section-header">(.*?)<\/div>\s*(<div class="section-body">)?/g)) {
    if (!m[2]) orphans.push(decode(m[1]).trim());
  }
  check("every section-header is followed by a section-body (fold needs the sibling)",
    orphans.length === 0, orphans.join(", ") || "all paired");

  check("fold keys are unique — duplicates would toggle each other via localStorage",
    new Set(headers).size === headers.length,
    `${headers.length} headers, ${new Set(headers).size} distinct`);
}

console.log("\n=== NESTED GROUPS ===");
{
  const prefixes = /GROUP_PREFIXES\s*=\s*\[([^\]]*)\]/.exec(SRC)?.[1] ?? "";
  const groups = [...prefixes.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  check("GROUP_PREFIXES parsed from the source", groups.length > 0, groups.join(", "));

  for (const g of groups) {
    const sep = `${g} — `;
    const idx = headers.map((h, i) => (h.startsWith(sep) ? i : -1)).filter((i) => i >= 0);
    check(`"${g}" groups at least 2 sections (fewer and the wrapper is noise)`,
      idx.length >= 2, `${idx.length} sections`);
    // Wrapping inserts the parent where the FIRST member sat and moves the rest
    // in — only order-preserving if they were already consecutive.
    const contiguous = idx.every((v, k) => k === 0 || v === idx[k - 1] + 1);
    check(`"${g}" sections are contiguous (wrapping in place preserves order)`,
      contiguous, `indices ${idx.join(",")}`);
    // The nested display name is the header minus the prefix — must be non-empty.
    check(`"${g}" children all have a name left after the prefix is stripped`,
      idx.every((i) => headers[i].slice(sep.length).trim().length > 0));
  }

  const topLevel = headers.filter((h) => !groups.some((g) => h.startsWith(`${g} — `))).length + groups.length;
  console.log(`  top level: ${topLevel} entries (from ${headers.length} flat)`);
  check("nesting actually shortens the top level", topLevel < headers.length);
}

console.log("\n=== DEFAULT_OPEN NAMES STILL EXIST ===");
{
  const body = /DEFAULT_OPEN\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(SRC)?.[1] ?? "";
  const names = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  check("DEFAULT_OPEN parsed", names.length > 0, names.join(", "));
  for (const n of names) {
    check(`DEFAULT_OPEN "${n}" matches a real header (a rename would silently break it)`,
      headers.includes(n));
  }
}

console.log("\n=== WORLD-LIGHT SLIDERS COVER THE ACTUAL VALUES ===");
// These edit LIVE engine state, not constants in this file — so a range that
// excludes the value in play clamps on init and silently changes the look the
// moment the panel opens. Checked against the game's boot overrides where it
// sets them, and the engine defaults where it doesn't.
{
  const game = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");
  const cfg = readFileSync(join(ROOT, "v2/app/config.js"), "utf8");
  const wstate = readFileSync(join(ROOT, "v3/app/state/worldState.js"), "utf8");

  const range = (id) => {
    const tag = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(SRC)?.[0] ?? "";
    return {
      min: Number(/min="(-?[\d.]+)"/.exec(tag)?.[1]),
      max: Number(/max="(-?[\d.]+)"/.exec(tag)?.[1]),
    };
  };
  const num = (src, key) => Number(new RegExp(`${key}:\\s*(-?[\\d.]+)`).exec(src)?.[1]);

  // roadGame's startV3App({ light: {...} }) block wins over the engine default.
  const boot = /startV3App\(\{[\s\S]*?light:\s*\{([\s\S]*?)\}/.exec(game)?.[1] ?? "";
  const tod = Number(/setTimeOfDay\(([\d.]+)\)/.exec(game)?.[1]);

  const cases = [
    ["dv-tod", "time of day", tod],
    ["dv-exposure", "exposure", num(boot, "exposure")],
    ["dv-sun-int", "dirIntensity", num(boot, "dirIntensity")],
    ["dv-hemi", "hemiIntensity", num(boot, "hemiIntensity")],
    ["dv-env", "envIntensity", num(boot, "envIntensity")],
    ["dv-sky-ray", "rayleigh", num(cfg, "rayleigh")],
    ["dv-sky-mie", "mie", num(wstate, "mie")],
    ["dv-sky-glow", "sunGlowStrength", num(wstate, "sunGlowStrength")],
  ];
  for (const [id, label, val] of cases) {
    const r = range(id);
    check(`${id} covers the live ${label} (${val})`,
      Number.isFinite(val) && Number.isFinite(r.min) && val >= r.min && val <= r.max,
      `${r.min} .. ${r.max}`);
  }
  // Match on the whole slider() line. `[^)]*` does NOT work here — it stops at
  // the first ")" which belongs to the "(v) =>" callback, not the call.
  const todLine = SRC.split("\n").find((l) => l.includes('slider("dv-tod"')) ?? "";
  check("time of day is wired through setTimeOfDay, not written directly — the "
    + "sun angles are its OUTPUT, so writing them would be overwritten",
    todLine.includes("setTimeOfDay"), todLine.trim());
  check("the game sets its own lighting at boot (a .v3proj carries none)",
    boot.length > 0 && Number.isFinite(tod));
}

console.log("\n=== EVERY WIRED CONTROL EXISTS IN THE MARKUP ===");
{
  // slider(id, obj, key, ...) — needs both the input and its "-v" readout.
  const sliders = [...SRC.matchAll(/\bslider\(\s*"([\w-]+)"/g)].map((m) => m[1]);
  const missing = sliders.filter((id) => !ids.has(id));
  const noReadout = sliders.filter((id) => ids.has(id) && !ids.has(`${id}-v`));
  console.log(`  ${sliders.length} sliders wired`);
  check("every slider() id exists in the markup", missing.length === 0, missing.join(", ") || "all present");
  check("every slider has its -v readout span", noReadout.length === 0,
    noReadout.join(", ") || "all present");

  // The negative lookbehind matters: `classList.toggle("collapsed", …)` is all
  // over this file and would otherwise be read as a control wired to an id
  // called "collapsed".
  const toggles = [...SRC.matchAll(/(?<![.\w])toggle\(\s*"([\w-]+)"/g)].map((m) => m[1]);
  const tMissing = toggles.filter((id) => !ids.has(id));
  console.log(`  ${toggles.length} toggles wired`);
  check("every toggle() id exists in the markup", tMissing.length === 0,
    tMissing.join(", ") || "all present");

  // Duplicate ids: querySelector takes the first, so the second control is dead.
  const all = [...SRC.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]);
  const dupes = [...new Set(all.filter((v, i) => all.indexOf(v) !== i))];
  check("no duplicate element ids", dupes.length === 0, dupes.join(", ") || "clean");
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
