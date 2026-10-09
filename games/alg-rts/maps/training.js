// THE TRAINING MAP — CAMP D'INSTRUCTION (2026-10-09, you: "a first mission that teaches the
// basics, on another terrain, smaller, simple — aerial grass, aerial rock"). ?map=training.
//
// World metres, north up = -Z. The map (public/levels/alg-training.v3proj, built by
// tools/algTrainingLevel.mjs from these very sites and track): a near-flat green plain of
// 330 m with gentle swells, one knoll (the high-ground lesson), hills framing it outside the
// box. The post in the south, the practice hamlet in the middle, a supply depot on the track,
// the FLN's ground in the north. Small and readable: everything a lesson needs is on screen.
import { t } from "../i18n/i18n.js";

/** THE PLAYABLE AREA: 330 m. Outside: the framing hills. */
export const PLAY = { x0: -165, x1: 165, z0: -170, z1: 165 };

export const LAYOUT = {
  sites: [
    // ── Starts ────────────────────────────────────────────────────────────────
    { kind: "french", name: t("Camp d'instruction"), x: 0, z: 118, r: 34, turn: 30 },
    { kind: "aln", name: t("Bande du FLN"), x: 10, z: -140, r: 22, turn: -30 },
    // ── The lessons' ground ──────────────────────────────────────────────────
    // The practice hamlet: the capture lesson, then the final defence.
    { kind: "hamlet", name: t("Mechta d'exercice"), x: -40, z: -12, r: 38, turn: 35 },
  ],
  wadis: [],
};

/** The track: the post's gate north to the hamlet and on toward the FLN's ground (algTracks resamples it). */
const TRACK = [[2, 98], [6, 70], [-4, 40], [-20, 14], [-26, -6], [-14, -46], [2, -86], [8, -120]];

export const MAP = {
  id: "training",
  name: t("Camp d'instruction — 1956"),
  level: "/levels/alg-training.v3proj",
  tracks: [{ name: t("Piste du camp"), kind: "piste", from: "gate", to: t("Mechta d'exercice"), length: 230, points: TRACK }],
  // One supply depot beside the track: the "points pay" lesson.
  supply: [{ name: t("Dépôt de munitions"), x: 48, z: 36, res: "mun" }],
  handPlaced: false,
  // THE TRAINING (algTutorial.js): the lessons run instead of the FLN's AI and the win rules.
  tutorial: true,
  // The knoll (the high-ground / cover lesson), as the level tool raises it.
  knoll: { x: 70, z: -58, r: 30, h: 5 },
  // A FARMSTEAD west of the track (algGame.js places it; algCivilians puts its "shepherd" there —
  // the moussebel of the shepherd's lesson). `turn`: off the camera's three-quarter view.
  farmsteads: [{ x: -58, z: 64, turn: 0.5 }],
};
