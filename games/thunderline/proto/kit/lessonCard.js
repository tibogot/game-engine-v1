// A STUNT LESSON (user, 2026-10-22): the card first (the game waits), the goal judged at the finish.
// Shared by the drive page and the shell's play mode (2026-10-28): attach it to a run, dispose it when the
// run is left (the shell stays loaded, so the card, its keys and its timer must go with the run).
import { lessons } from "../../app/library.js";

const CSS = `
  #lesson { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(460px, calc(100vw - 32px)); z-index: 70;
    background: rgba(8, 11, 18, 0.95); border: 1px solid #23304d; border-top: 3px solid #3fd2ff; color: #dbe4f5; padding: 18px 20px 16px;
    font: 500 15px/1.5 "Barlow", system-ui, sans-serif; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5); }
  #lesson .k { font: 700 12px "Barlow Condensed", sans-serif; letter-spacing: 0.12em; text-transform: uppercase; color: #3fd2ff; }
  #lesson h2 { margin: 4px 0 8px; font: 800 30px "Barlow Condensed", sans-serif; text-transform: uppercase; color: #fff; }
  #lesson .goal { margin: 10px 0 0; color: #8796b5; font-size: 14px; }
  #lesson kbd { font: 600 12px "Barlow Condensed", sans-serif; border: 1px solid #3a4a6b; padding: 0 5px; color: #fff; }
  #lesson button { margin-top: 14px; background: none; border: 1px solid #3fd2ff; color: #3fd2ff; padding: 7px 16px; cursor: pointer;
    font: 700 15px "Barlow Condensed", sans-serif; letter-spacing: 0.08em; text-transform: uppercase; }
  #lessonVerdict { position: fixed; left: 50%; top: 130px; transform: translateX(-50%); z-index: 65; padding: 10px 18px; background: rgba(8, 11, 18, 0.92);
    border-left: 3px solid #3fd2ff; color: #fff; font: 800 24px "Barlow Condensed", sans-serif; letter-spacing: 0.05em; text-transform: uppercase; }
  #lessonVerdict.no { border-left-color: #ff4d5e; }
  #lessonVerdict small { display: block; font: 600 14px "Barlow", sans-serif; letter-spacing: 0; text-transform: none; color: #8796b5; }`;

/**
 * Show a lesson's card over a run and judge its goal at the finish.
 * @param rig  the drive rig (createDriveRig), already started on the lesson's track
 * @param campaignRec  the lesson's campaign record (its `lesson`: { how, goal })
 * @param nextCampaign  the next record, or null (named in the verdict)
 * @returns {() => void} dispose: removes the card, the verdict, the keys and the judge
 */
export function attachLesson(rig, campaignRec, nextCampaign) {
  const lesson = campaignRec?.lesson;
  if (!lesson) return () => {};
  try { sessionStorage.setItem("thunderline.playTab", "lessons"); } catch {} // the menu comes back to the lessons
  if (!document.getElementById("lessonCss")) {
    const st = document.createElement("style");
    st.id = "lessonCss";
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  const need = lesson.goal?.perfect ?? 0;
  const goalText = need ? `Goal: reach the finish with ${need > 1 ? `${need} perfect landings` : "a perfect landing"}.` : "Goal: reach the finish.";
  const card = document.createElement("div");
  card.id = "lesson";
  card.innerHTML = `<div class="k">Stunt lesson · ${campaignRec.id.split("-")[1]}</div><h2>${campaignRec.name.replace(/^\d+\.\s*/, "")}</h2><div>${lesson.how}</div><div class="goal">${goalText} <kbd>R</kbd> restarts · <kbd>I</kbd> shows this card again.</div><button>Go ▶ <kbd>Enter</kbd></button>`;
  document.body.appendChild(card);
  const verdict = document.createElement("div");
  verdict.id = "lessonVerdict";
  verdict.style.display = "none";
  document.body.appendChild(verdict);
  let judged = false;
  const showCard = () => { card.style.display = ""; rig.setTimeScale(0); };
  const go = () => { card.style.display = "none"; verdict.style.display = "none"; rig.setTimeScale(1); rig.restart(); judged = false; };
  card.querySelector("button").onclick = go;
  const onKey = (e) => {
    if (e.code === "Enter" && card.style.display !== "none") { e.preventDefault(); go(); }
    else if (e.code === "KeyI" && card.style.display === "none") showCard();
    else if (e.code === "KeyR") { verdict.style.display = "none"; judged = false; }
  };
  addEventListener("keydown", onKey);
  showCard();
  // the goal, judged once per run when the race finishes: the finish, and the perfect landings
  const timer = setInterval(() => {
    const S = rig.session;
    if (!S) return;
    if (S.race.s.state !== "finished") { if (S.race.s.state === "countdown") judged = false; return; }
    if (judged) return;
    judged = true;
    const perfect = S.landings.filter((l) => l.grade === "perfect").length;
    const ok = perfect >= need;
    if (ok) lessons.markPassed(campaignRec.id);
    verdict.className = ok ? "" : "no";
    verdict.innerHTML = ok
      ? `Lesson passed ✓<small>${nextCampaign ? `Next: ${nextCampaign.name} (N)` : "That was the last lesson — on to the campaign"}</small>`
      : `Not yet<small>${need ? `${perfect} perfect landing${perfect === 1 ? "" : "s"} of ${need} — land with the wheels flat. ` : ""}R to try again, I for the card</small>`;
    verdict.style.display = "";
  }, 200);
  return () => {
    clearInterval(timer);
    removeEventListener("keydown", onKey);
    card.remove();
    verdict.remove();
    rig.setTimeScale(1);
  };
}
