// Key hints that name the key the player ACTUALLY has under their finger.
//
// Every shortcut in this game is bound by `e.code` — physical position — which
// is right, and is why WASD lands on the same three-finger cluster on every
// keyboard in the world. But `e.code` is NAMED for US QWERTY, so on any other
// layout the printed letter differs and a hardcoded hint is simply wrong.
// AZERTY is the case that bites: `KeyZ` is the key printed **W**, and the key
// printed **Z** is `KeyW` — the THROTTLE. So "Z/X roll" was telling an AZERTY
// player to press the gas to roll left. QWERTZ has the same problem one key
// over (Z is printed Y), and every layout moves the digits and brackets.
//
// `navigator.keyboard.getLayoutMap()` maps code → printed label, so a hint can
// just tell the truth. Chromium-only; everywhere else the markup's own QWERTY
// text stands, which is exactly the old behaviour.
//
// Two things are deliberately NOT annotated.
//
// A shortcut bound by `e.key` rather than by code — Ctrl+Z / Ctrl+Y undo, which
// follow the printed label on purpose so that "press Ctrl+Z" means the same
// thing on every layout. Those are already right as written, and relabelling
// them would make them wrong.
//
// And the DIGIT row, even though it is `e.code`-bound like everything else. A
// letter key prints exactly one label, so on AZERTY the QWERTY name is simply a
// lie; a digit key prints the digit AND the symbol above it, so "1" is still a
// true, and far more readable, name for `Digit1` than the "&" the layout map
// returns. "1–4 angles" beats "&–' angles". Brackets go the other way and ARE
// annotated: AZERTY does not print [ or ] on those keys at all.

/**
 * Rewrite every `[data-keys]` element under `root` to the labels this keyboard
 * actually prints. `data-keys` is a comma-separated list of KeyboardEvent codes
 * ("KeyW,KeyA,KeyS,KeyD"); the element's text is replaced by their labels,
 * joined. Safe to call more than once and safe to call on markup that has no
 * annotations at all.
 *
 * @param {ParentNode} [root] where to look; defaults to the whole document
 * @returns {Promise<boolean>} whether anything was relabelled
 */
export async function relabelKeys(root = document) {
  try {
    const map = await navigator.keyboard?.getLayoutMap?.();
    if (!map) return false;
    let any = false;
    for (const el of root.querySelectorAll("[data-keys]")) {
      const labels = el.dataset.keys.split(",").map((c) => map.get(c.trim())?.toUpperCase());
      // All or nothing — a half-translated "WASD" would be worse than none.
      if (labels.some((l) => !l)) continue;
      const next = labels.join("");
      if (el.textContent === next) continue;
      el.textContent = next;
      any = true;
    }
    return any;
  } catch {
    return false; // layout API unavailable or blocked — keep the QWERTY labels
  }
}
