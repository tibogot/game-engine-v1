/**
 * Play-mode collectible runtime — overlap + magnet pull + pickup animation + HUD counter.
 *
 * Three feel passes layered on top of basic touch-to-collect:
 *   1) Pickup animation — scale-up + lift + vanish (~0.22s) before hiding. Beats instant-disappear.
 *   2) Magnet pull — within MAGNET_RADIUS_MULT × pickupRadius, collectible drifts toward player
 *      with speed ramping from MAGNET_PULL_MIN (outer edge) to MAGNET_PULL_MAX (pickup edge).
 *   3) HUD counter — per-kind tally, top-left, only shows kinds actually placed.
 *
 * All position mutations on the live-prop group are transient: original positions are snapshotted
 * lazily on first sight, and restored in `stop()` so leaving play returns the world to author state.
 */
import * as THREE from "three";
import { COLLECTIBLE_KINDS } from "../core/props/collectibleFactory.js";

const REACH_BONUS = {
  capsule: 0.0,
  char:    0.0,
  car:     1.5,
  lotus:   1.5,
  fly:     3.0,
};

const PICKUP_ANIM_DUR    = 0.22;
const PICKUP_ANIM_PEAK_T = 0.65;   // proportion of duration spent inflating before shrink-out
const PICKUP_ANIM_SCALE  = 1.6;
const PICKUP_ANIM_LIFT   = 0.7;    // additional Y lift during anim (metres)

const MAGNET_RADIUS_MULT = 2.4;
const MAGNET_PULL_MIN    = 0.6;    // m/s at outer edge of magnet
const MAGNET_PULL_MAX    = 9.0;    // m/s at pickup edge

const HUD_ICONS = {
  coin:  "\u{1FA99}",  // 🪙
  heart: "❤️", // ❤️
  key:   "\u{1F511}",  // 🔑
};

export function createCollectibleRuntime({ livePropManager, burst, playSfx }) {
  /** Indices already consumed (this play session). */
  const collectedSet = new Set();
  /** instIdx → { t, group, origPos } */
  const activeAnims = new Map();
  /** instIdx → original world position (for magnet-pull restoration on stop). */
  const originalPos = new Map();
  /** kind → count of collectibles picked so far this session. */
  const counts = Object.create(null);
  /** Set of kinds with at least one instance placed (for HUD visibility). */
  const kindsPresent = new Set();

  let active = false;
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  /** Listeners: (kind, instIdx, position, kindCount) → void. */
  const pickupListeners = new Set();

  // HUD element built lazily on first start().
  let hudEl = null;
  let hudLastSig = "";

  function _ensureHud() {
    if (hudEl) return hudEl;
    hudEl = document.createElement("div");
    hudEl.id = "collectible-hud";
    hudEl.style.cssText = [
      "position:fixed",
      "top:16px",
      "left:16px",
      "z-index:9000",
      "display:none",
      "gap:14px",
      "padding:8px 14px",
      "background:rgba(12,16,24,0.78)",
      "border:1px solid rgba(255,255,255,0.12)",
      "border-radius:10px",
      "color:#eaf2ff",
      "font-family:'Inter',system-ui,sans-serif",
      "font-size:16px",
      "font-weight:700",
      "letter-spacing:0.3px",
      "backdrop-filter:blur(6px)",
      "pointer-events:none",
      "user-select:none",
      "text-shadow:0 1px 4px rgba(0,0,0,0.4)",
    ].join(";");
    document.body.appendChild(hudEl);
    return hudEl;
  }

  function _renderHud() {
    const el = _ensureHud();
    if (kindsPresent.size === 0) {
      if (el.style.display !== "none") el.style.display = "none";
      hudLastSig = "";
      return;
    }
    const kindsArr = Array.from(kindsPresent).sort();
    const sig = kindsArr.map((k) => `${k}:${counts[k] || 0}`).join("|");
    if (sig === hudLastSig) return;
    hudLastSig = sig;
    el.style.display = "flex";
    el.innerHTML = kindsArr.map((k) => {
      const icon = HUD_ICONS[k] || k[0].toUpperCase();
      const n = counts[k] || 0;
      return `<span style="display:inline-flex;align-items:center;gap:6px">
        <span style="font-size:18px">${icon}</span>
        <span>${n}</span>
      </span>`;
    }).join("");
  }

  function _scanKindsPresent() {
    kindsPresent.clear();
    livePropManager.forEachByKind(
      (k) => COLLECTIBLE_KINDS.has(k),
      (entry) => { kindsPresent.add(entry.obj.kind); },
    );
  }

  function _resetOriginalPositions() {
    for (const [instIdx, origPos] of originalPos) {
      const entry = livePropManager.getLiveEntry(instIdx);
      if (entry?.obj?.group) {
        entry.obj.group.position.copy(origPos);
        entry.obj.group.scale.set(1, 1, 1);
      }
    }
    originalPos.clear();
  }

  function start() {
    active = true;
    collectedSet.clear();
    activeAnims.clear();
    originalPos.clear();
    for (const k of Object.keys(counts)) delete counts[k];
    livePropManager.showAll();
    burst?.reset();

    _scanKindsPresent();
    hudLastSig = "";
    _renderHud();
  }

  function stop() {
    active = false;
    // Restore positions/scale before clearing maps so live-prop visuals snap back to author state.
    _resetOriginalPositions();
    for (const [instIdx] of activeAnims) {
      const entry = livePropManager.getLiveEntry(instIdx);
      if (entry?.obj?.group) entry.obj.group.scale.set(1, 1, 1);
    }
    activeAnims.clear();
    collectedSet.clear();
    for (const k of Object.keys(counts)) delete counts[k];
    livePropManager.showAll();
    burst?.reset();
    if (hudEl) hudEl.style.display = "none";
    hudLastSig = "";
  }

  function _startPickupAnim(instIdx, entry, playerPos) {
    const g = entry.obj.group;
    _v.copy(g.position).y += 0.8;
    burst?.burstAt(_v, entry.obj.burstColor || new THREE.Color(0xffffff));
    playSfx?.(entry.obj.kind);

    const orig = originalPos.get(instIdx) || g.position.clone();
    activeAnims.set(instIdx, { t: 0, group: g, origPos: orig });

    const kind = entry.obj.kind;
    counts[kind] = (counts[kind] || 0) + 1;
    _renderHud();

    // Fire listeners — game-logic hook.
    if (pickupListeners.size) {
      const pickupPos = _v.copy(orig);
      for (const fn of pickupListeners) {
        try { fn(kind, instIdx, pickupPos, counts[kind]); }
        catch (e) { console.error("[collectibles] onPickup listener threw:", e); }
      }
    }
  }

  function _tickAnims(dt) {
    if (activeAnims.size === 0) return;
    for (const [instIdx, anim] of activeAnims) {
      anim.t += dt;
      const p = anim.t / PICKUP_ANIM_DUR;
      if (p >= 1) {
        anim.group.visible = false;
        anim.group.scale.set(1, 1, 1);
        anim.group.position.copy(anim.origPos);
        activeAnims.delete(instIdx);
        continue;
      }
      let s, lift;
      if (p < PICKUP_ANIM_PEAK_T) {
        const q = p / PICKUP_ANIM_PEAK_T;          // 0 → 1
        s = 1 + (PICKUP_ANIM_SCALE - 1) * q;
        lift = PICKUP_ANIM_LIFT * q;
      } else {
        const q = (p - PICKUP_ANIM_PEAK_T) / (1 - PICKUP_ANIM_PEAK_T); // 0 → 1
        s = PICKUP_ANIM_SCALE * (1 - q);            // shrink to 0
        lift = PICKUP_ANIM_LIFT;                    // hold at peak height
      }
      anim.group.scale.set(s, s, s);
      anim.group.position.copy(anim.origPos);
      anim.group.position.y = anim.origPos.y + lift;
    }
  }

  /**
   * @param {number} dtSec
   * @param {THREE.Vector3} playerPos
   * @param {string} moveMode
   */
  function update(dtSec, playerPos, moveMode) {
    if (!active || !playerPos) return;

    // Pickup animations always tick — they own their own timeline regardless of player position.
    _tickAnims(dtSec);

    const bonus = REACH_BONUS[moveMode] ?? 0.0;

    livePropManager.forEachByKind(
      (k) => COLLECTIBLE_KINDS.has(k),
      (entry, instIdx) => {
        if (collectedSet.has(instIdx)) return;

        const g = entry.obj.group;

        // Lazy snapshot of authored position — written once, restored on stop().
        if (!originalPos.has(instIdx)) {
          originalPos.set(instIdx, g.position.clone());
        }

        const pickupR = (entry.obj.pickupRadius ?? 1.0) + bonus;
        const magnetR = pickupR * MAGNET_RADIUS_MULT;

        // Use original position (not pulled position) for distance check so magnet doesn't chase past the player.
        const ox = originalPos.get(instIdx);
        _v.set(playerPos.x - g.position.x, 0, playerPos.z - g.position.z);
        const dxz = _v.length();
        const dyAbs = Math.abs(playerPos.y - g.position.y);
        const dySoft = Math.max(0, dyAbs - 2.0);
        const dist = Math.sqrt(dxz * dxz + dySoft * dySoft);

        if (dist < pickupR) {
          collectedSet.add(instIdx);
          _startPickupAnim(instIdx, entry, playerPos);
          return;
        }

        // Magnet pull: only if outside pickup but inside magnet, and not already animating.
        // No snap-back when player leaves range — coin simply stops being pulled and floats where it landed.
        // Authored positions are restored on stop().
        if (dist < magnetR && !activeAnims.has(instIdx)) {
          // Speed ramps inward (linear) — outer edge slow, near pickup fast.
          const t = 1 - (dist - pickupR) / (magnetR - pickupR); // 0 (outer) → 1 (inner)
          const speed = MAGNET_PULL_MIN + (MAGNET_PULL_MAX - MAGNET_PULL_MIN) * t;
          _v2.set(playerPos.x - g.position.x, 0, playerPos.z - g.position.z);
          const len = _v2.length();
          if (len > 0.0001) {
            _v2.multiplyScalar(speed * dtSec / len);
            g.position.x += _v2.x;
            g.position.z += _v2.z;
            // Hold Y at the authored value; bob still happens on the mesh inside the group.
            g.position.y = ox.y;
          }
        }
      },
    );
  }

  function getCollectedCount() {
    let n = 0;
    for (const k of Object.keys(counts)) n += counts[k];
    return n;
  }
  function getCountsByKind() { return { ...counts }; }
  function isActive() { return active; }

  /**
   * Subscribe to pickup events. Listener receives (kind, instIdx, position, kindCount).
   * Returns an unsubscribe function for convenience.
   *
   * Example:
   *   const off = runtime.onPickup((kind, idx, pos, n) => {
   *     if (kind === "coin" && n >= 10) openDoor();
   *     if (kind === "heart") restoreHp(1);
   *   });
   */
  function onPickup(cb) {
    pickupListeners.add(cb);
    return () => pickupListeners.delete(cb);
  }
  function offPickup(cb) { pickupListeners.delete(cb); }

  return {
    start, stop, update,
    getCollectedCount, getCountsByKind, isActive,
    onPickup, offPickup,
  };
}
