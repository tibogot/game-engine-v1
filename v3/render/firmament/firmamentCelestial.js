// FIRMAMENT — the sun and the moon in the sky: where they are for a time, a date, a latitude, and how
// much of the moon is lit. Simple astronomy, good to a degree or so (no equation of time, no lunar
// inclination or parallax): what a game sky needs, not an ephemeris.
//
// Frame: +x east, -z north, +y up (Tidewater's, = the engine's). Time is LOCAL SOLAR time (12 h = the
// sun due south/north at its highest), so longitude and time zones never come into it.
//
// Public:
//   sunDirection( { hours, dayOfYear, latitude }, out )                    -> out (unit Vector3)
//   moonDirection( { hours, dayOfYear, latitude, moonAge }, out )          -> out
//   moonIllumination( sunDir, moonDir )  -> 0..1, the lit fraction of the disc (0 new, 1 full)
//   moonPhaseName( moonAge )             -> "new" | "waxing crescent" | … (for a UI)
//   SYNODIC_MONTH                        29.53 days

const DEG = Math.PI / 180;
const OBLIQUITY = 23.44 * DEG;
export const SYNODIC_MONTH = 29.530589;

/** The sun's ecliptic longitude (rad) on a day of the year: 0 at the March equinox (~day 80). */
function sunLongitude(dayOfYear) {
  return 2 * Math.PI * (dayOfYear - 80) / 365.2422;
}

/** Right ascension and declination (rad) of a point on the ecliptic (latitude 0) at longitude lambda. */
function eclipticToEquatorial(lambda) {
  const s = Math.sin(lambda), c = Math.cos(lambda);
  return {
    ra: Math.atan2(Math.cos(OBLIQUITY) * s, c),
    dec: Math.asin(Math.sin(OBLIQUITY) * s),
  };
}

/** A direction from an hour angle H (rad, 0 = on the meridian, + = west) and a declination, at latitude phi. */
function horizonDirection(H, dec, phi, out) {
  const east = -Math.cos(dec) * Math.sin(H);
  const north = Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(H);
  const up = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
  return out.set(east, up, -north).normalize();
}

/**
 * The sun's direction. hours = local solar time (0..24), dayOfYear 1..365, latitude in degrees (+ north).
 * Tidewater's fixed path is latitude 24 with a 6° declination (~day 96, early April).
 */
export function sunDirection({ hours, dayOfYear = 96, latitude = 24 }, out) {
  const { dec } = eclipticToEquatorial(sunLongitude(dayOfYear));
  return horizonDirection((hours - 12) * 15 * DEG, dec, latitude * DEG, out);
}

/**
 * The moon's direction. moonAge = days since the new moon (0..29.53): 0 = new (with the sun),
 * ~7.4 = first quarter (90° east of the sun: up in the afternoon, sets near midnight), ~14.8 = full
 * (opposite the sun: rises at sunset), ~22.1 = last quarter. On the ecliptic (its 5° tilt ignored).
 */
export function moonDirection({ hours, dayOfYear = 96, latitude = 24, moonAge = 14.8 }, out) {
  const ls = sunLongitude(dayOfYear);
  const lm = ls + 2 * Math.PI * (moonAge / SYNODIC_MONTH);
  const sun = eclipticToEquatorial(ls), moon = eclipticToEquatorial(lm);
  // the moon's hour angle = the sun's, minus how far east of the sun it stands in right ascension
  const H = (hours - 12) * 15 * DEG - (moon.ra - sun.ra);
  return horizonDirection(H, moon.dec, latitude * DEG, out);
}

/** The lit fraction of the moon's disc for these directions: (1 - cos elongation) / 2. */
export function moonIllumination(sunDir, moonDir) {
  const c = Math.max(-1, Math.min(1, sunDir.x * moonDir.x + sunDir.y * moonDir.y + sunDir.z * moonDir.z));
  return (1 - c) / 2;
}

const PHASES = ["new", "waxing crescent", "first quarter", "waxing gibbous", "full", "waning gibbous", "last quarter", "waning crescent"];
/** A phase name for a moon age (days). */
export function moonPhaseName(moonAge) {
  const k = ((moonAge / SYNODIC_MONTH) % 1 + 1) % 1;
  return PHASES[Math.round(k * 8) % 8];
}
