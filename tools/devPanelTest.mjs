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

console.log("\n=== MARKUP NESTING ===");
// A STRAY </div> CLOSES A SECTION EARLY AND NOTHING COMPLAINS. The browser's
// parser repairs it, the controls still render in roughly the right place, and
// they still get wired — so it survives. What it costs is the fold: rows that
// escaped the .section-body stay on screen when you collapse the section, and
// rows that escaped the .inspector-section stay on screen on EVERY TAB. Two of
// them had been sitting in "Sky — Night" long enough that nine sliders were
// outside their own section.
//
// Every one of these elements has exactly one correct depth, so walking the
// template and comparing is the whole test.
{
  const lines = SRC.split("\n");
  const from = lines.findIndex((l) => l.includes("root.innerHTML = `"));
  const to = lines.findIndex((l, i) => i > from && l.trim() === "`;");
  check("the panel template was found", from >= 0 && to > from);

  let depth = 0;
  let negative = false;
  const misplaced = [];
  // Depth 1 is a child of .tab-content: a section. Its header and body are 2,
  // and the rows and notes inside the body are 3.
  const WANT = { "inspector-section": 1, "section-body": 2, "prop-row": 3, "dv-hint": 3 };
  for (let i = from; i <= to; i++) {
    for (const m of lines[i].matchAll(/<div\b[^>]*>|<\/div>/g)) {
      if (m[0] === "</div>") { depth--; if (depth < 0) negative = true; continue; }
      for (const [cls, want] of Object.entries(WANT)) {
        // The advert prism block is a real wrapper around its rows, so a
        // prop-row is allowed to be one deeper than the section body.
        if (!m[0].includes(`class="${cls}"`)) continue;
        if (depth !== want && !(cls === "prop-row" && depth === want + 1)) {
          misplaced.push(`${cls} at line ${i + 1} depth ${depth} (want ${want})`);
        }
      }
      depth++;
    }
  }
  check("the template's divs balance", depth === 0 && !negative, `ends at ${depth}`);
  check("every section, body, row and note sits at its own nesting depth",
    misplaced.length === 0, misplaced.slice(0, 6).join("; ") || "all nested correctly");
}

console.log("\n=== NESTED GROUPS ===");
/** Group names and the top-level fold keys, shared with the tab checks below. */
let groups = [];
let topLevelKeys = [];
{
  // Comments stripped FIRST: the note above this list names two of the groups
  // in quotes, and without this they parse as extra (duplicate) prefixes.
  const prefixes = (/GROUP_PREFIXES\s*=\s*\[([^\]]*)\]/.exec(SRC)?.[1] ?? "")
    .replace(/\/\/[^\n]*/g, "");
  groups = [...prefixes.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
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

  // The keys the panel actually shows at the top of a tab: a section that was
  // not swallowed by a group keeps its own name, and each group contributes one
  // entry where its first member sat.
  const seen = new Set();
  for (const h of headers) {
    const g = groups.find((p) => h.startsWith(`${p} — `));
    if (!g) { topLevelKeys.push(h); continue; }
    if (!seen.has(g)) { seen.add(g); topLevelKeys.push(g); }
  }
  console.log(`  top level: ${topLevelKeys.length} entries (from ${headers.length} flat)`);
  check("nesting actually shortens the top level", topLevelKeys.length < headers.length);
}

console.log("\n=== TABS COVER EVERY SECTION, EXACTLY ONCE ===");
// The whole risk of a tabbed panel: a section that no tab claims is INVISIBLE.
// The panel itself falls back to showing an unclaimed section on the first tab
// and warning, so nothing is ever lost at runtime — this is what makes the
// mistake visible at commit time instead.
{
  const block = /const TABS\s*=\s*\[([\s\S]*?)\n  \];/.exec(SRC)?.[1] ?? "";
  const tabs = [...block.matchAll(/\{\s*id:\s*"([\w-]+)"[\s\S]*?keys:\s*\[([\s\S]*?)\]\s*\}/g)]
    .map((m) => ({ id: m[1], keys: [...m[2].matchAll(/"([^"]+)"/g)].map((k) => k[1]) }));
  check("TABS parsed from the source", tabs.length > 0,
    tabs.map((t) => `${t.id}(${t.keys.length})`).join(" "));
  check("tab ids are unique", new Set(tabs.map((t) => t.id)).size === tabs.length);

  const claimed = tabs.flatMap((t) => t.keys);
  const unknown = claimed.filter((k) => !topLevelKeys.includes(k));
  check("every tab key is a real top-level section or group", unknown.length === 0,
    unknown.join(", ") || "all resolve");

  const orphans = topLevelKeys.filter((k) => !claimed.includes(k));
  check("every top-level section is claimed by a tab", orphans.length === 0,
    orphans.join(", ") || "all placed");

  const twice = [...new Set(claimed.filter((v, i) => claimed.indexOf(v) !== i))];
  check("no section is claimed by two tabs (the second move wins, silently)",
    twice.length === 0, twice.join(", ") || "no overlap");

  const worst = Math.max(...tabs.map((t) => t.keys.length));
  check("no tab is longer than the corridor it replaced", worst <= 12, `longest ${worst}`);
}

console.log("\n=== DEFAULT_OPEN NAMES STILL EXIST ===");
{
  const body = /DEFAULT_OPEN\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(SRC)?.[1] ?? "";
  const names = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  check("DEFAULT_OPEN parsed", names.length > 0, names.join(", "));
  // A GROUP name is a fold key too — the wrapper header is built in JS, so it
  // never appears in the markup this test reads.
  for (const n of names) {
    check(`DEFAULT_OPEN "${n}" matches a real header or group (a rename would silently break it)`,
      headers.includes(n) || groups.includes(n));
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
  /* The boot time of day moved behind a named constant — `setTimeOfDay(
   * GAME_TIME_OF_DAY)` rather than an inline number — so scraping a literal out
   * of the call started returning NaN. That single NaN failed TWO checks: this
   * slider's range, and the "game sets its own lighting at boot" assertion
   * below, which only tests `Number.isFinite(tod)`. Resolve the constant, and
   * still accept an inline literal so either style works. */
  const todArg = /setTimeOfDay\(\s*([A-Za-z_$][\w$]*|[\d.]+)\s*\)/.exec(game)?.[1] ?? "";
  const tod = /^[\d.]+$/.test(todArg)
    ? Number(todArg)
    : Number(new RegExp(`(?:const|let|var)\\s+${todArg}\\s*=\\s*([\\d.]+)`).exec(game)?.[1]);

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
  // slider(id, obj, key, …) and roadSlider(id, uniformName, …) — both need the
  // input AND its "-v" readout. `roadSlider` is counted here on purpose: the
  // road-look controls moved onto it when they were rebound by NAME instead of
  // by uniform object, and a regex that only knew `slider(` silently stopped
  // checking two dozen ids the moment they were converted.
  const sliders = [...SRC.matchAll(/\b(?:road)?[sS]lider\(\s*"([\w-]+)"/g)].map((m) => m[1]);
  const missing = sliders.filter((id) => !ids.has(id));
  const noReadout = sliders.filter((id) => ids.has(id) && !ids.has(`${id}-v`));
  console.log(`  ${sliders.length} sliders wired`);
  check("every slider() id exists in the markup", missing.length === 0, missing.join(", ") || "all present");
  check("every slider has its -v readout span", noReadout.length === 0,
    noReadout.join(", ") || "all present");

  // Colour inputs: colorUniform(id, uniform) and roadColor(id, uniformName).
  // No "-v" readout — the swatch itself is the readout.
  const colors = [...SRC.matchAll(/\b(?:colorUniform|roadColor)\(\s*"([\w-]+)"/g)].map((m) => m[1]);
  const cMissing = colors.filter((id) => !ids.has(id));
  console.log(`  ${colors.length} colour inputs wired`);
  check("every colour input id exists in the markup", cMissing.length === 0,
    cMissing.join(", ") || "all present");

  // The negative lookbehind matters: `classList.toggle("collapsed", …)` is all
  // over this file and would otherwise be read as a control wired to an id
  // called "collapsed".
  const toggles = [...SRC.matchAll(/(?<![.\w])toggle\(\s*"([\w-]+)"/g)].map((m) => m[1]);
  const tMissing = toggles.filter((id) => !ids.has(id));
  console.log(`  ${toggles.length} toggles wired`);
  check("every toggle() id exists in the markup", tMissing.length === 0,
    tMissing.join(", ") || "all present");

  /* ROAD-LOOK CONTROLS MUST RESOLVE THEIR UNIFORM PER EVENT.
   *
   * The deck material is REPLACED whenever wetness, anisotropy, grit or line
   * relief crosses zero, and the replacement carries a fresh uniform() bag. A
   * control that captured the old uniform object writes into a material nobody
   * renders: the knob goes dead and the next re-sync snaps the edit back.
   * `game.roadUniforms` is a getter for exactly this reason, so reading it once
   * into a local and handing the members out defeats it.
   */
  // Checked against CODE, not prose: the comments above these bindings quote the
  // old snapshotting form to explain why it was wrong, and a raw search of the
  // file would fail on the note documenting the fix.
  const CODE = SRC
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  check("road-look controls do not snapshot the uniform bag",
    !/const\s+ru\s*=\s*game\.roadUniforms/.test(CODE),
    "`const ru = game.roadUniforms` captures one material's uniforms");
  check("nothing reaches around the getter into the material",
    !/game\.roadMaterial\??\.\s*_roadUniforms/.test(CODE),
    "use game.roadUniforms (a getter) so the binding follows a rebuild");
  // Every road control goes through the by-name helpers, which re-resolve on
  // each event and attach their listener exactly once.
  const byName = [...SRC.matchAll(/\broad(?:Slider|Color)\(\s*"([\w-]+)"/g)].length;
  check("the road-look controls are bound by name", byName >= 25, `${byName} bound`);

  // Duplicate ids: querySelector takes the first, so the second control is dead.
  const all = [...SRC.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]);
  const dupes = [...new Set(all.filter((v, i) => all.indexOf(v) !== i))];
  check("no duplicate element ids", dupes.length === 0, dupes.join(", ") || "clean");
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
