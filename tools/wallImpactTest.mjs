// ============================================================================
// A CAR IS NOT A PINBALL — assertions on what a solid contact does to the car.
//
// The other collision suites are all safety: did it go through, did it launch,
// is it stuck. Every one of them passed while the car bounced off barriers like
// a ball, because none of them ever asked how much speed came BACK. This one
// does, over an angle × speed matrix against a plain flat wall.
//
// The numbers in the comments are measured, and the "before" column is the
// centre-of-mass response this replaced (see the impulse block in
// _applySolidContact). Run tools/wallImpactProbe.mjs for the full tables.
//
// Run:  node tools/wallImpactTest.mjs
// ============================================================================
import { buildWallScene, runMatrix } from "./wallImpactProbe.mjs";

let fail = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) fail++;
};

const track = buildWallScene();
const planted = runMatrix(track, { planted: true });
const air = runMatrix(track, { planted: false });
const all = [...planted, ...air];
const max = (rows, f) => Math.max(...rows.map(f));
const avg = (rows, f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;

console.log(`=== ${all.length} impacts, 10°–90° at 12–55 m/s, on wheels and airborne ===\n`);

// ── THE PINBALL NUMBER ──────────────────────────────────────────────────────
// Speed gained back along the wall's own normal. A ball returns restitution ×
// the closing speed; a car's bodywork absorbs the hit and it returns almost
// nothing. BEFORE: 23.7 m/s — a 55 m/s head-on came off the wall at 80 km/h,
// and that single number is the whole "it hits like a flipper ball" report.
{
  const worst = max(all, (r) => r.rebound);
  check("nothing rebounds off a wall like a ball", worst <= 8,
    `worst ${worst.toFixed(1)} m/s off a 55 m/s impact (was 23.7)`);
}

// ── ENERGY ──────────────────────────────────────────────────────────────────
// A passive contact can only ever remove energy. Above 1 means the collider is
// a spring, which is how the penetration-spring model used to launch cars.
// Linear + rotational, so moving the hit into spin does not hide a gain.
{
  const worst = max(all, (r) => r.energyRatio);
  check("no contact ever ADDS energy", worst <= 1.02,
    `worst out/in ${worst.toFixed(2)}`);
}

// ── A GLANCING BLOW IS NOT A BRICK WALL ─────────────────────────────────────
// The thing a correct impulse buys that a centre-of-mass one cannot: a hit away
// from the centre of mass spins the car instead of stopping it, so clipping a
// barrier costs you a little speed and a lot of line — not the whole corner.
{
  const glance = all.filter((r) => r.angleDeg <= 20);
  const keep = avg(glance, (r) => r.exitRatio);
  check("a glancing clip keeps most of its speed", keep >= 0.8,
    `${(keep * 100).toFixed(0)}% kept over ${glance.length} glancing hits`);
}

// ── A HEAD-ON IS STILL A WALL ───────────────────────────────────────────────
// The other half, and the reason restitution is not simply set to zero: driving
// square into a barrier has to stop you. It must not stop you and then throw
// you back, which is what the two checks together pin down.
{
  const headOn = all.filter((r) => r.angleDeg === 90);
  const keep = avg(headOn, (r) => r.exitRatio);
  check("a square head-on still stops the car", keep <= 0.25,
    `${(keep * 100).toFixed(0)}% kept over ${headOn.length} head-on hits`);
}

// ── THE HIT TURNS THE CAR ───────────────────────────────────────────────────
// Where the energy goes instead of into a rebound. Before the rewrite a hard
// impact produced 0.15–0.47 rad/s of roll (see crashYieldTest) because rotation
// was a separate, deliberately tiny budget rather than part of the impulse.
{
  const hard = all.filter((r) => r.speed >= 40 && r.angleDeg >= 30 && r.angleDeg < 90);
  const spun = hard.filter((r) => r.yaw > 1 || r.roll > 1).length;
  check("a hard off-centre hit throws the car around instead of stopping it",
    spun === hard.length, `${spun}/${hard.length} hits produced real rotation`);
}

// ── NOTHING WINDS UP ────────────────────────────────────────────────────────
// A scrape is a contact every substep, so a per-contact cap bounds nothing over
// a sustained rub. The ceiling is on the resulting RATE — see the spin ceiling
// in _applySolidContact. CRASH.tripMaxRate (8.5) is the real ceiling once a
// crash is armed, and the trip-over is allowed to reach it.
{
  const worstYaw = max(all, (r) => r.yaw);
  const worstRoll = max(all, (r) => r.roll);
  check("and no contact winds the car past the trip ceiling",
    worstYaw <= 9.5 && worstRoll <= 9.5,
    `peak yaw ${worstYaw.toFixed(2)}, peak roll ${worstRoll.toFixed(2)} rad/s`);
}

console.log(fail ? `\n${fail} check(s) failed` : "\nall green");
process.exit(fail ? 1 : 0);
