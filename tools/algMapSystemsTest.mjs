// alg-rts WHAT EACH MAP SHOWS (games/alg-rts/mapSystems.js, 2026-10-12): every map lists its
// systems, the rest off. The cleanup changed HOW, not WHAT — this pins the two maps people play:
//   1. the Aurès lists them all: nothing switched off (no `key=0` in its address);
//   2. the training switches off EXACTLY its old seven, in the same order (landmarks fields herds hens poles ai fow —
//      VILLAGE LIFE on since 2026-10-24: the Blender village props in its practice hamlet);
//   3. every map's list names known switches only (a typo would silently leave one off);
//   4. the coast keeps its battle (the FLN's AI, the fog of war).
import * as aures from "../games/alg-rts/maps/aures.js";
import * as training from "../games/alg-rts/maps/training.js";
import * as coast from "../games/alg-rts/maps/coast.js";
import { SYSTEM_KEYS, systemsOff } from "../games/alg-rts/mapSystems.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
  if (!ok) fail++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check("the Aurès: nothing off", same(systemsOff(aures.MAP), []), JSON.stringify(systemsOff(aures.MAP)));
const OLD_TRAINING_OFF = ["landmarks", "fields", "herds", "hens", "poles", "ai", "fow"];
check("the training: its old seven, same order", same(systemsOff(training.MAP), OLD_TRAINING_OFF), JSON.stringify(systemsOff(training.MAP)));
for (const [name, m] of Object.entries({ aures, training, coast })) {
  const unknown = Object.keys(m.MAP.systems ?? {}).filter((k) => !SYSTEM_KEYS.includes(k));
  check(`${name}: only known switches`, !unknown.length, unknown.join(", "));
  check(`${name}: lists its systems`, !!m.MAP.systems);
}
const coastOff = systemsOff(coast.MAP);
check("the coast: its AI and fog of war on", !coastOff.includes("ai") && !coastOff.includes("fow"), JSON.stringify(coastOff));

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
