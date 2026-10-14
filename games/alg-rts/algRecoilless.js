// THE FLN'S RECOILLESS RIFLE (2026-10-13, A2 — its tank-killer: the army of the borders' 57 and 75 mm SR).
// A team of two (algSquads `sansRecul`): the gunner with the M18 57 mm (procWeapons sr57), the loader a
// rifle. The gun is a direct-fire SHELL (its type's weapon "cannon": projectiles marks it a shell, so
// algArmour's shell table applies — it goes through a half-track's side and an AMX-13's rear), slow to
// reload, weak against men (`footMul`, shared combat.js). This module:
//   AIMS      stopped, the gunner needs ~1.5 s on his knee before he can fire (`deploy`: combat holds
//             his fire until 1); moving resets it — it is fired from a halt, never on the run.
//   KNEELS    the gunner (and his loader beside him) while set.
//   BACK-BLAST every shot throws dust and smoke out BEHIND the tube — the team's giveaway.

export const RECOILLESS = { key: "sansRecul", aim: 1.5, blastBack: 2.4 };
const P = RECOILLESS;

export function createAlgRecoilless(app, { squads }) {
  const teams = () => squads.list.filter((s) => s.typeKey === P.key && s.members.length);
  const gunnerOf = (s) => s.slots.find((u) => u?.alive && u.weapon === "cannon") ?? null;

  function step(dt) {
    for (const s of teams()) {
      const g = gunnerOf(s);
      if (!g) continue;
      if (g.isMoving || s.retreating) g.deploy = 0;
      else g.deploy = Math.min(1, (g.deploy ?? 0) + dt / P.aim);
      // On his knee to aim (after the posture system's step: it rewrites postures each tick).
      if (!g.isMoving && !s.retreating && g.posture !== "prone") {
        g.posture = "kneel";
        for (const u of s.members) if (u !== g && !u.isMoving && u.posture !== "prone") u.posture = "kneel";
      }
    }
  }

  /** combat's onShot: a recoilless shot — the back-blast behind the gunner (the faoudj's bazooka too:
   *  any man on foot firing a shell). */
  function onShot(e) {
    if (e.weapon !== "cannon" || !e.type?.foot) return;
    const h = e.heading ?? 0, bx = e.position.x - Math.sin(h) * P.blastBack, bz = e.position.z - Math.cos(h) * P.blastBack;
    const y = app.getWorldHeight?.(bx, bz) ?? e.position.y;
    const fx = app.algCombat?.fx;
    fx?.dirt?.(bx, y, bz, 2.2);
    fx?.dirt?.(bx - Math.sin(h) * 1.5, y, bz - Math.cos(h) * 1.5, 1.6);
  }

  return { params: P, step, onShot };
}
