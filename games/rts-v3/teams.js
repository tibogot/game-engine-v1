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

/** The tint for a team (unknown teams render untinted rather than vanishing). */
export function teamTint(team) {
  return TEAM_TINT[team] ?? _white;
}

/** True when a team needs no tinting at all — lets us skip per-unit material clones. */
export function isUntinted(team) {
  return teamTint(team).equals(_white);
}
