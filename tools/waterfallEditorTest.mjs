// Waterfall mode (v3/tools/waterfallEditor.js): what a click does, auto
// direction over the drop, undo/redo, duplicate/delete, presets, the look
// following River v2, and the project round trip.
import * as THREE from "three";
import { createWaterfallEditor, presetShape } from "../v3/tools/waterfallEditor.js";
import { solveFall, FALL_DEFAULTS } from "../v3/render/waterfall/waterfallPath.js";
import { createWaterfallLookState, effectiveWaterfallLook, WATERFALL_PRESETS } from "../v3/app/state/waterfallState.js";
import { encodeProjectFile, decodeProjectFile } from "../v3/io/projectIO.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};
const near = (a, b, eps) => Math.abs(a - b) < eps;

// A cliff edge along x = 0: high ground (40) for x < 0, low (0) beyond.
const sampleGround = (x, yFrom, z) => ({ y: x < 0 ? 40 : 0, nx: 0, ny: 1, nz: 0 });

// A data-only stand-in for WaterfallSystem (no GPU): same data API.
let nextId = 1;
const system = {
  falls: [],
  sampleGround,
  add(p) {
    const f = { ...FALL_DEFAULTS, ...p };
    if (!Number.isInteger(f.id) || this.get(f.id)) f.id = nextId;
    nextId = Math.max(nextId, f.id + 1);
    this.falls.push(f);
    return f;
  },
  get(id) { return this.falls.find((f) => f.id === id) ?? null; },
  remove(id) { const i = this.falls.findIndex((f) => f.id === id); if (i >= 0) this.falls.splice(i, 1); return i >= 0; },
  duplicate(id, o) { const { id: _, ...r } = this.get(id); return this.add({ ...r, px: r.px + o.x, py: r.py + o.y, pz: r.pz + o.z }); },
  markDirty() {},
  snapshot() { return JSON.stringify(this.falls); },
  restore(s) { this.falls.length = 0; for (const f of JSON.parse(s)) this.add(f); },
  solved(id) { const f = this.get(id); return f ? solveFall(f, { sampleGround }) : null; },
  preview(p) { return solveFall({ ...FALL_DEFAULTS, ...p }, { sampleGround }); },
  // Picking by lip distance is enough for the click logic.
  pickAt: null,
  raycast() { return this.pickAt ? { fall: this.pickAt, distance: 1 } : null; },
};

let gizmo = null;
const ed = createWaterfallEditor({
  system, scene: new THREE.Scene(),
  attachGizmo: (f) => { gizmo = f.id; }, detachGizmo: () => { gizmo = null; },
});
ed.setActive(true);
const camera = new THREE.PerspectiveCamera();
camera.position.set(-30, 60, 0);

const edge = { point: new THREE.Vector3(-0.5, 40, 5), distance: 10 };
ed.hover(edge, camera);
check("click on the cliff edge places a fall", ed.click(edge, null, camera) === "place" && system.falls.length === 1);
const first = system.falls[0];
check("…selected, with the gizmo on it", ed.selectedId === first.id && gizmo === first.id);
check("…facing over the drop (+X)", near(Math.sin(first.yaw), 1, 0.05), `yaw ${first.yaw.toFixed(3)}`);
check("…with the current preset's shape", first.width === ed.place.width && first.speed === ed.place.speed);
const s = system.solved(first.id);
check("…and it solves into a real drop", s.drop > 38, `${s.drop.toFixed(1)} m`);

check("click on empty ground with one selected deselects", ed.click({ point: new THREE.Vector3(-50, 40, 0), distance: 10 }, null, camera) === "deselect" && ed.selectedId === null && gizmo === null);
system.pickAt = first;
check("click on a fall selects it", ed.click(edge, {}, camera) === "select" && ed.selectedId === first.id);
system.pickAt = null;

// Flat ground: no drop, so it faces away from the camera.
ed.deselect();
ed.click({ point: new THREE.Vector3(-80, 40, 0), distance: 10 }, null, camera);
const flat = system.get(ed.selectedId);
const away = Math.atan2(-80 - camera.position.x, 0 - camera.position.z);
check("on flat ground the fall faces away from the camera", near(flat.yaw, away, 1e-6));

const count = system.falls.length;
ed.edit({ width: 30 });
check("a panel edit changes the fall", flat.width === 30);
ed.history.undo();
check("undo reverts the edit", system.get(flat.id).width === ed.place.width);
ed.history.undo();
check("undo removes the last placement", system.falls.length === count - 1);
ed.history.redo();
check("redo brings it back with the same id", system.falls.length === count && !!system.get(flat.id));

ed.select(flat.id);
ed.applyPreset("torrent");
const t = WATERFALL_PRESETS.torrent;
check("a preset reshapes the selected fall", system.get(flat.id).speed === t.speed && system.get(flat.id).width === t.width);
check("…and the next placement", ed.place.speed === t.speed && ed.place.preset === "torrent");
check("preset shapes carry a friction", presetShape("ribbon").friction === FALL_DEFAULTS.friction && presetShape("cascade").friction === WATERFALL_PRESETS.cascade.friction);

const copy = ed.duplicateSelected();
check("duplicate copies the shape beside the original", copy && copy.id !== flat.id && copy.speed === t.speed && Math.hypot(copy.px - flat.px, copy.pz - flat.pz) > t.width);
check("…and selects the copy", ed.selectedId === copy.id);
ed.deleteSelected();
check("delete removes the selected fall", !system.get(copy.id) && ed.selectedId === null);

// ── Look ──
const look = createWaterfallLookState();
check("the look follows River v2 by default", look.followRiver === true);
const river = { style: "stylized", styBodyColor: "#123456" };
const eff = effectiveWaterfallLook(look, river);
check("…taking its style and stylized colours", eff.style === "stylized" && eff.styBodyColor === "#123456");
check("…unless unlinked", effectiveWaterfallLook({ ...look, followRiver: false }, river).style === "realistic");

// ── Project file ──
const waterfalls = { look, falls: system.falls.map(({ id, ...r }) => r) };
const out = await decodeProjectFile(await encodeProjectFile({ terrain: { worldSize: 1024 }, waterfalls }));
check("waterfalls survive the project file", JSON.stringify(out.waterfalls) === JSON.stringify(waterfalls));
check("a project without waterfalls loads none", (await decodeProjectFile(await encodeProjectFile({ terrain: { worldSize: 1024 } }))).waterfalls === null);

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
