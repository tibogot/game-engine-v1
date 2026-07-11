// Editor bootstrap. main.js used to self-run; now it exports startV3App() so a
// game project can boot the same engine headless and load its own world. This
// file is the EDITOR'S caller — it runs the app and shows a boot-error overlay.
import { startV3App } from "./main.js";

startV3App().then((app) => {
  // Console/debug access to the engine handle (same object games receive).
  window.__v3app = app;
}).catch((err) => {
  console.error("[V3] Editor failed to start:", err);
  const vp = document.getElementById("viewport");
  if (vp) {
    const msg = document.createElement("div");
    msg.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;color:#f66;font:14px/1.4 sans-serif;text-align:center;background:#1a0a0a;z-index:9999";
    msg.textContent = `Editor failed to start: ${err?.message ?? err}`;
    vp.appendChild(msg);
  }
});
