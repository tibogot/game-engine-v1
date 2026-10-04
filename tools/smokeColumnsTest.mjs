/**
 * SHARED SMOKE SIGHT (games/shared-rts/smokeColumns.js): what alg-rts's smoke grenade means.
 * A full cloud blocks a line straight through it (combat.js holds fire above 0.6), a line
 * beside it or a cloud BEHIND the shooter blocks nothing, it blooms in and dies out, and the
 * same numbers come out every run (no particles, no clock).
 *
 *   node tools/smokeColumnsTest.mjs
 */
import { smokeOcclusion, stepSmokeColumns } from "../games/shared-rts/smokeColumns.js";
import { SMOKE } from "../games/alg-rts/algSmoke.js";

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  else { failed++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};
const BLIND = 0.6;   // combat.js SMOKE_BLIND
const cloud = (x, z, age) => ({
  alive: true, x, z, age, life: SMOKE.life, strength: 1,
  radius: SMOKE.radius, growth: SMOKE.growth, bloom: SMOKE.bloom, losOpacity: SMOKE.losOpacity,
});

const full = [cloud(0, 0, 6)];
const through = smokeOcclusion(full, -30, 0, 30, 0);
ok("a full cloud blinds a line straight through it", through >= BLIND, through.toFixed(2));
const beside = smokeOcclusion(full, -30, 30, 30, 30);
ok("a line 30 m beside it is clear", beside < 0.05, beside.toFixed(3));
const behind = smokeOcclusion(full, 20, 0, 60, 0);
ok("a cloud behind the shooter blocks nothing", behind < 0.05, behind.toFixed(3));
const rim = smokeOcclusion(full, -30, 9, 30, 9);
ok("near its rim it thins (no hard edge)", rim > 0.02 && rim < through, rim.toFixed(2));

const young = smokeOcclusion([cloud(0, 0, 0.2)], -30, 0, 30, 0);
ok("a canister just landed hides less than the bloomed cloud", young < through, `${young.toFixed(2)} < ${through.toFixed(2)}`);

const fading = [cloud(0, 0, 0)];
stepSmokeColumns(fading, SMOKE.life + 0.1);
ok("after its life the column is gone", !fading[0].alive && smokeOcclusion(fading, -30, 0, 30, 0) === 0);

ok("the same answer every time", smokeOcclusion(full, -30, 0, 30, 0) === through);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
