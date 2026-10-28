// WHERE THE GAME GOES (2026-10-28, ONE ALWAYS-LOADED PAGE — user: "the track builder is still long to load …
// my old car game, opening the track builder was super quick"). The old game is one page where building is a
// MODE; Thunderline was three pages (menu, builder, drive), and every switch booted the engine again (2.5 s
// warm, 7 s after a browser start: shaders, scripts, the scene).
//
// Every "go to …" in the game comes through here. Inside THE SHELL (index.html → the builder page in shell
// mode, the menu over it in a frame) the shell switches modes in place: nothing reloads. Anywhere else (a
// page opened on its own: drive.html for the tests, the builder alone, the menu alone) it navigates as before.
//
//   go({ to: "menu", screen: "build" })            the menu, on a screen (home, play, build, settings)
//   go({ to: "build", id, tutorial })              the builder, on a library track
//   go({ to: "drive", id, from: "builder" })       drive a library track (from the builder's list: Back = builder)
//   go({ to: "campaign", id })                     drive a campaign track or a lesson
import { PAGES, builderUrl, driveUrl, campaignUrl } from "./library.js";

/** The shell's handle, when this page is the shell or sits in its menu frame; else null. */
export function shell() {
  try {
    if (window.__thunderShell) return window.__thunderShell;
    if (window.parent !== window && window.parent.__thunderShell) return window.parent.__thunderShell;
  } catch {} // (a frame from elsewhere: no shell)
  return null;
}

/** The URL a destination has as its own page (outside the shell). */
export function urlOf(w) {
  if (w.to === "menu") return `${PAGES.menu}${w.screen ? `#${w.screen}` : ""}`;
  if (w.to === "build") return `${builderUrl(w.id)}${w.tutorial ? "&tutorial=1" : ""}`;
  if (w.to === "drive") return driveUrl(w.id, w.from);
  if (w.to === "campaign") return campaignUrl(w.id);
  throw new Error(`nav: no destination ${w.to}`);
}

/** Go there: in place inside the shell, by navigating outside it. */
export function go(w) {
  const s = shell();
  if (s) return s.go(w);
  location.href = urlOf(w);
}
