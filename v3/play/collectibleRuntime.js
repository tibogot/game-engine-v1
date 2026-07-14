/**
 * Play-mode collectible runtime.
 *
 * The visuals — spin, bob, magnet pull toward the player, pickup pop — all run on the GPU
 * (see props/collectibles.js). This module owns only the *game* side:
 *
 *   - which collectibles the player has touched (grid query, not a scan over every coin)
 *   - the counter HUD
 *   - the burst + ding
 *   - the onPickup hook games listen to
 *
 * Per frame it looks at the handful of grid cells around the player, so a world with 10,000 coins
 * costs the same as one with 10.
 */
import * as THREE from "three";

/** Extra reach for modes where the player is a vehicle rather than a person. */
const REACH_BONUS = {
  capsule: 0.0,
  char: 0.0,
  fox: 0.5,
  husky: 0.5,
  car: 1.5,
  stunt: 1.5,
  ball: 0.8,
  fly: 3.0,
};

/** Panel caps pickupRadius at 6; the grid query never needs to look further than that + reach. */
const MAX_PICKUP_RADIUS = 6;

const HUD_ICONS = {
  coin: "\u{1FA99}",
  heart: "❤️",
  key: "\u{1F511}",
};

export function createCollectibleRuntime({ field, burst, playSfx }) {
  /** kind → number picked up this session. */
  const counts = Object.create(null);
  const pickupListeners = new Set();
  const _pos = new THREE.Vector3();

  let active = false;
  let hudEl = null;
  let hudSig = "";
  let kindsPresent = [];

  function ensureHud() {
    if (hudEl) return hudEl;
    hudEl = document.createElement("div");
    hudEl.id = "collectible-hud";
    hudEl.style.cssText = [
      "position:fixed", "top:16px", "left:16px", "z-index:9000",
      "display:none", "gap:14px",
      "padding:8px 14px",
      "background:rgba(12,16,24,0.78)",
      "border:1px solid rgba(255,255,255,0.12)",
      "border-radius:10px",
      "color:#eaf2ff",
      "font-family:'Inter',system-ui,sans-serif",
      "font-size:16px", "font-weight:700", "letter-spacing:0.3px",
      "backdrop-filter:blur(6px)",
      "pointer-events:none", "user-select:none",
      "text-shadow:0 1px 4px rgba(0,0,0,0.4)",
    ].join(";");
    document.body.appendChild(hudEl);
    return hudEl;
  }

  function renderHud() {
    const el = ensureHud();
    if (kindsPresent.length === 0) {
      el.style.display = "none";
      hudSig = "";
      return;
    }
    const sig = kindsPresent.map((k) => `${k}:${counts[k] || 0}`).join("|");
    if (sig === hudSig) return;
    hudSig = sig;
    el.style.display = "flex";
    el.innerHTML = kindsPresent.map((kind) => {
      const icon = HUD_ICONS[kind] ?? "◆";
      return `<span style="display:inline-flex;align-items:center;gap:6px">`
        + `<span style="font-size:18px">${icon}</span>`
        + `<span>${counts[kind] || 0}</span></span>`;
    }).join("");
  }

  function start() {
    active = true;
    for (const k of Object.keys(counts)) delete counts[k];
    field.showAll();
    burst?.reset();
    kindsPresent = field.kindsPresent().sort();
    hudSig = "";
    renderHud();
  }

  function stop() {
    active = false;
    field.setPlayer(null, false);
    field.showAll();          // respawn everything for the next run
    burst?.reset();
    for (const k of Object.keys(counts)) delete counts[k];
    if (hudEl) hudEl.style.display = "none";
    hudSig = "";
  }

  function pickUp(slot) {
    field.collect(slot.storeIdx);

    counts[slot.kind] = (counts[slot.kind] || 0) + 1;
    renderHud();

    _pos.set(slot.x, slot.y + 0.4, slot.z);
    const spec = field.getKindSpec(slot.kind);
    burst?.burstAt(_pos, spec?.burstColor ?? 0xffffff);
    playSfx?.(slot.kind);

    for (const fn of pickupListeners) {
      try {
        fn(slot.kind, slot.storeIdx, _pos, counts[slot.kind]);
      } catch (err) {
        console.error("[collectibles] onPickup listener threw:", err);
      }
    }
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} playerPos
   * @param {string} moveMode
   */
  function update(dt, playerPos, moveMode) {
    if (!active || !playerPos) return;

    field.setPlayer(playerPos, true);
    burst?.update(dt);

    const bonus = REACH_BONUS[moveMode] ?? 0;

    field.forEachNear(playerPos.x, playerPos.z, MAX_PICKUP_RADIUS + bonus, (slot) => {
      if (!field.isAlive(slot.storeIdx)) return;

      const r = slot.pickupRadius + bonus;
      const dx = playerPos.x - slot.x;
      const dz = playerPos.z - slot.z;
      // Vertical distance is forgiving — the player's origin is at their feet, the coin floats.
      const dy = Math.max(0, Math.abs(playerPos.y - slot.y) - 2.0);
      if (dx * dx + dz * dz + dy * dy < r * r) pickUp(slot);
    });
  }

  function onPickup(cb) {
    pickupListeners.add(cb);
    return () => pickupListeners.delete(cb);
  }

  return {
    start, stop, update,
    onPickup,
    offPickup: (cb) => pickupListeners.delete(cb),
    getCountsByKind: () => ({ ...counts }),
    getCollectedCount: () => Object.values(counts).reduce((a, b) => a + b, 0),
    isActive: () => active,
  };
}
