// THE MAP IN PLAY — one layout per map (maps/*.js: where each side starts,
// what there is to fight over, the play box, the level file), picked by
// ?map= (2026-10-04, mission 2). No ?map — and the map tools, in Node — get
// the Aurès, exactly as before.
//
// Everything that reads the map imports it from HERE, so the game, the tools
// and the labs all see the same one: PLAY, LAYOUT, MAP, and the view and site
// helpers below (the same rules on every map).
import * as aures from "./maps/aures.js";
import * as coast from "./maps/coast.js";

const MAPS = { aures, coast };
const asked = typeof location !== "undefined" ? new URLSearchParams(location.search).get("map") : null;
if (asked && !MAPS[asked]) console.warn(`[alg] no map "${asked}" — the Aurès (maps: ${Object.keys(MAPS).join(", ")})`);
const M = MAPS[asked] ?? aures;

export const { PLAY, LAYOUT, MAP } = M;

const _fr = LAYOUT.sites.find((s) => s.kind === "french");
const _aln = LAYOUT.sites.find((s) => s.kind === "aln");
/**
 * THE VIEW: the player's camera looks from the French base toward the ALN
 * (forward = (sin VIEW_YAW, cos VIEW_YAW)). A kit building's front is its
 * local -Z, which at yaw = VIEW_YAW points straight back at the camera.
 *
 * BUILDINGS TURN THEIR FRONTS TOWARD THE CAMERA, AT THREE-QUARTERS (your
 * rule, 2026-09-26, the Company of Heroes way): a front that matters (a gate,
 * a door, the good-looking side) is turned more toward the camera than away,
 * but ~25-45 deg off it — front and one side visible at once. Square-on
 * looks flat and staged; facing away shows back walls. Each site says its
 * own `turn` (degrees off the camera), so they do not all match.
 */
export const VIEW_YAW = Math.atan2(_aln.x - _fr.x, _aln.z - _fr.z);

/** A site's building yaw: the camera-facing yaw turned by its `turn` degrees. */
export const siteYaw = (site) => VIEW_YAW + ((site.turn ?? 30) * Math.PI) / 180;

/**
 * Where a site is HELD from: its centre, or — a ksar — its souk, `souk`
 * metres down the site's front (local -Z, toward the camera).
 */
export function sitePoint(site) {
  if (!site.souk) return { x: site.x, z: site.z };
  const y = siteYaw(site);
  return { x: site.x - site.souk * Math.sin(y), z: site.z - site.souk * Math.cos(y) };
}
