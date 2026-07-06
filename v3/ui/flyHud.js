/**
 * In-viewport flight HUD — ported from v2/play/playMode.js _createFlyHud / update block.
 */

const HUD_SPEED_SMOOTH = 14;
const HUD_ALT_SMOOTH = 10;
const HUD_NITRO_SMOOTH = 10;

function expSmooth(current, target, dt, rate) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

function bankDegFromRad(rad) {
  let d = (rad * 180) / Math.PI;
  d = ((((d + 180) % 360) + 360) % 360) - 180;
  return d;
}

export function createFlyHud() {
  const el = document.createElement("div");
  el.id = "fly-hud";
  el.style.cssText = [
    "position:fixed",
    "bottom:20px",
    "right:20px",
    "z-index:6",
    "display:none",
    "pointer-events:none",
    "font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,sans-serif",
    "font-variant-numeric:tabular-nums",
    "-webkit-font-smoothing:antialiased",
    "filter:drop-shadow(0 16px 40px rgba(0,0,0,0.65))",
  ].join(";");
  el.innerHTML = `
    <div style="display:flex;align-items:stretch;gap:0;border-radius:18px;overflow:hidden;background:rgba(6,10,14,0.72);backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);border:1px solid rgba(120,175,200,0.22);box-shadow:inset 0 1px 0 rgba(255,255,255,0.06),0 0 0 1px rgba(0,0,0,0.35),0 8px 32px rgba(0,0,0,0.4);">
      <div style="display:flex;flex-direction:column;justify-content:space-between;padding:14px 16px 14px 18px;min-width:188px;gap:10px;border-right:1px solid rgba(255,255,255,0.06);">
        <div>
          <div style="font-size:9px;font-weight:600;letter-spacing:0.2em;color:rgba(140,175,195,0.75);text-transform:uppercase;">Indicated airspeed</div>
          <div style="display:flex;align-items:baseline;gap:8px;margin-top:4px;">
            <span id="fly-hud-spd" style="font-size:38px;font-weight:700;line-height:1;color:#f2f8fc;letter-spacing:-0.02em;text-shadow:0 1px 0 rgba(0,0,0,0.45),0 0 24px rgba(100,180,220,0.2);">0</span>
            <span style="font-size:11px;font-weight:500;color:rgba(130,160,180,0.65);">m/s</span>
          </div>
        </div>
        <div style="display:flex;align-items:stretch;gap:0;border-radius:10px;background:rgba(0,0,0,0.22);border:1px solid rgba(255,255,255,0.05);overflow:hidden;">
          <div style="flex:1;padding:8px 10px;text-align:center;">
            <div style="font-size:8px;font-weight:600;letter-spacing:0.16em;color:rgba(130,165,188,0.7);">AGL</div>
            <div style="margin-top:2px;"><span id="fly-hud-alt" style="font-size:19px;font-weight:700;color:#e8f2f8;">0</span><span style="font-size:10px;color:rgba(120,150,170,0.55);">m</span></div>
          </div>
          <div style="width:1px;background:rgba(255,255,255,0.07);flex-shrink:0;"></div>
          <div style="flex:1;padding:8px 10px;text-align:center;">
            <div style="font-size:8px;font-weight:600;letter-spacing:0.16em;color:rgba(130,165,188,0.7);">PITCH</div>
            <div style="margin-top:2px;"><span id="fly-hud-pitch" style="font-size:19px;font-weight:700;color:#e8f2f8;">0</span><span style="font-size:10px;color:rgba(120,150,170,0.55);">°</span></div>
          </div>
          <div style="width:1px;background:rgba(255,255,255,0.07);flex-shrink:0;"></div>
          <div style="flex:1;padding:8px 10px;text-align:center;">
            <div style="font-size:8px;font-weight:600;letter-spacing:0.16em;color:rgba(130,165,188,0.7);">BANK</div>
            <div style="margin-top:2px;"><span id="fly-hud-bank" style="font-size:19px;font-weight:700;color:#e8f2f8;">0</span><span style="font-size:10px;color:rgba(120,150,170,0.55);">°</span></div>
          </div>
        </div>
        <div id="fly-hud-level-hint" style="align-self:flex-end;font-size:8px;font-weight:600;letter-spacing:0.18em;padding:5px 11px;border-radius:999px;opacity:0;transition:opacity 0.22s ease;color:rgba(185,245,215,0.95);background:rgba(45,120,85,0.35);border:1px solid rgba(100,200,150,0.35);text-transform:uppercase;">Wings level</div>
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
            <span style="font-size:8px;font-weight:600;letter-spacing:0.18em;color:rgba(200,155,115,0.85);text-transform:uppercase;">Thrust reserve</span>
            <span id="fly-hud-nitro-pct" style="font-size:10px;font-weight:700;color:rgba(255,220,185,0.95);">100%</span>
          </div>
          <div style="height:6px;border-radius:999px;overflow:hidden;background:rgba(0,0,0,0.35);box-shadow:inset 0 1px 2px rgba(0,0,0,0.5);">
            <div id="fly-hud-nitro-bar" style="width:100%;height:100%;border-radius:999px;background:linear-gradient(90deg,#c45a28,#e8a060);box-shadow:0 0 12px rgba(230,140,70,0.35);"></div>
          </div>
        </div>
      </div>
      <div style="padding:12px 14px 12px 10px;display:flex;align-items:center;justify-content:center;background:linear-gradient(180deg,rgba(255,255,255,0.03),transparent);">
        <div style="position:relative;width:124px;height:124px;border-radius:50%;padding:3px;background:linear-gradient(145deg,rgba(90,110,125,0.5),rgba(20,28,36,0.9));box-shadow:inset 0 1px 0 rgba(255,255,255,0.12),0 4px 16px rgba(0,0,0,0.35);">
          <div style="position:relative;width:100%;height:100%;border-radius:50%;overflow:hidden;background:#030608;box-shadow:inset 0 0 0 1px rgba(0,0,0,0.6);">
            <div id="fly-hud-horizon-layer" style="position:absolute;left:50%;top:50%;width:260%;height:260%;margin-left:-130%;margin-top:-130%;transform:rotate(0deg);background:radial-gradient(ellipse 55% 42% at 50% 18%,rgba(180,220,255,0.35) 0%,transparent 55%),linear-gradient(180deg,#0d2844 0%,#1e5078 32%,#4e8eb8 47%,#7ab8cf 49.2%,#c9a06a 50.2%,#6d5a42 51.5%,#2a241c 100%);"></div>
            <div style="position:absolute;inset:0;border-radius:50%;pointer-events:none;box-shadow:inset 0 0 36px rgba(0,0,0,0.55);"></div>
            <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;">
              <div style="display:flex;align-items:center;gap:0;">
                <div style="width:22px;height:3px;border-radius:2px 0 0 2px;background:linear-gradient(90deg,rgba(255,255,255,0.08),rgba(255,250,235,0.95));box-shadow:-1px 0 6px rgba(255,255,255,0.25);"></div>
                <div style="width:5px;height:5px;border-radius:50%;background:#f8fafc;box-shadow:0 0 6px rgba(255,255,255,0.5);"></div>
                <div style="width:22px;height:3px;border-radius:0 2px 2px 0;background:linear-gradient(90deg,rgba(255,250,235,0.95),rgba(255,255,255,0.08));box-shadow:1px 0 6px rgba(255,255,255,0.25);"></div>
              </div>
            </div>
            <div style="position:absolute;top:8px;left:0;right:0;text-align:center;font-size:7px;font-weight:600;letter-spacing:0.24em;color:rgba(160,195,215,0.55);text-transform:uppercase;">Horizon</div>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el);

  const refs = {
    spd: el.querySelector("#fly-hud-spd"),
    alt: el.querySelector("#fly-hud-alt"),
    pitch: el.querySelector("#fly-hud-pitch"),
    bank: el.querySelector("#fly-hud-bank"),
    horizon: el.querySelector("#fly-hud-horizon-layer"),
    nitroPct: el.querySelector("#fly-hud-nitro-pct"),
    nitroBar: el.querySelector("#fly-hud-nitro-bar"),
    levelHint: el.querySelector("#fly-hud-level-hint"),
  };

  let spdSmooth = 0;
  let altSmooth = 0;
  let nitroSmooth = 1;

  function setVisible(show) {
    el.style.display = show ? "" : "none";
    if (!show) {
      spdSmooth = 0;
      altSmooth = 0;
      nitroSmooth = 1;
    }
  }

  function update(state, dt) {
    if (!state) {
      setVisible(false);
      return;
    }
    setVisible(true);

    let barrelAdd = 0;
    if (state.barrelActive) {
      const t = Math.min(1, state.barrelPhase);
      barrelAdd = t * t * (3 - 2 * t) * Math.PI * 2 * state.barrelDir;
    }
    const bankRad = state.roll + barrelAdd + state.aileronAngle;
    const bankDeg = bankDegFromRad(bankRad);
    const pitchDeg = Math.round((state.pitch * 180) / Math.PI);

    const spdTgt = Math.abs(state.speed);
    const dSpd = spdTgt - spdSmooth;
    const spdRate = dSpd > 0 ? HUD_SPEED_SMOOTH : HUD_SPEED_SMOOTH * 0.55;
    spdSmooth = expSmooth(spdSmooth, spdTgt, dt, spdRate);
    altSmooth = expSmooth(altSmooth, state.agl, dt, HUD_ALT_SMOOTH);
    nitroSmooth = expSmooth(nitroSmooth, state.thrustReserve, dt, HUD_NITRO_SMOOTH);

    refs.spd.textContent = String(Math.round(spdSmooth));
    refs.alt.textContent = String(Math.round(altSmooth));
    refs.pitch.textContent = String(pitchDeg);
    refs.bank.textContent = String(Math.round(bankDeg));

    if (refs.horizon) {
      refs.horizon.style.transform = `rotate(${-bankDeg}deg)`;
    }
    const level = Math.abs(bankDeg) < 3.5;
    if (refs.levelHint) {
      refs.levelHint.style.opacity = level ? "1" : "0";
    }

    const nitroPct = Math.round(nitroSmooth * 100);
    if (refs.nitroPct) {
      refs.nitroPct.textContent = `${nitroPct}%`;
      refs.nitroPct.style.color = nitroSmooth > 0.2
        ? "rgba(255,220,190,0.95)"
        : "rgba(255,150,150,0.95)";
    }
    if (refs.nitroBar) {
      refs.nitroBar.style.width = `${nitroPct}%`;
      refs.nitroBar.style.background = nitroSmooth > 0.2
        ? "linear-gradient(90deg,#b84820,#e8a060)"
        : "linear-gradient(90deg,#a03030,#c07070)";
    }
  }

  function dispose() {
    el.remove();
  }

  return { setVisible, update, dispose, el };
}
