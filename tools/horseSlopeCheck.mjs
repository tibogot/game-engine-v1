// HORSE SLOPE CHECK: how the horse's legs do on the steppe-rider course's ramps, against limits.
// Run it after ANY change to the horse's legs (horse.js IK, clips, postures): a change that helps one
// slope used to break another and nobody saw it until riding there (LEG_IK_PLAN.md, 2026-10-24).
//
// Not a *Test.mjs suite (npm test is Node only): it needs the game in a real Chrome (WebGPU).
//   node tools/horseSlopeCheck.mjs --port 9471 [--url http://localhost:5191/games/steppe-rider/index.html]
//        [--cases flat,down10] [--hp '{"legUpright":1}']
// --port: a Chrome started with --remote-debugging-port (your OWN debug Chrome, never a shared one).
// Its first page is navigated to the game. ~1 min per case (fixed 1/60 s steps, 4 stride phases).
// The probe itself: games/steppe-rider/slopeProbe.js.
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const PORT = +arg("port", process.env.CDP_PORT ?? 9222);
const URL0 = arg("url", "http://localhost:5180/games/steppe-rider/index.html");
const cases = arg("cases", null)?.split(",");
const hp = JSON.parse(arg("hp", "{}"));

// The limits: what the legs must stay within. Flat ground is the yardstick (hang p95 1.7 cm, planted
// knee p95 ~37°, stretch 0.90, stifle 125°).
const LIMITS = [
  ["front hang p95 (cm)", (r) => r.hang.p95, 4.5],
  ["front planted knee p95 (°)", (r) => r.knee.p95, 60],
  ["hind stretch max", (r) => r.hind.stretchMax, 0.95],
  ["hind stifle max (°)", (r) => r.hind.stifleMax, 150],
  ["sink into the ground (cm)", (r) => r.sink, 3.5],
  ["refused by the slope gate", (r) => r.refused, 0.1],   // (a ramp within the limits must be ridden, or the rest measured the wrong ground)
];

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json().catch(() => null);
const page = list?.find((t) => t.type === "page");
if (!page) { console.error(`no Chrome page on port ${PORT} (start one with --remote-debugging-port=${PORT})`); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalAsync = async (body) => {
  const r = await send("Runtime.evaluate", { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

await send("Page.bringToFront");   // (a hidden tab's frames are throttled: the run would crawl)
await send("Page.navigate", { url: URL0 });
await new Promise((r) => setTimeout(r, 1500));
const ready = await evalAsync(`for (let i = 0; i < 300 && !window.__STEPPE?.kit?.ctrl?.legs; i++) await new Promise((r) => setTimeout(r, 300)); await new Promise((r) => setTimeout(r, 1500)); return !!window.__STEPPE;`);
if (!ready) { console.error("the game did not come up at " + URL0); process.exit(2); }
console.log(`horse slope check — ${URL0}${Object.keys(hp).length ? "  hp " + JSON.stringify(hp) : ""}`);
const t0 = Date.now();
const res = await evalAsync(`const m = await import('/games/steppe-rider/slopeProbe.js'); return m.runSlopeProbe(${JSON.stringify({ ...(cases ? { cases } : {}), hp })});`);
ws.close();

let fails = 0;
const pad = (s, n) => String(s).padEnd(n);
console.log(pad("", 8) + LIMITS.map(([name, , lim]) => pad(`${name} ≤ ${lim}`, 32)).join(""));
for (const [c, r] of Object.entries(res)) {
  const cells = LIMITS.map(([, get, lim]) => { const v = get(r), bad = v === null || v > lim; if (bad) fails++; return pad(`${bad ? "FAIL" : "ok  "} ${v ?? "—"}`, 32); });
  console.log(pad(c, 8) + cells.join(""));
}
console.log(`\n(also: hind hoof vs hip median ${Object.entries(res).map(([c, r]) => `${c} ${r.hind.reach}°`).join(", ")})`);
console.log(fails ? `\n${fails} over the limits` : "\nall within the limits", `— ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(fails ? 1 : 0);
