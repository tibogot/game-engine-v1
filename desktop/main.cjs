// Desktop TEST wrapper (2026-10-17): does a game boot in Electron with WebGPU, and how much of the
// boot does a persistent GPU shader cache save on the 2nd launch? Not the shipping app yet.
//
//   GAME_URL   page to open (default: alg-rts on the dev server, port 5181)
//   QUIT=0     keep the window open after the measurement
// Writes one line per run to desktop/boot-log.txt.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const URL_ = process.env.GAME_URL
  || "http://localhost:5181/games/alg-rts/alg.html?world=/levels/alg-aures.v3proj";
const LOG = path.join(__dirname, "boot-log.txt");
const log = (s) => fs.appendFileSync(LOG, s + "\n");

app.setName("SandAndBloodDesktopTest");
// Chromium's GPU disk cache defaults to 6 MB; ~390 pipelines need far more.
app.commandLine.appendSwitch("gpu-disk-cache-size-kb", String(1024 * 1024));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600, height: 900, show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const t0 = Date.now();
  win.webContents.on("console-message", (e, ...args) => {
    const message = e?.message ?? args[1] ?? "";
    if (/\[warmup\]|error|Error/.test(message)) log(`  ${Date.now() - t0} ms  ${String(message).slice(0, 160)}`);
  });
  log(`--- run ${new Date().toISOString()}  electron ${process.versions.electron} chrome ${process.versions.chrome}`);
  await win.loadURL(URL_);
  const res = await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const iv = setInterval(() => {
      const h = document.getElementById("hud");
      if (h && /WASD/.test(h.textContent)) { clearInterval(iv); resolve({ bootMs: Math.round(performance.now()), webgpu: !!navigator.gpu }); }
    }, 100);
    setTimeout(() => { clearInterval(iv); resolve({ timeout: true, webgpu: !!navigator.gpu }); }, 240000);
  })`);
  log(`RESULT ${JSON.stringify(res)}  userData=${app.getPath("userData")}`);
  if (process.env.QUIT !== "0") app.quit();
});
