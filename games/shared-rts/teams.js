// Teams — GAME code. One place that decides what a side LOOKS like.
//
// The rule that matters for performance: a team must NEVER fork a material.
// Instancing keys on the material, so if enemy jeeps got their own red material
// they'd become a second instanced draw — and a third faction a third, per unit
// type, per part. Instead a team is a per-instance TINT: same geometry, same
// material, one draw call for every jeep on the map regardless of who owns it.
//
// The tint MULTIPLIES the model's own color and texture (that's how three folds
// `instanceColor` into the shader), so it can only darken/shift a model, never
// brighten it. Keep the player at white — the models are authored as friendly.
import * as THREE from "three";

export const TEAM_TINT = {
  player: new THREE.Color(0xffffff), // as authored
  enemy: new THREE.Color(0xff5a4a),  // warm red wash
  neutral: new THREE.Color(0xb9b2a6),
};

const _white = TEAM_TINT.player;

/**
 * The tint for a team (unknown teams render untinted rather than vanishing).
 *
 * `type.nativeTeam` says a model is already painted for a side — the PT-76 is
 * the Front's own tank, in their khaki with their hull number — and that side
 * gets no wash: tinting it red would paint it twice and lose the model. It is
 * still read as theirs by the red health bar and selection ring.
 */
export function teamTint(team, type = null) {
  if (type?.nativeTeam && type.nativeTeam === team) return _white;
  return TEAM_TINT[team] ?? _white;
}

/**
 * THE HUMAN'S SIDE (2026-10-10, alg-rts "play the FLN"). The team strings stay the FACTIONS
 * ("player" = the French, "enemy" = the FLN in alg-rts) for the economy, the AI, production; who
 * the person at the keyboard COMMANDS is `SIDES.human` — "player" by default, so every game works
 * as before. Selection, the fog of war, "yours" vs "hostile" colours ask these, not the strings.
 */
export const SIDES = { human: "player" };
export function setHumanSide(team) { SIDES.human = team === "enemy" ? "enemy" : "player"; }
/** The human's team. */
export const isHuman = (team) => team === SIDES.human;
/** A FACTION that is not the human's — never the civilians ("civil") or a neutral. */
export const isHostile = (team) => (team === "player" || team === "enemy") && team !== SIDES.human;
/** The other faction (the AI's, the one "hostile" colours and fogs mean). */
export const hostileSide = () => (SIDES.human === "player" ? "enemy" : "player");

/** True when a team needs no tinting at all — lets us skip per-unit material clones. */
export function isUntinted(team, type = null) {
  return teamTint(team, type).equals(_white);
}
