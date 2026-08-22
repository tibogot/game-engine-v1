// The seven-segment digit now writes only the segments that CHANGED. That is
// only safe if the resulting lit-set is identical to a full rewrite — a wrong
// glyph on the speedo is a visible bug, and the diff has an obvious trap:
// after invalidate() the DOM state is unknown and cannot be diffed against.
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register("./threeWebgpuHook.mjs", import.meta.url);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

// Minimal DOM: createSegmentDash only needs createElementNS + appendChild and a
// classList that records state.
let toggleCalls = 0;
const makeEl = () => {
  const cls = new Set();
  return {
    children: [],
    style: {},
    dataset: {},
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c),
      toggle: (c, on) => { toggleCalls++; if (on) cls.add(c); else cls.delete(c); return on; },
      _set: cls,
    },
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    remove() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    set textContent(_v) {}, get textContent() { return ""; },
  };
};
globalThis.document = {
  createElement: makeEl,
  createElementNS: makeEl,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};

const { createSegmentDash } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/segmentDash.js")).href);

const root = makeEl();
const dash = createSegmentDash(root);

// Reach a digit through the dash's own speed digits by driving `update` and
// reading the element class sets. Simpler: rebuild the same glyph table logic by
// exercising update() across every speed and comparing lit-sets to a reference
// built by forcing a full rewrite each time (via the digit's invalidate()).
const speeds = [];
for (let v = 0; v <= 999; v++) speeds.push(v);

// Snapshot every segment element's lit state after showing a value.
const snapshot = () => {
  const out = [];
  const walk = (el) => {
    if (el.classList?._set) out.push([...el.classList._set].sort().join(","));
    for (const c of el.children ?? []) walk(c);
  };
  walk(root);
  return out.join("|");
};

// 1) Incremental: drive straight through every value.
const incremental = [];
for (const v of speeds) {
  dash.update(0.016, { speedKmh: v, gearLabel: "3", rpm: 0.4, reverse: false, redline: 0.88 });
  incremental.push(snapshot());
}
const incrementalToggles = toggleCalls;

// 2) Reference: same values, but force a full rewrite before each by rebuilding
//    a fresh dash (guaranteed cold state) and showing only that value.
const reference = [];
for (const v of speeds) {
  toggleCalls = 0;
  const r2 = makeEl();
  const d2 = createSegmentDash(r2);
  d2.update(0.016, { speedKmh: v, gearLabel: "3", rpm: 0.4, reverse: false, redline: 0.88 });
  // snapshot r2 with the same walk
  const out = [];
  const walk = (el) => {
    if (el.classList?._set) out.push([...el.classList._set].sort().join(","));
    for (const c of el.children ?? []) walk(c);
  };
  walk(r2);
  reference.push(out.join("|"));
}

let mismatch = -1;
for (let i = 0; i < speeds.length; i++) {
  if (incremental[i] !== reference[i]) { mismatch = i; break; }
}
check("every value 0-999 renders identically to a cold full rewrite",
  mismatch === -1,
  mismatch === -1 ? `${speeds.length} values` : `first differs at ${speeds[mismatch]} km/h`);

check("the diff actually saved toggles", incrementalToggles < speeds.length * 7 * 3,
  `${incrementalToggles} toggles for ${speeds.length} values`);

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
