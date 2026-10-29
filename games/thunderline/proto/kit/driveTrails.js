// THE DRIVE TRAILS (user, 2026-10-29, Apex Rush's editor: "the red lines … showing the previous jumps he did with his
// car"): every drive in the builder records where the car went; back in the editor the last few runs are drawn as red
// lines — the newest brightest — over the track: where you actually took the turns, flew, landed, fell off.
import * as THREE from "three";

const KEEP = 4; // runs drawn
const STEP = 0.6; // m between recorded points
const MAX_POINTS = 20000;

export function createDriveTrails(scene) {
  const group = new THREE.Group();
  group.name = "driveTrails";
  scene.add(group);
  const runs = []; // [{ line }] oldest first
  let rec = null, raf = 0, on = true;
  const mats = [];
  function restyle() {
    runs.forEach((r, i) => {
      const age = runs.length - 1 - i; // 0 = newest
      r.line.material.opacity = [1, 0.55, 0.35, 0.22][age] ?? 0.15;
    });
  }
  function sample() {
    if (!rec) return;
    const p = rec.vehicle.body.pos;
    const last = rec.pts[rec.pts.length - 1];
    if (!last || last.distanceToSquared(p) > STEP * STEP) {
      // (a jump back = a restart / a zone key: the run's line breaks there)
      if (last && last.distanceToSquared(p) > 40 * 40) { finishRun(); rec = { vehicle: rec.vehicle, pts: [] }; }
      if (Number.isFinite(p.x)) rec.pts.push(p.clone().add(new THREE.Vector3(0, 0.25, 0)));
      if (rec.pts.length > MAX_POINTS) rec.pts.shift();
    }
    raf = requestAnimationFrame(sample);
  }
  function finishRun() {
    if (!rec || rec.pts.length < 2) return;
    // a thin TUBE, not a line: WebGPU lines are one pixel — lost from the editor's distance
    const curve = new THREE.CatmullRomCurve3(rec.pts, false, "centripetal");
    const geo = new THREE.TubeGeometry(curve, Math.min(4000, rec.pts.length * 2), 0.14, 5, false);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff2a3d, transparent: true, opacity: 1, depthWrite: false });
    mats.push(mat);
    const line = new THREE.Mesh(geo, mat);
    line.renderOrder = 5;
    group.add(line);
    runs.push({ line });
    while (runs.length > KEEP) { const r = runs.shift(); group.remove(r.line); r.line.geometry.dispose(); r.line.material.dispose(); }
    restyle();
  }
  return {
    group,
    /** a drive starts: record this car */
    begin(vehicle) { cancelAnimationFrame(raf); rec = { vehicle, pts: [] }; group.visible = false; raf = requestAnimationFrame(sample); },
    /** the drive ends: its line joins the drawn runs */
    end() { cancelAnimationFrame(raf); finishRun(); rec = null; group.visible = on; },
    clear() { for (const r of runs) { group.remove(r.line); r.line.geometry.dispose(); r.line.material.dispose(); } runs.length = 0; },
    get on() { return on; },
    set on(v) { on = !!v; if (!rec) group.visible = on; },
    get count() { return runs.length; },
  };
}
