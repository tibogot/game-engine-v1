// Scene list search matching (v3/ui/sceneOutliner.js, v3/AUDIT.md #92):
// case-insensitive, every typed word must appear, in any order.
import { outlinerMatches } from "../v3/ui/sceneOutliner.js";

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) fail++;
};

check("empty search matches everything", outlinerMatches("Cube #3", ""));
check("case does not matter", outlinerMatches("Street Lamp #12", "street lamp"));
check("a part of a word matches", outlinerMatches("Tunnels & caves", "cav"));
check("every word must appear", outlinerMatches("Cube #3", "cube #3") && !outlinerMatches("Cube #4", "cube #3"));
check("words match in any order", outlinerMatches("Street Lamp #12", "#12 lamp"));
check("extra spaces are ignored", outlinerMatches("Lake 1", "  lake   1 "));
check("a miss is a miss", !outlinerMatches("River 2", "lake"));

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
