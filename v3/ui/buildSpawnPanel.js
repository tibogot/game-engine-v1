/**
 * Spawn (Player Start) panel — the mode where you place where the character
 * appears when play mode starts.
 */
export function buildSpawnPanel({
  mount,
  spawnSystem,
  onPlaceAtCamera,
  onFaceCamera,
  onChange,
}) {
  mount.innerHTML = `
    <div class="inspector-section">
      <div class="section-header">Player Start</div>
      <div class="section-body">
        <p class="mode-hint" style="margin:0 0 8px">
          Click the terrain to place the spawn · drag to aim its facing.<br>
          Play mode (P) starts the character here.
        </p>
        <div class="prop-row">
          <span class="prop-label">Status</span>
          <span class="insp-value" id="spawn-status">not placed</span>
        </div>
        <div class="prop-row">
          <span class="prop-label">X</span>
          <div class="prop-value"><input type="number" class="prop-num-input" id="spawn-x" step="1" value="0"></div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Z</span>
          <div class="prop-value"><input type="number" class="prop-num-input" id="spawn-z" step="1" value="0"></div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Facing</span>
          <div class="prop-value"><div class="prop-slider-wrap">
            <input type="range" class="prop-slider" id="spawn-yaw" min="-180" max="180" step="1" value="0">
            <input type="number" class="prop-num-input" id="spawn-yaw-num" min="-180" max="180" step="1" value="0">
          </div></div>
        </div>
        <div class="prop-row">
          <span class="prop-label">Ground Y</span>
          <span class="insp-value" id="spawn-y">—</span>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
          <button type="button" class="action-btn" id="spawn-at-cam">Place at camera</button>
          <button type="button" class="action-btn" id="spawn-face-cam">Aim like camera</button>
          <button type="button" class="action-btn" id="spawn-clear">Clear</button>
        </div>
      </div>
    </div>
  `;

  const elStatus = mount.querySelector("#spawn-status");
  const elX      = mount.querySelector("#spawn-x");
  const elZ      = mount.querySelector("#spawn-z");
  const elYaw    = mount.querySelector("#spawn-yaw");
  const elYawNum = mount.querySelector("#spawn-yaw-num");
  const elY      = mount.querySelector("#spawn-y");

  function refresh() {
    const s = spawnSystem.getSpawn();
    elStatus.textContent = s ? "placed" : "not placed";
    if (!s) { elY.textContent = "—"; return; }
    elX.value = s.x.toFixed(1);
    elZ.value = s.z.toFixed(1);
    const deg = Math.round((s.yaw * 180) / Math.PI);
    elYaw.value = String(deg);
    elYawNum.value = String(deg);
    elY.textContent = `${s.y.toFixed(1)} m`;
  }

  const applyXZ = () => {
    const x = parseFloat(elX.value);
    const z = parseFloat(elZ.value);
    if (!Number.isFinite(x) || !Number.isFinite(z)) { refresh(); return; }
    spawnSystem.setPosition(x, z);
    refresh();
    onChange?.();
  };
  elX.addEventListener("change", applyXZ);
  elZ.addEventListener("change", applyXZ);

  const applyYaw = (deg) => {
    if (!Number.isFinite(deg)) { refresh(); return; }
    if (!spawnSystem.placed) return;
    spawnSystem.setYaw((deg * Math.PI) / 180);
    refresh();
    onChange?.();
  };
  elYaw.addEventListener("input", () => applyYaw(parseFloat(elYaw.value)));
  elYawNum.addEventListener("change", () => applyYaw(parseFloat(elYawNum.value)));

  mount.querySelector("#spawn-at-cam").addEventListener("click", () => {
    onPlaceAtCamera?.();
    refresh();
  });
  mount.querySelector("#spawn-face-cam").addEventListener("click", () => {
    onFaceCamera?.();
    refresh();
  });
  mount.querySelector("#spawn-clear").addEventListener("click", () => {
    spawnSystem.clear();
    refresh();
    onChange?.();
  });

  refresh();
  return { refresh };
}
